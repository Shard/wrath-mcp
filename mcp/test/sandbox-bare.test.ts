/**
 * The bare stack's sandbox: `SandboxHost` with its own default child entry
 * (`src/sandbox/entry.ts`, no harness extension), against the real confined
 * child and no game stack. What a snippet sees here is what it sees under any
 * harness; what a harness adds rides the extension's rpc names and the
 * snapshot fields this child does not have.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_MD_PATH } from "@wrathbench/sdk";
import { Scratchpad } from "../src/scratchpad";
import { SANDBOX_FORWARDED_ENV, SandboxHost } from "../src/sandbox/host";

const dirs: string[] = [];
const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeHost(): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-sbx-"));
  dirs.push(dir);
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 2_000,
    pingGraceMs: 1_000,
    logSink: () => {},
  });
  hosts.push(host);
  return host;
}

describe("the bare sandbox child", () => {
  test("evaluates a snippet with the whole ambient surface", async () => {
    const host = makeHost();
    const r = await host.evalSnippet(
      "['sdk','state','events','connect','sleep','scratchpad','signal','API_MD_PATH'].filter((k) => !(k in globalThis))",
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe("[]");
    const api = await host.evalSnippet("API_MD_PATH");
    expect(api.value).toBe(JSON.stringify(API_MD_PATH));
  });

  test("its snapshot is the cache's plus the session's own two fields, and no harness's", async () => {
    const host = makeHost();
    const snap = await host.stateSnapshot();
    expect(snap["observation"]).toEqual({ connected: false });
    expect(snap["move"]).toBeNull();
    expect("units" in snap).toBe(false);
    // A name no extension registered answers the snapshot, as state_summary does.
    expect(Object.keys((await host.rpc("not_a_method")) as object)).toEqual(Object.keys(snap));
  });

  test("a drain never starts a child", async () => {
    const host = makeHost();
    expect(await host.drain("action_hints")).toBeNull();
    expect(await host.drainActionHints()).toEqual([]);
  });

  test("the named env list is what the child actually reads", () => {
    const child = readFileSync(join(import.meta.dir, "..", "src", "sandbox", "child.ts"), "utf8");
    const read = [...child.matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)].map((m) => m[1]!);
    const provided = new Set([...SANDBOX_FORWARDED_ENV, "WRATHBENCH_MODULE_URL", "WRATHBENCH_TOKEN", "WRATHBENCH_SECRET", "WRATHBENCH_ACCOUNT"]);
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((k) => !provided.has(k))).toEqual([]);
  });
});
