import { describe, expect, test } from "bun:test";

import {
  canonicalVoiceLanguage,
  createVoiceSettingsReader,
  DEFAULT_VOICE_MODEL,
  resolveVoiceSettings,
} from "./config.ts";

const none = {};
const warnings = () => {
  const seen: string[] = [];
  return { seen, warn: (m: string) => void seen.push(m) };
};

describe("resolveVoiceSettings", () => {
  test("nothing configured is off, silently", () => {
    const w = warnings();
    expect(resolveVoiceSettings(none, none, w.warn)).toBeNull();
    expect(w.seen).toEqual([]);
  });

  test("a key alone resolves with the default model", () => {
    expect(resolveVoiceSettings({ apiKey: "k" }, none, () => {})).toEqual({
      provider: "gemini-live",
      apiKey: "k",
      model: DEFAULT_VOICE_MODEL,
    });
  });

  test("the environment wins over the file field by field", () => {
    const s = resolveVoiceSettings(
      { apiKey: "file", model: "gemini-3.8-live" },
      { apiKey: "env", model: "gemini-3.8-live-extended-thinking", language: "da-DK", voiceName: "Puck" },
      () => {},
    );
    expect(s).toEqual({
      provider: "gemini-live",
      apiKey: "env",
      model: "gemini-3.8-live-extended-thinking",
      language: "da",
      voiceName: "Puck",
    });
  });

  test("a missing key warns and is off", () => {
    const w = warnings();
    expect(resolveVoiceSettings({ model: "gemini-3.8-live" }, none, w.warn)).toBeNull();
    expect(w.seen).toHaveLength(1);
  });

  test("an unknown model warns and is off", () => {
    const w = warnings();
    expect(resolveVoiceSettings({ apiKey: "k", model: "gemini-9" }, none, w.warn)).toBeNull();
    expect(w.seen[0]).toContain("gemini-9");
  });

  test("a language name is refused", () => {
    const w = warnings();
    expect(resolveVoiceSettings({ apiKey: "k", language: "danish" }, none, w.warn)).toBeNull();
    expect(w.seen).toHaveLength(1);
  });
});

describe("canonicalVoiceLanguage", () => {
  test("narrows regional tags", () => {
    expect(canonicalVoiceLanguage("pt_BR")).toBe("pt");
    expect(canonicalVoiceLanguage("DA")).toBe("da");
    expect(canonicalVoiceLanguage("dan")).toBeNull();
  });
});

describe("createVoiceSettingsReader", () => {
  test("re-reads on mtime change and holds the last good file when it breaks", async () => {
    let mtime: number | null = 1;
    let text = JSON.stringify({ apiKey: "a" });
    const w = warnings();
    const read = createVoiceSettingsReader({
      stateDir: "/s",
      warn: w.warn,
      env: {},
      io: { mtime: async () => mtime, read: async () => text },
    });
    expect((await read())?.apiKey).toBe("a");
    mtime = 2;
    text = "{not json";
    expect((await read())?.apiKey).toBe("a");
    expect(w.seen).toHaveLength(1);
    await read();
    expect(w.seen).toHaveLength(1);
    mtime = null;
    expect(await read()).toBeNull();
  });
});
