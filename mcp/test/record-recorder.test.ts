/**
 * The session recorder's drain (`src/record/recorder.ts`): the player names
 * the client cache was answered are handed to the host for the write gate's
 * scrub, each once, and again only when the answer changes.
 */

import { describe, expect, test } from "bun:test";
import { EventStream, StateCache } from "@wrathbench/sdk";
import { SessionRecorder } from "../src/record/recorder";

function rig() {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const state = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
  events.onAny((e) => {
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    state.apply(e);
  });
  let seq = 1;
  const named = (guid: string, name: string): void => {
    events.ingest(JSON.stringify({ seq: seq++, opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x51, ts: 1767225600000 + seq, data: { guid, found: true, name } }));
  };
  const client = { state, events };
  return { client, recorder: new SessionRecorder(client), named };
}

describe("the drain's player names", () => {
  test("are handed over once each, again when the answer changes, and absent when nothing is new", () => {
    const { recorder, named } = rig();
    expect(recorder.drain()).not.toHaveProperty("players");
    named("77", "Bystander");
    named("78", "Passerby");
    expect(recorder.drain().players).toEqual([
      ["77", "Bystander"],
      ["78", "Passerby"],
    ]);
    expect(recorder.drain()).not.toHaveProperty("players");
    named("77", "Renamed");
    expect(recorder.drain().players).toEqual([["77", "Renamed"]]);
  });

  test("a new recorder over a seeded cache hands over everything it holds", () => {
    const { client, recorder, named } = rig();
    named("77", "Bystander");
    recorder.drain();
    const again = new SessionRecorder(client);
    expect(again.drain().players).toEqual([["77", "Bystander"]]);
  });
});
