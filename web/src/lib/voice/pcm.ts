// ── PCM, AS PURE FUNCTIONS ───────────────────────────────────────────────────────────────────
//
// Gemini Live takes raw 16-bit little-endian mono PCM at 16 kHz and answers with the same at
// 24 kHz. The browser's microphone arrives as Float32 at the AudioContext's own rate (44.1 or 48
// kHz), so these four conversions are the whole of the audio maths. They touch no AudioContext, which
// is what lets `vitest` pin them without a browser.

export const CAPTURE_RATE = 16_000;
export const PLAYBACK_RATE = 24_000;

/**
 * A linear-interpolating resampler that REMEMBERS WHERE IT WAS between blocks.
 *
 * The microphone arrives in 2048-sample blocks, and resampling each one from a fresh phase floors
 * its length and jumps the waveform at every boundary: at 48 kHz that drops about two thirds of an
 * output sample per block and adds a click per block. This one keeps the fractional read position
 * and the last input sample, so a stream cut into any blocks resamples to the same samples as the
 * stream resampled whole. Identity when the rates match.
 */
export function createResampler(inRate: number, outRate: number): (input: Float32Array) => Float32Array {
  if (inRate === outRate) return (input) => input;
  // The read position of output sample `produced` is produced * inRate / outRate. It is kept as an
  // INTEGER NUMERATOR over `outRate`, so no float error accumulates across a long stream and the
  // block boundary lands exactly where whole-stream resampling would put it.
  let produced = 0;
  let consumed = 0;
  let previous: number | null = null;
  return (input) => {
    if (input.length === 0) return input;
    const first = input[0] ?? 0;
    previous ??= first;
    // Virtual block [previous, ...input]: 0 is the last sample of the previous block, 1 is input[0].
    const at = (i: number): number => (i === 0 ? (previous ?? first) : (input[i - 1] ?? 0));
    const limit = input.length * outRate;
    const out: number[] = [];
    for (;;) {
      const numerator = produced * inRate - consumed * outRate;
      if (numerator >= limit) break;
      const lo = Math.floor(numerator / outRate);
      const frac = (numerator - lo * outRate) / outRate;
      out.push(at(lo) * (1 - frac) + at(lo + 1) * frac);
      produced += 1;
    }
    consumed += input.length;
    previous = input.at(-1) ?? first;
    return Float32Array.from(out);
  };
}

/** One-shot resample of a whole buffer. Streams use {@link createResampler}. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  return createResampler(inRate, outRate)(input);
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

/**
 * A decoder for a STREAM of base64 PCM chunks. A chunk may end between the two bytes of a sample;
 * the lone byte is held and prepended to the next chunk, so playback never loses it and never
 * shifts every later sample by one byte.
 */
export function createPcm16Decoder(): (base64: string) => Int16Array {
  let held: number | null = null;
  return (base64) => {
    const binary = atob(base64);
    const lead = held === null ? 0 : 1;
    const all = new Uint8Array(lead + binary.length);
    if (held !== null) all[0] = held;
    for (let i = 0; i < binary.length; i++) all[lead + i] = binary.charCodeAt(i);
    held = all.length % 2 === 1 ? (all.at(-1) ?? null) : null;
    return new Int16Array(all.buffer.slice(0, all.length - (all.length % 2)));
  };
}

/** One-shot decode of a COMPLETE clip; a torn trailing byte is dropped. Streams use the decoder. */
export function base64ToPcm16(base64: string): Int16Array {
  return createPcm16Decoder()(base64);
}

/** Root-mean-square level of a Float32 block, 0..1. Drives the "listening" meter. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (const v of input) sum += v * v;
  return Math.sqrt(sum / input.length);
}
