/**
 * World coordinates to the map's pixels, and the view a map draws through.
 *
 * The world is a 64×64 grid of ADT tiles, 533.33325 yards square, with tile
 * (32, 32) at the origin; world X gives the tile row and world Y the column,
 * both decreasing as the index grows. A pixel here is 1/256 of a tile, the
 * native size of a minimap tile, so tiles drawn from a directory land on the
 * same grid. Pure numbers in, numbers out.
 */

export const TILE_SIZE = 533.33325;
export const GRID = 64;
export const TILE_PX = 256;

/** World (x, y) to unzoomed map pixels: column right, row down. */
export function worldToPixel(x: number, y: number): { px: number; py: number } {
  return { px: (32 - y / TILE_SIZE) * TILE_PX, py: (32 - x / TILE_SIZE) * TILE_PX };
}

/** A view: the map pixel at the canvas's centre, and canvas pixels per map pixel. */
export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export const MIN_SCALE = 1 / 64;
export const MAX_SCALE = 16;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Map pixels to canvas pixels, for a canvas `w` × `h`. */
export function toScreen(v: View, w: number, h: number, px: number, py: number): { sx: number; sy: number } {
  return { sx: (px - v.cx) * v.scale + w / 2, sy: (py - v.cy) * v.scale + h / 2 };
}

/** Canvas pixels to map pixels. */
export function fromScreen(v: View, w: number, h: number, sx: number, sy: number): { px: number; py: number } {
  return { px: (sx - w / 2) / v.scale + v.cx, py: (sy - h / 2) / v.scale + v.cy };
}

/** The view that frames every point with a margin, never closer in than `maxScale`. */
export function fit(points: readonly { px: number; py: number }[], w: number, h: number, maxScale = 2): View {
  if (points.length === 0) return { cx: 32 * TILE_PX, cy: 32 * TILE_PX, scale: clampScale(Math.min(w, h) / (GRID * TILE_PX)) };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.px);
    y0 = Math.min(y0, p.py);
    x1 = Math.max(x1, p.px);
    y1 = Math.max(y1, p.py);
  }
  const pad = 64;
  const scale = clampScale(Math.min(maxScale, (w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0)));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale };
}

/** The tiles a view shows, as rows and columns inside the grid. */
export function visibleTiles(v: View, w: number, h: number): { row: number; col: number }[] {
  const a = fromScreen(v, w, h, 0, 0);
  const b = fromScreen(v, w, h, w, h);
  const out: { row: number; col: number }[] = [];
  for (let row = Math.max(0, Math.floor(a.py / TILE_PX)); row <= Math.min(GRID - 1, Math.floor(b.py / TILE_PX)); row++) {
    for (let col = Math.max(0, Math.floor(a.px / TILE_PX)); col <= Math.min(GRID - 1, Math.floor(b.px / TILE_PX)); col++) out.push({ row, col });
  }
  return out;
}
