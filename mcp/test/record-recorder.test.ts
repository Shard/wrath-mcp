/**
 * The session recorder's drain (`src/record/recorder.ts`): the player names
 * the client cache was answered are handed to the host for the write gate's
 * scrub, each once, and again only when the answer changes; and the final
 * drain, the last before the client goes, catches up with the cache first.
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
  const feed = (opcode: string, opcodeId: number, data: unknown, ts: number): void => {
    events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts, data }));
  };
  const client = { state, events };
  // Never started, so no timer polls behind the test's back: a poll is the test's own call.
  return { client, recorder: new SessionRecorder(client), named, feed };
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

describe("the final drain", () => {
  const T0 = 1_767_225_600_000;

  test("catches the recorders up with the cache, so a move's verdict that landed after the last poll is written", () => {
    const { recorder, feed } = rig();
    feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map: 0, x: 100, y: 200, z: 30, o: 1 }, T0);
    recorder.trace.poll();
    recorder.events.poll();
    expect(recorder.drain().trace.rows.map((r) => [r.kind, r.x])).toEqual([["pos", 100]]);

    // The walk's verdict and a level, both in the cache, neither polled yet:
    // the session ends before the recorders' next tick.
    feed("WB_MOVE_RESULT", 0xff01, { moveId: 1, status: "arrived", pos: { x: 145, y: 200, z: 30, o: 1 } }, T0 + 9_000);
    feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields: { level: 6, xp: 0 } }] }, T0 + 9_100);
    const plain = recorder.drain();
    expect(plain.trace.rows.filter((r) => r.kind === "pos")).toEqual([]);
    expect(plain.events.rows.filter((r) => r.kind === "level")).toEqual([]);

    const last = recorder.drain({ final: true });
    expect(last.trace.rows.filter((r) => r.kind === "pos")).toEqual([{ ts: T0 + 9_000, kind: "pos", map: 0, x: 145, y: 200, z: 30, o: 1 }]);
    expect(last.events.rows.filter((r) => r.kind === "level")).toMatchObject([{ ts: T0 + 9_100, kind: "level", to: 6 }]);
  });

  test("writes the sample the trace held back for being on the heels of the last", () => {
    const { recorder, feed } = rig();
    feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map: 0, x: 100, y: 200, z: 30, o: 1 }, T0);
    recorder.trace.poll();
    feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 1, pos: { x: 140, y: 200, z: 30, o: 1 } }, T0 + 8_000);
    recorder.trace.poll();
    feed("WB_MOVE_RESULT", 0xff01, { moveId: 1, status: "arrived", pos: { x: 145, y: 200, z: 30, o: 1 } }, T0 + 8_100);
    recorder.trace.poll();
    expect(recorder.drain().trace.rows.map((r) => r.x)).toEqual([100, 140]);
    expect(recorder.drain({ final: true }).trace.rows.map((r) => r.x)).toEqual([145]);
  });
});
