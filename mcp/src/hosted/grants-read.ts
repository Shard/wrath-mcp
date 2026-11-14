/**
 * Grants for hosted mode: who may use a hosted wrath-mcp, with which key, on
 * which accounts and within which limits (`docs/ARCHITECTURE.md`, "Hosted").
 *
 * A grant is one credential: one MCP client, one worker, one roster. A person
 * who wants two agents holds two grants, each with its own accounts. The
 * grant extends the fan-out grant (`FanoutGrant`) with who holds it and how
 * they prove it, and it is narrower than the operator's in three ways the
 * loader enforces rather than trusts the file for:
 *
 *  - **Never GM.** A grant that so much as names `allowGm` is refused, and
 *    `toFanoutGrant` never carries it, so no lease a gateway takes for a
 *    person asks the module for the opt-in.
 *  - **Disjoint accounts.** No account is in two grants, or in the file's
 *    `reservedAccounts` (every account the operator's own sessions lease on
 *    the same world). A create on an account reclaims it from whatever session
 *    holds it, so the assignment here is the only thing that keeps one
 *    person's characters out of another's reach. Compared case-insensitively,
 *    as the module compares account names.
 *  - **A few characters at once**: at most `TENANT_MAX_CHARACTERS`, and never
 *    more than the grant's accounts, even at 1.
 *
 * Keys are 32 random bytes, shown once when made and stored only as their
 * SHA-256, each with an id that the audit names. A high-entropy key needs no
 * slow hash, and a lookup by its digest leaks nothing an attacker can steer.
 * A key is read from `Authorization: Bearer` (the inspector's sign-in also
 * takes it in a POST body) and never from a query parameter, which would put
 * it in a URL.
 *
 * The file is the source of truth and is read whole. One that does not read
 * or validate grants nothing: a hand edit that breaks the file must not leave
 * a revoked key working (`FileGrantSource`).
 *
 * This is the read side: the format, its validation, and who a key belongs
 * to. Minting a key and writing the file are `grants.ts`'s, which re-exports
 * all of this, so a reader that only authenticates (the inspector's sign-in,
 * through `@wrathbench/mcp/hosted/grants-read`) loads nothing that writes.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { fanoutGrantProblem, type FanoutGrant } from "../fanout-grant";

/** The most characters one hosted credential may have in the world at once. */
export const TENANT_MAX_CHARACTERS = 5;

/** The most characters every hosted credential together may have in the world, unless the file says otherwise. */
export const DEFAULT_GLOBAL_MAX_CHARACTERS = 50;

/** The grants file's format version. */
export const GRANTS_FILE_VERSION = 1;

/** The environment variable naming the grants file, for the CLI and a gateway. */
export const GRANTS_FILE_ENV = "WRATH_MCP_GRANTS_FILE";

/** The limits a gateway holds a credential to. */
export interface HostedLimits {
  /** MCP requests per second, refilled continuously. */
  requestsPerSecond: number;
  /** How many requests may arrive at once before the rate applies. */
  burst: number;
  /** Tool calls running at once. */
  inFlight: number;
  /**
   * Leases of new sessions per hour: each character the gateway lets into
   * the world under a token it has not held. What a session does under its
   * own lease (a snippet's `deleteSession` and `createSession` again) is not
   * seen here; the module's per-lease action rate is what bounds that.
   */
  loginsPerHour: number;
  /** Minutes with no authenticated request before the credential's characters are logged out and its worker stopped. */
  idleMinutes: number;
}

export const DEFAULT_LIMITS: Readonly<HostedLimits> = Object.freeze({
  requestsPerSecond: 5,
  burst: 20,
  inFlight: 4,
  loginsPerHour: 20,
  idleMinutes: 30,
});

/**
 * An id that becomes a path segment (a credential's `tenants/<id>/`, a
 * person's `audit/<person>/`): lowercase letters, digits, `-` and `_`, starting
 * with a letter or digit, so it can never be `..`, hidden or two segments.
 */
const PathId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lowercase letters, digits, - and _, starting with a letter or digit, at most 63 characters");
const Account = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "an account name: letters, digits, - and _, at most 32 characters");
const KeyId = z.string().regex(/^[a-z0-9]{4,32}$/, "lowercase letters and digits, 4 to 32 characters");

const LimitsPatch = z.strictObject({
  requestsPerSecond: z.number().positive().optional(),
  burst: z.int().min(1).optional(),
  inFlight: z.int().min(1).optional(),
  loginsPerHour: z.int().min(1).optional(),
  idleMinutes: z.int().min(1).optional(),
});

const KeyHash = z.strictObject({
  id: KeyId,
  /** The lowercase hex SHA-256 of the key's UTF-8 bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters"),
  /** When the key was made, ISO 8601; for the operator's listing. */
  created: z.string().optional(),
});

const Grant = z.strictObject({
  /** The credential's id: its worker, its state directory, its audit lines. */
  id: PathId,
  /** Who holds it; one person may hold several credentials. */
  person: PathId,
  keyHashes: z.array(KeyHash),
  accounts: z.array(Account).min(1),
  maxCharacters: z.int().min(1).max(TENANT_MAX_CHARACTERS),
  /** Overrides of `DEFAULT_LIMITS`, each at most the file's `ceiling`. */
  limits: LimitsPatch.optional(),
  /** A disabled grant authenticates nothing and keeps its accounts. */
  disabled: z.boolean().optional(),
});

const GrantsFileSchema = z.strictObject({
  version: z.literal(GRANTS_FILE_VERSION),
  /** Accounts the operator's own sessions lease on this world: no grant may name one. */
  reservedAccounts: z.array(Account).default([]),
  /** Characters every credential together may have in the world at once. */
  globalMaxCharacters: z.int().min(1).default(DEFAULT_GLOBAL_MAX_CHARACTERS),
  /** The most any grant's `limits` may set; a default above it is lowered to it. */
  ceiling: LimitsPatch.optional(),
  grants: z.array(Grant),
});

export type TenantGrant = z.infer<typeof Grant>;
export type GrantKeyHash = z.infer<typeof KeyHash>;
export type GrantsFile = z.infer<typeof GrantsFileSchema>;

/** An empty grants file. */
export function emptyGrantsFile(): GrantsFile {
  return { version: GRANTS_FILE_VERSION, reservedAccounts: [], globalMaxCharacters: DEFAULT_GLOBAL_MAX_CHARACTERS, grants: [] };
}

/** The lowercase hex SHA-256 of a key, as the file stores it. */
export function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The prefix every key carries, so a leaked one is recognisable in a scan. */
export const KEY_PREFIX = "wmk_";

/** What a grant leases with: its accounts and character count, and never the GM opt-in. */
export function toFanoutGrant(g: TenantGrant): FanoutGrant {
  return { maxCharacters: g.maxCharacters, accounts: [...g.accounts] };
}

/** The limits a grant is held to: the defaults, lowered to the file's ceiling, then its own overrides. */
export function effectiveLimits(g: TenantGrant, file: Pick<GrantsFile, "ceiling">): HostedLimits {
  const out: HostedLimits = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(out) as (keyof HostedLimits)[]) {
    const cap = file.ceiling?.[k];
    if (cap !== undefined) out[k] = Math.min(out[k], cap);
    const own = g.limits?.[k];
    if (own !== undefined) out[k] = own;
  }
  return out;
}

function zodProblems(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(file)"}: ${i.message}`);
}

/**
 * The file as it stands, or every reason it cannot. Beyond its shape: no
 * grant names `allowGm`; ids, key ids and key hashes are unique; each grant's
 * accounts are distinct and at least its character count; no account is in
 * two grants or reserved; no override is above the ceiling.
 */
export function parseGrantsFile(raw: unknown): { ok: true; file: GrantsFile } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  // Named before the shape is checked, so the refusal says why rather than "unrecognised key".
  if (raw !== null && typeof raw === "object" && Array.isArray((raw as { grants?: unknown }).grants)) {
    for (const [i, g] of ((raw as { grants: unknown[] }).grants).entries()) {
      if (g !== null && typeof g === "object" && "allowGm" in g) {
        problems.push(`grants.${i}: a hosted grant never carries allowGm; GM use is the operator's own sessions' alone`);
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const parsed = GrantsFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: zodProblems(parsed.error) };
  const file = parsed.data;
  const ids = new Map<string, number>();
  const keyIds = new Map<string, string>();
  const digests = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const a of file.reservedAccounts) owner.set(a.toUpperCase(), "the operator's reserved accounts");
  for (const [i, g] of file.grants.entries()) {
    const where = `grant ${g.id}`;
    if (ids.has(g.id)) problems.push(`${where}: the id is used by another grant`);
    ids.set(g.id, i);
    for (const k of g.keyHashes) {
      const other = keyIds.get(k.id);
      if (other !== undefined) problems.push(`${where}: key id ${k.id} is also ${other}'s`);
      keyIds.set(k.id, g.id);
      const same = digests.get(k.sha256);
      if (same !== undefined) problems.push(`${where}: key ${k.id} has the same hash as a key of ${same}`);
      digests.set(k.sha256, g.id);
    }
    const fan = fanoutGrantProblem(toFanoutGrant(g));
    if (fan !== null) problems.push(`${where}: ${fan}`);
    else if (g.accounts.length < g.maxCharacters) problems.push(`${where}: ${g.maxCharacters} characters at once need ${g.maxCharacters} accounts, and ${g.accounts.length} is granted`);
    for (const a of g.accounts) {
      const held = owner.get(a.toUpperCase());
      if (held !== undefined && held !== where) problems.push(`${where}: account ${a} is also in ${held}; a create on an account takes it from whoever holds it, so no account is shared`);
      owner.set(a.toUpperCase(), where);
    }
    for (const [k, v] of Object.entries(g.limits ?? {}) as [keyof HostedLimits, number][]) {
      const cap = file.ceiling?.[k];
      if (cap !== undefined && v > cap) problems.push(`${where}: limits.${k} ${v} is above the ceiling, ${cap}`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, file };
}

/** Who a request is, or why it is nobody. */
export type Authentication =
  | { ok: true; person: string; grant: TenantGrant; keyId: string; limits: HostedLimits }
  | {
      ok: false;
      /** `no_key`: no `Authorization: Bearer`; `unknown_key`: a key no grant holds; `disabled`: a key of a disabled grant. */
      reason: "no_key" | "unknown_key" | "disabled";
      /** For a disabled grant's key, so the audit can name it. */
      keyId?: string;
      person?: string;
    };

/** The bearer key on a request, or null. Only the `Authorization` header is read. */
export function bearerKey(headers: Headers): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
  return m === null ? null : m[1]!;
}

/** The grants as one load of the file left them, indexed by key. Immutable. */
export class GrantSet {
  private readonly byDigest = new Map<string, { grant: TenantGrant; keyId: string }>();
  private readonly byId = new Map<string, TenantGrant>();

  constructor(
    readonly file: GrantsFile,
    /** Why the file did not load, when it did not: the set is then empty. */
    readonly problems: readonly string[] = [],
  ) {
    for (const g of file.grants) {
      this.byId.set(g.id, g);
      for (const k of g.keyHashes) this.byDigest.set(k.sha256, { grant: g, keyId: k.id });
    }
  }

  /** A set that grants nothing, with the reasons it is empty. */
  static refused(problems: readonly string[]): GrantSet {
    return new GrantSet(emptyGrantsFile(), problems);
  }

  get grants(): readonly TenantGrant[] {
    return this.file.grants;
  }

  grant(id: string): TenantGrant | undefined {
    return this.byId.get(id);
  }

  /** Who holds this key, if any grant does and it is not disabled. */
  authenticateKey(key: string | null): Authentication {
    if (key === null || key.length === 0) return { ok: false, reason: "no_key" };
    return this.authenticateDigest(keyDigest(key));
  }

  /**
   * Who holds the key with this digest (`keyDigest`), if any grant does and
   * it is not disabled: for a holder that remembers a key it checked once by
   * its digest rather than the key itself, as the inspector's sign-in does.
   */
  authenticateDigest(digest: string): Authentication {
    const hit = this.byDigest.get(digest);
    if (hit === undefined) return { ok: false, reason: "unknown_key" };
    if (hit.grant.disabled === true) return { ok: false, reason: "disabled", keyId: hit.keyId, person: hit.grant.person };
    return { ok: true, person: hit.grant.person, grant: hit.grant, keyId: hit.keyId, limits: effectiveLimits(hit.grant, this.file) };
  }
}

/** Where a gateway reads grants from. A file first; the operator's admin API may stand behind the same shape later. */
export interface GrantSource {
  /** The grants as of the last load. */
  current(): GrantSet;
  close(): void;
}

/**
 * Who sent this request: the single place a gateway authenticates, so another
 * scheme (MCP's OAuth authorization) can replace bearer keys without anything
 * behind it changing.
 */
export function authenticate(req: { headers: Headers }, source: GrantSource): Authentication {
  return source.current().authenticateKey(bearerKey(req.headers));
}

/** Read and validate a grants file. Throws with every problem when it does not stand. */
export function readGrantsFile(path: string): GrantsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`grants file ${path} does not read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = parseGrantsFile(raw);
  if (!r.ok) throw new Error(`grants file ${path} is refused:\n  ${r.problems.join("\n  ")}`);
  return r.file;
}

export interface FileGrantSourceOptions {
  /** How often the file is checked for a change; 0 never checks (call `reload`). Default 1000. */
  pollMs?: number;
  /** Told whenever a load leaves the source refusing everything, with why. */
  onProblem?: (problems: readonly string[]) => void;
  /** Told after every reload, with the set it left in force. */
  onReload?: (set: GrantSet) => void;
}

/**
 * Grants from a file, reloaded when it changes (checked by its modification
 * time, size and inode, so a rename into place is seen). The first load
 * throws on a file that does not stand, so a gateway does not start on one.
 * A later load that fails — a broken hand edit, a deleted file — fails
 * closed: the source grants nothing until the file stands again, because
 * keeping the last good grants would keep a just-revoked key working.
 */
export class FileGrantSource implements GrantSource {
  private set: GrantSet;
  private stamp: string;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly path: string,
    private readonly o: FileGrantSourceOptions = {},
  ) {
    this.stamp = this.stampNow();
    this.set = new GrantSet(readGrantsFile(path));
    const poll = o.pollMs ?? 1000;
    if (poll > 0) {
      this.timer = setInterval(() => {
        if (this.stampNow() !== this.stamp) this.reload();
      }, poll);
      this.timer.unref?.();
    }
  }

  private stampNow(): string {
    try {
      const s = statSync(this.path);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  current(): GrantSet {
    return this.set;
  }

  /**
   * The grants as the file stands now: reloaded first when it changed since
   * the last load (one stat), so a reader that must see a revocation on its
   * next request need not wait for the poll.
   */
  fresh(): GrantSet {
    if (this.stampNow() !== this.stamp) this.reload();
    return this.set;
  }

  /** Load the file again now. Returns the set it left in force. */
  reload(): GrantSet {
    this.stamp = this.stampNow();
    try {
      this.set = new GrantSet(readGrantsFile(this.path));
    } catch (err) {
      const problems = [err instanceof Error ? err.message : String(err)];
      this.set = GrantSet.refused(problems);
      this.o.onProblem?.(problems);
    }
    this.o.onReload?.(this.set);
    return this.set;
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }
}
