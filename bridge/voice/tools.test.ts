import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isVoiceMode, isVoiceToolName, VOICE_FUNCTION_DECLARATIONS, VOICE_KEYS, VOICE_TOOL_NAMES } from "./tools.ts";

// The bridge declares the tools and keys; the phone runs them. Each side keeps its own closed list,
// so a name added on one side alone would be offered to the model and then refused by the phone.
// These tests read the phone's source and pin the two together.

const web = (path: string): string => readFileSync(join(import.meta.dir, "..", "..", "web", "src", path), "utf8");

/** The string literals inside the first `[ ... ]` after `marker`. */
function literals(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the bridge and the phone agree on what the model may do", () => {
  test("the tool names are the same list", () => {
    expect(literals(web("lib/voice/protocol.ts"), "export const VOICE_TOOL_NAMES")).toEqual([...VOICE_TOOL_NAMES]);
  });

  test("the keys the phone will press are the keys the bridge offers", () => {
    expect(literals(web("components/voice-sheet.tsx"), "const KEYS = new Set")).toEqual([...VOICE_KEYS]);
  });

  test("every declared function is a tool the phone runs, and no declaration is missing", () => {
    expect(VOICE_FUNCTION_DECLARATIONS.map((d) => d.name)).toEqual([...VOICE_TOOL_NAMES]);
  });

  test("the guards accept exactly their lists", () => {
    for (const name of VOICE_TOOL_NAMES) expect(isVoiceToolName(name)).toBe(true);
    expect(isVoiceToolName("rm_rf")).toBe(false);
    expect(isVoiceMode("agent")).toBe(true);
    expect(isVoiceMode("shout")).toBe(false);
  });
});
