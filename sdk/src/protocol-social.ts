/**
 * Wire protocol of the shared social surface: pets, group, mail, bank, trade,
 * group loot rolls and item text (items 98, 100, 102, 103).
 *
 * Split out of `protocol.ts` along the banners the two files already shared;
 * the same seam splits `state.ts` / `state-social.ts` and the two stay paired.
 * The rules of `protocol.ts` apply unchanged here: every `data` shape is a
 * loose object, and this is still the external boundary where Zod is used.
 *
 * It imports `guidSchema` from `./guid`, never from `./protocol`:
 * `protocol.ts` names these schemas in `eventDataSchemas`, so the arrow
 * between the two files points only one way and there is no evaluation cycle.
 * `protocol.ts` re-exports everything here, so `./protocol` still names it.
 */

import { z } from "zod";

import { guidSchema } from "./guid";

// ------------------------------------------------------------------ pets (item 98)

/** One button of the pet action bar as `SMSG_PET_SPELLS` carries it. */
export const petActionBarButtonSchema = z.looseObject({
  slot: z.number(),
  /** The wire's button type byte: 0x07 a command, 0x06 a react state, 0x01/0x81/0xC1 a spell (passive / castable / autocast). */
  type: z.number(),
  /** `CommandStates`: 0 stay, 1 follow, 2 attack, 3 abandon. */
  command: z.number().optional(),
  /** `ReactStates`: 0 passive, 1 defensive, 2 aggressive. */
  reaction: z.number().optional(),
  spellId: z.number().optional(),
  autocast: z.boolean().optional(),
  rank: z.number().optional(),
  name: z.string().optional(),
});
export type PetActionBarButton = z.infer<typeof petActionBarButtonSchema>;

/** One spell of the pet's book; `active` is the wire's autocast byte (0xC1 on, 0x81 off, 0x01 passive). */
export const petSpellSchema = z.looseObject({
  spellId: z.number(),
  active: z.number(),
  autocast: z.boolean(),
  rank: z.number().optional(),
  name: z.string().optional(),
});
export type PetSpell = z.infer<typeof petSpellSchema>;

/**
 * `SMSG_PET_SPELLS`: the pet control bar. `removed: true` (guid `"0"`, nothing
 * else) is the bar going away — the pet died, was dismissed or abandoned.
 * Otherwise the pet's guid, its creature family, `durationMs` (0 permanent),
 * the react and command states, the ten action-bar buttons, its spellbook and
 * its cooldowns. Spell names are Spell.dbc knowledge, as in the spellbook.
 */
export const petSpellsDataSchema = z.looseObject({
  guid: guidSchema,
  removed: z.boolean(),
  family: z.number().optional(),
  durationMs: z.number().optional(),
  reactState: z.number().optional(),
  commandState: z.number().optional(),
  flags: z.number().optional(),
  actionBar: z.array(petActionBarButtonSchema).optional(),
  spells: z.array(petSpellSchema).optional(),
  cooldowns: z.array(z.looseObject({ spellId: z.number(), category: z.number(), cooldownMs: z.number(), categoryCooldownMs: z.number() })).optional(),
});
export type PetSpellsData = z.infer<typeof petSpellsDataSchema>;

/** `SMSG_PET_ACTION_FEEDBACK`: 1 the pet is dead, 2 nothing to attack, 3 cannot attack that target. */
export const petActionFeedbackDataSchema = z.looseObject({ feedback: z.number() });
export type PetActionFeedbackData = z.infer<typeof petActionFeedbackDataSchema>;

/** `SMSG_PET_TAME_FAILURE`: a `PetTameFailure` code (`petTameFailureText` names them). */
export const petTameFailureDataSchema = z.looseObject({ result: z.number() });
export type PetTameFailureData = z.infer<typeof petTameFailureDataSchema>;

/** `SMSG_PET_CAST_FAILED`: the `SMSG_CAST_FAILED` shape for a spell the pet was told to cast. */
export const petCastFailedDataSchema = z.looseObject({
  spellId: z.number(),
  result: z.number(),
  rank: z.number().optional(),
  name: z.string().optional(),
});
export type PetCastFailedData = z.infer<typeof petCastFailedDataSchema>;

/** `SMSG_PET_NAME_QUERY_RESPONSE`: the given name for a pet number (the module asked when the pet came into view). */
export const petNameQueryResponseDataSchema = z.looseObject({
  petNumber: z.number(),
  found: z.boolean(),
  name: z.string().optional(),
});
export type PetNameQueryResponseData = z.infer<typeof petNameQueryResponseDataSchema>;

/** `SMSG_PET_NAME_INVALID`: a rename the server refused, with its `PetNameInvalidReason`. */
export const petNameInvalidDataSchema = z.looseObject({ reason: z.number(), name: z.string() });
export type PetNameInvalidData = z.infer<typeof petNameInvalidDataSchema>;

// ----------------------------------------------------------------- group (item 100)

/** `SMSG_GROUP_INVITE`: `canAccept` true is an invitation from `inviterName`; false is the "already grouped" notice. */
export const groupInviteDataSchema = z.looseObject({ canAccept: z.boolean(), inviterName: z.string() });
export type GroupInviteData = z.infer<typeof groupInviteDataSchema>;

/** `SMSG_GROUP_DECLINE` (they declined) and `SMSG_GROUP_SET_LEADER` (the new leader), both by name. */
export const groupNameDataSchema = z.looseObject({ name: z.string() });
export type GroupNameData = z.infer<typeof groupNameDataSchema>;

/** `SMSG_PARTY_COMMAND_RESULT`: the server's verdict on a party operation (`partyResultText` names `result`). */
export const partyCommandResultDataSchema = z.looseObject({
  /** 0 invite, 1 uninvite, 2 leave, 4 swap. */
  operation: z.number(),
  name: z.string(),
  result: z.number(),
  value: z.number(),
});
export type PartyCommandResultData = z.infer<typeof partyCommandResultDataSchema>;

export const groupMemberSchema = z.looseObject({
  name: z.string(),
  guid: guidSchema,
  online: z.boolean(),
  subGroup: z.number(),
  flags: z.number(),
  roles: z.number(),
});
export type GroupMemberData = z.infer<typeof groupMemberSchema>;

/**
 * `SMSG_GROUP_LIST`: the party as the server last sent it — the *other*
 * members (never self), the leader, and the loot settings. `left: true` is
 * the "you are no longer in a group" form.
 */
export const groupListDataSchema = z.looseObject({
  groupType: z.number(),
  left: z.boolean(),
  raid: z.boolean(),
  subGroup: z.number(),
  memberFlags: z.number(),
  roles: z.number(),
  groupGuid: guidSchema,
  counter: z.number(),
  members: z.array(groupMemberSchema),
  leaderGuid: guidSchema,
  lootMethod: z.number().optional(),
  looterGuid: guidSchema.optional(),
  lootThreshold: z.number().optional(),
  dungeonDifficulty: z.number().optional(),
  raidDifficulty: z.number().optional(),
});
export type GroupListData = z.infer<typeof groupListDataSchema>;

// ------------------------------------------------------------------ mail (item 100)

/** `SMSG_SHOW_MAILBOX` / `SMSG_SHOW_BANK`: the frame opened for this guid. */
export const showFrameDataSchema = z.looseObject({ guid: guidSchema });
export type ShowFrameData = z.infer<typeof showFrameDataSchema>;

/**
 * `SMSG_SEND_MAIL_RESULT`: `action` 0 send, 1 money taken, 2 item taken, 3
 * returned, 4 deleted, 5 made permanent; `result` 0 ok, else a
 * `MailResponseResult` (`mailResultText` names them); `inventoryResult` when
 * the result is an equip error.
 */
export const sendMailResultDataSchema = z.looseObject({
  mailId: z.number(),
  action: z.number(),
  result: z.number(),
  inventoryResult: z.number().optional(),
  itemGuidLow: z.number().optional(),
  count: z.number().optional(),
});
export type SendMailResultData = z.infer<typeof sendMailResultDataSchema>;

export const mailItemSchema = z.looseObject({
  index: z.number(),
  /** The low guid `takeMailItem` sends back (`CMSG_MAIL_TAKE_ITEM`). */
  itemGuidLow: z.number(),
  itemId: z.number(),
  count: z.number(),
});
export type MailItemData = z.infer<typeof mailItemSchema>;

export const mailEntrySchema = z.looseObject({
  mailId: z.number(),
  /** 0 a player (`senderGuid`), else a creature / gameobject / auction / calendar source (`senderId`). */
  type: z.number(),
  senderGuid: guidSchema.optional(),
  senderId: z.number().optional(),
  cod: z.number(),
  stationery: z.number(),
  money: z.number(),
  flags: z.number(),
  read: z.boolean(),
  daysLeft: z.number(),
  templateId: z.number(),
  subject: z.string(),
  body: z.string(),
  items: z.array(mailItemSchema),
});
export type MailEntryData = z.infer<typeof mailEntrySchema>;

/** `SMSG_MAIL_LIST_RESULT`: the inbox as the mailbox lists it (`total` counts mails the packet could not fit too). */
export const mailListResultDataSchema = z.looseObject({
  total: z.number(),
  count: z.number(),
  mails: z.array(mailEntrySchema),
});
export type MailListResultData = z.infer<typeof mailListResultDataSchema>;

/** `SMSG_BUY_BANK_SLOT_RESULT`: 0 failed (too many), 1 not enough money, 2 not a banker, 3 bought. */
export const buyBankSlotResultDataSchema = z.looseObject({ result: z.number() });
export type BuyBankSlotResultData = z.infer<typeof buyBankSlotResultDataSchema>;

// ----------------------------------------------------------------- trade (item 100)

/** `SMSG_TRADE_STATUS`: a `TradeStatus` code (`tradeStatusText` names them) with the fields that status carries. */
export const tradeStatusDataSchema = z.looseObject({
  status: z.number(),
  traderGuid: guidSchema.optional(),
  inventoryResult: z.number().optional(),
  targetError: z.boolean().optional(),
  limitedItemId: z.number().optional(),
  slot: z.number().optional(),
});
export type TradeStatusData = z.infer<typeof tradeStatusDataSchema>;

/** `SMSG_TRADE_STATUS_EXTENDED`: one side of the trade window (`theirs` says whose); slot 6 is the "will not be traded" slot. */
export const tradeStatusExtendedDataSchema = z.looseObject({
  theirs: z.boolean(),
  money: z.number(),
  spellId: z.number(),
  items: z.array(z.looseObject({ slot: z.number(), itemId: z.number(), count: z.number(), wrapped: z.boolean() })),
});
export type TradeStatusExtendedData = z.infer<typeof tradeStatusExtendedDataSchema>;

/** `result` is an InventoryResult code; the SDK does not name them. */
export const inventoryChangeFailureDataSchema = z.looseObject({
  result: z.number(),
  itemGuid: guidSchema.optional(),
  itemGuid2: guidSchema.optional(),
  requiredLevel: z.number().optional(),
});
export type InventoryChangeFailureData = z.infer<typeof inventoryChangeFailureDataSchema>;

/** One `(statType, value)` pair of an item's stat list (`ItemModType` ids: 3 agility, 4 strength, 5 intellect, 6 spirit, 7 stamina, ...). */
export const itemStatSchema = z.looseObject({
  type: z.number(),
  value: z.number(),
});
export type ItemStat = z.infer<typeof itemStatSchema>;

/** One damage range of a weapon; `type` is the school (0 physical). Zero ranges are not served. */
export const itemDamageSchema = z.looseObject({
  min: z.number(),
  max: z.number(),
  type: z.number(),
});
export type ItemDamage = z.infer<typeof itemDamageSchema>;

/** One of an item's spell slots; `trigger` 0 on use, 1 on equip, 2 chance on hit, 5 learn. Empty slots are not served. */
export const itemSpellSchema = z.looseObject({
  spellId: z.number(),
  trigger: z.number(),
  charges: z.number(),
  name: z.string().optional(),
});
export type ItemSpell = z.infer<typeof itemSpellSchema>;

/**
 * `SMSG_ITEM_QUERY_SINGLE_RESPONSE`: the item template as the tooltip shows
 * it. Everything past `subClass` was added 2026-08-29 (item 97) and is
 * absent from older modules' events.
 */
export const itemQueryResponseDataSchema = z.looseObject({
  itemId: z.number(),
  found: z.boolean(),
  name: z.string().optional(),
  quality: z.number().optional(),
  inventoryType: z.number().optional(),
  buyPrice: z.number().optional(),
  sellPrice: z.number().optional(),
  itemLevel: z.number().optional(),
  requiredLevel: z.number().optional(),
  class: z.number().optional(),
  subClass: z.number().optional(),
  requiredSkill: z.number().optional(),
  requiredSkillRank: z.number().optional(),
  requiredSkillName: z.string().optional(),
  requiredSpell: z.number().optional(),
  requiredReputationFaction: z.number().optional(),
  requiredReputationRank: z.number().optional(),
  requiredReputationFactionName: z.string().optional(),
  maxCount: z.number().optional(),
  stackable: z.number().optional(),
  containerSlots: z.number().optional(),
  stats: z.array(itemStatSchema).optional(),
  damage: z.array(itemDamageSchema).optional(),
  armor: z.number().optional(),
  resistances: z.record(z.string(), z.number()).optional(),
  speedMs: z.number().optional(),
  spells: z.array(itemSpellSchema).optional(),
  bonding: z.number().optional(),
  description: z.string().optional(),
  startQuest: z.number().optional(),
  /** The item's first page (PageText id) when it can be read; absent otherwise. Item 103. */
  pageText: z.number().optional(),
  block: z.number().optional(),
  maxDurability: z.number().optional(),
});
export type ItemQueryResponseData = z.infer<typeof itemQueryResponseDataSchema>;

// ------------------------------------------------------ group loot rolls (item 102)

/**
 * `SMSG_LOOT_START_ROLL`: a roll frame opened for one over-threshold item on
 * a group-looted corpse. `rollGuid` is the fresh guid the core minted for the
 * roll (what `CMSG_LOOT_ROLL` names); `countdownMs` is how long the frame
 * stays open. Pass is always allowed; need/greed/disenchant are per the mask.
 */
export const lootStartRollDataSchema = z.looseObject({
  rollGuid: guidSchema,
  slot: z.number(),
  itemId: z.number(),
  count: z.number(),
  countdownMs: z.number(),
  voteMask: z.number(),
  canNeed: z.boolean(),
  canGreed: z.boolean(),
  canDisenchant: z.boolean(),
});
export type LootStartRollData = z.infer<typeof lootStartRollDataSchema>;

/** `SMSG_LOOT_ROLL`: one counted vote. `roll` 1-100, or 128 for a pass; `rollType` 0 pass, 1 need, 2 greed, 3 disenchant. */
export const lootRollDataSchema = z.looseObject({
  rollGuid: guidSchema,
  slot: z.number(),
  playerGuid: guidSchema,
  itemId: z.number(),
  roll: z.number(),
  rollType: z.number(),
  autoPass: z.boolean(),
});
export type LootRollData = z.infer<typeof lootRollDataSchema>;

/** `SMSG_LOOT_ROLL_WON`: the roll is decided; the item goes to `winnerGuid`. */
export const lootRollWonDataSchema = z.looseObject({
  rollGuid: guidSchema,
  slot: z.number(),
  itemId: z.number(),
  winnerGuid: guidSchema,
  roll: z.number(),
  rollType: z.number(),
});
export type LootRollWonData = z.infer<typeof lootRollWonDataSchema>;

/** `SMSG_LOOT_ALL_PASSED`: everyone passed; the item stays on the corpse for whoever loots it. */
export const lootAllPassedDataSchema = z.looseObject({
  rollGuid: guidSchema,
  slot: z.number(),
  itemId: z.number(),
});
export type LootAllPassedData = z.infer<typeof lootAllPassedDataSchema>;

/** `SMSG_LOOT_MASTER_LIST`: who the master looter may assign an item to. */
export const lootMasterListDataSchema = z.looseObject({
  looters: z.array(z.looseObject({ guid: guidSchema })),
});
export type LootMasterListData = z.infer<typeof lootMasterListDataSchema>;

// ------------------------------------------------------------ item text (item 103)

/** `SMSG_READ_ITEM_OK` / `SMSG_READ_ITEM_FAILED`: the item a `CMSG_READ_ITEM` named. */
export const readItemDataSchema = z.looseObject({ guid: guidSchema });
export type ReadItemData = z.infer<typeof readItemDataSchema>;

/** `SMSG_PAGE_TEXT_QUERY_RESPONSE`: one page of a book or letter; `nextPageId` 0 is the last page. */
export const pageTextQueryResponseDataSchema = z.looseObject({
  pageId: z.number(),
  text: z.string(),
  nextPageId: z.number(),
});
export type PageTextQueryResponseData = z.infer<typeof pageTextQueryResponseDataSchema>;

/** `SMSG_ITEM_TEXT_QUERY_RESPONSE`: the player-written text on a carried item (a mailed letter), or `found: false`. */
export const itemTextQueryResponseDataSchema = z.looseObject({
  found: z.boolean(),
  guid: guidSchema.optional(),
  text: z.string().optional(),
});
export type ItemTextQueryResponseData = z.infer<typeof itemTextQueryResponseDataSchema>;
