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
 * The scanner is a character-level state machine (strings, template literals
 * with `${}` nesting, comments, bracket depth), not a parser. It only has to
 * find declaration keywords at depth 0 and the names they bind; over-capture
 * is safe because of the per-name try/catch, under-capture (an exotic pattern)
 * costs persistence of that one name.
 */

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
