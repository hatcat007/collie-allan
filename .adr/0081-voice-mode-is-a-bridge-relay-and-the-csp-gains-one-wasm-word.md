# 0081: Voice mode is a bridge relay, and the CSP gains one WASM word

- **Status:** Accepted
- **Date:** 2026-10-03
- **Shipped in:** pending
- **Related:** [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) (the provider seam
  and the conditional egress this extends) ·
  [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (opt-in is the ceiling) ·
  [ADR 0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md) (no spoken secret)
- **Trail:** the operator's request for a Gemini Live voice mode with the ai-elements Persona avatar,
  which weighed a browser-to-Google socket with an ephemeral token against a bridge relay, and
  weighed Persona's CDN-hosted Rive assets against bundling them · `bridge/voice/` ·
  `bridge/server.ts` (`CSP`, `/api/voice`) · `web/src/components/ai-elements/persona.tsx`

## Context

The phone is a microphone and a screen with no keyboard worth the name. Gemini Live is a
bidirectional audio WebSocket with tool calls. Two roads were on the table. The browser could open
the socket itself with an ephemeral token, which is lower latency and needs no relay. Or the bridge
could hold the key and relay, which costs one hop.

The browser road needs `connect-src` opened to `generativelanguage.googleapis.com`, which is the
first time the CSP would name a foreign origin, and it puts a Google credential, even a short-lived
one, in a page that renders agent output. The ai-elements Persona avatar also fetches its `.riv`
scenes from a public blob CDN and its Rive WASM runtime from another, and a browser will not compile
a WASM module under `script-src 'self'` without `'wasm-unsafe-eval'`.

## Decision

**The bridge relays. The phone never talks to Google, and the CSP's `connect-src` stays `'self'`.**

1. **The key lives in `<stateDir>/voice.json`** at 0600, written only by `collie voice setup`, read
   per request behind an mtime check, exactly as `stt.json` is. There is no web form.
2. **One WebSocket, `GET /api/voice`, behind a one-use ticket.** A browser WebSocket cannot send the
   pairing bearer header, so `POST /api/voice/ticket` is write-gated like typing and mints a random
   ticket good for 30 seconds and one upgrade. One session at a time per process, one hour at most.
3. **The bridge executes no tool.** It declares four, `read_pane`, `draft_reply`, `send_reply` and
   `press_key`, and relays each call to the phone. The phone runs them through the same guarded path
   typing uses (`sendGuardedReply`), and a send or a key press waits on a tap. A spoken send is never
   a send around the reply guard.
4. **Persona is bundled, not fetched.** The six `.riv` scenes sit in `web/public/persona/` and the
   WASM is a hashed asset of the bundle. Neither is precached; they load when the voice sheet opens.
5. **The CSP gains `'wasm-unsafe-eval'` in `script-src` and nothing else.** It permits compiling WASM
   the page already loaded from `'self'`. It does not permit `eval` or `new Function`.

## Consequences

- Latency is one relay hop worse than a browser socket. Audio is 16 kHz in and 24 kHz out, so the hop
  is cheap, and nothing about the key or the screen text reaches the page.
- While a session is open, audio and the screen text of the pane being discussed leave the host for
  Google. `collie voice setup` says so. Doing nothing leaves voice off and the bridge as it was.
- `'wasm-unsafe-eval'` is a permanent widening of `script-src`. It is the price of the avatar and is
  what to remove first if voice mode is ever dropped.
- The Persona `.riv` files are Vercel's assets, taken from the library's own CDN. The code is
  Apache-2.0; confirm the assets' terms before a release ships them.
- Revisit the browser road only if the relay's hop is measured as the reason a conversation feels
  slow, and then only with an ephemeral token minted by the bridge and a CSP change argued here.
