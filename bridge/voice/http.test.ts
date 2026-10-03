import { describe, expect, test } from "bun:test";

import { createVoiceAdmission, spentTicketAdmitted, voiceCapability } from "./http.ts";

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

  test("a spent ticket is re-checked against the pairing registry at the upgrade", () => {
    const paired = { enforced: () => true, resolve: (t: string | null) => (t === "good" ? { label: "phone" } : null) };
    expect(spentTicketAdmitted({ device: "phone", token: "good" }, paired)).toBe(true);
    // Revoked between mint and upgrade: the registry no longer knows the token.
    expect(spentTicketAdmitted({ device: "phone", token: "revoked" }, paired)).toBe(false);
    expect(spentTicketAdmitted({ device: "phone", token: null }, paired)).toBe(false);
    // Pairing off, or no registry: nothing to re-ask.
    expect(spentTicketAdmitted({ device: "x", token: null }, { ...paired, enforced: () => false })).toBe(true);
    expect(spentTicketAdmitted({ device: "x", token: null }, undefined)).toBe(true);
  });
});
