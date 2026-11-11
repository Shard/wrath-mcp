/**
 * Where a floating popover sits, against the viewport rather than its card.
 *
 * Lifted out of `lib/inventory.ts` when the ladder's filter
 * button wanted the same arithmetic: the maths is about a button, a viewport
 * and a panel, and nothing in it was ever about items. One mechanism, so a
 * second popover on the site cannot drift into its own placement rules.
 */

/** The button a popover hangs off, as much of its rect as the maths needs. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

/** Where a floating popover sits, in viewport coordinates. */
export interface Placement {
  /** Below the button, or flipped above it. */
  below: boolean;
  /** The CSS offset from the viewport edge the popover is pinned to. */
  offset: number;
  left: number;
  maxHeight: number;
}

/**
 * A placement as the style object a fixed panel is drawn with.
 *
 * Both edges are named on every render: a computed key would leave the other
 * one standing when the panel flips, and a stale `top` beats the `bottom` that
 * replaced it. One helper, so a second popover cannot name only one of them.
 */
export function popoverStyle(p: Placement, width?: number): Record<string, string> {
  const style: Record<string, string> = {
    left: `${p.left}px`,
    top: p.below ? `${p.offset}px` : "auto",
    bottom: p.below ? "auto" : `${p.offset}px`,
    "max-height": `${p.maxHeight}px`,
  };
  if (width !== undefined) style["width"] = `${width}px`;
  return style;
}

/**
 * Place a popover against the viewport rather than against its card.
 *
 * The panels hang off buttons inside a scrolling sidebar, and a popover that
 * is a child of that sidebar is clipped by it — a full paperdoll showed four
 * rows. So it is drawn through a portal, fixed, and this is the arithmetic:
 * below the button when there is room, flipped above when there is not, always
 * within the viewport horizontally, and never taller than what is left.
 *
 * Pure, so the case that matters — a button near the foot of a tall page — is
 * testable without a browser.
 */
export function popoverPlacement(
  rect: AnchorRect,
  viewport: { width: number; height: number },
  opts: { width?: number; gap?: number; margin?: number; min?: number; needed?: number } = {},
): Placement {
  const width = opts.width ?? 340;
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 8;
  const min = opts.min ?? 120;
  const below = viewport.height - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  // Below unless it is both short of a usable panel and worse than above: a
  // popover that fits below stays below, because that is where the button is.
  // Once the panel has been measured, `needed` is its real height, and the bar
  // becomes "does the whole thing fit" — a nineteen-slot doll under a button
  // near the foot of a card wants the room above it, not a scrollbar.
  const want = opts.needed ?? min;
  const goBelow = below >= want || below >= above;
  const room = Math.max(min, goBelow ? below : above);
  const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewport.width - width - margin));
  return {
    below: goBelow,
    offset: goBelow ? rect.bottom + gap : viewport.height - rect.top + gap,
    left,
    maxHeight: room,
  };
}

/** A box in one coordinate space, edges named: `l < r`, `t < b`. */
export interface Frame {
  l: number;
  t: number;
  r: number;
  b: number;
}

/**
 * Where a chart's hover card sits: beside the point it describes, inside the
 * part of the chart the reader can see.
 *
 * To the right of the point, centred on it vertically; flipped to the left
 * when the right would run out of the frame; and when neither side has the
 * room — a narrow phone frame — centred over the point's x and put below it,
 * or above when below would run out. Every answer is clamped into the frame,
 * so a card larger than the frame is pinned to its top-left rather than lost.
 * The gap keeps the card off the mark, which stays clickable under it.
 *
 * Pure, so the edges are testable without a browser; the chart measures the
 * card and the frame and passes them in.
 */
export function cardPlacement(
  anchor: { x: number; y: number },
  card: { w: number; h: number },
  frame: Frame,
  gap = 10,
): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
  const side = (left: number): { left: number; top: number } => ({
    left: clamp(left, frame.l, frame.r - card.w),
    top: clamp(anchor.y - card.h / 2, frame.t, frame.b - card.h),
  });
  if (anchor.x + gap + card.w <= frame.r) return side(anchor.x + gap);
  if (anchor.x - gap - card.w >= frame.l) return side(anchor.x - gap - card.w);
  const left = clamp(anchor.x - card.w / 2, frame.l, frame.r - card.w);
  const below = anchor.y + gap;
  const top = below + card.h <= frame.b ? below : anchor.y - gap - card.h;
  return { left: Math.max(frame.l, left), top: clamp(top, frame.t, frame.b - card.h) };
}
