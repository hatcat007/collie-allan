import type { JsonObject } from "../json.ts";

// ── THE TOOLS GEMINI MAY CALL ────────────────────────────────────────────────────────────────
//
// The bridge only DECLARES these. It never runs one: every call is relayed to the phone, which
// executes it against the pane the operator is looking at, through the same guarded path a typed
// reply takes (`web/src/lib/reply-action.ts`). That keeps three things true: a spoken send is never
// a send around the reply guard, the confirmation is a tap on the operator's own screen, and the
// bridge needs no new write route for voice.
//
// All declarations are NON_BLOCKING, which `gemini-3.8-live-extended-thinking` requires and
// `gemini-3.8-live` defaults to. The model is told to speak while the phone works.

/**
 * `agent` is a conversation that may act through the tools below. `dictate` is the same socket with
 * no tools and an instruction to stay silent: the phone reads only the input transcription and puts
 * it in the draft, so the model's own audio is never played.
 */
export const VOICE_MODES = ["agent", "dictate"] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export function isVoiceMode(value: string): value is VoiceMode {
  return VOICE_MODES.some((known) => known === value);
}

export const VOICE_TOOL_NAMES = ["read_pane", "draft_reply", "send_reply", "press_key"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

/** Keys the model may press. A closed list: the phone refuses everything else. */
export const VOICE_KEYS = ["Enter", "Escape", "Up", "Down", "Tab"] as const;

export function isVoiceToolName(name: string): name is VoiceToolName {
  return VOICE_TOOL_NAMES.some((known) => known === name);
}

export const VOICE_FUNCTION_DECLARATIONS: JsonObject[] = [
  {
    name: "read_pane",
    description:
      "Read what is currently on the terminal screen of the agent the operator has open. " +
      "Call it before summarising, answering a question about the agent, or composing a reply.",
    behavior: "NON_BLOCKING",
  },
  {
    name: "draft_reply",
    description:
      "Put text into the operator's reply box WITHOUT sending it. Use it when the operator dictates " +
      "or asks you to prepare a message. It replaces the current draft.",
    behavior: "NON_BLOCKING",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "The exact text to place in the reply box." } },
      required: ["text"],
    },
  },
  {
    name: "send_reply",
    description:
      "Send a reply to the agent. The operator's phone asks them to confirm before anything is sent, " +
      "so call it only when they clearly asked you to send. The result says whether it was sent, " +
      "declined, or blocked.",
    behavior: "NON_BLOCKING",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "The exact text to send to the agent." } },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description:
      "Press one key in the terminal, for example to answer a menu or dismiss a dialog. " +
      "The operator's phone asks them to confirm first.",
    behavior: "NON_BLOCKING",
    parameters: {
      type: "OBJECT",
      properties: { key: { type: "STRING", enum: [...VOICE_KEYS] } },
      required: ["key"],
    },
  },
];

/**
 * The standing instruction. It states the one rule that matters beyond tone: a terminal agent is
 * a real shell, so the model confirms intent before a send and never invents text the operator did
 * not say. Language follows the operator.
 */
export function voiceSystemInstruction(language: string | undefined, mode: VoiceMode = "agent"): string {
  if (mode === "dictate") {
    return [
      "You are a silent dictation transcriber inside Collie, a phone app.",
      "Never speak, never answer, never call a tool, whatever the operator says.",
      "Their speech is transcribed for them; your only job is to stay quiet.",
    ].join(" ");
  }
  const lang =
    language === undefined
      ? "Answer in the language the operator speaks."
      : `Answer in the language with code "${language}" unless the operator switches.`;
  return [
    "You are the voice of Collie, a phone app that lets the operator monitor and reply to AI coding agents running in their terminal.",
    "Be brief: one or two spoken sentences unless asked for detail.",
    lang,
    "Use read_pane to see the agent's screen before describing it. Never guess what is on screen.",
    "Use draft_reply when the operator dictates a message. Use send_reply only after they clearly ask to send it.",
    "Never put words in the operator's mouth: send exactly what they said, tidied only for speech errors.",
    "If a tool result says declined or blocked, say so plainly and do not retry on your own.",
  ].join(" ");
}
