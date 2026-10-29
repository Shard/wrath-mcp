# Changelog

What each release of the stack changed: the module, `@wrathbench/sdk` and
`@wrathbench/mcp`, which release together at one version. Versions follow
semantic versioning (`CONTRIBUTING.md`, "Versioning"). The module's wire
version, `protocol` on `GET /health`, is separate and named where it moves.

## 0.2.0

Wire protocol: unchanged, `1`.

### Operators must act

- **The module binds to loopback by default.** `WrathBench.BindAddress` now
  defaults to `127.0.0.1` (it was `0.0.0.0`). A deployment whose callers are on
  other hosts sets it, for example `AC_WRATH_BENCH_BIND_ADDRESS=0.0.0.0` in the
  worldserver's environment, and keeps the port on a private network.
- **The module refuses GM accounts.** `POST /session`, `POST /characters` and
  `POST /character-delete` answer `403 gm_account` for an account whose
  security level is above player on any realm, before touching any other
  session. Sessions run as players. Use accounts made with `account create`
  that no one has raised.
- **Audit files are named by fingerprint, not token.** A session's audit file
  is `<AuditDir>/<fingerprint>.<YYYY-MM-DD>.jsonl`, the fingerprint being the
  first 16 hex characters of the token's SHA-256, and each record's `session`
  is the session's tag, `tok:` and the first 8 (`module/PROTOCOL.md`, "Audit
  log"). `session_reclaimed` records name the reclaiming session as
  `bySession`, its tag, where they carried its token as `byToken`. Tooling that
  finds a session's files by its token hashes the token first; files written
  before the upgrade keep their old names until retention removes them.
- **The standalone MCP server's state directory moved.** It defaults to
  `$TMPDIR/wrathbench-mcp/<fingerprint>` (it was `<token>`). To resume a session
  kept under the old path, pass `--dir <that path> --token <its token>` once;
  the token is then kept in the directory and `--dir` alone resumes it.

### Added

- `unstuck()` in the SDK: the client's Help → "I'm stuck", the Stuck spell
  (7355), sent on a confirming second call.
- `castSpell(7355)` is sent while dead, as a body or a ghost: Stuck is the one
  spell a dead character may cast, so it is no longer refused with nothing
  sent.
- The MCP server's clean exit (stdin closing, SIGINT, SIGTERM) logs the
  character out and releases its lease, with the port secret and bounded; a
  second signal exits at once.
- The MCP server keeps its token in the state directory (`token`, mode 0600,
  the directory 0700) and resumes it from `--dir` alone; `--token-file <path>`
  names a token without putting it in argv.
- `@wrathbench/mcp/module-auth`: `tokenTag` and `tokenFingerprint`, the
  module's names for a session, and `logoutSession`.

### Changed

- The module is MIT-licensed, as is the rest of the repository; it was
  GPL-2.0-or-later. `module/src/WbNavRecast.cpp` keeps its zlib notice.
- `castSpell`'s refusal while dead says that Stuck is the one spell that goes
  off, and that `unstuck()` sends it.

### Fixed

- No session token in any log, error or file name:
  - the worldserver log names a session by its tag, never the token;
  - `EventStreamClosedError` names the stream's address without its query,
    where it carried `?token=`;
  - the MCP server's stderr names the session by its tag and its state
    directory by fingerprint, where both carried the token.
- `turnInQuest` no longer refuses a complete quest on a stale or gated
  questgiver marker.
- A `move_to` already within the smooth path's slop of its request ends there.
- The sandbox child's Landlock read list is built from where the `mcp` and
  `sdk` packages and their dependencies resolve, so a consumer's install
  layout is confined correctly.

## 0.1.0

The stack's first version, as separated from WrathBench: the module, the SDK
and the MCP server with its sandbox and core tools.
