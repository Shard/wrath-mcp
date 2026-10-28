/**
 * Where the generated method reference lives on disk, for a host that hands
 * it to its agent (the sandbox's ambient `API_MD_PATH`). `sdk/API.md` is
 * generated from the live prototypes by `generate-api-docs.ts` and shipped
 * with the package, so its path is this package's, not the caller's.
 */

import { join } from "node:path";

/** Absolute path of `API.md`, the SDK's generated reference. */
export const API_MD_PATH = join(import.meta.dir, "..", "API.md");
