#!/usr/bin/env bun
/**
 * wrath-inspector: read a session store, serve its API and page.
 *
 *   wrath-inspector --store <dir> [--host 127.0.0.1] [--port 8091] [--secret-file <path>] [--tiles <dir>] [--wowhead]
 *   wrath-inspector --hosted-state <dir> [--grants <file>] [same options]
 *
 * `--store` is a session store (`mcp/src/main.ts`'s `--record-dir`) or one
 * session directory. `--hosted-state` is a hosted gateway's state directory
 * instead: every credential's store under `tenants/`. With `--grants` (the
 * gateway's grants file, which it only reads) a person signs in with their
 * key and sees their own credentials' sessions, and no request is anonymous.
 * Bound to loopback, the default, and without grants, it needs no credential.
 * Bound to anything else it refuses to start without a bearer secret or
 * grants; the secret comes from `WRATH_INSPECTOR_SECRET` or the first line of
 * `--secret-file`, never from the command line. `--tiles` is a directory of minimap tiles,
 * `<map>/<row>_<col>.png`, for the map to draw over its grid. `--wowhead`
 * lets the page load Wowhead's tooltip script for item, spell and quest icons
 * and names, a third-party request it makes only when asked. It only ever
 * reads the store.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FileGrantSource, GRANTS_FILE_ENV } from "@wrathbench/mcp/hosted/grants-read";
import { SECRET_ENV } from "./auth";
import { hostedSource } from "./hosted-source";
import { serveInspector } from "./serve";
import { storeSource } from "./store-source";

const USAGE = "usage: wrath-inspector (--store <dir> | --hosted-state <dir> [--grants <file>]) [--host 127.0.0.1] [--port 8091] [--secret-file <path>] [--tiles <dir>] [--wowhead]";

export interface InspectorArgs {
  /** A session store or one session directory; or else `hostedState`. */
  store: string | undefined;
  /** A hosted gateway's state directory. */
  hostedState: string | undefined;
  /** The hosted grants file, from `--grants` or `WRATH_MCP_GRANTS_FILE`; only with `hostedState`. */
  grants: string | undefined;
  host: string;
  port: number;
  secret: string | undefined;
  tiles: string | undefined;
  wowhead: boolean;
}

/** The flags, parsed; throws with the usage on anything it does not know. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): InspectorArgs {
  const flags = new Map<string, string>();
  let wowhead = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") throw new Error(USAGE);
    if (a === "--wowhead") {
      wowhead = true;
      continue;
    }
    const m = /^--(store|hosted-state|grants|host|port|secret-file|tiles)(?:=(.*))?$/.exec(a);
    if (m === null) throw new Error(`unknown argument ${a}\n${USAGE}`);
    const v = m[2] ?? argv[++i];
    if (v === undefined) throw new Error(`--${m[1]} needs a value\n${USAGE}`);
    flags.set(m[1]!, v);
  }
  const store = flags.get("store");
  const hostedState = flags.get("hosted-state");
  if ((store === undefined) === (hostedState === undefined)) throw new Error(`one of --store and --hosted-state\n${USAGE}`);
  if (flags.has("grants") && hostedState === undefined) throw new Error(`--grants is for --hosted-state\n${USAGE}`);
  const grants = flags.get("grants") ?? (hostedState === undefined ? undefined : env[GRANTS_FILE_ENV]);
  const port = Number(flags.get("port") ?? 8091);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
  let secret = env[SECRET_ENV];
  const file = flags.get("secret-file");
  if (file !== undefined) secret = readFileSync(file, "utf8").split("\n")[0]!.trim();
  const tiles = flags.get("tiles");
  return {
    store: store === undefined ? undefined : resolve(store),
    hostedState: hostedState === undefined ? undefined : resolve(hostedState),
    grants: grants === undefined || grants.length === 0 ? undefined : resolve(grants),
    host: flags.get("host") ?? "127.0.0.1",
    port,
    secret: secret !== undefined && secret.length > 0 ? secret : undefined,
    tiles: tiles === undefined ? undefined : resolve(tiles),
    wowhead,
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dir = (args.store ?? args.hostedState)!;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${args.store !== undefined ? "--store" : "--hosted-state"} ${dir} is not a directory`);
    // The grants file is the gateway's, 0600: run as a user that may read it. Checked on every request, so a revocation applies at the next.
    const grants = args.grants === undefined ? undefined : new FileGrantSource(args.grants, { pollMs: 0, onProblem: (p) => console.error(`[wrath-inspector] grants refused, nobody signs in by key until the file stands: ${p.join("; ")}`) });
    const server = serveInspector({
      source: args.store !== undefined ? storeSource(args.store) : hostedSource(dir),
      host: args.host,
      port: args.port,
      ...(args.secret === undefined ? {} : { secret: args.secret }),
      ...(grants === undefined ? {} : { grants }),
      ...(args.tiles === undefined ? {} : { tilesDir: args.tiles }),
      wowhead: args.wowhead,
    });
    const gate = [args.secret === undefined ? null : "bearer secret", grants === undefined ? null : "grant keys"].filter((g) => g !== null);
    console.log(`[wrath-inspector] ${dir} on http://${server.hostname}:${server.port}${gate.length === 0 ? "" : ` (${gate.join(" or ")} required)`}`);
  } catch (err) {
    console.error(`[wrath-inspector] ${(err as Error).message}`);
    process.exit(2);
  }
}
