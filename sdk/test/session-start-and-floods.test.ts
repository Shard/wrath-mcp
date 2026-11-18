/**
 * Contract fixes the 2026-11-16 runs earned (operator, 2026-11-18):
 * `createSession` resolves with the own position folded, `questAreas` answers
 * a loop without flooding the server past its AntiDOS kick, a fresh
 * character's zero coinage, XP and rage read as 0 rather than unobserved,
 * and the SDK reference documents `state.self.dead` as the plain boolean it
 * is. Frames are hand-written from module/PROTOCOL.md with invented names.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { API_MD_PATH } from "../src/reference";
import { StateCache } from "../src/state";
import { frames, loginSequence, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const SEED = { guid: "7", name: "Fenwick" };
const [AUTH, ENUM, VERIFY_WORLD] = loginSequence;

function toEvents(list: readonly unknown[]): GameEvent[] {
  return list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

/** Our own create block with `fields` in place of the fixture's. */
const selfWith = (seq: number, fields: Record<string, number>) => ({
  ...selfCreate,
  seq,
  data: { blocks: 1, objects: [{ ...(selfCreate.data.objects[0] as object), fields }] },
});

describe("createSession: the own position is there when it resolves", () => {
  test("an answer that outran the login's position waits for it", async () => {
    // The event stream brings only the handshake at first; the position
    // follows the module's answer, as the two sockets let it.
    const stub = startStub({ onConnect: () => frames([AUTH, ENUM]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    const created = client.createSession({ character: "Fenwick" });
    setTimeout(() => stub.push(JSON.stringify(VERIFY_WORLD)), 150);
    await created;
    expect(client.state.self.position?.value).toMatchObject({ map: 0, x: -1234.5, y: 987.25 });
    client.close();
    await stub.stop();
  });

  test("a login stream whose own create came with no position does not wait out the bound", async () => {
    const stub = startStub({ onConnect: () => frames([AUTH, ENUM, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.events.waitFor((e) => e.seq === 17, { timeout: 2000 });
    const start = Date.now();
    await client.createSession({ character: "Fenwick" });
    expect(Date.now() - start).toBeLessThan(1_000);
    client.close();
    await stub.stop();
  });
});

describe("questAreas: a loop is answered without flooding the server", () => {
  const QUESTS = Array.from({ length: 12 }, (_, i) => 900 + i);
  /** A quest log of twelve quests, so twelve distinct queries can be asked. */
  const holding = () => {
    const fields: Record<string, number> = { ...(selfCreate.data.objects[0] as { fields: Record<string, number> }).fields };
    QUESTS.forEach((id, slot) => (fields[`quest${slot}Id`] = id));
    return frames([...loginSequence, selfWith(17, fields)]);
  };
  const answer = (stub: StubServer, seq: number, ids: readonly number[]) =>
    stub.push(JSON.stringify({ seq, opcode: "SMSG_QUEST_POI_QUERY_RESPONSE", opcodeId: 0x1e4, ts: 1_700_000_000_000 + seq, data: { quests: ids.map((questId) => ({ questId, pois: [] })) } }));
  const sent = (stub: StubServer) => stub.actions.filter((a) => a.action === "raw" && a.opcode === "CMSG_QUEST_POI_QUERY").length;
  async function inWorld(stub: StubServer): Promise<WrathClient> {
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitFor((e) => e.seq === 17, { timeout: 2000 });
    return client;
  }

  test("asks in flight are shared, and the same ask within a second is answered again from the last answer", async () => {
    const stub = startStub({ onConnect: holding });
    const client = await inWorld(stub);
    const a = client.questAreas(QUESTS[0]);
    const b = client.questAreas(QUESTS[0]);
    for (let i = 0; i < 100 && sent(stub) === 0; i++) await Bun.sleep(5);
    answer(stub, 500, [QUESTS[0]!]);
    expect(await a).toMatchObject({ ok: true, quests: [{ questId: QUESTS[0], pois: [] }] });
    expect(await b).toMatchObject({ ok: true, quests: [{ questId: QUESTS[0], pois: [] }] });
    expect(sent(stub)).toBe(1);
    // Asked again at once: the answer a moment old, nothing sent.
    expect(await client.questAreas(QUESTS[0])).toMatchObject({ ok: true, quests: [{ questId: QUESTS[0] }] });
    expect(sent(stub)).toBe(1);
    // A second later it asks the server again.
    await Bun.sleep(1_050);
    const again = client.questAreas(QUESTS[0]);
    for (let i = 0; i < 100 && sent(stub) === 1; i++) await Bun.sleep(5);
    expect(sent(stub)).toBe(2);
    answer(stub, 501, [QUESTS[0]!]);
    await again;
    client.close();
    await stub.stop();
  });

  test("no more than 10 go out in a second, well under the 25 the core kicks at", async () => {
    const stub = startStub({ onConnect: holding });
    const client = await inWorld(stub);
    const asks = QUESTS.map((id) => client.questAreas(id, { timeout: 3_000 }).catch(() => undefined));
    await Bun.sleep(300);
    expect(sent(stub)).toBe(10);
    await Bun.sleep(1_000);
    expect(sent(stub)).toBe(12);
    answer(stub, 500, QUESTS);
    await Promise.all(asks);
    client.close();
    await stub.stop();
  });
});

describe("state: a create block's omitted coinage, XP and power read 0", () => {
  test("a fresh warrior's coinage, XP and rage are 0 once its own create has folded", () => {
    const warrior = selfWith(17, { entry: 0, health: 80, maxHealth: 100, level: 1, powerType: 1, maxPower2: 1000, nextLevelXp: 400, playerFlags: 0 });
    const cache = StateCache.replay(toEvents([...loginSequence, warrior]), { seed: SEED });
    expect(cache.money?.value).toBe(0);
    expect(cache.xp?.value).toBe(0);
    expect(cache.nextLevelXp?.value).toBe(400);
    expect(cache.self.power?.value).toEqual({ current: 0, max: 1000 });
    // Only the power the character uses is stated, not every power field.
    expect(cache.self.fields.has("power1")).toBe(false);
  });

  test("a later ordinary self create still merges: a value held is not zeroed by its absence", () => {
    const first = selfWith(17, { health: 80, maxHealth: 100, level: 3, powerType: 1, power2: 300, maxPower2: 1000, money: 350, xp: 120 });
    const later = selfWith(40, { health: 70, maxHealth: 100, level: 3, powerType: 1, maxPower2: 1000 });
    const cache = StateCache.replay(toEvents([...loginSequence, first, later]), { seed: SEED });
    expect(cache.money?.value).toBe(350);
    expect(cache.xp?.value).toBe(120);
    expect(cache.self.power?.value).toEqual({ current: 300, max: 1000 });
  });
});

describe("the SDK reference: state.self.dead", () => {
  test("is documented as the one plain boolean, with no .value", () => {
    const api = readFileSync(API_MD_PATH, "utf8");
    expect(api).toContain("`state.self.dead` (no `.value`; `state.self.dead.value` is always");
    expect(api).toContain("is true while you are dead, as an unreleased corpse or as a ghost");
  });
});
