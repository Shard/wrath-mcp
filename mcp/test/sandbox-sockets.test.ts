/**
 * The sandbox child's socket filter and resource limits (`confine.ts`):
 * the filter as a program, run here on every case it decides, and then the
 * real confined child, which must keep what it legitimately does (TCP to
 * the module, Bun's own stream socketpairs, name resolution when the module
 * URL names a host) and be refused everything else, however a snippet asks —
 * `node:net`, `node:dgram`, or libc itself through `bun:ffi`.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseSessionSecret } from "../src/module-auth";
import { Scratchpad } from "../src/scratchpad";
import {
  AF,
  BPF,
  ConfinementError,
  DEFAULT_SANDBOX_LIMITS,
  IPPROTO,
  limitFlags,
  moduleNeedsDns,
  parseLimit,
  RLIMIT,
  rlimitPlan,
  SECCOMP_ARCHES,
  SECCOMP_RET,
  seccompArch,
  seccompProgram,
  SOCK,
  type SockFilter,
} from "../src/sandbox/confine";
import { SandboxHost, type SandboxHostOptions } from "../src/sandbox/host";
import { startStubModule, STUB_PORT_SECRET, type StubModule } from "./fixtures/stub-module";

// ------------------------------------------------------------ the program

/** A classic BPF interpreter for the instructions the filter uses, over one `struct seccomp_data`. */
function run(program: readonly SockFilter[], d: { arch: number; nr: number; args?: number[] }): number {
  const word = (off: number): number => {
    if (off === 0) return d.nr >>> 0;
    if (off === 4) return d.arch >>> 0;
    const i = (off - 16) / 8;
    if (!Number.isInteger(i)) throw new Error(`read of the high word at ${off}`);
    return (d.args?.[i] ?? 0) >>> 0;
  };
  let a = 0;
  for (let pc = 0; pc < program.length; pc++) {
    const op = program[pc]!;
    switch (op.code) {
      case BPF.LD_W_ABS:
        a = word(op.k);
        break;
      case BPF.ALU_AND_K:
        a = (a & op.k) >>> 0;
        break;
      case BPF.JEQ_K:
        pc += a === op.k ? op.jt : op.jf;
        break;
      case BPF.JGE_K:
        pc += a >= op.k ? op.jt : op.jf;
        break;
      case BPF.RET_K:
        return op.k;
      default:
        throw new Error(`unknown op ${op.code}`);
    }
  }
  throw new Error("fell off the end");
}

const ALLOW = SECCOMP_RET.ALLOW;
const EACCES = SECCOMP_RET.ERRNO | 13;
const ENOSYS = SECCOMP_RET.ERRNO | 38;

describe("seccompProgram", () => {
  for (const [name, arch] of Object.entries(SECCOMP_ARCHES)) {
    describe(name, () => {
      const tcpOnly = seccompProgram(arch, { udp: false });
      const withUdp = seccompProgram(arch, { udp: true });
      const socket = (p: SockFilter[], domain: number, type: number, proto = 0): number => run(p, { arch: arch.audit, nr: arch.socket, args: [domain, type, proto] });
      const pair = (p: SockFilter[], domain: number, type: number): number => run(p, { arch: arch.audit, nr: arch.socketpair, args: [domain, type, 0, 0] });

      test("TCP over IPv4 and IPv6 is allowed, flags or not, protocol 0 or TCP", () => {
        for (const p of [tcpOnly, withUdp]) {
          for (const domain of [AF.INET, AF.INET6]) {
            for (const type of [SOCK.STREAM, SOCK.STREAM | SOCK.NONBLOCK | SOCK.CLOEXEC, SOCK.STREAM | SOCK.CLOEXEC]) {
              expect(socket(p, domain, type)).toBe(ALLOW);
              expect(socket(p, domain, type, IPPROTO.TCP)).toBe(ALLOW);
            }
          }
        }
      });

      test("a stream of another protocol is refused: SCTP, MPTCP", () => {
        for (const p of [tcpOnly, withUdp]) {
          expect(socket(p, AF.INET, SOCK.STREAM, 132)).toBe(EACCES);
          expect(socket(p, AF.INET6, SOCK.STREAM, 262)).toBe(EACCES);
        }
      });

      test("UDP only when there is a name to resolve, and only UDP: no ICMP datagrams", () => {
        expect(socket(tcpOnly, AF.INET, SOCK.DGRAM)).toBe(EACCES);
        expect(socket(tcpOnly, AF.INET6, SOCK.DGRAM | SOCK.CLOEXEC, IPPROTO.UDP)).toBe(EACCES);
        expect(socket(withUdp, AF.INET, SOCK.DGRAM)).toBe(ALLOW);
        expect(socket(withUdp, AF.INET6, SOCK.DGRAM | SOCK.NONBLOCK | SOCK.CLOEXEC, IPPROTO.UDP)).toBe(ALLOW);
        expect(socket(withUdp, AF.INET, SOCK.DGRAM, 1)).toBe(EACCES);
        expect(socket(withUdp, AF.INET6, SOCK.DGRAM, 58)).toBe(EACCES);
      });

      test("every other family and type is refused: unix, netlink, packet, raw, seqpacket", () => {
        for (const p of [tcpOnly, withUdp]) {
          expect(socket(p, AF.UNIX, SOCK.STREAM)).toBe(EACCES);
          expect(socket(p, AF.UNIX, SOCK.DGRAM | SOCK.CLOEXEC)).toBe(EACCES);
          expect(socket(p, 16, 3)).toBe(EACCES); // AF_NETLINK, SOCK_RAW
          expect(socket(p, 17, 3)).toBe(EACCES); // AF_PACKET
          expect(socket(p, AF.INET, 3, 1)).toBe(EACCES); // SOCK_RAW, ICMP
          expect(socket(p, AF.INET, 5)).toBe(EACCES); // SOCK_SEQPACKET
          expect(socket(p, 40, SOCK.STREAM)).toBe(EACCES); // AF_VSOCK
        }
      });

      test("socketpair: unix streams only", () => {
        expect(pair(tcpOnly, AF.UNIX, SOCK.STREAM | SOCK.CLOEXEC)).toBe(ALLOW);
        expect(pair(tcpOnly, AF.UNIX, SOCK.DGRAM)).toBe(EACCES);
        expect(pair(tcpOnly, AF.UNIX, 5)).toBe(EACCES);
        expect(pair(tcpOnly, AF.INET, SOCK.STREAM)).toBe(EACCES);
      });

      test("io_uring is ENOSYS; another ABI is ENOSYS for every call; anything else passes to Landlock", () => {
        for (const nr of arch.ioUring) expect(run(tcpOnly, { arch: arch.audit, nr })).toBe(ENOSYS);
        expect(run(tcpOnly, { arch: 0x40000003, nr: 102, args: [1] })).toBe(ENOSYS); // i386 socketcall
        expect(run(tcpOnly, { arch: arch.audit, nr: 0 })).toBe(ALLOW);
        expect(run(tcpOnly, { arch: arch.audit, nr: 63 })).toBe(ALLOW);
        if (arch.x32Bit !== undefined) expect(run(tcpOnly, { arch: arch.audit, nr: arch.x32Bit + arch.socket, args: [AF.INET, SOCK.STREAM] })).toBe(ENOSYS);
      });
    });
  }

  test("an architecture the filter is not written for is a refusal", () => {
    expect(seccompArch("x64")).toBe(SECCOMP_ARCHES.x64);
    expect(seccompArch("arm64")).toBe(SECCOMP_ARCHES.arm64);
    expect(() => seccompArch("riscv64")).toThrow(ConfinementError);
  });

  test("UDP follows the module URL: a name needs resolving, an address does not", () => {
    expect(moduleNeedsDns("http://worldserver:8086")).toBe(true);
    expect(moduleNeedsDns("http://localhost:8086")).toBe(true);
    expect(moduleNeedsDns("http://127.0.0.1:8086")).toBe(false);
    expect(moduleNeedsDns("http://[::1]:8086")).toBe(false);
    expect(() => moduleNeedsDns("nope")).toThrow(ConfinementError);
  });
});

describe("limits", () => {
  test("defaults: a generous address space, no CPU cap, a file-size cap; core dumps always off", () => {
    expect(DEFAULT_SANDBOX_LIMITS).toEqual({ addressSpaceBytes: 16 * 1024 ** 3, cpuSeconds: null, fileBytes: 1024 ** 3 });
    expect(rlimitPlan(DEFAULT_SANDBOX_LIMITS)).toEqual([
      { resource: RLIMIT.CORE, value: 0 },
      { resource: RLIMIT.AS, value: 16 * 1024 ** 3 },
      { resource: RLIMIT.CPU, value: null },
      { resource: RLIMIT.FSIZE, value: 1024 ** 3 },
    ]);
  });

  test("flags round-trip, and a bad value is a refusal", () => {
    expect(limitFlags({ addressSpaceBytes: 1024, cpuSeconds: null, fileBytes: 7 })).toEqual(["--limit-as=1024", "--limit-cpu=unlimited", "--limit-fsize=7"]);
    expect(parseLimit("--limit-cpu", "unlimited")).toBeNull();
    expect(parseLimit("--limit-cpu", "3600")).toBe(3600);
    for (const bad of ["0", "-1", "1.5", "lots", ""]) expect(() => parseLimit("--limit-as", bad)).toThrow(ConfinementError);
  });
});

// ------------------------------------------------------------- the child

const dirs: string[] = [];
const hosts: SandboxHost[] = [];
const stubs: StubModule[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  await Promise.all(stubs.splice(0).map((s) => s.stop()));
  for (const s of servers.splice(0)) s.close();
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-sock-"));
  dirs.push(dir);
  return dir;
}

function makeHost(moduleUrl: string, extra: Partial<SandboxHostOptions> = {}): SandboxHost {
  const host = new SandboxHost({
    moduleUrl,
    token: "test-token",
    scratchpad: new Scratchpad(join(tempDir(), "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    logSink: () => {},
    ...extra,
  });
  hosts.push(host);
  return host;
}

const unquote = (v: string | undefined): string => JSON.parse(v ?? '""') as string;

/** libc through `bun:ffi` in the child, the lowest a snippet can reach: each call's result or errno. */
const LIBC_PROBE = `
const { dlopen, read } = await import("bun:ffi");
const lib = dlopen("libc.so.6", { socket: { args: ["i32", "i32", "i32"], returns: "i32" }, socketpair: { args: ["i32", "i32", "i32", "ptr"], returns: "i32" }, syscall: { args: ["i64", "i64", "i64", "i64", "i64"], returns: "i64" }, close: { args: ["i32"], returns: "i32" }, __errno_location: { args: [], returns: "ptr" } });
const errno = () => read.i32(lib.symbols.__errno_location(), 0);
const sock = (d, t, p) => { const fd = lib.symbols.socket(d, t, p); if (fd >= 0) { lib.symbols.close(fd); return "ok"; } return "errno " + errno(); };
const pair = (d, t) => { const sv = new Int32Array(2); if (lib.symbols.socketpair(d, t, 0, sv) === 0) { lib.symbols.close(sv[0]); lib.symbols.close(sv[1]); return "ok"; } return "errno " + errno(); };
const sys = (nr, a, b, c) => Number(lib.symbols.syscall(nr, a, b, c, 0)) >= 0 ? "ok" : "errno " + errno();
`;

describe("the confined child, module by address", () => {
  const moduleServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("module") });
  afterAll(() => moduleServer.stop(true));
  const moduleUrl = `http://127.0.0.1:${moduleServer.port}`;

  test("TCP to the module's port still opens", async () => {
    const host = makeHost(moduleUrl);
    const r = await host.evalSnippet(
      `const net = await import("node:net"); return await new Promise((res) => { const s = net.connect(${moduleServer.port}, "127.0.0.1"); s.once("connect", () => { s.destroy(); res("OPEN"); }); s.once("error", (e) => res(e.code ?? String(e))); });`,
    );
    expect(unquote(r.value)).toBe("OPEN");
  });

  test("a pathname unix socket outside the sandbox is EACCES, and its listener hears nothing", async () => {
    const path = join(tempDir(), "outside.sock");
    let accepted = 0;
    const server: Server = createServer(() => accepted++);
    await new Promise<void>((r) => server.listen(path, r));
    servers.push(server);
    // The test process itself can reach it.
    await new Promise<void>((res, rej) => {
      const c = (require("node:net") as typeof import("node:net")).connect(path, () => {
        c.destroy();
        res();
      });
      c.once("error", rej);
    });
    const before = accepted;
    const host = makeHost(moduleUrl);
    const r = await host.evalSnippet(
      `const net = await import("node:net"); return await new Promise((res) => { const s = net.connect(${JSON.stringify(path)}); s.once("connect", () => { s.destroy(); res("OPEN"); }); s.once("error", (e) => res(e.code ?? String(e))); });`,
    );
    expect(unquote(r.value)).toBe("EACCES");
    await Bun.sleep(50);
    expect(accepted).toBe(before);
  });

  test("UDP to a listener outside the sandbox is EACCES, and nothing arrives", async () => {
    const listener = createSocket("udp4");
    const got: Buffer[] = [];
    listener.on("message", (m) => got.push(m));
    await new Promise<void>((r) => listener.bind(0, "127.0.0.1", r));
    servers.push(listener);
    const port = listener.address().port;
    const host = makeHost(moduleUrl);
    const r = await host.evalSnippet(
      `const dgram = await import("node:dgram"); return await new Promise((res) => { try { const s = dgram.createSocket("udp4"); s.once("error", (e) => res(e.code ?? String(e))); s.send("hello", ${port}, "127.0.0.1", (e) => { s.close(); res(e ? e.code ?? String(e) : "SENT"); }); } catch (e) { res(e.code ?? String(e)); } });`,
    );
    expect(unquote(r.value)).toBe("EACCES");
    const viaBun = await host.evalSnippet(`try { const s = await Bun.udpSocket({}); s.send("hello", ${port}, "127.0.0.1"); s.close(); return "SENT"; } catch (e) { return e.code ?? String(e); }`);
    expect(unquote(viaBun.value)).toBe("EACCES");
    await Bun.sleep(50);
    expect(got).toEqual([]);
  });

  test("through libc itself: TCP and stream socketpairs open, every other family and io_uring do not", async () => {
    const host = makeHost(moduleUrl);
    const r = await host.evalSnippet(
      `${LIBC_PROBE} return JSON.stringify({ tcp: sock(2, 1, 0), tcp6: sock(10, 1, 6), udp: sock(2, 2, 0), udp6: sock(10, 2, 17), unix: sock(1, 1, 0), netlink: sock(16, 3, 0), packet: sock(17, 3, 0), raw: sock(2, 3, 1), sctp: sock(2, 1, 132), mptcp: sock(2, 1, 262), icmp: sock(2, 2, 1), pairStream: pair(1, 1 | 0x80000), pairDgram: pair(1, 2), ioUring: sys(425, 1, 0, 0), x32: process.arch === "x64" ? sys(0x40000000 + 41, 2, 1, 0) : "errno 38" });`,
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(unquote(r.value))).toEqual({
      tcp: "ok",
      tcp6: "ok",
      udp: "errno 13",
      udp6: "errno 13",
      unix: "errno 13",
      netlink: "errno 13",
      packet: "errno 13",
      raw: "errno 13",
      sctp: "errno 13",
      mptcp: "errno 13",
      icmp: "errno 13",
      pairStream: "ok",
      pairDgram: "errno 13",
      ioUring: "errno 38",
      x32: "errno 38",
    });
  });

  test("the limits are the child's own, as set and not raisable; core dumps off", async () => {
    const read = `return (await Bun.file("/proc/self/limits").text()).split("\\n").filter((l) => /^Max (cpu time|file size|core file size|address space)/.test(l)).map((l) => l.trim().split(/\\s{2,}/).slice(0, 3).join("|")).join("\\n");`;
    const byDefault = await makeHost(moduleUrl).evalSnippet(read);
    expect(unquote(byDefault.value).split("\n")).toEqual([
      "Max cpu time|unlimited|unlimited",
      `Max file size|${1024 ** 3}|${1024 ** 3}`,
      "Max core file size|0|0",
      `Max address space|${16 * 1024 ** 3}|${16 * 1024 ** 3}`,
    ]);
    const set = await makeHost(moduleUrl, { limits: { cpuSeconds: 86_400, fileBytes: 4096 } }).evalSnippet(read);
    expect(unquote(set.value).split("\n")).toEqual([
      "Max cpu time|86400|86400",
      "Max file size|4096|4096",
      "Max core file size|0|0",
      `Max address space|${16 * 1024 ** 3}|${16 * 1024 ** 3}`,
    ]);
  });
});

describe("the confined child, module by name", () => {
  test("a session over a module URL that names its host: the name resolves, the client connects and logs in", async () => {
    const stub = startStubModule();
    stubs.push(stub);
    const moduleUrl = stub.baseUrl.replace("127.0.0.1", "localhost");
    const lease = await leaseSessionSecret({ moduleUrl, token: "sock-token-0001", account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: STUB_PORT_SECRET } });
    if (lease.secret === undefined) throw new Error(`lease: ${JSON.stringify(lease)}`);
    const host = makeHost(moduleUrl, { token: "sock-token-0001", secret: lease.secret, account: "RUNNER" });
    const r = await host.evalSnippet('await connect(); return (await sdk.createSession({ character: "Thalvorn", race: 1, class: 2 })).character;');
    expect(r.ok).toBe(true);
    expect(unquote(r.value)).toBe("Thalvorn");
    // UDP is open for resolution here, and still nothing else is.
    const probe = await host.evalSnippet(`${LIBC_PROBE} return JSON.stringify({ udp: sock(2, 2, 0), udp6: sock(10, 2, 17), unix: sock(1, 1, 0), netlink: sock(16, 3, 0), icmp: sock(2, 2, 1) });`);
    expect(JSON.parse(unquote(probe.value))).toEqual({ udp: "ok", udp6: "ok", unix: "errno 13", netlink: "errno 13", icmp: "errno 13" });
  });
});
