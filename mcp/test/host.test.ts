/**
 * The host `main.ts` serves over stdio and a hosted gateway opens per
 * credential: one tool list per surface, built in one place. Without a
 * program it is what `main.ts` served before the host was its own module
 * (the fan-out-1 golden builds that list itself, and this holds the host's to
 * it); with one, the program's tools in place of the core `run_snippet`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FANOUT_TOOL_ORDER, fanoutTools, PLAIN_FANOUT_RENDER, type FanoutToolContext } from "../src/fanout";
import { hostToolDefs, hostToolSpecs, openHost, PLAIN_RENDER, type OpenedHost } from "../src/host";
import { coreTools, programTools, ToolSet, type CoreToolRender, type ProgramToolContext } from "../src/tools";
import { startStubModule, STUB_PORT_SECRET, type StubModule } from "./fixtures/stub-module";
import { portSecretLeaser } from "../src/module-auth";

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
