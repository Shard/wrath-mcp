#!/usr/bin/env bun
/**
 * A hosted credential's worker: the process that runs one credential's host
 * (`host.ts`: the sandbox host, the program host, the confined child and the
 * recorder) apart from the gateway, holding the lease secrets the gateway
 * hands it and nothing more (`docs/CONTRACTS.md`, "Control-surface
 * authentication").
 *
 * It listens on a TCP port and takes one connection, the gateway's, which
 * must first say `hello` with this worker's own secret (handed to it at
 * start, `WRATH_MCP_WORKER_SECRET`). The gateway then asks it to `open` its
 * host with the options the gateway decided (the credential's directories,
 * accounts, owner), to `invoke` tool calls, to `resume` and to `shutdown`.
 * Every lease, logout and release the host takes goes back to the gateway
 * as a request on the same connection: the worker never has the port
 * secret, and a lease the gateway refuses is a login that fails.
 *
 * A worker whose gateway is gone (no `hello` within `HELLO_WAIT_MS` of start,
 * or no connection for `ORPHAN_MS` after one closes) shuts its host down and
 * exits, so a gateway that died leaves nothing running.
 *
 *   WRATH_MCP_WORKER_SECRET=<secret> bun mcp/src/hosted/worker.ts [--host 127.0.0.1] [--port 0]
 *
 * It prints `wrath-mcp worker listening on <host>:<port>` on stdout once it
 * listens, and nothing else there.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { openHost, type OpenedHost } from "../host";
import type { Leaser, LeaseOutcome } from "../module-auth";
import { RpcPeer } from "./worker-rpc";

export const WORKER_SECRET_ENV = "WRATH_MCP_WORKER_SECRET";
export const WORKER_READY_PREFIX = "wrath-mcp worker listening on ";
export const HELLO_WAIT_MS = 30_000;
export const ORPHAN_MS = 60_000;

/** What the gateway opens a worker's host with: its own decisions, in the worker's paths. */
export const WorkerOpenSchema = z.strictObject({
  moduleUrl: z.string().url(),
  dir: z.string().min(1),
  token: z.string().min(1),
  account: z.string().optional(),
  grant: z.strictObject({ maxCharacters: z.int().min(1), accounts: z.array(z.string()) }).nullable(),
  program: z.boolean(),
  record: z.strictObject({ root: z.string().min(1), retentionMs: z.number().positive() }).nullable(),
  owner: z.string().optional(),
  snippetTimeoutMs: z.number().positive().optional(),
});
export type WorkerOpen = z.infer<typeof WorkerOpenSchema>;

const InvokeSchema = z.strictObject({ name: z.string(), args: z.unknown(), dispatchTs: z.number() });

const LeaseAnswer = z.union([
  z.strictObject({ secret: z.string(), account: z.string(), allowGm: z.boolean() }),
  z.strictObject({ secret: z.undefined().optional(), note: z.string() }),
]);

/** The worker's leaser: every lease, logout and release is the gateway's to do. */
function gatewayLeaser(peer: () => RpcPeer | undefined): Leaser {
  const ask = async (method: string, params: unknown): Promise<unknown> => {
    const p = peer();
    if (p === undefined || !p.open) throw new Error("the gateway is not connected");
    return p.request(method, params, 120_000);
  };
  return {
    // Never with the GM opt-in: the gateway would not send it either.
    lease: async (o) => LeaseAnswer.parse(await ask("lease", { token: o.token, ...(o.account !== undefined ? { account: o.account } : {}) })) as LeaseOutcome,
    logout: async (token) => void (await ask("logout", { token }).catch(() => undefined)),
    release: async (token) => void (await ask("release", { token }).catch(() => undefined)),
  };
}

export interface ServeWorkerOptions {
  secret: string;
  host?: string;
  port?: number;
  /** Opens the host; tests hand a stand-in. Default `openHost`. */
  openHost?: typeof openHost;
  helloWaitMs?: number;
  orphanMs?: number;
  /** Called once the worker has shut its host and closed: the process entry exits here. */
  onExit?: () => void;
}

export interface ServedWorker {
  host: string;
  port: number;
  /** Shut the host (logging out through the gateway while it is connected) and stop listening. */
  stop(): Promise<void>;
}

/** Serve one credential's worker on a TCP port until its gateway is gone. */
export async function serveWorker(o: ServeWorkerOptions): Promise<ServedWorker> {
  const secret = Buffer.from(o.secret, "utf8");
  let peer: RpcPeer | undefined;
  let host: OpenedHost | undefined;
  let stopping: Promise<void> | undefined;
  let orphanTimer: ReturnType<typeof setTimeout> | undefined;
  const leaser = gatewayLeaser(() => peer);
  const arm = (ms: number): void => {
    if (orphanTimer !== undefined) clearTimeout(orphanTimer);
    orphanTimer = setTimeout(() => void stop(), ms);
    orphanTimer.unref?.();
  };
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      if (orphanTimer !== undefined) clearTimeout(orphanTimer);
      if (host !== undefined) await host.shutdown({ logout: true }).catch(() => {});
      host = undefined;
      peer?.close();
      await new Promise<void>((r) => server.close(() => r()));
      o.onExit?.();
    })());

  const accept = (socket: Socket): void => {
    if (peer !== undefined && peer.open) {
      // One gateway at a time.
      socket.destroy();
      return;
    }
    const p = new RpcPeer(socket);
    let greeted = false;
    p.handle("hello", async (params) => {
      const given = Buffer.from(String((params as { secret?: unknown } | null)?.secret ?? ""), "utf8");
      if (given.length !== secret.length || !timingSafeEqual(given, secret)) {
        setTimeout(() => p.close(), 0);
        throw new Error("refused");
      }
      greeted = true;
      peer = p;
      if (orphanTimer !== undefined) clearTimeout(orphanTimer);
      return { ok: true, open: host !== undefined };
    });
    const greet = <T>(fn: (params: unknown) => Promise<T>) => async (params: unknown): Promise<T> => {
      if (!greeted) {
        setTimeout(() => p.close(), 0);
        throw new Error("say hello first");
      }
      return fn(params);
    };
    p.handle(
      "open",
      greet(async (params) => {
        if (host !== undefined) return { ok: true, already: true };
        const opts = WorkerOpenSchema.parse(params);
        host = await (o.openHost ?? openHost)({
          ...opts,
          leaser,
          log: (line) => p.notify("log", { line }),
          logSink: () => {},
        });
        return { ok: true };
      }),
    );
    p.handle(
      "invoke",
      greet(async (params) => {
        const h = host;
        if (h === undefined) throw new Error("the host is not open");
        const { name, args, dispatchTs } = InvokeSchema.parse(params);
        const coerced = h.tools.coerce(name, args);
        return coerced.ok ? await h.tools.call(name, coerced.args, { dispatchTs }) : await h.tools.appendPending({ text: coerced.error, isError: true });
      }),
    );
    p.handle(
      "resume",
      greet(async () => {
        await host?.resume();
        return { ok: true };
      }),
    );
    p.handle(
      "shutdown",
      greet(async () => {
        const h = host;
        host = undefined;
        if (h !== undefined) await h.shutdown({ logout: true });
        setTimeout(() => void stop(), 0);
        return { ok: true };
      }),
    );
    void p.closed.then(() => {
      if (peer === p) {
        peer = undefined;
        if (stopping === undefined) arm(o.orphanMs ?? ORPHAN_MS);
      }
    });
  };

  const server: Server = createServer(accept);
  const bind = o.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, bind, () => resolve());
  });
  arm(o.helloWaitMs ?? HELLO_WAIT_MS);
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  return { host: bind, port, stop };
}

if (import.meta.main) {
  const secret = process.env[WORKER_SECRET_ENV];
  if (secret === undefined || secret.length < 32) {
    console.error(`${WORKER_SECRET_ENV} must hold this worker's secret (32 characters or more)`);
    process.exit(2);
  }
  // Read once and struck, as the sandbox child strikes its own: nothing this process starts inherits it.
  delete process.env[WORKER_SECRET_ENV];
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const served = await serveWorker({
    secret,
    host: flag("host") ?? "127.0.0.1",
    port: Number(flag("port") ?? 0),
    onExit: () => process.exit(0),
  });
  process.stdout.write(`${WORKER_READY_PREFIX}${served.host}:${served.port}\n`);
  const onSignal = () => void served.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
