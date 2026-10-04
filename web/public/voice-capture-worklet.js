// Microphone capture for voice mode. Runs on the audio thread: it only batches the browser's own
// 128-sample blocks into 2048-sample Float32 frames and posts them to the page, which resamples to
// 16 kHz and encodes. Loaded same-origin by `lib/voice/audio.ts` (CSP: `script-src 'self'`).
class CollieCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    for (const sample of channel) {
      this.frame[this.filled] = sample;
      this.filled += 1;
      if (this.filled === this.frame.length) {
        // Transferred, not copied: the page owns this buffer from here, so a fresh one starts.
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(2048);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("collie-capture", CollieCapture);
