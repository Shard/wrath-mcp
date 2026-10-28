/**
 * The fold on the snippet child's log copy (`sandbox/log-fold.ts`): a line
 * repeated back to back is written once and then counted, and nothing it
 * cannot compare whole is folded.
 */
import { describe, expect, test } from "bun:test";
import { RepeatFolder } from "../src/sandbox/log-fold";

function folder(): { f: RepeatFolder; out: () => string } {
  let out = "";
  return { f: new RepeatFolder((t) => void (out += t)), out: () => out };
}

describe("RepeatFolder", () => {
  test("a repeated line is written once and counted when a different one arrives", () => {
    const { f, out } = folder();
    f.push("a\na\na\nb\n");
    f.push("b\nc\n");
    f.end();
    expect(out()).toBe("a\n[sandbox] the line above repeated ×2 more\nb\n[sandbox] the line above repeated ×1 more\nc\n");
  });

  test("a run across writes folds the same, and flush counts it without ending it", () => {
    const { f, out } = folder();
    f.push("loop\n");
    f.push("loop\nloop\n");
    f.flush();
    f.push("loop\n");
    f.end();
    expect(out()).toBe("loop\n[sandbox] the line above repeated ×2 more\n[sandbox] the line above repeated ×1 more\n");
  });

  test("text that never repeats passes through byte for byte, blank lines included", () => {
    const { f, out } = folder();
    const text = "one\n\n\ntwo é ✓\n  indented\n";
    f.push(text);
    f.end();
    expect(out()).toBe(text);
  });

  test("a line split across writes is passed through and never compared", () => {
    const { f, out } = folder();
    f.push("same\nsa");
    f.push("me\nsame\n");
    f.push("tail with no newline");
    f.end();
    expect(out()).toBe("same\nsame\nsame\ntail with no newline");
  });

  test("a partial write after a run counts the run first", () => {
    const { f, out } = folder();
    f.push("x\nx\nx\n");
    f.push("half");
    f.end();
    expect(out()).toBe("x\n[sandbox] the line above repeated ×2 more\nhalf");
  });
});
