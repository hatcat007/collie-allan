import type { VoiceCapability } from "../types.ts";
import type { VoiceSettings } from "./config.ts";
import type { SpentTicket } from "./ticket.ts";

// The route's own rules, away from `Bun.serve` (CLAUDE.md: the runner cannot stand it up).

/** Sessions this process relays at once. One: a microphone is one operator, and each is billed. */
export const MAX_CONCURRENT_VOICE = 1;

/** The two questions the upgrade asks the pairing registry, structurally (see `PairingGate`). */
export interface TicketPairing {
  enforced(): boolean;
  resolve(token: string | null): { label: string } | null;
}

/**
 * Whether a spent ticket still earns a session. The write gate admitted the device when it MINTED
 * the ticket; this asks the registry again at the upgrade, so a device revoked inside the ticket's
 * 30 seconds is refused, even if that revocation emptied the registry.
 */
export function spentTicketAdmitted(spent: SpentTicket, pairing: TicketPairing | undefined): boolean {
  if (pairing === undefined) return true;
  // A ticket minted under a token is checked against the registry WHATEVER enforcement is now: when
  // the last paired device is revoked the registry empties and `enforced()` turns false, which must
  // not wave that device's outstanding ticket through. Only a ticket minted with pairing off (no
  // token) rides on pairing still being off.
  if (spent.token === null) return !pairing.enforced();
  return pairing.resolve(spent.token) !== null;
}

/** Whether the proxy identity on the upgrade is the one the ticket was minted under. */
export function spentTicketBound(spent: SpentTicket, asserted: string | null): boolean {
  return spent.binding === asserted;
}

/** What `/api/config` says about voice: a label and the model id, never the key. */
export function voiceCapability(settings: VoiceSettings | null): VoiceCapability | null {
  if (settings === null) return null;
  return { provider: settings.provider, model: settings.model };
}

/** A non-queued admission gate. `acquire` returns the release, or null when full. */
export interface VoiceAdmission {
  acquire(): (() => void) | null;
}

export function createVoiceAdmission(max: number = MAX_CONCURRENT_VOICE): VoiceAdmission {
  let active = 0;
  return {
    acquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}
