import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  bearerKey,
  DEFAULT_LIMITS,
  effectiveLimits,
  emptyGrantsFile,
  FileGrantSource,
  GrantSet,
  keyDigest,
  KEY_PREFIX,
  newKey,
  parseGrantsFile,
  readGrantsFile,
  toFanoutGrant,
  writeGrantsFile,
  type GrantsFile,
  type TenantGrant,
} from "../src/hosted/grants";
import { runGrantsCommand } from "../src/hosted/grants-cli";

const KEY_A = `${KEY_PREFIX}alpha-key`;
const KEY_B = `${KEY_PREFIX}beta-key`;

function grant(over: Partial<TenantGrant> & { id: string }): TenantGrant {
  return { person: "pat", keyHashes: [], accounts: ["T_" + over.id.toUpperCase()], maxCharacters: 1, ...over };
}

function fileOf(...grants: TenantGrant[]): GrantsFile {
  return { ...emptyGrantsFile(), grants };
}

const req = (authorization?: string) => ({ headers: new Headers(authorization === undefined ? {} : { authorization }) });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wm-grants-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseGrantsFile", () => {
  test("a well-formed file stands, with its defaults filled in", () => {
    const r = parseGrantsFile({ version: 1, grants: [grant({ id: "a", keyHashes: [{ id: "k1aa", sha256: keyDigest(KEY_A) }] })] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.reservedAccounts).toEqual([]);
      expect(r.file.globalMaxCharacters).toBe(50);
    }
  });

  test("a grant that names allowGm is refused, even false", () => {
    for (const allowGm of [true, false]) {
      const r = parseGrantsFile({ version: 1, grants: [{ ...grant({ id: "a" }), allowGm }] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.join("\n")).toContain("never carries allowGm");
    }
  });

  test("an unknown key anywhere is refused rather than dropped", () => {
    expect(parseGrantsFile({ version: 1, grants: [{ ...grant({ id: "a" }), extra: 1 }] }).ok).toBe(false);
    expect(parseGrantsFile({ version: 1, grants: [], extra: 1 }).ok).toBe(false);
  });

  test("an account in two grants is refused, case-insensitively, the same person's included", () => {
    const r = parseGrantsFile(fileOf(grant({ id: "a", accounts: ["T_ONE"] }), grant({ id: "b", accounts: ["t_one"] })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toContain("account t_one is also in grant a");
  });

  test("an account the operator reserved is refused", () => {
    const r = parseGrantsFile({ ...fileOf(grant({ id: "a", accounts: ["RUNNER1"] })), reservedAccounts: ["runner1"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toContain("the operator's reserved accounts");
  });

  test("a grant needs at least one account, and as many as its characters", () => {
    expect(parseGrantsFile(fileOf(grant({ id: "a", accounts: [] }))).ok).toBe(false);
    const r = parseGrantsFile(fileOf(grant({ id: "a", accounts: ["T_1", "T_2"], maxCharacters: 3 })));
    expect(r.ok).toBe(false);
    expect(parseGrantsFile(fileOf(grant({ id: "a", accounts: ["T_1", "T_2"], maxCharacters: 2 }))).ok).toBe(true);
  });

  test("a grant's account listed twice is refused", () => {
    const r = parseGrantsFile(fileOf(grant({ id: "a", accounts: ["T_1", "t_1"] })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toContain("listed twice");
  });

  test("characters at once are at most five", () => {
    const accounts = ["A1", "A2", "A3", "A4", "A5", "A6"];
    expect(parseGrantsFile(fileOf(grant({ id: "a", accounts, maxCharacters: 5 }))).ok).toBe(true);
    expect(parseGrantsFile(fileOf(grant({ id: "a", accounts, maxCharacters: 6 }))).ok).toBe(false);
  });

  test("ids and persons are single safe path segments", () => {
    for (const bad of ["..", "a/b", ".hidden", "Upper", "", "-lead"]) {
      expect(parseGrantsFile(fileOf(grant({ id: bad }))).ok).toBe(false);
      expect(parseGrantsFile(fileOf(grant({ id: "a", person: bad }))).ok).toBe(false);
    }
  });

  test("duplicate grant ids, key ids and key hashes are refused", () => {
    const h = { id: "k1aa", sha256: keyDigest(KEY_A) };
    expect(parseGrantsFile(fileOf(grant({ id: "a" }), grant({ id: "a", accounts: ["OTHER"] }))).ok).toBe(false);
    expect(parseGrantsFile(fileOf(grant({ id: "a", keyHashes: [h] }), grant({ id: "b", keyHashes: [{ ...h, sha256: keyDigest(KEY_B) }] }))).ok).toBe(false);
    expect(parseGrantsFile(fileOf(grant({ id: "a", keyHashes: [h] }), grant({ id: "b", keyHashes: [{ ...h, id: "k2bb" }] }))).ok).toBe(false);
  });

  test("a grant's limits above the file's ceiling are refused", () => {
    const f = { ...fileOf(grant({ id: "a", limits: { inFlight: 8 } })), ceiling: { inFlight: 6 } };
    const r = parseGrantsFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toContain("limits.inFlight 8 is above the ceiling, 6");
  });
});

describe("limits and leases", () => {
  test("defaults, lowered to the ceiling, then the grant's own", () => {
    expect(effectiveLimits(grant({ id: "a" }), {})).toEqual({ ...DEFAULT_LIMITS });
    expect(effectiveLimits(grant({ id: "a" }), { ceiling: { burst: 10 } }).burst).toBe(10);
    expect(effectiveLimits(grant({ id: "a", limits: { idleMinutes: 120 } }), {}).idleMinutes).toBe(120);
  });

  test("the fan-out grant a hosted grant leases with never carries the GM opt-in", () => {
    const g = grant({ id: "a", accounts: ["T_1", "T_2"], maxCharacters: 2 });
    expect(toFanoutGrant(g)).toEqual({ maxCharacters: 2, accounts: ["T_1", "T_2"] });
    expect("allowGm" in toFanoutGrant(g)).toBe(false);
  });
});

describe("authenticate", () => {
  const set = new GrantSet(
    fileOf(
      grant({ id: "a", person: "pat", keyHashes: [{ id: "k1aa", sha256: keyDigest(KEY_A) }] }),
      grant({ id: "b", person: "sam", keyHashes: [{ id: "k2bb", sha256: keyDigest(KEY_B) }], disabled: true }),
    ),
  );
  const source = { current: () => set, close: () => {} };

  test("a key resolves to its person, grant, key id and limits", () => {
    const r = authenticate(req(`Bearer ${KEY_A}`), source);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.person).toBe("pat");
      expect(r.grant.id).toBe("a");
      expect(r.keyId).toBe("k1aa");
      expect(r.limits).toEqual({ ...DEFAULT_LIMITS });
    }
  });

  test("no header, another scheme, or an unknown key is nobody", () => {
    expect(authenticate(req(), source)).toEqual({ ok: false, reason: "no_key" });
    expect(authenticate(req(`Basic ${KEY_A}`), source)).toEqual({ ok: false, reason: "no_key" });
    expect(authenticate(req("Bearer"), source)).toEqual({ ok: false, reason: "no_key" });
    expect(authenticate(req(`Bearer ${KEY_A}x`), source)).toEqual({ ok: false, reason: "unknown_key" });
  });

  test("a disabled grant's key is refused and named", () => {
    expect(authenticate(req(`Bearer ${KEY_B}`), source)).toEqual({ ok: false, reason: "disabled", keyId: "k2bb", person: "sam" });
  });

  test("the key is read from the Authorization header alone", () => {
    expect(bearerKey(new Headers({ "x-api-key": KEY_A }))).toBeNull();
    expect(bearerKey(new Headers({ authorization: `bearer  ${KEY_A} ` }))).toBe(KEY_A);
  });

  test("a refused set grants nothing", () => {
    expect(GrantSet.refused(["broken"]).authenticateKey(KEY_A)).toEqual({ ok: false, reason: "unknown_key" });
  });
});

describe("keys", () => {
  test("a key is 32 random bytes behind its prefix, stored only as its hash", () => {
    const { key, hash } = newKey({ now: new Date("2026-01-02T03:04:05Z") });
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(Buffer.from(key.slice(KEY_PREFIX.length), "base64url").length).toBe(32);
    expect(hash.sha256).toBe(keyDigest(key));
    expect(hash.id).toMatch(/^[0-9a-f]{12}$/);
    expect(hash.created).toBe("2026-01-02T03:04:05.000Z");
    expect(JSON.stringify(hash)).not.toContain(key.slice(KEY_PREFIX.length));
  });
});

describe("the file", () => {
  test("is written 0600 by rename, and refused when it would not stand", () => {
    const path = join(dir, "sub", "grants.json");
    writeGrantsFile(path, fileOf(grant({ id: "a" })));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    expect(readGrantsFile(path).grants.map((g) => g.id)).toEqual(["a"]);
    expect(() => writeGrantsFile(path, fileOf(grant({ id: "a", accounts: ["X"] }), grant({ id: "b", accounts: ["X"] })))).toThrow("account X is also in grant a");
    expect(readGrantsFile(path).grants.map((g) => g.id)).toEqual(["a"]);
  });

  test("a source reloads on change and fails closed on a broken file", () => {
    const path = join(dir, "grants.json");
    writeGrantsFile(path, fileOf(grant({ id: "a", keyHashes: [{ id: "k1aa", sha256: keyDigest(KEY_A) }] })));
    const problems: string[][] = [];
    const src = new FileGrantSource(path, { pollMs: 0, onProblem: (p) => problems.push([...p]) });
    try {
      expect(authenticate(req(`Bearer ${KEY_A}`), src).ok).toBe(true);
      // A hand edit that breaks the file: the key it was meant to revoke must not keep working.
      writeFileSync(path, "{ not json");
      src.reload();
      expect(authenticate(req(`Bearer ${KEY_A}`), src).ok).toBe(false);
      expect(problems).toHaveLength(1);
      expect(src.current().problems[0]).toContain("does not read");
      // Fixed: the source grants again.
      writeGrantsFile(path, fileOf(grant({ id: "a", keyHashes: [{ id: "k2bb", sha256: keyDigest(KEY_B) }] })));
      src.reload();
      expect(authenticate(req(`Bearer ${KEY_A}`), src).ok).toBe(false);
      expect(authenticate(req(`Bearer ${KEY_B}`), src).ok).toBe(true);
    } finally {
      src.close();
    }
  });

  test("a source notices a file renamed into place", async () => {
    const path = join(dir, "grants.json");
    writeGrantsFile(path, fileOf(grant({ id: "a" })));
    const src = new FileGrantSource(path, { pollMs: 10 });
    try {
      const other = join(dir, "next.json");
      writeGrantsFile(other, fileOf(grant({ id: "a", keyHashes: [{ id: "k1aa", sha256: keyDigest(KEY_A) }] })));
      renameSync(other, path);
      const until = Date.now() + 2_000;
      while (!authenticate(req(`Bearer ${KEY_A}`), src).ok && Date.now() < until) await Bun.sleep(10);
      expect(authenticate(req(`Bearer ${KEY_A}`), src).ok).toBe(true);
    } finally {
      src.close();
    }
  });

  test("a source does not start on a file that does not stand", () => {
    const path = join(dir, "grants.json");
    writeFileSync(path, JSON.stringify({ version: 1, grants: [{ ...grant({ id: "a" }), allowGm: true }] }));
    expect(() => new FileGrantSource(path, { pollMs: 0 })).toThrow("never carries allowGm");
    expect(() => new FileGrantSource(join(dir, "missing.json"), { pollMs: 0 })).toThrow("does not read");
  });
});

describe("the CLI", () => {
  let seq = 0;
  const random = (n: number): Buffer => Buffer.alloc(n, ++seq);
  const run = (...argv: string[]) => runGrantsCommand(["--file", join(dir, "grants.json"), ...argv], { env: {}, random, now: new Date("2026-01-02T00:00:00Z") });

  test("add makes the file and prints a key once, which then authenticates", () => {
    const out = run("add", "pat-1", "--person", "pat", "--accounts", "T_1,T_2", "--max-characters", "2");
    const key = out.split("\n")[1]!;
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(readFileSync(join(dir, "grants.json"), "utf8")).not.toContain(key);
    const src = new FileGrantSource(join(dir, "grants.json"), { pollMs: 0 });
    try {
      const r = authenticate(req(`Bearer ${key}`), src);
      expect(r.ok && r.grant.id).toBe("pat-1");
    } finally {
      src.close();
    }
    expect(run("list")).toContain("pat-1\tperson=pat\taccounts=T_1,T_2\tmaxCharacters=2\tkeys=");
  });

  test("key, revoke, disable and enable", () => {
    const first = run("add", "pat-1", "--person", "pat", "--accounts", "T_1").split("\n")[0]!;
    const firstId = /^key (\S+)/.exec(first)![1]!;
    const second = run("key", "pat-1").split("\n")[1]!;
    expect(run("revoke", firstId)).toBe(`revoked key ${firstId} of pat-1; 1 key remains`);
    const set = new GrantSet(readGrantsFile(join(dir, "grants.json")));
    expect(set.authenticateKey(second).ok).toBe(true);
    run("disable", "pat-1");
    expect(new GrantSet(readGrantsFile(join(dir, "grants.json"))).authenticateKey(second).ok).toBe(false);
    run("enable", "pat-1");
    expect(new GrantSet(readGrantsFile(join(dir, "grants.json"))).authenticateKey(second).ok).toBe(true);
  });

  test("refuses an overlapping account, a reserved one, and a sixth character", () => {
    run("reserve", "RUNNER1,RUNNER2");
    run("add", "pat-1", "--person", "pat", "--accounts", "T_1");
    expect(() => run("add", "sam-1", "--person", "sam", "--accounts", "t_1")).toThrow("account t_1 is also in grant pat-1");
    expect(() => run("add", "sam-1", "--person", "sam", "--accounts", "runner2")).toThrow("reserved");
    expect(() => run("add", "sam-1", "--person", "sam", "--accounts", "A,B,C,D,E,F", "--max-characters", "6")).toThrow("from 1 to 5");
    expect(run("list")).toContain("reserved\taccounts=RUNNER1,RUNNER2");
  });

  test("needs a file, and refuses what it does not know", () => {
    expect(() => runGrantsCommand(["list"], { env: {} })).toThrow("no grants file");
    expect(() => run("list")).toThrow("does not exist");
    expect(() => run("add", "x", "--person", "p", "--accounts", "A", "--allow-gm")).toThrow("unknown flag --allow-gm");
    expect(() => run("frobnicate")).toThrow("unknown command");
  });
});
