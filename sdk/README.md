# @wrathbench/sdk

The surface the model programs against. Thin typed wrappers over the module's
HTTP/WebSocket protocol (`module/PROTOCOL.md`), a typed event stream, and a
state cache built purely from events.

The SDK's public shape is part of the harness version (`docs/ARCHITECTURE.md`).
Adding to it is a minor bump. Changing or removing anything exported from
`src/index.ts` is a major bump and wants an ADR under `docs/decisions/`. Two
consequences worth stating: helpers are added because a run needed them, never
in anticipation; and the cache never exposes a field no event carried, because
a field that appears and later becomes trustworthy is a silent contract change.

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

`connect` opens the event subscription *before* any session exists, on purpose:
`POST /session` blocks for the whole login handshake, so `SMSG_CHAR_ENUM` and
`SMSG_LOGIN_VERIFY_WORLD` arrive while that call is still in flight. Subscribing
first is what makes the state cache complete.

### Client

```ts
connect(options: ConnectOptions): Promise<WrathClient>

class WrathClient {
  readonly token: string
  readonly baseUrl: string
  readonly events: EventStream
  readonly state: StateCache

  health(): Promise<HealthResponse>                                   // GET /health
  createSession(req: Omit<CreateSessionRequest, "token">): Promise<SessionResponse>  // POST /session
  say(text: string): Promise<ActionResponse>                          // POST /action
  moveToAsync(target: MoveTarget): Promise<MoveToResponse>            // POST /action, ack only
  stop(): Promise<ActionResponse>                                     // POST /action
  face(orientationOrPoint: number | { x, y }): Promise<FaceResponse>  // POST /action
  deleteSession(): Promise<DeleteSessionResponse>                     // DELETE /session
  logout(): Promise<DeleteSessionResponse>                            // alias
  close(): void                                                       // closes the stream only

  // quest/combat extension: one method per single-opcode action
  setTarget(guid) / clearTarget()
  attackStart(guid) / attackStop()
  castSpell(spellId, targetGuid?) / cancelCast(spellId)
  interact(guid) / gossipHello(guid) / gossipSelect(guid, menuId, optionId)
  questList(guid) / questDetails(guid, questId) / questAccept(guid, questId)
  questComplete(guid, questId) / questChooseReward(guid, questId, rewardIndex?) / questAbandon(questId)
  loot(guid) / lootAll(guid) / lootItem(slot) / lootMoney() / lootRelease(guid)
  vendorList(guid) / buyItem(guid, itemId, slot, count?) / sellItem(guid, itemGuid, count?) / repairAll(guid)
  useItem(bag, slot, targetGuid?) / destroyItem(bag, slot, count?)
  trainerListAsync(guid) / trainerBuySpellAsync(guid, spellId)
  repop() / reclaimCorpse(guid?, options?) → { status: reclaimed | not_reclaimed | unconfirmed, reason: too_far | delay_not_elapsed | wrong_map | no_corpse | still_ghost … } (waits out SMSG_CORPSE_RECLAIM_DELAY itself; state.self.corpse / graveyard say where to walk) / spiritHealerActivate(guid)
  deleteCharacter(name, o?: DeleteCharacterOptions): Promise<CharacterDeleteResponse>  // POST /character-delete

  // composed helpers — each waits for the game's verdict
  waitForChat(match: string | ((e: ChatEntry) => boolean), o?: WaitForChatOptions): Promise<ChatEntry>
  moveTo(target: MoveTarget, o?: MoveToOptions): Promise<MoveResult>
  waitForNearby(p: (o: NearbyObject) => boolean, o?: WaitForNearbyOptions): Promise<NearbyObject>
  killTarget(guid, o?: KillTargetOptions): Promise<KillResult>
  lootCorpse(guid, o?: LootOptions): Promise<LootResult>
  questsAvailableFrom(npcGuid, o?: QuestOptions): Promise<{ ok: true; quests: readonly OfferedQuest[] }>
  acceptQuestFrom(npcGuid, questId, o?: QuestOptions): Promise<QuestAcceptResult>
  turnInQuest(npcGuid, questId, rewardIndex?, o?: QuestOptions): Promise<QuestTurnInResult>
  waitForQuestObjective(questId, o?: QuestOptions): Promise<QuestLogEntry>
  trainerList(npcGuid, o?: TrainerOptions): Promise<TrainerListResult>
  buySpell(npcGuid, spellId, o?: TrainerOptions): Promise<BuySpellResult>
  equipItem(bag, slot, o?: EquipOptions): Promise<EquipItemResult>
  get selfKey(): string | undefined
}
```

Every guid — state fields, helper returns, and every guid argument — is an
opaque decimal string (ADR-0017), which is also exactly what the wire carries:
compare with `===`, use as Map keys, `JSON.stringify` freely. A `number` guid
is rejected loudly (precision loss); a bigint you conjure yourself is converted
for you.

### Combat, loot and quests

```ts
// { ok, status, guid, swings, healthPct, attacking, detail }
const fight = await client.killTarget(kobold.guid, { abortBelowHealthPct: 35 });
if (fight.ok) await client.lootCorpse(kobold.guid);      // { ok, status, gold, items, window }
if (fight.attacking) await client.attackStop();          // it left us swinging
```

`killTarget` owns the whole melee loop, and each part of it is there because a
live run needed it: a synthesized character never auto-faces the way a client
does and the server drops a swing that is not facing its victim, so the target
is faced before the first swing and re-faced every ~1.5s; the character walks
into melee range before that first swing and is walked back whenever the target
drifts out of it; our own death ends it at once. Statuses are `killed` (the
target's observed health reached zero), `player_died`, `lost` (it left view
alive), `timeout`, and `aborted_low_health` when `abortBelowHealthPct` was given
and our own health fell under it. There is deliberately no `evaded`: nothing on
the whitelist says "evade", and naming a status the module never uttered would
be an SDK invention in a field that otherwise only holds the world's words.

The one thing to know before composing with it: a single `CMSG_ATTACKSWING`
makes the server swing until it is cancelled, and moving does not cancel it. So
`killTarget` sends `attack_stop` only when the fight is over (`killed`,
`player_died`, `aborted_low_health`) or when `disengage: true` was passed —
`timeout` and `lost` leave the character swinging, because disarming a
half-fought mob is how a character dies standing still. `attacking` says which
happened and `detail` says it in words. If the server cancels our auto-attack
mid-fight (`SMSG_ATTACKSTOP` with the target still alive), the loop swings
again. The default `timeout` is 25s, deliberately under the runner's 30s
snippet cap; longer fights belong in a background routine.

`lootCorpse` sends `loot_all` — the module replaying the client's auto-loot
sequence — and returns once the window has been emptied and released. Its
`items` are what `SMSG_ITEM_PUSH_RESULT` confirmed *stored*, not what the
window displayed (the window is an offer; the pushes are the receipt — ADR-0016
forbids reporting a possible no-op as success). The window contents ride along
as `window`. A corpse with nothing on it releases without ever opening a
window, which is `{ ok: false, status: "empty" }`: an answer, not a failure.
A window that showed items of which not one entered a bag — bags full, or a
broken store path — is `{ ok: false, status: "none_stored" }`. Silence still
throws `EventTimeoutError`.

`questsAvailableFrom` is that same send-and-wait with none of the accepting:
it returns whatever the NPC offers right now, `{ ok: true, quests: [...] }`,
and an empty list is an answer rather than an error. It exists because models
kept rebuilding it by hand over `questList` plus event scraping and getting
confused by their own nulls (FOLLOW-UPS 9a).

`acceptQuestFrom` reads the quest log *first*, because a turn-in chain may
already have added the quest (the core auto-advances, so an explicit accept can
be a no-op) — that is `status: "already_in_log"`. Otherwise it asks, and
accepts the list in either shape: a gossip-flagged questgiver answers
`quest_list` with an `SMSG_GOSSIP_MESSAGE` carrying the quests, not an
`SMSG_QUESTGIVER_QUEST_LIST`. `turnInQuest` handles the other branch of the
same asymmetry: `SMSG_QUESTGIVER_REQUEST_ITEMS` that says the quest *is*
completable is the client's cue to send the completion again. The completion
wait races `SMSG_INVENTORY_CHANGE_FAILURE`: a reward that does not fit is
answered with that failure and no completion at all, so a full bag comes back
as `{ ok: false, status: "inventory_full", hint }` instead of burning the
whole timeout (the quest stays in the log; free a slot and turn in again).

`waitForQuestObjective` waits on the **quest log**, not on an event, because at
the pinned commit the core sends no `SMSG_QUESTUPDATE_COMPLETE` for a kill
objective: the only thing that reports one to a client is the completion bit in
the served quest-log state field.

`trainerList` asks a trainer what it teaches and derives two things per row
that are not on the wire: `learnable` (the server's own green state, via the
single `TRAINER_SPELL_STATE` mapping) and `affordable` (observed money against
`cost`, `undefined` while money is unobserved — never guessed). They are
independent: the server's state says nothing about money, so a green spell can
still fail to buy. The core's handler answers nothing at all when the NPC is
out of interact range, is not a trainer, or trains another class, so all three
arrive as an `EventTimeoutError` saying so. `buySpell` races
`SMSG_TRAINER_BUY_SUCCEEDED` against `SMSG_TRAINER_BUY_FAILED` for the spell
id and returns `{ status: "learned" }` or `{ status: "buy_failed", reason,
hint }` — the raw reason plus one actionable sentence, never an exception,
because a refusal is the game answering.

`deleteCharacter` retries on its own, and that belongs in the SDK rather than
in a caller: for up to about a minute after logout the core still tracks an
offline session for the character and silently ignores `CMSG_CHAR_DELETE`,
which surfaces as `504 timeout` (or as an aborted request, if the module's
internal wait outlasts `requestTimeoutMs`). `account_in_use` is the same
not-yet-released transient seen from the other side. All three mean "not
released yet" and are retried with a fresh throwaway token each time; anything
else the module says (`character_not_found`, a `char_delete_failed_code_<N>`)
is a real answer and is thrown.

`ConnectOptions`: `baseUrl`, `token`, and optionally `eventsUrl`,
`subscribeEvents` (default true), `requestTimeoutMs` (default 30000 — the
session call blocks up to 20s server-side), `fetchImpl`, `events` (stream
options), `state` (`chatTail`, `notificationTail`).

Helpers stop here because this is what the probes and `infra/smoke/one-quest.ts`
have actually needed. Nothing is added in anticipation.

### Movement

```ts
const result = await client.moveTo({ x, y, z }, { timeout: 90_000 });
if (result.ok) console.log("arrived at", result.position);
else console.log("did not get there:", result.status, "stopped at", result.position);
```

`moveTo` takes a point, a unit from `state.units(...)`/`state.closest(...)`, or
a guid — the unit forms resolve to that unit's position in the state cache at
call time, and a guid nothing in view answers to comes back as `ok: false,
status: "unknown_target"` with a hint, the one arm with no move (and so no
`moveId`/`position`) behind it. `moveToAsync` takes the same targets and is the
call for a walk longer than your own time budget: dispatch, then watch
`WB_MOVE_RESULT`.

`moveTo` issues `move_to`, then resolves on the `WB_MOVE_RESULT` carrying the
same `moveId`. **Game outcomes are returned, not thrown** (`docs/decisions/ADR-0011`):
`arrived` is `ok: true` (with `meshZ` when the mesh walked to a different z
than asked); `too_far`, `no_mesh`, `target_off_mesh`, `start_off_mesh`,
`path_incomplete` (with `reachedPos`), `interrupted`, `stopped` and
`superseded` are `ok: false` with the status intact and a per-status `hint`,
and *every* one of them carries the server-confirmed position the character
actually ended at. A
snippet that forgets a `try` should not lose a run to a wall, and "there is no
path there" is an answer, not an error.

Two things still throw:

- `WrathRequestError` — the request was refused before anything moved
  (`missing_position`, `not_in_world`, …).
- `EventTimeoutError` — no result arrived within `timeout` (default 90s: the
  ~250yd single-move cap is ~36s of running, plus the module's server-confirmation
  deadline). That is the *absence* of an outcome — the character may still be
  walking — so it is not dressed up as a `status`.

A `moveTo` issued while another is running supersedes it, and the older call
returns `status: "superseded"`. `stop()` returns as soon as the module has
queued the `MSG_MOVE_STOP` — it does *not* wait for the character to halt; it is
the in-flight `moveTo` that resolves, with `status: "stopped"`, once the stop
has landed. Read the position off that result rather than off the cache right
after `await client.stop()`.
`face()` takes an absolute orientation in radians or a point, and is refused
with code `moving` while a move is running.

`waitForNearby` waits on the *cache*, not on one event: a named creature takes a
create block plus the creature-query answer the module fired on first sight, so
no single event answers "is there a named creature nearby".

### Errors: two channels, not quite two transports

- `WrathTransportError` — the request got no readable answer: socket refused,
  timeout, non-JSON body, a 2xx body that does not match the protocol.
- `WrathRequestError` — the module answered `{ ok: false }`. Carries `status`,
  `code`, `body`, and `kind`:
  - `kind: "request"` — your call was wrong (`token_in_use`, `no_session`,
    `not_in_world`, `unsupported_action`, …).
  - `kind: "game"` — the *server* decided (`char_create_failed_code_<N>` — the
    numeric code is parsed out into `charCreateResultCode` — plus `login_failed`
    and `timeout`). These come back as HTTP only because `POST /session` is
    synchronous; the same outcome is also on the event stream.

Everything the server decides *after* an action is acked never appears as an
error at all. It arrives as an event, because that is how a client would learn
of it — a muted `say` is a `SMSG_NOTIFICATION`, not a 4xx.

Unknown error codes parse fine; `ErrorCode` is a widened string union so a new
module code costs autocompletion, not correctness.

### Event stream

```ts
class EventStream implements AsyncIterable<StreamEvent> {
  connect(): Promise<void>
  close(): void
  get connected(): boolean
  get gaps(): number

  on(opcode, handler): Unsubscribe        // typed per opcode
  once(opcode, handler): Unsubscribe
  onAny(handler): Unsubscribe
  waitFor(predicate, o?: WaitForOptions): Promise<StreamEvent>
  waitForOpcode(opcode, o?: WaitForOptions): Promise<EventByOpcode[K]>
  recent(limit?: number): StreamEvent[]
  ingest(frame: string): void             // feed a raw frame (replay / tests)
  [Symbol.asyncIterator]()                // from subscription forward
}
```

Every event carries `seq`, `opcode`, `opcodeId`, `ts`, `data`, exactly as
PROTOCOL.md defines them.

`waitFor` searches the retained buffer (default 500 events) *before* waiting,
so a wait issued after an action was acked can still find an event that arrived
during the call. `{ sinceSeq }` bounds how far back it looks;
`{ includeBuffered: false }` turns history off; `{ timeout }` (default 10s)
rejects with `EventTimeoutError`; `{ signal }` accepts an `AbortSignal`.

Three ways an event can be less than fully typed, none of which drop it:

- `data` is `{ decodeError: true }` — the module could not decode a whitelisted
  packet. Use `isDecodeError(event.data)`.
- `schemaError` is set — the opcode is whitelisted but the payload did not match
  this SDK revision's schema. `isEvent(event, opcode)` returns false for these,
  so narrowing gives you real fields or nothing.
- the opcode is unknown to this revision — it arrives as an `UnknownEvent` with
  `data` unvalidated, so an SDK built against today's whitelist keeps streaming
  when the whitelist widens.

Two synthetic opcodes, lowercase so they can never collide with an `SMSG_*`:

- `stream_gap` — the stream reconnected across a hole. `data` is
  `{ fromSeq, toSeq, missing }`. Never suppressed: a cache is only as
  trustworthy as the stream it was fed. A `seq` that *restarts* (the session was
  torn down and recreated under the same token) is re-baselined, not reported
  as a gap.
- `stream_error` — a frame arrived that was not a readable event envelope.

### State cache

`client.state` is a `StateCache`: a pure fold over the stream.

```ts
state.self          // { guid, name, level?, position?, health?, power?, fields }
state.characters    // Observed<CharacterSummary[]> | undefined  (from SMSG_CHAR_ENUM)
state.names         // Map<guidKey, Observed<string>>            (from SMSG_NAME_QUERY_RESPONSE)
state.creatures     // Map<entry, Observed<CreatureInfo>>        (from SMSG_CREATURE_QUERY_RESPONSE)
state.items         // Map<itemId, Observed<ItemInfo>>          (from SMSG_ITEM_QUERY_SINGLE_RESPONSE)
state.nearby        // Map<guidKey, NearbyObject>                (from SMSG_UPDATE_OBJECT, MSG_MOVE_*, SMSG_MONSTER_MOVE)
state.questLog      // QuestLogEntry[]   — derived from the raw quest<slot><Off> fields
state.quest(id)     // one quest log slot, or undefined
state.inventory     // InventoryItem[]   — invSlot halves joined to items and names
state.bag()         // { items: [{ bag, slot, itemId, name, count, guid }], freeSlots }
state.questCompletions, state.questsCompleted  // turn-ins seen (SMSG_QUESTGIVER_QUEST_COMPLETE)
state.money, state.xp, state.nextLevelXp   // Observed<number> | undefined (self only)
state.target        // the NearbyObject our own targetGuid points at, when in view
state.aurasOf(guid) // AuraEntry[]       (from SMSG_AURA_UPDATE / _ALL)
state.chat          // readonly ChatEntry[]  (bounded tail)
state.notifications // readonly NotificationEntry[]
state.motd          // Observed<string[]> | undefined
state.gaps          // readonly GapRecord[]  — non-empty means incomplete
state.anomalies     // readonly Anomaly[]    — non-empty means contradictory
state.lastSeq, state.eventCount
state.nameOf(guid), state.snapshot()

state.nearbyUnits()          // objects a create block typed unit or player
state.creaturesByEntry(id)   // units whose observed template entry is `id`
state.closest(filter?)       // nearest object with a position, from ours
StateCache.replay(events, { seed })
```

`questLog`, `inventory`, `money`, `xp`, `nextLevelXp` and `target` are *derived
on read* from `self.fields` rather than kept as a second copy written by a
second path. There is one write seam (the field merge), so replay-equals-live
holds for them for free. The wire's shape is preserved on the way in
(ADR-0013): the module serves `quest3State` and `invSlot23Lo` as raw per-u32
fields and this is where they are folded.

- A quest slot's four objective counters are two u32s of packed u16s, split
  into `counts[0..3]`. The log carries the *current* counts only — `required`
  lives on `SMSG_QUESTUPDATE_ADD_KILL` and the quest details — so nothing here
  compares them, and `complete` is the state field's own bit.
- `questNId === 0` is an empty slot and does not become a quest with id 0.
- An inventory slot is a three-way join: the two u32 guid halves, the item's
  own create block (for `entry`), and an item query (for the name). Each leg
  can be missing, and a slot whose item has not been created for us yet is
  still reported — it *is* occupied — with `itemId` and `name` undefined.
- `bag()` is the backpack view of `inventory`, shaped for acting on it:
  `bag`/`slot` are exactly what `equipItem`, `useItem` and `destroyItem` take
  (bag 255, slots 23-38), `count` is the observed stack count, and `freeSlots`
  counts the backpack slots holding nothing. Earned surface (ADR-0015):
  morning-opus-1 rebuilt this from push-result listeners, invSlot regexes and a
  full relog when it was already in the cache. Two caveats: empty slots are
  zero fields the wire compresses away, so before our own create block arrives
  `freeSlots` reads 16; and equipped bags' contents (slots 19-22) are container
  fields no whitelisted opcode serves — only the backpack is reported.
- `pointOf(obj)` answers "where do I walk to reach it" from the freshest of the
  two independent sources: an oriented position (update blocks, `MSG_MOVE_*`)
  or `SMSG_MONSTER_MOVE`'s destination, which is what a player reads off a
  moving creature's animation.

Every observed field group is an `Observed<T> = { value, seq, ts }`, so
staleness is legible rather than implied. That matters most for position: our
own is written by `SMSG_LOGIN_VERIFY_WORLD`, then by our own create block, then
by every `WB_MOVE_PROGRESS` while we walk and by the server-confirmed
`WB_MOVE_RESULT` at the end — and between events it is stale, which the `seq`
says out loud.

The three queries are pure reads. `closest` returns `undefined` when we have no
position of our own, rather than guessing one. They hand back the live cache
entries; `snapshot()` is the frozen copy.

#### How an object in view is built

`create` blocks populate a `NearbyObject`, `values` deltas merge **per field**
(each field keeps the `seq`/`ts` of the block that carried it, so a health
number and the max it is out of can be minutes apart and say so), `movement`
blocks and `MSG_MOVE_*` update positions, `outOfRange` lists and
`SMSG_DESTROY_OBJECT` prune. A `near` block is *not* a removal and does not
prune. `names` and `creatures` are never pruned: the module will not re-issue a
query for an entry it already asked about, so a creature that walks away and
comes back would otherwise be permanently nameless.

Three consequences of "nothing is invented" worth knowing before you read a
field:

- `NearbyObject.position` is a `UnitPosition` (`x,y,z,o`) with **no map id** —
  nothing on the wire carries one for another object. Only `self.position` has
  a `map`, carried from the last `SMSG_LOGIN_VERIFY_WORLD`.
- `health`/`power` are set only when *every* part has been observed. A `values`
  delta routinely carries `health` without `maxHealth`, and which of
  `power1..7` is the character's power depends on `powerType`. Half a gauge is
  not a gauge. The raw parts are always in `obj.fields`, which is where to look
  when a gauge is `undefined`. (Seen live: a level-1 warrior's create block
  carries `powerType: 1` and `maxPower2` but no `power2`, because the current
  value is 0 and zero fields are not in the update mask — so `power` stays
  `undefined` until the first change.)
- A `create` block flagged `self` whose guid contradicts the seeded identity
  does **not** overwrite `self`. It is recorded on `state.anomalies` and filed
  as an ordinary object in view, because the cache cannot tell which of the two
  is wrong and picking silently would make it disagree with the trajectory log.

Two rules the tests enforce:

1. **Nothing is invented** (`docs/CONTRACTS.md`). A field exists only if an
   event carried it: an incomplete gauge stays `undefined` rather than being
   half-filled, an object with no `create` block has no `objectType` (and so is
   not a unit), and a chat sender does not become a nearby object — knowing who
   spoke is not knowing who is in range. A guid learned from a name query goes
   in `names`, which claims nothing spatial.
2. **Replayable.** `StateCache.replay(events, { seed })` reproduces the live
   cache exactly. The one input that is not an event is the seed — our own guid
   and name, which arrive in the `POST /session` response because no `SMSG_*`
   says "you are guid N". It is recorded on `state.seed` so a replay is explicit
   about it.

**Extension point.** `apply()` is a switch on opcode and every world write goes
through `upsertNearby()`. Landing a new event means: add the schema in
`src/protocol.ts`, add one `case` in `src/state.ts`, and derive rather than
duplicate if it belongs to `self`. Unknown opcodes,
unknown update-block kinds and unknown `data` fields all already pass through
rather than failing, so an SDK built against today's whitelist keeps streaming
when the module's widens.

## Running things

```bash
bun test sdk                 # the whole suite, no game stack needed
bunx tsc --noEmit -p sdk     # strict typecheck of src, test and examples

# live checks, need the stack up; not part of bun test
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-slice.ts
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-move.ts
```

`live-move.ts` is the movement/observation slice end to end: session, wait for a
named creature to arrive on the update stream, walk ~30y toward it, print the
server-confirmed arrival and the closest creature, log out. It retries patiently
while the worldserver is restarting.

Tests run against an in-process `Bun.serve` stub (`test/server.ts`) that speaks
the same HTTP and WebSocket shapes and replays fixture frames. All fixtures are
hand-written from PROTOCOL.md with invented names — nothing is captured from a
running game (`CLAUDE.md`).

## Dependencies

Zod, and only at the external boundary: `src/protocol.ts` validates module
messages and hands plain TypeScript types to everything downstream. Transport is
Bun's built-in `fetch` and `WebSocket`.
