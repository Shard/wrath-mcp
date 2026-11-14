#!/usr/bin/env bun
/**
 * The stack boundary, inside half: module/, sdk/, mcp/ and inspector/ are
 * meant to bolt onto a stock AzerothCore and into any harness, so they depend
 * on nothing but themselves and what they declare. This check keeps that true
 * as the code changes:
 *
 *  - A TypeScript file in sdk/, mcp/ or inspector/ imports only its own
 *    package (by relative path), Bun and Node built-ins, and the dependencies
 *    its package.json declares, at a subpath that dependency exports. sdk/
 *    declares no stack dependency, so it can never import mcp/; mcp/ reaches
 *    the SDK through `@wrathbench/sdk` alone, at an exported entry point.
 *  - The inspector reads records and nothing else: from the stack it imports
 *    `@wrathbench/mcp/record/read` (the store reader and the format's types)
 *    and `@wrathbench/mcp/hosted/grants-read` (the hosted grants, to sign a
 *    person in with their key) and no other entry point, and never the SDK,
 *    so it can never reach a module, a sandbox or a writer. sdk/ and mcp/
 *    never import it. In substance as well as by name: no module those
 *    entries load, followed through every import, and no source of the
 *    inspector's own calls a filesystem function that writes or deletes.
 *  - The UI's dependency graph (Solid, Vite and their kin) is declared by
 *    inspector/ alone; sdk/ and mcp/ never take one on.
 *  - The inspector's browser-side files (`src/wire.ts`, `src/codec/`,
 *    `src/views/`, and the bin's page in `page/`) import no runtime built-in
 *    and nothing of the inspector's server side, because a browser bundles
 *    them.
 *  - The C++ module's quoted includes name a header by its bare file name —
 *    its own or the core's — never a path out of module/.
 *
 * The outside half (a consumer reaches sdk/ and mcp/ through package names and
 * exported entry points only) belongs to each consumer; WrathBench runs its own.
 *
 * Run: `bun run boundary` (exit 1 and one line per violation);
 * `scripts/boundary.test.ts` runs it as part of `bun test`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

export const STACK_PACKAGES = ["sdk", "mcp", "inspector"] as const;

/** The only entry points of the stack the inspector may import: the read sides of the session record and of the hosted grants. */
export const INSPECTOR_STACK_IMPORTS: ReadonlySet<string> = new Set(["@wrathbench/mcp/record/read", "@wrathbench/mcp/hosted/grants-read"]);

/** The UI's dependencies: declared by inspector/ and by no other stack package. */
export const UI_DEPENDENCIES = ["solid-js", "@solidjs/router", "vite", "vite-plugin-solid", "happy-dom"] as const;

/** The inspector's files a browser bundles, relative to inspector/: a file, or a directory with a trailing slash. */
export const INSPECTOR_BROWSER = ["src/wire.ts", "src/codec/", "src/views/", "page/"] as const;

function isBrowserFile(relToInspector: string): boolean {
  const p = relToInspector.split(sep).join("/");
  return INSPECTOR_BROWSER.some((b) => (b.endsWith("/") ? p.startsWith(b) : p === b));
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, string>;
}

const SKIP_DIRS = new Set(["node_modules", "dist"]);

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

const BUILTINS = new Set(builtinModules);

function isBuiltin(spec: string): boolean {
  return spec === "bun" || spec.startsWith("bun:") || spec.startsWith("node:") || BUILTINS.has(spec);
}

/** `@scope/name/sub` → [`@scope/name`, `./sub`]; `name/sub` → [`name`, `./sub`]. */
function splitPackage(spec: string): [string, string] {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, n).join("/");
  const sub = parts.slice(n).join("/");
  return [name, sub.length === 0 ? "." : `./${sub}`];
}

/**
 * `code` with its comments blanked and its string and template literals kept,
 * so a specifier still reads as one and a commented-out import does not.
 */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The specifiers of the type-only forms Bun's scanner drops, since a
 * transpiler erases them: `import type …`, `import { type X } …`,
 * `export type … from`, and `import("…")` in a type position. Read from the
 * text with comments blanked; a statement's specifier is the first string
 * after its `from`, so a string elsewhere in the code is not one.
 */
export function typeOnlyImports(code: string): string[] {
  const text = stripComments(code);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(?:type\s+)?[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/g)) out.push(m[2]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g)) out.push(m[2]!);
  return out;
}

/**
 * Every module specifier a TypeScript file imports: Bun's own scanner for
 * what runs (strings and comments are not imports), and `typeOnlyImports` for
 * what only the compiler sees — a type import across the boundary binds the
 * two packages as surely as a value import.
 */
export function importsOf(file: string): string[] {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const scanner = new Bun.Transpiler({ loader });
  // The scanner refuses a shebang line; it is a comment to everything else.
  const code = readFileSync(file, "utf8").replace(/^#!.*/, "");
  // A TSX file's scan also names the JSX runtime the transpiler would import
  // (React's, whatever the file says); only what the text itself names counts.
  const named = (spec: string): boolean => loader !== "tsx" || code.includes(`"${spec}"`) || code.includes(`'${spec}'`);
  return [...new Set([...scanner.scanImports(code).map((i) => i.path).filter(named), ...typeOnlyImports(code)])];
}

/** The filesystem functions that write, move or delete, in `node:fs` and `node:fs/promises` alike. */
export const FS_WRITES: ReadonlySet<string> = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "createWriteStream", "link", "linkSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rename", "renameSync",
  "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync",
  "utimes", "utimesSync", "write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync",
]);

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;

/**
 * What in a file's code writes or deletes a file: a write function named in
 * an import from `node:fs` (or `fs/promises`), one reached through a default
 * or namespace import of it, and `Bun.write`. Read from the text with
 * comments blanked.
 */
export function fsWritesOf(code: string): string[] {
  const text = stripComments(code);
  const out = new Set<string>();
  for (const m of text.matchAll(/\bimport\s+([^;'"`]*?)\s+from\s*(["'])([^"'\n]+)\2/g)) {
    if (!FS_MODULE.test(m[3]!)) continue;
    const clause = m[1]!;
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of named?.[1]?.split(",") ?? []) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
      if (FS_WRITES.has(name)) out.add(name);
    }
    const whole = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+/, "").split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
    for (const ns of whole) {
      for (const use of text.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z]+)\\b`, "g"))) if (FS_WRITES.has(use[1]!)) out.add(`${ns}.${use[1]}`);
    }
  }
  if (/\bBun\s*\.\s*write\b/.test(text)) out.add("Bun.write");
  return [...out];
}

/** A package's relative value imports, followed from `entry` to every module they load. */
function valueClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    const code = readFileSync(file, "utf8").replace(/^#!.*/, "");
    for (const i of new Bun.Transpiler({ loader }).scanImports(code)) {
      if (!i.path.startsWith(".")) continue;
      const base = resolve(dirname(file), i.path);
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((c) => existsSync(c) && statSync(c).isFile());
      if (hit !== undefined) queue.push(hit);
    }
  }
  return [...seen];
}

/** One line per violation; empty when the boundary holds. */
export function checkStackBoundary(root: string): string[] {
  const problems: string[] = [];
  const stackManifests = new Map<string, Manifest>();
  for (const pkg of STACK_PACKAGES) {
    const m = manifest(join(root, pkg));
    stackManifests.set(m.name, m);
  }

  const exportedSubpath = (name: string, sub: string): boolean => {
    const stack = stackManifests.get(name);
    if (stack === undefined) return true; // a third-party package: its own exports map is the resolver's business
    return Object.hasOwn(stack.exports ?? { ".": "" }, sub);
  };

  const inspectorName = manifest(join(root, "inspector")).name;
  for (const pkg of STACK_PACKAGES) {
    const dir = join(root, pkg);
    const m = manifest(dir);
    const declared = new Set([...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]);
    if (pkg !== "inspector") {
      for (const dep of [inspectorName, ...UI_DEPENDENCIES]) {
        if (declared.has(dep)) problems.push(`${pkg}/package.json: declares ${dep}, which only inspector/ may`);
      }
    }
    for (const file of walk(dir, [".ts", ".tsx"])) {
      const rel = relative(root, file);
      const browser = pkg === "inspector" && isBrowserFile(relative(dir, file));
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          if (target !== dir && !target.startsWith(dir + sep)) problems.push(`${rel}: imports ${spec}, outside ${pkg}/`);
          else if (browser && ![target, `${target}.ts`, `${target}.tsx`, `${target}/`].some((t) => isBrowserFile(relative(dir, t) + (t.endsWith("/") ? "/" : "")))) {
            problems.push(`${rel}: imports ${spec}, the inspector's server side, from a file a browser bundles`);
          }
          continue;
        }
        if (isBuiltin(spec)) {
          if (browser) problems.push(`${rel}: imports ${spec}, a runtime built-in, from a file a browser bundles`);
          continue;
        }
        const [name, sub] = splitPackage(spec);
        if (!declared.has(name)) {
          problems.push(`${rel}: imports ${spec}, which ${pkg}/package.json does not declare`);
          continue;
        }
        if (!exportedSubpath(name, sub)) {
          problems.push(`${rel}: imports ${spec}, which ${name} does not export`);
          continue;
        }
        if (pkg === "inspector" && stackManifests.has(name) && !INSPECTOR_STACK_IMPORTS.has(spec)) {
          problems.push(`${rel}: imports ${spec}; the inspector takes only ${[...INSPECTOR_STACK_IMPORTS].join(", ")} from the stack`);
        }
      }
    }
  }

  // The read sides read: what the inspector may import from the stack, through
  // everything it loads, and the inspector's own sources, write nothing.
  const readOnly = new Set<string>();
  const mcp = stackManifests.get(manifest(join(root, "mcp")).name);
  for (const spec of INSPECTOR_STACK_IMPORTS) {
    const [, sub] = splitPackage(spec);
    const target = mcp?.exports?.[sub];
    if (target !== undefined && existsSync(join(root, "mcp", target))) for (const f of valueClosure(join(root, "mcp", target))) readOnly.add(f);
  }
  const inspectorDir = join(root, "inspector");
  for (const file of walk(inspectorDir, [".ts", ".tsx"])) {
    const rel = relative(inspectorDir, file).split(sep).join("/");
    if (rel.startsWith("test/") || /\.test\.tsx?$/.test(rel)) continue;
    readOnly.add(file);
  }
  for (const file of [...readOnly].sort()) {
    for (const w of fsWritesOf(readFileSync(file, "utf8"))) problems.push(`${relative(root, file)}: calls ${w}, on the read side`);
  }

  // The module: quoted includes by bare name only.
  for (const file of walk(join(root, "module"), [".cpp", ".h", ".hpp"])) {
    const rel = relative(root, file);
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
      if (m[1]!.includes("/") || m[1]!.includes("\\")) problems.push(`${rel}: includes "${m[1]}", a path rather than a header name`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkStackBoundary(resolve(import.meta.dir, ".."));
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log("stack boundary holds: module/, sdk/, mcp/ and inspector/ import nothing outside themselves but declared dependencies, and the inspector only the read sides of the record and the grants, which write nothing");
}
