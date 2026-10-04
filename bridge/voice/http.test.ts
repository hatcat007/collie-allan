import { describe, expect, test } from "bun:test";

import { createVoiceAdmission, spentTicketAdmitted, spentTicketBound, voiceCapability } from "./http.ts";

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
    expect(spentTicketAdmitted({ device: "phone", token: "good", binding: null }, paired)).toBe(true);
    // Revoked between mint and upgrade: the registry no longer knows the token.
    expect(spentTicketAdmitted({ device: "phone", token: "revoked", binding: null }, paired)).toBe(false);
    expect(spentTicketAdmitted({ device: "phone", token: null, binding: null }, paired)).toBe(false);
    // The LAST device revoked: the registry is empty, so enforcement is off, and its outstanding
    // ticket must still be refused.
    const emptied = { enforced: () => false, resolve: () => null };
    expect(spentTicketAdmitted({ device: "phone", token: "revoked", binding: null }, emptied)).toBe(false);
    // A ticket minted with pairing off rides on pairing still being off, and no longer does once a
    // device has been paired in the meantime.
    expect(spentTicketAdmitted({ device: "x", token: null, binding: null }, emptied)).toBe(true);
    expect(spentTicketAdmitted({ device: "x", token: null, binding: null }, paired)).toBe(false);
    expect(spentTicketAdmitted({ device: "x", token: null, binding: null }, undefined)).toBe(true);
  });

  test("a ticket is spent only under the proxy identity it was minted under", () => {
    const spent = { device: "phone", token: null, binding: "alice@phone" };
    expect(spentTicketBound(spent, "alice@phone")).toBe(true);
    expect(spentTicketBound(spent, "bob@laptop")).toBe(false);
    expect(spentTicketBound(spent, null)).toBe(false);
    expect(spentTicketBound({ ...spent, binding: null }, null)).toBe(true);
    expect(spentTicketBound({ ...spent, binding: null }, "bob@laptop")).toBe(false);
  });
});
