import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { STREAM_GAP, type StreamEvent, type StreamGapEvent } from "../src/events";
import { pointOf, StateCache, type UnitFilter } from "../src/state";
import {
  addKill,
  auraRemoved,
  auraUpdate,
  auraUpdateAll,
  BACKPACK_SLOT,
  chatEcho,
  inventorySlot,
  ITEM_ENTRY,
  ITEM_GUID,
  itemCreate,
  itemQuery,
  monsterMove,
  monsterStopped,
  OTHER_QUEST_ID,
  QUEST_ID,
  questAccepted,
  questChained,
  questCombatStream,
  questComplete,
  questProgress,
  questRewarded,
  selfProgress,
  selfTarget,
  CREATURE_ENTRY,
  CREATURE_GUID,
  creatureCreate,
  creatureDestroy,
  creatureMove,
  creatureOutOfRange,
  creatureQuery,
  creatureValues,
  fullStream,
  loginSequence,
  moveProgress,
  moveResult,
  notification,
  PLAYER_GUID,
  playerCreate,
  playerName,
  selfCreate,
  worldStream,
} from "./fixtures";

function toEvents(frames: readonly unknown[]): GameEvent[] {
  return frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

const SEED = { guid: "7", name: "Fenwick" };

describe("state cache: what it learns from events", () => {
  test("char enum populates known characters and self level", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: SEED });
    expect(cache.characters?.value).toHaveLength(2);
    expect(cache.characters?.value.map((c) => c.name)).toEqual(["Fenwick", "Quilby"]);
    expect(cache.characters?.seq).toBe(1);
    expect(cache.self.level?.value).toBe(3);
    expect(cache.self.level?.seq).toBe(1);
  });

  test("login verify world is the only source of position, and says so", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: SEED });
    expect(cache.self.position?.value).toEqual({ map: 0, x: -1234.5, y: 987.25, z: 42.125, o: 3.5 });
    expect(cache.self.position?.seq).toBe(2);
    expect(cache.self.position?.ts).toBe(1_700_000_000_020);
  });

  test("motd, chat tail and notifications come off their own opcodes", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.motd?.value).toEqual(["fixture line one", "fixture line two"]);
    expect(cache.chat).toHaveLength(1);
    expect(cache.chat[0]?.message).toBe("ping from the fixture");
    expect(cache.chat[0]?.senderGuid).toBe("7");
    expect(cache.notifications).toEqual([
      { seq: 7, ts: 1_700_000_000_070, text: "fixture notification" },
    ]);
  });

  test("names come only from name-query hits", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.nameOf("9")).toBe("Ordrick");
    expect(cache.nameOf("10")).toBeUndefined();
    expect(cache.names.size).toBe(1);
  });
});

describe("state cache: what it refuses to invent", () => {
  test("health and power stay undefined — no Stage-2 opcode carries them", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.self.health).toBeUndefined();
    expect(cache.self.power).toBeUndefined();
  });

  test("a chat sender does not become a nearby object", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.nearby.size).toBe(0);
  });

  test("without a seed, self identity stays unknown", () => {
    const cache = StateCache.replay(toEvents(loginSequence));
    expect(cache.self.guid).toBeUndefined();
    expect(cache.self.level).toBeUndefined();
    expect(cache.characters?.value).toHaveLength(2);
  });

  test("seeding by name alone still resolves self from the char enum", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: { name: "Quilby" } });
    expect(cache.self.guid).toBe("8");
    expect(cache.self.level?.value).toBe(11);
  });

  test("a decode-error packet contributes no fields", () => {
    const undecodable = toEvents([
      { seq: 0, opcode: "SMSG_MESSAGECHAT", opcodeId: 0x096, ts: 1, data: { decodeError: true } },
    ]);
    const cache = StateCache.replay(undecodable, { seed: SEED });
    expect(cache.chat).toHaveLength(0);
    expect(cache.lastSeq).toBe(0);
    expect(cache.eventCount).toBe(1);
  });

  test("an unknown opcode advances lastSeq and nothing else", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.lastSeq).toBe(10);
    expect(cache.eventCount).toBe(11);
  });
});

describe("state cache: the update-object fold", () => {
  test("a create block puts a typed, positioned object in view", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, creatureCreate]), { seed: SEED });
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj).toBeDefined();
    expect(obj?.objectType?.value).toBe("unit");
    expect(obj?.entry?.value).toBe(CREATURE_ENTRY);
    expect(obj?.level?.value).toBe(4);
    expect(obj?.position?.value).toEqual({ x: -1200, y: 980, z: 42, o: 1.5 });
    expect(obj?.health?.value).toEqual({ current: 120, max: 120 });
    expect(obj?.power?.value).toEqual({ current: 50, max: 100 });
    // A nearby object's map is on no packet, so its position does not claim one.
    expect((obj?.position?.value as { map?: number }).map).toBeUndefined();
  });

  test("a values delta merges per field, each keeping its own provenance", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, creatureCreate, creatureValues]),
      { seed: SEED },
    );
    const obj = cache.nearby.get(CREATURE_GUID);
    // health moved and says so; maxHealth is still the create block's word.
    expect(obj?.fields.get("health")).toEqual({ value: 60, seq: 13, ts: 1_700_000_000_130 });
    expect(obj?.fields.get("maxHealth")).toEqual({ value: 120, seq: 11, ts: 1_700_000_000_110 });
    expect(obj?.health?.value).toEqual({ current: 60, max: 120 });
    expect(obj?.health?.seq).toBe(13);
    // Untouched fields are neither refreshed nor dropped.
    expect(obj?.level?.value).toBe(4);
    expect(obj?.level?.seq).toBe(11);
    expect(obj?.lastSeq).toBe(13);
    expect(obj?.firstSeq).toBe(11);
  });

  test("a creature query names the object, by entry, whenever it arrives", () => {
    const before = StateCache.replay(
      toEvents([...loginSequence, creatureCreate, creatureQuery]),
      { seed: SEED },
    );
    expect(before.nearby.get(CREATURE_GUID)?.name?.value).toBe("Thistlebore");
    // Same answer if the query response lands before the create block.
    const after = StateCache.replay(
      toEvents([...loginSequence, creatureQuery, creatureCreate]),
      { seed: SEED },
    );
    expect(after.nearby.get(CREATURE_GUID)?.name?.value).toBe("Thistlebore");
    // An empty subname is not a subname.
    expect(before.creatures.get(CREATURE_ENTRY)?.value.subname).toBeUndefined();
  });

  test("a player is named by a name query, not a creature query", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, playerCreate, playerName]),
      { seed: SEED },
    );
    expect(cache.nearby.get(PLAYER_GUID)?.name?.value).toBe("Quilby");
  });

  test("MSG_MOVE_* moves a nearby object and nothing else", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, creatureCreate, creatureMove]),
      { seed: SEED },
    );
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.position?.value).toEqual({ x: -1210, y: 985, z: 42, o: 2 });
    expect(obj?.position?.seq).toBe(14);
    expect(obj?.health?.value).toEqual({ current: 120, max: 120 });
  });

  test("outOfRange and destroy prune the object, but never its name", () => {
    for (const removal of [creatureOutOfRange, creatureDestroy]) {
      const cache = StateCache.replay(
        toEvents([...loginSequence, creatureCreate, creatureQuery, removal]),
        { seed: SEED },
      );
      expect(cache.nearby.size).toBe(0);
      // The module will not re-query an entry it has already asked about, so
      // dropping this would make the creature permanently nameless on return.
      expect(cache.creatures.get(CREATURE_ENTRY)?.value.name).toBe("Thistlebore");
    }
  });

  test("a near-objects block is not a removal", () => {
    const near = {
      ...creatureOutOfRange,
      seq: 15,
      data: { blocks: 1, objects: [{ update: "near", guids: [CREATURE_GUID] }] },
    };
    const cache = StateCache.replay(toEvents([...loginSequence, creatureCreate, near]), {
      seed: SEED,
    });
    expect(cache.nearby.size).toBe(1);
  });

  test("half a gauge is not a gauge, and a power bar without powerType is a guess", () => {
    const partial = {
      ...creatureCreate,
      data: {
        blocks: 1,
        objects: [
          {
            update: "create",
            guid: CREATURE_GUID,
            objectType: "unit",
            fields: { entry: CREATURE_ENTRY, health: 40, power1: 10, maxPower1: 20 },
          },
        ],
      },
    };
    const cache = StateCache.replay(toEvents([...loginSequence, partial]), { seed: SEED });
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.health).toBeUndefined();
    expect(obj?.power).toBeUndefined();
    // …but what *was* observed is still there, raw.
    expect(obj?.fields.get("health")?.value).toBe(40);
    expect(obj?.fields.get("power1")?.value).toBe(10);
  });

  test("a values delta for an object never created records it without typing it", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, creatureValues]), { seed: SEED });
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.objectType).toBeUndefined();
    expect(obj?.fields.get("health")?.value).toBe(60);
    expect(cache.nearbyUnits()).toHaveLength(0);
  });
});

describe("state cache: self, from the wire", () => {
  test("the self create block feeds self and stays out of nearby", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate]), { seed: SEED });
    expect(cache.nearby.size).toBe(0);
    expect(cache.self.health?.value).toEqual({ current: 80, max: 100 });
    expect(cache.self.power?.value).toEqual({ current: 40, max: 90 });
    expect(cache.self.position?.value).toEqual({
      // map is carried from SMSG_LOGIN_VERIFY_WORLD; x/y/z/o are the block's.
      map: 0,
      x: -1234.5,
      y: 987.25,
      z: 42.125,
      o: 3.5,
    });
    expect(cache.self.position?.seq).toBe(17);
    expect(cache.anomalies).toHaveLength(0);
  });

  test("a self block whose guid contradicts the seed is an anomaly, not an overwrite", () => {
    const impostor = {
      ...selfCreate,
      data: {
        blocks: 1,
        objects: [{ ...(selfCreate.data.objects[0] as object), guid: "999", self: true }],
      },
    };
    const cache = StateCache.replay(toEvents([...loginSequence, impostor]), { seed: SEED });
    expect(cache.self.guid).toBe("7");
    expect(cache.self.health).toBeUndefined();
    expect(cache.anomalies).toHaveLength(1);
    expect(cache.anomalies[0]?.kind).toBe("self_guid_mismatch");
    // The block is not discarded: something is in view at that guid.
    expect(cache.nearby.get("999")).toBeDefined();
  });

  test("with no seed, the self flag is what tells us who we are", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate]));
    expect(cache.self.guid).toBe("7");
    expect(cache.self.health?.value).toEqual({ current: 80, max: 100 });
  });

  test("own position tracks WB_MOVE_PROGRESS and the confirmed WB_MOVE_RESULT", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, selfCreate, moveProgress, moveResult("arrived")]),
      { seed: SEED },
    );
    expect(cache.self.position?.value).toEqual({ map: 0, x: -1205, y: 981, z: 42, o: 1.2 });
    expect(cache.self.position?.seq).toBe(19);
  });

  test("own position with no map ever observed is refused, not defaulted", () => {
    const cache = StateCache.replay(toEvents([moveProgress]), { seed: SEED });
    expect(cache.self.position).toBeUndefined();
    expect(cache.anomalies[0]?.kind).toBe("self_position_without_map");
  });
});

describe("state cache: world queries", () => {
  const events = toEvents([
    ...loginSequence,
    selfCreate,
    creatureCreate,
    creatureQuery,
    playerCreate,
    playerName,
  ]);

  test("nearbyUnits are the objects a create block typed as unit or player", () => {
    const cache = StateCache.replay(events, { seed: SEED });
    expect(cache.nearbyUnits().map((o) => o.name?.value).sort()).toEqual(["Quilby", "Thistlebore"]);
  });

  test("creaturesByEntry selects on the observed template id", () => {
    const cache = StateCache.replay(events, { seed: SEED });
    expect(cache.creaturesByEntry(CREATURE_ENTRY).map((o) => o.guid)).toEqual([CREATURE_GUID]);
    expect(cache.creaturesByEntry(1)).toHaveLength(0);
  });

  test("closest measures from our own last observed position", () => {
    const cache = StateCache.replay(events, { seed: SEED });
    // self is at x=-1234.5: the creature at -1200 is ~35y away, the player at
    // -1240 is ~6y away.
    expect(cache.closest()?.name?.value).toBe("Quilby");
    expect(cache.closest((o) => o.objectType?.value === "unit")?.name?.value).toBe("Thistlebore");
  });

  test("closest claims nothing when we have no position of our own", () => {
    const cache = StateCache.replay(toEvents([creatureCreate]), {});
    expect(cache.closest()).toBeUndefined();
  });
});

describe("state cache: replay", () => {
  test("replay from seq 0 equals the incrementally fed cache", () => {
    const events = toEvents(fullStream);
    const incremental = new StateCache({ seed: SEED });
    for (const e of events) incremental.apply(e);
    const replayed = StateCache.replay(events, { seed: SEED });
    expect(replayed.snapshot()).toEqual(incremental.snapshot());
  });

  test("replay equals live for the observed world too, snapshots included", () => {
    const events = toEvents([...worldStream, creatureMove, playerCreate, playerName, moveProgress]);
    const incremental = new StateCache({ seed: SEED });
    for (const e of events) incremental.apply(e);
    const replayed = StateCache.replay(events, { seed: SEED });
    expect(replayed.snapshot()).toEqual(incremental.snapshot());
  });

  test("a snapshot does not share the field maps it copied", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, creatureCreate]), { seed: SEED });
    const snap = cache.snapshot();
    for (const e of toEvents([creatureValues])) cache.apply(e);
    expect(snap.nearby.get(CREATURE_GUID)?.fields.get("health")?.value).toBe(120);
    expect(cache.nearby.get(CREATURE_GUID)?.fields.get("health")?.value).toBe(60);
  });

  test("the seed is the only non-event input, and it is recorded", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: SEED });
    expect(cache.seed).toEqual({ guid: "7", name: "Fenwick" });
  });

  test("seedSelf after the fact backfills self from an already-seen char enum", () => {
    const cache = StateCache.replay(toEvents(loginSequence));
    expect(cache.self.level).toBeUndefined();
    cache.seedSelf({ guid: "7", name: "Fenwick" });
    expect(cache.self.level?.value).toBe(3);
  });

  test("the chat tail is bounded", () => {
    const cache = new StateCache({ chatTail: 3, seed: SEED });
    for (let i = 0; i < 10; i++) {
      const [event] = toEvents([{ ...chatEcho, seq: i, data: { ...chatEcho.data, message: `line ${i}` } }]);
      cache.apply(event as StreamEvent);
    }
    expect(cache.chat.map((c) => c.message)).toEqual(["line 7", "line 8", "line 9"]);
  });

  test("a stream gap is recorded so the cache admits it is incomplete", () => {
    const cache = new StateCache({ seed: SEED });
    for (const e of toEvents(loginSequence)) cache.apply(e);
    const gap: StreamGapEvent = {
      seq: 20,
      opcode: STREAM_GAP,
      opcodeId: -1,
      ts: 1_700_000_000_500,
      synthetic: true,
      data: { fromSeq: 4, toSeq: 19, missing: 16 },
    };
    cache.apply(gap);
    for (const e of toEvents([{ ...notification, seq: 20 }])) cache.apply(e);
    expect(cache.gaps).toEqual([
      { fromSeq: 4, toSeq: 19, missing: 16, ts: 1_700_000_000_500 },
    ]);
    expect(cache.lastSeq).toBe(20);
  });
});

describe("state cache: the quest log, folded out of the raw update fields", () => {
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("an occupied slot becomes an entry; an empty one does not", () => {
    const cache = withWorld([questAccepted]);
    expect(cache.questLog).toHaveLength(1);
    const [quest] = cache.questLog;
    expect(quest?.slot).toBe(0);
    expect(quest?.questId).toBe(QUEST_ID);
    expect(quest?.complete).toBe(false);
    expect(quest?.counts).toEqual([0, 0, 0, 0]);
    // `quest1Id: 0` was served and must not turn into a quest with id 0.
    expect(cache.questLog.some((q) => q.questId === 0)).toBe(false);
  });

  test("the two u32 halves split into four u16 objective counters", () => {
    const cache = withWorld([questAccepted, questProgress]);
    expect(cache.quest(QUEST_ID)?.counts).toEqual([3, 5, 7, 9]);
  });

  test("completion is the state bit, not a count comparison", () => {
    const before = withWorld([questAccepted, questProgress]);
    expect(before.quest(QUEST_ID)?.complete).toBe(false);
    // The counts do not move; only the state field does. This is the whole
    // point: the core sends no QUESTUPDATE_COMPLETE for a kill objective.
    const after = withWorld([questAccepted, questProgress, questComplete]);
    expect(after.quest(QUEST_ID)?.state).toBe(1);
    expect(after.quest(QUEST_ID)?.complete).toBe(true);
    expect(after.quest(QUEST_ID)?.counts).toEqual([3, 5, 7, 9]);
  });

  test("a chain's auto-added quest shows up as a second slot", () => {
    const cache = withWorld([questAccepted, questChained]);
    expect(cache.questLog.map((q) => q.questId)).toEqual([QUEST_ID, OTHER_QUEST_ID]);
    expect(cache.quest(OTHER_QUEST_ID)?.slot).toBe(1);
    expect(cache.quest(12345)).toBeUndefined();
  });

  test("a quest entry carries the seq of the field that last moved it", () => {
    const cache = withWorld([questAccepted, questProgress]);
    expect(cache.quest(QUEST_ID)?.seq).toBe(31);
  });

  test("kill credit is an event, and does not itself write the log", () => {
    const cache = withWorld([questAccepted, addKill]);
    // ADD_KILL is observable, but the log is what the cache reports; nothing
    // here invents progress from the packet's `current`.
    expect(cache.quest(QUEST_ID)?.counts).toEqual([0, 0, 0, 0]);
  });

  test("a turn-in is counted and listed with the reward the server named", () => {
    const cache = withWorld([questAccepted, questRewarded(QUEST_ID)]);
    expect(cache.questsCompleted).toBe(1);
    expect(cache.questCompletions).toEqual([
      { questId: QUEST_ID, xp: 400, money: 250, seq: 49, ts: 1_700_000_000_490 },
    ]);
  });

  test("nothing is counted before a turn-in is observed", () => {
    expect(withWorld([questAccepted]).questsCompleted).toBe(0);
    expect(withWorld([questAccepted]).questCompletions).toEqual([]);
  });

  test("two turn-ins of the same quest are two completions, not one", () => {
    // Repeatables exist; deduping by quest id would silently undercount them.
    const cache = withWorld([
      questRewarded(QUEST_ID, 60),
      questRewarded(OTHER_QUEST_ID, 61),
      questRewarded(QUEST_ID, 62),
    ]);
    expect(cache.questsCompleted).toBe(3);
    expect(cache.questCompletions.map((q) => q.questId)).toEqual([
      QUEST_ID,
      OTHER_QUEST_ID,
      QUEST_ID,
    ]);
  });

  test("the completion list reaches the snapshot and is decoupled from it", () => {
    const cache = StateCache.replay(toEvents([...worldStream, questRewarded(QUEST_ID)]), {
      seed: SEED,
    });
    const snap = cache.snapshot();
    expect(snap.questCompletions.map((q) => q.questId)).toEqual([QUEST_ID]);
    for (const e of toEvents([questRewarded(OTHER_QUEST_ID, 63)])) cache.apply(e);
    expect(snap.questCompletions).toHaveLength(1);
    expect(cache.questsCompleted).toBe(2);
  });
});

describe("state cache: self progress, target and inventory", () => {
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("money and the XP bar are exposed, with provenance", () => {
    const cache = withWorld([selfProgress]);
    expect(cache.money?.value).toBe(12345);
    expect(cache.xp?.value).toBe(480);
    expect(cache.nextLevelXp?.value).toBe(2100);
    expect(cache.money?.seq).toBe(34);
    expect(cache.self.level?.value).toBe(4);
  });

  test("nothing invents them before an event carried them", () => {
    const cache = withWorld([]);
    expect(cache.money).toBeUndefined();
    expect(cache.xp).toBeUndefined();
    expect(cache.nextLevelXp).toBeUndefined();
  });

  test("our own targetGuid resolves to the object in view", () => {
    const cache = withWorld([selfTarget]);
    expect(cache.self.targetGuid?.value).toBe(CREATURE_GUID);
    expect(cache.target?.guid).toBe(CREATURE_GUID);
    expect(cache.target?.name?.value).toBe("Thistlebore");
  });

  test("a target that has left view is a target we cannot see", () => {
    const cache = withWorld([selfTarget, creatureOutOfRange]);
    expect(cache.self.targetGuid?.value).toBe(CREATURE_GUID);
    expect(cache.target).toBeUndefined();
  });

  test("inventory reassembles the guid halves and joins the item's name", () => {
    const cache = withWorld([inventorySlot, itemCreate, itemQuery]);
    expect(cache.inventory).toHaveLength(1);
    const [item] = cache.inventory;
    expect(item?.slot).toBe(BACKPACK_SLOT);
    // The high half is above 2^32: a truncating join would lose it entirely.
    expect(item?.guid).toBe(ITEM_GUID);
    expect(item?.itemId).toBe(ITEM_ENTRY);
    expect(item?.name).toBe("Gritstone Charm");
    expect(item?.stackCount).toBe(5);
    expect(cache.items.get(ITEM_ENTRY)?.value.sellPrice).toBe(40);
  });

  test("an occupied slot whose item has not been created is still occupied", () => {
    const cache = withWorld([inventorySlot]);
    expect(cache.inventory).toHaveLength(1);
    expect(cache.inventory[0]?.guid).toBe(ITEM_GUID);
    expect(cache.inventory[0]?.itemId).toBeUndefined();
    expect(cache.inventory[0]?.name).toBeUndefined();
  });

  test("a map change evicts old-map objects but keeps own items", () => {
    const cache = withWorld([inventorySlot, itemCreate, itemQuery]);
    expect(cache.nearby.get(CREATURE_GUID)).toBeDefined();
    const verify = (seq: number, map: number) =>
      toEvents([
        {
          seq,
          opcode: "SMSG_LOGIN_VERIFY_WORLD",
          opcodeId: 0x236,
          ts: 1_700_000_000_900,
          data: { map, x: 10, y: 20, z: 30, o: 0 },
        },
      ])[0]!;
    // Same map: a re-verify is not a teleport, nothing is evicted.
    cache.apply(verify(90, 0));
    expect(cache.nearby.get(CREATURE_GUID)).toBeDefined();
    // New map: the old visibility set is gone — but items travel with us,
    // so the inventory join keeps working.
    cache.apply(verify(91, 1));
    expect(cache.nearby.get(CREATURE_GUID)).toBeUndefined();
    expect(cache.nearby.get(ITEM_GUID)).toBeDefined();
    expect(cache.inventory).toHaveLength(1);
    expect(cache.inventory[0]?.name).toBe("Gritstone Charm");
  });

  test("bag() shapes the backpack for the item actions", () => {
    const cache = withWorld([inventorySlot, itemCreate, itemQuery]);
    const bag = cache.bag();
    expect(bag.items).toEqual([
      {
        bag: 255,
        slot: BACKPACK_SLOT,
        guid: ITEM_GUID,
        itemId: ITEM_ENTRY,
        name: "Gritstone Charm",
        count: 5,
      },
    ]);
    expect(bag.freeSlots).toBe(15);
  });

  test("bag() reports an unjoined slot as occupied, and equipment stays out", () => {
    // The slot's guid halves arrived but the item's create block has not:
    // occupied is the observation, itemId/name honestly undefined.
    const cache = withWorld([inventorySlot]);
    const bag = cache.bag();
    expect(bag.items).toHaveLength(1);
    expect(bag.items[0]?.itemId).toBeUndefined();
    expect(bag.freeSlots).toBe(15);
    // No inventory fields at all: nothing occupied has been observed.
    expect(withWorld([]).bag()).toEqual({ items: [], freeSlots: 16 });
  });

  test("a zeroed slot is empty, not an item with guid 0", () => {
    const cache = withWorld([inventorySlot]);
    // `invSlot24Lo/Hi` were served as 0/0 in the same block.
    expect(cache.inventory.map((i) => i.slot)).toEqual([BACKPACK_SLOT]);
  });
});

describe("state cache: auras and creature movement", () => {
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("aura slots accumulate and carry their durations", () => {
    const cache = withWorld([auraUpdate]);
    const auras = cache.aurasOf(CREATURE_GUID);
    expect(auras.map((a) => a.spellId)).toEqual([7777, 8888]);
    expect(auras[0]?.duration).toBe(12000);
    expect(auras[1]?.stacks).toBe(3);
  });

  test("a cleared slot is dropped, and the others survive", () => {
    const cache = withWorld([auraUpdate, auraRemoved]);
    expect(cache.aurasOf(CREATURE_GUID).map((a) => a.slot)).toEqual([1]);
  });

  test("UPDATE_ALL replaces the list rather than merging into it", () => {
    const cache = withWorld([auraUpdate, auraUpdateAll]);
    expect(cache.aurasOf(CREATURE_GUID).map((a) => a.spellId)).toEqual([9999]);
  });

  test("auras leave with the unit they were on", () => {
    const cache = withWorld([auraUpdate, creatureDestroy]);
    expect(cache.aurasOf(CREATURE_GUID)).toEqual([]);
  });

  test("monster move is served as destination and duration, and nothing else", () => {
    const cache = withWorld([monsterMove]);
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.motion?.value.durationMs).toBe(2000);
    expect(obj?.motion?.value.destination).toEqual({ x: -1190.0, y: 970.0, z: 42.0 });
    // Where to walk to reach it: the destination while it is in motion.
    expect(pointOf(obj!)?.value).toEqual({ x: -1190.0, y: 970.0, z: 42.0 });
  });

  test("a stopped creature is where it stopped", () => {
    const cache = withWorld([monsterMove, monsterStopped]);
    expect(pointOf(cache.nearby.get(CREATURE_GUID)!)?.value).toEqual({ x: -1195.0, y: 972.0, z: 42.0 });
  });

  test("an oriented position newer than the spline still wins", () => {
    const cache = withWorld([monsterMove, { ...creatureMove, seq: 60 }]);
    expect(pointOf(cache.nearby.get(CREATURE_GUID)!)?.value).toEqual({ x: -1210.0, y: 985.0, z: 42.0 });
  });
});

describe("state cache: the quest/combat fold replays", () => {
  test("replaying the stream equals feeding it live", () => {
    const events = toEvents(questCombatStream);
    const replayed = StateCache.replay(events, { seed: SEED });
    const live = new StateCache({ seed: SEED });
    for (const e of events) live.apply(e);
    expect(JSON.stringify(live.snapshot(), jsonSafe)).toEqual(
      JSON.stringify(replayed.snapshot(), jsonSafe),
    );
  });

  test("the snapshot carries the derived views and is decoupled from the cache", () => {
    const events = toEvents(questCombatStream);
    const cache = StateCache.replay(events, { seed: SEED });
    const snap = cache.snapshot();
    expect(snap.questLog.map((q) => q.questId)).toEqual([QUEST_ID, OTHER_QUEST_ID]);
    expect(snap.inventory[0]?.name).toBe("Gritstone Charm");
    expect(snap.money?.value).toBe(12345);
    expect(snap.auras.get(CREATURE_GUID)?.map((a) => a.spellId)).toEqual([8888]);

    // Later events must not reach a snapshot already taken.
    for (const e of toEvents([questChained, creatureDestroy])) cache.apply(e);
    expect(snap.auras.get(CREATURE_GUID)?.map((a) => a.spellId)).toEqual([8888]);
    expect(snap.questLog).toHaveLength(2);
  });
});

/** bigints do not survive JSON; render them for the structural comparison. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) return [...value.entries()];
  return value;
}

describe("WB_SESSION_STATE (reattach)", () => {
  const frame = (guid: string, seq = 1) => ({
      seq,
      opcode: "WB_SESSION_STATE",
      opcodeId: 0xff03,
      ts: 1000,
      data: {
        character: "Fenwick",
        guid,
        inWorld: true,
        map: 0,
        x: -8949.9,
        y: -132.4,
        z: 83.5,
        o: 1.5,
        level: 3,
      },
    });

  test("populates self on an unseeded cache (resume into live session)", () => {
    const cache = StateCache.replay(toEvents([frame("7")]));
    expect(cache.seed?.guid).toBe("7");
    expect(cache.self.position?.value.map).toBe(0);
    expect(cache.self.position?.value.x).toBeCloseTo(-8949.9);
    expect(cache.self.level?.value).toBe(3);
  });

  test("matches a seeded cache and updates position/level", () => {
    const cache = StateCache.replay(toEvents([frame("7")]), { seed: SEED });
    expect(cache.self.level?.value).toBe(3);
    expect(cache.anomalies.length).toBe(0);
  });

  test("contradicting guid records an anomaly, never overwrites", () => {
    const cache = StateCache.replay(toEvents([frame("999")]), { seed: SEED });
    expect(cache.self.level?.value).toBeUndefined();
    expect(cache.anomalies.length).toBe(1);
    expect(cache.anomalies[0]!.kind).toBe("session_state_guid_mismatch");
  });
});

describe("ADR-0017: guids are opaque decimal strings at the model surface", () => {
  test("nearbyUnits guids and targetGuid are plain strings", () => {
    const cache = StateCache.replay(toEvents(worldStream), { seed: SEED });
    const units = cache.nearbyUnits();
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      expect(typeof u.guid).toBe("string");
      expect(u.guid).toMatch(/^\d+$/);
      if (u.targetGuid !== undefined) expect(typeof u.targetGuid.value).toBe("string");
    }
    expect(units.map((u) => u.guid)).toContain(CREATURE_GUID);
  });

  test("JSON.stringify works on a nearby unit and on the whole snapshot self", () => {
    const cache = StateCache.replay(toEvents(worldStream), { seed: SEED });
    const unit = cache.nearby.get(CREATURE_GUID);
    expect(unit).toBeDefined();
    // The single most frequent model-facing error of the first measured night
    // (JSON.stringify cannot serialize BigInt) must be impossible from state.
    expect(() => JSON.stringify(unit)).not.toThrow();
    expect(JSON.stringify({ guid: unit!.guid })).toContain(`"${CREATURE_GUID}"`);
    const snap = cache.snapshot();
    expect(() => JSON.stringify(snap.self)).not.toThrow();
    expect(() => JSON.stringify(snap.inventory)).not.toThrow();
    expect(() => JSON.stringify(snap.questLog)).not.toThrow();
  });

  test("guid strings compare with === and key Maps directly", () => {
    const cache = StateCache.replay(toEvents(worldStream), { seed: SEED });
    const unit = cache.nearbyUnits().find((u) => u.guid === CREATURE_GUID);
    expect(unit).toBeDefined();
    const byGuid = new Map(cache.nearbyUnits().map((u) => [u.guid, u]));
    expect(byGuid.get(CREATURE_GUID)).toBe(unit!);
  });
});

// ---------------------------------------------------------------- state.units
//
// The scan helper (ADR-0015, earned by roster-opus-low-20260822 turn 15, where
// `u.fields.entry?.value` on the raw Map made a populated world look empty).
// Fixtures here are local because they exist to make one query answer
// interesting: several objects at known distances, in known conditions.

const FAR_GUID = "1001";
const DEAD_GUID = "1002";
const OBJECT_GUID = "1003";
const GHOST_GUID = "1004";
const VENDOR_GUID = "1005";
const FAR_ENTRY = 4242;
const VENDOR_ENTRY = 4243;

/** A create block at a chosen offset from our own login position. */
function unitAt(
  guid: string,
  seq: number,
  opts: {
    objectType?: string;
    dx?: number;
    entry?: number;
    health?: number;
    maxHealth?: number;
    level?: number;
    npcFlags?: number;
    pos?: boolean;
  } = {},
): unknown {
  const fields: Record<string, number> = {};
  if (opts.entry !== undefined) fields["entry"] = opts.entry;
  if (opts.health !== undefined) fields["health"] = opts.health;
  if (opts.maxHealth !== undefined) fields["maxHealth"] = opts.maxHealth;
  if (opts.level !== undefined) fields["level"] = opts.level;
  if (opts.npcFlags !== undefined) fields["npcFlags"] = opts.npcFlags;
  return {
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: 1_700_000_000_000 + seq,
    data: {
      blocks: 1,
      objects: [
        {
          update: "create",
          guid,
          objectType: opts.objectType ?? "unit",
          ...(opts.pos === false
            ? {}
            : { pos: { x: -1234.5 + (opts.dx ?? 0), y: 987.25, z: 42.125, o: 0 } }),
          fields,
        },
      ],
    },
  };
}

/** A creature query answer for one invented entry. */
function namedEntry(entry: number, name: string, seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_CREATURE_QUERY_RESPONSE",
    opcodeId: 0x061,
    ts: 1_700_000_000_000 + seq,
    data: { entry, found: true, name, subname: "", type: 1, rank: 0 },
  };
}

/** worldStream (self + Thistlebore at ~35y) plus a populated neighbourhood. */
const scanStream: unknown[] = [
  ...worldStream,
  unitAt(FAR_GUID, 30, { dx: 100, entry: FAR_ENTRY, health: 50, maxHealth: 50, level: 9 }),
  namedEntry(FAR_ENTRY, "Ridgeback Boar", 31),
  unitAt(DEAD_GUID, 32, { dx: 5, entry: FAR_ENTRY, health: 0, maxHealth: 50 }),
  unitAt(OBJECT_GUID, 33, { dx: 10, objectType: "gameObject", entry: 7777 }),
  unitAt(GHOST_GUID, 34, { dx: 0, entry: FAR_ENTRY, pos: false }),
  unitAt(VENDOR_GUID, 35, { dx: 2, entry: VENDOR_ENTRY, health: 900, maxHealth: 900, npcFlags: 129 }),
];

describe("state.units(): the flat scan helper", () => {
  const cache = () => StateCache.replay(toEvents(scanStream), { seed: SEED });

  test("returns flat plain objects: no Observed wrappers, no Maps, JSON round-trips", () => {
    const rows = cache().units();
    expect(rows.length).toBeGreaterThan(3);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('"value"');
    expect(json).not.toContain('"seq"');
    expect(json).not.toContain('"fields"');
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(rows)));
    const one = rows.find((r) => r.guid === CREATURE_GUID)!;
    expect(one.entry).toBe(CREATURE_ENTRY);
    expect(one.name).toBe("Thistlebore");
    expect(one.type).toBe("unit");
    expect(one.level).toBe(4);
    expect(one.health).toBe(60);
    expect(one.maxHealth).toBe(120);
    expect(one.dead).toBe(false);
    expect(typeof one.distance).toBe("number");
    expect(typeof one.x).toBe("number");
  });

  test("never invents: unobserved fields stay undefined", () => {
    const ghost = cache().units().find((r) => r.guid === GHOST_GUID)!;
    expect(ghost.health).toBeUndefined();
    expect(ghost.maxHealth).toBeUndefined();
    expect(ghost.dead).toBeUndefined();
    expect(ghost.level).toBeUndefined();
    expect(ghost.distance).toBeUndefined();
    expect(ghost.x).toBeUndefined();
  });

  test("sorted by distance ascending, unknown distances last", () => {
    const rows = cache().units();
    const known = rows.filter((r) => r.distance !== undefined).map((r) => r.distance!);
    expect(known).toEqual([...known].sort((a, b) => a - b));
    expect(rows.at(-1)!.guid).toBe(GHOST_GUID);
    expect(rows[0]!.guid).toBe(VENDOR_GUID);
  });

  test("no self position means no distances, and the objects still list in first-sight order", () => {
    // Every row unknown: the comparator must still be a total order, or replay
    // would not sort the same way twice.
    const rows = StateCache.replay(
      toEvents([
        creatureCreate,
        creatureQuery,
        unitAt(FAR_GUID, 30, { dx: 100, entry: FAR_ENTRY }),
        unitAt(DEAD_GUID, 32, { dx: 5, entry: FAR_ENTRY }),
      ]),
      {},
    ).units();
    expect(rows.map((r) => r.guid)).toEqual([CREATURE_GUID, FAR_GUID, DEAD_GUID]);
    expect(rows.every((r) => r.distance === undefined)).toBe(true);
    expect(rows[0]!.name).toBe("Thistlebore");
  });

  test("items and containers are excluded; untyped objects are not", () => {
    const withItem = StateCache.replay(toEvents([...worldStream, itemCreate, itemQuery]), { seed: SEED });
    expect(withItem.units().map((r) => r.guid)).not.toContain(ITEM_GUID);
    const untyped = StateCache.replay(
      toEvents([
        ...worldStream,
        {
          seq: 40,
          opcode: "SMSG_UPDATE_OBJECT",
          opcodeId: 0x0a9,
          ts: 1_700_000_000_400,
          data: { blocks: 1, objects: [{ update: "values", guid: "2002", fields: { health: 5 } }] },
        },
      ]),
      { seed: SEED },
    );
    const row = untyped.units().find((r) => r.guid === "2002")!;
    expect(row).toBeDefined();
    expect(row.type).toBeUndefined();
  });

  test("entry filter takes one id or a list, and a numeric string is repaired", () => {
    const c = cache();
    expect(c.units({ entry: CREATURE_ENTRY }).map((r) => r.guid)).toEqual([CREATURE_GUID]);
    expect(c.units({ entry: [CREATURE_ENTRY, VENDOR_ENTRY] }).map((r) => r.guid)).toEqual([
      VENDOR_GUID,
      CREATURE_GUID,
    ]);
    // ADR-0016 deterministic repair: "90210" has exactly one valid reading.
    expect(c.units({ entry: String(CREATURE_ENTRY) as unknown as number })).toEqual(
      c.units({ entry: CREATURE_ENTRY }),
    );
    expect(c.units({ entry: [String(FAR_ENTRY) as unknown as number] }).length).toBe(3);
  });

  test("name is a case-insensitive substring; unnamed objects never match", () => {
    const c = cache();
    expect(c.units({ name: "thistle" }).map((r) => r.guid)).toEqual([CREATURE_GUID]);
    expect(c.units({ name: "BOAR" }).every((r) => r.name === "Ridgeback Boar")).toBe(true);
    expect(c.units({ name: "boar" }).map((r) => r.guid)).not.toContain(OBJECT_GUID);
    expect(c.units({ name: "nothing here" })).toEqual([]);
  });

  test("type filters on the observed create-block type", () => {
    const c = cache();
    expect(c.units({ type: "gameObject" }).map((r) => r.guid)).toEqual([OBJECT_GUID]);
    expect(c.units({ type: "player" })).toEqual([]);
    expect(c.units({ type: "unit" }).map((r) => r.guid)).not.toContain(OBJECT_GUID);
  });

  test("alive: true drops only the known dead; alive: false needs the observation", () => {
    const c = cache();
    const alive = c.units({ alive: true }).map((r) => r.guid);
    expect(alive).not.toContain(DEAD_GUID);
    // Health never observed is not evidence of death — the footgun this exists to kill.
    expect(alive).toContain(GHOST_GUID);
    expect(c.units({ alive: false }).map((r) => r.guid)).toEqual([DEAD_GUID]);
  });

  test("maxDistance is in yards and drops what has no known distance", () => {
    const c = cache();
    const near = c.units({ maxDistance: 20 });
    expect(near.map((r) => r.guid)).not.toContain(FAR_GUID);
    expect(near.map((r) => r.guid)).not.toContain(GHOST_GUID);
    expect(near.every((r) => r.distance! <= 20)).toBe(true);
    expect(c.units({ maxDistance: 500 }).length).toBe(c.units().length - 1);
    expect(c.units({ maxDistance: "20" as unknown as number })).toEqual(near);
  });

  test("npc: npcFlags > 0, and unobserved flags are not an npc", () => {
    const c = cache();
    expect(c.units({ npc: true }).map((r) => r.guid)).toEqual([VENDOR_GUID]);
    expect(c.units({ npc: false }).map((r) => r.guid)).not.toContain(VENDOR_GUID);
  });

  test("criteria are AND-ed", () => {
    const c = cache();
    expect(c.units({ entry: FAR_ENTRY, alive: true, maxDistance: 50 }).map((r) => r.guid)).toEqual([]);
    expect(c.units({ entry: FAR_ENTRY, alive: false }).map((r) => r.guid)).toEqual([DEAD_GUID]);
    expect(c.units({ type: "unit", name: "boar", alive: true, maxDistance: 200 }).map((r) => r.guid)).toEqual([
      FAR_GUID,
    ]);
  });

  test("targetGuid is flat, and no-target reads as undefined", () => {
    const c = StateCache.replay(toEvents([...worldStream, selfTarget]), { seed: SEED });
    const row = c.units().find((r) => r.guid === CREATURE_GUID)!;
    expect(row.targetGuid).toBeUndefined();
    const targeting = StateCache.replay(
      toEvents([
        ...worldStream,
        {
          seq: 41,
          opcode: "SMSG_UPDATE_OBJECT",
          opcodeId: 0x0a9,
          ts: 1_700_000_000_410,
          data: {
            blocks: 1,
            objects: [{ update: "values", guid: CREATURE_GUID, fields: { targetGuid: "7" } }],
          },
        },
      ]),
      { seed: SEED },
    );
    expect(targeting.units().find((r) => r.guid === CREATURE_GUID)!.targetGuid).toBe("7");
  });

  test("bad filter values are rejected with an actionable TypeError (ADR-0016)", () => {
    const c = cache();
    expect(() => c.units({ entry: "boar" as unknown as number })).toThrow(TypeError);
    expect(() => c.units({ entry: "boar" as unknown as number })).toThrow(/received "boar" \(string\)/);
    expect(() => c.units({ entry: 69.5 })).toThrow(/whole template id/);
    // An enum near-miss has two readings, so it is rejected rather than picked.
    expect(() => c.units({ type: "gameobject" as "gameObject" })).toThrow(/expected one of/);
    expect(() => c.units({ alive: "true" as unknown as boolean })).toThrow(/expected true or false/);
    expect(() => c.units({ minLevel: 5 } as unknown as UnitFilter)).toThrow(/unknown key "minLevel"/);
    expect(() => c.units({ minLevel: 5 } as unknown as UnitFilter)).toThrow(/Valid keys are entry, name/);
    expect(() => c.units(((u: unknown) => u) as unknown as UnitFilter)).toThrow(
      /criteria object, not a predicate/,
    );
    expect(() => c.units({ maxDistance: -1 })).toThrow(/expected a distance >= 0/);
  });
});
