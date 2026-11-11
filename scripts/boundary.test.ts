/**
 * The boundary check (`boundary.ts`) against this checkout, and against a
 * planted tree for each kind of violation it exists to catch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkStackBoundary } from "./boundary";

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wrath-mcp-boundary-"));
  made.push(root);
  const base: Record<string, string> = {
    "sdk/package.json": JSON.stringify({ name: "@wrathbench/sdk", dependencies: { zod: "4.4.3" }, exports: { ".": "./src/index.ts" } }),
    "mcp/package.json": JSON.stringify({
      name: "@wrathbench/mcp",
      dependencies: { "@wrathbench/sdk": "workspace:*", zod: "4.4.3" },
      exports: { ".": "./src/index.ts", "./sandbox-child": "./src/sandbox/child.ts", "./record": "./src/record/index.ts", "./record/read": "./src/record/read.ts" },
    }),
    "inspector/package.json": JSON.stringify({
      name: "@wrathbench/inspector",
      dependencies: { "@wrathbench/mcp": "workspace:*", "solid-js": "1.9.19" },
      exports: { ".": "./src/index.ts", "./wire": "./src/wire.ts" },
    }),
    "inspector/src/index.ts": 'import type { SessionFile } from "@wrathbench/mcp/record/read";\nimport { readFileSync } from "node:fs";\nimport type { TraceSegment } from "./wire";\n',
    "inspector/src/wire.ts": "export interface TraceSegment { v: number }\n",
    "inspector/src/codec/trace.ts": 'import type { TraceSegment } from "../wire";\n',
    "inspector/src/views/Map.tsx": 'import { createSignal } from "solid-js";\nimport { decode } from "../codec/trace";\nexport const Map = () => <div class="map">{String(createSignal(decode)[0]())}</div>;\n',
    "sdk/src/index.ts": 'import { z } from "zod";\nimport { join } from "node:path";\nexport const x = 1;\n',
    "mcp/src/index.ts": 'import { connect } from "@wrathbench/sdk";\nimport { readFileSync } from "node:fs";\n',
    "module/src/WbManager.cpp": '#include "WbManager.h"\n#include "Player.h"\n#include <string>\n',
  };
  for (const [path, body] of Object.entries({ ...base, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe("the stack boundary", () => {
  test("holds in this checkout", () => {
    expect(checkStackBoundary(resolve(import.meta.dir, ".."))).toEqual([]);
  });

  test("a clean planted tree passes", () => {
    expect(checkStackBoundary(tree({}))).toEqual([]);
  });

  test("the stack may not reach outside itself by path or by an undeclared name", () => {
    const root = tree({
      "mcp/src/bad.ts": 'import { callTool } from "../../runner/src/tools";\nimport { x } from "@wrathbench/runner";\n',
      "sdk/src/bad.ts": 'import { McpServer } from "@wrathbench/mcp";\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "mcp/src/bad.ts: imports ../../runner/src/tools, outside mcp/",
      "mcp/src/bad.ts: imports @wrathbench/runner, which mcp/package.json does not declare",
      "sdk/src/bad.ts: imports @wrathbench/mcp, which sdk/package.json does not declare",
    ]);
  });

  test("mcp reaches the SDK only through what it exports", () => {
    const root = tree({ "mcp/src/deep.ts": 'import { StateCache } from "@wrathbench/sdk/src/state";\n' });
    expect(checkStackBoundary(root)).toEqual(["mcp/src/deep.ts: imports @wrathbench/sdk/src/state, which @wrathbench/sdk does not export"]);
  });

  test("a module include is a header name, never a path", () => {
    const root = tree({ "module/src/Bad.h": '#include "../../scripts/thing.h"\n' });
    expect(checkStackBoundary(root)).toEqual(['module/src/Bad.h: includes "../../scripts/thing.h", a path rather than a header name']);
  });

  test("type-only imports count: every form a transpiler erases", () => {
    const root = tree({
      "mcp/src/t1.ts": 'import type { ToolContext } from "../../runner/src/tools";\n',
      "mcp/src/t2.ts": 'import { type Trajectory } from "@wrathbench/runner";\n',
      "mcp/src/t3.ts": 'export type { RunMeta } from "../../runner/src/trajectory";\n',
      "mcp/src/t4.ts": 'let x: import("../../runner/src/config").RunConfig | undefined;\nexport { x };\n',
      "sdk/src/t5.ts": 'import type {\n  McpServer,\n} from "@wrathbench/mcp";\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "mcp/src/t1.ts: imports ../../runner/src/tools, outside mcp/",
      "mcp/src/t2.ts: imports @wrathbench/runner, which mcp/package.json does not declare",
      "mcp/src/t3.ts: imports ../../runner/src/trajectory, outside mcp/",
      "mcp/src/t4.ts: imports ../../runner/src/config, outside mcp/",
      "sdk/src/t5.ts: imports @wrathbench/mcp, which sdk/package.json does not declare",
    ]);
  });

  test("strings and comments that look like imports are not imports", () => {
    const root = tree({ "mcp/src/prose.ts": '// import x from "../../runner/src/tools";\nexport const s = \'from "../../runner"\';\n' });
    expect(checkStackBoundary(root)).toEqual([]);
  });

  test("the inspector takes only the record's read side from the stack, and never the SDK", () => {
    const root = tree({
      "inspector/src/bad.ts": 'import { SessionWriter } from "@wrathbench/mcp/record";\nimport { McpServer } from "@wrathbench/mcp";\nimport { connect } from "@wrathbench/sdk";\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "inspector/src/bad.ts: imports @wrathbench/mcp/record; the inspector takes only @wrathbench/mcp/record/read from the stack",
      "inspector/src/bad.ts: imports @wrathbench/mcp; the inspector takes only @wrathbench/mcp/record/read from the stack",
      "inspector/src/bad.ts: imports @wrathbench/sdk, which inspector/package.json does not declare",
    ]);
  });

  test("sdk/ and mcp/ never import the inspector, nor take on the UI's dependencies", () => {
    const root = tree({
      "mcp/package.json": JSON.stringify({ name: "@wrathbench/mcp", dependencies: { "@wrathbench/sdk": "workspace:*", "@wrathbench/inspector": "workspace:*", vite: "8.3.7" }, exports: { ".": "./src/index.ts", "./record/read": "./src/record/read.ts" } }),
      "sdk/src/ui.ts": 'import { render } from "solid-js/web";\nimport { createInspectorApi } from "@wrathbench/inspector";\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "mcp/package.json: declares @wrathbench/inspector, which only inspector/ may",
      "mcp/package.json: declares vite, which only inspector/ may",
      "sdk/src/ui.ts: imports @wrathbench/inspector, which sdk/package.json does not declare",
      "sdk/src/ui.ts: imports solid-js/web, which sdk/package.json does not declare",
    ]);
  });

  test("what a browser bundles imports no built-in and nothing of the server side", () => {
    const root = tree({
      "inspector/src/codec/bad.ts": 'import { readFileSync } from "node:fs";\nimport { serve } from "bun";\nimport { createInspectorApi } from "../index";\nimport type { TraceSegment } from "../wire";\n',
      "inspector/src/views/Bad.tsx": 'import { storeSource } from "../store-source";\nimport { decode } from "../codec/trace";\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "inspector/src/codec/bad.ts: imports ../index, the inspector's server side, from a file a browser bundles",
      "inspector/src/codec/bad.ts: imports bun, a runtime built-in, from a file a browser bundles",
      "inspector/src/codec/bad.ts: imports node:fs, a runtime built-in, from a file a browser bundles",
      "inspector/src/views/Bad.tsx: imports ../store-source, the inspector's server side, from a file a browser bundles",
    ]);
  });

  test("the record's read side writes nothing, through every module it loads, and neither does the inspector", () => {
    const root = tree({
      "mcp/src/record/read.ts": 'export * from "./format";\nexport { SessionStore } from "./store";\nimport type { SessionWriter } from "./writer";\n',
      "mcp/src/record/format.ts": "export const SESSION_FORMAT = 1;\n",
      // Two hops down: the delete is pulled in by an import, not named by the entry.
      "mcp/src/record/store.ts": 'import { readdirSync } from "node:fs";\nimport { prune } from "./retention";\nexport class SessionStore { list() { return readdirSync("."); } prune() { prune(); } }\n',
      "mcp/src/record/retention.ts": 'import { rmSync as rm, statSync } from "node:fs";\nexport function prune() { rm("x"); statSync("y"); }\n',
      // A type-only import loads nothing, so the writer it names is not on the read side.
      "mcp/src/record/writer.ts": 'import { writeFileSync } from "node:fs";\nexport class SessionWriter { w() { writeFileSync("x", ""); } }\n',
      "inspector/src/cache.ts": 'import * as fs from "node:fs/promises";\nimport fsSync from "fs";\nexport async function keep() { await fs.writeFile("x", ""); await fs.readFile("y"); fsSync.unlinkSync("z"); await Bun.write("w", ""); }\n',
      "inspector/test/fixtures.ts": 'import { writeFileSync } from "node:fs";\nwriteFileSync("x", "");\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "inspector/src/cache.ts: calls Bun.write, on the record's read side",
      "inspector/src/cache.ts: calls fs.writeFile, on the record's read side",
      "inspector/src/cache.ts: calls fsSync.unlinkSync, on the record's read side",
      "mcp/src/record/retention.ts: calls rmSync, on the record's read side",
    ]);
  });
});
