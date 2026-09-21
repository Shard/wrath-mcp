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

import { guidSchema, parseGuid } from "./guid";
import {
  buyBankSlotResultDataSchema,
  groupInviteDataSchema,
  groupListDataSchema,
  groupNameDataSchema,
  inventoryChangeFailureDataSchema,
  itemQueryResponseDataSchema,
  itemTextQueryResponseDataSchema,
  lootAllPassedDataSchema,
  lootMasterListDataSchema,
  lootRollDataSchema,
  lootRollWonDataSchema,
  lootStartRollDataSchema,
  mailListResultDataSchema,
  pageTextQueryResponseDataSchema,
  partyCommandResultDataSchema,
  petActionFeedbackDataSchema,
  petCastFailedDataSchema,
  petNameInvalidDataSchema,
  petNameQueryResponseDataSchema,
  petSpellsDataSchema,
  petTameFailureDataSchema,
  readItemDataSchema,
  sendMailResultDataSchema,
  showFrameDataSchema,
  tradeStatusDataSchema,
  tradeStatusExtendedDataSchema,
} from "./protocol-social";

// Re-exported so `./protocol` still names every symbol it used to. `./guid`
// holds the guid primitives both halves need; `./protocol-social` holds the
// pets / group / mail / bank / trade / loot-roll / item-text schemas.
export * from "./guid";
export * from "./protocol-social";

// ---------------------------------------------------------------- primitives

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

/**
 * POST /lease (PROTOCOL.md, "Authentication"). Operator only: binds the token
 * to an account and issues the session secret the runner hands the snippet
 * child. `character` is present once a create under this token has bound one.
 */
export const leaseResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
  account: z.string(),
  secret: z.string().min(32),
  character: z.string().optional(),
});
export type LeaseResponse = z.infer<typeof leaseResponseSchema>;

/** DELETE /lease */
export const releaseLeaseResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
  released: z.boolean(),
});
export type ReleaseLeaseResponse = z.infer<typeof releaseLeaseResponseSchema>;

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
  | { token: string; action: "move_to"; x: number; y: number; z: number; guid?: string }
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
  | { token: string; action: "quest_query"; questId: number }
  | { token: string; action: "questgiver_status_query"; guid: string }
  | { token: string; action: "questgiver_status_multiple_query" }
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
  // trainer extension
  | { token: string; action: "trainer_list"; guid: string }
  | { token: string; action: "trainer_buy_spell"; guid: string; spellId: number }
  | { token: string; action: "repop" }
  | { token: string; action: "reclaim_corpse"; guid?: string }
  | { token: string; action: "spirit_healer_activate"; guid: string }
  // spellbook/talent extension
  | { token: string; action: "learn_talent"; talentId: number; rank: number }
  | { token: string; action: "learn_preview_talents"; talents: readonly (readonly [number, number])[] }
  /** A client-local read: the class talent tree, answered as `WB_TALENT_TREE` (no packet sent). */
  | { token: string; action: "talent_tree" }
  /** The escape hatch: an allowlisted client opcode by name and its body as hex. */
  | { token: string; action: "raw"; opcode: string; payload: string };

// ------------------------------------------------------------ raw payloads

/**
 * One field of a raw-action payload (module/PROTOCOL.md "raw"). Integers are little-endian,
 * as on the 3.3.5a wire; `guid` is a plain u64 (given as the decimal string
 * every guid already is), `packedGuid` the client's compressed form, `cstring`
 * a NUL-terminated UTF-8 string, `bytes` pre-built hex.
 */
export const rawFieldSchema = z.union([
  z.strictObject({ u8: z.number().int().min(0).max(0xff) }),
  z.strictObject({ u16: z.number().int().min(0).max(0xffff) }),
  z.strictObject({ u32: z.number().int().min(0).max(0xffffffff) }),
  z.strictObject({ i32: z.number().int().min(-0x80000000).max(0x7fffffff) }),
  z.strictObject({ f32: z.number() }),
  z.strictObject({ u64: z.string().regex(/^\d+$/) }),
  z.strictObject({ guid: guidSchema }),
  z.strictObject({ packedGuid: guidSchema }),
  z.strictObject({ cstring: z.string() }),
  z.strictObject({ bytes: z.string().regex(/^([0-9a-fA-F]{2})*$/) }),
]);
export type RawField = z.input<typeof rawFieldSchema>;

/**
 * What `client.raw(opcode, payload)` accepts: a hex string, raw bytes, or a
 * list of typed fields the SDK packs. Validated here because the bytes go
 * straight into a server handler — a malformed payload must be rejected with
 * a reason, never sent and silently mis-parsed.
 */
export const rawPayloadSchema = z.union([
  z.string().regex(/^([0-9a-fA-F]{2})*$/, "hex string of whole bytes"),
  z.instanceof(Uint8Array),
  z.array(rawFieldSchema),
]);
export type RawPayload = z.input<typeof rawPayloadSchema>;

/** The opcode names the module's allowlist uses; the module is the authority on membership. */
/** `CMSG_*`, or a bidirectional `MSG_*` a client also sends (`MSG_TALENT_WIPE_CONFIRM`). */
export const rawOpcodeSchema = z.string().regex(/^C?MSG_[A-Z0-9_]+$/, "a CMSG_* (or MSG_*) opcode name");

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function le(value: bigint, width: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < width; ++i) out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** Pack an already-validated payload into the hex string the module takes. */
export function encodeRawPayload(payload: z.output<typeof rawPayloadSchema>): string {
  if (typeof payload === "string") return payload.toLowerCase();
  if (payload instanceof Uint8Array) return hex(payload);
  const bytes: number[] = [];
  for (const f of payload) {
    if ("u8" in f) bytes.push(f.u8);
    else if ("u16" in f) bytes.push(...le(BigInt(f.u16), 2));
    else if ("u32" in f) bytes.push(...le(BigInt(f.u32), 4));
    else if ("i32" in f) bytes.push(...le(BigInt(f.i32 >>> 0), 4));
    else if ("f32" in f) {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, f.f32, true);
      bytes.push(...new Uint8Array(dv.buffer));
    } else if ("u64" in f) bytes.push(...le(BigInt(f.u64), 8));
    else if ("guid" in f) bytes.push(...le(parseGuid(f.guid), 8));
    else if ("packedGuid" in f) {
      const g = parseGuid(f.packedGuid);
      let mask = 0;
      const tail: number[] = [];
      for (let i = 0; i < 8; ++i) {
        const b = Number((g >> BigInt(8 * i)) & 0xffn);
        if (b !== 0) {
          mask |= 1 << i;
          tail.push(b);
        }
      }
      bytes.push(mask, ...tail);
    } else if ("cstring" in f) bytes.push(...new TextEncoder().encode(f.cstring), 0);
    else if ("bytes" in f) bytes.push(...Uint8Array.from(Buffer.from(f.bytes, "hex")));
  }
  return hex(Uint8Array.from(bytes));
}

/**
 * POST /character-delete body. Not session-scoped: the module stands up its own
 * parked session for the delete (module/PROTOCOL.md), so `token` is a throwaway for this
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
  zoneId: z.number().optional(),
  zoneName: z.string().optional(),
  areaId: z.number().optional(),
  areaName: z.string().optional(),
});
export type SessionStateData = z.infer<typeof sessionStateDataSchema>;

/**
 * Synthetic module event: the zone/subzone the character is in, on login and
 * on every change. Ids are the pair the server derives from the same terrain
 * data a client computes its own from; names are the client's AreaTable.dbc.
 */
export const areaDataSchema = z.looseObject({
  mapId: z.number(),
  zoneId: z.number(),
  zoneName: z.string(),
  areaId: z.number(),
  areaName: z.string(),
});
export type AreaData = z.infer<typeof areaDataSchema>;

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
  /**
   * `UNIT_FLAG_TAXI_FLIGHT` read off `unitFlags` by the module and named
   * (PROTOCOL.md). Served alongside `unitFlags`, never instead of it;
   * the state cache derives `self.taxiFlight` from the bit itself, so this is
   * here for the schema to be a full account of what the module sends.
   */
  taxiFlight: z.boolean().optional(),
  displayId: z.number().optional(),
  dynamicFlags: z.number().optional(),
  npcFlags: z.number().optional(),
  targetGuid: guidSchema.optional(),
  /**
   * Who a unit belongs to: a pet's master is `summonedByGuid` /
   * `createdByGuid`, a mind-controlled unit's is `charmedByGuid`; `petNumber`
   * is the number a client keys the pet's name query on (0 on non-pets).
   */
  summonedByGuid: guidSchema.optional(),
  createdByGuid: guidSchema.optional(),
  charmedByGuid: guidSchema.optional(),
  petNumber: z.number().optional(),
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
  /** Transports only: ms into the `TransportAnimation.dbc` period when the block was built. */
  pathProgress: z.number().optional(),
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

/**
 * The answer to the `CMSG_GAMEOBJECT_QUERY` the module fires on first sight of
 * a game object entry, exactly as it does for creatures. `type` is the core's
 * `GameobjectTypes` value; `found: false` carries the entry and nothing else.
 */
export const gameObjectQueryResponseDataSchema = z.looseObject({
  entry: z.number(),
  found: z.boolean(),
  name: z.string().optional(),
  type: z.number().optional(),
  displayId: z.number().optional(),
  castBarCaption: z.string().optional(),
});
export type GameObjectQueryResponseData = z.infer<typeof gameObjectQueryResponseDataSchema>;

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
  // The one entry about self: the server's side of a same-map teleport
  // (Hearthstone, graveyard port). `guid` is our own, `pos` the arrival point.
  "MSG_MOVE_TELEPORT_ACK",
  "MSG_MOVE",
] as const;
export type MoveOpcode = (typeof MOVE_OPCODES)[number];

/**
 * Terminal statuses of a `move_to`, from PROTOCOL.md. The former
 * undifferentiated `no_path` is gone.
 */
export const MOVE_STATUSES = [
  "arrived",
  "too_far",
  "no_mesh",
  "target_off_mesh",
  "start_off_mesh",
  "path_incomplete",
  "drop",
  "transferred",
  "teleported",
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
  /** `arrived` only: the ground z the mesh walked to when the request's z was off by >1y. */
  meshZ: z.number().optional(),
  /** `path_incomplete`: how far the mesh could get toward the request; `drop`: the ledge edge. */
  reachedPos: z.looseObject({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  /** `drop` only: the signed vertical step the route would have taken past `reachedPos`. */
  dz: z.number().optional(),
  /** `drop` only: the requested point, echoed. */
  target: z.looseObject({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  /** Present when the character ended the move aboard a transport the server is carrying it on. */
  onTransport: z.looseObject({ guid: guidSchema, entry: z.number() }).optional(),
});
export type MoveResultData = z.infer<typeof moveResultDataSchema>;

/**
 * Module-synthesized: own position while riding a transport and not walking.
 * The server tells a client nothing here (the client animates the transport
 * itself), so this is the riding counterpart of `WB_MOVE_PROGRESS`.
 */
export const rideProgressDataSchema = z.looseObject({
  transportGuid: guidSchema,
  transportEntry: z.number(),
  pos: positionSchema,
});
export type RideProgressData = z.infer<typeof rideProgressDataSchema>;

/**
 * Module-synthesized: where a transport the session has been sent (a tram
 * car, a boat) is right now, at most once a second. A client animates the car
 * itself from `TransportAnimation.dbc` and the clock its create block carried;
 * the module reports the same animation's result. `docked` is whether the
 * keyframe segment the clock is on has no displacement — the car is dwelling
 * at a platform; absent for transports without an animation path.
 */
export const transportProgressDataSchema = z.looseObject({
  guid: guidSchema,
  entry: z.number(),
  pos: positionSchema,
  progressMs: z.number(),
  periodMs: z.number().optional(),
  docked: z.boolean().optional(),
});
export type TransportProgressData = z.infer<typeof transportProgressDataSchema>;

// ---------------------------------------------------------- map transfers
//
// Navigation. `SMSG_NEW_WORLD` is the only map id a client
// receives after login, so state.ts keys self position's `map` on it.

export const transferPendingDataSchema = z.looseObject({
  map: z.number(),
  transportEntry: z.number().optional(),
  oldMap: z.number().optional(),
});
export type TransferPendingData = z.infer<typeof transferPendingDataSchema>;

export const newWorldDataSchema = z.looseObject({
  map: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  o: z.number(),
});
export type NewWorldData = z.infer<typeof newWorldDataSchema>;

export const transferAbortedDataSchema = z.looseObject({
  map: z.number(),
  reason: z.number(),
  arg: z.number().optional(),
});
export type TransferAbortedData = z.infer<typeof transferAbortedDataSchema>;

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

/**
 * `SMSG_QUESTGIVER_STATUS_MULTIPLE`: the marker for every questgiver in view,
 * sent on login/level-up/quest reward and in answer to
 * `questgiver_status_multiple_query`. Same `status` domain as the single form.
 */
export const questGiverStatusMultipleDataSchema = z.looseObject({
  statuses: z.array(questGiverStatusDataSchema),
});
export type QuestGiverStatusMultipleData = z.infer<typeof questGiverStatusMultipleDataSchema>;

/**
 * `SMSG_QUEST_QUERY_RESPONSE`: the quest template the client's log renders
 * from. `requiredNpcOrGo[i].entry` is a creature entry, or a gameobject entry
 * with bit 31 set (the client's own convention); a zero entry with a non-empty
 * `text` is an event/exploration objective.
 */
export const questQueryResponseDataSchema = z.looseObject({
  questId: z.number(),
  method: z.number().optional(),
  level: z.number().optional(),
  minLevel: z.number().optional(),
  type: z.number().optional(),
  suggestedPlayers: z.number().optional(),
  title: z.string(),
  objectives: z.string().optional(),
  details: z.string().optional(),
  areaDescription: z.string().optional(),
  completedText: z.string().optional(),
  requiredNpcOrGo: z.array(z.looseObject({ entry: z.number(), count: z.number(), text: z.string().optional() })),
  requiredItems: z.array(z.looseObject({ itemId: z.number(), count: z.number() })),
});
export type QuestQueryResponseData = z.infer<typeof questQueryResponseDataSchema>;

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

/**
 * One row of a trainer's spell list. `cost` is copper, already discounted by
 * the server for reputation; `reqSkill` is a skill-line id (0 = none).
 * `state` is the availability the server computed — see
 * `TRAINER_SPELL_STATE` in client.ts for the mapping, and note that it says
 * nothing about affordability.
 */
export const trainerSpellSchema = z.looseObject({
  spellId: z.number(),
  state: z.number(),
  cost: z.number(),
  reqLevel: z.number(),
  reqSkill: z.number(),
  reqSkillValue: z.number(),
});
export type TrainerSpellData = z.infer<typeof trainerSpellSchema>;

/** `trainerType` 0 class, 1 mount, 2 tradeskill, 3 pet. */
export const trainerListDataSchema = z.looseObject({
  guid: guidSchema,
  trainerType: z.number(),
  spells: z.array(trainerSpellSchema),
  greeting: z.string().optional(),
});
export type TrainerListData = z.infer<typeof trainerListDataSchema>;

export const trainerBuySucceededDataSchema = z.looseObject({
  guid: guidSchema,
  spellId: z.number(),
});
export type TrainerBuySucceededData = z.infer<typeof trainerBuySucceededDataSchema>;

/** `reason` is a `Trainer::FailReason`; `TRAINER_BUY_FAIL_HINTS` renders it. */
export const trainerBuyFailedDataSchema = z.looseObject({
  guid: guidSchema,
  spellId: z.number(),
  reason: z.number(),
});
export type TrainerBuyFailedData = z.infer<typeof trainerBuyFailedDataSchema>;

/**
 * One spellbook row. `rank` and `name` are what a client reads from its own
 * Spell.dbc for the id (1 / absent for an unranked or unknown spell); the
 * module serves them the way it serves item-template fields.
 */
export const knownSpellSchema = z.looseObject({
  spellId: z.number(),
  rank: z.number().optional(),
  name: z.string().optional(),
});
export type KnownSpellData = z.infer<typeof knownSpellSchema>;

/**
 * One login-time cooldown row from `SMSG_INITIAL_SPELLS`. A spell with a
 * category cooldown carries it in `categoryCooldownMs` and 0 in `cooldownMs`.
 */
export const initialCooldownSchema = z.looseObject({
  spellId: z.number(),
  itemId: z.number(),
  category: z.number(),
  cooldownMs: z.number(),
  categoryCooldownMs: z.number(),
});

/** `SMSG_INITIAL_SPELLS`: the whole spellbook (active spec) plus running cooldowns, at login. */
export const initialSpellsDataSchema = z.looseObject({
  spells: z.array(knownSpellSchema),
  cooldowns: z.array(initialCooldownSchema),
});
export type InitialSpellsData = z.infer<typeof initialSpellsDataSchema>;

export const learnedSpellDataSchema = knownSpellSchema;
export type LearnedSpellData = z.infer<typeof learnedSpellDataSchema>;

export const removedSpellDataSchema = z.looseObject({ spellId: z.number() });
export type RemovedSpellData = z.infer<typeof removedSpellDataSchema>;

/** `SMSG_SUPERCEDED_SPELL`: `supersededSpellId` leaves the book, `spellId` replaces it. */
export const supersededSpellDataSchema = z.looseObject({
  supersededSpellId: z.number(),
  spellId: z.number(),
  rank: z.number().optional(),
  name: z.string().optional(),
});
export type SupersededSpellData = z.infer<typeof supersededSpellDataSchema>;

/** `SMSG_SPELL_COOLDOWN`: cooldowns that just started; `flags & 1` means the GCD was included. */
export const spellCooldownDataSchema = z.looseObject({
  guid: guidSchema,
  flags: z.number(),
  cooldowns: z.array(z.looseObject({ spellId: z.number(), cooldownMs: z.number() })),
});
export type SpellCooldownData = z.infer<typeof spellCooldownDataSchema>;

/** `SMSG_COOLDOWN_EVENT` / `SMSG_CLEAR_COOLDOWN`: one spell's cooldown started or was cleared. */
export const cooldownEventDataSchema = z.looseObject({
  spellId: z.number(),
  guid: guidSchema,
});
export type CooldownEventData = z.infer<typeof cooldownEventDataSchema>;

export const talentRowSchema = z.looseObject({
  talentId: z.number(),
  /** 0-based: rank 0 is the first point. */
  rank: z.number(),
});

/**
 * `SMSG_TALENTS_INFO` for the player. The pet form arrives as `{ pet: true }`
 * with nothing else (the pet bar itself is `SMSG_PET_SPELLS`).
 */
export const talentsInfoDataSchema = z.looseObject({
  pet: z.boolean(),
  unspentPoints: z.number().optional(),
  specCount: z.number().optional(),
  activeSpec: z.number().optional(),
  specs: z.array(z.looseObject({ talents: z.array(talentRowSchema) })).optional(),
});
export type TalentsInfoData = z.infer<typeof talentsInfoDataSchema>;

/**
 * One achievement as the module serves it (issue #8): the id and the
 * wire's packed time, plus `name`/`points`/`categoryId` when the module could
 * read `Achievement.dbc` — client-cache knowledge, the same class as item and
 * spell names. Absent DBC means ids only, never a guessed name.
 */
export const achievementSchema = z.looseObject({
  achievementId: z.number(),
  /** The wire's packed bitfield (`AppendPackedTime`). */
  date: z.number(),
  /** The module's reading of `date`, `YYYY-MM-DD HH:MM`. */
  time: z.string().optional(),
  name: z.string().optional(),
  points: z.number().optional(),
  categoryId: z.number().optional(),
});
export type Achievement = z.infer<typeof achievementSchema>;

/**
 * `SMSG_ACHIEVEMENT_EARNED`. The core broadcasts this in **say range**, so the
 * event routinely describes another player: `self` is the equality with our own
 * guid and is the only thing that makes it ours. Never key on the opcode alone.
 */
export const achievementEarnedDataSchema = z.looseObject({
  guid: guidSchema,
  self: z.boolean(),
  achievement: achievementSchema,
});
export type AchievementEarnedData = z.infer<typeof achievementEarnedDataSchema>;

/**
 * `SMSG_ALL_ACHIEVEMENT_DATA`: everything already earned, sent to self once
 * during login. Only the completed block is decoded (the criteria-progress
 * block is consumed unserved), so `count` is the completed count.
 */
export const allAchievementDataSchema = z.looseObject({
  count: z.number(),
  achievements: z.array(achievementSchema),
});
export type AllAchievementData = z.infer<typeof allAchievementDataSchema>;

/**
 * `SMSG_ACTIVATETAXIREPLY`: the server's answer to `CMSG_ACTIVATETAXI`
 * (`activateTaxi`, or raw). `reply` is `ActivateTaxiReply`
 * (0 ok, 1 server error, 2 no such path, 3 not enough money, 4 too far away,
 * 5 no vendor nearby, 6 not visited, 7 busy, 8 mounted, 9 shapeshifted,
 * 10 moving, 11 same node, 12 not standing); `ok` is `reply === 0`. The flight
 * itself has no event — it is `taxiFlight` on self.
 */
export const activateTaxiReplyDataSchema = z.looseObject({
  reply: z.number(),
  ok: z.boolean(),
});
export type ActivateTaxiReplyData = z.infer<typeof activateTaxiReplyDataSchema>;

/**
 * One node of a flight master's window: the id the wire carries (a bit of
 * the taximask) and the name a client reads for it from its own
 * `TaxiNodes.dbc` — client-cache knowledge, the same class as area names.
 * `name` is absent when the module's copy of the table lacks the id.
 */
export const taxiNodeSchema = z.looseObject({
  nodeId: z.number(),
  name: z.string().optional(),
});
export type TaxiNode = z.infer<typeof taxiNodeSchema>;

/**
 * `SMSG_SHOWTAXINODES`: the flight master's window, exactly as a client gets
 * it when the taxi gossip option is chosen — `showWindow` (the leading u32),
 * the flight master's `guid`, the node the master stands at (`currentNode`),
 * and the character's taximask (`mask`, 14 u32 words as on the wire) decoded
 * into `known`, the nodes this character has visited. Nothing about routes
 * or fares: the client learns those by asking to fly (`activateTaxi`).
 */
export const showTaxiNodesDataSchema = z.looseObject({
  showWindow: z.boolean(),
  guid: guidSchema,
  currentNode: z.number(),
  currentNodeName: z.string().optional(),
  mask: z.array(z.number()),
  known: z.array(taxiNodeSchema),
});
export type ShowTaxiNodesData = z.infer<typeof showTaxiNodesDataSchema>;

/**
 * `SMSG_BINDER_CONFIRM`: the innkeeper (`guid`) asks "make this your home?"
 * after the bind gossip option. A client answers yes with
 * `CMSG_BINDER_ACTIVATE` (`bindAtInnkeeper` does; raw otherwise).
 */
export const binderConfirmDataSchema = z.looseObject({
  guid: guidSchema,
});
export type BinderConfirmData = z.infer<typeof binderConfirmDataSchema>;

/**
 * `SMSG_BINDPOINTUPDATE`: where the hearthstone goes — once at login and
 * again after every bind. `areaName` is the client's `AreaTable.dbc` text for
 * `areaId` (`""` when the table has no row).
 */
export const bindPointUpdateDataSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  map: z.number(),
  areaId: z.number(),
  areaName: z.string(),
});
export type BindPointUpdateData = z.infer<typeof bindPointUpdateDataSchema>;

/** `SMSG_PLAYERBOUND`: the "your home is now …" line after a bind; `guid` is the binder. */
export const playerBoundDataSchema = z.looseObject({
  guid: guidSchema,
  areaId: z.number(),
  areaName: z.string(),
});
export type PlayerBoundData = z.infer<typeof playerBoundDataSchema>;

/**
 * One faction row as the module serves it: the wire's reputation
 * index (`repListId`) and standing, joined to the client's `Faction.dbc`
 * (`factionId`, `name`) and the race/class base the client adds (`base`);
 * `reputation` is `base + standing`, the number the reputation pane shows.
 * `flags`/`visible`/`atWar` only ride the login packet.
 */
export const factionRowSchema = z.looseObject({
  repListId: z.number(),
  factionId: z.number().optional(),
  name: z.string().optional(),
  standing: z.number(),
  base: z.number().optional(),
  reputation: z.number().optional(),
  flags: z.number().optional(),
  visible: z.boolean().optional(),
  atWar: z.boolean().optional(),
});
export type FactionRow = z.infer<typeof factionRowSchema>;

/** `SMSG_INITIALIZE_FACTIONS`: the login reputation list (rows with a flag or a standing only). */
export const initializeFactionsDataSchema = z.looseObject({
  count: z.number(),
  factions: z.array(factionRowSchema),
});
export type InitializeFactionsData = z.infer<typeof initializeFactionsDataSchema>;

/** `SMSG_SET_FACTION_STANDING`: every faction whose standing changed; `showVisual` is the "reputation with X increased" line. */
export const setFactionStandingDataSchema = z.looseObject({
  showVisual: z.boolean(),
  factions: z.array(factionRowSchema),
});
export type SetFactionStandingData = z.infer<typeof setFactionStandingDataSchema>;

/** `SMSG_SET_FACTION_VISIBLE`: a faction appears in the reputation pane from now on. */
export const setFactionVisibleDataSchema = z.looseObject({
  repListId: z.number(),
  factionId: z.number().optional(),
  name: z.string().optional(),
});
export type SetFactionVisibleData = z.infer<typeof setFactionVisibleDataSchema>;

/**
 * `MSG_TALENT_WIPE_CONFIRM` from the server: the trainer (`guid`) asks
 * "unlearn all talents for `cost` copper?" after its unlearn gossip option.
 * A client answers yes by echoing the opcode with the guid (`resetTalents`
 * does; raw otherwise). `nothingToReset` is the refusal form (guid 0, cost
 * 0) the handler sends when there are no talents to reset or the money is
 * short.
 */
export const talentWipeConfirmDataSchema = z.looseObject({
  guid: guidSchema,
  cost: z.number(),
  nothingToReset: z.boolean(),
});
export type TalentWipeConfirmData = z.infer<typeof talentWipeConfirmDataSchema>;

/** One talent of the class tree as the talent frame draws it; `ranks` are the rank spells, `name` the first rank's Spell.dbc name. */
export const talentTreeTalentSchema = z.looseObject({
  talentId: z.number(),
  name: z.string().optional(),
  row: z.number(),
  col: z.number(),
  maxRank: z.number(),
  ranks: z.array(z.number()),
  dependsOn: z.number().optional(),
  dependsOnRank: z.number().optional(),
});
export type TalentTreeTalentData = z.infer<typeof talentTreeTalentSchema>;

/**
 * `WB_TALENT_TREE` (the answer to the `talent_tree` action): the character's
 * class talent tabs as the client reads them from its own Talent.dbc and
 * TalentTab.dbc — static; which ranks are learned is `SMSG_TALENTS_INFO`'s.
 */
export const talentTreeDataSchema = z.looseObject({
  class: z.number(),
  unspentPoints: z.number(),
  tabs: z.array(
    z.looseObject({
      tabId: z.number(),
      name: z.string().optional(),
      page: z.number(),
      talents: z.array(talentTreeTalentSchema),
    }),
  ),
});
export type TalentTreeData = z.infer<typeof talentTreeDataSchema>;

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

/**
 * The server's answer to the ghost's `MSG_CORPSE_QUERY` (the module asks once
 * per death on the client's behalf; PROTOCOL.md "Death"). Position fields only
 * when `found`; `map`/x/y/z is where a client draws the corpse marker and
 * `corpseMap` the map the corpse is on — they differ only for a corpse inside
 * a dungeon, where the marker sits on the entrance.
 */
export const corpseQueryDataSchema = z.looseObject({
  found: z.boolean(),
  map: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  corpseMap: z.number().optional(),
});
export type CorpseQueryData = z.infer<typeof corpseQueryDataSchema>;

export const charDeleteDataSchema = z.looseObject({ result: z.number() });
export type CharDeleteData = z.infer<typeof charDeleteDataSchema>;

/**
 * A creature's movement, reduced to what a player perceives: where it is, where
 * it is heading, and how long it will take. The spline points are consumed by
 * the module and never served (module/PROTOCOL.md). A stopped creature sends
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
  SMSG_GAMEOBJECT_QUERY_RESPONSE: gameObjectQueryResponseDataSchema,
  WB_MOVE_PROGRESS: moveProgressDataSchema,
  WB_SESSION_STATE: sessionStateDataSchema,
  WB_AREA: areaDataSchema,
  WB_MOVE_RESULT: moveResultDataSchema,
  WB_RIDE_PROGRESS: rideProgressDataSchema,
  WB_TRANSPORT_PROGRESS: transportProgressDataSchema,
  ...moveOpcodeSchemas,
  // map transfers
  SMSG_TRANSFER_PENDING: transferPendingDataSchema,
  SMSG_NEW_WORLD: newWorldDataSchema,
  SMSG_TRANSFER_ABORTED: transferAbortedDataSchema,
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
  SMSG_QUESTGIVER_STATUS_MULTIPLE: questGiverStatusMultipleDataSchema,
  SMSG_QUEST_QUERY_RESPONSE: questQueryResponseDataSchema,
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
  // group loot rolls
  SMSG_LOOT_START_ROLL: lootStartRollDataSchema,
  SMSG_LOOT_ROLL: lootRollDataSchema,
  SMSG_LOOT_ROLL_WON: lootRollWonDataSchema,
  SMSG_LOOT_ALL_PASSED: lootAllPassedDataSchema,
  SMSG_LOOT_MASTER_LIST: lootMasterListDataSchema,
  // item text
  SMSG_READ_ITEM_OK: readItemDataSchema,
  SMSG_READ_ITEM_FAILED: readItemDataSchema,
  SMSG_PAGE_TEXT_QUERY_RESPONSE: pageTextQueryResponseDataSchema,
  SMSG_ITEM_TEXT_QUERY_RESPONSE: itemTextQueryResponseDataSchema,
  SMSG_LIST_INVENTORY: listInventoryDataSchema,
  SMSG_BUY_ITEM: buyItemDataSchema,
  SMSG_BUY_FAILED: buyFailedDataSchema,
  SMSG_SELL_ITEM: sellItemDataSchema,
  // trainers
  SMSG_TRAINER_LIST: trainerListDataSchema,
  SMSG_TRAINER_BUY_SUCCEEDED: trainerBuySucceededDataSchema,
  SMSG_TRAINER_BUY_FAILED: trainerBuyFailedDataSchema,
  SMSG_INVENTORY_CHANGE_FAILURE: inventoryChangeFailureDataSchema,
  SMSG_ITEM_QUERY_SINGLE_RESPONSE: itemQueryResponseDataSchema,
  // spellbook, cooldowns, talents
  SMSG_INITIAL_SPELLS: initialSpellsDataSchema,
  SMSG_LEARNED_SPELL: learnedSpellDataSchema,
  SMSG_REMOVED_SPELL: removedSpellDataSchema,
  SMSG_SUPERCEDED_SPELL: supersededSpellDataSchema,
  SMSG_SPELL_COOLDOWN: spellCooldownDataSchema,
  SMSG_COOLDOWN_EVENT: cooldownEventDataSchema,
  SMSG_CLEAR_COOLDOWN: cooldownEventDataSchema,
  SMSG_TALENTS_INFO: talentsInfoDataSchema,
  MSG_TALENT_WIPE_CONFIRM: talentWipeConfirmDataSchema,
  WB_TALENT_TREE: talentTreeDataSchema,
  // reputation
  SMSG_INITIALIZE_FACTIONS: initializeFactionsDataSchema,
  SMSG_SET_FACTION_STANDING: setFactionStandingDataSchema,
  SMSG_SET_FACTION_VISIBLE: setFactionVisibleDataSchema,
  // pets
  SMSG_PET_SPELLS: petSpellsDataSchema,
  SMSG_PET_ACTION_FEEDBACK: petActionFeedbackDataSchema,
  SMSG_PET_TAME_FAILURE: petTameFailureDataSchema,
  SMSG_PET_CAST_FAILED: petCastFailedDataSchema,
  SMSG_PET_NAME_QUERY_RESPONSE: petNameQueryResponseDataSchema,
  SMSG_PET_NAME_INVALID: petNameInvalidDataSchema,
  // group, mail, bank, trade
  SMSG_GROUP_INVITE: groupInviteDataSchema,
  SMSG_GROUP_DECLINE: groupNameDataSchema,
  SMSG_GROUP_SET_LEADER: groupNameDataSchema,
  SMSG_GROUP_UNINVITE: emptyDataSchema,
  SMSG_GROUP_DESTROYED: emptyDataSchema,
  SMSG_PARTY_COMMAND_RESULT: partyCommandResultDataSchema,
  SMSG_GROUP_LIST: groupListDataSchema,
  SMSG_SHOW_MAILBOX: showFrameDataSchema,
  SMSG_RECEIVED_MAIL: emptyDataSchema,
  SMSG_SEND_MAIL_RESULT: sendMailResultDataSchema,
  SMSG_MAIL_LIST_RESULT: mailListResultDataSchema,
  SMSG_SHOW_BANK: showFrameDataSchema,
  SMSG_BUY_BANK_SLOT_RESULT: buyBankSlotResultDataSchema,
  SMSG_TRADE_STATUS: tradeStatusDataSchema,
  SMSG_TRADE_STATUS_EXTENDED: tradeStatusExtendedDataSchema,
  // achievements and flight paths
  SMSG_ACHIEVEMENT_EARNED: achievementEarnedDataSchema,
  SMSG_ALL_ACHIEVEMENT_DATA: allAchievementDataSchema,
  SMSG_ACTIVATETAXIREPLY: activateTaxiReplyDataSchema,
  SMSG_SHOWTAXINODES: showTaxiNodesDataSchema,
  // innkeeper bind
  SMSG_BINDER_CONFIRM: binderConfirmDataSchema,
  SMSG_BINDPOINTUPDATE: bindPointUpdateDataSchema,
  SMSG_PLAYERBOUND: playerBoundDataSchema,
  // death
  SMSG_DEATH_RELEASE_LOC: deathReleaseLocDataSchema,
  SMSG_CORPSE_RECLAIM_DELAY: corpseReclaimDelayDataSchema,
  SMSG_DURABILITY_DAMAGE_DEATH: emptyDataSchema,
  MSG_CORPSE_QUERY: corpseQueryDataSchema,
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
