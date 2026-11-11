/**
 * The stack's fixture sessions (`mcp/test/fixtures/sessions/`, synthetic, with
 * invented names), planted the way a writer leaves them: every closed segment
 * compressed. Read by path, not imported, so the inspector's tests take
 * nothing from `mcp/` but its declared entry points.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

export const FIXTURE_ROOT = join(import.meta.dir, "..", "..", "mcp", "test", "fixtures", "sessions");
export const CLOSED_ID = "3f9a1c0b7e2d4a61";
export const LIVE_ID = "b04e77c1d95a2f38";
/** The first window both fixtures are laid out from: 2026-01-01T00:00:00Z. */
export const FIXTURE_T0 = 1767225600000;

/** A temp directory removed when the file's tests end. */
export function tempDir(): string {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const d = mkdtempSync(join(tmpdir(), "wrath-inspector-"));
  dirs.push(d);
  return d;
}

/** Copy fixture `name` to `dest`, compressing what a writer would have closed. */
export function plant(name: "closed" | "live", dest: string, patch: Record<string, unknown> = {}): string {
  cpSync(join(FIXTURE_ROOT, name), dest, { recursive: true });
  const sessionPath = join(dest, "session.json");
  const session = { ...(JSON.parse(readFileSync(sessionPath, "utf8")) as Record<string, unknown>), ...patch };
  writeFileSync(sessionPath, JSON.stringify(session));
  for (const stream of ["trace", "events", "calls"]) {
    let names: string[];
    try {
      names = readdirSync(join(dest, stream)).sort();
    } catch {
      continue;
    }
    const closed = session["ended"] === null ? names.slice(0, -1) : names;
    for (const n of closed) {
      const p = join(dest, stream, n);
      writeFileSync(`${p}.zst`, Bun.zstdCompressSync(readFileSync(p)));
      unlinkSync(p);
    }
  }
  return dest;
}

/** A store holding both fixtures under their ids, the closed one owned by `alice`. */
export function plantStore(root: string): string {
  mkdirSync(root, { recursive: true });
  plant("closed", join(root, CLOSED_ID), { owner: "alice" });
  plant("live", join(root, LIVE_ID));
  return root;
}
