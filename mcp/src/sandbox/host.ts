/**
 * Sandbox host: owns the child process lifecycle, the per-snippet timeout, and
 * the restart-with-state-loss path.
 *
 * Semantics, exactly:
 *  - `evalSnippet` resolves with the child's result, or with a timeout result.
 *  - A timeout does NOT kill the runtime. The evaluation is abandoned (its
 *    late result is discarded), its abort signal is fired in the child (so the
 *    SDK waits it left behind settle and an in-flight move is stopped),
 *    and the child is pinged; only if the ping also goes
 *    unanswered (the event loop is blocked) is the child killed and respawned.
 *    The loss is recorded as a harness notice the model will see.
 *  - A kill names no culprit. A blocked loop cannot say what blocked it: the
 *    snippet whose timeout noticed, another snippet in flight, a routine an
 *    earlier snippet left running or the client's own work. Every snippet in
 *    flight on the killed child is told the same (`stalledText`).
 *  - Consecutive restarts are counted for the `snippet-runaway` watchdog; a
 *    successful evaluation resets the count.
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import { ScrubbedStream, SecretRedactor } from "../redact";
import { overCapText, type Scratchpad } from "../scratchpad";
import type { ClientCacheStore } from "./client-cache";
import type { ActionHintNote, ActionNote, ChildToHost, EventSummary, EvalResultMsg, HostToChild, HostcallResult, LogEntry, ProgramOrigin, SeatClosed, SeatOpened } from "./ipc";
import { RepeatFolder } from "./log-fold";
import type { RecordDrain } from "../record/recorder";
import type { DispatchLink, SessionWriter } from "../record/writer";
import { ProgramHost, type ProgramOptions } from "./program-host";

export interface SnippetResult {
  ok: boolean;
  value?: string | undefined;
  error?: string | undefined;
  /** A note about the completion value; see `EvalResultMsg.hint`. */
  hint?: string | undefined;
  /** What this snippet did to the model's program, in a sandbox that hosts one; see `EvalResultMsg.notes`. */
  notes?: string[] | undefined;
  /**
   * Hint-bearing action failures the SDK tallied since the last drain — while
   * the snippet ran, or before it in a background routine. The harness renders
   * these itself (tools.ts) because the hint inside the result object only
   * reaches the model if the snippet's own code kept it.
   */
  actionHints?: ActionHintNote[] | undefined;
  logs: LogEntry[];
  durationMs: number;
  timedOut?: boolean;
  /** Set when the timeout escalated to a kill: all sandbox state was lost. */
  restarted?: boolean;
}

/**
 * Which tool call a snippet was: the caller's `dispatchTs` for it (every
 * trajectory writer stamps the same value on its `tool_call` record) and the
 * driver turn. The action log carries both, so a reader joins an `actions`
 * record to its call by `callTs === dispatchTs` whatever order the writers
 * appended them in.
 */
export interface EvalLink {
  callTs?: number | undefined;
  turn?: number | undefined;
}

/**
 * One flush of the action log for one launching snippet, as the trajectory's
 * `actions` record carries it (`ActionsLine` in trajectory.ts). `callTs` and
 * `turn` are absent for actions dispatched outside every snippet, and for a
 * snippet evaluated without a link (the run's own teardown).
 */
export interface ActionsFlush {
  turn?: number;
  callTs?: number;
  /** Whose client dispatched them, at fan-out above 1: the character's name. */
  character?: string;
  routine?: true;
  /** With a program: the routine of the model's program that dispatched them. */
  program?: ProgramOrigin;
  actions: ActionNote[];
  dropped?: Record<string, number>;
}

/** The notices the sandbox itself raises. A harness adds its own kinds to the same channel. */
export type SandboxNoticeKind = "sandbox_restarted" | "sandbox_started" | "session_note";

/**
 * Something the harness must tell the model that no tool result carries: a
 * sandbox restart and the state it lost, a fault a background routine raised.
 * `kind` is one of the sandbox's own (`SandboxNoticeKind`) here; a harness
 * widens it with its own (the runner's window and compaction notices).
 */
export interface HarnessNotice<K extends string = SandboxNoticeKind> {
  ts: number;
  kind: K;
  text: string;
}

export interface SandboxHostOptions {
  moduleUrl: string;
  /** The session token of the one character, at fan-out 1. Unused above it, where each seat brings its own (`SeatSpec`). */
  token: string;
  /**
   * The session secret leased for `token` (module/PROTOCOL.md,
   * "Authentication"), forwarded to the child as `WRATHBENCH_SECRET` and
   * bound onto its SDK client. The only credential the child holds: it
   * reaches this token's session and nothing else. Undefined (tests, a
   * pre-auth module) sends the child in with no credential.
   *
   * Also the value scrubbed from everything the child writes to stdout and
   * stderr before the runner passes it on (`logSink`), from the stderr tail
   * the crash notice quotes, and from what a snippet writes to the
   * scratchpad: it is the only secret the child holds, so it is the only one
   * the child can print.
   */
  secret?: string;
  /**
   * The game account this run occupies, forwarded to the child as
   * `WRATHBENCH_ACCOUNT` and bound onto the SDK client. Operator
   * infra like `token`: it makes `sdk.createSession`/`deleteCharacter` land on
   * the assigned account regardless of what a snippet passes. Undefined leaves
   * the client unbound (standalone behavior).
   */
  account?: string;
  scratchpad: Scratchpad;
  snippetTimeoutMs: number;
  pingGraceMs: number;
  /**
   * The child entry to run: a file that imports `./child` and calls
   * `startSandboxChild` with the harness's extensions. Defaults to this
   * package's own `entry.ts`, the bare stack with no extension.
   */
  entryPath?: string;
  /**
   * Directories the confined child may read beyond the stack's own
   * workspaces (`confine.ts`, `--read=`): wherever a harness's child entry and
   * its extension live. Read-only.
   */
  readDirs?: readonly string[];
  /** Called for every notice, so the loop can log it as it happens. */
  onNotice?: (notice: HarnessNotice) => void;
  /**
   * Where the child's stdout and stderr go once scrubbed: the runner's own
   * streams by default, and from there the job log and the pod log. A test
   * passes its own to read what would have been logged.
   */
  logSink?: (stream: "stdout" | "stderr", text: string) => void;
  /**
   * Called with every action-log flush the child pushes, already linked to its
   * snippet's tool call, so the owner of the trajectory can write it. Record
   * only: nothing in it reaches the model.
   */
  onActions?: (flush: ActionsFlush) => void;
  /**
   * The client's query-answer cache for this run (`client-cache.ts`): every
   * answer the child forwards is kept here, and every child this host starts
   * is seeded from it before it is ready, so a restart loses no name the
   * session was already given — as a client's on-disk cache never does.
   * Undefined keeps nothing, and every child starts with an empty cache.
   */
  clientCache?: ClientCacheStore;
  /**
   * The session record (`docs/SESSION-FORMAT.md`). With a writer, every child
   * this host starts runs the session recorder, and the host drains it into
   * the writer on its own tick, with the action log. The host owns the tick
   * and the final drain; whoever built the writer opens and closes it.
   * Undefined records nothing, and the child runs no recorder.
   */
  record?: {
    /** The one character's record, at fan-out 1. Above it there is none here: each seat brings its own (`SeatSpec.writer`). */
    writer?: SessionWriter;
    /** How often the child's recorder is drained. Default `RECORD_TICK_MS`. */
    tickMs?: number;
  };
  /**
   * Fan-out: how many characters this sandbox may hold at once, when that is
   * more than one. The grant is the operator's, as the GM opt-in is
   * (`fanout.ts`); the host only holds the seats it is handed (`openSeat`).
   * The child then builds no client from its environment: `token`, `secret`
   * and `account` above are unused, and every client is a seat's, on that
   * seat's own token and lease secret, sent over IPC. Absent, or 1, is the
   * single-character sandbox, unchanged.
   */
  fanout?: { maxCharacters: number };
  /**
   * Host the model's program (`program-host.ts`): a file workspace rooted at
   * `main.ts` whose exported functions are routines the sandbox runs and
   * tracks. The child is then granted read access to the workspace's
   * versions and nothing more, snippets keep no bindings and leave nothing
   * running, and `SandboxHost.program` is the surface the program tools and a
   * harness use. Absent, none of it exists: the child is spawned with the
   * arguments and environment it always had, and is the snippet sandbox
   * unchanged.
   */
  program?: ProgramOptions;
  now?: () => number;
}

/**
 * One more character for a fan-out sandbox (`SandboxHost.openSeat`): the name
 * to enter the world as, and the token, lease secret and account the host's
 * owner took for it.
 */
export interface SeatSpec {
  character: string;
  token: string;
  secret?: string | undefined;
  account?: string | undefined;
  /** What to create the character with when the account has none by that name. */
  create?: { race?: number; class?: number; gender?: number } | undefined;
  /** The session may already be in the world (a resumed server): ask for the reattach replay. */
  reattach?: boolean | undefined;
  /**
   * The seat's session record, asked for once the character is in the world
   * and its name is the server's. The host drains the seat's recorder into
   * it; whoever built it opens and closes it.
   */
  writer?: ((opened: SeatOpened) => SessionWriter | undefined) | undefined;
}

/** A seat as the host knows it. */
export interface SeatView {
  character: string;
  account: string | undefined;
  /** False after a restart it could not be reattached from; `error` says why. */
  attached: boolean;
  error?: string;
}

interface HostSeat {
  character: string;
  /** The character's guid, once it is in the world. */
  guid?: string;
  token: string;
  secret: string | undefined;
  account: string | undefined;
  writer: SessionWriter | undefined;
  attached: boolean;
  error: string | undefined;
}

/** How long a seat may take to reach the world: the module's own 20s login and a reclaim before it. */
export const SEAT_OPEN_TIMEOUT_MS = 45_000;

/**
 * How many seats reattach at once after a restart. Each reattach is a replay
 * burst (a create block per object in view) folded on the child's one event
 * loop, so forty at once would starve the pings that decide whether the
 * child is alive; a few at a time keeps it answering.
 */
export const REATTACH_CONCURRENCY = 4;

/** How often the host drains the child's recorder into the session record. */
export const RECORD_TICK_MS = 2_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** The child it was sent to: its exit fails this request and no other child's. */
  proc: Subprocess | null;
}

/**
 * The environment the sandbox child is spawned with — an explicit allowlist,
 * not the runner's inherited env. The model authors the snippets and is the
 * untrusted party (the confinement bounds where it reaches, not what it reads
 * from its own environment);
 * its exfiltration channel is the snippet result stream that flows back into
 * its own context. Inheriting `process.env` therefore leaks every provider
 * credential present in the runner (OPENROUTER_KEY, OPENCODE_KEY,
 * CLAUDE_CODE_OAUTH_TOKEN, …) to a `console.log(process.env)` snippet.
 *
 * Like the CLI drivers' `childEnv` (adapter-claude.ts, adapter-codex.ts), this
 * is an allowlist, and the tightest of the three: the child needs a runnable
 * `bun` (PATH), a home/temp for the runtime, the four values the host passes
 * explicitly (module URL, token, session secret, account), and the fault knobs
 * `entry.ts` reads — `SANDBOX_FORWARDED_ENV`, named one by one. The SDK reads
 * no env.
 *
 * Named, never a prefix. Forwarding `WRATHBENCH_*` wholesale would hand the
 * child whatever the runner holds under that prefix: on the cluster that is the
 * database credentials the preflight smokes use and the module's port secret,
 * and wherever Bun autoloads a `.env` it is every `WRATHBENCH_`-spelled value
 * in that file — deploy tokens, store passwords. A snippet can read its whole
 * environment (`/proc/self/environ` included) and print it into a result,
 * which is published; root on acore_characters would also be exactly the
 * server-side shortcut docs/CONTRACTS.md forbids, and the port secret would let
 * it lease, list and delete on any allowlisted account. The child gets its own
 * per-token session secret instead (`WRATHBENCH_SECRET`, passed explicitly
 * below), which the run registers for redaction (`leaseRunSecret`).
 */
export const SANDBOX_FORWARDED_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  // entry.ts's fault-storm knobs, tunable from the parent (and by the storm tests).
  "WRATHBENCH_FAULT_WINDOW_MS",
  "WRATHBENCH_FAULT_ROLLUP_MS",
  "WRATHBENCH_FAULT_ESCALATION_THRESHOLD",
  "WRATHBENCH_FAULT_IMMEDIATE_CAP",
];
export function sandboxChildEnv(
  parent: Record<string, string | undefined>,
  explicit: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SANDBOX_FORWARDED_ENV) {
    const v = parent[key];
    if (v !== undefined) out[key] = v;
  }
  return { ...out, ...explicit };
}

/**
 * Appended to every state-loss notice so the model knows the recovery steps.
 * The game session outlives the sandbox process, and a subscribe to it
 * replays what a client holds (module/PROTOCOL.md, "/events"); the ambient
 * `connect()` waits for that replay before it returns, so the state is whole
 * when the next line runs. `createSession` is only for a session that is
 * gone, which `connect()` reports rather than answering ok.
 */
export const STATE_LOSS_RECOVERY =
  "All top-level bindings and routines were lost; the game session was not, and your character is " +
  "where it was. Run `await connect()`: resubscribing replays your own state (health, power, xp, money, " +
  "bags, quest log, spells, skills, factions, bind point) and everything in view, and `connect()` returns " +
  "once that replay has landed, so `state` and `sdk` are whole again. Call `await sdk.createSession({...})` " +
  "only if `connect()` fails because the session is gone.";

/** `STATE_LOSS_RECOVERY` for a fan-out sandbox: the host reattaches every seat itself, so there is nothing for a snippet to reconnect. */
export const STATE_LOSS_RECOVERY_FANOUT =
  "All top-level bindings and routines were lost; the game sessions were not, and each character is where it was. " +
  "Every character that was logged in is reattached and its state replayed before the next call is answered; " +
  "`list_characters` shows them, and one that could not be reattached is named in a notice.";

/**
 * `STATE_LOSS_RECOVERY` for a sandbox that hosts a program: what survives is
 * on disk, and the host brings the routines back itself.
 */
export const STATE_LOSS_RECOVERY_PROGRAM =
  "The game session was not lost, and your character is where it was. Your files, memory and scratchpad are as they were, " +
  "and the routines that were running are started again from the top; when a routine was what blocked the sandbox none is, " +
  "and they are named. In a snippet, run `await connect()` before reading `state`: resubscribing replays your own state and " +
  "everything in view, and `connect()` returns once that replay has landed.";

/** `STATE_LOSS_RECOVERY_PROGRAM` at fan-out above 1: the host reattaches every character before it starts a routine. */
export const STATE_LOSS_RECOVERY_PROGRAM_FANOUT =
  "The game sessions were not lost, and each character is where it was. Your files, memory and scratchpad are as they were. " +
  "Every character that was logged in is reattached, and the routines that were running are started again from the top; " +
  "when a routine was what blocked the sandbox none is, and they are named.";

/** The runner's own stream of the same name: the job log, or the pod log on the cluster. */
function defaultLogSink(stream: "stdout" | "stderr", text: string): void {
  (stream === "stdout" ? process.stdout : process.stderr).write(text);
}

/** How many evals' links the host keeps for routines still dispatching under them. */
const EVAL_LINKS_MAX = 256;

/** How often a repeat still going is counted in the log (`RepeatFolder.flush`), so a reader of a live log sees it. */
const LOG_FOLD_FLUSH_MS = 60_000;

/**
 * The SDK's advice at the foot of an abandoned walk's note (`moveTo`,
 * `moveAbandon`): dispatch it, or run it "from a background routine", and
 * poll. A host with a program has no background routine of a snippet's: its
 * timeout text says where a long walk goes instead (a routine), so the SDK's
 * sentence is dropped there and the distance covered and left is kept.
 */
export const SDK_MOVE_ABANDON_ADVICE =
  " A move that long does not fit one snippet — issue it with sdk.moveToAsync(target), or from a background routine, and poll " +
  "state.self.position (or watch the WB_MOVE_RESULT event) instead of awaiting it inline.";

/** An abandon note as a host with a program shows it: the SDK's advice dropped (`SDK_MOVE_ABANDON_ADVICE`). Pure. */
export function programAbandonNote(note: string): string {
  return note.endsWith(SDK_MOVE_ABANDON_ADVICE) ? note.slice(0, -SDK_MOVE_ABANDON_ADVICE.length) : note;
}

/**
 * The SDK's advice at the end of a walk's budget note (`walkBudgetNote`):
 * dispatch it, or run it "from a background routine", and poll. As with
 * `SDK_MOVE_ABANDON_ADVICE`, a host with a program has no background routine
 * of a snippet's, so the advice is cut there and the note ends on the fact
 * that a move this long does not fit one snippet.
 */
export const SDK_WALK_BUDGET_ADVICE = ": dispatch it with sdk.moveToAsync(target) or from a background routine, then poll state.self.position.";

/** Text a snippet's result carries, as a host with a program shows it: the SDK's walk-budget advice cut (`SDK_WALK_BUDGET_ADVICE`). Pure. */
export function programWalkText(text: string): string {
  return text.includes(SDK_WALK_BUDGET_ADVICE) ? text.split(SDK_WALK_BUDGET_ADVICE).join(".") : text;
}

export class SandboxHost {
  private proc: Subprocess | null = null;
  private markReady: () => void = () => {};
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly abandonedEvals = new Set<number>();
  /** The evals awaiting their result, by id: a kill tells each of them the same thing. */
  private readonly evalsInFlight = new Set<number>();
  /** Children this host killed because their event loop stopped answering. */
  private readonly stalledProcs = new WeakSet<Subprocess>();
  private ready: Promise<void> = Promise.resolve();
  private readonly notices: HarnessNotice[] = [];
  /**
   * The link for each recent eval, by the child's eval id. Kept past the eval
   * itself because a routine it launched dispatches under its id for as long
   * as the routine runs; bounded, and an id that aged out writes unlinked.
   */
  private readonly evalLinks = new Map<number, EvalLink>();
  /** Consecutive restarts without an intervening successful snippet. */
  consecutiveRestarts = 0;
  totalRestarts = 0;
  /**
   * Per-child stderr holder. A fresh one is allocated in start() and closed over
   * by that child's onExit/emit, so a crash notice reads the crashed child's
   * tail even if the replacement child has already started and is refilling its
   * own buffer (a shared field would be reset to "" by start() before emit ran,
   * losing or polluting the "Last stderr" diagnostic).
   */
  private stderr: { tail: string; done: Promise<void> } = { tail: "", done: Promise.resolve() };
  /** Both of the current child's output pumps, settled once each has written what it held. */
  private drained: Promise<void> = Promise.resolve();
  /** Scrubs the child's output, its crash tail and its pad writes; it knows only `opts.secret`. */
  private readonly redactor = new SecretRedactor();
  /** The record tick, running from the first start until `stop`. */
  private recordTimer: ReturnType<typeof setInterval> | undefined;
  private recordDraining: Promise<void> | null = null;
  /** The seats of a fan-out sandbox, by character name, in the order they were opened. */
  private readonly seats = new Map<string, HostSeat>();
  /** The current child's seats reattached, after its ready; resolved at once at fan-out 1. */
  private reattached: Promise<void> = Promise.resolve();
  /** The model's program, when this host was asked to hold one (`SandboxHostOptions.program`). */
  readonly program: ProgramHost | undefined;

  constructor(private readonly opts: SandboxHostOptions) {
    this.redactor.redact(opts.secret);
    if (opts.program !== undefined) {
      this.program = new ProgramHost(opts.program, {
        start: () => this.start(),
        running: () => this.proc !== null,
        request: async (msg, timeoutMs, link) => {
          const id = this.nextId++;
          if (link !== undefined) this.linkEval(id, link);
          const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>({ ...msg, id } as unknown as HostToChild & { id: number }, timeoutMs);
          if (!res.ok) throw new Error(res.error ?? `${msg.t} failed`);
          return res.value;
        },
        tell: (msg) => {
          try {
            this.send(msg as unknown as HostToChild);
          } catch {
            // no child to tell; the next one is told as it starts
          }
        },
        isTimeout: (err) => err instanceof SandboxTimeoutError,
        snippetsInFlight: () => this.evalsInFlight.size,
        restartStalled: () => this.restart("its event loop was blocked while no snippet was running, so a routine blocked it"),
        attached: (character) => character === undefined || this.seats.get(character)?.attached === true,
        now: () => (this.opts.now ?? Date.now)(),
      });
    }
  }

  /** Remember which tool call an id of the child's is, for the action log (`evalLinks`). */
  private linkEval(id: number, link: EvalLink): void {
    this.evalLinks.set(id, link);
    for (const key of this.evalLinks.keys()) {
      if (this.evalLinks.size <= EVAL_LINKS_MAX) break;
      this.evalLinks.delete(key);
    }
  }

  /** How many characters this sandbox may hold: above 1 only for a fan-out sandbox. */
  get maxCharacters(): number {
    const n = this.opts.fanout?.maxCharacters ?? 1;
    return Number.isInteger(n) && n > 1 ? n : 1;
  }

  private get fanout(): boolean {
    return this.maxCharacters > 1;
  }

  /** What a state-loss notice ends with: how to get the session back, or that the host already did. */
  private get stateLoss(): string {
    if (this.program !== undefined) return this.fanout ? STATE_LOSS_RECOVERY_PROGRAM_FANOUT : STATE_LOSS_RECOVERY_PROGRAM;
    return this.fanout ? STATE_LOSS_RECOVERY_FANOUT : STATE_LOSS_RECOVERY;
  }

  get entryPath(): string {
    return this.opts.entryPath ?? join(import.meta.dir, "entry.ts");
  }

  /** The Landlock wrapper the child is exec'd through (see start()). */
  get confinePath(): string {
    return join(import.meta.dir, "confine.ts");
  }

  private notice(kind: HarnessNotice["kind"], text: string): void {
    const n: HarnessNotice = { ts: (this.opts.now ?? Date.now)(), kind, text };
    this.notices.push(n);
    if (this.notices.length > 50) this.notices.splice(0, this.notices.length - 50);
    this.opts.onNotice?.(n);
  }

  /** Notices not yet consumed by a context assembly. Drained by the loop. */
  drainNotices(): HarnessNotice[] {
    return this.notices.splice(0, this.notices.length);
  }

  async start(): Promise<void> {
    // A child already starting is waited for, not raced: whatever a second
    // caller sends must queue behind the client-cache seed the host sends as
    // the child reports ready (`onMessage`), or an eval could connect and
    // fold events into a cache that is not seeded yet.
    if (this.proc !== null) {
      await this.ready;
      await this.reattached;
      return;
    }
    this.startRecordTick();
    this.ready = new Promise((r) => {
      this.markReady = r;
    });
    const markReady = this.markReady;
    // Own this child's stderr in a fresh holder; onExit/emit close over it, not
    // over the mutable field, so the next child's start() cannot clear it.
    const stderr = { tail: "", done: Promise.resolve() };
    this.stderr = stderr;
    // --env-file=/dev/null: Bun auto-loads `.env` from the child's cwd into
    // process.env AT STARTUP, regardless of the spawn env — so a repo-root
    // `.env` (where provider keys live) would re-enter the child right past the
    // allowlist. Pointing the flag at /dev/null disables that load (verified on
    // Bun 1.4.0 and 1.4.4), making the child's env exactly `sandboxChildEnv`.
    //
    // The child is exec'd through confine.ts, which applies a Landlock ruleset
    // first: the snippet process can then read the interpreter, mcp/, sdk/,
    // node_modules/ and the host's `readDirs` (a harness's own child code) and nothing else — not `.env` by any path, not $HOME,
    // not /tmp — can open TCP connections only to the module URL's port, bind
    // nothing, execute no binary but bun itself, and (on a kernel with scopes)
    // signal nothing outside its own process tree; the wrapper exits instead
    // of exec'ing when the kernel or container refuses the ruleset. The wrapper
    // gets the same `--env-file=/dev/null` as the child because it reads
    // WRATHBENCH_MODULE_URL for the port, and that must be this value and not
    // an autoloaded `.env`'s. The IPC channel and stdio are inherited
    // descriptors and survive the exec.
    //
    // stdout and stderr are both piped, never inherited: a snippet's
    // `console.log` reaches the child's stdout as well as its result, and the
    // child holds its session secret, so both streams pass the redaction
    // before they reach the runner's own and the logs behind them (`pump`).
    // With a program, the versions of the model's files are one more directory
    // the child may read; it is written by this process alone.
    const program = this.program;
    const readFlags = [...(this.opts.readDirs ?? []), ...(program !== undefined ? [program.workspace.deploysDir] : [])].map((d) => `--read=${d}`);
    this.proc = Bun.spawn(["bun", "--env-file=/dev/null", this.confinePath, ...readFlags, "bun", "--env-file=/dev/null", this.entryPath], {
      env: sandboxChildEnv(process.env, {
        WRATHBENCH_MODULE_URL: this.opts.moduleUrl,
        WRATHBENCH_TOKEN: this.opts.token,
        // Explicit and possibly empty, for the same reason as WRATHBENCH_ACCOUNT
        // below: nothing leaked from the operator's shell may stand in for it.
        WRATHBENCH_SECRET: this.opts.secret ?? "",
        // Always set explicitly (empty when unbound): the child must bind only
        // the account this run was actually assigned, never a stray one, and
        // sandboxChildEnv forwards no WRATHBENCH_ACCOUNT of its own.
        WRATHBENCH_ACCOUNT: this.opts.account ?? "",
        // Whether this child runs the session recorder: set here and nowhere
        // else, so a stray value in the operator's shell decides nothing.
        WRATHBENCH_RECORD: this.opts.record !== undefined ? "1" : "",
        // Fan-out only, and absent at 1: the child of a single-character
        // sandbox is spawned with exactly the environment it always had.
        ...(this.fanout ? { WRATHBENCH_MAX_CHARACTERS: String(this.maxCharacters) } : {}),
        // A program only, and absent without one, for the same reason.
        ...(program !== undefined ? { WRATHBENCH_PROGRAM: program.workspace.deploysDir } : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
      serialization: "json",
      ipc: (message) => {
        this.onMessage(message as ChildToHost, markReady);
      },
      onExit: (sub, exitCode, signalCode) => {
        // Deliberate kills (restart/stop) null `this.proc` before killing, so a
        // match here means the child died on its own — crash, OOM, exit(). The
        // state loss must reach the model as a notice (it did not in gate2-ox-3)
        // and count toward the snippet-runaway watchdog; the next evalSnippet's
        // start() respawns lazily.
        if (sub === this.proc) {
          this.proc = null;
          this.consecutiveRestarts++;
          this.totalRestarts++;
          // Let the stderr pipe drain (briefly) so the crash output makes it
          // into the notice — Bun prints the fatal error just before exiting.
          const emit = (): void => {
            const cause = `exit code ${exitCode ?? "?"}, signal ${signalCode ?? "none"}`;
            const tail = stderr.tail.trim().slice(-600);
            this.notice(
              "sandbox_restarted",
              `sandbox process exited unexpectedly (${cause}).` +
                (tail ? ` Last stderr: ${tail}\n` : " ") +
                this.stateLoss,
            );
            // Never leave a start() awaiting a dead child — this child's
            // start(), by its own resolver: the field may already belong to
            // the respawn, whose ready must wait for its seed (`onMessage`).
            markReady();
          };
          void Promise.race([stderr.done, new Promise((r) => setTimeout(r, 100))]).then(emit);
        }
        for (const [id, p] of this.pending) {
          if (p.proc !== sub) continue;
          this.pending.delete(id);
          p.reject(new SandboxExitedError());
        }
        this.abandonedEvals.clear();
      },
    });
    // Scrubbed before it is cut, every read: a secret split across two reads
    // is whole once the second is appended, and whole when it is replaced, so
    // neither this cut nor the notice's shorter one can leave a piece of it.
    stderr.done = this.pump(this.proc.stderr, "stderr", (text) => {
      stderr.tail = this.redactor.scrub(stderr.tail + text).slice(-4_000);
    });
    this.drained = Promise.all([stderr.done, this.pump(this.proc.stdout, "stdout")]).then(() => undefined);
    // A fan-out child starts with no client: every seat this host holds is
    // opened in it again before anything else is asked of it.
    const proc = this.proc;
    this.reattached = this.fanout ? this.ready.then(() => this.reattachSeats(proc)) : Promise.resolve();
    // With a program, the routines that were running come back once the
    // child is ready and its characters are attached; whoever awaits this
    // start is answered when they have.
    if (program !== undefined) {
      const attached = this.reattached;
      this.reattached = this.ready
        .then(() => attached)
        .then(() => (this.proc === proc && proc !== null ? program.resume() : undefined))
        .catch(() => undefined);
    }
    await this.ready;
    await this.reattached;
  }

  // ---------------------------------------------------------------- seats

  private async sendSeatOpen(seat: HostSeat, o: { reattach: boolean; create?: SeatSpec["create"] }): Promise<SeatOpened> {
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      {
        t: "seat_open",
        id,
        character: seat.character,
        token: seat.token,
        ...(seat.secret !== undefined ? { secret: seat.secret } : {}),
        ...(seat.account !== undefined ? { account: seat.account } : {}),
        ...(o.create !== undefined ? { create: o.create } : {}),
        reattach: o.reattach,
        frames: this.opts.clientCache?.snapshot() ?? [],
      },
      SEAT_OPEN_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error ?? "the character did not reach the world");
    return res.value as SeatOpened;
  }

  /**
   * Open every seat this host holds in a child that has just started, a few
   * at a time (`REATTACH_CONCURRENCY`). A seat that does not come back stays
   * in the table, marked, and is named in a notice; nothing here throws.
   * Abandoned without a word when the child it was for is no longer the
   * current one: the next start reattaches from the top.
   */
  private async reattachSeats(proc: Subprocess | null): Promise<void> {
    const pending = [...this.seats.values()];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const seat = pending[next++]!;
        if (this.proc !== proc || proc === null) return;
        try {
          await this.sendSeatOpen(seat, { reattach: true });
          seat.attached = true;
          seat.error = undefined;
        } catch (err) {
          if (this.proc !== proc) return;
          seat.attached = false;
          seat.error = err instanceof Error ? err.message : String(err);
          this.notice("session_note", `${seat.character} could not be reattached after the sandbox restarted: ${seat.error}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REATTACH_CONCURRENCY, pending.length) }, worker));
  }

  /**
   * Open a seat: one more character in a fan-out sandbox, on the token and
   * lease secret its owner took for it. Resolves with the character as the
   * server named it, which is the seat's key from then on; rejects with why
   * it did not reach the world, and then nothing is held. The secret is
   * scrubbed from everything the child writes, as the single character's is.
   */
  async openSeat(spec: SeatSpec): Promise<SeatOpened> {
    if (!this.fanout) throw new Error("this sandbox holds one character");
    this.redactor.redact(spec.secret);
    await this.start();
    const seat: HostSeat = { character: spec.character, token: spec.token, secret: spec.secret, account: spec.account, writer: undefined, attached: false, error: undefined };
    let opened: SeatOpened;
    try {
      opened = await this.sendSeatOpen(seat, { reattach: spec.reattach === true, create: spec.create });
    } catch (err) {
      // A create that outlived the wait may still land: have the child drop whatever it built.
      if (err instanceof SandboxTimeoutError) {
        try {
          this.send({ t: "seat_close", id: this.nextId++, seat: spec.character, logout: false });
        } catch {
          // no child to tell
        }
        throw new Error(`${spec.character} did not reach the world within ${SEAT_OPEN_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }
    seat.character = opened.character;
    seat.guid = opened.guid;
    seat.attached = true;
    seat.writer = spec.writer?.(opened);
    this.seats.set(opened.character, seat);
    // Each record's gate knows its own character and every other seat's at
    // once, not a record tick and an index read later: one seat printing
    // another's name is not a foreign player.
    seat.writer?.noteSelf(opened.guid);
    for (const other of this.seats.values()) {
      if (other.guid === undefined || other === seat) continue;
      other.writer?.noteOwn(opened.guid);
      seat.writer?.noteOwn(other.guid);
    }
    return opened;
  }

  /**
   * Close a seat: with `logout`, the child logs the character out first.
   * What its recorder still held is written before the seat is forgotten.
   * A seat this host does not hold is a no-op. Never throws.
   */
  async closeSeat(character: string, o: { logout: boolean }): Promise<void> {
    const seat = this.seats.get(character);
    if (seat === undefined) return;
    this.seats.delete(character);
    if (this.proc === null || !seat.attached) return;
    try {
      const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown }>(
        { t: "seat_close", id: this.nextId++, seat: character, logout: o.logout },
        this.opts.pingGraceMs + (o.logout ? 6_000 : 0),
      );
      const drain = (res.value as SeatClosed | undefined)?.drain ?? null;
      if (drain !== null) seat.writer?.ingest(drain as RecordDrain, (evalId, routine, program) => this.dispatchLink(evalId, routine, program));
    } catch {
      // A child that cannot answer loses the last tick of this seat's record, no more.
    }
  }

  /** The seats this host holds, in the order they were opened. */
  seatViews(): SeatView[] {
    return [...this.seats.values()].map((s) => ({ character: s.character, account: s.account, attached: s.attached, ...(s.error !== undefined ? { error: s.error } : {}) }));
  }

  /**
   * Mirror one of the child's output streams to the runner's, scrubbed of the
   * child's secret on the way (`ScrubbedStream`). `onRaw` sees the text as the
   * child wrote it, unheld; the stderr tail it keeps for the crash notice is
   * scrubbed as it accumulates (`start`).
   */
  private async pump(stream: unknown, name: "stdout" | "stderr", onRaw?: (text: string) => void): Promise<void> {
    if (!(stream instanceof ReadableStream)) return;
    const sink = this.opts.logSink ?? defaultLogSink;
    // Scrubbed, then folded (`RepeatFolder`): the log copy only. `onRaw`, and
    // with it the stderr tail a crash notice quotes, sees the stream as written.
    const fold = new RepeatFolder((text) => sink(name, text));
    const out = new ScrubbedStream(
      (text) => this.redactor.scrub(text),
      (text) => fold.push(text),
    );
    const tick = setInterval(() => fold.flush(), LOG_FOLD_FLUSH_MS);
    tick.unref();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        onRaw?.(text);
        out.push(text);
      }
    } catch {
      // stream torn down with the process; the tail keeps what we saw
    } finally {
      clearInterval(tick);
      out.push(decoder.decode());
      out.end();
      fold.end();
    }
  }

  private onMessage(msg: ChildToHost, markReady: () => void): void {
    switch (msg.t) {
      case "ready": {
        // Seed first, ready second: the seed is then the first message this
        // child handles, ahead of every eval and rpc that waited for ready.
        // A fan-out child has no client yet: each seat is seeded as it opens.
        const frames = this.fanout ? [] : (this.opts.clientCache?.snapshot() ?? []);
        if (frames.length > 0) {
          try {
            this.proc?.send({ t: "client_cache_seed", frames } satisfies HostToChild);
          } catch {
            // A child that died as it started is the onExit path's to report.
          }
        }
        if (this.program !== undefined) {
          try {
            this.proc?.send(this.program.initMessage() satisfies HostToChild);
          } catch {
            // as above
          }
        }
        markReady();
        return;
      }
      case "client_cache":
        this.opts.clientCache?.add(msg.frames);
        this.notePlayers(msg.frames);
        return;
      case "result":
      case "pong":
      case "rpc_result": {
        if (this.abandonedEvals.delete(msg.id)) return; // late result of a timed-out eval
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        return;
      }
      case "hostcall": {
        const reply = (ok: boolean, value?: unknown, error?: string): void => {
          const res: HostcallResult = { t: "hostcall_result", id: msg.id, ok, value, error };
          this.proc?.send(res);
        };
        try {
          const pad = this.opts.scratchpad;
          if (msg.method === "scratchpad_read") {
            reply(true, pad.read());
          } else {
            // A refusal is an error reply, so the snippet's promise rejects:
            // awaited, it is the snippet's error; not awaited, the child still
            // reports it (`collectPadRefusals` in entry.ts). A resolved
            // `{ truncated }` the model never read is how notes vanished.
            const write = msg.method === "scratchpad_write";
            // Scrubbed before it is stored: the pad is shown to the model
            // every turn, and the text it is shown must be the text
            // `edit_scratchpad` can match.
            const content = this.redactor.scrub(msg.params.content ?? "");
            const res = write ? pad.write(content) : pad.append(content);
            if (res.ok) reply(true, { chars: res.chars });
            else reply(false, undefined, overCapText(write ? "scratchpad.write" : "scratchpad.append", res.chars));
          }
        } catch (err) {
          reply(false, undefined, String(err));
        }
        return;
      }
      case "fatal":
        this.notice("session_note", `sandbox reported fatal error: ${msg.error}`);
        return;
      case "program":
        this.program?.onEvents(msg.events);
        return;
      case "memory":
        this.program?.onMemory(msg.json);
        return;
      case "actions": {
        const sink = this.opts.onActions;
        for (const b of msg.batches) {
          // The dispatching client's own record: the seat's at fan-out above 1.
          const writer = b.seat !== undefined ? this.seats.get(b.seat)?.writer : this.opts.record?.writer;
          writer?.actions(this.dispatchLink(b.evalId, b.routine === true, b.program), b.actions, b.dropped);
          if (sink === undefined) continue;
          const link = b.evalId === null ? undefined : this.evalLinks.get(b.evalId);
          const flush: ActionsFlush = { actions: b.actions };
          if (b.seat !== undefined) flush.character = b.seat;
          if (link?.turn !== undefined) flush.turn = link.turn;
          if (link?.callTs !== undefined) flush.callTs = link.callTs;
          if (b.routine === true) flush.routine = true;
          if (b.program !== undefined) flush.program = b.program;
          if (b.dropped !== undefined) flush.dropped = b.dropped;
          try {
            sink(flush);
          } catch {
            // A record that failed to write must not take the sandbox's IPC with it.
          }
        }
        return;
      }
    }
  }

  /**
   * Player names the child was just answered, handed to every record this
   * host writes as they arrive, so the write gate's scrub (`gate.ts`) knows
   * them before a result that prints one is written, not a record tick
   * later. The drain still carries them all, for what a restarted child was
   * seeded with. To every seat's record: a call can be written to each.
   */
  private notePlayers(frames: readonly unknown[]): void {
    const players: [string, string][] = [];
    for (const f of frames) {
      const frame = f as { opcode?: unknown; data?: { guid?: unknown; found?: unknown; name?: unknown } | null } | null;
      const d = frame?.opcode === "SMSG_NAME_QUERY_RESPONSE" ? frame.data : undefined;
      if (d?.found === true && typeof d.guid === "string" && typeof d.name === "string") players.push([d.guid, d.name]);
    }
    if (players.length === 0) return;
    this.opts.record?.writer?.notePlayers(players);
    for (const seat of this.seats.values()) seat.writer?.notePlayers(players);
  }

  /** Who dispatched something, for the session record: the call an eval was, when the host still knows. */
  private dispatchLink(evalId: number | null, routine: boolean, program?: ProgramOrigin): DispatchLink {
    if (evalId === null) return { inCall: false };
    return { inCall: true, call: this.evalLinks.get(evalId)?.callTs, routine, ...(program !== undefined ? { program } : {}) };
  }

  private startRecordTick(): void {
    const record = this.opts.record;
    if (record === undefined || this.recordTimer !== undefined) return;
    this.recordTimer = setInterval(() => void this.recordDrain(), record.tickMs ?? RECORD_TICK_MS);
    this.recordTimer.unref?.();
  }

  /**
   * One record tick: drain the child's session recorder into the writer.
   * Coalesced, so a slow drain is never raced by the next tick, and it never
   * spawns a child: with none running the writer only beats its heartbeat. A
   * host that needs what was just recorded (a harness acting on a row) awaits
   * this rather than waiting for the timer. Never throws.
   */
  recordDrain(): Promise<void> {
    if (this.fanout) return this.recordDrainSeats();
    const writer = this.opts.record?.writer;
    if (writer === undefined) return Promise.resolve();
    if (this.recordDraining !== null) return this.recordDraining;
    const p = (async () => {
      let drained: RecordDrain | null = null;
      try {
        drained = ((await this.drain("record_drain"))?.value ?? null) as RecordDrain | null;
      } catch {
        // A child that cannot answer now is drained on the next tick.
        return;
      }
      writer.ingest(drained, (evalId, routine, program) => this.dispatchLink(evalId, routine, program));
    })().finally(() => {
      if (this.recordDraining === p) this.recordDraining = null;
    });
    this.recordDraining = p;
    return p;
  }

  /** The record tick at fan-out above 1: one ask for every seat's recorder, each drained into its own writer. */
  private recordDrainSeats(): Promise<void> {
    if (this.opts.record === undefined) return Promise.resolve();
    if (this.recordDraining !== null) return this.recordDraining;
    const p = (async () => {
      let drained: Record<string, RecordDrain | null> = {};
      try {
        drained = ((await this.drain("record_drain_all"))?.value ?? {}) as Record<string, RecordDrain | null>;
      } catch {
        return;
      }
      // A call can be written to every seat's record (a roll-up), so each
      // seat's scrub looks for the players any seat's client was answered for.
      const players = Object.values(drained).flatMap((d) => d?.players ?? []);
      // A seat the child did not answer for (none running, or mid-reattach) still beats its heartbeat.
      for (const seat of this.seats.values()) {
        if (players.length > 0) seat.writer?.notePlayers(players);
        seat.writer?.ingest(drained[seat.character] ?? null, (evalId, routine, program) => this.dispatchLink(evalId, routine, program));
      }
    })().finally(() => {
      if (this.recordDraining === p) this.recordDraining = null;
    });
    this.recordDraining = p;
    return p;
  }

  private send(msg: HostToChild): void {
    if (this.proc === null) throw new Error("sandbox not started");
    this.proc.send(msg);
  }

  private request<T extends ChildToHost>(msg: HostToChild & { id: number }, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new SandboxTimeoutError(msg.id));
      }, timeoutMs);
      this.pending.set(msg.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        proc: this.proc,
      });
      try {
        this.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(msg.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Evaluate one snippet with the configured hard timeout. `link` names the
   * tool call it is, for the action log (`EvalLink`); it changes nothing about
   * the evaluation.
   */
  async evalSnippet(code: string, link?: EvalLink, character?: string): Promise<SnippetResult> {
    await this.start();
    const proc = this.proc;
    const id = this.nextId++;
    const started = performance.now();
    if (link !== undefined) this.linkEval(id, link);
    this.evalsInFlight.add(id);
    try {
      const res = await this.request<EvalResultMsg>(
        // The budget is the host's fact, so the host states it: the child hands
        // it to the SDK, which uses it to explain a walk that never fit (see
        // ipc.ts). Wall-clock, not `opts.now` — it is compared against
        // `Date.now()` in another process. The ceiling itself rides along so
        // an abandoned sleep's note can name it.
        {
          t: "eval",
          id,
          code,
          deadline: Date.now() + this.opts.snippetTimeoutMs,
          timeoutMs: this.opts.snippetTimeoutMs,
          // At fan-out above 1, the character whose `sdk`, `state` and `events` the snippet gets.
          ...(character !== undefined ? { seat: character } : {}),
        },
        this.opts.snippetTimeoutMs,
      );
      this.consecutiveRestarts = 0;
      // With a program, the SDK's walk-budget advice is cut from whatever carries it.
      const cut = this.program !== undefined ? programWalkText : (t: string): string => t;
      const opt = (t: string | undefined): string | undefined => (t === undefined ? t : cut(t));
      return {
        ok: res.ok,
        value: opt(res.value),
        error: opt(res.error),
        hint: opt(res.hint),
        ...(res.notes !== undefined ? { notes: res.notes.map(cut) } : {}),
        actionHints: this.program !== undefined ? (res.hints ?? []).map((h) => ({ ...h, hint: cut(h.hint) })) : (res.hints ?? []),
        logs: this.program !== undefined ? res.logs.map((l) => ({ ...l, text: cut(l.text) })) : res.logs,
        durationMs: res.durationMs,
      };
    } catch (err) {
      if (err instanceof SandboxStalledError) {
        // Killed while this snippet waited, on another snippet's timeout.
        return { ok: false, restarted: true, error: this.stalledText(), logs: [], durationMs: Math.round(performance.now() - started) };
      }
      if (err instanceof SandboxExitedError) {
        return {
          ok: false,
          restarted: true,
          error: `the sandbox process exited while this snippet was running — ${this.stateLoss}`,
          logs: [],
          durationMs: 0,
        };
      }
      if (!(err instanceof SandboxTimeoutError)) {
        return { ok: false, error: String(err), logs: [], durationMs: this.opts.snippetTimeoutMs };
      }
      // Timed out. Abandon this eval's eventual result, then check liveness.
      // The ping doubles as a log drain: the pong carries whatever the
      // abandoned snippet printed so far, so the model is not shown `logs: []`
      // for code that was in fact talking.
      this.abandonedEvals.add(id);
      // Cooperative abort first, then the liveness ping: the pong then carries
      // whatever the abort made the snippet print.
      try {
        this.send({ t: "abort", id });
      } catch {
        // not started / already gone — the ping path reports that
      }
      const ping = await this.pingAlive();
      if (ping.alive) {
        return {
          ok: false,
          timedOut: true,
          error:
            `snippet evaluation exceeded ${this.opts.snippetTimeoutMs}ms and was abandoned: its \`signal\` was ` +
            `aborted, so pending SDK waits (moveTo, killTarget, waitForTransfer, …) rejected with ` +
            `EventAbortedError and any move in flight was stopped. ` +
            // What the abort itself learned, when it learned anything: the
            // distance an in-flight moveTo had covered and had left (named by
            // the SDK), or that an awaited sleep was asked for at least the
            // time the snippet had left (named by the sandbox), carried home on
            // the pong. A generic "it timed out" is what the 2026-08-23 fan-out
            // showed models failing to act on (one retried the same blocking
            // call 5 times), and one e360 slept `sleep(30000, { wake: false })`
            // into a 30000ms ceiling 32 times without learning why.
            (ping.note !== undefined ? `${this.program !== undefined ? programAbandonNote(ping.note) : ping.note} ` : "") +
            (this.program !== undefined
              ? `The sandbox, your routines and the session are still alive. ` +
                `Work longer than ${Math.round(this.opts.snippetTimeoutMs / 1000)}s belongs in a routine: a function main.ts exports, ` +
                `started with start_routine, has no time limit, and a long walk there is \`await sdk.moveTo(target)\`. ` +
                `Code that was not awaiting the SDK may still be running, so check state/events before assuming it failed.`
              : `The runtime (bindings, routines, session) is still alive. ` +
            `A walk longer than this limit is dispatched, not awaited: sdk.moveToAsync(target) returns as soon ` +
            `as the move is queued, and you poll state.self.position or the WB_MOVE_RESULT event for the ` +
            `verdict. ` +
            `Work longer than ${Math.round(this.opts.snippetTimeoutMs / 1000)}s belongs in a background ` +
            `routine (launch it without awaiting, e.g. ` +
            `\`globalThis.trip = (async () => { for (const p of waypoints) await sdk.moveTo(p); return "done"; })().catch(String); "started"\` ` +
            `— the trailing value keeps the snippet from awaiting the promise REPL-style; it returns instantly, then a later snippet checks \`await Promise.race([trip, "running"])\`); ` +
            `code that was not awaiting the SDK may still be running, so check state/events before assuming it failed.`),
          logs: ping.logs,
          // The abandoned snippet's hints: its result is discarded, so this
          // pong is the only channel that still reaches the model.
          actionHints: ping.hints,
          durationMs: this.opts.snippetTimeoutMs,
        };
      }
      // Another snippet's timeout may have replaced the child while this one
      // pinged it, or the child may have died on its own: that loss is already
      // reported, and a second restart would kill the fresh child.
      if (this.proc !== proc) {
        return {
          ok: false,
          timedOut: true,
          restarted: true,
          error:
            proc !== null && this.stalledProcs.has(proc)
              ? this.stalledText()
              : `the sandbox process exited while this snippet was running — ${this.stateLoss}`,
          logs: [],
          durationMs: this.opts.snippetTimeoutMs,
        };
      }
      await this.restart("its event loop was blocked past the timeout; what blocked it is not known");
      return {
        ok: false,
        timedOut: true,
        restarted: true,
        error: this.stalledText(),
        logs: [],
        durationMs: this.opts.snippetTimeoutMs,
      };
    } finally {
      this.evalsInFlight.delete(id);
    }
  }

  /**
   * What every snippet in flight on a child killed for a blocked loop is told.
   * It names no culprit because none is known: the host sees only that the
   * child stopped answering, and the snippet whose timeout noticed is often a
   * bystander parked in `sleep` while a routine or the client's own work held
   * the loop.
   */
  private stalledText(): string {
    return (
      `the sandbox event loop was blocked past ${this.opts.snippetTimeoutMs}ms while this snippet was running, ` +
      `so the sandbox process was killed and restarted; what blocked it is not known (this snippet, ` +
      `a background routine, another snippet or the client's own work) — ${this.stateLoss}`
    );
  }

  private async pingAlive(): Promise<{ alive: boolean; logs: LogEntry[]; note?: string; hints: ActionHintNote[] }> {
    const id = this.nextId++;
    try {
      const pong = await this.request<{ t: "pong"; id: number; logs?: LogEntry[]; note?: string; hints?: ActionHintNote[] }>(
        { t: "ping", id },
        this.opts.pingGraceMs,
      );
      return {
        alive: true,
        logs: pong.logs ?? [],
        hints: pong.hints ?? [],
        ...(pong.note !== undefined ? { note: pong.note } : {}),
      };
    } catch {
      return { alive: false, logs: [], hints: [] };
    }
  }

  private async restart(reason: string): Promise<void> {
    this.consecutiveRestarts++;
    this.totalRestarts++;
    const old = this.proc;
    this.proc = null;
    this.abandonedEvals.clear();
    if (old !== null) {
      this.stalledProcs.add(old);
      // Every other snippet still waiting on this child hears why it went,
      // before the exit sweep could call it a crash.
      for (const id of this.evalsInFlight) {
        const p = this.pending.get(id);
        if (p === undefined || p.proc !== old) continue;
        this.pending.delete(id);
        p.reject(new SandboxStalledError());
      }
      try {
        old.kill(9);
      } catch {
        // already dead
      }
    }
    await this.start();
    this.notice("sandbox_restarted", `sandbox restarted (${reason}). ${this.stateLoss}`);
  }

  /**
   * Ask the child for `method` and return its value, starting a child if none
   * runs. The core's methods are `recent_events`, `action_hints` and
   * `state_summary`; any other is an extension's (`SandboxChildExtension.rpc`
   * in `child.ts`), which is how a harness drains what its extension latched.
   */
  async rpc(method: string, params: { limit?: number } = {}, character?: string): Promise<unknown> {
    await this.start();
    return this.ask(method, params, 5_000, character);
  }

  /**
   * The same ask, for a destructive drain: never spawns a child, so it answers
   * `null` when none is running (a paused run must not get a sandbox out of
   * its ticker, and with no child there is nothing to drain). Bounded by
   * `pingGraceMs`, the host's measure of how long a live child takes to
   * answer, so a child whose event loop is blocked costs that long and no more.
   */
  async drain(method: string, params: { limit?: number } = {}, character?: string): Promise<{ value: unknown } | null> {
    if (this.proc === null) return null;
    await this.ready;
    if (this.proc === null) return null;
    return { value: await this.ask(method, params, this.opts.pingGraceMs, character) };
  }

  private async ask(method: string, params: { limit?: number }, timeoutMs: number, character?: string): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method, params, ...(character !== undefined ? { seat: character } : {}) },
      timeoutMs,
    );
    if (!res.ok) throw new Error(res.error ?? `${method} rpc failed`);
    return res.value;
  }

  /** Recent events as JSON-safe summaries, via the child's SDK event buffer. */
  async recentEvents(limit: number, character?: string): Promise<EventSummary[]> {
    return ((await this.rpc("recent_events", { limit }, character)) ?? []) as EventSummary[];
  }

  /** Fan-out above 1: every seat's recent events, by character name. */
  async recentEventsAll(limit: number): Promise<Record<string, EventSummary[]>> {
    return ((await this.rpc("recent_events_all", { limit })) ?? {}) as Record<string, EventSummary[]>;
  }

  /**
   * Fan-out above 1: every seat's state reduced to what a roll-up reads
   * (`child.ts`, `stateBrief`), by character name: the snapshot's own fields
   * for identity, level, bars, flags, position, stream and last move, and
   * nothing else. What a roll-up of many characters asks for; one
   * character's whole state is `stateSnapshot(character)`.
   */
  async stateBriefs(): Promise<Record<string, Record<string, unknown>>> {
    return ((await this.rpc("state_brief_all")) ?? {}) as Record<string, Record<string, unknown>>;
  }

  /** Fan-out above 1: every seat's whole state snapshot, by character name. A roll-up wants `stateBriefs`. */
  async stateSnapshots(): Promise<Record<string, Record<string, unknown>>> {
    return ((await this.rpc("state_summary_all")) ?? {}) as Record<string, Record<string, unknown>>;
  }

  /**
   * Drain the hint-bearing failures the SDK tallied since the last drain, for a
   * tool result that is not a snippet's (`tools.ts`, `callTool`). A snippet's
   * own result and its pong drain the tally themselves; this is what lets a
   * hint raised by a background routine ride whichever tool result comes next
   * instead of waiting for the next snippet.
   *
   * Never spawns a child (`drain`): with none running there is no tally to
   * drain, and a scratchpad write must not start a sandbox.
   */
  async drainActionHints(): Promise<ActionHintNote[]> {
    const drained = await this.drain("action_hints");
    return ((drained?.value ?? []) as ActionHintNote[]);
  }

  /** JSON-safe snapshot of the child's StateCache, plus what its extensions add. */
  async stateSnapshot(character?: string): Promise<Record<string, unknown>> {
    return ((await this.rpc("state_summary", {}, character)) ?? {}) as Record<string, unknown>;
  }

  async stop(): Promise<void> {
    this.program?.stop();
    // The last of the record, while there is still a child to ask.
    if (this.recordTimer !== undefined) clearInterval(this.recordTimer);
    this.recordTimer = undefined;
    if (this.proc !== null) await Promise.race([this.recordDrain(), new Promise((r) => setTimeout(r, this.opts.pingGraceMs))]);
    const proc = this.proc;
    this.proc = null;
    if (proc === null) {
      this.opts.clientCache?.flush();
      return;
    }
    try {
      proc.send({ t: "shutdown" } satisfies HostToChild);
    } catch {
      // ignore
    }
    const drained = this.drained;
    const exited = Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1_000))]);
    await exited;
    try {
      proc.kill(9);
    } catch {
      // already gone
    }
    // The child is gone and its pipes are closing: give the pumps a moment to
    // write what they still hold, such as a last line with no newline.
    await Promise.race([drained, new Promise((r) => setTimeout(r, 250))]);
    // The child is gone, with whatever answers it forwarded on its way out:
    // the cache is on disk before the process that holds it goes.
    this.opts.clientCache?.flush();
  }
}

class SandboxExitedError extends Error {
  constructor() {
    super("sandbox process exited");
  }
}

/** The child an eval waited on was killed because its event loop stopped answering. */
class SandboxStalledError extends Error {
  constructor() {
    super("sandbox event loop blocked");
  }
}

class SandboxTimeoutError extends Error {
  constructor(readonly evalId: number) {
    super("sandbox request timed out");
  }
}
