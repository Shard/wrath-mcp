/**
 * The wire's mirror of the record's files (`src/wire.ts`) holds to the
 * format's own types (`@wrathbench/mcp/record/read`): a `session.json` and a
 * `live.json` the stack writes are what the views read. A compile-time check,
 * run by `bun run typecheck`; the test only makes it part of the suite.
 */

import { expect, test } from "bun:test";
import type { LiveFile, SessionFile, StreamName } from "@wrathbench/mcp/record/read";
import type { LiveFileWire, SessionFileWire, StreamNameWire } from "../src/wire";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("the wire's session.json, live.json and stream names are the format's", () => {
  const session: SessionFileWire = {} as SessionFile;
  const live: LiveFileWire = {} as LiveFile;
  const streams: Same<StreamName, StreamNameWire> = true;
  expect([session, live, streams]).toBeDefined();
});
