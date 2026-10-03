import { describe, expect, test } from "vitest";

import { parseServerMessage } from "./protocol";

describe("parseServerMessage", () => {
  test("reads each message the bridge sends", () => {
    for (const t of ["ready", "interrupted", "turn_complete", "closed"]) {
      expect(parseServerMessage(`{"t":"${t}"}`)).toEqual({ t });
    }
    expect(parseServerMessage('{"t":"out_text","text":"hej"}')).toEqual({ t: "out_text", text: "hej" });
    expect(parseServerMessage('{"t":"audio","data":"QQ=="}')).toEqual({ t: "audio", data: "QQ==" });
    expect(parseServerMessage('{"t":"in_text","text":"hej"}')).toEqual({ t: "in_text", text: "hej" });
    expect(parseServerMessage('{"t":"tool_call","id":"1","name":"read_pane","args":{"a":1}}')).toEqual({
      t: "tool_call", id: "1", name: "read_pane", args: { a: 1 },
    });
    expect(parseServerMessage('{"t":"tool_call","id":"1","name":"x"}')).toEqual({
      t: "tool_call", id: "1", name: "x", args: {},
    });
    expect(parseServerMessage('{"t":"tool_cancelled","ids":["a",3]}')).toEqual({ t: "tool_cancelled", ids: ["a"] });
    for (const code of ["voice.upstream_unavailable", "voice.upstream_closed", "voice.bad_message", "voice.too_long"]) {
      expect(parseServerMessage(`{"t":"error","code":"${code}"}`)).toEqual({ t: "error", code });
    }
  });

  test("anything else is null", () => {
    for (const raw of ["nope", "[]", '{"t":"audio"}', '{"t":"error","code":"boom"}', '{"t":"wat"}', '{"x":1}']) {
      expect(parseServerMessage(raw)).toBeNull();
    }
  });
});
