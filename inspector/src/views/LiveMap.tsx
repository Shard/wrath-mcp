/**
 * The live map: every session's last reading on one map, the units around
 * the selected one, drawn on a canvas over the tile grid, or over minimap
 * tiles when the page was given a directory of them. Drag to pan, wheel to
 * zoom, click a pip to select it; a chip per map that has a session.
 *
 * Tiles, when there are any, are `<tilesBase>/<map>/<row>_<col>.png`, drawn
 * only once a tile is big enough on screen to be worth a request; a tile that
 * is not there is a grid square. The map knows no map names: a host that has
 * them passes `mapName`.
 */

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { NearbyWindow, SessionSummary } from "../wire";
import { createNearbyStore, type NearbyClass } from "./lib/nearbyplayer";
import { isLive, livePosition, sessionName } from "./lib/sessions";
import { GRID, TILE_PX, clampScale, fit, fromScreen, toScreen, visibleTiles, worldToPixel, type View } from "./lib/world";

/** How often the selected session's units are asked for, and how far back. */
const NEARBY_POLL_MS = 5_000;
const NEARBY_SPAN_MS = 60_000;
/** A tile smaller than this on screen is drawn as grid, never fetched. */
const TILE_MIN_PX = 48;

const NEARBY_TOKEN: Record<NearbyClass, string> = { engaged: "--err", service: "--ok", player: "--accent", other: "--dim", dead: "--dim" };

export interface LiveMapProps {
  sessions: readonly SessionSummary[];
  now: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** The units around the selected session, when the host can fetch them. */
  nearby?: (id: string, spanMs: number) => Promise<NearbyWindow>;
  tilesBase?: string;
  mapName?: (map: number) => string | null;
}

export function LiveMap(props: LiveMapProps) {
  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [view, setView] = createSignal<View | null>(null);
  const [pinned, setPinned] = createSignal<number | null>(null);
  const [tick, setTick] = createSignal(0);
  const nearby = createNearbyStore({ onChange: () => setTick((n) => n + 1) });
  const tiles = new Map<string, HTMLImageElement | null>();

  /** Every session with a position, by map. */
  const placed = createMemo(() => {
    const out: { s: SessionSummary; map: number; px: number; py: number; live: boolean }[] = [];
    for (const s of props.sessions) {
      const pos = livePosition(s.live);
      if (pos === null) continue;
      out.push({ s, map: pos.map, ...worldToPixel(pos.x, pos.y), live: isLive(s, props.now) });
    }
    return out;
  });
  const maps = createMemo(() => [...new Set(placed().map((p) => p.map))].sort((a, b) => a - b));
  /** The map on screen: the one picked, else the selected session's, else the one with the most live sessions. */
  const map = createMemo<number | null>(() => {
    const pick = pinned();
    if (pick !== null && maps().includes(pick)) return pick;
    const sel = placed().find((p) => p.s.id === props.selected);
    if (sel !== undefined) return sel.map;
    const counts = new Map<number, number>();
    for (const p of placed()) counts.set(p.map, (counts.get(p.map) ?? 0) + (p.live ? 2 : 1));
    let best: number | null = null;
    for (const [m, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = m;
    return best;
  });
  const onMap = createMemo(() => placed().filter((p) => p.map === map()));

  // Frame the map's sessions whenever the map changes, and once there is a size to frame in.
  createEffect(() => {
    const { w, h } = size();
    map();
    if (w === 0 || h === 0) return;
    setView(fit(onMap().map((p) => ({ px: p.px, py: p.py })), w, h));
  });

  // The selected session's units, while it is live.
  createEffect(() => {
    const id = props.selected;
    const fetchUnits = props.nearby;
    nearby.retain(id === null ? [] : [id]);
    if (id === null || fetchUnits === undefined) return;
    let stopped = false;
    const read = (): void => {
      void fetchUnits(id, NEARBY_SPAN_MS)
        .then((w) => {
          if (!stopped) nearby.set(id, w);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, NEARBY_POLL_MS);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });

  const color = (token: string): string => getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "#888";

  const tileImage = (m: number, row: number, col: number): HTMLImageElement | null => {
    if (props.tilesBase === undefined) return null;
    const key = `${m}/${row}_${col}`;
    if (tiles.has(key)) return tiles.get(key) ?? null;
    const img = new Image();
    tiles.set(key, null);
    img.onload = () => {
      tiles.set(key, img);
      setTick((n) => n + 1);
    };
    img.src = `${props.tilesBase}/${m}/${row}_${col}.png`;
    return null;
  };

  const draw = (): void => {
    const v = view();
    const { w, h } = size();
    const ctx = canvas.getContext("2d");
    if (ctx === null || v === null || w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = color("--grid");
    ctx.fillRect(0, 0, w, h);
    const m = map();
    const tilePx = TILE_PX * v.scale;
    // The lattice: tile edges where a tile is a few pixels wide, else the world's outline.
    ctx.strokeStyle = color("--gridline");
    ctx.lineWidth = 1;
    if (tilePx >= 6) {
      for (const t of visibleTiles(v, w, h)) {
        const a = toScreen(v, w, h, t.col * TILE_PX, t.row * TILE_PX);
        const img = m !== null && tilePx >= TILE_MIN_PX ? tileImage(m, t.row, t.col) : null;
        if (img !== null) ctx.drawImage(img, a.sx, a.sy, tilePx, tilePx);
        ctx.strokeRect(Math.round(a.sx) + 0.5, Math.round(a.sy) + 0.5, tilePx, tilePx);
      }
    } else {
      const a = toScreen(v, w, h, 0, 0);
      ctx.strokeRect(a.sx, a.sy, GRID * TILE_PX * v.scale, GRID * TILE_PX * v.scale);
    }
    // The selected session's units, under the pips.
    if (m !== null && props.selected !== null) {
      for (const d of nearby.dotsAt(props.now, m, [props.selected])) {
        const p = worldToPixel(d.x, d.y);
        const s = toScreen(v, w, h, p.px, p.py);
        ctx.fillStyle = color(NEARBY_TOKEN[d.cls]);
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, d.cls === "dead" ? 2 : 3, 0, Math.PI * 2);
        if (d.cls === "dead") {
          ctx.strokeStyle = ctx.fillStyle;
          ctx.stroke();
        } else ctx.fill();
      }
    }
    // The sessions, with their names.
    ctx.font = `${getComputedStyle(document.body).fontSize} ui-monospace, monospace`;
    for (const p of onMap()) {
      const s = toScreen(v, w, h, p.px, p.py);
      const sel = p.s.id === props.selected;
      ctx.fillStyle = color(p.live ? "--accent" : "--dim");
      ctx.beginPath();
      ctx.arc(s.sx, s.sy, sel ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = color("--fg");
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = color(p.live ? "--fg" : "--dim");
      ctx.fillText(sessionName(p.s), s.sx + 9, s.sy + 4);
    }
  };

  createEffect(() => {
    tick();
    view();
    onMap();
    props.selected;
    props.now;
    draw();
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });

  // Pan, zoom and pick.
  let drag: { x: number; y: number; moved: boolean } | null = null;
  const pick = (sx: number, sy: number): string | null => {
    const v = view();
    if (v === null) return null;
    let best: { id: string; d: number } | null = null;
    for (const p of onMap()) {
      const s = toScreen(v, size().w, size().h, p.px, p.py);
      const d = Math.hypot(s.sx - sx, s.sy - sy);
      if (d <= 12 && (best === null || d < best.d)) best = { id: p.s.id, d };
    }
    return best?.id ?? null;
  };
  const onPointerDown = (e: PointerEvent): void => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("drag");
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const v = view();
    if (v !== null && drag.moved) setView({ ...v, cx: v.cx - dx / v.scale, cy: v.cy - dy / v.scale });
  };
  const onPointerUp = (e: PointerEvent): void => {
    canvas.classList.remove("drag");
    const was = drag;
    drag = null;
    if (was === null || was.moved) return;
    const r = canvas.getBoundingClientRect();
    props.onSelect(pick(e.clientX - r.left, e.clientY - r.top));
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const v = view();
    if (v === null) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const at = fromScreen(v, size().w, size().h, sx, sy);
    const scale = clampScale(v.scale * Math.exp(-e.deltaY * 0.0015));
    // Keep the point under the pointer where it is.
    setView({ scale, cx: at.px - (sx - size().w / 2) / scale, cy: at.py - (sy - size().h / 2) / scale });
  };

  return (
    <div class="map-stage" ref={stage}>
      <canvas ref={canvas} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} />
      <Show when={maps().length > 1}>
        <div class="map-chips">
          <For each={maps()}>
            {(m) => (
              <button classList={{ on: m === map() }} onClick={() => setPinned(m)}>
                {props.mapName?.(m) ?? `map ${m}`} · {placed().filter((p) => p.map === m).length}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
