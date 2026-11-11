/**
 * Retention for a session store: unlink whole sessions that closed long ago,
 * never one still being written, the audit log's rule. The writing side's,
 * kept out of the store's read (`store.ts`) so nothing a reader imports can
 * delete.
 */

import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIVE_FILE } from "./format";
import type { SessionStore } from "./store";

/** How long a closed session is kept unless the operator says otherwise: three days, the audit log's default. */
export const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60_000;

/**
 * Unlink every closed session in `store` older than `retentionMs`, and return
 * their ids. Closed means `ended` is that old, or the writer died: `ended` is
 * null and its heartbeat (`live.json`, else `opened`) is. A session being
 * written beats every tick, so it is never one of these. `except` is the
 * session the caller is about to write.
 */
export function pruneSessions(store: SessionStore, retentionMs: number, o: { now?: number; except?: string } = {}): string[] {
  const now = o.now ?? Date.now();
  const pruned: string[] = [];
  for (const s of store.list()) {
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
