# Changelog

What each release of the stack changed: the module, `@wrathbench/sdk`,
`@wrathbench/mcp` and `@wrathbench/inspector`, which release together at one
version. Versions follow
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

- **A browser off loopback signs in to the inspector over TLS.** Its
  sign-in cookie is now `Secure` whenever the bin is bound off loopback,
  where it was only over `https:`, so a browser reaching it over plain HTTP
  (a LAN with no TLS or proxy) drops the cookie and stays at the sign-in.
  Put TLS in front, directly or by a proxy; a bearer header still works
  without it.
- **Local workers serve only trusted grants.** `localWorkers` runs each
  credential's worker as the gateway's own user, beside the port secret, and
  now refuses to start one unless told the grants are the operator's own:
  `localWorkers({ trusted: true })`, or `--trusted-local-workers` on
  `bun run gateway`, which otherwise does not start. `GatewayOptions.workers`
  is required. A deployment for people outside it passes its own provider.

### Added

- **Hosted retention.** Hosted sessions' tokens have fingerprints starting
  `0000` (`mcp/src/hosted/tokens.ts`) and the gateway leases no other, so a
  deployment can keep their module audit as long as the person audit. The
  gateway prunes each credential's session records hourly, and removes the
  directory of a credential with no live grant after 30 days unused.
- **Hosted mode for a deployment's own tooling.** Exports
  `@wrathbench/mcp/hosted/gateway` (`runGateway`, `gatewayMain`),
  `/hosted/workers`, `/hosted/worker` (`workerMain`, with `--hello-wait-ms`),
  `/hosted/grants` and `/hosted/grants-cli`, so a deployment can run the
  gateway with a worker provider of its own.
- **The hosted gateway.**### Added

- **The hosted gateway.** `bun run gateway --grants <file> --state <dir>`
  serves the tools over Streamable HTTP (both 2026-07-28 and the
  `initialize` revisions) to the people a grants file names, each with a
  key, a host of their own, a lease ledger, rate, in-flight, login and idle
  limits, and an audit per person (`mcp/README.md`, "The hosted gateway").
  Only the gateway holds the port secret.
- **A worker per credential.** The gateway runs each credential's host in a
  worker of its own (`mcp/src/hosted/worker.ts`), which never holds the port
  secret and asks the gateway for every lease over a channel the gateway
  opens and greets with the worker's secret. Workers start through a
  `WorkerProvider`; `localWorkers` is a process per credential on the
  gateway's machine, and a deployment supplies one for pods.
- **`--program` on the standalone server**: the model's program beside the
  core tools. The host is now `src/host.ts`, shared by `main.ts` and the
  gateway; without `--program` the stdio server is unchanged.
- **`session.json` names the session's world.** An optional `world` label
  beside `owner` and `group` (`SessionWriterOptions.world`), for a host that
  runs more than one worldserver, each over its own characters database: a
  guid is unique within one world only. Additive to `wrath-session/1`;
  absent is the host's one world. The inspector shows it.
- **The module limits what a caller can make the worldserver hold.** Ahead of
  callers that hold only a lease secret and are not trusted (wrath-mcp#43,
  wrath-mcp#29). Per lease: a request rate (`429 rate_limited`;
  `WrathBench.ActionRate`, off by default, 20 a second with
  `WrathBench.ActionBurst` 40 for a hosted world) over
  `POST /action`, `POST /session`, `DELETE /session` and the `/events`
  upgrade, and concurrent `/events` subscribers (`429 subscriber_limit`;
  `WrathBench.EventsSubscribersPerToken` 4); the port secret is exempt from
  both. On the module: leases held (`429 lease_limit`; `WrathBench.MaxLeases`
  1024), connections (`WrathBench.MaxConnections` 4096,
  `WrathBench.MaxConnectionsPerPeer` off), a request head over 8 KiB (`431
  header_too_large`) or body over 64 KiB (`413 body_too_large`, was a silent
  close at 1 MiB), a 30-second deadline on a reply, a subscriber left more
  than `WrathBench.EventsBacklogBytes` (16 MiB) behind or sending a frame
  over 4 KiB (closed), and TCP keepalive on subscriber sockets. A `move_to`
  or `face` field that is NaN is `400 invalid_position`. The loopback
  `GET /health` adds `leases` and `limits`. Nothing a session observes or an
  action does changes. The request rate ships off; the other defaults are
  several times what a client sends: a deployment running more than 1024 characters at once, or more
  than 4 lease-secret subscribers on one token, raises the setting
  (`module/PROTOCOL.md`, "Limits").
- **Leasing through an interface.** `Leaser` (`@wrathbench/mcp`): the
  roster (`CharacterRosterOptions.leaser`) and the standalone server's
  shutdown take, end and give back leases through it, so a host that must
  not hold the port secret can be handed one that asks whoever does.
  `portSecretLeaser` is the default and behaves as before.
- **Grants for hosted mode.** `mcp/src/hosted/grants.ts`: a grants file
  (one credential per grant: person, key hashes, accounts, characters at
  once, limits), `authenticate` over `Authorization: Bearer`, and
  `bun run grants` to add, rotate, revoke, disable and list. The loader
  refuses a grant naming `allowGm`, an account in two grants or reserved for
  the operator, and more than 5 characters at once (`mcp/README.md`,
  "Hosted grants").
- **The inspector's user scope for hosted tenants** (wrath-mcp#29).
  `wrath-inspector --hosted-state <dir> --grants <file>` reads every
  credential's session store under a gateway's `tenants/`
  (`hostedSource(stateDir)`). The operator, with the bearer secret, sees all
  of it; a person signs in with the same `wmk_…` key their MCP client holds
  and sees the stores of every credential they hold, by where a session is
  and never by its record's `owner`, which the credential's host writes. A
  sign-in is an opaque cookie re-checked against the grants on every
  request, so a revoked key or a disabled or removed grant loses access at
  the next one, an open tail included; `POST /api/sign-out` and `GET /api/me`
  join it. Given grants, no request is anonymous, on loopback too. The
  grants' read side is a new entry point,
  `@wrathbench/mcp/hosted/grants-read` (`grants.ts` re-exports it), which the
  boundary lets the inspector import and holds to writing nothing. A test
  keeps the inspector's browser code free of HTML sinks (`innerHTML` and its
  kin), since tenant records are hostile strings.
- **Several characters for one client (fan-out).** Off unless the operator
  grants it: `--max-characters <n> --accounts <a,b,…>` on the standalone
  server, `SandboxHostOptions.fanout` with a `CharacterRoster` and
  `fanoutTools` (`@wrathbench/mcp/fanout`) for a harness. A granted client is
  served the core tools with an optional `character` on `run_snippet`,
  `recent_events` and `state_summary`, plus `login_character`,
  `logout_character` and `list_characters`; a snippet sees `chars`; each
  character has its own token, lease and session record, and the inspector
  lists one client's sessions together. Ungranted, nothing a model is served
  changes (`mcp/README.md`, "Several characters").
- **A program.** Off unless a host asks (`SandboxHostOptions.program` with a
  `Workspace`, `@wrathbench/mcp/workspace`): a file workspace rooted at
  `main.ts` whose exported async functions are routines the model starts and
  stops by name, loaded on save, tracked in a registry that survives a
  restart, with facts handed to the harness. `programTools` serves the file
  and routine tools beside the core tools (`docs/ARCHITECTURE.md`, "A
  program"). Without the option nothing a model is served changes. A
  workspace a harness filled before the first start (files carried over from
  another run, `memory.json` among them) is loaded at that start, starting no
  routine; its `loaded` or `load_failed` fact says `by: "carried"`, since
  nothing restarted.
- **A program at fan-out.** One workspace and one program for a client
  granted several characters, with routines per character:
  `programTools(render, { characters: true })` beside
  `fanoutTools(render, fan, { program: true })`, whose `run_snippet` is the
  program's one-off with a `character`. Logging a character out stops the
  routines started for it; in a new process a character's routines start
  again when its seat opens. What a routine dispatches is recorded with a
  `program` origin naming the routine and its character
  (`docs/SESSION-FORMAT.md`, `calls`).
- **Jump.** `sdk.jump()` (in place) and `sdk.jump({ forward: true })` (at the
  run speed along the facing), the `jump` action: `MSG_MOVE_JUMP` with the
  stock client's launch, the arc flown as a client's physics fly it, and
  `MSG_MOVE_FALL_LAND` where it comes down, which the server charges as any
  fall; `jump()` waits for the landing (`WB_SELF_MOVE` cause `jump`) and
  returns where the body came down. Refusals are values with hints
  (`moving`, `falling`, `flying`, `in_flight`, `stunned`, `rooted`,
  `swimming`, `on_transport`, `controlling`). A jump rises about 1.6y, so it does not clear a step
  `moveTo` refuses as a climb.
- **Knockbacks are answered.** `SMSG_MOVE_KNOCK_BACK` for the character is
  acked as a client acks it (`CMSG_MOVE_KNOCK_BACK_ACK` with the launch), and
  the body flies the arc and lands where it comes down, reported as
  `WB_SELF_MOVE` cause `knockback`; the server no longer holds a knocked
  character in place. A walk in progress ends with the new status
  `knocked_back`. Not answered, as before: aboard a transport or a vehicle,
  while the client moves another unit, and during a taxi flight or a
  server spline (a charge).
- **The character flies.** A character the server has told it can fly
  (`SMSG_MOVE_SET_CAN_FLY`: a flying mount, a flight form) is flown as a
  possessed flyer is: a straight line at the z asked for, at its flight
  speed, refused `path_incomplete` where the line runs into terrain or a
  model, `flight: true` on the result. The ground stays the default: a leg
  is flown only when `moveTo(p, { fly: true })` asks (`move_to` `fly`) or
  the body is already in the air; a ground refusal stays a refusal, its
  hint naming `{ fly: true }` for a character that can fly. A flight that
  ends on the ground lands; one that ends in the air hovers there. The
  module serves the state as `WB_FLIGHT_STATE`, read as
  `state.self.canFly` and `state.self.airborne`, and `dismount()` refuses
  while airborne (`status: "airborne"`: land first). When the server takes
  can-fly away in the air (a dismount, a no-fly zone) the body falls as a
  client's does and lands with `MSG_MOVE_FALL_LAND`, which the server
  charges, reported as `WB_SELF_MOVE` with cause `fall`. New move statuses
  `falling` (a move while the body falls) and `cannot_fly` (`fly` without
  can-fly), `face`'s `409 falling`, each with a hint; flown legs carry the
  line's pitch, the Eye of Acherus's included.
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
- Item odds and ends on the raw allowlist: `CMSG_SOCKET_GEMS`,
  `CMSG_CANCEL_TEMP_ENCHANTMENT`, `CMSG_ITEM_REFUND_INFO`, `CMSG_ITEM_REFUND`,
  `CMSG_REMOVE_GLYPH` and `CMSG_BUY_ITEM_IN_SLOT` (buy into a chosen bag).
  The replies the server sends are events: `SMSG_SOCKET_GEMS_RESULT` (the
  enchantment ids now in the sockets and the bonus),
  `SMSG_ITEM_REFUND_INFO_RESPONSE` and `SMSG_ITEM_REFUND_RESULT`.
- Single-item repair: `repairAll(vendor, item?)` and the `repair_all` action
  take an optional item (a name, guid or `{ bag, slot }`, worn or carried;
  `itemGuid` on the wire) and repair that one item. Without one, repair-all is
  unchanged.
- Instances on the raw allowlist: `CMSG_REQUEST_RAID_INFO`,
  `CMSG_RESET_INSTANCES`, `MSG_SET_DUNGEON_DIFFICULTY` and
  `MSG_SET_RAID_DIFFICULTY`. Their answers are events: the saved instances
  (`SMSG_RAID_INSTANCE_INFO`, read as `state.self.instanceLocks`: map,
  difficulty, instance id, locked, extended, `resetsAt`), each reset or
  failure (`SMSG_INSTANCE_RESET`, `SMSG_INSTANCE_RESET_FAILED`), the
  server's difficulty (both `MSG_SET_*_DIFFICULTY`, read as
  `state.self.dungeonDifficulty` and `raidDifficulty`), and on their own
  `SMSG_UPDATE_INSTANCE_OWNERSHIP`, `SMSG_UPDATE_LAST_INSTANCE`,
  `SMSG_INSTANCE_SAVE_CREATED` and the raid warnings
  `SMSG_RAID_INSTANCE_MESSAGE`. A solo difficulty change the server accepts
  is not answered. The saved-instance list is as of the last reply: a new
  save shows on the next `CMSG_REQUEST_RAID_INFO`.
- World states, weather and the game clock: `SMSG_INIT_WORLD_STATES` and
  `SMSG_UPDATE_WORLD_STATE` (read as `state.self.worldStates`, id → value
  with the map, zone and area the init named), `SMSG_WEATHER`
  (`state.self.weather`, named by `WeatherState`) and
  `SMSG_LOGIN_SETTIMESPEED` (`state.self.gameTime`). Entering a new zone
  clears the last zone's weather until the new zone's own arrives (an
  instance sends none). The reattach replay restates them with the
  difficulty, the raid one on the core's own map-arrival branch. A relog
  clears the new readings and every threat list until the new session
  restates them, all but the dungeon difficulty, which the login sends
  first.
- Threat: `SMSG_THREAT_UPDATE`, `SMSG_HIGHEST_THREAT_UPDATE`,
  `SMSG_THREAT_REMOVE` and `SMSG_THREAT_CLEAR`, read as a `threat` list on
  the creature's `units()` row (each unit's threat, highest first, and
  `topGuid` the one it attacks). The server sends a creature's list at most
  once a second while it fights, to every client in range.
- `SMSG_THREAT_UPDATE`, `SMSG_HIGHEST_THREAT_UPDATE` and
  `SMSG_UPDATE_WORLD_STATE` are folded into state but never retained in the
  SDK's event buffer (`recent()`, a wait's lookback), as the party frames
  are, and the bare MCP's `recent_events` folds them as ambient, as it does
  movement: about one threat list a second per creature fighting in range,
  and three world state changes a second while an outdoor PvP capture slider
  moves. The threat list's removal and clear and the zone's initial world
  states stay ordinary events.
- Own speeds: our own create block carries `speeds` (walk, run, run back,
  swim, swim back, flight, flight back, turn and pitch rate), and each
  `SMSG_FORCE_*_SPEED_CHANGE` is an event as well as acked as before;
  `state.self.speeds` reads them.
- Dispel logs: `SMSG_SPELLDISPELLOG`, `SMSG_SPELLSTEALLOG` and
  `SMSG_DISPEL_FAILED`, with the dispel and each aura named.
- **The session record format, `wrath-session/1`** (`docs/SESSION-FORMAT.md`):
  one directory per session of append-only JSONL segments (`trace`, `events`,
  `calls` and a live-only `nearby` ring), `session.json`, `live.json` and a
  manifest, with a validator (`mcp/src/record/validate.ts`) and fixture
  sessions. Unstable until v1 ships.
- **Sessions are recorded.** `mcp/src/record/` holds the session writer, the
  reader, the store and the recorders (the trace, the character sheet, the
  nearby ring and the death, flight and party watchers, moved here from
  WrathBench's runner, and a new events recorder). A `SandboxHost` given
  `record: { writer }` runs the recorder in its child and drains it on its own
  tick; `ToolSet.call` writes every tool call and result through
  `CoreToolContext.record`. `bun mcp/src/main.ts` records by default into
  `--record-dir` (a `sessions` directory beside the state directory), prunes
  sessions closed more than `--record-retention-days` ago (default 3), and
  `--no-record` turns it off. Players who are not sessions of the same
  deployment are never written (`mcp/src/record/gate.ts`), and free text is
  scrubbed of their guids and names, best-effort. New entry point
  `@wrathbench/mcp/record`.
- **wrath-inspector**, a third package, `@wrathbench/inspector`
  (`inspector/README.md`): read-only JSON and server-sent events over a
  session store (`createInspectorApi(source)`), the trace, nearby and
  track-inventory codecs that pack a session for a map, and the `wrath-inspector --store
  <dir>` bin, which needs a bearer secret to bind anywhere but loopback. It
  reads records through the new `@wrathbench/mcp/record/read` entry point and
  nothing else of the stack, and neither that entry, through everything it
  loads, nor the inspector writes or deletes a file (`scripts/boundary.ts`).
  Its SolidJS views (the live map, the session list and page, the
  character's unit frame, inventory and quest log, the party and the event
  feed) are `@wrathbench/inspector/views`, styled by one stylesheet
  (`@wrathbench/inspector/views/views.css`) over the host page's shell, with
  the pure logic a map plays a session with (the trace player and its clocks,
  a track's cursor maths and route, the transport's arithmetic, movement
  intentions, the camera's fit) and the base shapes of a map's position and
  track feeds; the bin serves a page built from them, with minimap tiles
  from `--tiles <dir>` when it has them.
  Wowhead's tooltip script, a third-party request, is opt-in: the views ask
  for it only on a page that calls `enableWowhead()`, which the bin's page
  does with `--wowhead`.
- **An item's random suffix is named in the record.** The trace's dictionary
  gains `rands`, `[rand, suffix]` for each random property id the sheet's
  `equip` and `inv` rows carry, once per segment like an item's name, so a
  reader shows "Sentry's Leggings of the Bear" where it showed the template's
  name; no row grows. The inspector's trace segments carry it as `rands` and
  its inventory views put it on the item's name.

### Changed

- **The sandbox child's sockets and resources are confined too.** Beside
  the Landlock ruleset, `confine.ts` installs a seccomp filter: the child may
  open IPv4 and IPv6 TCP sockets, unix stream socketpairs, and UDP sockets
  only when the module URL names a host to resolve; every other family
  (pathname and abstract unix sockets, netlink, raw, packet), SCTP and MPTCP
  are `EACCES`, and io_uring is `ENOSYS`. It also sets resource limits
  (`SandboxLimits`, `SandboxHostOptions.limits`, the gateway's
  `sandboxLimits` and `--limit-as`/`--limit-cpu`/`--limit-fsize`): 16 GiB of
  address space, a 1 GiB file size and no core dumps by default, and a CPU
  cap that is off unless set. Nothing a session legitimately does reaches
  them. The sandbox now also needs x86-64 or arm64 and a container that
  permits `prctl(PR_SET_SECCOMP)` (the default profiles do), and refuses to
  start otherwise.
- **The inspector's sign-in cookie is an opaque id, not the secret.** It
  stands for a sign-in the bin holds in memory for at most twelve hours, so
  a restart signs browsers out, and a browser holding the old cookie signs in
  once more. It is `Secure` off loopback as well as over TLS. For an
  embedder: `SessionScope`'s user is `{ kind: "user", person, credentials }`
  (the grant ids it may read) where it was `{ owner }`; `inScope(session,
  scope)` keeps its signature and grants a user nothing, since a record's
  labels are its writer's; `credentialInScope(credential, scope)` is the
  check a source that places sessions under credentials makes; and
  `bearerScope` is replaced by `inspectorAuth({ secret, grants })`.
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
- **Hint and result text from two long single-character runs.** Text a model
  reads, changed where it misled or said nothing:
  - `run_snippet`'s description says the `scratchpad` calls return Promises
    (`await scratchpad.read()`).
  - Cast refusals: `caster_aurastate` no longer gives a warrior's example and
    says an effect the spell needs is missing or one the caster carries rules
    it out; `only_abovewater`, `aura_bounced` and `incorrect_area` have
    meanings where they read "the server refused it". A `not_ready` gives the
    time left on a cooldown the server announced, else when the spell last
    went off and which other cast is inside the global cooldown's reach.
  - An interrupted cast is attributed where this client saw the cause: its
    own loot or `cancelCast` sent during the cast, a stun, a target gone from
    view, or a hit that landed in the same instant, beside its own move and
    death as before. With none of them it says the server names no cause,
    where it said "moving or acting during it".
  - `path_incomplete` hints name the point as `reachedPos`, the field
    `moveTo`'s result already carried and `sdk/API.md` never mentioned;
    `moveToAsync`'s refusal carries `reachedPos` too.
  - A `path_incomplete` and a climb's `drop` end by naming `unstuck()`.
  - `lootCorpse` and an opened item's `none_stored` carry a hint, in the
    result and the harness block: the server's inventory refusal (bags full)
    when it sent one. A loot window that never arrives still throws
    `EventTimeoutError`, now with what the cache shows of the corpse.
  - `sellItem` refuses an item given by name itself, listing the guid the
    bags hold it under, where the module answered `invalid_guid` and named a
    unit; the `invalid_guid` hint speaks of items as well as units.
  - `unstuck()`'s `cast_failed` for `not_mounted` says to dismount first.
  - `char_create_failed_code_48` says the race/class combination is not
    allowed.
  - `sdk/API.md` says areatriggers fire by themselves along walks and flown
    legs, and names `questAreas` where quests are taken and read.
- The harness block shows the same hint from several routines in one result
  as one line that names them, where it repeated the sentence per routine.
- `CoreToolRender.isAmbient` is handed the event's data after its opcode,
  so a harness can fold one kind of an opcode's events out of
  `recent_events` and keep the rest. A render that reads only the opcode is
  unchanged.

### Fixed

- `leaseSessionSecret` retries a module it cannot reach for about a minute
  (`LEASE_RETRY_DELAYS_MS`), then throws. It used to return without a secret,
  so a run whose pod started before its network path to the worldserver was
  up played its whole episode unauthenticated: every event-stream connection
  refused, nothing seen. A launch that cannot lease now fails, and is retried
  as an attempt.

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
- `zod` 4.4.3 to 4.6.7, for GHSA-mrhx-c7xc-m3w5: before 4.6.6 a schema over a
  large array, set or map built an issue for every failing element, so one
  oversized payload could exhaust memory; 4.6.6 checks the size bounds first,
  and an oversized array now reports the one bound issue where it reported one
  per element as well. The 4.5 release also tightened what a schema accepts:
  string lengths count code points, and `z.iso.datetime()` needs seconds.
- A sandbox killed because its event loop stopped answering no longer blames
  the snippet whose timeout noticed. That snippet was often a bystander parked
  in `sleep` while a routine or the client's own work held the loop; its
  error and the `sandbox_restarted` notice now say the loop was blocked and
  that what blocked it is not known. Every snippet in flight on the killed
  child is told the same (one waiting beside it was told the process
  exited), one stall is one restart (a second snippet timing out during the
  first one's ping could kill the fresh child), and a child's exit fails only
  the requests sent to it.
- `showTaxiNodes` at a flight master not yet visited threw on the first call.
  The server answers that hello by teaching the node (`SMSG_NEW_TAXI_PATH`)
  and sends a menu cut short before its taxi option; the call now greets the
  master once more, as a player clicks again, and returns the window.

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
