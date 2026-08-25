import { describe, expect, test } from "bun:test";

import {
  actionResponseSchema,
  deleteSessionResponseSchema,
  errorBodySchema,
  guidKey,
  healthResponseSchema,
  isDecodeError,
  isEvent,
  isKnownOpcode,
  isMoveOpcode,
  KNOWN_OPCODES,
  MOVE_OPCODES,
  moveToResponseSchema,
  parseEventFrame,
  sessionResponseSchema,
  updateObjectDataSchema,
} from "../src/protocol";
import {
  chatEcho,
  creatureCreate,
  CREATURE_GUID,
  fullStream,
  futureOpcode,
  healthResponseFixture,
  loginSequence,
  malformedChat,
  moveResult,
  sessionResponseFixture,
  undecodableChat,
} from "./fixtures";

describe("HTTP response schemas", () => {
  test("health round-trips every documented field", () => {
    const parsed = healthResponseSchema.parse(healthResponseFixture);
    expect(parsed).toEqual(healthResponseFixture);
  });

  test("session response decodes guid to an opaque decimal string (ADR-0017)", () => {
    const parsed = sessionResponseSchema.parse(sessionResponseFixture);
    expect(parsed.guid).toBe("7");
    expect(parsed.character).toBe("Fenwick");
    expect(parsed.inWorld).toBe(true);
  });

  test("session response accepts a guid sent as a string, preserved exactly", () => {
    const parsed = sessionResponseSchema.parse({
      ...sessionResponseFixture,
      guid: "18446744073709551000",
    });
    expect(parsed.guid).toBe("18446744073709551000");
  });

  test("action and delete acks round-trip", () => {
    expect(actionResponseSchema.parse({ ok: true, action: "say", token: "t" })).toEqual({
      ok: true,
      action: "say",
      token: "t",
    });
    expect(deleteSessionResponseSchema.parse({ ok: true, token: "t" })).toEqual({
      ok: true,
      token: "t",
    });
  });

  test("unknown fields on a response survive instead of being stripped", () => {
    const parsed = healthResponseSchema.parse({ ...healthResponseFixture, uptimeMs: 99 });
    expect((parsed as { uptimeMs?: number }).uptimeMs).toBe(99);
  });

  test("error bodies accept codes this SDK revision does not know", () => {
    const parsed = errorBodySchema.parse({ ok: false, error: "some_future_code", extra: 1 });
    expect(parsed.error).toBe("some_future_code");
  });

  test("a success shape does not parse as an error body", () => {
    expect(errorBodySchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe("event frames", () => {
  test("every whitelisted opcode in PROTOCOL.md has a schema", () => {
    expect(KNOWN_OPCODES).toEqual([
      "SMSG_AUTH_RESPONSE",
      "SMSG_CHAR_ENUM",
      "SMSG_CHAR_CREATE",
      "SMSG_CHARACTER_LOGIN_FAILED",
      "SMSG_LOGIN_VERIFY_WORLD",
      "SMSG_MOTD",
      "SMSG_NOTIFICATION",
      "SMSG_NAME_QUERY_RESPONSE",
      "SMSG_MESSAGECHAT",
      "SMSG_UPDATE_OBJECT",
      "SMSG_DESTROY_OBJECT",
      "SMSG_CREATURE_QUERY_RESPONSE",
      "SMSG_GAMEOBJECT_QUERY_RESPONSE",
      "WB_MOVE_PROGRESS",
    "WB_SESSION_STATE",
      "WB_AREA",
      "WB_MOVE_RESULT",
      "WB_RIDE_PROGRESS",
      "WB_TRANSPORT_PROGRESS",
      ...MOVE_OPCODES,
      // map transfers
      "SMSG_TRANSFER_PENDING",
      "SMSG_NEW_WORLD",
      "SMSG_TRANSFER_ABORTED",
      // quest/combat extension, in PROTOCOL.md's table order
      "SMSG_ATTACKSTART",
      "SMSG_ATTACKSTOP",
      "SMSG_ATTACKERSTATEUPDATE",
      "SMSG_SPELL_START",
      "SMSG_SPELL_GO",
      "SMSG_CAST_FAILED",
      "SMSG_SPELL_FAILURE",
      "SMSG_PERIODICAURALOG",
      "SMSG_AURA_UPDATE",
      "SMSG_AURA_UPDATE_ALL",
      "SMSG_LOG_XPGAIN",
      "SMSG_LEVELUP_INFO",
      "SMSG_ITEM_PUSH_RESULT",
      "SMSG_QUESTGIVER_STATUS",
      "SMSG_QUESTGIVER_STATUS_MULTIPLE",
      "SMSG_QUEST_QUERY_RESPONSE",
      "SMSG_QUESTGIVER_QUEST_LIST",
      "SMSG_QUESTGIVER_QUEST_DETAILS",
      "SMSG_QUESTGIVER_REQUEST_ITEMS",
      "SMSG_QUESTGIVER_OFFER_REWARD",
      "SMSG_QUESTGIVER_QUEST_COMPLETE",
      "SMSG_QUESTGIVER_QUEST_FAILED",
      "SMSG_QUESTUPDATE_ADD_KILL",
      "SMSG_QUESTUPDATE_ADD_ITEM",
      "SMSG_QUESTUPDATE_COMPLETE",
      "SMSG_QUESTUPDATE_FAILED",
      "SMSG_GOSSIP_MESSAGE",
      "SMSG_GOSSIP_COMPLETE",
      "SMSG_LOOT_RESPONSE",
      "SMSG_LOOT_REMOVED",
      "SMSG_LOOT_MONEY_NOTIFY",
      "SMSG_LOOT_CLEAR_MONEY",
      "SMSG_LOOT_RELEASE_RESPONSE",
      "SMSG_LIST_INVENTORY",
      "SMSG_BUY_ITEM",
      "SMSG_BUY_FAILED",
      "SMSG_SELL_ITEM",
      "SMSG_TRAINER_LIST",
      "SMSG_TRAINER_BUY_SUCCEEDED",
      "SMSG_TRAINER_BUY_FAILED",
      "SMSG_INVENTORY_CHANGE_FAILURE",
      "SMSG_ITEM_QUERY_SINGLE_RESPONSE",
      "SMSG_INITIAL_SPELLS",
      "SMSG_LEARNED_SPELL",
      "SMSG_REMOVED_SPELL",
      "SMSG_SUPERCEDED_SPELL",
      "SMSG_SPELL_COOLDOWN",
      "SMSG_COOLDOWN_EVENT",
      "SMSG_CLEAR_COOLDOWN",
      "SMSG_TALENTS_INFO",
      "SMSG_ACHIEVEMENT_EARNED",
      "SMSG_ALL_ACHIEVEMENT_DATA",
      "SMSG_ACTIVATETAXIREPLY",
      "SMSG_DEATH_RELEASE_LOC",
      "SMSG_CORPSE_RECLAIM_DELAY",
      "SMSG_DURABILITY_DAMAGE_DEATH",
      "MSG_CORPSE_QUERY",
      "SMSG_CHAR_DELETE",
      "SMSG_MONSTER_MOVE",
    ]);
    expect(isKnownOpcode("SMSG_MESSAGECHAT")).toBe(true);
    expect(isKnownOpcode("SMSG_UPDATE_OBJECT")).toBe(true);
    // An opcode outside the whitelist stays unknown (and still streams, as
    // `UnknownEvent`). SMSG_TRAINER_LIST used to stand here; it is whitelisted
    // now, so the negative case moved to one the module does not serve.
    expect(isKnownOpcode("SMSG_TRADE_STATUS")).toBe(false);
  });

  test("every observed MSG_MOVE_* name shares the one movement payload", () => {
    for (const opcode of MOVE_OPCODES) {
      expect(isMoveOpcode(opcode)).toBe(true);
      const parsed = parseEventFrame(
        JSON.stringify({
          seq: 0,
          opcode,
          opcodeId: 0xb5,
          ts: 1,
          data: { guid: "42", flags: 1, pos: { x: 1, y: 2, z: 3, o: 4 } },
        }),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect((parsed.event as { schemaError?: string }).schemaError).toBeUndefined();
      expect((parsed.event.data as { guid: string }).guid).toBe("42");
    }
    // The server's own-guid teleport ack is in the observed set since
    // FOLLOW-UPS 46; the client's WORLDPORT echo never is.
    expect(isMoveOpcode("MSG_MOVE_TELEPORT_ACK")).toBe(true);
    expect(isMoveOpcode("MSG_MOVE_WORLDPORT_ACK")).toBe(false);
  });

  test("every fixture frame parses, envelope intact", () => {
    for (const frame of fullStream) {
      const result = parseEventFrame(JSON.stringify(frame));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const source = frame as { seq: number; opcode: string; opcodeId: number; ts: number };
      expect(result.event.seq).toBe(source.seq);
      expect(result.event.opcode).toBe(source.opcode);
      expect(result.event.opcodeId).toBe(source.opcodeId);
      expect(result.event.ts).toBe(source.ts);
    }
  });

  test("char enum decodes rows with decimal-string guids", () => {
    const result = parseEventFrame(JSON.stringify(loginSequence[1]));
    expect(result.ok).toBe(true);
    if (!result.ok || !isEvent(result.event, "SMSG_CHAR_ENUM")) throw new Error("wrong opcode");
    const data = result.event.data;
    if (isDecodeError(data)) throw new Error("unexpected decode error");
    expect(data.count).toBe(2);
    expect(data.characters[0]?.guid).toBe("7");
    expect(data.characters[1]?.name).toBe("Quilby");
  });

  test("chat decodes senderGuid as a decimal string", () => {
    const result = parseEventFrame(JSON.stringify(chatEcho));
    if (!result.ok || !isEvent(result.event, "SMSG_MESSAGECHAT")) throw new Error("wrong opcode");
    const data = result.event.data;
    if (isDecodeError(data)) throw new Error("unexpected decode error");
    expect(data.senderGuid).toBe("7");
    expect(guidKey(data.senderGuid)).toBe("7");
    expect(data.message).toBe("ping from the fixture");
  });

  test("a module decode failure is preserved, not dropped", () => {
    const result = parseEventFrame(JSON.stringify(undecodableChat));
    if (!result.ok) throw new Error("frame should still parse");
    expect(isDecodeError(result.event.data)).toBe(true);
  });

  test("a malformed data payload downgrades to schemaError but keeps the event", () => {
    const result = parseEventFrame(JSON.stringify(malformedChat));
    if (!result.ok) throw new Error("frame should still parse");
    expect(result.event.opcode).toBe("SMSG_MESSAGECHAT");
    expect((result.event as { schemaError?: string }).schemaError).toBeDefined();
  });

  test("an opcode added after this revision passes through with raw data", () => {
    const result = parseEventFrame(JSON.stringify(futureOpcode));
    if (!result.ok) throw new Error("unknown opcodes must not fail");
    expect(result.event.opcode).toBe("SMSG_TRAINER_LIST");
    expect((result.event.data as { count: number }).count).toBe(1);
  });

  test("a creature guid above 2^63 survives the frame as an exact string", () => {
    // The regression this pins: a guid emitted as a JSON *number* is corrupted
    // by JSON.parse before any schema can see it, so the fixture has to be a
    // string — as the module writes it — and it has to round-trip exactly.
    const frame = JSON.stringify(creatureCreate).replace(/\s+/g, "");
    expect(frame).toContain(`"guid":"${CREATURE_GUID}"`);
    const result = parseEventFrame(frame);
    if (!result.ok) throw new Error("update-object frame should parse");
    const objects = (result.event.data as { objects: { guid: string }[] }).objects;
    const guid = objects[0]?.guid as string;
    expect(guid).toBe(CREATURE_GUID);
    expect(guidKey(guid)).toBe(CREATURE_GUID);
    // …and the number path is exactly what it protects against.
    expect(String(Number(CREATURE_GUID))).not.toBe(CREATURE_GUID);
  });

  test("update blocks decode by kind, and an unknown kind still survives", () => {
    const parsed = updateObjectDataSchema.parse({
      blocks: 5,
      objects: [
        { update: "create", guid: "5", objectType: "gameObject", fields: { entry: 1, goState: 1 } },
        { update: "values", guid: "5", fields: { health: 3 } },
        { update: "movement", guid: "5", pos: { x: 1, y: 2, z: 3, o: 0 }, moveFlags: 2 },
        { update: "outOfRange", guids: ["5", "6"] },
        { update: "somethingLater", guid: "5" },
      ],
    });
    expect(parsed.objects.map((o) => o.update)).toEqual([
      "create",
      "values",
      "movement",
      "outOfRange",
      "somethingLater",
    ]);
    const outOfRange = parsed.objects[3] as unknown as { guids: string[] };
    expect(outOfRange.guids).toEqual(["5", "6"]);
  });

  test("a create block without a position parses — not every object has one", () => {
    const parsed = updateObjectDataSchema.parse({
      blocks: 1,
      objects: [{ update: "create", guid: "5", objectType: "item", fields: {} }],
    });
    expect((parsed.objects[0] as { pos?: unknown }).pos).toBeUndefined();
  });

  test("moveId is a number on the wire, and a numeric string is tolerated", () => {
    expect(moveToResponseSchema.parse({ ok: true, action: "move_to", token: "t", moveId: 3 }).moveId).toBe(3);
    expect(moveToResponseSchema.parse({ ok: true, action: "move_to", token: "t", moveId: "3" }).moveId).toBe(3);
  });

  test("a move status this revision does not know still parses", () => {
    const result = parseEventFrame(JSON.stringify(moveResult("some_future_status")));
    if (!result.ok) throw new Error("frame should parse");
    expect(isEvent(result.event, "WB_MOVE_RESULT")).toBe(true);
    expect((result.event.data as { status: string }).status).toBe("some_future_status");
  });

  test("a broken envelope is a parse failure, not a silent drop", () => {
    expect(parseEventFrame("not json").ok).toBe(false);
    expect(parseEventFrame(JSON.stringify({ opcode: "SMSG_MOTD" })).ok).toBe(false);
  });
});
