/**
 * The fixture sessions under `fixtures/sessions/`, planted the way a writer
 * leaves them. They are kept in git as plain JSONL so they can be read and
 * reviewed: synthetic, with invented names and ids, nothing from a game
 * client or a real run. `plantSession` copies one into a directory and then
 * does what closing a segment does: every closed segment is compressed, and
 * a session that ended gets its manifest.
 *
 * - `closed`: an ended session. Two windows of trace, events and calls, with
 *   dictionary rows, a flight, a death, party records with own and foreign
 *   members, a call that spans the window boundary, and no ring.
 * - `live`: a session a writer still holds. One window per stream, the ring,
 *   `live.json`, a recorder key ahead of the character's first observation
 *   and a call in flight.
 */

import { createHash } from "node:crypto";
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURED_STREAMS, MANIFEST_FILE, SESSION_FILE, SESSION_FORMAT, type ManifestFile, type SessionFile } from "../../src/record/format";
import { compressSegment, listSegments } from "../../src/record/segments";

export const FIXTURE_SESSIONS = ["closed", "live"] as const;
export type FixtureSession = (typeof FIXTURE_SESSIONS)[number];

/** The first window both fixtures are laid out from: 2026-01-01T00:00:00Z. */
export const FIXTURE_T0 = 1767225600000;

export function fixtureSessionDir(name: FixtureSession): string {
  return join(import.meta.dir, "sessions", name);
}

/** The manifest of a session directory as it stands: every captured segment, sized and hashed. */
export function manifestOf(dir: string, id: string, written: number): ManifestFile {
  const segments: ManifestFile["segments"] = [];
  for (const stream of CAPTURED_STREAMS) {
    for (const seg of listSegments(dir, stream)) {
      segments.push({
        stream,
        file: `${seg.stem}${seg.compressed ? ".zst" : ""}`,
        bytes: statSync(seg.path).size,
        sha256: createHash("sha256").update(readFileSync(seg.path)).digest("hex"),
      });
    }
  }
  return { format: SESSION_FORMAT, id, written, segments };
}

/** Copy a fixture into `dest` and close what a writer would have closed. Returns `dest`. */
export async function plantSession(name: FixtureSession, dest: string): Promise<string> {
  cpSync(fixtureSessionDir(name), dest, { recursive: true });
  const session = JSON.parse(readFileSync(join(dest, SESSION_FILE), "utf8")) as SessionFile;
  for (const stream of CAPTURED_STREAMS) {
    const segs = listSegments(dest, stream);
    // A live session's newest segment is the one still being written.
    const closed = session.ended === null ? segs.slice(0, -1) : segs;
    for (const seg of closed) await compressSegment(seg.path);
  }
  if (session.ended !== null) writeFileSync(join(dest, MANIFEST_FILE), `${JSON.stringify(manifestOf(dest, session.id, session.ended), null, 2)}\n`);
  return dest;
}
