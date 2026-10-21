/**
 * The seventh batch of harness feedback from the 2026-10-21 Deadmines party
 * runs (attempt a2): an open group roll said where the loot window and the
 * harness block can see it, the trade window folded the way a client's
 * reads, the cast refusals a client explains, the character's own cast in
 * progress, and `moveToAsync`'s refusals answered as values. Packet sequences
 * follow the runs' own audit records; names, guids and positions are
 * invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import {
  BACKPACK_SLOT,
  CREATURE_GUID,
  creatureCreate,
  creatureQuery,
  frames,
  inventorySlot,
  ITEM_ENTRY,
  itemCreate,
  itemQuery,
  loginSequence,
  SELF_GUID,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));
const SEED = { guid: SELF_GUID, name: "Fenwick" };

const toEvents = (list: readonly unknown[]): GameEvent[] =>
  list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

async function untilAction(stub: StubServer, action: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.filter((a) => a.action === action).length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

// ------------------------------------------------------------- loot rolls

const ROLL_GUID = "4611686018427461302";
const CAPE = 5193;
const startRoll = (seq: number, mask = 0x03, countdownMs = 60_000) =>
  frame(seq, "SMSG_LOOT_START_ROLL", {
    rollGuid: ROLL_GUID,
    slot: 2,
    itemId: CAPE,
    count: 1,
    countdownMs,
    voteMask: mask,
    canNeed: (mask & 1) !== 0,
    canGreed: (mask & 2) !== 0,
    canDisenchant: (mask & 4) !== 0,
  });
const capeQuery = (seq: number) => frame(seq, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: CAPE, found: true, name: "Brigand's Cape", quality: 2 });

// a2 VanCleef, 03:43:48: the start-roll and the window in the same
// millisecond, the cape on slot 2 as slotType 1 (ROLL_ONGOING) beside two
// free-for-all slots.
describe("an open group roll is said where the window and the harness block show it", () => {
  test("lootCorpse names the roll, its seconds left and the lootRoll call; the harness block carries the frame opening", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, capeQuery(30)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", 30);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    push(stub, startRoll(70));
    push(stub, frame(71, "SMSG_LOOT_RESPONSE", {
      guid: CREATURE_GUID,
      lootType: 1,
      gold: 160,
      items: [{ slot: 0, itemId: 2874, count: 1, slotType: 0 }, { slot: 2, itemId: CAPE, count: 1, slotType: 1 }],
    }, TS + 70));
    push(stub, frame(72, "SMSG_ITEM_PUSH_RESULT", { playerGuid: SELF_GUID, itemId: 2874, count: 1, totalCount: 1, bagSlot: 255, itemSlot: 23, looted: true, created: false }, TS + 70));
    push(stub, frame(73, "SMSG_LOOT_RELEASE_RESPONSE", { guid: CREATURE_GUID }, TS + 2070));
    const loot = await pending;
    const LINE =
      'a group loot roll is open on "Brigand\'s Cape" (need/greed/pass, 58s left): vote with await sdk.lootRoll("Brigand\'s Cape", choice), ' +
      "choice one of the buttons listed. state.pendingRolls() holds each frame and its deadline; a frame left unvoted at its deadline counts as a pass";
    expect(loot).toMatchObject({ ok: true, status: "looted", items: [{ itemId: 2874, count: 1 }], hint: LINE });
    const hints = client.drainActionHints();
    expect(hints.map((h) => `${h.action} ${h.status}`)).toEqual(["lootRoll open"]);
    expect(hints[0]?.hint).toBe(LINE.replace("58s left", "60s left"));
    client.close();
    await stub.stop();
  });

  test("a roll whose item is not yet named is voted on by its id; a window without a roll slot has no hint", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery]) });
    const client = await inWorld(stub);
    push(stub, startRoll(40, 0x02));
    await folded(client, "SMSG_LOOT_START_ROLL", 40);
    expect(client.drainActionHints()[0]?.hint).toStartWith(
      'a group loot roll is open on "item 5193" (greed/pass, 60s left): vote with await sdk.lootRoll(5193, choice),',
    );
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    push(stub, frame(71, "SMSG_LOOT_RESPONSE", { guid: CREATURE_GUID, lootType: 1, gold: 5, items: [] }));
    push(stub, frame(72, "SMSG_LOOT_RELEASE_RESPONSE", { guid: CREATURE_GUID }));
    const loot = await pending;
    expect(loot.status).toBe("looted");
    expect("hint" in loot).toBe(false);
    client.close();
    await stub.stop();
  });

  // The core writes ObjectGuid::Empty as the source of every counted vote
  // and of the verdict (Group::CountRollVote / CountTheRoll), as the a2 audit
  // shows: the start-roll carried 4611686018427461302, both votes and the
  // win "0". Slot and item name the roll.
  test("the vote echo and the verdict with rollGuid 0 still close the frame they name by slot and item", () => {
    const base = [...loginSequence, startRoll(10), capeQuery(11)];
    const voted = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL", { rollGuid: "0", slot: 2, playerGuid: SELF_GUID, itemId: CAPE, roll: 128, rollType: 2, autoPass: false })]),
      { seed: SEED },
    );
    expect(voted.pendingRolls(TS + 13)).toEqual([]);
    const won = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL_WON", { rollGuid: "0", slot: 2, itemId: CAPE, winnerGuid: "978", roll: 36, rollType: 2 })]),
      { seed: SEED },
    );
    expect(won.pendingRolls(TS + 13)).toEqual([]);
  });
});

// ------------------------------------------------------------------ trade

const PARTNER = "981";
const tradeStatus = (seq: number, status: number, extra: Record<string, unknown> = {}) => frame(seq, "SMSG_TRADE_STATUS", { status, ...extra });
const theirSide = (seq: number, items: { slot: number; itemId: number; count: number }[], money = 0) =>
  frame(seq, "SMSG_TRADE_STATUS_EXTENDED", { theirs: true, money, spellId: 0, items: items.map((i) => ({ ...i, wrapped: false })) });
const bagWorld = () => frames([...loginSequence, selfCreate, inventorySlot, itemCreate, itemQuery]);

describe("state.trade() reads the window a client's trade frame shows", () => {
  // a2 mage, 03:13:17-03:14:32: six initiates answered busy while the healer
  // traded with the paladin, a seventh answered nothing, the window opened
  // when the healer began, the water went in, an accept met too far, and the
  // trade completed. traderGuid, mine and theirs never filled.
  test("the initiator: busy names who was asked, the window opens with them, and mine is what was placed", async () => {
    const stub = startStub({ onConnect: bagWorld });
    const client = await inWorld(stub);
    await folded(client, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", 38);
    await client.raw("CMSG_INITIATE_TRADE", [{ guid: PARTNER }]);
    push(stub, tradeStatus(40, 0));
    await folded(client, "SMSG_TRADE_STATUS", 40);
    expect(client.state.trade()).toMatchObject({
      status: 0, statusText: "busy: that player is already in a trade", open: false, traderGuid: PARTNER, mine: undefined, theirs: undefined,
    });
    // The seventh initiate: nothing comes back to the initiator.
    await client.raw("CMSG_INITIATE_TRADE", [{ guid: PARTNER }]);
    push(stub, tradeStatus(41, 2));
    await folded(client, "SMSG_TRADE_STATUS", 41);
    expect(client.state.trade()).toMatchObject({
      status: 2, statusText: "window open", open: true, traderGuid: PARTNER, mine: { money: 0, items: [] }, theirs: { money: 0, items: [] },
    });
    await client.raw("CMSG_SET_TRADE_ITEM", [{ u8: 0 }, { u8: 255 }, { u8: BACKPACK_SLOT }]);
    await client.raw("CMSG_SET_TRADE_GOLD", [{ u32: 250 }]);
    push(stub, tradeStatus(42, 7));
    await folded(client, "SMSG_TRADE_STATUS", 42);
    expect(client.state.trade()).toMatchObject({
      statusText: "back to trade: an accept was cleared",
      open: true,
      mine: { money: 250, items: [{ slot: 0, itemId: ITEM_ENTRY, name: "Gritstone Charm", count: 5 }] },
    });
    // An accept out of range: too far, then back to trade; the window stays.
    await client.raw("CMSG_ACCEPT_TRADE", [{ u32: 1 }]);
    push(stub, tradeStatus(43, 10));
    push(stub, tradeStatus(44, 7));
    await folded(client, "SMSG_TRADE_STATUS", 44);
    expect(client.state.trade()).toMatchObject({ status: 7, open: true, traderGuid: PARTNER, mine: { money: 250 } });
    await client.raw("CMSG_CLEAR_TRADE_ITEM", [{ u8: 0 }]);
    expect(client.state.trade()?.mine?.items).toEqual([]);
    push(stub, tradeStatus(45, 4));
    await folded(client, "SMSG_TRADE_STATUS", 45);
    expect(client.state.trade()).toMatchObject({ statusText: "the other side accepted", open: true });
    push(stub, tradeStatus(46, 8));
    await folded(client, "SMSG_TRADE_STATUS", 46);
    expect(client.state.trade()).toMatchObject({ status: 8, statusText: "trade complete", open: false, traderGuid: PARTNER, mine: undefined, theirs: undefined });
    client.close();
    await stub.stop();
  });

  // a2 healer, 03:13:40-03:14:32: the begin named the mage, the window
  // opened, the water arrived as the other side's EXTENDED, and a too-far
  // notice in between did not close the window.
  test("the receiver: the begin names the trader, theirs is the server's view, and a too-far notice keeps the window", () => {
    const cache = StateCache.replay(
      toEvents([
        ...loginSequence,
        tradeStatus(40, 1, { traderGuid: "978" }),
        tradeStatus(41, 2),
        tradeStatus(42, 7),
        theirSide(43, [{ slot: 0, itemId: ITEM_ENTRY, count: 10 }]),
        tradeStatus(44, 10),
        tradeStatus(45, 7),
        tradeStatus(46, 4),
      ]),
      { seed: SEED },
    );
    expect(cache.trade()).toMatchObject({
      status: 4,
      open: true,
      traderGuid: "978",
      mine: { money: 0, items: [] },
      theirs: { money: 0, items: [{ slot: 0, itemId: ITEM_ENTRY, count: 10 }] },
    });
    cache.apply(toEvents([tradeStatus(47, 3)])[0]!);
    expect(cache.trade()).toMatchObject({ status: 3, statusText: "trade canceled", open: false, traderGuid: "978", theirs: undefined });
  });
});

// --------------------------------------------------- casts and the cast bar

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", {
  spells: [
    { spellId: 6572, rank: 3, name: "Riposte Slam" },
    { spellId: 1715, rank: 1, name: "Hock" },
    { spellId: 7322, rank: 4, name: "Frost Lance" },
  ],
  cooldowns: [],
});
const castFailed = (seq: number, spellId: number, result: number, ts?: number) => frame(seq, "SMSG_CAST_FAILED", { spellId, result }, ts);
const spellStart = (seq: number, spellId: number, castTimeMs: number, ts?: number) =>
  frame(seq, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId, castTimeMs, targetGuid: CREATURE_GUID }, ts);
const spellFailure = (seq: number, spellId: number, ts?: number) =>
  frame(seq, "SMSG_SPELL_FAILURE", { casterGuid: SELF_GUID, spellId, result: 40 }, ts);
const spellGo = (seq: number, spellId: number, ts?: number) =>
  frame(seq, "SMSG_SPELL_GO", { casterGuid: SELF_GUID, spellId, hitGuids: [CREATURE_GUID], misses: [] }, ts);
const castWorld = () => frames([...loginSequence, SPELLS, selfCreate, creatureCreate, creatureQuery]);

describe("cast refusals a client explains say what they need", () => {
  // a2 tank: 132 Revenge refusals read "the server refused it"; one Hamstring
  // in Defensive Stance read the same.
  test("caster_aurastate, only_shapeshift and fleeing name the requirement", async () => {
    const stub = startStub({ onConnect: castWorld });
    const client = await inWorld(stub);
    await folded(client, "SMSG_CREATURE_QUERY_RESPONSE", creatureQuery.seq);
    let seq = 40;
    const refuse = async (spellId: number, result: number): Promise<string> => {
      await client.castSpell(spellId, CREATURE_GUID);
      push(stub, castFailed(seq, spellId, result));
      await folded(client, "SMSG_CAST_FAILED", seq++);
      const [h] = client.drainActionHints();
      return `${h!.action} ${h!.status}: ${h!.hint}`;
    };
    expect(await refuse(6572, 22)).toBe(
      "castSpell caster_aurastate: Riposte Slam (6572) on Thistlebore: needs a state first (e.g. after a dodge, parry or block)",
    );
    expect(await refuse(1715, 94)).toBe("castSpell only_shapeshift: Hock (1715) on Thistlebore: needs a different stance or form");
    expect(await refuse(7322, 34)).toBe("castSpell fleeing: Frost Lance (7322) on Thistlebore: you are fleeing (feared) and cannot act");
    client.close();
    await stub.stop();
  });
});

describe("state.self.casting: the cast bar, and the refusals it explains", () => {
  test("a cast time sets it, its own go or failure clears it, and a refusal of another cast leaves it", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, SPELLS, selfCreate, spellStart(40, 7322, 2100, TS + 1000)]), { seed: SEED });
    const fold = (f: unknown) => cache.apply(toEvents([f])[0]!);
    expect(cache.self.casting).toEqual({ value: { spellId: 7322, name: "Frost Lance", endsAt: TS + 3100 }, seq: 40, ts: TS + 1000 });
    fold(castFailed(41, 7322, 67));
    expect(cache.self.casting?.value.spellId).toBe(7322);
    // An instant cast, or somebody else's failure, is not this bar.
    fold(spellStart(42, 1715, 0));
    fold(frame(43, "SMSG_SPELL_FAILURE", { casterGuid: "978", spellId: 7322, result: 40 }));
    expect(cache.self.casting?.value.spellId).toBe(7322);
    fold(spellGo(44, 7322));
    expect(cache.self.casting).toBeUndefined();
    fold(spellStart(45, 7322, 2100));
    fold(spellFailure(46, 7322));
    expect(cache.self.casting).toBeUndefined();
  });

  // a2 mage, 03:40:37.737-03:40:39.280: Frostbolt casting (2.1s), a second
  // sent at +0.9s answered not_ready, a third at +1.5s cancelled the first
  // (CAST_FAILED interrupted, SPELL_FAILURE, then its own SPELL_START).
  test("not_ready and interrupted say you are still casting, when you are", async () => {
    const stub = startStub({ onConnect: castWorld });
    const client = await inWorld(stub);
    await folded(client, "SMSG_CREATURE_QUERY_RESPONSE", creatureQuery.seq);
    const T = TS + 10_000;
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, spellStart(40, 7322, 2100, T));
    await folded(client, "SMSG_SPELL_START", 40);
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(41, 7322, 67, T + 916));
    await folded(client, "SMSG_CAST_FAILED", 41);
    expect(client.drainActionHints().map((h) => `${h.action} ${h.status}: ${h.hint}`)).toEqual([
      "castSpell not_ready: Frost Lance (7322) on Thistlebore: you are still casting Frost Lance (7322), 1.2s left; " +
        "its cooldown, or the global cooldown, is still running",
    ]);
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(42, 7322, 40, T + 1543));
    push(stub, spellFailure(43, 7322, T + 1543));
    push(stub, spellStart(44, 7322, 2100, T + 1543));
    await folded(client, "SMSG_SPELL_START", 44);
    expect(client.drainActionHints().map((h) => `${h.action} ${h.status}: ${h.hint}`)).toEqual([
      "castSpell interrupted: Frost Lance (7322) on Thistlebore: you were still casting Frost Lance (7322), 0.6s left when your next cast went out, " +
        "and that cancelled it; cast again once state.self.casting is clear",
    ]);
    expect(client.state.self.casting?.value).toEqual({ spellId: 7322, name: "Frost Lance", endsAt: T + 1543 + 2100 });
    // With nothing on the bar, not_ready keeps its own words.
    push(stub, spellGo(45, 7322, T + 3643));
    await folded(client, "SMSG_SPELL_GO", 45);
    await client.castSpell(7322, CREATURE_GUID);
    push(stub, castFailed(46, 7322, 67, T + 3700));
    await folded(client, "SMSG_CAST_FAILED", 46);
    expect(client.drainActionHints()[0]?.hint).toBe("Frost Lance (7322) on Thistlebore: its cooldown, or the global cooldown, is still running");
    client.close();
    await stub.stop();
  });
});

// ------------------------------------------------------------ moveToAsync

describe("moveToAsync answers the refusals moveTo answers, with nothing sent", () => {
  test("a name nothing in view answers to is unknown_target, resolved and tallied", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const moved = await client.moveTo("Nobody Here");
    const queued = await client.moveToAsync("Nobody Here");
    expect(moved.status).toBe("unknown_target");
    expect(queued).toEqual({ ok: false, status: "unknown_target", hint: moved.hint as string });
    expect(stub.actions.filter((a) => a.action === "move_to")).toEqual([]);
    expect(client.drainActionHints().map((h) => `${h.action} ${h.status}`).sort()).toEqual(["moveTo unknown_target", "moveToAsync unknown_target"]);
    client.close();
    await stub.stop();
  });
});
