/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The drop guard's verdict on a walked route (PROTOCOL.md, `drop`), as
// arithmetic with no core type in it: which segment of a polyline is a ledge,
// and what the guard does with one. The module reads the world (the mesh, the
// ground, the liquid) and hands the numbers in; this file only judges them,
// so the verdict can be compiled and run without an AzerothCore tree
// (module/test/route.cpp) and by an offline mesh check.

#ifndef MOD_WRATHBENCH_WBROUTE_H
#define MOD_WRATHBENCH_WBROUTE_H

#include <cmath>

namespace WrathBench
{
    // A waypoint of a resolved navmesh path. Internal to the mover; never leaves
    // the module (docs/CONTRACTS.md: the agent gets progress/arrival/failure
    // events, not the path).
    struct WbVec
    {
        float x{0}, y{0}, z{0};
    };

    namespace Route
    {
        // A mesh path that falls is a ledge, not a route (nav-probe c4 on map
        // 369: a polyline segment with dz -7.64 over 1.0y of 2D travel was
        // walked, `arrived` was reported from a 2D-only check, and the next
        // move from down there was `start_off_mesh`). A segment is a ledge
        // when it is both tall (> 2.0y, so stairs and stale-z corrections stay
        // `meshZ`) and steeper than a ramp (|dz| > 1.2 x its 2D length, about
        // 50 degrees). Deliberately not the core's SetSlopeCheck: that is a
        // pathing-time preference, this is a verdict on the route the mesh
        // already chose.
        inline constexpr float DROP_MIN_DZ = 2.0f;
        inline constexpr float DROP_SLOPE = 1.2f;

        inline bool IsDropSegment(WbVec const& a, WbVec const& b, float* dzOut)
        {
            float const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            float const d2 = std::sqrt(dx * dx + dy * dy);
            if (dzOut)
                *dzOut = dz;
            return std::fabs(dz) > DROP_MIN_DZ && std::fabs(dz) > DROP_SLOPE * d2;
        }

        // What the guard does with a ledge of signed height `dz`: a step up is
        // refused whatever the request says (no client walks up a ledge), a
        // step down is refused unless the request is forced (then the fall is
        // the server's to judge), and a step down whose foot lies under the
        // ground (`buried`) is refused forced or not (no client falls through
        // terrain).
        inline bool RefusesLedge(float dz, bool force, bool buried)
        {
            return !force || dz > 0.0f || buried;
        }

        // The end of a walked route. The core's path keeps the z the request
        // asked for at its last point and settles it the way it settles every
        // point (NormalizePath: Map::GetHeight looking down from 2y over it),
        // so a request under the road looks down from inside the terrain and
        // keeps the guessed z (or finds a floor buried under the hill: a
        // tunnel roof 45y down in Dun Algaz), and a request in the air over
        // the floor lands on whatever surface lies within 2y under it (in a
        // Deadmines corridor, 1.4y under a request 4.9y over the floor: the
        // last segment then read as a 5.4y climb, refused 863 times). A
        // client's click lands on
        // the ground either way. So the end of the walk is the height of the
        // polygon the path ends on when the settled end sits more than
        // END_SINK_MAX under it or more than END_LIFT_MAX over it, and the
        // arrival reports it as `meshZ`, as any mesh-corrected z. 2y each
        // way: the band the core's own settling tolerates, and the guard's
        // own step. `lower` false keeps an end over its polygon where it is
        // (the caller's: a transport's deck has no mesh, and the polygon
        // under it is the water).
        inline constexpr float END_SINK_MAX = 2.0f;
        inline constexpr float END_LIFT_MAX = 2.0f;

        inline float EndZ(float endZ, float polyZ, bool lower = true)
        {
            if (endZ < polyZ - END_SINK_MAX)
                return polyZ;
            if (lower && endZ > polyZ + END_LIFT_MAX)
                return polyZ;
            return endZ;
        }

        // A walk that ends more than this far from the z the request asked
        // for reports where it ended as `meshZ` (PROTOCOL.md, `arrived`): the
        // request's z was off, and the caller should quote `meshZ` next time.
        inline constexpr float MESH_Z_REPORT = 1.0f;

        inline bool ReportsMeshZ(float endZ, float reqZ)
        {
            return std::fabs(endZ - reqZ) > MESH_Z_REPORT;
        }
    }
}

#endif // MOD_WRATHBENCH_WBROUTE_H
