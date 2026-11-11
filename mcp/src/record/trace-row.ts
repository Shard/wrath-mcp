/**
 * The trace stream's rows (`docs/SESSION-FORMAT.md`, "trace"): a fine-grained
 * record of the character's own position, unit state and character sheet.
 * In `wrath-session/1` it is the only record of level, XP, money, position
 * and what is carried; there is no coarser state table beside it.
 *
 * Nothing in it is new observation. The recorder (`trace-recorder.ts`) reads
 * the SDK's own state cache and event stream inside the sandbox child, and
 * the session writer (`writer.ts`) persists what the host drains. The agent
 * sees none of it.
 *
 * Beside the unit state rides the character sheet (`TraceSheet`): money, what
 * is worn and carried, the quest log's raw counters, visible reputation and
 * skills, as numbers and ids. Its lists are increments: a 'key' row states
 * each whole, a 'state' row carries only the rows that changed. The names a
 * reader shows them by travel once per id and segment, as dictionary entries
 * (`TraceDict`) on the segment's key row or a 'dict' row, never on a state row.
 */

export type TraceKind = "key" | "pos" | "state" | "flight" | "dict";

/** What the character's own target is, by the guid's high type. Never a name or a guid. */
export type TraceTargetKind = "creature" | "player" | "object" | "other";

/**
 * The character's state as the trace carries it. Every key is present in a
 * 'key' row and optional in a 'state' delta; `null` means unknown (the cache
 * has not observed it yet), never zero.
 */
export interface TraceState {
  hp: number | null;
  hpMax: number | null;
  pw: number | null;
  pwMax: number | null;
  /** The raw `powerType` field: 0 mana, 1 rage, 3 energy, 6 runic power. */
  pwType: number | null;
  level: number | null;
  xp: number | null;
  xpMax: number | null;
  /** `[spellId, stacks, expiresAt (epoch ms; 0 = no expiry), flags]`, sent whole on any change. */
  auras: [number, number, number, number][];
  combat: boolean;
  mounted: boolean;
  taxi: boolean;
  dead: boolean;
  ghost: boolean;
  resting: boolean;
  /** Zone and area (subzone) ids from `WB_AREA`. Ids only: the names are client text. */
  zone: number | null;
  area: number | null;
  /**
   * The character's own target. `entry` and `hpPct` for a creature; a player
   * target is its kind and nothing else (`gate.ts`).
   */
  target: null | { kind: TraceTargetKind; entry?: number; hpPct?: number };
  /** The cast in progress: `endsAt` is epoch ms. Null when not casting. */
  cast: null | { spellId: number; endsAt: number };
}

/**
 * The character sheet's lists, one row per thing, each keyed by its leading
 * fields (`SHEET_KEY_LEN`). In a 'key' row a list is the whole value; in a
 * 'state' row it is a patch: the rows that changed, whole, and a row holding
 * only its key fields for one that went. A list after `null` is whole.
 *
 * - `equip` `[slot, itemId, rand?]`: equipment slots 0-18. `rand` is the
 *   item's signed random property id, present only when it has one.
 * - `bags` `[slot, itemId, numSlots]`: the worn bags, slots 19-22.
 * - `inv` `[bag, slot, itemId, count?, rand?]`: what is carried, addressed as
 *   the item actions take it (the backpack is bag 255, slots 23-38; a worn
 *   bag is its own slot 19-22, with slots from 0), and the keyring and the
 *   currency tokens as bag 255 at their own slots, 86-117 and 118-149: every
 *   place the server counts toward a quest's items. Never the bank (39-73)
 *   or the vendor buyback slots (74-85). `count` is absent for 1 unless
 *   `rand` follows it.
 * - `dur` `[slot, cur, max]`: an equipped item's durability, for items that
 *   have one.
 * - `quests` `[slot, questId, state, c0?, c1?, c2?, c3?]`: the quest log's
 *   raw fields, its four objective counters with trailing zeros trimmed. The
 *   counts each needs are the quest's, not the log's (`TraceDict.quests`).
 * - `rep` `[factionId, standing]`: visible factions, the wire's standing.
 * - `skills` `[skillId, value, max]`.
 *
 * An `itemId` of 0 is a slot the cache knows is occupied by an item it has
 * not seen created yet. Never a name, a guid or any text.
 */
/** `[slot, itemId]` or `[slot, itemId, rand]`. */
export type TraceEquipRow = [slot: number, itemId: number, ...rand: number[]];
export type TraceBagRow = [slot: number, itemId: number, numSlots: number];
/** `[bag, slot, itemId]`, `[bag, slot, itemId, count]` or `[bag, slot, itemId, count, rand]`. */
export type TraceInvRow = [bag: number, slot: number, itemId: number, ...countRand: number[]];
export type TraceDurRow = [slot: number, cur: number, max: number];
/** `[slot, questId, state]` and up to four counters. */
export type TraceQuestRow = [slot: number, questId: number, state: number, ...counters: number[]];
export type TraceRepRow = [factionId: number, standing: number];
export type TraceSkillRow = [skillId: number, value: number, max: number];

/**
 * The character sheet as the trace carries it. Every key is present in a
 * 'key' row, and `null` means not observed: before this process has folded
 * the character's own create block the cache reads empty bags and an empty
 * log, because the wire compresses zeros out of create blocks, so the sheet
 * says nothing rather than "empty". A 'key' row from before the sheet was
 * recorded has none of these keys, which a reader takes as `null` too.
 */
export interface TraceSheet {
  /** Copper. */
  money: number | null;
  equip: TraceEquipRow[] | null;
  bags: TraceBagRow[] | null;
  inv: TraceInvRow[] | null;
  dur: TraceDurRow[] | null;
  quests: TraceQuestRow[] | null;
  rep: TraceRepRow[] | null;
  skills: TraceSkillRow[] | null;
}

/** The sheet's list keys, and how many leading fields key a row of each. */
export const SHEET_KEY_LEN = { equip: 1, bags: 1, inv: 2, dur: 1, quests: 1, rep: 1, skills: 1 } as const;
export type TraceSheetListKey = keyof typeof SHEET_KEY_LEN;

/**
 * What a 'state' row carries of the sheet: a new `money`, a patch per list
 * (rows whole, key-only rows removed, `null` back to unobserved), and
 * `qdone`, the quest ids the server confirmed turned in since the last row.
 *
 * `qdone` is an event and never state: it is in no 'key' row and no fold,
 * and it is never compared with what came before, so the same repeatable
 * quest turned in twice is two turn-ins. It is the server's own receipt
 * (`SMSG_QUESTGIVER_QUEST_COMPLETE`), so it is recorded whether or not the
 * rest of the sheet has been observed.
 */
export type TraceSheetDelta = {
  money?: number | null;
  qdone?: number[];
} & { [K in TraceSheetListKey]?: number[][] | null };

/**
 * Where a chat line went, by the server's own chat type: `say` (1), `party`
 * (2, and 51 from the leader), `raid` (3, 39, 40), `yell` (6), `whisper`
 * (9, the sender's copy of a whisper it sent) and `emote` (10, `/e`).
 */
export type TraceChatKind = "say" | "party" | "raid" | "yell" | "whisper" | "emote";
export const TRACE_CHAT_KINDS: readonly TraceChatKind[] = ["say", "party", "raid", "yell", "whisper", "emote"];

/** The longest chat line the trace keeps, in characters: the client's own input limit. */
export const TRACE_CHAT_MAX_CHARS = 255;

/** One line the character said: its kind and its text. Never a recipient, a guid or a name. */
export type TraceChat = [kind: TraceChatKind, text: string];

/**
 * What a 'state' row carries of the character's own chat: the lines the
 * server echoed back as said by it (`SMSG_MESSAGECHAT` from its own guid, or
 * the sender's copy of a whisper), so a line the server dropped is not here.
 * An event like `qdone`: in no 'key' row and no fold, and two identical lines
 * are two lines. The text is the model's own, as written.
 */
export interface TraceChatDelta {
  chat?: TraceChat[];
}

/** A 'key' row's data: the whole unit state and the whole sheet. */
export type TraceKeyData = TraceState & TraceSheet;
/** A 'state' row's data: the unit keys that changed, the sheet's patches, and the lines said. */
export type TraceStateDelta = Partial<TraceState> & TraceSheetDelta & TraceChatDelta;

/**
 * A quest's required counts, as its template states them: the four
 * creature, gameobject or event counts in counter order (the log's
 * `c0..c3`), then `[itemId, count]` for each item to collect. Numbers only:
 * no title, objective or any other text. A collect objective has no counter
 * in the log; a reader counts `inv` for it, as the client does.
 */
export type TraceQuestReq = [number, number, number, number, ...[itemId: number, count: number][]];

/**
 * What a drain names, each id once per process: an item's quality and its
 * template's name (never the instance's random suffix, its text or its
 * description), and a quest's required counts. The session writer keeps them
 * for the session and restates in each segment the ones its rows reference.
 */
export interface TraceDict {
  items?: [itemId: number, quality: number | null, name: string][];
  quests?: [questId: number, req: TraceQuestReq][];
}

/** The payload a 'flight' row carries: the spline's end and how long the ride is. */
export interface TraceFlight {
  to: { map: number; x: number; y: number; z: number };
  durationMs: number;
}

/** A position as the trace carries it (map, point and facing). */
export interface TracePoint {
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
}

/**
 * One trace row as a segment line. `ts` is the observation's own time (the
 * child's clock, `Observed.ts` where the cache has one), raised by the writer
 * to the last row written when it arrives late, so a segment's rows never go
 * back in time. The position fields are the last known position on a 'key'
 * row (null before one is known), the sample on a 'pos' row, the takeoff
 * point on a 'flight' row, and absent on 'state' and 'dict' rows.
 *
 * `data`, by kind: 'key' the full `TraceState` and `TraceSheet`; 'pos'
 * `{ jump: 1 }` when the character did not travel there continuously
 * (teleport, new world, login, reattach, hearth, graveyard, dungeon port) and
 * otherwise absent, so a reader never interpolates into a jump; 'state' a
 * partial `TraceState` holding only the keys that changed, the sheet's
 * patches (`TraceSheetDelta`) and the lines said (`TraceChatDelta`); 'flight'
 * a `TraceFlight`. `dict` is on a 'key' row (the entries its sheet
 * references) and is the whole payload of a 'dict' row.
 */
export interface TraceRow {
  ts: number;
  kind: TraceKind;
  map?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  o?: number | null;
  data?: TraceKeyData | TraceState | TraceStateDelta | { jump: 1 } | TraceFlight | null;
  dict?: TraceDict;
}

/** What the sandbox child hands the host per drain: the rows, how many the cap dropped, and the ids first named. */
export interface TraceDrain {
  rows: TraceRow[];
  dropped: number;
  dict?: TraceDict;
}

/** A `TraceState` with nothing observed: what a key row states before the world is seen. */
export function emptyTraceState(): TraceState {
  return {
    hp: null,
    hpMax: null,
    pw: null,
    pwMax: null,
    pwType: null,
    level: null,
    xp: null,
    xpMax: null,
    auras: [],
    combat: false,
    mounted: false,
    taxi: false,
    dead: false,
    ghost: false,
    resting: false,
    zone: null,
    area: null,
    target: null,
    cast: null,
  };
}

/** A `TraceSheet` with nothing observed. */
export function emptyTraceSheet(): TraceSheet {
  return { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null };
}

/** The sheet's keys, in the order every key row and patch uses. */
export const SHEET_KEYS = ["money", "equip", "bags", "inv", "dur", "quests", "rep", "skills"] as const satisfies readonly (keyof TraceSheet)[];

/** Two rows hold the same numbers. */
export function sameRow(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const rowKey = (row: readonly number[], keyLen: number): string => (keyLen === 1 ? String(row[0]) : `${row[0]},${row[1]}`);

/** Rows in key order, in place: by the first key field, then the second. */
export function sortRows<T extends readonly number[]>(rows: T[]): T[] {
  return rows.sort((a, b) => a[0]! - b[0]! || (a[1] ?? 0) - (b[1] ?? 0));
}

/**
 * A list with a patch applied, as a fresh array in key order. Never the
 * input mutated, so a key row already holding the old list keeps it. A list
 * after `null` is whole, and a `null` patch is back to unobserved.
 */
export function applySheetPatch<T extends number[]>(list: readonly T[] | null, patch: readonly (readonly number[])[] | null, keyLen: number): T[] | null {
  if (patch === null) return null;
  const rows = new Map<string, T>();
  for (const r of list ?? []) rows.set(rowKey(r, keyLen), r);
  for (const r of patch) {
    if (r.length < keyLen) continue;
    if (r.length === keyLen) rows.delete(rowKey(r, keyLen));
    else rows.set(rowKey(r, keyLen), [...r] as T);
  }
  return sortRows([...rows.values()]);
}

/**
 * The patch that takes list `a` to list `b`: each row of `b` that is new or
 * changed, whole, and the key of each row of `a` that `b` lacks, in key
 * order. `undefined` when they are the same; `b` whole when `a` is
 * unobserved; `null` when `b` is.
 */
export function sheetPatch(a: readonly (readonly number[])[] | null, b: readonly (readonly number[])[] | null, keyLen: number): number[][] | null | undefined {
  if (b === null) return a === null ? undefined : null;
  if (a === null) return b.map((r) => [...r]);
  const before = new Map<string, readonly number[]>();
  for (const r of a) before.set(rowKey(r, keyLen), r);
  const out: number[][] = [];
  for (const r of b) {
    const k = rowKey(r, keyLen);
    const o = before.get(k);
    before.delete(k);
    if (o === undefined || !sameRow(o, r)) out.push([...r]);
  }
  for (const r of before.values()) out.push(r.slice(0, keyLen));
  return out.length === 0 ? undefined : sortRows(out);
}
