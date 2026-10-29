# Changelog

What each release of the stack changed: the module, `@wrathbench/sdk` and
`@wrathbench/mcp`, which release together at one version. Versions follow
semantic versioning (`CONTRIBUTING.md`, "Versioning"); before 1.0 any release
may break, and its entry says how. The module's wire
version, `protocol` on `GET /health`, is separate and named where it moves.

## Unreleased

Wire protocol: unchanged, `1`. Every wire change below is an addition.

### Operators must act

- **`WrathBench.Enable` ships off.** `mod_wrathbench.conf.dist` now sets
  `WrathBench.Enable = 0`, matching the code's default, so a worldserver that
  only has the module built in opens no control port. A deployment that
  relied on the shipped conf's `1` sets it, in its conf or as
  `AC_WRATH_BENCH_ENABLE=1` in the worldserver's environment.
- **Command chat is refused by default.** Without the GM opt-in (below), `say`
  and `raw` `CMSG_MESSAGECHAT` answer `403 chat_command`, with a hint and
  nothing sent, for text the server would run as a command: the core's own
  `.`/`!` prefix test, and the addon channel's command form, whatever the
  account. That closes the gap 0.2.0 left, a player account granted commands
  in `rbac_account_permissions`. A deployment whose sessions send commands on
  purpose opts in; one that never does changes nothing.

### Added

- **The GM opt-in, off by default.** The MCP server's `--allow-gm` or
  `WRATHBENCH_ALLOW_GM=1` (`mcp/README.md`, "GM accounts"), and the SDK's
  `connect({ allowGm: true })`, let a GM account in and pass command chat
  through. On the wire it is `allowGm` on `POST /session`, `POST /characters`,
  `POST /character-delete` and `POST /lease`; a leased token's creates take
  the lease's, so only the port secret's holder can opt in, never a snippet.
  `POST /lease` echoes `allowGm`. There is no server conf for it. The
  SDK's opt-in is the client's: `createSession` sends it, and strikes an
  `allowGm` a call passes.
- `gm_account` and `chat_command` in `KNOWN_ERROR_CODES`, each with a hint
  that says how to opt in; the module's replies carry the same as `hint`.
- The server's refusals a client shows, as events: `SMSG_AREA_TRIGGER_MESSAGE`
  (a portal refused in words: a dungeon's level gate, a closed instance, a raid
  without a raid group), `SMSG_QUESTGIVER_QUEST_INVALID` (why a quest cannot be
  taken) and `SMSG_CHAT_PLAYER_NOT_FOUND` (a whisper to nobody online).
  `SMSG_PLAYERBINDERROR` and `SMSG_RESURRECT_FAILED` are never sent by the
  core, so nothing stands in for them.
- The vendor buyback slots: `invSlot74`-`85` and `buybackPrice0`-`11` on self,
  read by `state.buyback()`, the slot being what `CMSG_BUYBACK_ITEM` names.
- Unit reaction: the module serves each unit's FactionTemplate.dbc row beside
  its `faction` (`factionRow*`), and `units()` rows carry `reaction`
  (`"hostile"`, `"neutral"` or `"friendly"`), the client's reading of that row
  against the character's own and its reputation.
- `use_item` takes `glyphSlot` (0-5), the slot a client's glyph frame sends
  with a glyph; `useItem(..., { glyphSlot })` in the SDK.
- Unit state flags named, from the `unitFlags` and `dynamicFlags` the module
  already serves (no wire change): `units()` rows carry `inCombat`,
  `stunned`, `skinnable`, `lootable`, `tapped` and `tappedByYou` (the client's
  own readings; undefined until a block carried the field), and
  `state.self` carries `inCombat` and `stunned`. Stand state, shapeshift form,
  glyphs, own stats and rested XP need fields the module does not forward yet.
- Dismount: `state.self.mounted` (`UNIT_FLAG_MOUNT` on self, no wire change)
  and the SDK's `dismount()`, which sends the client's Dismount,
  `CMSG_CANCEL_MOUNT_AURA` (new on the raw allowlist), and answers
  `dismounted` once the flag clears; `not_mounted` and `in_flight` are
  answered from the state cache with nothing sent.
- Items that open for loot: `use_item` on an item with `ITEM_FLAG_HAS_LOOT`
  and no on-use spell or quest (a clam, a satchel, a lockbox) sends
  `CMSG_OPEN_ITEM`, where it answered `item_not_usable`. The SDK's `useItem`
  empties the window under the item's guid as `lootCorpse` empties a corpse's
  and answers `looted`, `none_stored` or `empty` with what reached the bag, or
  `refused` with the `InventoryResult` (a locked lockbox).

### Changed

- The `opcode_not_allowed` hint and `activateTaxi`'s already-mounted refusal
  point at `dismount()` rather than a raw `CMSG_CANCEL_AURA`.

- Versioning: before 1.0 any release may break, and the changelog says how
  (`CONTRIBUTING.md`, "Versioning").
- `LeaseOutcome` from `leaseSessionSecret`/`leaseRunSecret` carries
  `allowGm`, the module's word on the opt-in (false from a module that
  predates it).
- `acceptQuestFrom` settles on `SMSG_QUESTGIVER_QUEST_INVALID` with
  `status: "refused"`, the reason and a hint, where it waited out its timeout;
  `useItem` on a quest-start item likewise answers `status: "quest_refused"`.
- `waitForTransfer` settles on `SMSG_AREA_TRIGGER_MESSAGE` with
  `status: "refused"` and the server's text, where it answered `no_transfer`
  after its timeout, and a `moveTo` that crossed such a portal carries the
  refusal in its hint.

### Fixed

- `module/PROTOCOL.md` said swap and split are off the raw allowlist; they are
  on it.
- `sdk/API.md`: `raw`'s row said no SDK method sends the talent opcodes, though
  `learnTalent` sends `CMSG_LEARN_TALENT`; `state.self.corpse` is documented;
  `acceptQuestFrom` lists its statuses and `useItem` names `quest_refused`.

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
