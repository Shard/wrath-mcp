/**
 * The fourth batch from the 2026-10-20 Deadmines party runs, the half that
 * changes what the model reads: a repair at an NPC that cannot repair, what
 * an equip displaced, and when an aura runs out. Every frame is
 * hand-written from module/PROTOCOL.md's tables with invented names and
 * positions.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { parseEventFrame } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, inventorySlot, ITEM_GUID_HI, itemCreate, itemQuery, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));
const world = (extra: readonly unknown[] = []) => frames([...loginSequence, selfCreate, ...extra]);

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function untilAction(stub: StubServer, action: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.filter((a) => a.action === action).length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

const NPC = "17365880163140632777";
const npcCreate = (seq: number, npcFlags: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: NPC,
        objectType: "unit",
        moveFlags: 0,
        pos: { x: -1233, y: 988, z: 42.125, o: 3.1 },
        fields: { entry: 90555, health: 300, maxHealth: 300, level: 30, faction: 12, npcFlags },
      },
    ],
  });
const npcName = (seq: number) =>
  frame(seq, "SMSG_CREATURE_QUERY_RESPONSE", { entry: 90555, found: true, name: "Odran Vell", subname: "", type: 7, rank: 0 });

describe("repairAll: an NPC with no repair role is refused before anything is sent", () => {
  test("a vendor that does not repair answers no_repair with its roles, and no packet goes out", async () => {
    const stub = startStub({ onConnect: () => world([npcCreate(20, 0x80), npcName(21)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 21, { timeout: 2000 });
    const r = await client.repairAll(NPC);
    expect(r).toEqual({
      ok: false,
      status: "no_repair",
      hint: 'Odran Vell does not repair (its roles: vendor), so nothing was sent; state.units({ role: "repair" }) lists the repairers in view',
    });
    expect(stub.actions.filter((a) => a.action === "repair_all")).toHaveLength(0);
    expect(client.drainActionHints()).toMatchObject([{ action: "repairAll", status: "no_repair" }]);
    client.close();
    await stub.stop();
  });

  test("a repairer, and an NPC whose flags were never observed, are sent as before", async () => {
    const stub = startStub({ onConnect: () => world([npcCreate(20, 0x1080)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 20, { timeout: 2000 });
    expect(await client.repairAll(NPC)).toMatchObject({ ok: true });
    expect(await client.repairAll("17365880163140630001")).toMatchObject({ ok: true });
    expect(stub.actions.filter((a) => a.action === "repair_all")).toHaveLength(2);
    client.close();
    await stub.stop();
  });
});

describe("equipItem: an equip names what it displaced", () => {
  const OLD_LO = 4400;
  const OLD_GUID = ((BigInt(ITEM_GUID_HI) << 32n) | BigInt(OLD_LO)).toString();
  const worn = frame(40, "SMSG_UPDATE_OBJECT", {
    blocks: 2,
    objects: [
      { update: "values", guid: SELF_GUID, fields: { invSlot15Lo: OLD_LO, invSlot15Hi: ITEM_GUID_HI } },
      { update: "create", guid: OLD_GUID, objectType: "item", fields: { entry: 55600, stackCount: 1 } },
    ],
  });
  const oldName = frame(41, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: 55600, found: true, name: "Tarnished Cleaver", quality: 2, sellPrice: 90 });

  test("the worn item swapped into the bags is the result's replaced", async () => {
    const stub = startStub({ onConnect: () => world([inventorySlot, itemCreate, itemQuery, worn, oldName]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 41, { timeout: 2000 });
    const pending = client.equipItem("Gritstone Charm", { timeout: 2000 });
    await untilAction(stub, "equip_item");
    // The swap: the new item into slot 15, the old one into the bag slot it left.
    const [lo, hi] = [Number(BigInt(itemCreate.data.objects[0]!.guid) & 0xffff_ffffn), ITEM_GUID_HI];
    push(stub, frame(70, "SMSG_UPDATE_OBJECT", {
      blocks: 1,
      objects: [{ update: "values", guid: SELF_GUID, fields: { invSlot15Lo: lo, invSlot15Hi: hi, invSlot23Lo: OLD_LO, invSlot23Hi: ITEM_GUID_HI } }],
    }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "equipped", name: "Gritstone Charm", equippedSlot: 15, replaced: { itemId: 55600, name: "Tarnished Cleaver" } });
    client.close();
    await stub.stop();
  });
});

const moveResult = (seq: number, moveId: number, extra: Record<string, unknown>) =>
  frame(seq, "WB_MOVE_RESULT", { moveId, status: "drop", pos: { x: -1234.5, y: 987.25, z: 42.125, o: 0 }, ...extra });
describe("moveTo: a climb refused at the character's own feet reads as any drop refusal", () => {
  test("moveTo and moveToAsync: the edge is where the move started, and the recipe stays the plain one", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 17, { timeout: 2000 });
    const pending = client.moveTo({ x: -1200, y: 950, z: 40 });
    await untilAction(stub, "move_to");
    push(stub, moveResult(90, 1, { dz: 46.08, reachedPos: { x: -1234.5, y: 987.25, z: 42.125 }, target: { x: -1200, y: 950, z: 40 } }));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "drop" });
    expect(r.hint).toEndWith("find the ramp/stairs.");
    client.drainActionHints();
    const ack = await client.moveToAsync({ x: -1200, y: 950, z: 40 });
    push(stub, moveResult(91, ack.moveId, { dz: 46.08, reachedPos: { x: -1234.5, y: 987.25, z: 42.125 } }));
    await client.events.waitFor((e) => e.seq === 91, { timeout: 2000 });
    await Bun.sleep(5);
    const [drop] = client.drainActionHints();
    expect(drop).toMatchObject({ action: "moveToAsync", status: "drop" });
    expect(drop!.hint).toEndWith("find the ramp/stairs.");
    client.close();
    await stub.stop();
  });
});

describe("aurasOf: expiresAt is when a timed aura runs out", () => {
  test("ts + duration for a timed aura, undefined for one with no timer", () => {
    const state = new StateCache();
    const parsed = parseEventFrame(
      JSON.stringify(
        frame(50, "SMSG_AURA_UPDATE_ALL", {
          targetGuid: SELF_GUID,
          auras: [
            { slot: 0, spellId: 7294, flags: 0x1f, level: 20, stacks: 0 },
            { slot: 1, spellId: 15007, flags: 0xaf, level: 20, stacks: 0, maxDuration: 600_000, duration: 599_988 },
          ],
        }, TS),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    state.apply(parsed.event);
    const [aura, sickness] = state.aurasOf(SELF_GUID);
    expect(aura!.expiresAt).toBeUndefined();
    expect(sickness!.expiresAt).toBe(TS + 599_988);
  });
});
