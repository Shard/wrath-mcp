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
  | { t: "eval"; id: number; code: string }
  | { t: "ping"; id: number }
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
  | { t: "pong"; id: number; logs?: LogEntry[] }
  | { t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "hostcall"; id: number; method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append"; params: { content?: string } }
  | { t: "fatal"; error: string };

// host -> child, reply to hostcall
export type HostcallResult = { t: "hostcall_result"; id: number; ok: boolean; value?: unknown; error?: string };
