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

  append(text: string): { chars: number; truncated: boolean } {
    const current = this.read();
    const joined = current.length === 0 ? text : `${current}\n${text}`;
    return this.write(joined);
  }
}
