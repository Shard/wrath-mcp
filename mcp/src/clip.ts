/**
 * Cutting strings a caller chose before they are written to disk: the hosted
 * gateway's person audit and a session record's call arguments both store
 * what a client sent, and neither may grow by whatever a client sends. A cut
 * string ends in a marker that says how long it was, so a reader can tell a
 * cut from the real thing, and a cut value keeps its shape (an object stays
 * an object), so the file stays the same JSON its readers expect.
 */

/** A string cut to `max` characters, with a marker naming its length; unchanged when it fits. */
export function clipString(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[cut, ${s.length} chars]`;
}

export interface ClipOptions {
  /** The most characters any one string keeps. */
  max: number;
  /** The most characters all strings together keep; past it, each string is cut to what is left. Default unbounded. */
  budget?: number;
  /** The most entries an object or array keeps; the rest become one marker. Default 256. */
  entries?: number;
  /** How deep objects and arrays nest before the rest becomes a marker. Default 16. */
  depth?: number;
}

/** The longest an object key keeps. */
const KEY_MAX = 128;

/**
 * A JSON-shaped value with every string (keys included) cut to `max`, the
 * strings together to `budget`, objects and arrays to `entries` entries and
 * `depth` levels. Numbers, booleans and null pass through; a value that fits
 * comes back equal.
 */
export function clipStrings(v: unknown, o: ClipOptions): unknown {
  const entries = o.entries ?? 256;
  const depth = o.depth ?? 16;
  let left = o.budget ?? Number.POSITIVE_INFINITY;
  const str = (s: string, max = o.max): string => {
    const keep = Math.max(0, Math.min(max, left));
    left -= Math.min(s.length, keep);
    return clipString(s, keep);
  };
  const walk = (x: unknown, d: number): unknown => {
    if (typeof x === "string") return str(x);
    if (x === null || typeof x !== "object") return x;
    if (d >= depth) return `…[cut, nested deeper than ${depth}]`;
    if (Array.isArray(x)) {
      const out = x.slice(0, entries).map((e) => walk(e, d + 1));
      if (x.length > entries) out.push(`…[cut, ${x.length - entries} more]`);
      return out;
    }
    const keys = Object.keys(x);
    const out: Record<string, unknown> = {};
    for (const k of keys.slice(0, entries)) out[clipString(k, KEY_MAX)] = walk((x as Record<string, unknown>)[k], d + 1);
    if (keys.length > entries) out["…"] = `[cut, ${keys.length - entries} more keys]`;
    return out;
  };
  return walk(v, 0);
}
