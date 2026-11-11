/**
 * `wrath-session/1` as the validator holds it (`docs/SESSION-FORMAT.md`):
 * the fixture sessions are valid, and each rule the document states refuses
 * the one thing it forbids.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_FILE, SEGMENT_MS, SESSION_FILE, parseSegmentName, segmentFileName, segmentStart, type ManifestFile } from "../src/record/format";
import { compressSegment } from "../src/record/compress";
import { listSegments, parseLines, readSegment } from "../src/record/segments";
import { validateRow, validateSession } from "../src/record/validate";
import { FIXTURE_SESSIONS, FIXTURE_T0, fixtureSessionDir, plantSession, type FixtureSession } from "./fixtures/sessions";

const tmp: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wrath-session-"));
  tmp.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const plant = (name: FixtureSession): Promise<string> => plantSession(name, join(tempDir(), name));

/** Rewrite one plain segment's rows. */
function edit(dir: string, stream: string, t0: number, fn: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): void {
  const path = join(dir, stream, segmentFileName(t0));
  const rows = readFileSync(path, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  writeFileSync(path, fn(rows).map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** A player's guid: high type 0. */
const PLAYER = "77";

describe("segment names", () => {
  test("a name is a window start, an optional part and an optional compression suffix", () => {
    expect(parseSegmentName(segmentFileName(FIXTURE_T0))).toEqual({ t0: FIXTURE_T0, part: 0, compressed: false });
    expect(parseSegmentName(segmentFileName(FIXTURE_T0, 2, true))).toEqual({ t0: FIXTURE_T0, part: 2, compressed: true });
    expect(segmentFileName(FIXTURE_T0, 1, true)).toBe("1767225600000-1.jsonl.zst");
    expect(segmentStart(FIXTURE_T0 + SEGMENT_MS - 1)).toBe(FIXTURE_T0);
  });

  test("anything else in a stream directory is not a segment", () => {
    for (const name of ["1767225600001.jsonl", "1767225600000-0.jsonl", "1767225600000.json", "176722560000.jsonl", "notes.txt"]) {
      expect(parseSegmentName(name)).toBeNull();
    }
  });
});

describe("segments read the same plain and compressed", () => {
  test("a compressed segment has the rows the plain one had, and replaces it", async () => {
    const dir = await plant("live");
    const [seg] = listSegments(dir, "trace");
    const before = readSegment(seg!);
    expect(seg!.compressed).toBe(false);
    await compressSegment(seg!.path);
    const [after] = listSegments(dir, "trace");
    expect(after!.compressed).toBe(true);
    expect(readSegment(after!).rows).toEqual(before.rows);
    expect(listSegments(dir, "trace")).toHaveLength(1);
  });

  test("a last line with no newline is not read, and a line that is not an object is skipped", () => {
    const bytes = new TextEncoder().encode('{"ts":1,"kind":"key"}\nnot json\n[1]\n{"ts":2,"kind":"p');
    const parsed = parseLines(bytes);
    expect(parsed.rows).toEqual([{ ts: 1, kind: "key" }]);
    expect(parsed.skipped).toBe(2);
    expect(parsed.consumed).toBe(bytes.length - '{"ts":2,"kind":"p'.length);
  });
});

describe("the fixture sessions are valid wrath-session/1", () => {
  for (const name of FIXTURE_SESSIONS) {
    test(name, async () => {
      const v = validateSession(await plant(name));
      expect(v.errors).toEqual([]);
      expect(v.warnings).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.streams.trace.rows).toBeGreaterThan(0);
    });
  }

  test("as they sit in git, uncompressed, they differ only by the warning for it", () => {
    const v = validateSession(fixtureSessionDir("closed"));
    expect(v.errors).toEqual([]);
    expect(v.warnings.every((w) => w.endsWith("a closed segment that is not compressed"))).toBe(true);
    expect(v.warnings.length).toBe(6);
  });
});

describe("what the format refuses", () => {
  test("a directory with no session.json", () => {
    const v = validateSession(tempDir());
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toStartWith(SESSION_FILE);
  });

  test("a session id that is not sixteen hex characters, and a token-shaped extra key", async () => {
    const dir = await plant("live");
    const path = join(dir, SESSION_FILE);
    const s = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...s, id: "tok:1234", token: "x" }));
    const v = validateSession(dir);
    expect(v.errors.join("\n")).toContain("id");
    expect(v.errors.join("\n")).toContain("token");
  });

  test("a segment that does not open with a key row", async () => {
    const dir = await plant("live");
    edit(dir, "events", FIXTURE_T0 + SEGMENT_MS, (rows) => rows.slice(1));
    expect(validateSession(dir).errors.join("\n")).toContain("not a key row");
  });

  test("a player unit in the ring, by its guid", async () => {
    const dir = await plant("live");
    edit(dir, "nearby", FIXTURE_T0 + SEGMENT_MS, (rows) => [...rows, { ts: FIXTURE_T0 + SEGMENT_MS + 40_000, kind: "out", id: PLAYER }]);
    expect(validateSession(dir).errors.join("\n")).toContain("a player unit, which is never written");
  });

  test("a creature's target, or the character's own, as a player's guid rather than its kind", async () => {
    const dir = await plant("live");
    edit(dir, "nearby", FIXTURE_T0 + SEGMENT_MS, (rows) =>
      rows.map((r) => (r["kind"] === "st" ? { ...r, s: { tg: PLAYER } } : r["kind"] === "self" ? { ...r, self: { target: PLAYER } } : r)),
    );
    const errors = validateSession(dir).errors;
    expect(errors.filter((e) => e.includes("a player guid"))).toHaveLength(2);
  });

  test("a unit another player owns", async () => {
    const dir = await plant("live");
    edit(dir, "nearby", FIXTURE_T0 + SEGMENT_MS, (rows) => rows.map((r) => (r["kind"] === "st" ? { ...r, s: { ow: PLAYER } } : r)));
    expect(validateSession(dir).errors.join("\n")).toContain("ow names a player other than the session's own character");
  });

  test("a player target that carries more than its kind", () => {
    const row = { ts: 1, kind: "state", data: { target: { kind: "player", hpPct: 40 } } };
    expect(validateRow("trace", row).ok).toBe(false);
    expect(validateRow("trace", { ...row, data: { target: { kind: "player" } } }).ok).toBe(true);
  });

  test("a trace row that goes back in time", async () => {
    const dir = await plant("live");
    edit(dir, "trace", FIXTURE_T0 + SEGMENT_MS, (rows) => [...rows, { ts: FIXTURE_T0 + SEGMENT_MS + 5, kind: "state", data: { hp: 1 } }]);
    expect(validateSession(dir).errors.join("\n")).toContain("ts goes back in time");
  });

  test("a result whose call the segment neither holds nor restates", async () => {
    const dir = await plant("live");
    edit(dir, "calls", FIXTURE_T0 + SEGMENT_MS, (rows) => [...rows, { ts: FIXTURE_T0 + SEGMENT_MS + 50_000, kind: "result", id: 12345, text: "", error: false, durationMs: 1 }]);
    expect(validateSession(dir).errors.join("\n")).toContain("a result for call 12345");
  });

  test("a group or kill row with a guid that is not a guid, and a player victim", () => {
    expect(validateRow("events", { ts: 1, kind: "group", event: "joined", members: ["Bystander"], foreign: 0, count: 2 }).ok).toBe(false);
    expect(validateRow("events", { ts: 1, kind: "kill", victimGuid: PLAYER, self: true, member: true }).ok).toBe(false);
  });

  test("a ring that outlived its session, and a file that is not a segment", async () => {
    const dir = await plant("closed");
    const live = await plant("live");
    renameSync(join(live, "nearby"), join(dir, "nearby"));
    writeFileSync(join(dir, "trace", "notes.txt"), "x");
    const errors = validateSession(dir).errors.join("\n");
    expect(errors).toContain("the ring outlived the session");
    expect(errors).toContain("trace/notes.txt: not a segment name");
  });

  test("a manifest that no longer matches what is on disk", async () => {
    const dir = await plant("closed");
    const path = join(dir, MANIFEST_FILE);
    const m = JSON.parse(readFileSync(path, "utf8")) as ManifestFile;
    m.segments[0]!.sha256 = "0".repeat(64);
    m.segments.pop();
    writeFileSync(path, JSON.stringify(m));
    const errors = validateSession(dir).errors.join("\n");
    expect(errors).toContain("does not hash to what is listed");
    expect(errors).toContain("is on disk and not listed");
  });
});

describe("what the format allows and a clean session does not have", () => {
  test("a kind this version does not know is a warning, as a reader would skip it", async () => {
    const dir = await plant("live");
    edit(dir, "events", FIXTURE_T0 + SEGMENT_MS, (rows) => [...rows, { ts: FIXTURE_T0 + SEGMENT_MS + 9, kind: "duel", won: true }]);
    const v = validateSession(dir);
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toContain('kind "duel"');
  });

  test("the tear a killed writer leaves in its live segment", async () => {
    const dir = await plant("live");
    appendFileSync(join(dir, "trace", segmentFileName(FIXTURE_T0 + SEGMENT_MS)), '{"ts":17672259');
    const v = validateSession(dir);
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toContain("ends in a line with no newline");
  });
});
