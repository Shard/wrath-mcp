/**
 * The state cache: a pure fold over the event stream.
 *
 * Two rules, both from docs/CONTRACTS.md, and both load-bearing:
 *
 *  1. **Nothing is invented.** A field exists on the cache only if an event
 *     carried it. Nothing that no whitelisted opcode carries gets a default —
 *     `health` is `undefined`, not `0`, and `nearby` is empty rather than
 *     guessed from chat senders. A model reading `undefined` knows it has not
 *     observed the thing; a model reading `0` believes something false.
 *  2. **Replayable.** `StateCache.replay(events, seed)` over the same events
 *     produces the same cache as feeding them live. That is what makes the
 *     trajectory log sufficient to reconstruct what the model could see.
 *
 * Every observed field group carries the `seq`/`ts` it came from, so staleness
 * is legible — which matters most for position: our own is written by the login
 * verify, then by our create block, then by every `WB_MOVE_PROGRESS` while we
 * walk, and a reader can always see which.
 *
 * ### The update-object fold
 *
 * `SMSG_UPDATE_OBJECT` is already delta-shaped on the wire (full object on
 * first sight, sparse field deltas after), and the fold preserves that rather
 * than flattening it: `create` populates a `NearbyObject`, `values` merges
 * field by field with each field keeping the seq/ts of the block that carried
 * it, `outOfRange` and `SMSG_DESTROY_OBJECT` prune. Everything writes through
 * one seam, `upsertNearby`.
 *
 * The typed groups (`health`, `power`, `level`) are *derived* from the raw
 * `fields` record and only when the derivation is complete — see
 * `deriveGauges`. Name resolution is a join, not an observation: query answers
 * land in `names`/`creatures` and are attached to whatever is in view.
 */

import {
  formatGuid,
  isDecodeError,
  isLootError,
  isMoveOpcode,
  type AuraData,
  type AuraUpdateData,
  type CreateBlock,
  type GameObjectQueryResponseData,
  type GuidKey,
  type CooldownEventData,
  type InitialSpellsData,
  type ItemQueryResponseData,
  type ListInventoryData,
  type LootItemData,
  type LootResponseData,
  type LootRemovedData,
  type LootReleaseResponseData,
  type LootStartRollData,
  type LootRollData,
  type LootRollWonData,
  type LootAllPassedData,
  type PageTextQueryResponseData,
  type ItemTextQueryResponseData,
  type TrainerListData,
  type TrainerSpellData,
  type VendorItem,
  type InitializeFactionsData,
  type ItemDamage,
  type ItemSpell,
  type ItemStat,
  type SetFactionStandingData,
  type SetFactionVisibleData,
  type TalentTreeData,
  type GroupInviteData,
  type GroupListData,
  type GroupMemberData,
  type GroupNameData,
  type MailEntryData,
  type MailListResultData,
  type PartyCommandResultData,
  type PartyMemberStatsData,
  type PetActionBarButton,
  type PetNameQueryResponseData,
  type PetSpell,
  type PetSpellsData,
  type SendMailResultData,
  type ShowFrameData,
  type TradeStatusData,
  type TradeStatusExtendedData,
  type LearnedSpellData,
  type ClientControlUpdateData,
  type MonsterMoveData,
  type MonsterMoveTransportData,
  type RemovedSpellData,
  type SpellCooldownData,
  type SpellFailureData,
  type SpellGoData,
  type SpellStartData,
  type UpdateComboPointsData,
  type ConvertRuneData,
  type ChannelStartData,
  type ChannelUpdateData,
  type TotemCreatedData,
  type StartMirrorTimerData,
  type StopMirrorTimerData,
  type SpellDelayedData,
  type SetProficiencyData,
  type SupersededSpellData,
  type TalentsInfoData,
  type AchievementEarnedData,
  type AllAchievementData,
  type ActivateTaxiReplyData,
  type BindPointUpdateData,
  type ShowTaxiNodesData,
  type TransportProgressData,
  type QuestGiverStatusData,
  type QuestGiverStatusMultipleData,
  type QuestQueryResponseData,
  type QuestPoi,
  type QuestPoiQueryResponseData,
  type MoveUpdateData,
  type PositionData,
  type ResurrectRequestData,
  type UpdateBlock,
  type UpdateFields,
} from "./protocol";

// The social half of the cache — pets, group, mail, bank, trade, loot rolls,
// item text — lives in `./state-social`, on the same seam that splits
// `protocol.ts`. Re-exported so `./state` still names every symbol it used to.
export * from "./state-social";

import {
  mailResultText,
  partyResultText,
  tradeStatusText,
  type BankContents,
  type GroupMember,
  type GroupState,
  type PartyMemberAura,
  type PartyMemberStats,
  type PartyPowerType,
  type ItemText,
  type MailEntry,
  type MailboxState,
  type PendingRoll,
  type PetCommand,
  type PetReaction,
  type PetSpellEntry,
  type PetState,
  type RollChoice,
  type TradeSide,
  type TradeState,
} from "./state-social";
import { STREAM_GAP, type StreamEvent } from "./events";
import { resolveName, type Resolution } from "./resolve";

/**
 * A state *query* has no refusal channel — it answers a row or `undefined` —
 * so both "nothing answers to that" and "two things do" read as `undefined`,
 * and the caller falls back to the list accessor. Only actions refuse and say
 * why (METHODOLOGY, "A name in view is a valid referent, with bounded fuzz").
 */
function only<T>(hit: Resolution<T>): T | undefined {
  return hit.kind === "one" ? hit.value : undefined;
}

/**
 * `CORPSE_FLAG_BONES` (AzerothCore `Corpse.h`, `CorpseFlags`) in the
 * `corpseFlags` the module serves raw: what was a corpse is bones, scenery to
 * a client and no resurrection's target.
 */
const CORPSE_FLAG_BONES = 0x01;

/** `UNIT_FLAG_TAXI_FLIGHT` — the bit a client reads to know it is being flown. */
const UNIT_FLAG_TAXI_FLIGHT = 0x0010_0000;

/**
 * The `unitFlags` bits (AzerothCore `UnitDefines.h`, `UnitFlags`) and the
 * `dynamicFlags` bits (`SharedDefines.h`, `UnitDynFlags`) a client names:
 * stunned, in combat, skinnable, mounted; lootable, tapped, tapped by you.
 * Decoded from the two integers the module already serves; nothing new is
 * observed. `UNIT_FLAG_MOUNT` is the bit the server's own `IsMounted()` reads,
 * set by `Unit::Mount` and cleared by `Unit::Dismount`.
 */
const UNIT_FLAG_STUNNED = 0x0004_0000;
const UNIT_FLAG_IN_COMBAT = 0x0008_0000;
const UNIT_FLAG_SKINNABLE = 0x0400_0000;
const UNIT_FLAG_MOUNT = 0x0800_0000;
const UNIT_DYNFLAG_LOOTABLE = 0x0001;
const UNIT_DYNFLAG_TAPPED = 0x0004;
const UNIT_DYNFLAG_TAPPED_BY_PLAYER = 0x0008;

/** `RuneType` (AzerothCore `Player.h`) by value, and the slot layout a Death Knight starts with (`runeSlotTypes`). */
const RUNE_TYPE_NAMES = ["blood", "unholy", "frost", "death"] as const;
const BASE_RUNE_TYPES: readonly number[] = [0, 0, 1, 1, 2, 2];
const CLASS_DEATH_KNIGHT = 6;

/** The totem slot `SMSG_TOTEM_CREATED` names, 0-3 (`SummonSlot` less `SUMMON_SLOT_TOTEM_FIRE`). */
const TOTEM_ELEMENTS = ["fire", "earth", "water", "air"] as const;

/** `MirrorTimerType` (AzerothCore `Player.h`) by value. */
const MIRROR_TIMER_TYPES = ["fatigue", "breath", "fire"] as const;

/** `ItemClass` (AzerothCore `ItemTemplate.h`): the two classes `SMSG_SET_PROFICIENCY` names. */
const ITEM_CLASS_WEAPON = 2;
const ITEM_CLASS_ARMOR = 4;
/** `UnitStandStateType` (AzerothCore `UnitDefines.h`) by value, and the ones a client reads as sitting. */
const STAND_STATE_NAMES = [
  "stand", "sit", "sitChair", "sleep", "sitLowChair", "sitMediumChair", "sitHighChair", "dead", "kneel", "submerged",
] as const;
const SITTING_STAND_STATES: ReadonlySet<number> = new Set([1, 2, 4, 5, 6]);

/** The update-field keys the character sheet is built from. */
const SHEET_FIELD = /^(stat\d|resistance\d|(ranged)?[aA]ttackPower(Mods|Multiplier)?|(ranged)?[cC]ritPct|spellCritPct\d|blockPct|dodgePct|parryPct)$/;

/** `ShapeshiftForm` (AzerothCore `UnitDefines.h`) by value; 0 is no form. The numbering spellbook rows' `stances` and `form` use. */
const SHAPESHIFT_FORM_NAMES: Readonly<Record<number, string>> = {
  0: "none", 1: "cat", 2: "tree", 3: "travel", 4: "aqua", 5: "bear", 6: "ambient", 7: "ghoul", 8: "direBear",
  9: "stevesGhoul", 10: "tharonjaSkeleton", 11: "testOfStrength", 12: "blbPlayer", 13: "shadowDance",
  14: "creatureBear", 15: "creatureCat", 16: "ghostWolf", 17: "battleStance", 18: "defensiveStance",
  19: "berserkerStance", 20: "test", 21: "zombie", 22: "metamorphosis", 25: "undead", 26: "masterAngler",
  27: "flightEpic", 28: "shadow", 29: "flight", 30: "stealth", 31: "moonkin", 32: "spiritOfRedemption",
};

/** The spell schools after physical, as `resistance1`..`6` and `spellCritPct1`..`6` index them (`SpellSchools`). */
const MAGIC_SCHOOLS = ["holy", "fire", "nature", "frost", "shadow", "arcane"] as const;

/**
 * `PLAYER_FLAGS_RESTING` on 3.3.5a (AzerothCore `Player.h`, `PlayerFlags`) —
 * the bit the server sets while the character stands in a rest area, and the
 * one a client reads to draw the resting icon on the XP bar. Decoded here,
 * from the `playerFlags` integer the module already serves: nothing new is
 * observed, only named.
 */
const PLAYER_FLAGS_RESTING = 0x0000_0020;

/**
 * `PLAYER_FLAGS_GHOST` on 3.3.5a — set from the release of the spirit until
 * the resurrect, the bit a client reads to draw the ghost world. Decoded from
 * the same `playerFlags` integer; a ghost's health is 1, so health alone
 * cannot tell one from the living.
 */
export const PLAYER_FLAGS_GHOST = 0x0000_0010;

/**
 * `MEMBER_STATUS_*` (AzerothCore `Group.h`), the status word of
 * `SMSG_PARTY_MEMBER_STATS`: the bits a client's party frame reads for
 * offline, dead, ghost, AFK and DND.
 */
const MEMBER_STATUS_ONLINE = 0x01;
const MEMBER_STATUS_DEAD = 0x04;
const MEMBER_STATUS_GHOST = 0x08;
const MEMBER_STATUS_AFK = 0x40;
const MEMBER_STATUS_DND = 0x80;

/** A member as `SMSG_GROUP_LIST` left it; `group()` joins `inView` and `stats` on at read time. */
type StoredGroupMember = Omit<GroupMember, "inView" | "stats">;
type StoredGroupState = Omit<GroupState, "members"> & { readonly members: readonly StoredGroupMember[] };

/** `Powers` by id, as a party frame's power bar names them. */
const PARTY_POWER_TYPES: Readonly<Record<number, PartyPowerType>> = {
  0: "mana",
  1: "rage",
  2: "focus",
  3: "energy",
  4: "happiness",
  5: "runes",
  6: "runic power",
};

// The wire's react/command state byte, as the pet frame names it; the
// pair the `pet()` fold reads. The names themselves live in `./state-social`.
const PET_REACTIONS: readonly PetReaction[] = ["passive", "defensive", "aggressive"];
const PET_COMMANDS: readonly PetCommand[] = ["stay", "follow", "attack", "abandon"];

/** A value together with the event that carried it. */
/** How near its point a character stands at the release graveyard (`self.graveyard`'s zone and area). */
const GRAVEYARD_NEAR_YARDS = 20;

export interface Observed<T> {
  readonly value: T;
  readonly seq: number;
  readonly ts: number;
}

/**
 * A position as movement packets and update blocks carry it. No map id: no
 * whitelisted packet gives one for another object, so this type cannot pretend
 * to have one.
 */
export interface UnitPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly o: number;
}

/**
 * Own position. `map` only ever comes from `SMSG_LOGIN_VERIFY_WORLD` or `SMSG_NEW_WORLD`; the x/y/z/o
 * of later self updates are paired with the last map that packet reported,
 * which is what a client does. If no map has been observed yet, a self position
 * update is refused and recorded as an anomaly rather than defaulted.
 */
export interface WorldPosition extends UnitPosition {
  readonly map: number;
  /**
   * On `state.self.position` only, while a flight is in progress
   * (`taxiFlight`): this is the take-off point, not where the character is.
   * The flight's own position is not observed until it lands
   * (`taxiEta.landsAt`), which puts position at the end of the flight path.
   */
  readonly inFlight?: true;
}

/** A point with no orientation: what `SMSG_MONSTER_MOVE` carries. */
export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A creature's movement as a player perceives it: where the spline
 * started, where it is heading, how long it takes. No path points: the module
 * consumes them. `pointOf` reads where along it the unit is at a given time.
 */
export interface Motion {
  readonly position: Point3;
  readonly destination: Point3 | undefined;
  readonly durationMs: number | undefined;
  readonly stopped: boolean;
}

/** Current/max pair, as a client would display it. */
export interface Gauge {
  readonly current: number;
  readonly max: number;
}

/** One row of `SMSG_CHAR_ENUM`. */
export interface CharacterSummary {
  readonly guid: GuidKey;
  readonly name: string;
  readonly race: number;
  readonly class: number;
  readonly gender: number;
  readonly level: number;
}

/**
 * One chat line as the module decoded it. `senderName` is the packet's own
 * name where its layout carries one — creature speech (`type` 12–16, 41–42:
 * say/yell/emote/whisper from an NPC) and foreign-language whispers — and
 * otherwise, on `state.chat` and to `waitForChat`, the name query's answer
 * for the sender (`state.nameOf(senderGuid)`) once one has arrived, or a
 * party member's name from the group roster before it has. `type` 9
 * (`WHISPER_INFORM`) is the server's echo of our own whisper, and the core
 * puts the *recipient* in the sender's place: its `senderGuid` and
 * `senderName` name who it went to. `channelName` rides channel lines
 * (`type` 17), `achievementId` the achievement broadcast (`type` 48/49).
 * Creature speech's `message` is filled in as a client fills it: the wire's
 * `%s attempts to run away in fear!` reads `Defias Miner attempts to run away
 * in fear!`, the sender's own name in place of every `%s`
 * (`chatMessageAsShown`). The achievement broadcast's is filled on read, the
 * way its sender's name is joined, because the packet that names the
 * achievement arrives just after the line: `%s has earned the achievement $a!`
 * reads `Tankpartyb has earned the achievement [Deadmines]!`
 * (`achievementChatAsShown`).
 */
export interface ChatEntry {
  readonly seq: number;
  readonly ts: number;
  readonly type: number;
  readonly language: number;
  readonly senderGuid: GuidKey;
  readonly senderName?: string;
  readonly receiverGuid?: GuidKey;
  readonly receiverName?: string;
  readonly channelName?: string;
  readonly message: string;
  readonly chatTag: number;
  readonly achievementId?: number;
}

/** Creature speech: say, party, yell, whisper, emote (12–16) and the raid-boss emote and whisper (41–42). */
const CREATURE_CHAT_TYPES: ReadonlySet<number> = new Set([12, 13, 14, 15, 16, 41, 42]);

/**
 * A chat line's text as a client prints it. Creature speech is a template
 * whose `%s` is the speaker (`%s attempts to run away in fear!`), which a
 * client fills with the name the packet carries; every other line is the
 * text as sent.
 */
export function chatMessageAsShown(type: number, message: string, senderName: string | undefined): string {
  if (senderName === undefined || !CREATURE_CHAT_TYPES.has(type)) return message;
  return message.replaceAll("%s", senderName);
}

/** The achievement broadcast, `CHAT_MSG_ACHIEVEMENT` (48) and `CHAT_MSG_GUILD_ACHIEVEMENT` (49). */
export const ACHIEVEMENT_CHAT_TYPES: ReadonlySet<number> = new Set([48, 49]);

/**
 * The achievement broadcast's text as a client prints it. The wire's
 * `%s has earned the achievement $a!` is a template: a client puts the
 * earner's name for `%s` and the achievement's link, its name in brackets,
 * for `$a`. The name is what an achievement packet named that id with
 * (`Achievement.dbc`, client-cache knowledge); with none observed the link
 * reads `[achievement <id>]`. `%s` stays as sent while the sender has no name.
 */
export function achievementChatAsShown(
  message: string,
  senderName: string | undefined,
  achievementId: number | undefined,
  achievementName: string | undefined,
): string {
  const link =
    achievementName !== undefined
      ? `[${achievementName}]`
      : achievementId !== undefined
        ? `[achievement ${achievementId}]`
        : undefined;
  const linked = link === undefined ? message : message.replaceAll("$a", link);
  return senderName === undefined ? linked : linked.replaceAll("%s", senderName);
}

export interface NotificationEntry {
  readonly seq: number;
  readonly ts: number;
  readonly text: string;
}

/**
 * Own character. Fields are `undefined` until an event supplies them.
 *
 * `guid` and `name` are *seeded* from the `POST /session` response rather than
 * derived from events, because no whitelisted opcode says "you are guid N".
 * They are recorded separately (`seed`) so a replay is explicit about the one
 * input that did not come off the wire.
 */
/**
 * Everything an update block's `fields` can write to. `self` and a nearby
 * object share it, so one merge path serves both.
 *
 * `fields` is the raw per-field record: every named numeric field the module
 * decoded, each with the seq/ts of the block that carried it. The typed groups
 * above it are *derived* from those fields, and only when the derivation is
 * complete — see `deriveGauges`.
 */
export interface UnitFieldsState {
  level: Observed<number> | undefined;
  health: Observed<Gauge> | undefined;
  power: Observed<Gauge> | undefined;
  fields: Map<string, Observed<number>>;
}

/**
 * Where the corpse is, while dead. `source` says which packet it came from:
 * `corpse_query` is the server's own answer to the ghost's `MSG_CORPSE_QUERY`
 * (the one a client draws its corpse marker from); `death_spot` is the own
 * position at the moment health reached 0, held until that answer lands. Both
 * are things a client shows a player.
 *
 * A corpse inside a dungeon, queried from outside it, is answered with the
 * dungeon's entrance instead (`HandleCorpseQueryOpcode`): `map`/`x`/`y`/`z`
 * are then that entrance as the server places it, the marker a client draws,
 * and `instanceMap` is the map the corpse actually lies on. No position inside
 * the instance is in the packet. A reclaim cannot reach it from outside; a
 * ghost entering that dungeon's portal comes back to life inside on arrival.
 */
export interface CorpseLocation extends Point3 {
  readonly map: number;
  readonly source: "corpse_query" | "death_spot";
  /** The instance map the corpse is in, present only when `map`/`x`/`y`/`z` are its entrance. */
  readonly instanceMap?: number;
}

/**
 * A zone or subzone as the client names it: the id the client computes from
 * its own map files and the `AreaTable.dbc` name it draws on screen. `name` is
 * `""` only for an id the DBC has no row for.
 */
export interface AreaRef {
  readonly id: number;
  readonly name: string;
}

/**
 * A map's `InstanceType` in the client's own words for it: `none` the open
 * world, `party` a dungeon, `raid`, `pvp` a battleground, `arena`.
 */
export type InstanceType = "none" | "party" | "raid" | "pvp" | "arena";

/** `Map.dbc`'s `InstanceType` codes, in order. */
const INSTANCE_TYPES: readonly InstanceType[] = ["none", "party", "raid", "pvp", "arena"];

/**
 * The map the character is on as the client names it: the id the server's
 * world packets carry, and the client's `Map.dbc` name and instance type for
 * it, e.g. `{ id: 36, name: "Deadmines", instanceType: "party" }`.
 */
export interface MapRef {
  readonly id: number;
  readonly name: string;
  readonly instanceType: InstanceType;
}

/**
 * One map-transition portal in view: the centre of its `AreaTrigger.dbc`
 * volume (the client's own cache) on the map the character is on, and the
 * map it leads to, named and typed from `Map.dbc` (`name`/`instanceType`
 * undefined for a map the module has no row for). Never the arrival point.
 */
export interface PortalInView extends Point3 {
  readonly triggerId: number;
  readonly map: number;
  readonly to: { readonly id: number; readonly name: string | undefined; readonly instanceType: InstanceType | undefined };
}

/**
 * An offer to resurrect this dead character (`SMSG_RESURRECT_REQUEST`), as a
 * client's "accept resurrection?" dialog shows it: who is offering (`casterName`
 * from the packet for a creature, else the name a query returned for the
 * guid; undefined when neither is known) and whether accepting brings
 * resurrection sickness.
 */
export interface PendingResurrect {
  readonly casterGuid: GuidKey;
  readonly casterName: string | undefined;
  readonly sickness: boolean;
  readonly seq: number;
  readonly ts: number;
}

/**
 * One achievement the character holds, as the packets said it.
 *
 * `source` is which packet carried it: `login` is the `SMSG_ALL_ACHIEVEMENT_DATA`
 * backlog a client receives once during login, `earned` is an
 * `SMSG_ACHIEVEMENT_EARNED` for our own guid. The distinction is the whole
 * point — a backlog entry is history, an earn is a thing that just happened —
 * and it is what keeps the runner from re-reporting a resumed run's past as
 * fresh milestones.
 *
 * `name`, `points` and `categoryId` are present only when the module could read
 * `Achievement.dbc`; nothing is invented for an id it could not name.
 */
export interface AchievementEntry {
  readonly achievementId: number;
  readonly name: string | undefined;
  readonly points: number | undefined;
  readonly categoryId: number | undefined;
  /** The wire's packed time bitfield, and the module's reading of it. */
  readonly date: number | undefined;
  readonly time: string | undefined;
  readonly source: "login" | "earned";
  readonly seq: number;
  readonly ts: number;
}

/**
 * Every achievement observed for our own character, in observation order:
 * the login backlog first, then each earn as it landed.
 *
 * `points` is the sum of the entries whose points the module could name — a
 * lower bound when `Achievement.dbc` is absent, never a guess. `loginSeen` is
 * whether `SMSG_ALL_ACHIEVEMENT_DATA` was observed at all, which is a different
 * fact from the list being empty: a fresh character's backlog is genuinely
 * empty, and a session the cache joined late has no backlog to show.
 */
export interface AchievementsState {
  readonly entries: readonly AchievementEntry[];
  readonly points: number;
  readonly loginSeen: boolean;
}

export interface SelfState extends UnitFieldsState {
  guid: GuidKey | undefined;
  name: string | undefined;
  position: Observed<WorldPosition> | undefined;
  /**
   * The zone the character stands in (`WB_AREA`, seeded by the login
   * snapshot): the top-level area, e.g. "Elwynn Forest". Changes whether the
   * character walked, was teleported or transferred.
   */
  zone: Observed<AreaRef> | undefined;
  /** The subzone (`WB_AREA`), e.g. "Northshire Valley"; equals `zone` when there is none. */
  area: Observed<AreaRef> | undefined;
  /**
   * The map (`WB_AREA`, seeded by the login snapshot): its id, the client's
   * `Map.dbc` name and instance type — `instanceType: "party"` inside a
   * dungeon. Undefined until a `WB_AREA` named it, and again from a map
   * change until the new map's `WB_AREA` (`position.map` is the id alone).
   */
  map: Observed<MapRef> | undefined;
  /**
   * The map-transition portals in view (`WB_PORTALS`): each dungeon entrance
   * or exit on this map within the map's view range, where it stands and the
   * map it leads to. A portal is scenery and an areatrigger volume, never a
   * unit or game object, so this is the only place one shows; walking into
   * it is what takes you through. `[]` when none is in view; undefined until
   * the module reported (and from a map change until the new map's report).
   */
  portals: Observed<readonly PortalInView[]> | undefined;
  /**
   * The corpse, from death until the resurrect (`SMSG_DEATH_RELEASE_LOC` with
   * `map: -1`). `undefined` while alive, before the first death, or when the
   * server answered the corpse query with "no corpse" (a spirit-healer
   * resurrection or a corpse that expired). A ghost walks here to reclaim,
   * unless `instanceMap` says the corpse is inside a dungeon (see `CorpseLocation`).
   */
  corpse: Observed<CorpseLocation> | undefined;
  /**
   * The graveyard the spirit was released to, from `SMSG_DEATH_RELEASE_LOC`
   * (the packet a client draws the spirit-healer marker from). Cleared by the
   * same packet with `map: -1`, which is what a resurrect sends first.
   * `zone` and `area` are the names the character's own zone text showed
   * while it stood there (`WB_AREA` within 20y of the point), undefined
   * until it has: the release port lands the ghost on it.
   */
  graveyard: Observed<Point3 & { readonly map: number; readonly zone?: AreaRef; readonly area?: AreaRef }> | undefined;
  /**
   * The server's reclaim delay for this death (`SMSG_CORPSE_RECLAIM_DELAY`):
   * `readyAt` is the event's wall-clock `ts` plus `delayMs`, when a reclaim
   * becomes legal. Cleared by the resurrect.
   */
  reclaimDelay: Observed<{ readonly delayMs: number; readonly readyAt: number }> | undefined;
  /**
   * A map transfer the server announced (`SMSG_TRANSFER_PENDING`) and has not
   * yet completed (`SMSG_NEW_WORLD`) or abandoned (`SMSG_TRANSFER_ABORTED`).
   * While set, `position` is the old map's last word.
   */
  transfer: Observed<{ readonly toMap: number }> | undefined;
  /** `UNIT_FIELD_TARGET` on our own block: what the client shows as selected. */
  targetGuid: Observed<GuidKey> | undefined;
  /**
   * Achievements held, from the login backlog and our own earns.
   * `undefined` until an achievement packet has been observed at all.
   */
  achievements: AchievementsState | undefined;
  /**
   * `UNIT_FLAG_TAXI_FLIGHT` on our own `unitFlags`: true while the character is
   * being flown. There is no flight event — a `taxiReply` of `ok` followed by
   * this turning true is the flight starting, and the flip back is the landing,
   * exactly as a client reads it.
   */
  taxiFlight: Observed<boolean> | undefined;
  /**
   * When the flight lands, from the spline the server flies the character
   * along (`SMSG_MONSTER_MOVE` for our own guid): `durationMs` is the ride's
   * length and `landsAt` is the packet's `ts` plus it, in wall-clock ms like
   * `reclaimDelay.readyAt`. `undefined` until the flight's spline has arrived
   * (an accepted reply precedes it by a server tick, so read it after
   * `taxiFlight` is true, never off the reply alone) and again after the
   * landing. `position` stays the take-off point until the landing puts it
   * where the spline ends, and the module's own drop to the ground under that
   * point (`WB_SELF_MOVE`) follows within a tick.
   */
  taxiEta: Observed<{ readonly durationMs: number; readonly landsAt: number }> | undefined;
  /**
   * `PLAYER_FLAGS_RESTING` on our own `playerFlags`: true while the character
   * is in a rest area — an inn or a city — which is what the client's own
   * resting icon says. Read the same way `taxiFlight` reads `unitFlags`: only
   * from a block that actually carried `playerFlags`, so an update that omits
   * the field leaves the last observation standing rather than erasing it.
   * `undefined` until a block has carried `playerFlags` at all.
   */
  resting: Observed<boolean> | undefined;
  /**
   * Our own cast in progress, as the client's cast bar shows it: set by an
   * own `SMSG_SPELL_START` with a cast time, `endsAt` being that packet's
   * `ts` plus the cast time (wall-clock ms like `taxiEta.landsAt`), and
   * cleared by the same spell's own `SMSG_SPELL_GO` (it went off) or
   * `SMSG_SPELL_FAILURE` (it was interrupted). A refusal (`SMSG_CAST_FAILED`)
   * of a second cast leaves the running one standing, as it does on the
   * server. A pushback (`SMSG_SPELL_DELAYED`) moves `endsAt` later by the
   * delay, as the client's cast bar moves. An instant cast never sets it,
   * and a channel does not either: a channel starts after its spell's
   * `SMSG_SPELL_GO` and shows in `channeling`.
   */
  casting: Observed<{ readonly spellId: number; readonly name: string | undefined; readonly endsAt: number }> | undefined;
  /**
   * `PLAYER_FLAGS_GHOST` on our own `playerFlags`: true while the released
   * spirit walks as a ghost, from the release until the resurrect. A ghost's
   * health reads 1, not 0, so this is the reading that says dead once the
   * spirit is released. Guarded like `resting`; `undefined` until a block has
   * carried `playerFlags` at all.
   */
  ghost: Observed<boolean> | undefined;
  /**
   * `UNIT_FLAG_IN_COMBAT` and `UNIT_FLAG_STUNNED` on our own `unitFlags`: the
   * client's combat indicator and its stunned state. Guarded like `resting`:
   * read only from a block that carried `unitFlags`, so an update without it
   * leaves the last observation standing; `undefined` until one has.
   */
  inCombat: Observed<boolean> | undefined;
  stunned: Observed<boolean> | undefined;
  /**
   * `UNIT_FLAG_MOUNT` on our own `unitFlags`: true while the character rides
   * a mount. A flight path mounts the rider too, so it is true for the ride
   * (`taxiFlight`), which cannot be dismounted. Guarded the same way.
   */
  mounted: Observed<boolean> | undefined;
  /**
   * Our own channel in progress, as the client's channel bar shows it: set by
   * an own `MSG_CHANNEL_START` (which follows the spell's `SMSG_SPELL_GO`, so
   * a channel never shows in `casting`), `endsAt` being that packet's `ts`
   * plus the duration (wall-clock ms). A pushback's `MSG_CHANNEL_UPDATE`
   * moves `endsAt`; the update with no time left, the spell's own
   * `SMSG_SPELL_FAILURE`, or a self block carrying `channelSpell` 0 ends it.
   * `targetGuid` is what it is channelled at (`UNIT_FIELD_CHANNEL_OBJECT`),
   * once a block has carried it.
   */
  channeling:
    | Observed<{ readonly spellId: number; readonly name: string | undefined; readonly endsAt: number; readonly targetGuid: GuidKey | undefined }>
    | undefined;
  /**
   * Combo points (`SMSG_UPDATE_COMBO_POINTS`, sent on every change): how many
   * and on whom, `targetGuid` undefined when on no one. `undefined` until the
   * first packet; a login sends none while the count is 0.
   */
  comboPoints: Observed<{ readonly points: number; readonly targetGuid: GuidKey | undefined }> | undefined;
  /**
   * A Death Knight's six runes by slot (0-1 blood, 2-3 unholy, 4-5 frost):
   * `type` is the rune's current type (`SMSG_CONVERT_RUNE` changes it, a
   * death rune included), and `ready` whether it was ready as of the last own
   * cast that spent runes (`SMSG_SPELL_GO`'s rune list), `undefined` before
   * one. A spent rune refills on the client's own clock (10 s at base, less
   * with haste) and no packet says when, so `ready` is that cast's word, at
   * its `ts`. `undefined` for any other class.
   */
  runes: Observed<readonly RuneSlot[]> | undefined;
  /**
   * Our totems by slot (`SMSG_TOTEM_CREATED`): `slot` is the number
   * `CMSG_TOTEM_DESTROYED` takes, `expiresAt` the packet's `ts` plus the
   * duration (wall-clock ms). A totem leaves when the server destroys its
   * object (`SMSG_DESTROY_OBJECT`) or another takes its slot; one out of view
   * when it runs out stays listed, so read `expiresAt`.
   */
  totems: readonly TotemSlot[];
  /**
   * The breath, fatigue and fire bars a client draws (`SMSG_START_MIRROR_TIMER`
   * / `SMSG_STOP_MIRROR_TIMER`), by type. Sent on a change only: `value` is
   * the ms left at `ts`, moving by `scale` ms per ms (-1 draining, 10
   * refilling); at 0 the drowning or fatigue damage starts. Empty when no bar
   * is up.
   */
  mirrorTimers: readonly MirrorTimer[];
  /**
   * The item subclasses this character can use (`SMSG_SET_PROFICIENCY`, the
   * whole mask per item class each time): bit n of `weaponMask` is weapon
   * subclass n (item class 2), of `armorMask` armour subclass n (class 4),
   * as an item template's `subclass` numbers them. Each is undefined until
   * its packet arrived.
   */
  proficiency: Observed<{ readonly weaponMask: number | undefined; readonly armorMask: number | undefined }> | undefined;
  /**
   * Stand state, byte 0 of our own `UNIT_FIELD_BYTES_1`: `id` the
   * `UnitStandStateType` and `name` its reading ("stand", "sit", "sitChair",
   * "sleep", "dead", "kneel", …), and `sitting` whether the client draws the
   * character seated (sit or any chair). Guarded like `resting`; `undefined`
   * until a block carried the field.
   */
  standState: Observed<{ readonly id: number; readonly name: string | undefined }> | undefined;
  sitting: Observed<boolean> | undefined;
  /**
   * Shapeshift form, byte 3 of our own `UNIT_FIELD_BYTES_2`: `id` the
   * `ShapeshiftForm` (0 none; the numbering a spellbook row's `stances` and
   * `form` use) and `name` ("none", "cat", "bear", "battleStance",
   * "stealth", …). Guarded the same way.
   */
  shapeshiftForm: Observed<{ readonly id: number; readonly name: string | undefined }> | undefined;
  /**
   * The character sheet, from our own PRIVATE update fields; each number is
   * undefined until a block carried its field. `undefined` until any has.
   */
  stats: Observed<CharacterStats> | undefined;
  /** Rested XP (`PLAYER_REST_STATE_EXPERIENCE`): the bonus pool the XP bar shades. */
  restedXp: Observed<number> | undefined;
  /**
   * Which unit this client moves, from `SMSG_CLIENT_CONTROL_UPDATE`
   * (`Player::SetClientControl`): `mover` is our own guid, or the vehicle or
   * possessed unit the server handed over (a vehicle's driving seat, the Eye
   * of Acherus), and `allowMove` whether it may be moved at all — false while
   * feared or confused, and between a handover ending and control of the
   * character returning. The handed-over unit's spells are its control bar,
   * `pet()`, cast with `petCast`. `undefined` until a control update has
   * been observed: a client starts in control of itself.
   */
  control: Observed<{ readonly mover: GuidKey; readonly allowMove: boolean }> | undefined;
  /**
   * The vehicle this character sits in and its seat, from the boarding
   * spline the server launches onto the seat (`SMSG_MONSTER_MOVE_TRANSPORT`
   * for our own guid with a seat index); cleared by the exit spline
   * (`SMSG_MONSTER_MOVE` with `transportExit`) and by a new world. Whether
   * we drive it is `control` naming its guid. `undefined` when not aboard.
   */
  vehicle: Observed<{ readonly guid: GuidKey; readonly seat: number }> | undefined;
  /**
   * The last `SMSG_ACTIVATETAXIREPLY` (the answer to a raw `CMSG_ACTIVATETAXI`).
   * Kept because it is the only thing that says a flight was *accepted*; the
   * ride itself shows on `taxiFlight`.
   */
  taxiReply: Observed<{ readonly reply: number; readonly ok: boolean }> | undefined;
  /**
   * Where the Hearthstone goes (`SMSG_BINDPOINTUPDATE`): sent once at login
   * and again after every innkeeper bind, so this is always the server's
   * current word. `undefined` only before the login packet has been seen.
   */
  bindPoint: Observed<BindPoint> | undefined;
}

/** A Death Knight rune slot (`SelfState.runes`). */
export interface RuneSlot {
  readonly index: number;
  /** `undefined` for a type id the SDK does not know. */
  readonly type: "blood" | "unholy" | "frost" | "death" | undefined;
  readonly ready: boolean | undefined;
}

/** One of our totems (`SelfState.totems`). */
export interface TotemSlot {
  /** 0 fire, 1 earth, 2 water, 3 air: what `CMSG_TOTEM_DESTROYED` takes. */
  readonly slot: number;
  readonly element: "fire" | "earth" | "water" | "air" | undefined;
  readonly guid: GuidKey;
  readonly spellId: number;
  readonly name: string | undefined;
  readonly durationMs: number;
  readonly expiresAt: number;
  readonly seq: number;
  readonly ts: number;
}

/** A breath, fatigue or fire bar (`SelfState.mirrorTimers`). */
export interface MirrorTimer {
  readonly type: "fatigue" | "breath" | "fire" | undefined;
  /** The wire's timer type: 0 fatigue, 1 breath, 2 fire. */
  readonly typeId: number;
  /** ms left at `ts`. */
  readonly value: number;
  readonly max: number;
  /** ms gained per ms: -1 draining, 10 refilling. */
  readonly scale: number;
  readonly paused: boolean;
  readonly seq: number;
  readonly ts: number;
}

/**
 * The character sheet (`SelfState.stats`). Primary stats and armour are the
 * totals with buffs; `attackPower` is (base + mods) × (1 + multiplier), the
 * server's own total, floored. Percentages are as the sheet shows them.
 */
export interface CharacterStats {
  readonly strength: number | undefined;
  readonly agility: number | undefined;
  readonly stamina: number | undefined;
  readonly intellect: number | undefined;
  readonly spirit: number | undefined;
  readonly armor: number | undefined;
  readonly resistances: { readonly [school in (typeof MAGIC_SCHOOLS)[number]]: number | undefined };
  readonly attackPower: number | undefined;
  readonly rangedAttackPower: number | undefined;
  readonly critPct: number | undefined;
  readonly rangedCritPct: number | undefined;
  readonly spellCritPct: { readonly [school in (typeof MAGIC_SCHOOLS)[number]]: number | undefined };
  readonly blockPct: number | undefined;
  readonly dodgePct: number | undefined;
  readonly parryPct: number | undefined;
}

/**
 * The hearthstone's destination as the wire carries it: map, position, and
 * the area id with the client's `AreaTable.dbc` name for it (`""` when the
 * table has no row).
 */
export interface BindPoint {
  readonly map: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly area: AreaRef;
}

/**
 * One node in a flight master's window: the wire id, and the name and map
 * position the client's own `TaxiNodes.dbc` row gives it — the point its
 * flight map draws the node at, in the same frame `moveTo` takes. All four
 * are absent together when the module has no row for the id.
 */
export interface TaxiNodeRef {
  readonly nodeId: number;
  readonly name: string | undefined;
  readonly map?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly z?: number | undefined;
}

/**
 * The flight master's window last observed for one NPC: the fold of the last
 * `SMSG_SHOWTAXINODES` for that guid. `current` is the node the master
 * stands at (what `activateTaxi` sends as the source), `known` the nodes this
 * character has visited — the only destinations the server will accept, and only one
 * flight path from `current` (a farther one gets no reply).
 * `mask` is the taximask verbatim. Nothing here is a route or a fare.
 */
export interface TaxiWindow {
  readonly guid: GuidKey;
  readonly current: TaxiNodeRef;
  readonly known: readonly TaxiNodeRef[];
  readonly mask: readonly number[];
  readonly seq: number;
  readonly ts: number;
}

/**
 * One occupied quest-log slot, folded out of the raw `quest<slot><Off>` update
 * fields (PROTOCOL.md; the module keeps the wire shape and leaves the join here).
 *
 * `complete` is the quest log's own completion bit, and it is the *only*
 * reliable completion signal for a kill objective at the pinned commit: the
 * core emits `SMSG_QUESTUPDATE_COMPLETE` for exploration/event objectives but
 * not for kill ones. `counts` are the four packed u16 objective counters, one
 * per objective slot, split out of the two u32 halves — the log carries the
 * current counts only, never the required ones (those are on
 * `SMSG_QUESTUPDATE_ADD_KILL` and the quest details), so nothing here compares
 * them.
 */
export interface QuestLogEntry {
  readonly slot: number;
  readonly questId: number;
  /** From the quest query answer, once it has arrived. */
  readonly title: string | undefined;
  /**
   * The quest's level as the client's quest log shows it, from the quest
   * query answer's `level`. A template level of -1 (or 0) marks a quest that
   * scales to the player, and reads as the character's current level: the
   * core resolves it that way itself (`Player::GetQuestLevel`), and its
   * response writer notes the client must do the same. `undefined` until the
   * answer has arrived, or while a scaling quest's character level is
   * unobserved. The raw template value stays on `state.quests`.
   */
  readonly level: number | undefined;
  /**
   * The objectives as the client's quest log renders them ("Kobold Vermin
   * slain: 3/8"), joined from the quest query answer (`required`, `text`,
   * `entry`) and the log's own counters (`have`). `undefined` until
   * `SMSG_QUEST_QUERY_RESPONSE` has answered for this quest — the log alone
   * carries no denominators, so nothing is invented before then.
   */
  readonly objectives: readonly QuestObjective[] | undefined;
  /** Raw `PLAYER_QUEST_LOG_x_STATE`, unmasked, as the wire carried it. */
  readonly state: number;
  /** `state & 1` — the objectives are done and the quest can be turned in. */
  readonly complete: boolean;
  readonly counts: readonly [number, number, number, number];
  /** `PLAYER_QUEST_LOG_x_TIME`, when the slot carried one. */
  readonly timer: number | undefined;
  readonly seq: number;
  readonly ts: number;
}

/**
 * One objective of a quest in the log, client-style. `kind` is what the
 * required entry denotes: `kill` a creature, `interact` a gameobject (the
 * wire's `entry | 0x80000000`), `collect` an item, `event` a scripted
 * objective that carries text but no entry, `explore` a place to reach (the
 * template's exploration flag; one row, after the others). `have` is the log's
 * counter for creature/gameobject/event slots and, for items, the stack total
 * the server's `Player::GetItemCount(id, false)` counts — equipment, the worn
 * bags themselves, the backpack, the worn bags' contents, the keyring and the
 * currency token slots, never the bank — the two places a client reads it from.
 *
 * An `explore` row has no counter on the wire. Its `text` is the template's
 * `areaDescription` (the objectives text when that is empty), and it is
 * `done` (`have` 1 of 1) when the quest log's completion bit is set, or when
 * `SMSG_QUESTUPDATE_COMPLETE` named the quest during this session while it was
 * in the log — the server's only report of an exploration credit before the
 * rest of a quest is done. No packet restates that credit at login, so after
 * a relog a quest with other objectives still open reads not done until the
 * completion bit says so.
 */
export interface QuestObjective {
  readonly kind: "kill" | "interact" | "collect" | "event" | "explore";
  /** Creature entry, gameobject entry, or item id, by `kind`. `undefined` for `event` and `explore`. */
  readonly entry: number | undefined;
  /** The objective's own text from the template, when it has one. */
  readonly text: string | undefined;
  readonly required: number;
  readonly have: number;
  /** `have >= required`. */
  readonly done: boolean;
}

/**
 * What `SMSG_QUEST_QUERY_RESPONSE` said about one quest: the template the
 * client renders its log from. Kept as the wire shape, minus the reward fields
 * the module does not serve.
 */
export interface QuestInfo {
  readonly questId: number;
  readonly title: string;
  readonly level: number | undefined;
  readonly minLevel: number | undefined;
  /** The template's `QUEST_FLAGS_*` word, raw; `undefined` from a module that does not serve it. */
  readonly flags: number | undefined;
  readonly objectivesText: string | undefined;
  readonly details: string | undefined;
  /** The line a quest log lists for an exploration or event objective. */
  readonly areaDescription: string | undefined;
  readonly completedText: string | undefined;
  /** Four slots, as the wire carries them; unused slots have `entry` 0 and `count` 0. */
  readonly requiredNpcOrGo: readonly { entry: number; count: number; text: string | undefined }[];
  /** Six slots; unused slots have `itemId` 0. */
  readonly requiredItems: readonly { itemId: number; count: number }[];
}

/**
 * One quest turn-in the server confirmed, from `SMSG_QUESTGIVER_QUEST_COMPLETE`.
 *
 * The quest log cannot tell us this after the fact: a rewarded quest leaves the
 * log entirely, so the only trace of the turn-in is the packet itself. `xp` and
 * `money` are the reward the packet named, kept because they are what the
 * server said, not a derivation.
 */
export interface QuestCompletion {
  readonly questId: number;
  readonly xp: number | undefined;
  /** Copper the turn-in awarded, as the packet reported it. */
  readonly money: number | undefined;
  readonly seq: number;
  readonly ts: number;
}

/**
 * One occupied inventory slot: equipment and bags are 0-22, the backpack 23-38,
 * the bank 39-66 and the bank bags 67-73 (bank slots since; an older
 * module serves none).
 *
 * A three-way join, and each leg can be missing: the `invSlot<n>Lo`/`Hi` halves
 * give a guid, the item's own create block gives that guid an `entry`, and an
 * item query gives the entry a name. A slot whose item has not been created for
 * us yet is still a real observation — the slot is occupied — so it appears
 * with `itemId` and `name` undefined rather than being hidden.
 */
export interface InventoryItem extends ItemInstance {
  readonly slot: number;
  readonly guid: GuidKey;
  readonly itemId: number | undefined;
  readonly stackCount: number | undefined;
  /**
   * The item's own durability update fields (`ITEM_FIELD_DURABILITY` /
   * `ITEM_FIELD_MAXDURABILITY`, the "Durability 30 / 40" line of the
   * client's tooltip), present when the item has a maximum.
   * `current` 0 is broken: a broken item gives no stats and a broken weapon
   * does not count for a spell that needs one. A durability field the
   * create block left out is the wire compressing a zero, so it reads 0.
   */
  readonly durability?: { readonly current: number; readonly max: number };
  readonly seq: number;
  readonly ts: number;
}

/**
 * One occupied carried slot, addressed the way the item actions want it:
 * `bag`/`slot` feed `equipItem`, `useItem` and `destroyItem` unchanged. For
 * the backpack `bag` is 255 and `slot` 23-38; for a worn bag `bag` is the
 * bag's own equipment slot (19-22) and `slot` 0..numSlots-1 — exactly what
 * `Player::GetItemByPos(bag, slot)` resolves behind `CMSG_USE_ITEM` and
 * `CMSG_DESTROYITEM`.
 */
export interface BagSlotItem extends ItemInstance {
  readonly bag: number;
  readonly slot: number;
  readonly guid: GuidKey;
  readonly itemId: number | undefined;
  readonly count: number | undefined;
}

/**
 * What one carried or worn item shows that its template alone does not: the
 * name as the client's bag draws it — the template name plus the random
 * suffix ("Sentry's Leggings of the Bear") when the item rolled one — and
 * the stat lines of the tooltip. `stats` is the template's list followed by
 * the random property's stat enchants at the amounts the client computes
 * (ITEM_FIELD_PROPERTY_SEED × the suffix's allocation / 10000, or the
 * enchant row's own amount for a positive property), so an "of the Bear"
 * whose template says `stats: []` reads `[{ type: 7, value: 5 }, { type:
 * 4, value: 3 }]` here; `undefined` until the item query answered.
 * `suffix` and `enchants` are present only on an item that carries a random
 * property or an enchantment; `enchants` is the green lines in slot order
 * ("+5 Stamina", "+3 Strength"), `$i` in the client's text replaced by the
 * amount.
 */
export interface ItemInstance {
  readonly name: string | undefined;
  /** Item quality (0 poor .. 5 legendary) from the item query, when answered. */
  readonly quality?: number | undefined;
  readonly suffix?: string;
  readonly stats?: readonly ItemStat[] | undefined;
  readonly enchants?: readonly string[];
}

/**
 * The client's reading of an item instance's random property and
 * enchantment update fields (`randomPropertyId`, `propertySeed`, the
 * `enchant<n>*` keys and the DBC rows the module serves beside them).
 * Pure over the folded fields. `undefined` when the item has none.
 */
export function randomPropertyOf(item: Pick<NearbyObject, "fields" | "texts"> | undefined): { suffix: string | undefined; stats: ItemStat[]; enchants: string[] } | undefined {
  if (item === undefined) return undefined;
  const id = item.fields.get("randomPropertyId")?.value ?? 0;
  const seed = item.fields.get("propertySeed")?.value ?? 0;
  const suffix = id !== 0 ? item.texts.get("suffixName")?.value : undefined;
  const stats: ItemStat[] = [];
  const enchants: string[] = [];
  for (let n = 0; n < ENCHANTMENT_SLOTS; n++) {
    const enchantId = item.fields.get(`enchant${n}Id`)?.value ?? 0;
    if (enchantId === 0) continue;
    let firstAmount: number | undefined;
    for (let i = 0; i < ENCHANTMENT_EFFECTS; i++) {
      const type = item.fields.get(`enchant${n}Effect${i}Type`)?.value ?? 0;
      if (type === 0) continue;
      const arg = item.fields.get(`enchant${n}Effect${i}Arg`)?.value ?? 0;
      let amount = item.fields.get(`enchant${n}Effect${i}Amount`)?.value ?? 0;
      // A random suffix's enchants (slots 7-11) carry no amount of their own:
      // the client scales the suffix's per-slot allocation by the seed.
      if (id < 0 && n >= PROP_ENCHANTMENT_SLOT_0) {
        const alloc = item.fields.get(`suffixAlloc${n - PROP_ENCHANTMENT_SLOT_0}`)?.value ?? 0;
        amount = Math.floor((alloc * seed) / 10000);
      }
      if (firstAmount === undefined) firstAmount = amount;
      if (type === ENCHANTMENT_TYPE_STAT) stats.push({ type: arg, value: amount });
    }
    const text = item.texts.get(`enchant${n}Text`)?.value;
    if (text !== undefined) enchants.push(text.replace(/\$i/g, String(firstAmount ?? 0)));
  }
  if (suffix === undefined && stats.length === 0 && enchants.length === 0) return undefined;
  return { suffix, stats, enchants };
}

/** `MAX_ENCHANTMENT_SLOT`: twelve enchantment slots per item. */
const ENCHANTMENT_SLOTS = 12;
/** `MAX_SPELL_ITEM_ENCHANTMENT_EFFECTS`: three effects per enchantment row. */
const ENCHANTMENT_EFFECTS = 3;
/** `PROP_ENCHANTMENT_SLOT_0`: the first of the five slots a random property fills. */
const PROP_ENCHANTMENT_SLOT_0 = 7;
/** `ITEM_ENCHANTMENT_TYPE_STAT`: the effect's arg is an `ItemModType`, its amount the stat value. */
const ENCHANTMENT_TYPE_STAT = 5;

/** One worn bag, by the equipment slot the item actions address it as. */
export interface WornBag {
  readonly slot: number;
  readonly numSlots: number;
  readonly name: string | undefined;
}

/**
 * One occupied slot of the vendor window's buyback tab: an item this character
 * sold, which `CMSG_BUYBACK_ITEM` (raw: `[{ guid: vendor }, { u32: slot }]`,
 * at a vendor) buys back for `price`. `slot` is the core's 74-85, the number
 * that packet names. The same three-way join as `bag()`: after a reattach a
 * slot filled earlier has a guid and no `itemId` (the replay does not
 * re-create the item), as a client that dialled in again would hold it.
 */
export interface BuybackItem extends ItemInstance {
  readonly slot: number;
  readonly guid: GuidKey;
  readonly itemId: number | undefined;
  readonly count: number | undefined;
  /** Copper to buy it back (`PLAYER_FIELD_BUYBACK_PRICE_1`); `undefined` until observed. */
  readonly price: number | undefined;
}

/** The whole carried inventory — backpack plus worn bags — as `bag()` reports it. */
export interface BagContents {
  readonly items: readonly BagSlotItem[];
  /** Empty slots across the backpack and every worn bag whose size is known. */
  readonly freeSlots: number;
  /** 16 for the backpack plus each worn bag's `numSlots`. */
  readonly totalSlots: number;
  /** Worn bags (equipment slots 19-22), in slot order. */
  readonly bags: readonly WornBag[];
}

/**
 * What an item query answered about one item entry: the tooltip. The fields
 * past `buyPrice` are `undefined` on events from a module older
 * than 2026-08-29 and on items that simply have none (no stats, no damage).
 * `inventoryType` is the equip slot class (1 head, 13 one-hand, 17 two-hand,
 * 21 main hand, 22 off hand, 15 ranged, 18 bag, ...); `class` 2 weapon, 4
 * armor, 0 consumable, 1 container, 12 quest; `bonding` 1 binds on pickup,
 * 2 on equip, 3 on use, 4 quest item; `speedMs` is the weapon's swing time.
 */
export interface ItemInfo {
  readonly itemId: number;
  readonly name: string;
  readonly quality: number | undefined;
  readonly inventoryType: number | undefined;
  readonly itemLevel: number | undefined;
  readonly requiredLevel: number | undefined;
  readonly sellPrice: number | undefined;
  readonly buyPrice: number | undefined;
  readonly class: number | undefined;
  readonly subClass: number | undefined;
  readonly requiredSkill: { readonly id: number; readonly rank: number; readonly name: string | undefined } | undefined;
  readonly requiredReputation: { readonly factionId: number; readonly rank: number; readonly name: string | undefined } | undefined;
  readonly maxCount: number | undefined;
  readonly stackable: number | undefined;
  readonly containerSlots: number | undefined;
  readonly stats: readonly ItemStat[] | undefined;
  readonly damage: readonly ItemDamage[] | undefined;
  readonly armor: number | undefined;
  readonly resistances: Readonly<Record<string, number>> | undefined;
  readonly speedMs: number | undefined;
  readonly spells: readonly ItemSpell[] | undefined;
  readonly bonding: number | undefined;
  readonly description: string | undefined;
  readonly startQuest: number | undefined;
  /** PageText id of the first page when the item can be read (a book, a letter); undefined otherwise. */
  readonly pageText: number | undefined;
  readonly block: number | undefined;
  readonly maxDurability: number | undefined;
}

/**
 * One line of the character's skill pane, folded from the
 * `PLAYER_SKILL_INFO` update fields. `value`/`max` are the pane's "150/225";
 * `tempBonus`/`permBonus` the green modifier. `name` is the client's
 * SkillLine.dbc text (`undefined` when the module could not read it).
 */
export interface SkillLine {
  readonly skillId: number;
  readonly name: string | undefined;
  readonly value: number;
  readonly max: number;
  readonly tempBonus: number;
  readonly permBonus: number;
  readonly step: number;
  readonly seq: number;
  readonly ts: number;
}

/** The eight reputation ranks, as the client labels them. */
export type ReputationRank = "Hated" | "Hostile" | "Unfriendly" | "Neutral" | "Friendly" | "Honored" | "Revered" | "Exalted";

/**
 * The client's rank for a reputation value (`base + standing`): the fixed
 * 3.3.5 thresholds -42000/-6000/-3000/0/3000/9000/21000/42000.
 */
export function reputationRank(reputation: number): ReputationRank {
  if (reputation >= 42000) return "Exalted";
  if (reputation >= 21000) return "Revered";
  if (reputation >= 9000) return "Honored";
  if (reputation >= 3000) return "Friendly";
  if (reputation >= 0) return "Neutral";
  if (reputation >= -3000) return "Unfriendly";
  if (reputation >= -6000) return "Hostile";
  return "Hated";
}

/**
 * One faction of the reputation pane: the fold of the login list
 * (`SMSG_INITIALIZE_FACTIONS`) and every change since
 * (`SMSG_SET_FACTION_STANDING`). `standing` is the wire's value, `base` the
 * client's Faction.dbc base for this race/class, `reputation` their sum and
 * `rank` its bucket. `visible` follows the login flags and
 * `SMSG_SET_FACTION_VISIBLE`; the pane shows visible factions only.
 */
export interface ReputationEntry {
  readonly repListId: number;
  readonly factionId: number | undefined;
  readonly name: string | undefined;
  readonly standing: number;
  readonly base: number | undefined;
  readonly reputation: number;
  readonly rank: ReputationRank;
  readonly visible: boolean;
  readonly atWar: boolean;
  readonly seq: number;
  readonly ts: number;
}


// ------------------------------------------------------------------------- talents

/** One talent of the class tree, with the ranks this character has taken merged in from the last `SMSG_TALENTS_INFO`. */
export interface TalentTreeTalent {
  readonly talentId: number;
  readonly name: string | undefined;
  /** 0-based tier (each tier needs 5 points in the tab below it). */
  readonly row: number;
  readonly col: number;
  readonly maxRank: number;
  /** The rank spells, first to last. */
  readonly ranks: readonly number[];
  /** Points spent here, 0..maxRank (the wire's 0-based rank + 1). */
  readonly pointsSpent: number;
  readonly dependsOn: number | undefined;
  /** 0-based, as on the wire: the prerequisite must hold rank `dependsOnRank + 1`. */
  readonly dependsOnRank: number | undefined;
}

export interface TalentTreeTab {
  readonly tabId: number;
  readonly name: string | undefined;
  readonly page: number;
  readonly talents: readonly TalentTreeTalent[];
  /** Points spent in this tab. */
  readonly pointsSpent: number;
}

/**
 * The class talent frame: the last `WB_TALENT_TREE` (the answer to
 * `queryTalentTree`) with the learned ranks from the last `SMSG_TALENTS_INFO`
 * merged in at read time. `unspentPoints` follows the talents packet when
 * one has arrived since.
 */
export interface TalentTree {
  readonly class: number;
  readonly unspentPoints: number;
  readonly tabs: readonly TalentTreeTab[];
  readonly seq: number;
  readonly ts: number;
}

/**
 * One visible aura slot on a unit. A cleared slot is not an entry: the module
 * sends `removed: true` for it and the cache drops the slot instead of keeping
 * a zero-spell ghost.
 */
export interface AuraEntry {
  readonly slot: number;
  readonly spellId: number;
  readonly flags: number | undefined;
  readonly level: number | undefined;
  readonly stacks: number | undefined;
  readonly casterGuid: GuidKey | undefined;
  /** Total length in ms, when the aura shows a timer (`flags & 0x20`). */
  readonly maxDuration: number | undefined;
  /** What was left of it in ms when the packet was sent, at `ts`. */
  readonly duration: number | undefined;
  /**
   * When it runs out, epoch ms: `ts + duration`, the timer a client's buff
   * frame counts down from the same packet (the server sends no update as
   * it ticks, so `duration` alone stays what it was at `ts`). Undefined for
   * an aura that shows no timer.
   */
  readonly expiresAt: number | undefined;
  /** The aura's spell name (Spell.dbc, as the buff frame shows it); undefined when the module served none. `aurasOf` falls back to the spellbook's. */
  readonly name: string | undefined;
  readonly seq: number;
  readonly ts: number;
}

/** What a creature query answered about one creature entry. */
/**
 * One spell in the character's spellbook, from `SMSG_INITIAL_SPELLS` /
 * `SMSG_LEARNED_SPELL`. `rank` and `name` are the client's Spell.dbc view of
 * the id; `undefined` when the module could not resolve it.
 */
export interface KnownSpell {
  readonly spellId: number;
  readonly rank: number | undefined;
  readonly name: string | undefined;
  readonly seq: number;
  readonly ts: number;
}

/**
 * A cooldown the server announced. `readyAt` is epoch ms, computed from the
 * event's timestamp plus the announced duration; `Infinity` for the server's
 * "infinite" marker. It is `undefined` after a bare `SMSG_COOLDOWN_EVENT`,
 * which tells a client to start a timer whose length it reads from its own
 * Spell.dbc — the SDK has no such table, so the spell is known to be on
 * cooldown but not for how long (it clears on `SMSG_CLEAR_COOLDOWN` or the
 * next announcement for that spell).
 */
export interface SpellCooldown {
  readonly spellId: number;
  readonly readyAt: number | undefined;
  readonly cooldownMs: number | undefined;
  readonly seq: number;
  readonly ts: number;
}

/** One glyph slot (`TalentState.glyphs`). */
export interface GlyphSlot {
  readonly slot: number;
  readonly glyphId: number;
  readonly spellId: number | undefined;
  readonly name: string | undefined;
}

export interface TalentEntry {
  readonly talentId: number;
  /** 0-based, as on the wire: 0 means one point spent. */
  readonly rank: number;
}

/** The player's talent state from the last `SMSG_TALENTS_INFO`. */
export interface TalentState {
  readonly unspentPoints: number;
  readonly activeSpec: number;
  readonly specCount: number;
  /** Talents of the active spec. */
  readonly talents: readonly TalentEntry[];
  /**
   * The active spec's glyph slots, slot = index (what `useItem`'s
   * `glyphSlot` names): `glyphId` is the `GlyphProperties.dbc` id, 0 for an
   * empty slot, with the glyph's spell and name. Empty from a module older
   * than the field.
   */
  readonly glyphs: readonly GlyphSlot[];
  readonly seq: number;
  readonly ts: number;
}

export interface CreatureInfo {
  readonly entry: number;
  readonly name: string;
  readonly subname: string | undefined;
  readonly type: number | undefined;
  /** The core's `CreatureEliteType` value; `creatureRankName` names it. */
  readonly rank: number | undefined;
}

/**
 * The core's `CreatureEliteType` enum (SharedDefines.h, 3.3.5a), by value: the
 * classification a client draws as the portrait's dragon. A value outside the
 * enum reads as `unknown`.
 */
export const CREATURE_RANK_NAMES = ["normal", "elite", "rareelite", "worldboss", "rare"] as const;
export type CreatureRankName = (typeof CREATURE_RANK_NAMES)[number] | "unknown";

export function creatureRankName(rank: number): CreatureRankName {
  return CREATURE_RANK_NAMES[rank] ?? "unknown";
}

/** A game object template as `SMSG_GAMEOBJECT_QUERY_RESPONSE` describes it. */
export interface GameObjectInfo {
  readonly entry: number;
  readonly name: string;
  /** The core's `GameobjectTypes` value; `gameObjectTypeName` names it. */
  readonly type: number | undefined;
  readonly displayId: number | undefined;
  readonly castBarCaption: string | undefined;
}

/**
 * The core's `GameobjectTypes` enum (SharedDefines.h, 3.3.5a), by value. A
 * value outside the enum reads as `unknown`.
 */
export const GAME_OBJECT_TYPE_NAMES = [
  "door",
  "button",
  "questgiver",
  "chest",
  "binder",
  "generic",
  "trap",
  "chair",
  "spell_focus",
  "text",
  "goober",
  "transport",
  "areadamage",
  "camera",
  "map_object",
  "mo_transport",
  "duel_arbiter",
  "fishingnode",
  "summoning_ritual",
  "mailbox",
  "do_not_use",
  "guardpost",
  "spellcaster",
  "meetingstone",
  "flagstand",
  "fishinghole",
  "flagdrop",
  "mini_game",
  "do_not_use_2",
  "capture_point",
  "aura_generator",
  "dungeon_difficulty",
  "barber_chair",
  "destructible_building",
  "guild_bank",
  "trapdoor",
] as const;
export type GameObjectTypeName = (typeof GAME_OBJECT_TYPE_NAMES)[number] | "unknown";

export function gameObjectTypeName(type: number): GameObjectTypeName {
  return GAME_OBJECT_TYPE_NAMES[type] ?? "unknown";
}

/**
 * What a client animates for a transport it has been sent: the car's clock
 * on its `TransportAnimation.dbc` period and whether the segment under that
 * clock has no displacement (the car is dwelling at a platform). Folded from
 * `WB_TRANSPORT_PROGRESS`, which the module sends only while the car is
 * within the map's visibility range of the character or carrying it; the
 * position itself goes on `position`.
 */
export interface TransportState {
  readonly progressMs: number;
  readonly periodMs: number | undefined;
  /** Undefined once the car has left the range: it would be stale. */
  readonly docked: boolean | undefined;
  /**
   * `true` while the module reports the car every second, `false` after its
   * last report as it left the range (position and clock are then where it
   * was leaving), undefined for a car known only from its create block.
   */
  readonly inRange: boolean | undefined;
  /**
   * Every point this car has been observed dwelling at (`docked: true`),
   * deduplicated within 5y: where it stops, as far as this session has seen
   * it. A car accrues the platforms it docks at in range: the near one for a
   * character waiting there, both ends over a round trip aboard.
   */
  readonly docks: readonly Point3[];
}

/** One selectable row of an open gossip menu, as `gossipSelect` resolves against. */
export interface GossipMenuOption {
  readonly optionId: number;
  readonly text: string;
}

/**
 * The gossip menu last observed open for one NPC: the fold of the last
 * `SMSG_GOSSIP_MESSAGE` for that guid with no `SMSG_GOSSIP_COMPLETE` after it.
 * Flat and JSON-safe. `menuId` is what a `gossip_select` must echo back, and
 * `options` is what `gossipSelect(guid, "text")` matches text against.
 */
export interface GossipMenu {
  readonly guid: GuidKey;
  readonly menuId: number;
  readonly options: readonly GossipMenuOption[];
  readonly seq: number;
  readonly ts: number;
}

/**
 * A vendor's stock, as `SMSG_LIST_INVENTORY` last carried it for one NPC.
 *
 * The rows are the packet's own — `slot` is the 1-based number `buyItem` takes,
 * `price` is already the discounted copper the client shows, and
 * `leftInStock` -1 means unlimited. Nothing is derived here: whether an item is
 * affordable, or an upgrade, is the caller's read over `state.money` and the
 * item template.
 *
 * "Last observed", not "open": no packet closes a vendor frame, so this is the
 * last list this session saw for that guid and `seq`/`ts` are how stale it is.
 */
export interface VendorWindow {
  readonly guid: GuidKey;
  readonly items: readonly VendorItem[];
  /** The server's reason for an empty list, when it gave one. */
  readonly emptyReason: number | undefined;
  readonly seq: number;
  readonly ts: number;
}

/**
 * What a trainer teaches, as `SMSG_TRAINER_LIST` last carried it for one NPC.
 *
 * Raw rows, exactly as `trainerList` receives them (`state` 0 available,
 * 1 unavailable, 2 known); `learnable` and `affordable` are `trainerList`'s
 * derivations and stay there. "Last observed", like the vendor window.
 */
export interface TrainerWindow {
  readonly guid: GuidKey;
  /** 0 class, 1 mount, 2 tradeskill, 3 pet — the server's own classification. */
  readonly trainerType: number;
  readonly spells: readonly TrainerSpellData[];
  readonly greeting: string | undefined;
  readonly seq: number;
  readonly ts: number;
}

/**
 * The open loot window, as `SMSG_LOOT_RESPONSE` opened it and the loot packets
 * since have changed it: a taken slot leaves `items` (`SMSG_LOOT_REMOVED`),
 * taken gold zeroes `gold` (`SMSG_LOOT_CLEAR_MONEY`), and
 * `SMSG_LOOT_RELEASE_RESPONSE` for this guid closes it. One at a time, because
 * a client has one loot frame.
 */
export interface LootWindow {
  /** The corpse or object being looted. */
  readonly guid: GuidKey;
  readonly lootType: number;
  readonly gold: number;
  readonly items: readonly LootItemData[];
  readonly seq: number;
  readonly ts: number;
}

/**
 * A world object the update stream has put in view: created by a `create`
 * block, refreshed by `values`/`movement` blocks and `MSG_MOVE_*`, removed by
 * an `outOfRange` list or `SMSG_DESTROY_OBJECT`.
 */
export interface NearbyObject extends UnitFieldsState {
  readonly guid: GuidKey;
  /** `unit`, `player`, `gameObject`, … Only a `create` block carries it. */
  objectType: Observed<string> | undefined;
  /** Creature/gameobject template id, from `OBJECT_FIELD_ENTRY`. */
  entry: Observed<number> | undefined;
  /** Joined from a name query (players) or a creature query (units). Never guessed. */
  name: Observed<string> | undefined;
  position: Observed<UnitPosition> | undefined;
  /** From `SMSG_MONSTER_MOVE`: creatures move by spline, not by `MSG_MOVE_*`. */
  motion: Observed<Motion> | undefined;
  targetGuid: Observed<GuidKey> | undefined;
  /**
   * The master of a summoned or created unit (`UNIT_FIELD_SUMMONEDBY`, else
   * `UNIT_FIELD_CREATEDBY`): a pet's owner, a totem's shaman. On a corpse,
   * the player it belongs to (`CORPSE_FIELD_OWNER`, bones included). `"0"`
   * reads as undefined.
   */
  ownerGuid: Observed<GuidKey> | undefined;
  /** Who mind-controls this unit (`UNIT_FIELD_CHARMEDBY`), when observed. */
  charmedByGuid: Observed<GuidKey> | undefined;
  /**
   * Transports only: the animation clock and `docked`, from the create block's
   * `pathProgress` and then every `WB_TRANSPORT_PROGRESS`. Undefined for
   * everything else and for a transport the module has not yet reported on.
   */
  transport: Observed<TransportState> | undefined;
  /**
   * The questgiver marker the client draws over this object (`!`/`?`/grey),
   * from `SMSG_QUESTGIVER_STATUS` / `_MULTIPLE`. The wire `DIALOG_STATUS_*`
   * u8; `questGiverStatusName` names it.
   */
  questGiver: Observed<number> | undefined;
  /**
   * The string update fields the module serves beside an id as client-cache
   * knowledge (an item's `suffixName`, each `enchant<n>Text`); `fields`
   * holds numbers only. Empty on everything but items.
   */
  texts: Map<string, Observed<string>>;
  /** Seq of the event that first put this object in view. */
  firstSeq: number;
  /** Seq of the most recent event that touched this object. */
  lastSeq: number;
}

/**
 * One object as `units()` reports it: flat, plain, JSON-safe — no `Observed`
 * wrappers and no `Map`s, so `console.log`/`JSON.stringify` show the whole
 * thing and a property access reaches a value rather than a wrapper.
 *
 * Every field is `undefined` until an event carried it (docs/CONTRACTS.md rule
 * 1). `undefined` means unobserved, never zero and never a guess.
 */
export interface UnitView {
  /** Opaque decimal-string guid. */
  readonly guid: GuidKey;
  /** Creature/gameobject template id, from `OBJECT_FIELD_ENTRY`. */
  readonly entry: number | undefined;
  /** Joined from a creature or name query. Never guessed. */
  readonly name: string | undefined;
  /** `unit`, `player`, `gameObject`, … Only a `create` block carries it. */
  readonly type: string | undefined;
  readonly level: number | undefined;
  readonly health: number | undefined;
  readonly maxHealth: number | undefined;
  /**
   * `true` when health was observed *and* is 0, and on every `corpse` (a
   * player's body, which is dead by what it is). Unobserved stays
   * undefined, and so does anything with no health to observe (a game object,
   * a spell's ground effect).
   */
  readonly dead: boolean | undefined;
  /** Straight-line yards from our own last observed position. */
  readonly distance: number | undefined;
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly z: number | undefined;
  /** What it is targeting, when observed. `"0"` (no target) reads as undefined. */
  readonly targetGuid: GuidKey | undefined;
  /** Its master, for a pet, totem or other summon (`UNIT_FIELD_SUMMONEDBY` / `CREATEDBY`); a corpse's player (`CORPSE_FIELD_OWNER`); undefined otherwise. */
  readonly ownerGuid: GuidKey | undefined;
  /**
   * Creatures only: `normal`, `elite`, `rareelite`, `worldboss` or `rare`, from
   * the creature query's answer (`SMSG_CREATURE_QUERY_RESPONSE`) — what the
   * client draws as the elite dragon round the portrait. Undefined for players
   * and game objects, and until the query has answered.
   */
  readonly rank: CreatureRankName | undefined;
  /**
   * The questgiver marker the client shows over this object, named:
   * `available` (`!`), `reward` (`?` — a quest it ends is ready to turn in),
   * `incomplete` (grey `?` — it ends a quest in the log that is not done),
   * `none`, `unavailable`, and the rep/low-level variants. `undefined` until
   * a status packet named this guid; `none` is the server saying it has
   * nothing for you, which is an observation.
   */
  readonly questGiver: QuestGiverStatusName | undefined;
  /** The raw `DIALOG_STATUS_*` byte behind `questGiver`. */
  readonly questGiverStatus: number | undefined;
  /**
   * What this NPC is for, decoded from its `UNIT_NPC_FLAGS` (the bits a client
   * uses to pick the cursor and the interaction window): `questGiver`,
   * `vendor`, `trainer`, `flightMaster`, `innkeeper`, … Role words only, no
   * recommendation. Empty for players, game objects and creatures with no
   * flags; empty (not undefined) when the flags were never observed.
   */
  readonly roles: readonly NpcRole[];
  /**
   * Game objects only: what kind of object this is, named from the core's
   * `GameobjectTypes` (`door`, `chest`, `mailbox`, `transport`, …). From the
   * object's own `GAMEOBJECT_BYTES_1` or its template answer; undefined for
   * units and players, and for a game object neither has described yet.
   */
  readonly goType: GameObjectTypeName | undefined;
  /**
   * Transports only: `true` while the car is dwelling at a platform, `false`
   * while it is between ends — from the same `TransportAnimation.dbc` clock a
   * client animates the car with (`WB_TRANSPORT_PROGRESS`). Undefined for
   * everything that is not a transport, until the first report, and while
   * the car is out of the map's visibility range of the character.
   */
  readonly docked: boolean | undefined;
  /**
   * Units and players: how this unit regards you, as a client colours its
   * name — `hostile` (red), `neutral` (yellow) or `friendly` (green). The
   * client's own reading (`unitReaction`): the unit's FactionTemplate.dbc row,
   * which the module serves beside its `faction`, against yours, and, for a
   * faction that keeps a reputation, your standing with it (capped at
   * neutral while at war). Your own pets and summons, and party members and
   * theirs, are friendly. Undefined for game objects, and until both rows
   * (and, for a reputation faction, the reputation pane) have arrived.
   * Not modelled: a duel opponent, free-for-all PvP areas and the
   * quest-scripted forced reactions (`SMSG_SET_FORCED_REACTIONS` is not
   * tapped).
   */
  readonly reaction: UnitReaction | undefined;
  /**
   * Units and players, from `UNIT_FIELD_FLAGS`: the client's own readings of
   * the unit's state. `inCombat` is `UNIT_FLAG_IN_COMBAT`, `stunned`
   * `UNIT_FLAG_STUNNED`, `skinnable` `UNIT_FLAG_SKINNABLE` (a corpse that
   * can be skinned). Each is undefined until a block carried the field, and
   * for game objects and corpses.
   */
  readonly inCombat: boolean | undefined;
  readonly stunned: boolean | undefined;
  readonly skinnable: boolean | undefined;
  /**
   * Units and players, from `UNIT_DYNAMIC_FLAGS`, which the server rewrites for each
   * receiver (`Unit::BuildValuesUpdate`): `lootable` is `UNIT_DYNFLAG_LOOTABLE`,
   * already cleared for a character not allowed to loot the corpse; `tapped`
   * is `UNIT_DYNFLAG_TAPPED`, the unit has a loot recipient (someone has
   * tagged it); `tappedByYou` is `UNIT_DYNFLAG_TAPPED_BY_PLAYER`, that
   * recipient is you or your group. Tapped by someone else is `tapped` with
   * `tappedByYou` false. Each is undefined until a block carried the
   * field, and for game objects and corpses.
   */
  readonly lootable: boolean | undefined;
  readonly tapped: boolean | undefined;
  readonly tappedByYou: boolean | undefined;
  /**
   * Units and players: whether the client draws them seated (stand state, byte
   * 0 of `UNIT_FIELD_BYTES_1`, sit or any chair), and the shapeshift form's
   * name (byte 3 of `UNIT_FIELD_BYTES_2`: "cat", "bear", "ghostWolf", …).
   * `sitting` is undefined until a block carried its field; `shapeshiftForm`
   * is undefined also when the unit is in no form.
   */
  readonly sitting: boolean | undefined;
  readonly shapeshiftForm: string | undefined;
}

/** How a unit regards this character (`UnitView.reaction`). */
export type UnitReaction = "hostile" | "neutral" | "friendly";

/**
 * One FactionTemplate.dbc row, as the module serves it beside a unit's
 * `faction` (`factionRow*` update fields): the Faction.dbc faction it belongs
 * to, its flags, its own faction-group mask and the groups it befriends and
 * fights, its explicit enemy and friend factions, and the faction's
 * reputation index (-1 when it keeps none).
 */
export interface FactionTemplateRow {
  readonly faction: number;
  readonly flags: number;
  readonly group: number;
  readonly friendGroup: number;
  readonly enemyGroup: number;
  readonly enemies: readonly number[];
  readonly friends: readonly number[];
  readonly repIndex: number;
  /**
   * For a faction that keeps a reputation: its Faction.dbc base table, four
   * `{ raceMask, classMask, value }` entries, which give the standing of a
   * faction the reputation pane does not list. Empty otherwise.
   */
  readonly base: readonly { readonly raceMask: number; readonly classMask: number; readonly value: number }[];
}

/** `FACTION_TEMPLATE_FLAG_ATTACK_PVP_ACTIVE_PLAYERS`: contested guards, hostile to a PvP-flagged character. */
const FACTION_TEMPLATE_ATTACK_PVP_ACTIVE = 0x1000;
/** `FACTION_TEMPLATE_FLAG_HATES_ALL_EXCEPT_FRIENDS`. */
const FACTION_TEMPLATE_HATES_ALL_EXCEPT_FRIENDS = 0x2000;
/** `PLAYER_FLAGS_CONTESTED_PVP`: this character fought in PvP lately; contested guards attack it. */
const PLAYER_FLAGS_CONTESTED_PVP = 0x0000_0100;
/** `UNIT_FLAG_PLAYER_CONTROLLED`: a player, or a unit a player controls. */
const UNIT_FLAG_PLAYER_CONTROLLED = 0x0000_0008;
/** The ranks in order, Hated 0 .. Exalted 7, as the core numbers `ReputationRank`. */
const REPUTATION_RANK_ORDER: readonly ReputationRank[] = [
  "Hated", "Hostile", "Unfriendly", "Neutral", "Friendly", "Honored", "Revered", "Exalted",
];

/** A unit's served FactionTemplate row, when it is the row of the template it carries now. */
function factionTemplateRowOf(fields: ReadonlyMap<string, Observed<number>>): FactionTemplateRow | undefined {
  const id = fields.get("faction")?.value;
  if (id === undefined || fields.get("factionRow")?.value !== id) return undefined;
  const n = (key: string): number => fields.get(key)?.value ?? 0;
  return {
    faction: n("factionRowFaction"),
    flags: n("factionRowFlags"),
    group: n("factionRowGroup"),
    friendGroup: n("factionRowFriendGroup"),
    enemyGroup: n("factionRowEnemyGroup"),
    enemies: [0, 1, 2, 3].map((i) => n(`factionRowEnemy${i}`)),
    friends: [0, 1, 2, 3].map((i) => n(`factionRowFriend${i}`)),
    repIndex: fields.get("factionRowRepIndex")?.value ?? -1,
    base: fields.has("factionRowBaseRep0")
      ? [0, 1, 2, 3].map((i) => ({
          raceMask: n(`factionRowBaseRace${i}`),
          classMask: n(`factionRowBaseClass${i}`),
          value: n(`factionRowBaseRep${i}`),
        }))
      : [],
  };
}

/**
 * A faction's base reputation for a race and class, read off its Faction.dbc
 * table the way the client (and the core's `ReputationMgr::GetBaseReputation`)
 * does: the first entry whose race mask takes the race (or that names only
 * classes) and whose class mask takes the class (or is empty); 0 when none.
 */
export function baseReputation(row: FactionTemplateRow, race: number, cls: number): number {
  const raceMask = race > 0 ? 2 ** (race - 1) : 0;
  const classMask = cls > 0 ? 2 ** (cls - 1) : 0;
  for (const b of row.base) {
    const raceOk = (b.raceMask & raceMask) !== 0 || (b.raceMask === 0 && b.classMask !== 0);
    const classOk = (b.classMask & classMask) !== 0 || b.classMask === 0;
    if (raceOk && classOk) return b.value;
  }
  return 0;
}

/** `FactionTemplateEntry::IsFriendlyTo`: the explicit lists first, then the group masks both ways. */
function templateFriendlyTo(a: FactionTemplateRow, b: FactionTemplateRow): boolean {
  if (a.faction === b.faction) return true;
  if (b.faction !== 0) {
    if (a.enemies.includes(b.faction)) return false;
    if (a.friends.includes(b.faction)) return true;
  }
  return (a.friendGroup & b.group) !== 0 || (a.group & b.friendGroup) !== 0;
}

/** `FactionTemplateEntry::IsHostileTo`: the explicit lists first, then the enemy-group mask. */
function templateHostileTo(a: FactionTemplateRow, b: FactionTemplateRow): boolean {
  if (b.faction !== 0) {
    if (a.enemies.includes(b.faction)) return true;
    if (a.friends.includes(b.faction)) return false;
  }
  return (a.enemyGroup & b.group) !== 0;
}

/**
 * How a unit with template row `unit` regards a character with template row
 * `self` — the reading a 3.3.5a client makes from its FactionTemplate.dbc and
 * its own reputation, the same arithmetic as the core's
 * `Unit::GetFactionReactionTo`. A faction that keeps a reputation answers by
 * the character's standing with it (`standing`, capped at neutral while at
 * war; the pane's row for it, or, for a faction the pane does not list, the
 * row's base reputation for the character's race and class, never at war —
 * `undefined` when neither is known, which leaves the reaction unknown); any
 * other by the template relations. Ranks bin as the core's
 * `IsHostileTo`/`IsFriendlyTo` do: Hostile and below hostile, Friendly and
 * above friendly, Unfriendly and Neutral neutral.
 */
export function unitReaction(
  unit: FactionTemplateRow,
  self: FactionTemplateRow,
  options: {
    readonly contestedPvp: boolean;
    readonly standing: (unit: FactionTemplateRow) => { readonly rank: ReputationRank; readonly atWar: boolean } | undefined;
  },
): UnitReaction | undefined {
  if ((unit.flags & FACTION_TEMPLATE_ATTACK_PVP_ACTIVE) !== 0 && options.contestedPvp) return "hostile";
  if (unit.repIndex >= 0) {
    const st = options.standing(unit);
    if (st === undefined) return undefined;
    let rank = REPUTATION_RANK_ORDER.indexOf(st.rank);
    if (st.atWar) rank = Math.min(rank, REPUTATION_RANK_ORDER.indexOf("Neutral"));
    if (rank <= REPUTATION_RANK_ORDER.indexOf("Hostile")) return "hostile";
    if (rank >= REPUTATION_RANK_ORDER.indexOf("Friendly")) return "friendly";
    return "neutral";
  }
  if (templateHostileTo(unit, self)) return "hostile";
  if (templateFriendlyTo(unit, self) || templateFriendlyTo(self, unit)) return "friendly";
  if ((unit.flags & FACTION_TEMPLATE_HATES_ALL_EXCEPT_FRIENDS) !== 0) return "hostile";
  return "neutral";
}

/**
 * `UNIT_NPC_FLAGS` bits, 3.3.5a (`UnitDefines.h` NPCFlags), as role words.
 * Sub-kinds (`classTrainer`, `foodVendor`) come alongside their parent
 * (`trainer`, `vendor`) when the server sets both bits, which it does.
 */
export const NPC_ROLES = [
  "gossip",
  "questGiver",
  "trainer",
  "classTrainer",
  "professionTrainer",
  "vendor",
  "ammoVendor",
  "foodVendor",
  "poisonVendor",
  "reagentVendor",
  "repair",
  "flightMaster",
  "spiritHealer",
  "spiritGuide",
  "innkeeper",
  "banker",
  "petitioner",
  "tabardDesigner",
  "battlemaster",
  "auctioneer",
  "stableMaster",
  "guildBanker",
  "spellClick",
  "playerVehicle",
  "mailbox",
] as const;
export type NpcRole = (typeof NPC_ROLES)[number];

const NPC_ROLE_BITS: readonly (readonly [number, NpcRole])[] = [
  [0x00000001, "gossip"],
  [0x00000002, "questGiver"],
  [0x00000010, "trainer"],
  [0x00000020, "classTrainer"],
  [0x00000040, "professionTrainer"],
  [0x00000080, "vendor"],
  [0x00000100, "ammoVendor"],
  [0x00000200, "foodVendor"],
  [0x00000400, "poisonVendor"],
  [0x00000800, "reagentVendor"],
  [0x00001000, "repair"],
  [0x00002000, "flightMaster"],
  [0x00004000, "spiritHealer"],
  [0x00008000, "spiritGuide"],
  [0x00010000, "innkeeper"],
  [0x00020000, "banker"],
  [0x00040000, "petitioner"],
  [0x00080000, "tabardDesigner"],
  [0x00100000, "battlemaster"],
  [0x00200000, "auctioneer"],
  [0x00400000, "stableMaster"],
  [0x00800000, "guildBanker"],
  [0x01000000, "spellClick"],
  [0x02000000, "playerVehicle"],
  [0x04000000, "mailbox"],
];

/** Decode a `UNIT_NPC_FLAGS` value into role words, in bit order. */
export function npcRolesOf(npcFlags: number | undefined): NpcRole[] {
  if (npcFlags === undefined || npcFlags === 0) return [];
  const out: NpcRole[] = [];
  for (const [bit, role] of NPC_ROLE_BITS) if ((npcFlags & bit) !== 0) out.push(role);
  return out;
}

/** The `DIALOG_STATUS_*` names, 3.3.5a. `unknown` covers any byte outside 0-10. */
export type QuestGiverStatusName =
  | "none"
  | "unavailable"
  | "low_level_available"
  | "low_level_reward_rep"
  | "low_level_available_rep"
  | "incomplete"
  | "reward_rep"
  | "available_rep"
  | "available"
  | "reward2"
  | "reward"
  | "unknown";

const QUEST_GIVER_STATUS_NAMES: readonly QuestGiverStatusName[] = [
  "none",
  "unavailable",
  "low_level_available",
  "low_level_reward_rep",
  "low_level_available_rep",
  "incomplete",
  "reward_rep",
  "available_rep",
  "available",
  "reward2",
  "reward",
];

/** Name a wire `DIALOG_STATUS_*` byte. */
export function questGiverStatusName(status: number): QuestGiverStatusName {
  return QUEST_GIVER_STATUS_NAMES[status] ?? "unknown";
}

/**
 * Whether a self field is one the server computes a questgiver marker from: a
 * quest-log slot's quest or its state, or our own level. A marker older than
 * the latest of these may be about to change (the client's marker pre-checks
 * read it that way), and the login re-dates them for the same reason.
 */
export function isQuestGiverMarkerInput(key: string): boolean {
  return key === "level" || /^quest\d+(Id|State)$/.test(key);
}

/**
 * Criteria for `units()`. All present criteria are AND-ed; an absent one does
 * not filter. Anything else is rejected loudly.
 */
export interface UnitFilter {
  /** One template id or a list of them. */
  entry?: number | number[];
  /**
   * Match the joined name, case-insensitively. Unnamed objects never match.
   *
   * A plain string matches as a substring, but the results are then ordered by
   * how well each name fits the query — exact equal first, then whole-word
   * match, then any other substring — and, within a tier, by shortest name and
   * then nearest. So `{ name: "tree" }` returns a unit named `"tree"` ahead of
   * `"tree stump"`, even if the stump is closer. A `RegExp`, or a string that
   * looks like a regex literal (`"/^tree$/i"`), is matched with `RegExp.test`
   * and the results stay in nearest-first order.
   */
  name?: string | RegExp;
  type?: "unit" | "player" | "gameObject" | "corpse";
  /**
   * `true` keeps units and players whose health was observed above 0; `false`
   * those whose health was observed at 0. Anything whose health is
   * unobserved, or that has none, passes neither; a player's corpse is
   * `type: "corpse"`.
   */
  alive?: boolean;
  /** Yards. Objects with no known distance are dropped: the criterion cannot be evaluated. */
  maxDistance?: number;
  /** `npcFlags > 0` — a gossip/vendor/questgiver NPC, as observed. */
  npc?: boolean;
  /**
   * Keep only NPCs whose observed `roles` include this word (or any of a
   * list), e.g. `{ role: "flightMaster" }`, `{ role: ["vendor", "repair"] }`.
   */
  role?: NpcRole | NpcRole[];
  /**
   * The observed questgiver marker, by name or a list of names — e.g.
   * `{ questGiver: "reward" }` for every NPC ready to take a turn-in, or
   * `{ questGiver: ["available", "available_rep"] }`. Objects with no observed
   * status never match.
   *
   * `true` is shorthand for "has any marker at all": every observed status
   * except `"none"`, which is the server saying this NPC has nothing for you.
   * `false` is rejected — "no marker" and "never observed" are two readings.
   */
  questGiver?: QuestGiverStatusName | QuestGiverStatusName[] | true;
}

/**
 * Something the stream said that the cache could not reconcile. Recorded rather
 * than resolved: silently picking a winner would make the cache disagree with
 * the trajectory log.
 */
export interface Anomaly {
  readonly seq: number;
  readonly ts: number;
  readonly kind: "self_guid_mismatch" | "self_position_without_map" | (string & {});
  readonly detail: string;
}

/** A hole in the stream the cache knows it did not see. */
export interface GapRecord {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly missing: number;
  readonly ts: number;
}

export interface StateSeed {
  /** Opaque decimal-string guid, as `POST /session` returned it. */
  guid?: GuidKey;
  name?: string;
}

export interface StateCacheOptions {
  /** How many chat lines to retain. Default 200. */
  chatTail?: number;
  /** How many notifications to retain. Default 50. */
  notificationTail?: number;
  seed?: StateSeed;
}

/** Immutable view handed to callers by `snapshot()`. */
export interface StateSnapshot {
  readonly self: SelfState;
  readonly characters: Observed<CharacterSummary[]> | undefined;
  readonly names: ReadonlyMap<GuidKey, Observed<string>>;
  readonly creatures: ReadonlyMap<number, Observed<CreatureInfo>>;
  readonly items: ReadonlyMap<number, Observed<ItemInfo>>;
  readonly nearby: ReadonlyMap<GuidKey, NearbyObject>;
  readonly auras: ReadonlyMap<GuidKey, readonly AuraEntry[]>;
  readonly questLog: readonly QuestLogEntry[];
  readonly questCompletions: readonly QuestCompletion[];
  readonly quests: ReadonlyMap<number, Observed<QuestInfo>>;
  readonly inventory: readonly InventoryItem[];
  readonly money: Observed<number> | undefined;
  readonly xp: Observed<number> | undefined;
  readonly nextLevelXp: Observed<number> | undefined;
  readonly chat: readonly ChatEntry[];
  readonly notifications: readonly NotificationEntry[];
  readonly motd: Observed<string[]> | undefined;
  readonly gaps: readonly GapRecord[];
  readonly anomalies: readonly Anomaly[];
  /** guid -> the gossip menu last observed open for that NPC (none after a close). */
  readonly gossip: ReadonlyMap<GuidKey, GossipMenu>;
  /** guid -> the flight master window last observed for that NPC. */
  readonly taxiWindows: ReadonlyMap<GuidKey, TaxiWindow>;
  /** guid -> the stock list last observed for that vendor. */
  readonly vendorWindows: ReadonlyMap<GuidKey, VendorWindow>;
  /** guid -> the teaching list last observed for that trainer. */
  readonly trainerWindows: ReadonlyMap<GuidKey, TrainerWindow>;
  /** The open loot window, or undefined when none is open. */
  readonly lootWindow: LootWindow | undefined;
  readonly spells: readonly KnownSpell[];
  readonly cooldowns: readonly SpellCooldown[];
  readonly talents: TalentState | undefined;
  readonly talentTree: TalentTree | undefined;
  readonly skills: readonly SkillLine[];
  readonly reputation: readonly ReputationEntry[];
  readonly pet: PetState | undefined;
  readonly group: GroupState | undefined;
  readonly mailbox: MailboxState | undefined;
  readonly bank: BankContents;
  readonly buyback: readonly BuybackItem[];
  readonly trade: TradeState | undefined;
  readonly lastSeq: number;
  readonly eventCount: number;
}

export class StateCache {
  readonly self: SelfState = {
    guid: undefined,
    name: undefined,
    level: undefined,
    position: undefined,
    zone: undefined,
    area: undefined,
    map: undefined,
    portals: undefined,
    corpse: undefined,
    graveyard: undefined,
    reclaimDelay: undefined,
    transfer: undefined,
    targetGuid: undefined,
    achievements: undefined,
    taxiFlight: undefined,
    taxiEta: undefined,
    resting: undefined,
    casting: undefined,
    ghost: undefined,
    inCombat: undefined,
    stunned: undefined,
    mounted: undefined,
    channeling: undefined,
    comboPoints: undefined,
    runes: undefined,
    totems: [],
    mirrorTimers: [],
    proficiency: undefined,
    standState: undefined,
    sitting: undefined,
    shapeshiftForm: undefined,
    stats: undefined,
    restedXp: undefined,
    control: undefined,
    vehicle: undefined,
    taxiReply: undefined,
    bindPoint: undefined,
    health: undefined,
    power: undefined,
    fields: new Map<string, Observed<number>>(),
  };

  /** Characters on the account, from the most recent `SMSG_CHAR_ENUM`. */
  characters: Observed<CharacterSummary[]> | undefined;

  /** guid -> name, learned only from `SMSG_NAME_QUERY_RESPONSE`. Not a proximity claim. */
  readonly names = new Map<GuidKey, Observed<string>>();

  /**
   * entry -> creature template info, from `SMSG_CREATURE_QUERY_RESPONSE`.
   *
   * Never pruned when an object leaves view: the module's per-session
   * "already queried" sets mean it will *not* re-issue `CMSG_CREATURE_QUERY`
   * when the same creature comes back, so dropping this would make a
   * re-approached creature permanently nameless. Same reasoning for `names`.
   */
  readonly creatures = new Map<number, Observed<CreatureInfo>>();

  /**
   * entry -> game object template info, from `SMSG_GAMEOBJECT_QUERY_RESPONSE`.
   * Never pruned, for the same reason as `creatures`: the module issues the
   * query once per entry per session.
   */
  readonly gameObjects = new Map<number, Observed<GameObjectInfo>>();

  /**
   * itemId -> item template info, from `SMSG_ITEM_QUERY_SINGLE_RESPONSE`.
   * Never pruned, for the same reason as `creatures`: the module issues the
   * query once per entry per session.
   */
  readonly items = new Map<number, Observed<ItemInfo>>();

  /** guid -> object in view, from `SMSG_UPDATE_OBJECT` and `MSG_MOVE_*`. */
  readonly nearby = new Map<GuidKey, NearbyObject>();

  /**
   * questId -> quest template, from `SMSG_QUEST_QUERY_RESPONSE`. Never pruned:
   * a template does not change, and a quest abandoned and re-accepted is the
   * same template.
   */
  readonly quests = new Map<number, Observed<QuestInfo>>();

  /**
   * questId -> the quest's objective areas, from `SMSG_QUEST_POI_QUERY_RESPONSE`
   * (what `questAreas()` asks for, and what a client's world map and quest
   * tracker draw). Never pruned, and an empty answer never replaces a
   * non-empty one: the areas are the quest's, and the server answers empty
   * for a quest that has left the log as for one that has no areas.
   */
  readonly questPois = new Map<number, Observed<readonly QuestPoi[]>>();

  /**
   * Quest ids an `SMSG_QUESTUPDATE_COMPLETE` credited with their exploration
   * or event objective. Held only while the quest stays in the log: a quest
   * that leaves it (turned in, abandoned) is forgotten, so a re-accept starts
   * unexplored as it does on the server; and a login forgets them all, since
   * nothing the new session sends restates the credit.
   */
  private readonly questExplored = new Set<number>();

  /** Our runes' current types by slot, once a convert or the class said this is a Death Knight; the base layout until one converts. */
  private runeTypes: number[] | undefined;
  /** The ready-rune mask the last own rune-spending `SMSG_SPELL_GO` left. */
  private runeReadyMask: number | undefined;
  /** `UNIT_FIELD_CHANNEL_OBJECT` on our own block, `undefined` for none. */
  private selfChannelObject: GuidKey | undefined;

  /**
   * guid -> slot -> aura. Kept per slot because `SMSG_AURA_UPDATE` is a *slot*
   * delta: it names only the slots that changed, and a slot the server clears
   * arrives as `removed` rather than as an absence.
   */
  private readonly auraSlots = new Map<GuidKey, Map<number, AuraEntry>>();

  motd: Observed<string[]> | undefined;

  /**
   * guid -> the gossip menu last opened for that NPC. Set by
   * `SMSG_GOSSIP_MESSAGE`, cleared wholesale by `SMSG_GOSSIP_COMPLETE` — which
   * carries no guid, so the honest reading of a close is "no menu is open".
   * Populated from that one opcode pair only; nothing here queries the server.
   */
  private readonly gossipMenus = new Map<GuidKey, GossipMenu>();

  /**
   * guid -> the flight master window last sent for that NPC
   * (`SMSG_SHOWTAXINODES`). Not cleared by `SMSG_GOSSIP_COMPLETE`: the taxi
   * window is its own frame on a client and the packet that opened it is the
   * last word on what this character may fly to from there.
   */
  private readonly taxiWindows = new Map<GuidKey, TaxiWindow>();

  /**
   * guid -> the last vendor / trainer list seen for that NPC. Never cleared:
   * no served packet closes either frame (module/PROTOCOL.md), and clearing
   * them on some *other* window's close would be the cache inventing a server
   * signal. They are "last observed", with seq/ts saying how long ago — the
   * same shape `taxiWindows` already has.
   */
  private readonly vendorWindows = new Map<GuidKey, VendorWindow>();

  private readonly trainerWindows = new Map<GuidKey, TrainerWindow>();

  /** The open loot window. Cleared by the release the server does send. */
  private lootWin: LootWindow | undefined;

  /**
   * Skill slot -> the SkillLine.dbc name the module put beside that slot's
   * id (`skill<n>Name`, a string among the numeric update fields). Kept
   * apart because `self.fields` holds numbers only.
   */
  private readonly skillNames = new Map<number, string>();

  /** repListId -> the reputation row, in observation order. */
  private readonly reputationMap = new Map<number, ReputationEntry>();

  /** The last `WB_TALENT_TREE`, before the learned ranks are merged in. */
  private talentTreeData: (TalentTreeData & { readonly seq: number; readonly ts: number }) | undefined;

  // -------------------------------- pets, group, mail, bank, trade, rolls, item text

  /** The last `SMSG_PET_SPELLS` with a pet in it; cleared by the guid-0 removal. */
  private petBar: (PetSpellsData & { readonly seq: number; readonly ts: number }) | undefined;

  /** petNumber -> given name, from `SMSG_PET_NAME_QUERY_RESPONSE`. Never pruned: the module asks once per number. */
  private readonly petNames = new Map<number, string>();

  private groupState: StoredGroupState | undefined;

  /**
   * member guid -> the party frame folded from `SMSG_PARTY_MEMBER_STATS[_FULL]`,
   * joined onto `group().members` at read time because every `SMSG_GROUP_LIST`
   * rebuilds the member list. Cleared when this character leaves the group.
   */
  private readonly partyStats = new Map<GuidKey, PartyMemberStats>();

  /** The open resurrection offer; closed by the resurrect itself and by a new login. */
  private resurrectOffer: (ResurrectRequestData & { readonly seq: number; readonly ts: number }) | undefined;

  /** rollGuid -> the open roll frame. Closed by the won / all-passed verdict, by our own counted vote, or by its deadline. */
  private readonly rolls = new Map<GuidKey, PendingRoll>();

  /** pageId -> one page of a book. A client-cache mirror: pages never change, so never pruned. */
  private readonly pageTexts = new Map<number, { readonly text: string; readonly nextPageId: number }>();

  /** item guid -> the player-written text on it, from `SMSG_ITEM_TEXT_QUERY_RESPONSE`. */
  private readonly playerTexts = new Map<GuidKey, string>();

  private mailState: MailboxState | undefined;

  /** The banker the bank frame was last opened at. */
  private bankGuid: { readonly value: GuidKey; readonly seq: number; readonly ts: number } | undefined;

  private tradeState: TradeState | undefined;
  /**
   * Who our own `CMSG_INITIATE_TRADE` asked, until the window opens or the
   * server refuses: the server answers the initiator nothing on success (the
   * begin goes to the other side alone), so this is the only word of who the
   * window is with, as it is a client's.
   */
  private tradeProposal: GuidKey | undefined;

  // ----------------------------------------------------------------------- spellbook

  /**
   * spellId -> spellbook row. Replaced wholesale by `SMSG_INITIAL_SPELLS`
   * (the login-time book), then edited by `SMSG_LEARNED_SPELL`,
   * `SMSG_REMOVED_SPELL` and `SMSG_SUPERCEDED_SPELL`. Empty until login has
   * served the book: empty means unobserved, not "knows nothing".
   */
  private readonly spellBook = new Map<number, KnownSpell>();

  /**
   * spellId -> its Spell.dbc name, for every id a spellbook packet has named:
   * the rows themselves and the old rank `SMSG_SUPERCEDED_SPELL` replaced
   * (which shares its successor's name). Never pruned: a name stays true of
   * its id after the rank leaves the book. `heldRanksOf` reads it.
   */
  private readonly spellNamesSeen = new Map<number, string>();

  /** spellId -> the last cooldown announcement for it. See `cooldowns()`. */
  private readonly cooldownMap = new Map<number, SpellCooldown>();

  private talentState: TalentState | undefined;

  /**
   * achievementId -> the entry, in observation order (Map preserves it).
   *
   * First writer wins: a login backlog entry is not overwritten by a later
   * earn of the same id, because the backlog is what made it history. The
   * derived `self.achievements` is rebuilt from this map on every change.
   */
  private readonly achievementMap = new Map<number, AchievementEntry>();

  /** Whether `SMSG_ALL_ACHIEVEMENT_DATA` has been observed at all. */
  private achievementsLoginSeen = false;

  /**
   * achievementId -> its name, from every achievement packet that named one:
   * our own login backlog and earns, and the earns of players in say range
   * (`SMSG_ACHIEVEMENT_EARNED` is broadcast, and the module names it from
   * `Achievement.dbc` whoever earned it). Only the chat line's `$a` reads it.
   */
  private readonly achievementNames = new Map<number, string>();

  /** The one input that did not come from an event. */
  readonly seed: StateSeed;

  private readonly chatBuf: ChatEntry[] = [];
  private readonly notifyBuf: NotificationEntry[] = [];
  private readonly gapBuf: GapRecord[] = [];
  /**
   * Turn-ins seen this cache's lifetime, oldest first. Never trimmed and never
   * deduped: a repeatable quest turned in twice is two completions, and seq
   * restarts when a session is recreated so seq is not an identity. Like
   * `eventCount`, this is a lifetime counter across session recreation. It
   * would double-count only if the stream ever replayed a window it had
   * already served, which it does not.
   */
  private readonly questDoneBuf: QuestCompletion[] = [];
  private readonly anomalyBuf: Anomaly[] = [];
  private readonly chatTail: number;
  private readonly notificationTail: number;

  lastSeq = -1;
  /** The `ts` of the last event folded: the stream's own clock, which timed things (a roll's deadline) are read against. */
  lastTs = 0;
  eventCount = 0;

  /**
   * Last map id `SMSG_LOGIN_VERIFY_WORLD` or `SMSG_NEW_WORLD` reported: the two
   * sources of a map id on the whole whitelist, and what later self positions
   * are paired with.
   */
  private selfMap: number | undefined;

  /**
   * A reattach replay is in flight (`WB_SESSION_STATE` with `replay: true`
   * seen, `WB_REPLAY_DONE` not yet): the replay's own self create block
   * replaces `self.fields` instead of merging into them, because a create
   * block carries no zero-valued field and a merge would keep a stale
   * non-zero value from before the socket went down (money spent to zero,
   * a quest slot emptied) under the replayed truth.
   */
  private replayPending = false;

  /**
   * The last spline the server launched for our own character
   * (`SMSG_MONSTER_MOVE` for our guid), kept until it is landed on or
   * superseded. A client flies itself along it locally; the module serves its
   * start, its last point and its duration (PROTOCOL.md), so the last point is
   * where a landing puts `position`. Cleared by anything that takes the
   * character off it — a stop, a teleport, a map change, a login, a move of
   * its own (`WB_MOVE_*`) — and by an accepted taxi reply, so a landing only
   * ever reads the flight's own spline (players get other server splines
   * too: a charge, a fear). Mid-flight nothing here moves `position`: the
   * module serves no points between start and end, so a point in between
   * would be invented.
   */
  private selfSpline:
    | { readonly destination: Point3; readonly durationMs: number | undefined; readonly seq: number; readonly ts: number }
    | undefined;

  constructor(options: StateCacheOptions = {}) {
    this.chatTail = options.chatTail ?? 200;
    this.notificationTail = options.notificationTail ?? 50;
    this.seed = { ...options.seed };
    if (this.seed.guid !== undefined) this.self.guid = this.seed.guid;
    if (this.seed.name !== undefined) this.self.name = this.seed.name;
    guardSelfMisreads(this.self);
  }

  /** Rebuild a cache by replaying events from seq 0. */
  static replay(events: Iterable<StreamEvent>, options: StateCacheOptions = {}): StateCache {
    const cache = new StateCache(options);
    for (const e of events) cache.apply(e);
    return cache;
  }

  /**
   * Record what the `POST /session` response told us about our own character.
   * Kept separate from `apply` so the event-derived and response-derived parts
   * of the cache never blur.
   */
  seedSelf(seed: StateSeed): void {
    if (seed.guid !== undefined) {
      this.seed.guid = seed.guid;
      this.self.guid = seed.guid;
    }
    if (seed.name !== undefined) {
      this.seed.name = seed.name;
      this.self.name = seed.name;
    }
    this.adoptOwnCharacter();
  }

  /** Chat lines, oldest first, each player sender named once a name query has answered (see `ChatEntry`). */
  get chat(): readonly ChatEntry[] {
    return this.namedChat();
  }

  /**
   * The chat buffer with `senderName` joined from `names` on read: the answer
   * to a sender's name query often lands after the line itself, so the join
   * is made when the line is read rather than when it was folded.
   */
  private namedChat(): ChatEntry[] {
    return this.chatBuf.map((c) => this.namedChatEntry(c));
  }

  /**
   * One chat line with its sender named: the packet's own name, else the
   * name query's answer, else — for a party member whose name query has not
   * answered yet (party chat at a cold start) — the name `SMSG_GROUP_LIST`
   * gave that member. `waitForChat` reads lines through this too, so a
   * predicate sees the same `senderName` `state.chat` shows.
   */
  namedChatEntry(c: ChatEntry): ChatEntry {
    const name =
      c.senderName ?? this.nameOf(c.senderGuid) ?? this.groupState?.members.find((m) => m.guid === c.senderGuid)?.name;
    const named = name === undefined || c.senderName !== undefined ? c : { ...c, senderName: name };
    if (!ACHIEVEMENT_CHAT_TYPES.has(c.type)) return named;
    const title = c.achievementId === undefined ? undefined : this.achievementNames.get(c.achievementId);
    return { ...named, message: achievementChatAsShown(c.message, name, c.achievementId, title) };
  }

  /** Client-visible notifications (the game-error channel), oldest first. */
  get notifications(): readonly NotificationEntry[] {
    return this.notifyBuf;
  }

  /** Holes the cache knows about. Non-empty means the cache is incomplete. */
  get gaps(): readonly GapRecord[] {
    return this.gapBuf;
  }

  /** Contradictions the stream contained. Non-empty means something is off. */
  get anomalies(): readonly Anomaly[] {
    return this.anomalyBuf;
  }

  // ------------------------------------------------------ derived self views
  //
  // Each of these is computed from `self.fields` on read rather than kept as a
  // second copy written by a second path. That is what makes replay equal live
  // for free: there is only one write seam (`mergeFields`), and these are pure
  // functions of what it stored.

  /** Copper, from `PLAYER_FIELD_COINAGE`. Self only; the server marks it private. */
  get money(): Observed<number> | undefined {
    return this.self.fields.get("money");
  }

  /** Current XP toward the next level. */
  get xp(): Observed<number> | undefined {
    return this.self.fields.get("xp");
  }

  /** XP required for the next level, as the client's bar shows it. */
  get nextLevelXp(): Observed<number> | undefined {
    return this.self.fields.get("nextLevelXp");
  }

  /**
   * The quest log, occupied slots only. `questNId === 0` is an empty slot and
   * does not become an entry with quest id 0.
   */
  get questLog(): QuestLogEntry[] {
    const out: QuestLogEntry[] = [];
    for (let slot = 0; slot < QUEST_LOG_SLOTS; slot++) {
      const id = this.self.fields.get(`quest${slot}Id`);
      if (!id || id.value === 0) continue;
      const state = this.self.fields.get(`quest${slot}State`);
      const lo = this.self.fields.get(`quest${slot}CountsLo`);
      const hi = this.self.fields.get(`quest${slot}CountsHi`);
      const timer = this.self.fields.get(`quest${slot}Time`);
      const raw = state?.value ?? 0;
      // Two u32s, each holding two u16 objective counters (3.3.5 layout).
      const counts: [number, number, number, number] = [
        (lo?.value ?? 0) & 0xffff,
        ((lo?.value ?? 0) >>> 16) & 0xffff,
        (hi?.value ?? 0) & 0xffff,
        ((hi?.value ?? 0) >>> 16) & 0xffff,
      ];
      const info = this.quests.get(id.value)?.value;
      const complete = (raw & QUEST_STATE_COMPLETE) !== 0;
      out.push({
        slot,
        questId: id.value,
        title: info?.title,
        level: questLogLevel(info?.level, this.self.level?.value),
        objectives: info === undefined ? undefined : this.questObjectives(info, counts, complete),
        state: raw,
        complete,
        counts,
        timer: timer?.value,
        seq: Math.max(id.seq, state?.seq ?? -1, lo?.seq ?? -1, hi?.seq ?? -1),
        ts: Math.max(id.ts, state?.ts ?? 0, lo?.ts ?? 0, hi?.ts ?? 0),
      });
    }
    return out;
  }

  /** Confirmed turn-ins, oldest first. Empty until one is observed. */
  get questCompletions(): readonly QuestCompletion[] {
    return this.questDoneBuf;
  }

  /** How many turn-ins the server has confirmed for this cache. */
  get questsCompleted(): number {
    return this.questDoneBuf.length;
  }

  /** The quest log slot holding `questId`, if the log shows it at all. */
  quest(questId: number): QuestLogEntry | undefined {
    return this.questLog.find((q) => q.questId === questId);
  }

  /** The quest ids the log's slot fields hold now. */
  private questIdsInLog(): Set<number> {
    const ids = new Set<number>();
    for (let slot = 0; slot < QUEST_LOG_SLOTS; slot++) {
      const id = this.self.fields.get(`quest${slot}Id`)?.value;
      if (id !== undefined && id !== 0) ids.add(id);
    }
    return ids;
  }

  /**
   * The objectives of one quest, client-style: the template's required
   * entries and counts joined with the log's counters (creature/gameobject/
   * event slots) or the carried stack totals (item slots: everything
   * `carriedItems` counts), then the exploration objective
   * when the template's flags carry one. A join over observations, nothing
   * invented.
   */
  private questObjectives(info: QuestInfo, counts: readonly number[], complete: boolean): QuestObjective[] {
    const out: QuestObjective[] = [];
    info.requiredNpcOrGo.forEach((req, i) => {
      const text = req.text === undefined || req.text === "" ? undefined : req.text;
      if (req.entry === 0 && req.count === 0 && text === undefined) return;
      const have = counts[i] ?? 0;
      if (req.entry === 0) {
        // Scripted event objective: text only, credited as a count of 1.
        const required = Math.max(req.count, 1);
        out.push({ kind: "event", entry: undefined, text, required, have, done: have >= required });
        return;
      }
      const isGo = (req.entry & 0x80000000) !== 0;
      out.push({
        kind: isGo ? "interact" : "kill",
        entry: isGo ? req.entry & 0x7fffffff : req.entry,
        text,
        required: req.count,
        have,
        done: have >= req.count,
      });
    });
    let carried: { itemId: number | undefined; count: number | undefined }[] | undefined;
    for (const item of info.requiredItems) {
      if (item.itemId === 0) continue;
      carried ??= this.carriedItems();
      let have = 0;
      for (const row of carried) {
        if (row.itemId === item.itemId) have += row.count ?? 1;
      }
      out.push({ kind: "collect", entry: item.itemId, text: undefined, required: item.count, have, done: have >= item.count });
    }
    if (((info.flags ?? 0) & QUEST_FLAGS_EXPLORATION) !== 0) {
      // No counter on the wire: done is the completion bit (a quest complete
      // is explored), or the server's exploration credit for this quest while
      // it has been in the log.
      const done = complete || this.questExplored.has(info.questId);
      const text = info.areaDescription || info.objectivesText || undefined;
      out.push({ kind: "explore", entry: undefined, text, required: 1, have: done ? 1 : 0, done });
    }
    return out;
  }

  /**
   * Every item the character carries, for counting a collect objective the
   * way the server's `Player::GetItemCount(id, false)` does: the equipment
   * slots and the worn bags themselves, the backpack, the keyring and the
   * currency token slots (86-149), and the contents of the worn bags — not
   * the bank or a bank bag's contents, whose items the turn-in refuses.
   * Reading only the player's own inventory fields missed everything in a
   * worn bag, so a collect objective read `have: 0` while the quest log said
   * complete; and a key, which sits on the keyring that no view lists, read
   * `have: 0` the same way.
   */
  private carriedItems(): { itemId: number | undefined; count: number | undefined }[] {
    const out: { itemId: number | undefined; count: number | undefined }[] = [];
    for (const row of this.inventory) {
      if (row.slot < BACKPACK_FIRST_SLOT) out.push({ itemId: row.itemId, count: row.stackCount });
    }
    for (const row of this.bag().items) out.push({ itemId: row.itemId, count: row.count });
    // The keyring and the currency tokens: the same guid join as `inventory`,
    // over the slots past the bank that it does not read.
    for (let slot = KEYRING_FIRST_SLOT; slot <= CURRENCY_LAST_SLOT; slot++) {
      const lo = this.self.fields.get(`invSlot${slot}Lo`);
      const hi = this.self.fields.get(`invSlot${slot}Hi`);
      if (!lo && !hi) continue;
      const guid = formatGuid((BigInt(hi?.value ?? 0) << 32n) | BigInt((lo?.value ?? 0) >>> 0));
      if (guid === "0") continue;
      const item = this.nearby.get(guid);
      out.push({ itemId: item?.entry?.value, count: item?.fields.get("stackCount")?.value });
    }
    return out;
  }

  /**
   * Occupied inventory slots, joined guid -> item create block -> item query.
   * A slot whose halves are both zero is empty and is not reported.
   */
  get inventory(): InventoryItem[] {
    const out: InventoryItem[] = [];
    for (let slot = 0; slot <= INVENTORY_LAST_SLOT; slot++) {
      const lo = this.self.fields.get(`invSlot${slot}Lo`);
      const hi = this.self.fields.get(`invSlot${slot}Hi`);
      if (!lo && !hi) continue;
      // The one internal bigint use: packing the two u32 wire halves back into
      // the u64 the item's own create block carries. formatGuid is the seam.
      const guid = formatGuid((BigInt(hi?.value ?? 0) << 32n) | BigInt((lo?.value ?? 0) >>> 0));
      if (guid === "0") continue;
      const item = this.nearby.get(guid);
      const itemId = item?.entry?.value;
      const maxDurability = item?.fields.get("maxDurability")?.value ?? 0;
      out.push({
        slot,
        guid,
        itemId,
        ...this.itemInstance(item),
        stackCount: item?.fields.get("stackCount")?.value,
        ...(maxDurability > 0
          ? { durability: { current: item?.fields.get("durability")?.value ?? 0, max: maxDurability } }
          : {}),
        seq: Math.max(lo?.seq ?? -1, hi?.seq ?? -1),
        ts: Math.max(lo?.ts ?? 0, hi?.ts ?? 0),
      });
    }
    return out;
  }

  /**
   * The carried inventory, shaped for acting on it: `bag`/`slot` are exactly
   * what `equipItem(bag, slot)`, `useItem` and `destroyItem` take — the
   * backpack is bag 255, slots 23-38; a worn bag is addressed by its own
   * equipment slot (19-22) with slots 0..numSlots-1 — and `freeSlots` counts
   * empty slots across all of them, out of `totalSlots`. Equipment (slots
   * 0-18) is the `inventory` rows with `slot < 19`, not part of this list.
   *
   * A view over `inventory` and the worn bags' own create blocks — same
   * three-way join, no new observation. Earned surface:
   * morning-opus-1 rebuilt the backpack view from ITEM_PUSH_RESULT listeners,
   * invSlot regexes over raw updates, and a full relog to force a resend; the
   * worn-bag span came from `inventory_full` turn-ins (quests 33, 183) and a
   * model hand-rolling destroyItem loops against a 16-slot ceiling while a
   * worn bag had room.
   *
   * One honest caveat. Empty slots are zero-valued update fields and the wire
   * compresses zeros out of create blocks, so "no field observed" reads as
   * free — before our own create block has arrived this says 16 free.
   */
  bag(): BagContents {
    const items: BagSlotItem[] = [];
    const bags: WornBag[] = [];
    let totalSlots = BACKPACK_SIZE;
    const inventory = this.inventory;
    // Backpack first, then each worn bag in slot order.
    for (const i of inventory) {
      if (i.slot >= BACKPACK_FIRST_SLOT && i.slot <= BACKPACK_LAST_SLOT) items.push(this.bagRow(BACKPACK_BAG, i.slot, i.guid));
    }
    for (const i of inventory) {
      if (i.slot < BAG_FIRST_SLOT || i.slot > BAG_LAST_SLOT) continue;
      const { numSlots, contents } = this.walkContainer(i.guid);
      bags.push({ slot: i.slot, numSlots, name: i.name });
      totalSlots += numSlots;
      for (const c of contents) items.push(this.bagRow(i.slot, c.slot, c.guid));
    }
    return { items, freeSlots: totalSlots - items.length, totalSlots, bags };
  }

  /**
   * One slot's row: the guid joined to the item's entry (its create block) and
   * to the item template the query answered with, which is where the name and
   * quality come from. An unqueried item is a row with a guid and no name.
   */
  private bagRow(bag: number, slot: number, guid: GuidKey): BagSlotItem {
    const item = this.nearby.get(guid);
    return {
      bag,
      slot,
      guid,
      itemId: item?.entry?.value,
      ...this.itemInstance(item),
      count: item?.fields.get("stackCount")?.value,
    };
  }

  /**
   * The instance half of a bag or equipment row: the template's name and
   * quality joined through the item's entry, with the random property the
   * item's own update fields carry laid over them — the suffix on the name,
   * its stat enchants after the template's stats, the green lines as text
   * (`ItemInstance`). An item without a random property reads exactly as the
   * template does; `suffix`/`enchants` keys appear only when there is one.
   */
  private itemInstance(item: NearbyObject | undefined): ItemInstance {
    const itemId = item?.entry?.value;
    const info = itemId === undefined ? undefined : this.items.get(itemId)?.value;
    const prop = randomPropertyOf(item);
    const name = info?.name === undefined ? undefined : prop?.suffix === undefined ? info.name : `${info.name} ${prop.suffix}`;
    const stats = info === undefined ? undefined : prop === undefined ? info.stats : [...(info.stats ?? []), ...prop.stats];
    return {
      name,
      quality: info?.quality,
      ...(prop?.suffix === undefined ? {} : { suffix: prop.suffix }),
      stats,
      ...(prop === undefined || prop.enchants.length === 0 ? {} : { enchants: prop.enchants }),
    };
  }

  /**
   * What a worn bag holds: its size, and the guid in each occupied slot.
   *
   * A container's contents are the container item's own `bagSlot<n>Lo/Hi`
   * update fields, so reading a bag means reading the item that *is* the bag.
   * Bank bags work exactly the same way, which is why this walk lives once.
   * A container whose create block has not arrived reads as zero slots and
   * nothing in them rather than as an error.
   */
  private walkContainer(guid: GuidKey): { numSlots: number; contents: readonly { slot: number; guid: GuidKey }[] } {
    const container = this.nearby.get(guid);
    const numSlots = container?.fields.get("numSlots")?.value ?? 0;
    const contents: { slot: number; guid: GuidKey }[] = [];
    if (container === undefined) return { numSlots, contents };
    for (let n = 0; n < numSlots; n++) {
      const lo = container.fields.get(`bagSlot${n}Lo`);
      const hi = container.fields.get(`bagSlot${n}Hi`);
      if (!lo && !hi) continue;
      const inner = formatGuid((BigInt(hi?.value ?? 0) << 32n) | BigInt((lo?.value ?? 0) >>> 0));
      if (inner === "0") continue;
      contents.push({ slot: n, guid: inner });
    }
    return { numSlots, contents };
  }

  /** The object our own `targetGuid` points at, when it is also in view. */
  get target(): NearbyObject | undefined {
    const guid = this.self.targetGuid?.value;
    if (guid === undefined || guid === "0") return undefined;
    return this.nearby.get(guid);
  }

  /**
   * Visible auras on a unit, by slot — your own buff and debuff bar with
   * `state.aurasOf(state.self.guid)`. Empty when none have been observed.
   * `name` is the module's Spell.dbc name, else the spellbook's for the id.
   */
  aurasOf(guid: GuidKey): AuraEntry[] {
    const slots = this.auraSlots.get(guid);
    if (!slots) return [];
    return [...slots.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((a) => (a.name !== undefined ? a : { ...a, name: this.spell(a.spellId)?.name }));
  }

  /**
   * The gossip menu last observed open for `guid`, or `undefined` if none has
   * been seen or a `SMSG_GOSSIP_COMPLETE` has since closed it. What
   * `gossipSelect(guid, option)` resolves an option name or id against.
   */
  lastGossip(guid: GuidKey): GossipMenu | undefined {
    return this.gossipMenus.get(guid);
  }

  /**
   * The flight master window last observed for `guid` (`SMSG_SHOWTAXINODES`),
   * or `undefined` if none has been seen. What `activateTaxi(guid, dest)`
   * resolves a destination name or node id against, and where the source
   * node it sends comes from. Opened by choosing the taxi option on the
   * flight master's gossip menu (`showTaxiNodes` does that in one call).
   */
  lastTaxiNodes(guid: GuidKey): TaxiWindow | undefined {
    return this.taxiWindows.get(guid);
  }

  /**
   * The stock list last observed for vendor `guid` (`SMSG_LIST_INVENTORY`),
   * or `undefined` if none has been seen. Rows are the server's own; `slot` is
   * what `buyItem(guid, itemId, slot)` takes. Nothing closes a vendor frame, so
   * this survives walking away — read `seq`/`ts` for how old it is.
   */
  lastVendorList(guid: GuidKey): VendorWindow | undefined {
    return this.vendorWindows.get(guid);
  }

  /**
   * The teaching list last observed for trainer `guid` (`SMSG_TRAINER_LIST`),
   * or `undefined` if none has been seen. Raw rows; `trainerList(npcGuid)` is
   * the helper that asks and adds `learnable`/`affordable`.
   */
  lastTrainerList(guid: GuidKey): TrainerWindow | undefined {
    return this.trainerWindows.get(guid);
  }

  /**
   * The loot window currently open, or `undefined`. Its `items[].slot` is what
   * `lootItem(slot)` takes; taken slots and taken gold leave it as the server
   * says so, and the release closes it.
   */
  lastLoot(): LootWindow | undefined {
    return this.lootWin;
  }

  /**
   * The spellbook as the server served it: every spell id the character
   * knows in its active spec, by id. Empty until `SMSG_INITIAL_SPELLS` has
   * arrived (it is sent during login, before the world is entered).
   */
  spells(): KnownSpell[] {
    return [...this.spellBook.values()].sort((a, b) => a.spellId - b.spellId);
  }

  /** One spellbook row by id, or `undefined` when the character does not know it. */
  spell(spellId: number): KnownSpell | undefined {
    return this.spellBook.get(spellId);
  }

  /**
   * The spellbook rows that are another rank of `spellId`: those sharing the
   * name a spellbook packet once gave that id. Empty when no packet has named
   * it — the cache never guesses a rank chain it was not shown.
   */
  heldRanksOf(spellId: number): KnownSpell[] {
    const name = this.spellNamesSeen.get(spellId);
    if (name === undefined) return [];
    return this.spells().filter((s) => s.spellId !== spellId && s.name === name);
  }

  /**
   * Cooldowns still running at `now` (default: the wall clock): every spell
   * whose `readyAt` is in the future, plus those a `SMSG_COOLDOWN_EVENT`
   * started without a duration (`readyAt` undefined). Expired entries are
   * dropped from the answer, not from the cache — the server never announces
   * an expiry, so the clock is the only judge.
   */
  cooldowns(now: number = Date.now()): SpellCooldown[] {
    return [...this.cooldownMap.values()]
      .filter((c) => c.readyAt === undefined || c.readyAt > now)
      .sort((a, b) => a.spellId - b.spellId);
  }

  /** The last `SMSG_TALENTS_INFO` for the player, or `undefined` before one arrived. */
  talents(): TalentState | undefined {
    return this.talentState;
  }

  /**
   * The class talent frame: the last `WB_TALENT_TREE` (`queryTalentTree`)
   * with each talent's `pointsSpent` read off the last `SMSG_TALENTS_INFO`.
   * `undefined` until a tree has been queried.
   */
  talentTree(): TalentTree | undefined {
    const tree = this.talentTreeData;
    if (tree === undefined) return undefined;
    const spent = new Map<number, number>();
    for (const t of this.talentState?.talents ?? []) spent.set(t.talentId, t.rank + 1);
    const tabs = tree.tabs.map((tab) => {
      const talents = tab.talents.map((t) => ({
        talentId: t.talentId,
        name: t.name,
        row: t.row,
        col: t.col,
        maxRank: t.maxRank,
        ranks: [...t.ranks],
        pointsSpent: spent.get(t.talentId) ?? 0,
        dependsOn: t.dependsOn,
        dependsOnRank: t.dependsOnRank,
      }));
      return { tabId: tab.tabId, name: tab.name, page: tab.page, talents, pointsSpent: talents.reduce((n, t) => n + t.pointsSpent, 0) };
    });
    const unspent =
      this.talentState !== undefined && this.talentState.seq > tree.seq ? this.talentState.unspentPoints : tree.unspentPoints;
    return { class: tree.class, unspentPoints: unspent, tabs, seq: tree.seq, ts: tree.ts };
  }

  /**
   * The skill pane: every occupied `PLAYER_SKILL_INFO` slot on self, by
   * skill id. Empty until the self create block has been seen.
   */
  skills(): SkillLine[] {
    const out: SkillLine[] = [];
    for (let slot = 0; slot < SKILL_SLOTS; slot++) {
      const id = this.self.fields.get(`skill${slot}Id`);
      if (!id || id.value === 0) continue;
      const value = this.self.fields.get(`skill${slot}Value`);
      const max = this.self.fields.get(`skill${slot}Max`);
      const temp = this.self.fields.get(`skill${slot}TempBonus`);
      const perm = this.self.fields.get(`skill${slot}PermBonus`);
      const step = this.self.fields.get(`skill${slot}Step`);
      let latest = id;
      for (const f of [value, max, temp, perm]) if (f !== undefined && f.seq > latest.seq) latest = f;
      out.push({
        skillId: id.value,
        name: this.skillNames.get(slot),
        value: value?.value ?? 0,
        max: max?.value ?? 0,
        tempBonus: temp?.value ?? 0,
        permBonus: perm?.value ?? 0,
        step: step?.value ?? 0,
        seq: latest.seq,
        ts: latest.ts,
      });
    }
    return out.sort((a, b) => a.skillId - b.skillId);
  }

  /**
   * One skill line by id or by name, through the shared `resolveName`;
   * `undefined` when the character lacks it. A query is a *read* here, not an
   * action, so there is nowhere to put a refusal: an ambiguous name answers
   * `undefined` the same as an unknown one, and the caller looks at
   * `skills()`.
   */
  skill(key: number | string): SkillLine | undefined {
    const all = this.skills();
    if (typeof key === "number") return all.find((s) => s.skillId === key);
    return only(resolveName(key, all, (s) => s.name));
  }

  /**
   * The reputation pane: every faction the server has told this character
   * about, visible ones first, then by name. Empty until login's
   * `SMSG_INITIALIZE_FACTIONS`.
   */
  reputation(): ReputationEntry[] {
    return [...this.reputationMap.values()].sort((a, b) =>
      a.visible !== b.visible ? (a.visible ? -1 : 1) : (a.name ?? "").localeCompare(b.name ?? "") || a.repListId - b.repListId,
    );
  }

  /** One reputation row by faction id or by name (shared `resolveName`; ambiguous reads `undefined`, as `skill` does). */
  reputationWith(key: number | string): ReputationEntry | undefined {
    const all = [...this.reputationMap.values()];
    if (typeof key === "number") return all.find((r) => r.factionId === key);
    return only(resolveName(key, all, (r) => r.name));
  }

  // ------------------------------------------------------------------ pets

  /**
   * The pet frame: the control bar the server last sent
   * (`SMSG_PET_SPELLS`) joined to the pet's unit in view and its given name.
   * `undefined` when there is no pet — none summoned, or the server removed
   * the bar (death, dismiss, abandon).
   */
  pet(): PetState | undefined {
    const bar = this.petBar;
    if (bar === undefined) return undefined;
    const unit = this.nearby.get(bar.guid);
    const petNumber = unit?.fields.get("petNumber")?.value;
    const entry = unit?.entry?.value;
    const health = unit?.fields.get("health")?.value;
    const creatureName = entry === undefined ? undefined : this.creatures.get(entry)?.value.name;
    const spells: PetSpellEntry[] = (bar.spells ?? []).map((sp: PetSpell) => ({
      spellId: sp.spellId,
      name: sp.name,
      rank: sp.rank,
      autocast: sp.autocast,
      passive: sp.active === 0x01,
    }));
    return {
      guid: bar.guid,
      name: petNumber === undefined ? undefined : this.petNames.get(petNumber),
      creatureName,
      entry,
      level: unit?.level?.value,
      health,
      maxHealth: unit?.fields.get("maxHealth")?.value,
      power: unit?.power?.value.current,
      maxPower: unit?.power?.value.max,
      dead: health === undefined ? undefined : health === 0,
      inView: unit !== undefined,
      family: bar.family ?? 0,
      durationMs: bar.durationMs ?? 0,
      reaction: PET_REACTIONS[bar.reactState ?? 0] ?? "passive",
      command: PET_COMMANDS[bar.commandState ?? 0] ?? "stay",
      reactState: bar.reactState ?? 0,
      commandState: bar.commandState ?? 0,
      actionBar: bar.actionBar ?? [],
      spells,
      cooldowns: (bar.cooldowns ?? []).map((c) => ({ spellId: c.spellId, cooldownMs: c.cooldownMs, categoryCooldownMs: c.categoryCooldownMs })),
      seq: bar.seq,
      ts: bar.ts,
    };
  }

  /**
   * One of the pet's spells by id or by name (shared `resolveName`);
   * `undefined` when the pet lacks it, there is no pet, or the name is
   * ambiguous — a read has nowhere to put a refusal.
   */
  petSpell(key: number | string): PetSpellEntry | undefined {
    const all = this.pet()?.spells ?? [];
    if (typeof key === "number") return all.find((s) => s.spellId === key);
    return only(resolveName(key, all, (s) => s.name));
  }

  // ----------------------------------------------------- group loot rolls

  /**
   * The roll frames open right now, oldest first, named from the
   * item query where it has answered. A frame whose deadline has passed is
   * gone: the server decided it without us. `now` defaults to the stream's
   * own clock (`lastTs`), the clock the deadline was set on.
   */
  pendingRolls(now: number = this.lastTs): PendingRoll[] {
    const out: PendingRoll[] = [];
    for (const [guid, roll] of this.rolls) {
      if (roll.deadline <= now) {
        this.rolls.delete(guid);
        continue;
      }
      const info = this.items.get(roll.itemId)?.value;
      out.push(roll.name === undefined && info !== undefined ? { ...roll, name: info.name, quality: info.quality } : roll);
    }
    return out;
  }

  // ------------------------------------------------------------ item text

  /**
   * The text of every carried item this character has read: a
   * book's pages walked from the template's `pageText` through the cached
   * chain, or the player-written text on a mailed letter. Items that were
   * never read are absent; `complete` is false while a chain's later pages
   * are still arriving.
   */
  itemTexts(): ItemText[] {
    const out: ItemText[] = [];
    for (const item of this.bag().items) {
      const written = this.playerTexts.get(item.guid);
      if (written !== undefined) {
        out.push({ guid: item.guid, itemId: item.itemId, name: item.name, pages: [written], complete: true });
        continue;
      }
      const first = item.itemId === undefined ? undefined : this.items.get(item.itemId)?.value.pageText;
      if (first === undefined || first === 0) continue;
      const pages: string[] = [];
      let next = first;
      // Cap the walk: a page chain is short and a cycle in the data must not hang a read.
      for (let guard = 0; next !== 0 && guard < 64; guard++) {
        const page = this.pageTexts.get(next);
        if (page === undefined) break;
        pages.push(page.text);
        next = page.nextPageId;
      }
      if (pages.length === 0) continue;
      out.push({ guid: item.guid, itemId: item.itemId, name: item.name, pages, complete: next === 0 });
    }
    return out;
  }

  // ---------------------------------------------------------------- group

  /**
   * The party, or `undefined` until any group packet has been observed. Each
   * member carries whether its unit is in view and, once one arrived, the
   * party frame the server sends while it is out of sight (`stats`).
   */
  group(): GroupState | undefined {
    const g = this.groupState;
    if (g === undefined) return undefined;
    const members = g.members.map((m) => ({
      ...m,
      inView: this.nearby.has(m.guid),
      stats: this.partyStats.get(m.guid),
    }));
    return { ...g, members };
  }

  // ----------------------------------------------------------------- mail

  /**
   * The mailbox: the inbox as last listed, with item names and
   * sender names joined at read time. `undefined` until any mail packet.
   */
  mailbox(): MailboxState | undefined {
    const m = this.mailState;
    if (m === undefined) return undefined;
    const mails = m.mails.map((mail) => ({
      ...mail,
      senderName: mail.senderGuid === undefined ? undefined : this.names.get(mail.senderGuid)?.value,
      items: mail.items.map((it) => ({ ...it, name: this.items.get(it.itemId)?.value.name })),
    }));
    return { ...m, mails };
  }

  // ----------------------------------------------------------------- bank

  /**
   * The bank: the main bank slots (bag 255, slots 39-66) and each
   * bank bag's contents (bag = the bank bag's slot 67-73), addressed the way
   * `bankWithdraw(bag, slot)` takes them. The same three-way join as `bag()`.
   * `guid` is the banker the frame was last opened at, or undefined.
   */
  bank(): BankContents {
    const items: BagSlotItem[] = [];
    const bags: WornBag[] = [];
    const inventory = this.inventory;
    // The main bank: a character starts with 28 slots and buys none (3.3.5
    // bank *bag* slots are bought; the 28 item slots are free), so every
    // slot in the range counts toward totalSlots.
    let totalSlots = BANK_LAST_SLOT - BANK_FIRST_SLOT + 1;
    for (const i of inventory) {
      if (i.slot >= BANK_FIRST_SLOT && i.slot <= BANK_LAST_SLOT) items.push(this.bagRow(BACKPACK_BAG, i.slot, i.guid));
    }
    for (const i of inventory) {
      if (i.slot < BANK_BAG_FIRST_SLOT || i.slot > BANK_BAG_LAST_SLOT) continue;
      const { numSlots, contents } = this.walkContainer(i.guid);
      bags.push({ slot: i.slot, numSlots, name: i.name });
      totalSlots += numSlots;
      for (const c of contents) items.push(this.bagRow(i.slot, c.slot, c.guid));
    }
    return { guid: this.bankGuid?.value, items, bags, freeSlots: totalSlots - items.length, totalSlots };
  }

  // -------------------------------------------------------------- buyback

  /**
   * The vendor buyback tab: what this character sold and can buy back, in
   * slot order (74-85, the slot `CMSG_BUYBACK_ITEM` names), each with the
   * price the tab shows. Empty until a sale; the server keeps twelve, the
   * oldest giving way to the next sale.
   */
  buyback(): BuybackItem[] {
    const out: BuybackItem[] = [];
    for (let slot = BUYBACK_FIRST_SLOT; slot <= BUYBACK_LAST_SLOT; slot++) {
      const lo = this.self.fields.get(`invSlot${slot}Lo`);
      const hi = this.self.fields.get(`invSlot${slot}Hi`);
      if (!lo && !hi) continue;
      const guid = formatGuid((BigInt(hi?.value ?? 0) << 32n) | BigInt((lo?.value ?? 0) >>> 0));
      if (guid === "0") continue;
      const item = this.nearby.get(guid);
      out.push({
        slot,
        guid,
        itemId: item?.entry?.value,
        ...this.itemInstance(item),
        count: item?.fields.get("stackCount")?.value,
        price: this.self.fields.get(`buybackPrice${slot - BUYBACK_FIRST_SLOT}`)?.value,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- trade

  /** The trade window, or `undefined` until any trade packet. */
  trade(): TradeState | undefined {
    const t = this.tradeState;
    if (t === undefined) return undefined;
    const side = (s: TradeSide | undefined): TradeSide | undefined =>
      s === undefined ? undefined : { ...s, items: s.items.map((it) => ({ ...it, name: this.items.get(it.itemId)?.value.name })) };
    return { ...t, mine: side(t.mine), theirs: side(t.theirs) };
  }

  /**
   * One `SMSG_TRADE_STATUS`, read as a client's trade window reads it
   * (TradeHandler, TradeData at the pinned core):
   *
   *   - 1 (begin trade) is a proposal to us from `traderGuid`; no window yet.
   *   - 2 (window open) opens it, with both sides empty, for whoever proposed:
   *     the begin's trader, or the player our own initiate named.
   *   - 4 (the other side accepted), 7 (back to trade: an accept was cleared)
   *     and the notices the core sends without ending the trade (10 too far
   *     and 12 an inventory error at an accept, 22/23 a slot refused) leave
   *     an open window open.
   *   - Anything else with a window open closes it — 3 canceled, 8
   *     complete, 0 the other side busy — and empties both sides; the
   *     trader stays named.
   *   - Anything else with no window open is a refusal of our own initiate
   *     (0 busy: the target is already in a trade, or is us), named with the
   *     player it asked.
   */
  private foldTradeStatus(status: number, traderGuid: GuidKey | undefined, seq: number, ts: number): void {
    const prev = this.tradeState;
    const wasOpen = prev?.open === true;
    const statusText = tradeStatusText(status);
    const proposedToUs = prev !== undefined && !wasOpen && prev.status === 1 ? prev.traderGuid : undefined;
    if (status === 1) {
      this.tradeState = { status, statusText, open: false, traderGuid, mine: undefined, theirs: undefined, seq, ts };
      return;
    }
    if (status === 2) {
      const trader = proposedToUs ?? this.tradeProposal ?? prev?.traderGuid;
      this.tradeProposal = undefined;
      this.tradeState = { status, statusText, open: true, traderGuid: trader, mine: emptyTradeSide(seq), theirs: emptyTradeSide(seq), seq, ts };
      return;
    }
    if (wasOpen) {
      const open = TRADE_WINDOW_NOTICES.has(status);
      this.tradeState = open
        ? { ...prev, status, statusText, open, seq, ts }
        : { ...prev, status, statusText, open, mine: undefined, theirs: undefined, seq, ts };
      return;
    }
    const trader = this.tradeProposal ?? proposedToUs;
    this.tradeProposal = undefined;
    this.tradeState = { status, statusText, open: false, traderGuid: trader, mine: undefined, theirs: undefined, seq, ts };
  }

  /**
   * Fold one of our own trade opcodes, sent through `raw`, the way a client's
   * window shows what its own player did: the core echoes neither an item or
   * gold placed on our side (`TradeData::Update` goes to the other trader)
   * nor whom an initiate asked. `CMSG_INITIATE_TRADE` (u64 guid) is recorded
   * before the send, since a refusal can land before the ack; the item and
   * gold opcodes after it, on an open window. An item is the `state.bag()`
   * row at the wire's own bag/slot.
   */
  tradeSent(opcode: string, payloadHex: string): void {
    const bytes = Uint8Array.from(Buffer.from(payloadHex, "hex"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (opcode === "CMSG_INITIATE_TRADE") {
      if (bytes.length >= 8) this.tradeProposal = formatGuid(view.getBigUint64(0, true));
      return;
    }
    const t = this.tradeState;
    if (t === undefined || !t.open) return;
    const mine = t.mine ?? emptyTradeSide(this.lastSeq);
    let next: TradeSide | undefined;
    if (opcode === "CMSG_SET_TRADE_ITEM" && bytes.length >= 3) {
      const [tradeSlot, bag, slot] = [bytes[0]!, bytes[1]!, bytes[2]!];
      const row = this.bag().items.find((i) => i.bag === bag && i.slot === slot);
      if (row?.itemId === undefined) return;
      const items = mine.items.filter((i) => i.slot !== tradeSlot);
      items.push({ slot: tradeSlot, itemId: row.itemId, name: undefined, count: row.count ?? 1 });
      items.sort((a, b) => a.slot - b.slot);
      next = { money: mine.money, items, seq: this.lastSeq };
    } else if (opcode === "CMSG_CLEAR_TRADE_ITEM" && bytes.length >= 1) {
      next = { money: mine.money, items: mine.items.filter((i) => i.slot !== bytes[0]), seq: this.lastSeq };
    } else if (opcode === "CMSG_SET_TRADE_GOLD" && bytes.length >= 4) {
      next = { money: view.getUint32(0, true), items: mine.items, seq: this.lastSeq };
    }
    if (next !== undefined) this.tradeState = { ...t, mine: next };
  }

  // ---------------------- group, mail, pets, loot rolls folders

  private foldGroupList(d: GroupListData, seq: number, ts: number): void {
    const prev = this.groupState;
    const members: StoredGroupMember[] = d.left
      ? []
      : d.members.map((m: GroupMemberData) => ({
          guid: m.guid,
          name: m.name,
          online: m.online,
          subGroup: m.subGroup,
          assistant: (m.flags & 0x01) !== 0,
          leader: m.guid === d.leaderGuid,
        }));
    const leaderGuid = d.left || d.leaderGuid === "0" ? undefined : d.leaderGuid;
    const leaderName =
      leaderGuid === undefined
        ? undefined
        : members.find((m) => m.guid === leaderGuid)?.name ?? (this.self.guid === leaderGuid ? this.self.name : undefined) ?? this.names.get(leaderGuid)?.value;
    this.groupState = {
      inGroup: !d.left,
      raid: d.raid,
      groupGuid: d.left ? undefined : d.groupGuid,
      leaderGuid,
      leaderName,
      leader: leaderGuid !== undefined && leaderGuid === this.self.guid,
      members,
      lootMethod: d.lootMethod,
      // Joining a group is the invite answered; leaving it clears nothing.
      pendingInvite: d.left ? prev?.pendingInvite : undefined,
      lastResult: prev?.lastResult,
      lastDecline: prev?.lastDecline,
      seq,
      ts,
    };
  }

  /**
   * One party-frame packet into the member's record. A `_FULL` answer
   * replaces the record — it carries every field, and its aura list is the
   * whole set — except that its offline form (status alone) keeps the rest.
   * A delta overwrites only the fields its mask carried, and its aura entries
   * set or clear single slots. `_FULL` leaves out the power type only for
   * mana, so there its absence is mana; a delta without it keeps the last.
   */
  private foldPartyMemberStats(d: PartyMemberStatsData, seq: number, ts: number): void {
    const prev = this.partyStats.get(d.guid);
    const replace = d.full && d.health !== undefined;
    const base = replace ? undefined : prev;
    const statusFlags = d.status ?? base?.statusFlags;
    const health = d.health ?? base?.health;
    const has = (bit: number): boolean | undefined => (statusFlags === undefined ? undefined : (statusFlags & bit) !== 0);
    const ghost = has(MEMBER_STATUS_GHOST);
    const statusDead = has(MEMBER_STATUS_DEAD);
    const dead = statusDead === true || (health === 0 && ghost !== true) ? true : statusDead;
    let auras: PartyMemberAura[] | undefined = base?.auras === undefined ? undefined : [...base.auras];
    if (d.auras !== undefined) {
      const bySlot = new Map<number, PartyMemberAura>(replace || auras === undefined ? [] : auras.map((a) => [a.slot, a]));
      for (const a of d.auras) {
        if (a.spellId === 0) bySlot.delete(a.slot);
        else bySlot.set(a.slot, { slot: a.slot, spellId: a.spellId, name: a.name, flags: a.flags });
      }
      auras = [...bySlot.values()].sort((x, y) => x.slot - y.slot);
    }
    const powerTypeId = d.powerType ?? (replace ? 0 : undefined);
    this.partyStats.set(d.guid, {
      online: has(MEMBER_STATUS_ONLINE),
      dead,
      ghost,
      afk: has(MEMBER_STATUS_AFK),
      dnd: has(MEMBER_STATUS_DND),
      statusFlags,
      health,
      maxHealth: d.maxHealth ?? base?.maxHealth,
      powerType: powerTypeId === undefined ? base?.powerType : PARTY_POWER_TYPES[powerTypeId],
      power: d.power ?? base?.power,
      maxPower: d.maxPower ?? base?.maxPower,
      level: d.level ?? base?.level,
      zone: d.zoneId === undefined ? base?.zone : { id: d.zoneId, name: d.zoneName },
      position: d.x !== undefined && d.y !== undefined ? { x: d.x, y: d.y } : base?.position,
      auras,
      asOf: ts,
      seq,
    });
  }

  private groupPatch(patch: Partial<StoredGroupState>, seq: number, ts: number): void {
    const prev: StoredGroupState = this.groupState ?? {
      inGroup: false,
      raid: false,
      groupGuid: undefined,
      leaderGuid: undefined,
      leaderName: undefined,
      leader: false,
      members: [],
      lootMethod: undefined,
      pendingInvite: undefined,
      lastResult: undefined,
      lastDecline: undefined,
      seq,
      ts,
    };
    this.groupState = { ...prev, ...patch, seq, ts };
  }

  /**
   * Record the mailbox frame as open on `guid`. Called by `openMailbox` when
   * the first `SMSG_MAIL_LIST_RESULT` answers a `CMSG_GET_MAIL_LIST` on it: the
   * core sends no `SMSG_SHOW_MAILBOX` for a game-object mailbox, so the list
   * answering is what proves the box is in reach.
   */
  mailboxOpened(guid: GuidKey, seq: number, ts: number): void {
    this.mailPatch({ guid }, seq, ts);
  }

  /**
   * Drop a pending roll the packet names. The core writes the roll guid on
   * `SMSG_LOOT_START_ROLL` and `SMSG_LOOT_ALL_PASSED` but sends
   * `ObjectGuid::Empty` ("0") as the source on every `SMSG_LOOT_ROLL` vote
   * echo and on `SMSG_LOOT_ROLL_WON` (Group::CountRollVote / CountTheRoll —
   * the field is unused by the client), so those resolve by slot and item.
   */
  private closeRoll(d: { rollGuid: string; slot: number; itemId: number }): void {
    if (d.rollGuid !== "0") {
      this.rolls.delete(d.rollGuid);
      return;
    }
    for (const [guid, roll] of this.rolls) {
      if (roll.slot === d.slot && roll.itemId === d.itemId) this.rolls.delete(guid);
    }
  }

  /**
   * Fold the pet's react or command state off our own accepted order. The
   * core answers `CMSG_PET_ACTION` react and follow/stay buttons with no
   * packet (a client updates its bar locally — seen live 2026-08-30: no
   * `SMSG_PET_SPELLS` follows a react change), so the ack is the only signal
   * the bar has changed. The next `SMSG_PET_SPELLS` replaces it wholesale.
   */
  petCommanded(patch: { reactState?: number; commandState?: number }, seq: number, ts: number): void {
    if (this.petBar === undefined) return;
    this.petBar = { ...this.petBar, ...patch, seq, ts };
  }

  private mailPatch(patch: Partial<MailboxState>, seq: number, ts: number): void {
    const prev: MailboxState = this.mailState ?? { guid: undefined, mails: [], total: 0, newMail: false, lastResult: undefined, seq, ts };
    this.mailState = { ...prev, ...patch, seq, ts };
  }

  // ---------------------------------------------------------------------- reputation

  private foldFactionRow(row: FactionRowLike, seq: number, ts: number): void {
    const prev = this.reputationMap.get(row.repListId);
    const standing = row.standing;
    const base = row.base ?? prev?.base;
    const reputation = row.reputation ?? (base !== undefined ? base + standing : standing);
    this.reputationMap.set(row.repListId, {
      repListId: row.repListId,
      factionId: row.factionId ?? prev?.factionId,
      name: row.name ?? prev?.name,
      standing,
      base,
      reputation,
      rank: reputationRank(reputation),
      visible: row.visible ?? prev?.visible ?? false,
      atWar: row.atWar ?? prev?.atWar ?? false,
      seq,
      ts,
    });
  }

  /** Name for a guid, if a name query ever returned one. Never guessed. */
  nameOf(guid: GuidKey): string | undefined {
    if (this.self.guid !== undefined && guid === this.self.guid) return this.self.name;
    return this.names.get(guid)?.value;
  }

  /**
   * The resurrection offer waiting for an answer, from `SMSG_RESURRECT_REQUEST`
   * until the resurrect (`SMSG_DEATH_RELEASE_LOC { map: -1 }`, which every
   * resurrection sends first) or a new login; undefined when there is none.
   * A newer offer replaces an older one, as the server keeps only the last.
   */
  get pendingResurrect(): PendingResurrect | undefined {
    const o = this.resurrectOffer;
    if (o === undefined) return undefined;
    return {
      casterGuid: o.casterGuid,
      casterName: o.casterName ?? this.nameOf(o.casterGuid) ?? this.nearby.get(o.casterGuid)?.name?.value,
      sickness: o.sickness,
      seq: o.seq,
      ts: o.ts,
    };
  }

  snapshot(): StateSnapshot {
    return {
      // Field groups are always *replaced*, never mutated in place, so a
      // shallow copy is enough for them — but the `fields` map and the `nearby`
      // entries themselves are mutated in place, so both are copied.
      self: { ...this.self, fields: new Map(this.self.fields) },
      characters: this.characters,
      names: new Map(this.names),
      creatures: new Map(this.creatures),
      items: new Map(this.items),
      nearby: new Map([...this.nearby].map(([k, v]) => [k, { ...v, fields: new Map(v.fields) }])),
      auras: new Map([...this.auraSlots].map(([k, v]) => [k, [...v.values()].sort((a, b) => a.slot - b.slot)])),
      questLog: this.questLog,
      questCompletions: [...this.questDoneBuf],
      quests: new Map(this.quests),
      inventory: this.inventory,
      money: this.money,
      xp: this.xp,
      nextLevelXp: this.nextLevelXp,
      chat: this.namedChat(),
      notifications: [...this.notifyBuf],
      motd: this.motd,
      gaps: [...this.gapBuf],
      anomalies: [...this.anomalyBuf],
      gossip: new Map(this.gossipMenus),
      taxiWindows: new Map(this.taxiWindows),
      vendorWindows: new Map(this.vendorWindows),
      trainerWindows: new Map(this.trainerWindows),
      lootWindow: this.lootWin,
      spells: this.spells(),
      cooldowns: this.cooldowns(),
      talents: this.talentState,
      talentTree: this.talentTree(),
      skills: this.skills(),
      reputation: this.reputation(),
      pet: this.pet(),
      group: this.group(),
      mailbox: this.mailbox(),
      bank: this.bank(),
      buyback: this.buyback(),
      trade: this.tradeState,
      lastSeq: this.lastSeq,
      eventCount: this.eventCount,
    };
  }

  /** Fold one event in. Unknown opcodes advance `lastSeq` and change nothing else. */
  apply(event: StreamEvent): void {
    this.eventCount++;
    // Assigned, not max'd: seq restarts when a session is recreated (retry
    // churn), and holding the old max made `lastSeq` drift from the live
    // stream position for the rest of the run (seen in gate2-ox-2, +3).
    // `eventCount` stays a lifetime counter across sessions by design.
    if (event.opcode !== STREAM_GAP) {
      this.lastSeq = event.seq;
      this.lastTs = event.ts;
    }

    if (event.opcode === STREAM_GAP) {
      const d = event.data as GapRecord;
      this.gapBuf.push({ fromSeq: d.fromSeq, toSeq: d.toSeq, missing: d.missing, ts: event.ts });
      return;
    }
    // A packet the module could not decode carries no fields; the *fact* of it
    // is already in the stream, and inventing values from it is exactly what
    // rule 1 forbids.
    if (isDecodeError(event.data)) return;
    // Likewise for a payload that did not match this SDK revision's schema: the
    // opcode is known but the fields are not the ones we can read (PROTOCOL.md
    // warns that non-SAY chat sub-types vary the header). Reading them anyway
    // would write undefined into the cache and call it an observation.
    if ("schemaError" in event && event.schemaError !== undefined) return;

    switch (event.opcode) {
      case "SMSG_CHAR_ENUM": {
        const d = event.data as { characters: CharacterSummary[] };
        this.characters = {
          value: d.characters.map((c) => ({
            guid: c.guid,
            name: c.name,
            race: c.race,
            class: c.class,
            gender: c.gender,
            level: c.level,
          })),
          seq: event.seq,
          ts: event.ts,
        };
        this.adoptOwnCharacter();
        return;
      }
      case "WB_SESSION_STATE": {
        // Reattach snapshot for a live session: the login-verify equivalent the
        // stream cannot re-emit. Reconcile identity like the seed does; a
        // contradicting guid is an anomaly, never an overwrite.
        const d = event.data as {
          character: string; guid: GuidKey; map: number; x: number; y: number;
          z: number; o: number; level: number; mapName?: string; instanceType?: number;
          zoneId?: number; zoneName?: string; areaId?: number; areaName?: string;
          replay?: boolean;
        };
        if (this.seed.guid !== undefined && this.seed.guid !== d.guid) {
          this.anomalyBuf.push({
            seq: event.seq,
            ts: event.ts,
            kind: "session_state_guid_mismatch",
            detail: `WB_SESSION_STATE guid ${d.guid} != seeded ${this.seed.guid}`,
          });
          return;
        }
        if (this.seed.guid === undefined) this.seedSelf({ guid: d.guid, name: d.character });
        // A replay follows: the module is about to restate everything a
        // client holds, own items included, so nothing seen before it is
        // still vouched for. A restarted child has nothing here anyway; a
        // reopened socket in a live child may hold objects that left view
        // while it was down, and a replayed set that lacks them is the
        // truth. Self fields stay: the create block that follows restates
        // every non-zero one, as the login's does.
        if (d.replay === true) {
          this.forgetAllNearby();
          this.replayPending = true;
        } else {
          this.evictOnMapChange(d.map);
        }
        this.selfMap = d.map;
        this.self.position = {
          value: { map: d.map, x: d.x, y: d.y, z: d.z, o: d.o },
          seq: event.seq,
          ts: event.ts,
        };
        // No `endSelfSpline()`: a reattach is the stream's, not the
        // character's — a flight in progress still lands where its spline ends.
        this.self.level = { value: d.level, seq: event.seq, ts: event.ts };
        if (d.zoneId !== undefined && d.areaId !== undefined) {
          this.self.zone = { value: { id: d.zoneId, name: d.zoneName ?? "" }, seq: event.seq, ts: event.ts };
          this.self.area = { value: { id: d.areaId, name: d.areaName ?? "" }, seq: event.seq, ts: event.ts };
        }
        this.foldMap(d.map, d.mapName, d.instanceType, event.seq, event.ts);
        return;
      }
      case "WB_AREA": {
        // The module reads the server's zone/area pair for this character —
        // the same pair a client computes from its own map files — and names
        // it from the client's AreaTable.dbc (PROTOCOL.md). One event per
        // change, the first at login.
        const d = event.data as {
          mapId: number; mapName?: string; instanceType?: number;
          zoneId: number; zoneName: string; areaId: number; areaName: string;
        };
        this.self.zone = { value: { id: d.zoneId, name: d.zoneName }, seq: event.seq, ts: event.ts };
        this.self.area = { value: { id: d.areaId, name: d.areaName }, seq: event.seq, ts: event.ts };
        this.foldMap(d.mapId, d.mapName, d.instanceType, event.seq, event.ts);
        this.placeGraveyard(false);
        return;
      }
      case "WB_REPLAY_DONE":
        // The mark that closes a reattach replay. Everything it vouches for
        // arrived as ordinary frames before it; the cache has nothing to add.
        // A replay that stopped short (`incomplete`) never sent its self
        // create, so the next ordinary one must merge as usual.
        this.replayPending = false;
        return;
      case "WB_PORTALS": {
        // The portals in view, the whole set on each change (PROTOCOL.md).
        const d = event.data as {
          mapId: number;
          portals: { triggerId: number; x: number; y: number; z: number; toMap: number; toMapName?: string; toInstanceType?: number }[];
        };
        const portals: PortalInView[] = d.portals.map((p) => ({
          triggerId: p.triggerId,
          map: d.mapId,
          x: p.x,
          y: p.y,
          z: p.z,
          to: {
            id: p.toMap,
            name: p.toMapName,
            instanceType: p.toInstanceType === undefined ? undefined : INSTANCE_TYPES[p.toInstanceType],
          },
        }));
        this.self.portals = { value: portals, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_LOGIN_VERIFY_WORLD":
      case "SMSG_NEW_WORLD": {
        // The two packets that carry a map id to a client: login, and every
        // far teleport after it (a portal, a graveyard port on another map).
        // Same fold for both; NEW_WORLD additionally closes a pending transfer.
        const d = event.data as WorldPosition;
        this.evictOnMapChange(d.map);
        if (event.opcode === "SMSG_LOGIN_VERIFY_WORLD") {
          this.forgetQuestGiverMarkers();
          this.redateQuestGiverMarkerInputs(event.seq, event.ts);
          // The new session restates the quest log from the server's fields,
          // which hold the completion bit but not an exploration credit.
          this.questExplored.clear();
          // A fresh login has no dialog open: an old session's offer is gone.
          this.resurrectOffer = undefined;
          this.self.casting = undefined;
          // Nor a channel, combo points, totems or a mirror bar: a logout
          // ends all four. The runes start over too: the login's self block
          // re-seeds the base layout, and its aura applications re-announce
          // any conversion.
          this.self.channeling = undefined;
          this.self.comboPoints = undefined;
          this.self.totems = [];
          this.self.mirrorTimers = [];
          this.runeReadyMask = undefined;
          this.runeTypes = undefined;
          this.self.runes = undefined;
        }
        // The new map's name arrives on its WB_AREA; until then only the id
        // (position.map) is known, so the old map's name is not kept.
        if (this.self.map !== undefined && this.self.map.value.id !== d.map) this.self.map = undefined;
        // The old map's portals are not in view on the new one; its own report follows.
        if (this.selfMap !== d.map) this.self.portals = undefined;
        this.selfMap = d.map;
        this.self.position = {
          value: { map: d.map, x: d.x, y: d.y, z: d.z, o: d.o },
          seq: event.seq,
          ts: event.ts,
        };
        this.self.transfer = undefined;
        // A flight that crosses a map is flown as one spline per map: the
        // server launches the next one after the transfer.
        this.endSelfSpline();
        // The character is its own mover again once it is in the map
        // (`Player::SendInitialPacketsAfterAddToMap`), and no seat survives
        // a map change; the next control update says the rest.
        this.self.control = undefined;
        this.self.vehicle = undefined;
        return;
      }
      case "SMSG_TRANSFER_PENDING": {
        const d = event.data as { map: number };
        this.self.transfer = { value: { toMap: d.map }, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_TRANSFER_ABORTED": {
        this.self.transfer = undefined;
        return;
      }
      case "SMSG_DEATH_RELEASE_LOC": {
        // `map: -1` is the clear marker — the first thing `ResurrectPlayer`
        // sends — so it ends both the corpse and the graveyard. Otherwise it
        // is the graveyard the spirit was released to.
        const d = event.data as { map: number; x: number; y: number; z: number };
        if (d.map < 0) {
          this.self.corpse = undefined;
          this.self.graveyard = undefined;
          this.self.reclaimDelay = undefined;
          this.resurrectOffer = undefined;
          return;
        }
        this.self.graveyard = { value: { map: d.map, x: d.x, y: d.y, z: d.z }, seq: event.seq, ts: event.ts };
        this.placeGraveyard(true);
        return;
      }
      case "SMSG_RESURRECT_REQUEST": {
        const d = event.data as ResurrectRequestData;
        this.resurrectOffer = { ...d, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_CORPSE_RECLAIM_DELAY": {
        const d = event.data as { delayMs: number };
        this.self.reclaimDelay = {
          value: { delayMs: d.delayMs, readyAt: event.ts + d.delayMs },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "MSG_CORPSE_QUERY": {
        // The server's own word on where the corpse is, replacing the
        // death-spot fallback. "Not found" is an answer too: there is no
        // corpse to reclaim (healer resurrection, expiry), so nothing is kept.
        const d = event.data as {
          found: boolean; map?: number; x?: number; y?: number; z?: number; corpseMap?: number;
        };
        if (!d.found || d.map === undefined || d.x === undefined || d.y === undefined || d.z === undefined) {
          this.self.corpse = undefined;
          return;
        }
        // The two maps differ only for a corpse inside a dungeon asked about
        // from outside it: the position is then the dungeon's entrance.
        const inside = d.corpseMap !== undefined && d.corpseMap !== d.map ? { instanceMap: d.corpseMap } : {};
        this.self.corpse = {
          value: { map: d.map, x: d.x, y: d.y, z: d.z, source: "corpse_query", ...inside },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_QUESTGIVER_QUEST_COMPLETE": {
        // The turn-in receipt. The quest leaves the log when it is rewarded, so
        // this packet is the only place the completion is ever observable.
        const d = event.data as { questId: number; xp?: number; money?: number };
        this.questDoneBuf.push({
          questId: d.questId,
          xp: d.xp,
          money: d.money,
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_QUESTUPDATE_COMPLETE": {
        // The exploration or event credit (`Player::AreaExploredOrEventHappens`
        // is its only sender): sent once per accept, whether or not the rest of
        // the quest is done, so it is the only report of an explore objective
        // on a quest that still has kills or items open. The quest-log fields
        // carry no such flag.
        const d = event.data as { questId: number };
        this.questExplored.add(d.questId);
        return;
      }
      case "SMSG_QUESTGIVER_STATUS": {
        const d = event.data as QuestGiverStatusData;
        this.applyQuestGiverStatus(d.guid, d.status, event.seq, event.ts);
        return;
      }
      case "SMSG_QUESTGIVER_STATUS_MULTIPLE": {
        const d = event.data as QuestGiverStatusMultipleData;
        for (const row of d.statuses) this.applyQuestGiverStatus(row.guid, row.status, event.seq, event.ts);
        return;
      }
      case "SMSG_QUEST_QUERY_RESPONSE": {
        const d = event.data as QuestQueryResponseData;
        this.quests.set(d.questId, {
          value: {
            questId: d.questId,
            title: d.title,
            level: d.level,
            minLevel: d.minLevel,
            flags: d.flags,
            objectivesText: d.objectives,
            details: d.details,
            areaDescription: d.areaDescription,
            completedText: d.completedText,
            requiredNpcOrGo: d.requiredNpcOrGo.map((r) => ({ entry: r.entry, count: r.count, text: r.text })),
            requiredItems: d.requiredItems.map((r) => ({ itemId: r.itemId, count: r.count })),
          },
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_QUEST_POI_QUERY_RESPONSE": {
        const d = event.data as QuestPoiQueryResponseData;
        for (const q of d.quests) {
          if (q.pois.length === 0 && (this.questPois.get(q.questId)?.value.length ?? 0) > 0) continue;
          this.questPois.set(q.questId, { value: q.pois, seq: event.seq, ts: event.ts });
        }
        return;
      }
      case "SMSG_INITIAL_SPELLS": {
        const d = event.data as InitialSpellsData;
        this.spellBook.clear();
        for (const row of d.spells) {
          this.spellBook.set(row.spellId, { spellId: row.spellId, rank: row.rank, name: row.name, seq: event.seq, ts: event.ts });
          if (row.name !== undefined) this.spellNamesSeen.set(row.spellId, row.name);
        }
        for (const cd of d.cooldowns) {
          const infinite = cd.categoryCooldownMs === 0x80000000;
          const ms = cd.cooldownMs || cd.categoryCooldownMs;
          this.cooldownMap.set(cd.spellId, {
            spellId: cd.spellId,
            cooldownMs: infinite ? undefined : ms,
            readyAt: infinite ? Number.POSITIVE_INFINITY : event.ts + ms,
            seq: event.seq,
            ts: event.ts,
          });
        }
        return;
      }
      case "SMSG_LEARNED_SPELL": {
        const d = event.data as LearnedSpellData;
        this.spellBook.set(d.spellId, { spellId: d.spellId, rank: d.rank, name: d.name, seq: event.seq, ts: event.ts });
        if (d.name !== undefined) this.spellNamesSeen.set(d.spellId, d.name);
        return;
      }
      case "SMSG_REMOVED_SPELL": {
        const d = event.data as RemovedSpellData;
        this.spellBook.delete(d.spellId);
        return;
      }
      case "SMSG_SUPERCEDED_SPELL": {
        const d = event.data as SupersededSpellData;
        this.spellBook.delete(d.supersededSpellId);
        this.spellBook.set(d.spellId, { spellId: d.spellId, rank: d.rank, name: d.name, seq: event.seq, ts: event.ts });
        if (d.name !== undefined) {
          this.spellNamesSeen.set(d.spellId, d.name);
          this.spellNamesSeen.set(d.supersededSpellId, d.name);
        }
        return;
      }
      case "SMSG_SPELL_START": {
        const d = event.data as SpellStartData;
        if (!this.isSelfGuid(d.casterGuid) || d.castTimeMs <= 0) return;
        const name = this.spellBook.get(d.spellId)?.name ?? this.spellNamesSeen.get(d.spellId);
        this.self.casting = { value: { spellId: d.spellId, name, endsAt: event.ts + d.castTimeMs }, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_SPELL_GO":
      case "SMSG_SPELL_FAILURE": {
        const d = event.data as SpellGoData | SpellFailureData;
        if (!this.isSelfGuid(d.casterGuid)) return;
        if (this.self.casting?.value.spellId === d.spellId) this.self.casting = undefined;
        if (event.opcode === "SMSG_SPELL_FAILURE" && this.self.channeling?.value.spellId === d.spellId) this.self.channeling = undefined;
        const after = (d as SpellGoData).runesAfter;
        if (event.opcode === "SMSG_SPELL_GO" && after !== undefined) {
          this.runeReadyMask = after;
          this.publishRunes(event.seq, event.ts);
        }
        return;
      }
      case "SMSG_UPDATE_COMBO_POINTS": {
        const d = event.data as UpdateComboPointsData;
        this.self.comboPoints = {
          value: { points: d.points, targetGuid: d.targetGuid === "0" ? undefined : d.targetGuid },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_CONVERT_RUNE": {
        const d = event.data as ConvertRuneData;
        if (d.index < 0 || d.index >= BASE_RUNE_TYPES.length) return;
        this.runeTypes ??= [...BASE_RUNE_TYPES];
        this.runeTypes[d.index] = d.runeType;
        this.publishRunes(event.seq, event.ts);
        return;
      }
      case "MSG_CHANNEL_START": {
        const d = event.data as ChannelStartData;
        if (!this.isSelfGuid(d.casterGuid)) return;
        const name = d.name ?? this.spellBook.get(d.spellId)?.name ?? this.spellNamesSeen.get(d.spellId);
        this.self.channeling = {
          value: { spellId: d.spellId, name, endsAt: event.ts + d.durationMs, targetGuid: this.selfChannelObject },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "MSG_CHANNEL_UPDATE": {
        const d = event.data as ChannelUpdateData;
        if (!this.isSelfGuid(d.casterGuid) || this.self.channeling === undefined) return;
        this.self.channeling =
          d.timeMs === 0
            ? undefined
            : { value: { ...this.self.channeling.value, endsAt: event.ts + d.timeMs }, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_TOTEM_CREATED": {
        const d = event.data as TotemCreatedData;
        const totem: TotemSlot = {
          slot: d.slot,
          element: TOTEM_ELEMENTS[d.slot],
          guid: d.guid,
          spellId: d.spellId,
          name: d.name ?? this.spellNamesSeen.get(d.spellId),
          durationMs: d.durationMs,
          expiresAt: event.ts + d.durationMs,
          seq: event.seq,
          ts: event.ts,
        };
        this.self.totems = [...this.self.totems.filter((t) => t.slot !== d.slot), totem].sort((a, b) => a.slot - b.slot);
        return;
      }
      case "SMSG_START_MIRROR_TIMER": {
        const d = event.data as StartMirrorTimerData;
        const timer: MirrorTimer = {
          type: MIRROR_TIMER_TYPES[d.type],
          typeId: d.type,
          value: d.value,
          max: d.max,
          scale: d.scale,
          paused: d.paused,
          seq: event.seq,
          ts: event.ts,
        };
        this.self.mirrorTimers = [...this.self.mirrorTimers.filter((t) => t.typeId !== d.type), timer].sort((a, b) => a.typeId - b.typeId);
        return;
      }
      case "SMSG_STOP_MIRROR_TIMER": {
        const d = event.data as StopMirrorTimerData;
        this.self.mirrorTimers = this.self.mirrorTimers.filter((t) => t.typeId !== d.type);
        return;
      }
      case "SMSG_SPELL_DELAYED": {
        const d = event.data as SpellDelayedData;
        const c = this.self.casting;
        if (!this.isSelfGuid(d.casterGuid) || c === undefined) return;
        this.self.casting = { value: { ...c.value, endsAt: c.value.endsAt + d.delayMs }, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_SET_PROFICIENCY": {
        const d = event.data as SetProficiencyData;
        if (d.itemClass !== ITEM_CLASS_WEAPON && d.itemClass !== ITEM_CLASS_ARMOR) return;
        const was = this.self.proficiency?.value;
        this.self.proficiency = {
          value: {
            weaponMask: d.itemClass === ITEM_CLASS_WEAPON ? d.subclassMask : was?.weaponMask,
            armorMask: d.itemClass === ITEM_CLASS_ARMOR ? d.subclassMask : was?.armorMask,
          },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_SPELL_COOLDOWN": {
        const d = event.data as SpellCooldownData;
        // Sent to this session for its own character (or its pet): a guid
        // that is observably someone else is not our cooldown.
        if (this.self.guid !== undefined && d.guid !== this.self.guid) return;
        for (const cd of d.cooldowns) {
          this.cooldownMap.set(cd.spellId, {
            spellId: cd.spellId,
            cooldownMs: cd.cooldownMs,
            readyAt: event.ts + cd.cooldownMs,
            seq: event.seq,
            ts: event.ts,
          });
        }
        return;
      }
      case "SMSG_COOLDOWN_EVENT": {
        const d = event.data as CooldownEventData;
        if (this.self.guid !== undefined && d.guid !== this.self.guid) return;
        this.cooldownMap.set(d.spellId, { spellId: d.spellId, cooldownMs: undefined, readyAt: undefined, seq: event.seq, ts: event.ts });
        return;
      }
      case "SMSG_CLEAR_COOLDOWN": {
        const d = event.data as CooldownEventData;
        if (this.self.guid !== undefined && d.guid !== this.self.guid) return;
        this.cooldownMap.delete(d.spellId);
        return;
      }
      case "SMSG_TALENTS_INFO": {
        const d = event.data as TalentsInfoData;
        if (d.pet) return; // no pet surface
        const activeSpec = d.activeSpec ?? 0;
        const spec = d.specs?.[activeSpec];
        this.talentState = {
          unspentPoints: d.unspentPoints ?? 0,
          activeSpec,
          specCount: d.specCount ?? 0,
          talents: (spec?.talents ?? []).map((t) => ({ talentId: t.talentId, rank: t.rank })),
          glyphs: (spec?.glyphs ?? []).map((g) => ({ slot: g.slot, glyphId: g.glyphId, spellId: g.spellId, name: g.name })),
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      /*
       * Achievements and flight paths (issue #8). The earn is a
       * say-range broadcast, so `self` — not the opcode — is what makes it
       * ours; another player's achievement is not an observation about this
       * character and is dropped here rather than filtered downstream.
       */
      case "SMSG_ACHIEVEMENT_EARNED": {
        const d = event.data as AchievementEarnedData;
        // Another player's earn still names the achievement its chat line links.
        this.noteAchievementName(d.achievement);
        if (d.self !== true) return;
        this.addAchievement(d.achievement, "earned", event.seq, event.ts);
        return;
      }
      case "SMSG_ALL_ACHIEVEMENT_DATA": {
        const d = event.data as AllAchievementData;
        this.achievementsLoginSeen = true;
        for (const a of d.achievements) this.addAchievement(a, "login", event.seq, event.ts);
        this.rebuildAchievements();
        return;
      }
      case "SMSG_ACTIVATETAXIREPLY": {
        const d = event.data as ActivateTaxiReplyData;
        this.self.taxiReply = { value: { reply: d.reply, ok: d.ok }, seq: event.seq, ts: event.ts };
        // The flight's spline follows this reply (`Player::ActivateTaxiPathTo`
        // answers, then launches it), so any older self spline is not this
        // flight's.
        if (d.ok) this.selfSpline = undefined;
        return;
      }
      case "WB_TALENT_TREE": {
        const d = event.data as TalentTreeData;
        this.talentTreeData = { ...d, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_PET_SPELLS": {
        const d = event.data as PetSpellsData;
        this.petBar = d.removed || d.guid === "0" ? undefined : { ...d, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_PET_NAME_QUERY_RESPONSE": {
        const d = event.data as PetNameQueryResponseData;
        if (d.found && d.name !== undefined) this.petNames.set(d.petNumber, d.name);
        return;
      }
      case "SMSG_LOOT_START_ROLL": {
        const d = event.data as LootStartRollData;
        const allowed: RollChoice[] = ["pass"];
        if (d.canNeed) allowed.unshift("need");
        if (d.canGreed) allowed.splice(allowed.length - 1, 0, "greed");
        if (d.canDisenchant) allowed.splice(allowed.length - 1, 0, "disenchant");
        const info = this.items.get(d.itemId)?.value;
        this.rolls.set(d.rollGuid, {
          rollGuid: d.rollGuid,
          slot: d.slot,
          itemId: d.itemId,
          name: info?.name,
          quality: info?.quality,
          count: d.count,
          allowed,
          deadline: event.ts + d.countdownMs,
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_LOOT_ROLL": {
        // Our own counted vote closes the frame on a client; other voters' do not.
        const d = event.data as LootRollData;
        if (this.self.guid !== undefined && d.playerGuid === this.self.guid) this.closeRoll(d);
        return;
      }
      case "SMSG_LOOT_ROLL_WON":
      case "SMSG_LOOT_ALL_PASSED": {
        this.closeRoll(event.data as LootRollWonData | LootAllPassedData);
        return;
      }
      case "SMSG_PAGE_TEXT_QUERY_RESPONSE": {
        const d = event.data as PageTextQueryResponseData;
        this.pageTexts.set(d.pageId, { text: d.text, nextPageId: d.nextPageId });
        return;
      }
      case "SMSG_ITEM_TEXT_QUERY_RESPONSE": {
        const d = event.data as ItemTextQueryResponseData;
        if (d.found && d.guid !== undefined && d.text !== undefined) this.playerTexts.set(d.guid, d.text);
        return;
      }
      case "SMSG_GROUP_INVITE": {
        const d = event.data as GroupInviteData;
        if (d.canAccept) this.groupPatch({ pendingInvite: { inviterName: d.inviterName, seq: event.seq, ts: event.ts } }, event.seq, event.ts);
        return;
      }
      case "SMSG_GROUP_LIST": {
        const d = event.data as GroupListData;
        if (d.left) this.partyStats.clear();
        this.foldGroupList(d, event.seq, event.ts);
        return;
      }
      case "SMSG_PARTY_MEMBER_STATS":
      case "SMSG_PARTY_MEMBER_STATS_FULL": {
        this.foldPartyMemberStats(event.data as PartyMemberStatsData, event.seq, event.ts);
        return;
      }
      case "SMSG_GROUP_DESTROYED":
      case "SMSG_GROUP_UNINVITE": {
        this.partyStats.clear();
        this.groupPatch({ inGroup: false, raid: false, groupGuid: undefined, leaderGuid: undefined, leaderName: undefined, leader: false, members: [], lootMethod: undefined }, event.seq, event.ts);
        return;
      }
      case "SMSG_GROUP_SET_LEADER": {
        const d = event.data as GroupNameData;
        const prev = this.groupState;
        const byName = prev?.members.find((m) => m.name === d.name);
        const leaderGuid = byName?.guid ?? (this.self.name === d.name ? this.self.guid : undefined);
        this.groupPatch(
          {
            leaderName: d.name,
            leaderGuid: leaderGuid ?? prev?.leaderGuid,
            leader: this.self.name === d.name,
            members: (prev?.members ?? []).map((m) => ({ ...m, leader: m.name === d.name })),
          },
          event.seq,
          event.ts,
        );
        return;
      }
      case "SMSG_GROUP_DECLINE": {
        const d = event.data as GroupNameData;
        this.groupPatch({ lastDecline: { name: d.name, seq: event.seq, ts: event.ts } }, event.seq, event.ts);
        return;
      }
      case "SMSG_PARTY_COMMAND_RESULT": {
        const d = event.data as PartyCommandResultData;
        this.groupPatch(
          { lastResult: { operation: d.operation, name: d.name, result: d.result, text: partyResultText(d.result), seq: event.seq, ts: event.ts } },
          event.seq,
          event.ts,
        );
        return;
      }
      case "SMSG_SHOW_MAILBOX": {
        const d = event.data as ShowFrameData;
        this.mailPatch({ guid: d.guid }, event.seq, event.ts);
        return;
      }
      case "SMSG_RECEIVED_MAIL": {
        this.mailPatch({ newMail: true }, event.seq, event.ts);
        return;
      }
      case "SMSG_MAIL_LIST_RESULT": {
        const d = event.data as MailListResultData;
        const mails: MailEntry[] = d.mails.map((m: MailEntryData) => ({
          mailId: m.mailId,
          type: m.type,
          senderGuid: m.senderGuid,
          senderName: undefined,
          senderId: m.senderId,
          subject: m.subject,
          body: m.body,
          money: m.money,
          cod: m.cod,
          read: m.read,
          daysLeft: m.daysLeft,
          items: m.items.map((it) => ({ index: it.index, itemGuidLow: it.itemGuidLow, itemId: it.itemId, name: undefined, count: it.count })),
        }));
        this.mailPatch({ mails, total: d.total, newMail: false }, event.seq, event.ts);
        return;
      }
      case "SMSG_SEND_MAIL_RESULT": {
        const d = event.data as SendMailResultData;
        const prev = this.mailState;
        // The inbox the client shows updates itself off the verdict: taken
        // money zeroes it, a taken item leaves the list, a delete removes the mail.
        let mails = prev?.mails ?? [];
        if (d.result === 0) {
          if (d.action === 1) mails = mails.map((m) => (m.mailId === d.mailId ? { ...m, money: 0 } : m));
          else if (d.action === 2) mails = mails.map((m) => (m.mailId === d.mailId ? { ...m, items: m.items.filter((it) => it.itemGuidLow !== d.itemGuidLow) } : m));
          else if (d.action === 3 || d.action === 4) mails = mails.filter((m) => m.mailId !== d.mailId);
        }
        this.mailPatch(
          {
            mails,
            lastResult: { mailId: d.mailId, action: d.action, result: d.result, text: mailResultText(d.result), inventoryResult: d.inventoryResult, seq: event.seq, ts: event.ts },
          },
          event.seq,
          event.ts,
        );
        return;
      }
      case "SMSG_SHOW_BANK": {
        const d = event.data as ShowFrameData;
        this.bankGuid = { value: d.guid, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_TRADE_STATUS": {
        const d = event.data as TradeStatusData;
        this.foldTradeStatus(d.status, d.traderGuid, event.seq, event.ts);
        return;
      }
      case "SMSG_TRADE_STATUS_EXTENDED": {
        // One side of the window as the server holds it. The core sends it to
        // the other trader on every change (`TradeData::Update`), so it is
        // `theirs` in practice; our own side comes back only for an enchant
        // spell, and is otherwise what we placed (`tradeSent`).
        const d = event.data as TradeStatusExtendedData;
        const prev = this.tradeState ?? {
          status: 2, statusText: tradeStatusText(2), open: true, traderGuid: this.tradeProposal,
          mine: emptyTradeSide(event.seq), theirs: emptyTradeSide(event.seq), seq: event.seq, ts: event.ts,
        };
        const side: TradeSide = { money: d.money, items: d.items.map((it) => ({ slot: it.slot, itemId: it.itemId, name: undefined, count: it.count })), seq: event.seq };
        this.tradeState = { ...prev, open: true, mine: d.theirs ? prev.mine : side, theirs: d.theirs ? side : prev.theirs, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_INITIALIZE_FACTIONS": {
        // The login list replaces whatever a previous session left: the
        // server re-sends every row it has, and a faction it no longer
        // lists is one the client would not show either.
        const d = event.data as InitializeFactionsData;
        this.reputationMap.clear();
        for (const row of d.factions) this.foldFactionRow(row, event.seq, event.ts);
        return;
      }
      case "SMSG_SET_FACTION_STANDING": {
        const d = event.data as SetFactionStandingData;
        for (const row of d.factions) this.foldFactionRow(row, event.seq, event.ts);
        return;
      }
      case "SMSG_SET_FACTION_VISIBLE": {
        const d = event.data as SetFactionVisibleData;
        const prev = this.reputationMap.get(d.repListId);
        if (prev !== undefined) {
          this.reputationMap.set(d.repListId, { ...prev, visible: true, seq: event.seq, ts: event.ts });
        } else {
          this.foldFactionRow({ repListId: d.repListId, factionId: d.factionId, name: d.name, standing: 0, visible: true }, event.seq, event.ts);
        }
        return;
      }
      case "SMSG_SHOWTAXINODES": {
        // The flight master's window, per NPC. `known` is the module's decode
        // of the mask plus the client's TaxiNodes.dbc names; the mask itself
        // rides along verbatim so nothing about the fold is unverifiable.
        const d = event.data as ShowTaxiNodesData;
        const known: TaxiNodeRef[] = d.known.map((n) => ({ nodeId: n.nodeId, name: n.name, map: n.map, x: n.x, y: n.y, z: n.z }));
        const inKnown = known.find((n) => n.nodeId === d.currentNode);
        const current: TaxiNodeRef = {
          nodeId: d.currentNode,
          name: d.currentNodeName ?? inKnown?.name,
          map: d.currentPos?.map ?? inKnown?.map,
          x: d.currentPos?.x ?? inKnown?.x,
          y: d.currentPos?.y ?? inKnown?.y,
          z: d.currentPos?.z ?? inKnown?.z,
        };
        this.taxiWindows.set(d.guid, {
          guid: d.guid,
          current,
          known,
          mask: [...d.mask],
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_BINDPOINTUPDATE": {
        const d = event.data as BindPointUpdateData;
        this.self.bindPoint = {
          value: { map: d.map, x: d.x, y: d.y, z: d.z, area: { id: d.areaId, name: d.areaName } },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_NAME_QUERY_RESPONSE": {
        const d = event.data as { guid: GuidKey; found: boolean; name?: string };
        if (d.found && d.name !== undefined) {
          this.names.set(d.guid, { value: d.name, seq: event.seq, ts: event.ts });
          const obj = this.nearby.get(d.guid);
          if (obj) this.joinName(obj);
        }
        return;
      }
      case "SMSG_CREATURE_QUERY_RESPONSE": {
        const d = event.data as {
          entry: number;
          found: boolean;
          name?: string;
          subname?: string;
          type?: number;
          rank?: number;
        };
        if (!d.found || d.name === undefined) return;
        this.creatures.set(d.entry, {
          value: {
            entry: d.entry,
            name: d.name,
            // The module sends "" for a creature with no subname; an empty
            // string is not a subname, so it does not become one.
            subname: d.subname === undefined || d.subname === "" ? undefined : d.subname,
            type: d.type,
            rank: d.rank,
          },
          seq: event.seq,
          ts: event.ts,
        });
        for (const obj of this.nearby.values()) {
          if (obj.entry?.value === d.entry) this.joinName(obj);
        }
        return;
      }
      case "SMSG_GAMEOBJECT_QUERY_RESPONSE": {
        const d = event.data as GameObjectQueryResponseData;
        if (!d.found || d.name === undefined) return;
        this.gameObjects.set(d.entry, {
          value: {
            entry: d.entry,
            name: d.name,
            type: d.type,
            displayId: d.displayId,
            castBarCaption: d.castBarCaption === undefined || d.castBarCaption === "" ? undefined : d.castBarCaption,
          },
          seq: event.seq,
          ts: event.ts,
        });
        for (const obj of this.nearby.values()) {
          if (obj.objectType?.value === "gameObject" && obj.entry?.value === d.entry) this.joinName(obj);
        }
        return;
      }
      case "WB_TRANSPORT_PROGRESS": {
        // The car moved (or did not): a client animating the transport from
        // its own DBC knows exactly this. A report with `inRange: false` is
        // the last one until the car is back in range, and carries no
        // `docked`, so a car that left a platform never reads docked there.
        // The object stays in `nearby` only
        // if the update stream put it there; a report for a guid never
        // created still means the server sent the car, so it is upserted the
        // way a `values` delta for an unseen guid is.
        const d = event.data as TransportProgressData;
        this.upsertNearby(d.guid, event.seq, (obj) => {
          if (obj.entry === undefined) obj.entry = { value: d.entry, seq: event.seq, ts: event.ts };
          obj.position = { value: toUnitPosition(d.pos), seq: event.seq, ts: event.ts };
          const docks = [...(obj.transport?.value.docks ?? [])];
          if (d.docked === true && !docks.some((k) => Math.hypot(k.x - d.pos.x, k.y - d.pos.y) < 5)) {
            docks.push({ x: d.pos.x, y: d.pos.y, z: d.pos.z });
          }
          obj.transport = {
            value: { progressMs: d.progressMs, periodMs: d.periodMs, docked: d.docked, inRange: d.inRange !== false, docks },
            seq: event.seq,
            ts: event.ts,
          };
          this.joinName(obj);
        });
        return;
      }
      case "SMSG_ITEM_QUERY_SINGLE_RESPONSE": {
        const d = event.data as ItemQueryResponseData;
        if (!d.found || d.name === undefined) return;
        this.items.set(d.itemId, {
          value: {
            itemId: d.itemId,
            name: d.name,
            quality: d.quality,
            inventoryType: d.inventoryType,
            itemLevel: d.itemLevel,
            requiredLevel: d.requiredLevel,
            sellPrice: d.sellPrice,
            buyPrice: d.buyPrice,
            class: d.class,
            subClass: d.subClass,
            requiredSkill:
              d.requiredSkill !== undefined && d.requiredSkill !== 0
                ? { id: d.requiredSkill, rank: d.requiredSkillRank ?? 0, name: d.requiredSkillName }
                : undefined,
            requiredReputation:
              d.requiredReputationFaction !== undefined && d.requiredReputationFaction !== 0
                ? { factionId: d.requiredReputationFaction, rank: d.requiredReputationRank ?? 0, name: d.requiredReputationFactionName }
                : undefined,
            maxCount: d.maxCount,
            stackable: d.stackable,
            containerSlots: d.containerSlots,
            stats: d.stats === undefined ? undefined : d.stats.map((s) => ({ type: s.type, value: s.value })),
            damage: d.damage === undefined ? undefined : d.damage.map((x) => ({ min: x.min, max: x.max, type: x.type })),
            armor: d.armor,
            resistances: d.resistances === undefined ? undefined : { ...d.resistances },
            speedMs: d.speedMs,
            spells: d.spells === undefined ? undefined : d.spells.map((s) => ({ spellId: s.spellId, trigger: s.trigger, charges: s.charges, name: s.name })),
            bonding: d.bonding,
            description: d.description,
            startQuest: d.startQuest,
            pageText: d.pageText,
            block: d.block,
            maxDurability: d.maxDurability,
          },
          seq: event.seq,
          ts: event.ts,
        });
        for (const obj of this.nearby.values()) {
          if (obj.entry?.value === d.itemId) this.joinName(obj);
        }
        return;
      }
      case "SMSG_AURA_UPDATE":
      case "SMSG_AURA_UPDATE_ALL": {
        const d = event.data as AuraUpdateData;
        const key = d.targetGuid;
        // UPDATE_ALL is the full visible list, so it replaces; UPDATE names
        // only the slots that changed and merges into what is already there.
        const slots =
          event.opcode === "SMSG_AURA_UPDATE_ALL"
            ? new Map<number, AuraEntry>()
            : (this.auraSlots.get(key) ?? new Map<number, AuraEntry>());
        for (const a of d.auras as AuraData[]) {
          if (a.removed === true || a.spellId === 0) {
            slots.delete(a.slot);
            continue;
          }
          slots.set(a.slot, {
            slot: a.slot,
            spellId: a.spellId,
            flags: a.flags,
            level: a.level,
            stacks: a.stacks,
            casterGuid: a.casterGuid,
            maxDuration: a.maxDuration,
            duration: a.duration,
            expiresAt: a.duration !== undefined && a.duration > 0 ? event.ts + a.duration : undefined,
            name: a.name,
            seq: event.seq,
            ts: event.ts,
          });
        }
        if (slots.size === 0) this.auraSlots.delete(key);
        else this.auraSlots.set(key, slots);
        return;
      }
      case "SMSG_CLIENT_CONTROL_UPDATE": {
        // Which unit we move. Granted: that unit. Withheld for the unit we
        // were moving (a handover ending) or for ourselves (a fear): we are
        // our own mover and may not move it, until the grant that follows.
        const d = event.data as ClientControlUpdateData;
        const mover = this.self.control?.value.mover ?? this.self.guid;
        if (d.allowMove) {
          this.self.control = { value: { mover: d.guid, allowMove: true }, seq: event.seq, ts: event.ts };
        } else if (mover === undefined || d.guid === mover || this.isSelfGuid(d.guid)) {
          this.self.control = { value: { mover: this.self.guid ?? d.guid, allowMove: false }, seq: event.seq, ts: event.ts };
        }
        return;
      }
      case "SMSG_MONSTER_MOVE_TRANSPORT": {
        // A spline in a transport's frame. Ours with a seat is the boarding
        // spline onto a vehicle seat; its points are seat-relative, so no
        // position or spline is folded from it. Another unit's says nothing
        // a world position could carry either.
        const d = event.data as MonsterMoveTransportData;
        if (this.isSelfGuid(d.guid) && d.seat >= 0) {
          this.self.vehicle = { value: { guid: d.transportGuid, seat: d.seat }, seq: event.seq, ts: event.ts };
        }
        return;
      }
      case "SMSG_MONSTER_MOVE": {
        const d = event.data as MonsterMoveData;
        if (this.isSelfGuid(d.guid)) {
          // Our own character on a server spline: a taxi flight
          // (`MoveSplineInit::Launch` sends it to the flier too), or the
          // exit spline off a vehicle seat. Never a nearby object.
          if (d.transportExit === true) this.self.vehicle = undefined;
          this.applySelfSpline(d, event.seq, event.ts);
          return;
        }
        this.upsertNearby(d.guid, event.seq, (obj) => {
          obj.motion = {
            value: {
              position: { x: d.pos.x, y: d.pos.y, z: d.pos.z },
              destination: d.destination
                ? { x: d.destination.x, y: d.destination.y, z: d.destination.z }
                : undefined,
              durationMs: d.durationMs,
              stopped: d.stopped === true,
            },
            seq: event.seq,
            ts: event.ts,
          };
          this.joinName(obj);
        });
        return;
      }
      case "SMSG_UPDATE_OBJECT": {
        const d = event.data as { objects: UpdateBlock[] };
        for (const block of d.objects) this.applyUpdateBlock(block, event.seq, event.ts);
        return;
      }
      case "SMSG_DESTROY_OBJECT": {
        const d = event.data as { guid: GuidKey };
        this.forget(d.guid);
        if (this.self.totems.some((t) => t.guid === d.guid)) this.self.totems = this.self.totems.filter((t) => t.guid !== d.guid);
        return;
      }
      case "WB_MOVE_PROGRESS":
      case "WB_RIDE_PROGRESS":
      case "WB_SELF_MOVE":
      case "WB_MOVE_RESULT": {
        // Our own position while moving: the module's movement engine knows it
        // locally, exactly as a running client does. `WB_MOVE_RESULT.pos` is
        // read back from the live character, so it is the server's word.
        // `WB_SELF_MOVE` is a movement packet the module sent outside a move —
        // the client's own drop to the ground after a taxi landing — and its
        // `pos` is where the character stands, under the spline's last point.
        //
        // Except on `transferred`: the module reads the character back *before*
        // the teleport lands, so that `pos` is "the last old-map position"
        // (PROTOCOL.md). `SMSG_NEW_WORLD` carries the arrival point and can
        // land either side of the result (client.ts moveTo says so and passes
        // its own `sinceSeq` for exactly that reason), so folding it would pair
        // old-map x/y/z with the new map id — a WorldPosition the character was
        // never at, which is the invention `self_position_without_map` exists
        // to refuse. The arrival comes from `SMSG_NEW_WORLD` alone.
        //
        // Likewise on `teleported` (a same-map port): `pos` is the pre-teleport
        // position, and the arrival point came on the `MSG_MOVE_TELEPORT_ACK`
        // the server sent *before* this result — folding `pos` here would
        // overwrite the arrival with where the character left from.
        const d = event.data as { pos: PositionData; status?: string; mover?: GuidKey };
        // A walk of another unit (`mover`: the vehicle or possessed unit the
        // client moves) is that unit's position, folded onto it in view. The
        // character rides a vehicle it sits in, so its own position follows
        // that one; a possessed unit flies off while the character stands.
        if (d.mover !== undefined && !this.isSelfGuid(d.mover)) {
          this.upsertNearby(d.mover, event.seq, (obj) => {
            obj.position = { value: { x: d.pos.x, y: d.pos.y, z: d.pos.z, o: d.pos.o }, seq: event.seq, ts: event.ts };
          });
          if (this.self.vehicle?.value.guid !== d.mover) return;
        }
        // The character moving under its own control is off any server
        // spline, so a later landing has nothing to put it at.
        this.endSelfSpline();
        if (event.opcode === "WB_MOVE_RESULT" && (d.status === "transferred" || d.status === "teleported")) return;
        this.applySelfPosition(d.pos, event.seq, event.ts);
        return;
      }
      case "SMSG_MESSAGECHAT": {
        const d = event.data as Omit<ChatEntry, "seq" | "ts">;
        this.chatBuf.push({
          seq: event.seq,
          ts: event.ts,
          type: d.type,
          language: d.language,
          senderGuid: d.senderGuid,
          ...(d.senderName !== undefined ? { senderName: d.senderName } : {}),
          ...(d.receiverGuid !== undefined ? { receiverGuid: d.receiverGuid } : {}),
          ...(d.receiverName !== undefined ? { receiverName: d.receiverName } : {}),
          ...(d.channelName !== undefined ? { channelName: d.channelName } : {}),
          message: chatMessageAsShown(d.type, d.message, d.senderName),
          chatTag: d.chatTag,
          ...(d.achievementId !== undefined ? { achievementId: d.achievementId } : {}),
        });
        if (this.chatBuf.length > this.chatTail) {
          this.chatBuf.splice(0, this.chatBuf.length - this.chatTail);
        }
        return;
      }
      case "SMSG_NOTIFICATION": {
        const d = event.data as { text: string };
        this.notifyBuf.push({ seq: event.seq, ts: event.ts, text: d.text });
        if (this.notifyBuf.length > this.notificationTail) {
          this.notifyBuf.splice(0, this.notifyBuf.length - this.notificationTail);
        }
        return;
      }
      case "SMSG_MOTD": {
        const d = event.data as { lines: string[] };
        this.motd = { value: [...d.lines], seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_GOSSIP_MESSAGE": {
        // The open menu for this NPC. Only `optionId`/`text` are folded — the
        // two fields `gossipSelect` resolves against; the quests ride the same
        // packet and are read straight off the event by the quest helpers.
        const d = event.data as {
          guid: GuidKey;
          menuId: number;
          options: readonly { optionId: number; text: string }[];
        };
        this.gossipMenus.set(d.guid, {
          guid: d.guid,
          menuId: d.menuId,
          options: d.options.map((o) => ({ optionId: o.optionId, text: o.text })),
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_GOSSIP_COMPLETE": {
        // The client's gossip window closed. The packet names no guid, so the
        // only honest fold is "nothing is open" — keeping a per-guid menu alive
        // past this would let a select fire against a stale menu.
        this.gossipMenus.clear();
        return;
      }
      case "SMSG_LIST_INVENTORY": {
        // The vendor's stock, per NPC. The packet's rows are kept verbatim —
        // the price is already the discounted one the client shows, and what is
        // affordable or worth buying is the caller's read, not the cache's.
        const d = event.data as ListInventoryData;
        this.vendorWindows.set(d.vendorGuid, {
          guid: d.vendorGuid,
          items: d.items.map((i) => ({ ...i })),
          emptyReason: d.emptyReason,
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_TRAINER_LIST": {
        const d = event.data as TrainerListData;
        this.trainerWindows.set(d.guid, {
          guid: d.guid,
          trainerType: d.trainerType,
          spells: d.spells.map((sp) => ({ ...sp })),
          greeting: d.greeting,
          seq: event.seq,
          ts: event.ts,
        });
        return;
      }
      case "SMSG_LOOT_RESPONSE": {
        const d = event.data as LootResponseData;
        // The refusal form opens nothing: a client shows an error line and
        // keeps whatever frame it had.
        if (isLootError(d)) return;
        this.lootWin = {
          guid: d.guid,
          lootType: d.lootType,
          gold: d.gold,
          items: d.items.map((i) => ({ ...i })),
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_LOOT_REMOVED": {
        // One slot was taken (by us or, in a group, by someone else): the
        // client removes that row from the frame, so the cache does too.
        const d = event.data as LootRemovedData;
        if (this.lootWin === undefined) return;
        this.lootWin = {
          ...this.lootWin,
          items: this.lootWin.items.filter((i) => i.slot !== d.slot),
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_LOOT_CLEAR_MONEY": {
        if (this.lootWin === undefined) return;
        this.lootWin = { ...this.lootWin, gold: 0, seq: event.seq, ts: event.ts };
        return;
      }
      case "SMSG_LOOT_RELEASE_RESPONSE": {
        // The one close the server does send, and it names the object — so a
        // release for something else leaves this window alone.
        const d = event.data as LootReleaseResponseData;
        if (this.lootWin?.guid === d.guid) this.lootWin = undefined;
        return;
      }
      default:
        // Movement of another nearby unit, relayed with the opcode its own
        // client sent. All the MSG_MOVE_* names share one payload.
        if (isMoveOpcode(event.opcode)) {
          const d = event.data as MoveUpdateData;
          if (this.self.guid !== undefined && d.guid === this.self.guid) {
            // Our own guid: `MSG_MOVE_TELEPORT_ACK`, the server's side of a
            // same-map teleport, carrying the arrival point (PROTOCOL.md; no
            // SMSG_NEW_WORLD follows a same-map port, so this is how self
            // position follows a Hearthstone). Our own synthesized movement
            // is never echoed, but if the server ever relays any other
            // MSG_MOVE_* under our guid it is still our position. A port
            // takes the character off any spline it was on.
            this.endSelfSpline();
            this.applySelfPosition(d.pos, event.seq, event.ts);
            this.placeGraveyard(true);
            return;
          }
          this.upsertNearby(d.guid, event.seq, (obj) => {
            obj.position = { value: toUnitPosition(d.pos), seq: event.seq, ts: event.ts };
            obj.fields.set("moveFlags", { value: d.flags, seq: event.seq, ts: event.ts });
            this.joinName(obj);
          });
          return;
        }
        // SMSG_AUTH_RESPONSE, SMSG_CHAR_CREATE, SMSG_CHARACTER_LOGIN_FAILED and
        // anything the module adds: visible on the stream, no cached state yet.
        return;
    }
  }

  // --------------------------------------------------------- world queries
  //
  // Pure reads over what the cache already holds. They never widen an
  // observation: an object with no observed `objectType` is not a unit, and an
  // object with no observed position has no distance.

  /** Objects in view that a `create` block typed as a unit or a player. */
  nearbyUnits(): NearbyObject[] {
    return [...this.nearby.values()].filter(
      (o) => o.objectType?.value === "unit" || o.objectType?.value === "player",
    );
  }

  /**
   * Everything in view, flattened, sorted by distance — the scan helper.
   *
   * Earned surface. Models kept hand-rolling this over `nearby` and
   * tripping on the two shapes underneath it: roster-opus-low-20260822 turn 15
   * filtered `nearbyUnits()` on `u.fields.entry?.value`, and because `fields`
   * is a `Map` every filter returned `[]` while units stood in view — the model
   * concluded the area was empty. roster-sonnet-20260822 re-scanned with
   * ad-hoc filter chains 18 times. This returns plain objects with plain
   * values, so neither footgun is reachable.
   *
   * A query over what the cache already holds: nothing is observed here that
   * `nearby` did not already carry, and nothing is invented. Items and
   * containers (our own inventory) are left out, and so are bones (a corpse
   * whose owner is alive again or has died again, `CORPSE_FLAG_BONES`) and any
   * corpse an owner's newer one replaces; everything else in view is
   * included, *untyped objects too* — an object we have seen but whose create
   * block we missed is still in view, and hiding it would make the world look
   * emptier than it is.
   *
   * Positions come from `pointOf`, the same resolution `closest()` uses, so a
   * creature mid-spline reports where it is along that spline now, as a client
   * draws it (where it is going is `motion.value.destination` on the raw
   * object). `distance` is `undefined` when either side has no known position.
   *
   * No match returns `[]`, never `undefined` and never an error: nothing in
   * view matching is an answer. (`closest()` answers the same question with
   * `undefined`.)
   */
  units(filter?: UnitFilter): UnitView[] {
    const f = normalizeUnitFilter(filter);
    const from = this.self.position?.value;
    // One clock for the whole scan, so every row is read at the same instant.
    const now = Date.now();
    const out: UnitView[] = [];
    const superseded = supersededCorpses(this.nearby.values());
    const reactionOf = this.reactionReader();
    for (const obj of this.nearby.values()) {
      if (superseded.has(obj.guid)) continue;
      const view = toUnitView(obj, from, this.creatures, now, reactionOf);
      if (view === undefined) continue;

      if (!passesUnitFilter(view, obj, f)) continue;
      out.push(view);
    }
    // Nearest first; unknown distance last. Stable, so unknowns keep first-sight
    // order and a replay of the same events sorts the same way.
    //
    // A plain-string name query adds two keys ahead of distance: the match tier
    // (exact, then whole-word, then any other substring) and the shorter name.
    // That is what makes `{ name: "tree" }` return `"tree"` before `"tree
    // stump"` regardless of which is nearer. Regex and non-name queries keep the
    // pure distance order.
    const nameQuery = f.name?.kind === "text" ? f.name.query : undefined;
    return out.sort((a, b) => {
      if (nameQuery !== undefined) {
        // Both names are defined here: the filter dropped every unnamed object.
        const ta = nameTier(a.name as string, nameQuery);
        const tb = nameTier(b.name as string, nameQuery);
        if (ta !== tb) return ta - tb;
        const la = (a.name as string).length;
        const lb = (b.name as string).length;
        if (la !== lb) return la - lb;
      }
      if (a.distance === undefined) return b.distance === undefined ? 0 : 1;
      if (b.distance === undefined) return -1;
      return a.distance - b.distance;
    });
  }

  /**
   * The reaction reader one scan of the view shares: our own template row,
   * PvP flag, reputation pane and party read once, then each unit's row
   * against them (`unitReaction`). Our own pets and summons, and a party
   * member's (or the member), are friendly whatever their rows say: the
   * core's `GetReactionTo` answers those before it reads a template.
   */
  private reactionReader(): (obj: NearbyObject) => UnitReaction | undefined {
    const self = factionTemplateRowOf(this.self.fields);
    const me = this.self.guid;
    const contestedPvp = ((this.self.fields.get("playerFlags")?.value ?? 0) & PLAYER_FLAGS_CONTESTED_PVP) !== 0;
    const party = new Set(this.groupState?.members.map((m) => m.guid) ?? []);
    const byFaction = new Map<number, ReputationEntry>();
    for (const row of this.reputationMap.values()) if (row.factionId !== undefined) byFaction.set(row.factionId, row);
    const race = this.self.fields.get("race")?.value;
    const cls = this.self.fields.get("class")?.value;
    const standing = (unit: FactionTemplateRow) => {
      const row = byFaction.get(unit.faction);
      if (row !== undefined) return row;
      // The login list leaves out a faction with no flags and no standing:
      // its reputation is the Faction.dbc base for this race and class.
      if (unit.base.length === 0 || race === undefined || cls === undefined) return undefined;
      return { rank: reputationRank(baseReputation(unit, race, cls)), atWar: false };
    };
    return (obj) => {
      const owner = obj.ownerGuid?.value;
      if (me !== undefined && owner === me) return "friendly";
      const playerControlled = ((obj.fields.get("unitFlags")?.value ?? 0) & UNIT_FLAG_PLAYER_CONTROLLED) !== 0;
      if (playerControlled && (party.has(obj.guid) || (owner !== undefined && party.has(owner)))) return "friendly";
      const unit = factionTemplateRowOf(obj.fields);
      if (unit === undefined || self === undefined) return undefined;
      return unitReaction(unit, self, { contestedPvp, standing });
    };
  }

  /** Units in view whose observed template entry is `entry`. */
  creaturesByEntry(entry: number): NearbyObject[] {
    return this.nearbyUnits().filter((o) => o.entry?.value === entry);
  }

  /**
   * The nearest object in view that passes `filter`, by straight-line distance
   * from our own last observed position. `undefined` when we have no position,
   * or nothing in view has one — never a guess. The answer is that object's
   * `units()` row, built by the same `toUnitView` — flat, `distance` included —
   * because a caller who has used `units()` reads its sibling the same way:
   * while it returned the raw `NearbyObject`, three 0.5 probes each raised
   * 5–18 TypeErrors reading `closest(...).distance`, documented or not
   * (operator decision, 2026-10-01).
   *
   * `filter` is either a `units()` criteria object — `closest({ entry: 196 })`,
   * `closest({ name: "Deputy Willem", npc: true })` — with exactly the meaning
   * and the rejection messages it has there, or a predicate over the raw
   * object, which is still what a predicate is handed. Four of five models in
   * the 2026-08-22 roster reached for the criteria object by analogy with
   * `units(filter)` and got a bare V8 `TypeError: filter is not a function`,
   * which cost one of them a 15-turn detour; the analogy was right, so the
   * surface now matches it (earned by observed need).
   *
   * Ordering is by distance in both forms. `units({ name: "tree" })` ranks its
   * name matches by tier first; `closest` does not, because "nearest" is the
   * whole question it answers.
   *
   * Distances mix the freshness of two observations (ours and theirs); the
   * raw object (`state.nearby.get(row.guid)`) carries each one's `seq`, so a
   * caller that cares can check.
   *
   * Returns `undefined` on no match, and also when our own position has not
   * been observed yet — so read a field off it only after checking, or the
   * miss arrives as a bare `TypeError` from your own code rather than as an
   * answer. (`units()` answers the same question with `[]`.)
   */
  closest(filter?: UnitFilter | ((obj: NearbyObject) => boolean)): UnitView | undefined {
    const from = this.self.position?.value;
    if (!from) return undefined;

    // A criteria object goes through `units()`'s own normalization and its own
    // per-object test, so `{ entry: 196 }` here means exactly what it means
    // there — including the rejection messages for a bad key or a bad value.
    // What is *not* borrowed is `units()`'s name-tier ordering: `closest`
    // promises the nearest match by distance, and a best-name-first answer
    // under that name would be a new footgun in place of the old one.
    const criteria =
      filter !== undefined && typeof filter !== "function" ? normalizeUnitFilter(filter) : undefined;
    const predicate = typeof filter === "function" ? filter : undefined;

    let best: UnitView | undefined;
    let bestD2 = Infinity;
    const reactionOf = this.reactionReader();
    // One clock for the ordering and the rows, so they cannot disagree.
    const now = Date.now();
    const superseded = supersededCorpses(this.nearby.values());
    for (const obj of this.nearby.values()) {
      if (superseded.has(obj.guid)) continue;
      const p = pointOf(obj, now)?.value;
      if (!p) continue;
      if (predicate && !predicate(obj)) continue;
      // The answer is a `units()` row, so what `units()` leaves out — items
      // and containers, our own inventory — is never an answer here either.
      const view = toUnitView(obj, from, this.creatures, now, reactionOf);
      if (view === undefined) continue;
      if (criteria && !passesUnitFilter(view, obj, criteria)) continue;
      const d2 = (p.x - from.x) ** 2 + (p.y - from.y) ** 2 + (p.z - from.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = view;
      }
    }
    return best;
  }

  // ------------------------------------------------------ update-object fold

  private applyUpdateBlock(block: UpdateBlock, seq: number, ts: number): void {
    switch (block.update) {
      case "create":
        this.applyCreate(block as CreateBlock, seq, ts);
        return;
      case "values": {
        const b = block as { guid: GuidKey; fields?: UpdateFields };
        if (this.isSelfGuid(b.guid)) {
          this.mergeFields(this.self, b.fields, seq, ts);
          return;
        }
        // A `values` delta for an object we never saw created still means the
        // object is in view — the module's own guid->type cache just could not
        // name its fields. The entry records that, and claims nothing more.
        this.upsertNearby(b.guid, seq, (obj) => {
          this.mergeFields(obj, b.fields, seq, ts);
          this.joinName(obj);
        });
        return;
      }
      case "movement": {
        const b = block as { guid: GuidKey; pos?: PositionData; moveFlags?: number };
        if (this.isSelfGuid(b.guid)) {
          if (b.pos) this.applySelfPosition(b.pos, seq, ts);
          return;
        }
        this.upsertNearby(b.guid, seq, (obj) => {
          if (b.pos) obj.position = { value: toUnitPosition(b.pos), seq, ts };
          if (b.moveFlags !== undefined) obj.fields.set("moveFlags", { value: b.moveFlags, seq, ts });
        });
        return;
      }
      case "outOfRange": {
        const b = block as { guids: GuidKey[] };
        for (const g of b.guids) this.forget(g);
        return;
      }
      case "near":
        // NEAR_OBJECTS is the *opposite* of out-of-range: the module keeps its
        // guid->type cache for these guids and only prunes on OUT_OF_RANGE.
        // The block carries no fields, so there is nothing to record either.
        return;
      default:
        // A block kind added after this SDK revision. The event is still on the
        // stream; the cache simply has no rule for it.
        return;
    }
  }

  private applyCreate(block: CreateBlock, seq: number, ts: number): void {
    const flaggedSelf = block.self === true;
    if (flaggedSelf && this.self.guid !== undefined && block.guid !== this.self.guid) {
      // The module says "this is you" about a guid the session response did not
      // give us. One of the two is wrong and the cache cannot tell which, so it
      // keeps the seeded identity (the only one tied to the character we asked
      // for) and files the block as an ordinary object in view.
      this.anomalyBuf.push({
        seq,
        ts,
        kind: "self_guid_mismatch",
        detail: `create block flagged self carries guid ${block.guid}, seeded self is ${this.self.guid}`,
      });
    } else if (flaggedSelf || this.isSelfGuid(block.guid)) {
      if (this.self.guid === undefined) this.self.guid = block.guid;
      if (block.pos) this.applySelfPosition(block.pos, seq, ts);
      if (block.moveFlags !== undefined) {
        this.self.fields.set("moveFlags", { value: block.moveFlags, seq, ts });
      }
      if (block.runSpeed !== undefined) {
        this.self.fields.set("runSpeed", { value: block.runSpeed, seq, ts });
      }
      if (this.replayPending) {
        // The replay's own create is the whole field block, as a login's is
        // to a fresh cache: what it leaves out is zero, not "unchanged".
        this.replayPending = false;
        const kept = new Map<string, Observed<number>>();
        for (const key of ["moveFlags", "runSpeed"]) {
          const v = this.self.fields.get(key);
          if (v !== undefined) kept.set(key, v);
        }
        this.self.fields.clear();
        for (const [key, v] of kept) this.self.fields.set(key, v);
      }
      this.mergeFields(this.self, block.fields, seq, ts);
      return;
    }

    this.upsertNearby(block.guid, seq, (obj) => {
      obj.objectType = { value: block.objectType, seq, ts };
      if (block.pos) obj.position = { value: toUnitPosition(block.pos), seq, ts };
      if (block.moveFlags !== undefined) obj.fields.set("moveFlags", { value: block.moveFlags, seq, ts });
      if (block.runSpeed !== undefined) obj.fields.set("runSpeed", { value: block.runSpeed, seq, ts });
      if (block.targetGuid !== undefined) obj.targetGuid = { value: block.targetGuid, seq, ts };
      if (block.pathProgress !== undefined) {
        obj.transport = {
          value: { progressMs: block.pathProgress, periodMs: undefined, docked: undefined, inRange: undefined, docks: [] },
          seq,
          ts,
        };
      }
      this.mergeFields(obj, createdFields(block), seq, ts);
      this.joinName(obj);
    });
  }

  /**
   * Fold one questgiver marker onto the object it names. A status for a guid
   * not yet in `nearby` still goes on an entry: the core only reports
   * questgivers it considers visible to us, so the guid is in view even when
   * its create block has not been folded (or was missed).
   */
  private applyQuestGiverStatus(guid: GuidKey, status: number, seq: number, ts: number): void {
    if (this.isSelfGuid(guid)) return;
    this.upsertNearby(guid, seq, (obj) => {
      obj.questGiver = { value: status, seq, ts };
    });
  }

  /**
   * Drop everything observed *about one object* when it leaves view. Auras go
   * with it: a client stops showing the buff bar of a unit it cannot see, and
   * keeping them would let a stale aura outlive its unit.
   */
  private forget(guid: GuidKey): void {
    this.nearby.delete(guid);
    this.auraSlots.delete(guid);
  }

  /**
   * A new map means a new visibility set: nothing seen on the old map is in
   * view, and a client would have received out-of-range/destroy for all of it.
   * Without this, cross-map gameObjects lingered in `nearby` at absurd
   * distances (d≈8063 in morning-opus-1). Own items and containers are kept —
   * they travel with the character, and the inventory join reads them.
   */
  private evictOnMapChange(newMap: number): void {
    if (this.selfMap === undefined || this.selfMap === newMap) return;
    for (const [guid, obj] of this.nearby) {
      const t = obj.objectType?.value;
      if (t === "item" || t === "container") continue;
      this.forget(guid);
    }
  }

  /**
   * The whole view goes, own items and containers included: the reattach
   * replay (`WB_SESSION_STATE` with `replay: true`) restates every one of
   * them in the create blocks that follow, so what is not restated was not
   * at the client any more.
   */
  private forgetAllNearby(): void {
    for (const guid of [...this.nearby.keys()]) this.forget(guid);
  }

  /**
   * A login starts a new session, and `seq` restarts with it, so a questgiver
   * marker from an earlier session cannot be ordered against the new
   * session's quest log and level: the new self create block re-stamps those
   * at low seqs, and the old marker would read as newer than all of them.
   * Only the markers go — the objects stay, as a same-map login keeps them
   * (see `evictOnMapChange`) — and the client asks for them again as each
   * questgiver comes into view in the new session.
   */
  private forgetQuestGiverMarkers(): void {
    for (const obj of this.nearby.values()) obj.questGiver = undefined;
  }

  /**
   * The other half of a login: the self fields a marker is ordered against
   * (`isQuestGiverMarkerInput`) are re-dated to it. A create block never
   * carries a zero-valued field, so the new session's own create leaves an
   * empty slot, or an active quest's zero state, stamped with the last
   * session's seq, which late in a long session is far above anything the
   * new one has yet produced; every new marker read as older than it. Each
   * value stands; only its stamp moves to the login, and whatever the new
   * create restates takes the create's stamp as usual. Entries are replaced,
   * never mutated, so a snapshot taken earlier keeps its own.
   */
  private redateQuestGiverMarkerInputs(seq: number, ts: number): void {
    for (const [key, field] of this.self.fields) {
      if (isQuestGiverMarkerInput(key)) this.self.fields.set(key, { value: field.value, seq, ts });
    }
  }

  private isSelfGuid(guid: GuidKey): boolean {
    return this.self.guid !== undefined && guid === this.self.guid;
  }

  /**
   * Pair an observed x/y/z/o with the last observed map. Refused — and recorded
   * — when no map has ever been observed, because `WorldPosition.map` would
   * otherwise have to be invented.
   */
  private applySelfPosition(pos: PositionData, seq: number, ts: number): void {
    if (this.selfMap === undefined) {
      this.anomalyBuf.push({
        seq,
        ts,
        kind: "self_position_without_map",
        detail: "own position arrived before any SMSG_LOGIN_VERIFY_WORLD / SMSG_NEW_WORLD gave a map id",
      });
      return;
    }
    this.self.position = {
      value: { map: this.selfMap, x: pos.x, y: pos.y, z: pos.z, o: pos.o },
      seq,
      ts,
    };
  }

  /**
   * Name the release graveyard from the zone text, when the character stands
   * within `GRAVEYARD_NEAR_YARDS` of it on its map. A `WB_AREA` there names
   * it; a port's arrival names it `provisional`ly, only while nothing has —
   * the module's `WB_AREA` for the new place follows the port by a tick, and
   * a port within one area sends none, so the zone text then already reads it.
   */
  private placeGraveyard(provisional: boolean): void {
    const g = this.self.graveyard;
    const pos = this.self.position?.value;
    const zone = this.self.zone?.value;
    const area = this.self.area?.value;
    if (g === undefined || pos === undefined || zone === undefined || area === undefined) return;
    if (provisional && g.value.area !== undefined) return;
    if (pos.map !== g.value.map || Math.hypot(pos.x - g.value.x, pos.y - g.value.y) > GRAVEYARD_NEAR_YARDS) return;
    this.self.graveyard = { ...g, value: { ...g.value, zone, area } };
  }

  /**
   * A point the server put the character at with no facing (a spline's stop
   * or its end). The spline carries no orientation, so the last observed one
   * stands. A map always arrives with a position, so whenever
   * `applySelfPosition` would accept this there is a last orientation to keep.
   */
  private applySelfPoint(p: Point3, seq: number, ts: number): void {
    this.applySelfPosition({ x: p.x, y: p.y, z: p.z, o: this.self.position?.value.o ?? 0 }, seq, ts);
  }

  /**
   * Our own `SMSG_MONSTER_MOVE`. A launch is kept for the landing, and is the
   * flight's ETA once `taxiFlight` is (or turns) true — the spline is sent
   * before the flag's values update, which goes out on the next server tick.
   * A stop is the server's word on where the spline left the character
   * (`MoveSplineInit::Stop` writes the computed position), so it is a
   * position, and it ends the spline.
   */
  private applySelfSpline(d: MonsterMoveData, seq: number, ts: number): void {
    if (d.stopped === true || d.destination === undefined) {
      this.endSelfSpline();
      if (d.stopped === true) this.applySelfPoint(d.pos, seq, ts);
      return;
    }
    const { x, y, z } = d.destination;
    this.selfSpline = { destination: { x, y, z }, durationMs: d.durationMs, seq, ts };
    if (this.self.taxiFlight?.value === true) this.publishTaxiEta();
  }

  /** `self.taxiEta` from the kept spline, stamped with the packet that carried the duration. */
  private publishTaxiEta(): void {
    const s = this.selfSpline;
    if (s === undefined || s.durationMs === undefined) return;
    this.self.taxiEta = { value: { durationMs: s.durationMs, landsAt: s.ts + s.durationMs }, seq: s.seq, ts: s.ts };
  }

  /** The character is off its server spline: nothing left to land on, no ETA. */
  private endSelfSpline(): void {
    this.selfSpline = undefined;
    this.self.taxiEta = undefined;
  }

  /**
   * Record one achievement, first writer wins. `rebuildAchievements` is the
   * caller's job for the login batch so a backlog of hundreds rebuilds once.
   */
  private addAchievement(
    a: { achievementId: number; date?: number; time?: string; name?: string; points?: number; categoryId?: number },
    source: "login" | "earned",
    seq: number,
    ts: number,
  ): void {
    this.noteAchievementName(a);
    if (this.achievementMap.has(a.achievementId)) return;
    this.achievementMap.set(a.achievementId, {
      achievementId: a.achievementId,
      name: a.name,
      points: a.points,
      categoryId: a.categoryId,
      date: a.date,
      time: a.time,
      source,
      seq,
      ts,
    });
    if (source === "earned") this.rebuildAchievements();
  }

  /** Remember the name an achievement packet gave an id, for the chat line that links it. */
  private noteAchievementName(a: { achievementId: number; name?: string }): void {
    if (typeof a.name === "string" && a.name.length > 0) this.achievementNames.set(a.achievementId, a.name);
  }

  /** Replace `self.achievements` wholesale; the snapshot's shallow copy relies on it. */
  private rebuildAchievements(): void {
    const entries = [...this.achievementMap.values()];
    let points = 0;
    for (const e of entries) points += e.points ?? 0;
    this.self.achievements = { entries, points, loginSeen: this.achievementsLoginSeen };
  }

  /**
   * Merge one block's named fields, per field, with that block's provenance.
   * `targetGuid` is a guid rather than a number, so it gets its own group.
   */
  private mergeFields(
    target: UnitFieldsState & {
      targetGuid?: Observed<GuidKey> | undefined;
      entry?: Observed<number> | undefined;
    },
    fields: UpdateFields | undefined,
    seq: number,
    ts: number,
  ): void {
    if (!fields) return;
    const healthBefore = target === this.self ? target.fields.get("health")?.value : undefined;
    // A quest that leaves the log takes its exploration credit with it. Read
    // as a departure across the whole block — before against after — so a
    // quest restated in another slot stays, and a credit that arrived ahead
    // of its own slot field (the direct packet outruns the object flush) is
    // not dropped for not being there yet.
    const questsBefore =
      target === this.self && this.questExplored.size > 0 && Object.keys(fields).some((k) => QUEST_ID_FIELD.test(k))
        ? this.questIdsInLog()
        : undefined;
    for (const [key, raw] of Object.entries(fields)) {
      if (key === "targetGuid") {
        if (typeof raw === "string" && "targetGuid" in target) {
          target.targetGuid = { value: raw, seq, ts };
        }
        continue;
      }
      // What a unit channels at; only our own is read (`self.channeling`).
      if (key === "channelObjectGuid") {
        if (target === this.self && typeof raw === "string") {
          this.selfChannelObject = raw === "0" ? undefined : raw;
          const ch = this.self.channeling;
          if (ch !== undefined) this.self.channeling = { ...ch, value: { ...ch.value, targetGuid: this.selfChannelObject } };
        }
        continue;
      }
      // The skill pane's names ride beside the ids as strings;
      // they live in their own map because `fields` holds numbers only.
      if (target === this.self && typeof raw === "string") {
        const m = /^skill(\d+)Name$/.exec(key);
        if (m !== null) this.skillNames.set(Number(m[1]), raw);
        continue;
      }
      // Owner guids: joined u64 halves the module serves as guid
      // strings. SUMMONEDBY is the pet's master; CREATEDBY is the fallback
      // the client draws the same conclusion from; a corpse's owner is the
      // player whose name it is labelled with.
      if (typeof raw === "string" && target !== this.self && "ownerGuid" in target) {
        const obj = target as NearbyObject;
        if (
          key === "summonedByGuid" ||
          key === "corpseOwnerGuid" ||
          (key === "createdByGuid" && obj.ownerGuid?.value === undefined)
        ) {
          obj.ownerGuid = raw === "0" ? undefined : { value: raw, seq, ts };
        } else if (key === "charmedByGuid") {
          obj.charmedByGuid = raw === "0" ? undefined : { value: raw, seq, ts };
        } else {
          // An item's suffix name and enchant texts: the DBC strings the
          // module serves beside the ids (PROTOCOL.md, "items and containers").
          obj.texts.set(key, { value: raw, seq, ts });
        }
        continue;
      }
      // Unknown extras a newer module serves come through the loose schema as
      // non-numbers; only decoded numeric fields belong in the field record.
      if (typeof raw !== "number") continue;
      target.fields.set(key, { value: raw, seq, ts });
    }
    if (questsBefore !== undefined) {
      const after = this.questIdsInLog();
      for (const id of questsBefore) if (!after.has(id)) this.questExplored.delete(id);
    }
    const level = target.fields.get("level");
    if (level) target.level = level;
    const entry = target.fields.get("entry");
    if (entry && "entry" in target) target.entry = entry;
    this.deriveGauges(target);
    if (target === this.self) {
      // `taxiFlight` rides `unitFlags` in every block that carries it
      // (PROTOCOL.md), and the module names the bit; the bit is read here
      // rather than the named boolean because `fields` holds numbers only.
      // Derived only from a block that *carried* unitFlags, so the observation
      // keeps the provenance of the packet that made it.
      if (typeof fields.unitFlags === "number") {
        const wasFlying = this.self.taxiFlight?.value === true;
        const flying = (fields.unitFlags & UNIT_FLAG_TAXI_FLIGHT) !== 0;
        this.self.taxiFlight = { value: flying, seq, ts };
        if (flying && !wasFlying) {
          // Take-off: the flight's spline arrived just ahead of this flag.
          this.publishTaxiEta();
          // Nothing moves position until the landing, so it says it is the
          // take-off point rather than reading as where the character is.
          const at = this.self.position;
          if (at !== undefined) this.self.position = { ...at, value: { ...at.value, inFlight: true } };
        } else if (!flying && wasFlying) {
          // Landing: the client has flown itself to the end of the spline,
          // which is where the server set the character down. No spline
          // kept (a port, a stop already applied, a move of its own since)
          // leaves position as it was rather than guessing.
          const spline = this.selfSpline;
          this.endSelfSpline();
          if (spline !== undefined) this.applySelfPoint(spline.destination, seq, ts);
          else {
            const at = this.self.position;
            if (at?.value.inFlight === true) {
              const { inFlight: _, ...rest } = at.value;
              this.self.position = { ...at, value: rest };
            }
          }
        }
      }
      // `resting` is the same shape of reading off `playerFlags`, the players-
      // only field the module whitelists (PROTOCOL.md). Guarded the same way:
      // a delta that does not carry `playerFlags` says nothing about rest, and
      // must not be read as "not resting".
      if (typeof fields.playerFlags === "number") {
        this.self.resting = { value: (fields.playerFlags & PLAYER_FLAGS_RESTING) !== 0, seq, ts };
        this.self.ghost = { value: (fields.playerFlags & PLAYER_FLAGS_GHOST) !== 0, seq, ts };
      }
      // `inCombat`, `stunned` and `mounted` are the same shape off
      // `unitFlags`, in their own guard: a delta without the field says
      // nothing about any of them.
      if (typeof fields.unitFlags === "number") {
        this.self.inCombat = { value: (fields.unitFlags & UNIT_FLAG_IN_COMBAT) !== 0, seq, ts };
        this.self.stunned = { value: (fields.unitFlags & UNIT_FLAG_STUNNED) !== 0, seq, ts };
        this.self.mounted = { value: (fields.unitFlags & UNIT_FLAG_MOUNT) !== 0, seq, ts };
      }
      // A channel the server ended without a packet we saw (a reattach, a
      // dropped frame): the field reads 0 once it is over.
      if (fields.channelSpell === 0) this.self.channeling = undefined;
      // A Death Knight has runes from the start, in the base layout.
      if (fields.class === CLASS_DEATH_KNIGHT && this.self.runes === undefined) this.publishRunes(seq, ts);
      if (typeof fields.standState === "number") {
        this.self.standState = { value: { id: fields.standState, name: STAND_STATE_NAMES[fields.standState] }, seq, ts };
        this.self.sitting = { value: SITTING_STAND_STATES.has(fields.standState), seq, ts };
      }
      if (typeof fields.shapeshiftForm === "number") {
        this.self.shapeshiftForm = { value: { id: fields.shapeshiftForm, name: SHAPESHIFT_FORM_NAMES[fields.shapeshiftForm] }, seq, ts };
      }
      if (typeof fields.restedXp === "number") this.self.restedXp = { value: fields.restedXp, seq, ts };
      if (Object.keys(fields).some((k) => SHEET_FIELD.test(k))) this.self.stats = { value: this.characterStats(), seq, ts };
      const healthAfter = target.fields.get("health")?.value;
      const pos = this.self.position?.value;
      // The died transition: own health reaching 0 from a living value. Until
      // the corpse query answers, the corpse is where the character stood —
      // what a client knows from having been there.
      if (healthAfter === 0 && healthBefore !== undefined && healthBefore > 0 && pos !== undefined) {
        this.self.corpse = { value: { map: pos.map, x: pos.x, y: pos.y, z: pos.z, source: "death_spot" }, seq, ts };
      }
    }
  }

  /** Rebuild `self.runes` from the types and the last ready mask. */
  private publishRunes(seq: number, ts: number): void {
    const types = this.runeTypes ?? BASE_RUNE_TYPES;
    const mask = this.runeReadyMask;
    this.self.runes = {
      value: types.map((t, index) => ({
        index,
        type: RUNE_TYPE_NAMES[t],
        ready: mask === undefined ? undefined : ((mask >> index) & 1) === 1,
      })),
      seq,
      ts,
    };
  }

  /** The character sheet from our own fields as they now stand. */
  private characterStats(): CharacterStats {
    const f = (key: string): number | undefined => this.self.fields.get(key)?.value;
    const total = (base: string): number | undefined => {
      const b = f(base);
      if (b === undefined) return undefined;
      return Math.floor(Math.max(0, b + (f(`${base}Mods`) ?? 0)) * (1 + (f(`${base}Multiplier`) ?? 0)));
    };
    const bySchool = (prefix: string) =>
      Object.fromEntries(MAGIC_SCHOOLS.map((school, i) => [school, f(`${prefix}${i + 1}`)])) as {
        [school in (typeof MAGIC_SCHOOLS)[number]]: number | undefined;
      };
    return {
      strength: f("stat0"),
      agility: f("stat1"),
      stamina: f("stat2"),
      intellect: f("stat3"),
      spirit: f("stat4"),
      armor: f("resistance0"),
      resistances: bySchool("resistance"),
      attackPower: total("attackPower"),
      rangedAttackPower: total("rangedAttackPower"),
      critPct: f("critPct"),
      rangedCritPct: f("rangedCritPct"),
      spellCritPct: bySchool("spellCritPct"),
      blockPct: f("blockPct"),
      dodgePct: f("dodgePct"),
      parryPct: f("parryPct"),
    };
  }

  /**
   * Derive `health`/`power` from the raw fields — and only when the derivation
   * is complete.
   *
   * A `values` delta routinely carries `health` without `maxHealth`, and which
   * of `power1..7` is *the* power depends on `powerType` (the client reads
   * `UNIT_FIELD_POWER1 + powerType`). Half a gauge is not a gauge, and a power
   * bar chosen without `powerType` is a guess, so both stay `undefined` until
   * every part has actually been observed. The parts are always in `fields`.
   */
  private deriveGauges(target: UnitFieldsState): void {
    const health = target.fields.get("health");
    const maxHealth = target.fields.get("maxHealth");
    if (health && maxHealth) {
      target.health = {
        value: { current: health.value, max: maxHealth.value },
        seq: Math.max(health.seq, maxHealth.seq),
        ts: Math.max(health.ts, maxHealth.ts),
      };
    }
    const powerType = target.fields.get("powerType");
    if (!powerType) return;
    const n = powerType.value + 1;
    const power = target.fields.get(`power${n}`);
    const maxPower = target.fields.get(`maxPower${n}`);
    if (power && maxPower) {
      target.power = {
        value: { current: power.value, max: maxPower.value },
        seq: Math.max(power.seq, maxPower.seq),
        ts: Math.max(power.ts, maxPower.ts),
      };
    }
  }

  /**
   * Attach a name to an object from the query answers already received:
   * creatures by template entry, players by guid. Nothing else names anything.
   */
  private joinName(obj: NearbyObject): void {
    const type = obj.objectType?.value;
    const entry = obj.entry?.value;
    if ((type === "item" || type === "container") && entry !== undefined) {
      const info = this.items.get(entry);
      if (info) obj.name = { value: info.value.name, seq: info.seq, ts: info.ts };
      return;
    }
    if (type === "gameObject" && entry !== undefined) {
      // Game object and creature entries are separate id spaces: a chest's
      // entry can equal some creature's, so only the game object answer names it.
      const info = this.gameObjects.get(entry);
      if (info) {
        obj.name = { value: info.value.name, seq: info.seq, ts: info.ts };
        // The template's type stands in when the create block's
        // GAMEOBJECT_BYTES_1 was not in the mask; both are client-cache facts.
        if (!obj.fields.has("goType") && info.value.type !== undefined) {
          obj.fields.set("goType", { value: info.value.type, seq: info.seq, ts: info.ts });
        }
      }
      return;
    }
    if (type !== "player" && entry !== undefined) {
      const info = this.creatures.get(entry);
      if (info) {
        obj.name = { value: info.value.name, seq: info.seq, ts: info.ts };
        return;
      }
    }
    const byGuid = this.names.get(obj.guid);
    if (byGuid) obj.name = byGuid;
  }

  /**
   * `state.self.map` from an event that carried the map's `Map.dbc` row. One
   * that did not (an older module, or a map the table has no row for) leaves
   * the map unnamed rather than guessing; an unknown `InstanceType` code
   * likewise.
   */
  private foldMap(id: number, name: string | undefined, instanceType: number | undefined, seq: number, ts: number): void {
    const kind = instanceType === undefined ? undefined : INSTANCE_TYPES[instanceType];
    this.self.map = name === undefined || kind === undefined ? undefined : { value: { id, name, instanceType: kind }, seq, ts };
  }

  /**
   * Copy the char-enum row for our own character onto `self`. Only runs when a
   * seed identified us; matching by name alone would be a guess. The row's
   * level is the one at the character screen, so it only fills a level
   * nothing else has stated: a `createSession` repeated on a session already
   * in world seeds self again, and would otherwise put the login's level back
   * over the one `WB_SESSION_STATE` and the update blocks have said since.
   */
  private adoptOwnCharacter(): void {
    const enumerated = this.characters;
    if (!enumerated) return;
    const { guid, name } = this.self;
    const row = enumerated.value.find(
      (c) => (guid !== undefined && c.guid === guid) || (guid === undefined && name !== undefined && c.name === name),
    );
    if (!row) return;
    if (this.self.guid === undefined) this.self.guid = row.guid;
    if (this.self.name === undefined) this.self.name = row.name;
    if (this.self.level === undefined) this.self.level = { value: row.level, seq: enumerated.seq, ts: enumerated.ts };
  }

  /**
   * Create-or-update an object in `nearby`. Every update-object and MSG_MOVE_*
   * write goes through this one seam.
   */
  protected upsertNearby(guid: GuidKey, seq: number, mutate: (obj: NearbyObject) => void): NearbyObject {
    const key = guid;
    let obj = this.nearby.get(key);
    if (!obj) {
      obj = {
        guid,
        objectType: undefined,
        entry: undefined,
        name: undefined,
        level: undefined,
        position: undefined,
        motion: undefined,
        health: undefined,
        power: undefined,
        targetGuid: undefined,
        ownerGuid: undefined,
        charmedByGuid: undefined,
        transport: undefined,
        questGiver: undefined,
        fields: new Map<string, Observed<number>>(),
        texts: new Map<string, Observed<string>>(),
        firstSeq: seq,
        lastSeq: seq,
      };
      this.nearby.set(key, obj);
    }
    mutate(obj);
    obj.lastSeq = Math.max(obj.lastSeq, seq);
    return obj;
  }
}

/**
 * One `NearbyObject` as `units()` reports it, or `undefined` when the object is
 * not in the world view at all (our own items and bags). `from` is our own last
 * observed position; without it `distance`/`x`/`y`/`z` stay unobserved.
 * `now` is the clock `pointOf` reads a spline by.
 */
function toUnitView(
  obj: NearbyObject,
  from: UnitPosition | undefined,
  creatures: ReadonlyMap<number, Observed<CreatureInfo>>,
  now: number,
  reactionOf: (obj: NearbyObject) => UnitReaction | undefined,
): UnitView | undefined {
  const type = obj.objectType?.value;
  if (type === "item" || type === "container") return undefined;
  // Bones are scenery to a client, not a corpse: no row.
  if (type === "corpse" && isBones(obj)) return undefined;
  const point = pointOf(obj, now)?.value;
  const distance =
    from && point
      ? Math.round(Math.hypot(point.x - from.x, point.y - from.y, point.z - from.z) * 100) / 100
      : undefined;
  const health = obj.fields.get("health")?.value;
  const target = obj.targetGuid?.value;
  return {
    guid: obj.guid,
    entry: obj.entry?.value,
    name: obj.name?.value,
    type,
    level: obj.level?.value,
    health,
    maxHealth: obj.fields.get("maxHealth")?.value,
    dead: type === "corpse" ? true : health === undefined ? undefined : health === 0,
    distance,
    x: point?.x,
    y: point?.y,
    z: point?.z,
    targetGuid: target === undefined || target === "0" ? undefined : target,
    ownerGuid: obj.ownerGuid?.value,
    rank: rankOf(obj, creatures),
    questGiver: obj.questGiver === undefined ? undefined : questGiverStatusName(obj.questGiver.value),
    questGiverStatus: obj.questGiver?.value,
    roles: npcRolesOf(obj.fields.get("npcFlags")?.value),
    goType: goTypeOf(obj),
    docked: obj.transport?.value.docked,
    reaction: type === "unit" || type === "player" ? reactionOf(obj) : undefined,
    ...unitStateOf(type, obj.fields.get("unitFlags")?.value, obj.fields.get("dynamicFlags")?.value),
    ...postureOf(type, obj.fields.get("standState")?.value, obj.fields.get("shapeshiftForm")?.value),
  };
}

/**
 * The named readings off the flag words for `toUnitView`: only a unit or
 * player has them, and each group is undefined until a block carried its
 * field, the way `taxiFlight` is read.
 */
function unitStateOf(
  type: string | undefined,
  unitFlags: number | undefined,
  dynamicFlags: number | undefined,
): Pick<UnitView, "inCombat" | "stunned" | "skinnable" | "lootable" | "tapped" | "tappedByYou"> {
  const living = type === "unit" || type === "player";
  const u = living ? unitFlags : undefined;
  const d = living ? dynamicFlags : undefined;
  return {
    inCombat: u === undefined ? undefined : (u & UNIT_FLAG_IN_COMBAT) !== 0,
    stunned: u === undefined ? undefined : (u & UNIT_FLAG_STUNNED) !== 0,
    skinnable: u === undefined ? undefined : (u & UNIT_FLAG_SKINNABLE) !== 0,
    lootable: d === undefined ? undefined : (d & UNIT_DYNFLAG_LOOTABLE) !== 0,
    tapped: d === undefined ? undefined : (d & UNIT_DYNFLAG_TAPPED) !== 0,
    tappedByYou: d === undefined ? undefined : (d & UNIT_DYNFLAG_TAPPED_BY_PLAYER) !== 0,
  };
}

/** Sitting and the shapeshift form for `toUnitView`, units and players only. */
function postureOf(
  type: string | undefined,
  standState: number | undefined,
  form: number | undefined,
): Pick<UnitView, "sitting" | "shapeshiftForm"> {
  const living = type === "unit" || type === "player";
  return {
    sitting: !living || standState === undefined ? undefined : SITTING_STAND_STATES.has(standState),
    shapeshiftForm: !living || form === undefined || form === 0 ? undefined : SHAPESHIFT_FORM_NAMES[form],
  };
}

function isBones(obj: NearbyObject): boolean {
  return ((obj.fields.get("corpseFlags")?.value ?? 0) & CORPSE_FLAG_BONES) !== 0;
}

/**
 * The corpses in view that an owner's newer corpse replaces. A player has one
 * corpse at a time — the core turns the old one to bones before it lays the
 * new one (`Player::CreateCorpse`) — so a second corpse row for one owner is a
 * destroy the cache missed, and the newer create is the corpse. Over the whole
 * view, before any filter, so a filter can never leave the stale one standing
 * in for the real one. Bones and corpses with no observed owner are not
 * grouped.
 */
function supersededCorpses(objects: Iterable<NearbyObject>): Set<GuidKey> {
  const newest = new Map<GuidKey, NearbyObject>();
  const superseded = new Set<GuidKey>();
  const created = (o: NearbyObject) => o.objectType?.seq ?? o.firstSeq;
  for (const obj of objects) {
    if (obj.objectType?.value !== "corpse" || isBones(obj)) continue;
    const owner = obj.ownerGuid?.value;
    if (owner === undefined) continue;
    const held = newest.get(owner);
    if (held === undefined) {
      newest.set(owner, obj);
    } else if (created(obj) > created(held)) {
      superseded.add(held.guid);
      newest.set(owner, obj);
    } else {
      superseded.add(obj.guid);
    }
  }
  return superseded;
}

/**
 * A create block's fields as the client reads them. The core's create mask
 * carries only the non-zero fields (`Object::BuildValuesUpdate`) and a client
 * starts every field at zero, so a unit's create that states its `maxHealth`
 * and no `health` is a unit at 0 health: a creature that came into view
 * already dead. Stated, so an object re-entering view dead does not keep the
 * health it left with.
 */
function createdFields(block: CreateBlock): UpdateFields | undefined {
  const fields = block.fields;
  if (block.objectType !== "unit" && block.objectType !== "player") return fields;
  if (fields === undefined || !("maxHealth" in fields) || "health" in fields) return fields;
  return { ...fields, health: 0 };
}

/**
 * A creature's rank from its template's query answer. Only a unit's: a game
 * object's entry is a different table's id and may collide with a creature's.
 */
function rankOf(obj: NearbyObject, creatures: ReadonlyMap<number, Observed<CreatureInfo>>): CreatureRankName | undefined {
  const entry = obj.entry?.value;
  if (obj.objectType?.value !== "unit" || entry === undefined) return undefined;
  const rank = creatures.get(entry)?.value.rank;
  return rank === undefined ? undefined : creatureRankName(rank);
}

/**
 * A game object's type name from its `goType` field (the create block's
 * `GAMEOBJECT_BYTES_1`, or the template answer joined in by `joinName`).
 * Units and players have no type here.
 */
function goTypeOf(obj: NearbyObject): GameObjectTypeName | undefined {
  if (obj.objectType?.value !== "gameObject") return undefined;
  const own = obj.fields.get("goType")?.value;
  return own === undefined ? undefined : gameObjectTypeName(own);
}

/**
 * Whether one object satisfies every present criterion. The single definition
 * of what a `UnitFilter` *means*, shared by `units()` and `closest()` so the
 * two can never drift; `obj` is only needed for `npc`, which reads a raw field
 * the view does not carry.
 */
function passesUnitFilter(view: UnitView, obj: NearbyObject, f: NormalizedUnitFilter): boolean {
  if (f.entries && (view.entry === undefined || !f.entries.has(view.entry))) return false;
  if (f.name !== undefined) {
    // Unnamed objects never match: a name criterion cannot be evaluated
    // against a name we have not observed.
    if (view.name === undefined) return false;
    if (f.name.kind === "regex") {
      if (!f.name.re.test(view.name)) return false;
    } else if (!view.name.toLowerCase().includes(f.name.query)) {
      return false;
    }
  }
  if (f.type !== undefined && view.type !== f.type) return false;
  // Both are positive claims about a unit or player and need the
  // observation: `alive: true` is health seen above 0, so a corpse, a game
  // object or a spell's ground effect (none has health) never passes it, and
  // `alive: false` is health seen at 0. A player's corpse is dead too, but it
  // is not what a loot scan over `alive: false` is looking for, so it is
  // reached with `type: "corpse"` instead.
  if (f.alive === true && view.dead !== false) return false;
  if (f.alive === false && (view.dead !== true || view.type === "corpse")) return false;
  if (f.maxDistance !== undefined && (view.distance === undefined || view.distance > f.maxDistance)) {
    return false;
  }
  if (f.npc !== undefined) {
    const isNpc = (obj.fields.get("npcFlags")?.value ?? 0) > 0;
    if (isNpc !== f.npc) return false;
  }
  if (f.role !== undefined && !view.roles.some((r) => f.role!.has(r))) return false;
  if (f.questGiver !== undefined) {
    if (view.questGiver === undefined) return false;
    if (f.questGiver === ANY_QUEST_GIVER) {
      if (view.questGiver === "none") return false;
    } else if (!f.questGiver.has(view.questGiver)) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------ units() filter input
//
// Softening policy: repair only what has exactly one valid reading (a numeric string
// where a number is expected), reject everything else with a message that says
// what arrived, what was expected, and what to do. A silently ignored key is
// the forbidden outcome — it returns a wrong-but-plausible answer, which is the
// very failure this helper exists to remove.

const UNIT_FILTER_KEYS = ["entry", "name", "type", "alive", "maxDistance", "npc", "role", "questGiver"] as const;

/** `questGiver: true` — any marker except `"none"`. Not a status name, so it cannot collide with one. */
const ANY_QUEST_GIVER = "any" as const;

/**
 * Keys models actually passed that are not filter keys, and where the thing
 * they wanted really lives (2026-08-23 run audit: `dead`, `guid`). Naming the
 * replacement is explanation, not repair — inverting `dead` into `alive` would
 * be a guess, and repairs must be deterministic — guessing is forbidden.
 */
const UNIT_FILTER_KEY_HINTS: Readonly<Record<string, string>> = {
  dead: 'use alive instead — { alive: false } is the known-dead, { alive: true } drops them',
  guid: "guid is not a criterion — each returned row carries .guid, and state.nearby is keyed by it",
  questgiver: "questGiver is spelled with a capital G",
  distance: "use maxDistance (yards)",
  maxDist: "use maxDistance (yards)",
  id: "use entry (the creature/gameobject template id)",
  entryId: "use entry",
  level: "level is not a criterion — each returned row carries .level; filter the array yourself",
  hostile: "hostility is not observed as a filter criterion; read each row's fields instead",
};
const UNIT_FILTER_TYPES = ["unit", "player", "gameObject", "corpse"] as const;

/**
 * How a `name` criterion is matched, resolved once at normalization. `text`
 * carries the lowercased query for substring matching and tier ranking; `regex`
 * carries a compiled matcher whose results stay in nearest-first order.
 */
type NameMatcher = { kind: "text"; query: string } | { kind: "regex"; re: RegExp };

interface NormalizedUnitFilter {
  entries: Set<number> | undefined;
  name: NameMatcher | undefined;
  type: string | undefined;
  alive: boolean | undefined;
  maxDistance: number | undefined;
  npc: boolean | undefined;
  role: Set<NpcRole> | undefined;
  questGiver: Set<QuestGiverStatusName> | typeof ANY_QUEST_GIVER | undefined;
}

const EMPTY_UNIT_FILTER: NormalizedUnitFilter = {
  entries: undefined,
  name: undefined,
  type: undefined,
  alive: undefined,
  maxDistance: undefined,
  npc: undefined,
  role: undefined,
  questGiver: undefined,
};

/** How a rejected value is quoted back to the caller. */
function showValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function") return "a function";
  if (Array.isArray(v)) return `[${v.map(showValue).join(", ")}]`;
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v) ?? "an object";
  return String(v);
}

function filterError(detail: string): TypeError {
  return new TypeError(`state.units() filter: ${detail}`);
}

/** A finite number, repairing the one unambiguous reading: a numeric string. */
function coerceNumber(value: unknown, key: string, expected: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw filterError(
    `${key} received ${showValue(value)} (${typeof value}), expected ${expected}. ` +
      `Example: state.units({ ${key}: ${key === "entry" ? "69" : "50"} }).`,
  );
}

function coerceBoolean(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  throw filterError(
    `${key} received ${showValue(value)} (${typeof value}), expected true or false. ` +
      `Example: state.units({ ${key}: true }).`,
  );
}

/** `/pat/flags` — a string spelled as a JS regex literal. Flags are the real set. */
const REGEX_LITERAL = /^\/(.*)\/([dgimsuy]*)$/s;

/**
 * Resolve a `name` criterion into a matcher.
 *
 * A `RegExp`, or a string spelled as a regex literal (`"/^tree$/i"`), matches
 * with `RegExp.test`; the caller's own flags decide case-sensitivity. Anything
 * else is a plain case-insensitive substring query. A string that starts with
 * `/` but is not a valid `/pat/flags` (a bad flag, a dangling slash) is a
 * literal name, not an error — but a well-formed literal whose pattern does not
 * compile (`"/tree(/"`) is rejected, because it has exactly one reading and
 * that reading is broken.
 */
function compileNameMatcher(value: unknown): NameMatcher {
  if (value instanceof RegExp) return { kind: "regex", re: value };
  if (typeof value === "string") {
    const m = REGEX_LITERAL.exec(value);
    if (m) {
      try {
        return { kind: "regex", re: new RegExp(m[1] as string, m[2]) };
      } catch (e) {
        throw filterError(
          `name received ${showValue(value)}, which reads as a regex but did not compile ` +
            `(${e instanceof Error ? e.message : String(e)}). Fix the pattern, or pass a plain ` +
            'name string such as { name: "boar" }.',
        );
      }
    }
    return { kind: "text", query: value.toLowerCase() };
  }
  throw filterError(
    `name received ${showValue(value)} (${typeof value}), expected a string (matched as a ` +
      'case-insensitive substring, such as { name: "boar" }) or a RegExp (such as { name: /^tree$/i }).',
  );
}

/** Alphanumeric runs, lowercased: splits creature names on spaces, apostrophes, hyphens. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Whether `query`'s tokens appear as a contiguous run of whole words in `name`. */
function wholeWordMatch(name: string, query: string): boolean {
  const nt = tokenize(name);
  const qt = tokenize(query);
  if (qt.length === 0 || qt.length > nt.length) return false;
  for (let i = 0; i + qt.length <= nt.length; i++) {
    let hit = true;
    for (let j = 0; j < qt.length; j++) {
      if (nt[i + j] !== qt[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * How well `name` fits a plain-string `query`, lowest is best: 0 exact,
 * 1 whole-word, 2 any other substring. Only called for names the substring
 * filter already admitted, so 2 is the floor.
 */
function nameTier(name: string, query: string): number {
  const n = name.toLowerCase();
  if (n === query) return 0;
  if (wholeWordMatch(n, query)) return 1;
  return 2;
}

/**
 * Validate and canonicalize a filter. Returns a shape the scan can apply
 * without re-checking anything.
 */
function normalizeUnitFilter(filter: UnitFilter | undefined): NormalizedUnitFilter {
  if (filter === undefined || filter === null) return EMPTY_UNIT_FILTER;
  if (typeof filter === "function") {
    throw filterError(
      "received a function. This takes a criteria object, not a predicate: " +
        'state.units({ entry: 69, alive: true, maxDistance: 50 }). For a predicate, use state.closest(fn).',
    );
  }
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw filterError(
      `received ${showValue(filter)} (${typeof filter}), expected an object such as ` +
        "{ entry: 69, alive: true, maxDistance: 50 }.",
    );
  }

  const unknown = Object.keys(filter).filter(
    (k) => !(UNIT_FILTER_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    const hints = unknown
      .map((k) => (UNIT_FILTER_KEY_HINTS[k] !== undefined ? `${k}: ${UNIT_FILTER_KEY_HINTS[k]}` : undefined))
      .filter((h): h is string => h !== undefined);
    throw filterError(
      `unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map(showValue).join(", ")}. ` +
        `Valid keys are ${UNIT_FILTER_KEYS.join(", ")}. Drop the key or use one of those.` +
        (hints.length > 0 ? ` (${hints.join("; ")}.)` : ""),
    );
  }

  const out: NormalizedUnitFilter = { ...EMPTY_UNIT_FILTER };

  if (filter.entry !== undefined) {
    const raw = Array.isArray(filter.entry) ? filter.entry : [filter.entry];
    if (raw.length === 0) {
      throw filterError("entry received an empty array; pass a template id such as 69, or omit entry.");
    }
    const entries = new Set<number>();
    for (const item of raw) {
      const n = coerceNumber(item, "entry", "a creature/gameobject template id, or an array of them");
      if (!Number.isInteger(n) || n < 0) {
        throw filterError(
          `entry received ${showValue(item)}, expected a non-negative whole template id such as 69.`,
        );
      }
      entries.add(n);
    }
    out.entries = entries;
  }

  if (filter.name !== undefined) out.name = compileNameMatcher(filter.name);

  if (filter.type !== undefined) {
    // An enum near-miss ("gameobject", "npc") has more than one plausible
    // reading, so reject rather than pick. No case folding here.
    if (!(UNIT_FILTER_TYPES as readonly string[]).includes(filter.type as string)) {
      throw filterError(
        `type received ${showValue(filter.type)}, expected one of ${UNIT_FILTER_TYPES.map(showValue).join(", ")} ` +
          "(exact, case-sensitive).",
      );
    }
    out.type = filter.type;
  }

  if (filter.alive !== undefined) out.alive = coerceBoolean(filter.alive, "alive");
  if (filter.npc !== undefined) out.npc = coerceBoolean(filter.npc, "npc");

  if (filter.role !== undefined) {
    const raw = Array.isArray(filter.role) ? filter.role : [filter.role];
    if (raw.length === 0) throw filterError('role received an empty array; pass a role word such as "vendor", or omit role.');
    const roles = new Set<NpcRole>();
    for (const item of raw) {
      if (typeof item !== "string" || !(NPC_ROLES as readonly string[]).includes(item)) {
        throw filterError(
          `role received ${showValue(item)}, expected one of ${NPC_ROLES.map(showValue).join(", ")} ` +
            "(exact, case-sensitive) or an array of them.",
        );
      }
      roles.add(item as NpcRole);
    }
    out.role = roles;
  }

  if (filter.questGiver !== undefined) {
    // Exact names only: "?"/"!" or "turnin" have more than one reading
    // (reward vs reward_rep vs incomplete), so reject and list the options.
    // `true` is the exception: "does this NPC have anything for me" has one
    // reading (any marker but "none"), so it is honored. `false` has two
    // ("marker observed as none" vs "no marker observed"), so it is rejected.
    if (filter.questGiver === true) {
      out.questGiver = ANY_QUEST_GIVER;
    } else if (typeof filter.questGiver === "boolean") {
      throw filterError(
        'questGiver received false, which has no single meaning here. Use { questGiver: true } for "has any ' +
          'marker at all", or name the statuses you want, e.g. { questGiver: ["available", "reward"] }.',
      );
    } else {
      const raw = Array.isArray(filter.questGiver) ? filter.questGiver : [filter.questGiver];
      if (raw.length === 0) {
        throw filterError(
          'questGiver received an empty array; pass a status name such as "reward", { questGiver: true } for any ' +
            "marker at all, or omit questGiver.",
        );
      }
      const names = new Set<QuestGiverStatusName>();
      for (const item of raw) {
        if (typeof item !== "string" || !(QUEST_GIVER_STATUS_NAMES as readonly string[]).includes(item)) {
          throw filterError(
            `questGiver received ${showValue(item)}, expected one of ${QUEST_GIVER_STATUS_NAMES.map(showValue).join(", ")} ` +
              '(exact, case-sensitive), an array of them, or true for any marker at all. "reward" is a turn-in ready ' +
              'now, "available" a quest on offer, "incomplete" an ender whose quest is not done yet.',
          );
        }
        names.add(item as QuestGiverStatusName);
      }
      out.questGiver = names;
    }
  }

  if (filter.maxDistance !== undefined) {
    const n = coerceNumber(filter.maxDistance, "maxDistance", "a distance in yards");
    if (n < 0) throw filterError(`maxDistance received ${showValue(filter.maxDistance)}, expected a distance >= 0.`);
    out.maxDistance = n;
  }

  return out;
}

/** Drop everything but x/y/z/o: the wire gives a nearby object nothing else. */
function toUnitPosition(pos: PositionData): UnitPosition {
  return { x: pos.x, y: pos.y, z: pos.z, o: pos.o };
}

/** `PLAYER_QUEST_LOG_1_1` .. `_25_1`: 25 slots on 3.3.5. */
const QUEST_LOG_SLOTS = 25;
/** The quest log's completion bit, the one the probe verified live. */
const QUEST_STATE_COMPLETE = 1;
/**
 * A quest log entry's level: the template's when it is positive, else the
 * character's (`Player::GetQuestLevel`, the core's own resolution of a quest
 * that scales to the player). `undefined` when either half is unobserved.
 */
function questLogLevel(template: number | undefined, character: number | undefined): number | undefined {
  if (template === undefined) return undefined;
  return template > 0 ? template : character;
}
/** `QUEST_FLAGS_EXPLORATION` in the template's flags (QuestDef.h): the quest has an exploration objective. */
const QUEST_FLAGS_EXPLORATION = 0x4;
/** A quest-log slot's quest id field, `quest<slot>Id`. */
const QUEST_ID_FIELD = /^quest\d+Id$/;
/** Equipment + bags are 0-22, backpack 23-38 (PROTOCOL.md). */
/**
 * The last `invSlot<n>` this view reads: the bank bags. Older modules stop at
 * 38; newer ones also serve the vendor buyback slots (74-85, `buyback()`), the
 * keyring (86-117) and currency tokens (118-149), which no view lists; only a
 * collect objective's count reads the last two (`carriedItems`).
 */
const INVENTORY_LAST_SLOT = 73;
/** The vendor buyback slots' `invSlot<n>` (`BUYBACK_SLOT_START`, `BUYBACK_SLOT_END - 1`). */
const BUYBACK_FIRST_SLOT = 74;
const BUYBACK_LAST_SLOT = 85;
/** The keyring's first and the currency tokens' last `invSlot<n>` (`KEYRING_SLOT_START`, `CURRENCYTOKEN_SLOT_END - 1`). */
const KEYRING_FIRST_SLOT = 86;
const CURRENCY_LAST_SLOT = 149;
/** `PLAYER_SKILL_INFO_1_1` holds 128 skill slots of three packed u32s each. */
const SKILL_SLOTS = 128;

/** What `foldFactionRow` needs of a wire row (the login flags are optional). */
interface FactionRowLike {
  readonly repListId: number;
  readonly factionId?: number | undefined;
  readonly name?: string | undefined;
  readonly standing: number;
  readonly base?: number | undefined;
  readonly reputation?: number | undefined;
  readonly visible?: boolean | undefined;
  readonly atWar?: boolean | undefined;
}

/** First/last backpack slot in the `invSlot<n>` numbering, and its size. */
const BACKPACK_FIRST_SLOT = 23;
const BACKPACK_SIZE = 16;
const BACKPACK_LAST_SLOT = BACKPACK_FIRST_SLOT + BACKPACK_SIZE - 1;
/** Bank item slots (`BANK_SLOT_ITEM_START..END`) and bank bag slots (`BANK_SLOT_BAG_START..END`), the core's numbering. */
const BANK_FIRST_SLOT = 39;
const BANK_LAST_SLOT = 66;
const BANK_BAG_FIRST_SLOT = 67;
const BANK_BAG_LAST_SLOT = 73;
/** `INVENTORY_SLOT_BAG_0` on the wire: the bag id the item actions take for the backpack. */
const BACKPACK_BAG = 255;

/**
 * `SMSG_TRADE_STATUS` codes the core sends inside an open trade without
 * ending it: 4 the other side accepted, 7 back to trade, and the accept's own
 * refusals that only clear the accept — 10 too far, 12 an inventory error —
 * with 22/23, a slot the server would not take.
 */
const TRADE_WINDOW_NOTICES: ReadonlySet<number> = new Set([4, 7, 10, 12, 22, 23]);

/** A trade side with nothing on it: what a window shows as it opens. */
const emptyTradeSide = (seq: number): TradeSide => ({ money: 0, items: [], seq });
/** Worn-bag equipment slots (`INVENTORY_SLOT_BAG_START..END`): the bag ids the item actions take for them. */
const BAG_FIRST_SLOT = 19;
const BAG_LAST_SLOT = 22;

/**
 * Where an object is at `now` (default: the wall clock), from the freshest
 * thing that said so.
 *
 * Two independent sources with different shapes: `MSG_MOVE_*`/update blocks
 * give an oriented position, `SMSG_MONSTER_MOVE` gives a spline start plus a
 * destination and a duration, and no orientation. A client starts the spline
 * when the packet arrives and draws the unit along it by elapsed time, so a
 * creature mid-spline is read the same way: `now - ts` into `durationMs`, on
 * the straight line from start to destination (the module drops the path
 * points, so a bend in the route is not followed), held at the start before
 * `ts` and at the destination once the duration has run. `ts` is the module's
 * stamp of the packet's arrival — the parked client's own receipt time. A
 * creature re-launched every few milliseconds from the same start, as a stuck
 * chaser is, reads at that start, the way a client shows it running in place.
 * Where it is going stays readable as `obj.motion.value.destination`.
 *
 * A stop reads where it stopped; a spline with no destination reads at its
 * start, and one with no duration (or zero) at its destination, since there is
 * no clock to read it by. The answer carries the source's own `seq`/`ts`.
 * Returns `undefined` rather than guessing when nothing said.
 */
export function pointOf(obj: NearbyObject, now: number = Date.now()): Observed<Point3> | undefined {
  const pos = obj.position;
  const motion = obj.motion;
  if (motion && (!pos || motion.seq >= pos.seq)) {
    return { value: splinePoint(motion.value, now - motion.ts), seq: motion.seq, ts: motion.ts };
  }
  if (!pos) return undefined;
  return { value: { x: pos.value.x, y: pos.value.y, z: pos.value.z }, seq: pos.seq, ts: pos.ts };
}


/** Where a spline puts a unit `elapsedMs` after it was launched: see `pointOf`. */
function splinePoint(m: Motion, elapsedMs: number): Point3 {
  const start = m.position;
  const end = m.destination;
  if (m.stopped || end === undefined) return start;
  const duration = m.durationMs;
  if (duration === undefined || duration <= 0) return end;
  const t = elapsedMs / duration;
  if (!(t > 0)) return start;
  if (t >= 1) return end;
  return {
    x: start.x + t * (end.x - start.x),
    y: start.y + t * (end.y - start.y),
    z: start.z + t * (end.z - start.z),
  };
}

/**
 * Wrong reads of the XP bar, made loud.
 *
 * XP lives on the state object (`state.xp`, `state.nextLevelXp`), not on
 * `state.self`, because it is derived from `self.fields` the same way `money`
 * is. Models do not know that: two model families in the 2026-08-23 window
 * printed `XP: undefined /900` for a whole run reading `state.self.xp` or
 * `state.self.experience`, which are simply absent and so answer `undefined`
 * forever without ever being wrong out loud. The softening policy forbids exactly
 * that: an unusable read must say what it should have been.
 *
 * The getters are non-enumerable on purpose — `snapshot()` spreads `self`, and
 * an enumerable throwing getter would blow up every snapshot, every
 * `JSON.stringify`, and every `Bun.inspect` of the character.
 */
function guardSelfMisreads(self: SelfState): void {
  const wrong: Record<string, string> = {
    xp: "state.self.xp",
    experience: "state.self.experience",
  };
  for (const [key, spelling] of Object.entries(wrong)) {
    Object.defineProperty(self, key, {
      enumerable: false,
      configurable: true,
      get(): never {
        throw new TypeError(
          `${spelling} does not exist. Current XP is state.xp (wrapped: state.xp.value), and the ` +
            `bar's target is state.nextLevelXp (state.nextLevelXp.value). Both are undefined until ` +
            `an event has carried them.`,
        );
      },
    });
  }
}
