/**
 * `createInspectorApi(source)`: the inspector's read-only HTTP API over a
 * session source (`source.ts`), JSON and server-sent events. It answers the
 * paths under its `base` and returns null for every other, so a host mounts
 * it beside its own routes: the bin (`serve.ts`) at `/api`, a harness's
 * viewer wherever it likes.
 *
 * | path (under `base`) | what |
 * | --- | --- |
 * | `GET /sessions` | every session the caller may see, newest first: `{ sessions: [{ id, session, live }] }` |
 * | `GET /sessions/<id>` | `{ id, session, live }` |
 * | `GET /sessions/<id>/rows/<stream>?from=&to=&kinds=` | `{ stream, from, to, rows }`: the stream's rows with `ts` in `[from, to)`, in the order written; `kinds` a comma list |
 * | `GET /sessions/<id>/tail/<stream>?from=start` | SSE: `{ rows }` frames as the stream grows, each with the cursor as its `id`; from the end unless `from=start`; `Last-Event-ID` resumes |
 * | `GET /sessions/<id>/trace` | the trace index: closed windows and the open tail (`TraceIndexResponse`) |
 * | `GET /sessions/<id>/trace/<t0>` | one packed window (`TraceSegment`); a closed one is cached as immutable |
 * | `GET /sessions/<id>/recent` | the trace near now (`PositionTrace`), or null |
 * | `GET /sessions/<id>/nearby?span=` | the ring's last `span` ms as one window (`NearbyWindow`) |
 * | `GET /sessions/<id>/moves` | every movement intention, oldest first |
 *
 * Nothing here writes, and nothing takes a body. A session the caller's
 * scope does not cover is a 404 on every path, the same as one that does not
 * exist; a request with no scope at all is a 401.
 */

import { SEGMENT_MS, STREAMS, type StreamName } from "@wrathbench/mcp/record/read";
import { NEARBY_SPAN_MS } from "./codec/nearby";
import { SEG_MS } from "./codec/trace";
import { moves, nearbyWindow, recentTrace, traceIndex, traceSegment } from "./readout";
import { OPERATOR, rowsBetween, type SessionHandle, type SessionScope, type SessionSource } from "./source";

export interface InspectorApiOptions {
  /** The path prefix the API answers under, e.g. `/api`; empty is the root. No trailing slash. */
  base?: string;
  /** The scope of a request, or null to refuse it (401). Defaults to the operator's for every request. */
  scope?: (req: Request) => SessionScope | null | Promise<SessionScope | null>;
  /** The clock. Defaults to `Date.now`. */
  now?: () => number;
  /** How often an open tail looks for new rows. Defaults to one second. */
  tailPollMs?: number;
  /** How often an idle tail sends a heartbeat frame. Defaults to fifteen seconds. */
  heartbeatMs?: number;
}

/** The widest range one `rows` read may ask for: a day. */
export const MAX_ROWS_RANGE_MS = 24 * 60 * 60_000;

/** A handler for the API's paths: a response, or null for a path outside `base`. */
export type InspectorApi = (req: Request) => Promise<Response | null>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { ...JSON_HEADERS, "cache-control": "no-store", ...init.headers } });
}

function error(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: message }, { status, headers });
}

function isStream(s: string): s is StreamName {
  return (STREAMS as readonly string[]).includes(s);
}

/** A finite integer query parameter, `fallback` when absent, null when present and not one. */
function intParam(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function createInspectorApi(source: SessionSource, o: InspectorApiOptions = {}): InspectorApi {
  const base = o.base ?? "";
  const scopeOf = o.scope ?? (() => OPERATOR);
  const now = o.now ?? Date.now;
  const tailPollMs = o.tailPollMs ?? 1_000;
  const heartbeatMs = o.heartbeatMs ?? 15_000;

  function tail(req: Request, url: URL, h: SessionHandle, stream: StreamName): Response {
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const stop = (): void => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
    };
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown, id?: string | null): void => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`${id === undefined || id === null ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`));
          } catch {
            stop();
          }
        };
        // Where it starts: the browser's reconnect cursor, else the stream's start or end.
        const resume = req.headers.get("last-event-id");
        let cursor: string | null = resume !== null && resume.length > 0 ? resume : url.searchParams.get("from") === "start" ? null : await h.end(stream);
        let quiet = 0;
        let busy = false;
        const flush = async (): Promise<void> => {
          if (busy || closed) return;
          busy = true;
          try {
            const t = await h.tail(stream, cursor);
            if (t.cursor !== null) cursor = t.cursor;
            if (t.rows.length > 0) {
              quiet = 0;
              send({ rows: t.rows }, cursor);
            } else if ((quiet += tailPollMs) >= heartbeatMs) {
              quiet = 0;
              send({ tick: now() });
            }
          } catch {
            /* the next poll tries again */
          } finally {
            busy = false;
          }
        };
        send({ hello: h.id, stream }, cursor);
        await flush();
        if (!closed) timer = setInterval(() => void flush(), tailPollMs);
      },
      cancel() {
        stop();
      },
    });
    req.signal?.addEventListener("abort", stop);
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }

  async function session(req: Request, url: URL, h: SessionHandle, rest: string): Promise<Response> {
    if (rest === "") return json({ id: h.id, session: await h.session(), live: await h.live() });

    const rowsMatch = /^\/rows\/([a-z]+)$/.exec(rest);
    if (rowsMatch !== null) {
      const stream = rowsMatch[1]!;
      if (!isStream(stream)) return error(404, `no such stream: ${stream}`);
      const t = now();
      const from = intParam(url, "from", t - SEGMENT_MS);
      const to = intParam(url, "to", Math.max(t, (from ?? t) + 1));
      if (from === null || to === null || to <= from) return error(400, "from and to are epoch ms, from before to");
      if (to - from > MAX_ROWS_RANGE_MS) return error(400, `a range is at most ${MAX_ROWS_RANGE_MS} ms`);
      const kindsRaw = url.searchParams.get("kinds");
      const kinds = kindsRaw === null || kindsRaw === "" ? undefined : kindsRaw.split(",").filter((k) => k.length > 0);
      const rows = await rowsBetween(h, stream, { from, to }, kinds === undefined ? undefined : { kinds });
      return json({ stream, from, to, rows });
    }

    const tailMatch = /^\/tail\/([a-z]+)$/.exec(rest);
    if (tailMatch !== null) {
      const stream = tailMatch[1]!;
      if (!isStream(stream)) return error(404, `no such stream: ${stream}`);
      return tail(req, url, h, stream);
    }

    if (rest === "/trace") return json(await traceIndex(h, now()));

    const traceMatch = /^\/trace\/(\d{1,16})$/.exec(rest);
    if (traceMatch !== null) {
      const t0 = Number(traceMatch[1]);
      if (!Number.isSafeInteger(t0) || t0 % SEG_MS !== 0) return error(404, "no such trace window");
      const found = await traceSegment(h, t0, now());
      if (found === null) return error(404, "no trace in that window");
      return new Response(JSON.stringify(found.segment), {
        headers: { ...JSON_HEADERS, "cache-control": found.closed ? "private, max-age=31536000, immutable" : "no-store" },
      });
    }

    if (rest === "/recent") return json(await recentTrace(h, now()));

    if (rest === "/nearby") {
      const span = intParam(url, "span", NEARBY_SPAN_MS);
      if (span === null) return error(400, "span is a number of ms");
      return json(await nearbyWindow(h, span, now()));
    }

    if (rest === "/moves") return json(await moves(h));

    return error(404, "no such path");
  }

  return async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    const sub = path.slice(base.length);
    if (sub !== "/sessions" && !sub.startsWith("/sessions/")) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return error(405, "read-only", { allow: "GET, HEAD" });

    const scope = await scopeOf(req);
    if (scope === null) return error(401, "a bearer credential is required", { "www-authenticate": "Bearer" });

    if (sub === "/sessions" || sub === "/sessions/") return json({ sessions: await source.list(scope) });

    const m = /^\/sessions\/([^/]+)(\/.*)?$/.exec(sub);
    if (m === null) return error(404, "no such path");
    const h = await source.open(m[1]!, scope);
    if (h === null) return error(404, `no such session: ${m[1]}`);
    return await session(req, url, h, m[2] ?? "");
  };
}
