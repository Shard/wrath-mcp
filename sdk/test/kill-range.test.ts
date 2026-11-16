/**
 * `killTarget(guid, { range })`: the ranged auto-attack a client's button
 * fires for what the ranged slot holds, cast through the ordinary cast path
 * from within `range`; a refusal with nothing sent when there is nothing to
 * shoot; and the melee fight unchanged without it. Frames are the shared
 * fixtures plus a worn ranged weapon; names and ids are invented, the spell
 * ids and item subclasses are the game's.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import {
  CREATURE_GUID,
  creatureCreate,
  creatureHealth,
  creatureQuery,
  frames,
  ITEM_GUID_HI,
  loginSequence,
  moveResult,
  SELF_GUID,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const RANGED_SLOT = 17;
const RANGED_ENTRY = 55510;
const RANGED_GUID_LO = 4330;
const RANGED_GUID = ((BigInt(ITEM_GUID_HI) << 32n) | BigInt(RANGED_GUID_LO)).toString();
const AUTO_SHOT = 75;
const SHOOT_WAND = 5019;

const spells = (...ids: number[]) =>
  frame(16, "SMSG_INITIAL_SPELLS", { spells: ids.map((spellId) => ({ spellId, rank: 0, name: `spell ${spellId}` })), cooldowns: [] });
/** A weapon worn in the ranged slot, of item class 2 and the given subclass, with the ammo field. */
const rangedWorn = (subClass: number, name: string, ammoId: number) => [
  frame(39, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [
      {
        update: "values",
        guid: SELF_GUID,
        fields: { [`invSlot${RANGED_SLOT}Lo`]: RANGED_GUID_LO, [`invSlot${RANGED_SLOT}Hi`]: ITEM_GUID_HI, ammoId },
      },
    ],
  }),
  frame(40, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [{ update: "create", guid: RANGED_GUID, objectType: "item", fields: { entry: RANGED_ENTRY, stackCount: 1 } }],
  }),
  frame(41, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: RANGED_ENTRY, found: true, name, quality: 1, class: 2, subClass }),
];
const BOW = () => rangedWorn(2, "Practice Bow", 2512);
const WAND = () => rangedWorn(19, "Practice Wand", 0);

const world = (extra: readonly unknown[]) => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, ...extra]);
/** Our own shot going off at the creature. */
const shot = (spellId: number, seq: number) =>
  frame(seq, "SMSG_SPELL_GO", { casterGuid: SELF_GUID, spellId, hitGuids: [CREATURE_GUID], misses: [] }, Date.now());

async function inWorld(stub: StubServer): Promise<WrathClient> {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function until(stub: StubServer, pred: (a: Record<string, unknown>) => boolean, from = 0): Promise<number> {
  for (let i = 0; i < 400; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && pred(a as Record<string, unknown>));
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw it; saw ${stub.actions.map((a) => a.action).join(",")}`);
}
const named = (stub: StubServer) =>
  stub.actions.map((a) => (a.action === "raw" ? String((a as { opcode?: string }).opcode) : String(a.action)));

describe("killTarget with range", () => {
  test("a bow: Auto Shot from where it stands, its shots counted, no swing, and the auto-repeat cancelled at the kill", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...BOW()]) });
    const client = await inWorld(stub);
    // The creature is ~35y off; within 40y nothing walks.
    const fight = client.killTarget(CREATURE_GUID, { range: 40, timeout: 5000, pollIntervalMs: 10, reapproachIntervalMs: 60_000 });
    await until(stub, (a) => a.action === "cast_spell");
    push(stub, shot(AUTO_SHOT, 70));
    push(stub, shot(AUTO_SHOT, 71));
    await Bun.sleep(40);
    push(stub, creatureHealth(0, 72));
    const result = await fight;
    expect(result).toMatchObject({ ok: true, status: "killed", attack: { spellId: AUTO_SHOT, name: "Auto Shot" }, shots: 2, reached: true });
    expect(result.detail).toContain("Auto Shot, 2 shot(s); Auto Shot stopped");
    const cast = stub.actions.find((a) => a.action === "cast_spell") as Record<string, unknown>;
    expect(cast).toMatchObject({ spellId: AUTO_SHOT, targetGuid: CREATURE_GUID });
    const sent = named(stub);
    expect(sent).not.toContain("attack_start");
    expect(sent).not.toContain("move_to");
    expect(sent.slice(0, 2)).toEqual(["set_target", "CMSG_CANCEL_AUTO_REPEAT_SPELL"]);
    expect(sent.at(-1)).toBe("CMSG_CANCEL_AUTO_REPEAT_SPELL");
    expect(sent).not.toContain("attack_stop");
    client.close();
    await stub.stop();
  });

  test("a bow from farther than range: walks, stops once within it, then shoots", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...BOW()]) });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, { range: 20, timeout: 5000, pollIntervalMs: 10, reapproachIntervalMs: 60_000 });
    await until(stub, (a) => a.action === "move_to");
    // Partway: 15y from the creature, inside 20.
    push(stub, frame(60, "WB_MOVE_PROGRESS", { moveId: 1, pos: { x: -1215, y: 982, z: 42, o: 0 } }, Date.now()));
    const stopAt = await until(stub, (a) => a.action === "stop");
    push(stub, { ...(moveResult("stopped", 1, 61) as object), data: { moveId: 1, status: "stopped", pos: { x: -1215, y: 982, z: 42, o: 0 } } });
    const castAt = await until(stub, (a) => a.action === "cast_spell", stopAt);
    expect(castAt).toBeGreaterThan(stopAt);
    push(stub, creatureHealth(0, 62));
    const result = await fight;
    expect(result).toMatchObject({ ok: true, status: "killed", reached: true, attack: { spellId: AUTO_SHOT } });
    expect(result.detail).not.toContain("approach:");
    client.close();
    await stub.stop();
  });

  test("in range with no shot going off: cast again, then walk halfway (the line of sight is the server's to judge)", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...BOW()]) });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, { range: 40, timeout: 5000, pollIntervalMs: 10, reapproachIntervalMs: 40 });
    const first = await until(stub, (a) => a.action === "cast_spell");
    const again = await until(stub, (a) => a.action === "cast_spell", first + 1);
    const walk = await until(stub, (a) => a.action === "move_to", again + 1);
    expect(walk).toBeGreaterThan(again);
    push(stub, moveResult("arrived", 1, 69));
    push(stub, creatureHealth(0, 70));
    expect((await fight).status).toBe("killed");
    client.close();
    await stub.stop();
  });

  test("while a spell of the caller's is casting, no re-cast and no walk: the cast is the caller's", async () => {
    const stub = startStub({ onConnect: () => world([spells(SHOOT_WAND, 133), ...WAND()]) });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, { range: 40, timeout: 5000, pollIntervalMs: 10, reapproachIntervalMs: 60 });
    const first = await until(stub, (a) => a.action === "cast_spell");
    // A long cast of the caller's own, started from its own code.
    push(stub, frame(70, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId: 133, castTimeMs: 60_000, targetGuid: CREATURE_GUID }, Date.now()));
    await Bun.sleep(400);
    expect(stub.actions.slice(first + 1).filter((a) => a.action === "cast_spell" || a.action === "move_to")).toHaveLength(0);
    push(stub, creatureHealth(0, 71));
    expect((await fight).status).toBe("killed");
    client.close();
    await stub.stop();
  });

  test("a wand: Shoot 5019, and a wand needs no ammunition", async () => {
    const stub = startStub({ onConnect: () => world([spells(SHOOT_WAND), ...WAND()]) });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, { range: 40, timeout: 5000, pollIntervalMs: 10, reapproachIntervalMs: 60_000 });
    await until(stub, (a) => a.action === "cast_spell");
    push(stub, shot(SHOOT_WAND, 70));
    await Bun.sleep(30);
    push(stub, creatureHealth(0, 71));
    const result = await fight;
    expect(result).toMatchObject({ ok: true, attack: { spellId: SHOOT_WAND, name: "Shoot" }, shots: 1 });
    expect(stub.actions.find((a) => a.action === "cast_spell")).toMatchObject({ spellId: SHOOT_WAND });
    client.close();
    await stub.stop();
  });

  test("a timeout leaves it shooting, and says how to stop", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...BOW()]) });
    const client = await inWorld(stub);
    const result = await client.killTarget(CREATURE_GUID, { range: 40, timeout: 80, pollIntervalMs: 10 });
    expect(result).toMatchObject({ ok: false, status: "timeout", attacking: true, shots: 0 });
    expect(result.detail).toContain("still shooting — pass { disengage: true } to break off");
    expect(named(stub)).not.toContain("attack_stop");
    expect(named(stub).filter((n) => n === "CMSG_CANCEL_AUTO_REPEAT_SPELL")).toHaveLength(1);
    client.close();
    await stub.stop();
  });

  test("an empty ranged slot is refused with nothing sent, never fought in melee", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT)]) });
    const client = await inWorld(stub);
    const result = await client.killTarget(CREATURE_GUID, { range: 30 });
    expect(result).toMatchObject({ ok: false, status: "no_ranged_attack", swings: 0, attacking: false, reached: false });
    expect(result.detail).toStartWith("nothing is in your ranged slot (worn slot 17)");
    expect(stub.actions).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("an attack not in the spellbook, and a bow with no ammunition, are refused with nothing sent", async () => {
    const unknown = startStub({ onConnect: () => world([spells(SHOOT_WAND), ...BOW()]) });
    const a = await inWorld(unknown);
    const r1 = await a.killTarget(CREATURE_GUID, { range: 30 });
    expect(r1.status).toBe("no_ranged_attack");
    expect(r1.detail).toBe(
      "your Practice Bow (a bow) fires with Auto Shot (spell 75) or Shoot (spell 3018), which is not in your spellbook (state.spells()); nothing was sent.",
    );
    expect(unknown.actions).toHaveLength(0);
    a.close();
    await unknown.stop();

    const empty = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...rangedWorn(2, "Practice Bow", 0)]) });
    const b = await inWorld(empty);
    const r2 = await b.killTarget(CREATURE_GUID, { range: 30 });
    expect(r2.status).toBe("no_ranged_attack");
    expect(r2.detail).toContain("needs ammunition and none is set");
    expect(empty.actions).toHaveLength(0);
    b.close();
    await empty.stop();
  });

  test("a range that is not a distance throws before anything is sent", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...BOW()]) });
    const client = await inWorld(stub);
    await expect(client.killTarget(CREATURE_GUID, { range: "far" as unknown as number })).rejects.toThrow(/range is a distance in yards/);
    expect(stub.actions).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("without range the fight is melee as before: no cast, no attack or shots on the result", async () => {
    const stub = startStub({ onConnect: () => world([spells(AUTO_SHOT), ...BOW()]) });
    const client = await inWorld(stub);
    const fight = client.killTarget(CREATURE_GUID, { timeout: 5000, pollIntervalMs: 10, reapproachIntervalMs: 60_000, meleeRange: 100 });
    await until(stub, (a) => a.action === "attack_start");
    push(stub, creatureHealth(0, 70));
    const result = await fight;
    expect(result.ok).toBe(true);
    expect("attack" in result).toBe(false);
    expect("shots" in result).toBe(false);
    expect(result.detail).toBe("target died; auto-attack stopped");
    expect(named(stub)).toEqual(["set_target", "face", "attack_start", ...named(stub).slice(3, -1), "attack_stop"]);
    expect(named(stub)).not.toContain("cast_spell");
    expect(named(stub)).not.toContain("CMSG_CANCEL_AUTO_REPEAT_SPELL");
    client.close();
    await stub.stop();
  });
});
