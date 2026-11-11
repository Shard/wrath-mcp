/**
 * The session reader and the store (`src/record/reader.ts`, `store.ts`):
 * range reads, following a stream by byte offset while it is written,
 * rotated and compressed, the deployment's own-guid index, and retention.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEGMENT_MS, SESSION_FILE, segmentFileName, type SessionFile, type TraceRow } from "../src/record/format";
import { SessionReader, readSessionFile } from "../src/record/reader";
import { compressSegment } from "../src/record/segments";
import { DEFAULT_RETENTION_MS, SessionStore, ownGuidIndex } from "../src/record/store";
import { FIXTURE_T0 as T0, plantSession } from "./fixtures/sessions";

const tmp: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wrath-reader-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const line = (row: unknown): string => `${JSON.stringify(row)}\n`;
const key = (ts: number): TraceRow => ({ ts, kind: "key", map: null, x: null, y: null, z: null, o: null });
const pos = (ts: number): TraceRow => ({ ts, kind: "pos", map: 0, x: ts % 1000, y: 0, z: 0, o: 0 });

describe("reading a session", () => {
  test("its files, and null for a directory that is not one", async () => {
    const dir = await plantSession("closed", join(tempDir(), "s"));
    const r = new SessionReader(dir);
    expect(r.session()?.id).toBe("3f9a1c0b7e2d4a61");
    expect(r.live()).toBeNull();
    expect(r.manifest()?.segments).toHaveLength(6);
    expect(new SessionReader(tempDir()).session()).toBeNull();
    writeFileSync(join(tempDir(), SESSION_FILE), "{}");
    expect(readSessionFile(tmp[tmp.length - 1]!)).toBeNull();
  });

  test("a time range reads across compressed segments, in written order, bounds as [from, to)", async () => {
    const r = new SessionReader(await plantSession("closed", join(tempDir(), "s")));
    expect(r.rows("trace")).toHaveLength(19);
    const some = r.rows("trace", T0 + 60_000, T0 + SEGMENT_MS + 501);
    expect(some.map((x) => x.ts)).toEqual([T0 + 60_000, T0 + 60_000, T0 + SEGMENT_MS, T0 + SEGMENT_MS + 500]);
    expect(r.rows("trace", T0 + 3 * SEGMENT_MS)).toEqual([]);
    expect(r.last("events")).toMatchObject({ kind: "group", event: "left" });
    expect(r.last("nearby")).toBeNull();
  });

  test("a row written late sits in the next segment and is still found by its own time", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "events"));
    writeFileSync(join(dir, "events", segmentFileName(T0)), line({ ts: T0 + 1, kind: "key", state: {} }));
    writeFileSync(join(dir, "events", segmentFileName(T0 + SEGMENT_MS)), line({ ts: T0 + SEGMENT_MS, kind: "key", state: {} }) + line({ ts: T0 + SEGMENT_MS - 40, kind: "quest", id: 1 }));
    const rows = new SessionReader(dir).rows("events", T0, T0 + SEGMENT_MS);
    expect(rows.map((x) => x.kind)).toEqual(["key", "quest"]);
  });
});

describe("following a stream", () => {
  test("by byte offset: only whole lines, then what was appended, across a rotation and a compression", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "trace"));
    const a = join(dir, "trace", segmentFileName(T0));
    const r = new SessionReader(dir);
    expect(r.tail("trace")).toEqual({ rows: [], cursor: undefined });

    writeFileSync(a, line(key(T0 + 1)) + line(pos(T0 + 2)) + '{"ts":1767');
    let t = r.tail("trace");
    expect(t.rows.map((x) => x.ts)).toEqual([T0 + 1, T0 + 2]);
    expect(t.cursor).toEqual({ segment: segmentFileName(T0), offset: readFileSync(a).length - '{"ts":1767'.length });

    // Nothing new: the same cursor comes back.
    expect(r.tail("trace", t.cursor)).toEqual({ rows: [], cursor: t.cursor });

    // The torn line is finished by the writer, and one more appended.
    appendFileSync(a, `225600003,"kind":"pos","map":0,"x":3,"y":0,"z":0,"o":0}\n` + line(pos(T0 + 4)));
    t = r.tail("trace", t.cursor);
    expect(t.rows.map((x) => x.ts)).toEqual([T0 + 3, T0 + 4]);

    // The segment closes and is compressed, with one last row the reader had not seen; the next opens.
    appendFileSync(a, line(pos(T0 + 5)));
    await compressSegment(a);
    expect(existsSync(a)).toBe(false);
    writeFileSync(join(dir, "trace", segmentFileName(T0 + SEGMENT_MS)), line(key(T0 + SEGMENT_MS)));
    t = r.tail("trace", t.cursor);
    expect(t.rows.map((x) => x.ts)).toEqual([T0 + 5, T0 + SEGMENT_MS]);
    expect(t.cursor?.segment).toBe(segmentFileName(T0 + SEGMENT_MS));
  });

  test("from the end: only what is written afterwards", async () => {
    const dir = await plantSession("live", join(tempDir(), "s"));
    const r = new SessionReader(dir);
    const end = r.end("trace");
    expect(r.tail("trace", end).rows).toEqual([]);
    appendFileSync(join(dir, "trace", segmentFileName(T0 + SEGMENT_MS)), line(pos(T0 + SEGMENT_MS + 40_000)));
    expect(r.tail("trace", end).rows).toEqual([pos(T0 + SEGMENT_MS + 40_000)]);
    expect(r.end("events")).toBeDefined();
    expect(new SessionReader(tempDir()).end("trace")).toBeUndefined();
  });

  test("a cursor whose segment the ring has dropped resumes at the oldest one left", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nearby"));
    writeFileSync(join(dir, "nearby", segmentFileName(T0 + 2 * SEGMENT_MS)), line({ ts: T0 + 2 * SEGMENT_MS, kind: "tick" }));
    const t = new SessionReader(dir).tail("nearby", { segment: segmentFileName(T0), offset: 500 });
    expect(t.rows).toEqual([{ ts: T0 + 2 * SEGMENT_MS, kind: "tick" }]);
  });
});

describe("the store", () => {
  function session(root: string, id: string, over: Partial<SessionFile>, liveTs?: number): string {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const s: SessionFile = { format: "wrath-session/1", id, character: null, stack: { version: "t" }, module: null, started: 1, opened: 1, ended: null, ...over };
    writeFileSync(join(dir, SESSION_FILE), JSON.stringify(s));
    if (liveTs !== undefined) {
      writeFileSync(join(dir, "live.json"), JSON.stringify({ ts: liveTs }));
      utimesSync(join(dir, "live.json"), liveTs / 1000, liveTs / 1000);
    }
    return dir;
  }
  const NOW = 10 * DEFAULT_RETENTION_MS;
  const OLD = NOW - DEFAULT_RETENTION_MS - 1;
  const RECENT = NOW - 60_000;

  test("lists its sessions newest first and refuses an id that is not one", () => {
    const root = tempDir();
    session(root, "aaaaaaaaaaaaaaaa", { opened: 5 });
    session(root, "bbbbbbbbbbbbbbbb", { opened: 9 });
    mkdirSync(join(root, "not-a-session"));
    const store = new SessionStore(root);
    expect(store.list().map((s) => s.id)).toEqual(["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"]);
    expect(() => store.sessionDir("../etc")).toThrow();
    expect(store.reader("aaaaaaaaaaaaaaaa").session()?.opened).toBe(5);
    expect(new SessionStore(join(root, "missing")).list()).toEqual([]);
  });

  test("retention unlinks sessions that closed long ago or whose writer died long ago, and nothing being written", () => {
    const root = tempDir();
    session(root, "aaaaaaaaaaaaaaaa", { opened: OLD, ended: OLD });
    session(root, "bbbbbbbbbbbbbbbb", { opened: OLD, ended: RECENT });
    // Opened long ago and still beating: someone is writing it.
    session(root, "cccccccccccccccc", { opened: OLD }, RECENT);
    // Opened long ago, never closed, last beat long ago: its writer died.
    session(root, "dddddddddddddddd", { opened: OLD - 5 }, OLD);
    // The one the caller is about to write is never its own victim.
    session(root, "eeeeeeeeeeeeeeee", { opened: OLD, ended: OLD });
    const store = new SessionStore(root);
    expect(store.prune(DEFAULT_RETENTION_MS, { now: NOW, except: "eeeeeeeeeeeeeeee" }).sort()).toEqual(["aaaaaaaaaaaaaaaa", "dddddddddddddddd"]);
    expect(store.list().map((s) => s.id).sort()).toEqual(["bbbbbbbbbbbbbbbb", "cccccccccccccccc", "eeeeeeeeeeeeeeee"]);
  });

  test("the own-guid index knows the characters of the store's sessions, and learns a new one on the next refresh", () => {
    const root = tempDir();
    session(root, "aaaaaaaaaaaaaaaa", { character: { guid: "6", name: "Tamsin", race: 1, class: 2 } });
    let now = 0;
    const own = ownGuidIndex(() => new SessionStore(root).list().map((s) => s.dir), { refreshMs: 1000, now: () => now });
    expect(own("6")).toBe(true);
    expect(own("77")).toBe(false);
    // Not a player's guid at all: never own, and no read is spent on it.
    expect(own(String((0xf130n << 48n) | 5n))).toBe(false);
    session(root, "bbbbbbbbbbbbbbbb", { character: { guid: "77", name: "Orrin", race: 2, class: 3 } });
    now = 500;
    expect(own("77")).toBe(false);
    now = 1500;
    expect(own("77")).toBe(true);
    expect(new SessionStore(root).own()("6")).toBe(true);
  });
});
