/**
 * The user scope over a hosted gateway's state directory: a person sees the
 * session stores of the credentials they hold and nothing a record claims,
 * signs in with the same key as the MCP, and loses access at the next
 * request once that key no longer stands.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileGrantSource, keyDigest } from "@wrathbench/mcp/hosted/grants-read";
import { OPERATOR, createInspectorApi, hostedSessionId, hostedSource, inspectorAuth, inspectorHandler, rowsBetween, type SessionScope } from "../src/index";
import { CLOSED_ID, FIXTURE_T0, LIVE_ID, plant, tempDir } from "./fixtures";

const tmp = tempDir();
const SECRET = "an-inspector-secret-of-length";
const KEYS = { a1: "wmk_alice-one-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", a2: "wmk_alice-two-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", b1: "wmk_bob-one-key-ccccccccccccccccccccccccccccccccc" };
/** A session directory in bob's store whose record claims to be alice's closed session. */
const FORGED = "0123456789abcdef";

/** A gateway's state: alice holds a1 and a2, bob b1; b1's record says alice owns it, with her session's id. */
function plantState(dir: string): string {
  const store = (cred: string): string => join(dir, "tenants", cred, "sessions");
  for (const c of ["a1", "a2", "b1"]) mkdirSync(store(c), { recursive: true });
  plant("closed", join(store("a1"), CLOSED_ID), { owner: "alice" });
  plant("live", join(store("a2"), LIVE_ID), { owner: "alice" });
  plant("closed", join(store("b1"), FORGED), { owner: "alice", id: CLOSED_ID, group: "shared-label" });
  return dir;
}

interface GrantSpec {
  id: string;
  person: string;
  key?: string;
  account: string;
  disabled?: boolean;
}

/** Write a grants file in place by rename, as the grants CLI does, so a reader sees it whole. */
function writeGrants(path: string, grants: GrantSpec[]): void {
  const file = {
    version: 1,
    reservedAccounts: [],
    globalMaxCharacters: 50,
    grants: grants.map((g) => ({
      id: g.id,
      person: g.person,
      keyHashes: g.key === undefined ? [] : [{ id: `k${g.id}00`, sha256: keyDigest(g.key) }],
      accounts: [g.account],
      maxCharacters: 1,
      ...(g.disabled === true ? { disabled: true } : {}),
    })),
  };
  writeFileSync(`${path}.tmp`, JSON.stringify(file));
  renameSync(`${path}.tmp`, path);
}

const ALL: GrantSpec[] = [
  { id: "a1", person: "alice", key: KEYS.a1, account: "ACC1" },
  { id: "a2", person: "alice", key: KEYS.a2, account: "ACC2" },
  { id: "b1", person: "bob", key: KEYS.b1, account: "ACC3" },
];

const user = (person: string, ...credentials: string[]): SessionScope => ({ kind: "user", person, credentials: new Set(credentials) });

describe("the hosted source", () => {
  const state = plantState(join(tmp, "state"));
  const src = hostedSource(state);
  const a1 = hostedSessionId("a1", CLOSED_ID);
  const a2 = hostedSessionId("a2", LIVE_ID);
  const b1 = hostedSessionId("b1", FORGED);

  test("the operator sees every credential's sessions, each by its credential and directory, never its record's id", async () => {
    const list = await src.list(OPERATOR);
    expect(list.map((e) => e.id).sort()).toEqual([a1, a2, b1].sort());
    for (const id of [a1, a2, b1]) expect(await src.open(id, OPERATOR)).not.toBeNull();
    // A record's group is kept within its credential: no label lists one tenant's sessions with another's.
    expect(list.find((e) => e.id === b1)?.group).toBe("b1/shared-label");
  });

  test("a user never sees another credential's session, though its record claims their owner and their session's id", async () => {
    const alice = user("alice", "a1");
    expect((await src.list(alice)).map((e) => e.id)).toEqual([a1]);
    expect(await src.open(b1, alice)).toBeNull();
    expect(await src.open(hostedSessionId("a1", FORGED), alice)).toBeNull();
    expect((await src.list(user("bob", "b1"))).map((e) => e.id)).toEqual([b1]);
    expect(await src.open(a1, user("bob", "b1"))).toBeNull();
  });

  test("a person with two credentials sees both, and a scope with none sees nothing", async () => {
    expect((await src.list(user("alice", "a1", "a2"))).map((e) => e.id).sort()).toEqual([a1, a2].sort());
    expect(await src.list(user("carol"))).toEqual([]);
    expect(await src.open(a1, user("carol"))).toBeNull();
  });

  test("an id that is not a credential and a session directory opens nothing", async () => {
    for (const id of [CLOSED_ID, "a1", "a1.", `a1/${CLOSED_ID}`, `../a1.${CLOSED_ID}`, `A1.${CLOSED_ID}`, `a1.${CLOSED_ID}x`]) expect(await src.open(id, OPERATOR)).toBeNull();
  });

  test("a link out of a credential's directory reaches nothing: at the session, at its store, or at a segment", async () => {
    const tenants = join(state, "tenants");
    // A session directory that is a link to alice's.
    mkdirSync(join(tenants, "evil", "sessions"), { recursive: true });
    symlinkSync(join(tenants, "a1", "sessions", CLOSED_ID), join(tenants, "evil", "sessions", CLOSED_ID));
    // A store that is a link to alice's.
    mkdirSync(join(tenants, "evil2"), { recursive: true });
    symlinkSync(join(tenants, "a1", "sessions"), join(tenants, "evil2", "sessions"));
    // A credential directory that is a link to alice's.
    symlinkSync(join(tenants, "a1"), join(tenants, "evil3"));
    for (const c of ["evil", "evil2", "evil3"]) {
      const scope = user("mallory", c);
      expect(await src.list(scope)).toEqual([]);
      expect(await src.open(hostedSessionId(c, CLOSED_ID), scope)).toBeNull();
    }

    // A real session of its own whose segment, and whose session.json, are links to alice's.
    const own = join(tenants, "evil4", "sessions", FORGED);
    mkdirSync(join(tenants, "evil4", "sessions"), { recursive: true });
    plant("live", own, { owner: "mallory" });
    const theirs = join(tenants, "a2", "sessions", LIVE_ID, "events", `${FIXTURE_T0 + 300_000}.jsonl`);
    const mine = join(own, "events", `${FIXTURE_T0 + 300_000}.jsonl`);
    unlinkSync(mine);
    symlinkSync(theirs, mine);
    const scope = user("mallory", "evil4");
    const h = (await src.open(hostedSessionId("evil4", FORGED), scope))!;
    expect(h).not.toBeNull();
    expect(await rowsBetween(h, "events", { from: FIXTURE_T0, to: FIXTURE_T0 + 3_600_000 })).toEqual([]);
    expect((await h.tail("events", null)).rows).toEqual([]);
    expect(await h.end("events")).toBeNull();
    expect(await h.stat("events")).toBeNull();
    unlinkSync(join(own, "session.json"));
    symlinkSync(join(tenants, "a2", "sessions", LIVE_ID, "session.json"), join(own, "session.json"));
    expect(await h.session()).toBeNull();
    expect(await src.open(hostedSessionId("evil4", FORGED), scope)).toBeNull();
    expect(await src.list(scope)).toEqual([]);
    for (const c of ["evil", "evil2", "evil3", "evil4"]) rmSync(join(tenants, c), { recursive: true, force: true });
  });
});

describe("signing in with a grant key", () => {
  const state = plantState(join(tmp, "signin"));
  const grantsPath = join(tmp, "grants.json");
  writeGrants(grantsPath, ALL);
  const grants = new FileGrantSource(grantsPath, { pollMs: 0 });
  const h = inspectorHandler({ source: hostedSource(state), host: "0.0.0.0", secret: SECRET, grants });
  const json = { "content-type": "application/json" };
  const ids = async (headers: Record<string, string>): Promise<string[] | number> => {
    const res = await h(new Request("http://x/api/sessions", { headers }));
    return res.status === 200 ? ((await res.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort() : res.status;
  };
  const signIn = async (body: unknown, headers: Record<string, string> = json): Promise<Response> => h(new Request("http://x/api/sign-in", { method: "POST", headers, body: JSON.stringify(body) }));
  const cookieOf = (res: Response): string => res.headers.get("set-cookie")!.split(";")[0]!;
  const aliceSees = [hostedSessionId("a1", CLOSED_ID), hostedSessionId("a2", LIVE_ID)].sort();

  test("the key signs in to an opaque cookie that never carries it, and sees both of the person's credentials", async () => {
    const res = await signIn({ key: KEYS.a1 });
    expect(res.status).toBe(204);
    const set = res.headers.get("set-cookie")!;
    expect(set).not.toContain(KEYS.a1);
    expect(set).not.toContain(encodeURIComponent(KEYS.a1));
    expect(set).not.toContain(keyDigest(KEYS.a1));
    for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/", "Secure", "Max-Age=43200"]) expect(set).toContain(attr);
    expect(cookieOf(res)).toMatch(/^wrath_inspector=[A-Za-z0-9_-]{43}$/);
    expect(await ids({ cookie: cookieOf(res) })).toEqual(aliceSees);
    const me = (await (await h(new Request("http://x/api/me", { headers: { cookie: cookieOf(res) } }))).json()) as unknown;
    expect(me).toEqual({ kind: "user", person: "alice", credentials: ["a1", "a2"], signedIn: true });
  });

  test("the key as a bearer header, per request or to the sign-in, is the same person", async () => {
    expect(await ids({ authorization: `Bearer ${KEYS.b1}` })).toEqual([hostedSessionId("b1", FORGED)]);
    const res = await signIn(null, { authorization: `Bearer ${KEYS.a2}` });
    expect(res.status).toBe(204);
    expect(await ids({ cookie: cookieOf(res) })).toEqual(aliceSees);
  });

  test("a user is refused another credential's session on every path, as though it did not exist", async () => {
    const cookie = cookieOf(await signIn({ key: KEYS.b1 }));
    for (const rest of ["", "/trace", "/rows/events", "/tail/events", "/moves"]) {
      expect((await h(new Request(`http://x/api/sessions/${hostedSessionId("a1", CLOSED_ID)}${rest}`, { headers: { cookie } }))).status).toBe(404);
    }
  });

  test("the operator's secret sees every session", async () => {
    const all = [hostedSessionId("a1", CLOSED_ID), hostedSessionId("a2", LIVE_ID), hostedSessionId("b1", FORGED)].sort();
    expect(await ids({ authorization: `Bearer ${SECRET}` })).toEqual(all);
    const res = await signIn({ secret: SECRET });
    expect(res.headers.get("set-cookie")).not.toContain(SECRET);
    expect(await ids({ cookie: cookieOf(res) })).toEqual(all);
  });

  test("a key is never taken from a URL's query", async () => {
    expect(await ids({})).toBe(401);
    for (const q of [`key=${KEYS.a1}`, `secret=${KEYS.a1}`, `token=${KEYS.a1}`, `authorization=Bearer%20${KEYS.a1}`]) {
      expect((await h(new Request(`http://x/api/sessions?${q}`))).status).toBe(401);
      expect((await h(new Request(`http://x/api/sign-in?${q}`, { method: "POST", headers: json, body: "{}" }))).status).toBe(401);
    }
  });

  test("an unknown key, a wrong one and a form post are refused", async () => {
    expect((await signIn({ key: "wmk_nobody" })).status).toBe(401);
    expect(await ids({ authorization: "Bearer wmk_nobody" })).toBe(401);
    expect((await signIn({ key: KEYS.a1 }, { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await h(new Request("http://x/api/sign-in"))).status).toBe(405);
  });

  test("a revoked key, a disabled grant and a removed grant each end the cookie's access at its next request", async () => {
    const fresh = async (key: string): Promise<string> => cookieOf(await signIn({ key }));
    try {
      // Revoked: the grant stands with no key.
      let cookie = await fresh(KEYS.a1);
      expect(await ids({ cookie })).toEqual(aliceSees);
      writeGrants(grantsPath, ALL.map((g) => (g.id === "a1" ? { ...g, key: undefined } : g)));
      expect(await ids({ cookie })).toBe(401);
      expect(await ids({ authorization: `Bearer ${KEYS.a1}` })).toBe(401);
      writeGrants(grantsPath, ALL);
      // Signed out of it for good: the key standing again does not bring a dropped cookie back.
      expect(await ids({ cookie })).toBe(401);

      // Disabled.
      cookie = await fresh(KEYS.a1);
      writeGrants(grantsPath, ALL.map((g) => (g.id === "a1" ? { ...g, disabled: true } : g)));
      expect(await ids({ cookie })).toBe(401);
      // alice's other key still signs her in, to her credential that stands only.
      expect(await ids({ cookie: await fresh(KEYS.a2) })).toEqual([hostedSessionId("a2", LIVE_ID)]);
      writeGrants(grantsPath, ALL);

      // Removed.
      cookie = await fresh(KEYS.a1);
      writeGrants(grantsPath, ALL.filter((g) => g.id !== "a1"));
      expect(await ids({ cookie })).toBe(401);
      writeGrants(grantsPath, ALL);

      // A sibling credential removed narrows the scope at the next request.
      cookie = await fresh(KEYS.a1);
      writeGrants(grantsPath, ALL.filter((g) => g.id !== "a2"));
      expect(await ids({ cookie })).toEqual([hostedSessionId("a1", CLOSED_ID)]);
      // A grants file that no longer reads grants nothing.
      writeFileSync(grantsPath, "{ not json");
      expect(await ids({ cookie })).toBe(401);
    } finally {
      writeGrants(grantsPath, ALL);
    }
  });

  test("sign-out forgets the cookie and clears it", async () => {
    const cookie = cookieOf(await signIn({ key: KEYS.b1 }));
    expect(await ids({ cookie })).toEqual([hostedSessionId("b1", FORGED)]);
    const out = await h(new Request("http://x/api/sign-out", { method: "POST", headers: { cookie, ...json }, body: "{}" }));
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await ids({ cookie })).toBe(401);
  });

  test("with grants nothing is anonymous, loopback included", async () => {
    const local = inspectorHandler({ source: hostedSource(state), grants });
    expect((await local(new Request("http://127.0.0.1/api/sessions"))).status).toBe(401);
    expect((await local(new Request("http://127.0.0.1/api/me"))).status).toBe(401);
    const res = await local(new Request("http://127.0.0.1/api/sign-in", { method: "POST", headers: json, body: JSON.stringify({ key: KEYS.a1 }) }));
    // Over plain http on loopback, not Secure, so the browser keeps it.
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
    expect((await local(new Request("http://127.0.0.1/api/sessions", { headers: { cookie: cookieOf(res) } }))).status).toBe(200);
  });
});

describe("a sign-in's life", () => {
  const state = plantState(join(tmp, "life"));
  const grantsPath = join(tmp, "life-grants.json");
  writeGrants(grantsPath, ALL);
  const grants = new FileGrantSource(grantsPath, { pollMs: 0 });

  test("it ends when its time is up", async () => {
    let t = 1_000_000;
    const auth = inspectorAuth({ grants, ttlMs: 60_000, now: () => t });
    const res = await auth.signIn(new Request("http://x/api/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: KEYS.a1 }) }));
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(auth.scope(new Request("http://x/", { headers: { cookie } }))?.kind).toBe("user");
    t += 60_000;
    expect(auth.scope(new Request("http://x/", { headers: { cookie } }))).toBeNull();
    expect(auth.signIns).toBe(0);
  });

  test("an open tail ends at the next poll once the key is revoked", async () => {
    const auth = inspectorAuth({ grants });
    const res = await auth.signIn(new Request("http://x/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: KEYS.a2 }) }));
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const api = createInspectorApi(hostedSource(state), { scope: auth.scope, tailPollMs: 20 });
    const tail = (await api(new Request(`http://x/sessions/${hostedSessionId("a2", LIVE_ID)}/tail/events`, { headers: { cookie } })))!;
    expect(tail.status).toBe(200);
    const reader = tail.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"hello"');
    try {
      writeGrants(grantsPath, ALL.map((g) => (g.id === "a2" ? { ...g, key: undefined } : g)));
      let done = false;
      const deadline = Date.now() + 2_000;
      while (!done && Date.now() < deadline) done = (await reader.read()).done;
      expect(done).toBe(true);
    } finally {
      writeGrants(grantsPath, ALL);
    }
  });
});
