/**
 * Party frames (#286): `SMSG_PARTY_MEMBER_STATS` and `_FULL` folded onto
 * `group().members[i].stats`. The module decodes the wire (its tap, like
 * every other); these frames are hand-written from module/PROTOCOL.md's row
 * for the two opcodes, as the module would serve the bytes
 * `BuildPartyMemberStatsChangedPacket` and `HandleRequestPartyMemberStatsOpcode`
 * write. Names, guids and positions are invented.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { isEvent, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, selfCreate } from "./fixtures";
import { startStub } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq * 1000) => ({ seq, opcode, opcodeId: 0x07e, ts, data });

function toEvents(frames: readonly unknown[]): GameEvent[] {
  return frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

const SEED = { guid: "7", name: "Fenwick" };
const TANK = "940";
const MAGE = "941";

const groupList = (seq: number, left = false) =>
  frame(seq, "SMSG_GROUP_LIST", {
    groupType: left ? 0x10 : 0,
    left,
    raid: false,
    subGroup: 0,
    memberFlags: 0,
    roles: 0,
    groupGuid: left ? "0" : "1",
    counter: seq,
    members: left
      ? []
      : [
          { name: "Brannoc", guid: TANK, online: true, subGroup: 0, flags: 0, roles: 0 },
          { name: "Ysolde", guid: MAGE, online: true, subGroup: 0, flags: 0, roles: 0 },
        ],
    leaderGuid: left ? "0" : TANK,
    ...(left ? {} : { lootMethod: 0, looterGuid: "0", lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0 }),
  });

/**
 * The `_FULL` answer for a living warrior inside the Deadmines: every bit of
 * the member's own (0x1 status … 0x200 auras) plus 0x8 power type, since rage
 * is not mana, and the pet bits the builder always sets (0x800 name, 0x1000
 * model, 0x40000 auras).
 */
const tankFull = (seq: number) =>
  frame(seq, "SMSG_PARTY_MEMBER_STATS_FULL", {
    guid: TANK,
    full: true,
    mask: 0x0004_1bff,
    status: 0x01,
    health: 412,
    maxHealth: 515,
    powerType: 1,
    power: 35,
    maxPower: 100,
    level: 20,
    zoneId: 1581,
    zoneName: "The Deadmines",
    x: -16,
    y: -383,
    auras: [
      { slot: 0, spellId: 6673, flags: 0x1b, name: "Battle Shout" },
      { slot: 3, spellId: 11971, flags: 0x99, name: "Sunder Armor" },
    ],
  });

function partyCache(): { cache: StateCache; fold: (f: unknown) => void } {
  const cache = StateCache.replay(toEvents([...loginSequence]), { seed: SEED });
  const fold = (f: unknown) => cache.apply(toEvents([f])[0]!);
  fold(groupList(20));
  return { cache, fold };
}

const tank = (cache: StateCache) => cache.group()!.members.find((m) => m.guid === TANK)!;

describe("SMSG_PARTY_MEMBER_STATS[_FULL] parse", () => {
  test("the delta and the full form parse to the typed shape", () => {
    const [delta, full] = toEvents([
      frame(30, "SMSG_PARTY_MEMBER_STATS", { guid: "0x3ac", full: false, mask: 0x102, health: 0, x: -11208, y: 1673 }),
      tankFull(31),
    ]);
    if (!isEvent(delta!, "SMSG_PARTY_MEMBER_STATS")) throw new Error("delta did not type");
    expect(delta.data).toMatchObject({ guid: TANK, full: false, mask: 0x102, health: 0, x: -11208, y: 1673 });
    expect(delta.data.status).toBeUndefined();
    if (!isEvent(full!, "SMSG_PARTY_MEMBER_STATS_FULL")) throw new Error("full did not type");
    expect((full.data.auras as { name?: string }[] | undefined)?.map((a) => a.name)).toEqual(["Battle Shout", "Sunder Armor"]);
  });
});

describe("party frames fold onto group().members", () => {
  test("a member nothing has been sent for has no stats, and is not in view", () => {
    const { cache } = partyCache();
    expect(tank(cache)).toMatchObject({ name: "Brannoc", inView: false, stats: undefined });
  });

  test("the full form fills every field the member's own bits carry", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    expect(tank(cache).stats).toEqual({
      online: true,
      dead: false,
      ghost: false,
      afk: false,
      dnd: false,
      statusFlags: 0x01,
      health: 412,
      maxHealth: 515,
      powerType: "rage",
      power: 35,
      maxPower: 100,
      level: 20,
      zone: { id: 1581, name: "The Deadmines" },
      position: { x: -16, y: -383 },
      auras: [
        { slot: 0, spellId: 6673, name: "Battle Shout", flags: 0x1b },
        { slot: 3, spellId: 11971, name: "Sunder Armor", flags: 0x99 },
      ],
      asOf: TS + 30_000,
      seq: 30,
    });
    // The other member is untouched.
    expect(cache.group()!.members.find((m) => m.guid === MAGE)!.stats).toBeUndefined();
  });

  test("a full answer without a power type is mana: the builder leaves the bit out only for mana", () => {
    const { cache, fold } = partyCache();
    fold(
      frame(30, "SMSG_PARTY_MEMBER_STATS_FULL", {
        guid: MAGE,
        full: true,
        mask: 0x0004_1bf7,
        status: 0x01,
        health: 300,
        maxHealth: 300,
        power: 820,
        maxPower: 900,
        level: 20,
        zoneId: 40,
        zoneName: "Westfall",
        x: -10630,
        y: 1037,
        auras: [],
      }),
    );
    expect(cache.group()!.members.find((m) => m.guid === MAGE)!.stats).toMatchObject({ powerType: "mana", power: 820, auras: [] });
  });

  test("a delta overwrites only what its mask carried, and an aura entry with spell 0 clears its slot", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    // Out of sight and running: position and health, then one aura gone and one new.
    fold(frame(31, "SMSG_PARTY_MEMBER_STATS", { guid: TANK, full: false, mask: 0x102, health: 380, x: -40, y: -390 }));
    fold(
      frame(32, "SMSG_PARTY_MEMBER_STATS", {
        guid: TANK,
        full: false,
        mask: 0x200,
        auras: [
          { slot: 3, spellId: 0, flags: 1 },
          { slot: 5, spellId: 2457, flags: 1, name: "Battle Stance" },
        ],
      }),
    );
    expect(tank(cache).stats).toMatchObject({
      health: 380,
      maxHealth: 515,
      powerType: "rage",
      level: 20,
      zone: { id: 1581, name: "The Deadmines" },
      position: { x: -40, y: -390 },
      auras: [
        { slot: 0, spellId: 6673, name: "Battle Shout" },
        { slot: 5, spellId: 2457, name: "Battle Stance" },
      ],
      asOf: TS + 32_000,
      seq: 32,
    });
  });

  test("a death in place is health 0 under a stale alive status, and reads as dead", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    fold(frame(31, "SMSG_PARTY_MEMBER_STATS", { guid: TANK, full: false, mask: 0x2, health: 0 }));
    expect(tank(cache).stats).toMatchObject({ statusFlags: 0x01, online: true, health: 0, dead: true, ghost: false });
  });

  test("a release to the graveyard is a zone change, so its update carries the ghost status", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    fold(frame(31, "SMSG_PARTY_MEMBER_STATS", { guid: TANK, full: false, mask: 0x2, health: 0 }));
    // Player::UpdateZone sets every bit: here the member's own through position.
    fold(
      frame(32, "SMSG_PARTY_MEMBER_STATS", {
        guid: TANK,
        full: false,
        mask: 0x1ff,
        status: 0x09,
        health: 1,
        maxHealth: 515,
        powerType: 1,
        power: 0,
        maxPower: 100,
        level: 20,
        zoneId: 40,
        zoneName: "Westfall",
        x: -10546,
        y: 1197,
      }),
    );
    expect(tank(cache).stats).toMatchObject({
      online: true,
      ghost: true,
      dead: false,
      health: 1,
      zone: { id: 40, name: "Westfall" },
      position: { x: -10546, y: 1197 },
    });
    // The auras from before were not in this mask and are still the last word.
    expect(tank(cache).stats!.auras?.length).toBe(2);
  });

  test("the offline answer (status alone) says offline and keeps the last of the rest", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    fold(frame(31, "SMSG_PARTY_MEMBER_STATS_FULL", { guid: TANK, full: true, mask: 0x1, status: 0 }));
    expect(tank(cache).stats).toMatchObject({ online: false, dead: false, ghost: false, statusFlags: 0, health: 412, zone: { id: 1581 }, seq: 31 });
  });

  test("a later full answer replaces the record, auras included", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    fold(
      frame(31, "SMSG_PARTY_MEMBER_STATS_FULL", {
        guid: TANK,
        full: true,
        mask: 0x0004_1bff,
        status: 0x01,
        health: 515,
        maxHealth: 515,
        powerType: 1,
        power: 0,
        maxPower: 100,
        level: 21,
        zoneId: 1581,
        zoneName: "The Deadmines",
        x: -20,
        y: -400,
        auras: [],
      }),
    );
    expect(tank(cache).stats).toMatchObject({ level: 21, health: 515, auras: [] });
  });

  test("the member's unit in view sets inView; the stats stay the packets' last word", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    fold(
      frame(31, "SMSG_UPDATE_OBJECT", {
        blocks: 1,
        objects: [{ update: "create", guid: TANK, objectType: "player", pos: { x: -18, y: -380, z: 50, o: 0 }, fields: { health: 500, maxHealth: 515, level: 20 } }],
      }),
    );
    expect(tank(cache)).toMatchObject({ inView: true, stats: { health: 412 } });
    fold(frame(32, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "outOfRange", guids: [TANK] }] }));
    expect(tank(cache).inView).toBe(false);
  });

  test("a new SMSG_GROUP_LIST keeps the stats; leaving the group drops them", () => {
    const { cache, fold } = partyCache();
    fold(tankFull(30));
    fold(groupList(31));
    expect(tank(cache).stats?.health).toBe(412);
    expect(cache.snapshot().group?.members.find((m) => m.guid === TANK)?.stats?.zone?.name).toBe("The Deadmines");
    fold(groupList(32, true));
    expect(cache.group()!.members).toEqual([]);
    fold(groupList(33));
    expect(tank(cache).stats).toBeUndefined();
  });
});

describe("party frames are not retained in the event buffer", () => {
  // A far member walking sends about two a second: retained, four of them
  // would push the chat lines waitForChat looks back over out of the buffer.
  test("listeners and the fold see every one; recent() and waitForChat's lookback never hold them", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
    const push = (f: unknown) => stub.push(JSON.stringify(f));
    push(groupList(30));
    push(frame(31, "SMSG_MESSAGECHAT", { type: 2, language: 7, senderGuid: TANK, message: "pulling", chatTag: 0 }));
    await client.events.waitFor((e) => e.opcode === "SMSG_MESSAGECHAT" && e.seq === 31, { timeout: 2000 });
    let heard = 0;
    client.events.on("SMSG_PARTY_MEMBER_STATS", () => heard++);
    const before = client.events.recent().length;
    const N = 600; // more than the 500 the buffer retains
    const lastSeq = 32 + N - 1;
    const arrived = client.events.waitFor((e) => e.opcode === "SMSG_PARTY_MEMBER_STATS" && e.seq === lastSeq, {
      timeout: 5000,
      includeBuffered: false,
    });
    for (let i = 0; i < N; i++)
      push(frame(32 + i, "SMSG_PARTY_MEMBER_STATS", { guid: TANK, full: false, mask: 0x102, health: 400 - (i % 50), x: -16 - i, y: -383 }));
    expect((await arrived).seq).toBe(lastSeq);
    expect(heard).toBe(N);
    expect(client.events.recent().length).toBe(before);
    expect(client.events.recent().some((e) => e.opcode.startsWith("SMSG_PARTY_MEMBER_STATS"))).toBe(false);
    // The fold kept the latest values.
    expect(tank(client.state).stats).toMatchObject({ position: { x: -16 - (N - 1), y: -383 } });
    // The chat line from before the flood is still found by the lookback.
    expect(await client.waitForChat("pulling", { timeout: 200 })).toMatchObject({ seq: 31, message: "pulling" });
    client.close();
    await stub.stop();
  });
});
