/**
 * `unstuck()`: the stock client's Help → "I'm stuck", confirmed by calling it
 * twice (operator decision, 2026-10-28). Every frame is hand-written from
 * module/PROTOCOL.md's tables with invented names and positions.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { frames, loginSequence, SELF_GUID, selfCreate, teleportAck } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const STUCK = 7355;
const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", { spells: [{ spellId: 503, rank: 1, name: "Grim Jab" }], cooldowns: [] });
const ghostFlags = (seq: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 1, playerFlags: 0x10 } }] });

// A Hearthstone (item 6948) in the first backpack slot.
const HEARTH_LO = 5150;
const HEARTH_HI = 0x4000_0000;
const HEARTH_GUID = ((BigInt(HEARTH_HI) << 32n) | BigInt(HEARTH_LO)).toString();
const hearthSlot = frame(30, "SMSG_UPDATE_OBJECT", {
  blocks: 1,
  objects: [{ update: "values", guid: SELF_GUID, fields: { invSlot23Lo: HEARTH_LO, invSlot23Hi: HEARTH_HI } }],
});
const hearthCreate = frame(31, "SMSG_UPDATE_OBJECT", {
  blocks: 1,
  objects: [{ update: "create", guid: HEARTH_GUID, objectType: "item", fields: { entry: 6948, stackCount: 1 } }],
});

const spellStart = (seq: number) => frame(seq, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId: STUCK, castTimeMs: 10_000 });
const spellGo = (seq: number) => frame(seq, "SMSG_SPELL_GO", { casterGuid: SELF_GUID, spellId: STUCK, hitGuids: [SELF_GUID], misses: [] });

const world = (extra: readonly unknown[] = []) => frames([...loginSequence, SPELLS, selfCreate, ...extra]);

async function inWorld(stub: StubServer): Promise<WrathClient> {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

async function untilAction(stub: StubServer, action: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.some((a) => a.action === action)) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

const casts = (stub: StubServer) => stub.actions.filter((a) => a.action === "cast_spell");

afterEach(() => {
  setSystemTime();
});

describe("unstuck: the first call sends nothing and says what will happen", () => {
  test("alive with no Hearthstone: a move of up to 5 yards, and how to confirm", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const r = await client.unstuck();
    expect(r).toEqual({
      ok: false,
      status: "confirm",
      hint:
        'unstuck() is the game\'s Help → "I\'m stuck": it casts Stuck (spell 7355), a 10-second cast that moving ' +
        "interrupts and combat refuses, with a 5-minute cooldown. You are alive and carry no Hearthstone: the server " +
        "moves you up to 5 yards in a random direction. Nothing was sent. Call unstuck() again within 60s to do it.",
    });
    await Bun.sleep(20);
    expect(casts(stub)).toEqual([]);
    // The harness block carries it too, so a dropped result still reaches the model.
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "unstuck", status: "confirm", hint: (r as { hint: string }).hint });
    client.close();
    await stub.stop();
  });

  test("alive with a Hearthstone: home, and the Hearthstone's cooldown it spends", async () => {
    const stub = startStub({ onConnect: () => world([hearthSlot, hearthCreate]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 31);
    const r = await client.unstuck();
    expect(r.status).toBe("confirm");
    const hint = (r as { hint: string }).hint;
    expect(hint).toContain(
      "You are alive and carry a Hearthstone: if it is off cooldown the server uses it, taking you to your bind point " +
        "and putting the Hearthstone on its 30-minute cooldown; if it is still cooling down, it moves you up to 5 yards " +
        "in a random direction instead.",
    );
    expect(casts(stub)).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("a ghost: the graveyard nearest where it stands", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const r = await client.unstuck();
    expect(r.status).toBe("confirm");
    expect((r as { hint: string }).hint).toContain(
      "You are a ghost: the server moves you to the graveyard nearest where you stand now, which can be the one " +
        "you were released at; your corpse stays where it is.",
    );
    await Bun.sleep(20);
    expect(casts(stub)).toEqual([]);
    client.close();
    await stub.stop();
  });
});

describe("unstuck: the second call within the window casts Stuck as the client does", () => {
  test("alive: CMSG_CAST_SPELL 7355 with no target, then the teleport is the answer", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    expect((await client.unstuck()).status).toBe("confirm");
    const pending = client.unstuck({ timeout: 3000 });
    await untilAction(stub, "cast_spell");
    expect(casts(stub)).toEqual([{ action: "cast_spell", token: "t", spellId: STUCK }]);
    push(stub, spellStart(90));
    push(stub, spellGo(91));
    push(stub, teleportAck(92, { x: -1231.5, y: 990.0, z: 42.1, o: 3.5 }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "moved" });
    expect(r.ok && r.position).toMatchObject({ map: 0, x: -1231.5, y: 990.0 });
    client.close();
    await stub.stop();
  });

  test("a ghost is not refused as castSpell refuses it: the cast goes out and the port to the graveyard answers", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    expect((await client.unstuck()).status).toBe("confirm");
    const pending = client.unstuck({ timeout: 3000 });
    await untilAction(stub, "cast_spell");
    expect(casts(stub)).toEqual([{ action: "cast_spell", token: "t", spellId: STUCK }]);
    push(stub, spellStart(90));
    push(stub, spellGo(91));
    push(stub, teleportAck(92, { x: -1480.0, y: 4120.5, z: 180.2, o: 0 }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "moved" });
    expect(r.ok && r.position).toMatchObject({ x: -1480.0, y: 4120.5 });
    client.close();
    await stub.stop();
  });

  test("both calls in one snippet: the confirm line does not outlive the send", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    expect((await client.unstuck()).status).toBe("confirm");
    const pending = client.unstuck({ timeout: 3000 });
    await untilAction(stub, "cast_spell");
    push(stub, spellStart(90));
    push(stub, spellGo(91));
    push(stub, teleportAck(92, { x: -1231.5, y: 990.0, z: 42.1, o: 3.5 }));
    expect((await pending).status).toBe("moved");
    expect(client.drainActionHints().filter((h) => h.action === "unstuck")).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("an unreleased body: the release's port and its ghost flag both land before the answer", async () => {
    const corpse = frame(20, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 0 } }] });
    const stub = startStub({ onConnect: () => world([corpse]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const first = await client.unstuck();
    expect((first as { hint: string }).hint).toContain(
      "You are dead and not released: it releases your spirit, as repop() does, to the graveyard nearest you.",
    );
    const pending = client.unstuck({ timeout: 3000 });
    await untilAction(stub, "cast_spell");
    push(stub, spellGo(90));
    push(stub, teleportAck(91, { x: -1480.0, y: 4120.5, z: 180.2, o: 0 }));
    await Bun.sleep(20);
    push(stub, ghostFlags(92));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "moved" });
    expect(client.state.self.ghost?.value).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a refusal is cast_failed with its reason, and the next call asks again", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.unstuck();
    const pending = client.unstuck({ timeout: 3000 });
    await untilAction(stub, "cast_spell");
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: STUCK, result: 1 }));
    const r = await pending;
    expect(r).toEqual({
      ok: false,
      status: "cast_failed",
      result: 1,
      reason: "affecting_combat",
      hint: "Stuck was not cast: the server answered affecting_combat: it cannot be cast in combat. A new attempt asks for confirmation again.",
    });
    expect((await client.unstuck()).status).toBe("confirm");
    expect(casts(stub)).toHaveLength(1);
    client.close();
    await stub.stop();
  });

  test("a cast that goes off with no move is unconfirmed", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.unstuck();
    const pending = client.unstuck({ timeout: 300 });
    await untilAction(stub, "cast_spell");
    push(stub, spellGo(90));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "unconfirmed" });
    expect((r as { hint: string }).hint).toStartWith("Stuck went off but no move was observed");
    client.close();
    await stub.stop();
  });
});

describe("unstuck: a call after the window has lapsed asks again", () => {
  test("61 seconds later the second call is a new first call, and nothing is sent", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    expect((await client.unstuck()).status).toBe("confirm");
    setSystemTime(new Date(t0 + 61_000));
    expect((await client.unstuck()).status).toBe("confirm");
    setSystemTime();
    await Bun.sleep(20);
    expect(casts(stub)).toEqual([]);
    client.close();
    await stub.stop();
  });
});
