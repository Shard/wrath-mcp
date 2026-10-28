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
 *  - Consecutive restarts are counted for the `snippet-runaway` watchdog; a
 *    successful evaluation resets the count.
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import { ScrubbedStream, SecretRedactor } from "../redact";
import { overCapText, type Scratchpad } from "../scratchpad";
import type { ClientCacheStore } from "./client-cache";
import type { ActionHintNote, ActionNote, ChildToHost, EventSummary, EvalResultMsg, HostToChild, HostcallResult, LogEntry } from "./ipc";
import { RepeatFolder } from "./log-fold";

export interface SnippetResult {
  ok: boolean;
  value?: string | undefined;
  error?: string | undefined;
  /** A note about the completion value; see `EvalResultMsg.hint`. */
  hint?: string | undefined;
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
  routine?: true;
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
  now?: () => number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
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

/** The runner's own stream of the same name: the job log, or the pod log on the cluster. */
function defaultLogSink(stream: "stdout" | "stderr", text: string): void {
  (stream === "stdout" ? process.stdout : process.stderr).write(text);
}

/** How many evals' links the host keeps for routines still dispatching under them. */
const EVAL_LINKS_MAX = 256;

/** How often a repeat still going is counted in the log (`RepeatFolder.flush`), so a reader of a live log sees it. */
const LOG_FOLD_FLUSH_MS = 60_000;

export class SandboxHost {
  private proc: Subprocess | null = null;
  private markReady: () => void = () => {};
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly abandonedEvals = new Set<number>();
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

  constructor(private readonly opts: SandboxHostOptions) {
    this.redactor.redact(opts.secret);
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
      return;
    }
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
    const readFlags = (this.opts.readDirs ?? []).map((d) => `--read=${d}`);
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
                STATE_LOSS_RECOVERY,
            );
            // Never leave a start() awaiting a dead child — this child's
            // start(), by its own resolver: the field may already belong to
            // the respawn, whose ready must wait for its seed (`onMessage`).
            markReady();
          };
          void Promise.race([stderr.done, new Promise((r) => setTimeout(r, 100))]).then(emit);
        }
        for (const [, p] of this.pending) p.reject(new SandboxExitedError());
        this.pending.clear();
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
    await this.ready;
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
        const frames = this.opts.clientCache?.snapshot() ?? [];
        if (frames.length > 0) {
          try {
            this.proc?.send({ t: "client_cache_seed", frames } satisfies HostToChild);
          } catch {
            // A child that died as it started is the onExit path's to report.
          }
        }
        markReady();
        return;
      }
      case "client_cache":
        this.opts.clientCache?.add(msg.frames);
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
      case "actions": {
        const sink = this.opts.onActions;
        if (sink === undefined) return;
        for (const b of msg.batches) {
          const link = b.evalId === null ? undefined : this.evalLinks.get(b.evalId);
          const flush: ActionsFlush = { actions: b.actions };
          if (link?.turn !== undefined) flush.turn = link.turn;
          if (link?.callTs !== undefined) flush.callTs = link.callTs;
          if (b.routine === true) flush.routine = true;
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
  async evalSnippet(code: string, link?: EvalLink): Promise<SnippetResult> {
    await this.start();
    const id = this.nextId++;
    if (link !== undefined) {
      this.evalLinks.set(id, link);
      for (const key of this.evalLinks.keys()) {
        if (this.evalLinks.size <= EVAL_LINKS_MAX) break;
        this.evalLinks.delete(key);
      }
    }
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
        },
        this.opts.snippetTimeoutMs,
      );
      this.consecutiveRestarts = 0;
      return {
        ok: res.ok,
        value: res.value,
        error: res.error,
        hint: res.hint,
        actionHints: res.hints ?? [],
        logs: res.logs,
        durationMs: res.durationMs,
      };
    } catch (err) {
      if (err instanceof SandboxExitedError) {
        return {
          ok: false,
          restarted: true,
          error: `the sandbox process exited while this snippet was running — ${STATE_LOSS_RECOVERY}`,
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
            (ping.note !== undefined ? `${ping.note} ` : "") +
            `The runtime (bindings, routines, session) is still alive. ` +
            `A walk longer than this limit is dispatched, not awaited: sdk.moveToAsync(target) returns as soon ` +
            `as the move is queued, and you poll state.self.position or the WB_MOVE_RESULT event for the ` +
            `verdict. ` +
            `Work longer than ${Math.round(this.opts.snippetTimeoutMs / 1000)}s belongs in a background ` +
            `routine (launch it without awaiting, e.g. ` +
            `\`globalThis.trip = (async () => { for (const p of waypoints) await sdk.moveTo(p); return "done"; })().catch(String); "started"\` ` +
            `— the trailing value keeps the snippet from awaiting the promise REPL-style; it returns instantly, then a later snippet checks \`await Promise.race([trip, "running"])\`); ` +
            `code that was not awaiting the SDK may still be running, so check state/events before assuming it failed.`,
          logs: ping.logs,
          // The abandoned snippet's hints: its result is discarded, so this
          // pong is the only channel that still reaches the model.
          actionHints: ping.hints,
          durationMs: this.opts.snippetTimeoutMs,
        };
      }
      await this.restart("a snippet blocked the event loop past the timeout");
      return {
        ok: false,
        timedOut: true,
        restarted: true,
        error:
          `snippet blocked the sandbox event loop past ${this.opts.snippetTimeoutMs}ms; ` +
          `the sandbox process was killed and restarted — ${STATE_LOSS_RECOVERY}`,
        logs: [],
        durationMs: this.opts.snippetTimeoutMs,
      };
    }
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
      try {
        old.kill(9);
      } catch {
        // already dead
      }
    }
    await this.start();
    this.notice("sandbox_restarted", `sandbox restarted (${reason}). ${STATE_LOSS_RECOVERY}`);
  }

  /**
   * Ask the child for `method` and return its value, starting a child if none
   * runs. The core's methods are `recent_events`, `action_hints` and
   * `state_summary`; any other is an extension's (`SandboxChildExtension.rpc`
   * in `child.ts`), which is how a harness drains what its extension latched.
   */
  async rpc(method: string, params: { limit?: number } = {}): Promise<unknown> {
    await this.start();
    return this.ask(method, params, 5_000);
  }

  /**
   * The same ask, for a destructive drain: never spawns a child, so it answers
   * `null` when none is running (a paused run must not get a sandbox out of
   * its ticker, and with no child there is nothing to drain). Bounded by
   * `pingGraceMs`, the host's measure of how long a live child takes to
   * answer, so a child whose event loop is blocked costs that long and no more.
   */
  async drain(method: string, params: { limit?: number } = {}): Promise<{ value: unknown } | null> {
    if (this.proc === null) return null;
    await this.ready;
    if (this.proc === null) return null;
    return { value: await this.ask(method, params, this.opts.pingGraceMs) };
  }

  private async ask(method: string, params: { limit?: number }, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method, params },
      timeoutMs,
    );
    if (!res.ok) throw new Error(res.error ?? `${method} rpc failed`);
    return res.value;
  }

  /** Recent events as JSON-safe summaries, via the child's SDK event buffer. */
  async recentEvents(limit: number): Promise<EventSummary[]> {
    return ((await this.rpc("recent_events", { limit })) ?? []) as EventSummary[];
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
  async stateSnapshot(): Promise<Record<string, unknown>> {
    return ((await this.rpc("state_summary")) ?? {}) as Record<string, unknown>;
  }

  async stop(): Promise<void> {
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

class SandboxTimeoutError extends Error {
  constructor(readonly evalId: number) {
    super("sandbox request timed out");
  }
}
