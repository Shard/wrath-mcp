/**
 * The map's chat bubbles: what a character said, above its pip, for a while
 * after it said it.
 *
 * The lines are the trace's (`chat` events, `@wrathbench/inspector/codec/trace`): each
 * character's own outgoing say, party, raid, yell, whisper and emote lines as
 * the server echoed them back. A party's lines are therefore each said once,
 * above the one who said them: another member's copy of the same line is
 * never recorded.
 *
 * Time is the map's playhead, never the wall clock: the replay's cursor, and
 * live the delayed playhead the pips are placed by, which runs at 1× — so a
 * bubble appears when the pip reaches the moment it was said rather than when
 * the feed brought it in, and stays `BUBBLE_MS` of the run's own time. A
 * replay played fast would flash it, so there a bubble stays at least
 * `BUBBLE_MIN_WALL_MS` of the reader's time at the chosen speed
 * (`bubbleLifeMs`, operator, 2026-10-20); still measured on the cursor, so a
 * scrub shows exactly what playing to that point would.
 *
 * Pure, so it is pinned by tests; `MapPage.tsx` only draws what this returns.
 */

import type { TraceChatKind, TraceChatLine } from "../../codec/trace";
import type { ScreenBox } from "./nearbyplayer";

/** How long a line stays up, on the playhead's clock. */
export const BUBBLE_MS = 30_000;
/** In a replay, the least a bubble is on screen in the reader's own time, at the speed it plays. */
export const BUBBLE_MIN_WALL_MS = 4_000;

/**
 * How long a line stays up, in playhead ms: `BUBBLE_MS` live, and in a replay
 * playing at `speed`× the longer of that and `BUBBLE_MIN_WALL_MS` of wall time
 * (4 min of the run at 60×). Idle stretches the replay compresses go by
 * faster, so there it is approximate; nothing is said during those anyway.
 */
export function bubbleLifeMs(replaySpeed: number | null): number {
  return replaySpeed === null ? BUBBLE_MS : Math.max(BUBBLE_MS, BUBBLE_MIN_WALL_MS * replaySpeed);
}

/** At most this many of one character's lines at once, newest kept; an older one gives way to a new one. */
export const BUBBLE_STACK = 3;
/** A bubble shows at most this many characters; the rest is the hover's. */
export const BUBBLE_CHARS = 80;
/** From the pip's centre to the bottom of its stack, clear of the puck and its heading. */
export const BUBBLE_LIFT_PX = 22;
/** Where the leader stops above the pip's centre: the edge of its puck. */
export const BUBBLE_LEAD_END_PX = 15;
/** The space kept between two stacks, and between a stack and the stage's edge. */
export const BUBBLE_GAP_PX = 4;

/** One line as a bubble draws it. */
export interface Bubble {
  /** Stable while the line is up, so its element is not rebuilt as the playhead moves. */
  key: string;
  kind: TraceChatKind;
  /** The text, clipped to `BUBBLE_CHARS`. */
  text: string;
  /** The hover: the kind and the whole line. */
  title: string;
}

/** One character's bubbles, oldest first: the newest sits lowest, nearest its pip. */
export interface BubbleStack {
  runId: string;
  bubbles: Bubble[];
}

/** `text` cut to `max` characters with an ellipsis, as is when it fits. */
export function clipBubble(text: string, max = BUBBLE_CHARS): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * The bubbles up at playhead `t`, from one character's lines (any order): the
 * lines said in `(t − lifeMs, t]`, the newest `BUBBLE_STACK` of them, oldest
 * first. A line said after `t` is not up yet; in a replay scrubbed back it
 * disappears again.
 */
export function bubblesAt(runId: string, lines: readonly TraceChatLine[], t: number, lifeMs = BUBBLE_MS): Bubble[] {
  const up = lines.filter((l) => l.t > t - lifeMs && l.t <= t).sort((a, b) => a.t - b.t);
  return up.slice(-BUBBLE_STACK).map((l) => ({
    key: `${runId}\n${l.t}\n${l.kind}\n${l.text}`,
    kind: l.kind,
    text: clipBubble(l.text),
    title: `${l.kind}: ${l.text}`,
  }));
}

/** What a set of stacks shows, as one string: equal exactly when the same bubbles are up for the same characters. */
export function stacksKey(stacks: readonly BubbleStack[]): string {
  return stacks.map((s) => `${s.runId}\t${s.bubbles.map((b) => b.key).join("\t")}`).join("\n");
}

/** A stack to place: its pip on screen and its measured size. */
export interface StackBox {
  runId: string;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

/** Where a stack goes: its box, and the leader from its bottom edge down to its pip. */
export interface PlacedStack extends ScreenBox {
  runId: string;
  /** The pip's x inside the box: where the leader leaves it. */
  leadX: number;
  /** The leader's length, from the box's bottom to just above the puck. */
  lead: number;
}

const overlaps = (a: ScreenBox, b: ScreenBox): boolean =>
  a.x < b.x + b.w + BUBBLE_GAP_PX && b.x < a.x + a.w + BUBBLE_GAP_PX && a.y < b.y + b.h + BUBBLE_GAP_PX && b.y < a.y + a.h + BUBBLE_GAP_PX;

/**
 * Every stack centred over its pip, kept inside the stage across, and lifted
 * clear of the stacks already placed and of `avoid` (the characters' pucks,
 * so a bubble never hides a character). A party standing together says its
 * lines one above another rather than on top of each other: stacks are placed
 * from the lowest pip on screen up (ties by run id, so the order holds still
 * from frame to frame), and one that would overlap moves up above what it hit.
 * The leader then runs from the box down to its own pip, so a lifted line
 * still says whose it is.
 */
export function layoutStacks(boxes: readonly StackBox[], stageW: number, avoid: readonly ScreenBox[] = []): PlacedStack[] {
  const order = [...boxes].sort((a, b) => b.sy - a.sy || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const placed: PlacedStack[] = [];
  for (const b of order) {
    const maxX = Math.max(BUBBLE_GAP_PX, stageW - BUBBLE_GAP_PX - b.w);
    const x = Math.min(maxX, Math.max(BUBBLE_GAP_PX, b.sx - b.w / 2));
    const box: ScreenBox = { x, y: b.sy - BUBBLE_LIFT_PX - b.h, w: b.w, h: b.h };
    // Each lift clears the one it hit; a few passes settle any pile-up.
    for (let pass = 0; pass < placed.length + avoid.length + 1; pass++) {
      const hit = placed.find((p) => overlaps(box, p)) ?? avoid.find((a) => overlaps(box, a));
      if (hit === undefined) break;
      box.y = hit.y - BUBBLE_GAP_PX - box.h;
    }
    const leadX = Math.min(b.w, Math.max(0, b.sx - box.x));
    placed.push({ runId: b.runId, ...box, leadX, lead: Math.max(0, b.sy - BUBBLE_LEAD_END_PX - (box.y + box.h)) });
  }
  return placed;
}
