import { useCallback, useEffect, useRef, useState } from "react";

import { createVoiceAudio } from "@/lib/voice/audio";
import type { VoiceMode } from "@/lib/voice/protocol";
import { type VoiceSnapshot, type VoiceTools, VoiceSession } from "@/lib/voice/session";
import { connectVoiceTransport } from "@/lib/voice/transport";

// The React shell around one `VoiceSession` (lib/voice/session.ts, where all the behaviour is).
//
// The microphone is armed state, and it obeys the rules every other armed thing in this app does
// (CLAUDE.md, "Type into terminal"): it dies when the owner goes away. `stop()` runs on unmount, when
// `active` goes false (the sheet closed, or the pane changed) and when the page is hidden. It is
// never persisted and never restored, so a phone that was locked mid-sentence comes back to a closed
// session and not to an open microphone.

const IDLE: VoiceSnapshot = {
  phase: "idle",
  mode: "agent",
  persona: "asleep",
  muted: false,
  level: 0,
  lines: [],
  tool: null,
  error: null,
};

export interface VoiceControls {
  snapshot: VoiceSnapshot;
  start(mode: VoiceMode): void;
  stop(): void;
  setMuted(muted: boolean): void;
}

/**
 * @param active  false stops any live session and clears the transcript.
 * @param tools   read through a ref on every call, so a re-render never strands a stale closure
 *                inside a session that is already talking.
 */
export function useVoiceSession(active: boolean, tools: VoiceTools): VoiceControls {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(IDLE);
  const sessionRef = useRef<VoiceSession | null>(null);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  const start = useCallback(
    (mode: VoiceMode) => {
      stop();
      const session = new VoiceSession({
        connect: connectVoiceTransport,
        audio: createVoiceAudio(),
        tools: {
          readPane: () => toolsRef.current.readPane(),
          draftReply: (text) => toolsRef.current.draftReply(text),
          setDictation: (text) => toolsRef.current.setDictation(text),
          sendReply: (text, callId) => toolsRef.current.sendReply(text, callId),
          pressKey: (key, callId) => toolsRef.current.pressKey(key, callId),
          cancelPending: (callIds) => toolsRef.current.cancelPending(callIds),
        },
        onChange: setSnapshot,
      });
      sessionRef.current = session;
      setSnapshot({ ...IDLE, mode });
      void session.start(mode);
    },
    [stop],
  );

  const setMuted = useCallback((muted: boolean) => sessionRef.current?.setMuted(muted), []);

  useEffect(() => {
    if (active) return;
    stop();
    setSnapshot(IDLE);
  }, [active, stop]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, [stop]);

  return { snapshot, start, stop, setMuted };
}
