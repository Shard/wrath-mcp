/**
 * Confinement for the sandbox child: filesystem, TCP, socket families, exec,
 * process scope and resource limits.
 *
 * The host spawns THIS file, not the child's entry:
 *
 *   bun confine.ts [--read=<dir>]... [--limit-<as|cpu|fsize>=<n|unlimited>]... <bun argv for the child>
 *
 * It builds a Linux Landlock ruleset and a seccomp filter, applies both to
 * itself with the resource limits, and then `execv`s the real child in place.
 * All three are inherited across exec and cannot be lifted by the restricted
 * process, so whatever a snippet reaches for — `node:fs`, `node:net`,
 * `Bun.connect`, `Bun.spawn`, `bun:ffi`, a re-exec'd `bun` — the kernel
 * answers, not a JavaScript shim. The ruleset (`confinementPlan`):
 *
 *  - Filesystem: reads only where the child legitimately needs them (the Bun
 *    binary and system libraries, the `mcp` and `sdk` packages and the
 *    `node_modules/` their dependencies are installed in, wherever those are
 *    (`stackReadPaths`), any directory the host names with `--read=` (a
 *    harness's own child extension, e.g. the runner's `runner/`), the
 *    workspace manifests, its own `/proc` entry and a few system-wide `/proc`
 *    files, and five `/dev` nodes). `.env`, the repo root, `$HOME`, `/tmp`,
 *    `/dev/shm` and every other process's `/proc` entry are `EACCES` by any
 *    path.
 *  - Exec: `LANDLOCK_ACCESS_FS_EXECUTE` is granted on exactly two files, the
 *    Bun binary and its ELF interpreter, because the kernel checks both when
 *    this wrapper execs the child. Nothing else in the sandbox spawns or needs
 *    to (the child and the SDK fork nothing; Bun's workers are threads), so
 *    `/bin/sh`, `curl` and every other binary are `EACCES` at `posix_spawn`.
 *    Re-running `bun` itself gains nothing: the new process has a pid whose
 *    `/proc` entry the ruleset does not grant, so it fails to start, and were
 *    it to start it would be in the same Landlock domain with the same
 *    environment.
 *  - TCP (ABI 4, Linux 6.7+): `connect` is allowed to one port, the one in the
 *    run's module URL (`WRATHBENCH_MODULE_URL`, HTTP and the `/events`
 *    WebSocket share it); `bind` is allowed nowhere. Landlock network rules
 *    are per port and know nothing of hosts, so the child can still open a TCP
 *    connection to *any* address on that port — the per-host boundary is the
 *    deployment's network policy, documented in docs/CONTRACTS.md.
 *  - Scope (ABI 6, Linux 6.12+): the child cannot connect to abstract unix
 *    sockets outside its domain or signal processes outside it (the runner
 *    host included).
 *
 * Socket families are a seccomp filter's (`seccompProgram`), because Landlock
 * on the kernels this runs on (ABI 6 on the fleet) rules only TCP ports. What
 * the child legitimately opens was traced, not assumed: TCP sockets to the
 * module, unix stream socketpairs (Bun's own pipes for a `Bun.spawn`, which
 * Landlock then refuses to exec), and, when the module URL names a host
 * rather than an address, the UDP sockets name resolution sends from. The
 * IPC channel to the host is an inherited descriptor and needs no socket
 * call. So `socket()` is allowed for `AF_INET`/`AF_INET6` stream sockets of
 * protocol TCP, and datagram sockets of protocol UDP only when there is a
 * name to resolve; `socketpair()` for unix stream pairs only, which reach
 * nothing outside the pair. Everything else is `EACCES`: a pathname or
 * abstract unix socket, netlink, packet, raw and every other family, and
 * SCTP or MPTCP streams, which Landlock's TCP rules would not see. io_uring is
 * `ENOSYS`, since its socket and connect operations never pass a seccomp
 * filter, as is any syscall of another ABI (x32, i386) than the filter's.
 *
 * Resource limits (`SandboxLimits`, set with `setrlimit` and inherited by the
 * exec): a file-size cap and no core dumps always, and an address-space cap
 * and a CPU-time cap when a host sets them. Both of those are off by default
 * because either can reach the model: a snippet past the address-space cap
 * gets an allocation error or a restart where it got memory before, and
 * `RLIMIT_CPU` counts the process's whole life, so a session with no end
 * would reach any finite cap however idle it is. An address-space cap must
 * sit well above the runtime's own reservation (about 6 GiB, 10 GiB at its
 * peak while starting) or no child starts. Resident memory and a CPU rate are
 * the deployment's (a container's limits).
 *
 * What none of this covers and this wrapper therefore does not claim: which
 * hosts the allowed TCP port is reached on, and, with a module host to
 * resolve, which hosts UDP reaches (a module URL by address allows no UDP at
 * all). Those are the network policy's job.
 *
 * Fail closed, no knob: without Landlock at all, or with an ABI below 4 (no
 * TCP rules), on a CPU architecture the filter is not written for, or when
 * the kernel or container refuses the filter or a limit, this wrapper exits
 * instead of exec'ing the child, so a snippet never runs with the filesystem
 * or the network open. Scoping is applied when the kernel has it and
 * announced on stderr when it does not — the fleet's kernel has it; the
 * kernels without it that run this code are CI's.
 *
 * Why a wrapper and not a call inside the child: `landlock_restrict_self`
 * restricts the calling *thread*, and Bun starts its GC and I/O threads before
 * any user code runs, so a restriction applied from inside the child would
 * leave the thread pool unconfined. `execve` replaces the whole process with
 * the calling thread's image, restriction included, so restricting here and
 * then exec'ing is complete. The IPC channel and stdio are plain inherited
 * file descriptors and survive the exec unchanged.
 *
 * Why Landlock and not bubblewrap / user namespaces / a uid switch: it is in
 * the kernel, needs no privileges, no extra binaries, no namespace support in
 * the container's seccomp profile — only the three `landlock_*` syscalls, and
 * for the socket filter `prctl(PR_SET_SECCOMP)`, which a container's default
 * seccomp profile allows.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { dlopen, FFIType, ptr, read } from "bun:ffi";

// Linux ABI constants (include/uapi/linux/landlock.h, unified syscall table).
const SYS_landlock_create_ruleset = 444;
const SYS_landlock_add_rule = 445;
const SYS_landlock_restrict_self = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;
const LANDLOCK_RULE_NET_PORT = 2;

export const ACCESS_FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  IOCTL_DEV: 1n << 15n, // ABI 5
} as const;

export const ACCESS_NET = {
  BIND_TCP: 1n << 0n,
  CONNECT_TCP: 1n << 1n,
} as const;

export const SCOPE = {
  ABSTRACT_UNIX_SOCKET: 1n << 0n,
  SIGNAL: 1n << 1n,
} as const;

/** The lowest Landlock ABI this wrapper runs under: 4 brought the TCP rules. */
export const REQUIRED_ABI = 4;
/** The ABI that brought `scoped` (abstract unix sockets, signals). */
const SCOPE_ABI = 6;

/** Every filesystem access right the running kernel's Landlock ABI knows. */
function handledAccessFs(abi: number): bigint {
  if (abi >= 5) return 0xffffn; // + IOCTL_DEV
  if (abi >= 3) return 0x7fffn; // + TRUNCATE
  if (abi >= 2) return 0x3fffn; // + REFER
  return 0x1fffn;
}

const O_CLOEXEC = 0x80000;
const O_PATH = 0x200000;
const PR_SET_NO_NEW_PRIVS = 38;
const PR_SET_SECCOMP = 22;
const SECCOMP_MODE_FILTER = 2;

const LIBC_SYMBOLS = {
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
  open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  execv: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;

// ------------------------------------------------------------ socket filter

/** Address families, socket types and protocols the filter names (include/linux/socket.h, net.h, in.h). */
export const AF = { UNIX: 1, INET: 2, INET6: 10 } as const;
export const SOCK = { STREAM: 1, DGRAM: 2, NONBLOCK: 0x800, CLOEXEC: 0x80000 } as const;
export const IPPROTO = { TCP: 6, UDP: 17 } as const;
const EACCES = 13;
const ENOSYS = 38;

/** The syscalls the filter rules, per architecture: `AUDIT_ARCH_*` and the numbers from each unistd.h. */
interface SeccompArch {
  audit: number;
  socket: number;
  socketpair: number;
  /** io_uring_setup, io_uring_enter, io_uring_register: the unified table's numbers, the same on both. */
  ioUring: readonly number[];
  /** x86-64 shares its `AUDIT_ARCH` with x32, whose syscall numbers carry this bit. */
  x32Bit?: number;
}

export const SECCOMP_ARCHES: Readonly<Record<"x64" | "arm64", SeccompArch>> = {
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53, ioUring: [425, 426, 427], x32Bit: 0x40000000 },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199, ioUring: [425, 426, 427] },
};

/** One classic BPF instruction, as `struct sock_filter` lays it out. */
export interface SockFilter {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

export const BPF = {
  LD_W_ABS: 0x20,
  ALU_AND_K: 0x54,
  JEQ_K: 0x15,
  JGE_K: 0x35,
  RET_K: 0x06,
} as const;

export const SECCOMP_RET = {
  ALLOW: 0x7fff0000,
  ERRNO: 0x00050000,
} as const;

/** `struct seccomp_data` offsets: nr, arch, then the low 32 bits of each argument (both arches are little-endian). */
const DATA_NR = 0;
const DATA_ARCH = 4;
const dataArg = (i: number): number => 16 + 8 * i;

/**
 * The socket filter, as classic BPF over `struct seccomp_data`
 * (Documentation/userspace-api/seccomp_filter.rst). Pure, so a test can run it
 * on every case it should allow and refuse.
 *
 * - Another ABI than this one's (i386 through `int 0x80`, x32): `ENOSYS`.
 * - io_uring: `ENOSYS`, as on a kernel built without it.
 * - `socket(domain, type, protocol)`: `AF_INET`/`AF_INET6` only; a stream
 *   socket with protocol 0 or TCP; a datagram socket with protocol 0 or UDP,
 *   and only when `udp` (there is a module host to resolve); `EACCES`
 *   otherwise. Only the low 32 bits of each argument are read: the kernel
 *   takes them as `int`.
 * - `socketpair(domain, type, protocol)`: `AF_UNIX` stream pairs only.
 * - Everything else is allowed: Landlock rules it.
 */
export function seccompProgram(arch: SeccompArch, o: { udp: boolean }): SockFilter[] {
  type Op = { code: number; k: number; jt?: string; jf?: string } | { label: string };
  const allow = SECCOMP_RET.ALLOW;
  const eacces = SECCOMP_RET.ERRNO | EACCES;
  const enosys = SECCOMP_RET.ERRNO | ENOSYS;
  const typeMask = ~(SOCK.NONBLOCK | SOCK.CLOEXEC) >>> 0;
  const ld = (k: number): Op => ({ code: BPF.LD_W_ABS, k });
  const jeq = (k: number, jt: string, jf = "next"): Op => ({ code: BPF.JEQ_K, k, jt, jf });
  const ret = (k: number): Op => ({ code: BPF.RET_K, k });
  const ops: Op[] = [
    ld(DATA_ARCH),
    jeq(arch.audit, "next", "enosys"),
    ld(DATA_NR),
    ...(arch.x32Bit !== undefined ? [{ code: BPF.JGE_K, k: arch.x32Bit, jt: "enosys", jf: "next" }] : []),
    jeq(arch.socket, "socket"),
    jeq(arch.socketpair, "socketpair"),
    ...arch.ioUring.map((nr) => jeq(nr, "enosys")),
    ret(allow),

    { label: "socket" },
    ld(dataArg(0)),
    jeq(AF.INET, "type"),
    jeq(AF.INET6, "type", "eacces"),
    { label: "type" },
    ld(dataArg(1)),
    { code: BPF.ALU_AND_K, k: typeMask },
    jeq(SOCK.STREAM, "stream"),
    ...(o.udp ? [jeq(SOCK.DGRAM, "dgram", "eacces")] : [ret(eacces)]),
    { label: "stream" },
    ld(dataArg(2)),
    jeq(0, "allow"),
    jeq(IPPROTO.TCP, "allow", "eacces"),
    ...(o.udp ? [{ label: "dgram" }, ld(dataArg(2)), jeq(0, "allow"), jeq(IPPROTO.UDP, "allow", "eacces")] : []),

    { label: "socketpair" },
    ld(dataArg(0)),
    jeq(AF.UNIX, "next", "eacces"),
    ld(dataArg(1)),
    { code: BPF.ALU_AND_K, k: typeMask },
    jeq(SOCK.STREAM, "allow", "eacces"),

    { label: "allow" },
    ret(allow),
    { label: "eacces" },
    ret(eacces),
    { label: "enosys" },
    ret(enosys),
  ];
  // Resolve labels to the relative offsets classic BPF jumps by.
  const at = new Map<string, number>();
  let n = 0;
  for (const op of ops) {
    if ("label" in op) at.set(op.label, n);
    else n++;
  }
  const out: SockFilter[] = [];
  for (const op of ops) {
    if ("label" in op) continue;
    const i = out.length;
    const rel = (target: string | undefined): number => {
      if (target === undefined || target === "next") return 0;
      const to = at.get(target);
      if (to === undefined || to <= i || to - i - 1 > 255) throw new ConfinementError(`seccomp program: bad jump to ${target}`);
      return to - i - 1;
    };
    out.push({ code: op.code, jt: rel(op.jt), jf: rel(op.jf), k: op.k >>> 0 });
  }
  return out;
}

/** The filter's architecture for this process, or a refusal: an unknown one is not run unfiltered. */
export function seccompArch(arch: string = process.arch): SeccompArch {
  const a = (SECCOMP_ARCHES as Record<string, SeccompArch>)[arch];
  if (a === undefined) throw new ConfinementError(`no socket filter is written for the ${arch} architecture`);
  return a;
}

/**
 * Whether the child must resolve a name to reach the module: true unless the
 * module URL's host is an IP address. Name resolution sends UDP, so only then
 * does the filter allow a datagram socket.
 */
export function moduleNeedsDns(moduleUrl: string): boolean {
  let host: string;
  try {
    host = new URL(moduleUrl).hostname;
  } catch {
    throw new ConfinementError(`module URL ${JSON.stringify(moduleUrl)} does not parse`);
  }
  return isIP(host.replace(/^\[(.*)\]$/, "$1")) === 0;
}

// ----------------------------------------------------------------- limits

/**
 * The child's resource limits, each applied as both the soft and the hard
 * limit (so the child cannot raise it), and never above a hard limit the
 * wrapper already inherited. `null` leaves that limit as inherited.
 */
export interface SandboxLimits {
  /**
   * `RLIMIT_AS`: the address space, in bytes. Off by default (see the
   * header). Bun reserves about 6.1 GiB at start and peaks at 10.1 GiB while
   * starting, so a cap below about 12 GiB stops every child from starting.
   */
  addressSpaceBytes: number | null;
  /** `RLIMIT_CPU`: CPU seconds over the child's whole life, every thread counted. Off by default (see the header). */
  cpuSeconds: number | null;
  /** `RLIMIT_FSIZE`: the largest file the child may write, in bytes. */
  fileBytes: number | null;
}

const GiB = 1024 ** 3;

/**
 * The defaults: only what never reaches a session. The file-size cap is
 * inert while the ruleset grants no writable file; address space and CPU
 * time are off. For sizing an address-space cap: a child at fan-out 40
 * under a synthetic 8,000 frames a second (`test/fixtures/fanout-load.ts`)
 * held 7.1 GiB of address space and 168 MiB resident; a bare one 6.1 GiB,
 * with a 10.1 GiB peak while starting.
 */
export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  addressSpaceBytes: null,
  cpuSeconds: null,
  fileBytes: 1 * GiB,
});

/** The `RLIMIT_*` resource numbers (the same on x86-64 and arm64). */
export const RLIMIT = { CPU: 0, FSIZE: 1, CORE: 4, AS: 9 } as const;
const RLIM_INFINITY = 0xffffffffffffffffn;

/** The limits as the wrapper's flags, every one stated so the child's limits are the host's and nothing implicit. */
export function limitFlags(limits: SandboxLimits): string[] {
  const v = (n: number | null): string => (n === null ? "unlimited" : String(n));
  return [`--limit-as=${v(limits.addressSpaceBytes)}`, `--limit-cpu=${v(limits.cpuSeconds)}`, `--limit-fsize=${v(limits.fileBytes)}`];
}

/** One `--limit-*=` value: a positive whole number, or `unlimited`. */
export function parseLimit(flag: string, value: string): number | null {
  if (value === "unlimited") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConfinementError(`${flag} must be a positive whole number or "unlimited", not ${JSON.stringify(value)}`);
  return n;
}

/** The rlimits to set, in order: core dumps off (a dump would hold the lease secret), then the three limits. */
export function rlimitPlan(limits: SandboxLimits): { resource: number; value: number | null }[] {
  return [
    { resource: RLIMIT.CORE, value: 0 },
    { resource: RLIMIT.AS, value: limits.addressSpaceBytes },
    { resource: RLIMIT.CPU, value: limits.cpuSeconds },
    { resource: RLIMIT.FSIZE, value: limits.fileBytes },
  ];
}

let libcHandle: ReturnType<typeof dlopen<typeof LIBC_SYMBOLS>> | undefined;

/**
 * libc, opened on first use rather than at import: the plan and its tests
 * import this file without ever touching the kernel, and a process that only
 * plans (or only imports the package's root) has no business loading libc.
 */
function libc(): ReturnType<typeof dlopen<typeof LIBC_SYMBOLS>> {
  libcHandle ??= dlopen("libc.so.6", LIBC_SYMBOLS);
  return libcHandle;
}

function errno(): number {
  const p = libc().symbols.__errno_location();
  return p === null ? 0 : read.i32(p, 0);
}

function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf8");
}

/** The running kernel's Landlock ABI; 0 when Landlock is unsupported or disabled. */
export function landlockAbi(): number {
  const abi = Number(libc().symbols.syscall(SYS_landlock_create_ruleset, 0, 0, LANDLOCK_CREATE_RULESET_VERSION, 0));
  return abi < 1 ? 0 : abi;
}

function fail(step: string, detail?: string): never {
  const e = errno();
  console.error(
    `[sandbox] confinement failed at ${step}${detail ? ` (${detail})` : ""}` +
      `${e ? `: errno ${e}` : ""} — refusing to start the snippet child unconfined. ` +
      `Landlock ABI ${REQUIRED_ABI} or newer (Linux 6.7+, syscalls 444-446), prctl(PR_SET_SECCOMP) and setrlimit ` +
      `must be available to this process on x86-64 or arm64; if this is a container, its seccomp profile must permit them.`,
  );
  process.exit(78); // EX_CONFIG
}

export interface FsRule {
  path: string;
  access: bigint;
}

export interface NetRule {
  port: number;
  access: bigint;
}

/** The ruleset as built for one kernel ABI and one run — pure, so a test can pin it. */
export interface ConfinementPlan {
  abi: number;
  handledFs: bigint;
  handledNet: bigint;
  scoped: bigint;
  /** Bytes of `struct landlock_ruleset_attr` the kernel of this ABI accepts. */
  attrSize: number;
  fs: FsRule[];
  net: NetRule[];
  /** The socket filter's one choice: whether a datagram (UDP) socket may be opened, for name resolution. */
  sockets: { udp: boolean };
  /** The resource limits the child is exec'd under. */
  limits: SandboxLimits;
  /** What the plan could not do on this kernel, one line each, for stderr. */
  notes: string[];
}

/** Thrown when no confining ruleset can be built; the wrapper turns it into a refusal to exec. */
export class ConfinementError extends Error {}

/**
 * The one TCP port the child may connect to: the module URL's. HTTP and the
 * `/events` WebSocket share it (sdk/src/client.ts derives the WebSocket URL
 * from `baseUrl`). An unparsable URL is a refusal, not an open network.
 */
export function modulePort(moduleUrl: string): number {
  let url: URL;
  try {
    url = new URL(moduleUrl);
  } catch {
    throw new ConfinementError(`module URL ${JSON.stringify(moduleUrl)} does not parse`);
  }
  if (url.port !== "") return Number(url.port);
  if (url.protocol === "http:" || url.protocol === "ws:") return 80;
  if (url.protocol === "https:" || url.protocol === "wss:") return 443;
  throw new ConfinementError(`module URL ${JSON.stringify(moduleUrl)} has no TCP port`);
}

/**
 * `PT_INTERP` of a 64-bit ELF binary — the dynamic loader the kernel opens for
 * execution (`open_exec`, which Landlock checks as EXECUTE) when the binary
 * runs. Null for a static binary or anything that is not ELF64.
 */
export function elfInterpreter(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const at = (offset: number, size: number): Buffer => {
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, offset);
      return buf.subarray(0, n);
    };
    const header = at(0, 64);
    if (header.length < 64 || header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2) return null;
    const phoff = Number(header.readBigUInt64LE(0x20));
    const phentsize = header.readUInt16LE(0x36);
    const phnum = header.readUInt16LE(0x38);
    const table = at(phoff, phentsize * phnum);
    for (let i = 0; i < phnum; i++) {
      const ph = table.subarray(i * phentsize, (i + 1) * phentsize);
      if (ph.length < 40 || ph.readUInt32LE(0) !== 3) continue; // PT_INTERP
      const offset = Number(ph.readBigUInt64LE(8));
      const size = Number(ph.readBigUInt64LE(32));
      const interp = at(offset, size).toString("utf8").replace(/\0+$/, "");
      return interp.length > 0 ? interp : null;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** System-wide /proc files the runtime reads (memory, CPUs, uptime, kernel version); nothing per-process. */
export const PROC_GLOBAL_FILES: readonly string[] = ["meminfo", "stat", "cpuinfo", "loadavg", "uptime", "version", "filesystems"];

/** The /dev nodes the child may open: the null, zero and full sinks and the random sources. */
export const DEV_NODES: readonly string[] = ["null", "zero", "full", "random", "urandom"];

/** The manifests Bun may read in each directory above a package while it resolves and transpiles. */
export const MANIFEST_FILES: readonly string[] = ["package.json", "tsconfig.json", "tsconfig.base.json", "bunfig.toml"];

/** Where the stack the child runs is installed, as `stackReadPaths` finds it. */
export interface StackReadPaths {
  /** This package's directory, then every workspace package it depends on, transitively (`mcp`, `sdk`). */
  packages: string[];
  /** The `node_modules` directories those packages' dependencies are installed in. */
  nodeModules: string[];
  /**
   * The directories from each package's parent up to the install root (the
   * directory holding `node_modules`), whose `MANIFEST_FILES` are granted:
   * Bun reads them while resolving (`sdk/tsconfig.json` extends
   * `../tsconfig.base.json`, the root `package.json` names the workspaces).
   */
  manifestDirs: string[];
}

/** The nearest directory at or above `dir` holding a `package.json`. */
function packageDirOf(dir: string): string {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) return d;
    if (dirname(d) === d) throw new ConfinementError(`no package.json at or above ${dir}`);
  }
}

/**
 * The outermost `node_modules` directory on a resolved path, or null when the
 * path is not inside one (a workspace package, reached through a symlink that
 * resolution has already followed). Outermost, not nearest: Bun's isolated
 * linker stores a package at `<root>/node_modules/.bun/<name>@<v>/node_modules/<name>`
 * and links every workspace's `node_modules/<name>` there, so the whole
 * `<root>/node_modules` is what the child reads through.
 */
function outermostNodeModules(path: string): string | null {
  const parts = path.split(sep);
  const i = parts.indexOf("node_modules");
  return i < 0 ? null : parts.slice(0, i + 1).join(sep);
}

/**
 * The directories the stack's code and its imports are read from, found by
 * resolving rather than by counting directories, so the same code is right
 * whether the packages sit at the repository root (`<root>/{mcp,sdk}`) or one
 * level down in a consumer's checkout (`<root>/wrath-mcp/{mcp,sdk}`, with
 * `node_modules` hoisted at `<root>`).
 *
 * Starting from the package that holds `from` (this file's: `mcp`), each
 * package's `dependencies` are resolved from its own directory, as the child
 * will import them. A dependency that resolves (symlinks followed) outside any
 * `node_modules` is a workspace package and is walked in turn; one inside is
 * granted through the outermost `node_modules` it sits in. Anything that does
 * not resolve is a refusal: a ruleset built over a broken install would fail
 * the child in a less obvious place.
 */
export function stackReadPaths(from: string): StackReadPaths {
  const packages = [packageDirOf(from)];
  const nodeModules: string[] = [];
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i]!;
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      let resolved: string;
      try {
        resolved = Bun.resolveSync(dep, pkg);
      } catch (err) {
        throw new ConfinementError(`${dep} does not resolve from ${pkg}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const nm = outermostNodeModules(resolved);
      if (nm !== null) {
        if (!nodeModules.includes(nm)) nodeModules.push(nm);
      } else {
        const dir = packageDirOf(dirname(resolved));
        if (!packages.includes(dir)) packages.push(dir);
      }
    }
  }
  const roots = nodeModules.map((nm) => dirname(nm));
  const manifestDirs: string[] = [];
  for (const pkg of packages) {
    // A package outside every install root (nothing it depends on is in a
    // node_modules above it) has no manifests above it worth granting.
    const root = roots.find((r) => pkg.startsWith(r + sep));
    if (root === undefined) continue;
    for (let d = dirname(pkg); ; d = dirname(d)) {
      if (!manifestDirs.includes(d)) manifestDirs.push(d);
      if (d === root) break;
    }
  }
  return { packages, nodeModules, manifestDirs };
}

export interface PlanInput {
  /** The stack's packages and install, from `stackReadPaths`. */
  stack: StackReadPaths;
  bunExe: string;
  moduleUrl: string;
  abi: number;
  /**
   * The pid the child will run as: this wrapper's own, since execv keeps it.
   * Its /proc entry is the only one the child may read.
   */
  pid: number;
  /** Override for tests; defaults to reading `bunExe`'s ELF header. */
  interpreter?: string | null;
  /** Override for tests; defaults to `existsSync`. */
  exists?: (path: string) => boolean;
  /**
   * Directories beyond the stack's own workspaces the child must read: the
   * code of a child extension a harness loads into it (`--read=` on the
   * command line, from `SandboxHostOptions.readDirs`). Read-only, like the
   * workspaces.
   */
  readDirs?: readonly string[];
  /** The child's resource limits; default `DEFAULT_SANDBOX_LIMITS`. */
  limits?: SandboxLimits;
}

/**
 * What the child may do. Directories are read-only (no EXECUTE: that is how a
 * spawned `/bin/sh` or `curl` is refused), the Bun binary and its loader are
 * the only executables, the module's port is the only TCP destination, and
 * nothing may bind. Missing paths are skipped — a rule needs an inode to hang
 * on — and the executables are never skipped silently: without them the exec
 * itself fails and the wrapper exits.
 */
export function confinementPlan(input: PlanInput): ConfinementPlan {
  const { stack, bunExe, moduleUrl, abi } = input;
  const exists = input.exists ?? existsSync;
  if (abi < REQUIRED_ABI) {
    throw new ConfinementError(
      abi < 1
        ? "Landlock is unsupported or disabled on this kernel"
        : `Landlock ABI ${abi} has no TCP rules; ABI ${REQUIRED_ABI} (Linux 6.7+) is required`,
    );
  }
  const notes: string[] = [];
  const dirRead = ACCESS_FS.READ_FILE | ACCESS_FS.READ_DIR;
  const fileRead = ACCESS_FS.READ_FILE;
  const fs: FsRule[] = [];
  // System: the interpreter's libraries, loader cache, certificates, timezone
  // data, and /sys for the cgroup limits the runtime sizes its heap by. Read
  // only: shared libraries are mapped from a plain open, which needs no EXECUTE.
  for (const d of ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/sys", "/opt", "/nix"]) {
    fs.push({ path: d, access: dirRead });
  }
  // /proc: the child's own entry and the system-wide files the runtime reads,
  // never another process's. /proc/<pid>/environ is already refused across a
  // Landlock domain (it is a ptrace check), but /proc/<pid>/cmdline is not:
  // every process in the PID namespace — the runner, the CLIs, a sibling run's
  // child, and on a desktop every process on the machine — would have its argv
  // readable. `/proc/self` and `/proc/thread-self` resolve under the child's
  // own entry, which this wrapper's pid is, because execv keeps the pid.
  fs.push({ path: `/proc/${input.pid}`, access: dirRead });
  for (const f of PROC_GLOBAL_FILES) fs.push({ path: `/proc/${f}`, access: fileRead });
  fs.push({ path: "/proc/sys", access: dirRead });
  // /dev: the character devices a runtime opens, by name. Never /dev itself,
  // which would admit /dev/shm — another process's shared memory, readable and
  // writable — and every other node a container or desktop mounts there.
  for (const d of DEV_NODES) {
    fs.push({ path: `/dev/${d}`, access: fileRead | ACCESS_FS.WRITE_FILE | ACCESS_FS.IOCTL_DEV });
  }
  // The two executables: the bun binary wherever it is installed (often under
  // $HOME/.bun, otherwise unreadable) and the dynamic loader its ELF header
  // names, both opened for execution by the kernel when this wrapper execs.
  fs.push({ path: bunExe, access: fileRead | ACCESS_FS.EXECUTE });
  const interpreter = input.interpreter === undefined ? elfInterpreter(bunExe) : input.interpreter;
  if (interpreter !== null) fs.push({ path: interpreter, access: fileRead | ACCESS_FS.EXECUTE });
  // The packages the child's code and its imports live in, then whatever the
  // host named for its own child extension, then the manifests above the
  // packages, file by file. Never the repo root itself, nor any directory
  // between it and the packages: that is where `.env` is.
  for (const d of [...stack.packages, ...stack.nodeModules]) fs.push({ path: d, access: dirRead });
  for (const d of input.readDirs ?? []) fs.push({ path: d, access: dirRead });
  for (const dir of stack.manifestDirs) {
    for (const f of MANIFEST_FILES) fs.push({ path: join(dir, f), access: fileRead });
  }

  const net: NetRule[] = [{ port: modulePort(moduleUrl), access: ACCESS_NET.CONNECT_TCP }];

  let scoped = 0n;
  if (abi >= SCOPE_ABI) scoped = SCOPE.ABSTRACT_UNIX_SOCKET | SCOPE.SIGNAL;
  else notes.push(`Landlock ABI ${abi}: no scoping (ABI ${SCOPE_ABI}, Linux 6.12+); the child may signal and reach abstract unix sockets outside its domain`);

  return {
    abi,
    handledFs: handledAccessFs(abi),
    handledNet: ACCESS_NET.BIND_TCP | ACCESS_NET.CONNECT_TCP,
    scoped,
    // struct landlock_ruleset_attr { __u64 handled_access_fs; __u64
    // handled_access_net (ABI 4); __u64 scoped (ABI 6); }: the kernel refuses
    // a struct longer than the one it knows, so the size follows the ABI.
    attrSize: abi >= SCOPE_ABI ? 24 : 16,
    fs: fs.filter((r) => exists(r.path)),
    net,
    sockets: { udp: moduleNeedsDns(moduleUrl) },
    limits: input.limits ?? { ...DEFAULT_SANDBOX_LIMITS },
    notes,
  };
}

function addRule(rulesetFd: number, type: number, attr: Buffer): number {
  return Number(libc().symbols.syscall(SYS_landlock_add_rule, rulesetFd, type, ptr(attr), 0));
}

/** Build the ruleset, add the rules, and restrict the calling thread. */
function restrict(plan: ConfinementPlan): void {
  for (const note of plan.notes) console.error(`[sandbox] ${note}`);
  const attr = new BigUint64Array([plan.handledFs, plan.handledNet, plan.scoped]);
  const rulesetFd = Number(libc().symbols.syscall(SYS_landlock_create_ruleset, ptr(attr), plan.attrSize, 0, 0));
  if (rulesetFd < 0) fail("landlock_create_ruleset");

  // The rights granted may only be ones the ruleset handles.
  const grantMask = plan.handledFs;
  for (const r of plan.fs) {
    const p = cstr(r.path);
    const fd = libc().symbols.open(ptr(p), O_PATH | O_CLOEXEC, 0);
    if (fd < 0) fail("open(O_PATH)", r.path);
    // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; } __attribute__((packed))
    const beneath = Buffer.alloc(12);
    beneath.writeBigUInt64LE(r.access & grantMask, 0);
    beneath.writeInt32LE(fd, 8);
    const rc = addRule(rulesetFd, LANDLOCK_RULE_PATH_BENEATH, beneath);
    const e = errno();
    libc().symbols.close(fd);
    if (rc !== 0) {
      // A file rule carrying directory-only rights is EINVAL; retry with the
      // file-applicable subset before giving up.
      const fileOnly = r.access & (ACCESS_FS.READ_FILE | ACCESS_FS.WRITE_FILE | ACCESS_FS.EXECUTE | ACCESS_FS.IOCTL_DEV) & grantMask;
      if (e === 22 && fileOnly !== r.access) {
        const fd2 = libc().symbols.open(ptr(p), O_PATH | O_CLOEXEC, 0);
        beneath.writeBigUInt64LE(fileOnly, 0);
        beneath.writeInt32LE(fd2, 8);
        const rc2 = addRule(rulesetFd, LANDLOCK_RULE_PATH_BENEATH, beneath);
        libc().symbols.close(fd2);
        if (rc2 === 0) continue;
      }
      fail("landlock_add_rule", r.path);
    }
  }

  for (const r of plan.net) {
    // struct landlock_net_port_attr { __u64 allowed_access; __u64 port; }
    const portAttr = Buffer.alloc(16);
    portAttr.writeBigUInt64LE(r.access & plan.handledNet, 0);
    portAttr.writeBigUInt64LE(BigInt(r.port), 8);
    if (addRule(rulesetFd, LANDLOCK_RULE_NET_PORT, portAttr) !== 0) fail("landlock_add_rule(net)", `port ${r.port}`);
  }

  if (libc().symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) fail("prctl(PR_SET_NO_NEW_PRIVS)");
  if (Number(libc().symbols.syscall(SYS_landlock_restrict_self, rulesetFd, 0, 0, 0)) !== 0) fail("landlock_restrict_self");
  libc().symbols.close(rulesetFd);
}

/**
 * Install the socket filter on the calling thread. Like the Landlock domain
 * it is the thread's, and the exec makes this thread the whole process.
 * Needs `PR_SET_NO_NEW_PRIVS`, which `restrict` has set.
 */
function filterSockets(program: readonly SockFilter[]): void {
  // struct sock_filter { __u16 code; __u8 jt; __u8 jf; __u32 k; }
  const filter = Buffer.alloc(program.length * 8);
  program.forEach((op, i) => {
    filter.writeUInt16LE(op.code, i * 8);
    filter.writeUInt8(op.jt, i * 8 + 2);
    filter.writeUInt8(op.jf, i * 8 + 3);
    filter.writeUInt32LE(op.k, i * 8 + 4);
  });
  // struct sock_fprog { unsigned short len; struct sock_filter *filter; }
  const fprog = Buffer.alloc(16);
  fprog.writeUInt16LE(program.length, 0);
  fprog.writeBigUInt64LE(BigInt(ptr(filter)), 8);
  if (libc().symbols.prctl(PR_SET_SECCOMP, BigInt(SECCOMP_MODE_FILTER), BigInt(ptr(fprog)), 0n, 0n) !== 0) fail("prctl(PR_SET_SECCOMP)");
}

/**
 * Set the child's resource limits, last before the exec: the address-space
 * cap is below what this wrapper's own runtime has reserved, so it applies to
 * the image the exec starts, not to anything this process still allocates.
 * Each is set as soft and hard alike, never above an inherited hard limit.
 */
function applyLimits(limits: SandboxLimits): void {
  const rl = new BigUint64Array(2);
  for (const { resource, value } of rlimitPlan(limits)) {
    if (value === null) continue;
    if (libc().symbols.getrlimit(resource, ptr(rl)) !== 0) fail("getrlimit", `resource ${resource}`);
    const hard = rl[1]!;
    const want = BigInt(value);
    const v = hard !== RLIM_INFINITY && hard < want ? hard : want;
    rl[0] = v;
    rl[1] = v;
    if (libc().symbols.setrlimit(resource, ptr(rl)) !== 0) fail("setrlimit", `resource ${resource} to ${v}`);
  }
}

function execv(argv: readonly string[]): never {
  const bufs = argv.map(cstr);
  const vec = new BigUint64Array(bufs.length + 1);
  bufs.forEach((b, i) => {
    vec[i] = BigInt(ptr(b));
  });
  vec[bufs.length] = 0n;
  libc().symbols.execv(ptr(bufs[0]!), ptr(vec));
  fail("execv", argv[0]);
}

if (import.meta.main) {
  // Leading `--read=<dir>` and `--limit-*=` flags are this wrapper's;
  // everything after them is the child's argv (bun swallows a `--`), which
  // the child sees unchanged. A limit not named keeps its default.
  const args = process.argv.slice(2);
  const readDirs: string[] = [];
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS };
  const LIMIT_FLAGS = { "--limit-as": "addressSpaceBytes", "--limit-cpu": "cpuSeconds", "--limit-fsize": "fileBytes" } as const;
  for (;;) {
    const a = args[0];
    if (a?.startsWith("--read=") === true) {
      readDirs.push(resolve(args.shift()!.slice("--read=".length)));
      continue;
    }
    const m = a === undefined ? null : /^(--limit-(?:as|cpu|fsize))=(.*)$/.exec(a);
    if (m === null) break;
    args.shift();
    try {
      limits[LIMIT_FLAGS[m[1] as keyof typeof LIMIT_FLAGS]] = parseLimit(m[1]!, m[2]!);
    } catch (err) {
      fail("reading the limits", err instanceof Error ? err.message : String(err));
    }
  }
  const childArgv = args;
  if (childArgv.length === 0) {
    console.error("usage: bun confine.ts [--read=<dir>]... [--limit-<as|cpu|fsize>=<n|unlimited>]... <argv of the child to exec>");
    process.exit(64);
  }
  // Relative interpreters resolve through PATH the way the shell would; the
  // exec'd image is `process.execPath` when the child is `bun`, so the same
  // binary that runs the host runs the child.
  const exe = childArgv[0] === "bun" ? process.execPath : (Bun.which(childArgv[0]!) ?? childArgv[0]!);
  // The same variable, same default, that the child reads for its client, so
  // the port the kernel allows is the port the SDK dials. The host sets it
  // explicitly and spawns this wrapper with `--env-file=/dev/null`, so it is
  // the host's value and never an autoloaded `.env`'s.
  const moduleUrl = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
  let plan: ConfinementPlan;
  let program: SockFilter[];
  try {
    const stack = stackReadPaths(import.meta.dir);
    plan = confinementPlan({ stack, bunExe: exe, moduleUrl, abi: landlockAbi(), pid: process.pid, readDirs, limits });
    program = seccompProgram(seccompArch(), plan.sockets);
  } catch (err) {
    fail("planning the ruleset", err instanceof Error ? err.message : String(err));
  }
  restrict(plan);
  filterSockets(program);
  applyLimits(plan.limits);
  execv([exe, ...childArgv.slice(1)]);
}
