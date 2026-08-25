#!/usr/bin/env bun
/**
 * stdio <-> TCP bridge for the claude-code driver.
 *
 * `claude --mcp-config` can only launch a *stdio* MCP server as a child
 * process, but the runner must keep exactly one SandboxHost (one SDK client,
 * one session token) inside the driver process — spawning `mcp.ts` as the MCP
 * server would create a second sandbox and a second session on the same token.
 *
 * So the driver serves MCP on a loopback TCP port and hands `claude` this
 * bridge as the "command": it pipes stdin to the socket and the socket to
 * stdout, byte for byte. Deliberately dependency-free so it starts fast.
 *
 *   bun runner/src/mcp-bridge.ts <port>
 */

const port = Number(Bun.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: bun runner/src/mcp-bridge.ts <port>");
  process.exit(2);
}

/**
 * The CLI that launched this bridge, captured now: once it dies this process is
 * reparented to init and `process.ppid` would name the wrong victim.
 */
const parentPid = process.ppid;

/**
 * When the runner's MCP server goes away, so must the CLI.
 *
 * Observed on morning-opus-1: the runner ended, this bridge lost its socket and
 * exited — and `claude` carried on for 32 more seconds and 14 more tool calls,
 * replaying its whole 111k context into each one and degenerating into calling
 * tools that do not exist ("ping", "ping2"). About 1.5M tokens billed after the
 * episode was over. A CLI whose only tool server has vanished has nothing left
 * to do, and the driver cannot always be the one to stop it: when the runner
 * process is gone, this bridge is the last thing alive that knows.
 *
 * SIGTERM first so the CLI can flush its session, SIGKILL if it will not go.
 */
function stopParent(): void {
  if (parentPid <= 1) return;
  try {
    process.kill(parentPid, "SIGTERM");
  } catch {
    // already gone
  }
  // Deliberately not unref'd: this timer is the whole point, so the bridge
  // stays alive long enough to deliver the SIGKILL to a CLI that ignored the
  // SIGTERM, and only then exits.
  setTimeout(() => {
    try {
      process.kill(parentPid, "SIGKILL");
    } catch {
      // already gone
    }
    process.exit(0);
  }, 2_000);
}

/**
 * Set when the CLI closes our stdin and we end the socket ourselves. That is
 * the CLI's own orderly teardown of its MCP server, not the runner going away,
 * and killing the CLI for it would be a self-inflicted wound.
 */
let weClosedIt = false;

const socket = await Bun.connect({
  hostname: "127.0.0.1",
  port,
  socket: {
    data(_s, data) {
      process.stdout.write(data);
    },
    close() {
      if (weClosedIt) process.exit(0);
      stopParent();
    },
    error(_s, err) {
      console.error(`[mcp-bridge] socket error: ${err.message}`);
      stopParent();
    },
  },
});

for await (const chunk of Bun.stdin.stream()) socket.write(chunk);
weClosedIt = true;
socket.end();
