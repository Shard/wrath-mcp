/**
 * Movement intention: where the character is *trying* to get to.
 *
 * The map's position feed says where an agent is. That is the whole story only
 * for a character standing still: for a walking one, the interesting fact is
 * the destination it was aimed at and whether it got there — a `too_far` in
 * open country and an `arrived` look identical as a dot.
 *
 * Everything here is pure. The canvas draws what these functions decide, so
 * the decisions — which intention belongs to the cursor, whether it is still
 * worth drawing, and what it means — are testable without a browser, exactly
 * as `replay.ts` is.
 */

import type { MoveIntentView } from "../../wire";
import { positionAgeMs, type FeedClock } from "./feedclock";

/**
 * How an intention reads.
 *
 *   `walking`  dispatched, no verdict yet — the line the map draws solid-dashed
 *   `ended`    it is over and nothing went wrong (arrived, or the agent
 *              superseded/stopped it, or a portal took the character)
 *   `failed`   the module refused it or the walk broke down (`too_far`,
 *              `drop`, `lost`, `target_off_mesh`, …)
 *
 * The vocabulary is the module's, and the map does not try to own it: the
 * outcomes that are *not* failures are listed, and anything else the module
 * ever answers with reads as one. A new status word therefore shows up red
 * rather than silently as a success.
 */
export type IntentTone = "walking" | "ended" | "failed";

/** Statuses that end a move without anything having gone wrong. */
const BENIGN = new Set(["arrived", "transferred", "teleported", "stopped", "superseded"]);

export function intentTone(status: string | null): IntentTone {
  if (status === null) return "walking";
  return BENIGN.has(status) ? "ended" : "failed";
}

/**
 * How long an intention stays on the map.
 *
 * A walking one outlives a settled one because it is the live fact: an agent
 * on a long walk across a zone is walking for minutes, and the destination is
 * the only thing on screen that says where it is headed. A settled one is
 * history — worth a moment of "that is where it was going", not a permanent
 * marker. Past the walking bound the intention is not "still walking", it is
 * a verdict that never reached us (a sandbox restart, a paused session), so it is
 * dropped rather than drawn as live forever.
 */
export const INTENT_WALKING_MS = 180_000;
export const INTENT_ENDED_MS = 120_000;

/**
 * The intention worth drawing beside a position, or null.
 *
 * Three ways to have none: the session recorded none, the intention is stale, or
 * it was dispatched on another map. The last matters more than it looks —
 * `routeUpTo` splits the walked route per map for the same reason: world
 * coordinates repeat across continents, so a destination from before a
 * transfer would draw a confident line to a point on Kalimdor that nobody was
 * ever headed for.
 *
 * The age is measured through `positionAgeMs`, so a published snapshot's own
 * latency is accounted for exactly as it is for a pip.
 */
export function intentToDraw(
  move: MoveIntentView | null | undefined,
  onMap: number,
  now: number,
  clock: FeedClock | null = null,
): MoveIntentView | null {
  if (move === null || move === undefined) return null;
  if (move.map !== null && move.map !== onMap) return null;
  const age = positionAgeMs(move.ts, now, clock);
  const tone = intentTone(move.status);
  if (age > (tone === "walking" ? INTENT_WALKING_MS : INTENT_ENDED_MS)) return null;
  return move;
}

/**
 * The intention standing at a replay cursor: the newest one recorded at or
 * before it.
 *
 * The same shape of answer `positionsAt` gives for a position, and for the
 * same reason — a replay is the live feed filled from a recording, not a
 * second renderer. Binary search, because a long session's move list is walked on
 * every playback tick.
 */
export function intentAt(
  moves: readonly MoveIntentView[] | undefined,
  ts: number,
): MoveIntentView | null {
  if (moves === undefined || moves.length === 0) return null;
  let lo = 0;
  let hi = moves.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid]!.ts <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : moves[found]!;
}

/**
 * The destination's label: what the move was aimed at, or where it was aimed.
 *
 * A name when the agent moved to a unit — that is the intention in the words
 * the agent used. Coordinates otherwise, rounded, because a yard of precision
 * on a map at this zoom is noise. A feed that withholds names (a harness's
 * public projection) always shows the coordinate form.
 */
export function intentLabel(move: MoveIntentView): string {
  if (move.target !== null && move.target.length > 0) return move.target;
  return `${Math.round(move.x)}, ${Math.round(move.y)}`;
}
