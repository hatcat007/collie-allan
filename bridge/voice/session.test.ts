import { describe, expect, test } from "bun:test";

import type { VoiceSettings } from "./config.ts";
import type { JsonValue } from "../json.ts";
import { type UpstreamHandlers, type UpstreamSocket, VoiceRelay, type VoiceClientMessage } from "./session.ts";

const settings: VoiceSettings = { provider: "gemini-live", apiKey: "k", model: "gemini-3.8-live" };

class FakeSocket implements UpstreamSocket {
  sent: string[] = [];
  closed = false;
  handlers: UpstreamHandlers | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  attach(h: UpstreamHandlers) {
    this.handlers = h;
  }
  detach() {
    this.handlers = null;
  }
  open() {
    this.handlers?.open();
  }
  push(frame: JsonValue) {
    this.handlers?.message(JSON.stringify(frame));
  }
  drop() {
    this.handlers?.close();
  }
  fail() {
    this.handlers?.error();
  }
  frames(): JsonValue[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function rig(resumeTimeoutMs?: number) {
  const sockets: FakeSocket[] = [];
  const out: VoiceClientMessage[] = [];
  let ended = 0;
  const relay = new VoiceRelay({
    settings,
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    send: (m) => void out.push(m),
    onEnd: () => void (ended += 1),
    resumeTimeoutMs,
  });
  return { relay, sockets, out, ended: () => ended };
}

function ready(resumeTimeoutMs?: number) {
  const r = rig(resumeTimeoutMs);
  r.relay.start();
  r.sockets[0]?.open();
  r.sockets[0]?.push({ setupComplete: {} });
  return r;
}

describe("VoiceRelay", () => {
  test("start sends setup on open and announces ready after setupComplete", () => {
    const r = rig();
    r.relay.start();
    r.relay.start();
    expect(r.sockets).toHaveLength(1);
    r.sockets[0]?.open();
    expect(r.sockets[0]?.frames()[0]).toHaveProperty("setup.model", "models/gemini-3.8-live");
    expect(r.out).toEqual([]);
    r.sockets[0]?.push({ setupComplete: {} });
    expect(r.out).toEqual([{ t: "ready" }]);
  });

  test("a start message names the mode, and an unknown mode is refused", () => {
    const r = rig();
    r.relay.onClientMessage({ t: "start", mode: "dictate" });
    r.sockets[0]?.open();
    expect(JSON.stringify(r.sockets[0]?.frames()[0])).toContain("Never speak");
    const bad = rig();
    bad.relay.onClientMessage({ t: "start", mode: "shout" });
    expect(bad.out[0]).toEqual({ t: "error", code: "voice.bad_message" });
    expect(bad.sockets).toHaveLength(0);
  });

  test("audio flows both ways; end flushes the stream", () => {
    const r = ready();
    r.relay.onClientMessage({ t: "audio", data: "AAA=" });
    r.relay.onClientMessage({ t: "end" });
    const frames = r.sockets[0]?.frames() ?? [];
    expect(frames[1]).toEqual({ realtimeInput: { audio: { data: "AAA=", mimeType: "audio/pcm;rate=16000" } } });
    expect(frames[2]).toEqual({ realtimeInput: { audioStreamEnd: true } });
    r.sockets[0]?.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "QQ==" } }] } } });
    expect(r.out.at(-1)).toEqual({ t: "audio", data: "QQ==" });
  });

  test("audio before ready is dropped, not queued", () => {
    const r = rig();
    r.relay.start();
    r.sockets[0]?.open();
    r.relay.onClientMessage({ t: "audio", data: "AAA=" });
    expect(r.sockets[0]?.sent).toHaveLength(1);
  });

  test("a tool call round-trips through the phone", () => {
    const r = ready();
    r.sockets[0]?.push({ toolCall: { functionCalls: [{ id: "1", name: "draft_reply", args: { text: "hej" } }] } });
    expect(r.out.at(-1)).toEqual({ t: "tool_call", id: "1", name: "draft_reply", args: { text: "hej" } });
    r.relay.onClientMessage({ t: "tool_result", id: "1", response: { result: "ok" } });
    expect(r.sockets[0]?.frames().at(-1)).toEqual({
      toolResponse: { functionResponses: [{ id: "1", name: "draft_reply", response: { result: "ok" } }] },
    });
  });

  test("a result for an unknown id is dropped and an undeclared tool never reaches the phone", () => {
    const r = ready();
    const before = r.sockets[0]?.sent.length;
    r.relay.onClientMessage({ t: "tool_result", id: "zzz", response: { result: "ok" } });
    expect(r.sockets[0]?.sent.length).toBe(before);
    r.sockets[0]?.push({ toolCall: { functionCalls: [{ id: "2", name: "rm_rf", args: {} }] } });
    expect(r.out.some((m) => m.t === "tool_call")).toBe(false);
    expect(r.sockets[0]?.frames().at(-1)).toMatchObject({
      toolResponse: { functionResponses: [{ id: "2", response: { error: "unknown tool" } }] },
    });
  });

  test("an oversized audio chunk ends the session with a code", () => {
    const r = ready();
    r.relay.onClientMessage({ t: "audio", data: "x".repeat(200_000) });
    expect(r.out.at(-2)).toEqual({ t: "error", code: "voice.bad_message" });
    expect(r.out.at(-1)).toEqual({ t: "closed" });
    expect(r.sockets[0]?.closed).toBe(true);
    expect(r.ended()).toBe(1);
  });

  test("upstream closing unexpectedly is reported once", () => {
    const r = ready();
    r.sockets[0]?.drop();
    expect(r.out.at(-2)).toEqual({ t: "error", code: "voice.upstream_closed" });
    r.sockets[0]?.drop();
    expect(r.ended()).toBe(1);
  });

  test("the phone leaving closes upstream without an error", () => {
    const r = ready();
    r.relay.onClientClosed();
    expect(r.sockets[0]?.closed).toBe(true);
    expect(r.out).toEqual([{ t: "ready" }]);
    expect(r.ended()).toBe(1);
  });

  test("the retiring socket erroring mid-handshake does not take the replacement down either", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    r.sockets[0]?.fail();
    expect(r.ended()).toBe(0);
    r.sockets[1]?.open();
    r.sockets[1]?.push({ setupComplete: {} });
    r.relay.onClientMessage({ t: "audio", data: "AAA=" });
    expect(r.sockets[1]?.frames().at(-1)).toHaveProperty("realtimeInput.audio.data", "AAA=");
  });

  test("a replacement that never comes up is abandoned after its deadline, and the session ends once nothing is left", async () => {
    const r = ready(5);
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    r.sockets[0]?.drop();
    expect(r.ended()).toBe(0);
    // Each stalled replacement times out and is retried; the budget runs out and the dead socket
    // can no longer be hidden behind a live-looking session.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.sockets.length).toBe(4);
    expect(r.sockets.slice(1).every((s) => s.closed)).toBe(true);
    expect(r.out.at(-2)).toEqual({ t: "error", code: "voice.upstream_closed" });
    expect(r.ended()).toBe(1);
  });

  test("a repeated GoAway after the budget is spent does not open another replacement", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    r.sockets[1]?.drop();
    r.sockets[2]?.drop();
    r.sockets[3]?.drop();
    expect(r.sockets).toHaveLength(4);
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 10 } } });
    expect(r.sockets).toHaveLength(4);
  });

  test("a malformed message after ready ends the session with bad_message", () => {
    const r = ready();
    r.relay.onClientMessage({ t: "wat" });
    expect(r.out.at(-2)).toEqual({ t: "error", code: "voice.bad_message" });
    expect(r.out.at(-1)).toEqual({ t: "closed" });
  });

  test("the retiring socket closing mid-handshake does not take the replacement down", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    r.sockets[0]?.drop();
    expect(r.ended()).toBe(0);
    r.sockets[1]?.open();
    r.sockets[1]?.push({ setupComplete: {} });
    r.relay.onClientMessage({ t: "audio", data: "AAA=" });
    expect(r.sockets[1]?.frames().at(-1)).toHaveProperty("realtimeInput.audio.data", "AAA=");
    expect(r.ended()).toBe(0);
  });

  test("if the replacement then fails for good, the session ends with the closed code", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    r.sockets[0]?.drop();
    r.sockets[1]?.drop();
    r.sockets[2]?.drop();
    r.sockets[3]?.drop();
    expect(r.out.at(-2)).toEqual({ t: "error", code: "voice.upstream_closed" });
    expect(r.ended()).toBe(1);
  });

  test("a GoAway that arrives before the first handle resumes when the handle arrives", () => {
    const r = ready();
    r.sockets[0]?.push({ goAway: { timeLeft: "20s" } });
    expect(r.sockets).toHaveLength(1);
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    expect(r.sockets).toHaveLength(2);
    r.sockets[1]?.open();
    expect(r.sockets[1]?.frames()[0]).toHaveProperty("setup.sessionResumption.handle", "h1");
  });

  test("a present but non-string mode is refused, an absent one defaults to agent", () => {
    const bad = rig();
    bad.relay.onClientMessage({ t: "start", mode: null });
    expect(bad.out[0]).toEqual({ t: "error", code: "voice.bad_message" });
    expect(bad.sockets).toHaveLength(0);
    const ok = rig();
    ok.relay.onClientMessage({ t: "start" });
    ok.sockets[0]?.open();
    expect(JSON.stringify(ok.sockets[0]?.frames()[0])).toContain("read_pane");
  });

  test("a replacement that fails is retried while the handle is good, then left to the old socket", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    expect(r.sockets).toHaveLength(2);
    r.sockets[1]?.drop();
    expect(r.sockets).toHaveLength(3);
    r.sockets[2]?.drop();
    expect(r.sockets).toHaveLength(4);
    r.sockets[3]?.drop();
    // Attempts spent: no fourth replacement, the session still runs on the retiring socket.
    expect(r.sockets).toHaveLength(4);
    expect(r.ended()).toBe(0);
    r.sockets[0]?.drop();
    expect(r.out.at(-2)).toEqual({ t: "error", code: "voice.upstream_closed" });
  });

  test("a failed replacement is detached and closed, so its queued frames never pass as the live session's", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    const failed = r.sockets[1];
    r.sockets[1]?.fail();
    expect(failed?.closed).toBe(true);
    expect(failed?.handlers).toBeNull();
    const before = r.out.length;
    failed?.push({ serverContent: { turnComplete: true } });
    expect(r.out).toHaveLength(before);
  });

  test("a retry that comes up swaps in and resets the budget", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    r.sockets[1]?.drop();
    r.sockets[2]?.open();
    r.sockets[2]?.push({ setupComplete: {} });
    expect(r.sockets[0]?.closed).toBe(true);
    r.relay.onClientMessage({ t: "audio", data: "AAA=" });
    expect(r.sockets[2]?.frames().at(-1)).toHaveProperty("realtimeInput.audio.data", "AAA=");
  });

  test("goAway reconnects with the handle and swaps on setupComplete", () => {
    const r = ready();
    r.sockets[0]?.push({ sessionResumptionUpdate: { newHandle: "h9", resumable: true } });
    r.sockets[0]?.push({ goAway: { timeLeft: { seconds: 20 } } });
    expect(r.sockets).toHaveLength(2);
    r.sockets[1]?.open();
    expect(r.sockets[1]?.frames()[0]).toHaveProperty("setup.sessionResumption.handle", "h9");
    r.sockets[1]?.push({ setupComplete: {} });
    expect(r.sockets[0]?.closed).toBe(true);
    r.relay.onClientMessage({ t: "audio", data: "AAA=" });
    expect(r.sockets[1]?.frames().at(-1)).toHaveProperty("realtimeInput.audio.data", "AAA=");
    expect(r.ended()).toBe(0);
  });
});
