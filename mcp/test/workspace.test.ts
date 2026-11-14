/**
 * The program workspace and the one-off snippet compile: the files a model
 * keeps, the versions the child imports from, and the import statements a
 * snippet may write beside a program. None of it is reached by a sandbox
 * that hosts no program.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileOneOff, compileSnippet, extractImportStatements, resolveWorkspaceImport } from "../src/sandbox/rewrite";
import { durationWords } from "../src/sandbox/program";
import { renderRoutines, routineDetailKey } from "../src/sandbox/program-host";
import { FILE_MAX_CHARS, MEMORY_MAX_CHARS, sameImportGraph, Workspace, WORKSPACE_MAX_BYTES, workspaceImportGraph } from "../src/workspace";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "wrathbench-mcp-workspace-"));
  dirs.push(d);
  return d;
}

describe("the workspace's files", () => {
  test("write, read, edit and delete, with the refusals that name what to fix", () => {
    const ws = new Workspace(scratch());
    expect(ws.write("lib/combat.ts", "export const reach = 5;\n")).toEqual({ ok: true, text: "created lib/combat.ts (24 chars)" });
    expect(ws.write("lib/combat.ts", "export const reach = 6;\n")).toEqual({ ok: true, text: "wrote lib/combat.ts (24 chars)" });
    expect(ws.read("./lib/combat.ts")).toEqual({ ok: true, text: "export const reach = 6;\n" });
    expect(ws.list()).toEqual([{ path: "lib/combat.ts", bytes: 24 }]);
    expect(ws.read("main.ts")).toEqual({ ok: false, error: "no such file in the workspace: main.ts. Files: lib/combat.ts." });
    expect(ws.write("lib/combat.ts/x.ts", "")).toEqual({ ok: false, error: "lib/combat.ts is a file, so lib/combat.ts/x.ts cannot be created under it" });

    expect(ws.edit("lib/combat.ts", "6", "7")).toEqual({ ok: true, text: "edited lib/combat.ts (1 replacement) (24 chars)" });
    expect(ws.edit("lib/combat.ts", "", "x")).toEqual({ ok: false, error: "old was empty, so there is nothing to match; to replace a whole file use write_file" });
    expect(ws.edit("lib/combat.ts", "reach", "reach")).toEqual({ ok: false, error: "old and new are the same text, so this edit would change nothing" });
    expect(ws.edit("lib/combat.ts", "nope", "x")).toEqual({ ok: false, error: "old was not found in lib/combat.ts; copy the text exactly, whitespace included (read_file shows the file as it is now)" });
    ws.write("two.ts", "a\nb a\na\n");
    expect(ws.edit("two.ts", "a", "c")).toEqual({ ok: false, error: "old matches 3 places in two.ts, at lines 1, 2, 3; include more surrounding text or set replaceAll" });
    expect(ws.edit("two.ts", "a", "$&", true)).toEqual({ ok: true, text: "edited two.ts (3 replacements) (11 chars)" });
    expect(ws.read("two.ts")).toEqual({ ok: true, text: "$&\nb $&\n$&\n" });
    expect(ws.edit("gone.ts", "a", "b")).toEqual({ ok: false, error: "gone.ts does not exist; create it with write_file" });

    expect(ws.delete("lib/combat.ts")).toEqual({ ok: true, text: "deleted lib/combat.ts" });
    expect(existsSync(join(ws.filesDir, "lib"))).toBe(false);
    expect(ws.delete("lib/combat.ts").ok).toBe(false);
  });

  test("a path stays inside the workspace", () => {
    const ws = new Workspace(scratch());
    for (const [path, why] of [
      ["", "path is empty"],
      ["/etc/passwd", "is absolute"],
      ["~/x", "is absolute"],
      ["../x.ts", "contains .."],
      ["a/../../x.ts", "contains .."],
      ["a\\b.ts", "uses \\"],
      ["lib/", "names a directory"],
      [".", "names the workspace itself"],
      ["a\u0000b", "control character"],
    ] as const) {
      const r = ws.write(path, "x");
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toContain(why);
    }
    expect(ws.write(7, "x")).toEqual({ ok: false, error: "path must be a string, got number" });
    expect(ws.list()).toEqual([]);
  });

  test("a limit refuses and writes nothing; it never truncates", () => {
    const ws = new Workspace(scratch());
    ws.write("a.ts", "short");
    const over = ws.write("a.ts", "x".repeat(FILE_MAX_CHARS + 1));
    expect(over).toEqual({ ok: false, error: `a.ts would be ${FILE_MAX_CHARS + 1} chars, over the ${FILE_MAX_CHARS}-char limit of a file. Nothing was written.` });
    expect(ws.read("a.ts")).toEqual({ ok: true, text: "short" });
    expect(ws.write("a.ts", "x".repeat(FILE_MAX_CHARS)).ok).toBe(true);
    for (let i = 0; i < 32; i++) expect(ws.write(`fill/${i}.txt`, "y".repeat(FILE_MAX_CHARS)).ok || i === 31).toBe(true);
    const full = ws.write("one-more.txt", "z".repeat(FILE_MAX_CHARS));
    expect(full.ok).toBe(false);
    expect(full.ok ? "" : full.error).toMatch(new RegExp(`^the workspace would total \\d+ bytes, over its ${WORKSPACE_MAX_BYTES}-byte limit\\. Nothing was written\\.$`));
    expect(existsSync(join(ws.filesDir, "one-more.txt"))).toBe(false);
  });

  test("memory.json is the host's to write: refused to the file operations, saved through writeMemory, held to its limit", () => {
    const ws = new Workspace(scratch());
    expect(ws.readMemory()).toBeNull();
    for (const r of [ws.write("memory.json", "{}"), ws.edit("memory.json", "a", "b"), ws.delete("memory.json")]) {
      expect(r).toEqual({ ok: false, error: 'memory.json is saved by the harness from `memory`; change it in code, e.g. `memory.phase = "grind"` in a snippet or a routine.' });
    }
    expect(ws.writeMemory('{"phase":"grind"}')).toEqual({ ok: true, text: "saved memory.json (17 chars)" });
    expect(ws.read("memory.json")).toEqual({ ok: true, text: '{"phase":"grind"}' });
    const over = ws.writeMemory(JSON.stringify({ blob: "x".repeat(MEMORY_MAX_CHARS) }));
    expect(over.ok).toBe(false);
    expect(ws.readMemory()).toBe('{"phase":"grind"}');
  });
});

describe("versions", () => {
  test("a snapshot is the files as they stood, by plain path, each content stored once; memory.json is left out", () => {
    const dir = scratch();
    const ws = new Workspace(dir);
    expect(ws.version).toBe(0);
    ws.write("main.ts", "export const v = 1;\n");
    ws.write("lib/a.ts", "export const a = 1;\n");
    ws.writeMemory("{}");
    expect(ws.snapshot()).toBe(1);
    ws.write("main.ts", "export const v = 2;\n");
    expect(ws.snapshot()).toBe(2);
    expect(readFileSync(join(ws.versionDir(1), "main.ts"), "utf8")).toBe("export const v = 1;\n");
    expect(readFileSync(join(ws.versionDir(2), "main.ts"), "utf8")).toBe("export const v = 2;\n");
    expect(existsSync(join(ws.versionDir(2), "memory.json"))).toBe(false);
    // lib/a.ts did not change: both versions are the one stored content.
    expect(statSync(join(ws.versionDir(1), "lib", "a.ts")).ino).toBe(statSync(join(ws.versionDir(2), "lib", "a.ts")).ino);
    // A new process over the same directory continues the numbering.
    expect(new Workspace(dir).version).toBe(2);
  });

  test("main.ts's import graph: the files it reaches, the candidates tried before the one that resolved, and nothing else", () => {
    const ws = new Workspace(scratch());
    expect([...ws.graph()]).toEqual([["main.ts", null]]);
    ws.write("main.ts", 'import { a } from "./lib/a";\nimport data from "./data.json";\nimport { later } from "./later";\nexport const x = a;\n');
    ws.write("lib/a.ts", 'import { b } from "../b.js";\nexport const a = b;\n');
    ws.write("b.js", "export const b = 1;\n");
    ws.write("data.json", "{}");
    ws.write("unrelated.ts", "export const u = 1;\n");
    const graph = ws.graph();
    expect([...graph.keys()].sort()).toEqual(
      ["b.js", "data.json", "later.js", "later.jsx", "later.mjs", "later.ts", "later.tsx", "later/index.js", "later/index.ts", "lib/a.ts", "main.ts"].sort(),
    );
    expect(graph.get("later.ts")).toBeNull();
    expect(graph.get("b.js")).toBe("export const b = 1;\n");
    expect(sameImportGraph(graph, ws.graph())).toBe(true);
    // A file outside the graph changes nothing; one a specifier would resolve to does, as does an edit inside.
    ws.write("unrelated.ts", "export const u = 2;\n");
    expect(sameImportGraph(graph, ws.graph())).toBe(true);
    ws.write("later.ts", "export const later = 1;\n");
    expect(sameImportGraph(graph, ws.graph())).toBe(false);
    const n = ws.snapshot();
    expect(sameImportGraph(ws.graph(), ws.graphAt(n))).toBe(true);
    expect(sameImportGraph(ws.graph(), workspaceImportGraph(ws.versionDir(n)))).toBe(true);
    // A file that does not parse is a leaf.
    ws.write("main.ts", 'import { a } from "./lib/a";\nexport const x = ;\n');
    expect(ws.graph().has("main.ts")).toBe(true);
  });
});

describe("a one-off snippet", () => {
  const root = scratch();
  mkdirSync(join(root, "lib", "deep"), { recursive: true });
  writeFileSync(join(root, "util.ts"), "export const one = 1;\n");
  writeFileSync(join(root, "lib", "deep", "two.ts"), "export const two = 2;\n");
  writeFileSync(join(root, "lib", "index.ts"), "export const idx = 0;\n");
  writeFileSync(join(root, "plan.txt"), "walk north\n");
  writeFileSync(join(root, "data.json"), "{}");

  test("the persistent compile is untouched: what it emits for a snippet is what it always emitted", () => {
    // The fan-out-1 surface holds its outputs; this holds that an import statement is still not its business.
    expect(compileSnippet("const a = 1;\nfunction f() {}\nlet b;").statementsBody).toContain(';try{ globalThis["f"] = f; }catch(_){}');
    expect(() => compileSnippet('import { one } from "./util";\none')).toThrow();
  });

  test("declarations stay the snippet's own: no keyword strip, no copy-back", () => {
    const c = compileOneOff("const a = 1;\nfunction f() {}\nlet b;\nreturn a;");
    expect(c.statementsBody).toContain("const a = 1;");
    expect(c.statementsBody).not.toContain("globalThis");
    expect(c.names).toEqual(["a", "f", "b"]);
    expect(c.canTryExpression).toBe(false);
    expect(compileOneOff("40 + 2").canTryExpression).toBe(true);
    expect(compileOneOff("40 + 2").expressionBody).toBe(compileSnippet("40 + 2").expressionBody);
  });

  test("only top-level import declarations are lifted: not import(), not import.meta, not strings or comments", () => {
    const src = ['import { one } from "./util";', '// import { no } from "./comment"', 'const s = `import { no } from "./template"`;', 'const d = await import("node:path");', "if (true) { const m = import.meta; }", "one"].join("\n");
    const lifted = extractImportStatements(src);
    expect(lifted.imports.map((i) => i.text)).toEqual(['import { one } from "./util";']);
    expect(lifted.body.split("\n")).toHaveLength(src.split("\n").length);
    expect(lifted.body.split("\n")[0]).toBe("");
    const multi = extractImportStatements('import {\n  one, // the first\n  /* and */ one as uno,\n} from \'./util\'\nimport data from "./d.json" with { type: "json" }\none');
    expect(multi.imports.map((i) => i.text)).toEqual(["import { one, one as uno, } from './util'", 'import data from "./d.json" with { type: "json" }']);
    expect(multi.body).toBe("\n\n\n\n\none");
  });

  test("each specifier form resolves to the file's absolute path under the version's directory", () => {
    for (const [spec, rel] of [
      ["./util", "util.ts"],
      ["./util.ts", "util.ts"],
      ["util", "util.ts"],
      ["lib/deep/two", "lib/deep/two.ts"],
      ["./lib", "lib/index.ts"],
      ["./data.json", "data.json"],
    ] as const) {
      expect(resolveWorkspaceImport(spec, root)).toEqual({ abs: `${root}/${rel}`, rel });
    }
    expect(resolveWorkspaceImport("node:fs", root)).toBeNull();
    expect(() => resolveWorkspaceImport("./nope", root)).toThrow('import "./nope": no such file in the workspace (looked for nope.ts, nope.tsx, nope.js, nope.mjs, nope.jsx, nope/index.ts, nope/index.js)');
    expect(() => resolveWorkspaceImport("/etc/passwd", root)).toThrow("imports name workspace files by relative path");
    expect(() => resolveWorkspaceImport("../x", root)).toThrow(".. would leave the workspace");
    expect(() => resolveWorkspaceImport("./util", undefined)).toThrow("there are no workspace files to import yet");
    expect(() => resolveWorkspaceImport("./plan.txt", root)).toThrow('import "./plan.txt": only code and JSON files can be imported (.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs, .json)');
    expect(() => resolveWorkspaceImport("./memory.json", root)).toThrow("memory.json is your memory, not a module");
  });

  test("a bare builtin name is refused as what it is, once no workspace file answers to it", () => {
    // `import "fs"` was once refused as a missing fs.ts.
    const refusal = 'import "fs": fs is a builtin module, not a file in your workspace; in a snippet a bare name imports a workspace file, so import the builtin as "node:fs"';
    expect(() => resolveWorkspaceImport("fs", root)).toThrow(refusal);
    expect(() => resolveWorkspaceImport("fs", undefined)).toThrow(refusal);
    expect(() => resolveWorkspaceImport("fs/promises", root)).toThrow('so import the builtin as "node:fs/promises"');
    // Bun's own builtins have no node: name to point to.
    expect(() => resolveWorkspaceImport("bun", root)).toThrow(/^import "bun": bun is a builtin module, not a file in your workspace; in a snippet a bare name imports a workspace file$/);
    // A workspace file of the same name is the file; ./ is never a builtin.
    writeFileSync(join(root, "events.ts"), "export const e = 1;\n");
    expect(resolveWorkspaceImport("events", root)).toEqual({ abs: `${root}/events.ts`, rel: "events.ts" });
    expect(() => resolveWorkspaceImport("./path", root)).toThrow('import "./path": no such file in the workspace');
  });

  test("named, default, namespace and side-effect imports become awaited dynamic imports with checked exports", () => {
    const c = compileOneOff(['import { one, one as uno } from "./util";', 'import dflt, { two } from "lib/deep/two";', 'import * as ns from "util.ts";', 'import "./util";', 'import { join } from "node:path";', "return one + uno + two + ns.one + (dflt ?? 0) + join.length;"].join("\n"), { root });
    const util = JSON.stringify(`${root}/util.ts`);
    expect(c.statementsBody).toContain(`const __wrathbench_import_0__ = await import(${util});`);
    expect(c.statementsBody).toContain('throw new SyntaxError("util.ts has no export named " + JSON.stringify(__wrathbench_name__));');
    expect(c.statementsBody).toContain('const { one, "one": uno } = __wrathbench_import_0__;');
    expect(c.statementsBody).toContain(`const __wrathbench_import_1__ = await import(${JSON.stringify(`${root}/lib/deep/two.ts`)});`);
    expect(c.statementsBody).toContain("const dflt = __wrathbench_import_1__.default;");
    expect(c.statementsBody).toContain("const ns = __wrathbench_import_2__;");
    expect(c.statementsBody).toContain(`await import(${util});\n`);
    expect(c.statementsBody).toContain('= await import("node:path");');
    // A type-only import is dropped, as a TypeScript file drops it.
    const typed = compileOneOff('import type { T } from "./util";\nimport { one } from "./util";\nconst x: T = one;\nreturn x;', { root });
    expect(typed.statementsBody.match(/await import\(/g)).toHaveLength(1);
    // A single expression after its imports keeps its value.
    const expr = compileOneOff('import { one } from "./util"\none + 1', { root });
    expect(expr.canTryExpression).toBe(true);
    expect(expr.expressionBody.endsWith("return (\none + 1\n);")).toBe(true);
  });

  test("a string-literal import() of a workspace file is routed to the sandbox; schemes, absolute paths and computed arguments are not", () => {
    const body = compileOneOff(
      ['const a = await import("./lib/combat");', 'const c = await import("node:fs");', `const d = await ${"imp"}ort("/abs/x.ts");`, "const p = './util'; const e = await import(p);", 'const s = "import(\\"./only-in-a-string\\")";', 'const f = obj.import("./lib/combat");'].join("\n"),
      { root },
    ).statementsBody;
    expect(body).toContain('__wrathbench_import__("./lib/combat")');
    expect(body).toContain('import("node:fs")');
    expect(body).toContain(`${"imp"}ort("/abs/x.ts")`);
    expect(body).toContain("import(p)");
    expect(body).not.toContain('__wrathbench_import__("./only-in-a-string")');
    expect(body).toContain('obj.import("./lib/combat")');
  });

  test("a parse error below an import still names the user's line", () => {
    try {
      compileOneOff('const x = 1;\nimport { one } from "./util"\nconst y = ;', { root });
      throw new Error("expected a parse error");
    } catch (e) {
      // Line 1 of the transpiled text is the wrapper; the user's line 3 is line 4.
      expect((e as { position?: { line?: number } }).position?.line).toBe(4);
    }
  });
});

describe("the routine lines", () => {
  test("say how each routine stands, in durations", () => {
    const now = 1_000_000_000;
    expect(renderRoutines([], now)).toBe("routines: none started");
    const text = renderRoutines(
      [
        { name: "grind", deploy: 7, startedAt: now - 12 * 60_000, state: "running", lastAction: { action: "move_to", ts: now - 3_000 } },
        { name: "trip", deploy: 7, startedAt: now - 500_000, state: "returned", endedAt: now - 65_000, value: '"done"' },
        { name: "heal", character: "Bravo", deploy: 6, startedAt: now - 4_000_000, state: "threw", endedAt: now - 3_900_000, error: { name: "TypeError", text: "TypeError: x is undefined", frames: ["at heal (main.ts:9:3)"], signature: "heal|TypeError|main.ts:9" } },
        { name: "scout", deploy: 7, startedAt: now - 90_000, state: "interrupted", endedAt: now - 30_000, note: "the program did not load again" },
        { name: "idle", deploy: 7, startedAt: now - 1_000, state: "running" },
      ],
      now,
    );
    expect(text).toBe(
      [
        "routines:",
        "grind running 12m, deploy 7, last action 3s ago",
        'trip returned 1m ago: "done"',
        "heal (Bravo) threw 1h05m ago: TypeError: x is undefined at heal (main.ts:9:3)",
        "scout interrupted 30s ago: the program did not load again",
        "idle running 1s, deploy 7, no action yet",
      ].join("\n"),
    );
    expect([0, 59_400, 60_000, 3_599_000, 3_600_000].map(durationWords)).toEqual(["0s", "59s", "1m", "59m", "1h00m"]);
  });

  test("an error or a value already shown is referred to, not repeated; a changed one is shown again", () => {
    const now = 1_000_000_000;
    const trip = { name: "trip", deploy: 7, startedAt: now - 500_000, state: "returned" as const, endedAt: now - 65_000, value: '"done"' };
    const heal = { name: "heal", character: "Bravo", deploy: 6, startedAt: now - 4_000_000, state: "threw" as const, endedAt: now - 3_900_000, error: { name: "TypeError", text: "TypeError: x is undefined", frames: ["at heal (main.ts:9:3)"], signature: "heal|TypeError|main.ts:9" } };
    const shown = new Set([routineDetailKey(trip)!, routineDetailKey(heal)!]);
    expect(renderRoutines([trip, heal], now, shown)).toBe(["routines:", "trip returned 1m ago (value shown before)", "heal (Bravo) threw 1h05m ago: TypeError (shown before)"].join("\n"));
    expect(renderRoutines([{ ...trip, value: '"back"' }, { ...heal, startedAt: now - 3_950_000 }], now, shown)).toBe(
      ["routines:", 'trip returned 1m ago: "back"', "heal (Bravo) threw 1h05m ago: TypeError: x is undefined at heal (main.ts:9:3)"].join("\n"),
    );
    expect(routineDetailKey({ name: "grind", deploy: 7, startedAt: now, state: "running" })).toBeUndefined();
  });
});
