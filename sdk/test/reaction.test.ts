/**
 * `UnitView.reaction`: how a unit regards the character, read the way a
 * client reads it from the FactionTemplate.dbc rows the module serves beside
 * each `faction` (`factionRow*`) and the character's own reputation pane.
 * Every template, mask, faction id and standing here is invented; the shapes
 * are module/PROTOCOL.md's.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { baseReputation, StateCache, unitReaction, type FactionTemplateRow } from "../src/state";
import { loginSequence, SELF_GUID } from "./fixtures";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const toEvents = (frames: readonly unknown[]): GameEvent[] =>
  frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

/** Invented group masks: 1 players, 2 one side, 4 the other, 8 monsters. */
interface RowSpec {
  template: number;
  faction: number;
  flags?: number;
  group?: number;
  friendGroup?: number;
  enemyGroup?: number;
  enemies?: number[];
  friends?: number[];
  repIndex?: number;
  base?: { raceMask: number; classMask: number; value: number }[];
}

function rowFields(r: RowSpec): Record<string, number> {
  const out: Record<string, number> = {
    faction: r.template,
    factionRow: r.template,
    factionRowFaction: r.faction,
    factionRowFlags: r.flags ?? 0,
    factionRowGroup: r.group ?? 0,
    factionRowFriendGroup: r.friendGroup ?? 0,
    factionRowEnemyGroup: r.enemyGroup ?? 0,
    factionRowRepIndex: r.repIndex ?? -1,
  };
  for (let i = 0; i < 4; i++) {
    out[`factionRowEnemy${i}`] = r.enemies?.[i] ?? 0;
    out[`factionRowFriend${i}`] = r.friends?.[i] ?? 0;
  }
  r.base?.forEach((b, i) => {
    out[`factionRowBaseRace${i}`] = b.raceMask;
    out[`factionRowBaseClass${i}`] = b.classMask;
    out[`factionRowBaseRep${i}`] = b.value;
  });
  return out;
}

/** Our character: race 1, class 1, a player of side "2". */
const SELF_ROW: RowSpec = { template: 900, faction: 901, group: 1 | 2, friendGroup: 2, enemyGroup: 4 | 8 };

const selfCreate = (extra: Record<string, number> = {}) =>
  frame(17, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: SELF_GUID,
        objectType: "player",
        self: true,
        pos: { x: 0, y: 0, z: 0, o: 0 },
        fields: { health: 100, maxHealth: 100, level: 10, race: 1, class: 1, playerFlags: 0, ...rowFields(SELF_ROW), ...extra },
      },
    ],
  });

let nextGuid = 5000;
function unit(seq: number, r: RowSpec | Record<string, number>, objectType = "unit", extra: Record<string, number | string> = {}) {
  const guid = String(nextGuid++);
  const fields = "template" in r ? rowFields(r as RowSpec) : r;
  return {
    guid,
    frame: frame(seq, "SMSG_UPDATE_OBJECT", {
      blocks: 1,
      objects: [{ update: "create", guid, objectType, pos: { x: 5, y: 5, z: 0, o: 0 }, fields: { health: 50, maxHealth: 50, ...fields, ...extra } }],
    }),
  };
}

const pane = (seq: number, rows: { factionId: number; reputation: number; atWar?: boolean }[]) =>
  frame(seq, "SMSG_INITIALIZE_FACTIONS", {
    count: 128,
    factions: rows.map((r, i) => ({
      repListId: 10 + i,
      factionId: r.factionId,
      name: `Faction ${r.factionId}`,
      standing: r.reputation,
      base: 0,
      reputation: r.reputation,
      flags: 1 | (r.atWar ? 2 : 0),
      visible: true,
      atWar: r.atWar ?? false,
    })),
  });

function world(frames: unknown[], self = selfCreate()): StateCache {
  return StateCache.replay(toEvents([...loginSequence, self, ...frames]), { seed: { guid: SELF_GUID, name: "Fenwick" } });
}
const reactionOf = (cache: StateCache, guid: string) => cache.units().find((u) => u.guid === guid)?.reaction;

describe("unit reaction from the template relations", () => {
  test("an enemy group is hostile, a friend group friendly, no relation neutral, hates-all hostile", () => {
    const monster = unit(30, { template: 1, faction: 11, group: 8, enemyGroup: 1 | 2 | 4 });
    const guard = unit(31, { template: 2, faction: 12, group: 2, friendGroup: 2, enemyGroup: 4 | 8 });
    const critter = unit(32, { template: 3, faction: 13 });
    const hater = unit(33, { template: 4, faction: 14, flags: 0x2000 });
    const listed = unit(34, { template: 5, faction: 15, group: 8, enemyGroup: 1, friends: [901] });
    const cache = world([monster.frame, guard.frame, critter.frame, hater.frame, listed.frame]);
    expect(reactionOf(cache, monster.guid)).toBe("hostile");
    expect(reactionOf(cache, guard.guid)).toBe("friendly");
    expect(reactionOf(cache, critter.guid)).toBe("neutral");
    expect(reactionOf(cache, hater.guid)).toBe("hostile");
    // An explicit friend faction beats the enemy-group mask.
    expect(reactionOf(cache, listed.guid)).toBe("friendly");
  });

  test("a row that describes another template, or no row, is unknown; a game object has none", () => {
    const stale = unit(30, { ...rowFields({ template: 1, faction: 11, enemyGroup: 1 }), faction: 2 });
    const bare = unit(31, { faction: 3 });
    const chest = unit(32, { goType: 3 } as unknown as Record<string, number>, "gameObject");
    const cache = world([stale.frame, bare.frame, chest.frame]);
    expect(reactionOf(cache, stale.guid)).toBeUndefined();
    expect(reactionOf(cache, bare.guid)).toBeUndefined();
    expect(cache.units({ type: "gameObject" })[0]?.reaction).toBeUndefined();
  });

  test("a contested guard is hostile to a character flagged for PvP", () => {
    const guard = unit(30, { template: 2, faction: 12, flags: 0x1000, group: 2, friendGroup: 2 });
    expect(reactionOf(world([guard.frame]), guard.guid)).toBe("friendly");
    expect(reactionOf(world([guard.frame], selfCreate({ playerFlags: 0x100 })), guard.guid)).toBe("hostile");
  });

  test("your own pet and a party member are friendly whatever their rows say", () => {
    const pet = unit(30, { template: 1, faction: 11, enemyGroup: 1 | 2 }, "unit", { summonedByGuid: SELF_GUID, unitFlags: 0x8 });
    const member = unit(31, { template: 1, faction: 11, enemyGroup: 1 | 2 }, "player", { unitFlags: 0x8 });
    const group = frame(40, "SMSG_GROUP_LIST", {
      groupType: 0,
      left: false,
      raid: false,
      subGroup: 0,
      memberFlags: 0,
      roles: 0,
      groupGuid: "1",
      counter: 1,
      members: [{ name: "Ally", guid: member.guid, online: true, subGroup: 0, flags: 0, roles: 0 }],
      leaderGuid: SELF_GUID,
    });
    const cache = world([pet.frame, member.frame, group]);
    expect(reactionOf(cache, pet.guid)).toBe("friendly");
    expect(reactionOf(cache, member.guid)).toBe("friendly");
  });
});

describe("unit reaction from reputation", () => {
  const REP: RowSpec = { template: 20, faction: 77, repIndex: 5, group: 8, enemyGroup: 1 | 2 };

  test("a reputation faction answers by your standing with it, capped at neutral at war", () => {
    const u = unit(30, REP);
    expect(reactionOf(world([pane(20, [{ factionId: 77, reputation: 3500 }]), u.frame]), u.guid)).toBe("friendly");
    expect(reactionOf(world([pane(20, [{ factionId: 77, reputation: -2000 }]), u.frame]), u.guid)).toBe("neutral");
    expect(reactionOf(world([pane(20, [{ factionId: 77, reputation: -5000 }]), u.frame]), u.guid)).toBe("hostile");
    expect(reactionOf(world([pane(20, [{ factionId: 77, reputation: 3500, atWar: true }]), u.frame]), u.guid)).toBe("neutral");
  });

  test("a faction the pane leaves out reads its Faction.dbc base for your race and class", () => {
    const base = [
      { raceMask: 2, classMask: 0, value: -42000 }, // race 2 only
      { raceMask: 1, classMask: 0, value: 4000 }, // race 1: ours
    ];
    const u = unit(30, { ...REP, base });
    expect(reactionOf(world([pane(20, []), u.frame]), u.guid)).toBe("friendly");
    // With no base table and no row, nothing is known.
    const bare = unit(31, REP);
    expect(reactionOf(world([pane(20, []), bare.frame]), bare.guid)).toBeUndefined();
  });

  test("baseReputation follows the core's first-match rule", () => {
    const row = (base: FactionTemplateRow["base"]): FactionTemplateRow => ({
      faction: 1, flags: 0, group: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [], repIndex: 0, base,
    });
    // A class-only entry matches any race.
    expect(baseReputation(row([{ raceMask: 0, classMask: 4, value: 100 }]), 7, 3)).toBe(100);
    expect(baseReputation(row([{ raceMask: 0, classMask: 4, value: 100 }]), 7, 2)).toBe(0);
    expect(baseReputation(row([{ raceMask: 64, classMask: 0, value: -500 }]), 7, 1)).toBe(-500);
    expect(baseReputation(row([]), 1, 1)).toBe(0);
  });
});

describe("unitReaction", () => {
  test("the template checks run in the core's order", () => {
    const self: FactionTemplateRow = { faction: 1, flags: 0, group: 3, friendGroup: 2, enemyGroup: 12, enemies: [], friends: [], repIndex: -1, base: [] };
    const opts = { contestedPvp: false, standing: () => undefined };
    // Hostile by mask, but the unit lists our faction as a friend: friendly.
    expect(unitReaction({ ...self, faction: 9, group: 8, friendGroup: 0, enemyGroup: 1, friends: [1] }, self, opts)).toBe("friendly");
    // Friendly to us by our friend mask alone (the second IsFriendlyTo).
    expect(unitReaction({ ...self, faction: 9, group: 2, friendGroup: 0, enemyGroup: 0 }, self, opts)).toBe("friendly");
  });
});
