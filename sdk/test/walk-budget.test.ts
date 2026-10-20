/**
 * A move's budget note is judged by the route the module walked when the
 * verdict says its length (`pathLength`), and by the straight line only when
 * it does not: from the Deadmines staging spot a 165y line is a 660y walk
 * through the mine, and the line alone said nothing. An abandoned or
 * timed-out wait names the route's length too, beside the straight-line
 * progress, which understates a tunnel.
 *
 * When the module also says how long its walker takes over the route
 * (`etaMs`: swim speed in deep water, run speed elsewhere, a mount's or a
 * ghost's speed in both), that time decides instead of yards at 7yd/s: a swim
 * the run speed would have fitted warns, a mounted ride it would not have
 * fitted is silent. The estimate is the SDK's own input — lifted off the
 * event at ingest, so neither an event the model reads nor a result type
 * carries it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, walkBudgetNote, type MoveResult } from "../src/client";
import { EventTimeoutError } from "../src/events";
import { moveProgressDataSchema, moveResultDataSchema } from "../src/protocol";
import { frames, loginSequence, moveResult, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

async function untilAction(stub: StubServer, action: string, from = 0): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && a.action === action);
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

describe("walkBudgetNote", () => {
  test("the route's length decides, with the straight line beside it", () => {
    expect(walkBudgetNote(165, 660, 30_000)).toBe(
      "this move's route is ~660y (~165y in a straight line) — about 94s at a base run speed of 7yd/s, and the " +
        "caller had ~30s of its budget left when it was issued. Awaiting a move this long does not fit one snippet: " +
        "dispatch it with sdk.moveToAsync(target) or from a background routine, then poll state.self.position.",
    );
  });

  test("without a route length, the straight line as before", () => {
    expect(walkBudgetNote(300, undefined, 30_000)).toBe(
      "this move is ~300y in a straight line — about 43s at a base run speed of 7yd/s, and the caller had ~30s of " +
        "its budget left when it was issued. Awaiting a move this long does not fit one snippet: dispatch it with " +
        "sdk.moveToAsync(target) or from a background routine, then poll state.self.position.",
    );
  });

  test("nothing when the walk fits, whichever length judges it", () => {
    expect(walkBudgetNote(165, 200, 30_000)).toBeUndefined();
    expect(walkBudgetNote(100, undefined, 30_000)).toBeUndefined();
    // A short line on a long route is the case the line alone missed.
    expect(walkBudgetNote(100, 600, 30_000)).toBeDefined();
  });

  test("a swim the run speed would have fitted warns, by the walker's own time", () => {
    // 180y of water: ~26s at 7yd/s, so silent before; ~38s at the 4.72yd/s swim speed.
    expect(walkBudgetNote(150, 180, 30_000)).toBeUndefined();
    expect(walkBudgetNote(150, 180, 30_000, 38_136)).toBe(
      "this move's route is ~180y (~150y in a straight line) — about 38s at the character's own pace, and the " +
        "caller had ~30s of its budget left when it was issued. Awaiting a move this long does not fit one snippet: " +
        "dispatch it with sdk.moveToAsync(target) or from a background routine, then poll state.self.position.",
    );
  });

  test("a mounted ride the run speed would have warned on is silent", () => {
    // 300y: ~43s at 7yd/s, so it warned before; ~27s at a 60% mount's 11.2yd/s.
    expect(walkBudgetNote(250, 300, 30_000)).toBeDefined();
    expect(walkBudgetNote(250, 300, 30_000, 26_786)).toBeUndefined();
  });

  test("the time decides even without a route length, and states no speed", () => {
    const note = walkBudgetNote(200, undefined, 20_000, 25_000);
    expect(note).toStartWith("this move is ~200y in a straight line — about 25s at the character's own pace, and the caller had ~20s");
    expect(note).not.toContain("yd/s");
  });
});

describe("moveTo: the route's length", () => {
  test("a verdict carrying pathLength past the budget says so, though the straight line fits", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false }, deadline: () => Date.now() + 5_000 });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });

    // 10y in a straight line (about 1s), 300y along the route (about 43s).
    const walk = client.moveTo({ x: -1224.5, y: 987.25, z: 42.125 });
    await untilAction(stub, "move_to");
    const verdict = moveResult("arrived", 1, 30) as { data: Record<string, unknown> };
    verdict.data.pathLength = 300;
    stub.push(JSON.stringify(verdict));
    const r = await walk;
    expect(r.ok).toBe(true);
    expect(r.hint).toContain("this move's route is ~300y (~10y in a straight line) — about 43s");

    // The same line with no length on the verdict (an older module): no note.
    const walk2 = client.moveTo({ x: -1224.5, y: 987.25, z: 42.125 });
    await untilAction(stub, "move_to", 1);
    stub.push(JSON.stringify(moveResult("arrived", 2, 31)));
    expect((await walk2).hint ?? "").not.toContain("of its budget left");

    client.close();
    await stub.stop();
  });

  test("a timed-out wait names the route's length from the move's progress events", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });

    const walk = client.moveTo({ x: -1224.5, y: 987.25, z: 42.125 }, { timeout: 300 });
    await untilAction(stub, "move_to");
    stub.push(
      JSON.stringify({
        seq: 40,
        opcode: "WB_MOVE_PROGRESS",
        opcodeId: 0xff02,
        ts: 1_700_000_000_400,
        data: { moveId: 1, pos: { x: -1230.0, y: 987.25, z: 42.1, o: 0 }, pathLength: 660 },
      }),
    );
    const err = await walk.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect((err as Error).message).toContain("still to go to (-1224.5, 987.3) in a straight line, on a route of ~660y (about 94s at 7yd/s)");

    client.close();
    await stub.stop();
  });
});

describe("moveTo: the walk's time", () => {
  test("a verdict's etaMs decides the note, and no event or result the caller reads carries it", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false }, deadline: () => Date.now() + 30_000 });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });

    // A swim: a 180y route is ~26s at 7yd/s (inside the ~30s left), ~38s swum.
    const swim = client.moveTo({ x: -1224.5, y: 987.25, z: 42.125 });
    await untilAction(stub, "move_to");
    const wet = moveResult("arrived", 1, 30) as { data: Record<string, unknown> };
    wet.data.pathLength = 180;
    wet.data.etaMs = 38_136;
    stub.push(JSON.stringify(wet));
    const r = await swim;
    expect(r.hint).toContain("this move's route is ~180y (~10y in a straight line) — about 38s at the character's own pace");
    expect(JSON.stringify(r)).not.toContain("etaMs");
    // @ts-expect-error — no model-facing result type has the field
    void r.etaMs;

    // Mounted: 300y is ~43s at 7yd/s (past the budget), ~27s ridden.
    const ride = client.moveTo({ x: -1224.5, y: 987.25, z: 42.125 });
    await untilAction(stub, "move_to", 1);
    const dry = moveResult("arrived", 2, 31) as { data: Record<string, unknown> };
    dry.data.pathLength = 300;
    dry.data.etaMs = 26_786;
    stub.push(JSON.stringify(dry));
    expect((await ride).hint ?? "").not.toContain("of its budget left");

    // Lifted at ingest: the buffer `sdk.events.recent()` serves (and the turn
    // context renders from) has the route's length but not the time.
    const verdicts = client.events.recent().filter((e) => e.opcode === "WB_MOVE_RESULT");
    expect(verdicts).toHaveLength(2);
    for (const e of verdicts) {
      expect((e.data as Record<string, unknown>).pathLength).toBeDefined();
      expect(e.data as object).not.toHaveProperty("etaMs");
    }

    client.close();
    await stub.stop();
  });

  test("an abandoned or timed-out wait states the progress event's time, not 7yd/s", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });

    const walk = client.moveTo({ x: -1224.5, y: 987.25, z: 42.125 }, { timeout: 300 });
    await untilAction(stub, "move_to");
    stub.push(
      JSON.stringify({
        seq: 40,
        opcode: "WB_MOVE_PROGRESS",
        opcodeId: 0xff02,
        ts: 1_700_000_000_400,
        data: { moveId: 1, pos: { x: -1230.0, y: 987.25, z: 42.1, o: 0 }, pathLength: 660, etaMs: 139_831 },
      }),
    );
    const err = await walk.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect((err as Error).message).toContain("on a route of ~660y (about 140s at the character's own pace)");
    const progress = client.events.recent().find((e) => e.opcode === "WB_MOVE_PROGRESS");
    expect(progress?.data as object).not.toHaveProperty("etaMs");

    client.close();
    await stub.stop();
  });

  test("the model's surface never names it: schemas and API.md", () => {
    expect(Object.keys(moveResultDataSchema.shape)).not.toContain("etaMs");
    expect(Object.keys(moveProgressDataSchema.shape)).not.toContain("etaMs");
    expect(readFileSync(join(import.meta.dir, "..", "API.md"), "utf8")).not.toContain("etaMs");
    const typed: MoveResult | undefined = undefined;
    // @ts-expect-error — not a field of any MoveResult variant
    void typed?.etaMs;
  });
});
