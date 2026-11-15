/**
 * The host `main.ts` serves over stdio and a hosted gateway opens per
 * credential: one tool list per surface, built in one place. Without a
 * program it is what `main.ts` served before the host was its own module
 * (the fan-out-1 golden builds that list itself, and this holds the host's to
 * it); with one, the program's tools in place of the core `run_snippet`.
 * And the single-character host's clean exit, which `main.ts` runs on stdin
 * closing or a signal: no module and no child, a stub fetch or leaser in
 * their place.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FANOUT_TOOL_ORDER, fanoutTools, PLAIN_FANOUT_RENDER, type FanoutToolContext } from "../src/fanout";
import { hostToolDefs, hostToolSpecs, openHost, PLAIN_RENDER, type OpenedHost } from "../src/host";
import { coreTools, programTools, ToolSet, type CoreToolRender, type ProgramToolContext } from "../src/tools";
import { startStubModule, STUB_PORT_SECRET, type StubModule } from "./fixtures/stub-module";
import { portSecretLeaser, type Leaser } from "../src/module-auth";

const shape = (specs: readonly { def: unknown; help?: string; aliases?: unknown }[]) => specs.map((s) => ({ def: s.def, help: s.help, aliases: s.aliases ?? null }));

describe("the host's tool list", () => {
  test("without a program or fan-out is the core five, as main.ts served them", () => {
    const core = coreTools(PLAIN_RENDER);
    expect(shape(hostToolSpecs({ fanout: false, program: false }))).toEqual(shape([core.run_snippet, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]));
  });

  test("at fan-out without a program is the fan-out list, in its order", () => {
    const fan = fanoutTools<FanoutToolContext>(PLAIN_RENDER as CoreToolRender<FanoutToolContext>);
    expect(shape(hostToolSpecs({ fanout: true, program: false }))).toEqual(shape(FANOUT_TOOL_ORDER.map((n) => fan[n])));
  });

  test("with a program: the program's run_snippet, its file and routine tools, then the other four", () => {
    const prog = programTools(PLAIN_RENDER as CoreToolRender<ProgramToolContext>);
    const core = coreTools(PLAIN_RENDER);
    expect(hostToolDefs({ fanout: false, program: true }).map((d) => d.name)).toEqual(["run_snippet", "read_file", "write_file", "edit_file", "delete_file", "start_routine", "stop_routine", "recent_events", "state_summary", "write_scratchpad", "edit_scratchpad"]);
    expect(shape(hostToolSpecs({ fanout: false, program: true }))).toEqual(
      shape([prog.run_snippet, prog.read_file, prog.write_file, prog.edit_file, prog.delete_file, prog.start_routine, prog.stop_routine, core.recent_events, core.state_summary, core.write_scratchpad, core.edit_scratchpad]),
    );
  });

  test("a program at fan-out: character on the snippet, the routines and the summaries, and the three login tools last", () => {
    const defs = hostToolDefs({ fanout: true, program: true });
    expect(defs.map((d) => d.name)).toEqual(["run_snippet", "read_file", "write_file", "edit_file", "delete_file", "start_routine", "stop_routine", "recent_events", "state_summary", "write_scratchpad", "edit_scratchpad", "login_character", "logout_character", "list_characters"]);
    for (const name of ["run_snippet", "start_routine", "stop_routine", "recent_events", "state_summary"]) {
      const props = defs.find((d) => d.name === name)!.inputSchema["properties"] as Record<string, unknown>;
      expect(Object.keys(props)).toContain("character");
    }
    const fan = fanoutTools<FanoutToolContext & ProgramToolContext>(PLAIN_RENDER as CoreToolRender<FanoutToolContext & ProgramToolContext>, PLAIN_FANOUT_RENDER, { program: true });
    expect(defs[0]).toEqual(fan.run_snippet.def);
  });

  test("is fixed for the surface: the same list twice", () => {
    expect(new ToolSet(hostToolSpecs({ fanout: true, program: true })).defs).toEqual(hostToolDefs({ fanout: true, program: true }));
  });
});

describe("a host with a program", () => {
  const dirs: string[] = [];
  const stubs: StubModule[] = [];
  const hosts: OpenedHost[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.shutdown({ logout: true })));
    await Promise.all(stubs.splice(0).map((s) => s.stop()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("keeps its workspace in the state directory and serves its files", async () => {
    const stub = startStubModule();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-host-"));
    dirs.push(dir);
    const env = { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET };
    const host = await openHost({
      moduleUrl: stub.baseUrl,
      dir,
      token: "host-test-token-0123456789abcdef0123",
      account: "ACCA",
      grant: null,
      program: true,
      record: { root: join(dir, "sessions"), retentionMs: 3_600_000 },
      owner: "pat",
      leaser: portSecretLeaser({ moduleUrl: stub.baseUrl, env }),
      log: () => {},
      logSink: () => {},
    });
    hosts.push(host);
    expect(host.tools.list().map((d) => d.name)).toContain("write_file");
    const wrote = await host.tools.call("write_file", { path: "lib/a.ts", content: "export const a = 1;\n" }, { dispatchTs: Date.now() });
    expect(wrote.isError ?? false).toBe(false);
    expect((await host.tools.call("read_file", { path: "lib/a.ts" }, { dispatchTs: Date.now() + 1 })).text).toBe("export const a = 1;\n");
    expect(host.recordedIn).toStartWith(join(dir, "sessions"));
    // The owner the host was told is on its record.
    expect(JSON.parse(readFileSync(join(host.recordedIn!, "session.json"), "utf8")).owner).toBe("pat");
  });
});

describe("the single-character host's shutdown", () => {
  const env = { WRATHBENCH_MODULE_SECRET: "p".repeat(32) };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A single-character host with no program, leasing through `leaser`, recorded when `recorded`; the module's identity is handed, so nothing asks `/health`. */
  async function single(leaser: Leaser, recorded = false): Promise<{ host: OpenedHost; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-host-"));
    dirs.push(dir);
    const host = await openHost({
      moduleUrl: "http://module:8086",
      dir,
      token: "tok-abc",
      account: "ACCA",
      grant: null,
      program: false,
      record: recorded ? { root: join(dir, "sessions"), retentionMs: 3_600_000 } : null,
      module: null,
      leaser,
      log: () => {},
      logSink: () => {},
    });
    return { host, dir };
  }

  /** What reaches the module, and a fetch that answers a lease and, once `gone`, throws on everything after. */
  function module(): { calls: { call: string; auth: string | null; body: unknown }[]; gone: boolean; fetch: typeof fetch } {
    const m = {
      calls: [] as { call: string; auth: string | null; body: unknown }[],
      gone: false,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        m.calls.push({ call: `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
        if (m.gone) throw new Error("connection refused");
        return new Response(JSON.stringify({ ok: true, secret: "leased-secret-0123456789abcdef", account: "ACCA" }), { status: 200 });
      }) as typeof fetch,
    };
    return m;
  }

  test("stops the sandbox, then logs out and releases the lease with the port secret, once however often it is asked", async () => {
    const m = module();
    const { host } = await single(portSecretLeaser({ moduleUrl: "http://module:8086", env, fetch: m.fetch }));
    const order = m.calls;
    spyOn(host.sandbox, "stop").mockImplementation(async () => void order.push({ call: "stop", auth: null, body: null }));
    await Promise.all([host.shutdown(), host.shutdown()]);
    await host.shutdown();
    expect(order.map((c) => c.call)).toEqual(["POST /lease", "stop", "DELETE /session", "DELETE /lease"]);
    for (const c of order.slice(2)) {
      expect(c.auth).toBe(`Bearer ${env.WRATHBENCH_MODULE_SECRET}`);
      expect(c.body).toEqual({ token: "tok-abc" });
    }
  });

  test("a sandbox that fails to stop and a module that is gone still finish", async () => {
    const m = module();
    const { host } = await single(portSecretLeaser({ moduleUrl: "http://module:8086", env, fetch: m.fetch }));
    spyOn(host.sandbox, "stop").mockImplementation(async () => Promise.reject(new Error("wedged")));
    m.gone = true;
    await host.shutdown();
    expect(m.calls.map((c) => c.call)).toEqual(["POST /lease", "DELETE /session", "DELETE /lease"]);
  });

  test("closes the record after the sandbox has stopped and before the character is logged out", async () => {
    const seen: string[] = [];
    let record = (): string => "";
    const leaser: Leaser = { ...recordingLeaser(seen), logout: async (token) => void seen.push(`logout ${token}, record ${record()}`) };
    const { host } = await single(leaser, true);
    const sessionJson = join(host.recordedIn!, "session.json");
    record = () => (JSON.parse(readFileSync(sessionJson, "utf8")).ended !== null ? "ended" : "open");
    const stop = host.sandbox.stop.bind(host.sandbox);
    spyOn(host.sandbox, "stop").mockImplementation(async () => {
      seen.push(`stop, record ${record()}`);
      await stop();
    });
    await host.shutdown();
    expect(seen).toEqual(["lease tok-abc", "stop, record open", "logout tok-abc, record ended", "release tok-abc"]);
  });

  test("without logout stops the sandbox and closes the record, and leaves the character and its lease", async () => {
    const seen: string[] = [];
    const { host } = await single(recordingLeaser(seen), true);
    spyOn(host.sandbox, "stop").mockImplementation(async () => void seen.push("stop"));
    await host.shutdown({ logout: false });
    expect(seen).toEqual(["lease tok-abc", "stop"]);
    expect(JSON.parse(readFileSync(join(host.recordedIn!, "session.json"), "utf8")).ended).toBeNumber();
  });
});

/** A leaser that writes what it is asked into `log` and hands out a fixed secret. */
function recordingLeaser(log: string[]): Leaser {
  return {
    lease: async (o) => {
      log.push(`lease ${o.token}`);
      return { secret: `secret-for-${o.token}-0123456789abcdef`, account: o.account ?? "?", allowGm: false };
    },
    logout: async (token) => void log.push(`logout ${token}`),
    release: async (token) => void log.push(`release ${token}`),
  };
}
