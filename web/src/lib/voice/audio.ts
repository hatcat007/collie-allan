import { mounted } from "@/lib/base-path";
import {
  base64ToPcm16,
  CAPTURE_RATE,
  floatToPcm16,
  PLAYBACK_RATE,
  pcm16ToBase64,
  pcm16ToFloat,
  resample,
  rms,
} from "./pcm";
import type { VoiceAudio } from "./session";

// The browser's half of the audio path, behind the `VoiceAudio` seam so the session never sees an
// AudioContext. Capture: microphone, then an AudioWorklet that batches 2048-sample frames, then
// resample to 16 kHz and encode. Playback: the model's 24 kHz chunks scheduled back to back on one
// context, every source tracked so a barge-in can stop them at once. Not unit-tested in jsdom, which
// has no Web Audio; the maths it leans on is (pcm.test.ts) and the rest is checked on a phone.

const WORKLET = "/voice-capture-worklet.js";

/** What capture holds. Registered BEFORE the first await, so teardown can release a half-started one. */
interface Capture {
  stream: MediaStream | null;
  context: AudioContext | null;
  node: AudioWorkletNode | null;
  detach: AbortController;
}

function release(held: Capture): void {
  held.detach.abort();
  held.node?.disconnect();
  for (const track of held.stream?.getTracks() ?? []) track.stop();
  void held.context?.close();
}

export function createVoiceAudio(): VoiceAudio {
  let capture: Capture | null = null;
  let closed = false;
  let speaker: AudioContext | null = null;
  let nextStart = 0;
  const active = new Set<AudioBufferSourceNode>();
  let idleCallback: (() => void) | null = null;

  const stopCapture = (): void => {
    if (capture === null) return;
    release(capture);
    capture = null;
  };

  const flush = (): void => {
    // Cleared FIRST: the `ended` listener only reports idle for a source still in `active`, so a
    // barge-in's own stops are not mistaken for the model finishing a sentence.
    const stopping = [...active];
    active.clear();
    for (const source of stopping) {
      try {
        source.stop();
      } catch {
        // already ended; nothing to stop
      }
    }
    nextStart = 0;
  };

  return {
    async startCapture(onChunk) {
      if (closed) throw new Error("voice audio is closed");
      const held: Capture = { stream: null, context: null, node: null, detach: new AbortController() };
      capture = held;
      // True once teardown has run (or a newer capture replaced this one) while an await was pending.
      const superseded = (): boolean => capture !== held;
      try {
        held.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (superseded()) throw new Error("capture stopped before the microphone opened");
        held.context = new AudioContext();
        const { context } = held;
        await context.audioWorklet.addModule(mounted(WORKLET));
        if (superseded()) throw new Error("capture stopped before the worklet loaded");
        const node = new AudioWorkletNode(context, "collie-capture");
        held.node = node;
        node.port.addEventListener(
          "message",
          (event: MessageEvent<Float32Array>) => {
            const mono = resample(event.data, context.sampleRate, CAPTURE_RATE);
            onChunk(pcm16ToBase64(floatToPcm16(mono)), Math.min(1, rms(mono) * 4));
          },
          { signal: held.detach.signal },
        );
        // Required with addEventListener: a MessagePort queues until it is started, and only the
        // `onmessage` setter starts it implicitly.
        node.port.start();
        context.createMediaStreamSource(held.stream).connect(node);
      } catch (err) {
        // Whatever was opened is released here: a refused permission, a worklet that failed to load
        // and a teardown that raced the awaits all end with the microphone and the context shut.
        release(held);
        if (capture === held) capture = null;
        throw err;
      }
    },
    stopCapture,
    play(base64) {
      speaker ??= new AudioContext({ sampleRate: PLAYBACK_RATE });
      const floats = pcm16ToFloat(base64ToPcm16(base64));
      if (floats.length === 0) return;
      const buffer = speaker.createBuffer(1, floats.length, PLAYBACK_RATE);
      buffer.copyToChannel(floats, 0);
      const source = speaker.createBufferSource();
      source.buffer = buffer;
      source.connect(speaker.destination);
      nextStart = Math.max(nextStart, speaker.currentTime);
      source.start(nextStart);
      nextStart += buffer.duration;
      active.add(source);
      source.addEventListener(
        "ended",
        () => {
          if (!active.delete(source)) return;
          if (active.size === 0) idleCallback?.();
        },
        { once: true },
      );
    },
    flush,
    onIdle(callback) {
      idleCallback = callback;
    },
    close() {
      closed = true;
      stopCapture();
      flush();
      void speaker?.close();
      speaker = null;
    },
  };
}
