/**
 * A sandbox that hosts a program, against the real confined child and a stub
 * module: load on save, routines by name, what ends with a routine, what a
 * restart brings back, and who is told what.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseSessionSecret } from "../src/module-auth";
import { Scratchpad } from "../src/scratchpad";
import { SandboxHost } from "../src/sandbox/host";
import type { ProgramFact } from "../src/sandbox/program-host";
import { renderActionHints } from "../src/tools";
import { Workspace } from "../src/workspace";
import { startStubModule, STUB_PORT_SECRET, type StubModule } from "./fixtures/stub-module";

const dirs: string[] = [];
const hosts: SandboxHost[] = [];
const stubs: StubModule[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  await Promise.all(stubs.splice(0).map((s) => s.stop()));
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  host: SandboxHost;
  stub: StubModule;
  dir: string;
  facts: ProgramFact[];
  /** A second host over the same directory and session: the process that resumes the run. */
  again(): Promise<Rig>;
}

async function rig(o: { dir?: string; token?: string; secret?: string; stub?: StubModule; timeoutMs?: number; beatMs?: number; beatGraceMs?: number } = {}): Promise<Rig> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-"));
  if (o.dir === undefined) dirs.push(dir);
  const stub = o.stub ?? startStubModule();
  if (o.stub === undefined) stubs.push(stub);
  const token = o.token ?? "program-token-0001";
  let secret = o.secret;
  if (secret === undefined) {
    const lease = await leaseSessionSecret({ moduleUrl: stub.baseUrl, token, account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET } });
    if (lease.secret === undefined) throw new Error(`lease: ${JSON.stringify(lease)}`);
    secret = lease.secret;
  }
  const facts: ProgramFact[] = [];
  const host = new SandboxHost({
    moduleUrl: stub.baseUrl,
    token,
    secret,
    account: "RUNNER",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: o.timeoutMs ?? 5_000,
    pingGraceMs: 1_000,
    logSink: () => {},
    program: { workspace: new Workspace(join(dir, "program")), onFact: (f) => facts.push(f), beatMs: o.beatMs ?? 200, ...(o.beatGraceMs !== undefined ? { beatGraceMs: o.beatGraceMs } : {}) },
  });
  hosts.push(host);
  return { host, stub, dir, facts, again: () => rig({ ...o, dir, token, secret, stub }) };
}

/** Wait until `test` holds, or fail saying what was being waited for. */
async function until(what: string, test: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const LOGIN = 'await connect(); return (await sdk.createSession({ character: "Thalvorn", race: 1, class: 2 })).character;';


/** A routine that reports through memory and waits to be stopped. */
const IDLE = `export async function idle(args) {
  memory.started = (memory.started ?? 0) + 1;
  memory.args = args ?? null;
  while (!signal.aborted) await sleep(50, { wake: false });
}
`;

describe("load on save", () => {
  test("a save of main.ts loads it and names its routines; a file outside its graph loads nothing", async () => {
    const { host, facts } = await rig();
    const p = host.program!;
    const libSrc = "export const reach = 5;\n";
    expect(await p.writeFile("lib/combat.ts", libSrc)).toEqual({ ok: true, text: `created lib/combat.ts (${libSrc.length} chars)` });
    const mainSrc = 'import { reach } from "./lib/combat";\nexport async function grind() { return reach; }\nexport async function trip() {}\nexport const notARoutine = 1;\n';
    const main = await p.writeFile("main.ts", mainSrc);
    expect(main).toEqual({ ok: true, text: `created main.ts (${mainSrc.length} chars)\nloaded: deploy 2 · routines: grind, trip` });
    expect(p.deploy).toBe(2);
    // Code outside main.ts's graph, and a text file, are saved and load nothing.
    expect((await p.writeFile("scratch.ts", "export const x = 1;\n")).text).toBe("created scratch.ts (20 chars)");
    expect((await p.writeFile("plan.txt", "walk north\n")).text).toBe("created plan.txt (11 chars)");
    expect(p.deploy).toBe(2);
    expect(facts.filter((f) => f.kind === "loaded").length).toBe(1);
    // A file main.ts imports is the program: saving it loads again.
    const lib2 = await p.editFile("lib/combat.ts", "5", "8", false);
    expect(lib2.text).toBe("edited lib/combat.ts (1 replacement) (24 chars)\nloaded: deploy 4 · routines: grind, trip");
  }, 30_000);

  test("a load that fails changes nothing: the error names the file and line, and the code already running keeps running", async () => {
    const { host, facts } = await rig();
    const p = host.program!;
    await p.writeFile("main.ts", IDLE);
    expect((await p.startRoutine({ name: "idle" })).ok).toBe(true);
    const broken = await p.writeFile("main.ts", "export async function idle() {\n  const x = ;\n}\n");
    expect(broken.ok).toBe(false);
    expect(broken.text).toContain("load failed, deploy 1 keeps running: ");
    expect(broken.text).toContain("main.ts:2:13");
    expect(broken.text).not.toContain("/deploys/");
    expect(p.deploy).toBe(1);
    expect(p.routines()[0]).toMatchObject({ name: "idle", state: "running", deploy: 1 });
    // An import of a file not written yet is the same kind of failure.
    const missing = await p.writeFile("main.ts", 'import { a } from "./lib/nowhere";\nexport async function idle() { return a; }\n');
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("load failed, deploy 1 keeps running: ");
    expect(missing.text).toContain("lib/nowhere");
    // Deleting main.ts is a load that fails, like any other.
    const gone = await p.deleteFile("main.ts");
    expect(gone).toEqual({ ok: false, text: "deleted main.ts\nload failed, deploy 1 keeps running: main.ts is not in the workspace" });
    expect((await host.evalSnippet("memory.started")).value).toBe("1");
    expect(facts.filter((f) => f.kind === "load_failed").length).toBe(3);
  }, 30_000);

  test("a save restarts the running routines from the top with their arguments, and stops one whose export is gone", async () => {
    const { host } = await rig();
    const p = host.program!;
    await p.writeFile("main.ts", `${IDLE}export async function other() { while (!signal.aborted) await sleep(50, { wake: false }); }\n`);
    await p.startRoutine({ name: "idle", args: { zone: "north" } });
    await p.startRoutine({ name: "other" });
    await until("the first run", async () => (await host.evalSnippet("memory.started")).value === "1");
    const saved = await p.writeFile("main.ts", `${IDLE}// changed\n`);
    expect(saved.text).toEndWith("loaded: deploy 2 · routines: idle · restarted from the top: idle · stopped, no longer exported: other");
    await until("the restarted run", async () => (await host.evalSnippet("memory.started")).value === "2");
    expect((await host.evalSnippet("memory.args.zone")).value).toBe('"north"');
    const rows = p.routines();
    expect(rows.find((r) => r.name === "idle")).toMatchObject({ state: "running", deploy: 2, args: { zone: "north" } });
    expect(rows.find((r) => r.name === "other")).toMatchObject({ state: "stopped", note: "main.ts no longer exports it" });
    // The same text saved again is no change, and restarts nothing.
    expect((await p.writeFile("main.ts", `${IDLE}// changed\n`)).text).toBe(`wrote main.ts (${IDLE.length + 11} chars)`);
    await Bun.sleep(400);
    expect((await host.evalSnippet("memory.started")).value).toBe("2");
  }, 30_000);
});

describe("routines", () => {
  test("a throw on line 9 of main.ts reads main.ts:9", async () => {
    const { host, facts } = await rig();
    const p = host.program!;
    const src = [
      "interface Target { guid: string }", // 1
      "", // 2
      "function pick(targets: Target[]): Target | undefined {", // 3
      "  return targets[0];", // 4
      "}", // 5
      "", // 6
      "export async function grind(): Promise<string> {", // 7
      "  await sleep(10, { wake: false });", // 8
      "  return pick([])!.guid;", // 9
      "}", // 10
      "",
    ].join("\n");
    expect((await p.writeFile("main.ts", src)).ok).toBe(true);
    expect((await p.startRoutine({ name: "grind" })).ok).toBe(true);
    await until("the throw", () => facts.some((f) => f.kind === "ended"));
    const ended = facts.find((f) => f.kind === "ended")!;
    if (ended.kind !== "ended") throw new Error("unreachable");
    expect(ended.fresh).toBe(true);
    expect(ended.routine.state).toBe("threw");
    expect(ended.routine.error!.name).toBe("TypeError");
    expect(ended.routine.error!.frames[0]).toMatch(/^at grind \(main\.ts:9:\d+\)$/);
    expect(ended.routine.error!.signature).toBe("grind|TypeError|main.ts:9");
    expect(p.routineLines()).toMatch(/^routines:\ngrind threw \d+s ago: TypeError: .* at grind \(main\.ts:9:\d+\)$/);
    // The harness never refuses to start one that threw: the same throw again is a repeat, not a fresh signature.
    expect((await p.startRoutine({ name: "grind" })).ok).toBe(true);
    await until("the second throw", () => facts.filter((f) => f.kind === "ended").length === 2);
    const second = facts.filter((f) => f.kind === "ended")[1]!;
    expect(second.kind === "ended" && second.fresh).toBeUndefined();
    await p.beat();
    expect(p.drainFacts().repeats).toEqual([{ signature: "grind|TypeError|main.ts:9", count: 1, ts: expect.any(Number) }]);
  }, 30_000);

  test("a start says what is wrong: no main.ts, no such export, already running and since when", async () => {
    const { host } = await rig();
    const p = host.program!;
    const none = await p.startRoutine({ name: "idle" });
    expect(none).toEqual({ ok: false, text: "there is no main.ts yet: write it with write_file and export an async function from it\nroutines: none started" });
    await p.writeFile("main.ts", IDLE);
    const unknown = await p.startRoutine({ name: "grind" });
    expect(unknown.text).toBe("main.ts exports no function named grind. Its routines: idle.\nroutines: none started");
    const started = await p.startRoutine({ name: "idle" });
    expect(started.text).toMatch(/^started idle on deploy 1\nroutines:\nidle running 0s, deploy 1, no action yet$/);
    const twice = await p.startRoutine({ name: "idle" });
    expect(twice.ok).toBe(false);
    expect(twice.text).toMatch(/^idle is already running: started \d+s ago on deploy 1\. Stop it first with stop_routine to start it again\.\nroutines:\nidle running/);
    expect((await p.stopRoutine({ name: "idle" })).text).toMatch(/^stopped idle\nroutines:\nidle stopped 0s ago$/);
    expect((await p.stopRoutine({ name: "idle" })).text).toMatch(/^idle is not running \(it stopped \d+s ago\)\. No routine is running\.\n/);
  }, 30_000);

  test("stopping a routine aborts its signal and takes back the timers and listeners it started", async () => {
    const { host, stub } = await rig();
    const p = host.program!;
    expect((await host.evalSnippet(LOGIN)).value).toBe('"Thalvorn"');
    await p.writeFile(
      "main.ts",
      `export async function watch() {
  memory.ticks = 0; memory.heard = 0;
  setInterval(() => { memory.ticks++; }, 20);
  events.on("SMSG_TEST_PING", () => { memory.heard++; });
  try { await sleep(60000, { wake: false }); } catch (e) { memory.rejected = String(e && e.name); throw e; }
}
`,
    );
    await p.startRoutine({ name: "watch" });
    stub.push("program-token-0001", { opcode: "SMSG_TEST_PING", data: {} });
    await until("the routine to tick and hear", async () => (await host.evalSnippet("memory.ticks > 2 && memory.heard === 1")).value === "true");
    expect((await p.stopRoutine({ name: "watch" })).ok).toBe(true);
    await until("the pending sleep to reject", async () => (await host.evalSnippet("memory.rejected")).value === '"RoutineStopped"');
    const ticks = (await host.evalSnippet("memory.ticks")).value;
    stub.push("program-token-0001", { opcode: "SMSG_TEST_PING", data: {} });
    await Bun.sleep(300);
    expect((await host.evalSnippet("memory.ticks")).value).toBe(ticks);
    expect((await host.evalSnippet("memory.heard")).value).toBe("1");
    expect(p.routines()[0]).toMatchObject({ name: "watch", state: "stopped" });
  }, 30_000);

  test("a stopped routine that swallows every error neither acts nor spins", async () => {
    const { host, stub } = await rig();
    const p = host.program!;
    await host.evalSnippet(LOGIN);
    await p.writeFile(
      "main.ts",
      `export async function stubborn() {
  for (;;) {
    try { await sdk.attackStop(); await sleep(20, { wake: false }); } catch (e) { memory.swallowed = (memory.swallowed ?? 0) + 1; }
  }
}
`,
    );
    const actions = (): number => stub.calls.filter((c) => c.path === "/action").length;
    await p.startRoutine({ name: "stubborn" });
    await until("the routine to act", () => actions() > 3);
    await p.stopRoutine({ name: "stubborn" });
    await Bun.sleep(400);
    const after = actions();
    await Bun.sleep(600);
    expect(actions()).toBe(after);
    // Still answering, and the loop turns a few times a second at most.
    const n1 = Number((await host.evalSnippet("memory.swallowed")).value);
    await Bun.sleep(500);
    const n2 = Number((await host.evalSnippet("memory.swallowed")).value);
    expect(n2 - n1).toBeLessThan(12);
    expect(host.totalRestarts).toBe(0);
  }, 30_000);

  test("a routine that returns ends with its value; wake(reason) and its console are facts, not a snippet's output", async () => {
    const { host, facts } = await rig();
    const p = host.program!;
    await p.writeFile(
      "main.ts",
      `export async function trip(args) {
  console.log("leaving for", args.to);
  console.log("step"); console.log("step"); console.log("step");
  wake("bags full");
  return { arrived: args.to };
}
`,
    );
    await p.startRoutine({ name: "trip", args: { to: "Goldshire" } });
    await until("the return", () => facts.some((f) => f.kind === "ended"));
    expect(facts.find((f) => f.kind === "wake")).toMatchObject({ kind: "wake", reason: "bags full", routine: "trip" });
    const ended = facts.find((f) => f.kind === "ended");
    expect(ended).toMatchObject({ kind: "ended", routine: { name: "trip", state: "returned", value: '{\n  arrived: "Goldshire",\n}', args: { to: "Goldshire" } } });
    const snippet = await host.evalSnippet("1 + 1");
    expect(snippet.logs).toEqual([]);
    await p.beat();
    const drained = p.drainFacts();
    expect(drained.console.total).toBe(4);
    expect(drained.console.lines.map((l) => [l.routine, l.text, l.count])).toEqual([
      ["trip", "leaving for Goldshire", 1],
      ["trip", "step", 3],
    ]);
    expect(drained.routines[0]).toMatchObject({ name: "trip", state: "returned" });
    expect(p.drainFacts().facts).toEqual([]);
  }, 30_000);
});

describe("snippets beside a program", () => {
  test("a snippet keeps no bindings, leaves nothing running, and imports the files as they stand", async () => {
    const { host } = await rig();
    const p = host.program!;
    expect((await host.evalSnippet("const kept = 41; kept + 1")).ok).toBe(true);
    expect((await host.evalSnippet("typeof kept")).value).toBe('"undefined"');
    expect((await host.evalSnippet("memory.n = 0; setInterval(() => { memory.n++; }, 10); return 'armed';")).value).toBe('"armed"');
    const n = (await host.evalSnippet("memory.n")).value;
    await Bun.sleep(200);
    expect((await host.evalSnippet("memory.n")).value).toBe(n);
    // No version yet: an import says so.
    const early = await host.evalSnippet('import { reach } from "./lib/combat";\nreach');
    expect(early.ok).toBe(false);
    expect(early.error).toContain('import "./lib/combat": there are no workspace files to import yet');
    await p.writeFile("lib/combat.ts", "export const reach = 5;\nexport function double(n: number): number { return n * 2; }\n");
    expect((await host.evalSnippet('import { reach, double } from "./lib/combat";\ndouble(reach)')).value).toBe("10");
    await p.editFile("lib/combat.ts", "5", "8", false);
    expect((await host.evalSnippet('import { reach } from "./lib/combat";\nreach')).value).toBe("8");
    expect((await host.evalSnippet('(await import("./lib/combat")).reach')).value).toBe("8");
    const missing = await host.evalSnippet('import { nope } from "./lib/combat";\nnope');
    expect(missing.error).toContain('lib/combat.ts has no export named "nope"');
    // An error in a workspace file names it by its workspace path.
    await p.writeFile("lib/bad.ts", "export function boom(): never {\n  throw new Error('no');\n}\n");
    const thrown = await host.evalSnippet('import { boom } from "./lib/bad";\ntry { boom(); } catch (e) { return String(e.stack).split("\\n")[1].trim(); }');
    expect(thrown.value).toMatch(/^"at boom \(.*\/deploys\/\d+\/lib\/bad\.ts:2:\d+\)"$/);
  }, 30_000);

  test("memory is saved as the code runs, shown by read_file, refused to the file tools, and loaded again by a new sandbox", async () => {
    const r = await rig();
    const p = r.host.program!;
    expect((await r.host.evalSnippet('memory.phase = "grind"; memory.kills = 3; Object.keys(memory)')).ok).toBe(true);
    await until("memory.json", () => existsSync(join(r.dir, "program", "files", "memory.json")));
    expect(p.readFile("memory.json")).toEqual({ ok: true, text: '{"phase":"grind","kills":3}' });
    expect((await p.writeFile("memory.json", "{}")).text).toContain("memory.json is saved by the harness from `memory`");
    expect((await p.deleteFile("memory.json")).ok).toBe(false);
    const big = await r.host.evalSnippet('memory.blob = "x".repeat(40000); 1');
    expect(big.ok).toBe(true);
    await until("the refusal", () => r.facts.some((f) => f.kind === "error"));
    expect(r.facts.find((f) => f.kind === "error")).toMatchObject({ error: { name: "MemoryError", signature: "memory|over_limit" } });
    expect(readFileSync(join(r.dir, "program", "files", "memory.json"), "utf8")).toBe('{"phase":"grind","kills":3}');
    await r.host.stop();
    const next = await r.again();
    expect((await next.host.evalSnippet("memory.phase + memory.kills")).value).toBe('"grind3"');
  }, 30_000);
});
