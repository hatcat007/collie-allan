import { describe, expect, test } from "vitest";

import { base64ToPcm16, floatToPcm16, pcm16ToBase64, pcm16ToFloat, resample, rms } from "./pcm";

describe("pcm", () => {
  test("float to int16 clamps and hits the rails", () => {
    expect([...floatToPcm16(Float32Array.of(0, 1, -1, 2, -2))]).toEqual([0, 32767, -32768, 32767, -32768]);
  });

  test("int16 round-trips through float within one step", () => {
    const pcm = Int16Array.of(0, 1000, -1000, 32767, -32768);
    const back = floatToPcm16(pcm16ToFloat(pcm));
    pcm.forEach((v, i) => expect(Math.abs((back[i] ?? 0) - v)).toBeLessThanOrEqual(1));
  });

  test("base64 round-trips and drops a torn trailing byte", () => {
    const pcm = Int16Array.of(1, -2, 300, -400);
    expect([...base64ToPcm16(pcm16ToBase64(pcm))]).toEqual([1, -2, 300, -400]);
    expect(base64ToPcm16(btoa("\u0001\u0000\u0002")).length).toBe(1);
  });

  test("base64 survives a clip longer than the argument limit", () => {
    const pcm = new Int16Array(100_000).fill(7);
    expect(base64ToPcm16(pcm16ToBase64(pcm)).length).toBe(100_000);
  });

  test("resample is the identity at equal rates and scales length otherwise", () => {
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10));
    expect(resample(input, 16_000, 16_000)).toBe(input);
    expect(resample(input, 48_000, 16_000).length).toBe(1600);
    expect(resample(input, 16_000, 24_000).length).toBe(7200);
  });

  test("resample keeps a constant signal constant", () => {
    const out = resample(new Float32Array(480).fill(0.5), 48_000, 16_000);
    expect([...out].every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  test("rms of silence is zero and of a full-scale square is one", () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(Float32Array.of(1, -1, 1, -1))).toBeCloseTo(1);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
