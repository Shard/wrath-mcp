/**
 * The stdio<->TCP bridge the claude CLI runs as its MCP server.
 *
 * The behaviour under test is the one morning-opus-1 paid for: when the
 * runner's MCP server goes away, the CLI must go with it. The bridge is the
 * last process alive that knows, so it stops its parent.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BRIDGE = join(import.meta.dir, "..", "src", "mcp-bridge.ts");

/** True once the pid is gone (a zombie counts as gone: it has exited). */
function dead(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    return true;
  }
}

async function until(pred: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("mcp-bridge", () => {
  test("stops the process that launched it when the MCP socket closes", async () => {
    // A stand-in for `claude`: it launches the bridge and then does nothing,
    // which is exactly the shape that kept billing tokens after the run ended.
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {} },
    });
    const parent = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `Bun.spawn({ cmd: [process.execPath, ${JSON.stringify(BRIDGE)}, "${listener.port}"], stdin: "pipe", stdout: "pipe", stderr: "inherit" });
         await new Promise(() => {});`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    // give the bridge time to connect, then take the server away
    await new Promise((r) => setTimeout(r, 750));
    listener.stop(true);

    expect(await until(() => dead(parent.pid))).toBe(true);
    try {
      parent.kill("SIGKILL");
    } catch {
      // already gone, which is the point
    }
  }, 20_000);

  test("a CLI closing the bridge's stdin is its own teardown, not a reason to kill it", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {} },
    });
    // The parent shuts the bridge's stdin — the CLI's orderly MCP teardown —
    // and keeps running. The bridge must not take that as the runner leaving.
    const parent = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const b = Bun.spawn({ cmd: [process.execPath, ${JSON.stringify(BRIDGE)}, "${listener.port}"], stdin: "pipe", stdout: "pipe", stderr: "inherit" });
         await Bun.sleep(600);
         b.stdin.end();
         await new Promise(() => {});`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    await new Promise((r) => setTimeout(r, 3_500)); // past the 2s SIGKILL window
    expect(dead(parent.pid)).toBe(false);
    parent.kill("SIGKILL");
    listener.stop(true);
  }, 20_000);
});
