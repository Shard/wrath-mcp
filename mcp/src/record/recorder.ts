/**
 * The session recorder: everything the stack records about a session from
 * inside the process that holds its `WrathClient`, as one object.
 *
 * It is a library over a client, not something welded to the tool
 * dispatcher: it reads the client's state cache and broadcast subscriptions
 * and nothing else, so a long-running program that calls no tool is recorded
 * exactly as a snippet loop is. The sandbox child builds one
 * (`sandbox/child.ts`) and answers the host's `record_drain` with `drain()`;
 * the host's session writer (`writer.ts`) gates and persists what comes back.
 * Nothing here writes a file, and nothing here is reachable from a snippet.
 */

import type { EventStream, StateCache } from "@wrathbench/sdk";
import { EventsRecorder, type EventsDrain } from "./events-recorder";
import type { NearbyDrain, SessionCharacter, TraceDrain } from "./format";
import { NearbyRecorder } from "./nearby-recorder";
import { TraceRecorder } from "./trace-recorder";

export { EventsRecorder, type EventsDrain, type EventsRecorderOptions } from "./events-recorder";
export { NearbyRecorder, type NearbyRecorderOptions } from "./nearby-recorder";
export { TraceRecorder, type TraceRecorderOptions } from "./trace-recorder";
export { PartyWatcher, type PartyWatchEvent, type PartyWatchState } from "./party-watch";
export { DeathWatcher, FlightWatcher } from "./watchers";

/** The slice of a `WrathClient` the recorders read. */
export interface RecordedClient {
  state: StateCache;
  events: Pick<EventStream, "on" | "onAny" | "connected">;
}

/** A movement intention as the recorder is handed it by whatever watches the wire (`sandbox/child.ts`). */
export interface RecordedMove {
  /** When this row is about: the dispatch, or the verdict. */
  ts: number;
  /** When the move was dispatched. */
  at: number;
  /** The eval whose context dispatched it; null outside every eval. */
  evalId: number | null;
  /** True when that eval had already returned. */
  routine?: true;
  moveId: number | null;
  map: number | null;
  x: number;
  y: number;
  z: number;
  /** The guid the move was aimed at, and its client-cache name. */
  target: string | null;
  name?: string;
  status: string | null;
}

/** What one drain hands the host. */
export interface RecordDrain {
  trace: TraceDrain;
  nearby: NearbyDrain;
  events: EventsDrain;
  moves: RecordedMove[];
  /** The character as the cache holds it now; null before it is in the world. */
  character: SessionCharacter | null;
  /** The client's event stream: whether it is open, how many events it has folded and the last `seq`. */
  stream: { connected: boolean; events: number; seq: number };
  /**
   * Player names the client cache was answered (`SMSG_NAME_QUERY_RESPONSE`)
   * since the last drain, as `[guid, name]`; every one it holds on a
   * recorder's first drain. For the write gate's scrub (`gate.ts`): held by
   * the writer, never written.
   */
  players?: [string, string][];
}

export class SessionRecorder {
  readonly trace: TraceRecorder;
  readonly nearby: NearbyRecorder;
  readonly events: EventsRecorder;
  private readonly moves: RecordedMove[] = [];
  /** The player names already handed to the host, by guid. */
  private readonly playersSent = new Map<string, string>();

  constructor(private readonly client: RecordedClient) {
    this.trace = new TraceRecorder({ state: client.state, events: client.events });
    this.nearby = new NearbyRecorder({ state: client.state, events: client.events });
    this.events = new EventsRecorder({ state: client.state, events: client.events });
  }

  /** Start every recorder. Called once, after the client's own state fold is registered. */
  start(): void {
    this.events.start();
    this.trace.start();
    this.nearby.start();
  }

  stop(): void {
    this.events.stop();
    this.trace.stop();
    this.nearby.stop();
  }

  /** Note a movement intention: at its dispatch, and again at its verdict. Bounded like the recorders. */
  noteMove(move: RecordedMove): void {
    this.moves.push(move);
    if (this.moves.length > 256) this.moves.splice(0, this.moves.length - 256);
  }

  private character(): SessionCharacter | null {
    const self = this.client.state.self;
    if (self.guid === undefined) return null;
    const field = (name: string): number | null => {
      const v = self.fields.get(name)?.value;
      return typeof v === "number" ? v : null;
    };
    return { guid: self.guid, name: self.name ?? null, race: field("race"), class: field("class") };
  }

  /** The client cache's player names it has not handed over yet, or changed since. */
  private players(): [string, string][] {
    const out: [string, string][] = [];
    for (const [guid, observed] of this.client.state.names) {
      if (this.playersSent.get(guid) === observed.value) continue;
      this.playersSent.set(guid, observed.value);
      out.push([guid, observed.value]);
    }
    return out;
  }

  /** Everything latched since the last drain. Destructive: one caller, the host's writer, owns it. */
  drain(): RecordDrain {
    const players = this.players();
    return {
      ...(players.length > 0 ? { players } : {}),
      trace: this.trace.drain(),
      nearby: this.nearby.drain(),
      events: this.events.drain(),
      moves: this.moves.splice(0, this.moves.length),
      character: this.character(),
      stream: { connected: this.client.events.connected, events: this.client.state.eventCount, seq: this.client.state.lastSeq },
    };
  }
}
