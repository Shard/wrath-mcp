import { describe, expect, test } from "bun:test";

import { connect, WrathRequestError, WrathTransportError } from "../src/client";
import { EventTimeoutError } from "../src/events";
import {
  addKill,
  attackStopped,
  chatEcho,
  CREATURE_GUID,
  creatureCreate,
  creatureHealth,
  creatureOutOfRange,
  creatureQuery,
  frames,
  gossipWithQuests,
  inventoryChangeFailure,
  ITEM_ENTRY,
  itemPushed,
  loginSequence,
  lootRelease,
  lootResponse,
  moveResult,
  offerReward,
  OTHER_QUEST_ID,
  PLAYER_GUID,
  QUEST_ID,
  questAccepted,
  questComplete,
  questGiverList,
  questProgress,
  questRewarded,
  requestItems,
  SELF_GUID,
  selfCreate,
  selfHealth,
  swing,
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

describe("client: movement", () => {
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

  test("a game-level failure comes back as a result, not an exception", async () => {
    for (const status of ["no_path", "too_far", "interrupted", "stopped", "superseded"] as const) {
      const stub = startStub({ onConnect: () => frames(loginSequence) });
      const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
      await client.createSession({ character: "Fenwick" });

      const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
      stub.push(JSON.stringify(moveResult(status, 1, 30)));
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      // Where the character actually ended up — what the next decision needs.
      expect(result.position.x).toBe(-1205);
      client.close();
      await stub.stop();
    }
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
    await expect(client.killTarget("Kobold Worker")).rejects.toThrow(/killTarget\(guid\).*decimal guid string/s);
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

describe("ADR-0017: guid arguments at the client surface", () => {
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
