/** Cutting what a client chose before it is written to disk (`src/clip.ts`). */
import { describe, expect, test } from "bun:test";
import { clipString, clipStrings } from "../src/clip";

describe("clip", () => {
  test("a string that fits is unchanged; one that does not ends in a marker naming its length", () => {
    expect(clipString("abc", 3)).toBe("abc");
    expect(clipString("abcdef", 3)).toBe("abc…[cut, 6 chars]");
  });

  test("a value keeps its shape; strings, keys, entries and depth are bounded", () => {
    const v = { name: "n".repeat(10), list: Array.from({ length: 5 }, (_, i) => i), deep: { a: { b: { c: "d" } } }, ["k".repeat(200)]: 1, n: 3, ok: true, none: null };
    const out = clipStrings(v, { max: 4, entries: 3, depth: 2 }) as Record<string, unknown>;
    expect(out["name"]).toBe("nnnn…[cut, 10 chars]");
    expect(out["list"]).toEqual([0, 1, 2, "…[cut, 2 more]"]);
    expect(out["deep"]).toEqual({ a: "…[cut, nested deeper than 2]" });
    expect(Object.keys(out)).toHaveLength(4);
    expect(out["…"]).toBe("[cut, 4 more keys]");
    expect(clipStrings({ n: 3, ok: true, none: null, s: "ab" }, { max: 4 })).toEqual({ n: 3, ok: true, none: null, s: "ab" });
  });
});
