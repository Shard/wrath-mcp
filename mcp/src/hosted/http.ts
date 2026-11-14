/**
 * MCP over Streamable HTTP for a hosted gateway: the protocol's framing and
 * nothing else. Who the caller is, which tools they are served and what a
 * call does are the gateway's (`gateway.ts`), handed in as an
 * `McpEndpoint`; this file only reads a POST and writes its answer.
 *
 * Both eras of the protocol are served on the one endpoint, every answer a
 * single JSON object (never an SSE stream: nothing here streams):
 *
 * - **Modern** (2026-07-28): no handshake and no session. Every request
 *   carries its version in `params._meta`, mirrored in
 *   `MCP-Protocol-Version`, with `Mcp-Method` (and `Mcp-Name` on a
 *   `tools/call`) beside it; a header that is missing or disagrees with the
 *   body is `400` with `HeaderMismatch` (-32020), an unknown version `400`
 *   with `UnsupportedProtocolVersionError` (-32022) naming what is
 *   supported, an unknown method `404` with -32601. `server/discover` says
 *   what this server is; results carry `resultType: "complete"`.
 * - **Legacy** (2025-03-26 to 2025-11-25): an `initialize` is answered with
 *   the version it asked for when that is one of them, else the newest, and
 *   no `Mcp-Session-Id` is minted: the gateway keys nothing by connection,
 *   so a legacy client's later requests need nothing but its key. A request
 *   with no version header is taken as 2025-03-26, as the specification
 *   allows.
 *
 * A notification is `202` with no body. The stdio server (`server.ts`) is a
 * separate transport and keeps its own `initialize` answer.
 */

import { listedTools } from "../server";
import type { ToolDef, ToolResult } from "../tools";

/** The revisions with per-request metadata this server speaks. */
export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];
/** The handshake revisions served over Streamable HTTP, newest first. */
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** A legacy request with no `MCP-Protocol-Version` header. */
export const LEGACY_DEFAULT_VERSION = "2025-03-26";

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_HEADER_MISMATCH = -32020;
export const ERR_UNSUPPORTED_VERSION = -32022;
/** A refusal of the gateway's own: a limit, or a host that could not be opened. */
export const ERR_GATEWAY = -32000;

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

type Id = string | number | null;

/** A refusal a call can come back with instead of a result: an HTTP status and a JSON-RPC error. */
export interface CallRefusal {
  status: number;
  message: string;
  /** Seconds, for `Retry-After`. */
  retryAfterS?: number;
}

/** What the gateway hands the transport for one authenticated caller. */
export interface McpEndpoint {
  serverInfo: { name: string; version: string };
  /** The tools this caller is served: a function of their grant, never of earlier requests. */
  list(): ToolDef[];
  /** One `tools/call`, its arguments as the client sent them. */
  call(name: string, args: unknown): Promise<{ result: ToolResult } | { refused: CallRefusal }>;
}

/** What the transport tells the gateway about one request, for the audit. */
export interface McpRequestNote {
  era: "modern" | "legacy" | "none";
  method: string | null;
  version: string | null;
  /** The HTTP status answered. */
  status: number;
  error?: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rpcError = (status: number, id: Id, code: number, message: string, data?: unknown, headers?: Record<string, string>): Response =>
  json(status, { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }, headers);

/** A header value with the Base64 sentinel (`=?base64?…?=`) decoded, as the specification asks before comparing. */
export function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m === null ? v : Buffer.from(m[1]!, "base64").toString("utf8");
}

/**
 * Answer one POST to the MCP endpoint. `note` is told what was asked and
 * answered, for the gateway's audit; the call's own outcome is the
 * endpoint's to record.
 */
export async function serveMcpPost(req: Request, endpoint: McpEndpoint, note: (n: McpRequestNote) => void = () => {}): Promise<Response> {
  let msg: unknown;
  try {
    msg = JSON.parse(await req.text());
  } catch {
    note({ era: "none", method: null, version: null, status: 400, error: "parse error" });
    return rpcError(400, null, ERR_PARSE, "parse error");
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg) || (msg as { jsonrpc?: unknown }).jsonrpc !== "2.0" || typeof (msg as { method?: unknown }).method !== "string") {
    note({ era: "none", method: null, version: null, status: 400, error: "invalid request" });
    return rpcError(400, null, ERR_INVALID_REQUEST, "invalid request: one JSON-RPC 2.0 request or notification per POST");
  }
  const m = msg as { id?: Id; method: string; params?: Record<string, unknown> };
  const params = m.params !== null && typeof m.params === "object" && !Array.isArray(m.params) ? m.params : {};
  const id: Id = m.id ?? null;
  const isNotification = m.id === undefined;
  const meta = params["_meta"] !== null && typeof params["_meta"] === "object" ? (params["_meta"] as Record<string, unknown>) : undefined;
  const bodyVersion = typeof meta?.[VERSION_KEY] === "string" ? (meta[VERSION_KEY] as string) : undefined;
  const headerVersion = req.headers.get("mcp-protocol-version") ?? undefined;

  if (isNotification) {
    note({ era: bodyVersion !== undefined ? "modern" : "legacy", method: m.method, version: bodyVersion ?? headerVersion ?? null, status: 202 });
    return new Response(null, { status: 202 });
  }

  if (bodyVersion !== undefined) return serveModern(req, endpoint, note, m.method, params, id, bodyVersion, headerVersion);
  return serveLegacy(endpoint, note, m.method, params, id, headerVersion);
}

async function serveModern(
  req: Request,
  endpoint: McpEndpoint,
  note: (n: McpRequestNote) => void,
  method: string,
  params: Record<string, unknown>,
  id: Id,
  version: string,
  headerVersion: string | undefined,
): Promise<Response> {
  const done = (r: Response, error?: string): Response => {
    note({ era: "modern", method, version, status: r.status, ...(error !== undefined ? { error } : {}) });
    return r;
  };
  if (!MODERN_VERSIONS.includes(version)) {
    return done(rpcError(400, id, ERR_UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version }), "unsupported version");
  }
  const mismatch = (what: string): Response => done(rpcError(400, id, ERR_HEADER_MISMATCH, `Header mismatch: ${what}`), "header mismatch");
  if (headerVersion === undefined) return mismatch("MCP-Protocol-Version header is missing");
  if (headerVersion !== version) return mismatch(`MCP-Protocol-Version header value '${headerVersion}' does not match body value '${version}'`);
  const headerMethod = req.headers.get("mcp-method");
  if (headerMethod === null) return mismatch("Mcp-Method header is missing");
  if (headerMethod !== method) return mismatch(`Mcp-Method header value '${headerMethod}' does not match body value '${method}'`);
  if (method === "tools/call") {
    const raw = req.headers.get("mcp-name");
    if (raw === null) return mismatch("Mcp-Name header is missing");
    const name = decodeHeaderValue(raw);
    if (name !== String(params["name"] ?? "")) return mismatch(`Mcp-Name header value '${name}' does not match body value '${String(params["name"] ?? "")}'`);
  }
  const ok = (result: Record<string, unknown>): Response => done(json(200, { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } }));
  switch (method) {
    case "server/discover":
      return ok({
        supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": endpoint.serverInfo },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: listedTools(endpoint.list()) });
    case "tools/call": {
      const r = await endpoint.call(String(params["name"] ?? ""), params["arguments"] ?? {});
      if ("refused" in r) return done(refusal(id, r.refused), r.refused.message);
      return ok({ content: [{ type: "text", text: r.result.text }], isError: r.result.isError ?? false });
    }
    case "initialize":
      return done(rpcError(404, id, ERR_METHOD_NOT_FOUND, `method not found: initialize is the handshake of ${LEGACY_VERSIONS.join(", ")}; a request carrying ${version} needs none`), "method not found");
    default:
      return done(rpcError(404, id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`), "method not found");
  }
}

async function serveLegacy(endpoint: McpEndpoint, note: (n: McpRequestNote) => void, method: string, params: Record<string, unknown>, id: Id, headerVersion: string | undefined): Promise<Response> {
  const version = headerVersion ?? LEGACY_DEFAULT_VERSION;
  const done = (r: Response, error?: string): Response => {
    note({ era: "legacy", method, version, status: r.status, ...(error !== undefined ? { error } : {}) });
    return r;
  };
  // An initialize names the version it wants in its body; every later request in its header.
  if (method !== "initialize" && !LEGACY_VERSIONS.includes(version)) {
    return done(rpcError(400, id, ERR_UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version }), "unsupported version");
  }
  const ok = (result: unknown): Response => done(json(200, { jsonrpc: "2.0", id, result }));
  switch (method) {
    case "initialize": {
      const asked = typeof params["protocolVersion"] === "string" ? (params["protocolVersion"] as string) : undefined;
      return ok({
        protocolVersion: asked !== undefined && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: endpoint.serverInfo,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: listedTools(endpoint.list()) });
    case "tools/call": {
      const r = await endpoint.call(String(params["name"] ?? ""), params["arguments"] ?? {});
      if ("refused" in r) return done(refusal(id, r.refused), r.refused.message);
      return ok({ content: [{ type: "text", text: r.result.text }], isError: r.result.isError ?? false });
    }
    default:
      return done(rpcError(200, id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`), "method not found");
  }
}

function refusal(id: Id, r: CallRefusal): Response {
  return rpcError(r.status, id, ERR_GATEWAY, r.message, undefined, r.retryAfterS !== undefined ? { "retry-after": String(r.retryAfterS) } : {});
}
