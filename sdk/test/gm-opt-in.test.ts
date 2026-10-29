/**
 * The GM opt-in (module/PROTOCOL.md, "POST /session", `allowGm`): off unless
 * the client is connected with it, bound like the account so nothing a call
 * passes can raise it, and sent on every surface that refuses a GM account
 * without it — create, character-delete and the operator's lease.
 */

import { describe, expect, test } from "bun:test";

import { connect, WrathClient, WrathRequestError } from "../src/client";
import { startStub } from "./server";

const PORT_SECRET = "operator-secret-0123456789abcdef0123456789abcdef";
const TOKEN = "gm-opt-in-token-".padEnd(40, "a");

describe("client: the GM opt-in", () => {
  test("is off by default: no create, delete or lease body carries allowGm", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const client = await connect({ baseUrl: stub.baseUrl, token: TOKEN, secret: PORT_SECRET });
      await client.createSession({ character: "Fenwick", race: 1, class: 1 });
      await client.deleteCharacter("Fenwick");
      const lease = await client.lease("RUNNER");
      client.close();
      expect(stub.sessions[0]).not.toHaveProperty("allowGm");
      expect(stub.characterDeletes[0]).not.toHaveProperty("allowGm");
      expect(stub.leaseBodies[0]).toEqual({ token: TOKEN, account: "RUNNER" });
      expect(lease.allowGm).toBe(false);
    } finally {
      await stub.stop();
    }
  });

  test("connect({ allowGm: true }) sends it on create, delete and lease", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const client = await connect({ baseUrl: stub.baseUrl, token: TOKEN, secret: PORT_SECRET, allowGm: true });
      await client.createSession({ character: "Fenwick", race: 1, class: 1 });
      await client.deleteCharacter("Fenwick");
      const lease = await client.lease();
      client.close();
      expect(stub.sessions[0]?.allowGm).toBe(true);
      expect(stub.characterDeletes[0]?.allowGm).toBe(true);
      expect(stub.leaseBodies[0]).toEqual({ token: TOKEN, allowGm: true });
      expect(lease.allowGm).toBe(true);
    } finally {
      await stub.stop();
    }
  });

  test("a createSession request cannot raise it: an allowGm the call carries is struck", async () => {
    const stub = startStub({ secret: PORT_SECRET });
    try {
      const client = new WrathClient({ baseUrl: stub.baseUrl, token: TOKEN, secret: PORT_SECRET, subscribeEvents: false });
      // What untyped snippet code can pass.
      await client.createSession({ character: "Fenwick", allowGm: true } as unknown as { character: string });
      expect(stub.sessions[0]).not.toHaveProperty("allowGm");
    } finally {
      await stub.stop();
    }
  });

  test("both refusals say how an operator opts in", () => {
    for (const code of ["gm_account", "chat_command"]) {
      const e = new WrathRequestError(403, { ok: false, error: code });
      expect(e.code).toBe(code);
      expect(e.kind).toBe("request");
      expect(e.message).toContain("--allow-gm");
      expect(e.message).toContain("WRATHBENCH_ALLOW_GM=1");
      expect(e.message).toContain("connect({ allowGm: true })");
    }
    const chat = new WrathRequestError(403, { ok: false, error: "chat_command", action: "say" });
    expect(chat.message).toContain("nothing was sent");
    expect(chat.message).toContain("drop the leading character");
  });
});
