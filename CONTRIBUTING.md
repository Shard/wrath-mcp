# Contributing

Issues and discussion are welcome: a question about why something is the way it
is, a bug, an observation from reading the code. Open a pull request only
against an issue that already exists and that someone has agreed on, and keep
it small. Most of this repository encodes decisions whose reasons are written
down, and a patch that has not met the reason tends to undo it.

## The rules a change is held to

- Nothing Blizzard-derived ever enters git: no client files, no MPQ/DBC, no
  extracted maps/vmaps/mmaps, no game text, no logs.
- An agent observes only what a real game client could observe, and acts only
  through the opcodes and handlers a client would use. `docs/CONTRACTS.md` is
  the authoritative text, and a change to what it means needs the operator's
  explicit approval. Propose one in an issue first.
- The C++ module stays thin: packet bridge and event tap only. Game semantics
  live in TypeScript.
- The model surface — what the SDK and the core tools show a model — is
  governed by one text only, WrathBench's
  [`docs/METHODOLOGY.md`](https://github.com/Shard/WrathBench/blob/master/docs/METHODOLOGY.md)
  ("The model surface"): helpers are earned by observed need, and hints
  explain, never play.

## Licence

Inbound equals outbound: what you contribute is licensed as the file it lands
in, as `README.md` ("Licence") states it. There is no CLA and no DCO sign-off.
Opening the pull request is the grant.

## Running the checks

From a bare clone, with no game data of any kind, and Bun 1.4.x (pinned in
`.bun-version`):

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run boundary
bun run docs:api:check
```

CI runs the same. Bun strips types without checking them, so run the typecheck
as well as the tests. `docs:api:check` regenerates `sdk/API.md` and fails if it
differs from what is committed; commit the regenerated file with the source
change.

## Module changes

The module compiles only inside an AzerothCore tree and is exercised only by a
live worldserver, so nothing here can verify it. A `module/` change is verified
through a WrathBench pin-bump release, which builds the worldserver image with
the change and runs WrathBench's smoke suite
([`infra/smoke/`](https://github.com/Shard/WrathBench/tree/master/infra/smoke))
against the live stack. Say in the
pull request what the change should do on the wire, so the smokes that cover it
can be named. `sdk/examples/live-slice.ts` and `live-move.ts` are the quick
checks against any worldserver you run yourself.

## Where a change is written down

Describe the change in the pull request itself: what it does and why, against
the issue it lands on. A change to the wire is a change to `module/PROTOCOL.md`
in the same pull request; its "Versioning" section says when the `protocol`
number moves. A change anyone using the stack would notice also gets a line in
`CHANGELOG.md`, under the version it ships in.

## Versioning

The stack follows [semantic versioning](https://semver.org/). `@wrathbench/sdk`
and `@wrathbench/mcp` release together at one version (`SDK_VERSION`,
`sdk/package.json`, `mcp/package.json`, `MCP_PACKAGE_VERSION`), and that
version covers the module built from the same commit:

- **Major** for a breaking change: something that worked stops working, or
  works differently, without the user changing anything on their side.
- **Minor** for a feature or an addition: a new method, helper, action, event
  or option that leaves everything existing as it was.
- **Patch** for a fix: behaviour brought back to what the documentation
  already says.

Before 1.0 none of that is promised: any release may break, whatever number
moves, and the changelog says how. Every release has a `CHANGELOG.md` entry,
and what an operator must change on their side is listed there under its own
heading.

The module's wire has its own integer, `protocol` on `GET /health`, which
moves only for a change an existing SDK would misread (`module/PROTOCOL.md`,
"Versioning"); the stack's version moving says nothing about it.
