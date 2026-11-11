/**
 * `@wrathbench/mcp/record`: the session record (`docs/SESSION-FORMAT.md`).
 * The format's types, the writer a host holds, the reader and the store, and
 * the validator. Nothing here spawns or confines anything, so a process that
 * only reads records (a viewer, a collector) imports this and loads no
 * sandbox. The recorders that run beside a `WrathClient` are `./recorder`.
 */

export * from "./format";
export { WriteGate, type OwnGuid } from "./gate";
export { compressSegment, listSegments, parseLines, readSegment, readSegmentBytes, type ParsedLines, type SegmentRef } from "./segments";
export { SessionReader, readSessionFile, type StreamCursor } from "./reader";
export { DEFAULT_RETENTION_MS, SessionStore, ownGuidIndex, type StoredSession } from "./store";
export { SessionWriter, isSessionDir, type DispatchLink, type SessionWriterOptions } from "./writer";
export { liveFileSchema, manifestFileSchema, sessionFileSchema, validateRow, validateSession, type SessionValidation } from "./validate";
export type { RecordDrain, RecordedMove } from "./recorder";
export type { EventsDrain } from "./events-recorder";
export type { DeathSignal, FlightSignal } from "./watchers";
export type { PartySignal } from "./party-watch";
