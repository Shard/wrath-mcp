/**
 * The death and flight watchers: transitions latched in the sandbox child the
 * moment the event carrying them arrives, for the events recorder
 * (`events-recorder.ts`) to hand the host.
 *
 * Latched, never sampled. A whole death (die, release, walk to the spirit
 * healer, resurrect) closes in half a minute and leaves no residue in the
 * state cache (`SMSG_DEATH_RELEASE_LOC` with `map: -1` clears the corpse, the
 * graveyard and the reclaim delay), and two legs of a flight chain can land
 * inside any sampling interval; a periodic reading loses both. The child sees
 * every event, so the transition is read there, and its `ts` is the event's
 * own: when the thing happened.
 *
 * Both are fed after the client's own state fold has applied the event, so
 * every reading is of a cache that already holds it.
 */

import type { StateCache } from "@wrathbench/sdk";

/** `PLAYER_FLAGS_GHOST`: the released-spirit bit of `playerFlags`. */
export const PLAYER_FLAGS_GHOST = 0x10;

/** A death-window transition, with the event that carried it. */
export interface DeathSignal {
  kind: "death" | "release" | "resurrect";
  /** The timestamp of the event that carried the transition. */
  ts: number;
  /** That event's stream seq. */
  seq: number;
  /** Death only: the corpse as the cache held it at that instant; absent when only its dungeon's entrance was known. */
  position?: { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" };
  /** Release only: the graveyard the spirit was released to. */
  graveyard?: { map: number; x: number; y: number; z: number };
  /** Death only: the zone/area ids at the moment of death. */
  zone?: number;
  area?: number;
  /** Death only: the ghost flag as it read at that instant (usually false). */
  released?: boolean;
}

/**
 * A flight transition. `taxi` is the flag turning on after an accepted reply;
 * `taxi_landed` is it turning off. Both carry the position and zone/area ids
 * as the cache held them at that instant, so a landing is written with the
 * landing's own area.
 */
export interface FlightSignal {
  kind: "taxi" | "taxi_landed";
  ts: number;
  seq: number;
  position?: { map: number; x: number; y: number; z: number };
  zone?: number;
  area?: number;
}

/** The fields of an event the watchers read. */
export interface WatchedEvent {
  opcode: string;
  ts: number;
  seq: number;
  data: unknown;
}

type WatchedState = Pick<StateCache, "self">;

function point(v: unknown): { map: number; x: number; y: number; z: number } | undefined {
  const p = v as { map?: unknown; x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (p === undefined || p === null) return undefined;
  if (typeof p.map !== "number" || typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return undefined;
  return { map: p.map, x: p.x, y: p.y, z: p.z };
}

function zoneArea(state: WatchedState): { zone?: number; area?: number } {
  const zone = (state.self.zone?.value as { id?: unknown } | undefined)?.id;
  const area = (state.self.area?.value as { id?: unknown } | undefined)?.id;
  return { ...(typeof zone === "number" ? { zone } : {}), ...(typeof area === "number" ? { area } : {}) };
}

/**
 * The death window, from the events that carry it.
 *
 * The readings: own `health` off the raw field record (the derived gauge is
 * withheld until `maxHealth` has been seen) and the ghost bit off
 * `playerFlags`. Release and resurrect additionally have a packet that says
 * so outright, `SMSG_DEATH_RELEASE_LOC` (the graveyard on the way in and the
 * clear marker on the way out), and that is the primary trigger, because
 * `playerFlags` rides an update block that need not arrive with it.
 */
export class DeathWatcher {
  /** Own health last read as zero. */
  private dead = false;
  /** The spirit is released: the ghost flag, or the graveyard packet that made it one. */
  private released = false;
  /**
   * The ghost bit was actually seen set. Separate from `released` because
   * `playerFlags` need not ride the blocks that arrive during a death: a stale
   * 0 all the way through is ordinary, so only a bit that was seen on can be
   * read as meaning anything when it goes off again.
   */
  private ghostSeen = false;
  /**
   * The ghost bit as the previous event left it, undefined until first seen.
   * A release read off the bit needs it to rise: the bit is still set for an
   * event or two after the resurrect's clear marker, and reading "set" as
   * "released" there would reopen the window the resurrect had just closed.
   */
  private lastGhost: boolean | undefined;

  constructor(
    private readonly state: WatchedState,
    private readonly emit: (signal: DeathSignal) => void,
  ) {}

  /** Whether a death window is open, and whether the spirit is released in it. */
  get window(): { dead: boolean; released: boolean } {
    return { dead: this.dead || this.released, released: this.released };
  }

  observe(event: WatchedEvent): void {
    const self = this.state.self;
    const health = self.fields.get("health")?.value;
    const flags = self.fields.get("playerFlags")?.value;
    const ghost = typeof flags === "number" ? (flags & PLAYER_FLAGS_GHOST) !== 0 : undefined;
    const releaseLoc = event.opcode === "SMSG_DEATH_RELEASE_LOC" ? (event.data as { map?: unknown }) : undefined;
    // The window as it stood before this event: a resurrect is only ever read
    // against a window some earlier event opened, never against this one.
    const wasDead = this.dead;
    const wasReleased = this.released;
    const wasGhost = this.ghostSeen;
    const releasedTo = typeof releaseLoc?.map === "number" && releaseLoc.map >= 0;
    const cleared = typeof releaseLoc?.map === "number" && releaseLoc.map < 0;

    // The death: own health observed at zero, from a reading that was not.
    if (health === 0 && !this.dead) {
      this.dead = true;
      const corpse = self.corpse?.value as { source?: unknown; instanceMap?: unknown } | undefined;
      // A corpse inside a dungeon is reported at its entrance, which is not the death site.
      const at = typeof corpse?.instanceMap === "number" ? undefined : point(corpse);
      const source = corpse?.source === "corpse_query" ? "corpse_query" : corpse?.source === "death_spot" ? "death_spot" : undefined;
      this.emit({
        kind: "death",
        ts: event.ts,
        seq: event.seq,
        ...(at !== undefined && source !== undefined ? { position: { ...at, source } } : {}),
        ...zoneArea(this.state),
        ...(ghost === undefined ? {} : { released: ghost }),
      });
    }

    // The release: the graveyard packet, or the ghost flag turning on (an edge, not a level).
    const ghostRose = ghost === true && this.lastGhost !== true;
    if (ghost !== undefined) this.lastGhost = ghost;
    if (!this.released && (releasedTo || ghostRose)) {
      this.released = true;
      const grave = point(self.graveyard?.value);
      this.emit({ kind: "release", ts: event.ts, seq: event.seq, ...(grave === undefined ? {} : { graveyard: grave }) });
    }
    // The bit counts as "seen on" only inside a window this watcher opened:
    // the stale bit after a resurrect, latched outside one, would make the
    // next death's first `ghost === false` read as a resurrect.
    if (ghost === true && (this.dead || this.released)) this.ghostSeen = true;

    // The resurrect: the clear marker, health back above the single point a
    // released ghost carries, or the ghost flag turning off again. Read
    // against the window as it stood before this event, so the event that
    // opened the window cannot also close it.
    const alive = cleared || (typeof health === "number" && health > 1) || (ghost === false && wasGhost);
    if ((wasDead || wasReleased) && alive) {
      this.dead = false;
      this.released = false;
      this.ghostSeen = false;
      this.emit({ kind: "resurrect", ts: event.ts, seq: event.seq });
    }
  }
}

/**
 * Flights: the takeoff is the taxi flag turning on after an accepted reply,
 * the landing is it turning off. The flag is read off `taxiFlight`, which the
 * cache derives only from a block that carried `unitFlags`, so a block
 * without it changes nothing here. The first reading seeds silently: a
 * process that opens mid-flight did not see this flight begin.
 */
export class FlightWatcher {
  private last: boolean | undefined;

  constructor(
    private readonly state: WatchedState,
    private readonly emit: (signal: FlightSignal) => void,
  ) {}

  /** The taxi flag as last read; false before any reading. */
  get flying(): boolean {
    return this.last === true;
  }

  observe(event: WatchedEvent): void {
    const self = this.state.self;
    const flying = self.taxiFlight?.value;
    if (typeof flying !== "boolean") return;
    const was = this.last;
    this.last = flying;
    if (was === undefined || was === flying) return;
    const accepted = (self.taxiReply?.value as { ok?: unknown } | undefined)?.ok === true;
    if (flying && !accepted) return;
    const at = point(self.position?.value);
    this.emit({ kind: flying ? "taxi" : "taxi_landed", ts: event.ts, seq: event.seq, ...(at === undefined ? {} : { position: at }), ...zoneArea(this.state) });
  }
}
