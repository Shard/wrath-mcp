/**
 * The tool surface: one dispatcher (`ToolSet`) for every tool a harness
 * serves, and the five core tools every harness serves through it —
 * `run_snippet`, `recent_events`, `state_summary`, `write_scratchpad` and
 * `edit_scratchpad`. Beside them, for a sandbox that hosts a program,
 * `programTools`: the four file tools, the two routine tools and the
 * one-off `run_snippet`. A harness adds its own tools as `ToolSpec`s and lists the
 * whole set in the order it serves them; the dispatcher owns everything a
 * call goes through whichever tool it is: lenient argument parsing, alias
 * keys, strict validation with a prose restatement of the parameters, the
 * unknown-tool answer, the harness-delivered hint block, and the secret scrub.
 * Schemas are deliberately tight — few parameters, all described — because a
 * confused tool call costs a live-world turn.
 */

import { z } from "zod";
import type { ActionHintNote, EventSummary } from "./sandbox/ipc";
import type { SnippetResult } from "./sandbox/host";
import { overCapText, type Scratchpad } from "./scratchpad";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, for MCP and OpenAI tools
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/**
 * Who is calling, for the records a call leaves behind. `dispatchTs` is the
 * value the caller stamps on this call's `tool_call` record: a snippet's
 * action log carries it as `callTs`, which is how a reader joins the two.
 */
export interface CallOrigin {
  dispatchTs?: number;
}

/**
 * The session record's side of a tool call (`record/writer.ts`,
 * `SessionWriter`): the call as dispatched, its answer, and an event batch it
 * served. `call` returns the call's id, its dispatch stamp.
 */
export interface CallRecord {
  call(tool: string, args: unknown, dispatchTs?: number): number;
  result(id: number, result: ToolResult): void;
  eventsServed(call: number | undefined, events: EventSummary[], folded?: number): void;
}

/** What the core tools need of the sandbox: its host, or a stand-in. */
export interface ToolSandbox {
  evalSnippet(code: string, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<SnippetResult>;
  recentEvents(limit: number): Promise<EventSummary[]>;
  stateSnapshot(): Promise<Record<string, unknown>>;
  drainActionHints(): Promise<ActionHintNote[]>;
}

/**
 * What every tool context carries. A harness's context extends it with what
 * its own tools read; one context is built per episode by each dispatcher.
 */
export interface CoreToolContext {
  sandbox: ToolSandbox;
  scratchpad: Scratchpad;
  /** Whether a game session has been established (for the summary header). */
  sessionLive: () => boolean;
  /** The driver turn in flight, carried on a snippet's action log. */
  turn: () => number;
  /**
   * Called with every event batch actually served to the model (the visible
   * ones), plus how many ambient events (movement, party frames) were folded out of that span.
   */
  onEventsServed?: (events: unknown[], folded?: number) => void;
  /**
   * Called with the action hints a result carries, as it is built: a
   * snippet's own and the ones drained onto any other result. What the model
   * was told, by signature, so a harness can tell a fact it has delivered
   * from one it has not.
   */
  onHintsDelivered?: (hints: readonly ActionHintNote[]) => void;
  /**
   * The secret registry every result passes through (`redact.ts`'s
   * `SecretRedactor`, or a harness's own): each result `ToolSet.call` and
   * `ToolSet.appendPending` return has passed its `scrub`, so a secret a
   * snippet printed, threw, returned, wrote to the pad or said in chat reaches
   * the model, and the record of the result, as `[redacted]`. Required: a
   * dispatcher without it would hand the model the raw text on one path only.
   */
  secrets: { scrub(text: string): string };
  /**
   * The session record, when the host keeps one: `ToolSet.call` writes every
   * call and its scrubbed result to it, and `recent_events` the batch it
   * served. Undefined records nothing.
   */
  record?: CallRecord;
}

/**
 * One tool: its definition as served, the strict schema its arguments are
 * validated against, the prose restatement of its parameters a refusal ends
 * with, the alias keys models actually sent, and what it does.
 */
export interface ToolSpec<C extends CoreToolContext = CoreToolContext> {
  readonly def: ToolDef;
  readonly schema: z.ZodType;
  readonly help: string;
  /** Alias key -> canonical key, applied only when the canonical key is absent, before validation. */
  readonly aliases?: Readonly<Record<string, string>>;
  /**
   * False when this context does not serve the tool (a harness's per-run
   * option). A call to it then answers as an unknown tool, listing the others.
   */
  readonly enabled?: (ctx: C) => boolean;
  run(ctx: C, args: unknown, origin: CallOrigin): Promise<ToolResult>;
}

// Strict on purpose: the advertised inputSchema says `additionalProperties:
// false`, and a plain z.object would silently *strip* unknown keys — a model
// that sent { snippet: "..." } got an empty object and a confusing "code
// required" instead of being told about its unknown key. Aliases are
// normalized (`ToolSet.normalize`) BEFORE this validation runs.
/**
 * Booleanish, deterministically — repair only the deterministic. NOT
 * z.coerce.boolean(): that is JS truthiness, so the string "false" — which
 * models do send — would read true.
 */
export const booleanish = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((v) =>
    typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : /^(true|1|yes|on)$/i.test(v.trim()),
  );

/**
 * Strip trailing commas before `}` or `]`, but ONLY outside JSON string
 * literals. A naive global regex (the previous implementation) also rewrote
 * `,}`/`,]` sequences that occur *inside* a string value — so when the outer
 * JSON needed repair, a snippet whose `code` string contained e.g. `', ]'`
 * had that string silently mutated before execution, falsifying the trajectory.
 * A one-pass tokenizer that tracks whether we are inside a string (and honours
 * backslash escapes) keeps the repair to structural commas only.
 */
export function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look past whitespace: if the next non-space char closes an object or
      // array, this comma is trailing — drop it, keep the whitespace.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) {
        continue; // skip the comma; whitespace emits on its own iterations
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Parse a tool-arguments *string* leniently, in this order: (a) plain
 * JSON.parse; (b) strip one wrapping markdown code fence and re-parse; (c) one
 * conservative repair pass — trailing commas before `}` or `]`, outside string
 * literals — and re-parse. On final failure the error echoes what was received.
 */
export function parseToolArgsText(raw: string): { ok: true; args: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, args: {} };
  const candidates: string[] = [trimmed];
  const fence = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  for (const c of [...candidates]) {
    const repaired = stripTrailingCommas(c);
    if (repaired !== c) candidates.push(repaired);
  }
  let lastError: unknown;
  for (const c of candidates) {
    try {
      return { ok: true, args: JSON.parse(c) };
    } catch (e) {
      lastError = e;
    }
  }
  return {
    ok: false,
    error: `tool arguments were not valid JSON (${String(lastError)}); received: ${trimmed.slice(0, 200)}`,
  };
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        tmp + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/**
 * Tool calls dispatched per context: the episode's unit of elapsed activity,
 * for a harness tool that says "N tool calls ago". Keyed on the context
 * object, which each dispatcher builds once per episode, so it lives exactly
 * as long as the episode and is never written to disk.
 */
const CALLS = new WeakMap<object, number>();

/** How many tool calls this context has dispatched, the one in flight included. */
export function toolCallCount(ctx: object): number {
  return CALLS.get(ctx) ?? 0;
}

/**
 * How much of one snippet result the harness may spend on hints, and how much
 * of one hint. Both are caps, not budgets to fill: the common turn shows one
 * group of one line.
 */
export const ACTION_HINT_RENDER = {
  MAX_GROUPS: 4,
  MAX_HINT_CHARS: 320,
} as const;

/**
 * Render the SDK's hint-bearing failures for the model, or undefined when there
 * were none.
 *
 * This is the delivery the principle asks for: the hint is already in the
 * result object, but a snippet that reduces a result to `.status` throws it
 * away before the model reads it (run a11: 41 `too_far`, hint read 0 times), so
 * the harness puts it in the tool result itself — the one place every driver
 * shares, and one the model's own code cannot strip. Rendered in the tool
 * result rather than in a turn's context block because a CLI agent's turn can
 * be a whole session: a context notice would arrive a turn late, which is the
 * follow-up inspection the principle forbids. A snippet's result carries what
 * its eval drained; any other tool's result carries what was pending when it
 * answered (`ToolSet.appendPending`), so a background routine's hint is not
 * held back for the next snippet.
 *
 * Nothing is added to the hint strings. Grouping is the SDK's (action, status)
 * tally, so a status that failed 21 times costs one line and a count. The
 * tally is kept per routine, so one result could carry the same sentence once
 * for each routine that earned it; those are one line here, naming the
 * routines (`collapseOrigins`).
 */
export function renderActionHints(hints: readonly ActionHintNote[]): string | undefined {
  if (hints.length === 0) return undefined;
  let rows = collapseOrigins(hints);
  // Fan-out above 1: each client tallied its own, and a line says whose it is.
  if (rows.some((h) => h.character !== undefined)) rows = groupHintsByCharacter(rows);
  return renderHintRows(rows);
}

/** One line of the block: a tallied hint, with every routine it came from when several earned the same one. */
interface HintRow extends ActionHintNote {
  /** The `from` labels of the notes folded into this row, each once, in arrival order. */
  froms?: string[];
}

/** How many routines a collapsed line names before it counts the rest. */
const HINT_ORIGINS_SHOWN = 3;

/**
 * The same failure with the same hint raised by several earlier snippets'
 * routines, as one row: the SDK tallies each routine apart so a line can say
 * whose code it was, and a sentence with nothing of the call in it (a
 * `superseded`, a cooldown) then came once per routine in one result. The row
 * keeps the hint once, names each routine and sums the repeats; nothing is
 * remembered between results. The current snippet's own line stays apart from
 * a routine's, and so do lines whose hints differ in any character.
 */
function collapseOrigins(hints: readonly ActionHintNote[]): HintRow[] {
  const rows: HintRow[] = [];
  const byKey = new Map<string, HintRow & { froms: string[] }>();
  const byRoutine = new Map<string, HintRow>();
  for (const h of hints) {
    // A routine of the model's program: one row per routine, so the line names its owner.
    if (h.routine !== undefined) {
      const key = `${h.character ?? ""}\n${h.routine}\n${h.action}\n${h.status}\n${h.hint}`;
      const row = byRoutine.get(key);
      if (row === undefined) {
        const first = { ...h };
        byRoutine.set(key, first);
        rows.push(first);
      } else {
        row.count += h.count;
        if (h.ts > row.ts) row.ts = h.ts;
      }
      continue;
    }
    if (h.from === undefined) {
      rows.push({ ...h });
      continue;
    }
    const key = `${h.character ?? ""}\n${h.action}\n${h.status}\n${h.hint}`;
    const row = byKey.get(key);
    if (row === undefined) {
      const first = { ...h, froms: [h.from] };
      byKey.set(key, first);
      rows.push(first);
      continue;
    }
    row.count += h.count;
    if (h.ts > row.ts) row.ts = h.ts;
    if (!row.froms.includes(h.from)) row.froms.push(h.from);
  }
  return rows;
}

function renderHintRows(hints: readonly HintRow[]): string {
  // Most recent first. Nothing here reacts to how often a status failed — the
  // count is only the collapse marker for repeats of one hint, and no rendering
  // or ordering decision reads it.
  const ordered = [...hints].sort((a, b) => b.ts - a.ts || a.status.localeCompare(b.status));
  const shown = ordered.slice(0, ACTION_HINT_RENDER.MAX_GROUPS);
  const lines = ["--- harness ---"];
  for (const h of shown) {
    const hint =
      h.hint.length > ACTION_HINT_RENDER.MAX_HINT_CHARS
        ? `${h.hint.slice(0, ACTION_HINT_RENDER.MAX_HINT_CHARS - 1).trimEnd()}…`
        : h.hint;
    lines.push(`${h.action} ${h.status}${h.count > 1 ? ` ×${h.count}` : ""}${fromLabel(h)}: ${hint}`);
  }
  const rest = ordered.length - shown.length;
  if (rest > 0) lines.push(`(+${rest} other failure ${rest === 1 ? "status" : "statuses"} since the last result)`);
  return lines.join("\n");
}

/** How many names a grouped hint line lists before it counts the rest. */
const HINT_CHARACTERS_SHOWN = 4;

/**
 * Hints tallied per character (fan-out above 1), grouped: the same failure
 * with the same hint from several characters is one line whose head names
 * them, with the count summed, so the block grows with what differs between
 * characters and not with how many there are. The names ride the `from`
 * label's place on the line's head, where the hint cap never cuts them.
 */
function groupHintsByCharacter(hints: readonly HintRow[]): HintRow[] {
  const groups = new Map<string, { note: HintRow; names: string[] }>();
  for (const h of hints) {
    const key = `${h.action}\n${h.status}\n${h.hint}\n${h.froms === undefined ? "\u0000" : h.froms.join("\u0001")}${h.routine === undefined ? "" : `\n${h.routine}`}`;
    const g = groups.get(key);
    const name = h.character ?? "?";
    if (g === undefined) {
      groups.set(key, { note: { ...h }, names: [name] });
      continue;
    }
    g.note.count += h.count;
    if (h.ts > g.note.ts) g.note.ts = h.ts;
    if (!g.names.includes(name)) g.names.push(name);
  }
  return [...groups.values()].map(({ note, names }) => {
    const { character: _c, ...rest } = note;
    const shown = names.slice(0, HINT_CHARACTERS_SHOWN).join(", ") + (names.length > HINT_CHARACTERS_SHOWN ? ` +${names.length - HINT_CHARACTERS_SHOWN}` : "");
    return { ...rest, status: `${note.status} [${shown}]` };
  });
}

/**
 * Which earlier snippet's code raised a hint, on its line's head so the hint
 * cap never cuts it: the routine that made the call, by its function's name
 * or the statement that launched it, else the snippet's opening code — what
 * the model wrote and can recognise (`sandbox/call-site.ts`). Nothing for the
 * current snippet's own hints.
 */
function fromLabel(row: HintRow): string {
  if (row.routine !== undefined) return ` (routine ${row.routine})`;
  const froms = row.froms ?? (row.from === undefined ? undefined : [row.from]);
  if (froms === undefined) return "";
  // `""` is a routine nothing names any more: counted, never listed.
  const named = froms.filter((f) => f !== "");
  if (froms.length === 1) return named.length === 0 ? " (from an earlier snippet)" : ` (from an earlier snippet: ${named[0]})`;
  if (named.length === 0) return " (from earlier snippets)";
  const shown = named.slice(0, HINT_ORIGINS_SHOWN);
  const rest = froms.length - shown.length;
  return ` (from earlier snippets: ${shown.join("; ")}${rest > 0 ? `; +${rest}` : ""})`;
}

/**
 * `result` as the model may read it: every registered secret in its text
 * replaced by `[redacted]` (`CoreToolContext.secrets`). The last step of both
 * ways a tool result leaves the dispatcher, so every driver logs and sends the
 * same text. A result with no secret in it is returned as it was.
 */
function scrubResult(ctx: CoreToolContext, result: ToolResult): ToolResult {
  const text = ctx.secrets.scrub(result.text);
  return text === result.text ? result : { ...result, text };
}

/**
 * The results of snippets that actually ran: the eval (or the pong after an
 * abandoned one) drained the hint tally, and the result already renders it.
 */
const EVALUATED = new WeakSet<ToolResult>();

/**
 * `result` with the pending hint block at its foot, or `result` itself when
 * nothing is pending.
 *
 * Every tool result but an evaluated snippet's goes through here: a hint raised
 * by a background routine used to wait in the tally for the next snippet, so a
 * routine re-issuing a refused move surfaced as one `×4014` line long after the
 * fact. Pending hints now ride whichever tool result comes next. No counter,
 * threshold or new text: the block is `renderActionHints`' own, appended after
 * the tool's text exactly as a snippet result carries it, and the tool's text
 * and `isError` are untouched but for the secret scrub every result passes
 * (`scrubResult`).
 *
 * Never throws. A drain that fails — the sandbox mid-restart, a child not
 * answering in time — reads as nothing pending: delivering a hint must never
 * cost the model the result it asked for.
 */
export async function appendPendingActionHints(ctx: CoreToolContext, result: ToolResult): Promise<ToolResult> {
  let hints: ActionHintNote[];
  try {
    hints = await ctx.sandbox.drainActionHints();
  } catch {
    return scrubResult(ctx, result);
  }
  const block = renderActionHints(hints);
  if (hints.length > 0) ctx.onHintsDelivered?.(hints);
  return scrubResult(ctx, block === undefined ? result : { ...result, text: `${result.text}\n${block}` });
}

/** The dispatcher for one harness's tools, in the order it serves them. */
export class ToolSet<C extends CoreToolContext> {
  /** Every tool's name, in serving order: the unknown-tool answer and the near-miss search read this. */
  readonly names: readonly string[];
  private readonly byName: ReadonlyMap<string, ToolSpec<C>>;

  constructor(readonly specs: readonly ToolSpec<C>[]) {
    this.names = specs.map((s) => s.def.name);
    this.byName = new Map(specs.map((s) => [s.def.name, s]));
  }

  /** The definitions, as served. */
  get defs(): ToolDef[] {
    return this.specs.map((s) => s.def);
  }

  isKnown(name: string): boolean {
    return this.byName.has(name);
  }

  /** Rename known alias keys to their canonical names. Deterministic, model-agnostic. */
  normalize(name: string, args: unknown): unknown {
    const aliases = this.byName.get(name)?.aliases;
    if (aliases === undefined || args === null || typeof args !== "object" || Array.isArray(args)) return args;
    const obj = { ...(args as Record<string, unknown>) };
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (alias in obj && !(canonical in obj)) {
        obj[canonical] = obj[alias];
        delete obj[alias];
      }
    }
    return obj;
  }

  /**
   * The one entry point drivers use for raw tool arguments (string or object).
   * A string is parsed leniently; the final failure message restates the tool's
   * expected parameters in prose.
   */
  coerce(name: string, raw: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
    if (typeof raw !== "string") return { ok: true, args: raw };
    const parsed = parseToolArgsText(raw);
    if (parsed.ok) return parsed;
    const spec = this.byName.get(name);
    const help = spec !== undefined ? ` ${spec.help}` : "";
    return { ok: false, error: `${parsed.error}.${help}` };
  }

  /** Nearest valid tool for a misspelled/mangled name, or undefined. */
  nearest(name: string): string | undefined {
    // Mangled-but-containing first: observed "connect()<tool_call>run_snippet".
    const contained = this.names.find((n) => name.includes(n));
    if (contained !== undefined) return contained;
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const n of this.names) {
      const d = levenshtein(name.toLowerCase(), n);
      if (d < bestDistance) {
        bestDistance = d;
        best = n;
      }
    }
    return bestDistance <= 3 ? best : undefined;
  }

  /** Zod issues as sentences a model can act on, never raw issue arrays. */
  private renderIssues(spec: ToolSpec<C>, error: z.ZodError): string {
    const name = spec.def.name;
    const props = (spec.def.inputSchema["properties"] ?? {}) as Record<string, unknown>;
    const valid = Object.keys(props);
    return error.issues
      .map((issue) => {
        if (issue.code === "unrecognized_keys") {
          const keys = (issue as { keys: string[] }).keys.map((k) => `"${k}"`).join(", ");
          return `unknown key(s) ${keys} — valid keys for ${name}: ${valid.length > 0 ? valid.join(", ") : "(none)"}`;
        }
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
  }

  /**
   * Dispatch one tool call. Never throws: errors come back as `isError` text.
   * Pending action hints ride the result (`appendPending`), whichever tool it
   * is; an evaluated snippet's result already carries its own. Either way the
   * result is scrubbed of registered secrets (`scrubResult`).
   */
  async call(ctx: C, name: string, args: unknown, origin: CallOrigin = {}): Promise<ToolResult> {
    // The record's id for the call is its dispatch stamp, and from here on it
    // is the stamp: what the call sends is linked to it by that number.
    const id = ctx.record?.call(name, args, origin.dispatchTs);
    if (id !== undefined) origin = { ...origin, dispatchTs: id };
    const result = await this.run(ctx, name, args, origin);
    // `EVALUATED` is keyed on identity, so it is read before the scrub copies.
    const out = EVALUATED.has(result) ? scrubResult(ctx, result) : await appendPendingActionHints(ctx, result);
    if (id !== undefined) ctx.record?.result(id, out);
    return out;
  }

  /** `result` with whatever hints are pending (`appendPendingActionHints`). */
  appendPending(ctx: C, result: ToolResult): Promise<ToolResult> {
    return appendPendingActionHints(ctx, result);
  }

  private async run(ctx: C, name: string, args: unknown, origin: CallOrigin): Promise<ToolResult> {
    CALLS.set(ctx, toolCallCount(ctx) + 1);
    try {
      const spec = this.byName.get(name);
      if (spec === undefined) {
        const suggestion = this.nearest(name);
        return {
          text:
            `unknown tool: ${name}. Valid tools: ${this.names.join(", ")}.` +
            (suggestion !== undefined ? ` Did you mean ${suggestion}?` : ""),
          isError: true,
        };
      }
      if (spec.enabled?.(ctx) === false) {
        return {
          text: `unknown tool: ${name}. Valid tools: ${this.names.filter((n) => n !== name).join(", ")}.`,
          isError: true,
        };
      }
      const normalized = this.normalize(name, args ?? {});
      const parsed = spec.schema.safeParse(normalized);
      if (!parsed.success) {
        const received = JSON.stringify(normalized)?.slice(0, 200) ?? String(normalized).slice(0, 200);
        return {
          text:
            `invalid arguments for ${name}: ${this.renderIssues(spec, parsed.error)}. ` +
            `Received: ${received}. ${spec.help}`,
          isError: true,
        };
      }
      return await spec.run(ctx, parsed.data, origin);
    } catch (err) {
      return { text: `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

// ------------------------------------------------------------- core tools

/**
 * How much wider than `limit` recent_events scans so the fold still returns
 * `limit` signal events. Measured on gate2-ox-1: ambient movement was ~85% of
 * the stream, so 8x covers the observed worst case; the cap is the SDK's
 * retained event buffer (EventStream bufferSize, default 500).
 */
const RECENT_EVENTS_SCAN_FACTOR = 8;
const RECENT_EVENTS_SCAN_MAX = 500;

/**
 * Why an `edit_scratchpad` refusal happened, said as a per-failed-call hint in
 * the house style: what was expected and how to fix the call, never strategy
 * (docs/METHODOLOGY.md, "Softening: repair the deterministic, explain the
 * rest"). Two matches have two readings, so the harness refuses rather than
 * picking one.
 */
const EDIT_SCRATCHPAD_HINTS: Record<"empty_old" | "identical" | "not_found" | "ambiguous", (matches: number) => string> = {
  empty_old: () =>
    "edit_scratchpad: old was empty. There is nothing to match — use write_scratchpad to start a pad, then edit it.",
  identical: () => "edit_scratchpad: old and new are the same text, so this edit would change nothing.",
  not_found: () =>
    "edit_scratchpad: old was not found in the scratchpad; copy the text exactly, whitespace included. The scratchpad as last written is in this turn's context.",
  ambiguous: (matches) =>
    `edit_scratchpad: old matches ${matches} places; include more surrounding text or set replaceAll.`,
};

/**
 * A snippet's result as the model reads it: the verdict, its value, the note
 * about it, the error, the console, the hint block and whatever the harness
 * ends a snippet result with. Marked as evaluated, so the dispatcher does not
 * append the hints a second time.
 */
export async function snippetToolResult<C extends CoreToolContext>(ctx: C, res: SnippetResult, render: Pick<CoreToolRender<C>, "afterSnippet">): Promise<ToolResult> {
  const lines: string[] = [];
  lines.push(res.ok ? `ok (${res.durationMs}ms)` : `error (${res.durationMs}ms)`);
  if (res.value !== undefined) lines.push(`=> ${res.value}`);
  if (res.hint !== undefined) lines.push(res.hint);
  for (const note of res.notes ?? []) lines.push(note);
  if (res.error !== undefined) lines.push(res.error);
  if (res.logs.length > 0) {
    lines.push("--- console ---");
    for (const l of res.logs) lines.push(`[${l.level}] ${l.text}`);
  }
  // Last, and on a successful snippet too: a11's snippets returned `ok`
  // while swallowing 41 hints, so this is the main case, not the edge.
  const hints = renderActionHints(res.actionHints ?? []);
  if (hints !== undefined) lines.push(hints);
  if ((res.actionHints ?? []).length > 0) ctx.onHintsDelivered?.(res.actionHints!);
  // After the hint block and carrying no action outcome, so nothing a
  // background routine did is said twice; before the result is marked,
  // so it is still the one `EVALUATED` holds.
  if (render.afterSnippet !== undefined) {
    const after = await render.afterSnippet(ctx);
    if (after !== undefined) lines.push(after);
  }
  const result = { text: lines.join("\n"), isError: !res.ok };
  EVALUATED.add(result);
  return result;
}

/** How many events `recent_events` asks the sandbox for: `limit` of the raw stream, or a wider span to fold within. */
export function recentEventsScan(limit: number, includeMovement: boolean): number {
  return includeMovement ? limit : Math.min(RECENT_EVENTS_SCAN_MAX, limit * RECENT_EVENTS_SCAN_FACTOR);
}

/** The note a folded reply ends with, or undefined when nothing was folded. */
export function foldedNote(folded: number): string | undefined {
  return folded === 0
    ? undefined
    : `(+${folded} ambient movement and party-frame events folded into state — pass {includeMovement: true} for the raw stream)`;
}

/**
 * What `recent_events` serves of a scanned span: the events shown, how many
 * ambient ones were folded out of the span they cover, and the reply's text.
 */
export function serveEvents<C extends CoreToolContext>(
  scanned: EventSummary[],
  limit: number,
  includeMovement: boolean,
  render: Pick<CoreToolRender<C>, "eventLine" | "isAmbient">,
): { visible: EventSummary[]; folded: number; text: string } {
  if (includeMovement) {
    return { visible: scanned, folded: 0, text: scanned.length === 0 ? "no events yet" : scanned.map((e) => render.eventLine(e)).join("\n") };
  }
  const ambient = (e: EventSummary): boolean => render.isAmbient(e.opcode, e.data);
  // An event a child extension marked as a bystander's (a harness's
  // spell combat-log line nobody of ours is in) is left out as the
  // harness's own event window leaves it out; it is not movement, so it
  // is not counted below.
  const visible = scanned.filter((e) => !ambient(e) && e.bystander !== true).slice(-limit);
  // The span the reply covers. When `limit` truncated the signal events,
  // it starts at the oldest visible one — reporting ambient events from
  // before it would credit the note with a span the reply never showed.
  // When it did not, the reply is everything there was, so the span is
  // the whole scan and leading ambient events still get counted (an
  // all-movement buffer must say so, not silently look empty).
  const spanStart = visible.length < limit ? 0 : scanned.indexOf(visible[0]!);
  const folded = scanned.slice(spanStart).filter(ambient).length;
  const note = foldedNote(folded);
  if (visible.length === 0) return { visible, folded, text: note === undefined ? "no events yet" : `no non-ambient events yet\n${note}` };
  const lines = visible.map((e) => render.eventLine(e));
  if (note !== undefined) lines.push(note);
  return { visible, folded, text: lines.join("\n") };
}

/**
 * How a harness shows the core tools' answers: the event line and the state
 * summary are its context rendering, and which events are ambient is its
 * context policy: by opcode, and by the event's data where an opcode carries
 * both signal and noise. `afterSnippet` is what a snippet result ends with after its
 * hint block, if anything (a harness's "what changed since the last snippet").
 */
export interface CoreToolRender<C extends CoreToolContext> {
  eventLine(e: EventSummary): string;
  isAmbient(opcode: string, data?: unknown): boolean;
  stateSummary(snapshot: Record<string, unknown>, o: { sessionLive: boolean }): string;
  afterSnippet?(ctx: C): Promise<string | undefined>;
}

export type CoreToolName = "run_snippet" | "recent_events" | "state_summary" | "write_scratchpad" | "edit_scratchpad";

/** The five core tools, rendered the harness's way. A harness orders them among its own. */
export function coreTools<C extends CoreToolContext>(render: CoreToolRender<C>): Record<CoreToolName, ToolSpec<C>> {
  return {
    run_snippet: {
      def: {
        name: "run_snippet",
        description:
          "Execute a TypeScript snippet in the persistent game sandbox. Top-level bindings persist across snippets; `sdk`, `state`, `events`, `connect()`, `sleep(ms)`, `scratchpad` (its read(), write() and append() each return a Promise: `await scratchpad.read()`) and `signal` (aborted if this snippet is abandoned) are ambient. A single expression returns its value. This is the only way to act in the world.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "TypeScript source to evaluate." },
          },
          required: ["code"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({ code: z.string().min(1) }),
      help: "run_snippet expects { code: string } — the TypeScript source to evaluate.",
      aliases: { cmd: "code", snippet: "code", source: "code", script: "code", ts: "code" },
      run: async (ctx, args, origin) => {
        const { code } = args as { code: string };
        const res = await ctx.sandbox.evalSnippet(code, { callTs: origin.dispatchTs, turn: ctx.turn() });
        return snippetToolResult(ctx, res, render);
      },
    },
    recent_events: {
      def: {
        name: "recent_events",
        description:
          "Return the most recent game events (server packets as JSON), oldest first. Use after acting to see what the server said. Ambient movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*) are folded out by default — they fold into cached state instead, and a trailing note says how many were dropped. Pass includeMovement: true for the raw stream.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              description: "How many events to return, counted AFTER the movement fold. Default 50.",
            },
            includeMovement: {
              type: "boolean",
              description:
                "Include ambient movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*). Default false.",
            },
          },
          additionalProperties: false,
        },
      },
      schema: z
        .strictObject({
          // Lenient by declaration ("How many events", 1-200): coerce numeric
          // strings and clamp to the documented range rather than refusing.
          limit: z.coerce
            .number()
            .transform((n) => Math.min(200, Math.max(1, Math.round(n))))
            .default(50),
          includeMovement: booleanish.default(false),
        })
        // `.prefault({})`, not `.default({ limit: 50 })`: a `default` value is
        // returned as-is, so naming only some fields would pin the rest out of
        // existence; a prefault re-parses `{}` and lets the field defaults run.
        .prefault({}),
      help:
        "recent_events expects { limit?: number, includeMovement?: boolean } — how many events to return " +
        "(1-200, default 50, counted after ambient movement is folded out), and whether to include ambient " +
        "movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*; default false). includeMovement is new: it used to " +
        "serve every packet unconditionally.",
      aliases: { include_movement: "includeMovement", includemovement: "includeMovement" },
      run: async (ctx, args, origin) => {
        const { limit, includeMovement } = args as { limit: number; includeMovement: boolean };
        // `limit` counts SIGNAL events, so without the raw stream a wider span is scanned and folded within.
        const scanned = await ctx.sandbox.recentEvents(recentEventsScan(limit, includeMovement));
        const served = serveEvents(scanned, limit, includeMovement, render);
        ctx.onEventsServed?.(served.visible, served.folded);
        ctx.record?.eventsServed(origin.dispatchTs, served.visible, served.folded);
        return { text: served.text };
      },
    },
    state_summary: {
      def: {
        name: "state_summary",
        description:
          "A formatted summary of the cached game state: character, level, position, recent chat and notifications, whether any events were missed.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      schema: z.strictObject({}).default({}),
      help: "state_summary takes no parameters ({}).",
      run: async (ctx) => {
        const snapshot = await ctx.sandbox.stateSnapshot();
        // Liveness from the snapshot just fetched, not a loop's per-turn
        // flag: a CLI driver's turn spans many tool calls and the stale flag
        // contradicted the populated character data next to it.
        const live = (snapshot as { self?: { guid?: unknown } }).self?.guid != null;
        return { text: render.stateSummary(snapshot, { sessionLive: live }) };
      },
    },
    write_scratchpad: {
      def: {
        name: "write_scratchpad",
        description:
          "Replace the entire scratchpad with new markdown. Keep it current: plan, progress, durable facts. It survives restarts; conversation history does not.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The full new scratchpad content (markdown)." },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({ content: z.string() }),
      help: "write_scratchpad expects { content: string } — the full new scratchpad markdown.",
      aliases: { text: "content", markdown: "content" },
      run: async (ctx, args) => {
        const { content } = args as { content: string };
        const res = ctx.scratchpad.write(content);
        if (!res.ok) return { text: overCapText("write_scratchpad", res.chars), isError: true };
        return { text: `written (${res.chars} chars)` };
      },
    },
    edit_scratchpad: {
      def: {
        name: "edit_scratchpad",
        description:
          "Change part of the scratchpad in place: replace the exact text `old` with `new`. " +
          "Use this for ordinary upkeep — striking a done item, correcting a coordinate, adding a line under a heading — " +
          "and write_scratchpad only to start the pad or rewrite it wholesale. " +
          "`old` must match the pad byte for byte, whitespace included, and must appear exactly once unless replaceAll is set.",
        inputSchema: {
          type: "object",
          properties: {
            old: { type: "string", description: "The exact existing text to replace, copied from the scratchpad." },
            new: { type: "string", description: "What to put in its place. Empty string deletes the text." },
            replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique one. Default false." },
          },
          required: ["old", "new"],
          additionalProperties: false,
        },
      },
      // `old` is deliberately not `.min(1)`: an empty `old` is a semantic refusal
      // with its own hint ("use write_scratchpad to start a pad"), and a schema
      // error would replace that with the generic parameter restatement.
      schema: z.strictObject({
        old: z.string(),
        new: z.string(),
        replaceAll: booleanish.default(false),
      }),
      help:
        "edit_scratchpad expects { old: string, new: string, replaceAll?: boolean } — the exact existing text to " +
        "replace, what to put there, and whether to replace every occurrence (default false, which requires old to " +
        "appear exactly once).",
      aliases: {
        old_string: "old",
        oldString: "old",
        old_text: "old",
        search: "old",
        new_string: "new",
        newString: "new",
        new_text: "new",
        replace: "new",
        replace_all: "replaceAll",
        replaceall: "replaceAll",
      },
      run: async (ctx, args) => {
        const { old, new: replacement, replaceAll } = args as {
          old: string;
          new: string;
          replaceAll: boolean;
        };
        const res = ctx.scratchpad.edit(old, replacement, replaceAll);
        if (!res.ok) {
          if (res.reason === "over_cap") return { text: overCapText("edit_scratchpad", res.chars), isError: true };
          return { text: EDIT_SCRATCHPAD_HINTS[res.reason](res.matches), isError: true };
        }
        const where = res.replaced === 1 ? "1 replacement" : `${res.replaced} replacements`;
        return { text: `edited (${where}; ${res.chars} chars, ${res.lines} lines)` };
      },
    },
  };
}

// ---------------------------------------------------------- program tools

/**
 * What the program tools need of the sandbox: the program its host holds
 * (`SandboxHost.program`), or a stand-in. Each call answers with the text its
 * tool result carries.
 */
export interface ToolProgram {
  readFile(path: unknown, range?: { offset?: number | undefined; limit?: number | undefined }): ProgramToolAnswer;
  writeFile(path: unknown, content: unknown, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramToolAnswer>;
  editFile(path: unknown, oldText: unknown, newText: unknown, replaceAll: unknown, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramToolAnswer>;
  deleteFile(path: unknown, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramToolAnswer>;
  startRoutine(o: { name: string; args?: unknown; character?: string | undefined }, link?: { callTs?: number | undefined; turn?: number | undefined }): Promise<ProgramToolAnswer>;
  stopRoutine(o: { name: string; character?: string | undefined }): Promise<ProgramToolAnswer>;
}

export interface ProgramToolAnswer {
  ok: boolean;
  text: string;
}

/** The context of a dispatcher that serves the program tools. */
export interface ProgramToolContext extends CoreToolContext {
  program: ToolProgram;
}

export type ProgramToolName = "run_snippet" | "read_file" | "write_file" | "edit_file" | "delete_file" | "start_routine" | "stop_routine";

/** The file limits as the descriptions state them (`workspace.ts` holds the rule). */
const PROGRAM_FILE_MAX_CHARS = 32_000;
const PROGRAM_WORKSPACE_MAX_BYTES = 1_048_576;

/** `run_snippet` as a sandbox that hosts a program describes it: a one-off. */
export const PROGRAM_RUN_SNIPPET_DESCRIPTION =
  "Run a TypeScript snippet once in the game sandbox. `sdk`, `state`, `events`, `connect()`, `sleep(ms)`, `scratchpad` (its read(), write() and append() each return a Promise: `await scratchpad.read()`), `memory` and `signal` (aborted when this snippet returns or is abandoned) are ambient, and your workspace files import by relative path. A single expression returns its value. Nothing a snippet declares or starts outlives it; what must keep running is a routine (start_routine).";

const answer = (a: ProgramToolAnswer): ToolResult => (a.ok ? { text: a.text } : { text: a.text, isError: true });

/**
 * The tools of a sandbox that hosts a program, rendered the harness's way: a
 * harness serves them in place of the core `run_snippet` and beside the other
 * four core tools, in the order it chooses. With `characters` (fan-out above
 * 1) the routine tools take the character a routine runs for.
 */
export function programTools<C extends ProgramToolContext>(render: CoreToolRender<C>, o: { characters?: boolean } = {}): Record<ProgramToolName, ToolSpec<C>> {
  const core = coreTools(render);
  const character = o.characters === true;
  const characterProp = character
    ? { character: { type: "string", description: "The character the routine runs for: its `sdk`, `state` and `events` are that character's. Omit for a routine that drives several through `chars`." } }
    : {};
  const routineSchema = (extra: Record<string, z.ZodType>): z.ZodType => z.strictObject({ name: z.string().min(1), ...extra, ...(character ? { character: z.string().min(1).optional() } : {}) });
  const link = (ctx: C, origin: CallOrigin): { callTs?: number | undefined; turn?: number | undefined } => ({ callTs: origin.dispatchTs, turn: ctx.turn() });
  return {
    run_snippet: { ...core.run_snippet, def: { ...core.run_snippet.def, description: PROGRAM_RUN_SNIPPET_DESCRIPTION } },
    read_file: {
      def: {
        name: "read_file",
        description:
          "Return one file from your workspace, its text exactly as stored. The path is relative to the workspace, e.g. main.ts or lib/combat.ts. " +
          "offset and limit, both optional, return part of it instead: limit lines from line offset (counted from 1), under one line saying which lines of how many they are.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path, e.g. main.ts or lib/combat.ts." },
            offset: { type: "integer", minimum: 1, description: "The first line to return, counted from 1. Omit to start at the first line." },
            limit: { type: "integer", minimum: 1, description: "How many lines to return. Omit to read to the last line." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({ path: z.string(), offset: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).optional() }),
      help: "read_file expects { path: string, offset?: number, limit?: number } — a workspace-relative path such as main.ts or lib/combat.ts, and optionally the first line (from 1) and how many lines.",
      aliases: { file: "path", file_path: "path", filePath: "path", start: "offset", from: "offset", line: "offset", lines: "limit", count: "limit" },
      run: async (ctx, args) => {
        const a = args as { path: string; offset?: number; limit?: number };
        return answer(ctx.program.readFile(a.path, a.offset === undefined && a.limit === undefined ? undefined : { offset: a.offset, limit: a.limit }));
      },
    },
    write_file: {
      def: {
        name: "write_file",
        description:
          "Create a file in your workspace, or replace a file's whole content. Paths are relative to the workspace (main.ts, lib/combat.ts); parent directories are created as needed, and .. or an absolute path is refused. " +
          `Each file holds at most ${PROGRAM_FILE_MAX_CHARS} characters and the workspace at most ${PROGRAM_WORKSPACE_MAX_BYTES} bytes: a write past a limit is refused and nothing is written. ` +
          "A write that changes main.ts or a file it imports loads your program at once; the result says whether it loaded and which running routines were restarted.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path, e.g. main.ts or lib/combat.ts." },
            content: { type: "string", description: "The file's whole new content. May be empty." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({ path: z.string(), content: z.string() }),
      help: "write_file expects { path: string, content: string } — a workspace-relative path and the file's whole new content.",
      aliases: { file: "path", file_path: "path", filePath: "path", text: "content", code: "content" },
      run: async (ctx, args, origin) => {
        const { path, content } = args as { path: string; content: string };
        return answer(await ctx.program.writeFile(path, content, link(ctx, origin)));
      },
    },
    edit_file: {
      def: {
        name: "edit_file",
        description:
          "Replace exact text in a workspace file: `old` with `new`. `old` must match the file exactly, whitespace included, and appear exactly once unless replaceAll is set; a miss or a second match is refused and nothing changes. " +
          "An empty `new` deletes the text. Held to write_file's limits, and it loads your program as write_file does.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path of the file to edit." },
            old: { type: "string", description: "The exact existing text to replace, copied from the file." },
            new: { type: "string", description: "What to put in its place. Empty string deletes the text." },
            replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique one. Default false." },
          },
          required: ["path", "old", "new"],
          additionalProperties: false,
        },
      },
      // `old` is not `.min(1)`, as in `edit_scratchpad`: an empty `old` is a
      // refusal with its own sentence, which a schema error would replace.
      schema: z.strictObject({ path: z.string(), old: z.string(), new: z.string(), replaceAll: booleanish.default(false) }),
      help:
        "edit_file expects { path: string, old: string, new: string, replaceAll?: boolean } — the file, the exact existing text to " +
        "replace, what to put there, and whether to replace every occurrence (default false, which requires old to appear exactly once).",
      aliases: {
        file: "path",
        file_path: "path",
        filePath: "path",
        old_string: "old",
        oldString: "old",
        old_text: "old",
        search: "old",
        new_string: "new",
        newString: "new",
        new_text: "new",
        replace: "new",
        replace_all: "replaceAll",
        replaceall: "replaceAll",
      },
      run: async (ctx, args, origin) => {
        const a = args as { path: string; old: string; new: string; replaceAll: boolean };
        return answer(await ctx.program.editFile(a.path, a.old, a.new, a.replaceAll, link(ctx, origin)));
      },
    },
    delete_file: {
      def: {
        name: "delete_file",
        description:
          "Delete one file from your workspace. Refused when the file does not exist. Deleting main.ts or a file it imports is a load that fails: the code already running keeps running.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Workspace-relative path of the file to delete." } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      schema: z.strictObject({ path: z.string() }),
      help: "delete_file expects { path: string } — the workspace-relative path of the file to delete.",
      aliases: { file: "path", file_path: "path", filePath: "path" },
      run: async (ctx, args, origin) => answer(await ctx.program.deleteFile((args as { path: string }).path, link(ctx, origin))),
    },
    start_routine: {
      def: {
        name: "start_routine",
        description:
          "Run one exported async function of main.ts as a routine. It runs in the sandbox until it returns, throws or is stopped, with no time limit, whether or not you are awake. `args` is passed as its one argument. A name that is already running is refused and says since when. The result lists the state of every routine.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The export of main.ts to run, e.g. grind." },
            args: { description: "Passed to the function as its one argument. Any JSON value; omit for none." },
            ...characterProp,
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      schema: routineSchema({ args: z.unknown().optional() }),
      help: `start_routine expects { name: string, args?: any${character ? ", character?: string" : ""} } — the export of main.ts to run, and the one argument it is called with.`,
      aliases: { routine: "name", function: "name", fn: "name", arguments: "args", arg: "args", params: "args" },
      run: async (ctx, args, origin) => {
        const a = args as { name: string; args?: unknown; character?: string };
        return answer(await ctx.program.startRoutine({ name: a.name, ...(a.args !== undefined ? { args: a.args } : {}), character: a.character }, link(ctx, origin)));
      },
    },
    stop_routine: {
      def: {
        name: "stop_routine",
        description:
          "Stop a running routine: its signal is aborted, so its pending sdk waits reject and a move it has in flight is stopped. The result lists the state of every routine.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "The routine to stop, by the name it was started under." }, ...characterProp },
          required: ["name"],
          additionalProperties: false,
        },
      },
      schema: routineSchema({}),
      help: `stop_routine expects { name: string${character ? ", character?: string" : ""} } — the routine to stop.`,
      aliases: { routine: "name", function: "name", fn: "name" },
      run: async (ctx, args) => {
        const a = args as { name: string; character?: string };
        return answer(await ctx.program.stopRoutine({ name: a.name, character: a.character }));
      },
    },
  };
}
