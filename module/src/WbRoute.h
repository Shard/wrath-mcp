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
        // 1.2 is the 3.3.5a client's own limit: the client refuses ground
        // whose surface normal's up component is under cos 50 degrees
        // (CLIENT_WALKABLE_COS), and atan(1.2) is 50.2 degrees, inside a 4y
        // chord's own error. The server's mmaps are built walkable to 60
        // degrees (AzerothCore's mmaps-config.yaml, an NPC default), so a
        // route the mesh plans can cross a 50-60 degree face no client walks
        // up; the steep re-plan (SteepCost) steers around such faces.
        inline constexpr float DROP_MIN_DZ = 2.0f;
        inline constexpr float DROP_SLOPE = 1.2f;
        inline constexpr float CLIENT_WALKABLE_COS = 0.6427876f;

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

        // A point along the route. The core settles each one onto the first
        // floor Map::GetHeight finds looking down from 2.5y over the mesh
        // (its smooth path's 0.5y lift and 2y look), game objects included,
        // so a stair point under a landing is lifted onto the landing
        // (Kharanos: a cellar stair at 395.2 read as 397.5, and the step
        // after it as a 5.1y fall onto a foot "under" the landing, refused
        // forced or not). A point the core lifted more than MESH_LIFT_MAX
        // over the mesh's own height under it (`meshZ`, where `known`) is
        // judged and walked at the mesh's height: the surface the route was
        // smoothed along, which a client's character walks. A point at or
        // under the mesh keeps the core's z: that is the ground, or a swimmer's
        // depth under the water's surface. 1y: twice the smooth path's lift, inside which the core's
        // ground is the better height.
        inline constexpr float MESH_LIFT_MAX = 1.0f;

        inline float PointZ(float coreZ, bool known, float meshZ)
        {
            return known && coreZ > meshZ + MESH_LIFT_MAX ? meshZ : coreZ;
        }

        // A point over water. Where the water is deep enough to swim, the
        // core settles a point to its surface less GetMinHeightInWater (about
        // 1.2y for a player), and its swim test reads that depth as not
        // swimming; the mesh's own polygons there are the surface. A swimmer
        // leaves the water from the surface, as a client's character does,
        // so a climb out measured from 1.2y under it reads 1.2y too tall (the
        // Deadmines cove: a 47-50 degree bank the mesh walks read as a 4.9y
        // climb). A point over water deeper than `swimDepth` (WaterPoseAt's
        // own test: the liquid's Level over its bed) and under its surface
        // is judged and walked at the surface (`water` when the server's
        // liquid query has both; the walker holds the body at its swim depth
        // under that surface, PlaceMover). Water too shallow to swim keeps the
        // core's z, the bed a wading character walks on. A dock face 3y over
        // the water is still a climb.
        inline float WaterZ(float z, bool water, float level, float bed, float swimDepth)
        {
            return water && level - bed > swimDepth && z < level ? level : z;
        }

        // A surface the client will not walk up: its normal (any length, any
        // sign) points less than CLIENT_WALKABLE_COS up. `up` is the normal's
        // vertical component, `len` its length; a degenerate triangle is
        // not steep (it has no surface to stand on or slide off).
        inline bool SteepSurface(float up, float len)
        {
            return len > 0.0f && std::fabs(up) < CLIENT_WALKABLE_COS * len;
        }

        // The steep re-plan's travel cost through a polygon, as a factor on
        // the core's own (dtQueryFilterExt: distance, weighted mildly by
        // slope): 1 + STEEP_COST x the share of the polygon's surface steeper
        // than the client walks (SteepSurface over its detail triangles, by
        // area). A wholly steep polygon costs 1 + STEEP_COST times its
        // distance, so the search goes the long way round a face before it
        // goes up it, and a polygon with a steep corner costs a little more.
        // A penalty, not a bar: a polygon is mixed ground, and barring one
        // for its steep part can cut the only way through (Dun Morogh's
        // hills); the guard still judges the route that comes back.
        inline constexpr float STEEP_COST = 20.0f;

        inline float SteepCost(float steepShare, float weight = STEEP_COST)
        {
            float const share = steepShare < 0.0f ? 0.0f : steepShare > 1.0f ? 1.0f : steepShare;
            return 1.0f + weight * share;
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
