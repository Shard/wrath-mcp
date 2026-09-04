import { describe, expect, test } from "bun:test";

import { connect, inventoryResultText, meshZHint, WrathRequestError, WrathTransportError } from "../src/client";
import { EventAbortedError, EventTimeoutError } from "../src/events";
import {
  addKill,
  attackStopped,
  BACKPACK_SLOT,
  chatEcho,
  corpseQuery,
  corpseReclaimDelay,
  deathReleaseCleared,
  CREATURE_ENTRY,
  CREATURE_GUID,
  creatureCreate,
  creatureHealth,
  creatureMove,
  creatureOutOfRange,
  creatureQuery,
  frames,
  gossipWithQuests,
  inventoryChangeFailure,
  inventorySlot,
  inventorySlotCleared,
  inventorySlotMove,
  ITEM_ENTRY,
  ITEM_GUID,
  ITEM_GUID_HI,
  ITEM_GUID_LO,
  itemCreate,
  itemPushed,
  itemQuery,
  loginSequence,
  lootRelease,
  lootResponse,
  moveProgress,
  moveResult,
  newWorld,
  transferAborted,
  teleportAck,
  transferPending,
  offerReward,
  OTHER_QUEST_ID,
  playerCreate,
  playerName,
  PLAYER_GUID,
  QUEST_ID,
  questAccepted,
  questComplete,
  questGiverList,
  questGiverStatus,
  questGiverStatusMultiple,
  questProgress,
  questQueryResponse,
  questRewarded,
  requestItems,
  SELF_GUID,
  selfArrived,
  selfCreate,
  selfHealth,
  selfProgress,
  swing,
  trainerBuyFailed,
  trainerBuySucceeded,
  trainerList,
  CHEST_GUID,
  castFailed,
  chestCreate,
  chestLootResponse,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("client: the happy path through the slice", () => {
  test("connect -> createSession -> say -> chat -> logout, with the cache following along", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "run-test", events: { reconnect: false } });

    const health = await client.health();
    expect(health.module).toBe("mod-wrathbench");

    const session = await client.createSession({ character: "Fenwick", race: 1, class: 1, gender: 0 });
    expect(session.inWorld).toBe(true);
    expect(session.guid).toBe("7");

    // The login events arrived while the POST was in flight; the cache has them.
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
    expect(client.state.self.guid).toBe("7");
    expect(client.state.self.name).toBe("Fenwick");
    expect(client.state.self.level?.value).toBe(3);
    expect(client.state.self.position?.value.map).toBe(0);
    expect(client.state.characters?.value).toHaveLength(2);

    const ack = await client.say("ping from the fixture");
    expect(ack.action).toBe("say");
    stub.push(JSON.stringify(chatEcho));

    const entry = await client.waitForChat("ping from the fixture", { timeout: 2000 });
    expect(entry.senderGuid).toBe("7");
    expect(entry.seq).toBe(4);
    expect(client.state.chat.at(-1)?.message).toBe("ping from the fixture");

    const bye = await client.logout();
    expect(bye.ok).toBe(true);

    client.close();
    await stub.stop();
  });

  test("waitForChat accepts a predicate and can time out", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    const pending = client.waitForChat((e) => e.message.startsWith("ping"), { timeout: 1000 });
    stub.push(JSON.stringify(chatEcho));
    expect((await pending).message).toBe("ping from the fixture");

    await expect(client.waitForChat("never said", { timeout: 20 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
    client.close();
    await stub.stop();
  });

  test("connect can skip the subscription for a health-only client", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    expect((await client.health()).ok).toBe(true);
    expect(client.events.connected).toBe(false);
    client.close();
    await stub.stop();
  });
});

describe("client: operator-bound account", () => {
  test("a bound account fills an omitted createSession account", async () => {
    const stub = startStub();
    const client = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      account: "RUNNER6",
      subscribeEvents: false,
    });
    // The RUNNER6→RUNNER defect: the model omits the account entirely.
    await client.createSession({ character: "Qwenlocal", race: 1, class: 2 });
    expect(stub.sessions).toHaveLength(1);
    expect(stub.sessions[0]?.account).toBe("RUNNER6");
    client.close();
    await stub.stop();
  });

  test("a bound account overrides an account the model typed", async () => {
    const stub = startStub();
    const client = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      account: "RUNNER6",
      subscribeEvents: false,
    });
    // The model should never pass an account; if it does, the bound one wins so
    // it cannot land on someone else's account by typing the default.
    await client.createSession({ character: "Qwenlocal", account: "RUNNER", race: 1, class: 2 });
    expect(stub.sessions[0]?.account).toBe("RUNNER6");
    client.close();
    await stub.stop();
  });

  test("with no bound account the request's own account is preserved (standalone)", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await client.createSession({ character: "Fenwick", account: "PROBE", race: 1, class: 1 });
    expect(stub.sessions[0]?.account).toBe("PROBE");
    client.close();
    await stub.stop();
  });

  test("a bound account wins over a deleteCharacter account too", async () => {
    const stub = startStub();
    const client = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      account: "RUNNER6",
      subscribeEvents: false,
    });
    await client.deleteCharacter("Qwenlocal", { account: "RUNNER", retryDelayMs: 5 });
    expect(stub.characterDeletes[0]?.account).toBe("RUNNER6");
    client.close();
    await stub.stop();
  });
});

describe("client: movement", () => {
  test("the default signal aborts a pending moveTo, issues one stop, and leaves later waits alive (item 44)", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    // A provider, as the runner passes it: consulted at the start of each wait.
    let current: AbortSignal | undefined;
    const client = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      events: { reconnect: false },
      signal: () => current,
    });
    await client.createSession({ character: "Fenwick" });

    const ac = new AbortController();
    current = ac.signal;
    const walk = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 5000 });
    await Bun.sleep(20); // let the move_to ack land so the wait is armed
    ac.abort(new Error("snippet abandoned"));
    await expect(walk).rejects.toBeInstanceOf(EventAbortedError);
    await expect(walk).rejects.toThrow(/snippet abandoned/);
    await Bun.sleep(20);
    // Exactly one stop, after the move_to — deterministic, no game semantics.
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to", "stop"]);

    // A late verdict for the aborted move is ignored; a fresh eval's signal
    // does not inherit the old abort.
    stub.push(JSON.stringify(moveResult("arrived", 1, 30)));
    current = new AbortController().signal;
    const again = client.moveTo({ x: 4, y: 5, z: 6 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("arrived", 2, 31)));
    expect((await again).status).toBe("arrived");
    expect(stub.actions.filter((a) => a.action === "stop")).toHaveLength(1);

    client.close();
    await stub.stop();
  });

  test("a wait against an already-aborted default signal settles at once; waitForTransfer rethrows the abort", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const ac = new AbortController();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false }, signal: ac.signal });
    await client.createSession({ character: "Fenwick" });
    ac.abort();
    // Not a TransferResult: an abort is the absence of a verdict, never a status.
    await expect(client.waitForTransfer({ timeout: 2000 })).rejects.toBeInstanceOf(EventAbortedError);
    await expect(client.killTarget(CREATURE_GUID, { timeout: 2000 })).rejects.toBeInstanceOf(EventAbortedError);
    client.close();
    await stub.stop();
  });

  test("moveTo resolves on the WB_MOVE_RESULT carrying its own moveId", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const pending = client.moveTo({ x: -1205, y: 981, z: 42 }, { timeout: 2000 });
    // A result for a *different* move must not settle this one.
    stub.push(JSON.stringify(moveResult("arrived", 99, 30)));
    stub.push(JSON.stringify(moveResult("arrived", 1, 31)));
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.status).toBe("arrived");
    expect(result.moveId).toBe(1);
    expect(result.seq).toBe(31);
    expect(result.position).toEqual({ x: -1205, y: 981, z: 42, o: 1.2 });
    // The server-confirmed position is on the cache too, with its provenance.
    expect(client.state.self.position?.value.x).toBe(-1205);
    expect(client.state.self.position?.seq).toBe(31);

    client.close();
    await stub.stop();
  });

  test("moveTo(x, y, z) as three positional numbers is repaired to a point", async () => {
    // Deterministic repair: weak models write moveTo this way across
    // every family (nemotron/hy3/gpt-oss, 2026-08-22). Same outcome as the
    // object form; every other bad shape still throws.
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    // @ts-expect-error — the repaired call is untyped JS as a model writes it
    const pending = client.moveTo(-1205, 981, 42, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("arrived", 1, 31)));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.position).toEqual({ x: -1205, y: 981, z: 42, o: 1.2 });

    // A genuinely broken shape is still rejected loudly, with the message the
    // shape earns: two numbers are a half-written point, not a guid.
    // @ts-expect-error — deliberately wrong
    await expect(client.moveTo(-1205, 981)).rejects.toThrow(/needs a point object \{ x, y, z \}, got number/);
    // A non-numeric string is a name now: nothing in view answers to it, and
    // moveTo answers an unresolvable target with a value, not a throw.
    expect(await client.moveTo("here")).toMatchObject({ ok: false, status: "unknown_target" });
    // A malformed guid on a unit-shaped object is still the loud reject.
    // @ts-expect-error — deliberately wrong
    await expect(client.moveTo({ guid: "12abc34" })).rejects.toThrow(/neither a point nor a decimal guid string/);

    client.close();
    await stub.stop();
  });

  test("a game-level failure comes back as a result, not an exception", async () => {
    for (const status of ["too_far", "no_mesh", "target_off_mesh", "start_off_mesh", "path_incomplete", "interrupted", "stopped", "superseded"] as const) {
      const stub = startStub({ onConnect: () => frames(loginSequence) });
      const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
      await client.createSession({ character: "Fenwick" });

      const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
      stub.push(JSON.stringify(moveResult(status, 1, 30)));
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      // Where the character actually ended up — what the next decision needs.
      expect(result.position?.x).toBe(-1205);
      client.close();
      await stub.stop();
    }
  });

  test("a move that never moved sends the stop the module left unsent", async () => {
    // fleet-nav-probe-sonnet-20260822-c3: a walking move (heartbeats carrying
    // MOVEMENTFLAG_FORWARD) was superseded by a sweep of moveTo calls that all
    // failed `start_off_mesh`. `DoMoveTo` finishes the superseded move without
    // a MSG_MOVE_STOP and a planning failure sends no packet at all, so the
    // server's last word stayed "walking forward": ~10 minutes of Hearthstone
    // use_item answering SMSG_CAST_FAILED result 51 (SPELL_FAILED_MOVING)
    // while the character stood still, ended by one `stop`. The repair is
    // deterministic: after a move that did not move, "stop walking" has one reading.
    for (const status of ["too_far", "no_mesh", "target_off_mesh", "start_off_mesh", "path_incomplete", "drop"] as const) {
      const stub = startStub({ onConnect: () => frames(loginSequence) });
      const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
      await client.createSession({ character: "Fenwick" });

      const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
      stub.push(JSON.stringify(moveResult(status, 1, 30)));
      expect((await pending).status).toBe(status);
      expect(stub.actions.map((a) => a.action)).toEqual(["move_to", "stop"]);
      client.close();
      await stub.stop();
    }

    // The statuses where something did move, or something else is moving now:
    // the module already sent the stop (arrived, interrupted), a stop is what
    // ended it (stopped), or a newer move is walking and stopping it would
    // change game semantics (superseded).
    for (const status of ["arrived", "interrupted", "stopped", "superseded"] as const) {
      const stub = startStub({ onConnect: () => frames(loginSequence) });
      const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
      await client.createSession({ character: "Fenwick" });

      const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
      stub.push(JSON.stringify(moveResult(status, 1, 30)));
      expect((await pending).status).toBe(status);
      expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
      client.close();
      await stub.stop();
    }
  });

  test("hint-bearing failures are tallied per status on the client's own channel and drained once", async () => {
    // The hint rides inside the result object, so a snippet that keeps only
    // `.status` never shows it to the model (run a11: 41 `too_far`, hint read 0
    // times). The client records it as well; the sandbox drains this.
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    expect(client.drainActionHints()).toEqual([]);

    for (let i = 0; i < 3; i++) {
      const pending = client.moveTo({ x: 10 + i, y: 20, z: 30 }, { timeout: 2000 });
      stub.push(JSON.stringify(moveResult("too_far", i + 1, 30 + i)));
      await pending;
    }
    const p = client.moveTo({ x: 99, y: 98, z: 97 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("target_off_mesh", 4, 40)));
    await p;
    // An arrival is not a hint-bearing failure and must not be recorded.
    const ok = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("arrived", 5, 41)));
    await ok;

    const drained = client.drainActionHints();
    expect(drained.length).toBe(2);
    const tooFar = drained.find((h) => h.status === "too_far");
    expect(tooFar?.action).toBe("moveTo");
    expect(tooFar?.count).toBe(3);
    // The last occurrence's hint and point: nearest to where the character is.
    expect(tooFar?.point).toEqual({ x: 12, y: 20, z: 30 });
    expect(tooFar?.hint).toContain("a single moveTo covers ~250y");
    expect(drained.find((h) => h.status === "target_off_mesh")?.count).toBe(1);
    // Drained exactly once.
    expect(client.drainActionHints()).toEqual([]);

    client.close();
    await stub.stop();
  });

  test("a moveTo to an unknown target is recorded too, and its hint is the one the caller got", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    const r = await client.moveTo("999999999");
    expect(r.ok).toBe(false);
    const drained = client.drainActionHints();
    expect(drained.length).toBe(1);
    expect(drained[0]?.status).toBe("unknown_target");
    expect(drained[0]?.hint).toBe(r.ok ? undefined : r.hint);
    client.close();
    await stub.stop();
  });

  test("a refused stop after a failed move never masks the move verdict", async () => {
    const stub = startStub({
      onConnect: () => frames(loginSequence),
      failAction: (action) => (action === "stop" ? json({ ok: false, error: "not_in_world" }, 409) : undefined),
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("start_off_mesh", 1, 30)));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("start_off_mesh");
    client.close();
    await stub.stop();
  });

  test("each typed failure carries its own recovery hint; path_incomplete carries reachedPos", async () => {
    // FOLLOW-UPS 38 N1: the module now names the cause, so the hint is only
    // the recovery that follows from it.
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const p1 = client.moveTo({ x: 10, y: 20, z: 30 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("target_off_mesh", 1, 30)));
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error("unreachable");
    expect(r1.hint).toContain("10.0, 20.0");
    expect(r1.hint).toContain("not on walkable ground");
    expect(r1.reachedPos).toBeUndefined();

    const p2 = client.moveTo({ x: 10, y: 20, z: 30 }, { timeout: 2000 });
    const partial = moveResult("path_incomplete", 2, 31) as { data: Record<string, unknown> };
    partial.data.reachedPos = { x: 5, y: 6, z: 7 };
    stub.push(JSON.stringify(partial));
    const r2 = await p2;
    if (r2.ok) throw new Error("unreachable");
    expect(r2.status).toBe("path_incomplete");
    expect(r2.reachedPos).toEqual({ x: 5, y: 6, z: 7 });
    expect(r2.hint).toContain("ends at (5.0, 6.0)");

    const p3 = client.moveTo({ x: 10, y: 20, z: 30 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("no_mesh", 3, 32)));
    const r3 = await p3;
    if (r3.ok) throw new Error("unreachable");
    expect(r3.hint).toContain("harness data limitation");

    const p4 = client.moveTo({ x: 10, y: 20, z: 30 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("start_off_mesh", 4, 33)));
    const r4 = await p4;
    if (r4.ok) throw new Error("unreachable");
    expect(r4.hint).toContain("transport deck");
    client.close();
    await stub.stop();
  });

  test("target_off_mesh on a known transport dock names the car and says it is not here", async () => {
    // The tram platform with no car on it: the rail bed is not mesh, so the
    // module says target_off_mesh. The generic hint ("pick a floor") would
    // send the agent away from the one point boarding works at; with the car
    // observed docking there (WB_TRANSPORT_PROGRESS docked:true) the hint
    // says whose dock it is and where the car is now.
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    const tram = (seq: number, pos: { x: number; y: number; z: number }, docked: boolean, progressMs: number) =>
      JSON.stringify({
        seq,
        opcode: "WB_TRANSPORT_PROGRESS",
        opcodeId: 0xff06,
        ts: 1_700_000_000_000 + seq,
        data: { guid: "9001", entry: 176081, pos: { ...pos, o: 0 }, progressMs, periodMs: 143_330, docked },
      });
    stub.push(
      JSON.stringify({
        seq: 20,
        opcode: "SMSG_UPDATE_OBJECT",
        opcodeId: 0x0a9,
        ts: 1_700_000_000_020,
        data: {
          blocks: 1,
          objects: [{ update: "create", guid: "9001", objectType: "gameObject", pos: { x: 4.5, y: 8.4, z: -4.3, o: 0 }, fields: { entry: 176081, goType: 11 } }],
        },
      }),
    );
    stub.push(
      JSON.stringify({
        seq: 21,
        opcode: "SMSG_GAMEOBJECT_QUERY_RESPONSE",
        opcodeId: 0x05f,
        ts: 1_700_000_000_021,
        data: { entry: 176081, found: true, name: "Subway", type: 11, displayId: 3831, castBarCaption: "" },
      }),
    );
    stub.push(tram(22, { x: 4.5, y: 8.4, z: -4.3 }, true, 5_000));
    stub.push(tram(23, { x: 4.5, y: 1200.0, z: -4.3 }, false, 40_000));
    await client.events.waitFor((e) => e.seq === 23, { timeout: 2000 });

    const p1 = client.moveTo({ x: 4.5, y: 8.4, z: -4.3 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("target_off_mesh", 1, 30)));
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error("unreachable");
    expect(r1.status).toBe("target_off_mesh");
    expect(r1.hint).toContain("where Subway (guid 9001) docks");
    expect(r1.hint).toContain("it is moving, now at (4.5, 1200.0) 40s into its 143s cycle");
    expect(r1.hint).toContain("not a z problem");
    expect(r1.hint).not.toContain("Pick a point on a road");

    // Far from any dock the generic hint stands.
    const p2 = client.moveTo({ x: 400, y: 8.4, z: -4.3 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("target_off_mesh", 2, 31)));
    const r2 = await p2;
    if (r2.ok) throw new Error("unreachable");
    expect(r2.hint).toContain("Pick a point on a road");

    // A no-car attempt that the module judged a drop onto the rail bed is a
    // typed failure, never `arrived` and never aboard.
    const p3 = client.moveTo({ x: 4.5, y: 8.4, z: -4.3 }, { timeout: 2000 });
    const ev = moveResult("drop", 3, 32) as { data: Record<string, unknown> };
    ev.data.reachedPos = { x: 14.0, y: 8.4, z: -4.3 };
    ev.data.dz = -6.2;
    stub.push(JSON.stringify(ev));
    const r3 = await p3;
    expect(r3.ok).toBe(false);
    expect(r3.status).toBe("drop");
    expect((r3 as { onTransport?: unknown }).onTransport).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("drop carries the edge, the step and the target, with a hint about levels", async () => {
    // Navigation-cause amendment earned by nav-probe c4 (map 369): a route that falls 7.64y
    // over 1y of 2D travel is a ledge. The module refuses the walk and says
    // where the edge is; the hint says to change level by ramp or stairs.
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const p = client.moveTo({ x: 10, y: 20, z: -6.9 }, { timeout: 2000 });
    const ev = moveResult("drop", 1, 30) as { data: Record<string, unknown> };
    ev.data.reachedPos = { x: 9.2, y: 19.5, z: 0.7 };
    ev.data.dz = -7.64;
    ev.data.target = { x: 10, y: 20, z: -6.9 };
    stub.push(JSON.stringify(ev));
    const r = await p;
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe("drop");
    expect(r.reachedPos).toEqual({ x: 9.2, y: 19.5, z: 0.7 });
    expect(r.dz).toBe(-7.64);
    expect(r.hint).toContain("route to (10.0, 20.0, z -6.9) steps off a ledge of 7.6 yards at (9.2, 19.5)");
    expect(r.hint).toContain("stopped at the edge");
    expect(r.hint).toContain("ramp/stairs");
    // Nothing moved, so the SDK sends the stop the module left unsent.
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to", "stop"]);
    client.close();
    await stub.stop();
  });

  test("the meshZ hint says 'quote it' within 3y and 'a different level' beyond", async () => {
    expect(meshZHint({ x: 1, y: 2, z: 80 }, 81.5)).toContain("The mesh owns z; quote 81.5");
    expect(meshZHint({ x: 1, y: 2, z: 80 }, 77)).toContain("quote 77.0");
    const far = meshZHint({ x: 1, y: 2, z: 0.7 }, -6.9);
    expect(far).toContain("z -6.9, not 0.7");
    expect(far).toContain("ended 7.6 yards below the requested point");
    expect(far).toContain("not what put it there");
    expect(far).not.toContain("quote");
    expect(meshZHint({ x: 1, y: 2, z: 0 }, 5)).toContain("5.0 yards above");
  });

  test("arrived with meshZ says which z the mesh used; a plain arrived carries neither", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const p1 = client.moveTo({ x: -1205, y: 981, z: 80 }, { timeout: 2000 });
    const withZ = moveResult("arrived", 1, 30) as { data: Record<string, unknown> };
    withZ.data.meshZ = 42;
    stub.push(JSON.stringify(withZ));
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    if (!r1.ok || r1.status !== "arrived") throw new Error("unreachable");
    expect(r1.meshZ).toBe(42);
    expect(r1.hint).toContain("z 42.0, not 80.0");
    // 38y is a level, not a stale z: the hint must not say "quote it".
    expect(r1.hint).toContain("38.0 yards below");
    expect(r1.hint).not.toContain("quote");

    // A short walk, so the caller's 2s timeout draws no mesh-slack note either.
    const p2 = client.moveTo({ x: -1200, y: 983, z: 42 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("arrived", 2, 31)));
    const r2 = await p2;
    if (!r2.ok || r2.status !== "arrived") throw new Error("unreachable");
    expect(r2.meshZ).toBeUndefined();
    expect(r2.hint).toBeUndefined();

    // Aboard a transport at the end of the move: the module says which.
    const p4 = client.moveTo({ x: 4.5, y: 8.4, z: -4.3 }, { timeout: 2000 });
    const aboard = moveResult("arrived", 3, 33) as { data: Record<string, unknown> };
    aboard.data.onTransport = { guid: "12345", entry: 176081 };
    stub.push(JSON.stringify(aboard));
    const r4 = await p4;
    if (!r4.ok || r4.status !== "arrived") throw new Error("unreachable");
    expect(r4.onTransport).toEqual({ guid: "12345", entry: 176081 });

    // A status the SDK has no recipe for passes through with no hint invented.
    const p3 = client.moveTo({ x: -1200, y: 983, z: 42 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("stopped", 4, 34)));
    const r3 = await p3;
    if (r3.ok) throw new Error("unreachable");
    expect(r3.hint).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("transferred resolves on SMSG_NEW_WORLD, even one that landed before the move result", async () => {
    // FOLLOW-UPS 38 N1: the postcondition is the server naming the new map,
    // never the dispatch. The server sends NEW_WORLD in the tick the portal
    // fires; the module's `transferred` result follows on the next world tick.
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const pending = client.moveTo({ x: -4839, y: -1330, z: 508 }, { timeout: 2000 });
    stub.push(JSON.stringify(transferPending(369, 30)));
    stub.push(JSON.stringify(newWorld(369, 31)));
    stub.push(JSON.stringify(moveResult("transferred", 1, 32)));
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "transferred") throw new Error("unreachable");
    expect(result.to).toEqual({ map: 369, x: 69.25, y: 10.26, z: -4.3, o: 3.1 });
    expect(result.position.x).toBe(-1205); // old-map position from the result
    expect(result.hint).toContain("map 369");
    // The cache holds the *arrival* point, not the old-map pos the result
    // carried: a `transferred` result is never folded into self position.
    expect(client.state.self.position?.value).toEqual({ map: 369, x: 69.25, y: 10.26, z: -4.3, o: 3.1 });
    client.close();
    await stub.stop();
  });

  test("teleported (same-map port) resolves on the own-guid MSG_MOVE_TELEPORT_ACK, never waits for NEW_WORLD", async () => {
    // item 46: a Hearthstone mid-move used to answer `transferred`, and
    // moveTo then waited 90s for an SMSG_NEW_WORLD that never comes on a
    // same-map port. The module now says `teleported`, and the arrival point
    // is the server's own teleport ack, sent before the result.
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const pending = client.moveTo({ x: -4839, y: -1330, z: 508 }, { timeout: 2000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(teleportAck(30)));
    stub.push(JSON.stringify(moveResult("teleported", 1, 31)));
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "teleported") throw new Error("unreachable");
    expect(result.to).toEqual({ x: -8833.4, y: 625.9, z: 93.9, o: 0.5 });
    expect(result.position.x).toBe(-1205); // pre-teleport position from the result
    expect(result.hint).toContain("same-map teleport");
    // Self position is the arrival, on the same map; the result's pre-teleport
    // `pos` (seq 31, later) did not overwrite it.
    expect(client.state.self.position?.value).toEqual({ map: 0, x: -8833.4, y: 625.9, z: 93.9, o: 0.5 });
    expect(client.state.self.position?.seq).toBe(30);
    client.close();
    await stub.stop();
  });

  test("teleported with no teleport ack observed is ok:false, status intact, no 90s wait", async () => {
    // The ack wait is a fixed 5s (it normally hits the buffer), so give the
    // test room for exactly that.
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const started = Date.now();
    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 60_000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveResult("teleported", 1, 31)));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("teleported");
    if (result.ok) throw new Error("unreachable");
    expect(result.hint).toContain("MSG_MOVE_TELEPORT_ACK");
    expect(Date.now() - started).toBeLessThan(20_000);
    client.close();
    await stub.stop();
  }, 15_000);

  test("transferred with the transfer still pending at the deadline is ok:false, status intact", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 300 });
    stub.push(JSON.stringify(transferPending(369, 30)));
    stub.push(JSON.stringify(moveResult("transferred", 1, 31)));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("transferred");
    if (result.ok) throw new Error("unreachable");
    expect(result.hint).toContain("map 369");
    expect(result.hint).toContain("waitForTransfer");
    client.close();
    await stub.stop();
  });

  test("a moveTo timeout says the character is still walking and how far is left", async () => {
    // fleet-nav-probe-freeplay-sonnet-20260823-c4: 27/27 short-timeout moves
    // had their verdict arrive *after* the timeout, and the bare "timed out"
    // message led the model to supersede a move that was about to succeed.
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);

    const walk = client.moveTo({ x: -1000, y: 987.25, z: 42 }, { timeout: 1500 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveProgress)); // walked ~15y of the way, no verdict
    const err = (await walk.catch((e: unknown) => e)) as EventTimeoutError;
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect(err.message).toContain("~15y covered");
    expect(err.message).toContain("~220y still to go");
    expect(err.message).toContain("the character is still walking");
    expect(err.message).toContain("this move's verdict will arrive later");
    expect(err.message).toContain("1.5–2× the straight line");
    expect(err.message).toContain("sdk.moveToAsync(target)");

    client.close();
    await stub.stop();
  });

  test("a timeout shorter than the likely walk is called out on the verdict, with no deadline set", async () => {
    // The pre-flight hint must not depend on a caller budget: the probes that
    // hit this had no deadline at all.
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);

    const pending = client.moveTo({ x: -1000, y: 987.25, z: 42 }, { timeout: 5000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveResult("arrived", 1, 31)));
    const result = await pending;

    expect(result.status).toBe("arrived");
    expect(result.hint).toContain("~235y in a straight line");
    expect(result.hint).toContain("against the 5s timeout it was given");
    expect(result.hint).toContain("1.5–2× the straight line");
    expect(result.hint).toContain("sdk.moveToAsync(target)");

    client.close();
    await stub.stop();
  });

  test("a generous caller timeout draws no mesh-slack hint", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);

    const pending = client.moveTo({ x: -1234.5, y: 990, z: 42 }, { timeout: 10_000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveResult("arrived", 1, 31)));
    const result = await pending;

    expect(result.status).toBe("arrived");
    expect(result.hint).toBeUndefined();

    client.close();
    await stub.stop();
  });

  test("waitForTransfer: aborted, wrong_map, no_transfer, and a stale NEW_WORLD is not this transfer", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    // An earlier, completed transfer sits in the buffer; it must not answer a later wait.
    stub.push(JSON.stringify(newWorld(1, 30)));
    await client.events.waitFor((e) => e.seq === 30, { timeout: 1000 });
    const none = await client.waitForTransfer({ timeout: 200 });
    expect(none.status).toBe("no_transfer");

    const p1 = client.waitForTransfer({ timeout: 1000 });
    stub.push(JSON.stringify(transferPending(369, 31)));
    stub.push(JSON.stringify(transferAborted(369, 1, 32)));
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    if (r1.status !== "aborted") throw new Error("unreachable");
    expect(r1.reason).toBe(1);
    expect(client.state.self.transfer).toBeUndefined();

    const p2 = client.waitForTransfer({ timeout: 1000, expectMap: 369 });
    stub.push(JSON.stringify(newWorld(0, 33)));
    const r2 = await p2;
    if (r2.status !== "wrong_map") throw new Error("unreachable");
    expect(r2.expected).toBe(369);
    expect(r2.actual).toBe(0);

    const p3 = client.waitForTransfer({ timeout: 200 });
    stub.push(JSON.stringify(transferPending(369, 34)));
    const r3 = await p3;
    if (r3.status !== "waiting") throw new Error("unreachable");
    expect(r3.toMap).toBe(369);
    client.close();
    await stub.stop();
  });

  test("a relog cannot resolve a moveTo against the previous session's stale result", async () => {
    // The module's moveId generator is per-session and restarts when the
    // session is recreated, so after a relog a fresh ack can reuse a moveId
    // that a stale buffered result still carries (FOLLOW-UPS item 14: probes
    // with 8s timeouts "resolved" in 59ms against pre-relog payloads). The
    // stub pins moveId 1 on every ack to force exactly that collision.
    const stub = startStub({
      onConnect: () => frames(loginSequence),
      routes: { action: () => json({ ok: true, action: "move_to", token: "stub", moveId: 1 }, 200) },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    // First session: a completed move leaves its result in the buffer.
    const first = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("arrived", 1, 36)));
    expect((await first).status).toBe("arrived");

    // Relog: the module recreates the session; seq and moveId both restart.
    await client.logout();
    await client.createSession({ character: "Fenwick" });
    for (const f of frames(loginSequence)) stub.push(f);

    // The stale result (moveId 1, seq 36) is still buffered. It must not
    // settle the new session's move: absence of a fresh result is a timeout.
    await expect(client.moveTo({ x: 4, y: 5, z: 6 }, { timeout: 100 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );

    // The new session's own result still resolves, buffered or live.
    const pending = client.moveTo({ x: 4, y: 5, z: 6 }, { timeout: 2000 });
    stub.push(JSON.stringify(moveResult("arrived", 1, 5)));
    const result = await pending;
    expect(result.status).toBe("arrived");
    expect(result.seq).toBe(5);

    client.close();
    await stub.stop();
  });

  test("a moveTo left pending across a recreate cannot resolve against the new session's colliding moveId", async () => {
    // The forward twin of the stale-buffer test above: the epoch guard must be
    // an *exact* match, not a floor. A move still pending when its session is
    // torn down and recreated has no verdict — the new session's first move
    // also carries moveId 1 (the module's generator is per-session), and it
    // must not settle the old waiter with the wrong session's position.
    const stub = startStub({
      onConnect: () => frames(loginSequence),
      routes: { action: () => json({ ok: true, action: "move_to", token: "stub", moveId: 1 }, 200) },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    // A move that never gets its result before the session goes away. Settle
    // is captured eagerly so the rejection is never left unhandled.
    const stale = client
      .moveTo({ x: 1, y: 2, z: 3 }, { timeout: 900 })
      .then((r) => ({ settled: "resolved" as const, r }), (e: unknown) => ({ settled: "rejected" as const, e }));
    // Let the ack land so the waiter is registered before the recreate.
    await Bun.sleep(30);

    // Recreate the session; seq and moveId both restart.
    await client.logout();
    await client.createSession({ character: "Fenwick" });
    for (const f of frames(loginSequence)) stub.push(f);

    // The NEW session's result for ITS moveId 1 arrives while the old waiter
    // is still pending. The old moveTo must time out, not claim this verdict.
    stub.push(JSON.stringify(moveResult("arrived", 1, 5)));
    const outcome = await stale;
    expect(outcome.settled).toBe("rejected");
    if (outcome.settled === "rejected") expect(outcome.e).toBeInstanceOf(EventTimeoutError);

    // The new session's own moveTo still sees that (buffered) result.
    const fresh = await client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    expect(fresh.status).toBe("arrived");
    expect(fresh.seq).toBe(5);

    client.close();
    await stub.stop();
  });

  test("a request the module refuses still throws; a missing result times out", async () => {
    const refusing = startStub({
      routes: { action: () => json({ ok: false, error: "missing_position" }, 400) },
    });
    const a = await connect({ baseUrl: refusing.baseUrl, token: "t", subscribeEvents: false });
    const err = (await a.moveTo({ x: 1, y: 2, z: 3 }).catch((e) => e)) as WrathRequestError;
    expect(err).toBeInstanceOf(WrathRequestError);
    expect(err.code).toBe("missing_position");
    expect(err.kind).toBe("request");
    await refusing.stop();

    // No result event: the absence of an outcome is not an outcome.
    const silent = startStub();
    const b = await connect({ baseUrl: silent.baseUrl, token: "t", events: { reconnect: false } });
    await expect(b.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 50 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
    b.close();
    await silent.stop();
  });

  test("stop and face ack their own shapes", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    expect((await client.stop()).action).toBe("stop");
    expect((await client.face(1.57)).orientation).toBe(1.57);
    expect((await client.face({ x: 1, y: 2 })).action).toBe("face");
    client.close();
    await stub.stop();
  });
});

describe("client: waiting on the world", () => {
  test("waitForNearby resolves once the cache — not one event — satisfies it", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });

    // A named creature needs two events: the create block and the query answer.
    const pending = client.waitForNearby(
      (o) => o.objectType?.value === "unit" && o.name !== undefined,
      { timeout: 2000 },
    );
    stub.push(JSON.stringify(creatureCreate));
    stub.push(JSON.stringify(creatureQuery));
    const obj = await pending;

    expect(obj.name?.value).toBe("Thistlebore");
    expect(obj.level?.value).toBe(4);
    expect(client.state.closest()?.guid).toBe(obj.guid);

    // Already satisfied: resolves from the cache without another event.
    expect((await client.waitForNearby((o) => o.guid === obj.guid, { timeout: 50 })).guid).toBe(
      obj.guid,
    );
    client.close();
    await stub.stop();
  });

  test("waitForNearby times out rather than inventing an object", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await expect(client.waitForNearby(() => true, { timeout: 30 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
    client.close();
    await stub.stop();
  });
});

describe("client: the two error channels", () => {
  test("a request error is a WrathRequestError of kind request", async () => {
    const stub = startStub({
      routes: { session: () => json({ ok: false, error: "token_in_use" }, 409) },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.createSession({ character: "Fenwick" }).catch((e) => e)) as WrathRequestError;
    expect(err).toBeInstanceOf(WrathRequestError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("token_in_use");
    expect(err.kind).toBe("request");
    await stub.stop();
  });

  test("a synchronous game rejection is kind game, with the result code parsed out", async () => {
    const stub = startStub({
      routes: {
        session: () => json({ ok: false, error: "char_create_failed_code_47", token: "t" }, 502),
      },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.createSession({ character: "Fenwick" }).catch((e) => e)) as WrathRequestError;
    expect(err.kind).toBe("game");
    expect(err.charCreateResultCode).toBe(47);
    expect(err.status).toBe(502);
    await stub.stop();
  });

  test("login_failed and timeout are game-level too", async () => {
    for (const [code, status] of [
      ["login_failed", 502],
      ["timeout", 504],
    ] as const) {
      const stub = startStub({ routes: { session: () => json({ ok: false, error: code }, status) } });
      const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
      const err = (await client.createSession({ character: "F" }).catch((e) => e)) as WrathRequestError;
      expect(err.kind).toBe("game");
      expect(err.code).toBe(code);
      await stub.stop();
    }
  });

  test("an error code this SDK revision does not know still parses", async () => {
    const stub = startStub({
      routes: { action: () => json({ ok: false, error: "some_future_code" }, 400) },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.say("hi").catch((e) => e)) as WrathRequestError;
    expect(err.code).toBe("some_future_code");
    expect(err.kind).toBe("request");
    await stub.stop();
  });

  test("an unreachable module is a transport error", async () => {
    const stub = startStub();
    const port = new URL(stub.baseUrl).port;
    await stub.stop();
    const client = await connect({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      subscribeEvents: false,
      requestTimeoutMs: 500,
    });
    await expect(client.health()).rejects.toBeInstanceOf(WrathTransportError);
  });

  test("a response that does not match the protocol is a transport error", async () => {
    const stub = startStub({ routes: { health: () => json({ ok: true, module: 42 }, 200) } });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await expect(client.health()).rejects.toBeInstanceOf(WrathTransportError);
    await stub.stop();
  });

  test("a non-JSON body is a transport error", async () => {
    const stub = startStub({ routes: { health: () => new Response("<html>", { status: 200 }) } });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await expect(client.health()).rejects.toBeInstanceOf(WrathTransportError);
    await stub.stop();
  });
});

// ------------------------------------------------ quest/combat helper machines
//
// Each of these drives a helper against the stub and pushes the events the
// module would have emitted, so what is under test is the state machine: which
// actions it sends, in which order, and which outcome it settles on.

/** A client already in the world, with our own create block folded in. */
async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

/** Wait until the stub has recorded an action, so a push can follow it. */
async function untilAction(stub: StubServer, action: string, from = 0): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && a.action === action);
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}; saw ${stub.actions.map((a) => a.action).join(",")}`);
}

const combatWorld = () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery]);
const chestWorld = () => frames([...loginSequence, selfCreate, chestCreate]);

describe("client: killTarget", () => {
  test("targets, faces, swings, and settles when the target's health hits zero", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);

    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      refaceIntervalMs: 20,
      pollIntervalMs: 10,
      // Long enough that the re-approach never fires in this test.
      reapproachIntervalMs: 60_000,
      // Wider than the fixture's ~35y gap, so neither approach walks: this
      // test is about the swing loop, not about closing the distance.
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    // A client faces continuously; the module needs telling, or swings miss.
    await Bun.sleep(60);
    stub.push(JSON.stringify(creatureHealth(0, 61)));
    const result = await fight;

    expect(result).toMatchObject({
      ok: true,
      status: "killed",
      guid: CREATURE_GUID,
      swings: 0,
      attacking: false,
    });
    expect(result.detail).toContain("auto-attack stopped");
    const sent = stub.actions.map((a) => a.action);
    expect(sent.slice(0, 3)).toEqual(["set_target", "face", "attack_start"]);
    // Re-faced while swinging, and stopped swinging on the way out.
    expect(sent.filter((a) => a === "face").length).toBeGreaterThan(1);
    expect(sent.at(-1)).toBe("attack_stop");
    expect(stub.actions[0]?.guid).toBe(CREATURE_GUID);

    client.close();
    await stub.stop();
  });

  test("counts our own swings and ignores the ones aimed at us", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify(swing(SELF_GUID, CREATURE_GUID, 62)));
    stub.push(JSON.stringify(swing(CREATURE_GUID, SELF_GUID, 63)));
    stub.push(JSON.stringify(swing(SELF_GUID, CREATURE_GUID, 64)));
    stub.push(JSON.stringify(creatureHealth(0, 65)));
    const result = await fight;
    expect(result.swings).toBe(2);
    client.close();
    await stub.stop();
  });

  test("our own death ends the fight, and says so", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify(selfHealth(0, 66)));
    const result = await fight;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("player_died");
    client.close();
    await stub.stop();
  });

  test("a target that leaves view alive is lost, not killed", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify({ ...creatureOutOfRange, seq: 67 }));
    const result = await fight;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("lost");
    client.close();
    await stub.stop();
  });

  test("a guid the cache never held is not reported as 'target left view alive'", async () => {
    // The old detail claimed a mob "left view alive" for a guid that never
    // named anything observable — a false statement about a fight that never
    // existed. never-seen and genuinely-lost must read differently.
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const result = await client.killTarget("999", { timeout: 5000, pollIntervalMs: 10, meleeRange: 100 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("lost");
    expect(result.detail).toContain("never in view");
    expect(result.detail).not.toContain("left view");
    client.close();
    await stub.stop();
  });

  test("a non-canonical guid string still finds the cached target", async () => {
    // The nearby-cache keys are canonical decimal strings; the caller's guid
    // is canonicalised the same way, so "0<guid>" fights the same mob instead
    // of insta-reporting it lost.
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(`0${CREATURE_GUID}`, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify(creatureHealth(0, 61)));
    const result = await fight;
    expect(result.ok).toBe(true);
    expect(result.status).toBe("killed");
    expect(result.guid).toBe(CREATURE_GUID);
    client.close();
    await stub.stop();
  });

  test("a guid string that does not parse is rejected before any opcode", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await expect(client.killTarget("Kobold Worker")).rejects.toThrow(/neither a decimal guid nor the name of anything in view/);
    expect(stub.actions).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("a UnitView from state.units(...) can be passed straight in (item 3b)", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const unit = client.state.units().find((u) => u.guid === CREATURE_GUID)!;
    expect(unit).toBeDefined();
    const fight = client.killTarget(unit, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify(creatureHealth(0, 61)));
    const result = await fight;
    expect(result.ok).toBe(true);
    expect(result.status).toBe("killed");
    expect(result.guid).toBe(CREATURE_GUID);
    expect(stub.actions[0]?.guid).toBe(CREATURE_GUID);
    client.close();
    await stub.stop();
  });

  test("passing a plain object with no .guid is rejected with a pointer to state.units", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await expect(client.killTarget({ name: "boar" } as never)).rejects.toThrow(
      /killTarget\(guid\).*no usable \.guid.*state\.units/s,
    );
    expect(stub.actions).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("a target that will not die times out as a value, not a throw", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const result = await client.killTarget(CREATURE_GUID, {
      timeout: 60,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    client.close();
    await stub.stop();
  });

  test("a refused face does not end the fight", async () => {
    // The module answers `face` with `409 moving` while a move is running. A
    // real client faces continuously and cannot fail at it, so the loop has to
    // shrug this off — otherwise every fight dies on a re-face tick.
    const stub = startStub({
      onConnect: () => combatWorld(),
      failAction: (action) =>
        action === "face" ? json({ ok: false, error: "moving" }, 409) : undefined,
    });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      refaceIntervalMs: 20,
      pollIntervalMs: 10,
      reapproachIntervalMs: 60_000,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    await Bun.sleep(60);
    stub.push(JSON.stringify(creatureHealth(0, 84)));
    expect((await fight).ok).toBe(true);
    expect(stub.actions.filter((a) => a.action === "face").length).toBeGreaterThan(1);
    client.close();
    await stub.stop();
  });

  test("closes to melee before the first swing, and re-approaches after", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      reapproachIntervalMs: 20,
      meleeRange: 5,
    });
    // The creature is ~35y away in the fixtures, so the walk comes first: a
    // swing from 35 yards is a 0-swing timeout waiting to happen.
    const moveAt = await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveResult("arrived", 1, 68)));
    const attackAt = await untilAction(stub, "attack_start", moveAt);
    expect(attackAt).toBeGreaterThan(moveAt);
    stub.push(JSON.stringify(creatureHealth(0, 69)));
    expect((await fight).ok).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a timeout leaves the character swinging, and says so", async () => {
    // Defect A: the old helper disarmed on the way out of *every* fight,
    // including one both combatants walked out of alive. The server swings from
    // one CMSG_ATTACKSWING until it is cancelled, so cancelling mid-fight is
    // how a character stands there and dies.
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const result = await client.killTarget(CREATURE_GUID, {
      timeout: 60,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    expect(result.status).toBe("timeout");
    expect(result.attacking).toBe(true);
    expect(result.detail).toContain("still auto-attacking");
    expect(stub.actions.map((a) => a.action)).not.toContain("attack_stop");
    client.close();
    await stub.stop();
  });

  test("a lost target also leaves the character swinging", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify({ ...creatureOutOfRange, seq: 90 }));
    const result = await fight;
    expect(result.status).toBe("lost");
    expect(result.attacking).toBe(true);
    expect(stub.actions.map((a) => a.action)).not.toContain("attack_stop");
    client.close();
    await stub.stop();
  });

  test("disengage: true breaks off even when the fight did not end", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const result = await client.killTarget(CREATURE_GUID, {
      timeout: 60,
      pollIntervalMs: 10,
      meleeRange: 100,
      disengage: true,
    });
    expect(result.status).toBe("timeout");
    expect(result.attacking).toBe(false);
    expect(stub.actions.at(-1)?.action).toBe("attack_stop");
    client.close();
    await stub.stop();
  });

  test("abortBelowHealthPct breaks off on our own health, with the numbers", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      meleeRange: 100,
      abortBelowHealthPct: 30,
    });
    await untilAction(stub, "attack_start");
    // The fixture character is 80/100; drop it to 20/100.
    stub.push(JSON.stringify(selfHealth(20, 91)));
    const result = await fight;

    expect(result.ok).toBe(false);
    expect(result.status).toBe("aborted_low_health");
    expect(result.healthPct).toBe(20);
    expect(result.detail).toContain("30% floor");
    // Breaking off is the whole point, so this is the one case that disarms.
    expect(result.attacking).toBe(false);
    expect(stub.actions.at(-1)?.action).toBe("attack_stop");
    client.close();
    await stub.stop();
  });

  test("an unobserved health never trips the low-health abort", async () => {
    // No self create block in this world, so `state.self.health` is undefined —
    // which must not read as 0%.
    const stub = startStub({ onConnect: () => frames([...loginSequence, creatureCreate, creatureQuery]) });
    const client = await inWorld(stub);
    const result = await client.killTarget(CREATURE_GUID, {
      timeout: 60,
      pollIntervalMs: 10,
      meleeRange: 100,
      abortBelowHealthPct: 90,
    });
    expect(result.status).toBe("timeout");
    expect(result.healthPct).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("a mid-fight ATTACKSTOP from the server is re-armed", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      refaceIntervalMs: 60_000,
      reapproachIntervalMs: 60_000,
      meleeRange: 100,
    });
    const first = await untilAction(stub, "attack_start");
    // Ours, we are not dead, and the victim is still the target: swing again.
    stub.push(JSON.stringify(attackStopped(SELF_GUID, CREATURE_GUID, false, 92)));
    await untilAction(stub, "attack_start", first + 1);
    stub.push(JSON.stringify(creatureHealth(0, 93)));
    expect((await fight).ok).toBe(true);
    client.close();
    await stub.stop();
  });

  test("an ATTACKSTOP that is not ours, or names another victim, is ignored", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      refaceIntervalMs: 60_000,
      reapproachIntervalMs: 60_000,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify(attackStopped(CREATURE_GUID, SELF_GUID, false, 94)));
    stub.push(JSON.stringify(attackStopped(SELF_GUID, PLAYER_GUID, false, 95)));
    stub.push(JSON.stringify(attackStopped(SELF_GUID, CREATURE_GUID, true, 96)));
    await Bun.sleep(60);
    expect(stub.actions.filter((a) => a.action === "attack_start")).toHaveLength(1);
    stub.push(JSON.stringify(creatureHealth(0, 97)));
    expect((await fight).ok).toBe(true);
    client.close();
    await stub.stop();
  });
});

describe("client: chests", () => {
  test("interact on a chest is refused with the way that works", async () => {
    const stub = startStub({ onConnect: () => chestWorld() });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CHEST_GUID, { timeout: 2000 });
    const res = await client.interact(CHEST_GUID);
    expect(res).toMatchObject({ ok: false, status: "chest" });
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toContain("lootCorpse");
    expect(stub.actions.map((a) => a.action)).not.toContain("interact");
    client.close();
    await stub.stop();
  });

  test("lootCorpse on a chest casts the Opening ladder, then empties the window the client's way", async () => {
    const stub = startStub({ onConnect: () => chestWorld() });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CHEST_GUID, { timeout: 2000 });
    const pending = client.lootCorpse(CHEST_GUID, { timeout: 2000 });
    // Open Kneeling (6478) first; the lock is a plain "Open" (5), so the
    // server refuses it before the cast starts and the ladder moves on.
    const first = await untilAction(stub, "cast_spell");
    expect(stub.actions[first]).toMatchObject({ action: "cast_spell", spellId: 6478, targetGuid: CHEST_GUID });
    stub.push(JSON.stringify(castFailed(70, 6478)));
    const second = await untilAction(stub, "cast_spell", first + 1);
    expect(stub.actions[second]).toMatchObject({ action: "cast_spell", spellId: 3365, targetGuid: CHEST_GUID });
    stub.push(JSON.stringify(chestLootResponse(71, 25)));
    await untilAction(stub, "loot_release");
    stub.push(JSON.stringify(itemPushed(72)));
    stub.push(JSON.stringify(lootRelease(73)));
    const loot = await pending;
    expect(loot).toMatchObject({ ok: true, status: "looted", gold: 25, items: [{ itemId: ITEM_ENTRY, count: 1 }] });
    // The auto-loot sequence is sent from the SDK: no loot_all (CMSG_LOOT is
    // dropped for a game object guid), one store per slot, money, release.
    const after = stub.actions.slice(second + 1).map((a) => a.action);
    expect(after).toEqual(["loot_item", "loot_money", "loot_release"]);
    expect(stub.actions.map((a) => a.action)).not.toContain("loot_all");
    client.close();
    await stub.stop();
  });

  test("a chest no open-hand spell fits is not_opened, with the last refusal", async () => {
    const stub = startStub({ onConnect: () => chestWorld() });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CHEST_GUID, { timeout: 2000 });
    const pending = client.lootCorpse(CHEST_GUID, { timeout: 2000 });
    let from = 0;
    for (const [i, spellId] of [6478, 3365, 6247, 6477].entries()) {
      from = (await untilAction(stub, "cast_spell", from)) + 1;
      stub.push(JSON.stringify(castFailed(80 + i, spellId)));
    }
    const loot = await pending;
    expect(loot).toMatchObject({ ok: false, status: "not_opened", reason: 12, items: [] });
    expect(stub.actions.filter((a) => a.action === "cast_spell")).toHaveLength(4);
    client.close();
    await stub.stop();
  });

  test("a refusal other than bad-targets ends the ladder at once", async () => {
    const stub = startStub({ onConnect: () => chestWorld() });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CHEST_GUID, { timeout: 2000 });
    const pending = client.lootCorpse(CHEST_GUID, { timeout: 2000 });
    await untilAction(stub, "cast_spell");
    stub.push(JSON.stringify(castFailed(70, 6478, 45))); // SPELL_FAILED_MOVING
    const loot = await pending;
    expect(loot).toMatchObject({ ok: false, status: "not_opened", reason: 45 });
    expect(stub.actions.filter((a) => a.action === "cast_spell")).toHaveLength(1);
    client.close();
    await stub.stop();
  });
});

describe("client: lootCorpse", () => {
  test("an emptied corpse reports what was actually stored", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    // Solo loot: the window slot arrives as LOOT_SLOT_TYPE_OWNER (4).
    stub.push(JSON.stringify(lootResponse(70)));
    stub.push(JSON.stringify(itemPushed(71)));
    stub.push(JSON.stringify(lootRelease(72)));
    const loot = await pending;
    expect(loot.ok).toBe(true);
    expect(loot.gold).toBe(37);
    expect(loot.items).toEqual([{ itemId: ITEM_ENTRY, count: 1 }]);
    client.close();
    await stub.stop();
  });

  test("a push that trails the release is still counted", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    stub.push(JSON.stringify(lootResponse(70, 0))); // ALLOW_LOOT counts too
    stub.push(JSON.stringify(lootRelease(71)));
    stub.push(JSON.stringify(itemPushed(72)));
    const loot = await pending;
    expect(loot).toMatchObject({ ok: true, status: "looted", items: [{ itemId: ITEM_ENTRY, count: 1 }] });
    client.close();
    await stub.stop();
  });

  test("a window whose items never reach the bag is not a success", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 300 });
    await untilAction(stub, "loot_all");
    stub.push(JSON.stringify(lootResponse(70)));
    stub.push(JSON.stringify(lootRelease(71)));
    // No SMSG_ITEM_PUSH_RESULT ever arrives: bags full, or a broken replay.
    const loot = await pending;
    expect(loot.ok).toBe(false);
    if (loot.ok || loot.status !== "none_stored") throw new Error(`unexpected ${loot.status}`);
    expect(loot.items).toEqual([]);
    expect(loot.window.map((i) => i.itemId)).toEqual([ITEM_ENTRY]);
    expect(loot.gold).toBe(37);
    client.close();
    await stub.stop();
  });

  test("group-only slot types are not expected to be stored", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    stub.push(JSON.stringify(lootResponse(70, 3))); // LOCKED: shown, never auto-stored
    stub.push(JSON.stringify(lootRelease(71)));
    const loot = await pending;
    // Nothing was expected, so nothing missing: gold-only success, no items.
    expect(loot).toMatchObject({ ok: true, status: "looted", gold: 37, items: [] });
    client.close();
    await stub.stop();
  });

  test("a corpse with nothing on it is an answer, not a failure", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    stub.push(JSON.stringify(lootRelease(72)));
    const loot = await pending;
    expect(loot).toEqual({ ok: false, status: "empty", gold: 0, items: [] });
    client.close();
    await stub.stop();
  });

  test("silence is neither, and throws", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await expect(client.lootCorpse(CREATURE_GUID, { timeout: 40 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
    client.close();
    await stub.stop();
  });
});

describe("client: quests", () => {
  test("acceptQuestFrom reads the quest list out of a gossip menu", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.acceptQuestFrom(CREATURE_GUID, QUEST_ID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    // A gossip-flagged questgiver answers with SMSG_GOSSIP_MESSAGE, not
    // SMSG_QUESTGIVER_QUEST_LIST, and the quests ride along inside it.
    stub.push(JSON.stringify(gossipWithQuests([QUEST_ID, OTHER_QUEST_ID], 73)));
    await untilAction(stub, "quest_accept");
    stub.push(JSON.stringify({ ...(questAccepted as object), seq: 74 }));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ status: "accepted", questId: QUEST_ID });
    expect(client.state.quest(QUEST_ID)?.questId).toBe(QUEST_ID);
    client.close();
    await stub.stop();
  });

  test("acceptQuestFrom reads the plain questgiver list too", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.acceptQuestFrom(CREATURE_GUID, QUEST_ID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    stub.push(JSON.stringify(questGiverList([QUEST_ID], 75)));
    await untilAction(stub, "quest_accept");
    stub.push(JSON.stringify({ ...(questAccepted as object), seq: 76 }));
    expect((await pending).ok).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a quest a turn-in chain already added is not asked for again", async () => {
    const stub = startStub({ onConnect: () => [...combatWorld(), JSON.stringify(questAccepted)] });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 30, { timeout: 2000 });
    const result = await client.acceptQuestFrom(CREATURE_GUID, QUEST_ID, { timeout: 2000 });
    expect(result).toMatchObject({ ok: true, status: "already_in_log" });
    expect(stub.actions.map((a) => a.action)).not.toContain("quest_list");
    client.close();
    await stub.stop();
  });

  test("a questgiver that does not offer it says what it did offer", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.acceptQuestFrom(CREATURE_GUID, QUEST_ID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    stub.push(JSON.stringify(gossipWithQuests([OTHER_QUEST_ID], 77)));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("not_offered");
    expect(result.offered.map((q) => q.questId)).toEqual([OTHER_QUEST_ID]);
    client.close();
    await stub.stop();
  });

  test("turnInQuest chooses a reward and reports the XP the server granted", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.turnInQuest(CREATURE_GUID, QUEST_ID, 0, { timeout: 2000 });
    await untilAction(stub, "quest_complete");
    stub.push(JSON.stringify(offerReward(QUEST_ID, 78)));
    await untilAction(stub, "quest_choose_reward");
    stub.push(JSON.stringify(questRewarded(QUEST_ID, 79)));
    const result = await pending;
    expect(result).toEqual({ ok: true, status: "complete", questId: QUEST_ID, xp: 400, money: 250 });
    client.close();
    await stub.stop();
  });

  test("a completable REQUEST_ITEMS goes straight to the reward choice", async () => {
    // Re-asking with quest_complete gets REQUEST_ITEMS again forever on
    // item-delivery quests (roster-opus-20260822): the reward is chosen
    // directly from the completable answer.
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.turnInQuest(CREATURE_GUID, QUEST_ID, 0, { timeout: 2000 });
    await untilAction(stub, "quest_complete");
    stub.push(JSON.stringify(requestItems(QUEST_ID, true, 80)));
    await untilAction(stub, "quest_choose_reward");
    stub.push(JSON.stringify(questRewarded(QUEST_ID, 82)));
    expect((await pending).ok).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a reward that does not fit is inventory_full, not a timeout", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.turnInQuest(CREATURE_GUID, QUEST_ID, 0, { timeout: 2000 });
    await untilAction(stub, "quest_complete");
    stub.push(JSON.stringify(offerReward(QUEST_ID, 84)));
    await untilAction(stub, "quest_choose_reward");
    // The server refuses the hand-over: no QUEST_COMPLETE ever comes.
    stub.push(JSON.stringify(inventoryChangeFailure(85)));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== "inventory_full") throw new Error(`unexpected ${result.status}`);
    expect(result.result).toBe(48);
    expect(result.hint).toContain("free a bag slot");
    client.close();
    await stub.stop();
  });

  test("a questgiver refusing an unfinished quest is a value", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.turnInQuest(CREATURE_GUID, QUEST_ID, 0, { timeout: 2000 });
    await untilAction(stub, "quest_complete");
    stub.push(JSON.stringify(requestItems(QUEST_ID, false, 83)));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "not_complete", questId: QUEST_ID });
    if (result.ok || result.status !== "not_complete") throw new Error(`unexpected ${result.status}`);
    expect(result.hint).toContain("unfinished");
    client.close();
    await stub.stop();
  });

  test("a grossly out-of-range questgiver fails fast as too_far", async () => {
    // The server silently ignores an out-of-range quest_complete; without the
    // pre-check the call burns its whole timeout (roster-opus-20260822).
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const FAR_GUID = "17365880163140632599";
    const far = structuredClone(creatureCreate);
    (far.data.objects[0] as { guid: string }).guid = FAR_GUID;
    (far.data.objects[0] as { pos: { x: number } }).pos.x = -1100.0; // ~134y off
    far.seq = 90;
    stub.push(JSON.stringify(far));
    await Bun.sleep(20);
    const result = await client.turnInQuest(FAR_GUID, QUEST_ID, 0, { timeout: 2000 });
    expect(result).toMatchObject({ ok: false, status: "too_far", questId: QUEST_ID });
    if (result.ok || result.status !== "too_far") throw new Error(`unexpected ${result.status}`);
    expect(result.hint).toContain("moveTo");
    expect(stub.actions.some((a) => a.action === "quest_complete")).toBe(false);
    client.close();
    await stub.stop();
  });

  test("a turn-in timeout quotes the distance and rules range out when it is close", async () => {
    // laguna-s-2.1 stood 0.1y from the *giver* of quest 783 (McBride ends it)
    // and re-read "the NPC may be out of interact range" for 135 turns. The
    // SDK knows the distance locally, so the message stops offering range as a
    // live possibility when it is not one.
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const NEAR_GUID = "17365880163140632777";
    const self = client.state.self.position?.value;
    if (!self) throw new Error("no login position");
    const near = structuredClone(creatureCreate);
    (near.data.objects[0] as { guid: string }).guid = NEAR_GUID;
    (near.data.objects[0] as { pos: { x: number; y: number; z: number } }).pos = {
      ...(near.data.objects[0] as { pos: { x: number; y: number; z: number; o: number } }).pos,
      x: self.x + 0.8,
      y: self.y,
      z: self.z,
    };
    near.seq = 91;
    stub.push(JSON.stringify(near));
    await Bun.sleep(20);

    const err = (await client
      .turnInQuest(NEAR_GUID, QUEST_ID, 0, { timeout: 150 })
      .catch((e: unknown) => e)) as Error & { distance?: number };
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect(err.message).toContain("distance: 0.8y");
    expect(err.message).toContain("range is NOT the cause");
    expect(err.message).toContain(`does not end quest ${QUEST_ID}`);
    expect(err.message).toContain("search_reference");
    expect(err.distance).toBe(0.8);
    client.close();
    await stub.stop();
  });

  test("a quest-list timeout quotes the distance and says to close it when it is far", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await Bun.sleep(20);
    const err = (await client
      .questsAvailableFrom(CREATURE_GUID, { timeout: 150 })
      .catch((e: unknown) => e)) as Error & { distance?: number };
    expect(err).toBeInstanceOf(EventTimeoutError);
    // creatureCreate stands ~35y from the login position.
    expect(err.message).toMatch(/distance: 3\d(\.\d+)?y/);
    expect(err.message).toContain("interact range is ~5y");
    expect(err.message).toContain("move to the NPC first");
    expect(err.distance).toBeGreaterThan(30);
    client.close();
    await stub.stop();
  });

  test("a refusal while the log says complete names the wrong questgiver", async () => {
    // roster-sonnet-20260822: three not_completes against a log that said
    // complete:true — the honest status is that another NPC ends this quest.
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questAccepted));
    stub.push(JSON.stringify(questComplete));
    await Bun.sleep(20); // let the state cache apply the log updates
    const pending = client.turnInQuest(CREATURE_GUID, QUEST_ID, 0, { timeout: 2000 });
    await untilAction(stub, "quest_complete");
    stub.push(JSON.stringify(requestItems(QUEST_ID, false, 84)));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "wrong_questgiver", questId: QUEST_ID });
    if (result.ok || result.status !== "wrong_questgiver") throw new Error(`unexpected ${result.status}`);
    expect(result.hint).toContain("different NPC");
    client.close();
    await stub.stop();
  });

  test("waitForQuestObjective settles on the quest log's own completion bit", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questAccepted));
    const pending = client.waitForQuestObjective(QUEST_ID, { timeout: 2000 });
    // Kill credit alone must not settle it: no QUESTUPDATE_COMPLETE arrives for
    // a kill objective at the pinned commit, and ADD_KILL is not the log.
    stub.push(JSON.stringify(addKill));
    stub.push(JSON.stringify(questProgress));
    stub.push(JSON.stringify(questComplete));
    const quest = await pending;
    expect(quest.questId).toBe(QUEST_ID);
    expect(quest.complete).toBe(true);
    expect(quest.counts).toEqual([3, 5, 7, 9]);
    client.close();
    await stub.stop();
  });

  test("an objective that never completes throws rather than inventing a status", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questAccepted));
    await expect(client.waitForQuestObjective(QUEST_ID, { timeout: 40 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
    client.close();
    await stub.stop();
  });
});

describe("client: questsAvailableFrom", () => {
  test("reads the offer out of a gossip menu", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.questsAvailableFrom(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    stub.push(JSON.stringify(gossipWithQuests([QUEST_ID, OTHER_QUEST_ID], 91)));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.quests.map((q) => q.questId)).toEqual([QUEST_ID, OTHER_QUEST_ID]);
    expect(result.quests[0]?.title).toBe(`fixture quest ${QUEST_ID}`);
    expect(result.quests[0]?.icon).toBe(2);
    client.close();
    await stub.stop();
  });

  test("reads the plain questgiver list too", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.questsAvailableFrom(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    stub.push(JSON.stringify(questGiverList([QUEST_ID], 92)));
    const result = await pending;
    expect(result.quests.map((q) => q.questId)).toEqual([QUEST_ID]);
    client.close();
    await stub.stop();
  });

  test("an empty offer is an answer, not an error", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.questsAvailableFrom(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    stub.push(JSON.stringify(gossipWithQuests([], 93)));
    const result = await pending;
    expect(result).toEqual({ ok: true, quests: [] });
    client.close();
    await stub.stop();
  });

  test("silence throws rather than reporting an empty offer", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await expect(
      client.questsAvailableFrom(CREATURE_GUID, { timeout: 40 }),
    ).rejects.toBeInstanceOf(EventTimeoutError);
    client.close();
    await stub.stop();
  });
});

describe("client: trainers", () => {
  test("trainerList derives learnable and affordable per spell", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    // Coinage is a self-only PRIVATE field; it only exists once observed.
    stub.push(JSON.stringify(selfProgress)); // money 12345
    await Bun.sleep(20);
    const pending = client.trainerList(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "trainer_list");
    stub.push(
      JSON.stringify(
        trainerList([
          { spellId: 100, state: 0, cost: 100 },
          { spellId: 200, state: 0, cost: 999_999 },
          { spellId: 300, state: 1, cost: 10 },
          { spellId: 400, state: 2, cost: 10 },
        ]),
      ),
    );
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.trainerType).toBe(0);
    expect(result.spells.map((s) => s.learnable)).toEqual([true, true, false, false]);
    expect(result.spells.map((s) => s.affordable)).toEqual([true, false, true, true]);
    // The wire fields survive untouched alongside the derived ones.
    expect(result.spells[0]).toMatchObject({ spellId: 100, cost: 100, reqLevel: 4, reqSkill: 0 });
    client.close();
    await stub.stop();
  });

  test("affordable is undefined while money is unobserved, never guessed", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    expect(client.state.money).toBeUndefined();
    const pending = client.trainerList(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "trainer_list");
    stub.push(JSON.stringify(trainerList([{ spellId: 100, state: 0, cost: 100 }])));
    const result = await pending;
    expect(result.spells[0]?.affordable).toBeUndefined();
    expect(result.spells[0]?.learnable).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a trainer list for another NPC does not answer this one", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.trainerList(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "trainer_list");
    stub.push(JSON.stringify(trainerList([{ spellId: 1, state: 0, cost: 1 }], 63, SELF_GUID)));
    stub.push(JSON.stringify(trainerList([{ spellId: 100, state: 0, cost: 5 }], 64)));
    const result = await pending;
    expect(result.spells.map((s) => s.spellId)).toEqual([100]);
    client.close();
    await stub.stop();
  });

  test("a silent trainer times out with what was awaited", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const err = await client.trainerList(CREATURE_GUID, { timeout: 40 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect((err as EventTimeoutError).waitingFor).toContain("SMSG_TRAINER_LIST");
    client.close();
    await stub.stop();
  });

  test("buySpell reports the spell the server said it taught", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.buySpell(CREATURE_GUID, 100, { timeout: 2000 });
    await untilAction(stub, "trainer_buy_spell");
    // A verdict for a different spell must not settle this one.
    stub.push(JSON.stringify(trainerBuySucceeded(999, 65)));
    stub.push(JSON.stringify(trainerBuySucceeded(100, 66)));
    expect(await pending).toEqual({ ok: true, status: "learned", spellId: 100 });
    client.close();
    await stub.stop();
  });

  test("a refusal is a value carrying the server's reason and a hint", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.buySpell(CREATURE_GUID, 100, { timeout: 2000 });
    await untilAction(stub, "trainer_buy_spell");
    stub.push(JSON.stringify(trainerBuyFailed(100, 1, 67)));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("buy_failed");
    expect(result.reason).toBe(1);
    expect(result.hint).toContain("not enough money");
    expect(result.hint).toContain("trainerList");
    client.close();
    await stub.stop();
  });

  test("an unknown reason code still reports the number", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.buySpell(CREATURE_GUID, 100, { timeout: 2000 });
    await untilAction(stub, "trainer_buy_spell");
    stub.push(JSON.stringify(trainerBuyFailed(100, 77, 68)));
    const result = await pending;
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe(77);
    expect(result.hint).toContain("reason 77");
    client.close();
    await stub.stop();
  });

  test("no verdict at all throws rather than inventing one", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const err = await client.buySpell(CREATURE_GUID, 100, { timeout: 40 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect((err as EventTimeoutError).waitingFor).toContain("SMSG_TRAINER_BUY_SUCCEEDED");
    client.close();
    await stub.stop();
  });
});

describe("client: equipItem", () => {
  // A world where backpack slot 23 holds the fixture item, named and all.
  const bagWorld = () =>
    frames([...loginSequence, selfCreate, inventorySlot, itemCreate, itemQuery]);

  test("an item that reaches an equipment slot is equipped, with the slot it landed in", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    // 15 is EQUIPMENT_SLOT_MAINHAND: the item leaves the backpack for it.
    stub.push(JSON.stringify(inventorySlotMove(70, BACKPACK_SLOT, 15)));
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      status: "equipped",
      bag: 255,
      slot: BACKPACK_SLOT,
      itemId: ITEM_ENTRY,
      name: "Gritstone Charm",
      equippedSlot: 15,
    });
    client.close();
    await stub.stop();
  });

  test("a refusal is not ok: it carries the server's InventoryResult and a hint", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    // 8 is EQUIP_ERR_NO_REQUIRED_PROFICIENCY — the paladin-with-an-axe refusal
    // that fleet-nav-probe-sonnet-20260822-c3 saw reported as ok: true.
    stub.push(JSON.stringify(inventoryChangeFailure(71, 8)));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("not_equipped");
    if (result.status !== "not_equipped") throw new Error("unreachable");
    expect(result.reason).toBe(8);
    expect(result.hint).toContain("proficiency");
    expect(result.hint).toContain("Gritstone Charm");
    expect(result.hint).toContain(`bag 255 slot ${BACKPACK_SLOT}`);
    client.close();
    await stub.stop();
  });

  test("a level refusal reports the level the server named", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    stub.push(JSON.stringify(inventoryChangeFailure(72, 1, { requiredLevel: 6 })));
    const result = await pending;
    if (result.ok || result.status !== "not_equipped") throw new Error("unreachable");
    expect(result.reason).toBe(1);
    expect(result.requiredLevel).toBe(6);
    expect(result.hint).toContain("needs level 6");
    client.close();
    await stub.stop();
  });

  test("an unknown code still reports the number", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    stub.push(JSON.stringify(inventoryChangeFailure(73, 99)));
    const result = await pending;
    if (result.ok || result.status !== "not_equipped") throw new Error("unreachable");
    expect(result.reason).toBe(99);
    expect(result.hint).toContain("InventoryResult 99");
    client.close();
    await stub.stop();
  });

  test("another item's refusal does not settle this equip", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    // A background loot's bag-full names a different item guid: not our answer.
    stub.push(JSON.stringify(inventoryChangeFailure(74, 50, { itemGuid: "12345" })));
    stub.push(JSON.stringify(inventorySlotMove(75, BACKPACK_SLOT, 15)));
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.equippedSlot).toBe(15);
    client.close();
    await stub.stop();
  });

  test("an item that only leaves the backpack still counts as equipped", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    // The equipment slot's own field was not seen, only the backpack emptying.
    stub.push(JSON.stringify(inventorySlotCleared(76, BACKPACK_SLOT)));
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.equippedSlot).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("a bag-to-bag shuffle is not an equip", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 200 });
    await untilAction(stub, "equip_item");
    stub.push(JSON.stringify(inventorySlotMove(77, BACKPACK_SLOT, BACKPACK_SLOT + 1)));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("unconfirmed");
    client.close();
    await stub.stop();
  });

  test("a refusal is recorded for the harness, not only returned", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const pending = client.equipItem(255, BACKPACK_SLOT, { timeout: 2000 });
    await untilAction(stub, "equip_item");
    // 60 is EQUIP_ERR_NOT_IN_COMBAT — the code a run reverse-engineered from
    // context because nothing ever named it (item 101a).
    stub.push(JSON.stringify(inventoryChangeFailure(78, 60)));
    const result = await pending;
    if (result.ok || result.status !== "not_equipped") throw new Error("unreachable");
    expect(result.hint).toContain("not while in combat");
    const drained = client.drainActionHints();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.action).toBe("equipItem");
    expect(drained[0]!.status).toBe("not_equipped");
    expect(drained[0]!.hint).toContain("not while in combat");
    // Drained means drained: a second read is empty.
    expect(client.drainActionHints()).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("an unconfirmed equip is recorded for the harness too", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const result = await client.equipItem(255, BACKPACK_SLOT, { timeout: 60 });
    expect(result.ok).toBe(false);
    const drained = client.drainActionHints();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.status).toBe("unconfirmed");
    client.close();
    await stub.stop();
  });

  test("silence is unconfirmed, not success", async () => {
    const stub = startStub({ onConnect: () => bagWorld() });
    const client = await inWorld(stub);
    const result = await client.equipItem(255, BACKPACK_SLOT, { timeout: 60 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("unconfirmed");
    expect(result.hint).toContain("state.bag()");
    client.close();
    await stub.stop();
  });
});

describe("inventoryResultText", () => {
  test("names the codes runs actually hit, and stays silent on the rest", () => {
    // Spot checks against the pinned core's Item.h EQUIP_ERR_* list.
    expect(inventoryResultText(60)).toBe("not while in combat");
    expect(inventoryResultText(50)).toBe("your bags are full");
    expect(inventoryResultText(1)).toContain("level is too low");
    expect(inventoryResultText(8)).toContain("proficiency");
    expect(inventoryResultText(88)).toContain("talent");
    // OK, NONE and the enum's gap carry no client string, so neither do we,
    // and an out-of-range code is never guessed at.
    expect(inventoryResultText(0)).toBeUndefined();
    expect(inventoryResultText(59)).toBeUndefined();
    expect(inventoryResultText(83)).toBeUndefined();
    expect(inventoryResultText(999)).toBeUndefined();
  });

  test("every named code is a short sentence, never advice", () => {
    for (let code = 1; code <= 89; code++) {
      const text = inventoryResultText(code);
      if (text === undefined) continue;
      expect(text.length).toBeLessThanOrEqual(120);
      expect(text).not.toContain("InventoryResult");
    }
  });
});

describe("client: deleteCharacter", () => {
  test("retries past the core's silent window until the delete lands", async () => {
    const stub = startStub({
      // The module answers 504 while the core still tracks an offline session.
      characterDelete: (attempt, body) =>
        attempt < 2
          ? json({ ok: false, error: "timeout", token: body.token }, 504)
          : json({ ok: true, token: body.token, character: body.character, deleted: true }, 200),
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const res = await client.deleteCharacter("Fenwick", { account: "PROBE", retryDelayMs: 5 });
    expect(res.deleted).toBe(true);
    expect(stub.characterDeletes).toHaveLength(3);
    // A fresh token per attempt: the parked session of a timed-out attempt may
    // still be holding the previous one.
    expect(new Set(stub.characterDeletes.map((d) => d.token)).size).toBe(3);
    expect(stub.characterDeletes[0]?.account).toBe("PROBE");
    await stub.stop();
  });

  test("a real refusal is not retried", async () => {
    const stub = startStub({
      characterDelete: () => json({ ok: false, error: "character_not_found" }, 400),
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await expect(client.deleteCharacter("Nobody", { retryDelayMs: 5 })).rejects.toBeInstanceOf(
      WrathRequestError,
    );
    expect(stub.characterDeletes).toHaveLength(1);
    await stub.stop();
  });

  test("giving up is a transport error naming the character", async () => {
    const stub = startStub({
      characterDelete: () => json({ ok: false, error: "timeout" }, 504),
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client
      .deleteCharacter("Fenwick", { attempts: 3, retryDelayMs: 5 })
      .catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(WrathTransportError);
    expect(err.message).toContain("Fenwick");
    expect(stub.characterDeletes).toHaveLength(3);
    await stub.stop();
  });
});

describe("guids are opaque decimal strings: guid arguments at the client surface", () => {
  test("a model-conjured bigint is repaired to the wire's decimal string", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await client.setTarget(BigInt(CREATURE_GUID) as unknown as string);
    expect(stub.actions[0]).toMatchObject({ action: "set_target", guid: CREATURE_GUID });
    expect(typeof stub.actions[0]?.guid).toBe("string");
    await stub.stop();
  });

  test("killTarget returns its guid as the same opaque string, JSON-serialisable", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, {
      timeout: 5000,
      pollIntervalMs: 10,
      reapproachIntervalMs: 60_000,
      meleeRange: 100,
    });
    await untilAction(stub, "attack_start");
    stub.push(JSON.stringify(creatureHealth(0, 61)));
    const result = await fight;
    expect(result.status).toBe("killed");
    expect(result.guid).toBe(CREATURE_GUID);
    expect(typeof result.guid).toBe("string");
    expect(() => JSON.stringify(result)).not.toThrow();
    client.close();
    await stub.stop();
  });
});

describe("client: flight master window and activateTaxi (item 38 N3)", () => {
  const TS = 1_700_000_000_000;
  const menu = (seq: number, withTaxi = true): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_GOSSIP_MESSAGE",
      opcodeId: 0x17d,
      ts: TS + seq,
      data: {
        guid: CREATURE_GUID,
        menuId: 4360,
        textId: 100,
        options: withTaxi
          ? [{ optionId: 0, icon: 2, text: "I need a ride." }, { optionId: 1, icon: 0, text: "Tell me about the city." }]
          : [{ optionId: 1, icon: 0, text: "Tell me about the city." }],
        quests: [],
      },
    });
  const window = (seq: number): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_SHOWTAXINODES",
      opcodeId: 0x1a9,
      ts: TS + seq,
      data: {
        showWindow: true,
        guid: CREATURE_GUID,
        currentNode: 6,
        currentNodeName: "Ironforge, Dun Morogh",
        mask: [0xa0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        known: [{ nodeId: 6, name: "Ironforge, Dun Morogh" }, { nodeId: 8, name: "Thelsamar, Loch Modan" }],
      },
    });
  const reply = (seq: number, code: number): string =>
    JSON.stringify({ seq, opcode: "SMSG_ACTIVATETAXIREPLY", opcodeId: 0x1ae, ts: TS + seq, data: { reply: code, ok: code === 0 } });

  test("showTaxiNodes: hello, the taxi option by icon, then the window", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.showTaxiNodes(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello");
    stub.push(menu(300));
    const at = await untilAction(stub, "gossip_select");
    expect(stub.actions[at]).toMatchObject({ action: "gossip_select", guid: CREATURE_GUID, menuId: 4360, optionId: 0 });
    stub.push(window(301));
    const w = await pending;
    expect(w.current).toEqual({ nodeId: 6, name: "Ironforge, Dun Morogh" });
    expect(w.known.map((n) => n.nodeId)).toEqual([6, 8]);
    client.close();
    await stub.stop();
  });

  test("showTaxiNodes: a master with nothing else to say sends the window straight from the hello", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.showTaxiNodes(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello");
    stub.push(window(310));
    const w = await pending;
    expect(w.current.nodeId).toBe(6);
    expect(stub.actions.some((a) => a.action === "gossip_select")).toBe(false);
    client.close();
    await stub.stop();
  });

  test("showTaxiNodes: a menu without a taxi option throws and lists the options", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.showTaxiNodes(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello");
    stub.push(menu(320, false));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("no taxi option");
    expect((err as Error).message).toContain("Tell me about the city.");
    client.close();
    await stub.stop();
  });

  test("activateTaxi: sends the window's current node and the resolved destination, and reads the reply", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(window(330));
    await client.events.waitForOpcode("SMSG_SHOWTAXINODES", { timeout: 2000 });
    const pending = client.activateTaxi(CREATURE_GUID, "thelsamar", { timeout: 2000 });
    const at = await untilAction(stub, "raw");
    const guidHex = BigInt(CREATURE_GUID).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
    expect(stub.actions[at]).toMatchObject({ action: "raw", opcode: "CMSG_ACTIVATETAXI", payload: `${guidHex}0600000008000000` });
    stub.push(reply(331, 0));
    expect(await pending).toEqual({
      ok: true,
      status: "accepted",
      reply: 0,
      from: { nodeId: 6, name: "Ironforge, Dun Morogh" },
      to: { nodeId: 8, name: "Thelsamar, Loch Modan" },
    });
    client.close();
    await stub.stop();
  });

  test("activateTaxi: a refusal is a value with the server's code and a hint, and is recorded for the harness", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(window(340));
    await client.events.waitForOpcode("SMSG_SHOWTAXINODES", { timeout: 2000 });
    const pending = client.activateTaxi(CREATURE_GUID, 8, { timeout: 2000 });
    await untilAction(stub, "raw");
    stub.push(reply(341, 3));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("refused");
    expect(result.reply).toBe(3);
    expect(result.hint).toContain("not enough money");
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "activateTaxi", status: "refused", count: 1 });
    client.close();
    await stub.stop();
  });

  test("activateTaxi: no window observed, an unknown name, or an ambiguous one throws before anything is sent", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const none = await client.activateTaxi(CREATURE_GUID, 7).catch((e: unknown) => e);
    expect((none as Error).message).toContain("showTaxiNodes");
    stub.push(window(350));
    await client.events.waitForOpcode("SMSG_SHOWTAXINODES", { timeout: 2000 });
    const unknown = await client.activateTaxi(CREATURE_GUID, "Stormwind").catch((e: unknown) => e);
    expect((unknown as Error).message).toContain("Thelsamar");
    const notKnown = await client.activateTaxi(CREATURE_GUID, 9).catch((e: unknown) => e);
    expect((notKnown as Error).message).toContain("not in the window");
    const ambiguous = await client.activateTaxi(CREATURE_GUID, "o").catch((e: unknown) => e);
    expect((ambiguous as Error).message).toContain("matches 2 nodes");
    expect(stub.actions.some((a) => a.action === "raw")).toBe(false);
    client.close();
    await stub.stop();
  });
});

describe("client: bindAtInnkeeper (item 38 N2)", () => {
  const TS = 1_700_000_000_000;
  const menu = (seq: number): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_GOSSIP_MESSAGE",
      opcodeId: 0x17d,
      ts: TS + seq,
      data: {
        guid: CREATURE_GUID,
        menuId: 345,
        textId: 100,
        options: [
          { optionId: 0, icon: 0, text: "Trick or Treat!" },
          { optionId: 2, icon: 5, text: "Make this inn your home." },
          { optionId: 3, icon: 1, text: "Let me browse your goods." },
        ],
        quests: [],
      },
    });
  const confirm = (seq: number): string =>
    JSON.stringify({ seq, opcode: "SMSG_BINDER_CONFIRM", opcodeId: 0x2eb, ts: TS + seq, data: { guid: CREATURE_GUID } });
  const bound = (seq: number): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_BINDPOINTUPDATE",
      opcodeId: 0x155,
      ts: TS + seq,
      data: { x: -4840.7, y: -857.1, z: 502, map: 0, areaId: 1537, areaName: "Ironforge" },
    });

  test("hello, the home option, the confirm answered with CMSG_BINDER_ACTIVATE, the new bind point", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.bindAtInnkeeper(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello");
    stub.push(menu(400));
    const sel = await untilAction(stub, "gossip_select");
    expect(stub.actions[sel]).toMatchObject({ action: "gossip_select", guid: CREATURE_GUID, menuId: 345, optionId: 2 });
    stub.push(confirm(401));
    const rawAt = await untilAction(stub, "raw");
    const guidHex = BigInt(CREATURE_GUID).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
    expect(stub.actions[rawAt]).toMatchObject({ action: "raw", opcode: "CMSG_BINDER_ACTIVATE", payload: guidHex });
    stub.push(bound(402));
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      status: "bound",
      bindPoint: { map: 0, x: -4840.7, y: -857.1, z: 502, area: { id: 1537, name: "Ironforge" } },
    });
    expect(client.state.self.bindPoint?.value.area.name).toBe("Ironforge");
    client.close();
    await stub.stop();
  });

  test("an explicit option is resolved against the open menu; a menu without a home option throws", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.bindAtInnkeeper(CREATURE_GUID, { timeout: 2000, option: "browse" });
    await untilAction(stub, "gossip_hello");
    stub.push(menu(410));
    const sel = await untilAction(stub, "gossip_select");
    expect(stub.actions[sel]).toMatchObject({ optionId: 3 });
    // No confirm ever comes for a vendor option: the absence is a timeout, not an outcome.
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTimeoutError);
    client.close();
    await stub.stop();
  });
});

describe("client: gossipSelect by observed option text (item 3c)", () => {
  const gossipMenu = (seq: number): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_GOSSIP_MESSAGE",
      opcodeId: 0x17d,
      ts: 1_700_000_000_000 + seq,
      data: {
        guid: CREATURE_GUID,
        menuId: 7,
        textId: 100,
        options: [
          { optionId: 1, icon: 0, text: "Train me" },
          { optionId: 2, icon: 0, text: "Make me a Guild Master" },
          { optionId: 3, icon: 0, text: "I want to train in a new skill" },
        ],
        quests: [],
      },
    });
  const gossipComplete = (seq: number): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_GOSSIP_COMPLETE",
      opcodeId: 0x17e,
      ts: 1_700_000_000_000 + seq,
      data: {},
    });

  async function withMenu() {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(gossipMenu(200));
    await client.events.waitForOpcode("SMSG_GOSSIP_MESSAGE", { timeout: 2000 });
    return { stub, client };
  }

  test("resolves an exact option text to its optionId and the menu's menuId", async () => {
    const { stub, client } = await withMenu();
    await client.gossipSelect(CREATURE_GUID, "Train me");
    const sent = stub.actions.at(-1)!;
    expect(sent.action).toBe("gossip_select");
    expect(sent).toMatchObject({ guid: CREATURE_GUID, menuId: 7, optionId: 1 });
    client.close();
    await stub.stop();
  });

  test("resolves a unique substring, case-insensitively", async () => {
    const { stub, client } = await withMenu();
    await client.gossipSelect(CREATURE_GUID, "guild master");
    expect(stub.actions.at(-1)).toMatchObject({ menuId: 7, optionId: 2 });
    client.close();
    await stub.stop();
  });

  test("an ambiguous substring rejects with both matching texts and dispatches nothing", async () => {
    const { stub, client } = await withMenu();
    const before = stub.actions.length;
    await expect(client.gossipSelect(CREATURE_GUID, "train")).rejects.toThrow(
      /Train me[\s\S]*I want to train in a new skill|I want to train in a new skill[\s\S]*Train me/,
    );
    expect(stub.actions.length).toBe(before);
    client.close();
    await stub.stop();
  });

  test("an unmatched text rejects with the option list", async () => {
    const { stub, client } = await withMenu();
    await expect(client.gossipSelect(CREATURE_GUID, "nonsense")).rejects.toThrow(/no option.*matches.*Train me/s);
    client.close();
    await stub.stop();
  });

  test("a numeric option uses the menu's menuId and must be on the menu", async () => {
    const { stub, client } = await withMenu();
    await client.gossipSelect(CREATURE_GUID, 2);
    expect(stub.actions.at(-1)).toMatchObject({ menuId: 7, optionId: 2 });
    await expect(client.gossipSelect(CREATURE_GUID, 9)).rejects.toThrow(/no option 9/);
    client.close();
    await stub.stop();
  });

  test("the raw menuId+optionId form is unchanged", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    // No menu observed, yet the raw form still dispatches: it does not consult the fold.
    await client.gossipSelect(CREATURE_GUID, 42, 3);
    expect(stub.actions.at(-1)).toMatchObject({ action: "gossip_select", menuId: 42, optionId: 3 });
    client.close();
    await stub.stop();
  });

  test("with no menu open, the by-text form rejects with a pointer to gossipHello", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await expect(client.gossipSelect(CREATURE_GUID, "Train me")).rejects.toThrow(
      /no gossip menu.*gossipHello/s,
    );
    client.close();
    await stub.stop();
  });

  test("a gossip complete closes the menu, so a later by-text select rejects", async () => {
    const { stub, client } = await withMenu();
    stub.push(gossipComplete(201));
    await client.events.waitForOpcode("SMSG_GOSSIP_COMPLETE", { timeout: 2000 });
    await expect(client.gossipSelect(CREATURE_GUID, "Train me")).rejects.toThrow(/no gossip menu/);
    client.close();
    await stub.stop();
  });
});

// ------------------------------------------------ client-parity queries (27/28)

describe("client: questgiver status and quest query, issued the way a client does", () => {
  /** A questgiver-flagged create block for a fresh guid, near our own position. */
  function questGiverCreate(guid: string, seq: number, fields: Record<string, number> = { npcFlags: 2 }) {
    const block = structuredClone(creatureCreate);
    (block.data.objects[0] as { guid: string }).guid = guid;
    (block.data.objects[0] as { fields: Record<string, number> }).fields = { entry: 823, ...fields };
    block.seq = seq;
    return block;
  }
  const GIVER = "17365880163140632801";
  const GUARD = "17365880163140632802";

  test("a questgiver-flagged unit coming into view is queried once; a guard is not", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questGiverCreate(GIVER, 91)));
    stub.push(JSON.stringify(questGiverCreate(GUARD, 92, { npcFlags: 0 })));
    const at = await untilAction(stub, "questgiver_status_query");
    expect(stub.actions[at]).toMatchObject({ action: "questgiver_status_query", guid: GIVER });
    await Bun.sleep(200);
    expect(stub.actions.filter((a) => a.action === "questgiver_status_query")).toHaveLength(1);
    // The answer folds onto the unit.
    stub.push(JSON.stringify(questGiverStatus(GIVER, 8, 93)));
    await Bun.sleep(20);
    expect(client.state.units({ questGiver: "available" }).map((r) => r.guid)).toEqual([GIVER]);
    client.close();
    await stub.stop();
  });

  test("a questgiver gameobject is queried too; a status already in the burst suppresses the query", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const GO = "17365880163140632803";
    stub.push(JSON.stringify(questGiverCreate(GO, 91, { goType: 2 })));
    // The login STATUS_MULTIPLE names GIVER in the same burst as its create.
    stub.push(JSON.stringify(questGiverCreate(GIVER, 92)));
    stub.push(JSON.stringify(questGiverStatusMultiple([{ guid: GIVER, status: 10 }], 93)));
    await untilAction(stub, "questgiver_status_query");
    await Bun.sleep(200);
    const sent = stub.actions.filter((a) => a.action === "questgiver_status_query").map((a) => a.guid);
    expect(sent).toEqual([GO]);
    expect(client.state.units({ questGiver: "reward" }).map((r) => r.guid)).toEqual([GIVER]);
    client.close();
    await stub.stop();
  });

  test("a unit that leaves view and returns is queried again", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questGiverCreate(GIVER, 91)));
    await untilAction(stub, "questgiver_status_query");
    const gone = structuredClone(creatureOutOfRange) as { seq: number; data: { objects: { guids: string[] }[] } };
    gone.seq = 92;
    gone.data.objects[0]!.guids = [GIVER];
    stub.push(JSON.stringify(gone));
    await Bun.sleep(20);
    stub.push(JSON.stringify(questGiverCreate(GIVER, 93)));
    await untilAction(stub, "questgiver_status_query", 1);
    expect(stub.actions.filter((a) => a.action === "questgiver_status_query")).toHaveLength(2);
    client.close();
    await stub.stop();
  });

  test("a quest entering the log is queried once; completion refreshes every marker; re-accept re-queries", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    // The login fold of the (empty) quest log does not ask for markers: the
    // core sends STATUS_MULTIPLE unprompted at login.
    await Bun.sleep(200);
    expect(stub.actions.map((a) => a.action)).not.toContain("questgiver_status_multiple_query");

    stub.push(JSON.stringify(questAccepted));
    const q = await untilAction(stub, "quest_query");
    expect(stub.actions[q]).toMatchObject({ action: "quest_query", questId: QUEST_ID });
    await untilAction(stub, "questgiver_status_multiple_query");
    stub.push(JSON.stringify(questQueryResponse()));
    await Bun.sleep(20);
    expect(client.state.quest(QUEST_ID)?.title).toBe("Kobold Camp Cleanup");

    // Counters moving do not refresh markers; the complete bit does.
    const before = stub.actions.length;
    stub.push(JSON.stringify(questProgress));
    await Bun.sleep(200);
    expect(stub.actions.length).toBe(before);
    stub.push(JSON.stringify(questComplete));
    await untilAction(stub, "questgiver_status_multiple_query", before);
    expect(stub.actions.filter((a) => a.action === "quest_query")).toHaveLength(1);

    // Abandon (slot emptied) then re-accept: the template is cached, so no
    // second quest_query — but the marker refresh fires for each log change.
    const empty = structuredClone(questAccepted) as { seq: number; data: { objects: { fields: Record<string, number> }[] } };
    empty.seq = 40;
    empty.data.objects[0]!.fields = { quest0Id: 0, quest0State: 0 };
    stub.push(JSON.stringify(empty));
    await Bun.sleep(200);
    const re = structuredClone(questAccepted) as { seq: number };
    re.seq = 41;
    stub.push(JSON.stringify(re));
    await Bun.sleep(200);
    expect(stub.actions.filter((a) => a.action === "quest_query")).toHaveLength(1);
    expect(client.state.quest(QUEST_ID)?.objectives).toHaveLength(4);
    client.close();
    await stub.stop();
  });

  test("a turn-in silence names the observed marker when it is not `reward`", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const self = client.state.self.position?.value;
    if (!self) throw new Error("no login position");
    const near = questGiverCreate(GIVER, 91);
    (near.data.objects[0] as { pos: { x: number; y: number; z: number; o: number } }).pos = { x: self.x + 0.8, y: self.y, z: self.z, o: 0 };
    stub.push(JSON.stringify(near));
    stub.push(JSON.stringify(questGiverStatus(GIVER, 8, 92)));
    await Bun.sleep(20);
    const err = (await client.turnInQuest(GIVER, QUEST_ID, 0, { timeout: 150 }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect(err.message).toContain("range is NOT the cause");
    expect(err.message).toContain("questgiver status is `available`, not `reward`");
    expect(err.message).toContain(`not quest ${QUEST_ID}'s ender`);
    expect(err.message).toContain('state.units({ questGiver: "reward" })');
    client.close();
    await stub.stop();
  });

  test("a `none` marker answers a quest list before it is sent; no marker means the silence says nothing", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questGiverStatus(CREATURE_GUID, 0, 91)));
    await Bun.sleep(20);
    // 2026-08-30: the marker is the server's own answer, received before the
    // call, so a 10s EventTimeoutError would only confirm it — a value instead.
    const none = await client.questsAvailableFrom(CREATURE_GUID, { timeout: 150 });
    expect(none).toMatchObject({ ok: false, status: "nothing_on_offer", quests: [] });
    if (none.ok) throw new Error("unreachable");
    expect(none.hint).toContain("questgiver status is `none`");
    expect(none.hint).toContain("Nothing was sent");
    expect(stub.actions.map((a) => a.action)).not.toContain("quest_list");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "questsAvailableFrom", status: "nothing_on_offer" });
    const bare = (await client.questsAvailableFrom(PLAYER_GUID, { timeout: 150 }).catch((e: unknown) => e)) as Error;
    expect(bare.message).not.toContain("questgiver status");
    client.close();
    await stub.stop();
  });

  test("the raw queries are on the client for a caller who wants one now", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    await client.questQuery(QUEST_ID);
    await client.questGiverStatusQuery(CREATURE_GUID);
    await client.questGiverStatusQuery();
    expect(stub.actions.map((a) => a.action)).toEqual([
      "quest_query",
      "questgiver_status_query",
      "questgiver_status_multiple_query",
    ]);
    expect(stub.actions[0]).toMatchObject({ questId: QUEST_ID });
    expect(stub.actions[1]).toMatchObject({ guid: CREATURE_GUID });
    client.close();
    await stub.stop();
  });
});

describe("client: talents and the raw escape hatch (item 39)", () => {
  const talentsInfo = (seq: number, talents: { talentId: number; rank: number }[], unspent = 0) =>
    JSON.stringify({
      seq,
      opcode: "SMSG_TALENTS_INFO",
      opcodeId: 0x4c0,
      ts: 1_700_000_000_000 + seq,
      data: { pet: false, unspentPoints: unspent, specCount: 1, activeSpec: 0, specs: [{ talents }] },
    });

  test("learnTalent reads the verdict off the SMSG_TALENTS_INFO answer", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.learnTalent(42, 0, { timeout: 2000 });
    const at = await untilAction(stub, "learn_talent");
    expect(stub.actions[at]).toMatchObject({ action: "learn_talent", talentId: 42, rank: 0 });
    stub.push(talentsInfo(60, [{ talentId: 42, rank: 0 }]));
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.talents.talents).toEqual([{ talentId: 42, rank: 0 }]);

    const refused = client.learnTalent(43, 1, { timeout: 2000 });
    await untilAction(stub, "learn_talent", at + 1);
    stub.push(talentsInfo(61, [{ talentId: 42, rank: 0 }], 0));
    const r2 = await refused;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.hint).toContain("unspentPoints is 0");
    await stub.stop();
  });

  test("raw packs a field list little-endian and sends the allowlisted opcode by name", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const ack = await client.raw("CMSG_TEXT_EMOTE", [
      { u32: 0x0102 },
      { u8: 7 },
      { guid: "4294967296" }, // 0x1_0000_0000
      { packedGuid: "4294967296" },
      { cstring: "hi" },
      { i32: -1 },
      { u16: 0xabcd },
      { bytes: "ff" },
    ]);
    expect(ack.opcode).toBe("CMSG_TEXT_EMOTE");
    expect(ack.payload).toBe("02010000" + "07" + "0000000001000000" + "1001" + "686900" + "ffffffff" + "cdab" + "ff");
    expect(stub.actions.at(-1)).toMatchObject({ action: "raw", opcode: "CMSG_TEXT_EMOTE", payload: ack.payload });

    // Bodiless, hex, and bytes forms.
    expect((await client.raw("CMSG_GROUP_DISBAND")).payload).toBe("");
    expect((await client.raw("CMSG_GROUP_DISBAND", "ABCD")).payload).toBe("abcd");
    expect((await client.raw("CMSG_GROUP_DISBAND", Uint8Array.from([1, 255]))).payload).toBe("01ff");
    await stub.stop();
  });

  test("raw rejects a non-opcode name and a malformed payload before anything is sent", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const before = stub.actions.length;
    expect(() => client.raw("say", "")).toThrow(/CMSG_\* \(or bidirectional MSG_\*\) name/);
    expect(() => client.raw("CMSG_EMOTE", "abc")).toThrow(/hex string/);
    expect(() => client.raw("CMSG_EMOTE", [{ u8: 300 }])).toThrow(/payload/);
    expect(() => client.raw("CMSG_EMOTE", [{ u9: 3 } as never])).toThrow(/field/);
    expect(stub.actions.length).toBe(before);
    await stub.stop();
  });

  test("the module's raw refusals render hints", async () => {
    const stub = startStub({
      onConnect: () => combatWorld(),
      failAction: (a) =>
        a === "raw" ? json({ ok: false, error: "opcode_not_allowed", action: "raw", opcode: "CMSG_EMOTE" }, 400) : undefined,
    });
    const client = await inWorld(stub);
    const err = await client.raw("CMSG_EMOTE", [{ u32: 1 }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WrathRequestError);
    expect((err as WrathRequestError).message).toContain("allowlist");
    await stub.stop();
  });
});

describe("client: reclaimCorpse owns the delay and answers with a verdict", () => {
  /** Login plus our own create block, then whatever health this world needs. */
  const deadWorld = (health: number, extra: readonly unknown[] = []) =>
    frames([...loginSequence, selfCreate, selfHealth(health, 90), ...extra]);

  test("a ghost whose delay has already elapsed reclaims, and says so", async () => {
    // A delay announced 60s ago: nothing left to wait out, so it dispatches now.
    const stub = startStub({
      onConnect: () => deadWorld(1, [corpseReclaimDelay(30_000, 91, Date.now() - 60_000)]),
    });
    const client = await inWorld(stub);
    const pending = client.reclaimCorpse(undefined, { timeout: 4000, attemptTimeout: 1500 });
    await untilAction(stub, "reclaim_corpse");
    stub.push(JSON.stringify(deathReleaseCleared(92)));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.status).toBe("reclaimed");
    expect(result.attempts).toBe(1);
    expect(result.delayMs).toBe(30_000);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    client.close();
    await stub.stop();
  });

  test("health leaving the ghost's 1 confirms a reclaim on its own", async () => {
    const stub = startStub({ onConnect: () => deadWorld(1) });
    const client = await inWorld(stub);
    const pending = client.reclaimCorpse(undefined, { timeout: 4000, attemptTimeout: 1500 });
    await untilAction(stub, "reclaim_corpse");
    stub.push(JSON.stringify(selfHealth(20, 93)));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.status).toBe("reclaimed");
    client.close();
    await stub.stop();
  });

  test("the announced delay is waited out before anything is dispatched", async () => {
    const stub = startStub({
      onConnect: () => deadWorld(1, [corpseReclaimDelay(400, 91, Date.now())]),
    });
    const client = await inWorld(stub);
    const started = Date.now();
    const pending = client.reclaimCorpse(undefined, { timeout: 4000, attemptTimeout: 1500 });
    await untilAction(stub, "reclaim_corpse");
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(300);
    stub.push(JSON.stringify(deathReleaseCleared(94)));
    expect((await pending).ok).toBe(true);
    client.close();
    await stub.stop();
  });

  test("no delay event at all means dispatch now, not a made-up 30s wait", async () => {
    const stub = startStub({ onConnect: () => deadWorld(1) });
    const client = await inWorld(stub);
    const started = Date.now();
    const pending = client.reclaimCorpse(undefined, { timeout: 4000, attemptTimeout: 1500 });
    await untilAction(stub, "reclaim_corpse");
    expect(Date.now() - started).toBeLessThan(1000);
    stub.push(JSON.stringify(deathReleaseCleared(95)));
    const result = await pending;
    expect(result.status).toBe("reclaimed");
    expect(result.delayMs).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("a silent refusal with nothing else observed is re-sent, and reported once as still_ghost", async () => {
    const stub = startStub({ onConnect: () => deadWorld(1) });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse(undefined, { timeout: 700, attemptTimeout: 150 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("not_reclaimed");
    expect(result.reason).toBe("still_ghost");
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.hint).toContain("39y");
    expect(result.hint).toContain("spiritHealerActivate");
    expect(result.hint).not.toMatch(/\d+ reclaims went out/);
    client.close();
    await stub.stop();
  });

  test("a ghost far from its corpse is told too_far with the distance, the radius and the healer's price", async () => {
    // Died at the create-block position, released 387y away; the corpse query
    // confirms the corpse at the death spot. Level 3: no sickness at that level.
    const stub = startStub({
      onConnect: () =>
        deadWorld(1, [
          corpseQuery(91, { map: 0, x: -1234.5, y: 987.25, z: 42.125 }),
          selfArrived(92, { x: -1234.5 + 387, y: 987.25, z: 42.125 }),
        ]),
    });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse(undefined, { timeout: 500, attemptTimeout: 120 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("too_far");
    expect(result.distance).toBe(387);
    expect(result.radius).toBe(39);
    expect(result.corpse?.source).toBe("corpse_query");
    expect(result.hint).toContain("387y");
    expect(result.hint).toContain("moveTo(state.self.corpse.value)");
    expect(result.hint).toContain("25% durability");
    expect(result.hint).toContain("no resurrection sickness at your level");
    client.close();
    await stub.stop();
  });

  test("a corpse on another map is wrong_map, and no corpse at all is no_corpse", async () => {
    const other = startStub({
      onConnect: () => deadWorld(1, [corpseQuery(91, { map: 1, x: 10, y: 10, z: 10 })]),
    });
    const c1 = await inWorld(other);
    const r1 = await c1.reclaimCorpse(undefined, { timeout: 400, attemptTimeout: 120 });
    if (r1.ok) throw new Error("unreachable");
    expect(r1.reason).toBe("wrong_map");
    expect(r1.hint).toContain("map 1");
    c1.close();
    await other.stop();

    const none = startStub({ onConnect: () => deadWorld(1, [corpseQuery(91)]) });
    const c2 = await inWorld(none);
    const r2 = await c2.reclaimCorpse(undefined, { timeout: 400, attemptTimeout: 120 });
    if (r2.ok) throw new Error("unreachable");
    expect(r2.reason).toBe("no_corpse");
    expect(r2.hint).toContain("spiritHealerActivate");
    c2.close();
    await none.stop();
  });

  test("a delay still running after the dispatches is delay_not_elapsed with the seconds left", async () => {
    // Delay announced 29s ago of 30s: the first pass waits ~1s, but the budget
    // is shorter, so one attempt goes out at most and the delay is still the cause.
    const stub = startStub({
      onConnect: () => deadWorld(1, [corpseReclaimDelay(30_000, 91, Date.now() - 29_700)]),
    });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse(undefined, { timeout: 200, attemptTimeout: 50 });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("delay_not_elapsed");
    expect(result.secondsLeft).toBe(1);
    client.close();
    await stub.stop();
  });

  test("a corpse still unreleased is named, and nothing is sent", async () => {
    const stub = startStub({ onConnect: () => deadWorld(0) });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_released");
    expect(result.hint).toContain("repop()");
    expect(result.attempts).toBe(0);
    expect(stub.actions.filter((a) => a.action === "reclaim_corpse")).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("a living character is told there is nothing to reclaim", async () => {
    const stub = startStub({ onConnect: () => deadWorld(40) });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_dead");
    expect(stub.actions.filter((a) => a.action === "reclaim_corpse")).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("a delay longer than the budget sends nothing and says how much is left", async () => {
    const stub = startStub({
      onConnect: () => deadWorld(1, [corpseReclaimDelay(30_000, 91, Date.now())]),
    });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse(undefined, { timeout: 300, attemptTimeout: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("delay_not_elapsed");
    expect(result.attempts).toBe(0);
    expect(result.hint).toContain("still to run");
    expect(stub.actions.filter((a) => a.action === "reclaim_corpse")).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("unobserved health with the dispatch out is unconfirmed, not a guess", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence]) });
    const client = await inWorld(stub);
    const result = await client.reclaimCorpse(undefined, { timeout: 400, attemptTimeout: 120 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("unconfirmed");
    expect(result.reason).toBe("no_observation");
    expect(result.hint).toContain("state.self.health");
    client.close();
    await stub.stop();
  });

  test("reclaimCorpseAsync is still the bare dispatch", async () => {
    const stub = startStub({ onConnect: () => deadWorld(1) });
    const client = await inWorld(stub);
    const ack = await client.reclaimCorpseAsync();
    expect(ack.ok).toBe(true);
    expect(stub.actions.at(-1)?.action).toBe("reclaim_corpse");
    client.close();
    await stub.stop();
  });
});

/**
 * `moveTo` taking the thing at the destination, not only the destination
 * (earned surface). The trajectory: the 2026-08-23 navigation fan-out,
 * where 4 of 7 runs threw a raw `TypeError` reading `.x` off a unit lookup that
 * had returned nothing — the model never learned it was the lookup that failed.
 */
describe("client: moveTo target resolution", () => {
  const movePos = (stub: StubServer): { x: number; y: number; z: number } => {
    const move = stub.actions.filter((a) => a.action === "move_to").at(-1) as unknown as {
      x: number;
      y: number;
      z: number;
    };
    return { x: move.x, y: move.y, z: move.z };
  };

  test("a unit and its guid both resolve to the position the state cache holds", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const unit = client.state.units({ entry: CREATURE_ENTRY })[0]!;

    const byUnit = client.moveTo(unit, { timeout: 2000 });
    await untilAction(stub, "move_to");
    expect(movePos(stub)).toEqual({ x: -1200, y: 980, z: 42 });
    // A unit target carries its guid as the module's planning hint (ground-z
    // resolution, PROTOCOL.md move_to); a point (below, in the next test)
    // sends none.
    expect(stub.actions.filter((a) => a.action === "move_to").at(-1)?.guid).toBe(CREATURE_GUID);
    stub.push(JSON.stringify(moveResult("arrived", 1, 30)));
    expect((await byUnit).ok).toBe(true);

    // The guid form reads the cache at call time, so a unit that has moved
    // since is walked to where it is now, not where the caller last saw it.
    stub.push(JSON.stringify(creatureMove));
    await Bun.sleep(20);
    const byGuid = client.moveTo(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "move_to", 1);
    expect(movePos(stub)).toEqual({ x: -1210, y: 985, z: 42 });
    stub.push(JSON.stringify(moveResult("arrived", 2, 31)));
    expect((await byGuid).ok).toBe(true);

    client.close();
    await stub.stop();
  });

  test("a guid nothing in view answers to is a typed verdict, never a TypeError", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);

    const result = await client.moveTo("123456789");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unknown_target");
    expect(result.position).toBeUndefined();
    expect(result.hint).toContain("not in view");
    expect(result.hint).toContain("state.closest(...)");
    // Nothing was dispatched: there was nowhere to walk.
    expect(stub.actions.filter((a) => a.action === "move_to")).toHaveLength(0);

    // The raw tier has no result object to answer in, so it throws — and says
    // which call does answer.
    expect(() => client.moveToAsync("123456789")).toThrow(/unknown_target/);
    // A point is untouched by any of this.
    const walk = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    await untilAction(stub, "move_to");
    expect(stub.actions.filter((a) => a.action === "move_to").at(-1)?.guid).toBeUndefined();
    stub.push(JSON.stringify(moveResult("arrived", 1, 30)));
    expect((await walk).status).toBe("arrived");

    client.close();
    await stub.stop();
  });

  test("a unit that left view walks to the coordinates it carried, and says so", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const unit = client.state.units({ entry: CREATURE_ENTRY })[0]!;
    stub.push(JSON.stringify(creatureOutOfRange));
    await Bun.sleep(20);
    expect(client.state.nearby.has(CREATURE_GUID)).toBe(false);

    const walk = client.moveTo(unit, { timeout: 2000 });
    await untilAction(stub, "move_to");
    expect(movePos(stub)).toEqual({ x: -1200, y: 980, z: 42 });
    stub.push(JSON.stringify(moveResult("arrived", 1, 30)));
    const result = await walk;
    expect(result.ok).toBe(true);
    // Silent wrong behaviour is the one forbidden outcome.
    expect(result.hint).toContain("not in view any more");

    client.close();
    await stub.stop();
  });

  test("the abandon error names the distance covered, the distance left, and moveToAsync", async () => {
    // The 2026-08-23 fan-out: 6 of 7 runs hit the 30s snippet abandon with a
    // moveTo in flight, and one re-issued the identical blocking call 5 times.
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    let current: AbortSignal | undefined;
    const client = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      events: { reconnect: false },
      signal: () => current,
    });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });

    const ac = new AbortController();
    current = ac.signal;
    const walk = client.moveTo({ x: -1000, y: 987.25, z: 42.125 }, { timeout: 5000 });
    await untilAction(stub, "move_to");
    // It got a third of the way before the snippet ran out of time.
    stub.push(JSON.stringify(moveProgress));
    await Bun.sleep(20);
    ac.abort(new Error("snippet abandoned by the harness (timeout)"));

    const err = (await walk.catch((e: unknown) => e)) as Error & { moveAbandon?: string };
    expect(err).toBeInstanceOf(EventAbortedError);
    expect(err.message).toContain("~15y covered");
    expect(err.message).toContain("~220y still to go");
    expect(err.message).toContain("sdk.moveToAsync(target)");
    expect(err.moveAbandon).toContain("still walking when this was abandoned");

    client.close();
    await stub.stop();
  });

  test("a walk longer than the caller's remaining budget says so in the hint, and still walks", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      events: { reconnect: false },
      // The runner passes the instant the snippet will be abandoned.
      deadline: () => Date.now() + 5_000,
    });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });

    const walk = client.moveTo({ x: -1000, y: 987.25, z: 42.125 }, { timeout: 2000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveResult("arrived", 1, 30)));
    const result = await walk;
    // No status change and no cap: the move was issued exactly as asked.
    expect(result.ok).toBe(true);
    expect(result.status).toBe("arrived");
    expect(result.hint).toContain("~235y");
    expect(result.hint).toContain("7yd/s");
    expect(result.hint).toContain("sdk.moveToAsync(target)");

    // A deadline already past is an unknown budget, not a budget of zero: a
    // background routine inherits the launching snippet's deadline and keeps
    // walking legitimately, and telling it to use a background routine would be
    // the remediation contradicting itself.
    const routine = await connect({
      baseUrl: stub.baseUrl,
      token: "t",
      events: { reconnect: false },
      deadline: () => Date.now() - 60_000,
    });
    await routine.createSession({ character: "Fenwick" });
    const leg = routine.moveTo({ x: -1000, y: 987.25, z: 42.125 }, { timeout: 2000 });
    await untilAction(stub, "move_to", 1);
    stub.push(JSON.stringify(moveResult("arrived", 2, 31)));
    // The budget sentence is gone; the caller's own short timeout is still
    // worth saying, and says nothing about budgets.
    const legHint = (await leg).hint ?? "";
    expect(legHint).not.toContain("of its budget left");
    expect(legHint).toContain("often outlasts a timeout that short");
    routine.close();

    // With no deadline known, nothing is said either.
    const quiet = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await quiet.createSession({ character: "Fenwick" });
    const plain = quiet.moveTo({ x: -1000, y: 987.25, z: 42.125 }, { timeout: 2000 });
    await untilAction(stub, "move_to", 2);
    stub.push(JSON.stringify(moveResult("arrived", 3, 32)));
    const plainHint = (await plain).hint ?? "";
    expect(plainHint).not.toContain("of its budget left");
    expect(plainHint).toContain("often outlasts a timeout that short");

    quiet.close();
    client.close();
    await stub.stop();
  });
});

describe("client: queryTalentTree and resetTalents (item 96)", () => {
  const TS = 1_700_000_000_000;
  const tree = (seq: number): string =>
    JSON.stringify({
      seq,
      opcode: "WB_TALENT_TREE",
      opcodeId: 0xff08,
      ts: TS + seq,
      data: {
        class: 1,
        unspentPoints: 1,
        tabs: [{ tabId: 161, name: "Arms", page: 0, talents: [{ talentId: 124, name: "Improved Heroic Strike", row: 0, col: 0, maxRank: 3, ranks: [12282, 12663, 12664] }] }],
      },
    });
  const menu = (seq: number, withUnlearn = true): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_GOSSIP_MESSAGE",
      opcodeId: 0x17d,
      ts: TS + seq,
      data: {
        guid: CREATURE_GUID,
        menuId: 4675,
        textId: 100,
        options: withUnlearn
          ? [{ optionId: 0, icon: 3, text: "I seek training." }, { optionId: 1, icon: 3, text: "I wish to unlearn my talents." }]
          : [{ optionId: 0, icon: 3, text: "I seek training." }],
        quests: [],
      },
    });
  const confirm = (seq: number, cost: number, nothing = false): string =>
    JSON.stringify({
      seq,
      opcode: "MSG_TALENT_WIPE_CONFIRM",
      opcodeId: 0x2aa,
      ts: TS + seq,
      data: { guid: nothing ? "0" : CREATURE_GUID, cost, nothingToReset: nothing },
    });
  const talents = (seq: number, rows: { talentId: number; rank: number }[], unspent: number): string =>
    JSON.stringify({
      seq,
      opcode: "SMSG_TALENTS_INFO",
      opcodeId: 0x4c0,
      ts: TS + seq,
      data: { pet: false, unspentPoints: unspent, specCount: 1, activeSpec: 0, specs: [{ talents: rows }] },
    });

  test("queryTalentTree sends talent_tree and returns the folded tree with learned ranks", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(talents(500, [{ talentId: 124, rank: 0 }], 1));
    await client.events.waitForOpcode("SMSG_TALENTS_INFO", { timeout: 2000 });
    const pending = client.queryTalentTree({ timeout: 2000 });
    const at = await untilAction(stub, "talent_tree");
    expect(stub.actions[at]).toMatchObject({ action: "talent_tree" });
    stub.push(tree(501));
    const t = await pending;
    expect(t.tabs[0]!.name).toBe("Arms");
    expect(t.tabs[0]!.talents[0]).toMatchObject({ talentId: 124, pointsSpent: 1, maxRank: 3 });
    expect(client.state.talentTree()?.seq).toBe(501);
    client.close();
    await stub.stop();
  });

  test("resetTalents: hello, the unlearn option, the confirm echoed raw, the talents packet", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.resetTalents(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello");
    stub.push(menu(510));
    const sel = await untilAction(stub, "gossip_select");
    expect(stub.actions[sel]).toMatchObject({ action: "gossip_select", guid: CREATURE_GUID, menuId: 4675, optionId: 1 });
    stub.push(confirm(511, 10000));
    const rawAt = await untilAction(stub, "raw");
    const guidHex = BigInt(CREATURE_GUID).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
    expect(stub.actions[rawAt]).toMatchObject({ action: "raw", opcode: "MSG_TALENT_WIPE_CONFIRM", payload: guidHex });
    stub.push(talents(512, [], 3));
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.cost).toBe(10000);
    expect(result.talents.unspentPoints).toBe(3);
    expect(result.talents.talents).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("resetTalents: the guid-0 confirm is a refusal value; a menu without the option throws", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const pending = client.resetTalents(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello");
    stub.push(menu(520));
    await untilAction(stub, "gossip_select");
    stub.push(confirm(521, 0, true));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "refused", cost: 0 });
    expect(stub.actions.some((a) => a.action === "raw")).toBe(false);
    expect(client.drainActionHints()[0]).toMatchObject({ action: "resetTalents", status: "refused" });

    const noOption = client.resetTalents(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "gossip_hello", 1);
    stub.push(menu(530, false));
    const noOptionResult = await noOption;
    expect(noOptionResult).toMatchObject({ ok: false, status: "no_option" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "resetTalents", status: "no_option" });
    client.close();
    await stub.stop();
  });
});

describe("client: pet, group, mail and bank helpers (items 98 and 100)", () => {
  const TS = 1_700_000_000_000;
  const PET_GUID = "17365880163140632999";
  const frame = (seq: number, opcode: string, data: unknown): string => JSON.stringify({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
  const guidHex = (g: string) => BigInt(g).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  const u32Hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");
  const petBar = (seq: number) =>
    frame(seq, "SMSG_PET_SPELLS", {
      guid: PET_GUID,
      removed: false,
      family: 0,
      durationMs: 0,
      reactState: 1,
      commandState: 1,
      flags: 0,
      actionBar: [],
      spells: [{ spellId: 3110, active: 0xc1, autocast: true, rank: 1, name: "Firebolt" }],
      cooldowns: [],
    });

  test("petAttack / petFollow / petCast build the CMSG_PET_ACTION button the pet frame sends; no pet throws", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    expect(await client.petFollow()).toMatchObject({ ok: false, status: "no_pet" });
    expect(client.drainActionHints()[0]?.hint).toContain("summon one first");
    stub.push(petBar(500));
    await client.events.waitForOpcode("SMSG_PET_SPELLS", { timeout: 2000 });
    await client.petAttack(CREATURE_GUID);
    let at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ action: "raw", opcode: "CMSG_PET_ACTION", payload: guidHex(PET_GUID) + u32Hex(2 | (0x07 << 24)) + guidHex(CREATURE_GUID) });
    await client.petFollow();
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ payload: guidHex(PET_GUID) + u32Hex(1 | (0x07 << 24)) + guidHex("0") });
    // No packet answers a react or follow/stay button (seen live); the ack folds the bar.
    expect(client.state.pet()?.command).toBe("follow");
    await client.petStay();
    at = await untilAction(stub, "raw", at + 1);
    expect(client.state.pet()?.command).toBe("stay");
    await client.petReact("aggressive");
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ payload: guidHex(PET_GUID) + u32Hex(2 | (0x06 << 24)) + guidHex("0") });
    expect(client.state.pet()?.reaction).toBe("aggressive");
    await client.petCast("fire", CREATURE_GUID);
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ payload: guidHex(PET_GUID) + u32Hex(3110 | (0x81 << 24)) + guidHex(CREATURE_GUID) });
    expect(await client.petCast("Growl")).toMatchObject({ ok: false, status: "unknown_spell" });
    await client.petDismiss();
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ payload: guidHex(PET_GUID) + u32Hex(3 | (0x07 << 24)) + guidHex("0") });
    client.close();
    await stub.stop();
  });

  test("inviteToGroup reads the party result; acceptGroupInvite and leaveGroup wait for the list", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const invite = client.inviteToGroup("Quilby", { timeout: 2000 });
    let at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_GROUP_INVITE", payload: "5175696c62790000000000" });
    stub.push(frame(510, "SMSG_PARTY_COMMAND_RESULT", { operation: 0, name: "Quilby", result: 5, value: 0 }));
    expect(await invite).toMatchObject({ ok: false, status: "refused", result: 5 });
    expect(client.drainActionHints()[0]?.hint).toContain("already in a group");

    expect(client.acceptGroupInvite({ timeout: 2000 })).rejects.toThrow(/no invitation is pending/);
    stub.push(frame(511, "SMSG_GROUP_INVITE", { canAccept: true, inviterName: "Ordrick" }));
    await client.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 2000 });
    const accept = client.acceptGroupInvite({ timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_GROUP_ACCEPT", payload: "00000000" });
    stub.push(
      frame(512, "SMSG_GROUP_LIST", {
        groupType: 0, left: false, raid: false, subGroup: 0, memberFlags: 0, roles: 0, groupGuid: "1", counter: 1,
        members: [{ name: "Ordrick", guid: "9", online: true, subGroup: 0, flags: 0, roles: 0 }], leaderGuid: "9", lootMethod: 0,
      }),
    );
    expect((await accept).inGroup).toBe(true);
    const leave = client.leaveGroup({ timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_GROUP_DISBAND", payload: "" });
    stub.push(frame(513, "SMSG_GROUP_LIST", { groupType: 0x10, left: true, raid: false, subGroup: 0, memberFlags: 0, roles: 0, groupGuid: "1", counter: 2, members: [], leaderGuid: "0" }));
    expect((await leave).inGroup).toBe(false);
    client.close();
    await stub.stop();
  });

  test("openMailbox, sendMail, mailList and takeMailMoney: the frame first, then the bodies and verdicts", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    expect(() => client.mailList()).toThrow(/no mailbox frame/);
    expect(await client.deleteMail(1)).toMatchObject({ ok: false, status: "no_mailbox" });
    const open = client.openMailbox(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "interact");
    let at = await untilAction(stub, "raw");
    // No SMSG_SHOW_MAILBOX: the core sends none for a game-object mailbox; the first list answering is the frame.
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_GET_MAIL_LIST", payload: guidHex(CREATURE_GUID) });
    stub.push(frame(520, "SMSG_MAIL_LIST_RESULT", { total: 0, count: 0, mails: [] }));
    expect((await open).guid).toBe(CREATURE_GUID);

    const send = client.sendMail("Quilby", "hi", "text", { money: 100, timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({
      opcode: "CMSG_SEND_MAIL",
      payload: guidHex(CREATURE_GUID) + "5175696c627900" + "686900" + "7465787400" + u32Hex(41) + u32Hex(0) + "00" + u32Hex(100) + u32Hex(0) + "0000000000000000" + "00",
    });
    stub.push(frame(521, "SMSG_SEND_MAIL_RESULT", { mailId: 0, action: 0, result: 0 }));
    expect(await send).toMatchObject({ ok: true, status: "sent" });

    const list = client.mailList({ timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_GET_MAIL_LIST", payload: guidHex(CREATURE_GUID) });
    stub.push(
      frame(522, "SMSG_MAIL_LIST_RESULT", {
        total: 1, count: 1,
        mails: [{ mailId: 7, type: 0, senderGuid: "9", cod: 0, stationery: 41, money: 100, flags: 0, read: false, daysLeft: 29, templateId: 0, subject: "hi", body: "text", items: [] }],
      }),
    );
    // The sender is a guid the module has never named: the list asks CMSG_NAME_QUERY and joins the answer.
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_NAME_QUERY", payload: guidHex("9") });
    stub.push(frame(523, "SMSG_NAME_QUERY_RESPONSE", { guid: 9, found: true, name: "Ordrick" }));
    expect((await list).mails[0]).toMatchObject({ mailId: 7, money: 100, senderName: "Ordrick" });

    const take = client.takeMailMoney(7, { timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_MAIL_TAKE_MONEY", payload: guidHex(CREATURE_GUID) + u32Hex(7) });
    stub.push(frame(524, "SMSG_SEND_MAIL_RESULT", { mailId: 7, action: 1, result: 6 }));
    expect(await take).toMatchObject({ ok: false, status: "refused", result: 6 });
    client.close();
    await stub.stop();
  });

  test("openBank, bankDeposit (lands in a bank slot) and bankWithdraw (refused by the server)", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, itemQuery]) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const open = client.openBank(CREATURE_GUID, { timeout: 2000 });
    let at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_BANKER_ACTIVATE", payload: guidHex(CREATURE_GUID) });
    stub.push(frame(530, "SMSG_SHOW_BANK", { guid: CREATURE_GUID }));
    expect((await open).guid).toBe(CREATURE_GUID);

    expect(await client.bankDeposit(255, 30)).toMatchObject({ ok: false, status: "no_item" });
    const deposit = client.bankDeposit(255, BACKPACK_SLOT, { timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_AUTOBANK_ITEM", payload: "ff" + BACKPACK_SLOT.toString(16) });
    stub.push(
      frame(531, "SMSG_UPDATE_OBJECT", {
        blocks: 1,
        objects: [{ update: "values", guid: SELF_GUID, fields: { [`invSlot${BACKPACK_SLOT}Lo`]: 0, [`invSlot${BACKPACK_SLOT}Hi`]: 0, invSlot39Lo: ITEM_GUID_LO, invSlot39Hi: ITEM_GUID_HI } }],
      }),
    );
    expect(await deposit).toMatchObject({ ok: true, status: "moved", bag: 255, slot: 39, guid: ITEM_GUID });

    const withdraw = client.bankWithdraw(255, 39, { timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_AUTOSTORE_BANK_ITEM", payload: "ff27" });
    stub.push(frame(532, "SMSG_INVENTORY_CHANGE_FAILURE", { result: 4 }));
    expect(await withdraw).toMatchObject({ ok: false, status: "refused", result: 4 });
    client.close();
    await stub.stop();
  });
});

describe("client: the softened inputs and the harness hints they refuse with (2026-08-29)", () => {
  const TS = 1_700_000_000_000;
  const PET_GUID = "17365880163140632999";
  const frame = (seq: number, opcode: string, data: unknown): string => JSON.stringify({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
  const guidHex = (g: string) => BigInt(g).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  const u32Hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");
  const carried = () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, itemQuery]);

  test("a helper target may be the name of something in view; two matches refuse and list them", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    // Exact name, case-insensitive and whitespace-tolerant.
    await client.interact("  thistlebore ");
    expect(stub.actions.at(-1)).toMatchObject({ action: "interact", guid: CREATURE_GUID });

    // A second unit with a name the query matches makes it two readings.
    stub.push(
      frame(601, "SMSG_UPDATE_OBJECT", {
        blocks: 1,
        objects: [
          {
            update: "create", guid: "17365880163140632777", objectType: "unit", moveFlags: 0, runSpeed: 7.5,
            pos: { x: -1201.0, y: 981.0, z: 42.0, o: 1.5 },
            fields: { entry: 777, health: 10, maxHealth: 10, level: 2, faction: 7, unitFlags: 0, displayId: 1, powerType: 0, power1: 1, maxPower1: 1, race: 0, class: 0, gender: 0 },
          },
        ],
      }),
    );
    stub.push(frame(602, "SMSG_CREATURE_QUERY_RESPONSE", { entry: 777, found: true, name: "Thistlebore Whelp" }));
    await client.events.waitFor((e) => e.seq === 602, { timeout: 2000 });
    await expect(client.killTarget(" thistle ")).rejects.toThrow(/matches 2 things in view/);
    await expect(client.killTarget("nothing here")).rejects.toThrow(/neither a decimal guid nor the name of anything in view/);
    client.close();
    await stub.stop();
  });

  test("moveTo takes a name and answers an unresolvable one as a value with a hint", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    const walk = client.moveTo("Thistlebore", { timeout: 2000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(moveResult("arrived", 1, 700)));
    expect((await walk).ok).toBe(true);
    const miss = await client.moveTo("Ragnaros");
    expect(miss).toMatchObject({ ok: false, status: "unknown_target" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "moveTo", status: "unknown_target" });
    client.close();
    await stub.stop();
  });

  test("an item-taking call takes the item's name; a name that names nothing is a no_item value with a hint", async () => {
    const stub = startStub({ onConnect: () => carried() });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    // The name form leaves argument 2 free, so the options object may sit there.
    const equip = client.equipItem("gritstone", { timeout: 500 });
    const at = await untilAction(stub, "equip_item");
    expect(stub.actions[at]).toMatchObject({ action: "equip_item", bag: 255, slot: BACKPACK_SLOT });
    await equip;
    client.drainActionHints();

    // …and a trailing count keeps its meaning rather than being read as a slot.
    await client.destroyItem("Gritstone Charm", 5);
    expect(stub.actions.at(-1)).toMatchObject({ action: "destroy_item", bag: 255, slot: BACKPACK_SLOT, count: 5 });
    await client.useItem("Gritstone Charm", CREATURE_GUID);
    expect(stub.actions.at(-1)).toMatchObject({ action: "use_item", bag: 255, slot: BACKPACK_SLOT, targetGuid: CREATURE_GUID });

    const missing = await client.equipItem("Thunderfury");
    expect(missing).toMatchObject({ ok: false, status: "no_item" });
    if (!missing.ok && missing.status === "no_item") expect(missing.hint).toContain("Gritstone Charm");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "equipItem", status: "no_item" });
    expect(() => client.useItem("Thunderfury")).toThrow(/nothing in state\.bag\(\) is named/);
    // A numeric bag still needs its slot, and says so instead of guessing one.
    expect(await client.equipItem(255)).toMatchObject({ ok: false, status: "no_item" });
    client.close();
    await stub.stop();
  });

  test("pet refusals are values with hints: no_pet, unknown_reaction, ambiguous_spell, passive_spell", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    expect(await client.petStay()).toMatchObject({ ok: false, status: "no_pet" });
    expect(await client.petReact("berserk")).toMatchObject({ ok: false, status: "unknown_reaction" });
    const early = client.drainActionHints();
    expect(early.map((h) => `${h.action}:${h.status}`).sort()).toEqual(["petReact:unknown_reaction", "petStay:no_pet"]);

    stub.push(
      frame(610, "SMSG_PET_SPELLS", {
        guid: PET_GUID, removed: false, family: 0, durationMs: 0, reactState: 1, commandState: 1, flags: 0, actionBar: [],
        spells: [
          { spellId: 3110, active: 0xc1, autocast: true, rank: 1, name: "Firebolt" },
          { spellId: 3111, active: 0xc1, autocast: false, rank: 2, name: "Firebolt Rank 2" },
          { spellId: 3112, active: 0x01, autocast: false, rank: 1, name: "Demon Armor" },
        ],
        cooldowns: [],
      }),
    );
    await client.events.waitForOpcode("SMSG_PET_SPELLS", { timeout: 2000 });
    // Case-insensitive react words reach the wire.
    expect(await client.petReact("  Aggressive ")).toMatchObject({ ok: true, status: "sent" });
    expect(stub.actions.at(-1)).toMatchObject({ opcode: "CMSG_PET_ACTION", payload: guidHex(PET_GUID) + u32Hex(2 | (0x06 << 24)) + guidHex("0") });
    const ambiguous = await client.petCast("fire");
    expect(ambiguous).toMatchObject({ ok: false, status: "ambiguous_spell" });
    if (!ambiguous.ok) expect(ambiguous.hint).toContain("3111");
    expect(await client.petCast("Demon Armor")).toMatchObject({ ok: false, status: "passive_spell" });
    // The exact name still resolves past the substring tie.
    expect(await client.petCast("Firebolt")).toMatchObject({ ok: true, status: "sent" });
    expect(client.drainActionHints().map((h) => h.status).sort()).toEqual(["ambiguous_spell", "passive_spell"]);
    client.close();
    await stub.stop();
  });

  test("a bank move with no frame open is refused before anything is sent, and hints are labelled per call", async () => {
    const stub = startStub({ onConnect: () => carried() });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const before = stub.actions.length;
    const closed = await client.bankDeposit("Gritstone Charm");
    expect(closed).toMatchObject({ ok: false, status: "no_bank" });
    if (!closed.ok) expect(closed.hint).toContain("openBank");
    expect(stub.actions.length).toBe(before);
    expect(client.drainActionHints()[0]).toMatchObject({ action: "bankDeposit", status: "no_bank" });

    const open = client.openBank(CREATURE_GUID, { timeout: 2000 });
    let at = await untilAction(stub, "raw");
    stub.push(frame(620, "SMSG_SHOW_BANK", { guid: CREATURE_GUID }));
    await open;
    const deposit = client.bankDeposit("gritstone", { timeout: 2000 });
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_AUTOBANK_ITEM", payload: "ff" + BACKPACK_SLOT.toString(16) });
    stub.push(frame(621, "SMSG_INVENTORY_CHANGE_FAILURE", { result: 4 }));
    expect(await deposit).toMatchObject({ ok: false, status: "refused" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "bankDeposit", status: "refused" });
    client.close();
    await stub.stop();
  });

  test("mail refuses without a frame as a value, attaches items by name, and labels its hints per call", async () => {
    const stub = startStub({ onConnect: () => carried() });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    expect(await client.sendMail("Quilby", "s", "b")).toMatchObject({ ok: false, status: "no_mailbox" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "sendMail", status: "no_mailbox" });

    const open = client.openMailbox(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "interact");
    const opened = await untilAction(stub, "raw");
    stub.push(frame(630, "SMSG_MAIL_LIST_RESULT", { total: 0, count: 0, mails: [] }));
    await open;
    const send = client.sendMail("  Quilby ", "s", "b", { items: ["gritstone"], timeout: 2000 });
    const at = await untilAction(stub, "raw", opened + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_SEND_MAIL" });
    // The named attachment resolved to the carried item's guid, indexed 0.
    expect((stub.actions[at] as unknown as { payload: string }).payload).toContain("00" + guidHex(ITEM_GUID));
    stub.push(frame(631, "SMSG_SEND_MAIL_RESULT", { mailId: 0, action: 0, result: 3 }));
    expect(await send).toMatchObject({ ok: false, status: "refused" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "sendMail", status: "refused" });
    expect(await client.sendMail("Quilby", "s", "b", { items: ["Thunderfury"] })).toMatchObject({ ok: false, status: "no_item" });
    client.close();
    await stub.stop();
  });

  test("learnTalent takes a talent by name once the tree is read, and defaults rank to the next point", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    // Without the tree a name cannot be resolved, and the refusal says so.
    expect(await client.learnTalent("Improved Heroic Strike")).toMatchObject({ ok: false, status: "no_tree" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "learnTalent", status: "no_tree" });

    const query = client.queryTalentTree({ timeout: 2000 });
    await untilAction(stub, "talent_tree");
    stub.push(
      frame(640, "WB_TALENT_TREE", {
        class: 1, unspentPoints: 2,
        tabs: [{ tabId: 161, name: "Arms", page: 0, talents: [{ talentId: 124, name: "Improved Heroic Strike", row: 0, col: 0, maxRank: 3, ranks: [12282, 12663, 12664] }] }],
      }),
    );
    await query;
    stub.push(frame(641, "SMSG_TALENTS_INFO", { pet: false, unspentPoints: 2, specCount: 1, activeSpec: 0, specs: [{ talents: [{ talentId: 124, rank: 0 }] }] }));
    await client.events.waitForOpcode("SMSG_TALENTS_INFO", { timeout: 2000 });

    const learn = client.learnTalent("heroic strike", { timeout: 2000 });
    const at = await untilAction(stub, "learn_talent");
    // One point is already in, so the next one is wire rank 1.
    expect(stub.actions[at]).toMatchObject({ action: "learn_talent", talentId: 124, rank: 1 });
    stub.push(frame(642, "SMSG_TALENTS_INFO", { pet: false, unspentPoints: 1, specCount: 1, activeSpec: 0, specs: [{ talents: [{ talentId: 124, rank: 1 }] }] }));
    expect(await learn).toMatchObject({ ok: true, status: "learned", talentId: 124, rank: 1 });
    expect(await client.learnTalent("Bladestorm")).toMatchObject({ ok: false, status: "unknown_talent" });
    client.close();
    await stub.stop();
  });
});

/**
 * METHODOLOGY, "A name in view is a valid referent, with bounded fuzz": the
 * three tiers reach the same unit, a non-exact match says so in the result
 * rather than in a hint, two matches refuse, and nothing guid-shaped is ever
 * fuzzed.
 */
describe("client: a name in view is a referent", () => {
  const namedWorld = () =>
    frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, playerCreate, playerName]);

  test("an exact name acts, and says nothing about resolving — there was nothing to resolve", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const ack = await client.interact("  thistlebore ");
    expect(stub.actions[0]?.guid).toBe(CREATURE_GUID);
    expect(ack).not.toHaveProperty("resolved");
    client.close();
    await stub.stop();
  });

  test("a unique substring acts and the result carries what it landed on", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const ack = await client.interact("thistle");
    expect(stub.actions[0]?.guid).toBe(CREATURE_GUID);
    expect(ack.resolved).toEqual({ input: "thistle", name: "Thistlebore", guid: CREATURE_GUID });
    client.close();
    await stub.stop();
  });

  test("a unique near-miss acts and the result carries what it landed on", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const ack = await client.interact("Thistlebode");
    expect(stub.actions[0]?.guid).toBe(CREATURE_GUID);
    expect(ack.resolved).toEqual({ input: "Thistlebode", name: "Thistlebore", guid: CREATURE_GUID });
    client.close();
    await stub.stop();
  });

  test("a name two things answer to refuses with both, and dispatches nothing", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    // "b" is in both "Thistlebore" and "Quilby".
    expect(() => client.interact("b")).toThrow(/matches 2 things in view.*does not choose between referents/s);
    expect(stub.actions).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("the raw tier takes a name too — setTarget reaches the wire as the guid", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const ack = await client.setTarget("thistle");
    expect(stub.actions.at(-1)).toMatchObject({ action: "set_target", guid: CREATURE_GUID });
    expect(ack.resolved).toEqual({ input: "thistle", name: "Thistlebore", guid: CREATURE_GUID });
    client.close();
    await stub.stop();
  });

  test("sellItem's itemGuid stays strict — an item guid is not a unit in view", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    // The vendor resolves by name; the item does not, because there is no
    // name-to-item-guid namespace to resolve it against — so a name there
    // goes to the module as typed (and is refused there), never rewritten
    // into the guid of a unit standing nearby.
    await client.sellItem("thistle", "thistle");
    expect(stub.actions.at(-1)).toMatchObject({ action: "sell_item", guid: CREATURE_GUID, itemGuid: "thistle" });
    expect(() => client.sellItem("thistle", undefined as never)).toThrow(/sellItem\(\.\.\., itemGuid\)/);
    client.close();
    await stub.stop();
  });

  test("a raw payload's guid field takes a name in view, resolved the same way", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const ack = await client.raw("CMSG_TEXT_EMOTE", [{ u32: 1 }, { guid: "thistle" }]);
    const exact = await client.raw("CMSG_TEXT_EMOTE", [{ u32: 1 }, { guid: "Thistlebore" }]);
    expect(ack.payload).toBe(exact.payload); // the same bytes a guid would have produced
    expect(ack.resolved).toEqual([{ input: "thistle", name: "Thistlebore", guid: CREATURE_GUID }]);
    expect(exact.resolved).toBeUndefined();
    // packedGuid encodes differently (mask + non-zero bytes), so it gets its
    // own end-to-end check rather than riding on the guid one.
    const packed = await client.raw("CMSG_TEXT_EMOTE", [{ packedGuid: "thistle" }]);
    const packedExact = await client.raw("CMSG_TEXT_EMOTE", [{ packedGuid: CREATURE_GUID }]);
    expect(packed.payload).toBe(packedExact.payload);
    client.close();
    await stub.stop();
  });

  test("a raw payload refuses an ambiguous name rather than picking, and sends nothing", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const before = stub.actions.length;
    expect(() => client.raw("CMSG_TEXT_EMOTE", [{ packedGuid: "b" }])).toThrow(/matches 2 things in view/);
    expect(stub.actions).toHaveLength(before);
    client.close();
    await stub.stop();
  });

  test("the rest of a raw payload is left alone — a cstring is not a referent, nor is a u64", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    // "Thistle" as a mail recipient or invite target is a player the server
    // resolves; rewriting it against what is in view would retarget the call.
    const ack = await client.raw("CMSG_TEXT_EMOTE", [{ cstring: "Thistle" }, { u64: "4294967296" }]);
    expect(ack.payload).toBe("54686973746c6500" + "0000000001000000");
    expect(ack.resolved).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("an opcode name is never fuzzed — a near miss goes to the module as typed", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const ack = await client.raw("CMSG_TEXT_EMOT", [{ u32: 1 }]);
    // The module owns the allowlist and answers for it; the SDK must not
    // "correct" the name to the opcode it nearly spells.
    expect(ack.opcode).toBe("CMSG_TEXT_EMOT");
    expect(stub.actions.at(-1)).toMatchObject({ opcode: "CMSG_TEXT_EMOT" });
    client.close();
    await stub.stop();
  });

  test("a guid is never fuzzed — one digit off is that guid, not the unit it nearly names", async () => {
    const stub = startStub({ onConnect: () => namedWorld() });
    const client = await inWorld(stub);
    const nearMiss = `${CREATURE_GUID.slice(0, -1)}9`;
    expect(nearMiss).not.toBe(CREATURE_GUID);
    const ack = await client.interact(nearMiss);
    expect(stub.actions[0]?.guid).toBe(nearMiss);
    expect(ack).not.toHaveProperty("resolved");
    client.close();
    await stub.stop();
  });
});

describe("client: quest-start items and the questgiver marker pre-check (2026-08-30)", () => {
  const TS = 1_700_000_000_000;
  const START_QUEST = 1646;
  const frame = (seq: number, opcode: string, data: unknown): string => JSON.stringify({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
  /** The Gritstone Charm carried, with a tooltip that says it starts a quest. */
  const tome = () =>
    frames([
      ...loginSequence,
      selfCreate,
      creatureCreate,
      creatureQuery,
      inventorySlot,
      itemCreate,
      { ...(itemQuery as object), data: { ...(itemQuery as { data: object }).data, name: "Tome of Divinity", startQuest: START_QUEST } },
    ]);
  const details = (seq: number, guid: string, questId: number) =>
    frame(seq, "SMSG_QUESTGIVER_QUEST_DETAILS", {
      guid,
      questId,
      title: "The Tome of Divinity",
      details: "Read it.",
      objectives: "Speak to someone.",
      choiceRewards: [],
      rewards: [],
      money: 0,
      xp: 0,
    });

  test("useItem on a quest-start item waits for the server's offer and names the item as the questgiver", async () => {
    const stub = startStub({ onConnect: () => tome() });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const pending = client.useItem("Tome of Divinity", undefined, undefined, { timeout: 2000 });
    const at = await untilAction(stub, "use_item");
    expect(stub.actions[at]).toMatchObject({ action: "use_item", bag: 255, slot: BACKPACK_SLOT });
    stub.push(details(90, ITEM_GUID, START_QUEST));
    const used = await pending;
    expect(used.ok).toBe(true);
    expect(used.questOffer).toEqual({ questId: START_QUEST, title: "The Tome of Divinity", itemGuid: ITEM_GUID });

    // Taking it: the item guid stands where an NPC guid would, and there is no
    // quest list to ask for — the details query is the offer.
    const accept = client.acceptQuestFrom(used.questOffer!.itemGuid, START_QUEST, { timeout: 2000 });
    const q = await untilAction(stub, "quest_details");
    expect(stub.actions[q]).toMatchObject({ action: "quest_details", guid: ITEM_GUID, questId: START_QUEST });
    stub.push(details(91, ITEM_GUID, START_QUEST));
    const a = await untilAction(stub, "quest_accept");
    expect(stub.actions[a]).toMatchObject({ action: "quest_accept", guid: ITEM_GUID, questId: START_QUEST });
    stub.push(frame(92, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { quest0Id: START_QUEST, quest0State: 0, quest0CountsLo: 0, quest0CountsHi: 0, quest0Time: 0, quest1Id: 0 } }] }));
    const result = await accept;
    expect(result).toMatchObject({ ok: true, status: "accepted", questId: START_QUEST, title: "The Tome of Divinity" });
    expect(stub.actions.map((x) => x.action)).not.toContain("quest_list");
    client.close();
    await stub.stop();
  });

  test("acceptQuestFrom(itemGuid) refuses a quest the item's tooltip says it does not start", async () => {
    const stub = startStub({ onConnect: () => tome() });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    await expect(client.acceptQuestFrom(ITEM_GUID, OTHER_QUEST_ID, { timeout: 200 })).rejects.toThrow(/starts quest 1646, not 909/);
    expect(stub.actions.map((x) => x.action)).not.toContain("quest_details");
    client.close();
    await stub.stop();
  });

  test("useItem on an ordinary item is the plain ack: nothing is waited for", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, itemQuery]) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const used = await client.useItem("Gritstone Charm");
    expect(used.ok).toBe(true);
    expect(used).not.toHaveProperty("questOffer");
    client.close();
    await stub.stop();
  });

  test("item_not_usable says what is known: no spell and no quest, or a module build that predates quest-start items", async () => {
    const refuse = (a: string) => (a === "use_item" ? json({ ok: false, error: "item_not_usable", action: a }, 400) : undefined);
    const plain = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, itemQuery]), failAction: refuse });
    const c1 = await inWorld(plain);
    await c1.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const e1 = (await c1.useItem("Gritstone Charm").catch((e: unknown) => e)) as WrathRequestError;
    expect(e1).toBeInstanceOf(WrathRequestError);
    expect(e1.message).toContain("no on-use spell and no quest to start");
    expect(e1.message).not.toContain("no on-use effect");
    c1.close();
    await plain.stop();

    const start = startStub({ onConnect: () => tome(), failAction: refuse });
    const c2 = await inWorld(start);
    await c2.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const e2 = (await c2.useItem("Tome of Divinity").catch((e: unknown) => e)) as WrathRequestError;
    expect(e2.message).toContain(`starts quest ${START_QUEST}`);
    expect(e2.message).toContain("predates quest-start items");
    c2.close();
    await start.stop();
  });

  test("acceptQuestFrom on a turn-in-only NPC is nothing_on_offer at once, with the marker's hint and nothing sent", async () => {
    const stub = startStub({ onConnect: () => combatWorld() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(questGiverStatus(CREATURE_GUID, 6, 91))); // reward_rep
    await Bun.sleep(20);
    const before = Date.now();
    const result = await client.acceptQuestFrom(CREATURE_GUID, QUEST_ID, { timeout: 10_000 });
    expect(Date.now() - before).toBeLessThan(1000);
    expect(result).toMatchObject({ ok: false, status: "nothing_on_offer", questId: QUEST_ID, offered: [] });
    if (result.ok || result.status !== "nothing_on_offer") throw new Error("unreachable");
    expect(result.hint).toContain("questgiver status is `reward_rep`");
    expect(stub.actions.map((a) => a.action)).not.toContain("quest_list");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "acceptQuestFrom", status: "nothing_on_offer" });

    // An offering marker still asks, as before.
    stub.push(JSON.stringify(questGiverStatus(CREATURE_GUID, 8, 92))); // available
    await Bun.sleep(20);
    const pending = client.questsAvailableFrom(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "quest_list");
    stub.push(JSON.stringify(questGiverList([QUEST_ID], 93)));
    expect((await pending).quests.map((q) => q.questId)).toEqual([QUEST_ID]);
    client.close();
    await stub.stop();
  });
});
