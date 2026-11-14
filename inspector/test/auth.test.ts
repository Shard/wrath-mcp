/**
 * When the inspector may start, and the bin's flags: loopback needs nothing,
 * every other bind needs a bearer secret, and the secret never comes from
 * the command line.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindRefusal, isLoopbackHost, serveInspector, storeSource } from "../src/index";
import { parseArgs } from "../src/bin";
import { tempDir } from "./fixtures";

const tmp = tempDir();
const SECRET = "an-inspector-secret-of-length";

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
    expect(parseArgs(["--store", tmp], {})).toEqual({ store: tmp, hostedState: undefined, grants: undefined, host: "127.0.0.1", port: 8091, secret: undefined, tiles: undefined, wowhead: false });
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
