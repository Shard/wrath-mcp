/**
 * The host's side of a program (`SandboxHostOptions.program`): the files, the
 * routine registry, load on save, the heartbeat and what a harness reads of
 * all of it. The child runs the routines (`program.ts`); this decides what is
 * loaded, remembers what was running, and brings it back.
 *
 *  - Files. The four file operations are the workspace's (`workspace.ts`),
 *    answered here so a save can load. A save that changes a code or JSON
 *    file makes a new version of the files, which snippets import from at
 *    once; when it changed `main.ts` or a file in its import graph, that
 *    version is loaded as the program and the answer says what happened. A
 *    load that fails changes nothing.
 *  - The registry. One row per routine name and character: its arguments,
 *    when it started, on which version, how it stands and the last action it
 *    dispatched. Written beside the workspace on every change, so a new
 *    process finds what was running.
 *  - Restarts. After a sandbox restart, and in a new process over an old
 *    registry, the program is loaded again and the routines that were running
 *    are started again from the top. The one exception is a child killed for
 *    a blocked event loop while no snippet was in flight: the program is then
 *    to blame, which routine cannot be known, and none is started; their rows
 *    read `interrupted` and the restart fact names them.
 *  - The heartbeat. While a routine runs the child is asked for a beat every
 *    few seconds. The answer carries what is too frequent to push (last
 *    actions, repeat counts, the routines' console); no answer means the
 *    event loop is blocked, and with no snippet in flight to notice, the
 *    beat is what restarts the child. It also starts a child that died while
 *    nothing else was looking.
 *  - Facts. Everything a harness needs to decide a wake and to say what
 *    happened is here as data: `onFact` as it happens, `drainFacts` for the
 *    span since the last drain. The stack words none of it and wakes nobody.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durationWords, LOAD_TIMEOUT_MS, RESTART_SETTLE_MS } from "./program";
import type { ProgramBeat, ProgramErrorNote, ProgramEvent, ProgramLoadAnswer, ProgramLogLine, RoutineAnswer, RoutineNote } from "./ipc";
import { isImportable, MAIN_PATH, sameImportGraph, type LineRange, type Workspace, type WorkspaceResult } from "../workspace";

/** How often a running program is asked for a beat. */
export const PROGRAM_BEAT_MS = 5_000;
/** How long a beat may take before the child's event loop counts as blocked. */
export const PROGRAM_BEAT_GRACE_MS = 10_000;
/** How long a routine's start or stop may take to answer. */
const ROUTINE_ANSWER_MS = 10_000;
/** How long a resumed start may take: the stream reopens and replays first. */
const ROUTINE_RESUME_MS = 30_000;
/** Facts kept between two drains; past it the oldest go, counted. */
const FACTS_KEEP = 200;
/** Console lines kept between two drains. */
const CONSOLE_KEEP = 200;

export interface ProgramOptions {
  /** The model's files, and where the registry lives. */
  workspace: Workspace;
  /** Called with every fact as it happens (`ProgramFact`). Never throws into the sandbox. */
  onFact?: (fact: ProgramFact) => void;
  /** How often a running program is asked for a beat. Default `PROGRAM_BEAT_MS`. */
  beatMs?: number;
  /** How long a beat may go unanswered. Default `PROGRAM_BEAT_GRACE_MS`. */
  beatGraceMs?: number;
}

/** A routine as the registry holds it. */
export interface RoutineRow extends RoutineNote {
  /** Why an `interrupted` row is one. */
  note?: string;
}

/**
 * Something that happened to the model's program. The child's own events
 * (`ProgramEvent`) plus the host's: a successful or failed load, and a
 * restart with what came back.
 */
export type ProgramFact =
  | ProgramEvent
  | { kind: "loaded"; ts: number; deploy: number; routines: string[]; restarted: string[]; dropped: string[]; by: "save" | "restart" }
  | { kind: "load_failed"; ts: number; error: string; running: number | null; by: "save" | "restart" }
  | {
      kind: "restart";
      ts: number;
      /** The program is to blame: the child's event loop was blocked with no snippet in flight. */
      blamed: boolean;
      /** The routines started again from the top. */
      restarted: RoutineRow[];
      /** The routines that were running and were not started again, each with why. */
      interrupted: RoutineRow[];
    }
  | { kind: "error"; ts: number; deploy: number; error: ProgramErrorNote; fresh: true };

/** What a drain hands a harness: the span since the last one. */
export interface ProgramFacts {
  /** The loaded version, or null with nothing loaded. */
  deploy: number | null;
  /** Every routine as it stands now. */
  routines: RoutineRow[];
  facts: ProgramFact[];
  /** Facts that fell off the front of a full buffer. */
  factsDropped: number;
  /** Repeats of error and refusal signatures since the last drain, by signature. */
  repeats: { signature: string; count: number; ts: number }[];
  /** The routines' console since the last drain: its last lines, and how many lines there were in all. */
  console: { lines: ProgramLogLine[]; total: number };
}

/** What a file or routine operation answers: the text a tool result carries. */
export interface ProgramAnswer {
  ok: boolean;
  text: string;
}

/** What the program needs of the sandbox host. */
export interface ProgramPort {
  /** Start a child if none runs, and wait for it to be ready. */
  start(): Promise<void>;
  running(): boolean;
  /** Send one request to the child and await its `rpc_result` value; rejects on a refusal, an exit or `timeoutMs`. */
  request(msg: Record<string, unknown> & { t: string }, timeoutMs: number, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<unknown>;
  /** Tell the child something it does not answer. */
  tell(msg: Record<string, unknown> & { t: string }): void;
  /** Whether `err` is a request that timed out, as against a child that went away. */
  isTimeout(err: unknown): boolean;
  /** How many snippets are awaiting their result. */
  snippetsInFlight(): number;
  /** Kill and restart a child whose event loop is blocked. */
  restartStalled(): Promise<void>;
  /** Whether a character is attached, at fan-out above 1; always true at fan-out 1. */
  attached(character: string | undefined): boolean;
  now(): number;
}

const rowKey = (name: string, character: string | undefined): string => `${character ?? ""}\u0000${name}`;
const label = (r: { name: string; character?: string | undefined }): string => (r.character === undefined ? r.name : `${r.name} (${r.character})`);

/**
 * What identifies a routine line's error or returned value as shown: the run
 * (name, character, start) and the text itself, so a new run's value and a
 * changed one are new. Undefined for a row that has neither.
 */
export function routineDetailKey(r: RoutineRow): string | undefined {
  const run = `${rowKey(r.name, r.character)}\u0000${r.startedAt}`;
  if (r.state === "threw" && r.error !== undefined) return `${run}\u0000threw\u0000${r.error.text}\u0000${r.error.frames[0] ?? ""}`;
  if (r.state === "returned" && r.value !== undefined) return `${run}\u0000returned\u0000${r.value}`;
  return undefined;
}

/**
 * The routines as a tool result lists them, one per line. Pure: the rows, the
 * clock and what was shown before arrive as data. Durations, never clock
 * times, so the lines mean the same in any time zone. An error or a returned
 * value whose `routineDetailKey` is in `shown` is already in the
 * conversation: its line refers to it rather than repeating it.
 */
export function renderRoutines(rows: readonly RoutineRow[], now: number, shown: ReadonlySet<string> = new Set()): string {
  if (rows.length === 0) return "routines: none started";
  const lines = rows.map((r) => {
    if (r.state === "running") {
      const acted = r.lastAction === undefined ? "no action yet" : `last action ${durationWords(now - r.lastAction.ts)} ago`;
      return `${label(r)} running ${durationWords(now - r.startedAt)}, deploy ${r.deploy}, ${acted}`;
    }
    const ago = `${durationWords(now - (r.endedAt ?? now))} ago`;
    const key = routineDetailKey(r);
    const before = key !== undefined && shown.has(key);
    if (r.state === "threw") {
      if (before) return `${label(r)} threw ${ago}: ${r.error!.name} (shown before)`;
      return `${label(r)} threw ${ago}: ${r.error?.text ?? "an error"}${r.error?.frames[0] !== undefined ? ` ${r.error.frames[0]}` : ""}`;
    }
    if (r.state === "interrupted") return `${label(r)} interrupted ${ago}${r.note !== undefined ? `: ${r.note}` : ""}`;
    if (r.state === "returned") {
      if (before) return `${label(r)} returned ${ago} (value shown before)`;
      return `${label(r)} returned ${ago}${r.value !== undefined ? `: ${r.value}` : ""}`;
    }
    return `${label(r)} stopped ${ago}${r.note !== undefined ? `: ${r.note}` : ""}`;
  });
  return `routines:\n${lines.join("\n")}`;
}

/** How an ended routine's state reads after "it": `it returned`, `it was stopped`. */
function endedWords(state: RoutineRow["state"]): string {
  return state === "stopped" || state === "interrupted" ? `was ${state}` : state;
}

interface RegistryFile {
  /** The loaded version, or null. */
  deploy: number | null;
  /** The version the last load was tried at. */
  attempted: number;
  routines: RoutineRow[];
}

export class ProgramHost {
  readonly workspace: Workspace;
  private readonly rows = new Map<string, RoutineRow>();
  private loadedVersion: number | null = null;
  private attempted = 0;
  /** main.ts's import graph as of the last load attempt. */
  private lastGraph: Map<string, string | null>;
  private readonly facts: ProgramFact[] = [];
  private factsDropped = 0;
  private readonly repeats = new Map<string, { count: number; ts: number }>();
  private consoleLines: ProgramLogLine[] = [];
  private consoleTotal = 0;
  /** Routine errors and values the model has been shown (`routineDetailKey`); not persisted, so a new process shows them whole. */
  private readonly shown = new Set<string>();
  /** Saves, loads and routine calls, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  /** The beat in flight, if any: a second caller awaits it rather than missing what it carries. */
  private beating: Promise<void> | null = null;
  /** Set as the beat kills a blocked child: the restart that follows starts no routine. */
  private blame = false;
  /** Whether the child now running has had the program brought back. */
  private stopped = false;

  constructor(
    private readonly opts: ProgramOptions,
    private readonly port: ProgramPort,
  ) {
    this.workspace = opts.workspace;
    const saved = this.readRegistry();
    if (saved !== null) {
      this.loadedVersion = saved.deploy;
      this.attempted = saved.attempted;
      for (const r of saved.routines) this.rows.set(rowKey(r.name, r.character), r);
    }
    this.lastGraph = this.attempted > 0 ? this.workspace.graphAt(this.attempted) : new Map([[MAIN_PATH, null]]);
  }

  private get registryPath(): string {
    return join(this.workspace.dir, "registry.json");
  }

  private readRegistry(): RegistryFile | null {
    try {
      if (!existsSync(this.registryPath)) return null;
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as Partial<RegistryFile>;
      return { deploy: typeof parsed.deploy === "number" ? parsed.deploy : null, attempted: typeof parsed.attempted === "number" ? parsed.attempted : 0, routines: Array.isArray(parsed.routines) ? parsed.routines : [] };
    } catch {
      return null;
    }
  }

  private persist(): void {
    const file: RegistryFile = { deploy: this.loadedVersion, attempted: this.attempted, routines: [...this.rows.values()] };
    try {
      const tmp = `${this.registryPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(tmp, this.registryPath);
    } catch {
      // A registry that could not be written costs a resume its routines, not this run its sandbox.
    }
  }

  // ------------------------------------------------------------------ reads

  /** The loaded version, or null with nothing loaded. */
  get deploy(): number | null {
    return this.loadedVersion;
  }

  /** Every routine as it stands. */
  routines(): RoutineRow[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  /** The routine lines a tool result ends with; what they show of errors and values counts as shown from then on. */
  routineLines(): string {
    const rows = this.routines();
    const text = renderRoutines(rows, this.port.now(), this.shown);
    this.markShown(rows);
    return text;
  }

  /**
   * The errors and returned values the model has been shown, by
   * `routineDetailKey`: a harness that renders routine lines of its own (a
   * wake) renders with this, and marks what it showed with `markShown` when
   * the text stays in the model's conversation.
   */
  shownDetails(): ReadonlySet<string> {
    return new Set(this.shown);
  }

  /** These rows' errors and values are in the model's conversation now. Only the current runs' are kept. */
  markShown(rows: readonly RoutineRow[]): void {
    for (const r of rows) {
      const k = routineDetailKey(r);
      if (k !== undefined) this.shown.add(k);
    }
    const current = new Set<string>();
    for (const r of this.rows.values()) {
      const k = routineDetailKey(r);
      if (k !== undefined) current.add(k);
    }
    for (const k of this.shown) if (!current.has(k)) this.shown.delete(k);
  }

  /** The conversation lost what it held (a compaction, a trim, another thread): every error and value is shown whole again. */
  forgetShown(): void {
    this.shown.clear();
  }

  /** Everything since the last drain, and the routines as they stand. */
  drainFacts(): ProgramFacts {
    const out: ProgramFacts = {
      deploy: this.loadedVersion,
      routines: this.routines(),
      facts: this.facts.splice(0, this.facts.length),
      factsDropped: this.factsDropped,
      repeats: [...this.repeats.entries()].map(([signature, r]) => ({ signature, count: r.count, ts: r.ts })),
      console: { lines: this.consoleLines, total: this.consoleTotal },
    };
    this.factsDropped = 0;
    this.repeats.clear();
    this.consoleLines = [];
    this.consoleTotal = 0;
    return out;
  }

  private fact(fact: ProgramFact): void {
    this.facts.push(fact);
    if (this.facts.length > FACTS_KEEP) this.factsDropped += this.facts.splice(0, this.facts.length - FACTS_KEEP).length;
    try {
      this.opts.onFact?.(fact);
    } catch {
      // A harness that failed to take a fact must not take the sandbox's IPC with it.
    }
  }

  // ------------------------------------------------------------------ files

  readFile(path: unknown, range?: LineRange): ProgramAnswer {
    const r = this.workspace.read(path, range);
    return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.error };
  }

  writeFile(path: unknown, content: unknown, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramAnswer> {
    return this.save(path, () => this.workspace.write(path, content), link);
  }

  editFile(path: unknown, oldText: unknown, newText: unknown, replaceAll: unknown, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramAnswer> {
    return this.save(path, () => this.workspace.edit(path, oldText, newText, replaceAll), link);
  }

  deleteFile(path: unknown, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramAnswer> {
    return this.save(path, () => this.workspace.delete(path), link);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A file operation, and what it did to the program when it changed a file. */
  private save(path: unknown, op: () => WorkspaceResult, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramAnswer> {
    return this.serial(async () => {
      const res = op();
      if (!res.ok) return { ok: false, text: res.error };
      const resolved = this.workspace.resolve(path);
      if (!resolved.ok || !isImportable(resolved.rel)) return { ok: true, text: res.text };
      const graph = this.workspace.graph();
      // A new version either way: a snippet imports the files as they are now.
      const version = this.workspace.snapshot();
      if (this.port.running()) this.port.tell({ t: "program_version", version });
      if (sameImportGraph(graph, this.lastGraph)) return { ok: true, text: res.text };
      this.lastGraph = graph;
      const loaded = await this.load(version, "save", link);
      return { ok: loaded.ok, text: `${res.text}\n${loaded.text}` };
    });
  }

  private keeps(): string {
    return this.loadedVersion === null ? "nothing is loaded" : `deploy ${this.loadedVersion} keeps running`;
  }

  /** Load version `version` as the program and say what happened. */
  private async load(version: number, by: "save" | "restart", link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramAnswer> {
    if (by === "save") this.attempted = version;
    let answer: ProgramLoadAnswer;
    try {
      if (by === "save") await this.port.start();
      answer = (await this.port.request({ t: "program_load", version }, LOAD_TIMEOUT_MS + 4_000, link)) as ProgramLoadAnswer;
    } catch (err) {
      answer = { ok: false, error: this.port.isTimeout(err) ? "the sandbox did not answer the load" : `the sandbox went away during the load (${err instanceof Error ? err.message : String(err)})` };
    }
    const ts = this.port.now();
    if (!answer.ok) {
      this.persist();
      this.fact({ kind: "load_failed", ts, error: answer.error, running: this.loadedVersion, by });
      return { ok: false, text: `load failed, ${this.keeps()}: ${answer.error}` };
    }
    this.loadedVersion = answer.version;
    for (const r of answer.restarted) this.rows.set(rowKey(r.name, r.character), { ...r });
    for (const r of answer.dropped) this.rows.set(rowKey(r.name, r.character), { ...r, note: `${MAIN_PATH} no longer exports it` });
    this.persist();
    this.fact({ kind: "loaded", ts, deploy: answer.version, routines: answer.routines, restarted: answer.restarted.map(label), dropped: answer.dropped.map(label), by });
    const parts = [`loaded: deploy ${answer.version}`, answer.routines.length > 0 ? `routines: ${answer.routines.join(", ")}` : `${MAIN_PATH} exports no async function, so it has no routine`];
    // The restart waits out the settle window, and a load inside it restarts the routine in its place: one restart, on the last load's code.
    if (answer.restarted.length > 0) parts.push(`restarts from the top ${durationWords(RESTART_SETTLE_MS)} after the last load: ${answer.restarted.map(label).join(", ")}`);
    if (answer.dropped.length > 0) parts.push(`stopped, no longer exported: ${answer.dropped.map(label).join(", ")}`);
    return { ok: true, text: parts.join(" · ") };
  }

  // --------------------------------------------------------------- routines

  startRoutine(o: { name: string; args?: unknown; character?: string | undefined }, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramAnswer> {
    return this.serial(async () => {
      let answer: RoutineAnswer;
      try {
        await this.port.start();
        answer = (await this.port.request(
          { t: "routine_start", name: o.name, ...(o.args !== undefined ? { args: o.args } : {}), ...(o.character !== undefined ? { seat: o.character } : {}) },
          ROUTINE_ANSWER_MS,
          link,
        )) as RoutineAnswer;
      } catch (err) {
        return { ok: false, text: `start_routine failed: ${err instanceof Error ? err.message : String(err)}\n${this.routineLines()}` };
      }
      if (!answer.ok) return { ok: false, text: `${answer.error}\n${this.routineLines()}` };
      // Already running the code just saved: a save restarted it, with these arguments.
      if (answer.restartedBy !== undefined) {
        const r = answer.routine;
        return { ok: true, text: `${label(r)} is running: your save restarted it from the top on deploy ${answer.restartedBy}, ${durationWords(this.port.now() - r.startedAt)} ago, with these arguments\n${this.routineLines()}` };
      }
      this.rows.set(rowKey(answer.routine.name, answer.routine.character), { ...answer.routine });
      this.persist();
      this.ensureBeat();
      return { ok: true, text: `started ${label(answer.routine)} on deploy ${answer.routine.deploy}\n${this.routineLines()}` };
    });
  }

  stopRoutine(o: { name: string; character?: string | undefined }): Promise<ProgramAnswer> {
    return this.serial(async () => {
      const row = this.rows.get(rowKey(o.name, o.character));
      // With no child there is nothing running to stop: the row is what is left of one.
      if (!this.port.running()) {
        if (row === undefined) return { ok: false, text: `${label(o)} is not running.\n${this.routineLines()}` };
        if (row.state !== "running") return { ok: true, text: `${this.alreadyEnded(row)}\n${this.routineLines()}` };
        this.rows.set(rowKey(o.name, o.character), { ...row, state: "stopped", endedAt: this.port.now() });
        this.persist();
        return { ok: true, text: `stopped ${label(o)}\n${this.routineLines()}` };
      }
      let answer: RoutineAnswer;
      try {
        answer = (await this.port.request({ t: "routine_stop", name: o.name, ...(o.character !== undefined ? { seat: o.character } : {}) }, ROUTINE_ANSWER_MS)) as RoutineAnswer;
      } catch (err) {
        return { ok: false, text: `stop_routine failed: ${err instanceof Error ? err.message : String(err)}\n${this.routineLines()}` };
      }
      if (!answer.ok) return { ok: false, text: `${answer.error}\n${this.routineLines()}` };
      // Nothing to stop: a true answer about the run that ended, not a failure.
      if (answer.ended === true) return { ok: true, text: `${this.alreadyEnded(answer.routine)}\n${this.routineLines()}` };
      this.rows.set(rowKey(answer.routine.name, answer.routine.character), { ...answer.routine });
      this.persist();
      return { ok: true, text: `stopped ${label(answer.routine)}\n${this.routineLines()}` };
    });
  }

  /** What a stop of a routine that had already ended answers: how and when it ended. */
  private alreadyEnded(r: RoutineRow): string {
    return `${label(r)} had already ended: it ${endedWords(r.state)} ${durationWords(this.port.now() - (r.endedAt ?? this.port.now()))} ago.`;
  }

  // -------------------------------------------------------- from the child

  /** What a starting child is told before it is ready: the saved memory, and the newest version of the files. */
  initMessage(): { t: "program_init"; memory: string | null; version: number } {
    return { t: "program_init", memory: this.workspace.readMemory(), version: this.workspace.version };
  }

  /** The child's facts, as they arrive. */
  onEvents(events: readonly ProgramEvent[]): void {
    let changed = false;
    for (const e of events) {
      if (e.kind === "ended") {
        // A row is replaced only by the run it describes: a late end of a run
        // that was already restarted must not overwrite its successor.
        const k = rowKey(e.routine.name, e.routine.character);
        const row = this.rows.get(k);
        if (row === undefined || row.startedAt === e.routine.startedAt) {
          this.rows.set(k, { ...e.routine });
          changed = true;
        }
      }
      this.fact(e);
    }
    if (changed) this.persist();
  }

  /** The child's memory changed: save it. A refusal is an error fact, and the last save stays. */
  onMemory(json: string): void {
    const res = this.workspace.writeMemory(json);
    if (res.ok) return;
    this.fact({ kind: "error", ts: this.port.now(), deploy: this.loadedVersion ?? 0, error: { name: "MemoryError", text: res.error, frames: [], signature: "memory|refused" }, fresh: true });
  }

  /**
   * Bring the program back in a child that has just started: load the version
   * that was loaded and start what was running from the top, unless the
   * program is to blame for the restart. Called by the host once the child is
   * ready and its seats are reattached; never throws.
   */
  async resume(): Promise<void> {
    const blamed = this.blame;
    this.blame = false;
    const wasRunning = [...this.rows.values()].filter((r) => r.state === "running");
    if (this.loadedVersion === null) return;
    const ts = this.port.now();
    const interrupt = (r: RoutineRow, note: string): RoutineRow => {
      const row: RoutineRow = { ...r, state: "interrupted", endedAt: ts, note };
      this.rows.set(rowKey(r.name, r.character), row);
      return row;
    };
    const loaded = await this.load(this.loadedVersion, "restart");
    const restarted: RoutineRow[] = [];
    const interrupted: RoutineRow[] = [];
    for (const r of wasRunning) {
      if (!loaded.ok) {
        interrupted.push(interrupt(r, "the program did not load again"));
        continue;
      }
      if (blamed) {
        interrupted.push(interrupt(r, "the sandbox was restarted for a blocked event loop while no snippet was running"));
        continue;
      }
      if (!this.port.attached(r.character)) {
        interrupted.push(interrupt(r, `${r.character} is not attached`));
        continue;
      }
      try {
        const answer = (await this.port.request(
          { t: "routine_start", name: r.name, ...(r.args !== undefined ? { args: r.args } : {}), ...(r.character !== undefined ? { seat: r.character } : {}), resumed: true },
          ROUTINE_RESUME_MS,
        )) as RoutineAnswer;
        if (!answer.ok) {
          interrupted.push(interrupt(r, answer.error));
          continue;
        }
        this.rows.set(rowKey(r.name, r.character), { ...answer.routine });
        restarted.push({ ...answer.routine });
      } catch (err) {
        interrupted.push(interrupt(r, err instanceof Error ? err.message : String(err)));
      }
    }
    this.persist();
    if (wasRunning.length > 0 || blamed) this.fact({ kind: "restart", ts, blamed, restarted, interrupted });
    this.ensureBeat();
  }

  // ------------------------------------------------------------------- beat

  private anyRunning(): boolean {
    for (const r of this.rows.values()) if (r.state === "running") return true;
    return false;
  }

  /** Run the beat while a routine runs. */
  ensureBeat(): void {
    if (this.beatTimer !== undefined || this.stopped) return;
    this.beatTimer = setInterval(() => void this.beat(), this.opts.beatMs ?? PROGRAM_BEAT_MS);
    this.beatTimer.unref?.();
  }

  /**
   * One beat: ask the child, fold its answer into the registry and the
   * ledger. An unanswered beat with no snippet in flight is a blocked event
   * loop nobody else will notice, and the program's to answer for; a child
   * that is gone while routines should be running is started. A caller that
   * arrives while a beat is in flight is handed that beat, so what it folds
   * is there when the caller reads. Never throws.
   */
  beat(): Promise<void> {
    if (this.beating !== null) return this.beating;
    if (this.stopped) return Promise.resolve();
    const p = this.beatOnce().finally(() => {
      if (this.beating === p) this.beating = null;
    });
    this.beating = p;
    return p;
  }

  private async beatOnce(): Promise<void> {
    try {
      if (!this.port.running()) {
        // The child died with routines running and nothing else is looking.
        if (this.anyRunning()) await this.port.start();
        return;
      }
      let beat: ProgramBeat;
      try {
        beat = (await this.port.request({ t: "rpc", method: "program_beat", params: {} }, this.opts.beatGraceMs ?? PROGRAM_BEAT_GRACE_MS)) as ProgramBeat;
      } catch (err) {
        if (this.port.isTimeout(err) && this.anyRunning() && this.port.snippetsInFlight() === 0 && this.port.running()) {
          this.blame = true;
          await this.port.restartStalled();
        }
        return;
      }
      this.fold(beat);
    } catch {
      // The next beat tries again.
    }
  }

  private fold(beat: ProgramBeat): void {
    let changed = false;
    for (const r of beat.routines) {
      const k = rowKey(r.name, r.character);
      const row = this.rows.get(k);
      if (row === undefined || row.startedAt !== r.startedAt) continue;
      if (row.lastAction?.ts !== r.lastAction?.ts || row.state !== r.state) {
        this.rows.set(k, { ...row, ...r });
        changed = true;
      }
    }
    for (const r of beat.repeats) {
      const prev = this.repeats.get(r.signature);
      if (prev === undefined) this.repeats.set(r.signature, { count: r.count, ts: r.ts });
      else {
        prev.count += r.count;
        prev.ts = Math.max(prev.ts, r.ts);
      }
    }
    this.consoleTotal += beat.console.dropped + beat.console.lines.reduce((n, l) => n + l.count, 0);
    this.consoleLines.push(...beat.console.lines);
    if (this.consoleLines.length > CONSOLE_KEEP) this.consoleLines.splice(0, this.consoleLines.length - CONSOLE_KEEP);
    if (changed) this.persist();
  }

  /** The host is stopping: no more beats, and the registry as it stands is what a resume finds. */
  stop(): void {
    this.stopped = true;
    if (this.beatTimer !== undefined) clearInterval(this.beatTimer);
    this.beatTimer = undefined;
    this.persist();
  }
}
