/**
 * The sandbox child's Landlock ruleset, as `confinementPlan` builds it — pure,
 * no child process, no kernel: this pins what gets asked of the kernel on each
 * ABI, so a change to the rights the snippet child holds is a visible diff
 * here before it is a behaviour in sandbox-fs.test.ts / sandbox-net.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { ACCESS_FS, ACCESS_NET, ConfinementError, confinementPlan, DEV_NODES, elfInterpreter, modulePort, PROC_GLOBAL_FILES, REQUIRED_ABI, SCOPE } from "../src/sandbox/confine";

const REPO = "/srv/wrathbench";
const BUN = "/home/bun/.bun/bin/bun";
const LOADER = "/lib64/ld-linux-x86-64.so.2";
const PID = 4242;
/** The stack at the repository root, as `stackReadPaths` finds it in this monorepo (sandbox-layout.test.ts resolves real trees). */
const STACK = { packages: [`${REPO}/mcp`, `${REPO}/sdk`], nodeModules: [`${REPO}/node_modules`], manifestDirs: [REPO] };

function plan(abi: number, moduleUrl = "http://worldserver:8086") {
  return confinementPlan({ stack: STACK, bunExe: BUN, moduleUrl, abi, pid: PID, interpreter: LOADER, exists: () => true });
}

describe("confinementPlan", () => {
  test("refuses a kernel without TCP rules: no Landlock, and ABIs 1-3", () => {
    expect(() => plan(0)).toThrow(ConfinementError);
    expect(() => plan(0)).toThrow(/unsupported or disabled/);
    for (const abi of [1, 2, 3]) {
      expect(() => plan(abi)).toThrow(ConfinementError);
      expect(() => plan(abi)).toThrow(new RegExp(`ABI ${abi} has no TCP rules; ABI ${REQUIRED_ABI}`));
    }
  });

  test("ABI 4: filesystem and TCP handled, no scoping, 16-byte attr, and it says so", () => {
    const p = plan(4);
    expect(p.handledFs).toBe(0x7fffn);
    expect(p.handledNet).toBe(ACCESS_NET.BIND_TCP | ACCESS_NET.CONNECT_TCP);
    expect(p.scoped).toBe(0n);
    expect(p.attrSize).toBe(16);
    expect(p.notes).toEqual([expect.stringContaining("no scoping")]);
  });

  test("ABI 5 adds IOCTL_DEV to the handled filesystem rights; ABI 6 adds both scopes and a 24-byte attr", () => {
    expect(plan(5).handledFs).toBe(0xffffn);
    expect(plan(5).scoped).toBe(0n);
    const p = plan(6);
    expect(p.scoped).toBe(SCOPE.ABSTRACT_UNIX_SOCKET | SCOPE.SIGNAL);
    expect(p.attrSize).toBe(24);
    expect(p.notes).toEqual([]);
    // Newer ABIs add nothing this wrapper asks for.
    expect(plan(10)).toEqual({ ...p, abi: 10 });
  });

  test("EXECUTE is granted on the bun binary and its ELF loader and on nothing else", () => {
    const p = plan(6);
    const executable = p.fs.filter((r) => (r.access & ACCESS_FS.EXECUTE) !== 0n).map((r) => r.path);
    expect(executable.sort()).toEqual([BUN, LOADER].sort());
    // Every directory is read-only (plus write+ioctl on the /dev nodes); no directory executes.
    for (const r of p.fs) {
      if (executable.includes(r.path)) continue;
      expect(r.access & ACCESS_FS.EXECUTE).toBe(0n);
    }
    // A static bun (no PT_INTERP) grants EXECUTE on the binary alone.
    const staticPlan = confinementPlan({ stack: STACK, bunExe: BUN, moduleUrl: "http://m:8086", abi: 6, pid: PID, interpreter: null, exists: () => true });
    expect(staticPlan.fs.filter((r) => (r.access & ACCESS_FS.EXECUTE) !== 0n).map((r) => r.path)).toEqual([BUN]);
  });

  test("nothing under the repo root but the workspaces and manifests; never the root itself", () => {
    const p = plan(6);
    const underRepo = p.fs.filter((r) => r.path.startsWith(REPO)).map((r) => r.path);
    expect(underRepo).toEqual([
      `${REPO}/mcp`,
      `${REPO}/sdk`,
      `${REPO}/node_modules`,
      `${REPO}/package.json`,
      `${REPO}/tsconfig.json`,
      `${REPO}/tsconfig.base.json`,
      `${REPO}/bunfig.toml`,
    ]);
    expect(p.fs.some((r) => r.path === REPO)).toBe(false);
    // WRITE_FILE only on the named /dev nodes.
    expect(p.fs.filter((r) => (r.access & ACCESS_FS.WRITE_FILE) !== 0n).map((r) => r.path)).toEqual(DEV_NODES.map((d) => `/dev/${d}`));
  });

  test("/proc: the child's own entry and named system-wide files, never /proc itself or another pid", () => {
    const p = plan(6);
    const proc = p.fs.filter((r) => r.path === "/proc" || r.path.startsWith("/proc/"));
    expect(proc.map((r) => r.path)).toEqual([`/proc/${PID}`, ...PROC_GLOBAL_FILES.map((f) => `/proc/${f}`), "/proc/sys"]);
    // Reads only: nothing under /proc is writable or executable.
    for (const r of proc) expect(r.access & ~(ACCESS_FS.READ_FILE | ACCESS_FS.READ_DIR)).toBe(0n);
    // Directory reads on the child's own entry and on /proc/sys alone; the rest are files.
    expect(proc.filter((r) => (r.access & ACCESS_FS.READ_DIR) !== 0n).map((r) => r.path)).toEqual([`/proc/${PID}`, "/proc/sys"]);
    // No per-process name among the globals: every one is a fixed system file.
    for (const f of PROC_GLOBAL_FILES) expect(f).toMatch(/^[a-z]+$/);
  });

  test("/dev: five named nodes and never the directory, so /dev/shm is out", () => {
    const p = plan(6);
    const dev = p.fs.filter((r) => r.path === "/dev" || r.path.startsWith("/dev/")).map((r) => r.path);
    expect(dev).toEqual(["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"]);
    expect(p.fs.some((r) => r.path === "/dev" || r.path.startsWith("/dev/shm"))).toBe(false);
  });

  test("missing paths are dropped; the executables are listed whether or not they exist", () => {
    const p = confinementPlan({ stack: STACK, bunExe: BUN, moduleUrl: "http://m:8086", abi: 6, pid: PID, interpreter: LOADER, exists: (path) => path === "/usr" || path === `${REPO}/mcp` });
    expect(p.fs.map((r) => r.path)).toEqual(["/usr", `${REPO}/mcp`]);
  });

  test("TCP: connect to the module URL's port only, bind nowhere", () => {
    expect(plan(6).net).toEqual([{ port: 8086, access: ACCESS_NET.CONNECT_TCP }]);
    expect(plan(6, "http://127.0.0.1:41234/").net).toEqual([{ port: 41234, access: ACCESS_NET.CONNECT_TCP }]);
    expect(plan(6, "https://module.example").net).toEqual([{ port: 443, access: ACCESS_NET.CONNECT_TCP }]);
    for (const p of [plan(4), plan(6)]) {
      expect(p.net.some((r) => (r.access & ACCESS_NET.BIND_TCP) !== 0n)).toBe(false);
    }
  });
});

describe("modulePort", () => {
  test("explicit port, scheme default, and refusal", () => {
    expect(modulePort("http://worldserver:8086")).toBe(8086);
    expect(modulePort("ws://worldserver:8086/events")).toBe(8086);
    expect(modulePort("http://worldserver")).toBe(80);
    expect(modulePort("https://worldserver")).toBe(443);
    expect(() => modulePort("not a url")).toThrow(ConfinementError);
    expect(() => modulePort("unix:///run/module.sock")).toThrow(/no TCP port/);
    // A plan over a bad URL refuses rather than opening the network.
    expect(() => plan(6, "nope")).toThrow(ConfinementError);
  });
});

describe("elfInterpreter", () => {
  test("reads PT_INTERP from the running bun, and null from a non-ELF file", () => {
    const interp = elfInterpreter(process.execPath);
    // Bun ships dynamically linked against glibc on Linux; a static build
    // would return null, which the plan also handles (above).
    if (interp !== null) expect(interp).toMatch(/^\/.*ld-/);
    expect(elfInterpreter(import.meta.path)).toBeNull();
    expect(elfInterpreter("/nonexistent/binary")).toBeNull();
  });
});
