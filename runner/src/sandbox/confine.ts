/**
 * Confinement for the sandbox child: filesystem, TCP, exec and process scope.
 *
 * The host spawns THIS file, not `entry.ts`:
 *
 *   bun confine.ts <bun argv for the child>
 *
 * It builds a Linux Landlock ruleset, applies it to itself and then `execv`s
 * the real child in place. Landlock is inherited across exec and cannot be
 * lifted by the restricted process, so whatever a snippet reaches for —
 * `node:fs`, `node:net`, `Bun.connect`, `Bun.spawn`, a re-exec'd `bun` — the
 * kernel answers, not a JavaScript shim. The ruleset (`confinementPlan`):
 *
 *  - Filesystem: reads only where the child legitimately needs them (the Bun
 *    binary and system libraries, `runner/`, `sdk/`, `node_modules/`, the
 *    workspace manifests). `.env`, the repo root, `$HOME` and `/tmp` are
 *    `EACCES` by any path.
 *  - Exec: `LANDLOCK_ACCESS_FS_EXECUTE` is granted on exactly two files, the
 *    Bun binary and its ELF interpreter, because the kernel checks both when
 *    this wrapper execs the child. Nothing else in the sandbox spawns or needs
 *    to (entry.ts and the SDK fork nothing; Bun's workers are threads), so
 *    `/bin/sh`, `curl` and every other binary are `EACCES` at `posix_spawn`.
 *    Re-running `bun` itself stays possible and gains nothing: the new process
 *    is in the same Landlock domain with the same environment.
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
 * What Landlock does not cover and this wrapper therefore does not claim:
 * UDP (DNS resolution is the legitimate user), raw and non-IP socket families,
 * and which hosts the allowed port is reached on. Those are the network
 * policy's job.
 *
 * Fail closed, no knob: without Landlock at all, or with an ABI below 4 (no
 * TCP rules), this wrapper exits instead of exec'ing the child, so a snippet
 * never runs with the filesystem or the network open. Scoping is applied when
 * the kernel has it and announced on stderr when it does not — the fleet's
 * kernel has it; the kernels without it that run this code are CI's.
 *
 * Why a wrapper and not a call inside entry.ts: `landlock_restrict_self`
 * restricts the calling *thread*, and Bun starts its GC and I/O threads before
 * any user code runs, so a restriction applied from inside the child would
 * leave the thread pool unconfined. `execve` replaces the whole process with
 * the calling thread's image, restriction included, so restricting here and
 * then exec'ing is complete. The IPC channel and stdio are plain inherited
 * file descriptors and survive the exec unchanged.
 *
 * Why Landlock and not bubblewrap / user namespaces / a uid switch: it is in
 * the kernel, needs no privileges, no extra binaries, no namespace support in
 * the container's seccomp profile — only the three `landlock_*` syscalls.
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const libc = dlopen("libc.so.6", {
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
  open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  execv: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
});

function errno(): number {
  const p = libc.symbols.__errno_location();
  return p === null ? 0 : read.i32(p, 0);
}

function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf8");
}

/** The running kernel's Landlock ABI; 0 when Landlock is unsupported or disabled. */
export function landlockAbi(): number {
  const abi = Number(libc.symbols.syscall(SYS_landlock_create_ruleset, 0, 0, LANDLOCK_CREATE_RULESET_VERSION, 0));
  return abi < 1 ? 0 : abi;
}

function fail(step: string, detail?: string): never {
  const e = errno();
  console.error(
    `[sandbox] confinement failed at ${step}${detail ? ` (${detail})` : ""}` +
      `${e ? `: errno ${e}` : ""} — refusing to start the snippet child unconfined. ` +
      `Landlock ABI ${REQUIRED_ABI} or newer (Linux 6.7+, syscalls 444-446) must be available to this process; ` +
      `if this is a container, its seccomp profile must permit them.`,
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

export interface PlanInput {
  repoRoot: string;
  bunExe: string;
  moduleUrl: string;
  abi: number;
  /** Override for tests; defaults to reading `bunExe`'s ELF header. */
  interpreter?: string | null;
  /** Override for tests; defaults to `existsSync`. */
  exists?: (path: string) => boolean;
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
  const { repoRoot, bunExe, moduleUrl, abi } = input;
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
  // data, /proc and /sys for what the runtime introspects. Read only: shared
  // libraries are mapped from a plain open, which needs no EXECUTE.
  for (const d of ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/sys", "/opt", "/nix"]) {
    fs.push({ path: d, access: dirRead });
  }
  // /dev: null, urandom, tty. Read+write, never create.
  fs.push({ path: "/dev", access: dirRead | ACCESS_FS.WRITE_FILE | ACCESS_FS.IOCTL_DEV });
  // The two executables: the bun binary wherever it is installed (often under
  // $HOME/.bun, otherwise unreadable) and the dynamic loader its ELF header
  // names, both opened for execution by the kernel when this wrapper execs.
  fs.push({ path: bunExe, access: fileRead | ACCESS_FS.EXECUTE });
  const interpreter = input.interpreter === undefined ? elfInterpreter(bunExe) : input.interpreter;
  if (interpreter !== null) fs.push({ path: interpreter, access: fileRead | ACCESS_FS.EXECUTE });
  // The workspaces the child's code and its imports live in. Never the repo
  // root itself: that is where `.env` is.
  for (const d of ["runner", "sdk", "node_modules"]) fs.push({ path: join(repoRoot, d), access: dirRead });
  for (const f of ["package.json", "tsconfig.json", "tsconfig.base.json", "bunfig.toml"]) {
    fs.push({ path: join(repoRoot, f), access: fileRead });
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
    notes,
  };
}

function addRule(rulesetFd: number, type: number, attr: Buffer): number {
  return Number(libc.symbols.syscall(SYS_landlock_add_rule, rulesetFd, type, ptr(attr), 0));
}

/** Build the ruleset, add the rules, and restrict the calling thread. */
function restrict(plan: ConfinementPlan): void {
  for (const note of plan.notes) console.error(`[sandbox] ${note}`);
  const attr = new BigUint64Array([plan.handledFs, plan.handledNet, plan.scoped]);
  const rulesetFd = Number(libc.symbols.syscall(SYS_landlock_create_ruleset, ptr(attr), plan.attrSize, 0, 0));
  if (rulesetFd < 0) fail("landlock_create_ruleset");

  // The rights granted may only be ones the ruleset handles.
  const grantMask = plan.handledFs;
  for (const r of plan.fs) {
    const p = cstr(r.path);
    const fd = libc.symbols.open(ptr(p), O_PATH | O_CLOEXEC, 0);
    if (fd < 0) fail("open(O_PATH)", r.path);
    // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; } __attribute__((packed))
    const beneath = Buffer.alloc(12);
    beneath.writeBigUInt64LE(r.access & grantMask, 0);
    beneath.writeInt32LE(fd, 8);
    const rc = addRule(rulesetFd, LANDLOCK_RULE_PATH_BENEATH, beneath);
    const e = errno();
    libc.symbols.close(fd);
    if (rc !== 0) {
      // A file rule carrying directory-only rights is EINVAL; retry with the
      // file-applicable subset before giving up.
      const fileOnly = r.access & (ACCESS_FS.READ_FILE | ACCESS_FS.WRITE_FILE | ACCESS_FS.EXECUTE | ACCESS_FS.IOCTL_DEV) & grantMask;
      if (e === 22 && fileOnly !== r.access) {
        const fd2 = libc.symbols.open(ptr(p), O_PATH | O_CLOEXEC, 0);
        beneath.writeBigUInt64LE(fileOnly, 0);
        beneath.writeInt32LE(fd2, 8);
        const rc2 = addRule(rulesetFd, LANDLOCK_RULE_PATH_BENEATH, beneath);
        libc.symbols.close(fd2);
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

  if (libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) fail("prctl(PR_SET_NO_NEW_PRIVS)");
  if (Number(libc.symbols.syscall(SYS_landlock_restrict_self, rulesetFd, 0, 0, 0)) !== 0) fail("landlock_restrict_self");
  libc.symbols.close(rulesetFd);
}

function execv(argv: readonly string[]): never {
  const bufs = argv.map(cstr);
  const vec = new BigUint64Array(bufs.length + 1);
  bufs.forEach((b, i) => {
    vec[i] = BigInt(ptr(b));
  });
  vec[bufs.length] = 0n;
  libc.symbols.execv(ptr(bufs[0]!), ptr(vec));
  fail("execv", argv[0]);
}

if (import.meta.main) {
  // Everything after this file is the child's argv (bun swallows a `--`).
  const childArgv = process.argv.slice(2);
  if (childArgv.length === 0) {
    console.error("usage: bun confine.ts <argv of the child to exec>");
    process.exit(64);
  }
  // Relative interpreters resolve through PATH the way the shell would; the
  // exec'd image is `process.execPath` when the child is `bun`, so the same
  // binary that runs the host runs the child.
  const exe = childArgv[0] === "bun" ? process.execPath : (Bun.which(childArgv[0]!) ?? childArgv[0]!);
  const repoRoot = resolve(dirname(import.meta.path), "..", "..", "..");
  // The same variable, same default, that entry.ts reads for its client, so
  // the port the kernel allows is the port the SDK dials. The host sets it
  // explicitly and spawns this wrapper with `--env-file=/dev/null`, so it is
  // the host's value and never an autoloaded `.env`'s.
  const moduleUrl = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
  let plan: ConfinementPlan;
  try {
    plan = confinementPlan({ repoRoot, bunExe: exe, moduleUrl, abi: landlockAbi() });
  } catch (err) {
    fail("planning the ruleset", err instanceof Error ? err.message : String(err));
  }
  restrict(plan);
  execv([exe, ...childArgv.slice(1)]);
}
