import type { JsonObject, JsonValue } from "@/lib/json";
import { asJsonObject, asJsonString, parseJsonObject } from "@/lib/json";

// The phone's end of the voice socket (bridge/voice/session.ts owns the other). Two directions, one
// short vocabulary: `t` names the message and the rest is its payload.

export type VoiceMode = "agent" | "dictate";

/** What the bridge reports when a session ends badly. Translated here, never shown raw. */
export type VoiceErrorCode =
  | "voice.upstream_unavailable"
  | "voice.upstream_closed"
  | "voice.bad_message"
  | "voice.too_long";

// MIRROR of `bridge/voice/tools.ts` (VOICE_TOOL_NAMES), pinned by `bridge/voice/tools.test.ts`.
export const VOICE_TOOL_NAMES = ["read_pane", "draft_reply", "send_reply", "press_key"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

export type VoiceServerMessage =
  | { t: "ready" }
  | { t: "audio"; data: string }
  | { t: "interrupted" }
  | { t: "turn_complete" }
  | { t: "in_text"; text: string }
  | { t: "out_text"; text: string }
  | { t: "tool_call"; id: string; name: string; args: JsonObject }
  | { t: "tool_cancelled"; ids: string[] }
  | { t: "error"; code: VoiceErrorCode }
  | { t: "closed" };

export type VoiceClientMessage =
  | { t: "start"; mode: VoiceMode }
  | { t: "audio"; data: string }
  | { t: "end" }
  | { t: "tool_result"; id: string; response: JsonObject };

const ERROR_CODES: ReadonlySet<string> = new Set([
  "voice.upstream_unavailable",
  "voice.upstream_closed",
  "voice.bad_message",
  "voice.too_long",
]);

export function isVoiceToolName(name: string): name is VoiceToolName {
  return VOICE_TOOL_NAMES.some((known) => known === name);
}

function isErrorCode(code: string): code is VoiceErrorCode {
  return ERROR_CODES.has(code);
}

function strings(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const s = asJsonString(item);
    return s === undefined ? [] : [s];
  });
}

/** One frame from the bridge, or null when it is not one this phone understands. */
export function parseServerMessage(raw: string): VoiceServerMessage | null {
  const o = parseJsonObject(raw);
  const t = o === undefined ? undefined : asJsonString(o.t);
  if (o === undefined || t === undefined) return null;
  switch (t) {
    case "ready":
    case "interrupted":
    case "turn_complete":
    case "closed":
      return { t };
    case "audio": {
      const data = asJsonString(o.data);
      return data === undefined ? null : { t, data };
    }
    case "in_text":
    case "out_text": {
      const text = asJsonString(o.text);
      return text === undefined ? null : { t, text };
    }
    case "tool_call": {
      const id = asJsonString(o.id);
      const name = asJsonString(o.name);
      if (id === undefined || name === undefined) return null;
      return { t, id, name, args: asJsonObject(o.args) ?? {} };
    }
    case "tool_cancelled":
      return { t, ids: strings(o.ids) };
    case "error": {
      const code = asJsonString(o.code);
      return code !== undefined && isErrorCode(code) ? { t, code } : null;
    }
    default:
      return null;
  }
}
