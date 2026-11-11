/**
 * The session reader: one session directory, read-only
 * (`docs/SESSION-FORMAT.md`). It never creates, locks or changes anything, so
 * any number of readers follow a session while its one writer writes it.
 *
 * Three reads: a stream's segments, the rows of a time range, and a tail
 * from a cursor. A closed segment never changes, so a caller may cache what
 * it decoded from one for as long as it likes; the live segment is read from
 * a byte offset up to its last whole line.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIVE_FILE, MANIFEST_FILE, SEGMENT_MS, SESSION_FILE, SESSION_FORMAT, segmentStart, type LiveFile, type ManifestFile, type SessionFile, type StreamName, type StreamRows } from "./format";
import { listSegments, parseLines, readSegment, readSegmentBytes, type SegmentRef } from "./segments";

/** Where a tail has read to: a segment by its uncompressed name, and a byte offset into its plain bytes. */
export interface StreamCursor {
  segment: string;
  offset: number;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** `session.json` of a directory, or null when it is not a session of this format. */
export function readSessionFile(dir: string): SessionFile | null {
  const s = readJson<SessionFile>(join(dir, SESSION_FILE));
  return s !== null && s.format === SESSION_FORMAT && typeof s.id === "string" ? s : null;
}

export class SessionReader {
  constructor(readonly dir: string) {}

  session(): SessionFile | null {
    return readSessionFile(this.dir);
  }

  live(): LiveFile | null {
    return readJson<LiveFile>(join(this.dir, LIVE_FILE));
  }

  manifest(): ManifestFile | null {
    return readJson<ManifestFile>(join(this.dir, MANIFEST_FILE));
  }

  /** A stream's segments, oldest first. */
  segments(stream: StreamName): SegmentRef[] {
    return listSegments(this.dir, stream);
  }

  /** Every whole row of one segment. */
  segment<S extends StreamName>(_stream: S, ref: Pick<SegmentRef, "path">): StreamRows[S][] {
    return readSegment<StreamRows[S]>(ref).rows;
  }

  /**
   * The stream's rows with `ts` in `[from, to)`, in the order they were
   * written. A row sits in the segment that was live when it was written, so
   * its `ts` may precede that segment's window by the writer's drain
   * interval: the read takes the segment after the range's last window too.
   */
  rows<S extends StreamName>(stream: S, from = -Infinity, to = Infinity): StreamRows[S][] {
    const first = Number.isFinite(from) ? segmentStart(from) : -Infinity;
    const last = Number.isFinite(to) ? segmentStart(to) + SEGMENT_MS : Infinity;
    const out: StreamRows[S][] = [];
    for (const seg of this.segments(stream)) {
      if (seg.t0 < first || seg.t0 > last) continue;
      for (const row of this.segment(stream, seg)) if (row.ts >= from && row.ts < to) out.push(row);
    }
    return out;
  }

  /** The newest row of a stream, or null when it has none. */
  last<S extends StreamName>(stream: S): StreamRows[S] | null {
    const segs = this.segments(stream);
    for (let i = segs.length - 1; i >= 0; i--) {
      const rows = this.segment(stream, segs[i]!);
      if (rows.length > 0) return rows[rows.length - 1]!;
    }
    return null;
  }

  /**
   * Follow a stream: the rows written since `cursor`, and the cursor to pass
   * next time. With no cursor it starts at the stream's first segment; a
   * caller that only wants what comes next starts from `end(stream)`. A
   * segment compressed since the last read is read from the same offset,
   * because its plain bytes did not change.
   */
  tail<S extends StreamName>(stream: S, cursor?: StreamCursor): { rows: StreamRows[S][]; cursor: StreamCursor | undefined } {
    const segs = this.segments(stream);
    if (segs.length === 0) return { rows: [], cursor };
    let i = cursor === undefined ? 0 : segs.findIndex((s) => s.stem === cursor.segment);
    let offset = cursor?.offset ?? 0;
    if (i < 0) {
      // The cursor's segment is gone (a ring that moved on): the oldest one after it.
      i = segs.findIndex((s) => s.stem > cursor!.segment);
      offset = 0;
      if (i < 0) return { rows: [], cursor };
    }
    const rows: StreamRows[S][] = [];
    let at: StreamCursor = { segment: segs[i]!.stem, offset };
    for (; i < segs.length; i++) {
      const seg = segs[i]!;
      let bytes: Uint8Array;
      try {
        bytes = readSegmentBytes(seg.path);
      } catch {
        break;
      }
      const start = seg.stem === at.segment ? at.offset : 0;
      const parsed = parseLines<StreamRows[S]>(bytes, start);
      rows.push(...parsed.rows);
      at = { segment: seg.stem, offset: parsed.consumed };
      // Only a segment with a successor is finished; the newest may still grow.
    }
    return { rows, cursor: at };
  }

  /** The cursor at the stream's end as it stands: a tail from it returns only what is written afterwards. */
  end(stream: StreamName): StreamCursor | undefined {
    const segs = this.segments(stream);
    const newest = segs[segs.length - 1];
    if (newest === undefined) return undefined;
    try {
      return { segment: newest.stem, offset: parseLines(readSegmentBytes(newest.path)).consumed };
    } catch {
      return { segment: newest.stem, offset: 0 };
    }
  }

  /** The newest mtime among a stream's segments, for a "is it being written" check; null with none. */
  touched(stream: StreamName): number | null {
    const segs = this.segments(stream);
    const newest = segs[segs.length - 1];
    if (newest === undefined) return null;
    return statSync(newest.path, { throwIfNoEntry: false })?.mtimeMs ?? null;
  }
}
