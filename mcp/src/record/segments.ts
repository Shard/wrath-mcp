/**
 * Segment files: listing a stream's, reading one whether it is plain or
 * compressed, and compressing one that has closed. The only place a segment
 * is opened for reading, so "readers accept both" is one function.
 *
 * A closed segment never changes. Compressing it writes `<name>.zst` beside
 * it under a temporary name, renames that into place and only then unlinks
 * the plain file, so at every instant a reader finds at least one complete
 * copy, and when it finds both it takes the compressed one.
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSegmentName, segmentFileName, type StreamName } from "./format";

/** One segment of a stream as the directory holds it now. */
export interface SegmentRef {
  t0: number;
  part: number;
  /** Its name without the compression suffix. */
  stem: string;
  /** The file to read: the compressed one when it exists. */
  path: string;
  compressed: boolean;
}

/** A stream's segments, oldest first. A segment present both ways is listed once, compressed. */
export function listSegments(sessionDir: string, stream: StreamName): SegmentRef[] {
  const dir = join(sessionDir, stream);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const byStem = new Map<string, SegmentRef>();
  for (const name of names) {
    const seg = parseSegmentName(name);
    if (seg === null) continue;
    const stem = segmentFileName(seg.t0, seg.part);
    const have = byStem.get(stem);
    if (have !== undefined && have.compressed) continue;
    byStem.set(stem, { t0: seg.t0, part: seg.part, stem, path: join(dir, name), compressed: seg.compressed });
  }
  return [...byStem.values()].sort((a, b) => a.t0 - b.t0 || a.part - b.part);
}

/** A segment's bytes as JSONL text, decompressed when it is stored compressed. Throws when it cannot be read. */
export function readSegmentBytes(path: string): Uint8Array {
  const raw = readFileSync(path);
  return path.endsWith(".zst") ? Bun.zstdDecompressSync(raw) : raw;
}

export interface ParsedLines<T> {
  rows: T[];
  /** Lines that were not a JSON object: a tear a killed writer left, never fatal. */
  skipped: number;
  /** Bytes consumed: up to and including the last newline. A reader tails from here. */
  consumed: number;
}

/**
 * The rows in `bytes` from `offset`, whole lines only: a last line with no
 * newline is still being written and is left for the next read. A line that
 * does not parse to an object is skipped and counted.
 */
export function parseLines<T = unknown>(bytes: Uint8Array, offset = 0): ParsedLines<T> {
  const end = bytes.lastIndexOf(0x0a);
  if (end < offset) return { rows: [], skipped: 0, consumed: offset };
  const text = new TextDecoder().decode(bytes.subarray(offset, end));
  const rows: T[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) rows.push(v as T);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped, consumed: end + 1 };
}

/** Every whole row of one segment. An unreadable file reads as no rows. */
export function readSegment<T = unknown>(ref: Pick<SegmentRef, "path">): ParsedLines<T> {
  try {
    return parseLines<T>(readSegmentBytes(ref.path));
  } catch {
    return { rows: [], skipped: 0, consumed: 0 };
  }
}

/**
 * Compress a closed plain segment in place of itself. Idempotent: one already
 * compressed, or gone, is left alone. Returns the compressed file's path, or
 * null when there was nothing to do.
 */
export async function compressSegment(plainPath: string): Promise<string | null> {
  if (!plainPath.endsWith(".jsonl")) return null;
  const out = `${plainPath}.zst`;
  if (!existsSync(plainPath)) return existsSync(out) ? out : null;
  if (!existsSync(out)) {
    const packed = await Bun.zstdCompress(readFileSync(plainPath));
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, packed);
    renameSync(tmp, out);
  }
  try {
    unlinkSync(plainPath);
  } catch {
    /* a reader that raced us still has the compressed copy */
  }
  return out;
}
