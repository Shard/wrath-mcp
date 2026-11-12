/**
 * Fan-out above 1: one client, several characters. The pure pieces (the
 * grant, the merge, the roll-up, the grouped hints, where a call is
 * recorded) on their own, then the whole of it with the real confined child
 * against the stub module: seats opened and closed, `character` on the three
 * tools that take it, `chars`, a restart that reattaches every seat, a
 * record per character, and the standalone server over stdio.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CharacterRoster,
  digestCharacter,
  exceptionsOf,
  FANOUT_TOOL_ORDER,
  FanoutCalls,
  fanoutGrantProblem,
  fanoutTools,
  groupCentre,
  mergeEvents,
  PLAIN_FANOUT_RENDER,
  type FanoutToolContext,
  type RosterEntry,
} from "../src/fanout";
import { fanoutOption, PLAIN_RENDER, readRoster, ROSTER_FILE } from "../src/main";
import { tokenFingerprint } from "../src/module-auth";
import type { CallRow } from "../src/record/format";
import { SessionReader } from "../src/record/reader";
import { SessionStore } from "../src/record/store";
import { validateSession } from "../src/record/validate";
import { SessionWriter } from "../src/record/writer";
import { SecretRedactor } from "../src/redact";
import { SandboxHost, STATE_LOSS_RECOVERY_FANOUT } from "../src/sandbox/host";
import type { EventSummary } from "../src/sandbox/ipc";
import { Scratchpad } from "../src/scratchpad";
import { coreTools, renderActionHints, ToolSet } from "../src/tools";
import { startStubModule, STUB_PORT_SECRET, type StubModule } from "./fixtures/stub-module";

const ROOT = resolve(import.meta.dir, "..", "..");
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
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wrathbench-mcp-fan-"));
  dirs.push(d);
  return d;
};

describe("the grant", () => {
  test("a count above 1 needs that many distinct accounts", () => {
    expect(fanoutGrantProblem({ maxCharacters: 1, accounts: [] })).toBeNull();
    expect(fanoutGrantProblem({ maxCharacters: 5, accounts: ["A", "B", "C", "D", "E"] })).toBeNull();
    expect(fanoutGrantProblem({ maxCharacters: 3, accounts: ["A", "B"] })).toContain("3 accounts");
    expect(fanoutGrantProblem({ maxCharacters: 2, accounts: ["A", "a"] })).toContain("twice");
    expect(fanoutGrantProblem({ maxCharacters: 41, accounts: [] })).toContain("1 to 40");
    expect(fanoutGrantProblem({ maxCharacters: 1.5, accounts: [] })).toContain("whole number");
  });

  test("argv: absent or 1 is the single-character server, above 1 needs --accounts and refuses --account", () => {
    expect(fanoutOption([])).toBeNull();
    expect(fanoutOption(["--max-characters", "1", "--account", "RUNNER"])).toBeNull();
    expect(fanoutOption(["--max-characters", "3", "--accounts", "A, B,C"])).toEqual({ maxCharacters: 3, accounts: ["A", "B", "C"] });
    expect(fanoutOption(["--max-characters", "2", "--accounts", "A,B"], true)).toEqual({ maxCharacters: 2, accounts: ["A", "B"], allowGm: true });
    expect(() => fanoutOption(["--max-characters", "3"])).toThrow("3 accounts");
    expect(() => fanoutOption(["--max-characters", "3", "--accounts", "A,B,C", "--account", "A"])).toThrow("--accounts");
    expect(() => fanoutOption(["--accounts", "A,B"])).toThrow("--max-characters");
    expect(() => fanoutOption(["--max-characters", "0"])).toThrow("1 to 40");
    expect(() => fanoutOption(["--max-characters", "many"])).toThrow("1 to 40");
  });
});

const ev = (seq: number, ts: number, opcode: string, data: unknown): EventSummary => ({ seq, ts, opcode, data, schemaError: undefined });

describe("the merged feed", () => {
  test("an event several characters received is one entry; one that differs, or arrives much later, stays apart", () => {
    const merged = mergeEvents({
      Alfa: [ev(4, 1000, "SMSG_SPELL_GO", { caster: "9", spell: 1 }), ev(5, 1010, "SMSG_UPDATE_OBJECT", { self: true, guid: "1" }), ev(6, 9000, "SMSG_SPELL_GO", { caster: "9", spell: 1 })],
      Bravo: [ev(7, 1004, "SMSG_SPELL_GO", { caster: "9", spell: 1 }), ev(8, 1011, "SMSG_UPDATE_OBJECT", { self: true, guid: "2" })],
      Charlie: [ev(1, 1500, "SMSG_SPELL_GO", { caster: "9", spell: 1 })],
    });
    expect(merged.map((m) => [m.event.opcode, m.event.ts, m.seenBy])).toEqual([
      ["SMSG_SPELL_GO", 1000, ["Alfa", "Bravo", "Charlie"]],
      ["SMSG_UPDATE_OBJECT", 1010, ["Alfa"]],
      ["SMSG_UPDATE_OBJECT", 1011, ["Bravo"]],
      ["SMSG_SPELL_GO", 9000, ["Alfa"]],
    ]);
    expect(PLAIN_FANOUT_RENDER.seenBy(["Alfa"])).toBe(" [Alfa]");
    expect(PLAIN_FANOUT_RENDER.seenBy(["Alfa", "Bravo", "Charlie"])).toBe(" [seen by 3]");
  });

  test("forty copies of one event are one line", () => {
    const per: Record<string, EventSummary[]> = {};
    for (let i = 0; i < 40; i++) per[`C${i}`] = [ev(i, 1000 + i, "SMSG_MESSAGECHAT", { senderGuid: "8", message: "pull" })];
    const merged = mergeEvents(per);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.seenBy).toHaveLength(40);
  });
});

const snap = (o: { guid?: string; hp?: [number, number]; power?: [number, number]; map?: number; x?: number; y?: number; connected?: boolean; combat?: boolean; ghost?: boolean; move?: string | null; powerType?: number }): Record<string, unknown> => ({
  self: {
    ...(o.guid !== undefined ? { guid: o.guid } : {}),
    level: { value: 20 },
    ...(o.hp !== undefined ? { health: { value: { current: o.hp[0], max: o.hp[1] } } } : {}),
    ...(o.power !== undefined ? { power: { value: { current: o.power[0], max: o.power[1] } } } : {}),
    ...(o.map !== undefined ? { position: { value: { map: o.map, x: o.x ?? 0, y: o.y ?? 0, z: 0 } } } : {}),
    inCombat: { value: o.combat === true },
    ghost: { value: o.ghost === true },
    fields: { powerType: { value: o.powerType ?? 0 } },
  },
  observation: { connected: o.connected !== false },
  move: o.move === undefined ? null : { status: o.move },
});

describe("the roll-up", () => {
  const digests = [
    digestCharacter("Alfa", snap({ guid: "1", hp: [900, 1000], power: [10, 1000], map: 36, x: 0, y: 0, combat: true })),
    digestCharacter("Bravo", snap({ guid: "2", hp: [200, 1000], power: [500, 1000], map: 36, x: 10, y: 0, combat: true })),
    digestCharacter("Charlie", snap({ guid: "3", hp: [0, 1000], map: 36, x: 5, y: 5 })),
    digestCharacter("Delta", snap({ guid: "4", hp: [1000, 1000], map: 36, x: 400, y: 0, move: "too_far" })),
    digestCharacter("Echo", snap({ guid: "5", hp: [1000, 1000], map: 0, x: 0, y: 0, connected: false })),
    digestCharacter("Foxtrot", snap({})),
  ];

  test("counts, where the group is, and one line per exception", () => {
    expect(groupCentre(digests)).toEqual({ map: 36, x: 7.5, y: 0, count: 4 });
    const text = PLAIN_FANOUT_RENDER.rollup(digests, { maxCharacters: 8, views: [] });
    expect(text.split("\n")).toEqual([
      "6 of 8 characters logged in: 4 alive, 1 dead, 2 in combat, 0 casting, 1 out of mana",
      "group: 4 on map 36 around (8, 0)",
      "Bravo: health 20%",
      "Charlie: dead",
      "Delta: 393y from the group, last move too_far",
      "Echo: disconnected, on map 0",
      "Foxtrot: not in the world",
    ]);
  });

  test("it grows with the exceptions, not with the characters", () => {
    const forty = Array.from({ length: 40 }, (_, i) => digestCharacter(`C${i}`, snap({ guid: String(i + 1), hp: [1000, 1000], power: [900, 1000], map: 533, x: i, y: 0 })));
    const text = PLAIN_FANOUT_RENDER.rollup(forty, { maxCharacters: 40, views: [] });
    expect(text.split("\n")).toEqual(["40 of 40 characters logged in: 40 alive, 0 dead, 0 in combat, 0 casting, 0 out of mana", "group: 40 on map 533 around (20, 0)", "no exceptions"]);
    expect(exceptionsOf(forty[0]!, groupCentre(forty))).toEqual([]);
  });

  test("nobody logged in says how to log in, and a detached seat is an exception", () => {
    expect(PLAIN_FANOUT_RENDER.rollup([], { maxCharacters: 5, views: [] })).toBe("No character is logged in; use login_character.");
    expect(PLAIN_FANOUT_RENDER.rollup([], { maxCharacters: 5, views: [{ character: "Alfa", state: "detached", error: "timeout" }] })).toContain("Alfa: not attached (timeout)");
  });
});

describe("hints tallied per character", () => {
  test("the same failure from several characters is one line naming them; fan-out 1's hints render as they always did", () => {
    const text = renderActionHints([
      { action: "moveTo", status: "too_far", count: 2, hint: "walk closer", ts: 3, character: "Alfa" },
      { action: "moveTo", status: "too_far", count: 1, hint: "walk closer", ts: 5, character: "Bravo" },
      { action: "castSpell", status: "not_ready", count: 1, hint: "wait", ts: 4, character: "Bravo" },
    ]);
    expect(text).toBe("--- harness ---\nmoveTo too_far [Alfa, Bravo] ×3: walk closer\ncastSpell not_ready [Bravo]: wait");
    expect(renderActionHints([{ action: "moveTo", status: "too_far", count: 2, hint: "walk closer", ts: 3 }])).toBe("--- harness ---\nmoveTo too_far ×2: walk closer");
  });
});

describe("the same hint from several routines in one result", () => {
  const SUPERSEDED = "a newer moveTo replaced this one";
  test("is one line that names each routine once and sums the repeats", () => {
    const text = renderActionHints([
      { action: "moveTo", status: "superseded", count: 4, hint: SUPERSEDED, ts: 3, from: "trip" },
      { action: "moveTo", status: "superseded", count: 2, hint: SUPERSEDED, ts: 9, from: "grind" },
      { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 5, from: "trip" },
      { action: "castSpell", status: "not_ready", count: 20, hint: "Divine Storm (53385): still cooling down", ts: 7, from: "grind" },
    ]);
    expect(text).toBe(
      "--- harness ---\n" +
        `moveTo superseded ×7 (from earlier snippets: trip; grind): ${SUPERSEDED}\n` +
        "castSpell not_ready ×20 (from an earlier snippet: grind): Divine Storm (53385): still cooling down",
    );
  });

  test("one routine under two snippets is named once; a routine nothing names is counted, never listed", () => {
    expect(
      renderActionHints([
        { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 1, from: "trip" },
        { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 2, from: "trip" },
      ]),
    ).toBe(`--- harness ---\nmoveTo superseded ×2 (from an earlier snippet: trip): ${SUPERSEDED}`);
    const five = ["a", "b", "", "c", "d"].map((from, i) => ({ action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: i, from }));
    expect(renderActionHints(five)).toBe(`--- harness ---\nmoveTo superseded ×5 (from earlier snippets: a; b; c; +2): ${SUPERSEDED}`);
    expect(renderActionHints(five.filter((h) => h.from === "").concat({ ...five[2]!, ts: 9 }))).toBe(
      `--- harness ---\nmoveTo superseded ×2 (from an earlier snippet): ${SUPERSEDED}`,
    );
  });

  test("hints that differ in a character stay apart, and so does the current snippet's own line", () => {
    const text = renderActionHints([
      { action: "moveTo", status: "path_incomplete", count: 3, hint: "no route to (1.0, 2.0)", ts: 4, from: "trip" },
      { action: "moveTo", status: "path_incomplete", count: 5, hint: "no route to (1.0, 3.0)", ts: 3, from: "grind" },
      { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 2, from: "trip" },
      { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 1 },
    ]);
    expect(text).toBe(
      "--- harness ---\n" +
        "moveTo path_incomplete ×3 (from an earlier snippet: trip): no route to (1.0, 2.0)\n" +
        "moveTo path_incomplete ×5 (from an earlier snippet: grind): no route to (1.0, 3.0)\n" +
        `moveTo superseded (from an earlier snippet: trip): ${SUPERSEDED}\n` +
        `moveTo superseded: ${SUPERSEDED}`,
    );
  });

  test("a collapsed line frees a place among the four a result shows", () => {
    const routines = ["a", "b", "c", "d", "e"].map((from, i) => ({ action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: i, from }));
    const text = renderActionHints([...routines, { action: "castSpell", status: "not_ready", count: 1, hint: "wait", ts: 9 }]);
    expect(text).toBe(`--- harness ---\ncastSpell not_ready: wait\nmoveTo superseded ×5 (from earlier snippets: a; b; c; +2): ${SUPERSEDED}`);
  });

  test("above fan-out 1 the routines collapse per character, then the characters group", () => {
    const text = renderActionHints([
      { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 1, from: "trip", character: "Alfa" },
      { action: "moveTo", status: "superseded", count: 2, hint: SUPERSEDED, ts: 2, from: "grind", character: "Alfa" },
      { action: "moveTo", status: "superseded", count: 1, hint: SUPERSEDED, ts: 3, from: "trip", character: "Bravo" },
    ]);
    expect(text).toBe(
      "--- harness ---\n" +
        `moveTo superseded [Bravo] (from an earlier snippet: trip): ${SUPERSEDED}\n` +
        `moveTo superseded [Alfa] ×3 (from earlier snippets: trip; grind): ${SUPERSEDED}`,
    );
  });
});

describe("where a call is recorded", () => {
  test("a call that names a character goes to its record, one that names none to every open record, all under one id", () => {
    const root = scratch();
    const writers = new Map<string, SessionWriter>();
    for (const [name, id] of [["Alfa", "aaaaaaaaaaaaaaaa"], ["Bravo", "bbbbbbbbbbbbbbbb"]] as const) {
      const w = new SessionWriter({ dir: join(root, name), id, stack: { version: "0.0.0-test" }, log: () => {} });
      w.open();
      writers.set(name, w);
    }
    const calls = new FanoutCalls(writers);
    const one = calls.call("run_snippet", { code: "1", character: "Alfa" }, 1_000);
    calls.result(one, { text: "ok" });
    const all = calls.call("state_summary", {}, 1_000);
    calls.eventsServedFor("Bravo", all, []);
    calls.result(all, { text: "rolled up" });
    expect(all).toBe(1_001);
    const kinds = (name: string): string[] => (new SessionReader(join(root, name)).rows("calls") as CallRow[]).filter((r) => r.kind !== "key").map((r) => `${r.kind}:${"id" in r ? r.id : ""}`);
    expect(kinds("Alfa")).toEqual(["call:1000", "result:1000", "call:1001", "result:1001"]);
    expect(kinds("Bravo")).toEqual(["call:1001", "events:", "result:1001"]);
  });
});

// ------------------------------------------------------------ end to end

interface Rig {
  stub: StubModule;
  host: SandboxHost;
  roster: CharacterRoster;
  ctx: FanoutToolContext;
  tools: ToolSet<FanoutToolContext>;
  store: SessionStore;
  entries: () => RosterEntry[];
  call: (name: string, args: unknown) => Promise<{ text: string; isError?: boolean }>;
}

function rig(o: { max?: number; accounts?: string[]; timeoutMs?: number; known?: RosterEntry[] } = {}): Rig {
  const root = scratch();
  const stub = startStubModule();
  stubs.push(stub);
  const scratchpad = new Scratchpad(join(root, "scratchpad.md"));
  const max = o.max ?? 3;
  const host = new SandboxHost({
    moduleUrl: stub.baseUrl,
    token: "",
    scratchpad,
    snippetTimeoutMs: o.timeoutMs ?? 5_000,
    pingGraceMs: 1_000,
    fanout: { maxCharacters: max },
    record: { tickMs: 3_600_000 },
    logSink: () => {},
  });
  hosts.push(host);
  const store = new SessionStore(join(root, "sessions"));
  const secrets = new SecretRedactor();
  let entries: RosterEntry[] = [];
  const roster: CharacterRoster = new CharacterRoster({
    grant: { maxCharacters: max, accounts: o.accounts ?? ["ACCA", "ACCB", "ACCC"] },
    moduleUrl: stub.baseUrl,
    sandbox: host,
    secrets,
    env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
    ...(o.known !== undefined ? { known: o.known } : {}),
    onChange: (e) => (entries = e),
    record: (seat) => {
      const id = tokenFingerprint(seat.token);
      const w = new SessionWriter({ dir: store.sessionDir(id), id, stack: { version: "0.0.0-test" }, group: "0123456789abcdef", token: seat.token, scrub: (text) => roster.scrubTokens(text), log: () => {} });
      w.open();
      return w;
    },
  });
  const ctx: FanoutToolContext = { sandbox: host, scratchpad, sessionLive: () => true, turn: () => 0, secrets, fanout: roster, record: roster.calls };
  const specs = fanoutTools<FanoutToolContext>(PLAIN_RENDER);
  const tools = new ToolSet(FANOUT_TOOL_ORDER.map((n) => specs[n]));
  return { stub, host, roster, ctx, tools, store, entries: () => entries, call: (name, args) => tools.call(ctx, name, args) };
}

describe("the fan-out tool list", () => {
  test("is the core five with `character` on three of them, and the three that change who is logged in", () => {
    const specs = fanoutTools<FanoutToolContext>(PLAIN_RENDER);
    const defs = FANOUT_TOOL_ORDER.map((n) => specs[n].def);
    expect(defs.map((d) => d.name)).toEqual(["run_snippet", "recent_events", "state_summary", "write_scratchpad", "edit_scratchpad", "login_character", "logout_character", "list_characters"]);
    const core = coreTools(PLAIN_RENDER);
    // The scratchpad pair is the core's own, unchanged: one scratchpad per client.
    expect(specs.write_scratchpad.def).toEqual(core.write_scratchpad.def);
    expect(specs.edit_scratchpad.def).toEqual(core.edit_scratchpad.def);
    for (const name of ["run_snippet", "recent_events", "state_summary"] as const) {
      const props = specs[name].def.inputSchema["properties"] as Record<string, unknown>;
      expect(Object.keys(props)).toEqual([...Object.keys(core[name].def.inputSchema["properties"] as object), "character"]);
      expect((specs[name].def.inputSchema["required"] as string[] | undefined) ?? []).not.toContain("character");
    }
    // The wording a model reads above fan-out 1, held so a change to it is seen in review.
    expect(`${JSON.stringify({ defs, help: FANOUT_TOOL_ORDER.map((n) => specs[n].help) }, null, 2)}\n`).toBe(readFileSync(join(import.meta.dir, "fixtures", "fanout-tools.json"), "utf8"));
  });
});

describe("a fan-out sandbox", () => {
  test("logs characters in on separate accounts, each with its own client, and serves each by name", async () => {
    const r = rig();
    expect((await r.call("state_summary", {})).text).toBe("No character is logged in; use login_character.");
    expect((await r.call("login_character", { name: "alfa", race: 1, class: 1 })).text).toBe("logged in: Alfa (guid 101). 1 of 3 characters logged in.");
    expect((await r.call("login_character", { character: "bravo", race: "1", class: "2" })).text).toBe("logged in: Bravo (guid 102). 2 of 3 characters logged in.");
    expect(await r.call("login_character", { name: "ALFA" })).toEqual({ text: "login_character failed: Alfa is already logged in", isError: true });
    // One lease and one session per character, each on its own account, each child call under its own lease.
    expect([...r.stub.sessions.values()].map((s) => `${s.account}:${s.character}`)).toEqual(["ACCA:Alfa", "ACCB:Bravo"]);
    expect(r.stub.calls.filter((c) => c.path === "/session").every((c) => c.auth === "session")).toBe(true);
    expect(new Set(r.entries().map((e) => e.token)).size).toBe(2);

    expect((await r.call("run_snippet", { code: "Object.keys(chars)" })).text).toContain('[ "Alfa", "Bravo" ]');
    expect((await r.call("run_snippet", { code: "[state.self.name, sdk === chars.Alfa.sdk, events === chars.Alfa.events]", character: "Alfa" })).text).toContain('[ "Alfa", true, true ]');
    expect((await r.call("run_snippet", { code: "(await chars.Bravo.sdk.say('x')).ok && chars.Bravo.state.self.guid" })).text).toContain('"102"');
    // A routine keeps the character of the snippet that launched it.
    await r.call("run_snippet", { code: "globalThis.later = (async () => { await sleep(20, { wake: false }); return state.self.name; })(); 0", character: "Bravo" });
    expect((await r.call("run_snippet", { code: "await later", character: "Alfa" })).text).toContain('"Bravo"');

    const none = await r.call("run_snippet", { code: "sdk.moveTo({ x: 1, y: 2, z: 3 })" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("sdk.moveTo: no character selected");
    expect((await r.call("run_snippet", { code: "typeof sdk + ':' + (await sleep(5))" })).text).toContain('"object:elapsed"');
    expect(await r.call("run_snippet", { code: "1", character: "alfa" })).toEqual({ text: "unknown character: alfa. Logged in: Alfa, Bravo.", isError: true });
    expect(await r.call("state_summary", { character: "Zulu" })).toEqual({ text: "unknown character: Zulu. Logged in: Alfa, Bravo.", isError: true });

    const summary = JSON.parse((await r.call("state_summary", { character: "Bravo" })).text) as { self: { name: string } };
    expect(summary.self.name).toBe("Bravo");
    expect((await r.call("state_summary", {})).text).toStartWith("2 of 3 characters logged in: 2 alive, 0 dead");
    // The roll-up reads a brief of each seat: the snapshot's own fields, and only the ones a digest takes.
    const brief = (await r.host.stateBriefs())["Bravo"]!;
    const whole = await r.host.stateSnapshot("Bravo");
    expect(Object.keys(brief).sort()).toEqual(["eventCount", "lastSeq", "move", "observation", "self"]);
    expect(digestCharacter("Bravo", brief)).toEqual(digestCharacter("Bravo", whole));
    expect(digestCharacter("Bravo", brief)).toMatchObject({ inWorld: true, connected: true, level: 3, health: { current: 80, max: 100 }, mana: true });
    expect((await r.call("list_characters", {})).text.split("\n")).toEqual(["Alfa: level 3, health 80/100", "Bravo: level 3, health 80/100", "2 of 3 characters logged in."]);
  }, 30_000);

  test("merges what several characters received, and keeps one character's feed its own", async () => {
    const r = rig();
    await r.call("login_character", { name: "alfa", race: 1, class: 1 });
    await r.call("login_character", { name: "bravo", race: 1, class: 1 });
    // Each seat's own create block has landed (seq 0) before the frames below.
    await r.call("run_snippet", { code: "await sleep(50, { wake: false })" });
    const at = Date.now() + 60_000;
    r.stub.push(null, { opcode: "SMSG_MESSAGECHAT", opcodeId: 0x096, ts: at, data: { type: 1, language: 7, senderGuid: "8", message: "to both", chatTag: 0 } });
    r.stub.push([...r.stub.sessions.keys()][1]!, { opcode: "SMSG_NOTIFICATION", opcodeId: 0x1cb, ts: at + 1, data: { text: "to one" } });
    r.stub.push(null, { opcode: "MSG_MOVE_HEARTBEAT", opcodeId: 0x0ee, ts: at + 2, data: { guid: "9", flags: 1, pos: { x: 1, y: 2, z: 3, o: 0 } } });
    await r.call("run_snippet", { code: "await sleep(100, { wake: false })" });
    const merged = (await r.call("recent_events", { limit: 2 })).text.split("\n");
    expect(merged).toEqual([
      '#1 SMSG_MESSAGECHAT {"type":1,"language":7,"senderGuid":"8","message":"to both","chatTag":0} [seen by 2]',
      '#2 SMSG_NOTIFICATION {"text":"to one"} [Bravo]',
      "(+2 ambient movement and party-frame events folded into state — pass {includeMovement: true} for the raw stream)",
    ]);
    const own = (await r.call("recent_events", { character: "Alfa", limit: 1 })).text.split("\n");
    expect(own[0]).toBe('#1 SMSG_MESSAGECHAT {"type":1,"language":7,"senderGuid":"8","message":"to both","chatTag":0}');
  }, 30_000);

  test("refuses a login past the grant, frees a place at logout, and remembers where a character lives", async () => {
    const r = rig({ max: 2, accounts: ["ACCA", "ACCB"] });
    await r.call("login_character", { name: "alfa", race: 1, class: 1 });
    await r.call("login_character", { name: "bravo", race: 1, class: 1 });
    expect(await r.call("login_character", { name: "charlie", race: 1, class: 1 })).toEqual({ text: "login_character failed: 2 of 2 characters are logged in; log one out first (logout_character)", isError: true });
    expect((await r.call("logout_character", { character: "Alfa" })).text).toBe("logged out: Alfa. 1 of 2 characters logged in.");
    expect([...r.stub.sessions.values()].map((s) => s.character)).toEqual(["Bravo"]);
    expect((await r.call("list_characters", {})).text).toContain("Not logged in: Alfa.");
    expect(await r.call("logout_character", { character: "Alfa" })).toEqual({ text: "unknown character: Alfa. Logged in: Bravo.", isError: true });
    // Back by name, on the account and token it had.
    const before = r.entries().find((e) => e.character === "Alfa")!;
    expect((await r.call("login_character", { name: "alfa" })).text).toStartWith("logged in: Alfa (guid 101)");
    expect(r.entries().find((e) => e.character === "Alfa")).toEqual({ ...before, in: true });
    expect(r.stub.sessions.get(before.token)).toMatchObject({ account: "ACCA", character: "Alfa" });
  }, 30_000);

  test("a restart reattaches every seat before the next call is answered", async () => {
    const r = rig({ timeoutMs: 1_500 });
    await r.call("login_character", { name: "alfa", race: 1, class: 1 });
    await r.call("login_character", { name: "bravo", race: 1, class: 1 });
    const blocked = await r.call("run_snippet", { code: "globalThis.kept = 1; for (;;) {}", character: "Alfa" });
    expect(blocked.text).toContain(STATE_LOSS_RECOVERY_FANOUT);
    expect(r.host.drainNotices().map((n) => n.kind)).toEqual(["sandbox_restarted"]);
    const after = await r.call("run_snippet", { code: "[typeof kept, Object.keys(chars).join(), chars.Alfa.events.connected, chars.Bravo.state.self.name, state.self.name]", character: "Bravo" });
    expect(after.text).toContain('[ "undefined", "Alfa,Bravo", true, "Bravo", "Bravo" ]');
    // The replay was asked for on each seat's own stream.
    expect(r.stub.calls.filter((c) => c.path === "/events?replay=1")).toHaveLength(2);
    expect(r.host.totalRestarts).toBe(1);
  }, 30_000);

  test("keeps a record per character, each call in the records it concerns, and closes them at logout and shutdown", async () => {
    const r = rig();
    await r.call("login_character", { name: "alfa", race: 1, class: 1 });
    await r.call("login_character", { name: "bravo", race: 1, class: 1 });
    await r.call("run_snippet", { code: "(await sdk.say('from alfa')).ok", character: "Alfa" });
    await r.call("run_snippet", { code: "(await chars.Bravo.sdk.say('from bravo')).ok" });
    await r.call("write_scratchpad", { content: "notes" });
    // A call recorded in both records prints one character's token: neither record may hold it.
    expect((await r.call("run_snippet", { code: "chars.Bravo.sdk.token" })).text).toContain(r.entries().find((e) => e.character === "Bravo")!.token);
    await r.call("recent_events", { character: "Bravo" });
    await r.host.recordDrain();
    const byName = new Map(r.store.list().map((s) => [s.session.character?.name, s]));
    expect([...byName.keys()].sort()).toEqual(["Alfa", "Bravo"]);
    expect(new Set(r.store.list().map((s) => s.session.group))).toEqual(new Set(["0123456789abcdef"]));
    const rows = (name: string): CallRow[] => (new SessionReader(byName.get(name)!.dir).rows("calls") as CallRow[]).filter((x) => x.kind !== "key");
    const tools = (name: string): string[] => rows(name).flatMap((x) => (x.kind === "call" ? [`${x.tool}${(x.args as { character?: string } | null)?.character !== undefined ? `@${(x.args as { character: string }).character}` : ""}`] : []));
    // Alfa's record: its own login, Bravo's login (it was open), its snippet, the two that name nobody.
    expect(tools("Alfa")).toEqual(["login_character", "login_character", "run_snippet@Alfa", "run_snippet", "write_scratchpad", "run_snippet"]);
    expect(tools("Bravo")).toEqual(["login_character", "run_snippet", "write_scratchpad", "run_snippet", "recent_events@Bravo"]);
    for (const name of ["Alfa", "Bravo"]) {
      const text = JSON.stringify(rows(name));
      for (const e of r.entries()) expect(text).not.toContain(e.token);
      expect(text).toContain("[redacted]");
    }
    // Each character's dispatches are in its own record, linked to the call that sent them.
    const said = (name: string): string[] => rows(name).flatMap((x) => (x.kind === "actions" ? x.actions.filter((a) => a.action === "say").map((a) => String(a.args?.["text"])) : []));
    expect(said("Alfa")).toEqual(["from alfa"]);
    expect(said("Bravo")).toEqual(["from bravo"]);
    expect(rows("Bravo").some((x) => x.kind === "events")).toBe(true);
    expect(byName.get("Alfa")!.live).toMatchObject({ stream: { connected: true } });

    await r.call("logout_character", { character: "Alfa" });
    await r.host.stop();
    await r.roster.shutdown({ logout: true });
    for (const s of r.store.list()) {
      const v = validateSession(s.dir);
      expect(v.errors).toEqual([]);
      expect(v.session?.ended).not.toBeNull();
    }
    // Alfa's last call is the one that logged it out, with its result.
    expect(rows("Alfa").slice(-2).map((x) => x.kind)).toEqual(["call", "result"]);
    expect(r.stub.sessions.size).toBe(0);
  }, 30_000);

  test("a player one character's client was answered for is scrubbed from every record, as soon as the answer lands", async () => {
    const r = rig();
    await r.call("login_character", { name: "alfa", race: 1, class: 1 });
    const bravo = /\(guid (\d+)\)/.exec((await r.call("login_character", { name: "bravo", race: 1, class: 1 })).text)![1]!;
    await r.call("run_snippet", { code: "await sleep(50, { wake: false })" });
    const [alfaToken, bravoToken] = [...r.stub.sessions.keys()];
    const at = Date.now() + 60_000;
    r.stub.push(bravoToken!, { opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x051, ts: at, data: { guid: "88", found: true, name: "Stranger" } });
    r.stub.push(alfaToken!, { opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x051, ts: at + 1, data: { guid: bravo, found: true, name: "Bravo" } });
    await r.call("run_snippet", { code: "await sleep(100, { wake: false })" });
    // No record tick in between: the answers reached the writers with the cache
    // forward, and the other seat is own from the moment it opened.
    await r.call("run_snippet", { code: `'Stranger (guid 88) and Bravo (guid ${bravo})'`, character: "Alfa" });
    await r.host.recordDrain();
    const byName = new Map(r.store.list().map((s) => [s.session.character?.name, s]));
    const results = (new SessionReader(byName.get("Alfa")!.dir).rows("calls") as CallRow[]).flatMap((x) => (x.kind === "result" ? [x.text] : []));
    expect(results.at(-1)).toContain(`player (guid player) and Bravo (guid ${bravo})`);
    expect(JSON.stringify(results)).not.toContain("Stranger");
    await r.host.stop();
    await r.roster.shutdown({ logout: true });
  }, 30_000);

  test("a resumed roster brings back the characters that were logged in", async () => {
    const first = rig();
    await first.call("login_character", { name: "alfa", race: 1, class: 1 });
    await first.call("login_character", { name: "bravo", race: 1, class: 1 });
    await first.call("logout_character", { character: "Bravo" });
    const known = first.entries();
    expect(known.map((e) => [e.character, e.in])).toEqual([["Alfa", true], ["Bravo", false]]);
    await first.host.stop();
    await first.roster.shutdown({ logout: false });
    expect(first.entries().map((e) => [e.character, e.in])).toEqual([["Alfa", true], ["Bravo", false]]);

    // A second host on the same module state would need the same stub; a fresh one stands for a worldserver restart.
    const second = rig({ known });
    expect(await second.roster.resume()).toEqual([]);
    expect(second.roster.views()).toEqual([{ character: "Alfa", state: "in" }, { character: "Bravo", state: "out" }]);
    expect([...second.stub.sessions.values()].map((s) => `${s.account}:${s.character}`)).toEqual(["ACCA:Alfa"]);
  }, 30_000);
});

describe("the standalone server at fan-out above 1", () => {
  test("serves the fan-out list over stdio, keeps its roster 0600, and logs every character out on a clean exit", async () => {
    const tmp = scratch();
    const stub = startStubModule();
    stubs.push(stub);
    const state = join(tmp, "state");
    const proc = Bun.spawn(["bun", "--env-file=/dev/null", join(ROOT, "mcp", "src", "main.ts"), "--max-characters", "2", "--accounts", "ACCA,ACCB", "--dir", state], {
      cwd: ROOT,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: tmp, WRATHBENCH_MODULE_URL: stub.baseUrl, WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const ask = async (request: Record<string, unknown>): Promise<{ result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } }> => {
      proc.stdin.write(`${JSON.stringify(request)}\n`);
      await proc.stdin.flush();
      for (;;) {
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          // stdout carries JSON-RPC and nothing else, a snippet's console included.
          return JSON.parse(line) as never;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("the server closed its stdout early");
        buf += decoder.decode(value, { stream: true });
      }
    };
    const tool = async (id: number, name: string, args: unknown): Promise<string> => (await ask({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).result?.content?.[0]?.text ?? "";
    await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const list = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result?.tools?.map((t) => t.name)).toEqual([...FANOUT_TOOL_ORDER]);
    expect(await tool(3, "login_character", { name: "alfa", race: 1, class: 1 })).toStartWith("logged in: Alfa");
    expect(await tool(4, "login_character", { name: "bravo", race: 1, class: 1 })).toStartWith("logged in: Bravo");
    expect(await tool(5, "run_snippet", { code: "(console.log('printed'), Object.keys(chars).length)" })).toContain("=> 2");
    expect(statSync(join(state, ROSTER_FILE)).mode & 0o777).toBe(0o600);
    expect(readRoster(join(state, ROSTER_FILE)).map((e) => [e.character, e.account, e.in])).toEqual([["Alfa", "ACCA", true], ["Bravo", "ACCB", true]]);
    expect(stub.sessions.size).toBe(2);
    proc.stdin.end();
    await proc.exited;
    expect(stub.sessions.size).toBe(0);
    // Logged out on the way down, so a later start has nobody to bring back.
    expect(readRoster(join(state, ROSTER_FILE)).map((e) => e.in)).toEqual([false, false]);
    const store = new SessionStore(join(tmp, "sessions"));
    expect(store.list().map((s) => s.session.character?.name).sort()).toEqual(["Alfa", "Bravo"]);
    expect(new Set(store.list().map((s) => s.session.group)).size).toBe(1);
  }, 60_000);
});
