#!/usr/bin/env bun
/**
 * Emit `sdk/API.md` from the public `WrathClient` + `StateCache` surface.
 *
 * The doc is the model's reference for exact signatures, so it must never drift
 * from the code and must never advertise a method that does not exist (ADR-0015
 * recorded models burning turns inventing `mineRock`-shaped helpers). This
 * generator is therefore self-checking against the *live* prototypes:
 *
 *   - every documented member must exist on the prototype (no invented rows),
 *   - every public prototype member must be documented or explicitly listed as
 *     internal plumbing (no silent undocumented surface),
 *
 * so adding a public method without a row here fails the build, and renaming or
 * removing one fails it too. The signature/purpose text is curated (runtime
 * introspection cannot recover TypeScript types); the *names* are verified.
 *
 * Output is deterministic — no date, no version, stable ordering — so
 * `docs:api:check` (regenerate + `git diff --exit-code`) only ever fires on a
 * real surface change or a hand-edit.
 *
 * Run: `bun run docs:api` (writes the file) — from anywhere; the path is
 * resolved from this file, not the cwd.
 */

import { join } from "node:path";
import {
  WrathClient,
  StateCache,
  EventStream,
  KNOWN_ERROR_CODES,
  TRAINER_SPELL_STATE,
  WrathRequestError,
  WrathTransportError,
} from "./src/index";
import { EventAbortedError, EventTimeoutError } from "./src/events";

/** One documented member: its name (verified against the prototype), signature, and one-line purpose. */
interface Row {
  /** The exact prototype member name — cross-checked at generate time. */
  readonly name: string;
  /** Full call signature as it appears in the source. */
  readonly sig: string;
  /** One line: what it does. No strategy. */
  readonly purpose: string;
}

// --------------------------------------------------------------- client rows

/**
 * Session, connection and query endpoints: they return their HTTP answer
 * directly (createSession blocks server-side up to 20s for the login verdict),
 * so they are neither "ack-only" raw actions nor event-waiting helpers.
 */
const CLIENT_ENDPOINTS: readonly Row[] = [
  { name: "createSession", sig: "createSession({ character, race?, class? }): Promise<SessionResponse>", purpose: "Create or reuse the character and enter the world; blocks until in-world or failed." },
  { name: "deleteSession", sig: "deleteSession(): Promise<DeleteSessionResponse>", purpose: "Log the character out (a client-style disconnect)." },
  { name: "logout", sig: "logout(): Promise<DeleteSessionResponse>", purpose: "Alias for deleteSession()." },
  { name: "deleteCharacter", sig: "deleteCharacter(character, options?): Promise<CharacterDeleteResponse>", purpose: "Delete a character by name through the real delete path, with the module's required retries." },
  { name: "health", sig: "health(): Promise<HealthResponse>", purpose: "Module and world status; no auth, not session-scoped." },
  { name: "close", sig: "close(): void", purpose: "Close the event stream; does not log the character out." },
  { name: "selfKey", sig: "get selfKey: string | undefined", purpose: "Our own guid once the session response has seeded it." },
];

/** Helpers: they wait for the game's verdict and return it as a value (ADR-0011). */
const CLIENT_HELPERS: readonly Row[] = [
  { name: "moveTo", sig: "moveTo(point, options?): Promise<MoveResult>", purpose: "Walk to a world position and wait for the server's arrive/target_off_mesh/… verdict." },
  { name: "killTarget", sig: "killTarget(target: GuidOrUnit, options?): Promise<KillResult>", purpose: "Approach and auto-attack until the target or we drop; returns how the fight ended." },
  { name: "lootCorpse", sig: "lootCorpse(target: GuidOrUnit, options?): Promise<LootResult>", purpose: "Empty a corpse and report what actually entered the bags (confirmed pushes, not the window)." },
  { name: "acceptQuestFrom", sig: "acceptQuestFrom(npcGuid: GuidOrUnit, questId, options?): Promise<QuestAcceptResult>", purpose: "Take a quest from an NPC and confirm it landed in the quest log." },
  { name: "turnInQuest", sig: "turnInQuest(npcGuid: GuidOrUnit, questId, rewardIndex?, options?): Promise<QuestTurnInResult>", purpose: "Hand a finished quest back and take a reward." },
  { name: "questsAvailableFrom", sig: "questsAvailableFrom(npcGuid: GuidOrUnit, options?): Promise<{ ok, quests }>", purpose: "What an NPC is offering right now; an empty list is an answer, not an error." },
  { name: "trainerList", sig: "trainerList(npcGuid: GuidOrUnit, options?): Promise<TrainerListResult>", purpose: "What a trainer teaches, each row with derived learnable/affordable." },
  { name: "buySpell", sig: "buySpell(npcGuid: GuidOrUnit, spellId, options?): Promise<BuySpellResult>", purpose: "Learn one spell from a trainer for money; returns learned or buy_failed." },
  { name: "learnTalent", sig: "learnTalent(talentId, rank, options?): Promise<LearnTalentResult>", purpose: "Spend a talent point (rank is 0-based) and read the verdict off the SMSG_TALENTS_INFO answer; returns learned or not_learned with the new state.talents()." },
  { name: "waitForChat", sig: "waitForChat(match: string | (entry) => boolean, options?): Promise<ChatEntry>", purpose: "Wait for a chat line matching a string or predicate." },
  { name: "waitForNearby", sig: "waitForNearby(predicate: (obj) => boolean, options?): Promise<NearbyObject>", purpose: "Wait until an object in view satisfies the predicate." },
  { name: "waitForTransfer", sig: "waitForTransfer({ timeout?, sinceSeq?, expectMap? }): Promise<TransferResult>", purpose: "Wait for a map transfer's server verdict: transferred (SMSG_NEW_WORLD) / aborted / waiting / no_transfer / wrong_map. moveTo already does this when a portal takes the character." },
  { name: "waitForQuestObjective", sig: "waitForQuestObjective(questId, options?): Promise<QuestLogEntry>", purpose: "Wait until the quest log marks a quest's objectives complete." },
];

/**
 * Raw actions: one opcode each, acknowledged by HTTP; the game's outcome (a
 * cast failure, a gossip menu, a loot window) arrives on the event stream.
 * A few take a `GuidOrUnit` (`interact`) or resolve a gossip option by text —
 * that is argument convenience, not verdict-waiting; the RAW label is only
 * about where the outcome lands.
 */
const CLIENT_RAW: readonly Row[] = [
  { name: "say", sig: "say(text): Promise<ActionResponse>", purpose: "Say something in local chat." },
  { name: "moveToAsync", sig: "moveToAsync(point): Promise<MoveToResponse>", purpose: "Queue a move without waiting; prefer moveTo, which waits for the verdict." },
  { name: "stop", sig: "stop(): Promise<ActionResponse>", purpose: "Queue a movement stop; the in-flight moveTo resolves with status 'stopped'." },
  { name: "face", sig: "face(orientationOrPoint: number | { x, y }): Promise<FaceResponse>", purpose: "Turn in place toward an orientation (radians) or a point." },
  { name: "setTarget", sig: "setTarget(guid: GuidArg): Promise<ActionResponse>", purpose: "Set the current target (guid string only)." },
  { name: "clearTarget", sig: "clearTarget(): Promise<ActionResponse>", purpose: "Clear the current target." },
  { name: "attackStart", sig: "attackStart(guid: GuidArg): Promise<ActionResponse>", purpose: "Start melee auto-attack (guid string only)." },
  { name: "attackStop", sig: "attackStop(): Promise<ActionResponse>", purpose: "Stop melee auto-attack." },
  { name: "castSpell", sig: "castSpell(spellId, targetGuid?: GuidArg): Promise<ActionResponse>", purpose: "Cast a spell; no target means self/auto-target." },
  { name: "cancelCast", sig: "cancelCast(spellId): Promise<ActionResponse>", purpose: "Cancel a cast in progress." },
  { name: "interact", sig: "interact(target: GuidOrUnit): Promise<ActionResponse>", purpose: "Use a gameobject — chest, door, quest object (accepts a unit or its guid)." },
  { name: "gossipHello", sig: "gossipHello(guid: GuidArg): Promise<ActionResponse>", purpose: "Open an NPC's gossip menu (guid string only)." },
  { name: "gossipSelect", sig: "gossipSelect(guid: GuidArg, option: string | number) | gossipSelect(guid, menuId, optionId): Promise<ActionResponse>", purpose: "Choose a gossip option by visible text (from the last observed menu) or by numeric ids." },
  { name: "questList", sig: "questList(guid: GuidArg): Promise<ActionResponse>", purpose: "Ask an NPC for its quest list." },
  { name: "questDetails", sig: "questDetails(guid: GuidArg, questId): Promise<ActionResponse>", purpose: "Request a quest's text." },
  { name: "questAccept", sig: "questAccept(guid: GuidArg, questId): Promise<ActionResponse>", purpose: "Accept a quest (prefer acceptQuestFrom, which confirms)." },
  { name: "questComplete", sig: "questComplete(guid: GuidArg, questId): Promise<ActionResponse>", purpose: "Ask to complete a quest (prefer turnInQuest, which waits)." },
  { name: "questChooseReward", sig: "questChooseReward(guid: GuidArg, questId, rewardIndex?): Promise<ActionResponse>", purpose: "Choose a quest reward by index." },
  { name: "questAbandon", sig: "questAbandon(questId): Promise<ActionResponse>", purpose: "Abandon a quest from the log." },
  { name: "questQuery", sig: "questQuery(questId): Promise<ActionResponse>", purpose: "Fetch a quest template (title, objective text, required entries/counts) into state.quests; the SDK already does this for every quest entering the log." },
  { name: "questGiverStatusQuery", sig: "questGiverStatusQuery(guid?: GuidArg): Promise<ActionResponse>", purpose: "Refresh the questgiver marker (state.units(...).questGiver) for one guid, or for everything in view when called with no guid; the SDK already does this on sight and on quest-log changes." },
  { name: "loot", sig: "loot(guid: GuidArg): Promise<ActionResponse>", purpose: "Open the loot window on a corpse." },
  { name: "lootAll", sig: "lootAll(guid: GuidArg): Promise<ActionResponse>", purpose: "Open and auto-loot; fire-and-forget (prefer lootCorpse, which waits)." },
  { name: "lootItem", sig: "lootItem(slot): Promise<ActionResponse>", purpose: "Store one loot slot into the bags." },
  { name: "lootMoney", sig: "lootMoney(): Promise<ActionResponse>", purpose: "Take the money from the open loot window." },
  { name: "lootRelease", sig: "lootRelease(guid: GuidArg): Promise<ActionResponse>", purpose: "Close the loot window." },
  { name: "vendorList", sig: "vendorList(guid: GuidArg): Promise<ActionResponse>", purpose: "Ask a vendor for its inventory list." },
  { name: "buyItem", sig: "buyItem(guid: GuidArg, itemId, slot, count?): Promise<ActionResponse>", purpose: "Buy an item from a vendor (slot is the 1-based vendor slot)." },
  { name: "sellItem", sig: "sellItem(guid: GuidArg, itemGuid: GuidArg, count?): Promise<ActionResponse>", purpose: "Sell an item to a vendor; omit count to sell the whole stack." },
  { name: "repairAll", sig: "repairAll(guid: GuidArg): Promise<ActionResponse>", purpose: "Repair everything at a repair vendor." },
  { name: "equipItem", sig: "equipItem(bag, slot): Promise<ActionResponse>", purpose: "Equip an item; bag 255 is the backpack, slots 23-38." },
  { name: "useItem", sig: "useItem(bag, slot, targetGuid?: GuidArg): Promise<ActionResponse>", purpose: "Use a bag item's on-use effect." },
  { name: "destroyItem", sig: "destroyItem(bag, slot, count?): Promise<ActionResponse>", purpose: "Destroy a bag item; omit count to destroy the whole stack." },
  { name: "repop", sig: "repop(): Promise<ActionResponse>", purpose: "Release the spirit while dead." },
  { name: "reclaimCorpse", sig: "reclaimCorpse(guid?: GuidArg): Promise<ActionResponse>", purpose: "Resurrect at the corpse (accepted only near it, after the delay)." },
  { name: "spiritHealerActivate", sig: "spiritHealerActivate(guid: GuidArg): Promise<ActionResponse>", purpose: "Resurrect at a graveyard spirit healer (durability cost, resurrection sickness)." },
  { name: "trainerListAsync", sig: "trainerListAsync(guid: GuidArg): Promise<ActionResponse>", purpose: "Ask a trainer for its list without waiting (prefer trainerList)." },
  { name: "trainerBuySpellAsync", sig: "trainerBuySpellAsync(guid: GuidArg, spellId): Promise<ActionResponse>", purpose: "Buy a spell without waiting (prefer buySpell)." },
  { name: "learnTalentAsync", sig: "learnTalentAsync(talentId, rank): Promise<ActionResponse>", purpose: "Spend a talent point without waiting (prefer learnTalent)." },
  { name: "raw", sig: "raw(opcode: string, payload?: hex | Uint8Array | RawField[]): Promise<RawActionResponse>", purpose: "Escape hatch (ADR-0025): send one allowlisted CMSG_* opcode with a body you build — a field list like [{ u32: 5 }, { guid: unit.guid }, { cstring: \"x\" }] is packed little-endian for you. Allowlist and field types: module/PROTOCOL.md \"raw\". The answer arrives on sdk.events only if its opcode is whitelisted there." },
];

/** WrathClient prototype members that are internal plumbing, deliberately undocumented. */
const CLIENT_INTERNAL = new Set([
  "action",
  "request",
  "resolveGossipOption",
  "questOffer",
  "faceQuietly",
  "waitForState",
  "waitEvent",
  "currentSignal",
  "throwIfAborted",
  "clientParityQueries",
  "fireAndForget",
  "flushStatusQueries",
  "forgetStatus",
  "trackQuestLog",
]);

// ---------------------------------------------------------------- state rows

/**
 * State reads, accessed as `state.<name>` (aliased as `state` in a snippet, or
 * `sdk.state`). Getters are plain properties (`state.xp`); the rest are methods.
 * Every field is `undefined` until an event carried it — undefined means
 * unobserved, never zero.
 */
const STATE_ROWS: readonly Row[] = [
  { name: "units", sig: "state.units(filter?: UnitFilter): UnitView[]", purpose: "Scan nearby objects, nearest first; filter by entry, name (string | RegExp), type, alive, maxDistance, npc, questGiver (the observed marker name: \"available\" offers a quest, \"reward\" takes a turn-in now, \"incomplete\" ends a quest not yet done). Rows carry questGiver / questGiverStatus." },
  {
    name: "closest",
    sig: "state.closest(filter?): NearbyObject | undefined",
    purpose:
      "The nearest object by distance. `filter` is a units() criteria object ({ entry, name, type, alive, maxDistance, npc, questGiver }) or a predicate over the raw object.",
  },
  { name: "nearbyUnits", sig: "state.nearbyUnits(): NearbyObject[]", purpose: "The raw nearby objects (state.units gives flat plain objects instead)." },
  { name: "creaturesByEntry", sig: "state.creaturesByEntry(entry): NearbyObject[]", purpose: "Nearby creatures with a given template entry id." },
  { name: "bag", sig: "state.bag(): BagContents", purpose: "The backpack as { items: [{ bag, slot, itemId, name, count }], freeSlots }." },
  { name: "quest", sig: "state.quest(questId): QuestLogEntry | undefined", purpose: "One quest-log entry by id: questId, title, complete bit, counts, and objectives: [{ kind: \"kill\"|\"interact\"|\"collect\"|\"event\", entry, text, required, have, done }] (objectives/title are undefined until the quest template answer has arrived, usually within a second of accepting)." },
  { name: "questLog", sig: "get state.questLog: QuestLogEntry[]", purpose: "All quest-log entries." },
  { name: "lastGossip", sig: "state.lastGossip(guid): GossipMenu | undefined", purpose: "The gossip menu last observed open for a guid (what gossipSelect-by-text resolves against)." },
  { name: "aurasOf", sig: "state.aurasOf(guid): AuraEntry[]", purpose: "Observed auras on a unit, by slot." },
  { name: "spells", sig: "state.spells(): KnownSpell[]", purpose: "The spellbook the server served: [{ spellId, rank, name }] for every spell the character knows (empty until login's SMSG_INITIAL_SPELLS; kept current by learned/removed/superseded events)." },
  { name: "spell", sig: "state.spell(spellId): KnownSpell | undefined", purpose: "One spellbook row by id; undefined means the character does not know that spell." },
  { name: "cooldowns", sig: "state.cooldowns(now?): SpellCooldown[]", purpose: "Spells still on cooldown: [{ spellId, readyAt (epoch ms, or undefined when the server gave no duration), cooldownMs }]." },
  { name: "talents", sig: "state.talents(): TalentState | undefined", purpose: "Last SMSG_TALENTS_INFO: { unspentPoints, activeSpec, specCount, talents: [{ talentId, rank (0-based) }] }." },
  { name: "nameOf", sig: "state.nameOf(guid): string | undefined", purpose: "The name for a guid, if a name query ever returned one." },
  { name: "snapshot", sig: "state.snapshot(): StateSnapshot", purpose: "A frozen plain-object copy of the whole cache." },
  { name: "target", sig: "get state.target: NearbyObject | undefined", purpose: "The object our own target points at, when it is also in view." },
  { name: "xp", sig: "get state.xp: Observed<number> | undefined", purpose: "Current experience (read .value)." },
  { name: "nextLevelXp", sig: "get state.nextLevelXp: Observed<number> | undefined", purpose: "Experience needed for the next level (read .value)." },
  { name: "money", sig: "get state.money: Observed<number> | undefined", purpose: "Money in copper (read .value)." },
  { name: "inventory", sig: "get state.inventory: InventoryItem[]", purpose: "All observed inventory items (bag() is the backpack view)." },
  { name: "chat", sig: "get state.chat: readonly ChatEntry[]", purpose: "The retained chat tail." },
  { name: "notifications", sig: "get state.notifications: readonly NotificationEntry[]", purpose: "The retained notification tail." },
  { name: "gaps", sig: "get state.gaps: readonly GapRecord[]", purpose: "Observed gaps in the event stream." },
  { name: "anomalies", sig: "get state.anomalies: readonly Anomaly[]", purpose: "Things the stream said that the cache could not reconcile." },
  { name: "questCompletions", sig: "get state.questCompletions: readonly QuestCompletion[]", purpose: "Observed quest completions." },
  { name: "questsCompleted", sig: "get state.questsCompleted: number", purpose: "Count of observed quest completions." },
];

/**
 * StateCache prototype members that are internal plumbing (event folding, seed)
 * — deliberately undocumented. `self` and `nearby` are instance fields, not on
 * the prototype, so they are described in prose in the state section, not here.
 */
const STATE_INTERNAL = new Set([
  "apply",
  "applyQuestGiverStatus",
  "questObjectives",
  "seedSelf",
  "adoptOwnCharacter",
  "applyCreate",
  "applySelfPosition",
  "applyUpdateBlock",
  "deriveGauges",
  "evictOnMapChange",
  "forget",
  "isSelfGuid",
  "joinName",
  "mergeFields",
  "upsertNearby",
]);

// ---------------------------------------------------------------- event rows

/** The event stream, accessed as `sdk.events` (aliased as `events` in a snippet). */
const EVENT_ROWS: readonly Row[] = [
  { name: "on", sig: "events.on(opcode, fn): Unsubscribe", purpose: "Subscribe to an SMSG_* opcode; returns a function that unsubscribes." },
  { name: "onAny", sig: "events.onAny(fn): Unsubscribe", purpose: "Subscribe to every event." },
  { name: "once", sig: "events.once(opcode, fn): Unsubscribe", purpose: "Subscribe to the next single event of an opcode." },
  { name: "waitFor", sig: "events.waitFor(predicate, options?): Promise<StreamEvent>", purpose: "Wait for the next event satisfying a predicate; throws EventTimeoutError on timeout, EventAbortedError if options.signal (or the client default) fires." },
  { name: "waitForOpcode", sig: "events.waitForOpcode(opcode, { timeout }): Promise<StreamEvent>", purpose: "Wait for the next event of a given opcode." },
  { name: "recent", sig: "events.recent(n?): StreamEvent[]", purpose: "The most recent buffered events, newest last." },
  { name: "connected", sig: "get events.connected: boolean", purpose: "Whether the event socket is open." },
];

/** EventStream prototype members that are internal plumbing, deliberately undocumented. */
const EVENT_INTERNAL = new Set([
  "connect",
  "close",
  "emit",
  "ingest",
  "openSocket",
  "scheduleReconnect",
  "advanceEpoch",
  "epoch",
  "gaps",
]);

// ----------------------------------------------------------- drift checking

/** Public own members of a prototype (excludes the constructor). */
function prototypeMembers(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
}

/**
 * Fail loudly if the documented rows and the live prototype disagree, in either
 * direction. This is what keeps API.md from advertising a method that does not
 * exist and from silently omitting one that does.
 */
function checkDrift(label: string, proto: object, documented: readonly Row[], internal: Set<string>): void {
  const live = new Set(prototypeMembers(proto));
  const docNames = new Set(documented.map((r) => r.name));

  const invented = [...docNames].filter((n) => !live.has(n)).sort();
  if (invented.length > 0) {
    throw new Error(`${label}: documented member(s) not on the prototype (invented or renamed): ${invented.join(", ")}`);
  }
  const undocumented = [...live].filter((n) => !docNames.has(n) && !internal.has(n)).sort();
  if (undocumented.length > 0) {
    throw new Error(
      `${label}: public member(s) neither documented nor listed internal: ${undocumented.join(", ")} ` +
        `— add a row to the generator or list it as internal.`,
    );
  }
  const staleInternal = [...internal].filter((n) => !live.has(n)).sort();
  if (staleInternal.length > 0) {
    throw new Error(`${label}: internal list names member(s) not on the prototype: ${staleInternal.join(", ")}`);
  }
}

// -------------------------------------------------------------- rendering

function table(rows: readonly Row[]): string {
  const lines = ["| Method | Signature | Purpose |", "| --- | --- | --- |"];
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | \`${r.sig}\` | ${r.purpose} |`);
  }
  return lines.join("\n");
}

function render(): string {
  const errorCodes = [...KNOWN_ERROR_CODES].sort().map((c) => `\`${c}\``).join(", ");
  const trainerStates = Object.entries(TRAINER_SPELL_STATE)
    .map(([k, v]) => `\`${k}\` = ${v}`)
    .join(", ");

  return `<!-- AUTO-GENERATED by sdk/generate-api-docs.ts — DO NOT EDIT. Run \`bun run docs:api\` to regenerate. -->

# WrathBench SDK reference

The exact call surface of the SDK your snippets program against, generated from
the public \`WrathClient\` and \`StateCache\`. Every method here exists; nothing
else does. There is **no** \`killNearest\`, \`goTo\`, \`navigate\`, \`trainSkill\`, or
skill-specific porcelain — do not invent methods. Gathering and talking to NPCs
go through \`interact\`, \`gossipHello\`, \`gossipSelect\`, \`useItem\`, and
\`castSpell\`. This file is larger than one snippet result, so read it in slices
(one \`## \` section, or lines filtered by name).

**Guids** are opaque decimal strings. Compare with \`===\`, use them as Map keys
and in template literals, and \`JSON.stringify\` them freely; get them from
\`state.units(...)\`, \`state.closest(...)\`, or event data. Never a number.

**Throw vs value (ADR-0011).** A transport or request error always throws
(\`WrathTransportError\`, \`WrathRequestError\`), and so does the *absence* of an
outcome (\`EventTimeoutError\` — no result arrived within the timeout;
\`EventAbortedError\` — the wait was cancelled by its abort signal). Anything
the *game* decided is a returned value, not an exception: helpers return a
discriminated union with an \`ok\` boolean and a \`status\`, so \`if (!result.ok)\`
handles the normal failures (\`target_off_mesh\`, \`buy_failed\`, \`not_complete\`) without a
\`try\`. So: \`try\`/\`catch\` guards a broken or unanswered call; \`if (!ok)\` reads a
game answer you asked for.

**Two tiers.** A **helper** waits for the game's verdict and returns it. A **raw
action** is one opcode acknowledged over HTTP; its outcome arrives later on the
event stream (\`sdk.events\`). The tier is about where the outcome lands, not
about the argument type — \`interact\` is a raw action that still accepts a unit
object. Endpoints (session, health) return their HTTP answer directly.

## Session & connection

In a snippet, \`await connect()\` (no arguments) opens the event stream on the
pre-constructed \`sdk\` client; call it once before \`createSession\`. (The library
form \`connect(options): Promise<WrathClient>\` is for host code that builds its
own client — not for snippets, where \`sdk\` already exists.) Then, on the client:

${table(CLIENT_ENDPOINTS)}

## Helpers (wait for a game verdict)

${table(CLIENT_HELPERS)}

## Raw actions (HTTP ack; outcome arrives as an event)

${table(CLIENT_RAW)}

## State reads (\`state.*\`)

\`state\` (alias for \`sdk.state\`) is a cache folded from events. \`state.self\`
(guid, name, level, position, health, targetGuid) and \`state.nearby\` (a Map
keyed by guid) are plain properties; the members below are getters and methods.
Observed fields are wrapped as \`{ value, seq, ts }\` — read \`.value\`. Every field
is \`undefined\` until an event carried it; \`undefined\` means unobserved, never
zero.

${table(STATE_ROWS)}

## Events (\`sdk.events\`)

Events are the server's \`SMSG_*\` packets as JSON.

${table(EVENT_ROWS)}

## Errors & exported values

- \`WrathTransportError\` — the request never got a readable answer (thrown).
- \`WrathRequestError\` — the module answered \`{ ok: false }\` (thrown); carries
  \`code\`, \`status\`, and \`kind: "request" | "game"\`.
- \`EventTimeoutError\` — no event arrived within the timeout (thrown).
- \`EventAbortedError\` — the wait was cancelled by an \`AbortSignal\` before
  anything arrived (thrown; \`reason\` is what the signal was aborted with).
  Every wait honors the client's default signal (\`ConnectOptions.signal\`, a
  signal or a provider consulted per wait); in the runner sandbox that is the
  current snippet's ambient \`signal\`, aborted when the snippet is abandoned
  on timeout. A \`moveTo\` aborted mid-walk also issues \`stop\` before rethrowing.
- \`KNOWN_ERROR_CODES\`: ${errorCodes}.
- \`TRAINER_SPELL_STATE\`: ${trainerStates}.
`;
}

function main(): void {
  checkDrift("WrathClient", WrathClient.prototype, [...CLIENT_ENDPOINTS, ...CLIENT_HELPERS, ...CLIENT_RAW], CLIENT_INTERNAL);
  checkDrift("StateCache", StateCache.prototype, STATE_ROWS, STATE_INTERNAL);
  checkDrift("EventStream", EventStream.prototype, EVENT_ROWS, EVENT_INTERNAL);
  // Touch the error exports so a rename of any breaks the build here too.
  void WrathTransportError;
  void WrathRequestError;
  void EventTimeoutError;
  void EventAbortedError;

  const out = join(import.meta.dir, "API.md");
  Bun.write(out, render());
  console.error(`wrote ${out}`);
}

main();
