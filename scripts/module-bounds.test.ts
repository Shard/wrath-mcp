/**
 * The module's request bounds, compiled and run. `module/src/WbBounds.h` holds
 * them as arithmetic with no AzerothCore type in it, so that this suite can
 * pin them from a bare clone: what a position or facing may be, how far one
 * move reaches, how many samples a planned line may take on the world thread,
 * how much caller text an audit record carries. The checks themselves are
 * `module/test/bounds.cpp`.
 *
 * The module proper builds only inside an AzerothCore tree, so this is the one
 * piece of it a checkout compiles. Skipped, visibly, where there is no C++
 * compiler.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const compiler = Bun.which("c++") ?? Bun.which("g++") ?? Bun.which("clang++");

test.skipIf(compiler === null)(
  "the module's bounds hold: coordinates, reach, sample counts, audit text",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-bounds-"));
    try {
      const bin = join(dir, "bounds");
      const build = Bun.spawn(
        [compiler!, "-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", join(root, "module", "src"), join(root, "module", "test", "bounds.cpp"), "-o", bin],
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
  },
  60_000,
);
