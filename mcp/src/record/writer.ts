/**
 * The session writer: the one writer of a session directory
 * (`docs/SESSION-FORMAT.md`). The host process of a session owns one. It
 * takes what the sandbox child's recorder latched (`recorder.ts`, drained by
 * the host on its record tick), the tool calls the dispatcher saw and the
 * action log the child pushed, passes every row through the write gate
 * (`gate.ts`), and appends it to the live segment of its stream.
 *
 * Its memory is one fold per stream, kept so that every segment can open
 * with a key row stating the stream whole: the trace's unit state, sheet and
 * position, the events state, the calls still in flight, and the units in
 * view. Rotation is lazy: a segment is opened when a row for its window is
 * written, so an idle session writes no empty windows, and the segment that
 * was live is closed and compressed then.
 *
 * It never throws into its caller. A full or read-only disk costs the
 * record, never the session: a failed write is logged once per streak and
 * the rows are dropped.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretRedactor } from "../redact";
import type { ActionNote, EventSummary, ProgramOrigin } from "../sandbox/ipc";
import {
  CAPTURED_STREAMS,
  LIVE_FILE,
  MANIFEST_FILE,
  NEARBY_RING_MS,
  SEGMENT_MS,
  SESSION_FILE,
  SESSION_FORMAT,
  SHEET_KEY_LEN,
  applySheetPatch,
  emptyEventsState,
  emptyNearbySelf,
  emptyTraceSheet,
  emptyTraceState,
  segmentFileName,
  segmentStart,
  type CallOriginRef,
  type CallRow,
  type EventRow,
  type EventsState,
  type LiveFile,
  type ManifestFile,
  type NearbyRow,
  type NearbySelf,
  type NearbyUnit,
  type SessionCharacter,
  type SessionFile,
  type StreamName,
  type StreamRows,
  type TraceDict,
  type TracePoint,
  type TraceQuestReq,
  type TraceRow,
  type TraceSheet,
  type TraceState,
  type TraceStateDelta,
} from "./format";
import { WriteGate, type OwnGuid } from "./gate";
import type { RecordDrain, RecordedMove } from "./recorder";
import { compressSegment } from "./compress";
import { listSegments } from "./segments";

export interface SessionWriterOptions {
  /** The session directory itself: `<store>/<session-id>`, or a directory a harness keeps inside its run. */
  dir: string;
  /** The session id: `tokenFingerprint(token)`. Never the token. */
  id: string;
  stack: SessionFile["stack"];
  module?: SessionFile["module"];
  owner?: string;
  group?: string;
  /** The world the session plays on (`SessionFile.world`), when the host has more than one. */
  world?: string;
  /** Whether a player guid is another session of the same deployment (`gate.ts`). Default: none is. */
  own?: OwnGuid;
  /** Applied to every line before it is written: the host's secret scrub. */
  scrub?: (text: string) => string;
  /**
   * The session token, so the writer can strike it: an agent can print its
   * own token, and no file of the record may hold it. Held in memory for
   * that and never written.
   */
  token?: string;
  /**
   * Called with the rows of each stream as they were written, after the gate.
   * For a host that also acts on what was recorded; nothing it returns is read.
   */
  onRows?: <S extends StreamName>(stream: S, rows: StreamRows[S][]) => void;
  now?: () => number;
  /** Where a dropped-row count or a write failure goes: stderr by default. */
  log?: (text: string) => void;
}

/** Who dispatched something, as the host knows it: the call's dispatch stamp, and whether it had already returned. */
export interface DispatchLink {
  call?: number | undefined;
  routine?: boolean | undefined;
  /** With a program: the routine of the model's program that dispatched it, which makes it a `program` origin. */
  program?: ProgramOrigin | undefined;
  /** Dispatched inside an eval's context at all; false for the SDK's own traffic. */
  inCall: boolean;
}

function originOf(link: DispatchLink): CallOriginRef {
  if (link.inCall && link.program !== undefined) {
    const p = link.program;
    return { type: "program", ...(link.call !== undefined ? { call: link.call } : {}), routine: p.routine, ...(p.character !== undefined ? { character: p.character } : {}) };
  }
  const type = !link.inCall ? "client" : link.routine === true ? "routine" : "tool";
  return link.call === undefined ? { type } : { type, call: link.call };
}

/** Write a JSON file whole: a temporary name beside it, then a rename, so a reader never sees half. */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Whether a file's last byte is a newline; true for an empty or missing one. */
function endsWithNewline(path: string): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined || st.size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const b = new Uint8Array(1);
    readSync(fd, b, 0, 1, st.size - 1);
    return b[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** One stream's files: which segment is live, and the closing of the one before it. */
class StreamFiles {
  private live: { t0: number; path: string } | null = null;
  private made = false;
  private failed = false;
  /** Lines waiting for the next flush, in order. */
  private pending: string[] = [];

  constructor(
    readonly stream: StreamName,
    private readonly sessionDir: string,
    private readonly o: { compress: boolean; scrub: ((text: string) => string) | undefined; log: (text: string) => void; closed: (job: Promise<unknown>) => void },
  ) {}

  private get dir(): string {
    return join(this.sessionDir, this.stream);
  }

  /** The window the live segment is for, or null before the first row. */
  get t0(): number | null {
    return this.live?.t0 ?? null;
  }

  /**
   * Make the segment for `t0` live. Returns true when it is a segment this
   * process has just opened, which the caller must start with a key row. A
   * plain segment a dead process left for the same window is continued (its
   * torn last line ended first); a compressed one is closed for good, and
   * the window gets a new part.
   */
  open(t0: number): boolean {
    if (this.live !== null && this.live.t0 >= t0) return false;
    this.close();
    let part = 0;
    for (const seg of listSegments(this.sessionDir, this.stream)) {
      if (seg.t0 !== t0) continue;
      part = seg.compressed ? seg.part + 1 : seg.part;
    }
    const path = join(this.dir, segmentFileName(t0, part));
    try {
      if (!endsWithNewline(path)) this.pending.push("\n");
    } catch {
      /* unreadable: the append below reports it */
    }
    this.live = { t0, path };
    return true;
  }

  append(row: unknown): void {
    const line = JSON.stringify(row);
    this.pending.push(`${this.o.scrub === undefined ? line : this.o.scrub(line)}\n`);
  }

  /** Write what is pending to the live segment. */
  flush(): void {
    if (this.pending.length === 0 || this.live === null) return;
    const text = this.pending.join("");
    this.pending = [];
    try {
      if (!this.made) {
        mkdirSync(this.dir, { recursive: true });
        this.made = true;
      }
      appendFileSync(this.live.path, text, "utf8");
      this.failed = false;
    } catch (err) {
      // The directory may have been removed under us: make it again next time.
      this.made = false;
      if (!this.failed) this.o.log(`[record] could not write ${this.stream}: ${err instanceof Error ? err.message : String(err)}`);
      this.failed = true;
    }
  }

  /** Close the live segment: flush it, and compress it when this stream is captured. */
  close(): void {
    this.flush();
    const live = this.live;
    this.live = null;
    if (live === null || !this.o.compress) return;
    this.o.closed(compressSegment(live.path).catch((err: unknown) => this.o.log(`[record] could not compress ${live.path}: ${String(err)}`)));
  }

  /** Compress every plain segment but the live one: what a process that died left behind. */
  recover(): void {
    if (!this.o.compress) return;
    for (const seg of listSegments(this.sessionDir, this.stream)) {
      if (seg.compressed || seg.path === this.live?.path) continue;
      this.o.closed(compressSegment(seg.path).catch(() => null));
    }
  }
}

/** A key row's sheet: each key as it is, and `null` for one it lacks. */
function sheetOf(data: unknown): TraceSheet {
  const s = emptyTraceSheet();
  if (data === null || typeof data !== "object") return s;
  const d = data as Record<string, unknown>;
  if (typeof d["money"] === "number") s.money = d["money"];
  for (const key of Object.keys(SHEET_KEY_LEN) as (keyof typeof SHEET_KEY_LEN)[]) {
    const v = d[key];
    if (Array.isArray(v)) (s as unknown as Record<string, unknown>)[key] = v;
  }
  return s;
}

/** The item, random property and quest ids a key or state row's sheet lists reference. */
function sheetRefs(data: unknown): { items: number[]; rands: number[]; quests: number[] } {
  const items: number[] = [];
  const rands: number[] = [];
  const quests: number[] = [];
  if (data === null || typeof data !== "object") return { items, rands, quests };
  const d = data as Record<string, unknown>;
  const at = (key: string, index: number, out: number[], signed = false): void => {
    const list = d[key];
    if (!Array.isArray(list)) return;
    for (const r of list as unknown[]) {
      const id = Array.isArray(r) ? (r[index] as unknown) : undefined;
      if (typeof id === "number" && (signed ? id !== 0 : id > 0)) out.push(id);
    }
  };
  at("equip", 1, items);
  at("bags", 1, items);
  at("inv", 2, items);
  // A random property id is signed: negative is a random suffix.
  at("equip", 2, rands, true);
  at("inv", 4, rands, true);
  at("quests", 1, quests);
  return { items, rands, quests };
}

/** A dictionary of the entries given, without the empty lists; `undefined` when all are empty. */
function dictOf(items: NonNullable<TraceDict["items"]>, rands: NonNullable<TraceDict["rands"]>, quests: NonNullable<TraceDict["quests"]>): TraceDict | undefined {
  if (items.length === 0 && rands.length === 0 && quests.length === 0) return undefined;
  return { ...(items.length > 0 ? { items } : {}), ...(rands.length > 0 ? { rands } : {}), ...(quests.length > 0 ? { quests } : {}) };
}

const FLAG_KEYS = ["combat", "mounted", "taxi", "dead", "ghost", "resting"] as const;

export class SessionWriter {
  readonly dir: string;
  private readonly now: () => number;
  private readonly log: (text: string) => void;
  private readonly gate: WriteGate;
  private readonly files: Record<StreamName, StreamFiles>;
  private readonly jobs = new Set<Promise<unknown>>();
  private session: SessionFile | null = null;
  private closed = false;

  // trace
  private readonly traceFold: { state: TraceState; sheet: TraceSheet; pos: TracePoint | null; ts: number; any: boolean } = {
    state: emptyTraceState(),
    sheet: emptyTraceSheet(),
    pos: null,
    ts: 0,
    any: false,
  };
  private traceLast = 0;
  private readonly dictItems = new Map<number, NonNullable<TraceDict["items"]>[number]>();
  private readonly dictRands = new Map<number, string>();
  private readonly dictQuests = new Map<number, TraceQuestReq>();
  /** The ids the live trace segment has already named. */
  private named = { items: new Set<number>(), rands: new Set<number>(), quests: new Set<number>() };

  // events
  private eventsFold: EventsState = emptyEventsState();

  // calls
  private readonly openCalls = new Map<number, Extract<CallRow, { kind: "call" }>>();
  private lastCallId = 0;

  // nearby
  private readonly nearbyFold: { self: NearbySelf; units: Map<string, NearbyUnit>; ts: number; any: boolean } = {
    self: emptyNearbySelf(),
    units: new Map(),
    ts: 0,
    any: false,
  };
  /** Names this session's client was answered, by creature entry: a restarted child starts with none. */
  private readonly entryNames = new Map<number, { name: string; sub?: string }>();

  private stream: LiveFile["stream"] = null;
  /** Rows written since the last `onRows`, per stream. */
  private written: { [S in StreamName]?: StreamRows[S][] } = {};

  constructor(private readonly o: SessionWriterOptions) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((text) => console.error(text));
    this.gate = new WriteGate(o.own);
    const closed = (job: Promise<unknown>): void => {
      this.jobs.add(job);
      void job.finally(() => this.jobs.delete(job));
    };
    // Every line of the captured streams passes the host's scrub and then the
    // token's own strike. The ring holds no free text, so it is written as it is.
    const token = new SecretRedactor();
    token.redact(o.token);
    const scrub = (text: string): string => token.scrub(o.scrub === undefined ? text : o.scrub(text));
    const make = (stream: StreamName): StreamFiles =>
      new StreamFiles(stream, this.dir, { compress: stream !== "nearby", scrub: stream === "nearby" ? undefined : scrub, log: this.log, closed });
    this.files = { trace: make("trace"), events: make("events"), calls: make("calls"), nearby: make("nearby") };
  }

  /**
   * Open the session: make its directory, state it in `session.json`, remove
   * a ring a killed process left and compress the segments it left plain.
   * A session that was open before keeps its `started`.
   */
  open(): void {
    const now = this.now();
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      let before: Partial<SessionFile> = {};
      try {
        before = JSON.parse(readFileSync(join(this.dir, SESSION_FILE), "utf8")) as Partial<SessionFile>;
      } catch {
        /* a new session */
      }
      this.session = {
        format: SESSION_FORMAT,
        id: this.o.id,
        character: before.id === this.o.id ? (before.character ?? null) : null,
        stack: this.o.stack,
        module: this.o.module ?? null,
        ...(this.o.owner !== undefined ? { owner: this.o.owner } : {}),
        ...(this.o.group !== undefined ? { group: this.o.group } : {}),
        ...(this.o.world !== undefined ? { world: this.o.world } : {}),
        started: before.id === this.o.id && typeof before.started === "number" ? before.started : now,
        opened: now,
        ended: null,
      };
      if (this.session.character !== null) this.gate.setSelf(this.session.character.guid);
      this.writeSession();
      rmSync(join(this.dir, "nearby"), { recursive: true, force: true });
      rmSync(join(this.dir, MANIFEST_FILE), { force: true });
      for (const stream of CAPTURED_STREAMS) this.files[stream].recover();
    } catch (err) {
      this.log(`[record] could not open the session record at ${this.dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** What the module said of itself, learned after the session opened. */
  setModule(module: SessionFile["module"]): void {
    if (this.session === null || this.closed) return;
    this.session = { ...this.session, module };
    this.writeSession();
  }

  private writeSession(): void {
    if (this.session === null) return;
    try {
      writeJson(join(this.dir, SESSION_FILE), this.session);
    } catch (err) {
      this.log(`[record] could not write ${SESSION_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------------------------------------------------------------- plumbing

  /** Gate one row and append it to its stream's live segment, opening the segment (and keying it) as needed. */
  private put<S extends StreamName>(stream: S, raw: StreamRows[S], key: (ts: number) => StreamRows[S]): StreamRows[S] | null {
    const row = this.gate.gate(stream, raw);
    if (row === null) return null;
    const files = this.files[stream];
    const fresh = files.open(Math.max(files.t0 ?? 0, segmentStart(row.ts)));
    if (fresh) {
      // A segment opens with a key row: the row itself when it is one, else the fold's.
      if (row.kind !== "key") this.emit(stream, key(row.ts));
    }
    this.emit(stream, row);
    return row;
  }

  private emit<S extends StreamName>(stream: S, row: StreamRows[S]): void {
    this.files[stream].append(row);
    if (this.o.onRows !== undefined) ((this.written[stream] ??= []) as StreamRows[S][]).push(row);
  }

  private flush(): void {
    for (const stream of Object.keys(this.files) as StreamName[]) this.files[stream].flush();
    const written = this.written;
    this.written = {};
    if (this.o.onRows === undefined) return;
    for (const stream of Object.keys(written) as StreamName[]) {
      try {
        this.o.onRows(stream, written[stream] as never);
      } catch {
        /* a host's own handler must not cost the record */
      }
    }
  }

  // ---------------------------------------------------------------- drain

  /**
   * One record tick: everything the child's recorder latched since the last,
   * written in order, then `live.json`. `link` names the call an eval id
   * belongs to, for the moves. A null drain (no child running) still beats
   * the heartbeat.
   */
  ingest(drain: RecordDrain | null, link: (evalId: number | null, routine: boolean, program?: ProgramOrigin) => DispatchLink = () => ({ inCall: false })): void {
    if (this.closed || this.session === null) return;
    try {
      if (drain !== null) {
        this.stream = drain.stream;
        this.noteCharacter(drain.character);
        if (drain.players !== undefined) this.notePlayers(drain.players);
        this.writeTrace(drain.trace.rows, drain.trace.dict);
        for (const row of drain.events.rows) this.writeEvent(row);
        for (const move of drain.moves) this.writeMove(move, link(move.evalId, move.routine === true, move.program));
        for (const row of drain.nearby.rows) this.writeNearby(row);
        if (drain.nearby.through > this.nearbyFold.ts && this.nearbyFold.any) this.writeNearby({ ts: drain.nearby.through, kind: "tick" });
        const dropped = drain.trace.dropped + drain.nearby.dropped + drain.events.dropped;
        if (dropped > 0) this.log(`[record] the sandbox buffers dropped ${dropped} row(s) before this drain`);
      } else this.stream = null;
      this.flush();
      this.pruneRing();
      this.writeLive();
    } catch (err) {
      this.log(`[record] a record tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Player names a client was answered, as `[guid, name]`: what the gate's
   * free-text scrub looks for (`gate.ts`). Held in memory, never written.
   * `ingest` takes a drain's own; a host driving several characters also
   * hands each writer the others'.
   */
  notePlayers(players: Iterable<readonly [string, string]>): void {
    this.gate.notePlayers(players);
  }

  /**
   * The session's own character's guid, when the host learns it before a
   * drain names the character (a seat as it opens). Held by the gate only;
   * `session.json` still names the character from the drain.
   */
  noteSelf(guid: string): void {
    this.gate.setSelf(guid);
  }

  /** Another session of the deployment that the host knows of ahead of the store's index: a seat of the same client. */
  noteOwn(guid: string): void {
    this.gate.noteOwn(guid);
  }

  private noteCharacter(c: SessionCharacter | null): void {
    if (c === null || this.session === null) return;
    const have = this.session.character;
    if (have !== null && have.guid === c.guid && have.name === c.name && have.race === c.race && have.class === c.class) return;
    this.session = { ...this.session, character: c };
    this.gate.setSelf(c.guid);
    this.writeSession();
  }

  // ---------------------------------------------------------------- trace

  private traceKey(ts: number): TraceRow {
    const f = this.traceFold;
    const data = { ...f.state, auras: [...f.state.auras], ...f.sheet };
    const row: TraceRow = {
      ts: Math.max(ts, this.traceLast),
      kind: "key",
      map: f.pos?.map ?? null,
      x: f.pos?.x ?? null,
      y: f.pos?.y ?? null,
      z: f.pos?.z ?? null,
      o: f.pos?.o ?? null,
      data,
    };
    const dict = this.unnamed(data);
    if (dict !== undefined) row.dict = dict;
    return row;
  }

  /** The dictionary entries `data` references that the live segment has not named yet, marked named. */
  private unnamed(data: unknown): TraceDict | undefined {
    const refs = sheetRefs(data);
    const items: NonNullable<TraceDict["items"]> = [];
    const rands: NonNullable<TraceDict["rands"]> = [];
    const quests: NonNullable<TraceDict["quests"]> = [];
    const item = (id: number): void => {
      const e = this.dictItems.get(id);
      if (e === undefined || this.named.items.has(id)) return;
      this.named.items.add(id);
      items.push(e);
    };
    for (const id of refs.quests) {
      const req = this.dictQuests.get(id);
      if (req === undefined || this.named.quests.has(id)) continue;
      this.named.quests.add(id);
      quests.push([id, req]);
      // The items it asks for are named with it, so a reader can say what is collected before any is carried.
      for (let i = 4; i < req.length; i++) item((req[i] as [number, number])[0]);
    }
    for (const id of refs.items) item(id);
    for (const id of refs.rands) {
      const suffix = this.dictRands.get(id);
      if (suffix === undefined || this.named.rands.has(id)) continue;
      this.named.rands.add(id);
      rands.push([id, suffix]);
    }
    return dictOf(items, rands, quests);
  }

  private writeTrace(rows: TraceRow[], dict: TraceDict | undefined): void {
    // Entries the child named for the first time: kept for the session, and
    // written at once to a segment that is already open.
    const fresh: TraceDict = {};
    for (const e of dict?.items ?? []) {
      this.dictItems.set(e[0], e);
      (fresh.items ??= []).push(e);
    }
    for (const [id, suffix] of dict?.rands ?? []) {
      this.dictRands.set(id, suffix);
      (fresh.rands ??= []).push([id, suffix]);
    }
    for (const [id, req] of dict?.quests ?? []) {
      this.dictQuests.set(id, req);
      (fresh.quests ??= []).push([id, req]);
    }
    // Stable, so rows observed at the same instant keep the child's order.
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    const first = sorted[0];
    const live = this.files.trace.t0;
    const at = Math.max(this.traceLast, first?.ts ?? this.now());
    // Into the segment that is open, ahead of the rows that may need them. When
    // the first row opens a new segment instead, its key names what it references.
    if ((fresh.items !== undefined || fresh.rands !== undefined || fresh.quests !== undefined) && live !== null && segmentStart(at) <= live) {
      this.putTrace({ ts: at, kind: "dict", dict: fresh });
    }
    for (const latched of sorted) this.putTrace(latched);
  }

  private putTrace(latched: TraceRow): void {
    const key = (ts: number): TraceRow => this.traceKey(ts);
    // Never back in time: a row stamped before the last one written is raised to it.
    let row: TraceRow = latched.ts < this.traceLast ? { ...latched, ts: this.traceLast } : latched;
    const live = this.files.trace.t0;
    if (live === null || segmentStart(row.ts) > live) {
      // A new segment names everything again. It opens with this row when the
      // row is a key, else with the fold's, which names what the fold references.
      this.named = { items: new Set(), rands: new Set(), quests: new Set() };
      if (row.kind !== "key") this.writeTraceRow(this.traceKey(row.ts), key);
    }
    if (row.kind === "dict") {
      const items = (row.dict?.items ?? []).filter((e) => !this.named.items.has(e[0]));
      const rands = (row.dict?.rands ?? []).filter((e) => !this.named.rands.has(e[0]));
      const quests = (row.dict?.quests ?? []).filter((e) => !this.named.quests.has(e[0]));
      const dict = dictOf(items, rands, quests);
      if (dict === undefined) return;
      for (const e of items) this.named.items.add(e[0]);
      for (const e of rands) this.named.rands.add(e[0]);
      for (const e of quests) this.named.quests.add(e[0]);
      row = { ts: row.ts, kind: "dict", dict };
    } else if (row.kind === "key" || row.kind === "state") {
      const dict = this.unnamed(row.data);
      if (dict !== undefined) {
        if (row.kind === "key") row = { ...row, dict };
        else this.writeTraceRow({ ts: row.ts, kind: "dict", dict }, key);
      }
    }
    this.writeTraceRow(row, key);
  }

  private writeTraceRow(row: TraceRow, key: (ts: number) => TraceRow): void {
    const written = this.put("trace", row, key);
    if (written === null) return;
    if (written.ts > this.traceLast) this.traceLast = written.ts;
    this.foldTrace(written);
  }

  private foldTrace(row: TraceRow): void {
    const f = this.traceFold;
    if (row.kind === "dict") return;
    f.any = true;
    if (row.ts > f.ts) f.ts = row.ts;
    if (row.kind === "key") {
      f.state = { ...emptyTraceState(), ...(row.data as TraceState) };
      f.sheet = sheetOf(row.data);
    } else if (row.kind === "state") {
      const d = (row.data ?? {}) as TraceStateDelta;
      // Turn-ins and chat are events, never state: neither reaches a key row.
      const { money, qdone: _qdone, chat: _chat, equip, bags, inv, dur, quests, rep, skills, ...unit } = d;
      Object.assign(f.state, unit);
      // A new sheet object whenever one key moves, so a key row already written holds the old one.
      const patches = { equip, bags, inv, dur, quests, rep, skills };
      let sheet: TraceSheet | null = null;
      if (money !== undefined) (sheet ??= { ...f.sheet }).money = money;
      for (const key of Object.keys(patches) as (keyof typeof patches)[]) {
        const p = patches[key];
        if (p === undefined) continue;
        sheet ??= { ...f.sheet };
        (sheet as unknown as Record<string, unknown>)[key] = applySheetPatch(f.sheet[key], p, SHEET_KEY_LEN[key]);
      }
      if (sheet !== null) f.sheet = sheet;
    }
    if (row.kind !== "state" && typeof row.map === "number" && typeof row.x === "number" && typeof row.y === "number" && typeof row.z === "number") {
      f.pos = { map: row.map, x: row.x, y: row.y, z: row.z, o: typeof row.o === "number" ? row.o : (f.pos?.o ?? 0) };
    }
  }

  // --------------------------------------------------------------- events

  private writeEvent(raw: EventRow): void {
    const row = this.put("events", raw, (ts) => ({ ts, kind: "key", state: this.eventsFold }));
    if (row === null) return;
    const s = { ...this.eventsFold };
    switch (row.kind) {
      case "key":
        this.eventsFold = row.state;
        return;
      case "zone":
        s.zone = row.to;
        break;
      case "area":
        s.area = row.to;
        break;
      case "level":
        s.level = row.to;
        break;
      case "death":
        s.dead = true;
        if (row.released === true) s.released = true;
        break;
      case "release":
        s.dead = true;
        s.released = true;
        break;
      case "resurrect":
        s.dead = false;
        s.released = false;
        break;
      case "taxi":
        s.taxi = true;
        break;
      case "taxi_landed":
        s.taxi = false;
        break;
      case "group":
        s.group =
          row.event === "left"
            ? null
            : {
                ...(row.groupGuid !== undefined ? { groupGuid: row.groupGuid } : {}),
                ...(row.leaderGuid !== undefined ? { leaderGuid: row.leaderGuid } : {}),
                members: row.members,
                foreign: row.foreign,
                count: row.count,
              };
        break;
      case "instance":
        s.map = row.map;
        s.instanceType = row.instanceType;
        break;
      default:
        return;
    }
    this.eventsFold = s;
  }

  // ---------------------------------------------------------------- calls

  /** The calls still in flight, as written: through the gate like the rows they restate. */
  private callsKey = (ts: number): CallRow => this.gate.gate("calls", { ts, kind: "key", open: [...this.openCalls.values()] }) as CallRow;

  private writeCall(row: CallRow): void {
    if (this.closed || this.session === null) return;
    try {
      this.put("calls", row, this.callsKey);
      this.files.calls.flush();
    } catch (err) {
      this.log(`[record] a calls row failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A tool call as it is dispatched. `dispatchTs` is the caller's own stamp
   * for it when it has one; the id returned is that stamp, raised when needed
   * so that ids are strictly increasing, and is what links everything the
   * call sends.
   */
  call(tool: string, args: unknown, dispatchTs?: number): number {
    const at = dispatchTs ?? this.now();
    const id = at > this.lastCallId ? at : this.lastCallId + 1;
    this.lastCallId = id;
    const row: Extract<CallRow, { kind: "call" }> = { ts: id, kind: "call", id, origin: { type: "tool" }, tool, args: args ?? null };
    // Open before it is written, so a key this very row forces does not need it; closed again by its result.
    this.writeCall(row);
    this.openCalls.set(id, row);
    return id;
  }

  /** The call's answer, as the caller was handed it. */
  result(id: number, result: { text: string; isError?: boolean | undefined }): void {
    const now = this.now();
    // Written while the call is still open, so a segment this row opens restates it.
    this.writeCall({ ts: now, kind: "result", id, text: result.text, error: result.isError === true, durationMs: Math.max(0, now - id) });
    this.openCalls.delete(id);
  }

  /** One flush of the action log, linked to what dispatched it. */
  actions(link: DispatchLink, actions: ActionNote[], dropped?: Record<string, number>): void {
    this.writeCall({ ts: this.now(), kind: "actions", origin: originOf(link), actions, ...(dropped !== undefined ? { dropped } : {}) });
  }

  /** An event batch a call served its caller, as it was shown. */
  eventsServed(call: number | undefined, events: EventSummary[], folded?: number): void {
    this.writeCall({
      ts: this.now(),
      kind: "events",
      origin: originOf({ call, inCall: true }),
      count: events.length,
      ...(folded !== undefined && folded > 0 ? { folded } : {}),
      events,
    });
  }

  private writeMove(m: RecordedMove, link: DispatchLink): void {
    this.put(
      "calls",
      {
        ts: m.ts,
        kind: "move",
        origin: originOf(link),
        at: m.at,
        moveId: m.moveId,
        map: m.map,
        x: m.x,
        y: m.y,
        z: m.z,
        target: m.target,
        ...(m.name !== undefined ? { name: m.name } : {}),
        status: m.status,
      },
      this.callsKey,
    );
  }

  // --------------------------------------------------------------- nearby

  /** Fill a unit's missing name from what this session's client was told before. */
  private nameUnit(u: NearbyUnit): NearbyUnit {
    if ((u.s.name !== undefined && u.s.name !== null) || typeof u.s.entry !== "number") return u;
    const n = this.entryNames.get(u.s.entry);
    if (n === undefined) return u;
    return { ...u, s: { ...u.s, name: n.name, ...(n.sub !== undefined && u.s.sub == null ? { sub: n.sub } : {}) } };
  }

  private remember(entry: unknown, name: unknown, sub: unknown): void {
    if (typeof name !== "string" || name === "" || typeof entry !== "number") return;
    this.entryNames.set(entry, { name, ...(typeof sub === "string" ? { sub } : {}) });
  }

  private writeNearby(raw: NearbyRow): void {
    let named = raw;
    if (raw.kind === "key") named = { ...raw, units: raw.units.map((u) => this.nameUnit(u)) };
    else if (raw.kind === "in") named = { ...raw, u: this.nameUnit(raw.u) };
    if (named.ts < this.nearbyFold.ts) named = { ...named, ts: this.nearbyFold.ts };
    const row = this.put("nearby", named, (ts) => ({ ts, kind: "key", self: { ...this.nearbyFold.self }, units: [...this.nearbyFold.units.values()] }));
    if (row === null) return;
    const f = this.nearbyFold;
    f.any = true;
    if (row.ts > f.ts) f.ts = row.ts;
    switch (row.kind) {
      case "key":
        f.self = { ...row.self };
        f.units = new Map(row.units.map((u) => [u.id, u]));
        for (const u of row.units) this.remember(u.s.entry, u.s.name, u.s.sub);
        return;
      case "in":
        f.units.set(row.u.id, row.u);
        this.remember(row.u.s.entry, row.u.s.name, row.u.s.sub);
        return;
      case "mv":
      case "pos": {
        const u = f.units.get(row.id);
        if (u !== undefined) f.units.set(row.id, { ...u, m: row.m });
        return;
      }
      case "st": {
        const u = f.units.get(row.id);
        if (u === undefined) return;
        const s = { ...u.s };
        for (const [k, v] of Object.entries(row.s)) {
          if (v === null) delete (s as Record<string, unknown>)[k];
          else (s as Record<string, unknown>)[k] = v;
        }
        f.units.set(row.id, { ...u, s });
        this.remember(s.entry, s.name, s.sub);
        return;
      }
      case "nm": {
        const u = f.units.get(row.id);
        if (u === undefined) return;
        f.units.set(row.id, { ...u, s: { ...u.s, name: row.name, ...(row.sub !== undefined ? { sub: row.sub } : {}) } });
        this.remember(u.s.entry, row.name, row.sub);
        return;
      }
      case "out":
        f.units.delete(row.id);
        return;
      case "self":
        f.self = { ...f.self, ...row.self };
        return;
      case "tick":
        return;
    }
  }

  /** Unlink every ring segment that ended more than `NEARBY_RING_MS` ago. */
  private pruneRing(): void {
    const now = this.now();
    for (const seg of listSegments(this.dir, "nearby")) {
      if (seg.t0 + SEGMENT_MS > now - NEARBY_RING_MS) continue;
      try {
        unlinkSync(seg.path);
      } catch {
        /* gone already */
      }
    }
  }

  // ----------------------------------------------------------------- live

  private writeLive(): void {
    const f = this.traceFold;
    const live: LiveFile = {
      ts: this.now(),
      observed: f.any ? f.ts : null,
      map: f.pos?.map ?? null,
      x: f.pos?.x ?? null,
      y: f.pos?.y ?? null,
      z: f.pos?.z ?? null,
      o: f.pos?.o ?? null,
      level: f.state.level,
      hp: f.state.hp,
      hpMax: f.state.hpMax,
      zone: f.state.zone,
      area: f.state.area,
      flags: FLAG_KEYS.filter((k) => f.state[k]),
      stream: this.stream,
    };
    try {
      writeJson(join(this.dir, LIVE_FILE), live);
    } catch {
      /* the next tick writes it again */
    }
  }

  // ---------------------------------------------------------------- close

  /**
   * Close the session: every live segment closed and compressed, the ring
   * removed, `ended` stated and the manifest written. Idempotent. After it,
   * nothing more is written.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.session === null) return;
    try {
      for (const stream of Object.keys(this.files) as StreamName[]) this.files[stream].close();
      await Promise.all([...this.jobs]);
      rmSync(join(this.dir, "nearby"), { recursive: true, force: true });
      const ended = this.now();
      this.session = { ...this.session, ended };
      this.writeSession();
      this.stream = null;
      this.writeLive();
      writeJson(join(this.dir, MANIFEST_FILE), this.manifest(ended));
    } catch (err) {
      this.log(`[record] could not close the session record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Every captured segment as the directory holds it, sized and hashed. */
  private manifest(written: number): ManifestFile {
    const segments: ManifestFile["segments"] = [];
    for (const stream of CAPTURED_STREAMS) {
      for (const seg of listSegments(this.dir, stream)) {
        const bytes = readFileSync(seg.path);
        segments.push({ stream, file: `${seg.stem}${seg.compressed ? ".zst" : ""}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
    return { format: SESSION_FORMAT, id: this.o.id, written, segments };
  }
}

/** Whether a directory holds a session record of this format. */
export function isSessionDir(dir: string): boolean {
  return existsSync(join(dir, SESSION_FILE));
}
