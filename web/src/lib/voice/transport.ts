import { voiceTicket } from "@/lib/api";
import { mounted } from "@/lib/base-path";
import { parseServerMessage } from "./protocol";
import type { TransportHandlers, VoiceTransport } from "./session";

// The phone's end of `GET /api/voice`: spend a freshly minted ticket on one WebSocket to the bridge.
// The page never names Google; the bridge holds the key and relays (ADR 0081). The URL is derived
// from the page's own origin, so `connect-src 'self'` covers it.

/** `ws(s)://<this origin><mount>/api/voice?ticket=…` */
export function voiceSocketUrl(ticket: string, base: string = location.href): string {
  const url = new URL(mounted("/api/voice"), base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export async function connectVoiceTransport(handlers: TransportHandlers): Promise<VoiceTransport> {
  const ticket = await voiceTicket();
  const socket = new WebSocket(voiceSocketUrl(ticket));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("voice socket refused")), { once: true });
    socket.addEventListener("close", () => reject(new Error("voice socket closed")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = parseServerMessage(String(event.data));
    if (message !== null) handlers.message(message);
  });
  socket.addEventListener("close", () => handlers.closed());
  socket.addEventListener("error", () => handlers.closed());
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(1000, "done"),
  };
}
