/**
 * The fourth batch of harness feedback from the 2026-10-20 Deadmines party
 * runs, the corrections that change no text the model reads: a release
 * that returned before its port landed, and a spirit healer's silence
 * explained after the healer had left view. Every frame is hand-written from
 * module/PROTOCOL.md's tables with invented names and positions.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { deathReleaseLoc, frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
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

const selfValues = (seq: number, fields: Record<string, number>) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] });
/** Dead and not released: health 0, no ghost flag. */
const corpse = (seq: number) => selfValues(seq, { health: 0, playerFlags: 0 });
/** Released: a ghost's health of 1 and PLAYER_FLAGS_GHOST. */
const ghostFields = (seq: number) => selfValues(seq, { health: 1, playerFlags: 0x10 });
const area = (seq: number, areaId: number, areaName: string) =>
  frame(seq, "WB_AREA", { mapId: 0, mapName: "Eastern Kingdoms", instanceType: 0, zoneId: 40, zoneName: "Westfall", areaId, areaName });

const GRAVEYARD = { map: 0, x: -2546.9, y: 1197.24, z: 31.7263 };

describe("repop: the call returns once its own release has landed", () => {
  test("a far port: position, ghost flag and area are the graveyard's when the call returns", async () => {
    const stub = startStub({ onConnect: () => world([corpse(20)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 20, { timeout: 2000 });
    const pending = client.repop();
    await untilAction(stub, "repop");
    // The order a release from a dungeon sends it in (rogue, 13:32:42), with
    // the ghost flag a tick behind.
    push(stub, frame(90, "SMSG_TRANSFER_PENDING", { map: 0 }));
    push(stub, frame(91, "SMSG_NEW_WORLD", { ...GRAVEYARD, o: 6.18 }));
    push(stub, deathReleaseLoc(92, GRAVEYARD));
    setTimeout(() => push(stub, ghostFields(93)), 15);
    setTimeout(() => push(stub, area(94, 108, "Sentinel Hill")), 25);
    const ack = await pending;
    expect(ack).toMatchObject({ ok: true });
    expect(client.state.self.position?.value).toMatchObject({ map: 0, x: GRAVEYARD.x, y: GRAVEYARD.y });
    expect(client.state.self.ghost?.value).toBe(true);
    expect(client.state.self.area?.value.name).toBe("Sentinel Hill");
    client.close();
    await stub.stop();
  });

  test("a same-map port: the teleport ack lands before the release marker", async () => {
    const stub = startStub({ onConnect: () => world([corpse(20)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 20, { timeout: 2000 });
    const pending = client.repop();
    await untilAction(stub, "repop");
    // The paladin's order at 14:17:02: the ack, then the marker, then the fields.
    push(stub, frame(90, "MSG_MOVE_TELEPORT_ACK", { guid: SELF_GUID, flags: 0, pos: { x: -1606.8, y: 294.05, z: 31.8, o: 4.7 } }));
    push(stub, deathReleaseLoc(91, { map: 0, x: -1606.8, y: 294.05, z: 31.8 }));
    setTimeout(() => push(stub, ghostFields(92)), 10);
    await pending;
    expect(client.state.self.position?.value).toMatchObject({ x: -1606.8, y: 294.05 });
    expect(client.state.self.ghost?.value).toBe(true);
    client.close();
    await stub.stop();
  });

  test("the living and a ghost are not released, and the call does not wait", async () => {
    const stub = startStub({ onConnect: () => world([ghostFields(20)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 20, { timeout: 2000 });
    const started = Date.now();
    await client.repop();
    expect(Date.now() - started).toBeLessThan(500);
    push(stub, selfValues(21, { health: 80, playerFlags: 0 }));
    await client.events.waitFor((e) => e.seq === 21, { timeout: 2000 });
    const again = Date.now();
    await client.repop();
    expect(Date.now() - again).toBeLessThan(500);
    expect(stub.actions.filter((a) => a.action === "repop")).toHaveLength(2);
    client.close();
    await stub.stop();
  });

  test("a release the server never makes ends the wait at its bound, with the ack", async () => {
    const stub = startStub({ onConnect: () => world([corpse(20)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 20, { timeout: 2000 });
    const started = Date.now();
    const ack = await client.repop();
    const waited = Date.now() - started;
    expect(ack).toMatchObject({ ok: true });
    expect(waited).toBeGreaterThanOrEqual(2900);
    expect(waited).toBeLessThan(4000);
    client.close();
    await stub.stop();
  }, 8000);
});

const HEALER = "17365880163140632999";
const healerCreate = (seq: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: HEALER,
        objectType: "unit",
        moveFlags: 0,
        pos: { x: -1234.5, y: 1004.25, z: 42.125, o: 3.1 },
        fields: { entry: 90777, health: 4121, maxHealth: 4121, level: 60, faction: 35, unitFlags: 768, npcFlags: 0x4001 },
      },
    ],
  });

describe("spiritHealerActivate: a silence is explained with the distance at dispatch", () => {
  test("a healer that leaves view during the wait still has its distance", async () => {
    // selfCreate stands at (-1234.5, 987.25, 42.125): the healer is 17y north.
    const stub = startStub({ onConnect: () => world([ghostFields(20), healerCreate(21)]) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 21, { timeout: 2000 });
    const pending = client.spiritHealerActivate(HEALER, { timeout: 300 });
    await untilAction(stub, "spirit_healer_activate");
    push(stub, frame(90, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "outOfRange", guids: [HEALER] }] }));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "unconfirmed", distance: 17 });
    expect(r.ok === false && r.hint).toContain("You are 17y from the spirit healer");
    client.close();
    await stub.stop();
  });
});
