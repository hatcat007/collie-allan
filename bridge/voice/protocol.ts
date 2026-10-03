import type { JsonObject, JsonValue } from "../json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "../stt/json.ts";
import type { VoiceSettings } from "./config.ts";
import { VOICE_FUNCTION_DECLARATIONS, type VoiceMode, voiceSystemInstruction } from "./tools.ts";

// ── THE GEMINI LIVE WIRE, AS PURE FUNCTIONS ──────────────────────────────────────────────────
//
// Raw WebSocket on purpose, no SDK: the bridge already speaks `fetch` to its other provider, a
// dependency is a seven-day age gate and a compiled-binary question, and the surface used is five
// message shapes. Nothing here opens a socket — builders return the frame, the parser returns a
// typed event — so `bun test` covers all of it. Shapes from ai.google.dev/api/live.

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** The URL with the key as the query parameter Google documents. Never logged, never reflected. */
export function geminiLiveUrl(apiKey: string): string {
  return `${GEMINI_LIVE_URL}?key=${encodeURIComponent(apiKey)}`;
}

export const INPUT_AUDIO_MIME = "audio/pcm;rate=16000";

/** The first frame of a session. `resumeHandle` is set when the bridge reconnects after a GoAway. */
export function buildSetup(settings: VoiceSettings, mode: VoiceMode, resumeHandle?: string): JsonObject {
  const speechConfig: JsonObject | undefined =
    settings.voiceName === undefined
      ? undefined
      : { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voiceName } } };
  const inputTranscription: JsonObject = {};
  if (settings.language !== undefined) inputTranscription.languageCodes = [settings.language];
  const setup: JsonObject = {
    model: `models/${settings.model}`,
    generationConfig: { responseModalities: ["AUDIO"], speechConfig },
    systemInstruction: { parts: [{ text: voiceSystemInstruction(settings.language, mode) }] },
    // Dictation declares no tools: there is nothing the silent transcriber may do.
    tools: mode === "agent" ? [{ functionDeclarations: VOICE_FUNCTION_DECLARATIONS }] : undefined,
    inputAudioTranscription: inputTranscription,
    outputAudioTranscription: {},
    // Past the 15-minute audio cap and across a GoAway: compress, and resume by handle.
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle === undefined ? {} : { handle: resumeHandle },
  };
  return { setup };
}

export function buildAudioFrame(base64Pcm: string): JsonObject {
  return { realtimeInput: { audio: { data: base64Pcm, mimeType: INPUT_AUDIO_MIME } } };
}

/** The microphone paused or closed: flush the model's VAD. */
export function buildAudioStreamEnd(): JsonObject {
  return { realtimeInput: { audioStreamEnd: true } };
}

export interface ToolCall {
  id: string;
  name: string;
  args: JsonObject;
}

/** `response` is whatever the phone answered; the model reads it as the function's result. */
export function buildToolResponse(id: string, name: string, response: JsonObject): JsonObject {
  return { toolResponse: { functionResponses: [{ id, name, response }] } };
}

/** What one server frame meant. A frame may carry several of these. */
export type LiveEvent =
  | { kind: "setup_complete" }
  | { kind: "audio"; base64: string }
  | { kind: "interrupted" }
  | { kind: "turn_complete" }
  | { kind: "input_text"; text: string }
  | { kind: "output_text"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_cancelled"; ids: string[] }
  | { kind: "go_away"; seconds: number | null }
  | { kind: "resumption"; handle: string };

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: JsonValue | undefined): string | null {
  const text = jsonStringField(jsonRecord(value)?.text);
  return text === null || text === "" ? null : text;
}

/**
 * A protobuf `Duration` as JSON is the string `"30s"` (or `"1.5s"`); the object form `{seconds}` is
 * accepted too, because that is what the docs spell. Null when it is neither.
 */
export function durationSeconds(value: JsonValue | undefined): number | null {
  const text = jsonStringField(value);
  if (text !== null) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(text);
    return match?.[1] === undefined ? null : Number(match[1]);
  }
  return jsonNumberField(jsonRecord(value)?.seconds);
}

/** Decode one server frame (already `JSON.parse`d) into events, in a stable order. */
export function parseServerFrame(frame: JsonValue): LiveEvent[] {
  const o = jsonRecord(frame);
  if (o === null) return [];
  const events: LiveEvent[] = [];

  if (jsonRecord(o.setupComplete) !== null) events.push({ kind: "setup_complete" });

  const content = jsonRecord(o.serverContent);
  if (content !== null) {
    if (content.interrupted === true) events.push({ kind: "interrupted" });
    for (const part of asArray(jsonRecord(content.modelTurn)?.parts)) {
      const data = jsonStringField(jsonRecord(jsonRecord(part)?.inlineData)?.data);
      if (data !== null) events.push({ kind: "audio", base64: data });
    }
    const input = textOf(content.inputTranscription);
    if (input !== null) events.push({ kind: "input_text", text: input });
    const output = textOf(content.outputTranscription);
    if (output !== null) events.push({ kind: "output_text", text: output });
    if (content.turnComplete === true) events.push({ kind: "turn_complete" });
  }

  const toolCall = jsonRecord(o.toolCall);
  if (toolCall !== null) {
    for (const raw of asArray(toolCall.functionCalls)) {
      const fc = jsonRecord(raw);
      const id = jsonStringField(fc?.id);
      const name = jsonStringField(fc?.name);
      if (fc === null || id === null || name === null) continue;
      events.push({ kind: "tool_call", call: { id, name, args: jsonRecord(fc.args) ?? {} } });
    }
  }

  const cancelled = jsonRecord(o.toolCallCancellation);
  if (cancelled !== null) {
    const ids = asArray(cancelled.ids).flatMap((id) => {
      const s = jsonStringField(id);
      return s === null ? [] : [s];
    });
    events.push({ kind: "tool_cancelled", ids });
  }

  const goAway = jsonRecord(o.goAway);
  if (goAway !== null) {
    events.push({ kind: "go_away", seconds: durationSeconds(goAway.timeLeft) });
  }

  const update = jsonRecord(o.sessionResumptionUpdate);
  if (update !== null && update.resumable === true) {
    const handle = jsonStringField(update.newHandle);
    if (handle !== null && handle !== "") events.push({ kind: "resumption", handle });
  }
  return events;
}
