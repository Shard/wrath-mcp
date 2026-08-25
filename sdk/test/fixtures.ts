/**
 * Synthetic protocol fixtures.
 *
 * Every one of these is hand-written from the tables in module/PROTOCOL.md.
 * Nothing here is captured from a running game: no real character names, no
 * server MOTD text, no game strings (CLAUDE.md — nothing Blizzard-derived
 * enters git). The names are invented.
 */

/** Frames as they appear on the wire: JSON objects, one per WebSocket frame. */
export const loginSequence: unknown[] = [
  { seq: 0, opcode: "SMSG_AUTH_RESPONSE", opcodeId: 0x1ee, ts: 1_700_000_000_000, data: { code: 12 } },
  {
    seq: 1,
    opcode: "SMSG_CHAR_ENUM",
    opcodeId: 0x03b,
    ts: 1_700_000_000_010,
    data: {
      count: 2,
      characters: [
        { guid: 7, name: "Fenwick", race: 1, class: 1, gender: 0, level: 3 },
        { guid: 8, name: "Quilby", race: 4, class: 3, gender: 1, level: 11 },
      ],
    },
  },
  {
    seq: 2,
    opcode: "SMSG_LOGIN_VERIFY_WORLD",
    opcodeId: 0x236,
    ts: 1_700_000_000_020,
    data: { map: 0, x: -1234.5, y: 987.25, z: 42.125, o: 3.5 },
  },
  {
    seq: 3,
    opcode: "SMSG_MOTD",
    opcodeId: 0x33d,
    ts: 1_700_000_000_030,
    data: { lineCount: 2, lines: ["fixture line one", "fixture line two"] },
  },
];

export const chatEcho = {
  seq: 4,
  opcode: "SMSG_MESSAGECHAT",
  opcodeId: 0x096,
  ts: 1_700_000_000_040,
  data: { type: 1, language: 7, senderGuid: 7, message: "ping from the fixture", chatTag: 0 },
};

export const nameQuery = {
  seq: 5,
  opcode: "SMSG_NAME_QUERY_RESPONSE",
  opcodeId: 0x051,
  ts: 1_700_000_000_050,
  data: { guid: 9, found: true, name: "Ordrick" },
};

export const nameQueryMiss = {
  seq: 6,
  opcode: "SMSG_NAME_QUERY_RESPONSE",
  opcodeId: 0x051,
  ts: 1_700_000_000_060,
  data: { guid: 10, found: false },
};

export const notification = {
  seq: 7,
  opcode: "SMSG_NOTIFICATION",
  opcodeId: 0x1cb,
  ts: 1_700_000_000_070,
  data: { text: "fixture notification" },
};

/** A whitelisted packet the module could not decode. Still emitted. */
export const undecodableChat = {
  seq: 8,
  opcode: "SMSG_MESSAGECHAT",
  opcodeId: 0x096,
  ts: 1_700_000_000_080,
  data: { decodeError: true },
};

/** A whitelisted opcode whose `data` does not match this SDK's schema. */
export const malformedChat = {
  seq: 9,
  opcode: "SMSG_MESSAGECHAT",
  opcodeId: 0x096,
  ts: 1_700_000_000_090,
  data: { type: 1, language: 7 },
};

/**
 * An opcode added to the whitelist after this SDK revision was written. Not one
 * of the movement/observation opcodes any more — those are known now — so it is
 * an action-set opcode a later increment will bring.
 */
export const futureOpcode = {
  seq: 10,
  opcode: "SMSG_TRAINER_LIST",
  opcodeId: 0x1b1,
  ts: 1_700_000_000_100,
  data: { count: 1, spells: [{ spellId: 4242 }] },
};

/** The full ordered fixture stream, seq 0..10. */
export const fullStream: unknown[] = [
  ...loginSequence,
  chatEcho,
  nameQuery,
  nameQueryMiss,
  notification,
  undecodableChat,
  malformedChat,
  futureOpcode,
];

// ------------------------------------------ movement / observation extension
//
// Guids here are written the way the module writes them: decimal *strings*.
// `CREATURE_GUID` is a real-shaped 3.3.5a creature guid (high part 0xF130…),
// which is above 2^63 and therefore the exact value a JSON number would ruin.

export const CREATURE_GUID = "17365880163140632581";
export const PLAYER_GUID = "8";
export const SELF_GUID = "7";
/** Invented; nothing here is a real creature entry or a real creature name. */
export const CREATURE_ENTRY = 90210;

/** A create block for a nearby creature: type, position, and the unit fields. */
export const creatureCreate = {
  seq: 11,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_110,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: CREATURE_GUID,
        objectType: "unit",
        moveFlags: 0,
        runSpeed: 7.5,
        pos: { x: -1200.0, y: 980.0, z: 42.0, o: 1.5 },
        fields: {
          entry: CREATURE_ENTRY,
          health: 120,
          maxHealth: 120,
          level: 4,
          faction: 7,
          unitFlags: 0,
          displayId: 111,
          powerType: 0,
          power1: 50,
          maxPower1: 100,
          race: 0,
          class: 0,
          gender: 0,
        },
      },
    ],
  },
};

/** The answer to the creature query the module fired on first sight. */
export const creatureQuery = {
  seq: 12,
  opcode: "SMSG_CREATURE_QUERY_RESPONSE",
  opcodeId: 0x061,
  ts: 1_700_000_000_120,
  data: { entry: CREATURE_ENTRY, found: true, name: "Thistlebore", subname: "", type: 1, rank: 0 },
};

/** A sparse delta: it lost health, and nothing else changed. */
export const creatureValues = {
  seq: 13,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_130,
  data: {
    blocks: 1,
    objects: [{ update: "values", guid: CREATURE_GUID, fields: { health: 60 } }],
  },
};

/** Another unit moved; only nearby positions come from these. */
export const creatureMove = {
  seq: 14,
  opcode: "MSG_MOVE_HEARTBEAT",
  opcodeId: 0x0ee,
  ts: 1_700_000_000_140,
  data: { guid: CREATURE_GUID, flags: 1, pos: { x: -1210.0, y: 985.0, z: 42.0, o: 2.0 } },
};

/** Left update range. */
export const creatureOutOfRange = {
  seq: 15,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_150,
  data: { blocks: 1, objects: [{ update: "outOfRange", guids: [CREATURE_GUID] }] },
};

/** Destroyed (killed, despawned, or gone for any client-visible reason). */
export const creatureDestroy = {
  seq: 16,
  opcode: "SMSG_DESTROY_OBJECT",
  opcodeId: 0x0aa,
  ts: 1_700_000_000_160,
  data: { guid: CREATURE_GUID, onDeath: true },
};

/** Our own create block, the only one flagged `self`. */
export const selfCreate = {
  seq: 17,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_170,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: SELF_GUID,
        objectType: "player",
        self: true,
        moveFlags: 0,
        runSpeed: 7.0,
        pos: { x: -1234.5, y: 987.25, z: 42.125, o: 3.5 },
        fields: {
          entry: 0,
          health: 80,
          maxHealth: 100,
          level: 3,
          powerType: 0,
          power1: 40,
          maxPower1: 90,
          playerFlags: 0,
        },
      },
    ],
  },
};

export const moveProgress = {
  seq: 18,
  opcode: "WB_MOVE_PROGRESS",
  opcodeId: 0xff02,
  ts: 1_700_000_000_180,
  data: { moveId: 1, pos: { x: -1220.0, y: 985.0, z: 42.0, o: 1.0 } },
};

export function moveResult(status: string, moveId = 1, seq = 19): unknown {
  return {
    seq,
    opcode: "WB_MOVE_RESULT",
    opcodeId: 0xff01,
    ts: 1_700_000_000_190,
    data: { moveId, status, pos: { x: -1205.0, y: 981.0, z: 42.0, o: 1.2 } },
  };
}

/**
 * The server's side of a same-map teleport (Player::SendTeleportAckPacket),
 * tapped under our own guid with the arrival point. Sent before the
 * `teleported` move result; no SMSG_NEW_WORLD follows.
 */
export function teleportAck(seq = 40, pos = { x: -8833.4, y: 625.9, z: 93.9, o: 0.5 }): unknown {
  return {
    seq,
    opcode: "MSG_MOVE_TELEPORT_ACK",
    opcodeId: 0x0c7,
    ts: 1_700_000_000_400,
    data: { guid: SELF_GUID, flags: 0, pos },
  };
}

export function transferPending(toMap: number, seq = 40): unknown {
  return { seq, opcode: "SMSG_TRANSFER_PENDING", opcodeId: 0x03f, ts: 1_700_000_000_400, data: { map: toMap } };
}
export function newWorld(map: number, seq = 41, pos = { x: 69.25, y: 10.26, z: -4.3, o: 3.1 }): unknown {
  return { seq, opcode: "SMSG_NEW_WORLD", opcodeId: 0x03e, ts: 1_700_000_000_410, data: { map, ...pos } };
}
export function transferAborted(map: number, reason: number, seq = 41): unknown {
  return { seq, opcode: "SMSG_TRANSFER_ABORTED", opcodeId: 0x040, ts: 1_700_000_000_410, data: { map, reason } };
}

/** A player create block, named by a name query rather than a creature query. */
export const playerCreate = {
  seq: 20,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_200,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: PLAYER_GUID,
        objectType: "player",
        pos: { x: -1240.0, y: 990.0, z: 42.0, o: 0.5 },
        fields: { health: 200, maxHealth: 200, level: 11 },
      },
    ],
  },
};

export const playerName = {
  seq: 21,
  opcode: "SMSG_NAME_QUERY_RESPONSE",
  opcodeId: 0x051,
  ts: 1_700_000_000_210,
  data: { guid: PLAYER_GUID, found: true, name: "Quilby" },
};

/** Login, then our own create block: the ordinary start of an observed world. */
export const worldStream: unknown[] = [
  ...loginSequence,
  selfCreate,
  creatureCreate,
  creatureQuery,
  creatureValues,
];

// ---------------------------------------------- quest / combat extension
//
// Same rule as everything above: hand-written from PROTOCOL.md's tables. The
// quest ids, item ids and names are invented, so nothing here is a game string.

/** An invented quest id, and the four-objective packed counters it carries. */
export const QUEST_ID = 4242;
export const OTHER_QUEST_ID = 909;
export const ITEM_ENTRY = 55501;
/**
 * An item guid with a non-zero high half: the halves arrive as two u32 update
 * fields, so this is what proves the cache reassembles rather than truncates.
 */
export const ITEM_GUID_LO = 4321;
export const ITEM_GUID_HI = 0x4000_0000;
export const ITEM_GUID = ((BigInt(ITEM_GUID_HI) << 32n) | BigInt(ITEM_GUID_LO)).toString();
/** Backpack slot 23, the first one the module serves as `invSlot23Lo/Hi`. */
export const BACKPACK_SLOT = 23;

function selfFields(seq: number, fields: Record<string, number>, ts = 1_700_000_000_000 + seq): unknown {
  return {
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts,
    data: { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] },
  };
}

/** Quest accepted: slot 0 occupied, no progress, nothing complete. Slot 1 empty. */
export const questAccepted = selfFields(30, {
  quest0Id: QUEST_ID,
  quest0State: 0,
  quest0CountsLo: 0,
  quest0CountsHi: 0,
  quest0Time: 0,
  quest1Id: 0,
});

/**
 * Progress on the first two objectives. The 3.3.5 layout packs two u16
 * counters per u32, so `CountsLo` holds objectives 0 and 1 and `CountsHi`
 * holds 2 and 3.
 */
export const questProgress = selfFields(31, {
  quest0CountsLo: 3 | (5 << 16),
  quest0CountsHi: 7 | (9 << 16),
});

/** The completion bit. The only thing that reports a finished kill objective. */
export const questComplete = selfFields(32, { quest0State: 1 });

/** A second quest in slot 1, as a turn-in chain's auto-advance would add it. */
export const questChained = selfFields(33, {
  quest1Id: OTHER_QUEST_ID,
  quest1State: 0,
  quest1CountsLo: 0,
  quest1CountsHi: 0,
});

/** Self-only progress fields: coinage and the XP bar. */
export const selfProgress = selfFields(34, { money: 12345, xp: 480, nextLevelXp: 2100, level: 4 });

/** What the client shows as selected. */
export const selfTarget = {
  seq: 35,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_350,
  data: {
    blocks: 1,
    objects: [{ update: "values", guid: SELF_GUID, fields: { targetGuid: CREATURE_GUID } }],
  },
};

/** An occupied backpack slot: two u32 halves of one item guid. */
export const inventorySlot = selfFields(36, {
  [`invSlot${BACKPACK_SLOT}Lo`]: ITEM_GUID_LO,
  [`invSlot${BACKPACK_SLOT}Hi`]: ITEM_GUID_HI,
  invSlot24Lo: 0,
  invSlot24Hi: 0,
});

/** The item's own create block: where the slot's guid gets an entry. */
export const itemCreate = {
  seq: 37,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_370,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: ITEM_GUID,
        objectType: "item",
        fields: { entry: ITEM_ENTRY, stackCount: 5 },
      },
    ],
  },
};

/**
 * A worn bag in equipment slot 19 (FOLLOW-UPS 50): the player's `invSlot19`
 * halves name the container, the container's own create block carries
 * `numSlots` and its `bagSlot<n>Lo/Hi` halves, and one of those names a second
 * copy of the charm. Guid high halves are non-zero to prove reassembly.
 */
export const BAG_SLOT = 19;
export const BAG_GUID_LO = 777;
export const BAG_GUID_HI = 0x4000_0000;
export const BAG_GUID = ((BigInt(BAG_GUID_HI) << 32n) | BigInt(BAG_GUID_LO)).toString();
export const BAG_ENTRY = 4496;
export const BAG_NUM_SLOTS = 6;
export const BAGGED_GUID_LO = 9999;
export const BAGGED_GUID_HI = 0x4000_0000;
export const BAGGED_GUID = ((BigInt(BAGGED_GUID_HI) << 32n) | BigInt(BAGGED_GUID_LO)).toString();
export const wornBagSlot = selfFields(36, {
  [`invSlot${BAG_SLOT}Lo`]: BAG_GUID_LO,
  [`invSlot${BAG_SLOT}Hi`]: BAG_GUID_HI,
});
export const wornBagCreate = {
  seq: 37,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_371,
  data: {
    blocks: 2,
    objects: [
      {
        update: "create",
        guid: BAG_GUID,
        objectType: "container",
        fields: {
          entry: BAG_ENTRY,
          numSlots: BAG_NUM_SLOTS,
          bagSlot0Lo: 0,
          bagSlot0Hi: 0,
          bagSlot2Lo: BAGGED_GUID_LO,
          bagSlot2Hi: BAGGED_GUID_HI,
        },
      },
      {
        update: "create",
        guid: BAGGED_GUID,
        objectType: "item",
        fields: { entry: ITEM_ENTRY, stackCount: 2 },
      },
    ],
  },
};
export const wornBagQuery = {
  seq: 38,
  opcode: "SMSG_ITEM_QUERY_SINGLE_RESPONSE",
  opcodeId: 0x058,
  ts: 1_700_000_000_381,
  data: { itemId: BAG_ENTRY, found: true, name: "Small Brown Pouch", quality: 1 },
};

/** The item query the module fired on first sight of that entry. */
export const itemQuery = {
  seq: 38,
  opcode: "SMSG_ITEM_QUERY_SINGLE_RESPONSE",
  opcodeId: 0x058,
  ts: 1_700_000_000_380,
  data: { itemId: ITEM_ENTRY, found: true, name: "Gritstone Charm", quality: 1, sellPrice: 40 },
};

/** Two aura slots on the creature. */
export const auraUpdate = {
  seq: 39,
  opcode: "SMSG_AURA_UPDATE",
  opcodeId: 0x496,
  ts: 1_700_000_000_390,
  data: {
    targetGuid: CREATURE_GUID,
    auras: [
      { slot: 0, spellId: 7777, flags: 0x20, level: 4, stacks: 1, duration: 12000, maxDuration: 15000 },
      { slot: 1, spellId: 8888, flags: 0, level: 4, stacks: 3 },
    ],
  },
};

/** Slot 0 cleared; slot 1 untouched, and must survive. */
export const auraRemoved = {
  seq: 40,
  opcode: "SMSG_AURA_UPDATE",
  opcodeId: 0x496,
  ts: 1_700_000_000_400,
  data: { targetGuid: CREATURE_GUID, auras: [{ slot: 0, spellId: 0, removed: true }] },
};

/** The full visible list: replaces whatever was there. */
export const auraUpdateAll = {
  seq: 41,
  opcode: "SMSG_AURA_UPDATE_ALL",
  opcodeId: 0x495,
  ts: 1_700_000_000_410,
  data: { targetGuid: CREATURE_GUID, auras: [{ slot: 4, spellId: 9999, flags: 0, stacks: 1 }] },
};

/** A creature walking: destination and duration only, never the spline. */
export const monsterMove = {
  seq: 42,
  opcode: "SMSG_MONSTER_MOVE",
  opcodeId: 0x0dd,
  ts: 1_700_000_000_420,
  data: {
    guid: CREATURE_GUID,
    pos: { x: -1210.0, y: 985.0, z: 42.0 },
    destination: { x: -1190.0, y: 970.0, z: 42.0 },
    durationMs: 2000,
  },
};

export const monsterStopped = {
  seq: 43,
  opcode: "SMSG_MONSTER_MOVE",
  opcodeId: 0x0dd,
  ts: 1_700_000_000_430,
  data: { guid: CREATURE_GUID, pos: { x: -1195.0, y: 972.0, z: 42.0 }, stopped: true },
};

/** A kill credit toward one objective. */
export const addKill = {
  seq: 44,
  opcode: "SMSG_QUESTUPDATE_ADD_KILL",
  opcodeId: 0x199,
  ts: 1_700_000_000_440,
  data: { questId: QUEST_ID, entry: CREATURE_ENTRY, current: 3, required: 8, guid: CREATURE_GUID },
};

/** The quest list as a *gossip*-flagged questgiver answers it. */
export function gossipWithQuests(questIds: readonly number[], seq = 45): unknown {
  return {
    seq,
    opcode: "SMSG_GOSSIP_MESSAGE",
    opcodeId: 0x17d,
    ts: 1_700_000_000_450,
    data: {
      guid: CREATURE_GUID,
      menuId: 3,
      textId: 9,
      options: [{ optionId: 0, icon: 0, text: "fixture option" }],
      quests: questIds.map((questId) => ({ questId, icon: 2, level: 3, title: `fixture quest ${questId}` })),
    },
  };
}

/** The same list as a plain questgiver answers it. */
export function questGiverList(questIds: readonly number[], seq = 46): unknown {
  return {
    seq,
    opcode: "SMSG_QUESTGIVER_QUEST_LIST",
    opcodeId: 0x185,
    ts: 1_700_000_000_460,
    data: {
      guid: CREATURE_GUID,
      greeting: "fixture greeting",
      quests: questIds.map((questId) => ({
        questId,
        icon: 2,
        level: 3,
        repeatable: false,
        title: `fixture quest ${questId}`,
      })),
    },
  };
}

export function offerReward(questId: number, seq = 47): unknown {
  return {
    seq,
    opcode: "SMSG_QUESTGIVER_OFFER_REWARD",
    opcodeId: 0x18d,
    ts: 1_700_000_000_470,
    data: {
      guid: CREATURE_GUID,
      questId,
      title: "fixture quest",
      text: "fixture reward text",
      choiceRewards: [{ itemId: ITEM_ENTRY, count: 1 }],
      rewards: [],
      money: 250,
      xp: 400,
    },
  };
}

export function requestItems(questId: number, completable: boolean, seq = 48): unknown {
  return {
    seq,
    opcode: "SMSG_QUESTGIVER_REQUEST_ITEMS",
    opcodeId: 0x18b,
    ts: 1_700_000_000_480,
    data: {
      guid: CREATURE_GUID,
      questId,
      title: "fixture quest",
      text: "fixture request text",
      requiredMoney: 0,
      requiredItems: [],
      completable,
    },
  };
}

export function questRewarded(questId: number, seq = 49): unknown {
  return {
    seq,
    opcode: "SMSG_QUESTGIVER_QUEST_COMPLETE",
    opcodeId: 0x191,
    ts: 1_700_000_000_490,
    data: { questId, xp: 400, money: 250 },
  };
}

/** `result` 48 is EQUIP_ERR_INVENTORY_FULL, the bag-full refusal. */
export function inventoryChangeFailure(
  seq: number,
  result = 48,
  extra: { itemGuid?: string; requiredLevel?: number } = {},
): unknown {
  return {
    seq,
    opcode: "SMSG_INVENTORY_CHANGE_FAILURE",
    opcodeId: 0x112,
    ts: 1_700_000_000_495,
    data: { result, ...extra },
  };
}

/** The source slot zeroed with no arrival seen: the item left the backpack. */
export function inventorySlotCleared(seq: number, slot: number): unknown {
  return selfFields(seq, { [`invSlot${slot}Lo`]: 0, [`invSlot${slot}Hi`]: 0 });
}

/**
 * The character's own inventory fields after the server moved `ITEM_GUID` from
 * one slot to another — what an accepted equip looks like on the wire (the old
 * slot zeroed, the equipment slot carrying the guid halves).
 */
export function inventorySlotMove(seq: number, from: number, to: number): unknown {
  return selfFields(seq, {
    [`invSlot${from}Lo`]: 0,
    [`invSlot${from}Hi`]: 0,
    [`invSlot${to}Lo`]: ITEM_GUID_LO,
    [`invSlot${to}Hi`]: ITEM_GUID_HI,
  });
}

/** `slotType` defaults to 4 (LOOT_SLOT_TYPE_OWNER): what every solo loot carries. */
export function lootResponse(seq = 50, slotType = 4): unknown {
  return {
    seq,
    opcode: "SMSG_LOOT_RESPONSE",
    opcodeId: 0x160,
    ts: 1_700_000_000_500,
    data: {
      guid: CREATURE_GUID,
      lootType: 1,
      gold: 37,
      items: [{ slot: 0, itemId: ITEM_ENTRY, count: 1, slotType }],
    },
  };
}

/** The server confirming an item entered a bag (`received == 0` ⇒ looted). */
export function itemPushed(seq: number, itemId = ITEM_ENTRY, count = 1): unknown {
  return {
    seq,
    opcode: "SMSG_ITEM_PUSH_RESULT",
    opcodeId: 0x166,
    ts: 1_700_000_000_505,
    data: {
      playerGuid: SELF_GUID,
      itemId,
      count,
      totalCount: count,
      bagSlot: 255,
      itemSlot: 23,
      looted: true,
      created: false,
    },
  };
}

export function lootRelease(seq = 51): unknown {
  return {
    seq,
    opcode: "SMSG_LOOT_RELEASE_RESPONSE",
    opcodeId: 0x161,
    ts: 1_700_000_000_510,
    data: { guid: CREATURE_GUID },
  };
}

/** A health delta for the creature; `0` is how a client learns it died. */
export function creatureHealth(health: number, seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: 1_700_000_000_000 + seq,
    data: { blocks: 1, objects: [{ update: "values", guid: CREATURE_GUID, fields: { health } }] },
  };
}

export function selfHealth(health: number, seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    ts: 1_700_000_000_000 + seq,
    data: { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health } }] },
  };
}

/** One melee swing, in whichever direction. */
export function swing(attackerGuid: string, victimGuid: string, seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_ATTACKERSTATEUPDATE",
    opcodeId: 0x14a,
    ts: 1_700_000_000_000 + seq,
    data: {
      attackerGuid,
      victimGuid,
      hitInfo: 2,
      damage: 7,
      overkill: 0,
      absorb: 0,
      resist: 0,
      blocked: 0,
      victimState: 1,
      miss: false,
      crit: false,
    },
  };
}

/**
 * The server cancelling an auto-attack. `attackerDead: false` with a live
 * victim is the mid-fight cancel the SDK re-arms from.
 */
export function attackStopped(
  attackerGuid: string,
  victimGuid: string,
  attackerDead: boolean,
  seq: number,
): unknown {
  return {
    seq,
    opcode: "SMSG_ATTACKSTOP",
    opcodeId: 0x144,
    ts: 1_700_000_000_000 + seq,
    data: { attackerGuid, victimGuid, attackerDead },
  };
}

/** The whole quest/combat fold in one stream, for the replay property. */
export const questCombatStream: unknown[] = [
  ...worldStream,
  questAccepted,
  questProgress,
  questComplete,
  questChained,
  selfProgress,
  selfTarget,
  inventorySlot,
  itemCreate,
  itemQuery,
  auraUpdate,
  auraRemoved,
  monsterMove,
];

/**
 * A trainer's spell list. Opcode ids are the pinned core's
 * (`Opcodes.h`: SMSG_TRAINER_LIST 0x1B1, BUY_SUCCEEDED 0x1B3, BUY_FAILED 0x1B4).
 */
export function trainerList(
  spells: readonly { spellId: number; state: number; cost: number }[],
  seq = 60,
  guid: string = CREATURE_GUID,
): unknown {
  return {
    seq,
    opcode: "SMSG_TRAINER_LIST",
    opcodeId: 0x1b1,
    ts: 1_700_000_000_600,
    data: {
      guid,
      trainerType: 0,
      greeting: "fixture trainer greeting",
      spells: spells.map((s) => ({
        spellId: s.spellId,
        state: s.state,
        cost: s.cost,
        reqLevel: 4,
        reqSkill: 0,
        reqSkillValue: 0,
      })),
    },
  };
}

export function trainerBuySucceeded(spellId: number, seq = 61): unknown {
  return {
    seq,
    opcode: "SMSG_TRAINER_BUY_SUCCEEDED",
    opcodeId: 0x1b3,
    ts: 1_700_000_000_610,
    data: { guid: CREATURE_GUID, spellId },
  };
}

export function trainerBuyFailed(spellId: number, reason: number, seq = 62): unknown {
  return {
    seq,
    opcode: "SMSG_TRAINER_BUY_FAILED",
    opcodeId: 0x1b4,
    ts: 1_700_000_000_620,
    data: { guid: CREATURE_GUID, spellId, reason },
  };
}

export const sessionResponseFixture = {
  ok: true as const,
  token: "test-token",
  account: "RUNNER",
  character: "Fenwick",
  guid: 7,
  inWorld: true,
};

export const healthResponseFixture = {
  ok: true as const,
  module: "mod-wrathbench",
  worldStopped: false,
  sessions: 1,
  droppedPackets: 4213,
  droppedPacketsLive: 37,
};

export function frames(objects: readonly unknown[]): string[] {
  return objects.map((o) => JSON.stringify(o));
}

// ---------------------------------------------------------------- quest info
//
// Synthetic captures of the two packets behind FOLLOW-UPS 27/28, in the exact
// JSON shape PROTOCOL.md gives for the module's decode.

/** A kobold entry for the objectives fixture; `| 0x80000000` marks a gameobject on the wire. */
export const KOBOLD_ENTRY = 6;
export const GO_ENTRY = 1617;
export const REQUIRED_ITEM = ITEM_ENTRY;

/** `SMSG_QUESTGIVER_STATUS` for one guid. */
export function questGiverStatus(guid: string, status: number, seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_QUESTGIVER_STATUS",
    opcodeId: 0x183,
    ts: 1_700_000_000_000 + seq,
    data: { guid, status },
  };
}

/** `SMSG_QUESTGIVER_STATUS_MULTIPLE`: every questgiver in view. */
export function questGiverStatusMultiple(rows: readonly { guid: string; status: number }[], seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_QUESTGIVER_STATUS_MULTIPLE",
    opcodeId: 0x418,
    ts: 1_700_000_000_000 + seq,
    data: { statuses: rows.map((r) => ({ guid: r.guid, status: r.status })) },
  };
}

/**
 * `SMSG_QUEST_QUERY_RESPONSE` for QUEST_ID: kill 8 kobolds (objective 0),
 * use one gameobject (objective 1), an event objective (objective 2, text
 * only), and collect 4 of one item. The wire carries four npc/go slots and
 * six item slots whatever the quest uses; unused ones are zero.
 */
export function questQueryResponse(questId = QUEST_ID, seq = 60): unknown {
  return {
    seq,
    opcode: "SMSG_QUEST_QUERY_RESPONSE",
    opcodeId: 0x05d,
    ts: 1_700_000_000_000 + seq,
    data: {
      questId,
      method: 2,
      level: 3,
      minLevel: 1,
      type: 0,
      suggestedPlayers: 0,
      title: "Kobold Camp Cleanup",
      objectives: "Kill 8 Kobold Vermin, then return to Marshal McBride.",
      details: "Kobolds have camped in the vineyard.",
      areaDescription: "",
      completedText: "",
      requiredNpcOrGo: [
        { entry: KOBOLD_ENTRY, count: 8, text: "" },
        { entry: GO_ENTRY | 0x80000000, count: 1, text: "Unlock the chest" },
        { entry: 0, count: 0, text: "Investigate the vineyard" },
        { entry: 0, count: 0, text: "" },
      ],
      requiredItems: [
        { itemId: REQUIRED_ITEM, count: 4 },
        { itemId: 0, count: 0 },
        { itemId: 0, count: 0 },
        { itemId: 0, count: 0 },
        { itemId: 0, count: 0 },
        { itemId: 0, count: 0 },
      ],
    },
  };
}

// ------------------------------------------------------------------ death
//
// Hand-written from PROTOCOL.md's death table. `SMSG_CORPSE_RECLAIM_DELAY`
// starts the clock the server enforces before a reclaim is legal;
// `SMSG_DEATH_RELEASE_LOC` with map -1 is what `Player::ResurrectPlayer` sends
// first, and is the observable a reclaim actually worked.

export function corpseReclaimDelay(delayMs: number, seq: number, ts = Date.now()): unknown {
  return { seq, opcode: "SMSG_CORPSE_RECLAIM_DELAY", opcodeId: 0x269, ts, data: { delayMs } };
}

/** `map: -1` clears the client's spirit-healer marker: you are alive again. */
export function deathReleaseCleared(seq: number): unknown {
  return {
    seq,
    opcode: "SMSG_DEATH_RELEASE_LOC",
    opcodeId: 0x378,
    ts: 1_700_000_000_000 + seq,
    data: { map: -1, x: 0, y: 0, z: 0 },
  };
}

/** The graveyard the spirit was released to (`SMSG_DEATH_RELEASE_LOC` with a real map). */
export function deathReleaseLoc(seq: number, at: { map: number; x: number; y: number; z: number }): unknown {
  return { seq, opcode: "SMSG_DEATH_RELEASE_LOC", opcodeId: 0x378, ts: 1_700_000_000_000 + seq, data: at };
}

/**
 * The server's answer to the ghost's `MSG_CORPSE_QUERY` (the module asks once
 * per death on the client's behalf). `found: false` carries no position.
 */
export function corpseQuery(
  seq: number,
  at?: { map: number; x: number; y: number; z: number; corpseMap?: number },
): unknown {
  return {
    seq,
    opcode: "MSG_CORPSE_QUERY",
    opcodeId: 0x216,
    ts: 1_700_000_000_000 + seq,
    data: at === undefined ? { found: false } : { found: true, corpseMap: at.map, ...at },
  };
}

/** Our own position moving (a ghost walking), as the module's WB_MOVE_RESULT reports it. */
export function selfArrived(seq: number, pos: { x: number; y: number; z: number }): unknown {
  return {
    seq,
    opcode: "WB_MOVE_RESULT",
    opcodeId: 0xff01,
    ts: 1_700_000_000_000 + seq,
    data: { moveId: seq, status: "arrived", pos: { ...pos, o: 0 } },
  };
}
