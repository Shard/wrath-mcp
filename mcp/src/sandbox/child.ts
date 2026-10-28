/**
 * Sandbox child process. Spawned by `host.ts` with an IPC channel; holds the
 * one long-lived SDK client for the session and evaluates snippets against it.
 * A child entry imports this module and calls `startSandboxChild` with a
 * harness's extensions (`SandboxChildExtension`, below), or with none
 * (`entry.ts`); an extension watches and reports, and adds nothing a snippet
 * can reach.
 *
 * ### What a snippet sees (the whole ambient surface, documented once, here)
 *
 *   sdk         the WrathClient for this session (constructed, not connected),
 *               and the only path to the module. Assigning to it is ignored.
 *   state       alias for sdk.state (the StateCache); a getter, like `sdk`
 *   events      alias for sdk.events (the EventStream); a getter, like `sdk`
 *   connect()   open the event stream; call before createSession. A no-op while
 *               the stream is open, and a reopen once it is not — including
 *               after something closed it. A reopen onto a character already
 *               in world (a restarted child, a resumed run) returns once the
 *               module's reattach replay has landed, so the next line reads a
 *               whole cache (`awaitReattachReplay`)
 *   sleep(ms, options?)  Promise timer that resolves with why it woke:
 *               "elapsed", or early with "attacked" (a unit started attacking
 *               us or hit us with a spell), "died" (our health reached zero,
 *               transition only) or
 *               "chat" (a party, raid or whisper line from another player).
 *               A spell hit wakes it only on the way into combat.
 *               `{ wake: false }` is a pure timer. Rejects with the abort
 *               reason if this snippet is abandoned; an awaited sleep asked
 *               for at least the time the snippet had left is named in the
 *               abandon message, and is never shortened for it
 *   signal      AbortSignal for the *current* snippet; fires when the host
 *               abandons it (timeout). Every SDK wait honors it by default.
 *   scratchpad  { read(), write(content), append(text) } — the run's markdown
 *               scratchpad, bridged to the host process which owns the file
 *   API_MD_PATH absolute path to the generated SDK reference (sdk/API.md);
 *               read it with `await Bun.file(API_MD_PATH).text()`, in slices
 *   setTimeout / setInterval / clearInterval / …  the normal timers; routines
 *               started here keep running between snippets
 *
 * Top-level `const`/`let`/`var`/`function`/`class` declarations persist across
 * snippets (copied onto globalThis after each evaluation — see rewrite.ts for
 * the exact mechanics and limitations). `import` is not available.
 *
 * ### Network posture — stated honestly
 *
 * The module is reachable only through the ambient client's own transport
 * (operator, 2026-10-19; docs/CONTRACTS.md). The client is handed the real
 * `fetch` and `WebSocket`, captured before the globals are replaced; the
 * leased credential it authenticates with is read from the environment once,
 * then struck from it, and lives in a `#`-private field a snippet cannot read
 * off `sdk`. So a snippet that builds its own `fetch`, `WebSocket` or
 * `WrathClient` has no credential and no way to send: `globalThis.fetch` and
 * `globalThis.WebSocket` refuse every host, the module's included, with a
 * readable one-line reason.
 *
 * The kernel holds the boundary under that: this process runs under the
 * Landlock ruleset `confine.ts` applied before exec, which allows TCP
 * connections to the module URL's port and no other, no bind, no exec of any
 * binary but bun, and no signal outside its domain. Those rules are per port,
 * not per host: which hosts the port is reached on, and anything that is not
 * TCP (UDP, raw sockets), is the deployment's network policy — docs/CONTRACTS.md
 * says what that leaves. `node:net`/`Bun.connect`/`Bun.fetch` can still open
 * the module's port there, but with no credential to read they authenticate
 * nothing. The in-process guard is the readable layer, not the boundary.
 *
 * ### Timeouts
 *
 * The per-snippet timeout lives in the host. A timed-out evaluation is
 * abandoned (its eventual result discarded) but the runtime, its bindings and
 * its routines survive. Abandonment is cooperative: each eval
 * runs under its own AbortController, reachable as `signal` and threaded into
 * the SDK client through AsyncLocalStorage, so the waits the abandoned code
 * left behind (`moveTo`, `killTarget`, `waitForTransfer`, …) reject with
 * `EventAbortedError` and an in-flight move is stopped. Code the snippet
 * launched without awaiting shares its async context and therefore its
 * signal: a routine started by a snippet that later times out is aborted with
 * it; one started by a snippet that returned normally is never aborted.
 * A snippet that blocks the event loop makes this process unresponsive to
 * pings; the host kills and respawns it, and the state loss is surfaced to
 * the model as a harness notice.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { API_MD_PATH as SDK_API_MD_PATH, isGroupOrWhisperChat, WrathClient, type StreamEvent } from "@wrathbench/sdk";
import { callSiteLabel, SNIPPET_URL } from "./call-site";
import { keepsAnswer, reparseFrame } from "./client-cache";
import { toJsonSafe } from "../jsonsafe";
import { compileSnippet } from "./rewrite";
import { REATTACH_REPLAY_WAIT_MS, REATTACH_STATE_WAIT_MS } from "./reattach-waits";
import type { ActionBatch, ActionHintNote, ActionNote, ChildToHost, EventSummary, HostToChild, HostcallResult, LogEntry, MoveIntentNote } from "./ipc";

export type { EventSummary } from "./ipc";

const MODULE_URL = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
// The host always passes WRATHBENCH_TOKEN; the fallback only covers running
// this file by hand, and is random rather than a fixed `"dev"` so it can never
// collide with — or be guessed alongside — a real run's session.
const TOKEN = process.env["WRATHBENCH_TOKEN"] ?? randomBytes(16).toString("hex");
// The fleet-assigned game account, bound onto the client so a snippet cannot
// pass (or omit) an account and land on the wrong one. Empty means
// unbound (standalone / running this file by hand): the client keeps its prior
// account behavior.
const ACCOUNT_ENV = process.env["WRATHBENCH_ACCOUNT"];
const ACCOUNT = ACCOUNT_ENV !== undefined && ACCOUNT_ENV.length > 0 ? ACCOUNT_ENV : undefined;
// The session secret the host leased for TOKEN (module/PROTOCOL.md,
// "Authentication"): the one credential this process holds, good for this
// token's session and nothing else. Empty means none was leased (a pre-auth
// module, or running this file by hand), and the client sends no header.
const SECRET_ENV = process.env["WRATHBENCH_SECRET"];
const SECRET = SECRET_ENV !== undefined && SECRET_ENV.length > 0 ? SECRET_ENV : undefined;
// Read once, above, into the one client this process will build — then struck
// from the environment so snippet code cannot read it back. `process.env` and
// `Bun.env` are the same store, and a snippet can print either; the leased
// secret and the bound account are credentials the ambient client holds, not
// values the model may read (docs/CONTRACTS.md, the per-token secret scope;
// operator, 2026-10-19). The token stays: it names the session, authenticates
// nothing without the secret, and the client exposes it as `sdk.token`.
delete process.env["WRATHBENCH_SECRET"];
delete process.env["WRATHBENCH_ACCOUNT"];
const VALUE_MAX_CHARS = 4_000;
const LOG_MAX_CHARS = 4_000;

const send = (msg: ChildToHost): void => {
  // Bun provides process.send when spawned with ipc; absent means we were run
  // directly (debugging) — print instead of crashing.
  const s = (process as unknown as { send?: (m: unknown) => void }).send;
  if (s) s.call(process, msg);
  else console.error("[sandbox] (no ipc)", JSON.stringify(msg).slice(0, 400));
};

// ------------------------------------------------------------ network guard
//
// The module is reachable only through the ambient client's own transport. The
// client is handed `realFetch` and `RealWebSocket` directly (captured here,
// below, before the globals are replaced), and `globalThis.fetch` /
// `globalThis.WebSocket` are then replaced with versions that refuse every
// host — the module's included. A snippet that builds its own `fetch`,
// `WebSocket` or `WrathClient` against the module therefore cannot send to it:
// the only module connection is `sdk`'s (docs/CONTRACTS.md, the per-token
// secret scope; operator, 2026-10-19). This is the readable, in-process layer;
// the kernel's per-port TCP rule (`confine.ts`) is still the boundary, and
// `node:net`/`Bun.connect`/`Bun.fetch` can still open the module's port there —
// but with no credential to read (above) such a connection authenticates
// nothing. Other hosts are refused here as before, ahead of the kernel's
// `EACCES`.

const allowedHosts = new Set<string>();
try {
  allowedHosts.add(new URL(MODULE_URL).host);
} catch {
  // leave empty; everything refused, which is the safe direction
}

const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
type FetchInput = Parameters<typeof fetch>[0];

const SNIPPET_NET_REFUSAL =
  "use the ambient sdk, state and events; snippets may not open their own connection to the module.";

/**
 * The client's own transport: `realFetch`, bounded to the module host so a
 * stray URL inside the SDK cannot reach elsewhere. Not installed as a global —
 * it is passed to the one client this process builds, and snippet code never
 * holds it. `watchedFetch` (the move watch and action log) wraps this.
 */
const moduleFetch = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url,
  );
  if (!allowedHosts.has(url.host)) {
    return Promise.reject(
      new Error(`sandbox: network egress to ${url.host} is not permitted (module only)`),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

// `globalThis.fetch` for snippet code: every host refused, the module's too.
const guardedFetch = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
  let host = "that host";
  try {
    host = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url,
    ).host;
  } catch {
    // unparsable: still refused, named generically
  }
  return Promise.reject(new Error(`sandbox: fetch to ${host} is not available — ${SNIPPET_NET_REFUSAL}`));
}) as typeof fetch;
globalThis.fetch = guardedFetch;

// Not a subclass of `RealWebSocket`: it never opens a socket, it refuses, so
// there is nothing to `super()` to. The ambient client's stream uses
// `RealWebSocket` directly (injected as `webSocketImpl`, below).
class GuardedWebSocket {
  constructor(url: string | URL, _init?: string | string[] | object) {
    let host = "that host";
    try {
      host = new URL(String(url)).host;
    } catch {
      // unparsable: still refused, named generically
    }
    throw new Error(`sandbox: WebSocket to ${host} is not available — ${SNIPPET_NET_REFUSAL}`);
  }
}
globalThis.WebSocket = GuardedWebSocket as unknown as typeof WebSocket;

// ------------------------------------------------------- movement intention

/**
 * Where the character is trying to get to: the destination of the current or
 * last `move_to`, watched at the SDK's own HTTP call rather than inside the SDK.
 *
 * The wire request is the honest place to read it. By the time the client POSTs
 * `/action`, a unit, a guid or a name has already been resolved to the point
 * the module is actually asked to walk to — so nothing here re-implements
 * `resolveMoveTarget`, and a `moveToAsync` the snippet never awaits is watched
 * on exactly the same path as an awaited `moveTo`. The verdict comes from the
 * `WB_MOVE_RESULT` the module sends, so a move that is superseded, stopped or
 * refused terminates instead of being drawn as in flight forever.
 *
 * One slot: the module runs one move at a time per session, and a newer
 * dispatch is what supersedes an older one.
 */
let moveIntent: MoveIntentNote | null = null;

/**
 * Verdicts whose `moveId` no intent has learned yet, kept until the POST that
 * carries it answers. An immediate refusal (`target_off_mesh`) lands on the
 * event stream while the ack is still in flight, and dropping it would leave
 * that move drawn as if it were still walking.
 */
const earlyVerdicts = new Map<number, { status: string; ts: number }>();
const EARLY_VERDICT_MAX = 8;

function settleMoveIntent(moveId: number, status: string, ts: number): void {
  if (moveIntent !== null && moveIntent.moveId === moveId) {
    moveIntent.status = status;
    moveIntent.endedAt = ts;
    return;
  }
  earlyVerdicts.set(moveId, { status, ts });
  for (const key of earlyVerdicts.keys()) {
    if (earlyVerdicts.size <= EARLY_VERDICT_MAX) break;
    earlyVerdicts.delete(key);
  }
}

/** The `move_to` body the SDK is about to POST, as a fresh intent. Null for anything else. */
function noteMoveDispatch(body: unknown): MoveIntentNote | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b["action"] !== "move_to") return null;
  const { x, y, z } = b;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  const pos = client.state.self.position?.value as { map?: unknown } | undefined;
  const guid = typeof b["guid"] === "string" ? b["guid"] : undefined;
  // The unit the move was aimed at, when it was aimed at one: the guid rides
  // along as the module's planning hint, and the cache is what has its name.
  const target =
    guid === undefined ? null : (client.state.units().find((u) => u.guid === guid)?.name ?? null);
  const note: MoveIntentNote = {
    moveId: null,
    map: typeof pos?.map === "number" ? pos.map : null,
    x,
    y,
    z,
    target,
    status: null,
    ts: Date.now(),
    endedAt: null,
  };
  moveIntent = note;
  return note;
}

// --------------------------------------------------------------- action log

/**
 * Every `POST /action` the client makes, with the module's answer (`ActionNote`
 * in ipc.ts), grouped by the snippet whose async context dispatched it and
 * pushed to the host, which writes it to the trajectory. Record-only: nothing
 * here is shown to the model.
 *
 * Bounded twice, because a routine re-issuing a call in a tight loop is a thing
 * runs do (one compose-era session dispatched 4.4M `move_to` in six hours):
 * consecutive identical dispatches fold into one note with a count, the way
 * `pushLog` folds console lines, and past `ACTION_LOG_MAX` notes per batch per
 * flush the rest are counted by action name instead of kept.
 */
const ACTION_LOG_MAX = 120;
const ACTION_ARG_MAX_CHARS = 200;
const ACTION_TEXT_MAX_CHARS = 240;
/** How often what background routines dispatched is flushed while no snippet runs. */
const ACTION_IDLE_FLUSH_MS = 60_000;
/** The SDK's client-parity queries (client.ts, "client-parity queries"). */
const CLIENT_PARITY_ACTIONS = new Set(["questgiver_status_query", "questgiver_status_multiple_query", "quest_query"]);

interface PendingBatch {
  evalId: number | null;
  actions: ActionNote[];
  dropped: Record<string, number>;
}
const actionBatches = new Map<number | null, PendingBatch>();

function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…(+${s.length - max + 1})`;
}

/** The body as the log keeps it: no token (operator infra), no action name, long strings clipped. */
function actionArgs(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "token" || k === "action") continue;
    out[k] = typeof v === "string" ? clipText(v, ACTION_ARG_MAX_CHARS) : v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** A guid's name as the cache holds it: the unit in view, else a name query's answer. */
function unitName(guid: string): string | undefined {
  return client.state.units().find((u) => u.guid === guid)?.name ?? client.state.nameOf(guid);
}

/**
 * Client-cache names for the ids an action carries, read before the action
 * changes anything (a destroyed item has no slot to read afterwards). Only
 * what the session already observed; never a lookup of its own.
 */
function actionNames(body: Record<string, unknown>): ActionNote["names"] {
  const names: NonNullable<ActionNote["names"]> = {};
  try {
    const state = client.state;
    const guid = typeof body["targetGuid"] === "string" ? body["targetGuid"] : body["guid"];
    if (typeof guid === "string") {
      const n = unitName(guid);
      if (n !== undefined) names.target = n;
    }
    if (typeof body["spellId"] === "number") {
      const n = state.spell(body["spellId"])?.name;
      if (n !== undefined) names.spell = n;
    }
    let item: string | undefined;
    if (typeof body["itemId"] === "number") item = state.items.get(body["itemId"])?.value.name;
    else if (typeof body["itemGuid"] === "string") {
      const g = body["itemGuid"];
      item = state.bag().items.find((i) => i.guid === g)?.name ?? state.inventory.find((i) => i.guid === g)?.name;
    } else if (typeof body["bag"] === "number" && typeof body["slot"] === "number") {
      const { bag, slot } = body as { bag: number; slot: number };
      item = state.bag().items.find((i) => i.bag === bag && i.slot === slot)?.name;
    } else if (body["action"] === "loot_item" && typeof body["slot"] === "number") {
      const id = state.lastLoot()?.items.find((i) => i.slot === body["slot"])?.itemId;
      if (id !== undefined) item = state.items.get(id)?.value.name;
    }
    if (item !== undefined) names.item = item;
    if (typeof body["questId"] === "number") {
      const n = state.quests.get(body["questId"])?.value.title ?? state.quest(body["questId"])?.title;
      if (n !== undefined) names.quest = n;
    }
  } catch {
    // A name is a convenience for the reader; the dispatch is recorded without it.
  }
  return Object.keys(names).length === 0 ? undefined : names;
}

/** Start a note for an action about to be sent, in the dispatching snippet's context. */
function beginAction(body: Record<string, unknown>): { note: ActionNote; evalId: number | null } {
  const evalId = evalContext.getStore()?.evalId ?? null;
  const action = String(body["action"]);
  const note: ActionNote = { ts: Date.now(), action, status: 0, ms: 0 };
  const args = actionArgs(body);
  if (args !== undefined) note.args = args;
  const names = actionNames(body);
  if (names !== undefined) note.names = names;
  if (evalId === null && CLIENT_PARITY_ACTIONS.has(action)) note.auto = true;
  return { note, evalId };
}

/** The module's answer arrived (or never will): fold or append the finished note. */
function finishAction(
  pending: { note: ActionNote; evalId: number | null },
  status: number,
  answer: unknown,
  failure?: string,
): void {
  const { note, evalId } = pending;
  note.status = status;
  note.ms = Date.now() - note.ts;
  const a = answer !== null && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  if (failure !== undefined) note.error = clipText(failure, ACTION_TEXT_MAX_CHARS);
  else if (status < 200 || status >= 300) {
    note.error = typeof a["error"] === "string" ? clipText(a["error"], ACTION_TEXT_MAX_CHARS) : `http_${status}`;
  }
  if (typeof a["hint"] === "string") note.hint = clipText(a["hint"], ACTION_TEXT_MAX_CHARS);
  if (typeof a["moveId"] === "number") note.moveId = a["moveId"];
  let batch = actionBatches.get(evalId);
  if (batch === undefined) {
    batch = { evalId, actions: [], dropped: {} };
    actionBatches.set(evalId, batch);
  }
  const last = batch.actions.at(-1);
  if (last !== undefined && sameAction(last, note)) {
    last.count = (last.count ?? 1) + 1;
    last.lastTs = note.ts;
    return;
  }
  if (batch.actions.length >= ACTION_LOG_MAX) {
    batch.dropped[note.action] = (batch.dropped[note.action] ?? 0) + 1;
    return;
  }
  batch.actions.push(note);
}

/** Same dispatch, same answer: everything but the clocks (and a move's own id) agrees. */
function sameAction(a: ActionNote, b: ActionNote): boolean {
  return (
    a.action === b.action &&
    a.status === b.status &&
    a.error === b.error &&
    a.hint === b.hint &&
    a.moveId === undefined &&
    b.moveId === undefined &&
    a.auto === b.auto &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.names) === JSON.stringify(b.names)
  );
}

/**
 * Push everything noted so far to the host. `finishing` is the eval whose
 * result is about to be sent: its batch is that snippet's own; a batch whose
 * snippet had already returned is a background routine's.
 */
function flushActions(finishing?: number): void {
  if (actionBatches.size === 0) return;
  const batches: ActionBatch[] = [];
  for (const b of actionBatches.values()) {
    if (b.actions.length === 0 && Object.keys(b.dropped).length === 0) continue;
    const out: ActionBatch = { evalId: b.evalId, actions: b.actions };
    if (b.evalId !== null && b.evalId !== finishing && !evalControllers.has(b.evalId)) out.routine = true;
    if (Object.keys(b.dropped).length > 0) out.dropped = b.dropped;
    batches.push(out);
  }
  actionBatches.clear();
  if (batches.length > 0) send({ t: "actions", batches });
}

// Between snippets nothing else carries a routine's dispatches home. Only while
// no snippet runs, so a snippet's own actions arrive as one batch with its result.
setInterval(() => {
  if (evalControllers.size === 0) flushActions();
}, ACTION_IDLE_FLUSH_MS).unref();

function isActionPost(input: FetchInput, init?: RequestInit): boolean {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  try {
    const href = typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url;
    return new URL(href).pathname.endsWith("/action");
  } catch {
    return false;
  }
}

/**
 * `moduleFetch` (the module-host transport) plus the move watch and the action
 * log. Passed to the client explicitly rather than installed globally, so this
 * is the client's own path and a snippet's `globalThis.fetch` — which refuses
 * every host — is not read here.
 */
const watchedFetch = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
  let note: MoveIntentNote | null = null;
  let logged: { note: ActionNote; evalId: number | null } | null = null;
  try {
    if (typeof init?.body === "string") {
      const body: unknown = JSON.parse(init.body);
      note = noteMoveDispatch(body);
      if (body !== null && typeof body === "object" && !Array.isArray(body) && isActionPost(input, init)) {
        logged = beginAction(body as Record<string, unknown>);
      }
    }
  } catch {
    // Not JSON, or not ours to read: the request is untouched either way.
  }
  const res = moduleFetch(input, init);
  if (note === null && logged === null) return res;
  return res.then(
    async (r) => {
      // Read the answer here, then hand the SDK an identical Response over the
      // same text: the note is finished before the SDK's call can return, so a
      // snippet's result never overtakes the record of its last action.
      let text: string;
      try {
        text = await r.text();
      } catch (err) {
        if (logged !== null) finishAction(logged, r.status, null, `body: ${String(err)}`);
        throw err;
      }
      let j: unknown = null;
      try {
        j = JSON.parse(text);
      } catch {
        // The SDK reports a non-JSON body itself; the log keeps the status.
      }
      if (logged !== null) finishAction(logged, r.status, j);
      // Learn the module's move id from the ack.
      const id = (j as { moveId?: unknown } | null)?.moveId;
      if (note !== null && typeof id === "number" && moveIntent === note) {
        note.moveId = id;
        const early = earlyVerdicts.get(id);
        if (early !== undefined) {
          earlyVerdicts.delete(id);
          note.status = early.status;
          note.endedAt = early.ts;
        }
      }
      return new Response(text, { status: r.status, statusText: r.statusText, headers: r.headers });
    },
    (err: unknown) => {
      // Nothing was dispatched, so there is no intention to draw.
      if (note !== null && moveIntent === note) moveIntent = null;
      if (logged !== null) finishAction(logged, 0, null, `transport: ${String(err)}`);
      throw err;
    },
  );
}) as typeof fetch;

// ------------------------------------------------------------- console tap

const logBuf: LogEntry[] = [];
let lastEntry: LogEntry | null = null;
let lastEntryBase = "";
let lastEntryRepeats = 1;

/**
 * Append to the log buffer, collapsing consecutive identical lines into one
 * entry suffixed "×N". A background routine faulting in a tight loop used to
 * fill a snippet result with thousands of repeated lines (morning-laguna-2);
 * the collapse keeps the information and drops the bulk. A drain resets the
 * run (the collapsed entry is no longer in the buffer), so counts never span
 * two snippet results.
 */
function pushLog(level: LogEntry["level"], text: string): void {
  const t = text.slice(0, LOG_MAX_CHARS);
  if (
    lastEntry !== null &&
    logBuf[logBuf.length - 1] === lastEntry &&
    lastEntry.level === level &&
    lastEntryBase === t
  ) {
    lastEntryRepeats++;
    lastEntry.ts = Date.now();
    lastEntry.text = `${t} ×${lastEntryRepeats}`.slice(0, LOG_MAX_CHARS);
    return;
  }
  lastEntry = { level, ts: Date.now(), text: t };
  lastEntryBase = t;
  lastEntryRepeats = 1;
  logBuf.push(lastEntry);
  if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500);
}

const realConsole = { ...console };
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]): void => {
    const text = args
      .map((a) => (typeof a === "string" ? a : Bun.inspect(a, { depth: 4 })))
      .join(" ");
    pushLog(level, text);
    realConsole[level]?.(...args);
  };
}

function drainLogs(): LogEntry[] {
  return logBuf.splice(0, logBuf.length);
}

/**
 * The hint-bearing failures the SDK tallied since the last drain. Drained by a
 * snippet's result (or its pong, for an abandoned one) and by the
 * `action_hints` rpc the host sends for every other tool result, so the runner
 * can render them whether or not the snippet kept the result objects, and a
 * hint raised by a background routine rides whichever tool result comes next.
 * Each drain empties the tally, so a hint is delivered once.
 *
 * `current` is the eval whose result this is, if any. A hint raised by any
 * other eval's code — a routine an earlier snippet launched, or the late
 * verdict of an earlier snippet's cast — carries `from`, the routine that
 * made the call (`callOrigin`) or else that snippet's opening code, so the
 * line can say whose it is (the 2026-10-20 party: a
 * routine's `castSpell caster_dead` printed under 51 unrelated snippets, and a
 * healer fought its own walker for six minutes).
 */
function drainHints(current?: number): ActionHintNote[] {
  const out: ActionHintNote[] = [];
  // The current snippet's own lines, one per (action, status) as before: its
  // call sites are told apart only for an earlier snippet's code.
  const own = new Map<string, ActionHintNote>();
  for (const { origin, ...h } of client.drainActionHints()) {
    const site = origin === undefined ? undefined : callSites.get(origin);
    const evalId = site?.evalId ?? origin;
    if (evalId !== undefined && evalId !== current) {
      out.push({ ...h, from: site?.label ?? snippetHeads.get(evalId) ?? "" });
      continue;
    }
    const key = `${h.action}:${h.status}`;
    const prev = own.get(key);
    if (prev === undefined) {
      own.set(key, h);
      out.push(h);
      continue;
    }
    const merged = h.ts >= prev.ts ? { ...h, count: prev.count + h.count } : { ...prev, count: prev.count + h.count };
    out[out.indexOf(prev)] = merged;
    own.set(key, merged);
  }
  return out;
}

/** How much of a snippet's opening code names it on a routine's harness line. */
const SNIPPET_HEAD_CHARS = 48;
/** Snippet heads kept for routines still running; the oldest go first. */
const SNIPPET_HEADS_MAX = 512;
/** Each eval's opening code, whitespace folded, by eval id (`drainHints`). */
const snippetHeads = new Map<number, string>();

function noteSnippetHead(id: number, code: string): void {
  const flat = code.replace(/\s+/g, " ").trim();
  snippetHeads.set(id, flat.length > SNIPPET_HEAD_CHARS ? `${flat.slice(0, SNIPPET_HEAD_CHARS - 1).trimEnd()}…` : flat);
  if (snippetHeads.size > SNIPPET_HEADS_MAX) snippetHeads.delete(snippetHeads.keys().next().value as number);
}

/** Each eval's compiled body by eval id, for the statement a stack frame in it names (`callSiteLabel`). */
const snippetBodies = new Map<number, string>();

/**
 * The SDK's `origin` for a call: the eval whose context it runs in, refined
 * to the routine that made it (`callSiteLabel`) as a site id of its own, so
 * two routines one snippet started are tallied, and labelled, apart. Site ids
 * are negative, out of the host's eval-id range.
 */
const callSites = new Map<number, { evalId: number; label: string }>();
const callSiteIds = new Map<string, number>();
const CALL_SITES_MAX = 2048;
let nextCallSite = -1;
/** Frames enough to reach a routine's entry under the SDK's own (the default is 10). */
const CALL_SITE_STACK_LIMIT = 64;

function callOrigin(): number | undefined {
  const evalId = evalContext.getStore()?.evalId;
  if (evalId === undefined) return undefined;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CALL_SITE_STACK_LIMIT;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const label = callSiteLabel(stack, evalId, snippetBodies, import.meta.url);
  if (label === undefined) return evalId;
  const key = `${evalId}\n${label}`;
  let id = callSiteIds.get(key);
  if (id === undefined) {
    // The oldest site goes first; its id is never handed out again, so a
    // tally entry still holding it cannot be read as another's.
    if (callSiteIds.size >= CALL_SITES_MAX) {
      const [oldKey, oldId] = callSiteIds.entries().next().value as [string, number];
      callSiteIds.delete(oldKey);
      callSites.delete(oldId);
    }
    id = nextCallSite--;
    callSiteIds.set(key, id);
    callSites.set(id, { evalId, label });
  }
  return id;
}

// -------------------------------------------------------- ambient snippet API

/**
 * The eval whose async context we are in, if any. Set by `evaluate`. `evalId`
 * is the host's id for it, which the action log groups by: a routine a snippet
 * launched shares that snippet's context, and so its id.
 */
const evalContext = new AsyncLocalStorage<{ evalId: number; signal: AbortSignal; deadline?: number; timeoutMs?: number }>();
const currentSignal = (): AbortSignal | undefined => evalContext.getStore()?.signal;
/** When the host will abandon the snippet we are inside, if it said. */
const currentDeadline = (): number | undefined => evalContext.getStore()?.deadline;
/**
 * What the last abandoned eval learned as it unwound — set from an error that
 * carried a `moveAbandon` sentence (the SDK's, for a walk), a `waitAbandon`
 * one (the SDK's, for `reclaimCorpse`'s wait) or a `sleepAbandon` one
 * (`sleep`'s, below), drained by the liveness pong that follows the abort.
 * One slot: the host pings immediately after aborting, and only the abandoned
 * snippet is unwinding at that moment.
 */
let abandonNote: string | undefined;
/**
 * Resolves when the eval an `abort` just interrupted finishes unwinding. The
 * host sends `abort` then `ping` back-to-back; when both land in one IPC chunk
 * the pong would read `abandonNote` before the SDK rejection has climbed the
 * snippet's await chain to set it, and the note the abort learned is silently
 * lost. A snippet that ignores its signal never settles, so the pong's wait on
 * this is bounded (ABANDON_UNWIND_GRACE_MS), well under the host's pingGraceMs.
 */
let abandonUnwind: Promise<void> | undefined;
const abandonUnwindSettled = new Map<number, () => void>();
const ABANDON_UNWIND_GRACE_MS = 100;
/** The eval the last `abort` abandoned: the pong that follows is its result, so its own hints are not a routine's. */
let abandonedEval: number | undefined;
/** Live controllers by eval id, for the host's `abort`. */
const evalControllers = new Map<number, AbortController>();

const client = new WrathClient({
  baseUrl: MODULE_URL,
  token: TOKEN,
  secret: SECRET,
  account: ACCOUNT,
  subscribeEvents: false,
  signal: currentSignal,
  deadline: currentDeadline,
  // The eval whose code is calling, and the routine in it that called: a
  // routine keeps the id of the snippet that launched it, so its harness
  // lines can say whose they are (`drainHints`, `callOrigin`).
  origin: callOrigin,
  fetchImpl: watchedFetch,
  // The real WebSocket, captured before `globalThis.WebSocket` was replaced
  // with the refusing guard: this is the ambient client's own event stream,
  // the one module connection a snippet cannot open for itself.
  events: { webSocketImpl: RealWebSocket },
});

// The module's verdict on a move, whoever issued it: an awaited `moveTo`
// resolves from the same event, and this sees the ones nothing awaited.
client.events.on("WB_MOVE_RESULT", (e) => {
  const d = e.data as { moveId?: unknown; status?: unknown } | null;
  if (typeof d?.moveId === "number" && typeof d.status === "string") {
    settleMoveIntent(d.moveId, d.status, typeof e.ts === "number" ? e.ts : Date.now());
  }
});

let hostcallId = 0;
const hostcallPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function hostcall(method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append", params: { content?: string } = {}): Promise<unknown> {
  const id = ++hostcallId;
  return new Promise((resolve, reject) => {
    hostcallPending.set(id, { resolve, reject });
    send({ t: "hostcall", id, method, params });
  });
}

// ------------------------------------------------ scratchpad writes, watched
//
// A scratchpad write over the cap is refused and its promise rejects (host.ts).
// Awaited, that is the snippet's error like any other. Not awaited — the usual
// shape, `scratchpad.append(note); return …` — the rejection would land after
// the snippet's result had gone, and reach the model only as a background
// fault on its next turn; a model that never awaited its appends lost eighty
// turns of notes to a `{ truncated }` it never read. So each write remembers
// whether the snippet ever attached to it, and a snippet's result waits for
// the writes it made: an unobserved refusal becomes that snippet's error.

/** One scratchpad write, as the snippet that made it may or may not have kept it. */
interface PadCall {
  /** The eval it was made in (`evalContext`), if any. */
  evalId: number | undefined;
  /** Something attached to the promise: an await, then, catch or finally. */
  observed: boolean;
  settled: boolean;
  error: Error | undefined;
  /** Its refusal has been reported, in a result or as a background fault. Once only. */
  reported: boolean;
  /** Resolves once the call has settled, either way. */
  done: Promise<void>;
}

/** Report an unobserved refusal as a background fault, once. */
function reportPadCall(call: PadCall): void {
  if (call.error === undefined || call.observed || call.reported) return;
  call.reported = true;
  reportBackgroundError("unhandled promise rejection", call.error);
}

/**
 * The promise a snippet gets back. A subclass, because that is the only way to
 * see an `await`: the runtime awaits a native promise without calling its
 * `then`, but calls `then` on any other thenable. Derived promises are plain
 * (`Symbol.species`), so only the one handed out is watched.
 */
class PadPromise<T> extends Promise<T> {
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  call: PadCall | undefined;

  override then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    if (this.call !== undefined) this.call.observed = true;
    return super.then(onFulfilled, onRejected);
  }
}

/** The writes each still-running snippet made, until its result collects them. */
const padCallsByEval = new Map<number, Set<PadCall>>();

/** How long a snippet's result waits for its writes. A hostcall is one IPC round trip. */
const PAD_SETTLE_MS = 1_000;

function padWrite(method: "scratchpad_write" | "scratchpad_append", content: string): Promise<unknown> {
  const evalId = evalContext.getStore()?.evalId;
  let markDone!: () => void;
  const call: PadCall = {
    evalId,
    observed: false,
    settled: false,
    error: undefined,
    reported: false,
    done: new Promise<void>((resolve) => (markDone = resolve)),
  };
  let resolveCall!: (v: unknown) => void;
  let rejectCall!: (e: unknown) => void;
  const p = new PadPromise<unknown>((resolve, reject) => {
    resolveCall = resolve;
    rejectCall = reject;
  });
  p.call = call;
  if (evalId !== undefined && evalControllers.has(evalId)) {
    let calls = padCallsByEval.get(evalId);
    if (calls === undefined) padCallsByEval.set(evalId, (calls = new Set()));
    calls.add(call);
  }
  const settle = (error: Error | undefined): void => {
    call.settled = true;
    call.error = error;
    markDone();
    if (error === undefined) return;
    // Its snippet is still running: that snippet's result reports it.
    if (evalId !== undefined && padCallsByEval.get(evalId)?.has(call) === true) return;
    // A background routine's write, or one that outlived its snippet's
    // result: reported like any unhandled rejection, a tick later so a late
    // await can still claim it.
    setTimeout(() => reportPadCall(call), 0);
  };
  // The harness's own handler goes on through the base `then`: it does not
  // count as the snippet observing the call, and it keeps the runtime's
  // unhandled-rejection hook out of it, so the refusal is reported once.
  Promise.prototype.then.call(
    p,
    () => settle(undefined),
    (err: unknown) => settle(err instanceof Error ? err : new Error(String(err))),
  );
  hostcall(method, { content }).then(resolveCall, rejectCall);
  return p;
}

/**
 * The refusals among the writes snippet `id` made and never attached to,
 * after waiting up to PAD_SETTLE_MS for any still in flight. Collecting ends
 * the snippet's claim: a write still unsettled after the wait is reported as a
 * background fault when it settles.
 */
async function collectPadRefusals(id: number): Promise<Error[]> {
  const calls = padCallsByEval.get(id);
  if (calls === undefined) return [];
  const pending = [...calls].filter((c) => !c.settled).map((c) => c.done);
  if (pending.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, PAD_SETTLE_MS))),
    ]);
    clearTimeout(timer);
  }
  padCallsByEval.delete(id);
  const refused: Error[] = [];
  for (const c of calls) {
    if (c.error === undefined || c.observed || c.reported) continue;
    c.reported = true;
    refused.push(c.error);
  }
  return refused;
}

/**
 * An eval that ends without collecting — abandoned, or failing before it got
 * there: its unobserved refusals go the background-fault way, which the
 * abandon's pong carries, and its writes still in flight follow when they
 * settle. Called on abort too, so a snippet that ignores its signal and never
 * finishes cannot sit on a refusal.
 */
function releasePadCalls(id: number): void {
  const calls = padCallsByEval.get(id);
  if (calls === undefined) return;
  padCallsByEval.delete(id);
  for (const c of calls) reportPadCall(c);
}

// The generated SDK reference (sdk/API.md), at a stable absolute path a snippet
// can read: `await Bun.file(API_MD_PATH).text()`. It is larger than one snippet
// result, so read it in slices (one `## ` section, or lines filtered by name).
// The SDK names its own file (`API_MD_PATH` in @wrathbench/sdk), so the path
// does not depend on the cwd, which the child does not control, nor on where
// this package sits beside the SDK.
const API_MD_PATH = SDK_API_MD_PATH;

/**
 * Why `sleep` resolves. `elapsed` is the timer; the others are the world
 * interrupting a wait the model would want to react to.
 */
export type SleepReason = "elapsed" | "attacked" | "died" | "chat";

/**
 * The abandon-note sentence for a sleep of `ms` starting now, or undefined when
 * it fits in what its snippet has left — or when no budget is known.
 *
 * One e360 run awaited `sleep(30000, { wake: false })` against a 30000ms
 * ceiling 32 times in six hours and was told only that the snippet timed out,
 * so it never learned that the sleep itself was the reason. The note states
 * what was asked, the ceiling, and that the sleep cannot finish inside the
 * snippet; it says nothing about what to do instead. A sleep of the ceiling or
 * longer can never finish inside any snippet, and the note says so; a shorter
 * one started too late could not finish inside this one, and the note says
 * that instead, since the first would not be true of it.
 *
 * A deadline already past is a budget we do not know, not a budget of zero —
 * the same rule as the SDK's walk estimate: a background routine inherits the
 * async context (and so the deadline) of the snippet that launched it, and that
 * snippet's clock may have run out long ago.
 */
function sleepOverrunNote(ms: number): string | undefined {
  const store = evalContext.getStore();
  if (store?.deadline === undefined || store.timeoutMs === undefined) return undefined;
  const left = store.deadline - Date.now();
  if (left <= 0 || ms < left) return undefined;
  const head = `a sleep(${ms}) was still waiting when this was abandoned: it was asked for ${ms}ms`;
  return ms >= store.timeoutMs
    ? `${head} and the snippet time limit is ${store.timeoutMs}ms, so a sleep that long can never finish inside one snippet.`
    : `${head} when this snippet had ${Math.round(left)}ms of its ${store.timeoutMs}ms time limit left, so it could never finish inside this snippet.`;
}

/**
 * The rejection for an abandoned sleep that could never have finished: a fresh
 * error with the abort reason's name and message, so code that catches it
 * reads exactly what it always read, carrying the note as `sleepAbandon` the
 * way the SDK's walk carries `moveAbandon`. Fresh rather than the reason
 * itself, which every other wait of the snippet rejects with too. `evaluate`
 * reads the note only when this rejection is what the snippet was awaiting.
 */
function withSleepAbandon(reason: unknown, note: string): Error {
  const base = reason instanceof Error ? reason : new Error(String(reason));
  const err = new Error(base.message, { cause: reason });
  err.name = base.name;
  (err as { sleepAbandon?: string }).sleepAbandon = note;
  return err;
}

/**
 * `sleep(ms)` — a timer that also wakes for the things a sleeping snippet
 * most needs to hear about, and says which happened.
 *
 * Sleep is blind: nothing about `await sleep(28000)` notices a mob walking up
 * behind the character, and the trajectories are full of 28-second naps that
 * ended in a corpse. So the timer additionally resolves early when the server
 * says a unit started attacking *us* (`SMSG_ATTACKSTART` with our guid as the
 * victim) or a unit's spell hit us (`SMSG_SPELLNONMELEEDAMAGELOG` with our
 * guid as the target and another unit as the caster — a caster never starts
 * a melee attack, and one Deadmines rogue slept from 627 to 460 health under
 * an Evoker's spells; the SDK observes no hostility, so "another unit" is the
 * test, and only a hostile unit's spell can damage us), when our own health
 * is observed reaching zero, or when another
 * player says something to our group or to us (a party, raid or raid-warning
 * line, or a whisper received — the party runs' sleeps were mostly polls of
 * `state.chat`, and one slept through a resurrection offer), and the resolved
 * value names the reason. Our own lines, our whisper's echo, creature speech
 * and say/yell/emote/channel/system lines do not wake it. Ignoring the value
 * costs nothing, and an early resolve is harmless inside
 * `Promise.race([routine, sleep(ms)])` — the race's whole point is that the
 * first settle wins.
 *
 * Three deliberate non-wakes:
 *   - `died` fires on the *transition* only. A snippet that sleeps while
 *     already dead (waiting out the corpse reclaim delay is the single most
 *     common long sleep in the runs) is not woken by the death it is already
 *     handling.
 *   - A spell hit wakes it only on the way *into* combat, as the melee wake
 *     already does by construction (`SMSG_ATTACKSTART` comes once per new
 *     attacker, not per swing). Every hit used to wake it, and in Deadmines
 *     attempt a8 that turned a mage's `sleep(200)` cast loop into a busy loop
 *     — 837 `not_ready` casts in twenty seconds, then a death. The sleep is
 *     armed for spell hits when `UNIT_FLAG_IN_COMBAT` is clear on our own
 *     `unitFlags` as it begins (an unobserved field reads as clear, the old
 *     behaviour), and re-armed whenever the bit is seen clear during it. The
 *     bit rising during the sleep never disarms it: aggro sets it before a
 *     caster's first bolt lands, usually in the same server tick, so reading
 *     it at the hit would sleep through exactly the caster wake this exists
 *     for.
 *   - `{ wake: false }` is a pure timer for a caller that wants one: nothing
 *     wakes it, chat included. Chat used to wake it too, and in a8 the party
 *     leader's lines cut 22 of the tank's 55 sleeps short, so every member
 *     wrapped its timers in `while (Date.now() - t0 < N)` loops and none ever
 *     read the reason.
 *
 * The ambient snippet signal still aborts it: an abandoned snippet's sleep
 * rejects rather than resolving. When the sleep was asked for at least the
 * time its snippet had left as it began, the rejection also carries a sentence
 * saying so (`sleepOverrunNote`), which the abandon message states if the
 * rejection is what the snippet was awaiting. Nothing about the timer changes
 * for it — the sleep runs for exactly what it was asked (docs/METHODOLOGY.md,
 * "A deadline explains, never caps").
 */
/** `UNIT_FLAG_IN_COMBAT` (AzerothCore `UnitDefines.h`): the bit a client reads for the combat icon on its own frame. */
const UNIT_FLAG_IN_COMBAT = 0x0008_0000;

/** The combat bit on our own `unitFlags`; false while no block has carried the field. */
function selfInCombat(): boolean {
  const flags = client.state.self.fields.get("unitFlags")?.value;
  return typeof flags === "number" && (flags & UNIT_FLAG_IN_COMBAT) !== 0;
}

function sleep(ms: number, options?: { wake?: boolean }): Promise<SleepReason> {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    const shown = ms === undefined ? "undefined" : typeof ms === "number" ? String(ms) : typeof ms;
    throw new TypeError(
      `sleep(ms) needs a non-negative number of milliseconds, got ${shown} — e.g. sleep(2000), ` +
        `or sleep(2000, { wake: false }) for a timer that ignores being attacked`,
    );
  }
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new TypeError(`sleep(ms, options) needs an options object, got ${typeof options} — the only option is { wake }`);
  }
  const wakeOpt = options?.wake;
  if (wakeOpt !== undefined && typeof wakeOpt !== "boolean") {
    throw new TypeError(`sleep(ms, { wake }) needs a boolean, got ${typeof wakeOpt} — { wake: false } is a pure timer`);
  }

  return new Promise<SleepReason>((resolve, reject) => {
    const signal = currentSignal();
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    // Read as the sleep begins: "the time the snippet had left" is the time it
    // had left when this sleep started, not when it was abandoned.
    const overrun = sleepOverrunNote(ms);
    const selfDead = (): boolean => client.state.self.health?.value.current === 0;
    // Already dead when the sleep started: this snippet is handling that death,
    // so only a *later* one wakes it.
    let deadAtLastCheck = selfDead();
    // Armed for a spell-hit wake only while out of combat (see above): set as
    // the sleep begins, re-armed by the bit seen clear, never disarmed.
    let spellWakeArmed = !selfInCombat();
    let offAttack: (() => void) | undefined;
    let offSpellHit: (() => void) | undefined;
    let offChat: (() => void) | undefined;
    let offAny: (() => void) | undefined;

    const settle = (reason: SleepReason): void => {
      cleanup();
      resolve(reason);
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      offAttack?.();
      offSpellHit?.();
      offChat?.();
      offAny?.();
    }
    function onAbort(): void {
      cleanup();
      reject(overrun === undefined ? signal?.reason : withSleepAbandon(signal?.reason, overrun));
    }
    const timer = setTimeout(() => settle("elapsed"), ms);
    signal?.addEventListener("abort", onAbort, { once: true });

    // Registered after the client's own state fold (`onAny` handlers run in
    // registration order and the cache is the first one), so all of these see
    // a state cache that already has this event in it.
    if (wakeOpt === false) return;
    offChat = client.events.on("SMSG_MESSAGECHAT", (e) => {
      const d = e.data as { type?: unknown; senderGuid?: unknown };
      const me = client.state.self.guid;
      const fromOther = me !== undefined && typeof d?.senderGuid === "string" && d.senderGuid !== me;
      if (fromOther && isGroupOrWhisperChat(d)) settle("chat");
    });
    offAttack = client.events.on("SMSG_ATTACKSTART", (e) => {
      const d = e.data as { victimGuid?: unknown };
      const me = client.state.self.guid;
      if (me !== undefined && typeof d?.victimGuid === "string" && d.victimGuid === me) settle("attacked");
    });
    offSpellHit = client.events.on("SMSG_SPELLNONMELEEDAMAGELOG", (e) => {
      const d = e.data as { targetGuid?: unknown; casterGuid?: unknown };
      const me = client.state.self.guid;
      if (me !== undefined && d?.targetGuid === me && typeof d?.casterGuid === "string" && d.casterGuid !== me) {
        if (spellWakeArmed) settle("attacked");
      }
    });
    offAny = client.events.onAny(() => {
      if (!selfInCombat()) spellWakeArmed = true;
      const dead = selfDead();
      if (!dead) {
        // Alive again (a reclaim, a resurrect): a later death is a new one.
        deadAtLastCheck = false;
        return;
      }
      if (!deadAtLastCheck) settle("died");
    });
  });
}

/**
 * After a reopen, wait for the reattach replay to land (module/PROTOCOL.md,
 * "/events"): the `WB_SESSION_STATE` the subscribe answers with and, when it
 * says `replay: true`, the `WB_REPLAY_DONE` that closes the burst. Only live
 * frames count — the buffer may hold an earlier reopen's — and nothing here
 * throws: a stream with no session behind it, a module from before the
 * replay, or a burst slower than the wait all end the same way, with
 * `connect()` returning and the cache filling as frames arrive. The snippet's
 * own abort ends the wait too.
 */
async function awaitReattachReplay(): Promise<void> {
  const signal = currentSignal();
  const live = (predicate: (e: StreamEvent) => boolean, timeout: number): Promise<StreamEvent | undefined> =>
    client.events.waitFor(predicate, { timeout, includeBuffered: false, signal }).catch(() => undefined);
  const state = await live((e) => e.opcode === "WB_SESSION_STATE", REATTACH_STATE_WAIT_MS);
  if (state === undefined) return;
  if ((state.data as { replay?: unknown } | null)?.replay !== true) return;
  await live((e) => e.opcode === "WB_REPLAY_DONE" && e.seq > state.seq, REATTACH_REPLAY_WAIT_MS);
}

const ambient: Record<string, unknown> = {
  API_MD_PATH,
  /**
   * Open the event stream, reading the stream itself for whether it is already
   * open. Cheap when it is; a reopen when it is not, including after a snippet
   * closed it (`events.close()`, or a cleanup loop calling `.close()` on every
   * closable binding — which is how one freeplay run spent fifteen hours
   * reading a frozen state cache while `connect()` kept answering ok over a
   * dead socket). A latched "we connected once" flag cannot tell the difference
   * and so could only lie; `connected` is the fact.
   *
   * What comes back after a reopen is the module's business, and it already
   * does the right thing: a subscribe to a session that is in world gets a
   * `WB_SESSION_STATE` and then the reattach replay (PROTOCOL.md, "/events"):
   * the character's own create block with every item, its auras, the login
   * packets and a create block for everything in view, all folding into the
   * cache, with the events missed while the socket was down shown as one
   * `stream_gap`. This waits for that replay (`awaitReattachReplay`) so the
   * line after `await connect()` reads a whole cache, which is what the
   * restart notice promises. A session that is gone is not re-created here —
   * the refusal is the honest answer, and it is the caller's to read.
   */
  connect: async (): Promise<void> => {
    if (client.events.connected) return;
    // An explicit connect() onto a session already in world is a consumer
    // that holds nothing (a restarted child, a resumed run, a snippet that
    // closed the stream), so it asks for the replay; the stream's own
    // reconnects after a drop never do.
    await client.events.connect({ replay: true });
    await awaitReattachReplay();
  },
  sleep,
  scratchpad: {
    read: (): Promise<unknown> => hostcall("scratchpad_read"),
    write: (content: string): Promise<unknown> => padWrite("scratchpad_write", content),
    append: (text: string): Promise<unknown> => padWrite("scratchpad_append", text),
  },
};
Object.assign(globalThis, ambient);
// `signal` is per-eval, so it is a getter over the async context rather than a
// value: an abandoned snippet keeps seeing its own (aborted) signal after the
// next eval has started. The setter keeps a snippet's own `const signal = …`
// copy-back (rewrite.ts) from throwing; it has no effect.
Object.defineProperty(globalThis, "signal", {
  get: currentSignal,
  set: () => {},
  configurable: true,
  enumerable: true,
});

// `sdk`, `state` and `events` are getters over the one client, not values, so a
// snippet cannot lose the session by overwriting them. A cleanup snippet that
// set `sdk = null` (and a `.close()` sweep over every binding) is how one
// freeplay run went on sampling a dead session while the model, having nulled
// its only handle, built a second client to carry on (#74). The no-op setter
// swallows the assignment — and the copy-back a `let sdk = …` leaves behind
// (rewrite.ts) — so the next access returns the live client; `connect()`
// reopens the stream under it. The getters are not the credential boundary (the
// `#secret` field and the net guard are); they keep the session reachable.
for (const name of ["sdk", "state", "events"] as const) {
  const get = name === "sdk" ? (): unknown => client : name === "state" ? (): unknown => client.state : (): unknown => client.events;
  Object.defineProperty(globalThis, name, { get, set: () => {}, configurable: true, enumerable: true });
}

// ---------------------------------------------------------------- evaluate

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (
  ...fnArgs: unknown[]
) => Promise<unknown>;

/**
 * The one-line wrapper `compileSnippet` puts above the user's source
 * (`const __wrathbench_snippet__ = async () => {\n`), so a transpiler
 * position's 1-based line N is the user's line N-1.
 */
const WRAPPER_LINE_OFFSET = 1;

interface BuildPosition {
  line?: number;
  column?: number;
  lineText?: string;
}

/** One transpiler diagnostic as a line the model can act on. */
function renderBuildMessage(err: { message?: string; position?: BuildPosition | null }): string {
  const msg = err.message ?? "parse error";
  const pos = err.position;
  if (pos == null || typeof pos.line !== "number") return msg;
  const line = Math.max(1, pos.line - WRAPPER_LINE_OFFSET);
  const col = typeof pos.column === "number" ? `:${pos.column}` : "";
  const text = typeof pos.lineText === "string" && pos.lineText.length > 0 ? ` — ${pos.lineText}` : "";
  return `${msg} at line ${line}${col}${text}`;
}

const BIGINT_STRINGIFY_RE = /serialize\s+(a\s+)?BigInt/i;

/**
 * Render a caught error for the model. Three cases earn special handling,
 * all observed misrendering in live runs:
 *   - Bun transpiler failures: an AggregateError whose message is literally
 *     "Parse error" — flatten the sub-errors with their positions instead
 *     (line numbers corrected for the compile wrapper).
 *   - a single BuildMessage (one parse error) — same, without the wrapper.
 *   - JSON.stringify on a bigint — keep the TypeError but name the fix.
 */
export function renderError(err: unknown): string {
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length > 0) {
    const subs = err.errors.map((e) => renderBuildMessage(e as { message?: string; position?: BuildPosition }));
    return `${err.name}: ${err.message}\n${subs.map((s) => `  ${s}`).join("\n")}`;
  }
  if (err instanceof Error) {
    // A lone Bun BuildMessage (one parse error) carries a `position` too.
    const pos = (err as { position?: BuildPosition | null }).position;
    if (pos != null && typeof pos.line === "number") {
      return `${err.name}: ${renderBuildMessage(err as { message?: string; position?: BuildPosition })}`;
    }
    // SDK guids are plain strings, so only a bigint the snippet
    // itself conjured (a 123n literal) can reach this — still worth naming.
    if (err instanceof TypeError && BIGINT_STRINGIFY_RE.test(err.message)) {
      return (
        `${err.name}: ${err.message} — JSON.stringify throws on BigInt values; ` +
        `SDK guids are already plain strings, so convert your own bigints with ` +
        `String(x), template literals, or console.log directly`
      );
    }
    return `${err.name}: ${err.message}`;
  }
  return Bun.inspect(err).slice(0, 1_000);
}

// A timed-out evaluation's late result is discarded host-side (the host
// abandons the id), so the child always reports. What it does track is the
// eval's AbortController, so a host `abort` can fire the snippet's signal.
async function evaluate(id: number, code: string, deadline?: number, timeoutMs?: number): Promise<void> {
  const started = Date.now();
  const controller = new AbortController();
  evalControllers.set(id, controller);
  noteSnippetHead(id, code);
  try {
    const compiled = compileSnippet(code);
    // Tagged so a stack frame in this snippet's code names it (`callSiteLabel`).
    const tag = `\n//# sourceURL=${SNIPPET_URL}${id}`;
    let fn: ((...args: unknown[]) => Promise<unknown>) | null = null;
    let body = compiled.statementsBody;
    if (compiled.canTryExpression) {
      try {
        // Single-expression snippets get REPL semantics: their value comes back.
        fn = new AsyncFunction(compiled.expressionBody + tag);
        body = compiled.expressionBody;
      } catch {
        fn = null;
      }
    }
    fn ??= new AsyncFunction(compiled.statementsBody + tag);
    snippetBodies.set(id, body);
    if (snippetBodies.size > SNIPPET_HEADS_MAX) snippetBodies.delete(snippetBodies.keys().next().value as number);
    const run = fn;
    const value: unknown = await evalContext.run({ evalId: id, signal: controller.signal, deadline, timeoutMs }, () =>
      run.call(globalThis),
    );
    // A scratchpad write the snippet did not await and the cap refused is this
    // snippet's error; its value still comes back beside it. Collected before
    // the logs are drained, so a log line written while waiting is not lost.
    let refused = await collectPadRefusals(id);
    if (controller.signal.aborted) {
      // Abandoned while waiting: this result will be discarded, so the
      // refusals go the background way and ride the pong.
      for (const e of refused) reportBackgroundError("unhandled promise rejection", e);
      refused = [];
    }
    const msg: ChildToHost = {
      t: "result",
      id,
      ok: refused.length === 0,
      logs: drainLogs(),
      hints: drainHints(id),
      durationMs: Date.now() - started,
    };
    if (refused.length > 0) msg.error = refused.map(renderError).join("\n");
    if (value !== undefined) msg.value = Bun.inspect(value, { depth: 4 }).slice(0, VALUE_MAX_CHARS);
    // A snippet whose completion value is a function defined a wrapper and then
    // never invoked it, so nothing it wrote actually ran: `north-mini-code`
    // wrapped all 120 of its snippets in `async () => { … }` and got a cheerful
    // `ok` plus `[AsyncFunction (anonymous)]` every time, never connecting to
    // the world at all. The harness will not call it for the model (repair
    // only what has exactly one reading, and "define a callback for later" is
    // a second one) — it says what it sees.
    if (typeof value === "function") {
      msg.hint =
        "the snippet returned a function it never called — call it (await fn()) or return its " +
        "result; nothing in that function body has run.";
    }
    // The action log first, so the host has recorded what this snippet
    // dispatched before its tool result exists.
    flushActions(id);
    send(msg);
  } catch (err) {
    // An aborted eval's result is discarded host-side, and with it the one
    // thing the abort knew: how far the move it interrupted had got (the SDK
    // hangs that sentence on the error as `moveAbandon`), or that the sleep it
    // was awaiting could never have finished (`sleepAbandon`, from `sleep`).
    // Keep it for the pong, which is the only channel the model still sees.
    // Read off the error that reached this catch, so only a wait the snippet
    // was awaiting can name itself as what ran the snippet out. A snippet can
    // throw anything, `undefined` and `null` included, and a read that threw
    // here would send no result at all: the host would wait out the ceiling
    // and report a timeout for a snippet that failed at once.
    if (controller.signal.aborted) {
      const thrown = err as { moveAbandon?: unknown; waitAbandon?: unknown; sleepAbandon?: unknown } | null | undefined;
      const carried = [thrown?.moveAbandon, thrown?.waitAbandon, thrown?.sleepAbandon].find((n) => typeof n === "string");
      if (typeof carried === "string") abandonNote = carried;
    }
    // Not for an abandoned eval: its result is discarded, so its refusals go
    // the background way (`releasePadCalls`, below) and ride the pong.
    const refused = controller.signal.aborted ? [] : await collectPadRefusals(id);
    flushActions(id);
    // An aborted eval's result is discarded host-side; its logs must not go
    // with it — leave them in the buffer for the liveness pong that follows.
    send({
      t: "result",
      id,
      ok: false,
      error: [renderError(err), ...refused.map(renderError)].join("\n"),
      // As with the logs: an abandoned eval's result is discarded host-side, so
      // its hints must stay in the SDK's tally for the pong that follows.
      logs: controller.signal.aborted ? [] : drainLogs(),
      hints: controller.signal.aborted ? [] : drainHints(id),
      durationMs: Date.now() - started,
    });
  } finally {
    releasePadCalls(id);
    evalControllers.delete(id);
    const settled = abandonUnwindSettled.get(id);
    if (settled !== undefined) {
      abandonUnwindSettled.delete(id);
      settled();
    }
  }
}

/** Host abandoned this eval: fire its signal. Idempotent; unknown ids are ignored. */
function abortEval(id: number): void {
  const controller = evalControllers.get(id);
  if (controller === undefined) return;
  evalControllers.delete(id);
  releasePadCalls(id);
  abandonedEval = id;
  abandonUnwind = new Promise((resolve) => abandonUnwindSettled.set(id, resolve));
  const reason = new Error(`snippet abandoned by the harness (timeout); pending waits cancelled`);
  abandonReasons.add(reason);
  controller.abort(reason);
}

/**
 * The reasons `abortEval` aborted with. An abandoned snippet's pending calls
 * reject with one of them: `sleep` with the reason itself, a sleep that could
 * never have fit with it as `cause` (`withSleepAbandon`), an SDK wait as an
 * `EventAbortedError` whose `reason` it is. A call the snippet launched and did
 * not await rejects unhandled with that, after the abandonment's own report
 * has already told the model its pending waits were cancelled; it is the
 * harness's doing and no fault of the sandbox. Identity, not the class: a
 * wait the snippet cancelled with its own AbortController is still the
 * snippet's fault to hear about.
 */
const abandonReasons = new WeakSet<object>();

/** Whether `reason` is the harness abandoning a snippet, directly or as what an aborted wait carries. */
function isHarnessAbandonment(reason: unknown): boolean {
  let r = reason;
  for (let depth = 0; depth < 4 && typeof r === "object" && r !== null; depth++) {
    if (abandonReasons.has(r)) return true;
    const carried = r as { reason?: unknown; cause?: unknown };
    r = carried.reason !== undefined ? carried.reason : carried.cause;
  }
  return false;
}

// ------------------------------------------------------------ client cache

/**
 * The client's query-answer cache, kept across a restart the way a client
 * keeps its on-disk cache (`client-cache.ts`). Each answer the SDK folds is
 * forwarded to the host as it arrives — this process cannot write the run
 * directory — and a starting child is handed what the host holds before it
 * is ready (`seedClientCache`).
 *
 * Registered once, where an extension asks for it in its own listener order
 * (`SandboxChildApi.forwardClientCache`), or else after every extension has
 * installed: `onAny` listeners run in registration order and one that throws
 * stops the rest, so where this one sits is part of the child's behaviour.
 */
let clientCacheForwarded = false;

function forwardClientCache(): void {
  if (clientCacheForwarded) return;
  clientCacheForwarded = true;
  client.events.onAny((event) => {
    if (!keepsAnswer(event)) return;
    send({
      t: "client_cache",
      frames: [{ seq: event.seq, opcode: event.opcode, opcodeId: event.opcodeId, ts: event.ts, data: event.data }],
    });
  });
}

/**
 * Fold the host's cached answers into the SDK cache through the SDK's own
 * `apply`, the path a live frame takes, so each map holds exactly what it held
 * before the restart, `seq` and `ts` included. Straight into the cache and
 * nowhere else: not the event stream (`events.recent()`, the turn's event
 * window), not the recorders, not the client-parity queries, none of which
 * these frames are new to. The cache's own stream counters are put back as
 * they were, because the HUD prints them and no event has arrived.
 */
function seedClientCache(frames: readonly unknown[]): void {
  const state = client.state;
  const { eventCount, lastSeq, lastTs } = state;
  for (const raw of frames) {
    const frame = reparseFrame(raw);
    if (frame === null) continue;
    try {
      state.apply(frame as StreamEvent);
    } catch {
      // One answer that will not fold costs that one name, not the seed.
    }
  }
  state.eventCount = eventCount;
  state.lastSeq = lastSeq;
  state.lastTs = lastTs;
}

// --------------------------------------------------------------- extensions

/**
 * What a harness adds to this child, in-process: watchers on the event stream
 * that latch what it records, named rpc methods its host drains them through,
 * decoration on the event summaries every reader of the buffer gets, and the
 * fields its HUD reads off the state snapshot. Installed by
 * `startSandboxChild`, in order, after the client's own state fold and this
 * file's watchers, so every listener an extension registers sees a cache that
 * already holds the event. Nothing an extension holds is reachable from a
 * snippet.
 */
export interface SandboxChildExtension {
  /** Rpc methods by name (`HostToChild` `rpc`), answered with the returned value. */
  readonly rpc?: Readonly<Record<string, (params: { limit?: number }) => unknown>>;
  /** Fields merged onto an event's summary (`note`, `bystander`), resolved as the event arrived. */
  readonly summarize?: (event: StreamEvent) => Partial<Pick<EventSummary, "note" | "bystander">> | undefined;
  /** Fields added to the state snapshot, after the cache's own and before `observation` and `move`. */
  readonly snapshot?: (snap: Record<string, unknown>) => void;
}

/** What an extension is handed: the one client, and the summary every reader of an event gets. */
export interface SandboxChildApi {
  readonly client: WrathClient;
  summarize(event: StreamEvent): EventSummary;
  /**
   * Register the stack's client-cache forward at this point of the listener
   * order. Optional and idempotent: without a call it registers after every
   * extension has installed.
   */
  forwardClientCache(): void;
}

export type SandboxChildExtensionFactory = (api: SandboxChildApi) => SandboxChildExtension;

const extensions: SandboxChildExtension[] = [];

/**
 * An event as every reader of the buffer gets it: JSON-safe and depth-limited,
 * plus what each extension resolved for it as it arrived.
 */
function eventSummary(e: StreamEvent): EventSummary {
  const summary: EventSummary = {
    seq: e.seq,
    ts: e.ts,
    opcode: e.opcode,
    data: toJsonSafe(e.data, 5),
    schemaError:
      "schemaError" in e && e.schemaError !== undefined ? String(e.schemaError) : undefined,
  };
  for (const ext of extensions) {
    const extra = ext.summarize?.(e);
    if (extra !== undefined) Object.assign(summary, extra);
  }
  return summary;
}

function recentEvents(limit: number): EventSummary[] {
  return client.events.recent(limit).map(eventSummary);
}

/**
 * The state snapshot the host renders (`SandboxHost.stateSnapshot`):
 * `StateCache.snapshot()`, then whatever each extension adds for its HUD,
 * then two fields that are this session's own rather than the world's. All
 * pure reads over what the cache already holds — no new observation.
 */
function stateSnapshot(): unknown {
  const snap = toJsonSafe(client.state.snapshot(), 6) as Record<string, unknown>;
  for (const ext of extensions) ext.snapshot?.(snap);
  // Whether this child's own event stream is still open. Not an observation of
  // the world and never printed by a HUD that reads named fields: the cache
  // above is a pure local read, so a stream that stopped folding into it
  // looks exactly like a world where nothing happens, and a host's stall
  // detector needs the difference.
  snap["observation"] = { connected: client.events.connected };
  // Where the character is trying to get to (`moveIntent`). Not an observation
  // of the world — it is this session's own last dispatch — so it rides the
  // snapshot rather than the state cache.
  snap["move"] = moveIntent === null ? null : { ...moveIntent };
  return snap;
}

/** An rpc by name: the core's three, else an extension's, else the snapshot. */
function answerRpc(method: string, params: { limit?: number }): unknown {
  if (method === "recent_events") return recentEvents(params.limit ?? 50);
  if (method === "action_hints") return drainHints();
  if (method !== "state_summary") {
    for (const ext of extensions) {
      const fn = ext.rpc?.[method];
      if (fn !== undefined) return fn(params);
    }
  }
  return stateSnapshot();
}

function handle(msg: HostToChild | HostcallResult): void {
  switch (msg.t) {
    case "eval":
      void evaluate(msg.id, msg.code, msg.deadline, msg.timeoutMs);
      return;
    case "abort":
      abortEval(msg.id);
      return;
    case "ping":
      // Pings carry any buffered console output home: the host pings after a
      // snippet times out, and this is how the abandoned snippet's logs reach
      // the model instead of `logs: []`.
      {
        const unwinding = abandonUnwind;
        abandonUnwind = undefined;
        const pong = (): void => {
          const note = abandonNote;
          abandonNote = undefined;
          const abandoned = abandonedEval;
          abandonedEval = undefined;
          flushActions();
          send({
            t: "pong",
            id: msg.id,
            logs: drainLogs(),
            hints: drainHints(abandoned),
            ...(note !== undefined ? { note } : {}),
          });
        };
        if (unwinding === undefined) pong();
        else void Promise.race([unwinding, Bun.sleep(ABANDON_UNWIND_GRACE_MS)]).then(pong);
      }
      return;
    case "rpc": {
      try {
        const value = answerRpc(msg.method, msg.params);
        send({ t: "rpc_result", id: msg.id, ok: true, value });
      } catch (err) {
        send({ t: "rpc_result", id: msg.id, ok: false, error: String(err) });
      }
      return;
    }
    case "client_cache_seed":
      seedClientCache(msg.frames);
      return;
    case "hostcall_result": {
      const pending = hostcallPending.get(msg.id);
      if (pending) {
        hostcallPending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error ?? "hostcall failed"));
      }
      return;
    }
    case "shutdown":
      flushActions();
      try {
        client.close();
      } catch {
        // closing anyway
      }
      process.exit(0);
  }
}

process.on("message", (msg) => {
  handle(msg as HostToChild | HostcallResult);
});

process.on("disconnect", () => process.exit(0));

// ------------------------------------------------- survive background errors
//
// Bun's default policy kills the process on an unhandled rejection or uncaught
// exception. A snippet that fires an SDK call without awaiting it (seen in
// night-laguna-oc-1: `JSON.stringify(sdk.questList())`) turns a routine module
// error into a rejected promise nobody holds — and the whole runtime, with all
// its bindings and routines, died for it. Report instead: the error lands in
// the log buffer (so the next snippet result shows it) and as a fatal notice
// the host surfaces to the model.
//
// Storm control (morning-laguna-2: a routine throwing in a tight loop pushed
// 4,125 identical session notes — 12MB — into one trajectory): the first
// occurrence of a fault signature reports immediately; repeats aggregate into
// a rollup notice gated to at most one per FAULT_ROLLUP_INTERVAL_MS across
// all signatures; a signature that keeps faulting past
// FAULT_ESCALATION_THRESHOLD inside its window gets one distinct escalation
// notice telling the model its routine is broken and how to stop it. The
// sandbox is never killed for this — bindings are healthy; the model acts.

const FAULT_WINDOW_MS = Number(process.env["WRATHBENCH_FAULT_WINDOW_MS"] ?? 60_000);
const FAULT_ROLLUP_INTERVAL_MS = Number(process.env["WRATHBENCH_FAULT_ROLLUP_MS"] ?? 30_000);
const FAULT_ESCALATION_THRESHOLD = Number(process.env["WRATHBENCH_FAULT_ESCALATION_THRESHOLD"] ?? 50);
/** Max immediate first-reports across ALL signatures per window (see below). */
const FAULT_IMMEDIATE_CAP = Number(process.env["WRATHBENCH_FAULT_IMMEDIATE_CAP"] ?? 5);
/** Cap on distinct signatures tracked, so a varying-message loop can't grow the Map without bound. */
const FAULT_STATS_MAX = 500;

interface FaultStat {
  count: number;
  windowStart: number;
  escalated: boolean;
}
const faultStats = new Map<string, FaultStat>();
/** Faults per signature not yet covered by a notice, for the next rollup. */
const rollupPending = new Map<string, number>();
/** When the last background-fault notice of any kind was sent. Gates rollups. */
let lastFaultNoticeAt = 0;
/**
 * Global immediate-report budget. Storm control that only aggregates repeats of
 * the SAME signature was bypassed by a routine that rejects with a per-iteration
 * value (a new signature every time), each taking the count===1 immediate path —
 * reproducing the morning-laguna-2 trajectory bloat through a varying fault
 * shape. This caps first-reports across all signatures per window; once spent,
 * even a brand-new signature aggregates into the rollup. Escalation still fires
 * once per continuously-faulting signature.
 */
let immediateReports = 0;
let immediateWindowStart = 0;

/**
 * What makes two faults "the same": kind, error name, and the first stack
 * frame — not the message, which a loop can vary per iteration.
 */
function faultSignature(kind: string, reason: unknown): string {
  if (reason instanceof Error) {
    const stackLine =
      reason.stack
        ?.split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("at ")) ?? "";
    return `${kind}: ${reason.name}${stackLine.length > 0 ? ` (${stackLine})` : ""}`;
  }
  return `${kind}: ${Bun.inspect(reason).slice(0, 120)}`;
}

function reportBackgroundError(kind: string, reason: unknown): void {
  const now = Date.now();
  const text = reason instanceof Error ? renderError(reason) : Bun.inspect(reason, { depth: 4 }).slice(0, 1_000);
  pushLog("error", `[${kind}] ${text}`);

  const signature = faultSignature(kind, reason);
  let stat = faultStats.get(signature);
  if (stat === undefined || now - stat.windowStart > FAULT_WINDOW_MS) {
    stat = { count: 0, windowStart: now, escalated: false };
    // Bound the Map: a routine varying its fault message adds a new signature
    // each iteration, so evict the oldest rather than growing without bound.
    if (!faultStats.has(signature) && faultStats.size >= FAULT_STATS_MAX) {
      const oldest = faultStats.keys().next().value;
      if (oldest !== undefined) faultStats.delete(oldest);
    }
    faultStats.set(signature, stat);
  }
  stat.count++;

  // Roll the global immediate-report window.
  if (now - immediateWindowStart > FAULT_WINDOW_MS) {
    immediateWindowStart = now;
    immediateReports = 0;
  }

  // First occurrence of this signature (per window): report immediately, but
  // only while the global first-report budget for this window has room. Once
  // spent, a new signature falls through to the aggregated rollup path so a
  // varying-signature storm can't bypass the control.
  if (stat.count === 1 && immediateReports < FAULT_IMMEDIATE_CAP) {
    immediateReports++;
    realConsole.error?.(`[sandbox] ${kind}:`, text);
    send({ t: "fatal", error: `${kind} (sandbox survived; bindings and routines intact): ${text}` });
    lastFaultNoticeAt = now;
    return;
  }

  // Continuous faulting: one distinct escalation notice per signature.
  if (!stat.escalated && stat.count > FAULT_ESCALATION_THRESHOLD) {
    stat.escalated = true;
    rollupPending.delete(signature); // the escalation covers the backlog
    const secs = Math.max(1, Math.round((now - stat.windowStart) / 1000));
    const escalation =
      `background routine broken: ${signature} has faulted ${stat.count} times in the last ${secs}s. ` +
      `The sandbox is alive and your bindings are intact, but a background routine is failing in a tight ` +
      `loop — from your next snippet, stop it: clearInterval any timers you started, set the flags your ` +
      `loops check so they exit, then restart the routine with a try/catch inside it. ` +
      `Further identical faults will only be reported as periodic rollups.`;
    realConsole.error?.(`[sandbox] ${escalation}`);
    send({ t: "fatal", error: escalation });
    lastFaultNoticeAt = now;
    return;
  }

  // A repeat: aggregate, and roll up at most once per interval overall.
  rollupPending.set(signature, (rollupPending.get(signature) ?? 0) + 1);
  if (now - lastFaultNoticeAt >= FAULT_ROLLUP_INTERVAL_MS) {
    const summary = [...rollupPending.entries()].map(([sig, n]) => `${sig} ×${n}`).join("; ");
    rollupPending.clear();
    const rollup = `background faults continuing (aggregated; sandbox alive): ${summary} since the last report`;
    realConsole.error?.(`[sandbox] ${rollup}`);
    send({ t: "fatal", error: rollup });
    lastFaultNoticeAt = now;
  }
}

process.on("unhandledRejection", (reason) => {
  if (isHarnessAbandonment(reason)) return;
  reportBackgroundError("unhandled promise rejection", reason);
});

process.on("uncaughtException", (err) => {
  reportBackgroundError("uncaught exception", err);
});

/**
 * Install a harness's extensions (`SandboxChildExtension`), in order, and tell
 * the host this child is ready. A child entry calls it once, after importing
 * this module: `startSandboxChild([myExtension])`, or with nothing for the
 * bare stack (`entry.ts`). The host sends no eval, rpc or seed before ready.
 */
export function startSandboxChild(factories: readonly SandboxChildExtensionFactory[] = []): void {
  for (const factory of factories) extensions.push(factory({ client, summarize: eventSummary, forwardClientCache }));
  forwardClientCache();
  send({ t: "ready" });
}
