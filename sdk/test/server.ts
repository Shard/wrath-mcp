/**
 * A stand-in for the module: `Bun.serve` speaking the same HTTP + WebSocket
 * shapes as module/PROTOCOL.md, replaying fixture frames. Lets the whole SDK be
 * exercised — including reconnects and error bodies — with no game stack.
 */

import type { ServerWebSocket } from "bun";

export interface StubOptions {
  /** Frames pushed to every subscriber as soon as it connects. */
  onConnect?: (index: number) => readonly string[];
  /** Close the socket after pushing, so the SDK has to reconnect. */
  closeAfterPush?: boolean;
  /** Override handlers per route; return undefined to fall through to defaults. */
  routes?: Partial<Record<"health" | "session" | "action" | "deleteSession", () => Response>>;
  /**
   * `POST /character-delete`, by attempt number. The real module answers `504
   * timeout` until the core has released the character, so a stub that never
   * varies cannot exercise the retry.
   */
  characterDelete?: (attempt: number, body: CharacterDeleteBody) => Response;
  /**
   * Refuse one kind of action while the rest still work — the module rejects a
   * `face` with `409 moving` while a move is running, and only that one.
   * Return undefined to fall through to the default ack.
   */
  failAction?: (action: string) => Response | undefined;
}

export interface CharacterDeleteBody {
  token?: string;
  character?: string;
  account?: string;
}

/** One `POST /session` body, as the SDK sent it. */
export interface CreateSessionBody {
  token?: string;
  character?: string;
  account?: string;
  race?: number;
  class?: number;
  gender?: number;
}

/** One dispatched action body, as the SDK sent it. */
export interface RecordedAction {
  action: string;
  [key: string]: unknown;
}

export interface StubServer {
  baseUrl: string;
  wsUrl: string;
  /** Push a frame to every open subscriber. */
  push(frame: string): void;
  /** Close every open subscriber socket without stopping the server. */
  dropSockets(): void;
  connections: number;
  sockets: ServerWebSocket<{ token: string }>[];
  /** Every `POST /action` body the SDK sent, in order. */
  actions: RecordedAction[];
  /** Every `POST /session` body the SDK sent, in order. */
  sessions: CreateSessionBody[];
  /** Every `POST /character-delete` body, in order. */
  characterDeletes: CharacterDeleteBody[];
  stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startStub(options: StubOptions = {}): StubServer {
  const sockets = new Set<ServerWebSocket<{ token: string }>>();
  let connections = 0;
  let moveIdGen = 0;
  const actions: RecordedAction[] = [];
  const sessions: CreateSessionBody[] = [];
  const characterDeletes: CharacterDeleteBody[] = [];

  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const token = url.searchParams.get("token") ?? "";
        if (srv.upgrade(req, { data: { token } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") {
        return (
          options.routes?.health?.() ??
          json({
            ok: true,
            module: "mod-wrathbench",
            worldStopped: false,
            sessions: sockets.size,
            droppedPackets: 0,
            droppedPacketsLive: 0,
          })
        );
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return req.json().then((body) => {
          sessions.push(body as CreateSessionBody);
          return (
            options.routes?.session?.() ??
            json({
              ok: true,
              token: "stub",
              account: (body as CreateSessionBody).account ?? "RUNNER",
              character: (body as CreateSessionBody).character ?? "Fenwick",
              guid: 7,
              inWorld: true,
            })
          );
        });
      }
      if (url.pathname === "/session" && req.method === "DELETE") {
        return options.routes?.deleteSession?.() ?? json({ ok: true, token: "stub" });
      }
      if (url.pathname === "/character-delete" && req.method === "POST") {
        return req.json().then((body) => {
          const attempt = characterDeletes.length;
          characterDeletes.push(body as CharacterDeleteBody);
          return (
            options.characterDelete?.(attempt, body as CharacterDeleteBody) ??
            json({
              ok: true,
              token: (body as CharacterDeleteBody).token ?? "stub",
              character: (body as CharacterDeleteBody).character ?? "Fenwick",
              deleted: true,
            })
          );
        });
      }
      if (url.pathname === "/action" && req.method === "POST") {
        const override = options.routes?.action?.();
        if (override) return override;
        // The default ack mirrors the module: shape depends on the action, and
        // `move_to` hands back the moveId its WB_MOVE_RESULT will carry.
        return req.json().then((body) => {
          const action = (body as { action?: string }).action ?? "say";
          actions.push({ ...(body as object), action } as RecordedAction);
          const refused = options.failAction?.(action);
          if (refused) return refused;
          if (action === "move_to") {
            return json({ ok: true, action, token: "stub", moveId: ++moveIdGen });
          }
          if (action === "face") {
            const b = body as { orientation?: number; x?: number; y?: number };
            return json({ ok: true, action, token: "stub", orientation: b.orientation ?? 0 });
          }
          return json({ ok: true, action, token: "stub" });
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const frames = options.onConnect?.(connections) ?? [];
        connections++;
        for (const f of frames) ws.send(f);
        if (options.closeAfterPush) {
          // Give the frames a tick to land before tearing the socket down.
          setTimeout(() => ws.close(), 10);
        }
      },
      message() {
        /* the channel is send-only */
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl: base,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    push(frame) {
      for (const ws of sockets) ws.send(frame);
    },
    dropSockets() {
      for (const ws of sockets) ws.close();
    },
    get connections() {
      return connections;
    },
    get sockets() {
      return [...sockets];
    },
    actions,
    sessions,
    characterDeletes,
    async stop() {
      await server.stop(true);
    },
  };
}
