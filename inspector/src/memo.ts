/**
 * The readout's memo of what it derived from closed segments (`readout.ts`).
 * Its own module so that a test can reach it without the package's entry
 * point exporting it.
 */

import type { SegmentInfo } from "./source";

/**
 * What was derived from closed segments, by `ref`: bounded, the least
 * recently used evicted first. The bound scales with the sessions it holds
 * entries for, `perSession` each, between `min` and `max`: a map that follows
 * forty characters reads every one's recent windows on each pass, and a fixed
 * bound smaller than that evicts each entry just before it is asked for
 * again, so nothing is ever a hit.
 */
export class SegmentMemo<T> {
  private readonly entries = new Map<string, { session: string; value: T }>();
  /** How many entries each session holds. */
  private readonly sessions = new Map<string, number>();
  /** Without `perSession`, the bound is `max` whatever is held. */
  constructor(private readonly o: { max: number; perSession?: number; min?: number }) {}

  /** The bound as it stands. */
  get bound(): number {
    const { max, perSession, min = 0 } = this.o;
    return perSession === undefined ? max : Math.min(max, Math.max(min, perSession * this.sessions.size));
  }

  get size(): number {
    return this.entries.size;
  }

  async get(session: string, seg: SegmentInfo, derive: () => Promise<T>): Promise<T> {
    if (!seg.closed) return await derive();
    const hit = this.entries.get(seg.ref);
    if (hit !== undefined) {
      this.entries.delete(seg.ref);
      this.entries.set(seg.ref, hit);
      return hit.value;
    }
    const value = await derive();
    if (this.entries.has(seg.ref)) return value; // derived twice at once: the first is kept
    this.entries.set(seg.ref, { session, value });
    this.sessions.set(session, (this.sessions.get(session) ?? 0) + 1);
    while (this.entries.size > this.bound) {
      const [ref, oldest] = this.entries.entries().next().value as [string, { session: string; value: T }];
      this.entries.delete(ref);
      const left = (this.sessions.get(oldest.session) ?? 1) - 1;
      if (left > 0) this.sessions.set(oldest.session, left);
      else this.sessions.delete(oldest.session);
    }
    return value;
  }
}
