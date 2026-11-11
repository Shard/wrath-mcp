/**
 * The unit frame's arithmetic, kept pure so the bars are checked here rather
 * than by looking at a DOM.
 *
 * The frame is modelled on the client's own: a health bar, a power bar tinted
 * by the character's power type, and an experience bar with the level in a
 * badge where the portrait's ring would be. Colours are the client's
 * `PowerBarColor` triples (mana 0/0/1, rage 1/0/0, energy 1/1/0, focus
 * 1/.5/.25, runic power 0/.82/1) pulled toward the page in each scheme, as
 * custom properties in `styles.css`; this file only names them.
 *
 * What the feed carries decides what draws. Level and xp are on every
 * `AgentPosition`; health, power, the power type and the class ride with them
 * since, but a run recorded before that carries none, so a bar whose
 * numbers are absent renders as *unobserved* — an empty track with a dash —
 * rather than as zero. Undefined means unobserved, never zero, the same rule
 * the SDK holds.
 */

import type { TraceAura, TraceCast, TraceState, TraceTarget } from "../../wire";

/** 3.3.5a power type ids, as `UNIT_FIELD_BYTES_0` carries them. */
export type PowerType = "mana" | "rage" | "focus" | "energy" | "runic";

const POWER_BY_ID: Record<number, PowerType> = { 0: "mana", 1: "rage", 2: "focus", 3: "energy", 6: "runic" };

/** The power type behind a numeric id; anything the client has no bar for is mana. */
export function powerTypeOf(id: number | null | undefined): PowerType {
  return (id === null || id === undefined ? undefined : POWER_BY_ID[id]) ?? "mana";
}

/**
 * A class's primary power at 3.3.5a, for a feed that carries the class but no
 * per-sample power type. Hunters used mana until Cataclysm; focus is the pet's.
 */
export function classPowerType(klass: number | null | undefined): PowerType {
  switch (klass) {
    case 1: return "rage"; // warrior
    case 4: return "energy"; // rogue
    case 6: return "runic"; // death knight
    default: return "mana";
  }
}

/**
 * Which bar to tint: the sample's own `powerType` when the feed carried one,
 * the class's primary power otherwise. A druid's bar therefore reads mana on
 * an old run and rage in bear form on a new one, which is what the client does.
 */
export function resolvePowerType(
  powerType: number | null | undefined,
  klass: number | null | undefined,
): PowerType {
  return powerType === null || powerType === undefined ? classPowerType(klass) : powerTypeOf(powerType);
}

/** The custom property each power type paints with; see `styles.css`. */
export function powerToken(type: PowerType): string {
  return `var(--power-${type})`;
}

/** A bar's fill as 0–100, clamped, and 0 for anything that is not a real ratio. */
export function percentOf(cur: number | null | undefined, max: number | null | undefined): number {
  if (typeof cur !== "number" || typeof max !== "number") return 0;
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (cur / max) * 100));
}

/** What one bar draws: its fill, its label, and whether it has numbers at all. */
export interface BarReading {
  pct: number;
  /** "cur / max" — or a dash when unobserved. */
  text: string;
  /** "42%" for the title; empty when unobserved. */
  title: string;
  observed: boolean;
}

export function barReading(cur: number | null | undefined, max: number | null | undefined): BarReading {
  const observed = typeof cur === "number" && typeof max === "number" && max > 0;
  if (!observed) return { pct: 0, text: "—", title: "", observed: false };
  const pct = percentOf(cur, max);
  return { pct, text: `${fmtInt(cur)} / ${fmtInt(max)}`, title: `${Math.round(pct)}%`, observed: true };
}

/**
 * Dead or a released ghost. The cache's own convention: health 0 is a corpse,
 * 1 is a ghost (`BuildPlayerRepop` sets it), anything above is alive. A feed
 * that says so outright (`dead: true`) wins over the inference.
 */
export function isDead(health: number | null | undefined, dead?: boolean | null): boolean {
  if (dead === true) return true;
  if (dead === false) return false;
  return typeof health === "number" && health <= 1;
}

/**
 * Health as the frame shows it: a dead character's bar is empty and muted
 * even though a ghost technically carries 1 hp.
 */
export function healthReading(cur: number | null | undefined, max: number | null | undefined, dead?: boolean | null): BarReading & { dead: boolean } {
  const d = isDead(cur, dead);
  const r = barReading(cur, max);
  if (d && r.observed) return { ...r, pct: 0, text: `0 / ${fmtInt(max as number)}`, title: "dead", dead: true };
  return { ...r, dead: d };
}

/**
 * XP needed to leave each level at 3.3.5a, indexed by level (index 0 unused).
 * Generated from AzerothCore's `player_xp_for_level` table
 * (`deps/azerothcore/data/sql/base/db_world/player_xp_for_level.sql`, rows
 * L1–L79; the cap has no row): the earlier constant was a pre-Wrath curve shifted a slot, so it
 * had L59 wanting 171,900 and L60 178,100 where the 3.3.5 table has 172,000
 * and 290,000. A fallback for a feed that carries `xp` but not `nextLevelXp`;
 * the character's own value wins when present. Level 80 is the cap and has no next.
 */
export const XP_FOR_LEVEL: readonly number[] = [
  0,
  400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600,
  8700, 9800, 11000, 12300, 13600, 15000, 16400, 17800, 19300, 20800,
  22400, 24000, 25500, 27200, 28900, 30500, 32200, 33900, 36300, 38800,
  41600, 44600, 48000, 51400, 55000, 58700, 62400, 66200, 70200, 74300,
  78500, 82800, 87100, 91600, 96300, 101000, 105800, 110700, 115700, 120900,
  126100, 131500, 137000, 142500, 148200, 154000, 159900, 165800, 172000, 290000,
  317000, 349000, 386000, 428000, 475000, 527000, 585000, 648000, 717000, 1523800,
  1539600, 1555700, 1571800, 1587900, 1604200, 1620700, 1637400, 1653900, 1670800,
];

export function xpToNext(level: number | null | undefined, nextLevelXp?: number | null): number | null {
  if (typeof nextLevelXp === "number" && nextLevelXp > 0) return nextLevelXp;
  if (typeof level !== "number" || level < 1 || level >= 80) return null;
  return XP_FOR_LEVEL[level] ?? null;
}

/* One formatter for every bar and hover: `toLocaleString` built a new one per call, eight per table row. */
const INT = new Intl.NumberFormat("en-US");

function fmtInt(n: number): string {
  return INT.format(Math.round(n));
}

/**
 * The exact reading a compact xp bar cannot print inside itself.
 *
 * A table cell is too narrow for "1,234 / 5,400", so the bar in a row carries
 * no text and this sentence is its `title`. It is the whole reading — the
 * level, the xp within it, the level's own total and the percentage — because
 * a hover that says less than the bar shows is worse than no hover.
 *
 * Every absence is named rather than drawn as a zero: the ladder's own rule
 * that 0 xp is a reading and "never recorded" is not. Level 80 and any level
 * the table cannot answer for have an xp figure and no total, and say so.
 */
export function xpCellTitle(
  level: number | null | undefined,
  xp: number | null | undefined,
  nextLevelXp?: number | null,
): string {
  if (typeof level !== "number") return "level not recorded";
  const head = `level ${level}`;
  if (typeof xp !== "number") return `${head} — no xp reading`;
  const next = xpToNext(level, nextLevelXp);
  if (next === null || next <= 0) return `${head} — ${fmtInt(xp)} xp into the level, which has no recorded total`;
  return `${head} — ${fmtInt(xp)} / ${fmtInt(next)} xp into the level (${Math.round(percentOf(xp, next))}%)`;
}

/* --- the trace's half of the frame (`traceplayer.ts` reads the state) --- */

/** The numbers the bars draw, wherever they came from. */
export interface Gauges {
  level: number | null | undefined;
  xp: number | null | undefined;
  nextLevelXp: number | null | undefined;
  health: number | null | undefined;
  maxHealth: number | null | undefined;
  power: number | null | undefined;
  maxPower: number | null | undefined;
  powerType: number | null | undefined;
  /** Only ever `true` or absent: see `gaugesOf`. */
  dead?: true;
}

/** The fields a position or a track point carries for the frame. */
export type GaugeSource = Partial<Omit<Gauges, "dead">>;

/**
 * The frame's numbers at the playhead: the trace's state where the trace
 * answers for that moment, the reading's (an `AgentPosition`, or the track
 * point a replay cursor stands on) where it does not.
 *
 * The gauges come by pair, never mixed — a trace's hp over a 60 s sample's
 * max is a bar no observation drew — and while the trace answers, its null is
 * kept rather than filled from the reading: it is a gauge the trace did not
 * observe (or, in a public segment published before deaths were public, one
 * withheld while the character was down), and a bar filled in from the sample
 * beside it would draw what no observation saw. Level and xp fall back field
 * by field.
 *
 * `dead` is passed only when the trace says so. A segment published before
 * deaths were public carries no `dead` at all and the decoder reads that as
 * `false`, which `isDead` would take as a positive "alive" over the hp
 * inference.
 */
export function gaugesOf(reading: GaugeSource, state: TraceState | null): Gauges {
  if (state === null) {
    return {
      level: reading.level,
      xp: reading.xp,
      nextLevelXp: reading.nextLevelXp,
      health: reading.health,
      maxHealth: reading.maxHealth,
      power: reading.power,
      maxPower: reading.maxPower,
      powerType: reading.powerType,
    };
  }
  const xpFromTrace = state.xp !== null;
  return {
    level: state.level ?? reading.level,
    xp: xpFromTrace ? state.xp : reading.xp,
    nextLevelXp: xpFromTrace ? state.xpMax : reading.nextLevelXp,
    health: state.hp,
    maxHealth: state.hpMax,
    power: state.pw,
    maxPower: state.pwMax,
    powerType: state.pwType ?? reading.powerType,
    ...(state.dead ? { dead: true as const } : {}),
  };
}

/** One aura as the buffs row draws it. `key` is unique within the row, so a cell keeps its link across updates. */
export interface AuraView {
  key: string;
  spellId: number;
  stacks: number;
  /** Epoch ms; 0 is no expiry. */
  expiresAt: number;
  /** The aura's own negative flag, which only a private segment carries. */
  debuff: boolean;
}

/** `AFLAG_NEGATIVE`, in the flags byte `SMSG_AURA_UPDATE` sends per aura. */
const AURA_NEGATIVE = 0x80;

/**
 * The buffs row at `t`: in the order the server sent them, without the ones
 * whose time ran out before the update removing them arrived. A spell on the
 * unit twice (two casters' copies) keeps both, told apart by key.
 */
export function auraViews(auras: readonly TraceAura[], t: number): AuraView[] {
  const seen = new Map<number, number>();
  const out: AuraView[] = [];
  for (const [spellId, stacks, expiresAt, flags] of auras) {
    if (expiresAt > 0 && expiresAt <= t) continue;
    const n = seen.get(spellId) ?? 0;
    seen.set(spellId, n + 1);
    out.push({
      key: n === 0 ? String(spellId) : `${spellId}#${n}`,
      spellId,
      stacks,
      expiresAt,
      debuff: flags !== undefined && (flags & AURA_NEGATIVE) !== 0,
    });
  }
  return out;
}

/** Whether two rows draw the same cells: the same keys with the same stacks and expiry. */
export function sameAuras(a: readonly AuraView[], b: readonly AuraView[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return x.key === y.key && x.stacks === y.stacks && x.expiresAt === y.expiresAt && x.debuff === y.debuff;
  });
}

/** An aura's time left, the client's way: seconds under a minute, then minutes, then hours; empty for no expiry. */
export function auraLeft(expiresAt: number, t: number): string {
  if (expiresAt <= 0) return "";
  const s = Math.max(0, Math.ceil((expiresAt - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** A cast in progress, as its bar draws it. */
export interface CastReading {
  spellId: number;
  /** 0–100; 0 when its start is not on the record. */
  pct: number;
  /** The time left, to a tenth of a second. */
  text: string;
}

/**
 * The cast bar at `t`, from the cast and the moment the record shows it
 * starting (`TraceUnit.castFrom`). Nothing once its end has passed: the update
 * clearing it can land a tick after the spell went off.
 */
export function castReading(cast: TraceCast | null, from: number | null, t: number): CastReading | null {
  if (cast === null || t >= cast.endsAt) return null;
  const pct = from === null || cast.endsAt <= from ? 0 : percentOf(t - from, cast.endsAt - from);
  return { spellId: cast.spellId, pct, text: `${((cast.endsAt - t) / 1000).toFixed(1)}s` };
}

/** The states the frame names beside the bars. */
export type UnitFlag = "combat" | "mounted" | "flying" | "resting" | "ghost";

/** Which of them hold, in a fixed order. */
export function unitFlags(state: TraceState): UnitFlag[] {
  const out: UnitFlag[] = [];
  if (state.combat) out.push("combat");
  if (state.mounted) out.push("mounted");
  if (state.taxi) out.push("flying");
  if (state.resting) out.push("resting");
  if (state.ghost) out.push("ghost");
  return out;
}

/**
 * The target's bar: its kind and, for a creature, the entry the server gave,
 * with its health — or its name, where the live map's nearby layer holds the
 * unit the character has targeted (`lib/nearbyplayer.ts`; the trace itself
 * carries no name by design). Null with no target — and always on the public
 * site, which withholds it.
 */
export function targetReading(target: TraceTarget | null, name: string | null = null): BarReading | null {
  if (target === null) return null;
  const fallback = target.kind === "creature" && target.entry !== undefined ? `creature ${target.entry}` : target.kind;
  const label = name ?? fallback;
  if (target.hpPct === undefined) return { pct: 0, text: label, title: "target", observed: false };
  const pct = Math.min(100, Math.max(0, target.hpPct));
  return { pct, text: label, title: `target · ${Math.round(pct)}%`, observed: true };
}
