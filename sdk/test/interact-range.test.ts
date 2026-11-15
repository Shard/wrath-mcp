/**
 * Interaction helpers answer `too_far` at once, with nothing sent, when the
 * cached positions put the NPC or mailbox beyond any NPC's reach: the core
 * drops an out-of-range interaction without a word, and every such call used
 * to wait out its whole timeout. Inside the ceiling, with no position, for a
 * passenger on a transport and for any game object but a mailbox, the call
 * goes out as before. The fixture creature stands ~35y from the login
 * position; walking up puts the character 2y from it.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import {
  BACKPACK_SLOT,
  CREATURE_GUID,
  creatureCreate,
  creatureQuery,
  frames,
  inventorySlot,
  itemCreate,
  itemQuery,
  loginSequence,
  selfArrived,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => JSON.stringify({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const AT_CREATURE = { x: -1202, y: 980, z: 42 };
const LOGIN_POS = { x: -1234.5, y: 987.25, z: 42.125 };
const FAR_HINT = (what: string) => `the ${what} is 35y away — interact range is ~5y; moveTo it first`;

const world = (extra: readonly unknown[] = []) => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, ...extra]);
const carried = (extra: readonly unknown[] = []) =>
  frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, ...extra, inventorySlot, itemCreate, itemQuery]);

async function inWorld(stub: StubServer): Promise<WrathClient> {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  await Bun.sleep(20);
  return client;
}

async function untilAction(stub: StubServer, action: string, from = 0): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && a.action === action);
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}; saw ${stub.actions.map((a) => a.action).join(",")}`);
}

/** Everything the client sent after logging in, as action names (raw sends by their opcode). */
const sent = (stub: StubServer): string[] =>
  stub.actions.map((a) => (a.action === "raw" ? String((a as { opcode?: string }).opcode) : String(a.action)));

/** A unit at the fixture creature's spot, `fields` merged over the fixture's. */
function unitCreate(guid: string, seq: number, extra: { moveFlags?: number; objectType?: string; fields?: Record<string, number> } = {}) {
  const block = structuredClone(creatureCreate);
  const obj = block.data.objects[0] as Record<string, unknown>;
  obj.guid = guid;
  if (extra.moveFlags !== undefined) obj.moveFlags = extra.moveFlags;
  if (extra.objectType !== undefined) obj.objectType = extra.objectType;
  if (extra.fields !== undefined) obj.fields = { ...(obj.fields as Record<string, number>), ...extra.fields };
  block.seq = seq;
  return block;
}

/** A game object of `goType` at `pos`. */
function gameObjectCreate(guid: string, seq: number, goType: number, pos: { x: number; y: number; z: number }) {
  return {
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: TS + seq,
    data: { blocks: 1, objects: [{ update: "create", guid, objectType: "gameObject", pos: { ...pos, o: 0 }, fields: { entry: 32349, goType } }] },
  };
}

describe("past the reach ceiling an NPC interaction is too_far at once, with nothing sent", () => {
  test("trainerList, buySpell, bindAtInnkeeper, resetTalents and spiritHealerActivate answer too_far with the distance", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const before = stub.actions.length;
    const started = Date.now();
    const list = await client.trainerList(CREATURE_GUID, { timeout: 5000 });
    const buy = await client.buySpell(CREATURE_GUID, 100, { timeout: 5000 });
    const bind = await client.bindAtInnkeeper(CREATURE_GUID, { timeout: 5000 });
    const reset = await client.resetTalents(CREATURE_GUID, { timeout: 5000 });
    const healer = await client.spiritHealerActivate(CREATURE_GUID, { timeout: 5000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(list).toEqual({ ok: false, status: "too_far", spells: [], distance: 35, hint: FAR_HINT("trainer") });
    expect(buy).toEqual({ ok: false, status: "too_far", spellId: 100, distance: 35, hint: FAR_HINT("trainer") });
    expect(bind).toEqual({ ok: false, status: "too_far", distance: 35, hint: FAR_HINT("innkeeper") });
    expect(reset).toEqual({ ok: false, status: "too_far", distance: 35, hint: FAR_HINT("trainer") });
    expect(healer).toEqual({ ok: false, status: "too_far", distance: 35, hint: FAR_HINT("spirit healer") });
    expect(stub.actions.length).toBe(before);
    expect(client.drainActionHints().map((h) => `${h.action}:${h.status}`)).toEqual([
      "trainerList:too_far",
      "buySpell:too_far",
      "bindAtInnkeeper:too_far",
      "resetTalents:too_far",
      "spiritHealerActivate:too_far",
    ]);
    client.close();
    await stub.stop();
  });

  test("showTaxiNodes and openBank, which return a window, throw the same hint", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const before = stub.actions.length;
    const taxi = (await client.showTaxiNodes(CREATURE_GUID, { timeout: 5000 }).catch((e: unknown) => e)) as Error;
    const bank = (await client.openBank(CREATURE_GUID, { timeout: 5000 }).catch((e: unknown) => e)) as Error;
    expect(taxi.message).toBe(`showTaxiNodes(${CREATURE_GUID}): ${FAR_HINT("flight master")} (nothing was sent)`);
    expect(bank.message).toBe(`openBank(${CREATURE_GUID}): ${FAR_HINT("banker")} (nothing was sent)`);
    expect(stub.actions.length).toBe(before);
    client.close();
    await stub.stop();
  });

  test("a bank move after walking away from the banker is too_far", async () => {
    const stub = startStub({ onConnect: () => carried([selfArrived(20, AT_CREATURE)]) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
    const open = client.openBank(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "raw");
    stub.push(frame(530, "SMSG_SHOW_BANK", { guid: CREATURE_GUID }));
    await open;
    stub.push(JSON.stringify(selfArrived(531, LOGIN_POS)));
    await client.events.waitFor((e) => e.seq === 531, { timeout: 2000 });
    const before = stub.actions.length;
    expect(await client.bankDeposit(255, BACKPACK_SLOT, { timeout: 5000 })).toEqual({
      ok: false,
      status: "too_far",
      distance: 35,
      hint: FAR_HINT("banker"),
    });
    expect(await client.bankWithdraw(255, 39, { timeout: 5000 })).toMatchObject({ ok: false, status: "too_far", distance: 35 });
    expect(stub.actions.length).toBe(before);
    expect(client.drainActionHints().map((h) => `${h.action}:${h.status}`)).toEqual(["bankDeposit:too_far", "bankWithdraw:too_far"]);
    client.close();
    await stub.stop();
  });
});

describe("a mailbox is judged at its own range", () => {
  const MAILBOX = "17365880163140700001";

  test("a far mailbox throws from openMailbox; walking off an open one makes every mail call too_far", async () => {
    // The mailbox stands at the creature's spot, ~35y from the login position.
    const stub = startStub({ onConnect: () => world([gameObjectCreate(MAILBOX, 13, 19, { x: -1200, y: 980, z: 42 })]) });
    const client = await inWorld(stub);
    const mailHint = "the mailbox is 35y away — interact range is ~10y; moveTo it first";
    const far = (await client.openMailbox(MAILBOX, { timeout: 5000 }).catch((e: unknown) => e)) as Error;
    expect(far.message).toBe(`openMailbox(${MAILBOX}): ${mailHint} (nothing was sent)`);
    expect(sent(stub)).not.toContain("interact");

    stub.push(JSON.stringify(selfArrived(500, AT_CREATURE)));
    await client.events.waitFor((e) => e.seq === 500, { timeout: 2000 });
    const open = client.openMailbox(MAILBOX, { timeout: 2000 });
    await untilAction(stub, "raw");
    stub.push(frame(501, "SMSG_MAIL_LIST_RESULT", { total: 0, count: 0, mails: [] }));
    await open;

    stub.push(JSON.stringify(selfArrived(502, LOGIN_POS)));
    await client.events.waitFor((e) => e.seq === 502, { timeout: 2000 });
    const before = stub.actions.length;
    const tooFar = { ok: false, status: "too_far", distance: 35, hint: mailHint } as const;
    expect(await client.sendMail("Quilby", "s", "b", { timeout: 5000 })).toEqual(tooFar);
    expect(await client.takeMailMoney(7, { timeout: 5000 })).toEqual(tooFar);
    expect(await client.takeMailItem(7, 1, { timeout: 5000 })).toEqual(tooFar);
    expect(await client.deleteMail(7, { timeout: 5000 })).toEqual(tooFar);
    expect(() => client.mailList({ timeout: 5000 })).toThrow(`mailList(): ${mailHint} (nothing was sent)`);
    expect(stub.actions.length).toBe(before);
    expect(client.drainActionHints().map((h) => `${h.action}:${h.status}`)).toEqual([
      "sendMail:too_far",
      "takeMailMoney:too_far",
      "takeMailItem:too_far",
      "deleteMail:too_far",
    ]);
    client.close();
    await stub.stop();
  });
});

describe("whatever the cache cannot prove out of reach still goes out", () => {
  test("inside the ceiling but past 5y, trainerList sends and the silence is still the timeout", async () => {
    const stub = startStub({ onConnect: () => world([selfArrived(20, { x: -1220, y: 980, z: 42 })]) });
    const client = await inWorld(stub);
    const err = await client.trainerList(CREATURE_GUID, { timeout: 150 }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("EventTimeoutError");
    expect(sent(stub)).toContain("trainer_list");
    client.close();
    await stub.stop();
  });

  test("a guid with no observed position sends", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.trainerList("424242", { timeout: 100 }).catch(() => undefined);
    await client.buySpell("424242", 100, { timeout: 100 }).catch(() => undefined);
    expect(sent(stub)).toEqual(expect.arrayContaining(["trainer_list", "trainer_buy_spell"]));
    client.close();
    await stub.stop();
  });

  test("a creature riding a transport is not judged by the stale position it was sent at", async () => {
    const PASSENGER = "17365880163140700002";
    const stub = startStub({ onConnect: () => world([unitCreate(PASSENGER, 13, { moveFlags: 0x200 })]) });
    const client = await inWorld(stub);
    await client.trainerList(PASSENGER, { timeout: 100 }).catch(() => undefined);
    expect(sent(stub)).toContain("trainer_list");
    client.close();
    await stub.stop();
  });

  test("a questgiver game object, whose reach is its model's box, is asked however far it looks", async () => {
    const BOARD = "17365880163140700003";
    const stub = startStub({ onConnect: () => world([gameObjectCreate(BOARD, 13, 2, { x: -1200, y: 980, z: 42 })]) });
    const client = await inWorld(stub);
    await client.questsAvailableFrom(BOARD, { timeout: 100 }).catch(() => undefined);
    expect(sent(stub)).toContain("interact");
    client.close();
    await stub.stop();
  });

  test("a player is never judged: the core puts no NPC range on one", async () => {
    const OTHER = "9";
    const stub = startStub({ onConnect: () => world([unitCreate(OTHER, 13, { objectType: "player" })]) });
    const client = await inWorld(stub);
    await client.questsAvailableFrom(OTHER, { timeout: 100 }).catch(() => undefined);
    expect(sent(stub)).toContain("quest_list");
    client.close();
    await stub.stop();
  });
});
