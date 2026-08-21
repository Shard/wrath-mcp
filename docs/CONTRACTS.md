# Observation and Action Contracts

These two contracts are what make a server-side control module defensible as a benchmark surface. The module enforces them; the SDK assumes them; the write-up states them.

## Observation contract

The agent may observe exactly what a real 3.3.5a game client connected to this character could observe, and nothing else.

The test for any field is: which `SMSG_*` packet would carry this to a client? If there is no such packet, the agent does not get it.

Allowed, with the client's limits:
- Own character: level, XP, health, power, position, buffs and debuffs, cooldowns, inventory, equipment, gold, quest log with objective progress text, known spells, skills, reputation as the client shows it.
- World objects: creatures, players, game objects, and items within update range, with the fields a client receives (name, level, health as the client sees it, faction, position, hostile/neutral/friendly, target). Objects outside update range or not yet sent by the server are not visible.
- Target: what the client shows for the current target.
- Events: combat log entries, spell results, loot windows, quest updates, gossip menus, vendor lists, chat, death and release, zone changes, errors the client would display.
- Map knowledge: nothing beyond what the SDK or reference bundle provides. The agent does not get the server navmesh or spawn tables.

Not allowed, even though the server knows them:
- Exact mob health when the client would show a percentage.
- Aggro and leash radii, loot tables, respawn timers, spawn coordinates, quest objective coordinates from the database, creature AI state.
- Objects beyond update range or behind the server's visibility checks.
- Anything about other sessions' characters beyond what a nearby player would see.

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
- Chat: say, whisper (for later multi-agent use; harmless now).

Deferred: trainers, flight paths, mail, bank, group invites, trade, talents.

Pathing: the module resolves "move to position" into the client movement packet sequence a client would send along a navmesh path, using the server's mmaps. This is the one place the module does work a client would do locally, and it is done so that movement is correct rather than privileged. The agent still cannot query the navmesh directly; it asks to go somewhere and either arrives or gets a failure event.

## Audit

Every observation served and every action dispatched is logged at the module boundary with session id and timestamp. This log is both the trajectory's ground truth and the evidence that the contracts held for a given run.

## Changing the contracts

Any widening of either contract is a major harness version. Any narrowing is at least a minor version and is noted in the decision log.
