import { describe, expect, test } from "bun:test";

import { VOICE_ENV_KEYS, VOICE_FILENAME } from "../bridge/voice/config.ts";
import type { UpstreamHandlers, UpstreamSocket } from "../bridge/voice/session.ts";
import { capture, context, type FakeFiles, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdVoice, cmdVoiceOff, cmdVoiceSetup, cmdVoiceStatus, cmdVoiceTest, type VoiceDeps } from "./voice.ts";

// The four `voice` verbs against fake seams. What is asserted is what only these verbs own: the file
// under the state dir, the words the operator reads, and that the key is never printed. The
// precedence and the refusals belong to `bridge/voice/config.ts` and are pinned in its own suite.

const CONFIG_PATH = `${STATE}/${VOICE_FILENAME}`;

type Deps = VoiceDeps & { io: ReturnType<typeof capture>; files: FakeFiles };

function deps(
  over: {
    seed?: Record<string, string>;
    env?: Record<string, string | undefined>;
    answers?: string[];
    open?: VoiceDeps["open"];
  } = {},
): Deps {
  const queued = [...(over.answers ?? [])];
  const built: Deps = {
    ctx: context(over.env ?? {}),
    io: capture(),
    files: fakeFiles(over.seed ?? {}),
    interactive: queued.length > 0,
    prompt: () => queued.shift() ?? null,
    timeoutMs: 50,
  };
  if (over.open !== undefined) built.open = over.open;
  return built;
}

const said = (d: Deps): string => [...d.io.stdout, ...d.io.stderr].join("\n");

describe("voice setup", () => {
  test("the key can come from the environment, so it never has to be an argument", async () => {
    const d = deps({ env: { [VOICE_ENV_KEYS.key]: "AIza-from-env" } });
    expect(await cmdVoiceSetup(d, [])).toBe(EXIT.OK);
    expect(JSON.parse(d.files.entries.get(CONFIG_PATH)?.text ?? "{}").apiKey).toBe("AIza-from-env");
    expect(said(d)).not.toContain("warning");
  });

  test("--key still works but warns about arguments and shell history", async () => {
    const d = deps();
    expect(await cmdVoiceSetup(d, ["--key", "k"])).toBe(EXIT.OK);
    expect(said(d)).toContain("warning: --key");
    expect(said(d)).not.toContain("--key k");
  });

  test("an unknown flag or a stray word is refused, and nothing is written", async () => {
    for (const args of [["--key", "k", "--modle", "gemini-3.8-live"], ["--key", "k", "extra"]]) {
      const d = deps();
      expect(await cmdVoiceSetup(d, args)).toBe(EXIT.USAGE);
      expect(said(d)).toContain("unknown argument");
      expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
    }
  });

  test("a stray word, which may be a key pasted in the wrong place, is never echoed back", async () => {
    const d = deps();
    expect(await cmdVoiceSetup(d, ["AIza-pasted-secret-9999"])).toBe(EXIT.USAGE);
    expect(said(d)).toContain("1 stray word");
    expect(said(d)).not.toContain("AIza-pasted-secret");
  });

  test("writes an owner-only file, never echoing the key, and leaves defaults out", async () => {
    const d = deps();
    expect(await cmdVoiceSetup(d, ["--key", "AIza-secret-1234"])).toBe(EXIT.OK);
    const entry = d.files.entries.get(CONFIG_PATH);
    expect(JSON.parse(entry?.text ?? "{}")).toEqual({ provider: "gemini-live", apiKey: "AIza-secret-1234" });
    expect(entry?.mode).toBe(0o600);
    expect(said(d)).not.toContain("AIza-secret-1234");
  });

  test("model, language and voice flow through, and a regional language is narrowed", async () => {
    const d = deps();
    const code = await cmdVoiceSetup(d, [
      "--key", "k", "--model", "gemini-3.8-live-extended-thinking", "--lang", "da-DK", "--voice", "Puck",
    ]);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(d.files.entries.get(CONFIG_PATH)?.text ?? "{}")).toEqual({
      provider: "gemini-live",
      apiKey: "k",
      model: "gemini-3.8-live-extended-thinking",
      language: "da",
      voiceName: "Puck",
    });
  });

  test("an unattended run with no key refuses and writes nothing", async () => {
    const d = deps();
    expect(await cmdVoiceSetup(d, [])).toBe(EXIT.FAIL);
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
  });

  test("an unknown model is refused by the bridge's own resolve, and nothing is written", async () => {
    const d = deps();
    expect(await cmdVoiceSetup(d, ["--key", "k", "--model", "gemini-9"])).toBe(EXIT.FAIL);
    expect(said(d)).toContain("gemini-9");
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
  });

  test("the prompt asks for the key when there is a terminal", async () => {
    const d = deps({ answers: ["typed-key", "", "", ""] });
    expect(await cmdVoiceSetup(d, [])).toBe(EXIT.OK);
    expect(JSON.parse(d.files.entries.get(CONFIG_PATH)?.text ?? "{}").apiKey).toBe("typed-key");
  });

  test("names an environment variable that will override the file", async () => {
    const d = deps({ env: { [VOICE_ENV_KEYS.model]: "gemini-3.8-live" } });
    await cmdVoiceSetup(d, ["--key", "k"]);
    expect(said(d)).toContain(VOICE_ENV_KEYS.model);
  });
});

describe("voice status and off", () => {
  test("off when nothing is configured", () => {
    const d = deps();
    expect(cmdVoiceStatus(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("voice mode: off");
  });

  test("on shows the model and only the tail of the key", async () => {
    const d = deps();
    await cmdVoiceSetup(d, ["--key", "AIza-secret-1234"]);
    d.io.stdout.length = 0;
    expect(cmdVoiceStatus(d)).toBe(EXIT.OK);
    const out = said(d);
    expect(out).toContain("voice mode: on");
    expect(out).toContain("gemini-3.8-live");
    expect(out).toContain("…1234");
    expect(out).not.toContain("AIza-secret");
  });

  test("an unusable file is a failure, not an off", () => {
    const d = deps({ seed: { [CONFIG_PATH]: JSON.stringify({ apiKey: "k", model: "nope" }) } });
    expect(cmdVoiceStatus(d)).toBe(EXIT.FAIL);
  });

  test("off removes only the file, and a second off is a clean no-op", async () => {
    const d = deps();
    await cmdVoiceSetup(d, ["--key", "k"]);
    expect(cmdVoiceOff(d)).toBe(EXIT.OK);
    expect(d.files.entries.has(CONFIG_PATH)).toBe(false);
    expect(cmdVoiceOff(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("already off");
  });

  test("status reports a voice.json that does not parse instead of calling it unconfigured", () => {
    const d = deps({ seed: { [CONFIG_PATH]: "{not json" } });
    expect(cmdVoiceStatus(d)).toBe(EXIT.FAIL);
    expect(said(d)).toContain("could not be parsed");
    expect(said(d)).not.toContain("nothing configured");
  });

  test("off does not claim voice is off while the environment still configures it", async () => {
    const d = deps({ env: { [VOICE_ENV_KEYS.key]: "AIza-env" } });
    await cmdVoiceSetup(d, ["--key", "k"]);
    d.io.stdout.length = 0;
    d.io.stderr.length = 0;
    expect(cmdVoiceOff(d)).toBe(EXIT.OK);
    const out = said(d);
    expect(out).toContain("removed");
    expect(out).not.toContain("Voice mode is off");
    expect(out).toContain(VOICE_ENV_KEYS.key);
  });
});

class ScriptedSocket implements UpstreamSocket {
  closed = false;
  private handlers: UpstreamHandlers | null = null;
  constructor(private readonly script: "ready" | "silent" | "drop") {}
  send(): void {
    if (this.script === "ready") this.handlers?.message(JSON.stringify({ setupComplete: {} }));
    if (this.script === "drop") this.handlers?.close();
  }
  close(): void {
    this.closed = true;
  }
  attach(h: UpstreamHandlers): void {
    this.handlers = h;
    queueMicrotask(() => h.open());
  }
  detach(): void {
    this.handlers = null;
  }
}

describe("voice test", () => {
  const seed = { [CONFIG_PATH]: JSON.stringify({ apiKey: "k" }) };

  test("passes when the session comes up", async () => {
    const d = deps({ seed, open: () => new ScriptedSocket("ready") });
    expect(await cmdVoiceTest(d)).toBe(EXIT.OK);
    expect(said(d)).toContain("session came up");
  });

  test("fails when upstream closes", async () => {
    const d = deps({ seed, open: () => new ScriptedSocket("drop") });
    expect(await cmdVoiceTest(d)).toBe(EXIT.FAIL);
    expect(said(d)).toContain("voice.upstream_closed");
  });

  test("fails on silence, after the deadline", async () => {
    const d = deps({ seed, open: () => new ScriptedSocket("silent") });
    expect(await cmdVoiceTest(d)).toBe(EXIT.FAIL);
    expect(said(d)).toContain("timeout");
  });

  test("refuses when voice mode is off", async () => {
    expect(await cmdVoiceTest(deps())).toBe(EXIT.FAIL);
  });
});

describe("voice dispatch", () => {
  test("a bare or misspelt sub-verb is a usage error", async () => {
    expect(await cmdVoice(deps(), [])).toBe(EXIT.USAGE);
    expect(await cmdVoice(deps(), ["nope"])).toBe(EXIT.USAGE);
  });
});
