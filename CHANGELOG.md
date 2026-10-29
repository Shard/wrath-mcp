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
- Vehicles and possession, the observation and the seat half
  (module/PROTOCOL.md, "Vehicles and possession"). Events:
  `SMSG_CLIENT_CONTROL_UPDATE` (which unit the client moves), the boarding
  spline `SMSG_MONSTER_MOVE_TRANSPORT` (vehicle and seat) and `transportExit`
  on `SMSG_MONSTER_MOVE`; the SDK folds them into `state.self.control`
  (`mover`, `allowMove`) and `state.self.vehicle` (`guid`, `seat`), and the
  controlled unit's bar is `state.pet()` as before, cast from with `petCast`.
  Actions: `vehicle_exit` and `vehicle_change_seat`, which send the
  controlled-vehicle opcode (`CMSG_DISMISS_CONTROLLED_VEHICLE`,
  `CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE`, each with the vehicle's
  MovementInfo) from the driving seat and the passenger one
  (`CMSG_REQUEST_VEHICLE_EXIT`, `CMSG_REQUEST_VEHICLE_SWITCH_SEAT`) from any
  other; `CMSG_SPELLCLICK` and `CMSG_PLAYER_VEHICLE_ENTER` on the raw
  allowlist. In the SDK: `spellClick(target)` (refused `no_spellclick` when
  the unit in view has no spellclick flag), `leaveVehicle()` (`left` on the
  exit spline) and `changeSeat(seat)` (`seated` on the new seat's boarding
  spline). The module answers a control handover as a client does
  (`CMSG_SET_ACTIVE_MOVER`, `CMSG_MOVE_NOT_ACTIVE_MOVER`) and reports the end
  of a boarding or exit spline (`CMSG_MOVE_SPLINE_DONE`), audited as
  `active_mover` and `spline_done`.
- Driving the controlled unit (module/PROTOCOL.md, "Vehicles and
  possession", Driving). While a vehicle's driving seat or a possession
  makes another unit the client's mover, `move_to`, `stop` and `face` are
  that unit's: its guid on every packet, its position, speed, map and water
  the walk's, and `mover` naming it on the progress events and the verdict
  (whose `pos` is the unit's; the SDK folds it onto the unit in view, and
  onto the character too when it sits in that vehicle). A ground unit is
  walked over the mesh as the character is; a flying unit (the Eye of
  Acherus) is flown in a straight line at the z asked for and at its flight
  speed, judged against the map's line of sight and the terrain and refused
  `path_incomplete` at the last clear point when it runs into either
  (`flight: true` on the verdict; `moveTo`'s hint says to fly higher or
  around). The unit's root and movement-state packets are answered with its
  guid and kept as its own state; a seated passenger's root and
  movement-state acks carry the seat's transport block, so an ack during
  the boarding spline no longer takes it off the seat in the server's
  record. The walk's drift guard scales with the pace for a flight or a walk
  of another unit, so a flight is not ended `interrupted` for outrunning a
  runner's tolerance; the character's own walk keeps its 15y. The status
  `controlling` is kept for the one case no packet can drive — the core
  holds a mover that is not in the character's map — and for a walk that
  control changes hands under. Before this change the server silently
  dropped such a walk and it ended `interrupted`.
- `petCast(spell, point)`: a ground target for the controlled unit's bar
  (a vehicle cannon's shot), sent as `CMSG_PET_CAST_SPELL` with
  `TARGET_FLAG_DEST_LOCATION`; a unit target and no target are as before.
- Unit state flags named, from the `unitFlags` and `dynamicFlags` the module
  already serves (no wire change): `units()` rows carry `inCombat`,
  `stunned`, `skinnable`, `lootable`, `tapped` and `tappedByYou` (the client's
  own readings; undefined until a block carried the field), and
  `state.self` carries `inCombat` and `stunned`.
- Stand state and shapeshift form on every unit (`standState`,
  `shapeshiftForm`; `units()` rows carry `sitting` and the form's name,
  `state.self` `standState`, `sitting` and `shapeshiftForm`); our own
  character sheet (stats, armour, resistances, attack power, crit, block,
  dodge and parry; `state.self.stats`) and rested XP (`state.self.restedXp`);
  the glyph slots on
  `SMSG_TALENTS_INFO` (`state.talents().glyphs`); and
  `SMSG_EXPLORATION_EXPERIENCE`.
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
- Quest objective areas: `CMSG_QUEST_POI_QUERY` on the raw allowlist and
  `SMSG_QUEST_POI_QUERY_RESPONSE` as an event, the polygons a client's world
  map and quest tracker draw for each quest in the log. The SDK's
  `questAreas()` asks for them and keeps them in `state.questPois`;
  `docs/CONTRACTS.md` records them as served.
- Class resources and the bars a client draws, as events and on
  `state.self`: combo points (`SMSG_UPDATE_COMBO_POINTS`, `comboPoints`); a
  Death Knight's runes (`SMSG_CONVERT_RUNE` and the rune list on
  `SMSG_SPELL_GO`, `runes`); our own channel (`MSG_CHANNEL_START` /
  `MSG_CHANNEL_UPDATE`, and `channelSpell` / `channelObjectGuid` on units,
  `channeling`); totems (`SMSG_TOTEM_CREATED`, `totems`); the breath, fatigue
  and fire bars (`SMSG_START_MIRROR_TIMER` / `SMSG_STOP_MIRROR_TIMER`,
  `mirrorTimers`). The reattach replay re-sends the combo points and any
  converted runes.
- Raw allowlist: `CMSG_SET_AMMO` (with `ammoId`, `PLAYER_AMMO_ID`, on self),
  `CMSG_SELF_RES` (with `selfResSpell`, `PLAYER_SELF_RES_SPELL`, on self),
  `CMSG_DISMISS_CRITTER` and `CMSG_TOTEM_DESTROYED`.
- Replies to allowlisted raw opcodes that answered nothing: `SMSG_NPC_TEXT_UPDATE`
  (a gossip window's body text, for `CMSG_NPC_TEXT_QUERY`),
  `SMSG_TAXINODE_STATUS`, `SMSG_PLAYED_TIME` and `SMSG_QUERY_TIME_RESPONSE`.
- More of what a client is told: `SMSG_NEW_TAXI_PATH`, `SMSG_SET_PROFICIENCY`
  (`state.self.proficiency`, re-sent by the reattach replay),
  `SMSG_SPELLORDAMAGE_IMMUNE`, `SMSG_ENVIRONMENTAL_DAMAGE_LOG` and
  `SMSG_SPELL_DELAYED` (which moves `state.self.casting.endsAt`).
- Item and ground targets on a cast: `cast_spell` and `use_item` take
  `itemTargetGuid` (`TARGET_FLAG_ITEM`, an item the character holds) and
  `destX`/`destY`/`destZ` (`TARGET_FLAG_DEST_LOCATION`, all three or none),
  written into the cast's target block as a client writes it; without them
  the encoding is unchanged. In the SDK, `castSpell(id, target?, { targetItem,
  targetPoint })` and the same two options on `useItem`: an item by name,
  guid or `{ bag, slot }` (worn slots as bag 255), a point `{ x, y, z }` or a
  unit at its position. A point without z is refused with nothing sent. These
  are the target forms Feed Pet, poisons, stones and oils on a weapon,
  enchanting, Disenchant, Prospecting and Milling, and ground-targeted spells
  and items use.
  New module errors `invalid_item_target`, `invalid_dest`, `missing_dest` and
  `no_spell_to_target` (an item that starts a quest or opens for loot takes no
  target). Cast-failure hints name the item or the point and say what the
  item-target codes mean (`wrong_pet_food`, `cant_be_disenchanted`,
  `item_gone`, …).
- Gossip options that take a code. `SMSG_GOSSIP_MESSAGE` options carry
  `coded`, and `boxMoney` (copper) and `boxText` (the confirm text a client
  shows first), each left out when 0 or empty; the menu fold in
  `state.lastGossip(guid).options[]` carries them too. `gossip_select` takes an optional `code`, appended to
  `CMSG_GOSSIP_SELECT_OPTION` as the core reads it for a coded menu item. In
  the SDK `gossipSelect(guid, option, code?)` and
  `gossipSelect(guid, menuId, optionId, code?)`; the by-text form refuses a
  coded option without a code, and a code on one that is not coded, with
  nothing sent.
- Inbound emotes and channel notices: `SMSG_EMOTE` (a unit's one-shot emote),
  `SMSG_TEXT_EMOTE` (a player's text emote, with the target's name as the
  packet carries it) and `SMSG_CHANNEL_NOTIFY` (a channel notice: its type,
  the channel and the type's tail).

### Changed

- **A stun is told apart from a root.** While the unit the client moves
  carries `UNIT_FLAG_STUNNED` (`state.self.stunned` for the character), a
  `move_to` is refused, and a walk ends, with the new status `stunned` where
  it said `rooted`, and `face` is refused `409 stunned` with nothing sent: a
  stunned client neither moves nor turns, a rooted one still turns. A caller
  that matched `rooted` for a stun matches `stunned` too. `stunned` joins
  `MOVE_STATUSES` and `KNOWN_ERROR_CODES`; the `rooted` hints now speak of a
  root alone, and `killTarget`'s re-face shrugs off `stunned` as it does
  `moving`.
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

- `state.pet().spells` carries the bar's own spell buttons beside the
  packet's `spells` list, and `petCast` sends a button as the bar types it.
  A possessed unit's bar (the Eye of Acherus, `Player::PossessSpellInitialize`)
  and a vehicle's list no spells and put everything castable on the buttons
  — the possess form typed `ACT_PASSIVE`, which the handler casts like any
  other — so `petSpell("Recall Eye of Acherus")` found nothing and the Eye
  could not be recalled (the eye-of-acherus smoke, live).
- `module/PROTOCOL.md` said swap and split are off the raw allowlist; they are
  on it.
- `sdk/API.md`: `raw`'s row said no SDK method sends the talent opcodes, though
  `learnTalent` sends `CMSG_LEARN_TALENT`; `state.self.corpse` is documented;
  `acceptQuestFrom` lists its statuses and `useItem` names `quest_refused`.
- A create block's absent fields read as zero. The core sends only the
  non-zero fields in a create (`Object::BuildValuesUpdate`), and a client
  starts every field at 0, so the cache now states `unitFlags`,
  `dynamicFlags`, `standState` and `shapeshiftForm` (and, for the
  character itself, `playerFlags` and `restedXp`) as 0 when a create block
  leaves them out. A fresh character reads `state.self.standState` stand,
  `sitting` false, `shapeshiftForm` none, `restedXp` 0, and a creature with no
  flags reads `inCombat`, `stunned`, `skinnable`, `sitting` false, where they
  were undefined until the first change. A values block that omits a field
  still means unchanged.
- `castSpell` and `useItem` with a `targetPoint` that names no point (no z, a
  unit or name that is not in view) answer `{ ok: false, status:
  "unknown_target", hint }` with nothing sent, as `moveTo` answers a target it
  cannot place; they threw. A malformed point and an unresolvable `targetItem`
  still throw.

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
