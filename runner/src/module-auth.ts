/**
 * The runner's side of the module's authentication (module/PROTOCOL.md,
 * "Authentication").
 *
 * Two credentials exist and this file keeps them apart:
 *
 *  - The **port secret**, `WRATHBENCH_MODULE_SECRET`, read from the
 *    environment (Bun loads it from the repo-root `.env`; docs/RUNBOOK.md
 *    "Secrets"). It is the operator class: the host process presents it on
 *    hygiene, `/health`, and to lease. It never reaches the snippet child —
 *    `sandboxChildEnv` drops it — because a snippet holding it could list and
 *    delete characters on any allowlisted account.
 *  - The **session secret**, leased per token with `POST /lease` and handed to
 *    the child as `WRATHBENCH_SECRET`. It is the only credential the child
 *    holds, and the module honours it for that token's `/session`, `/action`,
 *    `DELETE /session` and `/events` alone.
 *
 * Nothing here retries or hides a refusal: a module that says `401` to the
 * port secret is a misconfiguration the launch must surface, not paper over.
 */

export const MODULE_SECRET_ENV = "WRATHBENCH_MODULE_SECRET";

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
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export type LeaseOutcome =
  | { secret: string; account: string }
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
 * child cannot authenticate would only burn the attempt later.
 */
export async function leaseSessionSecret(o: LeaseOptions): Promise<LeaseOutcome> {
  const env = o.env ?? process.env;
  const secret = moduleSecret(env);
  if (secret === undefined) {
    return { secret: undefined, note: `${MODULE_SECRET_ENV} is not set — no session secret leased; the snippet child authenticates with nothing (a pre-auth module only)` };
  }
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.moduleUrl}/lease`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(o.account === undefined ? { token: o.token } : { token: o.token, account: o.account }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Unreachable module: hygiene and createSession will say the same thing
    // in their own words; nothing is gained by failing here first.
    return { secret: undefined, note: `module unreachable for /lease (${err instanceof Error ? err.message : String(err)}) — no session secret leased` };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; secret?: unknown; account?: unknown } | null;
  if (res.status === 404 && body?.error === "not_found") {
    return { secret: undefined, note: "module predates /lease (404 not_found) — no session secret leased; it will not require one" };
  }
  if (!res.ok || body?.ok !== true || typeof body.secret !== "string" || typeof body.account !== "string") {
    throw new Error(`POST /lease for this run's token failed: HTTP ${res.status} ${body?.error ?? ""} — check ${MODULE_SECRET_ENV} matches the worldserver's WrathBench.Secret`);
  }
  return { secret: body.secret, account: body.account };
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
