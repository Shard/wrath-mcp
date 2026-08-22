/**
 * The typed event stream over `GET /events?token=...`.
 *
 * Three things this owns:
 *   - decoding frames into `GameEvent`s (protocol.ts does the schema work);
 *   - delivery: listeners, `waitFor`, and an `AsyncIterable` view;
 *   - continuity: `seq` is a per-session counter, so a reconnect that skipped
 *     events is detectable, and is surfaced as an explicit `stream_gap` event
 *     rather than being papered over. The state cache is only as trustworthy as
 *     the stream it was fed, so a gap has to be visible in-band.
 *
 * Buffering matters more than it looks. `POST /session` blocks for the whole
 * login handshake, which means the login events arrive while the caller is
 * awaiting the HTTP response. `waitFor` therefore searches the retained buffer
 * *before* waiting for future events.
 */

import {
  parseEventFrame,
  type GameEvent,
  type KnownEvent,
  type KnownOpcode,
} from "./protocol";

/** Opcode of a gap marker. Lowercase, so it can never collide with an `SMSG_*`. */
export const STREAM_GAP = "stream_gap";
/** Opcode of a frame the SDK could not read at all. */
export const STREAM_ERROR = "stream_error";

const STREAM_GAP_ID = -1;
const STREAM_ERROR_ID = -2;

/**
 * Events between `fromSeq` and `toSeq` (inclusive) were never delivered to this
 * SDK — almost always a reconnect across a socket drop. Its own `seq` is the
 * seq of the first event that *did* arrive after the hole, so it sorts into
 * place in the stream.
 */
export interface StreamGapEvent {
  readonly seq: number;
  readonly opcode: typeof STREAM_GAP;
  readonly opcodeId: typeof STREAM_GAP_ID;
  readonly ts: number;
  readonly synthetic: true;
  readonly data: { readonly fromSeq: number; readonly toSeq: number; readonly missing: number };
}

/** A frame arrived but was not a readable event envelope. Never dropped silently. */
export interface StreamErrorEvent {
  readonly seq: number;
  readonly opcode: typeof STREAM_ERROR;
  readonly opcodeId: typeof STREAM_ERROR_ID;
  readonly ts: number;
  readonly synthetic: true;
  readonly data: { readonly message: string; readonly frame: string };
}

/** Anything the stream delivers: a real event, or an SDK-generated marker. */
export type StreamEvent = GameEvent | StreamGapEvent | StreamErrorEvent;

/** Opcode -> event type, for the `on`/`once` overloads. */
export type EventByOpcode = { [K in KnownOpcode]: Extract<KnownEvent, { opcode: K }> } & {
  [STREAM_GAP]: StreamGapEvent;
  [STREAM_ERROR]: StreamErrorEvent;
};

export type Unsubscribe = () => void;

export interface EventStreamOptions {
  /** Full websocket URL, e.g. `ws://worldserver:8086/events`. */
  url: string;
  token: string;
  /** How many events to retain for `waitFor`/`recent`. Default 500. */
  bufferSize?: number;
  /** First seq expected on a fresh session. Default 0 (the module starts there). */
  expectFromSeq?: number;
  /** Reconnect after an unexpected close. Default true. */
  reconnect?: boolean;
  /** Backoff bounds in ms. Defaults 250 / 5000. */
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Injectable for tests; defaults to the global. */
  webSocketImpl?: typeof WebSocket;
  now?: () => number;
}

export interface WaitForOptions {
  /** Reject with `EventTimeoutError` after this many ms. Default 10000. */
  timeout?: number;
  /** Only consider events with `seq >= sinceSeq`. Default: consider all. */
  sinceSeq?: number;
  /**
   * Only consider events ingested at *exactly* this session epoch (see
   * `EventStream.epoch`). The guard for per-session correlation ids (`moveId`,
   * `seq`) that restart when the module recreates the session: a stale buffered
   * event from a previous session can carry the same id as a fresh request —
   * and, in the other direction, a *later* session's event can carry the same
   * id as a request left pending across a teardown/recreate. An exact match
   * excludes both; the pending waiter then times out, which is the honest
   * answer (the session that issued the request never produced the event).
   */
  epoch?: number;
  /**
   * Only consider events ingested at or after this session epoch. A one-sided
   * floor: it excludes earlier sessions' events but still admits *later*
   * sessions', so it is the wrong guard for per-session correlation ids — use
   * `epoch` for those. Kept for waits that mean "anything from this boundary
   * on", where later epochs are legitimately acceptable.
   */
  sinceEpoch?: number;
  /** Search the retained buffer before waiting. Default true. */
  includeBuffered?: boolean;
  /**
   * What this wait is for, in words (e.g. `WB_MOVE_RESULT for moveId 3`).
   * Rendered into the `EventTimeoutError`, so a timeout says what never
   * arrived instead of just "an event".
   */
  description?: string;
  /**
   * Reject with `EventAbortedError` when this fires. The runner threads the
   * per-snippet signal in by default (`ConnectOptions.signal`), so a wait
   * left behind by an abandoned snippet settles instead of outliving it.
   */
  signal?: AbortSignal;
}

export class EventTimeoutError extends Error {
  override readonly name = "EventTimeoutError";
  /** What was being waited for, when the caller said. */
  readonly waitingFor: string | undefined;
  constructor(
    readonly timeoutMs: number,
    waitingFor?: string,
  ) {
    super(`timed out after ${timeoutMs}ms waiting for ${waitingFor ?? "an event"}`);
    this.waitingFor = waitingFor;
  }
}

/**
 * The wait was cancelled by its `AbortSignal` before anything arrived — the
 * absence of a verdict, like `EventTimeoutError`, never a game outcome.
 * `reason` is whatever the signal was aborted with.
 */
export class EventAbortedError extends Error {
  override readonly name = "EventAbortedError";
  readonly waitingFor: string | undefined;
  constructor(
    readonly reason: unknown,
    waitingFor?: string,
  ) {
    const why = reason instanceof Error ? reason.message : reason === undefined ? "aborted" : String(reason);
    super(`aborted while waiting for ${waitingFor ?? "an event"}: ${why}`);
    this.waitingFor = waitingFor;
  }
}

export class EventStreamClosedError extends Error {
  override readonly name = "EventStreamClosedError";
  constructor(message = "event stream closed") {
    super(message);
  }
}

type AnyHandler = (event: StreamEvent) => void;

interface Waiter {
  predicate: (event: StreamEvent) => boolean;
  resolve: (event: StreamEvent) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

interface Consumer {
  queue: StreamEvent[];
  notify: (() => void) | undefined;
  done: boolean;
}

export class EventStream implements AsyncIterable<StreamEvent> {
  readonly token: string;

  private readonly url: string;
  private readonly bufferSize: number;
  private readonly reconnectEnabled: boolean;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly WS: typeof WebSocket;
  private readonly now: () => number;

  private socket: WebSocket | undefined;
  private closedByUser = false;
  private openPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;

  private readonly buffer: StreamEvent[] = [];
  /** Ingest epoch of each buffered event, in lockstep with `buffer`. */
  private readonly bufferEpochs: number[] = [];
  private readonly opcodeHandlers = new Map<string, Set<AnyHandler>>();
  private readonly anyHandlers = new Set<AnyHandler>();
  private readonly waiters = new Set<Waiter>();
  private readonly consumers = new Set<Consumer>();

  /** seq we expect next. Drives gap detection. */
  private expectedSeq: number;
  private sawAnyEvent = false;
  private gapCount = 0;
  private epochCounter = 0;

  constructor(options: EventStreamOptions) {
    this.token = options.token;
    this.url = `${options.url}?token=${encodeURIComponent(options.token)}`;
    this.bufferSize = options.bufferSize ?? 500;
    this.expectedSeq = options.expectFromSeq ?? 0;
    this.reconnectEnabled = options.reconnect ?? true;
    this.minDelay = options.reconnectMinDelayMs ?? 250;
    this.maxDelay = options.reconnectMaxDelayMs ?? 5000;
    this.WS = options.webSocketImpl ?? WebSocket;
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------- lifecycle

  /** Opens the socket. Resolves once it is open; rejects if the first connect fails. */
  connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = this.openSocket();
    return this.openPromise;
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  /** Number of `stream_gap` events emitted so far. */
  get gaps(): number {
    return this.gapCount;
  }

  /**
   * The current session epoch. Advances whenever the stream detects a session
   * boundary (the module's `seq` restarting) and whenever `advanceEpoch()`
   * marks one explicitly. Capture it before issuing a request and pass it as
   * `waitFor`'s `epoch` to keep a per-session correlation id (`moveId`) from
   * matching an event of any *other* session — a stale buffered result from an
   * earlier one, or a colliding fresh result from a later one.
   */
  get epoch(): number {
    return this.epochCounter;
  }

  /**
   * Mark a session boundary explicitly. Called by the client before
   * `POST /session`, so the boundary exists even if the recreated session's
   * first events never reach this stream (a dropped socket would otherwise
   * delay the seq-restart detection past the next request).
   */
  advanceEpoch(): void {
    this.epochCounter++;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    for (const w of this.waiters) {
      if (!w.settled) {
        w.settled = true;
        w.reject(new EventStreamClosedError());
      }
    }
    this.waiters.clear();
    for (const c of this.consumers) {
      c.done = true;
      c.notify?.();
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new this.WS(this.url);
      this.socket = ws;

      ws.addEventListener("open", () => {
        this.attempt = 0;
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        this.ingest(typeof ev.data === "string" ? ev.data : String(ev.data));
      });
      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new EventStreamClosedError(`failed to connect to ${this.url}`));
        }
      });
      ws.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          reject(new EventStreamClosedError(`connection to ${this.url} closed before open`));
        }
        if (this.socket === ws) this.socket = undefined;
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || !this.reconnectEnabled) return;
    if (this.reconnectTimer !== undefined) return;
    const delay = Math.min(this.maxDelay, this.minDelay * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closedByUser) return;
      this.openSocket().catch(() => {
        /* the close handler reschedules */
      });
    }, delay);
  }

  // -------------------------------------------------------------- ingestion

  /**
   * Feed one raw frame. Public so a replay harness (and the tests) can drive a
   * stream without a socket.
   */
  ingest(frame: string): void {
    const parsed = parseEventFrame(frame);
    if (!parsed.ok) {
      this.emit({
        seq: this.expectedSeq,
        opcode: STREAM_ERROR,
        opcodeId: STREAM_ERROR_ID,
        ts: this.now(),
        synthetic: true,
        data: { message: parsed.error, frame },
      });
      return;
    }
    const event = parsed.event;

    if (!this.sawAnyEvent || event.seq >= this.expectedSeq) {
      if (event.seq > this.expectedSeq) {
        this.emit({
          seq: event.seq,
          opcode: STREAM_GAP,
          opcodeId: STREAM_GAP_ID,
          ts: event.ts,
          synthetic: true,
          data: {
            fromSeq: this.expectedSeq,
            toSeq: event.seq - 1,
            missing: event.seq - this.expectedSeq,
          },
        });
        this.gapCount++;
      }
      this.expectedSeq = event.seq + 1;
    } else {
      // seq went backwards: the session was torn down and recreated under the
      // same token, so the counter restarted. Not a gap; re-baseline, and mark
      // the session boundary so per-session correlation ids cannot leak across.
      this.expectedSeq = event.seq + 1;
      this.epochCounter++;
    }
    this.sawAnyEvent = true;
    this.emit(event);
  }

  private emit(event: StreamEvent): void {
    this.buffer.push(event);
    this.bufferEpochs.push(this.epochCounter);
    if (this.buffer.length > this.bufferSize) {
      const drop = this.buffer.length - this.bufferSize;
      this.buffer.splice(0, drop);
      this.bufferEpochs.splice(0, drop);
    }

    for (const h of this.anyHandlers) h(event);
    const set = this.opcodeHandlers.get(event.opcode);
    if (set) for (const h of [...set]) h(event);

    for (const w of [...this.waiters]) {
      if (w.settled) continue;
      let hit = false;
      try {
        hit = w.predicate(event);
      } catch {
        hit = false;
      }
      if (hit) {
        w.settled = true;
        this.waiters.delete(w);
        w.resolve(event);
      }
    }

    for (const c of this.consumers) {
      c.queue.push(event);
      c.notify?.();
    }
  }

  // --------------------------------------------------------------- delivery

  /** Events retained in the buffer, oldest first. */
  recent(limit?: number): StreamEvent[] {
    return limit === undefined ? [...this.buffer] : this.buffer.slice(-limit);
  }

  on<K extends keyof EventByOpcode>(opcode: K, handler: (event: EventByOpcode[K]) => void): Unsubscribe;
  on(opcode: string, handler: (event: StreamEvent) => void): Unsubscribe;
  on(opcode: string, handler: (event: never) => void): Unsubscribe {
    const h = handler as AnyHandler;
    let set = this.opcodeHandlers.get(opcode);
    if (!set) {
      set = new Set();
      this.opcodeHandlers.set(opcode, set);
    }
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  /** Every event, in arrival order. */
  onAny(handler: (event: StreamEvent) => void): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  once<K extends keyof EventByOpcode>(opcode: K, handler: (event: EventByOpcode[K]) => void): Unsubscribe;
  once(opcode: string, handler: (event: StreamEvent) => void): Unsubscribe;
  once(opcode: string, handler: (event: never) => void): Unsubscribe {
    const h = handler as unknown as AnyHandler;
    const off = this.on(opcode, (event: StreamEvent) => {
      off();
      h(event);
    });
    return off;
  }

  /**
   * Resolve with the first event matching `predicate`.
   *
   * Searches the retained buffer first (see the note at the top of this file):
   * a `waitFor` issued after `POST /session` returned must still be able to see
   * the login events that arrived during the call.
   */
  waitFor(predicate: (event: StreamEvent) => boolean, options: WaitForOptions = {}): Promise<StreamEvent> {
    const { timeout = 10_000, sinceSeq, epoch, sinceEpoch, includeBuffered = true, description, signal } = options;
    // A live event is always tested at its own epoch: `emit` runs synchronously
    // inside `ingest`, after any epoch bump, so `epochCounter` is exact here.
    const matches = (e: StreamEvent): boolean =>
      (sinceSeq === undefined || e.seq >= sinceSeq) &&
      (epoch === undefined || this.epochCounter === epoch) &&
      (sinceEpoch === undefined || this.epochCounter >= sinceEpoch) &&
      predicate(e);

    if (includeBuffered) {
      // Buffered events were ingested at earlier epochs; test the recorded one.
      const idx = this.buffer.findIndex(
        (e, i) =>
          (epoch === undefined || (this.bufferEpochs[i] ?? this.epochCounter) === epoch) &&
          (sinceEpoch === undefined || (this.bufferEpochs[i] ?? this.epochCounter) >= sinceEpoch) &&
          (sinceSeq === undefined || e.seq >= sinceSeq) &&
          predicate(e),
      );
      if (idx >= 0) return Promise.resolve(this.buffer[idx] as StreamEvent);
    }
    if (signal?.aborted) return Promise.reject(new EventAbortedError(signal.reason, description));

    return new Promise<StreamEvent>((resolve, reject) => {
      const waiter: Waiter = { predicate: matches, resolve: () => {}, reject: () => {}, settled: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };
      waiter.resolve = (e) => {
        cleanup();
        resolve(e);
      };
      waiter.reject = (err) => {
        cleanup();
        reject(err);
      };
      function onAbort() {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.reject(new EventAbortedError(signal?.reason, description));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.reject(new EventTimeoutError(timeout, description));
      }, timeout);
      this.waiters.add(waiter);
    });
  }

  /** Wait for the next event with this opcode. */
  waitForOpcode<K extends keyof EventByOpcode>(
    opcode: K,
    options?: WaitForOptions,
  ): Promise<EventByOpcode[K]> {
    return this.waitFor((e) => e.opcode === opcode, {
      description: `a ${String(opcode)} event`,
      ...options,
    }) as Promise<EventByOpcode[K]>;
  }

  /**
   * Iterate events from *now* forward. Each iterator is an independent
   * consumer, so two loops both see every event.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const consumer: Consumer = { queue: [], notify: undefined, done: false };
    this.consumers.add(consumer);
    try {
      for (;;) {
        while (consumer.queue.length > 0) {
          yield consumer.queue.shift() as StreamEvent;
        }
        if (consumer.done) return;
        await new Promise<void>((resolve) => {
          consumer.notify = () => {
            consumer.notify = undefined;
            resolve();
          };
        });
      }
    } finally {
      this.consumers.delete(consumer);
    }
  }
}
