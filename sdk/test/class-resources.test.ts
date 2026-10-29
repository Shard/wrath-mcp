/**
 * Class resources and the bars a client draws for them: combo points, a Death
 * Knight's runes, our own channel, totems and the mirror timers, folded into
 * `state.self` from hand-written frames in PROTOCOL.md's shapes.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { CREATURE_GUID, loginSequence, SELF_GUID, selfCreate } from "./fixtures";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const selfValues = (seq: number, fields: Record<string, unknown>) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] });
const OTHER = "9";
const TOTEM_GUID = "17370386424495620200";

function replay(list: readonly unknown[]): StateCache {
  const events: GameEvent[] = list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    if ((parsed.event as { schemaError?: string }).schemaError !== undefined) throw new Error(`schema: ${(parsed.event as { schemaError?: string }).schemaError}`);
    return parsed.event;
  });
  return StateCache.replay(events, { seed: { guid: SELF_GUID, name: "Fenwick" } });
}

describe("combo points", () => {
  test("each change replaces the count and its target; an empty target reads undefined", () => {
    let cache = replay([...loginSequence, selfCreate, frame(40, "SMSG_UPDATE_COMBO_POINTS", { targetGuid: CREATURE_GUID, points: 3 })]);
    expect(cache.self.comboPoints?.value).toEqual({ points: 3, targetGuid: CREATURE_GUID });
    cache = replay([
      ...loginSequence,
      selfCreate,
      frame(40, "SMSG_UPDATE_COMBO_POINTS", { targetGuid: CREATURE_GUID, points: 3 }),
      frame(41, "SMSG_UPDATE_COMBO_POINTS", { targetGuid: "0", points: 0 }),
    ]);
    expect(cache.self.comboPoints?.value).toEqual({ points: 0, targetGuid: undefined });
    expect(cache.self.comboPoints?.seq).toBe(41);
  });
});

describe("runes", () => {
  test("a Death Knight starts in the base layout with readiness unknown", () => {
    const cache = replay([...loginSequence, selfCreate, selfValues(40, { class: 6 })]);
    expect(cache.self.runes?.value.map((r) => r.type)).toEqual(["blood", "blood", "unholy", "unholy", "frost", "frost"]);
    expect(cache.self.runes?.value.every((r) => r.ready === undefined)).toBe(true);
  });

  test("an own rune list sets readiness, a conversion sets a type, and another caster's list is ignored", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      selfValues(40, { class: 6 }),
      frame(41, "SMSG_SPELL_GO", {
        casterGuid: SELF_GUID, spellId: 45477, hitGuids: [CREATURE_GUID], misses: [],
        runesBefore: 0x3f, runesAfter: 0x2f, runesSpent: [{ index: 4, passed: 0 }],
      }),
      frame(42, "SMSG_CONVERT_RUNE", { index: 0, runeType: 3 }),
      frame(43, "SMSG_SPELL_GO", { casterGuid: OTHER, spellId: 45477, hitGuids: [], misses: [], runesBefore: 0x3f, runesAfter: 0 }),
    ]);
    const runes = cache.self.runes?.value ?? [];
    expect(runes.map((r) => r.type)).toEqual(["death", "blood", "unholy", "unholy", "frost", "frost"]);
    expect(runes.map((r) => r.ready)).toEqual([true, true, true, true, false, true]);
  });

  test("a relog starts the runes over from the base layout", () => {
    const login = (loginSequence as { opcode: string }[]).find((f) => f.opcode === "SMSG_LOGIN_VERIFY_WORLD")!;
    const cache = replay([
      ...loginSequence,
      selfCreate,
      selfValues(40, { class: 6 }),
      frame(41, "SMSG_CONVERT_RUNE", { index: 0, runeType: 3 }),
      frame(42, "SMSG_SPELL_GO", { casterGuid: SELF_GUID, spellId: 45477, hitGuids: [], misses: [], runesBefore: 0x3f, runesAfter: 0x2f }),
      { ...login, seq: 43, ts: TS + 43 },
      selfValues(44, { class: 6 }),
    ]);
    expect(cache.self.runes?.value.map((r) => r.type)).toEqual(["blood", "blood", "unholy", "unholy", "frost", "frost"]);
    expect(cache.self.runes?.value.every((r) => r.ready === undefined)).toBe(true);
  });

  test("any other class has no runes", () => {
    expect(replay([...loginSequence, selfCreate, selfValues(40, { class: 1 })]).self.runes).toBeUndefined();
  });
});

describe("channeling", () => {
  const start = frame(41, "MSG_CHANNEL_START", { casterGuid: SELF_GUID, spellId: 5143, name: "Test Channel", durationMs: 3000 });

  test("an own channel start sets it with its end and target; a pushback moves the end; the update with no time ends it", () => {
    let cache = replay([...loginSequence, selfCreate, frame(40, "SMSG_SPELL_GO", { casterGuid: SELF_GUID, spellId: 5143, hitGuids: [], misses: [] }), start]);
    expect(cache.self.channeling?.value).toEqual({ spellId: 5143, name: "Test Channel", endsAt: TS + 41 + 3000, targetGuid: undefined });
    expect(cache.self.casting).toBeUndefined();
    cache = replay([...loginSequence, selfCreate, start, selfValues(42, { channelObjectGuid: CREATURE_GUID, channelSpell: 5143 }), frame(43, "MSG_CHANNEL_UPDATE", { casterGuid: SELF_GUID, timeMs: 2500 })]);
    expect(cache.self.channeling?.value).toMatchObject({ targetGuid: CREATURE_GUID, endsAt: TS + 43 + 2500 });
    cache = replay([...loginSequence, selfCreate, start, frame(43, "MSG_CHANNEL_UPDATE", { casterGuid: SELF_GUID, timeMs: 0 })]);
    expect(cache.self.channeling).toBeUndefined();
  });

  test("another unit's channel is not ours; our own interruption or a cleared field ends ours", () => {
    expect(replay([...loginSequence, selfCreate, frame(41, "MSG_CHANNEL_START", { casterGuid: OTHER, spellId: 5143, durationMs: 3000 })]).self.channeling).toBeUndefined();
    expect(replay([...loginSequence, selfCreate, start, frame(42, "SMSG_SPELL_FAILURE", { casterGuid: SELF_GUID, spellId: 5143, result: 40 })]).self.channeling).toBeUndefined();
    expect(replay([...loginSequence, selfCreate, start, selfValues(42, { channelSpell: 0, channelObjectGuid: "0" })]).self.channeling).toBeUndefined();
  });
});

describe("totems", () => {
  test("a created totem fills its slot, a new one replaces it, and the object's destroy removes it", () => {
    const created = (seq: number, slot: number, guid: string, spellId: number) =>
      frame(seq, "SMSG_TOTEM_CREATED", { slot, guid, durationMs: 120_000, spellId, name: "Test Totem" });
    let cache = replay([...loginSequence, selfCreate, created(40, 0, TOTEM_GUID, 3599), created(41, 1, "77", 8071)]);
    expect(cache.self.totems.map((t) => [t.slot, t.element, t.guid])).toEqual([[0, "fire", TOTEM_GUID], [1, "earth", "77"]]);
    expect(cache.self.totems[0]?.expiresAt).toBe(TS + 40 + 120_000);
    cache = replay([...loginSequence, selfCreate, created(40, 0, TOTEM_GUID, 3599), created(41, 0, "78", 3599)]);
    expect(cache.self.totems.map((t) => t.guid)).toEqual(["78"]);
    cache = replay([...loginSequence, selfCreate, created(40, 0, TOTEM_GUID, 3599), frame(41, "SMSG_DESTROY_OBJECT", { guid: TOTEM_GUID, onDeath: false })]);
    expect(cache.self.totems).toEqual([]);
  });
});

describe("mirror timers", () => {
  test("a start shows a bar by type and a stop removes it", () => {
    const breath = frame(40, "SMSG_START_MIRROR_TIMER", { type: 1, value: 180_000, max: 180_000, scale: -1, paused: false, spellId: 0 });
    let cache = replay([...loginSequence, selfCreate, breath]);
    expect(cache.self.mirrorTimers).toMatchObject([{ type: "breath", typeId: 1, value: 180_000, max: 180_000, scale: -1, paused: false }]);
    cache = replay([...loginSequence, selfCreate, breath, frame(41, "SMSG_STOP_MIRROR_TIMER", { type: 1 })]);
    expect(cache.self.mirrorTimers).toEqual([]);
  });
});
