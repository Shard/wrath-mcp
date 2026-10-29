# mod-wrathbench wire protocol

The module exposes a small HTTP/WebSocket surface inside the worldserver. The SDK
is generated against this document, so shapes are exact. It covers the whole
surface the module serves today: session lifecycle, the action set of
`docs/CONTRACTS.md` (including the raw passthrough), and the filtered outbound
event stream.

Transport: plain HTTP/1.1 and RFC6455 WebSocket on `WrathBench.BindAddress:Port`
(default `127.0.0.1:8086`, loopback only). A deployment that serves callers on
other hosts sets the bind address itself, and keeps the port on a private
network nothing publishes beyond them: it carries bearer secrets in the clear.
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

No reply names the caller's token. It is the caller's own opaque session id,
so an echo tells it nothing, and a reply on the session surface flows into
snippet results and from there into whatever a harness records or publishes; only
the operator-only `POST /lease` and `DELETE /lease` replies carry it, to pair
a secret with its token.

Two credential classes:

- **Operator** — the bearer is the *port secret*, `WrathBench.Secret`
  (`AC_WRATH_BENCH_SECRET` in the worldserver's environment; callers read the
  same value as `WRATHBENCH_MODULE_SECRET`). May use every route
  with any token. Held by the process that hosts the sandbox (`mcp/src/main.ts`
  or a harness's own host) and by operator tooling; never by the snippet child
  (the sandbox strips it from the child's environment).
- **Session** — the bearer is a *lease secret*, a 64-hex-character random value
  the module issued on `POST /lease` for exactly one token. It authenticates
  `POST /session`, `POST /action`, `DELETE /session` and the `/events` upgrade
  for that token alone (`403 token_mismatch` for any other), plus `GET /health`.
  Everything else — leasing, `/characters`, `/character-delete` — is
  `403 operator_only`. This is what the sandbox host hands the snippet child, so a
  snippet in run A holds no credential that reaches run B.

The lease is what binds a token to an account and a character:

- `POST /lease { token, account, allowGm? }` (operator) records `token →
  account`, and the GM opt-in ("POST /session" below) when `allowGm` is
  `true`, and returns the secret. Re-leasing a token rotates its secret (a
  resumed run re-leases the token it stored) and keeps its character binding
  unless the account changed; the opt-in is each lease's own, so a re-lease
  without it turns it off, for a session already in world too.
- A session-class `POST /session` lands on the lease's account whatever the body
  says (`403 account_not_leased` if the body names another), and takes the
  lease's GM opt-in whatever its body's `allowGm` says: only the port
  secret's holder can opt in, never the snippet a lease secret is handed to. The first create
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
tells a module build that predates a route from one that refuses it: the stack's
lease helper (`leaseRunSecret`, `mcp/src/module-auth.ts`) reads `404 not_found`
on `POST /lease` as "this module has no leasing" and runs
without a session secret, where `403 operator_only` would mean the route is
there and the credential is wrong.

The module never logs a secret, and neither the worldserver log nor the audit
log carries a token: both name a session by `tok:` and the first 8 hex
characters of the token's SHA-256, enough to correlate one session's lines and
no more, and the audit files are named by the first 16 ("Audit log" below).
`POST /lease` is the only response that carries a secret. Secrets are compared in constant time. With
`WrathBench.Secret` unset or shorter than 32 characters the module does not
listen at all (logged at ERROR), so a mis-deployed worldserver is unreachable
rather than open.

## Versioning

The protocol has a version of its own, an integer the module serves as
`protocol` on `GET /health` (today `1`). It moves only for a change an existing
SDK would misread — a field that changes meaning or type, a shape or status
that goes away. An addition (a new action, a new event, a new field, a new
error code) leaves it alone: every reader of this protocol ignores what it does
not know, which is why the SDK's schemas are loose and an error code is a bare
string. The audit log ("Audit log" below) is an operational record on the
worldserver's disk, outside the wire: no SDK reads it, so a change to its
layout does not move `protocol`, which would only make every SDK refuse a
module it drives correctly. Such a change is named in the release's changelog
(`CHANGELOG.md`), which is where an operator's tooling learns of it.

The SDK states the protocol versions it can drive (`MODULE_PROTOCOL_VERSIONS`
in `sdk/src/version.ts`) and checks the module's on `connect`, refusing one it
cannot drive with `ModuleProtocolError` before it subscribes. A module that
serves no `protocol` predates the field and speaks `1`. The build identity
(`build`, `startedAtMs`) is a separate thing: which binary, not which wire.

## Endpoints

### GET /health

Module and world status. Either credential class, no body.

Two views. Callers on that network — the sandbox host and, through
it, the snippet sandbox — get liveness plus build identity: `ok`, `module`,
`worldStopped`, `worldLoaded`, `build`, `startedAtMs`, `uptimeMs`, `protocol`,
with `sessions` / `droppedPackets` / `droppedPacketsLive` present but zeroed
(kept so the SDK response schema parses) and no `droppedByOpcode` or
`worldLoad`. The global
session count and the drop census describe module internals and other runs'
sessions, which the observation contract never serves to a snippet. The full
view below is served only to loopback callers — an operator inside the
worldserver container, with the port secret the container already holds (for
example WrathBench's
[`infra/module-health.sh`](https://github.com/Shard/WrathBench/blob/master/infra/module-health.sh), a
perl probe exec'd into the worldserver's container, whose image has no curl).

Operator (loopback) response `200`:
```json
{
  "ok": true,
  "module": "mod-wrathbench",
  "worldStopped": false,
  "worldLoaded": true,
  "sessions": 1,
  "droppedPackets": 4213,
  "droppedPacketsLive": 37,
  "droppedByOpcode": { "SMSG_POWER_UPDATE": 1400, "SMSG_EMOTE": 220, "0x4F2": 3 },
  "worldLoad": { "creatureSpawns": 130000, "gameObjectSpawns": 50000, "creatureTemplates": 28000,
                 "questTemplates": 9500, "dbUptimeS": 86400, "loadedAfterMs": 180000, "dbRestarted": false },
  "build": "harness-0.3-41-g0bfe207",
  "startedAtMs": 1787400000000,
  "uptimeMs": 3600000,
  "protocol": 1
}
```

- `worldLoaded` — whether the world loaded whole; `true` on every `200` (see
  "A world that did not load whole" below).
- `worldLoad` (operator view only) — what that verdict was taken from:
  `creatureSpawns`, `gameObjectSpawns`, `creatureTemplates`, `questTemplates`
  (sizes of the core's in-memory stores), `dbUptimeS` (the world database's
  `SHOW GLOBAL STATUS` Uptime, `null` when unread, in which case the counts
  alone decide), `loadedAfterMs` (this process's age when the verdict was
  taken) and `dbRestarted`. Server internals no client sees, like the drop
  census, so never on the network view.
- `build` — the build identity the builder passed as `-DWRATHBENCH_BUILD` at
  CMake time, compiled into the module (`module/mod-wrathbench.cmake`);
  WrathBench passes its repository's `git describe --tags --always --dirty`.
  `"unknown"` when the build was given none. Served to every caller: it is ops
  identity, not game state, and lets a deployment gate, a run's records or a
  dashboard name *which* server they talked to.
- `startedAtMs` — worldserver process start, epoch milliseconds (captured at
  static initialisation). `build` + `startedAtMs` together identify "this
  build, this boot" (WrathBench's preflight gate keys on exactly that pair).
- `uptimeMs` — milliseconds since `startedAtMs`. Telemetry, not identity.
- `protocol` — the wire protocol version this build speaks, an integer (see
  "Versioning" below). Served to every caller; the SDK reads it on `connect`.
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

**A world that did not load whole is not ready.** The answer is then `503`
with the usual error envelope, `"ok": false, "error": "world_not_loaded"`,
and the rest of the body as above with `"worldLoaded": false`, in both views.
The verdict is taken once, when the module starts (`OnStartup`, after the core
has loaded every store and before the first world tick), and holds until the
process exits: the core never reloads those stores, so only a restart clears
it. It fails when any of the creature spawn, gameobject spawn, creature
template or quest stores is empty, or when the world database's own `Uptime`
is shorter than this process's by more than a few seconds, i.e. MySQL
restarted during the load. The core logs a query that lost its connection and
carries on with that table empty, so without this a database restart in the
middle of the load serves a world with no creatures under an `ok` health.
Every reader that keys on `ok` waits on such a server rather than acting
against it, and a startup probe that passes only on a `200` here has the
orchestrator restart the worldserver rather than start it (WrathBench's chart
does this,
[`worldserver.yaml`](https://github.com/Shard/WrathBench/blob/master/infra/chart/wrathbench/templates/worldserver.yaml)).

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
  "gender": 0,                // optional, default 0 (Male)
  "allowGm": true             // optional, default false: the GM opt-in, below
}
```

`allowGm` is the GM opt-in, off unless the body carries JSON `true`.
Off, the module serves player use only: it refuses an account with a GM
security level (`gm_account`, below) and any chat the server would run as a
command (`chat_command`, "say" below), whatever the account. A session runs
at its account's security level and the stock chat handler runs commands,
so without both refusals a GM account, or a player account granted commands
in `rbac_account_permissions`, would make `say` a door to the server's
command set, which no player's client has. On, both are the account's own
business and the module passes them through. It exists so an operator who
means to drive a GM account can, and so an agent never does by accident.
A session-class create takes its lease's opt-in, whatever its body says
("Authentication"); an operator-class create takes the body's. A session in
world takes a new lease's opt-in for its token at once, so a resumed caller
that re-leases without it turns it off whether or not it creates again; a
same-token create that finds its session in world sets it to the create's. The
module has no conf for it: the opt-in comes only from the holder of the port
secret, who already decides which accounts the module serves.

`race`/`class` semantics: when the named character already
exists on the account, `race` and `class` are ignored entirely — the existing
character is logged in as-is. When the character does not exist
— so this request will CREATE one — both must be numeric and in `[1,11]`;
anything else (absent, non-numeric, out of range) fails the request with
`400 {"ok":false,"error":"invalid_race_class"}` before any
char-create packet is synthesized. There is no silent default character.
Whether a create is needed is only known once the module sees the account's
character list, so this check happens mid-flow (after `SMSG_CHAR_ENUM`),
not at request parse time.

Success `200`:
```json
{
  "ok": true,
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
  (the lease secret is; "Authentication" above) but it still keys every session
  and event stream, and through its hash every audit file, so a guessable one
  lets an operator-class caller collide with another run by accident. Checked before the session is
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
- `400 {"ok":false,"error":"invalid_race_class"}` — the character
  does not exist and race/class are not both in [1,11] (see above; decided at
  char-enum time, before any char-create packet is synthesized).
- `409 {"ok":false,"error":"token_in_use"}` — a session already exists under
  this token and is still mid-login (not yet in world). A same-token create for a
  session that is already in world does **not** get this: it succeeds
  idempotently (see the reclaim note below).
- `403 {"ok":false,"error":"account_not_permitted"}` — `account` is not on the
  `WrathBench.Accounts` allowlist.
- `400 {"ok":false,"error":"unknown_account"}`
- `403 {"ok":false,"error":"gm_account","hint":...}` — the account holds a
  security level above player (`account_access.gmlevel` greater than 0 on any
  realm) and the create has no GM opt-in (`allowGm` above); the hint says how
  to opt in. Checked first, before any reclaim, so a refused create disturbs
  no other session. `POST /characters` and `POST /character-delete` refuse the
  same accounts the same way, and take `allowGm` the same way. For player use,
  give the module dedicated accounts made with `account create`, which are
  players unless someone raises them.
- `400 {"ok":false,"error":"socket_setup_failed"}`
- `502 {"ok":false,"error":"char_create_failed_code_<N>"}` — game-level
  char-create rejection (N is the `SMSG_CHAR_CREATE` result code); also surfaced as
  a `SMSG_CHAR_CREATE` event.
- `502 {"ok":false,"error":"login_failed"}`
- `502 {"ok":false,"error":"character_missing_after_create"}`
- `504 {"ok":false,"error":"timeout"}` — either the login flow did not
  reach the world within 20s, or (see reclaim below) a stale session held the
  account and the core had not released it within the internal reclaim wait.
  Both are transient and retryable.

Create reclaims a permitted account. `POST /session` on an account
that passed the allowlist **always takes ownership** instead of dead-ending on a
stale/leaked session — the invariant is one account = one job = one live
session, which the deployment keeps (WrathBench's fleet enforces it with a
duplicate-account guard and an account-busy guard), so any session found
holding the account at create time is stale, and reclaiming it is correct, not
a race:
- Same token, already in world for the **same** account+character: returns
  success idempotently and emits one plain `WB_SESSION_STATE` (the reattach
  replay is a subscribe's to ask for; "/events" below); it does
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
`quest_complete`, `quest_request_reward`, `quest_choose_reward`, `quest_abandon`, `loot`, `loot_item`,
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
{ "ok": true, "action": "say" }
```

The say language is chosen server-side from the character's team (Common for
Alliance, Orcish for Horde); the caller does not supply it. A client-visible
rejection (e.g. muted) comes back as a `SMSG_NOTIFICATION` event, not an HTTP error.

Without the GM opt-in ("POST /session", `allowGm`), text the server would
run as a command is refused and nothing is sent:
`403 {"ok":false,"error":"chat_command","action":"say","hint":...}`, the hint
saying how to opt in. The test is the core's own, read off the packet the
module built, exactly as `WorldSession::HandleMessagechatOpcode` reads it:
`ChatHandler::ParseCommands`'s prefix (a `.` or `!`, then neither the same
character again nor a space; `src/server/game/Chat/Chat.cpp`, lines 250-271
at the pinned core) and, for `LANG_ADDON` lines, the addon channel's command
form (`AzerothCore\t`, then `h` or `i`, a four-character counter and a
command; `AddonChannelCommandHandler::ParseCommands`, lines 991-1030; the two
parse calls are `src/server/game/Handlers/ChatHandler.cpp` lines 302 and
307). The module stops at the prefix and runs no command lookup, so a line like `.hi`,
which the core would say as chat for a player when no command matches, is
refused too: say it without the leading character. `raw` `CMSG_MESSAGECHAT`
(party, yell, whisper, any chat type) is held to the same test.

#### move_to

Walk the character to a world position. The module resolves the position against
the server's navmesh once (the single sanctioned mmaps use, docs/CONTRACTS.md
"Pathing") and then drives the character with the client movement packet
sequence a real client would send (`MSG_MOVE_START_FORWARD`, heartbeats every
~500ms, `MSG_MOVE_STOP`) at the character's real run speed, or its swim speed
in water (Swimming, below). The caller never sees the path — only progress
and a terminal result event.

Turns. Where the route bends, the walk reports the turn when it passes the
point, as a client reports its own turn mid-run: `MSG_MOVE_SET_FACING` with
`MOVEMENTFLAG_FORWARD`, where the body is, with the new leg's heading, and
the heartbeat interval restarts from it. Observers run a character on along
the last heading they were sent, so without it they carried it past each
bend for up to a heartbeat and then snapped it back. One packet per change of
more than about 3 degrees (0.05 rad) from the heading last sent, so a curve
of smaller bends is reported once their sum passes that; none between a
forced ledge's edge and its landing (`force`, below). The packets carry the
session's own client clock (Speed changes and the clock, under
"Movement/observation extension").

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
Without `guid` the ground z is tried only after a `target_off_mesh`. The
ground height looks down from the z given, so a z under the ground (one read
off a lower level, often the character's own) finds none; after both, the
module tries the walkable level of the mesh directly over `x,y`, when it is
the only one in the column within ±50y (levels within 2y of each other are
one floor; an island the character cannot reach is not a level) and the
request rests on no ground of its own (no ground height within 2y of z): a z
buried in the terrain under a road, whose one reading is the road. The core
searches that band for the end polygon but refuses an end more than 7y from
it in 3D (`PATHFIND_FARFROMPOLY_END`), which this rung is for. A column with
two or more levels is two readings of the request and is not guessed
between; a request resting on ground the mesh does not walk asked for that
ground, not a roof over it; and a level below the request is not taken: the
ground rung has judged that already, and a point on a hillside did not ask
for the tunnel under it.
A target the mesh rejects at every height tried is still `target_off_mesh`,
and `meshZ` is reported relative to the z asked for. The audit log records
the level rung as `op: "move_mesh_z"` (`z`, `meshZ`), beside the ground rung's
`move_ground_z`.

Optional `force` (boolean): walk a route that steps *down* off a ledge instead
of refusing it as `drop` (statuses below) — a ledge of the mesh's own route,
or the edge past the end of the mesh that a move to a point below the route's
end walks on to (`path_incomplete`, below). The step is walked the way a
client's character walks off an edge — a heartbeat at the edge, nothing
during the fall, `MSG_MOVE_FALL_LAND` at the foot — so the server charges the
fall through its own `Player::HandleFall`, as it would a client's. The fall
takes the time a fall takes, not a run down the cliff: the core's own fall
clock (`Movement::computeFallTime`, gravity to terminal velocity, the slower
terminal velocity under Feather Fall or Slow Fall) over the ledge's height, or
the run's time over its horizontal span when that is longer, since a
character keeps its forward speed through a fall; areatriggers are not tested
in mid-air. `force`
does not apply to a step *up*: a client cannot walk up a ledge the mesh calls
a climb, and such a route is refused as `drop` (positive `dz`) whatever the
request says. Nor does it apply to a step whose foot lies under the ground
(`drop` with `surfaceZ`): no client falls through terrain. The module never
judges whether a fall is survivable: that is a game rule, and the SDK's
`moveTo` applies it from the facts a `drop` carries (`dz`, `safeFall`) and
the character's own health before deciding to re-issue with `force`.

Swimming. A route through water is swum the way a client swims it, decided
from the server's own liquid status (`Map::GetLiquidData`, the query behind
`IsInWater`/`IsUnderWater`) and the character's collision height, read every
tick so a mount counts. The numbers are the pinned core's, not measured off a
client: the core counts a unit as swimming once the water over its feet is
deeper than 75% of its collision height (`Unit::ProcessTerrainStatusUpdate`,
which says it mirrors the client), and runs the breath timer only once that
depth exceeds the whole height (`LIQUID_MAP_UNDER_WATER`). So where the water
is deeper than the threshold the module sends `MSG_MOVE_START_SWIM` with
`MOVEMENTFLAG_SWIMMING`, carries the flag and the pitch field the flag puts in
the packet (level, 0) on every packet after it, stops and facings included,
paces the walk at `GetSpeed(MOVE_SWIM)` (base 4.72y/s, swim-speed auras
included, no mounted bonus, `Unit::UpdateSpeed`), and holds the body just
past the threshold under the surface, a quarter of its height clear of the
breath timer; back in shallower water it sends `MSG_MOVE_STOP_SWIM` and runs
again. Shallower water is waded at run speed with the body on the bed. The
route's own z says neither: the navmesh over water is the surface (the mmaps
generator keeps a quad's liquid triangles and drops the terrain under them,
`TerrainBuilder`, "pick higher one"), and the core's path normalization
(`PathGenerator::NormalizePath`, `WorldObject::UpdateAllowedPositionZ`) then
lowers points over deep water to its own floating depth for a creature,
`GetMinHeightInWater`, about 0.59 of the collision height, which its own swim
test above reads as not swimming, and leaves points over shallows on the
surface, where a body sent at that z walks on the water. So depth is the
liquid's (its level less the bed under it), never the level less the route's
z, and the body's z is the module's. A walkable surface
more than 1y above the water (a pier, a dock, a bridge) is not water, nor is a
transport's deck. A forced fall that ends in swimmable water ends with
`MSG_MOVE_START_SWIM` and no `MSG_MOVE_FALL_LAND`, as a client's does, so the
server charges no fall. Everything that follows from the flag is the
server's: `Player::SetInWater` and the terrain-status update remove the auras
whose spells end on entering or leaving water (a mount among them, where its
spell says so), and swimming-only checks apply. Outside a move the flag on a
`stop` or `face` is the server's record of the last one sent
(`Player::IsInWater`); a move starts from that record and sends the transition
first if the character's position now says otherwise.

Walk time. At dispatch the module adds up how long its own walker will take
over the route, `etaMs`, reported beside `pathLength` on the dispatch ack,
`WB_MOVE_PROGRESS` and `WB_MOVE_RESULT`, so a caller can judge a move by time rather than by
yards at a run speed it assumes: a swim is slower than a run, a mount or a
ghost faster. Each stretch counts at the speed the walker will drive it at,
`GetSpeed(MOVE_SWIM)` where the water test above says the body swims and
`GetSpeed(MOVE_RUN)` everywhere else, wading and transport legs included;
both speeds are read once, at dispatch, so whatever the server applies to
them then (a mount, a ghost's speed, a slow) is in the estimate, and a change
mid-walk is not. A forced ledge counts as the fall it is (`force`, above). The water test runs once per 5y of route, at the middle of
each stretch and at the route's own z, as the walker passes it, so a
shoreline is placed to within half a stretch. This is the walker reporting its
own plan, not a game rule; the 3s confirmation after the last step is not in
it.

Success `200` (means "queued and pathing", not "arrived"):
```json
{ "ok": true, "action": "move_to", "moveId": 1, "pathLength": 612.4, "etaMs": 87486 }
```

The ack is sent once planning has answered, which is the call's own
synchronous work on the world thread. A walk that was dispatched carries its
route's `pathLength` (yards, 3D) and `etaMs` (absent when no speed could be
read), the same figures every `WB_MOVE_PROGRESS` of the move repeats; a move
refused at planning or as `too_far` acks with `moveId` alone, and its
`WB_MOVE_RESULT` follows the ack.

Additional error: `400 {"ok":false,"error":"missing_position","action":"move_to","param":"<first missing axis>"}`.

The outcome arrives as a `WB_MOVE_RESULT` event carrying the same `moveId`
(statuses below). A `move_to` issued while a previous one is still running
supersedes it: the old move ends with status `superseded` (the module sends the
`MSG_MOVE_STOP` a redirected client would, so a new request that fails at
planning never leaves the server believing the character is still running),
then the new path starts from wherever the character is. A request that fails
before anything moves (`too_far` and the planning causes below) likewise sends
a stop if the server still holds the character as moving.

A rooted character cannot move (Roots, below): while the module holds the
character rooted, a `move_to` is refused before planning with status `rooted`,
acked with `moveId` alone like any refusal, and nothing is sent, not even the
redirect's stop; a walk still running then ends `rooted` first. A stun is
the same refusal under its own status, `stunned` (Roots, below): the unit
the client moves carries `UNIT_FLAG_STUNNED`, the client-visible bit that
tells a stun from a root.

While the client moves another unit (a vehicle's driving seat, a possession:
"Vehicles and possession", below), the walk is that unit's — its guid on
every packet, its position, speed and water, `mover` naming it on the ack's
events and verdict, a flying unit's leg flown rather than walked — and a
`move_to` is refused `controlling` only when the core holds a mover that is
not in the character's map; a walk still running when control changes hands
ends `controlling`.

Flying. A character the server has told it can fly (`SMSG_MOVE_SET_CAN_FLY`
for its own guid, Movement-state changes below: a flying mount where flying
is allowed, a flight form; never read from the DB) is flown as a flying
mover is ("Driving", below): a straight line to the point at the z asked
for, at its flight speed (`MOVE_FLIGHT`, the mount's auras in it), the line
judged by the same line-of-sight and terrain samples and refused
`path_incomplete` at the last clear point, `flight: true` on the ack's
siblings, the progress events and the verdict. The ground is the default.
The leg is flown only

- when the request says so: optional `fly` (boolean), refused before
  planning with status `cannot_fly` (acked with `moveId` alone, nothing
  sent) when the character has not been told it can fly;
- or when the character is already in the air: a flight that ended there,
  which no ground route starts from.

Never on its own (operator decision): a ground walk the mesh refuses
(`path_incomplete`, `target_off_mesh`, a climb, …) stays a refusal for a
character that can fly, whose SDK hint then says `{ fly: true }` is there.
A flight the caller did not ask for could stop short of its landing (a stop,
a superseding move, a root, the drift guard) and leave the body hovering
over a drop that a later dismount or a no-fly zone would fall from. The
module serves the state as `WB_FLIGHT_STATE` (`canFly`, `airborne`), and the
SDK's `dismount` refuses while airborne. `too_far` holds a flight too.

The packets are a client's (unverified against a capture; every flight
opcode goes to `HandleMovementOpcodes` as a run does, `Opcodes.cpp`, so the
server reads only their flags and position): from the ground,
`MSG_MOVE_START_ASCEND` (0x359) with `MOVEMENTFLAG_ASCENDING`, then the
run's `MSG_MOVE_START_FORWARD`, heartbeats and `MSG_MOVE_STOP`, each with
`MOVEMENTFLAG_FLYING | MOVEMENTFLAG_CAN_FLY` and the pitch field the flag
puts in the layout, the line's own slope (level within ±90°; a possessed
flyer's flight is pitched the same way). Areatriggers are tested along it:
the character itself travels. A flight whose point lies on solid ground
(terrain, vmap or a game object's floor within 1y under or over it) lands
there, its stop carrying no `FLYING`; any other ends in the air, water
included, and the body hovers: every packet and ack carries
`FLYING | CAN_FLY` and a level pitch until a flight lands it, a teleport
or a new world puts it down, or the server takes can-fly away. Then it
falls, as a client's body falls: the can-fly ack is its last packet in the
air (no `FLYING`, so the server's fall start is that height), a heartbeat
every 500ms carries `MOVEMENTFLAG_FALLING`, the fall's clock (`fallTime`)
and the jump block (zspeed, sin, cos, xyspeed: 0, the facing, 0), and where
the core's own fall curve (`Movement::computeFallElevation`, Feather Fall
included) meets the surface under it (the edge drop's surface reads,
`path_incomplete` above) it sends `MSG_MOVE_FALL_LAND`, which the server
charges as any fall (`Player::HandleFall`; a dismount at height can kill),
or `MSG_MOVE_START_SWIM` into deep water. The landing is served as
`WB_SELF_MOVE` (cause `fall`). A flight running when it happens ends
`interrupted` where it was. While the body falls a `move_to` is refused
`falling` (acked with `moveId` alone, nothing sent), `face` is refused
`409 falling` and `stop` sends nothing: a packet with no fall clock would
move the server's fall start (`Player::UpdateFallInformationIfNeed`).

#### stop

Stop moving (sends `MSG_MOVE_STOP` where the character currently is). Always
acks `200 { "ok": true, "action": "stop" }`; if a move was in
progress it additionally ends with a `WB_MOVE_RESULT` status `stopped`, or
`rooted` (or `stunned`) with no packet when a root has already stopped it. While the client
moves another unit the stop is that unit's ("Vehicles and possession"). A
stop mid-flight leaves the body hovering where it stopped, and a stop while
the body falls sends nothing (Flying, above).

Request: `{ "token": "run-abc123", "action": "stop" }`

#### face

Turn in place (sends `MSG_MOVE_SET_FACING`). Give either an absolute
`orientation` in radians (0 = east/+x, counter-clockwise, normalized to
[0, 2pi)) or a point `x`,`y` to face toward.

Request: `{ "token": "run-abc123", "action": "face", "orientation": 1.57 }`
or `{ "token": "run-abc123", "action": "face", "x": -8900.0, "y": -130.0 }`

Success `200`: `{ "ok": true, "action": "face", "orientation": 1.57 }`
Additional errors: `400 {"ok":false,"error":"missing_face_target","action":"face","param":"orientation or x,y"}`,
`409 {"ok":false,"error":"stunned"}` (the unit the client moves is stunned:
a stunned client cannot turn, Roots below; nothing sent; a root alone does
not refuse it),
`409 {"ok":false,"error":"falling"}` (the body is falling, Flying above;
nothing sent),
`409 {"ok":false,"error":"moving"}` (stop first, or supersede with `move_to`),
`409 {"ok":false,"error":"controlling"}` (the core holds a mover for this
client that is not in the character's map, "Vehicles and possession" below;
nothing sent). While the client moves another unit, the facing is that unit's.

The refusal while moving is the client's own limit, not a module shortcut. A
walk is sent as forward running (`MOVEMENTFLAG_FORWARD`, with the orientation
of the leg it is on), and a client running forward travels where it faces:
its turn mid-run (`MSG_MOVE_SET_FACING` or a heartbeat with a new
orientation) bends the run itself. Sending the facing while the walk keeps
its course would put a facing on the wire that does not match the travel,
which no client's packets show. Strafe and backpedal flags reach only the
eight directions relative to facing, so they cannot hold an arbitrary facing
along a navmesh path either. A turn that the walk then follows would leave
the path the module planned. So a `face` mid-walk is refused with nothing
sent, and the character turns once it stands.

#### Single-opcode actions (quest/combat extension)

Every action below synthesizes exactly one client opcode into the stock
handler (plus, for `loot_all`, the follow-up opcodes a real auto-loot client
sends). The `200` ack means "queued"; game outcomes — cast failures, gossip
menus, loot windows, inventory errors — arrive as the whitelisted events
listed further down, never as HTTP errors. All `guid`/`targetGuid`/`itemGuid`
request fields are decimal strings (u64 note above). Success shape for all of
them: `{ "ok": true, "action": "<name>" }`.

| action | request fields (beyond `token`, `action`) | opcode sent | notes |
|---|---|---|---|
| `set_target` | `guid` | `CMSG_SET_SELECTION` | |
| `clear_target` | — | `CMSG_SET_SELECTION` | guid 0 |
| `attack_start` | `guid` | `CMSG_ATTACKSWING` | melee auto-attack; server swings while in range and facing. A swing it refuses is reported once as `SMSG_ATTACKSWING_NOTINRANGE` / `SMSG_ATTACKSWING_BADFACING` (latched: see "Swing errors" under the combat table) |
| `attack_stop` | — | `CMSG_ATTACKSTOP` | |
| `cast_spell` | `spellId`, `targetGuid?`, `itemTargetGuid?`, `destX?`, `destY?`, `destZ?` | `CMSG_CAST_SPELL` | no target = self/auto target (mask 0); with `targetGuid`, TARGET_FLAG_UNIT + packed guid. The target block is written in the order `SpellCastTargets::Read` (Spell.cpp) takes it: u32 mask, the unit's packed guid, then with `itemTargetGuid` TARGET_FLAG_ITEM (0x10) + the item's packed guid (an item the character holds; the server looks it up with `GetItemByGuid` and answers `item_gone` when it is not there), then with `destX`/`destY`/`destZ` TARGET_FLAG_DEST_LOCATION (0x40) + packed transport guid 0 + three floats, a world position. The three dest fields come together or not at all (`400 missing_dest`, `param` the first missing); an `itemTargetGuid` of 0 is `400 invalid_item_target`, a non-finite point `400 invalid_dest`. The trade-window item (TARGET_FLAG_TRADE_ITEM) and the projectile cast flags are not sent. A game object guid works too (the core resolves the packed guid by its type), which is how chests open; a client would set TARGET_FLAG_GAMEOBJECT for it. The leading cast count is the client's own: one per-session u8 counter, shared with `use_item`, one more on every cast and running 1..255 (never 0). The core skips its in-progress check for a count of 0 (`Spell::prepare`), so a cast sent while another is still casting would silently cancel it; with a count it is refused `SMSG_CAST_FAILED` `spell_in_progress` (105), as a client's is, and the cast in progress goes on. A cast sent with 400 ms or less of the running one left (and of the global cooldown) is held by the server's spell queue (`SpellQueue.Window`, default 400) and goes off after it, count or not. The audit row carries `castCount`, and `itemTargetGuid` and `destX`/`destY`/`destZ` when sent |
| `cancel_cast` | `spellId` | `CMSG_CANCEL_CAST` | |
| `interact` | `guid` | `CMSG_GAMEOBJ_USE` | doors, buttons, quest objects, mailboxes. Not chests: the core's `GameObject::Use` has no chest case and returns silently; a client opens a chest with `cast_spell` of the lock's Opening spell at the object's guid (the SDK's `lootCorpse` does this) |
| `gossip_hello` | `guid` | `CMSG_GOSSIP_HELLO` | opens the NPC gossip menu (`SMSG_GOSSIP_MESSAGE`) |
| `gossip_select` | `guid`, `menuId`, `optionId`, `code`? | `CMSG_GOSSIP_SELECT_OPTION` | ids from `SMSG_GOSSIP_MESSAGE` (`menuId`, `options[].optionId`). `code` is the text a client's box sends for an option whose `coded` is true: appended as a cstring after the three fields, which the core reads only for a coded menu item (`WorldSession::HandleGossipSelectOptionOpcode`, MiscHandler.cpp), so it is sent only when given; a coded option chosen without one is a short packet the core fails to read |
| `quest_list` | `guid` | `CMSG_QUESTGIVER_HELLO` | `SMSG_QUESTGIVER_QUEST_LIST` or a gossip menu follows; an NPC without the gossip flag whose menu holds one quest sends that quest's `SMSG_QUESTGIVER_QUEST_DETAILS` (or `_REQUEST_ITEMS` / `_OFFER_REWARD`) instead (`Player::SendPreparedQuest`) |
| `quest_details` | `guid`, `questId` | `CMSG_QUESTGIVER_QUERY_QUEST` | quest text via `SMSG_QUESTGIVER_QUEST_DETAILS` |
| `quest_accept` | `guid`, `questId` | `CMSG_QUESTGIVER_ACCEPT_QUEST` | `guid` may be a quest-start item's own guid (after `use_item` on it): the handler accepts TYPEMASK_ITEM |
| `quest_complete` | `guid`, `questId` | `CMSG_QUESTGIVER_COMPLETE_QUEST` | server answers REQUEST_ITEMS (a quest with required items, `completable` saying whether they are all in hand) or OFFER_REWARD |
| `quest_request_reward` | `guid`, `questId` | `CMSG_QUESTGIVER_REQUEST_REWARD` | the client's "Continue" on a completable REQUEST_ITEMS window: the handler completes the quest and answers OFFER_REWARD (`HandleQuestgiverRequestRewardOpcode`); silence when the quest is not completable there |
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
| `use_item` | `bag`, `slot`, `targetGuid?`, `itemTargetGuid?`, `destX?`, `destY?`, `destZ?`, `glyphSlot?` | `CMSG_USE_ITEM`, `CMSG_QUESTGIVER_QUERY_QUEST` or `CMSG_OPEN_ITEM` | module fills item guid + on-use spell id from the item (client-cache knowledge) and the cast count from the counter `cast_spell` uses. The targets are `cast_spell`'s, in the same target block after the cast flags (`HandleUseItemOpcode` reads it with `SpellCastTargets::Read`), with the same refusals; an item that starts a quest or opens for loot takes no item or ground target (`400 no_spell_to_target`). `glyphSlot` (0-5, default 0) is the glyph slot a client's glyph frame sends with a glyph, the u32 after the item guid; the server judges the slot's level lock and glyph type (`SMSG_CAST_FAILED`), and anything past the six slots is `400 invalid_glyph_slot` before dispatch. An item with no on-use spell but a `startquest` is right-clicked the way a client does it: `CMSG_QUESTGIVER_QUERY_QUEST` with the item guid as the questgiver and the template's quest id (`HandleUseItemOpcode` drops spell id 0 as unknown, so `CMSG_USE_ITEM` is never the packet for it); the server answers `SMSG_QUESTGIVER_QUEST_DETAILS`, and `quest_accept` with the same item guid takes it. An item with neither, whose template has `ITEM_FLAG_HAS_LOOT` (a clam, a satchel, a lockbox), is opened the way a client's right-click opens it: `CMSG_OPEN_ITEM` (`u8 bag, u8 slot`, `HandleOpenItemOpcode`); the window arrives as `SMSG_LOOT_RESPONSE` under the item's guid, and `loot_item`, `loot_money` and `loot_release` with that guid empty it (no replay is armed: a refusal, locked or dead, is `SMSG_INVENTORY_CHANGE_FAILURE` and opens nothing). `400 no_item_at_slot`; `400 item_not_usable` only when the item has no on-use spell, no quest to start and does not open for loot. The audit row carries `spellId`, `itemGuid`, `startQuest`, `glyphSlot` when it is not 0, `itemTargetGuid` and `destX`/`destY`/`destZ` when sent, and `open: true` for an open |
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
| `vehicle_exit` | — | `CMSG_DISMISS_CONTROLLED_VEHICLE` or `CMSG_REQUEST_VEHICLE_EXIT` | the client's Leave Vehicle. From the driving seat (the vehicle is the client's mover, "Vehicles and possession" below) the client hands the vehicle's last MovementInfo back: packGUID of the vehicle and a MovementInfo (`VehicleHandler.cpp` `HandleDismissControlledVehicle` applies it and exits); from any other seat the bodiless `CMSG_REQUEST_VEHICLE_EXIT` (`HandleRequestVehicleExit`, which exits only from a seat whose flags allow it and logs the rest silently). `409 not_in_vehicle` when the character sits in none, nothing sent. The exit is observed as the exit spline (`SMSG_MONSTER_MOVE` with `transportExit`). The audit row names the `opcode` and the `vehicleGuid` |
| `vehicle_change_seat` | `seat` | `CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE` or `CMSG_REQUEST_VEHICLE_SWITCH_SEAT` | the vehicle frame's seat click, `seat` the 0-based seat index. From the driving seat: packGUID of the vehicle, its MovementInfo, packGUID of the unit whose seat is wanted (the vehicle itself) and the `i8` seat; from any other seat: packGUID of the vehicle and the `i8` seat. Both reach `HandleChangeSeatsOnControlledVehicle`, which refuses a seat whose flags forbid switching, a taken seat and a seat that does not exist, all silently; the new seat is observed as its boarding spline (`SMSG_MONSTER_MOVE_TRANSPORT`). `409 not_in_vehicle`; `400 missing_seat`. The audit row names the `opcode`, the `vehicleGuid` and the `seat` |

Validation errors (all `400`): `missing_guid`, `missing_option`,
`missing_quest_id` (also for `quest_query`), `missing_reward_index`, `missing_spell_id`,
`missing_slot`, `missing_item`, `missing_item_guid`, `missing_bag_slot`,
`missing_talent`, `missing_talents`, `invalid_talents`, `missing_dest`,
`invalid_item_target`, `invalid_dest`, `no_spell_to_target`, `missing_seat`, and for `raw`:
`missing_opcode`, `opcode_not_allowed`, `invalid_payload`, `payload_too_large`.

Every `missing_*` reply from `POST /action` echoes what it was about:
`{"ok":false,"error":"missing_guid","action":"set_target","param":"guid"}`.
A guid-shaped field (`guid`, `targetGuid`, `itemGuid`, `itemTargetGuid`) that is present but not
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
`{ "ok": true, "action": "raw" }`. The audit record carries
`opcode` and `payload` so the exact bytes sent are reconstructable.

Errors (all `400`): `missing_opcode`, `opcode_not_allowed` (echoes `opcode`
and a hint), `invalid_payload` (not whole hex bytes), `payload_too_large`
(echoes `received` and `maximum`). And `403 chat_command`: a `CMSG_MESSAGECHAT`
whose text the server would run as a command, on a session without the GM
opt-in ("say" above has the test).

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
  `CMSG_OPEN_ITEM`, `CMSG_BUYBACK_ITEM`, `CMSG_SET_AMMO` (`u32 item id`, 0
  clears — the ammo slot, which `CMSG_AUTOEQUIP_ITEM` cannot fill; `ammoId`
  on self reads it back)
- spell/aura control: `CMSG_CANCEL_AURA`, `CMSG_CANCEL_MOUNT_AURA` (empty
  body — the client's Dismount; `HandleCancelMountAuraOpcode` dismounts and
  removes every mount aura, and answers a character not mounted or in flight
  with only a system line; the SDK's `dismount` sends it),
  `CMSG_CANCEL_AUTO_REPEAT_SPELL`, `CMSG_CANCEL_CHANNELLING`, `CMSG_SET_SHEATHED`, `CMSG_STANDSTATECHANGE`,
  `CMSG_RESURRECT_RESPONSE` (body `u64 caster guid, u8 status` — 1 accepts,
  0 declines — the answer to `SMSG_RESURRECT_REQUEST`; the handler ignores it
  from a living character and an accept that names a caster other than the
  pending one; the SDK's `acceptResurrection` sends it), `CMSG_SELF_RES`
  (empty — a dead character's own resurrection, the spell `selfResSpell` on
  self names), `CMSG_DISMISS_CRITTER` (`u64 companion guid`),
  `CMSG_TOTEM_DESTROYED` (`u8 slot`, as `SMSG_TOTEM_CREATED` names it)
- flight paths: `CMSG_TAXINODE_STATUS_QUERY`, `CMSG_TAXIQUERYAVAILABLENODES`,
  `CMSG_ACTIVATETAXI` (body `u64 guid, u32 fromNode, u32 toNode`; the SDK's
  `activateTaxi` builds it), `CMSG_ACTIVATETAXIEXPRESS` (body `u64 guid,
  u32 count, u32 node × count`, the current node first; `activateTaxi` with
  a hop list builds it)
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
  `SMSG_LOOT_START_ROLL` opened; the SDK's `lootRoll` builds it),
  `CMSG_REQUEST_PARTY_MEMBER_STATS` (`u64 guid`, unpacked — the party frame's
  own refresh of one member; answered with `SMSG_PARTY_MEMBER_STATS_FULL`)

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
  SpellCastTargets` as `cast_spell` carries them; the SDK's `petCast` with a
  point builds it with `TARGET_FLAG_DEST_LOCATION`, the shot a vehicle's
  cannon takes from its bar; the handler takes a pet or a charmed or
  possessed unit alike), `CMSG_PET_STOP_ATTACK` (`u64 pet guid`),
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
  mailed letter), `CMSG_QUEST_POI_QUERY` (`u32 count, u32 questId × count`,
  at most 25 — a quest's objective areas, answered with
  `SMSG_QUEST_POI_QUERY_RESPONSE`; the SDK's `questAreas` builds it),
  `CMSG_PLAYED_TIME`, `CMSG_QUERY_TIME`,
  `CMSG_SET_WATCHED_FACTION`, `CMSG_SET_ACTION_BUTTON`
- corpse: `MSG_CORPSE_QUERY` (empty body) — re-ask where the corpse is; the
  module already asks once per death on the client's behalf (see "Death"), and
  the answer is whitelisted
- vehicles: `CMSG_SPELLCLICK` (`u64 guid` — the click on a unit's spellclick,
  the vehicle cursor; `SpellHandler.cpp` `HandleSpellClick` casts the unit's
  `npc_spellclick_spells` spell at the character, a vehicle's ride aura
  among them, and does nothing silently for a unit out of range or whose
  conditions fail; the SDK's `spellClick` sends it), `CMSG_PLAYER_VEHICLE_ENTER`
  (`u64 player guid` — board another player's vehicle; `HandleEnterPlayerVehicle`
  takes raid members within interaction range only). Leaving and changing
  seat are actions (`vehicle_exit`, `vehicle_change_seat`): both carry the
  client's own MovementInfo

Deliberately absent: movement opcodes (the module drives them; a stray one
desyncs the mover), session lifecycle (login, logout, character create/delete),
every opcode that already has an action (one audited path per opcode), and
anything GM-gated or teleport-shaped. Answers to raw actions reach the agent
only through the event whitelist: the pet, party, mail, bank and trade
replies are whitelisted, as are those to `CMSG_NPC_TEXT_QUERY`,
`CMSG_TAXINODE_STATUS_QUERY`, `CMSG_PLAYED_TIME` and `CMSG_QUERY_TIME`; the
rest have none yet, which is exactly the evidence the hatch exists to produce.

### POST /lease

Operator only. `{ "token": <str>, "account"?: <str>, "allowGm"?: <bool> }` →
`200 { "ok": true, "token", "account", "secret", "allowGm", "character"? }`.
Binds the token to the account (default `WrathBench.Account`) and issues — or,
for a token already leased, rotates — its session secret; `allowGm` is the GM
opt-in its session-class creates inherit ("POST /session"), echoed so the
caller knows the module took it (a module that predates it echoes nothing);
`character` is present when an earlier create under this token already bound
one. Errors: `400
missing_token`, `400 weak_token`, `403 account_not_permitted`, `403
operator_only`. See "Authentication".

### DELETE /lease

Operator only. `{ "token": <str> }` → `200 { "ok": true, "token", "released": <bool> }`.
Revokes the token's lease secret; a live session under the token is untouched.

### POST /characters

Operator only (`403 operator_only` for a session-class caller).
`{ "token": <str>, "account"?: <str>, "allowGm"?: <bool> }` → `200 { "ok": true, "enum": { "count": <number>, "characters": [ { "guid", "name", "race", "class", "gender", "level" }, ... ] } }`.
A parked utility session (never enters world) answers with the decoded `SMSG_CHAR_ENUM` for the account — the same data a client's character-select screen shows. Exists for a harness's housekeeping between sessions (list-then-delete leftover characters); errors mirror `/character-delete` (`missing_token`, `token_in_use`, `account_not_permitted`, `unknown_account`, `gm_account`, `account_in_use` when a live session holds the account, `504 timeout`).

### POST /character-delete

Operator only (`403 operator_only` for a session-class caller; the snippet
child therefore cannot delete any character, its own included — a fresh start
is the operator's reset, not the agent's). Delete a character by name
through the real `CMSG_CHAR_DELETE` path. Needed because a fresh character per
session accumulates against the realm's 10-characters-per-account
cap. The module stands up a short-lived parked session, authenticates, walks
the character list, sends `CMSG_CHAR_DELETE` for the matching name, and tears
the session down. Cannot run while another session is live on the same account
(`account_in_use`). The character must be fully released by the core: for up to
~a minute after logout the core still tracks an offline session for the
character and `CMSG_CHAR_DELETE` is silently ignored (no response packet), which
surfaces here as `504 timeout` — callers should retry until `deleted` comes
back (the SDK's `deleteCharacter` does exactly that).

Request:
```json
{ "token": "del-abc123", "account": "RUNNER", "character": "Benchy" }
```
(`allowGm: true` may be added, as on `POST /session`, to serve a GM account.)
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
running session. A `POST /session` create, by contrast, reclaims (see the create
reclaim note above): it tears the other session down and takes ownership rather
than returning `account_in_use`, so a create never produces `account_in_use`.
`POST /session` and `POST /characters` apply the same allowlist. Minimal ownership gate for the per-run account scheme;
per-character credentials are the fuller fix.)

Success `200`: `{ "ok": true, "character": "Benchy", "deleted": true }`
Errors: `400 missing_token`, `400 missing_character`, `409 token_in_use`,
`403 account_not_permitted`, `403 gm_account`, `409 account_owned_by_other_token`,
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

Success `200`: `{ "ok": true }`
Errors: `400 missing_token`, `404 no_session`, `401 unauthorized`, `403 token_mismatch`.

What ends a session: this, a create that reclaims its account ("POST /session"
above), and the worldserver stopping. Nothing else does. Closing every
`/events` socket of a token does not, by design: a subscriber's socket is not
the session's lifetime. The SDK's stream reconnects on its own after a drop
and must find the character where it was; a restarted sandbox child
subscribes again (with `replay=1`) to the session its predecessor left; a
subscriber opens `/events` before the session exists; and a token may have
several subscribers at once. A caller that goes away without this call — a
process killed, a host lost — leaves its character in the world until one of
the three ends it, and there is no idle reaper. The standalone MCP server
(`mcp/src/main.ts`) makes this call on a clean exit.

## WebSocket /events?token=...

Upgrade request to `/events` with the session token in the query string and
the credential in the `Authorization` header ("Authentication": the port
secret, or the lease secret issued for this token; anything else is refused
with a plain `401` before the handshake and no subscriber is registered). The
server streams that session's whitelisted outbound packets as JSON text frames,
one object per frame. The channel is send-only (server→client); frames the client
sends are ignored. Multiple sockets may subscribe to the same token; each gets
every event, except the frames of a reattach replay another socket asked for
(below). `&replay=1` on the query asks for that replay.

Delivery guarantees:
- `seq` is per-session and restarts at 0 whenever a token's session is created;
  a restart after reconnecting a token is not a gap. Within one session, `seq`
  on the wire is gapless for a subscriber that stays connected, save the seqs
  of a replay it did not ask for, which go to the socket that did and read as
  a gap on every other (one socket per consumer in practice, so a gap no
  consumer sees).
- There is no buffered replay: events are fanned out live and never buffered
  for late or reconnecting subscribers. A dropped WS loses the observations
  emitted while it was down, irreversibly (they remain in the audit log, which
  the agent does not get). There is no `?sinceSeq=` — reconnect and treat the
  world as re-observed from the next update packets, or ask for the reattach
  replay, which restates it whole.
- Subscriber registration happens in the server's WebSocket handshake completion
  handler, before any subsequent request from the caller can be parsed. So: any
  action or `/session` call issued after the client's WS `open` completes will
  have its events delivered to that subscriber. Events emitted concurrently
  with the handshake itself may or may not be seen; open the event stream
  before `POST /session` (as the probes do) and this window is irrelevant.
- Reattach: when a WebSocket subscribes to a token whose session is already
  in world, the module emits one synthetic `WB_SESSION_STATE` event (shape
  below) so a reconnecting consumer regains the self state it would
  otherwise only have gotten from the long-gone `SMSG_LOGIN_VERIFY_WORLD`.
  Player state is read on the world thread, so the event is delivered
  asynchronously shortly after the subscribe — effectively the first frame,
  though events emitted concurrently with the attach may precede it. It
  takes the next `seq` and fans out to every subscriber of the token like
  any event (so `seq` stays gapless for subscribers that never disconnected;
  they can ignore the extra state event). A subscribe during login emits
  nothing — the real `SMSG_LOGIN_VERIFY_WORLD` follows anyway.

  The reattach replay: a subscribe that carries `replay=1` gets, instead of
  the plain frame, a `WB_SESSION_STATE` with `"replay": true` followed by
  what a connected client holds, closed by one `WB_REPLAY_DONE` — on that
  socket alone. It is for a consumer that holds nothing: a restarted sandbox
  child, a resumed run, a socket a snippet closed and reopened. Before it,
  such a consumer got the state frame alone and played with an empty bag,
  no quest log, no health, no spellbook and no race until something changed
  each of them. It is asked for rather than automatic, and sent to the asker
  rather than fanned out, because it is the heaviest thing a session's
  stream can carry — one create block per object in view, built on the
  world thread — and a live consumer whose socket merely flapped wants its
  view kept, not dropped and restated (the SDK's own reconnect ladder never
  asks; its explicit `connect({ replay: true })` does). Requests are
  coalesced and rate-limited per session: one burst, shared by every socket
  that asked since the last one, and no sooner than three seconds after it
  (`REPLAY_MIN_INTERVAL_MS`); a request inside the interval is deferred to
  its end, not refused, and a socket that hangs up before its turn is owed
  nothing. A same-token `POST /session` on a session in world answers with
  the plain state frame, as a subscribe without the flag does.

  What is replayed, in the order the login sends it
  (`WorldSession::HandlePlayerLoginFromDB`) and built by the same core
  functions: first the senders of `Player::SendInitialPacketsBeforeAddToMap`
  whose packets are on the event whitelist — `SMSG_BINDPOINTUPDATE`,
  `SMSG_TALENTS_INFO`, `SMSG_INITIAL_SPELLS` (with its cooldowns),
  `SMSG_INITIALIZE_FACTIONS`, `SMSG_ALL_ACHIEVEMENT_DATA`; then what
  `Map::AddPlayerToMap` sends — `Map::SendInitTransports` (the transports on
  the map), `Map::SendInitSelf` (a create block for every item and bag the
  character carries, then its own create block with `"self": true` and every
  non-zero update field: race, class, health, power, xp, money, the inventory
  and bag slots, the quest log, skills, flags, then its own
  `SMSG_AURA_UPDATE_ALL`), and one `SMSG_UPDATE_OBJECT` with a create block
  for every object in the character's visibility set followed by each unit's
  `SMSG_AURA_UPDATE_ALL` and, for a unit swinging at something, its
  `SMSG_ATTACKSTART` (what `VisibleNotifier::SendToSelf` sends for objects
  entering view); then `SMSG_PET_SPELLS` when a pet is out, as the login
  sends it once the pet is loaded; then `WB_REPLAY_DONE` with the count of
  objects restated. A passenger of the character's own transport is built
  twice, by `SendInitSelf` and by the visibility pass, as at login; a
  consumer merges the second create into the first. `WB_AREA` and
  `WB_PORTALS` follow on their own ticks, as they do after any reattach.
  Not replayed: the login's side effects (the login visual, the zone update,
  the group and friend notices, the time sync), so other players see nothing
  and no server state moves; and the login packets whose opcode is not on
  the event whitelist (the action bar, equipment sets, forced reactions, the
  social list, world states), which the tap would drop. The visibility set
  is read, never cleared and rebuilt, so it is the set the client had at
  that moment and the server's later destroys and creates apply to it
  unchanged. A builder that throws ends the burst early: the exception is
  logged, `WB_REPLAY_DONE` still closes it with `"incomplete": true`, and the
  consumer asks again if it wants the rest.

  Observation-contract note (docs/CONTRACTS.md): every packet in the replay
  is one the core sends a client at login, built by the core's own builders
  from the state the client would hold for the life of its connection; the
  module adds no field. A client that dials in again is handed all of it by
  the login path, and the bench client's connection is its WebSocket.

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
| `SMSG_MESSAGECHAT` | 0x096 | `{ "type": <u8>, "language": <i32>, "senderGuid": <guid-string>, "senderName": <string?>, "receiverGuid": <guid-string?>, "receiverName": <string?>, "channelName": <string?>, "message": <string>, "chatTag": <u8>, "achievementId": <u32?> }` |
| `SMSG_CHAT_PLAYER_NOT_FOUND` | 0x2A9 | `{ "name": <string> }` — a whisper found nobody by that name online, or one who does not take whispers (`WorldSession::SendPlayerNotFoundNotice`): the name as it was sent. The client shows it as "no player named … is playing"; the whisper went nowhere |
| `SMSG_EMOTE` | 0x103 | `{ "guid", "emoteId": <u32> }` — a unit's one-shot emote, to everyone in range, creatures and players alike (`Unit::HandleEmoteCommand`; `WorldPackets::Chat::Emote`): u32 emote id, raw u64 guid |
| `SMSG_TEXT_EMOTE` | 0x105 | `{ "guid", "textEmote": <u32>, "emoteNum": <u32>, "targetName": <string> }` — a player's text emote ("/wave") to the players in listen range, the emoter included (`Acore::EmoteChatBuilder`, ChatHandler.cpp): raw u64 guid, u32 text emote id (an `EmotesText` row), u32 emote number as the emoter's client sent it, u32 name length, then the target's name as a cstring; `targetName` is empty when there is no target (the core also writes a one-character name as none) |
| `SMSG_CHANNEL_NOTIFY` | 0x099 | `{ "type": <u8>, "channel": <string>, ... }` — a channel notice (`Channel::MakeNotifyPacket` and its callers, Channel.cpp): u8 `ChatNotify` type, the channel name as a cstring, then a tail by type, served by its shape: `guid` (joined 0, left 1, password changed 7, owner changed 8, announcements 13/14, moderation 15/16, already a member 23, invite 24, voice 34/35), `guid` and `byGuid` (kicked 18, banned 20, unbanned 21: the target, then who did it), `playerName` (not found 9, channel owner 11, not banned 22, invited 29, invite banned 30), `flags` and `channelId` (you joined 2), `channelId` and `constant` (you left 3), `guid`, `oldFlags` and `flags` (mode change 12). Every other type has no tail |

`SMSG_MESSAGECHAT.data` is decoded per chat `type`, following the layout
`ChatHandler::BuildChatPacket` writes for each (the core's `Chat.cpp`): the
header (`type`, `language`, `senderGuid`, flags) is common; then creature
speech (`CHAT_MSG_MONSTER_SAY`/`PARTY`/`YELL`/`WHISPER`/`EMOTE`, 12–16,
`RAID_BOSS_EMOTE`/`WHISPER`, 41–42, and `BATTLENET`, 47) carries a
length-prefixed `senderName` — a creature has no name-query path, so this is
the only place its name rides — the receiver guid, and a `receiverName` when
the receiver is neither a player nor a pet; `CHAT_MSG_WHISPER_FOREIGN` (8)
carries `senderName` and the receiver guid; the battleground system types
(36–38) the receiver guid and a `receiverName` for a non-player receiver;
`CHAT_MSG_ACHIEVEMENT`/`GUILD_ACHIEVEMENT` (48–49) the receiver guid, and an
`achievementId` after the chat tag; `CHAT_MSG_CHANNEL` (17) a `channelName`
(NUL-terminated) before the receiver guid; every other type just the receiver
guid. Then the length-prefixed `message` and `chatTag`. Optional fields are
present only when the type's layout carried them (`receiverGuid` only when
non-zero). The achievement broadcast's `message` is the client's raw template
(`%s has earned the achievement $a!`); filling it is the consumer's job, as it
is the client's.

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

Roots. The core roots a unit its client controls by packet alone
(`Unit::SendMoveRoot`): `SMSG_FORCE_MOVE_ROOT` (0x0E8) and
`SMSG_FORCE_MOVE_UNROOT` (0x0EA), each a packGUID and a `u32` movement
counter, sent to the controlling client, which stops, answers, and keeps
itself still until the unroot; the server sets nothing and trusts it to.
Stuns arrive the same way (`Unit::SetStunned` -> `SetRooted` ->
`SendMoveRoot`; `Unit::IsClientControlled` does not look at the stun flag), as
do death (`Player::KillPlayer`) and its end (`BuildPlayerRepop`,
`ResurrectPlayer`). A unit its client does not control (feared, confused) is
rooted server-side instead: `MOVEMENTFLAG_ROOT` set in place and
`SMSG_SPLINE_MOVE_ROOT` (0x31A) / `SMSG_SPLINE_MOVE_UNROOT` (0x304), a
packGUID alone, sent to the set, own client included. At login and after a
far port an immobilized character's root rides inside `SMSG_MULTIPLE_MOVES`
(0x51E; `Player::SendInitialPacketsAfterAddToMap`), each sub-packet a `u8`
length, `u16` opcode and body.

The module answers as a client does (module-internal client behaviour, like
the teleport acks; none of these packets is served as an event):
`CMSG_FORCE_MOVE_ROOT_ACK` (0x0E9) and `CMSG_FORCE_MOVE_UNROOT_ACK` (0x0EB),
both read by `WorldSession::HandleMoveRootAck` as the packGUID, the echoed
`u32` counter and a MovementInfo (the movement packets' layout) where the
character stands, with no moving flag and `MOVEMENTFLAG_ROOT` on the root ack
only (`ReadMovementInfo` strips ROOT from every client packet on arrival).
Where a walk is running the ack carries the walk's own point, so it is the
walk's stop; otherwise the server's position. Each is queued from the tap
the moment the server sends the packet, behind whatever the session already
queued, own guid only, and audited. The unroot ack is what clears a
server-side ROOT once control is back: the observed case was a fear, a stun
landing under it (ROOT set in place), the fear ending (a FORCE root, ignored
as already rooted) and the stun ending (a FORCE unroot); with no ack the core
kept ROOT through death, release and the far port, and dropped every movement
packet after (`VerifyMovementInfo`). An ack whose counter is at or below the
counter at the last far teleport is ignored as from the old map
(`Player::GetMapChangeOrderCounter`), so where the unroot and a far port are
one handler call — a repop whose graveyard is on another map — no client's
ack lands in time; the ack is still sent, as a client sends it.

The module also keeps the rooted state a client keeps: set by
`SMSG_FORCE_MOVE_ROOT` and `SMSG_SPLINE_MOVE_ROOT` for the character's own
guid (the multiple-moves sub-packet included), cleared by their unroot twins.
While it is set the mover stops (`rooted`, above) and `move_to` is refused
`rooted`. `face` still turns, which is right for a root. A stun arrives by
the same root packets, so they cannot tell the two apart; what does is
`UNIT_FLAG_STUNNED` (0x40000) in the unit's own `UNIT_FIELD_FLAGS`, which the
server sends the client in the unit's values update (`Unit::SetStunned` sets
it before it roots and clears it before it unroots; the logout countdown
sets it too). While the unit the client moves carries it, a `move_to` is
refused and a walk ends with status `stunned` instead of `rooted`, and
`face` is refused `409 stunned` with nothing sent: a stunned client neither
moves nor turns.

Speed changes and the clock. The core changes the speed of a unit its client
controls by packet too (`Unit::SetSpeed` -> `SendSpeedToController`):
`SMSG_FORCE_WALK_SPEED_CHANGE` (0x2DA), `SMSG_FORCE_RUN_SPEED_CHANGE` (0x0E2),
`SMSG_FORCE_RUN_BACK_SPEED_CHANGE` (0x0E4), `SMSG_FORCE_SWIM_SPEED_CHANGE`
(0x0E6), `SMSG_FORCE_SWIM_BACK_SPEED_CHANGE` (0x2DC),
`SMSG_FORCE_TURN_RATE_CHANGE` (0x2DE), `SMSG_FORCE_FLIGHT_SPEED_CHANGE`
(0x381), `SMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE` (0x383) and
`SMSG_FORCE_PITCH_RATE_CHANGE` (0x45C), each a packGUID, a `u32` movement
counter, a `u8` on the run-speed packet only, and the new speed, sent to the
controlling client alone. Observers learn the speed only from that client's
answer, the matching ack (`CMSG_FORCE_WALK_SPEED_CHANGE_ACK` 0x2DB,
`..._RUN_...` 0x0E3, `..._RUN_BACK_...` 0x0E5, `..._SWIM_...` 0x0E7,
`..._SWIM_BACK_...` 0x2DD, `CMSG_FORCE_TURN_RATE_CHANGE_ACK` 0x2DF,
`..._FLIGHT_...` 0x382, `..._FLIGHT_BACK_...` 0x384,
`CMSG_FORCE_PITCH_RATE_CHANGE_ACK` 0x45D), which
`WorldSession::HandleForceSpeedChangeAck` applies and relays to the set as
`MSG_MOVE_SET_*_SPEED`; unanswered, a mounted, dismounted, slowed or ghostly
character's observers extrapolated its run at the old speed while its
heartbeats advanced at the new one. The module answers each for its own guid
on its next world tick, a round trip after the server sent it, in the order
asked (module-internal client behaviour; neither packet is served as an
event): packGUID, the echoed counter, a MovementInfo, then the speed the
packet named, never a reading of the module's own. The world tick runs after
the session and map updates, so the core reads the ack at the start of the
next one. The handler checks the speed only on the ack that brings its count
of unanswered changes of that type (`Player::m_forced_speed_changes`) to
zero, against the server's speed then: it corrects a lower one and kicks the
player for a higher one. A change made while the character is not under its
client's control (feared, confused, charmed) goes to the set as the creature
opcode and leaves that count alone, so the last ack can echo a speed the
server no longer has. The module therefore withholds an ack that would be the
last of its type outstanding (counting the ones it sent this tick) when its
speed is no longer the server's: the count stays one high, which only makes
the core skip the check on the next ack of that type. The MovementInfo is where the client is
and what it is doing, since the handler applies it: during a walk the mover's
point running forward (`MOVEMENTFLAG_FORWARD`, the core reads it as it reads a
heartbeat); stopping, the stop's point with no moving flag; rooted, the root
ack's point with `MOVEMENTFLAG_ROOT`; mid-fall the edge heartbeat restated
(the server's position, running), which leaves the fall's start where the edge
put it; otherwise the server's position, standing. An ack whose counter is at
or below the last far teleport's is ignored as from the old map, as a
client's is.

Movement-state changes arrive the same way (`Unit::SetWaterWalking`,
`SetFeatherFall`, `SetHover`, `SetCanFly`, from the auras that grant them and
from a ghost's repop and resurrection), packGUID and a `u32` counter to the
controlling client alone: `SMSG_MOVE_WATER_WALK` (0x0DE) /
`SMSG_MOVE_LAND_WALK` (0x0DF), `SMSG_MOVE_FEATHER_FALL` (0x0F2) /
`SMSG_MOVE_NORMAL_FALL` (0x0F3), `SMSG_MOVE_SET_HOVER` (0x0F4) /
`SMSG_MOVE_UNSET_HOVER` (0x0F5), `SMSG_MOVE_SET_CAN_FLY` (0x343) /
`SMSG_MOVE_UNSET_CAN_FLY` (0x344), and the first three of them inside
`SMSG_MULTIPLE_MOVES` at login and after a far teleport. The core does not set
the flag itself: the client does, carries it on every movement packet after,
and answers `CMSG_MOVE_WATER_WALK_ACK` (0x2D0), `CMSG_MOVE_FEATHER_FALL_ACK`
(0x2CF), `CMSG_MOVE_HOVER_ACK` (0x0F6) or `CMSG_MOVE_SET_CAN_FLY_ACK` (0x345).
All four go to `WorldSession::HandleMoveFlagChangeOpcode`, which copies the
ack's flags into its record of the unit (before its old-map counter check),
applies the MovementInfo as a movement packet, clears the pending flight
change on a can-fly ack whose counter matches, and relays `MSG_MOVE_WATER_WALK`,
`MSG_MOVE_FEATHER_FALL`, `MSG_MOVE_HOVER` or `MSG_MOVE_UPDATE_CAN_FLY` to the
set; unanswered, every ghost's observers were never told it walks on water.
The module keeps the four flags as this client's state
(`MOVEMENTFLAG_WATERWALKING`, `_FALLING_SLOW`, `_HOVER`, `_CAN_FLY`), clears
them on `SMSG_NEW_WORLD` and `SMSG_LOGIN_VERIFY_WORLD` (the server restates
what still holds once the character is in the map, and sends nothing for an
unset made while it was out of one), sets or clears the one the packet names,
then answers for its own guid from the tap (module-internal, as the
speed acks; none of these packets is served as an event): packGUID, the echoed
counter, the MovementInfo as the speed acks build it (the new flag on it), and
the `u32` the handler reads and never uses (1 set, 0 unset). Every movement
packet and ack after carries the flags, since the core replaces its record of
them with each packet's; one the server dropped without a packet is stripped
on arrival (`ReadMovementInfo` removes each without its aura). Two
deliberate gaps: `MOVEMENTFLAG_CAN_FLY` is kept but sent only while the
body is in the air after a flight of the character took off (Flying, under
`move_to`), with `FLYING` beside it, acks included; on the ground it is not
sent, the can-fly ack included (it is still sent: it tells observers and
clears the pending flight change), because the core's pathfinder plans a
ground `move_to` on the character and, with the flag held
(`Player::CanFly` reads the packets' flags), stops settling route points on
the ground (`WorldObject::UpdateAllowedPositionZ`) and takes a straight-line
shortcut where the start or target is more than 7y off the mesh
(`PathGenerator`), while a ground walk only walks; and `MOVEMENTFLAG_WATERWALKING` is dropped
from every packet that swims, since the walker swims a water-walking body
under the surface (below) and no client sends the two together. The
`SMSG_SPLINE_MOVE_` twins of the first three (sent while the client does not
control the unit, which the server then flags itself) update the state and
want no ack. No ack is sent while the character moves another unit (a vehicle,
a charm): the handler writes the flags onto whatever the session moves.

With the server now holding hover, the core's pathfinder reads it as it
would a real client's: over land a hovering character's route points are
raised by its hover height (1y for a player) and so walked there
(`WorldObject::UpdateAllowedPositionZ`, from `PathGenerator::NormalizePath`).
Water walking is kept but not lived, a known gap: the walker's water test
(Swimming, above) does not read it, so a water-walking body (every ghost,
Water Walking, Levitate) is still swum under the surface at swim speed where
a client runs on it at run speed.

`SMSG_MOVE_KNOCK_BACK` (0x0EF) is not answered: a client's
`CMSG_MOVE_KNOCK_BACK_ACK` is the start of the arc (`MOVEMENTFLAG_FALLING`
and the launch velocity, which the handler relays to observers as
`MSG_MOVE_KNOCK_BACK`), and owes the arc's packets and a `MSG_MOVE_FALL_LAND`
where the body comes down, which the module would have to simulate (collision
included). Unanswered, the server keeps the character where it stood and
observers see no knockback; nothing on the server waits on the ack.

Vehicles and possession. A client moves exactly one unit, `Player::m_mover`:
every movement packet and every root and movement-state ack must carry that
unit's guid or the handler drops it (`HandleMovementOpcodes`,
`HandleMoveRootAck`, `HandleMoveFlagChangeOpcode`; the speed-change acks are
the exception, accepted for the character's own guid alone, so a controlled
unit's forced speed change is never acked by any client). The server tells
the client which unit that is with `SMSG_CLIENT_CONTROL_UPDATE` (0x159;
`Player::SetClientControl`): a packGUID and a `u8`, 1 when the client may
move the unit, 0 when not. A vehicle's driving seat (`Vehicle::AddPassenger`
on a seat with `VEHICLE_SEAT_FLAG_CAN_CONTROL`, `Unit::SetCharmedBy`
`CHARM_TYPE_VEHICLE`) and a possession (`CHARM_TYPE_POSSESS`, the Eye of
Acherus) send `(unit, 1)` and make the unit the mover, then the unit's
control bar as `SMSG_PET_SPELLS` under the unit's guid
(`Player::VehicleSpellInitialize` / `PossessSpellInitialize`, "Pets" below;
the bar is cast from with `CMSG_PET_CAST_SPELL` and `CMSG_PET_ACTION`, raw,
as a pet's is); the end of either (`Unit::RemoveCharmedBy`) sends
`(unit, 0)`, `(character, 1)`, makes the character the mover again and
removes the bar (guid 0). A fear or confusion sends `(character, 0)` and
`(character, 1)` with no mover change; login and every far teleport make the
character its own mover without a packet
(`Player::SendInitialPacketsAfterAddToMap`). The packet is served as an event
(the movement table below), and the module keeps the mover as a client does
and answers each update the way a stock client does (module-internal client
behaviour, audited as `op: "active_mover"`, never an agent action and not on
the raw allowlist): `CMSG_SET_ACTIVE_MOVER` (0x26A, `u64 guid`) for a unit
it may now move, which `HandleSetActiveMoverOpcode` only checks against the
mover, and `CMSG_MOVE_NOT_ACTIVE_MOVER` (0x2D1, packGUID and a MovementInfo
of the unit as it stands) for a unit it stops moving, whose MovementInfo
`HandleMoveNotActiveMover` keeps only while that unit is still the mover.

Boarding is `CMSG_SPELLCLICK` (raw, above): the seat's ride aura
(`SPELL_AURA_CONTROL_VEHICLE`) puts the character on the seat, and the
server sends the character `SMSG_ON_CANCEL_EXPECTED_RIDE_VEHICLE_AURA`
(bodiless, not served), `SMSG_BREAK_TARGET`, a root (`SMSG_FORCE_MOVE_ROOT`
for a passenger seat, acked as any root; `SMSG_SPLINE_MOVE_ROOT` once a
driving seat has made the vehicle the mover) and the boarding spline,
`SMSG_MONSTER_MOVE_TRANSPORT` (0x2AE) for the character's own guid: packGUID
of the character, packGUID of the vehicle, the `i8` seat, then the
`SMSG_MONSTER_MOVE` body in the vehicle's frame — how a client learns which
vehicle, and which seat, it sits in. Leaving (`vehicle_exit`, above) ends
with `SMSG_FORCE_MOVE_UNROOT` for the character (acked) and the exit spline,
`SMSG_MONSTER_MOVE` with `MoveSplineFlag::TransportExit`, served as
`transportExit: true`. A client reports the end of each of those two
splines with `CMSG_MOVE_SPLINE_DONE` (0x2C9: packGUID, its MovementInfo, the
`u32` spline id; `TaxiHandler.cpp` `HandleMoveSplineDoneOpcode`). The core
takes the report only while the character is its own mover — a passenger
seat's boarding, and every exit (`RemoveCharmedBy` restores the mover before
the exit spline) — and then clears the transport change it expects
(`Player::SetExpectingChangeTransport`) and relays the body's root state;
from a driving seat the vehicle is the mover and the report is dropped
(`mover->GetGUID() != guid`), as a stock client's is. The module sends it on
the world tick after the core has run the spline to its end
(`Unit::UpdateSplineMovement`), for its own guid and those two splines only
(module-internal, audited as `op: "spline_done"`). A taxi's spline is the
server's own flight and is ended by the core itself.

Driving. While the vehicle or the possessed unit is the mover, `move_to`,
`stop` and `face` are that unit's: every packet carries its guid, its
position, speed, map and water are the walk's, and the verdicts and progress
events name it (`mover`, with `pos` the unit's). A ground mover (a steed) is
walked over the mesh as the character is, planned from the unit's own
position and collision height at its run speed, with the same ledge, water
and turn rules; a flying mover (the Eye of Acherus: a unit whose create
block and spline packets, or a `SMSG_MOVE_SET_CAN_FLY` for its guid since,
carried can-fly or no gravity — which is how a client knows, never the
creature's template; the FLYING bit the core adds to a possessed flyer in
place, `Unit::SetCharmedBy`, reaches no client, so the walk sets it on its
own packets while it flies, as a client's physics do) is flown, as a client flies it, in a straight line
at the z asked for and at its flight speed (`flight: true` on the ack's
siblings, the progress events and the verdict), the line judged against the
geometry a client has — models and game objects by the map's line of sight
(`Map::isInLineOfSight`, which does not see terrain), the terrain by its own
height under each 4y sample (`Map::GetGridHeight`, whatever z the sample is
at) — and refused `path_incomplete` at the last clear point when it runs
into either; a flight has no water, no ledges and no transport legs, and the
unit's own `FLYING | CAN_FLY` ride its packets (the core keeps them once the
mover has its fly aura, `ReadMovementInfo`, and strips them until then). The
walk's drift guard (the walker ending a move `interrupted` when the server's
position falls more than a tolerance behind the walker's, checked each
heartbeat) keeps its 15y for the character's own walk and, for a flight or
a walk of another unit, follows the pace — 0.8 s of it plus 10y, never under
15 — since the server's position is the last heartbeat's. The unit's root packets
(`SMSG_FORCE_MOVE_ROOT` with its guid, `Unit::SendMoveRoot` to the
controlling client) and movement-state changes are answered with its guid
and kept as its own state, apart from the character's, which stands while
it sits on a seat (`moverRooted`, `moverMoveFlags`: the unit's ROOT and
flags from its create block at the handover, then the packets for its guid);
a forced speed change of the unit is never acked, as no client's is
(`HandleForceSpeedChangeAck` takes the character's guid alone).
Areatriggers are tested where the character itself travels: on its feet or
on a vehicle it sits in, never for a possessed unit that flies off while it
stands. The vehicle's spells are cast from its bar; a seat that moves nothing
(a cannon, a mine car the server drives) is rooted by the server and refused
`rooted`. `controlling` remains for the one case no packet can drive: the
core holds a mover that is not in the character's map, or control changes
hands mid-walk.

Every timestamp the module sends as the client's (the movement packets, the
acks, `CMSG_TIME_SYNC_RESP`) reads one clock of the session's own,
milliseconds since the session was created, as a client's clock is its own and
not the server's. The module answers `SMSG_TIME_SYNC_REQ` on its next world
tick, a round trip later, with the echoed counter and that clock then,
stamped as received the moment it is queued. The core takes the offset between the clocks from those answers
(`HandleTimeSyncResp`, `ComputeNewClockDelta`) and adds it to every movement
time before relaying it (`SynchronizeMovement`), so observers get the server
time of each packet. The clock is not the server's because an offset of ~0 is
never adopted (the core moves it only past 25ms) and reads as "no sync". The
answer waits for the tick because the tap runs inside `SendPacket`, before
`SendTimeSync` stamps the request's send time: an answer stamped there could
precede that stamp across a millisecond boundary, the core's u32 round trip
then wraps to ~2^32 ms and the offset it takes is ~2^31 ms (relayed movement
times ~24.8 days out). For the same reason the receive stamp is not the one
the socket gives a real client's answer, the start of the world tick, which
precedes a send made within it. Sessions whose character is between maps are
answered too: a far teleport's arrival resets the sync and asks again.

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
  A create block carries every field the core has non-zero for this receiver
  (`Object::BuildValuesUpdate` with `UPDATETYPE_CREATE_OBJECT` sets a mask bit
  only for a non-zero field, or one flagged to be sent regardless), and a
  client starts every field at 0: a named field absent from `fields` is 0 on
  the client, not unobserved. A values block is the opposite, a delta, where
  absent means unchanged. The SDK reads both that way (`StateCache`).
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
  `powerType` (the last four unpacked from UNIT_FIELD_BYTES_0),
  `standState` (byte 0 of UNIT_FIELD_BYTES_1, `UnitStandStateType`: 0
  stand, 1 sit, 2-6 chairs, 3 sleep, 7 dead, 8 kneel, 9 submerged),
  `shapeshiftForm` (byte 3 of UNIT_FIELD_BYTES_2, `ShapeshiftForm`, 0 none;
  the rest of both words is dropped), and
  `summonedByGuid`, `createdByGuid`, `charmedByGuid` (the
  PUBLIC owner fields as guid strings — a pet's master; `"0"` when unset) and
  `petNumber` (UNIT_FIELD_PETNUMBER; on first sight of a unit with a non-zero
  one the module issues the `CMSG_PET_NAME_QUERY` a client does, once per
  number per session), `channelSpell` and `channelObjectGuid`
  (UNIT_CHANNEL_SPELL and UNIT_FIELD_CHANNEL_OBJECT, PUBLIC: the spell a unit
  is channelling and what at, set by `Spell::SendChannelStart` and cleared to
  0 / `"0"` by the channel's end)
- units and players, beside `faction` (the `UNIT_FIELD_FACTIONTEMPLATE`
  id): that template's FactionTemplate.dbc row, which a client reads to
  colour the unit hostile, neutral or friendly — `factionRow` (the template
  id the row describes; absent when the client data has no such row),
  `factionRowFaction` (its Faction.dbc faction), `factionRowFlags`,
  `factionRowGroup` / `factionRowFriendGroup` / `factionRowEnemyGroup` (the
  faction-group masks: its own, those it befriends, those it fights),
  `factionRowEnemy0`..`3` and `factionRowFriend0`..`3` (explicit enemy and
  friend factions), and `factionRowRepIndex` (the faction's Faction.dbc
  `reputationListID`, -1 when it keeps no reputation). For a faction that
  keeps one, also `factionRowBaseRace0`..`3`, `factionRowBaseClass0`..`3`
  and `factionRowBaseRep0`..`3`, its Faction.dbc base reputation table (the
  standing of a faction the login reputation list leaves out). Client-cache
  knowledge served beside the id the way skill names are; every key is
  re-served whenever `faction` is, so a changed template overwrites the row.
  The SDK does the client's arithmetic (`UnitView.reaction`) with the
  character's own row and reputation pane
- players additionally: `playerFlags` (served as the raw integer; the module
  names no bit off it. The SDK decodes `PLAYER_FLAGS_GHOST` and
  `PLAYER_FLAGS_RESTING` SDK-side — a naming of already-served
  data, not a new tap)
- game objects: `goDisplayId`, `goFlags`, `goFaction`, `goLevel`, `goState`,
  `goType`
- corpses: `corpseOwnerGuid` (CORPSE_FIELD_OWNER, PUBLIC, as a guid string:
  the player whose corpse or bones this is — a client labels it "<name>'s
  corpse" from the owner's name). On a corpse's `create` with an owner not yet
  name-queried this session the module issues the `CMSG_NAME_QUERY` a client
  does, so an owner who was never in view is named too. `corpseFlags`
  (CORPSE_FIELD_FLAGS, PUBLIC, the raw integer; the module names no bit):
  `CORPSE_FLAG_BONES` (0x01) marks bones, which a client draws as scenery and
  no resurrection reaches. A corpse turns to bones when its owner comes back
  to life or dies again, or when it expires (`Map::ConvertCorpseToBones`):
  the corpse is destroyed (`SMSG_DESTROY_OBJECT`) and the bones are a new
  `create` under the same guid with the owner kept and the flags `0x05`
  (bones and 0x04, which every corpse carries). CORPSE_FIELD_DYNAMIC_FLAGS is
  not served: only a battleground's insignia bones set it

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
| `WB_MOVE_PROGRESS` | 0xFF02 | `{ "moveId": <number>, "pos": { "x","y","z","o" }, "pathLength": <f>, "etaMs": <u64>, "mover": <guid-string>?, "flight": true? }` — at most 1/s while moving; `mover` only on a walk of another unit (a vehicle, a possessed unit: "Vehicles and possession"), whose position `pos` then is, and `flight` only when the leg is flown (that unit's, or the character's own: move_to, "Flying"); `pathLength` is the length in yards of the route the move walks (the resolved polyline, 3D), and `etaMs` how long the module's walker takes over it at the speeds it read at dispatch (move_to, "Walk time"), both the same on every event of the move; `etaMs` is absent when no speed could be read |
| `WB_MOVE_RESULT` | 0xFF01 | `{ "moveId": <number>, "status": <str>, "pos": { "x","y","z","o" }, "meshZ": <f?>, "reachedPos": { "x","y","z" }? }` — `meshZ` only on `arrived` when the mesh z differed from the request; `reachedPos` on `path_incomplete` and `drop`; `"pathLength": <f>` and `"etaMs": <u64>` on the verdict of any move that was dispatched and walked (a refusal at planning has neither), the route's length in yards and its walk time as on `WB_MOVE_PROGRESS`; `"dz": <f>, "target": { "x","y","z" }` only on `drop`, plus `"safeFall": <u32>` when the character's own fall-height reduction (`SPELL_AURA_SAFE_FALL`, the client's buff frame) is non-zero, and `"surfaceZ": <f>` only when the step's foot lies under the ground surface at its x,y (the step is then refused forced or not); `"nearest": { "x","y","z" } | null` only on `target_off_mesh` (the walkable mesh point nearest the request within 20y, or `null` when none is); `"onTransport": { "guid": <guid-string>, "entry": <u32> }` when the character ended the move aboard a transport; `"mover": <guid-string>` on any verdict of a walk of another unit (and on `controlling`, the unit the core holds), with `pos` that unit's, and `"flight": true` when the leg was flown, that unit's or the character's own ("Vehicles and possession"; move_to, "Flying") |
| `WB_RIDE_PROGRESS` | 0xFF05 | `{ "transportGuid": <guid-string>, "transportEntry": <u32>, "pos": { "x","y","z","o" } }` — at most 1/s while the character rides a transport and is not walking; the server-side position the transport carried it to |
| `WB_TRANSPORT_PROGRESS` | 0xFF06 | `{ "guid": <guid-string>, "entry": <u32>, "pos": { "x","y","z","o" }, "progressMs": <u32>, "periodMs": <u32?>, "docked": <bool?>, "inRange": <bool?> }` — at most 1/s per session, one per transport on the character's map whose create block the session has received and that is within the map's visibility range of the character in 2D (`Map::GetVisibilityRange()`, the core's `Visibility.Distance.*` for the map — 100y on continents and 170y in instances by default — the distance the core sends every other object at; transports alone are sent map-wide) or is carrying it; a transport that leaves the range gets one last report with `"inRange": false` and no `docked` (its position as it left), then none until it is back: the car's current position on its `TransportAnimation.dbc` path (what a client animates locally from `pathProgress`), the clock and period, and `docked` when the keyframe segment the clock is on has no displacement (the car is dwelling at a platform; absent for transports without an animation path) |
| `WB_AREATRIGGER` | 0xFF04 | `{ "triggerId": <u32>, "moveId": <number>, "pos": { "x","y","z","o" } }` — the character entered an `AreaTrigger.dbc` volume and `CMSG_AREATRIGGER` was sent for it (see below); `moveId` is the `move_to` that crossed into it, 0 when no move did (a taxi landing, a transport carrying the character, a teleport's arrival) |
| `WB_PORTALS` | 0xFF0A | `{ "mapId": <u32>, "portals": [{ "triggerId": <u32>, "x", "y", "z", "toMap": <u32>, "toMapName"?: <str>, "toInstanceType"?: <u32> }] }` — the map-transition portals in view: every `AreaTrigger.dbc` volume on the character's map whose `areatrigger_teleport` row leads to another map, within the map's visibility range of the character in 2D (`Map::GetVisibilityRange()`, the range `WB_TRANSPORT_PROGRESS` uses). `x`,`y`,`z` is the volume's centre from the client's DBC; `toMap` is the map it leads to, named and typed from the client's `Map.dbc` as on `WB_AREA` (both absent for a map the table has no row for); the arrival point is never served. Tested at most once a second and sent only when the set or the map changes, the whole current set each time (`[]` once the last one is out of range); sent again after a reattach's `WB_SESSION_STATE`. A dungeon entrance is scenery and a trigger volume, never an object, so nothing else names it |
| `WB_SELF_MOVE` | 0xFF09 | `{ "opcode": "MSG_MOVE_FALL_LAND", "cause": "taxi_landing", "pos": { "x","y","z","o" }, "fromZ": <f> }` — a movement packet the module sent for the character outside any `move_to`, as a client's own physics would: the drop from a taxi flight's last spline point (`fromZ`) to the ground under it (`pos`), cause `taxi_landing`, see "Taxi landing" below; and the landing of a fall from the air after the server took can-fly away mid-air, cause `fall` (`fromZ` the height it fell from; `opcode` `MSG_MOVE_START_SWIM` when it came down in deep water), see move_to, "Flying" |
| `WB_FLIGHT_STATE` | 0xFF0C | `{ "canFly": <bool>, "airborne": <bool> }` — the flight state this client holds (move_to, "Flying"): `canFly` the server's word for the character's own guid (`SMSG_MOVE_SET_CAN_FLY` / `SMSG_MOVE_UNSET_CAN_FLY`), `airborne` its body in the air after a flight that ended there. Sent when either changes, at every `SMSG_NEW_WORLD` and `SMSG_LOGIN_VERIFY_WORLD` (both false until the server restates can-fly), and in the reattach replay before `WB_REPLAY_DONE` |
| `WB_AREA` | 0xFF07 | `{ "mapId": <u32>, "mapName"?: <str>, "instanceType"?: <u32>, "zoneId": <u32>, "zoneName": <str>, "areaId": <u32>, "areaName": <str> }` — the zone and subzone the character is in, named as the client names them, and the map it is on with the client's `Map.dbc` name and `InstanceType` for it (0 the open world, 1 a party dungeon, 2 a raid, 3 a battleground, 4 an arena; both absent when the table has no row for the map, never a guessed 0); once when the character enters the world and once per change of either area id, of the map or of the instance, whatever moved it (walking, a teleport, a map transfer). A transfer always sends one, with the new map's `mapId` and `instanceType`, even when both area ids stay the same: the Deadmines portal does, the mine outside on map 0 and map 36 inside being zone and area 1581 alike. See "Zone and area" below. |
| `WB_TALENT_TREE` | 0xFF08 | the class talent frame, the answer to the `talent_tree` action; shape under "Spellbook, cooldowns, talents" below |
| `WB_SESSION_STATE` | 0xFF03 | `{ "character": <str>, "guid": <guid-string>, "inWorld": true, "map": <n>, "x": <f>, "y": <f>, "z": <f>, "o": <f>, "level": <n>, "mapName"?, "instanceType"?, "zoneId", "zoneName", "areaId", "areaName", "replay"?: true }` — emitted once per WS subscribe to an already-in-world session and once per same-token `POST /session` on such a session; a subscribe that asked with `replay=1` gets it with `replay: true` and the reattach replay after it, on that socket alone (reattach semantics in the `/events` section above). Strictly client-visible facts: what `SMSG_LOGIN_VERIFY_WORLD` plus the session's own identity would carry, plus the same map and zone/area fields as `WB_AREA` so a reattached client starts where the stream cannot re-emit. |
| `WB_REPLAY_DONE` | 0xFF0B | `{ "objects": <u32>, "incomplete"?: true }` — closes the reattach replay a `WB_SESSION_STATE` with `replay: true` opened: how many objects in view were restated (the character and its items aside), and `incomplete` when a builder threw and the burst stopped there. No game state of its own; the mark a consumer waits on before reading what the replay filled. |

`moveId` is a plain JSON number: it is a per-session counter that cannot exceed
2^53, so it falls under the counter exemption to the u64-as-string rule stated
at the top of this document.

`WB_MOVE_RESULT.status` is one of (navigation vocabulary):
- `arrived` — the server-side character reached the destination; `pos` is the
  server-confirmed position. When the navmesh resolved the request to a ground
  z more than 1y from the requested z, the result also carries `meshZ` (the z
  actually walked to): the request's z was off, the mesh's z was used, and the
  agent should quote `meshZ` next time. A request whose z sits more than 2y
  under the ground is one such case: the core's own path normalization keeps
  a z it cannot see the ground from (it looks down from 2y above the point,
  and from inside the terrain finds nothing, or a floor buried under the hill
  — a tunnel roof 45y down, in Dun Algaz), so the module ends the walk at the
  height of the polygon the path ends on instead, and the arrival carries that
  as `meshZ`. The audit log records the lift as `op: "move_end_z"`.
  A request whose own polygon lies on a closed island of the mesh that the
  start's polygon is not on (a component of fewer than 1024 polygons; a
  sliver under a WMO floor, a ledge nothing links to) can be reached by no
  route, so the walk ends instead at the walkable mesh nearest the request
  that the start can reach, when that lies within 7y of it (the core's own
  far-from-polygon distance), and arrives there. The Deadmines entrance
  trigger's centre is such a point: the tunnel's mesh ends 4.4y from it,
  inside the trigger. With nothing reachable within 7y the move answers
  `path_incomplete`, as for any route the mesh does not have. The audit
  log records it as `op: "move_end_reachable"` (`islandPolys`, `walked`,
  `from`, `to`).
- `too_far` — destination beyond the single-move cap (~250yd straight-line);
  issue intermediate `move_to`s.
- `no_mesh` — no navmesh tile is loaded under the character or under the
  destination. A harness/data limitation, not a route problem; nothing to
  retry from the agent's side.
- `target_off_mesh` — the destination has no walkable polygon within the
  mesh's search box (3y in 2D, ±50y in z, and within 7y of the request in 3D)
  at the z asked for, the ground height under it, or the walkable level over
  it when that is the column's only one and the request rests on no ground
  (`move_to` above), or it sits inside geometry. A z buried under the ground
  alone produces this only where the column at `x,y` holds two or more
  walkable levels. The result
  carries `nearest`: the walkable mesh point closest to the request within
  20y in 2D that a move from the character's position can reach (Detour's
  nearest-polygon query, at most 128 polygons considered, so in a dense
  interior it is a walkable point near the request rather than provably the
  nearest; the polygons of up to eight closed islands the start is not on
  are stepped past), or `null` when the box holds none. It is a statement about the
  agent's own requested point in a failure, not a map query (operator
  decision, 2026-10-05, docs/CONTRACTS.md "Map knowledge"). Pick a point on
  a road, a floor, or where an NPC stands.
- `start_off_mesh` — the character is standing off the mesh and no walkable
  mesh lies within 10y of it (a transport deck, a bad landing). A start off
  the mesh with mesh within 10y is not a failure: the module paths from the
  nearest mesh point and prepends the straight walk onto it from the true
  position — what a client's character does, since only the pathfinder is
  mesh-bound — and the walk is dispatched (audited as `op: "move_start_snap"`
  with the point and distance); the drop guard judges that first leg like
  any other. Recovery from the failure is different from `target_off_mesh`:
  more than a few yards of movement, or a disembark, fixes the start.
- `path_incomplete` — the mesh has no continuous walkable route to the
  destination. The module already tried once to subdivide (path to where the
  mesh got, then onward), and then planned the whole corridor with its own
  search: the core's path holds at most 74 polygons from a 1024-node search,
  and a route the core runs out on (the Deadmines mine's tunnels are 177
  polygons) is searched again with 16384 nodes, 512 polygons and 256 points
  of 4y — the same route the core would build with room to finish, audited
  as `op: "move_long_plan"`. A request the character already stands at —
  within the smooth path's 0.3y slop of the start in 2D, within 2y of its
  height, on the start's own polygon or one linked to it — is not a route
  either answers (the core adds a second point to a one-point smooth path
  only for a one-polygon corridor, and calls the rest NOPATH): after both have
  failed, the walk is that step, dispatched like any route and arriving,
  where it would otherwise have been `path_incomplete`; audited as
  `op: "move_end_slop"`. Where the mesh got is never the request itself:
  the core's partial path ends at the request when its corridor is the start
  polygon alone, or when it gave up and returned the straight line (74
  points or more, or no polygon path), and a subdivision from there was the
  request to itself, which spliced that straight line into the walk (71y
  through the Deadmines from the pool past the first boss, into a hollow 15y
  from any polygon); that end is left off and the mesh got as far as the
  point before it. Before any of this, a start whose own polygon
  is on a closed island that does not hold the destination's (fewer than
  1024 polygons; the Deadmines pool's floor is 6 under the water surface's
  polygons) is planned from the water surface directly over the start, off
  that island and within the core's own start box (5y in z), when there is
  one: the route still begins at the start, in the same column — the swim up
  a client's character makes — and the drop guard judges its first segment
  like any other (audited as `op: "move_start_level"`). A dry level over the
  start, or any level under it, is not taken: that would be climbing a ledge
  or falling through a floor. `reachedPos` is how far the core's search got,
  so the agent can route around or approach from another side; its z can be
  a level away from the request (a search that ran out on a hillside over a
  tunnel). Nothing moved.
  A request more than 2y below where the route ends is not refused there
  (operator decision, 2026-10-28). The mesh is built per connected surface,
  so a plateau whose sides are too steep to walk has no route down that
  contains a ledge for the drop guard to judge, while a client's character
  walks off any edge. The module walks on from the route's end straight
  toward the request over the ground a client walks: a sample every 1.67y
  (the step at which the drop guard's two bounds meet), each one's surface
  read from 1y over the last (terrain, vmap and game-object floors, or the
  water over them), each step a walkable slope with nothing at body height in
  the way and nothing rising past that 1y — terrain by its own height, a
  model or game-object surface (a ramp, an arched deck) by the level line at
  the look's height from the last sample, which it would cross — with every
  sample, the one past the lip included, within 10y of the route's end (the
  start snap's own leg, the other way) and never past the request, to the
  first step the guard calls a ledge. That lip is the edge. The body falls
  from it as a client's does: it leaves the edge at the run speed the walker
  drives it at (a ghost's faster run included), keeps that speed forward, and
  drops by the core's own fall curve (`Movement::computeFallElevation`, Feather
  Fall's slower terminal velocity included). It lands where that arc first
  meets the surface under it — so it clears a shelf narrower than its flight,
  as a running client does, and lands on one wider — or, where the arc runs
  into a model, in the last column it crossed. On the ground it falls on only
  down a pair of samples steeper than the guard's ramp (a face no client
  stands on, whatever the mesh says) and stops at the first pair that is not,
  so a cliff is fallen to its foot rather than caught on a gentler patch of
  its face. Still in the air over the request, it comes down there, by the
  slower start that brings the arc onto the surface at the request, if that
  arc clears the ground before it. A short drop that comes down too far out
  for the edge-to-landing segment to be a ledge is stepped off instead (the
  slowest start) and lands at the foot. From the landing the route goes on to
  the request: from the mesh under the landing when the request can be
  reached from it, else from the walkable mesh nearest it within 10y that is
  not on a closed island apart from the request (as an island end is walked
  to its reachable mesh: the foot of a cliff is where the mesh breaks up
  around what stands there), walked onto over the ground under the walk on's
  own rule — no rise past the look, no pair a ledge, nothing at body height
  in the way — by the core's path or the module's planner, ending within 4y
  of the request. When neither has one and the landing (or the mesh it walks
  onto) is where the request is — within the smooth path's 0.3y slop of it in
  2D, within 2y of its height, on the request's own polygon or one linked
  to it — the route ends at the landing with no leg below (two points
  that close on neighbouring polygons are a path neither the core nor the
  planner returns, as for any move, below). The fall must be the route's only ledge, so `force` given
  for it never walks a second one. When the mesh's own route steps down a
  ledge on its way to its end (a terrace whose mesh is a small island with a
  steep step inside it) and is refused for that second ledge, the walk on is
  tried once more from where that route starts — where the character stands
  — toward the same request, under the same rules. When
  all of that holds the answer is that
  route's, settled by the same guard as any other: `drop` without `force`
  (the edge as `reachedPos`, `dz` to the landing, `safeFall`), and with
  `force` the walk, the fall — charged by the server as any forced ledge — and
  the leg below, ending `arrived`. Otherwise it stays `path_incomplete`. The
  edge, the fall and the leg below all lie on the line to, and the route to,
  the agent's own request: nothing is reported about ground it did not ask
  for. A `target_off_mesh` gets no such walk: there is no route end to walk
  on from and no route below to reach, and `nearest` names ground the agent
  can ask for instead, which may then end in one. The audit log records the
  attempt as `op: "move_edge_drop"`.
- `drop` — the mesh's route steps off a ledge: some segment of the resolved
  polyline falls (or climbs) more than 2.0y and steeper than 1.2x its 2D
  length — a cliff, not a ramp (stairs and ramps pass; a stale z within the
  `meshZ` band passes). Before refusing, the module re-plans around the steep
  band, up to three times, with the mesh polygons under every refused segment
  barred, and walks the first re-planned route this same guard passes; when
  none does, what follows describes the mesh's own route. A `drop` can also
  be the edge past the end of the mesh (`path_incomplete`, above): then
  `reachedPos` is that edge, `dz` the fall to where it lands, and no re-plan
  runs, since the mesh has no route to plan around. Without `force` the
  walk is not dispatched: `reachedPos` is the last point before the step (the
  edge, on the level the route reached it on: the character's own unless the
  route climbed first), `dz` is the signed vertical step the route
  would have taken there, `target` echoes the requested point, and `safeFall`
  rides when non-zero. The module reports the ledge and leaves the verdict to the
  caller: the server's fall rule (free under 13.48y, then a share of max
  health rising with height, `Player::HandleFall`) is a game rule, so the
  SDK estimates the fall from `dz` and `safeFall` against the character's own
  health and re-issues with `force` unless it would take about four fifths
  of current health or more (a ghost takes no fall damage, so a corpse run is
  never refused). With `force` a downward route is walked and the fall is the
  server's. A step *up* (positive `dz`) is refused forced or not: no client
  walks up a ledge. A step whose foot lies under the ground is refused forced
  or not as well, and carries `surfaceZ`: the first surface (terrain, vmap or
  game-object floor — the geometry a client has) found looking down from the
  edge's height at the foot's x,y, which the foot sits more than 1y below.
  Such a foot is a z the request guessed and the mesh never resolved — a
  point inside solid ground that no client can fall to — and the caller
  should quote a z on the surface instead. A foot in or on water over its
  bed is not under the ground, whatever solid lies over it (a lip or an
  overhang above a cove): the surface search sees solid geometry only, so
  the foot is tested against the server's liquid status there
  (`Map::GetLiquidData`, the swim test's query, Swimming above) and, in
  water or no more than 1y over it, is a fall into water, judged like any
  other drop. The same guard runs per segment while walking; a ledge that
  slips past planning stops the character at the edge with the same status
  and `pos` at the edge, or, on a forced downward one, is walked with the
  client's fall packets.
- `transferred` — a map transfer took the character mid-move (an areatrigger
  portal, a cross-map port); the server applies the destination itself. `pos`
  is the last old-map position; the new map and arrival point follow on
  `SMSG_NEW_WORLD`.
- `teleported` — a same-map teleport took the character mid-move (Hearthstone,
  a graveyard port on the same map). No map change is coming and no
  `SMSG_NEW_WORLD` will follow; `pos` is the pre-teleport position and the
  arrival point is the `MSG_MOVE_TELEPORT_ACK` observed-movement event (own
  guid), which the server sends before this result.
- `interrupted` — the move stopped early (death, rejection, or the
  character left the map for a non-teleport reason); `pos` is where the
  character actually is.
- `stopped` — a `stop` action ended the move.
- `falling` — the character's body is falling (move_to, "Flying"): a
  refusal, nothing sent, no `pathLength`. Move once it has landed.
- `cannot_fly` — `fly` was asked of a character the server has not told
  it can fly: a refusal, nothing sent, no `pathLength`.
- `superseded` — a newer `move_to` replaced this move.
- `controlling` — the core holds a mover for this client (a vehicle, a
  possessed unit: "Vehicles and possession", below), named by `mover`
  (guid-string), that is not in the character's map, so no packet can drive
  it: a refusal with no `pathLength` and nothing sent. A walk still running
  when control changes hands ends the same way, with its `pathLength`, where
  its unit stood. Every other verdict of a walk of another unit carries
  `mover` too, with `pos` that unit's, and `flight: true` when the leg was
  flown.
- `stunned` — a stun holds the unit the client moves (Roots, below): as
  `rooted` in every respect, refusal or stopped walk, under its own name.
- `rooted` — a root holds the character (Roots, below). A
  refusal: the `move_to` arrived while the character was rooted and nothing
  was sent; it carries no `pathLength`. A walk the root stopped: the root ack
  was its stop, at the point the walk had reached, and the verdict carries
  the walk's `pathLength` like any other dispatched move. Its `pos` is read
  back as always, and the server applies the ack on the session's next
  update, after the verdict, so `pos` can trail the point the walk stopped
  at by up to one heartbeat's walk (about 3.5y at run speed). Death roots
  too, but a walk the character dies on ends `interrupted`.

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
through the mesh and answers `start_off_mesh` / `target_off_mesh`. A
disembarking leg ends at the ground height under the requested x,y (terrain,
vmap and model geometry a client has too), not at the z asked for: a
client's character drops from the deck to the platform, and a leg left to
end at the deck height put the character in the air over the platform and
off the mesh for its next move. When that height differs from the request
by more than 1y the arrival carries `meshZ`, as a mesh-corrected arrival
does, and the `move_transport_leg` audit record carries `z` and `groundZ`. A
move that ends aboard reports `onTransport`; while aboard and idle, the server
moves the character and the module reports where it is as
`WB_RIDE_PROGRESS`. No "activate transport" action exists: boarding is
walking onto the car.

The car itself is observable the way a client sees it: a
transport's create block serves `goType` 11 and `pathProgress`, the module
asks `CMSG_GAMEOBJECT_QUERY` for its name like any other game object, and
`WB_TRANSPORT_PROGRESS` keeps its position and `docked` state current from
the same `TransportAnimation.dbc` the client animates from (the server's
`StaticTransport::RelocateToProgress` runs the same keyframes) while the car
is within the map's visibility range or carrying the character. The core
sends every transport on the map at login, so a character in Westfall knows
of every ship and zeppelin on the continent; reporting each one's clock every
second flooded the event stream for nothing a character there could use. A
car at the character's platform, or pulling in to it, is in range. The agent
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
player action. The test runs on every position the character has, however it
got there, as a client's does every frame: the mover's interpolated point
while a `move_to` is in progress, and otherwise the server's own position for
the character once per world tick — a transport carrying it, a teleport's
arrival inside an inn, a taxi landing — against the same per-session set, so
nothing fires twice and no heartbeat is owed when the tested position is
already the server's. The server ignores `CMSG_AREATRIGGER` while the
character is in flight (`HandleAreaTriggerOpcode`), so nothing is tested or
sent mid-flight and a volume the landing lies in is reported at the landing,
against the set as it stood at takeoff. The server's own radius check rejects
any hit the test got wrong.

Taxi landing. The server ends a flight with a stop at
the path's last point (`FlightPathMovementGenerator::DoFinalize`:
`StopMoving`, then `UNIT_FLAG_TAXI_FLIGHT` off), which is the flight
altitude over the node, a few yards above the ground. A client then has
control back, its physics drop the character to the ground and it sends
`MSG_MOVE_FALL_LAND` there — the server's next authoritative position (the
fall is measured from the `SetFallInformation` the finalize left, so a node's
few yards never hurt). On the first world tick that reads the flag off, the
module does the same from the same knowledge: the ground under x,y from the
terrain and vmap (`Map::GetHeight`), sent as `MSG_MOVE_FALL_LAND` and
reported as `WB_SELF_MOVE` with `cause: "taxi_landing"` (audited as a
`move_pkt` with the same cause, after a `taxi_landing` audit record carrying
`splineZ`, `groundZ` and `snapped`). The drop is bounded at 10y: a surface
farther below is not what a client falls to from a flight node, so the
server's position stands, `snapped` is false and no packet is sent. The
areatrigger test then runs at the landing position.

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
carries ids with empty names). The map is named the same way: `Map.dbc`,
loaded beside it (3.3.5a layout: 66 fields, 264-byte records; `id`, the
internal directory name, `InstanceType` at field 2, …, enUS `name` at field
5 — any other shape is refused with an error and the map fields are left
out), gives the name a client shows for the map id `SMSG_LOGIN_VERIFY_WORLD`
and `SMSG_NEW_WORLD` already carry, and the `InstanceType` the client reads
from the same row to know it has entered an instance. Once per world tick, for every in-world
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
| `SMSG_ATTACKSWING_NOTINRANGE` | 0x145 | `{}` — a ready melee swing was refused: the victim is out of melee range (see the latch note below) |
| `SMSG_ATTACKSWING_BADFACING` | 0x146 | `{}` — a ready melee swing was refused: the victim is outside the attacker's front arc |
| `SMSG_SPELL_START` | 0x131 | compact: `{ "casterGuid", "spellId", "castTimeMs", "targetGuid"? }` |
| `SMSG_SPELL_GO` | 0x132 | compact: `{ "casterGuid", "spellId", "hitGuids": [<guid-string>], "misses": [{ "guid", "reason": <u8> }], "runesBefore"?, "runesAfter"?, "runesSpent"?: [{ "index", "passed" }] }` — the rune fields only on a player's cast carrying `CAST_FLAG_RUNE_LIST` (a Death Knight's rune spend or rune activation; `Spell::SendSpellGo`): the ready-rune bit masks before and after the cast (bit n is rune slot n) and, per rune spent, the part of its cooldown passed, 0-255. It is the one packet that says which runes a cast spent; read past the cast targets and the power left, in a guard of its own so a surprise drops the rune fields alone |
| `SMSG_CAST_FAILED` | 0x130 | `{ "spellId", "result": <u8> }` (SpellCastResult code) |
| `SMSG_SPELL_FAILURE` | 0x133 | `{ "casterGuid", "spellId", "result": <u8> }` |
| `SMSG_SPELL_DELAYED` | 0x1E2 | `{ "casterGuid", "delayMs" }` — a cast in range pushed back by damage (`Spell::Delayed`); the client's cast bar, and `state.self.casting.endsAt` for our own, move back by `delayMs`. A channel's pushback is `MSG_CHANNEL_UPDATE` |
| `SMSG_PERIODICAURALOG` | 0x24E | compact: `{ "targetGuid", "casterGuid", "spellId", "auraType": <u32>, "amount" }` |
| `SMSG_SPELLNONMELEEDAMAGELOG` | 0x250 | `{ "targetGuid", "casterGuid", "spellId", "rank"?, "name"?, "damage", "overkill", "schoolMask": <u8>, "absorb", "resist", "blocked", "hitInfo": <u32>, "crit": <bool> }` — one direct spell hit (`Unit::SendSpellNonMeleeDamageLog`, and the reflect form `SendSpellNonMeleeReflectLog`); `schoolMask` is the `SpellSchoolMask` bit set (1 physical, 2 holy, 4 fire, 8 nature, 16 frost, 32 shadow, 64 arcane), `hitInfo` the raw `SpellHitType` and `crit` its `SPELL_HIT_TYPE_CRIT` bit; `physicalLog`, the unused byte and the debug flag are consumed |
| `SMSG_SPELLHEALLOG` | 0x150 | `{ "targetGuid", "casterGuid", "spellId", "rank"?, "name"?, "amount", "overheal", "absorb", "crit": <bool> }` — one direct heal (`Unit::SendHealSpellLog`); `amount` is the whole heal, `overheal` the part past full health |
| `SMSG_SPELLENERGIZELOG` | 0x151 | `{ "targetGuid", "casterGuid", "spellId", "rank"?, "name"?, "powerType": <u32>, "amount" }` — one power gain from a spell (`Unit::SendEnergizeSpellLog`); `powerType` 0 mana, 1 rage, 2 focus, 3 energy, 4 happiness, 5 runes, 6 runic power |
| `SMSG_SPELLORDAMAGE_IMMUNE` | 0x263 | `{ "casterGuid", "targetGuid", "spellId", "rank"?, "name"? }` — "Immune" in the combat log (`Unit::SendSpellDamageImmune`): the target was immune to the caster's spell; the debug-format byte is consumed |
| `SMSG_ENVIRONMENTAL_DAMAGE_LOG` | 0x1FC | `{ "victimGuid", "type": <u8>, "amount", "resist", "absorb" }` — damage from the world (`Player::EnvironmentalDamage`): `type` 0 fatigue, 1 drowning, 2 falling (a fall into the void is sent as 2), 3 lava, 4 slime, 5 fire |
| `SMSG_AURA_UPDATE` | 0x496 | `{ "targetGuid", "auras": [<aura>] }` |
| `SMSG_UPDATE_COMBO_POINTS` | 0x39D | `{ "targetGuid", "points": <u8> }` — the combo points held and on whom (`"0"` for no one); `Unit::SendComboPoints`, to the player alone, on every change |
| `SMSG_CONVERT_RUNE` | 0x486 | `{ "index": <u8>, "runeType": <u8> }` — Death Knight rune slot 0-5 became `RuneType` 0 blood, 1 unholy, 2 frost, 3 death (`Player::ConvertRune`). `SMSG_RESYNC_RUNES` and `SMSG_ADD_RUNE_POWER` have no caller at the pinned commit; readiness rides `SMSG_SPELL_GO` |
| `MSG_CHANNEL_START` | 0x139 | `{ "casterGuid", "spellId", "rank"?, "name"?, "durationMs" }` — a unit in range began a channel (`Spell::SendChannelStart`, after the spell's `SMSG_SPELL_GO`) |
| `MSG_CHANNEL_UPDATE` | 0x13A | `{ "casterGuid", "timeMs" }` — the channel's time left after a pushback; 0 is its end, interrupted or run out (`Spell::SendChannelUpdate`) |
| `SMSG_TOTEM_CREATED` | 0x413 | `{ "slot": <u8>, "guid", "durationMs", "spellId", "rank"?, "name"? }` — one of our totems (`Totem::InitStats`): `slot` 0 fire, 1 earth, 2 water, 3 air, the number raw `CMSG_TOTEM_DESTROYED` takes |
| `SMSG_START_MIRROR_TIMER` | 0x1D9 | `{ "type", "value", "max", "scale": <i32>, "paused": <bool>, "spellId" }` — a breath (1), fatigue (0) or fire (2) bar at `value` of `max` ms, moving by `scale` ms per ms (-1 draining, 10 refilling); `Player::SendMirrorTimer`, sent on a change only. `SMSG_PAUSE_MIRROR_TIMER` has no caller at the pinned commit |
| `SMSG_STOP_MIRROR_TIMER` | 0x1DB | `{ "type" }` — that bar is gone: refilled, or the character died |
| `SMSG_AURA_UPDATE_ALL` | 0x495 | same shape, full visible-aura list |

`<aura>` is `{ "slot": <u8>, "spellId": <u32>, "flags"?, "level"?, "stacks"?,
"casterGuid"?, "maxDuration"?, "duration"?, "name"? }`; `spellId` 0 means the slot was
cleared and the entry carries `"removed": true` instead of the optional fields.
Durations are in ms and present only when the aura shows one (`flags & 0x20`);
`duration` is what was left when the packet was sent. `name` is the client's
Spell.dbc name for the id, the one its buff frame shows (client-cache
knowledge, as on the spellbook rows); absent when the core has no name for it.

Spell combat log. `SMSG_SPELLNONMELEEDAMAGELOG`, `SMSG_SPELLHEALLOG` and
`SMSG_SPELLENERGIZELOG` are the combat-log lines a client prints for a direct
spell hit, heal or power gain; the core sends each to every client in range
(`SendMessageToSet`), so a session sees the spell fights around it, not only
its own. Both guids precede the spell id with the *target first*, unlike the
melee log. `rank` and `name` are the client's Spell.dbc reading of the id,
as on the spellbook rows (`AddSpellFields`), absent when the core has no
entry for it. Field names follow the melee log's (`absorb`, `resist`,
`blocked`). Periodic ticks stay on `SMSG_PERIODICAURALOG`.

Swing errors. `SMSG_ATTACKSWING_NOTINRANGE` and `SMSG_ATTACKSWING_BADFACING`
are the two packets a client shows as on-screen errors while auto-attack is
armed and no swing can land. Both are bodiless on the wire
(`Player::SendAttackSwingNotInRange`, `Player::SendAttackSwingBadFacingAttack`),
so `data` is `{}`: the packet names no victim and no distance, and the module
adds none. They go to the attacking player only, raised in `Player::Update`
when the main-hand swing comes ready and fails a check: range first
(`IsWithinMeleeRange`), then facing (the victim outside the 120° front arc,
and only when the attacker is not standing inside the victim's boundary
radius, where facing is not checked at all). The refused swing is retried
every 100 ms; melee stays armed and no `SMSG_ATTACKSTOP` follows.

The core latches them (`m_swingErrorMsg`), and a consumer has to know how:

- One event per change of error state, not one per refused swing. Out of
  range for ten seconds is one `SMSG_ATTACKSWING_NOTINRANGE`; moving into
  range with the back turned is then one `SMSG_ATTACKSWING_BADFACING`.
- Nothing is sent when the error clears. The latch resets only when a swing
  passes both checks (the swing itself then arrives as
  `SMSG_ATTACKERSTATEUPDATE`, hit or miss) or at login. `attack_stop` and a
  change of target do not reset it.
- So silence proves nothing. A second out-of-range attack after an earlier one
  that never swung sends no packet at all, and the absence of either event
  does not mean the character is in range or facing its target. Only a swing
  does.

The module forwards what the wire carries and synthesizes no "cleared" event.
The siblings `SMSG_ATTACKSWING_DEADTARGET` (0x148) and
`SMSG_ATTACKSWING_CANT_ATTACK` (0x149) are not whitelisted: at the pinned
commit their senders have no callers, so there is nothing to forward. An
attack on an invalid target is answered with `SMSG_ATTACKSTOP`, above.

Progress:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_LOG_XPGAIN` | 0x1D0 | `{ "victimGuid" ("0" for non-kill), "amount", "fromKill": <bool> }` |
| `SMSG_PARTYKILLLOG` | 0x1F5 | `{ "killerGuid", "victimGuid" }` — `Unit::Kill`: the player who landed the killing blow on a kill that rewards a player, broadcast to the killer's party (its subgroup in a raid), or sent to the killer alone when it has no group. `killerGuid` may be another member; nothing else about the kill is carried |
| `SMSG_LEVELUP_INFO` | 0x1D4 | `{ "level", "healthGained" }` |
| `SMSG_EXPLORATION_EXPERIENCE` | 0x1F8 | `{ "areaId", "areaName", "xp" }` — "Discovered <area>" (`Player::SendExplorationExperience`): the XP it gave, 0 at the level cap or for an area worth none; `areaName` is the client's `AreaTable.dbc` text, `""` when it has no row |
| `SMSG_ITEM_PUSH_RESULT` | 0x166 | `{ "playerGuid", "itemId", "count", "totalCount", "bagSlot", "itemSlot", "looted": <bool>, "created": <bool> }` |

Quests and gossip (quest/gossip text served as the client would show it):

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_QUESTGIVER_STATUS` | 0x183 | `{ "guid", "status": <u8> }` |
| `SMSG_QUESTGIVER_STATUS_MULTIPLE` | 0x418 | `{ "statuses": [{ "guid", "status": <u8> }] }` — every questgiver in view; sent by the core on login, level-up and quest reward, and in answer to `questgiver_status_multiple_query`. Status values are `DIALOG_STATUS_*` (0 none, 1 unavailable, 2 low-level available, 3 low-level reward-rep, 4 low-level available-rep, 5 incomplete, 6 reward-rep, 7 available-rep, 8 available, 9 reward2 (no minimap dot), 10 reward); the SDK names them |
| `SMSG_QUEST_QUERY_RESPONSE` | 0x05D | `{ "questId", "method", "level", "minLevel", "type", "suggestedPlayers", "flags", "title", "objectives", "details", "areaDescription", "completedText", "requiredNpcOrGo": [4 x { "entry", "count", "text" }], "requiredItems": [6 x { "itemId", "count" }] }` — decoded from `PlayerMenu::SendQuestQueryResponse` in this order: questId, method, level, minLevel, zoneOrSort, type, suggestedPlayers, rep objective faction/value x2, nextQuestInChain, xpId, rewMoney, rewMoneyMaxLevel, rewSpell, rewSpellCast, honor addition/multiplier, srcItem, flags, charTitle, playersSlain, bonusTalents, arenaPoints, repMask, 4+6 reward (item,count) pairs, 3x5 reputation ids, POI continent/x/y/pointOpt, then the five strings, then 4 x (requiredNpcOrGo, count, itemDrop, 0), 6 x (requiredItem, count), 4 x objective text (joined into `requiredNpcOrGo[i].text`). A gameobject objective arrives as `entry \| 0x80000000`, as the client expects. `flags` is the template's `QUEST_FLAGS_*` word served raw, as the wire carries it (the core sends `Flags & 0xFFFF`); `0x4` is `QUEST_FLAGS_EXPLORATION`, which the SDK reads for an exploration objective, and `areaDescription` is that objective's line of text. Reward fields are consumed and not served (they ride `QUEST_DETAILS`/`OFFER_REWARD` when the client asks) |
| `SMSG_QUEST_POI_QUERY_RESPONSE` | 0x1E4 | `{ "quests": [{ "questId", "pois": [{ "poiId", "objectiveIndex": <i32>, "map", "worldMapAreaId", "floor", "priority", "flags", "points": [{ "x": <i32>, "y": <i32> }] }] }] }` — the answer to a raw `CMSG_QUEST_POI_QUERY` (`WorldSession::HandleQuestPOIQuery`): the objective areas a client shades on its world map and quest tracker, served whole. One row per distinct quest id asked, in no particular order (the handler dedupes through an `unordered_set`); `pois` is empty both for a quest not in the log and for one with no areas. `objectiveIndex` -1 is the turn-in. `points` are a polygon's corners in world x/y, with no z; `worldMapAreaId` and `floor` name the client's `WorldMapArea.dbc` page, and `priority` and `flags` are the core's `Unk3`/`Unk4`. A query naming more than 25 (`MAX_QUEST_LOG_SIZE`) quests is dropped unanswered |
| `SMSG_QUESTGIVER_QUEST_LIST` | 0x185 | `{ "guid", "greeting", "quests": [{ "questId", "icon", "level", "repeatable", "title" }] }` |
| `SMSG_QUESTGIVER_QUEST_DETAILS` | 0x188 | `{ "guid", "questId", "title", "details", "objectives", "choiceRewards": [{ "itemId", "count" }], "rewards": [...], "money", "xp" }` |
| `SMSG_QUESTGIVER_REQUEST_ITEMS` | 0x18B | `{ "guid", "questId", "title", "text", "requiredMoney", "requiredItems": [{ "itemId", "count" }], "completable": <bool> }` |
| `SMSG_QUESTGIVER_OFFER_REWARD` | 0x18D | `{ "guid", "questId", "title", "text", "choiceRewards": [...], "rewards": [...], "money", "xp" }` |
| `SMSG_QUESTGIVER_QUEST_COMPLETE` | 0x191 | `{ "questId", "xp", "money" }` |
| `SMSG_QUESTGIVER_QUEST_FAILED` | 0x192 | `{ "questId", "reason" }` |
| `SMSG_QUESTUPDATE_ADD_KILL` | 0x199 | `{ "questId", "entry", "current", "required", "guid" }` (gameobject credit arrives with `entry | 0x80000000`) |
| `SMSG_QUESTUPDATE_ADD_ITEM` | 0x19A | `{}` — the core sends it empty; item progress is in the quest-log update fields |
| `SMSG_QUESTUPDATE_COMPLETE` | 0x198 | `{ "questId" }` — an exploration or scripted-event objective credited: its only sender is `Player::AreaExploredOrEventHappens`, once per accept, when the server-only `Explored` flag flips, whether or not the rest of the quest is done. NOT sent for kill/item objectives at the pinned commit; read completion from the quest-log `State` complete bit or the final `ADD_KILL` with `current == required` |
| `SMSG_QUESTUPDATE_FAILED` | 0x196 | `{ "questId" }` |
| `SMSG_QUESTLOG_FULL` | 0x195 | `{}` — bodiless: the quest log's 25 slots are taken, so an accept (or an auto-accept on a hello or query) added nothing (`Player::SatisfyQuestLog`); the client shows "Quest log is full." The refused quest is not named |
| `SMSG_QUESTGIVER_QUEST_INVALID` | 0x18F | `{ "reason": <u32> }` — why a quest cannot be taken (`Player::SendCanTakeQuestResponse`, from `CanTakeQuest` on an accept or on a quest-start item's query): the raw `QuestFailedReason` (0 requirements not met, 1 level too low, 6 wrong race, 7 already done, 12 one timed quest at a time, 13/18 already in the log, 21 missing items, 23 not enough money, 26/29 daily limits). The quest is not named; nothing is added to the log |
| `SMSG_GOSSIP_MESSAGE` | 0x17D | `{ "guid", "menuId", "textId", "options": [{ "optionId", "icon", "text", "coded": <bool>, "boxMoney"?: <u32 copper>, "boxText"?: <string> }], "quests": [{ "questId", "icon", "level", "title" }] }` |
| `SMSG_GOSSIP_COMPLETE` | 0x17E | `{}` |
| `SMSG_NPC_TEXT_UPDATE` | 0x180 | `{ "textId", "texts": [{ "probability": <float>, "text", "textFemale", "language" }] }` — the gossip window's body text, the answer to a raw `CMSG_NPC_TEXT_QUERY` (`u32 textId, u64 npc guid`) on the `textId` `SMSG_GOSSIP_MESSAGE` names (`WorldSession::HandleNpcTextQueryOpcode`). Of the eight slots, those with text are served; a client shows one, picked by `probability`, the male or female form by the reader's gender, `$N` being the reader's name. An unknown id answers the core's "Greetings $N" default. The emote animations are consumed |

Loot, vendor, inventory:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_LOOT_RESPONSE` | 0x160 | `{ "guid", "lootType": <u8>, "gold", "items": [{ "slot", "itemId", "count", "slotType": <u8> }] }` (slotType 0 = free to loot). The refusal form, `Player::SendLootError`, is the same opcode with `lootType` 0 (`LOOT_NONE`) and a one-byte `LootError` in place of gold and items: `{ "guid", "lootType": 0, "error": <u8> }` — 0 didn't kill / not yours, 4 too far, 5 bad facing, 6 someone else is looting it, 8 not standing, 9 stunned, 10 player not found, 11 play time exceeded, 12–14 master-loot assignment refused (bags full, unique item, other), 15 already pickpocketed, 16 shapeshifted. No window opens and no release follows; a pending `loot_all` replay is dropped |
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
knowledge, like item-template fields. A spellbook row (`SMSG_INITIAL_SPELLS`,
`SMSG_LEARNED_SPELL`, `SMSG_SUPERCEDED_SPELL`, written `…` below) also
carries the stance facts of the same Spell.dbc row, each absent when the row
has none: `stances`, the shapeshift form ids the spell may be cast in (its
`Stances` mask, bit n-1 = form n, as `SpellInfo::CheckShapeshift` reads it);
`stancesNot`, the forms it may not be cast in (`StancesNot`); and `form`, the
form a form-changing spell puts the caster in (the misc value of its
`SPELL_AURA_MOD_SHAPESHIFT` effect: Battle Stance 17, Defensive Stance 18,
Cat Form 1, Stealth 30, …). They are read from the DBC store a client has, not
from the server's corrected `SpellInfo`, so a `stances` list joined to the
book's `form` rows names the stance an `only_shapeshift` refusal wants. Some
spells may also be cast in no form at all, which the mask does not say (the
core's `SPELL_ATTR2_ALLOW_WHILE_NOT_SHAPESHIFTED`):

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_INITIAL_SPELLS` | 0x12A | `{ "spells": [{ "spellId", "rank"?, "name"?, … }], "cooldowns": [{ "spellId", "itemId", "category", "cooldownMs", "categoryCooldownMs" }] }` — the whole active-spec spellbook, sent during login before `SMSG_LOGIN_VERIFY_WORLD`; a category cooldown carries its time in `categoryCooldownMs` and 0 in `cooldownMs`; `categoryCooldownMs` 0x80000000 with `cooldownMs` 1 is the core's "infinite" marker |
| `SMSG_LEARNED_SPELL` | 0x12B | `{ "spellId", "rank"?, "name"?, … }` |
| `SMSG_REMOVED_SPELL` | 0x203 | `{ "spellId" }` |
| `SMSG_SUPERCEDED_SPELL` | 0x12C | `{ "supersededSpellId", "spellId", "rank"?, "name"?, … }` — the old rank leaves the book, `spellId` replaces it (a `SMSG_LEARNED_SPELL` for the new id follows) |
| `SMSG_SPELL_COOLDOWN` | 0x134 | `{ "guid", "flags": <u8>, "cooldowns": [{ "spellId", "cooldownMs" }] }` — cooldowns that just started for `guid` (self or pet); `flags & 1` = the GCD was triggered too; a 0 ms entry is a GCD-only marker |
| `SMSG_COOLDOWN_EVENT` | 0x135 | `{ "spellId", "guid" }` — "start the timer you already know for this spell": the duration is Spell.dbc knowledge the module does not serve |
| `SMSG_CLEAR_COOLDOWN` | 0x1DE | `{ "spellId", "guid" }` |
| `SMSG_TALENTS_INFO` | 0x4C0 | `{ "pet": false, "unspentPoints", "specCount", "activeSpec", "specs": [{ "talents": [{ "talentId", "rank" }], "glyphs": [{ "slot", "glyphId", "spellId"?, "name"? }] }] }` — `rank` is 0-based; `glyphs` are the spec's six glyph slots, slot = index, `glyphId` the `GlyphProperties.dbc` id (0 empty) with the glyph's spell and its `Spell.dbc` name beside it. The pet form is `{ "pet": true }` only (the pet bar itself is `SMSG_PET_SPELLS`; pet talents have not been asked for). Sent on login, level-up, after every `CMSG_LEARN_TALENT`, on spec change, and after a successful talent reset |
| `MSG_TALENT_WIPE_CONFIRM` | 0x2AA | `{ "guid", "cost": <u32 copper>, "nothingToReset": <bool> }` — the trainer's "unlearn all talents?" dialog (`Player::SendTalentWipeConfirm`) after its unlearn gossip option; a client answers yes by echoing the opcode with the guid (raw). `nothingToReset` is the guid-0/cost-0 form `HandleTalentWipeConfirmOpcode` sends back when there are no talents to reset or the money is short; a successful reset has no packet of its own — `SMSG_TALENTS_INFO` follows with every rank gone |
| `WB_TALENT_TREE` | 0xFF08 | `{ "class": <u8>, "unspentPoints": <u32>, "tabs": [{ "tabId", "name"?, "page", "talents": [{ "talentId", "name"?, "row", "col", "maxRank", "ranks": [<spellId> × maxRank], "dependsOn"?, "dependsOnRank"? }] }] }` — the answer to the `talent_tree` action: every TalentTab.dbc tab whose class mask holds the character's class, in page order, and every Talent.dbc row in it sorted by row then column. `name` on a tab is the client's TalentTab.dbc text (the module reads the file: `dbc/TalentTab.dbc`, 24 fields, record size 96, refused otherwise), on a talent the first rank spell's Spell.dbc name; `dependsOnRank` is 0-based. What the talent frame draws, nothing more — no icons, no tooltips, and no server-side state (the ranks learned are `SMSG_TALENTS_INFO`'s, joined by the SDK) |

The cooldown opcodes rarely fire. A client derives a cooldown from its own
Spell.dbc, so the core sends only what it cannot derive. For a player's own
cast, `Player::AddSpellAndCategoryCooldowns` sends `SMSG_SPELL_COOLDOWN` only
when a `SPELL_AURA_MOD_COOLDOWN` aura changed the recovery of a spell the
player knows, plus the category siblings of the few spells the core
force-flags (Aimed Shot). Neither level nor item changes that: a Hearthstone
use is answered with `SMSG_SPELL_START`, `SMSG_SPELL_GO` and
`MSG_MOVE_TELEPORT_ACK` and no cooldown opcode, though the server holds its
30-minute cooldown. The packet's other senders are pets and vehicles, the
school lockout after an interrupt, and a GCD-only marker for a weapon swap in
combat. `SMSG_COOLDOWN_EVENT` is for a cooldown that starts when an effect
ends: a potion, whose timer waits for the end of combat, and a
cooldown-on-event spell such as Stealth, when its aura is removed (read from
the core, not yet observed). A cooldown started without a packet still
persists through a logout and comes back at the next login in
`SMSG_INITIAL_SPELLS.cooldowns[]`, which is where a relog after a Hearthstone
reads its remaining time.

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
| `SMSG_PARTY_MEMBER_STATS` | 0x07E | `{ "guid", "full": false, "mask": <u32>, "status"?: <u16>, "health"?, "maxHealth"?, "powerType"?: <u8>, "power"?, "maxPower"?, "level"?, "zoneId"?, "zoneName"?, "x"?: <i16>, "y"?: <i16>, "auras"?: [{ "slot", "spellId", "flags": <u8>, "name"? }] }` — the party frame of a member out of sight: `Group::UpdatePlayerOutOfRange` sends `WorldSession::BuildPartyMemberStatsChangedPacket` once per update of that member to every other member out of its sight range or on another map, carrying only the fields whose bit is set in `mask` (`GROUP_UPDATE_FLAG_*`: 0x1 status, 0x2 health, 0x4 max health, 0x8 power type, 0x10 power, 0x20 max power, 0x40 level, 0x80 zone, 0x100 position, 0x200 auras; 0x400–0x40000 the pet's, 0x80000 a vehicle seat). The core sets each bit when that value changes and sets every bit on a group join, on a zone change and on every teleport, map transfer and resurrection (`Player::UpdateZone`), so status arrives only with those. `status` is `MEMBER_STATUS_*`: 0x1 online, 0x2 PvP, 0x4 dead, 0x8 ghost, 0x10 FFA PvP, 0x40 AFK, 0x80 DND. `x`, `y` are the member's position truncated to whole yards in 16 bits, read signed; the packet names no map. `zoneName` is the client's `AreaTable.dbc` name for `zoneId`. In a delta an aura entry with `spellId` 0 clears that slot; `flags` is the `AFLAG_*` byte (the delta always writes 1 for the member's own auras); `name` is the Spell.dbc name, as on `SMSG_AURA_UPDATE`. The pet and vehicle fields are not decoded (`mask` still shows them). Nothing is sent to a member in sight: its unit update fields carry the same values |
| `SMSG_PARTY_MEMBER_STATS_FULL` | 0x2F2 | same shape with `"full": true` — `HandleRequestPartyMemberStatsOpcode`'s answer to `CMSG_REQUEST_PARTY_MEMBER_STATS` (raw, above): every field, the auras as the complete list of visible ones with their real flags, and `powerType` only when the power is not mana (0). A guid the server cannot find in the party is answered `{ "mask": 1, "status": 0 }`, offline |
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
guilds, battlegrounds, dual spec and equipment sets, until
single-player play is validated; docs/CONTRACTS.md).

Achievements and flight paths ([Shard/WrathBench#8](https://github.com/Shard/WrathBench/issues/8) first half):

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_ACHIEVEMENT_EARNED` | 0x468 | `{ "guid", "self": <bool>, "achievement": { "achievementId", "date": <u32>, "time": "YYYY-MM-DD HH:MM", "name"?, "points"?, "categoryId"? } }` — the core broadcasts this in say range, so `guid` may be another player's; `self` is the equality with the session's own guid, nothing more |
| `SMSG_ALL_ACHIEVEMENT_DATA` | 0x47D | `{ "count", "achievements": [ <same achievement object> ] }` — sent to self once during login: every achievement already earned. Only the completed block (to its 0xFFFFFFFF terminator) is decoded; the criteria-progress block that follows is consumed and not served |
| `SMSG_ACTIVATETAXIREPLY` | 0x1AE | `{ "reply": <u32>, "ok": <bool> }` — the answer to `CMSG_ACTIVATETAXI[EXPRESS]` (raw). `ActivateTaxiReply`: 0 ok, 1 server error, 2 no such path, 3 not enough money, 4 too far away, 5 no vendor nearby, 6 not visited, 7 busy, 8 mounted, 9 shapeshifted, 10 moving, 11 same node, 12 not standing |
| `SMSG_SHOWTAXINODES` | 0x1A9 | `{ "showWindow": <bool>, "guid", "currentNode": <u32>, "currentNodeName"?: <str>, "currentPos"?: { "map": <u32>, "x","y","z" }, "mask": [<u32> × 14], "known": [{ "nodeId": <u32>, "name"?: <str>, "map"?: <u32>, "x"?, "y"?, "z"? }] }` — the flight master's window (`WorldSession::SendTaxiMenu`), sent when the taxi option of the master's gossip menu is chosen: the leading u32 (1 = show), the master's guid, the node it stands at, and the character's taximask verbatim (`TaxiMaskSize` 14 words; node *n* is bit `(n-1)%32` of word `(n-1)/32`). `known` is that mask decoded — the nodes this character has visited, the only destinations the server will sell (and only one flight path away: `CMSG_ACTIVATETAXI` to a farther one gets no reply) — each named and placed as the client names and draws it from its own `TaxiNodes.dbc` row (the name, map and position are absent together when the file is not loaded). Only the mask's nodes are served: a client's flight map draws the nodes it has discovered. No route or fare is served |
| `SMSG_TAXINODE_STATUS` | 0x1AB | `{ "guid", "known": <bool> }` — whether this character has discovered the node of flight master `guid`, its map icon: the answer to raw `CMSG_TAXINODE_STATUS_QUERY` (`u64 guid`; `WorldSession::SendTaxiStatus`), for every flight master in view (`Player::SendTaxiNodeStatusMultiple`), and after a discovery |
| `SMSG_NEW_TAXI_PATH` | 0x1AF | `{}` — a flight path was learned (`WorldSession::SendLearnNewTaxiNode`, `SendDiscoverNewTaxiNode`) |

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
inferred from the server's taxi state. The position after the landing is the
`WB_SELF_MOVE` the module sends for the client's drop to the ground ("Taxi
landing", above), which follows the flip within a world tick. `SMSG_CRITERIA_UPDATE` (0x46A) and
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
same rows carry are served beside the names (`map`, `x`, `y`, `z` on each
known node and `currentPos` for the master's own): the client draws its
flight map from exactly those rows, so they pass the test the names pass.
`TaxiPath.dbc` is never read: which nodes connect, and for how much, the
character learns by asking (`CMSG_ACTIVATETAXI` with the window's current
node and a known node, body `u64 guid, u32 from, u32 to`, through raw; or
`CMSG_ACTIVATETAXIEXPRESS`, body `u64 guid, u32 count, u32 node × count`
starting at the current node, for a chain of hops the client names itself —
the server flies the whole chain, charging each leg as it starts). A pair of
known nodes no single path joins gets no reply at all
(`Player::ActivateTaxiPathTo` returns without one); nothing stands in for it.

Innkeeper bind — the sequence a client runs
when "Make this inn your home." is chosen:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_BINDER_CONFIRM` | 0x2EB | `{ "guid" }` — the innkeeper asks; a client shows a yes/no dialog and answers yes with `CMSG_BINDER_ACTIVATE` (raw, body `u64 guid`) |
| `SMSG_BINDPOINTUPDATE` | 0x155 | `{ "x", "y", "z", "map": <u32>, "areaId": <u32>, "areaName": <str> }` — where the hearthstone goes: once during login (`Player::SendInitialPacketsBeforeAddToMap`) and again after every bind (`Spell::EffectBind`). `areaName` is the client's `AreaTable.dbc` text for the id, `""` when it has no row |
| `SMSG_PLAYERBOUND` | 0x158 | `{ "guid", "areaId", "areaName" }` — the "your home is now …" line; `guid` is the binder |

The server declines a bind silently (not an innkeeper, out of range, dead,
inside an instance): no packet follows the confirm, and the SDK reports that
as the absence of an answer, never as a status. `SMSG_PLAYERBINDERROR` exists
in the opcode table but the core never sends it (`STATUS_NEVER`, no builder),
so nothing stands in for it; likewise `SMSG_RESURRECT_FAILED`, so a
resurrection the server ignores is told by its absence too.

Client queries and proficiencies:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_PLAYED_TIME` | 0x1CD | `{ "totalSec", "levelSec", "show": <bool> }` — the answer to raw `CMSG_PLAYED_TIME` (`u8 show`): time played in total and at this level |
| `SMSG_QUERY_TIME_RESPONSE` | 0x1CF | `{ "serverTime", "dailyResetInSec" }` — the answer to raw `CMSG_QUERY_TIME` (empty): the server's clock in unix seconds and the seconds until the daily quests reset |
| `SMSG_SET_PROFICIENCY` | 0x127 | `{ "itemClass": <u8>, "subclassMask" }` — the item subclasses this character can use for one item class, 2 weapon or 4 armour, the whole mask each time (`Player::SendProficiency`, on learning a proficiency; the reattach replay re-sends both) |

#### Death

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_DEATH_RELEASE_LOC` | 0x378 | `{ "map" (-1 = clear marker), "x", "y", "z" }` |
| `SMSG_CORPSE_RECLAIM_DELAY` | 0x269 | `{ "delayMs" }` |
| `SMSG_DURABILITY_DAMAGE_DEATH` | 0x2BD | `{}` |
| `SMSG_RESURRECT_REQUEST` | 0x15B | `{ "casterGuid", "casterName"?, "sickness": <bool> }` — `Spell::SendResurrectRequest`, to a dead character someone is resurrecting: the caster, its name only when the packet carries one (a creature caster; a player caster is sent with an empty name, which a client looks up by guid), and whether accepting brings resurrection sickness (true for a creature caster). The wire is `u64 caster, u32 name length, that many bytes of name (its NUL included), u8 0, u8 sickness`, then a `u32 0` only for a spell that skips the reclaim timer; the padding byte and that trailing u32 are consumed. Answered with `CMSG_RESURRECT_RESPONSE` (raw, below) |
| `MSG_CORPSE_QUERY` | 0x216 | `{ "found": <bool>, "map"?, "x"?, "y"?, "z"?, "corpseMap"? }` — the server's answer to the ghost's corpse query (`HandleCorpseQueryOpcode`); position fields only when `found`. `map`/`x`/`y`/`z` is where a client draws the corpse marker, `corpseMap` the map the corpse is actually on; they differ only for a corpse inside a dungeon asked about from outside it, where the marker sits on the entrance (`Map.dbc`'s, not the portal's trigger) and the SDK keeps `corpseMap` as `state.self.corpse.instanceMap`. The trailing unused u32 is consumed |

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
| `SMSG_MONSTER_MOVE` | 0x0DD | `{ "guid", "pos": {x,y,z}, "destination": {x,y,z}, "durationMs", "transportExit": true? }` or `{ "guid", "pos", "stopped": true }` — `transportExit` only on the spline that takes a passenger off a vehicle seat (`MoveSplineFlag::TransportExit`, `Unit::_ExitVehicle`): for the character's own guid, how a client learns it is off the seat |
| `SMSG_MONSTER_MOVE_TRANSPORT` | 0x2AE | `{ "guid", "transportGuid", "seat": <i8>, "pos": {x,y,z}, "destination": {x,y,z}, "durationMs" }` or with `"stopped": true` — a spline in a transport's own frame (`MoveSplineInit::Launch` for a unit aboard one), `seat` -1 on a transport's deck and the seat index on a vehicle. For the character's own guid with a seat it is the boarding spline onto a vehicle seat ("Vehicles and possession", above): which vehicle, which seat. `pos` and `destination` are transport-relative, never a world position |
| `SMSG_CLIENT_CONTROL_UPDATE` | 0x159 | `{ "guid", "allowMove": <bool> }` — which unit this client moves and whether it may (`Player::SetClientControl`; "Vehicles and possession", above). The module answers it as a client does |

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
| `SMSG_CORPSE_NOT_IN_INSTANCE` | 0x506 | `{}` — bodiless: a dead character crossed a dungeon portal's areatrigger and the server refused it because its corpse is not in that dungeon or one inside it (`MapMgr::PlayerCannotEnter`); no transfer follows, and the `move_to` that crossed the trigger ends as it would have anyway |
| `SMSG_AREA_TRIGGER_MESSAGE` | 0x2B8 | `{ "text": <string> }` — a portal's refusal in words (`WorldSession::SendAreaTriggerMessage`): a dungeon's level gate, a closed instance, a raid entered without a raid group, a battleground portal of the other faction. One event per line of the text (u32 length, then the line; read to the length, cut at the first NUL, a line's own trailing newline dropped). No transfer follows, and the `move_to` that crossed the trigger ends as it would have anyway |

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
  unspent count), `ammoId` (`PLAYER_AMMO_ID`, the item id of the ammo a
  ranged weapon fires, 0 for none; raw `CMSG_SET_AMMO` sets it),
  `selfResSpell` (`PLAYER_SELF_RES_SPELL`, the spell a dead character may
  resurrect itself with — a Soulstone, Reincarnation — which raw
  `CMSG_SELF_RES` casts; 0 for none); the character sheet: `stat0`-`stat4` (strength, agility,
  stamina, intellect, spirit: `UNIT_FIELD_STAT0`, the totals with buffs),
  `resistance0`-`resistance6` (`UNIT_FIELD_RESISTANCES`: armour, then holy,
  fire, nature, frost, shadow, arcane), `attackPower`, `attackPowerMods`
  (signed), `attackPowerMultiplier` (float) and the same three `ranged…`
  (`UNIT_FIELD_(RANGED_)ATTACK_POWER[_MODS|_MULTIPLIER]`; the server's total
  is (base + mods) × (1 + multiplier)) — these are PRIVATE/OWNER, so a pet's
  reach its owner too — and the floats `blockPct`, `dodgePct`, `parryPct`,
  `critPct`, `rangedCritPct` and `spellCritPct0`-`6` (per school, 0
  physical .. 6 arcane); `restedXp` (`PLAYER_REST_STATE_EXPERIENCE`, the rested
  bonus pool; the explored-areas mask, `PLAYER_EXPLORED_ZONES_1`, is not
  served until it has a compact, named shape: 128 raw words would ride every
  self update); the skill pane as raw fields
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
  slots, 23-38 = backpack slots, 39-66 = bank slots, 67-73 = bank bag slots,
  74-85 = vendor buyback slots, 86-117 = keyring slots, 118-149 = currency
  token slots (the core's numbering, `PLAYER_FIELD_INV_SLOT_HEAD` through
  `PLAYER_FIELD_CURRENCYTOKEN_SLOT_1`, contiguous). The SDK reassembles guids
  and joins them to item create blocks; its `inventory` view stops at 73.
  The buyback slots are the vendor window's buyback tab: an item sold is
  moved into one (`Player::AddItemToBuyBackSlot`), keeping the item object the
  client already holds (a part-stack sale creates a new one), and the slot
  number is what `CMSG_BUYBACK_ITEM` (raw: `u64 vendor guid, u32 slot`) names.
  Beside them `buybackPrice<n>`, n 0-11, the copper each costs to buy back
  (`PLAYER_FIELD_BUYBACK_PRICE_1`, slot 74 + n). The reattach replay does
  not re-create a buyback item's object (the core's own create builder skips
  those slots), so after a reattach a slot filled earlier reads with a guid
  and no entry.
- items and containers: `stackCount`, `durability`, `maxDurability`,
  `itemFlags`, `ownerLo`/`ownerHi`, `containedLo`/`containedHi`; the random
  property and the enchantment slots, PUBLIC fields every client in range
  receives, served raw per field the way the quest log is:
  `randomPropertyId` (`ITEM_FIELD_RANDOM_PROPERTIES_ID` as a signed integer —
  positive an `ItemRandomProperties.dbc` row, negative the negated
  `ItemRandomSuffix.dbc` row), `propertySeed` (`ITEM_FIELD_PROPERTY_SEED`,
  the suffix factor the core computes from `RandPropPoints.dbc` for the
  template's level, quality and slot), and `enchant<n>Id` / `enchant<n>Duration`
  / `enchant<n>Charges` for n 0-11 (`ITEM_FIELD_ENCHANTMENT_1_1`, three u32s
  per slot: a permanent enchant in 0, a temporary one in 1, gems in 2-4, a
  random property's enchants in 7-11, which the core fills from the
  property's row). Beside the ids, as client-cache knowledge the way
  `skill<n>Name` rides beside a skill id: `suffixName`, the enUS name suffix
  of the property's row ("of the Bear"), and for a suffix `suffixAlloc0`-`4`,
  its per-slot allocation (all five, zeros included, so a re-rolled id
  overwrites every earlier one); and for each non-zero `enchant<n>Id` its
  `SpellItemEnchantment.dbc` row — `enchant<n>Effect<i>Type` / `Amount` /
  `Arg` for i 0-2 (type 5 is a stat: `Arg` the `ItemModType`, `Amount` the
  value; 1/3/7 a spell by id; 4 a resistance by school; all three effects
  served, zeros included) and `enchant<n>Text`, the enUS text the client draws
  the green line from, with `$i` left as the client's placeholder for the
  amount. The amount of a suffix's enchant is the client's arithmetic, not a
  field: `floor(suffixAlloc<k> × propertySeed / 10000)` for prop slot
  `7 + k`; a positive property's enchants carry their amount in the row. The
  module names rows from the core's own stores of those three files (loaded
  with every other DBC, and empty stores serve ids without names); the SDK
  does the arithmetic and the join to the template (`randomPropertyOf`,
  `bag()` rows). The field is what makes an "of the Bear" readable at all:
  the item template answers `stats: []` for it, because the stats are the
  instance's.
- containers only (worn bags): `numSlots`
  (`CONTAINER_FIELD_NUM_SLOTS`) and the bag's contents as
  `bagSlot<n>Lo`/`bagSlot<n>Hi` u32 guid halves, n 0-35
  (`CONTAINER_FIELD_SLOT_1`, 36 guid pairs). PUBLIC fields every client in
  range receives, served exactly as the player's `invSlot<n>` halves are: a
  values update may carry one half, zero halves in a create block are
  compressed out, and the SDK joins halves into guids and addresses the
  slot as `(bag = the bag's equipment slot 19-22, slot = n)`, which is what
  `CMSG_USE_ITEM` / `CMSG_DESTROYITEM` / `CMSG_AUTOEQUIP_ITEM` resolve
  through `Player::GetItemByPos`. Nothing new on the action side: moving,
  swapping and splitting items is the raw allowlist's (`CMSG_SWAP_ITEM`,
  `CMSG_SPLIT_ITEM` and the rest of its inventory line), addressed by the
  same `(bag, slot)` pairs.

## Audit log

Per session and UTC day, a JSONL file at
`WrathBench.AuditDir/<fingerprint>.<YYYY-MM-DD>.jsonl`, where `<fingerprint>`
is the first 16 lowercase hex characters of the SHA-256 of the session's token
(its bytes as sent). Every action dispatched and every event served is
appended as:
```json
{ "ts": 1755792000123, "session": "tok:3f2a9c1e", "kind": "action"|"event", "payload": { ... } }
```
`session` is the session's tag, `tok:` and the first 8 of those hex
characters: the name the worldserver log gives it, and a prefix of its file's
name. Neither a file name nor a record carries the token. An operator holding a
token finds its files with `printf %s "$TOKEN" | sha256sum | cut -c1-16`. The
file name takes 16 characters where the tag takes 8 because a name must be
unique across every session the directory holds over its retention window; at
8, two of ten thousand sessions share one about one time in a hundred, and
their records would interleave in one file unnoticed.
`payload` for `event` is the exact event object sent on the WebSocket; for
`action` it is a short record of the dispatched opcode. The ground truth for
the wire while it is kept: an operational record the deployment prunes by age
(docs/CONTRACTS.md "Audit"); the record that stays is whatever a harness keeps
from the sandbox's action log (docs/ARCHITECTURE.md, "The action log"). The day's file is opened at session create and held, in
append mode; the first record after a UTC day boundary closes it and opens the
next day's, only ever forward, so a session reopened later under the same
token appends to that day's file and a past day's file gets no further write.
The retention pass rests on that: a past day's file is deletable once it is
quiet for the window, whatever the server's start.

A create that reclaims an account ("POST /session") logs one `action` record
on the evicted session's file, `op: "session_reclaimed"` with the `account`
and the reclaiming session's tag, `bySession`.

The reattach replay ("/events", above) logs one `action` record,
`op: "reattach_replay"` with the `objects` restated and whether it was
`incomplete`, after the replayed events themselves, which are audited like
any other.

The root acks (Roots, above) log one `action` record each, `op: "root_ack"`
with the `opcode` sent, the echoed `counter`, the `pos` the ack carried and
the `moveId` of the walk it stopped (0 outside a walk). The speed-change and
movement-state acks (Speed changes and the clock, above) log one each, `op:
"move_ack"`, with the `kind` (`speed`, `water_walk`, `feather_fall`, `hover`,
`can_fly`), the `opcode` sent, the echoed `counter`, the `speed` echoed
(`speed`) or whether the flag was set (`apply`, the others), the `pos` the ack
carried and the `moveId` of the walk it was sent during (0 outside a walk). A
speed ack withheld because the server's speed has moved on is logged with
`withheld: true` and that `serverSpeed`, and nothing is sent.

Synthesized movement logs one `action` record per `move_to`/`stop`/`face`
request (`force: true` on the record when the request said so) plus one per
dispatched movement packet (`op: "move_pkt"` with the opcode and position;
`cause: "drop"` on the stop at a refused ledge, `cause: "drop_forced"` on the
edge heartbeat and the `MSG_MOVE_FALL_LAND` of a forced one, or the
`MSG_MOVE_START_SWIM` it becomes when the foot is deep water; `cause:
"turn"` on the `MSG_MOVE_SET_FACING` of a turn (Turns, above); `cause:
"water"` on the `MSG_MOVE_START_SWIM` / `MSG_MOVE_STOP_SWIM` of a swim
transition, with the mesh's z there, `meshZ`, beside the body's in `pos`, and
the `collisionHeight` the threshold came from), so the packet
sequence the "client" sent is fully reconstructable from the audit log.
A move whose start the mesh does not cover logs `op: "move_start_snap"` with
`from` (the true position), `to` (the nearest mesh point) and `distance`.
A move planned from the water surface over its start (the start's own
polygon on a closed island; `path_incomplete` below) logs
`op: "move_start_level"` with `from` (the start), `levelZ` (the level's
height there) and `islandPolys` (the start island's size).
A move whose endpoint the core's normalization left under the ground logs
`op: "move_end_z"` with `normZ` (the z the core settled on) and `meshZ` (the
height of the polygon the path ends on, where the walk ends instead).
A move whose route the drop guard refused logs `op: "move_replan_steep"`
(the re-plan under `drop`) with `outcome` — `ok` when a re-planned route
passed the guard and is the walk, `failed` or `skipped` with a `reason` when
the `drop` stands — `rounds` (re-plans run, at most three), `excluded` (mesh
polygons the last one barred), the refused route's `edge`, `dz` and
`pointCount`, and `replanPointCount` (the last re-planned route's, 0 when none
was built).
A `path_incomplete` whose request lies below the end of the mesh's route logs
`op: "move_edge_drop"` (the edge drop under `path_incomplete`) with `taken` —
true when the route is now the walk on, the fall and the leg below, whose
polyline is the `move_path` — else a `reason` (`no_edge`, `climb`, `blocked`,
`no_surface`, `landing_off_mesh`, `snap_climb`, `snap_ledge`,
`no_route_from_landing`, `second_ledge`, `air_to_request`, `no_speed`,
`no_direction`, `not_a_ledge`), `from` (the route's end), and, once an edge was
found, `edge`, `landing`, `walkYards` (the walk on from `from` to the edge) and
`landingSnap` (the leg below starts from the mesh nearest the landing) — with,
whenever that snap was tried, taken or refused (`snap_ledge`, `snap_climb`),
`snapTo` (the mesh point it aimed at) and `snapYards` (its distance from the
landing, 3D) — `endAtLanding` when the landing (or its snap) was where the
request is and the route ended there with no leg below, and `fromStart` with `firstReason` when it was tried again from the route's start
after the route's own ledge (`second_ledge`). A move that was already where
its request is (within the smooth path's slop, above) logs
`op: "move_end_slop"` after the drop guard has settled the step, with its
`status` (`ok`, or the guard's verdict) and `to`, the request as resolved;
the walk itself ends at that x,y at the start's z.
Each `move_to` that reaches the mesh also logs one `op: "move_path"` record at
dispatch — `moveId`, `status` (`"ok"` when the walk was dispatched, else the
`WB_MOVE_RESULT` status), `pointCount`, and `points` (the resolved polyline,
capped at 64 points with `truncated: true` when the cap bit) — so a route the
mesh chose is read from the log, not reconstructed from heartbeats. Beside it,
one `op: "move_eta"` record for each dispatched walk: `moveId`, `etaMs`,
`pathLength`, `swimYards` (the stretches the walk-time estimate counted as
swum), `samples` (water tests made), `costUs` (the estimate's own cost on the
world thread, in microseconds), and the `runSpeed` and `swimSpeed` it read.
