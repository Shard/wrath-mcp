/**
 * The one name resolver.
 *
 * METHODOLOGY, "A name in view is a valid referent, with bounded fuzz": a
 * player points at things by name, so wherever a helper or a raw action takes
 * a guid it also takes the name of something the model can currently observe.
 * Every name-taking surface in the SDK — units in view, items in bags and in
 * the bank, talents in the tree, taxi nodes, pet spells, gossip options,
 * skills, factions — runs through `resolveName` here, so the tiers and the
 * fuzz threshold are one thing rather than a dozen slightly different ones.
 *
 * Resolution is deterministic and narrow, and it never picks: exactly one
 * candidate acts, none refuses with what is in view, two or more refuse and
 * list them. Guids and opcode names are never fuzzed — their callers route
 * them away from here before it can happen.
 */

/** Which tier answered. `exact` includes a match that only normalisation made exact. */
export type ResolveTier = "exact" | "substring" | "edit";

/** What `resolveName` says about a query. `many` is any count above one, never a closest-wins pick. */
export type Resolution<T> =
  | { kind: "one"; value: T; name: string; tier: ResolveTier }
  | { kind: "none" }
  | { kind: "many"; candidates: T[] };

/**
 * The edit-distance budget, in one place, as Damerau-Levenshtein steps over
 * the *normalised* strings: none below 4 characters (a two-letter query would
 * fuzz into half the world), one up to 7, two from 8 — a long name earns a
 * second typo, a short one does not. Deliberately conservative: the tier only
 * ever runs when exact and substring both found nothing, and it still refuses
 * whenever more than one row lands inside the budget.
 */
export function editBudget(normalisedQuery: string): number {
  if (normalisedQuery.length < 4) return 0;
  return normalisedQuery.length >= 8 ? 2 : 1;
}

/**
 * Fold the spellings of one name together: case, surrounding and repeated
 * whitespace, the several apostrophes and quotes a model may type
 * (`Hall’s` / `Hall's` / `Hall\`s`), and trailing sentence punctuation. Purely
 * a spelling fold — it changes no letters, so it cannot turn one name into
 * another.
 */
export function normaliseName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["'.,!?;:]+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance, stopping as soon as
 * every cell of a row exceeds `max` — the caller only ever asks "within
 * budget?", so the exact distance past it is not worth computing.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let row: number[] = [];
  for (let i = 1; i <= a.length; ++i) {
    row = new Array<number>(b.length + 1);
    row[0] = i;
    let best = row[0]!;
    for (let j = 1; j <= b.length; ++j) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      row[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Resolve `query` against `rows` by the name `nameOf` reads off each one.
 * Rows with no name are not candidates (an unnamed row cannot be pointed at).
 *
 * Three tiers, tried in order and never blended: normalised exact, then unique
 * substring, then a unique match inside `editBudget`. A tier that finds two or
 * more answers refuses there — it does not fall through to a looser tier to
 * break its own tie, because a looser tier picking between two plausible
 * referents is the harness choosing, which is forbidden.
 */
export function resolveName<T>(
  query: string,
  rows: readonly T[],
  nameOf: (row: T) => string | undefined,
): Resolution<T> {
  const q = normaliseName(query);
  if (q.length === 0) return { kind: "none" };
  const named: { row: T; name: string; norm: string }[] = [];
  for (const row of rows) {
    const name = nameOf(row);
    if (name === undefined) continue;
    named.push({ row, name, norm: normaliseName(name) });
  }
  const answer = (hits: typeof named, tier: ResolveTier): Resolution<T> | undefined => {
    if (hits.length === 1) return { kind: "one", value: hits[0]!.row, name: hits[0]!.name, tier };
    if (hits.length > 1) return { kind: "many", candidates: hits.map((h) => h.row) };
    return undefined;
  };
  return (
    answer(named.filter((n) => n.norm === q), "exact") ??
    answer(named.filter((n) => n.norm.includes(q)), "substring") ??
    answer(
      ((budget) => (budget === 0 ? [] : named.filter((n) => editDistance(n.norm, q, budget) <= budget)))(editBudget(q)),
      "edit",
    ) ?? { kind: "none" }
  );
}

/**
 * What a result carries when the fuzz matched non-exactly: what was typed, the
 * name it landed on, and the guid acted on. A normalised-exact match carries
 * nothing — case and whitespace tolerance is always on and says nothing the
 * caller did not already know.
 */
export interface ResolvedRef {
  /** The string the caller passed. */
  input: string;
  /** The name of the thing actually acted on. */
  name: string;
  /** Its guid, where the thing has one. */
  guid?: string;
}

/** Whether a tier is worth reporting back as `resolved`. */
export function isFuzzy(tier: ResolveTier): boolean {
  return tier !== "exact";
}
