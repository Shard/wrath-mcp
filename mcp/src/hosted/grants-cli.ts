#!/usr/bin/env bun
/**
 * The operator's tool for a hosted deployment's grants file (`grants.ts`).
 * Keys, accounts and grants are never managed through MCP: this, or an admin
 * API over the same file, is the only way in.
 *
 *   bun mcp/src/hosted/grants-cli.ts [--file <path>] <command>
 *
 *   list                                    every grant: credential, person, accounts, characters, key ids
 *   add <credential> --person <id> --accounts <a,b,…> [--max-characters <n>]
 *                                           a new grant and its first key
 *   key <credential>                        another key for a grant (to rotate: key, then revoke the old)
 *   revoke <key-id>                         remove a key; it authenticates nothing from the next reload
 *   disable <credential> | enable <credential>
 *                                           stop or restore every key of a grant; its accounts stay its own
 *   reserve <a,b,…>                         accounts the operator's own sessions lease on this world
 *
 * The file is `--file`, else `WRATH_MCP_GRANTS_FILE`; `add` and `reserve`
 * create it. A new key is printed once, on stdout, and kept nowhere but as
 * its hash. Every write validates the whole file first and replaces it by
 * rename, mode 0600, so a gateway reading it never sees half of one.
 */

import { existsSync } from "node:fs";
import { emptyGrantsFile, GRANTS_FILE_ENV, newKey, readGrantsFile, TENANT_MAX_CHARACTERS, writeGrantsFile, type GrantsFile, type TenantGrant } from "./grants";

export const GRANTS_USAGE = `usage: grants-cli [--file <path>] <command>
  list
  add <credential> --person <id> --accounts <a,b,…> [--max-characters <n>]
  key <credential>
  revoke <key-id>
  disable <credential>
  enable <credential>
  reserve <a,b,…>
the file is --file, else ${GRANTS_FILE_ENV}`;

export interface GrantsCliOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  random?: (n: number) => Buffer;
}

const COMMANDS = new Set(["list", "add", "key", "revoke", "disable", "enable", "reserve"]);

const accountsList = (raw: string | undefined): string[] => (raw ?? "").split(",").map((a) => a.trim()).filter((a) => a.length > 0);

/** Run one command; returns what it prints. Throws with a message on anything refused. */
export function runGrantsCommand(argv: readonly string[], o: GrantsCliOptions = {}): string {
  const env = o.env ?? process.env;
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return GRANTS_USAGE;
    const m = /^--(file|person|accounts|max-characters)(?:=(.*))?$/.exec(a);
    if (m !== null) {
      const v = m[2] ?? argv[++i];
      if (v === undefined) throw new Error(`--${m[1]} needs a value\n${GRANTS_USAGE}`);
      flags.set(m[1]!, v);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag ${a}\n${GRANTS_USAGE}`);
    } else {
      words.push(a);
    }
  }
  const path = flags.get("file") ?? env[GRANTS_FILE_ENV];
  if (path === undefined || path.length === 0) throw new Error(`no grants file: pass --file or set ${GRANTS_FILE_ENV}\n${GRANTS_USAGE}`);
  const [cmd, arg, ...rest] = words;
  if (cmd === undefined) throw new Error(GRANTS_USAGE);
  if (rest.length > 0) throw new Error(`unexpected ${rest.join(" ")}\n${GRANTS_USAGE}`);
  if (!COMMANDS.has(cmd)) throw new Error(`unknown command ${cmd}\n${GRANTS_USAGE}`);
  const creates = cmd === "add" || cmd === "reserve";
  const file: GrantsFile = existsSync(path) ? readGrantsFile(path) : creates ? emptyGrantsFile() : (() => { throw new Error(`grants file ${path} does not exist; add creates it`); })();
  const need = (what: string): string => {
    if (arg === undefined) throw new Error(`${cmd} needs a ${what}\n${GRANTS_USAGE}`);
    return arg;
  };
  const grantOf = (id: string): TenantGrant => {
    const g = file.grants.find((x) => x.id === id);
    if (g === undefined) throw new Error(`no grant ${id}`);
    return g;
  };
  const keyLines = (key: string, g: TenantGrant, keyId: string): string =>
    [`key ${keyId} for ${g.id} (${g.person}), shown once:`, key].join("\n");

  switch (cmd) {
    case "list": {
      if (arg !== undefined) throw new Error(GRANTS_USAGE);
      const lines = file.grants.map((g) =>
        `${g.id}\tperson=${g.person}\taccounts=${g.accounts.join(",")}\tmaxCharacters=${g.maxCharacters}\tkeys=${g.keyHashes.map((k) => k.id).join(",") || "-"}${g.disabled === true ? "\tdisabled" : ""}${g.limits !== undefined ? `\tlimits=${JSON.stringify(g.limits)}` : ""}`,
      );
      if (file.reservedAccounts.length > 0) lines.push(`reserved\taccounts=${file.reservedAccounts.join(",")}`);
      return lines.length > 0 ? lines.join("\n") : "no grants";
    }
    case "add": {
      const id = need("credential id");
      if (file.grants.some((g) => g.id === id)) throw new Error(`grant ${id} exists; key ${id} adds a key to it`);
      const person = flags.get("person");
      if (person === undefined) throw new Error(`add needs --person\n${GRANTS_USAGE}`);
      const accounts = accountsList(flags.get("accounts"));
      if (accounts.length === 0) throw new Error(`add needs --accounts <a,b,…>\n${GRANTS_USAGE}`);
      const rawN = flags.get("max-characters") ?? "1";
      const n = Number(rawN);
      if (!/^\d+$/.test(rawN) || n < 1 || n > TENANT_MAX_CHARACTERS) throw new Error(`--max-characters must be a whole number from 1 to ${TENANT_MAX_CHARACTERS}`);
      const { key, hash } = newKey(o);
      const g: TenantGrant = { id, person, keyHashes: [hash], accounts, maxCharacters: n };
      writeGrantsFile(path, { ...file, grants: [...file.grants, g] });
      return keyLines(key, g, hash.id);
    }
    case "key": {
      const g = grantOf(need("credential id"));
      const { key, hash } = newKey(o);
      const next = { ...g, keyHashes: [...g.keyHashes, hash] };
      writeGrantsFile(path, { ...file, grants: file.grants.map((x) => (x === g ? next : x)) });
      return keyLines(key, next, hash.id);
    }
    case "revoke": {
      const keyId = need("key id");
      const g = file.grants.find((x) => x.keyHashes.some((k) => k.id === keyId));
      if (g === undefined) throw new Error(`no key ${keyId}`);
      const next = { ...g, keyHashes: g.keyHashes.filter((k) => k.id !== keyId) };
      writeGrantsFile(path, { ...file, grants: file.grants.map((x) => (x === g ? next : x)) });
      return `revoked key ${keyId} of ${g.id}; ${next.keyHashes.length} ${next.keyHashes.length === 1 ? "key remains" : "keys remain"}`;
    }
    case "disable":
    case "enable": {
      const g = grantOf(need("credential id"));
      const { disabled: _, ...rest } = g;
      const next: TenantGrant = cmd === "disable" ? { ...rest, disabled: true } : rest;
      writeGrantsFile(path, { ...file, grants: file.grants.map((x) => (x === g ? next : x)) });
      return `${g.id} ${cmd}d`;
    }
    case "reserve": {
      const accounts = accountsList(need("account list"));
      const have = new Set(file.reservedAccounts.map((a) => a.toUpperCase()));
      const added = accounts.filter((a) => !have.has(a.toUpperCase()));
      writeGrantsFile(path, { ...file, reservedAccounts: [...file.reservedAccounts, ...added] });
      return `reserved ${added.length > 0 ? added.join(",") : "nothing new"}`;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${GRANTS_USAGE}`);
  }
}

if (import.meta.main) {
  try {
    console.log(runGrantsCommand(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
