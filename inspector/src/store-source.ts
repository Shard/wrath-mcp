/**
 * The source over a session store on disk (`docs/SESSION-FORMAT.md`): a
 * directory of session directories, each named by its session id, or one
 * session directory alone (a harness that keeps a session inside its own run
 * directory). Read-only, through the stack's own reader
 * (`@wrathbench/mcp/record/read`): nothing here creates, locks, compresses
 * or prunes anything, so it follows sessions while their writers write them.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import {
  SessionReader,
  SessionStore,
  listSegments,
  parseLines,
  readSegmentBytes,
  readSessionFile,
  SEGMENT_MS,
  type SegmentRef,
  type StreamCursor,
  type StreamName,
  type StreamRows,
} from "@wrathbench/mcp/record/read";
import { inScope, type SegmentInfo, type SessionEntry, type SessionHandle, type SessionScope, type SessionSource, type StreamStat, type TailBatch, type TimeRange } from "./source";

/** A cursor as the API hands it out: `<segment stem>@<byte offset>`. */
export function encodeCursor(c: StreamCursor | undefined): string | null {
  return c === undefined ? null : `${c.segment}@${c.offset}`;
}

export function decodeCursor(s: string | null | undefined): StreamCursor | undefined {
  if (s === null || s === undefined) return undefined;
  const m = /^([0-9]{13}(?:-[0-9]{1,4})?\.jsonl)@([0-9]{1,15})$/.exec(s);
  return m === null ? undefined : { segment: m[1]!, offset: Number(m[2]) };
}

/** The rows of `bytes` whose line names one of `kinds`, parsed: a scan that parses only what it was asked for. */
function linesOfKinds<T>(bytes: Uint8Array, kinds: readonly string[]): T[] {
  const end = bytes.lastIndexOf(0x0a);
  if (end < 0) return [];
  const needles = kinds.map((k) => `"kind":${JSON.stringify(k)}`);
  const out: T[] = [];
  for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
    if (!needles.some((n) => line.includes(n))) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(v as T);
    } catch {
      /* a torn line: skipped */
    }
  }
  return out;
}

/** One session directory, read-only. */
export class StoredSessionHandle implements SessionHandle {
  private readonly reader: SessionReader;

  constructor(
    readonly id: string,
    readonly dir: string,
  ) {
    this.reader = new SessionReader(dir);
  }

  async session() {
    return this.reader.session();
  }

  async live() {
    return this.reader.live();
  }

  private refs(stream: StreamName): SegmentRef[] {
    return listSegments(this.dir, stream);
  }

  async segments(stream: StreamName, range?: TimeRange): Promise<SegmentInfo[]> {
    const refs = this.refs(stream);
    // A segment is closed once compressed, once it has a successor, or once its session closed.
    const ended = refs.length > 0 && this.reader.session()?.ended != null;
    const out: SegmentInfo[] = [];
    for (const [i, r] of refs.entries()) {
      const info: SegmentInfo = { t0: r.t0, t1: r.t0 + SEGMENT_MS, ref: join(this.dir, stream, r.stem), closed: r.compressed || i < refs.length - 1 || ended };
      if (range !== undefined && (info.t1 <= range.from || info.t0 >= range.to)) continue;
      out.push(info);
    }
    return out;
  }

  async read<S extends StreamName>(stream: S, segments: readonly SegmentInfo[], o?: { kinds?: readonly string[] }): Promise<StreamRows[S][][]> {
    // Listed afresh, so a segment compressed since it was listed is read from its compressed file.
    const byRef = new Map(this.refs(stream).map((r) => [join(this.dir, stream, r.stem), r]));
    return segments.map((seg) => {
      const ref = byRef.get(seg.ref);
      if (ref === undefined) return [];
      try {
        const bytes = readSegmentBytes(ref.path);
        return o?.kinds !== undefined ? linesOfKinds<StreamRows[S]>(bytes, o.kinds) : parseLines<StreamRows[S]>(bytes).rows;
      } catch {
        return [];
      }
    });
  }

  async tail<S extends StreamName>(stream: S, cursor?: string | null): Promise<TailBatch<S>> {
    const t = this.reader.tail(stream, decodeCursor(cursor));
    return { rows: t.rows, cursor: encodeCursor(t.cursor) };
  }

  async end(stream: StreamName): Promise<string | null> {
    return encodeCursor(this.reader.end(stream));
  }

  async stat(stream: StreamName): Promise<StreamStat | null> {
    const refs = this.refs(stream);
    const newest = refs[refs.length - 1];
    if (newest === undefined) return null;
    const st = statSync(newest.path, { throwIfNoEntry: false });
    // The segment count moves at a rotation, the newest one's size and mtime at every write between.
    return { stamp: `${refs.length}:${newest.stem}:${st?.size ?? 0}:${st?.mtimeMs ?? 0}`, touched: st?.mtimeMs ?? 0 };
  }
}

/**
 * A source over `dir`: a store of sessions, or, when `dir` holds a
 * `session.json` itself, that one session.
 */
export function storeSource(dir: string): SessionSource {
  const single = readSessionFile(dir) !== null;
  const store = new SessionStore(dir);

  const entries = (): SessionEntry[] => {
    if (!single) return store.list().map((s) => ({ id: s.id, session: s.session, live: s.live }));
    const reader = new SessionReader(dir);
    const session = reader.session();
    return session === null ? [] : [{ id: session.id, session, live: reader.live() }];
  };

  return {
    async list(scope: SessionScope) {
      return entries().filter((e) => inScope(e.session, scope));
    },
    async open(id: string, scope: SessionScope) {
      let sessionDir: string;
      if (single) {
        if (readSessionFile(dir)?.id !== id) return null;
        sessionDir = dir;
      } else {
        try {
          sessionDir = store.sessionDir(id);
        } catch {
          return null;
        }
      }
      const session = readSessionFile(sessionDir);
      if (session === null || !inScope(session, scope)) return null;
      return new StoredSessionHandle(id, sessionDir);
    },
  };
}

