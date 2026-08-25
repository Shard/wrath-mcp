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
  encodeRawPayload,
  rawOpcodeSchema,
  rawPayloadSchema,
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
  type CorpseReclaimDelayData,
  type CorpseQueryData,
  type CreateSessionRequest,
  type DeathReleaseLocData,
  type DeleteSessionResponse,
  type ErrorBody,
  type FaceResponse,
  type GossipMessageData,
  type HealthResponse,
  type InventoryChangeFailureData,
  type ItemPushResultData,
  type KnownMoveStatus,
  type LootItemData,
  type LootResponseData,
  type MoveResultData,
  type MoveUpdateData,
  type MoveStatus,
  type MoveToResponse,
  type NewWorldData,
  type TransferAbortedData,
  type OfferedQuest,
  type QuestGiverQuestCompleteData,
  type QuestGiverQuestListData,
  type QuestGiverRequestItemsData,
  type QuestGiverStatusData,
  type QuestGiverStatusMultipleData,
  type RawPayload,
  type SessionResponse,
  type TalentsInfoData,
  type TrainerBuyFailedData,
  type TrainerListData,
  type TrainerSpellData,
} from "./protocol";
import {
  EventAbortedError,
  EventStream,
  EventTimeoutError,
  type EventStreamOptions,
  type StreamEvent,
  type WaitForOptions,
} from "./events";
import {
  pointOf,
  questGiverStatusName,
  StateCache,
  type ChatEntry,
  type CorpseLocation,
  type NearbyObject,
  type Point3,
  type QuestLogEntry,
  type TalentState,
  type UnitPosition,
  type UnitView,
  type WorldPosition,
} from "./state";
import type { z } from "zod";

/**
 * What every guid-taking method accepts: the opaque decimal string the SDK
 * itself hands out (ADR-0017). The wire form is the same string.
 */
export type GuidArg = string;

/**
 * Client-side guid validation, thrown before anything reaches the wire.
 *
 * `number` is rejected outright: 3.3.5a guids carry a high part above
 * Number.MAX_SAFE_INTEGER, so a numeric guid has usually already been
 * precision-truncated — a live trajectory showed one silently targeting
 * nothing. `undefined` is rejected with a pointer to where guids come from,
 * because the module's own `missing_guid` reply cannot name the JS call site.
 *
 * A `bigint` is not on the surface any more (nothing SDK-visible produces
 * one), but a model can still conjure one (`123n`) and it names exactly one
 * guid — so it is repaired to the string form rather than rejected, per
 * ADR-0016's deterministic-repair rule.
 *
 * Everything else — objects, arrays, booleans — is rejected too, or the
 * `asserts` clause would be a lie: the commonest live mistake is passing the
 * whole unit (`sdk.setTarget(state.closest(...))`) instead of `.guid`, and
 * letting it reach the wire buys only the module's generic `invalid_guid`,
 * which cannot name the JS call site or the `.guid` fix.
 */
function assertGuid(guid: unknown, arg: string): asserts guid is string | bigint {
  if (guid === undefined || guid === null) {
    throw new TypeError(
      `${arg} is ${guid === undefined ? "undefined" : "null"} — pass a guid as its decimal ` +
        `string (guids come from state.nearbyUnits(), state.closest(...), or event data)`,
    );
  }
  if (typeof guid === "number") {
    throw new TypeError(
      `${arg} is a number — guids exceed Number.MAX_SAFE_INTEGER and a number silently loses ` +
        `precision (targeting nothing); pass the decimal string the state cache gave you (unit.guid)`,
    );
  }
  if (typeof guid !== "string" && typeof guid !== "bigint") {
    const kind = Array.isArray(guid) ? "an array" : typeof guid === "object" ? "an object" : `a ${typeof guid}`;
    throw new TypeError(
      `${arg} is ${kind}, not a guid — pass the .guid field itself (unit.guid, not the whole ` +
        `unit): the opaque decimal string from state.nearbyUnits(), state.closest(...), or event data`,
    );
  }
}

function guidArg(guid: GuidArg, arg: string): string {
  assertGuid(guid, arg);
  return typeof guid === "bigint" ? guidKey(guid) : guid;
}

/**
 * What a composed helper accepts for the thing it acts on: the opaque guid
 * string, or a whole unit from `state.units(...)` / `state.closest(...)`.
 * Passing the unit is the common case — the model just found it — so the
 * helpers read `.guid` off it rather than making the model destructure.
 */
export type GuidOrUnit = GuidArg | UnitView;

/**
 * Resolve a helper's target to a guid string. A `UnitView` (or any object) has
 * its `.guid` taken; a missing or unusable one is rejected loudly with a
 * pointer back to where units come from (ADR-0016). A non-object falls through
 * to `guidArg`, so a bare guid string keeps its exact existing validation — and
 * raw actions (`setTarget`, `attackStart`, `gossipSelect`) still take only that
 * string form, on purpose: referent selection is what this bench measures.
 */
function guidOf(target: GuidOrUnit, arg: string): string {
  if (target !== null && typeof target === "object") {
    const guid = (target as { guid?: unknown }).guid;
    if (typeof guid === "string" && guid.length > 0) return guidArg(guid, arg);
    throw new TypeError(
      `${arg} got an object with no usable .guid (received ${showTarget(target)}) — pass a unit from ` +
        `state.units(...) or state.closest(...) (each carries a .guid), or the guid string itself`,
    );
  }
  return guidArg(target, arg);
}

/** A one-line description of a rejected target object, for the error message. */
function showTarget(target: object): string {
  try {
    const json = JSON.stringify(target);
    if (json !== undefined) return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    /* circular or otherwise unserialisable */
  }
  return Array.isArray(target) ? "an array" : "an object";
}

/**
 * Deterministic repair (ADR-0016) for `moveTo(x, y, z)` written as three
 * positional numbers instead of one `{ x, y, z }`. That shape has exactly one
 * valid reading, and weak models write it across every family (nemotron, hy3,
 * gpt-oss trajectories 2026-08-22). Returns the repaired point, or null when
 * the call is not that shape — every other bad shape still hits the loud
 * assertMovePoint reject. Only the helper `moveTo` repairs the positional form;
 * raw `moveToAsync` stays strict about it (ADR-0015: raw actions do not soften).
 * Target *resolution* — point, unit, or guid — is shared by both: it is what the
 * call names, not a rewriting of what it said.
 */
function repairThreeArgMove(
  point: unknown,
  options: unknown,
  rest: unknown[],
): { point: MovePoint; options: MoveToOptions } | null {
  // point=x, options=y, rest[0]=z. A trailing rest[1] object is the real
  // options (moveTo(x, y, z, { timeout })); anything else is ignored.
  if (typeof point === "number" && typeof options === "number" && typeof rest[0] === "number") {
    const trailing = rest[1];
    const opts = trailing !== null && typeof trailing === "object" ? (trailing as MoveToOptions) : {};
    return { point: { x: point, y: options, z: rest[0] }, options: opts };
  }
  return null;
}

/** Client-side position validation for move_to: each axis a finite number. */
function assertMovePoint(point: unknown, method: string): asserts point is MovePoint {
  if (point === null || typeof point !== "object") {
    throw new TypeError(`${method} needs a point object { x, y, z }, got ${point === null ? "null" : typeof point}`);
  }
  for (const axis of ["x", "y", "z"] as const) {
    const v = (point as Record<string, unknown>)[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      const shown = v === undefined ? "undefined" : typeof v === "number" ? String(v) : typeof v;
      throw new TypeError(`${method} position ${axis} must be a finite number, got ${shown}`);
    }
  }
}

/**
 * What a move target resolved to: a point to walk to (with a note when the
 * resolution is worth stating), or nothing walkable at all.
 */
type ResolvedMoveTarget = { point: MovePoint; guid?: string; note?: string } | { unknown: string };

/** The guid a move target names, or undefined when it is (meant to be) a point. */
function moveTargetGuid(target: unknown): string | bigint | undefined {
  if (typeof target === "string" || typeof target === "bigint") return target;
  if (target !== null && typeof target === "object") {
    const guid = (target as { guid?: unknown }).guid;
    if (typeof guid === "string" && guid.length > 0) return guid;
    if (typeof guid === "bigint") return guid;
  }
  return undefined;
}

/** The finite x/y/z the caller's own object carries, when it carries all three. */
function ownPoint(target: unknown): MovePoint | undefined {
  if (target === null || typeof target !== "object") return undefined;
  const t = target as Record<string, unknown>;
  const { x, y, z } = t;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  return { x, y, z };
}

/**
 * Resolve `moveTo`'s target to a point (ADR-0015 earned surface: 4 of 7 runs in
 * the 2026-08-23 fan-out threw a raw `TypeError: moveTo position x must be a
 * finite number, got undefined` from `.x` on a lookup that found nothing).
 *
 * A point is untouched — same validation, same messages, same wire call. A unit
 * or guid resolves through the state cache, exactly the position `state.units()`
 * would report; a unit the cache has lost falls back to the coordinates that
 * unit object itself carries *and says so*, because walking to where something
 * was without mentioning it is the silent-wrong-behaviour ADR-0016 forbids; and
 * a guid nothing can be found for is a typed answer, not a throw.
 */
function resolveMoveTarget(target: unknown, state: StateCache, method: string): ResolvedMoveTarget {
  const guid = moveTargetGuid(target);
  if (guid === undefined) {
    // Not a guid-shaped argument: the point path, byte-identical to before —
    // including the message a bare number or a two-axis object earns.
    assertMovePoint(target, method);
    return { point: { x: target.x, y: target.y, z: target.z } };
  }
  let key: string;
  try {
    key = guidKey(guid);
  } catch {
    throw new TypeError(
      `${method} got ${JSON.stringify(String(guid))}, which is neither a point nor a decimal guid string — ` +
        `pass a point { x, y, z }, a unit from state.units(...) / state.closest(...), or that unit's .guid`,
    );
  }
  // The guid rides along as a planning hint: a unit's z is the z its own
  // movement packets carried, and for a patrolling or sloped NPC that can sit
  // outside the mesh's poly-search box while the ground under it is walkable.
  // With `guid` the module resolves z to the ground at x,y first (PROTOCOL.md
  // move_to); the request still walks to x,y, never to wherever the guid is.
  const obj = state.nearby.get(key);
  const seen = obj === undefined ? undefined : pointOf(obj)?.value;
  if (seen !== undefined) return { point: { x: seen.x, y: seen.y, z: seen.z }, guid: key };
  const own = ownPoint(target);
  if (own !== undefined) {
    return {
      point: own,
      guid: key,
      note:
        `guid ${key} is not in view any more, so this walked to (${fmtXY(own)}) — where the object you ` +
        `passed last saw it, not a live position. Re-read state.units(...) on arrival.`,
    };
  }
  const where = obj === undefined ? "not in view" : "in view but has no observed position yet";
  return {
    unknown:
      `${method}: guid ${key} is ${where}, so there is no position to walk to (undefined means unobserved, ` +
      `never zero). ` +
      (obj === undefined
        ? `Re-read a current unit with state.units(...) / state.closest(...) — guids go stale when a unit ` +
          `leaves view — or pass a point { x, y, z }.`
        : `Read it again from state.units(...) in a moment, or pass a point { x, y, z }.`),
  };
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
 * Error codes PROTOCOL.md documents today, as a runtime list so tests can pin
 * the hint table against it (every code here renders a hint). Widened with
 * `(string & {})` in `ErrorCode` on purpose: a module that adds a code must
 * not break the SDK's parsing, only lose the autocompletion for that one code.
 *
 * Deliberately absent: the per-parameter `missing_*` family beyond the three
 * listed (the module's reply echoes `action` and `param`, which is the hint),
 * the parametric `char_create_failed_code_<N>` / `char_delete_failed_code_<N>`
 * (hinted via `CHAR_RESPONSE_HINTS`), and the dispatch-level `not_found` /
 * `internal` (not reachable through the typed client methods).
 */
export const KNOWN_ERROR_CODES = [
  "missing_token",
  "missing_character",
  "token_in_use",
  "unknown_account",
  "account_not_permitted",
  "account_owned_by_other_token",
  "account_in_use",
  "character_not_found",
  "invalid_race_class",
  "socket_setup_failed",
  "login_failed",
  "character_missing_after_create",
  "timeout",
  "unsupported_action",
  "no_session",
  "not_in_world",
  "no_player",
  "session_gone",
  // movement extension
  "missing_position",
  "missing_face_target",
  "moving",
  // guid-taking actions
  "missing_guid",
  "invalid_guid",
  // raw passthrough (ADR-0025)
  "opcode_not_allowed",
  "invalid_payload",
  "payload_too_large",
] as const;

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

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
  // The name is the model's own choice (ADR-0050), so this one code is not a
  // dead end but a retry: say what to do about it, in the game's own rules.
  0x32:
    "that name is already in use — choose a different character name and call createSession again " +
    "(2-12 letters, no spaces, no three identical letters in a row; be creative, it is yours for the episode)",
  0x33: "character creation disabled",
  0x35: "the account has reached its character limit on this realm",
  0x36: "the account has reached its character limit",
  0x3a: "class requires an expansion the account lacks",
  0x3e: "that race/class combination is not allowed",
  // The name is the caller's own (ADR-0050), so every naming refusal is a
  // retry: it says what the server objected to AND that another name is the
  // way out. Unreachable while the harness assigned the name; not any more.
  0x59: "no name given — choose a character name (2-12 letters, no spaces) and pass it to createSession",
  0x5a: "name too short — choose a longer name (2-12 letters) and call createSession again",
  0x5b: "name too long — choose a shorter name (2-12 letters) and call createSession again",
  0x5c: "name contains an invalid character — letters only, no spaces, digits or punctuation; choose another and call createSession again",
  0x5d: "name mixes languages (letters only, one language) — choose another and call createSession again",
  0x5e: "name is profane — choose another and call createSession again",
  0x5f: "name is reserved — choose another and call createSession again",
};

/**
 * One actionable sentence per request-error code, rendered into the
 * `WrathRequestError` message. Deterministic and model-agnostic: the same
 * pattern as `CHAR_RESPONSE_HINTS`, extended to the codes live runs actually
 * hit. Keys are module error codes (KnownErrorCode plus codes the module
 * added later); an unknown code simply renders without a hint.
 */
const ERROR_CODE_HINTS: Record<string, string> = {
  account_in_use:
    "you already have a live session on this account — sdk already works; do not call createSession again",
  no_session: "call await connect() then await sdk.createSession({...}) first",
  not_in_world:
    "the character is not in the world — if a createSession is still resolving, let it finish; " +
    "if the session is stuck, await sdk.deleteSession() first, then await sdk.createSession({...})",
  token_in_use:
    "another session already holds this token — reuse the existing session; if it is defunct " +
    "(no_player/session_gone), await sdk.deleteSession() to release the token, then await sdk.createSession({...})",
  no_player:
    "the session exists but its player is gone — await sdk.deleteSession() to release the token, " +
    "then await sdk.createSession({...}); a bare createSession is refused with token_in_use while the old record remains",
  session_gone:
    "the session was torn down but its record can still hold the token — await sdk.deleteSession() " +
    "(ignore its error), then await sdk.createSession({...})",
  unsupported_action:
    "that action is not in the module's whitelist — inspect the sdk surface for what is supported",
  moving: "a move is in progress — await sdk.stop() first, or supersede it with sdk.moveTo(...)",
  missing_guid:
    "this action needs a guid argument — get one from state.nearbyUnits() or state.closest(...)",
  missing_position: "move_to needs finite x, y and z numbers",
  missing_face_target: "face needs either an orientation in radians or an { x, y } point",
  missing_token: "the request body is missing its session token — call through the sdk client methods",
  missing_character: "createSession needs a character name",
  unknown_account:
    "no account with that name exists in the server's auth database — it passed the allowlist, " +
    "so check the account name itself (or that the account was created on this realm)",
  account_not_permitted:
    "the account name is not on the module's WrathBench.Accounts allowlist for this realm — use a permitted account",
  account_owned_by_other_token:
    "another live session's token holds a character on this account — wait for that session to end, or use a different account",
  character_not_found: "no character with that name exists on this account — check the name and the account",
  invalid_race_class:
    "that race/class pair is not a legal 3.3.5a combination — pass numeric ids that go together (e.g. race 1 Human, class 1 Warrior)",
  socket_setup_failed: "the module could not open the internal client socket — retry once, then check the server",
  login_failed: "the server refused the login — check the character name and account",
  character_missing_after_create: "the character did not appear after creation — retry createSession once",
  timeout: "the module's internal wait ran out — the world may be busy; retry once before assuming failure",
  invalid_guid:
    "the guid did not parse as a decimal u64 string — pass unit.guid exactly as the state cache gave it, never a rounded number",
  weak_token:
    "the session token is shorter than 32 characters — the module refuses guessable tokens; " +
    "the runner issues a random one per run, so this means a hand-passed token needs replacing",
  item_not_usable:
    "the server refused CMSG_USE_ITEM for that bag/slot — the item there has no on-use effect, " +
    "or the slot is empty or shifted (slots move after looting/selling); check state.bag()",
  opcode_not_allowed:
    "sdk.raw() only sends the CMSG_* names on the module's allowlist (module/PROTOCOL.md, \"raw\"); " +
    "an opcode that already has a dedicated sdk method must go through that method",
  invalid_payload:
    "the raw payload did not reach the module as whole hex bytes — pass a field list like " +
    "[{ u32: id }, { guid: unit.guid }] and let the SDK pack it",
  payload_too_large: "a raw payload is capped at 512 bytes — no client packet on the allowlist needs more",
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
    const hint = match ? CHAR_RESPONSE_HINTS[Number(match[1])] : ERROR_CODE_HINTS[body.error];
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
  /**
   * The game account this run occupies, bound operator-side exactly like
   * `token` (ADR-0016, addendum 2026-08-22). When set it is authoritative: it
   * fills an omitted `createSession`/`deleteCharacter` account and overrides any
   * account the model typed, so a snippet can never land on — or delete on —
   * the wrong account (the RUNNER6→RUNNER cross-account corruption this closes).
   * Which account a run occupies is fleet infra, not a model decision, so the
   * model is not told it and cannot choose it. Left undefined (standalone /
   * MCP) the prior behavior stands: the caller's account, else the module
   * default.
   */
  account?: string;
  /** Defaults to `baseUrl` with an `ws://`/`wss://` scheme. */
  eventsUrl?: string;
  /** Open the event stream during `connect`. Default true; see the note below. */
  subscribeEvents?: boolean;
  /** Per-request timeout. Default 30000 — `POST /session` blocks up to 20s. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  events?: Omit<EventStreamOptions, "url" | "token">;
  state?: { chatTail?: number; notificationTail?: number };
  /**
   * Default abort signal for every wait the client performs (`moveTo`,
   * `waitForTransfer`, `killTarget`, `turnInQuest`, … — anything that awaits an
   * event with a deadline). A function is consulted at the start of each wait,
   * which is how the runner threads the *current snippet's* signal in without
   * the snippet passing anything: when a snippet is abandoned, the waits it
   * left behind reject with `EventAbortedError` instead of outliving it. An
   * explicit `signal` on a call still wins. Undefined means no default.
   */
  signal?: AbortSignal | (() => AbortSignal | undefined);
  /**
   * When the caller's current budget runs out, as an epoch-ms instant (or a
   * function consulted per call, the way `signal` is). The runner passes the
   * moment the sandbox will abandon the running snippet; nothing about a wait
   * changes because of it — it is used only to say, in a `moveTo` result's
   * `hint`, that the walk was always longer than the snippet had left
   * (ADR-0016 rule 2: explain, do not cap). Undefined means no budget is known.
   */
  deadline?: number | (() => number | undefined);
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

/**
 * What `moveTo`/`moveToAsync` accept: a world point, or the thing standing at
 * one — a unit from `state.units(...)` / `state.closest(...)`, or its guid.
 * The unit forms resolve to that unit's position in the state cache at call
 * time (ADR-0015: earned by the 2026-08-23 fan-out, where 4 of 7 runs threw a
 * raw `TypeError` reading `.x` off a lookup that returned nothing).
 */
export type MoveTarget = MovePoint | GuidOrUnit;

/** Base run speed in yards per second, 3.3.5a. Used only for the ETA hint. */
const RUN_SPEED_YPS = 7;

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
      /**
       * Present when the navmesh resolved the request to a ground z more than
       * 1y from the z asked for: the move still arrived (x/y matched), and this
       * is the z it actually walked to. Quote it next time.
       */
      readonly meshZ?: number;
      /**
       * What the result means beyond the status: the z the mesh chose (`meshZ`
       * above), and/or the note that this walk was longer than the caller's
       * remaining snippet budget. Absent when there is nothing to say.
       */
      readonly hint?: string;
      /**
       * Present when the move ended aboard a transport (tram car, boat) that
       * the server is now carrying the character on. `state.self.position`
       * keeps updating from `WB_RIDE_PROGRESS` for the ride.
       */
      readonly onTransport?: { readonly guid: string; readonly entry: number };
    }
  | {
      readonly ok: true;
      readonly status: "transferred";
      readonly moveId: number;
      /** Where the character was on the old map when the portal took it. */
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
      /** The map and arrival point `SMSG_NEW_WORLD` announced, server-confirmed. */
      readonly to: WorldPosition;
      readonly hint: string;
    }
  | {
      /**
       * A same-map teleport (Hearthstone, graveyard port) took the character
       * mid-move. No map change: `to` is the arrival point the server's
       * `MSG_MOVE_TELEPORT_ACK` carried, already on `state.self.position`.
       */
      readonly ok: true;
      readonly status: "teleported";
      readonly moveId: number;
      /** Where the character was when the teleport took it. */
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
      readonly to: UnitPosition;
      readonly hint: string;
    }
  | {
      /**
       * Nothing was dispatched: the unit or guid handed to `moveTo` names no
       * position the state cache can see, so there is no point to walk to and
       * no move to have an outcome. Not a `WB_MOVE_RESULT` status — the module's
       * status vocabulary is the module's word (ADR-0027); this arm is the SDK
       * answering before the wire, the way `killTarget` answers `lost`.
       */
      readonly ok: false;
      readonly status: "unknown_target";
      /** Never present here: there was no move. */
      readonly moveId?: undefined;
      readonly position?: undefined;
      readonly seq?: undefined;
      readonly ts?: undefined;
      readonly reachedPos?: undefined;
      readonly dz?: undefined;
      /** Why the target resolved to nothing, and what to pass instead. */
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: Exclude<KnownMoveStatus, "arrived" | "transferred" | "teleported"> | (string & {});
      readonly moveId: number;
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
      /**
       * `path_incomplete`: how far the mesh could get toward the request (the
       * module already tried one subdivision from here); route around, or
       * approach from another side. `drop`: the last point before the route
       * steps off a ledge — the edge, on the character's level.
       */
      readonly reachedPos?: Point3;
      /** `drop` only: the signed vertical step the route would have taken at `reachedPos`. */
      readonly dz?: number;
      /** What the status means and what to try next. See `MOVE_HINTS`. */
      readonly hint?: string;
    };

/**
 * Per-status recovery recipes (ADR-0016 rule 2: what happened, what it means,
 * the next step), in the result rather than in a trajectory nobody reads twice.
 * Before the module split `no_path` into causes (FOLLOW-UPS 38 N1) one hint
 * covered four failures and qwen (2026-08-22 roster) spent 8 turns discovering
 * which one it had; the cause is now the module's word and the hint is only the
 * recovery that follows from it.
 */
export const MOVE_HINTS: Readonly<Record<string, (point: MovePoint, data: MoveResultData) => string>> = {
  too_far: (p, d) =>
    `(${fmtXY(p)}) is ${Math.round(Math.hypot(p.x - d.pos.x, p.y - d.pos.y))}y away in a straight line; ` +
    `a single moveTo covers ~250y. Walk to an intermediate point first.`,
  no_mesh: (p) =>
    `no navmesh is loaded under you or under (${fmtXY(p)}); this is a harness data limitation, not a route ` +
    `problem. Nothing to retry here — choose a destination in a mapped area.`,
  target_off_mesh: (p) =>
    `(${fmtXY(p)}) is not on walkable ground within 4y (z is searched ±50y, so a wrong z alone is not the ` +
    `cause). Pick a point on a road or floor, or where an NPC stands.`,
  start_off_mesh: () =>
    `the character's own position is not on the walkable mesh (a transport deck, a ledge, a wedge of ` +
    `terrain the mesh misses), so no destination and no sweep of nearby points can fix it. Step a few ` +
    `yards onto ordinary ground if you can; when every moveTo fails the same way, stop(), stand still a ` +
    `few seconds, then useItem() the Hearthstone from state.bag() — it is a spell cast, ignores pathing, ` +
    `and returns you to your bound inn; retry it if the cast fails with SPELL_FAILED_MOVING.`,
  path_incomplete: (p, d) =>
    `the walkable mesh has no continuous route to (${fmtXY(p)})` +
    (d.reachedPos ? `; it ends at (${fmtXY(d.reachedPos)})` : "") +
    `. The module already tried one subdivision. Route around (a road, a ramp, a door) or approach from ` +
    `another side.`,
  drop: (p, d) => {
    const edge = d.reachedPos ?? d.pos;
    const n = d.dz === undefined ? "several" : Math.abs(d.dz).toFixed(1);
    return (
      `the route to (${fmtXY(p)}, z ${p.z.toFixed(1)}) steps off a ledge of ${n} yards at (${fmtXY(edge)}); ` +
      `the character stopped at the edge and did not take the drop. Pick a destination on this level, or ` +
      `find the ramp/stairs that connect the two.`
    );
  },
  interrupted: () =>
    `the move stopped early (death, root, stun, or the server rejected the movement). Check state.self, ` +
    `then retry from where you are.`,
};

/**
 * The move statuses that mean *nothing moved and no movement packet was sent*.
 * After one of these the server's last word about the character can still be a
 * `MOVEMENTFLAG_FORWARD` heartbeat from a move this request superseded, which
 * keeps `isMoving()` true and fails every later cast with
 * `SPELL_FAILED_MOVING`. `moveTo` sends the stop a client would; see the call
 * site for the trajectory this was earned from.
 *
 * Not in the set, and why: `arrived` and `interrupted` (the module sent the
 * stop itself), `stopped` (a stop is what ended it), `superseded` (a newer move
 * is walking now), `transferred` and `teleported` (the teleport's own ack is
 * the server's next movement word).
 */
const MOVE_LEAVES_NO_STOP: ReadonlySet<string> = new Set([
  "too_far",
  "no_mesh",
  "target_off_mesh",
  "start_off_mesh",
  "path_incomplete",
  "drop",
]);

/**
 * What an `arrived` with `meshZ` means. Within 3y the mesh corrected a stale
 * z and the agent should quote the mesh's value. Beyond that the module's
 * drop guard should have refused the walk, so the honest reading is that the
 * character ended a level away from where it asked to go — not that its z
 * was wrong (nav-probe c4, map 369: the old one-shape hint told an agent to
 * "quote z -6.9 next time" after the mesh walked it 7.6y down a ledge).
 */
export const MESH_Z_QUOTE_BAND = 3;
export function meshZHint(point: { x: number; y: number; z: number }, meshZ: number): string {
  const dz = meshZ - point.z;
  const head = `arrived at (${fmtXY(point)}), but the ground there is at z ${meshZ.toFixed(1)}, not ${point.z.toFixed(1)}.`;
  if (Math.abs(dz) <= MESH_Z_QUOTE_BAND) {
    return `${head} The mesh owns z; quote ${meshZ.toFixed(1)} for this spot next time.`;
  }
  const dir = dz < 0 ? "below" : "above";
  return (
    `${head} The character ended ${Math.abs(dz).toFixed(1)} yards ${dir} the requested point — a different ` +
    `level, not a stale z: the z passed to moveTo is not what put it there. Check state.self.position before ` +
    `the next move; if this is the wrong level, find the ramp/stairs rather than re-quoting a z.`
  );
}

/**
 * The `target_off_mesh` reading that fits a transport platform: the point is
 * where a car in view has been observed docking (`WB_TRANSPORT_PROGRESS`
 * with `docked: true`, kept on `state.nearby.*.transport.docks`) and the car
 * is not there now — an empty rail bed is not walkable, so the generic "pick
 * a floor" advice would send the agent away from the one place boarding
 * works. Undefined when no known transport docks within 12y of the point,
 * in which case the generic hint stands.
 */
function transportDockHint(state: StateCache, point: MovePoint): string | undefined {
  for (const obj of state.nearby.values()) {
    const t = obj.transport?.value;
    if (!t || obj.objectType?.value !== "gameObject") continue;
    if (!t.docks.some((k) => distance2d(k, point) <= 12)) continue;
    const name = obj.name?.value ?? `transport ${obj.entry?.value ?? "?"}`;
    const at = obj.position?.value;
    const where =
      at === undefined
        ? "its position has not been reported yet"
        : t.docked === true
          ? `it is docked at the other end, (${fmtXY(at)})`
          : `it is moving, now at (${fmtXY(at)})`;
    const clock =
      t.periodMs !== undefined
        ? ` ${Math.round(t.progressMs / 1000)}s into its ${Math.round(t.periodMs / 1000)}s cycle`
        : "";
    return (
      `(${fmtXY(point)}) is where ${name} (guid ${obj.guid}) docks, and the car is not there now: ${where}${clock}. ` +
      `The empty rail bed is not walkable, so this is not a z problem. Wait until the car's row in ` +
      `state.units({ type: "gameObject" }) reads docked: true near this point (or watch WB_TRANSPORT_PROGRESS), ` +
      `then moveTo the car's guid or this point again; once aboard, state.self.position follows the ride.`
    );
  }
  return undefined;
}

function fmtXY(p: { x: number; y: number }): string {
  return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;
}

export interface WaitForTransferOptions {
  /** How long to wait for `SMSG_NEW_WORLD`. Default 15000: a far teleport is a few server ticks. */
  timeout?: number;
  /** When given, arriving on any other map is reported as `wrong_map` rather than success. */
  expectMap?: number;
  /**
   * Only consider transfer packets with `seq > sinceSeq`. Default: the
   * stream position when the call is made, so a transfer that already
   * completed earlier cannot be mistaken for this one. `moveTo` passes the
   * position from before its move, because `SMSG_NEW_WORLD` can land before
   * the `WB_MOVE_RESULT` that says `transferred`.
   */
  sinceSeq?: number;
}

/**
 * The outcome of waiting for a map transfer — returned, never thrown, for the
 * same reason as `MoveResult` (ADR-0011): every arm is the game answering, and
 * the bounded-wait statuses FOLLOW-UPS 38 N1 asks for (`waiting`, `wrong_map`)
 * are answers too, not absences.
 */
export type TransferResult =
  | {
      readonly ok: true;
      readonly status: "transferred";
      /** Server-announced arrival map and point (`SMSG_NEW_WORLD`), now on `state.self.position`. */
      readonly to: WorldPosition;
      readonly seq: number;
      readonly ts: number;
    }
  | {
      readonly ok: false;
      readonly status: "aborted";
      readonly toMap: number;
      /** `TransferAbortReason` as the server sent it (`SMSG_TRANSFER_ABORTED.reason`). */
      readonly reason: number;
      readonly seq: number;
      readonly ts: number;
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "waiting";
      /** The destination `SMSG_TRANSFER_PENDING` announced before the deadline ran out. */
      readonly toMap: number;
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "no_transfer";
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "wrong_map";
      readonly expected: number;
      readonly actual: number;
      readonly to: WorldPosition;
      readonly seq: number;
      readonly ts: number;
      readonly hint: string;
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
  /** The target's guid, in the same opaque decimal-string form state uses. */
  readonly guid: string;
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
/**
 * Straight-line yards to an object in view, rounded to 2dp — `undefined` when
 * either side's position is unobserved. The one distance every questgiver
 * failure message quotes. Module-level, not a method: it is an explanation
 * detail, not new public surface (ADR-0015).
 */
function distanceToUnit(state: StateCache, guid: GuidArg): number | undefined {
  const obj = state.nearby.get(guidKey(guid));
  const pos = obj && pointOf(obj)?.value;
  const self = state.self.position?.value;
  if (!pos || !self) return undefined;
  return Math.round(Math.hypot(pos.x - self.x, pos.y - self.y, pos.z - self.z) * 100) / 100;
}

/** What the core treats as interaction range for a questgiver/trainer, in yards. */
const INTERACT_RANGE = 5;
/** `UNIT_NPC_FLAG_QUESTGIVER`. */
const NPC_FLAG_QUESTGIVER = 0x2;
/** `GAMEOBJECT_TYPE_QUESTGIVER`. */
const GO_TYPE_QUESTGIVER = 2;
/** How long the client-parity queries wait to coalesce one burst of events. */
const STATUS_QUERY_DEBOUNCE_MS = 150;

/**
 * The silence-explaining tail of a questgiver timeout, built from the distance
 * the SDK already knows.
 *
 * The core's questgiver handlers return without sending anything when the NPC
 * is out of range, is not the right NPC, or has nothing for this character —
 * one silence, three causes, and the old message listed all three with equal
 * weight. Range is the only one of the three the client can rule out locally,
 * and in every case observed in the 2026-08-22 roster it was *not* the cause:
 * laguna sat 0.1y from the giver of a quest McBride ends and spent 135 turns
 * there. So when the distance says range is fine, the message says so and
 * names what is left.
 */
function questgiverSilence(
  distance: number | undefined,
  otherCauses: string,
  nextStep: string,
  marker?: QuestGiverMarker,
): string {
  const status = marker === undefined ? "" : `${questgiverMarkerClause(marker)} `;
  if (distance === undefined) {
    return (
      `the server stays silent when the NPC is out of interact range (~${INTERACT_RANGE}y), ${otherCauses}. ` +
      `This SDK has no observed position for that guid, so it cannot tell you which — check state.units() ` +
      `for the NPC and its distance. ${status}${nextStep}`
    );
  }
  if (distance <= INTERACT_RANGE) {
    return (
      `distance: ${distance}y, inside interact range (~${INTERACT_RANGE}y) — so range is NOT the cause here. ` +
      `What is left: the NPC ${otherCauses}. ${status}${nextStep}`
    );
  }
  return (
    `distance: ${distance}y, and interact range is ~${INTERACT_RANGE}y — move to the NPC first ` +
    `(sdk.moveTo). If a closer attempt is also silent, the NPC ${otherCauses}. ${status}${nextStep}`
  );
}

/**
 * What the questgiver marker on an NPC says about a silent call. The marker
 * is the server's own answer to "what does this NPC have for me", received
 * before the call was made, so it names the cause the distance cannot.
 */
interface QuestGiverMarker {
  readonly name: ReturnType<typeof questGiverStatusName>;
  /** What the call needed the marker to be. */
  readonly wanted: "reward" | "available";
  readonly questId?: number;
}

function questgiverMarkerClause(m: QuestGiverMarker): string {
  const q = m.questId === undefined ? "" : ` quest ${m.questId}`;
  if (m.wanted === "reward") {
    const isReward = m.name === "reward" || m.name === "reward2" || m.name === "reward_rep";
    if (isReward) return `Its questgiver status is \`${m.name}\`, so it does end a quest that is complete — if the turn-in of${q} stays silent, the quest it ends is a different one.`;
    if (m.name === "incomplete") return `Its questgiver status is \`incomplete\`, not \`reward\` — it ends a quest in your log whose objectives are not done yet; check state.quest(id).objectives.`;
    return `Its questgiver status is \`${m.name}\`, not \`reward\` — it is not${q}'s ender (or the quest is not complete).`;
  }
  const offers = m.name === "available" || m.name === "available_rep" || m.name === "low_level_available" || m.name === "low_level_available_rep";
  if (offers) return `Its questgiver status is \`${m.name}\`, so it is offering something — the silence is not "nothing to give".`;
  if (m.name === "none") return `Its questgiver status is \`none\` — the server says it has no quest for you right now.`;
  return `Its questgiver status is \`${m.name}\`, not \`available\` — it has nothing on offer for you right now.`;
}

/** The observed questgiver marker of a unit, named, or undefined when none was observed. */
function questgiverMarkerOf(state: StateCache, guid: GuidArg, wanted: "reward" | "available", questId?: number): QuestGiverMarker | undefined {
  const raw = state.nearby.get(guidKey(guid))?.questGiver?.value;
  if (raw === undefined) return undefined;
  return { name: questGiverStatusName(raw), wanted, questId };
}

/**
 * Record the measured distance on a timeout so a caller can branch on it
 * without parsing the message. Any other error passes through untouched.
 */
function withDistance<E>(error: E, distance: number | undefined): E {
  if (error instanceof EventTimeoutError && distance !== undefined) {
    (error as EventTimeoutError & { distance?: number }).distance = distance;
  }
  return error;
}

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

/** How long after the loot release a straggling `SMSG_ITEM_PUSH_RESULT` is still waited for. */
const LOOT_PUSH_GRACE_MS = 1500;

export interface LootOptions {
  /** How long to wait for the loot window / release. Default 10000. */
  timeout?: number;
}

/** One item confirmed *stored* by `SMSG_ITEM_PUSH_RESULT` — in the bag, not merely seen. */
export interface StoredLootItem {
  readonly itemId: number;
  readonly count: number;
}

/**
 * What a corpse actually gave up. `items` are the pushes the server confirmed
 * with `SMSG_ITEM_PUSH_RESULT` — reporting the loot *window* contents as a
 * success would call a possible no-op "looted", which is exactly the silent
 * wrong behavior ADR-0016 forbids (and exactly what happened while the module's
 * auto-loot replay was broken: window shown, nothing stored, `ok: true`).
 *
 * - `looted`: at least one item was stored, or the window held only gold.
 * - `empty`: the server closed the window at once — nothing was on the corpse.
 * - `none_stored`: the window showed items but not one entered the bag
 *   (bags full, or the items were not ours to take); `window` says what was
 *   shown.
 */
export type LootResult =
  | {
      readonly ok: true;
      readonly status: "looted";
      readonly gold: number;
      readonly items: readonly StoredLootItem[];
      /** What the window showed, including anything that was not stored. */
      readonly window: readonly LootItemData[];
    }
  | { readonly ok: false; readonly status: "empty"; readonly gold: 0; readonly items: readonly [] }
  | {
      readonly ok: false;
      readonly status: "none_stored";
      readonly gold: number;
      readonly items: readonly [];
      readonly window: readonly LootItemData[];
    };

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

/**
 * The outcome of a turn-in. `not_complete` is the questgiver refusing while
 * the quest log agrees the objectives are unfinished; `wrong_questgiver` is
 * the refusal when the log says complete — another NPC ends this quest;
 * `too_far` is a local pre-check, nothing was sent; `inventory_full` is the
 * server refusing to hand over the reward — the quest is still in the log and
 * can be turned in again once a bag slot is free.
 */
export type QuestTurnInResult =
  | {
      readonly ok: true;
      readonly status: "complete";
      readonly questId: number;
      readonly xp: number;
      readonly money: number;
    }
  | {
      readonly ok: false;
      readonly status: "not_complete";
      readonly questId: number;
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "wrong_questgiver";
      readonly questId: number;
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "too_far";
      readonly questId: number;
      readonly distance: number;
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "inventory_full";
      readonly questId: number;
      /** Raw `InventoryResult` code from `SMSG_INVENTORY_CHANGE_FAILURE`. */
      readonly result: number;
      readonly hint: string;
    };

// ------------------------------------------------------------------ trainers

/**
 * `SMSG_TRAINER_LIST.state`, as `Trainer::SpellState` in the pinned core.
 *
 * The single place the numbers are interpreted, deliberately: the module
 * serves the server's byte verbatim, so if that enum is ever read differently
 * a correction is this one object.
 */
export const TRAINER_SPELL_STATE = {
  /** Green in a client's trainer window: the server will teach it now. */
  learnable: 0,
  /** Red: level, skill, prerequisite or class blocks it. */
  unavailable: 1,
  /** Gray: already known. */
  known: 2,
} as const;

/**
 * `SMSG_TRAINER_BUY_FAILED.reason`, as `Trainer::FailReason` in the pinned
 * core, rendered the way `CHAR_RESPONSE_HINTS` renders char-create codes: the
 * numeric reason is the server's word and always reported; this is the
 * client-visible sentence for it. An unknown reason renders without one.
 */
const TRAINER_BUY_FAIL_HINTS: Record<number, string> = {
  0: "the trainer will not teach it — wrong class or trainer, or a prerequisite is missing",
  1: "not enough money",
  2: "not enough skill (or level, or a missing prerequisite)",
};

/**
 * `SMSG_INVENTORY_CHANGE_FAILURE.result` — `InventoryResult` in the pinned
 * core — for the codes an equip refusal actually produces, rendered the way
 * `TRAINER_BUY_FAIL_HINTS` renders trainer refusals: the number is the
 * server's word and is always reported; this is the client-visible sentence
 * for it. An unknown code renders without one.
 */
const EQUIP_FAIL_HINTS: Record<number, string> = {
  1: "your level is too low for that item",
  2: "you do not have the skill it requires",
  3: "that item does not go in that slot",
  8: "your class has no proficiency for that weapon or armour type — a weapon master can teach some of them",
  9: "no equipment slot is free for it",
  10: "this character can never use that item",
  11: "this character can never use that item",
  13: "a two-handed weapon is equipped — that blocks an off-hand or shield until you equip a one-hander instead",
  14: "you cannot dual wield",
  20: "that item cannot be equipped",
  22: "that inventory slot is empty",
  23: "no item was found at that address",
  36: "the item is locked",
  37: "you are stunned",
  38: "you are dead",
  39: "you cannot do that right now",
  50: "your bags are full",
  60: "not while in combat",
  61: "not while disarmed",
  63: "your rank is too low",
  64: "your reputation is too low",
  88: "it needs a talent you have not taken",
};

/** Inventory slots below this are equipment and bag slots; 23-38 are backpack. */
const BACKPACK_FIRST_SLOT = 23;

/** One row of a trainer's list, plus what the SDK could derive about it. */
export interface TrainerSpell extends TrainerSpellData {
  /** True when `state` is green: the server will teach this right now. */
  readonly learnable: boolean;
  /**
   * Whether the observed money covers `cost`. `undefined` while money is
   * unobserved (it is a self-only PRIVATE update field, so it is absent until
   * an update block has carried it) — never guessed.
   */
  readonly affordable: boolean | undefined;
}

/** What a trainer teaches. An empty `spells` is an answer, not a failure. */
export interface TrainerListResult {
  readonly ok: true;
  /** 0 class, 1 mount, 2 tradeskill, 3 pet — the server's own classification. */
  readonly trainerType: number;
  readonly spells: readonly TrainerSpell[];
}

/**
 * The outcome of buying one spell, as a value (ADR-0011): `buy_failed` is the
 * server answering the question that was asked, not the call being wrong.
 * `reason` is the raw `SMSG_TRAINER_BUY_FAILED` code.
 */
export type BuySpellResult =
  | { readonly ok: true; readonly status: "learned"; readonly spellId: number }
  | {
      readonly ok: false;
      readonly status: "buy_failed";
      readonly spellId: number;
      readonly reason: number;
      readonly hint: string;
    };

export interface TrainerOptions {
  timeout?: number;
}

export interface EquipOptions {
  /**
   * How long to wait for the server's verdict before answering
   * `unconfirmed`. Default 3000 — the server answers `CMSG_AUTOEQUIP_ITEM`
   * within a round trip, and a loop over several items should not be able to
   * eat a snippet's whole budget.
   */
  timeout?: number;
}

/**
 * The outcome of one equip, as a value (ADR-0011). The server answers
 * `CMSG_AUTOEQUIP_ITEM` either by moving the item into an equipment slot —
 * visible as the character's own `invSlot` update fields — or with
 * `SMSG_INVENTORY_CHANGE_FAILURE` carrying an `InventoryResult` code, and
 * `equipItem` reports which of those happened rather than that the packet was
 * sent (fleet-nav-probe-sonnet-20260822-c3: a level-5 paladin got `ok: true`
 * six times for an axe and a shield that never left the bag).
 *
 * `unconfirmed` is the honest third answer: neither signal arrived in time, so
 * nothing was observed — re-read `state.bag()` rather than assume either way.
 */
export type EquipItemResult =
  | {
      readonly ok: true;
      readonly status: "equipped";
      readonly bag: number;
      readonly slot: number;
      readonly itemId: number | undefined;
      readonly name: string | undefined;
      /** The equipment slot it landed in, when the cache saw it arrive. */
      readonly equippedSlot: number | undefined;
    }
  | {
      readonly ok: false;
      readonly status: "not_equipped";
      readonly bag: number;
      readonly slot: number;
      readonly itemId: number | undefined;
      readonly name: string | undefined;
      /** Raw `InventoryResult` code from `SMSG_INVENTORY_CHANGE_FAILURE`. */
      readonly reason: number;
      /** The level the item needs, when the refusal named one. */
      readonly requiredLevel: number | undefined;
      readonly hint: string;
    }
  | {
      readonly ok: false;
      readonly status: "unconfirmed";
      readonly bag: number;
      readonly slot: number;
      readonly itemId: number | undefined;
      readonly name: string | undefined;
      readonly hint: string;
    };

/**
 * The outcome of `learnTalent`, as a value (ADR-0011). The server always
 * answers `CMSG_LEARN_TALENT` with a fresh `SMSG_TALENTS_INFO`, whether or
 * not it learned anything; `learned` is read off that answer.
 */
export type LearnTalentResult =
  | { readonly ok: true; readonly status: "learned"; readonly talentId: number; readonly rank: number; readonly talents: TalentState }
  | {
      readonly ok: false;
      readonly status: "not_learned";
      readonly talentId: number;
      readonly rank: number;
      readonly talents: TalentState;
      readonly hint: string;
    };

export interface ReclaimCorpseOptions {
  /**
   * The whole budget for the call: waiting out the reclaim delay, dispatching,
   * and confirming. Default 25000 — the same shape as `killTarget`'s, and for
   * the same reason: it fits under the runner's 30s snippet cap so an
   * in-snippet call returns a verdict instead of being abandoned mid-wait. A
   * death whose full 30s delay has not started burning down needs either a
   * larger `timeout` from a background routine, or a second call.
   */
  timeout?: number;
  /** How long each dispatch is given to be confirmed before it is re-sent. Default 2500. */
  attemptTimeout?: number;
}

/**
 * The outcome of one corpse reclaim, as a value (ADR-0011).
 *
 * The core's handler (`WorldSession::HandleReclaimCorpseOpcode`) returns
 * *silently* for every refusal — alive, spirit not released, no corpse, the
 * reclaim delay not elapsed, further than `CORPSE_RECLAIM_RADIUS` (~39y) — so
 * there is no refusal packet to read and the verdict has to come from the
 * observable outcome instead.
 *
 * What is observed: `SMSG_DEATH_RELEASE_LOC` with `map: -1`, which is the
 * first thing `Player::ResurrectPlayer` sends (it clears the client's spirit-
 * healer marker), corroborated by the character's own health leaving the
 * ghost's body value of 1 (`BuildPlayerRepop` sets health to 1; a reclaim
 * restores 50%). `waitedMs` is the whole time the call spent, delay included.
 *
 * `unconfirmed` is the honest third answer: the dispatch went out and neither
 * signal was observed — re-read `state.self.health` rather than assume.
 */
export type ReclaimCorpseResult =
  | {
      readonly ok: true;
      readonly status: "reclaimed";
      /** Total ms this call spent, including waiting out the delay. */
      readonly waitedMs: number;
      /** The delay the server last announced (`SMSG_CORPSE_RECLAIM_DELAY`), when one was seen. */
      readonly delayMs: number | undefined;
      /** How many `CMSG_RECLAIM_CORPSE` this call sent. */
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly status: "not_reclaimed" | "unconfirmed";
      readonly waitedMs: number;
      readonly delayMs: number | undefined;
      readonly attempts: number;
      /**
       * Exactly one cause, the most specific the observations support:
       * `not_dead`, `not_released` (pre-flight); `too_far` (with `distance`
       * and `radius`), `delay_not_elapsed` (with `secondsLeft`), `wrong_map`,
       * `no_corpse` (the server said there is none), else `still_ghost`; and
       * `no_observation` for `unconfirmed`.
       */
      readonly reason: ReclaimCorpseReason;
      /** Straight-line yards from the ghost to the corpse, for `too_far`. */
      readonly distance?: number;
      /** The reclaim radius the core enforces (`CORPSE_RECLAIM_RADIUS`), for `too_far`. */
      readonly radius?: number;
      /** Whole seconds of the reclaim delay still to run, for `delay_not_elapsed`. */
      readonly secondsLeft?: number;
      /** Where the corpse is, when known (`state.self.corpse`). */
      readonly corpse?: CorpseLocation;
      readonly hint: string;
    };

export type ReclaimCorpseReason =
  | "not_dead"
  | "not_released"
  | "too_far"
  | "delay_not_elapsed"
  | "wrong_map"
  | "no_corpse"
  | "still_ghost"
  | "no_observation";

/** `CORPSE_RECLAIM_RADIUS` in the core: a reclaim further than this is dropped silently. */
export const CORPSE_RECLAIM_RADIUS = 39;

/**
 * The Spirit Healer's price, as a rule rather than a table: every equipped
 * item loses 25% durability, and from level 11 the character gets resurrection
 * sickness — one minute per level above 10, capped at ten minutes from level
 * 20 (a level-10-or-lower character gets none). Paraphrased game rule; no
 * client text.
 */
export function spiritHealerCost(level: number | undefined): string {
  const sickness =
    level === undefined
      ? "resurrection sickness from level 11 (1 min per level above 10, 10 min from level 20)"
      : level <= 10
        ? "no resurrection sickness at your level"
        : `${Math.min(10, level - 10)} min of resurrection sickness`;
  return `25% durability off every equipped item and ${sickness}`;
}

export interface RawActionResponse extends ActionResponse {
  /** The opcode name as sent. */
  readonly opcode: string;
  /** The body bytes as sent, hex. */
  readonly payload: string;
}

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

  /** The operator-bound game account (ADR-0016). Authoritative when set; see ConnectOptions.account. */
  private readonly boundAccount: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly defaultSignal: (() => AbortSignal | undefined) | undefined;
  private readonly deadlineAt: (() => number | undefined) | undefined;

  constructor(options: ConnectOptions) {
    this.token = options.token;
    this.boundAccount = options.account;
    const sig = options.signal;
    this.defaultSignal = sig === undefined ? undefined : typeof sig === "function" ? sig : () => sig;
    const dl = options.deadline;
    this.deadlineAt = dl === undefined ? undefined : typeof dl === "function" ? dl : () => dl;
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
    this.events.onAny((event: StreamEvent) => this.clientParityQueries(event));
  }

  // ------------------------------------------------ client-parity queries
  //
  // Queries a real 3.3.5a client fires on its own, without the player doing
  // anything, so that the state cache sees what the client's screen shows.
  // They are issued from the event fold, bounded the way the client bounds
  // them, and their failures are dropped: none of them is an action the model
  // asked for, and a session that is not in world simply has nothing to ask.
  //
  //  - `questgiver_status_query` once per questgiver-flagged unit/gameobject
  //    that comes into view (the client does this to draw the !/? marker),
  //    skipped when a status for that guid already arrived in the same burst.
  //    The core's unprompted login-time `SMSG_QUESTGIVER_STATUS_MULTIPLE` is
  //    empty (sent before visibility is populated; verified live 2026-08-22),
  //    so these per-guid queries are what populate the initial view.
  //  - `questgiver_status_multiple_query` when the quest log's membership or
  //    a quest's complete bit changes (the client re-requests every marker on
  //    a quest-log update; counters alone do not move a marker, so they do
  //    not trigger it).
  //  - `quest_query` once per quest id that appears in the log (the client's
  //    template fetch); re-issued if the quest leaves the log and returns.

  private readonly statusKnown = new Set<string>();
  private readonly statusPending = new Set<string>();
  private statusFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private multipleTimer: ReturnType<typeof setTimeout> | undefined;
  private questLogKey: string | undefined;
  private readonly questQueried = new Set<number>();

  private clientParityQueries(event: StreamEvent): void {
    if (isDecodeError(event.data) || ("schemaError" in event && event.schemaError !== undefined)) return;
    switch (event.opcode) {
      case "SMSG_UPDATE_OBJECT": {
        const d = event.data as { objects: readonly Record<string, unknown>[] };
        for (const block of d.objects) {
          if (block["update"] === "create" && block["self"] !== true) {
            const guid = block["guid"] as string;
            if (this.state.self.guid !== undefined && guid === this.state.self.guid) continue;
            const fields = (block["fields"] ?? {}) as Record<string, unknown>;
            const npcFlags = typeof fields["npcFlags"] === "number" ? fields["npcFlags"] : 0;
            const goType = typeof fields["goType"] === "number" ? fields["goType"] : -1;
            const isQuestGiver = (npcFlags & NPC_FLAG_QUESTGIVER) !== 0 || goType === GO_TYPE_QUESTGIVER;
            if (isQuestGiver && !this.statusKnown.has(guid)) this.statusPending.add(guid);
          } else if (block["update"] === "outOfRange") {
            for (const g of block["guids"] as string[]) this.forgetStatus(g);
          }
        }
        if (this.statusPending.size > 0 && this.statusFlushTimer === undefined) {
          this.statusFlushTimer = setTimeout(() => this.flushStatusQueries(), STATUS_QUERY_DEBOUNCE_MS);
        }
        break;
      }
      case "SMSG_DESTROY_OBJECT":
        this.forgetStatus((event.data as { guid: string }).guid);
        break;
      case "SMSG_QUESTGIVER_STATUS": {
        const d = event.data as QuestGiverStatusData;
        this.statusKnown.add(d.guid);
        this.statusPending.delete(d.guid);
        break;
      }
      case "SMSG_QUESTGIVER_STATUS_MULTIPLE": {
        const d = event.data as QuestGiverStatusMultipleData;
        for (const row of d.statuses) {
          this.statusKnown.add(row.guid);
          this.statusPending.delete(row.guid);
        }
        break;
      }
      default:
        break;
    }
    this.trackQuestLog();
  }

  private forgetStatus(guid: string): void {
    this.statusKnown.delete(guid);
    this.statusPending.delete(guid);
  }

  private flushStatusQueries(): void {
    this.statusFlushTimer = undefined;
    const guids = [...this.statusPending];
    this.statusPending.clear();
    for (const guid of guids) {
      if (this.statusKnown.has(guid)) continue;
      this.statusKnown.add(guid);
      this.fireAndForget({ action: "questgiver_status_query", guid });
    }
  }

  private trackQuestLog(): void {
    const log = this.state.questLog;
    const key = log.map((q) => `${q.questId}:${q.complete ? 1 : 0}`).join(",");
    if (key === this.questLogKey) return;
    const first = this.questLogKey === undefined;
    this.questLogKey = key;
    const inLog = new Set(log.map((q) => q.questId));
    for (const id of this.questQueried) if (!inLog.has(id)) this.questQueried.delete(id);
    for (const id of inLog) {
      if (this.questQueried.has(id)) continue;
      this.questQueried.add(id);
      if (!this.state.quests.has(id)) this.fireAndForget({ action: "quest_query", questId: id });
    }
    // The first fold of the log is our own create block at login; the markers
    // for the initial view come from the per-guid spawn queries above, so no
    // refresh is owed yet — only a later change to the log earns one.
    if (first || this.multipleTimer !== undefined) return;
    this.multipleTimer = setTimeout(() => {
      this.multipleTimer = undefined;
      this.fireAndForget({ action: "questgiver_status_multiple_query" });
    }, STATUS_QUERY_DEBOUNCE_MS);
  }

  private fireAndForget(body: ActionBody): void {
    this.action(body).catch(() => {
      /* a client-parity query has no caller to report to */
    });
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
    // A session boundary for the event stream: per-session ids (`moveId`,
    // `seq`) restart with the new module session, so correlations issued from
    // here on must never match buffered events of an earlier session. Advanced
    // before the POST so the login handshake events land in the new epoch.
    this.events.advanceEpoch();
    // Account is operator infra, bound like `token`: when the run bound one it
    // is authoritative and placed *after* the spread, so it fills an omitted
    // account and overrides one the model typed (which it should never supply —
    // it is not told the account). Unbound, the request's own account (else the
    // module default) stands, preserving standalone/MCP behavior. This is what
    // closes the RUNNER6→RUNNER cross-account eviction: an omitted-account
    // createSession can no longer default onto a shared account.
    const account = this.boundAccount ?? request.account;
    const body: CreateSessionRequest = { token: this.token, ...request, account };
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
   * outcome is a `WB_MOVE_RESULT` event. Prefer `moveTo`, which waits for it —
   * but this is the call for a walk longer than the caller's own time budget:
   * dispatch here, then watch `WB_MOVE_RESULT` (or `state.self.position`).
   *
   * Takes the same targets `moveTo` does: a point, a unit, or a guid. A target
   * that resolves to no position throws here rather than returning a verdict —
   * this is the raw tier, and there is no result object to put an answer in;
   * `moveTo` answers the same case with `status: "unknown_target"`.
   */
  moveToAsync(target: MoveTarget): Promise<MoveToResponse> {
    const resolved = resolveMoveTarget(target, this.state, "moveTo");
    if ("unknown" in resolved) {
      throw new TypeError(
        `${resolved.unknown} (moveTo(target) answers this case with { ok: false, status: "unknown_target" } ` +
          `instead of throwing.)`,
      );
    }
    return this.postMoveTo(resolved.point, resolved.guid);
  }

  /** The `move_to` POST itself; `guid` is the planning hint `resolveMoveTarget` attaches to unit targets. */
  private postMoveTo(point: MovePoint, guid?: string): Promise<MoveToResponse> {
    return this.request(
      "POST",
      "/action",
      {
        token: this.token,
        action: "move_to",
        x: point.x,
        y: point.y,
        z: point.z,
        ...(guid !== undefined ? { guid } : {}),
      },
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
    return this.action({ action: "set_target", guid: guidArg(guid, "setTarget(guid)") });
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
    return this.action({ action: "attack_start", guid: guidArg(guid, "attackStart(guid)") });
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
        : { action: "cast_spell", spellId, targetGuid: guidArg(targetGuid, "castSpell(spellId, targetGuid)") },
    );
  }

  /** `CMSG_CANCEL_CAST`. */
  cancelCast(spellId: number): Promise<ActionResponse> {
    return this.action({ action: "cancel_cast", spellId });
  }

  /**
   * `CMSG_GAMEOBJ_USE` — chests, doors, quest objects. Takes the guid string or
   * a unit from `state.units(...)` / `state.closest(...)`.
   */
  interact(target: GuidOrUnit): Promise<ActionResponse> {
    return this.action({ action: "interact", guid: guidOf(target, "interact(guid)") });
  }

  /** `CMSG_GOSSIP_HELLO` — opens the NPC menu (`SMSG_GOSSIP_MESSAGE`). */
  gossipHello(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "gossip_hello", guid: guidArg(guid, "gossipHello(guid)") });
  }

  /**
   * `CMSG_GOSSIP_SELECT_OPTION`; ids come from `SMSG_GOSSIP_MESSAGE`.
   *
   * Two forms. The raw form takes the numeric `menuId` and `optionId` straight
   * off the packet. The convenience form takes just an `option` — an option's
   * visible `text` (case-insensitive exact, or a unique substring) or its
   * `optionId` — and resolves it against the menu last observed open for this
   * NPC (`state.lastGossip(guid)`), filling in the `menuId` from there. The
   * guid itself is always the raw string form: no name resolution on the
   * referent, only on the option within an already-open menu.
   *
   * The convenience form throws (nothing is dispatched) when no menu is open
   * for the guid, when the text matches no option or more than one, or when a
   * numeric option is not on the menu — every rejection lists the options so
   * the next call is obvious (ADR-0016). A menu is only ever read from the
   * `SMSG_GOSSIP_MESSAGE`/`SMSG_GOSSIP_COMPLETE` fold; the server is not
   * queried.
   */
  gossipSelect(guid: GuidArg, option: string | number): Promise<ActionResponse>;
  gossipSelect(guid: GuidArg, menuId: number, optionId: number): Promise<ActionResponse>;
  async gossipSelect(guid: GuidArg, a: string | number, b?: number): Promise<ActionResponse> {
    const id = guidArg(guid, "gossipSelect(guid, ...)");
    if (b !== undefined) {
      // Raw form: caller supplied both menuId and optionId.
      return this.action({ action: "gossip_select", guid: id, menuId: a as number, optionId: b });
    }
    // Convenience form: resolve against the last observed menu. `async`, so a
    // bad option is a rejected promise like every other helper, not a
    // synchronous throw.
    const { menuId, optionId } = this.resolveGossipOption(id, a);
    return this.action({ action: "gossip_select", guid: id, menuId, optionId });
  }

  /**
   * `CMSG_QUESTGIVER_HELLO`. The answer is `SMSG_QUESTGIVER_QUEST_LIST` — or,
   * on a gossip-flagged NPC, an `SMSG_GOSSIP_MESSAGE` with the quests embedded.
   * `acceptQuestFrom` handles both shapes.
   */
  questList(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "quest_list", guid: guidArg(guid, "questList(guid)") });
  }

  /** `CMSG_QUESTGIVER_QUERY_QUEST` — quest text via `..._QUEST_DETAILS`. */
  questDetails(guid: GuidArg, questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_details", guid: guidArg(guid, "questDetails(guid, questId)"), questId });
  }

  /** `CMSG_QUESTGIVER_ACCEPT_QUEST`. */
  questAccept(guid: GuidArg, questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_accept", guid: guidArg(guid, "questAccept(guid, questId)"), questId });
  }

  /** `CMSG_QUESTGIVER_COMPLETE_QUEST` — answered by REQUEST_ITEMS or OFFER_REWARD. */
  questComplete(guid: GuidArg, questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_complete", guid: guidArg(guid, "questComplete(guid, questId)"), questId });
  }

  /** `CMSG_QUESTGIVER_CHOOSE_REWARD`; index into `choiceRewards`, 0 when none. */
  questChooseReward(guid: GuidArg, questId: number, rewardIndex = 0): Promise<ActionResponse> {
    return this.action({ action: "quest_choose_reward", guid: guidArg(guid, "questChooseReward(guid, ...)"), questId, rewardIndex });
  }

  /**
   * `CMSG_QUEST_QUERY` — the quest template (title, objective text, required
   * entries and counts) via `SMSG_QUEST_QUERY_RESPONSE`, folded into
   * `state.quests` and onto `state.quest(id).objectives`. The SDK already
   * sends this for every quest that enters the log; call it only for a quest
   * you do not hold.
   */
  questQuery(questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_query", questId });
  }

  /**
   * `CMSG_QUESTGIVER_STATUS_QUERY` — the !/? marker for one questgiver, via
   * `SMSG_QUESTGIVER_STATUS`, folded onto `state.units()` as `questGiver`.
   * The SDK already sends this for every questgiver that comes into view and
   * refreshes all of them when the quest log changes; pass no guid to refresh
   * everything in view now (`CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY`).
   */
  questGiverStatusQuery(guid?: GuidArg): Promise<ActionResponse> {
    if (guid === undefined) return this.action({ action: "questgiver_status_multiple_query" });
    return this.action({ action: "questgiver_status_query", guid: guidArg(guid, "questGiverStatusQuery(guid?)") });
  }

  /** `CMSG_QUESTLOG_REMOVE_QUEST`; the module maps quest id to log slot. */
  questAbandon(questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_abandon", questId });
  }

  /** `CMSG_LOOT` — opens the loot window (`SMSG_LOOT_RESPONSE`). */
  loot(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "loot", guid: guidArg(guid, "loot(guid)") });
  }

  /**
   * `CMSG_LOOT` plus the auto-loot follow-ups the client sends once the window
   * arrives (ADR-0013). Fire-and-forget: prefer `lootCorpse`, which waits.
   */
  lootAll(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "loot_all", guid: guidArg(guid, "lootAll(guid)") });
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
    return this.action({ action: "loot_release", guid: guidArg(guid, "lootRelease(guid)") });
  }

  /** `CMSG_LIST_INVENTORY` — `SMSG_LIST_INVENTORY` follows. */
  vendorList(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "vendor_list", guid: guidArg(guid, "vendorList(guid)") });
  }

  /** `CMSG_BUY_ITEM`; `slot` is the 1-based vendor slot. */
  buyItem(guid: GuidArg, itemId: number, slot: number, count?: number): Promise<ActionResponse> {
    return this.action({ action: "buy_item", guid: guidArg(guid, "buyItem(guid, ...)"), itemId, slot, count });
  }

  /** `CMSG_SELL_ITEM`; omit `count` to sell the whole stack. */
  sellItem(guid: GuidArg, itemGuid: GuidArg, count?: number): Promise<ActionResponse> {
    return this.action({
      action: "sell_item",
      guid: guidArg(guid, "sellItem(guid, ...)"),
      itemGuid: guidArg(itemGuid, "sellItem(..., itemGuid)"),
      count,
    });
  }

  /** `CMSG_REPAIR_ITEM` with item guid 0 — repair everything. */
  repairAll(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "repair_all", guid: guidArg(guid, "repairAll(guid)") });
  }

  /**
   * `CMSG_AUTOEQUIP_ITEM` — equip what is at `bag`/`slot` (as `state.bag()`
   * lists it: bag 255 / slots 23-38 for the backpack, a worn bag's equip slot
   * 19-22 / slots 0..numSlots-1) and wait for the server's verdict.
   *
   * Races the item arriving in an equipment slot (the character's own
   * `invSlot0..22` update fields) against `SMSG_INVENTORY_CHANGE_FAILURE`, so
   * a refusal is returned as `status: "not_equipped"` with the server's
   * `InventoryResult` code and a hint, not as success. The refusal is a value,
   * not a throw: it is the game answering (ADR-0011).
   */
  async equipItem(bag: number, slot: number, options: EquipOptions = {}): Promise<EquipItemResult> {
    const before = this.state.bag().items.find((i) => i.bag === bag && i.slot === slot);
    const guid = before?.guid;
    const item = { bag, slot, itemId: before?.itemId, name: before?.name };
    const sinceSeq = this.events.recent(1)[0]?.seq;

    // Where the cache says our item is now: an equipment slot means the server
    // moved it. Without a guid (the slot was never observed) neither this nor
    // `leftSource` can speak, and the answer is `unconfirmed`.
    const equippedSlot = (): number | undefined => {
      if (guid === undefined) return undefined;
      const at = this.state.inventory.find((i) => i.guid === guid);
      return at !== undefined && at.slot < BACKPACK_FIRST_SLOT ? at.slot : undefined;
    };
    // Weaker but still the server's word: the item is no longer anywhere in
    // the carried inventory (backpack or worn bags). Only read when no
    // equipment slot claimed it, so a bag-to-bag shuffle cannot be mistaken
    // for an equip.
    const leftBackpack = (): boolean =>
      guid !== undefined && !this.state.bag().items.some((i) => i.guid === guid);

    await this.action({ action: "equip_item", bag, slot });

    let failure: InventoryChangeFailureData | undefined;
    const settled = (): boolean => equippedSlot() !== undefined || leftBackpack();
    if (!settled()) {
      try {
        await this.waitEvent(
          (e) => {
            if (
              isEvent(e, "SMSG_INVENTORY_CHANGE_FAILURE") &&
              !isDecodeError(e.data) &&
              (sinceSeq === undefined || e.seq > sinceSeq)
            ) {
              const d = e.data as InventoryChangeFailureData;
              // result 0 is EQUIP_ERR_OK, and a refusal that names a different
              // item (a background loot's bag-full) is not this equip's answer.
              const mine =
                d.itemGuid === undefined || guid === undefined || guidKey(d.itemGuid) === guid;
              if (d.result !== 0 && mine) {
                failure = d;
                return true;
              }
            }
            return settled();
          },
          {
            timeout: options.timeout ?? 3000,
            // Buffered events stay in scope on purpose: the verdict can land on
            // the stream while the POST is still in flight, which is what
            // `sinceSeq` fences (the same pattern as buySpell).
            description:
              `the verdict for equipping bag ${bag} slot ${slot} ` +
              `(the item in an equipment slot, or SMSG_INVENTORY_CHANGE_FAILURE)`,
          },
        );
      } catch (e) {
        // A timeout is the `unconfirmed` answer below; anything else (abort,
        // transport loss) is not this call's to swallow.
        if (!(e instanceof EventTimeoutError)) throw e;
      }
    }

    const landed = equippedSlot();
    if (landed !== undefined) return { ok: true, status: "equipped", ...item, equippedSlot: landed };
    if (failure !== undefined) {
      const named = EQUIP_FAIL_HINTS[failure.result];
      const level = failure.requiredLevel;
      return {
        ok: false,
        status: "not_equipped",
        ...item,
        reason: failure.result,
        requiredLevel: level,
        hint:
          `the server refused to equip ${item.name ?? `item ${item.itemId ?? "?"}`} ` +
          `(InventoryResult ${failure.result}${named ? `: ${named}` : ""}` +
          `${level === undefined ? "" : `, needs level ${level}`}) — the item is still at bag ${bag} slot ${slot}`,
      };
    }
    if (leftBackpack()) return { ok: true, status: "equipped", ...item, equippedSlot: undefined };
    return {
      ok: false,
      status: "unconfirmed",
      ...item,
      hint:
        guid === undefined
          ? `nothing was observed at bag ${bag} slot ${slot} before the equip, so neither outcome could be ` +
            `confirmed — re-read state.bag() and check whether the item moved`
          : `no equipment-slot update and no refusal arrived for bag ${bag} slot ${slot} — re-read ` +
            `state.bag() to see whether the item moved before trying again`,
    };
  }

  /** `CMSG_USE_ITEM`; the module fills the item guid and its on-use spell. */
  async useItem(bag: number, slot: number, targetGuid?: GuidArg): Promise<ActionResponse> {
    try {
      return await this.action({
        action: "use_item",
        bag,
        slot,
        targetGuid: targetGuid === undefined ? undefined : guidArg(targetGuid, "useItem(..., targetGuid)"),
      });
    } catch (err) {
      // A bare item_not_usable cannot be told apart from "the slot shifted
      // under me" (roster-sonnet-20260822); say what the local cache thinks is
      // at that address so the model does not have to guess.
      if (err instanceof WrathRequestError && err.code === "item_not_usable") {
        const item = this.state.bag().items.find((i) => i.bag === bag && i.slot === slot);
        err.message += item
          ? ` — local state sees ${item.name ?? `item ${item.itemId ?? "?"}`}${item.count !== undefined ? ` x${item.count}` : ""} at bag ${bag} slot ${slot}: that item has no on-use effect`
          : ` — local state sees nothing at bag ${bag} slot ${slot}; slots shift after looting/selling, re-read state.bag()`;
      }
      throw err;
    }
  }

  /**
   * `CMSG_TRAINER_LIST` — ask a trainer what it teaches (`SMSG_TRAINER_LIST`).
   * Prefer `trainerList`, which waits for the answer.
   */
  trainerListAsync(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "trainer_list", guid: guidArg(guid, "trainerList(npcGuid)") });
  }

  /**
   * `CMSG_TRAINER_BUY_SPELL` — learn one spell, paid for out of the
   * character's own money. Prefer `buySpell`, which waits for the verdict.
   */
  trainerBuySpellAsync(guid: GuidArg, spellId: number): Promise<ActionResponse> {
    return this.action({
      action: "trainer_buy_spell",
      guid: guidArg(guid, "buySpell(npcGuid, spellId)"),
      spellId,
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

  /**
   * `CMSG_RECLAIM_CORPSE` — dispatch only, no waiting and no verdict. Prefer
   * `reclaimCorpse`, which owns the reclaim delay and reports what happened.
   */
  reclaimCorpseAsync(guid?: GuidArg): Promise<ActionResponse> {
    return this.action({
      action: "reclaim_corpse",
      guid: guid === undefined ? undefined : guidArg(guid, "reclaimCorpse(guid)"),
    });
  }

  /**
   * Resurrect at your corpse: wait out the server's reclaim delay, send
   * `CMSG_RECLAIM_CORPSE`, and answer with what was observed.
   *
   * The delay is the server's own word, not a constant: `BuildPlayerRepop`
   * sends `SMSG_CORPSE_RECLAIM_DELAY { delayMs }` immediately before it resets
   * the corpse's ghost time, so the most recent one on the stream plus its
   * timestamp is when the reclaim becomes legal. When no such event is in the
   * retained buffer — none was owed (the core sends nothing when the delay has
   * already expired), or it aged out of the 500-event window — the call
   * dispatches *immediately* rather than inventing a 30s wait, and lets the
   * retry absorb a too-early refusal.
   *
   * Refusals are silent (see `ReclaimCorpseResult`), so the loop re-sends
   * every `attemptTimeout` until the budget runs out, and the verdict is read
   * off `SMSG_DEATH_RELEASE_LOC { map: -1 }` and the character's own health.
   * The ambient snippet signal aborts every wait here, as everywhere.
   *
   * Every game outcome is a value; the one throw is a refused request — a
   * `WrathRequestError` from the dispatch itself (`no_session`,
   * `not_in_world`) surfaces rather than being folded into `unconfirmed`, so a
   * dead session fails fast instead of retrying into nothing.
   */
  async reclaimCorpse(guid?: GuidArg, options: ReclaimCorpseOptions = {}): Promise<ReclaimCorpseResult> {
    const started = Date.now();
    const deadline = started + (options.timeout ?? 25_000);
    const attemptTimeout = Math.max(100, options.attemptTimeout ?? 2_500);
    const id = guid === undefined ? undefined : guidArg(guid, "reclaimCorpse(guid)");

    /** Own health as the cache last saw it: 0 = dead, 1 = a released ghost, >1 = alive. */
    const health = (): number | undefined => this.state.self.health?.value.current;
    const delayEvent = (): { delayMs: number; ts: number } | undefined => this.latestReclaimDelay();
    const announced = delayEvent();
    const delayMs = announced?.delayMs;

    // Pre-flight, so the two states that can never work are named rather than
    // burning the whole budget on a packet the core drops on sight.
    const before = health();
    const facts = (attempts: number): { waitedMs: number; delayMs: number | undefined; attempts: number } => ({
      waitedMs: Date.now() - started,
      delayMs,
      attempts,
    });
    if (before !== undefined && before === 0) {
      return {
        ok: false,
        status: "not_reclaimed",
        ...facts(0),
        reason: "not_released",
        hint:
          "your spirit has not been released, so there is no corpse to run back to — call sdk.repop() " +
          "first, then moveTo(state.self.corpse.value) as a ghost and reclaim",
      };
    }
    if (before !== undefined && before > 1) {
      return {
        ok: false,
        status: "not_reclaimed",
        ...facts(0),
        reason: "not_dead",
        hint: `state.self.health is ${before}, so you are alive and there is nothing to reclaim`,
      };
    }

    // The resurrect is announced by SMSG_DEATH_RELEASE_LOC clearing the marker
    // (map -1). Latched from a subscription rather than a wait, so an answer
    // that lands while the POST is in flight is not missed.
    let released = false;
    const offRelease = this.events.on("SMSG_DEATH_RELEASE_LOC", (e) => {
      if (isDecodeError(e.data)) return;
      if ((e.data as DeathReleaseLocData).map < 0) released = true;
    });
    const alive = (): boolean => released || (health() ?? 0) > 1;

    let attempts = 0;
    try {
      for (;;) {
        this.throwIfAborted("the corpse reclaim delay");
        // Recomputed each pass: a second death mid-call moves the clock.
        const latest = delayEvent();
        const readyAt =
          latest === undefined ? Date.now() : Math.min(latest.ts + latest.delayMs, Date.now() + latest.delayMs);
        const wait = Math.min(Math.max(0, readyAt - Date.now()), Math.max(0, deadline - Date.now()));
        if (wait > 0) await this.sleepAborting(wait);
        if (Date.now() >= deadline) break;

        attempts++;
        await this.reclaimCorpseAsync(id);
        if (alive()) break;
        const window = Math.min(attemptTimeout, Math.max(0, deadline - Date.now()));
        if (window > 0) {
          try {
            await this.waitEvent(() => alive(), {
              timeout: window,
              includeBuffered: false,
              description:
                "the resurrect after CMSG_RECLAIM_CORPSE (SMSG_DEATH_RELEASE_LOC clearing the marker, " +
                "or your health leaving the ghost's 1) — the core refuses silently",
            });
          } catch (e) {
            if (!(e instanceof EventTimeoutError)) throw e;
          }
        }
        if (alive()) break;
        if (Date.now() >= deadline) break;
      }
    } finally {
      offRelease();
    }

    if (alive()) return { ok: true, status: "reclaimed", ...facts(attempts) };
    const after = health();
    if (attempts > 0 && after === undefined) {
      return {
        ok: false,
        status: "unconfirmed",
        ...facts(attempts),
        reason: "no_observation",
        hint:
          `${attempts} reclaim${attempts === 1 ? "" : "s"} went out and nothing was observed either way — ` +
          "your own health has not been seen at all, so re-read state.self.health before trying again",
      };
    }
    return { ok: false, status: "not_reclaimed", ...facts(attempts), ...this.reclaimRefusal(attempts, options) };
  }

  /**
   * Why a reclaim was refused, as one reason. The core drops the packet
   * silently in every case, so the cause is read from what a client also has:
   * its own corpse query answer (`state.self.corpse`), the release loc, and
   * the announced reclaim delay. Checked most-specific first so the verdict
   * names the thing to fix rather than the number of packets sent.
   */
  private reclaimRefusal(
    attempts: number,
    options: ReclaimCorpseOptions,
  ): {
    reason: ReclaimCorpseReason;
    distance?: number;
    radius?: number;
    secondsLeft?: number;
    corpse?: CorpseLocation;
    hint: string;
  } {
    const corpse = this.state.self.corpse?.value;
    const pos = this.state.self.position?.value;
    const level = this.state.self.level?.value;
    const healerOption =
      "or spiritHealerActivate(guid) at the graveyard's Spirit Healer (state.units({ name: \"Spirit Healer\" }) once in view; " +
      `state.self.graveyard.value is where it stands), which costs ${spiritHealerCost(level)}`;

    // The server's own "no corpse": the most recent corpse query answered found: false.
    let queryAnsweredNone = false;
    const events = this.events.recent();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as StreamEvent;
      if (!isEvent(e, "MSG_CORPSE_QUERY") || isDecodeError(e.data)) continue;
      queryAnsweredNone = (e.data as CorpseQueryData).found === false;
      break;
    }
    if (corpse === undefined && queryAnsweredNone) {
      return {
        reason: "no_corpse",
        hint:
          "the server says you have no corpse to reclaim (it expired, or a Spirit Healer already took it) — " +
          "the only way back is spiritHealerActivate(guid) at the graveyard's Spirit Healer, which costs " +
          spiritHealerCost(level),
      };
    }
    if (corpse !== undefined && pos !== undefined && corpse.map !== pos.map) {
      return {
        reason: "wrong_map",
        corpse,
        hint:
          `your corpse is on map ${corpse.map} and you are on map ${pos.map}; a reclaim only works on the corpse's map — ` +
          `travel there (moveTo(state.self.corpse.value) once on that map) and reclaim, ${healerOption}`,
      };
    }
    if (corpse !== undefined && pos !== undefined) {
      const distance = Math.round(distance2d(pos, corpse));
      if (distance > CORPSE_RECLAIM_RADIUS) {
        return {
          reason: "too_far",
          distance,
          radius: CORPSE_RECLAIM_RADIUS,
          corpse,
          hint:
            `you are ${distance}y from your corpse at (${fmtXY(corpse)}) and a reclaim only works within ${CORPSE_RECLAIM_RADIUS}y — ` +
            `await sdk.moveTo(state.self.corpse.value) as a ghost, then reclaim again (no durability loss, no sickness), ${healerOption}`,
        };
      }
    }
    const latest = this.latestReclaimDelay();
    const left = latest === undefined ? 0 : Math.max(0, latest.ts + latest.delayMs - Date.now());
    if (left > 0) {
      const secondsLeft = Math.ceil(left / 1000);
      return {
        reason: "delay_not_elapsed",
        secondsLeft,
        corpse,
        hint:
          attempts === 0
            ? `the server's corpse reclaim delay outlasted this call's ${Math.round((options.timeout ?? 25_000) / 1000)}s budget ` +
              `(~${secondsLeft}s still to run) — nothing was sent; call it again, or pass a larger { timeout } from a background routine`
            : `the reclaim delay has ~${secondsLeft}s still to run, so the core dropped the reclaim — call it again after that`,
      };
    }
    return {
      reason: "still_ghost",
      corpse,
      hint:
        "you are still a ghost and nothing observed explains the refusal" +
        (corpse === undefined ? " (no corpse position has been observed yet — check state.self.corpse)" : "") +
        ` — the core drops a reclaim further than ${CORPSE_RECLAIM_RADIUS}y from the corpse, before the delay elapses, ` +
        `or on another map; stand on the corpse and call it again, ${healerOption}`,
    };
  }

  /** The most recent `SMSG_CORPSE_RECLAIM_DELAY` in the buffer: the server's word on when a reclaim becomes legal. */
  private latestReclaimDelay(): { delayMs: number; ts: number } | undefined {
    const events = this.events.recent();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as StreamEvent;
      if (isEvent(e, "SMSG_CORPSE_RECLAIM_DELAY") && !isDecodeError(e.data)) {
        return { delayMs: (e.data as CorpseReclaimDelayData).delayMs, ts: e.ts };
      }
    }
    return undefined;
  }

  /** `sleep`, bounded by the ambient signal: rejects with `EventAbortedError` when the snippet is abandoned. */
  private sleepAborting(ms: number): Promise<void> {
    const signal = this.currentSignal();
    if (signal === undefined) return sleep(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new EventAbortedError(signal.reason, "a corpse reclaim delay"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        reject(new EventAbortedError(signal?.reason, "a corpse reclaim delay"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * `CMSG_SPIRIT_HEALER_ACTIVATE` — resurrect at the graveyard's spirit healer
   * when the corpse is unreachable. Costs durability and applies resurrection
   * sickness; the outcome arrives through ordinary events (health, auras).
   */
  spiritHealerActivate(guid: GuidArg): Promise<ActionResponse> {
    return this.action({ action: "spirit_healer_activate", guid: guidArg(guid, "spiritHealerActivate(guid)") });
  }

  /**
   * `CMSG_LEARN_TALENT` — spend one talent point. `rank` is 0-based as on the
   * wire (0 = the first point in that talent). Prefer `learnTalent`, which
   * waits for the `SMSG_TALENTS_INFO` answer.
   */
  learnTalentAsync(talentId: number, rank: number): Promise<ActionResponse> {
    return this.action({ action: "learn_talent", talentId, rank });
  }

  /**
   * The raw-action escape hatch (ADR-0025, ADR-0015). Sends one client opcode
   * from the module's allowlist (module/PROTOCOL.md, "raw") with a body you
   * build: a hex string, bytes, or a field list the SDK packs little-endian —
   * `[{ u32: 5 }, { guid: unit.guid }, { cstring: "text" }]`. The ack means
   * "queued into the stock handler"; whatever the server answers arrives on
   * the event stream only if its opcode is whitelisted there, so an
   * unanswered raw action is the signal to ask for a surface, not a failure.
   *
   * Opcodes that already have a method (`castSpell`, `say`, `lootAll`, …) are
   * not on the allowlist: one audited path per opcode.
   */
  raw(opcode: string, payload: RawPayload = ""): Promise<RawActionResponse> {
    const op = rawOpcodeSchema.safeParse(opcode);
    if (!op.success) {
      throw new TypeError(
        `raw(opcode, payload): opcode must be a CMSG_* name (got ${JSON.stringify(opcode)}) — ` +
          `see module/PROTOCOL.md "raw" for the allowlist`,
      );
    }
    const body = rawPayloadSchema.safeParse(payload);
    if (!body.success) {
      throw new TypeError(
        `raw(${opcode}, payload): payload must be a hex string, a Uint8Array, or a list of ` +
          `{ u8 | u16 | u32 | i32 | f32 | u64 | guid | packedGuid | cstring | bytes } fields — ` +
          body.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; "),
      );
    }
    const hexPayload = encodeRawPayload(body.data);
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "raw", opcode: op.data, payload: hexPayload },
      actionResponseSchema,
    ).then((ack) => ({ ...ack, opcode: op.data, payload: hexPayload }));
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
   * aborted request. `account_in_use` is the same not-yet-released transient
   * seen from the other side (the parked session finds the account still
   * held), so all three are retried. Anything else the module says
   * (`character_not_found`, a `char_delete_failed_code_<N>`) is a real answer
   * and is thrown straight out.
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
            // Bound account wins here too (ADR-0016): a run must only ever
            // delete on its assigned account. Deleting on the wrong (idle)
            // account is a cross-account hazard even though character-delete
            // refuses an account another live token holds. Unbound, the
            // caller's option (else the module default) stands.
            account: this.boundAccount ?? options.account,
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
    if (this.statusFlushTimer !== undefined) clearTimeout(this.statusFlushTimer);
    if (this.multipleTimer !== undefined) clearTimeout(this.multipleTimer);
    this.statusFlushTimer = undefined;
    this.multipleTimer = undefined;
    this.statusPending.clear();
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
    const event = await this.waitEvent(
      (e) => {
        if (!isEvent(e, "SMSG_MESSAGECHAT") || isDecodeError(e.data)) return false;
        return predicate(toChatEntry(e.seq, e.ts, e.data));
      },
      {
        description:
          typeof match === "string" ? `a chat line saying ${JSON.stringify(match)}` : "a matching chat line",
        ...options,
      },
    );
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
  async moveTo(target: MoveTarget, options: MoveToOptions = {}, ...rest: unknown[]): Promise<MoveResult> {
    // Repair moveTo(x, y, z) → moveTo({ x, y, z }) before anything else; a
    // legitimate two-arg call passes rest empty and is untouched.
    const repaired = repairThreeArgMove(target, options, rest);
    if (repaired !== null) {
      target = repaired.point;
      options = repaired.options;
    }
    const resolved = resolveMoveTarget(target, this.state, "moveTo");
    if ("unknown" in resolved) return { ok: false, status: "unknown_target", hint: resolved.unknown };
    const point = resolved.point;
    // Notes that belong on whatever verdict comes back: a stale-position
    // fallback, and the budget estimate below. They explain the call, so they
    // ride the `hint` rather than changing the module's status (ADR-0027).
    const extras: string[] = [];
    if (resolved.note !== undefined) extras.push(resolved.note);
    const from = this.state.self.position?.value;
    const budgetMs = this.remainingBudgetMs();
    if (from !== undefined) {
      const yards = distance2d(from, point);
      const walkMs = (yards / RUN_SPEED_YPS) * 1000;
      if (budgetMs !== undefined && walkMs > budgetMs) {
        extras.push(
          `this move is ~${Math.round(yards)}y in a straight line — about ${Math.round(walkMs / 1000)}s at a ` +
            `base run speed of ${RUN_SPEED_YPS}yd/s, and the caller had ~${Math.round(budgetMs / 1000)}s of ` +
            `its budget left when it was issued. Awaiting a move this long does not fit one snippet: dispatch ` +
            `it with sdk.moveToAsync(target) or from a background routine, then poll state.self.position.`,
        );
      }
      // A caller-set timeout below the straight-line walk plus mesh slack will
      // expire on a move that is still going: the path the server walks is
      // typically 1.5–2× the straight line (fleet-nav-probe-freeplay-sonnet
      // -20260823-c4: 27/27 timeouts had their verdict arrive afterwards).
      if (options.timeout !== undefined && options.timeout < walkMs * 1.5) {
        extras.push(
          `this move was ~${Math.round(yards)}y in a straight line — about ${Math.round(walkMs / 1000)}s at ` +
            `${RUN_SPEED_YPS}yd/s — against the ${Math.round(options.timeout / 1000)}s timeout it was given, ` +
            `and mesh paths are typically 1.5–2× the straight line. A move this long often outlasts a timeout ` +
            `that short: use the default timeout, or sdk.moveToAsync(target) and poll state.self.position.`,
        );
      }
    }
    const withNotes = (hint?: string): string | undefined => {
      const all = hint === undefined ? extras : [hint, ...extras];
      return all.length === 0 ? undefined : all.join(" ");
    };
    const epoch = this.events.epoch;
    // Stream position before the move: a portal's SMSG_NEW_WORLD can land
    // before the WB_MOVE_RESULT that says `transferred`, so the transfer wait
    // has to admit packets from here on, not from the result on.
    const sinceSeq = this.state.lastSeq;
    const ack = await this.postMoveTo(point, resolved.guid);
    // The match is the moveId within the current session epoch, and the buffer
    // is searched: a result can land while the POST response is still in
    // flight (an immediate `target_off_mesh` does exactly that). No `sinceSeq` bound —
    // `seq` restarts when a token's session is recreated, so any seq-based
    // floor can outrun the very event it is meant to admit. `moveId` alone is
    // not enough either: the module's generator is per-session and restarts on
    // recreate, so after a relog the buffer can hold a byte-identical stale
    // result from the previous session (observed in night-opus-1: 8s-timeout
    // probes "resolving" in 59ms against pre-relog payloads). The epoch,
    // advanced on every session boundary, is what scopes the match to the
    // session that issued this ack — and the match is *exact*, not a floor:
    // a floor would still let a waiter left pending across a teardown/recreate
    // resolve against a LATER session's colliding moveId (the module's
    // generator restarts at 1 per session). A move whose session is gone has
    // no verdict; timing out is the honest outcome.
    let event: StreamEvent;
    try {
      event = await this.waitEvent(
        (e) =>
          isEvent(e, "WB_MOVE_RESULT") &&
          !isDecodeError(e.data) &&
          (e.data as MoveResultData).moveId === ack.moveId,
        {
          timeout: options.timeout ?? 90_000,
          epoch,
          description: `the WB_MOVE_RESULT for moveId ${ack.moveId} (move_to verdict)`,
        },
      );
    } catch (err) {
      // How far this walk got, shared by both branches below: an abort and a
      // timeout are both the absence of a verdict, and the caller needs the
      // same two facts either way.
      const at = this.state.self.position?.value;
      const covered = at !== undefined && from !== undefined ? distance2d(from, at) : undefined;
      const remaining = at !== undefined ? distance2d(at, point) : undefined;
      const progress =
        covered !== undefined && remaining !== undefined
          ? `~${Math.round(covered)}y covered, ~${Math.round(remaining)}y still to go to (${fmtXY(point)})`
          : `no position was observed for it (target (${fmtXY(point)}))`;
      if (err instanceof EventTimeoutError) {
        // The timeout is not "the move failed": the character is still walking
        // and the verdict is still coming. Saying so stops the model from
        // issuing a fresh moveTo that supersedes a move about to succeed.
        err.message =
          `${err.message} — ${progress}; the character is still walking and this move's verdict will arrive ` +
          `later. Mesh paths are typically 1.5–2× the straight line; use the default timeout, or ` +
          `sdk.moveToAsync(target) and poll state.self.position.`;
      }
      // An abort mid-walk (the runner abandoning the snippet that issued this
      // move) must not leave the character walking on its own: issue the
      // existing `stop` — no game semantics beyond "stop walking" — and let
      // the abort propagate. Its ack is not awaited: the signal holder has
      // already moved on, and a refusal (`no_session`, …) has nothing to add.
      if (err instanceof EventAbortedError) {
        void this.stop().catch(() => {});
        // The abandoning caller (the runner's snippet timeout) sees only the
        // error, so the error is where the two facts it needs go: how far this
        // walk got, and the call that would have survived (ADR-0016 rule 2).
        // `moveAbandon` carries the same sentence structurally, for the sandbox
        // to splice into its abandon notice.
        const note =
          `a moveTo was still walking when this was abandoned: ${progress}. A move that long does not fit one ` +
          `snippet — issue it with sdk.moveToAsync(target), or from a background routine, and poll ` +
          `state.self.position (or watch the WB_MOVE_RESULT event) instead of awaiting it inline.`;
        err.message = `${err.message} — ${note}`;
        (err as { moveAbandon?: string }).moveAbandon = note;
      }
      throw err;
    }
    const data = event.data as MoveResultData;
    const status: MoveStatus = data.status;
    const position: UnitPosition = {
      x: data.pos.x,
      y: data.pos.y,
      z: data.pos.z,
      o: data.pos.o,
    };
    const common = { moveId: data.moveId, position, seq: event.seq, ts: event.ts } as const;
    if (status === "arrived") {
      const aboard = data.onTransport !== undefined ? { onTransport: data.onTransport } : {};
      if (data.meshZ === undefined) {
        const hint = withNotes();
        return { ok: true, status: "arrived", ...common, ...aboard, ...(hint !== undefined ? { hint } : {}) };
      }
      return {
        ok: true,
        status: "arrived",
        ...common,
        ...aboard,
        meshZ: data.meshZ,
        hint: withNotes(meshZHint(point, data.meshZ)) as string,
      };
    }
    if (status === "transferred") {
      // Postcondition, not dispatch: resolve only once the server has named
      // the new map (FOLLOW-UPS 38 N1). A transfer that never completes is a
      // typed `ok: false` from waitForTransfer, surfaced with the move status
      // intact so the caller sees both facts.
      const transfer = await this.waitForTransfer({ timeout: options.timeout ?? 90_000, sinceSeq, epoch });
      if (transfer.ok) {
        return {
          ok: true,
          status: "transferred",
          ...common,
          to: transfer.to,
          hint: withNotes(
            `a portal took the character to map ${transfer.to.map} at (${fmtXY(transfer.to)}); ` +
              `state.self.position is on the new map now. Coordinates from the old map no longer apply.`,
          ) as string,
        };
      }
      return { ok: false, status: "transferred", ...common, hint: withNotes(transfer.hint) };
    }
    if (status === "teleported") {
      // A same-map port: no SMSG_NEW_WORLD is coming, so waiting for one
      // (what `transferred` does) would be a full-timeout hang ending in a
      // false "still pending" (FOLLOW-UPS 46). The arrival point is the
      // server's own MSG_MOVE_TELEPORT_ACK, sent before the result — so this
      // is a buffer lookup from before the move, and the short timeout only
      // covers a module that did not serve it.
      const landed = await this.waitOwnTeleportAck(sinceSeq, epoch, 5_000);
      if (landed !== undefined) {
        return {
          ok: true,
          status: "teleported",
          ...common,
          to: landed,
          hint: withNotes(
            `a same-map teleport took the character to (${fmtXY(landed)}); state.self.position already ` +
              `reflects it. The destination (${fmtXY(point)}) was not reached — decide again from here.`,
          ) as string,
        };
      }
      return {
        ok: false,
        status: "teleported",
        ...common,
        hint: withNotes(
          `a same-map teleport took the character mid-move, but no MSG_MOVE_TELEPORT_ACK with its arrival ` +
            `point was observed. state.self.position may be stale until the next move result; the ` +
            `destination (${fmtXY(point)}) was not reached.`,
        ),
      };
    }
    if (MOVE_LEAVES_NO_STOP.has(status)) {
      // Nothing moved — and that is exactly when the character can be left
      // *flagged* as moving. `DoMoveTo` finishes an in-flight move with
      // `superseded` without sending `MSG_MOVE_STOP`, and a request that fails
      // at planning time sends no packet at all, so the server's last movement
      // word stays `MSG_MOVE_HEARTBEAT | MOVEMENTFLAG_FORWARD`: `isMoving()`
      // remains true and every subsequent cast answers `SMSG_CAST_FAILED`
      // result 51 (SPELL_FAILED_MOVING), forever. Observed in
      // fleet-nav-probe-sonnet-20260822-c3: a walking move superseded by a
      // 200-point sweep that all failed `start_off_mesh`, then ~10 minutes of
      // Hearthstone `use_item` answering 51 while stationary, ended by one
      // `stop`. The repair is deterministic (ADR-0016 rule 1): after a move
      // that did not move, "stop walking" has exactly one reading, it is what a
      // client sends when its run ends, and it is a no-op if the character was
      // already still. `superseded` is deliberately not in the set — a newer
      // move is walking by then, and stopping it would change game semantics.
      // Awaited, not fired-and-forgotten: the ack means the module has queued
      // the packet, and per-session packets are processed in order, so awaiting
      // is what puts the stop ahead of the caller's next action. Never a sleep.
      // A refusal (`no_session`, `not_in_world`) has nothing to add to a move
      // verdict that already failed. If a *concurrent* moveTo started walking
      // while this probe was failing, this stop ends it and that caller reads
      // a typed `stopped` — visible, never a silent wrong value, and cheaper
      // than the ten dead minutes the leftover flag cost.
      await this.stop().catch(() => {});
    }
    const hint = withNotes(
      (status === "target_off_mesh" ? transportDockHint(this.state, point) : undefined) ??
        MOVE_HINTS[status]?.(point, data),
    );
    const reachedPos = data.reachedPos ? { x: data.reachedPos.x, y: data.reachedPos.y, z: data.reachedPos.z } : undefined;
    return {
      ok: false,
      status,
      ...common,
      ...(reachedPos !== undefined ? { reachedPos } : {}),
      ...(data.dz !== undefined ? { dz: data.dz } : {}),
      ...(hint !== undefined ? { hint } : {}),
    };
  }

  /**
   * The arrival point of a same-map teleport: the server's `MSG_MOVE_TELEPORT_ACK`
   * under our own guid after `sinceSeq`, or undefined when none shows within
   * `timeout`. The packet precedes the `teleported` move result, so this is
   * normally a buffer lookup.
   */
  private async waitOwnTeleportAck(sinceSeq: number, epoch: number, timeout: number): Promise<UnitPosition | undefined> {
    try {
      const event = await this.waitEvent(
        (e) =>
          e.seq > sinceSeq &&
          isEvent(e, "MSG_MOVE_TELEPORT_ACK") &&
          !isDecodeError(e.data) &&
          this.state.self.guid !== undefined &&
          (e.data as MoveUpdateData).guid === this.state.self.guid,
        { timeout, epoch, description: "MSG_MOVE_TELEPORT_ACK for self (same-map teleport arrival)" },
      );
      const d = event.data as MoveUpdateData;
      return { x: d.pos.x, y: d.pos.y, z: d.pos.z, o: d.pos.o };
    } catch (err) {
      if (err instanceof EventTimeoutError) return undefined;
      throw err;
    }
  }

  /**
   * Wait for a map transfer to complete, with a typed verdict.
   *
   * Resolves on `SMSG_NEW_WORLD` (the server's announcement of the new map
   * and arrival point, already folded into `state.self.position`), or on
   * `SMSG_TRANSFER_ABORTED`; a deadline with a transfer pending is `waiting`,
   * a deadline with no transfer announced at all is `no_transfer`, and an
   * arrival on a map other than `expectMap` is `wrong_map`. Never sleeps.
   *
   * Earned by the travel probe (`infra/smoke/travel.ts`, FOLLOW-UPS item 18):
   * every version of it before this helper creep-walked into the tram portal
   * and slept 1.5s per step to see whether a teleport had landed.
   */
  async waitForTransfer(options: WaitForTransferOptions & { epoch?: number } = {}): Promise<TransferResult> {
    const sinceSeq = options.sinceSeq ?? this.state.lastSeq;
    const epoch = options.epoch ?? this.events.epoch;
    const timeout = options.timeout ?? 15_000;
    const after = (e: StreamEvent) => e.seq > sinceSeq && !isDecodeError(e.data);
    let event: StreamEvent;
    try {
      event = await this.waitEvent(
        (e) => after(e) && (isEvent(e, "SMSG_NEW_WORLD") || isEvent(e, "SMSG_TRANSFER_ABORTED")),
        { timeout, epoch, description: "SMSG_NEW_WORLD or SMSG_TRANSFER_ABORTED (map transfer verdict)" },
      );
    } catch (err) {
      if (!(err instanceof EventTimeoutError)) throw err;
      const pending = this.state.self.transfer?.value;
      if (pending !== undefined) {
        return {
          ok: false,
          status: "waiting",
          toMap: pending.toMap,
          hint:
            `the server announced a transfer to map ${pending.toMap} but no SMSG_NEW_WORLD arrived within ` +
            `${timeout}ms. The teleport is still pending server-side; call waitForTransfer() again.`,
        };
      }
      return {
        ok: false,
        status: "no_transfer",
        hint:
          `no map transfer was announced within ${timeout}ms. The character did not enter a portal; ` +
          `check state.self.position and move onto the portal (an areatrigger fires on entry).`,
      };
    }
    if (isEvent(event, "SMSG_TRANSFER_ABORTED")) {
      const d = event.data as TransferAbortedData;
      return {
        ok: false,
        status: "aborted",
        toMap: d.map,
        reason: d.reason,
        seq: event.seq,
        ts: event.ts,
        hint: `the server refused the transfer to map ${d.map} (TransferAbortReason ${d.reason}); the character stays where it was.`,
      };
    }
    const d = event.data as NewWorldData;
    const to: WorldPosition = { map: d.map, x: d.x, y: d.y, z: d.z, o: d.o };
    if (options.expectMap !== undefined && d.map !== options.expectMap) {
      return {
        ok: false,
        status: "wrong_map",
        expected: options.expectMap,
        actual: d.map,
        to,
        seq: event.seq,
        ts: event.ts,
        hint: `the transfer landed on map ${d.map}, not the expected ${options.expectMap}; state.self.position reflects map ${d.map}.`,
      };
    }
    return { ok: true, status: "transferred", to, seq: event.seq, ts: event.ts };
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
    await this.waitEvent(
      () => {
        hit = scan();
        return hit !== undefined;
      },
      // The buffer is not re-scanned: those events are already folded into the
      // cache, and `scan()` above has just looked at the result.
      {
        timeout: options.timeout ?? 10_000,
        includeBuffered: false,
        description: "a nearby object matching the waitForNearby predicate",
      },
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
  async killTarget(target: GuidOrUnit, options: KillTargetOptions = {}): Promise<KillResult> {
    const raw = guidOf(target, "killTarget(guid)");
    // Canonicalised ("007" -> "7"), because it is used as the nearby-cache map
    // key and the cache's own keys are canonical (guidSchema round-trips every
    // wire guid). A raw string that does not parse names nothing and would
    // otherwise earn an instant, false "lost" — reject it before any opcode.
    let id: string;
    try {
      id = guidKey(raw);
    } catch {
      throw new TypeError(
        `killTarget(guid) got ${JSON.stringify(raw)}, which is not a decimal guid string — ` +
          `pass unit.guid exactly as state.nearbyUnits() or state.closest(...) gave it`,
      );
    }
    const key = id;
    // Whether the cache has ever held the target while this fight ran: it is
    // what separates "left view alive" from "was never in view at all".
    let sawTarget = this.state.nearby.has(key);
    const refaceMs = options.refaceIntervalMs ?? 1500;
    const reapproachMs = options.reapproachIntervalMs ?? 6000;
    const meleeRange = options.meleeRange ?? 5;
    const pollMs = options.pollIntervalMs ?? 300;
    const deadline = Date.now() + (options.timeout ?? 25_000);
    const abortPct = options.abortBelowHealthPct;

    let swings = 0;
    const offSwing = this.events.on("SMSG_ATTACKERSTATEUPDATE", (e) => {
      if (isDecodeError(e.data)) return;
      if ((e.data as { attackerGuid: string }).attackerGuid === this.state.self.guid) swings++;
    });
    // The server cancelling our swing is observable, so react to it rather than
    // assuming the opening `attack_start` holds for the whole fight. The
    // handler only raises a flag; the loop decides, because by the time it runs
    // the cache may already know the victim is dead.
    let rearmWanted = false;
    const offStop = this.events.on("SMSG_ATTACKSTOP", (e) => {
      if (isDecodeError(e.data)) return;
      const d = e.data as { attackerGuid: string; victimGuid: string; attackerDead: boolean };
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
      // A "lost" verdict on a guid the cache never held is not a target that
      // left view — it is a guid that named nothing observable. Say so.
      const base =
        status === "lost" && !sawTarget
          ? `target ${key} was never in view — a stale or mistyped guid, or a missed view update; ` +
            `get guids from state.nearbyUnits() or state.closest(...)`
          : KILL_DETAIL[status];
      const facts: KillResultFacts = {
        guid: id,
        swings,
        healthPct: healthPct(),
        attacking: armed,
        detail:
          `${base}${note}; ` +
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
        this.throwIfAborted("killTarget's fight loop");
        if (targetDead()) return done("killed");
        if (selfDead()) return done("player_died");
        if (this.state.nearby.has(key)) sawTarget = true;
        else return done("lost");
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
   * (ADR-0013): the window that says what was there, the release that says it
   * is finished — and, between them, one `SMSG_ITEM_PUSH_RESULT` per item that
   * actually entered a bag. The pushes, not the window, decide the result:
   * a window is an offer, and calling an offer "looted" made a broken replay
   * invisible for a whole run (morning-opus-1; ADR-0016 forbids exactly that).
   * A corpse with nothing on it releases without ever opening a window, which
   * is `{ ok: false, status: "empty" }` — an answer, not a failure. Silence is
   * neither, so it still throws `EventTimeoutError`.
   */
  async lootCorpse(target: GuidOrUnit, options: LootOptions = {}): Promise<LootResult> {
    const id = guidOf(target, "lootCorpse(guid)");
    const timeout = options.timeout ?? 10_000;
    const sinceSeq = this.events.recent(1)[0]?.seq;
    // Collected live from before the action goes out, so a push can never slip
    // between the window arriving and a listener being registered.
    const stored: StoredLootItem[] = [];
    const offPush = this.events.on("SMSG_ITEM_PUSH_RESULT", (e: StreamEvent) => {
      if (isDecodeError(e.data) || (sinceSeq !== undefined && e.seq <= sinceSeq)) return;
      const d = e.data as ItemPushResultData;
      if (d.looted) stored.push({ itemId: d.itemId, count: d.count });
    });
    try {
      await this.lootAll(id);
      const first = await this.waitEvent(
        (e) =>
          (isEvent(e, "SMSG_LOOT_RESPONSE") || isEvent(e, "SMSG_LOOT_RELEASE_RESPONSE")) &&
          !isDecodeError(e.data) &&
          (sinceSeq === undefined || e.seq > sinceSeq),
        { timeout, description: "the loot window (SMSG_LOOT_RESPONSE or SMSG_LOOT_RELEASE_RESPONSE)" },
      );
      if (first.opcode === "SMSG_LOOT_RELEASE_RESPONSE") {
        return { ok: false, status: "empty", gold: 0, items: [] };
      }
      const window = first.data as LootResponseData;
      // What the replay will try to store: slots free to loot (0, ALLOW_LOOT)
      // or owned outright (4, OWNER — every slot of a solo loot). Group-only
      // slot types are shown but never auto-stored.
      const expected = window.items.filter((i) => i.slotType === 0 || i.slotType === 4).length;
      const release = await this.waitEvent((e) => isEvent(e, "SMSG_LOOT_RELEASE_RESPONSE"), {
        timeout,
        sinceSeq: first.seq + 1,
        includeBuffered: true,
        description: "the loot window closing (SMSG_LOOT_RELEASE_RESPONSE)",
      });
      // The pushes usually precede the release, but the ordering is not
      // contractual; give stragglers a short grace rather than under-reporting.
      const deadline = Date.now() + Math.min(timeout, LOOT_PUSH_GRACE_MS);
      let graceSince = release.seq + 1;
      while (stored.length < expected && Date.now() < deadline) {
        try {
          const push = await this.waitEvent(
            (e) => isEvent(e, "SMSG_ITEM_PUSH_RESULT") && !isDecodeError(e.data),
            { timeout: Math.max(1, deadline - Date.now()), sinceSeq: graceSince },
          );
          graceSince = push.seq + 1; // the on() listener above already recorded it
        } catch {
          break; // grace expired: report what was confirmed, nothing more
        }
      }
      if (expected > 0 && stored.length === 0) {
        return { ok: false, status: "none_stored", gold: window.gold, items: [], window: window.items };
      }
      return { ok: true, status: "looted", gold: window.gold, items: stored, window: window.items };
    } finally {
      offPush();
    }
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
    npcGuid: GuidOrUnit,
    questId: number,
    options: QuestOptions = {},
  ): Promise<QuestAcceptResult> {
    const npc = guidOf(npcGuid, "acceptQuestFrom(npcGuid, questId)");
    const timeout = options.timeout ?? 10_000;
    const inLog = this.state.quest(questId);
    if (inLog) {
      return { ok: true, status: "already_in_log", questId, quest: inLog, title: undefined };
    }

    const offered = await this.questOffer(npc, timeout);
    const wanted = offered.find((q) => q.questId === questId);
    if (!wanted) return { ok: false, status: "not_offered", questId, offered };

    await this.questAccept(npc, questId);
    const quest = await this.waitForState(
      () => this.state.quest(questId),
      timeout,
      `quest ${questId} to appear in the quest log after accept`,
    );
    return { ok: true, status: "accepted", questId, quest, title: wanted.title };
  }

  /**
   * Ask an NPC what quests it is offering, and return the list.
   *
   * The same `quest_list` send-and-wait `acceptQuestFrom` does — including
   * accepting *either* answer shape, since a gossip-flagged questgiver replies
   * with `SMSG_GOSSIP_MESSAGE` carrying the quests instead of
   * `SMSG_QUESTGIVER_QUEST_LIST` — with none of the accepting. Models kept
   * rebuilding exactly this by hand over `questList` plus event scraping and
   * getting confused by their own nulls (FOLLOW-UPS 9a).
   *
   * An empty `quests` is an answer: the NPC has nothing for this character
   * right now. Silence is not, so it still throws `EventTimeoutError`.
   */
  async questsAvailableFrom(
    npcGuid: GuidOrUnit,
    options: QuestOptions = {},
  ): Promise<{ ok: true; quests: readonly OfferedQuest[] }> {
    const npc = guidOf(npcGuid, "questsAvailableFrom(npcGuid)");
    const quests = await this.questOffer(npc, options.timeout ?? 10_000);
    return { ok: true, quests };
  }

  /**
   * Ask a trainer what it teaches.
   *
   * Two derived fields per row, because both are questions a caller always has
   * and neither is on the wire: `learnable` is the server's own green/red/gray
   * state reduced to the one bit that matters, and `affordable` compares the
   * cost against *observed* money — `undefined` while money is unobserved, not
   * guessed. The two are independent: the server's state says nothing about
   * money, so a green spell can still fail to buy.
   *
   * The core's handler returns silently when the NPC is out of interaction
   * range, is not a trainer, or trains another class, so nothing distinguishes
   * those from a slow answer: they all surface as `EventTimeoutError`.
   */
  async trainerList(npcGuid: GuidOrUnit, options: TrainerOptions = {}): Promise<TrainerListResult> {
    const id = guidKey(guidOf(npcGuid, "trainerList(npcGuid)"));
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.trainerListAsync(id);
    const event = await this.waitEvent(
      (e) =>
        isEvent(e, "SMSG_TRAINER_LIST") &&
        !isDecodeError(e.data) &&
        (e.data as TrainerListData).guid === id &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      {
        timeout: options.timeout ?? 10_000,
        description:
          `the SMSG_TRAINER_LIST for ${id} — the server stays silent when the NPC is out of ` +
          `interact range (~5y), is not a trainer, or trains another class`,
      },
    );
    const data = event.data as TrainerListData;
    const money = this.state.money?.value;
    return {
      ok: true,
      trainerType: data.trainerType,
      spells: data.spells.map((s) => ({
        ...s,
        learnable: s.state === TRAINER_SPELL_STATE.learnable,
        affordable: money === undefined ? undefined : money >= s.cost,
      })),
    };
  }

  /**
   * Spend a talent point and wait for the server's verdict.
   *
   * The handler answers every `CMSG_LEARN_TALENT` with `SMSG_TALENTS_INFO`,
   * so the verdict is whether that answer shows `talentId` at `rank` (0-based,
   * as on the wire). A refusal is a value, not a throw: the server says
   * nothing about *why* (no points, wrong tree tier, prerequisite missing),
   * so the hint lists what a client checks before enabling the button.
   */
  async learnTalent(talentId: number, rank: number, options: TrainerOptions = {}): Promise<LearnTalentResult> {
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.learnTalentAsync(talentId, rank);
    await this.waitEvent(
      (e) =>
        isEvent(e, "SMSG_TALENTS_INFO") &&
        !isDecodeError(e.data) &&
        !(e.data as TalentsInfoData).pet &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      {
        timeout: options.timeout ?? 10_000,
        description: `the SMSG_TALENTS_INFO answering learn_talent(${talentId}, ${rank})`,
      },
    );
    const talents = this.state.talents();
    if (talents === undefined) {
      throw new Error("learnTalent: SMSG_TALENTS_INFO arrived but the state cache holds no talent state");
    }
    const row = talents.talents.find((t) => t.talentId === talentId);
    if (row !== undefined && row.rank >= rank) {
      return { ok: true, status: "learned", talentId, rank, talents };
    }
    return {
      ok: false,
      status: "not_learned",
      talentId,
      rank,
      talents,
      hint:
        `the server did not record talent ${talentId} at rank ${rank} — it needs an unspent point ` +
        `(state.talents().unspentPoints is ${talents.unspentPoints}), the previous rank first, enough ` +
        `points in that tree's earlier tiers, and any prerequisite talent; the server names no reason`,
    };
  }

  /**
   * Buy one spell from a trainer and wait for the server's verdict.
   *
   * Races `SMSG_TRAINER_BUY_SUCCEEDED` against `SMSG_TRAINER_BUY_FAILED` for
   * this spell id, so a refusal costs one round trip rather than the whole
   * timeout. The refusal is returned, not thrown: it is the game answering
   * (ADR-0011), and `hint` names the likely causes and points back at
   * `trainerList` (ADR-0016).
   */
  async buySpell(
    npcGuid: GuidOrUnit,
    spellId: number,
    options: TrainerOptions = {},
  ): Promise<BuySpellResult> {
    const id = guidKey(guidOf(npcGuid, "buySpell(npcGuid, spellId)"));
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.trainerBuySpellAsync(id, spellId);
    const isFor = (e: StreamEvent, opcode: "SMSG_TRAINER_BUY_SUCCEEDED" | "SMSG_TRAINER_BUY_FAILED") =>
      isEvent(e, opcode) &&
      !isDecodeError(e.data) &&
      (e.data as { spellId: number }).spellId === spellId;
    const event = await this.waitEvent(
      (e) =>
        (isFor(e, "SMSG_TRAINER_BUY_SUCCEEDED") || isFor(e, "SMSG_TRAINER_BUY_FAILED")) &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      {
        timeout: options.timeout ?? 10_000,
        description:
          `the verdict for buying spell ${spellId} from ${id} ` +
          `(SMSG_TRAINER_BUY_SUCCEEDED or SMSG_TRAINER_BUY_FAILED)`,
      },
    );
    if (event.opcode === "SMSG_TRAINER_BUY_SUCCEEDED") {
      return { ok: true, status: "learned", spellId };
    }
    const reason = (event.data as TrainerBuyFailedData).reason;
    const named = TRAINER_BUY_FAIL_HINTS[reason];
    return {
      ok: false,
      status: "buy_failed",
      spellId,
      reason,
      hint:
        `the trainer refused (reason ${reason}${named ? `: ${named}` : ""}) — the usual causes are ` +
        `too little money and a spell that is not learnable yet; sdk.trainerList(npcGuid) reports ` +
        `each spell's cost, learnable and affordable`,
    };
  }

  /**
   * Hand a finished quest back and take a reward.
   *
   * `quest_complete` is answered either with the reward offer or with
   * `SMSG_QUESTGIVER_REQUEST_ITEMS`. A *completable* REQUEST_ITEMS is how the
   * core answers item-delivery quests — re-asking gets the same answer forever
   * (roster-opus-20260822), so the reward is chosen directly from there. A
   * `completable: false` is the questgiver saying no: `not_complete` when the
   * quest log agrees, `wrong_questgiver` when the log says the objectives are
   * done — that refusal means another NPC ends this quest.
   */
  async turnInQuest(
    npcGuid: GuidOrUnit,
    questId: number,
    rewardIndex = 0,
    options: QuestOptions = {},
  ): Promise<QuestTurnInResult> {
    const npcId = guidOf(npcGuid, "turnInQuest(npcGuid, questId)");
    const timeout = options.timeout ?? 10_000;
    const isFor = (e: StreamEvent, opcode: "SMSG_QUESTGIVER_OFFER_REWARD" | "SMSG_QUESTGIVER_REQUEST_ITEMS") =>
      isEvent(e, opcode) &&
      !isDecodeError(e.data) &&
      (e.data as { questId: number }).questId === questId;

    // Out-of-range quest_complete is silently ignored by the server and burns
    // the whole timeout (roster-opus-20260822 turn ~28). Fail fast only when
    // the cache can prove the NPC is *grossly* far away — the 40y threshold
    // leaves cached-position staleness no room to reject a legitimate call
    // (ADR-0016); borderline cases still get the honest timeout.
    const distance = distanceToUnit(this.state, npcId);
    if (distance !== undefined && distance > 40) {
      return {
        ok: false,
        status: "too_far",
        questId,
        distance: Math.round(distance),
        hint: `the questgiver is ${Math.round(distance)}y away — interact range is ~${INTERACT_RANGE}y; moveTo it first`,
      };
    }

    {
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.questComplete(npcId, questId);
      const answer = await this
        .waitEvent(
          (e) =>
            (isFor(e, "SMSG_QUESTGIVER_OFFER_REWARD") || isFor(e, "SMSG_QUESTGIVER_REQUEST_ITEMS")) &&
            (sinceSeq === undefined || e.seq > sinceSeq),
          {
            timeout,
            description:
              `the turn-in answer for quest ${questId} (SMSG_QUESTGIVER_OFFER_REWARD or _REQUEST_ITEMS) — ` +
              questgiverSilence(
                distance,
                `does not end quest ${questId}, or the objectives are not complete`,
                `Check state.quest(${questId}).complete, and use the search_reference tool for who ends ` +
                  `quest ${questId} — the giver of a quest is often not its ender. ` +
                  `state.units({ questGiver: "reward" }) lists every NPC in view ready to take a turn-in.`,
                questgiverMarkerOf(this.state, npcId, "reward", questId),
              ),
          },
        )
        .catch((e: unknown) => {
          throw withDistance(e, distance);
        });
      if (answer.opcode === "SMSG_QUESTGIVER_REQUEST_ITEMS") {
        const req = answer.data as QuestGiverRequestItemsData;
        if (!req.completable) {
          const logComplete = this.state.quest(questId)?.complete === true;
          if (logComplete) {
            return {
              ok: false,
              status: "wrong_questgiver",
              questId,
              hint: "the quest log says the objectives are complete but this NPC refused — a different NPC ends this quest; check the quest text for who to return to",
            };
          }
          return {
            ok: false,
            status: "not_complete",
            questId,
            hint: "the questgiver refused and the quest log agrees the objectives are unfinished — check state.quest(questId).counts",
          };
        }
        // completable REQUEST_ITEMS: fall through and choose the reward.
      }
      await this.questChooseReward(npcId, questId, rewardIndex);
      // Raced against the completion: a reward that does not fit answers the
      // choose with SMSG_INVENTORY_CHANGE_FAILURE and *no* completion — before
      // this race, a full bag was indistinguishable from silence and burned
      // the whole timeout (morning-opus-1).
      const complete = await this.waitEvent(
        (e) =>
          (isEvent(e, "SMSG_QUESTGIVER_QUEST_COMPLETE") &&
            !isDecodeError(e.data) &&
            (e.data as QuestGiverQuestCompleteData).questId === questId) ||
          (isEvent(e, "SMSG_INVENTORY_CHANGE_FAILURE") && !isDecodeError(e.data)),
        {
          timeout,
          sinceSeq: answer.seq + 1,
          description: `SMSG_QUESTGIVER_QUEST_COMPLETE for quest ${questId} (or SMSG_INVENTORY_CHANGE_FAILURE)`,
        },
      );
      if (complete.opcode === "SMSG_INVENTORY_CHANGE_FAILURE") {
        const fail = complete.data as InventoryChangeFailureData;
        return {
          ok: false,
          status: "inventory_full",
          questId,
          result: fail.result,
          hint: "the reward could not be stored — free a bag slot (sell or destroyItem), then turn in again",
        };
      }
      const d = complete.data as QuestGiverQuestCompleteData;
      return { ok: true, status: "complete", questId, xp: d.xp, money: d.money };
    }
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
    return this.waitForState(
      () => {
        const q = this.state.quest(questId);
        return q?.complete === true ? q : undefined;
      },
      options.timeout ?? 60_000,
      `quest ${questId} objectives to read complete in the quest log`,
    );
  }

  /**
   * Our own guid as a map key, once the session response has seeded it.
   *
   * Optional-chained on `this.state` because introspection idioms read getters
   * off the prototype (where `this` has no fields) — that must yield
   * `undefined`, not a TypeError (observed in live runs, 4 of them).
   */
  get selfKey(): string | undefined {
    return this.state?.self?.guid;
  }

  // --------------------------------------------------------------- internals

  /**
   * Resolve a `gossipSelect` option (text or numeric id) against the menu last
   * observed open for `guid`. Throws — nothing is dispatched — for a missing
   * menu, no match, an ambiguous text, or an id that is not on the menu, each
   * message listing the options (ADR-0016).
   */
  private resolveGossipOption(guid: string, option: string | number): { menuId: number; optionId: number } {
    const menu = this.state.lastGossip(guidKey(guid));
    if (!menu) {
      throw new TypeError(
        `gossipSelect(guid, option): no gossip menu has been observed open for ${guid} — open one first ` +
          `with gossipHello(guid) (or questList), then select. If you already have the ids, use the raw ` +
          `form gossipSelect(guid, menuId, optionId).`,
      );
    }
    const list = menu.options.map((o) => `[${o.optionId}] ${JSON.stringify(o.text)}`).join(", ");
    if (typeof option === "number") {
      const found = menu.options.find((o) => o.optionId === option);
      if (!found) {
        throw new TypeError(
          `gossipSelect(guid, ${option}): the menu currently open for ${guid} has no option ${option}. ` +
            `Options are: ${list}.`,
        );
      }
      return { menuId: menu.menuId, optionId: found.optionId };
    }
    const q = option.trim().toLowerCase();
    const exact = menu.options.filter((o) => o.text.toLowerCase() === q);
    const matched = exact.length > 0 ? exact : menu.options.filter((o) => o.text.toLowerCase().includes(q));
    if (matched.length === 1) return { menuId: menu.menuId, optionId: matched[0]!.optionId };
    if (matched.length === 0) {
      throw new TypeError(
        `gossipSelect(guid, ${JSON.stringify(option)}): no option on the menu currently open for ${guid} ` +
          `matches. Options are: ${list}. Pass the exact text, a unique substring, or the numeric optionId.`,
      );
    }
    const both = matched.map((o) => `[${o.optionId}] ${JSON.stringify(o.text)}`).join(", ");
    throw new TypeError(
      `gossipSelect(guid, ${JSON.stringify(option)}): matches ${matched.length} options on the menu open ` +
        `for ${guid}: ${both}. Use the exact text, a longer unique substring, or the numeric optionId.`,
    );
  }

  /** One `POST /action`, with the session token filled in. */
  private action(body: ActionBody): Promise<ActionResponse> {
    return this.request("POST", "/action", { token: this.token, ...body }, actionResponseSchema);
  }

  /**
   * Send `quest_list` and return the offer the NPC answered with.
   *
   * The one place the two answer shapes are reconciled — a gossip-flagged
   * questgiver replies `SMSG_GOSSIP_MESSAGE` with the quests embedded — shared
   * by `questsAvailableFrom` and `acceptQuestFrom` so they can never drift.
   *
   * The match is on opcode and a `sinceSeq` floor, not on the event's guid:
   * that is how `acceptQuestFrom` has always behaved, and narrowing it here
   * would change a shipped helper. Two overlapping calls against *different*
   * NPCs can therefore cross answers; one at a time is the contract.
   */
  private async questOffer(npcGuid: GuidArg, timeout: number): Promise<readonly OfferedQuest[]> {
    const sinceSeq = this.events.recent(1)[0]?.seq;
    const distance = distanceToUnit(this.state, npcGuid);
    await this.questList(npcGuid);
    const menu = await this
      .waitEvent(
        (e) =>
          (isEvent(e, "SMSG_QUESTGIVER_QUEST_LIST") || isEvent(e, "SMSG_GOSSIP_MESSAGE")) &&
          !isDecodeError(e.data) &&
          (sinceSeq === undefined || e.seq > sinceSeq),
        {
          timeout,
          description:
            "the questgiver's quest list (SMSG_QUESTGIVER_QUEST_LIST or SMSG_GOSSIP_MESSAGE) — " +
            questgiverSilence(
              distance,
              "is not a questgiver, or has nothing for this character right now",
              'Use the search_reference tool for who offers the quest you are after; state.units({ questGiver: "available" }) lists every NPC in view with a quest on offer.',
              questgiverMarkerOf(this.state, npcGuid, "available"),
            ),
        },
      )
      .catch((e: unknown) => {
        throw withDistance(e, distance);
      });
    return (menu.data as QuestGiverQuestListData | GossipMessageData).quests ?? [];
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

  /** The signal in force for a wait started now (see `ConnectOptions.signal`). */
  private currentSignal(): AbortSignal | undefined {
    return this.defaultSignal?.();
  }

  /**
   * How much of the caller's budget is left, per `ConnectOptions.deadline`.
   * Undefined when no budget is known — and never used to shorten, cap or
   * refuse anything: it only lets a `moveTo` result say the walk was longer
   * than the snippet that awaited it.
   */
  private remainingBudgetMs(): number | undefined {
    const at = this.deadlineAt?.();
    if (at === undefined || !Number.isFinite(at)) return undefined;
    const left = at - Date.now();
    // A deadline already past is not a budget of zero, it is a budget we do not
    // know: a background routine inherits the async context (and therefore the
    // deadline) of the snippet that launched it, and that snippet's clock ran
    // out long ago. Reporting zero there would append "this does not fit your
    // budget — use a background routine" to every leg of a walk already running
    // in one.
    return left > 0 ? left : undefined;
  }

  /** `events.waitFor` with the client's default signal threaded in. */
  private waitEvent(predicate: (event: StreamEvent) => boolean, options: WaitForOptions = {}): Promise<StreamEvent> {
    const signal = options.signal ?? this.currentSignal();
    return this.events.waitFor(predicate, signal === undefined ? options : { ...options, signal });
  }

  /** Throw `EventAbortedError` if the default signal has already fired. */
  private throwIfAborted(waitingFor: string): void {
    const signal = this.currentSignal();
    if (signal?.aborted) throw new EventAbortedError(signal.reason, waitingFor);
  }

  /**
   * Wait until a predicate over the *state cache* holds. Checks immediately,
   * then re-checks on every event, which is exact because the cache is folded
   * before waiters run. Throws `EventTimeoutError` if it never holds.
   */
  private async waitForState<T>(
    read: () => T | undefined,
    timeout: number,
    description?: string,
  ): Promise<T> {
    const already = read();
    if (already !== undefined) return already;
    let hit: T | undefined;
    await this.waitEvent(
      () => {
        hit = read();
        return hit !== undefined;
      },
      {
        timeout,
        includeBuffered: false,
        description: description ?? "a state-cache condition to hold",
      },
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
