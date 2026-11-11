/**
 * The session store: a directory of session records, one per session, each
 * named by its session id (`docs/SESSION-FORMAT.md`). The standalone server
 * writes into one (`main.ts`, `--record-dir`); a harness that keeps its
 * evidence per run points a `SessionWriter` at a directory of its own
 * instead and needs none of this.
 *
 * What the store adds to a writer and a reader: the list of sessions, the
 * index of the deployment's own characters the write gate asks, and
 * retention, which unlinks whole sessions and only ones nobody is writing.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIVE_FILE, isPlayerGuid, type LiveFile, type SessionFile } from "./format";
import type { OwnGuid } from "./gate";
import { SessionReader, readSessionFile } from "./reader";

/** How long a closed session is kept unless the operator says otherwise: three days, the audit log's default. */
export const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60_000;

/** A session id is the 16 hex characters of a token fingerprint. */
const SESSION_ID_RE = /^[0-9a-f]{16}$/;

export interface StoredSession {
  id: string;
  dir: string;
  session: SessionFile;
  live: LiveFile | null;
}

/**
 * The guids that are sessions of one deployment, read from a set of session
 * directories and refreshed when a guid it does not know is asked for, at
 * most once every `refreshMs`. A guid it cannot place is foreign.
 */
export function ownGuidIndex(sessionDirs: () => string[], o: { refreshMs?: number; now?: () => number } = {}): OwnGuid {
  const refreshMs = o.refreshMs ?? 5_000;
  const now = o.now ?? Date.now;
  let known = new Set<string>();
  let readAt = -Infinity;
  return (guid) => {
    if (!isPlayerGuid(guid)) return false;
    if (known.has(guid)) return true;
    if (now() - readAt < refreshMs) return false;
    readAt = now();
    const next = new Set<string>();
    for (const dir of sessionDirs()) {
      const g = readSessionFile(dir)?.character?.guid;
      if (typeof g === "string") next.add(g);
    }
    known = next;
    return known.has(guid);
  };
}

export class SessionStore {
  constructor(readonly root: string) {}

  /** Where a session's record lives. */
  sessionDir(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new Error("a session id is 16 hex characters");
    return join(this.root, id);
  }

  private dirs(): string[] {
    try {
      return readdirSync(this.root).filter((n) => SESSION_ID_RE.test(n)).map((n) => join(this.root, n));
    } catch {
      return [];
    }
  }

  /** Every session in the store, newest first by when it was opened. */
  list(): StoredSession[] {
    const out: StoredSession[] = [];
    for (const dir of this.dirs()) {
      const reader = new SessionReader(dir);
      const session = reader.session();
      if (session !== null) out.push({ id: session.id, dir, session, live: reader.live() });
    }
    return out.sort((a, b) => b.session.opened - a.session.opened);
  }

  reader(id: string): SessionReader {
    return new SessionReader(this.sessionDir(id));
  }

  /** The write gate's question for sessions of this store: is this guid one of ours. */
  own(): OwnGuid {
    return ownGuidIndex(() => this.dirs());
  }

  /**
   * Unlink every closed session older than `retentionMs`, and return their
   * ids. Closed means `ended` is that old, or the writer died: `ended` is
   * null and its heartbeat (`live.json`, else `opened`) is. A session being
   * written beats every tick, so it is never one of these. `except` is the
   * session the caller is about to write.
   */
  prune(retentionMs: number, o: { now?: number; except?: string } = {}): string[] {
    const now = o.now ?? Date.now();
    const pruned: string[] = [];
    for (const s of this.list()) {
      if (s.id === o.except) continue;
      const beat = Math.max(s.live?.ts ?? 0, statSync(join(s.dir, LIVE_FILE), { throwIfNoEntry: false })?.mtimeMs ?? 0, s.session.opened);
      const last = s.session.ended ?? beat;
      if (now - last < retentionMs) continue;
      try {
        rmSync(s.dir, { recursive: true, force: true });
        pruned.push(s.id);
      } catch {
        /* the next start tries again */
      }
    }
    return pruned;
  }
}
