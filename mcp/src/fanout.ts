/**
 * Fan-out: one MCP client driving several characters.
 *
 * It is a grant, as the GM opt-in is: only whoever holds the port secret can
 * give it, because each character is one more lease on one more account
 * (`module/PROTOCOL.md`, "Authentication": one token, one account, one
 * character, and one live session per account). `FanoutGrant` is that grant
 * as the host holds it: how many characters at once, on which accounts.
 * Nothing in it names a user; whoever hosts several users builds one grant
 * per user and one roster per grant.
 *
 * Three pieces, each usable without the others' wording:
 *
 * - `CharacterRoster` owns the seats: it picks an account, leases a token
 *   for it, opens the seat in the sandbox, keeps the seat's session record,
 *   and gives all of it back at logout. It remembers which account and token
 *   a character lives on, so a name is a stable handle across a restart.
 * - `fanoutTools` is the tool surface above fan-out 1: the core five, the
 *   three that act on a character gaining an optional `character`, and
 *   `login_character`, `logout_character` and `list_characters`. The list is
 *   a function of the grant and never changes while it stands. At fan-out 1
 *   none of this is served: a host builds `coreTools` exactly as before.
 * - The summaries a model reads when it names no character: a roll-up of
 *   every character's state and one merged event feed. The mechanism is here
 *   with a plain default wording (`PLAIN_FANOUT_RENDER`); how a harness words
 *   them is its own context policy, as `CoreToolRender` is.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { leaseRunSecret, logoutSession, releaseSessionSecret } from "./module-auth";
import type { SessionWriter } from "./record/writer";
import type { EvalLink, SeatSpec, SeatView, SnippetResult } from "./sandbox/host";
import type { EventSummary, SeatOpened } from "./sandbox/ipc";
import {
  booleanish,
  coreTools,
  foldedNote,
  recentEventsScan,
  serveEvents,
  snippetToolResult,
  type CallOrigin,
  type CallRecord,
  type CoreToolContext,
  type CoreToolName,
  type CoreToolRender,
  type ToolResult,
  type ToolSpec,
} from "./tools";

// ------------------------------------------------------------------ grant

/** The most characters one client may be granted. */
export const MAX_CHARACTERS_LIMIT = 40;

/**
 * What the operator granted one client: how many characters it may have in
 * the world at once, and the accounts they live on. One account holds one
 * live session, so the characters logged in at once are at most the accounts.
 */
export interface FanoutGrant {
  maxCharacters: number;
  accounts: readonly string[];
  /** The GM opt-in, for every lease this grant takes. Off unless true. */
  allowGm?: boolean;
}

/** Why a grant cannot stand, or null when it can. */
export function fanoutGrantProblem(g: FanoutGrant): string | null {
  if (!Number.isInteger(g.maxCharacters) || g.maxCharacters < 1 || g.maxCharacters > MAX_CHARACTERS_LIMIT) {
    return `the character count is a whole number from 1 to ${MAX_CHARACTERS_LIMIT}`;
  }
  const upper = g.accounts.map((a) => a.toUpperCase());
  if (new Set(upper).size !== upper.length) return "an account is listed twice: the module holds one session per account";
  if (g.maxCharacters > 1 && g.accounts.length < g.maxCharacters) {
    return `${g.maxCharacters} characters at once need ${g.maxCharacters} accounts (one live session per account), and ${g.accounts.length} ${g.accounts.length === 1 ? "is" : "are"} granted`;
  }
  return null;
}

// ----------------------------------------------------------------- roster

/** Where a character lives, as the roster remembers it: never shown to a model. */
export interface RosterEntry {
  character: string;
  account: string;
  token: string;
  /** Logged in when this was last written, so a resumed host brings it back. */
  in: boolean;
}

/** A character as a tool may show it. */
export interface CharacterView {
  character: string;
  /** `in` the world on a seat, `detached` (its seat did not come back from a restart), or `out` (known, not logged in). */
  state: "in" | "detached" | "out";
  error?: string;
}

export interface LoginRequest {
  name: string;
  race?: number | undefined;
  class?: number | undefined;
  gender?: number | undefined;
}

export type LoginOutcome = { ok: true; character: string; guid: string } | { ok: false; error: string };

/** What the roster needs of the sandbox: its host, or a stand-in. */
export interface FanoutSandbox {
  openSeat(spec: SeatSpec): Promise<SeatOpened>;
  closeSeat(character: string, o: { logout: boolean }): Promise<void>;
  seatViews(): SeatView[];
  evalSnippet(code: string, link?: EvalLink, character?: string): Promise<SnippetResult>;
  recentEvents(limit: number, character?: string): Promise<EventSummary[]>;
  recentEventsAll(limit: number): Promise<Record<string, EventSummary[]>>;
  stateSnapshot(character?: string): Promise<Record<string, unknown>>;
  stateSnapshots(): Promise<Record<string, Record<string, unknown>>>;
}

/** What the fan-out tools need: the roster, or a stand-in. */
export interface FanoutSurface {
  readonly maxCharacters: number;
  readonly sandbox: Pick<FanoutSandbox, "evalSnippet" | "recentEvents" | "recentEventsAll" | "stateSnapshot" | "stateSnapshots">;
  login(req: LoginRequest): Promise<LoginOutcome>;
  logout(character: string): Promise<{ ok: true } | { ok: false; error: string }>;
  views(): CharacterView[];
  /** The record's side of a call that concerns particular characters. Absent records nothing. */
  readonly calls?: FanoutCalls | undefined;
}

export interface CharacterRosterOptions {
  grant: FanoutGrant;
  moduleUrl: string;
  sandbox: FanoutSandbox;
  /** Every lease secret is registered here before its seat exists, as the single character's is. */
  secrets: { redact(secret: string | undefined): void };
  /** Characters whose account and token are already known: a resumed host's own, or ones an operator staged. */
  known?: readonly RosterEntry[];
  /** Called with every entry whenever one changes, so the host can keep them (mode 0600: they hold tokens). */
  onChange?: (entries: RosterEntry[]) => void;
  /**
   * The session record of a seat, opened: asked for once its character is in
   * the world. The roster closes it when the character logs out and when it
   * shuts down. Absent records nothing.
   */
  record?: (seat: { character: string; guid: string; token: string }) => SessionWriter | undefined;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  newToken?: () => string;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The seats of one grant. Every change goes through one queue, so two logins
 * cannot pick the same account.
 */
export class CharacterRoster implements FanoutSurface {
  readonly maxCharacters: number;
  readonly sandbox: FanoutSandbox;
  readonly calls: FanoutCalls;
  private readonly entries = new Map<string, RosterEntry>();
  private readonly writers = new Map<string, SessionWriter>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: CharacterRosterOptions) {
    const problem = fanoutGrantProblem(o.grant);
    if (problem !== null) throw new Error(problem);
    this.maxCharacters = o.grant.maxCharacters;
    this.sandbox = o.sandbox;
    for (const e of o.known ?? []) this.entries.set(e.character, { ...e });
    this.calls = new FanoutCalls(this.writers);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private changed(): void {
    try {
      this.o.onChange?.(this.snapshot());
    } catch {
      // A roster that cannot be written costs a resume its names, never a login.
    }
  }

  /** Every entry, as `onChange` is handed them. */
  snapshot(): RosterEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  /** The writers of the seats in the world, by character: what a call is recorded into. */
  sessionWriters(): ReadonlyMap<string, SessionWriter> {
    return this.writers;
  }

  private entryFor(name: string): RosterEntry | undefined {
    for (const e of this.entries.values()) if (sameName(e.character, name)) return e;
    return undefined;
  }

  views(): CharacterView[] {
    const seats = this.sandbox.seatViews();
    const out: CharacterView[] = seats.map((s) => (s.attached ? { character: s.character, state: "in" as const } : { character: s.character, state: "detached" as const, ...(s.error !== undefined ? { error: s.error } : {}) }));
    for (const e of this.entries.values()) if (!seats.some((s) => s.character === e.character)) out.push({ character: e.character, state: "out" });
    return out;
  }

  login(req: LoginRequest): Promise<LoginOutcome> {
    return this.serial(() => this.loginNow(req, false));
  }

  private async loginNow(req: LoginRequest, resuming: boolean): Promise<LoginOutcome> {
    const name = req.name.trim();
    if (name.length === 0) return { ok: false, error: "a character needs a name" };
    let seats = this.sandbox.seatViews();
    const held = seats.find((s) => sameName(s.character, name));
    if (held?.attached === true) return { ok: false, error: `${held.character} is already logged in` };
    // A seat that did not come back from a restart is dropped and opened again.
    if (held !== undefined) {
      await this.sandbox.closeSeat(held.character, { logout: false });
      seats = this.sandbox.seatViews();
    }
    if (seats.length >= this.maxCharacters) {
      return { ok: false, error: `${seats.length} of ${this.maxCharacters} characters are logged in; log one out first (logout_character)` };
    }
    const known = this.entryFor(name);
    const busy = new Set(seats.map((s) => s.account?.toUpperCase()));
    let account: string | undefined;
    if (known !== undefined) {
      if (busy.has(known.account.toUpperCase())) {
        const other = seats.find((s) => s.account?.toUpperCase() === known.account.toUpperCase());
        return { ok: false, error: `${known.character} shares its account with ${other?.character ?? "another character"}, which is logged in; log that one out first` };
      }
      account = known.account;
    } else {
      // A character nobody has logged in before: an account no known character lives on first.
      const homes = new Set([...this.entries.values()].map((e) => e.account.toUpperCase()));
      const free = this.o.grant.accounts.filter((a) => !busy.has(a.toUpperCase()));
      account = free.find((a) => !homes.has(a.toUpperCase())) ?? free[0];
    }
    if (account === undefined) return { ok: false, error: "every granted account has a character logged in; log one out first (logout_character)" };
    const token = known?.token ?? (this.o.newToken ?? (() => randomBytes(16).toString("hex")))();
    const call = { moduleUrl: this.o.moduleUrl, token, ...(this.o.env !== undefined ? { env: this.o.env } : {}), ...(this.o.fetch !== undefined ? { fetch: this.o.fetch } : {}) };
    let opened: SeatOpened;
    try {
      const lease = await leaseRunSecret({ ...call, account, ...(this.o.grant.allowGm === true ? { allowGm: true } : {}) }, this.o.secrets);
      const create = { ...(req.race !== undefined ? { race: req.race } : {}), ...(req.class !== undefined ? { class: req.class } : {}), ...(req.gender !== undefined ? { gender: req.gender } : {}) };
      opened = await this.sandbox.openSeat({
        character: known?.character ?? name,
        token,
        secret: lease.secret,
        account,
        ...(Object.keys(create).length > 0 ? { create } : {}),
        // A character that was logged in when the roster was last written may be in the world still.
        reattach: known?.in === true,
        writer: (o) => {
          const w = this.o.record?.({ character: o.character, guid: o.guid, token });
          if (w !== undefined) this.writers.set(o.character, w);
          return w;
        },
      });
    } catch (err) {
      // A token nobody will present again gives its lease back.
      if (known === undefined) await releaseSessionSecret(call);
      if (resuming && known !== undefined) {
        known.in = false;
        this.changed();
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (known !== undefined && known.character !== opened.character) this.entries.delete(known.character);
    this.entries.set(opened.character, { character: opened.character, account, token, in: true });
    this.changed();
    return { ok: true, character: opened.character, guid: opened.guid };
  }

  logout(character: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.serial(async () => {
      const seat = this.sandbox.seatViews().find((s) => s.character === character);
      if (seat === undefined) return { ok: false as const, error: unknownCharacter(character, this.views()) };
      await this.release(character, true);
      return { ok: true as const };
    });
  }

  /** Close one seat and its record; with `logout`, log the character out and give its lease back. */
  private async release(character: string, logout: boolean): Promise<void> {
    await this.sandbox.closeSeat(character, { logout });
    const entry = this.entries.get(character);
    if (entry !== undefined && logout) {
      const call = { moduleUrl: this.o.moduleUrl, token: entry.token, ...(this.o.env !== undefined ? { env: this.o.env } : {}), ...(this.o.fetch !== undefined ? { fetch: this.o.fetch } : {}) };
      // With the port secret as well: it works however the child answered.
      await logoutSession(call);
      await releaseSessionSecret(call);
      entry.in = false;
      this.changed();
    }
    const writer = this.writers.get(character);
    if (writer !== undefined) {
      this.writers.delete(character);
      this.calls.retire(writer);
    }
  }

  /**
   * Bring back every character that was logged in when the entries were last
   * written (a resumed host). One that does not come back is marked out and
   * named in what this returns; nothing throws.
   */
  resume(): Promise<{ character: string; error: string }[]> {
    return this.serial(async () => {
      const failed: { character: string; error: string }[] = [];
      for (const e of this.snapshot().filter((x) => x.in)) {
        const r = await this.loginNow({ name: e.character }, true);
        if (!r.ok) failed.push({ character: e.character, error: r.error });
      }
      return failed;
    });
  }

  /**
   * Give every seat back, once the sandbox has stopped: close each record
   * and, with `logout`, log each character out and release its lease, with
   * the port secret, so a wedged child cannot hold a character in the world.
   * Without it the sessions stay where they are and the entries still say
   * `in`, for a host that will resume them.
   */
  shutdown(o: { logout: boolean }): Promise<void> {
    return this.serial(async () => {
      const names = new Set([...this.writers.keys(), ...this.sandbox.seatViews().map((s) => s.character), ...[...this.entries.values()].filter((e) => e.in).map((e) => e.character)]);
      for (const character of names) await this.release(character, o.logout);
      await this.calls.closeRetired();
    });
  }
}

function unknownCharacter(character: string, views: readonly CharacterView[]): string {
  const there = views.filter((v) => v.state === "in").map((v) => v.character);
  const detached = views.find((v) => v.character === character && v.state === "detached");
  if (detached !== undefined) {
    return `${character} is not attached${detached.error !== undefined ? ` (${detached.error})` : ""}; log it in again with login_character`;
  }
  return `unknown character: ${character}. ${there.length > 0 ? `Logged in: ${there.join(", ")}.` : "No character is logged in; use login_character."}`;
}

// -------------------------------------------------------------- call record

/** How many calls' targets are remembered between a call and its result. */
const OPEN_CALLS_MAX = 256;

/**
 * The session record's side of a tool call at fan-out above 1. A call that
 * names a character is written to that character's record; one that names
 * none (a roll-up, the scratchpad, a snippet over `chars`) is written to
 * every record open at the time, so each session's `calls` stream holds
 * every call its character could have acted under and reads alone. All of
 * them carry the same id, the call's dispatch stamp.
 */
export class FanoutCalls implements CallRecord {
  private readonly open = new Map<number, Set<SessionWriter>>();
  private readonly retired: SessionWriter[] = [];
  private last = 0;

  constructor(private readonly writers: ReadonlyMap<string, SessionWriter>) {}

  call(tool: string, args: unknown, dispatchTs?: number): number {
    const at = dispatchTs ?? Date.now();
    const id = at > this.last ? at : this.last + 1;
    this.last = id;
    const named = args !== null && typeof args === "object" ? (args as { character?: unknown }).character : undefined;
    const one = typeof named === "string" ? this.writers.get(named) : undefined;
    const targets = new Set(one !== undefined ? [one] : this.writers.values());
    for (const w of targets) w.call(tool, args, id);
    this.open.set(id, targets);
    this.rows.set(id, { tool, args });
    for (const key of this.open.keys()) {
      if (this.open.size <= OPEN_CALLS_MAX) break;
      this.open.delete(key);
      this.rows.delete(key);
    }
    return id;
  }

  private readonly rows = new Map<number, { tool: string; args: unknown }>();

  /** A record that opened under call `id` (a login's own seat) is given the call too. */
  adopt(id: number | undefined, character: string): void {
    if (id === undefined) return;
    const w = this.writers.get(character);
    const targets = this.open.get(id);
    const row = this.rows.get(id);
    if (w === undefined || targets === undefined || row === undefined || targets.has(w)) return;
    w.call(row.tool, row.args, id);
    targets.add(w);
  }

  result(id: number, result: ToolResult): void {
    for (const w of this.open.get(id) ?? []) w.result(id, result);
    this.open.delete(id);
    this.rows.delete(id);
    void this.closeRetired();
  }

  /** Unused at fan-out above 1: a served batch is one character's (`eventsServedFor`). */
  eventsServed(): void {}

  /** An event batch call `id` served from one character's stream. */
  eventsServedFor(character: string, id: number | undefined, events: EventSummary[], folded?: number): void {
    this.writers.get(character)?.eventsServed(id, events, folded);
  }

  /** A record whose character logged out: closed once the call that logged it out has its result in it. */
  retire(writer: SessionWriter): void {
    this.retired.push(writer);
    // A host that records no calls never reaches `result`.
    setTimeout(() => void this.closeRetired(), 2_000).unref?.();
  }

  async closeRetired(): Promise<void> {
    const closing = this.retired.splice(0, this.retired.length);
    await Promise.all(closing.map((w) => w.close().catch(() => undefined)));
  }
}

// ---------------------------------------------------------------- roll-up

/** One character's state, reduced to what a roll-up counts. Read off the state snapshot, nothing new observed. */
export interface CharacterDigest {
  character: string;
  /** In the world: its own guid has been observed. */
  inWorld: boolean;
  /** Its event stream is open. */
  connected: boolean;
  level: number | null;
  health: { current: number; max: number } | null;
  power: { current: number; max: number } | null;
  /** The power bar is mana (`powerType` 0), when the snapshot says. */
  mana: boolean;
  dead: boolean;
  inCombat: boolean;
  casting: boolean;
  map: number | null;
  x: number | null;
  y: number | null;
  zone: string | null;
  /** The last move's verdict when it was not an arrival: `too_far`, `interrupted`, … */
  moveRefused: string | null;
}

const valueOf = (v: unknown): unknown => (v !== null && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function bar(v: unknown): { current: number; max: number } | null {
  const b = valueOf(v) as { current?: unknown; max?: unknown } | undefined | null;
  const current = num(b?.current);
  const max = num(b?.max);
  return current === null || max === null ? null : { current, max };
}

/** Verdicts of a move that are not a refusal: it got there, or the character itself ended it. */
const MOVE_ENDED_OK = new Set(["arrived", "stopped", "superseded"]);

export function digestCharacter(character: string, snapshot: Record<string, unknown>): CharacterDigest {
  const self = (snapshot["self"] ?? {}) as Record<string, unknown>;
  const pos = valueOf(self["position"]) as { map?: unknown; x?: unknown; y?: unknown } | undefined | null;
  const zone = valueOf(self["zone"]) as { name?: unknown } | undefined | null;
  const fields = (self["fields"] ?? {}) as Record<string, unknown>;
  const health = bar(self["health"]);
  const move = snapshot["move"] as { status?: unknown } | null | undefined;
  const status = typeof move?.status === "string" ? move.status : null;
  return {
    character,
    inWorld: self["guid"] !== undefined && self["guid"] !== null,
    connected: (snapshot["observation"] as { connected?: unknown } | undefined)?.connected === true,
    level: num(valueOf(self["level"])),
    health,
    power: bar(self["power"]),
    mana: num(valueOf(fields["powerType"])) === 0,
    dead: valueOf(self["ghost"]) === true || (health !== null && health.current === 0),
    inCombat: valueOf(self["inCombat"]) === true,
    casting: valueOf(self["casting"]) !== undefined && valueOf(self["casting"]) !== null,
    map: num(pos?.map),
    x: num(pos?.x),
    y: num(pos?.y),
    zone: typeof zone?.name === "string" ? zone.name : null,
    moveRefused: status !== null && !MOVE_ENDED_OK.has(status) ? status : null,
  };
}

/** What a roll-up measures against. Plain defaults; a harness's own rendering picks its own. */
export const ROLLUP = {
  /** Health at or below this share is an exception. */
  LOW_HEALTH: 0.35,
  /** Mana at or below this share counts as out of power. */
  OUT_OF_POWER: 0.1,
  /** Farther than this (yards, on the map plane) from where most of the group stands is an exception. */
  FAR_YARDS: 100,
} as const;

/** Where most of the characters are: the map most of them stand on, and the median point of those. */
export function groupCentre(digests: readonly CharacterDigest[]): { map: number; x: number; y: number; count: number } | null {
  const placed = digests.filter((d): d is CharacterDigest & { map: number; x: number; y: number } => d.inWorld && d.map !== null && d.x !== null && d.y !== null);
  if (placed.length === 0) return null;
  const byMap = new Map<number, typeof placed>();
  for (const d of placed) byMap.set(d.map, [...(byMap.get(d.map) ?? []), d]);
  const [map, on] = [...byMap.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]!;
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  return { map, x: median(on.map((d) => d.x)), y: median(on.map((d) => d.y)), count: on.length };
}

/** What is unusual about one character, as short phrases; empty when nothing is. */
export function exceptionsOf(d: CharacterDigest, centre: ReturnType<typeof groupCentre>): string[] {
  if (!d.inWorld) return ["not in the world"];
  const out: string[] = [];
  if (!d.connected) out.push("disconnected");
  if (d.dead) out.push("dead");
  else if (d.health !== null && d.health.max > 0 && d.health.current / d.health.max <= ROLLUP.LOW_HEALTH) {
    out.push(`health ${Math.round((100 * d.health.current) / d.health.max)}%`);
  }
  if (centre !== null && d.map !== null && d.x !== null && d.y !== null) {
    if (d.map !== centre.map) out.push(`on map ${d.map}`);
    else {
      const far = Math.hypot(d.x - centre.x, d.y - centre.y);
      if (far > ROLLUP.FAR_YARDS) out.push(`${Math.round(far)}y from the group`);
    }
  }
  if (d.moveRefused !== null) out.push(`last move ${d.moveRefused}`);
  return out;
}

/** How a harness words what a model reads when it names no character. */
export interface FanoutRender {
  /** `state_summary` with no `character`. */
  rollup(digests: readonly CharacterDigest[], o: { maxCharacters: number; views: readonly CharacterView[] }): string;
  /** What a merged feed's line ends with: who saw the event. */
  seenBy(names: readonly string[]): string;
  /** `list_characters`. */
  list(views: readonly CharacterView[], digests: readonly CharacterDigest[], o: { maxCharacters: number }): string;
}

const NO_CHARACTERS = "No character is logged in; use login_character.";

function plainRollup(digests: readonly CharacterDigest[], o: { maxCharacters: number; views: readonly CharacterView[] }): string {
  const detached = o.views.filter((v) => v.state === "detached");
  if (digests.length === 0 && detached.length === 0) return NO_CHARACTERS;
  const world = digests.filter((d) => d.inWorld);
  const count = (f: (d: CharacterDigest) => boolean): number => world.filter(f).length;
  const lines = [
    `${digests.length} of ${o.maxCharacters} characters logged in: ${count((d) => !d.dead)} alive, ${count((d) => d.dead)} dead, ` +
      `${count((d) => d.inCombat)} in combat, ${count((d) => d.casting)} casting, ` +
      `${count((d) => d.mana && d.power !== null && d.power.max > 0 && d.power.current / d.power.max <= ROLLUP.OUT_OF_POWER)} out of mana`,
  ];
  const centre = groupCentre(digests);
  if (centre !== null) {
    const zones = [...new Set(world.filter((d) => d.map === centre.map && d.zone !== null).map((d) => d.zone))];
    lines.push(`group: ${centre.count} on map ${centre.map} around (${centre.x.toFixed(0)}, ${centre.y.toFixed(0)})${zones.length === 1 ? `, ${zones[0]}` : ""}`);
  }
  const exceptions = digests.map((d) => ({ d, why: exceptionsOf(d, centre) })).filter((e) => e.why.length > 0);
  for (const e of exceptions) lines.push(`${e.d.character}: ${e.why.join(", ")}`);
  for (const v of detached) lines.push(`${v.character}: not attached${v.error !== undefined ? ` (${v.error})` : ""}`);
  if (exceptions.length === 0 && detached.length === 0) lines.push("no exceptions");
  return lines.join("\n");
}

function plainList(views: readonly CharacterView[], digests: readonly CharacterDigest[], o: { maxCharacters: number }): string {
  const byName = new Map(digests.map((d) => [d.character, d]));
  const lines: string[] = [];
  for (const v of views.filter((x) => x.state !== "out")) {
    const d = byName.get(v.character);
    if (v.state === "detached") {
      lines.push(`${v.character}: not attached${v.error !== undefined ? ` (${v.error})` : ""}`);
      continue;
    }
    const parts = [
      d?.level !== null && d?.level !== undefined ? `level ${d.level}` : null,
      d?.health !== null && d?.health !== undefined ? `health ${d.health.current}/${d.health.max}` : null,
      d?.map !== null && d?.map !== undefined ? `map ${d.map}${d.zone !== null ? ` (${d.zone})` : ""}` : null,
      d?.dead === true ? "dead" : null,
      d !== undefined && !d.connected ? "disconnected" : null,
    ].filter((p): p is string => p !== null);
    lines.push(`${v.character}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`);
  }
  const inNow = views.filter((x) => x.state !== "out").length;
  lines.push(`${inNow} of ${o.maxCharacters} characters logged in.`);
  const out = views.filter((x) => x.state === "out").map((x) => x.character);
  if (out.length > 0) lines.push(`Not logged in: ${out.join(", ")}.`);
  return lines.join("\n");
}

/** The bare stack's wording: plain and neutral. A harness's own is its context policy. */
export const PLAIN_FANOUT_RENDER: FanoutRender = {
  rollup: plainRollup,
  seenBy: (names) => (names.length === 1 ? ` [${names[0]}]` : ` [seen by ${names.length}]`),
  list: plainList,
};

// ------------------------------------------------------------ merged feed

/** Two characters' copies of one event are the same event when they arrive within this of each other. */
export const MERGE_WINDOW_MS = 2_000;

export interface MergedEvent {
  /** The event as the first character to receive it was served it. */
  event: EventSummary;
  /** Who received it, in the order they did. */
  seenBy: string[];
}

/**
 * One feed from several characters' events: an event several of them
 * received is one entry naming who saw it. Two copies are the same event
 * when their opcode and their served data are identical and they arrived
 * within `MERGE_WINDOW_MS`; anything that differs per receiver (a block
 * flagged as the receiver's own) stays apart, which is the honest reading.
 * Ordered by arrival.
 */
export function mergeEvents(perCharacter: Readonly<Record<string, readonly EventSummary[]>>): MergedEvent[] {
  const all: { name: string; event: EventSummary; order: number }[] = [];
  let order = 0;
  for (const [name, events] of Object.entries(perCharacter)) for (const event of events) all.push({ name, event, order: order++ });
  all.sort((a, b) => a.event.ts - b.event.ts || a.order - b.order);
  const out: MergedEvent[] = [];
  const latest = new Map<string, MergedEvent>();
  for (const { name, event } of all) {
    const key = `${event.opcode}\n${JSON.stringify(event.data)}\n${event.note ?? ""}`;
    const prev = latest.get(key);
    if (prev !== undefined && event.ts - prev.event.ts <= MERGE_WINDOW_MS && !prev.seenBy.includes(name)) {
      prev.seenBy.push(name);
      continue;
    }
    const merged: MergedEvent = { event, seenBy: [name] };
    latest.set(key, merged);
    out.push(merged);
  }
  return out;
}

// ------------------------------------------------------------------ tools

/** A tool context at fan-out above 1: the core's, and the roster. */
export interface FanoutToolContext extends CoreToolContext {
  fanout: FanoutSurface;
}

export type FanoutToolName = CoreToolName | "login_character" | "logout_character" | "list_characters";

/** The fan-out tools in the order the bare stack serves them. A harness orders them among its own. */
export const FANOUT_TOOL_ORDER: readonly FanoutToolName[] = [
  "run_snippet",
  "recent_events",
  "state_summary",
  "write_scratchpad",
  "edit_scratchpad",
  "login_character",
  "logout_character",
  "list_characters",
];

const CHARACTER_PARAM = {
  type: "string",
  description: "A logged-in character's name, exactly as list_characters shows it.",
} as const;

/** `character` checked against the roster: the name when it is logged in, else the refusal. */
function resolveCharacter(ctx: FanoutToolContext, character: string): { ok: true; character: string } | { ok: false; result: ToolResult } {
  const views = ctx.fanout.views();
  if (views.some((v) => v.character === character && v.state === "in")) return { ok: true, character };
  return { ok: false, result: { text: unknownCharacter(character, views), isError: true } };
}

/** With a property added to its `properties`, in place after the ones it has. */
function withProperty(inputSchema: Record<string, unknown>, name: string, prop: unknown): Record<string, unknown> {
  return { ...inputSchema, properties: { ...(inputSchema["properties"] as Record<string, unknown>), [name]: prop } };
}

/**
 * The tools a client granted more than one character is served: the core
 * five, with `character` on the three that act on one, and the three that
 * change who is logged in. The scratchpad pair is the core's own, unchanged:
 * there is one scratchpad per client, not one per character.
 */
export function fanoutTools<C extends FanoutToolContext>(render: CoreToolRender<C>, fan: FanoutRender = PLAIN_FANOUT_RENDER): Record<FanoutToolName, ToolSpec<C>> {
  const core = coreTools(render);
  const digests = async (ctx: C): Promise<CharacterDigest[]> => {
    if (!ctx.fanout.views().some((v) => v.state === "in")) return [];
    return Object.entries(await ctx.fanout.sandbox.stateSnapshots()).map(([name, snap]) => digestCharacter(name, snap));
  };
  return {
    run_snippet: {
      def: {
        name: "run_snippet",
        description:
          core.run_snippet.def.description +
          " With `character`, `sdk`, `state` and `events` are that character's for this snippet and for anything it leaves running. `chars` holds every logged-in character by name, each with its own `sdk`, `state` and `events`, so one snippet can act for several.",
        inputSchema: withProperty(core.run_snippet.def.inputSchema, "character", CHARACTER_PARAM),
      },
      schema: z.strictObject({ code: z.string().min(1), character: z.string().min(1).optional() }),
      help: "run_snippet expects { code: string, character?: string } — the TypeScript source to evaluate, and the logged-in character whose sdk, state and events it gets.",
      ...(core.run_snippet.aliases !== undefined ? { aliases: core.run_snippet.aliases } : {}),
      run: async (ctx, args, origin) => {
        const { code, character } = args as { code: string; character?: string };
        if (character !== undefined) {
          const who = resolveCharacter(ctx, character);
          if (!who.ok) return who.result;
        }
        const res = await ctx.fanout.sandbox.evalSnippet(code, { callTs: origin.dispatchTs, turn: ctx.turn() }, character);
        return snippetToolResult(ctx, res, render);
      },
    },
    recent_events: {
      def: {
        name: "recent_events",
        description:
          core.recent_events.def.description +
          " With `character`, that character's events. Without, one feed merged from every logged-in character's: an event several of them received is one line ending with how many saw it, and an event one of them received ends with its name.",
        inputSchema: withProperty(core.recent_events.def.inputSchema, "character", CHARACTER_PARAM),
      },
      schema: z
        .strictObject({
          limit: z.coerce
            .number()
            .transform((n) => Math.min(200, Math.max(1, Math.round(n))))
            .default(50),
          includeMovement: booleanish.default(false),
          character: z.string().min(1).optional(),
        })
        .prefault({}),
      help:
        "recent_events expects { limit?: number, includeMovement?: boolean, character?: string } — how many events to return " +
        "(1-200, default 50, counted after ambient movement is folded out), whether to include ambient " +
        "movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*; default false), and the logged-in character whose events to return (default: one feed merged from all of them).",
      ...(core.recent_events.aliases !== undefined ? { aliases: core.recent_events.aliases } : {}),
      run: async (ctx, args, origin) => {
        const { limit, includeMovement, character } = args as { limit: number; includeMovement: boolean; character?: string };
        const scan = recentEventsScan(limit, includeMovement);
        if (character !== undefined) {
          const who = resolveCharacter(ctx, character);
          if (!who.ok) return who.result;
          const served = serveEvents(await ctx.fanout.sandbox.recentEvents(scan, character), limit, includeMovement, render);
          ctx.onEventsServed?.(served.visible, served.folded);
          ctx.fanout.calls?.eventsServedFor(character, origin.dispatchTs, served.visible, served.folded);
          return { text: served.text };
        }
        if (!ctx.fanout.views().some((v) => v.state === "in")) return { text: NO_CHARACTERS };
        const scanned = await ctx.fanout.sandbox.recentEventsAll(scan);
        // Each character's own fold first, uncut, so the merge sees every signal event of the span.
        const ambient = (e: EventSummary): boolean => render.isAmbient(e.opcode);
        const shown = (e: EventSummary): boolean => includeMovement || (!ambient(e) && e.bystander !== true);
        const kept: Record<string, EventSummary[]> = {};
        for (const [name, events] of Object.entries(scanned)) kept[name] = events.filter(shown);
        const merged = mergeEvents(kept);
        const visible = merged.slice(-limit);
        // The span the reply covers, as for one character: from the oldest line shown when the limit cut it.
        const from = visible.length < limit || visible.length === 0 ? -Infinity : visible[0]!.event.ts;
        let folded = 0;
        if (!includeMovement) for (const events of Object.values(scanned)) folded += events.filter((e) => ambient(e) && e.ts >= from).length;
        const servedTo = new Map<string, EventSummary[]>();
        for (const m of visible) for (const name of m.seenBy) servedTo.set(name, [...(servedTo.get(name) ?? []), m.event]);
        ctx.onEventsServed?.(visible.map((m) => m.event), folded);
        for (const [name, events] of servedTo) ctx.fanout.calls?.eventsServedFor(name, origin.dispatchTs, events);
        const note = foldedNote(folded);
        if (visible.length === 0) return { text: note === undefined ? "no events yet" : `no non-ambient events yet\n${note}` };
        const lines = visible.map((m) => `${render.eventLine(m.event)}${fan.seenBy(m.seenBy)}`);
        if (note !== undefined) lines.push(note);
        return { text: lines.join("\n") };
      },
    },
    state_summary: {
      def: {
        name: "state_summary",
        description:
          "A summary of the cached game state. With `character`, that character's: character, level, position, recent chat and notifications, whether any events were missed. Without, a roll-up of every logged-in character: how many are alive, in combat, casting and out of mana, where the group is, and one line for each character that is an exception (dead, low on health, disconnected, far from the group, its last move refused).",
        inputSchema: withProperty(core.state_summary.def.inputSchema, "character", CHARACTER_PARAM),
      },
      schema: z.strictObject({ character: z.string().min(1).optional() }).default({}),
      help: "state_summary expects { character?: string } — the logged-in character to summarise (default: a roll-up of all of them).",
      run: async (ctx, args) => {
        const { character } = args as { character?: string };
        if (character === undefined) return { text: fan.rollup(await digests(ctx), { maxCharacters: ctx.fanout.maxCharacters, views: ctx.fanout.views() }) };
        const who = resolveCharacter(ctx, character);
        if (!who.ok) return who.result;
        const snapshot = await ctx.fanout.sandbox.stateSnapshot(character);
        const live = (snapshot as { self?: { guid?: unknown } }).self?.guid != null;
        return { text: render.stateSummary(snapshot, { sessionLive: live }) };
      },
    },
    write_scratchpad: core.write_scratchpad,
    edit_scratchpad: core.edit_scratchpad,
    login_character: {
      def: {
        name: "login_character",
        description:
          "Log a character into the world. A character of that name is logged in if one exists; otherwise it is created, and race and class are then required. The name the result gives is the handle every `character` argument takes. Only so many characters may be logged in at once; list_characters says how many.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The character's name: 2-12 letters, no spaces." },
            race: { type: "integer", minimum: 1, maximum: 11, description: "Race id, 1-11. Needed only to create the character." },
            class: { type: "integer", minimum: 1, maximum: 11, description: "Class id, 1-11. Needed only to create the character." },
            gender: { type: "integer", minimum: 0, maximum: 1, description: "0 or 1. Default 0. Used only to create the character." },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({
        name: z.string().min(1),
        race: z.coerce.number().int().min(1).max(11).optional(),
        class: z.coerce.number().int().min(1).max(11).optional(),
        gender: z.coerce.number().int().min(0).max(1).optional(),
      }),
      help: "login_character expects { name: string, race?: number, class?: number, gender?: number } — the character's name, and the numeric race and class ids (1-11) to create it with when no character of that name exists.",
      aliases: { character: "name" },
      run: async (ctx, args, origin: CallOrigin) => {
        const req = args as LoginRequest;
        const r = await ctx.fanout.login(req);
        if (!r.ok) return { text: `login_character failed: ${r.error}`, isError: true };
        ctx.fanout.calls?.adopt(origin.dispatchTs, r.character);
        const inNow = ctx.fanout.views().filter((v) => v.state !== "out").length;
        return { text: `logged in: ${r.character} (guid ${r.guid}). ${inNow} of ${ctx.fanout.maxCharacters} characters logged in.` };
      },
    },
    logout_character: {
      def: {
        name: "logout_character",
        description: "Log a character out of the world, which frees its place for another. The character is saved and can be logged in again by name.",
        inputSchema: {
          type: "object",
          properties: { character: CHARACTER_PARAM },
          required: ["character"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({ character: z.string().min(1) }),
      help: "logout_character expects { character: string } — a logged-in character's name.",
      aliases: { name: "character" },
      run: async (ctx, args) => {
        const { character } = args as { character: string };
        const r = await ctx.fanout.logout(character);
        if (!r.ok) return { text: r.error, isError: true };
        const inNow = ctx.fanout.views().filter((v) => v.state !== "out").length;
        return { text: `logged out: ${character}. ${inNow} of ${ctx.fanout.maxCharacters} characters logged in.` };
      },
    },
    list_characters: {
      def: {
        name: "list_characters",
        description: "The characters logged in now, one line each with level, health and where it is, how many may be logged in at once, and the characters known but not logged in.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      schema: z.strictObject({}).default({}),
      help: "list_characters takes no parameters ({}).",
      run: async (ctx) => {
        const views = ctx.fanout.views();
        let ds: CharacterDigest[] = [];
        try {
          ds = await digests(ctx);
        } catch {
          // A sandbox mid-restart: the names still answer.
        }
        return { text: fan.list(views, ds, { maxCharacters: ctx.fanout.maxCharacters }) };
      },
    },
  };
}
