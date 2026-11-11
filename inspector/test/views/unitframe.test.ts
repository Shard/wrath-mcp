/**
 * The unit frame's bars: percent clamping, the power tint by type, the dead
 * state, and the "unobserved is not zero" rule the feed relies on.
 */

import { describe, expect, test } from "bun:test";
import type { TraceState } from "../../src/wire";
import { emptyTraceState } from "../../src/codec/trace";
import {
  XP_FOR_LEVEL,
  auraLeft,
  auraViews,
  barReading,
  castReading,
  classPowerType,
  gaugesOf,
  healthReading,
  isDead,
  percentOf,
  sameAuras,
  targetReading,
  unitFlags,
  xpCellTitle,
  powerToken,
  powerTypeOf,
  resolvePowerType,
  xpToNext,
} from "../../src/views/lib/unitframe";

describe("percentOf", () => {
  test("clamps into 0–100 and refuses non-ratios", () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(-5, 200)).toBe(0);
    expect(percentOf(10, 0)).toBe(0);
    expect(percentOf(null, 200)).toBe(0);
    expect(percentOf(10, Number.NaN)).toBe(0);
  });
});

describe("barReading", () => {
  test("prints cur / max with the percent in the title", () => {
    expect(barReading(1234, 5000)).toEqual({ pct: 24.68, text: "1,234 / 5,000", title: "25%", observed: true });
  });
  test("unobserved is a dash, not zero", () => {
    expect(barReading(undefined, undefined)).toEqual({ pct: 0, text: "—", title: "", observed: false });
    expect(barReading(5, null).observed).toBe(false);
  });
});

describe("power", () => {
  test("colours by the client's power type ids", () => {
    expect(powerToken(powerTypeOf(0))).toBe("var(--power-mana)");
    expect(powerToken(powerTypeOf(1))).toBe("var(--power-rage)");
    expect(powerToken(powerTypeOf(2))).toBe("var(--power-focus)");
    expect(powerToken(powerTypeOf(3))).toBe("var(--power-energy)");
    expect(powerToken(powerTypeOf(6))).toBe("var(--power-runic)");
    expect(powerTypeOf(null)).toBe("mana");
    expect(powerTypeOf(99)).toBe("mana");
  });
  test("falls back to the class's primary power at 3.3.5a", () => {
    expect(classPowerType(1)).toBe("rage");
    expect(classPowerType(4)).toBe("energy");
    expect(classPowerType(6)).toBe("runic");
    expect(classPowerType(3)).toBe("mana"); // hunters were mana until Cataclysm
    expect(classPowerType(11)).toBe("mana");
    expect(classPowerType(null)).toBe("mana");
  });
});

describe("dead state", () => {
  test("a corpse and a released ghost both read dead; alive above 1", () => {
    expect(isDead(0)).toBe(true);
    expect(isDead(1)).toBe(true);
    expect(isDead(2)).toBe(false);
    expect(isDead(undefined)).toBe(false);
    expect(isDead(500, true)).toBe(true);
    expect(isDead(0, false)).toBe(false);
  });
  test("the health bar empties and mutes when dead", () => {
    expect(healthReading(1, 120)).toEqual({ pct: 0, text: "0 / 120", title: "dead", observed: true, dead: true });
    expect(healthReading(90, 120).dead).toBe(false);
    expect(healthReading(undefined, undefined)).toMatchObject({ observed: false, dead: false, text: "—" });
  });
});

describe("resolvePowerType", () => {
  test("the sample's own power type wins; the class is the fallback", () => {
    // A druid (class 11) in bear form reports rage, whatever its class says.
    expect(resolvePowerType(1, 11)).toBe("rage");
    expect(resolvePowerType(0, 1)).toBe("mana");
    // A run recorded before the column: the class's primary power stands in.
    expect(resolvePowerType(null, 1)).toBe("rage");
    expect(resolvePowerType(undefined, 4)).toBe("energy");
    expect(resolvePowerType(null, 6)).toBe("runic");
    expect(resolvePowerType(null, null)).toBe("mana");
  });
});

describe("xpToNext", () => {
  test("prefers the character's own value and falls back to the level table", () => {
    expect(xpToNext(5, 2800)).toBe(2800);
    expect(xpToNext(5)).toBe(XP_FOR_LEVEL[5] ?? -1);
    expect(xpToNext(1)).toBe(400);
    expect(xpToNext(80)).toBeNull();
    expect(xpToNext(null)).toBeNull();
    // L1–L79 from the table; L80 is the cap and has no row.
    expect(XP_FOR_LEVEL.length).toBe(80);
  });

  test("the table is AzerothCore's 3.3.5 player_xp_for_level, not the pre-Wrath curve shifted a slot", () => {
    // deps/azerothcore/data/sql/base/db_world/player_xp_for_level.sql
    expect(XP_FOR_LEVEL[59]).toBe(172000);
    expect(XP_FOR_LEVEL[60]).toBe(290000);
    expect(XP_FOR_LEVEL[61]).toBe(317000);
    expect(XP_FOR_LEVEL[69]).toBe(717000);
    expect(XP_FOR_LEVEL[70]).toBe(1523800);
    expect(XP_FOR_LEVEL[79]).toBe(1670800);
  });
});

describe("xpCellTitle — the reading a compact bar cannot print inside itself", () => {
  test("the whole reading: level, xp within it, the level's total, the percentage", () => {
    // L9 leaves at 6,500 xp (XP_FOR_LEVEL[9]).
    expect(xpCellTitle(9, 3250)).toBe("level 9 — 3,250 / 6,500 xp into the level (50%)");
  });

  test("zero xp is a reading and says so", () => {
    expect(xpCellTitle(9, 0)).toBe("level 9 — 0 / 6,500 xp into the level (0%)");
  });

  test("a level with no xp reading is not a level at 0%", () => {
    expect(xpCellTitle(9, null)).toBe("level 9 — no xp reading");
    expect(xpCellTitle(9, undefined)).toBe("level 9 — no xp reading");
  });

  test("no level at all", () => {
    expect(xpCellTitle(null, 400)).toBe("level not recorded");
    expect(xpCellTitle(undefined, undefined)).toBe("level not recorded");
  });

  test("the cap has an xp figure and no total, and says which", () => {
    expect(xpCellTitle(80, 1234)).toBe("level 80 — 1,234 xp into the level, which has no recorded total");
  });

  test("the character's own next-level figure wins over the table", () => {
    expect(xpCellTitle(9, 500, 1000)).toBe("level 9 — 500 / 1,000 xp into the level (50%)");
    // Including at the cap, where the table has nothing to offer.
    expect(xpCellTitle(80, 500, 1000)).toBe("level 80 — 500 / 1,000 xp into the level (50%)");
  });
});

/* --- the trace's half --- */

const state = (over: Partial<TraceState> = {}): TraceState => ({ ...emptyTraceState(), ...over });
const reading = { level: 7, xp: 300, nextLevelXp: 3600, health: 90, maxHealth: 120, power: 40, maxPower: 100, powerType: 0 };

describe("gaugesOf", () => {
  test("the reading alone where the trace has nothing to say", () => {
    expect(gaugesOf(reading, null)).toEqual(reading);
  });

  test("the trace's gauges by pair, and its null kept — a public gauge is withheld while down", () => {
    const g = gaugesOf(reading, state({ hp: null, hpMax: null, pw: 10, pwMax: 50, pwType: 1, level: 8, xp: 20, xpMax: 4500 }));
    expect([g.health, g.maxHealth]).toEqual([null, null]);
    expect([g.power, g.maxPower, g.powerType]).toEqual([10, 50, 1]);
    expect([g.level, g.xp, g.nextLevelXp]).toEqual([8, 20, 4500]);
  });

  test("level and xp fall back field by field", () => {
    const g = gaugesOf(reading, state({ hp: 5, hpMax: 10 }));
    expect([g.level, g.xp, g.nextLevelXp]).toEqual([7, 300, 3600]);
    expect(g.powerType).toBe(0);
  });

  test("dead only when the trace says so: a public segment's absent flag decodes to false", () => {
    expect(gaugesOf(reading, state({ dead: true })).dead).toBe(true);
    expect("dead" in gaugesOf(reading, state({ dead: false }))).toBe(false);
  });
});

describe("auras", () => {
  test("in the server's order, the run-out dropped, a second copy told apart, a debuff by its flag", () => {
    const views = auraViews(
      [
        [1243, 1, 0],
        [774, 3, 50_000, 0x80 | 0x01],
        [774, 1, 60_000],
        [139, 1, 9_000],
      ],
      10_000,
    );
    expect(views.map((v) => v.key)).toEqual(["1243", "774", "774#1"]);
    expect(views.map((v) => v.debuff)).toEqual([false, true, false]);
    expect(views[1]!.stacks).toBe(3);
  });

  test("a row is the same row while no cell changes", () => {
    const a = auraViews([[1243, 1, 0]], 0);
    expect(sameAuras(a, auraViews([[1243, 1, 0]], 5_000))).toBe(true);
    expect(sameAuras(a, auraViews([[1243, 2, 0]], 5_000))).toBe(false);
  });

  test("time left the client's way, and nothing for no expiry", () => {
    expect(auraLeft(0, 5)).toBe("");
    expect(auraLeft(42_000, 0)).toBe("42s");
    expect(auraLeft(299_000, 0)).toBe("5m");
    expect(auraLeft(7_200_000, 0)).toBe("2h");
    expect(auraLeft(1_000, 5_000)).toBe("0s");
  });
});

describe("the cast bar", () => {
  test("filled from its start to its end, and gone once it has ended", () => {
    const c = { spellId: 133, endsAt: 4_000 };
    expect(castReading(c, 1_000, 2_500)).toEqual({ spellId: 133, pct: 50, text: "1.5s" });
    expect(castReading(c, null, 2_500)?.pct).toBe(0);
    expect(castReading(c, 1_000, 4_000)).toBeNull();
    expect(castReading(null, null, 0)).toBeNull();
  });
});

describe("flags and target", () => {
  test("the states, in a fixed order", () => {
    expect(unitFlags(state({ resting: true, combat: true, taxi: true, mounted: true }))).toEqual(["combat", "mounted", "flying", "resting"]);
    expect(unitFlags(state())).toEqual([]);
  });

  test("a target only when there is one, its health unobserved when not sent", () => {
    expect(targetReading(null)).toBeNull();
    expect(targetReading({ kind: "creature", entry: 299, hpPct: 40 })).toEqual({ pct: 40, text: "creature 299", title: "target · 40%", observed: true });
    expect(targetReading({ kind: "player" })?.observed).toBe(false);
  });
});
