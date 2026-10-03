import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createVoiceAudio } from "./audio";

// jsdom has no Web Audio, so these stubs stand in for the four browser objects capture touches and
// record what was opened and what was shut. What is pinned is the TEARDOWN: the microphone and the
// context must be released whichever await a stop lands in, and whether or not a worklet loads.

interface Tracks {
  stopped: number;
}

// The code under test calls only `getTracks()` and each track's `stop()`, so that is all this has.
interface FakeNode {
  connect?(to: FakeNode): FakeNode;
}

interface FakeStream {
  getTracks(): { stop(): void }[];
}

function fakeStream(t: Tracks): FakeStream {
  return { getTracks: () => [{ stop: () => void (t.stopped += 1) }] };
}

let tracks: Tracks;
let contextsClosed: number;
let contextsOpened: number;
let contextsResumed: number;
let releaseMic: (() => void) | null;
let rejectMic: ((e: Error) => void) | null;
let failWorklet: boolean;
let workletGate: Promise<void> | null;
let openWorklet: (() => void) | null;
const graph = { nodeConnected: 0 };

beforeEach(() => {
  tracks = { stopped: 0 };
  contextsClosed = 0;
  contextsOpened = 0;
  contextsResumed = 0;
  releaseMic = null;
  rejectMic = null;
  failWorklet = false;
  workletGate = null;
  openWorklet = null;
  graph.nodeConnected = 0;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<FakeStream>((resolve, reject) => {
          releaseMic = () => resolve(fakeStream(tracks));
          rejectMic = reject;
        }),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 48_000;
      audioWorklet = {
        addModule: async () => {
          await workletGate;
          if (failWorklet) throw new Error("worklet 404");
        },
      };
      constructor() {
        contextsOpened += 1;
      }
      destination = {};
      state = "running";
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createGain() {
        return { gain: { value: 1 }, connect: (to: FakeNode) => to };
      }
      resume() {
        contextsResumed += 1;
        return Promise.resolve();
      }
      close() {
        contextsClosed += 1;
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { addEventListener: () => {}, start: () => {} };
      connected = 0;
      connect(to: FakeNode) {
        graph.nodeConnected += 1;
        return to;
      }
      disconnect() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createVoiceAudio capture teardown", () => {
  test("a stop while the permission prompt is pending shuts the microphone when it lands", async () => {
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    audio.stopCapture();
    releaseMic?.();
    await expect(started).rejects.toThrow();
    expect(tracks.stopped).toBe(1);
    expect(contextsOpened).toBe(0);
  });

  test("close while the permission prompt is pending does the same, and a later start is refused", async () => {
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    audio.close();
    releaseMic?.();
    await expect(started).rejects.toThrow();
    expect(tracks.stopped).toBe(1);
    await expect(audio.startCapture(() => {})).rejects.toThrow("closed");
  });

  test("a worklet that fails to load releases the microphone and the context", async () => {
    failWorklet = true;
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    releaseMic?.();
    await expect(started).rejects.toThrow("worklet 404");
    expect(tracks.stopped).toBe(1);
    expect(contextsClosed).toBe(1);
  });

  test("a refused permission leaves nothing open", async () => {
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    rejectMic?.(new Error("denied"));
    await expect(started).rejects.toThrow("denied");
    expect(tracks.stopped).toBe(0);
    expect(contextsOpened).toBe(0);
  });

  test("a normal stop after capture is live releases everything once", async () => {
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    releaseMic?.();
    await started;
    await tick();
    audio.stopCapture();
    audio.stopCapture();
    expect(tracks.stopped).toBe(1);
    expect(contextsClosed).toBe(1);
  });

  test("the capture node is connected onward, or the graph would never run it", async () => {
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    releaseMic?.();
    await started;
    expect(graph.nodeConnected).toBe(1);
  });

  test("a stop that lands while the worklet loads closes the context exactly once", async () => {
    workletGate = new Promise<void>((resolve) => void (openWorklet = resolve));
    const audio = createVoiceAudio();
    const started = audio.startCapture(() => {});
    releaseMic?.();
    await tick();
    audio.stopCapture();
    openWorklet?.();
    await expect(started).rejects.toThrow();
    expect(contextsClosed).toBe(1);
    expect(tracks.stopped).toBe(1);
  });

  test("an interruption drops the decoder's held byte, so the next response is not shifted", () => {
    const sources: number[][] = [];
    vi.stubGlobal("AudioContext", class {
      currentTime = 0;
      state = "running";
      destination = {};
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createBuffer(_c: number, length: number) {
        return { duration: 0, copyToChannel: (data: Float32Array) => void sources.push([...data]), length };
      }
      createBufferSource() {
        return { buffer: null, connect: () => {}, start: () => {}, stop: () => {}, addEventListener: () => {} };
      }
    });
    const audio = createVoiceAudio();
    const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
    audio.play(b64([1, 0, 2])); // ends mid-sample: one byte held
    audio.flush();
    audio.play(b64([3, 0])); // a new response: must decode as 3, not as (2 | 3<<8)
    expect(sources.at(-1)).toEqual([3 / 0x8000]);
  });

  test("prime unlocks the speaker inside the gesture and is a no-op after close", () => {
    const audio = createVoiceAudio();
    audio.prime();
    expect(contextsOpened).toBe(1);
    expect(contextsResumed).toBe(1);
    audio.close();
    audio.prime();
    expect(contextsOpened).toBe(1);
  });
});
