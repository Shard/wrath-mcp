import { describe, expect, test } from "bun:test";

import { EventStream, EventTimeoutError, STREAM_ERROR, STREAM_GAP } from "../src/events";
import type { StreamEvent } from "../src/events";
import { chatEcho, frames, fullStream, loginSequence } from "./fixtures";
import { startStub } from "./server";

/** A stream with no socket, driven by `ingest`. Ordering/gap logic only. */
function offlineStream(): EventStream {
  return new EventStream({ url: "ws://unused", token: "t", reconnect: false });
}

describe("event stream: ordering and delivery", () => {
  test("events arrive in seq order and are retained for later reads", () => {
    const stream = offlineStream();
    const seen: number[] = [];
    stream.onAny((e) => seen.push(e.seq));
    for (const f of frames(fullStream)) stream.ingest(f);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stream.recent().map((e) => e.seq)).toEqual(seen);
    expect(stream.recent(2).map((e) => e.seq)).toEqual([9, 10]);
  });

  test("the retained buffer is bounded", () => {
    const stream = new EventStream({ url: "ws://unused", token: "t", bufferSize: 3, reconnect: false });
    for (const f of frames(fullStream)) stream.ingest(f);
    expect(stream.recent()).toHaveLength(3);
    expect(stream.recent()[0]?.seq).toBe(8);
  });

  test("on/once dispatch per opcode", () => {
    const stream = offlineStream();
    let chats = 0;
    let onceFired = 0;
    stream.on("SMSG_MESSAGECHAT", () => chats++);
    stream.once("SMSG_MESSAGECHAT", () => onceFired++);
    for (const f of frames(fullStream)) stream.ingest(f);
    // seq 4 decodes, seq 8 is a module decode error, seq 9 fails our schema.
    expect(chats).toBe(3);
    expect(onceFired).toBe(1);
  });

  test("unsubscribing stops delivery", () => {
    const stream = offlineStream();
    let n = 0;
    const off = stream.on("SMSG_MESSAGECHAT", () => n++);
    stream.ingest(JSON.stringify(chatEcho));
    off();
    stream.ingest(JSON.stringify({ ...chatEcho, seq: 20 }));
    expect(n).toBe(1);
  });

  test("the async iterator sees events from subscription forward", async () => {
    const stream = offlineStream();
    const collected: number[] = [];
    const consumer = (async () => {
      for await (const e of stream) {
        collected.push(e.seq);
        if (collected.length === 3) break;
      }
    })();
    await Bun.sleep(1);
    for (const f of frames(loginSequence)) stream.ingest(f);
    await consumer;
    expect(collected).toEqual([0, 1, 2]);
  });

  test("two iterators each see every event", async () => {
    const stream = offlineStream();
    const take = async () => {
      const out: number[] = [];
      for await (const e of stream) {
        out.push(e.seq);
        if (out.length === 2) break;
      }
      return out;
    };
    const a = take();
    const b = take();
    await Bun.sleep(1);
    for (const f of frames(loginSequence)) stream.ingest(f);
    expect(await a).toEqual([0, 1]);
    expect(await b).toEqual([0, 1]);
  });
});

describe("event stream: waitFor", () => {
  test("finds an event that already arrived", async () => {
    const stream = offlineStream();
    for (const f of frames(fullStream)) stream.ingest(f);
    const hit = await stream.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 50 });
    expect(hit.seq).toBe(2);
  });

  test("resolves on a future event", async () => {
    const stream = offlineStream();
    const pending = stream.waitForOpcode("SMSG_MESSAGECHAT", { timeout: 1000 });
    stream.ingest(JSON.stringify(chatEcho));
    expect((await pending).seq).toBe(4);
  });

  test("sinceSeq skips buffered events that are too old", async () => {
    const stream = offlineStream();
    for (const f of frames(fullStream)) stream.ingest(f);
    await expect(
      stream.waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", { sinceSeq: 5, timeout: 30 }),
    ).rejects.toBeInstanceOf(EventTimeoutError);
  });

  test("includeBuffered false ignores history", async () => {
    const stream = offlineStream();
    for (const f of frames(fullStream)) stream.ingest(f);
    await expect(
      stream.waitForOpcode("SMSG_MOTD", { includeBuffered: false, timeout: 30 }),
    ).rejects.toBeInstanceOf(EventTimeoutError);
  });

  test("times out with a typed error", async () => {
    const stream = offlineStream();
    await expect(stream.waitForOpcode("SMSG_MOTD", { timeout: 20 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
  });

  test("an abort signal rejects the wait", async () => {
    const stream = offlineStream();
    const ac = new AbortController();
    const pending = stream.waitForOpcode("SMSG_MOTD", { timeout: 5000, signal: ac.signal });
    ac.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });
});

describe("event stream: continuity", () => {
  test("a seq hole becomes exactly one stream_gap, never a silent skip", () => {
    const stream = offlineStream();
    const seen: StreamEvent[] = [];
    stream.onAny((e) => seen.push(e));
    stream.ingest(JSON.stringify(loginSequence[0]));
    stream.ingest(JSON.stringify({ ...chatEcho, seq: 9 }));
    const gaps = seen.filter((e) => e.opcode === STREAM_GAP);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.data).toEqual({ fromSeq: 1, toSeq: 8, missing: 8 });
    expect(gaps[0]?.seq).toBe(9);
    expect(stream.gaps).toBe(1);
  });

  test("a seq restart under the same token is not reported as a gap", () => {
    const stream = offlineStream();
    for (const f of frames(fullStream)) stream.ingest(f);
    const before = stream.gaps;
    // The session was torn down and recreated: the counter starts over.
    for (const f of frames(loginSequence)) stream.ingest(f);
    expect(stream.gaps).toBe(before);
  });

  test("a frame that is not an event envelope surfaces as stream_error", () => {
    const stream = offlineStream();
    const seen: StreamEvent[] = [];
    stream.onAny((e) => seen.push(e));
    stream.ingest("}{ not json");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.opcode).toBe(STREAM_ERROR);
  });
});

describe("event stream: over a real socket", () => {
  test("connects, receives fixture frames, and closes", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const stream = new EventStream({ url: `${stub.wsUrl}/events`, token: "t", reconnect: false });
    await stream.connect();
    const verify = await stream.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
    expect(verify.seq).toBe(2);
    stream.close();
    await stub.stop();
  });

  test("reconnects after a drop and reports the events it missed", async () => {
    // First connection gets seq 0..3; the second picks up at seq 20, so 4..19
    // were missed while the socket was down.
    const stub = startStub({
      onConnect: (i) => (i === 0 ? frames(loginSequence) : frames([{ ...chatEcho, seq: 20 }])),
      closeAfterPush: true,
    });
    const stream = new EventStream({
      url: `${stub.wsUrl}/events`,
      token: "t",
      reconnectMinDelayMs: 5,
      reconnectMaxDelayMs: 20,
    });
    await stream.connect();
    const gap = await stream.waitForOpcode(STREAM_GAP, { timeout: 3000 });
    expect(gap.data).toEqual({ fromSeq: 4, toSeq: 19, missing: 16 });
    expect(stub.connections).toBeGreaterThan(1);
    stream.close();
    await stub.stop();
  });
});
