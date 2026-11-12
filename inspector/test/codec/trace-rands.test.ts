/**
 * A random property's name suffix through the trace codec and the inventory
 * view: the segment names exactly the signed ids its `equip` and `inv` rows
 * carry, decodes them back, and the panels show "<template> <suffix>". Ids
 * and names invented.
 */

import { describe, expect, test } from "bun:test";
import { SEG_MS, decodeSegment, emptyTraceSheet, emptyTraceState, encodeSegment, sheetAt, type TraceDictLookup, type TraceRow } from "../../src/codec/trace";
import { sheetItems } from "../../src/views/lib/inventory";

const T0 = 1_760_000_100_000;
const W = { run: "rands-run", t0: T0, t1: T0 + SEG_MS };

const row = (ts: number, kind: string, data: Record<string, unknown>): TraceRow => ({ ts, kind, map: null, x: null, y: null, z: null, o: null, data: JSON.stringify(data) });

const NAMES = new Map<number, [number, string]>([
  [501, [2, "Sentry's Leggings"]],
  [702, [2, "Lupine Handwraps"]],
  [703, [1, "Linen Cloth"]],
]);
const SUFFIXES = new Map<number, string>([
  [-12, "of the Bear"],
  [44, "of Strength"],
  [-99, "of the Unused"],
]);
const dict: TraceDictLookup = {
  item: (id) => NAMES.get(id),
  quest: () => undefined,
  rand: (id) => SUFFIXES.get(id),
};

const rows: TraceRow[] = [
  row(T0 + 1000, "key", { ...emptyTraceState(), ...emptyTraceSheet(), money: 0, equip: [[6, 501, -12]], inv: [[255, 23, 703, 4]], dur: [] }),
  // Looted later in the window: a positive property, and one with no name the session knows.
  row(T0 + 5000, "state", { inv: [[255, 24, 702, 1, 44], [255, 25, 702, 1, 7]] }),
];

describe("trace codec: random property suffixes", () => {
  test("the segment names exactly the ids its rows carry, and decodes them back", () => {
    const seg = encodeSegment(rows, W, dict);
    // -99 is in the dictionary but on no row; 7 is on a row but the session never named it.
    expect(seg.rands).toEqual({ "-12": "of the Bear", "44": "of Strength" });
    const decoded = decodeSegment(JSON.parse(JSON.stringify(seg)));
    expect([...decoded.rands].sort((a, b) => a[0] - b[0])).toEqual([
      [-12, "of the Bear"],
      [44, "of Strength"],
    ]);
  });

  test("a lookup without suffixes, or a segment from before them, carries none and decodes to an empty map", () => {
    const seg = encodeSegment(rows, W, { item: dict.item, quest: dict.quest });
    expect(seg.rands).toBeUndefined();
    expect(decodeSegment(seg).rands.size).toBe(0);
  });

  test("the panels name an item as the client does: the template's name and its suffix", () => {
    const d = decodeSegment(encodeSegment(rows, W, dict));
    const items = sheetItems(sheetAt(d, T0 + 6000), d.items, d.rands)!;
    expect(items.map((i) => [i.name, i.rand ?? null])).toEqual([
      ["Sentry's Leggings of the Bear", -12],
      ["Linen Cloth", null],
      ["Lupine Handwraps of Strength", 44],
      // A property the session never named shows the template's name, and the id still links it.
      ["Lupine Handwraps", 7],
    ]);
    // Without the suffixes the same rows read as the template's names, never a stale suffixed row.
    expect(sheetItems(sheetAt(d, T0 + 6000), d.items)!.map((i) => i.name)).toEqual(["Sentry's Leggings", "Linen Cloth", "Lupine Handwraps", "Lupine Handwraps"]);
  });
});
