import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { VoiceClientMessage, VoiceServerMessage } from "@/lib/voice/protocol";
import type { TransportHandlers, VoiceAudio } from "@/lib/voice/session";
import { VoiceSheet, type VoiceHost } from "./voice-sheet";

// Persona is Rive + WebGL2, which jsdom has neither of. The state it is handed is asserted through
// the stand-in, which is all the sheet owns.
vi.mock("@/components/ai-elements/persona", () => ({
  Persona: ({ state }: { state: string }) => <div role="img" aria-label={`persona ${state}`} />,
}));

interface Wire {
  handlers: TransportHandlers | null;
  sent: VoiceClientMessage[];
  closed: number;
}

const wire: Wire = vi.hoisted(() => ({ handlers: null, sent: [], closed: 0 }));

vi.mock("@/lib/voice/transport", () => ({
  connectVoiceTransport: async (handlers: TransportHandlers) => {
    wire.handlers = handlers;
    return { send: (m: VoiceClientMessage) => void wire.sent.push(m), close: () => void (wire.closed += 1) };
  },
}));

vi.mock("@/lib/voice/audio", () => ({
  createVoiceAudio: (): VoiceAudio => ({
    prime: () => {},
    startCapture: async () => {},
    stopCapture: () => {},
    play: () => {},
    flush: () => {},
    onIdle: () => {},
    close: () => {},
  }),
}));

function host(over: Partial<VoiceHost> = {}): VoiceHost {
  return {
    readPane: () => "screen text",
    getDraft: () => "",
    isLocked: () => false,
    setDraft: vi.fn(),
    send: vi.fn(async () => true),
    pressKey: vi.fn(async () => true),
    locked: false,
    ...over,
  };
}

const server = (m: VoiceServerMessage) => act(() => wire.handlers?.message(m));

async function startLive(h: VoiceHost, mode: "Agent" | "Dictate" = "Agent") {
  const view = render(<VoiceSheet open onClose={vi.fn()} paneKey="p1" host={h} />);
  fireEvent.click(screen.getByRole("button", { name: mode }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(wire.sent[0]).toEqual({ t: "start", mode: mode.toLowerCase() }));
  await server({ t: "ready" });
  return view;
}

beforeEach(() => {
  wire.handlers = null;
  wire.sent = [];
  wire.closed = 0;
});

describe("VoiceSheet", () => {
  it("starts a session in the chosen mode and shows Persona listening once live", async () => {
    await startLive(host());
    await waitFor(() => expect(screen.getByRole("img", { name: "persona listening" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled();
  });

  it("a spoken send waits for a tap, goes through the host's own send, and tells the model", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "1", name: "send_reply", args: { text: "run the tests" } });
    expect(await screen.findByText("run the tests")).toBeInTheDocument();
    expect(h.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.send).toHaveBeenCalledWith("run the tests"));
    await waitFor(() =>
      expect(wire.sent.at(-1)).toEqual({ t: "tool_result", id: "1", response: { result: "sent" } }),
    );
  });

  it("cancelling a confirmation sends nothing and says declined", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "2", name: "send_reply", args: { text: "x" } });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(wire.sent.at(-1)).toEqual({ t: "tool_result", id: "2", response: { result: "declined" } }),
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a send the pane refuses is reported as blocked, not sent", async () => {
    const h = host({ send: vi.fn(async () => false) });
    await startLive(h);
    await server({ t: "tool_call", id: "3", name: "send_reply", args: { text: "x" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await waitFor(() => expect(wire.sent.at(-1)).toMatchObject({ response: { result: "blocked" } }));
  });

  it("a key outside the closed list is refused without asking", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "4", name: "press_key", args: { key: "ctrl+c" } });
    await waitFor(() => expect(wire.sent.at(-1)).toMatchObject({ id: "4", response: { result: "error" } }));
    expect(h.pressKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a locked pane blocks a send up front", async () => {
    await startLive(host({ locked: true }));
    await server({ t: "tool_call", id: "5", name: "send_reply", args: { text: "x" } });
    await waitFor(() => expect(wire.sent.at(-1)).toMatchObject({ id: "5", response: { result: "blocked" } }));
  });

  it("a composer that locked after the sheet drew blocks a send and a key at the moment they run", async () => {
    const h = host({ isLocked: () => true });
    await startLive(h);
    await server({ t: "tool_call", id: "11", name: "send_reply", args: { text: "x" } });
    await waitFor(() => expect(wire.sent.at(-1)).toMatchObject({ id: "11", response: { result: "blocked" } }));
    await server({ t: "tool_call", id: "12", name: "press_key", args: { key: "Enter" } });
    await waitFor(() => expect(wire.sent.at(-1)).toMatchObject({ id: "12", response: { result: "error" } }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("dictation appends to the draft the operator already had and never plays or sends", async () => {
    const h = host({ getDraft: () => "fix" });
    await startLive(h, "Dictate");
    await server({ t: "in_text", text: "the login" });
    expect(h.setDraft).toHaveBeenLastCalledWith("fix the login");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("closing the sheet ends the session and declines a pending confirmation", async () => {
    const onClose = vi.fn();
    const h = host();
    render(<VoiceSheet open onClose={onClose} paneKey="p1" host={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(wire.sent[0]).toBeDefined());
    await server({ t: "ready" });
    await server({ t: "tool_call", id: "6", name: "send_reply", args: { text: "x" } });
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(wire.closed).toBe(1));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a second request while one confirmation is open declines the first instead of stranding it", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "7", name: "send_reply", args: { text: "first" } });
    await screen.findByText("first");
    await server({ t: "tool_call", id: "8", name: "send_reply", args: { text: "second" } });
    await screen.findByText("second");
    await waitFor(() =>
      expect(wire.sent.find((m) => m.t === "tool_result" && m.id === "7")).toMatchObject({
        response: { result: "declined" },
      }),
    );
    expect(h.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.send).toHaveBeenCalledWith("second"));
  });

  it("Stop declines a showing confirmation and removes it, so it cannot be tapped afterwards", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "9", name: "send_reply", args: { text: "x" } });
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // The session is over, so there is no one to answer; the declined result is dropped with it.
    await waitFor(() => expect(wire.closed).toBe(1));
    expect(h.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("a request that arrives while a confirmed action is in flight is refused, never settled in its place", async () => {
    let finish: (ok: boolean) => void = () => {};
    const h = host({ send: vi.fn(() => new Promise<boolean>((resolve) => void (finish = resolve))) });
    await startLive(h);
    await server({ t: "tool_call", id: "20", name: "send_reply", args: { text: "first" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await server({ t: "tool_call", id: "21", name: "send_reply", args: { text: "second" } });
    await waitFor(() =>
      expect(wire.sent.find((m) => m.t === "tool_result" && m.id === "21")).toMatchObject({
        response: { result: "blocked" },
      }),
    );
    finish(true);
    await waitFor(() =>
      expect(wire.sent.find((m) => m.t === "tool_result" && m.id === "20")).toMatchObject({
        response: { result: "sent" },
      }),
    );
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("first");
  });

  it("a double tap on a key confirmation presses once", async () => {
    let finish: (ok: boolean) => void = () => {};
    const h = host({ pressKey: vi.fn(() => new Promise<boolean>((resolve) => void (finish = resolve))) });
    await startLive(h);
    await server({ t: "tool_call", id: "10", name: "press_key", args: { key: "Enter" } });
    const press = await screen.findByRole("button", { name: "Press" });
    fireEvent.click(press);
    fireEvent.click(press);
    expect(h.pressKey).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Press" })).toBeDisabled();
    finish(true);
    await waitFor(() =>
      expect(wire.sent.at(-1)).toEqual({ t: "tool_result", id: "10", response: { result: "sent" } }),
    );
  });

  it("a session that ends on its own takes its confirmation with it", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "30", name: "send_reply", args: { text: "x" } });
    await screen.findByRole("alertdialog", { name: "Send this to the agent?" });
    await server({ t: "error", code: "voice.upstream_closed" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a call the model cancels takes its confirmation with it", async () => {
    await startLive(host());
    await server({ t: "tool_call", id: "31", name: "send_reply", args: { text: "x" } });
    await screen.findByRole("alertdialog");
    await server({ t: "tool_cancelled", ids: ["31"] });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancelling a different call leaves the open confirmation alone", async () => {
    const h = host();
    await startLive(h);
    await server({ t: "tool_call", id: "40", name: "send_reply", args: { text: "x" } });
    await server({ t: "tool_call", id: "41", name: "read_pane", args: {} });
    await screen.findByRole("alertdialog");
    await server({ t: "tool_cancelled", ids: ["41"] });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("moving to another pane ends the session", async () => {
    const h = host();
    const { rerender } = render(<VoiceSheet open onClose={vi.fn()} paneKey="p1" host={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(wire.sent[0]).toBeDefined());
    await server({ t: "ready" });
    rerender(<VoiceSheet open onClose={vi.fn()} paneKey="p2" host={h} />);
    await waitFor(() => expect(wire.closed).toBe(1));
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("a bridge error is shown in words and the session is over", async () => {
    await startLive(host());
    await server({ t: "error", code: "voice.upstream_unavailable" });
    expect(await screen.findByText("The bridge could not reach Gemini.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
});
