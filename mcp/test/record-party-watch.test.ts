/**
 * The party watcher (`record/party-watch.ts`): `group`, `instance` and `kill`
 * transitions, latched off the packets the server sends a client anyway, for
 * the events recorder to turn into rows.
 *
 * The watcher alone, over a cache the test sets by hand: it reads a narrow
 * slice of the SDK's state (`PartyWatchState`), so its transitions are pinned
 * here without a stream. That the events recorder feeds it real folded events
 * and writes what it drains is `record-events-recorder.test.ts`. The packet
 * shapes are module/PROTOCOL.md's (`instanceType` on `WB_AREA`,
 * `killerGuid`/`victimGuid` on `SMSG_PARTYKILLLOG`). Guids, ids and positions
 * are invented; nothing is captured from a running game.
 */

import { describe, expect, test } from "bun:test";
import { PARTY_SIGNAL_CAP, PartyWatcher, groupKeyOf, type PartySignal, type PartyWatchState } from "../src/record/party-watch";
import { unitGuid } from "./fixtures/nearby-frames";

/** A cache the test sets by hand. */
function fakeState(): PartyWatchState & {
  g: ReturnType<PartyWatchState["group"]>;
  objects: Map<string, { entry: number | undefined; type: string | undefined }>;
  ranks: Map<number, number>;
} {
  const s = {
    g: undefined as ReturnType<PartyWatchState["group"]>,
    objects: new Map<string, { entry: number | undefined; type: string | undefined }>(),
    ranks: new Map<number, number>(),
    group: () => s.g,
    selfGuid: () => "7",
    objectOf: (guid: string) => s.objects.get(guid),
    rankOf: (entry: number) => s.ranks.get(entry),
  };
  return s;
}

let seq = 0;
const ev = (opcode: string, data: unknown = {}): { opcode: string; ts: number; seq: number; data: unknown } => ({ opcode, ts: 1000 + ++seq, seq, data });
const inGroup = (members: string[], leader = "7", groupGuid = "9001") => ({
  inGroup: true,
  groupGuid,
  leaderGuid: leader,
  members: members.map((guid) => ({ guid })),
});

/** Invented ids: a continent map, an instance map, and the zone/area pairs around them. */
const CONTINENT = 0;
const DUNGEON = 901;
const BOSS = 90639;

describe("the party watcher: group", () => {
  test("a login list is joined; a new member or leader is changed; leaving is left; nothing repeats", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.g = inGroup(["11", "12", "13", "14"]);
    w.observe(ev("SMSG_GROUP_LIST"));
    w.observe(ev("SMSG_GROUP_LIST")); // the same list again: nothing
    st.g = inGroup(["11", "12", "13", "14"], "11");
    w.observe(ev("SMSG_GROUP_SET_LEADER"));
    st.g = { inGroup: false, groupGuid: undefined, leaderGuid: undefined, members: [] };
    w.observe(ev("SMSG_GROUP_DESTROYED"));
    const got = w.drain();
    expect(got.map((s) => (s.kind === "group" ? s.event : s.kind))).toEqual(["joined", "changed", "left"]);
    expect(got[0]).toMatchObject({ kind: "group", groupGuid: "9001", leaderGuid: "7", members: ["11", "12", "13", "14"], count: 5 });
    expect(got[1]).toMatchObject({ leaderGuid: "11" });
    expect(got[2]).toMatchObject({ members: [], count: 0 });
    expect(got[2]).not.toHaveProperty("groupGuid");
    expect(w.drain()).toEqual([]);
  });

  test("a first reading outside a group seeds silently", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.g = { inGroup: false, groupGuid: undefined, leaderGuid: undefined, members: [] };
    w.observe(ev("SMSG_GROUP_LIST"));
    expect(w.drain()).toEqual([]);
  });

  test("a member list in another order is the same group; only the group opcodes are read for it", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.g = inGroup(["11", "12"]);
    w.observe(ev("SMSG_GROUP_LIST"));
    st.g = inGroup(["12", "11"]);
    w.observe(ev("SMSG_GROUP_LIST"));
    // A change the watcher is not shown a group packet for is not read.
    st.g = inGroup(["12", "11", "13"]);
    w.observe(ev("SMSG_UPDATE_OBJECT"));
    expect(w.drain().map((s) => (s.kind === "group" ? s.event : s.kind))).toEqual(["joined"]);
    expect(groupKeyOf({ groupGuid: "9001", leaderGuid: "7", members: ["11", "12"], count: 3 })).toBe(groupKeyOf({ groupGuid: "9001", leaderGuid: "7", members: ["12", "11"], count: 3 }));
    expect(groupKeyOf({ members: [], count: 0 })).toBe("out");
  });
});

describe("the party watcher: instance", () => {
  test("an instance is a map change whose instance type changed, seeded silently, and silent with no instanceType", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    // No instanceType: a module that does not serve it yet.
    w.observe(ev("WB_AREA", { mapId: CONTINENT, zoneId: 9140, zoneName: "", areaId: 9120, areaName: "" }));
    w.observe(ev("WB_AREA", { mapId: DUNGEON, zoneId: 9181, zoneName: "", areaId: 9181, areaName: "" }));
    expect(w.drain()).toEqual([]);
    // Seeded on the continent, a subzone change on the same map, then the portal.
    w.observe(ev("WB_AREA", { mapId: CONTINENT, instanceType: 0, zoneId: 9140, zoneName: "", areaId: 9120, areaName: "" }));
    w.observe(ev("WB_AREA", { mapId: CONTINENT, instanceType: 0, zoneId: 9140, zoneName: "", areaId: 9121, areaName: "" }));
    w.observe(ev("WB_AREA", { mapId: DUNGEON, instanceType: 1, zoneId: 9181, zoneName: "", areaId: 9181, areaName: "" }));
    // Out by the far trigger, and a reattach that says where the character is.
    w.observe(ev("WB_SESSION_STATE", { map: CONTINENT, instanceType: 0, x: 0, y: 0, z: 0 }));
    const got = w.drain();
    expect(got).toEqual([
      expect.objectContaining({ kind: "instance", event: "entered", map: DUNGEON, instanceType: 1, from: { map: CONTINENT, instanceType: 0 } }),
      expect.objectContaining({ kind: "instance", event: "left", map: CONTINENT, instanceType: 0, from: { map: DUNGEON, instanceType: 1 } }),
    ]);
  });

  test("a map change inside one instance type writes nothing (a tram, a continent hop)", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    w.observe(ev("WB_AREA", { mapId: 0, instanceType: 0 }));
    w.observe(ev("WB_AREA", { mapId: 1, instanceType: 0 }));
    w.observe(ev("WB_AREA", { mapId: 902, instanceType: 0 }));
    expect(w.drain()).toEqual([]);
  });
});

describe("the party watcher: kill", () => {
  test("a kill of rank 1 or above is recorded with its entry and rank; rank 0 and players are not; an unanswered rank is", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.objects.set("4000", { entry: BOSS, type: "unit" });
    st.ranks.set(BOSS, 1);
    st.objects.set("4001", { entry: 90299, type: "unit" });
    st.ranks.set(90299, 0);
    st.objects.set("4002", { entry: 90657, type: "unit" }); // no creature query answered
    st.objects.set("42", { entry: undefined, type: "player" });
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "7", victimGuid: "4000" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "11", victimGuid: "4001" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killer: 11, victim: "4002" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "11", victimGuid: "42" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "not a guid" }));
    const got = w.drain() as Extract<PartySignal, { kind: "kill" }>[];
    expect(got.map((k) => [k.victimGuid, k.entry, k.rank, k.self])).toEqual([
      ["4000", BOSS, 1, true],
      ["4002", 90657, undefined, false],
    ]);
    expect(got[1]!.killerGuid).toBe("11");
  });

  test("a kill says whether its killer is this character or a group member, and names a victim out of sight by its guid", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.g = inGroup(["11", "12", "13", "14"]);
    // A creature guid as a party's tank was told of one: high 0xF130, the entry in bits 24..47.
    const boss = unitGuid(BOSS, 0x51);
    st.ranks.set(BOSS, 1);
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "12", victimGuid: boss }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "7", victimGuid: boss }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "99", victimGuid: boss }));
    const got = w.drain() as Extract<PartySignal, { kind: "kill" }>[];
    expect(got.map((k) => [k.killerGuid, k.entry, k.rank, k.self, k.member])).toEqual([
      ["12", BOSS, 1, false, true],
      ["7", BOSS, 1, true, true],
      ["99", BOSS, 1, false, false],
    ]);
    // The packet's own instant, not the drain's.
    expect(got.map((k) => k.ts)).toEqual(got.map((k) => 1000 + k.seq));
  });

  test("an undrained backlog keeps the newest signals up to the cap", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    for (let i = 0; i < PARTY_SIGNAL_CAP + 10; i++) w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "7", victimGuid: unitGuid(90700, i + 1) }));
    const got = w.drain() as Extract<PartySignal, { kind: "kill" }>[];
    expect(got).toHaveLength(PARTY_SIGNAL_CAP);
    expect(got[0]!.victimGuid).toBe(unitGuid(90700, 11));
  });
});
