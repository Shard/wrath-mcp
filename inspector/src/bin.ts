#!/usr/bin/env bun
/**
 * wrath-inspector: read a session store, serve its API and page.
 *
 *   wrath-inspector --store <dir> [--host 127.0.0.1] [--port 8091] [--secret-file <path>]
 *
 * `--store` is a session store (`mcp/src/main.ts`'s `--record-dir`) or one
 * session directory. Bound to loopback, the default, it needs no credential.
 * Bound to anything else it refuses to start without a bearer secret, from
 * `WRATH_INSPECTOR_SECRET` or the first line of `--secret-file`; never from
 * the command line. It only ever reads the store.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SECRET_ENV } from "./auth";
import { serveInspector } from "./serve";
import { storeSource } from "./store-source";

const USAGE = "usage: wrath-inspector --store <dir> [--host 127.0.0.1] [--port 8091] [--secret-file <path>]";

/** The flags, parsed; throws with the usage on anything it does not know. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): { store: string; host: string; port: number; secret: string | undefined } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") throw new Error(USAGE);
    const m = /^--(store|host|port|secret-file)(?:=(.*))?$/.exec(a);
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
  return { store: resolve(store), host: flags.get("host") ?? "127.0.0.1", port, secret: secret !== undefined && secret.length > 0 ? secret : undefined };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(args.store) || !statSync(args.store).isDirectory()) throw new Error(`--store ${args.store} is not a directory`);
    const server = serveInspector({ source: storeSource(args.store), host: args.host, port: args.port, ...(args.secret === undefined ? {} : { secret: args.secret }) });
    console.log(`[wrath-inspector] ${args.store} on http://${server.hostname}:${server.port}${args.secret === undefined ? "" : " (bearer secret required)"}`);
  } catch (err) {
    console.error(`[wrath-inspector] ${(err as Error).message}`);
    process.exit(2);
  }
}
