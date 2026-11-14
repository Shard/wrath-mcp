/**
 * The module's request bounds, compiled and run. `module/src/WbBounds.h` holds
 * them as arithmetic with no AzerothCore type in it, so that this suite can
 * pin them from a bare clone: what a position or facing may be, how far one
 * move reaches, how many samples a planned line may take on the world thread,
 * how much caller text an audit record carries. The checks themselves are
 * `module/test/bounds.cpp`. `module/src/WbLease.h` is the same kind of piece
 * for what a lease decides about its creates (the character it binds, its
 * logins an hour), checked by `module/test/lease.cpp`.
 *
 * The module proper builds only inside an AzerothCore tree, so these are the
 * only pieces of it a checkout compiles. Skipped, visibly, where there is no C++
 * compiler.
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

test.skipIf(compiler === null)("the module's bounds hold: coordinates, reach, sample counts, audit text", () => buildAndRun("bounds"), 60_000);

test.skipIf(compiler === null)("a lease's rules hold: one character bound, overlapping first creates, logins an hour", () => buildAndRun("lease"), 60_000);
