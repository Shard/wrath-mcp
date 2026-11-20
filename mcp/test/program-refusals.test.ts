/**
 * What of a routine's failed calls the program reports as a refusal
 * (operator, 2026-11-18): what the SDK marks no fault of the code (a note on
 * a move that went ahead, a call the character's death refused) is none; a
 * signature is fresh once in the sandbox's life, not once per load; and a
 * run of a deploy a load replaced, still unwinding, mints nothing fresh.
 * Against the runtime itself, with fake runs: the SDK's side of the
 * classification is in the SDK's own tests.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildToHost, ProgramEvent } from "../src/sandbox/ipc";
import { Owner, type Ownership } from "../src/sandbox/owners";
import { ProgramRuntime, type ProgramDeps, type RoutineRun } from "../src/sandbox/program";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A runtime over versions 1 and 2 of a main.ts that exports `walk`, and what it sends. */
function runtime(): { rt: ProgramRuntime<null>; events: ProgramEvent[] } {
  const root = mkdtempSync(join(tmpdir(), "wrathbench-mcp-refusals-"));
  dirs.push(root);
  for (const v of [1, 2]) {
    mkdirSync(join(root, String(v)));
    writeFileSync(join(root, String(v), "main.ts"), `export async function walk() {}\n// ${v}\n`);
  }
  const events: ProgramEvent[] = [];
  const ownership: Ownership = {
    close: () => {},
    adopt: () => {},
    real: { setTimeout, setInterval, clearTimeout, clearInterval },
  };
  const deps = {
    root,
    send: (m: ChildToHost) => {
      if (m.t === "program") events.push(...m.events);
    },
    run: <T>(_run: RoutineRun<null>, fn: () => T): T => fn(),
    ownership,
    renderError: (err: unknown) => String(err),
    seat: () => undefined,
    characters: () => [],
    multi: false,
  } as unknown as ProgramDeps<null>;
  return { rt: new ProgramRuntime<null>(deps), events };
}

/** A run of `walk` on `deploy`, live or ended. */
function run(deploy: number, ended = false): RoutineRun<null> {
  return {
    note: { name: "walk", deploy, startedAt: Date.now(), state: ended ? "stopped" : "running" },
    evalId: 1,
    controller: new AbortController(),
    owner: new Owner("test"),
    seat: null,
    ended,
    endedAt: ended ? Date.now() - 10 : 0,
  };
}

const hint = (status: string, extra: { nonFault?: "note" | "death"; count?: number } = {}) => ({
  action: status === "long_route" ? "moveTo" : "castSpell",
  status,
  hint: `a ${status} hint`,
  count: extra.count ?? 1,
  ts: Date.now(),
  ...(extra.nonFault !== undefined ? { nonFault: extra.nonFault } : {}),
});

const refusals = (events: ProgramEvent[]) => events.filter((e) => e.kind === "refusal");

describe("a refusal is a fault of the code that made the call", () => {
  test("a long route on a move that went ahead is no refusal, fresh or repeated", async () => {
    const { rt, events } = runtime();
    await rt.load(1, 0);
    rt.noteRefusal(run(1), hint("long_route", { nonFault: "note", count: 3 }));
    expect(refusals(events)).toEqual([]);
    expect(rt.beat().repeats).toEqual([]);
  });

  test("a call the character's death refused or cut short is no refusal; a live interrupt still is", async () => {
    const { rt, events } = runtime();
    await rt.load(1, 0);
    rt.noteRefusal(run(1), hint("dead", { nonFault: "death" }));
    rt.noteRefusal(run(1), hint("interrupted", { nonFault: "death" }));
    expect(refusals(events)).toEqual([]);
    expect(rt.beat().repeats).toEqual([]);
    // Interrupted while alive (a hit, a stun): a cast that failed.
    rt.noteRefusal(run(1), hint("interrupted"));
    expect(refusals(events)).toMatchObject([{ action: "castSpell", status: "interrupted", signature: "walk||castSpell|interrupted", fresh: true }]);
  });
});

describe("a refusal is fresh once in the sandbox's life", () => {
  test("the same signature after a reload is a repeat, and repeats taken before the load are kept", async () => {
    const { rt, events } = runtime();
    await rt.load(1, 0);
    rt.noteRefusal(run(1), hint("out_of_range", { count: 2 }));
    expect(refusals(events)).toMatchObject([{ signature: "walk||castSpell|out_of_range", deploy: 1, fresh: true }]);
    expect((await rt.load(2, 0)).ok).toBe(true);
    rt.noteRefusal(run(2), hint("out_of_range"));
    expect(refusals(events).length).toBe(1);
    // One counted before the load and one after: the load drops neither.
    expect(rt.beat().repeats).toEqual([{ signature: "walk||castSpell|out_of_range", count: 2, ts: expect.any(Number), newest: { text: "a out_of_range hint" } }]);
  });

  test("a run of the replaced deploy, unwinding after the reload, mints nothing fresh; the new deploy's own first one is", async () => {
    const { rt, events } = runtime();
    await rt.load(1, 0);
    await rt.load(2, 0);
    rt.noteRefusal(run(1, true), hint("not_ready"));
    expect(refusals(events)).toEqual([]);
    expect(rt.beat().repeats).toEqual([{ signature: "walk||castSpell|not_ready", count: 1, ts: expect.any(Number), newest: { text: "a not_ready hint" } }]);
    rt.noteRefusal(run(2), hint("not_ready"));
    expect(refusals(events)).toMatchObject([{ signature: "walk||castSpell|not_ready", deploy: 2, fresh: true }]);
  });

  test("a run that ended on the current deploy still reports its first refusal", async () => {
    // A moveToAsync's verdict can land after its routine returned.
    const { rt, events } = runtime();
    await rt.load(1, 0);
    rt.noteRefusal(run(1, true), hint("too_far"));
    expect(refusals(events)).toMatchObject([{ signature: "walk||castSpell|too_far", fresh: true }]);
  });

  test("errors still count from the last load", async () => {
    const { rt, events } = runtime();
    await rt.load(1, 0);
    rt.noteError(run(1), new TypeError("x is undefined"));
    rt.noteError(run(1), new TypeError("x is undefined"));
    expect(events.filter((e) => e.kind === "error").length).toBe(1);
    await rt.load(2, 0);
    rt.noteError(run(2), new TypeError("x is undefined"));
    expect(events.filter((e) => e.kind === "error").length).toBe(2);
  });
});

describe("a repeat carries its newest occurrence", () => {
  test("a refusal's repeats name the newest hint, not the fresh one's", async () => {
    const { rt, events } = runtime();
    await rt.load(1, 0);
    const at = (text: string, ts: number) => ({ action: "moveTo", status: "path_incomplete", hint: text, count: 1, ts });
    rt.noteRefusal(run(1), at("ends at (1, 1)", 1_000));
    rt.noteRefusal(run(1), at("ends at (2, 2)", 2_000));
    rt.noteRefusal(run(1), at("ends at (3, 3)", 3_000));
    expect(refusals(events)).toMatchObject([{ hint: "ends at (1, 1)" }]);
    expect(rt.beat().repeats).toEqual([{ signature: "walk||moveTo|path_incomplete", count: 2, ts: 3_000, newest: { text: "ends at (3, 3)" } }]);
  });

  test("an error's repeats name the newest text", async () => {
    const { rt } = runtime();
    await rt.load(1, 0);
    // One place in the code, two messages: the same signature.
    const fail = (m: string): TypeError => {
      const e = new TypeError(m);
      e.stack = `TypeError: ${m}\n    at walk (/x/main.ts:3:1)`;
      return e;
    };
    rt.noteError(run(1), fail("first"));
    rt.noteError(run(1), fail("second"));
    rt.noteError(run(1), fail("third"));
    const [r] = rt.beat().repeats;
    expect(r).toMatchObject({ count: 2, newest: { text: expect.stringContaining("third") } });
  });
});
