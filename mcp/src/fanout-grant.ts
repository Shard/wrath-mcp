/**
 * The fan-out grant on its own: how many characters one client may have in
 * the world at once and on which accounts, and why one cannot stand. A leaf
 * with no imports, so what checks a grant (the hosted grants' read side,
 * `hosted/grants-read.ts`) loads none of the tool surface; `fanout.ts`
 * re-exports it.
 */

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
