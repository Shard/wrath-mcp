/**
 * Fields the module now forwards: stand state and shapeshift form on every
 * unit, our own character sheet and rested XP, the glyph slots on
 * `SMSG_TALENTS_INFO`, and `SMSG_EXPLORATION_EXPERIENCE`. Frames are
 * hand-written from module/PROTOCOL.md.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { SELF_GUID } from "./fixtures";

const TS = 1_700_000_000_000;
const MOB = "9001";
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const update = (seq: number, object: unknown) => frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [object] });
const createMob = (seq: number, fields: Record<string, number>) =>
  update(seq, { update: "create", guid: MOB, objectType: "unit", pos: { x: 1, y: 2, z: 3, o: 0 }, fields: { health: 50, maxHealth: 50, level: 3, ...fields } });
const selfValues = (seq: number, fields: Record<string, number>) => update(seq, { update: "values", guid: SELF_GUID, fields });

function replay(list: readonly unknown[]): StateCache {
  const events: GameEvent[] = list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    const schemaError = (parsed.event as { schemaError?: string }).schemaError;
    if (schemaError !== undefined) throw new Error(`schema: ${schemaError}`);
    return parsed.event;
  });
  return StateCache.replay(events, { seed: { guid: SELF_GUID, name: "Fenwick" } });
}

describe("stand state and shapeshift form", () => {
  test("a unit row reads sitting and its form's name; no form reads undefined, as does an uncarried field", () => {
    let row = replay([createMob(1, { standState: 1, shapeshiftForm: 5 })]).units().find((u) => u.guid === MOB)!;
    expect(row).toMatchObject({ sitting: true, shapeshiftForm: "bear" });
    row = replay([createMob(1, { standState: 0, shapeshiftForm: 0 })]).units().find((u) => u.guid === MOB)!;
    expect(row.sitting).toBe(false);
    expect(row.shapeshiftForm).toBeUndefined();
    row = replay([createMob(1, {})]).units().find((u) => u.guid === MOB)!;
    expect(row.sitting).toBe(false);
  });

  test("on self: stand state by id and name, sitting, and the form with 'none'", () => {
    const cache = replay([selfValues(1, { standState: 2, shapeshiftForm: 0 })]);
    expect(cache.self.standState?.value).toEqual({ id: 2, name: "sitChair" });
    expect(cache.self.sitting?.value).toBe(true);
    expect(cache.self.shapeshiftForm?.value).toEqual({ id: 0, name: "none" });
    const later = replay([selfValues(1, { standState: 2 }), selfValues(2, { health: 10, shapeshiftForm: 17 })]);
    expect(later.self.sitting?.value).toBe(true);
    expect(later.self.shapeshiftForm?.value).toEqual({ id: 17, name: "battleStance" });
  });
});

const OTHER = "9002";
const IN_COMBAT = 0x0008_0000;
const selfCreate = (seq: number, fields: Record<string, number>) =>
  update(seq, { update: "create", guid: SELF_GUID, objectType: "player", self: true, fields: { health: 50, maxHealth: 50, level: 1, ...fields } });
const mobValues = (seq: number, fields: Record<string, number>) => update(seq, { update: "values", guid: MOB, fields });
const mobRow = (cache: StateCache) => cache.units().find((u) => u.guid === MOB)!;

describe("a create block states what it leaves out as zero", () => {
  test("a unit with no flag words has none set, stands and is in no form", () => {
    const row = mobRow(replay([createMob(1, {})]));
    expect(row).toMatchObject({
      inCombat: false, stunned: false, skinnable: false, lootable: false, tapped: false, tappedByYou: false, sitting: false, roles: [],
    });
    expect(row.shapeshiftForm).toBeUndefined();
  });

  test("a unit known from a values block alone stays unobserved", () => {
    const row = mobRow(replay([mobValues(1, { health: 40 })]));
    expect(row).toMatchObject({ inCombat: undefined, lootable: undefined, sitting: undefined });
  });

  test("a values block that omits the field leaves it unchanged; a later create resets it", () => {
    const set = replay([createMob(1, { unitFlags: IN_COMBAT, dynamicFlags: 0x1, standState: 1 }), mobValues(2, { health: 40 })]);
    expect(mobRow(set)).toMatchObject({ inCombat: true, lootable: true, sitting: true });
    const reset = replay([createMob(1, { unitFlags: IN_COMBAT, standState: 1 }), mobValues(2, { health: 40 }), createMob(3, {})]);
    expect(mobRow(reset)).toMatchObject({ inCombat: false, sitting: false });
  });

  test("a fresh character reads standing, in no form, no rested XP, no flags", () => {
    const cache = replay([selfCreate(1, {})]);
    expect(cache.self.standState?.value).toEqual({ id: 0, name: "stand" });
    expect(cache.self.sitting?.value).toBe(false);
    expect(cache.self.shapeshiftForm?.value).toEqual({ id: 0, name: "none" });
    expect(cache.self.restedXp?.value).toBe(0);
    expect(cache.self.resting?.value).toBe(false);
    expect(cache.self.ghost?.value).toBe(false);
    expect(cache.self.inCombat?.value).toBe(false);
    expect(cache.self.stunned?.value).toBe(false);
    expect(cache.self.mounted?.value).toBe(false);
    expect(cache.self.taxiFlight?.value).toBe(false);
  });

  test("on self a values block without the fields changes nothing, and a later create resets them", () => {
    const fields = { standState: 1, shapeshiftForm: 5, restedXp: 300, playerFlags: 0x20, unitFlags: IN_COMBAT };
    const held = replay([selfCreate(1, fields), selfValues(2, { health: 40 })]);
    expect(held.self.sitting?.value).toBe(true);
    expect(held.self.shapeshiftForm?.value.id).toBe(5);
    expect(held.self.restedXp?.value).toBe(300);
    expect(held.self.resting?.value).toBe(true);
    expect(held.self.inCombat?.value).toBe(true);
    const reset = replay([selfCreate(1, fields), selfValues(2, { health: 40 }), selfCreate(3, {})]);
    expect(reset.self.sitting?.value).toBe(false);
    expect(reset.self.shapeshiftForm?.value.id).toBe(0);
    expect(reset.self.restedXp?.value).toBe(0);
    expect(reset.self.resting?.value).toBe(false);
    expect(reset.self.inCombat?.value).toBe(false);
  });

  test("another player's create invents no PRIVATE field", () => {
    const cache = replay([
      update(1, { update: "create", guid: OTHER, objectType: "player", pos: { x: 1, y: 2, z: 3, o: 0 }, fields: { health: 50, maxHealth: 50, level: 3 } }),
    ]);
    const other = cache.nearby.get(OTHER)!;
    expect(other.fields.get("unitFlags")?.value).toBe(0);
    expect(other.fields.has("restedXp")).toBe(false);
    expect(other.fields.has("playerFlags")).toBe(false);
  });

  test("an item or a game object create is left as the module sent it", () => {
    const cache = replay([update(1, { update: "create", guid: "9100", objectType: "gameObject", fields: { entry: 5 } })]);
    expect([...cache.nearby.get("9100")!.fields.keys()]).toEqual(["entry"]);
  });
});

describe("the character sheet", () => {
  test("stats, armour and resistances, attack power as the server totals it, and the percentages", () => {
    const cache = replay([
      selfValues(1, {
        stat0: 30, stat1: 25, stat2: 28, stat3: 20, stat4: 22,
        resistance0: 410, resistance2: 15,
        attackPower: 100, attackPowerMods: 20, attackPowerMultiplier: 0.1,
        rangedAttackPower: 40,
        critPct: 5.5, dodgePct: 4.25, spellCritPct2: 3.5,
      }),
      selfValues(2, { restedXp: 1200 }),
    ]);
    expect(cache.self.stats?.value).toMatchObject({
      strength: 30, agility: 25, stamina: 28, intellect: 20, spirit: 22,
      armor: 410,
      attackPower: 132,
      rangedAttackPower: 40,
      critPct: 5.5,
      dodgePct: 4.25,
      parryPct: undefined,
    });
    expect(cache.self.stats?.value.resistances).toMatchObject({ fire: 15, holy: undefined });
    expect(cache.self.stats?.value.spellCritPct.fire).toBe(3.5);
    expect(cache.self.restedXp?.value).toBe(1200);
  });

  test("negative mods never take attack power below zero", () => {
    const cache = replay([selfValues(1, { attackPower: 10, attackPowerMods: -30 })]);
    expect(cache.self.stats?.value.attackPower).toBe(0);
  });
});

describe("glyphs and exploration", () => {
  test("the active spec's glyph slots ride the talents", () => {
    const cache = replay([
      frame(1, "SMSG_TALENTS_INFO", {
        pet: false, unspentPoints: 0, specCount: 1, activeSpec: 0,
        specs: [{ talents: [], glyphs: [{ slot: 0, glyphId: 0 }, { slot: 1, glyphId: 251, spellId: 56368, name: "Glyph of Testing" }] }],
      }),
    ]);
    expect(cache.talents()?.glyphs).toEqual([
      { slot: 0, glyphId: 0, spellId: undefined, name: undefined },
      { slot: 1, glyphId: 251, spellId: 56368, name: "Glyph of Testing" },
    ]);
  });

  test("SMSG_EXPLORATION_EXPERIENCE decodes with the area's name", () => {
    const parsed = parseEventFrame(JSON.stringify(frame(1, "SMSG_EXPLORATION_EXPERIENCE", { areaId: 87, areaName: "Testvale", xp: 45 })));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.event.data).toEqual({ areaId: 87, areaName: "Testvale", xp: 45 });
  });
});
