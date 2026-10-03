// ── PCM, AS PURE FUNCTIONS ───────────────────────────────────────────────────────────────────
//
// Gemini Live takes raw 16-bit little-endian mono PCM at 16 kHz and answers with the same at
// 24 kHz. The browser's microphone arrives as Float32 at the AudioContext's own rate (44.1 or 48
// kHz), so these four conversions are the whole of the audio maths. They touch no AudioContext, which
// is what lets `vitest` pin them without a browser.

export const CAPTURE_RATE = 16_000;
export const PLAYBACK_RATE = 24_000;

/** Linear-interpolating resample. Identity when the rates match. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const lo = Math.floor(at);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = at - lo;
    out[i] = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac;
  }
  return out;
}

/** Float32 in [-1, 1] to Int16, clamped. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Int16 back to Float32 in [-1, 1]. */
export function pcm16ToFloat(input: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = (input[i] ?? 0) / 0x8000;
  return out;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument limit on a long clip.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  // An odd byte count is a torn frame; the trailing byte cannot be a sample.
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Root-mean-square level of a Float32 block, 0..1. Drives the "listening" meter. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (const v of input) sum += v * v;
  return Math.sqrt(sum / input.length);
}
