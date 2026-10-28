# @wrathbench/sdk

The TypeScript library a model's snippets call to drive a character. It wraps
the module's HTTP/WebSocket protocol (`module/PROTOCOL.md`) in typed helpers,
turns the module's packet stream into typed events, and folds those events into
a state cache that says what the character can see right now. The stack's
sandbox (`mcp/`) hands it to every snippet as the ambient `sdk`, the scripted
reference run plays through it from inside those snippets, and most of the
smoke scripts under
`infra/smoke/` call it directly. Everything it knows comes through the module,
so it observes only what a real client could observe (`docs/CONTRACTS.md`).

The model does not read this file. It reads `sdk/API.md`, the exhaustive
per-method reference generated from the source by `sdk/generate-api-docs.ts`.
This file is for people working on the harness: how the pieces fit, the
behaviours worth knowing before you compose helpers, and the rules the surface
is held to.

## The stack

The SDK is the middle of three pieces that together give an agent a game
client's eyes and hands on a stock AzerothCore — packets, not pixels — and
nothing of the benchmark built on them:

- `module/` (C++, GPL-2.0-or-later): the worldserver module. It takes actions
  as the client opcodes a client would send and serves the packets a client
  would receive, over HTTP and a WebSocket. Its wire is `module/PROTOCOL.md`.
- `sdk/` (this package, `@wrathbench/sdk`): the typed client over that wire,
  the event stream, the state cache, the helpers and their per-call hints.
- `mcp/` (`@wrathbench/mcp`): the agent surface over the SDK — a confined,
  persistent snippet sandbox holding one client, an MCP server, and the core
  tools (`run_snippet`, `recent_events`, `state_summary`, `write_scratchpad`,
  `edit_scratchpad`).

What the agent may observe and do is `docs/CONTRACTS.md`; with
`module/PROTOCOL.md` it is the stack's specification. `runner/` is the
benchmark that drives the stack; nothing in the stack imports it
(`bun run boundary`, `docs/ARCHITECTURE.md`, "The stack and the benchmark").

### Quickstart

1. **Add the module to a stock AzerothCore.** Check out AzerothCore at the
   pinned commit, `3cafaf4a588fd1f287678fdb37438fdedd1ed85c` (`infra/PINS.md`),
   copy `module/` to `modules/mod-wrathbench`, and build as usual; CMake finds
   the module itself. `-DWRATHBENCH_BUILD=<your build id>` names the build on
   `/health`. `infra/docker/server.Dockerfile` is this exact recipe. The
   worldserver needs the 3.3.5a client data (`dbc`, `maps`, `vmaps`, `mmaps`)
   for that core, which you supply; none of it is in this repository.
2. **Configure it.** Copy `module/conf/mod_wrathbench.conf.dist` beside the
   worldserver's config. `WrathBench.Secret` is required — the port secret,
   32 characters or more; without it the module does not listen.
   `WrathBench.Accounts` lists the game accounts sessions may use,
   `WrathBench.BindAddress` and `WrathBench.Port` (default `0.0.0.0:8086`)
   where it listens; keep that port on a private network.
3. **Run the MCP server.** With Bun 1.4 and `bun install` at the repo root:

   ```bash
   WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 \
   WRATHBENCH_MODULE_SECRET=<the port secret> \
     bun mcp/src/main.ts --account <an allowed account>
   ```

   It speaks MCP over stdio, so an MCP-capable agent launches it as its
   server command. It leases a session secret for its token with the port
   secret, hands the sandbox only that, and keeps the scratchpad and the
   client cache under `--dir` (default `$TMPDIR/wrathbench-mcp/<token>`). The
   sandbox needs Linux 6.7 or later (Landlock with TCP rules) and refuses to
   run without it. Event lines and the state summary come back in a plain
   rendering; a harness supplies its own (`CoreToolRender`).
4. **Or use the SDK directly**, as the smoke scripts do (below, "At a
   glance").

### Versioning

The SDK has its own version, `SDK_VERSION` (`src/version.ts`, the same string
as `package.json`; `docs/METHODOLOGY.md`, "Fixed harness, frozen per
version"), and `@wrathbench/mcp` carries the same one. As built, the runner
depends on the stack at an exact version (`workspace:0.1.0`), so an SDK whose
version moves fails the install until that dependency moves too, and every
run records the version it drove as `sdkVersion` in `meta.json`. A change a
model can see is still a harness change (`docs/METHODOLOGY.md`, "Changing
this document"). Which changes bump which part of the SDK's version is not
settled yet.

The module's wire has a version of its own, the integer `protocol` on
`GET /health` (`module/PROTOCOL.md`, "Versioning"). `connect` checks it before
anything else and throws `ModuleProtocolError` for a protocol this SDK cannot
drive (`MODULE_PROTOCOL_VERSIONS`); a module that predates the field passes.
The build identity on the same endpoint (`build`, `startedAtMs`) says which
binary, not which wire.

## At a glance

```ts
import { connect } from "@wrathbench/sdk";

const client = await connect({ baseUrl: "http://worldserver:8086", token: "run-1" });

await client.health();
const session = await client.createSession({ character: "Benchy", race: 1, class: 1 });

await client.say("hello world");
const echo = await client.waitForChat("hello world", { timeout: 5000 });

const target = await client.waitForNearby(
  (o) => o.objectType?.value === "unit" && o.name !== undefined && o.position !== undefined,
);
const move = await client.moveTo(target.position!.value, { timeout: 60_000 });
if (!move.ok) console.log("could not get there:", move.status);

console.log(client.state.self.position?.value);
await client.logout();
client.close();
```

`connect` opens the event subscription *before* any session exists, on
purpose: `POST /session` blocks for the whole login handshake, and
`SMSG_CHAR_ENUM` and `SMSG_LOGIN_VERIFY_WORLD` arrive while that call is still
in flight. Subscribing first is what makes the state cache complete.

## Running things

```bash
bun test sdk                 # the whole suite, from the repo root; no game stack needed
bunx tsc --noEmit -p sdk     # strict typecheck of src, test and examples

# live checks, need the stack up; not part of bun test. Both read
# WRATHBENCH_MODULE_SECRET from the environment and send it as the bearer
# credential — without it the module answers 401 unauthorized.
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-slice.ts
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-move.ts
```

The tests run against an in-process `Bun.serve` stub (`test/server.ts`) that
speaks the same HTTP and WebSocket shapes and replays fixture frames. Every
fixture is hand-written from `module/PROTOCOL.md` with invented names; nothing
is captured from a running game.

## The shape of the surface

A few rules hold across every helper. They are worth knowing before the
helper-by-helper detail below.

**Helpers and one escape hatch.** A helper sends an action, waits for the
game's verdict and returns it. `raw()` is not a helper: it queues one
allowlisted client opcode with a caller-built body (the allowlist is
`module/PROTOCOL.md`, "raw"). It is how a trajectory shows that a surface is
needed before one is built, not a second path to any helper
(`docs/METHODOLOGY.md`, "The model surface"). Helpers stop where they stop
because that is what the probes and `infra/smoke/one-quest.ts` have actually
needed; nothing is added in anticipation.

**Game outcomes are returned, not thrown.** A helper returns `ok: true` or
`ok: false` with the `status` intact and a per-status `hint`. "There is no path
there" is an answer, not an error, and a snippet that forgets a `try` should not
lose a run to a wall. What does throw is a broken or unanswered call: see
"Errors" below. The corollary is that an SDK-side status is legal only when it
describes the SDK declining to act (`unknown_target`, `lost`), never a renamed
or inferred server outcome.

**Every guid is an opaque decimal string**, in state fields, helper returns
and every guid argument, which is also exactly what the wire carries. Compare
with `===`, use them as Map keys, `JSON.stringify` them freely. A `number` guid
is rejected loudly (precision loss); a bigint you build yourself is converted
for you. The SDK may use bigint internally and never lets one escape.
Session-scoped short aliases were considered and rejected: they die on
reconnect, so a stale alias would silently name the wrong unit. Representation
is fair game to optimise; referents are not.

**A name in view is a valid referent.** Wherever a helper or raw action takes a
guid, it also takes the name of a unit, item, spell, talent, faction or taxi
node the model can currently observe (`src/resolve.ts` is the shared
resolver; `docs/METHODOLOGY.md`, "A name in view is a valid referent, with
bounded fuzz"). Resolution is deterministic and narrow: normalise case,
whitespace and apostrophes; exact match, else a unique substring, else a unique
match within a small edit distance. One candidate acts; none refuses and says
what is in view; two or more refuse and list them. Opcode names and guids
themselves are never fuzzed.

**The SDK reads no environment.** The bearer credential every route requires,
the port secret for operator tooling or the run's lease secret for a snippet
child, is passed in by the caller as `ConnectOptions.secret`.

## Combat, loot and quests

`killTarget` owns the whole melee loop. Each part of it is there because a live
run needed it: a synthesized character never auto-faces the way a client does,
and the server drops a swing that is not facing its victim, so the target is
faced before the first swing and re-faced during the fight; the character
walks into melee range before the first swing and is walked back whenever the
target drifts out of it; our own death ends it at once. Statuses are `killed`
(the target's observed health reached zero), `player_died`, `lost` (it left
view alive), `timeout`, and `aborted_low_health` when `abortBelowHealthPct` was
given and our own health fell under it. There is deliberately no `evaded`:
nothing on the whitelist says "evade", and naming a status the module never
uttered would put an SDK invention in a field that otherwise holds only the
world's words.

The one thing to know before composing with it: a single `CMSG_ATTACKSWING`
makes the server swing until it is cancelled, and moving does not cancel it. So
`killTarget` sends `attack_stop` only when the fight is over (`killed`,
`player_died`, `aborted_low_health`) or when `disengage: true` was passed.
`timeout` and `lost` leave the character swinging, because disarming a
half-fought mob is how a character dies standing still. `attacking` says which
happened and `detail` says it in words. If the server cancels our auto-attack
mid-fight (`SMSG_ATTACKSTOP` with the target still alive), the loop swings
again. The default `timeout` is 25000 ms, deliberately under the runner's 30 s
snippet cap; longer fights belong in a background routine. The walk into melee
range draws on the same timeout, so every result also says whether melee range
was ever reached (`reached`) and how far the target was at the end
(`distance`), and a `timeout` that never got there opens `detail` with "never
reached melee range" rather than reading as a fight.

A swing the server refuses is on the event stream as
`SMSG_ATTACKSWING_NOTINRANGE` or `SMSG_ATTACKSWING_BADFACING`, both with an
empty payload: the two errors a client shows while auto-attack is armed and
nothing lands. They are typed events and nothing more; `killTarget` does not
read them. Whoever does has to respect the core's latch
(`module/PROTOCOL.md`, "Swing errors"): one event per change of error state,
none when the error clears, and the latch survives `attackStop` and a new
target, so a second out-of-range attack is silent. Seeing one is evidence;
seeing none is not evidence of being in range or facing.

`lootCorpse` sends `loot_all`, the module replaying the client's auto-loot
sequence, and returns once the window has been emptied and released. Its
`items` are what `SMSG_ITEM_PUSH_RESULT` confirmed *stored*, not what the
window displayed: the window is an offer, the pushes are the receipt, and a
possible no-op is never reported as success. The non-success answers:

- `{ ok: false, status: "empty" }`: a corpse with nothing on it, which
  releases without ever opening a window. An answer, not a failure.
- `{ ok: false, status: "none_stored" }`: the window showed items and not one
  entered a bag (bags full, or a broken store path).
- `{ ok: false, status: "refused", reason, error, hint }`: the server refused
  the loot (too far away, not ours, someone else already on it). It answers
  with `SMSG_LOOT_RESPONSE` in its error form (`lootType` 0 and a `LootError`
  code; `module/PROTOCOL.md`) rather than a window and no release follows, so
  the helper returns at once with `error` the code's name (`too_far`,
  `didnt_kill`, `locked`, …; `LOOT_ERROR_NAMES`) and nothing left open.
- `{ ok: false, status: "not_opened", reason, hint }`: a chest none of the
  Opening spells fits.
- Silence still throws `EventTimeoutError`.

A chest-type game object goes the way a client opens one (`docs/CONTRACTS.md`,
the action contract): the helper casts the lock's Opening spell at it and sends
the store/money/release sequence itself once the window arrives.
`interact(guid)` on a chest is refused with `{ status: "chest" }` and a hint,
because the ack it would return means nothing.

`questsAvailableFrom` asks an NPC what it offers right now and returns
`{ ok: true, quests: [...] }`; an empty list is an answer, not an error. It
exists because models kept rebuilding it by hand over `questList` plus event
scraping and getting confused by their own nulls.

`acceptQuestFrom` reads the quest log *first*, because a turn-in chain may
already have added the quest (the core auto-advances, so an explicit accept can
be a no-op); that is `status: "already_in_log"`. Otherwise it asks, and accepts
the answer in every shape the core sends:

- A gossip-flagged questgiver answers `quest_list` with an
  `SMSG_GOSSIP_MESSAGE` carrying the quests, not an
  `SMSG_QUESTGIVER_QUEST_LIST`.
- An NPC without the gossip flag whose menu holds exactly one quest skips the
  list and sends that quest's own window (`Player::SendPreparedQuest`). Its
  details window is a one-row offer (an auto-accept quest has been added to the
  log by the hello itself, and is reported accepted); its request-items or
  offer-reward window is a quest that completes on the spot or, for a quest
  already in the log, that quest's turn-in, which is `nothing_on_offer` with a
  hint naming `turnInQuest`. These windows are matched on the NPC's guid as
  well, since turn-ins and quest-start items send the same opcodes.
- Showing an auto-accept quest's details is what takes it, but the window goes
  out at once and the quest-log field only with the map's next object flush,
  every few world ticks. Asked again inside that gap (`questsAvailableFrom`
  then `acceptQuestFrom` back to back), the NPC's menu no longer holds the
  quest although the log is about to. So when the menu lacks the quest and the
  event buffer holds this NPC's own details window for it, `acceptQuestFrom`
  gives the log up to a second to catch up and answers `already_in_log` when
  it does; without that window, `not_offered` is answered at once.
- A quest that hands over an item is refused with
  `SMSG_INVENTORY_CHANGE_FAILURE` when the item does not fit, and never enters
  the log: `inventory_full`.

`turnInQuest` handles the other side of the same asymmetry. An
`SMSG_QUESTGIVER_REQUEST_ITEMS` that says the quest *is* completable is the
client's cue to send the completion again; a completable one (a collect quest
with its items in hand) carries no reward list, so the helper sends the
client's "Continue" (`questRequestReward`,
`CMSG_QUESTGIVER_REQUEST_REWARD`), on which the core completes the quest and
answers with the reward window, and goes on from there like any other turn-in.
The completion wait races `SMSG_INVENTORY_CHANGE_FAILURE`: a reward that does
not fit is answered with that failure and no completion, so a full bag is
`{ ok: false, status: "inventory_full", hint }` instead of a burnt timeout (the
quest stays in the log; free a slot and turn in again). A reward window
offering two or more choice items, with no `rewardIndex` passed, is not
answered: the result is `{ ok: false, status: "choose_reward", choices, hint }`,
each choice `{ index, itemId, count, name, quality, item }` with the item's
tooltip from the client cache (the module queries every reward item it decodes;
the call waits up to a second for those answers and leaves `item` undefined
for any still missing), and a second call with the index takes it. Defaulting
to the first choice would hide the choice completely. An explicit index, or one
choice or none, completes without asking.

The core answers an out-of-range quest call with silence, so all three quest
helpers refuse locally with `too_far` and the distance when the cached
positions put the NPC beyond any questgiver's reach. That reach is 5.5 y plus
both combat reaches, and the module does not serve the NPC's, so the ceiling is
set by the largest questgiver in the pinned world rather than a typical one;
nearer than that the call still goes out, and a silence is explained by the
distance afterwards.

The questgiver marker answers before the wire too. `acceptQuestFrom` and
`questsAvailableFrom` refuse with `nothing_on_offer` when the NPC's marker says
it offers nothing, and `turnInQuest` refuses with `not_ready` and the `marker`
when it says nothing the NPC ends is ready (`none` or `incomplete`). Both
checks trust only a marker newer than the last change to the quest log or the
character's level, because the client re-asks for every marker when the log
changes and the old marker stands until that answer lands: a quest just
completed still reads `incomplete`, and an NPC just turned in to still reads
`reward` while the next quest of its chain is already on offer. An older
marker, or none, still sends. Event `seq` restarts with every session, so a
login drops every marker the cache holds and each questgiver the new session
puts in view is asked again, as a client asks after logging in; so is each
questgiver back in view after a trip to another map. The login also re-dates
the quest-log slot and level fields to itself (their values stand), because a
create block leaves out every zero-valued field and an empty slot would
otherwise keep the last session's `seq` and outrank every new marker.

`waitForQuestObjective` waits on the **quest log**, not on an event, because at
the pinned commit the core sends no `SMSG_QUESTUPDATE_COMPLETE` for a kill
objective: the only thing that reports one to a client is the completion bit
in the served quest-log state field.

`trainerList` asks a trainer what it teaches and derives two things per row
that are not on the wire: `learnable` (the server's own green state, via the
single `TRAINER_SPELL_STATE` mapping) and `affordable` (observed money against
`cost`, `undefined` while money is unobserved, never guessed). They are
independent: the server's state says nothing about money, so a green spell can
still fail to buy. The core's handler answers nothing at all when the NPC is
out of interact range, is not a trainer, or trains another class, so all three
arrive as an `EventTimeoutError` saying so. `buySpell` races
`SMSG_TRAINER_BUY_SUCCEEDED` against `SMSG_TRAINER_BUY_FAILED` for the spell id
and returns `{ status: "learned" }` or `{ status: "buy_failed", reason, hint }`:
the raw reason plus one actionable sentence, never an exception, because a
refusal is the game answering.

`deleteCharacter` retries on its own, and that belongs in the SDK rather than
in a caller: for up to about a minute after logout the core still tracks an
offline session for the character and silently ignores `CMSG_CHAR_DELETE`,
which surfaces as `504 timeout` (or as an aborted request, if the module's
internal wait outlasts `requestTimeoutMs`). `account_in_use` is the same
not-yet-released transient seen from the other side. All three mean "not
released yet" and are retried with a fresh throwaway token each time; anything
else the module says (`character_not_found`, a `char_delete_failed_code_<N>`)
is a real answer and is thrown.

## Movement

`moveTo` issues `move_to`, then resolves on the `WB_MOVE_RESULT` carrying the
same `moveId`. `arrived` is `ok: true`; every failure status is `ok: false`
with the status intact and a per-status `hint`, and *every* move result
carries the server-confirmed position the character actually ended at.

Two things still throw:

- `WrathRequestError`: the request was refused before anything moved
  (`missing_position`, `not_in_world`, …).
- `EventTimeoutError`: no result arrived within `timeout` (default 135000 ms,
  which is the ~250 yd single-move cap at about 53 s of swimming, the slower
  pace a move can go at, on a route up to ~2.4x the straight line, plus the
  module's server-confirmation deadline). That is the *absence* of an outcome,
  and the character may still be walking, so it is not dressed up as a
  `status`.

A route that steps off a ledge comes back from the module as `drop` with the
edge and the step. `moveTo` judges the fall before passing that on, using the
server's own fall-damage rule (free under 13.48 y, then a share of max health
rising with height, less the character's Safe Fall; `estimateFallDamage`)
against current health. A fall that would cost less than `DROP_BLOCK_FRACTION`
(0.8) of current health is taken: the move is re-issued with `force` and the
arrival's `hint` says what it cost. A ghost always takes it, since the dead
take no fall damage. Otherwise the result is `drop`, the hint carries the
estimate, and `moveTo(target, { force: true })` takes it anyway. `force`
applies to drops only: a step the route would climb is refused forced or not,
since no client walks up a ledge, and a step that would land underground is
refused the same way with `surfaceZ` giving the ground height, since no client
falls through terrain. The split is deliberate: the module reports the ledge
and walks it on request with the fall packets a client sends, so the server
charges the fall; what a fall costs is a game rule and lives here.

`moveToAsync` acks with a `moveId` and nothing more, so the client watches that
move's `WB_MOVE_RESULT` and tallies any verdict but an arrival, a transfer, a
teleport, `superseded` or `stopped` on the harness hint channel as
`moveToAsync <status>` (re-sending a move is how a caller steers with it, so
those two are the steering, not failures; operator, 2026-10-20), the same
recipe `moveTo` returns: a move refused at planning (`too_far`, `drop`) never
started, and the ack alone let a snippet sleep on it.

A dead character that has not released its spirit is a body, and a body cannot
move or fight: `moveTo` answers `dead` and `moveToAsync` rejects, both with
nothing sent, and `killTarget` answers `dead` for a body and for a ghost alike.
A ghost walks. Unobserved health is never read as dead. An `interrupted` verdict
that finds the character dead (the health-0 block precedes the result in the
same tick) says the character died.

A `moveTo` issued while another is running supersedes it, and the older call
returns `status: "superseded"`. `stop()` returns as soon as the module has
queued the `MSG_MOVE_STOP`; it does *not* wait for the character to halt. It is
the in-flight `moveTo` that resolves, with `status: "stopped"`, once the stop
has landed, so read the position off that result rather than off the cache
right after `await client.stop()`. The module says `stopped` only for a `stop`
action, and only the run's own client sends one (a caller's `stop()`, the stop
`moveTo` sends after a refusal, and the stop on a snippet's abandon), so that is
what its hint names.

`waitForNearby` waits on the *cache*, not on one event: a named creature takes
a create block plus the creature-query answer the module fired on first sight,
so no single event answers "is there a named creature nearby".

## Errors: two channels, not quite two transports

- `WrathTransportError`: the request got no readable answer. Socket refused,
  timeout, non-JSON body, a 2xx body that does not match the protocol.
- `WrathRequestError`: the module answered `{ ok: false }`. Carries `status`,
  `code`, `body`, and `kind`:
  - `kind: "request"`: your call was wrong (`token_in_use`, `no_session`,
    `not_in_world`, `unsupported_action`, …).
  - `kind: "game"`: the *server* decided (`char_create_failed_code_<N>`, with
    the numeric code parsed out into `charCreateResultCode`, plus
    `login_failed` and `timeout`). These come back as HTTP only because
    `POST /session` is synchronous; the same outcome is also on the event
    stream.

Everything the server decides *after* an action is acked never appears as an
error at all. It arrives as an event, because that is how a client would learn
of it: a muted `say` is an `SMSG_NOTIFICATION`, not a 4xx.

Unknown error codes parse fine; `ErrorCode` is a widened string union, so a new
module code costs autocompletion, not correctness.

## Event stream

`client.events.connect()` reopens the stream after a `close()`: a consumer
that hung up can dial again, and the gap accounting carries across, so the
events emitted while it was down arrive as one `stream_gap`. What `close()`
ended stays ended: the waits it rejected and the async iterators it finished
belong to the caller that closed them.

`waitFor` searches the retained buffer *before* waiting, so a wait issued after
an action was acked can still find an event that arrived during the call.

Three ways an event can be less than fully typed, none of which drop it:

- `data` is `{ decodeError: true }`: the module could not decode a whitelisted
  packet. Use `isDecodeError(event.data)`.
- `schemaError` is set: the opcode is whitelisted but the payload did not match
  this SDK revision's schema. `isEvent(event, opcode)` returns false for these,
  so narrowing gives you real fields or nothing.
- The opcode is unknown to this revision: it arrives as an `UnknownEvent` with
  `data` unvalidated, so an SDK built against today's whitelist keeps streaming
  when the whitelist widens.

Two synthetic opcodes, lowercase so they can never collide with an `SMSG_*`:

- `stream_gap`: the stream reconnected across a hole. `data` is
  `{ fromSeq, toSeq, missing }`. Never suppressed, because a cache is only as
  trustworthy as the stream it was fed. A `seq` that *restarts* (the session
  was torn down and recreated under the same token) is re-baselined, not
  reported as a gap.
- `stream_error`: a frame arrived that was not a readable event envelope.

One field is added at decode time, never invented: the cast-failure packets
(`SMSG_CAST_FAILED`, `SMSG_SPELL_FAILURE`, `SMSG_PET_CAST_FAILED`) keep their
numeric `result` and gain `reason`, the pinned core's `SpellCastResult` name
for it (`97` is `out_of_range`, `67` `not_ready`; `spellCastResultName`), or
`undefined` for a code outside that enum. The name is the key the client's own
failure text uses, so it is client-visible knowledge, like the
`InventoryResult` sentences. `castSpell` itself still acks the dispatch only:
these events, or `SMSG_SPELL_GO`, are the outcome. The client watches each
`castSpell` for that outcome, though, and tallies a failure on the harness
hint channel as `castSpell <reason>` with the spell and target named, so a
refusal reaches the model whichever snippet or routine cast it. Matched by
spell id (`SMSG_CAST_FAILED` names no caster), watched past the cast time once
the cast starts, ended by `SMSG_SPELL_GO`; `dont_report`, the server's silent
cancel a repop sends in a burst, is not a refusal. Helpers that read their own
cast verdicts (the chest's Opening ladder) dispatch untracked.

## State cache

`client.state` is a `StateCache`: a pure fold over the stream. Two rules hold
it, and the tests enforce both.

1. **Nothing is invented** (`docs/CONTRACTS.md`). A field exists only if an
   event carried it: an incomplete gauge stays `undefined` rather than being
   half-filled, an object with no `create` block has no `objectType` (and so
   is not a unit), and a chat sender does not become a nearby object, because
   knowing who spoke is not knowing who is in range. A guid learned from a
   name query goes in `names`, which claims nothing spatial.
2. **Replayable.** `StateCache.replay(events, { seed })` reproduces the live
   cache exactly. The one input that is not an event is the seed, our own guid
   and name, which arrive in the `POST /session` response because no `SMSG_*`
   says "you are guid N". It is recorded on `state.seed` so a replay is
   explicit about it.

Every observed field group is an `Observed<T> = { value, seq, ts }`, so
staleness is legible rather than implied. That matters most for position: our
own is written by `SMSG_LOGIN_VERIFY_WORLD`, then by our own create block, then
by every `WB_MOVE_PROGRESS` while we walk and by the server-confirmed
`WB_MOVE_RESULT` at the end, and by a flight's landing (`taxiFlight` turning
false), which puts it at the last point of our own `SMSG_MONSTER_MOVE` spline.
Between events it is stale, which the `seq` says out loud. A flight is the
long case: the module serves the spline's start, end and duration but no point
between, so mid-flight position stays the take-off point and `self.taxiEta`
says when that changes.

### What is derived from `self`

`questLog`, `inventory`, `money`, `xp`, `nextLevelXp` and `target` are
*derived on read* from `self.fields` rather than kept as a second copy written
by a second path. There is one write seam (the field merge), so
replay-equals-live holds for them for free. The wire's shape is preserved on
the way in: the module serves `quest3State` and `invSlot23Lo` as raw per-u32
fields, and this is where they are folded.

- A quest slot's four objective counters are two u32s of packed u16s, split
  into `counts[0..3]`. The log carries the *current* counts only (`required`
  lives on `SMSG_QUESTUPDATE_ADD_KILL` and the quest details), so nothing here
  compares them, and `complete` is the state field's own bit.
- An exploration objective has no slot and no counter. A quest whose template
  flags carry `QUEST_FLAGS_EXPLORATION` (0x4, served raw as `flags` on
  `SMSG_QUEST_QUERY_RESPONSE`) gets one `explore` row, last, with the
  template's `areaDescription` as its text (the objectives text when that is
  empty). It is done when the completion bit is set, or when
  `SMSG_QUESTUPDATE_COMPLETE` named the quest while it was in the log: the
  core sends that once, when the area is reached, even if kills or items are
  still open. The credit is dropped when the quest leaves the log and at
  login, because no field restates it; a quest with other objectives still
  open then reads not done until the completion bit is set. A module that
  does not serve `flags` gives no row.
- `questNId === 0` is an empty slot and does not become a quest with id 0.
- An inventory slot is a three-way join: the two u32 guid halves, the item's
  own create block (for `entry`), and an item query (for the name). Each leg
  can be missing, and a slot whose item has not been created for us yet is
  still reported, because it *is* occupied, with `itemId` and `name`
  undefined.
- `bag()` is the backpack view of `inventory`, shaped for acting on it:
  `bag`/`slot` are exactly what `equipItem`, `useItem` and `destroyItem` take,
  `count` is the observed stack count, and `freeSlots` counts the slots
  holding nothing. One caveat: empty slots are zero fields the wire
  compresses away, so before our own create block arrives `freeSlots` reads
  16.
- A bag or equipment row is the instance, not just the template. An item that
  rolled a random property carries it in its own update fields
  (`randomPropertyId`, `propertySeed`, the `enchant<n>*` keys, with the DBC
  rows the module serves beside them), and the row reads them the way the
  client does: `name` is the template name plus the suffix ("… of the Bear"),
  `stats` the template's stats followed by the suffix's at
  `floor(allocation × seed / 10000)`, `enchants` the tooltip's green lines
  with the amount filled in. A template that says `stats: []` can still be a
  stat-bearing item in hand. `randomPropertyOf(obj)` is the same reading over
  a raw nearby object.
- `pointOf(obj, now?)` answers "where is it now" from the freshest of two
  independent sources: an oriented position (update blocks, `MSG_MOVE_*`) or
  an `SMSG_MONSTER_MOVE` spline. A spline is read the way a client draws it:
  from its start toward its destination by the time elapsed since the packet
  arrived over its duration, in a straight line (the module drops the path
  points), held at the destination once the duration has run. A creature
  re-launched over and over from one spot, as a stuck chaser is, reads at
  that spot. Where it is going stays on the raw object,
  `obj.motion.value.destination`; for a mob chasing us that is ourselves,
  which is why `units()`, `closest()`, `moveTo(unit)` and `killTarget` all
  read the current point.

The queries (`nearbyUnits`, `creaturesByEntry`, `closest`) are pure reads.
`closest` returns `undefined` when we have no position of our own, rather than
guessing one, and otherwise the nearest object's `units()` row, the same flat
shape with `distance` included, because models reading its sibling's rows kept
reading `.distance` off it. `nearbyUnits` and `creaturesByEntry` hand back the
live cache entries; `snapshot()` is the frozen copy.

### How an object in view is built

`values` deltas merge **per field**: each field keeps the `seq`/`ts` of the
block that carried it, so a health number and the max it is out of can be
minutes apart and say so. A `near` block is *not* a removal and does not prune.
`names` and `creatures` are never pruned, because the module will not re-issue
a query for an entry it already asked about, and a creature that walks away and
comes back would otherwise be permanently nameless.

Three consequences of "nothing is invented" worth knowing before you read a
field:

- `NearbyObject.position` is a `UnitPosition` (`x,y,z,o`) with **no map id**:
  nothing on the wire carries one for another object. Only `self.position` has
  a `map`, carried from the last `SMSG_LOGIN_VERIFY_WORLD`.
- `health`/`power` are set only when *every* part has been observed. A
  `values` delta routinely carries `health` without `maxHealth`, and which of
  `power1..7` is the character's power depends on `powerType`. Half a gauge is
  not a gauge. The raw parts are always in `obj.fields`, which is where to look
  when a gauge is `undefined`. (A level-1 warrior's create block carries
  `powerType: 1` and `maxPower2` but no `power2`, because the current value is
  0 and zero fields are not in the update mask, so `power` stays `undefined`
  until the first change.)
- A `create` block flagged `self` whose guid contradicts the seeded identity
  does **not** overwrite `self`. It is recorded on `state.anomalies` and filed
  as an ordinary object in view, because the cache cannot tell which of the
  two is wrong and picking silently would make it disagree with the trajectory
  log.

## For maintainers

**The surface is versioned.** The SDK's public shape is part of the harness
version (`docs/ARCHITECTURE.md`). Adding to it is a minor bump. Changing or
removing anything exported from `src/index.ts` is a major bump and wants a note
in `docs/METHODOLOGY.md`. Two consequences: helpers are added because a run
needed them, never in anticipation; and the cache never exposes a field no
event carried, because a field that appears and later becomes trustworthy is a
silent contract change.

**Landing a new event.** `apply()` is a switch on opcode and every world write
goes through `upsertNearby()`. Add the schema in `src/protocol.ts`, add one
`case` in `src/state.ts`, and derive rather than duplicate if it belongs to
`self`. The social families live in `src/protocol-social.ts` and
`src/state-social.ts` instead: the same two steps, one file over in each case.
`src/guid.ts` is the leaf both halves of the protocol import for `guidSchema`;
it exists so `protocol-social.ts` never reaches back into `protocol.ts` at
value level, which is a module-eval cycle `tsc` cannot see.

**Every call crosses the event loop.** A call answered locally (a refusal
that sends nothing, a wait the event buffer already answers) would otherwise
settle in microtasks, and a snippet loop over it starves every timer and IPC
message in the sandbox until the host kills it as blocked. So every method on
the caller's surface, and `events.waitFor`/`waitForOpcode`, settles after one
`setImmediate` when it neither sent a request nor saw a turn pass; a call that
did either is untouched (`src/turn.ts`). The surface is every `WrathClient`
prototype member not in `CLIENT_PLUMBING` (`src/client.ts`), the same list the
API reference generator leaves out, so a new private method goes there.

**Dependencies.** Zod, and only at the external boundary: `src/protocol.ts`
(with `src/protocol-social.ts`) validates module messages and hands plain
TypeScript types to everything downstream. Transport is Bun's built-in `fetch`
and `WebSocket`.
