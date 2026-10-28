/**
 * MCP server: hand-rolled JSON-RPC, newline-delimited, per the MCP stdio
 * transport. Hand-rolled rather than the MCP SDK because the server side of
 * the protocol we need — initialize, tools/list, tools/call, ping — is a few
 * dozen lines, and the dependency budget is "Bun built-ins first" (CLAUDE.md).
 * Revisit if we ever need resources, sampling, or notifications.
 *
 * Transport only: what the tools are and what a call does is the `ToolHost`
 * a harness hands it (a `ToolSet` bound to its context), so the same server
 * serves the stack's core tools alone (`main.ts`) or a harness's whole set.
 * `serveStdio` runs it over stdin/stdout; a harness that must keep its one
 * sandbox in-process serves it over a loopback socket instead and hands the
 * CLI `bridge.ts`.
 */

import type { CallOrigin, ToolDef, ToolResult } from "./tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** What the server serves: the tool list as of now, and the dispatcher behind it. */
export interface ToolHost {
  list(): ToolDef[];
  coerce(name: string, raw: unknown): { ok: true; args: unknown } | { ok: false; error: string };
  call(name: string, args: unknown, origin: CallOrigin): Promise<ToolResult>;
  /** A result that never reached a tool (unparseable arguments) still carries pending hints. */
  appendPending(result: ToolResult): Promise<ToolResult>;
}

/**
 * Told about every `tools/call` once it has an answer. `dispatchTs` is the
 * wall clock taken as the call arrived, before the tool ran: every writer of
 * this callback appends its records after the fact, so their own timestamps
 * are write time, and this is the only honest start of the call it has.
 */
export type OnToolCall = (
  name: string,
  args: unknown,
  result: { text: string; isError?: boolean },
  dispatchTs: number,
) => void;

export interface McpServerOptions {
  /** `serverInfo.name` on `initialize`. */
  serverName?: string;
  /** `serverInfo.version` on `initialize`. */
  serverVersion?: string;
  onToolCall?: OnToolCall;
}

export class McpServer {
  private initialized = false;
  /**
   * The last `dispatchTs` handed out. Strictly increasing per server, so the
   * stamp doubles as the call's key: a snippet's `actions` record carries it as
   * `callTs`, and two calls answered in one millisecond must not share it.
   */
  private lastDispatchTs = 0;

  constructor(
    private readonly tools: ToolHost,
    private readonly opts: McpServerOptions = {},
  ) {}

  /** Handle one raw JSON-RPC line. Returns the response line, or null for notifications. */
  async handleLine(line: string): Promise<string | null> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      } satisfies JsonRpcResponse);
    }
    const isNotification = msg.id === undefined;
    const respond = (result: unknown): string | null =>
      isNotification ? null : JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result } satisfies JsonRpcResponse);
    const fail = (code: number, message: string): string | null =>
      isNotification ? null : JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } } satisfies JsonRpcResponse);

    switch (msg.method) {
      case "initialize":
        this.initialized = true;
        return respond({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.opts.serverName ?? "wrathbench-mcp", version: this.opts.serverVersion ?? "0.0.0" },
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return respond({});
      case "tools/list":
        return respond({
          tools: this.tools.list().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        if (!this.initialized) return fail(-32002, "server not initialized");
        const name = String(msg.params?.["name"] ?? "");
        // Stamped before anything runs, the argument check included, so a
        // refused call's near-zero duration is measured rather than assumed.
        const now = Date.now();
        const dispatchTs = now > this.lastDispatchTs ? now : this.lastDispatchTs + 1;
        this.lastDispatchTs = dispatchTs;
        // Leniency at the transport edge: some clients send `arguments` as a
        // JSON *string* (sometimes fenced); `coerce` handles that.
        const raw = msg.params?.["arguments"] ?? {};
        const coerced = this.tools.coerce(name, raw);
        // An unparseable call is still a tool result the model reads, so the
        // pending hints ride it as they would any other.
        const result = coerced.ok
          ? await this.tools.call(name, coerced.args, { dispatchTs })
          : await this.tools.appendPending({ text: coerced.error, isError: true });
        const args = coerced.ok ? coerced.args : raw;
        this.opts.onToolCall?.(name, args, result, dispatchTs);
        return respond({
          content: [{ type: "text", text: result.text }],
          isError: result.isError ?? false,
        });
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }
}

/** Newline-delimited lines off a byte stream; a last line without a newline is yielded too. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf.trim().length > 0) yield buf;
}

/** Serve `server` over this process's stdin and stdout until stdin closes. */
export async function serveStdio(server: McpServer): Promise<void> {
  const out = Bun.stdout.writer();
  for await (const line of lines(Bun.stdin.stream())) {
    if (line.trim().length === 0) continue;
    const response = await server.handleLine(line);
    if (response !== null) {
      out.write(`${response}\n`);
      await out.flush();
    }
  }
}
