#!/usr/bin/env bun
/**
 * Emit `sdk/API.md` from the public `WrathClient` + `StateCache` surface.
 *
 * The doc is the model's reference for exact signatures, so it must never drift
 * from the code and must never advertise a method that does not exist (runs
 * have recorded models burning turns inventing `mineRock`-shaped helpers). This
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

/** Helpers: they wait for the game's verdict and return it as a value. */
const CLIENT_HELPERS: readonly Row[] = [
  { name: "moveTo", sig: "moveTo(target, options?): Promise<MoveResult>", purpose: "Walk to a point { x, y, z }, a unit, a guid, or the name of something in view (its cached position; the guid rides along so the module resolves z to the ground under the unit) and wait for the server's arrive/target_off_mesh/transferred/teleported/… verdict; a target nothing in view answers to comes back as status \"unknown_target\". An arrival aboard a tram car or boat carries onTransport { guid, entry }, and state.self.position then follows the ride (WB_RIDE_PROGRESS)." },
  { name: "killTarget", sig: "killTarget(target: GuidOrUnit, options?): Promise<KillResult>", purpose: "Approach and auto-attack until the target or we drop; returns how the fight ended." },
  { name: "lootCorpse", sig: "lootCorpse(target: GuidOrUnit, options?): Promise<LootResult>", purpose: "Empty a corpse and report what actually entered the bags (confirmed pushes, not the window)." },
  { name: "acceptQuestFrom", sig: "acceptQuestFrom(npcGuid: GuidOrUnit, questId, options?): Promise<QuestAcceptResult>", purpose: "Take a quest from an NPC and confirm it landed in the quest log." },
  { name: "turnInQuest", sig: "turnInQuest(npcGuid: GuidOrUnit, questId, rewardIndex?, options?): Promise<QuestTurnInResult>", purpose: "Hand a finished quest back and take a reward." },
  { name: "questsAvailableFrom", sig: "questsAvailableFrom(npcGuid: GuidOrUnit, options?): Promise<{ ok, quests }>", purpose: "What an NPC is offering right now; an empty list is an answer, not an error." },
  { name: "trainerList", sig: "trainerList(npcGuid: GuidOrUnit, options?): Promise<TrainerListResult>", purpose: "What a trainer teaches, each row with derived learnable/affordable." },
  { name: "buySpell", sig: "buySpell(npcGuid: GuidOrUnit, spellId, options?): Promise<BuySpellResult>", purpose: "Learn one spell from a trainer for money; returns learned or buy_failed." },
  { name: "equipItem", sig: "equipItem(bagOrName: number | string, slot?, options?): Promise<EquipItemResult>", purpose: "Equip a carried item — its bag/slot as `state.bag()` lists them (255/23-38 for the backpack, a worn bag's equip slot 19-22 with slots 0..numSlots-1), or its name in place of the bag — and wait for the server's verdict; returns equipped, not_equipped with the InventoryResult reason (proficiency, level, a two-hander blocking a shield, …), or no_item when the name matches nothing carried or more than one thing." },
  { name: "showTaxiNodes", sig: "showTaxiNodes(npcGuid: GuidOrUnit, options?): Promise<TaxiWindow>", purpose: "Open a flight master's window (gossipHello, then its taxi option) and return it: the node the master stands at and the nodes this character has visited — the only destinations the server accepts." },
  { name: "activateTaxi", sig: "activateTaxi(npcGuid: GuidOrUnit, dest: string | number, options?): Promise<ActivateTaxiResult>", purpose: "Fly from the master's node to a known node by name or id (resolved against state.lastTaxiNodes(guid)); returns accepted or refused with the server's reply code and a hint. The ride is state.self.taxiFlight." },
  { name: "bindAtInnkeeper", sig: "bindAtInnkeeper(npcGuid: GuidOrUnit, options?): Promise<BindResult>", purpose: "Make an inn the Hearthstone's home the way a client does (gossip, the home option, confirm) and return the new bind point (also state.self.bindPoint)." },
  { name: "learnTalent", sig: "learnTalent(talentIdOrName: number | string, rank?, options?): Promise<LearnTalentResult>", purpose: "Spend a talent point — a talent id, or a name from the tree once queryTalentTree() has been called; rank is 0-based on the wire and defaults to the next point in that talent — and read the verdict off the SMSG_TALENTS_INFO answer; returns learned, not_learned, or unknown_talent / ambiguous_talent / no_tree." },
  { name: "queryTalentTree", sig: "queryTalentTree(options?): Promise<TalentTree>", purpose: "The class talent frame: tabs [{ tabId, name, page, pointsSpent, talents: [{ talentId, name, row, col, maxRank, ranks, pointsSpent, dependsOn, dependsOnRank }] }] plus unspentPoints; static per class, also state.talentTree()." },
  { name: "resetTalents", sig: "resetTalents(npcGuid: GuidOrUnit, options?): Promise<ResetTalentsResult>", purpose: "Unlearn all talents at a class trainer the way a client does (gossip, the unlearn option, confirm at the quoted cost); returns reset with the new state.talents(), refused (nothing to unlearn / not enough money), or no_option when the menu has no unlearn entry." },
  { name: "inviteToGroup", sig: "inviteToGroup(name, options?): Promise<InviteResult>", purpose: "Invite a player by name and return the server's verdict on the invite (invited = delivered, not yet accepted; refused carries the reason). Their answer lands in state.group(): inGroup, or lastDecline." },
  { name: "acceptGroupInvite", sig: "acceptGroupInvite(options?): Promise<GroupState>", purpose: "Accept the pending invitation (state.group().pendingInvite) and return the party once the server lists it." },
  { name: "leaveGroup", sig: "leaveGroup(options?): Promise<GroupState>", purpose: "Leave the party and return the state once the server confirms." },
  { name: "openMailbox", sig: "openMailbox(mailbox: GuidOrUnit, options?): Promise<MailboxState>", purpose: "Use a mailbox game object (goType \"mailbox\", within reach) and wait for its frame; every other mail helper needs this open." },
  { name: "sendMail", sig: "sendMail(to, subject, body, { money?, cod?, items?: ({ bag, slot } | name)[] }?): Promise<MailResult>", purpose: "Send a mail from the open mailbox with optional money, COD and up to 12 carried items (each a bag/slot pair or an item name); returns sent, refused with the server's reason (postage 30c comes out of state.money), or no_mailbox / no_item." },
  { name: "mailList", sig: "mailList(options?): Promise<MailboxState>", purpose: "List the inbox at the open mailbox: mails [{ mailId, senderName, subject, body, money, cod, read, items: [{ itemGuidLow, itemId, name, count }] }]." },
  { name: "takeMailMoney", sig: "takeMailMoney(mailId, options?): Promise<MailResult>", purpose: "Take the money out of one mail (money_taken, or refused)." },
  { name: "takeMailItem", sig: "takeMailItem(mailId, itemGuidLow, options?): Promise<MailResult>", purpose: "Take one attached item out of a mail into the bags (item_taken, or refused with the inventory reason)." },
  { name: "deleteMail", sig: "deleteMail(mailId, options?): Promise<MailResult>", purpose: "Delete one mail (deleted, or refused)." },
  { name: "openBank", sig: "openBank(npcGuid: GuidOrUnit, options?): Promise<BankContents>", purpose: "Open the bank at a banker (state.units({ role: \"banker\" }), within reach) and return it; deposits and withdrawals need this open." },
  { name: "bankDeposit", sig: "bankDeposit(bagOrName: number | string, slot?, options?): Promise<BankMoveResult>", purpose: "Put a carried item (bag/slot as state.bag() lists it, or its name) in the bank; returns where it landed in state.bank(), refused with the inventory reason, or no_bank / no_item when nothing was sent." },
  { name: "lootRoll", sig: "lootRoll(itemNameOrIdOrRollGuid, choice: \"need\" | \"greed\" | \"pass\" | \"disenchant\", options?): Promise<LootRollResult>", purpose: "Vote on an open roll frame from state.pendingRolls() (by the item's name — exact, else a unique substring — its id, or the roll guid); rolled carries the number rolled, while no_pending_roll / ambiguous_roll / roll_not_allowed mean nothing was sent. The winner arrives as SMSG_LOOT_ROLL_WON." },
  { name: "readItem", sig: "readItem(bagOrName: number | string, slot?, options?): Promise<ReadItemResult>", purpose: "Read a carried book or letter (bag/slot as state.bag() lists it, or its name) and return its pages and text; no_item / not_readable mean nothing to read. The pages stay in state.itemTexts()." },
  { name: "bankWithdraw", sig: "bankWithdraw(bagOrName: number | string, slot?, options?): Promise<BankMoveResult>", purpose: "Take an item out of the bank (bag/slot as state.bank() lists it, or its name) into the bags; returns where it landed in state.bag(), refused, or no_bank / no_item." },
  { name: "waitForChat", sig: "waitForChat(match: string | (entry) => boolean, options?): Promise<ChatEntry>", purpose: "Wait for a chat line matching a string or predicate." },
  { name: "waitForNearby", sig: "waitForNearby(predicate: (obj) => boolean, options?): Promise<NearbyObject>", purpose: "Wait until an object in view satisfies the predicate." },
  { name: "waitForTransfer", sig: "waitForTransfer({ timeout?, sinceSeq?, expectMap? }): Promise<TransferResult>", purpose: "Wait for a map transfer's server verdict: transferred (SMSG_NEW_WORLD) / aborted / waiting / no_transfer / wrong_map. moveTo already does this when a portal takes the character." },
  { name: "waitForQuestObjective", sig: "waitForQuestObjective(questId, options?): Promise<QuestLogEntry>", purpose: "Wait until the quest log marks a quest's objectives complete." },
];

/**
 * Raw actions: one opcode each, acknowledged by HTTP; the game's outcome (a
 * cast failure, a gossip menu, a loot window) arrives on the event stream.
 * Taking a `GuidOrUnit` or resolving a gossip option by text is argument
 * convenience, not verdict-waiting; the RAW label is only about where the
 * outcome lands.
 */
const CLIENT_RAW: readonly Row[] = [
  { name: "say", sig: "say(text): Promise<ActionResponse>", purpose: "Say something in local chat." },
  { name: "moveToAsync", sig: "moveToAsync(target): Promise<MoveToResponse>", purpose: "Queue a move without waiting — the call for a walk longer than your own time budget; same targets as moveTo." },
  { name: "stop", sig: "stop(): Promise<ActionResponse>", purpose: "Queue a movement stop; the in-flight moveTo resolves with status 'stopped'." },
  { name: "face", sig: "face(orientationOrPoint: number | { x, y }): Promise<FaceResponse>", purpose: "Turn in place toward an orientation (radians) or a point." },
  { name: "setTarget", sig: "setTarget(target: GuidOrUnit): Promise<ActionResponse>", purpose: "Set the current target." },
  { name: "clearTarget", sig: "clearTarget(): Promise<ActionResponse>", purpose: "Clear the current target." },
  { name: "attackStart", sig: "attackStart(target: GuidOrUnit): Promise<ActionResponse>", purpose: "Start melee auto-attack." },
  { name: "attackStop", sig: "attackStop(): Promise<ActionResponse>", purpose: "Stop melee auto-attack." },
  { name: "castSpell", sig: "castSpell(spellId, targetGuid?: GuidOrUnit): Promise<ActionResponse>", purpose: "Cast a spell; no target means self/auto-target." },
  { name: "cancelCast", sig: "cancelCast(spellId): Promise<ActionResponse>", purpose: "Cancel a cast in progress." },
  { name: "interact", sig: "interact(target: GuidOrUnit): Promise<ActionResponse>", purpose: "Use a gameobject — chest, door, quest object." },
  { name: "gossipHello", sig: "gossipHello(target: GuidOrUnit): Promise<ActionResponse>", purpose: "Open an NPC's gossip menu." },
  { name: "gossipSelect", sig: "gossipSelect(guid: GuidOrUnit, option: string | number) | gossipSelect(guid, menuId, optionId): Promise<ActionResponse>", purpose: "Choose a gossip option by visible text (from the last observed menu) or by numeric ids." },
  { name: "questList", sig: "questList(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Ask an NPC for its quest list." },
  { name: "questDetails", sig: "questDetails(guid: GuidOrUnit, questId): Promise<ActionResponse>", purpose: "Request a quest's text." },
  { name: "questAccept", sig: "questAccept(guid: GuidOrUnit, questId): Promise<ActionResponse>", purpose: "Accept a quest (prefer acceptQuestFrom, which confirms)." },
  { name: "questComplete", sig: "questComplete(guid: GuidOrUnit, questId): Promise<ActionResponse>", purpose: "Ask to complete a quest (prefer turnInQuest, which waits)." },
  { name: "questChooseReward", sig: "questChooseReward(guid: GuidOrUnit, questId, rewardIndex?): Promise<ActionResponse>", purpose: "Choose a quest reward by index." },
  { name: "questAbandon", sig: "questAbandon(questId): Promise<ActionResponse>", purpose: "Abandon a quest from the log." },
  { name: "questQuery", sig: "questQuery(questId): Promise<ActionResponse>", purpose: "Fetch a quest template (title, objective text, required entries/counts) into state.quests; the SDK already does this for every quest entering the log." },
  { name: "questGiverStatusQuery", sig: "questGiverStatusQuery(guid?: GuidOrUnit): Promise<ActionResponse>", purpose: "Refresh the questgiver marker (state.units(...).questGiver) for one guid, or for everything in view when called with no guid; the SDK already does this on sight and on quest-log changes." },
  { name: "loot", sig: "loot(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Open the loot window on a corpse." },
  { name: "lootAll", sig: "lootAll(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Open and auto-loot; fire-and-forget (prefer lootCorpse, which waits)." },
  { name: "lootItem", sig: "lootItem(slot): Promise<ActionResponse>", purpose: "Store one loot slot into the bags." },
  { name: "lootMoney", sig: "lootMoney(): Promise<ActionResponse>", purpose: "Take the money from the open loot window." },
  { name: "lootRelease", sig: "lootRelease(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Close the loot window." },
  { name: "vendorList", sig: "vendorList(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Ask a vendor for its inventory list." },
  { name: "buyItem", sig: "buyItem(guid: GuidOrUnit, itemId, slot, count?): Promise<ActionResponse>", purpose: "Buy an item from a vendor (slot is the 1-based vendor slot)." },
  { name: "sellItem", sig: "sellItem(vendor: GuidOrUnit, itemGuid: GuidArg, count?): Promise<ActionResponse>", purpose: "Sell an item to a vendor; omit count to sell the whole stack. The vendor takes a name in view, itemGuid stays the item's own guid string — there is no name-to-item-guid namespace." },
  { name: "repairAll", sig: "repairAll(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Repair everything at a repair vendor." },
  { name: "useItem", sig: "useItem(bagOrName: number | string, slot?, targetGuid?: GuidOrUnit): Promise<ActionResponse>", purpose: "Use a bag item's on-use effect; the item is its bag/slot or its name (with a name, the next argument is the target guid)." },
  { name: "destroyItem", sig: "destroyItem(bagOrName: number | string, slot?, count?): Promise<ActionResponse>", purpose: "Destroy a bag item by bag/slot or by name (with a name, the next argument is the count); omit count to destroy the whole stack." },
  { name: "repop", sig: "repop(): Promise<ActionResponse>", purpose: "Release the spirit while dead." },
  { name: "reclaimCorpse", sig: "reclaimCorpse(guid?: GuidOrUnit, options?: ReclaimCorpseOptions): Promise<ReclaimCorpseResult>", purpose: "Wait out the server's corpse reclaim delay, reclaim, and report the verdict: reclaimed / not_reclaimed / unconfirmed." },
  { name: "reclaimCorpseAsync", sig: "reclaimCorpseAsync(guid?: GuidOrUnit): Promise<ActionResponse>", purpose: "CMSG_RECLAIM_CORPSE, dispatch only. Prefer reclaimCorpse." },
  { name: "spiritHealerActivate", sig: "spiritHealerActivate(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Resurrect at a graveyard spirit healer (durability cost, resurrection sickness)." },
  { name: "trainerListAsync", sig: "trainerListAsync(guid: GuidOrUnit): Promise<ActionResponse>", purpose: "Ask a trainer for its list without waiting (prefer trainerList)." },
  { name: "trainerBuySpellAsync", sig: "trainerBuySpellAsync(guid: GuidOrUnit, spellId): Promise<ActionResponse>", purpose: "Buy a spell without waiting (prefer buySpell)." },
  { name: "learnTalentAsync", sig: "learnTalentAsync(talentId, rank): Promise<ActionResponse>", purpose: "Spend a talent point without waiting (prefer learnTalent)." },
  { name: "talentTreeAsync", sig: "talentTreeAsync(): Promise<ActionResponse>", purpose: "Ask for the class talent tree without waiting for the WB_TALENT_TREE answer (prefer queryTalentTree)." },
  { name: "petAttack", sig: "petAttack(target: GuidOrUnit): Promise<PetActionResult>", purpose: "Order the pet (state.pet()) to attack a unit; sent is an ack and the server's refusal arrives as SMSG_PET_ACTION_FEEDBACK, while no_pet means nothing was sent." },
  { name: "petFollow", sig: "petFollow(): Promise<PetActionResult>", purpose: "Order the pet to follow you." },
  { name: "petStay", sig: "petStay(): Promise<PetActionResult>", purpose: "Order the pet to stay where it is." },
  { name: "petReact", sig: "petReact(reaction: \"passive\" | \"defensive\" | \"aggressive\"): Promise<PetActionResult>", purpose: "Set the pet's react state (case-insensitive); anything else is unknown_reaction." },
  { name: "petCast", sig: "petCast(spellNameOrId, target?: GuidOrUnit): Promise<PetActionResult>", purpose: "Have the pet cast one of its own spells (state.pet().spells, by name or by id) at a unit or at nothing; the server's refusal arrives as SMSG_PET_CAST_FAILED, while unknown_spell / ambiguous_spell / passive_spell mean nothing was sent." },
  { name: "petDismiss", sig: "petDismiss(): Promise<PetActionResult>", purpose: "Send the pet away: a hunter casts Dismiss Pet (the pet can be called back), any other pet is abandoned (a demon or temporary summon just goes). state.pet() is undefined once the bar is removed." },
  { name: "declineGroupInvite", sig: "declineGroupInvite(): Promise<RawActionResponse>", purpose: "Decline the pending invitation." },
  { name: "raw", sig: "raw(opcode: string, payload?: hex | Uint8Array | RawField[]): Promise<RawActionResponse>", purpose: "Escape hatch: send one allowlisted CMSG_* opcode with a body you build — a field list like [{ u32: 5 }, { guid: unit.guid }, { cstring: \"x\" }] is packed little-endian for you. Allowlist and field types: module/PROTOCOL.md \"raw\". The answer arrives on sdk.events only if its opcode is whitelisted there." },
];

/** WrathClient prototype members that are internal plumbing, deliberately undocumented. */
const CLIENT_INTERNAL = new Set([
  "action",
  "noteActionHint",
  "drainActionHints",
  "request",
  "postMoveTo",
  "waitOwnTeleportAck",
  "reclaimRefusal",
  "latestReclaimDelay",
  "resolveGossipOption",
  "petGuidOrRefuse",
  "petRefusal",
  "lootRollRefusal",
  "targetGuid",
  "isChest",
  "openChest",
  "targetRef",
  "byName",
  "resolveRawGuids",
  "resolveTalent",
  "bankClosed",
  "noBankItem",
  "petAction",
  "mailboxGuidOrThrow",
  "mailboxGuid",
  "noMailbox",
  "waitMailResult",
  "bankMove",
  "questOffer",
  "faceQuietly",
  "waitForState",
  "waitEvent",
  "currentSignal",
  "remainingBudgetMs",
  "throwIfAborted",
  "sleepAborting",
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
  { name: "units", sig: "state.units(filter?: UnitFilter): UnitView[]", purpose: "Scan nearby objects, nearest first; filter by entry, name (string | RegExp), type, alive, maxDistance, npc, role (an NPC role word or a list: \"questGiver\", \"vendor\", \"repair\", \"trainer\", \"flightMaster\", \"innkeeper\", \"spiritHealer\", \"banker\", \"auctioneer\", …), questGiver (the observed marker name: \"available\" offers a quest, \"reward\" takes a turn-in now, \"incomplete\" ends a quest not yet done; true means any marker but \"none\"). Rows carry roles (the NPC's role words from its npc flags — what it is for, never what to do; empty for non-NPCs) and questGiver / questGiverStatus; game objects are named (\"Mailbox\", \"Subway\") and carry goType (door, chest, mailbox, transport, …), and a transport carries docked (true while the car sits at a platform)." },
  {
    name: "closest",
    sig: "state.closest(filter?): NearbyObject | undefined",
    purpose:
      "The nearest object by distance. `filter` is a units() criteria object ({ entry, name, type, alive, maxDistance, npc, role, questGiver }) or a predicate over the raw object.",
  },
  { name: "nearbyUnits", sig: "state.nearbyUnits(): NearbyObject[]", purpose: "The raw nearby objects (state.units gives flat plain objects instead)." },
  { name: "creaturesByEntry", sig: "state.creaturesByEntry(entry): NearbyObject[]", purpose: "Nearby creatures with a given template entry id." },
  { name: "bag", sig: "state.bag(): BagContents", purpose: "The whole carried inventory — backpack plus worn bags — as { items: [{ bag, slot, guid, itemId, name, count, quality? }], freeSlots, totalSlots, bags: [{ slot, numSlots, name }] }; each item's bag/slot is what the item actions take." },
  { name: "quest", sig: "state.quest(questId): QuestLogEntry | undefined", purpose: "One quest-log entry by id: questId, title, complete bit, counts, and objectives: [{ kind: \"kill\"|\"interact\"|\"collect\"|\"event\", entry, text, required, have, done }] (objectives/title are undefined until the quest template answer has arrived, usually within a second of accepting)." },
  { name: "questLog", sig: "get state.questLog: QuestLogEntry[]", purpose: "All quest-log entries." },
  { name: "lastTaxiNodes", sig: "state.lastTaxiNodes(guid): TaxiWindow | undefined", purpose: "The flight master window last observed for a guid: current node, known (visited) nodes with their names, the taximask verbatim (what activateTaxi resolves against)." },
  { name: "lastGossip", sig: "state.lastGossip(guid): GossipMenu | undefined", purpose: "The gossip menu last observed open for a guid (what gossipSelect-by-text resolves against)." },
  { name: "lastVendorList", sig: "state.lastVendorList(guid): VendorWindow | undefined", purpose: "The stock last observed for a vendor: { items: [{ slot (1-based, what buyItem takes), itemId, price (discounted copper), buyCount, leftInStock (-1 unlimited), extendedCost }], emptyReason, seq, ts }. Last observed, not open: nothing closes a vendor frame." },
  { name: "lastTrainerList", sig: "state.lastTrainerList(guid): TrainerWindow | undefined", purpose: "The teaching list last observed for a trainer: { trainerType, spells: [{ spellId, state (0 available, 1 unavailable, 2 known), cost, reqLevel, reqSkill, reqSkillValue }], greeting, seq, ts }. Raw rows; trainerList(npcGuid) asks and adds learnable/affordable." },
  { name: "lastLoot", sig: "state.lastLoot(): LootWindow | undefined", purpose: "The open loot window: { guid, lootType, gold, items: [{ slot (what lootItem takes), itemId, count, slotType }], seq, ts }. Taken slots and taken gold leave it; the release closes it." },
  { name: "aurasOf", sig: "state.aurasOf(guid): AuraEntry[]", purpose: "Observed auras on a unit, by slot." },
  { name: "spells", sig: "state.spells(): KnownSpell[]", purpose: "The spellbook the server served: [{ spellId, rank, name }] for every spell the character knows (empty until login's SMSG_INITIAL_SPELLS; kept current by learned/removed/superseded events)." },
  { name: "spell", sig: "state.spell(spellId): KnownSpell | undefined", purpose: "One spellbook row by id; undefined means the character does not know that spell." },
  { name: "cooldowns", sig: "state.cooldowns(now?): SpellCooldown[]", purpose: "Spells still on cooldown: [{ spellId, readyAt (epoch ms, or undefined when the server gave no duration), cooldownMs }]." },
  { name: "talents", sig: "state.talents(): TalentState | undefined", purpose: "Last SMSG_TALENTS_INFO: { unspentPoints, activeSpec, specCount, talents: [{ talentId, rank (0-based) }] }." },
  { name: "talentTree", sig: "state.talentTree(): TalentTree | undefined", purpose: "The class talent frame last answered by queryTalentTree, with pointsSpent per talent merged from the latest SMSG_TALENTS_INFO; undefined until queried." },
  { name: "skills", sig: "state.skills(): SkillLine[]", purpose: "The skill pane: [{ skillId, name, value, max, tempBonus, permBonus }] for every skill line the character has (weapons, armor, professions, languages), from the self update fields." },
  { name: "skill", sig: "state.skill(idOrName): SkillLine | undefined", purpose: "One skill line by id or name; undefined when the character lacks it, and also when the name is ambiguous — a read has no way to refuse." },
  { name: "reputation", sig: "state.reputation(): ReputationEntry[]", purpose: "The reputation pane: [{ factionId, name, standing, base, reputation, rank: \"Hated\"…\"Exalted\", visible, atWar }] from login's SMSG_INITIALIZE_FACTIONS and every SMSG_SET_FACTION_STANDING since; visible factions first." },
  { name: "reputationWith", sig: "state.reputationWith(factionIdOrName): ReputationEntry | undefined", purpose: "One reputation row by faction id or name; undefined when there is none or the name is ambiguous." },
  { name: "pet", sig: "state.pet(): PetState | undefined", purpose: "The pet frame: { guid, name, creatureName, level, health, maxHealth, power, maxPower, dead, inView, reaction: \"passive\"|\"defensive\"|\"aggressive\", command: \"stay\"|\"follow\"|\"attack\", actionBar, spells: [{ spellId, name, rank, autocast, passive }], cooldowns }; undefined when there is no pet (none summoned, or its bar was removed)." },
  { name: "petSpell", sig: "state.petSpell(idOrName): PetSpellEntry | undefined", purpose: "One of the pet's spells by id or name; undefined when there is none or the name is ambiguous." },
  { name: "group", sig: "state.group(): GroupState | undefined", purpose: "The party: { inGroup, raid, leaderGuid, leaderName, leader (you), members: [{ guid, name, online, leader, assistant }], pendingInvite: { inviterName }, lastResult: { operation, name, result, text }, lastDecline }; undefined until any group packet." },
  { name: "mailbox", sig: "state.mailbox(): MailboxState | undefined", purpose: "The mailbox: { guid (the open mailbox), mails: [{ mailId, senderName, subject, body, money, cod, read, daysLeft, items }], total, newMail, lastResult: { action, result, text } }; undefined until any mail packet." },
  { name: "bank", sig: "state.bank(): BankContents", purpose: "The bank: { guid (the banker the frame was opened at), items: [{ bag (255 for the main bank, else the bank bag's slot 67-73), slot, guid, itemId, name, count }], bags, freeSlots, totalSlots }; the slots are known from login, moving items needs openBank." },
  { name: "pendingRolls", sig: "state.pendingRolls(): PendingRoll[]", purpose: "The open group-loot roll frames: [{ rollGuid, itemId, name, quality, count, allowed: [\"need\"|\"greed\"|\"disenchant\"|\"pass\"], deadline }]; empty when nothing is up for a roll." },
  { name: "itemTexts", sig: "state.itemTexts(): ItemText[]", purpose: "The text of every carried item read so far: [{ guid, itemId, name, pages, complete }]." },
  { name: "trade", sig: "state.trade(): TradeState | undefined", purpose: "The trade window: { status, statusText, open, traderGuid, mine: { money, items }, theirs: { money, items } }; undefined until any trade packet." },
  { name: "nameOf", sig: "state.nameOf(guid): string | undefined", purpose: "The name for a guid, if a name query ever returned one." },
  { name: "snapshot", sig: "state.snapshot(): StateSnapshot", purpose: "A frozen plain-object copy of the whole cache." },
  { name: "target", sig: "get state.target: NearbyObject | undefined", purpose: "The object our own target points at, when it is also in view." },
  { name: "xp", sig: "get state.xp: Observed<number> | undefined", purpose: "Current experience (read .value)." },
  { name: "nextLevelXp", sig: "get state.nextLevelXp: Observed<number> | undefined", purpose: "Experience needed for the next level (read .value)." },
  { name: "money", sig: "get state.money: Observed<number> | undefined", purpose: "Money in copper (read .value)." },
  { name: "inventory", sig: "get state.inventory: InventoryItem[]", purpose: "All observed inventory slots by raw slot id; equipment is `slot < 19` (worn bags 19-22), bag() is the carried view." },
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
  "addAchievement",
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
  "rebuildAchievements",
  "upsertNearby",
  "foldFactionRow",
  "foldGroupList",
  "groupPatch",
  "mailPatch",
]);

// ---------------------------------------------------------------- event rows

/** The event stream, accessed as `sdk.events` (aliased as `events` in a snippet). */
const EVENT_ROWS: readonly Row[] = [
  { name: "on", sig: "events.on(opcode, fn): Unsubscribe", purpose: "Subscribe to an SMSG_* opcode; returns a function that unsubscribes." },
  { name: "off", sig: "events.off(opcode, fn): boolean", purpose: "Remove a handler added with on() (or once()) for that opcode; returns whether one was found. Removing something already gone is a no-op. For onAny(), call the unsubscribe it returned." },
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

**Throw vs value.** A transport or request error always throws
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
about the argument type: every call that takes a guid takes a unit object or a
name in view just the same. Endpoints (session, health) return their HTTP
answer directly.

**Names are referents.** Anywhere a guid is taken — helpers, raw actions, and a
\`{ guid }\` / \`{ packedGuid }\` field inside a \`raw()\` payload — you may instead
pass the name of something you can currently see, exactly as a player points at
things by name. Resolution ignores case, spacing and apostrophes, then takes an
exact name, else a unique substring, else a unique near-miss (one typo, two in a
name of eight characters or more). One match acts; nothing matching, or two
things matching, refuses and lists what is in view — the SDK never picks between
referents. When the match was not exact the answer carries
\`resolved: { input, name, guid }\` so you can see what you acted on. Items work
the same way in place of a bag number (\`equipItem("Bronze Axe")\`), against what
you carry. Guids and opcode names are never fuzzed.

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
(guid, name, level, position, zone and area — \`{ id, name }\`, the game's own
zone/subzone as the client names them on screen, e.g. "Elwynn Forest" /
"Northshire Valley" — health, targetGuid) and \`state.nearby\` (a Map
keyed by guid) are plain properties; the members below are getters and methods.
Observed fields are wrapped as \`{ value, seq, ts }\` — read \`.value\`. Every field
is \`undefined\` until an event carried it; \`undefined\` means unobserved, never
zero.

${table(STATE_ROWS)}

## Events (\`sdk.events\`)

Events are the server's \`SMSG_*\` packets as JSON, plus a few \`WB_*\` events for
what a client knows locally: \`WB_MOVE_RESULT\` / \`WB_MOVE_PROGRESS\` (own moves),
\`WB_AREA\` (\`{ mapId, zoneId, zoneName, areaId, areaName }\` on login and whenever
the zone or subzone changes, by foot, teleport or transfer — what \`state.self.zone\`
/ \`state.self.area\` are folded from),
\`WB_RIDE_PROGRESS\` (own position while a transport carries you, ≤1/s) and
\`WB_TRANSPORT_PROGRESS\` (\`{ guid, entry, pos, docked, progressMs, periodMs }\`
per transport in view, ≤1/s — the same facts as the \`docked\` column of
\`state.units()\`).

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
