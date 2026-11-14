/**
 * The entries a deployment builds on: `runGateway` with a provider of its
 * own (a pod per credential).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateway, type WorkerProvider } from "../src/hosted/gateway-main";
import { emptyGrantsFile, keyDigest, writeGrantsFile } from "../src/hosted/grants";
import { localWorkers } from "../src/hosted/workers";
import { startStubModule, STUB_PORT_SECRET } from "./fixtures/stub-module";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

test("runGateway serves with the provider it is handed", async () => {
  const stub = startStubModule();
  cleanups.push(() => stub.stop());
  const dir = mkdtempSync(join(tmpdir(), "wm-entry-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = "wmk_entry-key";
  writeGrantsFile(join(dir, "grants.json"), { ...emptyGrantsFile(), grants: [{ id: "a", person: "pat", keyHashes: [{ id: "kaaaa", sha256: keyDigest(key) }], accounts: ["A1"], maxCharacters: 1 }] });
  const started: string[] = [];
  const local = localWorkers({ trusted: true });
  const workers: WorkerProvider = { start: async (o) => (started.push(o.credential), local.start(o)) };
  const running = await runGateway(
    { grants: join(dir, "grants.json"), state: join(dir, "state"), host: "127.0.0.1", port: 0, program: false, allowedOrigins: [], trustForwardedFor: false, recordRetentionMs: 3_600_000 },
    { workers, env: { WRATHBENCH_MODULE_URL: stub.baseUrl, WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET }, log: () => {} },
  );
  cleanups.push(() => running.stop());
  const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "run_snippet" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_snippet", arguments: { code: "40 + 2" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
  });
  expect(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text).toContain("42");
  expect(started).toEqual(["a"]);
  await running.stop();
  expect(running.gateway.ledger.seats()).toHaveLength(0);
}, 30_000);

test("runGateway refuses to start without the port secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-entry-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeGrantsFile(join(dir, "grants.json"), emptyGrantsFile());
  await expect(runGateway({ grants: join(dir, "grants.json"), state: join(dir, "state"), host: "127.0.0.1", port: 0, program: false, allowedOrigins: [], trustForwardedFor: false, recordRetentionMs: 1, trustedLocalWorkers: true }, { env: {}, log: () => {} })).rejects.toThrow("WRATHBENCH_MODULE_SECRET");
});

test("runGateway refuses to start with no provider unless local workers are trusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-entry-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeGrantsFile(join(dir, "grants.json"), emptyGrantsFile());
  const args = { grants: join(dir, "grants.json"), state: join(dir, "state"), host: "127.0.0.1", port: 0, program: false, allowedOrigins: [], trustForwardedFor: false, recordRetentionMs: 1 };
  const env = { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET, WRATHBENCH_MODULE_URL: "http://127.0.0.1:1" };
  await expect(runGateway(args, { env, log: () => {} })).rejects.toThrow("--trusted-local-workers");
  const running = await runGateway({ ...args, trustedLocalWorkers: true }, { env, log: () => {} });
  await running.stop();
});

test("behind a proxy, the audit names the address the proxy added, never one the client sent", async () => {
  const { forwardedFor } = await import("../src/hosted/gateway-main");
  expect(forwardedFor(new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.9" }))).toBe("10.0.0.9");
  expect(forwardedFor(new Headers({ "x-forwarded-for": "10.0.0.9" }))).toBe("10.0.0.9");
  expect(forwardedFor(new Headers({ "x-forwarded-for": "6.6.6.6," }))).toBeUndefined();
  expect(forwardedFor(new Headers())).toBeUndefined();
});
