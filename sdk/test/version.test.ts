/**
 * The SDK's own version and the module protocol check `connect` makes
 * (`src/version.ts`; module/PROTOCOL.md, "Versioning").
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { connect } from "../src/client";
import { checkModuleProtocol, MODULE_PROTOCOL_VERSIONS, ModuleProtocolError, SDK_VERSION } from "../src/index";
import { startStub } from "./server";

const health = (extra: Record<string, unknown>): Response =>
  Response.json({ ok: true, module: "mod-wrathbench", worldStopped: false, sessions: 0, droppedPackets: 0, droppedPacketsLive: 0, ...extra });

describe("versions", () => {
  test("SDK_VERSION is the package's version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  test("a module without a protocol field, or with a supported one, passes", () => {
    expect(() => checkModuleProtocol({})).not.toThrow();
    for (const p of MODULE_PROTOCOL_VERSIONS) expect(() => checkModuleProtocol({ protocol: p })).not.toThrow();
  });

  test("an unsupported protocol is refused by name", () => {
    expect(() => checkModuleProtocol({ protocol: 99 })).toThrow(ModuleProtocolError);
    expect(() => checkModuleProtocol({ protocol: 99 })).toThrow(/protocol 99/);
  });

  test("connect refuses a module it cannot drive, before it subscribes", async () => {
    const stub = startStub({ routes: { health: () => health({ protocol: 99 }) } });
    try {
      await expect(connect({ baseUrl: stub.baseUrl, token: "t".repeat(32) })).rejects.toBeInstanceOf(ModuleProtocolError);
      expect(stub.connections).toBe(0);
    } finally {
      await stub.stop();
    }
  });

  test("connect goes ahead with a supported protocol, and with a /health that does not answer", async () => {
    for (const route of [() => health({ protocol: 1 }), () => new Response("down", { status: 503 })]) {
      const stub = startStub({ routes: { health: route } });
      try {
        const client = await connect({ baseUrl: stub.baseUrl, token: "t".repeat(32) });
        expect(client.events.connected).toBe(true);
        client.close();
      } finally {
        await stub.stop();
      }
    }
  });
});
