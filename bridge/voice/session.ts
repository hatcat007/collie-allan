import type { JsonObject, JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import type { VoiceSettings } from "./config.ts";
import {
  buildAudioFrame,
  buildAudioStreamEnd,
  buildSetup,
  buildToolResponse,
  geminiLiveUrl,
  type LiveEvent,
  parseServerFrame,
} from "./protocol.ts";
import { isVoiceMode, isVoiceToolName, type VoiceMode } from "./tools.ts";

// ── ONE VOICE SESSION: PHONE SOCKET ON ONE SIDE, GEMINI LIVE ON THE OTHER ───────────────────
//
// A relay and nothing more. Audio goes up as it arrived and comes back as it came; a tool call is
// handed to the phone and the phone's answer is handed back. The bridge never executes a tool,
// never writes to a pane, and never reads a screen on the model's behalf — those are the phone's
// acts, through the reply guard (see tools.ts). That is what lets `/api/voice` be one gated socket
// with no new write route behind it.
//
// Nothing here knows about `Bun.serve`: the upstream socket is injected, and the phone is a `send`
// callback, so `bun test` drives the whole lifecycle with fakes.

/** What an upstream socket reports. One handler each; the relay replaces them, never stacks them. */
export interface UpstreamHandlers {
  open(): void;
  /** One complete text frame, already decoded (`upstream.ts` owns text-vs-binary). */
  message(text: string): void;
  close(): void;
  error(): void;
}

/** The subset of a socket the relay uses. `upstream.ts` adapts a real `WebSocket` to it. */
export interface UpstreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Register the handlers. Called once, straight after the factory returns. */
  attach(handlers: UpstreamHandlers): void;
  /** Stop calling the handlers; a retired socket's late events mean nothing. */
  detach(): void;
}

export type UpstreamFactory = (url: string) => UpstreamSocket;

/** Largest base64 audio chunk accepted from the phone (~96 KB of PCM, a few seconds). */
export const MAX_AUDIO_CHUNK_CHARS = 128 * 1024;
/** Largest tool result accepted from the phone, serialised. A pane screen is far below this. */
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;
/** A session is cut here whatever else happens: an open microphone is not a standing service. */
export const MAX_SESSION_MS = 60 * 60 * 1000;

/** What the phone is sent. `error` carries a code the phone translates, never an upstream body. */
export type VoiceClientMessage =
  | { t: "ready" }
  | { t: "audio"; data: string }
  | { t: "interrupted" }
  | { t: "turn_complete" }
  | { t: "in_text"; text: string }
  | { t: "out_text"; text: string }
  | { t: "tool_call"; id: string; name: string; args: JsonObject }
  | { t: "tool_cancelled"; ids: string[] }
  | { t: "error"; code: VoiceErrorCode }
  | { t: "closed" };

export type VoiceErrorCode =
  | "voice.upstream_unavailable"
  | "voice.upstream_closed"
  | "voice.bad_message"
  | "voice.too_long";

export interface VoiceRelayOptions {
  settings: VoiceSettings;
  open: UpstreamFactory;
  /** Deliver one message to the phone. May throw if the phone is gone; the relay then closes. */
  send: (message: VoiceClientMessage) => void;
  /** Called exactly once when the session is over, for any reason. */
  onEnd: () => void;
}

export class VoiceRelay {
  private upstream: UpstreamSocket | null = null;
  private pending: UpstreamSocket | null = null;
  private handle: string | undefined;
  private started = false;
  private mode: VoiceMode = "agent";
  private ended = false;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Tool call ids the model is awaiting; a response for any other id is not sent upstream. */
  private readonly awaiting = new Map<string, string>();

  constructor(private readonly opts: VoiceRelayOptions) {}

  /** Open the upstream session. Idempotent: a second `start` is ignored. */
  start(mode: VoiceMode = "agent"): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.mode = mode;
    this.timer = setTimeout(() => this.fail("voice.too_long"), MAX_SESSION_MS);
    this.connect(false);
  }

  /** One decoded JSON message from the phone. */
  onClientMessage(raw: JsonValue): void {
    if (this.ended) return;
    const o = jsonRecord(raw);
    const t = jsonStringField(o?.t);
    if (o === null || t === null) return this.fail("voice.bad_message");
    if (t === "start") {
      const named = jsonStringField(o.mode) ?? "agent";
      if (!isVoiceMode(named)) return this.fail("voice.bad_message");
      return this.start(named);
    }
    if (!this.ready) return;
    if (t === "audio") {
      const data = jsonStringField(o.data);
      if (data === null || data.length > MAX_AUDIO_CHUNK_CHARS) return this.fail("voice.bad_message");
      this.upstream?.send(JSON.stringify(buildAudioFrame(data)));
    } else if (t === "end") {
      this.upstream?.send(JSON.stringify(buildAudioStreamEnd()));
    } else if (t === "tool_result") {
      this.onToolResult(o);
    } else {
      this.fail("voice.bad_message");
    }
  }

  /** The phone's socket closed. */
  onClientClosed(): void {
    this.end(false);
  }

  private onToolResult(o: JsonObject): void {
    const id = jsonStringField(o.id);
    const response = jsonRecord(o.response);
    if (id === null || response === null) return this.fail("voice.bad_message");
    const name = this.awaiting.get(id);
    // A result for a call nobody made is the phone talking past the model; drop it.
    if (name === undefined) return;
    if (JSON.stringify(response).length > MAX_TOOL_RESULT_CHARS) return this.fail("voice.bad_message");
    this.awaiting.delete(id);
    this.upstream?.send(JSON.stringify(buildToolResponse(id, name, response)));
  }

  private connect(resuming: boolean): void {
    const socket = this.opts.open(geminiLiveUrl(this.opts.settings.apiKey));
    if (resuming) this.pending = socket;
    else this.upstream = socket;
    socket.attach({
      open: () => {
        socket.send(JSON.stringify(buildSetup(this.opts.settings, this.mode, this.handle)));
      },
      message: (text) => {
        let frame: JsonValue;
        try {
          // SAFETY: `JSON.parse` answers with a JSON value and `parseServerFrame` is its only reader.
          frame = JSON.parse(text) as JsonValue;
        } catch {
          return;
        }
        for (const event of parseServerFrame(frame)) this.onEvent(socket, event);
      },
      error: () => {
        if (socket === this.pending) {
          this.pending = null;
          return;
        }
        if (!this.ended) this.fail("voice.upstream_unavailable");
      },
      close: () => {
        if (socket === this.pending) {
          this.pending = null;
          return;
        }
        if (socket === this.upstream && !this.ended) this.fail("voice.upstream_closed");
      },
    });
  }

  private onEvent(from: UpstreamSocket, event: LiveEvent): void {
    // A frame from the socket being retired is still real until the swap, but a frame from the
    // replacement before it is ready is not forwarded.
    if (event.kind === "setup_complete") {
      if (from === this.pending) {
        const old = this.upstream;
        this.upstream = this.pending;
        this.pending = null;
        if (old !== null) {
          old.detach();
          old.close(1000, "resumed");
        }
      }
      if (!this.ready) {
        this.ready = true;
        this.deliver({ t: "ready" });
      }
      return;
    }
    if (from === this.pending) return;
    switch (event.kind) {
      case "audio":
        return this.deliver({ t: "audio", data: event.base64 });
      case "interrupted":
        return this.deliver({ t: "interrupted" });
      case "turn_complete":
        return this.deliver({ t: "turn_complete" });
      case "input_text":
        return this.deliver({ t: "in_text", text: event.text });
      case "output_text":
        return this.deliver({ t: "out_text", text: event.text });
      case "resumption":
        this.handle = event.handle;
        return;
      case "go_away":
        // Reconnect ahead of the deadline, resuming by handle; the swap happens on setup_complete.
        if (this.handle !== undefined && this.pending === null) this.connect(true);
        return;
      case "tool_cancelled":
        for (const id of event.ids) this.awaiting.delete(id);
        return this.deliver({ t: "tool_cancelled", ids: event.ids });
      case "tool_call":
        // A name the bridge never declared is the model hallucinating; it is refused upstream with
        // an error result and the phone never hears of it.
        if (!isVoiceToolName(event.call.name)) {
          this.upstream?.send(
            JSON.stringify(buildToolResponse(event.call.id, event.call.name, { error: "unknown tool" })),
          );
          return;
        }
        this.awaiting.set(event.call.id, event.call.name);
        return this.deliver({ t: "tool_call", id: event.call.id, name: event.call.name, args: event.call.args });
    }
  }

  private deliver(message: VoiceClientMessage): void {
    if (this.ended) return;
    try {
      this.opts.send(message);
    } catch {
      this.end(false);
    }
  }

  private fail(code: VoiceErrorCode): void {
    if (this.ended) return;
    this.deliver({ t: "error", code });
    this.end(true);
  }

  private end(notify: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const socket of [this.upstream, this.pending]) {
      if (socket === null) continue;
      socket.detach();
      socket.close(1000, "done");
    }
    this.upstream = null;
    this.pending = null;
    this.awaiting.clear();
    if (notify) {
      try {
        this.opts.send({ t: "closed" });
      } catch {
        // the phone is already gone; nothing to tell it
      }
    }
    this.opts.onEnd();
  }
}
