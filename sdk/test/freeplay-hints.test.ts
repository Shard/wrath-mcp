/**
 * Hint and result text two long freeplay characters ran into: what a cast
 * refusal and an interrupt can say from what a client sees, a `not_ready`
 * with the caller's own casts timed, the point a refused move names as a
 * field, `unstuck()` named where a stranded character meets its refusals,
 * and the loot, sell and character-create answers that explained nothing.
 * Frames are hand-written from module/PROTOCOL.md's tables; names, guids and
 * positions are invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, WrathRequestError, type WrathClient } from "../src/client";
import { EventTimeoutError } from "../src/events";
import {
  CREATURE_GUID,
  creatureCreate,
  creatureDestroy,
  creatureQuery,
  frames,
  inventoryChangeFailure,
  inventorySlot,
  ITEM_GUID,
  itemCreate,
  itemQuery,
  loginSequence,
  lootRelease,
  lootResponse,
  SELF_GUID,
  selfCreate,
  spellDamage,
  swing,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", {
  spells: [
    { spellId: 2050, rank: 1, name: "Lesser Mend" },
    { spellId: 7322, rank: 4, name: "Frost Lance" },
    { spellId: 6572, rank: 3, name: "Riposte Slam" },
  ],
  cooldowns: [],
});
const world = (extra: readonly unknown[] = []) => frames([...loginSequence, SPELLS, selfCreate, creatureCreate, creatureQuery, ...extra]);

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  await client.events.waitFor((e) => e.seq === creatureQuery.seq, { timeout: 2000 });
  return client;
}
const folded = (client: WrathClient, seq: number) => client.events.waitFor((e) => e.seq === seq, { timeout: 2000 });
async function untilAction(stub: StubServer, action: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.filter((a) => a.action === action).length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

const castFailed = (seq: number, spellId: number, result: number, ts?: number) => frame(seq, "SMSG_CAST_FAILED", { spellId, result }, ts);
const spellStart = (seq: number, spellId: number, ts?: number) =>
  frame(seq, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId, castTimeMs: 2500 }, ts);
const spellGo = (seq: number, spellId: number, ts?: number, caster = SELF_GUID, hit = CREATURE_GUID) =>
  frame(seq, "SMSG_SPELL_GO", { casterGuid: caster, spellId, hitGuids: [hit], misses: [] }, ts);
const interrupted = (seq: number, spellId = 2050, ts?: number) =>
  frame(seq, "SMSG_SPELL_FAILURE", { casterGuid: SELF_GUID, spellId, result: 40 }, ts);
const selfFlags = (seq: number, unitFlags: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { unitFlags } }] });

const castHints = (client: WrathClient) =>
  client
    .drainActionHints()
    .filter((h) => h.action === "castSpell")
    .map((h) => `${h.status}: ${h.hint}`);

const NO_CAUSE =
  "the cast was interrupted, and the server names no cause: no move, loot or cancel of yours, no stun and no hit on you came with it";

describe("cast refusals: the meanings two characters were missing", () => {
  test("caster_aurastate says both sides and names no class's ability; a swim, a stronger aura and a wrong area are named", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    let seq = 40;
    const refuse = async (result: number): Promise<string> => {
      await client.castSpell(6572);
      push(stub, castFailed(seq, 6572, result));
      await folded(client, seq++);
      return castHints(client)[0]!;
    };
    expect(await refuse(22)).toBe(
      "caster_aurastate: Riposte Slam (6572): you are not in the state it needs: an effect it requires on you is missing, " +
        "or one you carry rules it out (yours: state.aurasOf(state.self.guid))",
    );
    expect(await refuse(88)).toBe("only_abovewater: Riposte Slam (6572): it cannot be cast while you are in water");
    expect(await refuse(9)).toBe("aura_bounced: Riposte Slam (6572): a more powerful spell is already active on the target");
    expect(await refuse(39)).toBe("incorrect_area: Riposte Slam (6572): it cannot be cast in this area");
    // A reason no row names still says only that it was refused.
    expect(await refuse(172)).toBe("custom_error: Riposte Slam (6572): the server refused it");
    client.close();
    await stub.stop();
  });
});

describe("castSpell interrupted: the causes a client can see, and an honest rest", () => {
  test("a loot this client sent during the cast", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(2050);
    push(stub, spellStart(40, 2050));
    await folded(client, 40);
    await client.lootAll(CREATURE_GUID);
    push(stub, interrupted(41));
    await folded(client, 41);
    expect(castHints(client)).toEqual([
      "interrupted: Lesser Mend (2050): your own loot interrupted it: the server ends a cast in progress to open a loot window",
    ]);
    client.close();
    await stub.stop();
  });

  test("a cancelCast of that spell, and not of another", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(2050);
    await client.cancelCast(7322);
    push(stub, interrupted(40));
    await folded(client, 40);
    await Bun.sleep(5);
    expect(castHints(client)).toEqual([`interrupted: Lesser Mend (2050): ${NO_CAUSE}`]);
    await client.castSpell(2050);
    await client.cancelCast(2050);
    push(stub, interrupted(41));
    await folded(client, 41);
    expect(castHints(client)).toEqual(["interrupted: Lesser Mend (2050): your own cancelCast ended it"]);
    client.close();
    await stub.stop();
  });

  test("a stun: the flag lands just after the failure, and the line is reworded in place", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(2050);
    push(stub, interrupted(40));
    push(stub, selfFlags(41, 0x0004_0000));
    await folded(client, 41);
    await Bun.sleep(5);
    const hints = client.drainActionHints().filter((h) => h.action === "castSpell");
    expect(hints.map((h) => [h.count, h.hint])).toEqual([[1, "Lesser Mend (2050): you were stunned during it"]]);
    client.close();
    await stub.stop();
  });

  test("a target that left view", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, { ...creatureDestroy, seq: 40 });
    push(stub, interrupted(41, 7322));
    await folded(client, 41);
    expect(castHints(client)).toEqual([
      `interrupted: Frost Lance (7322) on ${CREATURE_GUID}: its target is no longer in view, and the server ends a cast whose target is gone`,
    ]);
    client.close();
    await stub.stop();
  });

  test("a hit in the same instant is named beside it, and one a second earlier is not", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const tail = "landed on you; the server names no cause, and a hit or an interrupt effect ends some casts";
    // A melee swing, 2 ms before the failure.
    await client.castSpell(2050);
    push(stub, swing(CREATURE_GUID, SELF_GUID, 40));
    push(stub, interrupted(42));
    await folded(client, 42);
    expect(castHints(client)).toEqual([`interrupted: Lesser Mend (2050): it was interrupted in the same instant Thistlebore's melee hit ${tail}`]);
    // A spell's damage, named as the combat log names it.
    await client.castSpell(2050);
    push(stub, spellDamage(CREATURE_GUID, SELF_GUID, 50));
    push(stub, interrupted(51));
    await folded(client, 51);
    expect(castHints(client)).toEqual([`interrupted: Lesser Mend (2050): it was interrupted in the same instant Thistlebore's Test Bolt ${tail}`]);
    // A spell that landed on us with no damage of its own (a kick), by id.
    await client.castSpell(2050);
    push(stub, spellGo(60, 1766, undefined, CREATURE_GUID, SELF_GUID));
    push(stub, interrupted(61));
    await folded(client, 61);
    expect(castHints(client)).toEqual([`interrupted: Lesser Mend (2050): it was interrupted in the same instant Thistlebore's spell 1766 ${tail}`]);
    // A swing a second before it, a swing of our own, and a swing at someone else say nothing.
    await client.castSpell(2050);
    push(stub, swing(CREATURE_GUID, SELF_GUID, 70));
    push(stub, swing(SELF_GUID, CREATURE_GUID, 1071));
    push(stub, swing(CREATURE_GUID, "8", 1072));
    push(stub, interrupted(1073));
    await folded(client, 1073);
    await Bun.sleep(5);
    expect(castHints(client)).toEqual([`interrupted: Lesser Mend (2050): ${NO_CAUSE}`]);
    client.close();
    await stub.stop();
  });
});

describe("castSpell not_ready: the cooldown as far as this client has seen it", () => {
  test("a cooldown the server announced says its time left", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    push(stub, frame(40, "SMSG_SPELL_COOLDOWN", { guid: SELF_GUID, flags: 0, cooldowns: [{ spellId: 7322, cooldownMs: 8000 }] }, TS + 1000));
    await folded(client, 40);
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(41, 7322, 67, TS + 3400));
    await folded(client, 41);
    expect(castHints(client)).toEqual(["not_ready: Frost Lance (7322) on Thistlebore: its cooldown has 5.6s left (state.cooldowns())"]);
    client.close();
    await stub.stop();
  });

  test("with none announced: when it last went off, and which other cast is inside the global cooldown", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const base = "Frost Lance (7322) on Thistlebore: its cooldown, or the global cooldown, is still running";
    // Never seen cast: the words alone.
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(40, 7322, 67, TS + 1000));
    await folded(client, 40);
    expect(castHints(client)).toEqual([`not_ready: ${base}`]);
    // Its own last cast 6.2s back, and another spell 0.4s back.
    push(stub, spellGo(41, 7322, TS + 2000));
    push(stub, spellGo(42, 2050, TS + 7800));
    await folded(client, 42);
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(43, 7322, 67, TS + 8200));
    await folded(client, 43);
    expect(castHints(client)).toEqual([`not_ready: ${base} (it last went off 6.2s ago; Lesser Mend went off 0.4s ago)`]);
    // The other cast is out of the global cooldown's reach two seconds on, and is not named.
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(44, 7322, 67, TS + 9900));
    await folded(client, 44);
    expect(castHints(client)).toEqual([`not_ready: ${base} (it last went off 7.9s ago)`]);
    // Another unit's cast of the same spell is not ours.
    push(stub, spellGo(45, 7322, TS + 9950, CREATURE_GUID, SELF_GUID));
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(46, 7322, 67, TS + 132_000));
    await folded(client, 46);
    expect(castHints(client)).toEqual([`not_ready: ${base} (it last went off about 2 min ago)`]);
    client.close();
    await stub.stop();
  });
});

const UNSTUCK = 'With no way out, unstuck() is the game\'s "I\'m stuck".';
const moveResult = (seq: number, moveId: number, status: string, extra: Record<string, unknown> = {}) =>
  frame(seq, "WB_MOVE_RESULT", { moveId, status, pos: { x: -1234.5, y: 987.25, z: 42.125, o: 0 }, ...extra });

describe("a refused move: the point as a field, and the way out named", () => {
  test("path_incomplete: reachedPos is on moveTo's result and on moveToAsync's refusal, as the hint names it", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const reachedPos = { x: -1210.5, y: 960.25, z: 61.5 };
    const hint =
      "the walkable mesh has no continuous route to (-1200.0, 950.0); it ends at reachedPos (-1210.5, 960.3, z 61.5), " +
      "22y above the point asked for. The module already tried one subdivision. Route around (a road, a ramp, a door) " +
      `or approach from another side. ${UNSTUCK}`;
    const pending = client.moveTo({ x: -1200, y: 950, z: 40 });
    await untilAction(stub, "move_to");
    push(stub, moveResult(90, 1, "path_incomplete", { reachedPos }));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "path_incomplete", reachedPos, hint });
    expect(client.drainActionHints()).toMatchObject([{ action: "moveTo", status: "path_incomplete", hint }]);
    // The same verdict on the raw tier: in when the ack returns, so it is the answer.
    const queued = client.moveToAsync({ x: -1200, y: 951, z: 40 });
    await untilAction(stub, "move_to", 2);
    push(stub, moveResult(91, 2, "path_incomplete", { reachedPos }));
    const ack = await queued;
    expect(ack).toMatchObject({ ok: false, status: "path_incomplete", moveId: 2, reachedPos });
    expect((ack as { hint?: string }).hint).toContain("it ends at reachedPos (-1210.5, 960.3, z 61.5)");
    client.close();
    await stub.stop();
  });

  test("a flown leg names how far the line is clear, and the way out", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const pending = client.moveTo({ x: -1200, y: 950, z: 80 }, { fly: true });
    await untilAction(stub, "move_to");
    push(stub, moveResult(90, 1, "path_incomplete", { flight: true, reachedPos: { x: -1215, y: 965, z: 70 } }));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "path_incomplete", flight: true, reachedPos: { x: -1215, y: 965, z: 70 } });
    expect(r.hint).toBe(
      "the straight flight line to (-1200.0, 950.0, z 80.0) runs into terrain or a building; it is clear as far as reachedPos " +
        `(-1215.0, 965.0, z 70.0). Fly higher (a point well above the ground between) or around it, in a leg or two. ${UNSTUCK}`,
    );
    client.close();
    await stub.stop();
  });

  test("a flyer's ground refusal names the flight first, then the way out; a walker's fits the harness line", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const far = { x: -11200.5, y: -10950.5, z: 1140.5 };
    const reachedPos = { x: -11210.5, y: -10960.25, z: 1261.5 };
    const pending = client.moveTo(far);
    await untilAction(stub, "move_to");
    push(stub, moveResult(90, 1, "path_incomplete", { reachedPos }));
    const walker = (await pending).hint!;
    expect(walker).toEndWith(`or approach from another side. ${UNSTUCK}`);
    // The harness block cuts a hint at 320 characters (mcp, ACTION_HINT_RENDER):
    // with coordinates as long as the world has, the pointer still fits.
    expect(walker.length).toBeLessThanOrEqual(320);
    push(stub, frame(91, "WB_FLIGHT_STATE", { canFly: true, airborne: false }));
    await folded(client, 91);
    const again = client.moveTo({ ...far, y: far.y + 1 });
    await untilAction(stub, "move_to", 2);
    push(stub, moveResult(92, 2, "path_incomplete", { reachedPos }));
    expect((await again).hint).toEndWith(
      `or approach from another side. You can fly here (state.self.canFly): moveTo(p, { fly: true }) flies a straight line to the point. ${UNSTUCK}`,
    );
    client.close();
    await stub.stop();
  });

  test("a climb names unstuck(); a fall and an off-mesh target do not", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const refused = async (seq: number, moveId: number, status: string, extra: Record<string, unknown>) => {
      const pending = client.moveTo({ x: -1200, y: 950 + moveId, z: 40 });
      await untilAction(stub, "move_to", moveId);
      push(stub, moveResult(seq, moveId, status, extra));
      return (await pending).hint ?? "";
    };
    const edge = { x: -1234.5, y: 987.25, z: 42.125 };
    expect(await refused(90, 1, "drop", { dz: 5.2, reachedPos: edge })).toBe(
      "the route climbs a 5.2-yard step at (-1234.5, 987.3) that cannot be walked up, so the character stopped at the edge; " +
        `force does not apply to climbs. Pick a destination on this level, or find the ramp/stairs. ${UNSTUCK}`,
    );
    // A fall the estimate will not take: `force` is the way on, not unstuck().
    const fall = await refused(91, 2, "drop", { dz: -300, reachedPos: edge });
    expect(fall).toContain("{ force: true }");
    expect(fall).not.toContain("unstuck");
    expect(await refused(92, 3, "target_off_mesh", { nearest: null })).not.toContain("unstuck");
    client.close();
    await stub.stop();
  });
});

describe("unstuck: the cast refused for a mount says to dismount", () => {
  test("not_mounted", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    expect((await client.unstuck()).status).toBe("confirm");
    const pending = client.unstuck({ timeout: 3000 });
    await untilAction(stub, "cast_spell");
    push(stub, castFailed(40, 7355, 64));
    expect(await pending).toMatchObject({
      ok: false,
      status: "cast_failed",
      reason: "not_mounted",
      hint: "Stuck was not cast: the server answered not_mounted: it cannot be cast mounted, so dismount() first. A new attempt asks for confirmation again.",
    });
    client.close();
    await stub.stop();
  });
});

describe("lootCorpse: a window nothing came out of, and a window that never came", () => {
  test("none_stored carries the server's inventory refusal, once, and reaches the harness", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 300 });
    await untilAction(stub, "loot_all");
    push(stub, lootResponse(70));
    push(stub, inventoryChangeFailure(71, 50));
    push(stub, inventoryChangeFailure(72, 50));
    push(stub, lootRelease(73));
    const loot = await pending;
    const hint = "the loot window showed 1 item and none entered your bags: your bags are full (inventory result 50), so they are still there to loot";
    expect(loot).toMatchObject({ ok: false, status: "none_stored", hint });
    expect(client.drainActionHints()).toMatchObject([{ action: "lootCorpse", status: "none_stored", count: 1, hint }]);
    client.close();
    await stub.stop();
  });

  test("with no refusal on the wire it says the server gave none", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 300 });
    await untilAction(stub, "loot_all");
    push(stub, lootResponse(70));
    push(stub, lootRelease(71));
    expect(await pending).toMatchObject({
      status: "none_stored",
      hint: "the loot window showed 1 item and none entered your bags, and the server gave no reason; they are still there to loot",
    });
    client.close();
    await stub.stop();
  });

  test("silence still throws, and says what the cache shows of the corpse", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const err = (await client.lootCorpse(CREATURE_GUID, { timeout: 40 }).catch((e) => e)) as EventTimeoutError & { distance?: number };
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect(err.message).toBe(
      "timed out after 40ms waiting for the loot window (SMSG_LOOT_RESPONSE or SMSG_LOOT_RELEASE_RESPONSE): " +
        "the server sent neither; Thistlebore is 35y away, alive, not showing as lootable (state.units() lootable)",
    );
    expect(err.distance).toBeCloseTo(35.26, 1);
    // A guid nothing in view answers to.
    const gone = (await client.lootCorpse("4242", { timeout: 40 }).catch((e) => e)) as Error;
    expect(gone.message).toEndWith("the server sent neither; 4242 is not in view");
    client.close();
    await stub.stop();
  });
});

describe("sellItem: an item given by name is answered here, with its guid", () => {
  test("the bag row of that name is listed; nothing is sent", async () => {
    const stub = startStub({ onConnect: () => world([inventorySlot, itemCreate, itemQuery]) });
    const client = await inWorld(stub);
    await folded(client, itemQuery.seq);
    expect(() => client.sellItem(CREATURE_GUID, "gritstone charm")).toThrow(
      'sellItem(vendor, itemGuid): "gritstone charm" is not an item guid. sellItem takes the item\'s own guid, the .guid of its row in ' +
        `state.bag().items; "Gritstone Charm" is there as guid ${ITEM_GUID} (bag 255 slot 23)`,
    );
    expect(stub.actions.some((a) => a.action === "sell_item")).toBe(false);
    client.close();
    await stub.stop();
  });
});

describe("createSession: a race and class that do not go together", () => {
  test("char_create_failed_code_48 says so", async () => {
    const stub = startStub({ routes: { session: () => json({ ok: false, error: "char_create_failed_code_48" }, 502) } });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.createSession({ character: "Fenwick", race: 1, class: 3 }).catch((e) => e)) as WrathRequestError;
    expect(err.kind).toBe("game");
    expect(err.message).toBe(
      "module rejected request: char_create_failed_code_48 (character creation error: the server answers this for a race/class " +
        "combination the game does not allow (a Human cannot be a Hunter in 3.3.5a) — choose a race and class that go together) (HTTP 502)",
    );
    client.close();
    await stub.stop();
  });
});
