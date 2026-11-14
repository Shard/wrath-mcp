/**
 * No HTML sinks in what the inspector serves to a browser. A session's
 * records are written by whoever drove it, a hosted tenant included, so
 * every string in them is hostile; the views only ever set text, which
 * Solid's JSX escapes. A string parsed as markup could run script beside the
 * sign-in cookie, so nothing in `src/` or the page may write markup:
 * `innerHTML` (Solid's prop of that name too), `outerHTML`,
 * `insertAdjacentHTML`, `document.write`, `createContextualFragment` or
 * `srcdoc`. Comments count too, so the rule is never argued around.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const INSPECTOR = join(import.meta.dir, "..");
const ROOTS = ["src", "page"];
const SKIP = new Set(["node_modules", "dist"]);
const EXTS = [".ts", ".tsx", ".html", ".js", ".jsx"];

const SINKS: readonly [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\b/],
  ["createContextualFragment", /\bcreateContextualFragment\b/],
  ["srcdoc", /\bsrcdoc\b/i],
];

/** The sinks `code` names, each with its line. */
function htmlSinks(code: string): string[] {
  const out: string[] = [];
  for (const [i, line] of code.split("\n").entries()) for (const [name, re] of SINKS) if (re.test(line)) out.push(`${i + 1}: ${name}`);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

describe("HTML sinks", () => {
  test("the guard catches each sink, Solid's prop included", () => {
    expect(htmlSinks('el.innerHTML = row.name;\nconst x = <div innerHTML={row.name} />;')).toEqual(["1: innerHTML", "2: innerHTML"]);
    expect(htmlSinks("a.outerHTML = s")).toEqual(["1: outerHTML"]);
    expect(htmlSinks('a.insertAdjacentHTML("beforeend", s)')).toEqual(["1: insertAdjacentHTML"]);
    expect(htmlSinks("document.write(s); document . writeln(s)")).toEqual(["1: document.write"]);
    expect(htmlSinks("range.createContextualFragment(s)")).toEqual(["1: createContextualFragment"]);
    expect(htmlSinks('<iframe srcDoc={s} />')).toEqual(["1: srcdoc"]);
    expect(htmlSinks("el.textContent = row.name;\nconst x = <div>{row.name}</div>;")).toEqual([]);
  });

  test("nothing the inspector serves to a browser writes markup", () => {
    const files = ROOTS.flatMap((r) => walk(join(INSPECTOR, r)));
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((f) => htmlSinks(readFileSync(f, "utf8")).map((hit) => `${relative(INSPECTOR, f)}:${hit}`));
    expect(found).toEqual([]);
  });
});
