import { describe, expect, test } from "bun:test";

import {
  canonicalVoiceLanguage,
  coerceVoiceFile,
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

  test("an unknown provider warns and is off", () => {
    const w = warnings();
    expect(resolveVoiceSettings({ provider: "myspace", apiKey: "k" }, none, w.warn)).toBeNull();
    expect(w.seen[0]).toContain("myspace");
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

describe("coerceVoiceFile", () => {
  test("a present field that is not a string is dropped with a warning, a blank one is not", () => {
    const w = warnings();
    expect(coerceVoiceFile({ apiKey: 123, model: "  ", language: null }, w.warn)).toEqual({});
    expect(w.seen).toEqual(['"apiKey" in voice.json is not a string — ignored']);
  });
});

describe("createVoiceSettingsReader", () => {
  test("a changed mtime is re-read, and a file turned broken is reported once and the last good one kept", async () => {
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
    // The reload path: same reader, new mtime, new content.
    mtime = 2;
    text = JSON.stringify({ apiKey: "b" });
    expect((await read())?.apiKey).toBe("b");
    mtime = 3;
    text = "{not json";
    expect((await read())?.apiKey).toBe("b");
    expect(w.seen).toHaveLength(1);
    await read();
    expect(w.seen).toHaveLength(1);
    mtime = null;
    expect(await read()).toBeNull();
  });

  test("a file that becomes valid JSON but not an object keeps the last good settings", async () => {
    let mtime = 1;
    let text = JSON.stringify({ apiKey: "a" });
    const w = warnings();
    const read = createVoiceSettingsReader({
      stateDir: "/s",
      warn: w.warn,
      env: {},
      io: { mtime: async () => mtime, read: async () => text },
    });
    expect((await read())?.apiKey).toBe("a");
    for (const body of ["null", "[]"]) {
      mtime += 1;
      text = body;
      expect((await read())?.apiKey).toBe("a");
    }
    expect(w.seen).toHaveLength(2);
    expect(w.seen[0]).toContain("not a settings object");
  });
});
