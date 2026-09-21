import { readFileSync } from "node:fs";

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

  test("session response decodes guid to an opaque decimal string", () => {
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
      "SMSG_LOOT_START_ROLL",
      "SMSG_LOOT_ROLL",
      "SMSG_LOOT_ROLL_WON",
      "SMSG_LOOT_ALL_PASSED",
      "SMSG_LOOT_MASTER_LIST",
      "SMSG_READ_ITEM_OK",
      "SMSG_READ_ITEM_FAILED",
      "SMSG_PAGE_TEXT_QUERY_RESPONSE",
      "SMSG_ITEM_TEXT_QUERY_RESPONSE",
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
      "MSG_TALENT_WIPE_CONFIRM",
      "WB_TALENT_TREE",
      "SMSG_INITIALIZE_FACTIONS",
      "SMSG_SET_FACTION_STANDING",
      "SMSG_SET_FACTION_VISIBLE",
      "SMSG_PET_SPELLS",
      "SMSG_PET_ACTION_FEEDBACK",
      "SMSG_PET_TAME_FAILURE",
      "SMSG_PET_CAST_FAILED",
      "SMSG_PET_NAME_QUERY_RESPONSE",
      "SMSG_PET_NAME_INVALID",
      "SMSG_GROUP_INVITE",
      "SMSG_GROUP_DECLINE",
      "SMSG_GROUP_SET_LEADER",
      "SMSG_GROUP_UNINVITE",
      "SMSG_GROUP_DESTROYED",
      "SMSG_PARTY_COMMAND_RESULT",
      "SMSG_GROUP_LIST",
      "SMSG_SHOW_MAILBOX",
      "SMSG_RECEIVED_MAIL",
      "SMSG_SEND_MAIL_RESULT",
      "SMSG_MAIL_LIST_RESULT",
      "SMSG_SHOW_BANK",
      "SMSG_BUY_BANK_SLOT_RESULT",
      "SMSG_TRADE_STATUS",
      "SMSG_TRADE_STATUS_EXTENDED",
      "SMSG_ACHIEVEMENT_EARNED",
      "SMSG_ALL_ACHIEVEMENT_DATA",
      "SMSG_ACTIVATETAXIREPLY",
      "SMSG_SHOWTAXINODES",
      "SMSG_BINDER_CONFIRM",
      "SMSG_BINDPOINTUPDATE",
      "SMSG_PLAYERBOUND",
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
    // `UnknownEvent`). SMSG_TRAINER_LIST and then SMSG_TRADE_STATUS stood here; both are whitelisted
    // now, so the negative case moved to one the module does not serve.
    expect(isKnownOpcode("SMSG_AUCTION_LIST_RESULT")).toBe(false);
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
    // The client's WORLDPORT echo never is.
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

describe("the social seam decodes across the protocol / protocol-social split", () => {
  // These are the frames the split could break silently. `eventDataSchemas`
  // lives in `protocol.ts` and names schemas defined in `protocol-social.ts`,
  // which needs `guidSchema` at module-evaluation time; take that schema back
  // from `protocol.ts` instead of from the `./guid` leaf and the const lands
  // in the TDZ — a ReferenceError on import that types erase past and `tsc`
  // cannot see. One frame per seam family, each asserting the guid transform
  // actually ran, so a schema lost behind a broken re-export fails here rather
  // than passing data through unvalidated. The import-shape test below is the
  // other half: decoding proves today's graph evaluates, not that the arrow
  // between the two files still points the only way that is safe.

  const frame = (opcode: string, opcodeId: number, data: unknown): string =>
    JSON.stringify({ seq: 1, opcode, opcodeId, ts: 1_000, data });

  const decode = (opcode: string, opcodeId: number, data: unknown): Record<string, unknown> => {
    const result = parseEventFrame(frame(opcode, opcodeId, data));
    if (!result.ok) throw new Error(`${opcode}: frame did not parse`);
    const schemaError = (result.event as { schemaError?: string }).schemaError;
    if (schemaError !== undefined) throw new Error(`${opcode}: ${schemaError}`);
    if (isDecodeError(result.event.data)) throw new Error(`${opcode}: decode error`);
    return result.event.data as Record<string, unknown>;
  };

  // The decode tests above prove today's graph works. This one pins the arrow
  // direction that makes it work, which is the part a future edit breaks
  // silently: one IDE auto-import of `guidSchema` from "./protocol" instead of
  // "./guid" restores the cycle, and it survives today only because
  // `protocol.ts` happens to import (and re-export) `./guid` first. Whichever
  // module the graph is entered through, one of the two sides ends up reading
  // a `const` that has not been initialised.
  test("protocol-social reaches for nothing in protocol, and state-social only for types", () => {
    const importsOf = (file: string): string[] =>
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("import"));

    expect(importsOf("protocol-social.ts").filter((l) => l.includes('from "./protocol"'))).toEqual([]);

    // The state half is acyclic for a weaker reason — its back-reference is
    // erased — so the `type` keyword is the whole guarantee.
    const back = importsOf("state-social.ts").filter((l) => l.includes('from "./state"'));
    expect(back.length).toBe(1);
    expect(back.filter((l) => !l.startsWith("import type "))).toEqual([]);
  });

  test("every seam opcode is still in the known whitelist", () => {
    for (const opcode of [
      "SMSG_PET_SPELLS",
      "SMSG_GROUP_LIST",
      "SMSG_MAIL_LIST_RESULT",
      "SMSG_TRADE_STATUS",
      "SMSG_LOOT_START_ROLL",
      "SMSG_ITEM_TEXT_QUERY_RESPONSE",
    ]) {
      expect(isKnownOpcode(opcode)).toBe(true);
    }
  });

  test("pets: SMSG_PET_SPELLS", () => {
    const data = decode("SMSG_PET_SPELLS", 0x0179, {
      guid: "007",
      removed: false,
      reactState: 1,
      commandState: 1,
      actionBar: [{ slot: 0, type: 0x07, command: 1 }],
      spells: [{ spellId: 2649, active: 0xc1, autocast: true }],
    });
    expect(data.guid).toBe("7");
    expect((data.actionBar as { command: number }[])[0]?.command).toBe(1);
  });

  test("group: SMSG_GROUP_LIST", () => {
    const data = decode("SMSG_GROUP_LIST", 0x007d, {
      groupType: 0,
      left: false,
      raid: false,
      subGroup: 0,
      memberFlags: 0,
      roles: 0,
      groupGuid: "0x0",
      counter: 1,
      leaderGuid: "007",
      members: [{ name: "Quilby", guid: "0000009", online: true, subGroup: 0, flags: 0, roles: 0 }],
    });
    expect(data.leaderGuid).toBe("7");
    expect((data.members as { guid: string }[])[0]?.guid).toBe("9");
  });

  test("mail: SMSG_MAIL_LIST_RESULT", () => {
    const data = decode("SMSG_MAIL_LIST_RESULT", 0x023b, {
      total: 1,
      count: 1,
      mails: [{
        mailId: 42, type: 0, senderGuid: "007", cod: 0, stationery: 41, money: 100,
        flags: 0, read: false, daysLeft: 30, templateId: 0, subject: "hi", body: "there", items: [],
      }],
    });
    expect((data.mails as { senderGuid: string }[])[0]?.senderGuid).toBe("7");
  });

  test("trade: SMSG_TRADE_STATUS", () => {
    const data = decode("SMSG_TRADE_STATUS", 0x0120, { status: 1, traderGuid: "007" });
    expect(data.traderGuid).toBe("7");
  });

  test("group loot rolls: SMSG_LOOT_START_ROLL", () => {
    const data = decode("SMSG_LOOT_START_ROLL", 0x02a1, {
      rollGuid: "007", slot: 0, itemId: 2589, count: 1, countdownMs: 60_000,
      voteMask: 7, canNeed: true, canGreed: true, canDisenchant: false,
    });
    expect(data.rollGuid).toBe("7");
  });

  test("item text: SMSG_ITEM_TEXT_QUERY_RESPONSE", () => {
    const data = decode("SMSG_ITEM_TEXT_QUERY_RESPONSE", 0x0244, { found: true, guid: "007", text: "a letter" });
    expect(data.guid).toBe("7");
    expect(data.text).toBe("a letter");
  });

  test("bank: SMSG_SHOW_BANK carries the banker's guid", () => {
    const data = decode("SMSG_SHOW_BANK", 0x01b7, { guid: "007" });
    expect(data.guid).toBe("7");
  });
});
