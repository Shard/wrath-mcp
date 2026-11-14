/**
 * The hosted gateway against the stub module, with real confined children:
 *
 * - its tool list over HTTP, both eras, is the stdio server's for the same
 *   surface, byte for byte, and at fan-out 1 without a program it is the
 *   list the fan-out-1 golden holds the stdio server to;
 * - the protocol's framing, authentication and refusals;
 * - a call end to end, its lease in the ledger and its lines in the audit;
 * - one key never reaches another's character, account or session;
 * - the limits, the idle stop, a revoked grant, a restart and a restarted
 *   world.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostToolDefs, openHost } from "../src/host";
import { serveWorker } from "../src/hosted/worker";
import { localWorkers, type WorkerHandle, type WorkerProvider } from "../src/hosted/workers";

/** Workers served in this process, around a stand-in host opener: for a host that must misbehave. */
function inProcessWorkers(open: typeof openHost): WorkerProvider {
  return {
    async start({ secret, dir }) {
      const w = await serveWorker({ secret, openHost: open });
      let exit!: () => void;
      const exited = new Promise<void>((r) => (exit = r));
      return { host: w.host, port: w.port, paths: { state: join(dir, "state"), sessions: join(dir, "sessions") }, exited, stop: async () => (await w.stop(), exit()) };
    },
  };
}
import { Gateway, LeaseRefused, UNAUTHENTICATED, type GatewayOptions } from "../src/hosted/gateway";
import { HOSTED_FINGERPRINT_PREFIX, isHostedToken, newHostedToken } from "../src/hosted/tokens";
import { emptyGrantsFile, FileGrantSource, GrantSet, keyDigest, writeGrantsFile, type TenantGrant } from "../src/hosted/grants";
import { ERR_GATEWAY, ERR_HEADER_MISMATCH, ERR_METHOD_NOT_FOUND, ERR_UNSUPPORTED_VERSION, LEGACY_VERSIONS } from "../src/hosted/http";
import { McpServer } from "../src/server";
import { startStubModule, STUB_PORT_SECRET, type StubModule } from "./fixtures/stub-module";

const MODERN = "2026-07-28";
const KEY = { a: "wmk_key-of-a", b: "wmk_key-of-b" };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function grant(id: string, over: Partial<TenantGrant> = {}): TenantGrant {
  return { id, person: `p-${id}`, keyHashes: [{ id: `k${id}${id}${id}${id}`, sha256: keyDigest(KEY[id as "a" | "b"]) }], accounts: [`${id.toUpperCase()}1`], maxCharacters: 1, ...over };
}

interface Rig {
  stub: StubModule;
  gateway: Gateway;
  grants: FileGrantSource;
  grantsPath: string;
  state: string;
  url: string;
  clock: { now: number };
  modern(key: string | null, method: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<Response>;
  legacy(key: string | null, method: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<Response>;
  call(key: string, name: string, args: Record<string, unknown>): Promise<{ status: number; body: { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } } }>;
  audit(person: string): Record<string, unknown>[];
}

async function rig(o: { grants: TenantGrant[]; program?: boolean; health?: () => number | undefined; start?: (state: string, stub: StubModule) => void; openHost?: typeof openHost; workers?: WorkerProvider; sandboxLimits?: GatewayOptions["sandboxLimits"] } = { grants: [grant("a")] }): Promise<Rig> {
  const stub = startStubModule();
  const state = mkdtempSync(join(tmpdir(), "wm-gateway-"));
  const grantsPath = join(state, "..", `${state.split("/").pop()}-grants.json`);
  writeGrantsFile(grantsPath, { ...emptyGrantsFile(), grants: o.grants });
  const grants = new FileGrantSource(grantsPath, { pollMs: 0 });
  const clock = { now: Date.now() };
  o.start?.(state, stub);
  // The stub's /health has no start stamp; a test that restarts the world hands one.
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (o.health !== undefined && new URL(String(input)).pathname === "/health") return Response.json({ ok: true, startedAtMs: o.health() });
    return fetch(input, init);
  }) as typeof fetch;
  const gateway = new Gateway({
    grants,
    stateDir: state,
    moduleUrl: stub.baseUrl,
    env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET },
    fetch: f,
    program: o.program ?? false,
    sweepMs: 0,
    now: () => clock.now,
    log: () => {},
    snippetTimeoutMs: 5_000,
    workers: o.openHost !== undefined ? inProcessWorkers(o.openHost) : (o.workers ?? localWorkers({ trusted: true })),
    ...(o.sandboxLimits !== undefined ? { sandboxLimits: o.sandboxLimits } : {}),
  });
  await gateway.start();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, fetch: (req) => gateway.fetch(req, "127.0.0.1") });
  cleanups.push(async () => {
    await gateway.stop();
    grants.close();
    await server.stop(true);
    await stub.stop();
    rmSync(state, { recursive: true, force: true });
    rmSync(grantsPath, { force: true });
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  let id = 0;
  const post = (key: string | null, body: unknown, headers: Record<string, string>): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key !== null ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: JSON.stringify(body) });
  const modern = (key: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post(
      key,
      { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } },
      { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": String(params["name"]) } : {}), ...headers },
    );
  const legacy = (key: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post(key, { jsonrpc: "2.0", id: ++id, method, params }, headers);
  return {
    stub,
    gateway,
    grants,
    grantsPath,
    state,
    url,
    clock,
    modern,
    legacy,
    call: async (key, name, args) => {
      const res = await modern(key, "tools/call", { name, arguments: args });
      return { status: res.status, body: (await res.json()) as never };
    },
    audit: (person) => {
      const dir = join(state, "audit", person);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
    },
  };
}

const stdioTools = async (surface: { fanout: boolean; program: boolean }): Promise<unknown> => {
  const server = new McpServer({ list: () => hostToolDefs(surface), coerce: () => ({ ok: false, error: "" }), call: async () => ({ text: "" }), appendPending: async (r) => r });
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  return (JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!) as { result: { tools: unknown } }).result.tools;
};

describe("the tool list", () => {
  for (const program of [false, true]) {
    test(`at fan-out 1, ${program ? "with" : "without"} a program, is the stdio server's byte for byte, in both eras, and opens nothing`, async () => {
      const r = await rig({ grants: [grant("a")], program });
      const modern = (await (await r.modern(KEY.a, "tools/list")).json()) as { result: { tools: unknown; resultType: string } };
      const legacy = (await (await r.legacy(KEY.a, "tools/list", {}, { "mcp-protocol-version": "2025-06-18" })).json()) as { result: { tools: unknown } };
      const stdio = JSON.stringify(await stdioTools({ fanout: false, program }));
      expect(JSON.stringify(modern.result.tools)).toBe(stdio);
      expect(JSON.stringify(legacy.result.tools)).toBe(stdio);
      expect(modern.result.resultType).toBe("complete");
      // Listing tools takes no lease and starts no child.
      expect(r.stub.calls.filter((c) => c.path === "/lease")).toHaveLength(0);
    });
  }

  test("at fan-out 1 without a program is the list the fan-out-1 golden holds the stdio server to", async () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "fanout1-surface.json"), "utf8")) as { stdio: { request: { method: string }; response: { result?: { tools?: unknown } } }[] };
    const listed = golden.stdio.find((x) => x.request.method === "tools/list")!.response.result!.tools;
    const r = await rig({ grants: [grant("a")] });
    const body = (await (await r.modern(KEY.a, "tools/list")).json()) as { result: { tools: unknown } };
    expect(JSON.stringify(body.result.tools)).toBe(JSON.stringify(listed));
  });

  test("above fan-out 1 is the stdio fan-out list", async () => {
    const r = await rig({ grants: [grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 })] });
    const body = (await (await r.modern(KEY.a, "tools/list")).json()) as { result: { tools: unknown } };
    expect(JSON.stringify(body.result.tools)).toBe(JSON.stringify(await stdioTools({ fanout: true, program: false })));
  });
});

describe("the protocol", () => {
  test("refuses a missing or unknown key, a GET, and a foreign origin, and audits the failures", async () => {
    const r = await rig();
    const none = await r.modern(null, "tools/list");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await r.modern("wmk_nobody", "tools/list")).status).toBe(401);
    expect((await fetch(r.url)).status).toBe(405);
    expect((await fetch(r.url, { method: "DELETE" })).status).toBe(405);
    expect((await r.modern(KEY.a, "tools/list", {}, { origin: "https://evil.example" })).status).toBe(403);
    await r.gateway.audit.settled();
    expect(r.audit(UNAUTHENTICATED).map((l) => l["reason"] ?? l["why"])).toEqual(["no_key", "unknown_key", "origin"]);
  });

  test("modern: headers must match the body, the version must be served, the method known", async () => {
    const r = await rig();
    const bad = async (res: Response, status: number, code: number) => {
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(code);
    };
    await bad(await r.modern(KEY.a, "tools/list", {}, { "mcp-method": "tools/call" }), 400, ERR_HEADER_MISMATCH);
    await bad(await r.modern(KEY.a, "tools/call", { name: "run_snippet", arguments: { code: "1" } }, { "mcp-name": "state_summary" }), 400, ERR_HEADER_MISMATCH);
    await bad(await r.modern(KEY.a, "tools/list", {}, { "mcp-protocol-version": "2025-06-18" }), 400, ERR_HEADER_MISMATCH);
    await bad(await r.modern(KEY.a, "resources/list"), 404, ERR_METHOD_NOT_FOUND);
    const old = await fetch(r.url, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY.a}`, "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } }),
    });
    expect(old.status).toBe(400);
    const err = ((await old.json()) as { error: { code: number; data: { supported: string[] } } }).error;
    expect(err.code).toBe(ERR_UNSUPPORTED_VERSION);
    expect(err.data.supported).toEqual([MODERN, ...LEGACY_VERSIONS]);
    // A name carried in the Base64 sentinel is decoded before it is compared.
    const encoded = await r.modern(KEY.a, "tools/call", { name: "state_summary", arguments: {} }, { "mcp-name": `=?base64?${Buffer.from("state_summary").toString("base64")}?=` });
    expect(encoded.status).toBe(200);
    const discover = (await (await r.modern(KEY.a, "server/discover")).json()) as { result: { supportedVersions: string[]; capabilities: unknown; _meta: Record<string, { name: string }> } };
    expect(discover.result.supportedVersions[0]).toBe(MODERN);
    expect(discover.result.capabilities).toEqual({ tools: {} });
    expect(discover.result._meta["io.modelcontextprotocol/serverInfo"]!.name).toBe("wrath-mcp");
  });

  test("legacy: initialize negotiates without a session, and a notification is 202", async () => {
    const r = await rig();
    const init = await r.legacy(KEY.a, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const newer = await r.legacy(KEY.a, "initialize", { protocolVersion: "2099-01-01" });
    expect(((await newer.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(LEGACY_VERSIONS[0]!);
    const note = await fetch(r.url, { method: "POST", headers: { authorization: `Bearer ${KEY.a}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
  });
});

describe("a call", () => {
  test("opens the credential's host, leases through the ledger, audits it by person, and gives it back at stop", async () => {
    const r = await rig();
    const res = await r.call(KEY.a, "run_snippet", { code: "1 + 1" });
    expect(res.status).toBe(200);
    expect(res.body.result!.content[0]!.text).toContain("2");
    const seats = r.gateway.ledger.seats();
    expect(seats.map((s) => [s.credential, s.person, s.account])).toEqual([["a", "p-a", "A1"]]);
    expect(r.stub.calls.find((c) => c.path === "/lease" && c.method === "POST")?.body?.["allowGm"]).toBeUndefined();
    const kinds = r.audit("p-a").map((l) => l["kind"]);
    expect(kinds).toContain("lease");
    const call = r.audit("p-a").find((l) => l["kind"] === "call")!;
    expect(call).toMatchObject({ credential: "a", keyId: "kaaaa", tool: "run_snippet", outcome: "ok" });
    expect(typeof call["callId"]).toBe("number");
    expect(JSON.stringify(call)).not.toContain("1 + 1");
    // The record is the credential's own, and says whose.
    const sessions = join(r.state, "tenants", "a", "sessions");
    const [sid] = readdirSync(sessions);
    expect(JSON.parse(readFileSync(join(sessions, sid!, "session.json"), "utf8")).owner).toBe("p-a");
    await r.gateway.stop();
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect(r.stub.calls.some((c) => c.path === "/lease" && c.method === "DELETE")).toBe(true);
  }, 30_000);
});

describe("one key never reaches another's", () => {
  test("character: naming B's character from A is refused, at fan-out", async () => {
    const r = await rig({ grants: [grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 }), grant("b", { accounts: ["B1", "B2"], maxCharacters: 2 })] });
    expect((await r.call(KEY.a, "login_character", { name: "alfa", race: 1, class: 1 })).body.result!.content[0]!.text).toContain("logged in: Alfa");
    expect((await r.call(KEY.b, "login_character", { name: "bravo", race: 1, class: 1 })).body.result!.content[0]!.text).toContain("logged in: Bravo");
    const run = await r.call(KEY.a, "run_snippet", { code: "1", character: "Bravo" });
    expect(run.body.result).toEqual({ resultType: "complete", content: [{ type: "text", text: "unknown character: Bravo. Logged in: Alfa." }], isError: true } as never);
    const summary = await r.call(KEY.a, "state_summary", { character: "Bravo" });
    expect(summary.body.result!.isError).toBe(true);
    expect((await r.call(KEY.a, "run_snippet", { code: "Object.keys(chars)" })).body.result!.content[0]!.text).not.toContain("Bravo");
    expect(new Set(r.gateway.ledger.seats().map((s) => `${s.credential}:${s.account}`))).toEqual(new Set(["a:A1", "b:B1"]));
  }, 60_000);

  test("account and session: the leaser refuses an account not granted and a token another key holds", async () => {
    const r = await rig({ grants: [grant("a"), grant("b")] });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    const aToken = r.gateway.ledger.seats()[0]!.token;
    const b = { id: "b", person: "p-b", grant: grant("b"), limits: { requestsPerSecond: 5, burst: 20, inFlight: 4, loginsPerHour: 20, idleMinutes: 30 }, logins: [] as number[] };
    await expect(r.gateway.leaserFor(b).lease({ token: newHostedToken(), account: "A1" })).rejects.toBeInstanceOf(LeaseRefused);
    await expect(r.gateway.leaserFor(b).lease({ token: aToken, account: "B1" })).rejects.toThrow("another key");
    // Nor can B log out or release A's session.
    await r.gateway.leaserFor(b).release(aToken);
    await r.gateway.leaserFor(b).logout(aToken);
    expect(r.gateway.ledger.get(aToken)?.credential).toBe("a");
    // And GM is never sent, whatever is asked.
    await r.gateway.leaserFor(b).lease({ token: newHostedToken(), account: "B1", allowGm: true });
    expect(r.stub.calls.filter((c) => c.path === "/lease" && c.method === "POST").every((c) => c.body?.["allowGm"] === undefined)).toBe(true);
  }, 30_000);
});

describe("bounded audit and leases", () => {
  const LIMITS = { requestsPerSecond: 5, burst: 20, inFlight: 4, loginsPerHour: 20, idleMinutes: 30 };

  test("concurrent lease asks cannot all pass the caps: each is counted from before its await", async () => {
    const r = await rig({ grants: [grant("a", { accounts: ["A1", "A2", "A3"], maxCharacters: 2 }), grant("b")] });
    const a = { id: "a", person: "p-a", grant: grant("a", { accounts: ["A1", "A2", "A3"], maxCharacters: 2 }), limits: { ...LIMITS }, logins: [] as number[] };
    const asks = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => r.gateway.leaserFor(a).lease({ token: newHostedToken(), account: `A${(i % 3) + 1}` })));
    const granted = asks.filter((x) => x.status === "fulfilled" && x.value.secret !== undefined);
    expect(granted).toHaveLength(2);
    expect(asks.filter((x) => x.status === "rejected").every((x) => (x as PromiseRejectedResult).reason instanceof LeaseRefused)).toBe(true);
    expect(r.gateway.ledger.of("a")).toHaveLength(2);
    // Only the logins that happened count against the hour.
    expect(a.logins).toHaveLength(2);
    // The hourly limit holds the same way.
    const c = { id: "b", person: "p-b", grant: grant("b", { accounts: ["B1"], maxCharacters: 1 }), limits: { ...LIMITS, loginsPerHour: 1 }, logins: [] as number[] };
    const hour = await Promise.allSettled(Array.from({ length: 10 }, () => r.gateway.leaserFor(c).lease({ token: newHostedToken(), account: "B1" })));
    expect(hour.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  }, 30_000);

  test("a held seat being leased again counts once: a new character beside it is not refused", async () => {
    const r = await rig({ grants: [grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 })] });
    const a = { id: "a", person: "p-a", grant: grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 }), limits: { ...LIMITS }, logins: [] as number[] };
    const held = newHostedToken();
    expect((await r.gateway.leaserFor(a).lease({ token: held, account: "A1" })).secret).toBeDefined();
    const base = (r.gateway as unknown as { base: { lease: (o: { token: string }) => Promise<unknown> } }).base;
    const real = base.lease.bind(base);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    base.lease = async (o) => {
      if (o.token === held) await gate;
      return real(o);
    };
    const again = r.gateway.leaserFor(a).lease({ token: held, account: "A1" });
    const fresh = await r.gateway.leaserFor(a).lease({ token: newHostedToken(), account: "A2" });
    expect(fresh.secret).toBeDefined();
    release();
    expect((await again).secret).toBeDefined();
    expect(r.gateway.ledger.of("a")).toHaveLength(2);
  }, 30_000);

  test("a lease the module does not grant gives its reservation and its login back", async () => {
    const r = await rig({ grants: [grant("a")] });
    const a = { id: "a", person: "p-a", grant: grant("a"), limits: { ...LIMITS, loginsPerHour: 1 }, logins: [] as number[] };
    const base = (r.gateway as unknown as { base: { lease: (o: unknown) => Promise<unknown> } }).base;
    const real = base.lease;
    base.lease = async () => ({ note: "the module said no" });
    expect(await r.gateway.leaserFor(a).lease({ token: newHostedToken(), account: "A1" })).toEqual({ note: "the module said no" } as never);
    base.lease = async () => {
      throw new Error("module unreachable");
    };
    await expect(r.gateway.leaserFor(a).lease({ token: newHostedToken(), account: "A1" })).rejects.toThrow("unreachable");
    expect(a.logins).toHaveLength(0);
    // Neither held a place: the one login of the hour is still there to take.
    base.lease = real;
    expect((await r.gateway.leaserFor(a).lease({ token: newHostedToken(), account: "A1" })).secret).toBeDefined();
  }, 30_000);

  test("audit strings are cut: a huge tool name or character costs a bounded line", async () => {
    const r = await rig({ grants: [grant("a")] });
    // The legacy revision: the name rides the body alone, not a header.
    expect((await r.legacy(KEY.a, "tools/call", { name: "x".repeat(150_000), arguments: { character: "y".repeat(100_000), code: "1" } })).status).toBe(200);
    const line = r.audit("p-a").find((l) => l["kind"] === "call")!;
    expect(String(line["tool"]).length).toBeLessThan(400);
    expect(String(line["tool"])).toEndWith("…[cut, 150000 chars]");
    expect(String(line["character"])).toEndWith("…[cut, 100000 chars]");
    expect(line["argBytes"]).toBeGreaterThan(100_000);
    const dir = join(r.state, "audit", "p-a");
    const bytes = readdirSync(dir).reduce((n, f) => n + readFileSync(join(dir, f)).length, 0);
    expect(bytes).toBeLessThan(8_000);
  }, 30_000);

  test("unauthenticated refusals: one line per kind and address a window, the rest counted; a long Origin cut", async () => {
    const r = await rig();
    for (let i = 0; i < 50; i++) expect((await r.modern(null, "tools/list")).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await r.modern(KEY.a, "tools/list", {}, { origin: `https://${"e".repeat(8_000)}.example` })).status).toBe(403);
    await r.gateway.audit.settled();
    let lines = r.audit(UNAUTHENTICATED);
    expect(lines.map((l) => l["reason"] ?? l["why"])).toEqual(["no_key", "origin"]);
    expect(String(lines[1]!["origin"]).length).toBeLessThan(400);
    // The window passes: the next refusal writes the count of the last and starts another.
    r.clock.now += 61_000;
    await r.modern(null, "tools/list");
    r.gateway.refusals.flush(true);
    await r.gateway.audit.settled();
    lines = r.audit(UNAUTHENTICATED);
    const summaries = lines.filter((l) => l["kind"] === "refused-summary");
    expect(summaries.map((l) => [l["reason"] ?? l["why"], l["more"]])).toEqual([
      ["no_key", 49],
      ["origin", 4],
    ]);
    expect(lines.filter((l) => l["kind"] === "auth")).toHaveLength(2);
  });

  test("the session record keeps a call's arguments, cut past what a real call carries", async () => {
    const { clipStrings } = await import("../src/clip");
    const { CALL_ARG_LIMITS, CALL_TOOL_MAX } = await import("../src/record/writer");
    const file = "f".repeat(32_000);
    expect(clipStrings({ path: "main.ts", content: file }, CALL_ARG_LIMITS)).toEqual({ path: "main.ts", content: file });
    const cut = clipStrings({ code: "c".repeat(40_000), more: ["d".repeat(40_000), "e".repeat(40_000)] }, CALL_ARG_LIMITS) as { code: string; more: string[] };
    expect(cut.code).toEndWith("…[cut, 40000 chars]");
    expect(cut.code.length).toBeLessThan(32_800);
    expect(cut.more[0]).toEndWith("…[cut, 40000 chars]");
    // The budget runs out across strings.
    expect(cut.more[1]!.startsWith("e".repeat(32_768))).toBe(true);
    expect(clipStrings({ a: "x".repeat(70_000), b: "y".repeat(70_000), c: "z".repeat(70_000), d: "w" }, CALL_ARG_LIMITS)).toMatchObject({ d: "…[cut, 1 chars]" });
    expect(CALL_TOOL_MAX).toBe(128);
  });
});

describe("limits", () => {
  test("a request burst past the bucket is 429 with Retry-After", async () => {
    const r = await rig({ grants: [grant("a", { limits: { burst: 2, requestsPerSecond: 1 } })] });
    expect((await r.modern(KEY.a, "tools/list")).status).toBe(200);
    expect((await r.modern(KEY.a, "tools/list")).status).toBe(200);
    const third = await r.modern(KEY.a, "tools/list");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("1");
    r.clock.now += 1_000;
    expect((await r.modern(KEY.a, "tools/list")).status).toBe(200);
  });

  test("calls past the in-flight cap are refused while one runs", async () => {
    const r = await rig({ grants: [grant("a", { limits: { inFlight: 1 } })] });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    const slow = r.call(KEY.a, "run_snippet", { code: "await sleep(400); 1" });
    await Bun.sleep(50);
    const refused = await r.call(KEY.a, "state_summary", {});
    expect(refused.status).toBe(429);
    expect(refused.body.error!.code).toBe(ERR_GATEWAY);
    expect((await slow).status).toBe(200);
  }, 30_000);

  test("logins past the hourly limit are refused", async () => {
    const r = await rig({ grants: [grant("a", { accounts: ["A1", "A2"], maxCharacters: 2, limits: { loginsPerHour: 1 } })] });
    expect((await r.call(KEY.a, "login_character", { name: "alfa", race: 1, class: 1 })).body.result!.isError).toBe(false);
    const second = await r.call(KEY.a, "login_character", { name: "bravo", race: 1, class: 1 });
    expect(second.body.result!.isError).toBe(true);
    expect(second.body.result!.content[0]!.text).toContain("1 logins in the last hour");
  }, 30_000);
});

describe("stops", () => {
  test("idle: no request for the grant's minutes stops the host and gives the lease back", async () => {
    const r = await rig({ grants: [grant("a", { limits: { idleMinutes: 5 } })] });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    r.clock.now += 4 * 60_000;
    await r.gateway.sweep();
    expect(r.gateway.ledger.seats()).toHaveLength(1);
    r.clock.now += 2 * 60_000;
    await r.gateway.sweep();
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect(r.audit("p-a").some((l) => l["kind"] === "host" && l["why"] === "idle")).toBe(true);
    // The next call opens it again.
    expect((await r.call(KEY.a, "run_snippet", { code: "2 + 2" })).body.result!.content[0]!.text).toContain("4");
  }, 30_000);

  test("a disabled grant: its host stops and its key is refused", async () => {
    const r = await rig({ grants: [grant("a")] });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    writeGrantsFile(r.grantsPath, { ...emptyGrantsFile(), grants: [grant("a", { disabled: true })] });
    r.grants.reload();
    await r.gateway.sweep();
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect((await r.modern(KEY.a, "tools/list")).status).toBe(401);
    await r.gateway.audit.settled();
    expect(r.audit("p-a").some((l) => l["kind"] === "auth" && l["reason"] === "disabled")).toBe(true);
  }, 30_000);

  test("a restart releases every seat the last process held", async () => {
    let held = "";
    const r = await rig({
      grants: [grant("a")],
      start: (state, stub) => {
        // A seat left by a process that did not stop cleanly, its lease still on the module.
        held = "h".repeat(32);
        void stub;
        writeFileSync(join(state, "ledger.json"), JSON.stringify({ seats: [{ credential: "a", person: "p-a", account: "A1", token: held, fingerprint: "f", leasedAt: 1 }] }));
      },
    });
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect(r.stub.calls.some((c) => c.path === "/lease" && c.method === "DELETE" && c.body?.["token"] === held)).toBe(true);
    expect(r.audit("p-a").some((l) => l["kind"] === "release" && l["why"] === "gateway restart")).toBe(true);
  });

  test("a restarted world: every host stops, and the next call opens a new one", async () => {
    let started = 1_000;
    const r = await rig({ grants: [grant("a")], health: () => started });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    await r.gateway.sweep();
    expect(r.gateway.ledger.seats()).toHaveLength(1);
    started = 2_000;
    await r.gateway.sweep();
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect(r.audit("p-a").some((l) => l["kind"] === "host" && l["why"] === "world restarted")).toBe(true);
    expect((await r.call(KEY.a, "run_snippet", { code: "3" })).status).toBe(200);
    expect(r.gateway.ledger.seats()).toHaveLength(1);
  }, 30_000);
});

describe("after a crash", () => {
  test("a character the roster still marks in comes back at the next call, on a fresh lease", async () => {
    const token = newHostedToken();
    const r = await rig({
      grants: [grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 })],
      start: (state) => {
        // What a process that died left: the roster says Alfa is in, the ledger holds its lease.
        const dir = join(state, "tenants", "a", "state");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "roster.json"), JSON.stringify([{ character: "Alfa", account: "A1", token, in: true }]));
        writeFileSync(join(state, "ledger.json"), JSON.stringify({ seats: [{ credential: "a", person: "p-a", account: "A1", token, fingerprint: "f", leasedAt: 1 }] }));
      },
    });
    const list = await r.call(KEY.a, "list_characters", {});
    expect(list.status).toBe(200);
    expect(list.body.result!.content[0]!.text).toContain("Alfa");
    const summary = await r.call(KEY.a, "state_summary", { character: "Alfa" });
    expect(summary.body.result!.isError).toBe(false);
    expect(r.gateway.ledger.seats().map((s) => s.account)).toEqual(["A1"]);
  }, 30_000);
});

describe("the entry", () => {
  test("parses its flags and refuses what it does not know", async () => {
    const { parseGatewayArgs } = await import("../src/hosted/gateway-main");
    const a = parseGatewayArgs(["--grants", "g.json", "--state", "s", "--port", "9000", "--no-program", "--allowed-origin", "https://a.example", "--trust-forwarded-for"], {});
    expect(a).toMatchObject({ host: "127.0.0.1", port: 9000, program: false, allowedOrigins: ["https://a.example"], trustForwardedFor: true });
    expect(a.grants.endsWith("g.json")).toBe(true);
    expect(() => parseGatewayArgs(["--state", "s"], {})).toThrow("usage");
    expect(parseGatewayArgs(["--state", "s"], { WRATH_MCP_GRANTS_FILE: "/x/g.json" }).grants).toBe("/x/g.json");
    expect(() => parseGatewayArgs(["--grants", "g", "--state", "s", "--allow-gm"], {})).toThrow("unknown argument --allow-gm");
  });

  test("local workers only when told the grants are trusted; sandbox limits from flags", async () => {
    const { parseGatewayArgs } = await import("../src/hosted/gateway-main");
    expect(parseGatewayArgs(["--grants", "g", "--state", "s"], {})).toMatchObject({ trustedLocalWorkers: false });
    expect(parseGatewayArgs(["--grants", "g", "--state", "s"], {}).sandboxLimits).toBeUndefined();
    const a = parseGatewayArgs(["--grants", "g", "--state", "s", "--trusted-local-workers", "--limit-as", "8589934592", "--limit-cpu=3600", "--limit-fsize", "unlimited"], {});
    expect(a.trustedLocalWorkers).toBe(true);
    expect(a.sandboxLimits).toEqual({ addressSpaceBytes: 8589934592, cpuSeconds: 3600, fileBytes: null });
    expect(() => parseGatewayArgs(["--grants", "g", "--state", "s", "--limit-cpu", "0"], {})).toThrow("--limit-cpu must be");
  });

  test("localWorkers refuses to start a worker unless trusted", async () => {
    const { LocalWorkersRefused } = await import("../src/hosted/workers");
    const dir = mkdtempSync(join(tmpdir(), "wm-local-"));
    try {
      await expect(localWorkers().start({ credential: "a", secret: "s", dir })).rejects.toThrow(LocalWorkersRefused);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hardening", () => {
  test("the gateway's sandbox limits reach every credential's child", async () => {
    const seen: unknown[] = [];
    const r = await rig({
      grants: [grant("a")],
      sandboxLimits: { cpuSeconds: 3600, fileBytes: null },
      openHost: async (h) => {
        seen.push(h.sandboxLimits);
        return openHost(h);
      },
    });
    const res = await r.call(KEY.a, "run_snippet", { code: 'return (await Bun.file("/proc/self/limits").text()).split("\\n").find((l) => l.startsWith("Max cpu time"))' });
    expect(seen).toEqual([{ cpuSeconds: 3600, fileBytes: null }]);
    expect(res.body.result!.content[0]!.text).toMatch(/Max cpu time\s+3600\s+3600/);
  }, 30_000);

  test("a host that leased and then failed to open gives the lease back, so the next call is not locked out", async () => {
    let fail = true;
    const r = await rig({
      grants: [grant("a")],
      openHost: async (h) => {
        if (fail) {
          fail = false;
          await h.leaser!.lease({ token: newHostedToken(), account: "A1" });
          throw new Error("disk full");
        }
        return openHost(h);
      },
    });
    const first = await r.call(KEY.a, "run_snippet", { code: "1" });
    expect(first.body.result!.isError).toBe(true);
    // The person is told a reference, never the detail; the operator's audit has both.
    const text = first.body.result!.content[0]!.text;
    expect(text).toMatch(/could not be opened: the server could not start it \(ref [0-9a-f]{8}\)/);
    expect(text).not.toContain("disk full");
    const ref = /ref ([0-9a-f]{8})/.exec(text)![1];
    expect(r.audit("p-a").some((l) => l["kind"] === "call" && l["ref"] === ref && String(l["error"]).includes("disk full"))).toBe(true);
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect((await r.call(KEY.a, "run_snippet", { code: "5" })).body.result!.content[0]!.text).toContain("5");
  }, 30_000);

  test("revoking a grant's last key stops what it left running", async () => {
    const r = await rig({ grants: [grant("a")] });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    writeGrantsFile(r.grantsPath, { ...emptyGrantsFile(), grants: [grant("a", { keyHashes: [] })] });
    r.grants.reload();
    await r.gateway.sweep();
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect(r.audit("p-a").some((l) => l["kind"] === "host" && l["why"] === "every key revoked")).toBe(true);
  }, 30_000);

  test("a call is audited with the address it came from", async () => {
    const r = await rig({ grants: [grant("a")] });
    await r.call(KEY.a, "state_summary", {});
    expect(r.audit("p-a").find((l) => l["kind"] === "call")?.["remote"]).toBe("127.0.0.1");
  }, 30_000);

  test("the gateway does not start without the port secret", () => {
    const state = mkdtempSync(join(tmpdir(), "wm-gateway-nosecret-"));
    cleanups.push(() => rmSync(state, { recursive: true, force: true }));
    const grants = { current: () => new GrantSet(emptyGrantsFile()), close: () => {} };
    expect(() => new Gateway({ grants, stateDir: state, moduleUrl: "http://module.invalid", env: {}, workers: localWorkers({ trusted: true }) })).toThrow("WRATHBENCH_MODULE_SECRET is not set");
  });
});

describe("workers", () => {
  test("each credential's host runs in a worker process of its own, which never holds the port secret", async () => {
    const handles: WorkerHandle[] = [];
    const local = localWorkers({ trusted: true });
    const r = await rig({ grants: [grant("a"), grant("b")], workers: { start: async (x) => { const h = await local.start(x); handles.push(h); return h; } } });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    await r.call(KEY.b, "run_snippet", { code: "1" });
    expect(handles).toHaveLength(2);
    expect(new Set(handles.map((h) => h.pid)).size).toBe(2);
    expect(handles.every((h) => h.pid !== process.pid)).toBe(true);
    for (const h of handles) expect(readFileSync(`/proc/${h.pid}/environ`, "utf8")).not.toContain("WRATHBENCH_MODULE_SECRET");
  }, 60_000);

  test("a worker that dies: its seats are released, and the next call starts another", async () => {
    const handles: WorkerHandle[] = [];
    const local = localWorkers({ trusted: true });
    const r = await rig({ grants: [grant("a")], workers: { start: async (x) => { const h = await local.start(x); handles.push(h); return h; } } });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    expect(r.gateway.ledger.seats()).toHaveLength(1);
    process.kill(handles[0]!.pid!, "SIGKILL");
    const until = Date.now() + 5_000;
    while (r.gateway.ledger.seats().length > 0 && Date.now() < until) await Bun.sleep(20);
    expect(r.gateway.ledger.seats()).toHaveLength(0);
    expect(r.audit("p-a").some((l) => l["kind"] === "host" && l["event"] === "lost")).toBe(true);
    expect((await r.call(KEY.a, "run_snippet", { code: "6" })).body.result!.content[0]!.text).toContain("6");
    expect(handles).toHaveLength(2);
  }, 60_000);

  test("a worker asking for an account its credential was not granted is refused", async () => {
    const r = await rig({
      grants: [grant("a"), grant("b")],
      openHost: async (h) => {
        await h.leaser!.lease({ token: newHostedToken(), account: "B1" });
        return openHost(h);
      },
    });
    const res = await r.call(KEY.a, "run_snippet", { code: "1" });
    expect(res.body.result!.isError).toBe(true);
    expect(res.body.result!.content[0]!.text).toContain("not one this key was granted");
    expect(r.gateway.ledger.seats()).toHaveLength(0);
  }, 30_000);
});

describe("retention", () => {
  test("every token a hosted session runs under carries the hosted fingerprint, and the leaser refuses any other", async () => {
    expect(isHostedToken(newHostedToken())).toBe(true);
    const r = await rig({ grants: [grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 }), grant("b")] });
    await r.call(KEY.a, "login_character", { name: "alfa", race: 1, class: 1 });
    await r.call(KEY.b, "run_snippet", { code: "1" });
    const seats = r.gateway.ledger.seats();
    expect(seats).toHaveLength(2);
    for (const s of seats) expect(s.fingerprint.startsWith(HOSTED_FINGERPRINT_PREFIX)).toBe(true);
    const a = { id: "a", person: "p-a", grant: grant("a", { accounts: ["A1", "A2"], maxCharacters: 2 }), limits: { requestsPerSecond: 5, burst: 20, inFlight: 4, loginsPerHour: 20, idleMinutes: 30 }, logins: [] as number[] };
    await expect(r.gateway.leaserFor(a).lease({ token: "f".repeat(32), account: "A2" })).rejects.toThrow("not one the gateway issues");
  }, 60_000);

  test("session records past retention go on a schedule; a gone grant's directory goes after the audit's retention, a live one's never", async () => {
    const r = await rig({ grants: [grant("a"), grant("b")] });
    await r.call(KEY.a, "run_snippet", { code: "1" });
    await r.call(KEY.b, "run_snippet", { code: "1" });
    await r.gateway.stop();
    const sessions = join(r.state, "tenants", "a", "sessions");
    expect(readdirSync(sessions)).toHaveLength(1);
    // B's grant is removed; A's stays.
    writeGrantsFile(r.grantsPath, { ...emptyGrantsFile(), grants: [grant("a")] });
    r.grants.reload();
    // Four days on: A's closed record is past the three-day retention, B's directory not yet past thirty.
    r.clock.now += 4 * 86_400_000;
    expect(r.gateway.pruneTenants()).toEqual({ sessions: 2, credentials: [] });
    expect(readdirSync(sessions)).toHaveLength(0);
    expect(existsSync(join(r.state, "tenants", "b"))).toBe(true);
    // Thirty-one days on: B's directory goes; A's stays, its grant live.
    r.clock.now += 27 * 86_400_000;
    expect(r.gateway.pruneTenants().credentials).toEqual(["b"]);
    expect(existsSync(join(r.state, "tenants", "b"))).toBe(false);
    expect(existsSync(join(r.state, "tenants", "a", "state"))).toBe(true);
    expect(r.audit("p-b").some((l) => l["kind"] === "pruned")).toBe(false);
    expect(r.audit(UNAUTHENTICATED).some((l) => l["kind"] === "pruned" && l["credential"] === "b")).toBe(true);
  }, 60_000);
});
