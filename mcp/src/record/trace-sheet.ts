/**
 * The character sheet as the trace recorder reads it (`trace-recorder.ts`;
 * the shapes are `trace-row.ts`): money, equipment, worn bags, what is
 * carried, durability, the quest log, skills and visible reputation, off the
 * SDK's state cache and nothing else. What is carried is everywhere the
 * server counts toward a quest's items (`Player::GetItemCount(id, false)`):
 * the backpack, the worn bags' contents, the keyring and the currency token
 * slots. Never the bank, never the vendor buyback slots.
 *
 * It reads the raw fields the SDK's own views are built from, never the
 * views. `questLog` re-walks every carried item for each collect objective
 * (about 5 ms at level 43, against microseconds for the slot fields it starts
 * from), and `inventory` and `bag()` join every item to its template and
 * decode its enchantment slots; the trace wants ids and counts, so it takes
 * the slot guids, each item object's entry, stack count, random property and
 * durability, and each container's slots, directly; of the random property's
 * text, only its name suffix, and only for the dictionary. The slot numbering and
 * the guid packing are the SDK's (`state.ts`, `guid.ts`), copied here
 * because the SDK does not export them. The SDK's views do not read the
 * keyring or the currency slots at all; their fields arrive by name from a
 * module that serves them (`module/PROTOCOL.md`), and an older module's
 * absent fields read as no rows.
 *
 * Every read returns the newest observation time behind each key, so a
 * change is stamped with when the cache saw it, not when the poll ran.
 */

import type { NearbyObject, Observed, StateCache } from "@wrathbench/sdk";
import {
  emptyTraceSheet,
  sortRows,
  type TraceBagRow,
  type TraceDurRow,
  type TraceEquipRow,
  type TraceInvRow,
  type TraceQuestReq,
  type TraceQuestRow,
  type TraceRepRow,
  type TraceSheet,
  type TraceSkillRow,
} from "./trace-row";

/** The slice of the cache the sheet is read from. */
export type SheetSource = Pick<StateCache, "self" | "nearby" | "items" | "quests" | "reputation">;

/**
 * `invSlot<n>`: equipment 0-18, worn bags 19-22, backpack 23-38, keyring
 * 86-117 (`PLAYER_FIELD_KEYRING_SLOT_1`) and currency tokens 118-149
 * (`PLAYER_FIELD_CURRENCYTOKEN_SLOT_1`). The bank (39-73) and the vendor
 * buyback slots (74-85) between them are never read.
 */
const EQUIP_LAST_SLOT = 18;
const BAG_FIRST_SLOT = 19;
const BAG_LAST_SLOT = 22;
const BACKPACK_LAST_SLOT = 38;
const KEYRING_FIRST_SLOT = 86;
const CURRENCY_LAST_SLOT = 149;
/** Every slot read, in order: 0-38, then 86-149. */
const INV_SLOTS: readonly number[] = [
  ...Array.from({ length: BACKPACK_LAST_SLOT + 1 }, (_, i) => i),
  ...Array.from({ length: CURRENCY_LAST_SLOT - KEYRING_FIRST_SLOT + 1 }, (_, i) => KEYRING_FIRST_SLOT + i),
];
/** The bag id the item actions take for the backpack. */
const BACKPACK_BAG = 255;
/** `PLAYER_QUEST_LOG_1_1` .. `_25_1`. */
const QUEST_LOG_SLOTS = 25;
/** `PLAYER_SKILL_INFO_1_1`: 128 skill slots. */
const SKILL_SLOTS = 128;
/** `CONTAINER_FIELD_SLOT_1`: a container serves up to 36 slot guids. */
const CONTAINER_SLOTS = 36;

const names = (n: number, f: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => f(i));
const INV_LO = names(CURRENCY_LAST_SLOT + 1, (i) => `invSlot${i}Lo`);
const INV_HI = names(CURRENCY_LAST_SLOT + 1, (i) => `invSlot${i}Hi`);
const BAG_LO = names(CONTAINER_SLOTS, (i) => `bagSlot${i}Lo`);
const BAG_HI = names(CONTAINER_SLOTS, (i) => `bagSlot${i}Hi`);
const QUEST_ID = names(QUEST_LOG_SLOTS, (i) => `quest${i}Id`);
const QUEST_STATE = names(QUEST_LOG_SLOTS, (i) => `quest${i}State`);
const QUEST_LO = names(QUEST_LOG_SLOTS, (i) => `quest${i}CountsLo`);
const QUEST_HI = names(QUEST_LOG_SLOTS, (i) => `quest${i}CountsHi`);
const SKILL_ID = names(SKILL_SLOTS, (i) => `skill${i}Id`);
const SKILL_VALUE = names(SKILL_SLOTS, (i) => `skill${i}Value`);
const SKILL_MAX = names(SKILL_SLOTS, (i) => `skill${i}Max`);

type Fields = ReadonlyMap<string, Observed<number>>;
/**
 * The two u32 halves of a slot as the cache's guid key, or "0" for an empty
 * slot: the SDK's own packing (`state.ts` `inventory`, `guid.ts`
 * `formatGuid`). Memoised, because a carried item sits in the same slot for
 * hours and the poll would otherwise build the same bigint every second.
 */
const guidMemo = new Map<string, string>();
function guidOf(lo: number, hi: number): string {
  if (lo === 0 && hi === 0) return "0";
  const k = `${hi}:${lo}`;
  let g = guidMemo.get(k);
  if (g === undefined) {
    g = ((BigInt(hi) << 32n) | BigInt(lo >>> 0)).toString(10);
    if (guidMemo.size >= 4096) guidMemo.clear();
    guidMemo.set(k, g);
  }
  return g;
}

/** What one read of the sheet found, and the newest observation behind each key. */
export interface SheetReading {
  sheet: TraceSheet;
  ts: Partial<Record<keyof TraceSheet, number>>;
  /**
   * The name suffix of each random property id the sheet's rows carry, where
   * the item's object holds one (`suffixName`): for the dictionary, never
   * for a row. Absent when no row has one.
   */
  rands?: Map<number, string>;
}

/**
 * Read the sheet's self keys: everything but `rep`, which the recorder reads
 * only after a faction packet (`readVisibleReputation`). Every key is
 * observed here: the caller asks only once the character's own create block
 * has been folded, when a field the cache lacks is one the wire compressed
 * out for being zero.
 */
export function readSheet(state: SheetSource): SheetReading {
  const self: Fields = state.self.fields;
  const sheet = emptyTraceSheet();
  const ts: SheetReading["ts"] = {};
  const reading: SheetReading = { sheet, ts };
  const stamp = (key: keyof TraceSheet, t: number | undefined): void => {
    if (t !== undefined && t > (ts[key] ?? 0)) ts[key] = t;
  };

  const money = self.get("money");
  sheet.money = money?.value ?? 0;
  stamp("money", money?.ts);

  const equip: TraceEquipRow[] = [];
  const dur: TraceDurRow[] = [];
  const bags: TraceBagRow[] = [];
  const inv: TraceInvRow[] = [];
  /** A random property's suffix, read off the item that carries it. */
  const suffixOf = (rand: number, item: NearbyObject | undefined): void => {
    if (reading.rands?.has(rand) === true) return;
    const suffix = item?.texts.get("suffixName")?.value;
    if (typeof suffix === "string" && suffix.length > 0) (reading.rands ??= new Map()).set(rand, suffix);
  };
  const carried = (bag: number, slot: number, item: NearbyObject | undefined, slotTs: number): void => {
    const fields = item?.fields;
    const count = fields?.get("stackCount");
    const rand = fields?.get("randomPropertyId");
    const itemId = item?.entry?.value ?? 0;
    const n = count?.value ?? 1;
    const r = rand?.value ?? 0;
    inv.push(r !== 0 ? [bag, slot, itemId, n, r] : n !== 1 ? [bag, slot, itemId, n] : [bag, slot, itemId]);
    if (r !== 0) suffixOf(r, item);
    stamp("inv", Math.max(slotTs, item?.entry?.ts ?? 0, count?.ts ?? 0, rand?.ts ?? 0));
  };
  for (const slot of INV_SLOTS) {
    const lo = self.get(INV_LO[slot]!);
    const hi = self.get(INV_HI[slot]!);
    if (lo === undefined && hi === undefined) continue;
    const slotTs = Math.max(lo?.ts ?? 0, hi?.ts ?? 0);
    const guid = guidOf(lo?.value ?? 0, hi?.value ?? 0);
    const item = guid === "0" ? undefined : state.nearby.get(guid);
    if (slot <= EQUIP_LAST_SLOT) {
      stamp("equip", slotTs);
      stamp("dur", slotTs);
      if (guid === "0") continue;
      const fields = item?.fields;
      const rand = fields?.get("randomPropertyId");
      const itemId = item?.entry?.value ?? 0;
      equip.push(rand !== undefined && rand.value !== 0 ? [slot, itemId, rand.value] : [slot, itemId]);
      if (rand !== undefined && rand.value !== 0) suffixOf(rand.value, item);
      stamp("equip", Math.max(item?.entry?.ts ?? 0, rand?.ts ?? 0));
      const max = fields?.get("maxDurability");
      if (max !== undefined && max.value > 0) {
        const cur = fields?.get("durability");
        dur.push([slot, cur?.value ?? 0, max.value]);
        stamp("dur", Math.max(max.ts, cur?.ts ?? 0));
      }
    } else if (slot <= BAG_LAST_SLOT) {
      stamp("bags", slotTs);
      stamp("inv", slotTs);
      if (guid === "0") continue;
      const fields = item?.fields;
      const size = fields?.get("numSlots");
      const numSlots = Math.min(size?.value ?? 0, CONTAINER_SLOTS);
      bags.push([slot, item?.entry?.value ?? 0, numSlots]);
      stamp("bags", Math.max(item?.entry?.ts ?? 0, size?.ts ?? 0));
      if (fields === undefined) continue;
      for (let n = 0; n < numSlots; n++) {
        const blo = fields.get(BAG_LO[n]!);
        const bhi = fields.get(BAG_HI[n]!);
        if (blo === undefined && bhi === undefined) continue;
        const inTs = Math.max(blo?.ts ?? 0, bhi?.ts ?? 0);
        const inner = guidOf(blo?.value ?? 0, bhi?.value ?? 0);
        if (inner === "0") {
          stamp("inv", inTs);
          continue;
        }
        carried(slot, n, state.nearby.get(inner), inTs);
      }
    } else {
      // The backpack, the keyring and the currency slots: all bag 255, at their own slot numbers.
      stamp("inv", slotTs);
      if (guid !== "0") carried(BACKPACK_BAG, slot, item, slotTs);
    }
  }
  sheet.equip = equip;
  sheet.dur = dur;
  sheet.bags = bags;
  sheet.inv = sortRows(inv);

  const quests: TraceQuestRow[] = [];
  for (let slot = 0; slot < QUEST_LOG_SLOTS; slot++) {
    const id = self.get(QUEST_ID[slot]!);
    if (id === undefined) continue;
    stamp("quests", id.ts);
    if (id.value === 0) continue;
    const st = self.get(QUEST_STATE[slot]!);
    const lo = self.get(QUEST_LO[slot]!);
    const hi = self.get(QUEST_HI[slot]!);
    stamp("quests", Math.max(st?.ts ?? 0, lo?.ts ?? 0, hi?.ts ?? 0));
    // Two u32s, each two u16 objective counters (3.3.5), as the SDK unpacks them.
    const l = lo?.value ?? 0;
    const h = hi?.value ?? 0;
    const row: number[] = [slot, id.value, st?.value ?? 0, l & 0xffff, (l >>> 16) & 0xffff, h & 0xffff, (h >>> 16) & 0xffff];
    while (row.length > 3 && row[row.length - 1] === 0) row.pop();
    quests.push(row as TraceQuestRow);
  }
  sheet.quests = quests;

  const skills: TraceSkillRow[] = [];
  for (let slot = 0; slot < SKILL_SLOTS; slot++) {
    const id = self.get(SKILL_ID[slot]!);
    if (id === undefined) continue;
    stamp("skills", id.ts);
    if (id.value === 0) continue;
    const value = self.get(SKILL_VALUE[slot]!);
    const max = self.get(SKILL_MAX[slot]!);
    stamp("skills", Math.max(value?.ts ?? 0, max?.ts ?? 0));
    skills.push([id.value, value?.value ?? 0, max?.value ?? 0]);
  }
  sheet.skills = sortRows(skills);
  return reading;
}

/**
 * The reputation pane's visible rows, `[factionId, standing]` by faction id,
 * and the newest observation behind them. `reputation()` sorts every faction
 * by name, so the recorder calls this only after a faction packet. A row the
 * module could not name a faction id for is not carried: it has no id.
 */
export function readVisibleReputation(state: Pick<SheetSource, "reputation">): { rows: TraceRepRow[]; ts: number } {
  const rows: TraceRepRow[] = [];
  let ts = 0;
  for (const r of state.reputation()) {
    if (r.ts > ts) ts = r.ts;
    if (!r.visible || r.factionId === undefined) continue;
    rows.push([r.factionId, r.standing]);
  }
  return { rows: sortRows(rows), ts };
}

/** Every item id a sheet names, for its dictionary. */
export function sheetItemIds(sheet: TraceSheet, out: Set<number> = new Set()): Set<number> {
  for (const r of sheet.equip ?? []) if (r[1] > 0) out.add(r[1]);
  for (const r of sheet.bags ?? []) if (r[1] > 0) out.add(r[1]);
  for (const r of sheet.inv ?? []) if (r[2] > 0) out.add(r[2]);
  return out;
}

/** An item's quality and its template's name, from the item query the cache holds; the instance's suffix is `rands`'. */
export function itemEntry(state: Pick<SheetSource, "items">, itemId: number): [number, number | null, string] | undefined {
  const info = state.items.get(itemId)?.value;
  if (info === undefined || typeof info.name !== "string") return undefined;
  return [itemId, typeof info.quality === "number" ? info.quality : null, info.name];
}

/** A quest's required counts, from the template the cache holds: numbers only. */
export function questReq(state: Pick<SheetSource, "quests">, questId: number): TraceQuestReq | undefined {
  const info = state.quests.get(questId)?.value;
  if (info === undefined) return undefined;
  const req: TraceQuestReq = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) req[i] = info.requiredNpcOrGo[i]?.count ?? 0;
  for (const it of info.requiredItems) if (it.itemId !== 0) req.push([it.itemId, it.count]);
  return req;
}
