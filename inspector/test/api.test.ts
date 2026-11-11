/**
 * The API over a store, through the bin's own handler: every route, the
 * scope on per-session paths, the refusals, and a tail that follows a stream
 * as it grows.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInspectorApi, inspectorHandler, storeSource, type SessionScope } from "../src/index";
import { decodeSegment } from "../src/codec/trace";
import { decodeNearby as decodeNearbyCodec } from "../src/codec/nearby";
import type { NearbyWindow, TraceSegment } from "../src/wire";
import { CLOSED_ID, FIXTURE_T0, LIVE_ID, plantStore, tempDir } from "./fixtures";

const tmp = tempDir();
const root = plantStore(join(tmp, "store"));
const NOW = FIXTURE_T0 + 3_600_000;
const api = createInspectorApi(storeSource(root), { base: "/api", now: () => NOW });

async function get(path: string, init?: RequestInit): Promise<Response> {
  const res = await api(new Request(`http://127.0.0.1${path}`, init));
  if (res === null) throw new Error(`not the API's path: ${path}`);
  return res;
}

describe("routes", () => {
  test("paths outside the base are not the API's", async () => {
    expect(await api(new Request("http://127.0.0.1/"))).toBeNull();
    expect(await api(new Request("http://127.0.0.1/api/runs"))).toBeNull();
    expect(await api(new Request("http://127.0.0.1/apis/sessions"))).toBeNull();
  });

  test("the listing and one session", async () => {
    const list = (await (await get("/api/sessions")).json()) as { sessions: { id: string }[] };
    expect(list.sessions.map((s) => s.id)).toEqual([LIVE_ID, CLOSED_ID]);
    const one = (await (await get(`/api/sessions/${CLOSED_ID}`)).json()) as { id: string; session: { character: { name: string } }; live: unknown };
    expect(one.session.character.name).toBe("Quillon");
    expect(one.live).toBeNull();
  });

  test("a stream's rows over a range, filtered by kind", async () => {
    const res = await get(`/api/sessions/${CLOSED_ID}/rows/events?from=${FIXTURE_T0}&to=${FIXTURE_T0 + 600_000}&kinds=death,level`);
    const body = (await res.json()) as { rows: { kind: string; ts: number }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((r) => r.kind === "death" || r.kind === "level")).toBe(true);
    expect((await get(`/api/sessions/${CLOSED_ID}/rows/events?from=10&to=5`)).status).toBe(400);
    expect((await get(`/api/sessions/${CLOSED_ID}/rows/events?from=0&to=${FIXTURE_T0}`)).status).toBe(400);
    expect((await get(`/api/sessions/${CLOSED_ID}/rows/secrets`)).status).toBe(404);
  });

  test("the packed trace: an index, a closed window cached for good, and the recent trace", async () => {
    const index = (await (await get(`/api/sessions/${CLOSED_ID}/trace`)).json()) as { segs: [number, number][] };
    expect(index.segs).toEqual([[FIXTURE_T0, 2]]);
    const seg = await get(`/api/sessions/${CLOSED_ID}/trace/${FIXTURE_T0}`);
    expect(seg.headers.get("cache-control")).toContain("immutable");
    const decoded = decodeSegment((await seg.json()) as TraceSegment);
    expect(decoded.run).toBe(CLOSED_ID);
    expect(decoded.frames.length).toBeGreaterThan(0);
    expect((await get(`/api/sessions/${CLOSED_ID}/trace/${FIXTURE_T0 + 1}`)).status).toBe(404);
    expect((await get(`/api/sessions/${CLOSED_ID}/trace/${FIXTURE_T0 - 300_000}`)).status).toBe(404);
    expect(await (await get(`/api/sessions/${CLOSED_ID}/recent`)).json()).toBeNull();
  });

  test("the ring as one window, and the movement intentions", async () => {
    const live = createInspectorApi(storeSource(root), { now: () => FIXTURE_T0 + 340_000 });
    const res = (await live(new Request(`http://x/sessions/${LIVE_ID}/nearby?span=60000`)))!;
    const w = decodeNearbyCodec((await res.json()) as NearbyWindow);
    expect(w.units.length).toBeGreaterThan(0);
    const moves = (await (await get(`/api/sessions/${CLOSED_ID}/moves`)).json()) as { status: string | null }[];
    expect(moves.map((m) => m.status)).toEqual([null, "arrived"]);
  });

  test("read-only, and an unknown session is a 404", async () => {
    expect((await get("/api/sessions", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await get("/api/sessions/0123456789abcdef")).status).toBe(404);
    expect((await get(`/api/sessions/${CLOSED_ID}/nope`)).status).toBe(404);
  });
});

describe("scope", () => {
  const as = (scope: SessionScope | null) => createInspectorApi(storeSource(root), { scope: () => scope });

  test("no scope is a 401 on every path", async () => {
    const res = (await as(null)(new Request("http://x/sessions")))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect((await as(null)(new Request(`http://x/sessions/${CLOSED_ID}/trace`)))!.status).toBe(401);
  });

  test("a session out of scope is not there, on the listing and on every per-session path", async () => {
    const bob = as({ kind: "user", owner: "bob" });
    expect(((await (await bob(new Request("http://x/sessions")))!.json()) as { sessions: unknown[] }).sessions).toEqual([]);
    for (const rest of ["", "/trace", `/trace/${FIXTURE_T0}`, "/rows/calls", "/tail/calls", "/nearby", "/moves", "/recent"]) {
      expect((await bob(new Request(`http://x/sessions/${CLOSED_ID}${rest}`)))!.status).toBe(404);
    }
    const alice = as({ kind: "user", owner: "alice" });
    expect((await alice(new Request(`http://x/sessions/${CLOSED_ID}/trace`)))!.status).toBe(200);
  });
});

describe("tail", () => {
  test("frames follow the stream, each with its cursor; a reconnect resumes from Last-Event-ID", async () => {
    const tailApi = createInspectorApi(storeSource(root), { tailPollMs: 20 });
    const ac = new AbortController();
    const res = (await tailApi(new Request(`http://x/sessions/${LIVE_ID}/tail/events`, { signal: ac.signal })))!;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        text += dec.decode(value);
      }
    };
    await until('"hello"');
    appendFileSync(join(root, LIVE_ID, "events", `${FIXTURE_T0 + 300_000}.jsonl`), `${JSON.stringify({ ts: FIXTURE_T0 + 345_000, kind: "trade" })}\n`);
    await until('"trade"');
    const ids = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]!);
    expect(ids.length).toBe(2);
    await reader.cancel();
    ac.abort();

    // From the last id: nothing it already had.
    const again = (await tailApi(new Request(`http://x/sessions/${LIVE_ID}/tail/events`, { headers: { "last-event-id": ids[1]! } })))!;
    const r2 = again.body!.getReader();
    const first = dec.decode((await r2.read()).value);
    expect(first).toContain('"hello"');
    await r2.cancel();
  });
});

describe("the bin's handler", () => {
  test("off loopback it wants the secret, as a bearer header or the sign-in's cookie", async () => {
    const secret = "an-inspector-secret-of-length";
    const h = inspectorHandler({ source: storeSource(root), host: "0.0.0.0", secret });
    expect((await h(new Request("http://x/api/sessions"))).status).toBe(401);
    expect((await h(new Request("http://x/api/sessions", { headers: { authorization: `Bearer ${secret}` } }))).status).toBe(200);
    expect((await h(new Request("http://x/api/sessions", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const refused = await h(new Request("http://x/api/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "wrong" }) }));
    expect(refused.status).toBe(401);
    expect((await h(new Request("http://x/api/sign-in", { method: "POST", body: JSON.stringify({ secret }) }))).status).toBe(415);
    const ok = await h(new Request("http://x/api/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) }));
    expect(ok.status).toBe(204);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await h(new Request("http://x/api/sessions", { headers: { cookie } }))).status).toBe(200);
  });

  test("an unbuilt page says so, and the API still answers", async () => {
    const h = inspectorHandler({ source: storeSource(root), pageDir: join(tmp, "no-page") });
    expect((await h(new Request("http://x/"))).status).toBe(503);
    expect((await h(new Request("http://x/api/sessions"))).status).toBe(200);
    expect((await h(new Request("http://x/api/nothing"))).status).toBe(404);
  });
});
