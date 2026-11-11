/**
 * A child killed because its event loop stopped answering, against the real
 * confined child. The host sees only that the child went quiet, so whichever
 * snippet's timeout noticed is not the culprit by that fact: on arrival at a
 * crowded hub a run's `await sleep(20000)` poll was told it had blocked the
 * loop while something else held it. Every snippet in flight hears the same
 * thing, no culprit is named, and one stall is one restart.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scratchpad } from "../src/scratchpad";
import { SandboxHost, type SnippetResult } from "../src/sandbox/host";

const dirs: string[] = [];
const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TIMEOUT_MS = 1_000;

function makeHost(): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-stall-"));
  dirs.push(dir);
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: TIMEOUT_MS,
    pingGraceMs: 500,
    logSink: () => {},
  });
  hosts.push(host);
  return host;
}

/** What every snippet on a stalled child is told: no culprit, and the cause said to be unknown. */
function expectUnattributed(r: SnippetResult): void {
  expect(r.ok).toBe(false);
  expect(r.restarted).toBe(true);
  expect(r.error).toContain(`the sandbox event loop was blocked past ${TIMEOUT_MS}ms while this snippet was running`);
  expect(r.error).toContain("what blocked it is not known");
  expect(r.error).not.toContain("snippet blocked");
  expect(r.error).not.toContain("exited");
}

const ARM_SPIN = "setTimeout(() => { for (;;) {} }, 150); 'armed'";

describe("a sandbox killed for a blocked event loop", () => {
  test("a snippet parked in sleep while a routine blocks the loop is not blamed", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(ARM_SPIN)).ok).toBe(true);
    const parked = await host.evalSnippet("await sleep(5000, { wake: false }); 'woke'");
    expectUnattributed(parked);
    expect(parked.timedOut).toBe(true);
    const notices = host.drainNotices();
    expect(notices.map((n) => n.kind)).toEqual(["sandbox_restarted"]);
    expect(notices[0]!.text).toStartWith("sandbox restarted (its event loop was blocked past the timeout; what blocked it is not known). ");
    expect(host.totalRestarts).toBe(1);
    expect((await host.evalSnippet("1 + 1")).value).toBe("2");
  }, 15_000);

  test("two snippets in flight hear the same thing, and the stall is one restart", async () => {
    const host = makeHost();
    await host.evalSnippet("'warm'");
    // The bystander goes first, so its timeout is the one that notices; the
    // spin's own timeout fires while that ping is still unanswered.
    const bystander = host.evalSnippet("await sleep(5000, { wake: false }); 'woke'");
    await Bun.sleep(200);
    const culprit = host.evalSnippet("for (;;) {}");
    const [b, c] = await Promise.all([bystander, culprit]);
    expectUnattributed(b);
    expectUnattributed(c);
    expect(b.error).toBe(c.error);
    expect(host.totalRestarts).toBe(1);
    expect(host.drainNotices().map((n) => n.kind)).toEqual(["sandbox_restarted"]);
    expect((await host.evalSnippet("1 + 1")).value).toBe("2");
  }, 15_000);

  test("a snippet sent to the stalled child before the kill is told the same, not that the child crashed", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(ARM_SPIN)).ok).toBe(true);
    const parked = host.evalSnippet("await sleep(5000, { wake: false }); 'woke'");
    // Past the parked snippet's timeout, inside its ping's grace: this one is
    // still waiting on the old child when the host kills it.
    await Bun.sleep(TIMEOUT_MS + 200);
    const late = await host.evalSnippet("1 + 1");
    expectUnattributed(late);
    expect(late.timedOut).toBeUndefined();
    expectUnattributed(await parked);
    expect(host.totalRestarts).toBe(1);
  }, 15_000);
});
