/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The drop guard's verdict on a route, run without an AzerothCore tree:
// WbRoute.h includes nothing of the core's. Built and run by
// scripts/module-route.test.ts; not part of the module (AzerothCore compiles
// src/ only). The routes are invented, shaped like the ones that earned each
// rule. Prints one line per failed check and exits with their count.

#include "WbRoute.h"

#include <cstddef>
#include <cstdio>
#include <vector>

using namespace WrathBench;

static int failures = 0;

static void Check(bool ok, char const* what)
{
    if (ok)
        return;
    ++failures;
    std::printf("FAILED: %s\n", what);
}

// The guard over a whole polyline, as SettleRoute and TickMover run it: the
// first segment it refuses, or -1 when it refuses none. `buried` stands in for
// the world's ground read under a step down (FootUnderSurface).
static long FirstRefused(std::vector<WbVec> const& pts, bool force, bool buried = false)
{
    for (std::size_t i = 0; i + 1 < pts.size(); ++i)
    {
        float dz = 0.0f;
        if (Route::IsDropSegment(pts[i], pts[i + 1], &dz) && Route::RefusesLedge(dz, force, dz < 0.0f && buried))
            return long(i);
    }
    return -1;
}

// A straight polyline from `from`, `n` steps of `d2` yards across, each
// rising `rise`.
static std::vector<WbVec> Line(WbVec from, int n, float d2, float rise)
{
    std::vector<WbVec> pts{ from };
    for (int i = 1; i <= n; ++i)
        pts.push_back({ from.x + d2 * float(i), from.y, from.z + rise * float(i) });
    return pts;
}

static void Guard()
{
    // Stairs and ramps pass: a 4y step of the core's smooth path rising 2.6y
    // (33 degrees), and a 1.9y rise over half a yard (under the 2.0y floor).
    Check(FirstRefused(Line({ 0, 0, 0 }, 3, 4.0f, 2.6f), false) == -1, "a 33 degree stair passes");
    Check(FirstRefused({ { 0, 0, 0 }, { 0.5f, 0, 1.9f } }, false) == -1, "a step under 2.0y passes however steep");

    // A real wall: 5y straight up over 1.5y across, refused both ways, and
    // up whatever the request says.
    std::vector<WbVec> wall{ { 0, 0, 0 }, { 4, 0, 0 }, { 5.5f, 0, 5 }, { 9.5f, 0, 5 } };
    Check(FirstRefused(wall, false) == 1, "a 5y wall up is refused");
    Check(FirstRefused(wall, true) == 1, "a 5y wall up is refused with force");
    std::vector<WbVec> down{ { 9.5f, 0, 5 }, { 5.5f, 0, 5 }, { 4, 0, 0 }, { 0, 0, 0 } };
    Check(FirstRefused(down, false) == 1, "a 5y ledge down is refused unforced");
    Check(FirstRefused(down, true) == -1, "a 5y ledge down is walked with force");
    Check(FirstRefused(down, true, true) == 1, "a ledge down onto a buried foot is refused with force");

    // A sustained 55 degree slope (tan 55 = 1.43, past the 1.2 ramp): every 4y
    // step of it rises 3.3y over 2.3y across.
    Check(FirstRefused(Line({ 0, 0, 0 }, 5, 2.29f, 3.28f), false) == 0, "a sustained 55 degree slope is refused");
    Check(FirstRefused(Line({ 0, 0, 0 }, 5, 2.29f, 3.28f), true) == 0, "a sustained 55 degree climb is refused with force");
    // The bounds themselves: 1.2 x across is not a ledge, a hair past it is.
    Check(!Route::IsDropSegment({ 0, 0, 0 }, { 2.5f, 0, 3.0f }, nullptr), "exactly 1.2 x across is a ramp");
    Check(Route::IsDropSegment({ 0, 0, 0 }, { 2.5f, 0, 3.01f }, nullptr), "past 1.2 x across is a ledge");
}

int main()
{
    Guard();
    if (failures == 0)
        std::printf("ok\n");
    return failures;
}
