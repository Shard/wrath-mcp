/**
 * The session writer (`src/record/writer.ts`) against drains it is handed
 * directly: what it leaves on disk is valid `wrath-session/1`, every segment
 * decodes alone, the gate is applied, and a session survives being closed,
 * resumed and killed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_FILE,
  NEARBY_RING_MS,
  SEGMENT_MS,
  SESSION_FILE,
  emptyEventsState,
  emptyTraceSheet,
  emptyTraceState,
  segmentFileName,
  type CallRow,
  type EventRow,
  type LiveFile,
  type NearbyRow,
  type NearbyUnit,
  type SessionFile,
  type StreamName,
  type TraceRow,
} from "../src/record/format";
import { SessionReader } from "../src/record/reader";
import type { RecordDrain } from "../src/record/recorder";
import { validateSession } from "../src/record/validate";
import { SessionWriter, type SessionWriterOptions } from "../src/record/writer";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const T0 = 1767225600000;
const ID = "3f9a1c0b7e2d4a61";
const SELF = "5";
const OWN = "6";
const FOREIGN = "77";
const CREATURE = String((0xf130n << 48n) | (4101n << 24n) | 9n);

function rig(extra: Partial<SessionWriterOptions> = {}): { dir: string; clock: { now: number }; writer: SessionWriter; reader: SessionReader; logs: string[]; reopen: () => SessionWriter } {
  const dir = join(mkdtempSync(join(tmpdir(), "wrath-writer-")), "session");
  tmp.push(dir);
  const clock = { now: T0 + 1000 };
  const logs: string[] = [];
  const make = (): SessionWriter => new SessionWriter({ dir, id: ID, stack: { version: "0.0.0-test" }, now: () => clock.now, log: (t) => logs.push(t), ...extra });
  const writer = make();
  writer.open();
  return { dir, clock, writer, reader: new SessionReader(dir), logs, reopen: make };
}

function drain(o: { trace?: TraceRow[]; dict?: RecordDrain["trace"]["dict"]; events?: EventRow[]; nearby?: NearbyRow[]; moves?: RecordDrain["moves"]; through?: number } = {}): RecordDrain {
  return {
    trace: { rows: o.trace ?? [], dropped: 0, ...(o.dict !== undefined ? { dict: o.dict } : {}) },
    events: { rows: o.events ?? [], dropped: 0 },
    nearby: { rows: o.nearby ?? [], dropped: 0, through: o.through ?? 0 },
    moves: o.moves ?? [],
    character: { guid: SELF, name: "Quillon", race: 1, class: 1 },
    stream: { connected: true, events: 10, seq: 9 },
  };
}

const keyRow = (ts: number, state: Partial<ReturnType<typeof emptyTraceState>> = {}, sheet: Partial<ReturnType<typeof emptyTraceSheet>> = {}): TraceRow => ({
  ts,
  kind: "key",
  map: 0,
  x: 1,
  y: 2,
  z: 3,
  o: 0,
  data: { ...emptyTraceState(), level: 3, hp: 100, hpMax: 100, ...state, ...emptyTraceSheet(), ...sheet },
});
const unit = (id: string, s: NearbyUnit["s"] = {}): NearbyUnit => ({ id, ty: "creature", s, m: { k: "pos", t: T0, p: [0, 0, 0] } });
const files = (dir: string, stream: StreamName): string[] => (existsSync(join(dir, stream)) ? readdirSync(join(dir, stream)).sort() : []);
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const valid = (dir: string): void => {
  const v = validateSession(dir);
  expect(v.errors).toEqual([]);
};

describe("a session on disk", () => {
  test("opening states the session, and the first drain names its character and writes live.json", () => {
    const { dir, writer, clock } = rig({ owner: "ops", group: "g1" });
    const s = json<SessionFile>(join(dir, SESSION_FILE));
    expect(s).toMatchObject({ format: "wrath-session/1", id: ID, character: null, started: T0 + 1000, opened: T0 + 1000, ended: null, owner: "ops", group: "g1" });
    clock.now = T0 + 3000;
    writer.ingest(drain({ trace: [keyRow(T0 + 2000, { zone: 9001, combat: true }), { ts: T0 + 2500, kind: "pos", map: 0, x: 4, y: 5, z: 6, o: 1 }] }));
    expect(json<SessionFile>(join(dir, SESSION_FILE)).character).toEqual({ guid: SELF, name: "Quillon", race: 1, class: 1 });
    expect(json<LiveFile>(join(dir, "live.json"))).toEqual({
      ts: T0 + 3000,
      observed: T0 + 2500,
      map: 0,
      x: 4,
      y: 5,
      z: 6,
      o: 1,
      level: 3,
      hp: 100,
      hpMax: 100,
      zone: 9001,
      area: null,
      flags: ["combat"],
      stream: { connected: true, events: 10, seq: 9 },
    });
    valid(dir);
  });

  test("with no child the heartbeat still beats, and says there is no stream", () => {
    const { dir, writer, clock } = rig();
    clock.now = T0 + 9000;
    writer.ingest(null);
    expect(json<LiveFile>(join(dir, "live.json"))).toMatchObject({ ts: T0 + 9000, observed: null, stream: null });
  });

  test("no file of it holds what the scrub removes", () => {
    const secret = "lease-secret-9f2c";
    const { dir, writer } = rig({ scrub: (t) => t.replaceAll(secret, "[redacted]") });
    writer.ingest(drain({ trace: [keyRow(T0 + 2000), { ts: T0 + 2100, kind: "state", data: { chat: [["say", `my secret is ${secret}`]] } }] }));
    const id = writer.call("run_snippet", { code: `"${secret}"` });
    writer.result(id, { text: secret });
    for (const stream of ["trace", "calls"] as const) {
      const text = readFileSync(join(dir, stream, segmentFileName(T0)), "utf8");
      expect(text).not.toContain(secret);
      expect(text).toContain("[redacted]");
    }
  });
});

describe("segments", () => {
  test("a row for a later window closes and compresses the live segment and opens the next with the fold's key", async () => {
    const { dir, writer, reader } = rig();
    writer.ingest(
      drain({
        trace: [
          keyRow(T0 + 2000, {}, { money: 10, inv: [[255, 23, 70020, 5]] }),
          { ts: T0 + 3000, kind: "state", data: { hp: 80, money: 12 } },
          { ts: T0 + SEGMENT_MS + 500, kind: "pos", map: 0, x: 9, y: 9, z: 9, o: 0 },
        ],
      }),
    );
    await writer.close();
    expect(files(dir, "trace")).toEqual([`${segmentFileName(T0)}.zst`, `${segmentFileName(T0 + SEGMENT_MS)}.zst`]);
    const [, second] = reader.segments("trace");
    const rows = reader.segment("trace", second!);
    expect(rows[0]).toMatchObject({ kind: "key", ts: T0 + SEGMENT_MS + 500, x: 1, data: { hp: 80, money: 12, inv: [[255, 23, 70020, 5]] } });
    expect(rows[1]).toMatchObject({ kind: "pos", x: 9 });
    valid(dir);
  });

  test("an idle session writes no empty windows", () => {
    const { dir, writer, clock } = rig();
    writer.ingest(drain({ trace: [keyRow(T0 + 2000)] }));
    clock.now = T0 + 3 * SEGMENT_MS;
    writer.ingest(drain());
    expect(files(dir, "trace")).toEqual([segmentFileName(T0)]);
  });

  test("trace rows never go back in time: a late row is raised to the last one written", () => {
    const { writer, reader } = rig();
    writer.ingest(drain({ trace: [keyRow(T0 + 5000)] }));
    writer.ingest(drain({ trace: [{ ts: T0 + 4000, kind: "state", data: { hp: 50 } }] }));
    expect(reader.rows("trace").map((r) => r.ts)).toEqual([T0 + 5000, T0 + 5000]);
  });

  test("the dictionary travels once per segment: on the key for what the sheet references, in a dict row for what comes later", async () => {
    const { dir, writer, reader } = rig();
    const reed: [number, number, string] = [70020, 1, "Marsh Reed"];
    const token: [number, number, string] = [70030, 2, "Ferryman's Token"];
    writer.ingest(drain({ trace: [keyRow(T0 + 2000, {}, { inv: [[255, 23, 70020]], quests: [[0, 8101, 0]] })], dict: { items: [reed], quests: [[8101, [6, 0, 0, 0, [70030, 2]]]] } }));
    writer.ingest(drain({ trace: [{ ts: T0 + 3000, kind: "state", data: { inv: [[255, 24, 70030]] } }], dict: { items: [token] } }));
    // The same ids again in the same segment name nothing twice.
    writer.ingest(drain({ trace: [{ ts: T0 + 4000, kind: "state", data: { inv: [[255, 24, 70030, 2]] } }] }));
    writer.ingest(drain({ trace: [{ ts: T0 + SEGMENT_MS + 1, kind: "state", data: { hp: 1 } }] }));
    await writer.close();
    const [first, second] = reader.segments("trace");
    const a = reader.segment("trace", first!);
    expect(a.map((r) => r.kind)).toEqual(["key", "dict", "state", "state"]);
    expect(a[0]!.dict).toEqual({ items: [reed], quests: [[8101, [6, 0, 0, 0, [70030, 2]]]] });
    expect(a[1]!.dict).toEqual({ items: [token] });
    // The next segment's key names everything its sheet references, the quest's item included.
    const b = reader.segment("trace", second!);
    expect(b[0]!.kind).toBe("key");
    expect(b[0]!.dict).toEqual({ items: [token, reed], quests: [[8101, [6, 0, 0, 0, [70030, 2]]]] });
    valid(dir);
  });

  test("a result in a later segment than its call finds the call restated in that segment's key", async () => {
    const { dir, writer, reader, clock } = rig();
    const id = writer.call("run_snippet", { code: "await sleep(1)" }, T0 + 2000);
    expect(id).toBe(T0 + 2000);
    writer.actions({ inCall: true, call: id }, [{ ts: T0 + 2100, action: "say", status: 200, ms: 3 }]);
    clock.now = T0 + SEGMENT_MS + 50;
    writer.result(id, { text: "done" });
    await writer.close();
    const [first, second] = reader.segments("calls");
    expect(reader.segment("calls", first!).map((r) => r.kind)).toEqual(["key", "call", "actions"]);
    const b = reader.segment("calls", second!) as CallRow[];
    expect(b[0]).toMatchObject({ kind: "key", open: [{ id, tool: "run_snippet" }] });
    expect(b[1]).toMatchObject({ kind: "result", id, text: "done", error: false, durationMs: SEGMENT_MS - 1950 });
    valid(dir);
  });

  test("call ids are the caller's dispatch stamps, raised when two would collide", () => {
    const { writer } = rig();
    const a = writer.call("state_summary", {}, T0 + 2000);
    const b = writer.call("state_summary", {}, T0 + 2000);
    const c = writer.call("state_summary", {});
    expect([a, b]).toEqual([T0 + 2000, T0 + 2001]);
    expect(c).toBeGreaterThan(b);
  });

  test("what dispatched something is its origin: a tool call, a routine it left running, or the client itself", () => {
    const { writer, reader } = rig();
    const note = { ts: T0 + 2000, action: "cast_spell", status: 200, ms: 2 };
    writer.actions({ inCall: true, call: 7 }, [note]);
    writer.actions({ inCall: true, call: 7, routine: true }, [note]);
    writer.actions({ inCall: true }, [note]);
    writer.actions({ inCall: false }, [note], { face: 3 });
    writer.eventsServed(7, [{ seq: 1, ts: T0, opcode: "X", data: null }], 4);
    const rows = reader.rows("calls").filter((r) => r.kind !== "key") as Extract<CallRow, { origin: unknown }>[];
    expect(rows.map((r) => r.origin)).toEqual([{ type: "tool", call: 7 }, { type: "routine", call: 7 }, { type: "tool" }, { type: "client" }, { type: "tool", call: 7 }]);
    expect(rows[3]).toMatchObject({ dropped: { face: 3 } });
    expect(rows[4]).toMatchObject({ kind: "events", count: 1, folded: 4 });
  });

  test("a move is linked to the call whose eval dispatched it", () => {
    const { writer, reader } = rig();
    const move = { ts: T0 + 2000, at: T0 + 2000, evalId: 4, moveId: 11, map: 0, x: 1, y: 2, z: 3, target: CREATURE, name: "Mire Skulker", status: null };
    writer.ingest(drain({ moves: [move, { ...move, ts: T0 + 2900, status: "arrived" }] }), (evalId) => ({ inCall: evalId !== null, call: evalId === 4 ? 99 : undefined }));
    const rows = reader.rows("calls").filter((r) => r.kind === "move");
    expect(rows).toEqual([
      { ts: T0 + 2000, kind: "move", origin: { type: "tool", call: 99 }, at: T0 + 2000, moveId: 11, map: 0, x: 1, y: 2, z: 3, target: CREATURE, name: "Mire Skulker", status: null },
      { ts: T0 + 2900, kind: "move", origin: { type: "tool", call: 99 }, at: T0 + 2000, moveId: 11, map: 0, x: 1, y: 2, z: 3, target: CREATURE, name: "Mire Skulker", status: "arrived" },
    ]);
  });
});

describe("the gate is on the write path", () => {
  test("players never reach a file, and what was written is what a mirror is handed", async () => {
    const mirrored: Record<string, unknown[]> = {};
    const { dir, writer, reader } = rig({ own: (g) => g === OWN, onRows: (stream, rows) => ((mirrored[stream] ??= []).push(...rows)) });
    writer.ingest(
      drain({
        trace: [keyRow(T0 + 2000, { target: { kind: "player", hpPct: 30 } })],
        events: [
          { ts: T0 + 2000, kind: "key", state: emptyEventsState() },
          { ts: T0 + 2100, seq: 3, kind: "group", event: "joined", members: [OWN, FOREIGN], foreign: 0, count: 3 },
          { ts: T0 + 2200, seq: 4, kind: "kill", killerGuid: FOREIGN, victimGuid: CREATURE, self: false, member: true },
        ],
        nearby: [
          { ts: T0 + 2000, kind: "key", self: { guid: SELF, map: 0, target: null, down: false }, units: [unit(CREATURE, { tg: FOREIGN }), unit(FOREIGN) as never] },
          { ts: T0 + 2300, kind: "pos", id: FOREIGN, m: { k: "pos", t: T0 + 2300, p: [1, 1, 1] } },
        ],
        moves: [{ ts: T0 + 2400, at: T0 + 2400, evalId: null, moveId: 1, map: 0, x: 1, y: 2, z: 3, target: FOREIGN, name: "Bystander", status: null }],
      }),
    );
    const disk = ["trace", "events", "calls", "nearby"].map((s) => readFileSync(join(dir, s, segmentFileName(T0)), "utf8")).join("");
    expect(disk).not.toContain(`"${FOREIGN}"`);
    expect(disk).not.toContain("Bystander");
    expect(reader.rows("events")[1]).toMatchObject({ members: [OWN], foreign: 1 });
    expect(reader.rows("events")[2]).not.toHaveProperty("killerGuid");
    expect(mirrored["events"]).toEqual(reader.rows("events"));
    expect(mirrored["trace"]).toEqual(reader.rows("trace"));
    valid(dir);
    await writer.close();
  });
});

describe("the ring", () => {
  test("opens every segment with every unit in view, names a unit a restarted child cannot, and ticks a quiet scene", () => {
    const { writer, reader } = rig();
    writer.ingest(drain({ nearby: [{ ts: T0 + 2000, kind: "key", self: { guid: SELF, map: 0, target: null, down: false }, units: [unit(CREATURE, { entry: 4101, name: "Mire Skulker" })] }], through: T0 + 2500 }));
    // A restarted child's key no longer has the name; the writer remembers it by entry.
    writer.ingest(drain({ nearby: [{ ts: T0 + SEGMENT_MS + 10, kind: "key", self: { guid: SELF, map: 0, target: null, down: false }, units: [unit(CREATURE, { entry: 4101 })] }], through: T0 + SEGMENT_MS + 20 }));
    const [a, b] = reader.segments("nearby");
    expect(reader.segment("nearby", a!).map((r) => r.kind)).toEqual(["key", "tick"]);
    const rows = reader.segment("nearby", b!) as NearbyRow[];
    expect(rows[0]).toMatchObject({ kind: "key", units: [{ id: CREATURE, s: { entry: 4101, name: "Mire Skulker" } }] });
    expect(rows[1]).toEqual({ ts: T0 + SEGMENT_MS + 20, kind: "tick" });
  });

  test("is never compressed, is pruned past its reach, and is removed when the session closes", async () => {
    const { dir, writer, clock } = rig();
    const key = (ts: number): NearbyRow => ({ ts, kind: "key", self: { guid: SELF, map: 0, target: null, down: false }, units: [] });
    writer.ingest(drain({ nearby: [key(T0 + 2000)] }));
    writer.ingest(drain({ nearby: [key(T0 + SEGMENT_MS + 1)] }));
    expect(files(dir, "nearby")).toEqual([segmentFileName(T0), segmentFileName(T0 + SEGMENT_MS)]);
    clock.now = T0 + SEGMENT_MS + NEARBY_RING_MS + 1;
    writer.ingest(drain());
    expect(files(dir, "nearby")).toEqual([segmentFileName(T0 + SEGMENT_MS)]);
    await writer.close();
    expect(existsSync(join(dir, "nearby"))).toBe(false);
  });
});

describe("closing, resuming and dying", () => {
  test("a closed session is ended, compressed, has no ring, and matches its manifest", async () => {
    const { dir, writer, clock } = rig();
    writer.ingest(drain({ trace: [keyRow(T0 + 2000)], events: [{ ts: T0 + 2000, kind: "key", state: emptyEventsState() }] }));
    writer.result(writer.call("state_summary", {}), { text: "{}" });
    clock.now = T0 + 60_000;
    await writer.close();
    await writer.close();
    const v = validateSession(dir);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.session?.ended).toBe(T0 + 60_000);
    expect(json<{ segments: unknown[] }>(join(dir, MANIFEST_FILE)).segments).toHaveLength(3);
    // After close nothing more is written.
    writer.ingest(drain({ trace: [keyRow(T0 + 70_000)] }));
    expect(validateSession(dir).errors).toEqual([]);
  });

  test("a session resumed inside the window it closed in writes a new part beside the closed segment", async () => {
    const { dir, writer, reopen, clock, reader } = rig();
    writer.ingest(drain({ trace: [keyRow(T0 + 2000)] }));
    await writer.close();
    clock.now = T0 + 90_000;
    const again = reopen();
    again.open();
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
    expect(json<SessionFile>(join(dir, SESSION_FILE))).toMatchObject({ started: T0 + 1000, opened: T0 + 90_000, ended: null, character: { guid: SELF } });
    again.ingest(drain({ trace: [keyRow(T0 + 91_000, { level: 4 })] }));
    expect(files(dir, "trace")).toEqual([segmentFileName(T0, 1), `${segmentFileName(T0)}.zst`]);
    expect(reader.rows("trace").map((r) => (r.data as { level: number }).level)).toEqual([3, 4]);
    await again.close();
    const v = validateSession(dir);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test("a writer that died leaves a torn line; the next continues its segment, and closes what it left in older windows", async () => {
    const { dir, writer, reopen, clock, reader } = rig();
    writer.ingest(drain({ trace: [keyRow(T0 + 2000), { ts: T0 + SEGMENT_MS + 5, kind: "state", data: { hp: 7 } }], nearby: [{ ts: T0 + 2000, kind: "key", self: { guid: SELF, map: 0, target: null, down: false }, units: [] }] }));
    // Killed: nothing closed, and the live segment ends mid-line.
    appendFileSync(join(dir, "trace", segmentFileName(T0 + SEGMENT_MS)), '{"ts":17672259');
    clock.now = T0 + SEGMENT_MS + 30_000;
    const next = reopen();
    next.open();
    expect(existsSync(join(dir, "nearby"))).toBe(false);
    next.ingest(drain({ trace: [keyRow(T0 + SEGMENT_MS + 31_000, { hp: 55 })] }));
    const rows = reader.rows("trace", T0 + SEGMENT_MS);
    expect(rows.map((r) => r.kind)).toEqual(["key", "state", "key"]);
    expect(validateSession(dir).errors).toEqual([]);
    await next.close();
    const v = validateSession(dir);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([`trace/${segmentFileName(T0 + SEGMENT_MS)}: 1 line(s) that are not a JSON object`]);
  });

  test("a directory it cannot write costs the record and nothing else", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wrath-writer-")), "file");
    tmp.push(dir);
    appendFileSync(dir, "not a directory");
    const logs: string[] = [];
    const writer = new SessionWriter({ dir, id: ID, stack: { version: "t" }, log: (t) => logs.push(t) });
    writer.open();
    writer.ingest(drain({ trace: [keyRow(T0)] }));
    writer.result(writer.call("x", {}), { text: "" });
    await writer.close();
    expect(logs.join("\n")).toContain("could not open the session record");
  });
});
