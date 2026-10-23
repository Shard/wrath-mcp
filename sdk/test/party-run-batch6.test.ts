/**
 * The sixth batch of harness feedback from the 2026-10-20 Deadmines party
 * runs (attempt a7): the unit rows (rank, corpses, ground effects, the dead
 * on sight, what `alive` admits), creature emotes filled in, `waitForChat`
 * and the lines it already holds, the map after a transfer, the
 * `bad_targets` and `not_known` cast refusals, and the origin a hint is
 * tallied under. Every frame is hand-written from module/PROTOCOL.md's tables
 * with invented names, ids and positions.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));
const SEED = { guid: SELF_GUID, name: "Fenwick" };

const toEvents = (list: readonly unknown[]): GameEvent[] =>
  list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

async function inWorld(stub: StubServer, options: { origin?: () => number | undefined } = {}) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false }, ...options });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

async function untilAction(stub: StubServer, action: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.filter((a) => a.action === action).length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

/** A create block a few yards from the login position. */
const create = (seq: number, guid: string, objectType: string, fields: Record<string, number | string>, dx = 0) =>
  frame(seq, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [{ update: "create", guid, objectType, pos: { x: -1234.5 + dx, y: 987.25, z: 42.125, o: 0 }, fields }],
  });
const creatureQuery = (seq: number, entry: number, name: string, rank: number) =>
  frame(seq, "SMSG_CREATURE_QUERY_RESPONSE", { entry, found: true, name, subname: "", type: 7, rank });

// a7 mage, snippet 40: 8 of 17 rows came back with no name and no health, some
// under `alive: true`. They were player corpses (a create carrying only
// `scale`) and spell ground effects (dynamic objects whose entry is the
// spell), and the elite beside them was never said to be one.
describe("state.units(): corpses, ground effects, the dead on sight and the elite", () => {
  const ELITE = "17370390616419058401";
  const ELITE_ENTRY = 9634;
  const DEAD = "17370390616419058402";
  const DEAD_ENTRY = 9598;
  const CORPSE = "17366161638117343239";
  const EFFECT = "17365880163140632597";
  const OBJECT = "17370390616419058403";
  const stream: unknown[] = [
    ...loginSequence,
    selfCreate,
    create(30, ELITE, "unit", { entry: ELITE_ENTRY, health: 1219, maxHealth: 1219, level: 19 }, 8),
    creatureQuery(31, ELITE_ENTRY, "Ridge Overseer", 1),
    // A create omits every zero field, so a creature already dead states its
    // maxHealth and no health.
    create(32, DEAD, "unit", { entry: DEAD_ENTRY, maxHealth: 417, level: 17 }, 3),
    creatureQuery(33, DEAD_ENTRY, "Ridge Digger", 0),
    create(34, CORPSE, "corpse", { scale: 1, corpseOwnerGuid: "965" }, 4),
    create(35, EFFECT, "dynamicObject", { entry: 90001, scale: 1 }, 5),
  ];
  const cache = (extra: readonly unknown[] = []) => StateCache.replay(toEvents([...stream, ...extra]), { seed: SEED });
  const row = (guid: string, c = cache()) => c.units().find((r) => r.guid === guid)!;

  test("a creature's rank is named from its query answer, the core's words", () => {
    expect(row(ELITE).rank).toBe("elite");
    expect(row(DEAD).rank).toBe("normal");
    expect(row(CORPSE).rank).toBeUndefined();
    expect(row(EFFECT).rank).toBeUndefined();
    const named = (rank: number) => row(ELITE, cache([creatureQuery(40, ELITE_ENTRY, "Ridge Overseer", rank)])).rank;
    expect([2, 3, 4, 9].map(named)).toEqual(["rareelite", "worldboss", "rare", "unknown"]);
  });

  test("a game object never takes a creature's rank by sharing its entry", () => {
    const c = cache([create(40, OBJECT, "gameObject", { entry: ELITE_ENTRY }, 6)]);
    expect(row(OBJECT, c).rank).toBeUndefined();
  });

  test("a creature that came into view dead reads health 0 and dead", () => {
    expect(row(DEAD)).toMatchObject({ name: "Ridge Digger", health: 0, dead: true });
  });

  test("a creature that re-enters view dead does not keep the health it left with", () => {
    const c = cache([
      frame(40, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "outOfRange", guids: [ELITE] }] }),
      create(41, ELITE, "unit", { entry: ELITE_ENTRY, maxHealth: 1219, level: 19 }, 8),
    ]);
    expect(row(ELITE, c)).toMatchObject({ health: 0, dead: true });
  });

  test("a corpse says it is one and is dead; a ground effect is neither alive nor dead", () => {
    expect(row(CORPSE)).toMatchObject({ type: "corpse", dead: true, name: undefined, ownerGuid: "965" });
    expect(row(EFFECT)).toMatchObject({ type: "dynamicObject", entry: 90001, dead: undefined, name: undefined });
  });

  test("alive: true returns only the observed living; alive: false the observed dead, never a player's corpse; type takes corpse", () => {
    const c = cache();
    expect(c.units({ alive: true }).map((r) => r.guid)).toEqual([ELITE]);
    expect(c.units({ alive: false }).map((r) => r.guid)).toEqual([DEAD]);
    expect(c.closest({ alive: true })?.guid).toBe(ELITE);
    expect(c.units({ type: "corpse" }).map((r) => r.guid)).toEqual([CORPSE]);
  });
});

const emote = (seq: number, type: number, senderName: string | undefined, message: string) =>
  frame(seq, "SMSG_MESSAGECHAT", {
    type,
    language: 0,
    senderGuid: "17370390616419058402",
    ...(senderName !== undefined ? { senderName } : {}),
    message,
    chatTag: 0,
  });

describe("creature speech: %s is the speaker, as a client prints it", () => {
  test("state.chat fills a creature emote's template; a player's line is left as sent, and an achievement's with nothing to fill it", () => {
    const c = StateCache.replay(
      toEvents([
        ...loginSequence,
        emote(30, 16, "Ridge Digger", "%s attempts to run away in fear!"),
        emote(31, 14, "Ridge Digger", "%s yells for help, %s!"),
        emote(32, 1, undefined, "100%s sure"),
        emote(33, 48, undefined, "%s has earned the achievement $a!"),
      ]),
      { seed: SEED },
    );
    expect(c.chat.map((l) => l.message)).toEqual([
      "Ridge Digger attempts to run away in fear!",
      "Ridge Digger yells for help, Ridge Digger!",
      "100%s sure",
      "%s has earned the achievement $a!",
    ]);
  });

  test("waitForChat matches the line as state.chat shows it", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const hit = client.waitForChat("Ridge Digger attempts to run away in fear!", { timeout: 2000 });
    push(stub, emote(30, 16, "Ridge Digger", "%s attempts to run away in fear!"));
    expect((await hit).message).toBe("Ridge Digger attempts to run away in fear!");
    client.close();
    await stub.stop();
  });
});

describe("waitForChat: a line already received answers at once; includeBuffered: false waits for a new one", () => {
  test("the buffered line answers the default call; includeBuffered: false skips it", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    push(stub, emote(30, 1, "Tankfriend", "pull"));
    await folded(client, "SMSG_MESSAGECHAT", 30);
    expect((await client.waitForChat("pull", { timeout: 500 })).seq).toBe(30);
    const fresh = client.waitForChat("pull", { timeout: 2000, includeBuffered: false });
    await Bun.sleep(20);
    push(stub, emote(31, 1, "Tankfriend", "pull"));
    expect((await fresh).seq).toBe(31);
    client.close();
    await stub.stop();
  });
});

describe("a transfer's verdict waits for the new map's name", () => {
  const area = (seq: number) =>
    frame(seq, "WB_AREA", { mapId: 36, mapName: "Ridge Mines", instanceType: 1, zoneId: 1581, zoneName: "Ridge Mines", areaId: 1581, areaName: "Ridge Mines" });

  test("moveTo's transferred returns with state.self.map on the new map, the WB_AREA a tick after NEW_WORLD", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const pending = client.moveTo({ x: -1210, y: 990, z: 42 }, { timeout: 3000 });
    await untilAction(stub, "move_to");
    push(stub, frame(30, "SMSG_TRANSFER_PENDING", { map: 36 }));
    push(stub, frame(31, "SMSG_NEW_WORLD", { map: 36, x: -16.4, y: -383.1, z: 61.8, o: 1.9 }));
    push(stub, frame(32, "WB_MOVE_RESULT", { moveId: 1, status: "transferred", pos: { x: -1205, y: 981, z: 42, o: 1.2 } }));
    await Bun.sleep(50);
    push(stub, area(33));
    const result = await pending;
    expect(result.status).toBe("transferred");
    expect(client.state.self.map?.value).toEqual({ id: 36, name: "Ridge Mines", instanceType: "party" });
    client.close();
    await stub.stop();
  });

  test("with no WB_AREA at all the verdict still comes, after the bound", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const started = Date.now();
    const pending = client.waitForTransfer({ timeout: 2000 });
    push(stub, frame(31, "SMSG_NEW_WORLD", { map: 36, x: -16.4, y: -383.1, z: 61.8, o: 1.9 }));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1900);
    expect(client.state.self.map).toBeUndefined();
    client.close();
    await stub.stop();
  });
});

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", {
  spells: [
    { spellId: 2061, rank: 1, name: "Swift Mend" },
    { spellId: 7322, rank: 4, name: "Frost Lance" },
  ],
  cooldowns: [],
});
/** SpellCastResult codes (spell-cast-result.ts). */
const BAD_TARGETS = 12;
const CASTER_DEAD = 23;
const castFailed = (seq: number, spellId: number, result: number) => frame(seq, "SMSG_CAST_FAILED", { spellId, result });
const member = (seq: number, guid: string, fields: Record<string, number>) =>
  frame(seq, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [{ update: "create", guid, objectType: "player", pos: { x: -1230, y: 987, z: 42, o: 0 }, fields: { maxHealth: 809, ...fields } }],
  });

describe("castSpell bad_targets: the case the cache can tell, else the common ones", () => {
  test("a target observed dead, a ghost, no target at all, and the rest", async () => {
    const stub = startStub({
      onConnect: () =>
        frames([...loginSequence, SPELLS, selfCreate, member(20, "962", { health: 0 }), member(21, "963", { health: 1, playerFlags: 0x10 }), member(22, "964", { health: 500 })]),
    });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 22);
    let seq = 40;
    const refuse = async (spellId: number, target?: string): Promise<string> => {
      await client.castSpell(spellId, target);
      push(stub, castFailed(seq, spellId, BAD_TARGETS));
      await folded(client, "SMSG_CAST_FAILED", seq++);
      const [h] = client.drainActionHints();
      return h!.hint;
    };
    expect(await refuse(2061, "962")).toBe("Swift Mend (2061) on 962: the target is dead");
    expect(await refuse(2061, "963")).toBe("Swift Mend (2061) on 963: the target is dead");
    expect(await refuse(7322)).toBe("Frost Lance (7322): you gave no target and have none selected, and this spell needs one; pass one");
    expect(await refuse(7322, "964")).toBe(
      "Frost Lance (7322) on 964: this spell cannot take that target: commonly it is dead, it is a friend and the spell hits only enemies " +
        "(or an enemy, and the spell is a friendly one), or there is none and the spell needs one",
    );
    client.close();
    await stub.stop();
  });
});

describe("castSpell not_known: the rank the spellbook holds, when a spellbook packet has named the id", () => {
  test("an old rank the book superseded is named with the id it holds; nothing is cast in its place", async () => {
    const stub = startStub({
      onConnect: () =>
        frames([
          ...loginSequence,
          frame(16, "SMSG_INITIAL_SPELLS", { spells: [{ spellId: 1752, rank: 1, name: "Quick Cut" }], cooldowns: [] }),
          selfCreate,
          frame(18, "SMSG_SUPERCEDED_SPELL", { supersededSpellId: 1752, spellId: 1757, rank: 2, name: "Quick Cut" }),
          frame(19, "SMSG_SUPERCEDED_SPELL", { supersededSpellId: 1757, spellId: 1758, rank: 3, name: "Quick Cut" }),
        ]),
    });
    const client = await inWorld(stub);
    await folded(client, "SMSG_SUPERCEDED_SPELL", 19);
    const err = (await client.castSpell(1752).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "castSpell not_known: spell 1752 is not in your spellbook (state.spells()), and the server ignores a spell you do not know " +
        "without a word; nothing was sent. Cast one of the ids state.spells() lists. Quick Cut is in your spellbook as 1758.",
    );
    // An id no spellbook packet ever named says nothing more.
    const other = (await client.castSpell(642).catch((e: Error) => e)) as Error;
    expect(other.message.endsWith("Cast one of the ids state.spells() lists.")).toBe(true);
    expect(stub.actions.some((a) => a.action === "cast_spell")).toBe(false);
    client.close();
    await stub.stop();
  });
});

describe("hint origins: the code that made the call, kept apart per origin", () => {
  test("a cast's verdict landing after the caller moved on keeps the caller's origin", async () => {
    let current: number | undefined = 44;
    const stub = startStub({ onConnect: () => frames([...loginSequence, SPELLS, selfCreate]) });
    const client = await inWorld(stub, { origin: () => current });
    await client.castSpell(7322);
    current = 51;
    push(stub, castFailed(40, 7322, CASTER_DEAD));
    await folded(client, "SMSG_CAST_FAILED", 40);
    await client.castSpell(7322);
    push(stub, castFailed(41, 7322, CASTER_DEAD));
    await folded(client, "SMSG_CAST_FAILED", 41);
    const err = (await client.castSpell(642).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(client.drainActionHints().map((h) => [h.status, h.count, h.origin])).toEqual([
      ["caster_dead", 1, 44],
      ["caster_dead", 1, 51],
      ["not_known", 1, 51],
    ]);
    client.close();
    await stub.stop();
  });
});
