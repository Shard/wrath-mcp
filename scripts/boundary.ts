#!/usr/bin/env bun
/**
 * The stack boundary, inside half: module/, sdk/ and mcp/ are meant to bolt
 * onto a stock AzerothCore and into any harness, so they depend on nothing but
 * themselves and what they declare. This check keeps that true as the code
 * changes:
 *
 *  - A TypeScript file in sdk/ or mcp/ imports only its own package (by
 *    relative path), Bun and Node built-ins, and the dependencies its
 *    package.json declares, at a subpath that dependency exports. sdk/ declares
 *    no stack dependency, so it can never import mcp/; mcp/ reaches the SDK
 *    through `@wrathbench/sdk` alone, at an exported entry point.
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

export const STACK_PACKAGES = ["sdk", "mcp"] as const;

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
  return [...new Set([...scanner.scanImports(code).map((i) => i.path), ...typeOnlyImports(code)])];
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

  for (const pkg of STACK_PACKAGES) {
    const dir = join(root, pkg);
    const m = manifest(dir);
    const declared = new Set([...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]);
    for (const file of walk(dir, [".ts", ".tsx"])) {
      const rel = relative(root, file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          if (target !== dir && !target.startsWith(dir + sep)) problems.push(`${rel}: imports ${spec}, outside ${pkg}/`);
          continue;
        }
        if (isBuiltin(spec)) continue;
        const [name, sub] = splitPackage(spec);
        if (!declared.has(name)) {
          problems.push(`${rel}: imports ${spec}, which ${pkg}/package.json does not declare`);
          continue;
        }
        if (!exportedSubpath(name, sub)) problems.push(`${rel}: imports ${spec}, which ${name} does not export`);
      }
    }
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
  console.log("stack boundary holds: module/, sdk/ and mcp/ import nothing outside themselves but declared dependencies");
}
