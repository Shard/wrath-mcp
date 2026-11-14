/**
 * Where the inspector reads sessions from: one interface, so the same API and
 * views serve a session store on disk, a harness's own layout of the same
 * records (WrathBench keeps one per run, and reads runs from before the
 * format through an adapter of its own), and later a store behind HTTP.
 *
 * Four reads and nothing more: list the sessions, read a session's
 * `session.json` and `live.json`, read a stream's segments for a time range,
 * and tail a stream. Everything the inspector derives (the map's packed trace
 * and nearby windows, the movement intentions, the event feed) is built on
 * those in `readout.ts`, so an implementation never encodes anything.
 *
 * Every read is asynchronous, because a source may be a network away. Every
 * read is also scoped (wrath-mcp#29): the operator sees every session, and a
 * user, a person signed in with a hosted grant's key, sees the sessions in
 * the stores of the credentials they hold. A source filters by the scope it
 * is handed, on the listing and on every open, and the API asks a hook for
 * the scope of each request. A session out of scope is not there: it is
 * never listed and never opens.
 *
 * A user is scoped by where a session is, never by what it says. `owner` in
 * `session.json` is written by the credential's host, which runs the
 * tenant's code, so a record could claim anyone; it is shown, and grants
 * nothing. A source that cannot place a session under a credential (a plain
 * store, a harness's runs) shows a user nothing.
 */

import type { LiveFile, SessionFile, StreamName, StreamRows } from "@wrathbench/mcp/record/read";

/**
 * Who is asking. The operator sees every session. A user is a person signed
 * in with a hosted grant's key, and sees only the sessions in the stores of
 * `credentials`, the grant ids they hold now (a gateway keeps each one's at
 * `<state>/tenants/<credential>/sessions`).
 */
export type SessionScope = { readonly kind: "operator" } | UserScope;

/** A person's scope: the credentials (grant ids) whose session stores they may read. */
export interface UserScope {
  readonly kind: "user";
  /** Who they are, as the grants name them. For display: it grants nothing. */
  readonly person: string;
  readonly credentials: ReadonlySet<string>;
}

/** The operator's scope: every session. */
export const OPERATOR: SessionScope = Object.freeze({ kind: "operator" });

/**
 * Whether `scope` may see a session a source knows only by its record: the
 * operator's alone. A record's labels (`owner`, `group`) are written by
 * whoever wrote the session and never grant a user anything; a source that
 * can place a session under a credential asks `credentialInScope`.
 */
export function inScope(_session: Pick<SessionFile, "owner"> | null, scope: SessionScope): boolean {
  return scope.kind === "operator";
}

/**
 * Whether `scope` may see a session that lives in `credential`'s store, by
 * where it is: the operator always, a user when they hold that credential.
 * Null is a session in no credential's store, the operator's alone.
 */
export function credentialInScope(credential: string | null, scope: SessionScope): boolean {
  if (scope.kind === "operator") return true;
  return credential !== null && scope.credentials.has(credential);
}

/** One session as a listing names it. */
export interface SessionEntry {
  /** The id the source opens it by: opaque to the inspector, safe in a URL path segment. */
  id: string;
  session: SessionFile;
  live: LiveFile | null;
  /**
   * The sessions one client drove together: a fan-out client's characters, or
   * whatever a harness keeps as one unit (WrathBench's runs source gives a
   * run's id). Opaque, and only compared: a listing shows the sessions of one
   * group together. The store's is the record's own `group` label; absent
   * for a session that stands alone.
   */
  group?: string;
}

/** One segment of a stream: a window of time and how to recognise it again. */
export interface SegmentInfo {
  /** The window it holds, `[t0, t1)` in epoch ms. A row's `ts` may precede `t0` by the writer's drain interval. */
  t0: number;
  t1: number;
  /** Unique within the source and stable for the segment's life: what a memo keys it by. */
  ref: string;
  /** Whether its rows can never change, so whatever was derived from them stays right. */
  closed: boolean;
}

/** A time range, `[from, to)` in epoch ms; either end may be infinite. */
export interface TimeRange {
  from: number;
  to: number;
}

/** What a stream's writes have changed: `stamp` moves on every write, `touched` is when the newest landed. */
export interface StreamStat {
  stamp: string;
  touched: number;
}

/** What a tail read: the rows written since the cursor, and the cursor to pass next time. */
export interface TailBatch<S extends StreamName> {
  rows: StreamRows[S][];
  /** Opaque. Null when the stream has nothing yet; pass it back as it is. */
  cursor: string | null;
}

/** One session, opened in some scope. */
export interface SessionHandle {
  readonly id: string;
  session(): Promise<SessionFile | null>;
  live(): Promise<LiveFile | null>;
  /**
   * The stream's segments, oldest first; with a range, only those whose window
   * meets it (`t1 > from && t0 < to`). A stream with none, or a session that
   * never wrote it, has an empty list.
   */
  segments(stream: StreamName, range?: TimeRange): Promise<SegmentInfo[]>;
  /**
   * Every whole row of each segment, in the order written, one list per
   * segment in the order asked. `kinds`, when given, is a hint that only rows
   * of those kinds are wanted: a source may skip the rest without parsing
   * them, and may also return them, so a caller filters again.
   */
  read<S extends StreamName>(stream: S, segments: readonly SegmentInfo[], o?: { kinds?: readonly string[] }): Promise<StreamRows[S][][]>;
  /**
   * Follow a stream: the rows written since `cursor`, from the stream's first
   * row when it is null or absent. A cursor whose segment is gone resumes at
   * the oldest one after it.
   */
  tail<S extends StreamName>(stream: S, cursor?: string | null): Promise<TailBatch<S>>;
  /** The cursor at the stream's end as it stands: a tail from it returns only what is written afterwards. */
  end(stream: StreamName): Promise<string | null>;
  /** Null when the stream has no segment. */
  stat(stream: StreamName): Promise<StreamStat | null>;
}

/** Where the inspector reads sessions from. */
export interface SessionSource {
  /** Every session `scope` may see, newest first by when it was opened. */
  list(scope: SessionScope): Promise<SessionEntry[]>;
  /** One session, or null when there is none by that id that `scope` may see. */
  open(id: string, scope: SessionScope): Promise<SessionHandle | null>;
}

/**
 * How far a row's `ts` may precede its segment's window: the writer's drain
 * interval is a few seconds, so a minute is margin.
 */
export const ROW_LEAD_MS = 60_000;

/**
 * The rows of a stream with `ts` in `[from, to)`, in the order written: the
 * segments that can hold them (those meeting the range, and any a row
 * written late into a later window could be in), each read whole, then cut.
 */
export async function rowsBetween<S extends StreamName>(h: SessionHandle, stream: S, range: TimeRange, o?: { kinds?: readonly string[] }): Promise<StreamRows[S][]> {
  const segs = await h.segments(stream, { from: range.from, to: range.to + ROW_LEAD_MS });
  const out: StreamRows[S][] = [];
  const kinds = o?.kinds === undefined ? null : new Set(o.kinds);
  for (const rows of await h.read(stream, segs, o)) {
    for (const r of rows) if (r.ts >= range.from && r.ts < range.to && (kinds === null || kinds.has(r.kind))) out.push(r);
  }
  return out;
}
