/**
 * Fan-out 1 is byte-identical to the single-character stack: the tool list,
 * schemas, descriptions and parameter restatements, the sandbox's fixed
 * texts, the child's ambient names and environment, and every served output
 * of a scripted session, held to `fixtures/fanout1-surface.json`.
 *
 * That file was written by `fixtures/fanout1-surface.ts` at wrath-mcp
 * `f58802a`, the `v1` head before fan-out existed, and is not regenerated to
 * make this pass: a difference here is a change to what a single-character
 * model is served, which is WrathBench's `docs/METHODOLOGY.md` ("The model
 * surface") to decide, not a fixture to refresh. The refreshes since were
 * such decisions: a sandbox killed for a blocked event loop stopped naming
 * the snippet whose timeout noticed as the one that blocked it, which changed
 * that result's error and its notice and nothing else; and `run_snippet`'s
 * description says that the `scratchpad` calls return Promises (operator,
 * 2026-11-12), which changed that description where it is served and
 * nothing else.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fanout1Surface } from "./fixtures/fanout1-surface";

test(
  "what a model is served at fan-out 1 is what it was served before fan-out existed",
  async () => {
    const golden = readFileSync(join(import.meta.dir, "fixtures", "fanout1-surface.json"), "utf8");
    const now = `${JSON.stringify(await fanout1Surface(), null, 2)}\n`;
    expect(now).toBe(golden);
  },
  120_000,
);
