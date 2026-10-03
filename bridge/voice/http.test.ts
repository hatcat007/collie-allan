import { describe, expect, test } from "bun:test";

import { createVoiceAdmission, voiceCapability } from "./http.ts";

describe("voice http rules", () => {
  test("capability carries provider and model, never the key", () => {
    const wire = voiceCapability({ provider: "gemini-live", apiKey: "secret", model: "gemini-3.8-live" });
    expect(wire).toEqual({ provider: "gemini-live", model: "gemini-3.8-live" });
    expect(JSON.stringify(wire)).not.toContain("secret");
    expect(voiceCapability(null)).toBeNull();
  });

  test("admission is capped, non-queued, and release is idempotent", () => {
    const gate = createVoiceAdmission(1);
    const release = gate.acquire();
    expect(release).not.toBeNull();
    expect(gate.acquire()).toBeNull();
    release?.();
    release?.();
    expect(gate.acquire()).not.toBeNull();
    expect(gate.acquire()).toBeNull();
  });
});
