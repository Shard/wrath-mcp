/**
 * The source over a hosted gateway's state directory (`mcp/src/hosted/`):
 * every credential's session store, `<state>/tenants/<credential>/sessions`,
 * read as one. The operator sees them all; a user, the stores of the
 * credentials they hold (`credentialInScope`).
 *
 * Where a session is, not what it says, decides who sees it. Everything
 * under a credential's directory is written by that credential's host, which
 * runs the tenant's code, so none of it is believed:
 *
 *  - A session's id here is `<credential>.<directory>`, both from the path,
 *    never `session.json`'s own `id`, and the credential is checked against
 *    the scope before anything is read.
 *  - `owner` is shown and grants nothing; a record's `group` label is kept
 *    only within its credential, so no label can list one tenant's sessions
 *    with another's.
 *  - A session directory counts only when its real path is the path it is
 *    listed under, so a symlink at the credential, its `sessions` or the
 *    session cannot reach another credential's records or anything else the
 *    inspector can read. Inside a session, a stream directory must be one
 *    too, and `session.json`, `live.json` and every segment a read opens must
 *    be a plain file, not a link: checked before each read, not atomically
 *    with it, and a hard link is not a symlink (one to another tenant's file
 *    needs the writer to be able to read that file, which keeping each
 *    credential's directory to its own worker's user denies).
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LIVE_FILE, SESSION_FILE, listSegments, readSessionFile, type StreamName } from "@wrathbench/mcp/record/read";
import { credentialInScope, type SegmentInfo, type SessionEntry, type SessionHandle, type SessionScope, type SessionSource, type StreamStat, type TailBatch, type TimeRange } from "./source";
import { StoredSessionHandle, decodeCursor } from "./store-source";

/** A credential id as the grants file allows one (`PathId` in `grants-read.ts`): one safe path segment. */
const CREDENTIAL_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A session directory's name: 16 hex characters (`SessionStore`). */
const SESSION_DIR_RE = /^[0-9a-f]{16}$/;

/** A hosted session's id: its credential and its directory, both from the path. */
const HOSTED_ID_RE = /^([a-z0-9][a-z0-9_-]{0,62})\.([0-9a-f]{16})$/;

/** The id a hosted source lists a session by. */
export function hostedSessionId(credential: string, dir: string): string {
  return `${credential}.${dir}`;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether `path` is absent or a plain file: never a link, which could point anywhere the inspector can read. */
function plainOrAbsent(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st === undefined || (st.isFile() && !st.isSymbolicLink());
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * One hosted session directory, read only while it is where it was listed:
 * its real path the one it was opened at, its stream directories real ones,
 * and every file a read opens a plain file.
 */
class ConfinedSessionHandle extends StoredSessionHandle {
  /** Whether the directory, and the stream's directory when named, are still where they claim to be. */
  private intact(stream?: StreamName): boolean {
    if (real(this.dir) !== this.dir) return false;
    if (stream === undefined) return true;
    const s = join(this.dir, stream);
    const r = real(s);
    return r === null || r === s;
  }

  override async session() {
    return this.intact() && plainOrAbsent(join(this.dir, SESSION_FILE)) ? super.session() : null;
  }

  override async live() {
    return this.intact() && plainOrAbsent(join(this.dir, LIVE_FILE)) ? super.live() : null;
  }

  override async segments(stream: StreamName, range?: TimeRange): Promise<SegmentInfo[]> {
    return this.intact(stream) ? super.segments(stream, range) : [];
  }

  override async read<S extends StreamName>(stream: S, segments: readonly SegmentInfo[], o?: { kinds?: readonly string[] }) {
    if (!this.intact(stream)) return segments.map(() => []);
    const plain = new Set(listSegments(this.dir, stream).filter((r) => plainOrAbsent(r.path)).map((r) => join(this.dir, stream, r.stem)));
    const ok = segments.filter((s) => plain.has(s.ref));
    const rows = await super.read(stream, ok, o);
    const byRef = new Map(ok.map((s, i) => [s.ref, rows[i]!]));
    return segments.map((s) => byRef.get(s.ref) ?? []);
  }

  override async tail<S extends StreamName>(stream: S, cursor?: string | null): Promise<TailBatch<S>> {
    const refuse = { rows: [], cursor: cursor ?? null };
    if (!this.intact(stream)) return refuse;
    // The segments a tail from this cursor opens: its own and every later one.
    const segs = listSegments(this.dir, stream);
    const at = decodeCursor(cursor);
    const from = at === undefined ? 0 : segs.findIndex((s) => s.stem >= at.segment);
    if (from >= 0 && !segs.slice(from).every((s) => plainOrAbsent(s.path))) return refuse;
    return super.tail(stream, cursor);
  }

  override async end(stream: StreamName): Promise<string | null> {
    const newest = listSegments(this.dir, stream).at(-1);
    return this.intact(stream) && (newest === undefined || plainOrAbsent(newest.path)) ? super.end(stream) : null;
  }

  override async stat(stream: StreamName): Promise<StreamStat | null> {
    const newest = listSegments(this.dir, stream).at(-1);
    return this.intact(stream) && (newest === undefined || plainOrAbsent(newest.path)) ? super.stat(stream) : null;
  }
}

/**
 * A source over a hosted gateway's state directory: the sessions in every
 * `tenants/<credential>/sessions`, each listed as
 * `<credential>.<session directory>`, newest opened first.
 */
export function hostedSource(stateDir: string): SessionSource {
  const tenantsDir = join(stateDir, "tenants");

  /** A session's directory as its path names it, when that is where it really is; else null. */
  const sessionDir = (tenants: string, credential: string, dir: string): string | null => {
    const want = join(tenants, credential, "sessions", dir);
    return real(want) === want ? want : null;
  };

  return {
    async list(scope: SessionScope): Promise<SessionEntry[]> {
      const tenants = real(tenantsDir);
      if (tenants === null) return [];
      const out: SessionEntry[] = [];
      for (const credential of names(tenants)) {
        if (!CREDENTIAL_RE.test(credential) || !credentialInScope(credential, scope)) continue;
        for (const name of names(join(tenants, credential, "sessions"))) {
          if (!SESSION_DIR_RE.test(name)) continue;
          const dir = sessionDir(tenants, credential, name);
          if (dir === null) continue;
          const h = new ConfinedSessionHandle(hostedSessionId(credential, name), dir);
          const session = await h.session();
          if (session === null) continue;
          out.push({ id: h.id, session, live: await h.live(), ...(session.group !== undefined ? { group: `${credential}/${session.group}` } : {}) });
        }
      }
      return out.sort((a, b) => b.session.opened - a.session.opened);
    },

    async open(id: string, scope: SessionScope): Promise<SessionHandle | null> {
      const m = HOSTED_ID_RE.exec(id);
      if (m === null) return null;
      const [, credential, name] = m as unknown as [string, string, string];
      if (!credentialInScope(credential, scope)) return null;
      const tenants = real(tenantsDir);
      const dir = tenants === null ? null : sessionDir(tenants, credential, name);
      if (dir === null || !plainOrAbsent(join(dir, SESSION_FILE)) || readSessionFile(dir) === null) return null;
      return new ConfinedSessionHandle(id, dir);
    },
  };
}
