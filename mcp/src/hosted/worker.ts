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
 * or its gateway's connection closed) shuts its host down at once, without
 * logging out (there is no gateway to ask), and exits, so a gateway that
 * died leaves nothing running. While its host is open it holds a lock on its
 * state directory (`STATE_LOCK`, refreshed every second), so a worker started
 * for the same credential after a gateway restart waits for the old one to
 * stop writing there before it opens.
 *
 *   WRATH_MCP_WORKER_SECRET=<secret> bun mcp/src/hosted/worker.ts [--host 127.0.0.1] [--port 0]
 *
 * It prints `wrath-mcp worker listening on <host>:<port>` on stdout once it
 * listens, and nothing else there.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { openHost, type OpenedHost } from "../host";
import type { Leaser, LeaseOutcome } from "../module-auth";
import { newHostedToken } from "./tokens";
import { RpcPeer } from "./worker-rpc";

export const WORKER_SECRET_ENV = "WRATH_MCP_WORKER_SECRET";
export const WORKER_READY_PREFIX = "wrath-mcp worker listening on ";
export const HELLO_WAIT_MS = 30_000;
/** How long a connection may stay open without saying `hello`. */
export const CONNECTION_HELLO_MS = 5_000;
/** The lock a worker holds on its state directory while its host is open. */
export const STATE_LOCK = ".worker-lock";
/** How fresh a lock's heartbeat must be for another worker to wait for it. */
const LOCK_STALE_MS = 5_000;

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
  /** The sandbox child's resource limits (`SandboxLimits`), each replacing its default; `null` is no limit. */
  sandboxLimits: z
    .strictObject({
      addressSpaceBytes: z.int().positive().nullable().optional(),
      cpuSeconds: z.int().positive().nullable().optional(),
      fileBytes: z.int().positive().nullable().optional(),
    })
    .optional(),
  module: z.strictObject({ build: z.string().nullable(), protocol: z.number().nullable() }).nullable().optional(),
  /** Mint each new character's token as a hosted one (`tokens.ts`), which the gateway's leaser requires. */
  hostedTokens: z.boolean().optional(),
});
export type WorkerOpen = z.infer<typeof WorkerOpenSchema>;

const InvokeSchema = z.strictObject({ name: z.string(), args: z.unknown(), dispatchTs: z.number() });

const LeaseAnswer = z.union([
  z.strictObject({ secret: z.string(), account: z.string(), allowGm: z.boolean() }),
  z.strictObject({ secret: z.undefined().optional(), note: z.string() }),
]);

/**
 * Take the state directory's lock: wait while another worker's heartbeat is
 * fresh, take over one gone stale. Returns the release.
 */
async function lockState(dir: string, waitMs = 30_000): Promise<() => void> {
  const path = join(dir, STATE_LOCK);
  const id = randomBytes(8).toString("hex");
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(path, id, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let fresh = false;
      try {
        fresh = Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS;
      } catch {
        continue;
      }
      if (!fresh) {
        try {
          unlinkSync(path);
        } catch {
          // another worker took it over first
        }
        continue;
      }
      if (Date.now() > until) throw new Error("another worker still holds this credential's state");
      await Bun.sleep(200);
    }
  }
  const beat = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(path, t, t);
    } catch {
      // gone: the release below says so
    }
  }, 1_000);
  beat.unref?.();
  return () => {
    clearInterval(beat);
    try {
      if (readFileSync(path, "utf8") === id) unlinkSync(path);
    } catch {
      // already gone
    }
  };
}

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
  let unlock: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const leaser = gatewayLeaser(() => peer);
  const helloTimer = setTimeout(() => void stop(false), o.helloWaitMs ?? HELLO_WAIT_MS);
  helloTimer.unref?.();
  /** Shut the host and exit; `logout` only while there is a gateway to ask. */
  const stop = (logout: boolean): Promise<void> =>
    (stopping ??= (async () => {
      clearTimeout(helloTimer);
      if (host !== undefined) await host.shutdown({ logout }).catch(() => {});
      host = undefined;
      unlock?.();
      unlock = undefined;
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
    const deadline = setTimeout(() => {
      if (!greeted) p.close();
    }, CONNECTION_HELLO_MS);
    deadline.unref?.();
    p.handle("hello", async (params) => {
      const given = Buffer.from(String((params as { secret?: unknown } | null)?.secret ?? ""), "utf8");
      if (given.length !== secret.length || !timingSafeEqual(given, secret)) {
        setTimeout(() => p.close(), 0);
        throw new Error("refused");
      }
      greeted = true;
      peer = p;
      clearTimeout(helloTimer);
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
        const { hostedTokens, ...opts } = WorkerOpenSchema.parse(params);
        unlock = await lockState(opts.dir);
        try {
          host = await (o.openHost ?? openHost)({
            ...opts,
            ...(hostedTokens === true ? { newToken: () => newHostedToken() } : {}),
            leaser,
            log: (line) => p.notify("log", { line }),
            logSink: () => {},
          });
        } catch (err) {
          unlock();
          unlock = undefined;
          throw err;
        }
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
        setTimeout(() => void stop(false), 0);
        return { ok: true };
      }),
    );
    void p.closed.then(() => {
      clearTimeout(deadline);
      // The gateway is gone: nothing reconnects to a worker whose secret only it knew, so stop now, without a logout nobody can take.
      if (peer === p) {
        peer = undefined;
        void stop(false);
      }
    });
  };

  const server: Server = createServer(accept);
  const bind = o.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, bind, () => resolve());
  });
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  return { host: bind, port, stop: () => stop(true) };
}

/**
 * Run a worker as this entry does: the secret from `WRATH_MCP_WORKER_SECRET`
 * (struck from the environment once read), `--host` and `--port` to listen
 * on, `--hello-wait-ms` for how long it waits for its gateway (a pod may be
 * reached later than a local process), and an exit once its gateway is gone.
 * A deployment's own worker entry calls this.
 */
export async function workerMain(argv: readonly string[]): Promise<void> {
  const secret = process.env[WORKER_SECRET_ENV];
  if (secret === undefined || secret.length < 32) {
    console.error(`${WORKER_SECRET_ENV} must hold this worker's secret (32 characters or more)`);
    process.exit(2);
  }
  // Read once and struck, as the sandbox child strikes its own: nothing this process starts inherits it.
  delete process.env[WORKER_SECRET_ENV];
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const wait = flag("hello-wait-ms");
  const served = await serveWorker({
    secret,
    host: flag("host") ?? "127.0.0.1",
    port: Number(flag("port") ?? 0),
    ...(wait !== undefined ? { helloWaitMs: Number(wait) } : {}),
    onExit: () => process.exit(0),
  });
  process.stdout.write(`${WORKER_READY_PREFIX}${served.host}:${served.port}\n`);
  const onSignal = () => void served.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

if (import.meta.main) {
  await workerMain(process.argv.slice(2));
}
