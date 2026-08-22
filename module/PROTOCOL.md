# mod-wrathbench wire protocol

The module exposes a small HTTP/WebSocket surface inside the worldserver. The SDK
is generated against this document, so shapes are exact. This is the Stage-2
vertical slice (PHASE-0): session lifecycle, one action (`say`), and a filtered
outbound event stream. It is not the full action set.

Transport: plain HTTP/1.1 and RFC6455 WebSocket on `WrathBench.BindAddress:Port`
(default `0.0.0.0:8086`), reachable only from inside the private compose network.
All request and response bodies are JSON (`Content-Type: application/json`).

**u64 values are decimal strings.** Every guid the module emits — in responses
and in events (`guid`, `senderGuid`, `targetGuid`, `guids[]`) — is serialized as
a decimal string, e.g. `"17365880163140632581"`. 3.3.5a guids carry a high part
(creatures start at 0xF130...) that exceeds `Number.MAX_SAFE_INTEGER`, so a bare
JSON number would be corrupted by any IEEE-double consumer before it could
react. Consumers should compare guids as strings or parse them as BigInt.
(Counters that cannot exceed 2^53 — `seq`, `ts`, drop counts, `moveId` — remain
JSON numbers.)

Two error channels, deliberately separated (docs/CONTRACTS.md):

- **Transport / request errors** — malformed request, unknown token, wrong state —
  are HTTP non-2xx with a JSON body `{ "ok": false, "error": "<code>", ... }`.
- **Game-level errors** — anything the server decides about a dispatched action —
  are never HTTP errors. They arrive as events on the WebSocket (e.g. a
  `SMSG_CHARACTER_LOGIN_FAILED` or `SMSG_NOTIFICATION` event), because that is how
  a real client would learn of them.

## Endpoints

### GET /health

Module and world status. No auth, no body.

Two views (2026-08). Callers on the compose network — the runner and, through
it, the snippet sandbox — get liveness only: `ok`, `module`, `worldStopped`,
with `sessions` / `droppedPackets` / `droppedPacketsLive` present but zeroed
(kept so the SDK response schema parses) and no `droppedByOpcode`. The global
session count and the drop census describe module internals and other runs'
sessions, which the observation contract never serves to a snippet. The full
view below is served only to loopback callers — an operator inside the
worldserver container, e.g.
`docker compose -f infra/compose.yml exec worldserver curl -s localhost:8086/health`.

Operator (loopback) response `200`:
```json
{
  "ok": true,
  "module": "mod-wrathbench",
  "worldStopped": false,
  "sessions": 1,
  "droppedPackets": 4213,
  "droppedPacketsLive": 37,
  "droppedByOpcode": { "SMSG_POWER_UPDATE": 1400, "SMSG_EMOTE": 220, "0x4F2": 3 }
}
```
- `sessions` — number of live bench sessions.
- `droppedPackets` — lifetime count of outbound packets suppressed because they
  were not on the event whitelist (survives session teardown). Whitelist tuning
  signal for later stages; see the whitelist section below.
- `droppedPacketsLive` — the same count summed across only the currently live
  sessions.
- `droppedByOpcode` — per-opcode breakdown of `droppedPackets` (process
  lifetime, added 2026-08): the top 30 dropped opcodes by count, keyed by the
  core's opcode-table name where it has one, `"0xNNN"` hex otherwise. This is
  the whitelist-expansion census PHASE-0 anticipates.

### POST /session

Create (or, if the character already exists, reuse) a character and enter the
world. Blocks until the session reaches the world or fails, up to 20s.

Request:
```json
{
  "token": "run-abc123",     // required, opaque session id chosen by the caller
  "account": "RUNNER",       // optional, defaults to WrathBench.Account
  "character": "Benchy",     // required, character name
  "race": 1,                  // required when the character must be created; in [1,11]
  "class": 1,                 // required when the character must be created; in [1,11]
  "gender": 0                 // optional, default 0 (Male)
}
```

`race`/`class` semantics (tightened 2026-08): when the named character already
exists on the account, `race` and `class` are ignored entirely (as before —
the existing character is logged in as-is). When the character does not exist
— so this request will CREATE one — both must be numeric and in `[1,11]`;
anything else (absent, non-numeric, out of range) fails the request with
`400 {"ok":false,"error":"invalid_race_class","token":...}` before any
char-create packet is synthesized. There is no silent default character
anymore. Whether a create is needed is only known once the module sees the
account's character list, so this check happens mid-flow (after `SMSG_CHAR_ENUM`),
not at request parse time.

Success `200`:
```json
{
  "ok": true,
  "token": "run-abc123",
  "account": "RUNNER",
  "character": "Benchy",
  "guid": "1",                // full ObjectGuid as a decimal string (see u64 note)
  "inWorld": true
}
```

`guid` is the character's full 64-bit ObjectGuid. For players the high part is
zero, so it coincides numerically with the character's low GUID and with the
`senderGuid` of the character's own `SMSG_MESSAGECHAT` events — consumers may
compare them directly (as strings). This response is also the only place the
session's own identity (guid + name) is handed over explicitly; the same guid
reappears on the event stream in the self `SMSG_UPDATE_OBJECT` create block
(`"self": true`), which additionally carries own health/power/position.

Errors:
- `400 {"ok":false,"error":"missing_token"}`
- `400 {"ok":false,"error":"missing_character"}`
- `400 {"ok":false,"error":"invalid_race_class","token":...}` — the character
  does not exist and race/class are not both in [1,11] (see above; decided at
  char-enum time, before any char-create packet is synthesized).
- `409 {"ok":false,"error":"token_in_use"}`
- `403 {"ok":false,"error":"account_not_permitted"}` — `account` is not on the
  `WrathBench.Accounts` allowlist.
- `400 {"ok":false,"error":"unknown_account"}`
- `400 {"ok":false,"error":"socket_setup_failed"}`
- `502 {"ok":false,"error":"char_create_failed_code_<N>","token":...}` — game-level
  char-create rejection (N is the `SMSG_CHAR_CREATE` result code); also surfaced as
  a `SMSG_CHAR_CREATE` event.
- `502 {"ok":false,"error":"login_failed","token":...}`
- `502 {"ok":false,"error":"character_missing_after_create","token":...}`
- `504 {"ok":false,"error":"timeout","token":...}` — the flow did not reach the
  world within 20s.

The login flow the module performs internally, all through the real handlers:
`AddSession` → `SMSG_AUTH_RESPONSE(AUTH_OK)` → `CMSG_CHAR_ENUM` →
[`CMSG_CHAR_CREATE` → `SMSG_CHAR_CREATE` → `CMSG_CHAR_ENUM`] → `CMSG_PLAYER_LOGIN`
→ `SMSG_LOGIN_VERIFY_WORLD`. The caller sees only the final ack.

### POST /action

Dispatch one action. Supported: `say`, `move_to`, `stop`, `face` (`move_to`,
`stop`, `face` added in the movement extension, 2026-08; additive), and the
quest/combat extension set (2026-08, additive): `set_target`, `clear_target`,
`attack_start`, `attack_stop`, `cast_spell`, `cancel_cast`, `interact`,
`gossip_hello`, `gossip_select`, `quest_list`, `quest_details`, `quest_accept`,
`quest_complete`, `quest_choose_reward`, `quest_abandon`, `loot`, `loot_item`,
`loot_money`, `loot_release`, `loot_all`, `vendor_list`, `buy_item`,
`sell_item`, `repair_all`, `equip_item`, `use_item`, `destroy_item`, `repop`,
`reclaim_corpse`, `spirit_healer_activate` (2026-08, additive). Acks that the
opcode was synthesized and queued; the game
result (the chat echo, an arrival, or an error) arrives on the WebSocket.

Common errors for every action:
- `400 {"ok":false,"error":"missing_token"}`
- `400 {"ok":false,"error":"unsupported_action","action":"<x>"}`
- `404 {"ok":false,"error":"no_session"}`
- `409 {"ok":false,"error":"not_in_world"}`
- `409 {"ok":false,"error":"no_player"}`
- `410 {"ok":false,"error":"session_gone"}`

#### say

Request:
```json
{ "token": "run-abc123", "action": "say", "text": "hello world" }
```

Success `200`:
```json
{ "ok": true, "action": "say", "token": "run-abc123" }
```

The say language is chosen server-side from the character's team (Common for
Alliance, Orcish for Horde); the caller does not supply it. A client-visible
rejection (e.g. muted) comes back as a `SMSG_NOTIFICATION` event, not an HTTP error.

#### move_to

Walk the character to a world position. The module resolves the position against
the server's navmesh once (the single sanctioned mmaps use, docs/CONTRACTS.md
"Pathing") and then drives the character with the client movement packet
sequence a real client would send (`MSG_MOVE_START_FORWARD`, heartbeats every
~500ms, `MSG_MOVE_STOP`) at the character's real run speed. The caller never
sees the path — only progress and a terminal result event.

Request:
```json
{ "token": "run-abc123", "action": "move_to", "x": -8913.2, "y": -137.6, "z": 80.9 }
```

Success `200` (means "queued and pathing", not "arrived"):
```json
{ "ok": true, "action": "move_to", "token": "run-abc123", "moveId": 1 }
```

Additional error: `400 {"ok":false,"error":"missing_position","action":"move_to","param":"<first missing axis>"}`.

The outcome arrives as a `WB_MOVE_RESULT` event carrying the same `moveId`
(statuses below). A `move_to` issued while a previous one is still running
supersedes it: the old move ends with status `superseded`, then the new path
starts from wherever the character is.

#### stop

Stop moving (sends `MSG_MOVE_STOP` where the character currently is). Always
acks `200 { "ok": true, "action": "stop", "token": ... }`; if a move was in
progress it additionally ends with a `WB_MOVE_RESULT` status `stopped`.

Request: `{ "token": "run-abc123", "action": "stop" }`

#### face

Turn in place (sends `MSG_MOVE_SET_FACING`). Give either an absolute
`orientation` in radians (0 = east/+x, counter-clockwise, normalized to
[0, 2pi)) or a point `x`,`y` to face toward.

Request: `{ "token": "run-abc123", "action": "face", "orientation": 1.57 }`
or `{ "token": "run-abc123", "action": "face", "x": -8900.0, "y": -130.0 }`

Success `200`: `{ "ok": true, "action": "face", "token": ..., "orientation": 1.57 }`
Additional errors: `400 {"ok":false,"error":"missing_face_target","action":"face","param":"orientation or x,y"}`,
`409 {"ok":false,"error":"moving"}` (stop first, or supersede with `move_to`).

#### Single-opcode actions (quest/combat extension, 2026-08)

Every action below synthesizes exactly one client opcode into the stock
handler (plus, for `loot_all`, the follow-up opcodes a real auto-loot client
sends). The `200` ack means "queued"; game outcomes — cast failures, gossip
menus, loot windows, inventory errors — arrive as the whitelisted events
listed further down, never as HTTP errors. All `guid`/`targetGuid`/`itemGuid`
request fields are decimal strings (u64 note above). Success shape for all of
them: `{ "ok": true, "action": "<name>", "token": ... }`.

| action | request fields (beyond `token`, `action`) | opcode sent | notes |
|---|---|---|---|
| `set_target` | `guid` | `CMSG_SET_SELECTION` | |
| `clear_target` | — | `CMSG_SET_SELECTION` | guid 0 |
| `attack_start` | `guid` | `CMSG_ATTACKSWING` | melee auto-attack; server swings while in range |
| `attack_stop` | — | `CMSG_ATTACKSTOP` | |
| `cast_spell` | `spellId`, `targetGuid?` | `CMSG_CAST_SPELL` | no `targetGuid` = self/auto target (mask 0); with it, TARGET_FLAG_UNIT + packed guid |
| `cancel_cast` | `spellId` | `CMSG_CANCEL_CAST` | |
| `interact` | `guid` | `CMSG_GAMEOBJ_USE` | game objects (chests, doors, quest objects) |
| `gossip_hello` | `guid` | `CMSG_GOSSIP_HELLO` | opens the NPC gossip menu (`SMSG_GOSSIP_MESSAGE`) |
| `gossip_select` | `guid`, `menuId`, `optionId` | `CMSG_GOSSIP_SELECT_OPTION` | ids from `SMSG_GOSSIP_MESSAGE` (`menuId`, `options[].optionId`) |
| `quest_list` | `guid` | `CMSG_QUESTGIVER_HELLO` | `SMSG_QUESTGIVER_QUEST_LIST` or a gossip menu follows |
| `quest_details` | `guid`, `questId` | `CMSG_QUESTGIVER_QUERY_QUEST` | quest text via `SMSG_QUESTGIVER_QUEST_DETAILS` |
| `quest_accept` | `guid`, `questId` | `CMSG_QUESTGIVER_ACCEPT_QUEST` | |
| `quest_complete` | `guid`, `questId` | `CMSG_QUESTGIVER_COMPLETE_QUEST` | server answers REQUEST_ITEMS or OFFER_REWARD |
| `quest_choose_reward` | `guid`, `questId`, `rewardIndex` | `CMSG_QUESTGIVER_CHOOSE_REWARD` | `rewardIndex` 0-based into `choiceRewards`; 0 when there is no choice |
| `quest_abandon` | `questId` | `CMSG_QUESTLOG_REMOVE_QUEST` | module maps quest id -> log slot (client-visible via quest-log fields); `400 quest_not_in_log` |
| `loot` | `guid` | `CMSG_LOOT` | opens the loot window (`SMSG_LOOT_RESPONSE`) |
| `loot_item` | `slot` | `CMSG_AUTOSTORE_LOOT_ITEM` | `slot` from `SMSG_LOOT_RESPONSE.items[]` |
| `loot_money` | — | `CMSG_LOOT_MONEY` | |
| `loot_release` | `guid` | `CMSG_LOOT_RELEASE` | closes the loot window |
| `loot_all` | `guid` | `CMSG_LOOT` + sequence | on the next `SMSG_LOOT_RESPONSE` the module sends the auto-loot client sequence: AUTOSTORE per allow-loot slot, LOOT_MONEY if gold, LOOT_RELEASE |
| `vendor_list` | `guid` | `CMSG_LIST_INVENTORY` | `SMSG_LIST_INVENTORY` follows |
| `buy_item` | `guid`, `itemId`, `slot`, `count?` | `CMSG_BUY_ITEM` | `slot` is the 1-based vendor slot from `SMSG_LIST_INVENTORY`; `count` default 1 |
| `sell_item` | `guid`, `itemGuid`, `count?` | `CMSG_SELL_ITEM` | `count` 0/omitted = whole stack |
| `repair_all` | `guid` | `CMSG_REPAIR_ITEM` | item guid 0 = repair everything |
| `equip_item` | `bag`, `slot` | `CMSG_AUTOEQUIP_ITEM` | `bag` 255 = backpack/equipment container, `slot` 23-38 = backpack slots |
| `use_item` | `bag`, `slot`, `targetGuid?` | `CMSG_USE_ITEM` | module fills item guid + on-use spell id from the item (client-cache knowledge); `400 no_item_at_slot`, `400 item_not_usable` |
| `destroy_item` | `bag`, `slot`, `count?` | `CMSG_DESTROYITEM` | `count` 0/omitted = whole stack |
| `repop` | — | `CMSG_REPOP_REQUEST` | release spirit while dead |
| `reclaim_corpse` | `guid?` | `CMSG_RECLAIM_CORPSE` | resurrect at corpse; handler resolves the player's own corpse, guid optional |
| `spirit_healer_activate` | `guid` | `CMSG_SPIRIT_HEALER_ACTIVATE` | graveyard resurrection fallback; no dedicated response opcode — the outcome arrives through already-served events (health update fields, res-sickness aura) |

Validation errors (all `400`): `missing_guid`, `missing_option`,
`missing_quest_id`, `missing_reward_index`, `missing_spell_id`,
`missing_slot`, `missing_item`, `missing_item_guid`, `missing_bag_slot`.

Every `missing_*` reply from `POST /action` echoes what it was about:
`{"ok":false,"error":"missing_guid","action":"set_target","param":"guid"}`.
A guid-shaped field (`guid`, `targetGuid`, `itemGuid`) that is present but not
a decimal u64 string is `400 invalid_guid`, echoing `action`, `param` and the
received value (truncated to 64 chars) — never silently coerced to guid 0.

### POST /characters

`{ "token": <str>, "account"?: <str> }` → `200 { "ok": true, "token", "enum": { "count": <number>, "characters": [ { "guid", "name", "race", "class", "gender", "level" }, ... ] } }`.
A parked utility session (never enters world) answers with the decoded `SMSG_CHAR_ENUM` for the account — the same data a client's character-select screen shows. Exists for the runner's episode hygiene (list-then-delete leftover characters); errors mirror `/character-delete` (`missing_token`, `token_in_use`, `account_not_permitted`, `unknown_account`, `account_in_use` when a live session holds the account, `504 timeout`).

### POST /character-delete

Delete a character by name through the real `CMSG_CHAR_DELETE` path (added in
the quest/combat extension, 2026-08). Needed because per-episode fresh
characters (ADR-0006) accumulate against the realm's 10-characters-per-account
cap. The module stands up a short-lived parked session, authenticates, walks
the character list, sends `CMSG_CHAR_DELETE` for the matching name, and tears
the session down. Cannot run while another session is live on the same account
(`account_in_use`). The character must be fully released by the core: for up to
~a minute after logout the core still tracks an offline session for the
character and `CMSG_CHAR_DELETE` is silently ignored (no response packet), which
surfaces here as `504 timeout` — callers should retry until `deleted` comes
back (the module-quest probe shows the pattern).

Request:
```json
{ "token": "del-abc123", "account": "RUNNER", "character": "Benchy" }
```
(`token` is a fresh throwaway token for this operation's audit log/event
stream; `account` optional as in `POST /session`, but must be on the module's
configured account allowlist (`WrathBench.Accounts`, defaulting to the single
`WrathBench.Account`) — deletes are refused for any other account, and refused
while a different token holds a live bench session on it. The ownership check
is decided on the world thread where session creates are serialized (the HTTP
thread's scan is only a fast-path pre-filter), so a delete racing a
`POST /session` for the same account within one world tick loses: one of the
two gets `409 account_owned_by_other_token` (delete mode) or
`400 account_in_use` (create mode) instead of both proceeding. `POST /session`
and `POST /characters` apply the same allowlist. Minimal ownership gate for the
per-run account scheme; per-character credentials are the Phase-1 fix.)

Success `200`: `{ "ok": true, "token": ..., "character": "Benchy", "deleted": true }`
Errors: `400 missing_token`, `400 missing_character`, `409 token_in_use`,
`403 account_not_permitted`, `409 account_owned_by_other_token`,
`400 unknown_account`, `400 account_in_use`, `400 character_not_found`,
`502 char_delete_failed_code_<N>` (N is the `SMSG_CHAR_DELETE` result code,
e.g. guild leader / arena captain refusals), `504 timeout`.

### DELETE /session

Log the character out. Implemented as a WorldSession-level disconnect of the
parked socket, which triggers the core's `LogoutPlayer(save)` on its next update —
the same path a real client's disconnect at the character takes, so the character
is saved.

Request:
```json
{ "token": "run-abc123" }
```

Success `200`: `{ "ok": true, "token": "run-abc123" }`
Errors: `400 missing_token`, `404 no_session`.

## WebSocket /events?token=...

Upgrade request to `/events` with the session token in the query string. The
server streams that session's whitelisted outbound packets as JSON text frames,
one object per frame. The channel is send-only (server→client); frames the client
sends are ignored. Multiple sockets may subscribe to the same token; each gets
every event.

Delivery guarantees:
- `seq` is per-session and restarts at 0 whenever a token's session is created;
  a restart after reconnecting a token is not a gap. Within one session, `seq`
  on the wire is gapless for a subscriber that stays connected.
- There is no replay: events are fanned out live and never buffered for late or
  reconnecting subscribers. A dropped WS loses the observations emitted while it
  was down, irreversibly (they remain in the audit log, which the agent does not
  get). There is no `?sinceSeq=` — reconnect and treat the world as
  re-observed from the next update packets.
- Subscriber registration happens in the server's WebSocket handshake completion
  handler, before any subsequent request from the caller can be parsed. So: any
  action or `/session` call issued after the client's WS `open` completes will
  have its events delivered to that subscriber. Events emitted concurrently
  with the handshake itself may or may not be seen; open the event stream
  before `POST /session` (as the probes do) and this window is irrelevant.
- Reattach state (added 2026-08): when a WebSocket subscribes to a token whose
  session is already in world, the module emits one synthetic
  `WB_SESSION_STATE` event (shape below) so a reconnecting consumer regains the
  self state it would otherwise only have gotten from the long-gone
  `SMSG_LOGIN_VERIFY_WORLD`. Player state is read on the world thread, so the
  event is delivered asynchronously shortly after the subscribe — effectively
  the first frame, though events emitted concurrently with the attach may
  precede it. It takes the next `seq` and fans out to every subscriber of the
  token like any event (so `seq` stays gapless for subscribers that never
  disconnected; they can ignore the extra state event). A subscribe during
  login emits nothing — the real `SMSG_LOGIN_VERIFY_WORLD` follows anyway.

Every event frame:
```json
{
  "seq": 12,                       // per-session monotonically increasing counter
  "opcode": "SMSG_MESSAGECHAT",    // opcode name
  "opcodeId": 150,                 // numeric opcode (0x096)
  "ts": 1755792000123,             // unix epoch milliseconds
  "data": { ... }                  // opcode-specific, decoded fields (below)
}
```

If a whitelisted packet is truncated or fails to decode, `data` is
`{ "decodeError": true }` but the event is still emitted so the drop is visible.

### Whitelist and `data` shapes

Only these opcodes become events; everything else is dropped and counted in
`/health.droppedPackets`. Field layouts mirror the server-side builders at the
pinned AzerothCore commit.

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_AUTH_RESPONSE` | 0x1EE | `{ "code": <u8> }` |
| `SMSG_CHAR_ENUM` | 0x03B | `{ "count": <u8>, "characters": [ { "guid", "name", "race", "class", "gender", "level" } ] }` |
| `SMSG_CHAR_CREATE` | 0x03A | `{ "result": <u8> }` (0x2F = success) |
| `SMSG_CHARACTER_LOGIN_FAILED` | 0x041 | `{ "reason": <u8> }` |
| `SMSG_LOGIN_VERIFY_WORLD` | 0x236 | `{ "map": <u32>, "x": <f>, "y": <f>, "z": <f>, "o": <f> }` |
| `SMSG_MOTD` | 0x33D | `{ "lineCount": <u32>, "lines": [ <string> ] }` |
| `SMSG_NOTIFICATION` | 0x1CB | `{ "text": <string> }` |
| `SMSG_NAME_QUERY_RESPONSE` | 0x051 | `{ "guid": <guid-string>, "found": <bool>, "name": <string?> }` |
| `SMSG_MESSAGECHAT` | 0x096 | `{ "type": <u8>, "language": <i32>, "senderGuid": <guid-string>, "message": <string>, "chatTag": <u8> }` |

`SMSG_MESSAGECHAT.data` is decoded for the `CHAT_MSG_SAY`-shaped layout (the one
the slice produces). Other chat sub-types share the opcode but vary the header;
they will be decoded as the action set grows.

### Movement/observation extension (2026-08, additive)

Additional whitelisted opcodes:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_UPDATE_OBJECT` | 0x0A9 | `{ "blocks": <u32>, "objects": [ ... ] }` (shapes below) |
| `SMSG_DESTROY_OBJECT` | 0x0AA | `{ "guid": <guid-string>, "onDeath": <bool> }` |
| `SMSG_CREATURE_QUERY_RESPONSE` | 0x061 | `{ "entry": <u32>, "found": <bool>, "name": <str?>, "subname": <str>, "type": <u32?>, "rank": <u32?> }` — on a found creature `subname` is always present, `""` when the creature has none |
| `MSG_MOVE_*` (observed) | various | `{ "guid": <guid-string>, "flags": <u32>, "pos": { "x", "y", "z", "o" } }` |

`MSG_MOVE_*` covers movement of *other* nearby units/players relayed by the
server. The exact `opcode` strings emitted are: `MSG_MOVE_START_FORWARD`,
`MSG_MOVE_START_BACKWARD`, `MSG_MOVE_STOP`, `MSG_MOVE_START_STRAFE_LEFT`,
`MSG_MOVE_START_STRAFE_RIGHT`, `MSG_MOVE_STOP_STRAFE`, `MSG_MOVE_JUMP`,
`MSG_MOVE_START_TURN_LEFT`, `MSG_MOVE_START_TURN_RIGHT`, `MSG_MOVE_STOP_TURN`,
`MSG_MOVE_SET_FACING`, `MSG_MOVE_HEARTBEAT`, `MSG_MOVE_FALL_LAND`,
`MSG_MOVE_START_SWIM`, `MSG_MOVE_STOP_SWIM`, `MSG_MOVE_SET_RUN_MODE`,
`MSG_MOVE_SET_WALK_MODE`; any other movement opcode in the observed set is
emitted with the bare fallback name `MSG_MOVE`. The bench character's own
synthesized movement is not echoed by the server; own position comes from
`WB_MOVE_PROGRESS` / `WB_MOVE_RESULT` below and from the self
`SMSG_UPDATE_OBJECT` create block.

`SMSG_COMPRESSED_UPDATE_OBJECT` never appears on this stream: the core
compresses large update packets at socket-write time, below the module's tap,
so the tap always sees the uncompressed `SMSG_UPDATE_OBJECT`.

#### `SMSG_UPDATE_OBJECT.objects[]` shapes

The wire is already delta-shaped and the module preserves that: a full object on
first sight (`create`), sparse field deltas afterwards (`values`). Entries are
one of:

- Create (object entered update range, or initial self spawn):
```json
{
  "update": "create",
  "guid": "12345",
  "objectType": "unit",        // object|item|container|unit|player|gameObject|dynamicObject|corpse|unknown
  "self": true,                 // present only on the bench character's own block
  "moveFlags": 0,               // living objects only
  "runSpeed": 7.0,              // living objects only
  "pos": { "x": -8949.9, "y": -132.5, "z": 83.5, "o": 5.2 },  // conditional, see below
  "targetGuid": "0",            // present when the block carries a target
  "fields": { ... }             // whitelisted update fields, see below; may be {}
}
```
  Every field beyond `update`/`guid`/`objectType` is conditional on the block's
  update flags. `pos` appears only when the block carries UPDATEFLAG_LIVING,
  UPDATEFLAG_POSITION, or UPDATEFLAG_STATIONARY_POSITION — an item or container
  create has no `pos`. `moveFlags`/`runSpeed` appear only on living blocks.
  `fields` is always present but may be `{}` when the mask carried no
  whitelisted field. `objectType` is `"unknown"` for a type id outside the
  known enum (forward compatibility, not an expected case).
- Field delta: `{ "update": "values", "guid": <guid-string>, "fields": { ... } }`
- Left update range: `{ "update": "outOfRange", "guids": [ <guid-string>, ... ] }`
- Near objects: `{ "update": "near", "guids": [ <guid-string>, ... ] }` — same
  *shape* as `outOfRange` but opposite *semantics*: NEAR_OBJECTS is not a
  removal. Only `outOfRange` means the objects left update range (and it is the
  only one of the two on which the module erases its own guid/type cache);
  consumers must not prune state on `near`.
- Movement-only block: `{ "update": "movement", "guid": <guid-string>, ...pos/moveFlags }`

`fields` carries only the whitelisted update fields present in the packet's
mask, decoded by name; every other field the server sent is consumed and
dropped (the drop is invisible by design — the client got it, the agent does
not need it, docs/CONTRACTS.md):

- all objects: `entry`, `scale`
- units and players: `health`, `maxHealth`, `power1`..`power7`,
  `maxPower1`..`maxPower7`, `level`, `faction`, `unitFlags`, `displayId`,
  `dynamicFlags`, `npcFlags`, `targetGuid`, `race`, `class`, `gender`,
  `powerType` (the last four unpacked from UNIT_FIELD_BYTES_0)
- players additionally: `playerFlags`
- game objects: `goDisplayId`, `goFlags`, `goFaction`, `goLevel`, `goState`,
  `goType`

Values are the raw client-visible integers from the update stream (health is
whatever the server sends a client — no extra precision is added). A `values`
delta for an object never seen in a `create` decodes with no named fields
(the module, like a client, cannot type it); the entry is still emitted, with
`"fields": {}` present-and-empty rather than absent.

Name resolution: on first sight of a creature (by entry) or player (by guid)
the module issues the `CMSG_CREATURE_QUERY` / `CMSG_NAME_QUERY` a real client
would issue on cache miss; the answers arrive as `SMSG_CREATURE_QUERY_RESPONSE`
/ `SMSG_NAME_QUERY_RESPONSE` events. Joining guid/entry to name is the SDK's job.

#### Module-synthesized events

These event `opcode` values do not correspond to server packets; they carry
knowledge a real client has locally (the movement engine's own position, the
session's own identity). Their `opcodeId`s are outside the real opcode range.

| opcode | id | `data` fields |
|---|---|---|
| `WB_MOVE_PROGRESS` | 0xFF02 | `{ "moveId": <number>, "pos": { "x","y","z","o" } }` — at most 1/s while moving |
| `WB_MOVE_RESULT` | 0xFF01 | `{ "moveId": <number>, "status": <str>, "pos": { "x","y","z","o" } }` |
| `WB_SESSION_STATE` | 0xFF03 | `{ "character": <str>, "guid": <guid-string>, "inWorld": true, "map": <n>, "x": <f>, "y": <f>, "z": <f>, "o": <f>, "level": <n> }` — emitted once per WS subscribe to an already-in-world session (reattach semantics in the `/events` section above). Strictly client-visible facts: what `SMSG_LOGIN_VERIFY_WORLD` plus the session's own identity would carry. |

`moveId` is a plain JSON number: it is a per-session counter that cannot exceed
2^53, so it falls under the counter exemption to the u64-as-string rule stated
at the top of this document.

`WB_MOVE_RESULT.status` is one of:
- `arrived` — the server-side character reached the destination; `pos` is the
  server-confirmed position.
- `no_path` — the navmesh has no complete walkable path to the point.
- `too_far` — destination beyond the single-move cap (~250yd straight-line);
  issue intermediate `move_to`s.
- `interrupted` — the move stopped early (death, root, teleport, rejection);
  `pos` is where the character actually is.
- `stopped` — a `stop` action ended the move.
- `superseded` — a newer `move_to` replaced this move.

`WB_MOVE_PROGRESS.pos` is the engine's interpolated position (what a client
would render); `WB_MOVE_RESULT.pos` is read back from the live character, so an
`arrived` result is proof the server accepted the synthesized movement.

### Quest/combat extension whitelist (2026-08, additive)

Additional whitelisted opcodes. As everywhere: decoded per the server-side
builders at the pinned commit, compacted where the full packet would overserve
(noted per row), and anything ambiguous against docs/CONTRACTS.md is dropped,
not served.

Combat:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_ATTACKSTART` | 0x143 | `{ "attackerGuid", "victimGuid" }` |
| `SMSG_ATTACKSTOP` | 0x144 | `{ "attackerGuid", "victimGuid", "attackerDead": <bool> }` |
| `SMSG_ATTACKERSTATEUPDATE` | 0x14A | compact: `{ "attackerGuid", "victimGuid", "hitInfo": <u32>, "damage", "overkill", "absorb", "resist", "blocked", "victimState": <u8>, "miss": <bool>, "crit": <bool> }` — per-school sub-damages are summed, not itemized |
| `SMSG_SPELL_START` | 0x131 | compact: `{ "casterGuid", "spellId", "castTimeMs", "targetGuid"? }` |
| `SMSG_SPELL_GO` | 0x132 | compact: `{ "casterGuid", "spellId", "hitGuids": [<guid-string>], "misses": [{ "guid", "reason": <u8> }] }` |
| `SMSG_CAST_FAILED` | 0x130 | `{ "spellId", "result": <u8> }` (SpellCastResult code) |
| `SMSG_SPELL_FAILURE` | 0x133 | `{ "casterGuid", "spellId", "result": <u8> }` |
| `SMSG_PERIODICAURALOG` | 0x24E | compact: `{ "targetGuid", "casterGuid", "spellId", "auraType": <u32>, "amount" }` |
| `SMSG_AURA_UPDATE` | 0x496 | `{ "targetGuid", "auras": [<aura>] }` |
| `SMSG_AURA_UPDATE_ALL` | 0x495 | same shape, full visible-aura list |

`<aura>` is `{ "slot": <u8>, "spellId": <u32>, "flags"?, "level"?, "stacks"?,
"casterGuid"?, "maxDuration"?, "duration"? }`; `spellId` 0 means the slot was
cleared and the entry carries `"removed": true` instead of the optional fields.
Durations are in ms and present only when the aura shows one (`flags & 0x20`).

Progress:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_LOG_XPGAIN` | 0x1D0 | `{ "victimGuid" ("0" for non-kill), "amount", "fromKill": <bool> }` |
| `SMSG_LEVELUP_INFO` | 0x1D4 | `{ "level", "healthGained" }` |
| `SMSG_ITEM_PUSH_RESULT` | 0x166 | `{ "playerGuid", "itemId", "count", "totalCount", "bagSlot", "itemSlot", "looted": <bool>, "created": <bool> }` |

Quests and gossip (quest/gossip text served as the client would show it):

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_QUESTGIVER_STATUS` | 0x183 | `{ "guid", "status": <u8> }` |
| `SMSG_QUESTGIVER_QUEST_LIST` | 0x185 | `{ "guid", "greeting", "quests": [{ "questId", "icon", "level", "repeatable", "title" }] }` |
| `SMSG_QUESTGIVER_QUEST_DETAILS` | 0x188 | `{ "guid", "questId", "title", "details", "objectives", "choiceRewards": [{ "itemId", "count" }], "rewards": [...], "money", "xp" }` |
| `SMSG_QUESTGIVER_REQUEST_ITEMS` | 0x18B | `{ "guid", "questId", "title", "text", "requiredMoney", "requiredItems": [{ "itemId", "count" }], "completable": <bool> }` |
| `SMSG_QUESTGIVER_OFFER_REWARD` | 0x18D | `{ "guid", "questId", "title", "text", "choiceRewards": [...], "rewards": [...], "money", "xp" }` |
| `SMSG_QUESTGIVER_QUEST_COMPLETE` | 0x191 | `{ "questId", "xp", "money" }` |
| `SMSG_QUESTGIVER_QUEST_FAILED` | 0x192 | `{ "questId", "reason" }` |
| `SMSG_QUESTUPDATE_ADD_KILL` | 0x199 | `{ "questId", "entry", "current", "required", "guid" }` (gameobject credit arrives with `entry | 0x80000000`) |
| `SMSG_QUESTUPDATE_ADD_ITEM` | 0x19A | `{}` — the core sends it empty; item progress is in the quest-log update fields |
| `SMSG_QUESTUPDATE_COMPLETE` | 0x198 | `{ "questId" }` — NOT sent for kill/item objectives at the pinned commit (exploration/event quests only); read completion from the quest-log `State` complete bit or the final `ADD_KILL` with `current == required` (ADR-0013) |
| `SMSG_QUESTUPDATE_FAILED` | 0x196 | `{ "questId" }` |
| `SMSG_GOSSIP_MESSAGE` | 0x17D | `{ "guid", "menuId", "textId", "options": [{ "optionId", "icon", "text" }], "quests": [{ "questId", "icon", "level", "title" }] }` |
| `SMSG_GOSSIP_COMPLETE` | 0x17E | `{}` |

Loot, vendor, inventory:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_LOOT_RESPONSE` | 0x160 | `{ "guid", "lootType": <u8>, "gold", "items": [{ "slot", "itemId", "count", "slotType": <u8> }] }` (slotType 0 = free to loot) |
| `SMSG_LOOT_REMOVED` | 0x162 | `{ "slot" }` |
| `SMSG_LOOT_MONEY_NOTIFY` | 0x163 | `{ "money" }` (copper) |
| `SMSG_LOOT_CLEAR_MONEY` | 0x165 | `{}` |
| `SMSG_LOOT_RELEASE_RESPONSE` | 0x161 | `{ "guid" }` |
| `SMSG_LIST_INVENTORY` | 0x19F | `{ "vendorGuid", "items": [{ "slot" (1-based), "itemId", "price" (copper, discounted), "buyCount", "leftInStock" (-1 = unlimited), "extendedCost" }], "emptyReason"? }` |
| `SMSG_BUY_ITEM` | 0x1A4 | `{ "vendorGuid", "slot", "count" }` |
| `SMSG_BUY_FAILED` | 0x1A5 | `{ "vendorGuid", "itemId", "result": <u8> }` |
| `SMSG_SELL_ITEM` | 0x1A1 | `{ "vendorGuid", "itemGuid", "result": <u8> }` (0 = success) |
| `SMSG_INVENTORY_CHANGE_FAILURE` | 0x112 | `{ "result": <u8>, "itemGuid"?, "itemGuid2"?, "requiredLevel"? }` (InventoryResult code) |
| `SMSG_ITEM_QUERY_SINGLE_RESPONSE` | 0x058 | `{ "itemId", "found", "name"?, "quality"?, "inventoryType"?, "buyPrice"?, "sellPrice"?, "itemLevel"?, "requiredLevel"?, "class"?, "subClass"? }` |

Item name resolution mirrors creature/name queries: on first sight of an item
entry (item create block, loot window, vendor list, item push, quest reward
list) the module issues the `CMSG_ITEM_QUERY_SINGLE` a client cache miss would,
and the answer arrives as `SMSG_ITEM_QUERY_SINGLE_RESPONSE`. Joining ids to
names is the SDK's job.

Death:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_DEATH_RELEASE_LOC` | 0x378 | `{ "map" (-1 = clear marker), "x", "y", "z" }` |
| `SMSG_CORPSE_RECLAIM_DELAY` | 0x269 | `{ "delayMs" }` |
| `SMSG_DURABILITY_DAMAGE_DEATH` | 0x2BD | `{}` |

Session:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_CHAR_DELETE` | 0x03C | `{ "result": <u8> }` (0x47 = success) |

Creature movement:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_MONSTER_MOVE` | 0x0DD | `{ "guid", "pos": {x,y,z}, "destination": {x,y,z}, "durationMs" }` or `{ "guid", "pos", "stopped": true }` |

`SMSG_MONSTER_MOVE` is deliberately reduced to destination + duration: the
spline path points the client receives are consumed and dropped, because
serving them would hand the agent the server's route in machine-readable form
(ADR-0010). A client player only sees the animation.

#### Update-field whitelist additions (quest/combat extension)

Served in `SMSG_UPDATE_OBJECT` `fields` alongside the existing set:

- players (self only; the server marks these PRIVATE): `money` (copper),
  `xp`, `nextLevelXp`; quest log as raw fields `quest<slot><Off>` with slot
  0-24 and Off one of `Id`, `State`, `CountsLo`, `CountsHi`, `Time` (the
  3.3.5 layout: two u32s of packed u16 objective counters); inventory as
  `invSlot<n>Lo`/`invSlot<n>Hi` u32 guid halves, n 0-22 = equipment + bag
  slots, 23-38 = backpack slots. The SDK reassembles guids and joins them to
  item create blocks.
- items and containers: `stackCount`, `durability`, `maxDurability`,
  `itemFlags`, `ownerLo`/`ownerHi`, `containedLo`/`containedHi`.

## Audit log

Per session, a JSONL file at `WrathBench.AuditDir/<token>.jsonl`. Every action
dispatched and every event served is appended as:
```json
{ "ts": 1755792000123, "session": "run-abc123", "kind": "action"|"event", "payload": { ... } }
```
`payload` for `event` is the exact event object sent on the WebSocket; for
`action` it is a short record of the dispatched opcode. This is the trajectory's
ground truth and the evidence the contracts held (docs/CONTRACTS.md).

Synthesized movement logs one `action` record per `move_to`/`stop`/`face`
request plus one per dispatched movement packet (`op: "move_pkt"` with the
opcode and position), so the packet sequence the "client" sent is fully
reconstructable from the audit log.
