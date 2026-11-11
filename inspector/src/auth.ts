/**
 * Who may read the inspector, and when it may start at all.
 *
 * Bound to loopback it needs no credential: only this machine can reach it.
 * Bound to anything else it refuses to start without a bearer secret, the
 * module's own posture, and then every request must carry
 * `Authorization: Bearer <secret>` (or the cookie the page's sign-in sets
 * from it, since a browser's `EventSource` cannot send a header). Whoever
 * holds the secret is the operator and sees every session; a user's scope
 * (wrath-mcp#29, decision 11) comes with tenancy and is a different hook,
 * not a change to this one.
 *
 * The secret is never taken on the command line, where any process can read
 * it: from the environment or a file.
 */

import { timingSafeEqual } from "node:crypto";
import { OPERATOR, type SessionScope } from "./source";

/** The environment variable the bin reads the bearer secret from. */
export const SECRET_ENV = "WRATH_INSPECTOR_SECRET";

/** The cookie the page's sign-in sets: the secret itself, HttpOnly and SameSite=Strict. */
export const SESSION_COOKIE = "wrath_inspector";

/** Shorter than this is refused: a secret anyone could guess is no gate. */
export const MIN_SECRET_LENGTH = 16;

/** Whether `host` reaches only this machine: `localhost`, `127.0.0.0/8` or `::1`. `0.0.0.0` and `::` are every interface. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
}

/** Why the inspector may not start bound to `host` with this secret, or null when it may. */
export function bindRefusal(host: string, secret: string | undefined): string | null {
  if (isLoopbackHost(host)) return null;
  if (secret === undefined || secret.length === 0) return `bound to ${host}, which is not loopback, the inspector needs a bearer secret (${SECRET_ENV}, or --secret-file)`;
  if (secret.length < MIN_SECRET_LENGTH) return `the bearer secret must be at least ${MIN_SECRET_LENGTH} characters`;
  return null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The credential a request carries: its bearer token, else the sign-in cookie. */
export function presented(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth !== null) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    return m === null ? null : m[1]!;
  }
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * The scope of a request: the operator's for anyone when there is no secret
 * (loopback), else for whoever presents it, and null (refused) for anyone
 * who does not.
 */
export function bearerScope(secret: string | undefined): (req: Request) => SessionScope | null {
  if (secret === undefined || secret.length === 0) return () => OPERATOR;
  return (req) => {
    const p = presented(req);
    return p !== null && same(p, secret) ? OPERATOR : null;
  };
}

/** Whether `candidate` is the secret, in constant time. */
export function isSecret(secret: string | undefined, candidate: string): boolean {
  return secret !== undefined && secret.length > 0 && same(candidate, secret);
}
