/**
 * Filesystem confinement for the sandbox child (FOLLOW-UPS 19, part 3).
 *
 * The host spawns THIS file, not `entry.ts`:
 *
 *   bun confine.ts <bun argv for the child>
 *
 * It builds a Linux Landlock ruleset that allows reads only where the child
 * legitimately needs them (the Bun binary and system libraries, `runner/`,
 * `sdk/`, `node_modules/`, the workspace manifests), applies it to itself and
 * then `execv`s the real child in place. Landlock is inherited across exec and
 * cannot be lifted by the restricted process, so a snippet doing
 * `readFileSync("/home/.../wrathbench/.env")` — or `../../.env`, or anything
 * else outside the allowlist — gets `EACCES` from the kernel, whatever module
 * it reaches for (`node:fs`, `Bun.file`, a child `cat`, …). That is the
 * property the in-process fetch/WebSocket guard in entry.ts never had.
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
 * the kernel (5.13+), needs no privileges, no extra binaries, no namespace
 * support in the container's seccomp profile — only the three `landlock_*`
 * syscalls — and it fails closed: if the kernel or the container refuses it,
 * this wrapper exits without exec'ing the child rather than running it
 * unconfined. There is deliberately no opt-out knob.
 *
 * Only the filesystem is handled. The Landlock network bits (ABI 4+) are left
 * out of the ruleset so the module's TCP port is reached exactly as before;
 * the network posture stays what entry.ts documents.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dlopen, FFIType, ptr, read } from "bun:ffi";

// Linux ABI constants (include/uapi/linux/landlock.h, unified syscall table).
const SYS_landlock_create_ruleset = 444;
const SYS_landlock_add_rule = 445;
const SYS_landlock_restrict_self = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;

const ACCESS_FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  IOCTL_DEV: 1n << 15n, // ABI 5
} as const;

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

function fail(step: string, detail?: string): never {
  const e = errno();
  console.error(
    `[sandbox] filesystem confinement failed at ${step}${detail ? ` (${detail})` : ""}` +
      `${e ? `: errno ${e}` : ""} — refusing to start the snippet child unconfined. ` +
      `Landlock (Linux 5.13+, syscalls 444-446) must be available to this process; ` +
      `if this is a container, its seccomp profile must permit them.`,
  );
  process.exit(78); // EX_CONFIG
}

interface Rule {
  path: string;
  access: bigint;
}

/**
 * What the child may read. Directories get read+execute (execute so the
 * dynamic loader and `bun` itself can be mapped), files get read only.
 * Missing paths are skipped — a rule needs an inode to hang on.
 */
export function confinementRules(repoRoot: string, bunExe: string): Rule[] {
  const dirRead = ACCESS_FS.READ_FILE | ACCESS_FS.READ_DIR | ACCESS_FS.EXECUTE;
  const fileRead = ACCESS_FS.READ_FILE;
  const rules: Rule[] = [];
  // System: the interpreter, its libraries, loader cache, certificates,
  // timezone data, /proc and /sys for what the runtime introspects.
  for (const d of ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/sys", "/opt", "/nix"]) {
    rules.push({ path: d, access: dirRead });
  }
  // /dev: null, urandom, tty. Read+write, never create.
  rules.push({ path: "/dev", access: dirRead | ACCESS_FS.WRITE_FILE | ACCESS_FS.IOCTL_DEV });
  // The bun binary wherever it is installed (often under $HOME/.bun, which is
  // otherwise not readable).
  rules.push({ path: bunExe, access: fileRead | ACCESS_FS.EXECUTE });
  // The workspaces the child's code and its imports live in. Never the repo
  // root itself: that is where `.env` is.
  for (const d of ["runner", "sdk", "node_modules"]) rules.push({ path: join(repoRoot, d), access: dirRead });
  for (const f of ["package.json", "tsconfig.json", "tsconfig.base.json", "bunfig.toml"]) {
    rules.push({ path: join(repoRoot, f), access: fileRead });
  }
  return rules.filter((r) => existsSync(r.path));
}

/** Build the ruleset, add the rules, and restrict the calling thread. */
function restrict(rules: readonly Rule[]): void {
  const abiRaw = libc.symbols.syscall(SYS_landlock_create_ruleset, 0, 0, LANDLOCK_CREATE_RULESET_VERSION, 0);
  const abi = Number(abiRaw);
  if (abi < 1) fail("landlock_create_ruleset(VERSION)", "Landlock unsupported or disabled");
  const handled = handledAccessFs(abi);
  // The rights granted may only be ones the ruleset handles.
  const grantMask = handled;

  // struct landlock_ruleset_attr { __u64 handled_access_fs; ... }: the kernel
  // zero-fills fields past the size we pass, so 8 bytes is valid on every ABI.
  const attr = new BigUint64Array([handled]);
  const rulesetFd = Number(libc.symbols.syscall(SYS_landlock_create_ruleset, ptr(attr), 8, 0, 0));
  if (rulesetFd < 0) fail("landlock_create_ruleset");

  for (const r of rules) {
    const p = cstr(r.path);
    const fd = libc.symbols.open(ptr(p), O_PATH | O_CLOEXEC, 0);
    if (fd < 0) fail("open(O_PATH)", r.path);
    // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; } __attribute__((packed))
    const beneath = Buffer.alloc(12);
    beneath.writeBigUInt64LE(r.access & grantMask, 0);
    beneath.writeInt32LE(fd, 8);
    const rc = Number(libc.symbols.syscall(SYS_landlock_add_rule, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, ptr(beneath), 0));
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
        const rc2 = Number(libc.symbols.syscall(SYS_landlock_add_rule, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, ptr(beneath), 0));
        libc.symbols.close(fd2);
        if (rc2 === 0) continue;
      }
      fail("landlock_add_rule", r.path);
    }
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
  restrict(confinementRules(repoRoot, exe));
  execv([exe, ...childArgv.slice(1)]);
}
