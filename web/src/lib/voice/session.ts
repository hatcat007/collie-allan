import type { JsonObject } from "@/lib/json";
import type { PersonaState } from "@/components/ai-elements/persona";
import { asJsonString } from "@/lib/json";
import {
  isVoiceToolName,
  type VoiceClientMessage,
  type VoiceErrorCode,
  type VoiceMode,
  type VoiceServerMessage,
} from "./protocol";

// ── ONE VOICE SESSION, WITHOUT REACT ─────────────────────────────────────────────────────────
//
// The phase machine, the transcript, the Persona state and the tool dispatch live here as a plain
// class so `vitest` can drive a whole conversation with a fake transport, a fake speaker and fake
// tools. The hook (`hooks/use-voice-session.ts`) is a thin shell that owns one of these and turns its
// snapshots into React state.
//
// Three rules the bridge cannot enforce for us, so this file does:
//  - The model's audio is played only in `agent` mode. In `dictate` it is dropped on arrival.
//  - A tool runs only if its name is one this phone declared, and `send_reply` / `press_key` are
//    the tools' own business to confirm: this class never types into a terminal, it asks `tools`.
//  - A session never outlives its caller. `stop()` closes the socket, the microphone and the
//    speaker, and no late frame can reopen any of them.

// One definition: the avatar's own. Type-only, so importing it pulls no Rive code into the app shell.
export type { PersonaState };
export type VoicePhase = "idle" | "connecting" | "live" | "ended";

/** The failures that happen on this phone, or at the ticket, before a session exists. */
export type VoiceLocalError =
  | "voice.mic_denied"
  | "voice.ticket_failed"
  | "voice.unconfigured"
  | "voice.busy";

/**
 * Thrown by a transport when no session could be opened, carrying WHICH failure it was so the sheet
 * can say it: a bridge with no key and a bridge with too many tickets out are not "could not start".
 */
export class VoiceConnectError extends Error {
  readonly code: VoiceLocalError;
  constructor(code: VoiceLocalError) {
    super(code);
    this.name = "VoiceConnectError";
    this.code = code;
  }
}

export interface VoiceLine {
  id: number;
  role: "you" | "agent";
  text: string;
}

export interface VoiceSnapshot {
  phase: VoicePhase;
  mode: VoiceMode;
  persona: PersonaState;
  muted: boolean;
  /** Microphone level, 0..1, for the listening meter. */
  level: number;
  lines: VoiceLine[];
  /** The tool the model is waiting on, by name, or null. */
  tool: string | null;
  error: VoiceErrorCode | VoiceLocalError | null;
}

export interface VoiceTransport {
  send(message: VoiceClientMessage): void;
  close(): void;
}

export interface TransportHandlers {
  message(message: VoiceServerMessage): void;
  /** The socket closed or failed. After this no message arrives. */
  closed(): void;
}

export interface VoiceAudio {
  /**
   * Unlock playback. Called synchronously on the Start tap, before any await: mobile browsers only
   * let an audio context make sound if it was created or resumed inside a user gesture.
   */
  prime(): void;
  /** Start the microphone. Rejects when it is refused. */
  startCapture(onChunk: (base64: string, level: number) => void): Promise<void>;
  stopCapture(): void;
  /** Queue one chunk of the model's audio. */
  play(base64: string): void;
  /** Drop everything queued, at once (barge-in). */
  flush(): void;
  /** Called when the speaker has played everything it was given. */
  onIdle(callback: () => void): void;
  close(): void;
}

export type ToolOutcome = { status: "sent" | "declined" | "blocked" | "error"; detail?: string };

export interface VoiceTools {
  /** The pane's current screen text. */
  readPane(): string;
  draftReply(text: string): void;
  /** Dictation: the whole dictated text so far, replacing the previous call's. */
  setDictation(text: string): void;
  /** Ask the operator, then send through the reply guard. */
  sendReply(text: string): Promise<ToolOutcome>;
  /** Ask the operator, then press one key. */
  pressKey(key: string): Promise<ToolOutcome>;
  /** The model withdrew a call: drop any confirmation it is waiting on. */
  cancelPending(): void;
}

export interface VoiceSessionDeps {
  connect(handlers: TransportHandlers): Promise<VoiceTransport>;
  audio: VoiceAudio;
  tools: VoiceTools;
  onChange(snapshot: VoiceSnapshot): void;
}

/** The tail of the screen is what matters, and the bridge caps a tool result at 64 KB. */
export const MAX_SCREEN_CHARS = 12_000;

export class VoiceSession {
  private snap: VoiceSnapshot = {
    phase: "idle",
    mode: "agent",
    persona: "asleep",
    muted: false,
    level: 0,
    lines: [],
    tool: null,
    error: null,
  };
  private transport: VoiceTransport | null = null;
  private speaking = false;
  private awaiting = false;
  private nextLine = 1;
  private dictation = "";
  private stopped = false;
  /** Which microphone start is current; an older one that fails after a mute or a restart is stale. */
  private micGeneration = 0;
  /** Tool calls in flight, by id. A call the model cancelled is removed here and never answered. */
  private readonly activeTools = new Map<string, string>();

  private readonly deps: VoiceSessionDeps;

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
    deps.audio.onIdle(() => {
      this.speaking = false;
      this.publish();
    });
  }

  snapshot(): VoiceSnapshot {
    return this.snap;
  }

  async start(mode: VoiceMode): Promise<void> {
    if (this.snap.phase !== "idle") return;
    // First thing, before any await: this runs inside the Start tap's user activation.
    this.deps.audio.prime();
    this.snap = { ...this.snap, phase: "connecting", mode, persona: "thinking" };
    this.deps.onChange(this.snap);
    try {
      const transport = await this.deps.connect({
        message: (m) => this.onMessage(m),
        closed: () => this.onClosed(),
      });
      if (this.stopped) {
        transport.close();
        return;
      }
      this.transport = transport;
      transport.send({ t: "start", mode });
    } catch (err) {
      this.fail(err instanceof VoiceConnectError ? err.code : "voice.ticket_failed");
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.deps.audio.stopCapture();
    this.deps.audio.close();
    this.transport?.close();
    this.transport = null;
    this.speaking = false;
    this.awaiting = false;
    this.activeTools.clear();
    this.snap = { ...this.snap, phase: "ended", level: 0, tool: null };
    this.publish();
  }

  /**
   * Mute CLOSES the microphone (stream, worklet and context), not just the forwarding, so the OS
   * indicator goes out and "Muted" is true. It flushes the model's voice detection first. Unmuting
   * opens it again; the permission is already granted, so there is no second prompt.
   */
  setMuted(muted: boolean): void {
    if (this.snap.phase !== "live" || muted === this.snap.muted) return;
    this.snap = { ...this.snap, muted, level: 0 };
    if (muted) {
      // Any start still pending is cancelled by this stop; its rejection is the mute, not a refusal.
      this.micGeneration += 1;
      this.transport?.send({ t: "end" });
      this.deps.audio.stopCapture();
      this.publish();
      return;
    }
    this.publish();
    void this.openMicrophone();
  }

  private onMessage(m: VoiceServerMessage): void {
    if (this.stopped) return;
    switch (m.t) {
      case "ready":
        void this.goLive();
        return;
      case "audio":
        if (this.snap.mode === "agent") {
          this.awaiting = false;
          this.speaking = true;
          this.deps.audio.play(m.data);
          this.publish();
        }
        return;
      case "interrupted":
        this.deps.audio.flush();
        this.speaking = false;
        this.publish();
        return;
      case "turn_complete":
        this.awaiting = false;
        this.publish();
        return;
      case "in_text":
        this.onYou(m.text);
        return;
      case "out_text":
        if (this.snap.mode === "agent") this.addText("agent", m.text);
        return;
      case "tool_call":
        void this.runTool(m.id, m.name, m.args);
        return;
      case "tool_cancelled":
        this.cancelTools(m.ids);
        return;
      case "error":
        this.fail(m.code);
        return;
      case "closed":
        this.onClosed();
        return;
    }
  }

  private async goLive(): Promise<void> {
    this.snap = { ...this.snap, phase: "live" };
    this.publish();
    await this.openMicrophone();
  }

  private async openMicrophone(): Promise<void> {
    const generation = ++this.micGeneration;
    try {
      await this.deps.audio.startCapture((data, level) => {
        if (this.stopped || this.snap.muted) return;
        this.transport?.send({ t: "audio", data });
        if (Math.abs(level - this.snap.level) > 0.02) {
          this.snap = { ...this.snap, level };
          this.publish();
        }
      });
    } catch {
      // A capture that failed because the session ended, or because a mute or a newer start
      // superseded it, is not a refusal.
      if (!this.stopped && generation === this.micGeneration) this.fail("voice.mic_denied");
    }
  }

  private onYou(text: string): void {
    if (this.snap.mode === "dictate") {
      this.dictation += text;
      this.deps.tools.setDictation(this.dictation.trimStart());
      return;
    }
    this.awaiting = true;
    this.addText("you", text);
  }

  private addText(role: "you" | "agent", text: string): void {
    const last = this.snap.lines.at(-1);
    const lines =
      last !== undefined && last.role === role
        ? [...this.snap.lines.slice(0, -1), { ...last, text: last.text + text }]
        : [...this.snap.lines, { id: this.nextLine++, role, text }];
    this.snap = { ...this.snap, lines };
    this.publish();
  }

  private async runTool(id: string, name: string, args: JsonObject): Promise<void> {
    if (!isVoiceToolName(name) || this.snap.mode !== "agent") {
      this.transport?.send({ t: "tool_result", id, response: { error: "unavailable" } });
      return;
    }
    this.activeTools.set(id, name);
    this.snap = { ...this.snap, tool: name };
    this.publish();
    let response: JsonObject;
    try {
      response = await this.dispatch(name, args);
    } catch {
      response = { error: "failed" };
    }
    if (this.stopped) return;
    // Only if this call is still the model's: one it cancelled was dropped from `activeTools`, and
    // answering it would hand the model a result for a request it no longer holds.
    if (!this.activeTools.delete(id)) return;
    this.snap = { ...this.snap, tool: this.lastActiveTool() };
    this.transport?.send({ t: "tool_result", id, response });
    this.publish();
  }

  private lastActiveTool(): string | null {
    return [...this.activeTools.values()].at(-1) ?? null;
  }

  /** The model withdrew these calls. Forget them, and drop any confirmation they were waiting on. */
  private cancelTools(ids: readonly string[]): void {
    let any = false;
    for (const id of ids) any = this.activeTools.delete(id) || any;
    if (!any) return;
    this.deps.tools.cancelPending();
    this.snap = { ...this.snap, tool: this.lastActiveTool() };
    this.publish();
  }

  private async dispatch(
    name: "read_pane" | "draft_reply" | "send_reply" | "press_key",
    args: JsonObject,
  ): Promise<JsonObject> {
    const { tools } = this.deps;
    if (name === "read_pane") {
      return { screen: tools.readPane().slice(-MAX_SCREEN_CHARS) };
    }
    if (name === "press_key") {
      const key = asJsonString(args.key);
      if (key === undefined) return { error: "key is required" };
      return outcome(await tools.pressKey(key));
    }
    const text = asJsonString(args.text);
    if (text === undefined || text.trim() === "") return { error: "text is required" };
    if (name === "draft_reply") {
      tools.draftReply(text);
      return { result: "drafted" };
    }
    return outcome(await tools.sendReply(text));
  }

  private onClosed(): void {
    if (this.stopped) return;
    this.stop();
  }

  private fail(code: VoiceErrorCode | VoiceLocalError): void {
    if (this.stopped) return;
    this.snap = { ...this.snap, error: code };
    this.stop();
  }

  private publish(): void {
    this.snap = { ...this.snap, persona: this.derivePersona() };
    this.deps.onChange(this.snap);
  }

  private derivePersona(): PersonaState {
    const { phase, muted, tool } = this.snap;
    if (phase === "connecting") return "thinking";
    if (phase !== "live") return "asleep";
    if (this.speaking) return "speaking";
    if (tool !== null || this.awaiting) return "thinking";
    return muted ? "idle" : "listening";
  }
}

function outcome(o: ToolOutcome): JsonObject {
  return o.detail === undefined ? { result: o.status } : { result: o.status, detail: o.detail };
}
