/**
 * Quest objective areas: `SMSG_QUEST_POI_QUERY_RESPONSE` decoded, folded into
 * `state.questPois`, and the `questAreas` helper that asks for them with
 * `CMSG_QUEST_POI_QUERY`, against the stub module.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { isKnownOpcode, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, OTHER_QUEST_ID, QUEST_ID, questAccepted, questChained, questQueryResponse, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x1e4, ts: TS + seq, data });
const u32Hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");

/** One kill area (objective 0) and the turn-in (-1), points in world x/y as the wire carries them. */
const AREAS = [
  { poiId: 0, objectiveIndex: 0, map: 0, worldMapAreaId: 30, floor: 0, priority: 0, flags: 3, points: [{ x: -9100, y: -120 }, { x: -9080, y: -90 }, { x: -9120, y: -60 }] },
  { poiId: 1, objectiveIndex: -1, map: 0, worldMapAreaId: 30, floor: 0, priority: 0, flags: 1, points: [{ x: -8905, y: -160 }] },
];
const poiResponse = (seq: number, quests: unknown) => frame(seq, "SMSG_QUEST_POI_QUERY_RESPONSE", { quests });

function toEvents(list: readonly unknown[]): GameEvent[] {
  return list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
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

describe("protocol: SMSG_QUEST_POI_QUERY_RESPONSE", () => {
  test("decodes quests with their areas, a signed objective index and integer points", () => {
    expect(isKnownOpcode("SMSG_QUEST_POI_QUERY_RESPONSE")).toBe(true);
    const parsed = parseEventFrame(JSON.stringify(poiResponse(1, [{ questId: QUEST_ID, pois: AREAS }, { questId: OTHER_QUEST_ID, pois: [] }])));
    if (!parsed.ok || !("quests" in (parsed.event.data as object))) throw new Error("did not decode");
    expect((parsed.event as { schemaError?: string }).schemaError).toBeUndefined();
    const quests = (parsed.event.data as { quests: { questId: number; pois: { objectiveIndex: number; points: unknown[] }[] }[] }).quests;
    expect(quests[0]?.pois[1]?.objectiveIndex).toBe(-1);
    expect(quests[0]?.pois[0]?.points).toEqual([{ x: -9100, y: -120 }, { x: -9080, y: -90 }, { x: -9120, y: -60 }]);
    expect(quests[1]?.pois).toEqual([]);
  });
});

describe("state: questPois", () => {
  test("an answer is kept per quest, and a later empty answer does not erase the areas", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, poiResponse(40, [{ questId: QUEST_ID, pois: AREAS }]), poiResponse(41, [{ questId: QUEST_ID, pois: [] }, { questId: OTHER_QUEST_ID, pois: [] }])]),
      { seed: { guid: SELF_GUID, name: "Fenwick" } },
    );
    expect(cache.questPois.get(QUEST_ID)?.value).toEqual(AREAS);
    expect(cache.questPois.get(QUEST_ID)?.seq).toBe(40);
    expect(cache.questPois.get(OTHER_QUEST_ID)?.value).toEqual([]);
  });
});

describe("client: questAreas", () => {
  const holding = () => frames([...loginSequence, selfCreate, questAccepted, questChained, questQueryResponse()]);

  test("asks for every quest in the log in one query and returns each with its areas and title", async () => {
    const stub = startStub({ onConnect: holding });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 60, { timeout: 2000 });
    const ask = client.questAreas();
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_QUEST_POI_QUERY", payload: u32Hex(2) + u32Hex(QUEST_ID) + u32Hex(OTHER_QUEST_ID) });
    // The server's answer is in no particular order (it dedupes through an unordered_set).
    stub.push(JSON.stringify(poiResponse(500, [{ questId: OTHER_QUEST_ID, pois: [] }, { questId: QUEST_ID, pois: AREAS }])));
    const result = await ask;
    expect(result).toMatchObject({ ok: true, status: "answered" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.quests.map((q) => q.questId)).toEqual([QUEST_ID, OTHER_QUEST_ID]);
    expect(result.quests[0]?.title).toBeString();
    expect(result.quests[0]?.pois).toEqual(AREAS);
    expect(result.quests[1]?.pois).toEqual([]);
    expect(client.state.questPois.get(QUEST_ID)?.value).toEqual(AREAS);
    client.close();
    await stub.stop();
  });

  test("one named quest asks for that quest alone; a quest not in the log and an empty log send nothing", async () => {
    const stub = startStub({ onConnect: holding });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 60, { timeout: 2000 });
    const ask = client.questAreas(QUEST_ID);
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_QUEST_POI_QUERY", payload: u32Hex(1) + u32Hex(QUEST_ID) });
    stub.push(JSON.stringify(poiResponse(500, [{ questId: QUEST_ID, pois: AREAS }])));
    expect(await ask).toMatchObject({ ok: true, quests: [{ questId: QUEST_ID, pois: AREAS }] });

    const sent = stub.actions.length;
    const refused = await client.questAreas([QUEST_ID, 777]);
    expect(refused).toMatchObject({ ok: false, status: "not_in_log" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.hint).toContain("777");
    expect(stub.actions.length).toBe(sent);
    expect(client.drainActionHints()[0]).toMatchObject({ action: "questAreas", status: "not_in_log" });
    client.close();
    await stub.stop();

    const empty = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client2 = await inWorld(empty);
    await client2.events.waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT", { timeout: 2000 });
    expect(await client2.questAreas()).toMatchObject({ ok: false, status: "no_quests" });
    expect(empty.actions.filter((a) => a.action === "raw")).toEqual([]);
    client2.close();
    await empty.stop();
  });
});
