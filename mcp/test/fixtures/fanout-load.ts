#!/usr/bin/env bun
/**
 * A load measurement for fan-out, run by hand: N characters in one confined
 * child against the stub module, every one of them receiving the same room —
 * `UNITS` units in view, each moving and changing at `RATE` frames a second
 * per character — with the session recorders running. It prints how long the
 * seats take to open, how late the child's event loop runs under that load,
 * how long the tools that read every seat take, and how long a killed child
 * takes to come back with every seat reattached.
 *
 *   bun mcp/test/fixtures/fanout-load.ts [characters=5] [frames-per-second-per-character=200] [seconds=10]
 *
 * Synthetic: the stub answers at once and its frames are invented, so this
 * measures the stack's own cost per frame (decode, fold, record) and nothing
 * of a worldserver's. Not a test: nothing asserts on a machine's speed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterRoster, FANOUT_TOOL_ORDER, fanoutTools, type FanoutToolContext } from "../../src/fanout";
import { PLAIN_RENDER } from "../../src/main";
import { tokenFingerprint } from "../../src/module-auth";
import { SessionStore } from "../../src/record/store";
import { SessionWriter } from "../../src/record/writer";
import { SecretRedactor } from "../../src/redact";
import { SandboxHost } from "../../src/sandbox/host";
import { Scratchpad } from "../../src/scratchpad";
import { ToolSet } from "../../src/tools";
import { selfCreateFrame, startStubModule, STUB_PORT_SECRET } from "./stub-module";

const N = Number(Bun.argv[2] ?? 5);
const RATE = Number(Bun.argv[3] ?? 200);
const SECONDS = Number(Bun.argv[4] ?? 10);
const UNITS = 60;

const unitGuid = (i: number): string => String(17365880163140632000n + BigInt(i));
const unitCreate = (i: number): { opcode: string; opcodeId: number; data: unknown } => ({
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: unitGuid(i),
        objectType: "unit",
        moveFlags: 0,
        runSpeed: 7.5,
        pos: { x: -1200 + i, y: 980 + (i % 7), z: 42, o: 1.5 },
        fields: { entry: 90000 + (i % 12), health: 1200, maxHealth: 1200, level: 20, faction: 7, unitFlags: 0, displayId: 111, powerType: 0, power1: 50, maxPower1: 100, race: 0, class: 0, gender: 0 },
      },
    ],
  },
});

const tmp = mkdtempSync(join(tmpdir(), "wrathbench-mcp-load-"));
const stub = startStubModule({ onLogin: (s) => [selfCreateFrame(s), ...Array.from({ length: UNITS }, (_, i) => unitCreate(i))] });
const scratchpad = new Scratchpad(join(tmp, "scratchpad.md"));
const sandbox = new SandboxHost({ moduleUrl: stub.baseUrl, token: "", scratchpad, snippetTimeoutMs: 30_000, pingGraceMs: 5_000, fanout: { maxCharacters: N }, record: {}, logSink: () => {} });
const store = new SessionStore(join(tmp, "sessions"));
const secrets = new SecretRedactor();
const roster = new CharacterRoster({
  grant: { maxCharacters: Math.max(2, N), accounts: Array.from({ length: Math.max(2, N) }, (_, i) => `LOAD${String(i + 1).padStart(2, "0")}`) },
  moduleUrl: stub.baseUrl,
  sandbox,
  secrets,
  env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
  record: (seat) => {
    const id = tokenFingerprint(seat.token);
    const w = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: "load" }, token: seat.token, log: () => {} });
    w.open();
    return w;
  },
});
const ctx: FanoutToolContext = { sandbox, scratchpad, sessionLive: () => true, turn: () => 0, secrets, fanout: roster, record: roster.calls };
const specs = fanoutTools<FanoutToolContext>(PLAIN_RENDER);
const tools = new ToolSet(FANOUT_TOOL_ORDER.map((n) => specs[n]));
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
};
const ms = (n: number): string => `${n.toFixed(n < 10 ? 1 : 0)}ms`;

const [, loginMs] = await timed(async () => {
  for (let i = 0; i < N; i++) {
    const r = await tools.call(ctx, "login_character", { name: `Load${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, race: 1, class: 1 });
    if (r.isError === true) throw new Error(r.text);
  }
});
console.log(`${N} characters, ${UNITS} units in view each, ${RATE} frames/s per character for ${SECONDS}s (${N * RATE} frames/s into one child)`);
console.log(`login: ${ms(loginMs)} for ${N} (${ms(loginMs / N)} each, one after another)`);

// The child's own measure of how late its event loop runs: a 10ms timer's drift.
await sandbox.evalSnippet("globalThis.lags = []; globalThis.t = performance.now(); globalThis.iv = setInterval(() => { const n = performance.now(); lags.push(n - t - 10); t = n; }, 10); 0");
const tokens = [...stub.sessions.keys()];
let sent = 0;
const started = performance.now();
const tick = setInterval(() => {
  // Every character is sent the same frame: one room, seen N times.
  const due = Math.floor(((performance.now() - started) / 1000) * RATE) - sent;
  for (let k = 0; k < due; k++) {
    const i = (sent + k) % UNITS;
    const frame =
      (sent + k) % 5 === 0
        ? { opcode: "SMSG_UPDATE_OBJECT", opcodeId: 0x0a9, data: { blocks: 1, objects: [{ update: "values", guid: unitGuid(i), fields: { health: 1200 - ((sent + k) % 1000) } }] } }
        : { opcode: "MSG_MOVE_HEARTBEAT", opcodeId: 0x0ee, data: { guid: unitGuid(i), flags: 1, pos: { x: -1200 + i + ((sent + k) % 9), y: 980, z: 42, o: 2 } } };
    for (const t of tokens) stub.push(t, frame);
  }
  sent += Math.max(0, due);
}, 5);
const toolTimes: Record<string, number[]> = { rollup: [], merged: [], one: [], drain: [] };
const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  toolTimes["rollup"]!.push((await timed(() => tools.call(ctx, "state_summary", {})))[1]);
  toolTimes["merged"]!.push((await timed(() => tools.call(ctx, "recent_events", { includeMovement: true, limit: 50 })))[1]);
  toolTimes["one"]!.push((await timed(() => tools.call(ctx, "recent_events", { character: roster.views()[0]!.character })))[1]);
  toolTimes["drain"]!.push((await timed(() => sandbox.recordDrain()))[1]);
  await Bun.sleep(500);
}
clearInterval(tick);
const lag = await sandbox.evalSnippet(
  "(() => { clearInterval(iv); const s = [...lags].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; " +
    "return JSON.stringify({ n: s.length, p50: q(0.5), p99: q(0.99), max: s[s.length - 1], folded: Object.values(chars).map((c) => c.state.eventCount).reduce((a, b) => a + b, 0), cpu: process.cpuUsage() }); })()",
);
const l = JSON.parse(JSON.parse(lag.value ?? '"{}"') as string) as { n: number; p50: number; p99: number; max: number; folded: number; cpu: { user: number; system: number } };
const elapsed = (performance.now() - started) / 1000;
console.log(`sent ${sent} frames to each (${(sent / elapsed).toFixed(0)}/s), the child folded ${l.folded} in all (${(l.folded / elapsed).toFixed(0)}/s)`);
console.log(`event-loop lag (10ms timer, ${l.n} samples): p50 ${ms(l.p50)}, p99 ${ms(l.p99)}, max ${ms(l.max)}`);
console.log(`child cpu since start: ${((l.cpu.user + l.cpu.system) / 1e6).toFixed(1)}s over ${elapsed.toFixed(1)}s of load`);
const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const max = (xs: number[]): number => Math.max(0, ...xs);
for (const [k, label] of [["rollup", "state_summary (roll-up of all)"], ["merged", "recent_events (merged, raw stream)"], ["one", "recent_events (one character)"], ["drain", "record drain (all seats)"]] as const) {
  console.log(`${label}: median ${ms(med(toolTimes[k]!))}, max ${ms(max(toolTimes[k]!))}`);
}

// A blocked event loop: the child is killed, and every seat reattaches with its replay.
const [, restartMs] = await timed(() => sandbox.evalSnippet("for (;;) {}"));
const [after] = await timed(() => sandbox.evalSnippet("Object.values(chars).filter((c) => c.events.connected && c.state.self.guid !== undefined).length"));
console.log(`blocked snippet: ${ms(restartMs)} to a fresh child with every seat reattached (30000ms snippet timeout + 5000ms ping grace included), ${after.value} of ${N} attached and replayed`);

await sandbox.stop();
await roster.shutdown({ logout: true });
await stub.stop();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
