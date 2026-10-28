# @wrathbench/mcp

The agent surface over `@wrathbench/sdk`: a confined, persistent snippet
sandbox holding one SDK client per session, an MCP server, one tool
dispatcher, and the five core tools — `run_snippet`, `recent_events`,
`state_summary`, `write_scratchpad` and `edit_scratchpad`. With `sdk/` and
`module/` it is the stack described in `sdk/README.md` ("The stack"), whose
specification is `docs/CONTRACTS.md` and `module/PROTOCOL.md`. It knows nothing
of episodes, scores or trajectories; a harness plugs those in through its hooks
(`docs/ARCHITECTURE.md`, "The stack and the benchmark").

## Quickstart

With a worldserver running the module (`sdk/README.md`, "Quickstart") and Bun
1.4 with `bun install` at the repo root:

```bash
WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 \
WRATHBENCH_MODULE_SECRET=<the module's port secret> \
  bun mcp/src/main.ts --account <an allowed account> [--token <t>] [--dir <state-dir>]
```

That is an MCP server over stdio serving the core tools: point an MCP-capable
agent at it as its server command. It leases a session secret for its token
with the port secret and hands the sandbox only that; the scratchpad and the
client cache live in `--dir` (default `$TMPDIR/wrathbench-mcp/<token>`), so a
restart keeps both. Sandbox notices (a restart, a background fault) ride the
next tool result. The sandbox needs Linux 6.7 or later — Landlock with TCP
rules — and refuses to start without it.

## Pieces

- `src/sandbox/` — the host (`SandboxHost`), the child runtime (`child.ts`,
  whose header documents everything a snippet can reach), the Landlock wrapper
  (`confine.ts`), the IPC shapes, the snippet rewrite and the client cache.
- `src/tools.ts` — `ToolSet`, the core tools, and the hooks a harness renders
  them with (`CoreToolRender`).
- `src/server.ts`, `src/bridge.ts` — the MCP transport, and the stdio-to-TCP
  bridge a CLI is handed when the harness keeps its sandbox in-process.
- `src/main.ts` — the standalone server above.

Entry points: the root, `./sandbox-child` (the child runtime, for a harness's
own child entry), and leaves that load nothing else — `./module-auth`,
`./redact`, `./jsonsafe`, `./scratchpad`, `./client-cache`, `./paths`,
`./tools` — for processes that run no sandbox. The package releases with the
SDK at the same version.

## Known issues

- `src/sandbox/confine.ts` takes the repository root to be three directories
  above itself and grants the child `mcp/`, `sdk/` and `node_modules/` beneath
  it. That holds in this monorepo and its images; when the stack moves to a
  repository of its own, the read list has to come from where the packages
  are actually installed.
