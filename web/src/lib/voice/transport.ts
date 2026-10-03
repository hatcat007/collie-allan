import { apiErrorFields, voiceTicket } from "@/lib/api";
import { mounted } from "@/lib/base-path";
import { parseServerMessage } from "./protocol";
import { type TransportHandlers, VoiceConnectError, type VoiceTransport } from "./session";

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

/** A handshake that has not completed by now is a black-holed link, not a slow one. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Which ticket refusal this was, when the bridge said; any other failure is a plain start failure. */
function ticketFailure(code: string | undefined): VoiceConnectError {
  return new VoiceConnectError(code === "voice.unconfigured" || code === "voice.busy" ? code : "voice.ticket_failed");
}

export async function connectVoiceTransport(handlers: TransportHandlers): Promise<VoiceTransport> {
  let ticket: string;
  try {
    ticket = await voiceTicket();
  } catch (err) {
    throw ticketFailure(apiErrorFields(err)?.code);
  }
  const socket = new WebSocket(voiceSocketUrl(ticket));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("voice socket handshake timed out")), HANDSHAKE_TIMEOUT_MS);
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("voice socket refused")), { once: true });
      socket.addEventListener("close", () => reject(new Error("voice socket closed")), { once: true });
    });
  } catch {
    // Closed whichever way it failed, so a socket that opens late finds nobody to talk to.
    socket.close();
    throw new VoiceConnectError("voice.ticket_failed");
  } finally {
    clearTimeout(timer);
  }
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
