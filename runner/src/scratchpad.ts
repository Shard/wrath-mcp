/**
 * The scratchpad: one markdown file per run, `data/runs/<id>/scratchpad.md`.
 * It is the model's only durable memory across context windows and process
 * restarts, which is why it is a plain file on disk and not process state.
 * Reads and writes are synchronous and whole-file; the file is small by
 * construction (capped) and contention is nil (one writer).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Hard cap. A scratchpad is notes, not a database. */
export const SCRATCHPAD_MAX_CHARS = 32_000;

export class Scratchpad {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  read(): string {
    if (!existsSync(this.path)) return "";
    return readFileSync(this.path, "utf8");
  }

  /** Replace the whole scratchpad. Truncates at the cap, marking the cut. */
  write(content: string): { chars: number; truncated: boolean } {
    let out = content;
    let truncated = false;
    if (out.length > SCRATCHPAD_MAX_CHARS) {
      out = `${out.slice(0, SCRATCHPAD_MAX_CHARS)}\n\n[scratchpad truncated at ${SCRATCHPAD_MAX_CHARS} chars]`;
      truncated = true;
    }
    writeFileSync(this.path, out, "utf8");
    return { chars: out.length, truncated };
  }

  /**
   * Replace one exact substring, the way an editing tool does: the model sends
   * the text it wants gone and the text to put there, not the whole document.
   * Refusals are the point — an ambiguous or absent `old` means the model's
   * picture of the pad and the pad have diverged, and guessing which of two
   * matches was meant is exactly the referent selection the harness never makes
   * (docs/METHODOLOGY.md, "The model surface"). Plain string operations only:
   * `old`/`new` are model text, so a RegExp would choke on metacharacters and
   * String.replace would interpret `$&` in the replacement.
   */
  edit(
    old: string,
    replacement: string,
    replaceAll = false,
  ):
    | { ok: true; chars: number; lines: number; replaced: number; truncated: boolean }
    | { ok: false; reason: "empty_old" | "identical" | "not_found" | "ambiguous"; matches: number } {
    if (old.length === 0) return { ok: false, reason: "empty_old", matches: 0 };
    if (old === replacement) return { ok: false, reason: "identical", matches: 0 };
    const current = this.read();
    const matches = current.split(old).length - 1;
    if (matches === 0) return { ok: false, reason: "not_found", matches: 0 };
    if (matches > 1 && !replaceAll) return { ok: false, reason: "ambiguous", matches };
    const next = replaceAll
      ? current.split(old).join(replacement)
      : current.slice(0, current.indexOf(old)) + replacement + current.slice(current.indexOf(old) + old.length);
    const res = this.write(next);
    return {
      ok: true,
      chars: res.chars,
      lines: res.chars === 0 ? 0 : this.read().replace(/\n$/, "").split("\n").length,
      replaced: replaceAll ? matches : 1,
      truncated: res.truncated,
    };
  }

  append(text: string): { chars: number; truncated: boolean } {
    const current = this.read();
    const joined = current.length === 0 ? text : `${current}\n${text}`;
    return this.write(joined);
  }
}
