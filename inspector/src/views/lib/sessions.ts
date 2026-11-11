/**
 * What the inspector's own views derive from the API's bodies: which sessions
 * are live, a session's character at the end of its trace, its party, and an
 * event row as one line. Pure, so it is tested without a DOM.
 */

import { decodeSegment, sampleAt, sheetAt, stateAt, type DecodedSegment } from "../../codec/trace";
import type { LiveFileWire, RowWire, SessionSummary, TraceSegment, TraceState } from "../../wire";
import { sheetItems, type InvItem } from "./inventory";
import { questLog, type QuestRow } from "./questlog";
import { auraViews, castReading, gaugesOf, resolvePowerType, targetReading, unitFlags, type AuraView, type BarReading, type CastReading, type Gauges, type PowerType, type UnitFlag } from "./unitframe";

/** A session whose writer has ticked within this is live. Its writer beats every few seconds. */
export const LIVE_MS = 2 * 60_000;

/** Whether the session is being written: not ended, and its heartbeat fresh. */
export function isLive(s: Pick<SessionSummary, "session" | "live">, now: number): boolean {
  if (s.session === null || s.session.ended !== null) return false;
  return s.live !== null && now - s.live.ts <= LIVE_MS;
}

/** The name a session is shown by: its character's, else its id. */
export function sessionName(s: Pick<SessionSummary, "id" | "session">): string {
  return s.session?.character?.name ?? s.id;
}

/** Where the session last stood, or null when its last reading has no position. */
export function livePosition(live: LiveFileWire | null): { map: number; x: number; y: number } | null {
  if (live === null || live.map === null || live.x === null || live.y === null) return null;
  return { map: live.map, x: live.x, y: live.y };
}

/** Listed sessions in the order a reader scans them: live first, then the newest opened. */
export function sessionOrder<T extends Pick<SessionSummary, "id" | "session" | "live">>(list: readonly T[], now: number): T[] {
  return [...list].sort((a, b) => Number(isLive(b, now)) - Number(isLive(a, now)) || (b.session?.opened ?? 0) - (a.session?.opened ?? 0) || a.id.localeCompare(b.id));
}

/** A duration as the views print it: `45s`, `12m`, `3h 05m`, `2d 4h`. */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Copper as `1g 23s 45c`, the largest coin first, zeros left out. */
export function fmtMoney(copper: number | null | undefined): string {
  if (copper === null || copper === undefined) return "—";
  const g = Math.floor(copper / 10_000);
  const s = Math.floor((copper % 10_000) / 100);
  const c = copper % 100;
  const parts = [g > 0 ? `${g}g` : "", s > 0 ? `${s}s` : "", c > 0 || (g === 0 && s === 0) ? `${c}c` : ""];
  return parts.filter((p) => p !== "").join(" ");
}

// ------------------------------------------------------------ the character

/** The character at one instant of its trace: what the unit frame and the inventory draw. */
export interface CharacterAt {
  t: number;
  map: number | null;
  x: number | null;
  y: number | null;
  gauges: Gauges;
  powerType: PowerType;
  cast: CastReading | null;
  target: BarReading | null;
  flags: UnitFlag[];
  auras: AuraView[];
  money: number | null;
  items: InvItem[] | null;
  quests: QuestRow[] | null;
}

/** When the cast in progress at `t` began, from the segment's events; null when it began before the segment. */
function castFrom(seg: DecodedSegment, state: TraceState, t: number): number | null {
  if (state.cast === null) return null;
  let from: number | null = null;
  for (const e of seg.events) {
    if (e.t > t) break;
    if (e.kind === "cast") from = e.value === null ? null : e.t;
  }
  return from;
}

/** The character at `t` in a decoded segment, its class from `session.json` for a bar the trace has no type for. */
export function characterAt(seg: DecodedSegment, t: number, klass: number | null = null): CharacterAt {
  const state = stateAt(seg, t);
  const sheet = sheetAt(seg, t);
  const pose = sampleAt(seg.frames, t);
  const gauges = gaugesOf({}, state);
  return {
    t,
    map: pose?.map ?? null,
    x: pose?.x ?? null,
    y: pose?.y ?? null,
    gauges,
    powerType: resolvePowerType(gauges.powerType, klass),
    cast: castReading(state.cast, castFrom(seg, state, t), t),
    target: targetReading(state.target),
    flags: unitFlags(state),
    auras: auraViews(state.auras, t),
    money: sheet.money,
    items: sheetItems(sheet, seg.items),
    quests: questLog(sheet, seg.qreq, seg.items),
  };
}

/** The newest instant a segment answers for: its last sample, else its last event, else its start. */
export function segmentEnd(seg: DecodedSegment): number {
  let t = seg.t0;
  const lastFrame = seg.frames[seg.frames.length - 1];
  if (lastFrame !== undefined) t = Math.max(t, lastFrame.t);
  const lastEvent = seg.events[seg.events.length - 1];
  if (lastEvent !== undefined) t = Math.max(t, lastEvent.t);
  const lastSheet = seg.sheetEvents[seg.sheetEvents.length - 1];
  if (lastSheet !== undefined) t = Math.max(t, lastSheet.t);
  return t;
}

/** A packed window decoded, or null when it does not decode. */
export function decoded(seg: TraceSegment | null): DecodedSegment | null {
  if (seg === null) return null;
  try {
    return decodeSegment(seg);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- the party

/** One member of a session's party: its guid, and the session it is when it is one of this deployment's. */
export interface PartyMember {
  guid: string;
  session: SessionSummary | null;
}

export interface PartyView {
  /** Every member the record kept: the deployment's own characters. */
  members: PartyMember[];
  /** Members who are not sessions of this deployment, counted and never named (the write gate's rule). */
  foreign: number;
  leaderGuid: string | null;
}

/**
 * The party as the newest `group` event left it (or the events key's `group`
 * state, when no event followed), each member matched to the session that is
 * that character. Null when the session is in no party.
 */
export function partyOf(rows: readonly RowWire[], sessions: readonly SessionSummary[]): PartyView | null {
  let group: Record<string, unknown> | null = null;
  for (const r of rows) {
    if (r.kind === "group") group = r.event === "left" ? null : r;
    else if (r.kind === "key") {
      const state = r["state"] as { group?: Record<string, unknown> | null } | undefined;
      if (state !== undefined && state.group !== undefined) group = state.group;
    }
  }
  if (group === null) return null;
  const byGuid = new Map<string, SessionSummary>();
  for (const s of sessions) if (s.session?.character?.guid !== undefined) byGuid.set(s.session.character.guid, s);
  const members = (Array.isArray(group["members"]) ? (group["members"] as unknown[]) : []).filter((g): g is string => typeof g === "string").map((guid) => ({ guid, session: byGuid.get(guid) ?? null }));
  return { members, foreign: typeof group["foreign"] === "number" ? group["foreign"] : 0, leaderGuid: typeof group["leaderGuid"] === "string" ? group["leaderGuid"] : null };
}

// ------------------------------------------------------------- the feed

const FIELD_ORDER = ["to", "from", "id", "name", "event", "map", "zone", "area", "points", "count", "victimGuid", "entry", "rank"] as const;

/** An `events` row as one line: its kind and the fields that say what happened, in a fixed order. */
export function eventLine(r: RowWire): string {
  const parts: string[] = [r.kind];
  for (const k of FIELD_ORDER) {
    const v = r[k];
    if (v === undefined || v === null || typeof v === "object") continue;
    parts.push(`${k} ${String(v)}`);
  }
  if (r.kind === "group" && Array.isArray(r["members"])) parts.push(`members ${(r["members"] as unknown[]).length}${typeof r["foreign"] === "number" && r["foreign"] > 0 ? ` (+${r["foreign"]})` : ""}`);
  if (r.kind === "death" && r["released"] === true) parts.push("released");
  return parts.join(" · ");
}
