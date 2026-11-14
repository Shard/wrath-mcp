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
 * `--trust-forwarded-for` the audit names the address the one proxy in front
 * of it added, the last `X-Forwarded-For` entry (`forwardedFor`); otherwise
 * the socket's peer.
 *
 * SIGINT or SIGTERM stops every credential's host, logging its characters
 * out and giving their leases back.
 */

import { resolve } from "node:path";
import { DEFAULT_RETENTION_MS } from "../record/retention";
import { Gateway, MAX_BODY_BYTES } from "./gateway";
import type { WorkerProvider } from "./workers";

export { Gateway, type GatewayOptions } from "./gateway";
export type { CredentialHost, WorkerHandle, WorkerProvider } from "./workers";
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

/**
 * The client's address as the one trusted proxy in front of the gateway saw
 * it: the LAST `X-Forwarded-For` entry. A proxy appends the address it saw to
 * whatever the client sent, so every entry before the last is the client's
 * own say and could name anyone.
 */
export function forwardedFor(headers: Headers): string | undefined {
  const last = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last !== undefined && last.length > 0 ? last : undefined;
}

export interface RunningGateway {
  readonly gateway: Gateway;
  readonly port: number;
  /** Stop serving, then stop every credential's worker, logging its characters out. */
  stop(): Promise<void>;
}

/**
 * Run a gateway as this entry does: grants from the file, workers from
 * `workers` (default a process per credential on this machine), MCP served
 * at `/mcp`. A deployment that starts its workers its own way (a pod per
 * credential) calls this with its own provider. Throws on a configuration
 * the gateway refuses, such as no port secret.
 */
export async function runGateway(
  args: GatewayArgs,
  o: { workers?: WorkerProvider; env?: Record<string, string | undefined>; log?: (line: string) => void } = {},
): Promise<RunningGateway> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((line: string): void => console.error(`[wrath-mcp gateway] ${line}`));
  const grants = new FileGrantSource(args.grants, { onProblem: (p) => log(`grants file refused, granting nothing until it stands: ${p.join("; ")}`) });
  const gateway = new Gateway({
    grants,
    stateDir: args.state,
    moduleUrl: env["WRATHBENCH_MODULE_URL"] ?? "http://127.0.0.1:8086",
    env,
    program: args.program,
    allowedOrigins: args.allowedOrigins,
    recordRetentionMs: args.recordRetentionMs,
    ...(o.workers !== undefined ? { workers: o.workers } : {}),
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
      const forwarded = args.trustForwardedFor ? forwardedFor(req.headers) : undefined;
      return gateway.fetch(req, forwarded ?? srv.requestIP(req)?.address);
    },
  });
  log(`serving MCP at http://${args.host}:${server.port}/mcp for ${grants.current().grants.length} grant(s), state in ${args.state}`);
  let stopped: Promise<void> | undefined;
  return {
    gateway,
    port: server.port ?? args.port,
    stop: () =>
      (stopped ??= (async () => {
        void server.stop();
        await gateway.stop();
        grants.close();
      })()),
  };
}

/** Run the gateway until SIGINT or SIGTERM, as the entry does; a deployment's own entry calls this with its provider. */
export async function gatewayMain(argv: readonly string[], o: { workers?: WorkerProvider } = {}): Promise<void> {
  let running: RunningGateway;
  try {
    running = await runGateway(parseGatewayArgs(argv), o);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  let stopping = false;
  const onSignal = (code: number) => () => {
    if (stopping) process.exit(code);
    stopping = true;
    void Promise.race([running.stop(), Bun.sleep(30_000)]).finally(() => process.exit(code));
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
}

if (import.meta.main) {
  await gatewayMain(process.argv.slice(2));
}
