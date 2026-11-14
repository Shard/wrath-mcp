/**
 * The program runtime, in the sandbox child of a host that asked for one
 * (`SandboxHostOptions.program`). The model keeps its code in a small file
 * workspace rooted at `main.ts`; every async function `main.ts` exports is
 * a routine, started and stopped by name, and this is what runs them.
 *
 *  - Versions. The host keeps each version of the files in a directory of
 *    its own (`workspace.ts`) and names the one to load. `main.ts` is
 *    imported by its plain path there, so a load is a fresh module graph and
 *    the code already running never changes under itself. A load that fails
 *    (a syntax error, a missing import) changes nothing.
 *  - Routines. A routine runs once, until it returns, throws or is stopped;
 *    there is no tick and no time limit. It runs in an async context of its
 *    own, which carries its `signal`, its character and its owner
 *    (`owners.ts`): when it ends, by any road, its signal is aborted and the
 *    timers and listeners it started are removed. One run per name and
 *    character at a time.
 *  - A load restarts. The routines running when a load succeeds are stopped
 *    and started again from the top on the new version, with the arguments
 *    they had, after a settle window (`RESTART_SETTLE_MS`) in which a
 *    second load restarts them in the first one's place; one whose export is
 *    gone is stopped. A start of a routine a save restarted, with the same
 *    arguments, is that run: the answer says so rather than refusing.
 *  - An ended routine cannot act. Its pending waits reject as its signal
 *    aborts, and it has a moment to unwind (`UNWIND_GRACE_MS`); after that a
 *    `sleep` or a dispatch from its context rejects, slowly, so a loop that
 *    swallows every error neither acts beside its replacement nor spins.
 *  - Signatures. An error is the same error when its routine, name and first
 *    frame in the model's files agree; a refusal when its routine, character,
 *    helper and status do. The first of each since the last load is pushed
 *    to the host at once, marked fresh; repeats are counted and ride the
 *    next beat. Nothing is ever disabled, held or backed off for repeating.
 *  - Memory. One plain-JSON object, the ambient `memory`, serialized once a
 *    second and after every snippet and routine; a change is sent to the
 *    host, which alone writes memory.json.
 *
 * Free of module-level side effects and of the child's internals: everything
 * it needs arrives through `ProgramDeps`, so importing it changes nothing in
 * a child that hosts no program.
 */

import { statSync } from "node:fs";
import { HarnessStop, isHarnessStop, Owner, type Ownership } from "./owners";
import { MAIN_PATH, MEMORY_MAX_CHARS, resolveWorkspaceImport } from "./rewrite";
import type { ChildToHost, LogEntry, MoveOwner, ProgramBeat, ProgramErrorNote, ProgramEvent, ProgramLoadAnswer, ProgramLogLine, RoutineAnswer, RoutineNote } from "./ipc";

/** How long an ended routine may still dispatch: long enough to unwind (a `finally` that stops an attack), no longer. */
export const UNWIND_GRACE_MS = 250;
/**
 * How long a routine a load restarted waits before it runs again. A load
 * that follows inside it (the second of two saves sent together) restarts
 * the routine in its place, so the first restart never runs: saves sent
 * together restart a routine once. At least `UNWIND_GRACE_MS`, so the stop
 * the old run's abort sends cannot land on the new run's first move.
 */
export const RESTART_SETTLE_MS = 1_000;
/** How slowly a call from an ended context rejects after that, so a loop that swallows the rejection yields. */
export const ENDED_REJECT_DELAY_MS = 100;
/** How long a load waits for `main.ts` to finish importing. */
export const LOAD_TIMEOUT_MS = 8_000;
/** How many routine console lines are kept between two beats. */
export const PROGRAM_LOG_KEEP = 200;
/** How many frames of the model's files an error shows. */
export const STACK_FRAMES_SHOWN = 4;
/** A `wake(reason)` reason and a returned value are cut to this many characters. */
const SHORT_TEXT_MAX_CHARS = 200;
/** Distinct signatures remembered per load; past it a new one is counted, not pushed. */
const SIGNATURES_MAX = 500;

/** A routine was stopped by `stop_routine`: its signal is aborted with this. */
export class RoutineStopped extends HarnessStop {
  override name = "RoutineStopped";
}

/** A routine ended by itself; what it left pending is aborted with this. */
export class RoutineEnded extends HarnessStop {
  override name = "RoutineEnded";
}

/** A load replaced the code a routine was running: its signal is aborted with this. */
export class RoutineRestarted extends HarnessStop {
  override name = "RoutineRestarted";
}

/** One run of a routine, as the child holds it. `S` is the child's seat. */
export interface RoutineRun<S = unknown> {
  readonly note: RoutineNote;
  /** The id its dispatches are logged under: the host's id for the call that started it. */
  readonly evalId: number;
  readonly controller: AbortController;
  readonly owner: Owner;
  /** The character's seat, at fan-out above 1; null for none. */
  readonly seat: S | null;
  ended: boolean;
  /** When it ended, on the child's clock. */
  endedAt: number;
  /** Its call-site id in the SDK's hint tally, once it made a call. */
  site?: number;
  /** The deploy whose load restarted it from the top (a save), when that is how this run began. */
  restartedBy?: number;
}

export interface ProgramDeps<S> {
  /** The directory the versions live in: version n is `<root>/<n>/`. */
  root: string;
  send(msg: ChildToHost): void;
  /** Run `fn` in a routine's async context. */
  run<T>(run: RoutineRun<S>, fn: () => T): T;
  ownership: Ownership;
  /** An error as a snippet's result renders it. */
  renderError(err: unknown): string;
  /** The seat of a character: undefined for a name nobody holds. Only asked at fan-out above 1. */
  seat(name: string): S | undefined;
  /** Whether characters are named at all (fan-out above 1). */
  multi: boolean;
  /** Reopen the stream of a routine's character before a resumed start. */
  connect(seat: S | null): Promise<void>;
}

/** A duration as a routine line says it: `3s`, `12m`, `1h05m`. */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const key = (name: string, character: string | undefined): string => `${character ?? ""}\u0000${name}`;

/** Whether an export is a routine: an async function (`export async function`, or an async arrow). */
export function isRoutine(value: unknown): boolean {
  return typeof value === "function" && (value as { constructor?: { name?: unknown } }).constructor?.name === "AsyncFunction";
}

/** Two routine arguments are the same when their JSON is (absent equals absent). */
function sameArgs(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function short(text: string): string {
  return text.length > SHORT_TEXT_MAX_CHARS ? `${text.slice(0, SHORT_TEXT_MAX_CHARS - 1)}…` : text;
}

export class ProgramRuntime<S> {
  /** The newest version of the files: what a snippet imports from. */
  version = 0;
  private loaded: { version: number; module: Record<string, unknown>; owner: Owner; routines: string[] } | null = null;
  private loadError: string | undefined;
  private loading: { owner: Owner; marker: string } | undefined;
  /** The latest run per name and character, ended or not. */
  private readonly runs = new Map<string, RoutineRun<S>>();
  private memoryValue: Record<string, unknown> = {};
  private memorySaved = "{}";
  /** Signatures seen since the last load. */
  private readonly seen = new Set<string>();
  private readonly repeats = new Map<string, { count: number; ts: number }>();
  private readonly log: ProgramLogLine[] = [];
  private logDropped = 0;

  constructor(private readonly deps: ProgramDeps<S>) {}

  // ------------------------------------------------------------------ files

  /** Where version `n` of the files lives. */
  private dir(n: number): string {
    return `${this.deps.root}/${n}`;
  }

  /** The directory a snippet's imports resolve against, or undefined before the first version. */
  get importRoot(): string | undefined {
    return this.version > 0 ? this.dir(this.version) : undefined;
  }

  /** A snippet's string-literal `import("./x")`, resolved now against the newest version (`rewrite.ts`). */
  importModule(specifier: string, options?: ImportCallOptions): Promise<unknown> {
    const path = specifier.startsWith(`${this.deps.root}/`) ? specifier : (resolveWorkspaceImport(specifier, this.importRoot)?.abs ?? specifier);
    return import(path, options);
  }

  /**
   * Text as the model should read it: its files by their workspace paths,
   * without the version directory only the loader cares about.
   */
  relative(text: string): string {
    return text.split(`${this.deps.root}/`).join("\u0001").replace(/\u0001\d+\//g, "").split("\u0001").join("");
  }

  /**
   * The workspace file a path names, when a file read failed on it: the
   * path's own text or any tail of it after a `/` (`main.ts`, `./main.ts`,
   * `/workspace/lib/combat.ts`) that is a file of the newest version.
   */
  workspaceFileOf(path: string): string | undefined {
    const root = this.importRoot;
    if (root === undefined) return undefined;
    const parts = path.replace(/\\/g, "/").split("/");
    for (let i = 0; i < parts.length; i++) {
      const rel = parts.slice(i).filter((p) => p !== "" && p !== ".").join("/");
      if (rel.length === 0 || rel.split("/").includes("..")) continue;
      if (isFile(`${root}/${rel}`)) return rel;
    }
    return undefined;
  }

  /**
   * The note a failed read of a workspace file ends with (a snippet's
   * `Bun.file("main.ts")` or `readFileSync`, which look on the sandbox's own
   * disk): where the file is read instead. Undefined for any other error.
   */
  missingFileNote(err: unknown): string | undefined {
    const e = err as { code?: unknown; path?: unknown } | null;
    if (e === null || typeof e !== "object" || e.code !== "ENOENT" || typeof e.path !== "string") return undefined;
    const rel = this.workspaceFileOf(e.path);
    if (rel === undefined) return undefined;
    return ` — ${rel} is one of your workspace files, which are not on the sandbox's disk: read_file({ path: "${rel}" }) returns it, and a snippet imports its exports by relative path.`;
  }

  /** The owner of a module's top-level code while a load's import is in flight (`OwnershipOptions.fallback`). */
  loadingOwner(): { owner: Owner; marker: string } | undefined {
    return this.loading;
  }

  // ------------------------------------------------------------------ loads

  init(memory: string | null, version: number): void {
    this.version = version;
    if (memory === null) return;
    try {
      const parsed: unknown = JSON.parse(memory);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.memoryValue = parsed as Record<string, unknown>;
        this.memorySaved = memory;
      }
    } catch {
      // A memory.json that does not parse is not loaded; the next save replaces it.
    }
  }

  /** The loaded version, or null. */
  get deploy(): number | null {
    return this.loaded?.version ?? null;
  }

  async load(version: number, evalId: number): Promise<ProgramLoadAnswer> {
    if (version > this.version) this.version = version;
    const dir = this.dir(version);
    const path = `${dir}/${MAIN_PATH}`;
    if (!isFile(path)) return this.loadFailed(`${MAIN_PATH} is not in the workspace`);
    const owner = new Owner(`deploy ${version}`);
    const loading = { owner, marker: `${dir}/` };
    this.loading = loading;
    let module: Record<string, unknown>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const imported = import(path) as Promise<Record<string, unknown>>;
      // A load that outlives the wait is abandoned whole: whatever its top level started goes.
      imported.then(
        () => {},
        () => {},
      );
      module = await Promise.race([
        imported,
        new Promise<never>((_, reject) => {
          timer = this.deps.ownership.real.setTimeout(
            () => reject(new Error(`${MAIN_PATH} did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s; a top-level await that never settles holds a load open`)),
            LOAD_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      this.deps.ownership.close(owner);
      return this.loadFailed(this.relative(this.renderLoadError(err)));
    } finally {
      this.deps.ownership.real.clearTimeout(timer);
      if (this.loading === loading) this.loading = undefined;
    }
    const routines = Object.keys(module).filter((k) => k !== "default" && isRoutine(module[k]));
    const old = this.loaded;
    this.loaded = { version, module, owner, routines };
    this.loadError = undefined;
    this.seen.clear();
    this.repeats.clear();
    const restarted: RoutineNote[] = [];
    const dropped: RoutineNote[] = [];
    const now = Date.now();
    for (const run of [...this.runs.values()]) {
      if (run.ended) continue;
      this.end(run, "stopped", new RoutineRestarted("the program was loaded again; this routine was restarted on the new code"), now);
      if (!routines.includes(run.note.name)) {
        dropped.push({ ...run.note });
        continue;
      }
      // After the settle window: past the old run's moment to unwind, and long
      // enough that a second save sent with this one restarts it in this
      // run's place, before this run has started (`RESTART_SETTLE_MS`).
      const next = this.launch(run.note.name, run.note.args, run.note.character, run.seat, evalId, RESTART_SETTLE_MS);
      next.restartedBy = version;
      restarted.push({ ...next.note });
    }
    if (old !== null) this.deps.ownership.close(old.owner);
    return { ok: true, version, routines, restarted, dropped };
  }

  /**
   * A load's error. A file that does not parse arrives as the transpiler's
   * diagnostics, each with its own file and line; anything else (a missing
   * import, a throw at a module's top level) renders as a snippet's error
   * does.
   */
  private renderLoadError(err: unknown): string {
    const diagnostic = (e: unknown): string | undefined => {
      const d = e as { message?: unknown; position?: { file?: unknown; line?: unknown; column?: unknown; lineText?: unknown } | null } | null;
      const pos = d?.position;
      if (pos == null || typeof pos.line !== "number" || typeof pos.file !== "string") return undefined;
      const col = typeof pos.column === "number" ? `:${pos.column}` : "";
      const text = typeof pos.lineText === "string" && pos.lineText.trim().length > 0 ? ` — ${pos.lineText.trim()}` : "";
      return `${typeof d?.message === "string" ? d.message : "parse error"} at ${pos.file}:${pos.line}${col}${text}`;
    };
    const subs = err instanceof AggregateError ? err.errors.map(diagnostic) : [diagnostic(err)];
    if (subs.length > 0 && subs.every((s) => s !== undefined)) return subs.join("\n");
    const frame = err instanceof Error ? this.frames(err.stack)[0] : undefined;
    return `${this.deps.renderError(err)}${frame !== undefined ? ` ${frame}` : ""}`;
  }

  private loadFailed(error: string): ProgramLoadAnswer {
    if (this.loaded === null) this.loadError = error;
    return { ok: false, error };
  }

  // --------------------------------------------------------------- routines

  private label(name: string, character: string | undefined): string {
    return character === undefined ? name : `${name} (${character})`;
  }

  async start(msg: { id: number; name: string; args?: unknown; seat?: string; resumed?: boolean }): Promise<RoutineAnswer> {
    const loaded = this.loaded;
    if (loaded === null) {
      return {
        ok: false,
        error:
          this.loadError !== undefined
            ? `${MAIN_PATH} did not load, so there is no routine to start: ${this.loadError}`
            : `there is no ${MAIN_PATH} yet: write it with write_file and export an async function from it`,
      };
    }
    const fn = msg.name === "default" ? undefined : loaded.module[msg.name];
    if (!isRoutine(fn)) {
      const has = loaded.routines.length > 0 ? `Its routines: ${loaded.routines.join(", ")}.` : "It exports no async function.";
      const what =
        typeof fn === "function" ? `${MAIN_PATH} exports ${msg.name}, but it is not an async function, so it is not a routine.` : `${MAIN_PATH} exports no function named ${msg.name}.`;
      return { ok: false, error: `${what} ${has}` };
    }
    let seat: S | null = null;
    if (msg.seat !== undefined) {
      const found = this.deps.seat(msg.seat);
      if (found === undefined) return { ok: false, error: `unknown character: ${msg.seat}` };
      seat = found;
    }
    const existing = this.runs.get(key(msg.name, msg.seat));
    if (existing !== undefined && !existing.ended) {
      // A save restarted it from the top: it already runs the code just saved.
      if (existing.restartedBy !== undefined && msg.resumed !== true) {
        if (sameArgs(msg.args, existing.note.args)) return { ok: true, routine: { ...existing.note }, restartedBy: existing.restartedBy };
        return {
          ok: false,
          error: `${this.label(msg.name, msg.seat)} is already running: your save restarted it from the top ${durationWords(Date.now() - existing.note.startedAt)} ago on deploy ${existing.restartedBy}, with the arguments it had. Stop it first with stop_routine to start it with these.`,
        };
      }
      return {
        ok: false,
        error: `${this.label(msg.name, msg.seat)} is already running: started ${durationWords(Date.now() - existing.note.startedAt)} ago on deploy ${existing.note.deploy}. Stop it first with stop_routine to start it again.`,
      };
    }
    if (msg.resumed === true) {
      try {
        await this.deps.connect(seat);
      } catch (err) {
        return { ok: false, error: `the event stream could not be reopened: ${this.deps.renderError(err)}` };
      }
      // A load or a start may have landed while the stream reopened.
      const raced = this.runs.get(key(msg.name, msg.seat));
      if (this.loaded !== loaded || (raced !== undefined && !raced.ended)) return { ok: false, error: `${this.label(msg.name, msg.seat)} was started meanwhile` };
    }
    return { ok: true, routine: { ...this.launch(msg.name, msg.args, msg.seat, seat, msg.id, 0).note } };
  }

  private launch(name: string, args: unknown, character: string | undefined, seat: S | null, evalId: number, delayMs: number): RoutineRun<S> {
    const loaded = this.loaded!;
    const note: RoutineNote = { name, deploy: loaded.version, startedAt: Date.now(), state: "running" };
    if (character !== undefined) note.character = character;
    if (args !== undefined) note.args = args;
    const run: RoutineRun<S> = { note, evalId, controller: new AbortController(), owner: new Owner(`routine ${name}`), seat, ended: false, endedAt: 0 };
    this.runs.set(key(name, character), run);
    const fn = loaded.module[name] as (args: unknown) => unknown;
    const go = (): void => {
      if (run.ended) return;
      // An async wrapper, so a routine that throws before its first await ends like any other.
      const settled = this.deps.run(run, async () => fn(args));
      settled.then(
        (value) => this.finish(run, value, undefined),
        (err: unknown) => this.finish(run, undefined, { err }),
      );
    };
    if (delayMs > 0) this.deps.ownership.real.setTimeout(go, delayMs);
    else go();
    return run;
  }

  /** A routine's function settled: it returned, or threw. Nothing here for one already stopped. */
  private finish(run: RoutineRun<S>, value: unknown, thrown: { err: unknown } | undefined): void {
    if (run.ended) return;
    const now = Date.now();
    if (thrown === undefined) {
      if (value !== undefined) run.note.value = short(Bun.inspect(value, { depth: 2 }));
      this.end(run, "returned", new RoutineEnded("the routine returned; what it left pending was stopped"), now);
      this.push({ kind: "ended", ts: now, routine: { ...run.note } });
      return;
    }
    // Its own abort of its own wait is a throw like any other; a harness stop never reaches here.
    const error = this.errorNote(run.note.name, thrown.err);
    run.note.error = error;
    this.end(run, "threw", new RoutineEnded("the routine threw; what it left pending was stopped"), now);
    const fresh = this.fresh(error.signature, now);
    this.push({ kind: "ended", ts: now, routine: { ...run.note }, ...(fresh ? { fresh: true } : {}) });
  }

  /** End a run: mark it, abort its signal so its pending waits settle, and take back what it started. */
  private end(run: RoutineRun<S>, state: RoutineNote["state"], reason: HarnessStop, now: number): void {
    run.ended = true;
    run.endedAt = now;
    run.note.state = state;
    run.note.endedAt = now;
    if (!run.controller.signal.aborted) run.controller.abort(reason);
    this.deps.ownership.close(run.owner);
    this.saveMemory();
  }

  stop(name: string, character: string | undefined): RoutineAnswer {
    const run = this.runs.get(key(name, character));
    // A run that already ended is the answer, not a refusal: the host says how it ended.
    if (run !== undefined && run.ended) return { ok: true, routine: { ...run.note }, ended: true };
    if (run === undefined) {
      const running = [...this.runs.values()].filter((r) => !r.ended).map((r) => this.label(r.note.name, r.note.character));
      return { ok: false, error: `${this.label(name, character)} is not running. ${running.length > 0 ? `Running: ${running.join(", ")}.` : "No routine is running."}` };
    }
    this.end(run, "stopped", new RoutineStopped("the routine was stopped (stop_routine); pending waits cancelled"), Date.now());
    return { ok: true, routine: { ...run.note } };
  }

  /**
   * Whether a call from this run's context is refused: it ended, and its
   * moment to unwind is over. The caller rejects it after
   * `ENDED_REJECT_DELAY_MS`.
   */
  refused(run: RoutineRun<S>): boolean {
    return run.ended && Date.now() - run.endedAt > UNWIND_GRACE_MS;
  }

  /** The last action a routine dispatched: the registry's "last action 3s ago". */
  noteAction(run: RoutineRun<S>, action: string, ts: number): void {
    run.note.lastAction = { action, ts };
  }

  // ------------------------------------------------------ errors, refusals

  /** Whether `signature` is new since the last load; a repeat is counted for the next beat. */
  private fresh(signature: string, ts: number): boolean {
    if (!this.seen.has(signature)) {
      if (this.seen.size < SIGNATURES_MAX) {
        this.seen.add(signature);
        return true;
      }
    }
    const r = this.repeats.get(signature);
    if (r === undefined) this.repeats.set(signature, { count: 1, ts });
    else {
      r.count++;
      r.ts = ts;
    }
    return false;
  }

  /** The frames of `stack` in the model's files, innermost first, by their workspace paths. */
  private frames(stack: string | undefined): string[] {
    const out: string[] = [];
    for (const raw of (stack ?? "").split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("at ") || !line.includes(`${this.deps.root}/`)) continue;
      out.push(this.relative(line));
      if (out.length >= STACK_FRAMES_SHOWN) break;
    }
    return out;
  }

  private errorNote(routine: string | undefined, err: unknown): ProgramErrorNote {
    const frames = this.frames(err instanceof Error ? err.stack : undefined);
    const name = err instanceof Error ? err.name : typeof err;
    // The signature leaves the column out: one line is one place.
    const first = (frames[0] ?? "").replace(/:(\d+):\d+\)?$/, ":$1").replace(/^at (?:async )?/, "").replace(/^.*\(/, "");
    return { name, text: this.relative(this.deps.renderError(err)), frames, signature: `${routine ?? ""}|${name}|${first}` };
  }

  /** An error in a routine's code that did not end it: a listener that threw, a promise nobody held. */
  noteError(run: RoutineRun<S> | undefined, err: unknown): void {
    if (isHarnessStop(err)) return;
    const now = Date.now();
    const error = this.errorNote(run?.note.name, err);
    if (!this.fresh(error.signature, now)) return;
    this.push({
      kind: "error",
      ts: now,
      ...(run !== undefined ? { routine: run.note.name } : {}),
      ...(run?.note.character !== undefined ? { character: run.note.character } : {}),
      deploy: run?.note.deploy ?? this.loaded?.version ?? 0,
      error,
      fresh: true,
    });
  }

  /**
   * A rejection or exception nobody handled: the program's when its stack
   * runs through the model's files, and then reported as one of its errors
   * rather than as a fault of the sandbox.
   */
  claimBackgroundError(reason: unknown): boolean {
    if (!(reason instanceof Error) || this.frames(reason.stack).length === 0) return false;
    this.noteError(undefined, reason);
    return true;
  }

  /** A hint-bearing failure of a call a routine made, as the SDK tallied it. */
  noteRefusal(run: RoutineRun<S>, h: { action: string; status: string; hint: string; count: number; ts: number }): void {
    const signature = `${run.note.name}|${run.note.character ?? ""}|${h.action}|${h.status}`;
    let count = h.count;
    if (!this.seen.has(signature) && this.seen.size < SIGNATURES_MAX) {
      this.seen.add(signature);
      count--;
      this.push({
        kind: "refusal",
        ts: h.ts,
        routine: run.note.name,
        ...(run.note.character !== undefined ? { character: run.note.character } : {}),
        deploy: run.note.deploy,
        action: h.action,
        status: h.status,
        hint: h.hint,
        signature,
        fresh: true,
      });
    }
    if (count <= 0) return;
    const r = this.repeats.get(signature);
    if (r === undefined) this.repeats.set(signature, { count, ts: h.ts });
    else {
      r.count += count;
      r.ts = Math.max(r.ts, h.ts);
    }
  }

  /** `wake(reason)`: the model's own code asking for its attention. */
  wake(run: RoutineRun<S> | undefined, reason: unknown): void {
    const text = short(typeof reason === "string" ? reason : reason === undefined ? "" : Bun.inspect(reason, { depth: 2 }));
    this.push({
      kind: "wake",
      ts: Date.now(),
      reason: text,
      ...(run !== undefined ? { routine: run.note.name } : {}),
      ...(run?.note.character !== undefined ? { character: run.note.character } : {}),
    });
  }

  /** One of the model's moves replaced another that was in flight, and a routine is on one side. */
  preempted(character: string | undefined, by: MoveOwner, of: MoveOwner, to: { x: number; y: number; z: number }): void {
    this.push({ kind: "preempted", ts: Date.now(), ...(character !== undefined ? { character } : {}), by, of, to });
  }

  private push(event: ProgramEvent): void {
    this.deps.send({ t: "program", events: [event] });
  }

  // ---------------------------------------------------------------- console

  /** A line a routine printed: kept for the next beat, consecutive repeats folded. */
  logLine(run: RoutineRun<S>, level: LogEntry["level"], text: string): void {
    const last = this.log.at(-1);
    if (last !== undefined && last.routine === run.note.name && last.character === run.note.character && last.level === level && last.text === text) {
      last.count++;
      last.ts = Date.now();
      return;
    }
    this.log.push({ ts: Date.now(), level, routine: run.note.name, ...(run.note.character !== undefined ? { character: run.note.character } : {}), text, count: 1 });
    if (this.log.length > PROGRAM_LOG_KEEP) this.logDropped += this.log.splice(0, this.log.length - PROGRAM_LOG_KEEP).reduce((n, l) => n + l.count, 0);
  }

  // ----------------------------------------------------------------- memory

  get memory(): Record<string, unknown> {
    return this.memoryValue;
  }

  set memory(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("memory is one plain object: assign to its fields (memory.phase = \"grind\"), or replace it with an object");
    }
    this.memoryValue = value as Record<string, unknown>;
  }

  /** Send the memory to the host when it changed. One that cannot be saved is an error, and the last save stays. */
  saveMemory(): void {
    let json: string;
    try {
      json = JSON.stringify(this.memoryValue);
    } catch (err) {
      this.memoryError(`memory could not be saved: ${this.deps.renderError(err)}. It holds plain JSON values only; the last saved memory stays.`, "unserializable");
      return;
    }
    if (json === this.memorySaved) return;
    if (json.length > MEMORY_MAX_CHARS) {
      this.memoryError(`memory is ${json.length} chars of JSON, over its ${MEMORY_MAX_CHARS}-char limit, and was not saved. The last saved memory stays.`, "over_limit");
      return;
    }
    this.memorySaved = json;
    this.deps.send({ t: "memory", json });
  }

  private memoryError(text: string, what: string): void {
    const signature = `memory|${what}`;
    const now = Date.now();
    if (!this.fresh(signature, now)) return;
    this.push({ kind: "error", ts: now, deploy: this.loaded?.version ?? 0, error: { name: "MemoryError", text, frames: [], signature }, fresh: true });
  }

  // ------------------------------------------------------------------- beat

  beat(): ProgramBeat {
    this.saveMemory();
    const repeats = [...this.repeats.entries()].map(([signature, r]) => ({ signature, count: r.count, ts: r.ts }));
    this.repeats.clear();
    const dropped = this.logDropped;
    this.logDropped = 0;
    return {
      deploy: this.loaded?.version ?? null,
      routines: [...this.runs.values()].map((r) => ({ ...r.note })),
      repeats,
      console: { lines: this.log.splice(0, this.log.length), dropped },
    };
  }
}
