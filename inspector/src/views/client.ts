/**
 * The views' client for the inspector's API (`api.ts` on the server): one
 * function per route, and a tail over server-sent events. Browser-side, so it
 * imports nothing but wire types. Requests go same-origin with credentials,
 * so the sign-in cookie the bin sets off loopback rides along; a 401 is an
 * `Unauthorized` the page answers with its sign-in.
 */

import type { NearbyWindow, PositionTrace, RowWire, RowsResponse, SessionListResponse, SessionSummary, StreamNameWire, TraceIndexResponse, TraceSegment } from "../wire";

/** The API refused the request for want of a credential. */
export class Unauthorized extends Error {
  constructor() {
    super("a bearer credential is required");
  }
}

export interface InspectorClient {
  readonly base: string;
  sessions(): Promise<SessionListResponse["sessions"]>;
  session(id: string): Promise<SessionSummary>;
  traceIndex(id: string): Promise<TraceIndexResponse>;
  traceSegment(id: string, t0: number): Promise<TraceSegment | null>;
  recent(id: string): Promise<PositionTrace | null>;
  nearby(id: string, spanMs: number): Promise<NearbyWindow>;
  rows(id: string, stream: StreamNameWire, from: number, to: number, kinds?: readonly string[]): Promise<RowWire[]>;
  /**
   * Follow a stream: `onRows` with each batch written after the tail opened
   * (from the stream's start with `fromStart`). Returns the function that
   * closes it. The browser reconnects on its own and resumes where it stopped.
   */
  tail(id: string, stream: StreamNameWire, onRows: (rows: RowWire[]) => void, o?: { fromStart?: boolean }): () => void;
  /** Present the bearer secret; the bin answers with the cookie every later request carries. */
  signIn(secret: string): Promise<boolean>;
}

/** A client for the API at `base` (the bin's is `/api`; a host that mounts it elsewhere passes its own). */
export function createInspectorClient(base = "/api"): InspectorClient {
  const session = (id: string): string => `${base}/sessions/${encodeURIComponent(id)}`;

  async function get<T>(path: string, missing?: T): Promise<T> {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 401) throw new Unauthorized();
    if (res.status === 404 && missing !== undefined) return missing;
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    base,
    async sessions() {
      return (await get<SessionListResponse>(`${base}/sessions`)).sessions;
    },
    session: (id) => get<SessionSummary>(session(id)),
    traceIndex: (id) => get<TraceIndexResponse>(`${session(id)}/trace`),
    traceSegment: (id, t0) => get<TraceSegment | null>(`${session(id)}/trace/${t0}`, null),
    recent: (id) => get<PositionTrace | null>(`${session(id)}/recent`),
    nearby: (id, spanMs) => get<NearbyWindow>(`${session(id)}/nearby?span=${Math.round(spanMs)}`),
    async rows(id, stream, from, to, kinds) {
      const q = new URLSearchParams({ from: String(Math.floor(from)), to: String(Math.ceil(to)) });
      if (kinds !== undefined && kinds.length > 0) q.set("kinds", kinds.join(","));
      return (await get<RowsResponse>(`${session(id)}/rows/${stream}?${q}`)).rows;
    },
    tail(id, stream, onRows, o) {
      const es = new EventSource(`${session(id)}/tail/${stream}${o?.fromStart === true ? "?from=start" : ""}`, { withCredentials: true });
      es.onmessage = (e: MessageEvent<string>) => {
        try {
          const frame = JSON.parse(e.data) as { rows?: RowWire[] };
          if (Array.isArray(frame.rows) && frame.rows.length > 0) onRows(frame.rows);
        } catch {
          /* a frame that does not parse is skipped */
        }
      };
      return () => es.close();
    },
    async signIn(secret) {
      const res = await fetch(`${base}/sign-in`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
      return res.ok;
    },
  };
}
