#!/usr/bin/env bun
/**
 * stdio <-> TCP bridge for the claude-subscription driver.
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

const socket = await Bun.connect({
  hostname: "127.0.0.1",
  port,
  socket: {
    data(_s, data) {
      process.stdout.write(data);
    },
    close() {
      process.exit(0);
    },
    error(_s, err) {
      console.error(`[mcp-bridge] socket error: ${err.message}`);
      process.exit(1);
    },
  },
});

for await (const chunk of Bun.stdin.stream()) socket.write(chunk);
socket.end();
