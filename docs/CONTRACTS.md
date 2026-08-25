# Observation and Action Contracts

These two contracts are what make a server-side control module defensible as a benchmark surface. The module enforces them; the SDK assumes them; the write-up states them.

## Observation contract

The agent may observe exactly what a real 3.3.5a game client connected to this character could observe, and nothing else.

The test for any field is: which `SMSG_*` packet would carry this to a client? If there is no such packet, the agent does not get it.

Allowed, with the client's limits:
- Own character: level, XP, health, power, position, buffs and debuffs, cooldowns, inventory, equipment, gold, quest log with objective progress text, known spells, skills, reputation as the client shows it, achievements earned (the login list plus each own earn, with the names and points a client reads from its own DBC), and whether a flight is in progress (`taxiFlight`, the `UNIT_FLAG_TAXI_FLIGHT` bit on self) with the server's reply to the last flight request.
- World objects: creatures, players, game objects, and items within update range, with the fields a client receives (name, level, health as the client sees it, faction, position, hostile/neutral/friendly, target). Objects outside update range or not yet sent by the server are not visible.
- Target: what the client shows for the current target.
- Events: combat log entries, spell results, loot windows, quest updates, gossip menus, vendor lists, chat, death and release, zone changes, errors the client would display.
- Map knowledge: nothing beyond what the SDK or reference bundle provides. The agent does not get the server navmesh or spawn tables. Wiki-recorded coordinates in the reference bundle are withheld in scored runs and served only where the run's `wikiCoords` dimension says so (`docs/METHODOLOGY.md`).

Not allowed, even though the server knows them:
- Exact mob health when the client would show a percentage.
- Aggro and leash radii, loot tables, respawn timers, spawn coordinates, quest objective coordinates from the database, creature AI state.
- Objects beyond update range or behind the server's visibility checks.
- Anything about other sessions' characters beyond what a nearby player would see.
- The module's own diagnostics: the global session count and the packet-drop census. `GET /health` serves those to loopback (operator) callers only; the network view is liveness-only (see PROTOCOL.md).

Ambiguity resolves toward the client: if it is unclear whether a client could see something, it is not served until someone checks.

## Action contract

Every action is dispatched as the client opcode a real client would send, through the character's `WorldSession` handler. The module never calls server internals (`Player::CastSpell`, `MotionMaster`, teleport commands, GM commands) to perform an action on the agent's behalf.

Phase 0 action set:
- Session: create character (class, race, name), log in, log out.
- Movement: move to position (client movement packets along a path), stop, face, jump is not required.
- Targeting: set target, clear target.
- Combat: start and stop auto-attack, cast spell by id (with optional target), cancel cast.
- Interaction: interact with object, open gossip with NPC, select gossip option.
- Quests: accept quest from questgiver, complete and choose reward, abandon quest.
- Loot: open loot, take item, take money, take all.
- Vendor: list, buy, sell, repair.
- Inventory: equip item, use item, destroy item.
- Chat: say. (Whisper was listed here from the start but never implemented; corrected 2026-08. Other chat types are reachable through the raw passthrough's `CMSG_MESSAGECHAT` until a trajectory earns them a helper.)
- Death: release spirit, reclaim corpse, spirit healer resurrection (added 2026-08 as the graveyard fallback when the corpse is unreachable).
- Trainers (added 2026-08): list, buy spell.
- Talents (added 2026-08): learn talent, learn preview talents.
- Raw passthrough (added 2026-08): one allowlisted client opcode with a caller-built body, queued verbatim into the stock handler. The allowlist (module/PROTOCOL.md, "raw") holds only opcodes a stock client sends in ordinary play whose handlers do nothing a non-GM client could not do, and excludes movement, session lifecycle, anything already covered by an action, and anything GM-gated. It is the escape hatch the SDK surface philosophy promises (`docs/METHODOLOGY.md`, "The model surface"): a way for a trajectory to show need before a surface is built, not a second path to existing actions.

Observables added 2026-08 under the same test (each is a packet the client receives): the spellbook (`SMSG_INITIAL_SPELLS`, `SMSG_LEARNED_SPELL`, `SMSG_REMOVED_SPELL`, `SMSG_SUPERCEDED_SPELL`), cooldowns (`SMSG_SPELL_COOLDOWN`, `SMSG_COOLDOWN_EVENT`, `SMSG_CLEAR_COOLDOWN`) and talents (`SMSG_TALENTS_INFO`). Own-teleport arrivals ride the same test (`MSG_MOVE_TELEPORT_ACK`, 2026-08): the server tells a client where it landed after a Hearthstone or graveyard port, so the agent is told too. Spell rank and name ride the spell rows as client-cache (Spell.dbc) knowledge, the same way item-template fields already do.

Achievements and flight paths (2026-08-25, issue #8): `SMSG_ACHIEVEMENT_EARNED`, the login `SMSG_ALL_ACHIEVEMENT_DATA` (completed block only) and `SMSG_ACTIVATETAXIREPLY` are whitelisted, with name and points as client-cache (Achievement.dbc) knowledge, and the flight is the `UNIT_FLAG_TAXI_FLIGHT` bit on self. Flight activation stays raw.

Deferred: mail, bank, group invites, trade (all reachable raw; none has a helper or a whitelisted reply yet).

Pathing: the module resolves "move to position" into the client movement packet sequence a client would send along a navmesh path, using the server's mmaps. This is the one place the module does work a client would do locally, and it is done so that movement is correct rather than privileged. The agent still cannot query the navmesh directly; it asks to go somewhere and either arrives or gets a typed failure event (`no_mesh`, `target_off_mesh`, `start_off_mesh`, `path_incomplete`; 2026-08, FOLLOW-UPS 38 N1) — the z-ladder and subdivision retries are the module's, not the agent's, because they are pathing detail. A move the world ends is typed the same way rather than left to inference: `transferred` when a portal or trigger changed the map, `teleported` when a same-map teleport moved the character. Two more pieces of client-local behaviour ride on the mover under the same test (2026-08): areatriggers — the module reads the client's own `AreaTrigger.dbc` from the data volume and sends `CMSG_AREATRIGGER` on entering a volume, exactly as a client does without the player choosing to, so portals, exploration credit and inns happen to the character as consequences the agent observes; and transports — when the mover's position is inside a transport's model bounds, movement packets carry the `ONTRANSPORT` flag and transport-relative offset a client's physics would produce, so the character is a passenger the server carries. Neither is an agent action; both are what a client does on its own.

## Audit

Every observation served and every action dispatched is logged at the module boundary with session id and timestamp. This log is both the trajectory's ground truth and the evidence that the contracts held for a given run.

## Accepted risk: token-bearer control surface (pre-0.2)

Stated precisely so nobody re-derives it the hard way (fan-out review 2026-08,
finding: predictable bearer tokens; tracked as FOLLOW-UPS item 19):

- `POST /action` and `DELETE /session` authenticate solely by the session
  token in the request body. The token is a bearer capability with no binding
  to the caller, and the runner defaults it to the run id — a
  second-granularity timestamp (`run-YYYYMMDD-HHMMSS`), enumerable.
- The snippet sandbox's egress allowlist permits exactly the module host, so a
  snippet can reach these endpoints with any token. The module's distinct
  action statuses (`404 no_session` / `409 not_in_world` / `200`) double as a
  liveness oracle for guessing a neighbor's token.
- Consequence: a malicious or confused snippet in run A can drive actions in,
  or tear down, a concurrent run B on the same module. This crosses the
  per-run isolation boundary and can silently corrupt what the harness
  measures.

This is accepted for now because every job is operator-launched from one
tree on a private compose network with no external callers, and the audit log
records every dispatched action per token. It is a blocker, before any public
or MCP-exposed deployment and before any adversarial multi-run result is
trusted, to make tokens unguessable: a random secret issued at session create,
returned only to the creator, required on every subsequent token-bearing call
(module and runner change together; no backward compatibility). The account
allowlist (`WrathBench.Accounts`) gates only session/character surfaces and is
not caller authentication.

## Changing the contracts

Any widening of either contract is a major harness version. Any narrowing is at least a minor version and is noted in the decision log.
