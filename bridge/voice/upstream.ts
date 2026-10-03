import type { UpstreamFactory, UpstreamHandlers, UpstreamSocket } from "./session.ts";

// The one place a real WebSocket meets the relay. Gemini sends its JSON in BINARY frames, so a
// frame is decoded through `Response` (which reads a string, a Blob or an ArrayBuffer alike) and the
// decodes are chained so two frames in flight can never be delivered out of order.

export const openGeminiSocket: UpstreamFactory = (url) => {
  const ws = new WebSocket(url);
  let handlers: UpstreamHandlers | null = null;
  let chain: Promise<void> = Promise.resolve();
  const socket: UpstreamSocket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    attach: (h) => {
      handlers = h;
    },
    detach: () => {
      handlers = null;
    },
  };
  ws.addEventListener("open", () => handlers?.open());
  ws.addEventListener("message", (ev) => {
    // A frame that cannot be decoded or handled is reported through the relay's own error path, and
    // the queue carries on: a rejected link here would silently drop every later frame.
    chain = chain
      .then(async () => {
        const text = await new Response(ev.data).text();
        handlers?.message(text);
        return undefined;
      })
      .catch(() => {
        handlers?.error();
      });
  });
  ws.addEventListener("close", () => handlers?.close());
  ws.addEventListener("error", () => handlers?.error());
  return socket;
};
