/**
 * The events recorder: what happened to the character, as rows of the
 * session's `events` stream (`format.ts`, `EventRow`), latched in the sandbox
 * child for the host to drain.
 *
 * Two kinds of reading. Deaths, flights and the party records are
 * transitions a periodic reading would lose, so each is latched off the
 * event that carried it (`watchers.ts`, `party-watch.ts`). Zone, area, level,
 * achievements, the spellbook, talents, trades and quest turn-ins all leave
 * the state cache holding what changed, so a one-second comparison against
 * what was last emitted reads them, each stamped with the cache's own time
 * for the value and never the poll's.
 *
 * A recorder's first reading of each is a baseline, never a gain: the first
 * zone and level carry no `from`, the first spellbook and achievement
 * backlog are `spells_at_login` and `achievements_at_login`, and a talent
 * frame seeds silently. A restarted child is a new recorder and states its
 * baseline again, behind a `key` row that says so.
 *
 * It reads the cache and broadcast subscriptions only: nothing here consumes
 * an event queue, sends anything, or is reachable from a snippet. Bounded
 * like the other recorders: past `cap` the oldest rows go and are counted.
 */

import type { EventStream, StateCache } from "@wrathbench/sdk";
import { emptyEventsState, type EventRow, type EventsState } from "./format";
import { PartyWatcher } from "./party-watch";
import { DeathWatcher, FlightWatcher } from "./watchers";

/** How often the cache is compared against what was last emitted. */
export const EVENTS_POLL_MS = 1_000;
/** Rows held for the host before the oldest are dropped. */
export const EVENTS_BUFFER_CAP = 1024;
/** `TRADE_STATUS_TRADE_COMPLETE`. */
const TRADE_STATUS_COMPLETE = 8;

/** The slice of the SDK client the recorder reads. Structural, so a test hands it a cache it fed itself. */
export interface EventsSource {
  state: Pick<StateCache, "self" | "xp" | "questCompletions" | "spells" | "talents" | "trade" | "group" | "nearby" | "creatures">;
  events: Pick<EventStream, "onAny">;
}

export interface EventsRecorderOptions extends EventsSource {
  now?: () => number;
  pollMs?: number;
  cap?: number;
}

export interface EventsDrain {
  rows: EventRow[];
  dropped: number;
}

export class EventsRecorder {
  private readonly state: EventsSource["state"];
  private readonly events: EventsSource["events"];
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly cap: number;

  private readonly rows: EventRow[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  private readonly death: DeathWatcher;
  private readonly flight: FlightWatcher;
  private readonly party: PartyWatcher;

  private zone: number | undefined;
  private area: number | undefined;
  private level: number | undefined;
  private questsSeen = 0;
  private achievementsAtLogin = false;
  private readonly achievements = new Set<number>();
  private spellsAtLogin = false;
  private readonly spells = new Set<number>();
  private readonly talentRanks = new Map<number, number>();
  private talentsSeeded = false;
  private lastTradeTs: number | undefined;

  constructor(o: EventsRecorderOptions) {
    this.state = o.state;
    this.events = o.events;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? EVENTS_POLL_MS;
    this.cap = o.cap ?? EVENTS_BUFFER_CAP;
    this.death = new DeathWatcher(this.state, (s) => {
      const { kind, ts, seq, ...rest } = s;
      this.push({ ts, seq, kind, ...rest } as EventRow);
    });
    this.flight = new FlightWatcher(this.state, (s) => this.push(s));
    this.party = new PartyWatcher({
      group: () => this.state.group(),
      selfGuid: () => this.state.self.guid,
      objectOf: (guid) => {
        const o = this.state.nearby.get(guid);
        return o === undefined ? undefined : { entry: o.entry?.value, type: o.objectType?.value };
      },
      rankOf: (entry) => this.state.creatures.get(entry)?.value.rank,
    });
  }

  /** Emit the opening key, hook the stream and start the poll. Called once per child. */
  start(): void {
    // Turn-ins the cache already held were an earlier recorder's to write.
    this.questsSeen = this.state.questCompletions.length;
    this.push({ ts: this.now(), kind: "key", state: this.read() });
    this.unsubscribe = this.events.onAny((event) => {
      this.death.observe(event);
      this.flight.observe(event);
      this.party.observe(event);
      for (const s of this.party.drain()) {
        if (s.kind === "group") {
          const { kind, ts, seq, event: what, ...rest } = s;
          this.push({ ts, seq, kind, event: what, ...rest, foreign: 0 });
        } else this.push(s);
      }
    });
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  drain(): EventsDrain {
    const rows = this.rows.splice(0, this.rows.length);
    const dropped = this.dropped;
    this.dropped = 0;
    return { rows, dropped };
  }

  private push(row: EventRow): void {
    this.rows.push(row);
    if (this.rows.length > this.cap) {
      this.rows.splice(0, this.rows.length - this.cap);
      this.dropped++;
    }
  }

  /** The stream's state as the cache holds it now: what a key row states. */
  private read(): EventsState {
    const self = this.state.self;
    const s = emptyEventsState();
    if (self.level !== undefined) s.level = self.level.value;
    if (self.zone !== undefined) s.zone = self.zone.value.id;
    if (self.area !== undefined) s.area = self.area.value.id;
    const pos = self.position?.value;
    if (pos !== undefined) s.map = pos.map;
    const window = this.death.window;
    const health = self.fields.get("health")?.value;
    s.dead = window.dead || health === 0 || self.ghost?.value === true;
    s.released = window.released || self.ghost?.value === true;
    s.taxi = self.taxiFlight?.value === true;
    const g = this.state.group();
    if (g !== undefined && g.inGroup) {
      const members = g.members.map((m) => m.guid);
      s.group = {
        ...(g.groupGuid !== undefined ? { groupGuid: g.groupGuid } : {}),
        ...(g.leaderGuid !== undefined ? { leaderGuid: g.leaderGuid } : {}),
        members,
        foreign: 0,
        count: members.length + 1,
      };
    }
    return s;
  }

  /** One comparison of the cache against what was last emitted. Public so a test drives it without the timer. */
  poll(): void {
    const self = this.state.self;
    const zone = self.zone;
    if (zone !== undefined && zone.value.id !== this.zone) {
      this.push({ ts: zone.ts, kind: "zone", ...(this.zone === undefined ? {} : { from: this.zone }), to: zone.value.id });
      this.zone = zone.value.id;
    }
    const area = self.area;
    if (area !== undefined && area.value.id !== this.area) {
      this.push({ ts: area.ts, kind: "area", ...(this.area === undefined ? {} : { from: this.area }), to: area.value.id });
      this.area = area.value.id;
    }
    const level = self.level;
    if (level !== undefined && level.value !== this.level) {
      const xp = this.state.xp?.value;
      this.push({ ts: level.ts, kind: "level", ...(this.level === undefined ? {} : { from: this.level }), to: level.value, ...(typeof xp === "number" ? { xp } : {}) });
      this.level = level.value;
    }
    this.pollQuests();
    this.pollAchievements();
    this.pollSpells();
    this.pollTalents();
    this.pollTrade();
  }

  private pollQuests(): void {
    const done = this.state.questCompletions;
    // A shorter list is a cache that was rebuilt: nothing in it is ours yet.
    if (done.length < this.questsSeen) this.questsSeen = 0;
    for (const c of done.slice(this.questsSeen)) this.push({ ts: c.ts, seq: c.seq, kind: "quest", id: c.questId });
    this.questsSeen = done.length;
  }

  /** The backlog once, then one row per own earn; the cache has already dropped other players' broadcasts. */
  private pollAchievements(): void {
    const ach = this.state.self.achievements;
    if (ach === undefined) return;
    if (!this.achievementsAtLogin && ach.loginSeen) {
      const ids: number[] = [];
      let points = 0;
      let ts = 0;
      for (const e of ach.entries) {
        if (e.source !== "login") continue;
        ids.push(e.achievementId);
        if (typeof e.points === "number") points += e.points;
        if (e.ts > ts) ts = e.ts;
        this.achievements.add(e.achievementId);
      }
      this.push({ ts: ts > 0 ? ts : this.now(), kind: "achievements_at_login", ids, points });
      this.achievementsAtLogin = true;
    }
    for (const e of ach.entries) {
      if (e.source !== "earned" || this.achievements.has(e.achievementId)) continue;
      this.achievements.add(e.achievementId);
      this.push({
        ts: e.ts,
        seq: e.seq,
        kind: "achievement",
        id: e.achievementId,
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.points !== undefined ? { points: e.points } : {}),
        ...(e.categoryId !== undefined ? { categoryId: e.categoryId } : {}),
      });
    }
  }

  /**
   * The first book seen at all is the baseline, and everything appearing
   * afterwards is a learn. A book seen empty is not a baseline: the cache has
   * simply not had the login's spell list yet.
   */
  private pollSpells(): void {
    const book = this.state.spells();
    if (book.length === 0) return;
    if (!this.spellsAtLogin) {
      this.spellsAtLogin = true;
      for (const s of book) this.spells.add(s.spellId);
      this.push({ ts: this.now(), kind: "spells_at_login", ids: [...this.spells].sort((a, b) => a - b) });
      return;
    }
    for (const s of book) {
      if (this.spells.has(s.spellId)) continue;
      this.spells.add(s.spellId);
      this.push({ ts: this.now(), kind: "spell", id: s.spellId });
    }
  }

  /**
   * A rank that climbed is a spend. The wire rank is 0-based, so the row
   * carries both it and the points it means, and a talent the frame stops
   * listing (a respec) is forgotten, so a relearn reads as a spend again.
   */
  private pollTalents(): void {
    const talents = this.state.talents();
    if (talents === undefined) return;
    const seen = new Set<number>();
    for (const t of talents.talents) {
      seen.add(t.talentId);
      const prev = this.talentRanks.get(t.talentId);
      if (prev !== undefined && t.rank <= prev) {
        if (t.rank < prev) this.talentRanks.set(t.talentId, t.rank);
        continue;
      }
      this.talentRanks.set(t.talentId, t.rank);
      if (!this.talentsSeeded) continue;
      this.push({ ts: talents.ts, seq: talents.seq, kind: "talent", id: t.talentId, points: t.rank + 1, rank: t.rank, spec: talents.activeSpec });
    }
    for (const id of [...this.talentRanks.keys()]) if (!seen.has(id)) this.talentRanks.delete(id);
    this.talentsSeeded = true;
  }

  /** The completion latches on the trade window until the next trade packet; the cache's stamp dedupes it. */
  private pollTrade(): void {
    const trade = this.state.trade();
    if (trade === undefined || trade.status !== TRADE_STATUS_COMPLETE || trade.ts === this.lastTradeTs) return;
    this.lastTradeTs = trade.ts;
    this.push({ ts: trade.ts, seq: trade.seq, kind: "trade" });
  }
}
