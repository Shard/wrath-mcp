/**
 * The standalone server's session handling: where the token lives, what names
 * it, and what it records. No module, no sandbox: a stub fetch stands in for
 * the module. The clean exit is the host's (`host.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordOption, resolveSession, TOKEN_FILE } from "../src/main";
import { DEFAULT_RETENTION_MS } from "../src/record/retention";
import { logoutSession, moduleIdentity, tokenFingerprint, tokenTag } from "../src/module-auth";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "wb-mcp-main-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("token fingerprints", () => {
  test("are the SHA-256 of the token's bytes: the tag 8 hex, the file stem 16, the one a prefix of the other", () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(tokenTag("abc")).toBe("tok:ba7816bf");
    expect(tokenFingerprint("abc")).toBe("ba7816bf8f01cfea");
    const token = "smoke-travel-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    expect(tokenFingerprint(token).startsWith(tokenTag(token).slice("tok:".length))).toBe(true);
  });
});

describe("resolveSession", () => {
  test("a fresh start keys the state directory by fingerprint, 0700, and keeps the token in a 0600 file there", () => {
    const tmp = scratch();
    const s = resolveSession({ tmp });
    expect(s.token).toMatch(/^[0-9a-f]{32}$/);
    expect(s.dir).toBe(join(tmp, "wrathbench-mcp", tokenFingerprint(s.token)));
    expect(s.dir).not.toContain(s.token);
    expect(mode(s.dir)).toBe(0o700);
    expect(s.tokenPath).toBe(join(s.dir, TOKEN_FILE));
    expect(readFileSync(s.tokenPath, "utf8")).toBe(`${s.token}\n`);
    expect(mode(s.tokenPath)).toBe(0o600);
  });

  test("--dir alone resumes the token it holds, and tightens modes it finds loose", () => {
    const tmp = scratch();
    const first = resolveSession({ tmp });
    writeFileSync(first.tokenPath, `${first.token}\n`, { mode: 0o644 });
    const again = resolveSession({ dir: first.dir });
    expect(again.token).toBe(first.token);
    expect(mode(again.tokenPath)).toBe(0o600);
  });

  test("--token, then --token-file, win over what the directory holds", () => {
    const tmp = scratch();
    const dir = join(tmp, "state");
    resolveSession({ dir, token: "held-token-0000000000000000000000" });
    const file = join(tmp, "elsewhere");
    writeFileSync(file, "file-token-11111111111111111111111\n");
    expect(resolveSession({ dir, tokenFile: file }).token).toBe("file-token-11111111111111111111111");
    expect(resolveSession({ dir, tokenFile: file, token: "flag-token-2222222222222222222222" }).token).toBe("flag-token-2222222222222222222222");
    expect(readFileSync(join(dir, TOKEN_FILE), "utf8")).toBe("flag-token-2222222222222222222222\n");
    writeFileSync(file, "\n");
    expect(() => resolveSession({ dir, tokenFile: file })).toThrow(/holds no token/);
  });
});

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function stubFetch(calls: Call[], fail = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url: String(input), auth: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
    if (fail) throw new Error("connection refused");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

describe("logoutSession", () => {
  test("without a port secret sends no credential and never throws", async () => {
    const calls: Call[] = [];
    await logoutSession({ moduleUrl: "http://module:8086", token: "tok-abc", env: {}, fetch: stubFetch(calls, true) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBeNull();
  });
});

describe("the session record's options", () => {
  test("on by default, in a store beside the state directory, kept three days", () => {
    expect(recordOption([], "/var/lib/wrath/state/abcd")).toEqual({ root: "/var/lib/wrath/state/sessions", retentionMs: DEFAULT_RETENTION_MS });
    expect(DEFAULT_RETENTION_MS).toBe(3 * 24 * 60 * 60_000);
  });

  test("--record-dir names the store, --record-retention-days the window, --no-record turns it off", () => {
    expect(recordOption(["--record-dir", "/srv/sessions", "--record-retention-days", "0.5"], "/x/y")).toEqual({ root: "/srv/sessions", retentionMs: 12 * 60 * 60_000 });
    expect(recordOption(["--no-record", "--record-dir", "/srv/sessions"], "/x/y")).toBeNull();
    for (const bad of ["0", "-1", "soon"]) expect(() => recordOption(["--record-retention-days", bad], "/x/y")).toThrow();
  });

  test("a store named with --record-dir is kept unless a window is given; the default one beside an explicit --dir is not", () => {
    expect(recordOption(["--record-dir", "/srv/sessions"], "/x/y")).toEqual({ root: "/srv/sessions", retentionMs: null });
    expect(recordOption(["--record-retention-days", "2"], "/x/y")).toEqual({ root: "/x/sessions", retentionMs: 2 * 24 * 60 * 60_000 });
    expect(recordOption(["--dir", "/home/pat/wrath/state"], "/home/pat/wrath/state")).toEqual({ root: "/home/pat/wrath/sessions", retentionMs: DEFAULT_RETENTION_MS });
  });

  test("the module's identity is read from /health, and a module that does not answer is null", async () => {
    const seen: string[] = [];
    const ok = (async (url: URL | string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ build: "abc123", protocol: 1, startedAtMs: 5 }));
    }) as unknown as typeof fetch;
    expect(await moduleIdentity("http://worldserver:8086", {}, ok)).toEqual({ build: "abc123", protocol: 1 });
    expect(seen).toEqual(["http://worldserver:8086/health"]);
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await moduleIdentity("http://worldserver:8086", {}, down)).toBeNull();
    const denied = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await moduleIdentity("http://worldserver:8086", {}, denied)).toBeNull();
  });
});
