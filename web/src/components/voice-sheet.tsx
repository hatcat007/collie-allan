import { lazy, Suspense, useRef, useState } from "react";
import { Mic, MicOff, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useVoiceSession } from "@/hooks/use-voice-session";
import { t } from "@/lib/i18n";
import type { VoiceMode } from "@/lib/voice/protocol";
import type { PersonaState, ToolOutcome, VoiceTools } from "@/lib/voice/session";
import { cn } from "@/lib/utils";

// Persona is Rive + WebGL2 + a 2 MB WASM runtime. It is its own chunk and loads when this sheet
// first mounts, never with the app shell (ADR 0081).
const Persona = lazy(() =>
  import("@/components/ai-elements/persona").then((m) => ({ default: m.Persona })),
);

/**
 * What the sheet may do to the pane it was opened from. Handed in by the pane view, which owns the
 * composer: the sheet never touches a terminal itself, so a spoken send goes through the same
 * guarded path a typed one does.
 */
export interface VoiceHost {
  /** The pane's current screen text. */
  readPane(): string;
  getDraft(): string;
  setDraft(text: string): void;
  /** The composer's own verified send. True only when the text was seen in the input box. */
  send(text: string): Promise<boolean>;
  pressKey(key: string): Promise<boolean>;
  /** The composer cannot take a reply right now (gone pane, read-only device, dialog). */
  locked: boolean;
}

/** Keys the model may ask for. Closed here as well as in the bridge's declaration. */
const KEYS = new Set(["Enter", "Escape", "Up", "Down", "Tab"]);

type Confirm = { kind: "send"; text: string } | { kind: "key"; key: string };

interface VoiceSheetProps {
  open: boolean;
  onClose: () => void;
  /** Changes when the operator moves to another pane; the session ends with it. */
  paneKey: string;
  host: VoiceHost;
}

export function VoiceSheet({ open, onClose, paneKey, host }: VoiceSheetProps) {
  useLocale();
  const [mode, setMode] = useState<VoiceMode>("agent");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const answer = useRef<((outcome: ToolOutcome) => void) | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  // The draft as it stood when dictation began: dictated words are appended to it, replacing their
  // own earlier version as the transcript firms up, and never the operator's text before them.
  const base = useRef("");

  const ask = (what: Confirm): Promise<ToolOutcome> =>
    new Promise((resolve) => {
      answer.current = resolve;
      setConfirm(what);
    });
  const settle = (outcome: ToolOutcome) => {
    answer.current?.(outcome);
    answer.current = null;
    setConfirm(null);
  };

  const tools: VoiceTools = {
    readPane: () => hostRef.current.readPane(),
    draftReply: (text) => hostRef.current.setDraft(text),
    setDictation: (text) => {
      const lead = base.current === "" || /\s$/.test(base.current) ? base.current : `${base.current} `;
      hostRef.current.setDraft(`${lead}${text}`);
    },
    sendReply: (text) => (hostRef.current.locked ? Promise.resolve(blocked()) : ask({ kind: "send", text })),
    pressKey: (key) =>
      KEYS.has(key) && !hostRef.current.locked
        ? ask({ kind: "key", key })
        : Promise.resolve({ status: "error", detail: "that key is not available" } satisfies ToolOutcome),
  };

  const voice = useVoiceSession(open, tools);
  const { snapshot } = voice;
  const live = snapshot.phase === "connecting" || snapshot.phase === "live";
  const stateWord =
    snapshot.phase === "connecting" ? t("voice.state.connecting") : stateLabel(snapshot.persona);

  // The paneKey is read only to end the session when it changes; React compares it for us.
  const lastPane = useRef(paneKey);
  if (lastPane.current !== paneKey) {
    lastPane.current = paneKey;
    settle({ status: "declined" });
    voice.stop();
  }

  const close = () => {
    settle({ status: "declined" });
    voice.stop();
    onClose();
  };

  const start = () => {
    base.current = hostRef.current.getDraft();
    voice.start(mode);
  };

  const confirmed = async () => {
    const pending = confirm;
    if (pending === null) return;
    const ok =
      pending.kind === "send"
        ? await hostRef.current.send(pending.text)
        : await hostRef.current.pressKey(pending.key);
    settle(ok ? { status: "sent" } : blocked());
  };

  return (
    <BottomSheet open={open} onClose={close} title={t("voice.title")}>
      <div className="flex flex-col items-center gap-3 px-4 pb-4">
        <div className="flex w-full gap-2" role="group" aria-label={t("voice.title")}>
          {(["agent", "dictate"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              variant={mode === m ? "default" : "outline"}
              size="sm"
              className="flex-1"
              disabled={live}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {t(m === "agent" ? "voice.mode.agent" : "voice.mode.dictate")}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-center text-xs">
          {t(mode === "agent" ? "voice.mode.hint.agent" : "voice.mode.hint.dictate")}
        </p>

        <div
          role="img"
          aria-label={t("voice.persona.aria", { state: stateWord })}
          className="size-40 shrink-0"
        >
          <Suspense fallback={null}>
            <Persona state={snapshot.persona} variant="obsidian" className="size-40" />
          </Suspense>
        </div>
        <div className="text-sm" aria-live="polite">
          {stateWord}
        </div>
        <div className="bg-muted h-1 w-32 overflow-hidden rounded-full" aria-hidden>
          <div
            className={cn("bg-foreground h-full origin-left", snapshot.muted && "opacity-30")}
            style={{ transform: `scaleX(${snapshot.level})` }}
          />
        </div>

        {snapshot.error !== null && (
          <Notice tone="danger" variant="box" className="w-full">
            {t(errorKey(snapshot.error))}
          </Notice>
        )}
        {host.locked && <Notice tone="caution" variant="box" className="w-full">{t("voice.locked")}</Notice>}

        {confirm !== null && (
          <div className="border-border flex w-full flex-col gap-2 rounded-sm border p-3" role="alertdialog">
            <div className="text-sm font-medium">
              {confirm.kind === "send" ? t("voice.confirm.send.title") : t("voice.confirm.key.title", { key: confirm.key })}
            </div>
            {confirm.kind === "send" && (
              <div className="font-content max-h-32 overflow-y-auto text-sm whitespace-pre-wrap">{confirm.text}</div>
            )}
            <div className="flex gap-2">
              <Button type="button" className="flex-1" onClick={() => void confirmed()}>
                {confirm.kind === "send" ? t("voice.confirm.send") : t("voice.confirm.press")}
              </Button>
              <Button type="button" variant="outline" className="flex-1" onClick={() => settle({ status: "declined" })}>
                {t("voice.confirm.cancel")}
              </Button>
            </div>
          </div>
        )}

        <div className="flex w-full gap-2">
          {live ? (
            <>
              <Button type="button" variant="outline" className="flex-1" onClick={voice.stop}>
                <Square className="size-4" />
                {t("voice.stop")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={snapshot.phase !== "live"}
                aria-pressed={snapshot.muted}
                onClick={() => voice.setMuted(!snapshot.muted)}
              >
                {snapshot.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                {snapshot.muted ? t("voice.unmute") : t("voice.mute")}
              </Button>
            </>
          ) : (
            <Button type="button" className="flex-1" onClick={start}>
              <Mic className="size-4" />
              {t("voice.start")}
            </Button>
          )}
        </div>

        {snapshot.lines.length > 0 && (
          <ul className="flex max-h-48 w-full flex-col gap-1 overflow-y-auto text-sm" aria-live="polite">
            {snapshot.lines.map((line) => (
              <li key={line.id}>
                <span className="text-muted-foreground mr-1 text-xs">
                  {t(line.role === "you" ? "voice.transcript.you" : "voice.transcript.agent")}
                </span>
                <span className="font-content">{line.text}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-center text-xs">{t("voice.privacy")}</p>
      </div>
    </BottomSheet>
  );
}

function blocked(): ToolOutcome {
  return { status: "blocked", detail: "the pane did not accept it" };
}

function stateLabel(state: PersonaState): string {
  switch (state) {
    case "listening":
      return t("voice.state.listening");
    case "thinking":
      return t("voice.state.thinking");
    case "speaking":
      return t("voice.state.speaking");
    case "idle":
      return t("voice.state.idle");
    case "asleep":
      return t("voice.state.asleep");
  }
}

function errorKey(code: string) {
  switch (code) {
    case "voice.upstream_unavailable":
      return "voice.error.upstream_unavailable";
    case "voice.upstream_closed":
      return "voice.error.upstream_closed";
    case "voice.too_long":
      return "voice.error.too_long";
    case "voice.mic_denied":
      return "voice.error.mic_denied";
    case "voice.ticket_failed":
      return "voice.error.ticket_failed";
    default:
      return "voice.error.bad_message";
  }
}
