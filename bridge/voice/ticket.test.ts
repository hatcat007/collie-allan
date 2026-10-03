import { describe, expect, test } from "bun:test";

import { createTicketStore, MAX_OUTSTANDING_TICKETS, TICKET_TTL_MS } from "./ticket.ts";

describe("ticket store", () => {
  test("a ticket is spent exactly once and carries its device", () => {
    const s = createTicketStore();
    const t = s.mint("phone", "tok");
    expect(t).not.toBeNull();
    expect(s.consume(t ?? "")).toEqual({ device: "phone", token: "tok" });
    expect(s.consume(t ?? "")).toBeNull();
  });

  test("an expired ticket is refused", () => {
    let clock = 0;
    const s = createTicketStore({ now: () => clock });
    const t = s.mint("phone", null) ?? "";
    clock = TICKET_TTL_MS;
    expect(s.consume(t)).toBeNull();
  });

  test("an unknown ticket is refused", () => {
    expect(createTicketStore().consume("nope")).toBeNull();
  });

  test("minting is capped, and expiry frees room", () => {
    let clock = 0;
    const s = createTicketStore({ now: () => clock });
    for (let i = 0; i < MAX_OUTSTANDING_TICKETS; i++) expect(s.mint("d", null)).not.toBeNull();
    expect(s.mint("d", null)).toBeNull();
    clock = TICKET_TTL_MS + 1;
    expect(s.mint("d", null)).not.toBeNull();
  });
});
