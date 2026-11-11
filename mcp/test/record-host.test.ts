/**
 * The record end to end, with the real confined child and no game stack: a
 * host given a session writer runs the recorder in its child, drains it on
 * its own tick, writes the tool calls its dispatcher saw, and leaves a valid
 * session behind. A host given none runs no recorder at all.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAIN_RENDER } from "../src/main";
import type { CallRow } from "../src/record/format";
import { SessionReader } from "../src/record/reader";
import { validateSession } from "../src/record/validate";
import { SessionWriter } from "../src/record/writer";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { coreTools, ToolSet, type CoreToolContext } from "../src/tools";

const dirs: string[] = [];
const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig(record: boolean): { host: SandboxHost; writer: SessionWriter; ctx: CoreToolContext; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "wrathbench-mcp-rec-"));
  dirs.push(root);
  const dir = join(root, "session");
  const writer = new SessionWriter({ dir, id: "0123456789abcdef", stack: { version: "0.0.0-test" }, log: () => {} });
  if (record) writer.open();
  const scratchpad = new Scratchpad(join(root, "scratchpad.md"));
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 2_000,
    logSink: () => {},
    // A tick the test never waits for: it drains by hand.
    ...(record ? { record: { writer, tickMs: 3_600_000 } } : {}),
  });
  hosts.push(host);
  const ctx: CoreToolContext = { sandbox: host, scratchpad, sessionLive: () => false, turn: () => 0, secrets: { scrub: (t) => t }, ...(record ? { record: writer } : {}) };
  return { host, writer, ctx, dir };
}

const core = coreTools(PLAIN_RENDER);
const tools = new ToolSet([core.run_snippet, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]);

describe("a host that records", () => {
  test("drains its child's recorder and writes the calls its dispatcher saw, as a valid session", async () => {
    const { host, writer, ctx, dir } = rig(true);
    const at = Date.now();
    const answer = await tools.call(ctx, "run_snippet", { code: "1 + 1" }, { dispatchTs: at });
    expect(answer.text).toContain("2");
    await tools.call(ctx, "recent_events", {});
    await host.recordDrain();
    const reader = new SessionReader(dir);
    // No world yet: each recorder has stated itself with nothing observed.
    expect(reader.rows("trace")[0]).toMatchObject({ kind: "key", map: null, data: { level: null, auras: [], money: null } });
    expect(reader.rows("events")[0]).toMatchObject({ kind: "key", state: { level: null, dead: false, group: null } });
    expect(reader.rows("nearby")[0]).toMatchObject({ kind: "key", units: [] });
    expect(reader.live()).toMatchObject({ observed: expect.any(Number), stream: { connected: false, events: 0 } });
    // A window boundary crossed mid-test would add a key row; only the first is this test's.
    const calls = (reader.rows("calls") as CallRow[]).filter((r, i) => i === 0 || r.kind !== "key");
    expect(calls.map((r) => r.kind)).toEqual(["key", "call", "result", "call", "events", "result"]);
    expect(calls[1]).toMatchObject({ id: at, tool: "run_snippet", args: { code: "1 + 1" }, origin: { type: "tool" } });
    expect(calls[2]).toMatchObject({ id: at, error: false });
    expect((calls[2] as { text: string }).text).toBe(answer.text);
    expect(calls[4]).toMatchObject({ kind: "events", count: 0, origin: { type: "tool", call: (calls[3] as { id: number }).id } });
    expect(validateSession(dir).errors).toEqual([]);

    await host.stop();
    await writer.close();
    const v = validateSession(dir);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.session?.ended).not.toBeNull();
  });

  test("a record drain never starts a child", async () => {
    const { host, dir } = rig(true);
    await host.recordDrain();
    expect(new SessionReader(dir).live()).toMatchObject({ observed: null, stream: null });
    expect(existsSync(join(dir, "trace"))).toBe(false);
  });

  test("the last of the record is drained when the host stops", async () => {
    const { host, writer, ctx, dir } = rig(true);
    await tools.call(ctx, "state_summary", {});
    await host.stop();
    await writer.close();
    expect(new SessionReader(dir).rows("trace")[0]).toMatchObject({ kind: "key" });
  });
});

describe("a host that does not record", () => {
  test("its child runs no recorder and nothing is written", async () => {
    const { host, ctx, dir } = rig(false);
    await tools.call(ctx, "run_snippet", { code: "1" });
    expect(await host.rpc("record_drain")).toBeNull();
    await host.recordDrain();
    expect(existsSync(dir)).toBe(false);
  });
});
