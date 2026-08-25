/**
 * The stdio<->TCP bridge the claude CLI runs as its MCP server.
 *
 * The behaviour under test is the one morning-opus-1 paid for: when the
 * runner's MCP server goes away, the CLI must go with it. The bridge is the
 * last process alive that knows, so it stops its parent.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BRIDGE = join(import.meta.dir, "..", "src", "mcp-bridge.ts");

async function exitedWithin(proc: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

describe("mcp-bridge", () => {
  test("stops the process that launched it when the MCP socket closes", async () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    const parent = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `Bun.spawn({ cmd: [process.execPath, ${JSON.stringify(BRIDGE)}, "${listener.port}"], stdin: "pipe", stdout: "pipe", stderr: "inherit" });
         setInterval(() => {}, 1_000);`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      // give the bridge time to connect, then take the server away
      await new Promise((r) => setTimeout(r, 750));
      listener.stop(true);
      expect(await exitedWithin(parent, 8_000)).toBe(true);
    } finally {
      listener.stop(true);
      parent.kill("SIGKILL");
      await parent.exited.catch(() => undefined);
    }
  }, 20_000);

  test("a CLI closing the bridge's stdin is its own teardown, not a reason to kill it", async () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    // The parent shuts the bridge's stdin — the CLI's orderly MCP teardown —
    // and keeps running. The bridge must not take that as the runner leaving.
    const parent = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const b = Bun.spawn({ cmd: [process.execPath, ${JSON.stringify(BRIDGE)}, "${listener.port}"], stdin: "pipe", stdout: "pipe", stderr: "inherit" });
         setTimeout(() => b.stdin.end(), 600);
         setInterval(() => {}, 1_000);`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await new Promise((r) => setTimeout(r, 3_500)); // past the 2s SIGKILL window
      expect(await exitedWithin(parent, 0)).toBe(false);
    } finally {
      listener.stop(true);
      parent.kill("SIGKILL");
      await parent.exited.catch(() => undefined);
    }
  }, 20_000);
});
