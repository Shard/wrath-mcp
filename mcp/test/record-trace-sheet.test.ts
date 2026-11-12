/**
 * The character sheet in the trace recorder (`record/trace-sheet.ts`,
 * `record/trace-recorder.ts`): money, equipment, worn bags, what is carried,
 * durability, the quest log, skills, visible reputation and turn-ins, read off
 * a real SDK cache fed hand-written frames, and the item and quest dictionary
 * entries a drain carries. Ids and names are invented; the field names are
 * the module's (module/PROTOCOL.md, and `sdk/test/fixtures.ts`).
 */
import { describe, expect, test } from "bun:test";
import { EventStream, StateCache } from "@wrathbench/sdk";
import { TRACE_SHEET_MIN_GAP_MS, TraceRecorder } from "../src/record/trace-recorder";
import { applySheetPatch, SHEET_KEY_LEN, SHEET_KEYS, type TraceKeyData, type TraceRow, type TraceSheet, type TraceStateDelta } from "../src/record/trace-row";

const SELF = "7";
/** An item guid as the module packs one: high half 0x40000000, low half `n`. */
const HI = 0x4000_0000;
const itemGuid = (lo: number): string => ((BigInt(HI) << 32n) | BigInt(lo)).toString(10);

const SWORD = 61001;
const POUCH = 61002;
const STONE = 61003;
const RING = 61004;
const QUEST = 7001;
const QUEST_ITEM = 61009;

function rig(opts: { guard?: boolean } = {}) {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const cache = new StateCache({ seed: { guid: SELF, name: "Fenwick" } });
  events.onAny((e) => {
    // A frame the SDK's schema refuses is never folded: fail loudly instead.
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    cache.apply(e);
  });
  // The recorder must read the raw fields and never the SDK's joined views:
  // `questLog` re-walks the bags per collect objective, `inventory` and `bag()`
  // decode every item's enchantments. A guard that throws on them pins it.
  const banned = new Set(["questLog", "inventory", "bag", "bank", "skills", "snapshot", "quest", "itemTexts"]);
  const state = opts.guard === false
    ? cache
    : (new Proxy(cache, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && banned.has(prop)) throw new Error(`the recorder read ${prop}`);
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as StateCache);
  let clock = 1_000_000;
  const rec = new TraceRecorder({ state, events, now: () => clock, pollMs: 60_000 });
  let seq = 1;
  const feed = (opcode: string, data: unknown, ts: number): void => {
    clock = Math.max(clock, ts);
    events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId: 1, ts, data }));
  };
  const update = (objects: unknown[], ts: number): void => feed("SMSG_UPDATE_OBJECT", { blocks: objects.length, objects }, ts);
  const values = (guid: string, fields: Record<string, number | string>, ts: number): void => update([{ update: "values", guid, fields }], ts);
  const create = (guid: string, objectType: string, fields: Record<string, number | string>, self = false) => ({
    update: "create",
    guid,
    objectType,
    ...(self ? { self: true } : {}),
    fields,
  });
  const drain = (): TraceRow[] => rec.drain().rows;
  const sheetRows = (rows: TraceRow[]): TraceStateDelta[] =>
    rows.filter((r) => r.kind === "state" && SHEET_KEYS.some((k) => Object.hasOwn(r.data as object, k) || Object.hasOwn(r.data as object, "qdone"))).map((r) => r.data as TraceStateDelta);
  return {
    cache,
    rec,
    feed,
    update,
    values,
    create,
    drain,
    sheetRows,
    at: (t: number) => {
      clock = t;
    },
    clock: () => clock,
  };
}

/** The login a fresh session sees: the faction list, then the self create block and the items it names. */
function login(r: ReturnType<typeof rig>, ts: number): void {
  r.feed(
    "SMSG_INITIALIZE_FACTIONS",
    {
      count: 128,
      factions: [
        { flags: 1, visible: true, atWar: false, repListId: 5, factionId: 9001, name: "Test Faction", standing: 120, base: 0, reputation: 120 },
        { flags: 0, visible: false, atWar: false, repListId: 6, factionId: 9002, name: "Hidden Faction", standing: 50, base: 0, reputation: 50 },
        { flags: 1, visible: true, atWar: false, repListId: 7, name: "Unmapped", standing: 10 },
      ],
    },
    ts,
  );
  r.update(
    [
      r.create(
        SELF,
        "player",
        {
          level: 12,
          money: 4321,
          invSlot0Lo: 1,
          invSlot0Hi: HI,
          invSlot19Lo: 2,
          invSlot19Hi: HI,
          invSlot23Lo: 3,
          invSlot23Hi: HI,
          quest0Id: QUEST,
          quest0State: 0,
          quest0CountsLo: 2 | (1 << 16),
          skill0Id: 43,
          skill0Value: 31,
          skill0Max: 60,
          skill1Id: 6,
          skill1Value: 5,
          skill1Max: 5,
        },
        true,
      ),
      r.create(itemGuid(1), "item", { entry: SWORD, stackCount: 1, durability: 40, maxDurability: 50, randomPropertyId: -77, suffixName: "of the Badger" }),
      r.create(itemGuid(2), "container", { entry: POUCH, numSlots: 6, bagSlot2Lo: 4, bagSlot2Hi: HI }),
      r.create(itemGuid(3), "item", { entry: STONE, stackCount: 5 }),
      r.create(itemGuid(4), "item", { entry: RING, stackCount: 1 }),
    ],
    ts + 10,
  );
}

const sheetOfKey = (row: TraceRow): TraceSheet => {
  const d = row.data as TraceKeyData;
  return { money: d.money, equip: d.equip, bags: d.bags, inv: d.inv, dur: d.dur, quests: d.quests, rep: d.rep, skills: d.skills };
};

describe("trace recorder: the character sheet", () => {
  test("null until this process folds the character's own create block; a reattach restates only position and level", () => {
    const r = rig();
    r.rec.start();
    const [opening] = r.drain();
    expect(sheetOfKey(opening!)).toEqual({ money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null });

    // A restarted child: the module's reattach snapshot, then a values delta.
    // The cache now has a level and a money field but has never seen the
    // slots, so its empty bags are "not seen", and the sheet says nothing.
    r.feed("WB_SESSION_STATE", { character: "Fenwick", guid: SELF, inWorld: true, map: 0, x: 1, y: 2, z: 3, o: 0, level: 12 }, 1_001_000);
    r.values(SELF, { money: 999 }, 1_002_000);
    r.at(1_010_000);
    r.rec.poll();
    const rows = r.drain();
    const key = rows.find((x) => x.kind === "key")!;
    expect(sheetOfKey(key).inv).toBeNull();
    expect(sheetOfKey(key).money).toBeNull();
    expect(r.sheetRows(rows)).toEqual([]);
    r.rec.stop();
  });

  test("read from the raw fields: money, equipment with its random property, bags, what is carried, durability, quests, skills, visible reputation", () => {
    const r = rig();
    r.rec.start();
    r.drain();
    login(r, 1_100_000);
    r.at(1_102_000);
    r.rec.poll();
    const [delta, ...more] = r.sheetRows(r.drain());
    expect(more).toEqual([]);
    expect(delta).toEqual({
      money: 4321,
      equip: [[0, SWORD, -77]],
      bags: [[19, POUCH, 6]],
      // The worn bag's slot 2 first (bag 19), then the backpack (bag 255).
      inv: [
        [19, 2, RING],
        [255, 23, STONE, 5],
      ],
      dur: [[0, 40, 50]],
      quests: [[0, QUEST, 0, 2, 1]],
      // Visible, with a faction id: the hidden row and the unmapped one are not carried.
      rep: [[9001, 120]],
      skills: [
        [6, 5, 5],
        [43, 31, 60],
      ],
    });
    // A key row in the same process states the whole sheet.
    r.feed("WB_SESSION_STATE", { character: "Fenwick", guid: SELF, inWorld: true, map: 0, x: 1, y: 2, z: 3, o: 0, level: 12 }, 1_103_000);
    const key = r.drain().find((x) => x.kind === "key")!;
    expect(sheetOfKey(key)).toMatchObject({ money: 4321, inv: delta!.inv, rep: [[9001, 120]] });
    r.rec.stop();
  });

  test("the keyring and the currency slots are carried, as bag 255 at their own slots; the bank and the buyback slots are never read", () => {
    const KEY = 61020;
    const TOKEN = 61021;
    const BANKED = 61022;
    const SOLD = 61023;
    const r = rig();
    r.rec.start();
    r.drain();
    login(r, 1_100_000);
    // Each slot a guid, each guid a created item: what is not read is not
    // missing an item, it is never looked at.
    const slots: [slot: number, lo: number, entry: number, count: number][] = [
      [39, 20, BANKED, 1],
      [66, 21, BANKED, 1],
      [73, 22, BANKED, 1],
      [74, 23, SOLD, 1],
      [85, 24, SOLD, 1],
      [86, 25, KEY, 1],
      [117, 26, KEY, 1],
      [118, 27, TOKEN, 12],
      [149, 28, TOKEN, 3],
    ];
    const fields: Record<string, number> = {};
    for (const [slot, lo] of slots) {
      fields[`invSlot${slot}Lo`] = lo;
      fields[`invSlot${slot}Hi`] = HI;
    }
    r.update(
      [
        { update: "values", guid: SELF, fields },
        ...slots.map(([, lo, entry, count]) => r.create(itemGuid(lo), "item", count === 1 ? { entry } : { entry, stackCount: count })),
      ],
      1_100_100,
    );
    r.at(1_102_000);
    r.rec.poll();
    const [delta] = r.sheetRows(r.drain());
    expect(delta!.inv).toEqual([
      [19, 2, RING],
      [255, 23, STONE, 5],
      [255, 86, KEY],
      [255, 117, KEY],
      [255, 118, TOKEN, 12],
      [255, 149, TOKEN, 3],
    ]);
    // A key moved off the keyring is a removal at its slot, like any other.
    r.values(SELF, { invSlot117Lo: 0, invSlot117Hi: 0 }, 1_103_000);
    r.at(1_105_000);
    r.rec.poll();
    const [moved] = r.sheetRows(r.drain());
    expect(moved!.inv).toEqual([[255, 117]]);
    r.rec.stop();
  });

  test("a change is a patch: a looted stack is one row, a moved item two, a removal its key alone, and nothing unchanged is resent", () => {
    const r = rig();
    r.rec.start();
    login(r, 1_100_000);
    r.at(1_102_000);
    r.rec.poll();
    r.drain();
    // Loot: a new item in backpack slot 24, and the stack in 23 grows.
    r.update([r.create(itemGuid(5), "item", { entry: QUEST_ITEM, stackCount: 1 })], 1_103_000);
    r.values(SELF, { invSlot24Lo: 5, invSlot24Hi: HI }, 1_103_010);
    r.values(itemGuid(3), { stackCount: 6 }, 1_103_020);
    r.at(1_104_000);
    r.rec.poll();
    let rows = r.drain();
    expect(r.sheetRows(rows)).toEqual([
      {
        inv: [
          [255, 23, STONE, 6],
          [255, 24, QUEST_ITEM],
        ],
      },
    ]);
    // Stamped with when the cache saw the change, not when the poll ran.
    expect(rows.find((x) => x.kind === "state")!.ts).toBe(1_103_020);
    // The ring leaves the worn bag (sold): its row goes as [bag, slot].
    r.values(itemGuid(2), { bagSlot2Lo: 0, bagSlot2Hi: 0 }, 1_105_000);
    r.update([], 1_105_001);
    r.at(1_106_000);
    r.rec.poll();
    rows = r.drain();
    expect(r.sheetRows(rows)).toEqual([{ inv: [[19, 2]] }]);
    r.rec.stop();
  });

  test("read at most once a second and only after a packet that can change it; the delay never moves the stamp", () => {
    const r = rig({ guard: false });
    const fields = r.cache.self.fields;
    let reads = 0;
    const get = fields.get.bind(fields);
    fields.get = (k: string) => {
      if (k === "invSlot0Lo") reads++;
      return get(k);
    };
    r.rec.start();
    login(r, 1_100_000);
    r.at(1_102_000);
    r.rec.poll();
    const afterLogin = reads;
    // No packet: the poll does not read the sheet at all.
    for (let i = 1; i <= 8; i++) {
      r.at(1_102_000 + i * 250);
      r.rec.poll();
    }
    expect(reads).toBe(afterLogin);
    // A packet, but inside the gap: no read until the gap has passed.
    r.drain();
    r.values(SELF, { money: 5000 }, 1_104_100);
    r.at(1_104_200);
    r.rec.poll();
    r.at(1_104_400);
    r.rec.poll();
    expect(r.sheetRows(r.drain())).toEqual([{ money: 5000 }]);
    r.values(SELF, { money: 6000 }, 1_104_500);
    r.at(1_104_600);
    r.rec.poll();
    expect(r.drain()).toEqual([]);
    r.at(1_104_400 + TRACE_SHEET_MIN_GAP_MS);
    r.rec.poll();
    const rows = r.drain();
    expect(r.sheetRows(rows)).toEqual([{ money: 6000 }]);
    expect(rows[0]!.ts).toBe(1_104_500);
    r.rec.stop();
  });

  test("turn-ins: each receipt is a qdone, the same quest twice is twice, and they need no create block", () => {
    const r = rig();
    r.rec.start();
    r.drain();
    r.feed("SMSG_QUESTGIVER_QUEST_COMPLETE", { questId: QUEST, xp: 100, money: 10 }, 1_200_000);
    r.rec.poll();
    expect(r.sheetRows(r.drain())).toEqual([{ qdone: [QUEST] }]);
    r.feed("SMSG_QUESTGIVER_QUEST_COMPLETE", { questId: QUEST, xp: 100, money: 10 }, 1_200_500);
    r.feed("SMSG_QUESTGIVER_QUEST_COMPLETE", { questId: QUEST + 1, xp: 100, money: 10 }, 1_200_600);
    r.rec.poll();
    const rows = r.drain();
    expect(r.sheetRows(rows)).toEqual([{ qdone: [QUEST, QUEST + 1] }]);
    expect(rows[0]!.ts).toBe(1_200_600);
    // Never state: no key row carries one.
    r.feed("WB_SESSION_STATE", { character: "Fenwick", guid: SELF, inWorld: true, map: 0, x: 1, y: 2, z: 3, o: 0, level: 12 }, 1_201_000);
    expect(Object.hasOwn(r.drain().find((x) => x.kind === "key")!.data as object, "qdone")).toBe(false);
    r.rec.stop();
  });

  test("reputation is read again only after a faction packet, and moves as a patch", () => {
    const r = rig({ guard: false });
    let calls = 0;
    const rep = r.cache.reputation.bind(r.cache);
    r.cache.reputation = () => {
      calls++;
      return rep();
    };
    r.rec.start();
    login(r, 1_100_000);
    r.at(1_102_000);
    r.rec.poll();
    r.drain();
    expect(calls).toBe(1);
    r.values(SELF, { money: 1 }, 1_103_000);
    r.at(1_104_000);
    r.rec.poll();
    expect(calls).toBe(1);
    r.feed("SMSG_SET_FACTION_STANDING", { showVisual: true, factions: [{ repListId: 5, factionId: 9001, standing: 170 }] }, 1_105_000);
    r.at(1_106_000);
    r.rec.poll();
    expect(calls).toBe(2);
    expect(r.sheetRows(r.drain())).toEqual([{ money: 1 }, { rep: [[9001, 170]] }]);
    r.rec.stop();
  });

  test("names: each item once, its template's name, and its random property's suffix by id; a quest's needs as numbers; an id waits for its answer", () => {
    const r = rig();
    r.rec.start();
    login(r, 1_100_000);
    r.feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: SWORD, found: true, name: "Test Blade", quality: 2, description: "flavour text" }, 1_100_100);
    r.feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: STONE, found: true, name: "Test Stone", quality: 1 }, 1_100_200);
    r.at(1_102_000);
    r.rec.poll();
    let d = r.rec.drain().dict;
    expect(d?.items).toEqual([
      [SWORD, 2, "Test Blade"],
      [STONE, 1, "Test Stone"],
    ]);
    // The suffix rides beside the template's name, keyed by the id the row carries; the description never.
    expect(d?.rands).toEqual([[-77, "of the Badger"]]);
    expect(JSON.stringify(d)).not.toContain("flavour text");
    expect(d?.quests).toBeUndefined();
    // The pouch, the ring and the quest are answered later: each is named then, once.
    r.feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: POUCH, found: true, name: "Test Pouch", quality: 1 }, 1_103_000);
    r.feed(
      "SMSG_QUEST_QUERY_RESPONSE",
      {
        questId: QUEST,
        method: 2,
        level: 10,
        minLevel: 8,
        type: 0,
        suggestedPlayers: 0,
        title: "A Title",
        objectives: "Objective text",
        details: "Details text",
        areaDescription: "",
        completedText: "",
        requiredNpcOrGo: [
          { entry: 1234, count: 8, text: "" },
          { entry: 0x80000000 | 55, count: 1, text: "Use it" },
          { entry: 0, count: 0, text: "" },
          { entry: 0, count: 0, text: "" },
        ],
        requiredItems: [
          { itemId: QUEST_ITEM, count: 4 },
          { itemId: 0, count: 0 },
        ],
      },
      1_103_100,
    );
    r.feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: QUEST_ITEM, found: true, name: "Test Token", quality: 1 }, 1_103_200);
    r.at(1_104_000);
    r.rec.poll();
    d = r.rec.drain().dict;
    expect(d?.items).toEqual([
      [POUCH, 1, "Test Pouch"],
      [QUEST_ITEM, 1, "Test Token"],
    ]);
    expect(d?.quests).toEqual([[QUEST, [8, 1, 0, 0, [QUEST_ITEM, 4]]]]);
    // Nothing is resent, whatever moves: another item with a suffix already named
    // is not named again, and a property the module served no text for has no entry.
    r.values(itemGuid(3), { stackCount: 9, randomPropertyId: 5 }, 1_105_000);
    r.values(itemGuid(4), { randomPropertyId: -77, suffixName: "of the Badger" }, 1_105_000);
    r.at(1_106_000);
    r.rec.poll();
    const last = r.rec.drain();
    expect(last.dict).toBeUndefined();
    expect(r.sheetRows(last.rows).at(-1)?.inv).toEqual([
      [19, 2, RING, 1, -77],
      [255, 23, STONE, 9, 5],
    ]);
    r.rec.stop();
  });

  test("the patches folded onto the first read are what a fresh read says, at every step", () => {
    const r = rig();
    r.rec.start();
    login(r, 1_100_000);
    const fold: TraceSheet = { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null };
    const apply = (rows: TraceRow[]): void => {
      for (const row of rows) {
        if (row.kind === "key") Object.assign(fold, sheetOfKey(row));
        if (row.kind !== "state") continue;
        const d = row.data as TraceStateDelta;
        if (d.money !== undefined) fold.money = d.money;
        for (const k of Object.keys(SHEET_KEY_LEN) as (keyof typeof SHEET_KEY_LEN)[]) {
          const p = d[k];
          if (p !== undefined) (fold as unknown as Record<string, unknown>)[k] = applySheetPatch(fold[k], p, SHEET_KEY_LEN[k]);
        }
      }
    };
    let t = 1_102_000;
    const step = (fn: () => void): void => {
      fn();
      t += 1_000;
      r.at(t);
      r.rec.poll();
      apply(r.drain());
    };
    step(() => {});
    step(() => r.values(SELF, { invSlot0Lo: 0, invSlot0Hi: 0, invSlot25Lo: 1, invSlot25Hi: HI }, t + 1)); // unequip to the pack
    step(() => r.values(itemGuid(1), { durability: 39 }, t + 1));
    step(() => r.values(SELF, { quest0CountsLo: 3 | (1 << 16), quest0State: 1, skill0Value: 32 }, t + 1));
    step(() => r.values(SELF, { quest0Id: 0, quest1Id: QUEST + 1, quest1State: 0 }, t + 1));
    step(() => r.values(SELF, { invSlot19Lo: 0, invSlot19Hi: 0 }, t + 1)); // the bag comes off, contents and all
    // A fresh key: what the recorder reads now, whole.
    r.feed("WB_SESSION_STATE", { character: "Fenwick", guid: SELF, inWorld: true, map: 0, x: 1, y: 2, z: 3, o: 0, level: 12 }, t + 10);
    const key = r.drain().find((x) => x.kind === "key")!;
    expect(fold).toEqual(sheetOfKey(key));
    expect(fold.equip).toEqual([]);
    expect(fold.inv).toEqual([
      [255, 23, STONE, 5],
      [255, 25, SWORD, 1, -77],
    ]);
    expect(fold.quests).toEqual([[1, QUEST + 1, 0]]);
    expect(fold.bags).toEqual([]);
    // And the raw read agrees with the SDK's own joins, row for row.
    const bag: unknown[] = r.cache.bag().items.map((b) => [b.bag, b.slot, b.itemId, b.count]);
    expect(fold.inv!.map((x): unknown => [x[0], x[1], x[2], x[3] ?? 1])).toEqual(bag);
    const worn: unknown[] = r.cache.inventory.filter((i) => i.slot <= 18).map((i) => [i.slot, i.itemId]);
    expect(fold.equip!.map((x): unknown => [x[0], x[1]])).toEqual(worn);
    expect(fold.skills).toEqual(r.cache.skills().map((s) => [s.skillId, s.value, s.max]));
    expect(fold.quests!.map((q) => [q[0], q[1], q[2]])).toEqual(r.cache.questLog.map((q) => [q.slot, q.questId, q.state]));
    r.rec.stop();
  });
});
