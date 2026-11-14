#!/usr/bin/env bun
/**
 * The hosted gateway (`gateway.ts`) on its own: MCP over Streamable HTTP at
 * `/mcp`, for people the grants file names.
 *
 *   bun mcp/src/hosted/gateway-main.ts --grants <file> --state <dir> [--host 127.0.0.1] [--port 8095]
 *                                      [--no-program] [--allowed-origin <origin>]… [--trust-forwarded-for]
 *                                      [--record-retention-days <n>]
 *
 * Environment: `WRATHBENCH_MODULE_URL` (default `http://127.0.0.1:8086`) and
 * `WRATHBENCH_MODULE_SECRET`, the module's port secret, which only this
 * process holds. TLS is the deployment's (a reverse proxy or an ingress):
 * bound to anything but loopback, the gateway expects one in front of it,
 * since a key must never cross the network in the clear. With
 * `--trust-forwarded-for` the audit names the first `X-Forwarded-For`
 * address, which only a proxy that sets it may be trusted for; otherwise the
 * socket's peer.
 *
 * SIGINT or SIGTERM stops every credential's host, logging its characters
 * out and giving their leases back.
 */

import { resolve } from "node:path";
import { DEFAULT_RETENTION_MS } from "../record/retention";
import { Gateway, MAX_BODY_BYTES } from "./gateway";
import { FileGrantSource, GRANTS_FILE_ENV } from "./grants";

export const GATEWAY_USAGE =
  "usage: gateway-main --grants <file> --state <dir> [--host 127.0.0.1] [--port 8095] [--no-program] [--allowed-origin <origin>]… [--trust-forwarded-for] [--record-retention-days <n>]";

export interface GatewayArgs {
  grants: string;
  state: string;
  host: string;
  port: number;
  program: boolean;
  allowedOrigins: string[];
  trustForwardedFor: boolean;
  recordRetentionMs: number;
}

/** The flags, parsed; throws with the usage on anything it does not know. */
export function parseGatewayArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): GatewayArgs {
  const flags = new Map<string, string>();
  const origins: string[] = [];
  let program = true;
  let trustForwardedFor = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") throw new Error(GATEWAY_USAGE);
    if (a === "--no-program") {
      program = false;
      continue;
    }
    if (a === "--trust-forwarded-for") {
      trustForwardedFor = true;
      continue;
    }
    const m = /^--(grants|state|host|port|allowed-origin|record-retention-days)(?:=(.*))?$/.exec(a);
    if (m === null) throw new Error(`unknown argument ${a}\n${GATEWAY_USAGE}`);
    const v = m[2] ?? argv[++i];
    if (v === undefined) throw new Error(`--${m[1]} needs a value\n${GATEWAY_USAGE}`);
    if (m[1] === "allowed-origin") origins.push(v);
    else flags.set(m[1]!, v);
  }
  const grants = flags.get("grants") ?? env[GRANTS_FILE_ENV];
  const state = flags.get("state");
  if (grants === undefined || state === undefined) throw new Error(GATEWAY_USAGE);
  const port = Number(flags.get("port") ?? 8095);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
  let recordRetentionMs = DEFAULT_RETENTION_MS;
  const days = flags.get("record-retention-days");
  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) throw new Error("--record-retention-days must be a number of days above 0");
    recordRetentionMs = n * 86_400_000;
  }
  return { grants: resolve(grants), state: resolve(state), host: flags.get("host") ?? "127.0.0.1", port, program, allowedOrigins: origins, trustForwardedFor, recordRetentionMs };
}

if (import.meta.main) {
  let args: GatewayArgs;
  try {
    args = parseGatewayArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const log = (line: string): void => console.error(`[wrath-mcp gateway] ${line}`);
  const grants = new FileGrantSource(args.grants, { onProblem: (p) => log(`grants file refused, granting nothing until it stands: ${p.join("; ")}`) });
  const gateway = new Gateway({
    grants,
    stateDir: args.state,
    moduleUrl: process.env["WRATHBENCH_MODULE_URL"] ?? "http://127.0.0.1:8086",
    program: args.program,
    allowedOrigins: args.allowedOrigins,
    recordRetentionMs: args.recordRetentionMs,
    log,
  });
  await gateway.start();
  const server = Bun.serve({
    hostname: args.host,
    port: args.port,
    // A call can run as long as a snippet's timeout and then some; Bun's default would cut it at 10 s.
    idleTimeout: 255,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: (req, srv) => {
      const forwarded = args.trustForwardedFor ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
      return gateway.fetch(req, forwarded ?? srv.requestIP(req)?.address);
    },
  });
  log(`serving MCP at http://${args.host}:${server.port}/mcp for ${grants.current().grants.length} grant(s), state in ${args.state}`);
  let stopping = false;
  const onSignal = (code: number) => () => {
    if (stopping) process.exit(code);
    stopping = true;
    void server.stop();
    void Promise.race([gateway.stop(), Bun.sleep(30_000)]).finally(() => process.exit(code));
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
}
