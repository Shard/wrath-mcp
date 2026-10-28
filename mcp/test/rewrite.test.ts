import { describe, expect, test } from "bun:test";
import { compileSnippet, extractPatternNames, scanTopLevelDeclarations } from "../src/sandbox/rewrite";

describe("extractPatternNames", () => {
  test("object shorthand and renamed keys", () => {
    expect(extractPatternNames("{a, b: c}")).toEqual(["a", "c"]);
  });
  test("defaults bind the name, not the default expression", () => {
    expect(extractPatternNames("{a = other, b: c = 3}")).toEqual(["a", "c"]);
  });
  test("arrays and rest", () => {
    expect(extractPatternNames("[x, , y, ...rest]")).toEqual(["x", "y", "rest"]);
  });
  test("nested", () => {
    expect(extractPatternNames("{a: {b}, c: [d]}")).toEqual(["b", "d"]);
  });
});

describe("scanTopLevelDeclarations", () => {
  test("finds const/let/var/function/class at depth 0", () => {
    const { names } = scanTopLevelDeclarations(
      `const a = 1;\nlet b = { c: 2 };\nvar d = [3];\nfunction e() { const inner = 1; }\nclass F {}\nasync function g() {}`,
    );
    expect(names).toEqual(["a", "b", "d", "e", "F", "g"]);
  });
  test("ignores declarations inside blocks, strings, comments, templates", () => {
    const { names } = scanTopLevelDeclarations(
      `// const nope = 1
/* let nada = 2 */
const s = "const fake = 3";
const t = \`let alsoFake = \${(() => { const inner = 4; return inner; })()}\`;
if (true) { const scoped = 5; }`,
    );
    expect(names).toEqual(["s", "t"]);
  });
  test("destructuring at top level", () => {
    const { names } = scanTopLevelDeclarations(`const { x, y: z } = obj; let [p] = arr;`);
    expect(names).toEqual(["x", "z", "p"]);
  });
});

describe("compileSnippet", () => {
  test("strips TypeScript and rewrites simple declarations to global assignments", () => {
    const c = compileSnippet(`const n: number = 40 + 2;`);
    expect(c.js).not.toContain(": number");
    expect(c.names).toEqual(["n"]);
    // keyword stripped: the binding lives on globalThis, so later mutation
    // (e.g. from a routine) stays visible across snippets.
    expect(c.statementsBody).toContain("n = 42");
    expect(c.statementsBody).not.toContain("const n");
    expect(c.canTryExpression).toBe(false);
  });
  test("function/class/destructuring persist via guarded copy-back", () => {
    const c = compileSnippet(`function f() {}\nconst { a } = ({ a: 1 });\nlet noInit;`);
    expect(c.statementsBody).toContain(`globalThis["f"] = f`);
    expect(c.statementsBody).toContain(`globalThis["a"] = a`);
    expect(c.statementsBody).toContain(`globalThis["noInit"] = noInit`);
    expect(c.statementsBody).toContain("const { a }"); // destructuring kept as a declaration
  });
  test("for-loop declarations are not top-level and stay untouched", () => {
    const c = compileSnippet(`for (let i = 0; i < 3; i++) { console.log(i); }`);
    expect(c.statementsBody).toContain("let i = 0");
    expect(c.names).toEqual([]);
  });
  test("expression body wraps with newline padding (trailing comments safe)", () => {
    const c = compileSnippet("1 + 1 // done");
    expect(c.expressionBody.startsWith("return (\n")).toBe(true);
    expect(c.expressionBody.endsWith("\n);")).toBe(true);
  });
});
