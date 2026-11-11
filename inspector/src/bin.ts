#!/usr/bin/env bun
/**
 * wrath-inspector: read a session store, serve its API and page.
 *
 *   wrath-inspector --store <dir> [--host 127.0.0.1] [--port 8091] [--secret-file <path>] [--tiles <dir>] [--wowhead]
 *
 * `--store` is a session store (`mcp/src/main.ts`'s `--record-dir`) or one
 * session directory. Bound to loopback, the default, it needs no credential.
 * Bound to anything else it refuses to start without a bearer secret, from
 * `WRATH_INSPECTOR_SECRET` or the first line of `--secret-file`; never from
 * the command line. `--tiles` is a directory of minimap tiles,
 * `<map>/<row>_<col>.png`, for the map to draw over its grid. `--wowhead`
 * lets the page load Wowhead's tooltip script for item, spell and quest icons
 * and names, a third-party request it makes only when asked. It only ever
 * reads the store.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SECRET_ENV } from "./auth";
import { serveInspector } from "./serve";
import { storeSource } from "./store-source";

const USAGE = "usage: wrath-inspector --store <dir> [--host 127.0.0.1] [--port 8091] [--secret-file <path>] [--tiles <dir>] [--wowhead]";

/** The flags, parsed; throws with the usage on anything it does not know. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): { store: string; host: string; port: number; secret: string | undefined; tiles: string | undefined; wowhead: boolean } {
  const flags = new Map<string, string>();
  let wowhead = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") throw new Error(USAGE);
    if (a === "--wowhead") {
      wowhead = true;
      continue;
    }
    const m = /^--(store|host|port|secret-file|tiles)(?:=(.*))?$/.exec(a);
    if (m === null) throw new Error(`unknown argument ${a}\n${USAGE}`);
    const v = m[2] ?? argv[++i];
    if (v === undefined) throw new Error(`--${m[1]} needs a value\n${USAGE}`);
    flags.set(m[1]!, v);
  }
  const store = flags.get("store");
  if (store === undefined) throw new Error(USAGE);
  const port = Number(flags.get("port") ?? 8091);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
  let secret = env[SECRET_ENV];
  const file = flags.get("secret-file");
  if (file !== undefined) secret = readFileSync(file, "utf8").split("\n")[0]!.trim();
  const tiles = flags.get("tiles");
  return { store: resolve(store), host: flags.get("host") ?? "127.0.0.1", port, secret: secret !== undefined && secret.length > 0 ? secret : undefined, tiles: tiles === undefined ? undefined : resolve(tiles), wowhead };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(args.store) || !statSync(args.store).isDirectory()) throw new Error(`--store ${args.store} is not a directory`);
    const server = serveInspector({
      source: storeSource(args.store),
      host: args.host,
      port: args.port,
      ...(args.secret === undefined ? {} : { secret: args.secret }),
      ...(args.tiles === undefined ? {} : { tilesDir: args.tiles }),
      wowhead: args.wowhead,
    });
    console.log(`[wrath-inspector] ${args.store} on http://${server.hostname}:${server.port}${args.secret === undefined ? "" : " (bearer secret required)"}`);
  } catch (err) {
    console.error(`[wrath-inspector] ${(err as Error).message}`);
    process.exit(2);
  }
}
