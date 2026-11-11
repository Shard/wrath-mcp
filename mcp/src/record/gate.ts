/**
 * The write gate: the one place the rules for other players are applied
 * (`docs/SESSION-FORMAT.md`, "Other players"). Every row the session writer
 * is about to put in a file passes through `gate` first, whichever recorder
 * produced it, so "a player who is not one of the deployment's own sessions
 * is never written" is this file and not a property each recorder must keep.
 *
 * It governs storage only. The recorders read what the client observed, and
 * what an agent observes live is `docs/CONTRACTS.md`.
 *
 * Structured fields are gated by rule. Free text (a tool call's arguments,
 * its result, a served event batch, the action log) is scrubbed best-effort
 * in `gateCalls`: a foreign player's guid, and the name the client was
 * answered for it, are replaced wherever they stand as a whole token. The
 * players it knows are the ones the session's client cache was answered for
 * (`notePlayers`), held here and never written. It starts once the session's
 * own character is known. On a world with no foreign players it changes
 * nothing, and the record is what the agent saw.
 */

import { PLAYER_REF, isPlayerGuid, type CallRow, type EventRow, type EventsState, type NearbyRow, type NearbyState, type NearbyUnit, type StreamName, type StreamRows, type TraceRow } from "./format";
import { readSessionFile } from "./reader";

/** Whether a player guid is a session of the same deployment. The session's own character always is. */
export type OwnGuid = (guid: string) => boolean;

/**
 * The guids that are sessions of one deployment, read from a set of session
 * directories and refreshed when a guid it does not know is asked for, at
 * most once every `refreshMs`. A guid it cannot place is foreign.
 */
export function ownGuidIndex(sessionDirs: () => string[], o: { refreshMs?: number; now?: () => number } = {}): OwnGuid {
  const refreshMs = o.refreshMs ?? 5_000;
  const now = o.now ?? Date.now;
  let known = new Set<string>();
  let readAt = -Infinity;
  return (guid) => {
    if (!isPlayerGuid(guid)) return false;
    if (known.has(guid)) return true;
    if (now() - readAt < refreshMs) return false;
    readAt = now();
    const next = new Set<string>();
    for (const dir of sessionDirs()) {
      const g = readSessionFile(dir)?.character?.guid;
      if (typeof g === "string") next.add(g);
    }
    known = next;
    return known.has(guid);
  };
}

export class WriteGate {
  /** The session's own character, once a row has named it. */
  private self: string | null = null;
  /** Units not written because a foreign player owns or charms them, until they leave view. */
  private readonly hidden = new Set<string>();
  /** Player guids the host knows are the deployment's own before any record names them (`noteOwn`). */
  private readonly ownKnown = new Set<string>();
  /** Player guid -> the name the client cache was answered for it. Operational state: never written. */
  private readonly playerNames = new Map<string, string>();
  /** Name -> the guids answered with it, for the scrub's name lookup. */
  private readonly playersByName = new Map<string, Set<string>>();

  constructor(private readonly ownSession: OwnGuid = () => false) {}

  /** Name the session's own character, when the host learns it before a row does. */
  setSelf(guid: string | null): void {
    if (guid !== null && guid !== "" && guid !== "0") this.self = guid;
  }

  /**
   * Players the session's client was answered names for (`SMSG_NAME_QUERY_RESPONSE`),
   * as guid and name: what the free-text scrub looks for. Own or foreign is
   * asked when a row is written, not here, so a session of the deployment
   * that the index learns of later is never scrubbed.
   */
  notePlayers(players: Iterable<readonly [string, string]>): void {
    for (const [guid, name] of players) {
      if (!isPlayerGuid(guid) || name === "") continue;
      const before = this.playerNames.get(guid);
      if (before === name) continue;
      if (before !== undefined) this.playersByName.get(before)?.delete(guid);
      this.playerNames.set(guid, name);
      let guids = this.playersByName.get(name);
      if (guids === undefined) this.playersByName.set(name, (guids = new Set()));
      guids.add(guid);
    }
  }

  /** A player guid the host knows is another session of the deployment (a seat of the same client), ahead of the index. */
  noteOwn(guid: string): void {
    if (isPlayerGuid(guid)) this.ownKnown.add(guid);
  }

  /** Own: the session's character, or another session of the deployment. Anything else a player guid names is foreign. */
  private own(guid: string): boolean {
    return guid === this.self || this.ownKnown.has(guid) || this.ownSession(guid);
  }

  /**
   * Whether the free-text scrub has anything to do: a player answered, and
   * the session's own character known, so it is never taken for a stranger.
   */
  private scrubbing(): boolean {
    return this.playerNames.size > 0 && this.self !== null;
  }

  /** The row as it may be written, or null when it may not be written at all. */
  gate<S extends StreamName>(stream: S, row: StreamRows[S]): StreamRows[S] | null {
    switch (stream) {
      case "trace":
        return this.gateTrace(row as TraceRow) as StreamRows[S];
      case "nearby":
        return this.gateNearby(row as NearbyRow) as StreamRows[S] | null;
      case "events":
        return this.gateEvents(row as EventRow) as StreamRows[S];
      default:
        return this.gateCalls(row as CallRow) as StreamRows[S];
    }
  }

  // ---------------------------------------------------------------- trace

  /** A player target is its kind only. The character's own chat lines are its own speech and pass. */
  private gateTrace(row: TraceRow): TraceRow {
    if (row.kind !== "key" && row.kind !== "state") return row;
    const data = row.data as { target?: { kind?: unknown } | null } | null | undefined;
    const target = data?.target;
    if (target === undefined || target === null || target.kind !== "player") return row;
    if (Object.keys(target).length === 1) return row;
    return { ...row, data: { ...(row.data as object), target: { kind: "player" } } as TraceRow["data"] };
  }

  // --------------------------------------------------------------- nearby

  /** A unit ref a nearby row may carry: a player's guid cut to its kind. */
  private ref(guid: string | null | undefined): string | null | undefined {
    return typeof guid === "string" && isPlayerGuid(guid) ? PLAYER_REF : guid;
  }

  /** Whether a state says a player other than the session's own character owns or charms the unit. */
  private foreignOwned(s: Partial<NearbyState>): boolean {
    for (const g of [s.ow, s.ch]) if (typeof g === "string" && isPlayerGuid(g) && g !== this.self) return true;
    return false;
  }

  private gateState(s: Partial<NearbyState>): Partial<NearbyState> {
    if (typeof s.tg !== "string" || !isPlayerGuid(s.tg)) return s;
    return { ...s, tg: PLAYER_REF };
  }

  /** The unit as it may be written, or null: never a player, never a foreign player's pet, charm or vehicle. */
  private gateUnit(u: NearbyUnit): NearbyUnit | null {
    if ((u.ty as string) === "player" || isPlayerGuid(u.id)) return null;
    if (this.foreignOwned(u.s)) {
      this.hidden.add(u.id);
      return null;
    }
    this.hidden.delete(u.id);
    const s = this.gateState(u.s);
    return s === u.s ? u : { ...u, s };
  }

  private gateNearby(row: NearbyRow): NearbyRow | null {
    switch (row.kind) {
      case "key": {
        this.setSelf(row.self.guid);
        this.hidden.clear();
        const units: NearbyUnit[] = [];
        for (const u of row.units) {
          const g = this.gateUnit(u);
          if (g !== null) units.push(g);
        }
        return { ...row, self: { ...row.self, target: this.ref(row.self.target) ?? null }, units };
      }
      case "in": {
        const u = this.gateUnit(row.u);
        return u === null ? null : u === row.u ? row : { ...row, u };
      }
      case "self": {
        if (typeof row.self.guid === "string") this.setSelf(row.self.guid);
        if (typeof row.self.target !== "string" || !isPlayerGuid(row.self.target)) return row;
        return { ...row, self: { ...row.self, target: PLAYER_REF } };
      }
      case "tick":
        return row;
      case "out":
        // A hidden unit was never written in, so its leaving is not written either.
        if (this.hidden.delete(row.id) || isPlayerGuid(row.id)) return null;
        return row;
      case "st": {
        if (isPlayerGuid(row.id) || this.hidden.has(row.id)) return null;
        if (this.foreignOwned(row.s)) {
          // Taken by a foreign player while in view: it leaves the record here,
          // and stays out until it leaves view and comes back.
          this.hidden.add(row.id);
          return { ts: row.ts, kind: "out", id: row.id };
        }
        const s = this.gateState(row.s);
        return s === row.s ? row : { ...row, s };
      }
      default:
        return isPlayerGuid(row.id) || this.hidden.has(row.id) ? null : row;
    }
  }

  // --------------------------------------------------------------- events

  /** Own member guids kept, the rest counted; a foreign leader left out. */
  private gateGroup<G extends { leaderGuid?: string; members: string[]; foreign: number }>(g: G): G {
    const members: string[] = [];
    let foreign = g.foreign;
    for (const m of g.members) {
      if (this.own(m)) members.push(m);
      else foreign++;
    }
    const out: G = { ...g, members, foreign };
    if (out.leaderGuid !== undefined && !this.own(out.leaderGuid)) delete out.leaderGuid;
    return out;
  }

  private gateEvents(row: EventRow): EventRow {
    if (row.kind === "group") return this.gateGroup(row);
    if (row.kind === "key") {
      const group = row.state.group;
      if (group === null) return row;
      const state: EventsState = { ...row.state, group: this.gateGroup(group) };
      return { ...row, state };
    }
    if (row.kind === "kill" && row.killerGuid !== undefined && isPlayerGuid(row.killerGuid) && !this.own(row.killerGuid)) {
      const { killerGuid: _foreign, ...rest } = row;
      return rest;
    }
    return row;
  }

  // ---------------------------------------------------------------- calls

  /**
   * A move aimed at a foreign player keeps its destination and loses its
   * target. The free text of every other row is scrubbed (`scrubValue`): a
   * call's arguments, a result's text, the action log, a served batch, and
   * the calls a key row restates.
   */
  private gateCalls(row: CallRow): CallRow {
    switch (row.kind) {
      case "move": {
        if (row.target === null || !isPlayerGuid(row.target) || this.own(row.target)) return row;
        const { name: _name, ...rest } = row;
        return { ...rest, target: null };
      }
      case "key": {
        const open = this.scrubValue(row.open);
        return open === row.open ? row : { ...row, open };
      }
      case "call": {
        const args = this.scrubValue(row.args);
        return args === row.args ? row : { ...row, args };
      }
      case "result": {
        const text = this.scrubText(row.text);
        return text === row.text ? row : { ...row, text };
      }
      case "actions": {
        const actions = this.scrubValue(row.actions);
        return actions === row.actions ? row : { ...row, actions };
      }
      case "events": {
        const events = this.scrubValue(row.events);
        return events === row.events ? row : { ...row, events };
      }
      default:
        return row;
    }
  }

  /** Whether a token of free text names a foreign player: a guid the client cache answered, or the name it answered. */
  private foreignToken(token: string): boolean {
    const first = token.charCodeAt(0);
    if (first >= 0x30 && first <= 0x39) return this.playerNames.has(token) && !this.own(token);
    const guids = this.playersByName.get(token);
    if (guids === undefined) return false;
    for (const g of guids) if (!this.own(g)) return true;
    return false;
  }

  /**
   * Free text with each whole token that names a foreign player replaced by
   * `"player"`: a run of digits that is such a guid, a run of letters that is
   * such a name (case as the server answered it). Best-effort over prose: a
   * number or a word that happens to equal one is replaced too, and a name
   * spelled any other way is missed. The same string when nothing matched.
   */
  private scrubText(text: string): string {
    if (!this.scrubbing()) return text;
    let changed = false;
    const out = text.replace(TOKEN_RE, (token) => {
      if (!this.foreignToken(token)) return token;
      changed = true;
      return PLAYER_REF;
    });
    return changed ? out : text;
  }

  /** A JSON value with every string in it, keys included, through `scrubText`; the same value when nothing changed. */
  private scrubValue<T>(value: T): T {
    if (!this.scrubbing()) return value;
    if (typeof value === "string") return this.scrubText(value) as T;
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < value.length; i++) {
        const v = this.scrubValue(value[i] as unknown);
        if (v !== value[i]) (out ??= [...value])[i] = v;
      }
      return (out ?? value) as T;
    }
    let changed = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]): [string, unknown] => {
      const key = this.scrubText(k);
      const scrubbed = this.scrubValue(v);
      if (key !== k || scrubbed !== v) changed = true;
      return [key, scrubbed];
    });
    return changed ? (Object.fromEntries(entries) as T) : value;
  }
}

/** The tokens free text is scrubbed by: a run of ASCII digits (a guid as the surface prints it) or of letters (a name). */
const TOKEN_RE = /[0-9]+|\p{L}+/gu;
