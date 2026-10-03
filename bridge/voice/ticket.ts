// ── A ONE-USE TICKET FOR THE VOICE SOCKET ────────────────────────────────────────────────────
//
// A browser WebSocket cannot set an `Authorization` header, and the pairing gate (bridge/pairing.ts)
// reads exactly that header. So the socket is never gated on its own: the phone first asks
// `POST /api/voice/ticket`, which IS write-gated (same-origin + both device gates, bearer included),
// and gets a random ticket good for one upgrade within a few seconds. The upgrade spends it. A
// ticket is therefore proof that the device passed the write gate moments ago, it cannot be
// replayed, and it never lives anywhere but this process's memory.
//
// The ticket also carries the bearer token it was minted under (null when nothing is paired), so the
// upgrade can ask the pairing registry AGAIN: a device revoked inside the ticket's 30 seconds is
// refused at the door rather than let in on a proof that has since been withdrawn.

export const TICKET_TTL_MS = 30_000;
export const MAX_OUTSTANDING_TICKETS = 8;

export interface SpentTicket {
  device: string;
  /** The pairing bearer token the ticket was minted under, or null when pairing was off. */
  token: string | null;
}

export interface TicketStore {
  /** A fresh ticket for this device, or null when too many are outstanding. */
  mint(device: string, token: string | null): string | null;
  /** Spend a ticket. Who it was minted for, or null when unknown, spent or expired. */
  consume(ticket: string): SpentTicket | null;
}

export function createTicketStore(opts?: {
  now?: () => number;
  random?: () => string;
}): TicketStore {
  const now = opts?.now ?? Date.now;
  const random = opts?.random ?? (() => crypto.randomUUID() + crypto.randomUUID());
  const live = new Map<string, SpentTicket & { expires: number }>();
  const sweep = () => {
    const t = now();
    for (const [ticket, row] of live) if (row.expires <= t) live.delete(ticket);
  };
  return {
    mint(device, token) {
      sweep();
      if (live.size >= MAX_OUTSTANDING_TICKETS) return null;
      const ticket = random().replaceAll("-", "");
      live.set(ticket, { device, token, expires: now() + TICKET_TTL_MS });
      return ticket;
    },
    consume(ticket) {
      sweep();
      const row = live.get(ticket);
      if (row === undefined) return null;
      live.delete(ticket);
      return { device: row.device, token: row.token };
    },
  };
}
