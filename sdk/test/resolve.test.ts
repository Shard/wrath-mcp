import { describe, expect, test } from "bun:test";
import { editBudget, editDistance, isFuzzy, normaliseName, resolveName } from "../src/resolve";

const row = (name: string | undefined, guid = "1") => ({ name, guid });

function one<T>(r: ReturnType<typeof resolveName<T>>): { name: string; tier: string } {
  if (r.kind !== "one") throw new Error(`expected one, got ${r.kind}`);
  return { name: r.name, tier: r.tier };
}

describe("normaliseName", () => {
  test("folds case, whitespace, apostrophes and trailing punctuation", () => {
    expect(normaliseName("  Hall’s   Brewery  ")).toBe("hall's brewery");
    expect(normaliseName("Hall`s Brewery")).toBe("hall's brewery");
    expect(normaliseName("Kobold Vermin.")).toBe("kobold vermin");
    expect(normaliseName('"Rockjaw Raider"')).toBe("rockjaw raider");
  });

  test("changes no letters", () => {
    expect(normaliseName("Grik'nir")).toBe("grik'nir");
    expect(normaliseName("")).toBe("");
  });
});

describe("editBudget", () => {
  test("is 0 under 4 chars, 1 to 7, 2 from 8", () => {
    expect(editBudget("or")).toBe(0);
    expect(editBudget("boa")).toBe(0);
    expect(editBudget("boar")).toBe(1);
    expect(editBudget("kobolds")).toBe(1);
    expect(editBudget("rockjaw ")).toBe(2);
    expect(editBudget("frostmane troll")).toBe(2);
  });
});

describe("editDistance", () => {
  test("counts substitutions, insertions and transpositions", () => {
    expect(editDistance("boar", "bear", 2)).toBe(1);
    expect(editDistance("boar", "boars", 2)).toBe(1);
    expect(editDistance("boar", "obar", 2)).toBe(1); // transposition is one step
    expect(editDistance("boar", "boar", 2)).toBe(0);
  });

  test("gives up past max rather than counting on", () => {
    expect(editDistance("boar", "murloc", 1)).toBeGreaterThan(1);
    expect(editDistance("a", "abcdefgh", 2)).toBeGreaterThan(2);
  });
});

describe("resolveName tiers", () => {
  const rows = [row("Kobold Vermin", "10"), row("Kobold Laborer", "11"), row("Ragged Timber Wolf", "12")];

  test("exact wins, and normalised-exact still counts as exact", () => {
    expect(one(resolveName("Kobold Vermin", rows, (r) => r.name))).toEqual({ name: "Kobold Vermin", tier: "exact" });
    expect(one(resolveName("  kobold   vermin. ", rows, (r) => r.name))).toEqual({
      name: "Kobold Vermin",
      tier: "exact",
    });
  });

  test("unique substring is the second tier", () => {
    expect(one(resolveName("timber", rows, (r) => r.name))).toEqual({ name: "Ragged Timber Wolf", tier: "substring" });
  });

  test("a unique near-miss is the third tier", () => {
    expect(one(resolveName("Ragged Timber Wolv", rows, (r) => r.name))).toEqual({
      name: "Ragged Timber Wolf",
      tier: "edit",
    });
    expect(one(resolveName("Kobold Vermon", rows, (r) => r.name))).toEqual({ name: "Kobold Vermin", tier: "edit" });
  });

  test("an ambiguous substring refuses with every candidate, never the closest", () => {
    const r = resolveName("kobold", rows, (x) => x.name);
    if (r.kind !== "many") throw new Error(`expected many, got ${r.kind}`);
    expect(r.candidates.map((c) => c.guid)).toEqual(["10", "11"]);
  });

  test("an ambiguous substring does not fall through to the edit tier to break its tie", () => {
    // "Kobold Vermin" is edit-distance 0 from itself and would win a
    // closest-match contest; the substring tier still refuses.
    expect(resolveName("Kobold ", rows, (r) => r.name).kind).toBe("many");
  });

  test("two rows inside the edit budget refuse rather than picking the nearer one", () => {
    // "Ironfarge Guard" is one step from the first and two from the second,
    // and a substring of neither; both are inside the budget, so it refuses.
    const pair = [row("Ironforge Guard", "1"), row("Ironforge Guards", "2")];
    expect(resolveName("Ironfarge Guard", pair, (r) => r.name).kind).toBe("many");
  });

  test("nothing matching is none, and a short query never fuzzes", () => {
    expect(resolveName("murloc", rows, (r) => r.name).kind).toBe("none");
    expect(resolveName("wlf", [row("Wolf")], (r) => r.name).kind).toBe("none"); // under 4 chars, no fuzz
    expect(resolveName("", rows, (r) => r.name).kind).toBe("none");
  });

  test("unnamed rows are not candidates", () => {
    expect(resolveName("kobold", [row(undefined, "9"), row("Kobold Vermin", "10")], (r) => r.name).kind).toBe("one");
  });
});

describe("isFuzzy", () => {
  test("only the non-exact tiers are worth reporting", () => {
    expect(isFuzzy("exact")).toBe(false);
    expect(isFuzzy("substring")).toBe(true);
    expect(isFuzzy("edit")).toBe(true);
  });
});
