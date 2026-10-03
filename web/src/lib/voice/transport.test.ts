import { describe, expect, test } from "vitest";

import { voiceSocketUrl } from "./transport";

describe("voiceSocketUrl", () => {
  test("follows the page's scheme and carries the ticket", () => {
    expect(voiceSocketUrl("t1", "https://phone.ts.net/pane/1")).toBe("wss://phone.ts.net/api/voice?ticket=t1");
    expect(voiceSocketUrl("t1", "http://127.0.0.1:8787/")).toBe("ws://127.0.0.1:8787/api/voice?ticket=t1");
  });
});
