/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The walker's clock and its drift guard (TickMover; PROTOCOL.md,
// `interrupted`), as arithmetic with no core type in it, so they can be
// compiled and run without an AzerothCore tree (module/test/walk.cpp).

#ifndef MOD_WRATHBENCH_WBWALK_H
#define MOD_WRATHBENCH_WBWALK_H

#include <algorithm>
#include <cstdint>

namespace WrathBench
{
    namespace Walk
    {
        // A heartbeat every 500ms while walking, as a real client sends.
        inline constexpr int64_t HEARTBEAT_MS = 500;

        // How far the server's position may fall behind the walker's before
        // the walk is judged interrupted (a knockback, a teleport, a server
        // correction), checked before each packet. The server's position is
        // the last packet's, up to a heartbeat plus a map update behind. The
        // character's own walk keeps 15y. A flight, or a walk of another
        // unit, follows the pace, since a mover at several times run speed is
        // legitimately farther from its walker than a runner: 0.8s of the
        // pace plus 10y, never under 15.
        inline constexpr float OWN_DRIFT_YARDS = 15.0f;

        inline float DriftTolerance(bool paced, float pace)
        {
            return paced ? std::max(OWN_DRIFT_YARDS, pace * 0.8f + 10.0f) : OWN_DRIFT_YARDS;
        }

        // The most a single world tick advances the walker. The walker runs
        // inside the world thread, so when the world stalls (seconds without
        // an update) it stalls with it and sends nothing; advanced by the
        // whole gap on the next tick, it stood a stall's worth of yards ahead
        // of the server's last heartbeat and the drift guard ended the walk
        // `interrupted` though nothing had stopped it (a 3s stall at run
        // speed is 21y), or, near the end of a route, it stopped at the
        // destination in one jump no client makes. A client that hitches
        // resumes from where it was, so the walk takes up again from its last
        // point and the stall only delays it. 250ms is well over a normal
        // world tick, so an ordinary walk is unchanged, and keeps the worst
        // lead after a stall (a heartbeat's interval plus one step) inside
        // the 15y guard at any ground pace a character reaches.
        inline constexpr int64_t STEP_MAX_MS = 250;

        // The time a tick advances the walker by, from the wall time since
        // the last tick.
        inline int64_t StepMs(int64_t elapsedMs)
        {
            return std::clamp<int64_t>(elapsedMs, 0, STEP_MAX_MS);
        }

        // The wall time a tick does not advance the walker by: the stall.
        inline int64_t StallMs(int64_t elapsedMs)
        {
            return std::max<int64_t>(elapsedMs, 0) - StepMs(elapsedMs);
        }
    }
}

#endif
