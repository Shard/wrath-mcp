/**
 * A credential's worker on its own: started by the local provider with no
 * port secret in its environment, refusing any connection that does not
 * know its secret, asking the gateway for every lease, and gone when its
 * gateway is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWorker, WORKER_SECRET_ENV } from "../src/hosted/worker";
import { RpcPeer, MAX_LINE_BYTES } from "../src/hosted/worker-rpc";
import { connectWorker, localWorkerEnv, localWorkers, newWorkerSecret } from "../src/hosted/workers";
import type { OpenedHost } from "../src/host";
import { portSecretLeaser } from "../src/module-auth";
import { startStubModule, STUB_PORT_SECRET } from "./fixtures/stub-module";

/** A host that answers every call and records how it was shut. */
function standInHost(shut: string[]): OpenedHost {
  return { tools: { list: () => [], coerce: (_n: string, a: unknown) => ({ ok: true as const, args: a }), call: async () => ({ text: "ran" }), appendPending: async (r: { text: string }) => r }, resume: async () => {}, shutdown: async (o?: { logout: boolean }) => void shut.push(`logout=${o?.logout}`), flushCache: () => {}, recordedIn: undefined, surface: { fanout: false, program: false }, sandbox: undefined as never } as OpenedHost;
}

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
    const left = await serveWorker({ secret: "x".repeat(64), onExit: () => exits++ });
    cleanups.push(() => left.stop());
    const p = await dial(left.port);
    await p.request("hello", { secret: "x".repeat(64) });
    p.close();
    await Bun.sleep(250);
    expect(exits).toBe(2);
  });

  test("asks the gateway for every lease, and gets what the gateway's leaser answers", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "wm-worker-ask-"));
    cleanups.push(() => rmSync(lockDir, { recursive: true, force: true }));
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
      open: { moduleUrl: "http://module.invalid", dir: lockDir, token: "t".repeat(32), grant: null, program: false, record: null },
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

describe("a worker, from the inside", () => {
  test("reads no .env from where it runs, and so never asks the module anything with the port secret", async () => {
    const stub = startStubModule();
    cleanups.push(() => stub.stop());
    const dir = mkdtempSync(join(tmpdir(), "wm-worker-env-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "state"));
    // A .env and a bunfig beside the worker, as a container image or a careless cwd could leave them.
    writeFileSync(join(dir, ".env"), `WRATHBENCH_MODULE_SECRET=${STUB_PORT_SECRET}\n`);
    const secret = newWorkerSecret();
    const handle = await localWorkers({ cwd: dir }).start({ credential: "a", secret, dir });
    cleanups.push(() => handle.stop());
    const leaser = portSecretLeaser({ moduleUrl: stub.baseUrl, env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET } });
    const host = await connectWorker({
      handle,
      secret,
      // No module identity handed: the host asks /health itself, with whatever its process holds.
      open: { moduleUrl: stub.baseUrl, dir: join(dir, "state"), token: "w".repeat(32), account: "A1", grant: null, program: false, record: { root: join(dir, "sessions"), retentionMs: 3_600_000 } },
      leaser,
      log: () => {},
    });
    await host.invoke("run_snippet", { code: "1" }, 1);
    await Bun.sleep(100);
    const fromWorker = stub.calls.filter((c) => c.auth === "operator" && c.path !== "/lease");
    expect(fromWorker).toEqual([]);
    expect(stub.calls.some((c) => c.path === "/health" && c.auth !== "operator")).toBe(true);
    await host.shutdown();
  }, 30_000);

  test("a worker whose gateway vanished stops without logging out, and a second worker for the same state waits for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-worker-lock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const shut: string[] = [];
    const opened: string[] = [];
    const open = (name: string) => async () => {
      opened.push(name);
      return standInHost(shut);
    };
    const first = await serveWorker({ secret: "x".repeat(64), openHost: open("first") });
    cleanups.push(() => first.stop());
    const p1 = await dial(first.port);
    await p1.request("hello", { secret: "x".repeat(64) });
    const args = { moduleUrl: "http://module.invalid", dir, token: "t".repeat(32), grant: null, program: false, record: null };
    await p1.request("open", args);
    const second = await serveWorker({ secret: "y".repeat(64), openHost: open("second") });
    cleanups.push(() => second.stop());
    const p2 = await dial(second.port);
    await p2.request("hello", { secret: "y".repeat(64) });
    const secondOpen = p2.request("open", args);
    await Bun.sleep(400);
    expect(opened).toEqual(["first"]);
    // The first worker's gateway is gone: it stops at once, without a logout nobody could take.
    p1.close();
    await secondOpen;
    expect(opened).toEqual(["first", "second"]);
    expect(shut).toEqual(["logout=false"]);
  }, 30_000);
});
