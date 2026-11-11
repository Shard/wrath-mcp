/**
 * Closing a segment: the writer's half of the segment files. A closed plain
 * segment is replaced by its zstd copy (`docs/SESSION-FORMAT.md`); readers
 * accept both (`segments.ts`). Kept apart from the reader so the record's
 * read side (`read.ts`) carries no code that writes or unlinks.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

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
