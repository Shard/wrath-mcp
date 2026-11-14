# CLAUDE.md
Working instructions for agents developing this repository.

## What this is

wrath-mcp is a client-equivalent agent surface over a stock AzerothCore
(World of Warcraft 3.3.5a): the C++ module `module/`, the TypeScript SDK `sdk/`
and the MCP server and snippet sandbox `mcp/`. An agent gets what a game client
would see and do, and nothing more. It records what its own sessions did and
knows nothing of what drove them. The session record (the trace and character
sheet, game events, tool calls and their results) is the stack's: `mcp/` writes
it to the session store, in the format `docs/SESSION-FORMAT.md` specifies, and
`inspector/` reads it.
Episodes, scores, model trajectories (requests, responses, tokens, cost, turns,
compaction) and anything that compares one run with another are a harness's,
plugged in through its hooks. The stack never reads them, and no record of its
own carries a harness's ids or configuration.

## Hard constraints

- Nothing Blizzard-derived ever enters git: no client files, no MPQ/DBC, no
  extracted maps/vmaps/mmaps, no game text, no audit logs, session stores or
  trajectory logs. A fixture session is synthetic, with invented names.
- The agent observes only what a real game client could observe, and the action
  path goes through the same server opcode handlers a client would hit. See
  `docs/CONTRACTS.md`. If you find yourself reaching for a server-side shortcut
  that a client could not do, that is the signal to stop.
- `docs/CONTRACTS.md` is the authoritative text of the observation and action
  contracts. Changing what it means needs the operator's explicit approval; an
  agent never widens or narrows a contract on its own initiative. Wording fixes
  that change no meaning are fine; when in doubt, ask.
- The C++ module stays thin: packet bridge and event tap only. Game semantics
  and all recording live in TypeScript.
- The session store holds NPCs, objects and the deployment's own sessions, each
  from its own session. A player who is not one of them is never written; the
  rules are applied at one place, `mcp/src/record/gate.ts`. This governs
  storage only; what an agent observes live is `docs/CONTRACTS.md`.
- The session record is what a harness's scorer may read. A recorder or format
  change is judged as a change to a model-visible surface is: read WrathBench's
  [`docs/METHODOLOGY.md`](https://github.com/Shard/WrathBench/blob/master/docs/METHODOLOGY.md)
  ("Scoring") first, and change `docs/SESSION-FORMAT.md` in the same pull
  request.
- What the SDK and the core tools show a model is governed by WrathBench's
  [`docs/METHODOLOGY.md`](https://github.com/Shard/WrathBench/blob/master/docs/METHODOLOGY.md)
  ("The model surface") alone; this repository carries no
  copy of those rules. Read it before changing anything a model sees: helpers,
  hints, error text, `sdk/API.md`, core-tool descriptions.
- `sdk/API.md` is generated (`bun run docs:api`); never edit it by hand.
- Pinned versions are pinned: Bun in `.bun-version` and `package.json`, zod,
  TypeScript and `@types/bun` in the manifests, and the AzerothCore commit the
  README says the module is tested against. They agree with WrathBench's pins
  and change deliberately.
- Licensing is stated once, in `README.md` ("Licence"); keep it there rather
  than repeating it. AzerothCore retains its own terms; see
  `THIRD-PARTY-NOTICES.md`.

## Layout

```
module/        C++ AzerothCore module: HTTP/WS bridge into WorldSession
sdk/           Bun/TypeScript SDK over the module
mcp/           Snippet sandbox, MCP server and core tools over the SDK, and
               the session record (mcp/src/record/)
inspector/     wrath-inspector: read-only server, SolidJS views and bin over a
               session store; the UI's dependencies live here and nowhere else
docs/          CONTRACTS.md, the stack's specification with module/PROTOCOL.md;
               SESSION-FORMAT.md, the format of what a session records;
               ARCHITECTURE.md, how the pieces fit and the harness hooks
scripts/       Repository checks (the stack boundary)
```

## Toolchain

- Bun 1.4.x pinned in `.bun-version` and `package.json`. Use Bun built-ins
  before adding dependencies.
- TypeScript strict. Zod only at external boundaries (module messages, model
  output, config).
- C++ follows AzerothCore's module conventions and builds only inside an
  AzerothCore tree.

## How to work

- Read the relevant doc before touching a component: `docs/ARCHITECTURE.md` for
  structure and the harness hooks, `module/README.md` and `module/PROTOCOL.md`
  for the wire, `sdk/README.md` for the SDK, `mcp/README.md` for the sandbox
  and tools, `docs/CONTRACTS.md` for what an agent may see and do,
  `docs/SESSION-FORMAT.md` for what is recorded, `inspector/README.md` for
  reading it back.
- Checks, all fixture-based and green from a bare clone after
  `bun install --frozen-lockfile`: `bun test`, `bun run typecheck`,
  `bun run boundary`, `bun run docs:api:check`. Bun strips types without
  checking them, so a green `bun test` says nothing about types; run both.
- The stack imports nothing outside itself but declared dependencies
  (`scripts/boundary.ts`). sdk/ never imports mcp/, and mcp/ reaches the SDK
  through `@wrathbench/sdk` at an exported entry point. inspector/ takes only
  `@wrathbench/mcp/record/read` and `@wrathbench/mcp/hosted/grants-read` from
  the stack, sdk/ and mcp/ never import it, and the UI's dependencies are
  declared in inspector/ alone.
- A `module/` change cannot be verified here: it ships through a WrathBench
  pin bump and is proven by WrathBench's smoke suite
  ([`infra/smoke/`](https://github.com/Shard/WrathBench/tree/master/infra/smoke))
  against a live stack (`CONTRIBUTING.md`).

## Style

- Plain prose in docs. Bullets where they aid scanning. Keep things concise and
  focused on why, not what.
