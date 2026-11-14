# wrath-inspector

What a session did, read back: a read-only server over a session store
(`docs/SESSION-FORMAT.md`) and the views that draw it. It reads records and
nothing else. It never calls the module and never holds the port secret, so it
can run anywhere the store can be read, beside a live stack or long after.

It is released with the stack as `@wrathbench/inspector`, in three parts:

- **The server library.** `createInspectorApi(source)` answers read-only JSON
  and server-sent events over a `SessionSource`, and `wrath-inspector` is a bin
  that serves it over a store directory, or a hosted gateway's state
  directory, with its own page.
- **The views.** SolidJS components (`src/views/`, `@wrathbench/inspector/views`):
  the live map, the session list, a session's page, its character (unit
  frame, money, inventory and quest log), its party and its event feed. The
  bin's page (`page/`) is built from them, and a harness's own pages import
  them. Beside them, the pure logic a map plays a session with, each its own
  entry point: the trace player and its live and replay clocks
  (`…/traceplayer`), a track's cursor maths and route (`…/replay`), the
  transport's arithmetic (`…/playback`), movement intentions
  (`…/mapintent`), a feed's clock (`…/feedclock`) and the camera's fit
  (`…/mapfit`). The shapes a map's feeds carry are `SessionPosition` and
  `SessionTrack` in the wire types, which a harness's own feed extends.
- **The codecs.** The trace and the ring of nearby units, packed per window
  for a map (`src/codec/trace.ts`, `src/codec/nearby.ts`, where each format is
  specified), a replay track's inventory as patches (`src/codec/inventory.ts`),
  and their wire types (`src/wire.ts`). Browser-safe, so a page bundles them.

## Running it on a bare store

```
bun run --cwd inspector build                              # the page, once, into inspector/dist
bun inspector/src/bin.ts --store <dir>                     # http://127.0.0.1:8091
bun inspector/src/bin.ts --store <dir> --port 9000
WRATH_INSPECTOR_SECRET=… bun inspector/src/bin.ts --store <dir> --host 0.0.0.0
WRATH_INSPECTOR_SECRET=… bun inspector/src/bin.ts --hosted-state <dir> --grants <file> --host 0.0.0.0
```

`--tiles <dir>` gives the map minimap tiles, `<map>/<row>_<col>.png` (the
layout WrathBench's tile extraction writes its masters in); without it the
map draws the tile grid. `--wowhead` lets the page load Wowhead's tooltip
script for item, spell and quest icons and names, a third-party request from
the reader's browser; without it the page makes none. Without a build the page answers with how to make
one, and the API still serves.

`--store` is a session store, the directory `bun mcp/src/main.ts` records
into (`--record-dir`, by default `sessions` beside its state directory), or a
single session directory, such as the one a harness keeps inside a run. The
inspector only reads it: a session being written is followed as it grows.

Bound to loopback, the default, it needs no credential. Bound to any other
address it refuses to start without a bearer secret of at least 16 characters,
from `WRATH_INSPECTOR_SECRET` or the first line of `--secret-file <path>`, and
never from the command line. Every request must then carry
`Authorization: Bearer <secret>`, or the cookie the sign-in sets for a
browser. Whoever holds the secret is the operator and sees every session. It
is not a public surface: it shows raw records, unprojected.

## Hosted: a person's own sessions

`--hosted-state <dir>` reads a hosted gateway's state directory
(`mcp/README.md`, "The hosted gateway") in place of `--store`: the session
store of every credential, `tenants/<credential>/sessions`. With
`--grants <file>` (or `WRATH_MCP_GRANTS_FILE`), the gateway's grants file,
which the inspector only reads, a person signs in with the same `wmk_…` key
their MCP client holds and sees the sessions of every credential their
person holds now, and nobody else's. The file is the gateway's, mode 0600, so
the inspector runs as a user that may read it. Given grants, no request is
anonymous, on loopback too, since a loopback inspector behind a proxy for
tenants must not give every visitor the operator's view; the secret is then
optional, and without it nobody is the operator. Without grants,
`--hosted-state` is as `--store` is: on loopback with no secret, whoever
reaches it is the operator and sees every tenant.

A person is scoped by where a session is, never by what it says. A
credential's directory is written by its host, which runs the tenant's
code, so `owner` in `session.json` is shown and grants nothing, a session's
id is `<credential>.<directory>` from the path rather than its record's
`id`, a record's `group` is kept within its credential, and a link out of a
credential's directory (at the session, its store, a stream, `session.json`,
`live.json` or a segment) reads nothing. A hard link is not caught: one to
another tenant's file needs the writer to be able to read it, which a
deployment denies by keeping each credential's directory to its own
worker's user.

The sign-in, `POST /api/sign-in`, takes the secret or a key as
`Authorization: Bearer …` or in a JSON body (`{ "key": … }`; `{ "secret": … }`
is the same), never in a URL's query, and answers with a cookie,
`wrath_inspector`: an opaque random id, never the credential, `HttpOnly`,
`SameSite=Strict`, `Path=/`, `Secure` over TLS or off loopback, for twelve
hours. Off loopback a browser therefore signs in only over TLS, the bin's
own or a proxy's in front of it. The bin keeps what the id stands for in memory (a restart signs
everyone out), for a key only its digest, and checks it against the grants
file on every request: a key revoked, a grant disabled or removed, ends that
cookie's access at the next request, and an open tail at its next poll.
`POST /api/sign-out` forgets it, and `GET /api/me` says who the page is
signed in as. A key also works as a bearer header on any request, as the
MCP takes it.

Tenant records are hostile strings: the views only ever set text, and a
test (`test/html-sinks.test.ts`) keeps `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write` and their kin out of `src/` and the
page.

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
path, the same as one that does not exist, and a tail ends once its caller
may no longer read it. The bin adds `POST /sign-in`, `POST /sign-out` and
`GET /me` beside them (above).

## The page and the views

The page is the live map with every session beside it, and a page per
session (`#/session/<id>`): what it is, its character now, its party and what
happened to it, the feed following the `events` stream while the session is
live. Drag the map to pan, wheel to zoom, click a pip to see the units around
that character. A session is live while its writer's heartbeat is under two
minutes old. Where a credential is needed the page asks for the secret or a
key, and once signed in names who, with a sign-out.

The views take what they show from the API and from the codecs' readings, and
nothing else: names come from the record's dictionaries, never from game
data. Item, spell and quest links point at Wowhead's Wrath database. Asking
Wowhead's tooltip script for icons and names in the reader's browser is a
third-party request, so it is opt-in: a page calls `enableWowhead()`
(`@wrathbench/inspector/views/wowhead`) to allow it, the bin's page does when
started with `--wowhead`, and otherwise, as where the script is blocked, the
links show the record's names.

The views' own rules are one stylesheet, `@wrathbench/inspector/views/views.css`
(`src/views/views.css`): the classes only they draw. The shell they sit in,
the palette and type-scale tokens and the card, table, badge and button
classes, is the host page's, and the views' stylesheet is imported after it.
The bin's shell is `page/page.css`, WrathBench's dashboard's tokens and
classes taken as they are; the dashboard imports the views' stylesheet and
carries no copy of it.

`bun run --cwd inspector dev` serves the page from source with the API
proxied to a bin on 8091 (`WRATH_INSPECTOR_ORIGIN` points it elsewhere).

## Sources and scope

The API reads through one interface, `SessionSource` (`src/source.ts`): list
the sessions, open one, and on an open session read `session.json` and
`live.json`, list and read a stream's segments for a time range, and tail a
stream. Every read is asynchronous, so a source may be a network away.
`storeSource(dir)` is the one over a store directory; a harness implements its
own over its own layout (WrathBench maps its runs to their `session/`
directories and reads runs from before the format through an adapter), and
everything the inspector derives is built on those reads in `src/readout.ts`.

A listing may say which sessions belong together: an entry's `group` is the
same for the sessions one client drove (a fan-out client's characters; a
harness's own unit, as WrathBench's run). `storeSource` takes it from the
record's `group` label. The session list shows a group as one block, and a
session's page links its siblings.

Every read is scoped (wrath-mcp#29): the operator sees every session, and a
user (`{ kind: "user", person, credentials }`) the sessions in the stores of
the credentials, grant ids, they hold. A source filters by the scope it is
handed, on the listing and on every open, and the API asks a hook (`scope`)
for each request's; the bin's is `inspectorAuth` (`src/auth.ts`).
`hostedSource(stateDir)` places each session under its credential by path
and checks `credentialInScope`. A source that cannot place a session under a
credential, `storeSource` or a harness's own, shows a user nothing:
`inScope(session, scope)` is true for the operator alone, because a record's
labels are its writer's.

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
reader and the format's types) and `@wrathbench/mcp/hosted/grants-read` (the
grants file's reader and `authenticate`, for the sign-in) and nothing else,
and nothing those entries load, nor anything of the inspector's own, writes
or deletes a file. `sdk/`
and `mcp/` never import it or the UI's dependencies, which are this
package's alone. Its browser-side files (`src/wire.ts`, `src/codec/`,
`src/views/`, `page/`) import no runtime built-in and nothing of its server
side. `scripts/boundary.ts` holds all of it. The views also typecheck under
the strictest flags an embedding page compiles them with
(`tsconfig.views.json`). The session record's format is
`docs/SESSION-FORMAT.md`; the inspector changes with it in the same pull
request.
