import { assertEquals } from "@std/assert";
import { isPusherConfig } from "./contract.ts";

Deno.test("pusher configuration admits both shared ports and both separate assignments", () => {
  for (const id of ["p1", "p2"]) {
    assertEquals(
      isPusherConfig({
        schema_version: 1,
        enabled_pushers: [id],
        assignments: { call_start: id, call_end: id },
      }),
      true,
    );
  }
  for (const [start, end] of [["p1", "p2"], ["p2", "p1"]]) {
    assertEquals(
      isPusherConfig({
        schema_version: 1,
        enabled_pushers: ["p1", "p2"],
        assignments: { call_start: start, call_end: end },
      }),
      true,
    );
  }
});

Deno.test("pusher configuration rejects missing, extra, ambiguous, and unlock assignments", () => {
  const valid = {
    schema_version: 1,
    enabled_pushers: ["p1"],
    assignments: { call_start: "p1", call_end: "p1" },
  };
  for (
    const input of [
      null,
      [],
      {},
      { ...valid, schema_version: "1" },
      { ...valid, arbitrary_gpio: 9 },
      { ...valid, enabled_pushers: [] },
      { ...valid, enabled_pushers: ["p1", "p1"] },
      { ...valid, enabled_pushers: ["p2", "p1"] },
      { ...valid, enabled_pushers: ["p3"] },
      { ...valid, enabled_pushers: ["p1", "p2"] },
      { ...valid, assignments: { call_start: "p1" } },
      { ...valid, assignments: { call_start: "p1", call_end: "p3" } },
      { ...valid, assignments: { ...valid.assignments, unlock: "p1" } },
    ]
  ) assertEquals(isPusherConfig(input), false, JSON.stringify(input));
});
