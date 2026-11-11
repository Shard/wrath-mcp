/**
 * A track's inventory as changes: the codec a harness's track builder encodes
 * a replay track's `inv` with (WrathBench's `trackFrom`) and a map's
 * `itemsAt` (`views/lib/replay.ts`) folds back.
 *
 * The track used to carry the whole inventory on every point where its stored
 * text changed, and on a long-lived character that was most of the file: a
 * level-43 freeplay character with full bags was 30 MB of track, four-fifths
 * of it whole inventories repeating each other, re-uploaded on every publisher
 * pass while the run was live. Each reading is now the slots that changed.
 *
 * **Format** (`TrackInventory`):
 *
 * - `items`: every distinct item the readings name, `[name, itemId, quality]`,
 *   null where the stored row carried none, referenced by index. It is keyed
 *   by the whole triple rather than by the item id, because the stored name is
 *   not a function of the id: an item with a random suffix stores the suffix in
 *   its name, so two copies of one id can be carried at once under two names.
 * - `at`: the readings, oldest first, each on the index of the track point it
 *   surfaces at (the join `trackFrom` documents), in one of two forms:
 *   - `[point, patch]`: the reading before it — or empty bags, for the first —
 *     with each `[bag, slot, item]` (`[bag, slot, item, count]` when the stack
 *     is not 1) filling its slot and each bare `[bag, slot]` emptying it.
 *     `bag` is -1 for a worn item, whose `slot` is the equipment slot; a
 *     carried one has the SDK's own pair (`ItemSample`).
 *   - `[point, null, whole]`: the reading exactly as stored, rows and all. Used
 *     where a patch cannot say it: a row with no slot (every run recorded
 *     before the slot columns), two rows on one slot, rows stored out of the
 *     order a patch rebuilds, and anything after a reading like that.
 *
 * A patched reading is rebuilt in the order the recorder writes one — worn by
 * equipment slot, then the backpack, then the worn bags in slot order, each by
 * slot — with each row's keys in `itemSamplesOf`'s order and absent fields
 * absent. That is what makes a reading folded from patches the reading the
 * track would have carried whole, which is the property the tests and the
 * encoder's own order check hold it to.
 *
 * Imports nothing but wire types, like `trace.ts`, so a server and a browser
 * bundle both take it (`@wrathbench/inspector/codec/inventory`).
 */

import type { ItemSample, TrackInvEntry, TrackInvGone, TrackInvItem, TrackInventory, TrackInvRow } from "../wire";

/** The `bag` of a worn row in a patch. */
export const WORN = -1;

/** A reading is kept every this many entries, so a fold never replays more than this many patches. */
export const INV_CHECKPOINT = 64;

/** Where a row sits, `[bag, slot]`, or null when the row does not say. */
function slotOf(i: ItemSample): [number, number] | null {
  if (typeof i.slot !== "number") return null;
  if (i.equipped) return i.bag === undefined ? [WORN, i.slot] : null;
  return typeof i.bag === "number" && i.bag !== WORN ? [i.bag, i.slot] : null;
}

/** The recorder's order: worn first, then the backpack (255), then the worn bags by slot. */
const bagRank = (bag: number): number => (bag === WORN ? -2 : bag === 255 ? -1 : bag);

const before = (a: readonly [number, number], b: readonly [number, number]): boolean =>
  bagRank(a[0]) < bagRank(b[0]) || (a[0] === b[0] && a[1] < b[1]);

/** One slot's identity as a map key. */
const slotKey = (bag: number, slot: number): string => `${bag}:${slot}`;

/**
 * Encode a track's readings — the whole inventory at each point where it
 * changed, oldest first — as `TrackInventory`, or null when there are none.
 */
export function encodeInventory(readings: readonly { point: number; items: readonly ItemSample[] }[]): TrackInventory | null {
  if (readings.length === 0) return null;
  const items: TrackInvItem[] = [];
  const itemIndex = new Map<string, number>();
  const itemOf = (i: ItemSample): number => {
    const def: TrackInvItem = [i.name, i.itemId ?? null, i.quality ?? null];
    const key = JSON.stringify(def);
    let k = itemIndex.get(key);
    if (k === undefined) {
      k = items.length;
      items.push(def);
      itemIndex.set(key, k);
    }
    return k;
  };
  const at: TrackInvEntry[] = [];
  // The previous reading by slot, as `[item, count]`, or null when it was one a patch cannot follow.
  let prev: Map<string, { bag: number; slot: number; item: number; count: number }> | null = new Map();
  let prevWhole: string | null = null;
  for (const { point, items: rows } of readings) {
    const slots = rows.map(slotOf);
    const keyed = slots.every((s, n) => s !== null && (n === 0 || before(slots[n - 1]!, s)));
    if (!keyed) {
      // Stored as it is; a reading that only restates the one before is no change.
      const text = JSON.stringify(rows);
      if (text !== prevWhole) at.push([point, null, [...rows]]);
      prev = null;
      prevWhole = text;
      continue;
    }
    const next = new Map<string, { bag: number; slot: number; item: number; count: number }>();
    rows.forEach((r, n) => {
      const [bag, slot] = slots[n]!;
      next.set(slotKey(bag, slot), { bag, slot, item: itemOf(r), count: r.count });
    });
    if (prev === null) {
      // After a whole reading: this one is whole too, as a patch onto empty bags would not be.
      at.push([point, null, [...rows]]);
    } else {
      const patch: (TrackInvRow | TrackInvGone)[] = [];
      for (const [k, v] of prev) if (!next.has(k)) patch.push([v.bag, v.slot]);
      for (const [k, v] of next) {
        const was = prev.get(k);
        if (was !== undefined && was.item === v.item && was.count === v.count) continue;
        patch.push(v.count === 1 ? [v.bag, v.slot, v.item] : [v.bag, v.slot, v.item, v.count]);
      }
      // The first reading is an entry even when it is empty bags: none at all
      // would read as "not yet observed".
      if (patch.length > 0 || at.length === 0) at.push([point, patch]);
    }
    prev = next;
    prevWhole = null;
  }
  return { items, at };
}

/** One row of a patch, rebuilt as `itemSamplesOf` would have parsed it. */
function rowOf(items: readonly TrackInvItem[], r: TrackInvRow): ItemSample | null {
  const def = items[r[2]];
  if (def === undefined) return null;
  const [name, itemId, quality] = def;
  const worn = r[0] === WORN;
  return {
    name,
    count: r.length === 4 ? r[3] : 1,
    equipped: worn,
    ...(itemId === null ? {} : { itemId }),
    ...(quality === null ? {} : { quality }),
    slot: r[1],
    ...(worn ? {} : { bag: r[0] }),
  };
}

/** Apply one entry to the reading before it (null before the first). */
function apply(items: readonly TrackInvItem[], prev: readonly ItemSample[] | null, e: TrackInvEntry): ItemSample[] {
  if (e[1] === null) return e[2];
  const bySlot = new Map<string, { at: [number, number]; row: ItemSample }>();
  for (const row of prev ?? []) {
    const s = slotOf(row);
    if (s !== null) bySlot.set(slotKey(s[0], s[1]), { at: s, row });
  }
  for (const r of e[1]) {
    const key = slotKey(r[0], r[1]);
    if (r.length === 2) {
      bySlot.delete(key);
      continue;
    }
    const row = rowOf(items, r);
    if (row !== null) bySlot.set(key, { at: [r[0], r[1]], row });
  }
  return [...bySlot.values()].sort((a, b) => (before(a.at, b.at) ? -1 : before(b.at, a.at) ? 1 : 0)).map((v) => v.row);
}

/** The last entry at or before point `i`, or -1. */
function entryAt(at: readonly TrackInvEntry[], i: number): number {
  let lo = 0;
  let hi = at.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid]![0] <= i) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

interface Folds {
  /** The reading at entry `n * INV_CHECKPOINT`, as far as one has been asked for. */
  checkpoints: ItemSample[][];
  /** The last reading asked for, so a cursor that stays inside one gets the same array back. */
  last: { entry: number; reading: ItemSample[] } | null;
}

/** Per `inv` object: a track is fetched once and then read on every frame. */
const folds = new WeakMap<TrackInventory, Folds>();

/** The reading at entry `n`, folded from the nearest checkpoint or from the last reading. */
function readingAt(inv: TrackInventory, n: number): ItemSample[] {
  let f = folds.get(inv);
  if (f === undefined) {
    f = { checkpoints: [], last: null };
    folds.set(inv, f);
  }
  if (f.last !== null && f.last.entry === n) return f.last.reading;
  const want = Math.floor(n / INV_CHECKPOINT);
  while (f.checkpoints.length <= want) {
    const c = f.checkpoints.length;
    let reading: ItemSample[] | null = c === 0 ? null : f.checkpoints[c - 1]!;
    const from = c === 0 ? 0 : (c - 1) * INV_CHECKPOINT + 1;
    for (let k = from; k <= c * INV_CHECKPOINT; k++) reading = apply(inv.items, reading, inv.at[k]!);
    f.checkpoints.push(reading!);
  }
  // Forward from the last reading when it is nearer than the checkpoint: a
  // replay playing forward folds one patch a change, not up to sixty-four.
  const base = want * INV_CHECKPOINT;
  let k = f.last !== null && f.last.entry > base && f.last.entry < n ? f.last.entry : base;
  let reading = k === base ? f.checkpoints[want]! : f.last!.reading;
  while (k < n) reading = apply(inv.items, reading, inv.at[++k]!);
  f.last = { entry: n, reading };
  return reading;
}

/**
 * The inventory standing at track point `i`: the newest reading at or before
 * it, or null before the first — not yet observed, which is not empty bags.
 *
 * The same array comes back for every point between two changes, and a row
 * that did not change keeps its object, so a panel drawn from it redraws only
 * what moved.
 */
export function inventoryAt(inv: TrackInventory, i: number): ItemSample[] | null {
  const n = entryAt(inv.at, i);
  return n < 0 ? null : readingAt(inv, n);
}
