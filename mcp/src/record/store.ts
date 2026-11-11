/**
 * The session store: a directory of session records, one per session, each
 * named by its session id (`docs/SESSION-FORMAT.md`). The standalone server
 * writes into one (`main.ts`, `--record-dir`); a harness that keeps its
 * evidence per run points a `SessionWriter` at a directory of its own
 * instead and needs none of this.
 *
 * This is the store read: its sessions and a reader for each. What the
 * writing side adds over it, the index of the deployment's own characters the
 * write gate asks (`ownGuidIndex`, `gate.ts`) and retention, which unlinks
 * whole sessions (`retention.ts`), lives with the writer, so the record's read
 * side (`read.ts`) carries nothing that writes or deletes.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { LiveFile, SessionFile } from "./format";
import { SessionReader } from "./reader";

/** A session id is the 16 hex characters of a token fingerprint. */
const SESSION_ID_RE = /^[0-9a-f]{16}$/;

export interface StoredSession {
  id: string;
  dir: string;
  session: SessionFile;
  live: LiveFile | null;
}

export class SessionStore {
  constructor(readonly root: string) {}

  /** Where a session's record lives. */
  sessionDir(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new Error("a session id is 16 hex characters");
    return join(this.root, id);
  }

  /** The directories named as sessions, whether or not they hold a record yet. */
  dirs(): string[] {
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
}
