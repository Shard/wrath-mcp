/**
 * How long a freshly opened stream waits for the module's reattach frame, and
 * then for the replay it announces, before `connect()` returns (ms). The
 * module emits the frame one world tick after the subscribe when the session
 * is in world and nothing at all when it is not (a fresh run's first
 * `connect()`, a login in flight), so the first wait is the cost of not
 * knowing which: paid once per run on a fresh login, and the replay itself
 * takes a world tick more.
 *
 * Its own module because `entry.ts` replaces the global `fetch` and
 * `WebSocket` when it loads: a test that imported these from there would
 * confine every test after it in the same process.
 */
export const REATTACH_STATE_WAIT_MS = 1_000;
export const REATTACH_REPLAY_WAIT_MS = 5_000;
