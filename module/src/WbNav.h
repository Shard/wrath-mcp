/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef WRATHBENCH_NAV_H
#define WRATHBENCH_NAV_H

// The module's own navmesh queries behind move_to (PROTOCOL.md,
// WB_MOVE_RESULT.status): Detour over the server's mmaps and nothing else —
// no Player, no Map — so an offline check of the mesh can compile this file
// as it ships. Path query semantics only; what a move means stays in
// WbManager.cpp and the SDK. Points are in Detour order (y, z, x).

#include "DetourExtended.h"
#include "DetourNavMesh.h"
#include "DetourNavMeshQuery.h"

#include <cstdint>
#include <vector>

namespace WbNav
{
    // The core's own constants (PathGenerator.h, MapDefines.h), restated so
    // this file needs neither; WbManager.cpp static_asserts each against the
    // core's.
    constexpr float SMOOTH_STEP = 4.0f;          // SMOOTH_PATH_STEP_SIZE
    constexpr float SMOOTH_SLOP = 0.3f;          // SMOOTH_PATH_SLOP
    constexpr uint32_t CORE_POINT_PATH = 74;     // MAX_POINT_PATH_LENGTH
    constexpr uint16_t PLAYER_FLAGS = 0x01 | 0x02 | 0x08; // NAV_GROUND | NAV_MAGMA | NAV_WATER (CreateFilter, a Player)
    constexpr uint16_t WATER_FLAG = 0x08;        // NAV_WATER

    // The module's planner: the corridor the core's PathGenerator cannot
    // hold (MAX_PATH_LENGTH 74 polygons from a 1024-node search, MMapMgr) —
    // a mine's tunnels, a long switchback. A bigger node pool searches
    // exactly as the core's does until the core's would have run out, so
    // every route the core completes is the same route here; it only
    // finishes the searches the core abandons. The point cap bounds the
    // walk at what a move can travel: 250y in a straight line is at most
    // about 3x that along a mine's tunnels.
    constexpr int PLAN_MAX_NODES = 16384;
    constexpr int PLAN_MAX_POLYS = 512;
    constexpr uint32_t PLAN_MAX_POINTS = 256;

    // An island: a closed mesh component, smaller than this, that does not
    // hold the mover's start polygon — no route reaches it, however long the
    // search (two by the Deadmines entrance: 7 and 31 polygons). The flood
    // stops at the cap, so a component that large is assumed reachable and
    // costs at most this many polygon visits.
    constexpr uint32_t ISLAND_MAX_POLYS = 1024;
    // How many islands a nearest-reachable query steps past before giving up.
    constexpr uint32_t NEAREST_MAX_ISLANDS = 8;

    // The player's filter (PathGenerator::CreateFilter for a Player, the
    // core's slope-weighted cost) with a set of polygons it may not enter.
    class ExcludePolysFilter : public dtQueryFilterExt
    {
    public:
        explicit ExcludePolysFilter(std::vector<dtPolyRef> const* excluded = nullptr);
        bool passFilter(dtPolyRef const ref, dtMeshTile const* tile, dtPoly const* poly) const override;

    private:
        std::vector<dtPolyRef> const* _excluded;
    };

    // The polygon the core's path builder picks for a point
    // (PathGenerator::GetPolyByLocation on a fresh generator: a 3y x 5y box,
    // then 3y x 50y), with the distance to it.
    dtPolyRef CorePolyAt(dtNavMeshQuery const* query, dtQueryFilter const& filter, float const* point, float* dist);

    // The smooth path along a corridor, the walk the core's path builder
    // makes (PathGenerator::FindSmoothPath, private to it): Recast's
    // path-follow (WbNavRecast.cpp, zlib, from Recast Navigation's demo)
    // with the core's step, slop and lift — SMOOTH_STEP steps along the
    // surface, each point 0.5y over its polygon. A straight-path corner list
    // would not do: a 30y corner segment across a 55 degree face averages
    // under the drop guard's slope, and the walk would interpolate through
    // the hill. `polyPathSize` at most PLAN_MAX_POLYS. Fails when the route
    // needs the whole point cap.
    dtStatus SmoothPath(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtQueryFilter const& filter,
        float const* startPos, float const* endPos, dtPolyRef const* polyPath, uint32_t polyPathSize,
        float* smoothPath, uint32_t* smoothPathSize, uint32_t maxSmoothPathSize);

    // The planner's query on `navMesh`: one per thread, PLAN_MAX_NODES deep,
    // re-bound when the mesh changes. Null when Detour cannot allocate it.
    dtNavMeshQuery const* PlannerQuery(dtNavMesh const* navMesh);

    // One route from startRef to endRef as the core builds one — findPath,
    // then the smooth path along the corridor — into `out` (Detour order,
    // 3 floats a point). False, with `why`, when the corridor does not reach
    // the end polygon ("no_route") or the route would not fit `maxPoints`
    // ("too_long").
    bool PlanCorridor(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtQueryFilter const& filter,
        dtPolyRef startRef, dtPolyRef endRef, float const* start, float const* end, uint32_t maxPoints,
        std::vector<float>& out, char const** why, int* polysOut = nullptr);

    // Whether `ref` lies on an island `startRef` cannot reach: its component
    // closes under ISLAND_MAX_POLYS polygons without holding `startRef`.
    // `island` gets the component when it does. A zero `startRef` (no start
    // polygon) is held by no component.
    bool OnIsland(dtNavMesh const* navMesh, dtQueryFilter const& filter, dtPolyRef startRef, dtPolyRef ref,
        std::vector<dtPolyRef>* island = nullptr);

    // The walkable point nearest `point` within `extents` (Detour's
    // findNearestPoly) whose polygon is not on an island `startRef` cannot
    // reach; up to NEAREST_MAX_ISLANDS islands are stepped past. `islands`
    // counts them.
    bool NearestReachable(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtPolyRef startRef,
        float const* point, float const* extents, dtPolyRef* refOut, float* pointOut, uint32_t* islands = nullptr);

    // The start level a move plans from when the polygon the core picks for
    // the start (`startRef`, CorePolyAt) is on a closed island that does not
    // hold the end's polygon: the water surface directly over the start
    // point itself, inside the core's own 3y x 5y start box, that is not on
    // that island, and on which the core's own pick is not the island again.
    // A two-level spot: the Deadmines pool past the first boss is a
    // 6-polygon floor under the water surface's polygons, the floor nearer in
    // z wherever the character stands, and every route from it ended at the
    // floor's edge. Only water over the start: a character swims up to its
    // surface, while a dry level over it is a ledge no client climbs, and
    // one under it is a floor no client falls through. `pointOut` is the
    // level's point over the start (Detour order), `refOut` the polygon the
    // core picks there, `islandPolys` the start island's size. False when
    // the start's component holds the end, or no such level is there.
    bool ReachableStartLevel(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtPolyRef startRef, dtPolyRef endRef,
        float const* start, dtPolyRef* refOut, float* pointOut, uint32_t* islandPolys);
}

#endif
