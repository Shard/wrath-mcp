/**
 * Ownership of what model code starts, in a sandbox that hosts a program
 * (`program.ts`): every timer and every event listener created while a
 * snippet or a routine is the current async context belongs to it, and is
 * removed when it ends: a snippet when it returns or is abandoned, a routine
 * when it returns, throws, is stopped or is restarted. That is what makes
 * "nothing a snippet starts outlives it" and a routine's stop true.
 *
 * Ownership keys on the async context (the sandbox's AsyncLocalStorage), never
 * on stack frames: Bun elides a strict-mode tail call's frame, so a module
 * frame can simply be missing from a stack. SDK plumbing stays out of every
 * owner: Bun carries no async context into WebSocket callbacks, so event
 * ingestion, and every debounce timer the SDK arms there, runs unowned, and
 * the ambient `connect()` runs with no context at all. What an owner does
 * collect from the SDK is per-call: the timeouts and listeners of waits the
 * model started, which the owner's abort has already settled by the time
 * they are cleared.
 *
 * A listener registered from owned code is wrapped to run inside its owner's
 * context, so a timer that handler starts belongs to the same owner, and a
 * handler that throws is reported through `onHandlerError` instead of
 * breaking the SDK's dispatch for every other listener of that event.
 *
 * Installed only where a program is hosted. A snippet sandbox never calls
 * `installOwnership`, so its timers and listeners behave as they always have.
 */

/**
 * The abort reason of a stop the harness made: a snippet that returned, a
 * routine stopped or restarted. A rejection that carries one (directly, or as
 * an SDK `EventAbortedError`'s `reason`) is the stop working, never a fault
 * to report.
 */
export class HarnessStop extends Error {
  override name = "HarnessStop";
}

/** Whether an error is only the echo of a harness stop. */
export function isHarnessStop(err: unknown): boolean {
  let r = err;
  for (let depth = 0; depth < 4 && typeof r === "object" && r !== null; depth++) {
    if (r instanceof HarnessStop) return true;
    const carried = r as { reason?: unknown; cause?: unknown };
    r = carried.reason !== undefined ? carried.reason : carried.cause;
  }
  return false;
}

/** One snippet evaluation, one routine run, or one version's module graph. */
export class Owner {
  /** Live timers this owner created, by handle, with the kind that clears it. */
  readonly timers = new Map<unknown, "timeout" | "interval">();
  /** Unsubscribe functions for live listeners this owner registered. */
  readonly listeners = new Set<() => void>();
  /** Set by `close`: nothing more may be scheduled or heard for this owner. */
  closed = false;
  constructor(readonly label: string) {}
}

type Handler = (event: never) => unknown;
type Unsubscribe = () => void;

/** The event stream surface this patches: the SDK's `EventStream`, structurally. */
export interface OwnableEvents {
  on(opcode: string, handler: Handler): Unsubscribe;
  onAny(handler: Handler): Unsubscribe;
  once(opcode: string, handler: Handler): Unsubscribe;
  off(opcode: string, handler: Handler): boolean;
}

export interface OwnershipOptions<S> {
  /** The async context now, if any. */
  store: () => S | undefined;
  /** Its owner, if it has one. */
  ownerOf: (store: S) => Owner | undefined;
  /** Run `fn` inside `store`. */
  run: <T>(store: S, fn: () => T) => T;
  /** A listener registered by owned code threw (or its promise rejected). */
  onHandlerError: (store: S, opcode: string, err: unknown) => void;
  /**
   * A context to own a call made with none, when the caller's stack runs
   * through `marker`: a module's top-level code, which Bun evaluates outside
   * the importer's async context. Only consulted while one is offered (a
   * load's import in flight), and never for a call from outside the marked
   * code, so SDK plumbing stays nobody's.
   */
  fallback?: () => { store: S; marker: string } | undefined;
}

export interface Ownership {
  /** Clear every timer and remove every listener the owner holds; later ones are refused at birth. */
  close(owner: Owner): void;
  /** Own the registrations made on one more event stream (a seat's). */
  adopt(events: OwnableEvents): void;
  /** The real timer functions, for the harness's own scheduling. */
  readonly real: {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    clearTimeout: typeof clearTimeout;
    clearInterval: typeof clearInterval;
  };
}

/** Patch the global timers. Call once; `adopt` each event stream. */
export function installOwnership<S>(o: OwnershipOptions<S>): Ownership {
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  /** Which owner holds a live timer, so a clear by the model's own code forgets it too. */
  const holder = new Map<unknown, Owner>();

  /** The context that owns a call made now: the current one, or the offered fallback for marked code. */
  const owningStore = (): S | undefined => {
    const s = o.store();
    if (s !== undefined && o.ownerOf(s) !== undefined) return s;
    const f = o.fallback?.();
    if (f !== undefined && (new Error().stack ?? "").includes(f.marker)) return f.store;
    return s;
  };

  const currentOwner = (): Owner | undefined => {
    const s = owningStore();
    return s === undefined ? undefined : o.ownerOf(s);
  };

  const forget = (handle: unknown): void => {
    const owner = holder.get(handle);
    if (owner === undefined) return;
    holder.delete(handle);
    owner.timers.delete(handle);
  };

  const ownedSetTimeout = ((handler: unknown, ms?: number, ...args: unknown[]) => {
    const owner = currentOwner();
    if (owner === undefined || typeof handler !== "function") {
      return (real.setTimeout as (...a: unknown[]) => unknown)(handler, ms, ...args);
    }
    const fn = handler as (...a: unknown[]) => unknown;
    const handle: unknown = real.setTimeout(
      (...a: unknown[]) => {
        forget(handle);
        fn(...a);
      },
      ms,
      ...args,
    );
    if (owner.closed) {
      real.clearTimeout(handle as ReturnType<typeof setTimeout>);
      return handle;
    }
    owner.timers.set(handle, "timeout");
    holder.set(handle, owner);
    return handle;
  }) as unknown as typeof setTimeout;

  const ownedSetInterval = ((handler: unknown, ms?: number, ...args: unknown[]) => {
    const owner = currentOwner();
    if (owner === undefined || typeof handler !== "function") {
      return (real.setInterval as (...a: unknown[]) => unknown)(handler, ms, ...args);
    }
    const handle: unknown = real.setInterval(handler as (...a: unknown[]) => void, ms, ...args);
    if (owner.closed) {
      real.clearInterval(handle as ReturnType<typeof setInterval>);
      return handle;
    }
    owner.timers.set(handle, "interval");
    holder.set(handle, owner);
    return handle;
  }) as unknown as typeof setInterval;

  const ownedClearTimeout = ((handle: unknown) => {
    forget(handle);
    real.clearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  const ownedClearInterval = ((handle: unknown) => {
    forget(handle);
    real.clearInterval(handle as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  globalThis.setTimeout = ownedSetTimeout;
  globalThis.setInterval = ownedSetInterval;
  globalThis.clearTimeout = ownedClearTimeout;
  globalThis.clearInterval = ownedClearInterval;

  // ------------------------------------------------------------- listeners

  const adopt = (ev: OwnableEvents): void => {
    const realOn = ev.on.bind(ev);
    const realOnAny = ev.onAny.bind(ev);
    const realOnce = ev.once.bind(ev);
    const realOff = ev.off.bind(ev);
    /** `off(opcode, handler)` must find a registration by the handler the caller passed. */
    const byHandler = new Map<string, Map<Handler, Unsubscribe[]>>();

    const remember = (opcode: string, handler: Handler, entry: Unsubscribe): void => {
      let m = byHandler.get(opcode);
      if (m === undefined) byHandler.set(opcode, (m = new Map()));
      const list = m.get(handler) ?? [];
      list.push(entry);
      m.set(handler, list);
    };
    const unremember = (opcode: string, handler: Handler, entry: Unsubscribe): void => {
      const m = byHandler.get(opcode);
      const list = m?.get(handler);
      if (m === undefined || list === undefined) return;
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) m.delete(handler);
    };

    /** Register an owned listener: wrapped to run in its owner's context, removed when the owner closes. */
    const owned = (opcode: string, handler: Handler, register: (wrapped: Handler) => Unsubscribe, once: boolean): Unsubscribe | undefined => {
      const store = owningStore();
      const owner = store === undefined ? undefined : o.ownerOf(store);
      if (store === undefined || owner === undefined) return undefined;
      if (owner.closed) return () => {};
      let entry: Unsubscribe = () => {};
      const wrapped = ((event: never) => {
        if (owner.closed) return;
        if (once) entry();
        o.run(store, () => {
          try {
            const r = (handler as (e: never) => unknown)(event);
            if (r instanceof Promise) r.catch((err: unknown) => o.onHandlerError(store, opcode, err));
          } catch (err) {
            o.onHandlerError(store, opcode, err);
          }
        });
      }) as Handler;
      const unsubscribe = register(wrapped);
      let done = false;
      entry = () => {
        if (done) return;
        done = true;
        unsubscribe();
        owner.listeners.delete(entry);
        unremember(opcode, handler, entry);
      };
      owner.listeners.add(entry);
      remember(opcode, handler, entry);
      return entry;
    };

    ev.on = (opcode: string, handler: Handler): Unsubscribe => {
      if (typeof handler !== "function") return realOn(opcode, handler);
      // "*" is onAny in the SDK; keep one spelling of it here as well.
      if (opcode === "*") return ev.onAny(handler);
      return owned(opcode, handler, (w) => realOn(opcode, w), false) ?? realOn(opcode, handler);
    };
    ev.onAny = (handler: Handler): Unsubscribe => {
      if (typeof handler !== "function") return realOnAny(handler);
      return owned("*", handler, (w) => realOnAny(w), false) ?? realOnAny(handler);
    };
    ev.once = (opcode: string, handler: Handler): Unsubscribe => {
      if (typeof handler !== "function") return realOnce(opcode, handler);
      return owned(opcode, handler, (w) => realOn(opcode, w), true) ?? realOnce(opcode, handler);
    };
    ev.off = (opcode: string, handler: Handler): boolean => {
      const entries = typeof opcode === "string" ? byHandler.get(opcode)?.get(handler) : undefined;
      if (entries !== undefined && entries.length > 0) {
        entries[0]!();
        return true;
      }
      return realOff(opcode, handler);
    };
  };

  return {
    real,
    adopt,
    close(owner: Owner): void {
      owner.closed = true;
      for (const [handle, kind] of owner.timers) {
        holder.delete(handle);
        if (kind === "interval") real.clearInterval(handle as ReturnType<typeof setInterval>);
        else real.clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
      owner.timers.clear();
      for (const entry of [...owner.listeners]) entry();
      owner.listeners.clear();
    },
  };
}
