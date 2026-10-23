/**
 * The achievement broadcast as a client prints it (deadmines@4, 08:14:57: the
 * model read "%s has earned the achievement $a!" under each member's name).
 * The server sends `CHAT_MSG_ACHIEVEMENT` first and `SMSG_ACHIEVEMENT_EARNED`,
 * which the module names from `Achievement.dbc`, right after it, to everyone
 * in say range; the line is filled when it is read. Frames are hand-written
 * from module/PROTOCOL.md with invented names and ids.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));
const SEED = { guid: SELF_GUID, name: "Fenwick" };
const FRIEND = "1000";

const toEvents = (list: readonly unknown[]): GameEvent[] =>
  list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

const line = (seq: number, guid: string, achievementId: number | undefined, type = 48) =>
  frame(seq, "SMSG_MESSAGECHAT", {
    type,
    language: 0,
    senderGuid: guid,
    receiverGuid: guid,
    message: "%s has earned the achievement $a!",
    chatTag: 0,
    ...(achievementId !== undefined ? { achievementId } : {}),
  });
const earned = (seq: number, guid: string, achievementId: number, name?: string) =>
  frame(seq, "SMSG_ACHIEVEMENT_EARNED", {
    guid,
    self: guid === SELF_GUID,
    achievement: { achievementId, date: 0, ...(name !== undefined ? { name, points: 10, categoryId: 14808 } : {}) },
  });
const nameAnswer = (seq: number, guid: string, name: string) =>
  frame(seq, "SMSG_NAME_QUERY_RESPONSE", { guid, found: true, name });

const replay = (list: readonly unknown[]) => StateCache.replay(toEvents([...loginSequence, ...list]), { seed: SEED });

describe("state.chat fills the achievement broadcast as a client does", () => {
  test("another player's line takes their name and the name their earn gave the achievement", () => {
    const c = replay([nameAnswer(30, FRIEND, "Tankfriend"), line(31, FRIEND, 628), earned(32, FRIEND, 628, "Deadmines")]);
    expect(c.chat.map((l) => l.message)).toEqual(["Tankfriend has earned the achievement [Deadmines]!"]);
    // Another player's earn names the line and nothing else: it is not ours.
    expect(c.self.achievements).toBeUndefined();
  });

  test("our own line takes our name and our earn's achievement name", () => {
    const c = replay([line(30, SELF_GUID, 628), earned(31, SELF_GUID, 628, "Deadmines")]);
    expect(c.chat.map((l) => l.message)).toEqual(["Fenwick has earned the achievement [Deadmines]!"]);
  });

  test("before its earn lands, or with no name served, the link is the id; an unnamed sender stays %s", () => {
    const before = replay([nameAnswer(30, FRIEND, "Tankfriend"), line(31, FRIEND, 628)]);
    expect(before.chat[0]!.message).toBe("Tankfriend has earned the achievement [achievement 628]!");
    const noDbc = replay([line(30, "1003", 628), earned(31, "1003", 628)]);
    expect(noDbc.chat[0]!.message).toBe("%s has earned the achievement [achievement 628]!");
  });

  test("a guild achievement line reads the same; the login backlog names an id too", () => {
    const c = replay([
      frame(30, "SMSG_ALL_ACHIEVEMENT_DATA", { count: 1, achievements: [{ achievementId: 6, date: 0, name: "Level 10", points: 10 }] }),
      nameAnswer(31, FRIEND, "Tankfriend"),
      line(32, FRIEND, 6, 49),
    ]);
    expect(c.chat.map((l) => l.message)).toEqual(["Tankfriend has earned the achievement [Level 10]!"]);
  });

  test("the snapshot carries the same text", () => {
    const c = replay([nameAnswer(30, FRIEND, "Tankfriend"), line(31, FRIEND, 628), earned(32, FRIEND, 628, "Deadmines")]);
    expect(c.snapshot().chat.map((l) => l.message)).toEqual(["Tankfriend has earned the achievement [Deadmines]!"]);
  });
});

describe("waitForChat sees the achievement line as state.chat does", () => {
  test("a match on the achievement's name answers once the earn that names it lands", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
    push(stub, nameAnswer(30, FRIEND, "Tankfriend"));
    const hit = client.waitForChat((l) => l.message.includes("[Deadmines]"), { timeout: 2000, includeBuffered: false });
    push(stub, line(31, FRIEND, 628));
    push(stub, earned(32, FRIEND, 628, "Deadmines"));
    const got = await hit;
    expect(got.message).toBe("Tankfriend has earned the achievement [Deadmines]!");
    expect(got.seq).toBe(31);
    client.close();
    await stub.stop();
  });
});
