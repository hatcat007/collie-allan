import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { diskIo, type OperatorFileIo } from "../operator-file.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";

// ── WHERE THE VOICE-MODE SETTINGS COME FROM ──────────────────────────────────────────────────
//
// The same shape as `bridge/stt/config.ts`, on purpose: `<stateDir>/voice.json` (0600, written by
// `collie voice setup`, never hand-edited) with the environment on top of it field by field, re-read
// behind an mtime check so setup goes live with no restart. The Gemini key lives HERE and never
// reaches the phone: the phone speaks to the bridge, the bridge speaks to Google. That is what keeps
// the CSP at `connect-src 'self'` and is the reason this is a relay and not an ephemeral-token mint.
//
// Off is the default and is never an error. A configuration that is present but unusable warns and
// resolves to null, because the alternative is a voice button that fails after the operator spoke.

export const VOICE_FILENAME = "voice.json";

/** The provider names this bridge can build. One today; a second is a file and an arm. */
export const VOICE_PROVIDERS = ["gemini-live"] as const;
export type VoiceProviderName = (typeof VOICE_PROVIDERS)[number];

/**
 * Collie's default Live model. A DEFAULT, not a pin: `collie voice setup` writes the model into
 * `voice.json` only when the operator named one, so an install that took the default follows this
 * constant when it moves.
 */
export const DEFAULT_VOICE_MODEL = "gemini-3.8-live";

/**
 * Models the operator may name. Closed on purpose: a typo here is a session that fails after the
 * microphone is open. `gemini-3.8-live-extended-thinking` takes NON_BLOCKING tools only, which the
 * tool set in `tools.ts` already declares.
 */
export const VOICE_MODELS = [
  "gemini-3.8-live",
  "gemini-3.8-live-extended-thinking",
  "gemini-3.1-flash-live-preview",
] as const;
export type VoiceModel = (typeof VOICE_MODELS)[number];

export interface VoiceSettings {
  provider: VoiceProviderName;
  apiKey: string;
  model: VoiceModel;
  /** BCP-47 base language for input transcription, or absent for auto-detect. */
  language?: string;
  /** The prebuilt Gemini voice name, or absent for the model's own default. */
  voiceName?: string;
}

export const VOICE_ENV_KEYS = {
  provider: "COLLIE_VOICE_PROVIDER",
  key: "COLLIE_VOICE_KEY",
  model: "COLLIE_VOICE_MODEL",
  language: "COLLIE_VOICE_LANG",
  voiceName: "COLLIE_VOICE_NAME",
} as const;

export function voiceSettingsPath(stateDir: string): string {
  return join(stateDir, VOICE_FILENAME);
}

interface RawSettings {
  provider?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  voiceName?: string;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  const raw = jsonStringField(value);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Narrow the parsed file to the fields this module knows; anything else is dropped. */
export function coerceVoiceFile(raw: JsonValue | undefined): RawSettings {
  const o = jsonRecord(raw);
  if (o === null) return {};
  return {
    provider: optionalString(o.provider),
    apiKey: optionalString(o.apiKey),
    model: optionalString(o.model),
    language: optionalString(o.language),
    voiceName: optionalString(o.voiceName),
  };
}

export function voiceEnvSettings(env: Record<string, string | undefined>): RawSettings {
  return {
    provider: optionalString(env[VOICE_ENV_KEYS.provider]),
    apiKey: optionalString(env[VOICE_ENV_KEYS.key]),
    model: optionalString(env[VOICE_ENV_KEYS.model]),
    language: optionalString(env[VOICE_ENV_KEYS.language]),
    voiceName: optionalString(env[VOICE_ENV_KEYS.voiceName]),
  };
}

/** `da`, `en-GB`, `pt_BR` become a base language tag (`da`, `en`, `pt`); anything else is null. */
export function canonicalVoiceLanguage(raw: string): string | null {
  const base = /^([A-Za-z]{2})(?:[-_][A-Za-z0-9]{2,8})?$/.exec(raw.trim())?.[1];
  return base === undefined ? null : base.toLowerCase();
}

function isVoiceModel(value: string): value is VoiceModel {
  return VOICE_MODELS.some((known) => known === value);
}

/** The settings the bridge runs with, or null when voice mode is off. */
export function resolveVoiceSettings(
  file: RawSettings,
  env: RawSettings,
  warn: (message: string) => void,
): VoiceSettings | null {
  const named = env.provider ?? file.provider;
  const apiKey = env.apiKey ?? file.apiKey;
  const model = env.model ?? file.model;
  const language = env.language ?? file.language;
  const voiceName = env.voiceName ?? file.voiceName;

  if (
    named === undefined &&
    apiKey === undefined &&
    model === undefined &&
    language === undefined &&
    voiceName === undefined
  ) {
    return null;
  }
  const provider = named ?? "gemini-live";
  if (provider !== "gemini-live") {
    warn(`voice mode is off: unknown provider "${provider}" (expected ${VOICE_PROVIDERS.join(", ")})`);
    return null;
  }
  if (apiKey === undefined) {
    warn(`voice mode is off: no key configured (set ${VOICE_ENV_KEYS.key} or "apiKey" in ${VOICE_FILENAME})`);
    return null;
  }
  const resolvedModel = model ?? DEFAULT_VOICE_MODEL;
  if (!isVoiceModel(resolvedModel)) {
    warn(`voice mode is off: unknown model "${resolvedModel}" (expected ${VOICE_MODELS.join(", ")})`);
    return null;
  }
  const settings: VoiceSettings = { provider, apiKey, model: resolvedModel };
  if (language !== undefined) {
    const code = canonicalVoiceLanguage(language);
    if (code === null) {
      warn(`voice mode is off: "${language}" is not a language code (${VOICE_ENV_KEYS.language} / "language")`);
      return null;
    }
    settings.language = code;
  }
  if (voiceName !== undefined) settings.voiceName = voiceName;
  return settings;
}

/** `<stateDir>/voice.json` + the environment, re-read behind an mtime check. Holds the last good file. */
export function createVoiceSettingsReader(opts: {
  stateDir: string;
  warn: (message: string) => void;
  io?: OperatorFileIo;
  env?: Record<string, string | undefined>;
}): () => Promise<VoiceSettings | null> {
  const path = voiceSettingsPath(opts.stateDir);
  const io = opts.io ?? diskIo;
  const env = opts.env ?? process.env;
  let seen: number | null | undefined;
  let file: RawSettings = {};
  return async () => {
    const mtime = await io.mtime(path);
    if (mtime !== seen) {
      seen = mtime;
      if (mtime === null) {
        file = {};
      } else {
        try {
          // SAFETY: `JSON.parse` answers with a JSON value and `coerceVoiceFile` is its only reader;
          // every field it names is checked before it is believed.
          file = coerceVoiceFile(JSON.parse(await io.read(path)) as JsonValue);
        } catch (err) {
          opts.warn(`${path} could not be parsed (${String(err)}) — keeping the last good settings`);
        }
      }
    }
    return resolveVoiceSettings(file, voiceEnvSettings(env), opts.warn);
  };
}
