/**
 * How old a position reading is, on whichever clock the feed was made by.
 * A map dims a stale pip and drops a stale intention by this age
 * (`mapintent.ts`), and a feed rendered ahead of time (a harness's published
 * snapshot) must not read as stale for its own latency.
 */

/** The feed's own reference clock: when the response was rendered, and when this tab received it. */
export interface FeedClock {
  /** When the feed was rendered, on the server's clock (a snapshot envelope's `generatedAt`). */
  generatedAt: number;
  /** When this browser got the body (browser clock). */
  fetchedAt: number;
}

/**
 * How old a position reading is, for the stale dimming.
 *
 * Against the browser's clock alone a feed rendered ahead of time reads
 * healthy sessions as stale: a published snapshot's own pipeline latency (in
 * WrathBench, a publish cadence, the edge and the client's memo) can be all of
 * the stale bound, with no margin for the reading's own age. When the feed
 * carries its rendering clock, the age is how old the reading was on the
 * server's clock when the feed was rendered, plus how long this tab has held
 * the response. Without one (a live API, a replay) the plain arithmetic
 * stands.
 */
export function positionAgeMs(ts: number, now: number, clock: FeedClock | null): number {
  if (clock === null) return now - ts;
  return clock.generatedAt - ts + (now - clock.fetchedAt);
}
