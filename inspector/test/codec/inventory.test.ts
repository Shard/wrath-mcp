/**
 * The track's inventory codec (`src/codec/inventory.ts`).
 *
 * The one property that matters is that folding the patches gives back the
 * reading the track would have carried whole, exactly: the same rows in the
 * same order with the same keys, absent fields absent. Every test here
 * compares serialised readings, so key order and row order count. The rest
 * pin when a reading has to go whole, and that a reader scrubbing back and
 * forth gets stable arrays back.
 */

import { describe, expect, test } from "bun:test";
import type { ItemSample } from "../../src/wire";
import { INV_CHECKPOINT, encodeInventory, inventoryAt } from "../../src/codec/inventory";

/** A worn row, as `itemSamplesOf` parses one. */
const worn = (slot: number, itemId: number, name = `worn ${itemId}`, quality = 2): ItemSample => ({
  name,
  count: 1,
  equipped: true,
  itemId,
  quality,
  slot,
});

/** A carried row, as `itemSamplesOf` parses one. */
const carried = (bag: number, slot: number, itemId: number, count = 1, name = `item ${itemId}`): ItemSample => ({
  name,
  count,
  equipped: false,
  itemId,
  quality: 1,
  slot,
  bag,
});

/** Encode readings on consecutive points and check every point folds back to its reading. */
function roundTrip(readings: ItemSample[][]): ReturnType<typeof encodeInventory> {
  const inv = encodeInventory(readings.map((items, point) => ({ point, items })));
  expect(inv).not.toBeNull();
  readings.forEach((r, i) => expect(JSON.stringify(inventoryAt(inv!, i))).toBe(JSON.stringify(r)));
  return inv;
}

describe("a reading folds back to exactly what was stored", () => {
  test("slots filled, emptied, restacked and swapped, worn and carried", () => {
    const a = [worn(4, 100), worn(16, 101), carried(255, 23, 200, 3), carried(255, 24, 201), carried(19, 0, 202)];
    const b = [worn(4, 100), worn(16, 105), carried(255, 23, 200, 7), carried(19, 0, 202), carried(19, 1, 203)];
    const c = [worn(16, 105), carried(255, 23, 200, 7), carried(255, 30, 204, 20), carried(20, 2, 205)];
    const inv = roundTrip([a, b, c])!;
    // The first reading is a patch onto empty bags; each later one only what moved.
    expect(inv.at[0]![1]).toHaveLength(5);
    expect(inv.at[1]).toEqual([1, [[255, 24], [-1, 16, 5], [255, 23, 2, 7], [19, 1, 6]]]);
    expect(inv.at[2]).toEqual([2, [[-1, 4], [19, 0], [19, 1], [255, 30, 7, 20], [20, 2, 8]]]);
  });

  test("one id under two names at once is two items, not one", () => {
    // A random suffix is stored in the name, so two copies of one item can differ.
    const r = [carried(255, 23, 9890, 1, "Sentry Cloak of the Owl"), carried(255, 24, 9890, 1, "Sentry Cloak of the Monkey")];
    const inv = roundTrip([r, [r[1]!, { ...r[0]!, slot: 25 }].sort((x, y) => x.slot! - y.slot!)])!;
    expect(inv.items).toEqual([
      ["Sentry Cloak of the Owl", 9890, 1],
      ["Sentry Cloak of the Monkey", 9890, 1],
    ]);
  });

  test("a row whose id or quality was not yet seen keeps those fields absent", () => {
    const unresolved: ItemSample = { name: "slot 3", count: 1, equipped: true, slot: 3 };
    const noQuality: ItemSample = { name: "item 6948", count: 1, equipped: false, itemId: 6948, slot: 23, bag: 255 };
    const inv = roundTrip([[unresolved, noQuality], [worn(3, 50), noQuality]])!;
    expect(inv.items[0]).toEqual(["slot 3", null, null]);
    expect(Object.keys(inventoryAt(inv, 0)![0]!)).toEqual(["name", "count", "equipped", "slot"]);
  });

  test("empty bags are a reading, from the first one on", () => {
    const inv = roundTrip([[], [carried(255, 23, 1)], []])!;
    expect(inv.at[0]).toEqual([0, []]);
    expect(inventoryAt(inv, 0)).toEqual([]);
  });

  test("a reading that only restates the one before is no entry at all", () => {
    const r = [worn(1, 2), carried(255, 23, 3)];
    const inv = encodeInventory([
      { point: 0, items: r },
      { point: 5, items: r.map((x) => ({ ...x })) },
    ])!;
    expect(inv.at.map((e) => e[0])).toEqual([0]);
    expect(inventoryAt(inv, 7)).toEqual(r);
  });
});

describe("what a patch cannot say goes whole", () => {
  test("rows recorded before the slot columns", () => {
    const old: ItemSample[] = [
      { name: "Worn Mace", count: 1, equipped: true },
      { name: "Linen Cloth", count: 3, equipped: false },
    ];
    const inv = roundTrip([old, [{ ...old[0]! }, { ...old[1]!, count: 4 }]])!;
    expect(inv.at.every((e) => e[1] === null)).toBe(true);
    expect(inv.items).toEqual([]);
  });

  test("a whole reading in the middle, and the patches after it", () => {
    const keyed = [worn(4, 100), carried(255, 23, 200)];
    const loose = [worn(4, 100), { name: "Hearthstone", count: 1, equipped: false, itemId: 6948 }];
    const inv = roundTrip([keyed, loose, keyed, [...keyed, carried(255, 24, 201)]])!;
    // After a whole reading the next is whole too; only then do patches resume.
    expect(inv.at.map((e) => e[1] === null)).toEqual([false, true, true, false]);
  });

  test("two rows on one slot, and rows stored out of the order a patch rebuilds", () => {
    const twice = [carried(255, 23, 1), carried(255, 23, 2)];
    const outOfOrder = [carried(19, 0, 1), carried(255, 23, 2), worn(0, 3)];
    const inv = roundTrip([[worn(0, 3)], twice, [worn(0, 3)], outOfOrder])!;
    expect(inv.at.map((e) => e[1] === null)).toEqual([false, true, true, true]);
  });

  test("a worn row that names a bag, and a carried one on the worn sentinel", () => {
    const odd: ItemSample[] = [{ ...worn(1, 1), bag: 255 }, carried(-1, 4, 2)];
    const inv = roundTrip([odd])!;
    expect(inv.at[0]![1]).toBeNull();
  });
});

describe("reading it back", () => {
  /** A long run: one carried stack growing, one slot cycling, one coming and going, one bag never touched. */
  const long: ItemSample[][] = Array.from({ length: INV_CHECKPOINT * 3 + 17 }, (_, i) => [
    worn(16, 100 + (i % 5)),
    carried(255, 23, 200, i + 1),
    ...(i % 3 === 0 ? [carried(255, 24, 300)] : []),
    carried(19, 0, 400),
  ]);

  test("forwards, backwards across checkpoints, and at random", () => {
    const inv = encodeInventory(long.map((items, point) => ({ point: point * 2, items })))!;
    const want = (p: number): string => JSON.stringify(p < 0 ? null : long[Math.floor(p / 2)]);
    const points = [...Array(long.length * 2).keys()];
    for (const order of [points, [...points].reverse(), [...points].sort(() => Math.random() - 0.5)]) {
      const fresh = structuredClone(inv);
      for (const p of order) expect(JSON.stringify(inventoryAt(fresh, p))).toBe(want(p));
    }
    expect(inventoryAt(inv, -1)).toBeNull();
  });

  test("the same array for every point between two changes, and unchanged rows keep their objects", () => {
    const inv = encodeInventory(long.map((items, point) => ({ point: point * 2, items })))!;
    const a = inventoryAt(inv, 10)!;
    expect(inventoryAt(inv, 11)).toBe(a);
    const b = inventoryAt(inv, 12)!;
    expect(b).not.toBe(a);
    // The worn slot cycles and the stack grows, but the bag's row never moved:
    // it is the same object, so a panel redraws only what did.
    const stayed = b.find((r) => r.bag === 19);
    expect(inventoryAt(inv, 14)!.find((r) => r.bag === 19)).toBe(stayed!);
    expect(inventoryAt(inv, 14)!.find((r) => r.bag === 255 && r.slot === 23)).not.toBe(b.find((r) => r.bag === 255 && r.slot === 23)!);
  });

  test("no readings is no inventory", () => {
    expect(encodeInventory([])).toBeNull();
  });
});
