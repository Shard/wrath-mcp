/**
 * The party records' producer: `group`, `instance` and `kill` transitions,
 * latched in the sandbox child as the events that carry them arrive, for the
 * events recorder (`events-recorder.ts`) to hand the host. Latched rather
 * than sampled for the reason deaths and flights are (`watchers.ts`): a
 * periodic reading misses what happened between two readings, and a reading
 * off a sample (a map id, say) is not the server telling the client anything.
 *
 * Each one is read off a packet the server sends a client anyway:
 *
 * - **group**, from `SMSG_GROUP_LIST` (and the destroy, uninvite and
 *   set-leader packets around it) as the SDK's `state.group()` folds it.
 *   `joined` is a list arriving while not in a group, `left` the reverse,
 *   `changed` any other change of the group guid, the leader or the members.
 *   A process's first reading outside a group seeds silently; its first
 *   reading inside one is `joined`.
 * - **instance**, from the map transfer: the `WB_AREA` (or the reattaching
 *   `WB_SESSION_STATE`) that follows `SMSG_NEW_WORLD`, carrying the map with
 *   the module's `Map.dbc` reading of it, `instanceType`. Written when the map
 *   changed and the instance type with it: `entered` into a type other than
 *   0 (a continent), `left` back to 0. The first reading seeds silently (a
 *   resumed process inside an instance did not see it entered).
 * - **kill**, from `SMSG_PARTYKILLLOG` (`killerGuid`, `victimGuid`), with the
 *   victim's `entry` from the unit cache, else from the victim's creature
 *   guid, which carries it, so a member out of sight of the kill still names
 *   it, and its `rank` from the creature query the cache holds. A victim of
 *   rank 0 is not recorded (an open world would write a line per rabbit), nor
 *   is a player; a victim whose rank was never answered is, without one, so
 *   no elite is lost to a missing query. `member` is whether the killer is
 *   this character or one of its group's members as the group list stood
 *   when the packet arrived.
 *
 * Guids and ids only, never names: the record stays what the server said.
 * Pure over a narrow reading of the cache, so it is tested against fixture
 * events without a sandbox.
 */

import { guidKey } from "@wrathbench/sdk";
import { creatureEntryOfGuid } from "./format";

/** A party transition the child latched, with the event that carried it. */
export type PartySignal =
  | {
      kind: "group";
      event: "joined" | "changed" | "left";
      /** Absent on `left`. */
      groupGuid?: string;
      leaderGuid?: string;
      /** The other members' guids, in the server's order (self is never in the list). */
      members: string[];
      /** The party's size, self included; 0 on `left`. */
      count: number;
      ts: number;
      seq: number;
    }
  | {
      kind: "instance";
      event: "entered" | "left";
      map: number;
      instanceType: number;
      from: { map: number; instanceType: number };
      ts: number;
      seq: number;
    }
  | {
      kind: "kill";
      killerGuid: string;
      victimGuid: string;
      entry?: number;
      rank?: number;
      /** The killer is this character. */
      self: boolean;
      /** The killer is this character or a member of its group. */
      member: boolean;
      ts: number;
      seq: number;
    };

/** What the watcher reads off the SDK's cache, and nothing more. */
export interface PartyWatchState {
  group(): { inGroup: boolean; groupGuid: string | undefined; leaderGuid: string | undefined; members: readonly { guid: string }[] } | undefined;
  selfGuid(): string | undefined;
  /** The object's template entry and type (`unit`, `player`, …), when in view. */
  objectOf(guid: string): { entry: number | undefined; type: string | undefined } | undefined;
  /** The creature query's rank for a template entry, when answered. */
  rankOf(entry: number): number | undefined;
}

/** The fields of an event the watcher reads. */
export interface PartyWatchEvent {
  opcode: string;
  ts: number;
  seq: number;
  data: unknown;
}

const GROUP_OPCODES: ReadonlySet<string> = new Set(["SMSG_GROUP_LIST", "SMSG_GROUP_DESTROYED", "SMSG_GROUP_UNINVITE", "SMSG_GROUP_SET_LEADER"]);

/** Keep the newest this many undrained; a host that stops draining loses the oldest, never the process. */
export const PARTY_SIGNAL_CAP = 256;

/** A group signal's identity, event aside: what the host dedupes a restarted child's re-reading by. */
export function groupKeyOf(s: { groupGuid?: string | undefined; leaderGuid?: string | undefined; members: readonly string[]; count: number }): string {
  return s.count === 0 ? "out" : `in|${s.groupGuid ?? "?"}|${s.leaderGuid ?? "?"}|${[...s.members].sort().join(",")}`;
}

function guidOf(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return guidKey(BigInt(Math.trunc(v)));
  if (typeof v !== "string" || v.length === 0) return undefined;
  try {
    return guidKey(v);
  } catch {
    return undefined;
  }
}

export class PartyWatcher {
  private readonly signals: PartySignal[] = [];
  /** `groupKeyOf` of the last reading, undefined until the first. */
  private lastGroup: string | undefined;
  private lastMap: { map: number; instanceType: number } | undefined;

  constructor(private readonly state: PartyWatchState) {}

  /** Read one event; call after the SDK's own fold has applied it. */
  observe(event: PartyWatchEvent): void {
    if (GROUP_OPCODES.has(event.opcode)) this.group(event);
    else if (event.opcode === "WB_AREA" || event.opcode === "WB_SESSION_STATE") this.area(event);
    else if (event.opcode === "SMSG_PARTYKILLLOG") this.kill(event);
  }

  /** Everything latched since the last drain, oldest first. */
  drain(): PartySignal[] {
    return this.signals.splice(0, this.signals.length);
  }

  private push(s: PartySignal): void {
    this.signals.push(s);
    if (this.signals.length > PARTY_SIGNAL_CAP) this.signals.splice(0, this.signals.length - PARTY_SIGNAL_CAP);
  }

  private group(event: PartyWatchEvent): void {
    const g = this.state.group();
    if (g === undefined) return;
    const members = g.inGroup ? g.members.map((m) => m.guid) : [];
    const reading = {
      ...(g.inGroup && g.groupGuid !== undefined ? { groupGuid: g.groupGuid } : {}),
      ...(g.inGroup && g.leaderGuid !== undefined ? { leaderGuid: g.leaderGuid } : {}),
      members,
      count: g.inGroup ? members.length + 1 : 0,
    };
    const key = groupKeyOf(reading);
    const before = this.lastGroup;
    if (key === before) return;
    this.lastGroup = key;
    if (!g.inGroup) {
      // Seeded outside a group: nothing was left.
      if (before === undefined || before === "out") return;
      this.push({ kind: "group", event: "left", members: [], count: 0, ts: event.ts, seq: event.seq });
      return;
    }
    const kind = before === undefined || before === "out" ? "joined" : "changed";
    this.push({ kind: "group", event: kind, ...reading, ts: event.ts, seq: event.seq });
  }

  private area(event: PartyWatchEvent): void {
    const d = event.data as { mapId?: unknown; map?: unknown; instanceType?: unknown } | null;
    if (d === null || typeof d !== "object") return;
    const map = typeof d.mapId === "number" ? d.mapId : typeof d.map === "number" ? d.map : undefined;
    const instanceType = d.instanceType;
    // No `instanceType` is a module that does not serve it yet: no reading.
    if (map === undefined || typeof instanceType !== "number") return;
    const before = this.lastMap;
    this.lastMap = { map, instanceType };
    if (before === undefined || before.map === map || before.instanceType === instanceType) return;
    this.push({
      kind: "instance",
      event: instanceType !== 0 ? "entered" : "left",
      map,
      instanceType,
      from: before,
      ts: event.ts,
      seq: event.seq,
    });
  }

  private kill(event: PartyWatchEvent): void {
    const d = event.data as { killerGuid?: unknown; victimGuid?: unknown; killer?: unknown; victim?: unknown } | null;
    if (d === null || typeof d !== "object") return;
    const killer = guidOf(d.killerGuid ?? d.killer);
    const victim = guidOf(d.victimGuid ?? d.victim);
    if (killer === undefined || victim === undefined) return;
    const obj = this.state.objectOf(victim);
    if (obj?.type === "player") return;
    const entry = obj?.entry ?? creatureEntryOfGuid(victim);
    const rank = entry === undefined ? undefined : this.state.rankOf(entry);
    if (rank === 0) return;
    const self = killer === this.state.selfGuid();
    const g = this.state.group();
    const member = self || (g?.inGroup === true && g.members.some((m) => m.guid === killer));
    this.push({
      kind: "kill",
      killerGuid: killer,
      victimGuid: victim,
      ...(entry !== undefined ? { entry } : {}),
      ...(rank !== undefined ? { rank } : {}),
      self,
      member,
      ts: event.ts,
      seq: event.seq,
    });
  }
}
