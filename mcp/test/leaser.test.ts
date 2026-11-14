/**
 * A host leases through a `Leaser`: the roster and the single-character
 * server's shutdown take, end and give back every lease through the one they
 * are handed, so a host that never holds the port secret (a hosted worker)
 * can be handed one that asks whoever does. Without one, both lease with the
 * port secret as before.
 */

import { describe, expect, test } from "bun:test";
import { CharacterRoster, type FanoutSandbox } from "../src/fanout";
import { sessionShutdown } from "../src/main";
import { leaseRedacted, portSecretLeaser, type Leaser, type LeaseOutcome } from "../src/module-auth";
import { SecretRedactor } from "../src/redact";
import type { SeatSpec, SeatView } from "../src/sandbox/host";

/** A leaser that records what it was asked and hands out a fixed secret per token. */
function recordingLeaser(): Leaser & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    lease: async (o): Promise<LeaseOutcome> => {
      log.push(`lease ${o.token} ${o.account ?? "-"}${o.allowGm === true ? " gm" : ""}`);
      return { secret: `secret-for-${o.token}-0123456789abcdef`, account: o.account ?? "?", allowGm: false };
    },
    logout: async (token) => void log.push(`logout ${token}`),
    release: async (token) => void log.push(`release ${token}`),
  };
}

/** The roster's view of a sandbox, with seats kept in a map; `failOpen` makes the next open throw. */
function standInSandbox(): FanoutSandbox & { specs: SeatSpec[]; failOpen: boolean } {
  const seats = new Map<string, SeatView>();
  let guid = 100;
  const sb = {
    specs: [] as SeatSpec[],
    failOpen: false,
    openSeat: async (spec: SeatSpec) => {
      sb.specs.push(spec);
      if (sb.failOpen) {
        sb.failOpen = false;
        throw new Error("no such character");
      }
      seats.set(spec.character, { character: spec.character, account: spec.account, attached: true });
      return { character: spec.character, guid: String(++guid) };
    },
    closeSeat: async (character: string) => void seats.delete(character),
    seatViews: () => [...seats.values()],
    evalSnippet: async () => ({ ok: true, value: null, logs: [] }) as never,
    recentEvents: async () => [],
    recentEventsAll: async () => ({}),
    stateSnapshot: async () => ({}),
    stateBriefs: async () => ({}),
  };
  return sb;
}

/** A fetch that fails the test if anything reaches the module directly. */
const noModule = (async (input: string | URL | Request) => {
  throw new Error(`the roster reached the module itself: ${String(input)}`);
}) as unknown as typeof fetch;

describe("a roster handed a leaser", () => {
  test("takes, ends and gives back every lease through it, and never reaches the module itself", async () => {
    const leaser = recordingLeaser();
    const sandbox = standInSandbox();
    const secrets = new SecretRedactor();
    let n = 0;
    const roster = new CharacterRoster({
      grant: { maxCharacters: 2, accounts: ["ACCA", "ACCB"] },
      moduleUrl: "http://module.invalid",
      sandbox,
      secrets,
      leaser,
      env: {},
      fetch: noModule,
      newToken: () => `tok${++n}`,
    });
    expect(await roster.login({ name: "Alfa" })).toEqual({ ok: true, character: "Alfa", guid: "101" });
    expect(await roster.login({ name: "Bravo" })).toEqual({ ok: true, character: "Bravo", guid: "102" });
    // Each seat is opened with the secret its lease returned, and that secret is already on the scrub list.
    expect(sandbox.specs.map((s) => [s.character, s.account, s.secret])).toEqual([
      ["Alfa", "ACCA", "secret-for-tok1-0123456789abcdef"],
      ["Bravo", "ACCB", "secret-for-tok2-0123456789abcdef"],
    ]);
    expect(secrets.scrub("x secret-for-tok1-0123456789abcdef y")).not.toContain("secret-for-tok1");
    expect(await roster.logout("Alfa")).toEqual({ ok: true });
    await roster.shutdown({ logout: true });
    expect(leaser.log).toEqual(["lease tok1 ACCA", "lease tok2 ACCB", "logout tok1", "release tok1", "logout tok2", "release tok2"]);
  });

  test("gives back the lease of a login whose seat did not open", async () => {
    const leaser = recordingLeaser();
    const sandbox = standInSandbox();
    sandbox.failOpen = true;
    const roster = new CharacterRoster({ grant: { maxCharacters: 1, accounts: ["ACCA"] }, moduleUrl: "http://module.invalid", sandbox, secrets: new SecretRedactor(), leaser, fetch: noModule, newToken: () => "tokx" });
    expect(await roster.login({ name: "Alfa" })).toEqual({ ok: false, error: "no such character" });
    expect(leaser.log).toEqual(["lease tokx ACCA", "release tokx"]);
  });

  test("passes the grant's GM opt-in to the leaser, and nothing when the grant has none", async () => {
    for (const allowGm of [true, false]) {
      const leaser = recordingLeaser();
      const roster = new CharacterRoster({ grant: { maxCharacters: 1, accounts: ["ACCA"], ...(allowGm ? { allowGm } : {}) }, moduleUrl: "http://module.invalid", sandbox: standInSandbox(), secrets: new SecretRedactor(), leaser, newToken: () => "tokg" });
      await roster.login({ name: "Alfa" });
      expect(leaser.log[0]).toBe(allowGm ? "lease tokg ACCA gm" : "lease tokg ACCA");
    }
  });
});

describe("the port-secret leaser", () => {
  test("is what a host without a leaser of its own uses: /lease, DELETE /session and DELETE /lease with the port secret", async () => {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname} ${(init?.headers as Record<string, string>)["authorization"]}`);
      return new Response(JSON.stringify({ ok: true, secret: "leased-secret-0123456789abcdef", account: "ACCA" }), { status: 200 });
    }) as unknown as typeof fetch;
    const leaser = portSecretLeaser({ moduleUrl: "http://module.invalid", env: { WRATHBENCH_MODULE_SECRET: "port-secret" }, fetch: f });
    const secrets = new SecretRedactor();
    const lease = await leaseRedacted(leaser, { token: "t1", account: "ACCA" }, secrets);
    expect(lease).toEqual({ secret: "leased-secret-0123456789abcdef", account: "ACCA", allowGm: false });
    expect(secrets.scrub("leased-secret-0123456789abcdef")).not.toContain("leased-secret");
    await leaser.logout("t1");
    await leaser.release("t1");
    expect(calls).toEqual(["POST /lease Bearer port-secret", "DELETE /session Bearer port-secret", "DELETE /lease Bearer port-secret"]);
  });
});

describe("the single-character shutdown", () => {
  test("logs out and releases through the leaser it is handed", async () => {
    const leaser = recordingLeaser();
    const shutdown = sessionShutdown({ sandbox: { stop: async () => {} }, moduleUrl: "http://module.invalid", token: "tok-s", leaser, fetch: noModule });
    await shutdown();
    await shutdown();
    expect(leaser.log).toEqual(["logout tok-s", "release tok-s"]);
  });
});
