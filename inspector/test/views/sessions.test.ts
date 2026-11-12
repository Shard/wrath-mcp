/**
 * The inspector views' own arithmetic, without a DOM: which sessions are
 * live, the character at the end of a trace (over the stack's fixture
 * session, packed and decoded as the page does), the party a record left,
 * an event as one line, and the map's view.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OPERATOR, storeSource, traceSegment } from "../../src/index";
import { characterAt, decoded, eventLine, fmtAgo, fmtMoney, groupSiblings, isLive, partyOf, segmentEnd, sessionBlocks, sessionGroup, sessionOrder } from "../../src/views/lib/sessions";
import { fit, fromScreen, toScreen, visibleTiles, worldToPixel } from "../../src/views/lib/world";
import type { SessionSummary } from "../../src/wire";
import { CLOSED_ID, FIXTURE_T0, LIVE_ID, plantStore, tempDir } from "../fixtures";

const root = plantStore(join(tempDir(), "store"));
const NOW = FIXTURE_T0 + 330_000;

const summary = (id: string, o: { ended?: number | null; liveTs?: number | null; opened?: number; guid?: string } = {}): SessionSummary => ({
  id,
  session: { format: "wrath-session/1", id, character: o.guid === undefined ? null : { guid: o.guid, name: `c${id}`, race: 1, class: 1 }, stack: { version: "0" }, module: null, started: 0, opened: o.opened ?? 0, ended: o.ended ?? null },
  live: o.liveTs === null || o.liveTs === undefined ? null : { ts: o.liveTs, observed: null, map: 0, x: 1, y: 2, z: 3, o: 0, level: 5, hp: 1, hpMax: 1, zone: null, area: null, flags: [], stream: null },
});

describe("sessions", () => {
  test("live is unended with a fresh heartbeat; live ones list first, then the newest opened", () => {
    expect(isLive(summary("a", { liveTs: NOW - 1_000 }), NOW)).toBe(true);
    expect(isLive(summary("a", { liveTs: NOW - 10 * 60_000 }), NOW)).toBe(false);
    expect(isLive(summary("a", { liveTs: NOW, ended: NOW }), NOW)).toBe(false);
    const order = sessionOrder([summary("old", { opened: 1 }), summary("new", { opened: 5 }), summary("live", { opened: 0, liveTs: NOW })], NOW);
    expect(order.map((s) => s.id)).toEqual(["live", "new", "old"]);
  });

  test("the sessions one client drove are one block, listed where its first member would be; a lone session is its own", () => {
    const grouped = (id: string, group: string | undefined, o: Parameters<typeof summary>[1] = {}): SessionSummary => ({ ...summary(id, { guid: id, ...o }), ...(group !== undefined ? { group } : {}) });
    const list = [grouped("solo", undefined, { opened: 9 }), grouped("b", "run-1", { opened: 3 }), grouped("a", "run-1", { opened: 2, liveTs: NOW }), grouped("z", "run-2", { opened: 5 })];
    const blocks = sessionBlocks(list, NOW);
    expect(blocks.map((b) => [b.group, b.sessions.map((s) => s.id)])).toEqual([
      ["run-1", ["a", "b"]],
      [null, ["solo"]],
      ["run-2", ["z"]],
    ]);
    expect(groupSiblings(list, list[1]!).map((s) => s.id)).toEqual(["a"]);
    expect(groupSiblings(list, list[0]!)).toEqual([]);
    // A source's own grouping wins; the record's label stands in when it gives none.
    const labelled = summary("l");
    labelled.session!.group = "0123456789abcdef";
    expect(sessionGroup(labelled)).toBe("0123456789abcdef");
    expect(sessionGroup({ ...labelled, group: "run-9" })).toBe("run-9");
    expect(sessionGroup(summary("n"))).toBeNull();
  });

  test("durations and money", () => {
    expect([fmtAgo(5_000), fmtAgo(125_000), fmtAgo(3 * 3_600_000 + 5 * 60_000), fmtAgo(50 * 3_600_000)]).toEqual(["5s", "2m", "3h 05m", "2d 2h"]);
    expect([fmtMoney(12_345), fmtMoney(0), fmtMoney(null), fmtMoney(100)]).toEqual(["1g 23s 45c", "0c", "—", "1s"]);
  });
});

describe("the character at the end of its trace", () => {
  test("the fixture's last window: its gauges, sheet, item names and quest log", async () => {
    const h = (await storeSource(root).open(CLOSED_ID, OPERATOR))!;
    const found = (await traceSegment(h, FIXTURE_T0 + 300_000, NOW + 3_600_000))!;
    const seg = decoded(found.segment)!;
    const c = characterAt(seg, segmentEnd(seg), 1);
    expect(c.gauges.level).not.toBeNull();
    expect(c.map).not.toBeNull();
    // The worn hatchet rolled a random property, named as the client names it.
    expect(c.items?.find((i) => i.slot === 15 && i.equipped)?.name).toBe("Brindle Hatchet of the Hare");
    expect(c.items?.find((i) => i.slot === 4 && i.equipped)?.name).toBe("Wayfarer's Tunic");
    expect(c.powerType).toBeDefined();
    expect(decoded(null)).toBeNull();
  });
});

describe("the party", () => {
  test("own members are matched to their sessions, the rest only counted; leaving ends it", () => {
    const sessions = [summary("s1", { guid: "5" }), summary("s2", { guid: "9" })];
    const joined = { ts: 1, kind: "group", event: "joined", members: ["5", "9"], foreign: 2, count: 5, leaderGuid: "9" };
    const p = partyOf([joined], sessions)!;
    expect(p.members.map((m) => m.session?.id)).toEqual(["s1", "s2"]);
    expect([p.foreign, p.leaderGuid]).toEqual([2, "9"]);
    expect(partyOf([joined, { ts: 2, kind: "group", event: "left", members: [], foreign: 0, count: 0 }], sessions)).toBeNull();
    expect(partyOf([{ ts: 0, kind: "key", state: { group: { members: ["5"], foreign: 0, count: 1 } } }], sessions)!.members).toHaveLength(1);
    expect(partyOf([], sessions)).toBeNull();
  });
});

describe("the feed", () => {
  test("an event is its kind and the fields that say what happened", () => {
    expect(eventLine({ ts: 0, kind: "level", from: 5, to: 6, xp: 10 })).toBe("level · to 6 · from 5");
    expect(eventLine({ ts: 0, kind: "group", event: "joined", members: ["1", "2"], foreign: 1, count: 3 })).toBe("group · event joined · count 3 · members 2 (+1)");
    expect(eventLine({ ts: 0, kind: "death", released: true, position: { x: 1 } })).toBe("death · released");
  });
});

describe("the map's view", () => {
  test("world to map pixels, and screen and back", () => {
    expect(worldToPixel(0, 0)).toEqual({ px: 32 * 256, py: 32 * 256 });
    const v = { cx: 100, cy: 200, scale: 2 };
    const s = toScreen(v, 800, 600, 150, 260);
    expect(fromScreen(v, 800, 600, s.sx, s.sy)).toEqual({ px: 150, py: 260 });
  });

  test("a fit frames every point; the visible tiles stay inside the grid", () => {
    const pts = [worldToPixel(-6000, 400), worldToPixel(-6100, 300)];
    const v = fit(pts, 800, 600);
    for (const p of pts) {
      const s = toScreen(v, 800, 600, p.px, p.py);
      expect(s.sx >= 0 && s.sx <= 800 && s.sy >= 0 && s.sy <= 600).toBe(true);
    }
    const all = visibleTiles({ cx: 32 * 256, cy: 32 * 256, scale: 1 / 64 }, 800, 600);
    expect(all.every((t) => t.row >= 0 && t.row < 64 && t.col >= 0 && t.col < 64)).toBe(true);
    expect(fit([], 800, 600).cx).toBe(32 * 256);
  });
});

void LIVE_ID;
