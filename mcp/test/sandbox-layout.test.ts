/**
 * Where the confined child may read, wherever the stack is installed: at a
 * repository's root (`<root>/{mcp,sdk}`, as in this monorepo) or one level
 * down in a consumer's checkout (`<root>/wrath-mcp/{mcp,sdk}`, with
 * `node_modules` hoisted at `<root>` and an intermediate `tsconfig.base.json`
 * the packages' own tsconfigs extend). `stackReadPaths` resolves the read list
 * from the install rather than counting directories, and the last test runs a
 * real confined child out of a copied tree in the nested shape, so the kernel,
 * not the plan, says whether a snippet can load the SDK and zod there.
 *
 * The trees are real copies, never symlinks to this checkout: resolution and
 * `import.meta` follow symlinks to their targets, so a linked tree would
 * quietly resolve back here and prove nothing.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { API_MD_PATH } from "@wrathbench/sdk";
import { ACCESS_FS, confinementPlan, MANIFEST_FILES, stackReadPaths } from "../src/sandbox/confine";

const MCP_DIR = resolve(import.meta.dir, "..");
const SDK_DIR = dirname(API_MD_PATH);
const ZOD_DIR = dirname(Bun.resolveSync("zod/package.json", SDK_DIR));
const ZOD_VERSION = (JSON.parse(readFileSync(join(ZOD_DIR, "package.json"), "utf8")) as { version: string }).version;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrathbench-mcp-layout-")));
  dirs.push(dir);
  return dir;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A relative symlink at `link` to `target`, as Bun's installer lays them. */
function link(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), target), link);
}

interface TreeOptions {
  /** Where the stack sits under the root: "" for the root itself, "wrath-mcp" for a submodule. */
  stackDir: string;
  /** Bun's isolated linker (this repository's: `node_modules/.bun` plus per-workspace links) or a flat hoisted one. */
  linker: "isolated" | "hoisted";
  /** Copy the real zod, for a child that runs; otherwise a stub that only resolves. */
  realZod: boolean;
}

/** A consumer checkout with the stack's two packages copied in and installed by hand. */
function buildTree(opts: TreeOptions): { root: string; stack: string } {
  const root = tempRoot();
  const stack = join(root, opts.stackDir);
  const workspaces = opts.stackDir === "" ? ["sdk", "mcp"] : [`${opts.stackDir}/sdk`, `${opts.stackDir}/mcp`];
  write(join(root, "package.json"), JSON.stringify({ name: "consumer", private: true, workspaces }));
  write(join(root, "bunfig.toml"), "");
  write(join(root, "tsconfig.base.json"), readFileSync(join(MCP_DIR, "..", "tsconfig.base.json"), "utf8"));
  write(join(root, ".env"), "SECRET=must-not-be-read\n");
  write(join(root, "LICENSE"), "not the child's\n");
  if (opts.stackDir !== "") {
    write(join(stack, "package.json"), JSON.stringify({ name: "wrath-mcp", private: true, workspaces: ["sdk", "mcp"] }));
    write(join(stack, "tsconfig.base.json"), readFileSync(join(MCP_DIR, "..", "tsconfig.base.json"), "utf8"));
    write(join(stack, "README.md"), "the submodule's root, not the child's\n");
  }
  for (const [from, to, files] of [
    [SDK_DIR, "sdk", ["package.json", "tsconfig.json", "API.md", "src"]],
    [MCP_DIR, "mcp", ["package.json", "tsconfig.json", "src"]],
  ] as const) {
    for (const f of files) cpSync(join(from, f), join(stack, to, f), { recursive: true });
  }

  const zodStore = opts.linker === "isolated" ? join(root, "node_modules", ".bun", `zod@${ZOD_VERSION}`, "node_modules", "zod") : join(root, "node_modules", "zod");
  if (opts.realZod) {
    cpSync(ZOD_DIR, zodStore, { recursive: true, dereference: true });
  } else {
    write(join(zodStore, "package.json"), JSON.stringify({ name: "zod", version: ZOD_VERSION, main: "index.js" }));
    write(join(zodStore, "index.js"), "export const z = {};\n");
  }
  for (const pkg of ["sdk", "mcp"]) link(join(root, "node_modules", "@wrathbench", pkg), join(stack, pkg));
  if (opts.linker === "isolated") {
    for (const pkg of ["sdk", "mcp"]) link(join(stack, pkg, "node_modules", "zod"), zodStore);
    link(join(stack, "mcp", "node_modules", "@wrathbench", "sdk"), join(stack, "sdk"));
  }
  return { root, stack };
}

/** The read rules the plan builds for a stack, as paths, filtered by what exists on disk. */
function readPaths(stack: ReturnType<typeof stackReadPaths>): string[] {
  const p = confinementPlan({ stack, bunExe: process.execPath, moduleUrl: "http://worldserver:8086", abi: 6, pid: process.pid, interpreter: null });
  return p.fs.filter((r) => (r.access & ACCESS_FS.EXECUTE) === 0n).map((r) => r.path);
}

describe("stackReadPaths", () => {
  for (const linker of ["isolated", "hoisted"] as const) {
    test(`stack at the root (${linker}): the two packages, the root node_modules and the root's manifests — the monorepo's rules`, () => {
      const { root } = buildTree({ stackDir: "", linker, realZod: false });
      const found = stackReadPaths(join(root, "mcp", "src", "sandbox"));
      expect(found).toEqual({ packages: [join(root, "mcp"), join(root, "sdk")], nodeModules: [join(root, "node_modules")], manifestDirs: [root] });
      const under = readPaths(found).filter((p) => p.startsWith(`${root}/`) || p === root);
      // What the old three-directories-up derivation granted, path for path.
      expect(under).toEqual([
        `${root}/mcp`,
        `${root}/sdk`,
        `${root}/node_modules`,
        `${root}/package.json`,
        `${root}/tsconfig.base.json`,
        `${root}/bunfig.toml`,
      ]);
    });

    test(`stack in a submodule (${linker}): the packages where they are, node_modules at the consumer's root, manifests at both levels`, () => {
      const { root, stack } = buildTree({ stackDir: "wrath-mcp", linker, realZod: false });
      const found = stackReadPaths(join(stack, "mcp", "src", "sandbox"));
      expect(found).toEqual({
        packages: [join(stack, "mcp"), join(stack, "sdk")],
        nodeModules: [join(root, "node_modules")],
        manifestDirs: [stack, root],
      });
      const under = readPaths(found).filter((p) => p.startsWith(`${root}/`) || p === root);
      expect(under).toEqual([
        `${stack}/mcp`,
        `${stack}/sdk`,
        `${root}/node_modules`,
        `${stack}/package.json`,
        `${stack}/tsconfig.base.json`,
        `${root}/package.json`,
        `${root}/tsconfig.base.json`,
        `${root}/bunfig.toml`,
      ]);
      // Neither root is a directory rule: their other files stay out.
      expect(under).not.toContain(root);
      expect(under).not.toContain(stack);
    });
  }

  test("this checkout: the packages this file's own resolve to, and the manifests up to the install root", () => {
    const found = stackReadPaths(join(MCP_DIR, "src", "sandbox"));
    expect(found.packages).toEqual([MCP_DIR, SDK_DIR]);
    expect(found.nodeModules).toHaveLength(1);
    const installRoot = dirname(found.nodeModules[0]!);
    expect(MCP_DIR.startsWith(`${installRoot}/`)).toBe(true);
    const chain: string[] = [];
    for (let d = dirname(MCP_DIR); ; d = dirname(d)) {
      chain.push(d);
      if (d === installRoot) break;
    }
    expect(found.manifestDirs).toEqual(chain);
    // The file the snippets are pointed at is inside what the child may read.
    expect(found.packages.some((p) => API_MD_PATH.startsWith(`${p}/`))).toBe(true);
    for (const f of MANIFEST_FILES) expect(f).not.toContain("/");
  });

  test("a dependency that does not resolve is a refusal, not a narrower ruleset", () => {
    const { stack } = buildTree({ stackDir: "wrath-mcp", linker: "hoisted", realZod: false });
    rmSync(join(dirname(stack), "node_modules", "zod"), { recursive: true });
    expect(() => stackReadPaths(join(stack, "mcp", "src", "sandbox"))).toThrow(/zod does not resolve/);
  });
});

describe("a confined child in the submodule layout", () => {
  type Host = { evalSnippet(code: string): Promise<{ ok: boolean; value?: string }>; start(): Promise<void>; stop(): Promise<void> };
  const hosts: Host[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.stop()));
  });

  test("imports the SDK and zod, reads API.md, and is refused both roots", async () => {
    const { root, stack } = buildTree({ stackDir: "wrath-mcp", linker: "isolated", realZod: true });
    // The copied package's own host: its confine.ts and entry.ts are the tree's,
    // so the ruleset is the one the nested layout resolves to.
    const mcp = (await import(join(stack, "mcp", "src", "index.ts"))) as {
      SandboxHost: new (opts: object) => Host;
      Scratchpad: new (path: string) => unknown;
    };
    const host = new mcp.SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      scratchpad: new mcp.Scratchpad(join(tempRoot(), "scratchpad.md")),
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
      logSink: () => {},
    });
    hosts.push(host);
    // The fleet runs the child from the consumer's root, whose manifests Bun
    // reads at startup; the spawn inherits the cwd synchronously in start().
    const cwd = process.cwd();
    process.chdir(root);
    let started: Promise<void>;
    try {
      started = host.start();
    } finally {
      process.chdir(cwd);
    }
    await started;

    const readCode = (path: string): string =>
      `try { (await import("node:fs")).readFileSync(${JSON.stringify(path)}, "utf8"); return "READ"; } catch (e) { return e.code ?? String(e); }`;
    // Positive controls: the child came up on the tree's SDK (which imports
    // zod), zod itself imports, and API_MD_PATH is the tree's and readable.
    expect((await host.evalSnippet("typeof sdk.createSession")).value).toBe('"function"');
    expect((await host.evalSnippet('typeof (await import("zod")).z.object')).value).toBe('"function"');
    expect((await host.evalSnippet("API_MD_PATH")).value).toBe(JSON.stringify(join(stack, "sdk", "API.md")));
    expect((await host.evalSnippet(readCode(join(stack, "sdk", "API.md")))).value).toBe('"READ"');
    expect((await host.evalSnippet(readCode(join(root, "package.json")))).value).toBe('"READ"');
    // Neither root is readable beyond its manifests.
    expect((await host.evalSnippet(readCode(join(root, ".env")))).value).toBe('"EACCES"');
    expect((await host.evalSnippet(readCode(join(root, "LICENSE")))).value).toBe('"EACCES"');
    expect((await host.evalSnippet(readCode(join(stack, "README.md")))).value).toBe('"EACCES"');
  });
});
