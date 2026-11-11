/**
 * Trace v1: one character's movement and unit state, packed per five-minute
 * window — the codec the inspector serves and its map player decodes, and
 * that a harness may serve and publish as it is.
 *
 * The recorder writes the session's `trace` stream (`docs/SESSION-FORMAT.md`):
 * `key` (full state), `pos` (a position sample, `{"jump":1}` when it was not
 * reached by travel), `state` (the changed keys only; `auras` whole) and
 * `flight` (a taxi takeoff, `{"to":{map,x,y,z},"durationMs"}`). This file turns
 * one window of them into a segment and back.
 *
 * **Segment.** One session × one UTC-aligned window `[t0, t1)`, `t1 = t0 + SEG_MS`,
 * self-contained: it decodes alone. Columnar JSON, keys in this order:
 *
 * - `v` 1; `run`, the session's id (a name kept from when sessions were a
 *   harness's runs); `t0`, `t1` (epoch ms); `q: {p: 10, o: 1024}` — positions in
 *   1/10 yd, orientation in 1/1024 turn. Decoders read `q`, not the constants.
 * - `k`, the keyframe. `p: [map, x, y, z, o]` quantised absolute — where the
 *   character was at `t0` (interpolated between the samples either side when
 *   they are close and continuous) or null if no position was known. `pt` is
 *   the ms from `t0` at which that position was observed, absent when 0. `s`
 *   is the full `TraceState` at `t0`. `f: [map, x, y, z, ms]` is a flight still
 *   in the air at `t0`: its destination and the ms left.
 * - `dt`, `x`, `y`, `z`, `o`: one entry per sample. `dt` is ms since the
 *   previous sample (the first since `t0`); the rest are integer deltas from
 *   the previous sample (the first from `k.p`, or from 0 when it is null),
 *   `o` wrapped to the short way round. A null z or o carries the last one.
 * - `cuts: [[i, map]]`: sample `i` was a jump or landed on another map, and
 *   `map` is the map from it on. Never interpolated into. With `k.p` null the
 *   first sample is always one.
 * - `flights: [[i, map, x, y, z, ms]]`: sample `i` is a taxi takeoff; it flies
 *   straight to the quantised absolute destination over `ms`.
 * - `ev: [[ms, kind, value]]`: state changes after the keyframe, `ms` from `t0`,
 *   `kind` a `TraceState` key, in recorded order.
 *
 * **The character sheet** (`TraceSheet`: money, `equip`, `bags`, `inv`, `dur`,
 * `quests`, `rep`, `skills`) rides the same keyframe and event list, as
 * numbers and ids. `k.s` holds each observed sheet key whole; one it lacks is
 * not recorded, never empty. A list's event is a patch, not a value: the rows
 * that changed, whole, and a row of only its key fields (`[slot]`,
 * `[bag, slot]`, `[factionId]`, `[skillId]`) for one that went; a list after
 * null is whole, and a null event is back to unobserved. `qdone` events carry
 * the quest ids the server confirmed turned in at that moment: they append,
 * are never compared with what came before, and are in no keyframe. Two
 * dictionaries make the segment decode alone, each holding exactly the ids
 * its keyframe and events reference: `items: {id: [quality, name]}`, the item
 * template's name, and `qreq: {id: [r0, r1, r2, r3, [itemId, n]...]}`, the
 * counts each quest needs. The unit-state readers (`stateAt`) never see the
 * sheet; `sheetAt` folds it.
 *
 * **Chat** rides the event list too: `[ms, "chat", [kind, text]]`, one per
 * line the character said (`TraceChat`: say, party, raid, yell, whisper or
 * emote, and the model's own text, at most `CHAT_MAX_CHARS`). Like `qdone`
 * it is an event and never state: in no keyframe, never compared, every line
 * kept. It was added after the first segments were published, under the rule
 * below, so a window that closed before it says nothing, which reads as no
 * line said.
 *
 * **Versioning.** A decoder ignores keys it does not know and skips events of
 * kinds it does not know, so a field or an event kind is added without a bump;
 * `v` moves only when a meaning changes, and a v1 decoder refuses anything else.
 *
 * **Playback** (`sampleAt`): positions interpolate linearly, orientation the
 * short way round. A sample is held, not interpolated out of, into a cut,
 * across a map change and across a gap longer than `GAP_MS`; a takeoff flies
 * straight to its destination over its duration and holds there until the
 * landing sample.
 *
 * Imports nothing but wire types: a browser bundles it, so nothing
 * server-side may follow it in. The server half is `readout.ts`, over a
 * session source (`source.ts`).
 */

import type {
  TraceAura,
  TraceCast,
  TraceChat,
  TraceChatKind,
  TraceEventWire,
  TraceItemName,
  TraceKeyframe,
  TraceQuestReq,
  TraceSegment,
  TraceSegRuns,
  TraceSheet,
  TraceState,
  TraceTarget,
} from "../wire";

export type {
  TraceAura,
  TraceCast,
  TraceChat,
  TraceChatKind,
  TraceEventWire,
  TraceItemName,
  TraceKeyframe,
  TraceQuestReq,
  TraceSegment,
  TraceSegRuns,
  TraceSheet,
  TraceState,
  TraceTarget,
};

export const TRACE_VERSION = 1;

/** One window. UTC-aligned, so every reader cuts the same boundaries. */
export const SEG_MS = 300_000;

/**
 * How long after its end a window is still taken to be growing.
 *
 * The recorder buffers rows in the sandbox child and the host drains them on
 * its 5 s ticker, so a row observed just before `t1` reaches the record up to
 * a drain later — longer when the drain waits on a slow disk or a slow RPC,
 * and the row's stamp is the child's clock while the reader's may be another
 * machine's. A harness may cache a closed segment as immutable for a year, so
 * a row that landed after it was served would be lost for good; a minute is
 * twelve drains of margin and costs only that the tail is a minute longer.
 */
export const SETTLE_MS = 60_000;

/**
 * How far before `t0` a caller reads to seed the keyframe. Three windows: the
 * recorder writes a `key` row in every window it is live for, so this always
 * holds one, and a taxi flight in the air at `t0` took off inside it.
 */
export const CONTEXT_MS = 3 * SEG_MS;

/** Samples further apart than this are held, not interpolated between. */
export const GAP_MS = 5_000;

export const Q_POS = 10;
export const Q_O = 1024;

/** `TraceState`'s keys, in the order every keyframe and event list uses. */
export const STATE_KEYS = [
  "hp",
  "hpMax",
  "pw",
  "pwMax",
  "pwType",
  "level",
  "xp",
  "xpMax",
  "auras",
  "combat",
  "mounted",
  "taxi",
  "dead",
  "ghost",
  "resting",
  "target",
  "cast",
  // Appended, so every key before them keeps its place; a keyframe carries
  // them only once observed (`STATE_KEYS_IF_OBSERVED`).
  "zone",
  "area",
] as const;
export type TraceStateKey = (typeof STATE_KEYS)[number];

/**
 * The state keys a keyframe carries only when they hold a reading: a trace
 * recorded before them never named a zone or an area, and its segments read
 * exactly as they did before the keys existed; a trace that has them names
 * them.
 */
const STATE_KEYS_IF_OBSERVED: ReadonlySet<TraceStateKey> = new Set(["zone", "area"]);

/** A trace row as the encoder reads it: the record's row with its `data` as JSON text (`readout.ts` makes them). */
export interface TraceRow {
  ts: number;
  kind: string;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  o: number | null;
  data: string | null;
}

export interface TraceWindow {
  /** The session's id, written as the segment's `run`. */
  run: string;
  t0: number;
  t1: number;
}

/* ------------------------------------------------------------- windows --- */

/** The window a timestamp falls in. */
export function windowOf(ts: number, segMs = SEG_MS): number {
  return Math.floor(ts / segMs) * segMs;
}

/**
 * The first window that is not closed at `now`: every window before it ended at
 * least `SETTLE_MS` ago. It is also where the tail starts.
 */
export function tailStart(now: number, segMs = SEG_MS): number {
  return windowOf(now - SETTLE_MS, segMs);
}

/** Whether the window at `t0` is closed — settled, so its segment never changes. */
export function isClosed(t0: number, now: number, segMs = SEG_MS): boolean {
  return t0 < tailStart(now, segMs);
}

/** Window `t0`s to runs of consecutive windows, sorted and deduplicated. */
export function packSegs(t0s: readonly number[], segMs = SEG_MS): TraceSegRuns {
  const out: TraceSegRuns = [];
  for (const t of [...new Set(t0s)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last !== undefined && last[0] + last[1] * segMs === t) last[1] += 1;
    else out.push([t, 1]);
  }
  return out;
}

/** Runs back to every window `t0`, ascending. */
export function unpackSegs(runs: TraceSegRuns, segMs = SEG_MS): number[] {
  const out: number[] = [];
  for (const [first, count] of runs) for (let i = 0; i < count; i++) out.push(first + i * segMs);
  return out;
}

export function segRunsHas(runs: TraceSegRuns, t0: number, segMs = SEG_MS): boolean {
  return runs.some(([first, count]) => t0 >= first && t0 < first + count * segMs && (t0 - first) % segMs === 0);
}

/** `runs` with `t0` added, as a fresh list. */
export function segRunsAdd(runs: TraceSegRuns, t0: number, segMs = SEG_MS): TraceSegRuns {
  return segRunsHas(runs, t0, segMs) ? runs.map(([a, b]): [number, number] => [a, b]) : packSegs([...unpackSegs(runs, segMs), t0], segMs);
}

/* --------------------------------------------------------------- state --- */

export function emptyTraceState(): TraceState {
  return {
    hp: null,
    hpMax: null,
    pw: null,
    pwMax: null,
    pwType: null,
    level: null,
    xp: null,
    xpMax: null,
    auras: [],
    combat: false,
    mounted: false,
    taxi: false,
    dead: false,
    ghost: false,
    resting: false,
    target: null,
    cast: null,
    zone: null,
    area: null,
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** `undefined` is "not a valid value for this key", and the key is then left alone. */
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : finite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === 1 ? true : v === 0 ? false : undefined);

function aura(v: unknown): TraceAura | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const [id, stacks, expiresAt, flags] = v as unknown[];
  if (!finite(id) || !finite(stacks) || !finite(expiresAt)) return undefined;
  return finite(flags) ? [id, stacks, expiresAt, flags] : [id, stacks, expiresAt];
}

const TARGET_KINDS = new Set(["creature", "player", "object", "other"]);

/**
 * Each key's reader: the value rebuilt fresh in a fixed shape, or `undefined`
 * when the input is not one. Typed over every key, so a key added to
 * `TraceState` does not compile until it has one.
 */
const SANITIZE: { [K in TraceStateKey]: (v: unknown) => TraceState[K] | undefined } = {
  hp: numOrNull,
  hpMax: numOrNull,
  pw: numOrNull,
  pwMax: numOrNull,
  pwType: numOrNull,
  level: numOrNull,
  xp: numOrNull,
  xpMax: numOrNull,
  auras: (v) => (v === null ? [] : Array.isArray(v) ? v.map(aura).filter((a): a is TraceAura => a !== undefined) : undefined),
  combat: bool,
  mounted: bool,
  taxi: bool,
  dead: bool,
  ghost: bool,
  resting: bool,
  target: (v): TraceTarget | null | undefined => {
    if (v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o["kind"] !== "string" || !TARGET_KINDS.has(o["kind"])) return undefined;
    return {
      kind: o["kind"] as TraceTarget["kind"],
      ...(finite(o["entry"]) ? { entry: o["entry"] } : {}),
      ...(finite(o["hpPct"]) ? { hpPct: o["hpPct"] } : {}),
    };
  },
  cast: (v): TraceCast | null | undefined => {
    if (v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    return finite(o["spellId"]) && finite(o["endsAt"]) ? { spellId: o["spellId"], endsAt: o["endsAt"] } : undefined;
  },
  zone: numOrNull,
  area: numOrNull,
};

/** Whether `kind` names a state key this decoder knows. */
export function isStateKey(kind: unknown): kind is TraceStateKey {
  return typeof kind === "string" && Object.hasOwn(SANITIZE, kind);
}

/** One key's value, sanitized; `undefined` when it is not a valid one. */
export function sanitizeStateValue<K extends TraceStateKey>(key: K, v: unknown): TraceState[K] | undefined {
  return SANITIZE[key](v) as TraceState[K] | undefined;
}

function setKey(s: TraceState, key: TraceStateKey, value: unknown): void {
  (s as unknown as Record<string, unknown>)[key] = value;
}

/** A full state from a keyframe's object: missing or invalid keys read as empty. */
export function stateOf(o: unknown): TraceState {
  const s = emptyTraceState();
  if (o === null || typeof o !== "object" || Array.isArray(o)) return s;
  for (const key of STATE_KEYS) {
    const v = SANITIZE[key]((o as Record<string, unknown>)[key]);
    if (v !== undefined) setKey(s, key, v);
  }
  return s;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function parseData(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- sheet --- */

/** `TraceSheet`'s keys, in the order every keyframe and event list uses. */
export const SHEET_KEYS = ["money", "equip", "bags", "inv", "dur", "quests", "rep", "skills"] as const;
export type TraceSheetKey = (typeof SHEET_KEYS)[number];
export type TraceSheetListKey = Exclude<TraceSheetKey, "money">;
/** The event kind that appends turn-ins and is never state. */
export const QDONE = "qdone";

/** How many leading fields key a row of each list, and how many fields a row has at most. */
export const SHEET_KEY_LEN: { readonly [K in TraceSheetListKey]: number } = { equip: 1, bags: 1, inv: 2, dur: 1, quests: 1, rep: 1, skills: 1 };
const SHEET_ROW_MAX: { readonly [K in TraceSheetListKey]: number } = { equip: 3, bags: 3, inv: 5, dur: 3, quests: 7, rep: 2, skills: 3 };
/** Which field of a row is an item id, for the dictionary. */
const ITEM_FIELD: Partial<Record<TraceSheetListKey, number>> = { equip: 1, bags: 1, inv: 2 };

export function emptyTraceSheet(): TraceSheet {
  return { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null };
}

/** Whether `kind` names a sheet key, or the turn-in event. */
export function isSheetKind(kind: unknown): kind is TraceSheetKey | typeof QDONE {
  return typeof kind === "string" && (kind === QDONE || (SHEET_KEYS as readonly string[]).includes(kind));
}

const rowKey = (row: readonly number[], keyLen: number): string => (keyLen === 1 ? String(row[0]) : `${row[0]},${row[1]}`);
const sortRows = <T extends readonly number[]>(rows: T[]): T[] => rows.sort((a, b) => a[0]! - b[0]! || (a[1] ?? 0) - (b[1] ?? 0));
const sameRow = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A list's rows rebuilt fresh, each all finite numbers and at most the key's
 * width; `minLen` is the key length for a patch (a removal is a key alone)
 * and one past it for a whole list. `undefined` when `v` is not a list, or
 * is one whose every row was malformed (an empty list is a value; a list of
 * nothing usable is not).
 */
function rowsOf(key: TraceSheetListKey, v: unknown, patch: boolean): number[][] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const keyLen = SHEET_KEY_LEN[key];
  const minLen = patch ? keyLen : keyLen + 1;
  const out: number[][] = [];
  for (const r of v as unknown[]) {
    if (!Array.isArray(r) || r.length < minLen) continue;
    const row = (r as unknown[]).slice(0, SHEET_ROW_MAX[key]);
    if (row.every(finite)) out.push(row as number[]);
  }
  return out.length === 0 && v.length > 0 ? undefined : out;
}

/** A sheet from a keyframe's object: keys it lacks, or carries invalid, read as null. */
export function sheetOf(o: unknown): TraceSheet {
  const s = emptyTraceSheet();
  if (o === null || typeof o !== "object" || Array.isArray(o)) return s;
  const d = o as Record<string, unknown>;
  if (finite(d["money"])) s.money = d["money"];
  for (const key of SHEET_KEYS) {
    if (key === "money") continue;
    const rows = rowsOf(key, d[key], false);
    if (rows !== undefined && rows !== null) setSheet(s, key, dedupe(rows, SHEET_KEY_LEN[key]));
  }
  return s;
}

function setSheet(s: TraceSheet, key: TraceSheetKey, v: unknown): void {
  (s as unknown as Record<string, unknown>)[key] = v;
}

/** One row per key, the last one standing, in key order. */
function dedupe(rows: number[][], keyLen: number): number[][] {
  const m = new Map<string, number[]>();
  for (const r of rows) m.set(rowKey(r, keyLen), r);
  return sortRows([...m.values()]);
}

/** A list with a patch applied, as a fresh array in key order; the input is never mutated. A null patch is unobserved. */
export function applySheetPatch(list: readonly (readonly number[])[] | null, patch: readonly (readonly number[])[] | null, keyLen: number): number[][] | null {
  if (patch === null) return null;
  const rows = new Map<string, number[]>();
  for (const r of list ?? []) rows.set(rowKey(r, keyLen), r as number[]);
  for (const r of patch) {
    if (r.length < keyLen) continue;
    if (r.length === keyLen) rows.delete(rowKey(r, keyLen));
    else rows.set(rowKey(r, keyLen), [...r]);
  }
  return sortRows([...rows.values()]);
}

/** The patch from `a` to `b`, in key order: `undefined` when they are the same, `b` whole after null, null when `b` is. */
export function sheetPatch(a: readonly (readonly number[])[] | null, b: readonly (readonly number[])[] | null, keyLen: number): number[][] | null | undefined {
  if (b === null) return a === null ? undefined : null;
  if (a === null) return b.map((r) => [...r]);
  const before = new Map<string, readonly number[]>();
  for (const r of a) before.set(rowKey(r, keyLen), r);
  const out: number[][] = [];
  for (const r of b) {
    const k = rowKey(r, keyLen);
    const o = before.get(k);
    before.delete(k);
    if (o === undefined || !sameRow(o, r)) out.push([...r]);
  }
  for (const r of before.values()) out.push(r.slice(0, keyLen));
  return out.length === 0 ? undefined : sortRows(out);
}

/* ---------------------------------------------------------------- chat --- */

/** The event kind that carries a line the character said, and is never state. */
export const CHAT = "chat";
/** The longest line a segment carries, in characters: the client's own input limit. */
export const CHAT_MAX_CHARS = 255;
export const CHAT_KINDS: readonly TraceChatKind[] = ["say", "party", "raid", "yell", "whisper", "emote"];

/** One chat line rebuilt fresh, or `undefined` when `v` is not one: a known kind and a non-empty string. */
export function chatOf(v: unknown): TraceChat | undefined {
  if (!Array.isArray(v) || typeof v[1] !== "string" || v[1].length === 0) return undefined;
  const kind = v[0] as TraceChatKind;
  return CHAT_KINDS.includes(kind) ? [kind, v[1].slice(0, CHAT_MAX_CHARS)] : undefined;
}

/** A 'state' row's chat lines, sanitized; empty when it carries none. */
function chatLines(data: Record<string, unknown> | null): TraceChat[] {
  const v = data?.[CHAT];
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).map(chatOf).filter((c): c is TraceChat => c !== undefined);
}

/** A trace row's chat lines from its stored `data` text, sanitized as a segment's are; empty when it carries none. */
export function chatOfRowData(text: string | null): TraceChat[] {
  return chatLines(parseData(text));
}

/** A turn-in event's ids, or `undefined` when `v` is not a list of them. */
function qdoneOf(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = (v as unknown[]).filter(finite);
  return ids.length === 0 ? undefined : ids;
}

/** One sheet change, as the event list carries it: a new `money`, a list's effective patch, or turn-ins. */
export type TraceSheetChange = [TraceSheetKey | typeof QDONE, number | number[][] | number[] | null];

/**
 * A 'state' row's sheet applied: the new sheet and the changes it actually
 * made — `money` when it moved, each list's effective patch (rows that
 * already read so dropped), and the turn-ins, which always count.
 */
function mergedSheet(sheet: TraceSheet, data: Record<string, unknown> | null): { sheet: TraceSheet; changes: TraceSheetChange[] } {
  const changes: TraceSheetChange[] = [];
  if (data === null) return { sheet, changes };
  let next: TraceSheet | null = null;
  for (const key of SHEET_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    if (key === "money") {
      const v = numOrNull(data[key]);
      if (v === undefined || v === sheet.money) continue;
      (next ??= { ...sheet }).money = v;
      changes.push([key, v]);
      continue;
    }
    const patch = rowsOf(key, data[key], true);
    if (patch === undefined) continue;
    const after = applySheetPatch(sheet[key], patch, SHEET_KEY_LEN[key]);
    const eff = sheetPatch(sheet[key], after, SHEET_KEY_LEN[key]);
    if (eff === undefined) continue;
    setSheet((next ??= { ...sheet }), key, after);
    changes.push([key, eff]);
  }
  const done = qdoneOf(data[QDONE]);
  if (done !== undefined) changes.push([QDONE, done]);
  return { sheet: next ?? sheet, changes };
}

/** A mid-window key row's sheet against the running one: what differs, as patches. */
function sheetDiff(a: TraceSheet, b: TraceSheet): TraceSheetChange[] {
  const changes: TraceSheetChange[] = [];
  for (const key of SHEET_KEYS) {
    if (key === "money") {
      if (a.money !== b.money) changes.push([key, b.money]);
      continue;
    }
    const eff = sheetPatch(a[key], b[key], SHEET_KEY_LEN[key]);
    if (eff !== undefined) changes.push([key, eff]);
  }
  return changes;
}

/** Where a segment finds what its ids are shown by: the session's dictionary, answered per id. */
export interface TraceDictLookup {
  item(itemId: number): TraceItemName | undefined;
  quest(questId: number): TraceQuestReq | undefined;
}

/** An item dictionary entry rebuilt: a finite quality or null, and a string name. */
export function itemNameOf(v: unknown): TraceItemName | undefined {
  if (!Array.isArray(v) || typeof v[1] !== "string") return undefined;
  return [finite(v[0]) ? v[0] : null, v[1]];
}

/** A quest's required counts rebuilt: four numbers, then `[itemId, count]` pairs. */
export function questReqOf(v: unknown): TraceQuestReq | undefined {
  if (!Array.isArray(v) || v.length < 4) return undefined;
  const head = (v as unknown[]).slice(0, 4);
  if (!head.every(finite)) return undefined;
  const req: TraceQuestReq = [head[0] as number, head[1] as number, head[2] as number, head[3] as number];
  for (const p of (v as unknown[]).slice(4)) if (Array.isArray(p) && finite(p[0]) && finite(p[1])) req.push([p[0], p[1]]);
  return req;
}

/** The item and quest ids a sheet, or a change to one, references. */
function refsOf(lists: Iterable<[TraceSheetKey | typeof QDONE, unknown]>, items: Set<number>, quests: Set<number>): void {
  for (const [key, v] of lists) {
    if (key === "money" || key === QDONE || !Array.isArray(v)) continue;
    const at = ITEM_FIELD[key];
    for (const r of v as number[][]) {
      if (at !== undefined && r.length > at && r[at]! > 0) items.add(r[at]!);
      if (key === "quests" && r.length > 1) quests.add(r[1]!);
    }
  }
}

/* ----------------------------------------------------------- positions --- */

const TURN = 2 * Math.PI;
/** `+ 0` folds a `-0` into `0`, so the wire never depends on which side a round fell. */
const int = (v: number): number => Math.round(v) + 0;
const qp = (v: number): number => int(v * Q_POS);
const qo = (rad: number): number => ((int((rad / TURN) * Q_O) % Q_O) + Q_O) % Q_O;
/** An orientation delta in units, the short way round: [−q/2, q/2). */
const wrap = (d: number, q: number): number => ((((d + q / 2) % q) + q) % q) - q / 2;

interface Pos {
  ts: number;
  map: number;
  x: number;
  y: number;
  z: number | null;
  o: number | null;
}

interface Flight {
  ts: number;
  from: Pos;
  to: { map: number; x: number; y: number; z: number | null };
  ms: number;
}

function posOf(r: TraceRow): Pos | null {
  if (!finite(r.map) || !finite(r.x) || !finite(r.y)) return null;
  return { ts: r.ts, map: r.map, x: r.x, y: r.y, z: finite(r.z) ? r.z : null, o: finite(r.o) ? r.o : null };
}

function flightOf(r: TraceRow, from: Pos): Flight | null {
  const data = parseData(r.data);
  const to = data?.["to"];
  if (to === null || typeof to !== "object" || Array.isArray(to)) return null;
  const t = to as Record<string, unknown>;
  const ms = data?.["durationMs"];
  if (!finite(t["map"]) || !finite(t["x"]) || !finite(t["y"]) || !finite(ms) || ms <= 0) return null;
  return { ts: r.ts, from, to: { map: t["map"], x: t["x"], y: t["y"], z: finite(t["z"]) ? t["z"] : null }, ms };
}

const isSample = (r: TraceRow): boolean => (r.kind === "pos" || r.kind === "flight") && posOf(r) !== null;
/** A sample the character did not travel to: `{"jump":1}` on a `pos` row. */
function isJump(r: TraceRow): boolean {
  if (r.kind !== "pos") return false;
  const j = parseData(r.data)?.["jump"];
  return j !== undefined && j !== null && j !== 0 && j !== false;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** Shortest-arc blend of two orientations in radians, into [0, 2π). */
function arc(a: number, b: number, f: number): number {
  let d = (b - a) % TURN;
  if (d > Math.PI) d -= TURN;
  if (d < -Math.PI) d += TURN;
  return (((a + d * f) % TURN) + TURN) % TURN;
}

/** The heading from one point to another, as WoW measures orientation; `fallback` when they coincide. */
function heading(ax: number, ay: number, bx: number, by: number, fallback: number): number {
  if (ax === bx && ay === by) return fallback;
  return (Math.atan2(by - ay, bx - ax) + TURN) % TURN;
}

/* -------------------------------------------------------------- encode --- */

/**
 * Encode one window. Deterministic: the same rows give byte-identical output.
 *
 * **The caller's contract.** `rows` are the session's rows with `ts` in
 * `[t0 − CONTEXT_MS, t1)`, in write order (`ts` ascending, ties by rowid).
 * Rows before `t0` are context: they seed the keyframe and are never emitted.
 * The keyframe is exact when the context reaches back to a `key` row (the
 * recorder writes one per live window, so `CONTEXT_MS` holds three), and a
 * flight in the air at `t0` carries on only when its takeoff is in it. With no
 * `key` row in the context the window's own first `key` row seeds the
 * keyframe, folding in the state of the rows before it inside the window (their
 * positions stay samples). Rows at or after `t1` are ignored. A window with no
 * rows of its own still encodes — to a keyframe and nothing else — so whether
 * that is worth serving is the caller's call.
 *
 * `dict` answers the item names and quest requirements the sheet references
 * (the trace's `dict` entries); without one, or for an id it does not know, the segment
 * carries the ids alone.
 */
export function encodeSegment(rows: readonly TraceRow[], window: TraceWindow, dict?: TraceDictLookup): TraceSegment {
  const { run, t0, t1 } = window;
  // Stable, so rows the caller handed over in rowid order keep it on a tie.
  const sorted = [...rows].filter((r) => finite(r.ts) && r.ts < t1).sort((a, b) => a.ts - b.ts);
  const firstIn = sorted.findIndex((r) => r.ts >= t0);
  const context = firstIn === -1 ? sorted : sorted.slice(0, firstIn);
  const inWindow = firstIn === -1 ? [] : sorted.slice(firstIn);

  // The context, folded: the state, the last position sample, a flight with no
  // sample since its takeoff, and the newest key row's position as a last resort.
  let state = emptyTraceState();
  let sheet = emptyTraceSheet();
  let contextKey = false;
  let lastPos: Pos | null = null;
  let flight: Flight | null = null;
  let keyPos: Pos | null = null;
  for (const r of context) {
    if (r.kind === "key") {
      const data = parseData(r.data);
      state = stateOf(data);
      sheet = sheetOf(data);
      contextKey = true;
      keyPos = posOf(r) ?? keyPos;
    } else if (r.kind === "state") {
      const data = parseData(r.data);
      state = merged(state, data).state;
      sheet = mergedSheet(sheet, data).sheet;
    } else if (r.kind === "pos" || r.kind === "flight") {
      const p = posOf(r);
      if (p === null) continue;
      lastPos = p;
      flight = r.kind === "flight" ? flightOf(r, p) : null;
    }
  }

  // No key row before the window: its own first key row stands in for one.
  let eventsFrom = 0;
  if (!contextKey) {
    const at = inWindow.findIndex((r) => r.kind === "key");
    if (at !== -1) {
      // A key row is the whole state, so the state rows before it inside the
      // window are already folded into it; their positions stay samples. The
      // turn-ins among them are events, not state, and are not in it.
      const data = parseData(inWindow[at]!.data);
      state = stateOf(data);
      sheet = sheetOf(data);
      eventsFrom = at + 1;
      if (lastPos === null && keyPos === null && !inWindow.slice(0, at).some(isSample)) keyPos = posOf(inWindow[at]!);
    }
  }

  // Where the character stood at t0.
  const first = inWindow.find(isSample);
  let base: Pos | null = null;
  let pt = 0;
  let inFlight: [number, number, number, number, number] | undefined;
  if (flight !== null && flight.to.map === flight.from.map) {
    // Still in the air, or landed by the clock with no landing sample yet.
    const elapsed = t0 - flight.ts;
    const o = heading(flight.from.x, flight.from.y, flight.to.x, flight.to.y, flight.from.o ?? 0);
    const toZ = flight.to.z ?? flight.from.z;
    if (elapsed < flight.ms) {
      const f = elapsed / flight.ms;
      const z = flight.from.z === null || toZ === null ? toZ : lerp(flight.from.z, toZ, f);
      base = { ts: t0, map: flight.from.map, x: lerp(flight.from.x, flight.to.x, f), y: lerp(flight.from.y, flight.to.y, f), z, o };
      inFlight = [flight.to.map, qp(flight.to.x), qp(flight.to.y), qp(toZ ?? 0), int(flight.ms - elapsed)];
    } else {
      base = { ts: flight.ts + flight.ms, map: flight.to.map, x: flight.to.x, y: flight.to.y, z: toZ, o };
      pt = int(flight.ts + flight.ms - t0);
    }
  } else if (lastPos !== null) {
    const next = first === undefined ? null : posOf(first);
    if (next !== null && !isJump(first!) && next.map === lastPos.map && next.ts - lastPos.ts <= GAP_MS && next.ts > lastPos.ts) {
      const f = (t0 - lastPos.ts) / (next.ts - lastPos.ts);
      const z = lastPos.z === null || next.z === null ? (lastPos.z ?? next.z) : lerp(lastPos.z, next.z, f);
      const o = lastPos.o === null || next.o === null ? (lastPos.o ?? next.o) : arc(lastPos.o, next.o, f);
      base = { ts: t0, map: lastPos.map, x: lerp(lastPos.x, next.x, f), y: lerp(lastPos.y, next.y, f), z, o };
    } else {
      base = lastPos;
      pt = int(lastPos.ts - t0);
    }
  } else if (keyPos !== null) {
    base = keyPos;
    pt = int(keyPos.ts - t0);
  }

  const kp: [number, number, number, number, number] | null =
    base === null ? null : [base.map, qp(base.x), qp(base.y), qp(base.z ?? 0), qo(base.o ?? 0)];
  const s: Partial<TraceState & TraceSheet> = {};
  for (const key of STATE_KEYS) if (!STATE_KEYS_IF_OBSERVED.has(key) || state[key] !== null) setKey(s as TraceState, key, state[key]);
  // The sheet's observed keys only: one the run never recorded stays absent.
  for (const key of SHEET_KEYS) if (sheet[key] !== null) setSheet(s as TraceSheet, key, sheet[key]);
  const k: TraceKeyframe = { p: kp, ...(pt !== 0 ? { pt } : {}), s, ...(inFlight !== undefined ? { f: inFlight } : {}) };

  // The samples.
  const dt: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const os: number[] = [];
  const cuts: [number, number][] = [];
  const flights: [number, number, number, number, number, number][] = [];
  let prevT = t0;
  let [prevMap, prevX, prevY, prevZ, prevO] = kp ?? [null, 0, 0, 0, 0];
  for (const r of inWindow) {
    if (!isSample(r)) continue;
    const p = posOf(r)!;
    const i = dt.length;
    const qx = qp(p.x);
    const qy = qp(p.y);
    const qz = p.z === null ? prevZ : qp(p.z);
    const qO = p.o === null ? prevO : qo(p.o);
    dt.push(int(r.ts - prevT));
    xs.push(qx - prevX);
    ys.push(qy - prevY);
    zs.push(qz - prevZ);
    os.push(wrap(qO - prevO, Q_O) + 0);
    if (prevMap === null || p.map !== prevMap || isJump(r)) cuts.push([i, p.map]);
    if (r.kind === "flight") {
      const fl = flightOf(r, p);
      if (fl !== null) flights.push([i, fl.to.map, qp(fl.to.x), qp(fl.to.y), qp(fl.to.z ?? p.z ?? 0), int(fl.ms)]);
    }
    [prevT, prevMap, prevX, prevY, prevZ, prevO] = [r.ts, p.map, qx, qy, qz, qO];
  }

  // The state changes after the keyframe, and the sheet's. The lines said
  // before a keyframe taken from inside the window are not in it, as no
  // event is, so they lead the list.
  const ev: TraceEventWire[] = [];
  const itemIds = new Set<number>();
  const questIds = new Set<number>();
  refsOf(SHEET_KEYS.map((key) => [key, sheet[key]]), itemIds, questIds);
  for (const r of inWindow.slice(0, eventsFrom)) {
    if (r.kind !== "state") continue;
    for (const c of chatLines(parseData(r.data))) ev.push([int(r.ts - t0), CHAT, c]);
  }
  for (const r of inWindow.slice(eventsFrom)) {
    if (r.kind !== "state" && r.kind !== "key") continue;
    const data = parseData(r.data);
    // A key row mid-window (the child restarted, or reattached) is a full
    // state: what differs from the running fold is what changed.
    const whole = r.kind === "key" ? stateOf(data) : null;
    const prev = state;
    const next = whole === null ? merged(state, data) : { state: whole, changed: STATE_KEYS.filter((key) => !same(whole[key], prev[key])) };
    const ms = int(r.ts - t0);
    for (const key of next.changed) ev.push([ms, key, next.state[key]]);
    state = next.state;
    let changes: TraceSheetChange[];
    if (r.kind === "key") {
      const wholeSheet = sheetOf(data);
      changes = sheetDiff(sheet, wholeSheet);
      sheet = wholeSheet;
    } else {
      const m = mergedSheet(sheet, data);
      changes = m.changes;
      sheet = m.sheet;
    }
    for (const [key, v] of changes) ev.push([ms, key, v]);
    refsOf(changes, itemIds, questIds);
    if (r.kind === "state") for (const c of chatLines(data)) ev.push([ms, CHAT, c]);
  }

  const seg: TraceSegment = { v: TRACE_VERSION, run, t0, t1, q: { p: Q_POS, o: Q_O }, k, dt, x: xs, y: ys, z: zs, o: os, cuts, flights, ev };
  if (dict !== undefined) attachDict(seg, dict, itemIds, questIds);
  return seg;
}

/**
 * The dictionaries for the ids a segment references, in id order: each
 * quest's required counts, and the names of its items and of the items its
 * quests ask for. An id the run never named is left out, and so is an empty
 * dictionary.
 */
function attachDict(seg: TraceSegment, dict: TraceDictLookup, itemIds: Set<number>, questIds: Set<number>): void {
  const qreq: Record<string, TraceQuestReq> = {};
  for (const id of [...questIds].sort((a, b) => a - b)) {
    const req = questReqOf(dict.quest(id));
    if (req === undefined) continue;
    qreq[id] = req;
    for (const p of req.slice(4) as [number, number][]) if (p[0] > 0) itemIds.add(p[0]);
  }
  const items: Record<string, TraceItemName> = {};
  for (const id of [...itemIds].sort((a, b) => a - b)) {
    const name = itemNameOf(dict.item(id));
    if (name !== undefined) items[id] = name;
  }
  if (Object.keys(items).length > 0) seg.items = items;
  if (Object.keys(qreq).length > 0) seg.qreq = qreq;
}

/** A partial state row applied: the new state and the keys that actually changed, in key order. */
function merged(state: TraceState, data: Record<string, unknown> | null): { state: TraceState; changed: TraceStateKey[] } {
  const next = { ...state };
  const changed: TraceStateKey[] = [];
  if (data === null) return { state: next, changed };
  for (const key of STATE_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const v = SANITIZE[key](data[key]);
    if (v === undefined || same(v, state[key])) continue;
    setKey(next, key, v);
    changed.push(key);
  }
  return { state: next, changed };
}

/* -------------------------------------------------------------- decode --- */

/** A flight's destination and duration, on the frame that takes off. */
export interface TraceFlightTo {
  map: number;
  x: number;
  y: number;
  z: number;
  ms: number;
}

/** One position, in yards and radians, at epoch ms `t`. */
export interface TraceFrame {
  t: number;
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
  /** Reached by a jump or onto another map: never interpolated into. */
  cut: boolean;
  /** Present on a takeoff: where it flies to, and how long it takes. */
  fly?: TraceFlightTo;
}

/** A flight, listed for drawing: which frame takes off, and where to. */
export interface TraceFlight extends TraceFlightTo {
  frame: number;
  t: number;
}

export type TraceEvent = { [K in TraceStateKey]: { t: number; kind: K; value: TraceState[K] } }[TraceStateKey];

export interface DecodedSegment {
  run: string;
  t0: number;
  t1: number;
  /** The keyframe's position (when it had one) first, then every sample. */
  frames: TraceFrame[];
  flights: TraceFlight[];
  /** The state at `t0`. A key the segment does not carry reads as empty. */
  key: TraceState;
  /** State changes, by time. */
  events: TraceEvent[];
  /** The sheet at `t0`: a key the segment does not carry is null, not recorded. */
  sheet: TraceSheet;
  /** The sheet's changes, by time: a list's are patches, `qdone` its turn-ins. Folded by `sheetAt`. */
  sheetEvents: TraceSheetEvent[];
  /** The names and qualities of the items it references, and the counts its quests need, by id. */
  items: ReadonlyMap<number, TraceItemName>;
  qreq: ReadonlyMap<number, TraceQuestReq>;
  /** The lines the character said, by time. */
  chat: TraceChatLine[];
}

/** One line the character said, at epoch ms `t`. */
export interface TraceChatLine {
  t: number;
  kind: TraceChatKind;
  text: string;
}

/** One sheet change: a new `money`, a list's patch, or the quest ids turned in. */
export type TraceSheetEvent =
  | { t: number; kind: "money"; value: number | null }
  | { t: number; kind: TraceSheetListKey; value: number[][] | null }
  | { t: number; kind: typeof QDONE; value: number[] };

const numAt = (a: unknown, i: number): number => {
  const v = Array.isArray(a) ? (a as unknown[])[i] : undefined;
  return finite(v) ? v : 0;
};

/** Decode a segment (a v1 one: anything else throws, since its meaning has changed). */
export function decodeSegment(seg: TraceSegment): DecodedSegment {
  if (seg.v !== TRACE_VERSION) throw new Error(`trace segment v${String(seg.v)}: this decoder reads v${TRACE_VERSION}`);
  const qP = finite(seg.q?.p) && seg.q.p > 0 ? seg.q.p : Q_POS;
  const qO = finite(seg.q?.o) && seg.q.o > 0 ? seg.q.o : Q_O;
  const rad = (u: number): number => ((((u % qO) + qO) % qO) / qO) * TURN;
  const frames: TraceFrame[] = [];
  const flights: TraceFlight[] = [];

  const fly = (map: number, x: number, y: number, z: number, ms: number): TraceFlightTo => ({ map, x: x / qP, y: y / qP, z: z / qP, ms });
  const kp = Array.isArray(seg.k?.p) ? seg.k.p : null;
  // The running position in quantised units, from the keyframe's (or from 0).
  let map = kp === null ? 0 : numAt(kp, 0);
  let cx = kp === null ? 0 : numAt(kp, 1);
  let cy = kp === null ? 0 : numAt(kp, 2);
  let cz = kp === null ? 0 : numAt(kp, 3);
  let co = kp === null ? 0 : numAt(kp, 4);
  if (kp !== null) {
    const f = Array.isArray(seg.k.f) ? seg.k.f : null;
    const frame: TraceFrame = {
      t: seg.t0 + (finite(seg.k.pt) ? seg.k.pt : 0),
      map,
      x: cx / qP,
      y: cy / qP,
      z: cz / qP,
      o: rad(co),
      cut: false,
      ...(f === null ? {} : { fly: fly(numAt(f, 0), numAt(f, 1), numAt(f, 2), numAt(f, 3), numAt(f, 4)) }),
    };
    frames.push(frame);
    if (frame.fly !== undefined) flights.push({ frame: 0, t: frame.t, ...frame.fly });
  }

  const cuts = new Map<number, number>();
  for (const c of Array.isArray(seg.cuts) ? seg.cuts : []) if (Array.isArray(c) && finite(c[0]) && finite(c[1])) cuts.set(c[0], c[1]);
  const takeoffs = new Map<number, TraceFlightTo>();
  for (const f of Array.isArray(seg.flights) ? seg.flights : []) {
    if (Array.isArray(f) && finite(f[0])) takeoffs.set(f[0], fly(numAt(f, 1), numAt(f, 2), numAt(f, 3), numAt(f, 4), numAt(f, 5)));
  }
  const cols = [seg.dt, seg.x, seg.y, seg.z, seg.o];
  const n = Math.min(...cols.map((c) => (Array.isArray(c) ? c.length : 0)));
  let t = seg.t0;
  for (let i = 0; i < n; i++) {
    t += numAt(seg.dt, i);
    cx += numAt(seg.x, i);
    cy += numAt(seg.y, i);
    cz += numAt(seg.z, i);
    co += numAt(seg.o, i);
    const cutMap = cuts.get(i);
    if (cutMap !== undefined) map = cutMap;
    const to = takeoffs.get(i);
    const frame: TraceFrame = {
      t,
      map,
      x: cx / qP,
      y: cy / qP,
      z: cz / qP,
      o: rad(co),
      cut: cutMap !== undefined,
      ...(to === undefined ? {} : { fly: to }),
    };
    if (to !== undefined) flights.push({ frame: frames.length, t, ...to });
    frames.push(frame);
  }

  const events: TraceEvent[] = [];
  const sheetEvents: TraceSheetEvent[] = [];
  const chat: TraceChatLine[] = [];
  for (const e of Array.isArray(seg.ev) ? seg.ev : []) {
    if (!Array.isArray(e) || !finite(e[0])) continue;
    if (e[1] === CHAT) {
      const c = chatOf(e[2]);
      if (c !== undefined) chat.push({ t: seg.t0 + e[0], kind: c[0], text: c[1] });
      continue;
    }
    if (isStateKey(e[1])) {
      const value = SANITIZE[e[1]](e[2]);
      if (value !== undefined) events.push({ t: seg.t0 + e[0], kind: e[1], value } as TraceEvent);
      continue;
    }
    const ev = sheetEventOf(seg.t0 + e[0], e[1], e[2]);
    if (ev !== undefined) sheetEvents.push(ev);
  }
  events.sort((a, b) => a.t - b.t);
  sheetEvents.sort((a, b) => a.t - b.t);
  chat.sort((a, b) => a.t - b.t);

  const items = new Map<number, TraceItemName>();
  for (const [id, v] of Object.entries(isRecord(seg.items) ? seg.items : {})) {
    const name = itemNameOf(v);
    if (name !== undefined && finite(Number(id))) items.set(Number(id), name);
  }
  const qreq = new Map<number, TraceQuestReq>();
  for (const [id, v] of Object.entries(isRecord(seg.qreq) ? seg.qreq : {})) {
    const req = questReqOf(v);
    if (req !== undefined && finite(Number(id))) qreq.set(Number(id), req);
  }

  return { run: seg.run, t0: seg.t0, t1: seg.t1, frames, flights, key: stateOf(seg.k?.s), events, sheet: sheetOf(seg.k?.s), sheetEvents, items, qreq, chat };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** One wire event as a sheet change, sanitized; `undefined` when it is not one. */
function sheetEventOf(t: number, kind: unknown, v: unknown): TraceSheetEvent | undefined {
  if (!isSheetKind(kind)) return undefined;
  if (kind === QDONE) {
    const ids = qdoneOf(v);
    return ids === undefined ? undefined : { t, kind, value: ids };
  }
  if (kind === "money") {
    const m = numOrNull(v);
    return m === undefined ? undefined : { t, kind, value: m };
  }
  const rows = rowsOf(kind, v, true);
  return rows === undefined ? undefined : { t, kind, value: rows };
}

/* ------------------------------------------------------------ playback --- */

export interface TracePose {
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
  /** Between a takeoff and the end of its flight. */
  flying: boolean;
}

const pose = (f: TraceFrame): TracePose => ({ map: f.map, x: f.x, y: f.y, z: f.z, o: f.o, flying: false });

/**
 * Where the character was at `t`, from frames in time order — one segment's,
 * or several laid end to end. Null before the first frame; the last one holds
 * after it.
 */
export function sampleAt(frames: readonly TraceFrame[], t: number): TracePose | null {
  let lo = 0;
  let hi = frames.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (i === -1) return null;
  const a = frames[i]!;
  if (a.fly !== undefined && a.fly.map === a.map) {
    const f = a.fly.ms <= 0 ? 1 : Math.min(1, (t - a.t) / a.fly.ms);
    return {
      map: a.map,
      x: lerp(a.x, a.fly.x, f),
      y: lerp(a.y, a.fly.y, f),
      z: lerp(a.z, a.fly.z, f),
      o: heading(a.x, a.y, a.fly.x, a.fly.y, a.o),
      flying: f < 1,
    };
  }
  const b = frames[i + 1];
  if (b === undefined || b.cut || b.map !== a.map || b.t - a.t > GAP_MS || b.t <= a.t) return pose(a);
  const f = (t - a.t) / (b.t - a.t);
  return { map: a.map, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), o: arc(a.o, b.o, f), flying: false };
}

/** The state at `t`: the keyframe with every event at or before `t` applied. */
export function stateAt(seg: DecodedSegment, t: number): TraceState {
  const s: TraceState = { ...seg.key, auras: [...seg.key.auras] };
  for (const e of seg.events) {
    if (e.t > t) break;
    setKey(s, e.kind, e.value);
  }
  return s;
}

/** The sheet at a moment, and the quest ids turned in since the segment's `t0`. */
export interface TraceSheetAt extends TraceSheet {
  qdone: number[];
}

/** The last fold `sheetAt` made per segment: how many events it applied, and what it made of them. */
const sheetMemo = new WeakMap<DecodedSegment, { n: number; at: TraceSheetAt }>();

/**
 * The sheet at `t`: the keyframe's with every sheet event at or before `t`
 * applied. Kept apart from `stateAt`, which the unit frame calls every frame
 * and which copies what it returns: this one is memoised on the events it
 * has applied, so a frame that crosses none gets the very object the last
 * one did, and a playhead moving forward applies only what it crossed. Every
 * list it returns is fresh and never mutated afterwards.
 */
export function sheetAt(seg: DecodedSegment, t: number): TraceSheetAt {
  const evs = seg.sheetEvents;
  let lo = 0;
  let hi = evs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (evs[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  const n = lo;
  const memo = sheetMemo.get(seg);
  if (memo !== undefined && memo.n === n) return memo.at;
  const from = memo !== undefined && memo.n < n ? memo : { n: 0, at: { ...seg.sheet, qdone: [] } };
  const at: TraceSheetAt = { ...from.at, qdone: [...from.at.qdone] };
  for (let i = from.n; i < n; i++) {
    const e = evs[i]!;
    if (e.kind === QDONE) at.qdone.push(...e.value);
    else if (e.kind === "money") at.money = e.value;
    else setSheet(at, e.kind, applySheetPatch(at[e.kind], e.value, SHEET_KEY_LEN[e.kind]));
  }
  sheetMemo.set(seg, { n, at });
  return at;
}
