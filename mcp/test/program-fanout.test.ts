/**
 * A program at fan-out above 1: one client's one workspace and one program,
 * with routines per character, served through the fan-out tools and the
 * program tools together, against the real confined child and a stub module.
 * What the tools say, what each character's record says made each dispatch,
 * and what becomes of a character's routines when it is logged out.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterRoster, fanoutTools, PLAIN_FANOUT_RENDER, PROGRAM_FANOUT_RUN_SNIPPET_SENTENCE, type FanoutToolContext } from "../src/fanout";
import { PLAIN_RENDER } from "../src/main";
import { tokenFingerprint } from "../src/module-auth";
import type { CallRow } from "../src/record/format";
import { SessionReader } from "../src/record/reader";
import { SessionStore } from "../src/record/store";
import { validateSession } from "../src/record/validate";
import { SessionWriter } from "../src/record/writer";
import { SecretRedactor } from "../src/redact";
import { SandboxHost } from "../src/sandbox/host";
import type { ProgramFact } from "../src/sandbox/program-host";
import { Scratchpad } from "../src/scratchpad";
import { PROGRAM_RUN_SNIPPET_DESCRIPTION, programTools, ToolSet, type CoreToolRender, type ProgramToolContext, type ToolSpec } from "../src/tools";
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

type Ctx = FanoutToolContext & ProgramToolContext;

/** The child's `NO_CHARACTER_SELECTED_ROUTINE`, as the model reads it: the child is not imported here, since loading it arms the sandbox's guards in this process. */
const NO_CHARACTER_SELECTED_ROUTINE =
  "no character selected: this routine was started without `character`. Pass `character` to start_routine, or use chars[name].sdk, chars[name].state and chars[name].events.";

/** The tools a harness serves a program at fan-out: the program's file and routine tools, and the fan-out tools with the program's one-off `run_snippet`. */
function surface(): Record<string, ToolSpec<Ctx>> {
  const render = PLAIN_RENDER as CoreToolRender<Ctx>;
  const fan = fanoutTools<Ctx>(render, PLAIN_FANOUT_RENDER, { program: true });
  const prog = programTools<Ctx>(render, { characters: true });
  return {
    run_snippet: fan.run_snippet,
    read_file: prog.read_file,
    write_file: prog.write_file,
    edit_file: prog.edit_file,
    delete_file: prog.delete_file,
    start_routine: prog.start_routine,
    stop_routine: prog.stop_routine,
    recent_events: fan.recent_events,
    state_summary: fan.state_summary,
    write_scratchpad: fan.write_scratchpad,
    edit_scratchpad: fan.edit_scratchpad,
    login_character: fan.login_character,
    logout_character: fan.logout_character,
    list_characters: fan.list_characters,
  };
}

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function rig() {
  const root = mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-fanout-"));
  dirs.push(root);
  const stub = startStubModule();
  stubs.push(stub);
  const facts: ProgramFact[] = [];
  const scratchpad = new Scratchpad(join(root, "scratchpad.md"));
  const host = new SandboxHost({
    moduleUrl: stub.baseUrl,
    token: "",
    scratchpad,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    fanout: { maxCharacters: 3 },
    record: { tickMs: 3_600_000 },
    logSink: () => {},
    program: { workspace: new Workspace(join(root, "program")), onFact: (f) => facts.push(f), beatMs: 200 },
  });
  hosts.push(host);
  const store = new SessionStore(join(root, "sessions"));
  const secrets = new SecretRedactor();
  const roster: CharacterRoster = new CharacterRoster({
    grant: { maxCharacters: 3, accounts: ["ACCA", "ACCB", "ACCC"] },
    moduleUrl: stub.baseUrl,
    sandbox: host,
    secrets,
    env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
    record: (seat) => {
      const id = tokenFingerprint(seat.token);
      const w = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: "0.0.0-test" }, token: seat.token, scrub: (text) => roster.scrubTokens(text), log: () => {} });
      w.open();
      return w;
    },
  });
  const ctx: Ctx = { sandbox: host, scratchpad, sessionLive: () => true, turn: () => 0, secrets, fanout: roster, record: roster.calls, program: host.program! };
  const tools = new ToolSet<Ctx>(Object.values(surface()));
  const rows = (name: string): CallRow[] => {
    const s = store.list().find((x) => x.session.character?.name === name);
    return s === undefined ? [] : (new SessionReader(s.dir).rows("calls") as CallRow[]).filter((x) => x.kind !== "key");
  };
  return { host, roster, store, facts, call: (name: string, args: unknown) => tools.call(ctx, name, args), rows };
}

describe("the tools a program is served at fan-out", () => {
  test("run_snippet is the program's one-off with a character, and the routine tools take one", () => {
    const s = surface();
    expect(s.run_snippet!.def.description).toBe(PROGRAM_RUN_SNIPPET_DESCRIPTION + PROGRAM_FANOUT_RUN_SNIPPET_SENTENCE);
    expect(PROGRAM_FANOUT_RUN_SNIPPET_SENTENCE).toBe(
      " With `character`, `sdk`, `state` and `events` are that character's for this snippet. `chars` holds every logged-in character by name, each with its own `sdk`, `state` and `events`, so one snippet can act for several.",
    );
    expect(Object.keys(s.run_snippet!.def.inputSchema["properties"] as object)).toEqual(["code", "character"]);
    expect(s.start_routine!.def.description).toBe(
      "Run one exported async function of main.ts as a routine. It runs in the sandbox until it returns, throws or is stopped, with no time limit, whether or not you are awake. `args` is passed as its one argument. One routine of a name runs per character at a time: a name already running for that character is refused and says since when. The result lists the state of every routine.",
    );
    expect(Object.keys(s.start_routine!.def.inputSchema["properties"] as object)).toEqual(["name", "args", "character"]);
    expect(Object.keys(s.stop_routine!.def.inputSchema["properties"] as object)).toEqual(["name", "character"]);
    // The snippet loop's fan-out wording is untouched.
    expect(fanoutTools(PLAIN_RENDER).run_snippet.def.description).toContain("for this snippet and for anything it leaves running");
  });
});

describe("a program at fan-out", () => {
  test("one workspace, routines per character, and each character's record names the routine and character that dispatched", async () => {
    const r = rig();
    expect((await r.call("login_character", { name: "alfa", race: 1, class: 1 })).text).toStartWith("logged in: Alfa ");
    expect((await r.call("login_character", { name: "bravo", race: 1, class: 1 })).text).toStartWith("logged in: Bravo ");
    const src = (tag: string): string => `export async function chat(args) {
  await sdk.say(args.text + "${tag}");
  while (!signal.aborted) await sleep(50, { wake: false });
}
export async function both() {
  await chars.Alfa.sdk.say("both via alfa${tag}");
  await chars.Bravo.sdk.say("both via bravo${tag}");
  while (!signal.aborted) await sleep(50, { wake: false });
}
export async function bare() {
  try {
    await sdk.say("never");
  } catch (err) {
    memory.bare = String(err.message);
  }
}
`;
    expect((await r.call("write_file", { path: "main.ts", content: src("") })).text).toEndWith("loaded: deploy 1 · routines: bare, both, chat");
    expect((await r.call("start_routine", { name: "chat", args: { text: "from alfa" }, character: "Alfa" })).text).toStartWith("started chat (Alfa) on deploy 1\n");
    expect((await r.call("start_routine", { name: "chat", args: { text: "from bravo" }, character: "Bravo" })).isError).toBeUndefined();
    const again = await r.call("start_routine", { name: "chat", character: "Alfa" });
    expect(again.isError).toBe(true);
    expect(again.text).toStartWith("chat (Alfa) is already running: started ");
    expect((await r.call("start_routine", { name: "both" })).text).toStartWith("started both on deploy 1\n");
    expect((await r.call("start_routine", { name: "bare" })).isError).toBeUndefined();
    // A routine started for no character has no `sdk` of its own, and its stand-in names start_routine.
    await until("the bare routine", async () => (await r.call("run_snippet", { code: "memory.bare ?? null" })).text.includes("no character"));
    expect((await r.call("run_snippet", { code: "memory.bare" })).text).toContain(`sdk.say: ${NO_CHARACTER_SELECTED_ROUTINE}`);
    // A snippet run for a character has that character's sdk.
    expect((await r.call("run_snippet", { code: "state.self.name", character: "Bravo" })).text).toContain('"Bravo"');

    // One save restarts every routine under one load: each still says which routine it is.
    expect((await r.call("edit_file", { path: "main.ts", old: 'args.text + ""', new: 'args.text + " again"' })).text).toContain("restarts from the top 1s after the last load: chat (Alfa), chat (Bravo), both");
    await Bun.sleep(1_600);
    await r.call("run_snippet", { code: "1" });
    await r.host.recordDrain();

    const said = (name: string): Record<string, unknown>[] =>
      r.rows(name).flatMap((x) => (x.kind === "actions" ? x.actions.filter((a) => a.action === "say").map((a) => ({ text: a.args?.["text"], origin: x.origin })) : []));
    /** The id of the first call of `tool` in `name`'s record whose arguments have these fields. */
    const callId = (name: string, tool: string, args: Record<string, unknown> = {}): number | undefined =>
      r.rows(name).flatMap((x) => (x.kind === "call" && x.tool === tool && Object.entries(args).every(([k, v]) => (x.args as Record<string, unknown>)[k] === v) ? [x.id] : []))[0];
    const alfa = said("Alfa");
    expect(alfa.filter((s) => s.text === "from alfa")).toEqual([{ text: "from alfa", origin: { type: "program", call: callId("Alfa", "start_routine", { name: "chat" }), routine: "chat", character: "Alfa" } }]);
    // After the save both run again under the one load's id, and are still two routines apart.
    const edit = callId("Alfa", "edit_file");
    expect(alfa.filter((s) => s.text === "both via alfa").map((s) => s.origin)).toEqual([
      { type: "program", call: callId("Alfa", "start_routine", { name: "both" }), routine: "both" },
      { type: "program", call: edit, routine: "both" },
    ]);
    expect(alfa.filter((s) => s.text === "from alfa again")).toEqual([{ text: "from alfa again", origin: { type: "program", call: edit, routine: "chat", character: "Alfa" } }]);
    const bravo = said("Bravo");
    expect(bravo.filter((s) => s.text === "from bravo again")).toEqual([{ text: "from bravo again", origin: { type: "program", call: edit, routine: "chat", character: "Bravo" } }]);
    expect(bravo.filter((s) => s.text === "both via bravo").map((s) => (s.origin as { routine: string }).routine)).toEqual(["both", "both"]);
    // A start for one character is that character's call; one for none is every record's.
    expect(r.rows("Bravo").filter((x) => x.kind === "call" && x.tool === "start_routine").map((x) => (x as { args: { name: string } }).args.name)).toEqual(["chat", "both", "bare"]);
    // A snippet's own dispatches stay `tool`.
    await r.call("run_snippet", { code: "(await sdk.say('by hand')).ok", character: "Alfa" });
    expect(said("Alfa").find((s) => s.text === "by hand")?.origin).toMatchObject({ type: "tool" });

    // Logging a character out stops the routines started for it; one started for none runs on.
    expect((await r.call("logout_character", { character: "Bravo" })).text).toBe("logged out: Bravo. 1 of 3 characters logged in.");
    await until("Bravo's routine to end", () => r.facts.some((f) => f.kind === "ended" && f.routine.character === "Bravo"));
    expect(r.facts.find((f) => f.kind === "ended" && f.routine.character === "Bravo")).toMatchObject({ routine: { name: "chat", character: "Bravo", state: "stopped" } });
    const lines = r.host.program!.routineLines();
    expect(lines).toMatch(/\nchat \(Bravo\) stopped \d+s ago\n/);
    expect(lines).toMatch(/\nboth running \d+s, deploy 2, /);
    expect(lines).toMatch(/^routines:\nchat \(Alfa\) running /);
    // A name nobody holds says who is logged in.
    const zulu = await r.call("start_routine", { name: "chat", character: "Zulu" });
    expect(zulu.text).toStartWith("unknown character: Zulu. Logged in: Alfa.\n");

    await r.host.stop();
    await r.roster.shutdown({ logout: true });
    for (const s of r.store.list()) expect(validateSession(s.dir).errors).toEqual([]);
  }, 40_000);
});

describe("a program at fan-out across a pause", () => {
  test("a new process over the same workspace starts each character's routines again once its roster logs it back in", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrathbench-mcp-program-fanout-resume-"));
    dirs.push(root);
    const stub = startStubModule();
    stubs.push(stub);
    const open = (facts: ProgramFact[], known?: ReturnType<CharacterRoster["snapshot"]>) => {
      const host = new SandboxHost({
        moduleUrl: stub.baseUrl,
        token: "",
        scratchpad: new Scratchpad(join(root, "scratchpad.md")),
        snippetTimeoutMs: 5_000,
        pingGraceMs: 1_000,
        fanout: { maxCharacters: 3 },
        logSink: () => {},
        program: { workspace: new Workspace(join(root, "program")), onFact: (f) => facts.push(f), beatMs: 200 },
      });
      hosts.push(host);
      const roster = new CharacterRoster({
        grant: { maxCharacters: 3, accounts: ["ACCA", "ACCB", "ACCC"] },
        moduleUrl: stub.baseUrl,
        sandbox: host,
        secrets: new SecretRedactor(),
        env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
        ...(known !== undefined ? { known } : {}),
      });
      return { host, roster };
    };
    const a = open([]);
    expect((await a.roster.login({ name: "alfa", race: 1, class: 1 })).ok).toBe(true);
    expect((await a.roster.login({ name: "bravo", race: 1, class: 1 })).ok).toBe(true);
    const p = a.host.program!;
    await p.writeFile(
      "main.ts",
      `export async function idle(args) {
  memory[args.slot] = (memory[args.slot] ?? 0) + 1;
  while (!signal.aborted) await sleep(50, { wake: false });
}
`,
    );
    await p.startRoutine({ name: "idle", args: { slot: "a" }, character: "Alfa" });
    await p.startRoutine({ name: "idle", args: { slot: "b" }, character: "Bravo" });
    await p.startRoutine({ name: "idle", args: { slot: "none" } });
    await until("every run", async () => (await a.host.evalSnippet("memory.a + memory.b + memory.none")).value === "3");
    // The pause: the sandbox stops, then the roster gives its seats back and keeps them for a resume.
    await a.host.stop();
    await a.roster.shutdown({ logout: false });
    expect(p.routines().map((r) => r.state)).toEqual(["running", "running", "running"]);

    const facts: ProgramFact[] = [];
    const b = open(facts, a.roster.snapshot());
    expect((await b.roster.resume())).toEqual([]);
    const q = b.host.program!;
    expect(q.routines().map((r) => [r.character ?? null, r.state])).toEqual([
      ["Alfa", "running"],
      ["Bravo", "running"],
      [null, "running"],
    ]);
    await until("every run again", async () => (await b.host.evalSnippet("memory.a + memory.b + memory.none")).value === "6");
    // Each character's routines are named as they come back; none is said to be interrupted.
    const restarts = facts.filter((f): f is Extract<ProgramFact, { kind: "restart" }> => f.kind === "restart");
    expect(restarts.flatMap((f) => f.restarted.map((r) => `${r.name}${r.character !== undefined ? ` (${r.character})` : ""}`)).sort()).toEqual(["idle", "idle (Alfa)", "idle (Bravo)"]);
    expect(restarts.flatMap((f) => f.interrupted)).toEqual([]);
    await b.roster.shutdown({ logout: true });
  }, 40_000);
});

