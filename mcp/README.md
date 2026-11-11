# @wrathbench/mcp

The agent surface over `@wrathbench/sdk`: a confined, persistent snippet
sandbox holding one SDK client per session, an MCP server, one tool
dispatcher, and the five core tools — `run_snippet`, `recent_events`,
`state_summary`, `write_scratchpad` and `edit_scratchpad`. With `sdk/` and
`module/` it is the stack the root `README.md` describes, whose specification
is `docs/CONTRACTS.md` and `module/PROTOCOL.md`. It records what its own
sessions did and knows nothing of what drove them: the session record (the
trace and character sheet, game events, tool calls and their results) is the
stack's, written here, and episodes, scores and model trajectories are a
harness's, plugged in through its hooks (`docs/ARCHITECTURE.md`, "The stack
and a harness").

## Quickstart

With a worldserver running the module (root `README.md`, "Building the module
into a worldserver") and Bun 1.4 with `bun install --frozen-lockfile` at the
repo root:

```bash
WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 \
WRATHBENCH_MODULE_SECRET=<the module's port secret> \
  bun mcp/src/main.ts --account <an allowed account> [--dir <state-dir>] [--token-file <path> | --token <t>] [--allow-gm] \
    [--record-dir <store> | --no-record] [--record-retention-days <n>]
```

That is an MCP server over stdio serving the core tools: point an MCP-capable
agent at it as its server command. It leases a session secret for its token
with the port secret and hands the sandbox only that. The scratchpad, the
client cache and the token itself live in the state directory, `--dir`
(default `$TMPDIR/wrathbench-mcp/<fingerprint>`, created mode 0700, the token
in its `token` file, mode 0600), so `--dir` alone resumes the same session
with both; `--token-file` or `--token` names a token instead. The token is never
printed: stderr names the session by its tag (`tok:<8 hex>`, the name the
worldserver log and the audit log give it) and the state directory by its
path. Sandbox notices (a restart, a background fault) ride the next tool
result.

Stdin closing, SIGINT or SIGTERM is a clean exit: the sandbox stops, the
character is logged out (`DELETE /session`) and the lease released, each with
the port secret and each bounded, and a second signal exits at once. A process
killed outright leaves the character in the world until a create on its
account reclaims it (`module/PROTOCOL.md`, "DELETE /session"). The sandbox needs Linux 6.7 or later — Landlock with TCP
rules — and refuses to start without it; what it confines and what it leaves
to the deployment's network policy is `docs/ARCHITECTURE.md` ("The sandbox").

## The session record

Every session is recorded unless `--no-record` says otherwise, in the format
`docs/SESSION-FORMAT.md` specifies:

```
<record-dir>/<fingerprint>/
  session.json   live.json   manifest.json
  trace/   events/   calls/   nearby/
```

- `--record-dir` is the store, a directory of sessions. Its default is a
  `sessions` directory beside the state directory, so with the default state
  directory it is `$TMPDIR/wrathbench-mcp/sessions/`.
- A session's directory is named by its token's fingerprint, the 16 hex
  characters the module's audit files carry, so `--dir` resuming a session
  continues its record. No file of the record holds the token.
- `trace/` is the character's own position, state and character sheet;
  `events/` what happened to it; `calls/` the tool calls, their results, the
  action log and movement intentions; `nearby/` a live-only ring of the units
  in view, removed when the session closes. A closed segment is compressed
  with zstd, and the one being written stays plain so it can be followed.
- Players who are not sessions of the same store are never written.
- At start, sessions that closed more than `--record-retention-days` ago
  (default 3) are removed. One still being written never is.

`mcp/src/record/` is the code: the writer a host holds, the reader, the store
and `validateSession(dir)`, which says what a directory holds that the format
does not allow. A harness that keeps its evidence per run does not use the
store: it points a `SessionWriter` at a directory inside the run and hands it
to `SandboxHost` and to its tool contexts (`docs/ARCHITECTURE.md`, "The
session record").

## GM accounts

Off by default: the module then refuses a GM account (`gm_account`) and any
chat the server would run as a command, a `.` or `!` line (`chat_command`),
whatever the account. Both refusals say how to opt in. To drive a GM account,
or to let a session run commands, pass `--allow-gm` or set
`WRATHBENCH_ALLOW_GM=1` (`0`, `false` or unset is off; any other value is
refused at start) in the server's entry in the client's `mcpServers`:

```json
{
  "mcpServers": {
    "wrath": {
      "command": "bun",
      "args": ["/path/to/wrath-mcp/mcp/src/main.ts", "--account", "GMACCOUNT", "--allow-gm"],
      "env": {
        "WRATHBENCH_MODULE_URL": "http://127.0.0.1:8086",
        "WRATHBENCH_MODULE_SECRET": "<the module's port secret>"
      }
    }
  }
}
```

or the same entry without `--allow-gm` and with `"WRATHBENCH_ALLOW_GM": "1"`
in `env`. The opt-in rides the lease this process takes with the port secret
(`module/PROTOCOL.md`, "POST /lease"), so the session the sandbox creates
inherits it and nothing a snippet sends can turn it on; stderr says whether
the module confirmed it. The SDK's equivalent is
`connect({ ..., allowGm: true })`.

## Pieces

- `src/sandbox/` — the host (`SandboxHost`), the child runtime (`child.ts`,
  whose header documents everything a snippet can reach), the Landlock wrapper
  (`confine.ts`), the IPC shapes, the snippet rewrite and the client cache.
- `src/tools.ts` — `ToolSet`, the core tools, and the hooks a harness renders
  them with (`CoreToolRender`).
- `src/record/` — the session record: the format's types, the recorders the
  child runs, the writer, the reader, the store and the validator.
- `src/server.ts`, `src/bridge.ts` — the MCP transport, and the stdio-to-TCP
  bridge a CLI is handed when the harness keeps its sandbox in-process.
- `src/main.ts` — the standalone server above.

Entry points: the root, `./sandbox-child` (the child runtime, for a harness's
own child entry), and leaves that load nothing else — `./module-auth`,
`./redact`, `./jsonsafe`, `./scratchpad`, `./client-cache`, `./paths`,
`./tools`, `./record` (the format, writer, reader, store and validator) and
`./record/recorder` (the recorders) — for processes that run no sandbox. The package releases with the
SDK at the same version.
