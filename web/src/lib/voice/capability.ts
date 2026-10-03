import { useEffect, useSyncExternalStore } from "react";

import { getVoiceCapability, loadOperatorCommands, subscribeOperatorConfig } from "@/lib/operator-config";
import type { VoiceCapability } from "@/lib/types";

// Whether a voice row exists on this phone. Two independent gates, like speech-to-text's:
//
//  1. The bridge published a key (`/api/config` carries `voice` only after `collie voice setup`;
//     absent is the feature being off, and also what an older bridge sends). Absent draws NO row.
//  2. This browser can capture and play audio: a secure context, `getUserMedia` and AudioWorklet.
//     Over plain HTTP `navigator.mediaDevices` is simply absent, so a control that provably cannot
//     work is withheld rather than drawn disabled. There is nothing the phone can do to fix it.

export function voiceSupported(): boolean {
  if (!globalThis.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return "AudioWorkletNode" in globalThis && "AudioContext" in globalThis;
}

/** The bridge's voice block, or `null` when this phone must offer no voice row. */
export function useVoiceCapability(): VoiceCapability | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  const capability = useSyncExternalStore(subscribeOperatorConfig, getVoiceCapability, getVoiceCapability);
  return capability !== null && voiceSupported() ? capability : null;
}
