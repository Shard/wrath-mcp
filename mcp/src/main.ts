#!/usr/bin/env bun
/**
 * The stack on its own: an MCP server over stdio serving the five core tools
 * against one confined sandbox, for any MCP-capable agent and a module bolted
 * onto a stock AzerothCore. No harness: no trajectory, no wiki, no episodic
 * log, and a plain rendering of events and state where a harness would put
 * its own context rendering (`CoreToolRender`).
 *
 *   bun mcp/src/main.ts [--token <session-token>] [--account <name>] [--dir <state-dir>]
 *
 * Environment: `WRATHBENCH_MODULE_URL` (default `http://127.0.0.1:8086`) and
 * `WRATHBENCH_MODULE_SECRET`, the module's port secret, which this process
 * uses to lease a session secret for the token and never hands the sandbox.
 * The scratchpad and the client cache live in `--dir` (default
 * `$TMPDIR/wrathbench-mcp/<token>`), so a restart of this server keeps both.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventSummary } from "./sandbox/ipc";
import { compactJson } from "./jsonsafe";
import { leaseRunSecret } from "./module-auth";
import { SecretRedactor } from "./redact";
import { CLIENT_CACHE_FILE, ClientCacheStore } from "./sandbox/client-cache";
import { SandboxHost } from "./sandbox/host";
import { Scratchpad } from "./scratchpad";
import { McpServer, serveStdio } from "./server";
import { coreTools, ToolSet, type CoreToolContext, type CoreToolRender, type ToolResult } from "./tools";
import { MCP_PACKAGE_VERSION } from "./version";

/** Ambient motion and out-of-sight party frames: folded out of `recent_events` unless asked for, as its fold note says. */
const AMBIENT = /^(SMSG_MONSTER_MOVE|MSG_MOVE_|SMSG_PARTY_MEMBER_STATS)/;

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

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // Random by default: the token names the session, and with the leased
  // secret it is what authenticates the sandbox's calls.
  const token = flag("token") ?? randomBytes(16).toString("hex");
  const account = flag("account");
  const moduleUrl = process.env["WRATHBENCH_MODULE_URL"] ?? "http://127.0.0.1:8086";
  const dir = flag("dir") ?? join(tmpdir(), "wrathbench-mcp", token);
  mkdirSync(dir, { recursive: true });

  const secrets = new SecretRedactor();
  const lease = await leaseRunSecret({ moduleUrl, token, ...(account !== undefined ? { account } : {}) }, secrets);
  if (lease.secret === undefined) console.error(`[wrathbench-mcp] ${lease.note}`);

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
  console.error(`[wrathbench-mcp] token ${token} — state in ${dir}`);
  await serveStdio(server);
  await sandbox.stop();
}

if (import.meta.main) {
  void main();
}
