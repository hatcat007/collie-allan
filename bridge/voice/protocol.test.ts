import { describe, expect, test } from "bun:test";

import type { VoiceSettings } from "./config.ts";
import {
  buildAudioFrame,
  buildAudioStreamEnd,
  buildSetup,
  buildToolResponse,
  geminiLiveUrl,
  parseServerFrame,
} from "./protocol.ts";
import { VOICE_FUNCTION_DECLARATIONS } from "./tools.ts";

const settings: VoiceSettings = { provider: "gemini-live", apiKey: "k", model: "gemini-3.8-live" };

describe("buildSetup", () => {
  test("names the model, audio modality, tools and transcription", () => {
    const frame = buildSetup(settings, "agent");
    expect(frame).toMatchObject({
      setup: {
        model: "models/gemini-3.8-live",
        generationConfig: { responseModalities: ["AUDIO"] },
        tools: [{ functionDeclarations: VOICE_FUNCTION_DECLARATIONS }],
        outputAudioTranscription: {},
        sessionResumption: {},
      },
    });
  });

  test("language and voice flow through; the resume handle is carried", () => {
    const frame = JSON.parse(
      JSON.stringify(buildSetup({ ...settings, language: "da", voiceName: "Puck" }, "agent", "h1")),
    );
    expect(frame.setup.inputAudioTranscription).toEqual({ languageCodes: ["da"] });
    expect(frame.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(frame.setup.sessionResumption).toEqual({ handle: "h1" });
  });

  test("dictation declares no tools and tells the model to stay silent", () => {
    const frame = JSON.parse(JSON.stringify(buildSetup(settings, "dictate")));
    expect(frame.setup.tools).toBeUndefined();
    expect(frame.setup.systemInstruction.parts[0].text).toContain("Never speak");
  });

  test("every declaration is NON_BLOCKING", () => {
    for (const d of VOICE_FUNCTION_DECLARATIONS) expect(d.behavior).toBe("NON_BLOCKING");
  });
});

describe("frames", () => {
  test("audio, stream end, tool response, url", () => {
    expect(buildAudioFrame("AAA=")).toEqual({
      realtimeInput: { audio: { data: "AAA=", mimeType: "audio/pcm;rate=16000" } },
    });
    expect(buildAudioStreamEnd()).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(buildToolResponse("1", "read_pane", { result: "ok" })).toEqual({
      toolResponse: { functionResponses: [{ id: "1", name: "read_pane", response: { result: "ok" } }] },
    });
    expect(geminiLiveUrl("a b")).toContain("?key=a%20b");
  });
});

describe("parseServerFrame", () => {
  test("one frame can carry audio, transcript and turn end in order", () => {
    const events = parseServerFrame({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "QQ==", mimeType: "audio/pcm;rate=24000" } }] },
        outputTranscription: { text: "hej" },
        turnComplete: true,
      },
    });
    expect(events).toEqual([
      { kind: "audio", base64: "QQ==" },
      { kind: "output_text", text: "hej" },
      { kind: "turn_complete" },
    ]);
  });

  test("interrupted comes first; input transcription is read", () => {
    expect(
      parseServerFrame({ serverContent: { interrupted: true, inputTranscription: { text: "stop" } } }),
    ).toEqual([{ kind: "interrupted" }, { kind: "input_text", text: "stop" }]);
  });

  test("tool calls keep id, name and args; malformed ones are dropped", () => {
    expect(
      parseServerFrame({
        toolCall: {
          functionCalls: [{ id: "a", name: "draft_reply", args: { text: "x" } }, { name: "no-id" }, "junk"],
        },
      }),
    ).toEqual([{ kind: "tool_call", call: { id: "a", name: "draft_reply", args: { text: "x" } } }]);
  });

  test("setup, goAway, resumption, cancellation", () => {
    expect(parseServerFrame({ setupComplete: {} })).toEqual([{ kind: "setup_complete" }]);
    expect(parseServerFrame({ goAway: { timeLeft: { seconds: 30 } } })).toEqual([
      { kind: "go_away", seconds: 30 },
    ]);
    expect(parseServerFrame({ sessionResumptionUpdate: { newHandle: "h", resumable: true } })).toEqual([
      { kind: "resumption", handle: "h" },
    ]);
    expect(parseServerFrame({ sessionResumptionUpdate: { newHandle: "h", resumable: false } })).toEqual([]);
    expect(parseServerFrame({ toolCallCancellation: { ids: ["a", 3] } })).toEqual([
      { kind: "tool_cancelled", ids: ["a"] },
    ]);
  });

  test("non-objects and unknown frames yield nothing", () => {
    expect(parseServerFrame("x")).toEqual([]);
    expect(parseServerFrame({ usageMetadata: {} })).toEqual([]);
  });
});
