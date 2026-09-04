/**
 * Guids, the one primitive both halves of the wire protocol need.
 *
 * Its own module for exactly one reason: `protocol.ts` names the social
 * schemas in `eventDataSchemas`, so it imports `protocol-social.ts` at value
 * level, and `protocol-social.ts` needs `guidSchema` at module-evaluation
 * time. Reaching back into `protocol.ts` for it would be a cycle whose
 * `const` initialisers land in the TDZ — a `ReferenceError` on import that no
 * typecheck can see. A leaf both sides import has no such order.
 *
 * `protocol.ts` re-exports everything here, so `./protocol` still names it.
 */

import { z } from "zod";

/**
 * ObjectGuids are u64, and the module serialises every one of them as a decimal
 * *string* (PROTOCOL.md, "u64 values are decimal strings"): creature guids carry
 * a high part (0xF130…) far above `Number.MAX_SAFE_INTEGER`, so a bare JSON
 * number would already be corrupted by `JSON.parse` before this schema ran.
 *
 * The schema emits the guid as an **opaque decimal string**: that is
 * the only representation the model surface ever carries, so `===`, Map keys,
 * template literals and `JSON.stringify` all behave as a model expects. The
 * round-trip through `parseGuid`/`formatGuid` canonicalises ("007" -> "7") and
 * validates in one step — which is what the 2^63 test pins down. Numbers are
 * still accepted on input, because the Stage-2 slice's small player guids were
 * emitted that way and a fixture may still use them.
 */
export const guidSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx): GuidKey => {
    try {
      return formatGuid(typeof v === "number" ? BigInt(Math.trunc(v)) : parseGuid(v));
    } catch {
      ctx.addIssue({ code: "custom", message: `not a guid: ${String(v)}` });
      return z.NEVER;
    }
  });

/** A guid as the model surface carries it: an opaque decimal string. */
export type GuidKey = string;

// The one auditable seam between the string surface and the SDK's internal
// bigint use (bit packing/unpacking). A bigint never escapes past this pair to
// anything model-visible.

/** SDK-internal: a guid string as a u64 for bit arithmetic. Throws on non-decimal input. */
export function parseGuid(guid: string): bigint {
  return BigInt(guid);
}

/** SDK-internal: render a u64 back into the canonical decimal-string form. */
export function formatGuid(guid: bigint): GuidKey {
  return guid.toString(10);
}

/**
 * Canonical decimal-string form of a guid, whichever representation it arrives
 * in. Retained as the public guid -> map-key conversion; for a string off
 * today's SDK surface it canonicalises (and is usually the identity).
 */
export function guidKey(guid: bigint | string): GuidKey {
  return typeof guid === "bigint" ? formatGuid(guid) : formatGuid(parseGuid(guid));
}
