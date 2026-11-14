/**
 * A program at fan-out 1 is served what it was served before a program could
 * run at fan-out above 1: the program tools' definitions, parameter
 * restatements and alias keys, the routine lines, and the restart text, held
 * byte for byte to `fixtures/program1-surface.json`.
 *
 * That file was written by `fixtures/program1-surface.ts` at wrath-mcp
 * `b90ee70`, the `v1` head that adopted the program, and is not regenerated
 * to make this pass: a difference here is a change to what a single
 * character's model is served, which is WrathBench's `docs/METHODOLOGY.md`
 * ("The model surface") to decide.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { program1Surface } from "./fixtures/program1-surface";

test("what a program is served at fan-out 1 is what it was served before a program ran at fan-out", () => {
  const golden = readFileSync(join(import.meta.dir, "fixtures", "program1-surface.json"), "utf8");
  expect(`${JSON.stringify(program1Surface(), null, 2)}\n`).toBe(golden);
});
