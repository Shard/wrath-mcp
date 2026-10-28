/**
 * Which of the model's routines made an SDK call: the label a harness line
 * raised by an earlier snippet's code carries (`(from an earlier snippet: …)`).
 *
 * The line used to name the snippet by its first ~48 characters, and a party
 * run's routines are mostly started by snippets whose opening is setup:
 * `let s9 = startAI.toString(); const o9 = "sdk.mo…` named 101 lines of one
 * rogue's routine, `let src=ctl.toString()` a healer's (the 2026-10-21
 * Deadmines party, attempt a2). The sandbox knows more than the opening: every
 * snippet's compiled body is tagged with a `sourceURL` (`SNIPPET_URL`), so a
 * stack frame in it names the snippet and the line, and an async stack keeps
 * the routine's own entry as its outermost frame. In order:
 *
 *  1. The outermost named function of the model's code on the stack: `startAI`,
 *     `tick` — what the model called the routine.
 *  2. Else the outermost frame's top-level statement in its snippet: the
 *     `setInterval(…)` or IIFE that launched an anonymous routine. A
 *     snippet's own top-level code is no routine and gets no label.
 *  3. Else (code a snippet built with `eval`, which carries no snippet tag, or
 *     a verdict that arrived with no caller on the stack) the routine the
 *     originating snippet built or started: the name it assigned from an
 *     `eval`, else the function its first bare call statement starts,
 *     `startAI();`.
 *  4. Else the snippet's opening, as before.
 *
 * Pure functions over the stack text and the compiled bodies; the sandbox
 * (`entry.ts`) holds the state.
 */

/** The `sourceURL` prefix each snippet's compiled body carries, then its eval id. */
export const SNIPPET_URL = "wb-snippet-";

/** How much of a statement names a routine on its harness line. */
export const CALL_SITE_LABEL_CHARS = 48;

/**
 * Lines the `AsyncFunction` constructor puts before the body: Bun compiles
 * `async function anonymous(\n) {\n<body>`, so body line 1 is frame line 3.
 */
const BODY_LINE_OFFSET = 2;

interface Frame {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

/** `at [async ]name (file:line:col)` or `at file:line:col`, one per stack line. */
const FRAME_RE = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):\d+\)?\s*$/;

/** The names Bun gives code the model did not name. */
const UNNAMED: ReadonlySet<string> = new Set(["", "anonymous", "<anonymous>"]);

/**
 * The model's own frames, innermost first: a snippet's body (`SNIPPET_URL`)
 * or code a snippet built with `eval`, which Bun places at `evalFile`, the
 * `file://` URL of the module that compiled the snippet — the SDK's and the
 * sandbox's own frames are plain paths.
 */
function userFrames(stack: string, evalFile: string): Frame[] {
  const out: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const m = FRAME_RE.exec(raw);
    if (m === null) continue;
    const file = m[2]!;
    if (!file.startsWith(SNIPPET_URL) && file !== evalFile) continue;
    out.push({ name: (m[1] ?? "").trim(), file, line: Number(m[3]) });
  }
  return out;
}

/**
 * A statement as the label shows it: whitespace folded, the transpiler's
 * `!0`/`!1` read back, cut short, and `…` after one that runs on.
 */
function shown(text: string, more = false): string {
  const flat = text
    .replace(/(?<![\w$.)\]])!0(?![\w$.])/g, "true")
    .replace(/(?<![\w$.)\]])!1(?![\w$.])/g, "false")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
  if (flat.length > CALL_SITE_LABEL_CHARS) return `${flat.slice(0, CALL_SITE_LABEL_CHARS - 1).trimEnd()}…`;
  return more ? `${flat}…` : flat;
}

/**
 * The top-level statement of a compiled body that holds body line `line`
 * (1-based): the nearest line at or above it at the body's own indentation,
 * and whether the statement runs on past it. The transpiler indents nested
 * code two spaces deeper per level.
 */
function topLevelStatement(body: string, line: number): { text: string; more: boolean } | undefined {
  const lines = body.split("\n");
  const indent = (l: string): number => l.length - l.trimStart().length;
  const base = Math.min(...lines.filter((l) => l.trim().length > 0).map(indent));
  const top = (l: string | undefined): boolean => l !== undefined && l.trim().length > 0 && indent(l) < base + 2;
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    if (!top(lines[i])) continue;
    const next = lines[i + 1];
    return { text: lines[i]!, more: next !== undefined && next.trim().length > 0 && !top(next) };
  }
  return undefined;
}

/** Calls that set a routine up or tear one down rather than being one. */
const NOT_A_ROUTINE: ReadonlySet<string> = new Set([
  "clearInterval", "clearTimeout", "setInterval", "setTimeout", "sleep", "eval", "String", "Number", "Boolean",
  "connect", "fetch", "require",
]);

/**
 * The routine a snippet's compiled body built or started: a name it assigned
 * from an `eval` (`globalThis.startAI = eval("(" + s9 + ")")`), else its first
 * bare call statement that is not set-up (`startAI();`), by that name.
 */
export function builtRoutine(body: string): string | undefined {
  const built = /(?:^|[\s;{])(?:globalThis\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:\(0,\s*eval\)|eval)\(/m.exec(body);
  if (built !== null) return built[1];
  for (const l of body.split("\n")) {
    const call = /^\s*([A-Za-z_$][\w$]*)\(.*\);?\s*$/.exec(l);
    if (call !== null && !NOT_A_ROUTINE.has(call[1]!)) return call[1];
  }
  return undefined;
}

/**
 * The label for a call made from eval `evalId`'s context with stack `stack`:
 * rules 1–3 above, `undefined` when none applies (the caller keeps the
 * snippet's opening) and for a snippet's own top-level code, which is no
 * routine. `bodies` holds each snippet's compiled body by eval id; `evalFile`
 * is where Bun places code built with `eval` (`userFrames`).
 */
export function callSiteLabel(stack: string, evalId: number, bodies: ReadonlyMap<number, string>, evalFile: string): string | undefined {
  const all = userFrames(stack, evalFile);
  // A snippet's own top level (the AsyncFunction Bun names `anonymous`) is
  // the caller of a routine's first synchronous stretch, never the routine.
  const frames = all.filter((f) => !(f.name === "anonymous" && f.file.startsWith(SNIPPET_URL)));
  const named = frames.findLast((f) => !UNNAMED.has(f.name));
  if (named !== undefined) return named.name;
  const outer = frames.at(-1);
  if (outer !== undefined && outer.file.startsWith(SNIPPET_URL)) {
    const body = bodies.get(Number(outer.file.slice(SNIPPET_URL.length)));
    const statement = body === undefined ? undefined : topLevelStatement(body, outer.line - BODY_LINE_OFFSET);
    if (statement !== undefined) return shown(statement.text, statement.more);
  }
  if (frames.length === 0 && all.length > 0) return undefined;
  const own = bodies.get(evalId);
  return own === undefined ? undefined : builtRoutine(own);
}
