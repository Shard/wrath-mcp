/**
 * `@wrathbench/mcp/record/read`: the read side of the session record and
 * nothing else — the format's types and constants, the segment reader, the
 * session reader and the store's listing. No writer, no write gate, no
 * recorder, no validator: what a process that only reads records (the
 * inspector above all, `scripts/boundary.ts` holds it here) needs.
 */

export * from "./format";
export { listSegments, parseLines, readSegment, readSegmentBytes, type ParsedLines, type SegmentRef } from "./segments";
export { SessionReader, readSessionFile, type StreamCursor } from "./reader";
export { SessionStore, type StoredSession } from "./store";
