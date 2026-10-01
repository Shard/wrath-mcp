# Observation and Action Contracts

These two contracts are what make a server-side control module defensible as a benchmark surface. The module enforces them; the SDK assumes them; the write-up states them.

## Observation contract

The agent may observe exactly what a real 3.3.5a game client connected to this character could observe, and nothing else.

The test for any field is: which `SMSG_*` packet would carry this to a client? If there is no such packet, the agent does not get it.

Allowed, with the client's limits:
- Own character: level, XP, health, power, position, buffs and debuffs, cooldowns, inventory, equipment, gold, quest log with objective progress text, known spells, skills, reputation as the client shows it, achievements earned (the login list plus each own earn, with the names and points a client reads from its own DBC), whether the character is in a rest area (`resting`, the `PLAYER_FLAGS_RESTING` bit on the `playerFlags` the module already serves — the same resting icon a client draws on its XP bar), and whether a flight is in progress (`taxiFlight`, the `UNIT_FLAG_TAXI_FLIGHT` bit on self) with the server's reply to the last flight request, the flight master's window when one is opened through its gossip (`SMSG_SHOWTAXINODES`: the node it stands at and the nodes this character has visited, named from the client's `TaxiNodes.dbc`; never the route table), and where the hearthstone goes (`SMSG_BINDPOINTUPDATE`, at login and after every innkeeper bind).
- World objects: creatures, players, game objects, and items within update range, with the fields a client receives (name, level, health as the client sees it, faction, position, hostile/neutral/friendly, target). Objects outside update range or not yet sent by the server are not visible.
- Target: what the client shows for the current target.
- Events: combat log entries, spell results, loot windows, quest updates, gossip menus, vendor lists, chat, death and release, zone changes, errors the client would display.
- Map knowledge: nothing beyond what the SDK or reference bundle provides. The agent does not get the server navmesh or spawn tables. Wiki-recorded coordinates in the reference bundle are withheld in scored runs and served only where the run's `wikiCoords` dimension says so (`docs/METHODOLOGY.md`). A run may also be configured with no reference bundle at all (`wiki: false`, issue #61): the tool is not offered and the prompt does not name it, which narrows what the agent may see and never widens it.

Not allowed, even though the server knows them:
- Exact mob health when the client would show a percentage.
- Aggro and leash radii, loot tables, respawn timers, spawn coordinates, quest objective coordinates from the database, creature AI state.
- Objects beyond update range or behind the server's visibility checks.
- Anything about other sessions' characters beyond what a nearby player would see.
- The module's own diagnostics: the global session count and the packet-drop census. `GET /health` serves those to loopback (operator) callers only; the network view is liveness-only (see PROTOCOL.md).

Ambiguity resolves toward the client: if it is unclear whether a client could see something, it is not served until someone checks.

## Action contract

Every action is dispatched as the client opcode a real client would send, through the character's `WorldSession` handler. The module never calls server internals (`Player::CastSpell`, `MotionMaster`, teleport commands, GM commands) to perform an action on the agent's behalf.

The action set:
- Session: create character (class, race, name), log in, log out.
- Movement: move to position (client movement packets along a path), stop, face, jump is not required.
- Targeting: set target, clear target.
- Combat: start and stop auto-attack, cast spell by id (with optional target), cancel cast.
- Interaction: interact with object, open gossip with NPC, select gossip option.
- Quests: accept quest from questgiver, complete and choose reward, abandon quest. Quest-start items: an item whose template starts a quest and has no on-use spell is not a `CMSG_USE_ITEM` — the core drops spell id 0 as unknown — so `use_item` on it sends what a client's right-click sends, `CMSG_QUESTGIVER_QUERY_QUEST` with the item's own guid as the questgiver, and the accept names the item guid the same way; the server offers with `SMSG_QUESTGIVER_QUEST_DETAILS`. The quest id is the item template's (client-cache knowledge, as the on-use spell id already is).
- Loot: open loot, take item, take money, take all. Chests: the core ignores `CMSG_GAMEOBJ_USE` on a chest and drops `CMSG_LOOT` on a game object guid, so a chest is opened as a client opens one — `CMSG_CAST_SPELL` of the lock's Opening spell (`SPELL_EFFECT_OPEN_LOCK`) at it, then the same store/money/release sequence.
- Vendor: list, buy, sell, repair.
- Inventory: equip item, use item, destroy item.
- Chat: say. (Other chat types are reachable through the raw passthrough's `CMSG_MESSAGECHAT` until a trajectory earns them a helper.)
- Death: release spirit, reclaim corpse, spirit healer resurrection (the graveyard fallback when the corpse is unreachable).
- Trainers: list, buy spell.
- Talents: learn talent, learn preview talents.
- Raw passthrough: one allowlisted client opcode with a caller-built body, queued verbatim into the stock handler. The allowlist (module/PROTOCOL.md, "raw") holds only opcodes a stock client sends in ordinary play whose handlers do nothing a non-GM client could not do, and excludes movement, session lifecycle, anything already covered by an action, and anything GM-gated. It is the escape hatch the SDK surface philosophy promises (`docs/METHODOLOGY.md`, "The model surface"): a way for a trajectory to show need before a surface is built, not a second path to existing actions. Replies reach the agent only through the existing event whitelist — "I sent it and saw nothing" is precisely the evidence that earns a tap or a helper — and a raw opcode recurring in trajectories is the signal to give it an action. The allowlist is the agent's action surface, never a place to spend for operator convenience.

Observables added under the same test (each is a packet the client receives): the spellbook (`SMSG_INITIAL_SPELLS`, `SMSG_LEARNED_SPELL`, `SMSG_REMOVED_SPELL`, `SMSG_SUPERCEDED_SPELL`), cooldowns (`SMSG_SPELL_COOLDOWN`, `SMSG_COOLDOWN_EVENT`, `SMSG_CLEAR_COOLDOWN`) and talents (`SMSG_TALENTS_INFO`). Own-teleport arrivals ride the same test (`MSG_MOVE_TELEPORT_ACK`): the server tells a client where it landed after a Hearthstone or graveyard port, so the agent is told too. Spell rank and name ride the spell rows as client-cache (Spell.dbc) knowledge, the same way item-template fields already do. No new observation is involved in the state cache keeping a window open: the vendor list, the trainer list and the loot window are already-whitelisted events, and folding the latest of each into the cache — as the gossip menu and the flight master's window already are — only stops the agent from having to re-ask for what it was already told. The loot window closes on the release the server sends; nothing served closes a vendor or trainer frame, so those read as "last observed" with their seq and ts, never as "open".

Achievements and flight paths (issue #8): `SMSG_ACHIEVEMENT_EARNED`, the login `SMSG_ALL_ACHIEVEMENT_DATA` (completed block only) and `SMSG_ACTIVATETAXIREPLY` are whitelisted, with name and points as client-cache (Achievement.dbc) knowledge, and the flight is the `UNIT_FLAG_TAXI_FLIGHT` bit on self. Flight activation stays raw (`CMSG_ACTIVATETAXI`), and the flight master's window (`SMSG_SHOWTAXINODES`) is whitelisted with node names as client-cache (TaxiNodes.dbc) knowledge. The innkeeper bind rides the same test: `SMSG_BINDER_CONFIRM`, `SMSG_BINDPOINTUPDATE`, `SMSG_PLAYERBOUND` whitelisted, `CMSG_BINDER_ACTIVATE` raw. The node positions those same `TaxiNodes.dbc` rows carry are contract-clean too: they are the client's own cache, drawn on the flight map a client shows, so they pass the test the node names already pass. No decision withholds them, and nothing serves them today — the observation is simply built when a trajectory asks for it, which is the repo's observed-need rule for surface growth and nothing more; the route table stays out either way, and none of this touches the wiki-recorded coordinates the `wikiCoords` dimension gates. Achievements and flight use are observed, never inferred: the module never asks the server's achievement manager anything — a run's achievements are what its own packets said — and a flight "ends" when the runner sees the flag flip, because no packet says so and inventing an event for it would be the SDK asserting an outcome the wire never gave. Progress *toward* an achievement is deliberately not tapped: it is not a milestone, and the criteria stream is chatter a client renders and a benchmark has no derivation for.

Skills, the talent frame, item tooltips and reputation: the skill pane is the `PLAYER_SKILL_INFO` update fields on self (3.3.5 has no skill opcode) named from `SkillLine.dbc`; the talent frame is a client-local read of `Talent.dbc`/`TalentTab.dbc` answered on request, with the learned ranks staying `SMSG_TALENTS_INFO`'s; the respec is the trainer's `MSG_TALENT_WIPE_CONFIRM` whitelisted and echoed raw; the item tooltip is the rest of `SMSG_ITEM_QUERY_SINGLE_RESPONSE` decoded; reputation is `SMSG_INITIALIZE_FACTIONS`, `SMSG_SET_FACTION_STANDING` and `SMSG_SET_FACTION_VISIBLE` whitelisted, named from `Faction.dbc` with the race/class base a client adds. All of it is client-cache knowledge over packets the client already receives; nothing here reads server state a client lacks.

Pets, party, mail, bank and trade: the pet frame is `SMSG_PET_SPELLS` (the control bar the core sends on every change), the pet's own unit update fields — including the PUBLIC owner fields `UNIT_FIELD_SUMMONEDBY` / `CREATEDBY` / `CHARMEDBY` and `UNIT_FIELD_PETNUMBER`, which every client in range receives — and the `CMSG_PET_NAME_QUERY` a client fires on the pet number, answered by `SMSG_PET_NAME_QUERY_RESPONSE`; `SMSG_PET_ACTION_FEEDBACK`, `SMSG_PET_TAME_FAILURE`, `SMSG_PET_CAST_FAILED`, `SMSG_PET_NAME_INVALID` are whitelisted and the pet client opcodes are raw. The party is `SMSG_GROUP_INVITE`, `SMSG_GROUP_LIST`, `SMSG_PARTY_COMMAND_RESULT`, `SMSG_GROUP_DECLINE`, `SMSG_GROUP_UNINVITE`, `SMSG_GROUP_SET_LEADER`, `SMSG_GROUP_DESTROYED`; the mailbox is `SMSG_SHOW_MAILBOX`, `SMSG_MAIL_LIST_RESULT`, `SMSG_SEND_MAIL_RESULT`, `SMSG_RECEIVED_MAIL`; the bank is `SMSG_SHOW_BANK`, `SMSG_BUY_BANK_SLOT_RESULT` and the PRIVATE `PLAYER_FIELD_BANK_SLOT_1` / `PLAYER_FIELD_BANKBAG_SLOT_1` update fields on self (the client holds them from login); trade is `SMSG_TRADE_STATUS` and `SMSG_TRADE_STATUS_EXTENDED`. Every one is a packet the client receives; spell and item names ride along as client-cache knowledge. `SMSG_PET_MODE` is never sent by the core, so nothing stands in for it.

Group loot rolls and item text: the roll frame is `SMSG_LOOT_START_ROLL`, `SMSG_LOOT_ROLL`, `SMSG_LOOT_ROLL_WON`, `SMSG_LOOT_ALL_PASSED` and `SMSG_LOOT_MASTER_LIST` whitelisted, the vote `CMSG_LOOT_ROLL` raw; reading a book or letter is `SMSG_READ_ITEM_OK` / `SMSG_READ_ITEM_FAILED` and the page chain `SMSG_PAGE_TEXT_QUERY_RESPONSE` whitelisted, with the item query now serving the template's `pageText` so the SDK can send the `CMSG_PAGE_TEXT_QUERY` a client sends on its own; the player-written text on a mailed letter is `CMSG_ITEM_TEXT_QUERY` raw and `SMSG_ITEM_TEXT_QUERY_RESPONSE` whitelisted. Names and text only; nothing here carries a coordinate.

Deferred until single-player play is validated: the auction house (`CMSG_AUCTION_*` is not allowlisted and no auction reply is tapped), the dungeon finder, guilds, battlegrounds and PvP, glyphs, dual spec and equipment sets. Pet talents and the stable are also unserved: nothing has asked. None of these is a contract question — each is a packet a client receives and an opcode it sends — they are scope, held back so the surface a solo character needs is finished and validated first.

## Pathing

The module resolves "move to position" into the client movement packet sequence a client would send along a navmesh path, using the server's mmaps. This is the one place the module does work a client would do locally, and it is done so that movement is correct rather than privileged. The agent still cannot query the navmesh directly; it asks to go somewhere and either arrives or gets a typed failure event (`no_mesh`, `target_off_mesh`, `start_off_mesh`, `path_incomplete`) — the z-ladder and subdivision retries are the module's, not the agent's, because they are pathing detail. A move the world ends is typed the same way rather than left to inference: `transferred` when a portal or trigger changed the map, `teleported` when a same-map teleport moved the character. Two more pieces of client-local behaviour ride on the mover under the same test: areatriggers — the module reads the client's own `AreaTrigger.dbc` from the data volume and sends `CMSG_AREATRIGGER` on entering a volume, exactly as a client does without the player choosing to, so portals, exploration credit and inns happen to the character as consequences the agent observes; and transports — when the mover's position is inside a transport's model bounds, movement packets carry the `ONTRANSPORT` flag and transport-relative offset a client's physics would produce, so the character is a passenger the server carries. Neither is an agent action; both are what a client does on its own.

## Audit

Every observation served and every action dispatched is logged at the module boundary with session id and timestamp. This log is both the trajectory's ground truth and the evidence that the contracts held for a given run.

## Control-surface authentication

Stated precisely so nobody re-derives it the hard way. The control surface is
a token-bearer one: `POST /action` and `DELETE /session` act on the session
their token names, and the snippet sandbox can reach the port. Without a
credential of its own, a snippet in run A could therefore drive or tear down
run B — across the per-run isolation boundary the harness measures inside.

The floor that closes that (`module/PROTOCOL.md`
"Authentication" is the authority on the served surface):

- **A secret on the port.** Every request and every `/events` upgrade carries
  `Authorization: Bearer`; the module refuses anything else with `401` before a
  route runs, and does not listen at all without a configured secret. There
  is no unauthenticated path and no backward compatibility.
- **A per-run secret the module issues, before the session exists.** The
  runner host, holding the port secret, calls `POST /lease` for the run's
  token and receives a random secret bound to that token and the run's
  account. That secret is the only credential the snippet child gets. It is
  honoured for the token's own `/session`, `/action`, `DELETE /session` and
  `/events` (validated against the lease, so the SDK still subscribes before it
  creates and loses none of the login burst) and refused everywhere else: for
  another token, and for leasing, `/characters` and `/character-delete`.
- **Token-to-account and token-to-character binding.** A leased token lands on
  its lease's account whatever the body says, and the first create that
  succeeds under it binds the character; a later same-token create for another
  is refused. A snippet cannot delete any character — its own included — and
  cannot open a session on any account or character but the one it was
  launched as.
- **The snippet child cannot read what it was not given.** The child is
  exec'd under a Linux Landlock ruleset that allows reads only of what the
  snippet runtime needs to run (runner/README.md, "The sandbox"); `.env`, the
  repo root, the home directory and `/tmp` answer `EACCES` from the kernel
  however the read is attempted, and the sandbox refuses to start rather than
  run unconfined.

The account allowlist (`WrathBench.Accounts`) gates only which accounts the
module serves; it is not caller authentication. What this does not do: it does
not authenticate the operator's own tooling to anything finer than "holds the
port secret", and the audit log remains the record of what each token actually
dispatched.

## Changing the contracts

Any widening of either contract is a major harness version. Any narrowing is at least a minor version and is noted in `docs/METHODOLOGY.md`.
