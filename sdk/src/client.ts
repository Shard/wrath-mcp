/**
 * The typed client over mod-wrathbench.
 *
 * One method per PROTOCOL.md request, exact shapes, no cleverness. This is the
 * surface the model programs against, so it is deliberately boring.
 *
 * ### The two error channels
 *
 * PROTOCOL.md separates transport/request errors (HTTP non-2xx) from game-level
 * errors (events on the WebSocket). The split is not quite "HTTP vs WS",
 * because `POST /session` is synchronous and therefore reports *game* outcomes
 * — `char_create_failed_code_<N>`, `login_failed`, `timeout` — as HTTP status
 * codes too. So:
 *
 *   - `WrathTransportError`  — the request never got an answer (socket refused,
 *     non-JSON body, abort). Always thrown.
 *   - `WrathRequestError`    — the module answered `{ ok: false }`. Always
 *     thrown, and carries `kind: "request" | "game"` so a caller can tell
 *     `token_in_use` (fix your call) from `char_create_failed_code_47` (the
 *     game said no). The game-level ones are *also* on the event stream.
 *
 * Anything the server decides after an action is acked never appears here at
 * all: it arrives as an event, because that is how a client would learn of it.
 */

import {
  actionResponseSchema,
  characterDeleteResponseSchema,
  deleteSessionResponseSchema,
  errorBodySchema,
  faceResponseSchema,
  guidKey,
  healthResponseSchema,
  isDecodeError,
  isEvent,
  moveToResponseSchema,
  sessionResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type CharacterDeleteResponse,
  type CreateSessionRequest,
  type DeleteSessionResponse,
  type ErrorBody,
  type FaceResponse,
  type GossipMessageData,
  type HealthResponse,
  type KnownMoveStatus,
  type LootItemData,
  type LootResponseData,
  type MoveResultData,
  type MoveStatus,
  type MoveToResponse,
  type OfferedQuest,
  type QuestGiverQuestCompleteData,
  type QuestGiverQuestListData,
  type QuestGiverRequestItemsData,
  type SessionResponse,
} from "./protocol";
import {
  EventStream,
  EventTimeoutError,
  type EventStreamOptions,
  type StreamEvent,
} from "./events";
import {
  pointOf,
  StateCache,
  type ChatEntry,
  type NearbyObject,
  type Point3,
  type QuestLogEntry,
  type UnitPosition,
} from "./state";
import type { z } from "zod";

/** Anything a caller can hand us as a guid. The wire wants a decimal string. */
export type GuidArg = bigint | string;

function guidArg(guid: GuidArg): string {
  return typeof guid === "bigint" ? guidKey(guid) : guid;
}

function toBigInt(guid: GuidArg): bigint {
  return typeof guid === "bigint" ? guid : BigInt(guid);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ground distance. Melee range is a horizontal question — a target one step up
 * a slope is in reach — and it is the only distance the helpers ask about.
 */
function distance2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * A `POST /action` body with the token left out; the client fills it in. The
 * conditional distributes over the union so each member keeps its own fields.
 */
type ActionBody = ActionRequest extends infer T
  ? T extends { token: string }
    ? Omit<T, "token">
    : never
  : never;

/**
 * Error codes PROTOCOL.md documents today. Widened with `(string & {})` on
 * purpose: a module that adds a code must not break the SDK's parsing, only
 * lose the autocompletion for that one code.
 */
export type KnownErrorCode =
  | "missing_token"
  | "missing_character"
  | "token_in_use"
  | "unknown_account"
  | "socket_setup_failed"
  | "login_failed"
  | "character_missing_after_create"
  | "timeout"
  | "unsupported_action"
  | "no_session"
  | "not_in_world"
  | "no_player"
  | "session_gone"
  // movement extension
  | "missing_position"
  | "missing_face_target"
  | "moving";

export type ErrorCode = KnownErrorCode | (string & {});

/** Error codes that report a decision the game server made, not a bad request. */
const GAME_LEVEL_CODES = new Set<string>([
  "login_failed",
  "character_missing_after_create",
  "timeout",
]);

/** The request never completed: no answer, or an answer we could not read. */
export class WrathTransportError extends Error {
  override readonly name = "WrathTransportError";
  constructor(
    message: string,
    readonly detail?: { method: string; path: string; cause?: unknown },
  ) {
    super(message);
  }
}

/** The module answered, and said no. */
/**
 * What a real client's UI displays for SMSG_CHAR_CREATE result codes
 * (ResponseCodes in the core; only the ones a WrathBench run can plausibly
 * hit). Keyed by decimal code as it appears in `char_create_failed_code_<N>`.
 */
const CHAR_RESPONSE_HINTS: Record<number, string> = {
  0x30: "character creation error",
  0x31: "character creation failed",
  0x32: "that name is already in use",
  0x33: "character creation disabled",
  0x35: "the account has reached its character limit on this realm",
  0x36: "the account has reached its character limit",
  0x3a: "class requires an expansion the account lacks",
  0x3e: "that race/class combination is not allowed",
  0x59: "no name given",
  0x5a: "name too short",
  0x5b: "name too long",
  0x5c: "name contains an invalid character",
  0x5d: "name mixes languages (letters only, one language)",
  0x5e: "name is profane",
  0x5f: "name is reserved",
};

export class WrathRequestError extends Error {
  override readonly name = "WrathRequestError";
  readonly status: number;
  readonly code: ErrorCode;
  /** `"game"` when the code reports a server decision; `"request"` otherwise. */
  readonly kind: "request" | "game";
  /** Parsed out of `char_create_failed_code_<N>`, when that is the code. */
  readonly charCreateResultCode: number | undefined;
  readonly body: ErrorBody;

  constructor(status: number, body: ErrorBody) {
    const match = /^char_create_failed_code_(\d+)$/.exec(body.error);
    // The numeric code is the server's word; the parenthetical is the string a
    // real client's UI shows for it (GlobalStrings) — client-visible knowledge,
    // added because a bare number proved unactionable in live runs.
    const hint = match ? CHAR_RESPONSE_HINTS[Number(match[1])] : undefined;
    super(`module rejected request: ${body.error}${hint ? ` (${hint})` : ""} (HTTP ${status})`);
    this.status = status;
    this.code = body.error;
    this.charCreateResultCode = match?.[1] !== undefined ? Number(match[1]) : undefined;
    this.kind = match !== null || GAME_LEVEL_CODES.has(body.error) ? "game" : "request";
    this.body = body;
  }
}

export interface ConnectOptions {
  /** e.g. `http://worldserver:8086`. */
  baseUrl: string;
  /** Opaque session id chosen by the caller; scopes both actions and events. */
  token: string;
  /** Defaults to `baseUrl` with an `ws://`/`wss://` scheme. */
  eventsUrl?: string;
  /** Open the event stream during `connect`. Default true; see the note below. */
  subscribeEvents?: boolean;
  /** Per-request timeout. Default 30000 — `POST /session` blocks up to 20s. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  events?: Omit<EventStreamOptions, "url" | "token">;
  state?: { chatTail?: number; notificationTail?: number };
}

export interface WaitForChatOptions {
  timeout?: number;
  sinceSeq?: number;
  includeBuffered?: boolean;
}

/** A point to walk to. `o` is ignored: `move_to` takes no orientation. */
export interface MovePoint {
  x: number;
  y: number;
  z: number;
}

export interface MoveToOptions {
  /**
   * How long to wait for the terminal `WB_MOVE_RESULT`. Default 90000: the
   * single-move cap is ~250yd, which is ~36s at a base run speed of 7yd/s,
   * plus the module's 3s server-confirmation deadline and slack for a path
   * that is longer than the straight line.
   */
  timeout?: number;
}

/**
 * The outcome of a `move_to`, as the server decided it.
 *
 * A *returned* discriminated union rather than a thrown error, and deliberately
 * so: PROTOCOL.md splits transport/request errors (HTTP non-2xx) from
 * game-level outcomes (events), and `no_path` / `too_far` / `interrupted` are
 * squarely the second kind — the game answering the question that was asked,
 * not the call being wrong. Modelling them as exceptions would put a normal
 * answer ("there is no path there") on the same channel as `not_in_world`, and
 * a snippet that forgot a `try` would abort a run over it. `if (!result.ok)` is
 * hard to forget and hard to get wrong.
 *
 * `position` is the server-confirmed position the character actually ended at,
 * whatever the status — which is exactly what the next decision needs.
 */
export type MoveResult =
  | {
      readonly ok: true;
      readonly status: "arrived";
      readonly moveId: number;
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
    }
  | {
      readonly ok: false;
      readonly status: Exclude<KnownMoveStatus, "arrived"> | (string & {});
      readonly moveId: number;
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
    };

export interface WaitForNearbyOptions {
  timeout?: number;
}

export interface DeleteCharacterOptions {
  /** Defaults to the module's configured account, as `POST /session` does. */
  account?: string;
  /** How many times to send the delete. Default 8. */
  attempts?: number;
  /** Wait before the *first* attempt; the core needs a moment after logout. */
  initialDelayMs?: number;
  /** Wait between attempts. Default 3000. */
  retryDelayMs?: number;
}

export interface KillTargetOptions {
  /**
   * Give up after this long and return `status: "timeout"`. Default 25000,
   * chosen to sit under the runner's 30s snippet cap: a call that outlives the
   * snippet is abandoned mid-fight and its verdict is never seen. Raise it only
   * from a background routine, which outlives the snippet that started it.
   */
  timeout?: number;
  /** How often to re-face the target while swinging. Default 1500. */
  refaceIntervalMs?: number;
  /** How often to check whether the target has wandered out of reach. Default 6000. */
  reapproachIntervalMs?: number;
  /** Distance beyond which we walk to the target again. Default 5 yards. */
  meleeRange?: number;
  /** How often the loop looks at the world. Default 300. */
  pollIntervalMs?: number;
  /**
   * Send `attack_stop` on the way out even when the fight did not end — i.e.
   * on `timeout` and `lost`, which otherwise leave the character swinging.
   * Default false. See `KillResult.attacking`.
   */
  disengage?: boolean;
  /**
   * Break off when our own health drops below this percent of max (0-100).
   * Returns `aborted_low_health` and always disengages, because the point of
   * asking is to stop taking hits. Unobserved health never triggers it.
   */
  abortBelowHealthPct?: number;
}

/** What every `KillResult` carries, whatever the outcome. */
interface KillResultFacts {
  readonly guid: bigint;
  readonly swings: number;
  /** Our own health as a percent of max at exit; `undefined` when unobserved. */
  readonly healthPct: number | undefined;
  /**
   * Whether we left auto-attack running. The server keeps swinging from a
   * single `CMSG_ATTACKSWING` until it is cancelled, and cancelling it while
   * both combatants are alive is how a character gets killed standing still —
   * so a fight that has not ended is left armed unless `disengage` was asked
   * for. Call `attackStop()` when you actually want to break off.
   */
  readonly attacking: boolean;
  /** One line about how it ended and what state the character was left in. */
  readonly detail: string;
}

/**
 * How a fight ended, as a value (ADR-0011).
 *
 * `killed` is the target's own observed health reaching zero — the thing a
 * player watches the health bar for. The failures are deliberately coarse, and
 * in particular there is no `evaded`: a creature resetting is not separately
 * observable on this whitelist (no packet says "evade"; the tells a player
 * reads are the mob running off and healing, which is exactly what `timeout`
 * and `lost` already cover). Naming a status the module never uttered would put
 * an SDK invention where only the world's words belong. `aborted_low_health` is
 * the one status that reports *our* decision rather than the world's, and it
 * says so.
 */
export type KillResult =
  | ({ readonly ok: true; readonly status: "killed" } & KillResultFacts)
  | ({
      readonly ok: false;
      /**
       * `player_died` — we died. `lost` — it left view alive. `timeout` — still
       * up. `aborted_low_health` — we broke off at `abortBelowHealthPct`.
       */
      readonly status: "player_died" | "lost" | "timeout" | "aborted_low_health";
    } & KillResultFacts);

/** How each outcome reads, before the note and the armed/disarmed clause. */
const KILL_DETAIL: Record<KillResult["status"], string> = {
  killed: "target died",
  player_died: "we died",
  lost: "target left view alive",
  timeout: "timed out with both alive",
  aborted_low_health: "broke off on low health",
};

/**
 * Whether the character is left swinging. Only an ended fight disarms, unless
 * the caller asked to disengage; an outcome we never reached (the helper threw)
 * counts as "still fighting".
 */
function leavingArmed(status: KillResult["status"] | undefined, disengage: boolean): boolean {
  if (disengage) return false;
  return !(status === "killed" || status === "player_died" || status === "aborted_low_health");
}

/** Re-arm guards: never faster than this, never more than this many per fight. */
const REARM_MIN_INTERVAL_MS = 500;
const REARM_CAP = 20;

export interface LootOptions {
  /** How long to wait for the loot window / release. Default 10000. */
  timeout?: number;
}

/** What a corpse gave up. `empty` means the server closed the window at once. */
export type LootResult =
  | {
      readonly ok: true;
      readonly status: "looted";
      readonly gold: number;
      readonly items: readonly LootItemData[];
    }
  | { readonly ok: false; readonly status: "empty"; readonly gold: 0; readonly items: readonly [] };

export interface QuestOptions {
  timeout?: number;
}

/**
 * The outcome of asking a questgiver for a quest.
 *
 * `already_in_log` is a success and not a curiosity: turn-in chains at this
 * commit auto-advance, so the core may have added the follow-up quest to the
 * log during the previous turn-in and an explicit accept would be a no-op. The
 * quest log is the truth, so the helper reads it first and says so.
 */
export type QuestAcceptResult =
  | {
      readonly ok: true;
      readonly status: "accepted" | "already_in_log";
      readonly questId: number;
      readonly quest: QuestLogEntry;
      readonly title: string | undefined;
    }
  | {
      readonly ok: false;
      readonly status: "not_offered";
      readonly questId: number;
      /** What the NPC did offer, so a caller can say what it saw. */
      readonly offered: readonly OfferedQuest[];
    };

/** The outcome of a turn-in. `not_complete` is the questgiver refusing. */
export type QuestTurnInResult =
  | {
      readonly ok: true;
      readonly status: "complete";
      readonly questId: number;
      readonly xp: number;
      readonly money: number;
    }
  | { readonly ok: false; readonly status: "not_complete"; readonly questId: number };

/**
 * Connect to the module and (by default) subscribe to the event stream.
 *
 * The subscription is opened *before* any session exists, on purpose: the whole
 * login handshake — `SMSG_AUTH_RESPONSE`, `SMSG_CHAR_ENUM`,
 * `SMSG_LOGIN_VERIFY_WORLD` — is emitted while `POST /session` is still
 * blocking, and it is the only source for the character list and the starting
 * position. Connecting first is what makes the state cache complete.
 */
export async function connect(options: ConnectOptions): Promise<WrathClient> {
  const client = new WrathClient(options);
  if (options.subscribeEvents ?? true) await client.events.connect();
  return client;
}

export class WrathClient {
  readonly token: string;
  readonly baseUrl: string;
  readonly events: EventStream;
  readonly state: StateCache;

  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ConnectOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

    const wsBase = options.eventsUrl ?? this.baseUrl.replace(/^http/, "ws");
    this.events = new EventStream({
      ...options.events,
      url: `${wsBase.replace(/\/+$/, "")}/events`,
      token: options.token,
    });
    this.state = new StateCache(options.state ?? {});
    // Registered before the socket opens, so the cache sees every frame.
    this.events.onAny((event: StreamEvent) => this.state.apply(event));
  }

  // ------------------------------------------------------------- endpoints

  /** GET /health. Module and world status; no auth, not session-scoped. */
  health(): Promise<HealthResponse> {
    return this.request("GET", "/health", undefined, healthResponseSchema);
  }

  /**
   * POST /session — create (or reuse) the character and enter the world.
   * Blocks server-side until the session is in the world or fails, up to 20s.
   *
   * Seeds the state cache with our own guid and name, which no event carries.
   */
  async createSession(request: Omit<CreateSessionRequest, "token">): Promise<SessionResponse> {
    // Runtime guard: race/class must be numeric ids. A string like "hunter"
    // used to be silently coerced to 0 by the module and the server then
    // created a default Human Warrior — the wrong character with no error
    // (observed live, gate2-ox-1). Fail loudly instead.
    for (const key of ["race", "class"] as const) {
      const v = (request as Record<string, unknown>)[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 11)) {
        throw new WrathRequestError(400, {
          ok: false,
          error:
            `invalid_${key}: must be a numeric id 1-11, got ${JSON.stringify(v)} ` +
            `(e.g. race 1 = Human, class 2 = Paladin)`,
        });
      }
    }
    const body: CreateSessionRequest = { token: this.token, ...request };
    const res = await this.request("POST", "/session", body, sessionResponseSchema);
    this.state.seedSelf({ guid: res.guid, name: res.character });
    return res;
  }

  /**
   * POST /action with `action: "say"`. Acks that the opcode was synthesized and
   * queued — the chat echo (or a `SMSG_NOTIFICATION` rejection) is an event.
   * The language is chosen server-side from the character's team.
   */
  say(text: string): Promise<ActionResponse> {
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "say", text },
      actionResponseSchema,
    );
  }

  /**
   * POST /action with `action: "move_to"`. Acks "queued and pathing"; the
   * outcome is a `WB_MOVE_RESULT` event. Prefer `moveTo`, which waits for it.
   */
  moveToAsync(point: MovePoint): Promise<MoveToResponse> {
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "move_to", x: point.x, y: point.y, z: point.z },
      moveToResponseSchema,
    );
  }

  /**
   * POST /action with `action: "stop"`. Returns as soon as the module has
   * queued the `MSG_MOVE_STOP` — it does not wait for the character to halt.
   * The in-flight `moveTo` is what resolves, with `status: "stopped"`, and its
   * result carries where the character actually came to rest.
   */
  stop(): Promise<ActionResponse> {
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "stop" },
      actionResponseSchema,
    );
  }

  /**
   * POST /action with `action: "face"` — turn in place.
   *
   * Takes either an absolute orientation in radians (0 = east/+x,
   * counter-clockwise) or a point to turn toward; the module resolves a point
   * into an orientation and echoes the one it used. Rejects with
   * `WrathRequestError` code `moving` while a move is running — stop first, or
   * supersede with `moveTo`.
   */
  face(orientationOrPoint: number | { x: number; y: number }): Promise<FaceResponse> {
    const body =
      typeof orientationOrPoint === "number"
        ? { token: this.token, action: "face", orientation: orientationOrPoint }
        : { token: this.token, action: "face", x: orientationOrPoint.x, y: orientationOrPoint.y };
    return this.request("POST", "/action", body, faceResponseSchema);
  }

  // ------------------------------------- quest/combat actions (one per opcode)
  //
  // Thin by design: each is exactly one row of PROTOCOL.md's single-opcode
  // table, and each acks "queued". Everything the *game* then decides — a cast
  // failure, a gossip menu, a loot window, an inventory error — arrives as an
  // event, never as a return value here. The composed helpers below are the
  // ones that wait for a verdict.

  /** `CMSG_SET_SELECTION`. What the client shows as the current target. */
  setTarget(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "set_target", guid: guidArg(guid) });
  }

  /** `CMSG_SET_SELECTION` with guid 0. */
  clearTarget(): Promise<ActionResponse> {
    return this.action({ action: "clear_target" });
  }

  /**
   * `CMSG_ATTACKSWING` — start melee auto-attack. The server swings while the
   * character is in range *and facing the victim*; see `killTarget` for why
   * that second condition needs help here.
   */
  attackStart(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "attack_start", guid: guidArg(guid) });
  }

  /** `CMSG_ATTACKSTOP`. */
  attackStop(): Promise<ActionResponse> {
    return this.action({ action: "attack_stop" });
  }

  /** `CMSG_CAST_SPELL`. No target guid means self/auto-target. */
  castSpell(spellId: number, targetGuid?: GuidArg): Promise<ActionResponse> {
    return this.action(
      targetGuid === undefined
        ? { action: "cast_spell", spellId }
        : { action: "cast_spell", spellId, targetGuid: guidArg(targetGuid) },
    );
  }

  /** `CMSG_CANCEL_CAST`. */
  cancelCast(spellId: number): Promise<ActionResponse> {
    return this.action({ action: "cancel_cast", spellId });
  }

  /** `CMSG_GAMEOBJ_USE` — chests, doors, quest objects. */
  interact(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "interact", guid: guidArg(guid) });
  }

  /** `CMSG_GOSSIP_HELLO` — opens the NPC menu (`SMSG_GOSSIP_MESSAGE`). */
  gossipHello(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "gossip_hello", guid: guidArg(guid) });
  }

  /** `CMSG_GOSSIP_SELECT_OPTION`; ids come from `SMSG_GOSSIP_MESSAGE`. */
  gossipSelect(guid: GuidArg, menuId: number, optionId: number): Promise<ActionResponse> {
    return this.action({ action: "gossip_select", guid: guidArg(guid), menuId, optionId });
  }

  /**
   * `CMSG_QUESTGIVER_HELLO`. The answer is `SMSG_QUESTGIVER_QUEST_LIST` — or,
   * on a gossip-flagged NPC, an `SMSG_GOSSIP_MESSAGE` with the quests embedded.
   * `acceptQuestFrom` handles both shapes.
   */
  questList(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "quest_list", guid: guidArg(guid) });
  }

  /** `CMSG_QUESTGIVER_QUERY_QUEST` — quest text via `..._QUEST_DETAILS`. */
  questDetails(guid: GuidArg, questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_details", guid: guidArg(guid), questId });
  }

  /** `CMSG_QUESTGIVER_ACCEPT_QUEST`. */
  questAccept(guid: GuidArg, questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_accept", guid: guidArg(guid), questId });
  }

  /** `CMSG_QUESTGIVER_COMPLETE_QUEST` — answered by REQUEST_ITEMS or OFFER_REWARD. */
  questComplete(guid: GuidArg, questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_complete", guid: guidArg(guid), questId });
  }

  /** `CMSG_QUESTGIVER_CHOOSE_REWARD`; index into `choiceRewards`, 0 when none. */
  questChooseReward(guid: GuidArg, questId: number, rewardIndex = 0): Promise<ActionResponse> {
    return this.action({ action: "quest_choose_reward", guid: guidArg(guid), questId, rewardIndex });
  }

  /** `CMSG_QUESTLOG_REMOVE_QUEST`; the module maps quest id to log slot. */
  questAbandon(questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_abandon", questId });
  }

  /** `CMSG_LOOT` — opens the loot window (`SMSG_LOOT_RESPONSE`). */
  loot(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "loot", guid: guidArg(guid) });
  }

  /**
   * `CMSG_LOOT` plus the auto-loot follow-ups the client sends once the window
   * arrives (ADR-0013). Fire-and-forget: prefer `lootCorpse`, which waits.
   */
  lootAll(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "loot_all", guid: guidArg(guid) });
  }

  /** `CMSG_AUTOSTORE_LOOT_ITEM`; `slot` from `SMSG_LOOT_RESPONSE.items[]`. */
  lootItem(slot: number): Promise<ActionResponse> {
    return this.action({ action: "loot_item", slot });
  }

  /** `CMSG_LOOT_MONEY`. */
  lootMoney(): Promise<ActionResponse> {
    return this.action({ action: "loot_money" });
  }

  /** `CMSG_LOOT_RELEASE` — closes the loot window. */
  lootRelease(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "loot_release", guid: guidArg(guid) });
  }

  /** `CMSG_LIST_INVENTORY` — `SMSG_LIST_INVENTORY` follows. */
  vendorList(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "vendor_list", guid: guidArg(guid) });
  }

  /** `CMSG_BUY_ITEM`; `slot` is the 1-based vendor slot. */
  buyItem(guid: GuidArg, itemId: number, slot: number, count?: number): Promise<ActionResponse> {
    return this.action({ action: "buy_item", guid: guidArg(guid), itemId, slot, count });
  }

  /** `CMSG_SELL_ITEM`; omit `count` to sell the whole stack. */
  sellItem(guid: GuidArg, itemGuid: GuidArg, count?: number): Promise<ActionResponse> {
    return this.action({ action: "sell_item", guid: guidArg(guid), itemGuid: guidArg(itemGuid), count });
  }

  /** `CMSG_REPAIR_ITEM` with item guid 0 — repair everything. */
  repairAll(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "repair_all", guid: guidArg(guid) });
  }

  /** `CMSG_AUTOEQUIP_ITEM`; bag 255 is the backpack, slots 23-38. */
  equipItem(bag: number, slot: number): Promise<ActionResponse> {
    return this.action({ action: "equip_item", bag, slot });
  }

  /** `CMSG_USE_ITEM`; the module fills the item guid and its on-use spell. */
  useItem(bag: number, slot: number, targetGuid?: GuidArg): Promise<ActionResponse> {
    return this.action({
      action: "use_item",
      bag,
      slot,
      targetGuid: targetGuid === undefined ? undefined : guidArg(targetGuid),
    });
  }

  /** `CMSG_DESTROYITEM`; omit `count` to destroy the whole stack. */
  destroyItem(bag: number, slot: number, count?: number): Promise<ActionResponse> {
    return this.action({ action: "destroy_item", bag, slot, count });
  }

  /** `CMSG_REPOP_REQUEST` — release the spirit while dead. */
  repop(): Promise<ActionResponse> {
    return this.action({ action: "repop" });
  }

  /** `CMSG_RECLAIM_CORPSE` — resurrect at the corpse. */
  reclaimCorpse(guid?: GuidArg): Promise<ActionResponse> {
    return this.action({
      action: "reclaim_corpse",
      guid: guid === undefined ? undefined : guidArg(guid),
    });
  }

  /**
   * POST /character-delete — delete a character by name through the real
   * `CMSG_CHAR_DELETE` path. Not the session token: the module stands up its
   * own parked session, so this takes (and defaults) a throwaway one per
   * attempt (ADR-0013).
   *
   * Retrying is in here rather than in the caller because the retry is a
   * property of the module's contract, not of any one script: for up to about
   * a minute after logout the core still tracks an offline session for the
   * character and silently ignores the delete, which surfaces as `504 timeout`
   * — or, if the module's internal wait outlasts `requestTimeoutMs`, as an
   * aborted request. Both mean "not released yet", so both are retried.
   * Anything else the module says (`character_not_found`, `account_in_use`, a
   * `char_delete_failed_code_<N>`) is a real answer and is thrown straight out.
   */
  async deleteCharacter(
    character: string,
    options: DeleteCharacterOptions = {},
  ): Promise<CharacterDeleteResponse> {
    const attempts = options.attempts ?? 8;
    const retryDelay = options.retryDelayMs ?? 3000;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 || options.initialDelayMs !== undefined) {
        await sleep(attempt === 0 ? (options.initialDelayMs ?? 0) : retryDelay);
      }
      try {
        const res = await this.request(
          "POST",
          "/character-delete",
          {
            // A fresh token per attempt: a reused one can still be held by the
            // parked session the previous attempt timed out on.
            token: `${this.token}-del${attempt}`,
            character,
            account: options.account,
          },
          characterDeleteResponseSchema,
        );
        if (res.deleted) return res;
        last = new Error(`module answered ok without deleted:true for ${character}`);
      } catch (e) {
        // `account_in_use` is the same not-yet-released transient as `timeout`:
        // the core holds a logged-out session for ~60s (PROTOCOL.md).
        const retryable =
          e instanceof WrathTransportError ||
          (e instanceof WrathRequestError && (e.code === "timeout" || e.code === "account_in_use"));
        if (!retryable) throw e;
        last = e;
      }
    }
    throw new WrathTransportError(
      `character-delete for ${character} never returned deleted:true in ${attempts} attempts` +
        ` (last: ${String(last)})`,
      { method: "POST", path: "/character-delete", cause: last },
    );
  }

  /** DELETE /session — log the character out (a real client-style disconnect). */
  deleteSession(): Promise<DeleteSessionResponse> {
    return this.request(
      "DELETE",
      "/session",
      { token: this.token },
      deleteSessionResponseSchema,
    );
  }

  /** Alias for `deleteSession`, which is what it means in game terms. */
  logout(): Promise<DeleteSessionResponse> {
    return this.deleteSession();
  }

  /** Close the event stream. Does not log the character out. */
  close(): void {
    this.events.close();
  }

  // --------------------------------------------------------------- helpers
  //
  // Only what the current protocol supports. No speculative helpers
  // (docs/ARCHITECTURE.md): a helper is added when a run needed it.

  /**
   * Wait for a chat line. `match` is either an exact message string or a
   * predicate over the decoded entry. Searches events already received before
   * waiting, so it is safe to call after the action has been acked.
   */
  async waitForChat(
    match: string | ((entry: ChatEntry) => boolean),
    options: WaitForChatOptions = {},
  ): Promise<ChatEntry> {
    const predicate = typeof match === "string" ? (e: ChatEntry) => e.message === match : match;
    const event = await this.events.waitFor((e) => {
      if (!isEvent(e, "SMSG_MESSAGECHAT") || isDecodeError(e.data)) return false;
      return predicate(toChatEntry(e.seq, e.ts, e.data));
    }, options);
    return toChatEntry(event.seq, event.ts, event.data as ChatFields);
  }

  /**
   * Walk to a world position and wait for the server's verdict.
   *
   * Issues `move_to`, then resolves on the `WB_MOVE_RESULT` carrying the same
   * `moveId`. The result is *returned*, not thrown, for every outcome the game
   * decides — see `MoveResult` for why. Still thrown:
   *
   *   - `WrathRequestError` — the request was refused before anything moved
   *     (`missing_position`, `not_in_world`, `no_session`, …).
   *   - `EventTimeoutError` — no result arrived within `timeout`. That is not
   *     an outcome, it is the *absence* of one: the character may well still be
   *     walking, and pretending otherwise (a synthetic `status: "timeout"`)
   *     would put an SDK invention in a field that otherwise only ever holds
   *     the module's own words.
   *
   * A `moveTo` issued while another is running supersedes it; the older call
   * resolves with `status: "superseded"`.
   */
  async moveTo(point: MovePoint, options: MoveToOptions = {}): Promise<MoveResult> {
    const ack = await this.moveToAsync(point);
    // The match is the moveId alone, and the buffer is searched: a result can
    // land while the POST response is still in flight (an immediate `no_path`
    // does exactly that). No `sinceSeq` bound — `seq` restarts when a token's
    // session is recreated, so any seq-based floor can outrun the very event it
    // is meant to admit, while `moveId` is unique per session and issued by the
    // ack we are holding.
    const event = await this.events.waitFor(
      (e) =>
        isEvent(e, "WB_MOVE_RESULT") &&
        !isDecodeError(e.data) &&
        (e.data as MoveResultData).moveId === ack.moveId,
      { timeout: options.timeout ?? 90_000 },
    );
    const data = event.data as MoveResultData;
    const status: MoveStatus = data.status;
    const position: UnitPosition = {
      x: data.pos.x,
      y: data.pos.y,
      z: data.pos.z,
      o: data.pos.o,
    };
    const common = { moveId: data.moveId, position, seq: event.seq, ts: event.ts } as const;
    return status === "arrived"
      ? { ok: true, status: "arrived", ...common }
      : { ok: false, status, ...common };
  }

  /**
   * Wait until an object in view satisfies `predicate`.
   *
   * Reads the state cache, not the raw stream: what puts an object in view is
   * a whole `SMSG_UPDATE_OBJECT` fold plus, usually, a later query response
   * that gives it a name — no single event answers "is there a named creature
   * nearby". The cache is updated before waiters run, so re-checking it on
   * every event is exact.
   *
   * Returns the live cache entry (as every `state` query does); take
   * `state.snapshot()` if you need it frozen.
   */
  async waitForNearby(
    predicate: (obj: NearbyObject) => boolean,
    options: WaitForNearbyOptions = {},
  ): Promise<NearbyObject> {
    const scan = (): NearbyObject | undefined => {
      for (const obj of this.state.nearby.values()) {
        try {
          if (predicate(obj)) return obj;
        } catch {
          /* a throwing predicate is not a match */
        }
      }
      return undefined;
    };
    const already = scan();
    if (already) return already;

    let hit: NearbyObject | undefined;
    await this.events.waitFor(
      () => {
        hit = scan();
        return hit !== undefined;
      },
      // The buffer is not re-scanned: those events are already folded into the
      // cache, and `scan()` above has just looked at the result.
      { timeout: options.timeout ?? 10_000, includeBuffered: false },
    );
    // `waitFor` only resolves when `scan()` found something.
    return hit as NearbyObject;
  }

  /**
   * Fight a target until it (or we) drops.
   *
   * Owns the whole melee loop, because every part of it turned out to be
   * load-bearing on live runs:
   *
   *   - **facing**. A synthesized character never auto-faces the way a client
   *     does, and the server drops a swing that is not facing its victim. So
   *     the target is faced before the first swing and re-faced every
   *     `refaceIntervalMs` — through `faceQuietly`, because the module refuses
   *     a `face` while a move is running and a fight must not end over that.
   *   - **re-approach**. Creatures wander and get knocked around; if the
   *     target drifts beyond `meleeRange` the loop walks back in and swings
   *     again.
   *   - **approach**. The first swing is issued from melee range, not from
   *     wherever the character happened to be standing: a `killTarget` on
   *     something 50 yards off used to spend its whole timeout out of reach and
   *     land zero swings.
   *   - **death**. Ours ends the fight immediately (`player_died`); theirs is
   *     read off the observed health reaching zero.
   *   - **staying armed**. One `CMSG_ATTACKSWING` makes the server swing until
   *     it is cancelled; movement does not cancel it, and only `attack_stop`,
   *     a death, losing the target or re-targeting does. So `attack_stop` is
   *     sent only when the fight actually ended (`killed`, `player_died`,
   *     `aborted_low_health`) or when `disengage: true` was asked for.
   *     `timeout` and `lost` leave the character swinging — disarming a
   *     half-fought mob is how a character dies — and `attacking`/`detail` say
   *     so. If the helper throws, the character is likewise left as it was.
   *   - **re-arming**. If the server reports our auto-attack stopped
   *     (`SMSG_ATTACKSTOP`, not because we died) while the target is still
   *     alive and still ours, the loop swings again, rate-limited and capped.
   *
   * The default `timeout` (25s) is deliberately under the runner's 30s snippet
   * cap so an in-snippet call returns its verdict rather than being abandoned
   * mid-fight; a longer fight belongs in a background routine. An approach walk
   * that outlasts the deadline — before the first swing or after it — is folded
   * into `detail` and reported as `timeout` rather than thrown, so the outcome
   * stays a value.
   *
   * Returns a value for every game outcome and throws only for a refused
   * request. The caller is expected to loot afterwards: `killTarget` does not,
   * because a fight and a corpse are two decisions.
   */
  async killTarget(guid: GuidArg, options: KillTargetOptions = {}): Promise<KillResult> {
    const id = toBigInt(guid);
    const key = guidKey(id);
    const refaceMs = options.refaceIntervalMs ?? 1500;
    const reapproachMs = options.reapproachIntervalMs ?? 6000;
    const meleeRange = options.meleeRange ?? 5;
    const pollMs = options.pollIntervalMs ?? 300;
    const deadline = Date.now() + (options.timeout ?? 25_000);
    const abortPct = options.abortBelowHealthPct;

    let swings = 0;
    const offSwing = this.events.on("SMSG_ATTACKERSTATEUPDATE", (e) => {
      if (isDecodeError(e.data)) return;
      if ((e.data as { attackerGuid: bigint }).attackerGuid === this.state.self.guid) swings++;
    });
    // The server cancelling our swing is observable, so react to it rather than
    // assuming the opening `attack_start` holds for the whole fight. The
    // handler only raises a flag; the loop decides, because by the time it runs
    // the cache may already know the victim is dead.
    let rearmWanted = false;
    const offStop = this.events.on("SMSG_ATTACKSTOP", (e) => {
      if (isDecodeError(e.data)) return;
      const d = e.data as { attackerGuid: bigint; victimGuid: bigint; attackerDead: boolean };
      if (d.attackerGuid !== this.state.self.guid || d.attackerDead) return;
      if (d.victimGuid !== id) return; // a re-target names the *old* victim
      rearmWanted = true;
    });

    const aimAt = (): Point3 | undefined => {
      const obj = this.state.nearby.get(key);
      return obj === undefined ? undefined : pointOf(obj)?.value;
    };
    const selfDead = (): boolean => this.state.self.health?.value.current === 0;
    const targetDead = (): boolean => this.state.nearby.get(key)?.health?.value.current === 0;
    /** Our health as a percent of max, or undefined while it is unobserved. */
    const healthPct = (): number | undefined => {
      const h = this.state.self.health?.value;
      if (h === undefined || h.max <= 0) return undefined;
      return (h.current / h.max) * 100;
    };

    let outcome: KillResult["status"] | undefined;
    let note = "";
    /**
     * Walk to the target, recording what the walk did. A walk that never
     * finishes is the clock running out, which the loop reports as `timeout` on
     * its next tick — so it is folded into `note` rather than thrown out of a
     * helper whose whole contract is a value per outcome.
     */
    const walkTo = async (at: Point3): Promise<void> => {
      try {
        const walk = await this.moveTo(at, { timeout: Math.max(1000, deadline - Date.now()) });
        if (!walk.ok) note = ` (approach: ${walk.status})`;
      } catch (e) {
        if (!(e instanceof EventTimeoutError)) throw e;
        note = " (approach never finished)";
      }
    };
    const done = (status: KillResult["status"]): KillResult => {
      outcome = status;
      const armed = leavingArmed(status, options.disengage === true);
      const facts: KillResultFacts = {
        guid: id,
        swings,
        healthPct: healthPct(),
        attacking: armed,
        detail:
          `${KILL_DETAIL[status]}${note}; ` +
          (armed
            ? "still auto-attacking — call attackStop() or pass { disengage: true } to break off"
            : "auto-attack stopped"),
      };
      return status === "killed"
        ? { ok: true, status, ...facts }
        : { ok: false, status, ...facts };
    };

    try {
      await this.setTarget(id);
      // Close the distance before the first swing, so it is a swing and not a
      // 25-second stare. A walk that runs out the clock is an answer too.
      const opening = aimAt();
      const from = this.state.self.position?.value;
      if (opening && from && distance2d(from, opening) > meleeRange) await walkTo(opening);
      const facing = aimAt();
      if (facing) await this.faceQuietly(facing);
      await this.attackStart(id);

      let refaceAt = Date.now() + refaceMs;
      let reapproachAt = Date.now() + reapproachMs;
      let rearms = 0;
      let rearmNotBefore = 0;
      for (;;) {
        if (targetDead()) return done("killed");
        if (selfDead()) return done("player_died");
        if (!this.state.nearby.has(key)) return done("lost");
        if (abortPct !== undefined) {
          const pct = healthPct();
          if (pct !== undefined && pct < abortPct) {
            note = ` (health ${pct.toFixed(0)}% below the ${abortPct}% floor)`;
            return done("aborted_low_health");
          }
        }
        if (Date.now() > deadline) return done("timeout");

        const at = aimAt();
        const now = Date.now();
        if (rearmWanted) {
          rearmWanted = false;
          // Re-checked here, not in the handler: an ATTACKSTOP for a victim
          // that is about to be reported dead must not re-arm into a corpse.
          if (rearms < REARM_CAP && now >= rearmNotBefore && !targetDead()) {
            rearms++;
            rearmNotBefore = now + REARM_MIN_INTERVAL_MS;
            if (at) await this.faceQuietly(at);
            await this.attackStart(id);
          }
        }
        if (at && now >= refaceAt) {
          refaceAt = now + refaceMs;
          await this.faceQuietly(at);
        }
        if (at && now >= reapproachAt) {
          reapproachAt = now + reapproachMs;
          const pos = this.state.self.position?.value;
          if (pos && distance2d(pos, at) > meleeRange) {
            await walkTo(at);
            const after = aimAt();
            if (after) await this.faceQuietly(after);
            await this.attackStart(id);
          }
        }
        await sleep(pollMs);
      }
    } finally {
      offSwing();
      offStop();
      // Only disarm when the fight is over, or when the caller asked. Anything
      // else — including an exception on the way out — leaves the server
      // swinging, because a disarmed character in a live fight dies.
      if (!leavingArmed(outcome, options.disengage === true)) {
        await this.attackStop().catch(() => {});
      }
    }
  }

  /**
   * Empty a corpse and wait until the window is closed again.
   *
   * `loot_all` is the module replaying the client's auto-loot sequence
   * (ADR-0013), so this is one action plus the two events that bracket it: the
   * window that says what was there, and the release that says it is finished.
   * A corpse with nothing on it releases without ever opening a window, which
   * is `{ ok: false, status: "empty" }` — an answer, not a failure. Silence is
   * neither, so it still throws `EventTimeoutError`.
   */
  async lootCorpse(guid: GuidArg, options: LootOptions = {}): Promise<LootResult> {
    const id = toBigInt(guid);
    const timeout = options.timeout ?? 10_000;
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.lootAll(id);
    const first = await this.events.waitFor(
      (e) =>
        (isEvent(e, "SMSG_LOOT_RESPONSE") || isEvent(e, "SMSG_LOOT_RELEASE_RESPONSE")) &&
        !isDecodeError(e.data) &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout },
    );
    if (first.opcode === "SMSG_LOOT_RELEASE_RESPONSE") {
      return { ok: false, status: "empty", gold: 0, items: [] };
    }
    const window = first.data as LootResponseData;
    await this.events.waitFor((e) => isEvent(e, "SMSG_LOOT_RELEASE_RESPONSE"), {
      timeout,
      sinceSeq: first.seq + 1,
      includeBuffered: true,
    });
    return { ok: true, status: "looted", gold: window.gold, items: window.items };
  }

  /**
   * Take a quest from an NPC and confirm it landed in the quest log.
   *
   * Two shapes of "here are my quests" have to be accepted, because a
   * gossip-flagged questgiver answers `quest_list` with an
   * `SMSG_GOSSIP_MESSAGE` carrying the quests rather than an
   * `SMSG_QUESTGIVER_QUEST_LIST`. And the log is checked *first*, because a
   * turn-in chain may already have added the quest for us.
   */
  async acceptQuestFrom(
    npcGuid: GuidArg,
    questId: number,
    options: QuestOptions = {},
  ): Promise<QuestAcceptResult> {
    const timeout = options.timeout ?? 10_000;
    const inLog = this.state.quest(questId);
    if (inLog) {
      return { ok: true, status: "already_in_log", questId, quest: inLog, title: undefined };
    }

    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.questList(npcGuid);
    const menu = await this.events.waitFor(
      (e) =>
        (isEvent(e, "SMSG_QUESTGIVER_QUEST_LIST") || isEvent(e, "SMSG_GOSSIP_MESSAGE")) &&
        !isDecodeError(e.data) &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout },
    );
    const offered = (menu.data as QuestGiverQuestListData | GossipMessageData).quests ?? [];
    const wanted = offered.find((q) => q.questId === questId);
    if (!wanted) return { ok: false, status: "not_offered", questId, offered };

    await this.questAccept(npcGuid, questId);
    const quest = await this.waitForState(() => this.state.quest(questId), timeout);
    return { ok: true, status: "accepted", questId, quest, title: wanted.title };
  }

  /**
   * Hand a finished quest back and take a reward.
   *
   * `quest_complete` is answered either with the reward offer or with
   * `SMSG_QUESTGIVER_REQUEST_ITEMS` — which, when it says the quest *is*
   * completable, is the client's cue to send the completion again to get the
   * offer. A `completable: false` is the questgiver saying no, and comes back
   * as `{ ok: false, status: "not_complete" }`.
   */
  async turnInQuest(
    npcGuid: GuidArg,
    questId: number,
    rewardIndex = 0,
    options: QuestOptions = {},
  ): Promise<QuestTurnInResult> {
    const timeout = options.timeout ?? 10_000;
    const isFor = (e: StreamEvent, opcode: "SMSG_QUESTGIVER_OFFER_REWARD" | "SMSG_QUESTGIVER_REQUEST_ITEMS") =>
      isEvent(e, opcode) &&
      !isDecodeError(e.data) &&
      (e.data as { questId: number }).questId === questId;

    for (let attempt = 0; attempt < 2; attempt++) {
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.questComplete(npcGuid, questId);
      const answer = await this.events.waitFor(
        (e) =>
          (isFor(e, "SMSG_QUESTGIVER_OFFER_REWARD") || isFor(e, "SMSG_QUESTGIVER_REQUEST_ITEMS")) &&
          (sinceSeq === undefined || e.seq > sinceSeq),
        { timeout },
      );
      if (answer.opcode === "SMSG_QUESTGIVER_REQUEST_ITEMS") {
        const req = answer.data as QuestGiverRequestItemsData;
        if (!req.completable) return { ok: false, status: "not_complete", questId };
        continue; // completable: ask again, which is what the client does.
      }
      await this.questChooseReward(npcGuid, questId, rewardIndex);
      const complete = await this.events.waitFor(
        (e) =>
          isEvent(e, "SMSG_QUESTGIVER_QUEST_COMPLETE") &&
          !isDecodeError(e.data) &&
          (e.data as QuestGiverQuestCompleteData).questId === questId,
        { timeout, sinceSeq: answer.seq + 1 },
      );
      const d = complete.data as QuestGiverQuestCompleteData;
      return { ok: true, status: "complete", questId, xp: d.xp, money: d.money };
    }
    return { ok: false, status: "not_complete", questId };
  }

  /**
   * Wait until the quest log says a quest's objectives are done.
   *
   * The quest log — not an event — is the source, because the core does not
   * emit `SMSG_QUESTUPDATE_COMPLETE` for kill objectives at the pinned commit:
   * the only thing that reports a finished kill objective to a client is the
   * completion bit in the served quest-log state field. Resolves with the log
   * entry, whose `counts` are the objective counters; throws
   * `EventTimeoutError` if it never completes, because a quest that is still
   * unfinished is the absence of an outcome rather than one (ADR-0011).
   */
  waitForQuestObjective(questId: number, options: QuestOptions = {}): Promise<QuestLogEntry> {
    return this.waitForState(() => {
      const q = this.state.quest(questId);
      return q?.complete === true ? q : undefined;
    }, options.timeout ?? 60_000);
  }

  /** Our own guid as a map key, once the session response has seeded it. */
  get selfKey(): string | undefined {
    return this.state.self.guid === undefined ? undefined : guidKey(this.state.self.guid);
  }

  // --------------------------------------------------------------- internals

  /** One `POST /action`, with the session token filled in. */
  private action(body: ActionBody): Promise<ActionResponse> {
    return this.request("POST", "/action", { token: this.token, ...body }, actionResponseSchema);
  }

  /**
   * `face`, with the module's refusals swallowed.
   *
   * A real client faces its target continuously and simply cannot fail at it;
   * the module's `face` is a single opcode that the module rejects with `409
   * moving` while a move is running, and the character may also have died or
   * left the world between the decision and the call. None of those are worth
   * ending a fight over, so this is the one place the SDK drops a request
   * error on the floor — and it is why every re-face tick in `killTarget` goes
   * through here.
   */
  private async faceQuietly(point: { x: number; y: number }): Promise<void> {
    try {
      await this.face(point);
    } catch (e) {
      // Swallow ONLY the load-bearing refusal (409 while a move is active):
      // anything else — no_session, session_gone, transport loss — must
      // surface so a dead session fails the fight fast instead of burning
      // its timeout on invisible re-face ticks.
      if (e instanceof WrathRequestError && e.code === "moving") return;
      throw e;
    }
  }

  /**
   * Wait until a predicate over the *state cache* holds. Checks immediately,
   * then re-checks on every event, which is exact because the cache is folded
   * before waiters run. Throws `EventTimeoutError` if it never holds.
   */
  private async waitForState<T>(read: () => T | undefined, timeout: number): Promise<T> {
    const already = read();
    if (already !== undefined) return already;
    let hit: T | undefined;
    await this.events.waitFor(
      () => {
        hit = read();
        return hit !== undefined;
      },
      { timeout, includeBuffered: false },
    );
    return hit as T;
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    if (schema === undefined || typeof (schema as { safeParse?: unknown }).safeParse !== "function") {
      throw new TypeError(
        `request(${method}, ${path}) needs a Zod schema as its 4th argument — ` +
          `prefer the typed methods on the client over calling request() directly`,
      );
    }
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      throw new WrathTransportError(`${method} ${path} failed: ${String(cause)}`, {
        method,
        path,
        cause,
      });
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new WrathTransportError(
        `${method} ${path} returned HTTP ${res.status} with a non-JSON body`,
        { method, path, cause },
      );
    }

    if (!res.ok) {
      const err = errorBodySchema.safeParse(json);
      if (!err.success) {
        throw new WrathTransportError(
          `${method} ${path} returned HTTP ${res.status} with an unrecognised error body`,
          { method, path },
        );
      }
      throw new WrathRequestError(res.status, err.data);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new WrathTransportError(
        `${method} ${path} response did not match the protocol: ${parsed.error.message}`,
        { method, path },
      );
    }
    return parsed.data;
  }
}

type ChatFields = Omit<ChatEntry, "seq" | "ts">;

function toChatEntry(seq: number, ts: number, d: ChatFields): ChatEntry {
  return {
    seq,
    ts,
    type: d.type,
    language: d.language,
    senderGuid: d.senderGuid,
    message: d.message,
    chatTag: d.chatTag,
  };
}
