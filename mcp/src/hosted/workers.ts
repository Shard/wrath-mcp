/**
 * How the gateway starts and reaches a credential's worker (`worker.ts`).
 *
 * `WorkerProvider` is the hook: it starts a worker for a credential, with
 * that worker's secret, and says where to connect and where the credential's
 * directories are as the worker sees them. The stack ships `localWorkers`, a
 * process per credential on this machine; a deployment that runs a worker
 * per pod or container supplies its own provider, so the stack stays free of
 * any orchestrator.
 *
 * `connectWorker` is the gateway's end of one worker: it says `hello`, opens
 * the host with the gateway's own decisions, and answers the worker's lease
 * requests with the gateway's leaser for that credential. Nothing the worker
 * sends is trusted: a tool result is checked for its shape, and a lease
 * request is held to the credential the gateway started the worker for.
 */

import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Leaser } from "../module-auth";
import type { ToolResult } from "../tools";
import { WORKER_READY_PREFIX, WORKER_SECRET_ENV, type WorkerOpen } from "./worker";
import { RpcPeer } from "./worker-rpc";

/** A credential's host as the gateway drives it, wherever it runs. */
export interface CredentialHost {
  /** One tool call: its arguments as the client sent them, coerced and run where the host is. */
  invoke(name: string, args: unknown, dispatchTs: number): Promise<ToolResult>;
  resume(): Promise<void>;
  /** Shut the host, logging its characters out, and stop the worker. */
  shutdown(): Promise<void>;
  /** Settles if the host goes away without being asked to. */
  readonly lost: Promise<string>;
}

/** A started worker, as its provider describes it. */
export interface WorkerHandle {
  /** Where the gateway connects. */
  host: string;
  port: number;
  /** The credential's directories as the worker sees them. */
  paths: { state: string; sessions: string };
  /** Stop the worker, however it is. Idempotent. */
  stop(): Promise<void>;
  /** Settles when the worker has gone. */
  readonly exited: Promise<unknown>;
  /** The worker's process id, where it is a process on this machine. */
  readonly pid?: number;
}

export interface WorkerProvider {
  /**
   * Start a worker for `credential`. `secret` is the one it must be handed
   * (and nothing else of the gateway's); `dir` is the credential's directory
   * as the gateway sees it (`<state>/tenants/<credential>`), which the
   * provider makes the worker's own.
   */
  start(o: { credential: string; secret: string; dir: string }): Promise<WorkerHandle>;
}

/** The environment a local worker is started with: enough to run Bun, and its secret. Never the port secret. */
export function localWorkerEnv(secret: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = { [WORKER_SECRET_ENV]: secret };
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "TZ"]) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The worker entry, beside this file. */
export const WORKER_ENTRY = resolve(dirname(new URL(import.meta.url).pathname), "worker.ts");

/**
 * A process per credential on this machine, listening on loopback. Its
 * child is confined as every sandbox is, and the process holds no port
 * secret; the only boundary between workers is the kernel's, so this
 * serves one machine and its tests. A deployment for people outside it runs
 * a worker per pod.
 */
export function localWorkers(o: { entry?: string; startTimeoutMs?: number; env?: Record<string, string | undefined> } = {}): WorkerProvider {
  return {
    async start({ secret, dir }) {
      const proc = Bun.spawn([process.execPath, o.entry ?? WORKER_ENTRY, "--host", "127.0.0.1", "--port", "0"], {
        env: localWorkerEnv(secret, o.env),
        cwd: dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const ready = (async (): Promise<{ host: string; port: number }> => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`the worker exited before it listened (code ${await proc.exited})`);
          buf += decoder.decode(value, { stream: true });
          const line = buf.split("\n").find((l) => l.startsWith(WORKER_READY_PREFIX));
          if (line !== undefined) {
            const m = /^(.*):(\d+)$/.exec(line.slice(WORKER_READY_PREFIX.length).trim());
            if (m === null) throw new Error(`the worker said where it listens in a form not understood: ${line}`);
            return { host: m[1]!, port: Number(m[2]) };
          }
        }
      })();
      const timeout = o.startTimeoutMs ?? 15_000;
      let at: { host: string; port: number };
      try {
        at = await Promise.race([ready, Bun.sleep(timeout).then(() => Promise.reject(new Error(`the worker did not listen within ${timeout} ms`)))]);
      } catch (err) {
        proc.kill("SIGKILL");
        throw err;
      }
      // Nothing else is read from its stdout; keep draining it so a write never blocks.
      void (async () => {
        try {
          for (;;) if ((await reader.read()).done) return;
        } catch {
          // gone
        }
      })();
      let stopped: Promise<void> | undefined;
      return {
        ...at,
        pid: proc.pid,
        paths: { state: join(dir, "state"), sessions: join(dir, "sessions") },
        exited: proc.exited,
        stop: () =>
          (stopped ??= (async () => {
            proc.kill("SIGTERM");
            const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
            if (!done) proc.kill("SIGKILL");
          })()),
      };
    },
  };
}

/** A fresh worker secret. */
export function newWorkerSecret(): string {
  return randomBytes(32).toString("hex");
}

const ToolResultSchema = z.object({ text: z.string(), isError: z.boolean().optional() });
const LeaseAsk = z.strictObject({ token: z.string().min(1).max(256), account: z.string().max(64).optional() });
const TokenAsk = z.strictObject({ token: z.string().min(1).max(256) });
const LogNote = z.object({ line: z.string() });

export interface ConnectWorkerOptions {
  handle: WorkerHandle;
  secret: string;
  /** What the host is opened with, in the worker's paths. */
  open: WorkerOpen;
  /** The gateway's leaser for this credential: the worker's every lease request is answered by it. */
  leaser: Leaser;
  log: (line: string) => void;
  /** How long a tool call may run on the worker before the gateway gives up on it. */
  callTimeoutMs?: number;
}

/** Connect to a started worker, greet it, open its host, and drive it. */
export async function connectWorker(o: ConnectWorkerOptions): Promise<CredentialHost> {
  const socket = connect({ host: o.handle.host, port: o.handle.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const peer = new RpcPeer(socket);
  peer.handle("lease", async (params) => {
    const ask = LeaseAsk.parse(params);
    // Never the GM opt-in: the worker cannot ask for it, and the leaser would not send it.
    return o.leaser.lease({ token: ask.token, ...(ask.account !== undefined ? { account: ask.account } : {}) });
  });
  peer.handle("logout", async (params) => {
    await o.leaser.logout(TokenAsk.parse(params).token);
    return { ok: true };
  });
  peer.handle("release", async (params) => {
    await o.leaser.release(TokenAsk.parse(params).token);
    return { ok: true };
  });
  peer.onNotify("log", (params) => {
    const n = LogNote.safeParse(params);
    if (n.success) o.log(n.data.line.slice(0, 2_000));
  });
  let asked = false;
  // Settles only for a loss nobody asked for: a shutdown's own close is not one.
  const lost = new Promise<string>((resolve) => {
    void Promise.race([peer.closed.then(() => "the worker's channel closed"), o.handle.exited.then(() => "the worker exited")]).then((why) => {
      if (asked) return;
      peer.close();
      void o.handle.stop();
      resolve(why);
    });
  });
  try {
    await peer.request("hello", { secret: o.secret }, 10_000);
    await peer.request("open", o.open, 60_000);
  } catch (err) {
    peer.close();
    await o.handle.stop();
    throw err;
  }
  const callTimeoutMs = o.callTimeoutMs ?? 300_000;
  let shut: Promise<void> | undefined;
  return {
    lost,
    invoke: async (name, args, dispatchTs) => ToolResultSchema.parse(await peer.request("invoke", { name, args, dispatchTs }, callTimeoutMs)) as ToolResult,
    resume: async () => void (await peer.request("resume", {}, 120_000)),
    shutdown: () =>
      (shut ??= (async () => {
        asked = true;
        await peer.request("shutdown", {}, 60_000).catch(() => undefined);
        peer.close();
        await o.handle.stop();
      })()),
  };
}
