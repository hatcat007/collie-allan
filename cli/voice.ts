import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import {
  coerceVoiceFile,
  DEFAULT_VOICE_MODEL,
  resolveVoiceSettings,
  VOICE_ENV_KEYS,
  VOICE_FILENAME,
  VOICE_MODELS,
  voiceEnvSettings,
  type VoiceSettings,
} from "../bridge/voice/config.ts";
import { type UpstreamFactory, VoiceRelay } from "../bridge/voice/session.ts";
import { openGeminiSocket } from "../bridge/voice/upstream.ts";
import { parseCrewArgs } from "./crew.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Files } from "./sys.ts";

// `voice setup | test | status | off` — the operator's half of voice mode.
//
// A CLI act and not a settings page, for the reason `stt setup` is one: it writes a provider key
// into the state dir, and a page loaded over the front door cannot authorise that. It follows
// `cli/stt.ts` on every rule that matters: it writes `<stateDir>/voice.json` (0600, atomically),
// it VALIDATES through the bridge's own `resolveVoiceSettings` so a config the CLI accepts is one
// the bridge accepts, the bridge re-reads the file per request so no verb needs a restart, and no
// verb ever prints the key back.

export const VOICE_SUBCOMMANDS = ["setup", "test", "status", "off"] as const;

export interface VoiceDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
  interactive: boolean;
  prompt(question: string): string | null | Promise<string | null>;
  /** Injected so no test dials Google. Production leaves it. */
  open?: UpstreamFactory;
  /** How long `test` waits for the session to come up. */
  timeoutMs?: number;
}

type RawSettings = ReturnType<typeof coerceVoiceFile>;

const settingsPath = (deps: VoiceDeps): string => join(deps.ctx.stateDir, VOICE_FILENAME);

function readFileSettings(deps: VoiceDeps): RawSettings {
  const raw = deps.files.read(settingsPath(deps));
  if (raw === null) return coerceVoiceFile(undefined);
  try {
    // SAFETY: `JSON.parse` answers with a JSON value, and `coerceVoiceFile` is its only reader.
    return coerceVoiceFile(JSON.parse(raw) as JsonValue);
  } catch {
    return coerceVoiceFile(undefined);
  }
}

function liveEnvKeys(ctx: CliContext): string[] {
  return Object.values(VOICE_ENV_KEYS).filter((name) => (ctx.env[name] ?? "").trim() !== "");
}

function keyLabel(apiKey: string): string {
  return apiKey.length <= 4 ? "set" : `set (…${apiKey.slice(-4)})`;
}

/** The only flags `setup` takes. Anything else is refused before a byte is written. */
const SETUP_FLAGS: ReadonlySet<string> = new Set(["key", "model", "lang", "voice"]);

const SETUP_USAGE = [
  "usage: collie voice setup [--model <id>] [--lang <iso-639-1>] [--voice <name>]",
  "       the key is asked for at the prompt, or read from COLLIE_VOICE_KEY (never from a flag by choice)",
  `                          [--lang <iso-639-1>] [--voice <name>]   (models: ${VOICE_MODELS.join(", ")})`,
];

async function ask(
  deps: VoiceDeps,
  flag: string | undefined,
  question: string,
  lead: string[],
): Promise<string | null> {
  if (flag !== undefined) return flag.trim();
  if (!deps.interactive) return null;
  for (const line of lead) deps.io.out(line);
  const answered = await deps.prompt(question);
  return answered === null ? null : answered.trim();
}

/** `collie voice setup` — take a Gemini key, prove the bridge would accept it, write `voice.json`. */
export async function cmdVoiceSetup(deps: VoiceDeps, args: readonly string[]): Promise<number> {
  const { flags, positional } = parseCrewArgs(args, []);

  // A typo such as `--modle` must not let setup succeed with the default model the operator meant to
  // override, and in an unattended run nobody is there to notice. Refused before anything is written.
  const unknown = [...Object.keys(flags).filter((name) => !SETUP_FLAGS.has(name)).map((n) => `--${n}`), ...positional];
  if (unknown.length > 0) {
    deps.io.err(`error: unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(" ")}. Nothing was written.`);
    for (const line of SETUP_USAGE) deps.io.err(line);
    return EXIT.USAGE;
  }

  // The key stays out of argv where it can: a flag is visible to `ps` while the command runs and sits
  // in shell history afterwards. COLLIE_VOICE_KEY (exported from a secret store, or via
  // `read -rs`) and the prompt both keep it out. `--key` still works, with a warning.
  const fromEnv = deps.ctx.env[VOICE_ENV_KEYS.key]?.trim();
  if (flags.key !== undefined) {
    deps.io.err(
      "warning: --key puts the key in this process's arguments and your shell history. " +
        `Prefer the prompt, or export ${VOICE_ENV_KEYS.key} and run setup without the flag.`,
    );
  }
  const key = await ask(deps, flags.key ?? (fromEnv === "" ? undefined : fromEnv), "Gemini API key: ", [
    "A Gemini API key (https://aistudio.google.com/apikey). Audio and screen text from the pane you",
    "talk about leave this machine for Google while a voice session is open.",
    `This terminal cannot read without echo, so what you type is visible; it lands in ${VOICE_FILENAME}`,
    "at mode 0600 and is never printed again.",
  ]);
  if (key === null || key === "") {
    deps.io.err(
      `error: a key is required — run setup at a terminal, or export ${VOICE_ENV_KEYS.key} first. Nothing was written.`,
    );
    return EXIT.FAIL;
  }
  const model = await ask(deps, flags.model, `model [${DEFAULT_VOICE_MODEL}]: `, [
    `Empty takes Collie's default, ${DEFAULT_VOICE_MODEL}. Options: ${VOICE_MODELS.join(", ")}.`,
  ]);
  const language = await ask(deps, flags.lang, "spoken language [auto-detect]: ", [
    "Two-letter code (da, en, de). Empty lets the model detect it.",
  ]);
  const voiceName = await ask(deps, flags.voice, "Gemini voice [model default]: ", [
    "A prebuilt voice name (for example Puck, Kore). Empty takes the model's default.",
  ]);

  // Absent means default, so an empty answer leaves the field OUT of the file: a defaulted model
  // must not be pinned to today's default forever.
  const document: RawSettings = { provider: "gemini-live", apiKey: key };
  if (model !== null && model !== "") document.model = model;
  if (language !== null && language !== "") document.language = language;
  if (voiceName !== null && voiceName !== "") document.voiceName = voiceName;

  const warnings: string[] = [];
  const resolved = resolveVoiceSettings(document, {}, (m) => warnings.push(m));
  if (resolved === null) {
    for (const line of warnings) deps.io.err(`error: ${line}`);
    for (const line of SETUP_USAGE) deps.io.err(line);
    deps.io.err("Nothing was written.");
    return EXIT.FAIL;
  }
  if (resolved.language !== undefined) document.language = resolved.language;

  const path = settingsPath(deps);
  const temporary = `${path}.tmp`;
  try {
    deps.files.mkdirp(deps.ctx.stateDir, 0o700);
    deps.files.write(temporary, `${JSON.stringify(document, null, 2)}\n`, 0o600);
    deps.files.rename(temporary, path);
  } catch (err) {
    deps.files.remove(temporary);
    deps.io.err(`error: could not write ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ voice mode configured — ${path} (owner-only)`);
  deps.io.out("  Live immediately — no restart needed. Check it end to end with `collie voice test`.");
  reportEnvOverrides(deps);
  return EXIT.OK;
}

/** The settings as the bridge would resolve them right now, from file plus environment. */
function resolveNow(deps: VoiceDeps, warnings: string[]): VoiceSettings | null {
  return resolveVoiceSettings(readFileSettings(deps), voiceEnvSettings(deps.ctx.env), (m) => warnings.push(m));
}

/**
 * `collie voice test` — open one real session through the bridge's own relay and wait for it to
 * come up. It sends no audio: what it proves is the key, the model id and the wire, which is what
 * fails after somebody has spoken into the microphone otherwise.
 */
export async function cmdVoiceTest(deps: VoiceDeps): Promise<number> {
  const warnings: string[] = [];
  const settings = resolveNow(deps, warnings);
  if (settings === null) {
    deps.io.err("error: voice mode is off — run `collie voice setup`.");
    for (const line of warnings) deps.io.err(`  ${line}`);
    return EXIT.FAIL;
  }
  const opened: VoiceRelay[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.timeoutMs ?? 15_000);
    const relay = new VoiceRelay({
      settings,
      open: deps.open ?? openGeminiSocket,
      send: (message) => {
        if (message.t === "ready") resolve("ready");
        if (message.t === "error") resolve(message.code);
      },
      onEnd: () => resolve("closed"),
    });
    opened.push(relay);
    relay.start();
  });
  clearTimeout(timer);
  for (const relay of opened) relay.onClientClosed();
  if (outcome === "ready") {
    deps.io.out(`✓ a ${settings.model} session came up. Voice mode will work from the phone.`);
    return EXIT.OK;
  }
  deps.io.err(`error: the session did not come up (${outcome}). Check the key and the model id.`);
  return EXIT.FAIL;
}

/** `collie voice status` — what is configured, and where each part came from. Never the key. */
export function cmdVoiceStatus(deps: VoiceDeps): number {
  const file = readFileSettings(deps);
  const env = voiceEnvSettings(deps.ctx.env);
  const warnings: string[] = [];
  const settings = resolveVoiceSettings(file, env, (m) => warnings.push(m));
  const path = settingsPath(deps);
  const source = (name: keyof RawSettings): string => {
    if (env[name] !== undefined) return VOICE_ENV_KEYS[envKeyOf(name)];
    if (file[name] !== undefined) return VOICE_FILENAME;
    return "default";
  };
  const row = (label: string, value: string, from: string): void =>
    deps.io.out(`  ${label.padEnd(9)} ${value.padEnd(34)} (${from})`);

  if (settings === null) {
    if (warnings.length === 0) {
      deps.io.out("voice mode: off — nothing configured. Run `collie voice setup` to turn it on.");
      deps.io.out(`  config    ${path} (absent)`);
      return EXIT.OK;
    }
    deps.io.out("voice mode: off — the configuration on this machine cannot be used.");
    for (const line of warnings) deps.io.err(`  ${line}`);
    deps.io.out(`  config    ${path}`);
    return EXIT.FAIL;
  }
  deps.io.out("voice mode: on");
  row("provider", settings.provider, source("provider"));
  row("model", settings.model, source("model"));
  row("api key", keyLabel(settings.apiKey), source("apiKey"));
  row("language", settings.language ?? "auto-detect", source("language"));
  row("voice", settings.voiceName ?? "model default", source("voiceName"));
  deps.io.out(`  config    ${path}${deps.files.exists(path) ? "" : " (absent)"}`);
  return EXIT.OK;
}

/** The env key that carries one raw field. One switch, so a renamed field cannot silently mis-report. */
function envKeyOf(name: keyof RawSettings): keyof typeof VOICE_ENV_KEYS {
  return name === "apiKey" ? "key" : name;
}

function reportEnvOverrides(deps: VoiceDeps, verb: "setup" | "off" = "setup"): void {
  const live = liveEnvKeys(deps.ctx);
  if (live.length === 0) return;
  deps.io.out(
    verb === "off"
      ? `  ⚠ but the environment still configures it, and the environment wins: ${live.join(", ")}.`
      : `  ⚠ the environment overrides part of this, field by field: ${live.join(", ")}.`,
  );
}

/** `collie voice off` — remove `voice.json`, and only that file. A second `off` is a clean no-op. */
export function cmdVoiceOff(deps: VoiceDeps): number {
  const path = settingsPath(deps);
  const existed = deps.files.exists(path);
  try {
    deps.files.remove(path);
  } catch (err) {
    deps.io.err(`error: could not remove ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(
    existed
      ? `✓ removed ${path} — voice mode is off from the next request (no restart needed).`
      : `voice mode was already off — no ${path} to remove.`,
  );
  reportEnvOverrides(deps, "off");
  return EXIT.OK;
}

export function voiceUsage(): string {
  return `usage: collie voice {${VOICE_SUBCOMMANDS.join("|")}}`;
}

export async function cmdVoice(deps: VoiceDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup":
      return await cmdVoiceSetup(deps, rest);
    case "test":
      return await cmdVoiceTest(deps);
    case "status":
      return cmdVoiceStatus(deps);
    case "off":
      return cmdVoiceOff(deps);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown voice subcommand \`${sub}\``);
      }
      deps.io.err(voiceUsage());
      deps.io.err("  setup    take a Gemini key and write it into the state dir (interactive or by flag)");
      deps.io.err("  test     open one real session through what is configured");
      deps.io.err("  status   the model, where each setting came from, and whether it is on");
      deps.io.err("  off      remove voice.json — voice mode is absent again");
      return EXIT.USAGE;
  }
}
