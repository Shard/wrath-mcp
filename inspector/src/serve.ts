/**
 * The inspector as a process: the API (`api.ts`) at `/api` over a source, a
 * sign-in for a browser off loopback, minimap tiles when it was given a
 * directory of them, and the built page. What the bin
 * (`bin.ts`) starts; a harness that embeds the inspector mounts
 * `createInspectorApi` in its own server instead and needs none of this.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { GrantSet, GrantSource } from "@wrathbench/mcp/hosted/grants-read";
import { createInspectorApi } from "./api";
import { bindRefusal, inspectorAuth, isLoopbackHost } from "./auth";
import type { SessionSource } from "./source";
import type { MeResponse } from "./wire";

/** Where the page is built to, beside this package's sources. */
export const PAGE_DIR = resolve(import.meta.dir, "..", "dist");

export interface InspectorServerOptions {
  source: SessionSource;
  host?: string;
  port?: number;
  /** The operator's bearer secret; required unless `host` is loopback or there are grants. */
  secret?: string;
  /**
   * The hosted grants (`@wrathbench/mcp/hosted/grants-read`): a person signs
   * in with their key and sees their credentials' sessions. Given grants, no
   * request is anonymous, on loopback too.
   */
  grants?: GrantSource & { fresh?(): GrantSet };
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
  // Secure over TLS, and off loopback, where a proxy in front may be what speaks TLS.
  const offLoopback = o.host !== undefined && !isLoopbackHost(o.host);
  const auth = inspectorAuth({
    ...(o.secret === undefined ? {} : { secret: o.secret }),
    ...(o.grants === undefined ? {} : { grants: o.grants }),
    secureCookie: (url) => offLoopback || url.protocol === "https:",
  });
  const scope = auth.scope;
  const api = createInspectorApi(o.source, { base: "/api", scope });
  const tilesDir = o.tilesDir === undefined ? undefined : resolve(o.tilesDir);
  const pageDir = resolve(o.pageDir ?? PAGE_DIR);

  return async (req) => {
    const url = new URL(req.url);

    /*
     * The page's sign-in and sign-out (`auth.ts`): a credential in, an opaque
     * HttpOnly cookie out, because a browser's EventSource sends cookies and
     * no header. `me` is who the page is signed in as.
     */
    if (url.pathname === "/api/sign-in") return auth.signIn(req);
    if (url.pathname === "/api/sign-out") return auth.signOut(req);
    if (url.pathname === "/api/me") {
      const who = auth.caller(req);
      if (who === null) return Response.json({ error: "a bearer credential is required" }, { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } });
      const body: MeResponse = who.scope.kind === "operator" ? { kind: "operator", signedIn: who.signedIn } : { kind: "user", person: who.scope.person, credentials: [...who.scope.credentials].sort(), signedIn: who.signedIn };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
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
  const refusal = bindRefusal(host, o.secret, { grants: o.grants !== undefined });
  if (refusal !== null) throw new Error(refusal);
  const handler = inspectorHandler({ ...o, host });
  // An SSE tail stays open; the idle timeout must not cut it between frames.
  return Bun.serve({ hostname: host, port: o.port ?? 8091, idleTimeout: 0, fetch: handler });
}
