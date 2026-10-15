/**
 * Secret redaction: the one rule every sink the runner writes applies to a
 * registered secret value.
 *
 * `Trajectory` holds the run's list and scrubs every string it persists
 * (trajectory.jsonl, meta.json); `SandboxHost` scrubs what the snippet child
 * writes to stdout and stderr before it reaches the runner's own, and from
 * there the job log and the pod log. Both use `SecretRedactor`, so the marker
 * and the length floor cannot drift between them.
 */

/** What a registered secret reads as wherever the runner writes it. */
export const REDACTED = "[redacted]";

/**
 * Shorter values are never registered: replacing a short string everywhere
 * would mangle ordinary text, and nothing the runner holds as a secret is that
 * short (a lease secret is 64 hex characters).
 */
export const MIN_SECRET_CHARS = 8;

export class SecretRedactor {
  private readonly secrets: string[] = [];

  /** Register a secret to scrub. Undefined and too-short values are ignored. */
  redact(secret: string | undefined): void {
    if (secret !== undefined && secret.length >= MIN_SECRET_CHARS && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  /** `text` with every registered secret replaced by `REDACTED`. */
  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.replaceAll(s, REDACTED);
    return out;
  }
}

/**
 * Characters held back from a long line with no newline yet: a secret the read
 * cut in two may still be continuing in them. Longer than any secret the
 * runner registers (a lease secret is 64 characters, a lane's OAuth token
 * about 110).
 */
export const SCRUB_HOLD_CHARS = 4_096;

/** A line longer than this with no newline is written in part rather than held whole. */
export const SCRUB_MAX_PENDING_CHARS = 64 * 1_024;

/**
 * A text stream scrubbed on its way to a log. A pipe hands text over in
 * whatever pieces it was read in, so a secret can arrive split across two;
 * text is therefore held until a newline and scrubbed a whole line at a time.
 * A line that grows past `SCRUB_MAX_PENDING_CHARS` is scrubbed and written all
 * but its last `SCRUB_HOLD_CHARS`, so memory stays bounded. `end()` writes
 * whatever is left, scrubbed, when the stream closes.
 */
export class ScrubbedStream {
  private pending = "";

  constructor(
    private readonly scrub: (text: string) => string,
    private readonly write: (text: string) => void,
  ) {}

  push(text: string): void {
    this.pending += text;
    const nl = this.pending.lastIndexOf("\n");
    if (nl >= 0) {
      this.write(this.scrub(this.pending.slice(0, nl + 1)));
      this.pending = this.pending.slice(nl + 1);
    }
    if (this.pending.length > SCRUB_MAX_PENDING_CHARS) {
      const scrubbed = this.scrub(this.pending);
      this.write(scrubbed.slice(0, scrubbed.length - SCRUB_HOLD_CHARS));
      this.pending = scrubbed.slice(-SCRUB_HOLD_CHARS);
    }
  }

  end(): void {
    if (this.pending.length > 0) this.write(this.scrub(this.pending));
    this.pending = "";
  }
}
