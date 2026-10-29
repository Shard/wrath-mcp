/**
 * The standalone server's GM opt-in: `--allow-gm` or `WRATHBENCH_ALLOW_GM`,
 * off by default, carried on the lease (the one call only the port secret's
 * holder makes) and reported back as the module's word on it.
 */
import { describe, expect, test } from "bun:test";

import { ALLOW_GM_ENV, allowGmOption } from "../src/main";
import { leaseSessionSecret } from "../src/module-auth";

const PORT = "port-secret-0123456789abcdef0123456789abcdef";
const LEASED = "l".repeat(64);

describe("allowGmOption", () => {
  test("is off with nothing set", () => {
    expect(allowGmOption([], {})).toBe(false);
    expect(allowGmOption(["--account", "RUNNER", "--dir", "/tmp/x"], {})).toBe(false);
  });

  test("--allow-gm turns it on, wherever it stands in argv", () => {
    expect(allowGmOption(["--allow-gm"], {})).toBe(true);
    expect(allowGmOption(["--account", "GM", "--allow-gm", "--dir", "/tmp/x"], {})).toBe(true);
  });

  test(`${ALLOW_GM_ENV} reads 1 and true as on, and unset, empty, 0 and false as off`, () => {
    for (const v of ["1", "true", "TRUE", " 1 "]) expect(allowGmOption([], { [ALLOW_GM_ENV]: v })).toBe(true);
    for (const v of [undefined, "", "0", "false", "False"]) expect(allowGmOption([], { [ALLOW_GM_ENV]: v })).toBe(false);
  });

  test("any other value is refused rather than read either way", () => {
    for (const v of ["yes", "on", "2", "gm"]) expect(() => allowGmOption([], { [ALLOW_GM_ENV]: v })).toThrow(ALLOW_GM_ENV);
  });

  test("the flag wins over an env that says off", () => {
    expect(allowGmOption(["--allow-gm"], { [ALLOW_GM_ENV]: "0" })).toBe(true);
  });
});

describe("leaseSessionSecret: the opt-in", () => {
  const leasing = (answer: (body: Record<string, unknown>) => Record<string, unknown>) => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(JSON.stringify(answer(body)), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { bodies, f };
  };
  const echo = (b: Record<string, unknown>) => ({ ok: true, token: b["token"], account: "RUNNER", secret: LEASED, allowGm: b["allowGm"] === true });

  test("is absent from the lease body by default, and the outcome says off", async () => {
    const m = leasing(echo);
    const out = await leaseSessionSecret({ moduleUrl: "http://module.invalid", token: "t", account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: PORT }, fetch: m.f });
    expect(m.bodies).toEqual([{ token: "t", account: "RUNNER" }]);
    expect(out).toEqual({ secret: LEASED, account: "RUNNER", allowGm: false });
  });

  test("rides the lease when asked for, and the outcome carries the module's confirmation", async () => {
    const m = leasing(echo);
    const out = await leaseSessionSecret({ moduleUrl: "http://module.invalid", token: "t", allowGm: true, env: { WRATHBENCH_MODULE_SECRET: PORT }, fetch: m.f });
    expect(m.bodies).toEqual([{ token: "t", allowGm: true }]);
    expect(out).toEqual({ secret: LEASED, account: "RUNNER", allowGm: true });
  });

  test("a module that predates it answers without allowGm, which reads as off", async () => {
    const m = leasing((b) => ({ ok: true, token: b["token"], account: "RUNNER", secret: LEASED }));
    const out = await leaseSessionSecret({ moduleUrl: "http://module.invalid", token: "t", allowGm: true, env: { WRATHBENCH_MODULE_SECRET: PORT }, fetch: m.f });
    expect(out.secret).toBe(LEASED);
    expect(out.secret !== undefined && out.allowGm).toBe(false);
  });
});
