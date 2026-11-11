/**
 * `@wrathbench/inspector`: the server half of wrath-inspector. A harness
 * embeds `createInspectorApi` over a source of its own (`SessionSource`), or
 * over `storeSource(dir)`; the readout functions are what the API is built
 * from, for a harness that serves the same shapes under its own paths.
 *
 * Browser-safe entry points are separate and import nothing server-side:
 * `@wrathbench/inspector/wire` (the wire types) and
 * `@wrathbench/inspector/codec/trace`, `@wrathbench/inspector/codec/nearby`
 * (the packed-window codecs).
 */

export { createInspectorApi, MAX_ROWS_RANGE_MS, type InspectorApi, type InspectorApiOptions } from "./api";
export { SECRET_ENV, SESSION_COOKIE, bearerScope, bindRefusal, isLoopbackHost } from "./auth";
export * from "./readout";
export { OPERATOR, ROW_LEAD_MS, inScope, rowsBetween, type SegmentInfo, type SessionEntry, type SessionHandle, type SessionScope, type SessionSource, type StreamStat, type TailBatch, type TimeRange } from "./source";
export { StoredSessionHandle, decodeCursor, encodeCursor, storeSource } from "./store-source";
export { PAGE_DIR, inspectorHandler, serveInspector, type InspectorServerOptions } from "./serve";
export type * from "./wire";
