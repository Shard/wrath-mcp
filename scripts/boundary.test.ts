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
      exports: { ".": "./src/index.ts", "./sandbox-child": "./src/sandbox/child.ts" },
    }),
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
});
