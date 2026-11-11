/**
 * `wrath-session/1`: the shapes of a session record on disk. The prose
 * specification is `docs/SESSION-FORMAT.md`; this file is its types and
 * constants, shared by the writer (`writer.ts`), the reader (`reader.ts`),
 * the validator (`validate.ts`) and the recorders that produce the rows.
 *
 * A session is one directory: `session.json`, `live.json`, an optional
 * `manifest.json`, and one subdirectory per stream holding append-only JSONL
 * segments. Every row is a JSON object with a `ts` (epoch ms) and a `kind`,
 * and every segment's first row is a `key` row that states its stream whole,
 * so a segment decodes with no other file.
 *
 * Unstable until v1 ships: the format is documented, not yet a public
 * contract, and may change without a version move until then.
 */

import type { EventSummary, ActionNote } from "../sandbox/ipc";
import type { NearbyRow } from "./nearby-row";
import type { TraceRow } from "./trace-row";

export * from "./trace-row";
export * from "./nearby-row";

/** The `format` every `session.json` and `manifest.json` carries. */
export const SESSION_FORMAT = "wrath-session/1";

export const SESSION_FILE = "session.json";
export const LIVE_FILE = "live.json";
export const MANIFEST_FILE = "manifest.json";

/** The streams, each a subdirectory of the session directory. */
export const STREAMS = ["trace", "events", "calls", "nearby"] as const;
export type StreamName = (typeof STREAMS)[number];

/** The streams a capture holds: every one but the live-only ring. */
export const CAPTURED_STREAMS = ["trace", "events", "calls"] as const satisfies readonly StreamName[];

/** One stream × one UTC-aligned window of this many ms is a segment. */
export const SEGMENT_MS = 300_000;

/** The window a timestamp falls in, as its start. */
export function segmentStart(ts: number): number {
  return ts - (ts % SEGMENT_MS);
}

/** A segment file's parts: its window, its part within the window, and whether it is compressed. */
export interface SegmentName {
  t0: number;
  /** 0 for the window's first file; above 0 when a closed one already held the window. */
  part: number;
  compressed: boolean;
}

const SEGMENT_RE = /^(\d{13})(?:-(\d{1,4}))?\.jsonl(\.zst)?$/;

/** `<t0>[-<part>].jsonl[.zst]` → its parts, or null for anything else in a stream directory. */
export function parseSegmentName(name: string): SegmentName | null {
  const m = SEGMENT_RE.exec(name);
  if (m === null) return null;
  const t0 = Number(m[1]);
  if (!Number.isSafeInteger(t0) || t0 % SEGMENT_MS !== 0) return null;
  const part = m[2] === undefined ? 0 : Number(m[2]);
  if (m[2] !== undefined && part === 0) return null;
  return { t0, part, compressed: m[3] !== undefined };
}

/** The file name of a segment, plain or compressed. */
export function segmentFileName(t0: number, part = 0, compressed = false): string {
  return `${String(t0).padStart(13, "0")}${part > 0 ? `-${part}` : ""}.jsonl${compressed ? ".zst" : ""}`;
}

/** A segment's name without its compression suffix: what a cursor and the manifest call it. */
export function segmentStem(t0: number, part = 0): string {
  return segmentFileName(t0, part, false);
}

// ------------------------------------------------------------ session.json

/** The character a session drove, once observed. Never a token or an account name. */
export interface SessionCharacter {
  guid: string;
  name: string | null;
  race: number | null;
  class: number | null;
}

/**
 * `session.json`: what the session is. Rewritten whole (write to a temporary
 * name, then rename) when the session opens, when the character is first
 * observed or changes, and when it closes.
 */
export interface SessionFile {
  format: typeof SESSION_FORMAT;
  /** The first 16 hex characters of the session token's SHA-256: the stem of the module's audit files. */
  id: string;
  /** Null until the character is in the world. */
  character: SessionCharacter | null;
  /** The stack that recorded it: its version, and its commit when the host knew one. */
  stack: { version: string; commit?: string };
  /** The module it drove, from `GET /health`; null when it did not answer. */
  module: { build: string | null; protocol: number | null } | null;
  /** Deployment labels the operator's host sets; absent unless it does. Never a harness's ids. */
  owner?: string;
  group?: string;
  /** When the session was first opened, and when this process opened it. */
  started: number;
  opened: number;
  /** When it closed; null while a writer holds it, or after one died. */
  ended: number | null;
}

// --------------------------------------------------------------- live.json

/**
 * `live.json`: the session's last reading, rewritten whole on every writer
 * tick, so a map of every session opens one small file each and no trace.
 * `ts` is the writer's clock at that tick: its heartbeat.
 */
export interface LiveFile {
  ts: number;
  /** The newest trace row folded in, or null before the first. */
  observed: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  o: number | null;
  level: number | null;
  hp: number | null;
  hpMax: number | null;
  zone: number | null;
  area: number | null;
  /** `combat`, `mounted`, `taxi`, `dead`, `ghost`, `resting`: the ones that are set. */
  flags: string[];
  /** The child's event stream: whether it is open, how many events it has folded and the last `seq`. Null with no child. */
  stream: { connected: boolean; events: number; seq: number } | null;
}

// ------------------------------------------------------------ manifest.json

export interface ManifestSegment {
  stream: StreamName;
  /** The file as it is on disk, compression suffix included. */
  file: string;
  bytes: number;
  /** SHA-256 of the file's bytes as stored, hex. */
  sha256: string;
}

/** `manifest.json`: every captured segment as the session held it when it closed. */
export interface ManifestFile {
  format: typeof SESSION_FORMAT;
  id: string;
  written: number;
  segments: ManifestSegment[];
}

// ------------------------------------------------------------ events stream

/**
 * The state an events segment opens with: what its rows are transitions of.
 * `null` is not observed yet. `group` counts the party with the character;
 * `members` are the other members that are sessions of the same deployment,
 * and `foreign` is how many are not.
 */
export interface EventsState {
  level: number | null;
  zone: number | null;
  area: number | null;
  map: number | null;
  instanceType: number | null;
  dead: boolean;
  released: boolean;
  taxi: boolean;
  group: null | { groupGuid?: string; leaderGuid?: string; members: string[]; foreign: number; count: number };
}

export function emptyEventsState(): EventsState {
  return { level: null, zone: null, area: null, map: null, instanceType: null, dead: false, released: false, taxi: false, group: null };
}

interface Point {
  map: number;
  x: number;
  y: number;
  z: number;
}

/** What every event row may carry besides its kind: the stream `seq` of the packet that carried it. */
interface EventBase {
  ts: number;
  seq?: number;
}

/**
 * One events row. `ts` is the event's own time: the packet that carried it,
 * or the cache's stamp for the reading. Kinds are additive, and a reader
 * ignores the ones it does not know.
 *
 * - `key`: the stream's state, whole. Opens every segment, and is restated
 *   whenever a recorder starts (a child restart, a resumed session).
 * - `zone` / `area`: the id changed; `from` absent on a recorder's first reading.
 * - `level`: likewise, with the XP reading at that moment.
 * - `death` / `release` / `resurrect`: the death window's transitions.
 * - `taxi` / `taxi_landed`: the taxi flag turning on after an accepted reply, and off.
 * - `achievement`, and `achievements_at_login` once per recorder.
 * - `spell`, and `spells_at_login` once per recorder.
 * - `talent`: a talent whose rank climbed. `trade`: a completed trade.
 * - `quest`: a turn-in the server confirmed.
 * - `group` / `instance` / `kill`: the party records. A guid that is not a
 *   session of the same deployment is never written: `members` holds the own
 *   ones and `foreign` counts the rest, `leaderGuid` and `killerGuid` are
 *   absent for a foreign player.
 */
export type EventRow =
  | ({ kind: "key"; state: EventsState } & EventBase)
  | ({ kind: "zone" | "area"; from?: number; to: number } & EventBase)
  | ({ kind: "level"; from?: number; to: number; xp?: number } & EventBase)
  | ({
      kind: "death";
      /** Where the corpse is and which packet said so; absent when only its dungeon's entrance was known. */
      position?: Point & { source: "corpse_query" | "death_spot" };
      zone?: number;
      area?: number;
      /** The ghost flag as it read at that instant. */
      released?: boolean;
    } & EventBase)
  | ({ kind: "release"; graveyard?: Point } & EventBase)
  | ({ kind: "resurrect" } & EventBase)
  | ({ kind: "taxi" | "taxi_landed"; position?: Point; zone?: number; area?: number } & EventBase)
  | ({ kind: "achievement"; id: number; name?: string; points?: number; categoryId?: number } & EventBase)
  | ({ kind: "achievements_at_login"; ids: number[]; points: number } & EventBase)
  | ({ kind: "spells_at_login"; ids: number[] } & EventBase)
  | ({ kind: "spell"; id: number } & EventBase)
  | ({ kind: "talent"; id: number; points: number; rank: number; spec?: number } & EventBase)
  | ({ kind: "trade" } & EventBase)
  | ({ kind: "quest"; id: number } & EventBase)
  | ({
      kind: "group";
      event: "joined" | "changed" | "left";
      groupGuid?: string;
      leaderGuid?: string;
      members: string[];
      foreign: number;
      /** The party's size, the character included; 0 on `left`. */
      count: number;
    } & EventBase)
  | ({ kind: "instance"; event: "entered" | "left"; map: number; instanceType: number; from: { map: number; instanceType: number } } & EventBase)
  | ({
      kind: "kill";
      /** Absent when the killer is a foreign player. */
      killerGuid?: string;
      victimGuid: string;
      entry?: number;
      rank?: number;
      /** The killer is this character. */
      self: boolean;
      /** The killer is this character or a member of its group. */
      member: boolean;
    } & EventBase);

export type EventKind = EventRow["kind"];

// ------------------------------------------------------------- calls stream

/**
 * What sent something, left open on purpose: `tool` a tool call, `routine`
 * code a call left running after it returned, `client` the SDK's own traffic
 * outside every call. A reader ignores a `type` it does not know; `program`
 * is reserved.
 */
export interface CallOriginRef {
  type: string;
  /** The call that launched it, when there is one: that `call` row's `id`. */
  call?: number;
}

/**
 * One calls row.
 *
 * - `key`: opens a segment with every call still in flight, whole, so a
 *   `result` whose `call` row is in an earlier segment still has it.
 * - `call`: a tool call as it was dispatched. `id` is its dispatch stamp,
 *   strictly increasing per host, and `ts` equals it.
 * - `result`: the call's answer as the caller was handed it.
 * - `actions`: what one origin put on the wire since the last flush, with
 *   the module's answer to each (`ActionNote`).
 * - `move`: a movement intention as dispatched, and again with its verdict.
 *   `target` is the guid it was aimed at, null for a point or a foreign player.
 * - `events`: an event batch a call served its caller, as it was shown.
 */
export type CallRow =
  | { ts: number; kind: "key"; open: Extract<CallRow, { kind: "call" }>[] }
  | { ts: number; kind: "call"; id: number; origin: CallOriginRef; tool: string; args: unknown }
  | { ts: number; kind: "result"; id: number; text: string; error: boolean; durationMs: number }
  | { ts: number; kind: "actions"; origin: CallOriginRef; actions: ActionNote[]; dropped?: Record<string, number> }
  | {
      ts: number;
      kind: "move";
      origin: CallOriginRef;
      /** When the move was dispatched: with `ts`, the dispatch row and the verdict row of one move share it. */
      at: number;
      moveId: number | null;
      map: number | null;
      x: number;
      y: number;
      z: number;
      target: string | null;
      /** The target's client-cache name, when it had one and may be written. */
      name?: string;
      status: string | null;
    }
  | { ts: number; kind: "events"; origin: CallOriginRef; count: number; folded?: number; events: EventSummary[] };

export type CallKind = CallRow["kind"];

/** A row of each stream. */
export interface StreamRows {
  trace: TraceRow;
  events: EventRow;
  calls: CallRow;
  nearby: NearbyRow;
}

export type AnyRow = StreamRows[StreamName];

// -------------------------------------------------------------------- guids

/** The high 16 bits of a 3.3.5a guid, as a client reads an object's type off it; null for what is not a guid. */
export function guidHigh(guid: string): number | null {
  try {
    return Number(BigInt(guid) >> 48n);
  } catch {
    return null;
  }
}

/** Whether a guid names a player: high type 0, and not the null guid. */
export function isPlayerGuid(guid: string): boolean {
  if (guid === "0" || guid === "") return false;
  return guidHigh(guid) === 0x0000;
}

/** The creature entry packed into a unit or vehicle guid; undefined for any other. */
export function creatureEntryOfGuid(guid: string): number | undefined {
  try {
    const g = BigInt(guid);
    const high = Number(g >> 48n);
    if (high !== 0xf130 && high !== 0xf150) return undefined;
    const entry = Number((g >> 24n) & 0xffffffn);
    return entry > 0 ? entry : undefined;
  } catch {
    return undefined;
  }
}
