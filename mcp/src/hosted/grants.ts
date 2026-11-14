/**
 * Grants for hosted mode: who may use a hosted wrath-mcp, with which key, on
 * which accounts and within which limits (`docs/ARCHITECTURE.md`, "Hosted").
 * The format, its validation and authentication are the read side,
 * `grants-read.ts`, re-exported here whole; this module adds what mints a key
 * and writes the file, the grants CLI's half.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEY_PREFIX, keyDigest, parseGrantsFile, type GrantKeyHash, type GrantsFile } from "./grants-read";

export * from "./grants-read";

/** A new key, its id and its stored hash. The key itself is shown once and kept nowhere. */
export function newKey(o: { now?: Date; random?: (n: number) => Buffer } = {}): { key: string; hash: GrantKeyHash } {
  const random = o.random ?? randomBytes;
  const key = `${KEY_PREFIX}${random(32).toString("base64url")}`;
  return { key, hash: { id: random(6).toString("hex"), sha256: keyDigest(key), created: (o.now ?? new Date()).toISOString() } };
}

/**
 * Write a grants file whole, after validating it: 0600 in a 0700 directory,
 * by rename, so a reader never sees half a file and never a looser mode.
 */
export function writeGrantsFile(path: string, file: GrantsFile): void {
  const r = parseGrantsFile(file);
  if (!r.ok) throw new Error(`refusing to write grants that do not stand:\n  ${r.problems.join("\n  ")}`);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r.file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
