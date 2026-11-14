/**
 * Hosted sessions' tokens, recognisable by their fingerprint.
 *
 * The module names its audit files by a token's fingerprint, and a
 * deployment keeps them a few days (module/PROTOCOL.md, "Audit log"), where
 * the gateway's person audit, whose lease lines point at those files, is
 * kept 30. So every token a hosted session runs under has a fingerprint
 * starting `HOSTED_FINGERPRINT_PREFIX`: a deployment's retention can keep
 * those files as long as the person audit without keeping the operator's own
 * sessions' (about one in 65,536 of which share the prefix by chance and is
 * kept longer, which costs nothing). The gateway mints such tokens and
 * refuses a lease for any other, so not even a worker gone wrong can open a
 * session whose wire record is pruned early.
 *
 * Fixing 16 bits of a hash of a 128-bit random token leaves it as hard to
 * guess as before; finding one takes about 65,536 hashes, a few tens of
 * milliseconds, once per session.
 */

import { randomBytes } from "node:crypto";
import { tokenFingerprint } from "../module-auth";

export const HOSTED_FINGERPRINT_PREFIX = "0000";

/** Whether a token is a hosted session's: its fingerprint carries the prefix. */
export function isHostedToken(token: string): boolean {
  return tokenFingerprint(token).startsWith(HOSTED_FINGERPRINT_PREFIX);
}

/** A new random token whose fingerprint carries the hosted prefix. */
export function newHostedToken(random: (n: number) => Buffer = randomBytes): string {
  for (;;) {
    const t = random(16).toString("hex");
    if (isHostedToken(t)) return t;
  }
}
