import { describe, expect, test } from "bun:test";

import { EventStream, EventStreamClosedError, EventTimeoutError, STREAM_ERROR, STREAM_GAP } from "../src/events";
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

  test("an exact-epoch waiter matches its own session's events", async () => {
    const stream = offlineStream();
    const pending = stream.waitFor((e) => e.opcode === "SMSG_MESSAGECHAT", {
      epoch: stream.epoch,
      timeout: 500,
    });
    stream.ingest(JSON.stringify(chatEcho));
    expect((await pending).opcode).toBe("SMSG_MESSAGECHAT");
  });

  test("an exact-epoch waiter never matches a later session's colliding event", async () => {
    const stream = offlineStream();
    for (const f of frames(fullStream)) stream.ingest(f);
    // Issued against the current session: correlation must be exact, because
    // per-session ids (moveId, seq) restart when the session is recreated.
    const pending = stream.waitFor((e) => e.opcode === "SMSG_MESSAGECHAT", {
      epoch: stream.epoch,
      includeBuffered: false,
      timeout: 60,
    });
    // The session restarts (seq goes backwards): a byte-identical event from
    // the NEW session must not settle the old waiter — it has no verdict.
    for (const f of frames(loginSequence)) stream.ingest(f);
    stream.ingest(JSON.stringify({ ...chatEcho, seq: 30 }));
    await expect(pending).rejects.toBeInstanceOf(EventTimeoutError);
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

  test("a seq restart advances the session epoch (ingest-side boundary detection)", () => {
    // The module can recreate a session under the same token without this
    // client ever calling createSession (whose advanceEpoch would mark the
    // boundary). The seq going backwards is the only tell, and the ingest-side
    // bump is the only thing keeping per-session correlation ids (moveId, seq)
    // of the old session from matching the new one's restarted counters.
    const stream = offlineStream();
    for (const f of frames(fullStream)) stream.ingest(f);
    const before = stream.epoch;
    for (const f of frames(loginSequence)) stream.ingest(f);
    expect(stream.epoch).toBe(before + 1);
    // Continuing forward within the new session is not another boundary.
    stream.ingest(JSON.stringify({ ...chatEcho, seq: 30 }));
    expect(stream.epoch).toBe(before + 1);
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

  test("a stream closed by its consumer reopens, and the events it missed are one gap", async () => {
    // The freeplay failure this exists for: a snippet's cleanup loop closed the
    // client's own stream, and a `connect()` that could only reject left the
    // run reading a frozen cache. The reopen keeps the ladder's continuity —
    // seq 4..19 were emitted while the socket was down, and that is a gap, not
    // a replay and not silence.
    const stub = startStub({
      onConnect: (i) => (i === 0 ? frames(loginSequence) : frames([{ ...chatEcho, seq: 20 }])),
    });
    const stream = new EventStream({ url: `${stub.wsUrl}/events`, token: "t", reconnect: false });
    await stream.connect();
    await stream.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
    const epoch = stream.epoch;

    stream.close();
    expect(stream.connected).toBe(false);

    // Registered before the reopen: the missed-events gap rides the first frame
    // of the new socket, which can land before a wait started afterwards.
    const gapSeen = stream.waitForOpcode(STREAM_GAP, { timeout: 2000, includeBuffered: false });
    await stream.connect();
    expect(stream.connected).toBe(true);
    const gap = await gapSeen;
    expect(gap.data).toEqual({ fromSeq: 4, toSeq: 19, missing: 16 });
    expect(stream.gaps).toBe(1);
    // Same session, so no session boundary: a reopen is a reconnect, and the
    // per-session correlation ids are still this session's.
    expect(stream.epoch).toBe(epoch);
    // And observation is arriving again.
    const chat = await stream.waitForOpcode("SMSG_MESSAGECHAT", { timeout: 2000 });
    expect(chat.seq).toBe(20);
    stream.close();
    await stub.stop();
  });
});

describe("events.off (2026-08-23 softening: EventEmitter-shaped removal)", () => {
  /** One chat frame at `seq`, so a test can drive delivery without the fixtures' order. */
  function chatAt(seq: number): string {
    return JSON.stringify({ ...chatEcho, seq });
  }

  test("off removes a handler registered with on", () => {
    const stream = offlineStream();
    const seen: number[] = [];
    const h = (e: StreamEvent) => seen.push(e.seq);
    stream.on("SMSG_MESSAGECHAT", h);
    stream.ingest(chatAt(0));
    expect(stream.off("SMSG_MESSAGECHAT", h)).toBe(true);
    stream.ingest(chatAt(1));
    expect(seen).toEqual([0]);
  });

  test("off finds the wrapper a once() registration installed", () => {
    const stream = offlineStream();
    const seen: number[] = [];
    const h = (e: StreamEvent) => seen.push(e.seq);
    stream.once("SMSG_MESSAGECHAT", h);
    expect(stream.off("SMSG_MESSAGECHAT", h)).toBe(true);
    stream.ingest(chatAt(0));
    expect(seen).toEqual([]);
  });

  test("removing something already gone is a no-op, not an error", () => {
    const stream = offlineStream();
    const h = (): void => {};
    expect(stream.off("SMSG_MESSAGECHAT", h)).toBe(false);
    const unsubscribe = stream.on("SMSG_MESSAGECHAT", h);
    unsubscribe();
    expect(stream.off("SMSG_MESSAGECHAT", h)).toBe(false);
  });

  test("off leaves other handlers on the same opcode alone", () => {
    const stream = offlineStream();
    const seen: string[] = [];
    const a = (): void => void seen.push("a");
    const b = (): void => void seen.push("b");
    stream.on("SMSG_MESSAGECHAT", a);
    stream.on("SMSG_MESSAGECHAT", b);
    stream.off("SMSG_MESSAGECHAT", a);
    stream.ingest(chatAt(0));
    expect(seen).toEqual(["b"]);
  });

  test("wrong arguments throw a message that says the expected shape", () => {
    const stream = offlineStream();
    // The one-argument EventEmitter habit: rejected, never silently ignored.
    expect(() => (stream as unknown as { off: (h: unknown) => void }).off(() => {})).toThrow(
      /events\.off\(opcode, handler\)/,
    );
    expect(() => (stream as unknown as { off: (o: unknown, h: unknown) => void }).off("SMSG_MESSAGECHAT", "h")).toThrow(
      /expected an opcode string and the handler/,
    );
  });
});

test('on("*") and off("*") route to the any-handler set', () => {
  const stream = offlineStream();
  const seen: number[] = [];
  const h = (e: { seq: number }) => seen.push(e.seq);
  stream.on("*", h as never);
  const all = [...frames(fullStream)];
  stream.ingest(all[0]!);
  expect(seen).toHaveLength(1);
  expect(stream.off("*", h as never)).toBe(true);
  stream.ingest(all[1]!);
  expect(seen).toHaveLength(1);
});

describe("event stream: per-attempt connect deadline (issue #34)", () => {
  /**
   * A socket that never completes its handshake, so the stream only escapes it
   * via the open deadline. Instance 0 stalls in CONNECTING; instance 1 opens.
   * `close()` dispatches its `close` event *late* — after the backoff delay has
   * already fired the next attempt — which is the case that would double-advance
   * the ladder if the timeout path did not claim the socket for itself.
   */
  class StallingSocket {
    static instances: StallingSocket[] = [];
    readonly index: number;
    closeCalls = 0;
    /** 0 CONNECTING, 1 OPEN, 3 CLOSED — what `EventStream.connected` reads. */
    readyState = 0;
    private readonly handlers = new Map<string, ((ev: unknown) => void)[]>();

    constructor(readonly url: string) {
      this.index = StallingSocket.instances.length;
      StallingSocket.instances.push(this);
      if (this.index > 0)
        setTimeout(() => {
          this.readyState = 1;
          this.dispatch("open");
        }, 0);
    }

    addEventListener(type: string, handler: (ev: unknown) => void): void {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }

    close(): void {
      this.closeCalls++;
      this.readyState = 3;
      if (this.index === 0) setTimeout(() => this.dispatch("close"), 30);
    }

    private dispatch(type: string): void {
      for (const h of this.handlers.get(type) ?? []) h({ type });
    }
  }

  test("a handshake that never completes fails the attempt and advances the ladder", async () => {
    StallingSocket.instances = [];
    const opened = Promise.withResolvers<void>();
    const lateClose = Promise.withResolvers<void>();
    class Watched extends StallingSocket {
      constructor(url: string) {
        super(url);
        if (this.index === 0) this.addEventListener("close", () => lateClose.resolve());
        if (this.index === 1) this.addEventListener("open", () => opened.resolve());
      }
    }
    const stream = new EventStream({
      url: "ws://stalled",
      token: "t",
      connectTimeoutMs: 20,
      reconnectMinDelayMs: 5,
      reconnectMaxDelayMs: 20,
      webSocketImpl: Watched as unknown as typeof WebSocket,
    });

    // Without the deadline this promise never settles: the stalled socket fires
    // neither close nor error, so nothing reschedules. With it, the stalled
    // attempt fails, the ladder retries, and the caller sees that retry open
    // (one attempt's failure is not the caller's verdict).
    await stream.connect();
    // The stalled socket is closed, not leaked half-open.
    expect(StallingSocket.instances[0]?.closeCalls).toBe(1);

    // The ladder advanced on its own and the next attempt connected.
    await opened.promise;
    expect(StallingSocket.instances.length).toBe(2);
    expect(stream.connected).toBe(true);

    // The stalled socket's late `close` must not open a third attempt. Awaiting
    // it keeps the assertion from passing merely because it never arrived.
    await lateClose.promise;
    await new Promise((r) => setTimeout(r, 40));
    expect(StallingSocket.instances.length).toBe(2);

    stream.close();
  });
});

describe("event stream: connect() rides the ladder", () => {
  type Plan = "open" | "stall" | "refuse";

  /**
   * A socket whose fate is scripted per instance: `open` completes the
   * handshake, `stall` never does (only the open deadline escapes it), `refuse`
   * fires error then close, the way a refused TCP connect or a 401 upgrade
   * arrives. Everything dispatches on a timer so the stream's handlers are
   * attached first.
   */
  class ScriptedSocket {
    static instances: ScriptedSocket[] = [];
    static plan: (index: number) => Plan = () => "open";
    readonly index: number;
    readyState = 0;
    private readonly handlers = new Map<string, ((ev: unknown) => void)[]>();

    constructor(readonly url: string) {
      this.index = ScriptedSocket.instances.length;
      ScriptedSocket.instances.push(this);
      const plan = ScriptedSocket.plan(this.index);
      if (plan === "open")
        setTimeout(() => {
          this.readyState = 1;
          this.dispatch("open");
        }, 0);
      if (plan === "refuse")
        setTimeout(() => {
          this.readyState = 3;
          this.dispatch("error");
          this.dispatch("close");
        }, 0);
    }

    addEventListener(type: string, handler: (ev: unknown) => void): void {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }

    close(): void {
      this.readyState = 3;
    }

    private dispatch(type: string): void {
      for (const h of this.handlers.get(type) ?? []) h({ type });
    }
  }

  function scripted(plan: (index: number) => Plan): EventStream {
    ScriptedSocket.instances = [];
    ScriptedSocket.plan = plan;
    // min 5 / max 20: the ladder climbs 5, 10, then caps — a connect() caller
    // sits through three failures before giving up.
    return new EventStream({
      url: "ws://scripted",
      token: "t",
      connectTimeoutMs: 20,
      reconnectMinDelayMs: 5,
      reconnectMaxDelayMs: 20,
      webSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
    });
  }

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a caller awaiting connect() across a refused first attempt sees the ladder's success", async () => {
    const stream = scripted((i) => (i === 0 ? "refuse" : "open"));
    await stream.connect();
    expect(stream.connected).toBe(true);
    expect(ScriptedSocket.instances.length).toBe(2);
    stream.close();
  });

  test("concurrent and retried connect() calls share one attempt — never two sockets", async () => {
    const stream = scripted((i) => (i === 0 ? "refuse" : "open"));
    // Two calls while the first attempt is in flight share it.
    const first = stream.connect();
    const second = stream.connect();
    expect(ScriptedSocket.instances.length).toBe(1);
    // Let the refusal land; the ladder's retry is now pending, not yet started.
    await settle(1);
    expect(stream.connected).toBe(false);
    expect(ScriptedSocket.instances.length).toBe(1);
    // A retry from the caller joins the pending attempt rather than opening
    // its own socket alongside the ladder's.
    const third = stream.connect();
    expect(ScriptedSocket.instances.length).toBe(1);
    await Promise.all([first, second, third]);
    expect(stream.connected).toBe(true);
    expect(ScriptedSocket.instances.length).toBe(2);
    // Already open: resolves at once without touching the socket.
    await stream.connect();
    expect(ScriptedSocket.instances.length).toBe(2);
    stream.close();
  });

  test("close() mid-connect rejects the pending connect() as a user close", async () => {
    const stream = scripted(() => "stall");
    const pending = stream.connect();
    stream.close();
    await expect(pending).rejects.toThrow(/^event stream closed$/);
    // No ladder after a user close: nothing retries on its own.
    await settle(40);
    expect(ScriptedSocket.instances.length).toBe(1);
    stream.close();
  });

  test("connect() after close() is a fresh attempt, not a standing refusal", async () => {
    const stream = scripted(() => "open");
    await stream.connect();
    stream.close();
    expect(stream.connected).toBe(false);
    await stream.connect();
    expect(stream.connected).toBe(true);
    expect(ScriptedSocket.instances.length).toBe(2);
    // And still cheap while it is open.
    await stream.connect();
    expect(ScriptedSocket.instances.length).toBe(2);
    stream.close();
  });

  test("a reopen against a server that refuses the upgrade rejects, and says so", async () => {
    // What a session the module no longer has looks like from here: the
    // handshake is refused. The reopen must report that, not resolve.
    ScriptedSocket.instances = [];
    ScriptedSocket.plan = () => "refuse";
    const stream = new EventStream({
      url: "ws://scripted",
      token: "t",
      reconnect: false,
      connectTimeoutMs: 20,
      webSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
    });
    stream.close();
    await expect(stream.connect()).rejects.toThrow(/^failed to connect to ws:\/\/scripted/);
    expect(stream.connected).toBe(false);
    stream.close();
  });

  test("an unreachable server rejects after a whole climb of the ladder while the stream keeps trying", async () => {
    const stream = scripted((i) => (i < 5 ? "refuse" : "open"));
    await expect(stream.connect()).rejects.toThrow(/failed to connect to ws:\/\/scripted.*\(3 attempts/);
    // The caller gave up; the stream did not, and a later caller rides the
    // recovery in.
    await stream.connect();
    expect(stream.connected).toBe(true);
    expect(ScriptedSocket.instances.length).toBe(6);
    stream.close();
  });

  test("with reconnect off, connect() rejects on the attempt and a retry opens a fresh one", async () => {
    ScriptedSocket.instances = [];
    ScriptedSocket.plan = (i) => (i === 0 ? "refuse" : "open");
    const stream = new EventStream({
      url: "ws://scripted",
      token: "t",
      reconnect: false,
      connectTimeoutMs: 20,
      webSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
    });
    await expect(stream.connect()).rejects.toThrow(/^failed to connect to ws:\/\/scripted/);
    await settle(10);
    expect(ScriptedSocket.instances.length).toBe(1);
    // Not the same rejected promise forever: a retry is a real attempt.
    await stream.connect();
    expect(stream.connected).toBe(true);
    expect(ScriptedSocket.instances.length).toBe(2);
    stream.close();
  });
});
