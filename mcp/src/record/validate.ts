/**
 * The validator for `wrath-session/1` (`docs/SESSION-FORMAT.md`): the
 * specification as something that runs. It reads a session directory and
 * says what in it the format does not allow, row by row, so a writer other
 * than this stack's can be held to the same text, and so this stack's own
 * writer is (`mcp/test/record-*.test.ts` validates everything it writes).
 *
 * Errors are things the format forbids. Warnings are things it allows but a
 * closed, cleanly written session does not have: a torn line, a plain segment
 * that is not its stream's newest, a row kind this version does not know.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CAPTURED_STREAMS,
  LIVE_FILE,
  MANIFEST_FILE,
  PLAYER_REF,
  SEGMENT_MS,
  SESSION_FILE,
  SESSION_FORMAT,
  SHEET_KEY_LEN,
  STREAMS,
  TRACE_CHAT_KINDS,
  TRACE_CHAT_MAX_CHARS,
  isPlayerGuid,
  parseSegmentName,
  type SessionFile,
  type StreamName,
} from "./format";
import { listSegments, parseLines, readSegmentBytes } from "./segments";

const ts = z.number().int().nonnegative();
const num = z.number();
const nnum = z.number().nullable();
const guid = z.string().regex(/^(0x[0-9a-fA-F]+|\d+)$/);
const point = z.strictObject({ map: num, x: num, y: num, z: num });

// ------------------------------------------------------------------ files

export const sessionFileSchema = z.strictObject({
  format: z.literal(SESSION_FORMAT),
  id: z.string().regex(/^[0-9a-f]{16}$/),
  character: z.strictObject({ guid, name: z.string().nullable(), race: nnum, class: nnum }).nullable(),
  stack: z.strictObject({ version: z.string().min(1), commit: z.string().min(1).optional() }),
  module: z.strictObject({ build: z.string().nullable(), protocol: nnum }).nullable(),
  owner: z.string().optional(),
  group: z.string().optional(),
  world: z.string().min(1).optional(),
  started: ts,
  opened: ts,
  ended: ts.nullable(),
});

export const liveFileSchema = z.strictObject({
  ts,
  observed: ts.nullable(),
  map: nnum,
  x: nnum,
  y: nnum,
  z: nnum,
  o: nnum,
  level: nnum,
  hp: nnum,
  hpMax: nnum,
  zone: nnum,
  area: nnum,
  flags: z.array(z.enum(["combat", "mounted", "taxi", "dead", "ghost", "resting"])),
  stream: z.strictObject({ connected: z.boolean(), events: num, seq: num }).nullable(),
});

export const manifestFileSchema = z.strictObject({
  format: z.literal(SESSION_FORMAT),
  id: z.string().regex(/^[0-9a-f]{16}$/),
  written: ts,
  segments: z.array(
    z.strictObject({ stream: z.enum(CAPTURED_STREAMS), file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  ),
});

// ------------------------------------------------------------------ trace

const numRow = z.array(num);
const sheetList = z.array(numRow).nullable();
const traceStateShape = {
  hp: nnum,
  hpMax: nnum,
  pw: nnum,
  pwMax: nnum,
  pwType: nnum,
  level: nnum,
  xp: nnum,
  xpMax: nnum,
  auras: z.array(z.tuple([num, num, num, num])),
  combat: z.boolean(),
  mounted: z.boolean(),
  taxi: z.boolean(),
  dead: z.boolean(),
  ghost: z.boolean(),
  resting: z.boolean(),
  zone: nnum,
  area: nnum,
  target: z
    .union([
      // A player target is its kind and nothing else.
      z.strictObject({ kind: z.literal("player") }),
      z.strictObject({ kind: z.enum(["creature", "object", "other"]), entry: num.optional(), hpPct: num.optional() }),
    ])
    .nullable(),
  cast: z.strictObject({ spellId: num, endsAt: num }).nullable(),
};
const traceSheetShape = {
  money: nnum,
  equip: sheetList,
  bags: sheetList,
  inv: sheetList,
  dur: sheetList,
  quests: sheetList,
  rep: sheetList,
  skills: sheetList,
};
const traceDict = z.strictObject({
  items: z.array(z.tuple([num, nnum, z.string()])).optional(),
  rands: z.array(z.tuple([num, z.string()])).optional(),
  quests: z.array(z.tuple([num, z.array(z.union([num, z.tuple([num, num])])).min(4)])).optional(),
});
const posFields = { map: nnum.optional(), x: nnum.optional(), y: nnum.optional(), z: nnum.optional(), o: nnum.optional() };
const chat = z.array(z.tuple([z.enum(TRACE_CHAT_KINDS as [string, ...string[]]), z.string().max(TRACE_CHAT_MAX_CHARS)]));

const traceRow = z.discriminatedUnion("kind", [
  z.strictObject({ ts, kind: z.literal("key"), ...posFields, data: z.strictObject({ ...traceStateShape, ...traceSheetShape }), dict: traceDict.optional() }),
  z.strictObject({ ts, kind: z.literal("pos"), map: num, x: num, y: num, z: num, o: num, data: z.strictObject({ jump: z.literal(1) }).optional() }),
  z.strictObject({
    ts,
    kind: z.literal("state"),
    data: z
      .strictObject({ ...traceStateShape, ...traceSheetShape, qdone: z.array(num), chat })
      .partial(),
  }),
  z.strictObject({
    ts,
    kind: z.literal("flight"),
    map: num,
    x: num,
    y: num,
    z: num,
    o: num,
    data: z.strictObject({ to: point, durationMs: num }),
  }),
  z.strictObject({ ts, kind: z.literal("dict"), dict: traceDict }),
]);

// ----------------------------------------------------------------- nearby

/** A guid that is not a player's, or the literal a player's is cut to. */
const unitRef = z.string().refine((g) => g === PLAYER_REF || !isPlayerGuid(g), "a player guid, where only a unit guid or \"player\" may be");
const nearbyState = z
  .strictObject({
    entry: nnum,
    name: z.string().nullable(),
    sub: z.string().nullable(),
    ctype: nnum,
    level: nnum,
    hp: nnum,
    uf: nnum,
    df: nnum,
    nf: nnum,
    qg: nnum,
    tg: unitRef.nullable(),
    tgs: z.boolean().nullable(),
    ow: z.string().nullable(),
    ch: z.string().nullable(),
    disp: nnum,
    scale: nnum,
    mf: nnum,
  })
  .partial();
const nearbyPoint = z.union([z.tuple([num, num, num]), z.tuple([num, num, num, num])]);
const nearbyMotion = z.strictObject({ k: z.enum(["pos", "mv"]), t: num, p: nearbyPoint, to: z.tuple([num, num, num]).optional(), ms: num.optional() });
const unitId = guid.refine((g) => !isPlayerGuid(g), "a player unit, which is never written");
const nearbyUnit = z.strictObject({ id: unitId, ty: z.enum(["creature", "pet", "vehicle"]), s: nearbyState, m: nearbyMotion.nullable() });
const nearbySelf = z.strictObject({ guid: z.string().nullable(), map: nnum, target: unitRef.nullable(), down: z.boolean() });

const nearbyRow = z.discriminatedUnion("kind", [
  z.strictObject({ ts, kind: z.literal("key"), self: nearbySelf, units: z.array(nearbyUnit) }),
  z.strictObject({ ts, kind: z.literal("in"), u: nearbyUnit }),
  z.strictObject({ ts, kind: z.enum(["mv", "pos"]), id: unitId, m: nearbyMotion }),
  z.strictObject({ ts, kind: z.literal("st"), id: unitId, s: nearbyState }),
  z.strictObject({ ts, kind: z.literal("nm"), id: unitId, name: z.string(), sub: z.string().optional() }),
  z.strictObject({ ts, kind: z.literal("out"), id: unitId }),
  z.strictObject({ ts, kind: z.literal("self"), self: nearbySelf.partial() }),
  z.strictObject({ ts, kind: z.literal("tick") }),
]);

// ----------------------------------------------------------------- events

const seq = num.optional();
const groupState = z.strictObject({
  groupGuid: z.string().optional(),
  leaderGuid: guid.optional(),
  members: z.array(guid),
  foreign: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
const eventsState = z.strictObject({
  level: nnum,
  zone: nnum,
  area: nnum,
  map: nnum,
  instanceType: nnum,
  dead: z.boolean(),
  released: z.boolean(),
  taxi: z.boolean(),
  group: groupState.nullable(),
});
const eventRow = z.discriminatedUnion("kind", [
  z.strictObject({ ts, seq, kind: z.literal("key"), state: eventsState }),
  z.strictObject({ ts, seq, kind: z.enum(["zone", "area"]), from: num.optional(), to: num }),
  z.strictObject({ ts, seq, kind: z.literal("level"), from: num.optional(), to: num, xp: num.optional() }),
  z.strictObject({
    ts,
    seq,
    kind: z.literal("death"),
    position: point.extend({ source: z.enum(["corpse_query", "death_spot"]) }).optional(),
    zone: num.optional(),
    area: num.optional(),
    released: z.boolean().optional(),
  }),
  z.strictObject({ ts, seq, kind: z.literal("release"), graveyard: point.optional() }),
  z.strictObject({ ts, seq, kind: z.literal("resurrect") }),
  z.strictObject({ ts, seq, kind: z.enum(["taxi", "taxi_landed"]), position: point.optional(), zone: num.optional(), area: num.optional() }),
  z.strictObject({ ts, seq, kind: z.literal("achievement"), id: num, name: z.string().optional(), points: num.optional(), categoryId: num.optional() }),
  z.strictObject({ ts, seq, kind: z.literal("achievements_at_login"), ids: z.array(num), points: num }),
  z.strictObject({ ts, seq, kind: z.literal("spells_at_login"), ids: z.array(num) }),
  z.strictObject({ ts, seq, kind: z.literal("spell"), id: num }),
  z.strictObject({ ts, seq, kind: z.literal("talent"), id: num, points: num, rank: num, spec: num.optional() }),
  z.strictObject({ ts, seq, kind: z.literal("trade") }),
  z.strictObject({ ts, seq, kind: z.literal("quest"), id: num }),
  z.strictObject({ ts, seq, kind: z.literal("group"), event: z.enum(["joined", "changed", "left"]), ...groupState.shape }),
  z.strictObject({
    ts,
    seq,
    kind: z.literal("instance"),
    event: z.enum(["entered", "left"]),
    map: num,
    instanceType: num,
    from: z.strictObject({ map: num, instanceType: num }),
  }),
  z.strictObject({
    ts,
    seq,
    kind: z.literal("kill"),
    killerGuid: guid.optional(),
    victimGuid: guid.refine((g) => !isPlayerGuid(g), "a player victim, which is never written"),
    entry: num.optional(),
    rank: num.optional(),
    self: z.boolean(),
    member: z.boolean(),
  }),
]);

// ------------------------------------------------------------------ calls

const origin = z.looseObject({ type: z.string().min(1), call: num.optional() });
const callRowCall = z.strictObject({ ts, kind: z.literal("call"), id: num, origin, tool: z.string(), args: z.unknown() });
const actionNote = z.looseObject({ ts: num, action: z.string(), status: num, ms: num });
const eventSummary = z.looseObject({ seq: num, ts: num, opcode: z.string() });
const callRow = z.discriminatedUnion("kind", [
  z.strictObject({ ts, kind: z.literal("key"), open: z.array(callRowCall) }),
  callRowCall,
  z.strictObject({ ts, kind: z.literal("result"), id: num, text: z.string(), error: z.boolean(), durationMs: num }),
  z.strictObject({ ts, kind: z.literal("actions"), origin, actions: z.array(actionNote), dropped: z.record(z.string(), num).optional() }),
  z.strictObject({
    ts,
    kind: z.literal("move"),
    origin,
    at: num,
    moveId: nnum,
    map: nnum,
    x: num,
    y: num,
    z: num,
    target: z.string().nullable(),
    name: z.string().optional(),
    status: z.string().nullable(),
  }),
  z.strictObject({ ts, kind: z.literal("events"), origin, count: num, folded: num.optional(), events: z.array(eventSummary) }),
]);

const ROW_SCHEMAS: Record<StreamName, { schema: z.ZodType; kinds: ReadonlySet<string> }> = {
  trace: { schema: traceRow, kinds: new Set(["key", "pos", "state", "flight", "dict"]) },
  nearby: { schema: nearbyRow, kinds: new Set(["key", "in", "mv", "pos", "st", "nm", "out", "self", "tick"]) },
  events: {
    schema: eventRow,
    kinds: new Set([
      "key", "zone", "area", "level", "death", "release", "resurrect", "taxi", "taxi_landed", "achievement", "achievements_at_login",
      "spells_at_login", "spell", "talent", "trade", "quest", "group", "instance", "kill",
    ]),
  },
  calls: { schema: callRow, kinds: new Set(["key", "call", "result", "actions", "move", "events"]) },
};

/** Streams whose rows a writer keeps in time order within a segment. */
const ORDERED: ReadonlySet<StreamName> = new Set(["trace", "nearby"]);

function issues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

/** One row against its stream's schema: null when it is allowed, else why not. An unknown kind is `unknown`. */
export function validateRow(stream: StreamName, row: unknown): { ok: true } | { ok: false; unknownKind: boolean; error: string } {
  const kind = (row as { kind?: unknown } | null)?.kind;
  const spec = ROW_SCHEMAS[stream];
  if (typeof kind === "string" && !spec.kinds.has(kind)) return { ok: false, unknownKind: true, error: `kind "${kind}" is not one this version knows` };
  const parsed = spec.schema.safeParse(row);
  return parsed.success ? { ok: true } : { ok: false, unknownKind: false, error: issues(parsed.error) };
}

export interface SessionValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  session: SessionFile | null;
  streams: Record<StreamName, { segments: number; rows: number }>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** The sheet lists of a trace row's data: every row long enough to hold its key. */
function checkSheetRows(data: Record<string, unknown>): string | null {
  for (const [key, keyLen] of Object.entries(SHEET_KEY_LEN)) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const r of list as unknown[]) if (!Array.isArray(r) || r.length < keyLen) return `${key}: a row shorter than its ${keyLen} key field(s)`;
  }
  return null;
}

/**
 * Validate one session directory against `wrath-session/1`. Never throws: a
 * directory that is not a session at all comes back as one error.
 */
export function validateSession(dir: string): SessionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const streams = Object.fromEntries(STREAMS.map((s) => [s, { segments: 0, rows: 0 }])) as SessionValidation["streams"];
  let session: SessionFile | null = null;

  try {
    const parsed = sessionFileSchema.safeParse(readJson(join(dir, SESSION_FILE)));
    if (parsed.success) session = parsed.data as SessionFile;
    else errors.push(`${SESSION_FILE}: ${issues(parsed.error)}`);
  } catch (e) {
    errors.push(`${SESSION_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (session !== null && session.ended !== null && session.ended < session.started) errors.push(`${SESSION_FILE}: ended before it started`);

  if (existsSync(join(dir, LIVE_FILE))) {
    try {
      const parsed = liveFileSchema.safeParse(readJson(join(dir, LIVE_FILE)));
      if (!parsed.success) errors.push(`${LIVE_FILE}: ${issues(parsed.error)}`);
    } catch (e) {
      errors.push(`${LIVE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ended = session !== null && session.ended !== null;
  const self = session?.character?.guid ?? null;
  for (const stream of STREAMS) {
    const sdir = join(dir, stream);
    let names: string[] = [];
    try {
      names = readdirSync(sdir);
    } catch {
      continue;
    }
    if (stream === "nearby" && ended) errors.push("nearby/: the ring outlived the session; it is removed when the session closes");
    for (const name of names) {
      if (parseSegmentName(name) === null && !name.endsWith(".tmp")) errors.push(`${stream}/${name}: not a segment name`);
    }
    const segs = listSegments(dir, stream);
    streams[stream].segments = segs.length;
    segs.forEach((seg, i) => {
      const where = `${stream}/${seg.stem}`;
      const newest = i === segs.length - 1;
      if (stream === "nearby" && seg.compressed) errors.push(`${where}: a compressed ring segment; the ring is never compressed`);
      if (stream !== "nearby" && !seg.compressed && (ended || !newest)) {
        warnings.push(`${where}: a closed segment that is not compressed`);
      }
      let bytes: Uint8Array;
      try {
        bytes = readSegmentBytes(seg.path);
      } catch (e) {
        errors.push(`${where}: unreadable (${e instanceof Error ? e.message : String(e)})`);
        return;
      }
      const { rows, skipped, consumed } = parseLines<Record<string, unknown>>(bytes);
      if (skipped > 0) warnings.push(`${where}: ${skipped} line(s) that are not a JSON object`);
      if (consumed < bytes.length) (seg.compressed ? errors : warnings).push(`${where}: ends in a line with no newline`);
      streams[stream].rows += rows.length;
      if (rows.length === 0) {
        errors.push(`${where}: no rows; a segment opens with a key row`);
        return;
      }
      if (rows[0]!["kind"] !== "key") errors.push(`${where}: opens with a "${String(rows[0]!["kind"])}" row, not a key row`);
      let last = -Infinity;
      const open = new Set<number>();
      // The ring names its own character on its key and `self` rows; `session.json` may not have it yet.
      let ringSelf = self;
      rows.forEach((row, n) => {
        const at = `${where}:${n + 1}`;
        const v = validateRow(stream, row);
        if (!v.ok) {
          (v.unknownKind ? warnings : errors).push(`${at}: ${v.error}`);
          return;
        }
        const rowTs = row["ts"] as number;
        if (ORDERED.has(stream)) {
          if (rowTs < last) errors.push(`${at}: ts goes back in time (${rowTs} after ${last})`);
          last = rowTs;
        }
        if (rowTs >= seg.t0 + 2 * SEGMENT_MS) errors.push(`${at}: ts ${rowTs} is past the window after this segment's`);
        if (stream === "trace" && (row["kind"] === "key" || row["kind"] === "state")) {
          const bad = checkSheetRows((row["data"] ?? {}) as Record<string, unknown>);
          if (bad !== null) errors.push(`${at}: ${bad}`);
        }
        if (stream === "nearby") {
          // A unit a player other than the session's own character owns or charms is never a row.
          const states: Record<string, unknown>[] = [];
          if (row["kind"] === "key" || row["kind"] === "self") {
            const g = (row["self"] as { guid?: unknown }).guid;
            if (typeof g === "string") ringSelf = g;
          }
          if (row["kind"] === "key") for (const u of row["units"] as { s: Record<string, unknown> }[]) states.push(u.s);
          else if (row["kind"] === "in") states.push((row["u"] as { s: Record<string, unknown> }).s);
          else if (row["kind"] === "st") states.push(row["s"] as Record<string, unknown>);
          for (const s of states) {
            for (const k of ["ow", "ch"]) {
              const g = s[k];
              if (typeof g === "string" && isPlayerGuid(g) && g !== ringSelf) errors.push(`${at}: ${k} names a player other than the session's own character`);
            }
          }
        }
        if (stream === "calls") {
          if (row["kind"] === "key") for (const c of row["open"] as { id: number }[]) open.add(c.id);
          else if (row["kind"] === "call") {
            open.add(row["id"] as number);
            if (row["ts"] !== row["id"]) errors.push(`${at}: a call's ts is its id`);
          } else if (row["kind"] === "result" && !open.delete(row["id"] as number)) {
            errors.push(`${at}: a result for call ${String(row["id"])}, which this segment neither holds nor restates in its key`);
          }
        }
      });
    });
  }

  if (existsSync(join(dir, MANIFEST_FILE))) {
    try {
      const parsed = manifestFileSchema.safeParse(readJson(join(dir, MANIFEST_FILE)));
      if (!parsed.success) errors.push(`${MANIFEST_FILE}: ${issues(parsed.error)}`);
      else {
        if (session !== null && parsed.data.id !== session.id) errors.push(`${MANIFEST_FILE}: id is not the session's`);
        const listed = new Set<string>();
        for (const seg of parsed.data.segments) {
          const rel = `${seg.stream}/${seg.file}`;
          listed.add(rel);
          const path = join(dir, seg.stream, seg.file);
          const st = statSync(path, { throwIfNoEntry: false });
          if (st === undefined) {
            errors.push(`${MANIFEST_FILE}: ${rel} is listed and missing`);
            continue;
          }
          if (st.size !== seg.bytes) errors.push(`${MANIFEST_FILE}: ${rel} is ${st.size} bytes, listed as ${seg.bytes}`);
          else if (createHash("sha256").update(readFileSync(path)).digest("hex") !== seg.sha256) errors.push(`${MANIFEST_FILE}: ${rel} does not hash to what is listed`);
        }
        for (const stream of CAPTURED_STREAMS) {
          for (const seg of listSegments(dir, stream)) {
            const rel = `${stream}/${seg.stem}${seg.compressed ? ".zst" : ""}`;
            if (!listed.has(rel)) errors.push(`${MANIFEST_FILE}: ${rel} is on disk and not listed`);
          }
        }
      }
    } catch (e) {
      errors.push(`${MANIFEST_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, session, streams };
}
