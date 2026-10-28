/**
 * The SDK's own version, and the module protocol it speaks.
 *
 * `SDK_VERSION` is this package's `package.json` version (a test holds the
 * two together), separate from the harness's (docs/METHODOLOGY.md, "Fixed
 * harness, frozen per version"). As built, the runner depends on it at an
 * exact version and records it per run (`sdkVersion`, docs/ARCHITECTURE.md);
 * `@wrathbench/mcp` carries the same version.
 *
 * `MODULE_PROTOCOL_VERSIONS` are the module protocol versions this SDK can
 * drive (`module/PROTOCOL.md`, "Versioning"): the integer the module serves
 * as `protocol` on `GET /health`. The module bumps it only for a change an
 * existing SDK would misread; additions to the protocol do not move it.
 */

export const SDK_VERSION = "0.1.0";

/** The module protocol versions this SDK can drive. */
export const MODULE_PROTOCOL_VERSIONS: readonly number[] = [1];

/** A module whose protocol this SDK cannot drive: thrown by `connect` before anything else is sent. */
export class ModuleProtocolError extends Error {
  constructor(
    readonly served: number,
    readonly supported: readonly number[],
  ) {
    super(
      `the module speaks protocol ${served}, and this SDK (${SDK_VERSION}) speaks ${supported.join(", ")}: ` +
        `use an SDK release for protocol ${served}, or a module build for ${supported.join(" or ")} (module/PROTOCOL.md, "Versioning")`,
    );
    this.name = "ModuleProtocolError";
  }
}

/**
 * Whether this SDK can drive the module that answered `/health`; throws
 * `ModuleProtocolError` when it cannot. A module that serves no `protocol`
 * predates the field and speaks protocol 1, the protocol this SDK was written
 * against, so it passes. Read off the response as served, not through the
 * health schema, which keeps parsing whatever else a module adds.
 */
export function checkModuleProtocol(health: object): void {
  const served = (health as { protocol?: unknown }).protocol;
  if (typeof served !== "number") return;
  if (!MODULE_PROTOCOL_VERSIONS.includes(served)) throw new ModuleProtocolError(served, MODULE_PROTOCOL_VERSIONS);
}
