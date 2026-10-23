/**
 * Every call a caller makes into the SDK settles on a later turn of the event
 * loop, as a real client's call always does: the request crosses the network
 * and the answer comes back as an I/O callback.
 *
 * A call answered locally does not cross it on its own: a refusal that sends
 * nothing (dead, no such target or item, out of reach, a bad argument), or a
 * wait the event buffer already holds the answer to, settles in microtasks. A
 * loop that awaits such a call (`for (;;) await sdk.killTarget(guid)` once the
 * character has died) then never gives the event loop back: no timer fires,
 * no stream frame or IPC message is read, and the sandbox host, whose ping
 * goes unanswered, kills the process as blocked. So such a call waits for one
 * `setImmediate` before it settles. It is a yield, not a delay: zero ms, and
 * `setImmediate` rather than `setTimeout(0)`, which Bun clamps to a
 * millisecond.
 *
 * A call that did cross a turn settles exactly as before. That matters on the
 * I/O paths: the continuation after a request's answer registers its event
 * waiters in the same callback the answer arrived in, before the next stream
 * frame is read, and a turn inserted there could let that frame fold first.
 */

/**
 * Requests answered so far, process-wide, bumped by `noteRequest` as each
 * answer (or failure) arrives. Counted at the answer, not the send: a refusal
 * that fires a request it never awaits has not crossed a turn by settling.
 */
let requests = 0;

/** Count a request answered: an I/O callback ran, so whoever awaited it crossed the event loop. */
export function noteRequest(): void {
  requests++;
}

/**
 * `out` as returned, unless it is a promise that settles before a turn has
 * passed and without a request: then it settles, either way, on the next turn.
 * A synchronous throw from the call that produced `out` is not this function's
 * business and stays synchronous.
 */
function settleOnALaterTurn<T>(out: T): T {
  if (out === null || typeof (out as { then?: unknown })?.then !== "function") return out;
  const sentAt = requests;
  let turned = false;
  const turn = new Promise<void>((resolve) =>
    setImmediate(() => {
      turned = true;
      resolve();
    }),
  );
  const local = (): boolean => !turned && requests === sentAt;
  return (out as unknown as PromiseLike<unknown>).then(
    (value) => (local() ? turn.then(() => value) : value),
    (err: unknown) => {
      if (!local()) throw err;
      return turn.then(() => {
        throw err;
      });
    },
  ) as T;
}

/**
 * Make each named method on `proto` settle on a later turn (see the top of
 * this file). Installed on the prototype, so an instance's own override, once
 * deleted, falls back to it. Accessors and non-functions are left alone.
 */
export function settleOnLaterTurns(proto: object, names: Iterable<string>): void {
  for (const name of names) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (desc === undefined || typeof desc.value !== "function") continue;
    const fn = desc.value as (...args: unknown[]) => unknown;
    // Computed method syntax keeps the original's name in stack traces.
    const wrapped = {
      [name](this: unknown, ...args: unknown[]): unknown {
        return settleOnALaterTurn(fn.apply(this, args));
      },
    }[name] as (...args: unknown[]) => unknown;
    // Reading the method (`String(sdk.killTarget)`, its arity) shows the method, not this wrapper.
    Object.defineProperty(wrapped, "length", { value: fn.length });
    Object.defineProperty(wrapped, "toString", { value: () => Function.prototype.toString.call(fn) });
    Object.defineProperty(proto, name, { ...desc, value: wrapped });
  }
}
