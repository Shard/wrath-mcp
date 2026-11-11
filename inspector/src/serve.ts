/**
 * The inspector as a process: the API (`api.ts`) at `/api` over a source, a
 * sign-in for a browser off loopback, and the built page. What the bin
 * (`bin.ts`) starts; a harness that embeds the inspector mounts
 * `createInspectorApi` in its own server instead and needs none of this.
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { createInspectorApi } from "./api";
import { SESSION_COOKIE, bearerScope, bindRefusal, isLoopbackHost, isSecret } from "./auth";
import type { SessionSource } from "./source";

/** Where the page is built to, beside this package's sources. */
export const PAGE_DIR = resolve(import.meta.dir, "..", "dist");

export interface InspectorServerOptions {
  source: SessionSource;
  host?: string;
  port?: number;
  /** The bearer secret; required unless `host` is loopback. */
  secret?: string;
  /** The built page; defaults to `PAGE_DIR`. */
  pageDir?: string;
}

const NOT_BUILT = "The inspector's page is not built: run `bun run --cwd inspector build`. The API answers under /api.\n";

function staticFile(root: string, path: string): Response | null {
  const target = normalize(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const immutable = path.startsWith("/assets/");
  return new Response(Bun.file(target), { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
}

/** The request handler, without a socket: what `serveInspector` binds, and what a test calls. */
export function inspectorHandler(o: Omit<InspectorServerOptions, "port">): (req: Request) => Promise<Response> {
  const secure = o.host !== undefined && !isLoopbackHost(o.host);
  const api = createInspectorApi(o.source, { base: "/api", scope: bearerScope(o.secret) });
  const pageDir = resolve(o.pageDir ?? PAGE_DIR);

  return async (req) => {
    const url = new URL(req.url);

    /*
     * The page's sign-in: the secret in a JSON body, answered with an
     * HttpOnly cookie that carries it, because a browser's EventSource sends
     * cookies and no header. JSON only, so a form on another site cannot post
     * it without a preflight this server never grants.
     */
    if (url.pathname === "/api/sign-in") {
      if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
      if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return new Response("JSON only", { status: 415 });
      let candidate: unknown;
      try {
        candidate = ((await req.json()) as { secret?: unknown }).secret;
      } catch {
        return new Response("bad body", { status: 400 });
      }
      if (o.secret === undefined || o.secret.length === 0) return new Response(null, { status: 204 });
      if (typeof candidate !== "string" || !isSecret(o.secret, candidate)) return new Response("refused", { status: 401 });
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(o.secret)}; HttpOnly; SameSite=Strict; Path=/${secure && url.protocol === "https:" ? "; Secure" : ""}`;
      return new Response(null, { status: 204, headers: { "set-cookie": cookie } });
    }

    const answered = await api(req);
    if (answered !== null) return answered;
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return Response.json({ error: "no such path" }, { status: 404 });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405, headers: { allow: "GET, HEAD" } });

    if (!existsSync(join(pageDir, "index.html"))) return new Response(NOT_BUILT, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    const hit = url.pathname === "/" ? null : staticFile(pageDir, decodeURIComponent(url.pathname));
    if (hit !== null) return hit;
    // Client-side routing: anything that is not a file is the page.
    return new Response(Bun.file(join(pageDir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  };
}

/** Start the inspector. Throws, binding nothing, when the bind needs a secret it was not given. */
export function serveInspector(o: InspectorServerOptions): ReturnType<typeof Bun.serve> {
  const host = o.host ?? "127.0.0.1";
  const refusal = bindRefusal(host, o.secret);
  if (refusal !== null) throw new Error(refusal);
  const handler = inspectorHandler({ ...o, host });
  // An SSE tail stays open; the idle timeout must not cut it between frames.
  return Bun.serve({ hostname: host, port: o.port ?? 8091, idleTimeout: 0, fetch: handler });
}
