/**
 * Softening repairs from the 2026-08-23 run audit (ADR-0016), kept together so
 * the evidence that earned each one stays next to the behaviour it bought:
 *
 *   - `state.units({ questGiver: true })`: 17 filter-misuse calls, six of them
 *     the boolean spelling, in `fleet-free-oc-a-hy3-free-20260822-c5`;
 *   - unknown filter keys (`dead`, `guid`) now name where the thing they wanted
 *     actually lives, rather than only listing the valid keys;
 *   - the `start_off_mesh` move hint carries the recovery two nav-probe runs
 *     had to find by trial and error.
 */
import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { MOVE_HINTS } from "../src/client";
import { CREATURE_GUID, PLAYER_GUID, playerCreate, questGiverStatusMultiple, worldStream } from "./fixtures";

const SEED = { guid: "7", name: "Fenwick" };

function toEvents(frames: readonly unknown[]): GameEvent[] {
  return frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

const withWorld = (extra: readonly unknown[]): StateCache =>
  StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

describe("units({ questGiver: true })", () => {
  /** CREATURE_GUID has a turn-in ready; PLAYER_GUID's marker was observed as "none". */
  const cache = (): StateCache =>
    withWorld([
      playerCreate,
      questGiverStatusMultiple(
        [
          { guid: CREATURE_GUID, status: 10 },
          { guid: PLAYER_GUID, status: 0 },
        ],
        60,
      ),
    ]);

  test("true means any marker but \"none\"", () => {
    const c = cache();
    expect(c.units({ questGiver: true }).map((r) => r.guid)).toEqual([CREATURE_GUID]);
    // Not "any observed status": "none" is the server saying it has nothing.
    expect(c.units({ questGiver: "none" }).map((r) => r.guid)).toEqual([PLAYER_GUID]);
  });

  test("true composes with the other criteria and with closest()", () => {
    const c = cache();
    expect(c.units({ questGiver: true, maxDistance: 0 })).toEqual([]);
    expect(c.closest({ questGiver: true })?.guid).toBe(CREATURE_GUID);
  });

  test("an unobserved marker never matches", () => {
    expect(withWorld([]).units({ questGiver: true })).toEqual([]);
  });

  test("false is rejected: it has two readings", () => {
    expect(() => cache().units({ questGiver: false as never })).toThrow(/questGiver received false/);
    expect(() => cache().units({ questGiver: false as never })).toThrow(/\{ questGiver: true \}/);
  });

  test("the status-name rejection advertises the boolean shorthand", () => {
    expect(() => cache().units({ questGiver: "turnin" as never })).toThrow(/true for any marker at all/);
  });
});

describe("units() unknown keys point at the real thing", () => {
  test("dead names alive, and does not silently invert it", () => {
    const c = withWorld([]);
    expect(() => c.units({ dead: true } as never)).toThrow(/unknown key "dead"/);
    expect(() => c.units({ dead: true } as never)).toThrow(/use alive instead/);
  });

  test("guid says where a guid is actually used", () => {
    expect(() => withWorld([]).units({ guid: "7" } as never)).toThrow(/guid is not a criterion/);
  });

  test("a key with no hint still lists the valid keys", () => {
    expect(() => withWorld([]).units({ wobble: 1 } as never)).toThrow(
      /unknown key "wobble"\. Valid keys are entry, name, type, alive, maxDistance, npc, role, questGiver\./,
    );
  });
});

describe("start_off_mesh hint", () => {
  test("says the position itself is the problem and names the hearthstone recovery", () => {
    const hint = MOVE_HINTS.start_off_mesh!(
      { x: 1, y: 2, z: 3 },
      { pos: { x: 0, y: 0, z: 0, o: 0, map: 0 } } as never,
    );
    expect(hint).toMatch(/own position/);
    expect(hint).toMatch(/stop\(\)/);
    expect(hint).toMatch(/Hearthstone/);
    expect(hint).toMatch(/state\.bag\(\)/);
    expect(hint).toMatch(/SPELL_FAILED_MOVING/);
  });
});
