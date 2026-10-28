/**
 * The bare sandbox child: the stack's runtime (`child.ts`) with no harness
 * extension. `SandboxHost` spawns this unless it is given a harness's own
 * entry, which imports `./child` the same way and passes its extensions.
 */

import { startSandboxChild } from "./child";

startSandboxChild();
