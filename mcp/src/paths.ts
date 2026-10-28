/**
 * Where the stack's runnable files are, for a host that launches them: the
 * bridge a CLI agent is handed as its MCP server command, and the sandbox's
 * confinement wrapper and bare child entry. A leaf with no imports but
 * `node:path`, so a process that only needs a path loads nothing else.
 */

import { join } from "node:path";

/** The stdio <-> TCP bridge a CLI agent is handed as its MCP server command (`bridge.ts`). */
export const MCP_BRIDGE_PATH = join(import.meta.dir, "bridge.ts");
/** The Landlock wrapper every sandbox child is exec'd through (`sandbox/confine.ts`). */
export const SANDBOX_CONFINE_PATH = join(import.meta.dir, "sandbox", "confine.ts");
/** The bare sandbox child, with no harness extension (`sandbox/entry.ts`); `SandboxHost`'s default. */
export const SANDBOX_ENTRY_PATH = join(import.meta.dir, "sandbox", "entry.ts");
