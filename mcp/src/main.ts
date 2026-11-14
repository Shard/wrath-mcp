#!/usr/bin/env bun
/**
 * The stack on its own: an MCP server over stdio serving the five core tools
 * against one confined sandbox, for any MCP-capable agent and a module bolted
 * onto a stock AzerothCore. No harness: no trajectory, no wiki, no episodic
 * log, and a plain rendering of events and state where a harness would put
 * its own context rendering (`CoreToolRender`).
 *
 *   bun mcp/src/main.ts [--account <name>] [--dir <state-dir>] [--token-file <path> | --token <session-token>] [--allow-gm]
 *                       [--record-dir <store> | --no-record] [--record-retention-days <n>]
 *                       [--max-characters <n> --accounts <a,b,…>]
 *
 * Environment: `WRATHBENCH_MODULE_URL` (default `http://127.0.0.1:8086`) and
 * `WRATHBENCH_MODULE_SECRET`, the module's port secret, which this process
 * uses to lease a session secret for the token and never hands the sandbox.
 * `--allow-gm` or `WRATHBENCH_ALLOW_GM=1` is the GM opt-in, off by default:
 * without it the module refuses a GM account and any chat the server would
 * run as a command (`allowGmOption`).
 * The scratchpad, the client cache and the token itself (`token`, mode 0600)
 * live in `--dir` (default `$TMPDIR/wrathbench-mcp/<fingerprint>`, mode 0700),
 * so `--dir` alone resumes the session with both. The token is never printed:
 * stderr names the session by its tag and the state directory by its path.
 *
 * The session is recorded by default (`docs/SESSION-FORMAT.md`): its trace,
 * events, tool calls and a live ring of nearby units go to
 * `<record-dir>/<fingerprint>/`, where `--record-dir` defaults to a `sessions`
 * directory beside the state directory. Sessions that closed more than
 * `--record-retention-days` ago (default 3) are removed at start; `--no-record`
 * records nothing.
 *
 * `--max-characters <n>` above 1 is fan-out, the operator's grant as
 * `--allow-gm` is (`fanout.ts`): this one client may have up to `n` characters
 * in the world at once, on the accounts `--accounts` lists (one live session
 * per account, so at least `n` of them). The tool list is then the fan-out one
 * (`fanoutTools`): the same five, `character` on the three that act on one,
 * and `login_character`, `logout_character`, `list_characters`. Each
 * character has its own token, lease and session record; the state directory
 * keeps which account and token each lives on (`roster.json`, mode 0600), so
 * `--dir` brings back the ones that were logged in. Absent, or 1, everything
 * here is the single-character server, byte for byte.
 *
 * A clean exit — stdin closing, SIGINT or SIGTERM — logs the character out and
 * releases the lease. A killed process leaves the character in the world until
 * a create on its account reclaims it (module/PROTOCOL.md, "POST /session").
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventSummary } from "./sandbox/ipc";
import { compactJson } from "./jsonsafe";
import { CharacterRoster, FANOUT_TOOL_ORDER, fanoutGrantProblem, fanoutTools, MAX_CHARACTERS_LIMIT, type FanoutGrant, type FanoutToolContext, type RosterEntry } from "./fanout";
import { leaseRedacted, moduleAuthHeaders, moduleIdentity, portSecretLeaser, tokenFingerprint, tokenTag, type Leaser } from "./module-auth";
import { ownGuidIndex } from "./record/gate";
import { DEFAULT_RETENTION_MS, pruneSessions } from "./record/retention";
import { SessionStore } from "./record/store";
import { SessionWriter } from "./record/writer";
import { SecretRedactor } from "./redact";
import { CLIENT_CACHE_FILE, ClientCacheStore } from "./sandbox/client-cache";
import { SandboxHost } from "./sandbox/host";
import { Scratchpad } from "./scratchpad";
import { McpServer, serveStdio } from "./server";
import { coreTools, ToolSet, type CoreToolContext, type CoreToolRender, type ToolResult } from "./tools";
import { MCP_PACKAGE_VERSION } from "./version";

/**
 * Ambient motion, out-of-sight party frames, threat list updates and world
 * state changes: folded out of `recent_events` unless asked for, as its fold
 * note says. The state cache keeps them all.
 */
const AMBIENT = /^(SMSG_MONSTER_MOVE|MSG_MOVE_|SMSG_PARTY_MEMBER_STATS|SMSG_THREAT_UPDATE|SMSG_HIGHEST_THREAT_UPDATE|SMSG_UPDATE_WORLD_STATE)/;

/** The bare stack's rendering: one event per line, and the snapshot's own fields as JSON. */
export const PLAIN_RENDER: CoreToolRender<CoreToolContext> = {
  eventLine: (e: EventSummary) =>
    `${e.opcode === "stream_gap" ? "#gap" : `#${e.seq}`} ${e.opcode}${e.schemaError !== undefined ? " [schema mismatch]" : ""} ${compactJson(e.data, 220)}${e.note !== undefined ? ` — ${e.note}` : ""}`,
  isAmbient: (opcode) => AMBIENT.test(opcode),
  stateSummary: (snapshot, o) =>
    JSON.stringify({
      sessionLive: o.sessionLive,
      self: snapshot["self"],
      xp: snapshot["xp"],
      money: snapshot["money"],
      questLog: snapshot["questLog"],
      eventCount: snapshot["eventCount"],
      lastSeq: snapshot["lastSeq"],
      observation: snapshot["observation"],
      move: snapshot["move"],
    }),
};

/**
 * `result` with the sandbox's pending notices at its foot — a restart and the
 * state it lost, a background fault — scrubbed like the result. A harness
 * puts these in its own turn context; the bare stack has no turns, so the
 * next tool result is where the agent hears of them.
 */
export function withNotices(
  sandbox: Pick<SandboxHost, "drainNotices">,
  secrets: { scrub(text: string): string },
  result: ToolResult,
): ToolResult {
  const notices = sandbox.drainNotices();
  if (notices.length === 0) return result;
  const block = ["--- notices ---", ...notices.map((n) => `${n.kind}: ${n.text}`)].join("\n");
  return { ...result, text: secrets.scrub(`${result.text}\n${block}`) };
}

/** The environment variable that turns the GM opt-in on, as `--allow-gm` does. */
export const ALLOW_GM_ENV = "WRATHBENCH_ALLOW_GM";

/**
 * The GM opt-in, off unless asked for: `--allow-gm` in argv, or
 * `WRATHBENCH_ALLOW_GM` set to `1` or `true`. Unset, empty, `0` or `false` is
 * off; any other value is refused rather than read either way, so a typo
 * cannot pass for a choice.
 */
export function allowGmOption(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  if (argv.includes("--allow-gm")) return true;
  const v = env[ALLOW_GM_ENV]?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new Error(`${ALLOW_GM_ENV} must be 1 or true to allow GM use, or 0, false or unset for the default (off)`);
}

/**
 * The fan-out grant from argv, or null for the single-character server:
 * `--max-characters <n>` above 1 with `--accounts <a,b,…>`. Refused rather
 * than guessed at: a count that is no whole number from 1 to the limit, a
 * count above 1 with no accounts or fewer than it needs, and `--account`
 * beside `--accounts`, which would be two answers to where a character lives.
 */
export function fanoutOption(argv: readonly string[], allowGm = false): FanoutGrant | null {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const raw = flag("max-characters");
  const accountsRaw = flag("accounts");
  if (raw === undefined) {
    if (accountsRaw !== undefined) throw new Error("--accounts is the fan-out grant's and needs --max-characters above 1; a single character takes --account");
    return null;
  }
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > MAX_CHARACTERS_LIMIT) throw new Error(`--max-characters must be a whole number from 1 to ${MAX_CHARACTERS_LIMIT}`);
  if (n === 1) {
    if (accountsRaw !== undefined) throw new Error("--accounts is the fan-out grant's and needs --max-characters above 1; a single character takes --account");
    return null;
  }
  if (flag("account") !== undefined) throw new Error("--account names one character's account; with --max-characters above 1 the accounts are --accounts <a,b,…>");
  const accounts = (accountsRaw ?? "").split(",").map((a) => a.trim()).filter((a) => a.length > 0);
  const grant: FanoutGrant = { maxCharacters: n, accounts, ...(allowGm ? { allowGm: true } : {}) };
  const problem = fanoutGrantProblem(grant);
  if (problem !== null) throw new Error(`--max-characters ${n}: ${problem} (--accounts <a,b,…>)`);
  return grant;
}

/** The file in the state directory that keeps where each character lives, at fan-out above 1. Mode 0600: it holds tokens. */
export const ROSTER_FILE = "roster.json";

/** The entries a state directory's roster file holds; none when it has no file or one that does not read. */
export function readRoster(path: string): RosterEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is RosterEntry =>
        e !== null && typeof e === "object" && typeof (e as RosterEntry).character === "string" && typeof (e as RosterEntry).account === "string" && typeof (e as RosterEntry).token === "string",
    ).map((e) => ({ character: e.character, account: e.account, token: e.token, in: e.in === true }));
  } catch {
    return [];
  }
}

/** Write the roster file whole, 0600, by rename, so a reader never sees half and never a looser mode. */
export function writeRoster(path: string, entries: readonly RosterEntry[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The file in the state directory that holds the session token. */
export const TOKEN_FILE = "token";

/** A token file's token: its first line, trimmed; undefined when it holds none. */
function readToken(path: string): string | undefined {
  const t = readFileSync(path, "utf8").split("\n")[0]!.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * The session token and the state directory it lives in. The token is
 * `--token`, else the first line of `--token-file`, else the one a `--dir`
 * already holds, else a fresh random one. Neither path nor argv need carry it
 * after the first start: `--dir` resumes. The directory is created 0700 and
 * the token written into it 0600, both set explicitly because a mode given at
 * creation does not change what already exists.
 */
export function resolveSession(o: { token?: string; tokenFile?: string; dir?: string; tmp?: string }): { token: string; dir: string; tokenPath: string } {
  const held = o.dir !== undefined && existsSync(join(o.dir, TOKEN_FILE)) ? readToken(join(o.dir, TOKEN_FILE)) : undefined;
  const fromFile = o.tokenFile !== undefined ? readToken(o.tokenFile) : undefined;
  if (o.tokenFile !== undefined && fromFile === undefined) throw new Error("--token-file holds no token");
  // Random by default: the token names the session, and with the leased
  // secret it is what authenticates the sandbox's calls.
  const token = o.token ?? fromFile ?? held ?? randomBytes(16).toString("hex");
  const dir = o.dir ?? join(o.tmp ?? tmpdir(), "wrathbench-mcp", tokenFingerprint(token));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tokenPath = join(dir, TOKEN_FILE);
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return { token, dir, tokenPath };
}

/**
 * Where the session is recorded and for how long, from argv: null with
 * `--no-record`. The store is `--record-dir`, else `sessions` beside the
 * state directory; retention is `--record-retention-days`, else three days.
 */
export function recordOption(argv: readonly string[], stateDir: string): { root: string; retentionMs: number } | null {
  if (argv.includes("--no-record")) return null;
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = flag("record-retention-days");
  let retentionMs = DEFAULT_RETENTION_MS;
  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) throw new Error("--record-retention-days must be a number of days above 0");
    retentionMs = n * 24 * 60 * 60_000;
  }
  return { root: flag("record-dir") ?? join(dirname(stateDir), "sessions"), retentionMs };
}

/**
 * The clean exit, once however many ways it is asked for: stop the sandbox,
 * close the session record, log the character out and release the lease,
 * each bounded, through the leaser (with the port secret, unless the host
 * hands another), so a wedged child cannot hold the character in the world.
 */
export function sessionShutdown(o: {
  sandbox: Pick<SandboxHost, "stop">;
  record?: Pick<SessionWriter, "close"> | undefined;
  moduleUrl: string;
  token: string;
  /** Absent, `portSecretLeaser` over `moduleUrl`, `env` and `fetch`. */
  leaser?: Leaser;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): () => Promise<void> {
  const leaser = o.leaser ?? portSecretLeaser({ moduleUrl: o.moduleUrl, ...(o.env !== undefined ? { env: o.env } : {}), ...(o.fetch !== undefined ? { fetch: o.fetch } : {}) });
  let done: Promise<void> | undefined;
  return () =>
    (done ??= (async () => {
      await Promise.race([o.sandbox.stop().catch(() => {}), Bun.sleep(5_000)]);
      if (o.record !== undefined) await Promise.race([o.record.close().catch(() => {}), Bun.sleep(5_000)]);
      await leaser.logout(o.token);
      await leaser.release(o.token);
    })());
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tokenFlag = flag("token");
  const tokenFile = flag("token-file");
  const dirFlag = flag("dir");
  const { token, dir, tokenPath } = resolveSession({
    ...(tokenFlag !== undefined ? { token: tokenFlag } : {}),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    ...(dirFlag !== undefined ? { dir: dirFlag } : {}),
  });
  const account = flag("account");
  const moduleUrl = process.env["WRATHBENCH_MODULE_URL"] ?? "http://127.0.0.1:8086";
  const allowGm = allowGmOption(argv, process.env);
  const grant = fanoutOption(argv, allowGm);
  if (grant !== null) return mainFanout({ argv, grant, token, dir, tokenPath, moduleUrl });

  const secrets = new SecretRedactor();
  const leaser = portSecretLeaser({ moduleUrl });
  // The opt-in rides the lease, which only this process can take: the child's
  // creates inherit it, and nothing a snippet sends can raise it.
  const lease = await leaseRedacted(
    leaser,
    { token, ...(account !== undefined ? { account } : {}), ...(allowGm ? { allowGm } : {}) },
    secrets,
  );
  if (lease.secret === undefined) console.error(`[wrathbench-mcp] ${lease.note}`);
  else if (allowGm && !lease.allowGm) {
    console.error("[wrathbench-mcp] --allow-gm: the module did not confirm the GM opt-in (it predates it), so it serves player use only");
  } else if (allowGm) console.error("[wrathbench-mcp] GM opt-in on: the module serves a GM account and passes command chat for this session");

  // The session record: on unless refused, in a store beside the state
  // directory, named by the token's fingerprint and never by the token.
  const recordAt = recordOption(argv, dir);
  let record: SessionWriter | undefined;
  if (recordAt !== null) {
    const store = new SessionStore(recordAt.root);
    const id = tokenFingerprint(token);
    const pruned = pruneSessions(store, recordAt.retentionMs, { except: id });
    if (pruned.length > 0) console.error(`[wrathbench-mcp] removed ${pruned.length} session record(s) past retention from ${recordAt.root}`);
    record = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: MCP_PACKAGE_VERSION }, own: ownGuidIndex(() => store.dirs()), scrub: (text) => secrets.scrub(text), token });
    record.open();
    const writer = record;
    void moduleIdentity(moduleUrl, moduleAuthHeaders()).then((m) => writer.setModule(m));
  }

  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const clientCache = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE));
  process.on("exit", () => clientCache.flush());
  const sandbox = new SandboxHost({
    moduleUrl,
    token,
    ...(lease.secret !== undefined ? { secret: lease.secret } : {}),
    ...(account !== undefined ? { account } : {}),
    scratchpad,
    snippetTimeoutMs: 30_000,
    pingGraceMs: 5_000,
    clientCache,
    ...(record !== undefined ? { record: { writer: record } } : {}),
    // Scrubbed like everything else this process writes: a crash notice
    // quotes the child's stderr, and the child holds the lease secret.
    onNotice: (n) => console.error(secrets.scrub(`[wrathbench-mcp] ${n.kind}: ${n.text}`)),
    // stdout is the MCP transport: what a snippet prints goes to stderr with the rest of this process's log.
    logSink: (_stream, text) => void process.stderr.write(text),
  });
  const ctx: CoreToolContext = {
    sandbox,
    scratchpad,
    sessionLive: () => true,
    turn: () => 0,
    secrets,
    ...(record !== undefined ? { record } : {}),
  };
  const core = coreTools(PLAIN_RENDER);
  const tools = new ToolSet([core.run_snippet, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]);
  const server = new McpServer(
    {
      list: () => tools.defs,
      coerce: (name, raw) => tools.coerce(name, raw),
      call: async (name, args, origin) => withNotices(sandbox, secrets, await tools.call(ctx, name, args, origin)),
      appendPending: async (result) => withNotices(sandbox, secrets, await tools.appendPending(ctx, result)),
    },
    { serverVersion: MCP_PACKAGE_VERSION },
  );
  const shutdown = sessionShutdown({ sandbox, moduleUrl, token, record, leaser });
  let signalled = false;
  const onSignal = (code: number) => () => {
    // A second signal does not wait for the first one's logout.
    if (signalled) process.exit(code);
    signalled = true;
    void shutdown().finally(() => process.exit(code));
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  console.error(
    `[wrathbench-mcp] session ${tokenTag(token)}, state in ${dir}; its token is in ${tokenPath} (mode 0600), and --dir ${dir} resumes it` +
      (record !== undefined ? `; recorded in ${record.dir}` : "; not recorded"),
  );
  await serveStdio(server);
  await shutdown();
  process.exit(0);
}

/**
 * The server for a client granted more than one character. The state
 * directory's token names the client, not a session: it is never leased, and
 * its fingerprint is the `group` every one of the client's session records
 * carries, which is how a reader finds the sessions one client drove.
 */
async function mainFanout(o: { argv: readonly string[]; grant: FanoutGrant; token: string; dir: string; tokenPath: string; moduleUrl: string }): Promise<void> {
  const { grant, dir, moduleUrl } = o;
  const secrets = new SecretRedactor();
  const group = tokenFingerprint(o.token);
  const rosterPath = join(dir, ROSTER_FILE);
  const known = readRoster(rosterPath);

  const recordAt = recordOption(o.argv, dir);
  const store = recordAt !== null ? new SessionStore(recordAt.root) : null;
  if (store !== null && recordAt !== null) {
    const pruned = pruneSessions(store, recordAt.retentionMs);
    if (pruned.length > 0) console.error(`[wrathbench-mcp] removed ${pruned.length} session record(s) past retention from ${recordAt.root}`);
  }
  const module = store !== null ? moduleIdentity(moduleUrl, moduleAuthHeaders()) : null;

  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const clientCache = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE));
  process.on("exit", () => clientCache.flush());
  const sandbox = new SandboxHost({
    moduleUrl,
    token: "",
    scratchpad,
    snippetTimeoutMs: 30_000,
    pingGraceMs: 5_000,
    clientCache,
    fanout: { maxCharacters: grant.maxCharacters },
    ...(store !== null ? { record: {} } : {}),
    onNotice: (n) => console.error(secrets.scrub(`[wrathbench-mcp] ${n.kind}: ${n.text}`)),
    logSink: (_stream, text) => void process.stderr.write(text),
  });
  const roster: CharacterRoster = new CharacterRoster({
    grant,
    moduleUrl,
    sandbox,
    secrets,
    known,
    onChange: (entries) => writeRoster(rosterPath, entries),
    ...(store !== null
      ? {
          record: (seat) => {
            const id = tokenFingerprint(seat.token);
            const writer = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: MCP_PACKAGE_VERSION }, group, own: ownGuidIndex(() => store.dirs()), scrub: (text) => roster.scrubTokens(secrets.scrub(text)), token: seat.token });
            writer.open();
            void module?.then((m) => writer.setModule(m));
            return writer;
          },
        }
      : {}),
  });
  const ctx: FanoutToolContext = { sandbox, scratchpad, sessionLive: () => true, turn: () => 0, secrets, fanout: roster, ...(store !== null ? { record: roster.calls } : {}) };
  const specs = fanoutTools<FanoutToolContext>(PLAIN_RENDER);
  const tools = new ToolSet(FANOUT_TOOL_ORDER.map((name) => specs[name]));
  const server = new McpServer(
    {
      list: () => tools.defs,
      coerce: (name, raw) => tools.coerce(name, raw),
      call: async (name, args, origin) => withNotices(sandbox, secrets, await tools.call(ctx, name, args, origin)),
      appendPending: async (result) => withNotices(sandbox, secrets, await tools.appendPending(ctx, result)),
    },
    { serverVersion: MCP_PACKAGE_VERSION },
  );
  let done: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (done ??= (async () => {
      await Promise.race([sandbox.stop().catch(() => {}), Bun.sleep(5_000)]);
      await Promise.race([roster.shutdown({ logout: true }).catch(() => {}), Bun.sleep(5_000 + 1_000 * grant.maxCharacters)]);
    })());
  let signalled = false;
  const onSignal = (code: number) => () => {
    if (signalled) process.exit(code);
    signalled = true;
    void shutdown().finally(() => process.exit(code));
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  console.error(
    `[wrathbench-mcp] up to ${grant.maxCharacters} characters on ${grant.accounts.length} accounts, state in ${dir} (--dir ${dir} resumes it)` +
      (recordAt !== null ? `; each recorded in ${recordAt.root}, group ${group}` : "; not recorded"),
  );
  // The characters that were logged in when this state directory was last used.
  for (const f of await roster.resume()) console.error(secrets.scrub(`[wrathbench-mcp] ${f.character} was not brought back: ${f.error}`));
  await serveStdio(server);
  await shutdown();
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
