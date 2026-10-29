/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// mod-wrathbench: the WrathBench control module. A thin bridge: it
// stands up headless WorldSessions, synthesizes CMSG_* into their
// handlers, and taps the outbound SMSG_* stream into filtered JSON events. All
// game semantics live in the TypeScript SDK; this module knows only opcodes and
// sessions.

#include "WbManager.h"

#include "Log.h"
#include "ScriptMgr.h"

using WrathBench::Manager;

// World lifecycle: config, HTTP/WS server start/stop, and the per-tick pump that
// drains queued actions and keeps parked sockets alive.
class WrathBenchWorldScript : public WorldScript
{
public:
    WrathBenchWorldScript() : WorldScript("WrathBenchWorldScript", {
        WORLDHOOK_ON_AFTER_CONFIG_LOAD,
        WORLDHOOK_ON_STARTUP,
        WORLDHOOK_ON_UPDATE,
        WORLDHOOK_ON_SHUTDOWN
    }) { }

    void OnAfterConfigLoad(bool /*reload*/) override
    {
        Manager::Instance().Configure();
    }

    void OnStartup() override
    {
        if (!Manager::Instance().Enabled())
        {
            LOG_INFO("module", "mod-wrathbench disabled (WrathBench.Enable = 0)");
            return;
        }
        Manager::Instance().Start();
        LOG_INFO("module", "mod-wrathbench loaded");
    }

    void OnUpdate(uint32 diff) override
    {
        if (Manager::Instance().Enabled())
            Manager::Instance().Update(diff);
    }

    void OnShutdown() override
    {
        Manager::Instance().Stop();
    }
};

// Outbound packet tap. CanPacketSend fires for every SMSG the server would send
// to a client; for bench sessions we suppress the (parked) socket write and turn
// whitelisted packets into events instead.
class WrathBenchServerScript : public ServerScript
{
public:
    WrathBenchServerScript() : ServerScript("WrathBenchServerScript", {
        SERVERHOOK_CAN_PACKET_SEND
    }) { }

    bool CanPacketSend(WorldSession* session, WorldPacket const& packet) override
    {
        if (!Manager::Instance().Enabled() || !session)
            return true;
        return Manager::Instance().OnPacketSend(session, packet);
    }
};

// Loader entry point: name is derived from the module directory name
// (mod-wrathbench -> Addmod_wrathbenchScripts) by modules/CMakeLists.txt.
void Addmod_wrathbenchScripts()
{
    new WrathBenchWorldScript();
    new WrathBenchServerScript();
}
