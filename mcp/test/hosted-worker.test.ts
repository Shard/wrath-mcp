/**
 * A credential's worker on its own: started by the local provider with no
 * port secret in its environment, refusing any connection that does not
 * know its secret, asking the gateway for every lease, and gone when its
 * gateway is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWorker, WORKER_SECRET_ENV } from "../src/hosted/worker";
import { RpcPeer, MAX_LINE_BYTES } from "../src/hosted/worker-rpc";
import { connectWorker, localWorkerEnv, localWorkers, newWorkerSecret } from "../src/hosted/workers";
import type { OpenedHost } from "../src/host";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const dial = async (port: number): Promise<RpcPeer> => {
  const s = connect({ host: "127.0.0.1", port });
  await new Promise<void>((r, j) => (s.once("connect", () => r()), s.once("error", j)));
  const p = new RpcPeer(s);
  cleanups.push(() => p.close());
  return p;
};

describe("the local provider", () => {
  test("starts a worker whose environment holds its secret and no port secret", async () => {
    expect(localWorkerEnv("s".repeat(64), { PATH: "/bin", WRATHBENCH_MODULE_SECRET: "port", WRATH_MCP_GRANTS_FILE: "/g", HOME: "/h" })).toEqual({ [WORKER_SECRET_ENV]: "s".repeat(64), PATH: "/bin", HOME: "/h" });
    const dir = mkdtempSync(join(tmpdir(), "wm-worker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const handle = await localWorkers({ env: { ...process.env, WRATHBENCH_MODULE_SECRET: "port-secret-that-must-not-travel" } }).start({ credential: "a", secret: newWorkerSecret(), dir });
    cleanups.push(() => handle.stop());
    const environ = readFileSync(`/proc/${handle.pid}/environ`, "utf8").split("\0");
    expect(environ.some((e) => e.startsWith("WRATHBENCH_MODULE_SECRET="))).toBe(false);
    expect(handle.paths).toEqual({ state: join(dir, "state"), sessions: join(dir, "sessions") });
    await handle.stop();
    await handle.exited;
  }, 30_000);
});

describe("a worker", () => {
  test("refuses a wrong secret and anything before hello, and closes", async () => {
    const w = await serveWorker({ secret: "x".repeat(64), helloWaitMs: 60_000 });
    cleanups.push(() => w.stop());
    const early = await dial(w.port);
    await expect(early.request("open", {})).rejects.toThrow("say hello first");
    await early.closed;
    const wrong = await dial(w.port);
    await expect(wrong.request("hello", { secret: "y".repeat(64) })).rejects.toThrow("refused");
    await wrong.closed;
    const right = await dial(w.port);
    expect(await right.request("hello", { secret: "x".repeat(64) })).toEqual({ ok: true, open: false });
    // One gateway at a time.
    const second = await dial(w.port);
    await second.closed;
  });

  test("exits when no gateway greets it in time, and when its gateway is gone", async () => {
    let exits = 0;
    const lonely = await serveWorker({ secret: "x".repeat(64), helloWaitMs: 50, onExit: () => exits++ });
    cleanups.push(() => lonely.stop());
    await Bun.sleep(200);
    expect(exits).toBe(1);
    const left = await serveWorker({ secret: "x".repeat(64), orphanMs: 50, onExit: () => exits++ });
    cleanups.push(() => left.stop());
    const p = await dial(left.port);
    await p.request("hello", { secret: "x".repeat(64) });
    p.close();
    await Bun.sleep(250);
    expect(exits).toBe(2);
  });

  test("asks the gateway for every lease, and gets what the gateway's leaser answers", async () => {
    const asked: string[] = [];
    const w = await serveWorker({
      secret: "x".repeat(64),
      openHost: async (h) => {
        const lease = await h.leaser!.lease({ token: "t".repeat(32), account: "B1", allowGm: true });
        asked.push(JSON.stringify(lease));
        return { tools: { list: () => [], coerce: (_n: string, a: unknown) => ({ ok: true as const, args: a }), call: async () => ({ text: "ran" }), appendPending: async (r: { text: string }) => r }, resume: async () => {}, shutdown: async () => {}, flushCache: () => {}, recordedIn: undefined, surface: { fanout: false, program: false }, sandbox: undefined as never } as OpenedHost;
      },
    });
    cleanups.push(() => w.stop());
    let exit!: () => void;
    const exited = new Promise<void>((r) => (exit = r));
    const host = await connectWorker({
      handle: { host: w.host, port: w.port, paths: { state: "/s", sessions: "/r" }, exited, stop: async () => (await w.stop(), exit()) },
      secret: "x".repeat(64),
      open: { moduleUrl: "http://module.invalid", dir: "/s", token: "t".repeat(32), grant: null, program: false, record: null },
      leaser: {
        lease: async (o) => {
          asked.push(`lease ${o.token.slice(0, 4)} ${o.account} gm=${o.allowGm === true}`);
          return { secret: "leased", account: o.account!, allowGm: false };
        },
        logout: async () => {},
        release: async () => {},
      },
      log: () => {},
    });
    // The GM opt-in never crosses the channel, whatever the host asked.
    expect(asked).toEqual(["lease tttt B1 gm=false", JSON.stringify({ secret: "leased", account: "B1", allowGm: false })]);
    expect(await host.invoke("anything", {}, 1)).toEqual({ text: "ran" });
    await host.shutdown();
  });
});

describe("the channel", () => {
  test("closes on a line longer than its limit", async () => {
    const w = await serveWorker({ secret: "x".repeat(64) });
    cleanups.push(() => w.stop());
    const s = connect({ host: "127.0.0.1", port: w.port });
    await new Promise<void>((r) => s.once("connect", () => r()));
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    s.write("a".repeat(MAX_LINE_BYTES + 10));
    await closed;
  });
});
