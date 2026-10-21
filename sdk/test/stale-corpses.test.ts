/**
 * Stale corpses in `state.units()` (Deadmines attempt a8): a healer cast
 * Resurrection on a corpse row that was bones — its owner already back on its
 * feet — and the spell went off with no target hit. Bones are not rows, and a
 * player has one corpse: an owner's older corpse row gives way to the newer.
 * Frames are hand-written from module/PROTOCOL.md (`corpseFlags`,
 * `corpseOwnerGuid`) with invented guids and positions.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { loginSequence, SELF_GUID, selfCreate } from "./fixtures";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const SEED = { guid: SELF_GUID, name: "Fenwick" };

const toEvents = (list: readonly unknown[]): GameEvent[] =>
  list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

/** A corpse's create a few yards from the login position, as the core fills it. */
const corpse = (seq: number, guid: string, fields: Record<string, number | string>, dx: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [
      { update: "create", guid, objectType: "corpse", pos: { x: -1234.5 + dx, y: 987.25, z: 42.125, o: 0 }, fields },
    ],
  });
const destroy = (seq: number, guid: string) => frame(seq, "SMSG_DESTROY_OBJECT", { guid, onDeath: false });

const OWNER = "965";
const OTHER = "966";
const LIVE = "17366161638117343239";
const OLD = "17366161638117343240";
const NEW = "17366161638117343241";
// Every corpse carries CORPSE_FLAG_UNK2; bones add CORPSE_FLAG_BONES (Map::ConvertCorpseToBones).
const BODY = { scale: 1, corpseOwnerGuid: OWNER, corpseFlags: 0x04 };
const BONES = { scale: 1, corpseOwnerGuid: OWNER, corpseFlags: 0x05 };

const cache = (extra: readonly unknown[]) =>
  StateCache.replay(toEvents([...loginSequence, selfCreate, ...extra]), { seed: SEED });
const corpses = (c: StateCache) => c.units({ type: "corpse" }).map((r) => r.guid);

describe("state.units(): bones and stale corpses", () => {
  test("a live corpse stays a corpse row", () => {
    const c = cache([corpse(30, LIVE, BODY, 4)]);
    expect(c.units().find((r) => r.guid === LIVE)).toMatchObject({ type: "corpse", dead: true, ownerGuid: OWNER });
    expect(c.closest({ type: "corpse" })?.guid).toBe(LIVE);
  });

  test("a corpse turned to bones — destroyed, then created again under its guid with the bones flag — is no row", () => {
    const c = cache([corpse(30, LIVE, BODY, 4), destroy(31, LIVE), corpse(32, LIVE, BONES, 4)]);
    expect(c.units().map((r) => r.guid)).not.toContain(LIVE);
    expect(corpses(c)).toEqual([]);
    expect(c.closest({ type: "corpse" })).toBeUndefined();
    // The object is still in view; it is only not a corpse.
    expect(c.nearby.has(LIVE)).toBe(true);
  });

  test("bones come into view as bones: no row, and the owner's real corpse beside them stays", () => {
    const c = cache([corpse(30, OLD, BONES, 2), corpse(31, NEW, BODY, 6)]);
    expect(corpses(c)).toEqual([NEW]);
  });

  test("an owner's older corpse gives way to the newer one, whichever is nearer", () => {
    const c = cache([corpse(30, OLD, BODY, 2), corpse(31, NEW, BODY, 6)]);
    expect(corpses(c)).toEqual([NEW]);
    expect(c.closest({ type: "corpse" })?.guid).toBe(NEW);
    // A filter that leaves the newer one out does not bring the older back.
    expect(c.units({ type: "corpse", maxDistance: 4 })).toEqual([]);
    expect(c.closest({ type: "corpse", maxDistance: 4 })).toBeUndefined();
  });

  test("corpses of two owners, and a corpse whose owner was not served, all stay", () => {
    const c = cache([
      corpse(30, OLD, BODY, 2),
      corpse(31, NEW, { ...BODY, corpseOwnerGuid: OTHER }, 6),
      corpse(32, LIVE, { scale: 1 }, 8),
    ]);
    expect(corpses(c)).toEqual([OLD, NEW, LIVE]);
  });
});
