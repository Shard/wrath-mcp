/**
 * The state cache's shared social surface: pets, group, mail, bank, trade,
 * group loot rolls and item text.
 *
 * The read shapes the model sees for that surface, plus the client's own text
 * for the result codes those packets carry. Split out of `state.ts` along the
 * banners the seam already carried, on the same line as
 * `protocol.ts` / `protocol-social.ts` so the two halves stay paired; the
 * folding and the readers themselves stay on `StateCache`, which owns the
 * private fields they read.
 *
 * The arrow back into `state.ts` is type-only (`BagSlotItem`, `WornBag`), so
 * unlike the protocol half there is no evaluation order to get wrong.
 * `state.ts` re-exports everything here, so `./state` still names it.
 */

import type { PetActionBarButton } from "./protocol";
import type { GuidKey } from "./guid";
import type { BagSlotItem, WornBag } from "./state";

// ------------------------------------------------------------------ pets

/** The pet's react state, as the pet frame labels it. */
export type PetReaction = "passive" | "defensive" | "aggressive";
/** The pet's standing order, as the pet frame labels it. */
export type PetCommand = "stay" | "follow" | "attack" | "abandon";

/** One spell of the pet's book, with its name and whether it autocasts. */
export interface PetSpellEntry {
  readonly spellId: number;
  readonly name: string | undefined;
  readonly rank: number | undefined;
  readonly autocast: boolean;
  /** True for a passive (never cast) ability. */
  readonly passive: boolean;
}

/**
 * The pet as the pet frame shows it: the control bar from the last
 * `SMSG_PET_SPELLS`, joined at read time to the pet's own unit in view (level,
 * health, power, the creature template's name) and to the given name the
 * server answered for its pet number (`SMSG_PET_NAME_QUERY_RESPONSE`).
 * `undefined` when there is no control bar — no pet, or it died / was
 * dismissed and the server removed the bar.
 */
export interface PetState {
  readonly guid: GuidKey;
  /** The given name ("Fluffy"; a warlock demon's is its creature name), when the name query has answered. */
  readonly name: string | undefined;
  /** The creature template's name ("Imp", "Wolf"), when the creature query has answered. */
  readonly creatureName: string | undefined;
  readonly entry: number | undefined;
  readonly level: number | undefined;
  readonly health: number | undefined;
  readonly maxHealth: number | undefined;
  readonly power: number | undefined;
  readonly maxPower: number | undefined;
  /** `true` only when health was observed and is 0. */
  readonly dead: boolean | undefined;
  /** Whether the pet's unit is currently in view (its update blocks are what level/health come from). */
  readonly inView: boolean;
  /** CreatureFamily.dbc id (1 wolf, 2 cat, ... ; 0 for demons and vehicles). */
  readonly family: number;
  /** 0 for a permanent pet; else how long a temporary summon lasts. */
  readonly durationMs: number;
  readonly reaction: PetReaction;
  readonly command: PetCommand;
  readonly reactState: number;
  readonly commandState: number;
  readonly actionBar: readonly PetActionBarButton[];
  readonly spells: readonly PetSpellEntry[];
  readonly cooldowns: readonly { readonly spellId: number; readonly cooldownMs: number; readonly categoryCooldownMs: number }[];
  readonly seq: number;
  readonly ts: number;
}


// ---------------------------------------------------------------- group

/** One other member of the party, as `SMSG_GROUP_LIST` lists them (self is never in the list). */
export interface GroupMember {
  readonly guid: GuidKey;
  readonly name: string;
  readonly online: boolean;
  readonly subGroup: number;
  readonly assistant: boolean;
  readonly leader: boolean;
}

/**
 * The party: the last `SMSG_GROUP_LIST` plus the invitation and
 * verdict packets around it. `inGroup` false with a `pendingInvite` is the
 * "X invites you to a group" dialog; `lastResult` is the server's word on the
 * last invite / uninvite / leave (`partyResultText` names it).
 * `undefined` until any group packet has been observed.
 */
export interface GroupState {
  readonly inGroup: boolean;
  readonly raid: boolean;
  readonly groupGuid: GuidKey | undefined;
  readonly leaderGuid: GuidKey | undefined;
  readonly leaderName: string | undefined;
  /** True when the leader guid is our own. */
  readonly leader: boolean;
  readonly members: readonly GroupMember[];
  readonly lootMethod: number | undefined;
  readonly pendingInvite: { readonly inviterName: string; readonly seq: number; readonly ts: number } | undefined;
  readonly lastResult:
    | { readonly operation: number; readonly name: string; readonly result: number; readonly text: string; readonly seq: number; readonly ts: number }
    | undefined;
  /** The last member who declined an invitation from us, by name. */
  readonly lastDecline: { readonly name: string; readonly seq: number; readonly ts: number } | undefined;
  readonly seq: number;
  readonly ts: number;
}


// ----------------------------------------------------------------- mail

/** One attached item of a mail, with the template name joined when the item query has answered. */
export interface MailItem {
  readonly index: number;
  /** What `takeMailItem(mailId, itemGuidLow)` sends. */
  readonly itemGuidLow: number;
  readonly itemId: number;
  readonly name: string | undefined;
  readonly count: number;
}

/** One mail of the inbox as the mailbox listed it. */
export interface MailEntry {
  readonly mailId: number;
  /** 0 a player, 2 a creature, 3 a gameobject, 4 an auction, 5 the calendar. */
  readonly type: number;
  readonly senderGuid: GuidKey | undefined;
  /** The sender's name, when a name query has answered for the guid. */
  readonly senderName: string | undefined;
  readonly senderId: number | undefined;
  readonly subject: string;
  readonly body: string;
  readonly money: number;
  readonly cod: number;
  readonly read: boolean;
  readonly daysLeft: number;
  readonly items: readonly MailItem[];
}

/**
 * The mailbox: the frame last opened (`openMailbox`, or an
 * `SMSG_SHOW_MAILBOX` when the core does send one), the
 * inbox as last listed (`SMSG_MAIL_LIST_RESULT`), whether new mail has
 * arrived since (`SMSG_RECEIVED_MAIL`), and the last verdict
 * (`SMSG_SEND_MAIL_RESULT`; `mailResultText` names it). `undefined` until any
 * mail packet has been observed.
 */
export interface MailboxState {
  /** The mailbox object the frame was last opened on. */
  readonly guid: GuidKey | undefined;
  readonly mails: readonly MailEntry[];
  /** How many mails the server holds, including any the list could not fit. */
  readonly total: number;
  /** True after `SMSG_RECEIVED_MAIL` until the next list. */
  readonly newMail: boolean;
  readonly lastResult:
    | { readonly mailId: number; readonly action: number; readonly result: number; readonly text: string; readonly inventoryResult: number | undefined; readonly seq: number; readonly ts: number }
    | undefined;
  readonly seq: number;
  readonly ts: number;
}


// ----------------------------------------------------------------- bank

/**
 * The bank: the banker the frame was last opened at
 * (`SMSG_SHOW_BANK`) and the bank slots, addressed the way the bank opcodes
 * want them — `bag` 255 with `slot` 39-66 for the main bank, a bank bag's own
 * slot (67-73) with `slot` 0..numSlots-1 for its contents. The slots come
 * from the self update fields (a client has them from login), so `items` is
 * populated whether or not a bank frame is open; depositing and withdrawing
 * need the frame.
 */
export interface BankContents {
  readonly guid: GuidKey | undefined;
  readonly items: readonly BagSlotItem[];
  readonly bags: readonly WornBag[];
  /** Empty slots across the main bank slots the character has bought and every bank bag of known size. */
  readonly freeSlots: number;
  readonly totalSlots: number;
}


// ---------------------------------------------------------------- trade

/**
 * The trade window: the last `SMSG_TRADE_STATUS`
 * (`tradeStatusText` names it) and both sides of the window from
 * `SMSG_TRADE_STATUS_EXTENDED`. `open` is true from the window opening until
 * a cancel, a completion or a close. `undefined` until any trade packet.
 */
export interface TradeState {
  readonly status: number;
  readonly statusText: string;
  readonly open: boolean;
  readonly traderGuid: GuidKey | undefined;
  readonly mine: TradeSide | undefined;
  readonly theirs: TradeSide | undefined;
  readonly seq: number;
  readonly ts: number;
}

export interface TradeSide {
  readonly money: number;
  readonly items: readonly { readonly slot: number; readonly itemId: number; readonly name: string | undefined; readonly count: number }[];
  readonly seq: number;
}


// ---------------------------- pets, group, mail, trade result text

const PARTY_RESULT_TEXT: Readonly<Record<number, string>> = {
  0: "ok",
  1: "cannot find that player",
  2: "that player is not in your party",
  3: "that player is not in your instance",
  4: "your party is full",
  5: "that player is already in a group",
  6: "you are not in a group",
  7: "you are not the party leader",
  8: "that player is of the wrong faction",
  9: "that player is ignoring you",
  12: "that player is in the dungeon finder queue",
  13: "invites are restricted",
  14: "cannot invite while in combat",
  15: "unknown realm",
  16: "party server unavailable",
  17: "the party is busy",
  18: "ambiguous player name",
};

const MAIL_RESULT_TEXT: Readonly<Record<number, string>> = {
  0: "ok",
  1: "inventory problem (see inventoryResult)",
  2: "cannot send mail to yourself",
  3: "not enough money",
  4: "recipient not found",
  5: "recipient is not on your faction",
  6: "internal mail error",
  14: "mail is disabled for trial accounts",
  15: "the recipient's mailbox is full",
  16: "cannot send a wrapped item with COD",
  17: "mail and chat are suspended",
  18: "too many attachments",
  19: "an attachment is invalid",
  21: "the item has expired",
};

const TRADE_STATUS_TEXT: Readonly<Record<number, string>> = {
  0: "busy",
  1: "begin trade",
  2: "window open",
  3: "trade canceled",
  4: "trade accepted",
  5: "busy",
  6: "no target",
  7: "back to trade",
  8: "trade complete",
  9: "trade rejected",
  10: "target too far away",
  11: "wrong faction",
  12: "window closed",
  14: "target is ignoring you",
  15: "you are stunned",
  16: "target is stunned",
  17: "you are dead",
  18: "target is dead",
  19: "you are logging out",
  20: "target is logging out",
  21: "trial account",
  22: "wrong realm",
  23: "not on the tap list",
};

const PET_TAME_FAILURE_TEXT: Readonly<Record<number, string>> = {
  1: "invalid creature",
  2: "you already have too many pets",
  3: "that creature is already owned",
  4: "that creature cannot be tamed",
  5: "another summon is active",
  6: "units cannot tame",
  7: "no pet available",
  8: "internal error",
  9: "the creature's level is too high",
  10: "the creature is dead",
  11: "the creature is not dead",
  12: "you cannot control exotic pets",
  13: "unknown error",
};

const PET_FEEDBACK_TEXT: Readonly<Record<number, string>> = {
  0: "none",
  1: "your pet is dead",
  2: "there is nothing to attack",
  3: "your pet cannot attack that target",
};

// ----------------------------------------------------- group loot rolls

/** A vote on a group loot roll, as the roll frame's buttons name them. */
export type RollChoice = "need" | "greed" | "pass" | "disenchant";

/** The wire `RollVote` for each button (`CMSG_LOOT_ROLL`, `SMSG_LOOT_ROLL.rollType`). */
export const ROLL_VOTE: Readonly<Record<RollChoice, number>> = { pass: 0, need: 1, greed: 2, disenchant: 3 };

/**
 * One open roll frame: an over-threshold item on a group-looted
 * corpse the server asked this character to vote on (`SMSG_LOOT_START_ROLL`).
 * `rollGuid` is what the vote names; `deadline` is when the frame closes
 * (arrival plus the countdown, on the local clock); `allowed` lists the
 * buttons the server offered — pass is always among them.
 */
export interface PendingRoll {
  readonly rollGuid: GuidKey;
  readonly slot: number;
  readonly itemId: number;
  /** From the item query, when answered. */
  readonly name: string | undefined;
  readonly quality: number | undefined;
  readonly count: number;
  readonly allowed: readonly RollChoice[];
  readonly deadline: number;
  readonly seq: number;
  readonly ts: number;
}


// ------------------------------------------------------------ item text

/**
 * The text of a carried item the character has read: a book's or
 * letter's pages (`SMSG_PAGE_TEXT_QUERY_RESPONSE`, in chain order) or the
 * player-written text on a mailed letter (`SMSG_ITEM_TEXT_QUERY_RESPONSE`).
 */
export interface ItemText {
  readonly guid: GuidKey;
  readonly itemId: number | undefined;
  readonly name: string | undefined;
  readonly pages: readonly string[];
  /** Whether every page of the chain has arrived. */
  readonly complete: boolean;
}


// ---------------------------- pets, group, mail, trade result text

/** The client's text for a `SMSG_PARTY_COMMAND_RESULT` code; the code itself when the SDK does not name it. */
export function partyResultText(result: number): string {
  return PARTY_RESULT_TEXT[result] ?? `party result ${result}`;
}
/** The client's text for a `SMSG_SEND_MAIL_RESULT` result code. */
export function mailResultText(result: number): string {
  return MAIL_RESULT_TEXT[result] ?? `mail result ${result}`;
}
/** The client's text for a `SMSG_TRADE_STATUS` code. */
export function tradeStatusText(status: number): string {
  return TRADE_STATUS_TEXT[status] ?? `trade status ${status}`;
}
/** The client's text for a `SMSG_PET_TAME_FAILURE` code. */
export function petTameFailureText(result: number): string {
  return PET_TAME_FAILURE_TEXT[result] ?? `tame failure ${result}`;
}
/** The client's text for a `SMSG_PET_ACTION_FEEDBACK` code. */
export function petFeedbackText(feedback: number): string {
  return PET_FEEDBACK_TEXT[feedback] ?? `pet feedback ${feedback}`;
}

