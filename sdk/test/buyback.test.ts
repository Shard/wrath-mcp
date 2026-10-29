/**
 * The vendor buyback tab: `invSlot74`-`85` and `buybackPrice<n>` on self,
 * folded into `state.buyback()` and kept out of every carried view. Frames
 * are hand-written from module/PROTOCOL.md ("Update-field whitelist
 * additions") with the shared fixture item; nothing here is game data.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import {
  BACKPACK_SLOT,
  ITEM_ENTRY,
  ITEM_GUID,
  ITEM_GUID_HI,
  ITEM_GUID_LO,
  inventorySlot,
  itemCreate,
  itemQuery,
  loginSequence,
  SELF_GUID,
  selfCreate,
} from "./fixtures";

const TS = 1_700_000_000_000;
const selfFields = (seq: number, fields: Record<string, number>) => ({
  seq,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: TS + seq,
  data: { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] },
});

const toEvents = (frames: readonly unknown[]): GameEvent[] =>
  frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

/** The charm sold whole: its backpack slot empties and buyback slot 74 takes the same guid. */
const sold = selfFields(50, {
  [`invSlot${BACKPACK_SLOT}Lo`]: 0,
  [`invSlot${BACKPACK_SLOT}Hi`]: 0,
  invSlot74Lo: ITEM_GUID_LO,
  invSlot74Hi: ITEM_GUID_HI,
  buybackPrice0: 200,
});

/** A slot whose item the cache never saw created (a reattach after the sale). */
const unseen = selfFields(51, { invSlot75Lo: 4999, invSlot75Hi: ITEM_GUID_HI, buybackPrice1: 35 });

const world = (extra: readonly unknown[]) =>
  StateCache.replay(toEvents([...loginSequence, selfCreate, inventorySlot, itemCreate, itemQuery, ...extra]), {
    seed: { guid: SELF_GUID, name: "Fenwick" },
  });

describe("state.buyback()", () => {
  test("a sold item moves from the bag to the buyback tab, named and priced", () => {
    const before = world([]);
    expect(before.buyback()).toEqual([]);
    expect(before.bag().items.map((i) => i.guid)).toEqual([ITEM_GUID]);

    const cache = world([sold]);
    expect(cache.bag().items).toEqual([]);
    expect(cache.buyback()).toEqual([
      expect.objectContaining({ slot: 74, guid: ITEM_GUID, itemId: ITEM_ENTRY, name: "Gritstone Charm", count: 5, price: 200 }),
    ]);
    // Never carried: not in the inventory view, the bag, or a collect count.
    expect(cache.inventory.some((i) => i.guid === ITEM_GUID)).toBe(false);
    expect(cache.snapshot().buyback).toEqual(cache.buyback());
  });

  test("a slot whose item was never created reads with a guid and no entry", () => {
    const cache = world([sold, unseen]);
    const rows = cache.buyback();
    expect(rows.map((r) => r.slot)).toEqual([74, 75]);
    expect(rows[1]).toMatchObject({ slot: 75, itemId: undefined, name: undefined, price: 35 });
  });

  test("a slot bought back empties", () => {
    const cache = world([sold, selfFields(52, { invSlot74Lo: 0, invSlot74Hi: 0, buybackPrice0: 0 })]);
    expect(cache.buyback()).toEqual([]);
  });
});
