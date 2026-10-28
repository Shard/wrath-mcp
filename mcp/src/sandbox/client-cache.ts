/**
 * The client's query-answer cache, kept across a sandbox restart the way a
 * real client keeps its on-disk cache (WDB). Operator decision, 2026-10-18.
 *
 * Why it has to exist: a restarted child reattaches to the module session its
 * predecessor left (a restart sends no `DELETE /session`), and the module's
 * per-session "already queried" sets survive the reattach, so the module
 * never asks for those entries again. A fresh SDK cache would then have no
 * name for any creature, object, item, player or pet the session had already
 * been answered about: a second wolf of a known entry walks into view
 * nameless, and one that leaves and returns stays nameless for the rest of
 * the session. A client never loses these answers, so neither does the child.
 *
 * What goes in: the answer frames themselves, exactly as this run's event
 * stream delivered them, for the eight query responses the SDK folds into a
 * cache (`CLIENT_CACHE_OPCODES`) — and only answers that told the cache
 * something (`keepsAnswer`). Nothing from the reference bundle or the
 * database, and nothing the stream did not carry. The newest answer for each
 * id wins, as it does in the SDK's own maps.
 *
 * Who holds it: the child is confined (`confine.ts`) and can neither read nor
 * write the run directory, so it forwards each answer to the host as it
 * arrives (`{ t: "client_cache" }`) and the host keeps the file
 * (`ClientCacheStore`), written on change, debounced, through a temp file and
 * a rename. When a child starts, the host hands it the store's frames before
 * it is ready (`{ t: "client_cache_seed" }`), and the child folds them through
 * the SDK's own `StateCache.apply` — the live path — before any event or
 * snippet reaches it.
 *
 * Scope: one file per run directory, `data/runs/<id>/client-cache.json`, and a
 * run is one account on one realm. A `--resume` reopens the same directory and
 * so the same file — the case where the bug bites hardest, since a provider
 * pause or a hard kill leaves the module session alive for the resume to
 * reattach to. A fresh run, scored or not, starts in an empty directory, and a
 * `--continue-from` continuation is a new run id on a new token and so a new
 * module session, which asks for every entry again: neither inherits another
 * run's file.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseEventFrame } from "@wrathbench/sdk";

export const CLIENT_CACHE_FILE = "client-cache.json";

/** The query answers the SDK keeps in a cache, and the id each is keyed by there. */
const KEY_FIELD: Readonly<Record<string, string>> = {
  SMSG_NAME_QUERY_RESPONSE: "guid",
  SMSG_CREATURE_QUERY_RESPONSE: "entry",
  SMSG_GAMEOBJECT_QUERY_RESPONSE: "entry",
  SMSG_ITEM_QUERY_SINGLE_RESPONSE: "itemId",
  SMSG_QUEST_QUERY_RESPONSE: "questId",
  SMSG_PET_NAME_QUERY_RESPONSE: "petNumber",
  SMSG_PAGE_TEXT_QUERY_RESPONSE: "pageId",
  SMSG_ITEM_TEXT_QUERY_RESPONSE: "guid",
};

export const CLIENT_CACHE_OPCODES: ReadonlySet<string> = new Set(Object.keys(KEY_FIELD));

/** One answer as the stream delivered it: the frame's own envelope and its decoded `data`. */
export interface ClientCacheFrame {
  seq: number;
  opcode: string;
  opcodeId: number;
  ts: number;
  data: unknown;
}

/**
 * Whether this frame is an answer the SDK's cache would keep: one of the eight
 * opcodes, decoded cleanly, and not a "not found" (which the SDK ignores, and
 * which must not replace an earlier answer for the same id here either).
 */
export function keepsAnswer(frame: { opcode: string; data: unknown; schemaError?: unknown }): boolean {
  if (!CLIENT_CACHE_OPCODES.has(frame.opcode)) return false;
  if (frame.schemaError !== undefined) return false;
  const d = frame.data;
  if (typeof d !== "object" || d === null) return false;
  const rec = d as Record<string, unknown>;
  if (rec["decodeError"] === true) return false;
  if (rec["found"] === false) return false;
  return clientCacheKey(frame) !== undefined;
}

/** The id the SDK keys this answer by, prefixed with its opcode; undefined when it carries none. */
export function clientCacheKey(frame: { opcode: string; data: unknown }): string | undefined {
  const field = KEY_FIELD[frame.opcode];
  if (field === undefined || typeof frame.data !== "object" || frame.data === null) return undefined;
  const id = (frame.data as Record<string, unknown>)[field];
  return typeof id === "string" || typeof id === "number" ? `${frame.opcode}:${id}` : undefined;
}

/**
 * A stored frame put back through the SDK's own frame parser, so a seed is
 * held to exactly what a live frame is held to. Null for anything that would
 * not fold: a malformed envelope, a payload this SDK revision rejects, or a
 * frame that is not a kept answer.
 */
export function reparseFrame(raw: unknown): ClientCacheFrame | null {
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  const parsed = parseEventFrame(text);
  if (!parsed.ok) return null;
  const e = parsed.event as { seq: number; opcode: string; opcodeId: number; ts: number; data: unknown; schemaError?: string };
  if (!keepsAnswer(e)) return null;
  return { seq: e.seq, opcode: e.opcode, opcodeId: e.opcodeId, ts: e.ts, data: e.data };
}

const FILE_VERSION = 1;
/**
 * At most one write per window. Each write is the whole file (a long freeplay
 * run's is a megabyte or two, on a network-backed volume), and the file is
 * only read by a resume: a restarted child is seeded from memory. What a hard
 * kill can cost is the answers of the last window, and only if the session
 * outlives the process; every orderly exit flushes.
 */
const WRITE_DEBOUNCE_MS = 5_000;

export interface ClientCacheStoreOptions {
  /** How long a change waits for others before the file is written. */
  debounceMs?: number;
  /** Where a failed read or write is reported. stderr by default. */
  log?: (line: string) => void;
}

/**
 * The host's copy of the client cache and the file behind it. Loaded once, at
 * construction; every frame added replaces the one for its id and schedules a
 * write. The write is the whole file to `<path>.tmp` and a rename over
 * `<path>`, so a reader — the next child's seed, a resumed run — sees the old
 * file or the new one and never half of either.
 */
export class ClientCacheStore {
  private readonly frames = new Map<string, ClientCacheFrame>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private readonly debounceMs: number;
  private readonly log: (line: string) => void;
  private writeFailed = false;

  constructor(
    readonly path: string,
    opts: ClientCacheStoreOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? WRITE_DEBOUNCE_MS;
    this.log = opts.log ?? ((line) => console.error(line));
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      // A cache is a convenience the server can always refill: an unreadable
      // one starts empty rather than costing the run.
      this.log(`[wrathbench] client cache at ${this.path} is unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const d = doc as { v?: unknown; frames?: unknown } | null;
    if (d === null || typeof d !== "object" || d.v !== FILE_VERSION || !Array.isArray(d.frames)) {
      this.log(`[wrathbench] client cache at ${this.path} is not a version ${FILE_VERSION} cache, starting empty`);
      return;
    }
    for (const raw of d.frames) {
      const frame = reparseFrame(raw);
      if (frame === null) continue;
      this.frames.set(clientCacheKey(frame)!, frame);
    }
  }

  /** The frames a new child is seeded with, oldest id first. */
  snapshot(): ClientCacheFrame[] {
    return [...this.frames.values()];
  }

  get size(): number {
    return this.frames.size;
  }

  /**
   * Take answers the child forwarded, each held to the parser a live frame
   * passes (`reparseFrame`); anything else is ignored.
   */
  add(frames: readonly unknown[]): void {
    let changed = false;
    for (const raw of frames) {
      const frame = reparseFrame(raw);
      if (frame === null) continue;
      const key = clientCacheKey(frame)!;
      // Delete first so a refreshed answer moves to the end: the file reads
      // in the order the answers last arrived.
      this.frames.delete(key);
      this.frames.set(key, frame);
      changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
      this.timer.unref?.();
    }
  }

  /** Write now if anything changed since the last write. Synchronous, so it is safe in an exit hook. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, frames: [...this.frames.values()] }));
      renameSync(tmp, this.path);
      this.writeFailed = false;
    } catch (err) {
      // Kept in memory either way, so a restarted child is still seeded; only
      // a resume would miss what did not reach the disk. Said once per streak.
      this.dirty = true;
      if (!this.writeFailed) {
        this.writeFailed = true;
        this.log(`[wrathbench] could not write the client cache to ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
