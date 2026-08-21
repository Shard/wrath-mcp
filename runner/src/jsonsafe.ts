/**
 * JSON that survives the game's data. Guids are bigints; JSON.stringify throws
 * on those. Everything the runner persists or shows the model goes through
 * here, so one rule applies everywhere: bigint renders as its decimal string.
 * That is lossy in type but not in value, and the trajectory stays greppable.
 */

/** Recursively convert a value into something JSON.stringify accepts. */
export function toJsonSafe(value: unknown, depth = 8): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "function") return `[function ${(value as { name?: string }).name ?? "anonymous"}]`;
  if (t === "symbol") return String(value);
  if (t !== "object") return value;
  if (depth <= 0) return "[depth limit]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) out[String(k)] = toJsonSafe(v, depth - 1);
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => toJsonSafe(v, depth - 1));
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth - 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = toJsonSafe(v, depth - 1);
  }
  return out;
}

/** One JSONL line: bigint-safe, no trailing newline. */
export function jsonLine(record: unknown): string {
  return JSON.stringify(toJsonSafe(record));
}

/** Compact single-line rendering with a hard length cap, for event summaries. */
export function compactJson(value: unknown, maxChars = 240): string {
  let s: string;
  try {
    s = JSON.stringify(toJsonSafe(value));
  } catch {
    s = String(value);
  }
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 2)} …`;
}
