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
  type ActivateTaxiReplyData,
  type BindPointUpdateData,
  type CharacterDeleteResponse,
  type CorpseReclaimDelayData,
  type CorpseQueryData,
  type CreateSessionRequest,
  type DeathReleaseLocData,
  type DeleteSessionResponse,
  type ErrorBody,
  type FaceResponse,
  type GossipMessageData,
  type GroupListData,
  type HealthResponse,
  type MailListResultData,
  type PartyCommandResultData,
  type SendMailResultData,
  type ShowFrameData,
  type SpellFailureData,
  type InventoryChangeFailureData,
  type CastFailedData,
  type ItemPushResultData,
  type KnownMoveStatus,
  type LootItemData,
  type LootResponseData,
  type LootRollData,
  type ReadItemData,
  type PageTextQueryResponseData,
  type ItemTextQueryResponseData,
  type MoveResultData,
  type MoveUpdateData,
  type MoveStatus,
  type MoveToResponse,
  type NewWorldData,
  type TransferAbortedData,
  type OfferedQuest,
  type QuestGiverQuestCompleteData,
  type QuestGiverQuestListData,
  type QuestGiverQuestDetailsData,
  type QuestGiverRequestItemsData,
  type QuestGiverStatusData,
  type QuestGiverStatusMultipleData,
  type RawField,
  type RawPayload,
  type SessionResponse,
  type TalentsInfoData,
  type TalentTreeData,
  type TalentWipeConfirmData,
  type TrainerBuyFailedData,
  type TrainerListData,
  type TrainerSpellData,
  leaseResponseSchema,
  releaseLeaseResponseSchema,
  type LeaseResponse,
  type ReleaseLeaseResponse,
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
  mailResultText,
  partyResultText,
  pointOf,
  questGiverStatusName,
  StateCache,
  type BagSlotItem,
  type BankContents,
  type BindPoint,
  type ChatEntry,
  type GroupState,
  type MailboxState,
  type PetSpellEntry,
  type PendingRoll,
  type RollChoice,
  ROLL_VOTE,
  type CorpseLocation,
  type NearbyObject,
  type Point3,
  type QuestGiverStatusName,
  type QuestLogEntry,
  type TalentState,
  type TalentTree,
  type TaxiNodeRef,
  type TaxiWindow,
  type UnitPosition,
  type UnitView,
  type WorldPosition,
} from "./state";
import type { z } from "zod";
import { isFuzzy, resolveName, type ResolvedRef, type ResolveTier } from "./resolve";

/**
 * What every guid-taking method accepts: the opaque decimal string the SDK
 * itself hands out. The wire form is the same string.
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
 * the deterministic-repair rule.
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

/**
 * Resolve `activateTaxi`'s destination — a node name, through the shared
 * `resolveName`, or a node id — against a flight master window.
 * Throws with the known nodes listed on no match or more than one; the
 * current node is a legal target here (the server answers 11, same node).
 */
function resolveTaxiNode(window: TaxiWindow, dest: string | number): TaxiNodeRef {
  const list = () =>
    window.known.map((n) => `${n.nodeId}${n.name === undefined ? "" : `:${JSON.stringify(n.name)}`}`).join(", ");
  if (typeof dest === "number") {
    const hit = window.known.find((n) => n.nodeId === dest);
    if (hit !== undefined) return hit;
    throw new Error(
      `activateTaxi(${window.guid}, ${dest}): node ${dest} is not in the window this flight master last showed ` +
        `(only nodes this character has visited are offered). Known: ${list()}`,
    );
  }
  const named = window.known.filter((n) => n.name !== undefined);
  const hit = resolveName(dest, named, (n) => n.name);
  if (hit.kind === "one") return hit.value;
  if (hit.kind === "none") {
    throw new Error(
      `activateTaxi(${window.guid}, ${JSON.stringify(dest)}): no known node in this flight master's window is named ` +
        `that${named.length === 0 ? " (the module served ids only — pass a node id)" : ""}. Known: ${list()}`,
    );
  }
  throw new Error(
    `activateTaxi(${window.guid}, ${JSON.stringify(dest)}): matches ${hit.candidates.length} nodes (${hit.candidates
      .map((n) => JSON.stringify(n.name))
      .join(", ")}); use the exact name or the node id. Known: ${list()}`,
  );
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
 * pointer back to where units come from. A non-object falls through
 * to `guidArg`, so a bare guid string keeps its exact existing validation. A
 * name is handled a step earlier, by `targetRef`.
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

/** A guid as the module writes them: decimal digits and nothing else. */
const GUID_TEXT = /^\d+$/;

/** What a name resolved to: the thing's guid, the name it actually landed on, and which tier answered. */
interface NameHit {
  guid: string;
  name: string;
  tier: ResolveTier;
}

/**
 * A helper's target once resolved: the guid it will act on, plus — only when a
 * name matched non-exactly — the `resolved` the result carries back, so the
 * model can see what it acted on rather than being told in a hint.
 */
interface TargetRef {
  guid: string;
  resolved?: ResolvedRef;
}

/** Any helper result, plus the `resolved` a non-exact name match adds to it. */
export type WithResolved<T> = T & { resolved?: ResolvedRef };

/** Fold a ref's `resolved` into a result object, leaving an exact match untouched. */
function withResolved<T extends object>(ref: { resolved?: ResolvedRef }, out: T): WithResolved<T> {
  return ref.resolved === undefined ? out : { ...out, resolved: ref.resolved };
}

/** How many rows a "what was found instead" list quotes before it truncates. */
const SHOWN_MATCHES = 8;

function listNames(rows: readonly { guid: string; name?: string | undefined }[]): string {
  const shown = rows.slice(0, SHOWN_MATCHES).map((r) => `${r.guid}:${JSON.stringify(r.name ?? "?")}`);
  return shown.join(", ") + (rows.length > shown.length ? `, +${rows.length - shown.length} more` : "");
}

/**
 * Resolve a helper target given as a name rather than a guid — what a client
 * picks by looking at it. The tiers and the fuzz budget are the shared
 * `resolveName` (sdk/src/resolve.ts). Two matches is two readings, so it
 * refuses and lists them rather than picking (METHODOLOGY, "Softening"): the
 * SDK never chooses a referent for the model.
 */
function resolveNamedTarget(state: StateCache, name: string, arg: string): NameHit {
  const rows = state.units();
  if (name.trim().length === 0) {
    throw new TypeError(
      `${arg} is an empty string — pass a guid, a unit from state.units(...) / state.closest(...), or the ` +
        `name of something in view`,
    );
  }
  const named = rows.filter((u) => u.name !== undefined);
  const hit = resolveName(name, named, (u) => u.name);
  if (hit.kind === "one") return { guid: hit.value.guid, name: hit.name, tier: hit.tier };
  if (hit.kind === "none") {
    throw new TypeError(
      `${arg} got ${JSON.stringify(name)}, which is neither a decimal guid nor the name of anything in view. ` +
        `In view: [${listNames(named)}] — pass a unit from state.units({ name: ... }) or its .guid`,
    );
  }
  throw new TypeError(
    `${arg} got ${JSON.stringify(name)}, which matches ${hit.candidates.length} things in view ` +
      `([${listNames(hit.candidates)}]); pass the one you mean from state.units({ name: ... }) — the SDK does ` +
      `not choose between referents`,
  );
}

/**
 * Resolve which item an item-taking call means: the `bag`/`slot` pair
 * `state.bag()` / `state.bank()` list, or the item's name in place of `bag`
 * (through the shared `resolveName`). A name that matches
 * nothing or more than one thing is refused with what was found; a `bag`
 * number with no `slot` is refused the same way. The numeric pair is passed
 * through untouched, including one nothing has been observed at — the caller
 * that cares reports that itself.
 */
function resolveItemSlot(
  items: readonly { bag: number; slot: number; itemId?: number | undefined; name?: string | undefined }[],
  bagOrName: number | string,
  slot: number | undefined,
  method: string,
  where: string,
): { bag: number; slot: number; resolved?: ResolvedRef } | { refusal: string } {
  if (typeof bagOrName === "number") {
    if (typeof slot !== "number" || !Number.isInteger(slot)) {
      return { refusal: `${method}: a numeric bag needs its slot too — pass ${method.replace(/\(.*$/, "")}(bag, slot) as ${where} lists them, or the item's name` };
    }
    return { bag: bagOrName, slot };
  }
  const named = items.filter((i) => i.name !== undefined);
  const hit = resolveName(bagOrName, named, (i) => i.name);
  const show = (rows: readonly { bag: number; slot: number; name?: string | undefined }[]) =>
    rows.slice(0, SHOWN_MATCHES).map((i) => `${JSON.stringify(i.name ?? "?")} at bag ${i.bag} slot ${i.slot}`).join(", ") +
    (rows.length > SHOWN_MATCHES ? `, +${rows.length - SHOWN_MATCHES} more` : "");
  if (hit.kind === "one") {
    return {
      bag: hit.value.bag,
      slot: hit.value.slot,
      ...(isFuzzy(hit.tier) ? { resolved: { input: bagOrName, name: hit.name } } : {}),
    };
  }
  if (hit.kind === "none") {
    return { refusal: `${method}: nothing in ${where} is named ${JSON.stringify(bagOrName)} — it holds [${show(named)}]` };
  }
  return {
    refusal: `${method}: ${JSON.stringify(bagOrName)} matches ${hit.candidates.length} items in ${where} ([${show(hit.candidates)}]) — pass the bag and slot of the one you mean`,
  };
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
 * Deterministic repair for `moveTo(x, y, z)` written as three
 * positional numbers instead of one `{ x, y, z }`. That shape has exactly one
 * valid reading, and weak models write it across every family (nemotron, hy3,
 * gpt-oss trajectories 2026-08-22). Returns the repaired point, or null when
 * the call is not that shape — every other bad shape still hits the loud
 * assertMovePoint reject. Only the helper `moveTo` repairs the positional form;
 * raw `moveToAsync` stays strict about it (raw actions do not soften).
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
 * Resolve `moveTo`'s target to a point (earned surface: 4 of 7 runs in
 * the 2026-08-23 fan-out threw a raw `TypeError: moveTo position x must be a
 * finite number, got undefined` from `.x` on a lookup that found nothing).
 *
 * A point is untouched — same validation, same messages, same wire call. A unit
 * or guid resolves through the state cache, exactly the position `state.units()`
 * would report; a unit the cache has lost falls back to the coordinates that
 * unit object itself carries *and says so*, because walking to where something
 * was without mentioning it is the silent wrong behaviour the softening policy
 * forbids; and
 * a guid nothing can be found for is a typed answer, not a throw.
 */
function resolveMoveTarget(target: unknown, state: StateCache, method: string): ResolvedMoveTarget {
  // A name is the third form a client could mean, and moveTo answers a target
  // it cannot resolve with a value rather than a throw — so a name that names
  // nothing, or two things, comes back as `unknown_target` with what was found.
  if (typeof target === "string" && !GUID_TEXT.test(target.trim())) {
    try {
      target = resolveNamedTarget(state, target, `${method}(target)`).guid;
    } catch (e) {
      return { unknown: e instanceof Error ? e.message : String(e) };
    }
  }
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
  // authentication (PROTOCOL.md, "Authentication")
  "unauthorized",
  "operator_only",
  "token_mismatch",
  "account_not_leased",
  "character_bound",
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
  // raw passthrough
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
  // The name is the model's own choice, so this one code is not a
  // dead end but a retry: say what to do about it, in the game's own rules.
  0x32:
    "that name is already in use — choose a different character name and call createSession again " +
    "(2-12 letters, no spaces, no three identical letters in a row; be creative, it is yours for the episode)",
  0x33: "character creation disabled",
  0x35: "the account has reached its character limit on this realm",
  0x36: "the account has reached its character limit",
  0x3a: "class requires an expansion the account lacks",
  0x3e: "that race/class combination is not allowed",
  // The name is the caller's own, so every naming refusal is a
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
  unauthorized:
    "the request carried no valid credential — the client must be constructed with the `secret` the " +
    "runner obtained for this token (or, for operator tooling, the port secret from WRATHBENCH_MODULE_SECRET)",
  operator_only:
    "this route (lease, list or delete characters) is for operator tooling holding the port secret; " +
    "a session works only with its own character through createSession/deleteSession",
  token_mismatch:
    "this session's credential is bound to one token and the request named another — use the client " +
    "as constructed; there is no other session to reach",
  account_not_leased:
    "the account named is not the one this session was leased for — omit `account`; the run's account is fixed",
  character_bound:
    "this session already played a character (see `bound`) and cannot create another — call createSession " +
    "with that name, or deleteSession and continue with it",
  item_not_usable:
    "the module refused use_item for that bag/slot — the item there has no on-use spell and no quest to start, " +
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
   * The credential sent as `Authorization: Bearer` on every request and on
   * the `/events` upgrade (module/PROTOCOL.md, "Authentication"). For the
   * snippet child this is the lease secret the runner obtained for `token`
   * (`POST /lease`); for operator tooling — smokes, hygiene, the fleet — it
   * is the port secret. The SDK reads no environment: the caller passes it.
   * Undefined sends no header, which the module answers with
   * `401 unauthorized`.
   */
  secret?: string;
  /**
   * The game account this run occupies, bound operator-side exactly like
   * `token` (decided 2026-08-22). When set it is authoritative: it
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
   * (explain, do not cap). Undefined means no budget is known.
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
 * time (earned by the 2026-08-23 fan-out, where 4 of 7 runs threw a
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
       * status vocabulary is the module's word; this arm is the SDK
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
 * Per-status recovery recipes (what happened, what it means,
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
 * One (action, status) pair of hint-bearing failures, tallied for the harness.
 *
 * The hints above ride inside the result object, so a snippet that reduces a
 * result to `.status` — the common shape — throws them away before the model
 * ever reads one: run a11 (2026-08-29) took 41 `too_far` refusals and read the
 * hint zero times. The client therefore also *records* every hint-bearing
 * failure on a channel the snippet cannot strip; the sandbox drains it and the
 * runner renders it into the snippet result. Aggregated per status rather than
 * kept per occurrence because the recipes interpolate coordinates: 41 `too_far`
 * hints are 41 distinct strings, and a per-occurrence log would deliver 41
 * lines saying one thing. `hint` is the last occurrence's — the one nearest
 * where the character actually is, and so the actionable one.
 */
export interface ActionHint {
  /** The SDK call that failed, e.g. `moveTo`. */
  action: string;
  /** The failure status, the module's word. */
  status: string;
  /** How many times this (action, status) failed since the last drain. */
  count: number;
  /** The most recent hint text for this pair. */
  hint: string;
  /** The destination of the most recent such failure, when the call had one. */
  point?: { x: number; y: number; z: number };
  /** When that most recent failure was recorded (epoch ms). */
  ts: number;
}

/** Distinct (action, status) pairs kept between drains. A guard, never reached in practice. */
const ACTION_HINT_MAX_KEYS = 32;

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
 * same reason as `MoveResult`: every arm is the game answering, and
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
 * How a fight ended, as a value.
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
 * detail, not new public surface.
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

/**
 * How a client opens a chest. `CMSG_GAMEOBJ_USE` does nothing to a chest-type
 * game object (the core's `GameObject::Use` has no chest case and returns
 * silently); the client instead casts the lock's "Opening" spell at it —
 * `SPELL_EFFECT_OPEN_LOCK`, ~1s cast, interrupted by moving — and the server
 * answers the cast with the loot window. Which spell is decided by the lock's
 * type in `Lock.dbc`, which the SDK does not carry, so it tries the
 * open-hand spells in order of how many spawned chests each one fits and
 * takes the first the server accepts; a wrong one is refused before the cast
 * starts (`SMSG_CAST_FAILED`, `SPELL_FAILED_BAD_TARGETS`), costing one round
 * trip. Lock types: 13 Open Kneeling (6478), 5 Open (3365), 10 Quick Open
 * (6247), 12 Open Tinkering (6477). Profession nodes (herbs, ore) need the
 * gathering spell and are not chests to this helper.
 */
const CHEST_OPEN_SPELLS: readonly number[] = [6478, 3365, 6247, 6477];
/** SpellCastResult: the lock does not fit the spell (or the target is no lock). */
const SPELL_FAILED_BAD_TARGETS = 12;
/** Loot slot types the auto-loot sequence stores: ALLOW_LOOT (0) and OWNER (4). */
const isStorableSlot = (i: { slotType: number }): boolean => i.slotType === 0 || i.slotType === 4;

/** `interact(guid)` on a chest: the opcode would be dropped, so it is refused with the way that works. */
export type InteractResult = ActionResponse | { readonly ok: false; readonly status: "chest"; readonly hint: string };

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
 * wrong behavior the softening policy forbids (and exactly what happened while the module's
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
      /** A chest none of the open spells could open: the server refused every cast. */
      readonly ok: false;
      readonly status: "not_opened";
      readonly gold: 0;
      readonly items: readonly [];
      /** SpellCastResult code of the last refusal (12 = bad targets: no open-hand lock type fits). */
      readonly reason: number;
      readonly hint: string;
    }
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
    }
  | {
      readonly ok: false;
      /** The NPC's observed questgiver marker already says it offers nothing; nothing was sent. */
      readonly status: "nothing_on_offer";
      readonly questId: number;
      readonly offered: readonly OfferedQuest[];
      readonly hint: string;
    };

/**
 * `useItem`'s answer: the module's ack, plus — for an item whose tooltip says
 * it starts a quest — the offer the server made from it. `itemGuid` is what
 * `acceptQuestFrom` takes in place of an NPC guid.
 */
export type UseItemResult = ActionResponse & {
  readonly questOffer?: { readonly questId: number; readonly title: string; readonly itemGuid: string };
};

/** The quest an item's tooltip says it starts, when the tooltip has been observed and says so. */
function questStartedBy(state: StateCache, item: BagSlotItem | undefined): number | undefined {
  if (item?.itemId === undefined) return undefined;
  const startQuest = state.items.get(item.itemId)?.value?.startQuest;
  return startQuest === undefined || startQuest === 0 ? undefined : startQuest;
}

/** `questsAvailableFrom`'s answer; `nothing_on_offer` is the marker pre-check, with nothing sent. */
export type QuestsAvailableResult =
  | { readonly ok: true; readonly quests: readonly OfferedQuest[] }
  | { readonly ok: false; readonly status: "nothing_on_offer"; readonly quests: readonly OfferedQuest[]; readonly hint: string };

/** What `questOffer` learned: the list, or the marker that made asking pointless. */
type QuestOfferOutcome = { readonly quests: readonly OfferedQuest[] } | { readonly nothing: QuestGiverMarker; readonly hint: string };

/** The questgiver markers that say "nothing to offer" before a quest list is even asked for. */
const OFFERS_NOTHING: ReadonlySet<QuestGiverStatusName> = new Set([
  "none",
  "unavailable",
  "incomplete",
  "reward_rep",
  "low_level_reward_rep",
  "reward2",
  "reward",
]);

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
 * `SMSG_ACTIVATETAXIREPLY.reply` — `ActivateTaxiReply` in the pinned core —
 * rendered the way `TRAINER_BUY_FAIL_HINTS` renders trainer refusals: the
 * number is the server's word and is always reported; this is the
 * client-visible sentence and the recovery that follows from it. The
 * accepted case (0) needs no hint. An unknown code renders without one.
 */
const TAXI_REPLY_HINTS: Record<number, string> = {
  1: "the server refused the flight without a reason (ERR_TAXIUNSPECIFIEDSERVERERROR); ask again",
  2: "no flight path connects these two nodes for this character (ERR_TAXINOSUCHPATH); pick another destination from state.lastTaxiNodes(guid).known",
  3: "not enough money for the fare (ERR_TAXINOTENOUGHMONEY); state.money is what you have",
  4: "too far from the flight master, or it is not a flight master (ERR_TAXITOOFARAWAY); moveTo the NPC first, then reopen the window with showTaxiNodes(guid)",
  5: "no flight master is in interaction range (ERR_TAXINOVENDORNEARBY); moveTo the NPC and retry",
  6: "this character has not visited that node (ERR_TAXINOTVISITED) — a flight master only sells routes between nodes you have discovered on foot; the destination must be in state.lastTaxiNodes(guid).known",
  7: "you are busy (ERR_TAXIPLAYERBUSY): in combat, casting, or trading; wait and retry",
  8: "you are already mounted (ERR_TAXIPLAYERALREADYMOUNTED); dismount first",
  9: "you are shapeshifted (ERR_TAXIPLAYERSHAPESHIFTED); cancel the form first",
  10: "you are moving (ERR_TAXIPLAYERMOVING); stop(), stand still a moment, retry",
  11: "the destination is the node you are standing at (ERR_TAXISAMENODE); pick another",
  12: "you are not standing (ERR_TAXINOTSTANDING); stand up and retry",
};

/**
 * `SMSG_INVENTORY_CHANGE_FAILURE.result` — the 3.3.5a `InventoryResult` enum
 * (`EQUIP_ERR_*` in the pinned core's `Item.h`), as the short sentence a client
 * would put on screen for it.
 *
 * Every inventory refusal the game makes arrives as one of these numbers and
 * nothing else, and a run was observed reverse-engineering "reason 60" into
 * "in combat" from context (FOLLOW-UPS item 101a). The number stays the
 * server's word and is always reported alongside; this table only names it.
 * Naming is not softening game semantics — the client shows this text too —
 * and it says nothing about what to do next.
 *
 * Codes whose only client string is empty (`EQUIP_ERR_OK`, `EQUIP_ERR_NONE`,
 * the gap at 83) are absent on purpose, and an unknown code renders without
 * text rather than with a guess.
 */
const INVENTORY_RESULT_TEXT: Record<number, string> = {
  1: "your level is too low for that item",
  2: "you do not have the skill it requires",
  3: "that item does not go in that slot",
  4: "that bag is full",
  5: "a bag with things in it cannot go inside another bag",
  6: "bags with things in them cannot be traded",
  7: "only ammo can go there",
  8: "your class has no proficiency for that weapon or armour type — a weapon master can teach some of them",
  9: "no equipment slot is free for it",
  10: "this character can never use that item",
  11: "this character can never use that item",
  12: "no equipment slot is free for it",
  13: "a two-handed weapon is equipped — that blocks an off-hand or shield until you equip a one-hander instead",
  14: "you cannot dual wield",
  15: "that item does not go into a bag",
  16: "that item does not go into a bag",
  17: "you cannot carry any more of that",
  18: "no equipment slot is free for it",
  19: "that item does not stack",
  20: "that item cannot be equipped",
  21: "those two items cannot be swapped",
  22: "that inventory slot is empty",
  23: "no item was found at that address",
  24: "a soulbound item cannot be dropped that way",
  25: "you are out of range",
  26: "you tried to split off more than the stack holds",
  27: "the stack could not be split",
  28: "a reagent is missing",
  29: "you do not have enough money",
  30: "that is not a bag",
  31: "that can only be done with empty bags",
  32: "you do not own that item",
  33: "you can equip only one quiver",
  34: "that bag slot has not been bought yet",
  35: "you are too far from the bank",
  36: "the item is locked",
  37: "you are stunned",
  38: "you are dead",
  39: "you cannot do that right now",
  40: "the server reported an internal bag error",
  41: "you can equip only one bolt container",
  42: "you can equip only one ammo pouch",
  43: "a stack cannot be wrapped",
  44: "an equipped item cannot be wrapped",
  45: "a wrapped item cannot be wrapped again",
  46: "a soulbound item cannot be wrapped",
  47: "a unique item cannot be wrapped",
  48: "bags cannot be wrapped",
  49: "that has already been looted",
  50: "your bags are full",
  51: "your bank is full",
  52: "the vendor is sold out of that",
  53: "that bag is full",
  54: "no item was found at that address",
  55: "that item does not stack",
  56: "that bag is full",
  57: "the vendor is sold out of that",
  58: "that object is busy",
  60: "not while in combat",
  61: "not while disarmed",
  62: "that bag is full",
  63: "your rank is too low",
  64: "your reputation is too low",
  65: "you are carrying too many special bags of that kind",
  66: "you cannot loot that right now",
  67: "you can have only one of that unique-equipped item",
  68: "the vendor wants items you do not have",
  69: "you do not have enough honor points",
  70: "you do not have enough arena points",
  71: "you already have as many of that gem socketed as are allowed",
  72: "a soulbound item cannot be mailed",
  73: "a stack cannot be split while prospecting",
  75: "you already have as many of that gem socketed on equipped items as are allowed",
  76: "you already have that unique-equipped gem socketed",
  77: "you cannot carry that much gold",
  78: "not during an arena match",
  79: "that item cannot be traded",
  80: "your personal arena rating is too low",
  81: "equipping that will bind it to you — confirmation is needed",
  82: "that item belongs to another character",
  84: "you already have as many items of that category as are allowed",
  85: "you already have as many gems of that category socketed as are allowed",
  86: "the item's scaling level would be exceeded",
  87: "your level is too low to buy that",
  88: "it needs a talent you have not taken",
  89: "you already have as many items of that category equipped as are allowed",
};

/**
 * The client-visible sentence for an `InventoryResult` code, or `undefined`
 * for one the SDK does not name. Exported because the runner names the code on
 * the raw `SMSG_INVENTORY_CHANGE_FAILURE` event line too, and the two must read
 * from one table.
 */
export function inventoryResultText(result: number): string | undefined {
  return INVENTORY_RESULT_TEXT[result];
}

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
 * The outcome of buying one spell, as a value: `buy_failed` is the
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

export interface TalentTreeOptions {
  /** How long to wait for the module's WB_TALENT_TREE answer. Default 10000. */
  timeout?: number;
}

export interface ResetTalentsOptions {
  /** How long to wait for each server answer (menu, confirm, talents). Default 10000. */
  timeout?: number;
  /**
   * Which gossip option is the respec. Default: the option whose text
   * mentions "unlearn" (the stock "I wish to unlearn my talents."). A visible
   * text (exact or unique substring) or an `optionId` from `state.lastGossip(guid)`.
   */
  option?: string | number;
}

/** Why a pet call sent nothing. Each is a state of the world the SDK can see before dispatching, never a server verdict. */
export type PetRefusalStatus = "no_pet" | "unknown_spell" | "ambiguous_spell" | "passive_spell" | "unknown_reaction";

/**
 * The outcome of a pet order. `sent` is an ack — the pet action bar has no
 * "done" packet, so the verdict is `SMSG_PET_ACTION_FEEDBACK` /
 * `SMSG_PET_CAST_FAILED` on the stream and `state.pet()` afterwards. The
 * refusals are the SDK declining to act on what it can already see (no pet,
 * a spell the pet does not have), each with a hint the harness delivers.
 */
export type PetActionResult =
  | { readonly ok: true; readonly status: "sent"; readonly ack: ActionResponse }
  | { readonly ok: false; readonly status: PetRefusalStatus; readonly hint: string };

/** The outcome of `inviteToGroup`: the server's `SMSG_PARTY_COMMAND_RESULT` on the invite. */
export type InviteResult = { ok: true; status: "invited"; name: string } | { ok: false; status: "refused"; name: string; result: number; hint: string };

export interface GroupOptions {
  /** How long to wait for the server's answer. Default 10000. */
  timeout?: number;
}

export interface MailOptions {
  /** How long to wait for the server's answer. Default 10000. */
  timeout?: number;
}

/** Why `lootRoll` sent nothing: what the SDK can see before dispatching, never a server verdict. */
export type LootRollRefusalStatus = "no_pending_roll" | "ambiguous_roll" | "roll_not_allowed";

/**
 * The outcome of `lootRoll` (item 102). `rolled` is the server's echo of the
 * counted vote (`SMSG_LOOT_ROLL` for this character). That first echo is only
 * an acknowledgement of the button — `Group::CountRollVote` sends it with
 * rollNumber 0 for need and 128 for pass / greed / disenchant, and with
 * rollType 0 (pass) for a need — so `roll` is undefined on it and `choice` is
 * the button that was pressed, not a re-read of the wire. The number actually
 * rolled arrives later, in the per-voter `SMSG_LOOT_ROLL` batch
 * `Group::CountTheRoll` broadcasts once every vote is in, alongside
 * `SMSG_LOOT_ROLL_WON` (or `SMSG_LOOT_ALL_PASSED`). A won item is stored by
 * `CountTheRoll` with no `SMSG_ITEM_PUSH_RESULT` at all: it shows up only as
 * the object update `state.bag()` folds, so poll the bag rather than waiting
 * for a push.
 */
export type LootRollResult =
  | {
      readonly ok: true;
      readonly status: "rolled";
      readonly rollGuid: string;
      readonly choice: RollChoice;
      readonly roll: number | undefined;
      readonly item: { readonly itemId: number; readonly name: string | undefined };
    }
  | { readonly ok: false; readonly status: LootRollRefusalStatus; readonly hint: string };

export interface LootRollOptions {
  /** How long to wait for the server to echo the vote. Default 10000. */
  timeout?: number;
}

/**
 * The outcome of `readItem` (item 103). `read` carries the pages in order and
 * `text` as one string. `no_item` is a bag address or name that holds
 * nothing; `not_readable` is the server's (or the template's) word that there
 * is nothing to read on it.
 */
export type ReadItemResult =
  | {
      readonly ok: true;
      readonly status: "read";
      readonly item: { readonly bag: number; readonly slot: number; readonly guid: string; readonly itemId: number | undefined; readonly name: string | undefined };
      readonly pages: readonly string[];
      readonly text: string;
    }
  | { readonly ok: false; readonly status: "no_item" | "not_readable"; readonly hint: string };

export interface ReadItemOptions {
  /** How long to wait for each server answer (the read ack, the pages). Default 10000. */
  timeout?: number;
}

/** What `sendMail` attaches: carried items by the `bag`/`slot` `state.bag()` lists them under, or by name. */
export interface SendMailOptions extends MailOptions {
  /** Copper to enclose. */
  money?: number;
  /** Cash-on-delivery the recipient pays to take the items. */
  cod?: number;
  /** Up to 12 carried items, each `{ bag, slot }` or the item's name (exact, else a unique substring). */
  items?: readonly ({ bag: number; slot: number } | string)[];
}

/** The outcome of a mail action, as the server's `SMSG_SEND_MAIL_RESULT` said it. */
export type MailResult =
  | { ok: true; status: "sent" | "money_taken" | "item_taken" | "deleted" | "returned"; mailId: number }
  | { ok: false; status: "refused"; mailId: number; result: number; inventoryResult: number | undefined; hint: string }
  /** The SDK sent nothing: no mailbox frame is open, or the item named is not carried. */
  | { ok: false; status: "no_mailbox" | "no_item"; hint: string };

export interface BankOptions {
  /** How long to wait for the item to move (or the server to refuse). Default 10000. */
  timeout?: number;
}

/** The outcome of `bankDeposit` / `bankWithdraw`: the item's new place, or the server's `SMSG_INVENTORY_CHANGE_FAILURE`. */
export type BankMoveResult =
  | { ok: true; status: "moved"; guid: string; bag: number; slot: number }
  | { ok: false; status: "refused"; guid: string; result: number; hint: string }
  /** The SDK sent nothing: no bank frame is open, or nothing answers to the bag/slot or name given. */
  | { ok: false; status: "no_bank" | "no_item"; hint: string };

/**
 * The outcome of `resetTalents`, as a value. `reset` is the server's
 * `SMSG_TALENTS_INFO` after the confirm with every rank gone and the points
 * back (`cost` is what the trainer charged, from its confirm). `refused` is
 * the handler's guid-0 confirm: nothing to reset, or not enough money.
 */
export type ResetTalentsResult =
  | {
      readonly ok: true;
      readonly status: "reset";
      readonly cost: number;
      readonly talents: TalentState;
    }
  | {
      readonly ok: false;
      readonly status: "refused";
      readonly cost: number;
      readonly hint: string;
    }
  /** The SDK sent no confirm: the menu that opened has no unlearn option to choose. */
  | {
      readonly ok: false;
      readonly status: "no_option";
      readonly hint: string;
    };

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
 * The outcome of one equip, as a value. The server answers
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
    }
  /** Nothing was sent: the name given matches nothing carried, or matches more than one thing. */
  | {
      readonly ok: false;
      readonly status: "no_item";
      readonly hint: string;
    };

/**
 * The outcome of `learnTalent`, as a value. The server always
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
    }
  /** Nothing was sent: the name given is not one talent of this class's tree, or the tree has not been read yet. */
  | {
      readonly ok: false;
      readonly status: "unknown_talent" | "ambiguous_talent" | "no_tree";
      readonly hint: string;
    };

export interface TaxiOptions {
  /** How long to wait for the server's window or verdict. Default 10000. */
  timeout?: number;
}

/**
 * The outcome of `activateTaxi`, as a value: the server's
 * `SMSG_ACTIVATETAXIREPLY`. `accepted` means the flight is starting — the
 * ride itself is `state.self.taxiFlight` turning true, and the landing is it
 * turning false again; no packet says "landed", so nothing here does either.
 * `refused` carries the server's reply code and the client-visible sentence
 * for it.
 */
export type ActivateTaxiResult =
  | {
      readonly ok: true;
      readonly status: "accepted";
      readonly reply: 0;
      readonly from: TaxiNodeRef;
      readonly to: TaxiNodeRef;
    }
  | {
      readonly ok: false;
      readonly status: "refused";
      /** Raw `ActivateTaxiReply` code (1..12). */
      readonly reply: number;
      readonly from: TaxiNodeRef;
      readonly to: TaxiNodeRef;
      readonly hint: string;
    };

export interface BindOptions {
  /** How long to wait for each of the three server answers (menu, confirm, bind point). Default 10000. */
  timeout?: number;
  /**
   * Which gossip option is the bind. Default: the option whose text contains
   * "home" (the stock "Make this inn your home."). A visible text (exact or
   * unique substring) or an `optionId` from `state.lastGossip(guid)`.
   */
  option?: string | number;
}

/**
 * The outcome of `bindAtInnkeeper`, as a value. `bound` is the server's
 * `SMSG_BINDPOINTUPDATE` after the confirm — the new hearthstone destination,
 * also on `state.self.bindPoint`. Every other way the sequence can end is
 * an absence of a server answer and throws (`EventTimeoutError`), or an SDK
 * refusal to act (no such option on the menu) and throws too.
 */
export type BindResult = {
  readonly ok: true;
  readonly status: "bound";
  readonly bindPoint: BindPoint;
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
 * The outcome of one corpse reclaim, as a value.
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
  /** One entry per payload field where a non-exact name resolved to a guid. */
  readonly resolved?: readonly ResolvedRef[];
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

  /** The operator-bound game account. Authoritative when set; see ConnectOptions.account. */
  private readonly boundAccount: string | undefined;
  private readonly secret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly defaultSignal: (() => AbortSignal | undefined) | undefined;
  private readonly deadlineAt: (() => number | undefined) | undefined;

  /** Hint-bearing failures since the last drain, by `action:status`. See `ActionHint`. */
  private readonly actionHints = new Map<string, ActionHint>();

  constructor(options: ConnectOptions) {
    this.token = options.token;
    this.boundAccount = options.account;
    this.secret = options.secret;
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
      secret: options.secret,
    });
    this.state = new StateCache(options.state ?? {});
    // Registered before the socket opens, so the cache sees every frame.
    this.events.onAny((event: StreamEvent) => this.state.apply(event));
    this.events.onAny((event: StreamEvent) => this.clientParityQueries(event));
  }

  /**
   * What a *helper* acts on, as a guid: a unit object, the opaque decimal guid
   * string, or the name of something in view (`resolveNamedTarget`) — the
   * three forms a client could reasonably mean. Raw actions keep `guidArg` and
   * take the guid string only: referent selection is what this bench measures,
   * and the SDK still never picks between two matches, it refuses and lists
   * them.
   */
  private targetGuid(target: GuidOrUnit, arg: string): string {
    return this.targetRef(target, arg).guid;
  }

  /**
   * The same resolution, keeping what it took to get there: a name that only
   * matched by substring or by the edit tier comes back with `resolved`, which
   * the helper folds into its result (`withResolved`). A guid, a unit object
   * and a normalised-exact name all resolve with nothing to report — case and
   * whitespace tolerance is always on and tells the caller nothing new.
   */
  private targetRef(target: GuidOrUnit, arg: string): TargetRef {
    if (typeof target === "string" && !GUID_TEXT.test(target.trim())) {
      const hit = resolveNamedTarget(this.state, target, arg);
      return isFuzzy(hit.tier)
        ? { guid: hit.guid, resolved: { input: target, name: hit.name, guid: hit.guid } }
        : { guid: hit.guid };
    }
    return { guid: guidKey(guidOf(target, arg)) };
  }

  /**
   * Run a guid-taking helper against a target given as a guid, a unit or a
   * name, and hand back its own result with `resolved` attached when the name
   * matched non-exactly. One place, so no helper drifts into reporting the
   * fuzz differently (or not at all).
   */
  private byName<T extends object>(
    target: GuidOrUnit,
    arg: string,
    run: (guid: string) => Promise<T>,
  ): Promise<WithResolved<T>> {
    // Deliberately not `async`: a bad referent must still throw where the
    // caller stands, so a non-async method like `setTarget` keeps rejecting
    // an object or a number synchronously as it always has.
    const ref = this.targetRef(target, arg);
    return run(ref.guid).then((out) => withResolved(ref, out));
  }

  /**
   * Record a hint-bearing failure for the harness to deliver. Only the status
   * recipe is kept, not the call-specific notes `withNotes` folds in (a budget
   * or timeout remark is already in the result and would vary per call).
   */
  private noteActionHint(action: string, status: string, hint: string | undefined, point?: { x: number; y: number; z: number }): void {
    if (hint === undefined || hint.length === 0) return;
    const key = `${action}:${status}`;
    const prev = this.actionHints.get(key);
    if (prev === undefined && this.actionHints.size >= ACTION_HINT_MAX_KEYS) return;
    this.actionHints.set(key, {
      action,
      status,
      count: (prev?.count ?? 0) + 1,
      hint,
      ...(point !== undefined ? { point: { x: point.x, y: point.y, z: point.z } } : {}),
      ts: Date.now(),
    });
  }

  /**
   * Take the recorded hint-bearing failures and clear the tally. Called by the
   * sandbox once per snippet; not part of the model-facing surface.
   */
  drainActionHints(): ActionHint[] {
    const out = [...this.actionHints.values()];
    this.actionHints.clear();
    return out;
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
  setTarget(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "setTarget(guid)", (guid) => this.action({ action: "set_target", guid }));
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
  attackStart(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "attackStart(guid)", (guid) => this.action({ action: "attack_start", guid }));
  }

  /** `CMSG_ATTACKSTOP`. */
  attackStop(): Promise<ActionResponse> {
    return this.action({ action: "attack_stop" });
  }

  /** `CMSG_CAST_SPELL`. No target guid means self/auto-target. */
  castSpell(spellId: number, targetGuid?: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    if (targetGuid === undefined) return this.action({ action: "cast_spell", spellId });
    return this.byName(targetGuid, "castSpell(spellId, targetGuid)", (guid) =>
      this.action({ action: "cast_spell", spellId, targetGuid: guid }),
    );
  }

  /** `CMSG_CANCEL_CAST`. */
  cancelCast(spellId: number): Promise<ActionResponse> {
    return this.action({ action: "cancel_cast", spellId });
  }

  /**
   * `CMSG_GAMEOBJ_USE` — chests, doors, quest objects. Takes the guid string,
   * a unit from `state.units(...)` / `state.closest(...)`, or its name.
   */
  interact(target: GuidOrUnit): Promise<WithResolved<InteractResult>> {
    return this.byName(target, "interact(guid)", async (guid) => {
      if (this.isChest(guid)) {
        return {
          ok: false,
          status: "chest",
          hint:
            "this is a chest: the server ignores CMSG_GAMEOBJ_USE on chests (a client opens one by casting its " +
            "lock's Opening spell at it) — call lootCorpse(guid) instead, which casts, waits for the window and empties it",
        };
      }
      return this.action({ action: "interact", guid });
    });
  }

  /** Whether the state cache knows `guid` as a chest-type game object. */
  private isChest(guid: string): boolean {
    return this.state.units({ type: "gameObject" }).some((u) => u.guid === guid && u.goType === "chest");
  }

  /**
   * Open a chest the way a client does: cast the lock's Opening spell at it
   * (see `CHEST_OPEN_SPELLS`) and wait for the loot window the server sends
   * on the cast landing. Returns the window event, or the refusal that ended
   * the ladder. `since` bounds the events considered.
   */
  private async openChest(
    guid: string,
    since: number | undefined,
    timeout: number,
  ): Promise<{ window: StreamEvent } | { refused: number }> {
    let from = since;
    let lastResult = SPELL_FAILED_BAD_TARGETS;
    for (const spellId of CHEST_OPEN_SPELLS) {
      await this.castSpell(spellId, guid);
      const verdict = await this.waitEvent(
        (e) =>
          (from === undefined || e.seq > from) &&
          !isDecodeError(e.data) &&
          ((isEvent(e, "SMSG_LOOT_RESPONSE") && guidKey((e.data as LootResponseData).guid) === guid) ||
            (isEvent(e, "SMSG_CAST_FAILED") && (e.data as CastFailedData).spellId === spellId) ||
            (isEvent(e, "SMSG_SPELL_FAILURE") && (e.data as SpellFailureData).spellId === spellId)),
        { timeout, description: `the loot window or the cast verdict for Opening (${spellId}) on ${guid}` },
      );
      if (verdict.opcode === "SMSG_LOOT_RESPONSE") return { window: verdict };
      lastResult = (verdict.data as CastFailedData | SpellFailureData).result;
      from = verdict.seq;
      // Only "wrong lock type" moves the ladder on; anything else (moving,
      // interrupted, too far) would fail the next spell the same way.
      if (verdict.opcode !== "SMSG_CAST_FAILED" || lastResult !== SPELL_FAILED_BAD_TARGETS) break;
    }
    return { refused: lastResult };
  }

  /** `CMSG_GOSSIP_HELLO` — opens the NPC menu (`SMSG_GOSSIP_MESSAGE`). */
  gossipHello(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "gossipHello(guid)", (guid) => this.action({ action: "gossip_hello", guid }));
  }

  /**
   * `CMSG_GOSSIP_SELECT_OPTION`; ids come from `SMSG_GOSSIP_MESSAGE`.
   *
   * Two forms. The raw form takes the numeric `menuId` and `optionId` straight
   * off the packet. The convenience form takes just an `option` — an option's
   * visible `text` (case-insensitive exact, or a unique substring) or its
   * `optionId` — and resolves it against the menu last observed open for this
   * NPC (`state.lastGossip(guid)`), filling in the `menuId` from there. The
   * guid itself takes the same three forms every other referent does — a guid,
   * a unit, or a name in view.
   *
   * The convenience form throws (nothing is dispatched) when no menu is open
   * for the guid, when the text matches no option or more than one, or when a
   * numeric option is not on the menu — every rejection lists the options so
   * the next call is obvious. A menu is only ever read from the
   * `SMSG_GOSSIP_MESSAGE`/`SMSG_GOSSIP_COMPLETE` fold; the server is not
   * queried.
   */
  gossipSelect(guid: GuidOrUnit, option: string | number): Promise<WithResolved<ActionResponse>>;
  gossipSelect(guid: GuidOrUnit, menuId: number, optionId: number): Promise<WithResolved<ActionResponse>>;
  async gossipSelect(guid: GuidOrUnit, a: string | number, b?: number): Promise<WithResolved<ActionResponse>> {
    return this.byName(guid, "gossipSelect(guid, ...)", (id) => {
      if (b !== undefined) {
        // Raw form: caller supplied both menuId and optionId.
        return this.action({ action: "gossip_select", guid: id, menuId: a as number, optionId: b });
      }
      // Convenience form: resolve against the last observed menu. `async`, so a
      // bad option is a rejected promise like every other helper, not a
      // synchronous throw.
      const { menuId, optionId } = this.resolveGossipOption(id, a);
      return this.action({ action: "gossip_select", guid: id, menuId, optionId });
    });
  }

  /**
   * `CMSG_QUESTGIVER_HELLO`. The answer is `SMSG_QUESTGIVER_QUEST_LIST` — or,
   * on a gossip-flagged NPC, an `SMSG_GOSSIP_MESSAGE` with the quests embedded.
   * `acceptQuestFrom` handles both shapes.
   */
  questList(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "questList(guid)", (guid) => this.action({ action: "quest_list", guid }));
  }

  /** `CMSG_QUESTGIVER_QUERY_QUEST` — quest text via `..._QUEST_DETAILS`. */
  questDetails(target: GuidOrUnit, questId: number): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "questDetails(guid, questId)", (guid) =>
      this.action({ action: "quest_details", guid, questId }),
    );
  }

  /** `CMSG_QUESTGIVER_ACCEPT_QUEST`. */
  questAccept(target: GuidOrUnit, questId: number): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "questAccept(guid, questId)", (guid) =>
      this.action({ action: "quest_accept", guid, questId }),
    );
  }

  /** `CMSG_QUESTGIVER_COMPLETE_QUEST` — answered by REQUEST_ITEMS or OFFER_REWARD. */
  questComplete(target: GuidOrUnit, questId: number): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "questComplete(guid, questId)", (guid) =>
      this.action({ action: "quest_complete", guid, questId }),
    );
  }

  /** `CMSG_QUESTGIVER_CHOOSE_REWARD`; index into `choiceRewards`, 0 when none. */
  questChooseReward(target: GuidOrUnit, questId: number, rewardIndex = 0): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "questChooseReward(guid, ...)", (guid) =>
      this.action({ action: "quest_choose_reward", guid, questId, rewardIndex }),
    );
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
  questGiverStatusQuery(target?: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    if (target === undefined) return this.action({ action: "questgiver_status_multiple_query" });
    return this.byName(target, "questGiverStatusQuery(guid?)", (guid) =>
      this.action({ action: "questgiver_status_query", guid }),
    );
  }

  /** `CMSG_QUESTLOG_REMOVE_QUEST`; the module maps quest id to log slot. */
  questAbandon(questId: number): Promise<ActionResponse> {
    return this.action({ action: "quest_abandon", questId });
  }

  /** `CMSG_LOOT` — opens the loot window (`SMSG_LOOT_RESPONSE`). */
  loot(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "loot(guid)", (guid) => this.action({ action: "loot", guid }));
  }

  /**
   * `CMSG_LOOT` plus the auto-loot follow-ups the client sends once the window
   * arrives. Fire-and-forget: prefer `lootCorpse`, which waits.
   */
  lootAll(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "lootAll(guid)", (guid) => this.action({ action: "loot_all", guid }));
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
  lootRelease(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "lootRelease(guid)", (guid) => this.action({ action: "loot_release", guid }));
  }

  /** `CMSG_LIST_INVENTORY` — `SMSG_LIST_INVENTORY` follows. */
  vendorList(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "vendorList(guid)", (guid) => this.action({ action: "vendor_list", guid }));
  }

  /** `CMSG_BUY_ITEM`; `slot` is the 1-based vendor slot. */
  buyItem(target: GuidOrUnit, itemId: number, slot: number, count?: number): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "buyItem(guid, ...)", (guid) =>
      this.action({ action: "buy_item", guid, itemId, slot, count }),
    );
  }

  /** `CMSG_SELL_ITEM`; omit `count` to sell the whole stack. */
  sellItem(target: GuidOrUnit, itemGuid: GuidArg, count?: number): Promise<WithResolved<ActionResponse>> {
    // The vendor is a unit in view and takes a name; `itemGuid` is an item's
    // own guid, which is not in that namespace — there is no name-to-item-guid
    // resolver, so it stays the strict guid string.
    const item = guidArg(itemGuid, "sellItem(..., itemGuid)");
    return this.byName(target, "sellItem(guid, ...)", (guid) =>
      this.action({ action: "sell_item", guid, itemGuid: item, count }),
    );
  }

  /** `CMSG_REPAIR_ITEM` with item guid 0 — repair everything. */
  repairAll(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "repairAll(guid)", (guid) => this.action({ action: "repair_all", guid }));
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
   * not a throw: it is the game answering.
   */
  async equipItem(bagOrName: number | string, slot?: number | EquipOptions, options: EquipOptions = {}): Promise<WithResolved<EquipItemResult>> {
    // A name in place of the bag leaves the second argument free, so
    // `equipItem("Bronze Axe", { timeout })` has exactly one reading: shift it.
    if (slot !== null && typeof slot === "object") {
      options = slot;
      slot = undefined;
    }
    const where = resolveItemSlot(this.state.bag().items, bagOrName, slot, "equipItem(bagOrName, slot?)", "state.bag()");
    if ("refusal" in where) {
      this.noteActionHint("equipItem", "no_item", where.refusal);
      return { ok: false, status: "no_item", hint: where.refusal };
    }
    const { bag, slot: at } = where;
    slot = at;
    const before = this.state.bag().items.find((i) => i.bag === bag && i.slot === slot);
    const guid = before?.guid;
    // Every answer this call can give spreads `item`, so a name that only
    // matched by substring or by a typo says so in all of them.
    const item = { bag, slot, itemId: before?.itemId, name: before?.name, ...(where.resolved === undefined ? {} : { resolved: where.resolved }) };
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
      const named = inventoryResultText(failure.result);
      const level = failure.requiredLevel;
      const hint =
        `the server refused to equip ${item.name ?? `item ${item.itemId ?? "?"}`} ` +
        `(InventoryResult ${failure.result}${named ? `: ${named}` : ""}` +
        `${level === undefined ? "" : `, needs level ${level}`}) — the item is still at bag ${bag} slot ${slot}`;
      // The hint rides inside the result, and a snippet that ignores the return
      // value sees nothing — so it is recorded for the harness too, exactly as
      // moveTo and activateTaxi record theirs.
      this.noteActionHint("equipItem", "not_equipped", hint);
      return {
        ok: false,
        status: "not_equipped",
        ...item,
        reason: failure.result,
        requiredLevel: level,
        hint,
      };
    }
    if (leftBackpack()) return { ok: true, status: "equipped", ...item, equippedSlot: undefined };
    const unconfirmed =
      guid === undefined
        ? `nothing was observed at bag ${bag} slot ${slot} before the equip, so neither outcome could be ` +
          `confirmed — re-read state.bag() and check whether the item moved`
        : `no equipment-slot update and no refusal arrived for bag ${bag} slot ${slot} — re-read ` +
          `state.bag() to see whether the item moved before trying again`;
    this.noteActionHint("equipItem", "unconfirmed", unconfirmed);
    return { ok: false, status: "unconfirmed", ...item, hint: unconfirmed };
  }

  /**
   * `CMSG_USE_ITEM`; the module fills the item guid and its on-use spell.
   * The item is the `bag`/`slot` pair `state.bag()` lists, or its name in
   * place of `bag` (the shared `resolveName`) — a name that names nothing
   * carried, or two things, throws with what is carried.
   *
   * A quest-start item with no on-use spell (a found letter, the Tome of
   * Divinity) is not a spell cast: the module right-clicks it the way a
   * client does (`CMSG_QUESTGIVER_QUERY_QUEST` with the item's own guid as the
   * questgiver) and the server offers the quest with
   * `SMSG_QUESTGIVER_QUEST_DETAILS`. When the item's tooltip says it starts a
   * quest, this waits for that offer and reports it as `questOffer`; taking
   * it is `acceptQuestFrom(questOffer.itemGuid, questOffer.questId)` — the
   * item guid stands where an NPC guid would (2026-08-30, the Tome of
   * Divinity defect).
   */
  async useItem(bagOrName: number | string, slot?: number | GuidOrUnit, targetGuid?: GuidOrUnit, options: QuestOptions = {}): Promise<WithResolved<UseItemResult>> {
    // `useItem("Healing Potion", guid)`: with a name, the second argument
    // cannot be a slot, so the guid it holds is the target.
    if (typeof bagOrName === "string" && slot !== undefined) {
      targetGuid = slot as GuidOrUnit;
      slot = undefined;
    }
    const where = resolveItemSlot(this.state.bag().items, bagOrName, slot as number | undefined, "useItem(bagOrName, slot?)", "state.bag()");
    if ("refusal" in where) throw new TypeError(where.refusal);
    const { bag } = where;
    slot = where.slot;
    const item = this.state.bag().items.find((i) => i.bag === bag && i.slot === slot);
    const startQuest = questStartedBy(this.state, item);
    const sinceSeq = this.events.recent(1)[0]?.seq;
    let ack: ActionResponse;
    try {
      ack = await this.action({
        action: "use_item",
        bag,
        slot,
        targetGuid: targetGuid === undefined ? undefined : this.targetGuid(targetGuid, "useItem(..., targetGuid)"),
      });
    } catch (err) {
      // A bare item_not_usable cannot be told apart from "the slot shifted
      // under me" (roster-sonnet-20260822); say what the local cache thinks is
      // at that address so the model does not have to guess.
      if (err instanceof WrathRequestError && err.code === "item_not_usable") {
        const label = item === undefined ? "" : `${item.name ?? `item ${item.itemId ?? "?"}`}${item.count !== undefined ? ` x${item.count}` : ""}`;
        err.message += item === undefined
          ? ` — local state sees nothing at bag ${bag} slot ${slot}; slots shift after looting/selling, re-read state.bag()`
          : startQuest !== undefined
            ? ` — local state sees ${label} at bag ${bag} slot ${slot}, and its tooltip says it starts quest ${startQuest}: this module build predates quest-start items (it needs the 2026-08-30 build); until then the quest cannot be started from the item`
            : ` — local state sees ${label} at bag ${bag} slot ${slot}: that item has no on-use spell and no quest to start (per its tooltip, state.items)`;
      }
      throw err;
    }
    if (startQuest === undefined || item === undefined) return withResolved(where, ack);
    const offer = await this.waitEvent(
      (e) =>
        isEvent(e, "SMSG_QUESTGIVER_QUEST_DETAILS") &&
        !isDecodeError(e.data) &&
        (e.data as QuestGiverQuestDetailsData).questId === startQuest &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      {
        timeout: options.timeout ?? 10_000,
        description:
          `the quest offer (SMSG_QUESTGIVER_QUEST_DETAILS for quest ${startQuest}) from ${item.name ?? `item ${item.itemId}`} — ` +
          "the server stays silent when the quest cannot be taken (already in the log or done, level or race gate); check state.quest(id)",
      },
    );
    const data = offer.data as QuestGiverQuestDetailsData;
    return withResolved(where, { ...ack, questOffer: { questId: data.questId, title: data.title, itemGuid: item.guid } });
  }

  /**
   * `CMSG_TRAINER_LIST` — ask a trainer what it teaches (`SMSG_TRAINER_LIST`).
   * Prefer `trainerList`, which waits for the answer.
   */
  trainerListAsync(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "trainerList(npcGuid)", (guid) => this.action({ action: "trainer_list", guid }));
  }

  /**
   * `CMSG_TRAINER_BUY_SPELL` — learn one spell, paid for out of the
   * character's own money. Prefer `buySpell`, which waits for the verdict.
   */
  trainerBuySpellAsync(target: GuidOrUnit, spellId: number): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "buySpell(npcGuid, spellId)", (guid) =>
      this.action({ action: "trainer_buy_spell", guid, spellId }),
    );
  }

  /**
   * `CMSG_DESTROYITEM`; omit `count` to destroy the whole stack. Takes the
   * `bag`/`slot` pair `state.bag()` lists, or the item's name in place of
   * `bag` (the shared `resolveName`).
   */
  destroyItem(bagOrName: number | string, slot?: number, count?: number): Promise<WithResolved<ActionResponse>> {
    // `destroyItem("Copper Ore", 5)`: with a name, the second argument cannot
    // be a slot, so the number it holds is the count.
    if (typeof bagOrName === "string" && slot !== undefined) {
      count = slot;
      slot = undefined;
    }
    const where = resolveItemSlot(this.state.bag().items, bagOrName, slot, "destroyItem(bagOrName, slot?)", "state.bag()");
    if ("refusal" in where) throw new TypeError(where.refusal);
    return this.action({ action: "destroy_item", bag: where.bag, slot: where.slot, count }).then((ack) => withResolved(where, ack));
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
  spiritHealerActivate(target: GuidOrUnit): Promise<WithResolved<ActionResponse>> {
    return this.byName(target, "spiritHealerActivate(guid)", (guid) =>
      this.action({ action: "spirit_healer_activate", guid }),
    );
  }

  /**
   * Ask the module for the class talent tree (the `talent_tree` action); the
   * answer is the `WB_TALENT_TREE` event. Prefer `queryTalentTree`, which
   * waits for it and returns `state.talentTree()`.
   */
  talentTreeAsync(): Promise<ActionResponse> {
    return this.action({ action: "talent_tree" });
  }

  /**
   * The character's class talent frame as a client draws it from its own
   * Talent.dbc / TalentTab.dbc: per tab, each talent's id, name, grid
   * position, max rank, rank spells and prerequisite, with `pointsSpent`
   * merged from the last `SMSG_TALENTS_INFO` and the unspent points. The
   * tree is static for a class, so one call per session is enough;
   * `state.talentTree()` stays current as points are spent.
   */
  async queryTalentTree(options: TalentTreeOptions = {}): Promise<TalentTree> {
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.talentTreeAsync();
    await this.waitEvent(
      (e) => isEvent(e, "WB_TALENT_TREE") && !isDecodeError(e.data) && (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout: options.timeout ?? 10_000, description: "the WB_TALENT_TREE answering talent_tree" },
    );
    const tree = this.state.talentTree();
    if (tree === undefined) throw new Error("queryTalentTree: WB_TALENT_TREE arrived but the state cache holds no tree");
    return tree;
  }

  /**
   * Unlearn every talent at a class trainer, the way a client does it: open
   * the trainer's gossip menu, choose the unlearn option ("I wish to unlearn
   * my talents." by default), answer the server's `MSG_TALENT_WIPE_CONFIRM`
   * (which names the cost) by echoing it, and read the verdict off the
   * `SMSG_TALENTS_INFO` that follows. The cost is charged by the server and
   * shows on `state.money`; it rises with every reset (the client's
   * "next reset will cost" is not on the wire).
   *
   * Throws (nothing further dispatched) when the menu has no such option.
   * The refusal — nothing to reset, or not enough money — is a value: the
   * handler answers the echo with a guid-0 confirm and nothing else.
   */
  async resetTalents(npcGuid: GuidOrUnit, options: ResetTalentsOptions = {}): Promise<WithResolved<ResetTalentsResult>> {
    return this.byName(npcGuid, "resetTalents(npcGuid)", async (id) => {
      const timeout = options.timeout ?? 10_000;
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.gossipHello(id);
      const menuEvent = await this.waitEvent(
        (e) =>
          isEvent(e, "SMSG_GOSSIP_MESSAGE") &&
          !isDecodeError(e.data) &&
          guidKey((e.data as GossipMessageData).guid) === id &&
          (sinceSeq === undefined || e.seq > sinceSeq),
        { timeout, description: `the trainer's menu (SMSG_GOSSIP_MESSAGE) for ${id}` },
      );
      const menu = menuEvent.data as GossipMessageData;
      let choice: { menuId: number; optionId: number };
      if (options.option !== undefined) {
        choice = this.resolveGossipOption(id, options.option);
      } else {
        const unlearn = menu.options.filter((o) => /unlearn/i.test(o.text));
        if (unlearn.length !== 1) {
          const hint =
            `the menu that opened has ${unlearn.length === 0 ? "no" : unlearn.length} option(s) mentioning "unlearn" — ` +
            `a respec needs a class trainer for your own class (state.units({ role: "trainer" })). Pass { option } to ` +
            `pick one of: ` + menu.options.map((o) => `${o.optionId}:${JSON.stringify(o.text)}`).join(", ");
          this.noteActionHint("resetTalents", "no_option", hint);
          return { ok: false, status: "no_option", hint };
        }
        choice = { menuId: menu.menuId, optionId: unlearn[0]!.optionId };
      }
      await this.gossipSelect(id, choice.menuId, choice.optionId);
      const isConfirm = (e: StreamEvent) => isEvent(e, "MSG_TALENT_WIPE_CONFIRM") && !isDecodeError(e.data);
      const confirm = await this.waitEvent((e) => isConfirm(e) && e.seq > menuEvent.seq, {
        timeout,
        description: `the trainer's confirm (MSG_TALENT_WIPE_CONFIRM) from ${id}`,
      });
      const ask = confirm.data as TalentWipeConfirmData;
      if (ask.nothingToReset) {
        const hint = "the trainer offered no reset: there are no talents to unlearn (state.talents().talents is empty)";
        this.noteActionHint("resetTalents", "refused", hint);
        return { ok: false, status: "refused", cost: 0, hint };
      }
      await this.raw("MSG_TALENT_WIPE_CONFIRM", [{ guid: id }]);
      const verdict = await this.waitEvent(
        (e) =>
          e.seq > confirm.seq &&
          ((isEvent(e, "SMSG_TALENTS_INFO") && !isDecodeError(e.data) && !(e.data as TalentsInfoData).pet) || isConfirm(e)),
        { timeout, description: `the SMSG_TALENTS_INFO (or a refusal) after confirming the reset with ${id}` },
      );
      if (isConfirm(verdict)) {
        const hint =
          `the server refused the reset (cost ${ask.cost} copper): nothing to unlearn, or not enough money ` +
          `(state.money is ${this.state.money?.value ?? "unobserved"})`;
        this.noteActionHint("resetTalents", "refused", hint);
        return { ok: false, status: "refused", cost: ask.cost, hint };
      }
      const talents = this.state.talents();
      if (talents === undefined) throw new Error("resetTalents: SMSG_TALENTS_INFO arrived but the state cache holds no talent state");
      return { ok: true, status: "reset", cost: ask.cost, talents };
    });
  }

  // ------------------------------------------------------------------ pets (item 98)

  /**
   * The pet the control bar is for, or the refusal to send anything. "There is
   * no pet" is a state of the world, not a caller mistake, so it is a value
   * with a hint the harness delivers — the same shape as `moveTo`'s
   * `unknown_target`.
   */
  private petGuidOrRefuse(what: string): { guid: string } | { refusal: PetActionResult } {
    const pet = this.state.pet();
    if (pet !== undefined) return { guid: pet.guid };
    return { refusal: this.petRefusal(what, "no_pet",
      `there is no pet (state.pet() is undefined) — summon one first (a warlock's Summon Imp, a hunter's Call Pet) ` +
      `and wait for its control bar, SMSG_PET_SPELLS`) };
  }

  /** Record a pet refusal on the harness channel and return it as the call's value. */
  private petRefusal(action: string, status: PetRefusalStatus, hint: string): PetActionResult {
    this.noteActionHint(action, status, hint);
    return { ok: false, status, hint };
  }

  /** `CMSG_PET_ACTION` with one action-bar button: `data` is `action | type << 24` as the wire packs it. */
  private async petAction(petGuid: string, action: number, type: number, targetGuid: string = "0"): Promise<PetActionResult> {
    const ack = await this.raw("CMSG_PET_ACTION", [{ guid: petGuid }, { u32: ((action & 0x00ffffff) | (type << 24)) >>> 0 }, { guid: targetGuid }]);
    return { ok: true, status: "sent", ack };
  }

  /**
   * Order the pet to attack a unit (the "Attack" button: `CMSG_PET_ACTION`
   * with `COMMAND_ATTACK`). `sent` is an ack, not a verdict: the order landing
   * shows as `SMSG_ATTACKSTART` from the pet's guid at the target (a ranged
   * pet such as an imp with Firebolt autocast off then stands there — no
   * swing follows; `petCast` or autocast is what makes it fight), its swings
   * as `SMSG_ATTACKERSTATEUPDATE` from its guid, a refusal as
   * `SMSG_PET_ACTION_FEEDBACK` (`petFeedbackText`). One refusal is silent: a
   * passive pet (`state.pet().reaction === "passive"`, which is how a fresh
   * summon arrives) ignores the order with no packet at all — the core's
   * PetAI::CanAIAttack answers false for REACT_PASSIVE before the command
   * flag is set. `petReact("defensive")` first.
   */
  async petAttack(target: GuidOrUnit): Promise<WithResolved<PetActionResult>> {
    const pet = this.petGuidOrRefuse("petAttack");
    if ("refusal" in pet) return pet.refusal;
    return this.byName(target, "petAttack(target)", (guid) => this.petAction(pet.guid, 2, 0x07, guid));
  }

  /** Order the pet to follow you (the "Follow" button). Ack-only: no packet answers it, so the ack folds `state.pet().command`. */
  async petFollow(): Promise<PetActionResult> {
    const pet = this.petGuidOrRefuse("petFollow");
    if ("refusal" in pet) return pet.refusal;
    return this.petCommand(pet.guid, 1);
  }

  /** Order the pet to stay where it is (the "Stay" button). Ack-only, folded like `petFollow`. */
  async petStay(): Promise<PetActionResult> {
    const pet = this.petGuidOrRefuse("petStay");
    if ("refusal" in pet) return pet.refusal;
    return this.petCommand(pet.guid, 0);
  }

  /** A follow/stay command button, with the ack folded into the bar's command state. */
  private async petCommand(petGuid: string, command: number): Promise<PetActionResult> {
    const sent = await this.petAction(petGuid, command, 0x07);
    const last = this.events.recent(1)[0];
    this.state.petCommanded({ commandState: command }, last?.seq ?? 0, last?.ts ?? Date.now());
    return sent;
  }

  /**
   * Set the pet's react state: `"passive"`, `"defensive"` or `"aggressive"`
   * (the react buttons), case-insensitive and whitespace-tolerant. Ack-only.
   */
  async petReact(reaction: string): Promise<PetActionResult> {
    const key = String(reaction).trim().toLowerCase();
    const state = ({ passive: 0, defensive: 1, aggressive: 2 } as Record<string, number>)[key];
    if (state === undefined) {
      return this.petRefusal("petReact", "unknown_reaction",
        `${JSON.stringify(reaction)} is not a react state — pass "passive", "defensive" or "aggressive" ` +
        `(the pet's current one is state.pet().reaction)`);
    }
    const pet = this.petGuidOrRefuse("petReact");
    if ("refusal" in pet) return pet.refusal;
    const sent = await this.petAction(pet.guid, state, 0x06);
    // No packet answers a react change; the ack folds it (state.petCommanded).
    const last = this.events.recent(1)[0];
    this.state.petCommanded({ reactState: state }, last?.seq ?? 0, last?.ts ?? Date.now());
    return sent;
  }

  /**
   * Have the pet cast one of its own spells, by name (`state.pet().spells`,
   * case-insensitive exact, else a unique substring) or by id, at a unit or at
   * nothing. The pet frame's button: `CMSG_PET_ACTION` with the spell.
   * Ack-only; a refusal arrives as `SMSG_PET_CAST_FAILED`.
   */
  async petCast(spell: string | number, target?: GuidOrUnit): Promise<WithResolved<PetActionResult>> {
    const pet = this.petGuidOrRefuse("petCast");
    if ("refusal" in pet) return pet.refusal;
    const book = this.state.pet()?.spells ?? [];
    const list = book.map((s) => `${s.spellId}:${JSON.stringify(s.name ?? "?")}`).join(", ");
    let known: PetSpellEntry | undefined;
    if (typeof spell === "number") {
      known = book.find((s) => s.spellId === spell);
    } else {
      const named = book.filter((s) => s.name !== undefined);
      const hit = resolveName(spell, named, (s) => s.name);
      if (hit.kind === "many") {
        return this.petRefusal("petCast", "ambiguous_spell",
          `${JSON.stringify(spell)} matches ${hit.candidates.length} of the pet's spells ` +
          `(${hit.candidates.map((s) => `${s.spellId}:${JSON.stringify(s.name ?? "?")}`).join(", ")}) — pass the exact name or the spell id`);
      }
      known = hit.kind === "one" ? hit.value : undefined;
    }
    if (known === undefined) {
      return this.petRefusal("petCast", "unknown_spell",
        `the pet does not know ${JSON.stringify(spell)} — its book is [${list}] (state.pet().spells)`);
    }
    if (known.passive) {
      return this.petRefusal("petCast", "passive_spell",
        `${known.name ?? known.spellId} is a passive the pet always has, so there is nothing to cast — the ` +
        `castable rows in state.pet().spells are the ones with passive: false`);
    }
    if (target === undefined) return this.petAction(pet.guid, known.spellId, 0x81, "0");
    return this.byName(target, "petCast(spell, target)", (guid) => this.petAction(pet.guid, known.spellId, 0x81, guid));
  }

  /**
   * Send the pet away the way a client does: a hunter casts Dismiss Pet
   * (spell 2641, from the spellbook — the pet stays in the stable and can
   * be called back), any other pet gets the "Abandon" command, which for a
   * warlock's demon or a temporary summon just dismisses it. Ack-only; the
   * bar removal is `SMSG_PET_SPELLS` with `removed: true`, after which
   * `state.pet()` is undefined.
   */
  async petDismiss(): Promise<PetActionResult> {
    const pet = this.petGuidOrRefuse("petDismiss");
    if ("refusal" in pet) return pet.refusal;
    if (this.state.spell(2641) !== undefined) {
      const ack = await this.castSpell(2641);
      return { ok: true, status: "sent", ack };
    }
    return this.petAction(pet.guid, 3, 0x07);
  }

  // ---------------------------------------------------------------- group (item 100)

  /**
   * Invite a player by name (`CMSG_GROUP_INVITE`) and return the server's
   * verdict (`SMSG_PARTY_COMMAND_RESULT` for the invite). `invited` means the
   * invitation was delivered, not accepted: the other side's answer shows up
   * as `SMSG_GROUP_LIST` (accepted, `state.group().inGroup`) or
   * `SMSG_GROUP_DECLINE` (`state.group().lastDecline`).
   */
  async inviteToGroup(name: string, options: GroupOptions = {}): Promise<InviteResult> {
    const who = String(name).trim();
    if (who.length === 0) throw new TypeError("inviteToGroup(name): name is empty — pass the other character's name as the client would type it");
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_GROUP_INVITE", [{ cstring: who }, { u32: 0 }]);
    const event = await this.waitEvent(
      (e) =>
        isEvent(e, "SMSG_PARTY_COMMAND_RESULT") &&
        !isDecodeError(e.data) &&
        (e.data as PartyCommandResultData).operation === 0 &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout: options.timeout ?? 10_000, description: `the SMSG_PARTY_COMMAND_RESULT answering inviteToGroup(${JSON.stringify(who)})` },
    );
    const d = event.data as PartyCommandResultData;
    if (d.result === 0) return { ok: true, status: "invited", name: who };
    const hint = `the server refused the invite: ${partyResultText(d.result)}`;
    this.noteActionHint("inviteToGroup", "refused", hint);
    return { ok: false, status: "refused", name: who, result: d.result, hint };
  }

  /**
   * Accept the pending invitation (`CMSG_GROUP_ACCEPT`) and return the party
   * once the server lists it (`SMSG_GROUP_LIST`). Throws when there is no
   * pending invite in `state.group()`.
   */
  async acceptGroupInvite(options: GroupOptions = {}): Promise<GroupState> {
    if (this.state.group()?.pendingInvite === undefined) {
      throw new Error("acceptGroupInvite(): no invitation is pending (state.group()?.pendingInvite is undefined) — nobody has invited you, or the invite already expired");
    }
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_GROUP_ACCEPT", [{ u32: 0 }]);
    await this.waitEvent(
      (e) => isEvent(e, "SMSG_GROUP_LIST") && !isDecodeError(e.data) && !(e.data as GroupListData).left && (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout: options.timeout ?? 10_000, description: "the SMSG_GROUP_LIST after accepting the invite" },
    );
    return this.state.group()!;
  }

  /** Decline the pending invitation (`CMSG_GROUP_DECLINE`). Ack-only. */
  declineGroupInvite(): Promise<RawActionResponse> {
    return this.raw("CMSG_GROUP_DECLINE", "");
  }

  /**
   * Leave the party (`CMSG_GROUP_DISBAND`, which is also what a leader's
   * "leave" sends) and return the party state once the server confirms
   * (`SMSG_GROUP_LIST` in its left form, or `SMSG_GROUP_DESTROYED`).
   */
  async leaveGroup(options: GroupOptions = {}): Promise<GroupState> {
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_GROUP_DISBAND", "");
    await this.waitEvent(
      (e) =>
        (sinceSeq === undefined || e.seq > sinceSeq) &&
        ((isEvent(e, "SMSG_GROUP_LIST") && !isDecodeError(e.data) && (e.data as GroupListData).left) || isEvent(e, "SMSG_GROUP_DESTROYED")),
      { timeout: options.timeout ?? 10_000, description: "the SMSG_GROUP_LIST / SMSG_GROUP_DESTROYED after leaving the group" },
    );
    return this.state.group()!;
  }

  // ----------------------------------------------------------------- mail (item 100)

  /**
   * The sentence every mail call says when no frame is open. One text, whether
   * it reaches the model as this call's `no_mailbox` value or (for `mailList`,
   * which has no union to answer with) as the thrown message.
   */
  private static readonly NO_MAILBOX =
    'no mailbox frame is open — call openMailbox(mailbox) on a mailbox game object in view ' +
    '(state.units({ type: "gameObject" }) has goType "mailbox") and stay within reach of it';

  /** The mailbox the frame is open on, or `undefined` when none is. */
  private mailboxGuid(): string | undefined {
    return this.state.mailbox()?.guid;
  }

  /** The `no_mailbox` refusal as a value, recorded on the harness channel first. */
  private noMailbox(action: string): MailResult {
    this.noteActionHint(action, "no_mailbox", WrathClient.NO_MAILBOX);
    return { ok: false, status: "no_mailbox", hint: WrathClient.NO_MAILBOX };
  }

  /** The mailbox the frame is open on, or a thrown explanation (for the calls that return state, not a verdict). */
  private mailboxGuidOrThrow(what: string): string {
    const guid = this.mailboxGuid();
    if (guid === undefined) throw new Error(`${what}: ${WrathClient.NO_MAILBOX}`);
    return guid;
  }

  /** Open a mailbox (`CMSG_GAMEOBJ_USE` on it, as a client does) and wait for the frame (`SMSG_SHOW_MAILBOX`). */
  async openMailbox(mailbox: GuidOrUnit, options: MailOptions = {}): Promise<WithResolved<MailboxState>> {
    return this.byName(mailbox, "openMailbox(mailbox)", async (id) => {
      // The core never answers CMSG_GAMEOBJ_USE on a mailbox with
      // SMSG_SHOW_MAILBOX (GameObject::Use has no mailbox case; the client
      // opens the frame locally). What proves the box is open and in reach
      // is the first list: CMSG_GET_MAIL_LIST is refused silently unless
      // Player::GetGameObjectIfCanInteractWith(guid, MAILBOX) holds, and
      // answered with SMSG_MAIL_LIST_RESULT when it does. The use is still
      // sent, as a client does, so the server sees the same sequence.
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.interact(id);
      await this.raw("CMSG_GET_MAIL_LIST", [{ guid: id }]);
      const listed = await this.waitEvent(
        (e) => isEvent(e, "SMSG_MAIL_LIST_RESULT") && !isDecodeError(e.data) && (sinceSeq === undefined || e.seq > sinceSeq),
        { timeout: options.timeout ?? 10_000, description: `the SMSG_MAIL_LIST_RESULT answering openMailbox(${id}) (is it a mailbox, and are you within reach?)` },
      );
      this.state.mailboxOpened(id, listed.seq, listed.ts);
      return this.state.mailbox()!;
    });
  }

  private async waitMailResult(call: string, action: number, sinceSeq: number | undefined, timeout: number, what: string): Promise<MailResult> {
    const event = await this.waitEvent(
      (e) => isEvent(e, "SMSG_SEND_MAIL_RESULT") && !isDecodeError(e.data) && (e.data as SendMailResultData).action === action && (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout, description: `the SMSG_SEND_MAIL_RESULT answering ${what}` },
    );
    const d = event.data as SendMailResultData;
    if (d.result === 0) {
      const status = (["sent", "money_taken", "item_taken", "returned", "deleted"] as const)[action] ?? "sent";
      return { ok: true, status, mailId: d.mailId };
    }
    const hint =
      `the server refused ${what}: ${mailResultText(d.result)}` +
      (d.inventoryResult !== undefined ? ` (${inventoryResultText(d.inventoryResult) ?? `inventory result ${d.inventoryResult}`})` : "");
    this.noteActionHint(call, "refused", hint);
    return { ok: false, status: "refused", mailId: d.mailId, result: d.result, inventoryResult: d.inventoryResult, hint };
  }

  /**
   * Send a mail from the open mailbox (`CMSG_SEND_MAIL`): a recipient name,
   * subject, body, optional money / COD and up to 12 carried items by
   * `bag`/`slot`. Postage (30 copper) plus any money comes out of
   * `state.money`. Returns the server's verdict; items to another account
   * take an hour to deliver, money and text are immediate.
   */
  async sendMail(to: string, subject: string, body: string, options: SendMailOptions = {}): Promise<MailResult> {
    const mailbox = this.mailboxGuid();
    if (mailbox === undefined) return this.noMailbox("sendMail");
    const items = options.items ?? [];
    if (items.length > 12) throw new Error(`sendMail: at most 12 items per mail (got ${items.length})`);
    const carried = this.state.bag().items;
    const fields: RawField[] = [{ guid: mailbox }, { cstring: to.trim() }, { cstring: subject }, { cstring: body }, { u32: 41 }, { u32: 0 }, { u8: items.length }];
    for (const [i, ref] of items.entries()) {
      // Each attachment is a bag/slot pair or a carried item's name, resolved
      // the same way every other item-taking call resolves one.
      const where = typeof ref === "object" ? { bag: ref.bag, slot: ref.slot } : resolveItemSlot(carried, ref, undefined, "sendMail({ items })", "state.bag()");
      if ("refusal" in where) {
        this.noteActionHint("sendMail", "no_item", where.refusal);
        return { ok: false, status: "no_item", hint: where.refusal };
      }
      const row = carried.find((it) => it.bag === where.bag && it.slot === where.slot);
      if (row === undefined) {
        const hint = `nothing is carried at bag ${where.bag} slot ${where.slot} — state.bag().items lists what is, and an attachment can also be given by name`;
        this.noteActionHint("sendMail", "no_item", hint);
        return { ok: false, status: "no_item", hint };
      }
      fields.push({ u8: i }, { guid: row.guid });
    }
    fields.push({ u32: options.money ?? 0 }, { u32: options.cod ?? 0 }, { u64: "0" }, { u8: 0 });
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_SEND_MAIL", fields);
    return this.waitMailResult("sendMail", 0, sinceSeq, options.timeout ?? 10_000, `sendMail(${JSON.stringify(to.trim())})`);
  }

  /** List the inbox at the open mailbox (`CMSG_GET_MAIL_LIST`) and return it (`SMSG_MAIL_LIST_RESULT`, also `state.mailbox()`). */
  async mailList(options: MailOptions = {}): Promise<MailboxState> {
    const mailbox = this.mailboxGuidOrThrow("mailList()");
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_GET_MAIL_LIST", [{ guid: mailbox }]);
    const listed = await this.waitEvent(
      (e) => isEvent(e, "SMSG_MAIL_LIST_RESULT") && !isDecodeError(e.data) && (sinceSeq === undefined || e.seq > sinceSeq),
      { timeout: options.timeout ?? 10_000, description: "the SMSG_MAIL_LIST_RESULT answering mailList()" },
    );
    await this.nameMailSenders(listed.seq, options.timeout ?? 10_000);
    return this.state.mailbox()!;
  }

  /**
   * A player-sent mail carries only the sender's guid, and the module names
   * guids it sees in update blocks, not in mail — the sender is usually
   * logged out. A client asks `CMSG_NAME_QUERY` for each unknown sender as
   * it fills the inbox; so does this, and waits (briefly) for the answers so
   * `mails[].senderName` is joined on return.
   */
  private async nameMailSenders(sinceSeq: number, timeout: number): Promise<void> {
    const unknown = [...new Set((this.state.mailbox()?.mails ?? []).filter((m) => m.senderGuid !== undefined && m.senderName === undefined).map((m) => m.senderGuid!))];
    if (unknown.length === 0) return;
    for (const guid of unknown) await this.raw("CMSG_NAME_QUERY", [{ guid }]);
    await this.waitEvent(
      (e) => e.seq > sinceSeq && (this.state.mailbox()?.mails ?? []).every((m) => m.senderGuid === undefined || m.senderName !== undefined),
      { timeout: Math.min(timeout, 5_000), description: `the SMSG_NAME_QUERY_RESPONSE for the mail sender(s) ${unknown.join(", ")}` },
    ).catch(() => undefined);
  }

  /** Take the money out of a mail (`CMSG_MAIL_TAKE_MONEY`) and return the verdict. */
  async takeMailMoney(mailId: number, options: MailOptions = {}): Promise<MailResult> {
    const mailbox = this.mailboxGuid();
    if (mailbox === undefined) return this.noMailbox("takeMailMoney");
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_MAIL_TAKE_MONEY", [{ guid: mailbox }, { u32: mailId }]);
    return this.waitMailResult("takeMailMoney", 1, sinceSeq, options.timeout ?? 10_000, `takeMailMoney(${mailId})`);
  }

  /** Take one attached item out of a mail (`CMSG_MAIL_TAKE_ITEM`; `itemGuidLow` from `state.mailbox().mails[].items[]`) and return the verdict. */
  async takeMailItem(mailId: number, itemGuidLow: number, options: MailOptions = {}): Promise<MailResult> {
    const mailbox = this.mailboxGuid();
    if (mailbox === undefined) return this.noMailbox("takeMailItem");
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_MAIL_TAKE_ITEM", [{ guid: mailbox }, { u32: mailId }, { u32: itemGuidLow }]);
    return this.waitMailResult("takeMailItem", 2, sinceSeq, options.timeout ?? 10_000, `takeMailItem(${mailId}, ${itemGuidLow})`);
  }

  /** Delete a mail (`CMSG_MAIL_DELETE`) and return the verdict. */
  async deleteMail(mailId: number, options: MailOptions = {}): Promise<MailResult> {
    const mailbox = this.mailboxGuid();
    if (mailbox === undefined) return this.noMailbox("deleteMail");
    const sinceSeq = this.events.recent(1)[0]?.seq;
    // u64 mailbox, u32 mailId, u32 mail template id: HandleMailDelete reads
    // all three, and a body without the third is a ByteBufferException the
    // core skips silently (seen live on the first mail smoke).
    await this.raw("CMSG_MAIL_DELETE", [{ guid: mailbox }, { u32: mailId }, { u32: 0 }]);
    return this.waitMailResult("deleteMail", 4, sinceSeq, options.timeout ?? 10_000, `deleteMail(${mailId})`);
  }

  // ----------------------------------------------------------------- bank (item 100)

  /** Open the bank at a banker (`CMSG_BANKER_ACTIVATE`) and return it once the frame opens (`SMSG_SHOW_BANK`; also `state.bank()`). */
  async openBank(npcGuid: GuidOrUnit, options: BankOptions = {}): Promise<WithResolved<BankContents>> {
    return this.byName(npcGuid, "openBank(npcGuid)", async (id) => {
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.raw("CMSG_BANKER_ACTIVATE", [{ guid: id }]);
      await this.waitEvent(
        (e) => isEvent(e, "SMSG_SHOW_BANK") && !isDecodeError(e.data) && guidKey((e.data as ShowFrameData).guid) === id && (sinceSeq === undefined || e.seq > sinceSeq),
        { timeout: options.timeout ?? 10_000, description: `the SMSG_SHOW_BANK for ${id} (is it a banker — state.units({ role: "banker" }) — within reach?)` },
      );
      return this.state.bank();
    });
  }

  /**
   * The `no_bank` refusal, when the bank frame was never opened. The server
   * answers `CMSG_AUTOBANK_ITEM` with silence in that case, so without this
   * check the call would spend its whole timeout learning nothing.
   */
  private bankClosed(call: string): BankMoveResult | undefined {
    if (this.state.bank().guid !== undefined) return undefined;
    const hint = 'no bank open — walk to a banker (state.units({ role: "banker" })) and call openBank(guid) first';
    this.noteActionHint(call, "no_bank", hint);
    return { ok: false, status: "no_bank", hint };
  }

  /** The `no_item` refusal, recorded on the harness channel first. */
  private noBankItem(call: string, hint: string): BankMoveResult {
    this.noteActionHint(call, "no_item", hint);
    return { ok: false, status: "no_item", hint };
  }

  /**
   * One bank move: send the opcode, then wait for the item's guid to show up
   * where `landed` says, or for the server's `SMSG_INVENTORY_CHANGE_FAILURE`.
   */
  private async bankMove(
    call: string,
    opcode: "CMSG_AUTOBANK_ITEM" | "CMSG_AUTOSTORE_BANK_ITEM",
    guid: string,
    bag: number,
    slot: number,
    landed: () => { bag: number; slot: number } | undefined,
    timeout: number,
    what: string,
  ): Promise<BankMoveResult> {
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw(opcode, [{ u8: bag }, { u8: slot }]);
    let failure: InventoryChangeFailureData | undefined;
    let place: { bag: number; slot: number } | undefined;
    await this.waitEvent(
      (e) => {
        if (sinceSeq !== undefined && e.seq <= sinceSeq) return false;
        if (isEvent(e, "SMSG_INVENTORY_CHANGE_FAILURE") && !isDecodeError(e.data)) {
          failure = e.data as InventoryChangeFailureData;
          return true;
        }
        place = landed();
        return place !== undefined;
      },
      { timeout, includeBuffered: false, description: `the item to move (or SMSG_INVENTORY_CHANGE_FAILURE) after ${what}` },
    );
    if (failure !== undefined) {
      const f: InventoryChangeFailureData = failure;
      const hint = `the server refused ${what}: ${inventoryResultText(f.result) ?? `inventory result ${f.result}`}`;
      this.noteActionHint(call, "refused", hint);
      return { ok: false, status: "refused", guid, result: f.result, hint };
    }
    const at = place ?? landed()!;
    return { ok: true, status: "moved", guid, bag: at.bag, slot: at.slot };
  }

  /**
   * Put a carried item in the bank (`CMSG_AUTOBANK_ITEM`; `bag`/`slot` as
   * `state.bag()` lists them) and return where it landed in `state.bank()`,
   * or the server's refusal (bank full, not at a banker, ...). Needs the
   * bank frame open (`openBank`).
   */
  async bankDeposit(bagOrName: number | string, slot?: number | BankOptions, options: BankOptions = {}): Promise<WithResolved<BankMoveResult>> {
    if (slot !== null && typeof slot === "object") {
      options = slot;
      slot = undefined;
    }
    const closed = this.bankClosed("bankDeposit");
    if (closed !== undefined) return closed;
    const where = resolveItemSlot(this.state.bag().items, bagOrName, slot, "bankDeposit(bagOrName, slot?)", "state.bag()");
    if ("refusal" in where) return this.noBankItem("bankDeposit", where.refusal);
    const { bag, slot: at } = where;
    const row = this.state.bag().items.find((it) => it.bag === bag && it.slot === at);
    if (row === undefined) {
      return this.noBankItem("bankDeposit", `nothing is carried at bag ${bag} slot ${at} — state.bag().items lists what is, and the item's name works in place of the bag`);
    }
    const guid = row.guid;
    return withResolved(where, await this.bankMove(
      "bankDeposit",
      "CMSG_AUTOBANK_ITEM",
      guid,
      bag,
      at,
      () => {
        const hit = this.state.bank().items.find((it) => it.guid === guid);
        return hit === undefined ? undefined : { bag: hit.bag, slot: hit.slot };
      },
      options.timeout ?? 10_000,
      `bankDeposit(${bag}, ${slot})`,
    ));
  }

  /**
   * Take an item out of the bank (`CMSG_AUTOSTORE_BANK_ITEM`; `bag`/`slot`
   * as `state.bank()` lists them: 255 with 39-66 for the main bank, a bank
   * bag's slot 67-73 with its inner slot) and return where it landed in
   * `state.bag()`, or the server's refusal. Needs the bank frame open.
   */
  async bankWithdraw(bagOrName: number | string, slot?: number | BankOptions, options: BankOptions = {}): Promise<WithResolved<BankMoveResult>> {
    if (slot !== null && typeof slot === "object") {
      options = slot;
      slot = undefined;
    }
    const closed = this.bankClosed("bankWithdraw");
    if (closed !== undefined) return closed;
    const where = resolveItemSlot(this.state.bank().items, bagOrName, slot, "bankWithdraw(bagOrName, slot?)", "state.bank()");
    if ("refusal" in where) return this.noBankItem("bankWithdraw", where.refusal);
    const { bag, slot: at } = where;
    const row = this.state.bank().items.find((it) => it.bag === bag && it.slot === at);
    if (row === undefined) {
      return this.noBankItem("bankWithdraw", `nothing is banked at bag ${bag} slot ${at} — state.bank().items lists what is, and the item's name works in place of the bag`);
    }
    const guid = row.guid;
    return withResolved(where, await this.bankMove(
      "bankWithdraw",
      "CMSG_AUTOSTORE_BANK_ITEM",
      guid,
      bag,
      at,
      () => {
        const hit = this.state.bag().items.find((it) => it.guid === guid);
        return hit === undefined ? undefined : { bag: hit.bag, slot: hit.slot };
      },
      options.timeout ?? 10_000,
      `bankWithdraw(${bag}, ${slot})`,
    ));
  }

  /**
   * `CMSG_LEARN_TALENT` — spend one talent point. `rank` is 0-based as on the
   * wire (0 = the first point in that talent). Prefer `learnTalent`, which
   * waits for the `SMSG_TALENTS_INFO` answer.
   */
  learnTalentAsync(talentId: number, rank: number): Promise<ActionResponse> {
    return this.action({ action: "learn_talent", talentId, rank });
  }

  // ------------------------------------------- group loot rolls (item 102)

  /**
   * Vote on an open roll frame (`CMSG_LOOT_ROLL`): the need / greed / pass /
   * disenchant button for one item on a group-looted corpse. `which` is the
   * item's name as `state.pendingRolls()` lists it (exact, else a unique
   * substring), its item id, or the roll guid. Refusals are values with a
   * hint: nothing pending or nothing by that name (`no_pending_roll`), two
   * frames match (`ambiguous_roll`), a button the server did not offer
   * (`roll_not_allowed`). `rolled` is the server's echo of the counted vote.
   */
  async lootRoll(which: string | number, choice: RollChoice, options: LootRollOptions = {}): Promise<WithResolved<LootRollResult>> {
    const timeout = options.timeout ?? 10_000;
    const vote = ROLL_VOTE[choice];
    if (vote === undefined) {
      throw new TypeError(`lootRoll(which, choice): choice must be "need", "greed", "pass" or "disenchant", not ${JSON.stringify(choice)}`);
    }
    const pending = this.state.pendingRolls();
    const show = (rows: readonly PendingRoll[]) =>
      rows.map((r) => `${JSON.stringify(r.name ?? `item ${r.itemId}`)} (${r.allowed.join("/")}, roll ${r.rollGuid})`).join(", ");
    if (pending.length === 0) {
      return this.lootRollRefusal("no_pending_roll",
        "no roll frame is open — a roll only appears (state.pendingRolls()) when a group-looted corpse holds an item at or " +
        "above the group's loot threshold, and it closes after its countdown or once you have voted");
    }
    let roll: PendingRoll | undefined;
    let resolved: ResolvedRef | undefined;
    if (typeof which === "number") {
      const hits = pending.filter((r) => r.itemId === which);
      if (hits.length > 1) return this.lootRollRefusal("ambiguous_roll", `item ${which} is up for ${hits.length} rolls [${show(hits)}] — pass the roll guid`);
      roll = hits[0];
    } else {
      roll = pending.find((r) => r.rollGuid === which);
      if (roll === undefined) {
        const hit = resolveName(which, pending, (r) => r.name);
        if (hit.kind === "many") {
          return this.lootRollRefusal("ambiguous_roll", `${JSON.stringify(which)} matches ${hit.candidates.length} open rolls [${show(hit.candidates)}] — pass the roll guid`);
        }
        if (hit.kind === "one") {
          roll = hit.value;
          if (isFuzzy(hit.tier)) resolved = { input: which, name: hit.name };
        }
      }
    }
    if (roll === undefined) {
      return this.lootRollRefusal("no_pending_roll", `no open roll is for ${JSON.stringify(which)} — the open rolls are [${show(pending)}] (state.pendingRolls())`);
    }
    if (!roll.allowed.includes(choice)) {
      return this.lootRollRefusal("roll_not_allowed",
        `the server offered only ${roll.allowed.join(" / ")} on ${JSON.stringify(roll.name ?? `item ${roll.itemId}`)} — need is withheld when your class ` +
        `cannot use the item, disenchant when nobody in the group can`);
    }
    const chosen = roll;
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.raw("CMSG_LOOT_ROLL", [{ guid: chosen.rollGuid }, { u32: chosen.slot }, { u8: vote }]);
    const echo = await this.waitEvent(
      (e) =>
        isEvent(e, "SMSG_LOOT_ROLL") &&
        !isDecodeError(e.data) &&
        (sinceSeq === undefined || e.seq > sinceSeq) &&
        // The echo's source guid is ObjectGuid::Empty ("0") from the core (Group::CountRollVote); slot + item name the roll.
        ((e.data as LootRollData).rollGuid === chosen.rollGuid ||
          ((e.data as LootRollData).rollGuid === "0" && (e.data as LootRollData).slot === chosen.slot && (e.data as LootRollData).itemId === chosen.itemId)) &&
        (e.data as LootRollData).playerGuid === this.state.self.guid,
      { timeout, description: `the server counting the ${choice} vote (SMSG_LOOT_ROLL)` },
    );
    const d = echo.data as LootRollData;
    const out: LootRollResult = {
      ok: true,
      status: "rolled",
      rollGuid: chosen.rollGuid,
      // The acknowledgement cannot be read back for the button: a need ack
      // carries rollType 0, which is ROLL_PASS. Report what was pressed.
      choice,
      // 0 (the need ack) and 128 (every other ack, and a pass) are not rolls.
      roll: d.roll >= 1 && d.roll <= 100 ? d.roll : undefined,
      item: { itemId: chosen.itemId, name: chosen.name },
    };
    return resolved === undefined ? out : { ...out, resolved };
  }

  private lootRollRefusal(status: LootRollRefusalStatus, hint: string): LootRollResult {
    this.noteActionHint("lootRoll", status, hint);
    return { ok: false, status, hint };
  }

  // ------------------------------------------------------ item text (item 103)

  /**
   * Read a carried book or letter and return its text. The item is the
   * `bag`/`slot` pair `state.bag()` lists, or its name in place of `bag`.
   * A page item (the template's `pageText`) goes the way a client reads it:
   * `CMSG_READ_ITEM`, the server's `SMSG_READ_ITEM_OK`, then the client's
   * `CMSG_PAGE_TEXT_QUERY` on the first page, which the core answers page by
   * page down the chain. Anything else is asked for its player-written text
   * (`CMSG_ITEM_TEXT_QUERY`, a mailed letter); an empty answer is
   * `not_readable`. The pages stay in `state.itemTexts()` afterwards.
   */
  async readItem(bagOrName: number | string, slot?: number | ReadItemOptions, options: ReadItemOptions = {}): Promise<WithResolved<ReadItemResult>> {
    if (slot !== null && typeof slot === "object") {
      options = slot;
      slot = undefined;
    }
    const timeout = options.timeout ?? 10_000;
    const where = resolveItemSlot(this.state.bag().items, bagOrName, slot, "readItem(bagOrName, slot?)", "state.bag()");
    if ("refusal" in where) {
      this.noteActionHint("readItem", "no_item", where.refusal);
      return { ok: false, status: "no_item", hint: where.refusal };
    }
    const row = this.state.bag().items.find((i) => i.bag === where.bag && i.slot === where.slot);
    if (row === undefined) {
      const hint = `readItem: nothing is carried at bag ${where.bag} slot ${where.slot} — state.bag() lists what is`;
      this.noteActionHint("readItem", "no_item", hint);
      return { ok: false, status: "no_item", hint };
    }
    const item = { bag: row.bag, slot: row.slot, guid: row.guid, itemId: row.itemId, name: row.name };
    const label = JSON.stringify(row.name ?? `item ${row.itemId ?? "?"}`);
    const firstPage = row.itemId === undefined ? undefined : this.state.items.get(row.itemId)?.value.pageText;
    const sinceSeq = this.events.recent(1)[0]?.seq;
    const after = (e: StreamEvent) => !isDecodeError(e.data) && (sinceSeq === undefined || e.seq > sinceSeq);
    if (firstPage !== undefined && firstPage !== 0) {
      await this.raw("CMSG_READ_ITEM", [{ u8: row.bag }, { u8: row.slot }]);
      const ack = await this.waitEvent(
        (e) =>
          after(e) &&
          (((isEvent(e, "SMSG_READ_ITEM_OK") || isEvent(e, "SMSG_READ_ITEM_FAILED")) && (e.data as ReadItemData).guid === row.guid) ||
            isEvent(e, "SMSG_INVENTORY_CHANGE_FAILURE")),
        { timeout, description: `the server's answer to reading ${label} (SMSG_READ_ITEM_OK / _FAILED)` },
      );
      if (!isEvent(ack, "SMSG_READ_ITEM_OK")) {
        const code = isEvent(ack, "SMSG_INVENTORY_CHANGE_FAILURE") ? (ack.data as InventoryChangeFailureData).result : undefined;
        const why = code === undefined ? "the server refused the read" : (inventoryResultText(code) ?? `inventory error ${code}`);
        const hint = `${label} cannot be read: ${why} — a level or class requirement on the item, or it is not a book`;
        this.noteActionHint("readItem", "not_readable", hint);
        return withResolved(where, { ok: false, status: "not_readable", hint });
      }
      await this.raw("CMSG_PAGE_TEXT_QUERY", [{ u32: firstPage }, { guid: row.guid }]);
      await this.waitEvent(
        (e) => after(e) && isEvent(e, "SMSG_PAGE_TEXT_QUERY_RESPONSE") && (e.data as PageTextQueryResponseData).nextPageId === 0,
        { timeout, description: `the last page of ${label} (SMSG_PAGE_TEXT_QUERY_RESPONSE with nextPageId 0)` },
      );
      const text = this.state.itemTexts().find((t) => t.guid === row.guid);
      const pages = text?.pages ?? [];
      return withResolved(where, { ok: true, status: "read", item, pages, text: pages.join("\n\n") });
    }
    await this.raw("CMSG_ITEM_TEXT_QUERY", [{ guid: row.guid }]);
    const reply = await this.waitEvent(
      (e) => after(e) && isEvent(e, "SMSG_ITEM_TEXT_QUERY_RESPONSE") && ((e.data as ItemTextQueryResponseData).guid ?? row.guid) === row.guid,
      { timeout, description: `the text of ${label} (SMSG_ITEM_TEXT_QUERY_RESPONSE)` },
    );
    const d = reply.data as ItemTextQueryResponseData;
    if (!d.found || d.text === undefined || d.text.length === 0) {
      const hint = `${label} has nothing to read: it is neither a book or letter with pages nor a mailed letter with text — ` +
        `a readable item's tooltip (state.items.get(itemId)) carries a pageText`;
      this.noteActionHint("readItem", "not_readable", hint);
      return withResolved(where, { ok: false, status: "not_readable", hint });
    }
    return withResolved(where, { ok: true, status: "read", item, pages: [d.text], text: d.text });
  }

  /**
   * The raw-action escape hatch. Sends one client opcode
   * from the module's allowlist (module/PROTOCOL.md, "raw") with a body you
   * build: a hex string, bytes, or a field list the SDK packs little-endian —
   * `[{ u32: 5 }, { guid: unit.guid }, { cstring: "text" }]`. The ack means
   * "queued into the stock handler"; whatever the server answers arrives on
   * the event stream only if its opcode is whitelisted there, so an
   * unanswered raw action is the signal to ask for a surface, not a failure.
   *
   * Opcodes that already have a method (`castSpell`, `say`, `lootAll`, …) are
   * not on the allowlist: one audited path per opcode.
   *
   * A `guid`/`packedGuid` field also takes the name of something in view, the
   * same referent a helper takes and through the same resolver — a name is a
   * referent wherever a guid is one (METHODOLOGY). Nothing else in the payload
   * is touched: a `cstring` is a mail recipient or an invite target, usually
   * someone not in view, and a `u64` is not a referent at all. The opcode name
   * is never fuzzed either. Two matches refuse and name both; the answer
   * carries `resolved` for each field a name resolved.
   */
  raw(opcode: string, payload: RawPayload = ""): Promise<RawActionResponse> {
    const op = rawOpcodeSchema.safeParse(opcode);
    if (!op.success) {
      throw new TypeError(
        `raw(opcode, payload): opcode must be a CMSG_* (or bidirectional MSG_*) name (got ${JSON.stringify(opcode)}) — ` +
          `see module/PROTOCOL.md "raw" for the allowlist`,
      );
    }
    const named = this.resolveRawGuids(op.data, payload);
    const body = rawPayloadSchema.safeParse(named.payload);
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
    ).then((ack) => ({
      ...ack,
      opcode: op.data,
      payload: hexPayload,
      ...(named.resolved.length > 0 ? { resolved: named.resolved } : {}),
    }));
  }

  /**
   * Turn any name sitting in a raw payload's `guid`/`packedGuid` field into
   * the guid it names, and report the ones that needed fuzz. Only those two
   * field kinds: `cstring` carries player names the server resolves itself
   * (a mail recipient, a group invite) and rewriting one against what is in
   * view would silently retarget a valid call, and `u64` is a 64-bit value
   * rather than a referent. A hex or byte payload is already encoded and is
   * passed through untouched.
   */
  private resolveRawGuids(
    opcode: string,
    payload: RawPayload,
  ): { payload: RawPayload; resolved: ResolvedRef[] } {
    if (!Array.isArray(payload)) return { payload, resolved: [] };
    const resolved: ResolvedRef[] = [];
    const fields = payload.map((field) => {
      if (field === null || typeof field !== "object") return field;
      for (const key of ["guid", "packedGuid"] as const) {
        const value = (field as Record<string, unknown>)[key];
        if (typeof value !== "string" || GUID_TEXT.test(value.trim())) continue;
        const ref = this.targetRef(value, `raw(${opcode}, [{ ${key} }])`);
        if (ref.resolved !== undefined) resolved.push(ref.resolved);
        return { ...(field as object), [key]: ref.guid } as RawField;
      }
      return field;
    });
    return { payload: fields, resolved };
  }

  /**
   * POST /character-delete — delete a character by name through the real
   * `CMSG_CHAR_DELETE` path. Not the session token: the module stands up its
   * own parked session, so this takes (and defaults) a throwaway one per
   * attempt.
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
            // Bound account wins here too: a run must only ever
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

  /**
   * POST /lease — operator only (the caller's `secret` must be the port
   * secret). Binds this client's token to `account` (the bound account when
   * set, else the module default) and returns the session secret a
   * session-class client for the same token should be constructed with. The
   * runner calls this once per launch and hands `secret` to the snippet
   * child; a snippet has no use for it (its own class is refused with
   * `403 operator_only`). See module/PROTOCOL.md, "Authentication".
   */
  lease(account?: string): Promise<LeaseResponse> {
    const bound = this.boundAccount ?? account;
    return this.request(
      "POST",
      "/lease",
      bound === undefined ? { token: this.token } : { token: this.token, account: bound },
      leaseResponseSchema,
    );
  }

  /** DELETE /lease — operator only. Revokes this token's session secret; a live session is untouched. */
  releaseLease(): Promise<ReleaseLeaseResponse> {
    return this.request("DELETE", "/lease", { token: this.token }, releaseLeaseResponseSchema);
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
    if ("unknown" in resolved) {
      this.noteActionHint("moveTo", "unknown_target", resolved.unknown);
      return { ok: false, status: "unknown_target", hint: resolved.unknown };
    }
    const point = resolved.point;
    // Notes that belong on whatever verdict comes back: a stale-position
    // fallback, and the budget estimate below. They explain the call, so they
    // ride the `hint` rather than changing the module's status (the status
    // vocabulary is the module's word).
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
        // walk got, and the call that would have survived.
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
      this.noteActionHint("moveTo", "transferred", transfer.hint, point);
      return { ok: false, status: "transferred", ...common, hint: withNotes(transfer.hint) };
    }
    if (status === "teleported") {
      // A same-map port: no SMSG_NEW_WORLD is coming, so waiting for one
      // (what `transferred` does) would be a full-timeout hang ending in a
      // false "still pending" (item 46). The arrival point is the
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
      const teleportHint =
        `a same-map teleport took the character mid-move, but no MSG_MOVE_TELEPORT_ACK with its arrival ` +
        `point was observed. state.self.position may be stale until the next move result; the ` +
        `destination (${fmtXY(point)}) was not reached.`;
      this.noteActionHint("moveTo", "teleported", teleportHint, point);
      return { ok: false, status: "teleported", ...common, hint: withNotes(teleportHint) };
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
      // `stop`. The repair is deterministic: after a move
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
    const recipe =
      (status === "target_off_mesh" ? transportDockHint(this.state, point) : undefined) ??
      MOVE_HINTS[status]?.(point, data);
    // Recorded before the call-specific notes are folded in: the recipe is what
    // the model needs and what dedupes; the notes are per-call (see ActionHint).
    this.noteActionHint("moveTo", status, recipe, point);
    const hint = withNotes(recipe);
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
  async killTarget(target: GuidOrUnit, options: KillTargetOptions = {}): Promise<WithResolved<KillResult>> {
    return this.byName(target, "killTarget(guid)", async (raw) => {
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
    });
  }

  /**
   * Empty a corpse and wait until the window is closed again.
   *
   * `loot_all` is the module replaying the client's auto-loot sequence:
   * the window that says what was there, the release that says it
   * is finished — and, between them, one `SMSG_ITEM_PUSH_RESULT` per item that
   * actually entered a bag. The pushes, not the window, decide the result:
   * a window is an offer, and calling an offer "looted" made a broken replay
   * invisible for a whole run (morning-opus-1; the forbidden silent-wrong outcome).
   * A corpse with nothing on it releases without ever opening a window, which
   * is `{ ok: false, status: "empty" }` — an answer, not a failure. Silence is
   * neither, so it still throws `EventTimeoutError`.
   *
   * A chest-type game object is emptied the same way but opened differently:
   * the server drops `CMSG_LOOT` on a game object guid and ignores
   * `CMSG_GAMEOBJ_USE` on a chest, so the window has to be earned by casting
   * the lock's Opening spell at it, as a client does (`CHEST_OPEN_SPELLS`).
   * Once the window is open the auto-loot sequence is the client's own:
   * `CMSG_AUTOSTORE_LOOT_ITEM` per storable slot, `CMSG_LOOT_MONEY` if there
   * is gold, `CMSG_LOOT_RELEASE`. A chest no open-hand spell fits is
   * `{ ok: false, status: "not_opened", reason, hint }`. Seen in two runs
   * (opus-low a11/a12, sonnet-low a2, Coldridge Valley, 2026-08-29) as an
   * `interact` that acked and a `lootCorpse` that timed out.
   */
  async lootCorpse(target: GuidOrUnit, options: LootOptions = {}): Promise<WithResolved<LootResult>> {
    return this.byName(target, "lootCorpse(guid)", async (id) => {
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
        const chest = this.isChest(id);
        let first: StreamEvent;
        if (chest) {
          const opened = await this.openChest(id, sinceSeq, timeout);
          if ("refused" in opened) {
            return {
              ok: false,
              status: "not_opened",
              gold: 0,
              items: [],
              reason: opened.refused,
              hint:
                opened.refused === SPELL_FAILED_BAD_TARGETS
                  ? `the server refused every open-hand Opening spell (${CHEST_OPEN_SPELLS.join(", ")}) on this chest: ` +
                    "its lock wants something else (a key item, lockpicking, or a gathering skill)"
                  : `the Opening cast was refused with SpellCastResult ${opened.refused}: stand still within reach of the chest and retry`,
            };
          }
          first = opened.window;
        } else {
          await this.lootAll(id);
          first = await this.waitEvent(
            (e) =>
              (isEvent(e, "SMSG_LOOT_RESPONSE") || isEvent(e, "SMSG_LOOT_RELEASE_RESPONSE")) &&
              !isDecodeError(e.data) &&
              (sinceSeq === undefined || e.seq > sinceSeq),
            { timeout, description: "the loot window (SMSG_LOOT_RESPONSE or SMSG_LOOT_RELEASE_RESPONSE)" },
          );
        }
        if (first.opcode === "SMSG_LOOT_RELEASE_RESPONSE") {
          return { ok: false, status: "empty", gold: 0, items: [] };
        }
        const window = first.data as LootResponseData;
        // What the replay will try to store: slots free to loot (0, ALLOW_LOOT)
        // or owned outright (4, OWNER — every slot of a solo loot). Group-only
        // slot types are shown but never auto-stored.
        const expected = window.items.filter(isStorableSlot).length;
        if (chest) {
          // The module's auto-loot replay rides on `loot_all`, which a chest
          // never goes through; send the client's sequence from here.
          for (const item of window.items.filter(isStorableSlot)) await this.lootItem(item.slot);
          if (window.gold > 0) await this.lootMoney();
          await this.lootRelease(id);
        }
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
    });
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
  ): Promise<WithResolved<QuestAcceptResult>> {
    return this.byName(npcGuid, "acceptQuestFrom(npcGuid, questId)", async (npc) => {
      const timeout = options.timeout ?? 10_000;
      const inLog = this.state.quest(questId);
      if (inLog) {
        return { ok: true, status: "already_in_log", questId, quest: inLog, title: undefined };
      }

      let wanted: OfferedQuest | undefined;
      const carried = this.state.bag().items.find((i) => i.guid === npc);
      if (carried !== undefined) {
        // A quest-start item is its own questgiver: there is no quest list to
        // ask it for (CMSG_QUESTGIVER_HELLO on an item guid is dropped), so the
        // offer is the details the server sends for the query — the same
        // packet useItem waits for.
        const offer = await this.questDetailsFrom(npc, questId, timeout, carried);
        wanted = { questId: offer.questId, title: offer.title, icon: 0, level: 0 };
      } else {
        const offered = await this.questOffer(npc, timeout);
        if ("nothing" in offered) {
          this.noteActionHint("acceptQuestFrom", "nothing_on_offer", offered.hint);
          return { ok: false, status: "nothing_on_offer", questId, offered: [], hint: offered.hint };
        }
        wanted = offered.quests.find((q) => q.questId === questId);
        if (!wanted) return { ok: false, status: "not_offered", questId, offered: offered.quests };
      }

      await this.questAccept(npc, questId);
      const quest = await this.waitForState(
        () => this.state.quest(questId),
        timeout,
        `quest ${questId} to appear in the quest log after accept`,
      );
      return { ok: true, status: "accepted", questId, quest, title: wanted.title };
    });
  }

  /**
   * Ask an NPC what quests it is offering, and return the list.
   *
   * The same `quest_list` send-and-wait `acceptQuestFrom` does — including
   * accepting *either* answer shape, since a gossip-flagged questgiver replies
   * with `SMSG_GOSSIP_MESSAGE` carrying the quests instead of
   * `SMSG_QUESTGIVER_QUEST_LIST` — with none of the accepting. Models kept
   * rebuilding exactly this by hand over `questList` plus event scraping and
   * getting confused by their own nulls (item 9a).
   *
   * An empty `quests` is an answer: the NPC has nothing for this character
   * right now. Silence is not, so it still throws `EventTimeoutError`.
   */
  async questsAvailableFrom(
    npcGuid: GuidOrUnit,
    options: QuestOptions = {},
  ): Promise<WithResolved<QuestsAvailableResult>> {
    return this.byName(npcGuid, "questsAvailableFrom(npcGuid)", async (npc) => {
      const offered = await this.questOffer(npc, options.timeout ?? 10_000);
      if ("nothing" in offered) {
        this.noteActionHint("questsAvailableFrom", "nothing_on_offer", offered.hint);
        return { ok: false, status: "nothing_on_offer", quests: [], hint: offered.hint };
      }
      return { ok: true, quests: offered.quests };
    });
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
  async trainerList(npcGuid: GuidOrUnit, options: TrainerOptions = {}): Promise<WithResolved<TrainerListResult>> {
    return this.byName(npcGuid, "trainerList(npcGuid)", async (id) => {
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
    });
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
  async learnTalent(talent: number | string, rank?: number | TrainerOptions, options: TrainerOptions = {}): Promise<LearnTalentResult> {
    // `learnTalent("Improved Heroic Strike", { timeout })`: an object is never
    // a rank, so it is the options — one reading, repaired rather than sent.
    if (rank !== null && typeof rank === "object") {
      options = rank;
      rank = undefined;
    }
    const resolved = this.resolveTalent(talent);
    if ("refusal" in resolved) return resolved.refusal;
    const talentId = resolved.talentId;
    // The wire rank is 0-based, so the next point is exactly how many are
    // already in this talent — the rank the client's own tooltip would buy.
    const spent = this.state.talents()?.talents.find((t) => t.talentId === talentId)?.rank;
    rank = rank ?? (spent === undefined ? 0 : spent + 1);
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
    const hint =
        `the server did not record talent ${talentId} at rank ${rank} — it needs an unspent point ` +
        `(state.talents().unspentPoints is ${talents.unspentPoints}), the previous rank first, enough ` +
        `points in that tree's earlier tiers, and any prerequisite talent; the server names no reason`;
    this.noteActionHint("learnTalent", "not_learned", hint);
    return { ok: false, status: "not_learned", talentId, rank, talents, hint };
  }

  /**
   * Which talent `learnTalent` means: an id, or a talent's name anywhere in
   * this class's tree (through the shared `resolveName`), which needs the tree
   * read once — `queryTalentTree()`. Two matches are two
   * readings, so they are refused with both named rather than picked.
   */
  private resolveTalent(talent: number | string): { talentId: number } | { refusal: LearnTalentResult } {
    if (typeof talent === "number") return { talentId: talent };
    const refuse = (status: "unknown_talent" | "ambiguous_talent" | "no_tree", hint: string) => {
      this.noteActionHint("learnTalent", status, hint);
      return { refusal: { ok: false as const, status, hint } };
    };
    const tree = this.state.talentTree();
    if (tree === undefined) {
      return refuse("no_tree", `a talent name can only be resolved against the class tree — call queryTalentTree() once first, or pass the talent id`);
    }
    const all = tree.tabs.flatMap((tab) => tab.talents.map((t) => ({ ...t, tab: tab.name })));
    const named = all.filter((t) => t.name !== undefined);
    const hit = resolveName(talent, named, (t) => t.name);
    const show = (rows: typeof named) => rows.map((t) => `${t.talentId}:${JSON.stringify(t.name ?? "?")}${t.tab === undefined ? "" : ` (${t.tab})`}`).join(", ");
    if (hit.kind === "one") return { talentId: hit.value.talentId };
    if (hit.kind === "none") {
      return refuse("unknown_talent", `no talent in your tree is named ${JSON.stringify(talent)} — state.talentTree().tabs[].talents lists them`);
    }
    return refuse("ambiguous_talent", `${JSON.stringify(talent)} matches ${hit.candidates.length} talents (${show(hit.candidates)}) — pass the exact name or the talent id`);
  }

  /**
   * Open a flight master's window and return it: `gossipHello` on the NPC,
   * then — when the master's menu has other entries too — choose its taxi
   * option (gossip icon 2, the client's own marker), and wait for
   * `SMSG_SHOWTAXINODES`. A flight master with nothing else to say sends the
   * window straight from the hello, so the select step is skipped when the
   * window arrives first. The result is what `state.lastTaxiNodes(guid)`
   * holds: the node this master stands at and the nodes this character has
   * visited (the only destinations the server will accept). Nothing here
   * is a route or a fare; the way to learn whether two nodes connect is to
   * ask (`activateTaxi`).
   */
  async showTaxiNodes(npcGuid: GuidOrUnit, options: TaxiOptions = {}): Promise<WithResolved<TaxiWindow>> {
    return this.byName(npcGuid, "showTaxiNodes(npcGuid)", async (id) => {
      const timeout = options.timeout ?? 10_000;
      const sinceSeq = this.events.recent(1)[0]?.seq;
      const after = (e: StreamEvent) => sinceSeq === undefined || e.seq > sinceSeq;
      const isWindow = (e: StreamEvent) =>
        isEvent(e, "SMSG_SHOWTAXINODES") && !isDecodeError(e.data) && guidKey((e.data as { guid: string }).guid) === id;
      const isMenu = (e: StreamEvent) =>
        isEvent(e, "SMSG_GOSSIP_MESSAGE") && !isDecodeError(e.data) && guidKey((e.data as GossipMessageData).guid) === id;
      await this.gossipHello(id);
      const first = await this.waitEvent((e) => after(e) && (isWindow(e) || isMenu(e)), {
        timeout,
        description: `the flight master's window (SMSG_SHOWTAXINODES) or menu (SMSG_GOSSIP_MESSAGE) for ${id}`,
      });
      if (isMenu(first)) {
        const menu = first.data as GossipMessageData;
        const taxi = menu.options.filter((o) => o.icon === 2);
        if (taxi.length !== 1) {
          throw new Error(
            `showTaxiNodes(${id}): the menu that opened has ${taxi.length === 0 ? "no" : taxi.length} taxi option(s) ` +
              `(gossip icon 2) — is this NPC a flight master (state.units({ role: "flightMaster" }))? Options: ` +
              menu.options.map((o) => `${o.optionId}:${JSON.stringify(o.text)} (icon ${o.icon})`).join(", "),
          );
        }
        await this.gossipSelect(id, menu.menuId, taxi[0]!.optionId);
        await this.waitEvent((e) => e.seq > first.seq && isWindow(e), {
          timeout,
          description: `the flight master's window (SMSG_SHOWTAXINODES) for ${id} after choosing its taxi option`,
        });
      }
      const window = this.state.lastTaxiNodes(id);
      if (window === undefined) {
        throw new Error(`showTaxiNodes(${id}): SMSG_SHOWTAXINODES arrived but the state cache holds no window for it`);
      }
      return window;
    });
  }

  /**
   * `CMSG_ACTIVATETAXI` — fly from the node this flight master stands at to
   * `dest`, and read the server's verdict off `SMSG_ACTIVATETAXIREPLY`.
   *
   * `dest` is a node name (case-insensitive exact, or a unique substring) or
   * a node id, resolved against the window last observed for this master
   * (`state.lastTaxiNodes(guid)`; `showTaxiNodes` opens one). The source
   * node is that window's `current`, exactly what a client sends. Throws
   * (nothing dispatched) when no window has been seen for the guid or the
   * destination matches no known node or more than one — every rejection
   * lists the known nodes so the next call is obvious. The refusal codes
   * come back as values with a hint each (`TAXI_REPLY_HINTS`).
   *
   * `accepted` is the flight starting; `state.self.taxiFlight` is true for
   * the ride and flips false on landing. The fare is charged by the server
   * and shows on `state.money`.
   */
  async activateTaxi(npcGuid: GuidOrUnit, dest: string | number, options: TaxiOptions = {}): Promise<WithResolved<ActivateTaxiResult>> {
    return this.byName(npcGuid, "activateTaxi(npcGuid, dest)", async (id) => {
      const window = this.state.lastTaxiNodes(id);
      if (window === undefined) {
        throw new Error(
          `activateTaxi(${id}, ${JSON.stringify(dest)}): no flight master window has been observed for ${id} — ` +
            `open one first with showTaxiNodes(guid) (gossipHello on a visible flight master), then fly.`,
        );
      }
      const to = resolveTaxiNode(window, dest);
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.raw("CMSG_ACTIVATETAXI", [{ guid: id }, { u32: window.current.nodeId }, { u32: to.nodeId }]);
      const event = await this.waitEvent(
        (e) => isEvent(e, "SMSG_ACTIVATETAXIREPLY") && !isDecodeError(e.data) && (sinceSeq === undefined || e.seq > sinceSeq),
        {
          timeout: options.timeout ?? 10_000,
          description: `the SMSG_ACTIVATETAXIREPLY answering activateTaxi(${id}, ${JSON.stringify(dest)})`,
        },
      );
      const reply = (event.data as ActivateTaxiReplyData).reply;
      if (reply === 0) {
        return { ok: true, status: "accepted", reply: 0, from: window.current, to };
      }
      const named = TAXI_REPLY_HINTS[reply];
      const hint = named === undefined ? `the server refused the flight with reply ${reply}, a code the SDK does not name` : named;
      this.noteActionHint("activateTaxi", "refused", hint);
      return { ok: false, status: "refused", reply, from: window.current, to, hint };
    });
  }

  /**
   * Make an inn the hearthstone's home, the way a client does it: open the
   * innkeeper's gossip menu, choose the bind option ("Make this inn your
   * home." by default), answer the server's `SMSG_BINDER_CONFIRM` with
   * `CMSG_BINDER_ACTIVATE`, and return the `SMSG_BINDPOINTUPDATE` that
   * follows — the new destination, also on `state.self.bindPoint`.
   *
   * Throws (nothing further dispatched) when the menu has no such option;
   * the message lists the options. The server declines silently when the
   * NPC is not an innkeeper in range or the character is dead, which shows
   * as the confirm never arriving (`EventTimeoutError`).
   */
  async bindAtInnkeeper(npcGuid: GuidOrUnit, options: BindOptions = {}): Promise<WithResolved<BindResult>> {
    return this.byName(npcGuid, "bindAtInnkeeper(npcGuid)", async (id) => {
      const timeout = options.timeout ?? 10_000;
      const sinceSeq = this.events.recent(1)[0]?.seq;
      await this.gossipHello(id);
      const menuEvent = await this.waitEvent(
        (e) =>
          isEvent(e, "SMSG_GOSSIP_MESSAGE") &&
          !isDecodeError(e.data) &&
          guidKey((e.data as GossipMessageData).guid) === id &&
          (sinceSeq === undefined || e.seq > sinceSeq),
        { timeout, description: `the innkeeper's menu (SMSG_GOSSIP_MESSAGE) for ${id}` },
      );
      const menu = menuEvent.data as GossipMessageData;
      let choice: { menuId: number; optionId: number };
      if (options.option !== undefined) {
        choice = this.resolveGossipOption(id, options.option);
      } else {
        const home = menu.options.filter((o) => /home/i.test(o.text));
        if (home.length !== 1) {
          throw new Error(
            `bindAtInnkeeper(${id}): the menu that opened has ${home.length === 0 ? "no" : home.length} option(s) mentioning ` +
              `"home" — is this NPC an innkeeper (state.units({ role: "innkeeper" }))? Pass { option } to pick one of: ` +
              menu.options.map((o) => `${o.optionId}:${JSON.stringify(o.text)}`).join(", "),
          );
        }
        choice = { menuId: menu.menuId, optionId: home[0]!.optionId };
      }
      await this.gossipSelect(id, choice.menuId, choice.optionId);
      const confirm = await this.waitEvent(
        (e) =>
          isEvent(e, "SMSG_BINDER_CONFIRM") && !isDecodeError(e.data) && guidKey((e.data as { guid: string }).guid) === id && e.seq > menuEvent.seq,
        { timeout, description: `the innkeeper's confirm (SMSG_BINDER_CONFIRM) from ${id}` },
      );
      await this.raw("CMSG_BINDER_ACTIVATE", [{ guid: id }]);
      const bound = await this.waitEvent(
        (e) => isEvent(e, "SMSG_BINDPOINTUPDATE") && !isDecodeError(e.data) && e.seq > confirm.seq,
        { timeout, description: `the new bind point (SMSG_BINDPOINTUPDATE) after confirming with ${id}` },
      );
      const d = bound.data as BindPointUpdateData;
      return {
        ok: true,
        status: "bound",
        bindPoint: { map: d.map, x: d.x, y: d.y, z: d.z, area: { id: d.areaId, name: d.areaName } },
      };
    });
  }

  /**
   * Buy one spell from a trainer and wait for the server's verdict.
   *
   * Races `SMSG_TRAINER_BUY_SUCCEEDED` against `SMSG_TRAINER_BUY_FAILED` for
   * this spell id, so a refusal costs one round trip rather than the whole
   * timeout. The refusal is returned, not thrown: it is the game answering,
   * and `hint` names the likely causes and points back at `trainerList`.
   */
  async buySpell(
    npcGuid: GuidOrUnit,
    spellId: number,
    options: TrainerOptions = {},
  ): Promise<WithResolved<BuySpellResult>> {
    return this.byName(npcGuid, "buySpell(npcGuid, spellId)", async (id) => {
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
      const hint =
        `the trainer refused (reason ${reason}${named ? `: ${named}` : ""}) — the usual causes are ` +
        `too little money and a spell that is not learnable yet; sdk.trainerList(npcGuid) reports ` +
        `each spell's cost, learnable and affordable`;
      this.noteActionHint("buySpell", "buy_failed", hint);
      return { ok: false, status: "buy_failed", spellId, reason, hint };
    });
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
  ): Promise<WithResolved<QuestTurnInResult>> {
    return this.byName(npcGuid, "turnInQuest(npcGuid, questId)", async (npcId) => {
      const timeout = options.timeout ?? 10_000;
      const isFor = (e: StreamEvent, opcode: "SMSG_QUESTGIVER_OFFER_REWARD" | "SMSG_QUESTGIVER_REQUEST_ITEMS") =>
        isEvent(e, opcode) &&
        !isDecodeError(e.data) &&
        (e.data as { questId: number }).questId === questId;

      // Out-of-range quest_complete is silently ignored by the server and burns
      // the whole timeout (roster-opus-20260822 turn ~28). Fail fast only when
      // the cache can prove the NPC is *grossly* far away — the 40y threshold
      // leaves cached-position staleness no room to reject a legitimate call;
      // borderline cases still get the honest timeout.
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
          const named = inventoryResultText(fail.result);
          const hint =
            `the reward could not be stored (InventoryResult ${fail.result}${named ? `: ${named}` : ""}) — ` +
            `free a bag slot (sell or destroyItem), then turn in again`;
          this.noteActionHint("turnInQuest", "inventory_full", hint);
          return { ok: false, status: "inventory_full", questId, result: fail.result, hint };
        }
        const d = complete.data as QuestGiverQuestCompleteData;
        return { ok: true, status: "complete", questId, xp: d.xp, money: d.money };
      }
    });
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
   * unfinished is the absence of an outcome rather than one.
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
   * message listing the options.
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
    const hit = resolveName(option, menu.options, (o) => o.text);
    if (hit.kind === "one") return { menuId: menu.menuId, optionId: hit.value.optionId };
    if (hit.kind === "none") {
      throw new TypeError(
        `gossipSelect(guid, ${JSON.stringify(option)}): no option on the menu currently open for ${guid} ` +
          `matches. Options are: ${list}. Pass the exact text, a unique substring, or the numeric optionId.`,
      );
    }
    const both = hit.candidates.map((o) => `[${o.optionId}] ${JSON.stringify(o.text)}`).join(", ");
    throw new TypeError(
      `gossipSelect(guid, ${JSON.stringify(option)}): matches ${hit.candidates.length} options on the menu open ` +
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
  private async questOffer(npcGuid: GuidArg, timeout: number): Promise<QuestOfferOutcome> {
    const sinceSeq = this.events.recent(1)[0]?.seq;
    const distance = distanceToUnit(this.state, npcGuid);
    const marker = questgiverMarkerOf(this.state, npcGuid, "available");
    if (marker !== undefined && OFFERS_NOTHING.has(marker.name)) {
      // The server already said what this NPC has for us (its questgiver
      // marker, received before the call), and it is not a quest on offer — a
      // turn-in-only or empty-handed NPC answers a quest_list with silence, so
      // waiting the timeout out would only confirm what is already known.
      return {
        nothing: marker,
        hint:
          `${questgiverMarkerClause(marker)} Nothing was sent. ` +
          'Use the search_reference tool for who offers the quest you are after; state.units({ questGiver: "available" }) lists every NPC in view with a quest on offer.',
      };
    }
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
    return { quests: (menu.data as QuestGiverQuestListData | GossipMessageData).quests ?? [] };
  }

  /**
   * Ask a quest-start item for its quest: `CMSG_QUESTGIVER_QUERY_QUEST` with
   * the item's guid, answered by `SMSG_QUESTGIVER_QUEST_DETAILS`. The item's
   * own tooltip (`startQuest`) is checked first so a wrong quest id is refused
   * here rather than by the server's silence.
   */
  private async questDetailsFrom(itemGuid: string, questId: number, timeout: number, item: BagSlotItem): Promise<QuestGiverQuestDetailsData> {
    const starts = questStartedBy(this.state, item);
    if (starts !== undefined && starts !== questId) {
      throw new TypeError(
        `acceptQuestFrom(itemGuid, questId): ${item.name ?? `item ${item.itemId}`} starts quest ${starts}, not ${questId} (its tooltip's startQuest)`,
      );
    }
    const sinceSeq = this.events.recent(1)[0]?.seq;
    await this.questDetails(itemGuid, questId);
    const offer = await this.waitEvent(
      (e) =>
        isEvent(e, "SMSG_QUESTGIVER_QUEST_DETAILS") &&
        !isDecodeError(e.data) &&
        (e.data as QuestGiverQuestDetailsData).questId === questId &&
        (sinceSeq === undefined || e.seq > sinceSeq),
      {
        timeout,
        description:
          `the quest offer (SMSG_QUESTGIVER_QUEST_DETAILS for quest ${questId}) from ${item.name ?? `item ${item.itemId}`} — ` +
          "the server stays silent when the item does not start that quest or the quest cannot be taken (already in the log or done, level or race gate)",
      },
    );
    return offer.data as QuestGiverQuestDetailsData;
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
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.secret !== undefined) headers["authorization"] = `Bearer ${this.secret}`;
      res = await this.fetchImpl(url, {
        method,
        headers,
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
