/**
 * When the inspector may start, and the bin's flags: loopback needs nothing,
 * every other bind needs a bearer secret, and the secret never comes from
 * the command line.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindRefusal, inspectorHandler, isLoopbackHost, serveInspector, storeSource } from "../src/index";
import { inspectorAuth, MAX_SIGN_INS_PER_CREDENTIAL, MIN_SECRET_LENGTH, SIGN_IN_BODY_MAX, SIGN_IN_FAILURES } from "../src/auth";
import { contentSecurityPolicy } from "../src/serve";
import { parseArgs } from "../src/bin";
import { tempDir } from "./fixtures";

const tmp = tempDir();
const SECRET = "an-inspector-secret-of-at-least-32-characters";

describe("binds", () => {
  test("loopback is localhost, 127.0.0.0/8 and ::1; the wildcard addresses are not", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "[::]", "10.0.0.5", "192.168.1.2", "example.org", "127.0.0.256", "128.0.0.1"]) expect(isLoopbackHost(h)).toBe(false);
  });

  test("anything but loopback refuses to start without a secret, or with a short one", () => {
    expect(bindRefusal("127.0.0.1", undefined)).toBeNull();
    expect(bindRefusal("0.0.0.0", undefined)).toContain("bearer secret");
    expect(bindRefusal("::", undefined)).toContain("bearer secret");
    expect(bindRefusal("0.0.0.0", "short")).toContain("at least");
    expect(bindRefusal("0.0.0.0", SECRET)).toBeNull();
    expect(() => serveInspector({ source: storeSource(tmp), host: "0.0.0.0", port: 0 })).toThrow("bearer secret");
    expect(() => serveInspector({ source: storeSource(tmp), host: "::", port: 0 })).toThrow("bearer secret");
  });

  test("with grants every request needs a credential, so the secret is optional on any bind, and a short one still refused", () => {
    expect(bindRefusal("0.0.0.0", undefined, { grants: true })).toBeNull();
    expect(bindRefusal("127.0.0.1", "short", { grants: true })).toContain("at least");
    expect(bindRefusal("127.0.0.1", "short")).toBeNull();
  });

  test("on loopback it serves", async () => {
    const server = serveInspector({ source: storeSource(tmp), port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sessions: [] });
    } finally {
      server.stop(true);
    }
  });
});

describe("flags", () => {
  test("the store is required; host and port default to loopback and 8091", () => {
    expect(() => parseArgs([], {})).toThrow("usage");
    expect(parseArgs(["--store", tmp], {})).toEqual({ store: tmp, hostedState: undefined, grants: undefined, host: "127.0.0.1", port: 8091, secret: undefined, tiles: undefined, wowhead: false, allowAnonymous: false, secureCookie: false });
    expect(parseArgs(["--store", tmp, "--wowhead"], {}).wowhead).toBe(true);
    expect(() => parseArgs(["--store", tmp, "--wowhead=yes"], {})).toThrow("unknown argument");
    expect(parseArgs([`--store=${tmp}`, "--host", "0.0.0.0", "--port=9000"], {}).port).toBe(9000);
    expect(() => parseArgs(["--store", tmp, "--secret", SECRET], {})).toThrow("unknown argument");
  });

  test("exactly one of --store and --hosted-state; --grants only with the latter, from the flag or the gateway's variable", () => {
    expect(() => parseArgs(["--store", tmp, "--hosted-state", tmp], {})).toThrow("one of --store and --hosted-state");
    expect(() => parseArgs(["--grants", join(tmp, "g.json")], {})).toThrow("one of --store and --hosted-state");
    expect(() => parseArgs(["--store", tmp, "--grants", join(tmp, "g.json")], {})).toThrow("--grants is for --hosted-state");
    const hosted = parseArgs(["--hosted-state", tmp, "--grants", join(tmp, "g.json")], {});
    expect([hosted.store, hosted.hostedState, hosted.grants]).toEqual([undefined, tmp, join(tmp, "g.json")]);
    expect(parseArgs(["--hosted-state", tmp], { WRATH_MCP_GRANTS_FILE: join(tmp, "e.json") }).grants).toBe(join(tmp, "e.json"));
    expect(parseArgs(["--store", tmp], { WRATH_MCP_GRANTS_FILE: join(tmp, "e.json") }).grants).toBeUndefined();
  });

  test("the secret comes from the environment or a file", () => {
    expect(parseArgs(["--store", tmp], { WRATH_INSPECTOR_SECRET: SECRET }).secret).toBe(SECRET);
    const file = join(tmp, "secret");
    writeFileSync(file, `${SECRET}\n`);
    expect(parseArgs(["--store", tmp, "--secret-file", file], {}).secret).toBe(SECRET);
  });
});

describe("hardening", () => {
  test("the secret floor is 32 characters, the module's own", () => {
    expect(MIN_SECRET_LENGTH).toBe(32);
    expect(bindRefusal("0.0.0.0", "x".repeat(31))).toContain("at least 32");
    expect(bindRefusal("0.0.0.0", "x".repeat(32))).toBeNull();
  });

  test("a hosted state needs grants or a secret on loopback too, unless told to serve it to anyone", () => {
    expect(bindRefusal("127.0.0.1", undefined, { hosted: true })).toContain("--allow-anonymous");
    expect(bindRefusal("127.0.0.1", undefined, { hosted: true, allowAnonymous: true })).toBeNull();
    expect(bindRefusal("127.0.0.1", undefined, { hosted: true, grants: true })).toBeNull();
    expect(bindRefusal("127.0.0.1", SECRET, { hosted: true })).toBeNull();
    expect(bindRefusal("127.0.0.1", "short", { hosted: true })).toContain("at least");
    // A plain store on loopback is unchanged.
    expect(bindRefusal("127.0.0.1", undefined)).toBeNull();
    expect(() => serveInspector({ source: storeSource(tmp), port: 0, hosted: true })).toThrow("--allow-anonymous");
    const server = serveInspector({ source: storeSource(tmp), port: 0, hosted: true, allowAnonymous: true });
    server.stop(true);
  });

  test("the flags: --allow-anonymous only with --hosted-state; --secure-cookie", () => {
    expect(parseArgs(["--hosted-state", tmp, "--allow-anonymous"], {}).allowAnonymous).toBe(true);
    expect(() => parseArgs(["--store", tmp, "--allow-anonymous"], {})).toThrow("--allow-anonymous is for --hosted-state");
    expect(parseArgs(["--store", tmp, "--secure-cookie"], {}).secureCookie).toBe(true);
  });

  test("--secure-cookie marks the cookie Secure behind a TLS proxy on loopback", async () => {
    const signIn = (secureCookie: boolean): Promise<Response> =>
      inspectorHandler({ source: storeSource(tmp), host: "127.0.0.1", secret: SECRET, secureCookie })(new Request("http://127.0.0.1/api/sign-in", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect((await signIn(false)).headers.get("set-cookie")).not.toContain("Secure");
    expect((await signIn(true)).headers.get("set-cookie")).toContain("; Secure");
  });

  test("a sign-in body past its cap is refused before it is parsed", async () => {
    const auth = inspectorAuth({ secret: SECRET });
    const big = JSON.stringify({ secret: "x".repeat(SIGN_IN_BODY_MAX) });
    const res = await auth.signIn(new Request("http://x/api/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: big }), "10.0.0.1");
    expect(res.status).toBe(413);
  });

  test("an address that keeps failing is throttled, others are not; the right credential waits too", async () => {
    let t = 1_000_000;
    const auth = inspectorAuth({ secret: SECRET, now: () => t });
    const post = (secret: string, remote: string): Promise<Response> =>
      auth.signIn(new Request("http://x/api/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) }), remote);
    for (let i = 0; i < SIGN_IN_FAILURES; i++) expect((await post("wrong", "10.0.0.9")).status).toBe(401);
    const held = await post(SECRET, "10.0.0.9");
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(SECRET, "10.0.0.10")).status).toBe(204);
    t += 61_000;
    expect((await post(SECRET, "10.0.0.9")).status).toBe(204);
  });

  test("one credential holds a bounded number of sign-ins, and evicts only its own", async () => {
    const auth = inspectorAuth({ secret: SECRET });
    for (let i = 0; i < MAX_SIGN_INS_PER_CREDENTIAL * 2; i++) {
      expect((await auth.signIn(new Request("http://x/api/sign-in", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }), "10.0.0.1")).status).toBe(204);
    }
    expect(auth.signIns).toBe(MAX_SIGN_INS_PER_CREDENTIAL);
  });

  test("every response carries the policy: own scripts only, no framing, no sniffing", async () => {
    const res = await inspectorHandler({ source: storeSource(tmp) })(new Request("http://127.0.0.1/api/sessions"));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("wowhead");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(contentSecurityPolicy(true)).toContain("script-src 'self' https://wow.zamimg.com https://*.wowhead.com");
  });

  test("the server caps request bodies", async () => {
    const server = serveInspector({ source: storeSource(tmp), port: 0, secret: SECRET, host: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(256 * 1024) });
      expect(res.status).toBe(413);
    } finally {
      server.stop(true);
    }
  });
});
