/**
 * The host's side of the module's authentication (module/PROTOCOL.md,
 * "Authentication").
 *
 * Two credentials exist and this file keeps them apart:
 *
 *  - The **port secret**, `WRATHBENCH_MODULE_SECRET`, read from the
 *    environment (Bun loads it from the repo-root `.env`; docs/RUNBOOK.md
 *    "Secrets"). It is the operator class: the host process presents it on
 *    hygiene, `/health`, and to lease. It never reaches the snippet child —
 *    `sandboxChildEnv` does not forward it — because a snippet holding it could list and
 *    delete characters on any allowlisted account.
 *  - The **session secret**, leased per token with `POST /lease` and handed to
 *    the child as `WRATHBENCH_SECRET`. It is the only credential the child
 *    holds, and the module honours it for that token's `/session`, `/action`,
 *    `DELETE /session` and `/events` alone.
 *
 * Nothing here retries or hides a refusal: a module that says `401` to the
 * port secret is a misconfiguration the launch must surface, not paper over.
 */

import { createHash } from "node:crypto";

export const MODULE_SECRET_ENV = "WRATHBENCH_MODULE_SECRET";

/** The lowercase hex SHA-256 of the token's bytes, as the module hashes it. */
function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * How the module names a session wherever its token must not appear: `tok:`
 * and the first 8 hex characters of the token's SHA-256 (module/PROTOCOL.md,
 * "Authentication"). The worldserver log and every audit record carry it.
 * Enough to correlate one session's lines, and no more.
 */
export function tokenTag(token: string): string {
  return `tok:${tokenDigest(token).slice(0, 8)}`;
}

/**
 * The first 16 hex characters of the token's SHA-256: the stem of the
 * session's audit files (`<fingerprint>.<YYYY-MM-DD>.jsonl`, module/PROTOCOL.md
 * "Audit log") and of the standalone server's state directory. Its first 8
 * are `tokenTag`'s, so a log line's tag is a prefix of its file's name. Longer
 * than the tag because a file name must stay unique across every session the
 * audit directory holds, where the tag only tells one session's lines apart.
 */
export function tokenFingerprint(token: string): string {
  return tokenDigest(token).slice(0, 16);
}

/** The port secret, or undefined when the environment carries none. */
export function moduleSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env[MODULE_SECRET_ENV];
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * `Authorization: Bearer <port secret>` for an operator-class call, or an
 * empty object when there is no secret to send (a pre-auth module accepts
 * that; the hardened one answers `401 unauthorized`).
 */
export function moduleAuthHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const s = moduleSecret(env);
  return s === undefined ? {} : { authorization: `Bearer ${s}` };
}

export interface LeaseOptions {
  moduleUrl: string;
  token: string;
  account?: string;
  /**
   * The GM opt-in (module/PROTOCOL.md, "POST /lease"). The token's
   * session-class creates inherit it, so it is set here, by the holder of the
   * port secret, and never by the child. Absent or false is off.
   */
  allowGm?: boolean;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Waits between `/lease` attempts on an unreachable module; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits before each retry of `/lease` when the module cannot be reached: about
 * a minute in all. A run pod can start before its network path to the
 * worldserver is up (seen on the cluster: two of six pods refused at start, the
 * other four fine), and a run that starts without its secret never
 * authenticates, so it would play its whole episode blind.
 */
export const LEASE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export type LeaseOutcome =
  /** `allowGm` is the module's word on the opt-in: false from a module that predates it, whatever was asked. */
  | { secret: string; account: string; allowGm: boolean }
  /** No secret for the child, and why. The launch proceeds bare: a module that needs one refuses the child's first call, which is the honest failure. */
  | { secret: undefined; note: string };

/**
 * Lease this run's token: bind it to its account on the module and obtain the
 * session secret the sandbox child is built with.
 *
 * Degrades in exactly two cases, both named in `note`: no port secret in the
 * environment (nothing to lease with), or a module that answers `404
 * not_found` to `/lease` (it predates authentication, so it will not ask the
 * child for a secret either). Everything else — a refused port secret, a
 * refused account, a malformed answer — throws, because starting a run whose
 * child cannot authenticate would only burn the attempt later. An unreachable
 * module is retried over `LEASE_RETRY_DELAYS_MS` and then throws too: the
 * module is up for every other run, so the likeliest cause is this pod's own
 * network not being ready yet, and a bare launch would run the episode blind.
 */
export async function leaseSessionSecret(o: LeaseOptions): Promise<LeaseOutcome> {
  const env = o.env ?? process.env;
  const secret = moduleSecret(env);
  if (secret === undefined) {
    return { secret: undefined, note: `${MODULE_SECRET_ENV} is not set — no session secret leased; the snippet child authenticates with nothing (a pre-auth module only)` };
  }
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  let res: Response | undefined;
  let lastErr = "";
  for (let attempt = 0; attempt <= LEASE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(LEASE_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      res = await f(`${o.moduleUrl}/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          token: o.token,
          ...(o.account === undefined ? {} : { account: o.account }),
          ...(o.allowGm === true ? { allowGm: true } : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (res === undefined) {
    const waited = LEASE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 1000;
    throw new Error(`module unreachable for /lease after ${LEASE_RETRY_DELAYS_MS.length + 1} tries over ${waited}s (${lastErr}) — a run without its session secret cannot authenticate, so it does not start`);
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; secret?: unknown; account?: unknown; allowGm?: unknown } | null;
  if (res.status === 404 && body?.error === "not_found") {
    return { secret: undefined, note: "module predates /lease (404 not_found) — no session secret leased; it will not require one" };
  }
  if (!res.ok || body?.ok !== true || typeof body.secret !== "string" || typeof body.account !== "string") {
    throw new Error(`POST /lease for this run's token failed: HTTP ${res.status} ${body?.error ?? ""} — check ${MODULE_SECRET_ENV} matches the worldserver's WrathBench.Secret`);
  }
  return { secret: body.secret, account: body.account, allowGm: body.allowGm === true };
}

/**
 * Lease this run's session secret and register it for redaction in the same
 * step, so no caller can hold one without the other.
 *
 * The secret is handed to the snippet child in its environment, and a snippet
 * can read its own environment and print it; whatever it prints lands in the
 * trajectory, and from there in the derived store and the published feed. So
 * the value must be on the run's redaction list before the child exists. (What
 * it prints to stdout or stderr the sandbox host scrubs itself, with the same
 * `SecretRedactor`, before the job log; the same registration scrubs it from
 * every tool result and context message before the model reads them.) The session token beside it is deliberately not (run.ts says why: meta.json is
 * scrubbed with the same list and `--resume` reads the token back) — and it
 * authenticates nothing without this secret.
 */
export async function leaseRunSecret(
  o: LeaseOptions,
  sink: { redact(secret: string | undefined): void },
): Promise<LeaseOutcome> {
  const lease = await leaseSessionSecret(o);
  sink.redact(lease.secret);
  return lease;
}

/**
 * Best effort: log the token's character out (`DELETE /session` with the port
 * secret, the operator class, so it works however wedged the sandbox child
 * is). The same disconnect a client's makes; the core saves the character.
 * Never throws; a token with no session is `404 no_session`, which is fine.
 */
export async function logoutSession(o: Omit<LeaseOptions, "account">): Promise<void> {
  try {
    await (o.fetch ?? fetch)(`${o.moduleUrl}/session`, {
      method: "DELETE",
      headers: { "content-type": "application/json", ...moduleAuthHeaders(o.env ?? process.env) },
      body: JSON.stringify({ token: o.token }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // the module is gone or slow: a reclaiming create takes the account over
  }
}

/** Best effort: forget the token's lease at the end of a run. Never throws. */
export async function releaseSessionSecret(o: Omit<LeaseOptions, "account">): Promise<void> {
  const secret = moduleSecret(o.env ?? process.env);
  if (secret === undefined) return;
  try {
    await (o.fetch ?? fetch)(`${o.moduleUrl}/lease`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ token: o.token }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // the lease is one small record on the module; the next deploy clears it
  }
}

/** What the module says of itself on `GET /health`, for `session.json`; null when it does not answer. */
export async function moduleIdentity(moduleUrl: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<{ build: string | null; protocol: number | null } | null> {
  try {
    const res = await fetchImpl(new URL("/health", moduleUrl), { headers, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { build?: unknown; protocol?: unknown };
    return { build: typeof j.build === "string" ? j.build : null, protocol: typeof j.protocol === "number" ? j.protocol : null };
  } catch {
    return null;
  }
}
