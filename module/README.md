# mod-wrathbench

AzerothCore module for WrathBench. Licensed GPL-2.0-or-later; see `LICENSE`. All other original WrathBench code and documentation are MIT under the root `LICENSE`. AzerothCore remains under its own upstream license; see `../THIRD-PARTY-NOTICES.md`.

## What it is

A thin bridge between the WrathBench SDK and the worldserver, per `../docs/ARCHITECTURE.md` and `../docs/CONTRACTS.md`:

- Actions: typed HTTP requests turned into the client opcodes (`CMSG_*`) a real client would send, dispatched through the character's `WorldSession` handler so every server-side check applies unchanged. A raw passthrough carries one allowlisted opcode with a caller-built body, for surfaces no helper covers yet.
- Events: a tap on the session's outbound packets (`SMSG_*`), filtered to the observation contract and published as JSON over WebSocket.
- Movement: `move_to` resolved into the client movement packet sequence along an mmaps path, with areatrigger and transport handling a client would do locally.
- Session management: token to character mapping, login, logout, character creation.
- Audit log: every action dispatched and observation served.

It stays thin: it knows opcodes and sessions, never game semantics. Those live in the TypeScript SDK.

The wire surface — every endpoint, event shape, status code and constant — is `PROTOCOL.md`, which the SDK is generated against. How the module attaches to the core (the parked `WorldSocket`, the capture hook, the mover) is `../docs/ARCHITECTURE.md`.

## Layout

Stock AzerothCore module conventions: the build copies this directory to `modules/mod-wrathbench/` in the AzerothCore tree, where CMake auto-discovers it (sources under `src/`, config under `conf/*.conf.dist`, static loader entry point `Addmod_wrathbenchScripts()`). See `../infra/docker/server.Dockerfile`.

## Building and verifying

The module compiles only inside the worldserver image, so there is no host-side build or test. Its verification is the smoke scripts in `../infra/smoke/`, which need the live stack (`infra/compose.yml`) and therefore the operator-supplied server data directory at `data/client`.
