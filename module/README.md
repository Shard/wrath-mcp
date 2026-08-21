# mod-wrathbench

AzerothCore module for WrathBench. Licensed AGPL-3.0 (inherited from AzerothCore); the rest of the WrathBench repository is MIT.

## Status: skeleton

This is currently a build-pipeline skeleton: a single `WorldScript` that reads `WrathBench.Enable` from `mod_wrathbench.conf` and logs `mod-wrathbench loaded` on world startup. It exists to prove the worldserver image builds the module in and loads it.

## What it will become

A thin bridge between the WrathBench SDK and the worldserver, per `docs/ARCHITECTURE.md` and `docs/CONTRACTS.md`:

- Actions: typed HTTP requests turned into the client opcodes (`CMSG_*`) a real client would send, dispatched through the character's `WorldSession` handler so every server-side check applies unchanged.
- Events: a tap on the session's outbound packets (`SMSG_*`), filtered to the observation contract and published as JSON over WebSocket.
- Session management: token to character mapping, login, logout, character creation.
- Audit log: every action dispatched and observation served.

It stays thin: it knows opcodes and sessions, never game semantics. Those live in the TypeScript SDK.

## Layout

Stock AzerothCore module conventions: the build copies this directory to `modules/mod-wrathbench/` in the AzerothCore tree, where CMake auto-discovers it (sources under `src/`, config under `conf/*.conf.dist`, static loader entry point `Addmod_wrathbenchScripts()`). See `infra/docker/server.Dockerfile`.
