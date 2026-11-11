/**
 * The store source over the stack's fixture sessions: listing a store and a
 * lone session directory, the scope on the listing and on every open,
 * segments and whether they are closed, the `kinds` hint, and tailing.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR, rowsBetween, storeSource, type SessionScope } from "../src/index";
import { CLOSED_ID, FIXTURE_T0, LIVE_ID, plant, plantStore, tempDir } from "./fixtures";

const tmp = tempDir();
const root = plantStore(join(tmp, "store"));
const alice: SessionScope = { kind: "user", owner: "alice" };
const bob: SessionScope = { kind: "user", owner: "bob" };

describe("listing and scope", () => {
  test("a store lists every session, newest opened first", async () => {
    const list = await storeSource(root).list(OPERATOR);
    expect(list.map((e) => e.id)).toEqual([LIVE_ID, CLOSED_ID]);
    expect(list[0]!.live?.level).toBe(1);
    expect(list[1]!.live).toBeNull();
  });

  test("sessions one client drove carry its group; a session that stands alone carries none", async () => {
    const store = join(tmp, "grouped");
    mkdirSync(store, { recursive: true });
    plant("closed", join(store, CLOSED_ID), { group: "0123456789abcdef" });
    plant("live", join(store, LIVE_ID), { group: "0123456789abcdef" });
    expect((await storeSource(store).list(OPERATOR)).map((e) => e.group)).toEqual(["0123456789abcdef", "0123456789abcdef"]);
    expect((await storeSource(root).list(OPERATOR)).map((e) => "group" in e)).toEqual([false, false]);
  });

  test("a lone session directory is a source of one", async () => {
    const one = plant("closed", join(tmp, "one"));
    const src = storeSource(one);
    expect((await src.list(OPERATOR)).map((e) => e.id)).toEqual([CLOSED_ID]);
    expect(await src.open(CLOSED_ID, OPERATOR)).not.toBeNull();
    expect(await src.open(LIVE_ID, OPERATOR)).toBeNull();
  });

  test("a user sees only the sessions they own, on the listing and on every open", async () => {
    const src = storeSource(root);
    expect((await src.list(alice)).map((e) => e.id)).toEqual([CLOSED_ID]);
    expect(await src.list(bob)).toEqual([]);
    expect(await src.open(CLOSED_ID, alice)).not.toBeNull();
    expect(await src.open(CLOSED_ID, bob)).toBeNull();
    // A session with no owner is the operator's alone.
    expect(await src.open(LIVE_ID, alice)).toBeNull();
    expect(await src.open(LIVE_ID, OPERATOR)).not.toBeNull();
  });

  test("an id that is not a session id opens nothing", async () => {
    const src = storeSource(root);
    for (const id of ["..", "../store", "nope", `${CLOSED_ID}x`]) expect(await src.open(id, OPERATOR)).toBeNull();
  });
});

describe("segments and reads", () => {
  test("a closed session's segments are all closed; a live one's newest is open", async () => {
    const src = storeSource(root);
    const closed = (await src.open(CLOSED_ID, OPERATOR))!;
    expect((await closed.segments("trace")).map((s) => [s.t0, s.closed])).toEqual([
      [FIXTURE_T0, true],
      [FIXTURE_T0 + 300_000, true],
    ]);
    const live = (await src.open(LIVE_ID, OPERATOR))!;
    expect((await live.segments("trace")).map((s) => s.closed)).toEqual([false]);
    expect(await live.segments("trace", { from: 0, to: FIXTURE_T0 + 300_000 })).toEqual([]);
  });

  test("reads compressed and plain alike, and the kinds hint skips the rest", async () => {
    const h = (await storeSource(root).open(CLOSED_ID, OPERATOR))!;
    const segs = await h.segments("calls");
    const all = await h.read("calls", segs);
    expect(all[0]!.length).toBeGreaterThan(2);
    const moves = await h.read("calls", segs, { kinds: ["move"] });
    expect(moves.flat().map((r) => r.kind)).toEqual(["move", "move"]);
    const ranged = await rowsBetween(h, "calls", { from: FIXTURE_T0, to: FIXTURE_T0 + 600_000 }, { kinds: ["call"] });
    // The second window's key restates the open call inside itself: a hint's false hit, filtered out.
    expect(ranged.every((r) => r.kind === "call")).toBe(true);
    expect(ranged.length).toBe(3);
  });

  test("a tail returns what was written since its cursor", async () => {
    const dir = plant("live", join(tmp, "tailing"));
    const h = (await storeSource(dir).open(LIVE_ID, OPERATOR))!;
    const first = await h.tail("events");
    expect(first.rows.length).toBe(3);
    expect(first.cursor).toBe(await h.end("events"));
    const stat = await h.stat("events");
    appendFileSync(join(dir, "events", `${FIXTURE_T0 + 300_000}.jsonl`), `${JSON.stringify({ ts: FIXTURE_T0 + 340_000, kind: "trade" })}\n`);
    const next = await h.tail("events", first.cursor);
    expect(next.rows).toEqual([{ ts: FIXTURE_T0 + 340_000, kind: "trade" }]);
    expect((await h.stat("events"))!.stamp).not.toBe(stat!.stamp);
    // A torn line is left for the next read.
    appendFileSync(join(dir, "events", `${FIXTURE_T0 + 300_000}.jsonl`), `{"ts":1,"kind":"tra`);
    expect((await h.tail("events", next.cursor)).rows).toEqual([]);
  });

  test("a stream never written reads as empty", async () => {
    const dir = join(tmp, "bare");
    mkdirSync(dir);
    plant("live", join(dir, LIVE_ID));
    const h = (await storeSource(dir).open(LIVE_ID, OPERATOR))!;
    const closed = (await storeSource(root).open(CLOSED_ID, OPERATOR))!;
    expect(await closed.segments("nearby")).toEqual([]);
    expect(await closed.stat("nearby")).toBeNull();
    expect(await closed.end("nearby")).toBeNull();
    expect((await h.tail("nearby")).rows.length).toBeGreaterThan(0);
  });
});
