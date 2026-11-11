/**
 * A stand-in for the module, for the tests that run a real sandbox child
 * against a wire: `Bun.serve` speaking the routes a session uses
 * (module/PROTOCOL.md: `/lease`, `/session`, `/action`, `/events`,
 * `/health`), keyed by token so several sessions stay apart. Synthetic
 * throughout: invented names, no game text.
 *
 * It keeps the module's own rules a fan-out depends on: one session per
 * account (a create on a held account reclaims it), a lease secret that
 * reaches its own token alone, and a subscriber that only hears its own
 * session's frames.
 */

import type { ServerWebSocket } from "bun";

export const STUB_PORT_SECRET = "stub-port-secret-0123456789abcdef0123456789abcdef";

export interface StubSession {
  token: string;
  account: string;
  character: string;
  guid: string;
}

export interface StubCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  /** `operator`, `session`, or `none`: which credential the request carried. */
  auth: "operator" | "session" | "none";
}

export interface StubModule {
  baseUrl: string;
  /** Live sessions by token. */
  sessions: Map<string, StubSession>;
  calls: StubCall[];
  /** Push a frame to one token's subscribers, or to every subscriber with `null`. `seq` is filled per token when absent. */
  push(token: string | null, frame: { opcode: string; data: unknown; ts?: number; seq?: number; opcodeId?: number }): void;
  /** How many `/events` sockets are open for a token. */
  subscribers(token: string): number;
  stop(): Promise<void>;
}

export interface StubModuleOptions {
  /** Frames a token's subscriber is sent after its session enters the world. Default: its own create block. */
  onLogin?: (s: StubSession) => { opcode: string; data: unknown }[];
  /** Refuse a create: return an error body and status. */
  refuseSession?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> } | undefined;
  now?: () => number;
}

interface SocketData {
  token: string;
  replay: boolean;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A name as the server stores one: first letter upper, the rest lower. */
export function stubCharacterName(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1).toLowerCase();
}

/** A character's own create block, the one flagged `self`. */
export function selfCreateFrame(s: StubSession, o: { level?: number; health?: number; x?: number; y?: number } = {}): { opcode: string; opcodeId: number; data: unknown } {
  return {
    opcode: "SMSG_UPDATE_OBJECT",
    opcodeId: 0x0a9,
    data: {
      blocks: 1,
      objects: [
        {
          update: "create",
          guid: s.guid,
          objectType: "player",
          self: true,
          moveFlags: 0,
          runSpeed: 7.0,
          pos: { x: o.x ?? -1234.5, y: o.y ?? 987.25, z: 42.125, o: 3.5 },
          fields: { entry: 0, health: o.health ?? 80, maxHealth: 100, level: o.level ?? 3, powerType: 0, power1: 40, maxPower1: 90, playerFlags: 0, unitFlags: 0, race: 1, class: 1 },
        },
      ],
    },
  };
}

export function startStubModule(options: StubModuleOptions = {}): StubModule {
  const now = options.now ?? Date.now;
  const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  const leases = new Map<string, { secret: string; account: string }>();
  const sessions = new Map<string, StubSession>();
  const guids = new Map<string, string>();
  const seqs = new Map<string, number>();
  const calls: StubCall[] = [];
  let leaseCounter = 0;
  let moveIds = 0;

  const guidOf = (character: string): string => {
    let g = guids.get(character);
    if (g === undefined) guids.set(character, (g = String(101 + guids.size)));
    return g;
  };

  const send = (token: string, frame: { opcode: string; data: unknown; ts?: number; seq?: number; opcodeId?: number }): void => {
    const seq = frame.seq ?? seqs.get(token) ?? 0;
    seqs.set(token, seq + 1);
    const line = JSON.stringify({ seq, opcode: frame.opcode, opcodeId: frame.opcodeId ?? 0, ts: frame.ts ?? now(), data: frame.data });
    for (const ws of sockets.get(token) ?? []) ws.send(line);
  };

  const server = Bun.serve<SocketData, never>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const header = req.headers.get("authorization") ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const operator = bearer === STUB_PORT_SECRET;
      const leasedFor = (token: string): boolean => leases.get(token)?.secret === bearer;
      if (url.pathname === "/events") {
        const token = url.searchParams.get("token") ?? "";
        calls.push({ method: "WS", path: `/events${url.searchParams.get("replay") === "1" ? "?replay=1" : ""}`, body: { token }, auth: operator ? "operator" : leasedFor(token) ? "session" : "none" });
        if (!operator && !leasedFor(token)) return json({ ok: false, error: "unauthorized" }, 401);
        if (srv.upgrade(req, { data: { token, replay: url.searchParams.get("replay") === "1" } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as Record<string, unknown> | null);
      const token = typeof body?.["token"] === "string" ? body["token"] : "";
      const auth: StubCall["auth"] = operator ? "operator" : token !== "" && leasedFor(token) ? "session" : "none";
      calls.push({ method: req.method, path: url.pathname, body, auth });
      if (url.pathname === "/health") {
        if (!operator && ![...leases.values()].some((l) => l.secret === bearer)) return json({ ok: false, error: "unauthorized" }, 401);
        return json({ ok: true, module: "mod-wrathbench", protocol: 1, build: "stub", worldStopped: false, sessions: sessions.size, droppedPackets: 0, droppedPacketsLive: 0 });
      }
      if (auth === "none") return json({ ok: false, error: bearer === "" ? "unauthorized" : "token_mismatch" }, bearer === "" ? 401 : 403);
      if (url.pathname === "/lease") {
        if (!operator) return json({ ok: false, error: "operator_only" }, 403);
        if (req.method === "DELETE") return json({ ok: true, token, released: leases.delete(token) });
        const account = typeof body?.["account"] === "string" ? body["account"] : "RUNNER";
        const secret = `${(++leaseCounter).toString(16).padStart(8, "0")}`.padEnd(64, "e");
        leases.set(token, { secret, account });
        return json({ ok: true, token, account, secret, allowGm: body?.["allowGm"] === true });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        const refused = options.refuseSession?.(body ?? {});
        if (refused !== undefined) return json(refused.body, refused.status);
        const account = leases.get(token)?.account ?? (typeof body?.["account"] === "string" ? body["account"] : "RUNNER");
        const character = stubCharacterName(String(body?.["character"] ?? ""));
        if (character === "") return json({ ok: false, error: "missing_character" }, 400);
        // One account, one live session: a create reclaims it from another token.
        for (const [t, s] of sessions) if (s.account === account && t !== token) sessions.delete(t);
        const s: StubSession = { token, account, character, guid: guidOf(character) };
        const already = sessions.get(token)?.character === character;
        sessions.set(token, s);
        if (!already) {
          const frames = options.onLogin?.(s) ?? [selfCreateFrame(s)];
          setTimeout(() => {
            for (const f of frames) send(token, f);
          }, 5);
        }
        return json({ ok: true, account, character, guid: s.guid, inWorld: true });
      }
      if (url.pathname === "/session" && req.method === "DELETE") {
        return sessions.delete(token) ? json({ ok: true }) : json({ ok: false, error: "no_session" }, 404);
      }
      if (url.pathname === "/action" && req.method === "POST") {
        if (!sessions.has(token)) return json({ ok: false, error: "no_session" }, 404);
        const action = String(body?.["action"] ?? "");
        if (action === "move_to") return json({ ok: true, action, moveId: ++moveIds });
        return json({ ok: true, action });
      }
      return json({ ok: false, error: "not_found" }, 404);
    },
    websocket: {
      open(ws) {
        const set = sockets.get(ws.data.token) ?? new Set();
        sockets.set(ws.data.token, set);
        set.add(ws);
        // The reattach: a subscribe to a session already in world is told so,
        // and one that asked for the replay gets what a client holds.
        const s = sessions.get(ws.data.token);
        if (s === undefined) return;
        const state = { character: s.character, guid: s.guid, inWorld: true, map: 0, x: -1234.5, y: 987.25, z: 42.125, o: 3.5, level: 3 };
        setTimeout(() => {
          if (!ws.data.replay) return send(ws.data.token, { opcode: "WB_SESSION_STATE", data: state });
          send(ws.data.token, { opcode: "WB_SESSION_STATE", data: { ...state, replay: true } });
          for (const f of options.onLogin?.(s) ?? [selfCreateFrame(s)]) send(ws.data.token, f);
          send(ws.data.token, { opcode: "WB_REPLAY_DONE", data: { objects: 1 } });
        }, 5);
      },
      message() {
        /* send-only */
      },
      close(ws) {
        sockets.get(ws.data.token)?.delete(ws);
      },
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    sessions,
    calls,
    push(token, frame) {
      if (token !== null) return send(token, frame);
      for (const t of sockets.keys()) send(t, frame);
    },
    subscribers: (token) => sockets.get(token)?.size ?? 0,
    async stop() {
      await server.stop(true);
    },
  };
}
