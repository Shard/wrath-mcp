/**
 * The quest log at the playhead, from the trace's character sheet.
 *
 * The sheet carries the log as numbers (the session format's trace rows, `wrath-mcp/docs/SESSION-FORMAT.md`): each
 * slot's quest id, its state and its four objective counters, and beside them
 * the counts each quest needs (`qreq`, the segment's own dictionary). Nothing
 * here names a quest: the trace records no title and the public projection
 * publishes none, so the panel links each id to Wowhead and the reader's
 * browser asks for the name (`questUrl`).
 *
 * What is pinned here is the join, client-style:
 *
 *  - a creature, gameobject or event objective is its counter against the
 *    quest's count for that counter, the four in the log's order;
 *  - a collect objective has no counter in the log at all. Its progress is
 *    what is carried — equipped, worn bags, the backpack, the worn bags'
 *    contents, the keyring and the currency tokens (bag 255, slots 86-149),
 *    as the server's `Player::GetItemCount(id, false)` counts it — capped at
 *    the count needed, as the server keeps it (`AdjustQuestReqItemCount`).
 *    The bag grid leaves the keyring and the currency slots out, as the 60 s
 *    reading does (`sheetItems`); only this count reads them. A key reads 0
 *    where the sheet did not see the keyring (a module that does not serve
 *    it); the panel shows objectives only while a quest is in progress, so a
 *    complete quest's key is never shown as missing;
 *  - the state is the slot's `QuestSlotStateMask` (AzerothCore `Player.h`):
 *    bit 1 complete, bit 2 failed;
 *  - a quest the segment carries no counts for has no objectives rather than
 *    zeros, and an objective with no counter and no count (exploration, a
 *    scripted event) is invisible in the counts, so its quest shows only its
 *    state.
 *
 * `null` is "the sheet cannot say" — a segment from before the sheet, the
 * stretch after a sandbox restart before the character's own create block —
 * and an empty list is an observed empty log. There is no coarser reading to
 * fall back to: the 60 s state line carries a count of turn-ins, not the log.
 */

import type { TraceItemName, TraceQuestReq, TraceSheet } from "../../wire";

/** The log slot's state bits, `QuestSlotStateMask`. */
export const QUEST_STATE_COMPLETE = 0x1;
export const QUEST_STATE_FAIL = 0x2;

/** Where a row stands: in the log, done, failed, or turned in since its window began. */
export type QuestStatus = "active" | "complete" | "failed" | "turnedIn";

export interface QuestObjective {
  /** A counter's value, or what is carried of the item capped at `need`; null when what is carried was not observed. */
  have: number | null;
  need: number;
  /** A collect objective's item, and its template's name where the segment names it. */
  itemId?: number;
  name?: string;
}

export interface QuestRow {
  questId: number;
  /** The log slot, 0-24; null for a quest turned in and gone from the log. */
  slot: number | null;
  status: QuestStatus;
  /** Null where the segment carries no counts for the quest, and for a turn-in. */
  objectives: readonly QuestObjective[] | null;
}

/** The parts of a sheet the log is read from, and the turn-ins since its window's start (`TraceSheetAt.qdone`). */
export type SheetQuests = Pick<TraceSheet, "quests" | "equip" | "bags" | "inv"> & { qdone?: readonly number[] };

type Names = ReadonlyMap<number, TraceItemName>;
type Reqs = ReadonlyMap<number, TraceQuestReq>;

function statusOf(state: number): QuestStatus {
  if ((state & QUEST_STATE_FAIL) !== 0) return "failed";
  if ((state & QUEST_STATE_COMPLETE) !== 0) return "complete";
  return "active";
}

/**
 * Stacks carried per item id, wherever the server counts them for a quest —
 * every `inv` row, the keyring and the currency slots among them — null when
 * any of those lists is not observed.
 */
function carriedCounts(sheet: SheetQuests): Map<number, number> | null {
  const { equip, bags, inv } = sheet;
  if (equip === null || bags === null || inv === null) return null;
  const n = new Map<number, number>();
  const add = (id: number | undefined, count: number): void => {
    if (id !== undefined && id > 0) n.set(id, (n.get(id) ?? 0) + count);
  };
  for (const r of equip) add(r[1], 1);
  for (const r of bags) add(r[1], 1);
  for (const r of inv) add(r[2], r[3] ?? 1);
  return n;
}

function objectivesOf(row: readonly number[], req: TraceQuestReq | undefined, carried: Map<number, number> | null, names: Names): QuestObjective[] | null {
  if (req === undefined) return null;
  const out: QuestObjective[] = [];
  for (let i = 0; i < 4; i++) {
    const need = req[i] as number;
    // Trailing zero counters are trimmed off the row.
    if (need > 0) out.push({ have: row[3 + i] ?? 0, need });
  }
  for (const pair of req.slice(4) as [number, number][]) {
    const [itemId, need] = pair;
    if (itemId <= 0 || need <= 0) continue;
    const name = names.get(itemId)?.[1];
    out.push({ have: carried === null ? null : Math.min(carried.get(itemId) ?? 0, need), need, itemId, ...(name === undefined ? {} : { name }) });
  }
  return out;
}

/** The last fold's inputs and answer, so a frame that crossed no change of the log's lists gets it back at once. */
let last: { quests: unknown; equip: unknown; bags: unknown; inv: unknown; qdone: unknown; qreq: Reqs; names: Names; out: QuestRow[] } | null = null;
/**
 * The newest answer's rows by what they say, and its array. The live tail is
 * decoded afresh on every poll and a window again when it closes, as new
 * arrays and new dictionaries; a row that says the same thing keeps its
 * object across that, and a log that does keeps its array.
 */
let lastRows = new Map<string, QuestRow>();
let lastOut: QuestRow[] = [];

/**
 * The log at the playhead: one row per quest in log-slot order, then each
 * quest turned in since the segment's window began that has left the log,
 * once. Null when the sheet does not carry the log.
 *
 * The same array comes back while the rows say the same thing — a frame, a
 * money change, an item picked up that no quest asks for, the live tail
 * polled again, a window arriving closed — and a row that did not change
 * keeps its object.
 */
export function questLog(sheet: SheetQuests, qreq: Reqs, names: Names): QuestRow[] | null {
  const { quests, equip, bags, inv } = sheet;
  if (quests === null) return null;
  const qdone = sheet.qdone ?? null;
  if (
    last !== null &&
    last.quests === quests &&
    last.equip === equip &&
    last.bags === bags &&
    last.inv === inv &&
    last.qdone === qdone &&
    last.qreq === qreq &&
    last.names === names
  ) {
    return last.out;
  }
  const carried = carriedCounts(sheet);
  const seen = new Set<number>();
  const built: QuestRow[] = [];
  for (const r of quests) {
    const [slot, questId, state] = r;
    if (questId <= 0 || seen.has(questId)) continue;
    seen.add(questId);
    built.push({ questId, slot, status: statusOf(state), objectives: objectivesOf(r, qreq.get(questId), carried, names) });
  }
  for (const questId of qdone ?? []) {
    // A turn-in lands a moment before the log loses the quest; while it is still there the log's row stands.
    if (questId <= 0 || seen.has(questId)) continue;
    seen.add(questId);
    built.push({ questId, slot: null, status: "turnedIn", objectives: null });
  }
  const rows = new Map<string, QuestRow>();
  const reused = built.map((q) => {
    const key = JSON.stringify(q);
    const row = rows.get(key) ?? lastRows.get(key) ?? q;
    rows.set(key, row);
    return row;
  });
  const out = reused.length === lastOut.length && reused.every((q, i) => q === lastOut[i]) ? lastOut : reused;
  lastRows = rows;
  lastOut = out;
  last = { quests, equip, bags, inv, qdone, qreq, names, out };
  return out;
}

/** The number on the quest button: quests in the log, not the turn-ins shown after them. */
export function questsInLog(rows: readonly QuestRow[]): number {
  return rows.reduce((n, q) => (q.status === "turnedIn" ? n : n + 1), 0);
}

/**
 * One objective as the panel prints it: `have / need`, a dash for a have that
 * was not observed. Its spaces do not break, so a quest with several
 * objectives wraps between them and never inside one.
 */
export function objectiveText(o: QuestObjective): string {
  return `${o.have ?? "—"} / ${o.need}`;
}

/** What a status is called, on its row's tooltip and in place of objectives a row does not have. */
export const QUEST_STATUS_LABEL: Readonly<Record<QuestStatus, string>> = {
  active: "in progress",
  complete: "complete",
  failed: "failed",
  turnedIn: "turned in",
};
