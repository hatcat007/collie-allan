import { describe, expect, test } from "vitest";

import { parseServerMessage } from "./protocol";

describe("parseServerMessage", () => {
  test("reads each message the bridge sends", () => {
    expect(parseServerMessage('{"t":"ready"}')).toEqual({ t: "ready" });
    expect(parseServerMessage('{"t":"audio","data":"QQ=="}')).toEqual({ t: "audio", data: "QQ==" });
    expect(parseServerMessage('{"t":"in_text","text":"hej"}')).toEqual({ t: "in_text", text: "hej" });
    expect(parseServerMessage('{"t":"tool_call","id":"1","name":"read_pane","args":{"a":1}}')).toEqual({
      t: "tool_call", id: "1", name: "read_pane", args: { a: 1 },
    });
    expect(parseServerMessage('{"t":"tool_call","id":"1","name":"x"}')).toEqual({
      t: "tool_call", id: "1", name: "x", args: {},
    });
    expect(parseServerMessage('{"t":"tool_cancelled","ids":["a",3]}')).toEqual({ t: "tool_cancelled", ids: ["a"] });
    expect(parseServerMessage('{"t":"error","code":"voice.too_long"}')).toEqual({ t: "error", code: "voice.too_long" });
  });

  test("anything else is null", () => {
    for (const raw of ["nope", "[]", '{"t":"audio"}', '{"t":"error","code":"boom"}', '{"t":"wat"}', '{"x":1}']) {
      expect(parseServerMessage(raw)).toBeNull();
    }
  });
});
