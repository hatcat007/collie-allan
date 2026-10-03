import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createVoiceAudio } from "./audio";

// jsdom has no Web Audio, so these stubs stand in for the four browser objects capture touches and
// record what was opened and what was shut. What is pinned is the TEARDOWN: the microphone and the
// context must be released whichever await a stop lands in, and whether or not a worklet loads.

interface Tracks {
  stopped: number;
}

// The code under test calls only `getTracks()` and each track's `stop()`, so that is all this has.
interface FakeStream {
  getTracks(): { stop(): void }[];
}

function fakeStream(t: Tracks): FakeStream {
  return { getTracks: () => [{ stop: () => void (t.stopped += 1) }] };
}

let tracks: Tracks;
let contextsClosed: number;
let contextsOpened: number;
let releaseMic: (() => void) | null;
let rejectMic: ((e: Error) => void) | null;
let failWorklet: boolean;

beforeEach(() => {
  tracks = { stopped: 0 };
  contextsClosed = 0;
  contextsOpened = 0;
  releaseMic = null;
  rejectMic = null;
  failWorklet = false;
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
          if (failWorklet) throw new Error("worklet 404");
        },
      };
      constructor() {
        contextsOpened += 1;
      }
      createMediaStreamSource() {
        return { connect: () => {} };
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
});
