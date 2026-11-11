# wrath-inspector

What a session did, read back: a read-only server over a session store
(`docs/SESSION-FORMAT.md`) and the views that draw it. It reads records and
nothing else. It never calls the module and never holds the port secret, so it
can run anywhere the store can be read, beside a live stack or long after.

It has two halves, released with the stack as `@wrathbench/inspector`:

- **The server library.** `createInspectorApi(source)` answers read-only JSON
  and server-sent events over a `SessionSource`, and `wrath-inspector` is a bin
  that serves it over a store directory with its own page.
- **The codecs.** The trace and the ring of nearby units, packed per window
  for a map (`src/codec/trace.ts`, `src/codec/nearby.ts`, where each format is
  specified), and their wire types (`src/wire.ts`). Browser-safe, so a page
  bundles them.

## Running it on a bare store

```
bun inspector/src/bin.ts --store <dir>                     # http://127.0.0.1:8091
bun inspector/src/bin.ts --store <dir> --port 9000
WRATH_INSPECTOR_SECRET=… bun inspector/src/bin.ts --store <dir> --host 0.0.0.0
```

`--store` is a session store, the directory `bun mcp/src/main.ts` records
into (`--record-dir`, by default `sessions` beside its state directory), or a
single session directory, such as the one a harness keeps inside a run. The
inspector only reads it: a session being written is followed as it grows.

Bound to loopback, the default, it needs no credential. Bound to any other
address it refuses to start without a bearer secret of at least 16 characters,
from `WRATH_INSPECTOR_SECRET` or the first line of `--secret-file <path>`, and
never from the command line. Every request must then carry
`Authorization: Bearer <secret>`, or the cookie `POST /api/sign-in` (a JSON
body `{ "secret": … }`) sets for a browser. It is not a public surface: it
shows raw records, unprojected.

## The API

Under `/api` in the bin; wherever a host mounts it otherwise.

| path | what |
| --- | --- |
| `GET /sessions` | every session the caller may see, newest first: `{ sessions: [{ id, session, live }] }` |
| `GET /sessions/<id>` | `{ id, session, live }`: `session.json` and `live.json` |
| `GET /sessions/<id>/rows/<stream>?from=&to=&kinds=` | the stream's rows with `ts` in `[from, to)` (epoch ms, at most a day; the last five minutes by default), in the order written; `kinds` a comma list |
| `GET /sessions/<id>/tail/<stream>?from=start` | SSE: a `hello` frame, then `{ rows }` frames as the stream grows, each with its cursor as the event `id`; from the end, or the start with `from=start`; a reconnect's `Last-Event-ID` resumes where it stopped |
| `GET /sessions/<id>/trace` | the trace index: the closed windows and the open tail, packed |
| `GET /sessions/<id>/trace/<t0>` | one packed window; a closed one never changes and is cached as immutable |
| `GET /sessions/<id>/recent` | the trace near now: the newest closed windows and the tail |
| `GET /sessions/<id>/nearby?span=` | the ring's last `span` ms (at most 15 minutes) as one packed window |
| `GET /sessions/<id>/moves` | every movement intention, oldest first |

The streams are `trace`, `events`, `calls` and `nearby`. Nothing takes a
body and nothing writes. A session the caller may not see is a 404 on every
path, the same as one that does not exist.

## Sources and scope

The API reads through one interface, `SessionSource` (`src/source.ts`): list
the sessions, open one, and on an open session read `session.json` and
`live.json`, list and read a stream's segments for a time range, and tail a
stream. Every read is asynchronous, so a source may be a network away.
`storeSource(dir)` is the one over a store directory; a harness implements its
own over its own layout (WrathBench maps its runs to their `session/`
directories and reads runs from before the format through an adapter), and
everything the inspector derives is built on those reads in `src/readout.ts`.

Every read is scoped (wrath-mcp#29, decision 11): the operator sees every
session, a user only the sessions whose `owner` is theirs. A source filters by
the scope it is handed, on the listing and on every open, and the API asks a
hook (`scope`) for each request's. Today the only scope anything grants is the
operator's: whoever holds the secret, or anyone on loopback. A user's scope
comes with tenancy, as a different hook rather than a change to the interface.

## Embedding

```ts
import { createInspectorApi, storeSource } from "@wrathbench/inspector";

const inspector = createInspectorApi(storeSource("/var/lib/sessions"), { base: "/inspector" });
Bun.serve({ fetch: async (req) => (await inspector(req)) ?? new Response("not found", { status: 404 }) });
```

`createInspectorApi` returns a handler that answers the paths under its `base`
and null for any other, so it mounts beside a host's own routes. The readout
functions (`traceIndex`, `traceSegment`, `nearbyWindow`, `moves`, …) are
exported for a host that serves the same shapes under paths of its own.

## Boundaries

From the stack the inspector imports `@wrathbench/mcp/record/read` (the store
reader and the format's types) and nothing else, and `sdk/` and `mcp/` never
import it; its browser-side files (`src/wire.ts`, `src/codec/`) import no
runtime built-in and nothing of its server side. `scripts/boundary.ts` holds
all three. The session record's format is `docs/SESSION-FORMAT.md`; the
inspector changes with it in the same pull request.
