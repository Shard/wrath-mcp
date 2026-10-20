/**
 * The harness feedback the 2026-10-20 Deadmines party runs were missing: a
 * cast the server refused, a `moveToAsync` that never started, acting while
 * dead, a `reclaimCorpse` abandoned mid-wait, where a spirit healer left you,
 * own auras by name, and chat senders by name. Every frame is hand-written
 * from module/PROTOCOL.md's tables with invented names.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { EventAbortedError } from "../src/events";
import { isEvent, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import {
  CHEST_GUID,
  chestCreate,
  CREATURE_GUID,
  creatureCreate,
  creatureQuery,
  deathReleaseCleared,
  frames,
  loginSequence,
  PLAYER_GUID,
  SELF_GUID,
  selfCreate,
  selfHealth,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", {
  spells: [
    { spellId: 501, rank: 1, name: "Mending Word" },
    { spellId: 502, rank: 1, name: "Frost Lance" },
  ],
  cooldowns: [],
});
/** Our own values block with the ghost bit (`PLAYER_FLAGS_GHOST`) and a ghost's health of 1. */
const ghostFlags = (seq: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 1, playerFlags: 0x10 } }] });

async function inWorld(stub: StubServer, options: { deadline?: () => number | undefined; signal?: () => AbortSignal | undefined } = {}) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false }, ...options });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function untilAction(stub: StubServer, action: string, from = 0): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && a.action === action);
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}; saw ${stub.actions.map((a) => a.action).join(",")}`);
}

/** Wait until the cache has folded an opcode (the stub's pushes are asynchronous). */
async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

const world = (extra: readonly unknown[] = []) => frames([...loginSequence, SPELLS, selfCreate, creatureCreate, creatureQuery, ...extra]);

describe("castSpell: a refusal reaches the harness, named", () => {
  test("SMSG_CAST_FAILED after a castSpell is tallied with the spell, the target and what the reason means", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const ack = await client.castSpell(501, CREATURE_GUID);
    // The dispatch is still acked as sent: castSpell's contract is unchanged.
    expect(ack).toEqual({ ok: true, action: "cast_spell" });
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: 501, result: 47 }));
    await folded(client, "SMSG_CAST_FAILED", 90);
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "castSpell", status: "line_of_sight", count: 1 });
    expect(hints[0]!.hint).toBe(
      `Mending Word (501) on ${creatureName()}: something blocks the line of sight to the target`,
    );
    client.close();
    await stub.stop();
  });

  test("each reason is its own tally line; a repop's dont_report burst and other spells are not this cast's", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    for (let i = 0; i < 3; i++) {
      await client.castSpell(502, CREATURE_GUID);
      push(stub, frame(90 + i, "SMSG_CAST_FAILED", { spellId: 502, result: 134 }));
      await folded(client, "SMSG_CAST_FAILED", 90 + i);
    }
    await client.castSpell(502, CREATURE_GUID);
    push(stub, frame(95, "SMSG_CAST_FAILED", { spellId: 502, result: 27 })); // dont_report: not a refusal
    push(stub, frame(96, "SMSG_CAST_FAILED", { spellId: 777, result: 97 })); // a spell castSpell never sent
    push(stub, frame(97, "SMSG_CAST_FAILED", { spellId: 502, result: 97 }));
    await folded(client, "SMSG_CAST_FAILED", 97);
    const hints = client.drainActionHints().sort((a, b) => a.status.localeCompare(b.status));
    expect(hints.map((h) => [h.status, h.count])).toEqual([
      ["out_of_range", 1],
      ["unit_not_infront", 3],
    ]);
    expect(hints[1]!.hint).toContain("Frost Lance (502)");
    expect(hints[1]!.hint).toBe(`Frost Lance (502) on ${creatureName()}: the target is not in front of you`);
    client.close();
    await stub.stop();
  });

  test("a cast that starts and goes off says nothing; one interrupted mid-cast is still its own", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.castSpell(501);
    push(stub, frame(90, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId: 501, castTimeMs: 2500 }));
    push(stub, frame(91, "SMSG_SPELL_GO", { casterGuid: SELF_GUID, spellId: 501, hitGuids: [SELF_GUID], misses: [] }));
    // A later failure for the same spell, with no new cast, is nobody's.
    push(stub, frame(92, "SMSG_CAST_FAILED", { spellId: 501, result: 40 }));
    await folded(client, "SMSG_CAST_FAILED", 92);
    expect(client.drainActionHints()).toEqual([]);

    await client.castSpell(502, CREATURE_GUID);
    push(stub, frame(93, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId: 502, castTimeMs: 2500 }));
    // Another caster's interrupt is not ours.
    push(stub, frame(94, "SMSG_SPELL_FAILURE", { casterGuid: PLAYER_GUID, spellId: 502, result: 40 }));
    push(stub, frame(95, "SMSG_SPELL_FAILURE", { casterGuid: SELF_GUID, spellId: 502, result: 40 }));
    push(stub, frame(96, "SMSG_CAST_FAILED", { spellId: 502, result: 40 })); // the same interrupt's second packet
    await folded(client, "SMSG_CAST_FAILED", 96);
    const hints = client.drainActionHints();
    expect(hints.map((h) => [h.status, h.count])).toEqual([["interrupted", 1]]);
    expect(hints[0]!.hint).toContain("the cast was interrupted");
    client.close();
    await stub.stop();
  });

  test("a castSpell from a background routine reaches the next tool result the same way", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    // Fire and forget, as a routine's loop does; nobody reads the ack.
    void client.castSpell(501, CREATURE_GUID);
    await untilAction(stub, "cast_spell");
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: 501, result: 23 }));
    await folded(client, "SMSG_CAST_FAILED", 90);
    expect(client.drainActionHints()[0]).toMatchObject({ action: "castSpell", status: "caster_dead" });
    client.close();
    await stub.stop();
  });

  test("lootCorpse's own Opening casts are not tallied as castSpell refusals", async () => {
    const stub = startStub({ onConnect: () => world([chestCreate]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", (chestCreate as { seq: number }).seq);
    const pending = client.lootCorpse(CHEST_GUID, { timeout: 1000 }).catch(() => undefined);
    await untilAction(stub, "cast_spell");
    const spellId = stub.actions.find((a) => a.action === "cast_spell")!["spellId"] as number;
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId, result: 51 }));
    await pending;
    expect(client.drainActionHints().filter((h) => h.action === "castSpell")).toEqual([]);
    client.close();
    await stub.stop();
  });
});

/** The fixture creature's name, as the creature query answered it. */
function creatureName(): string {
  return (creatureQuery as { data: { name: string } }).data.name;
}

describe("moveToAsync: a verdict that is not an arrival reaches the harness", () => {
  const result = (seq: number, moveId: number, status: string, extra: Record<string, unknown> = {}) =>
    frame(seq, "WB_MOVE_RESULT", { moveId, status, pos: { x: -1234.5, y: 987.25, z: 42.1, o: 0 }, ...extra });

  test("too_far is tallied under moveToAsync with the same cap stated", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const ack = await client.moveToAsync({ x: -500, y: 987, z: 42 });
    push(stub, result(90, ack.moveId, "too_far"));
    await folded(client, "WB_MOVE_RESULT", 90);
    await Bun.sleep(5);
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "moveToAsync", status: "too_far", point: { x: -500, y: 987, z: 42 } });
    expect(hints[0]!.hint).toContain("one move (moveTo or moveToAsync alike) covers ~250y. Walk to an intermediate point first.");
    client.close();
    await stub.stop();
  });

  test("a verdict that beats the ack still counts; an arrival says nothing; a ghost's drop says it costs nothing", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    // The refusal lands before the ack: moveIds are minted 1, 2, … per stub.
    push(stub, result(90, 1, "drop", { dz: -6, reachedPos: { x: -1230, y: 987, z: 42 } }));
    await folded(client, "WB_MOVE_RESULT", 90);
    await client.moveToAsync({ x: -1200, y: 987, z: 36 });
    await Bun.sleep(5);
    const [drop] = client.drainActionHints();
    expect(drop).toMatchObject({ action: "moveToAsync", status: "drop" });
    expect(drop!.hint).toContain("pass { force: true } to take it anyway");
    expect(drop!.hint).toEndWith(" A ghost takes no fall damage.");

    const ack = await client.moveToAsync({ x: -1220, y: 987, z: 42 });
    push(stub, result(91, ack.moveId, "arrived"));
    await folded(client, "WB_MOVE_RESULT", 91);
    await Bun.sleep(5);
    expect(client.drainActionHints()).toEqual([]);
    client.close();
    await stub.stop();
  });
});

describe("moveToAsync: steering verdicts stay out of the harness block (operator, 2026-10-20)", () => {
  test("a superseded or stopped moveToAsync records no hint; a refusal after them still does", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const verdict = (seq: number, moveId: number, status: string) =>
      frame(seq, "WB_MOVE_RESULT", { moveId, status, pos: { x: -1234.5, y: 987.25, z: 42.1, o: 0 } });
    const first = await client.moveToAsync({ x: -1220, y: 987, z: 42 });
    const second = await client.moveToAsync({ x: -1210, y: 987, z: 42 });
    push(stub, verdict(90, first.moveId, "superseded"));
    push(stub, verdict(91, second.moveId, "stopped"));
    await folded(client, "WB_MOVE_RESULT", 91);
    await Bun.sleep(5);
    expect(client.drainActionHints()).toEqual([]);
    const third = await client.moveToAsync({ x: -500, y: 987, z: 42 });
    push(stub, verdict(92, third.moveId, "too_far"));
    await folded(client, "WB_MOVE_RESULT", 92);
    await Bun.sleep(5);
    expect(client.drainActionHints().map((h) => `${h.action} ${h.status}`)).toEqual(["moveToAsync too_far"]);
    client.close();
    await stub.stop();
  });
});

describe("acting while dead: a corpse cannot move or fight, a ghost can walk", () => {
  test("moveTo and moveToAsync refuse a corpse and send nothing; a ghost's move goes out", async () => {
    const stub = startStub({ onConnect: () => world([selfHealth(0, 20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const moved = await client.moveTo({ x: -1220, y: 987, z: 42 });
    const DEAD = "you are dead and a corpse cannot move; nothing was sent. sdk.repop() releases your spirit, and a ghost can walk.";
    expect(moved).toEqual({ ok: false, status: "dead", hint: DEAD });
    await expect(client.moveToAsync({ x: -1220, y: 987, z: 42 })).rejects.toThrow(`moveToAsync: ${DEAD}`);
    expect(stub.actions.filter((a) => a.action === "move_to")).toEqual([]);
    expect(client.drainActionHints().map((h) => `${h.action} ${h.status}`).sort()).toEqual(["moveTo dead", "moveToAsync dead"]);

    push(stub, ghostFlags(21));
    await folded(client, "SMSG_UPDATE_OBJECT", 21);
    const ack = await client.moveToAsync({ x: -1220, y: 987, z: 42 });
    expect(ack.ok).toBe(true);
    expect(stub.actions.filter((a) => a.action === "move_to")).toHaveLength(1);
    client.close();
    await stub.stop();
  });

  test("killTarget refuses a corpse and a ghost before any opcode", async () => {
    const stub = startStub({ onConnect: () => world([selfHealth(0, 20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const corpse = await client.killTarget(CREATURE_GUID);
    expect(corpse).toMatchObject({ ok: false, status: "dead", swings: 0, attacking: false, reached: false });
    expect(corpse.detail).toBe("you are dead and cannot attack; nothing was sent. sdk.repop() releases your spirit.");
    push(stub, ghostFlags(21));
    await folded(client, "SMSG_UPDATE_OBJECT", 21);
    const ghost = await client.killTarget(CREATURE_GUID);
    expect(ghost).toMatchObject({ ok: false, status: "dead" });
    expect(ghost.detail).toContain("you are a ghost and cannot attack");
    expect(stub.actions.map((a) => a.action).filter((a) => a !== "questgiver_status_query" && a !== "creature_query")).toEqual([]);
    expect(client.drainActionHints()).toMatchObject([{ action: "killTarget", status: "dead", count: 2 }]);
    client.close();
    await stub.stop();
  });

  test("an interrupted move whose verdict finds the character dead says it died", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const pending = client.moveTo({ x: -1220, y: 987, z: 42 });
    await untilAction(stub, "move_to");
    // The live order (tank, 10:41:00.916): health 0 in the update block, then
    // the verdict, in the same tick.
    push(stub, selfHealth(0, 90));
    push(stub, frame(91, "WB_MOVE_RESULT", { moveId: 1, status: "interrupted", pos: { x: -1230, y: 987, z: 42, o: 0 } }));
    const moved = await pending;
    expect(moved).toMatchObject({ ok: false, status: "interrupted" });
    expect(moved.hint).toBe(
      "the move stopped because the character died. A corpse cannot move: sdk.repop() releases the spirit, and a ghost can walk.",
    );
    client.close();
    await stub.stop();
  });

  test("an interrupted move while alive keeps the general hint", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const pending = client.moveTo({ x: -1220, y: 987, z: 42 });
    await untilAction(stub, "move_to");
    push(stub, frame(91, "WB_MOVE_RESULT", { moveId: 1, status: "interrupted", pos: { x: -1230, y: 987, z: 42, o: 0 } }));
    expect((await pending).hint).toContain("the move stopped early (death, root, stun");
    client.close();
    await stub.stop();
  });
});

describe("reclaimCorpse: an abandoned wait says what was waiting", () => {
  test("the abort error names the reclaim delay and carries the note the sandbox splices in", async () => {
    const ac = new AbortController();
    const stub = startStub({
      onConnect: () => frames([...loginSequence, selfCreate, selfHealth(1, 20), frame(21, "SMSG_CORPSE_RECLAIM_DELAY", { delayMs: 20_000 }, Date.now())]),
    });
    const client = await inWorld(stub, { signal: () => ac.signal });
    await client.events.waitFor((e) => isEvent(e, "SMSG_CORPSE_RECLAIM_DELAY"), { timeout: 2000 });
    const pending = client.reclaimCorpse();
    await Bun.sleep(30);
    ac.abort(new Error("snippet abandoned"));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventAbortedError);
    const note = (err as { waitAbandon?: string }).waitAbandon;
    expect(note).toMatch(/^reclaimCorpse was waiting out the server's reclaim delay \(~(19|20)s still to run\) when this was abandoned, 0s into its 25s wait\. Give it a snippet of its own, or pass a \{ timeout \} that fits\.$/);
    expect((err as Error).message).toContain(note!);
    client.close();
    await stub.stop();
  });
});

describe("spiritHealerActivate: the result says where you are", () => {
  test("position, zone and subzone from the cache", async () => {
    const area = frame(19, "WB_AREA", { mapId: 0, mapName: "Fixture Continent", instanceType: 0, zoneId: 40, zoneName: "Fixture Vale", areaId: 20, areaName: "Mossmill" });
    const stub = startStub({ onConnect: () => world([area, selfHealth(1, 20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const pending = client.spiritHealerActivate(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "spirit_healer_activate");
    push(stub, deathReleaseCleared(91));
    expect(await pending).toEqual({
      ok: true,
      status: "resurrected",
      position: client.state.self.position!.value,
      zone: "Fixture Vale",
      area: "Mossmill",
    });
    client.close();
    await stub.stop();
  });
});

describe("state: own auras by name, chat senders by name", () => {
  const SEED = { guid: SELF_GUID, name: "Fenwick" };
  const toEvents = (list: readonly unknown[]): GameEvent[] =>
    list.map((f) => {
      const parsed = parseEventFrame(JSON.stringify(f));
      if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
      return parsed.event;
    });

  test("an aura carries the module's name, else the spellbook's; neither is invented", () => {
    const cache = StateCache.replay(
      toEvents([
        ...loginSequence,
        SPELLS,
        frame(30, "SMSG_AURA_UPDATE_ALL", {
          targetGuid: SELF_GUID,
          auras: [
            { slot: 0, spellId: 9002, flags: 0xa0, level: 20, stacks: 1, maxDuration: 600_000, duration: 552_000, name: "Spirit Weariness" },
            { slot: 1, spellId: 501, flags: 0x18, level: 20, stacks: 1 },
            { slot: 2, spellId: 9003, flags: 0x18, level: 20, stacks: 1 },
          ],
        }),
      ]),
      { seed: SEED },
    );
    expect(cache.aurasOf(SELF_GUID).map((a) => [a.spellId, a.name, a.duration])).toEqual([
      [9002, "Spirit Weariness", 552_000],
      [501, "Mending Word", undefined],
      [9003, undefined, undefined],
    ]);
  });

  test("a player's chat line is named once the name query answers, even when the answer comes later", () => {
    const say = frame(30, "SMSG_MESSAGECHAT", { type: 2, language: 7, senderGuid: 9, message: "ready", chatTag: 0 });
    const before = StateCache.replay(toEvents([...loginSequence, say]), { seed: SEED });
    expect(before.chat[0]?.senderName).toBeUndefined();
    const after = StateCache.replay(
      toEvents([...loginSequence, say, frame(31, "SMSG_NAME_QUERY_RESPONSE", { guid: 9, found: true, name: "Ordrick" })]),
      { seed: SEED },
    );
    expect(after.chat[0]).toMatchObject({ senderGuid: "9", senderName: "Ordrick", message: "ready" });
    expect(after.snapshot().chat[0]?.senderName).toBe("Ordrick");
  });
});

describe("resurrect helpers resolve once our own fields say alive (reference run 2026-10-20)", () => {
  /** The ghost's aura slot, then its removal: what the resurrect sends before the values update. */
  const ghostAura = (seq: number) =>
    frame(seq, "SMSG_AURA_UPDATE_ALL", { targetGuid: SELF_GUID, auras: [{ slot: 0, spellId: 9100, flags: 0x19, level: 20, stacks: 1 }] });
  const ghostAuraGone = (seq: number) => frame(seq, "SMSG_AURA_UPDATE", { targetGuid: SELF_GUID, auras: [{ slot: 0, spellId: 0, removed: true }] });
  const aliveFields = (seq: number) =>
    frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 61, playerFlags: 0 } }] });

  test("reclaimCorpse waits past the marker and the aura removal for the values update", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20), ghostAura(21)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_AURA_UPDATE_ALL", 21);
    let settled = false;
    const pending = client.reclaimCorpse(undefined, { timeout: 4000, attemptTimeout: 1500 }).then((r) => {
      settled = true;
      return r;
    });
    await untilAction(stub, "reclaim_corpse");
    push(stub, ghostAuraGone(90));
    push(stub, deathReleaseCleared(91));
    await folded(client, "SMSG_DEATH_RELEASE_LOC", 91);
    await Bun.sleep(30);
    // The server has said the resurrect happened; our own fields have not yet.
    expect(settled).toBe(false);
    push(stub, aliveFields(92));
    const result = await pending;
    expect(result).toMatchObject({ ok: true, status: "reclaimed" });
    expect(client.state.self.health?.value.current).toBe(61);
    expect(client.state.self.ghost?.value).toBe(false);
    client.close();
    await stub.stop();
  });

  test("acceptResurrection waits the same way", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20), ghostAura(21)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_AURA_UPDATE_ALL", 21);
    push(stub, frame(80, "SMSG_RESURRECT_REQUEST", { casterGuid: PLAYER_GUID, sickness: false }));
    await folded(client, "SMSG_RESURRECT_REQUEST", 80);
    let settled = false;
    const pending = client.acceptResurrection({ timeout: 2000 }).then((r) => {
      settled = true;
      return r;
    });
    await untilAction(stub, "raw");
    push(stub, ghostAuraGone(90));
    push(stub, deathReleaseCleared(91));
    await folded(client, "SMSG_DEATH_RELEASE_LOC", 91);
    await Bun.sleep(30);
    expect(settled).toBe(false);
    push(stub, aliveFields(92));
    expect(await pending).toMatchObject({ ok: true, status: "resurrected" });
    expect(client.state.self.health?.value.current).toBe(61);
    client.close();
    await stub.stop();
  });

  test("spiritHealerActivate waits the same way, and its result already reads alive", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20), ghostAura(21)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_AURA_UPDATE_ALL", 21);
    let settled = false;
    const pending = client.spiritHealerActivate(CREATURE_GUID, { timeout: 2000 }).then((r) => {
      settled = true;
      return r;
    });
    await untilAction(stub, "spirit_healer_activate");
    push(stub, ghostAuraGone(90));
    push(stub, deathReleaseCleared(91));
    await folded(client, "SMSG_DEATH_RELEASE_LOC", 91);
    await Bun.sleep(30);
    expect(settled).toBe(false);
    push(stub, aliveFields(92));
    expect(await pending).toMatchObject({ ok: true, status: "resurrected" });
    expect(client.state.self.health?.value.current).toBe(61);
    client.close();
    await stub.stop();
  });
});
