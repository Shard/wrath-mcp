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
 *                       [--max-characters <n> --accounts <a,b,…>] [--program]
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
 * `--program` serves the model's program beside the core tools (`host.ts`,
 * `hostToolSpecs`): `run_snippet` as a one-off, the file tools over a
 * workspace in the state directory (`program/`), and routines that keep
 * running between calls, at fan-out each for a character. Absent, nothing of
 * it is served.
 *
 * The host itself (sandbox, record, roster, program and the tool list) is
 * `host.ts`'s, which a hosted gateway opens once per credential, so the two
 * serve the same tools.
 *
 * A clean exit — stdin closing, SIGINT or SIGTERM — logs the character out and
 * releases the lease. A killed process leaves the character in the world until
 * a create on its account reclaims it (module/PROTOCOL.md, "POST /session").
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fanoutGrantProblem, MAX_CHARACTERS_LIMIT, type FanoutGrant } from "./fanout";
import { openHost } from "./host";
import { portSecretLeaser, tokenFingerprint, tokenTag, type Leaser } from "./module-auth";
import { DEFAULT_RETENTION_MS } from "./record/retention";
import type { SessionWriter } from "./record/writer";
import type { SandboxHost } from "./sandbox/host";
import { McpServer, serveStdio } from "./server";
import { MCP_PACKAGE_VERSION } from "./version";

// The host's pieces, where they were before the host was its own module.
export { PLAIN_RENDER, readRoster, ROSTER_FILE, withNotices, writeRoster } from "./host";

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
  const record = recordOption(argv, dir);
  const host = await openHost({
    moduleUrl,
    dir,
    token,
    account,
    allowGm,
    grant,
    program: argv.includes("--program"),
    record,
    log: (line) => console.error(`[wrathbench-mcp] ${line}`),
    // stdout is the MCP transport: what a snippet prints goes to stderr with the rest of this process's log.
    logSink: (_stream, text) => void process.stderr.write(text),
  });
  const server = new McpServer(host.tools, { serverVersion: MCP_PACKAGE_VERSION });
  // A fan-out host's characters need the leases the roster holds, logged out with the port secret however the child answered.
  const timeoutMs = grant !== null ? 10_000 + 1_000 * grant.maxCharacters : 25_000;
  let done: Promise<void> | undefined;
  const shutdown = (): Promise<void> => (done ??= Promise.race([host.shutdown({ logout: true }), Bun.sleep(timeoutMs)]));
  let signalled = false;
  const onSignal = (code: number) => () => {
    // A second signal does not wait for the first one's logout.
    if (signalled) process.exit(code);
    signalled = true;
    void shutdown().finally(() => process.exit(code));
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  if (grant === null) {
    console.error(
      `[wrathbench-mcp] session ${tokenTag(token)}, state in ${dir}; its token is in ${tokenPath} (mode 0600), and --dir ${dir} resumes it` +
        (host.recordedIn !== undefined ? `; recorded in ${host.recordedIn}` : "; not recorded"),
    );
  } else {
    // The state directory's token names the client, not a session: it is never leased, and its fingerprint is every one of the client's session records' `group`.
    console.error(
      `[wrathbench-mcp] up to ${grant.maxCharacters} characters on ${grant.accounts.length} accounts, state in ${dir} (--dir ${dir} resumes it)` +
        (host.recordedIn !== undefined ? `; each recorded in ${host.recordedIn}, group ${tokenFingerprint(token)}` : "; not recorded"),
    );
  }
  await host.resume();
  await serveStdio(server);
  await shutdown();
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
