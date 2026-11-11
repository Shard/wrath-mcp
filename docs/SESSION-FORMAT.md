# The session record format: `wrath-session/1`

A session that goes through the stack's TypeScript layer leaves a **session
record**: what the character did and what happened to it, as files in one
directory. This document is the format of that directory. Its types are
`mcp/src/record/format.ts`, and `mcp/src/record/validate.ts` is the same text
as something that runs: `validateSession(dir)` says what a directory holds
that this document does not allow.

**Unstable until v1 ships.** The format is documented so that any reader or
writer can be built against it, but it is not yet a public contract: it may
change without the version moving until v1 is released. From then on
"Versioning" below applies.

What an agent observes live is `CONTRACTS.md` and is not changed by anything
here. This document governs what is written down.

## Why it is shaped this way

- **JSON Lines throughout.** Every stream is append-only JSONL, one JSON
  object per line. A line is written whole or not at all, so a reader follows
  a session while it is written by remembering a byte offset.
- **Closed segments never change.** A stream is cut into five-minute
  segments. Once a segment's successor exists it is immutable, so capture is a
  copy, pruning is an unlink and compression is a file operation on something
  nobody is writing.
- **Every segment decodes alone.** Each opens with a `key` row that states its
  stream whole, including the dictionary entries its rows need. A reader of
  one window needs that window's file and no earlier one, and a lost segment
  costs its own five minutes.
- **One writer.** The host process of the session writes it. Any number of
  readers read it, and none of them takes a lock.
- **No query layer.** The record is evidence, not a database. Analysis goes
  through a store derived from it.

## The directory

```
<session>/
  session.json            what the session is
  live.json               its last reading, rewritten on every writer tick
  manifest.json           every captured segment, sized and hashed; written when the session closes
  trace/<segment>         the character's own position, state and character sheet
  events/<segment>        what happened to it: zone, level, death, flight, party records, ...
  calls/<segment>         tool calls and results, the action log, movement intentions, event batches served
  nearby/<segment>        the units in view: a live-only ring, removed when the session closes
```

A session store is a directory of these, one per session, each named by its
**session id**: the first 16 hex characters of the SHA-256 of the session
token. That is the stem the module's audit files already use
(`module/PROTOCOL.md`, "Audit log"), so the two join by name. No field of the
record is a token, a secret or an account name, and the writer strikes the
session's own token and the host's registered secrets from every line of
`trace`, `events` and `calls` before it is written, so text an agent printed
cannot put one there either.

A harness that keeps its own evidence per run points the writer at a
directory inside the run instead of at a store. The session directory is the
same either way.

A session is one character's. A client that drives several characters
(fan-out) leaves one session per character, each with its own token and so
its own id, each written from its own client's stream and decodable alone;
nothing in one refers to another.

`session.json`, `live.json` and `manifest.json` are each rewritten whole by
writing a temporary file beside them and renaming it into place, so a reader
never sees half of one.

## Segments

A segment is one stream over one UTC-aligned window of 300 000 ms.

- **Name.** `<t0>.jsonl`, where `<t0>` is the window's start in epoch
  milliseconds, 13 digits, a multiple of 300 000. When a closed segment
  already holds a window and a writer opens that window again (a session
  resumed within five minutes of closing), the new file is `<t0>-<n>.jsonl`
  with `n` counting from 1. Segments sort by `t0`, then by `n`. Anything else
  in a stream directory is not a segment.
- **Rows.** Every line is a JSON object with `ts`, an integer of epoch
  milliseconds, and `kind`, a string. The first row is a `key` row. A `key`
  row may also appear later in a segment (a recorder that restarted states
  itself again), and a reader starts over from each one.
- **Which segment a row is in.** The one that was live when the row was
  written. The writer moves to a new window when a row's `ts`, or its own
  clock, reaches it, and never moves back. A row's `ts` may therefore precede
  its segment's `t0` by the writer's drain interval, a few seconds at most,
  and never reaches the window after its segment's.
- **Order.** In `trace` and `nearby` a segment's rows never go back in time:
  the writer raises a late row's `ts` to the last one it wrote. In `events`
  and `calls` rows are in the order they were written and `ts` is the row's
  own instant, so a reader that wants time order sorts.
- **Closing.** A segment closes when the writer opens its successor, or when
  the session closes. A closed segment of `trace`, `events` or `calls` is then
  compressed with zstd into `<name>.zst` and the plain file removed: the
  compressed file is written under a temporary name, renamed into place, and
  only then is the plain one unlinked. The live segment stays plain so it can
  be followed.
- **Reading.** A reader accepts both forms, and takes the compressed one when
  it finds both. The decompressed bytes are exactly the plain file's, so a
  byte offset into one is an offset into the other.
- **Tears.** A writer that is killed can leave a last line with no newline.
  A reader ignores a final line that has none, and skips any line that does
  not parse to an object. A writer that reopens such a segment ends the torn
  line before writing its key row. Neither is an error; the validator reports
  both as warnings.

A reader follows a stream with a cursor of a segment name (without the
compression suffix) and a byte offset: it reads from the offset to the last
newline, and moves to the next segment once one exists and the current one is
exhausted.

## `session.json`

| Field | Type | Meaning |
|---|---|---|
| `format` | `"wrath-session/1"` | The format and its version. |
| `id` | string, 16 hex | The session id. |
| `character` | object or null | `guid` (string), `name`, `race`, `class`, each of the last three null until observed. Null until the character is in the world. |
| `stack` | object | `version`, the stack's release, and `commit` when the host knew which commit it ran. |
| `module` | object or null | `build` and `protocol` from the module's `GET /health`; null when it did not answer. |
| `owner`, `group` | string, optional | Deployment labels the operator's host sets. Never a harness's ids or configuration. The standalone server sets `group` on every session of a client granted several characters, to one value for that client: the first 16 hex characters of the SHA-256 of the client's own state token, which is no session's. |
| `started` | integer | When the session was first opened. |
| `opened` | integer | When the process now (or last) writing it opened it. |
| `ended` | integer or null | When it closed. Null while a writer holds it, and left null by a writer that died. |

A directory is a session when it holds a `session.json` with this `format`.

## `live.json`

The session's last reading, rewritten on every writer tick, so that a map of
every session opens one small file per session and no trace.

| Field | Type | Meaning |
|---|---|---|
| `ts` | integer | The writer's clock at that tick: its heartbeat. |
| `observed` | integer or null | The newest trace row folded in. |
| `map`, `x`, `y`, `z`, `o` | number or null | The last known position. |
| `level`, `hp`, `hpMax`, `zone`, `area` | number or null | From the trace's state. |
| `flags` | string[] | Those of `combat`, `mounted`, `taxi`, `dead`, `ghost`, `resting` that are set. |
| `stream` | object or null | The child's event stream: `connected`, `events` (how many it has folded) and `seq` (the last). Null when no child is running. |

A session whose `ended` is null and whose heartbeat is old was abandoned by
its writer.

## `trace`

The character's own position, unit state and character sheet, at the cadence
the client observed them. It is the only record of level, XP, money, position
and what is carried: there is no coarser state table beside it.

Row kinds: `key`, `pos`, `state`, `flight`, `dict`.

| Field | On | Meaning |
|---|---|---|
| `ts` | all | The observation's own time. |
| `map`, `x`, `y`, `z`, `o` | `key`, `pos`, `flight` | The last known position on a `key` (null before one is known), the sample on a `pos`, the takeoff point on a `flight`. |
| `data` | `key` | The whole unit state and the whole sheet, every key present. |
| `data` | `pos` | `{ "jump": 1 }` when the character did not travel there continuously (teleport, new world, login, hearth, graveyard, dungeon port); otherwise absent. A reader never interpolates into a jump. |
| `data` | `state` | Only what changed: unit state keys, sheet patches, and the two event lists `qdone` and `chat`. |
| `data` | `flight` | `to` (`map`, `x`, `y`, `z`) and `durationMs`: the spline a taxi flight rides. |
| `dict` | `key`, `dict` | Dictionary entries (below). |

**Unit state.** `null` means not observed, never zero.

| Key | Type | Meaning |
|---|---|---|
| `hp`, `hpMax`, `pw`, `pwMax` | number or null | Health and the power bar. |
| `pwType` | number or null | The raw power type: 0 mana, 1 rage, 3 energy, 6 runic power. |
| `level`, `xp`, `xpMax` | number or null | |
| `auras` | `[spellId, stacks, expiresAt, flags][]` | Sent whole on any change; `expiresAt` is epoch ms, 0 for no expiry. |
| `combat`, `mounted`, `taxi`, `dead`, `ghost`, `resting` | boolean | |
| `zone`, `area` | number or null | Ids only. |
| `target` | object or null | `kind` (`creature`, `player`, `object`, `other`), and for a creature its `entry` and `hpPct`. A player target is `{ "kind": "player" }` and nothing else. |
| `cast` | object or null | `spellId` and `endsAt` (epoch ms) of the cast in progress. |

**The sheet.** `money` (copper) and seven lists, each `null` until observed.
Every list row is an array of numbers keyed by its leading fields.

| List | Row | Key fields |
|---|---|---|
| `equip` | `[slot, itemId, rand?]` | 1 |
| `bags` | `[slot, itemId, numSlots]` | 1 |
| `inv` | `[bag, slot, itemId, count?, rand?]` | 2 |
| `dur` | `[slot, cur, max]` | 1 |
| `quests` | `[slot, questId, state, c0?, c1?, c2?, c3?]` | 1 |
| `rep` | `[factionId, standing]` | 1 |
| `skills` | `[skillId, value, max]` | 1 |

In a `key` row a list is whole. In a `state` row it is a patch: each row that
is new or changed, whole, and a row holding only its key fields for one that
went; `null` puts the list back to unobserved, and a patch after `null` is the
whole list. `inv` is what the server counts toward a quest's items: the
backpack (bag 255), the worn bags, the keyring and the currency slots, never
the bank or the buyback slots. An `itemId` of 0 is an occupied slot whose item
has not been seen yet.

**Events on a state row.** `qdone` is the quest ids the server confirmed
turned in since the last row, and `chat` is the lines the character itself
said as the server echoed them back, each `[kind, text]` with kind one of
`say`, `party`, `raid`, `yell`, `whisper`, `emote` and text at most 255
characters. Neither is state: neither is in a `key` row or a fold, and the
same value twice is two events. A chat line never carries a recipient.

**The dictionary.** `items` is `[itemId, quality, name][]` (the item
template's name, never an instance's suffix or description) and `quests` is
`[questId, [c0, c1, c2, c3, [itemId, count]...]][]`, a quest's required
counts. A segment's `key` row carries the entries its sheet references, and a
`dict` row carries any entry a later row of the same segment needs, ahead of
that row when the entry was known by then. An id whose name the client was
never told has no entry.

## `events`

What happened to the character, each as the packet that carried it or the
cache's stamp for the reading. Kinds are additive.

Every row may carry `seq`, the event stream's sequence number of the packet
behind it.

| Kind | Fields | Meaning |
|---|---|---|
| `key` | `state` | The stream's state, whole: `level`, `zone`, `area`, `map`, `instanceType` (number or null), `dead`, `released`, `taxi` (boolean), `group` (null, or `groupGuid?`, `leaderGuid?`, `members`, `foreign`, `count`). |
| `zone`, `area` | `from?`, `to` | The id changed. `from` is absent on a recorder's first reading. |
| `level` | `from?`, `to`, `xp?` | Likewise. A level gained is a row with a `from`. |
| `death` | `position?`, `zone?`, `area?`, `released?` | Own health reaching zero. `position` has a `source` of `corpse_query` or `death_spot`. |
| `release` | `graveyard?` | The spirit released. |
| `resurrect` | | Alive again. |
| `taxi`, `taxi_landed` | `position?`, `zone?`, `area?` | The taxi flag turning on after an accepted reply, and off. |
| `achievement` | `id`, `name?`, `points?`, `categoryId?` | One of the character's own earns. |
| `achievements_at_login` | `ids`, `points` | The backlog, once per recorder. |
| `spells_at_login` | `ids` | The spellbook as first read, once per recorder. |
| `spell` | `id` | A spell learned after that. |
| `talent` | `id`, `points`, `rank`, `spec?` | A talent whose rank climbed. |
| `trade` | | A completed trade. |
| `quest` | `id` | A turn-in the server confirmed. |
| `group` | `event` (`joined`, `changed`, `left`), `groupGuid?`, `leaderGuid?`, `members`, `foreign`, `count` | The party list changed. `count` includes the character and is 0 on `left`. |
| `instance` | `event` (`entered`, `left`), `map`, `instanceType`, `from` | A map transfer whose instance type changed. |
| `kill` | `killerGuid?`, `victimGuid`, `entry?`, `rank?`, `self`, `member` | A party kill log line for a victim of rank 1 or above. Never a player victim. |

"Once per recorder" means once per process that records: a restarted child or
a resumed session states its baseline again, with a `key` row before it, so a
reader never counts a baseline as a gain.

## `calls`

What the agent asked for and what was sent on its behalf.

| Kind | Fields | Meaning |
|---|---|---|
| `key` | `open` | Every `call` row still without a `result`, whole. |
| `call` | `id`, `origin`, `tool`, `args` | A tool call as dispatched. `id` is its dispatch stamp in epoch ms, strictly increasing per host; `ts` equals it. |
| `result` | `id`, `text`, `error`, `durationMs` | The answer as the caller was handed it. |
| `actions` | `origin`, `actions`, `dropped?` | What one origin put on the wire since the last flush: each action's `ts`, `action`, `args?`, HTTP `status`, `ms`, and the module's `error`, `hint` and `moveId` where it gave them. Consecutive identical dispatches fold into one with `count` and `lastTs`. |
| `move` | `origin`, `at`, `moveId`, `map`, `x`, `y`, `z`, `target`, `name?`, `status` | A movement intention: one row when dispatched (`status` null) and one with the module's verdict. Both carry the same `at`, the dispatch time. `target` is the guid it was aimed at, or null. |
| `events` | `origin`, `count`, `folded?`, `events` | An event batch a call served, as it was shown: each event's `seq`, `ts`, `opcode` and `data`. |

`origin` says what sent something and is left open: an object with a `type`
string and, when a call launched it, that call's `id` as `call`. The types
written today are `tool` (a tool call, or what it sent while it ran),
`routine` (code a call left running after it returned) and `client` (the
SDK's own traffic outside every call). A reader ignores a type it does not
know; `program` is reserved.

A `result` always has its `call` in the same segment or restated in that
segment's key. A call whose process died has no result.

At fan-out a tool call is written to the record of every character it
concerns, under one `id`: the character it named, or, when it named none (a
roll-up, the scratchpad, a snippet that reaches several), every character
logged in at the time. So each session's `calls` holds every call its
character could have acted under, and an `actions` or `move` row's `call` is
always a `call` row of the same session. A `call` whose `args` name another
character is never in this session; one whose `args` name none may be in
several. An `events` row holds what was served from this character's own
stream.

The stack never learns what drove it, so no row carries a turn number, a run
id or anything else of a harness's. A harness joins its own records to these
by time, and a tool call by its dispatch stamp.

## `nearby`

The units the character's client has in view: where each is and is going, and
the fields a map draws them by. Creatures, pets and vehicles only.

It is a ring, not a record. Segments that ended more than 15 minutes ago are
unlinked on every tick, the directory is removed when the session closes, and
nothing in it is compressed, hashed, listed in the manifest or captured.

| Kind | Fields | Meaning |
|---|---|---|
| `key` | `self`, `units` | Every unit in view and the character, whole. |
| `in` | `u` | A unit came into view. |
| `mv`, `pos` | `id`, `m` | A spline or a stop; a position sample. |
| `st` | `id`, `s` | The state keys that changed; `null` for one back to unobserved. |
| `nm` | `id`, `name`, `sub?` | A name answer that landed after `in`. |
| `out` | `id` | The unit left view. |
| `self` | `self` | The self keys that changed. |
| `tick` | | The recorder looked up to `ts` and nothing else changed. |

A unit is `id` (its guid), `ty` (`creature`, `pet`, `vehicle`), `s` (state)
and `m` (motion or null). State keys, all optional: `entry`, `name`, `sub`,
`ctype`, `level`, `hp` (percent), `uf`, `df`, `nf` (unit, dynamic and NPC
flags), `qg` (questgiver marker), `tg` (its target), `tgs` (whether that is
this character), `ow`, `ch` (owner, charmer), `disp`, `scale`, `mf`. A motion
is `k` (`pos` or `mv`), `t` (the packet's own time), `p` (`[x, y, z]` or
`[x, y, z, o]`), and for a spline `to` and `ms`. `self` is `guid`, `map`,
`target` and `down`.

## Other players

The store holds NPCs, objects and the deployment's own sessions, each from
its own session's record. A player who is not one of those sessions is never
written in a field the format defines, and free text is scrubbed of them,
best-effort (below). "Own" means the session's own character, another
character of the same client (a fan-out seat), or a character guid in the
`session.json` of another session of the same deployment; a player guid the
writer cannot place is foreign.

These rules are applied at one place, the writer's gate
(`mcp/src/record/gate.ts`), to every row before it reaches a file:

| Where | Rule |
|---|---|
| `nearby` units | No player unit is written, own or foreign. A unit that a player other than the session's own character owns or charms is not written either. |
| `nearby` `tg`, `self.target` | A player's guid is replaced by the string `"player"`. |
| `trace` `target` | A player target is its kind only: no entry, no health. |
| `trace` `chat` | The character's own lines; unchanged. |
| `events` `group` | Own member guids are kept in `members`; the rest are counted in `foreign`. A foreign `leaderGuid` is left out. |
| `events` `kill` | A foreign `killerGuid` is left out; `self` and `member` still say whose kill it was. |
| `calls` `move` | `target` is null, and `name` absent, for a foreign player. |
| `calls` free text | Scrubbed, best-effort; below. |

**Free text** is scrubbed rather than ruled: a `call`'s `args`, a `result`'s
`text`, an `actions` row's notes, an `events` batch, and the calls a `key`
row restates. The gate knows the players the session's client was answered
names for (`SMSG_NAME_QUERY_RESPONSE`, which a client asks for every player
it sees), and at fan-out those of every character of the same client; it
holds them in memory and never writes them. Once the session's own character
is known, in every string of those rows, object keys included, a whole token
that names one of them who is foreign is replaced by `"player"`: a run of
digits equal to the guid, or a run of letters equal to the name as the
server answered it. Own or foreign is asked as each row is written.

It is best-effort over prose, and says so. A number or a word that happens
to equal a foreign player's guid or name is replaced too; a name spelled
another way, a player the client was never answered for, or a guid in a JSON
number is missed. On a world with no foreign players it changes nothing, and
the record is what the agent saw. Keeping an evaluation apart from other
players is done by giving it a world of its own, not by this scrub.

**The module's audit log** records every event served, other players
included, and is not part of this format.

## The manifest

`manifest.json` is written when a session closes: `format`, `id`, `written`,
and `segments`, one entry per file of `trace`, `events` and `calls` with its
`stream`, `file` (as on disk, compression suffix included), `bytes` and
`sha256` of the stored bytes. It is what a capture is checked against. The
ring and `live.json` are not in it. A session that was resumed and closed
again has its manifest rewritten to cover everything.

## Retention

A store prunes whole sessions, by unlinking, and only closed ones: a session
whose `ended` is older than the retention window, or one whose writer died
and whose heartbeat (`live.json` `ts`, else `opened`) is older than it. A
session someone is writing is never pruned. A session directory inside a
harness's run is the harness's to keep.

## Versioning

The version is the number in `format`. It moves when a reader of the old
version would misread a new record: a field's meaning changes, a field a
reader needs is removed, or the layout of the directory changes. It does not
move for an addition: a new row kind, a new optional field, a new `origin`
type or a new file. A reader therefore ignores row kinds, fields and files it
does not know.

A harness that scores from the record should also note which stack recorded
it, because a recorder can change what a row means without changing its
shape; `session.json` carries `stack.version` and `stack.commit` for that.
