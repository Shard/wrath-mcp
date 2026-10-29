# mod-wrathbench

The AzerothCore module that lets an agent drive a character. It runs inside
the worldserver and exposes, over HTTP and WebSocket, exactly what a game
client could see and do: actions go in as the client opcodes a real client
would send, and the packets the server sends back come out as JSON events. The
SDK ([`../sdk/`](../sdk/)) is its only intended caller; a harness, the MCP
server and any script reach the module through the SDK.

Licensed GPL-2.0-or-later; see `LICENSE`. All other original WrathBench code
and documentation are MIT under the root `LICENSE`. AzerothCore remains under
its own upstream licence; see `../THIRD-PARTY-NOTICES.md`.

## What it does

A thin bridge between the SDK and the worldserver, per
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and
[`../docs/CONTRACTS.md`](../docs/CONTRACTS.md):

- Actions: typed HTTP requests turned into the client opcodes (`CMSG_*`) a
  real client would send, dispatched through the character's `WorldSession`
  handler so every server-side check applies unchanged. A raw passthrough
  carries one allowlisted opcode with a caller-built body, for surfaces no
  helper covers yet.
- Events: a tap on the session's outbound packets (`SMSG_*`), filtered to the
  observation contract and published as JSON over WebSocket.
- Movement: `move_to` resolved into the client movement packet sequence along
  an mmaps path, with the areatrigger and transport handling a client would do
  locally.
- Session management: token to character mapping, login, logout, character
  creation.
- Audit log: every action dispatched and observation served.

It stays thin on purpose: it knows opcodes and sessions, never game semantics.
Those live in the TypeScript SDK. If a change here would teach the module what
a quest or a route is, it belongs in `../sdk/` instead.

The wire surface (every endpoint, event shape, status code and constant) is
[`PROTOCOL.md`](PROTOCOL.md), which the SDK is written against. How the module
attaches to the core (the parked `WorldSocket`, the capture hook, the mover) is
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) ("module/").

## Layout

Stock AzerothCore module conventions: copy this directory to
`modules/mod-wrathbench/` in the AzerothCore tree, where CMake auto-discovers
it (sources under `src/`, config under `conf/*.conf.dist`, static loader entry
point `Addmod_wrathbenchScripts()`). The directory name matters:
`mod-wrathbench.cmake` names `modules/mod-wrathbench/src/` when it stamps the
build identity from `-DWRATHBENCH_BUILD`.

## Building, configuring and verifying

The module compiles only inside an AzerothCore tree, at the commit the root
[`README.md`](../README.md) says it is tested against; that README's "Building
the module into a worldserver" is the recipe, and
[`conf/mod_wrathbench.conf.dist`](conf/mod_wrathbench.conf.dist) documents
every setting. There is no host-side build or test here.

`../sdk/examples/live-slice.ts` and `live-move.ts` check a running worldserver
end to end through the SDK. A change to the module is verified against a live
stack by
[WrathBench's smoke scripts](https://github.com/Shard/WrathBench/tree/master/infra/smoke),
which build a worldserver image with it ([`../CONTRIBUTING.md`](../CONTRIBUTING.md),
"Module changes").
