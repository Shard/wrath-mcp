/**
 * Snippet compilation: TypeScript in, an async-function body out, with the
 * persistence trick that makes the sandbox feel like a REPL.
 *
 * Every snippet runs inside a fresh `AsyncFunction` (so `await` works at the
 * top level). Function scope would normally swallow top-level declarations, so
 * two mechanisms make them persist:
 *
 *  1. Simple initialized declarations (`let x = …`) have their keyword
 *     stripped, becoming sloppy-mode global assignments. The binding IS
 *     `globalThis.x`, so a closure (a setInterval routine) that mutates it
 *     later stays visible to every subsequent snippet.
 *  2. Everything else declared at the top level — functions, classes,
 *     destructuring patterns, uninitialized names — is copied onto
 *     `globalThis` after the user's code, each in its own try/catch (a name in
 *     TDZ or an over-captured pattern identifier is skipped, never fatal).
 *     These are value snapshots taken at snippet end.
 *
 * Honest limitations, stated in the system prompt too:
 *  - a top-level `return` before the end skips the copy-back (mechanism 2)
 *    for that snippet; keyword-stripped assignments already ran;
 *  - `import` statements are not supported — `sdk` and friends are ambient.
 *
 * A sandbox that hosts a program compiles its snippets with `compileOneOff`
 * (below) instead: no persistence, and import statements that name the
 * program's workspace files.
 *
 * The scanner is a character-level state machine (strings, template literals
 * with `${}` nesting, comments, bracket depth), not a parser. It only has to
 * find declaration keywords at depth 0 and the names they bind; over-capture
 * is safe because of the per-name try/catch, under-capture (an exotic pattern)
 * costs persistence of that one name.
 */

import { statSync } from "node:fs";
import { isBuiltin } from "node:module";

export interface ScanResult {
  /** Every name declared at the top level. */
  names: string[];
  /** Names that need the copy-back (declaration kept in function scope). */
  copyBack: string[];
  /**
   * The source with `const`/`let`/`var` keywords stripped from simple
   * initialized declarations, turning them into sloppy-mode global
   * assignments. That — not the copy-back — is what makes a binding mutated
   * *after* the snippet returns (by a routine or callback) visible to later
   * snippets: the closure now closes over `globalThis.<name>`.
   */
  rewritten: string;
}

const DECL_RE = /^(?:const|let|var|function|class|async)$/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Extract bound names from a destructuring pattern's source text. */
export function extractPatternNames(pattern: string): string[] {
  const names: string[] = [];
  let i = 0;
  let skipDepth: number | null = null; // inside a default value: skip until depth back
  let depth = 0;
  let prevIdent: { name: string; end: number } | null = null;

  const flush = (nextSignificant: string): void => {
    if (prevIdent === null) return;
    // `key:` in an object pattern is a key, not a binding.
    if (nextSignificant !== ":") names.push(prevIdent.name);
    prevIdent = null;
  };

  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '"' || c === "'" || c === "`") {
      // string literal (computed keys, defaults): skip to close
      const quote = c;
      i++;
      while (i < pattern.length && pattern[i] !== quote) {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (skipDepth !== null) {
      const sd = skipDepth;
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if (c === "," && depth <= sd) skipDepth = null;
      if (depth < sd) skipDepth = null;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      flush(c);
      let j = i + 1;
      while (j < pattern.length && IDENT_CHAR.test(pattern[j]!)) j++;
      prevIdent = { name: pattern.slice(i, j), end: j };
      i = j;
      continue;
    }
    if (c === ":") {
      // previous identifier was a key; the binding follows.
      prevIdent = null;
      i++;
      continue;
    }
    if (c === "=") {
      flush(c);
      skipDepth = depth;
      i++;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      flush(c);
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      flush(c);
      depth--;
      i++;
      continue;
    }
    flush(c);
    i++;
  }
  flush(";");
  return names.filter((n) => !DECL_RE.test(n) && n !== "of" && n !== "in");
}

/**
 * Find names declared at the top level of a JS source (post-transpile).
 * Handles: `const|let|var <name|pattern> = …` (first declarator; later
 * declarators in a multi-declaration are not captured — documented),
 * `function name`, `async function name`, `class name`.
 */
export function scanTopLevelDeclarations(js: string): ScanResult {
  const names: string[] = [];
  const copyBack: string[] = [];
  /** Spans to delete from the source (keyword strips). */
  const edits: { start: number; end: number }[] = [];
  let i = 0;
  let depth = 0;
  const templateStack: number[] = []; // depth of `${` nesting per template

  const readIdent = (from: number): { name: string; end: number } | null => {
    let j = from;
    while (j < js.length && /\s/.test(js[j]!)) j++;
    if (j >= js.length || !IDENT_START.test(js[j]!)) return null;
    let k = j + 1;
    while (k < js.length && IDENT_CHAR.test(js[k]!)) k++;
    return { name: js.slice(j, k), end: k };
  };

  while (i < js.length) {
    const c = js[i]!;
    // comments
    if (c === "/" && js[i + 1] === "/") {
      while (i < js.length && js[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && js[i + 1] === "*") {
      i += 2;
      while (i < js.length && !(js[i] === "*" && js[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // strings
    if (c === '"' || c === "'") {
      i++;
      while (i < js.length && js[i] !== c) {
        if (js[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      while (i < js.length) {
        if (js[i] === "\\") {
          i += 2;
          continue;
        }
        if (js[i] === "`") {
          i++;
          break;
        }
        if (js[i] === "$" && js[i + 1] === "{") {
          templateStack.push(depth);
          depth++;
          i += 2;
          break; // fall back to main loop inside the interpolation
        }
        i++;
      }
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      // closing a template interpolation: resume template scanning
      if (c === "}" && templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        i++;
        // scan the remainder of the template literal
        while (i < js.length) {
          if (js[i] === "\\") {
            i += 2;
            continue;
          }
          if (js[i] === "`") {
            i++;
            break;
          }
          if (js[i] === "$" && js[i + 1] === "{") {
            templateStack.push(depth);
            depth++;
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    if (depth === 0 && IDENT_START.test(c) && (i === 0 || !IDENT_CHAR.test(js[i - 1]!))) {
      let j = i + 1;
      while (j < js.length && IDENT_CHAR.test(js[j]!)) j++;
      const word = js.slice(i, j);
      if (word === "async") {
        const next = readIdent(j);
        if (next !== null && next.name === "function") {
          const fn = readIdent(next.end);
          if (fn !== null) {
            names.push(fn.name);
            copyBack.push(fn.name);
          }
          i = next.end;
          continue;
        }
      } else if (word === "function" || word === "class") {
        const fn = readIdent(j);
        if (fn !== null) {
          names.push(fn.name);
          copyBack.push(fn.name);
        }
        i = j;
        continue;
      } else if (word === "const" || word === "let" || word === "var") {
        let k = j;
        while (k < js.length && /\s/.test(js[k]!)) k++;
        const open = js[k];
        if (open === "{" || open === "[") {
          // Destructuring: keep the declaration, persist by copy-back.
          const close = open === "{" ? "}" : "]";
          let d = 0;
          let m = k;
          for (; m < js.length; m++) {
            if (js[m] === open) d++;
            else if (js[m] === close) {
              d--;
              if (d === 0) break;
            }
          }
          const patternNames = extractPatternNames(js.slice(k, m + 1));
          names.push(...patternNames);
          copyBack.push(...patternNames);
          i = m + 1;
          continue;
        }
        const id = readIdent(j);
        if (id !== null && !DECL_RE.test(id.name)) {
          names.push(id.name);
          let after = id.end;
          while (after < js.length && /\s/.test(js[after]!)) after++;
          if (js[after] === "=" && js[after + 1] !== "=") {
            // `let x = …` -> `x = …`: a sloppy-mode global assignment, so the
            // binding IS globalThis.x and later mutation stays visible.
            edits.push({ start: i, end: j });
          } else {
            // `let x;` (no initializer): keep the declaration, copy back.
            copyBack.push(id.name);
          }
          i = id.end;
          continue;
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  let rewritten = js;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, e.start) + rewritten.slice(e.end);
  }
  return { names: [...new Set(names)], copyBack: [...new Set(copyBack)], rewritten };
}

/**
 * Transpile TypeScript to plain JS. `deadCodeElimination: false` matters: the
 * default would delete a side-effect-free expression statement like `40 + 2`,
 * and a REPL-style snippet is exactly that.
 */
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun", deadCodeElimination: false });

export interface CompiledSnippet {
  /** JS to place in an AsyncFunction body when run as statements. */
  statementsBody: string;
  /** JS to try first as `return (\n <js> \n);` — single-expression snippets. */
  expressionBody: string;
  /**
   * Whether the expression path may be attempted. False whenever the snippet
   * declares anything at the top level: `function f() {}` would otherwise
   * parse as a function *expression*, silently skipping the declaration.
   */
  canTryExpression: boolean;
  /** Top-level names to copy onto globalThis after the user code. */
  names: string[];
  /** The transpiled JS, for logging. */
  js: string;
}

export function compileSnippet(source: string): CompiledSnippet {
  // Transpile inside an async-arrow wrapper: a bare snippet containing both
  // `await` and a top-level `return` is rejected by the transpiler ("top-level
  // return cannot be used inside an ECMAScript module"), but the eventual
  // execution context IS an async function body, so transpile it as one and
  // extract the body again. The wrapper is ours, so the first `{` and the last
  // `}` are its braces.
  const wrapped = transpiler.transformSync(
    `const __wrathbench_snippet__ = async () => {\n${source}\n};`,
  );
  const js = wrapped.slice(wrapped.indexOf("{") + 1, wrapped.lastIndexOf("}"));
  const { names, copyBack, rewritten } = scanTopLevelDeclarations(js);
  const copyBackCode = copyBack
    .map((n) => `\n;try{ globalThis[${JSON.stringify(n)}] = ${n}; }catch(_){}`)
    .join("");
  // The transpiler terminates statements with `;`, which would break
  // `return ( … );` — trim trailing semicolons for the expression attempt.
  const exprJs = js.trim().replace(/;+\s*$/, "");
  return {
    js,
    names,
    canTryExpression: names.length === 0 && exprJs.length > 0,
    statementsBody: `${rewritten}${copyBackCode}`,
    expressionBody: `return (\n${exprJs}\n);`,
  };
}

// ------------------------------------------------------------ one-off snippets
//
// A sandbox that hosts a program (`program.ts`) compiles a snippet as a
// one-off: its declarations are its own and end with it, and it may import
// the workspace's files. `compileSnippet` above is the persistent snippet's
// and is not touched by any of this: a sandbox with no program never calls
// what follows, and compiles to exactly the bytes it always did.

/** The program's file, at the workspace root and only that name. */
export const MAIN_PATH = "main.ts";
/** The program's saved memory: a workspace file the host alone writes, and no module. */
export const MEMORY_PATH = "memory.json";
/** memory.json's limit, in characters of JSON. */
export const MEMORY_MAX_CHARS = 32_000;

/** The file kinds an import may name. */
export const IMPORTABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

/** Whether a workspace path names a file an import can load. */
export function isImportable(path: string): boolean {
  return IMPORTABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export interface OneOffOptions {
  /**
   * The directory holding the version of the workspace files this snippet
   * imports from (absolute). Undefined while no version exists: a snippet
   * that imports is then refused, naming the specifier.
   */
  root?: string | undefined;
}

/** The wrapper line a snippet is transpiled inside. */
const WRAPPER_OPEN = "const __wrathbench_snippet__ = async () => {";

/**
 * Compile a one-off snippet. A function body cannot hold an `import`
 * declaration, so the snippet's top-level imports are lifted out before the
 * wrapper is built: each becomes an awaited dynamic `import()` of the file it
 * names under `root`, resolved here to an absolute path (`./x`, `./x.ts`, `x`
 * and nested paths all name workspace files; a specifier with a scheme, such
 * as `node:fs`, is passed through). A string-literal `import("./x")` in the
 * body is routed to the sandbox's `__wrathbench_import__`, which resolves it
 * when the call runs. Nothing is copied onto `globalThis`: `names` is scanned
 * only to decide the expression path, since a declaration must never parse as
 * an expression.
 */
export function compileOneOff(source: string, options: OneOffOptions = {}): CompiledSnippet {
  const lifted = extractImportStatements(source);
  if (lifted.imports.length === 0) {
    const wrapped = transpiler.transformSync(`${WRAPPER_OPEN}\n${source}\n};`);
    const js = wrapped.slice(wrapped.indexOf("{") + 1, wrapped.lastIndexOf("}"));
    return finishOneOff(routeDynamicImports(js, wrapped), "");
  }
  // Imports stay outside the wrapper, where a module may declare them, so the
  // transpiler sees them used by the body and drops only the type-only and
  // unused ones, the trimming a TypeScript file gets. They share the
  // wrapper's one line, and each is blanked out of the body keeping its line
  // breaks, so a parse error's line number still maps to the user's line.
  const head = lifted.imports.map((i) => (i.text.endsWith(";") ? i.text : `${i.text};`)).join(" ");
  const wrapped = importTranspiler.transformSync(`${head} ${WRAPPER_OPEN}\n${lifted.body}\n};`);
  const open = wrapped.indexOf(WRAPPER_OPEN);
  if (open === -1) throw new Error("snippet compile: the transpiler dropped the snippet wrapper");
  const js = wrapped.slice(open + WRAPPER_OPEN.length, wrapped.lastIndexOf("}"));
  const prelude = importPrelude(parseTranspiledImports(wrapped.slice(0, open)), options.root);
  return finishOneOff(routeDynamicImports(js, wrapped), prelude);
}

function finishOneOff(js: string, prelude: string): CompiledSnippet {
  const { names } = scanTopLevelDeclarations(js);
  // The transpiler terminates statements with `;`, which would break
  // `return ( … );`, so trailing semicolons go for the expression attempt.
  const exprJs = js.trim().replace(/;+\s*$/, "");
  return {
    js,
    names,
    canTryExpression: names.length === 0 && exprJs.length > 0,
    statementsBody: `${prelude}${js}`,
    expressionBody: `${prelude}return (\n${exprJs}\n);`,
  };
}


/**
 * The snippet transpiler for a source that imports: the same settings, plus
 * TypeScript's own rule that an import used only as a type (or not at all)
 * is dropped rather than loaded.
 */
const importTranspiler = new Bun.Transpiler({
  loader: "ts",
  target: "bun",
  deadCodeElimination: false,
  trimUnusedImports: true,
});

/** A specifier with a scheme (`node:fs`, `bun:sqlite`): never a workspace file. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * A snippet's string-literal `import("…")` calls, routed to the workspace.
 *
 * A snippet's code is evaluated from the sandbox's own child module, so an
 * unrouted `import("./lib/combat")` resolves against the stack's directory
 * and fails naming the stack's path. Each call whose specifier names a
 * workspace file the way an import statement would (`./x`, `x`, `x.ts`,
 * nested, or a `..` that the resolver refuses by name) becomes
 * `__wrathbench_import__("./x", …)`: the sandbox resolves it when the call
 * runs, against the newest version of the files. A specifier with a scheme,
 * an absolute path and a computed argument are left exactly as written.
 *
 * Only calls the transpiler itself reports as dynamic imports are touched, so
 * text that merely looks like one inside a string is left alone unless the
 * same specifier is also imported for real. `wrapped` is the transpiled
 * module the body `js` was cut from.
 */
function routeDynamicImports(js: string, wrapped: string): string {
  if (!js.includes("import")) return js;
  let specifiers: Set<string>;
  try {
    specifiers = new Set(
      importTranspiler
        .scanImports(wrapped)
        .filter((i) => i.kind === "dynamic-import")
        .map((i) => i.path)
        .filter((p) => !SCHEME.test(p) && !p.startsWith("/")),
    );
  } catch {
    return js;
  }
  if (specifiers.size === 0) return js;
  return js.replace(
    /(?<![\w$.])import\s*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g,
    (whole, literal: string) => {
      // A path with an escape in it is not one a workspace file has; leave it.
      if (literal.includes("\\")) return whole;
      const spec = literal.slice(1, -1);
      return specifiers.has(spec) ? `__wrathbench_import__(${JSON.stringify(spec)}` : whole;
    },
  );
}

/** An import the snippet's resolution or linking refused; the message names the path. */
export class ImportError extends Error {
  override name = "ImportError";
}

export interface LiftedImports {
  /** Each top-level import statement, comments removed, on one line. */
  imports: { text: string; start: number; end: number }[];
  /** The source with every import statement blanked out, its line breaks kept. */
  body: string;
}

/**
 * Find the snippet's top-level import statements in the TypeScript source.
 *
 * The same kind of character-level scan as `scanTopLevelDeclarations`
 * (strings, template literals with `${}` nesting, comments, bracket depth).
 * `import` at depth 0 followed by anything but `(` or `.` is a declaration —
 * the word is reserved, so it cannot be an identifier there; `import(…)` and
 * `import.meta` are left where they are. A statement runs to its module
 * specifier, an optional `with { … }` clause and an optional `;`.
 */
export function extractImportStatements(source: string): LiftedImports {
  const imports: LiftedImports["imports"] = [];
  let i = 0;
  let depth = 0;
  const templateStack: number[] = [];

  const skipString = (from: number): number => {
    const q = source[from]!;
    let j = from + 1;
    while (j < source.length && source[j] !== q) {
      if (source[j] === "\\") j++;
      j++;
    }
    return j + 1;
  };
  const skipComment = (from: number): number => {
    if (source[from + 1] === "/") {
      let j = from;
      while (j < source.length && source[j] !== "\n") j++;
      return j;
    }
    const end = source.indexOf("*/", from + 2);
    return end === -1 ? source.length : end + 2;
  };
  /** Skip whitespace and comments from `from`, recording comment spans. */
  const skipTrivia = (from: number, comments: [number, number][]): number => {
    let j = from;
    for (;;) {
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] === "/" && (source[j + 1] === "/" || source[j + 1] === "*")) {
        const end = skipComment(j);
        comments.push([j, end]);
        j = end;
        continue;
      }
      return j;
    }
  };
  /**
   * From just after `import`, the end of the statement — or -1 when this is not
   * a statement we lift (`import x = require(…)`, or something malformed that
   * the transpiler will report on its own).
   */
  const statementEnd = (from: number, comments: [number, number][]): number => {
    let j = skipTrivia(from, comments);
    if (source[j] === '"' || source[j] === "'") {
      j = skipString(j); // import "./side-effect"
    } else {
      // The clause: identifiers, `*`, `,`, `as`, `type`, and one `{ … }`.
      for (;;) {
        j = skipTrivia(j, comments);
        if (j >= source.length) return -1;
        const c = source[j]!;
        if (c === "{") {
          let d = 0;
          for (; j < source.length; j++) {
            const ch = source[j]!;
            if (ch === '"' || ch === "'") {
              j = skipString(j) - 1;
              continue;
            }
            if (ch === "/" && (source[j + 1] === "/" || source[j + 1] === "*")) {
              const end = skipComment(j);
              comments.push([j, end]);
              j = end - 1;
              continue;
            }
            if (ch === "{") d++;
            else if (ch === "}" && --d === 0) break;
          }
          j++;
          continue;
        }
        if (c === "=" || c === ";" || c === "(") return -1;
        if (
          source.startsWith("from", j) &&
          !IDENT_CHAR.test(source[j - 1] ?? "") &&
          !IDENT_CHAR.test(source[j + 4] ?? "")
        ) {
          j = skipTrivia(j + 4, comments);
          if (source[j] !== '"' && source[j] !== "'") return -1;
          j = skipString(j);
          break;
        }
        j++;
      }
    }
    // An import attributes clause: `with { type: "json" }` (or the older `assert`).
    const k = skipTrivia(j, [] as [number, number][]);
    for (const word of ["with", "assert"]) {
      if (source.startsWith(word, k) && !IDENT_CHAR.test(source[k + word.length] ?? "")) {
        const open = skipTrivia(k + word.length, comments);
        if (source[open] === "{") {
          const close = source.indexOf("}", open);
          if (close !== -1) j = close + 1;
        }
      }
    }
    // The statement's own `;`, when it has one on the same line.
    let m = j;
    while (m < source.length && (source[m] === " " || source[m] === "\t")) m++;
    return source[m] === ";" ? m + 1 : j;
  };

  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = skipComment(i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(i);
      continue;
    }
    if (c === "`") {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          i++;
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          templateStack.push(depth);
          depth++;
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (c === "}" && templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === "`") {
            i++;
            break;
          }
          if (source[i] === "$" && source[i + 1] === "{") {
            templateStack.push(depth);
            depth++;
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    if (
      depth === 0 &&
      source.startsWith("import", i) &&
      (i === 0 || (!IDENT_CHAR.test(source[i - 1]!) && source[i - 1] !== ".")) &&
      !IDENT_CHAR.test(source[i + 6] ?? "")
    ) {
      const probe: [number, number][] = [];
      const next = source[skipTrivia(i + 6, probe)];
      if (next !== "(" && next !== ".") {
        const comments: [number, number][] = [];
        const end = statementEnd(i + 6, comments);
        if (end !== -1) {
          let text = "";
          let from = i;
          for (const [a, b] of comments.filter(([a]) => a >= i && a < end).sort((x, y) => x[0] - y[0])) {
            text += `${source.slice(from, a)} `;
            from = b;
          }
          text += source.slice(from, end);
          imports.push({ text: text.replace(/\s+/g, " ").trim(), start: i, end });
          i = end;
          continue;
        }
      }
    }
    i++;
  }

  let body = "";
  let from = 0;
  for (const imp of imports) {
    body += source.slice(from, imp.start) + source.slice(imp.start, imp.end).replace(/[^\n]/g, "");
    from = imp.end;
  }
  body += source.slice(from);
  return { imports, body };
}

/** One import statement as the transpiler prints it back. */
export interface ParsedImport {
  specifier: string;
  /** `import d from …` */
  defaultName?: string;
  /** `import * as ns from …` */
  namespace?: string;
  /** `import { a, b as c } from …`: [imported, local]. */
  named: [string, string][];
  /** `with { … }`, verbatim, when present. */
  attributes?: string;
}

const PRINTED_IMPORT =
  /import\s*(?:([^"';]*?)\s*from\s*)?"((?:[^"\\\n]|\\.)*)"(?:\s*(?:with|assert)\s*(\{[^}]*\}))?\s*;?/gy;

/**
 * Parse the import statements the transpiler printed ahead of the wrapper.
 * Its printer is canonical (double quotes, one clause shape per form), so
 * this reads a known grammar, not arbitrary source; anything left over means
 * the transpiler printed something unexpected, which is refused rather than
 * guessed at.
 */
export function parseTranspiledImports(js: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  PRINTED_IMPORT.lastIndex = 0;
  let at = 0;
  for (;;) {
    while (at < js.length && /\s/.test(js[at]!)) at++;
    if (at >= js.length) break;
    PRINTED_IMPORT.lastIndex = at;
    const m = PRINTED_IMPORT.exec(js);
    if (m === null) throw new Error(`snippet compile: could not read the import statements (${js.slice(at, at + 80)})`);
    at = PRINTED_IMPORT.lastIndex;
    const parsed: ParsedImport = { specifier: JSON.parse(`"${m[2]!}"`) as string, named: [] };
    if (m[3] !== undefined) parsed.attributes = m[3];
    let clause = (m[1] ?? "").trim();
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces !== null) {
      for (const part of braces[1]!.split(",")) {
        const p = part.trim();
        if (p.length === 0) continue;
        const as = /^([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
        const imported = as === null ? p : as[1]!.trim();
        const local = as === null ? p : as[2]!;
        parsed.named.push([imported.startsWith('"') ? (JSON.parse(imported) as string) : imported, local]);
      }
      clause = clause.replace(braces[0], "").trim();
    }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns !== null) {
      parsed.namespace = ns[1]!;
      clause = clause.replace(ns[0], "").trim();
    }
    const def = clause.replace(/,/g, " ").trim();
    if (def.length > 0) parsed.defaultName = def;
    out.push(parsed);
  }
  return out;
}

/** Extensions a workspace import may leave off, in the order they are tried. */
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".jsx"];

/**
 * The candidate files for a specifier: itself when it already names an
 * importable file, else itself with each implied extension and as a directory
 * index. A specifier is never resolved to a file that is not code or JSON.
 */
export function importCandidates(base: string): string[] {
  return isImportable(base) ? [base] : [...IMPORT_EXTENSIONS.map((e) => base + e), `${base}/index.ts`, `${base}/index.js`];
}

/**
 * A snippet's import specifier, resolved against `root`, the directory that
 * holds the version of the workspace files the snippet imports from: the
 * absolute file, plus the path the model would recognise for error messages.
 * `null` means pass the specifier through unchanged (it has a scheme, e.g.
 * `node:fs`).
 */
export function resolveWorkspaceImport(specifier: string, root: string | undefined): { abs: string; rel: string } | null {
  if (SCHEME.test(specifier)) return null;
  const shown = JSON.stringify(specifier);
  if (root === undefined || root.length === 0) {
    if (isBareBuiltin(specifier)) throw new ImportError(builtinRefusal(specifier));
    throw new ImportError(`import ${shown}: there are no workspace files to import yet; write one with write_file`);
  }
  if (specifier.startsWith("/")) {
    throw new ImportError(`import ${shown}: imports name workspace files by relative path, e.g. "./lib/combat"`);
  }
  if (specifier.split("/").includes("..")) throw new ImportError(`import ${shown}: .. would leave the workspace`);
  const rel = specifier.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (rel === MEMORY_PATH) {
    throw new ImportError(`import ${shown}: ${MEMORY_PATH} is your memory, not a module; it is the ambient \`memory\` object in code`);
  }
  const tried = importCandidates(rel);
  for (const candidate of tried) {
    const abs = `${root}/${candidate}`;
    if (isFile(abs)) return { abs, rel: candidate };
  }
  if (isFile(`${root}/${rel}`)) {
    throw new ImportError(`import ${shown}: only code and JSON files can be imported (${IMPORTABLE_EXTENSIONS.join(", ")})`);
  }
  // Only once no workspace file answers to it: a bare name is a workspace file first, so a model's events.ts imports as "events".
  if (isBareBuiltin(specifier)) throw new ImportError(builtinRefusal(specifier));
  throw new ImportError(`import ${shown}: no such file in the workspace (looked for ${tried.join(", ")})`);
}

/** A specifier with no path and no scheme that names one of the runtime's builtin modules (`fs`, `path`). */
function isBareBuiltin(specifier: string): boolean {
  return !specifier.startsWith(".") && isBuiltin(specifier);
}

/**
 * The refusal of a bare builtin name. The sandbox does import builtins (a
 * snippet's `node:fs` passes through, and a workspace file's `import "fs"`
 * is the runtime's own); in a snippet a bare name means a workspace file, so
 * the builtin is named by its scheme.
 */
function builtinRefusal(specifier: string): string {
  const scheme = `node:${specifier}`;
  let resolves = false;
  try {
    resolves = Bun.resolveSync(scheme, import.meta.dir) === scheme;
  } catch {
    // Bun's own builtins (`bun`, `ws`) have no node: name.
  }
  return `import ${JSON.stringify(specifier)}: ${specifier} is a builtin module, not a file in your workspace; in a snippet a bare name imports a workspace file${resolves ? `, so import the builtin as ${JSON.stringify(scheme)}` : ""}`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The awaited dynamic imports that stand in for a snippet's import
 * statements. Every named binding is checked before it is read, so a missing
 * export is an error naming the file and the export, not a silent undefined.
 */
export function importPrelude(imports: readonly ParsedImport[], root: string | undefined): string {
  const lines: string[] = [];
  imports.forEach((imp, k) => {
    const target = resolveWorkspaceImport(imp.specifier, root);
    const path = target === null ? imp.specifier : target.abs;
    const shown = target === null ? imp.specifier : target.rel;
    // Either way an ordinary dynamic import: a workspace file by the absolute
    // path of the version it was resolved in, anything else as written.
    const call = `await import(${JSON.stringify(path)}${imp.attributes !== undefined ? `, { with: ${imp.attributes} }` : ""})`;
    const wanted = [
      ...(imp.defaultName !== undefined ? ["default"] : []),
      ...imp.named.map(([imported]) => imported),
    ];
    if (imp.namespace === undefined && wanted.length === 0) {
      lines.push(`${call};`);
      return;
    }
    const mod = `__wrathbench_import_${k}__`;
    lines.push(`const ${mod} = ${call};`);
    if (wanted.length > 0) {
      lines.push(
        `for (const __wrathbench_name__ of ${JSON.stringify(wanted)}) if (!(__wrathbench_name__ in ${mod})) ` +
          `throw new SyntaxError(${JSON.stringify(`${shown} has no export named `)} + JSON.stringify(__wrathbench_name__));`,
      );
    }
    if (imp.namespace !== undefined) lines.push(`const ${imp.namespace} = ${mod};`);
    if (imp.defaultName !== undefined) lines.push(`const ${imp.defaultName} = ${mod}.default;`);
    if (imp.named.length > 0) {
      const fields = imp.named.map(([imported, local]) =>
        imported === local ? local : `${JSON.stringify(imported)}: ${local}`,
      );
      lines.push(`const { ${fields.join(", ")} } = ${mod};`);
    }
  });
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
