import { describe, expect, test } from "vitest";

import type { VoiceClientMessage, VoiceServerMessage } from "./protocol";
import {
  type ToolOutcome,
  type TransportHandlers,
  type VoiceAudio,
  type VoiceSnapshot,
  type VoiceTools,
  VoiceSession,
} from "./session";

function rig(over: { micDenied?: boolean; connectFails?: boolean; send?: () => Promise<ToolOutcome> } = {}) {
  const sent: VoiceClientMessage[] = [];
  const played: string[] = [];
  const log = { flushed: 0, captureStopped: 0, captureStarted: 0, closed: 0, transportClosed: 0 };
  let denyOnce = false;
  const drafts: string[] = [];
  const dictations: string[] = [];
  const keys: string[] = [];
  const sends: string[] = [];
  let handlers: TransportHandlers | null = null;
  let chunk: ((data: string, level: number) => void) | null = null;
  let idle: (() => void) | null = null;
  const audio: VoiceAudio = {
    startCapture: async (cb) => {
      if (over.micDenied || denyOnce) {
        denyOnce = false;
        throw new Error("denied");
      }
      log.captureStarted += 1;
      chunk = cb;
    },
    stopCapture: () => void (log.captureStopped += 1),
    play: (d) => void played.push(d),
    flush: () => void (log.flushed += 1),
    onIdle: (cb) => void (idle = cb),
    close: () => void (log.closed += 1),
  };
  const tools: VoiceTools = {
    readPane: () => "x".repeat(20_000),
    draftReply: (t) => void drafts.push(t),
    setDictation: (t) => void dictations.push(t),
    sendReply: over.send ?? (async (t) => (sends.push(t), { status: "sent" })),
    pressKey: async (k) => (keys.push(k), { status: "sent" }),
  };
  const snaps: VoiceSnapshot[] = [];
  const session = new VoiceSession({
    connect: async (h) => {
      if (over.connectFails) throw new Error("no ticket");
      handlers = h;
      return { send: (m) => void sent.push(m), close: () => void (log.transportClosed += 1) };
    },
    audio,
    tools,
    onChange: (s) => void snaps.push(s),
  });
  const server = (m: VoiceServerMessage) => handlers?.message(m);
  return {
    session, sent, played, log, drafts, dictations, keys, sends, snaps, server,
    mic: (data: string, level = 0.1) => chunk?.(data, level),
    drain: () => idle?.(),
    drop: () => handlers?.closed(),
    denyNext: () => void (denyOnce = true),
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

async function live(mode: "agent" | "dictate" = "agent", over: Parameters<typeof rig>[0] = {}) {
  const r = rig(over);
  await r.session.start(mode);
  r.server({ t: "ready" });
  await r.tick();
  return r;
}

describe("VoiceSession lifecycle", () => {
  test("start sends the mode, ready goes live and opens the microphone", async () => {
    const r = await live("dictate");
    expect(r.sent[0]).toEqual({ t: "start", mode: "dictate" });
    expect(r.session.snapshot()).toMatchObject({ phase: "live", persona: "listening" });
    r.mic("AAA=");
    expect(r.sent.at(-1)).toEqual({ t: "audio", data: "AAA=" });
  });

  test("a failed ticket ends the session with its code", async () => {
    const r = rig({ connectFails: true });
    await r.session.start("agent");
    expect(r.session.snapshot()).toMatchObject({ phase: "ended", error: "voice.ticket_failed", persona: "asleep" });
  });

  test("a refused microphone ends the session and closes everything", async () => {
    const r = await live("agent", { micDenied: true });
    expect(r.session.snapshot()).toMatchObject({ phase: "ended", error: "voice.mic_denied" });
    expect(r.log).toMatchObject({ closed: 1, transportClosed: 1 });
  });

  test("a bridge error ends it with the bridge's code, and stop is idempotent", async () => {
    const r = await live();
    r.server({ t: "error", code: "voice.too_long" });
    expect(r.session.snapshot().error).toBe("voice.too_long");
    r.session.stop();
    expect(r.log.closed).toBe(1);
  });

  test("the socket dropping ends the session", async () => {
    const r = await live();
    r.drop();
    expect(r.session.snapshot().phase).toBe("ended");
  });

  test("a frame after stop does nothing", async () => {
    const r = await live();
    r.session.stop();
    r.server({ t: "audio", data: "QQ==" });
    expect(r.played).toEqual([]);
  });
});

describe("VoiceSession persona and audio", () => {
  test("model audio speaks, drains to listening, and barge-in flushes", async () => {
    const r = await live();
    r.server({ t: "audio", data: "QQ==" });
    expect(r.session.snapshot().persona).toBe("speaking");
    expect(r.played).toEqual(["QQ=="]);
    r.drain();
    expect(r.session.snapshot().persona).toBe("listening");
    r.server({ t: "audio", data: "QQ==" });
    r.server({ t: "interrupted" });
    expect(r.log.flushed).toBe(1);
    expect(r.session.snapshot().persona).toBe("listening");
  });

  test("what you said is thinking until the model answers", async () => {
    const r = await live();
    r.server({ t: "in_text", text: "hej" });
    expect(r.session.snapshot().persona).toBe("thinking");
    r.server({ t: "turn_complete" });
    expect(r.session.snapshot().persona).toBe("listening");
  });

  test("transcript fragments of one speaker merge, and speakers alternate", async () => {
    const r = await live();
    r.server({ t: "in_text", text: "hej " });
    r.server({ t: "in_text", text: "med dig" });
    r.server({ t: "out_text", text: "Hej!" });
    expect(r.session.snapshot().lines.map((l) => [l.role, l.text])).toEqual([
      ["you", "hej med dig"],
      ["agent", "Hej!"],
    ]);
  });

  test("mute closes the microphone itself, and unmute opens it again", async () => {
    const r = await live();
    const stopsBefore = r.log.captureStopped;
    const opensBefore = r.log.captureStarted;
    r.session.setMuted(true);
    expect(r.log.captureStopped).toBe(stopsBefore + 1);
    r.session.setMuted(false);
    await r.tick();
    expect(r.log.captureStarted).toBe(opensBefore + 1);
    expect(r.session.snapshot().muted).toBe(false);
  });

  test("a microphone that fails to reopen after unmute ends the session as refused", async () => {
    const r = await live();
    r.session.setMuted(true);
    r.denyNext();
    r.session.setMuted(false);
    await r.tick();
    expect(r.session.snapshot()).toMatchObject({ phase: "ended", error: "voice.mic_denied" });
  });

  test("mute stops the microphone, tells the model, and shows idle", async () => {
    const r = await live();
    r.session.setMuted(true);
    expect(r.sent.at(-1)).toEqual({ t: "end" });
    const before = r.sent.length;
    r.mic("AAA=");
    expect(r.sent.length).toBe(before);
    expect(r.session.snapshot().persona).toBe("idle");
    r.session.setMuted(false);
    r.mic("AAA=");
    expect(r.sent.at(-1)).toEqual({ t: "audio", data: "AAA=" });
  });

  test("dictation never plays the model and streams the transcript into the draft", async () => {
    const r = await live("dictate");
    r.server({ t: "audio", data: "QQ==" });
    expect(r.played).toEqual([]);
    r.server({ t: "in_text", text: " skriv " });
    r.server({ t: "in_text", text: "en test" });
    expect(r.dictations).toEqual(["skriv ", "skriv en test"]);
    expect(r.session.snapshot().lines).toEqual([]);
  });
});

describe("VoiceSession tools", () => {
  test("read_pane returns the tail of the screen", async () => {
    const r = await live();
    r.server({ t: "tool_call", id: "1", name: "read_pane", args: {} });
    await r.tick();
    const res = r.sent.at(-1);
    expect(res).toMatchObject({ t: "tool_result", id: "1" });
    expect(res?.t === "tool_result" && String(res.response.screen).length).toBe(12_000);
  });

  test("draft_reply drafts and send_reply waits for the tool's own confirmation", async () => {
    let release: (o: ToolOutcome) => void = () => {};
    const r = await live("agent", { send: () => new Promise((res) => void (release = res)) });
    r.server({ t: "tool_call", id: "a", name: "draft_reply", args: { text: "hej" } });
    await r.tick();
    expect(r.drafts).toEqual(["hej"]);
    r.server({ t: "tool_call", id: "b", name: "send_reply", args: { text: "go" } });
    await r.tick();
    expect(r.session.snapshot()).toMatchObject({ tool: "send_reply", persona: "thinking" });
    release({ status: "declined" });
    await r.tick();
    expect(r.sent.at(-1)).toEqual({ t: "tool_result", id: "b", response: { result: "declined" } });
    expect(r.session.snapshot().tool).toBeNull();
  });

  test("press_key passes the key, and a missing argument is an error result", async () => {
    const r = await live();
    r.server({ t: "tool_call", id: "k", name: "press_key", args: { key: "Enter" } });
    r.server({ t: "tool_call", id: "m", name: "press_key", args: {} });
    r.server({ t: "tool_call", id: "n", name: "send_reply", args: { text: "  " } });
    await r.tick();
    expect(r.keys).toEqual(["Enter"]);
    const byId = new Map(r.sent.flatMap((m) => (m.t === "tool_result" ? [[m.id, m.response] as const] : [])));
    expect(byId.get("k")).toEqual({ result: "sent" });
    expect(byId.get("m")).toEqual({ error: "key is required" });
    expect(byId.get("n")).toEqual({ error: "text is required" });
  });

  test("an undeclared tool and any tool in dictation are refused without running", async () => {
    const a = await live();
    a.server({ t: "tool_call", id: "x", name: "rm_rf", args: {} });
    await a.tick();
    expect(a.sent.at(-1)).toEqual({ t: "tool_result", id: "x", response: { error: "unavailable" } });
    const d = await live("dictate");
    d.server({ t: "tool_call", id: "y", name: "send_reply", args: { text: "x" } });
    await d.tick();
    expect(d.sends).toEqual([]);
    expect(d.sent.at(-1)).toEqual({ t: "tool_result", id: "y", response: { error: "unavailable" } });
  });

  test("a throwing tool answers with an error instead of hanging the model", async () => {
    const r = await live("agent", { send: async () => { throw new Error("boom"); } });
    r.server({ t: "tool_call", id: "z", name: "send_reply", args: { text: "x" } });
    await r.tick();
    expect(r.sent.at(-1)).toEqual({ t: "tool_result", id: "z", response: { error: "failed" } });
  });
});
