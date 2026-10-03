import { describe, expect, test } from "vitest";

import {
  base64ToPcm16,
  createPcm16Decoder,
  createResampler,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
  resample,
  rms,
} from "./pcm";

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

  test("a stream resampled in blocks equals the same stream resampled whole", () => {
    const whole = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin(i / 7));
    const expected = resample(whole, 48_000, 16_000);
    const next = createResampler(48_000, 16_000);
    const parts: number[] = [];
    for (let at = 0; at < whole.length; at += 2048) parts.push(...next(whole.subarray(at, at + 2048)));
    expect(Math.abs(parts.length - expected.length)).toBeLessThanOrEqual(1);
    parts.slice(0, expected.length - 1).forEach((v, i) => expect(Math.abs(v - (expected[i] ?? 0))).toBeLessThan(1e-6));
  });

  test("blocks that do not divide the ratio lose no samples over a long stream", () => {
    const next = createResampler(44_100, 16_000);
    let total = 0;
    for (let i = 0; i < 100; i++) total += next(new Float32Array(2048)).length;
    expect(Math.abs(total - (100 * 2048 * 16_000) / 44_100)).toBeLessThanOrEqual(1);
  });

  test("the stream decoder carries a torn byte into the next chunk instead of dropping it", () => {
    const pcm = Int16Array.of(258, -2, 300, -400);
    const bytes = new Uint8Array(pcm.buffer);
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const decode = createPcm16Decoder();
    const a = decode(b64(bytes.subarray(0, 3)));
    const b = decode(b64(bytes.subarray(3, 8)));
    expect([...a, ...b]).toEqual([258, -2, 300, -400]);
  });

  test("the one-shot decoder still drops a torn trailing byte", () => {
    expect(base64ToPcm16(btoa("\u0001\u0000\u0002")).length).toBe(1);
  });

  test("content above the new Nyquist is removed, not folded back into the band", () => {
    const tone = (hz: number) => Float32Array.from({ length: 48_000 }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 48_000));
    const settle = (out: Float32Array) => out.subarray(200);
    // 10 kHz is above 16 kHz / 2: unfiltered decimation would alias it to a full-strength 6 kHz.
    const aliased = rms(settle(resample(tone(10_000), 48_000, 16_000)));
    const kept = rms(settle(resample(tone(1_000), 48_000, 16_000)));
    expect(kept).toBeGreaterThan(0.65);
    expect(aliased).toBeLessThan(0.05);
  });

  test("the low-pass does not break block independence", () => {
    const whole = Float32Array.from({ length: 24_000 }, (_, i) => Math.sin(i / 3) + Math.sin(i / 11));
    const expected = resample(whole, 44_100, 16_000);
    const next = createResampler(44_100, 16_000);
    const parts: number[] = [];
    for (let at = 0; at < whole.length; at += 1000) parts.push(...next(whole.subarray(at, at + 1000)));
    parts.slice(0, expected.length - 2).forEach((v, i) => expect(Math.abs(v - (expected[i] ?? 0))).toBeLessThan(1e-5));
  });
});
