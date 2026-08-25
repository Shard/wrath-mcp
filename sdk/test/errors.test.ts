/**
 * Regression tests for the deterministic error-surface work (2026-08 audit):
 * client-side guid/position validation, prototype-safe getters, error-code
 * hints, and labeled event timeouts.
 */

import { describe, expect, test } from "bun:test";

import { KNOWN_ERROR_CODES, WrathClient, WrathRequestError } from "../src/client";
import { EventStream, EventTimeoutError } from "../src/events";

function makeClient(): WrathClient {
  return new WrathClient({ baseUrl: "http://module.invalid:8086", token: "t", subscribeEvents: false });
}

describe("guid argument validation", () => {
  test("a number guid is rejected before the wire, naming the method and the precision hazard", () => {
    const client = makeClient();
    expect(() => client.setTarget(12970366926827028480 as unknown as string)).toThrow(TypeError);
    try {
      client.setTarget(123 as unknown as string);
      throw new Error("did not throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("setTarget(guid)");
      expect(msg).toContain("MAX_SAFE_INTEGER");
      expect(msg).toContain("decimal string");
    }
  });

  test("an undefined guid is rejected, naming the method and where guids come from", () => {
    const client = makeClient();
    try {
      client.attackStart(undefined as unknown as string);
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      const msg = (e as Error).message;
      expect(msg).toContain("attackStart(guid)");
      expect(msg).toContain("undefined");
      expect(msg).toContain("state.nearbyUnits()");
    }
  });

  test("helpers taking guids validate too (killTarget, sellItem's itemGuid)", async () => {
    const client = makeClient();
    await expect(client.killTarget(42 as unknown as string)).rejects.toThrow(/killTarget\(guid\).*number/s);
    expect(() => client.sellItem("1", undefined as unknown as string)).toThrow(/sellItem\(\.\.\., itemGuid\)/);
  });

  test("a whole object (the unit instead of unit.guid) is rejected, naming the .guid fix", () => {
    // The commonest live mistake: sdk.setTarget(state.closest(...)) instead of
    // .guid. It must be caught client-side with the call site named, not
    // serialized to the wire for a generic invalid_guid.
    const client = makeClient();
    try {
      client.setTarget({ guid: "7", name: "Kobold Worker" } as unknown as string);
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      const msg = (e as Error).message;
      expect(msg).toContain("setTarget(guid)");
      expect(msg).toContain("an object");
      expect(msg).toContain("unit.guid");
    }
    expect(() => client.attackStart(["7"] as unknown as string)).toThrow(/an array.*unit\.guid/s);
    expect(() => client.interact(true as unknown as string)).toThrow(/a boolean.*unit\.guid/s);
  });

  test("a decimal string passes; a model-conjured bigint is repaired, not rejected (ADR-0017)", () => {
    const client = makeClient();
    // These reach fetch against an unreachable host: the returned promise
    // rejects with a transport error, but nothing throws synchronously. A
    // bigint names exactly one guid, so it is silently converted to the
    // string form (ADR-0016 deterministic repair) rather than thrown on.
    expect(() => void client.setTarget("12970366926827028480").catch(() => {})).not.toThrow();
    expect(() => void client.setTarget(7n as unknown as string).catch(() => {})).not.toThrow();
  });
});

describe("move_to position validation", () => {
  test("a missing axis is named", () => {
    const client = makeClient();
    expect(() => client.moveToAsync({ x: 1, y: 2 } as unknown as { x: number; y: number; z: number })).toThrow(
      /position z must be a finite number, got undefined/,
    );
  });

  test("a non-finite axis is named with its value", () => {
    const client = makeClient();
    expect(() => client.moveToAsync({ x: NaN, y: 2, z: 3 })).toThrow(/position x must be a finite number, got NaN/);
    expect(() =>
      client.moveToAsync({ x: 1, y: "2" as unknown as number, z: 3 }),
    ).toThrow(/position y must be a finite number, got string/);
  });

  test("moveTo (the waiting helper) rejects the same way", async () => {
    const client = makeClient();
    await expect(client.moveTo({ x: 1, y: 2, z: Infinity })).rejects.toThrow(/position z/);
  });
});

describe("selfKey off the prototype", () => {
  test("reading the getter with a prototype receiver yields undefined, not a TypeError", () => {
    const client = makeClient();
    const proto = Object.getPrototypeOf(client) as { selfKey?: string };
    // This is what generic introspection does; it used to throw
    // "undefined is not an object (evaluating 'this.state.self')".
    expect(proto.selfKey).toBeUndefined();
    expect(client.selfKey).toBeUndefined(); // unseeded instance: undefined too
  });
});

describe("error-code hints", () => {
  const hintCases: Array<[string, RegExp]> = [
    ["account_in_use", /do not call createSession again/],
    ["no_session", /await connect\(\).*createSession/],
    ["not_in_world", /createSession/],
    ["token_in_use", /reuse the existing session/],
    ["no_player", /deleteSession/],
    ["unsupported_action", /whitelist/],
    ["moving", /sdk\.stop\(\)/],
    ["missing_guid", /nearbyUnits/],
    ["missing_position", /x, y and z/],
    ["missing_face_target", /orientation/],
    ["invalid_guid", /decimal u64|String\(guid\)/],
  ];
  for (const [code, pattern] of hintCases) {
    test(`${code} renders an actionable hint`, () => {
      const err = new WrathRequestError(400, { ok: false, error: code });
      expect(err.message).toContain(code);
      expect(err.message).toMatch(pattern);
    });
  }

  test("every member of the stale-session cycle names the actual exit (deleteSession)", () => {
    // no_player/session_gone/not_in_world are only emitted while the session
    // record still holds the token, so a bare createSession answers
    // token_in_use — the recovery is deleteSession() first. Each hint in that
    // cycle must name it, or the hints steer a model into a loop with no exit.
    for (const code of ["no_player", "session_gone", "not_in_world", "token_in_use"]) {
      const err = new WrathRequestError(409, { ok: false, error: code });
      expect(err.message).toContain("deleteSession");
    }
  });

  test("an unknown code renders without a hint, unchanged", () => {
    const err = new WrathRequestError(400, { ok: false, error: "some_future_code" });
    expect(err.message).toBe("module rejected request: some_future_code (HTTP 400)");
  });

  test("char_create hints still take precedence", () => {
    const err = new WrathRequestError(400, { ok: false, error: "char_create_failed_code_50" });
    expect(err.message).toContain("that name is already in use");
  });

  test("a taken name tells the model to choose another, in the game's own naming rules (ADR-0050)", () => {
    // The model names its own character, so code 50 is a retry and not a dead
    // end: `fleet-sonnet-e90-...-a12` looped it for eight minutes on 2026-08-25
    // because the message named no way forward.
    const err = new WrathRequestError(400, { ok: false, error: "char_create_failed_code_50" });
    expect(err.message).toContain("choose a different character name");
    expect(err.message).toContain("createSession again");
    expect(err.message).toContain("2-12 letters");
  });

  test("every naming refusal names a way out, not just the objection (ADR-0050)", () => {
    // 0x5a-0x5f were unreachable while the harness assigned the name and are
    // model-reachable now: `createSession` validates race and class before the
    // wire, never the name.
    for (const code of [0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f]) {
      const err = new WrathRequestError(400, { ok: false, error: `char_create_failed_code_${code}` });
      expect(err.message).toMatch(/choose (a |another)/);
    }
  });

  test("every KnownErrorCode renders a hint — the table cannot drift from the list", () => {
    // The module grew codes (account_not_permitted) the hint table never
    // learned, and unknown_account's hint described the wrong condition. Any
    // code promoted into KNOWN_ERROR_CODES must carry a hint from day one.
    for (const code of KNOWN_ERROR_CODES) {
      const err = new WrathRequestError(400, { ok: false, error: code });
      expect(err.message).not.toBe(`module rejected request: ${code} (HTTP 400)`);
    }
  });

  test("the two account refusals describe their own conditions, not each other's", () => {
    // account_not_permitted = allowlist miss; unknown_account = the name
    // passed the allowlist but no auth-DB account exists. The old
    // unknown_account hint sent operators to the (already-correct) allowlist.
    const permitted = new WrathRequestError(403, { ok: false, error: "account_not_permitted" });
    expect(permitted.message).toContain("allowlist");
    const unknown = new WrathRequestError(400, { ok: false, error: "unknown_account" });
    expect(unknown.message).toContain("auth database");
    expect(unknown.message).not.toContain("is not on the module's allowlist");
  });
});

describe("labeled event timeouts", () => {
  test("waitFor's description lands in the EventTimeoutError", async () => {
    const stream = new EventStream({ url: "ws://module.invalid", token: "t", reconnect: false });
    const pending = stream.waitFor(() => false, {
      timeout: 10,
      description: "the WB_MOVE_RESULT for moveId 3 (move_to verdict)",
    });
    await expect(pending).rejects.toThrow(/waiting for the WB_MOVE_RESULT for moveId 3/);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTimeoutError);
    expect((err as EventTimeoutError).waitingFor).toContain("moveId 3");
  });

  test("waitForOpcode labels the timeout with the opcode by default", async () => {
    const stream = new EventStream({ url: "ws://module.invalid", token: "t", reconnect: false });
    await expect(stream.waitForOpcode("SMSG_LOOT_RESPONSE", { timeout: 10 })).rejects.toThrow(
      /waiting for a SMSG_LOOT_RESPONSE event/,
    );
  });

  test("without a description the message keeps its old wording", async () => {
    const stream = new EventStream({ url: "ws://module.invalid", token: "t", reconnect: false });
    await expect(stream.waitFor(() => false, { timeout: 10 })).rejects.toThrow(
      /timed out after 10ms waiting for an event/,
    );
  });
});
