/**
 * A move's budget note is judged by the route the module walked when the
 * verdict says its length (`pathLength`), and by the straight line only when
 * it does not: from the Deadmines staging spot a 165y line is a 660y walk
 * through the mine, and the line alone said nothing. An abandoned or
 * timed-out wait names the route's length too, beside the straight-line
 * progress, which understates a tunnel.
 */
import { describe, expect, test } from "bun:test";
import { connect, walkBudgetNote } from "../src/client";
import { EventTimeoutError } from "../src/events";
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
