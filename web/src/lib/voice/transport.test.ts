import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { connectVoiceTransport, HANDSHAKE_TIMEOUT_MS, voiceSocketUrl } from "./transport";

interface ApiStub {
  ticket: () => Promise<string>;
  fields: { code: string } | undefined;
}

const api: ApiStub = vi.hoisted(() => ({ ticket: async () => "t1", fields: undefined }));

vi.mock("@/lib/api", () => ({
  voiceTicket: () => api.ticket(),
  apiErrorFields: () => api.fields,
}));

describe("voiceSocketUrl", () => {
  test("follows the page's scheme and carries the ticket", () => {
    expect(voiceSocketUrl("t1", "https://phone.ts.net/pane/1")).toBe("wss://phone.ts.net/api/voice?ticket=t1");
    expect(voiceSocketUrl("t1", "http://127.0.0.1:8787/")).toBe("ws://127.0.0.1:8787/api/voice?ticket=t1");
  });
});

type Listener = () => void;

class FakeSocket {
  static last: FakeSocket | null = null;
  closed = 0;
  private readonly listeners = new Map<string, Listener[]>();
  constructor() {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed += 1;
  }
  send() {}
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.last = null;
  api.ticket = async () => "t1";
  api.fields = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const handlers = { message: () => {}, closed: () => {} };

describe("connectVoiceTransport", () => {
  test("a handshake that never completes is abandoned after the deadline and the socket closed", async () => {
    const outcome = expect(connectVoiceTransport(handlers)).rejects.toMatchObject({
      name: "VoiceConnectError",
      code: "voice.ticket_failed",
    });
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await outcome;
    expect(FakeSocket.last?.closed).toBe(1);
  });

  test("an open socket resolves, and no timer is left running", async () => {
    const pending = connectVoiceTransport(handlers);
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.fire("open");
    expect(await pending).toHaveProperty("send");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a refused handshake closes the socket and reports a start failure", async () => {
    const outcome = expect(connectVoiceTransport(handlers)).rejects.toMatchObject({ code: "voice.ticket_failed" });
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.fire("error");
    await outcome;
    expect(FakeSocket.last?.closed).toBe(1);
  });

  test("a ticket the bridge refuses with a named reason keeps that reason", async () => {
    api.ticket = async () => {
      throw new Error("refused");
    };
    for (const code of ["voice.unconfigured", "voice.busy"]) {
      api.fields = { code };
      await expect(connectVoiceTransport(handlers)).rejects.toMatchObject({ code });
    }
    api.fields = { code: "something.else" };
    await expect(connectVoiceTransport(handlers)).rejects.toMatchObject({ code: "voice.ticket_failed" });
    expect(FakeSocket.last).toBeNull();
  });
});
