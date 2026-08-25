/**
 * IPC message shapes between the sandbox host and the sandbox child process.
 * Transport is Bun's built-in `ipc` channel on `Bun.spawn` (JSON
 * serialization), so everything here must survive JSON.
 */

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
  | { t: "rpc"; id: number; method: "recent_events" | "state_summary"; params: { limit?: number } }
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
  | { t: "pong"; id: number; logs?: LogEntry[]; note?: string }
  | { t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "hostcall"; id: number; method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append"; params: { content?: string } }
  | { t: "fatal"; error: string };

// host -> child, reply to hostcall
export type HostcallResult = { t: "hostcall_result"; id: number; ok: boolean; value?: unknown; error?: string };
