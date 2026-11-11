/**
 * Everything a model is served at fan-out 1, gathered as one JSON value: the
 * tool list, schemas, descriptions and parameter restatements, the fixed
 * texts the sandbox raises, and the served outputs of one scripted session
 * run two ways — over stdio through the real `main.ts` against a stub module,
 * and through a `SandboxHost` with short timeouts for the abandon and restart
 * paths. `fanout1-identity.test.ts` holds it byte for byte to
 * `fanout1-surface.json`, which was written from the commit before fan-out
 * existed, so the capability existing changes nothing for a single character.
 *
 * Only what varies run to run is normalised: clocks, durations, paths and the
 * random session token.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { PLAIN_RENDER } from "../../src/main";
import { SandboxHost, STATE_LOSS_RECOVERY } from "../../src/sandbox/host";
import { Scratchpad } from "../../src/scratchpad";
import { coreTools, renderActionHints, ToolSet, type CoreToolContext } from "../../src/tools";
import { selfCreateFrame, startStubModule, STUB_PORT_SECRET, type StubModule } from "./stub-module";

const ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Strike what differs between two runs of the same code: clocks, durations, paths, the token. */
export function normalise(text: string, o: { tmp?: string; tokens?: readonly string[] } = {}): string {
  let out = text.replaceAll(ROOT, "<root>");
  if (o.tmp !== undefined) out = out.replaceAll(o.tmp, "<tmp>");
  for (const t of o.tokens ?? []) if (t.length > 0) out = out.replaceAll(t, "<token>");
  return out
    .replace(/\b(ok|error) \(\d+ms\)/g, "$1 (<n>ms)")
    .replace(/\b1[6-9]\d{11}(\.\d+)?\b/g, "<ts>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
}

function schemaJson(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch (err) {
    return `unrepresentable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The five tools as `main.ts` serves them, with everything a refusal can quote. */
function staticSurface(): unknown {
  const core = coreTools(PLAIN_RENDER);
  const tools = new ToolSet([core.run_snippet, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]);
  return {
    names: tools.names,
    defs: tools.defs,
    specs: tools.specs.map((s) => ({ name: s.def.name, help: s.help, aliases: s.aliases ?? null, schema: schemaJson(s.schema) })),
    stateLossRecovery: STATE_LOSS_RECOVERY,
    hintBlock: renderActionHints([
      { action: "moveTo", status: "too_far", count: 3, hint: "the destination is farther than one move reaches", ts: 2 },
      { action: "castSpell", status: "not_ready", count: 1, hint: "the spell is on cooldown", ts: 1, from: "loop()" },
    ]),
  };
}

interface Exchange {
  request: unknown;
  response: unknown;
}

const call = (id: number, name: string, args: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** Frames the stub pushes mid-session: another player's line, ambient motion, a creature coming into view. */
function worldFrames(): { opcode: string; opcodeId?: number; data: unknown; ts: number }[] {
  const creature = "17365880163140632581";
  return [
    { opcode: "SMSG_MESSAGECHAT", opcodeId: 0x096, ts: 1_700_000_000_040, data: { type: 1, language: 7, senderGuid: "8", message: "fixture hello", chatTag: 0 } },
    {
      opcode: "SMSG_UPDATE_OBJECT",
      opcodeId: 0x0a9,
      ts: 1_700_000_000_110,
      data: {
        blocks: 1,
        objects: [
          {
            update: "create",
            guid: creature,
            objectType: "unit",
            moveFlags: 0,
            runSpeed: 7.5,
            pos: { x: -1200.0, y: 980.0, z: 42.0, o: 1.5 },
            fields: { entry: 90210, health: 120, maxHealth: 120, level: 4, faction: 7, unitFlags: 0, displayId: 111, powerType: 0, power1: 50, maxPower1: 100, race: 0, class: 0, gender: 0 },
          },
        ],
      },
    },
    { opcode: "MSG_MOVE_HEARTBEAT", opcodeId: 0x0ee, ts: 1_700_000_000_140, data: { guid: creature, flags: 1, pos: { x: -1210.0, y: 985.0, z: 42.0, o: 2.0 } } },
    { opcode: "SMSG_NOTIFICATION", opcodeId: 0x1cb, ts: 1_700_000_000_150, data: { text: "fixture notice" } },
  ];
}

/** One session over stdio through the real `main.ts`, its child confined, against the stub module. */
async function stdioSession(stub: StubModule, tmp: string): Promise<{ exchanges: Exchange[]; tokens: string[] }> {
  const proc = Bun.spawn(["bun", "--env-file=/dev/null", join(ROOT, "mcp", "src", "main.ts"), "--account", "RUNNER", "--dir", join(tmp, "state")], {
    cwd: ROOT,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      TMPDIR: tmp,
      WRATHBENCH_MODULE_URL: stub.baseUrl,
      WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readLine = async (): Promise<string> => {
    for (;;) {
      const i = buf.indexOf("\n");
      if (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`main.ts closed its stdout early: ${buf}`);
      buf += decoder.decode(value, { stream: true });
    }
  };
  const exchanges: Exchange[] = [];
  const ask = async (request: Record<string, unknown>): Promise<unknown> => {
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    await proc.stdin.flush();
    // A snippet's console output is mirrored onto this stream by the child's log
    // sink; only a JSON-RPC line is an answer.
    let line = await readLine();
    while (!line.startsWith('{"jsonrpc"')) line = await readLine();
    const response: unknown = JSON.parse(line);
    exchanges.push({ request, response });
    return response;
  };
  let id = 0;
  await ask({ jsonrpc: "2.0", id: ++id, method: "initialize", params: {} });
  await ask({ jsonrpc: "2.0", id: ++id, method: "tools/list" });
  await ask({ jsonrpc: "2.0", id: ++id, method: "ping" });
  // The ambient surface, before anything else binds a name.
  await ask(
    call(++id, "run_snippet", {
      code:
        "((names) => ({ count: names.length, hash: String(Bun.hash(names.join(','))), " +
        "ambient: ['sdk','state','events','connect','sleep','scratchpad','signal','API_MD_PATH','chars','character','characters'].map((k) => `${k}:${k in globalThis ? typeof globalThis[k] : 'absent'}`), " +
        "env: Object.keys(process.env).sort(), api: API_MD_PATH, token: sdk.token }))(Object.getOwnPropertyNames(globalThis).sort())",
    }),
  );
  await ask(call(++id, "state_summary", {}));
  await ask(call(++id, "recent_events", {}));
  await ask(
    call(++id, "run_snippet", {
      code: "await (async () => { await connect(); const s = await sdk.createSession({ character: 'fixa', race: 1, class: 1 }); await sleep(150, { wake: false }); return { character: s.character, guid: s.guid, self: state.self.guid, level: state.self.level?.value }; })()",
    }),
  );
  const token = [...stub.sessions.keys()][0] ?? "";
  for (const f of worldFrames()) stub.push(token, f);
  await ask(call(++id, "run_snippet", { snippet: "await sleep(150, { wake: false }); events.recent().length" }));
  await ask(call(++id, "recent_events", {}));
  await ask(call(++id, "recent_events", { limit: "1" }));
  await ask(call(++id, "recent_events", { include_movement: "true", limit: 3 }));
  await ask(call(++id, "state_summary", {}));
  await ask(call(++id, "run_snippet", { code: "console.log('a line'); console.warn('a warning'); throw new RangeError('fixture failure')" }));
  await ask(call(++id, "run_snippet", { code: "async () => 1" }));
  await ask(call(++id, "run_snippet", { code: "const kept = 41; kept + 1" }));
  await ask(call(++id, "run_snippet", { code: "kept" }));
  await ask(call(++id, "run_snippet", { code: "(await sdk.say('fixture line')).ok" }));
  await ask(call(++id, "write_scratchpad", { content: "# plan\n- one\n- two\n" }));
  await ask(call(++id, "edit_scratchpad", { old: "- one", new: "- ~~one~~" }));
  await ask(call(++id, "edit_scratchpad", { old: "- nine", new: "x" }));
  await ask(call(++id, "edit_scratchpad", { old: "- ", new: "* " }));
  await ask(call(++id, "edit_scratchpad", { old: "", new: "x" }));
  await ask(call(++id, "run_snippet", { code: "await scratchpad.read()" }));
  await ask(call(++id, "run_snipet", { code: "1" }));
  await ask(call(++id, "state_summary", { character: "Fixa" }));
  await ask(call(++id, "recent_events", { limit: 5, character: "Fixa" }));
  await ask(call(++id, "run_snippet", { code: "1", character: "Fixa" }));
  await ask(call(++id, "login_character", { name: "Fixb" }));
  await ask(call(++id, "list_characters", {}));
  await ask(call(++id, "run_snippet", '```json\n{"code": "2 + 2",}\n```'));
  await ask(call(++id, "run_snippet", "{not json"));
  await ask({ jsonrpc: "2.0", id: ++id, method: "resources/list" });
  proc.stdin.end();
  await proc.exited;
  return { exchanges, tokens: [token] };
}

/** The abandon and restart paths, through a host with short timeouts. */
async function hostPaths(stub: StubModule, tmp: string): Promise<unknown> {
  const core = coreTools(PLAIN_RENDER);
  const tools = new ToolSet([core.run_snippet, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]);
  const scratchpad = new Scratchpad(join(tmp, "host-scratchpad.md"));
  const token = "f".repeat(32);
  const lease = (await (
    await fetch(`${stub.baseUrl}/lease`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${STUB_PORT_SECRET}` }, body: JSON.stringify({ token, account: "HOSTED" }) })
  ).json()) as { secret: string };
  const logs: string[] = [];
  const host = new SandboxHost({
    moduleUrl: stub.baseUrl,
    token,
    secret: lease.secret,
    account: "HOSTED",
    scratchpad,
    snippetTimeoutMs: 2_000,
    pingGraceMs: 600,
    logSink: (_stream, text) => logs.push(text),
  });
  const ctx: CoreToolContext = { sandbox: host, scratchpad, sessionLive: () => true, turn: () => 0, secrets: { scrub: (t) => t } };
  const out: { tool: string; args: unknown; result: unknown; notices?: unknown }[] = [];
  const run = async (tool: string, args: unknown): Promise<void> => {
    const result = await tools.call(ctx, tool, args);
    const notices = host.drainNotices().map((n) => ({ kind: n.kind, text: n.text }));
    out.push({ tool, args, result, ...(notices.length > 0 ? { notices } : {}) });
  };
  try {
    await run("run_snippet", { code: "await connect(); (await sdk.createSession({ character: 'hosta', race: 1, class: 1 })).character" });
    await run("run_snippet", { code: "globalThis.kept = 7; await sleep(5000, { wake: false })" });
    await run("run_snippet", { code: "kept" });
    await run("run_snippet", { code: "for (;;) {}" });
    await run("run_snippet", { code: "typeof kept" });
    await run("run_snippet", { code: "await connect(); await sleep(100, { wake: false }); ({ connected: events.connected, self: state.self.guid })" });
    await run("state_summary", {});
    await run("run_snippet", { code: "process.exit(3)" });
    await run("run_snippet", { code: "1" });
  } finally {
    await host.stop();
  }
  return { calls: out, restarts: host.totalRestarts };
}

export async function fanout1Surface(): Promise<unknown> {
  const tmp = mkdtempSync(join(tmpdir(), "wrathbench-mcp-fan1-"));
  const stub = startStubModule({
    now: () => 1_700_000_001_000,
    onLogin: (s) => [selfCreateFrame(s)],
  });
  try {
    const stdio = await stdioSession(stub, tmp);
    const host = await hostPaths(stub, tmp);
    const surface = { static: staticSurface(), stdio: stdio.exchanges, host, wire: stub.calls.map((c) => `${c.auth} ${c.method} ${c.path}${c.body?.["action"] !== undefined ? ` ${String(c.body["action"])}` : ""}`) };
    return JSON.parse(normalise(JSON.stringify(surface), { tmp, tokens: [...stdio.tokens, "f".repeat(32)] })) as unknown;
  } finally {
    await stub.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const path = join(import.meta.dir, "fanout1-surface.json");
  await Bun.write(path, `${JSON.stringify(await fanout1Surface(), null, 2)}\n`);
  console.error(`wrote ${path}`);
}
