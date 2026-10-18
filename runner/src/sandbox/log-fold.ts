/**
 * The fold the host applies to the snippet child's stdout and stderr on their
 * way to the runner's own, and from there the fleet job's log or the run
 * pod's: a line repeated back to back is written once, and its repeats as one
 * count line.
 *
 * A model's routine stuck in a loop prints one line for as long as it runs.
 * One supervisor log reached 1.69 GB, 88% of it "Target … is not a valid
 * hostile or is dead. Finding new target.", and another was 99% "blocked bad
 * moveTo in stuck routine". Folded, the line is written once and then as
 * `[sandbox] the line above repeated ×N more` — when a different line
 * arrives, on `flush` (the host calls it once a minute while the stream is
 * open) and on `end`.
 *
 * Only the log copy is folded. The child's console still prints every call,
 * its snippet results fold their own way (`pushLog`, sandbox/entry.ts), and
 * the stderr tail a crash notice quotes to the model is read off the raw
 * stream before this (`SandboxHost.pump`), so nothing the model reads changes.
 *
 * It sits after the scrub, so the lines it compares and holds are already free
 * of the child's secret. A write that ends mid-line passes through as it is
 * and breaks any run: a line split across writes is never compared.
 */
export class RepeatFolder {
  /** The last whole line written, newline excluded; null after a partial write. */
  private last: string | null = null;
  private repeats = 0;
  /** The previous write ended without a newline, so the next one starts mid-line. */
  private midLine = false;

  constructor(private readonly write: (text: string) => void) {}

  push(text: string): void {
    let out = "";
    let at = 0;
    while (at < text.length) {
      const nl = text.indexOf("\n", at);
      if (nl < 0) {
        out += this.countLine() + text.slice(at);
        this.last = null;
        this.midLine = true;
        break;
      }
      const line = text.slice(at, nl);
      at = nl + 1;
      if (this.midLine) {
        // The rest of a line a previous write began: passed through, never compared.
        out += `${line}\n`;
        this.midLine = false;
        this.last = null;
        continue;
      }
      if (line.length > 0 && line === this.last) {
        this.repeats++;
        continue;
      }
      out += `${this.countLine()}${line}\n`;
      this.last = line;
    }
    if (out.length > 0) this.write(out);
  }

  /** Write the count of a run still going, so a log read now says so. The run goes on counting. */
  flush(): void {
    const count = this.countLine();
    if (count.length > 0) this.write(count);
  }

  /** The stream is closing: whatever run is open is counted. */
  end(): void {
    this.flush();
  }

  private countLine(): string {
    if (this.repeats === 0) return "";
    const line = `[sandbox] the line above repeated ×${this.repeats} more\n`;
    this.repeats = 0;
    return line;
  }
}
