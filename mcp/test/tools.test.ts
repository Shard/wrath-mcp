/**
 * The stack's tool surface on its own: the core tools through one `ToolSet`,
 * a harness tool slotted among them, and the MCP server over it — against a
 * stand-in sandbox, no child and no game stack.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SDK_VERSION } from "@wrathbench/sdk";
import { PLAIN_RENDER, withNotices } from "../src/main";
import { SecretRedactor } from "../src/redact";
import type { ActionHintNote, EventSummary } from "../src/sandbox/ipc";
import { Scratchpad } from "../src/scratchpad";
import { McpServer } from "../src/server";
import { coreTools, toolCallCount, ToolSet, type CoreToolContext, type ToolSpec } from "../src/tools";
import { MCP_PACKAGE_VERSION } from "../src/version";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function context(pending: ActionHintNote[] = []): CoreToolContext {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-tools-"));
  dirs.push(dir);
  const secrets = new SecretRedactor();
  secrets.redact("lease-0123456789abcdef");
  const events: EventSummary[] = [
    { seq: 1, ts: 1, opcode: "SMSG_MONSTER_MOVE", data: {} },
    { seq: 2, ts: 2, opcode: "SMSG_ATTACKSTART", data: { victimGuid: "1" } },
  ];
  return {
    sandbox: {
      evalSnippet: async () => ({ ok: true, value: "1", logs: [{ level: "log", ts: 1, text: "lease-0123456789abcdef" }], durationMs: 3 }),
      recentEvents: async (n) => events.slice(-n),
      stateSnapshot: async () => ({ self: { guid: "1" } }),
      drainActionHints: async () => pending.splice(0),
    },
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    sessionLive: () => true,
    turn: () => 0,
    secrets,
  };
}

const core = coreTools(PLAIN_RENDER);
/** A harness tool between two core tools, the way a harness orders its own. */
const echo: ToolSpec = {
  def: { name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { say: { type: "string" } }, additionalProperties: false } },
  schema: z.strictObject({ say: z.string() }),
  help: "echo expects { say: string }.",
  aliases: { text: "say" },
  enabled: (ctx) => ctx.turn() >= 0,
  run: async (ctx, args) => ({ text: `${(args as { say: string }).say} after ${toolCallCount(ctx)} calls` }),
};
const tools = new ToolSet([core.run_snippet, echo, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]);

describe("ToolSet", () => {
  test("serves the tools in the order it was given", () => {
    expect(tools.names).toEqual(["run_snippet", "echo", "recent_events", "state_summary", "write_scratchpad", "edit_scratchpad"]);
  });

  test("a harness tool goes through the same aliasing, validation and counter", async () => {
    const ctx = context();
    expect((await tools.call(ctx, "state_summary", {})).text).toContain('"guid":"1"');
    expect((await tools.call(ctx, "echo", { text: "hi" })).text).toBe("hi after 2 calls");
    const bad = await tools.call(ctx, "echo", { say: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toEndWith("echo expects { say: string }.");
  });

  test("an unknown tool lists every tool in serving order, with the near miss", async () => {
    const res = await tools.call(context(), "run_snipet", {});
    expect(res.text).toBe(
      "unknown tool: run_snipet. Valid tools: run_snippet, echo, recent_events, state_summary, write_scratchpad, edit_scratchpad. Did you mean run_snippet?",
    );
  });

  test("results are scrubbed and pending hints ride a non-snippet result", async () => {
    const ctx = context([{ action: "move_to", status: "too_far", count: 2, ts: 1, hint: "split the walk" }]);
    const snippet = await tools.call(ctx, "run_snippet", { code: "1" });
    expect(snippet.text).toContain("[redacted]");
    expect(snippet.text).not.toContain("lease-0123456789abcdef");
    const pad = await tools.call(ctx, "write_scratchpad", { content: "x" });
    expect(pad.text).toBe("written (1 chars)\n--- harness ---\nmove_to too_far ×2: split the walk");
  });

  test("recent_events folds what the render calls ambient", async () => {
    const res = await tools.call(context(), "recent_events", {});
    expect(res.text.split("\n")).toEqual([
      '#2 SMSG_ATTACKSTART {"victimGuid":"1"}',
      "(+1 ambient movement and party-frame events folded into state — pass {includeMovement: true} for the raw stream)",
    ]);
  });
});

describe("McpServer", () => {
  const ctx = context();
  const server = new McpServer({
    list: () => tools.defs,
    coerce: (name, raw) => tools.coerce(name, raw),
    call: (name, args, origin) => tools.call(ctx, name, args, origin),
    appendPending: (result) => tools.appendPending(ctx, result),
  });

  test("names itself the stack's server unless told otherwise", async () => {
    const res = JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })))!);
    expect(res.result.serverInfo).toEqual({ name: "wrathbench-mcp", version: "0.0.0" });
  });

  test("lists and calls the tool set", async () => {
    const list = JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([...tools.names]);
    const call = JSON.parse(
      (await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: '{"say": "x",}' } })))!,
    );
    expect(call.result.content[0].text).toStartWith("x after");
  });
});

test("the package version constant is package.json's, and the SDK's: the stack releases as one", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
  expect(MCP_PACKAGE_VERSION).toBe(pkg.version);
  expect(MCP_PACKAGE_VERSION).toBe(SDK_VERSION);
});

test("the bare server hands pending sandbox notices to the next result, scrubbed", () => {
  const secrets = new SecretRedactor();
  secrets.redact("lease-0123456789abcdef");
  const pending = [{ ts: 1, kind: "sandbox_restarted" as const, text: "exited; Last stderr: lease-0123456789abcdef" }];
  const sandbox = { drainNotices: () => pending.splice(0) };
  expect(withNotices(sandbox, secrets, { text: "ok" }).text).toBe("ok\n--- notices ---\nsandbox_restarted: exited; Last stderr: [redacted]");
  expect(withNotices(sandbox, secrets, { text: "ok" })).toEqual({ text: "ok" });
});
