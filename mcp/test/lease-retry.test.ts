/**
 * `/lease` on an unreachable module: retried over LEASE_RETRY_DELAYS_MS, then
 * the launch fails. A run pod whose network path to the worldserver was not
 * up yet used to start bare and play its whole episode unauthenticated.
 */
import { describe, expect, test } from "bun:test";

import { LEASE_RETRY_DELAYS_MS, leaseSessionSecret } from "../src/module-auth";

const PORT = "port-secret-0123456789abcdef0123456789abcdef";
const LEASED = "l".repeat(64);
const env = { WRATHBENCH_MODULE_SECRET: PORT };

/** A fetch that refuses the connection `refusals` times, then leases. */
const flaky = (refusals: number) => {
  let calls = 0;
  const f = (async () => {
    calls++;
    if (calls <= refusals) throw new Error("ECONNREFUSED: Unable to connect");
    return new Response(JSON.stringify({ ok: true, account: "RUNNER", secret: LEASED }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
};

describe("leaseSessionSecret: an unreachable module", () => {
  test("is retried, and a lease that lands on a later try is the outcome", async () => {
    const waits: number[] = [];
    const m = flaky(2);
    const out = await leaseSessionSecret({ moduleUrl: "http://module.invalid", token: "t", env, fetch: m.f, sleep: async (ms) => void waits.push(ms) });
    expect(out).toEqual({ secret: LEASED, account: "RUNNER", allowGm: false });
    expect(m.calls()).toBe(3);
    expect(waits).toEqual(LEASE_RETRY_DELAYS_MS.slice(0, 2));
  });

  test("throws once every try is spent, rather than starting the run bare", async () => {
    const waits: number[] = [];
    const m = flaky(Number.POSITIVE_INFINITY);
    await expect(leaseSessionSecret({ moduleUrl: "http://module.invalid", token: "t", env, fetch: m.f, sleep: async (ms) => void waits.push(ms) })).rejects.toThrow(
      /module unreachable for \/lease after 7 tries over 60s \(ECONNREFUSED: Unable to connect\)/,
    );
    expect(m.calls()).toBe(LEASE_RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...LEASE_RETRY_DELAYS_MS]);
  });

  test("an answer, even a refusal, is not retried", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    }) as unknown as typeof fetch;
    await expect(leaseSessionSecret({ moduleUrl: "http://module.invalid", token: "t", env, fetch: f, sleep: async () => {} })).rejects.toThrow("HTTP 401");
    expect(calls).toBe(1);
  });
});
