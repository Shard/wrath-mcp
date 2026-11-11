/**
 * The write gate (`src/record/gate.ts`): the rules for other players in
 * `docs/SESSION-FORMAT.md`, each applied to the row a recorder would send.
 */

import { describe, expect, test } from "bun:test";
import { PLAYER_REF, type CallRow, type EventRow, type NearbyRow, type NearbyUnit, type TraceRow } from "../src/record/format";
import { WriteGate } from "../src/record/gate";

const SELF = "5";
const OWN = "6";
const FOREIGN = "77";
const CREATURE = String((0xf130n << 48n) | (4101n << 24n) | 9n);
const PET = String((0xf140n << 48n) | (900n << 24n) | 3n);

const gate = (): WriteGate => {
  const g = new WriteGate((guid) => guid === OWN);
  g.setSelf(SELF);
  return g;
};
const unit = (id: string, s: NearbyUnit["s"] = {}, ty: NearbyUnit["ty"] = "creature"): NearbyUnit => ({ id, ty, s, m: { k: "pos", t: 1, p: [0, 0, 0] } });

describe("trace", () => {
  test("a player target is its kind and nothing else; a creature's is untouched", () => {
    const player: TraceRow = { ts: 1, kind: "state", data: { target: { kind: "player", hpPct: 40 } } };
    expect(gate().gate("trace", player)).toEqual({ ts: 1, kind: "state", data: { target: { kind: "player" } } });
    const creature: TraceRow = { ts: 1, kind: "state", data: { target: { kind: "creature", entry: 4101, hpPct: 40 } } };
    expect(gate().gate("trace", creature)).toBe(creature);
  });

  test("the character's own chat passes as written", () => {
    const row: TraceRow = { ts: 1, kind: "state", data: { chat: [["say", "over here"]] } };
    expect(gate().gate("trace", row)).toBe(row);
  });
});

describe("nearby", () => {
  test("no player unit is written, own or foreign, on any row kind", () => {
    const g = gate();
    const key: NearbyRow = {
      ts: 1,
      kind: "key",
      self: { guid: SELF, map: 0, target: FOREIGN, down: false },
      units: [unit(CREATURE), unit(FOREIGN, {}, "player" as never), unit(OWN, {}, "player" as never)],
    };
    const out = g.gate("nearby", key) as Extract<NearbyRow, { kind: "key" }>;
    expect(out.units.map((u) => u.id)).toEqual([CREATURE]);
    expect(out.self.target).toBe(PLAYER_REF);
    expect(g.gate("nearby", { ts: 2, kind: "in", u: unit(FOREIGN, {}, "player" as never) })).toBeNull();
    for (const kind of ["pos", "mv"] as const) expect(g.gate("nearby", { ts: 2, kind, id: OWN, m: { k: kind, t: 2, p: [1, 1, 1] } })).toBeNull();
    expect(g.gate("nearby", { ts: 2, kind: "st", id: FOREIGN, s: { hp: 50 } })).toBeNull();
    expect(g.gate("nearby", { ts: 2, kind: "nm", id: FOREIGN, name: "Bystander" })).toBeNull();
    expect(g.gate("nearby", { ts: 2, kind: "out", id: FOREIGN })).toBeNull();
  });

  test("a unit a foreign player owns or charms is not written, nor anything about it, until it leaves and returns", () => {
    const g = gate();
    expect(g.gate("nearby", { ts: 1, kind: "in", u: unit(PET, { ow: FOREIGN }, "pet") })).toBeNull();
    expect(g.gate("nearby", { ts: 2, kind: "st", id: PET, s: { hp: 10 } })).toBeNull();
    expect(g.gate("nearby", { ts: 3, kind: "out", id: PET })).toBeNull();
    // Back in view with no owner: an ordinary unit again.
    expect(g.gate("nearby", { ts: 4, kind: "in", u: unit(PET, {}, "pet") })).not.toBeNull();
    // Another session's pet is not this session's to write either.
    expect(g.gate("nearby", { ts: 5, kind: "in", u: unit(PET, { ch: OWN }, "pet") })).toBeNull();
  });

  test("the session's own pet is written, with its owner", () => {
    const row: NearbyRow = { ts: 1, kind: "in", u: unit(PET, { ow: SELF }, "pet") };
    expect(gate().gate("nearby", row)).toBe(row);
  });

  test("a unit a foreign player takes while in view leaves the record there", () => {
    const g = gate();
    g.gate("nearby", { ts: 1, kind: "in", u: unit(CREATURE) });
    expect(g.gate("nearby", { ts: 2, kind: "st", id: CREATURE, s: { ch: FOREIGN } })).toEqual({ ts: 2, kind: "out", id: CREATURE });
    expect(g.gate("nearby", { ts: 3, kind: "pos", id: CREATURE, m: { k: "pos", t: 3, p: [1, 1, 1] } })).toBeNull();
  });

  test("a unit's player target is cut to its kind, and whether it is this character survives", () => {
    const g = gate();
    const out = g.gate("nearby", { ts: 1, kind: "st", id: CREATURE, s: { tg: FOREIGN, tgs: false } });
    expect(out).toEqual({ ts: 1, kind: "st", id: CREATURE, s: { tg: PLAYER_REF, tgs: false } });
    expect(g.gate("nearby", { ts: 1, kind: "st", id: CREATURE, s: { tg: SELF, tgs: true } })).toEqual({ ts: 1, kind: "st", id: CREATURE, s: { tg: PLAYER_REF, tgs: true } });
    expect(g.gate("nearby", { ts: 1, kind: "self", self: { target: OWN } })).toEqual({ ts: 1, kind: "self", self: { target: PLAYER_REF } });
  });
});

describe("events", () => {
  test("own members are kept and foreign ones counted; a foreign leader is left out", () => {
    const row: EventRow = { ts: 1, kind: "group", event: "joined", groupGuid: "g", leaderGuid: FOREIGN, members: [OWN, FOREIGN, "78"], foreign: 0, count: 4 };
    expect(gate().gate("events", row)).toEqual({ ts: 1, kind: "group", event: "joined", groupGuid: "g", members: [OWN], foreign: 2, count: 4 });
    const led: EventRow = { ...row, leaderGuid: SELF };
    expect((gate().gate("events", led) as { leaderGuid?: string }).leaderGuid).toBe(SELF);
  });

  test("a key row's group is gated the same way", () => {
    const key: EventRow = {
      ts: 1,
      kind: "key",
      state: { level: 3, zone: 1, area: 1, map: 0, instanceType: 0, dead: false, released: false, taxi: false, group: { members: [FOREIGN], foreign: 0, count: 2 } },
    };
    expect((gate().gate("events", key) as Extract<EventRow, { kind: "key" }>).state.group).toEqual({ members: [], foreign: 1, count: 2 });
  });

  test("a foreign killer is left out; whose kill it was is still said", () => {
    const base = { ts: 1, kind: "kill" as const, victimGuid: CREATURE, entry: 4101, self: false, member: true };
    expect(gate().gate("events", { ...base, killerGuid: FOREIGN })).toEqual(base);
    expect(gate().gate("events", { ...base, killerGuid: OWN })).toEqual({ ...base, killerGuid: OWN });
    expect(gate().gate("events", { ...base, killerGuid: SELF, self: true })).toEqual({ ...base, killerGuid: SELF, self: true });
  });

  test("with no index of the deployment, every other player is foreign", () => {
    const g = new WriteGate();
    g.setSelf(SELF);
    const row: EventRow = { ts: 1, kind: "group", event: "joined", members: [OWN], foreign: 0, count: 2 };
    expect(g.gate("events", row)).toMatchObject({ members: [], foreign: 1 });
  });
});

describe("calls", () => {
  const move = (target: string | null): CallRow => ({ ts: 1, kind: "move", origin: { type: "tool" }, at: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3, target, name: "Someone", status: null });

  test("a move aimed at a foreign player keeps its destination and loses its target and name", () => {
    expect(gate().gate("calls", move(FOREIGN))).toEqual({ ts: 1, kind: "move", origin: { type: "tool" }, at: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3, target: null, status: null });
  });

  test("one aimed at a creature or an own session is written whole", () => {
    for (const target of [CREATURE, OWN]) {
      const row = move(target);
      expect(gate().gate("calls", row)).toBe(row);
    }
  });

  const freeText = (): CallRow[] => [
    { ts: 1, kind: "call", id: 1, origin: { type: "tool" }, tool: "run_snippet", args: { code: `await sdk.whisper("Bystander", "hi"); await sdk.interact({ guid: "${FOREIGN}" })` } },
    { ts: 1, kind: "result", id: 1, text: `saw Bystander (guid ${FOREIGN}) {"senderGuid":"${FOREIGN}","guids":["${OWN}","${FOREIGN}"]}`, error: false, durationMs: 1 },
    { ts: 1, kind: "actions", origin: { type: "tool" }, actions: [{ ts: 1, action: "set_target", args: { guid: FOREIGN }, status: 200, ms: 1, names: { target: "Bystander" } }] },
    { ts: 1, kind: "events", origin: { type: "tool" }, count: 1, events: [{ seq: 1, ts: 1, opcode: "SMSG_MESSAGECHAT", data: { senderGuid: FOREIGN, text: "Bystander waves" } }] },
  ];

  test("with no player names answered, free text is written as it was", () => {
    for (const row of freeText()) expect(gate().gate("calls", row)).toBe(row);
  });

  test("a foreign player's guid and answered name are scrubbed from every kind of free text", () => {
    const g = gate();
    g.notePlayers([[FOREIGN, "Bystander"]]);
    const out = freeText().map((row) => g.gate("calls", row));
    expect(out).toEqual([
      { ts: 1, kind: "call", id: 1, origin: { type: "tool" }, tool: "run_snippet", args: { code: `await sdk.whisper("player", "hi"); await sdk.interact({ guid: "player" })` } },
      { ts: 1, kind: "result", id: 1, text: `saw player (guid player) {"senderGuid":"player","guids":["${OWN}","player"]}`, error: false, durationMs: 1 },
      { ts: 1, kind: "actions", origin: { type: "tool" }, actions: [{ ts: 1, action: "set_target", args: { guid: PLAYER_REF }, status: 200, ms: 1, names: { target: PLAYER_REF } }] },
      { ts: 1, kind: "events", origin: { type: "tool" }, count: 1, events: [{ seq: 1, ts: 1, opcode: "SMSG_MESSAGECHAT", data: { senderGuid: PLAYER_REF, text: "player waves" } }] },
    ]);
    // A key row restates the calls in flight, scrubbed the same way.
    const key: CallRow = { ts: 2, kind: "key", open: [freeText()[0] as Extract<CallRow, { kind: "call" }>] };
    expect((g.gate("calls", key) as Extract<CallRow, { kind: "key" }>).open[0]!.args).toEqual({ code: `await sdk.whisper("player", "hi"); await sdk.interact({ guid: "player" })` });
  });

  test("the character itself and the deployment's other sessions are never scrubbed", () => {
    const g = gate();
    g.notePlayers([
      [SELF, "Quillon"],
      [OWN, "Partner"],
    ]);
    for (const row of [...freeText(), { ts: 1, kind: "result", id: 1, text: `Quillon (guid ${SELF}) and Partner (guid ${OWN})`, error: false, durationMs: 1 } as CallRow]) {
      expect(g.gate("calls", row)).toBe(row);
    }
  });

  test("own or foreign is asked as the row is written, so a session the index learns of later is kept", () => {
    const own = new Set<string>();
    const g = new WriteGate((guid) => own.has(guid));
    g.setSelf(SELF);
    g.notePlayers([[OWN, "Partner"]]);
    const row: CallRow = { ts: 1, kind: "result", id: 1, text: `Partner (guid ${OWN})`, error: false, durationMs: 1 };
    expect(g.gate("calls", row)).toMatchObject({ text: "player (guid player)" });
    own.add(OWN);
    expect(g.gate("calls", row)).toBe(row);
  });

  test("a number equal to a foreign guid is kept wherever it is not a guid: damage, coordinates, counts, ids", () => {
    const g = gate();
    g.notePlayers([[FOREIGN, "Bystander"]]);
    const text = `hit for ${FOREIGN} damage at (${FOREIGN}, ${FOREIGN}.5, -${FOREIGN}); looted ${FOREIGN}x Linen Cloth (item ${FOREIGN}); {"damage":${FOREIGN},"count":"${FOREIGN}","x":${FOREIGN}}; level: ${FOREIGN}`;
    const rows: CallRow[] = [
      { ts: 1, kind: "result", id: 1, text, error: false, durationMs: 1 },
      { ts: 1, kind: "call", id: 1, origin: { type: "tool" }, tool: "run_snippet", args: { code: `await sdk.useItem(${FOREIGN}); await sdk.moveTo(${FOREIGN}, -${FOREIGN}, 0)`, count: FOREIGN } },
      { ts: 1, kind: "actions", origin: { type: "tool" }, actions: [{ ts: 1, action: "move_to", args: { x: Number(FOREIGN), y: 1, z: 2, itemId: FOREIGN }, status: 200, ms: 1 }] },
      {
        ts: 1,
        kind: "events",
        origin: { type: "tool" },
        count: 1,
        events: [{ seq: 1, ts: 1, opcode: "SMSG_SPELLNONMELEEDAMAGELOG", data: { damage: Number(FOREIGN), amount: FOREIGN, spellId: FOREIGN, [FOREIGN]: "x", pos: { x: Number(FOREIGN) } } }],
      },
    ];
    for (const row of rows) expect(g.gate("calls", row)).toBe(row);
  });

  test("only whole words and whole guids match: a longer number or word that contains one is kept", () => {
    const g = gate();
    g.notePlayers([[FOREIGN, "Bystander"]]);
    const row: CallRow = { ts: 1, kind: "result", id: 1, text: `guid ${FOREIGN}0 {"guid":"${FOREIGN}7"} Bystanders bystander`, error: false, durationMs: 1 };
    expect(g.gate("calls", row)).toBe(row);
    const quoted: CallRow = { ts: 1, kind: "result", id: 1, text: `{ guid: "${FOREIGN}", name: "Bystander's", hitGuids: [ "${FOREIGN}", "1" ] }`, error: false, durationMs: 1 };
    expect(g.gate("calls", quoted)).toMatchObject({ text: `{ guid: "player", name: "player's", hitGuids: [ "player", "1" ] }` });
    // A guid-named key's value, or a list under one, in structured data.
    const keyed: CallRow = { ts: 1, kind: "events", origin: { type: "tool" }, count: 1, events: [{ seq: 1, ts: 1, opcode: "X", data: { casterGuid: FOREIGN, mover: FOREIGN, guids: [OWN, FOREIGN], Bystander: 3 } }] };
    expect(g.gate("calls", keyed)).toMatchObject({ events: [{ data: { casterGuid: PLAYER_REF, mover: PLAYER_REF, guids: [OWN, PLAYER_REF], player: 3 } }] });
  });

  test("a name shorter than three characters is never scrubbed", () => {
    const g = gate();
    g.notePlayers([[FOREIGN, "Bo"]]);
    const row: CallRow = { ts: 1, kind: "result", id: 1, text: "Bo said hi", error: false, durationMs: 1 };
    expect(g.gate("calls", row)).toBe(row);
  });

  test("nothing is scrubbed before the session's own character is known, so it is never taken for a stranger", () => {
    const g = new WriteGate(() => false);
    g.notePlayers([[SELF, "Quillon"]]);
    const row: CallRow = { ts: 1, kind: "result", id: 1, text: `logged in: Quillon (guid ${SELF})`, error: false, durationMs: 1 };
    expect(g.gate("calls", row)).toBe(row);
    g.setSelf(SELF);
    expect(g.gate("calls", row)).toBe(row);
  });

  test("a guid the host says is own is kept before any index knows it", () => {
    const g = new WriteGate(() => false);
    g.setSelf(SELF);
    g.notePlayers([[OWN, "Partner"]]);
    const row: CallRow = { ts: 1, kind: "result", id: 1, text: "Partner", error: false, durationMs: 1 };
    expect(g.gate("calls", row)).toMatchObject({ text: PLAYER_REF });
    g.noteOwn(OWN);
    expect(g.gate("calls", row)).toBe(row);
  });

  test("a renamed player is looked for by the name answered last", () => {
    const g = gate();
    g.notePlayers([[FOREIGN, "Bystander"]]);
    g.notePlayers([[FOREIGN, "Passerby"]]);
    const row: CallRow = { ts: 1, kind: "result", id: 1, text: "Bystander Passerby", error: false, durationMs: 1 };
    expect(g.gate("calls", row)).toMatchObject({ text: "Bystander player" });
  });
});
