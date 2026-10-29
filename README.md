# wrath-mcp

A client-equivalent agent surface over a stock AzerothCore (World of Warcraft
3.3.5a): packets, not pixels. It gives an agent a game client's eyes and hands
on a live character, and nothing a client would not have. Every action goes in
as the client opcode a real client would send, through the same server handler,
and every observation is a packet the server would send that client.

Three pieces:

| Path | What it is |
|---|---|
| `module/` | `mod-wrathbench`, the C++ AzerothCore module. A thin packet bridge and event tap over HTTP and WebSocket inside the worldserver. Its wire is `module/PROTOCOL.md`. |
| `sdk/` | `@wrathbench/sdk`, the typed Bun/TypeScript client over that wire: the event stream, the state cache, the helpers and their per-call hints. `sdk/API.md` is the generated per-method reference an agent reads. |
| `mcp/` | `@wrathbench/mcp`, the agent surface over the SDK: a confined, persistent snippet sandbox holding one client, an MCP server, and the core tools `run_snippet`, `recent_events`, `state_summary`, `write_scratchpad` and `edit_scratchpad`. |

What an agent may observe and do is `docs/CONTRACTS.md`; with
`module/PROTOCOL.md` it is the stack's specification. The stack knows nothing
of episodes, scores or trajectories. A harness plugs those in through the hooks
`mcp/` exposes; `docs/ARCHITECTURE.md` is how the pieces fit and what those
hooks are. [WrathBench](https://github.com/Shard/WrathBench), an LLM
evaluation harness, is one such harness and the stack's first consumer.

Tested against AzerothCore
[`3cafaf4a588fd1f287678fdb37438fdedd1ed85c`](https://github.com/azerothcore/azerothcore-wotlk/commit/3cafaf4a588fd1f287678fdb37438fdedd1ed85c).

## Building the module into a worldserver

1. Check out AzerothCore at the tested commit.
2. Copy `module/` to `modules/mod-wrathbench` in that tree. The directory name
   matters: `mod-wrathbench.cmake` names `modules/mod-wrathbench/src/` when it
   stamps the build identity.
3. Build as usual; AzerothCore's CMake discovers the module itself. Pass
   `-DWRATHBENCH_BUILD=<your build id>` to name the build on `GET /health`;
   without it the module reports `unknown`.
4. Copy `module/conf/mod_wrathbench.conf.dist` beside the worldserver's config
   and set it:
   - `WrathBench.Enable = 1` (or `AC_WRATH_BENCH_ENABLE=1`). The module is off
     unless this is set, in the shipped conf and in the code alike, so a
     worldserver that only has it built in opens no control port.
   - `WrathBench.Secret`, the port secret, 32 characters or more. It is
     required; without it the module does not listen. Keep it out of the file
     itself and pass it as `AC_WRATH_BENCH_SECRET` in the worldserver's
     environment.
   - `WrathBench.Accounts`, the game accounts sessions may use. Each must exist
     in the auth database (`account create <name> <password>` on the
     worldserver console) and be a player account: the module refuses one
     with a GM security level (`gm_account`), and chat the server would run
     as a command (`chat_command`), unless the caller opts in to GM use
     (`mcp/README.md`, "GM accounts").
   - `WrathBench.BindAddress` and `WrathBench.Port` (default `127.0.0.1:8086`,
     loopback only). To serve callers on other hosts, set the address and keep
     the port on a private network: it is plain HTTP with bearer secrets.
   - `WrathBench.AuditDir`, where the per-session audit logs go. Its default is
     the AzerothCore Docker image's log path; outside that image, point it at a
     writable directory.

The worldserver needs the 3.3.5a client data (`dbc`, `maps`, `vmaps`,
`mmaps`) for that core, extracted from a client you own. None of it is in this
repository, and none of it may be committed here.

## Quick start

With Bun 1.4.4 (`.bun-version`) and Linux:

```bash
bun install --frozen-lockfile
```

Check the module end to end with the SDK alone. `sdk/examples/live-slice.ts`
connects, creates or reuses a character, says a line, reads the echo off the
event stream and checks the state cache against it:

```bash
MODULE_HOST=127.0.0.1 MODULE_PORT=8086 \
WRATHBENCH_MODULE_SECRET=<the port secret> \
  bun sdk/examples/live-slice.ts
```

It uses the module's default account (`WrathBench.Account`). `live-move.ts`
does the same for movement.

Then serve the core tools to an MCP-capable agent:

```bash
WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 \
WRATHBENCH_MODULE_SECRET=<the port secret> \
  bun mcp/src/main.ts --account <an allowed account>
```

It speaks MCP over stdio, so the agent launches it as its server command. It
leases a session secret with the port secret and hands the sandbox only that,
and when it exits cleanly it logs the character out and releases the lease.
The sandbox needs Linux 6.7 or later (Landlock with TCP rules) and refuses to
start without it. `mcp/README.md` has the options; `sdk/README.md` covers
using the SDK directly.

## Development

```bash
bun test                 # sdk, mcp and the boundary check, against an in-process module stub
bun run typecheck        # tsc over sdk, mcp and scripts; bun test does not check types
bun run boundary         # the stack imports nothing but itself and declared dependencies
bun run docs:api:check   # sdk/API.md matches the source it is generated from
```

None of these needs a game stack or any game data. The module compiles only
inside an AzerothCore tree; see `CONTRIBUTING.md` for how a module change is
verified.

## Versions

The stack follows semantic versioning (`CONTRIBUTING.md`, "Versioning"):
major for a breaking change, minor for a feature or addition, patch for a fix.
Before 1.0 any release may break, and `CHANGELOG.md` says how. It lists what
each release changed and what an operator must do about it.

## Licence

Everything here is MIT under `LICENSE`, except
`module/src/WbNavRecast.cpp`, which is derived from Recast Navigation and keeps
its zlib licence notice. A worldserver built with the module is a combined work
under AzerothCore's licence. Nothing here relicenses AzerothCore, Blizzard's
assets or any dependency; see `THIRD-PARTY-NOTICES.md`.

Nothing Blizzard-derived is in this repository: no client files, no extracted
maps or DBCs, no game text. The client data a worldserver needs is the user's
own to supply, and the stack runs only against a private AzerothCore server.
