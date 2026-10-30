/**
 * Instance saves and difficulty, world states, weather and the game clock,
 * threat lists, own speeds and dispel logs: each tap decodes in PROTOCOL.md's
 * shape, and the stateful ones fold as a client reads them.
 */
import { describe, expect, test } from "bun:test";

import { isKnownOpcode, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { CREATURE_GUID, creatureCreate, loginSequence, PLAYER_GUID, SELF_GUID, selfCreate } from "./fixtures";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });

function parse(f: unknown): GameEvent {
  const parsed = parseEventFrame(JSON.stringify(f));
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
  const schemaError = (parsed.event as { schemaError?: string }).schemaError;
  if (schemaError !== undefined) throw new Error(`schema: ${schemaError}`);
  return parsed.event;
}

const replay = (list: readonly unknown[]) => StateCache.replay(list.map(parse), { seed: { guid: SELF_GUID, name: "Fenwick" } });

const SPEEDS = { walk: 2.5, run: 7, runBack: 4.5, swim: 4.72, swimBack: 2.5, flight: 7, flightBack: 4.5, turnRate: 3.14, pitchRate: 3.14 };

const selfCreateWithSpeeds = {
  ...selfCreate,
  data: { blocks: 1, objects: [{ ...(selfCreate.data.objects[0] as object), speeds: SPEEDS }] },
};

describe("taps decode", () => {
  test.each([
    ["SMSG_RAID_INSTANCE_INFO", { locks: [{ map: 249, difficulty: 0, instanceId: 12, locked: true, extended: false, resetInSec: 3600 }] }],
    ["SMSG_RAID_INSTANCE_INFO", { locks: [] }],
    ["SMSG_INSTANCE_RESET", { map: 36 }],
    ["SMSG_INSTANCE_RESET_FAILED", { reason: 0, map: 36 }],
    ["SMSG_UPDATE_INSTANCE_OWNERSHIP", { saved: true }],
    ["SMSG_UPDATE_LAST_INSTANCE", { map: 249 }],
    ["SMSG_INSTANCE_SAVE_CREATED", {}],
    ["SMSG_RAID_INSTANCE_MESSAGE", { type: 4, map: 249, difficulty: 0, timeLeftSec: 86_400, locked: true, extended: false }],
    ["SMSG_RAID_INSTANCE_MESSAGE", { type: 2, map: 249, difficulty: 0, timeLeftSec: 600 }],
    ["MSG_SET_DUNGEON_DIFFICULTY", { difficulty: 1, inGroup: false }],
    ["MSG_SET_RAID_DIFFICULTY", { difficulty: 3, inGroup: true }],
    ["SMSG_INIT_WORLD_STATES", { map: 0, zone: 12, area: 87, states: [{ id: 3191, value: 0 }, { id: 3901, value: 1 }] }],
    ["SMSG_UPDATE_WORLD_STATE", { id: 3191, value: 5 }],
    ["SMSG_WEATHER", { weather: 3, intensity: 0.4, abrupt: false }],
    ["SMSG_LOGIN_SETTIMESPEED", { date: 0x1a96_94b2, time: "2026-10-27 18:50", speed: 0.01666667 }],
    ["SMSG_FORCE_RUN_SPEED_CHANGE", { guid: SELF_GUID, speed: 14 }],
    ["SMSG_FORCE_PITCH_RATE_CHANGE", { guid: SELF_GUID, speed: 3.14 }],
    ["SMSG_THREAT_UPDATE", { unitGuid: CREATURE_GUID, entries: [{ guid: SELF_GUID, threat: 12_550 }] }],
    ["SMSG_HIGHEST_THREAT_UPDATE", { unitGuid: CREATURE_GUID, topGuid: SELF_GUID, entries: [{ guid: SELF_GUID, threat: 100 }] }],
    ["SMSG_THREAT_REMOVE", { unitGuid: CREATURE_GUID, guid: PLAYER_GUID }],
    ["SMSG_THREAT_CLEAR", { unitGuid: CREATURE_GUID }],
    ["SMSG_SPELLDISPELLOG", { targetGuid: CREATURE_GUID, casterGuid: SELF_GUID, spellId: 527, rank: 1, name: "Dispel Magic", auras: [{ spellId: 1243, rank: 1, name: "Power Word: Fortitude" }] }],
    ["SMSG_SPELLSTEALLOG", { targetGuid: CREATURE_GUID, casterGuid: SELF_GUID, spellId: 30449, auras: [{ spellId: 1243 }] }],
    ["SMSG_DISPEL_FAILED", { casterGuid: SELF_GUID, targetGuid: CREATURE_GUID, spellId: 527, auras: [{ spellId: 1243 }, { spellId: 1244 }] }],
  ])("%s", (opcode, data) => {
    expect(isKnownOpcode(opcode)).toBe(true);
    expect(parse(frame(1, opcode, data)).data).toEqual(data);
  });
});

describe("instances and difficulty", () => {
  test("the saved-instance list replaces the last, with the reset as a wall-clock time", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      frame(40, "SMSG_RAID_INSTANCE_INFO", { locks: [{ map: 249, difficulty: 0, instanceId: 12, locked: true, extended: false, resetInSec: 3600 }] }),
    ]);
    expect(cache.self.instanceLocks?.value).toEqual([
      { map: 249, difficulty: 0, instanceId: 12, locked: true, extended: false, resetsAt: TS + 40 + 3_600_000 },
    ]);
    const empty = replay([...loginSequence, selfCreate, frame(41, "SMSG_RAID_INSTANCE_INFO", { locks: [] })]);
    expect(empty.self.instanceLocks?.value).toEqual([]);
  });

  test("dungeon and raid difficulty are named by their own tables", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      frame(40, "MSG_SET_DUNGEON_DIFFICULTY", { difficulty: 1, inGroup: false }),
      frame(41, "MSG_SET_RAID_DIFFICULTY", { difficulty: 3, inGroup: true }),
    ]);
    expect(cache.self.dungeonDifficulty?.value).toEqual({ id: 1, name: "heroic" });
    expect(cache.self.raidDifficulty?.value).toEqual({ id: 3, name: "heroic25" });
  });
});

describe("world states, weather and the game clock", () => {
  test("the init sets the zone's states and an update changes one", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      frame(40, "SMSG_INIT_WORLD_STATES", { map: 0, zone: 12, area: 87, states: [{ id: 3191, value: 0 }, { id: 3901, value: 1 }] }),
      frame(41, "SMSG_UPDATE_WORLD_STATE", { id: 3191, value: 5 }),
      frame(42, "SMSG_UPDATE_WORLD_STATE", { id: 4000, value: 2 }),
    ]);
    expect(cache.self.worldStates?.value).toEqual({ map: 0, zone: 12, area: 87, states: { 3191: 5, 3901: 1, 4000: 2 } });
    expect(cache.self.worldStates?.seq).toBe(42);
  });

  test("an update before any init is not a zone's states", () => {
    const cache = replay([...loginSequence, selfCreate, frame(40, "SMSG_UPDATE_WORLD_STATE", { id: 3191, value: 5 })]);
    expect(cache.self.worldStates).toBeUndefined();
  });

  test("weather is named by WeatherState and the login clock is kept as sent", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      frame(40, "SMSG_WEATHER", { weather: 86, intensity: 0.9, abrupt: true }),
      frame(41, "SMSG_LOGIN_SETTIMESPEED", { date: 0x1a96_94b2, time: "2026-10-27 18:50", speed: 0.01666667 }),
    ]);
    expect(cache.self.weather?.value).toEqual({ id: 86, name: "thunders", intensity: 0.9 });
    expect(cache.self.gameTime?.value).toEqual({ time: "2026-10-27 18:50", date: 0x1a96_94b2, speed: 0.01666667 });
  });
});

describe("own speeds", () => {
  test("seeded by our own create block and moved by our own forced changes only", () => {
    const cache = replay([
      ...loginSequence,
      selfCreateWithSpeeds,
      frame(40, "SMSG_FORCE_RUN_SPEED_CHANGE", { guid: SELF_GUID, speed: 14 }),
      frame(41, "SMSG_FORCE_FLIGHT_SPEED_CHANGE", { guid: SELF_GUID, speed: 26.6 }),
      // a vehicle's own change, sent to the client that drives it
      frame(42, "SMSG_FORCE_RUN_SPEED_CHANGE", { guid: CREATURE_GUID, speed: 3 }),
    ]);
    expect(cache.self.speeds?.value).toEqual({ ...SPEEDS, run: 14, flight: 26.6 });
    expect(cache.self.speeds?.seq).toBe(41);
  });

  test("a forced change before the create block seeds nothing", () => {
    const cache = replay([...loginSequence, frame(16, "SMSG_FORCE_RUN_SPEED_CHANGE", { guid: SELF_GUID, speed: 14 }), selfCreate]);
    expect(cache.self.speeds).toBeUndefined();
  });
});

describe("threat", () => {
  test("the list rides the unit's row in the core's units, the victim kept until it leaves", () => {
    let cache = replay([
      ...loginSequence,
      selfCreate,
      creatureCreate,
      frame(40, "SMSG_HIGHEST_THREAT_UPDATE", { unitGuid: CREATURE_GUID, topGuid: SELF_GUID, entries: [{ guid: SELF_GUID, threat: 12_550 }] }),
      frame(41, "SMSG_THREAT_UPDATE", { unitGuid: CREATURE_GUID, entries: [{ guid: SELF_GUID, threat: 20_000 }, { guid: PLAYER_GUID, threat: 500 }] }),
    ]);
    const row = () => cache.units().find((u) => u.guid === CREATURE_GUID);
    expect(row()?.threat).toEqual({
      topGuid: SELF_GUID,
      entries: [
        { guid: SELF_GUID, threat: 200 },
        { guid: PLAYER_GUID, threat: 5 },
      ],
    });

    cache = replay([
      ...loginSequence,
      selfCreate,
      creatureCreate,
      frame(40, "SMSG_HIGHEST_THREAT_UPDATE", { unitGuid: CREATURE_GUID, topGuid: SELF_GUID, entries: [{ guid: SELF_GUID, threat: 100 }, { guid: PLAYER_GUID, threat: 50 }] }),
      frame(41, "SMSG_THREAT_REMOVE", { unitGuid: CREATURE_GUID, guid: SELF_GUID }),
    ]);
    expect(row()?.threat).toEqual({ topGuid: undefined, entries: [{ guid: PLAYER_GUID, threat: 0.5 }] });

    cache = replay([
      ...loginSequence,
      selfCreate,
      creatureCreate,
      frame(40, "SMSG_THREAT_UPDATE", { unitGuid: CREATURE_GUID, entries: [{ guid: SELF_GUID, threat: 100 }] }),
      frame(41, "SMSG_THREAT_CLEAR", { unitGuid: CREATURE_GUID }),
    ]);
    expect(row()?.threat).toEqual({ topGuid: undefined, entries: [] });
  });

  test("a unit no threat packet named has none, and a list for a unit not in view makes no row", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      creatureCreate,
      frame(40, "SMSG_THREAT_UPDATE", { unitGuid: "999", entries: [{ guid: SELF_GUID, threat: 100 }] }),
    ]);
    expect(cache.units().find((u) => u.guid === CREATURE_GUID)?.threat).toBeUndefined();
    expect(cache.units().find((u) => u.guid === "999")).toBeUndefined();
  });
});
