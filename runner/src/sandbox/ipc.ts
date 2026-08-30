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
   */
  | { t: "eval"; id: number; code: string; deadline?: number }
  | { t: "ping"; id: number }
  /** Abort the eval with this id: fires its `signal`, so SDK waits it left behind settle. */
  | { t: "abort"; id: number }
  | { t: "rpc"; id: number; method: "recent_events" | "state_summary" | "death_signals"; params: { limit?: number } }
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
   * `note` carries what the abandoned eval learned on its way out — today, the
   * distance an in-flight `moveTo` had covered and had left — so the host's
   * abandon message can state it. Absent when the abort taught us nothing.
   */
  | { t: "pong"; id: number; logs?: LogEntry[]; note?: string; hints?: ActionHintNote[] }
  | { t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "hostcall"; id: number; method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append"; params: { content?: string } }
  | { t: "fatal"; error: string };

// host -> child, reply to hostcall
export type HostcallResult = { t: "hostcall_result"; id: number; ok: boolean; value?: unknown; error?: string };
