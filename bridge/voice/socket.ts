import type { ServerWebSocket, WebSocketHandler } from "bun";

import type { JsonValue } from "../json.ts";
import type { VoiceSettings } from "./config.ts";
import { VoiceRelay } from "./session.ts";
import { openGeminiSocket } from "./upstream.ts";

// The phone-facing half of `GET /api/voice`: Bun's websocket handler, one relay per socket. The
// upgrade itself (gates, ticket, admission) is decided in server.ts before this ever runs.

export interface VoiceSocketData {
  settings: VoiceSettings;
  device: string;
  /** Returns this session's admission slot. */
  release: () => void;
  /** Called once when the session ends, with its length, for the audit line. */
  onEnd: (ms: number) => void;
  relay?: VoiceRelay;
  startedAt?: number;
}

/** A frame is a few seconds of base64 PCM; anything larger is not this protocol. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

export function createVoiceWebsocket(): WebSocketHandler<VoiceSocketData> {
  return {
    maxPayloadLength: MAX_PAYLOAD_BYTES,
    idleTimeout: 120,
    open(ws: ServerWebSocket<VoiceSocketData>) {
      ws.data.startedAt = Date.now();
      ws.data.relay = new VoiceRelay({
        settings: ws.data.settings,
        open: openGeminiSocket,
        send: (message) => void ws.send(JSON.stringify(message)),
        onEnd: () => ws.close(1000, "done"),
      });
    },
    message(ws, raw) {
      let parsed: JsonValue;
      try {
        // SAFETY: `JSON.parse` answers with a JSON value; `VoiceRelay.onClientMessage` is its only
        // reader and checks every field it names. A binary frame is decoded through `String` first.
        parsed = JSON.parse(String(raw)) as JsonValue;
      } catch {
        ws.close(1003, "bad frame");
        return;
      }
      ws.data.relay?.onClientMessage(parsed);
    },
    close(ws) {
      ws.data.relay?.onClientClosed();
      ws.data.release();
      ws.data.onEnd(Date.now() - (ws.data.startedAt ?? Date.now()));
    },
  };
}
