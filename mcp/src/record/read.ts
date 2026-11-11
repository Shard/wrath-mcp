/**
 * `@wrathbench/mcp/record/read`: the read side of the session record and
 * nothing else — the format's types and constants, the segment reader, the
 * session reader and the store's listing. No writer, no write gate, no
 * recorder, no validator, no retention: nothing reachable from here writes or
 * deletes a file, which `scripts/boundary.ts` checks over every module this
 * entry loads. What a process that only reads records (the inspector above
 * all, which the same script holds to this entry) needs.
 */

export * from "./format";
export { listSegments, parseLines, readSegment, readSegmentBytes, type ParsedLines, type SegmentRef } from "./segments";
export { SessionReader, readSessionFile, type StreamCursor } from "./reader";
export { SessionStore, type StoredSession } from "./store";
