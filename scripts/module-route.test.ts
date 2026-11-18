/**
 * The drop guard's verdict on a walked route, compiled and run.
 * `module/src/WbRoute.h` holds it as arithmetic with no AzerothCore type in
 * it: which segment of a polyline is a ledge, what the guard does with one,
 * and the z each route point is judged and walked at. The module reads the
 * world and hands the numbers in. The checks are `module/test/route.cpp`,
 * invented routes shaped like the ones that earned each rule.
 *
 * The module proper builds only inside an AzerothCore tree, so this is one of
 * the few pieces of it a checkout compiles (module-bounds.test.ts has the
 * others). Skipped, visibly, where there is no C++ compiler.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const compiler = Bun.which("c++") ?? Bun.which("g++") ?? Bun.which("clang++");

/** Compile `module/test/<name>.cpp` against `module/src` and run it: it prints `ok` and exits 0 when every check holds. */
async function buildAndRun(name: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `wb-${name}-`));
  try {
    const bin = join(dir, name);
    const build = Bun.spawn(
      [compiler!, "-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", join(root, "module", "src"), join(root, "module", "test", `${name}.cpp`), "-o", bin],
      { stdout: "pipe", stderr: "pipe" },
    );
    const buildErr = await new Response(build.stderr).text();
    expect({ code: await build.exited, stderr: buildErr }).toEqual({ code: 0, stderr: "" });

    const run = Bun.spawn([bin], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(run.stdout).text();
    expect({ code: await run.exited, out }).toEqual({ code: 0, out: "ok\n" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(compiler === null)("the drop guard's verdict holds: stairs pass, walls and sustained steep slopes are refused", () => buildAndRun("route"), 60_000);
