/**
 * The unit state flags named off the `unitFlags` and `dynamicFlags` the module
 * serves: `UnitView.inCombat` / `stunned` / `skinnable` / `lootable` / `tapped`
 * / `tappedByYou` and `state.self.inCombat` / `stunned`. Bit values are AzerothCore's (`UnitDefines.h`, `SharedDefines.h`);
 * the frames are hand-written from module/PROTOCOL.md.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { SELF_GUID } from "./fixtures";

const TS = 1_700_000_000_000;
const STUNNED = 0x0004_0000;
const IN_COMBAT = 0x0008_0000;
const TAXI = 0x0010_0000;
const SKINNABLE = 0x0400_0000;
const LOOTABLE = 0x1;
const TAPPED = 0x4;
const TAPPED_BY_PLAYER = 0x8;

const frame = (seq: number, data: unknown) => ({ seq, opcode: "SMSG_UPDATE_OBJECT", opcodeId: 0x0a9, ts: TS + seq, data });
const toEvents = (frames: readonly unknown[]): GameEvent[] =>
  frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

const MOB = "9001";
const create = (seq: number, guid: string, objectType: string, fields: Record<string, number>) =>
  frame(seq, {
    blocks: 1,
    objects: [{ update: "create", guid, objectType, pos: { x: 1, y: 2, z: 3, o: 0 }, fields: { health: 50, maxHealth: 50, level: 3, ...fields } }],
  });
const values = (seq: number, guid: string, fields: Record<string, number>) =>
  frame(seq, { blocks: 1, objects: [{ update: "values", guid, fields }] });

const replay = (frames: readonly unknown[]) => StateCache.replay(toEvents(frames), { seed: { guid: SELF_GUID, name: "Fenwick" } });
const mob = (cache: StateCache) => cache.units().find((u) => u.guid === MOB)!;

describe("UnitView: unit state flags", () => {
  test("a create block with neither field states every flag false; a values block alone leaves them undefined", () => {
    const created = mob(replay([create(1, MOB, "unit", {})]));
    const seen = mob(replay([values(1, MOB, { health: 40 })]));
    for (const key of ["inCombat", "stunned", "skinnable", "lootable", "tapped", "tappedByYou"] as const) {
      expect(created[key]).toBe(false);
      expect(seen[key]).toBeUndefined();
    }
  });

  test("unitFlags names in combat, stunned and skinnable", () => {
    const row = mob(replay([create(1, MOB, "unit", { unitFlags: IN_COMBAT | SKINNABLE })]));
    expect(row).toMatchObject({ inCombat: true, stunned: false, skinnable: true });
    // dynamicFlags absent from a create block is 0: nothing lootable or tapped.
    expect(row).toMatchObject({ lootable: false, tapped: false, tappedByYou: false });
  });

  test("a raised flag clears on the next delta that carries the field, and survives one that does not", () => {
    const stunned = replay([create(1, MOB, "unit", { unitFlags: STUNNED }), values(2, MOB, { health: 40 })]);
    expect(mob(stunned)).toMatchObject({ stunned: true, inCombat: false, health: 40 });
    const cleared = replay([create(1, MOB, "unit", { unitFlags: STUNNED }), values(2, MOB, { unitFlags: IN_COMBAT })]);
    expect(mob(cleared)).toMatchObject({ stunned: false, inCombat: true });
  });

  test("an unrelated bit (taxi flight) names none of them", () => {
    expect(mob(replay([create(1, MOB, "unit", { unitFlags: TAXI })]))).toMatchObject({
      inCombat: false,
      stunned: false,
      skinnable: false,
    });
  });

  test("dynamicFlags names lootable, and the corpse stops being lootable when the bit drops", () => {
    const lootable = replay([create(1, MOB, "unit", { health: 0, dynamicFlags: LOOTABLE })]);
    expect(mob(lootable)).toMatchObject({ lootable: true, tapped: false, tappedByYou: false });
    const looted = replay([create(1, MOB, "unit", { health: 0, dynamicFlags: LOOTABLE }), values(2, MOB, { dynamicFlags: 0 })]);
    expect(mob(looted)).toMatchObject({ lootable: false });
  });

  test("tapped by you is both bits, tapped by someone else is the first alone, untapped is neither", () => {
    const mine = replay([create(1, MOB, "unit", { dynamicFlags: TAPPED | TAPPED_BY_PLAYER })]);
    expect(mob(mine)).toMatchObject({ tapped: true, tappedByYou: true });
    const theirs = replay([create(1, MOB, "unit", { dynamicFlags: TAPPED })]);
    expect(mob(theirs)).toMatchObject({ tapped: true, tappedByYou: false });
    const free = replay([create(1, MOB, "unit", { dynamicFlags: 0 })]);
    expect(mob(free)).toMatchObject({ tapped: false, tappedByYou: false });
  });

  test("a delta without dynamicFlags keeps the last tap reading", () => {
    const cache = replay([create(1, MOB, "unit", { dynamicFlags: TAPPED | TAPPED_BY_PLAYER }), values(2, MOB, { unitFlags: IN_COMBAT })]);
    expect(mob(cache)).toMatchObject({ tappedByYou: true, inCombat: true });
  });

  test("a game object has the flags undefined, whatever its fields carry", () => {
    const row = mob(replay([create(1, MOB, "gameObject", { unitFlags: IN_COMBAT, dynamicFlags: LOOTABLE })]));
    for (const key of ["inCombat", "stunned", "skinnable", "lootable", "tapped", "tappedByYou"] as const) {
      expect(row[key]).toBeUndefined();
    }
  });

  test("a player row reads them too", () => {
    const row = mob(replay([create(1, MOB, "player", { unitFlags: STUNNED | IN_COMBAT })]));
    expect(row).toMatchObject({ stunned: true, inCombat: true, skinnable: false });
  });
});

describe("state.self: inCombat and stunned", () => {
  const selfValues = (seq: number, fields: Record<string, number>) => values(seq, SELF_GUID, fields);

  test("undefined until a block carried unitFlags", () => {
    const cache = replay([selfValues(1, { health: 90 })]);
    expect(cache.self.inCombat).toBeUndefined();
    expect(cache.self.stunned).toBeUndefined();
  });

  test("read from the bits, with the packet's provenance", () => {
    const cache = replay([selfValues(3, { unitFlags: IN_COMBAT })]);
    expect(cache.self.inCombat).toEqual({ value: true, seq: 3, ts: TS + 3 });
    expect(cache.self.stunned).toEqual({ value: false, seq: 3, ts: TS + 3 });
    const both = replay([selfValues(3, { unitFlags: IN_COMBAT | STUNNED })]);
    expect(both.self.stunned?.value).toBe(true);
  });

  test("a delta without unitFlags leaves the last reading standing, and one carrying it clears", () => {
    const held = replay([selfValues(1, { unitFlags: STUNNED }), selfValues(2, { health: 80 })]);
    expect(held.self.stunned).toEqual({ value: true, seq: 1, ts: TS + 1 });
    const cleared = replay([selfValues(1, { unitFlags: STUNNED | IN_COMBAT }), selfValues(2, { unitFlags: 0 })]);
    expect(cleared.self.stunned).toEqual({ value: false, seq: 2, ts: TS + 2 });
    expect(cleared.self.inCombat).toEqual({ value: false, seq: 2, ts: TS + 2 });
  });
});
