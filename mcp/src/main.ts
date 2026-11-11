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
 * A clean exit — stdin closing, SIGINT or SIGTERM — logs the character out and
 * releases the lease. A killed process leaves the character in the world until
 * a create on its account reclaims it (module/PROTOCOL.md, "POST /session").
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventSummary } from "./sandbox/ipc";
import { compactJson } from "./jsonsafe";
import { leaseRunSecret, logoutSession, moduleAuthHeaders, moduleIdentity, releaseSessionSecret, tokenFingerprint, tokenTag } from "./module-auth";
import { DEFAULT_RETENTION_MS, SessionStore } from "./record/store";
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
 * each bounded, with the port secret, so a wedged child cannot hold the
 * character in the world.
 */
export function sessionShutdown(o: {
  sandbox: Pick<SandboxHost, "stop">;
  record?: Pick<SessionWriter, "close"> | undefined;
  moduleUrl: string;
  token: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () =>
    (done ??= (async () => {
      await Promise.race([o.sandbox.stop().catch(() => {}), Bun.sleep(5_000)]);
      if (o.record !== undefined) await Promise.race([o.record.close().catch(() => {}), Bun.sleep(5_000)]);
      const call = { moduleUrl: o.moduleUrl, token: o.token, ...(o.env !== undefined ? { env: o.env } : {}), ...(o.fetch !== undefined ? { fetch: o.fetch } : {}) };
      await logoutSession(call);
      await releaseSessionSecret(call);
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

  const secrets = new SecretRedactor();
  // The opt-in rides the lease, which only this process can take: the child's
  // creates inherit it, and nothing a snippet sends can raise it.
  const lease = await leaseRunSecret(
    { moduleUrl, token, ...(account !== undefined ? { account } : {}), ...(allowGm ? { allowGm } : {}) },
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
    const pruned = store.prune(recordAt.retentionMs, { except: id });
    if (pruned.length > 0) console.error(`[wrathbench-mcp] removed ${pruned.length} session record(s) past retention from ${recordAt.root}`);
    record = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: MCP_PACKAGE_VERSION }, own: store.own(), scrub: (text) => secrets.scrub(text) });
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
  const shutdown = sessionShutdown({ sandbox, moduleUrl, token, record });
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

if (import.meta.main) {
  void main();
}
