/**
 * Replies to allowlisted raw opcodes and the smaller observation taps: each
 * decodes in PROTOCOL.md's shape, and the two that fold into `state.self`
 * (a cast's pushback, the proficiency masks) fold as a client reads them.
 */
import { describe, expect, test } from "bun:test";

import { isKnownOpcode, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { CREATURE_GUID, loginSequence, SELF_GUID, selfCreate } from "./fixtures";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });

function parse(f: unknown): GameEvent {
  const parsed = parseEventFrame(JSON.stringify(f));
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
  const schemaError = (parsed.event as { schemaError?: string }).schemaError;
  if (schemaError !== undefined) throw new Error(`schema: ${schemaError}`);
  return parsed.event;
}

const replay = (list: readonly unknown[]) => StateCache.replay(list.map(parse), { seed: { guid: SELF_GUID, name: "Fenwick" } });

describe("reply and observation taps decode", () => {
  test.each([
    ["SMSG_PLAYED_TIME", { totalSec: 86_400, levelSec: 3_600, show: true }],
    ["SMSG_QUERY_TIME_RESPONSE", { serverTime: 1_700_000_000, dailyResetInSec: 7_200 }],
    ["SMSG_NPC_TEXT_UPDATE", { textId: 68, texts: [{ probability: 1, text: "Well met, $N.", textFemale: "Well met, $N.", language: 0 }] }],
    ["SMSG_TAXINODE_STATUS", { guid: CREATURE_GUID, known: true }],
    ["SMSG_NEW_TAXI_PATH", {}],
    ["SMSG_SET_PROFICIENCY", { itemClass: 2, subclassMask: 0x4011 }],
    ["SMSG_SPELLORDAMAGE_IMMUNE", { casterGuid: SELF_GUID, targetGuid: CREATURE_GUID, spellId: 133, rank: 1, name: "Test Bolt" }],
    ["SMSG_ENVIRONMENTAL_DAMAGE_LOG", { victimGuid: SELF_GUID, type: 2, amount: 120, resist: 0, absorb: 0 }],
    ["SMSG_SPELL_DELAYED", { casterGuid: SELF_GUID, delayMs: 500 }],
    ["SMSG_EMOTE", { guid: CREATURE_GUID, emoteId: 4 }],
    ["SMSG_TEXT_EMOTE", { guid: CREATURE_GUID, textEmote: 78, emoteNum: 0, targetName: "Fenwick" }],
    ["SMSG_TEXT_EMOTE", { guid: CREATURE_GUID, textEmote: 78, emoteNum: 0, targetName: "" }],
    // The tail by notice type: a player (joined), two (kicked), a name (invited),
    // the join and leave of our own, a mode change, and a notice with no tail.
    ["SMSG_CHANNEL_NOTIFY", { type: 0, channel: "General - Elwynn Forest", guid: CREATURE_GUID }],
    ["SMSG_CHANNEL_NOTIFY", { type: 18, channel: "Trade", guid: CREATURE_GUID, byGuid: SELF_GUID }],
    ["SMSG_CHANNEL_NOTIFY", { type: 29, channel: "Trade", playerName: "Fenwick" }],
    ["SMSG_CHANNEL_NOTIFY", { type: 2, channel: "General", flags: 0x18, channelId: 1 }],
    ["SMSG_CHANNEL_NOTIFY", { type: 3, channel: "General", channelId: 1, constant: true }],
    ["SMSG_CHANNEL_NOTIFY", { type: 12, channel: "Trade", guid: SELF_GUID, oldFlags: 0, flags: 2 }],
    ["SMSG_CHANNEL_NOTIFY", { type: 5, channel: "Trade" }],
  ])("%s", (opcode, data) => {
    expect(isKnownOpcode(opcode)).toBe(true);
    expect(parse(frame(1, opcode, data)).data).toEqual(data);
  });
});

describe("state", () => {
  test("a pushback moves our own cast's end; another caster's does not", () => {
    const start = frame(40, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId: 133, castTimeMs: 2500 });
    let cache = replay([...loginSequence, selfCreate, start, frame(41, "SMSG_SPELL_DELAYED", { casterGuid: SELF_GUID, delayMs: 500 })]);
    expect(cache.self.casting?.value.endsAt).toBe(TS + 40 + 2500 + 500);
    cache = replay([...loginSequence, selfCreate, start, frame(41, "SMSG_SPELL_DELAYED", { casterGuid: CREATURE_GUID, delayMs: 500 })]);
    expect(cache.self.casting?.value.endsAt).toBe(TS + 40 + 2500);
  });

  test("proficiency keeps each item class's whole mask, the latest per class", () => {
    const cache = replay([
      ...loginSequence,
      selfCreate,
      frame(40, "SMSG_SET_PROFICIENCY", { itemClass: 2, subclassMask: 0x0011 }),
      frame(41, "SMSG_SET_PROFICIENCY", { itemClass: 4, subclassMask: 0x0007 }),
      frame(42, "SMSG_SET_PROFICIENCY", { itemClass: 2, subclassMask: 0x4011 }),
    ]);
    expect(cache.self.proficiency?.value).toEqual({ weaponMask: 0x4011, armorMask: 0x0007 });
  });
});
