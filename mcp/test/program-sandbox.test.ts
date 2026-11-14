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
import { programAbandonNote, programWalkText, SandboxHost, SDK_MOVE_ABANDON_ADVICE, SDK_WALK_BUDGET_ADVICE } from "../src/sandbox/host";
import type { ProgramFact } from "../src/sandbox/program-host";
import { CharacterRoster } from "../src/fanout";
import { SecretRedactor } from "../src/redact";
import { coreTools, programTools, renderActionHints, ToolSet, type CoreToolRender, type ProgramToolContext } from "../src/tools";
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
    expect(saved.text).toEndWith("loaded: deploy 2 · routines: idle · restarts from the top 1s after the last load: idle · stopped, no longer exported: other");
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
    // A stop of a routine that has ended is a plain answer, not a failure: how and when it ended.
    expect(await p.stopRoutine({ name: "idle" })).toEqual({ ok: true, text: "idle had already ended: it was stopped 0s ago.\nroutines:\nidle stopped 0s ago" });
    // A name that never ran is still refused.
    expect(await p.stopRoutine({ name: "grind" })).toEqual({ ok: false, text: "grind is not running. No routine is running.\nroutines:\nidle stopped 0s ago" });
  }, 30_000);

  test("a stop of a routine that ended before a restart is the same plain answer: the new child never ran it", async () => {
    const r = await rig();
    await r.host.program!.writeFile("main.ts", 'export async function trip() { return "done"; }\n');
    await r.host.program!.startRoutine({ name: "trip" });
    await until("trip ended", () => r.host.program!.routines()[0]?.state === "returned");
    await r.host.stop();
    const next = await r.again();
    // A child is running, and it holds no run of trip.
    expect((await next.host.evalSnippet("1 + 1")).value).toBe("2");
    const stopped = await next.host.program!.stopRoutine({ name: "trip" });
    expect(stopped.ok).toBe(true);
    expect(stopped.text).toMatch(/^trip had already ended: it returned \d+s ago\.\nroutines:\ntrip returned \d+s ago: "done"$/);
  }, 30_000);

  test("a routine's returned value and error are shown whole once; later lines refer to them", async () => {
    const { host } = await rig();
    const p = host.program!;
    await p.writeFile("main.ts", 'export async function trip(args) { return args ?? "done"; }\nexport async function fail() { throw new TypeError("no target in view"); }\n');
    await p.startRoutine({ name: "trip" });
    await p.startRoutine({ name: "fail" });
    await until("both ended", () => p.routines().every((r) => r.state !== "running"));
    const first = await p.stopRoutine({ name: "trip" });
    expect(first.ok).toBe(true);
    expect(first.text).toContain('\ntrip returned 0s ago: "done"\n');
    expect(first.text).toMatch(/\nfail threw 0s ago: TypeError: no target in view at fail \(main\.ts:2:\d+\)$/);
    // Shown once: the next result refers to them.
    expect((await p.stopRoutine({ name: "fail" })).text).toBe("fail had already ended: it threw 0s ago.\nroutines:\ntrip returned 0s ago (value shown before)\nfail threw 0s ago: TypeError (shown before)");
    // A new run's value is new, even an equal one; a changed one too.
    await p.startRoutine({ name: "trip", args: "back" });
    await until("trip ended again", () => p.routines().find((r) => r.name === "trip")?.state === "returned");
    expect((await p.stopRoutine({ name: "trip" })).text).toContain('\ntrip returned 0s ago: "back"\n');
    // A harness whose conversation lost them (a compaction, a trim) shows them whole again.
    p.forgetShown();
    expect((await p.stopRoutine({ name: "fail" })).text).toContain("\nfail threw 0s ago: TypeError: no target in view at fail");
    // What a harness renders of its own, it marks.
    expect(p.shownDetails().size).toBe(2);
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
    // Two callers at once share one beat: the second is answered when the first has folded, not before.
    const first = p.beat();
    expect(p.beat()).toBe(first);
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
    // In a workspace file a bare builtin name is the builtin; in a snippet's import it is refused as one.
    const bare = await host.evalSnippet('import { readdirSync } from "fs";\ntypeof readdirSync');
    expect(bare.ok).toBe(false);
    expect(bare.error).toContain('import "fs": fs is a builtin module, not a file in your workspace; in a snippet a bare name imports a workspace file, so import the builtin as "node:fs"');
    expect((await host.evalSnippet('import { readdirSync } from "node:fs";\ntypeof readdirSync')).value).toBe('"function"');
    await p.writeFile("lib/disk.ts", 'import { readdirSync } from "fs";\nexport const kind = typeof readdirSync;\n');
    expect((await host.evalSnippet('import { kind } from "./lib/disk";\nkind')).value).toBe('"function"');
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

/** Answer every `move_to` the stub is sent with a verdict, until stopped. */
function answerMoves(stub: StubModule, token: string, status: string): () => void {
  let answered = 0;
  const timer = setInterval(() => {
    const moves = stub.calls.filter((c) => c.path === "/action" && c.body?.["action"] === "move_to");
    while (answered < moves.length) {
      answered++;
      stub.push(token, { opcode: "WB_MOVE_RESULT", data: { moveId: answered, status, pos: { x: 0, y: 0, z: 0, o: 0 } } });
    }
  }, 10);
  return () => clearInterval(timer);
}

describe("who is told what", () => {
  test("a routine's refusal is a fact once per signature, counted after that, and a tool result's hint line names the routine", async () => {
    const { host, stub, facts } = await rig();
    const p = host.program!;
    await host.evalSnippet(LOGIN);
    const stop = answerMoves(stub, "program-token-0001", "too_far");
    try {
      await p.writeFile(
        "main.ts",
        `export async function walk() {
  for (let i = 0; i < 4; i++) memory.status = (await sdk.moveTo({ x: -1200, y: 990, z: 42 }, { timeout: 4000 })).status;
}
`,
      );
      await p.startRoutine({ name: "walk" });
      await until("the routine to finish", () => facts.some((f) => f.kind === "ended"), 20_000);
      // The failures ride the next tool result, as they do without a program, owned by name.
      const next = await host.evalSnippet("memory.status");
      expect(next.value).toBe('"too_far"');
      const hints = next.actionHints ?? [];
      const refusals = facts.filter((f) => f.kind === "refusal");
      expect(refusals.length).toBe(1);
      expect(refusals[0]).toMatchObject({ routine: "walk", action: "moveTo", status: "too_far", signature: "walk||moveTo|too_far", fresh: true, deploy: 1 });
      await p.beat();
      const drained = p.drainFacts();
      expect(drained.repeats).toEqual([{ signature: "walk||moveTo|too_far", count: 3, ts: expect.any(Number) }]);
      expect(hints.every((h) => h.routine === "walk" && h.from === undefined)).toBe(true);
      const block = renderActionHints(hints)!;
      expect(block.split("\n").length).toBe(2);
      expect(block).toContain("moveTo too_far ×4 (routine walk): ");
      const routine = drained.routines.find((r) => r.name === "walk")!;
      expect(["move_to", "stop"]).toContain(routine.lastAction!.action);
    } finally {
      stop();
    }
  }, 40_000);

  test("a snippet's move that replaces a routine's says so in its own result, and the routine's side is a fact", async () => {
    const { host, facts } = await rig();
    const p = host.program!;
    await host.evalSnippet(LOGIN);
    await p.writeFile(
      "main.ts",
      `export async function walk() {
  memory.walk = (await sdk.moveTo({ x: -1200, y: 990, z: 42 }, { timeout: 20000 })).status;
}
`,
    );
    await p.startRoutine({ name: "walk" });
    await until("the move to be dispatched", async () => (await host.stateSnapshot())["move"] != null);
    const res = await host.evalSnippet("await sdk.moveToAsync({ x: -1230, y: 980, z: 42 }); return 'sent';");
    expect(res.ok).toBe(true);
    expect(res.notes).toEqual(["this replaced the move routine walk had in flight"]);
    const pre = facts.find((f) => f.kind === "preempted");
    expect(pre).toMatchObject({ kind: "preempted", by: { snippet: true }, of: { routine: "walk" }, to: { x: -1230, y: 980, z: 42 } });
    // A snippet with no routine's move under it says nothing.
    await p.stopRoutine({ name: "walk" });
    const again = await host.evalSnippet("await sdk.moveToAsync({ x: -1231, y: 981, z: 42 }); return 'sent';");
    expect(again.notes).toBeUndefined();
  }, 30_000);
});

describe("what a restart brings back", () => {
  test("a new process over the same registry loads the program and starts what was running from the top", async () => {
    const r = await rig();
    await r.host.evalSnippet(LOGIN);
    await r.host.program!.writeFile("main.ts", IDLE);
    await r.host.program!.startRoutine({ name: "idle", args: { zone: "north" } });
    await until("the first run", async () => (await r.host.evalSnippet("memory.started")).value === "1");
    await r.host.stop();
    const registry = JSON.parse(readFileSync(join(r.dir, "program", "registry.json"), "utf8")) as { deploy: number; routines: { name: string; state: string }[] };
    expect(registry.deploy).toBe(1);
    expect(registry.routines).toMatchObject([{ name: "idle", state: "running" }]);

    const next = await r.again();
    await next.host.start();
    const restart = next.facts.find((f) => f.kind === "restart");
    expect(restart).toMatchObject({ kind: "restart", blamed: false, restarted: [{ name: "idle", state: "running", args: { zone: "north" } }], interrupted: [] });
    expect(next.facts.find((f) => f.kind === "loaded")).toMatchObject({ deploy: 1, by: "restart", routines: ["idle"] });
    await until("the run from the top", async () => (await next.host.evalSnippet("memory.started")).value === "2");
    // The stream was reopened for it: the routine reads a whole cache without a connect() of its own.
    expect((await next.host.evalSnippet("state.self.name")).value).toContain("Thalvorn");
  }, 40_000);

  test("a child killed for a blocked loop while no snippet ran is the program's: no routine is restarted, and they are named", async () => {
    const { host, facts } = await rig({ beatMs: 150, beatGraceMs: 700 });
    const p = host.program!;
    await p.writeFile("main.ts", `${IDLE}export async function spin() { await sleep(300, { wake: false }); for (;;) {} }\n`);
    await p.startRoutine({ name: "idle" });
    await p.startRoutine({ name: "spin" });
    await until("the restart", () => facts.some((f) => f.kind === "restart"), 15_000);
    const restart = facts.find((f) => f.kind === "restart")!;
    if (restart.kind !== "restart") throw new Error("unreachable");
    expect(restart.blamed).toBe(true);
    expect(restart.restarted).toEqual([]);
    expect(restart.interrupted.map((r) => [r.name, r.state, r.note])).toEqual([
      ["idle", "interrupted", "the sandbox was restarted for a blocked event loop while no snippet was running"],
      ["spin", "interrupted", "the sandbox was restarted for a blocked event loop while no snippet was running"],
    ]);
    expect(host.totalRestarts).toBe(1);
    const notice = host.drainNotices().find((n) => n.kind === "sandbox_restarted")!;
    expect(notice.text).toStartWith("sandbox restarted (its event loop was blocked while no snippet was running, so a routine blocked it). ");
    expect(notice.text).toContain("when a routine was what blocked the sandbox none is");
    // The program is loaded again, so a routine can be started by name; nothing runs until one is.
    expect(p.deploy).toBe(1);
    await Bun.sleep(400);
    expect((await host.evalSnippet("memory.started")).value).toBe("1");
    expect((await p.startRoutine({ name: "idle" })).ok).toBe(true);
    expect(host.totalRestarts).toBe(1);
  }, 40_000);

  test("a child killed while a snippet was in flight restarts the routines: the snippet may be what blocked it", async () => {
    const { host, facts } = await rig({ timeoutMs: 1_000, beatMs: 150, beatGraceMs: 10_000 });
    const p = host.program!;
    await p.writeFile("main.ts", IDLE);
    await p.startRoutine({ name: "idle" });
    await until("the first run", async () => (await host.evalSnippet("memory.started")).value === "1");
    const blocked = await host.evalSnippet("for (;;) {}");
    expect(blocked.restarted).toBe(true);
    expect(blocked.error).toContain("the routines that were running are started again from the top");
    const restart = facts.find((f) => f.kind === "restart");
    expect(restart).toMatchObject({ kind: "restart", blamed: false, restarted: [{ name: "idle" }], interrupted: [] });
    await until("the run from the top", async () => (await host.evalSnippet("memory.started")).value === "2");
  }, 40_000);
});

describe("fan-out: a routine carries its character", () => {
  test("the same routine runs once per character, each with that character's sdk, and every row and fact names whose it is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-fanout-"));
    dirs.push(dir);
    const stub = startStubModule();
    stubs.push(stub);
    const facts: ProgramFact[] = [];
    const host = new SandboxHost({
      moduleUrl: stub.baseUrl,
      token: "",
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
      fanout: { maxCharacters: 3 },
      logSink: () => {},
      program: { workspace: new Workspace(join(dir, "program")), onFact: (f) => facts.push(f), beatMs: 200 },
    });
    hosts.push(host);
    const roster = new CharacterRoster({
      grant: { maxCharacters: 3, accounts: ["ACCA", "ACCB", "ACCC"] },
      moduleUrl: stub.baseUrl,
      sandbox: host,
      secrets: new SecretRedactor(),
      env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
    });
    expect((await roster.login({ name: "Alpha" })).ok).toBe(true);
    expect((await roster.login({ name: "Bravo" })).ok).toBe(true);
    const p = host.program!;
    await p.writeFile(
      "main.ts",
      `export async function report(args) {
  memory[args.slot] = { self: state.self.name, others: Object.keys(chars).sort().join(",") };
  if (args.fail) throw new Error("as " + state.self.name);
  while (!signal.aborted) await sleep(50, { wake: false });
}
`,
    );
    expect((await p.startRoutine({ name: "report", args: { slot: "a" }, character: "Alpha" })).text).toStartWith("started report (Alpha) on deploy 1\n");
    expect((await p.startRoutine({ name: "report", args: { slot: "b" }, character: "Bravo" })).ok).toBe(true);
    // One run per name and character: the same name again for Alpha is refused, and for nobody known is said.
    expect((await p.startRoutine({ name: "report", character: "Alpha" })).text).toStartWith("report (Alpha) is already running: started ");
    expect((await p.startRoutine({ name: "report", character: "Zulu" })).text).toStartWith("unknown character: Zulu. Logged in: Alpha, Bravo.\n");
    await until("both runs", async () => (await host.evalSnippet("Boolean(memory.a && memory.b)")).value === "true");
    expect((await host.evalSnippet("memory.a.self + '/' + memory.b.self + '/' + memory.a.others")).value).toBe('"Alpha/Bravo/Alpha,Bravo"');
    expect(p.routineLines()).toMatch(/^routines:\nreport \(Alpha\) running \d+s, deploy 1, no action yet\nreport \(Bravo\) running \d+s, deploy 1, no action yet$/);
    // Stopping one leaves the other.
    expect((await p.stopRoutine({ name: "report", character: "Alpha" })).ok).toBe(true);
    expect(p.routines().map((r) => [r.character, r.state])).toEqual([
      ["Alpha", "stopped"],
      ["Bravo", "running"],
    ]);
    // A throw is a fact that names the character, and the two characters' errors are two signatures apart only by routine and place.
    await p.startRoutine({ name: "report", args: { slot: "a", fail: true }, character: "Alpha" });
    await until("the throw", () => facts.some((f) => f.kind === "ended"));
    expect(facts.find((f) => f.kind === "ended")).toMatchObject({ routine: { name: "report", character: "Alpha", state: "threw", error: { text: "Error: as Alpha" } } });
    await roster.shutdown({ logout: true });
  }, 40_000);
});

describe("the program tools", () => {
  const render: CoreToolRender<ProgramToolContext> = { eventLine: (e) => e.opcode, isAmbient: () => false, stateSummary: () => "state" };

  test("are the one-off run_snippet, four file tools and two routine tools, beside a core that is untouched", () => {
    const specs = programTools(render);
    expect(Object.keys(specs)).toEqual(["run_snippet", "read_file", "write_file", "edit_file", "delete_file", "start_routine", "stop_routine"]);
    const core = coreTools(render);
    expect(specs.run_snippet.def.inputSchema).toEqual(core.run_snippet.def.inputSchema);
    expect(specs.run_snippet.def.description).not.toBe(core.run_snippet.def.description);
    expect(specs.run_snippet.def.description).toContain("Nothing a snippet declares or starts outlives it");
    expect(core.run_snippet.def.description).toContain("Top-level bindings persist across snippets");
    expect(Object.keys(specs.start_routine.def.inputSchema["properties"] as object)).toEqual(["name", "args"]);
    expect(Object.keys(specs.edit_file.def.inputSchema["properties"] as object)).toEqual(["path", "old", "new", "replaceAll"]);
    // Above fan-out 1 the routine tools name a character, optionally.
    const many = programTools(render, { characters: true });
    expect(Object.keys(many.start_routine.def.inputSchema["properties"] as object)).toEqual(["name", "args", "character"]);
    expect(Object.keys(many.stop_routine.def.inputSchema["properties"] as object)).toEqual(["name", "character"]);
    expect(many.start_routine.def.inputSchema["required"]).toEqual(["name"]);
  });

  test("drive a real program end to end: write, load, start, a snippet that pre-empts, stop", async () => {
    const { host } = await rig();
    const specs = programTools(render);
    const tools = new ToolSet<ProgramToolContext>([specs.run_snippet, specs.read_file, specs.write_file, specs.edit_file, specs.delete_file, specs.start_routine, specs.stop_routine]);
    const ctx: ProgramToolContext = { sandbox: host, scratchpad: new Scratchpad(join(mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-pad-")), "pad.md")), sessionLive: () => true, turn: () => 3, secrets: new SecretRedactor(), program: host.program! };
    const call = (name: string, args: unknown): Promise<{ text: string; isError?: boolean }> => tools.call(ctx, name, args);

    expect((await call("run_snippet", { code: LOGIN })).text).toContain('=> "Thalvorn"');
    const src = `export async function walk(args) {\n  memory.walk = (await sdk.moveTo(args.to, { timeout: 20000 })).status;\n}\n`;
    const wrote = await call("write_file", { path: "main.ts", content: src });
    expect(wrote).toEqual({ text: `created main.ts (${src.length} chars)\nloaded: deploy 1 · routines: walk` });
    expect((await call("read_file", { path: "main.ts" })).text).toBe(src);
    expect(await call("read_file", { path: "lib/none.ts" })).toEqual({ text: "no such file in the workspace: lib/none.ts. Files: main.ts.", isError: true });
    // The alias keys an editing model reaches for are the canonical ones.
    const edited = await call("edit_file", { file_path: "main.ts", old_string: "20000", new_string: "25000" });
    expect(edited.text).toBe(`edited main.ts (1 replacement) (${src.length} chars)\nloaded: deploy 2 · routines: walk`);
    const twice = await call("edit_file", { path: "main.ts", old: "a", new: "b" });
    expect(twice.isError).toBe(true);
    expect(twice.text).toMatch(/^old matches \d+ places in main\.ts, at lines /);
    const broken = await call("write_file", { path: "main.ts", content: "export async function walk( {" });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("load failed, deploy 2 keeps running: ");
    await call("write_file", { path: "main.ts", content: src });

    const started = await call("start_routine", { name: "walk", args: { to: { x: -1200, y: 990, z: 42 } } });
    expect(started.text).toMatch(/^started walk on deploy 4\nroutines:\nwalk running 0s, deploy 4, /);
    const again = await call("start_routine", { routine: "walk" });
    expect(again.isError).toBe(true);
    expect(again.text).toStartWith("walk is already running: started ");
    await until("the move to be dispatched", async () => (await host.stateSnapshot())["move"] != null);
    const snippet = await call("run_snippet", { code: "await sdk.moveToAsync({ x: -1230, y: 980, z: 42 }); return 'sent';" });
    expect(snippet.text).toContain('=> "sent"\nthis replaced the move routine walk had in flight');
    const stopped = await call("stop_routine", { name: "walk" });
    expect(stopped.text).toMatch(/^stopped walk\nroutines:\nwalk stopped 0s ago$/);
    // Stopping it again is a plain answer, not a tool error.
    expect(await call("stop_routine", { name: "walk" })).toEqual({ text: "walk had already ended: it was stopped 0s ago.\nroutines:\nwalk stopped 0s ago" });
    expect((await call("start_routine", {})).text).toStartWith("invalid arguments for start_routine: ");
  }, 40_000);
});

describe("an abandoned walk's note with a program", () => {
  test("drops the SDK's background-routine advice and keeps the distances", () => {
    const note = `a moveTo was still walking when this was abandoned: ~15y covered, ~220y still to go.${SDK_MOVE_ABANDON_ADVICE}`;
    expect(programAbandonNote(note)).toBe("a moveTo was still walking when this was abandoned: ~15y covered, ~220y still to go.");
    expect(programAbandonNote(note)).not.toContain("background routine");
    // A note of another kind (an abandoned sleep or wait) is left as it is.
    expect(programAbandonNote("sleep(30000) could not finish in the 12s the snippet had left.")).toBe("sleep(30000) could not finish in the 12s the snippet had left.");
  });
});

describe("saves, starts and what a result carries", () => {
  const render: CoreToolRender<ProgramToolContext> = { eventLine: (e) => e.opcode, isAmbient: () => false, stateSummary: () => "state" };

  test("only an async export is a routine; a sync one is named as not being one", async () => {
    const { host } = await rig();
    const p = host.program!;
    const src = "export async function grind() {}\nexport const trip = async () => {};\nexport function selfPos() { return 1; }\n";
    expect((await p.writeFile("main.ts", src)).text).toEndWith("loaded: deploy 1 · routines: grind, trip");
    const sync = await p.startRoutine({ name: "selfPos" });
    expect(sync).toEqual({ ok: false, text: "main.ts exports selfPos, but it is not an async function, so it is not a routine. Its routines: grind, trip.\nroutines: none started" });
    expect((await p.writeFile("main.ts", "export function helper() {}\n")).text).toEndWith("loaded: deploy 2 · main.ts exports no async function, so it has no routine");
  }, 30_000);

  test("a routine re-exported from another file, as the prompt's example writes it, is a routine, and a save of that file restarts it", async () => {
    const { host } = await rig();
    const p = host.program!;
    await p.writeFile("lib/patrol.ts", IDLE.replace("export async function idle", "export async function patrol"));
    expect((await p.writeFile("main.ts", 'export { patrol } from "./lib/patrol";\n')).text).toEndWith("loaded: deploy 2 · routines: patrol");
    expect((await p.startRoutine({ name: "patrol" })).ok).toBe(true);
    const edited = await p.editFile("lib/patrol.ts", "?? null", "?? null ", false);
    expect(edited.text).toEndWith("loaded: deploy 3 · routines: patrol · restarts from the top 1s after the last load: patrol");
  }, 30_000);

  test("a start after the save that restarted the routine is that run, said plainly; with other arguments it is refused truthfully", async () => {
    // write_file then start_routine in one batch, the save restarting the running routine.
    const { host } = await rig();
    const p = host.program!;
    await p.writeFile("main.ts", IDLE);
    await p.startRoutine({ name: "idle", args: { zone: "north" } });
    expect((await p.editFile("main.ts", "?? 0) + 1", "?? 0) + 1 ", false)).text).toEndWith("restarts from the top 1s after the last load: idle");
    const same = await p.startRoutine({ name: "idle", args: { zone: "north" } });
    expect(same.ok).toBe(true);
    expect(same.text).toMatch(/^idle is running: your save restarted it from the top on deploy 2, 0s ago, with these arguments\nroutines:\nidle running/);
    const other = await p.startRoutine({ name: "idle", args: { zone: "south" } });
    expect(other.ok).toBe(false);
    expect(other.text).toMatch(/^idle is already running: your save restarted it from the top \d+s ago on deploy 2, with the arguments it had\. Stop it first with stop_routine to start it with these\./);
    // A run started by start_routine is refused as before.
    await p.stopRoutine({ name: "idle" });
    await p.startRoutine({ name: "idle" });
    expect((await p.startRoutine({ name: "idle" })).text).toMatch(/^idle is already running: started \d+s ago on deploy 2\. Stop it first/);
  }, 30_000);

  test("two saves sent together restart a running routine once", async () => {
    // Two edit_file calls 7 ms apart once gave two loads and two restarts, interrupting a cast.
    const { host } = await rig();
    const p = host.program!;
    await p.writeFile("main.ts", IDLE);
    await p.startRoutine({ name: "idle" });
    await until("the first start", async () => (await host.evalSnippet("memory.started")).value === "1");
    const a = await p.editFile("main.ts", "?? 0) + 1", "?? 0) + 1 ", false);
    const b = await p.editFile("main.ts", "?? null", "?? null ", false);
    expect(a.text).toEndWith("restarts from the top 1s after the last load: idle");
    expect(b.text).toEndWith("restarts from the top 1s after the last load: idle");
    await until("the restart", async () => (await host.evalSnippet("memory.started")).value === "2");
    await Bun.sleep(1_500);
    // The first save's restart never ran: the second replaced it inside the settle window.
    expect((await host.evalSnippet("memory.started")).value).toBe("2");
    expect(p.routines().find((r) => r.name === "idle")).toMatchObject({ state: "running", deploy: 3 });
  }, 30_000);

  test("read_file returns a range of lines under a line saying which, and refuses one past the end", async () => {
    const { host } = await rig();
    const specs = programTools(render);
    const tools = new ToolSet<ProgramToolContext>([specs.read_file, specs.write_file]);
    const ctx: ProgramToolContext = { sandbox: host, scratchpad: new Scratchpad(join(mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-pad-")), "pad.md")), sessionLive: () => true, turn: () => 1, secrets: new SecretRedactor(), program: host.program! };
    const src = Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
    await tools.call(ctx, "write_file", { path: "notes.txt", content: src });
    expect((await tools.call(ctx, "read_file", { path: "notes.txt" })).text).toBe(src);
    expect((await tools.call(ctx, "read_file", { path: "notes.txt", offset: 4, limit: 2 })).text).toBe("notes.txt, lines 4-5 of 10:\n// line 4\n// line 5");
    expect((await tools.call(ctx, "read_file", { path: "notes.txt", offset: "9" })).text).toBe("notes.txt, lines 9-10 of 10:\n// line 9\n// line 10");
    expect((await tools.call(ctx, "read_file", { path: "notes.txt", limit: 1 })).text).toBe("notes.txt, lines 1-1 of 10:\n// line 1");
    expect(await tools.call(ctx, "read_file", { path: "notes.txt", offset: 11 })).toEqual({ text: "notes.txt has 10 lines; offset 11 is past its end", isError: true });
    expect(specs.read_file.def.description).toContain("offset and limit, both optional, return part of it instead");
    expect(Object.keys(specs.read_file.def.inputSchema["properties"] as object)).toEqual(["path", "offset", "limit"]);
  }, 30_000);

  test("a snippet's read of a workspace file off the sandbox's disk says where the file is read instead", async () => {
    const { host } = await rig();
    await host.program!.writeFile("main.ts", IDLE);
    for (const code of ['return await Bun.file("main.ts").text()', 'const fs = await import("node:fs"); return fs.readFileSync("/workspace/main.ts", "utf8")']) {
      const res = await host.evalSnippet(code);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ENOENT");
      expect(res.error).toEndWith(' — main.ts is one of your workspace files, which are not on the sandbox\'s disk: read_file({ path: "main.ts" }) returns it, and a snippet imports its exports by relative path.');
    }
    // A missing file that is not the workspace's gets no such line.
    const other = await host.evalSnippet('return await Bun.file("nope.ts").text()');
    expect(other.error).toContain("ENOENT");
    expect(other.error).not.toContain("read_file");
  }, 30_000);

  test("a walk's budget note keeps its facts and loses the SDK's background-routine advice", () => {
    // The note exactly as sdk/test/walk-budget.test.ts pins walkBudgetNote's text.
    const note =
      "this move's route is ~660y (~165y in a straight line) — about 94s at a base run speed of 7yd/s, and the " +
      "caller had ~30s of its budget left when it was issued. Awaiting a move this long does not fit one snippet: " +
      "dispatch it with sdk.moveToAsync(target) or from a background routine, then poll state.self.position.";
    expect(note).toEndWith(`Awaiting a move this long does not fit one snippet${SDK_WALK_BUDGET_ADVICE}`);
    const cut = programWalkText(`=> { status: "arrived", note: "${note}" }`);
    expect(cut).not.toContain("background routine");
    expect(cut).toContain("Awaiting a move this long does not fit one snippet.");
    expect(cut).toContain("this move's route is ~660y");
  });

  test("the hints a result carries are handed to onHintsDelivered: a snippet's own and those drained onto another tool's", async () => {
    const { host, stub, facts } = await rig();
    const specs = programTools(render);
    const tools = new ToolSet<ProgramToolContext>([specs.run_snippet, specs.read_file]);
    const delivered: { action: string; status: string; routine?: string }[][] = [];
    const ctx: ProgramToolContext = {
      sandbox: host,
      scratchpad: new Scratchpad(join(mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-pad-")), "pad.md")),
      sessionLive: () => true,
      turn: () => 1,
      secrets: new SecretRedactor(),
      program: host.program!,
      onHintsDelivered: (h) => delivered.push(h.map((x) => ({ action: x.action, status: x.status, ...(x.routine !== undefined ? { routine: x.routine } : {}) }))),
    };
    await tools.call(ctx, "run_snippet", { code: LOGIN });
    expect(delivered).toEqual([]);
    const stop = answerMoves(stub, "program-token-0001", "too_far");
    try {
      // A routine's refusal rides the next result whatever tool it is, its owner named.
      await host.program!.writeFile("main.ts", "export async function far() { await sdk.moveTo({ x: -1200, y: 990, z: 42 }, { timeout: 4000 }); }\n");
      await host.program!.startRoutine({ name: "far" });
      await until("the routine to end", () => facts.some((f) => f.kind === "ended"), 20_000);
      await tools.call(ctx, "read_file", { path: "main.ts" });
      expect(delivered).toEqual([[{ action: "moveTo", status: "too_far", routine: "far" }]]);
      delivered.length = 0;
      // A snippet's own rides its own result.
      const own = await tools.call(ctx, "run_snippet", { code: "return (await sdk.moveTo({ x: -1200, y: 990, z: 42 }, { timeout: 4000 })).status" });
      expect(own.text).toContain("too_far");
      expect(delivered).toEqual([[{ action: "moveTo", status: "too_far" }]]);
    } finally {
      stop();
    }
  }, 30_000);
});
