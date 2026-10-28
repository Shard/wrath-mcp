/**
 * @wrathbench/mcp — the agent surface over the SDK: a confined, persistent
 * snippet sandbox holding one `WrathClient`, an MCP server, the core tools
 * that drive them, and the module's authentication helpers.
 *
 * It depends on `@wrathbench/sdk` through that package's public entry point
 * and on nothing else in this repository. A harness (the runner is one)
 * plugs its own tools, its context rendering, its records and its child-side
 * watchers in through the hooks exported here; nothing in this package knows
 * what a harness records or scores.
 *
 * This root loads the whole package. A process that needs one helper and runs
 * no sandbox — a viewer, a supervisor, a trajectory writer — imports the leaf
 * entry point instead: `@wrathbench/mcp/module-auth`, `/redact`, `/jsonsafe`,
 * `/scratchpad`, `/client-cache` or `/paths`.
 */

export { MCP_BRIDGE_PATH, SANDBOX_CONFINE_PATH, SANDBOX_ENTRY_PATH } from "./paths";

export {
  SANDBOX_FORWARDED_ENV,
  SandboxHost,
  sandboxChildEnv,
  STATE_LOSS_RECOVERY,
} from "./sandbox/host";
export type {
  ActionsFlush,
  EvalLink,
  HarnessNotice,
  SandboxHostOptions,
  SandboxNoticeKind,
  SnippetResult,
} from "./sandbox/host";
// Types only: importing the child runtime itself is what makes a process a
// sandbox child (it replaces fetch, WebSocket and console), so its values are
// reached through `@wrathbench/mcp/sandbox-child` and nowhere else.
export type { SandboxChildApi, SandboxChildExtension, SandboxChildExtensionFactory } from "./sandbox/child";

export { compactJson, jsonLine, toJsonSafe } from "./jsonsafe";
export {
  leaseRunSecret,
  leaseSessionSecret,
  MODULE_SECRET_ENV,
  moduleAuthHeaders,
  moduleSecret,
  releaseSessionSecret,
} from "./module-auth";
export type { LeaseOptions, LeaseOutcome } from "./module-auth";
export { MIN_SECRET_CHARS, REDACTED, SCRUB_HOLD_CHARS, SCRUB_MAX_PENDING_CHARS, ScrubbedStream, SecretRedactor } from "./redact";
export {
  overCapText,
  Scratchpad,
  SCRATCHPAD_MAX_CHARS,
  scratchpadSizeLabel,
  stripLegacyMarker,
} from "./scratchpad";
export type { OverCap, WriteResult } from "./scratchpad";

export { CALL_SITE_LABEL_CHARS, SNIPPET_URL, builtRoutine, callSiteLabel } from "./sandbox/call-site";
export {
  CLIENT_CACHE_FILE,
  CLIENT_CACHE_OPCODES,
  ClientCacheStore,
  clientCacheKey,
  keepsAnswer,
  reparseFrame,
} from "./sandbox/client-cache";
export type { ClientCacheFrame, ClientCacheStoreOptions } from "./sandbox/client-cache";
export {
  ACCESS_FS,
  ACCESS_NET,
  ConfinementError,
  confinementPlan,
  DEV_NODES,
  elfInterpreter,
  landlockAbi,
  modulePort,
  PROC_GLOBAL_FILES,
  REQUIRED_ABI,
  SCOPE,
} from "./sandbox/confine";
export type { ConfinementPlan, FsRule, NetRule, PlanInput } from "./sandbox/confine";
export { RepeatFolder } from "./sandbox/log-fold";
export { REATTACH_REPLAY_WAIT_MS, REATTACH_STATE_WAIT_MS } from "./sandbox/reattach-waits";
export { compileSnippet, extractPatternNames, scanTopLevelDeclarations } from "./sandbox/rewrite";
export type { CompiledSnippet, ScanResult } from "./sandbox/rewrite";
export type {
  ActionBatch,
  ActionHintNote,
  ActionNote,
  ChildToHost,
  EvalResultMsg,
  EventSummary,
  HostcallResult,
  HostToChild,
  LogEntry,
  MoveIntentNote,
} from "./sandbox/ipc";

export {
  ACTION_HINT_RENDER,
  appendPendingActionHints,
  booleanish,
  coreTools,
  parseToolArgsText,
  renderActionHints,
  stripTrailingCommas,
  toolCallCount,
  ToolSet,
} from "./tools";
export type {
  CallOrigin,
  CoreToolContext,
  CoreToolName,
  CoreToolRender,
  ToolDef,
  ToolResult,
  ToolSandbox,
  ToolSpec,
} from "./tools";
export { lines, MCP_PROTOCOL_VERSION, McpServer, serveStdio } from "./server";
export { MCP_PACKAGE_VERSION } from "./version";
export type { McpServerOptions, OnToolCall, ToolHost } from "./server";
