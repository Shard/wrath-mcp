import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { STREAM_GAP, type StreamEvent, type StreamGapEvent } from "../src/events";
import { gameObjectTypeName, pointOf, reputationRank, StateCache, type UnitFilter } from "../src/state";
import {
  addKill,
  auraRemoved,
  auraUpdate,
  auraUpdateAll,
  BACKPACK_SLOT,
  BAG_SLOT,
  BAG_GUID,
  BAG_NUM_SLOTS,
  BAGGED_GUID,
  wornBagSlot,
  wornBagCreate,
  wornBagQuery,
  chatEcho,
  inventorySlot,
  ITEM_ENTRY,
  ITEM_GUID,
  ITEM_GUID_HI,
  ITEM_GUID_LO,
  BAG_GUID_HI,
  BAG_GUID_LO,
  nameQuery,
  itemCreate,
  itemQuery,
  monsterMove,
  monsterStopped,
  newWorld,
  OTHER_QUEST_ID,
  QUEST_ID,
  questAccepted,
  questChained,
  questCombatStream,
  questComplete,
  questProgress,
  transferAborted,
  teleportAck,
  transferPending,
  questRewarded,
  questGiverStatus,
  questGiverStatusMultiple,
  questQueryResponse,
  KOBOLD_ENTRY,
  GO_ENTRY,
  REQUIRED_ITEM,
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
  corpseQuery,
  corpseReclaimDelay,
  deathReleaseCleared,
  deathReleaseLoc,
  fullStream,
  loginSequence,
  moveProgress,
  moveResult,
  notification,
  PLAYER_GUID,
  playerCreate,
  playerName,
  SELF_GUID,
  selfCreate,
  selfHealth,
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

  test("SMSG_NEW_WORLD moves self to the new map and evicts the old map's objects", () => {
    // SMSG_LOGIN_VERIFY_WORLD is login-only, so before this
    // a tram ride left self.position.map at the login map forever and the
    // Ironforge crowd lingered in `nearby` on map 369.
    const cache = StateCache.replay(
      toEvents([...loginSequence, selfCreate, creatureCreate, transferPending(369), newWorld(369)]),
      { seed: SEED },
    );
    expect(cache.self.position?.value).toEqual({ map: 369, x: 69.25, y: 10.26, z: -4.3, o: 3.1 });
    expect(cache.self.position?.seq).toBe(41);
    expect(cache.self.transfer).toBeUndefined();
    expect(cache.nearbyUnits()).toEqual([]);
    // Later own positions pair with the new map.
    cache.apply(toEvents([moveProgress])[0]!);
    expect(cache.self.position?.value.map).toBe(369);
  });

  test("a `transferred` move result never writes old-map coordinates under the new map id", () => {
    // The module reads the character back before the teleport lands, so
    // WB_MOVE_RESULT.pos on `transferred` is "the last old-map position"
    // (PROTOCOL.md). Folding it would pair those x/y/z with the new map id —
    // a WorldPosition the character was never at. SMSG_NEW_WORLD owns the
    // arrival point, and it can land on either side of the result.
    const resultFirst = StateCache.replay(
      toEvents([...loginSequence, selfCreate, transferPending(369, 40), moveResult("transferred", 1, 41)]),
      { seed: SEED },
    );
    // Nothing adopted: still the old map, at the position login gave.
    expect(resultFirst.self.position?.value.map).toBe(0);
    expect(resultFirst.self.position?.value.x).not.toBe(-1205);
    resultFirst.apply(toEvents([newWorld(369, 42)])[0]!);
    expect(resultFirst.self.position?.value).toEqual({ map: 369, x: 69.25, y: 10.26, z: -4.3, o: 3.1 });

    const newWorldFirst = StateCache.replay(
      toEvents([
        ...loginSequence,
        selfCreate,
        transferPending(369, 40),
        newWorld(369, 41),
        moveResult("transferred", 1, 42),
      ]),
      { seed: SEED },
    );
    expect(newWorldFirst.self.position?.value).toEqual({ map: 369, x: 69.25, y: 10.26, z: -4.3, o: 3.1 });
    expect(newWorldFirst.self.position?.seq).toBe(41);
    // Every other move result still writes self position, transfer or not.
    newWorldFirst.apply(toEvents([moveResult("arrived", 2, 43)])[0]!);
    expect(newWorldFirst.self.position?.value).toEqual({ map: 369, x: -1205, y: 981, z: 42, o: 1.2 });
  });

  test("an own-guid MSG_MOVE_TELEPORT_ACK moves self, and the `teleported` result after it does not", () => {
    // a same-map port sends no SMSG_NEW_WORLD; the server's
    // teleport ack under our guid is the arrival point. The `teleported` move
    // result that follows carries the pre-teleport position and must not win.
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate, teleportAck(40)]), { seed: SEED });
    expect(cache.self.position?.value).toEqual({ map: 0, x: -8833.4, y: 625.9, z: 93.9, o: 0.5 });
    expect(cache.self.position?.seq).toBe(40);
    expect(cache.nearby.has(SELF_GUID)).toBe(false); // never upserted as a nearby unit
    cache.apply(toEvents([moveResult("teleported", 1, 41)])[0]!);
    expect(cache.self.position?.value).toEqual({ map: 0, x: -8833.4, y: 625.9, z: 93.9, o: 0.5 });
    // Every later own position still folds.
    cache.apply(toEvents([moveResult("arrived", 2, 42)])[0]!);
    expect(cache.self.position?.value.x).toBe(-1205);
  });

  test("a pending transfer is visible until NEW_WORLD completes or ABORTED cancels it", () => {
    const pending = StateCache.replay(toEvents([...loginSequence, transferPending(369)]), { seed: SEED });
    expect(pending.self.transfer?.value).toEqual({ toMap: 369 });
    expect(pending.self.position?.value.map).toBe(0);

    const aborted = StateCache.replay(
      toEvents([...loginSequence, transferPending(369), transferAborted(369, 1)]),
      { seed: SEED },
    );
    expect(aborted.self.transfer).toBeUndefined();
    expect(aborted.self.position?.value.map).toBe(0);
  });

  test("own position with no map ever observed is refused, not defaulted", () => {
    const cache = StateCache.replay(toEvents([moveProgress]), { seed: SEED });
    expect(cache.self.position).toBeUndefined();
    expect(cache.anomalies[0]?.kind).toBe("self_position_without_map");
  });
});

describe("state cache: a ghost knows where its corpse is", () => {
  const GRAVE = { map: 0, x: -1500, y: 900, z: 50 };
  const CORPSE = { map: 0, x: -1240.1, y: 990.4, z: 42.5 };

  test("the died transition pins the corpse to the death spot until the query answers", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate, selfHealth(0, 30)]), { seed: SEED });
    expect(cache.self.corpse?.value).toEqual({ map: 0, x: -1234.5, y: 987.25, z: 42.125, source: "death_spot" });
    expect(cache.self.graveyard).toBeUndefined();
  });

  test("the corpse query and the release loc are the server's word, and the resurrect clears both", () => {
    const events = toEvents([
      ...loginSequence,
      selfCreate,
      selfHealth(0, 30),
      deathReleaseLoc(31, GRAVE),
      selfHealth(1, 32),
      corpseQuery(33, CORPSE),
    ]);
    const cache = StateCache.replay(events, { seed: SEED });
    expect(cache.self.graveyard?.value).toEqual(GRAVE);
    expect(cache.self.corpse?.value).toEqual({ ...CORPSE, source: "corpse_query" });
    expect(cache.self.corpse?.seq).toBe(33);
    cache.apply(toEvents([corpseReclaimDelay(30_000, 34, 1_000)])[0]!);
    expect(cache.self.reclaimDelay?.value).toEqual({ delayMs: 30_000, readyAt: 31_000 });
    cache.apply(toEvents([deathReleaseCleared(40)])[0]!);
    expect(cache.self.corpse).toBeUndefined();
    expect(cache.self.graveyard).toBeUndefined();
    expect(cache.self.reclaimDelay).toBeUndefined();
  });

  test("a corpse query answered not-found leaves no corpse, and a values delta without a death does not invent one", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, selfCreate, selfHealth(0, 30), corpseQuery(31)]),
      { seed: SEED },
    );
    expect(cache.self.corpse).toBeUndefined();
    const living = StateCache.replay(toEvents([...loginSequence, selfCreate, selfHealth(50, 30)]), { seed: SEED });
    expect(living.self.corpse).toBeUndefined();
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
    // Quality rides the same leg of the join `name` does, as bag() rows already
    // carry it: a paperdoll tints a slot by it.
    expect(item?.quality).toBe(1);
    expect(cache.items.get(ITEM_ENTRY)?.value.sellPrice).toBe(40);
  });

  test("an occupied slot whose item has not been created is still occupied", () => {
    const cache = withWorld([inventorySlot]);
    expect(cache.inventory).toHaveLength(1);
    expect(cache.inventory[0]?.guid).toBe(ITEM_GUID);
    expect(cache.inventory[0]?.itemId).toBeUndefined();
    expect(cache.inventory[0]?.name).toBeUndefined();
    // Unanswered, not poor: quality 0 is a real quality.
    expect(cache.inventory[0]?.quality).toBeUndefined();
  });

  test("an item whose create block arrived but whose query has not has no quality", () => {
    const cache = withWorld([inventorySlot, itemCreate]);
    expect(cache.inventory[0]?.itemId).toBe(ITEM_ENTRY);
    expect(cache.inventory[0]?.name).toBeUndefined();
    expect(cache.inventory[0]?.quality).toBeUndefined();
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
        quality: 1,
      },
    ]);
    expect(bag.freeSlots).toBe(15);
    expect(bag.totalSlots).toBe(16);
    expect(bag.bags).toEqual([]);
  });

  test("bag() spans a worn bag: container slots joined, addressed by the bag's equip slot", () => {
    const cache = withWorld([inventorySlot, itemCreate, itemQuery, wornBagSlot, wornBagCreate, wornBagQuery]);
    const bag = cache.bag();
    expect(bag.bags).toEqual([{ slot: BAG_SLOT, numSlots: BAG_NUM_SLOTS, name: "Small Brown Pouch" }]);
    expect(bag.totalSlots).toBe(16 + BAG_NUM_SLOTS);
    expect(bag.items.map((i) => [i.bag, i.slot, i.guid, i.name, i.count])).toEqual([
      [255, BACKPACK_SLOT, ITEM_GUID, "Gritstone Charm", 5],
      [BAG_SLOT, 2, BAGGED_GUID, "Gritstone Charm", 2],
    ]);
    expect(bag.freeSlots).toBe(16 + BAG_NUM_SLOTS - 2);
    // The bag itself is equipment (slot 19), never a carried item.
    expect(bag.items.some((i) => i.guid === BAG_GUID)).toBe(false);
    expect(cache.inventory.find((i) => i.slot === BAG_SLOT)?.name).toBe("Small Brown Pouch");
  });

  test("a worn bag whose create block has not arrived adds no slots", () => {
    const bag = withWorld([wornBagSlot]).bag();
    expect(bag.bags).toEqual([{ slot: BAG_SLOT, numSlots: 0, name: undefined }]);
    expect(bag.totalSlots).toBe(16);
    expect(bag.freeSlots).toBe(16);
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
    expect(withWorld([]).bag()).toEqual({ items: [], freeSlots: 16, totalSlots: 16, bags: [] });
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

  test("seeds zone and area when the snapshot carries them", () => {
    const f = frame("7");
    const cache = StateCache.replay(
      toEvents([{ ...f, data: { ...f.data, zoneId: 12, zoneName: "Elwynn Forest", areaId: 9, areaName: "Northshire Valley" } }]),
    );
    expect(cache.self.zone?.value).toEqual({ id: 12, name: "Elwynn Forest" });
    expect(cache.self.area?.value).toEqual({ id: 9, name: "Northshire Valley" });
    // A pre-N2 module's snapshot has neither: nothing is invented.
    expect(StateCache.replay(toEvents([frame("7")])).self.zone).toBeUndefined();
  });

  test("contradicting guid records an anomaly, never overwrites", () => {
    const cache = StateCache.replay(toEvents([frame("999")]), { seed: SEED });
    expect(cache.self.level?.value).toBeUndefined();
    expect(cache.anomalies.length).toBe(1);
    expect(cache.anomalies[0]!.kind).toBe("session_state_guid_mismatch");
  });
});

describe("guids are opaque decimal strings at the model surface", () => {
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
// The scan helper (earned by roster-opus-low-20260822 turn 15, where
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

/** The game object template answer the module fires on first sight of a gameObject entry. */
function namedGameObject(entry: number, name: string, seq: number, type = 5): unknown {
  return {
    seq,
    opcode: "SMSG_GAMEOBJECT_QUERY_RESPONSE",
    opcodeId: 0x05f,
    ts: 1_700_000_000_000 + seq,
    data: { entry, found: true, name, type, displayId: 1, castBarCaption: "" },
  };
}

function transportProgress(
  guid: string,
  entry: number,
  seq: number,
  pos: { x: number; y: number; z: number },
  docked: boolean | undefined,
  progressMs = 1000,
): unknown {
  return {
    seq,
    opcode: "WB_TRANSPORT_PROGRESS",
    opcodeId: 0xff06,
    ts: 1_700_000_000_000 + seq,
    data: { guid, entry, pos: { ...pos, o: 0 }, progressMs, periodMs: 143_330, ...(docked === undefined ? {} : { docked }) },
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
    // Deterministic repair: "90210" has exactly one valid reading.
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

  // The tree/tree-stump fixture: an exact name and a longer name that contains
  // it as a whole word, with the longer one placed *nearer*, so a pure distance
  // sort would put the stump first.
  const TREE_GUID = "1100";
  const STUMP_GUID = "1101";
  const TREE_ENTRY = 5100;
  const STUMP_ENTRY = 5101;
  const treeStream: unknown[] = [
    ...worldStream,
    unitAt(STUMP_GUID, 60, { dx: 2, objectType: "gameObject", entry: STUMP_ENTRY }),
    namedGameObject(STUMP_ENTRY, "tree stump", 61),
    unitAt(TREE_GUID, 62, { dx: 20, objectType: "gameObject", entry: TREE_ENTRY }),
    namedGameObject(TREE_ENTRY, "tree", 63),
  ];
  const treeCache = () => StateCache.replay(toEvents(treeStream), { seed: SEED });

  test("a plain name prefers the exact/shortest match over a longer one, even when farther", () => {
    const rows = treeCache().units({ name: "tree" });
    // Both match the substring, but "tree" (exact) ranks ahead of "tree stump"
    // (whole-word) despite the stump being nearer.
    expect(rows.map((r) => r.name)).toEqual(["tree", "tree stump"]);
    expect(rows[0]!.guid).toBe(TREE_GUID);
  });

  test("a regex-literal string and a RegExp both match with test(), nearest-first", () => {
    const c = treeCache();
    // Anchored regex: only the exact "tree", not "tree stump".
    expect(c.units({ name: "/^tree$/" }).map((r) => r.name)).toEqual(["tree"]);
    expect(c.units({ name: /^tree$/i }).map((r) => r.name)).toEqual(["tree"]);
    // A bare regex that matches both keeps nearest-first order (stump is nearer).
    expect(c.units({ name: /tree/ }).map((r) => r.name)).toEqual(["tree stump", "tree"]);
  });

  test("a string starting with / but not a valid regex literal is a literal name", () => {
    // No object is named this, so it simply finds nothing rather than throwing.
    expect(treeCache().units({ name: "/tree" })).toEqual([]);
  });

  test("a well-formed regex literal whose pattern is broken is rejected", () => {
    expect(() => cache().units({ name: "/tree(/" })).toThrow(/did not compile/);
  });

  test("a non-string, non-RegExp name is rejected with actionable help", () => {
    expect(() => cache().units({ name: 5 as unknown as string })).toThrow(/expected a string.*or a RegExp/s);
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

  test("bad filter values are rejected with an actionable TypeError", () => {
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

describe("state.closest(): criteria object or predicate", () => {
  const cache = () => StateCache.replay(toEvents(scanStream), { seed: SEED });

  test("takes a units() criteria object, the analogy four of five models drew", () => {
    // roster 2026-08-22: state.closest({entry:196}) / {name:"Deputy Willem"}
    // threw a bare "filter is not a function" for hy3, nemotron, laguna and
    // ox-alpha. It now means what it means in units().
    const c = cache();
    expect(c.closest({ entry: VENDOR_ENTRY })?.guid).toBe(VENDOR_GUID);
    expect(c.closest({ npc: true })?.guid).toBe(VENDOR_GUID);
    expect(c.closest({ type: "gameObject" })?.guid).toBe(OBJECT_GUID);
    // alive:true drops only the known-dead; the positionless ghost is not a
    // candidate for a distance question at all.
    expect(c.closest({ entry: FAR_ENTRY, alive: true })?.guid).toBe(FAR_GUID);
    expect(c.closest({ entry: FAR_ENTRY, alive: false })?.guid).toBe(DEAD_GUID);
    // maxDistance is evaluated against the same distance units() reports.
    expect(c.closest({ entry: FAR_ENTRY, maxDistance: 1 })).toBeUndefined();
    expect(c.closest({ entry: 999_999 })).toBeUndefined();
  });

  test("orders by distance, not by units()'s name tier", () => {
    // units({name}) ranks an exact match ahead of a longer substring match
    // regardless of distance; closest answers "nearest", which is the whole
    // question it is asked.
    const NEAR = "2001";
    const FAR = "2002";
    const NEAR_ENTRY = 5252;
    const FAR_NAME_ENTRY = 5253;
    const c = StateCache.replay(
      toEvents([
        ...worldStream,
        unitAt(FAR, 40, { dx: 100, entry: FAR_NAME_ENTRY, health: 50, maxHealth: 50 }),
        namedEntry(FAR_NAME_ENTRY, "Boar", 41),
        unitAt(NEAR, 42, { dx: 5, entry: NEAR_ENTRY, health: 50, maxHealth: 50 }),
        namedEntry(NEAR_ENTRY, "Boar Cub", 43),
      ]),
      { seed: SEED },
    );
    expect(c.units({ name: "boar" }).map((u) => u.guid)).toEqual([FAR, NEAR]);
    expect(c.closest({ name: "boar" })?.guid).toBe(NEAR);
  });

  test("a predicate still works and still sees the raw object", () => {
    const c = cache();
    expect(c.closest((o) => o.objectType?.value === "gameObject")?.guid).toBe(OBJECT_GUID);
    expect(c.closest()?.guid).toBeDefined();
  });

  test("a bad key is rejected with the same message units() gives", () => {
    const c = cache();
    expect(() => c.closest({ minLevel: 5 } as unknown as UnitFilter)).toThrow(
      /unknown key "minLevel"/,
    );
    expect(() => c.closest({ minLevel: 5 } as unknown as UnitFilter)).toThrow(
      /Valid keys are entry, name/,
    );
    expect(() => c.closest({ alive: "true" as unknown as boolean })).toThrow(
      /expected true or false/,
    );
  });
});

describe("state cache: the gossip menu fold", () => {
  const gossipMsg = (guid: string, seq: number) => ({
    seq,
    opcode: "SMSG_GOSSIP_MESSAGE",
    opcodeId: 0x17d,
    ts: 1_700_000_000_000 + seq,
    data: {
      guid,
      menuId: 5,
      textId: 1,
      options: [
        { optionId: 0, icon: 0, text: "Train me" },
        { optionId: 1, icon: 0, text: "Show wares" },
      ],
      quests: [],
    },
  });
  const gossipComplete = (seq: number) => ({
    seq,
    opcode: "SMSG_GOSSIP_COMPLETE",
    opcodeId: 0x17e,
    ts: 1_700_000_000_000 + seq,
    data: {},
  });

  test("SMSG_GOSSIP_MESSAGE folds into lastGossip and the snapshot, options only", () => {
    const c = StateCache.replay(toEvents([...worldStream, gossipMsg("2002", 70)]), { seed: SEED });
    const menu = c.lastGossip("2002");
    expect(menu?.menuId).toBe(5);
    expect(menu?.options).toEqual([
      { optionId: 0, text: "Train me" },
      { optionId: 1, text: "Show wares" },
    ]);
    expect(c.snapshot().gossip.get("2002")?.menuId).toBe(5);
  });

  test("SMSG_GOSSIP_COMPLETE clears the open menu", () => {
    const c = StateCache.replay(
      toEvents([...worldStream, gossipMsg("2002", 70), gossipComplete(71)]),
      { seed: SEED },
    );
    expect(c.lastGossip("2002")).toBeUndefined();
    expect(c.snapshot().gossip.size).toBe(0);
  });

  test("guid lookups are canonical, so a non-canonical guid finds the same menu", () => {
    const c = StateCache.replay(toEvents([...worldStream, gossipMsg("2002", 70)]), { seed: SEED });
    // "2002" is already canonical here; the fold keys by the schema-canonical
    // guid, which is what gossipSelect looks up with guidKey(...).
    expect(c.lastGossip("2002")?.menuId).toBe(5);
  });
});

describe("state cache: vendor, trainer and loot windows", () => {
  const ts = (seq: number) => 1_700_000_000_000 + seq;
  const vendorList = (guid: string, seq: number, items = [{ slot: 1, itemId: 117, price: 25, buyCount: 1, leftInStock: -1, extendedCost: 0 }]) => ({
    seq,
    opcode: "SMSG_LIST_INVENTORY",
    opcodeId: 0x19f,
    ts: ts(seq),
    data: { vendorGuid: guid, items },
  });
  const trainerList = (guid: string, seq: number) => ({
    seq,
    opcode: "SMSG_TRAINER_LIST",
    opcodeId: 0x1b1,
    ts: ts(seq),
    data: {
      guid,
      trainerType: 0,
      spells: [{ spellId: 1180, state: 0, cost: 100, reqLevel: 4, reqSkill: 0, reqSkillValue: 0 }],
      greeting: "I can teach you.",
    },
  });
  const lootResponse = (guid: string, seq: number) => ({
    seq,
    opcode: "SMSG_LOOT_RESPONSE",
    opcodeId: 0x160,
    ts: ts(seq),
    data: {
      guid,
      lootType: 1,
      gold: 42,
      items: [
        { slot: 0, itemId: 2589, count: 2, slotType: 0 },
        { slot: 1, itemId: 769, count: 1, slotType: 0 },
      ],
    },
  });
  const lootRemoved = (slot: number, seq: number) => ({
    seq,
    opcode: "SMSG_LOOT_REMOVED",
    opcodeId: 0x162,
    ts: ts(seq),
    data: { slot },
  });
  const lootClearMoney = (seq: number) => ({
    seq,
    opcode: "SMSG_LOOT_CLEAR_MONEY",
    opcodeId: 0x165,
    ts: ts(seq),
    data: {},
  });
  const lootRelease = (guid: string, seq: number) => ({
    seq,
    opcode: "SMSG_LOOT_RELEASE_RESPONSE",
    opcodeId: 0x161,
    ts: ts(seq),
    data: { guid },
  });
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("a vendor list folds per guid, rows verbatim, and reaches the snapshot", () => {
    const c = withWorld([vendorList("3001", 70)]);
    const win = c.lastVendorList("3001");
    expect(win?.items).toEqual([
      { slot: 1, itemId: 117, price: 25, buyCount: 1, leftInStock: -1, extendedCost: 0 },
    ]);
    expect(win?.seq).toBe(70);
    expect(c.snapshot().vendorWindows.get("3001")?.items).toHaveLength(1);
    // Another vendor is another window, not a replacement.
    expect(c.lastVendorList("3002")).toBeUndefined();
  });

  test("a second list for the same vendor replaces the first", () => {
    const c = withWorld([
      vendorList("3001", 70),
      vendorList("3001", 71, [
        { slot: 1, itemId: 117, price: 25, buyCount: 1, leftInStock: 0, extendedCost: 0 },
      ]),
    ]);
    expect(c.lastVendorList("3001")?.items[0]?.leftInStock).toBe(0);
    expect(c.lastVendorList("3001")?.seq).toBe(71);
  });

  test("a trainer list folds per guid with the server's raw rows", () => {
    const c = withWorld([trainerList("3003", 70)]);
    const win = c.lastTrainerList("3003");
    expect(win?.trainerType).toBe(0);
    expect(win?.greeting).toBe("I can teach you.");
    expect(win?.spells[0]).toEqual({
      spellId: 1180,
      state: 0,
      cost: 100,
      reqLevel: 4,
      reqSkill: 0,
      reqSkillValue: 0,
    });
    // No derivation: learnable/affordable are trainerList()'s, not the cache's.
    expect(Object.keys(win!.spells[0]!)).not.toContain("learnable");
    expect(c.snapshot().trainerWindows.get("3003")?.spells).toHaveLength(1);
  });

  test("neither window is cleared by a gossip close, because nothing closes them", () => {
    const c = withWorld([
      vendorList("3001", 70),
      trainerList("3003", 71),
      { seq: 72, opcode: "SMSG_GOSSIP_COMPLETE", opcodeId: 0x17e, ts: ts(72), data: {} },
    ]);
    expect(c.lastVendorList("3001")).toBeDefined();
    expect(c.lastTrainerList("3003")).toBeDefined();
  });

  test("a loot window opens, loses taken slots and taken gold, and closes on its release", () => {
    const open = withWorld([lootResponse("4001", 70)]);
    expect(open.lastLoot()?.gold).toBe(42);
    expect(open.lastLoot()?.items).toHaveLength(2);
    expect(open.snapshot().lootWindow?.guid).toBe("4001");

    const partial = withWorld([lootResponse("4001", 70), lootRemoved(0, 71), lootClearMoney(72)]);
    expect(partial.lastLoot()?.items.map((i) => i.slot)).toEqual([1]);
    expect(partial.lastLoot()?.gold).toBe(0);
    expect(partial.lastLoot()?.seq).toBe(72);

    const closed = withWorld([lootResponse("4001", 70), lootRelease("4001", 71)]);
    expect(closed.lastLoot()).toBeUndefined();
    expect(closed.snapshot().lootWindow).toBeUndefined();
  });

  test("a release for a different object leaves the open window alone", () => {
    const c = withWorld([lootResponse("4001", 70), lootRelease("4002", 71)]);
    expect(c.lastLoot()?.guid).toBe("4001");
  });

  test("loot packets with no window open change nothing", () => {
    const c = withWorld([lootRemoved(0, 70), lootClearMoney(71), lootRelease("4001", 72)]);
    expect(c.lastLoot()).toBeUndefined();
  });
});

describe("state cache: questgiver markers", () => {
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("a unit has no marker until a status packet names it", () => {
    const c = withWorld([]);
    const row = c.units().find((r) => r.guid === CREATURE_GUID)!;
    expect(row.questGiver).toBeUndefined();
    expect(row.questGiverStatus).toBeUndefined();
    expect(c.nearby.get(CREATURE_GUID)?.questGiver).toBeUndefined();
  });

  test("SMSG_QUESTGIVER_STATUS folds onto the unit, named and raw", () => {
    const c = withWorld([questGiverStatus(CREATURE_GUID, 10, 60)]);
    const row = c.units().find((r) => r.guid === CREATURE_GUID)!;
    expect(row.questGiver).toBe("reward");
    expect(row.questGiverStatus).toBe(10);
    expect(c.nearby.get(CREATURE_GUID)?.questGiver).toEqual({ value: 10, seq: 60, ts: 1_700_000_000_060 });
  });

  test("the latest status per guid wins, and STATUS_MULTIPLE covers several guids at once", () => {
    const c = withWorld([
      questGiverStatus(CREATURE_GUID, 8, 60),
      questGiverStatusMultiple(
        [
          { guid: CREATURE_GUID, status: 5 },
          { guid: PLAYER_GUID, status: 0 },
        ],
        61,
      ),
    ]);
    const byGuid = new Map(c.units().map((r) => [r.guid, r]));
    expect(byGuid.get(CREATURE_GUID)?.questGiver).toBe("incomplete");
    expect(byGuid.get(PLAYER_GUID)?.questGiver).toBe("none");
    expect(byGuid.get(PLAYER_GUID)?.questGiverStatus).toBe(0);
  });

  test("every DIALOG_STATUS byte has a name; out-of-range bytes are unknown", () => {
    const names = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(
      (n) => withWorld([questGiverStatus(CREATURE_GUID, n, 60)]).units().find((r) => r.guid === CREATURE_GUID)!.questGiver,
    );
    expect(names).toEqual([
      "none",
      "unavailable",
      "low_level_available",
      "low_level_reward_rep",
      "low_level_available_rep",
      "incomplete",
      "reward_rep",
      "available_rep",
      "available",
      "reward2",
      "reward",
      "unknown",
    ]);
  });

  test("a status for a guid with no create block still puts it in view, untyped", () => {
    const GHOST = "17365880163140639999";
    const c = withWorld([questGiverStatus(GHOST, 8, 60)]);
    const row = c.units().find((r) => r.guid === GHOST)!;
    expect(row.type).toBeUndefined();
    expect(row.questGiver).toBe("available");
  });

  test("the marker leaves with the object, and a replay is identical", () => {
    const frames = [questGiverStatus(CREATURE_GUID, 10, 60), creatureOutOfRange];
    const c = withWorld(frames);
    expect(c.nearby.has(CREATURE_GUID)).toBe(false);
    const live = new StateCache({ seed: SEED });
    for (const e of toEvents([...worldStream, ...frames])) live.apply(e);
    expect(live.snapshot()).toEqual(c.snapshot());
  });

  test("units({ questGiver }) filters by one name or a list; unobserved never matches", () => {
    const c = withWorld([
      playerCreate,
      questGiverStatusMultiple(
        [
          { guid: CREATURE_GUID, status: 10 },
          { guid: PLAYER_GUID, status: 8 },
        ],
        60,
      ),
    ]);
    expect(c.units({ questGiver: "reward" }).map((r) => r.guid)).toEqual([CREATURE_GUID]);
    expect(c.units({ questGiver: ["reward", "available"] }).map((r) => r.guid).sort()).toEqual(
      [CREATURE_GUID, PLAYER_GUID].sort(),
    );
    expect(c.units({ questGiver: "incomplete" })).toEqual([]);
    expect(withWorld([]).units({ questGiver: "none" })).toEqual([]);
    expect(c.closest({ questGiver: "available" })?.guid).toBe(PLAYER_GUID);
  });

  test("units({ questGiver }) rejects a name it cannot read, and says what it takes", () => {
    const c = withWorld([]);
    expect(() => c.units({ questGiver: "?" as never })).toThrow(/questGiver received "\?", expected one of "none", .*"reward"/);
    expect(() => c.units({ questGiver: "Reward" as never })).toThrow(/exact, case-sensitive/);
    expect(() => c.units({ questGiver: [] })).toThrow(/empty array/);
    expect(() => c.units({ questGiver: 10 as never })).toThrow(/questGiver received 10/);
  });
});

describe("state cache: quest objectives from the quest query", () => {
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("before the query answers, the entry has no title and objectives are undefined, not []", () => {
    const q = withWorld([questAccepted]).quest(QUEST_ID)!;
    expect(q.title).toBeUndefined();
    expect(q.objectives).toBeUndefined();
    expect(q.counts).toEqual([0, 0, 0, 0]);
  });

  test("SMSG_QUEST_QUERY_RESPONSE lands in state.quests and joins onto the log entry", () => {
    const c = withWorld([questAccepted, questQueryResponse()]);
    expect(c.quests.get(QUEST_ID)?.value.title).toBe("Kobold Camp Cleanup");
    expect(c.quests.get(QUEST_ID)?.value.level).toBe(3);
    const q = c.quest(QUEST_ID)!;
    expect(q.title).toBe("Kobold Camp Cleanup");
    expect(q.objectives).toEqual([
      { kind: "kill", entry: KOBOLD_ENTRY, text: undefined, required: 8, have: 0, done: false },
      { kind: "interact", entry: GO_ENTRY, text: "Unlock the chest", required: 1, have: 0, done: false },
      { kind: "event", entry: undefined, text: "Investigate the vineyard", required: 1, have: 0, done: false },
      { kind: "collect", entry: REQUIRED_ITEM, text: undefined, required: 4, have: 0, done: false },
    ]);
  });

  test("have comes from the log counters per slot, and from the backpack for items", () => {
    const c = withWorld([questAccepted, questQueryResponse(), questProgress, inventorySlot, itemCreate, itemQuery]);
    const obj = c.quest(QUEST_ID)!.objectives!;
    // counts [3, 5, 7, 9]: slot 0 kill 3/8, slot 1 go 5/1 (done), slot 2 event 7/1 (done)
    expect(obj.map((o) => [o.kind, o.have, o.done])).toEqual([
      ["kill", 3, false],
      ["interact", 5, true],
      ["event", 7, true],
      ["collect", 5, true], // one stack of 5 Gritstone Charms in the backpack
    ]);
  });

  test("the answer arriving before the log entry still joins; the template is never pruned", () => {
    const c = withWorld([questQueryResponse(), questAccepted]);
    expect(c.quest(QUEST_ID)?.title).toBe("Kobold Camp Cleanup");
    const after = withWorld([questQueryResponse(), questAccepted, questRewarded(QUEST_ID), selfProgress]);
    expect(after.quests.has(QUEST_ID)).toBe(true);
  });

  test("a second quest in the log without an answer stays undecorated", () => {
    const c = withWorld([questAccepted, questChained, questQueryResponse()]);
    expect(c.quest(OTHER_QUEST_ID)?.objectives).toBeUndefined();
    expect(c.quest(QUEST_ID)?.objectives).toHaveLength(4);
  });
});

describe("state cache: spellbook, cooldowns and talents", () => {
  const at = (seq: number, opcode: string, opcodeId: number, data: unknown) => ({
    seq,
    opcode,
    opcodeId,
    ts: 1_700_000_000_000 + seq,
    data,
  });
  const initialSpells = at(60, "SMSG_INITIAL_SPELLS", 0x12a, {
    spells: [
      { spellId: 100, rank: 1, name: "Fixture Strike" },
      { spellId: 200, rank: 1 },
    ],
    cooldowns: [
      { spellId: 100, itemId: 0, category: 0, cooldownMs: 30_000, categoryCooldownMs: 0 },
      { spellId: 300, itemId: 0, category: 5, cooldownMs: 0, categoryCooldownMs: 0x80000000 },
    ],
  });
  const withWorld = (extra: readonly unknown[]) =>
    StateCache.replay(toEvents([...worldStream, ...extra]), { seed: SEED });

  test("empty until SMSG_INITIAL_SPELLS; then the book and its cooldowns are what the server served", () => {
    expect(withWorld([]).spells()).toEqual([]);
    expect(withWorld([]).talents()).toBeUndefined();
    const c = withWorld([initialSpells]);
    expect(c.spells().map((s) => [s.spellId, s.rank, s.name])).toEqual([
      [100, 1, "Fixture Strike"],
      [200, 1, undefined],
    ]);
    expect(c.spell(200)?.seq).toBe(60);
    expect(c.spell(999)).toBeUndefined();
    const cds = c.cooldowns(1_700_000_000_060 + 1000);
    expect(cds.map((x) => [x.spellId, x.readyAt, x.cooldownMs])).toEqual([
      [100, 1_700_000_000_060 + 30_000, 30_000],
      [300, Number.POSITIVE_INFINITY, undefined],
    ]);
    // The clock is the only judge of expiry.
    expect(c.cooldowns(1_700_000_000_060 + 31_000).map((x) => x.spellId)).toEqual([300]);
  });

  test("learned, removed and superseded edit the book in place", () => {
    const c = withWorld([
      initialSpells,
      at(61, "SMSG_LEARNED_SPELL", 0x12b, { spellId: 400, rank: 2, name: "Fixture Strike" }),
      at(62, "SMSG_SUPERCEDED_SPELL", 0x12c, { supersededSpellId: 100, spellId: 400, rank: 2 }),
      at(63, "SMSG_REMOVED_SPELL", 0x203, { spellId: 200 }),
    ]);
    expect(c.spells().map((s) => s.spellId)).toEqual([400]);
    expect(c.spell(400)?.rank).toBe(2);
  });

  test("cooldown announcements replace, COOLDOWN_EVENT is duration-less, CLEAR drops; other guids are ignored", () => {
    const c = withWorld([
      initialSpells,
      at(61, "SMSG_SPELL_COOLDOWN", 0x134, { guid: "7", flags: 1, cooldowns: [{ spellId: 100, cooldownMs: 5000 }, { spellId: 500, cooldownMs: 0 }] }),
      at(62, "SMSG_COOLDOWN_EVENT", 0x135, { spellId: 600, guid: "7" }),
      at(63, "SMSG_CLEAR_COOLDOWN", 0x1de, { spellId: 300, guid: "7" }),
      at(64, "SMSG_SPELL_COOLDOWN", 0x134, { guid: "99", flags: 0, cooldowns: [{ spellId: 700, cooldownMs: 9000 }] }),
    ]);
    const now = 1_700_000_000_061 + 100;
    expect(c.cooldowns(now).map((x) => [x.spellId, x.readyAt])).toEqual([
      [100, 1_700_000_000_061 + 5000],
      [600, undefined],
    ]);
  });

  test("SMSG_TALENTS_INFO keeps the active spec; the pet form changes nothing", () => {
    const c = withWorld([
      at(61, "SMSG_TALENTS_INFO", 0x4c0, {
        pet: false,
        unspentPoints: 2,
        specCount: 2,
        activeSpec: 1,
        specs: [{ talents: [{ talentId: 1, rank: 0 }] }, { talents: [{ talentId: 7, rank: 2 }] }],
      }),
      at(62, "SMSG_TALENTS_INFO", 0x4c0, { pet: true }),
    ]);
    expect(c.talents()).toEqual({
      unspentPoints: 2,
      activeSpec: 1,
      specCount: 2,
      talents: [{ talentId: 7, rank: 2 }],
      seq: 61,
      ts: 1_700_000_000_061,
    });
    expect(c.snapshot().talents?.unspentPoints).toBe(2);
  });
});

describe("xp is read off the state object, not off self", () => {
  test("state.self.xp and state.self.experience throw and name state.xp", () => {
    const cache = new StateCache();
    expect(() => (cache.self as unknown as { xp: unknown }).xp).toThrow(/state\.xp/);
    expect(() => (cache.self as unknown as { experience: unknown }).experience).toThrow(
      /state\.nextLevelXp/,
    );
  });

  test("the guards are invisible to snapshot, spread and JSON", () => {
    const cache = new StateCache();
    expect(() => cache.snapshot()).not.toThrow();
    expect(() => JSON.stringify(cache.self)).not.toThrow();
    expect(() => ({ ...cache.self })).not.toThrow();
    expect(Object.keys(cache.self)).not.toContain("xp");
  });
});

describe("game objects: names, goType and transports", () => {
  const TRAM_GUID = "9001";
  const TRAM_ENTRY = 176081;
  const BOX_GUID = "9002";
  const BOX_ENTRY = 32571;

  test("a game object is named from its own query answer, never from a creature with the same entry", () => {
    const c = StateCache.replay(
      toEvents([
        ...worldStream,
        unitAt(BOX_GUID, 60, { dx: 3, objectType: "gameObject", entry: BOX_ENTRY }),
        namedEntry(BOX_ENTRY, "Not A Mailbox", 61),
      ]),
      { seed: SEED },
    );
    expect(c.units({ type: "gameObject" })[0]!.name).toBeUndefined();
    c.apply(toEvents([namedGameObject(BOX_ENTRY, "Mailbox", 62, 19)])[0]!);
    const row = c.units({ type: "gameObject" })[0]!;
    expect(row.name).toBe("Mailbox");
    expect(row.goType).toBe("mailbox");
    expect(c.gameObjects.get(BOX_ENTRY)?.value.type).toBe(19);
  });

  test("goType comes from the create block's GAMEOBJECT_BYTES_1 when present, named from the core enum", () => {
    const c = StateCache.replay(
      toEvents([
        ...worldStream,
        {
          seq: 60,
          opcode: "SMSG_UPDATE_OBJECT",
          opcodeId: 0x0a9,
          ts: 1_700_000_000_060,
          data: {
            blocks: 1,
            objects: [
              {
                update: "create",
                guid: TRAM_GUID,
                objectType: "gameObject",
                pos: { x: 4.5, y: 8.4, z: -4.3, o: 0 },
                pathProgress: 12_000,
                fields: { entry: TRAM_ENTRY, goState: 1, goType: 11 },
              },
            ],
          },
        },
      ]),
      { seed: SEED },
    );
    const row = c.units({ type: "gameObject" }).find((r) => r.guid === TRAM_GUID)!;
    expect(row.goType).toBe("transport");
    expect(row.docked).toBeUndefined(); // the clock alone says nothing about dwelling
    expect(c.nearby.get(TRAM_GUID)?.transport?.value.progressMs).toBe(12_000);
    // A unit never has a goType, and a value outside the enum is "unknown".
    expect(c.units({ type: "unit" })[0]!.goType).toBeUndefined();
    expect(gameObjectTypeName(99)).toBe("unknown");
  });

  test("WB_TRANSPORT_PROGRESS moves the car, sets docked, and accrues the places it stops", () => {
    const c = StateCache.replay(
      toEvents([
        ...worldStream,
        unitAt(TRAM_GUID, 60, { dx: 0, objectType: "gameObject", entry: TRAM_ENTRY }),
        namedGameObject(TRAM_ENTRY, "Subway", 61, 11),
        transportProgress(TRAM_GUID, TRAM_ENTRY, 62, { x: 4.5, y: 8.4, z: -4.3 }, true, 1000),
        transportProgress(TRAM_GUID, TRAM_ENTRY, 63, { x: 4.5, y: 9.0, z: -4.3 }, true, 2000),
        transportProgress(TRAM_GUID, TRAM_ENTRY, 64, { x: 4.5, y: 900.0, z: -4.3 }, false, 40_000),
      ]),
      { seed: SEED },
    );
    const row = c.units({ type: "gameObject" }).find((r) => r.guid === TRAM_GUID)!;
    expect(row.name).toBe("Subway");
    expect(row.goType).toBe("transport");
    expect(row.docked).toBe(false);
    expect(row.y).toBe(900);
    const t = c.nearby.get(TRAM_GUID)!.transport!.value;
    expect(t.progressMs).toBe(40_000);
    expect(t.periodMs).toBe(143_330);
    expect(t.docks).toEqual([{ x: 4.5, y: 8.4, z: -4.3 }]); // 0.6y apart: one dock, not two
    c.apply(toEvents([transportProgress(TRAM_GUID, TRAM_ENTRY, 65, { x: 4.5, y: 2480.0, z: -4.3 }, true, 70_000)])[0]!);
    expect(c.nearby.get(TRAM_GUID)!.transport!.value.docks).toHaveLength(2);
    expect(c.units({ type: "gameObject" }).find((r) => r.guid === TRAM_GUID)!.docked).toBe(true);
  });

  test("a report for a car the update stream never created still puts it in view, typed by its report", () => {
    const c = StateCache.replay(
      toEvents([...worldStream, transportProgress(TRAM_GUID, TRAM_ENTRY, 62, { x: 4.5, y: 8.4, z: -4.3 }, true)]),
      { seed: SEED },
    );
    const obj = c.nearby.get(TRAM_GUID)!;
    expect(obj.entry?.value).toBe(TRAM_ENTRY);
    expect(obj.transport?.value.docked).toBe(true);
    // No create block: objectType is unobserved, so it is not a gameObject row and has no goType.
    expect(c.units().find((r) => r.guid === TRAM_GUID)!.goType).toBeUndefined();
  });
});

describe("WB_AREA (zone/subzone as the client names them)", () => {
  const area = (seq: number, d: Record<string, unknown>) => ({
    seq,
    opcode: "WB_AREA",
    opcodeId: 0xff07,
    ts: 1000 + seq,
    data: { mapId: 0, zoneId: 12, zoneName: "Elwynn Forest", areaId: 9, areaName: "Northshire Valley", ...d },
  });

  test("folds into self.zone / self.area as Observed { id, name }", () => {
    const cache = StateCache.replay(toEvents([area(1, {})]), { seed: SEED });
    expect(cache.self.zone).toEqual({ value: { id: 12, name: "Elwynn Forest" }, seq: 1, ts: 1001 });
    expect(cache.self.area).toEqual({ value: { id: 9, name: "Northshire Valley" }, seq: 1, ts: 1001 });
  });

  test("a later event replaces both; the zone survives a subzone-only change", () => {
    const cache = StateCache.replay(
      toEvents([area(1, {}), area(2, { areaId: 24, areaName: "Northshire Abbey" })]),
      { seed: SEED },
    );
    expect(cache.self.zone?.value).toEqual({ id: 12, name: "Elwynn Forest" });
    expect(cache.self.area?.value).toEqual({ id: 24, name: "Northshire Abbey" });
    expect(cache.self.area?.seq).toBe(2);
  });
});

describe("units(): NPC roles from UNIT_NPC_FLAGS", () => {
  const cache = () =>
    StateCache.replay(
      toEvents([
        // questgiver + gossip
        unitAt("901", 1, { dx: 3, entry: 823, health: 100, maxHealth: 100, npcFlags: 0x3 }),
        // vendor (general + food) + repair
        unitAt("902", 2, { dx: 5, entry: 824, health: 100, maxHealth: 100, npcFlags: 0x80 | 0x200 | 0x1000 }),
        // flight master
        unitAt("903", 3, { dx: 7, entry: 825, health: 100, maxHealth: 100, npcFlags: 0x2000 }),
        // flags never observed
        unitAt("904", 4, { dx: 9, entry: 826, health: 100, maxHealth: 100 }),
      ]),
      { seed: SEED },
    );

  test("rows carry role words in bit order; no flags means an empty array", () => {
    const c = cache();
    const by = (g: string) => c.units().find((u) => u.guid === g)!.roles;
    expect(by("901")).toEqual(["gossip", "questGiver"]);
    expect(by("902")).toEqual(["vendor", "foodVendor", "repair"]);
    expect(by("903")).toEqual(["flightMaster"]);
    expect(by("904")).toEqual([]);
  });

  test("role filter matches one word or any of a list, nearest first", () => {
    const c = cache();
    expect(c.units({ role: "questGiver" }).map((u) => u.guid)).toEqual(["901"]);
    expect(c.units({ role: ["repair", "flightMaster"] }).map((u) => u.guid)).toEqual(["902", "903"]);
    expect(c.units({ role: "innkeeper" })).toEqual([]);
  });

  test("an unknown role word is rejected with the list", () => {
    expect(() => cache().units({ role: "flight master" as never })).toThrow(/role received "flight master", expected one of/);
  });
});

describe("achievements and flight paths", () => {
  const earned = (seq: number, id: number, self: boolean, extra: Record<string, unknown> = {}) => ({
    seq,
    opcode: "SMSG_ACHIEVEMENT_EARNED",
    opcodeId: 0x468,
    ts: 2000 + seq,
    data: {
      guid: self ? SEED.guid : "999",
      self,
      achievement: { achievementId: id, date: 123, time: "2026-08-25 10:00", ...extra },
    },
  });
  const backlog = (seq: number, ids: number[]) => ({
    seq,
    opcode: "SMSG_ALL_ACHIEVEMENT_DATA",
    opcodeId: 0x47d,
    ts: 2000 + seq,
    data: {
      count: ids.length,
      achievements: ids.map((id) => ({ achievementId: id, date: 1, points: 10 })),
    },
  });
  const taxiReply = (seq: number, reply: number) => ({
    seq,
    opcode: "SMSG_ACTIVATETAXIREPLY",
    opcodeId: 0x1ae,
    ts: 2000 + seq,
    data: { reply, ok: reply === 0 },
  });
  /** A self values block carrying `unitFlags` (and the module's named bit). */
  const unitFlags = (seq: number, flags: number) => ({
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: 2000 + seq,
    data: {
      blocks: 1,
      objects: [
        {
          update: "values",
          guid: SEED.guid,
          fields: { unitFlags: flags, taxiFlight: (flags & 0x0010_0000) !== 0 },
        },
      ],
    },
  });

  test("the login backlog and our own earns land in self.achievements, with the points total", () => {
    const cache = StateCache.replay(
      toEvents([backlog(1, [6, 7]), earned(2, 12, true, { name: "Explore Elwynn Forest", points: 10, categoryId: 97 })]),
      { seed: SEED },
    );
    const a = cache.self.achievements!;
    expect(a.loginSeen).toBe(true);
    expect(a.entries.map((e) => [e.achievementId, e.source])).toEqual([
      [6, "login"],
      [7, "login"],
      [12, "earned"],
    ]);
    expect(a.points).toBe(30);
    expect(a.entries[2]!.name).toBe("Explore Elwynn Forest");
    expect(a.entries[2]!.categoryId).toBe(97);
  });

  test("a say-range broadcast for another player is not ours and is dropped", () => {
    // SMSG_ACHIEVEMENT_EARNED reaches every client in say range; `self` is the
    // only thing that makes it this character's.
    const cache = StateCache.replay(toEvents([earned(1, 99, false, { points: 50 })]), { seed: SEED });
    expect(cache.self.achievements).toBeUndefined();
  });

  test("an empty backlog is observed, which is not the same as no backlog", () => {
    const cache = StateCache.replay(toEvents([backlog(1, [])]), { seed: SEED });
    expect(cache.self.achievements).toEqual({ entries: [], points: 0, loginSeen: true });
    expect(StateCache.replay(toEvents([]), { seed: SEED }).self.achievements).toBeUndefined();
  });

  test("an id already in the backlog is not double-counted by a later earn", () => {
    const cache = StateCache.replay(toEvents([backlog(1, [6]), earned(2, 6, true, { points: 10 })]), {
      seed: SEED,
    });
    expect(cache.self.achievements!.entries).toHaveLength(1);
    expect(cache.self.achievements!.points).toBe(10);
    expect(cache.self.achievements!.entries[0]!.source).toBe("login");
  });

  test("taxiFlight is the UNIT_FLAG_TAXI_FLIGHT bit on self, with the reply beside it", () => {
    const cache = StateCache.replay(
      toEvents([unitFlags(1, 0x8), taxiReply(2, 0), unitFlags(3, 0x0010_0008), unitFlags(4, 0x8)]),
      { seed: SEED },
    );
    expect(cache.self.taxiReply?.value).toEqual({ reply: 0, ok: true });
    // The last word is the landing; the flip itself is the runner's to read.
    expect(cache.self.taxiFlight).toEqual({ value: false, seq: 4, ts: 2004 });
  });

  test("SMSG_SHOWTAXINODES folds into lastTaxiNodes(guid): current node, known nodes, the mask verbatim", () => {
    const window = (seq: number) => ({
      seq,
      opcode: "SMSG_SHOWTAXINODES",
      opcodeId: 0x1a9,
      ts: 2000 + seq,
      data: {
        showWindow: true,
        guid: "17365880163140632581",
        currentNode: 6,
        currentNodeName: "Ironforge, Dun Morogh",
        mask: [0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        known: [{ nodeId: 6, name: "Ironforge, Dun Morogh" }, { nodeId: 7 }],
      },
    });
    const cache = StateCache.replay(toEvents([window(1)]), { seed: SEED });
    const w = cache.lastTaxiNodes("17365880163140632581");
    expect(w?.current).toEqual({ nodeId: 6, name: "Ironforge, Dun Morogh" });
    expect(w?.known).toEqual([
      { nodeId: 6, name: "Ironforge, Dun Morogh" },
      { nodeId: 7, name: undefined },
    ]);
    expect(w?.mask).toEqual([0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(w?.seq).toBe(1);
    expect(cache.lastTaxiNodes("8")).toBeUndefined();
    expect(cache.snapshot().taxiWindows.get("17365880163140632581")?.current.nodeId).toBe(6);
  });

  test("SMSG_BINDPOINTUPDATE is self.bindPoint, the last one winning", () => {
    const bind = (seq: number, areaId: number, areaName: string, x: number) => ({
      seq,
      opcode: "SMSG_BINDPOINTUPDATE",
      opcodeId: 0x155,
      ts: 2000 + seq,
      data: { x, y: -132.5, z: 83.5, map: 0, areaId, areaName },
    });
    const cache = StateCache.replay(toEvents([bind(1, 9, "Northshire Valley", -8949.9), bind(2, 1537, "Ironforge", -4840.6)]), {
      seed: SEED,
    });
    expect(cache.self.bindPoint).toEqual({
      value: { map: 0, x: -4840.6, y: -132.5, z: 83.5, area: { id: 1537, name: "Ironforge" } },
      seq: 2,
      ts: 2002,
    });
    expect(StateCache.replay([], { seed: SEED }).self.bindPoint).toBeUndefined();
  });

  test("a refused flight is an ok:false reply and no flag", () => {
    const cache = StateCache.replay(toEvents([taxiReply(1, 3)]), { seed: SEED });
    expect(cache.self.taxiReply?.value).toEqual({ reply: 3, ok: false });
    expect(cache.self.taxiFlight).toBeUndefined();
  });

  test("a block with no unitFlags leaves taxiFlight alone rather than reading it as false", () => {
    const cache = StateCache.replay(
      toEvents([unitFlags(1, 0x0010_0000), selfProgress]),
      { seed: SEED },
    );
    expect(cache.self.taxiFlight).toEqual({ value: true, seq: 1, ts: 2001 });
  });

  /** A self values block carrying `playerFlags`, the players-only field. */
  const playerFlags = (seq: number, flags: number) => ({
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: 2000 + seq,
    data: {
      blocks: 1,
      objects: [{ update: "values", guid: SEED.guid, fields: { playerFlags: flags } }],
    },
  });

  test("resting is the PLAYER_FLAGS_RESTING bit on self, and unobserved until a block carries it", () => {
    expect(StateCache.replay([], { seed: SEED }).self.resting).toBeUndefined();
    // 0x20 is PLAYER_FLAGS_RESTING; 0x10 (ghost) alone is not resting.
    expect(
      StateCache.replay(toEvents([playerFlags(1, 0x10)]), { seed: SEED }).self.resting,
    ).toEqual({ value: false, seq: 1, ts: 2001 });
    expect(
      StateCache.replay(toEvents([playerFlags(1, 0x30)]), { seed: SEED }).self.resting,
    ).toEqual({ value: true, seq: 1, ts: 2001 });
  });

  test("a block with no playerFlags leaves resting alone rather than reading it as false", () => {
    const cache = StateCache.replay(toEvents([playerFlags(1, 0x20), selfProgress]), { seed: SEED });
    expect(cache.self.resting).toEqual({ value: true, seq: 1, ts: 2001 });
  });
});

describe("skills, talent tree, item stats, reputation", () => {
  const TS = 1_700_000_000_000;
  const selfValues = (seq: number, fields: Record<string, number | string>) => ({
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: TS + seq,
    data: { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] },
  });

  test("skill fields fold into skills(): id, name beside it, value/max, bonuses; an empty slot is no line", () => {
    const cache = StateCache.replay(
      toEvents([
        selfValues(1, {
          skill0Id: 43,
          skill0Step: 0,
          skill0Name: "Swords",
          skill0Value: 5,
          skill0Max: 20,
          skill0TempBonus: 0,
          skill0PermBonus: 0,
          skill1Id: 98,
          skill1Name: "Language: Common",
          skill1Value: 300,
          skill1Max: 300,
          skill2Id: 0,
          skill2Value: 0,
          skill2Max: 0,
        }),
        selfValues(2, { skill0Value: 7, skill0TempBonus: -1 }),
      ]),
      { seed: SEED },
    );
    const skills = cache.skills();
    expect(skills.map((s) => [s.skillId, s.name, s.value, s.max, s.tempBonus, s.seq])).toEqual([
      [43, "Swords", 7, 20, -1, 2],
      [98, "Language: Common", 300, 300, 0, 1],
    ]);
    expect(cache.skill("swords")?.value).toBe(7);
    expect(cache.skill("Language")?.skillId).toBe(98);
    expect(cache.skill(999)).toBeUndefined();
    // The name string never lands in the numeric field record.
    expect(cache.self.fields.get("skill0Name")).toBeUndefined();
    expect(cache.snapshot().skills).toHaveLength(2);
  });

  test("the login faction list, a standing change and a visible flip fold into reputation() with the client's rank", () => {
    const init = {
      seq: 1,
      opcode: "SMSG_INITIALIZE_FACTIONS",
      opcodeId: 0x122,
      ts: TS + 1,
      data: {
        count: 128,
        factions: [
          { flags: 1, visible: true, atWar: false, repListId: 5, factionId: 47, name: "Ironforge", standing: 0, base: 2500, reputation: 2500 },
          { flags: 3, visible: true, atWar: true, repListId: 9, factionId: 76, name: "Orgrimmar", standing: 0, base: -42000, reputation: -42000 },
          { flags: 0, visible: false, atWar: false, repListId: 30, factionId: 529, name: "Argent Dawn", standing: 150, base: 0, reputation: 150 },
        ],
      },
    };
    const gain = {
      seq: 2,
      opcode: "SMSG_SET_FACTION_STANDING",
      opcodeId: 0x124,
      ts: TS + 2,
      data: { showVisual: true, factions: [{ repListId: 5, factionId: 47, name: "Ironforge", standing: 600, base: 2500, reputation: 3100 }] },
    };
    const visible = { seq: 3, opcode: "SMSG_SET_FACTION_VISIBLE", opcodeId: 0x123, ts: TS + 3, data: { repListId: 30, factionId: 529, name: "Argent Dawn" } };
    const cache = StateCache.replay(toEvents([init, gain, visible]), { seed: SEED });
    const rep = cache.reputation();
    expect(rep.map((r) => [r.name, r.reputation, r.rank, r.visible, r.seq])).toEqual([
      ["Argent Dawn", 150, "Neutral", true, 3],
      ["Ironforge", 3100, "Friendly", true, 2],
      ["Orgrimmar", -42000, "Hated", true, 1],
    ]);
    expect(cache.reputationWith(47)?.standing).toBe(600);
    expect(cache.reputationWith("orgrimmar")?.atWar).toBe(true);
    expect(cache.reputationWith("nowhere")).toBeUndefined();
    expect(cache.snapshot().reputation).toHaveLength(3);
    // A module that served no base leaves reputation = standing.
    const bare = StateCache.replay(
      toEvents([{ ...init, data: { count: 128, factions: [{ repListId: 5, standing: 9000 }] } }]),
      { seed: SEED },
    );
    expect(bare.reputation()[0]).toMatchObject({ repListId: 5, factionId: undefined, reputation: 9000, rank: "Honored", visible: false });
  });

  test("reputationRank buckets at the client's thresholds", () => {
    expect([-42001, -6000, -3000, -1, 0, 2999, 3000, 9000, 21000, 42000].map(reputationRank)).toEqual([
      "Hated", "Hostile", "Unfriendly", "Unfriendly", "Neutral", "Neutral", "Friendly", "Honored", "Revered", "Exalted",
    ]);
  });

  test("WB_TALENT_TREE is talentTree(), with pointsSpent merged from the latest SMSG_TALENTS_INFO", () => {
    const tree = {
      seq: 1,
      opcode: "WB_TALENT_TREE",
      opcodeId: 0xff08,
      ts: TS + 1,
      data: {
        class: 1,
        unspentPoints: 2,
        tabs: [
          {
            tabId: 161,
            name: "Arms",
            page: 0,
            talents: [
              { talentId: 124, name: "Improved Heroic Strike", row: 0, col: 0, maxRank: 3, ranks: [12282, 12663, 12664] },
              { talentId: 128, name: "Deflection", row: 0, col: 1, maxRank: 5, ranks: [16462, 16463, 16464, 16465, 16466] },
              { talentId: 121, name: "Tactical Mastery", row: 1, col: 1, maxRank: 3, ranks: [12295, 12676, 12677], dependsOn: 128, dependsOnRank: 2 },
            ],
          },
          { tabId: 164, name: "Fury", page: 1, talents: [] },
        ],
      },
    };
    const talents = (seq: number, rows: { talentId: number; rank: number }[], unspent: number) => ({
      seq,
      opcode: "SMSG_TALENTS_INFO",
      opcodeId: 0x4c0,
      ts: TS + seq,
      data: { pet: false, unspentPoints: unspent, specCount: 1, activeSpec: 0, specs: [{ talents: rows }] },
    });
    expect(StateCache.replay([], { seed: SEED }).talentTree()).toBeUndefined();
    const cache = StateCache.replay(toEvents([tree, talents(2, [{ talentId: 124, rank: 1 }], 1)]), { seed: SEED });
    const t = cache.talentTree()!;
    expect(t.class).toBe(1);
    expect(t.unspentPoints).toBe(1);
    expect(t.tabs.map((tab) => [tab.name, tab.pointsSpent])).toEqual([["Arms", 2], ["Fury", 0]]);
    expect(t.tabs[0]!.talents.map((x) => [x.talentId, x.pointsSpent, x.dependsOn])).toEqual([
      [124, 2, undefined],
      [128, 0, undefined],
      [121, 0, 128],
    ]);
    expect(cache.snapshot().talentTree?.tabs).toHaveLength(2);
  });

  test("the item query's tooltip fields land on ItemInfo, and an old module's short answer still does", () => {
    const full = {
      seq: 1,
      opcode: "SMSG_ITEM_QUERY_SINGLE_RESPONSE",
      opcodeId: 0x058,
      ts: TS + 1,
      data: {
        itemId: 2028,
        found: true,
        name: "Wooden Mallet",
        quality: 1,
        inventoryType: 17,
        buyPrice: 205,
        sellPrice: 41,
        itemLevel: 6,
        requiredLevel: 1,
        class: 2,
        subClass: 5,
        requiredSkill: 160,
        requiredSkillRank: 1,
        requiredSkillName: "Two-Handed Maces",
        maxCount: 0,
        stackable: 1,
        containerSlots: 0,
        stats: [{ type: 4, value: 1 }],
        damage: [{ min: 8, max: 13, type: 0 }],
        armor: 0,
        speedMs: 2800,
        spells: [],
        bonding: 0,
        maxDurability: 40,
      },
    };
    const cache = StateCache.replay(toEvents([full]), { seed: SEED });
    const info = cache.items.get(2028)?.value;
    expect(info).toMatchObject({
      name: "Wooden Mallet",
      class: 2,
      subClass: 5,
      requiredSkill: { id: 160, rank: 1, name: "Two-Handed Maces" },
      requiredReputation: undefined,
      stats: [{ type: 4, value: 1 }],
      damage: [{ min: 8, max: 13, type: 0 }],
      speedMs: 2800,
      maxDurability: 40,
    });
    const short = { ...full, data: { itemId: 2028, found: true, name: "Wooden Mallet", quality: 1 } };
    const old = StateCache.replay(toEvents([short]), { seed: SEED });
    expect(old.items.get(2028)?.value).toMatchObject({ name: "Wooden Mallet", stats: undefined, damage: undefined, requiredSkill: undefined });
  });
});

describe("pets, group, mail, bank, trade", () => {
  const TS = 1_700_000_000_000;
  const PET_GUID = "17365880163140632999";
  const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
  const petCreate = (seq: number) =>
    frame(seq, "SMSG_UPDATE_OBJECT", {
      blocks: 1,
      objects: [
        {
          update: "create",
          guid: PET_GUID,
          objectType: "unit",
          pos: { x: -1201, y: 981, z: 42, o: 0 },
          fields: { entry: 416, health: 80, maxHealth: 90, level: 3, power1: 100, maxPower1: 120, powerType: 0, petNumber: 77, summonedByGuid: SELF_GUID, createdByGuid: SELF_GUID },
        },
      ],
    });
  const petBar = (seq: number) =>
    frame(seq, "SMSG_PET_SPELLS", {
      guid: PET_GUID,
      removed: false,
      family: 0,
      durationMs: 0,
      reactState: 1,
      commandState: 1,
      flags: 0,
      actionBar: [
        { slot: 0, type: 7, command: 2 },
        { slot: 1, type: 7, command: 1 },
        { slot: 2, type: 7, command: 0 },
        { slot: 3, type: 0xc1, spellId: 3110, autocast: true, rank: 1, name: "Firebolt" },
        { slot: 7, type: 6, reaction: 2 },
      ],
      spells: [
        { spellId: 3110, active: 0xc1, autocast: true, rank: 1, name: "Firebolt" },
        { spellId: 4511, active: 0x01, autocast: false, name: "Phase Shift" },
      ],
      cooldowns: [{ spellId: 3110, category: 0, cooldownMs: 1500, categoryCooldownMs: 0 }],
    });

  test("the control bar joins the pet's unit, its creature name and its given name into pet(); the removal clears it", () => {
    const cache = StateCache.replay(
      toEvents([
        ...loginSequence,
        petCreate(10),
        frame(11, "SMSG_CREATURE_QUERY_RESPONSE", { entry: 416, found: true, name: "Imp", subname: "" }),
        frame(12, "SMSG_PET_NAME_QUERY_RESPONSE", { petNumber: 77, found: true, name: "Zilkip" }),
        petBar(13),
      ]),
      { seed: SEED },
    );
    const pet = cache.pet();
    expect(pet).toMatchObject({
      guid: PET_GUID,
      name: "Zilkip",
      creatureName: "Imp",
      entry: 416,
      level: 3,
      health: 80,
      maxHealth: 90,
      power: 100,
      maxPower: 120,
      dead: false,
      inView: true,
      reaction: "defensive",
      command: "follow",
      seq: 13,
    });
    expect(pet!.spells.map((s) => [s.spellId, s.name, s.autocast, s.passive])).toEqual([
      [3110, "Firebolt", true, false],
      [4511, "Phase Shift", false, true],
    ]);
    expect(cache.petSpell("fire")?.spellId).toBe(3110);
    expect(cache.petSpell(4511)?.name).toBe("Phase Shift");
    expect(cache.nearbyUnits().find((u) => u.guid === PET_GUID)?.ownerGuid?.value).toBe(SELF_GUID);
    expect(cache.units().find((u) => u.guid === PET_GUID)?.ownerGuid).toBe(SELF_GUID);
    expect(cache.snapshot().pet?.name).toBe("Zilkip");

    cache.apply(toEvents([frame(14, "SMSG_PET_SPELLS", { guid: "0", removed: true })])[0]!);
    expect(cache.pet()).toBeUndefined();
    expect(cache.petSpell("fire")).toBeUndefined();
  });

  test("a bar for a pet not yet in view still reads, with inView false and nothing invented", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, petBar(5)]), { seed: SEED });
    expect(cache.pet()).toMatchObject({ guid: PET_GUID, inView: false, name: undefined, health: undefined, level: undefined });
  });

  test("invite, list, leader change, decline, result and destroy fold into group()", () => {
    const cache = StateCache.replay(toEvents([...loginSequence]), { seed: SEED });
    expect(cache.group()).toBeUndefined();
    const fold = (f: unknown) => cache.apply(toEvents([f])[0]!);
    fold(frame(20, "SMSG_GROUP_INVITE", { canAccept: true, inviterName: "Ordrick" }));
    expect(cache.group()).toMatchObject({ inGroup: false, pendingInvite: { inviterName: "Ordrick", seq: 20 } });
    fold(
      frame(21, "SMSG_GROUP_LIST", {
        groupType: 0,
        left: false,
        raid: false,
        subGroup: 0,
        memberFlags: 0,
        roles: 0,
        groupGuid: "1",
        counter: 1,
        members: [{ name: "Ordrick", guid: "9", online: true, subGroup: 0, flags: 0, roles: 0 }],
        leaderGuid: "9",
        lootMethod: 0,
        looterGuid: "0",
        lootThreshold: 2,
        dungeonDifficulty: 0,
        raidDifficulty: 0,
      }),
    );
    expect(cache.group()).toMatchObject({ inGroup: true, leaderGuid: "9", leaderName: "Ordrick", leader: false, pendingInvite: undefined, lootMethod: 0 });
    expect(cache.group()!.members).toEqual([{ guid: "9", name: "Ordrick", online: true, subGroup: 0, assistant: false, leader: true }]);
    fold(frame(22, "SMSG_GROUP_SET_LEADER", { name: "Fenwick" }));
    expect(cache.group()).toMatchObject({ leader: true, leaderName: "Fenwick", leaderGuid: SELF_GUID });
    expect(cache.group()!.members[0]!.leader).toBe(false);
    fold(frame(23, "SMSG_PARTY_COMMAND_RESULT", { operation: 0, name: "Quilby", result: 5, value: 0 }));
    expect(cache.group()!.lastResult).toMatchObject({ result: 5, text: "that player is already in a group", name: "Quilby" });
    fold(frame(24, "SMSG_GROUP_DECLINE", { name: "Quilby" }));
    expect(cache.group()!.lastDecline?.name).toBe("Quilby");
    fold(frame(25, "SMSG_GROUP_LIST", { groupType: 0x10, left: true, raid: false, subGroup: 0, memberFlags: 0, roles: 0, groupGuid: "1", counter: 2, members: [], leaderGuid: "0" }));
    expect(cache.group()).toMatchObject({ inGroup: false, members: [], leaderGuid: undefined, seq: 25 });
    fold(frame(26, "SMSG_GROUP_DESTROYED", {}));
    expect(cache.group()!.inGroup).toBe(false);
  });

  test("the mailbox frame, the inbox with joined names, new-mail, and the verdicts edit the list the way the client does", () => {
    const cache = StateCache.replay(
      toEvents([
        ...loginSequence,
        nameQuery,
        frame(30, "SMSG_SHOW_MAILBOX", { guid: "555" }),
        frame(31, "SMSG_MAIL_LIST_RESULT", {
          total: 1,
          count: 1,
          mails: [
            {
              mailId: 42,
              type: 0,
              senderGuid: "9",
              cod: 0,
              stationery: 41,
              money: 300,
              flags: 0,
              read: false,
              daysLeft: 29.9,
              templateId: 0,
              subject: "hello",
              body: "a body",
              items: [{ index: 0, itemGuidLow: 4321, itemId: ITEM_ENTRY, count: 2 }],
            },
          ],
        }),
        itemQuery,
      ]),
      { seed: SEED },
    );
    let box = cache.mailbox()!;
    expect(box.guid).toBe("555");
    expect(box.mails[0]).toMatchObject({ mailId: 42, senderName: "Ordrick", money: 300, subject: "hello" });
    expect(box.mails[0]!.items[0]!.name).toBeDefined();
    const fold = (f: unknown) => cache.apply(toEvents([f])[0]!);
    fold(frame(40, "SMSG_RECEIVED_MAIL", {}));
    expect(cache.mailbox()!.newMail).toBe(true);
    fold(frame(41, "SMSG_SEND_MAIL_RESULT", { mailId: 42, action: 1, result: 0 }));
    box = cache.mailbox()!;
    expect(box.mails[0]!.money).toBe(0);
    expect(box.lastResult).toMatchObject({ action: 1, result: 0, text: "ok" });
    fold(frame(42, "SMSG_SEND_MAIL_RESULT", { mailId: 42, action: 2, result: 0, itemGuidLow: 4321, count: 2 }));
    expect(cache.mailbox()!.mails[0]!.items).toEqual([]);
    fold(frame(43, "SMSG_SEND_MAIL_RESULT", { mailId: 42, action: 4, result: 0 }));
    expect(cache.mailbox()!.mails).toEqual([]);
    fold(frame(44, "SMSG_SEND_MAIL_RESULT", { mailId: 0, action: 0, result: 3 }));
    expect(cache.mailbox()!.lastResult).toMatchObject({ result: 3, text: "not enough money" });
    expect(cache.snapshot().mailbox?.total).toBe(1);
  });

  test("bank slots 39-73 fold into bank() and stay out of bag(); the frame's banker rides along", () => {
    const selfValues = (seq: number, fields: Record<string, number>) => frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] });
    const cache = StateCache.replay(
      toEvents([
        ...loginSequence,
        selfValues(50, { invSlot40Lo: ITEM_GUID_LO, invSlot40Hi: ITEM_GUID_HI, invSlot67Lo: BAG_GUID_LO, invSlot67Hi: BAG_GUID_HI }),
        itemCreate,
        itemQuery,
        wornBagCreate,
        wornBagQuery,
        frame(60, "SMSG_SHOW_BANK", { guid: "777" }),
      ]),
      { seed: SEED },
    );
    const bank = cache.bank();
    expect(bank.guid).toBe("777");
    expect(bank.items.map((i) => [i.bag, i.slot, i.guid, i.itemId])).toEqual([
      [255, 40, ITEM_GUID, ITEM_ENTRY],
      [67, 2, BAGGED_GUID, ITEM_ENTRY],
    ]);
    expect(bank.bags).toEqual([{ slot: 67, numSlots: BAG_NUM_SLOTS, name: expect.any(String) }]);
    expect(bank.totalSlots).toBe(28 + BAG_NUM_SLOTS);
    expect(bank.freeSlots).toBe(28 + BAG_NUM_SLOTS - 2);
    expect(cache.bag().items).toEqual([]);
    expect(cache.inventory.map((i) => i.slot)).toEqual([40, 67]);
    expect(cache.snapshot().bank.items).toHaveLength(2);
  });

  test("trade status and both sides of the window fold into trade(); a cancel closes it", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, itemQuery]), { seed: SEED });
    const fold = (f: unknown) => cache.apply(toEvents([f])[0]!);
    fold(frame(70, "SMSG_TRADE_STATUS", { status: 1, traderGuid: "9" }));
    expect(cache.trade()).toMatchObject({ status: 1, statusText: "begin trade", open: false, traderGuid: "9" });
    fold(frame(71, "SMSG_TRADE_STATUS", { status: 2 }));
    expect(cache.trade()).toMatchObject({ open: true, traderGuid: "9" });
    fold(frame(72, "SMSG_TRADE_STATUS_EXTENDED", { theirs: true, money: 500, spellId: 0, items: [{ slot: 0, itemId: ITEM_ENTRY, count: 1, wrapped: false }] }));
    fold(frame(73, "SMSG_TRADE_STATUS_EXTENDED", { theirs: false, money: 0, spellId: 0, items: [] }));
    const t = cache.trade()!;
    expect(t.theirs).toMatchObject({ money: 500 });
    expect(t.theirs!.items[0]!.name).toBeDefined();
    expect(t.mine).toMatchObject({ money: 0, items: [] });
    fold(frame(74, "SMSG_TRADE_STATUS", { status: 3 }));
    expect(cache.trade()).toMatchObject({ open: false, statusText: "trade canceled", mine: undefined, theirs: undefined });
  });
});
