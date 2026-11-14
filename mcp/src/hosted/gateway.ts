/**
 * The hosted gateway: serves the stack's tools to people other than the
 * operator, over Streamable HTTP, each authenticated by a key of their own
 * (`docs/ARCHITECTURE.md`, "Hosted"; `docs/CONTRACTS.md`,
 * "Control-surface authentication").
 *
 * It is the only holder of the port secret. For each credential it starts
 * a worker (`worker.ts`, through a `WorkerProvider`) on the first tool call,
 * which runs the credential's host (`host.ts`: the confined sandbox, the
 * record, the roster and the program) holding only the lease secrets it is
 * handed. Every lease that host takes is asked of this gateway over the
 * worker's channel and goes through its leaser, which holds it to the grant
 * whatever the worker asks: the account must be the credential's, the token
 * no other credential's, the characters within the grant's count and the
 * deployment's cap, the logins within the hourly limit, and the GM opt-in is
 * never sent.
 *
 * What it keeps, all under its state directory and none of it under
 * `tenants/`, which belongs to the credentials' hosts and is never read
 * back for a token, an account or an owner:
 *
 * - `ledger.json` (0600): every lease it holds, by credential and person,
 *   with the token, so a restart can log each out and give it back. Nothing
 *   survives a restart in this process, so on start every seat is released.
 * - `audit/<person>/<YYYY-MM-DD>.jsonl`: authentications (failures under
 *   `_unauthenticated` unless the key names a person), every request and
 *   tool call (its id is the call's dispatch stamp, which the session
 *   record's `calls` carry too, and the arguments only as a size and a hash),
 *   leases, releases, limit refusals, idle stops, revocations and world
 *   restarts. Kept `auditRetentionDays` (30). Lease lines carry the token's
 *   fingerprint, which names the module's own audit files, so the two join
 *   without the module ever learning a person.
 * - `tenants/<credential>/state` and `tenants/<credential>/sessions`: the
 *   host's state directory and its own session store, so one credential's
 *   characters are another's foreign players.
 *
 * Limits (`HostedLimits`, per grant): a token bucket on requests (`429`), a
 * cap on tool calls running or waiting (calls of one credential run one at a
 * time, as the stdio server runs them), logins an hour, and an idle stop:
 * with no authenticated request for `idleMinutes`, the host is shut and its
 * characters logged out. A program's routines run between requests, which
 * is the point of them; idle is measured from the person, not the game.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clipStrings } from "../clip";
import { hostToolDefs, type HostSurface } from "../host";
import { MODULE_SECRET_ENV, moduleAuthHeaders, moduleIdentity, moduleSecret, portSecretLeaser, tokenFingerprint, type Leaser, type LeaseOutcome } from "../module-auth";
import type { ToolResult } from "../tools";
import { pruneSessions } from "../record/retention";
import { SessionStore } from "../record/store";
import { MCP_PACKAGE_VERSION } from "../version";
import { authenticate, toFanoutGrant, type Authentication, type GrantSource, type HostedLimits, type TenantGrant } from "./grants";
import { serveMcpPost, type CallRefusal, type McpEndpoint } from "./http";
import { isHostedToken, newHostedToken } from "./tokens";
import { connectWorker, localWorkers, newWorkerSecret, type CredentialHost, type WorkerProvider } from "./workers";

/** The person audit's directory for a request no key named a person for. */
export const UNAUTHENTICATED = "_unauthenticated";

/** How long the person audit is kept. */
export const AUDIT_RETENTION_DAYS = 30;

/** The largest request body the gateway reads. A file the program writes is at most 32,000 characters. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * The most characters any string in a person audit line keeps (a tool name,
 * a character, an `Origin`, an error), cut with a marker past it: every
 * line's size is the gateway's, whatever a client sends.
 */
export const AUDIT_STRING_MAX = 256;

/**
 * Refused requests (no key, a wrong or disabled key, a foreign `Origin`) are
 * audited a line per kind and address per window, not a line each: the first
 * is written whole and the rest counted into one `refused-summary` line.
 */
export const REFUSAL_WINDOW_MS = 60_000;

/** The most kinds and addresses a refusal window tells apart; past it, the rest share one count. */
export const REFUSAL_KEYS_MAX = 1_000;

// ------------------------------------------------------------------ audit

/** The per-person audit: one JSON object a line, a file a person a day. */
export class PersonAudit {
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly retentionDays = AUDIT_RETENTION_DAYS,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private queue: Promise<void> = Promise.resolve();

  /** One line, every string in it cut to `AUDIT_STRING_MAX`, and where it goes. */
  private place(person: string | null, line: Record<string, unknown>): { dir: string; file: string; text: string } {
    const ts = this.now();
    const day = new Date(ts).toISOString().slice(0, 10);
    const dir = join(this.dir, person ?? UNAUTHENTICATED);
    return { dir, file: join(dir, `${day}.jsonl`), text: `${JSON.stringify(clipStrings({ ts, ...line }, { max: AUDIT_STRING_MAX }))}\n` };
  }

  write(person: string | null, line: Record<string, unknown>): void {
    const { dir, file, text } = this.place(person, line);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, text, { mode: 0o600 });
    } catch {
      // An audit that cannot be written must not take a person's call down with it; the gateway's own log says so.
    }
  }

  /**
   * The same line, written off the event loop: for what an unauthenticated
   * caller can cause, so a flood of them never waits on the disk. Lines
   * written this way keep their order among themselves.
   */
  writeAsync(person: string | null, line: Record<string, unknown>): void {
    const { dir, file, text } = this.place(person, line);
    this.queue = this.queue
      .then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await appendFile(file, text, { mode: 0o600 });
      })
      .catch(() => {});
  }

  /** Settles once every line `writeAsync` was given is written. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Remove day files older than the retention. Returns how many went. */
  prune(): number {
    const cutoff = new Date(this.now() - this.retentionDays * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const person of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      const dir = join(this.dir, person);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m !== null && m[1]! < cutoff) {
          rmSync(join(dir, f), { force: true });
          n++;
        }
      }
    }
    return n;
  }
}

/**
 * Refusals, audited cheaply: per window, the first refusal of each kind from
 * each address (and, for a key that named one, each person) is written
 * whole, the rest are counted, and the count is written as one
 * `refused-summary` line when the window has passed and the next refusal of
 * that kind arrives, at the sweep, or at stop. Nothing here waits on disk.
 */
export class RefusalAudit {
  private readonly windows = new Map<string, { person: string | null; line: Record<string, unknown>; first: number; count: number }>();

  constructor(
    private readonly audit: PersonAudit,
    private readonly now: () => number = Date.now,
  ) {}

  note(person: string | null, line: Record<string, unknown>): void {
    const now = this.now();
    let key = JSON.stringify([person, line["kind"], line["why"] ?? line["reason"], line["remote"]]);
    if (!this.windows.has(key) && this.windows.size >= REFUSAL_KEYS_MAX) {
      key = "overflow";
      person = null;
      line = { kind: "refused", why: "many kinds and addresses" };
    }
    const w = this.windows.get(key);
    if (w !== undefined && now - w.first < REFUSAL_WINDOW_MS) {
      w.count++;
      return;
    }
    if (w !== undefined) this.summarize(w, now);
    this.windows.set(key, { person, line, first: now, count: 0 });
    this.audit.writeAsync(person, line);
  }

  /** Write the count of every window that has passed (all of them with `all`), and forget them. */
  flush(all = false): void {
    const now = this.now();
    for (const [key, w] of this.windows) {
      if (!all && now - w.first < REFUSAL_WINDOW_MS) continue;
      this.summarize(w, now);
      this.windows.delete(key);
    }
  }

  private summarize(w: { person: string | null; line: Record<string, unknown>; first: number; count: number }, now: number): void {
    if (w.count === 0) return;
    const { kind: _kind, ...rest } = w.line;
    this.audit.writeAsync(w.person, { kind: "refused-summary", ...rest, more: w.count, since: w.first, until: now });
  }
}

// ----------------------------------------------------------------- ledger

/** One lease the gateway holds. The token never leaves the gateway's own state. */
export interface Seat {
  credential: string;
  person: string;
  account: string;
  token: string;
  /** `tokenFingerprint(token)`: the stem of the module's audit files for it. */
  fingerprint: string;
  leasedAt: number;
}

/** The leases the gateway holds, written whole (0600, by rename) whenever they change. */
export class Ledger {
  private readonly bySeat = new Map<string, Seat>();

  constructor(readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { seats?: unknown };
      for (const s of Array.isArray(raw.seats) ? raw.seats : []) {
        const seat = s as Seat;
        if (typeof seat?.token === "string" && typeof seat.credential === "string" && typeof seat.account === "string") this.bySeat.set(seat.token, seat);
      }
    } catch {
      // No ledger yet, or one that does not read: nothing is known to be held.
    }
  }

  seats(): Seat[] {
    return [...this.bySeat.values()];
  }

  of(credential: string): Seat[] {
    return this.seats().filter((s) => s.credential === credential);
  }

  get(token: string): Seat | undefined {
    return this.bySeat.get(token);
  }

  add(seat: Seat): void {
    this.bySeat.set(seat.token, seat);
    this.save();
  }

  remove(token: string): Seat | undefined {
    const seat = this.bySeat.get(token);
    if (seat !== undefined) {
      this.bySeat.delete(token);
      this.save();
    }
    return seat;
  }

  private save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ seats: this.seats() }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

// ---------------------------------------------------------------- tenants

interface Tenant {
  id: string;
  person: string;
  grant: TenantGrant;
  limits: HostedLimits;
  /** The request bucket: tokens left and when it was last filled. */
  bucket: { tokens: number; at: number };
  lastSeen: number;
  /** Tool calls running or waiting. */
  pending: number;
  /** Calls, opens and stops of this credential's host, one at a time. */
  chain: Promise<unknown>;
  host: CredentialHost | undefined;
  /** The last dispatch stamp handed out: strictly increasing, the call's key in the record and the audit. */
  lastDispatchTs: number;
  /** When each lease of the last hour was taken. */
  logins: number[];
}

/** What changes a credential's host: its accounts and character count. Keys and limits do not. */
const hostShape = (g: TenantGrant): string => JSON.stringify({ accounts: g.accounts.map((a) => a.toUpperCase()), maxCharacters: g.maxCharacters });

export interface GatewayOptions {
  grants: GrantSource;
  /** `ledger.json`, `audit/` and `tenants/` live here. */
  stateDir: string;
  moduleUrl: string;
  /** Where the port secret is read from (`WRATHBENCH_MODULE_SECRET`). Default the process's. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Serve the program's tools beside the core ones. Default true. */
  program?: boolean;
  /** `Origin` values a browser-borne request may carry; any other present `Origin` is refused `403`. Default none. */
  allowedOrigins?: readonly string[];
  /** How long a credential's session records are kept. Default three days. */
  recordRetentionMs?: number;
  /** How often credentials' directories are pruned (`pruneTenants`), at most. Default an hour. */
  storePruneMs?: number;
  /** How often idle credentials, changed grants and the world's restarts are checked. Default 30 s; 0 never (call `sweep`). */
  sweepMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Starts each credential's worker. Default `localWorkers()`: a process per credential on this machine. */
  workers?: WorkerProvider;
  snippetTimeoutMs?: number;
}

/** Why a lease was refused before the module was asked. */
export class LeaseRefused extends Error {}

export class Gateway {
  readonly audit: PersonAudit;
  readonly refusals: RefusalAudit;
  readonly ledger: Ledger;
  private readonly tenants = new Map<string, Tenant>();
  private readonly base: Leaser;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The worldserver's start as `/health` last said it; a change means every lease is gone. */
  private worldStartedAt: number | undefined;
  private sweeping = false;
  private lastStorePrune = 0;
  /** The last lease refusal of each credential's host while it opens: what the person is told when the open fails. */
  private readonly refused = new Map<string, string>();
  /**
   * Leases asked for and not yet answered, by token, with their credential:
   * counted against every cap as if held, so concurrent asks cannot all pass
   * a check made before any of them is answered.
   */
  private readonly leasing = new Map<string, string>();
  private defaultWorkers: WorkerProvider | undefined;

  constructor(private readonly o: GatewayOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((line) => console.error(`[wrath-mcp gateway] ${line}`));
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(o.stateDir, "tenants"), { recursive: true, mode: 0o700 });
    this.audit = new PersonAudit(join(o.stateDir, "audit"), this.now);
    this.refusals = new RefusalAudit(this.audit, this.now);
    this.ledger = new Ledger(join(o.stateDir, "ledger.json"));
    if (moduleSecret(o.env ?? process.env) === undefined) {
      // Without it no lease is taken, no seat is recorded, and every limit that counts seats counts nothing.
      throw new Error(`${MODULE_SECRET_ENV} is not set: the gateway leases every character with the module's port secret and does not start without it`);
    }
    this.base = portSecretLeaser({ moduleUrl: o.moduleUrl, ...(o.env !== undefined ? { env: o.env } : {}), ...(o.fetch !== undefined ? { fetch: o.fetch } : {}) });
  }

  /**
   * Release every seat the ledger holds (nothing it names survived this
   * process), prune the audit, and start the sweep.
   */
  async start(): Promise<void> {
    for (const seat of this.ledger.seats()) {
      await this.base.logout(seat.token);
      await this.base.release(seat.token);
      this.ledger.remove(seat.token);
      this.audit.write(seat.person, { kind: "release", why: "gateway restart", credential: seat.credential, account: seat.account, fingerprint: seat.fingerprint });
    }
    const pruned = this.audit.prune();
    if (pruned > 0) this.log(`removed ${pruned} audit file(s) past ${AUDIT_RETENTION_DAYS} days`);
    this.worldStartedAt = await this.worldStart();
    const every = this.o.sweepMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep(), every);
      this.timer.unref?.();
    }
  }

  /** Stop every host, logging its characters out and giving their leases back. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await Promise.all([...this.tenants.values()].map((t) => this.stopHost(t, "gateway stopping")));
    this.refusals.flush(true);
    await this.audit.settled();
  }

  /**
   * The checks the timer runs: grants removed, disabled, left with no key or
   * reshaped (their hosts stop), credentials idle past their limit (theirs too), the world
   * restarted (every host stops: the module forgot every lease), the
   * audit's retention, and, at most every `storePruneMs`, the credentials'
   * own directories (`pruneTenants`).
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const set = this.o.grants.current();
      const now = this.now();
      for (const t of this.tenants.values()) {
        const g = set.grant(t.id);
        // A grant whose last key was revoked can never be called again: what its key left running stops too.
        if (g === undefined || g.disabled === true || g.keyHashes.length === 0) {
          if (t.host !== undefined) await this.stopHost(t, g === undefined ? "grant removed" : g.disabled === true ? "grant disabled" : "every key revoked");
          this.tenants.delete(t.id);
          continue;
        }
        if (hostShape(g) !== hostShape(t.grant) && t.host !== undefined) await this.stopHost(t, "grant changed");
        t.grant = g;
        if (t.host !== undefined && now - t.lastSeen > t.limits.idleMinutes * 60_000) await this.stopHost(t, "idle");
      }
      const started = await this.worldStart();
      if (started !== undefined && this.worldStartedAt !== undefined && started !== this.worldStartedAt) {
        this.log("the worldserver restarted: every lease is gone, so every host stops and opens again at its next call");
        for (const t of this.tenants.values()) if (t.host !== undefined) await this.stopHost(t, "world restarted");
      }
      if (started !== undefined) this.worldStartedAt = started;
      this.refusals.flush();
      this.audit.prune();
      if (now - this.lastStorePrune >= (this.o.storePruneMs ?? 3_600_000)) {
        this.lastStorePrune = now;
        this.pruneTenants(set);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async worldStart(): Promise<number | undefined> {
    try {
      const res = await (this.o.fetch ?? fetch)(new URL("/health", this.o.moduleUrl), { headers: moduleAuthHeaders(this.o.env ?? process.env), signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return undefined;
      const j = (await res.json()) as { startedAtMs?: unknown };
      return typeof j.startedAtMs === "number" ? j.startedAtMs : undefined;
    } catch {
      return undefined;
    }
  }

  /** The tools a credential is served: a function of its grant alone. */
  surfaceOf(g: TenantGrant): HostSurface {
    return { fanout: g.maxCharacters > 1, program: this.o.program !== false };
  }

  // -------------------------------------------------------------- HTTP

  /** Answer one HTTP request. `remote` is the peer's address, for the audit. */
  async fetch(req: Request, remote?: string): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (url.pathname !== "/mcp") return Response.json({ error: "not_found" }, { status: 404 });
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const origin = req.headers.get("origin");
    if (origin !== null && !(this.o.allowedOrigins ?? []).includes(origin)) {
      this.refusals.note(null, { kind: "refused", why: "origin", origin, remote });
      return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "origin not allowed" } }, { status: 403 });
    }
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request body over ${MAX_BODY_BYTES} bytes` } }, { status: 413 });
    const auth = authenticate(req, this.o.grants);
    if (!auth.ok) {
      this.refusals.note(auth.person ?? null, { kind: "auth", ok: false, reason: auth.reason, ...(auth.keyId !== undefined ? { keyId: auth.keyId } : {}), remote });
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.reason === "disabled" ? "this key's grant is disabled" : "a valid key is required: Authorization: Bearer <key>" } },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="wrath-mcp"' } },
      );
    }
    const t = this.tenantFor(auth);
    t.lastSeen = this.now();
    if (!this.takeRequest(t)) {
      this.audit.write(t.person, { kind: "refused", why: "request rate", credential: t.id, keyId: auth.keyId, remote });
      const retry = Math.max(1, Math.ceil(1 / t.limits.requestsPerSecond));
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: `over ${t.limits.requestsPerSecond} requests a second (burst ${t.limits.burst}); slow down` } },
        { status: 429, headers: { "retry-after": String(retry) } },
      );
    }
    return serveMcpPost(req, this.endpoint(t, auth.keyId, remote), (n) => {
      if (n.method !== "tools/call" || n.status !== 200) this.audit.write(t.person, { kind: "request", credential: t.id, keyId: auth.keyId, remote, era: n.era, method: n.method, version: n.version, status: n.status, ...(n.error !== undefined ? { error: n.error } : {}) });
    });
  }

  private tenantFor(auth: Extract<Authentication, { ok: true }>): Tenant {
    let t = this.tenants.get(auth.grant.id);
    if (t === undefined) {
      t = { id: auth.grant.id, person: auth.person, grant: auth.grant, limits: auth.limits, bucket: { tokens: auth.limits.burst, at: this.now() }, lastSeen: this.now(), pending: 0, chain: Promise.resolve(), host: undefined, lastDispatchTs: 0, logins: [] };
      this.tenants.set(t.id, t);
    }
    t.person = auth.person;
    t.limits = auth.limits;
    return t;
  }

  private takeRequest(t: Tenant): boolean {
    const now = this.now();
    const b = t.bucket;
    b.tokens = Math.min(t.limits.burst, b.tokens + ((now - b.at) / 1000) * t.limits.requestsPerSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private endpoint(t: Tenant, keyId: string, remote: string | undefined): McpEndpoint {
    return {
      serverInfo: { name: "wrath-mcp", version: MCP_PACKAGE_VERSION },
      list: () => hostToolDefs(this.surfaceOf(t.grant)),
      call: (name, args) => this.call(t, keyId, remote, name, args),
    };
  }

  private serial<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
    const run = t.chain.then(fn, fn);
    t.chain = run.catch(() => undefined);
    return run;
  }

  private async call(t: Tenant, keyId: string, remote: string | undefined, name: string, args: unknown): Promise<{ result: ToolResult } | { refused: CallRefusal }> {
    if (t.pending >= t.limits.inFlight) {
      this.audit.write(t.person, { kind: "refused", why: "calls in flight", credential: t.id, keyId, remote, tool: name });
      return { refused: { status: 429, message: `${t.pending} calls are already running or waiting for this key (at most ${t.limits.inFlight}); wait for one to answer`, retryAfterS: 1 } };
    }
    t.pending++;
    try {
      const result = await this.serial(t, async () => {
        const started = this.now();
        const dispatchTs = started > t.lastDispatchTs ? started : t.lastDispatchTs + 1;
        t.lastDispatchTs = dispatchTs;
        const text = JSON.stringify(args ?? {});
        const target = args !== null && typeof args === "object" ? ((args as Record<string, unknown>)["character"] ?? (name === "login_character" ? (args as Record<string, unknown>)["name"] : undefined)) : undefined;
        const line = { kind: "call", credential: t.id, keyId, remote, tool: name, callId: dispatchTs, ...(typeof target === "string" ? { character: target } : {}), argBytes: Buffer.byteLength(text), argSha256: createHash("sha256").update(text).digest("hex") };
        let host: CredentialHost;
        try {
          this.refused.delete(t.id);
          host = await this.hostFor(t);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          // A host that leased and then failed to open holds nothing that will give the lease back.
          await this.releaseSeats(t, "host failed to open");
          // The detail can name the module's address and this machine's paths:
          // it goes to the operator's log and audit under a reference, and the
          // person is told only that reference, or the gateway's own refusal
          // of a lease, which is theirs to know.
          const ref = randomBytes(4).toString("hex");
          const refusal = this.refused.get(t.id);
          this.refused.delete(t.id);
          this.log(`[${t.id}] host failed to open (ref ${ref}): ${why}`);
          this.audit.write(t.person, { ...line, outcome: "error", durationMs: this.now() - started, error: `host: ${why}`, ref });
          return { text: `${name} failed: your session could not be opened: ${refusal ?? `the server could not start it (ref ${ref}); try again shortly`}`, isError: true };
        }
        let result: ToolResult;
        try {
          result = await host.invoke(name, args, dispatchTs);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          result = { text: `${name} failed: your session's worker did not answer (${why}); the next call starts it again`, isError: true };
        }
        this.audit.write(t.person, { ...line, outcome: result.isError === true ? "error" : "ok", durationMs: this.now() - started });
        return result;
      });
      return { result };
    } finally {
      t.pending--;
    }
  }

  /**
   * The credential's host, opened on its first call in a worker of its own:
   * the provider starts it, the gateway greets it with its secret and opens
   * the host with the gateway's own decisions. Only ever called inside the
   * credential's chain.
   */
  private async hostFor(t: Tenant): Promise<CredentialHost> {
    if (t.host !== undefined) return t.host;
    const base = join(this.o.stateDir, "tenants", t.id);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    for (const sub of ["state", "sessions"]) mkdirSync(join(base, sub), { recursive: true, mode: 0o700 });
    const grant = t.grant;
    const surface = this.surfaceOf(grant);
    const secret = newWorkerSecret();
    const handle = await (this.o.workers ?? (this.defaultWorkers ??= localWorkers())).start({ credential: t.id, secret, dir: base });
    const host = await connectWorker({
      handle,
      secret,
      open: {
        moduleUrl: this.o.moduleUrl,
        dir: handle.paths.state,
        // The single character's token is minted here; at fan-out it names the client's records (`group`) and is never leased.
        token: surface.fanout ? `hosted-client-${t.id}` : newHostedToken(),
        hostedTokens: true,
        account: grant.accounts[0],
        grant: surface.fanout ? { maxCharacters: grant.maxCharacters, accounts: [...toFanoutGrant(grant).accounts] } : null,
        program: surface.program,
        record: { root: handle.paths.sessions, retentionMs: this.o.recordRetentionMs ?? 3 * 86_400_000 },
        owner: t.person,
        ...(this.o.snippetTimeoutMs !== undefined ? { snippetTimeoutMs: this.o.snippetTimeoutMs } : {}),
        // The worker has no port secret to ask `/health` with; the gateway asks for it.
        module: await moduleIdentity(this.o.moduleUrl, moduleAuthHeaders(this.o.env ?? process.env), this.o.fetch ?? fetch),
      },
      leaser: this.leaserFor(t),
      log: (line) => this.log(`[${t.id}] ${line}`),
    });
    t.host = host;
    this.markUsed(t.id);
    void host.lost.then((why) => this.lostHost(t, host, why));
    this.audit.write(t.person, { kind: "host", event: "open", credential: t.id, fanout: surface.fanout, program: surface.program });
    await host.resume();
    return host;
  }

  /** A worker that went away unasked: its seats are released, and the next call starts another. */
  private async lostHost(t: Tenant, host: CredentialHost, why: string): Promise<void> {
    // Cleared at once, so a call queued behind this does not pick up the dead host; released in the chain.
    if (t.host !== host) return;
    t.host = undefined;
    await this.serial(t, async () => {
      await this.releaseSeats(t, `worker lost: ${why}`);
      this.audit.write(t.person, { kind: "host", event: "lost", why, credential: t.id });
      this.log(`[${t.id}] worker lost: ${why}`);
    });
  }

  private async stopHost(t: Tenant, why: string): Promise<void> {
    await this.serial(t, async () => {
      const host = t.host;
      if (host === undefined) return;
      t.host = undefined;
      this.markUsed(t.id);
      await host.shutdown();
      // Whatever the host did not give back, the gateway does.
      await this.releaseSeats(t, why);
      this.audit.write(t.person, { kind: "host", event: "stop", why, credential: t.id });
      this.log(`[${t.id}] host stopped: ${why}`);
    });
  }

  /**
   * Each credential's directory, on a schedule rather than only when its
   * worker next opens (which an idle or disabled credential never does):
   *
   * - every session record past the record retention goes, from every
   *   credential's store; a live one beats and is kept;
   * - a credential whose grant is removed, disabled or left with no key, and
   *   which has had no host for the person audit's retention, loses its whole
   *   directory (workspace, scratchpad, roster, records). A live grant keeps
   *   its workspace however long it is idle: that is the person's program.
   *
   * When a credential was last used is the gateway's own record
   * (`last-used.json` beside the ledger), never a time a credential's
   * directory says of itself.
   */
  pruneTenants(set = this.o.grants.current()): { sessions: number; credentials: string[] } {
    const root = join(this.o.stateDir, "tenants");
    const now = this.now();
    const used = this.lastUsed();
    let sessions = 0;
    const removed: string[] = [];
    for (const id of existsSync(root) ? readdirSync(root) : []) {
      const dir = join(root, id);
      const sessionsDir = join(dir, "sessions");
      if (existsSync(sessionsDir)) {
        try {
          sessions += pruneSessions(new SessionStore(sessionsDir), this.o.recordRetentionMs ?? 3 * 86_400_000, { now }).length;
        } catch (err) {
          this.log(`[${id}] pruning its session records: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const g = set.grant(id);
      const live = g !== undefined && g.disabled !== true && g.keyHashes.length > 0;
      if (live || this.tenants.get(id)?.host !== undefined) continue;
      let last = used[id];
      if (last === undefined) {
        try {
          last = statSync(dir).mtimeMs;
        } catch {
          continue;
        }
      }
      if (now - last < AUDIT_RETENTION_DAYS * 86_400_000) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(id);
      delete used[id];
      this.audit.write(g?.person ?? null, { kind: "pruned", credential: id, why: g === undefined ? "grant removed" : "grant disabled", lastUsed: last });
      this.log(`[${id}] removed its directory: no live grant and unused for ${AUDIT_RETENTION_DAYS} days`);
    }
    if (removed.length > 0) this.saveLastUsed(used);
    return { sessions, credentials: removed };
  }

  private lastUsedPath(): string {
    return join(this.o.stateDir, "last-used.json");
  }

  private lastUsed(): Record<string, number> {
    try {
      const raw = JSON.parse(readFileSync(this.lastUsedPath(), "utf8")) as unknown;
      return raw !== null && typeof raw === "object" ? (raw as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private saveLastUsed(used: Record<string, number>): void {
    const tmp = `${this.lastUsedPath()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(used)}\n`, { mode: 0o600 });
    renameSync(tmp, this.lastUsedPath());
  }

  /** Note that a credential's host was open now: what `pruneTenants` measures an unused credential from. */
  private markUsed(id: string): void {
    const used = this.lastUsed();
    used[id] = this.now();
    this.saveLastUsed(used);
  }

  /** Log out and release every seat the ledger holds for a credential. */
  private async releaseSeats(t: Pick<Tenant, "id">, why: string): Promise<void> {
    for (const seat of this.ledger.of(t.id)) {
      await this.base.logout(seat.token);
      await this.base.release(seat.token);
      this.ledger.remove(seat.token);
      this.audit.write(seat.person, { kind: "release", why, credential: t.id, account: seat.account, fingerprint: seat.fingerprint });
    }
  }

  /**
   * The leases of one credential's host, held to its grant here whatever
   * the host asks, so the check stands when the host is a process of its own.
   */
  leaserFor(t: Pick<Tenant, "id" | "person" | "grant" | "limits" | "logins">): Leaser {
    return {
      lease: async (o): Promise<LeaseOutcome> => {
        const refuse = (why: string): never => {
          this.refused.set(t.id, why);
          this.audit.write(t.person, { kind: "refused", why: `lease: ${why}`, credential: t.id, ...(o.account !== undefined ? { account: o.account } : {}) });
          throw new LeaseRefused(why);
        };
        const account = o.account;
        if (account === undefined || !t.grant.accounts.some((a) => a.toUpperCase() === account.toUpperCase())) refuse(`account ${account ?? "(none)"} is not one this key was granted`);
        // Its module audit must be kept as long as the person audit that points at it (tokens.ts).
        if (!isHostedToken(o.token)) refuse("that session's token is not one the gateway issues");
        if (this.leasing.has(o.token)) refuse("that session is already being leased");
        const held = this.ledger.get(o.token);
        if (held !== undefined && held.credential !== t.id) refuse("that session belongs to another key");
        // Seats held and seats being taken alike: every check and its
        // reservation happen before the first await, so concurrent asks see
        // each other.
        // By token, so a held seat being leased again counts once.
        const seats = new Map<string, string>([...this.ledger.seats().map((s) => [s.token, s.credential] as const), ...this.leasing]);
        seats.delete(o.token);
        const mine = [...seats.values()].filter((c) => c === t.id).length;
        if (mine >= t.grant.maxCharacters) refuse(`${mine} of ${t.grant.maxCharacters} characters are already in the world for this key`);
        const global = this.o.grants.current().file.globalMaxCharacters;
        if (seats.size >= global) refuse(`the server has ${seats.size} characters in the world, its most; try again later`);
        const hourAgo = this.now() - 3_600_000;
        while (t.logins.length > 0 && t.logins[0]! < hourAgo) t.logins.shift();
        if (held === undefined && t.logins.length >= t.limits.loginsPerHour) refuse(`${t.limits.loginsPerHour} logins in the last hour, this key's most; try again later`);
        this.leasing.set(o.token, t.id);
        const login = held === undefined ? this.now() : undefined;
        if (login !== undefined) t.logins.push(login);
        let granted = false;
        try {
          // Never with the GM opt-in, whatever was asked.
          const lease = await this.base.lease({ token: o.token, account: account! });
          if (lease.secret !== undefined) {
            granted = true;
            const seat: Seat = { credential: t.id, person: t.person, account: lease.account, token: o.token, fingerprint: tokenFingerprint(o.token), leasedAt: this.now() };
            this.ledger.add(seat);
            this.audit.write(t.person, { kind: "lease", credential: t.id, account: seat.account, fingerprint: seat.fingerprint });
          }
          return lease;
        } finally {
          this.leasing.delete(o.token);
          // A login that never happened gives its place in the hour back.
          if (!granted && login !== undefined) {
            const i = t.logins.lastIndexOf(login);
            if (i >= 0) t.logins.splice(i, 1);
          }
        }
      },
      logout: async (token) => {
        if (this.ledger.get(token)?.credential !== t.id) return;
        await this.base.logout(token);
        this.audit.write(t.person, { kind: "logout", credential: t.id, fingerprint: tokenFingerprint(token) });
      },
      release: async (token) => {
        const seat = this.ledger.get(token);
        if (seat === undefined || seat.credential !== t.id) return;
        await this.base.release(token);
        this.ledger.remove(token);
        this.audit.write(t.person, { kind: "release", credential: t.id, account: seat.account, fingerprint: seat.fingerprint });
      },
    };
  }
}
