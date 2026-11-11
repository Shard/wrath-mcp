/**
 * The inspector as a process: the API (`api.ts`) at `/api` over a source, a
 * sign-in for a browser off loopback, minimap tiles when it was given a
 * directory of them, and the built page. What the bin
 * (`bin.ts`) starts; a harness that embeds the inspector mounts
 * `createInspectorApi` in its own server instead and needs none of this.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
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
  /**
   * Minimap tiles, `<dir>/<map>/<row>_<col>.png`, served at the same path under
   * `/tiles/`. Without one the map draws its grid.
   */
  tilesDir?: string;
  /**
   * Let the page load Wowhead's tooltip script for item, spell and quest
   * icons and names, a third-party request from the reader's browser. Off
   * unless asked for.
   */
  wowhead?: boolean;
}

/** The page's marker that the bin was started with `--wowhead`; `page/main.tsx` reads it. */
export const WOWHEAD_META = '<meta name="wrath-inspector-wowhead" content="on" />';

/** The built page's `index.html`, marked when the bin lets it load Wowhead's script. */
function pageHtml(pageDir: string, wowhead: boolean): Response {
  const file = join(pageDir, "index.html");
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
  if (!wowhead) return new Response(Bun.file(file), { headers });
  return new Response(readFileSync(file, "utf8").replace("</head>", `  ${WOWHEAD_META}\n  </head>`), { headers });
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
  const scope = bearerScope(o.secret);
  const api = createInspectorApi(o.source, { base: "/api", scope });
  const tilesDir = o.tilesDir === undefined ? undefined : resolve(o.tilesDir);
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

    // A tile is a whole file named by three integers, so nothing a request says reaches outside the directory.
    const tile = /^\/tiles\/(\d{1,4})\/(\d{1,2})_(\d{1,2})\.png$/.exec(url.pathname);
    if (tile !== null || url.pathname.startsWith("/tiles/")) {
      if (scope(req) === null) return new Response("a bearer credential is required", { status: 401 });
      if (tile === null || tilesDir === undefined) return new Response("no such tile", { status: 404 });
      const file = join(tilesDir, String(Number(tile[1])), `${Number(tile[2])}_${Number(tile[3])}.png`);
      if (!existsSync(file)) return new Response("no such tile", { status: 404 });
      return new Response(Bun.file(file), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405, headers: { allow: "GET, HEAD" } });

    if (!existsSync(join(pageDir, "index.html"))) return new Response(NOT_BUILT, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    const path = decodeURIComponent(url.pathname);
    const hit = path === "/" || path === "/index.html" ? null : staticFile(pageDir, path);
    if (hit !== null) return hit;
    // Client-side routing: anything that is not a file is the page.
    return pageHtml(pageDir, o.wowhead === true);
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
