import { mounted } from "@/lib/base-path";
import {
  CAPTURE_RATE,
  createPcm16Decoder,
  createResampler,
  floatToPcm16,
  PLAYBACK_RATE,
  pcm16ToBase64,
  pcm16ToFloat,
  rms,
} from "./pcm";
import type { VoiceAudio } from "./session";

// The browser's half of the audio path, behind the `VoiceAudio` seam so the session never sees an
// AudioContext. Capture: microphone, then an AudioWorklet that batches 2048-sample frames, then
// resample to 16 kHz and encode. Playback: the model's 24 kHz chunks scheduled back to back on one
// context, every source tracked so a barge-in can stop them at once. Not unit-tested in jsdom, which
// has no Web Audio; the maths it leans on is (pcm.test.ts) and the rest is checked on a phone.
// Playback runs through a gain and a limiter, not straight to the destination: with the
// echo-cancelled microphone open, phones treat the session as a call and play it far quieter than
// media, and the model's audio is mastered quiet besides.

const WORKLET = "/voice-capture-worklet.js";

/** Makeup gain for the model's voice (~+8 dB). The limiter after it keeps the peaks from clipping. */
const PLAYBACK_GAIN = 2.5;

declare global {
  interface Navigator {
    /** Safari 16.4+ only; lib.dom does not type it yet, and every other browser leaves it absent. */
    audioSession?: { type: string };
  }
}

/**
 * Ask iOS for the loudspeaker. "play-and-record" maps to PlayAndRecord with DefaultToSpeaker, so the
 * open microphone no longer sends the model's voice to the earpiece. Elsewhere this does nothing.
 */
function setAudioSession(type: string): void {
  const session = navigator.audioSession;
  if (session === undefined) return;
  try {
    session.type = type;
  } catch {
    // a browser that rejects the type keeps its own routing
  }
}

/** The speaker context and the node every source plays into: gain, then a limiter, then out. */
interface Speaker {
  context: AudioContext;
  input: GainNode;
}

function createSpeaker(): Speaker {
  const context = new AudioContext({ sampleRate: PLAYBACK_RATE });
  const input = context.createGain();
  input.gain.value = PLAYBACK_GAIN;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  input.connect(limiter).connect(context.destination);
  return { context, input };
}

/** What capture holds. Registered BEFORE the first await, so teardown can release a half-started one. */
interface Capture {
  stream: MediaStream | null;
  context: AudioContext | null;
  node: AudioWorkletNode | null;
  detach: AbortController;
}

function release(held: Capture): void {
  held.detach.abort();
  // Every part is cleared as it is let go, so a second release (a stop that lands in an await, then
  // the setup's own catch) finds nothing left to stop or close: no second `close()` to reject.
  const { node, stream, context } = held;
  held.node = null;
  held.stream = null;
  held.context = null;
  node?.disconnect();
  for (const track of stream?.getTracks() ?? []) track.stop();
  void context?.close();
}

export function createVoiceAudio(): VoiceAudio {
  let capture: Capture | null = null;
  let closed = false;
  let speaker: Speaker | null = null;
  // The capture context made inside the Start tap, waiting for `startCapture` to take it. It is
  // created there because the microphone prompt and the worklet load are awaits, and a context made
  // after them is not in a gesture any more: mobile browsers leave it suspended and it posts nothing.
  let primedCapture: AudioContext | null = null;
  let nextStart = 0;
  const active = new Set<AudioBufferSourceNode>();
  let idleCallback: (() => void) | null = null;
  // One decoder for the whole session: a chunk may end mid-sample, and the byte is carried over.
  let decode = createPcm16Decoder();

  const stopCapture = (): void => {
    if (capture === null) return;
    release(capture);
    capture = null;
  };

  const dropPrimedCapture = (): void => {
    const unused = primedCapture;
    primedCapture = null;
    void unused?.close();
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
    // A byte the decoder was holding for the next chunk belongs to audio that was just thrown away;
    // left in, it would shift every sample of the next response by one byte and play as noise.
    decode = createPcm16Decoder();
  };

  return {
    async startCapture(onChunk) {
      if (closed) throw new Error("voice audio is closed");
      // A second start must not orphan the first: release it so its stream and context close.
      stopCapture();
      const held: Capture = { stream: null, context: null, node: null, detach: new AbortController() };
      capture = held;
      // True once teardown has run (or a newer capture replaced this one) while an await was pending.
      const superseded = (): boolean => capture !== held;
      try {
        held.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (superseded()) throw new Error("capture stopped before the microphone opened");
        held.context = primedCapture ?? new AudioContext();
        primedCapture = null;
        const { context } = held;
        // A refusal to run is a capture that cannot work: it ends the start like a denied microphone.
        await context.resume();
        if (superseded()) throw new Error("capture stopped before the context resumed");
        await context.audioWorklet.addModule(mounted(WORKLET));
        if (superseded()) throw new Error("capture stopped before the worklet loaded");
        const node = new AudioWorkletNode(context, "collie-capture");
        held.node = node;
        // One resampler per capture: it carries its phase across the worklet's blocks.
        const toCaptureRate = createResampler(context.sampleRate, CAPTURE_RATE);
        node.port.addEventListener(
          "message",
          (event: MessageEvent<Float32Array>) => {
            const mono = toCaptureRate(event.data);
            onChunk(pcm16ToBase64(floatToPcm16(mono)), Math.min(1, rms(mono) * 4));
          },
          { signal: held.detach.signal },
        );
        // Required with addEventListener: a MessagePort queues until it is started, and only the
        // `onmessage` setter starts it implicitly.
        node.port.start();
        // The graph is only pulled from its destination, so a capture node with no path to one is
        // never run and posts nothing. A zero-gain sink gives it that path and plays silence.
        const sink = context.createGain();
        sink.gain.value = 0;
        node.connect(sink).connect(context.destination);
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
    prime() {
      // Called synchronously from the Start tap. Mobile browsers only let a context make sound if
      // it was created or resumed inside a user gesture, and the model's first audio arrives long
      // after the tap, so the speaker is made and unlocked here, not on first play.
      if (closed) return;
      setAudioSession("play-and-record");
      speaker ??= createSpeaker();
      void speaker.context.resume();
      if (primedCapture === null) {
        primedCapture = new AudioContext();
        void primedCapture.resume();
      }
    },
    play(base64) {
      speaker ??= createSpeaker();
      const { context, input } = speaker;
      if (context.state === "suspended") void context.resume();
      const floats = pcm16ToFloat(decode(base64));
      if (floats.length === 0) return;
      const buffer = context.createBuffer(1, floats.length, PLAYBACK_RATE);
      buffer.copyToChannel(floats, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(input);
      nextStart = Math.max(nextStart, context.currentTime);
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
      decode = createPcm16Decoder();
      stopCapture();
      dropPrimedCapture();
      flush();
      void speaker?.context.close();
      speaker = null;
      setAudioSession("auto");
    },
  };
}
