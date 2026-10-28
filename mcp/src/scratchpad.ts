/**
 * The scratchpad: one markdown file per run, `data/runs/<id>/scratchpad.md`.
 * It is the model's only durable memory across context windows and process
 * restarts, which is why it is a plain file on disk and not process state.
 * Reads and writes are synchronous and whole-file; the file is small by
 * construction (capped) and contention is nil (one writer).
 *
 * The cap refuses; it never cuts (docs/METHODOLOGY.md, "Context policy";
 * operator, 2026-10-14). It used to keep the head of an over-long write and
 * drop the tail, and an append at the cap dropped the whole new text: a model
 * that prepended a turn log to its pad lost every durable note off the end,
 * and every note it appended for eighty turns vanished, with nothing to say
 * so but a `truncated` flag on a promise it never awaited. A refusal saves
 * nothing and says why, so the model is the one that decides what goes.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Hard cap. A scratchpad is notes, not a database. */
export const SCRATCHPAD_MAX_CHARS = 32_000;

/**
 * The marker the old cut appended (`[scratchpad truncated at 32000 chars]`).
 * A pad written before the refusal can still carry one, and a model's
 * read-modify-write carried it along, mid-file once it prepended; it records
 * nothing true once the text around it has changed. Stripped wherever it
 * appears, on read and on write, so it is neither shown nor counted nor kept.
 */
const LEGACY_TRUNCATION_MARKER = /\n{0,2}\[scratchpad truncated at \d+ chars\]/g;

export function stripLegacyMarker(text: string): string {
  return text.replace(LEGACY_TRUNCATION_MARKER, "");
}

/** A refused write: what the pad would have held. Nothing was saved. */
export interface OverCap {
  ok: false;
  reason: "over_cap";
  /** The length the write would have left the pad at. */
  chars: number;
}

export type WriteResult = { ok: true; chars: number } | OverCap;

/**
 * The refusal sentence, the same on every path (`op` names the call: the
 * tool, or the snippet-side `scratchpad.append`). Says what happened and what
 * fixes it; never what to cut.
 */
export function overCapText(op: string, chars: number): string {
  return (
    `${op} refused: the scratchpad would be ${chars} chars, over its ${SCRATCHPAD_MAX_CHARS}-char cap. ` +
    `Nothing was saved. Condense the scratchpad, then try again.`
  );
}

/**
 * The size as every turn's context shows it, "31.2k/32k". Rounded down, so
 * the figure never reads as the cap while there is still room under it; a pad
 * past the cap (see `write`) says so, since rounding down could hide it.
 */
export function scratchpadSizeLabel(chars: number): string {
  const size = `${(Math.floor(chars / 100) / 10).toFixed(1)}k/${SCRATCHPAD_MAX_CHARS / 1000}k`;
  return chars > SCRATCHPAD_MAX_CHARS ? `${size}, over the cap` : size;
}

export class Scratchpad {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  read(): string {
    if (!existsSync(this.path)) return "";
    return stripLegacyMarker(readFileSync(this.path, "utf8"));
  }

  /**
   * Replace the whole scratchpad, or refuse. A result over the cap is refused
   * when it would also grow the pad: a pad already over the cap — one written
   * before the cap refused, or a cap lowered under it — stays readable, and a
   * write that leaves it no larger is accepted, so the condensing edit the
   * refusal asks for is never itself refused. Every other over-cap result is.
   */
  write(content: string): WriteResult {
    const out = stripLegacyMarker(content);
    if (out.length > SCRATCHPAD_MAX_CHARS && out.length > this.read().length) {
      return { ok: false, reason: "over_cap", chars: out.length };
    }
    writeFileSync(this.path, out, "utf8");
    return { ok: true, chars: out.length };
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
    | { ok: true; chars: number; lines: number; replaced: number }
    | { ok: false; reason: "empty_old" | "identical" | "not_found" | "ambiguous"; matches: number }
    | OverCap {
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
    if (!res.ok) return res;
    return {
      ok: true,
      chars: res.chars,
      lines: res.chars === 0 ? 0 : this.read().replace(/\n$/, "").split("\n").length,
      replaced: replaceAll ? matches : 1,
    };
  }

  /** Add a line at the end, or refuse: an append always grows the pad. */
  append(text: string): WriteResult {
    const current = this.read();
    const joined = current.length === 0 ? text : `${current}\n${text}`;
    return this.write(joined);
  }
}
