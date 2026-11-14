/**
 * The channel between the gateway and one credential's worker: JSON-RPC-like
 * messages, one JSON object a line, over one TCP connection the gateway
 * opens (`docs/ARCHITECTURE.md`, "Hosted"). Either side may ask the other:
 * the gateway asks the worker to open its host, run a tool call and shut
 * down; the worker asks the gateway for each lease, logout and release, since
 * only the gateway holds the port secret.
 *
 * Each side treats what the other sends as untrusted input: a line longer
 * than `MAX_LINE_BYTES` closes the connection, a line that is not one JSON
 * object is dropped, and every handler validates its params itself.
 */

import type { Socket } from "node:net";

/** The longest line either side reads before giving up on the peer. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type RpcHandler = (params: unknown) => Promise<unknown>;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

/** One end of the channel. */
export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly notifyHandlers = new Map<string, (params: unknown) => void>();
  private buf = "";
  private isClosed = false;
  /** Settles when the connection closes, from either side. */
  readonly closed: Promise<void>;
  private markClosed!: () => void;

  constructor(private readonly socket: Socket) {
    this.closed = new Promise((r) => (this.markClosed = r));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
  }

  get open(): boolean {
    return !this.isClosed;
  }

  handle(method: string, fn: RpcHandler): void {
    this.handlers.set(method, fn);
  }

  onNotify(method: string, fn: (params: unknown) => void): void {
    this.notifyHandlers.set(method, fn);
  }

  /** Ask the peer; rejects if it answers an error or the connection closes first. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.isClosed) return Promise.reject(new Error("the worker channel is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} got no answer within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.isClosed) this.write({ method, params });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
    this.onClose();
  }

  private write(msg: unknown): void {
    try {
      this.socket.write(`${JSON.stringify(msg)}\n`);
    } catch {
      this.onClose();
    }
  }

  private read(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE_BYTES && !this.buf.includes("\n")) {
      // A peer that sends one unbounded line is not one this side keeps talking to.
      this.close();
      return;
    }
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length > MAX_LINE_BYTES) {
        this.close();
        return;
      }
      if (line.trim().length > 0) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.method === "string") {
      if (typeof msg.id === "number") {
        const id = msg.id;
        const h = this.handlers.get(msg.method);
        if (h === undefined) {
          this.write({ id, error: { message: `unknown method ${msg.method}` } });
          return;
        }
        void h(msg.params).then(
          (result) => this.write({ id, result: result ?? null }),
          (err: unknown) => this.write({ id, error: { message: err instanceof Error ? err.message : String(err) } }),
        );
      } else {
        this.notifyHandlers.get(msg.method)?.(msg.params);
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (p === undefined) return;
    this.pending.delete(msg.id);
    if (msg.error !== undefined && msg.error !== null) {
      const m = (msg.error as { message?: unknown }).message;
      p.reject(new Error(typeof m === "string" ? m : "the peer answered an error"));
    } else {
      p.resolve(msg.result);
    }
  }

  private onClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) p.reject(new Error("the worker channel closed"));
    this.pending.clear();
    this.markClosed();
  }
}
