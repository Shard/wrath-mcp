/**
 * IPC message shapes between the sandbox host and the sandbox child process.
 * Transport is Bun's built-in `ipc` channel on `Bun.spawn` (JSON
 * serialization), so everything here must survive JSON.
 */

/**
 * A hint-bearing failure the SDK recorded, tallied per (action, status). The
 * hint rides inside the result object too, but a snippet that keeps only
 * `.status` drops it (run a11: 41 `too_far`, hint read 0 times), so the harness
 * carries it home itself. Mirrors `ActionHint` from the SDK; redeclared here
 * because everything on this channel must survive JSON.
 */
export interface ActionHintNote {
  action: string;
  status: string;
  count: number;
  hint: string;
  point?: { x: number; y: number; z: number };
  ts: number;
}

/**
 * A death-window transition the child latched the moment the event carrying it
 * arrived, rather than the moment the host next sampled.
 *
 * The host samples every `stateIntervalMs` (60s in the fleet); an entire death,
 * release and spirit-healer resurrection fits inside 30 seconds, so the sampled
 * window read misses whole deaths (run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2`: three deaths, none
 * recorded). The child sees every event, so the transition is latched there and
 * drained from here; `ts` is the event's own timestamp, which is when the thing
 * happened.
 */
export interface DeathSignal {
  kind: "death" | "release" | "resurrect";
  /** The timestamp of the event that carried the transition. */
  ts: number;
  /** That event's stream seq, for correlation with the event log. */
  seq: number;
  /** Death only: the corpse as the cache held it at that instant. */
  position?: { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" };
  /** Release only: the graveyard the spirit was released to. */
  graveyard?: { map: number; x: number; y: number; z: number };
  /** Death only: the zone/area ids at the moment of death. */
  zone?: number;
  area?: number;
  /** Death only: the ghost flag as it read at that instant (usually false). */
  released?: boolean;
}

/**
 * Where the character is trying to get to: the destination of the current or
 * last `move_to` this session dispatched, and what became of it.
 *
 * Captured at the sandbox boundary rather than inside the SDK, from the
 * `POST /action` the client makes and the `WB_MOVE_RESULT` that answers it —
 * the destination the module was actually asked for, after the SDK resolved a
 * unit or a name to a point. It rides the `state_summary` snapshot, so the
 * runner's state ticker sees it on the 5s tick rather than on the (60s) row
 * cadence: a walk of ~250y is over inside one row interval, and an intention
 * only sampled at row cadence would be an intention nobody could see.
 */
export interface MoveIntentNote {
  /** The module's move id, once the POST answered. Null while the ack is in flight. */
  moveId: number | null;
  /** The map the character stood on when the move was dispatched, when observed. */
  map: number | null;
  x: number;
  y: number;
  z: number;
  /** The name of the unit the move was aimed at, when it was aimed at one. */
  target: string | null;
  /** The module's verdict (`arrived`, `too_far`, …); null while the move is in flight. */
  status: string | null;
  /** When the move was dispatched. */
  ts: number;
  /** When the verdict arrived; null while the move is in flight. */
  endedAt: number | null;
}

/**
 * One `POST /action` the session's SDK client dispatched, and the module's
 * answer to it — the action log (CLAUDE.md: "every action dispatched").
 *
 * Watched at the sandbox's fetch, like `MoveIntentNote`, so it is every action
 * the client actually put on the wire — a helper's inner `set_target`, a
 * `raw` opcode, a routine's re-cast — and nothing the SDK refused before
 * sending. It records the dispatch and the HTTP answer only: an ack means
 * "queued", and how the game took it (a cast that failed, an arrival) arrives
 * later on the event stream, where it already is. Nothing here guesses it.
 */
export interface ActionNote {
  /** When the request was handed to fetch. */
  ts: number;
  action: string;
  /** The request body minus `token` and `action`; long strings clipped. Absent when empty. */
  args?: Record<string, unknown>;
  /** The HTTP status the module answered with; 0 when no answer came (transport failure). */
  status: number;
  /** Request to answer, in ms. */
  ms: number;
  /** The module's error code (`too_far`, `opcode_not_allowed`, …), or the transport failure. */
  error?: string;
  /** The module's own hint on a refusal, clipped. */
  hint?: string;
  /** The module's move id, on a `move_to` ack — the key its `move` verdict carries. */
  moveId?: number;
  /**
   * Client-cache names for the ids in `args`, read at dispatch from what the
   * session had already observed (name and creature queries, the spellbook,
   * item and quest queries, the bag). Never looked up anywhere else; an id the
   * cache had no name for has no entry.
   */
  names?: { target?: string; spell?: string; item?: string; quest?: string };
  /** Consecutive identical dispatches folded into this one (same action, args and answer). */
  count?: number;
  /** The last of those folded dispatches. */
  lastTs?: number;
  /**
   * The SDK's own client-parity query (`questgiver_status_query`,
   * `questgiver_status_multiple_query`, `quest_query` fired from the event
   * fold, outside every snippet's async context): traffic a real client sends
   * by itself, not something the snippet asked for.
   */
  auto?: true;
}

/**
 * The actions one snippet's async context dispatched since the last flush.
 * `evalId` is the eval that launched them — a background routine keeps the
 * id of the snippet that started it — or null outside every snippet (an event
 * callback, the SDK's parity queries).
 */
export interface ActionBatch {
  evalId: number | null;
  /** True when the launching snippet had already returned: a background routine's actions. */
  routine?: true;
  actions: ActionNote[];
  /** Dispatches past the per-flush cap, counted by action name rather than kept. */
  dropped?: Record<string, number>;
}

export interface LogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  ts: number;
  text: string;
}

// host -> child
export type HostToChild =
  /**
   * `deadline` is the epoch-ms instant this eval will be abandoned — the host
   * owns the snippet budget, so the host is what names it. The child threads it
   * into the SDK client, which uses it for explanation only (a `moveTo` result
   * whose walk was always longer than the budget says so in its `hint`); no
   * wait is ever shortened or refused because of it.
   *
   * `timeoutMs` is the ceiling that deadline was set from, carried the same way
   * and for the same purpose: an awaited `sleep` asked for at least the time
   * its snippet had left names the ceiling in the abandon note. Explanation
   * only; the sleep still runs for what it was asked.
   */
  | { t: "eval"; id: number; code: string; deadline?: number; timeoutMs?: number }
  | { t: "ping"; id: number }
  /** Abort the eval with this id: fires its `signal`, so SDK waits it left behind settle. */
  | { t: "abort"; id: number }
  /**
   * `action_hints` drains the SDK's hint tally for a tool result that is not a
   * snippet's (`SandboxHost.drainActionHints`); a snippet's own result and
   * pong drain it themselves.
   */
  | {
      t: "rpc";
      id: number;
      method: "recent_events" | "state_summary" | "death_signals" | "action_hints";
      params: { limit?: number };
    }
  | { t: "shutdown" };

export interface EvalResultMsg {
  t: "result";
  id: number;
  ok: boolean;
  /** Bun.inspect rendering of the completion value; absent when undefined. */
  value?: string;
  /** Error rendering when ok is false. */
  error?: string;
  /**
   * A note about the completion value itself, rendered under it. Today the one
   * case is a snippet whose value is a function it never called (the harness
   * explains, it does not act).
   */
  hint?: string;
  /** console output drained since the previous result (includes background logs). */
  logs: LogEntry[];
  /**
   * Hint-bearing failures the SDK recorded while this snippet ran, drained here
   * so the runner can render them whatever the snippet kept. Empty on an
   * abandoned eval — the host discards its result, so those ride the pong.
   */
  hints?: ActionHintNote[];
  durationMs: number;
}

export interface EventSummary {
  seq: number;
  ts: number;
  opcode: string;
  /** JSON-safe, depth-limited data. */
  data: unknown;
  schemaError?: string | undefined;
}

// child -> host
export type ChildToHost =
  | { t: "ready" }
  | EvalResultMsg
  /**
   * `note` carries what the abandoned eval learned on its way out — the
   * distance an in-flight `moveTo` had covered and had left, or that an awaited
   * `sleep` was asked for at least the time the snippet had left — so the
   * host's abandon message can state it. Absent when the abort taught us
   * nothing.
   */
  | { t: "pong"; id: number; logs?: LogEntry[]; note?: string; hints?: ActionHintNote[] }
  | { t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }
  /**
   * The action log, pushed rather than drained: sent just before a snippet's
   * result (so the host has written it before the tool result exists), before
   * a pong, and on an idle timer for what background routines dispatch
   * between snippets. Record-only; nothing in it reaches the model.
   */
  | { t: "actions"; batches: ActionBatch[] }
  | { t: "hostcall"; id: number; method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append"; params: { content?: string } }
  | { t: "fatal"; error: string };

// host -> child, reply to hostcall
export type HostcallResult = { t: "hostcall_result"; id: number; ok: boolean; value?: unknown; error?: string };
