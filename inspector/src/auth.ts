/**
 * Who may read the inspector, and when it may start at all.
 *
 * Bound to loopback with no credential configured, it needs none: only this
 * machine can reach it, and whoever does is the operator. Bound to anything
 * else it refuses to start without a bearer secret, the module's own posture.
 *
 * Two kinds of credential, each presented as `Authorization: Bearer …` on a
 * request or once to the sign-in:
 *
 *  - **The operator's secret.** Whoever holds it sees every session.
 *  - **A hosted grant's key** (`wmk_…`, the key the person's MCP client
 *    holds), when the inspector is given the grants (`--grants`). Its holder
 *    is a user, and sees the session stores of every credential their person
 *    holds now (wrath-mcp#29). Read through the grants' read side, so the
 *    inspector authenticates exactly as the gateway does.
 *
 * Given grants, nothing is anonymous, loopback included: an inspector on
 * loopback behind a proxy for its tenants must not hand every visitor the
 * operator's view.
 *
 * A browser signs in once (`POST /api/sign-in`) and carries a cookie, since
 * its `EventSource` cannot send a header. The cookie is an opaque random id
 * and never the credential: the server keeps what it stands for in memory
 * (a restart signs everyone out), for a bounded time, and for a grant key
 * only the key's digest. Every request re-checks a key's grant, so a key
 * revoked, a grant disabled or removed, ends that cookie's access at its
 * next request. Sign-out forgets the id.
 *
 * The secret is never taken on the command line, where any process can read
 * it: from the environment or a file. Neither credential is ever read from a
 * URL's query, which would put it in logs and history.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { bearerKey, keyDigest, type GrantSet, type GrantSource } from "@wrathbench/mcp/hosted/grants-read";
import { OPERATOR, type SessionScope, type UserScope } from "./source";

/** The environment variable the bin reads the bearer secret from. */
export const SECRET_ENV = "WRATH_INSPECTOR_SECRET";

/** The cookie the sign-in sets: an opaque session id, HttpOnly and SameSite=Strict, never the credential. */
export const SESSION_COOKIE = "wrath_inspector";

/** How long a sign-in lasts before the browser must sign in again: twelve hours. */
export const SIGN_IN_TTL_MS = 12 * 60 * 60_000;

/** The most sign-ins held at once; past it the oldest is forgotten. */
export const MAX_SIGN_INS = 10_000;

/** Shorter than this is refused: a secret anyone could guess is no gate. */
export const MIN_SECRET_LENGTH = 16;

/** Whether `host` reaches only this machine: `localhost`, `127.0.0.0/8` or `::1`. `0.0.0.0` and `::` are every interface. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
}

/**
 * Why the inspector may not start bound to `host` with this secret, or null
 * when it may. With grants, a request without a credential is refused on any
 * bind, so the secret is then optional (without one, nobody is the operator).
 */
export function bindRefusal(host: string, secret: string | undefined, o: { grants?: boolean } = {}): string | null {
  const gated = !isLoopbackHost(host) || o.grants === true;
  if (!gated) return null;
  if (secret === undefined || secret.length === 0) return o.grants === true ? null : `bound to ${host}, which is not loopback, the inspector needs a bearer secret (${SECRET_ENV}, or --secret-file)`;
  if (secret.length < MIN_SECRET_LENGTH) return `the bearer secret must be at least ${MIN_SECRET_LENGTH} characters`;
  return null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Whether `candidate` is the secret, in constant time. */
export function isSecret(secret: string | undefined, candidate: string): boolean {
  return secret !== undefined && secret.length > 0 && same(candidate, secret);
}

/** The values of the sign-in cookie a request carries, in order. */
function cookieValues(req: Request): string[] {
  const out: string[] = [];
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) out.push(v.join("="));
  }
  return out;
}

/** A person's scope as the grants stand: the credentials they hold that are not disabled. */
export function userScope(set: GrantSet, person: string): UserScope {
  return { kind: "user", person, credentials: new Set(set.grants.filter((g) => g.person === person && g.disabled !== true).map((g) => g.id)) };
}

/** What a sign-in stands for: the operator, or one grant's key by its digest. */
type Signed = { kind: "operator"; expires: number } | { kind: "user"; grant: string; digest: string; person: string; expires: number };

/** Who a request is, and whether it came by the sign-in's cookie. */
export interface Caller {
  scope: SessionScope;
  /** Signed in by cookie, so signing out means something. */
  signedIn: boolean;
}

export interface InspectorAuthOptions {
  /** The operator's bearer secret. */
  secret?: string;
  /**
   * The hosted grants, for signing a person in with their key. A source with
   * `fresh()` (`FileGrantSource`) is asked on every request, so a change to
   * the file applies at the next one rather than the next poll.
   */
  grants?: GrantSource & { fresh?(): GrantSet };
  /** Whether a cookie set for this request's URL must be `Secure`. Defaults to over TLS only. */
  secureCookie?: (url: URL) => boolean;
  /** How long a sign-in lasts. Defaults to `SIGN_IN_TTL_MS`. */
  ttlMs?: number;
  now?: () => number;
}

/** Who may read, and the sign-in and sign-out a browser uses. */
export interface InspectorAuth {
  /** The scope of a request, or null to refuse it. */
  scope(req: Request): SessionScope | null;
  /** The scope and how it was presented, or null. */
  caller(req: Request): Caller | null;
  /** `POST` a credential (the `Authorization` header, or a JSON body `{ key }` or `{ secret }`): a cookie, or 401. */
  signIn(req: Request): Promise<Response>;
  /** `POST`: forget the cookie's sign-in, and clear it. */
  signOut(req: Request): Response;
  /** How many sign-ins are held. */
  readonly signIns: number;
}

/**
 * The inspector's credentials: the operator's secret, a hosted grant's key,
 * and the sign-in cookie that stands for either. With neither a secret nor
 * grants (loopback), every request is the operator.
 */
export function inspectorAuth(o: InspectorAuthOptions = {}): InspectorAuth {
  const secret = o.secret !== undefined && o.secret.length > 0 ? o.secret : undefined;
  const grants = o.grants;
  const open = secret === undefined && grants === undefined;
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? SIGN_IN_TTL_MS;
  const secureCookie = o.secureCookie ?? ((url: URL) => url.protocol === "https:");
  const held = new Map<string, Signed>();

  const grantSet = (): GrantSet | null => (grants === undefined ? null : (grants.fresh?.() ?? grants.current()));

  /** The scope a credential grants on its own, or null. */
  const ofCredential = (candidate: string): { scope: SessionScope; signed: Signed } | null => {
    const expires = now() + ttlMs;
    if (isSecret(secret, candidate)) return { scope: OPERATOR, signed: { kind: "operator", expires } };
    const set = grantSet();
    if (set === null) return null;
    const auth = set.authenticateKey(candidate);
    if (!auth.ok) return null;
    return { scope: userScope(set, auth.person), signed: { kind: "user", grant: auth.grant.id, digest: keyDigest(candidate), person: auth.person, expires } };
  };

  /** What a held sign-in grants now, or null when it has expired or its key no longer stands. */
  const ofSignIn = (id: string): SessionScope | null => {
    const s = held.get(id);
    if (s === undefined) return null;
    if (s.expires <= now()) {
      held.delete(id);
      return null;
    }
    if (s.kind === "operator") return secret === undefined ? null : OPERATOR;
    const set = grantSet();
    const auth = set?.authenticateDigest(s.digest);
    if (set === null || set === undefined || auth === undefined || !auth.ok || auth.grant.id !== s.grant || auth.person !== s.person) {
      held.delete(id);
      return null;
    }
    return userScope(set, s.person);
  };

  const caller = (req: Request): Caller | null => {
    if (open) return { scope: OPERATOR, signedIn: false };
    // A request that presents a header stands or falls by it.
    if (req.headers.get("authorization") !== null) {
      const key = bearerKey(req.headers);
      const hit = key === null ? null : ofCredential(key);
      return hit === null ? null : { scope: hit.scope, signedIn: false };
    }
    for (const id of cookieValues(req)) {
      const scope = ofSignIn(id);
      if (scope !== null) return { scope, signedIn: true };
    }
    return null;
  };

  const cookie = (url: URL, value: string, maxAge: number): string =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie(url) ? "; Secure" : ""}`;

  const prune = (): void => {
    const t = now();
    for (const [id, s] of held) if (s.expires <= t) held.delete(id);
    while (held.size >= MAX_SIGN_INS) held.delete(held.keys().next().value!);
  };

  return {
    scope: (req) => caller(req)?.scope ?? null,
    caller,
    get signIns() {
      return held.size;
    },

    async signIn(req) {
      if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
      // From the header, else a JSON body: never the URL. JSON only, so a form
      // on another site cannot post it without a preflight this server never grants.
      let candidate: unknown = null;
      if (req.headers.get("authorization") !== null) candidate = bearerKey(req.headers);
      else {
        if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return new Response("JSON only", { status: 415 });
        try {
          const body = (await req.json()) as { key?: unknown; secret?: unknown } | null;
          candidate = body?.key ?? body?.secret ?? null;
        } catch {
          return new Response("bad body", { status: 400 });
        }
      }
      if (open) return new Response(null, { status: 204 });
      const hit = typeof candidate === "string" && candidate.length > 0 ? ofCredential(candidate) : null;
      if (hit === null) return new Response("refused", { status: 401 });
      prune();
      const id = randomBytes(32).toString("base64url");
      held.set(id, hit.signed);
      return new Response(null, { status: 204, headers: { "set-cookie": cookie(new URL(req.url), id, Math.floor(ttlMs / 1000)), "cache-control": "no-store" } });
    },

    signOut(req) {
      if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
      for (const id of cookieValues(req)) held.delete(id);
      return new Response(null, { status: 204, headers: { "set-cookie": cookie(new URL(req.url), "", 0), "cache-control": "no-store" } });
    },
  };
}
