/**
 * The events recorder (`record/events-recorder.ts`): what happened to the
 * character, as rows of the session's `events` stream, latched in the sandbox
 * child for the host to drain.
 *
 * A real SDK state cache and event stream, fed frames hand-written from
 * module/PROTOCOL.md's tables (ids, guids and positions invented, names empty
 * or invented, nothing captured from a running game), with the cache's fold
 * registered before the recorder starts, as the child registers it. The poll
 * is driven by hand (`poll()`) and the clock is the test's.
 *
 * What it covers, by the recorder's two kinds of reading:
 *
 * - Polled off the cache, each stamped with the cache's own time for the
 *   value: zone, area and level (the first reading of each carries no
 *   `from`), the spellbook (`spells_at_login` once, an empty book never
 *   taken for one, then `spell` per new id), achievements
 *   (`achievements_at_login` once, then the character's own earns), talents
 *   (seeded silently, then a climbed rank is a row and a respec is
 *   forgotten), a completed trade (once per cache stamp) and quest turn-ins
 *   (from `questCompletions` growth, never the ones the cache held when the
 *   recorder started).
 * - Latched off the event that carried them, through `events.onAny`: the
 *   death and flight watchers and the party watcher, each row carrying that
 *   event's `ts` and `seq`. A `group` row says `foreign: 0`: the recorder
 *   writes every member it saw, and counting foreign players is the write
 *   gate's (`gate.ts`).
 *
 * And the opening `key` row, which states the stream whole, and the buffer's
 * cap. The watchers' own latch logic is `record-watchers.test.ts` and
 * `record-party-watch.test.ts`; this file pins what the recorder makes of it.
 */
import { describe, expect, test } from "bun:test";
import { EventStream, StateCache } from "@wrathbench/sdk";
import { EventsRecorder } from "../src/record/events-recorder";
import type { EventRow } from "../src/record/format";
import { unitGuid } from "./fixtures/nearby-frames";

const T0 = 1_760_000_000_000;
const ZONE = 9101;
const AREA = 9111;

function rig(opts: { cap?: number } = {}) {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const state = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
  // The client's own order: the cache folds first, the recorder (subscribed
  // in `start()`) reads after. A frame the SDK's schema refuses is never
  // folded, so it throws here rather than read as a recorder that saw nothing.
  events.onAny((e) => {
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    state.apply(e);
  });
  let clock = T0;
  const rec = new EventsRecorder({ state, events, now: () => clock, pollMs: 60_000, ...(opts.cap !== undefined ? { cap: opts.cap } : {}) });
  let seq = 1;
  let ts = T0;
  /** One frame; `at` moves the stream's clock (and the test's, which never runs behind it). */
  const feed = (opcode: string, opcodeId: number, data: unknown, at?: number): { seq: number; ts: number } => {
    if (at !== undefined) ts = at;
    clock = Math.max(clock, ts);
    const s = seq++;
    events.ingest(JSON.stringify({ seq: s, opcode, opcodeId, ts, data }));
    return { seq: s, ts };
  };
  const selfFields = (fields: Record<string, unknown>, at?: number) =>
    feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] }, at);
  return {
    state,
    rec,
    feed,
    selfFields,
    at: (t: number) => {
      clock = t;
    },
    /** `WB_SESSION_STATE` 0xFF03: in the world with a position, a level and the zone/area pair. */
    enter: (o: { level?: number; zoneId?: number; areaId?: number; map?: number } = {}, at?: number) =>
      feed(
        "WB_SESSION_STATE",
        0xff03,
        {
          character: "Fenwick",
          guid: "7",
          inWorld: true,
          map: o.map ?? 0,
          x: -6572,
          y: 405,
          z: 387,
          o: 1.7,
          level: o.level ?? 7,
          zoneId: o.zoneId ?? ZONE,
          zoneName: "",
          areaId: o.areaId ?? AREA,
          areaName: "",
        },
        at,
      ),
    /** `WB_AREA` 0xFF07. */
    area: (zoneId: number, areaId: number, at?: number, extra: { mapId?: number; instanceType?: number } = {}) =>
      feed("WB_AREA", 0xff07, { mapId: extra.mapId ?? 0, zoneId, zoneName: "", areaId, areaName: "", ...(extra.instanceType !== undefined ? { instanceType: extra.instanceType } : {}) }, at),
    /** `SMSG_GROUP_LIST` 0x07D with invented members. */
    groupList: (members: string[], leaderGuid = "7", at?: number) =>
      feed(
        "SMSG_GROUP_LIST",
        0x7d,
        {
          groupType: 0,
          left: false,
          raid: false,
          subGroup: 0,
          memberFlags: 0,
          roles: 0,
          groupGuid: "9001",
          counter: 1,
          members: members.map((guid, i) => ({ name: `Member${i}`, guid, online: true, subGroup: 0, flags: 0, roles: 0 })),
          leaderGuid,
        },
        at,
      ),
    rows: (): EventRow[] => rec.drain().rows,
  };
}

const kinds = (rows: EventRow[]): string[] => rows.map((r) => r.kind);

describe("events recorder: the key", () => {
  test("the opening key states the stream whole; a recorder started before the world states nulls", () => {
    const empty = rig();
    empty.rec.start();
    const [key, ...rest] = empty.rows();
    expect(rest).toEqual([]);
    expect(key).toEqual({
      ts: T0,
      kind: "key",
      state: { level: null, zone: null, area: null, map: null, instanceType: null, dead: false, released: false, taxi: false, group: null },
    });
    empty.rec.stop();

    const r = rig();
    r.enter({}, T0 + 100);
    r.selfFields({ health: 186, maxHealth: 186, playerFlags: 0 }, T0 + 110);
    r.at(T0 + 500);
    r.rec.start();
    const rows = r.rows();
    // The key first, then the poll `start()` runs: the first readings, which
    // carry no `from`, stamped with the cache's time for them, not the poll's.
    expect(kinds(rows)).toEqual(["key", "zone", "area", "level"]);
    expect(rows[0]).toMatchObject({ ts: T0 + 500, kind: "key", state: { level: 7, zone: ZONE, area: AREA, map: 0, dead: false, released: false, taxi: false, group: null } });
    expect(rows.slice(1)).toEqual([
      { ts: T0 + 100, kind: "zone", to: ZONE },
      { ts: T0 + 100, kind: "area", to: AREA },
      { ts: T0 + 100, kind: "level", to: 7 },
    ]);
    r.rec.stop();
  });

  test("a key states a death, a released spirit, a flight and the group as the cache holds them", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.selfFields({ health: 1, maxHealth: 186, playerFlags: 0x10, unitFlags: 0x100008 }, T0 + 110);
    r.groupList(["11", "12"], "11", T0 + 120);
    r.rec.start();
    const [key] = r.rows();
    expect(key).toMatchObject({
      kind: "key",
      state: {
        dead: true,
        released: true,
        taxi: true,
        // Every member the cache holds, and `foreign: 0`: the write gate is what counts foreign players.
        group: { groupGuid: "9001", leaderGuid: "11", members: ["11", "12"], foreign: 0, count: 3 },
      },
    });
    r.rec.stop();

    const corpse = rig();
    corpse.enter({}, T0 + 100);
    corpse.selfFields({ health: 0, maxHealth: 186 }, T0 + 110);
    corpse.rec.start();
    expect(corpse.rows()[0]).toMatchObject({ kind: "key", state: { dead: true, released: false } });
    corpse.rec.stop();
  });
});

describe("events recorder: zone, area and level", () => {
  test("later readings carry `from`, each stamped with the packet that changed it; level carries the XP reading", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    r.rows();
    r.area(ZONE, 9112, T0 + 1_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: T0 + 1_000, kind: "area", from: AREA, to: 9112 }]);
    r.area(9102, 9121, T0 + 2_000);
    r.rec.poll();
    expect(r.rows()).toEqual([
      { ts: T0 + 2_000, kind: "zone", from: ZONE, to: 9102 },
      { ts: T0 + 2_000, kind: "area", from: 9112, to: 9121 },
    ]);
    r.selfFields({ level: 8, xp: 40 }, T0 + 3_000);
    r.at(T0 + 3_900);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: T0 + 3_000, kind: "level", from: 7, to: 8, xp: 40 }]);
    // Nothing changed: nothing written.
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.rec.stop();
  });
});

describe("events recorder: the spellbook", () => {
  test("an empty book is not a baseline; the first book is `spells_at_login` once, and each later id a `spell`", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    r.rows();
    // The login's spell list has not arrived: an empty book, and nothing written.
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.feed("SMSG_INITIAL_SPELLS", 0x12a, { spells: [{ spellId: 90003 }, { spellId: 90001 }], cooldowns: [] }, T0 + 1_000);
    r.at(T0 + 1_500);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: T0 + 1_500, kind: "spells_at_login", ids: [90001, 90003] }]);
    r.feed("SMSG_LEARNED_SPELL", 0x12b, { spellId: 90002 }, T0 + 2_000);
    r.at(T0 + 2_500);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: T0 + 2_500, kind: "spell", id: 90002 }]);
    // A learn is read once; a spell removed and learned again is not a new one.
    r.rec.poll();
    r.feed("SMSG_REMOVED_SPELL", 0x203, { spellId: 90002 }, T0 + 3_000);
    r.rec.poll();
    r.feed("SMSG_LEARNED_SPELL", 0x12b, { spellId: 90002 }, T0 + 3_100);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.rec.stop();
  });

  test("a book already full when the recorder starts is its baseline, not a run of learns", () => {
    const r = rig();
    r.feed("SMSG_INITIAL_SPELLS", 0x12a, { spells: [{ spellId: 90001 }, { spellId: 90002 }], cooldowns: [] }, T0 + 100);
    r.at(T0 + 200);
    r.rec.start();
    expect(r.rows()).toEqual([
      expect.objectContaining({ kind: "key" }),
      { ts: T0 + 200, kind: "spells_at_login", ids: [90001, 90002] },
    ]);
    r.rec.stop();
  });
});

describe("events recorder: achievements", () => {
  test("the login backlog once, then the character's own earns; another player's is not ours", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    r.rows();
    r.feed(
      "SMSG_ALL_ACHIEVEMENT_DATA",
      0x47d,
      {
        count: 2,
        achievements: [
          { achievementId: 9501, date: 0, points: 10 },
          { achievementId: 9502, date: 0, points: 5 },
        ],
      },
      T0 + 1_000,
    );
    r.at(T0 + 1_500);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: T0 + 1_000, kind: "achievements_at_login", ids: [9501, 9502], points: 15 }]);
    // Another player's earn, broadcast in range: dropped by the cache.
    r.feed("SMSG_ACHIEVEMENT_EARNED", 0x468, { guid: "12", self: false, achievement: { achievementId: 9504, date: 0 } }, T0 + 1_900);
    const earn = r.feed(
      "SMSG_ACHIEVEMENT_EARNED",
      0x468,
      { guid: "7", self: true, achievement: { achievementId: 9503, date: 0, name: "Invented Feat", points: 10, categoryId: 92 } },
      T0 + 2_000,
    );
    r.at(T0 + 2_500);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: earn.ts, seq: earn.seq, kind: "achievement", id: 9503, name: "Invented Feat", points: 10, categoryId: 92 }]);
    // Read once.
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.rec.stop();
  });
});

describe("events recorder: talents", () => {
  const talents = (r: ReturnType<typeof rig>, list: { talentId: number; rank: number }[], at: number) =>
    r.feed("SMSG_TALENTS_INFO", 0x4c0, { pet: false, unspentPoints: 0, specCount: 1, activeSpec: 0, specs: [{ talents: list }] }, at);

  test("the first frame seeds silently; a climbed rank or a new talent is a row; a respec is forgotten, so a relearn is a spend", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    r.rows();
    talents(r, [{ talentId: 901, rank: 0 }], T0 + 1_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    const spend = talents(
      r,
      [
        { talentId: 901, rank: 1 },
        { talentId: 902, rank: 0 },
      ],
      T0 + 2_000,
    );
    r.rec.poll();
    // The wire rank is 0-based: the row carries it and the points it means.
    expect(r.rows()).toEqual([
      { ts: spend.ts, seq: spend.seq, kind: "talent", id: 901, points: 2, rank: 1, spec: 0 },
      { ts: spend.ts, seq: spend.seq, kind: "talent", id: 902, points: 1, rank: 0, spec: 0 },
    ]);
    // The same frame again: nothing.
    talents(
      r,
      [
        { talentId: 901, rank: 1 },
        { talentId: 902, rank: 0 },
      ],
      T0 + 2_500,
    );
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // A respec: the frame lists nothing, and nothing is written.
    talents(r, [], T0 + 3_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    const relearn = talents(r, [{ talentId: 901, rank: 0 }], T0 + 4_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: relearn.ts, seq: relearn.seq, kind: "talent", id: 901, points: 1, rank: 0, spec: 0 }]);
    r.rec.stop();
  });
});

describe("events recorder: trades and turn-ins", () => {
  test("a completed trade is one row per cache stamp, however many polls read it", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    r.rows();
    r.feed("SMSG_TRADE_STATUS", 0x120, { status: 2, traderGuid: "12" }, T0 + 1_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    const done = r.feed("SMSG_TRADE_STATUS", 0x120, { status: 8 }, T0 + 2_000);
    r.rec.poll();
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: done.ts, seq: done.seq, kind: "trade" }]);
    // A second trade later is a second row.
    r.feed("SMSG_TRADE_STATUS", 0x120, { status: 2, traderGuid: "12" }, T0 + 3_000);
    const again = r.feed("SMSG_TRADE_STATUS", 0x120, { status: 8 }, T0 + 4_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: again.ts, seq: again.seq, kind: "trade" }]);
    r.rec.stop();
  });

  test("turn-ins are read from the cache's receipts as they grow; the ones it already held at start were an earlier recorder's", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.feed("SMSG_QUESTGIVER_QUEST_COMPLETE", 0x191, { questId: 9301, xp: 100, money: 10 }, T0 + 200);
    r.rec.start();
    r.rows();
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    const first = r.feed("SMSG_QUESTGIVER_QUEST_COMPLETE", 0x191, { questId: 9302, xp: 100, money: 10 }, T0 + 1_000);
    // The same quest twice is twice.
    const second = r.feed("SMSG_QUESTGIVER_QUEST_COMPLETE", 0x191, { questId: 9302, xp: 100, money: 10 }, T0 + 1_100);
    r.at(T0 + 2_000);
    r.rec.poll();
    expect(r.rows()).toEqual([
      { ts: first.ts, seq: first.seq, kind: "quest", id: 9302 },
      { ts: second.ts, seq: second.seq, kind: "quest", id: 9302 },
    ]);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.rec.stop();
  });
});

describe("events recorder: transitions latched off the event that carried them", () => {
  test("a death, its release and resurrect are rows the moment they arrive, with that event's ts and seq", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.selfFields({ health: 186, maxHealth: 186, playerFlags: 0 }, T0 + 110);
    r.rec.start();
    r.rows();
    const died = r.selfFields({ health: 0 }, T0 + 1_000);
    const released = r.feed("SMSG_DEATH_RELEASE_LOC", 0x378, { map: 0, x: -6164, y: 336, z: 399 }, T0 + 5_000);
    r.selfFields({ playerFlags: 0x10, health: 1 }, T0 + 5_100);
    const back = r.feed("SMSG_DEATH_RELEASE_LOC", 0x378, { map: -1, x: 0, y: 0, z: 0 }, T0 + 20_000);
    r.selfFields({ playerFlags: 0, health: 132 }, T0 + 20_100);
    // No poll: the latched rows are already in the buffer.
    expect(r.rows()).toEqual([
      { ts: died.ts, seq: died.seq, kind: "death", position: { map: 0, x: -6572, y: 405, z: 387, source: "death_spot" }, zone: ZONE, area: AREA, released: false },
      { ts: released.ts, seq: released.seq, kind: "release", graveyard: { map: 0, x: -6164, y: 336, z: 399 } },
      { ts: back.ts, seq: back.seq, kind: "resurrect" },
    ]);
    r.rec.stop();
  });

  test("a takeoff and a landing are rows with the flip's own ts, seq, position and area", () => {
    const r = rig();
    r.enter({ zoneId: 9201, areaId: 9201 }, T0 + 100);
    r.selfFields({ unitFlags: 0x8 }, T0 + 110);
    r.rec.start();
    r.rows();
    r.feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply: 0, ok: true }, T0 + 1_000);
    r.feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: { x: -6572, y: 405, z: 387 }, destination: { x: -5421, y: -2930, z: 351.5 }, durationMs: 120_000 }, T0 + 1_050);
    const off = r.selfFields({ unitFlags: 0x100008 }, T0 + 1_100);
    r.area(9202, 9202, T0 + 60_000);
    const down = r.selfFields({ unitFlags: 0x8 }, T0 + 121_100);
    const rows = r.rows().filter((x) => x.kind === "taxi" || x.kind === "taxi_landed");
    expect(rows).toEqual([
      { ts: off.ts, seq: off.seq, kind: "taxi", position: { map: 0, x: -6572, y: 405, z: 387 }, zone: 9201, area: 9201 },
      { ts: down.ts, seq: down.seq, kind: "taxi_landed", position: { map: 0, x: -5421, y: -2930, z: 351.5 }, zone: 9202, area: 9202 },
    ]);
    r.rec.stop();
  });

  test("the first map reading is a baseline stated in a key, never an instance row, so a recorder started inside a dungeon says so", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    r.rows();
    const first = r.area(9181, 9181, T0 + 150, { mapId: 901, instanceType: 1 });
    const seeded = r.rows();
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ ts: first.ts, seq: first.seq, kind: "key", state: { map: 901, instanceType: 1 } });
    // Only the first: a later reading of the same map states nothing.
    r.area(9181, 9182, T0 + 300, { mapId: 901, instanceType: 1 });
    expect(r.rows()).toEqual([]);
    r.rec.stop();
  });

  test("group, instance and kill rows carry their packet's ts and seq; a group row says foreign 0 before the gate", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.rec.start();
    // The watcher hears only what arrives after `start()`: this first map
    // reading seeds it silently, as a resumed process's would.
    r.area(ZONE, AREA, T0 + 150, { mapId: 0, instanceType: 0 });
    r.rec.poll();
    r.rows();
    const joined = r.groupList(["11", "12", "13", "14"], "7", T0 + 1_000);
    const entered = r.area(9181, 9181, T0 + 2_000, { mapId: 901, instanceType: 1 });
    const boss = unitGuid(90639, 0x51);
    r.feed("SMSG_CREATURE_QUERY_RESPONSE", 0x61, { entry: 90639, found: true, name: "Invented Boss", subname: "", type: 7, rank: 1 }, T0 + 2_500);
    const kill = r.feed("SMSG_PARTYKILLLOG", 0x1f5, { killerGuid: "12", victimGuid: boss }, T0 + 3_000);
    const left = r.feed("SMSG_GROUP_DESTROYED", 0x33c, {}, T0 + 4_000);
    const latched = r.rows();
    expect(latched).toEqual([
      { ts: joined.ts, seq: joined.seq, kind: "group", event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["11", "12", "13", "14"], count: 5, foreign: 0 },
      { ts: entered.ts, seq: entered.seq, kind: "instance", event: "entered", map: 901, instanceType: 1, from: { map: 0, instanceType: 0 } },
      { ts: kill.ts, seq: kill.seq, kind: "kill", killerGuid: "12", victimGuid: boss, entry: 90639, rank: 1, self: false, member: true },
      { ts: left.ts, seq: left.seq, kind: "group", event: "left", members: [], count: 0, foreign: 0 },
    ]);
    // The zone and area the portal changed are the poll's, after the latched rows.
    r.rec.poll();
    expect(kinds(r.rows())).toEqual(["zone", "area"]);
    r.rec.stop();
  });

  test("stopped, the recorder hears nothing more", () => {
    const r = rig();
    r.enter({}, T0 + 100);
    r.selfFields({ health: 186, maxHealth: 186 }, T0 + 110);
    r.rec.start();
    r.rows();
    r.rec.stop();
    r.selfFields({ health: 0 }, T0 + 1_000);
    r.groupList(["11"], "7", T0 + 1_100);
    expect(r.rows()).toEqual([]);
  });
});

describe("events recorder: the cap", () => {
  test("past the cap the oldest rows go and each one dropped is counted; a drain resets the count", () => {
    const r = rig({ cap: 3 });
    r.enter({}, T0 + 100);
    r.rec.start();
    // key, zone, area, level: one over the cap already.
    for (let i = 1; i <= 4; i++) {
      r.area(ZONE, AREA + i, T0 + 1_000 * i);
      r.rec.poll();
    }
    const d = r.rec.drain();
    expect(d.rows.map((x) => (x.kind === "area" ? x.to : x.kind))).toEqual([AREA + 2, AREA + 3, AREA + 4]);
    expect(d.dropped).toBe(5);
    expect(r.rec.drain()).toEqual({ rows: [], dropped: 0 });
    r.rec.stop();
  });
});
