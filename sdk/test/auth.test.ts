/**
 * The credential the client carries (module/PROTOCOL.md, "Authentication"):
 * `secret` rides every request and the `/events` upgrade as
 * `Authorization: Bearer`, the operator's `lease()` fetches the session
 * secret a child client is built with, and a stub that enforces the secret
 * refuses a client built without one — the module's shape, so the SDK's
 * behaviour against it is pinned here rather than discovered live.
 */

import { describe, expect, test } from "bun:test";

import { connect, WrathClient, WrathRequestError } from "../src/client";
import { startStub } from "./server";

const PORT_SECRET = "operator-secret-0123456789abcdef0123456789abcdef";

describe("client: authentication", () => {
  test("the secret is sent on HTTP requests and on the /events upgrade", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const client = await connect({ baseUrl: stub.baseUrl, token: "t".repeat(32), secret: PORT_SECRET });
      await client.health();
      await client.say("hi");
      client.close();
      // upgrade, /health, /action — every one carried the bearer.
      expect(stub.authorizations).toEqual([`Bearer ${PORT_SECRET}`, `Bearer ${PORT_SECRET}`, `Bearer ${PORT_SECRET}`]);
    } finally {
      await stub.stop();
    }
  });

  test("without a secret the request goes out bare and the module's 401 is a typed request error", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const client = new WrathClient({ baseUrl: stub.baseUrl, token: "t".repeat(32), subscribeEvents: false });
      await expect(client.health()).rejects.toBeInstanceOf(WrathRequestError);
      await client.health().catch((e: WrathRequestError) => {
        expect(e.status).toBe(401);
        expect(e.code).toBe("unauthorized");
        expect(e.message).toContain("secret");
      });
      expect(stub.authorizations).toEqual([null, null]);
    } finally {
      await stub.stop();
    }
  });

  test("an unauthenticated /events upgrade is refused before the socket opens", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const client = new WrathClient({
        baseUrl: stub.baseUrl,
        token: "t".repeat(32),
        events: { reconnect: false },
      });
      await expect(client.events.connect()).rejects.toThrow();
      expect(stub.connections).toBe(0);
    } finally {
      await stub.stop();
    }
  });

  test("lease() is the operator's call and yields a secret a session-class client works with", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const token = "run-token-".padEnd(40, "a");
      const operator = new WrathClient({ baseUrl: stub.baseUrl, token, secret: PORT_SECRET, account: "RUNNER3", subscribeEvents: false });
      const lease = await operator.lease();
      expect(lease.token).toBe(token);
      expect(lease.account).toBe("RUNNER3");
      expect(lease.secret.length).toBeGreaterThanOrEqual(32);
      expect(stub.leases.get(token)).toBe(lease.secret);

      const child = await connect({ baseUrl: stub.baseUrl, token, secret: lease.secret });
      await child.say("hello");
      child.close();
      expect(stub.authorizations.at(-1)).toBe(`Bearer ${lease.secret}`);

      const released = await operator.releaseLease();
      expect(released.released).toBe(true);
      expect(stub.leases.has(token)).toBe(false);
    } finally {
      await stub.stop();
    }
  });
});
