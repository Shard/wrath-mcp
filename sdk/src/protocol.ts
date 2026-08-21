/**
 * Wire protocol of mod-wrathbench, transcribed from module/PROTOCOL.md.
 *
 * This is the one external boundary in the SDK, so it is the one place Zod is
 * used (CLAUDE.md). Everything downstream of `parseEventFrame` / the response
 * parsers deals in plain TypeScript types.
 *
 * Two rules keep this file additive-friendly, because PROTOCOL.md is expected
 * to grow (update-object events, more actions):
 *   - every `data` shape is a *loose* object: unknown fields pass through
 *     instead of being stripped, so a module that starts sending more does not
 *     silently lose it on the way to the state cache;
 *   - an unknown opcode is not an error. It becomes an `UnknownEvent` with its
 *     `data` unvalidated, so an SDK built against today's whitelist keeps
 *     streaming when the whitelist widens.
 */

import { z } from "zod";

/**
 * The protocol revision this file was written against. Bump deliberately: the
 * SDK surface is part of the harness surface (see sdk/README.md).
 */
export const PROTOCOL_REVISION = "phase0-stage2+movement+quest-combat";

// ---------------------------------------------------------------- primitives

/**
 * ObjectGuids are u64, and the module serialises every one of them as a decimal
 * *string* (PROTOCOL.md, "u64 values are decimal strings"): creature guids carry
 * a high part (0xF130…) far above `Number.MAX_SAFE_INTEGER`, so a bare JSON
 * number would already be corrupted by `JSON.parse` before this schema ran.
 *
 * Numbers are still accepted, because the Stage-2 slice's small player guids
 * were emitted that way and a fixture may still use them — but a string is the
 * only form that round-trips, which is what the 2^63 test pins down.
 */
export const guidSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx): bigint => {
    try {
      return typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v);
    } catch {
      ctx.addIssue({ code: "custom", message: `not a guid: ${String(v)}` });
      return z.NEVER;
    }
  });

/** A guid rendered as a decimal string; the key type for guid-keyed maps. */
export type GuidKey = string;

export function guidKey(guid: bigint): GuidKey {
  return guid.toString(10);
}

/**
 * A move's correlation id. A per-session counter that cannot approach 2^53, so
 * unlike a guid it is a plain number on the wire; a string is tolerated.
 */
export const moveIdSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `not a moveId: ${String(v)}` });
      return z.NEVER;
    }
    return n;
  });

/**
 * A position as the movement packets carry it: no map id, because no movement
 * or update block on the wire has one. Own map comes from
 * `SMSG_LOGIN_VERIFY_WORLD` and nowhere else.
 */
export const positionSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  o: z.number(),
});
export type PositionData = z.infer<typeof positionSchema>;

// ------------------------------------------------------------ HTTP responses

/** `{ ok: false, error: "<code>", ... }` from any endpoint. */
export const errorBodySchema = z.looseObject({
  ok: z.literal(false),
  // Deliberately a bare string, not an enum: a new module error code must not
  // break parsing. Known codes are typed as a union in client.ts.
  error: z.string(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** GET /health */
export const healthResponseSchema = z.looseObject({
  ok: z.literal(true),
  module: z.string(),
  worldStopped: z.boolean(),
  sessions: z.number(),
  droppedPackets: z.number(),
  droppedPacketsLive: z.number(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** POST /session */
export const sessionResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
  account: z.string(),
  character: z.string(),
  guid: guidSchema,
  inWorld: z.boolean(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** POST /action */
export const actionResponseSchema = z.looseObject({
  ok: z.literal(true),
  action: z.string(),
  token: z.string(),
});
export type ActionResponse = z.infer<typeof actionResponseSchema>;

/**
 * POST /action with `action: "move_to"`. The ack means "queued and pathing";
 * `moveId` ties the request to its terminal `WB_MOVE_RESULT` event.
 *
 * `moveId` is a counter, not a guid, so it stays a JSON number (PROTOCOL.md's
 * u64 note exempts it explicitly, and the module writes it with the numeric
 * `Add`). A numeric string is accepted anyway, so the SDK survives the module
 * ever tightening it to the guid convention.
 */
export const moveToResponseSchema = z.looseObject({
  ok: z.literal(true),
  action: z.string(),
  token: z.string(),
  moveId: moveIdSchema,
});
export type MoveToResponse = z.infer<typeof moveToResponseSchema>;

/** POST /action with `action: "face"`. Echoes the resolved absolute orientation. */
export const faceResponseSchema = z.looseObject({
  ok: z.literal(true),
  action: z.string(),
  token: z.string(),
  orientation: z.number(),
});
export type FaceResponse = z.infer<typeof faceResponseSchema>;

/** POST /character-delete */
export const characterDeleteResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
  character: z.string(),
  deleted: z.boolean(),
});
export type CharacterDeleteResponse = z.infer<typeof characterDeleteResponseSchema>;

/** DELETE /session */
export const deleteSessionResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
});
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;

// ------------------------------------------------------------ HTTP requests

/** POST /session body. */
export interface CreateSessionRequest {
  token: string;
  character: string;
  account?: string;
  race?: number;
  class?: number;
  gender?: number;
}

/**
 * POST /action body. The union widens as PROTOCOL.md grows, and `action` stays
 * the discriminant.
 *
 * `face` takes *either* an absolute `orientation` in radians or a point to turn
 * toward — never both — which is why it is two members rather than one with
 * three optional fields.
 */
export type ActionRequest =
  | { token: string; action: "say"; text: string }
  | { token: string; action: "move_to"; x: number; y: number; z: number }
  | { token: string; action: "stop" }
  | { token: string; action: "face"; orientation: number }
  | { token: string; action: "face"; x: number; y: number }
  // quest/combat extension. Guids are decimal strings on the wire.
  | { token: string; action: "set_target"; guid: string }
  | { token: string; action: "clear_target" }
  | { token: string; action: "attack_start"; guid: string }
  | { token: string; action: "attack_stop" }
  | { token: string; action: "cast_spell"; spellId: number; targetGuid?: string }
  | { token: string; action: "cancel_cast"; spellId: number }
  | { token: string; action: "interact"; guid: string }
  | { token: string; action: "gossip_hello"; guid: string }
  | { token: string; action: "gossip_select"; guid: string; menuId: number; optionId: number }
  | { token: string; action: "quest_list"; guid: string }
  | { token: string; action: "quest_details"; guid: string; questId: number }
  | { token: string; action: "quest_accept"; guid: string; questId: number }
  | { token: string; action: "quest_complete"; guid: string; questId: number }
  | { token: string; action: "quest_choose_reward"; guid: string; questId: number; rewardIndex: number }
  | { token: string; action: "quest_abandon"; questId: number }
  | { token: string; action: "loot"; guid: string }
  | { token: string; action: "loot_all"; guid: string }
  | { token: string; action: "loot_item"; slot: number }
  | { token: string; action: "loot_money" }
  | { token: string; action: "loot_release"; guid: string }
  | { token: string; action: "vendor_list"; guid: string }
  | { token: string; action: "buy_item"; guid: string; itemId: number; slot: number; count?: number }
  | { token: string; action: "sell_item"; guid: string; itemGuid: string; count?: number }
  | { token: string; action: "repair_all"; guid: string }
  | { token: string; action: "equip_item"; bag: number; slot: number }
  | { token: string; action: "use_item"; bag: number; slot: number; targetGuid?: string }
  | { token: string; action: "destroy_item"; bag: number; slot: number; count?: number }
  | { token: string; action: "repop" }
  | { token: string; action: "reclaim_corpse"; guid?: string };

/**
 * POST /character-delete body. Not session-scoped: the module stands up its own
 * parked session for the delete (ADR-0013), so `token` is a throwaway for this
 * one operation's audit log, never the live session's token.
 */
export interface CharacterDeleteRequest {
  token: string;
  character: string;
  account?: string;
}

/** DELETE /session body. */
export interface DeleteSessionRequest {
  token: string;
}

// ------------------------------------------------------------- event frames

/**
 * Emitted in place of the decoded fields when the module could not decode a
 * whitelisted packet. The event is still delivered so the drop is visible.
 */
export const decodeErrorSchema = z.looseObject({ decodeError: z.literal(true) });
export type DecodeErrorData = z.infer<typeof decodeErrorSchema>;

export const authResponseDataSchema = z.looseObject({ code: z.number() });
export type AuthResponseData = z.infer<typeof authResponseDataSchema>;

export const charEnumEntrySchema = z.looseObject({
  guid: guidSchema,
  name: z.string(),
  race: z.number(),
  class: z.number(),
  gender: z.number(),
  level: z.number(),
});
export type CharEnumEntry = z.infer<typeof charEnumEntrySchema>;

export const charEnumDataSchema = z.looseObject({
  count: z.number(),
  characters: z.array(charEnumEntrySchema),
});
export type CharEnumData = z.infer<typeof charEnumDataSchema>;

export const charCreateDataSchema = z.looseObject({ result: z.number() });
export type CharCreateData = z.infer<typeof charCreateDataSchema>;

export const characterLoginFailedDataSchema = z.looseObject({ reason: z.number() });
export type CharacterLoginFailedData = z.infer<typeof characterLoginFailedDataSchema>;

export const loginVerifyWorldDataSchema = z.looseObject({
  map: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  o: z.number(),
});
export type LoginVerifyWorldData = z.infer<typeof loginVerifyWorldDataSchema>;

/**
 * Synthetic module event: emitted as the first frame when a WebSocket attaches
 * to a session whose character is already in world (reattach after a dropped
 * socket). Carries only what SMSG_LOGIN_VERIFY_WORLD plus the session response
 * would have carried at real login.
 */
export const sessionStateDataSchema = z.looseObject({
  character: z.string(),
  guid: guidSchema,
  inWorld: z.boolean(),
  map: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  o: z.number(),
  level: z.number(),
});
export type SessionStateData = z.infer<typeof sessionStateDataSchema>;

export const motdDataSchema = z.looseObject({
  lineCount: z.number(),
  lines: z.array(z.string()),
});
export type MotdData = z.infer<typeof motdDataSchema>;

export const notificationDataSchema = z.looseObject({ text: z.string() });
export type NotificationData = z.infer<typeof notificationDataSchema>;

export const nameQueryResponseDataSchema = z.looseObject({
  guid: guidSchema,
  found: z.boolean(),
  name: z.string().optional(),
});
export type NameQueryResponseData = z.infer<typeof nameQueryResponseDataSchema>;

export const messageChatDataSchema = z.looseObject({
  type: z.number(),
  language: z.number(),
  senderGuid: guidSchema,
  message: z.string(),
  chatTag: z.number(),
});
export type MessageChatData = z.infer<typeof messageChatDataSchema>;

// ------------------------------------------- movement / observation extension

/**
 * The whitelisted update fields, decoded by name (PROTOCOL.md
 * "`SMSG_UPDATE_OBJECT.objects[]` shapes"). Every one is optional: a `values`
 * delta carries only what changed, and a block for an object the module never
 * saw a `create` for carries no named fields at all.
 *
 * The object is *loose*, so a field the module starts serving before this file
 * knows about it survives to the state cache as an unvalidated extra rather
 * than being stripped.
 *
 * The quest/combat extension's two *indexed* field families are deliberately
 * left to that passthrough rather than spelled out: `quest<0-24><Id|State|
 * CountsLo|CountsHi|Time>` and `invSlot<0-38><Lo|Hi>` are 203 keys whose only
 * consumer is the state cache's quest-log and inventory fold, which reads them
 * by name out of the field record. Enumerating them here would buy a typed
 * `fields.quest3Id` nobody wants and 203 lines of schema to keep in step with
 * the module.
 */
export const updateFieldsSchema = z.looseObject({
  // all objects
  entry: z.number().optional(),
  scale: z.number().optional(),
  // units and players
  health: z.number().optional(),
  maxHealth: z.number().optional(),
  power1: z.number().optional(),
  power2: z.number().optional(),
  power3: z.number().optional(),
  power4: z.number().optional(),
  power5: z.number().optional(),
  power6: z.number().optional(),
  power7: z.number().optional(),
  maxPower1: z.number().optional(),
  maxPower2: z.number().optional(),
  maxPower3: z.number().optional(),
  maxPower4: z.number().optional(),
  maxPower5: z.number().optional(),
  maxPower6: z.number().optional(),
  maxPower7: z.number().optional(),
  level: z.number().optional(),
  faction: z.number().optional(),
  unitFlags: z.number().optional(),
  displayId: z.number().optional(),
  dynamicFlags: z.number().optional(),
  npcFlags: z.number().optional(),
  targetGuid: guidSchema.optional(),
  race: z.number().optional(),
  class: z.number().optional(),
  gender: z.number().optional(),
  powerType: z.number().optional(),
  // players
  playerFlags: z.number().optional(),
  // players, self only (the server marks these PRIVATE)
  money: z.number().optional(),
  xp: z.number().optional(),
  nextLevelXp: z.number().optional(),
  // items and containers
  stackCount: z.number().optional(),
  durability: z.number().optional(),
  maxDurability: z.number().optional(),
  itemFlags: z.number().optional(),
  ownerLo: z.number().optional(),
  ownerHi: z.number().optional(),
  containedLo: z.number().optional(),
  containedHi: z.number().optional(),
  // game objects
  goDisplayId: z.number().optional(),
  goFlags: z.number().optional(),
  goFaction: z.number().optional(),
  goLevel: z.number().optional(),
  goState: z.number().optional(),
  goType: z.number().optional(),
});
export type UpdateFields = z.infer<typeof updateFieldsSchema>;

/**
 * A full object on first sight. `pos` is present only when the packet carried a
 * position block (LIVING / POSITION / STATIONARY_POSITION); `moveFlags` and
 * `runSpeed` only for living objects; `self` only on our own block.
 */
export const createBlockSchema = z.looseObject({
  update: z.literal("create"),
  guid: guidSchema,
  objectType: z.string(),
  self: z.boolean().optional(),
  moveFlags: z.number().optional(),
  runSpeed: z.number().optional(),
  pos: positionSchema.optional(),
  targetGuid: guidSchema.optional(),
  fields: updateFieldsSchema.optional(),
});

/** Sparse field delta for an object already in view. */
export const valuesBlockSchema = z.looseObject({
  update: z.literal("values"),
  guid: guidSchema,
  fields: updateFieldsSchema.optional(),
});

/** Movement-only block: same movement payload a create block carries. */
export const movementBlockSchema = z.looseObject({
  update: z.literal("movement"),
  guid: guidSchema,
  moveFlags: z.number().optional(),
  runSpeed: z.number().optional(),
  pos: positionSchema.optional(),
  targetGuid: guidSchema.optional(),
});

/**
 * `outOfRange` — the objects left update range. `near` shares the shape and is
 * the *opposite* claim (NEAR_OBJECTS); see the note in state.ts on why only one
 * of the two prunes.
 */
export const guidListBlockSchema = z.looseObject({
  update: z.enum(["outOfRange", "near"]),
  guids: z.array(guidSchema),
});

/** A block kind added after this SDK revision. Kept, not dropped. */
export const unknownBlockSchema = z.looseObject({ update: z.string() });

export const updateBlockSchema = z.union([
  createBlockSchema,
  valuesBlockSchema,
  movementBlockSchema,
  guidListBlockSchema,
  unknownBlockSchema,
]);
export type UpdateBlock = z.infer<typeof updateBlockSchema>;
export type CreateBlock = z.infer<typeof createBlockSchema>;
export type ValuesBlock = z.infer<typeof valuesBlockSchema>;
export type MovementBlock = z.infer<typeof movementBlockSchema>;
export type GuidListBlock = z.infer<typeof guidListBlockSchema>;

export const updateObjectDataSchema = z.looseObject({
  blocks: z.number(),
  objects: z.array(updateBlockSchema),
});
export type UpdateObjectData = z.infer<typeof updateObjectDataSchema>;

export const destroyObjectDataSchema = z.looseObject({
  guid: guidSchema,
  onDeath: z.boolean(),
});
export type DestroyObjectData = z.infer<typeof destroyObjectDataSchema>;

/** `found: false` carries the entry and nothing else. */
export const creatureQueryResponseDataSchema = z.looseObject({
  entry: z.number(),
  found: z.boolean(),
  name: z.string().optional(),
  subname: z.string().optional(),
  type: z.number().optional(),
  rank: z.number().optional(),
});
export type CreatureQueryResponseData = z.infer<typeof creatureQueryResponseDataSchema>;

/** Movement of another nearby unit or player, relayed by the server. */
export const moveUpdateDataSchema = z.looseObject({
  guid: guidSchema,
  flags: z.number(),
  pos: positionSchema,
});
export type MoveUpdateData = z.infer<typeof moveUpdateDataSchema>;

/**
 * The observed `MSG_MOVE_*` opcode names, exactly the closed set the module's
 * `MoveOpcodeName` can produce — including the bare `MSG_MOVE` it falls back to
 * for a whitelisted opcode it has no name for. All share one `data` shape.
 */
export const MOVE_OPCODES = [
  "MSG_MOVE_START_FORWARD",
  "MSG_MOVE_START_BACKWARD",
  "MSG_MOVE_STOP",
  "MSG_MOVE_START_STRAFE_LEFT",
  "MSG_MOVE_START_STRAFE_RIGHT",
  "MSG_MOVE_STOP_STRAFE",
  "MSG_MOVE_JUMP",
  "MSG_MOVE_START_TURN_LEFT",
  "MSG_MOVE_START_TURN_RIGHT",
  "MSG_MOVE_STOP_TURN",
  "MSG_MOVE_SET_FACING",
  "MSG_MOVE_HEARTBEAT",
  "MSG_MOVE_FALL_LAND",
  "MSG_MOVE_START_SWIM",
  "MSG_MOVE_STOP_SWIM",
  "MSG_MOVE_SET_RUN_MODE",
  "MSG_MOVE_SET_WALK_MODE",
  "MSG_MOVE",
] as const;
export type MoveOpcode = (typeof MOVE_OPCODES)[number];

/** Terminal statuses of a `move_to`, from PROTOCOL.md. */
export const MOVE_STATUSES = [
  "arrived",
  "no_path",
  "too_far",
  "interrupted",
  "stopped",
  "superseded",
] as const;
export type KnownMoveStatus = (typeof MOVE_STATUSES)[number];
/** Widened, so a status this revision does not know still parses. */
export type MoveStatus = KnownMoveStatus | (string & {});

/** Module-synthesized: the movement engine's interpolated own position. */
export const moveProgressDataSchema = z.looseObject({
  moveId: moveIdSchema,
  pos: positionSchema,
});
export type MoveProgressData = z.infer<typeof moveProgressDataSchema>;

/**
 * Module-synthesized terminal event of a `move_to`. `pos` is read back from the
 * live character, so an `arrived` is proof the server accepted the movement.
 */
export const moveResultDataSchema = z.looseObject({
  moveId: moveIdSchema,
  // Deliberately a bare string: a new status must widen the type, not break
  // parsing (same reasoning as `errorBodySchema.error`).
  status: z.string(),
  pos: positionSchema,
});
export type MoveResultData = z.infer<typeof moveResultDataSchema>;

// ----------------------------------------------- quest / combat extension
//
// One schema per row of PROTOCOL.md's quest/combat whitelist, in the same
// order. All loose, all optional-where-the-module-says-conditional.

export const attackStartDataSchema = z.looseObject({
  attackerGuid: guidSchema,
  victimGuid: guidSchema,
});
export type AttackStartData = z.infer<typeof attackStartDataSchema>;

export const attackStopDataSchema = z.looseObject({
  attackerGuid: guidSchema,
  victimGuid: guidSchema,
  attackerDead: z.boolean(),
});
export type AttackStopData = z.infer<typeof attackStopDataSchema>;

/** One melee swing, either direction. Per-school sub-damages are pre-summed. */
export const attackerStateUpdateDataSchema = z.looseObject({
  attackerGuid: guidSchema,
  victimGuid: guidSchema,
  hitInfo: z.number(),
  damage: z.number(),
  overkill: z.number(),
  absorb: z.number(),
  resist: z.number(),
  blocked: z.number(),
  victimState: z.number(),
  miss: z.boolean(),
  crit: z.boolean(),
});
export type AttackerStateUpdateData = z.infer<typeof attackerStateUpdateDataSchema>;

export const spellStartDataSchema = z.looseObject({
  casterGuid: guidSchema,
  spellId: z.number(),
  castTimeMs: z.number(),
  targetGuid: guidSchema.optional(),
});
export type SpellStartData = z.infer<typeof spellStartDataSchema>;

export const spellGoDataSchema = z.looseObject({
  casterGuid: guidSchema,
  spellId: z.number(),
  hitGuids: z.array(guidSchema),
  misses: z.array(z.looseObject({ guid: guidSchema, reason: z.number() })),
});
export type SpellGoData = z.infer<typeof spellGoDataSchema>;

/** `result` is a SpellCastResult code; the SDK does not name them. */
export const castFailedDataSchema = z.looseObject({
  spellId: z.number(),
  result: z.number(),
});
export type CastFailedData = z.infer<typeof castFailedDataSchema>;

export const spellFailureDataSchema = z.looseObject({
  casterGuid: guidSchema,
  spellId: z.number(),
  result: z.number(),
});
export type SpellFailureData = z.infer<typeof spellFailureDataSchema>;

export const periodicAuraLogDataSchema = z.looseObject({
  targetGuid: guidSchema,
  casterGuid: guidSchema,
  spellId: z.number(),
  auraType: z.number(),
  amount: z.number(),
});
export type PeriodicAuraLogData = z.infer<typeof periodicAuraLogDataSchema>;

/**
 * One visible aura slot. `spellId: 0` means the slot was cleared, and then the
 * module sends `removed: true` instead of the optional fields — which is why
 * every field but `slot`/`spellId` is optional here.
 */
export const auraSchema = z.looseObject({
  slot: z.number(),
  spellId: z.number(),
  removed: z.boolean().optional(),
  flags: z.number().optional(),
  level: z.number().optional(),
  stacks: z.number().optional(),
  casterGuid: guidSchema.optional(),
  maxDuration: z.number().optional(),
  duration: z.number().optional(),
});
export type AuraData = z.infer<typeof auraSchema>;

/** `SMSG_AURA_UPDATE` (changed slots) and `SMSG_AURA_UPDATE_ALL` (full list). */
export const auraUpdateDataSchema = z.looseObject({
  targetGuid: guidSchema,
  auras: z.array(auraSchema),
});
export type AuraUpdateData = z.infer<typeof auraUpdateDataSchema>;

export const logXpGainDataSchema = z.looseObject({
  victimGuid: guidSchema,
  amount: z.number(),
  fromKill: z.boolean(),
});
export type LogXpGainData = z.infer<typeof logXpGainDataSchema>;

export const levelUpInfoDataSchema = z.looseObject({
  level: z.number(),
  healthGained: z.number(),
});
export type LevelUpInfoData = z.infer<typeof levelUpInfoDataSchema>;

export const itemPushResultDataSchema = z.looseObject({
  playerGuid: guidSchema,
  itemId: z.number(),
  count: z.number(),
  totalCount: z.number(),
  bagSlot: z.number(),
  itemSlot: z.number(),
  looted: z.boolean(),
  created: z.boolean(),
});
export type ItemPushResultData = z.infer<typeof itemPushResultDataSchema>;

export const questGiverStatusDataSchema = z.looseObject({
  guid: guidSchema,
  status: z.number(),
});
export type QuestGiverStatusData = z.infer<typeof questGiverStatusDataSchema>;

/** One row of a questgiver's list, in either of the two shapes that carry it. */
export const offeredQuestSchema = z.looseObject({
  questId: z.number(),
  icon: z.number(),
  level: z.number(),
  title: z.string(),
  repeatable: z.boolean().optional(),
});
export type OfferedQuest = z.infer<typeof offeredQuestSchema>;

export const questGiverQuestListDataSchema = z.looseObject({
  guid: guidSchema,
  greeting: z.string(),
  quests: z.array(offeredQuestSchema),
});
export type QuestGiverQuestListData = z.infer<typeof questGiverQuestListDataSchema>;

/** An item reward: fixed (`rewards`) or one of a choice (`choiceRewards`). */
export const questRewardItemSchema = z.looseObject({
  itemId: z.number(),
  count: z.number(),
});
export type QuestRewardItem = z.infer<typeof questRewardItemSchema>;

export const questGiverQuestDetailsDataSchema = z.looseObject({
  guid: guidSchema,
  questId: z.number(),
  title: z.string(),
  details: z.string(),
  objectives: z.string(),
  choiceRewards: z.array(questRewardItemSchema),
  rewards: z.array(questRewardItemSchema),
  money: z.number(),
  xp: z.number(),
});
export type QuestGiverQuestDetailsData = z.infer<typeof questGiverQuestDetailsDataSchema>;

export const questGiverRequestItemsDataSchema = z.looseObject({
  guid: guidSchema,
  questId: z.number(),
  title: z.string(),
  text: z.string(),
  requiredMoney: z.number(),
  requiredItems: z.array(questRewardItemSchema),
  completable: z.boolean(),
});
export type QuestGiverRequestItemsData = z.infer<typeof questGiverRequestItemsDataSchema>;

export const questGiverOfferRewardDataSchema = z.looseObject({
  guid: guidSchema,
  questId: z.number(),
  title: z.string(),
  text: z.string(),
  choiceRewards: z.array(questRewardItemSchema),
  rewards: z.array(questRewardItemSchema),
  money: z.number(),
  xp: z.number(),
});
export type QuestGiverOfferRewardData = z.infer<typeof questGiverOfferRewardDataSchema>;

export const questGiverQuestCompleteDataSchema = z.looseObject({
  questId: z.number(),
  xp: z.number(),
  money: z.number(),
});
export type QuestGiverQuestCompleteData = z.infer<typeof questGiverQuestCompleteDataSchema>;

export const questGiverQuestFailedDataSchema = z.looseObject({
  questId: z.number(),
  reason: z.number(),
});
export type QuestGiverQuestFailedData = z.infer<typeof questGiverQuestFailedDataSchema>;

/** Kill (or gameobject, `entry | 0x80000000`) credit toward one objective. */
export const questUpdateAddKillDataSchema = z.looseObject({
  questId: z.number(),
  entry: z.number(),
  current: z.number(),
  required: z.number(),
  guid: guidSchema,
});
export type QuestUpdateAddKillData = z.infer<typeof questUpdateAddKillDataSchema>;

/** The core sends this one empty; item progress lives in the quest-log fields. */
export const questUpdateAddItemDataSchema = z.looseObject({});
export type QuestUpdateAddItemData = z.infer<typeof questUpdateAddItemDataSchema>;

export const questUpdateQuestIdDataSchema = z.looseObject({ questId: z.number() });
export type QuestUpdateQuestIdData = z.infer<typeof questUpdateQuestIdDataSchema>;

export const gossipOptionSchema = z.looseObject({
  optionId: z.number(),
  icon: z.number(),
  text: z.string(),
});
export type GossipOption = z.infer<typeof gossipOptionSchema>;

/**
 * A gossip menu — which, on a gossip-flagged questgiver, is *also* how the
 * quest list arrives (`quests[]`), instead of `SMSG_QUESTGIVER_QUEST_LIST`.
 * Callers that want offered quests must accept either opcode.
 */
export const gossipMessageDataSchema = z.looseObject({
  guid: guidSchema,
  menuId: z.number(),
  textId: z.number(),
  options: z.array(gossipOptionSchema),
  quests: z.array(offeredQuestSchema),
});
export type GossipMessageData = z.infer<typeof gossipMessageDataSchema>;

export const emptyDataSchema = z.looseObject({});
export type EmptyData = z.infer<typeof emptyDataSchema>;

/** One row of an open loot window. `slotType` 0 is free to loot. */
export const lootItemSchema = z.looseObject({
  slot: z.number(),
  itemId: z.number(),
  count: z.number(),
  slotType: z.number(),
});
export type LootItemData = z.infer<typeof lootItemSchema>;

export const lootResponseDataSchema = z.looseObject({
  guid: guidSchema,
  lootType: z.number(),
  gold: z.number(),
  items: z.array(lootItemSchema),
});
export type LootResponseData = z.infer<typeof lootResponseDataSchema>;

export const lootRemovedDataSchema = z.looseObject({ slot: z.number() });
export type LootRemovedData = z.infer<typeof lootRemovedDataSchema>;

export const lootMoneyNotifyDataSchema = z.looseObject({ money: z.number() });
export type LootMoneyNotifyData = z.infer<typeof lootMoneyNotifyDataSchema>;

export const lootReleaseResponseDataSchema = z.looseObject({ guid: guidSchema });
export type LootReleaseResponseData = z.infer<typeof lootReleaseResponseDataSchema>;

/** `slot` is 1-based; `leftInStock` -1 means unlimited. */
export const vendorItemSchema = z.looseObject({
  slot: z.number(),
  itemId: z.number(),
  price: z.number(),
  buyCount: z.number(),
  leftInStock: z.number(),
  extendedCost: z.number(),
});
export type VendorItem = z.infer<typeof vendorItemSchema>;

export const listInventoryDataSchema = z.looseObject({
  vendorGuid: guidSchema,
  items: z.array(vendorItemSchema),
  emptyReason: z.number().optional(),
});
export type ListInventoryData = z.infer<typeof listInventoryDataSchema>;

export const buyItemDataSchema = z.looseObject({
  vendorGuid: guidSchema,
  slot: z.number(),
  count: z.number(),
});
export type BuyItemData = z.infer<typeof buyItemDataSchema>;

export const buyFailedDataSchema = z.looseObject({
  vendorGuid: guidSchema,
  itemId: z.number(),
  result: z.number(),
});
export type BuyFailedData = z.infer<typeof buyFailedDataSchema>;

export const sellItemDataSchema = z.looseObject({
  vendorGuid: guidSchema,
  itemGuid: guidSchema,
  result: z.number(),
});
export type SellItemData = z.infer<typeof sellItemDataSchema>;

/** `result` is an InventoryResult code; the SDK does not name them. */
export const inventoryChangeFailureDataSchema = z.looseObject({
  result: z.number(),
  itemGuid: guidSchema.optional(),
  itemGuid2: guidSchema.optional(),
  requiredLevel: z.number().optional(),
});
export type InventoryChangeFailureData = z.infer<typeof inventoryChangeFailureDataSchema>;

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
});
export type ItemQueryResponseData = z.infer<typeof itemQueryResponseDataSchema>;

/** `map: -1` clears the release marker. */
export const deathReleaseLocDataSchema = z.looseObject({
  map: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type DeathReleaseLocData = z.infer<typeof deathReleaseLocDataSchema>;

export const corpseReclaimDelayDataSchema = z.looseObject({ delayMs: z.number() });
export type CorpseReclaimDelayData = z.infer<typeof corpseReclaimDelayDataSchema>;

export const charDeleteDataSchema = z.looseObject({ result: z.number() });
export type CharDeleteData = z.infer<typeof charDeleteDataSchema>;

/**
 * A creature's movement, reduced to what a player perceives: where it is, where
 * it is heading, and how long it will take. The spline points are consumed by
 * the module and never served (ADR-0010/0013). A stopped creature sends
 * `stopped: true` and no destination.
 */
export const monsterMoveDataSchema = z.looseObject({
  guid: guidSchema,
  pos: z.looseObject({ x: z.number(), y: z.number(), z: z.number() }),
  destination: z.looseObject({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  durationMs: z.number().optional(),
  stopped: z.boolean().optional(),
});
export type MonsterMoveData = z.infer<typeof monsterMoveDataSchema>;

const moveOpcodeSchemas = Object.fromEntries(
  MOVE_OPCODES.map((op) => [op, moveUpdateDataSchema]),
) as { [K in MoveOpcode]: typeof moveUpdateDataSchema };

/**
 * Opcode name -> decoded `data` schema. Add a row when PROTOCOL.md adds one;
 * nothing else in the SDK needs to change for the event to reach the stream.
 */
export const eventDataSchemas = {
  SMSG_AUTH_RESPONSE: authResponseDataSchema,
  SMSG_CHAR_ENUM: charEnumDataSchema,
  SMSG_CHAR_CREATE: charCreateDataSchema,
  SMSG_CHARACTER_LOGIN_FAILED: characterLoginFailedDataSchema,
  SMSG_LOGIN_VERIFY_WORLD: loginVerifyWorldDataSchema,
  SMSG_MOTD: motdDataSchema,
  SMSG_NOTIFICATION: notificationDataSchema,
  SMSG_NAME_QUERY_RESPONSE: nameQueryResponseDataSchema,
  SMSG_MESSAGECHAT: messageChatDataSchema,
  // movement / observation extension
  SMSG_UPDATE_OBJECT: updateObjectDataSchema,
  SMSG_DESTROY_OBJECT: destroyObjectDataSchema,
  SMSG_CREATURE_QUERY_RESPONSE: creatureQueryResponseDataSchema,
  WB_MOVE_PROGRESS: moveProgressDataSchema,
  WB_SESSION_STATE: sessionStateDataSchema,
  WB_MOVE_RESULT: moveResultDataSchema,
  ...moveOpcodeSchemas,
  // quest/combat extension — combat
  SMSG_ATTACKSTART: attackStartDataSchema,
  SMSG_ATTACKSTOP: attackStopDataSchema,
  SMSG_ATTACKERSTATEUPDATE: attackerStateUpdateDataSchema,
  SMSG_SPELL_START: spellStartDataSchema,
  SMSG_SPELL_GO: spellGoDataSchema,
  SMSG_CAST_FAILED: castFailedDataSchema,
  SMSG_SPELL_FAILURE: spellFailureDataSchema,
  SMSG_PERIODICAURALOG: periodicAuraLogDataSchema,
  SMSG_AURA_UPDATE: auraUpdateDataSchema,
  SMSG_AURA_UPDATE_ALL: auraUpdateDataSchema,
  // progress
  SMSG_LOG_XPGAIN: logXpGainDataSchema,
  SMSG_LEVELUP_INFO: levelUpInfoDataSchema,
  SMSG_ITEM_PUSH_RESULT: itemPushResultDataSchema,
  // quests and gossip
  SMSG_QUESTGIVER_STATUS: questGiverStatusDataSchema,
  SMSG_QUESTGIVER_QUEST_LIST: questGiverQuestListDataSchema,
  SMSG_QUESTGIVER_QUEST_DETAILS: questGiverQuestDetailsDataSchema,
  SMSG_QUESTGIVER_REQUEST_ITEMS: questGiverRequestItemsDataSchema,
  SMSG_QUESTGIVER_OFFER_REWARD: questGiverOfferRewardDataSchema,
  SMSG_QUESTGIVER_QUEST_COMPLETE: questGiverQuestCompleteDataSchema,
  SMSG_QUESTGIVER_QUEST_FAILED: questGiverQuestFailedDataSchema,
  SMSG_QUESTUPDATE_ADD_KILL: questUpdateAddKillDataSchema,
  SMSG_QUESTUPDATE_ADD_ITEM: questUpdateAddItemDataSchema,
  SMSG_QUESTUPDATE_COMPLETE: questUpdateQuestIdDataSchema,
  SMSG_QUESTUPDATE_FAILED: questUpdateQuestIdDataSchema,
  SMSG_GOSSIP_MESSAGE: gossipMessageDataSchema,
  SMSG_GOSSIP_COMPLETE: emptyDataSchema,
  // loot, vendor, inventory
  SMSG_LOOT_RESPONSE: lootResponseDataSchema,
  SMSG_LOOT_REMOVED: lootRemovedDataSchema,
  SMSG_LOOT_MONEY_NOTIFY: lootMoneyNotifyDataSchema,
  SMSG_LOOT_CLEAR_MONEY: emptyDataSchema,
  SMSG_LOOT_RELEASE_RESPONSE: lootReleaseResponseDataSchema,
  SMSG_LIST_INVENTORY: listInventoryDataSchema,
  SMSG_BUY_ITEM: buyItemDataSchema,
  SMSG_BUY_FAILED: buyFailedDataSchema,
  SMSG_SELL_ITEM: sellItemDataSchema,
  SMSG_INVENTORY_CHANGE_FAILURE: inventoryChangeFailureDataSchema,
  SMSG_ITEM_QUERY_SINGLE_RESPONSE: itemQueryResponseDataSchema,
  // death
  SMSG_DEATH_RELEASE_LOC: deathReleaseLocDataSchema,
  SMSG_CORPSE_RECLAIM_DELAY: corpseReclaimDelayDataSchema,
  SMSG_DURABILITY_DAMAGE_DEATH: emptyDataSchema,
  // session
  SMSG_CHAR_DELETE: charDeleteDataSchema,
  // creature movement
  SMSG_MONSTER_MOVE: monsterMoveDataSchema,
} as const;

export type KnownOpcode = keyof typeof eventDataSchemas;

export const KNOWN_OPCODES = Object.keys(eventDataSchemas) as KnownOpcode[];

export function isKnownOpcode(opcode: string): opcode is KnownOpcode {
  return Object.hasOwn(eventDataSchemas, opcode);
}

const MOVE_OPCODE_SET = new Set<string>(MOVE_OPCODES);

/** True for any observed `MSG_MOVE_*` opcode: they all share one `data` shape. */
export function isMoveOpcode(opcode: string): opcode is MoveOpcode {
  return MOVE_OPCODE_SET.has(opcode);
}

/** The envelope every frame carries, before `data` is interpreted. */
export const eventEnvelopeSchema = z.looseObject({
  seq: z.number(),
  opcode: z.string(),
  opcodeId: z.number(),
  ts: z.number(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

interface EventBase {
  readonly seq: number;
  readonly opcodeId: number;
  /** Unix epoch milliseconds, as the module stamped it. */
  readonly ts: number;
}

/** A whitelisted opcode whose `data` this SDK knows how to type. */
export type KnownEvent = {
  [K in KnownOpcode]: EventBase & {
    readonly opcode: K;
    readonly data: z.infer<(typeof eventDataSchemas)[K]> | DecodeErrorData;
  };
}[KnownOpcode];

/**
 * A well-formed frame carrying an opcode this SDK revision does not know, or a
 * known opcode whose `data` failed validation. Never dropped: the model can
 * still see that something happened.
 */
export interface UnknownEvent extends EventBase {
  readonly opcode: string;
  readonly data: unknown;
  /** Set when the opcode *is* whitelisted but `data` did not match its schema. */
  readonly schemaError?: string;
}

/** Any event that came off the wire. */
export type GameEvent = KnownEvent | UnknownEvent;

/**
 * Narrow an event to one opcode's decoded shape.
 *
 * Needed because `UnknownEvent.opcode` is `string`, so a plain
 * `event.opcode === "SMSG_MESSAGECHAT"` comparison cannot exclude it and
 * `data` stays `unknown`. Returns false for an event whose payload failed this
 * SDK revision's schema, so a caller that narrows is guaranteed real fields.
 */
export function isEvent<K extends KnownOpcode>(
  event: { readonly opcode: string; readonly data: unknown },
  opcode: K,
): event is Extract<KnownEvent, { opcode: K }> {
  if (event.opcode !== opcode) return false;
  const schemaError = (event as { schemaError?: string }).schemaError;
  return schemaError === undefined;
}

/** True when `data` is the module's decode-failure marker. */
export function isDecodeError(data: unknown): data is DecodeErrorData {
  return typeof data === "object" && data !== null && (data as { decodeError?: unknown }).decodeError === true;
}

export type ParseEventResult =
  | { ok: true; event: GameEvent }
  | { ok: false; error: string };

/**
 * Turn one WebSocket text frame into a typed event.
 *
 * Only a malformed *envelope* is a failure. A bad `data` payload downgrades the
 * event to `UnknownEvent` with `schemaError` set, because losing the fact that
 * the packet arrived is worse than losing its fields.
 */
export function parseEventFrame(text: string): ParseEventResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `frame is not JSON: ${String(e)}` };
  }
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, error: `frame envelope invalid: ${envelope.error.message}` };
  }
  const { seq, opcode, opcodeId, ts, data } = envelope.data;

  if (isDecodeError(data)) {
    return {
      ok: true,
      event: { seq, opcode, opcodeId, ts, data: { decodeError: true } } as GameEvent,
    };
  }
  if (!isKnownOpcode(opcode)) {
    return { ok: true, event: { seq, opcode, opcodeId, ts, data } };
  }
  const decoded = eventDataSchemas[opcode].safeParse(data);
  if (!decoded.success) {
    return {
      ok: true,
      event: { seq, opcode, opcodeId, ts, data, schemaError: decoded.error.message },
    };
  }
  return {
    ok: true,
    event: { seq, opcode, opcodeId, ts, data: decoded.data } as GameEvent,
  };
}
