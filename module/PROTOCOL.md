# mod-wrathbench wire protocol

The module exposes a small HTTP/WebSocket surface inside the worldserver. The SDK
is generated against this document, so shapes are exact. It covers the whole
surface the module serves today: session lifecycle, the action set of
`docs/CONTRACTS.md` (including the raw passthrough), and the filtered outbound
event stream.

Transport: plain HTTP/1.1 and RFC6455 WebSocket on `WrathBench.BindAddress:Port`
(default `0.0.0.0:8086`), reachable only from inside the deployment's private network.
All request and response bodies are JSON (`Content-Type: application/json`).

Two error channels, deliberately separated (docs/CONTRACTS.md):

- **Transport / request errors** — malformed request, unknown token, wrong state —
  are HTTP non-2xx with a JSON body `{ "ok": false, "error": "<code>", ... }`.
- **Game-level errors** — anything the server decides about a dispatched action —
  are never HTTP errors. They arrive as events on the WebSocket (e.g. a
  `SMSG_CHARACTER_LOGIN_FAILED` or `SMSG_NOTIFICATION` event), because that is how
  a real client would learn of them.

## u64 values are decimal strings

Every guid the module emits — in responses and in events (`guid`, `senderGuid`,
`targetGuid`, `guids[]`) — is serialized as a decimal string, e.g.
`"17365880163140632581"`. 3.3.5a guids carry a high part
(creatures start at 0xF130...) that exceeds `Number.MAX_SAFE_INTEGER`, so a bare
JSON number would be corrupted by any IEEE-double consumer before it could
react. Consumers should compare guids as strings or parse them as BigInt.
(Counters that cannot exceed 2^53 — `seq`, `ts`, drop counts, `moveId` — remain
JSON numbers.)

## Authentication

Every HTTP request and every `/events` upgrade carries
`Authorization: Bearer <credential>` (docs/CONTRACTS.md,
"Control-surface authentication"). A request without a valid one is
`401 unauthorized` before any route runs, including `GET /health`. There is no unauthenticated
path and no backward compatibility with callers that send none.

Two credential classes:

- **Operator** — the bearer is the *port secret*, `WrathBench.Secret`
  (`AC_WRATH_BENCH_SECRET` on the worldserver, from `WRATHBENCH_MODULE_SECRET` —
  a Secret key on the cluster, the operator's `.env` under compose;
  docs/RUNBOOK.md "Secrets"). May use every route
  with any token. Held by the runner host process, the fleet supervisor and the
  smoke scripts; never by the snippet child (the sandbox strips it from the
  child's environment).
- **Session** — the bearer is a *lease secret*, a 64-hex-character random value
  the module issued on `POST /lease` for exactly one token. It authenticates
  `POST /session`, `POST /action`, `DELETE /session` and the `/events` upgrade
  for that token alone (`403 token_mismatch` for any other), plus `GET /health`.
  Everything else — leasing, `/characters`, `/character-delete` — is
  `403 operator_only`. This is what the runner hands the snippet child, so a
  snippet in run A holds no credential that reaches run B.

The lease is what binds a token to an account and a character:

- `POST /lease { token, account }` (operator) records `token → account` and
  returns the secret. Re-leasing a token rotates its secret (a resumed run
  re-leases the token it stored) and keeps its character binding unless the
  account changed.
- A session-class `POST /session` lands on the lease's account whatever the body
  says (`403 account_not_leased` if the body names another). The first create
  that succeeds binds the token to that character; a later same-token create
  naming a different one is `409 character_bound` with `bound: <name>`. A create
  the core refused (name taken, bad race/class) binds nothing.
- The secret exists before the session does, which is why a subscriber can open
  `/events` first — as the SDK does, to catch the login burst — and still be
  validated: the upgrade is checked against the lease, not against a live
  session. (The alternative, requiring an existing session to subscribe, would
  have flipped the connect-before-create order the whole state cache depends on
  and lost every `SMSG_UPDATE_OBJECT` of the login.)
- `DELETE /lease { token }` (operator) revokes the credential; it does not touch
  a live session under the token.

A method and target the module does not serve is `404 not_found`, after
authentication and after the operator-only check — which is also how a caller
tells a module build that predates a route from one that refuses it: the runner
reads `404 not_found` on `POST /lease` as "this module has no leasing" and runs
without a session secret, where `403 operator_only` would mean the route is
there and the credential is wrong.

The module never logs a secret; `POST /lease` is the only response that carries
one. Secrets are compared in constant time. With `WrathBench.Secret` unset or
shorter than 32 characters the module does not listen at all (logged at ERROR),
so a mis-deployed worldserver is unreachable rather than open.

## Endpoints

### GET /health

Module and world status. Either credential class, no body.

Two views. Callers on that network — the runner and, through
it, the snippet sandbox — get liveness plus build identity: `ok`, `module`,
`worldStopped`, `build`, `startedAtMs`, `uptimeMs`,
with `sessions` / `droppedPackets` / `droppedPacketsLive` present but zeroed
(kept so the SDK response schema parses) and no `droppedByOpcode`. The global
session count and the drop census describe module internals and other runs'
sessions, which the observation contract never serves to a snippet. The full
view below is served only to loopback callers — an operator inside the
worldserver container, with the port secret the container already holds, e.g.
`docker compose -f infra/compose.yml exec worldserver sh -c 'curl -s -H "Authorization: Bearer $AC_WRATH_BENCH_SECRET" localhost:8086/health'`.

Operator (loopback) response `200`:
```json
{
  "ok": true,
  "module": "mod-wrathbench",
  "worldStopped": false,
  "sessions": 1,
  "droppedPackets": 4213,
  "droppedPacketsLive": 37,
  "droppedByOpcode": { "SMSG_POWER_UPDATE": 1400, "SMSG_EMOTE": 220, "0x4F2": 3 },
  "build": "harness-0.3-41-g0bfe207",
  "startedAtMs": 1787400000000,
  "uptimeMs": 3600000
}
```
- `build` — the wrathbench repo's `git describe --tags --always --dirty` at
  image build time, compiled into the module from the `WRATHBENCH_BUILD`
  docker build-arg (`infra/build-worldserver.sh` supplies it; see
  `module/mod-wrathbench.cmake`). `"unknown"` when the image was built without
  it. Served to every caller: it is ops identity, not game
  state, and lets the fleet gate, trajectories and the dashboard name *which*
  server they talked to.
- `startedAtMs` — worldserver process start, epoch milliseconds (captured at
  static initialisation). `build` + `startedAtMs` together identify "this
  build, this boot"; the fleet's preflight gate keys on exactly that pair.
- `uptimeMs` — milliseconds since `startedAtMs`. Telemetry, not identity.
- `sessions` — number of live bench sessions.
- `droppedPackets` — lifetime count of outbound packets suppressed because they
  were not on the event whitelist (survives session teardown). Whitelist tuning
  signal for later stages; see the whitelist section below.
- `droppedPacketsLive` — the same count summed across only the currently live
  sessions.
- `droppedByOpcode` — per-opcode breakdown of `droppedPackets` (process
  lifetime): the top 30 dropped opcodes by count, keyed by the
  core's opcode-table name where it has one, `"0xNNN"` hex otherwise. This is
  the whitelist-expansion census this anticipates.

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

`race`/`class` semantics: when the named character already
exists on the account, `race` and `class` are ignored entirely — the existing
character is logged in as-is. When the character does not exist
— so this request will CREATE one — both must be numeric and in `[1,11]`;
anything else (absent, non-numeric, out of range) fails the request with
`400 {"ok":false,"error":"invalid_race_class","token":...}` before any
char-create packet is synthesized. There is no silent default character.
Whether a create is needed is only known once the module sees the account's
character list, so this check happens mid-flow (after `SMSG_CHAR_ENUM`),
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
- `400 {"ok":false,"error":"weak_token","received":<len>,"minimum":32,"hint":...}` —
  the token is shorter than 32 characters. The token is not the credential
  (the lease secret is; "Authentication" above) but it still keys every session,
  audit file and event stream, so a guessable one lets an operator-class caller
  collide with another run by accident. Checked before the session is
  registered. `POST /lease` applies the same floor; the `/characters` and
  `/character-delete` utility surfaces do not (they park at character-select and
  are operator-only anyway).
- `401 {"ok":false,"error":"unauthorized"}` — no valid credential ("Authentication").
- `403 {"ok":false,"error":"token_mismatch"}` — a session-class caller named a
  token other than its lease's.
- `403 {"ok":false,"error":"account_not_leased"}` — a session-class body named an
  account other than the lease's.
- `409 {"ok":false,"error":"character_bound","bound":"<name>"}` — a session-class
  create for a different character than the one this token already played.
- `400 {"ok":false,"error":"invalid_race_class","token":...}` — the character
  does not exist and race/class are not both in [1,11] (see above; decided at
  char-enum time, before any char-create packet is synthesized).
- `409 {"ok":false,"error":"token_in_use"}` — a session already exists under
  this token and is still mid-login (not yet in world). A same-token create for a
  session that is already in world does **not** get this: it succeeds
  idempotently (see the reclaim note below).
- `403 {"ok":false,"error":"account_not_permitted"}` — `account` is not on the
  `WrathBench.Accounts` allowlist.
- `400 {"ok":false,"error":"unknown_account"}`
- `400 {"ok":false,"error":"socket_setup_failed"}`
- `502 {"ok":false,"error":"char_create_failed_code_<N>","token":...}` — game-level
  char-create rejection (N is the `SMSG_CHAR_CREATE` result code); also surfaced as
  a `SMSG_CHAR_CREATE` event.
- `502 {"ok":false,"error":"login_failed","token":...}`
- `502 {"ok":false,"error":"character_missing_after_create","token":...}`
- `504 {"ok":false,"error":"timeout","token":...}` — either the login flow did not
  reach the world within 20s, or (see reclaim below) a stale session held the
  account and the core had not released it within the internal reclaim wait.
  Both are transient and retryable.

Create reclaims a permitted account. `POST /session` on an account
that passed the allowlist **always takes ownership** instead of dead-ending on a
stale/leaked session — the invariant is one account = one job = one live
episode (enforced by the fleet's duplicate-account guard and the roster's
account-busy guard), so any session found holding the account at create time is
stale, and reclaiming it is correct, not a race:
- Same token, already in world for the **same** account+character: returns
  success idempotently (the caller re-syncs state from the event stream); it does
  not tear down and rebuild. A same-token session mid-login is `token_in_use`; a
  same-token session in world for a **different** character/account is torn down
  and rebuilt (never a silent wrong-character success).
- A different token (or a core-side session with no live bench token) holding the
  account is torn down via the normal teardown path, and the create waits for the
  core to fully release the account before entering world. If the release does not
  complete within the reclaim wait, the create returns `504 timeout` (retryable),
  never `account_in_use`. `account_in_use` does not fire on `POST /session`;
  it applies only to the read-only `POST /characters` and to
  `POST /character-delete`, neither of which reclaims.

The login flow the module performs internally, all through the real handlers:
`AddSession` → `SMSG_AUTH_RESPONSE(AUTH_OK)` → `CMSG_CHAR_ENUM` →
[`CMSG_CHAR_CREATE` → `SMSG_CHAR_CREATE` → `CMSG_CHAR_ENUM`] → `CMSG_PLAYER_LOGIN`
→ `SMSG_LOGIN_VERIFY_WORLD`. The caller sees only the final ack.

### POST /action

Dispatch one action. Supported: `say`, `move_to`, `stop`, `face` (`move_to`,
`stop`, `face` added in the movement extension; additive), and the
quest/combat extension set (additive): `set_target`, `clear_target`,
`attack_start`, `attack_stop`, `cast_spell`, `cancel_cast`, `interact`,
`gossip_hello`, `gossip_select`, `quest_list`, `quest_details`, `quest_accept`,
`quest_complete`, `quest_choose_reward`, `quest_abandon`, `loot`, `loot_item`,
`loot_money`, `loot_release`, `loot_all`, `vendor_list`, `buy_item`,
`sell_item`, `repair_all`, `equip_item`, `use_item`, `destroy_item`, `repop`,
`reclaim_corpse`, `spirit_healer_activate` (additive), the trainer
extension (additive): `trainer_list`, `trainer_buy_spell`, and the
spellbook/talent extension (additive): `learn_talent`,
`learn_preview_talents`, `raw`, and the talent-frame read
(`talent_tree`). Acks that the
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

Optional `guid` (decimal string): the unit the point was read from. It is a
planning hint, never a lookup — the move still goes to `x,y`. A unit's z comes
from its own movement packets and a patrolling or sloped NPC's can sit outside
the mesh's poly-search box while the ground under it is walkable, so with
`guid` the module resolves z to the ground height at `x,y` (terrain, vmap and
model geometry a client has too) before pathing, and falls back to the given z.
Without `guid` the ground z is tried only after a `target_off_mesh`. Either way
a target the mesh rejects at both heights is still `target_off_mesh`, and
`meshZ` is reported relative to the z asked for.

Success `200` (means "queued and pathing", not "arrived"):
```json
{ "ok": true, "action": "move_to", "token": "run-abc123", "moveId": 1 }
```

Additional error: `400 {"ok":false,"error":"missing_position","action":"move_to","param":"<first missing axis>"}`.

The outcome arrives as a `WB_MOVE_RESULT` event carrying the same `moveId`
(statuses below). A `move_to` issued while a previous one is still running
supersedes it: the old move ends with status `superseded` (the module sends the
`MSG_MOVE_STOP` a redirected client would, so a new request that fails at
planning never leaves the server believing the character is still running),
then the new path starts from wherever the character is. A request that fails
before anything moves (`too_far` and the planning causes below) likewise sends
a stop if the server still holds the character as moving.

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

#### Single-opcode actions (quest/combat extension)

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
| `cast_spell` | `spellId`, `targetGuid?` | `CMSG_CAST_SPELL` | no `targetGuid` = self/auto target (mask 0); with it, TARGET_FLAG_UNIT + packed guid. A game object guid works too (the core resolves the packed guid by its type), which is how chests open; a client would set TARGET_FLAG_GAMEOBJECT for it |
| `cancel_cast` | `spellId` | `CMSG_CANCEL_CAST` | |
| `interact` | `guid` | `CMSG_GAMEOBJ_USE` | doors, buttons, quest objects, mailboxes. Not chests: the core's `GameObject::Use` has no chest case and returns silently; a client opens a chest with `cast_spell` of the lock's Opening spell at the object's guid (the SDK's `lootCorpse` does this) |
| `gossip_hello` | `guid` | `CMSG_GOSSIP_HELLO` | opens the NPC gossip menu (`SMSG_GOSSIP_MESSAGE`) |
| `gossip_select` | `guid`, `menuId`, `optionId` | `CMSG_GOSSIP_SELECT_OPTION` | ids from `SMSG_GOSSIP_MESSAGE` (`menuId`, `options[].optionId`) |
| `quest_list` | `guid` | `CMSG_QUESTGIVER_HELLO` | `SMSG_QUESTGIVER_QUEST_LIST` or a gossip menu follows |
| `quest_details` | `guid`, `questId` | `CMSG_QUESTGIVER_QUERY_QUEST` | quest text via `SMSG_QUESTGIVER_QUEST_DETAILS` |
| `quest_accept` | `guid`, `questId` | `CMSG_QUESTGIVER_ACCEPT_QUEST` | `guid` may be a quest-start item's own guid (after `use_item` on it): the handler accepts TYPEMASK_ITEM |
| `quest_complete` | `guid`, `questId` | `CMSG_QUESTGIVER_COMPLETE_QUEST` | server answers REQUEST_ITEMS or OFFER_REWARD |
| `quest_choose_reward` | `guid`, `questId`, `rewardIndex` | `CMSG_QUESTGIVER_CHOOSE_REWARD` | `rewardIndex` 0-based into `choiceRewards`; 0 when there is no choice |
| `quest_abandon` | `questId` | `CMSG_QUESTLOG_REMOVE_QUEST` | module maps quest id -> log slot (client-visible via quest-log fields); `400 quest_not_in_log` |
| `quest_query` | `questId` | `CMSG_QUEST_QUERY` | the client's template fetch for a quest in its log; `SMSG_QUEST_QUERY_RESPONSE` follows (unknown id: silence) |
| `questgiver_status_query` | `guid` | `CMSG_QUESTGIVER_STATUS_QUERY` | what a client sends per questgiver-flagged unit/gameobject as it comes into view; `SMSG_QUESTGIVER_STATUS` for that guid follows (not a questgiver, or not in view: silence) |
| `questgiver_status_multiple_query` | — | `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY` | what a client sends after its quest log changes; `SMSG_QUESTGIVER_STATUS_MULTIPLE` follows |
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
| `use_item` | `bag`, `slot`, `targetGuid?` | `CMSG_USE_ITEM`, or `CMSG_QUESTGIVER_QUERY_QUEST` | module fills item guid + on-use spell id from the item (client-cache knowledge). An item with no on-use spell but a `startquest` is right-clicked the way a client does it: `CMSG_QUESTGIVER_QUERY_QUEST` with the item guid as the questgiver and the template's quest id (`HandleUseItemOpcode` drops spell id 0 as unknown, so `CMSG_USE_ITEM` is never the packet for it); the server answers `SMSG_QUESTGIVER_QUEST_DETAILS`, and `quest_accept` with the same item guid takes it. `400 no_item_at_slot`; `400 item_not_usable` only when the item has neither an on-use spell nor a quest to start. The audit row carries `spellId`, `itemGuid`, `startQuest` |
| `destroy_item` | `bag`, `slot`, `count?` | `CMSG_DESTROYITEM` | `count` 0/omitted = whole stack |
| `trainer_list` | `guid` | `CMSG_TRAINER_LIST` | `SMSG_TRAINER_LIST` follows — or nothing at all when the NPC is out of interaction range, is not a trainer, or trains another class (the handler returns silently) |
| `trainer_buy_spell` | `guid`, `spellId` | `CMSG_TRAINER_BUY_SPELL` | costs the character's own money server-side; answered by `SMSG_TRAINER_BUY_SUCCEEDED` or `SMSG_TRAINER_BUY_FAILED` |
| `learn_talent` | `talentId`, `rank` | `CMSG_LEARN_TALENT` | `talentId` from Talent.dbc, `rank` 0-based; the handler always answers `SMSG_TALENTS_INFO`, and a granted spell arrives as `SMSG_LEARNED_SPELL`; `400 missing_talent` |
| `learn_preview_talents` | `talents` = `[[talentId, rank], ...]` | `CMSG_LEARN_PREVIEW_TALENTS` | the preview-mode "learn" button (at most 150 pairs); `400 missing_talents`, `400 invalid_talents` |
| `talent_tree` | — | none (client-local read) | the class talent frame from the client's own Talent.dbc / TalentTab.dbc, answered as `WB_TALENT_TREE` on the stream so the observation is logged; no packet is sent |
| `raw` | `opcode`, `payload` | the named opcode | the escape hatch, below |
| `repop` | — | `CMSG_REPOP_REQUEST` | release spirit while dead |
| `reclaim_corpse` | `guid?` | `CMSG_RECLAIM_CORPSE` | resurrect at corpse; handler resolves the player's own corpse, guid optional. Refusals are silent (further than 39y, delay not elapsed, other map, no corpse); the SDK reads them off the corpse-query answer below |
| `spirit_healer_activate` | `guid` | `CMSG_SPIRIT_HEALER_ACTIVATE` | graveyard resurrection fallback; no dedicated response opcode — the outcome arrives through already-served events (health update fields, res-sickness aura) |

Validation errors (all `400`): `missing_guid`, `missing_option`,
`missing_quest_id` (also for `quest_query`), `missing_reward_index`, `missing_spell_id`,
`missing_slot`, `missing_item`, `missing_item_guid`, `missing_bag_slot`,
`missing_talent`, `missing_talents`, `invalid_talents`, and for `raw`:
`missing_opcode`, `opcode_not_allowed`, `invalid_payload`, `payload_too_large`.

Every `missing_*` reply from `POST /action` echoes what it was about:
`{"ok":false,"error":"missing_guid","action":"set_target","param":"guid"}`.
A guid-shaped field (`guid`, `targetGuid`, `itemGuid`) that is present but not
a decimal u64 string is `400 invalid_guid`, echoing `action`, `param` and the
received value (truncated to 64 chars) — never silently coerced to guid 0.

#### raw (escape hatch)

Send one allowlisted client opcode with a caller-built body. Exists so a
trajectory can demonstrate the need for a surface before the module and SDK
grow a dedicated action for it; it is not a second way to do what an
action already does.

Request:
```json
{ "token": "...", "action": "raw", "opcode": "CMSG_TEXT_EMOTE", "payload": "2200000000000000" }
```

`opcode` is the `CMSG_*` name; `payload` is the packet body as a hex string
(little-endian per field, as on the 3.3.5a wire; empty or omitted for a
bodiless opcode; at most 512 bytes). The bytes are queued verbatim into the
stock handler for that opcode — the module does not parse or repair them, and
a body the handler cannot read is the same as a malformed client packet (the
core logs it and, as for any client, may kick the session). Success `200`:
`{ "ok": true, "action": "raw", "token": ... }`. The audit record carries
`opcode` and `payload` so the exact bytes sent are reconstructable.

Errors (all `400`): `missing_opcode`, `opcode_not_allowed` (echoes `opcode`
and a hint), `invalid_payload` (not whole hex bytes), `payload_too_large`
(echoes `received` and `maximum`).

Allowlist — every entry is an opcode a stock client sends during ordinary play
whose handler does nothing a non-GM client could not do:

- talents: `CMSG_LEARN_TALENT`, `CMSG_LEARN_PREVIEW_TALENTS`,
  `MSG_TALENT_WIPE_CONFIRM` (body `u64 trainer guid` — the yes on the
  "unlearn all talents for N gold?" dialog after the server's own
  `MSG_TALENT_WIPE_CONFIRM`; the SDK's `resetTalents` sends it. The one
  `MSG_*` on the list: the opcode is bidirectional and a client sends it)
- chat/emotes: `CMSG_MESSAGECHAT` (whisper, party, yell and the rest ride this
  one), `CMSG_EMOTE`, `CMSG_TEXT_EMOTE`
- inventory: `CMSG_SPLIT_ITEM`, `CMSG_SWAP_ITEM`, `CMSG_SWAP_INV_ITEM`,
  `CMSG_AUTOSTORE_BAG_ITEM`, `CMSG_AUTOEQUIP_ITEM_SLOT`, `CMSG_READ_ITEM`,
  `CMSG_OPEN_ITEM`, `CMSG_BUYBACK_ITEM`
- spell/aura control: `CMSG_CANCEL_AURA`, `CMSG_CANCEL_AUTO_REPEAT_SPELL`,
  `CMSG_CANCEL_CHANNELLING`, `CMSG_SET_SHEATHED`, `CMSG_STANDSTATECHANGE`,
  `CMSG_RESURRECT_RESPONSE`
- flight paths: `CMSG_TAXINODE_STATUS_QUERY`, `CMSG_TAXIQUERYAVAILABLENODES`,
  `CMSG_ACTIVATETAXI` (body `u64 guid, u32 fromNode, u32 toNode`; the SDK's
  `activateTaxi` builds it), `CMSG_ACTIVATETAXIEXPRESS`
- innkeeper bind: `CMSG_BINDER_ACTIVATE` (body `u64 guid` — the yes on the
  confirm dialog after `SMSG_BINDER_CONFIRM`; the SDK's `bindAtInnkeeper`
  sends it)
- bank: `CMSG_BANKER_ACTIVATE`, `CMSG_AUTOBANK_ITEM`, `CMSG_AUTOSTORE_BANK_ITEM`,
  `CMSG_BUY_BANK_SLOT`
- mail: `CMSG_SEND_MAIL` (body `u64 mailbox, cstring to, cstring subject,
  cstring body, u32 stationery (41), u32 0, u8 count, count × (u8 index, u64
  item guid), u32 money, u32 cod, u64 0, u8 0`; the SDK's `sendMail` builds
  it), `CMSG_GET_MAIL_LIST` (`u64 mailbox`), `CMSG_MAIL_TAKE_ITEM` (`u64
  mailbox, u32 mailId, u32 item low guid`), `CMSG_MAIL_TAKE_MONEY` (`u64
  mailbox, u32 mailId`), `CMSG_MAIL_MARK_AS_READ` (`u64 mailbox, u32
  mailId`), `CMSG_MAIL_DELETE` (`u64 mailbox, u32 mailId, u32 0` — the
  template id; without it HandleMailDelete throws and the core skips the
  packet), `CMSG_MAIL_RETURN_TO_SENDER` (`u64 mailbox, u32 mailId, u64 0`).
  Every mail handler checks the mailbox guid is a mailbox game object within
  reach. The core sends no `SMSG_SHOW_MAILBOX` for `CMSG_GAMEOBJ_USE` on a
  mailbox (GameObject::Use has no mailbox case; a client opens the frame
  locally) — the first `SMSG_MAIL_LIST_RESULT` answering `CMSG_GET_MAIL_LIST`
  is what proves the box is in reach, and the SDK's `openMailbox` waits for it
- party: `CMSG_GROUP_INVITE` (`cstring name, u32 0`), `CMSG_GROUP_ACCEPT`
  (`u32 0`), `CMSG_GROUP_DECLINE` (empty), `CMSG_GROUP_UNINVITE` (`cstring
  name`), `CMSG_GROUP_UNINVITE_GUID` (`u64 guid, cstring reason`),
  `CMSG_GROUP_DISBAND` (empty — "leave group"), `CMSG_GROUP_SET_LEADER` (`u64
  guid`), `CMSG_LOOT_METHOD`, `CMSG_LOOT_ROLL` (`u64 roll guid, u32 loot
  slot, u8 vote` — 0 pass, 1 need, 2 greed, 3 disenchant — on a frame
  `SMSG_LOOT_START_ROLL` opened; the SDK's `lootRoll` builds it)

- trade: `CMSG_INITIATE_TRADE` (`u64 guid`), `CMSG_BEGIN_TRADE`, `CMSG_ACCEPT_TRADE`,
  `CMSG_UNACCEPT_TRADE`, `CMSG_CANCEL_TRADE`, `CMSG_BUSY_TRADE`,
  `CMSG_IGNORE_TRADE`, `CMSG_SET_TRADE_ITEM` (`u8 trade slot, u8 bag, u8
  slot`), `CMSG_CLEAR_TRADE_ITEM` (`u8 trade slot`), `CMSG_SET_TRADE_GOLD`
  (`u32 copper`)
- pet control: `CMSG_PET_ACTION` (`u64 pet guid,
  u32 button, u64 target guid` — `button` is `action | type << 24` exactly as
  the bar serves it: type 0x07 with a command 0 stay / 1 follow / 2 attack /
  3 abandon, type 0x06 with a react state 0 passive / 1 defensive / 2
  aggressive, type 0x81 / 0xC1 / 0x01 with a spell id; the SDK's `petAttack`,
  `petFollow`, `petStay`, `petReact`, `petCast`, `petDismiss` build it),
  `CMSG_PET_CAST_SPELL` (`u64 pet guid, u8 cast count, u32 spell, u8 flags,
  SpellCastTargets`), `CMSG_PET_STOP_ATTACK` (`u64 pet guid`),
  `CMSG_PET_ABANDON` (`u64 pet guid`), `CMSG_PET_RENAME` (`u64 pet guid,
  cstring name, u8 declined`), `CMSG_PET_SET_ACTION` (`u64 pet guid, (u32
  position, u32 button) × 1..2`), `CMSG_PET_SPELL_AUTOCAST` (`u64 pet guid,
  u32 spell, u8 on`), `CMSG_PET_CANCEL_AURA` (`u64 pet guid, u32 spell`),
  `CMSG_PET_NAME_QUERY` (`u32 pet number, u64 pet guid` — the module asks
  once per pet number on the client's behalf), `CMSG_REQUEST_PET_INFO`
  (empty — re-sends `SMSG_PET_SPELLS`)
- client-cache queries: `CMSG_NAME_QUERY`, `CMSG_CREATURE_QUERY`,
  `CMSG_GAMEOBJECT_QUERY`, `CMSG_ITEM_QUERY_SINGLE`, `CMSG_NPC_TEXT_QUERY`,
  `CMSG_PAGE_TEXT_QUERY` (`u32 page id, u64 item guid` — the SDK's `readItem`
  sends it after `SMSG_READ_ITEM_OK`, on the template's `pageText`),
  `CMSG_ITEM_TEXT_QUERY` (`u64 item guid` — the player-written text on a
  mailed letter), `CMSG_PLAYED_TIME`, `CMSG_QUERY_TIME`,
  `CMSG_SET_WATCHED_FACTION`, `CMSG_SET_ACTION_BUTTON`
- corpse: `MSG_CORPSE_QUERY` (empty body) — re-ask where the corpse is; the
  module already asks once per death on the client's behalf (see "Death"), and
  the answer is whitelisted

Deliberately absent: movement opcodes (the module drives them; a stray one
desyncs the mover), session lifecycle (login, logout, character create/delete),
every opcode that already has an action (one audited path per opcode), and
anything GM-gated or teleport-shaped. Answers to raw actions reach the agent
only through the event whitelist: the pet, party, mail, bank and trade
replies are whitelisted; the rest have none yet, which is
exactly the evidence the hatch exists to produce.

### POST /lease

Operator only. `{ "token": <str>, "account"?: <str> }` →
`200 { "ok": true, "token", "account", "secret", "character"? }`. Binds the
token to the account (default `WrathBench.Account`) and issues — or, for a
token already leased, rotates — its session secret; `character` is present when
an earlier create under this token already bound one. Errors: `400
missing_token`, `400 weak_token`, `403 account_not_permitted`, `403
operator_only`. See "Authentication".

### DELETE /lease

Operator only. `{ "token": <str> }` → `200 { "ok": true, "token", "released": <bool> }`.
Revokes the token's lease secret; a live session under the token is untouched.

### POST /characters

Operator only (`403 operator_only` for a session-class caller).
`{ "token": <str>, "account"?: <str> }` → `200 { "ok": true, "token", "enum": { "count": <number>, "characters": [ { "guid", "name", "race", "class", "gender", "level" }, ... ] } }`.
A parked utility session (never enters world) answers with the decoded `SMSG_CHAR_ENUM` for the account — the same data a client's character-select screen shows. Exists for the runner's episode hygiene (list-then-delete leftover characters); errors mirror `/character-delete` (`missing_token`, `token_in_use`, `account_not_permitted`, `unknown_account`, `account_in_use` when a live session holds the account, `504 timeout`).

### POST /character-delete

Operator only (`403 operator_only` for a session-class caller; the snippet
child therefore cannot delete any character, its own included — a fresh start
is the operator's episode reset, not the model's). Delete a character by name
through the real `CMSG_CHAR_DELETE` path. Needed because per-episode fresh
characters accumulate against the realm's 10-characters-per-account
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
`POST /session` for the same account within one world tick is decided
deterministically: a `POST /character-delete` that finds another token on the
account gets `409 account_owned_by_other_token` — character-delete never evicts a
running episode. A `POST /session` create, by contrast, reclaims (see the create
reclaim note above): it tears the other session down and takes ownership rather
than returning `account_in_use`, so a create never produces `account_in_use`.
`POST /session` and `POST /characters` apply the same allowlist. Minimal ownership gate for the per-run account scheme;
per-character credentials are the fuller fix.)

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
Errors: `400 missing_token`, `404 no_session`, `401 unauthorized`, `403 token_mismatch`.

## WebSocket /events?token=...

Upgrade request to `/events` with the session token in the query string and
the credential in the `Authorization` header ("Authentication": the port
secret, or the lease secret issued for this token; anything else is refused
with a plain `401` before the handshake and no subscriber is registered). The
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
- Reattach state: when a WebSocket subscribes to a token whose
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

### Movement/observation extension (additive)

Additional whitelisted opcodes:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_UPDATE_OBJECT` | 0x0A9 | `{ "blocks": <u32>, "objects": [ ... ] }` (shapes below) |
| `SMSG_DESTROY_OBJECT` | 0x0AA | `{ "guid": <guid-string>, "onDeath": <bool> }` |
| `SMSG_CREATURE_QUERY_RESPONSE` | 0x061 | `{ "entry": <u32>, "found": <bool>, "name": <str?>, "subname": <str>, "type": <u32?>, "rank": <u32?> }` — on a found creature `subname` is always present, `""` when the creature has none |
| `SMSG_GAMEOBJECT_QUERY_RESPONSE` | 0x05F | `{ "entry": <u32>, "found": <bool>, "name": <str?>, "type": <u32?>, "displayId": <u32?>, "castBarCaption": <str?> }` — `type` is the core's `GameobjectTypes` value (11 = transport, 19 = mailbox, 3 = chest, …); the template's raw data, size and quest-item list the packet also carries are not served |
| `MSG_MOVE_*` (observed) | various | `{ "guid": <guid-string>, "flags": <u32>, "pos": { "x", "y", "z", "o" } }` |

`MSG_MOVE_*` covers movement of *other* nearby units/players relayed by the
server. The exact `opcode` strings emitted are: `MSG_MOVE_START_FORWARD`,
`MSG_MOVE_START_BACKWARD`, `MSG_MOVE_STOP`, `MSG_MOVE_START_STRAFE_LEFT`,
`MSG_MOVE_START_STRAFE_RIGHT`, `MSG_MOVE_STOP_STRAFE`, `MSG_MOVE_JUMP`,
`MSG_MOVE_START_TURN_LEFT`, `MSG_MOVE_START_TURN_RIGHT`, `MSG_MOVE_STOP_TURN`,
`MSG_MOVE_SET_FACING`, `MSG_MOVE_HEARTBEAT`, `MSG_MOVE_FALL_LAND`,
`MSG_MOVE_START_SWIM`, `MSG_MOVE_STOP_SWIM`, `MSG_MOVE_SET_RUN_MODE`,
`MSG_MOVE_SET_WALK_MODE`, `MSG_MOVE_TELEPORT_ACK`; any other movement opcode in
the observed set is emitted with the bare fallback name `MSG_MOVE`. The bench
character's own synthesized movement is not echoed by the server; own position
comes from `WB_MOVE_PROGRESS` / `WB_MOVE_RESULT` below and from the self
`SMSG_UPDATE_OBJECT` create block.

`MSG_MOVE_TELEPORT_ACK` (0x0C7) is the one entry about *self*: the server's
side of a same-map teleport (`Player::SendTeleportAckPacket` — Hearthstone,
graveyard port, any port that does not change map). `guid` is the bench
character's own and `pos` is the arrival point; the module answers the packet
itself (module-internal client behaviour, like `MSG_MOVE_WORLDPORT_ACK`) so
the agent only observes it. No `SMSG_NEW_WORLD`
follows a same-map teleport; this is how own position follows one. On the wire
the packet carries a `u32` movement-order counter between the packGUID and the
MovementInfo; it is consumed, not served.

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
  "pathProgress": 12345,        // transports only: ms into the TransportAnimation.dbc period
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
  `maxPower1`..`maxPower7`, `level`, `faction`, `unitFlags` (with
  `taxiFlight`, the `UNIT_FLAG_TAXI_FLIGHT` bit named), `displayId`,
  `dynamicFlags`, `npcFlags`, `targetGuid`, `race`, `class`, `gender`,
  `powerType` (the last four unpacked from UNIT_FIELD_BYTES_0), and
  `summonedByGuid`, `createdByGuid`, `charmedByGuid` (the
  PUBLIC owner fields as guid strings — a pet's master; `"0"` when unset) and
  `petNumber` (UNIT_FIELD_PETNUMBER; on first sight of a unit with a non-zero
  one the module issues the `CMSG_PET_NAME_QUERY` a client does, once per
  number per session)
- players additionally: `playerFlags` (served as the raw integer; the module
  names no bit off it. The SDK decodes `PLAYER_FLAGS_GHOST` and
  `PLAYER_FLAGS_RESTING` runner-side — a naming of already-served
  data, not a new tap)
- game objects: `goDisplayId`, `goFlags`, `goFaction`, `goLevel`, `goState`,
  `goType`

Values are the raw client-visible integers from the update stream (health is
whatever the server sends a client — no extra precision is added). A `values`
delta for an object never seen in a `create` decodes with no named fields
(the module, like a client, cannot type it); the entry is still emitted, with
`"fields": {}` present-and-empty rather than absent.

Name resolution: on first sight of a creature or game object (by entry) or
player (by guid) the module issues the `CMSG_CREATURE_QUERY` /
`CMSG_GAMEOBJECT_QUERY` / `CMSG_NAME_QUERY` a real client would issue on cache
miss; the answers arrive as `SMSG_CREATURE_QUERY_RESPONSE` /
`SMSG_GAMEOBJECT_QUERY_RESPONSE` / `SMSG_NAME_QUERY_RESPONSE` events. Joining
guid/entry to name is the SDK's job.

#### Module-synthesized events

These event `opcode` values do not correspond to server packets; they carry
knowledge a real client has locally (the movement engine's own position, the
session's own identity). Their `opcodeId`s are outside the real opcode range.

| opcode | id | `data` fields |
|---|---|---|
| `WB_MOVE_PROGRESS` | 0xFF02 | `{ "moveId": <number>, "pos": { "x","y","z","o" } }` — at most 1/s while moving |
| `WB_MOVE_RESULT` | 0xFF01 | `{ "moveId": <number>, "status": <str>, "pos": { "x","y","z","o" }, "meshZ": <f?>, "reachedPos": { "x","y","z" }? }` — `meshZ` only on `arrived` when the mesh z differed from the request; `reachedPos` on `path_incomplete` and `drop`; `"dz": <f>, "target": { "x","y","z" }` only on `drop`; `"onTransport": { "guid": <guid-string>, "entry": <u32> }` when the character ended the move aboard a transport |
| `WB_RIDE_PROGRESS` | 0xFF05 | `{ "transportGuid": <guid-string>, "transportEntry": <u32>, "pos": { "x","y","z","o" } }` — at most 1/s while the character rides a transport and is not walking; the server-side position the transport carried it to |
| `WB_TRANSPORT_PROGRESS` | 0xFF06 | `{ "guid": <guid-string>, "entry": <u32>, "pos": { "x","y","z","o" }, "progressMs": <u32>, "periodMs": <u32?>, "docked": <bool?> }` — at most 1/s per session, one per transport on the character's map whose create block the session has received: the car's current position on its `TransportAnimation.dbc` path (what a client animates locally from `pathProgress`), the clock and period, and `docked` when the keyframe segment the clock is on has no displacement (the car is dwelling at a platform; absent for transports without an animation path) |
| `WB_AREATRIGGER` | 0xFF04 | `{ "triggerId": <u32>, "moveId": <number>, "pos": { "x","y","z","o" } }` — the mover entered an `AreaTrigger.dbc` volume and sent `CMSG_AREATRIGGER` for it (see below) |
| `WB_AREA` | 0xFF07 | `{ "mapId": <u32>, "zoneId": <u32>, "zoneName": <str>, "areaId": <u32>, "areaName": <str> }` — the zone and subzone the character is in, named as the client names them; once when the character enters the world and once per change of either id, whatever moved it (walking, a teleport, a map transfer). See "Zone and area" below. |
| `WB_TALENT_TREE` | 0xFF08 | the class talent frame, the answer to the `talent_tree` action; shape under "Spellbook, cooldowns, talents" below |
| `WB_SESSION_STATE` | 0xFF03 | `{ "character": <str>, "guid": <guid-string>, "inWorld": true, "map": <n>, "x": <f>, "y": <f>, "z": <f>, "o": <f>, "level": <n>, "zoneId", "zoneName", "areaId", "areaName" }` — emitted once per WS subscribe to an already-in-world session (reattach semantics in the `/events` section above). Strictly client-visible facts: what `SMSG_LOGIN_VERIFY_WORLD` plus the session's own identity would carry, plus the same zone/area fields as `WB_AREA` so a reattached client starts where the stream cannot re-emit. |

`moveId` is a plain JSON number: it is a per-session counter that cannot exceed
2^53, so it falls under the counter exemption to the u64-as-string rule stated
at the top of this document.

`WB_MOVE_RESULT.status` is one of (navigation vocabulary):
- `arrived` — the server-side character reached the destination; `pos` is the
  server-confirmed position. When the navmesh resolved the request to a ground
  z more than 1y from the requested z, the result also carries `meshZ` (the z
  actually walked to): the request's z was off, the mesh's z was used, and the
  agent should quote `meshZ` next time.
- `too_far` — destination beyond the single-move cap (~250yd straight-line);
  issue intermediate `move_to`s.
- `no_mesh` — no navmesh tile is loaded under the character or under the
  destination. A harness/data limitation, not a route problem; nothing to
  retry from the agent's side.
- `target_off_mesh` — the destination has no walkable polygon within the
  mesh's search box (4y in 2D; z is searched ±50y, so a stale z alone never
  produces this), or it sits inside geometry. Pick a point on a road, a floor,
  or where an NPC stands.
- `start_off_mesh` — the character itself is standing somewhere the mesh does
  not cover (a transport deck, a bad landing). Recovery is different from
  `target_off_mesh`: a few yards of movement, or a disembark, fixes the start.
- `path_incomplete` — the mesh has no continuous walkable route to the
  destination. The module already tried once to subdivide (path to where the
  mesh got, then onward); `reachedPos` is how far the mesh could get, so the
  agent can route around or approach from another side. Nothing moved.
- `drop` — the mesh's route steps off a ledge: some segment of the resolved
  polyline falls (or climbs) more than 2.0y and steeper than 1.2x its 2D
  length — a cliff, not a ramp (stairs and ramps pass; a stale z within the
  `meshZ` band passes). A mesh path that falls is a ledge, not a route, so the
  walk is not dispatched: `reachedPos` is the last point before the step
  (the edge, on the character's level), `dz` is the signed vertical step the
  route would have taken there, and `target` echoes the requested point. Pick
  a destination on this level, or find the ramp/stairs. The same guard runs
  per segment while walking; a ledge that slips past planning stops the
  character at the edge with the same status and `pos` at the edge.
- `transferred` — a map transfer took the character mid-move (an areatrigger
  portal, a cross-map port); the server applies the destination itself. `pos`
  is the last old-map position; the new map and arrival point follow on
  `SMSG_NEW_WORLD`.
- `teleported` — a same-map teleport took the character mid-move (Hearthstone,
  a graveyard port on the same map). No map change is coming and no
  `SMSG_NEW_WORLD` will follow; `pos` is the pre-teleport position and the
  arrival point is the `MSG_MOVE_TELEPORT_ACK` observed-movement event (own
  guid), which the server sends before this result.
- `interrupted` — the move stopped early (death, root, rejection, or the
  character left the map for a non-teleport reason); `pos` is where the
  character actually is.
- `stopped` — a `stop` action ended the move.
- `superseded` — a newer `move_to` replaced this move.

`WB_MOVE_PROGRESS.pos` is the engine's interpolated position (what a client
would render); `WB_MOVE_RESULT.pos` is read back from the live character, so an
`arrived` result is proof the server accepted the synthesized movement.

Transports. A client standing on a tram car or
boat sends movement packets flagged `MOVEMENTFLAG_ONTRANSPORT` with the
transport guid and its transport-relative offset, because its physics put it
on the transport's model; the server then carries it as a passenger and
nothing else does. The module does the same from the same knowledge: when
the mover's interpolated point lies inside a transport's model bounds (the
`GameObjectModel` the server keeps current as the transport moves), every
synthesized packet carries the transport block. Transports have no navmesh,
so a `move_to` within 30y whose start or destination is on one is a straight
line (boarding or disembarking, as a client walks it); anything longer goes
through the mesh and answers `start_off_mesh` / `target_off_mesh`. A move
that ends aboard reports `onTransport`; while aboard and idle, the server
moves the character and the module reports where it is as
`WB_RIDE_PROGRESS`. No "activate transport" action exists: boarding is
walking onto the car.

The car itself is observable the way a client sees it: a
transport's create block serves `goType` 11 and `pathProgress`, the module
asks `CMSG_GAMEOBJECT_QUERY` for its name like any other game object, and
`WB_TRANSPORT_PROGRESS` keeps its position and `docked` state current from
the same `TransportAnimation.dbc` the client animates from (the server's
`StaticTransport::RelocateToProgress` runs the same keyframes). The agent
therefore sees "Subway" standing at the platform or absent, and a `move_to`
onto an empty rail bed still answers `target_off_mesh` — the SDK's hint
names the docking car when one is known.

Areatriggers. A real client tests its own position
against the `AreaTrigger.dbc` volumes it ships and sends `CMSG_AREATRIGGER`
the moment it enters one — the player never chooses to. The module does the
same: it reads `AreaTrigger.dbc` from the server data volume (`DataDir/dbc`,
the same file a client has), tests the mover's interpolated position after
each heartbeat with the same sphere/oriented-box geometry as
`Player::IsInAreaTriggerRadius`, and queues `CMSG_AREATRIGGER` once per entry
and never again while the mover lingers inside: the module keeps the set of
volumes the character is in, fires only for ids newly inside, and forgets an
id when the character leaves the volume, changes map or is teleported, so a
re-entry fires again. Because a client never reports a
trigger from a position it has not sent, each entry packet is preceded by a
`MSG_MOVE_HEARTBEAT` at the entry position (audited as a `move_pkt` with
`cause: "areatrigger"`), so the server's applied position is the tested one
when it evaluates the trigger rather than one up to a heartbeat interval
behind. A hit the server still rejects is not retried. Each dispatch is
audited (`op: "areatrigger"`) and mirrored as `WB_AREATRIGGER`. Consequences
are whatever the server does for that trigger, as for a client: a map
transfer (`SMSG_TRANSFER_PENDING` … `transferred`), exploration quest credit
(`SMSG_QUESTUPDATE_COMPLETE`), or the inn's rest flag — all of which
happen without an agent action, because they happen to a client without a
player action. Triggers fire only while a `move_to` is in progress; the
server's own radius check rejects any hit the interpolation got wrong.

#### Zone and area

No packet carries "Elwynn Forest / Northshire Valley" to a client. The client
computes its current area id locally — from the area-id grid of the ADT it
stands on, or from the WMO group it is inside (WMOAreaTable) — walks the
parent chain in `AreaTable.dbc` for the zone, and draws both names from the
same table. The server derives the same pair from the same terrain data
(`Player::GetZoneAndAreaId`, which reads the map-file area grid and the vmap
WMO area the extractor took from the client's files), so reading the pair
off the player is observation-equivalent to what the client computes, not a
server-side extra; the names come from the client's own `AreaTable.dbc` in the
data volume, loaded at startup next to `AreaTrigger.dbc` (3.3.5a layout: 36
fields, 144-byte records; `id`, `mapId`, `parentAreaId`, …, enUS `name` at
field 11 — a file with any other shape is refused with an error, exactly as
the areatrigger loader refuses a wrong `AreaTrigger.dbc`, and `WB_AREA` then
carries ids with empty names). Once per world tick, for every in-world
session, the module compares the pair to the last one announced and emits
`WB_AREA` when either changed; the first in-world tick counts as a change, so
login announces the starting zone, and a teleport or map transfer announces
its arrival the same way a walk across a subzone edge does. The event is
audited like every other (`kind: "event"`). What the server does with the
pair (exploration credit, PvP flags, rest state) is not gated on this.

### Quest/combat extension whitelist (additive)

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
| `SMSG_QUESTGIVER_STATUS_MULTIPLE` | 0x418 | `{ "statuses": [{ "guid", "status": <u8> }] }` — every questgiver in view; sent by the core on login, level-up and quest reward, and in answer to `questgiver_status_multiple_query`. Status values are `DIALOG_STATUS_*` (0 none, 1 unavailable, 2 low-level available, 3 low-level reward-rep, 4 low-level available-rep, 5 incomplete, 6 reward-rep, 7 available-rep, 8 available, 9 reward2 (no minimap dot), 10 reward); the SDK names them |
| `SMSG_QUEST_QUERY_RESPONSE` | 0x05D | `{ "questId", "method", "level", "minLevel", "type", "suggestedPlayers", "title", "objectives", "details", "areaDescription", "completedText", "requiredNpcOrGo": [4 x { "entry", "count", "text" }], "requiredItems": [6 x { "itemId", "count" }] }` — decoded from `PlayerMenu::SendQuestQueryResponse` in this order: questId, method, level, minLevel, zoneOrSort, type, suggestedPlayers, rep objective faction/value x2, nextQuestInChain, xpId, rewMoney, rewMoneyMaxLevel, rewSpell, rewSpellCast, honor addition/multiplier, srcItem, flags, charTitle, playersSlain, bonusTalents, arenaPoints, repMask, 4+6 reward (item,count) pairs, 3x5 reputation ids, POI continent/x/y/pointOpt, then the five strings, then 4 x (requiredNpcOrGo, count, itemDrop, 0), 6 x (requiredItem, count), 4 x objective text (joined into `requiredNpcOrGo[i].text`). A gameobject objective arrives as `entry \| 0x80000000`, as the client expects. Reward fields are consumed and not served (they ride `QUEST_DETAILS`/`OFFER_REWARD` when the client asks) |
| `SMSG_QUESTGIVER_QUEST_LIST` | 0x185 | `{ "guid", "greeting", "quests": [{ "questId", "icon", "level", "repeatable", "title" }] }` |
| `SMSG_QUESTGIVER_QUEST_DETAILS` | 0x188 | `{ "guid", "questId", "title", "details", "objectives", "choiceRewards": [{ "itemId", "count" }], "rewards": [...], "money", "xp" }` |
| `SMSG_QUESTGIVER_REQUEST_ITEMS` | 0x18B | `{ "guid", "questId", "title", "text", "requiredMoney", "requiredItems": [{ "itemId", "count" }], "completable": <bool> }` |
| `SMSG_QUESTGIVER_OFFER_REWARD` | 0x18D | `{ "guid", "questId", "title", "text", "choiceRewards": [...], "rewards": [...], "money", "xp" }` |
| `SMSG_QUESTGIVER_QUEST_COMPLETE` | 0x191 | `{ "questId", "xp", "money" }` |
| `SMSG_QUESTGIVER_QUEST_FAILED` | 0x192 | `{ "questId", "reason" }` |
| `SMSG_QUESTUPDATE_ADD_KILL` | 0x199 | `{ "questId", "entry", "current", "required", "guid" }` (gameobject credit arrives with `entry | 0x80000000`) |
| `SMSG_QUESTUPDATE_ADD_ITEM` | 0x19A | `{}` — the core sends it empty; item progress is in the quest-log update fields |
| `SMSG_QUESTUPDATE_COMPLETE` | 0x198 | `{ "questId" }` — NOT sent for kill/item objectives at the pinned commit (exploration/event quests only); read completion from the quest-log `State` complete bit or the final `ADD_KILL` with `current == required` |
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
| `SMSG_TRAINER_LIST` | 0x1B1 | `{ "guid", "trainerType": <i32>, "spells": [{ "spellId", "state": <u8>, "cost" (copper, discounted), "reqLevel", "reqSkill" (skill line id, 0 = none), "reqSkillValue" }], "greeting" }` — `trainerType` 0 class, 1 mount, 2 tradeskill, 3 pet; `state` 0 available (green), 1 unavailable (red: level/skill/prerequisite/class), 2 known (gray). `state` says nothing about money: a green spell still fails with reason 1 if unaffordable |
| `SMSG_TRAINER_BUY_SUCCEEDED` | 0x1B3 | `{ "guid", "spellId" }` |
| `SMSG_TRAINER_BUY_FAILED` | 0x1B4 | `{ "guid", "spellId", "reason": <i32> }` — 0 unavailable, 1 not enough money, 2 not enough skill (also level/prerequisites) |
| `SMSG_INVENTORY_CHANGE_FAILURE` | 0x112 | `{ "result": <u8>, "itemGuid"?, "itemGuid2"?, "requiredLevel"? }` (InventoryResult code) |
| `SMSG_ITEM_QUERY_SINGLE_RESPONSE` | 0x058 | `{ "itemId", "found", "name"?, "quality"?, "inventoryType"?, "buyPrice"?, "sellPrice"?, "itemLevel"?, "requiredLevel"?, "class"?, "subClass"?, "requiredSkill", "requiredSkillRank", "requiredSkillName"?, "requiredSpell"?, "requiredReputationFaction"?, "requiredReputationRank"?, "requiredReputationFactionName"?, "maxCount", "stackable", "containerSlots", "stats": [{ "type", "value" }], "damage": [{ "min": <f>, "max": <f>, "type" }], "armor", "resistances"?: { "holy"?, "fire"?, ... }, "speedMs", "spells": [{ "spellId", "trigger", "charges", "name"? }], "bonding", "description"?, "startQuest"?, "pageText"?, "block"?, "maxDurability" }` — everything from `requiredSkill` on is the tooltip, read in `HandleItemQuerySingleOpcode`'s order up to `MaxDurability`; sockets, gem properties, duration and holiday are left unread. Zero damage ranges and empty spell slots are dropped; `resistances` only when one is non-zero. Names on `requiredSkill`, `requiredReputationFaction` and each spell are client-cache (SkillLine.dbc, Faction.dbc, Spell.dbc) knowledge like the rest |

Item name resolution mirrors creature/name queries: on first sight of an item
entry (item create block, loot window, vendor list, item push, quest reward
list) the module issues the `CMSG_ITEM_QUERY_SINGLE` a client cache miss would,
and the answer arrives as `SMSG_ITEM_QUERY_SINGLE_RESPONSE`. Joining ids to
names is the SDK's job.

Spellbook, cooldowns, talents (additive). `rank` and `name` on a spell
row are what a client reads from its own Spell.dbc for the id (`rank` 1 when
unranked; both absent when the id is unknown to the core) — client-cache
knowledge, like item-template fields:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_INITIAL_SPELLS` | 0x12A | `{ "spells": [{ "spellId", "rank"?, "name"? }], "cooldowns": [{ "spellId", "itemId", "category", "cooldownMs", "categoryCooldownMs" }] }` — the whole active-spec spellbook, sent during login before `SMSG_LOGIN_VERIFY_WORLD`; a category cooldown carries its time in `categoryCooldownMs` and 0 in `cooldownMs`; `categoryCooldownMs` 0x80000000 with `cooldownMs` 1 is the core's "infinite" marker |
| `SMSG_LEARNED_SPELL` | 0x12B | `{ "spellId", "rank"?, "name"? }` |
| `SMSG_REMOVED_SPELL` | 0x203 | `{ "spellId" }` |
| `SMSG_SUPERCEDED_SPELL` | 0x12C | `{ "supersededSpellId", "spellId", "rank"?, "name"? }` — the old rank leaves the book, `spellId` replaces it (a `SMSG_LEARNED_SPELL` for the new id follows) |
| `SMSG_SPELL_COOLDOWN` | 0x134 | `{ "guid", "flags": <u8>, "cooldowns": [{ "spellId", "cooldownMs" }] }` — cooldowns that just started for `guid` (self or pet); `flags & 1` = the GCD was triggered too; a 0 ms entry is a GCD-only marker |
| `SMSG_COOLDOWN_EVENT` | 0x135 | `{ "spellId", "guid" }` — "start the timer you already know for this spell": the duration is Spell.dbc knowledge the module does not serve |
| `SMSG_CLEAR_COOLDOWN` | 0x1DE | `{ "spellId", "guid" }` |
| `SMSG_TALENTS_INFO` | 0x4C0 | `{ "pet": false, "unspentPoints", "specCount", "activeSpec", "specs": [{ "talents": [{ "talentId", "rank" }] }] }` — `rank` is 0-based; glyph slots are consumed and not served. The pet form is `{ "pet": true }` only (the pet bar itself is `SMSG_PET_SPELLS`; pet talents have not been asked for). Sent on login, level-up, after every `CMSG_LEARN_TALENT`, on spec change, and after a successful talent reset |
| `MSG_TALENT_WIPE_CONFIRM` | 0x2AA | `{ "guid", "cost": <u32 copper>, "nothingToReset": <bool> }` — the trainer's "unlearn all talents?" dialog (`Player::SendTalentWipeConfirm`) after its unlearn gossip option; a client answers yes by echoing the opcode with the guid (raw). `nothingToReset` is the guid-0/cost-0 form `HandleTalentWipeConfirmOpcode` sends back when there are no talents to reset or the money is short; a successful reset has no packet of its own — `SMSG_TALENTS_INFO` follows with every rank gone |
| `WB_TALENT_TREE` | 0xFF08 | `{ "class": <u8>, "unspentPoints": <u32>, "tabs": [{ "tabId", "name"?, "page", "talents": [{ "talentId", "name"?, "row", "col", "maxRank", "ranks": [<spellId> × maxRank], "dependsOn"?, "dependsOnRank"? }] }] }` — the answer to the `talent_tree` action: every TalentTab.dbc tab whose class mask holds the character's class, in page order, and every Talent.dbc row in it sorted by row then column. `name` on a tab is the client's TalentTab.dbc text (the module reads the file: `dbc/TalentTab.dbc`, 24 fields, record size 96, refused otherwise), on a talent the first rank spell's Spell.dbc name; `dependsOnRank` is 0-based. What the talent frame draws, nothing more — no icons, no tooltips, and no server-side state (the ranks learned are `SMSG_TALENTS_INFO`'s, joined by the SDK) |

Reputation. The wire keys factions by their
`Faction.dbc` reputation index (`repListId`), not the faction id; the module
makes the same join a client does and adds the client's base standing for
the character's race and class (`ReputationMgr::GetBaseReputation` is the
same arithmetic over the same masks), so `reputation` = `base` + `standing`
is the number the pane shows and the one the rank thresholds apply to
(Hated < -6000, Hostile, Unfriendly < 0, Neutral, Friendly ≥ 3000, Honored
≥ 9000, Revered ≥ 21000, Exalted ≥ 42000). `base` and `reputation` are
absent only when the player object was not reachable at decode time:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_INITIALIZE_FACTIONS` | 0x122 | `{ "count": <u32>, "factions": [{ "repListId", "flags": <u8>, "visible", "atWar", "factionId"?, "name"?, "standing": <i32>, "base"?, "reputation"? }] }` — the login list (`ReputationMgr::SendInitialReputations`): 128 positions, only those with a non-zero flag or standing served. `flags`: 1 visible, 2 at war, 4 hidden, 8 invisible-forced, 16 peace-forced, 32 inactive |
| `SMSG_SET_FACTION_STANDING` | 0x124 | `{ "showVisual": <bool>, "factions": [{ "repListId", "factionId"?, "name"?, "standing", "base"?, "reputation"? }] }` — every faction whose standing changed since the last send (`ReputationMgr::SendState`); `showVisual` is the "reputation with X increased" chat line |
| `SMSG_SET_FACTION_VISIBLE` | 0x123 | `{ "repListId", "factionId"?, "name"? }` — the faction joins the pane |

`SMSG_SET_FACTION_ATWAR` and the at-war/inactive toggles a client sends are
not tapped or allowlisted: nothing in a trajectory has asked for them.

Pets. The pet frame is drawn from one packet plus
the pet's own unit in view: `SMSG_PET_SPELLS` carries the control bar, the
unit's update fields (`health`, `level`, `power1`, `summonedByGuid`,
`petNumber` above) carry the rest, and the given name comes back from the
name query the module fires on the pet number. Spell ids carry their
Spell.dbc `name`/`rank` as everywhere. `SMSG_PET_MODE` exists in the opcode
table but the core never sends it (`STATUS_NEVER`, no builder), so the react
and command states are read off `SMSG_PET_SPELLS`, which the core re-sends on
every change. Pet talents (`CMSG_PET_LEARN_TALENT`, the pet form of
`SMSG_TALENTS_INFO`) and the stable are not served: nothing has asked.

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_PET_SPELLS` | 0x179 | `{ "guid", "removed": <bool> }` when the bar is removed (guid 0: the pet died, was dismissed or abandoned); otherwise `{ "guid", "removed": false, "family": <u16>, "durationMs": <u32>, "reactState": <u8>, "commandState": <u8>, "flags": <u16>, "actionBar": [{ "slot", "type": <u8>, "command"? | "reaction"? | "spellId"?, "autocast"?, "rank"?, "name"? }] × 10, "spells": [{ "spellId", "active": <u8>, "autocast", "rank"?, "name"? }], "cooldowns": [{ "spellId", "category", "cooldownMs", "categoryCooldownMs" }] }` — `Player::PetSpellInitialize` (and the possess / charm / vehicle variants, same layout). `type` is the wire's button type: 0x07 a command (0 stay, 1 follow, 2 attack, 3 abandon), 0x06 a react state (0 passive, 1 defensive, 2 aggressive), 0x01 / 0x81 / 0xC1 a spell (passive / castable / autocast on); `active` on a spell row is the same byte. `family` is CreatureFamily.dbc (0 for demons); `durationMs` 0 is a permanent pet. Sent on summon, tame, login with a pet out, and after every bar, react or autocast change |
| `SMSG_PET_ACTION_FEEDBACK` | 0x2C6 | `{ "feedback": <u8> }` — 1 the pet is dead, 2 nothing to attack, 3 cannot attack that target |
| `SMSG_PET_TAME_FAILURE` | 0x173 | `{ "result": <u8> }` — `PetTameFailure`: 1 invalid creature, 2 too many, 3 already owned, 4 not tameable, 5 another summon active, 6 units can't tame, 7 no pet available, 8 internal error, 9 too high level, 10 dead, 11 not dead, 12 can't control exotic, 13 unknown |
| `SMSG_PET_CAST_FAILED` | 0x138 | `{ "spellId", "result": <u8>, "rank"?, "name"? }` — the `SMSG_CAST_FAILED` layout for a spell the pet was told to cast |
| `SMSG_PET_NAME_QUERY_RESPONSE` | 0x053 | `{ "petNumber", "found": <bool>, "name"? }` — the given name for a pet number (the name timestamp and declined-name block are consumed and not served) |
| `SMSG_PET_NAME_INVALID` | 0x178 | `{ "reason": <u32>, "name" }` — a rename the server refused (`PetNameInvalidReason`) |

Group, mail, bank and trade: the replies to the
raw-allowlisted client opcodes above, so a raw send is answered. Result codes
are the core's enums (`PartyResult`, `MailResponseResult`, `TradeStatus`),
served as numbers; the SDK names them.

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_GROUP_INVITE` | 0x06F | `{ "canAccept": <bool>, "inviterName" }` — `canAccept` true is an invitation (answer with `CMSG_GROUP_ACCEPT` / `CMSG_GROUP_DECLINE`); false is the "you were invited but are already in a group" notice the inviter's failed invite sends |
| `SMSG_GROUP_DECLINE` | 0x074 | `{ "name" }` — to the inviter: that player declined |
| `SMSG_GROUP_SET_LEADER` | 0x079 | `{ "name" }` — the new leader, broadcast to the group |
| `SMSG_GROUP_UNINVITE` | 0x077 | `{}` — this character was removed from the group |
| `SMSG_GROUP_DESTROYED` | 0x07C | `{}` — the group was disbanded |
| `SMSG_PARTY_COMMAND_RESULT` | 0x07F | `{ "operation": <u32>, "name", "result": <u32>, "value": <u32> }` — `WorldSession::SendPartyResult`: `operation` 0 invite, 1 uninvite, 2 leave, 4 swap; `result` `PartyResult` (0 ok, 1 bad player name, 2 not in your group, 4 group full, 5 already in a group, 6 not in a group, 7 not the leader, 8 wrong faction, 9 ignoring you, …) |
| `SMSG_GROUP_LIST` | 0x07D | `{ "groupType": <u8>, "left": <bool>, "raid": <bool>, "subGroup", "memberFlags", "roles", "groupGuid", "counter", "members": [{ "name", "guid", "online": <bool>, "subGroup", "flags": <u8>, "roles" }], "leaderGuid", "lootMethod"?, "looterGuid"?, "lootThreshold"?, "dungeonDifficulty"?, "raidDifficulty"? }` — `Group::SendUpdateToPlayer`: the *other* members (self is never listed), the leader and, when there are any, the loot settings. `left` is the 0x10 group type the core sends with an empty list and a zero leader when this character leaves or the group is disbanded. `flags` 1 assistant, 2 main tank, 4 main assist; the LFG state/dungeon pair on LFG groups is consumed |
| `SMSG_SHOW_MAILBOX` | 0x297 | `{ "guid" }` — the mailbox frame opened on that game object (after `CMSG_GAMEOBJ_USE` / the `interact` action on a mailbox) |
| `SMSG_RECEIVED_MAIL` | 0x285 | `{}` — "you have new mail" |
| `SMSG_SEND_MAIL_RESULT` | 0x239 | `{ "mailId", "action": <u32>, "result": <u32>, "inventoryResult"?, "itemGuidLow"?, "count"? }` — `Player::SendMailResult`: `action` 0 send, 1 money taken, 2 item taken, 3 returned to sender, 4 deleted, 5 made permanent; `result` `MailResponseResult` (0 ok, 1 equip error — `inventoryResult` is the InventoryResult — 2 cannot send to self, 3 not enough money, 4 recipient not found, 5 not your team, 6 internal error, 15 recipient cap reached, 18 too many attachments, …); `itemGuidLow`/`count` on a taken item |
| `SMSG_MAIL_LIST_RESULT` | 0x23B | `{ "total": <u32>, "count": <u8>, "mails": [{ "mailId", "type": <u8>, "senderGuid"? (type 0, a player) | "senderId"? (creature / gameobject entry, auction or calendar id), "cod", "stationery", "money", "flags", "read": <bool>, "daysLeft": <f32>, "templateId", "subject", "body", "items": [{ "index", "itemGuidLow", "itemId", "count" }] }] }` — `WorldSession::HandleGetMailList`; `total` counts mails the packet could not fit (the client's "undelivered mail" warning). Per-item enchantments, random property, charges and durability are consumed and not served; item entries are queried like a cache miss so `SMSG_ITEM_QUERY_SINGLE_RESPONSE` names them |
| `SMSG_SHOW_BANK` | 0x1B8 | `{ "guid" }` — the bank frame opened at that banker (after `CMSG_BANKER_ACTIVATE` or the banker's gossip option). The slots themselves are `invSlot39`–`invSlot73` on self (28 bank slots, then 7 bank bag slots whose containers serve their own `bagSlot<n>` fields) |
| `SMSG_BUY_BANK_SLOT_RESULT` | 0x1BA | `{ "result": <u32> }` — 0 failed (too many), 1 not enough money, 2 not a banker, 3 ok |
| `SMSG_TRADE_STATUS` | 0x120 | `{ "status": <u32>, "traderGuid"? (status 1), "inventoryResult"?, "targetError"?, "limitedItemId"? (status 12), "slot"? (22, 23) }` — `TradeStatus`: 0 busy, 1 begin trade (the other player proposed), 2 window open, 3 canceled, 4 accepted, 6 no target, 7 back to trade, 8 complete, 9 rejected, 10 too far, 11 wrong faction, 12 close window, 14 ignoring you, 15/16 stunned, 17/18 dead, 19/20 logging out, 21 trial account |
| `SMSG_TRADE_STATUS_EXTENDED` | 0x121 | `{ "theirs": <bool>, "money", "spellId", "items": [{ "slot", "itemId", "count", "wrapped": <bool> }] }` — one side of the trade window (`theirs` false is own); slot 6 is the "will not be traded" enchant slot; empty slots and the per-item enchant / gem / creator / durability block are consumed and not served |

Group loot rolls: the roll frame a group-looted
corpse opens for each item at or above the group's loot threshold
(`Group::GroupLoot`; uncommon by default, and the threshold cannot be set
lower). A roll is keyed by the fresh item guid the core mints for it
(`rollGuid`), which is what `CMSG_LOOT_ROLL` names. Every packet carries the
item entry, queried like a cache miss so the SDK can name it.

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_LOOT_START_ROLL` | 0x2A1 | `{ "rollGuid", "slot", "itemId", "count", "countdownMs", "voteMask": <u8>, "canNeed": <bool>, "canGreed": <bool>, "canDisenchant": <bool> }` — the frame opens; pass is always allowed. The per-player form drops the need bit when this character cannot need. Map id, random suffix and property are consumed and not served |
| `SMSG_LOOT_ROLL` | 0x2A2 | `{ "rollGuid", "slot", "playerGuid", "itemId", "roll": <u8>, "rollType": <u8>, "autoPass": <bool> }` — one counted vote, to every voter; `roll` 1-100, 128 for a pass; `rollType` 0 pass, 1 need, 2 greed, 3 disenchant. The *first* of these after a vote is only `Group::CountRollVote`'s acknowledgement of the button, and it is not a roll: need is acked as `roll` 0 with `rollType` 0 (which is pass), and greed / disenchant / pass as `roll` 128 with their own type. The numbers actually rolled arrive later, one per need (or per greed) voter, from `Group::CountTheRoll` once every vote is in. `rollGuid` is `"0"` here: the core writes `ObjectGuid::Empty` as the source (Group::CountRollVote / CountTheRoll), so `slot` + `itemId` name the roll |
| `SMSG_LOOT_ROLL_WON` | 0x29F | `{ "rollGuid", "slot", "itemId", "winnerGuid", "roll": <u8>, "rollType": <u8> }` — the verdict. No `SMSG_ITEM_PUSH_RESULT` follows: `Group::CountTheRoll` stores the won item with `StoreNewItem` and never calls `SendNewItem` (Group.cpp has no such call), so the item shows up only in the object update the bag fold reads. `rollGuid` is `"0"` here too (same source field); `SMSG_LOOT_ALL_PASSED` and `SMSG_LOOT_START_ROLL` carry the real guid |
| `SMSG_LOOT_ALL_PASSED` | 0x29E | `{ "rollGuid", "slot", "itemId" }` — everyone passed; the item stays on the corpse |
| `SMSG_LOOT_MASTER_LIST` | 0x2A4 | `{ "looters": [{ "guid" }] }` — under master loot, who the master looter may assign an over-threshold item to |

Item text: a client reads a book or letter with
`CMSG_READ_ITEM`, and on the server's `SMSG_READ_ITEM_OK` asks
`CMSG_PAGE_TEXT_QUERY` for the template's `pageText` (served on the item
query above), which the core answers page by page down the `NextPage` chain
in one go. The player-written text on a mailed letter is a different query
(`CMSG_ITEM_TEXT_QUERY`). `SMSG_ITEM_TEXT_QUERY_RESPONSE` is the only reply
to the latter; the core never sends it for books. Text only — no
coordinates ride any of these.

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_READ_ITEM_OK` | 0x0AE | `{ "guid" }` — the item may be read; the pages follow the client's page query |
| `SMSG_READ_ITEM_FAILED` | 0x0AF | `{ "guid" }` — the item has pages but this character may not read it (`SMSG_INVENTORY_CHANGE_FAILURE` precedes it with the reason). An item with no pages answers `SMSG_INVENTORY_CHANGE_FAILURE` alone (`EQUIP_ERR_ITEM_NOT_FOUND`) |
| `SMSG_PAGE_TEXT_QUERY_RESPONSE` | 0x05B | `{ "pageId", "text", "nextPageId" }` — one page; `nextPageId` 0 is the last. A missing page is served as the core's own "Item page missing." text |
| `SMSG_ITEM_TEXT_QUERY_RESPONSE` | 0x244 | `{ "found": <bool>, "guid"?, "text"? }` — `found` false is "no such carried item"; a carried item with nothing written on it answers `found` true with an empty `text` |

The auction house stays outside both lists: `CMSG_AUCTION_*` is not
allowlisted and no auction reply is tapped (deferred, with the dungeon finder,
guilds, battlegrounds, glyphs, dual spec and equipment sets, until
single-player play is validated; docs/CONTRACTS.md).

Achievements and flight paths (issue #8 first half):

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_ACHIEVEMENT_EARNED` | 0x468 | `{ "guid", "self": <bool>, "achievement": { "achievementId", "date": <u32>, "time": "YYYY-MM-DD HH:MM", "name"?, "points"?, "categoryId"? } }` — the core broadcasts this in say range, so `guid` may be another player's; `self` is the equality with the session's own guid, nothing more |
| `SMSG_ALL_ACHIEVEMENT_DATA` | 0x47D | `{ "count", "achievements": [ <same achievement object> ] }` — sent to self once during login: every achievement already earned. Only the completed block (to its 0xFFFFFFFF terminator) is decoded; the criteria-progress block that follows is consumed and not served |
| `SMSG_ACTIVATETAXIREPLY` | 0x1AE | `{ "reply": <u32>, "ok": <bool> }` — the answer to `CMSG_ACTIVATETAXI[EXPRESS]` (raw). `ActivateTaxiReply`: 0 ok, 1 server error, 2 no such path, 3 not enough money, 4 too far away, 5 no vendor nearby, 6 not visited, 7 busy, 8 mounted, 9 shapeshifted, 10 moving, 11 same node, 12 not standing |
| `SMSG_SHOWTAXINODES` | 0x1A9 | `{ "showWindow": <bool>, "guid", "currentNode": <u32>, "currentNodeName"?: <str>, "mask": [<u32> × 14], "known": [{ "nodeId": <u32>, "name"?: <str> }] }` — the flight master's window (`WorldSession::SendTaxiMenu`), sent when the taxi option of the master's gossip menu is chosen: the leading u32 (1 = show), the master's guid, the node it stands at, and the character's taximask verbatim (`TaxiMaskSize` 14 words; node *n* is bit `(n-1)%32` of word `(n-1)/32`). `known` is that mask decoded — the nodes this character has visited, the only destinations the server will sell — each named as the client names it from its own `TaxiNodes.dbc`. No route, fare or position is served |

`date` is the wire's packed bitfield (`AppendPackedTime`: `(year-2000)<<24 |
month<<20 | (day-1)<<14 | weekday<<11 | hour<<6 | minute`); `time` is its
reading, a client-local decode. `name`, `points` and `categoryId` are what a
client reads from its own `Achievement.dbc` for the id — the module loads that
file from the data volume beside `AreaTable.dbc` (`dbc/Achievement.dbc`,
62 fields, record size 248; the loader refuses any other layout) and serves
ids only when it is absent. Category names (`Achievement_Category.dbc`) are
not served.

The flight itself has no event: `taxiFlight` on self in `SMSG_UPDATE_OBJECT`
`fields` (below) is `UNIT_FLAG_TAXI_FLIGHT` read off `unitFlags`, so a
`reply` of 0 followed by `taxiFlight: true` is the flight starting and the
flip back to `false` is the landing, exactly as a client sees them. Nothing is
inferred from the server's taxi state. `SMSG_CRITERIA_UPDATE` (0x46A) and
`SMSG_TAXINODE_STATUS` are not tapped: the agent finds flight masters the way
it finds anything, and learns a node by visiting it.

The window: `SMSG_SHOWTAXINODES` is the one
packet that tells a client what a flight master offers, and the client only
ever gets it by choosing the taxi option on the master's gossip menu
(`gossip_hello` then `gossip_select`; a master with no other menu entries
sends it straight from the hello). Node names come from `TaxiNodes.dbc` on
the data volume (`dbc/TaxiNodes.dbc`, 24 fields, record size 96; the loader
refuses any other layout) and are ids only when it is absent — the same
client-cache class as area and achievement names. The node positions the
same table carries are deliberately not served, and `TaxiPath.dbc` is never
read: which nodes connect, and for how much, the character learns by asking
(`CMSG_ACTIVATETAXI` with the window's current node and a known node, body
`u64 guid, u32 from, u32 to`, through raw).

Innkeeper bind — the sequence a client runs
when "Make this inn your home." is chosen:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_BINDER_CONFIRM` | 0x2EB | `{ "guid" }` — the innkeeper asks; a client shows a yes/no dialog and answers yes with `CMSG_BINDER_ACTIVATE` (raw, body `u64 guid`) |
| `SMSG_BINDPOINTUPDATE` | 0x155 | `{ "x", "y", "z", "map": <u32>, "areaId": <u32>, "areaName": <str> }` — where the hearthstone goes: once during login (`Player::SendInitialPacketsBeforeAddToMap`) and again after every bind (`Spell::EffectBind`). `areaName` is the client's `AreaTable.dbc` text for the id, `""` when it has no row |
| `SMSG_PLAYERBOUND` | 0x158 | `{ "guid", "areaId", "areaName" }` — the "your home is now …" line; `guid` is the binder |

The server declines a bind silently (not an innkeeper, out of range, dead,
inside an instance): no packet follows the confirm, and the SDK reports that
as the absence of an answer, never as a status.

#### Death

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_DEATH_RELEASE_LOC` | 0x378 | `{ "map" (-1 = clear marker), "x", "y", "z" }` |
| `SMSG_CORPSE_RECLAIM_DELAY` | 0x269 | `{ "delayMs" }` |
| `SMSG_DURABILITY_DAMAGE_DEATH` | 0x2BD | `{}` |
| `MSG_CORPSE_QUERY` | 0x216 | `{ "found": <bool>, "map"?, "x"?, "y"?, "z"?, "corpseMap"? }` — the server's answer to the ghost's corpse query (`HandleCorpseQueryOpcode`); position fields only when `found`. `map`/`x`/`y`/`z` is where a client draws the corpse marker, `corpseMap` the map the corpse is actually on; they differ only for a corpse inside a dungeon, where the marker sits on the entrance. The trailing unused u32 is consumed |

A ghost knows where its corpse is: a real client
sends `MSG_CORPSE_QUERY` as soon as it is a ghost and the answer is the corpse
marker on its map. The parked client has no map, so the module sends the same
one query per death, once the repop teleport has been acked (the handler
compares corpse map to player map, so the graveyard port must have applied),
audited as `op: "corpse_query"`, and the reply is served above. The latch
resets when the character is alive again. A snippet may re-ask through the raw
hatch. This is the same class as the time-sync reply and the teleport ack:
module-internal client behaviour. Nothing resurrects server-side; the
reclaim radius (`CORPSE_RECLAIM_RADIUS`, 39y) and delay are unchanged.

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
serving them would hand the agent the server's route in machine-readable form.
A client player only sees the animation.

Map transfers (navigation):

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_TRANSFER_PENDING` | 0x03F | `{ "map": <u32>, "transportEntry": <u32?>, "oldMap": <u32?> }` — the optional pair only when a transport carries the character across |
| `SMSG_NEW_WORLD` | 0x03E | `{ "map": <u32>, "x", "y", "z", "o" }` — the arrival point (transport-local when aboard one) |
| `SMSG_TRANSFER_ABORTED` | 0x040 | `{ "map": <u32>, "reason": <u8>, "arg": <u8?> }` — `arg` only for INSUF_EXPAN_LVL / DIFFICULTY / UNIQUE_MESSAGE |

`SMSG_NEW_WORLD` is the only map id a client receives after login
(`SMSG_LOGIN_VERIFY_WORLD` is never re-sent), so it is what self position's
`map` follows from then on. The module answers the teleport itself
(`MSG_MOVE_WORLDPORT_ACK`, see the teleport-ack note) and a `move_to` in
flight when a transfer begins ends with status `transferred` (a same-map
teleport: `teleported`, with the arrival on `MSG_MOVE_TELEPORT_ACK`).

#### Update-field whitelist additions (quest/combat extension)

Served in `SMSG_UPDATE_OBJECT` `fields` alongside the existing set:

- players (self only; the server marks these PRIVATE): `money` (copper),
  `xp`, `nextLevelXp`, `talentPoints` (`PLAYER_CHARACTER_POINTS1`, the
  unspent count); the skill pane as raw fields
  `skill<slot><Off>` with slot 0-127 (`PLAYER_SKILL_INFO_1_1`, three packed
  u32s per line) and Off one of `Id`/`Step` (low/high u16 of the first),
  `Value`/`Max` (the second), `TempBonus`/`PermBonus` (the third, as signed
  i16), plus `skill<slot>Name`, a string beside each non-zero id with the
  client's SkillLine.dbc text — the one non-numeric entry `fields` carries;
  the SDK lifts it into its skill rows. There is no dedicated skill opcode in
  3.3.5: every change is a values update on these fields. Quest log as raw fields `quest<slot><Off>` with slot
  0-24 and Off one of `Id`, `State`, `CountsLo`, `CountsHi`, `Time` (the
  3.3.5 layout: two u32s of packed u16 objective counters); inventory as
  `invSlot<n>Lo`/`invSlot<n>Hi` u32 guid halves, n 0-22 = equipment + bag
  slots, 23-38 = backpack slots. The SDK reassembles guids and joins them to
  item create blocks.
- items and containers: `stackCount`, `durability`, `maxDurability`,
  `itemFlags`, `ownerLo`/`ownerHi`, `containedLo`/`containedHi`.
- containers only (worn bags): `numSlots`
  (`CONTAINER_FIELD_NUM_SLOTS`) and the bag's contents as
  `bagSlot<n>Lo`/`bagSlot<n>Hi` u32 guid halves, n 0-35
  (`CONTAINER_FIELD_SLOT_1`, 36 guid pairs). PUBLIC fields every client in
  range receives, served exactly as the player's `invSlot<n>` halves are: a
  values update may carry one half, zero halves in a create block are
  compressed out, and the SDK joins halves into guids and addresses the
  slot as `(bag = the bag's equipment slot 19-22, slot = n)`, which is what
  `CMSG_USE_ITEM` / `CMSG_DESTROYITEM` / `CMSG_AUTOEQUIP_ITEM` resolve
  through `Player::GetItemByPos`. Nothing new on the action side: swap and
  split stay off the allowlist.

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
Each `move_to` that reaches the mesh also logs one `op: "move_path"` record at
dispatch — `moveId`, `status` (`"ok"` when the walk was dispatched, else the
`WB_MOVE_RESULT` status), `pointCount`, and `points` (the resolved polyline,
capped at 64 points with `truncated: true` when the cap bit) — so a route the
mesh chose is read from the log, not reconstructed from heartbeats.
