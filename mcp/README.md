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
    [--record-dir <store> | --no-record] [--record-retention-days <n>] \
    [--max-characters <n> --accounts <a,b,…>]
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

## Several characters

Off by default, and the operator's to grant, as GM use is: with
`--max-characters <n>` above 1 and `--accounts <a,b,…>` (at least `n` allowed
accounts, because the module holds one live session per account), one client
may have up to `n` characters in the world at once.

- The tool list is then the five core tools, with an optional `character` on
  `run_snippet`, `recent_events` and `state_summary`, and three more:
  `login_character { name, race?, class?, gender? }`,
  `logout_character { character }` and `list_characters {}`. It is fixed for
  the server's life. A character's name, as the server spells it, is its
  handle, matched exactly.
- With `character`, a snippet's `sdk`, `state` and `events` are that
  character's. Every snippet also sees `chars`, each logged-in character by
  name with its own `sdk`, `state` and `events`. Without `character`,
  `state_summary` is a roll-up of all of them with one line per exception and
  `recent_events` one merged feed.
- Each character has its own token, lease and session record; the records of
  one client carry the same `group`. The scratchpad is one per client.
- The state directory keeps which account and token each character lives on
  (`roster.json`, mode 0600), so a name logs the same character back in and
  `--dir` brings back the ones that were logged in when the server last
  stopped uncleanly. A clean exit logs every one out.
- Without the flag, or with `--max-characters 1`, none of this exists and the
  server is the single-character one, byte for byte.

A harness grants it through `SandboxHostOptions.fanout`, a `CharacterRoster`
and `fanoutTools` (`src/fanout.ts`; `docs/ARCHITECTURE.md`, "Several
characters"), and words the roll-up and the merged feed its own way through
`FanoutRender`. The roster leases with the port secret unless it is handed a
`Leaser` (`src/module-auth.ts`) that asks whoever holds it.

## A program

Off by default. A harness that sets `SandboxHostOptions.program` to a
`Workspace` gets a sandbox that also runs the model's program: files rooted at
`main.ts`, routines started and stopped by name, a save that loads at once,
and a registry that survives a restart (`docs/ARCHITECTURE.md`, "A program").
It serves `programTools` beside the core tools and reads what happened from
`SandboxHost.program`. At fan-out a client has one workspace and one program
with routines per character: `programTools(render, { characters: true })`
beside `fanoutTools(render, fan, { program: true })`. The standalone server
serves it with `--program`: the workspace is `program/` in the state
directory, and the tools are `run_snippet` (a one-off), `read_file`,
`write_file`, `edit_file`, `delete_file`, `start_routine` and
`stop_routine`, then the other four core tools (`src/host.ts`,
`hostToolSpecs`).

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

## Hosted grants

Hosted mode (`docs/ARCHITECTURE.md`, "Hosted") serves the tools to people
other than the operator, each with a key of their own. Who may connect, on
which accounts and within which limits is a grants file the gateway reads
and the operator edits with `bun run grants` (`src/hosted/grants-cli.ts`):

```sh
export WRATH_MCP_GRANTS_FILE=/srv/wrath-mcp/grants.json
bun run grants reserve RUNNER1,RUNNER2          # accounts the operator's own sessions use
bun run grants add pat-1 --person pat --accounts T_PAT1   # prints the key, once
bun run grants key pat-1                        # a second key, to rotate
bun run grants revoke <key-id>
bun run grants disable pat-1
bun run grants list
```

- A grant is one credential: one MCP client with its own accounts and at
  most 5 characters in the world at once (default 1). A person who wants
  two agents holds two grants.
- No account is in two grants or reserved for the operator, because a
  create on an account takes it from whoever holds it. The file is refused
  otherwise, and refused if a grant names `allowGm`: GM use is never hosted.
- A key is 32 random bytes, printed once; the file keeps its SHA-256 and an
  id. It is read from `Authorization: Bearer`, or the inspector's sign-in
  body, and never from a URL. The same key signs its person in to
  wrath-inspector (`inspector/README.md`, "Hosted: a person's own sessions").
- The file's reader and `authenticate` are `src/hosted/grants-read.ts`
  (`@wrathbench/mcp/hosted/grants-read`), which writes nothing, so the
  inspector can import it; `grants.ts` re-exports it and adds what mints keys
  and writes the file.
- The file is written whole, mode 0600, by rename. A gateway reloads it when
  it changes, and a file that does not validate grants nothing until it does.
- Per-grant `limits` override the defaults (5 requests a second with a burst
  of 20, 4 calls at once, 20 logins an hour, logged out after 30 idle
  minutes), each at most the file's `ceiling`.

## The hosted gateway

`bun run gateway --grants <file> --state <dir>` serves the tools over
Streamable HTTP at `/mcp` to the people the grants file names
(`src/hosted/gateway-main.ts`; `docs/ARCHITECTURE.md`, "Hosted"). A client
connects with its key as `Authorization: Bearer <key>`:

```json
{ "mcpServers": { "wrath": { "type": "http", "url": "https://wrath.example/mcp", "headers": { "Authorization": "Bearer wmk_…" } } } }
```

- Each credential's host runs in a **worker** of its own (`src/hosted/worker.ts`),
  which holds the lease secrets the gateway hands it and never the port
  secret: every lease, logout and release it needs, it asks the gateway for
  over the channel the gateway opens to it, greeted with that worker's own
  secret. A worker whose gateway is gone shuts down and exits.
- Workers start through a `WorkerProvider`. The default, `localWorkers`, is
  a process per credential on the gateway's machine, started with no port
  secret in its environment. Its boundary is the kernel's alone: a worker
  runs as the gateway's user, so code that escaped a sandbox child into its
  worker could reach the gateway's process. **It serves the operator's own
  tests, not people outside the deployment**; for them a deployment runs a
  worker per pod or container through a provider of its own, with no route
  to anything but the module's port.
- Only the gateway holds the port secret (`WRATHBENCH_MODULE_SECRET`), and
  it refuses to start without it. Each
  credential gets a host of its own, opened at its first tool call, with its
  state in `<state>/tenants/<credential>/` and its own session store there;
  its records carry the person as `owner`, for display.
  `wrath-inspector --hosted-state <state> --grants <file>` reads those
  stores, a person seeing their own credentials' by where they are, never by
  `owner`.
- Every lease is held to the grant by the gateway: the credential's
  accounts, its character count and the file's `globalMaxCharacters`, the
  hourly logins, and never the GM opt-in. Leases are kept in
  `<state>/ledger.json` (0600) and released on the next start if the
  process died with them.
- Requests past the grant's rate are `429`; tool calls of one credential run
  one at a time, and past its in-flight cap are refused. With no
  authenticated request for the idle minutes, the credential's characters are
  logged out and its host stopped; the next call opens it again. A grant
  disabled, removed or left with no key stops its host at the next sweep,
  and so does a worldserver restart.
- `<state>/audit/<person>/<day>.jsonl` records who called what: keys tried,
  each request and tool call (by its call id, with the arguments as a size
  and a hash), leases by token fingerprint, refusals and stops. Kept 30 days.
- Both eras of the protocol are served: 2026-07-28's per-request metadata
  and `server/discover`, and the `initialize` handshake of 2025-03-26 to
  2025-11-25, answered without a session.
- Bound to anything but loopback it expects TLS in front of it.
  `--allowed-origin` names browser origins it accepts; `--trust-forwarded-for`
  audits the address the one proxy in front of it added, the last
  `X-Forwarded-For` entry; anything before it is the client's own say.

A deployment that starts its workers its own way (a pod per credential)
builds on the exports: `runGateway` or `gatewayMain` from
`@wrathbench/mcp/hosted/gateway` with its own `WorkerProvider`
(`@wrathbench/mcp/hosted/workers`), `workerMain` from
`@wrathbench/mcp/hosted/worker` as the worker's entry (`--host`, `--port`,
`--hello-wait-ms`), and `runGrantsCommand` from
`@wrathbench/mcp/hosted/grants-cli` for its own tooling over the grants file.

## Pieces

- `src/sandbox/` — the host (`SandboxHost`), the child runtime (`child.ts`,
  whose header documents everything a snippet can reach), the Landlock wrapper
  (`confine.ts`), the IPC shapes, the snippet rewrite and the client cache.
- `src/tools.ts` — `ToolSet`, the core tools, and the hooks a harness renders
  them with (`CoreToolRender`).
- `src/workspace.ts`, `src/sandbox/program.ts`, `src/sandbox/program-host.ts`,
  `src/sandbox/owners.ts` — a program: its files and their versions, the
  routine runtime in the child, the registry and heartbeat in the host, and
  who owns what a snippet or a routine starts.
- `src/fanout.ts` — several characters for one client: the grant, the roster
  of seats, the fan-out tool list and the summaries it serves.
- `src/record/` — the session record: the format's types, the recorders the
  child runs, the writer, the reader, the store and the validator.
- `src/server.ts`, `src/bridge.ts` — the MCP transport, and the stdio-to-TCP
  bridge a CLI is handed when the harness keeps its sandbox in-process.
- `src/host.ts` — one host: the sandbox, record, roster, program and the
  tool list, as `main.ts` serves it over stdio and the gateway per credential.
- `src/hosted/` — hosted mode: the grants file, keys and `authenticate`; the
  Streamable HTTP transport (`http.ts`); the gateway (`gateway.ts`) and its
  entry (`gateway-main.ts`); a credential's worker (`worker.ts`), its channel
  (`worker-rpc.ts`), and the provider hook with the local provider
  (`workers.ts`).
- `src/main.ts` — the standalone server above.

Entry points: the root, `./sandbox-child` (the child runtime, for a harness's
own child entry), and leaves that load nothing else — `./module-auth`,
`./redact`, `./jsonsafe`, `./scratchpad`, `./client-cache`, `./paths`,
`./tools`, `./fanout`, `./record` (the format, writer, reader, store and validator) and
`./record/recorder` (the recorders) — for processes that run no sandbox. The package releases with the
SDK at the same version.
