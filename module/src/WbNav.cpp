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

#include "WbNav.h"

#include "DetourCommon.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstring>
#include <unordered_set>

namespace WbNav
{
    namespace
    {
        constexpr int VERTS = 3;
    }

    ExcludePolysFilter::ExcludePolysFilter(std::vector<dtPolyRef> const* excluded) : _excluded(excluded)
    {
        setIncludeFlags(PLAYER_FLAGS);
        setExcludeFlags(0);
    }

    bool ExcludePolysFilter::passFilter(dtPolyRef const ref, dtMeshTile const* tile, dtPoly const* poly) const
    {
        if (_excluded && std::find(_excluded->begin(), _excluded->end(), ref) != _excluded->end())
            return false;
        return dtQueryFilter::passFilter(ref, tile, poly);
    }

    dtPolyRef CorePolyAt(dtNavMeshQuery const* query, dtQueryFilter const& filter, float const* point, float* dist)
    {
        float closest[3] = { 0.0f, 0.0f, 0.0f };
        for (float vertical : { 5.0f, 50.0f })
        {
            float extents[3] = { 3.0f, vertical, 3.0f };
            dtPolyRef ref = 0;
            if (dtStatusSucceed(query->findNearestPoly(point, extents, &filter, &ref, closest)) && ref != 0)
            {
                if (dist)
                    *dist = dtVdist(closest, point);
                return ref;
            }
        }
        if (dist)
            *dist = FLT_MAX;
        return 0;
    }

    // The core's smooth path, ported because PathGenerator keeps it private:
    // FindSmoothPath with GetSteerTarget and FixupCorridor (PathGenerator.cpp,
    // GPL-2.0-or-later like this module), unchanged but for the filter, the
    // corridor buffer and the point cap (the caller's) — 4y steps along the
    // surface, each point 0.5y over its polygon, failing when the route needs
    // the whole cap. A straight-path corner list would not do: a 30y corner
    // segment across a 55 degree face averages under the drop guard's slope,
    // and the walk would interpolate through the hill.
    static bool InRangeYZX(float const* v1, float const* v2, float r, float h)
    {
        float const dx = v2[0] - v1[0];
        float const dy = v2[1] - v1[1]; // elevation
        float const dz = v2[2] - v1[2];
        return (dx * dx + dz * dz) < r * r && std::fabs(dy) < h;
    }

    static uint32_t FixupCorridor(dtPolyRef* path, uint32_t npath, uint32_t maxPath, dtPolyRef const* visited, uint32_t nvisited)
    {
        int32_t furthestPath = -1;
        int32_t furthestVisited = -1;
        for (int32_t i = int32_t(npath) - 1; i >= 0; --i)
        {
            bool found = false;
            for (int32_t j = int32_t(nvisited) - 1; j >= 0; --j)
            {
                if (path[i] == visited[j])
                {
                    furthestPath = i;
                    furthestVisited = j;
                    found = true;
                }
            }
            if (found)
                break;
        }
        if (furthestPath == -1 || furthestVisited == -1)
            return npath;

        uint32_t req = nvisited - furthestVisited;
        uint32_t orig = uint32_t(furthestPath + 1) < npath ? furthestPath + 1 : npath;
        uint32_t size = npath > orig ? npath - orig : 0;
        if (req + size > maxPath)
            size = maxPath - req;
        if (size)
            memmove(path + req, path + orig, size * sizeof(dtPolyRef));
        for (uint32_t i = 0; i < req; ++i)
            path[i] = visited[(nvisited - 1) - i];
        return req + size;
    }

    static bool SteerTarget(dtNavMeshQuery const* query, float const* startPos, float const* endPos, float minTargetDist,
        dtPolyRef const* path, uint32_t pathSize, float* steerPos, unsigned char& steerPosFlag, dtPolyRef& steerPosRef)
    {
        static uint32_t const MAX_STEER_POINTS = 3;
        float steerPath[MAX_STEER_POINTS * VERTS];
        unsigned char steerPathFlags[MAX_STEER_POINTS];
        dtPolyRef steerPathPolys[MAX_STEER_POINTS];
        int nsteerPath = 0;
        dtStatus st = query->findStraightPath(startPos, endPos, path, int(pathSize),
            steerPath, steerPathFlags, steerPathPolys, &nsteerPath, int(MAX_STEER_POINTS));
        if (!nsteerPath || dtStatusFailed(st))
            return false;
        uint32_t ns = 0;
        while (ns < uint32_t(nsteerPath))
        {
            if ((steerPathFlags[ns] & DT_STRAIGHTPATH_OFFMESH_CONNECTION)
                || !InRangeYZX(&steerPath[ns * VERTS], startPos, minTargetDist, 1000.0f))
                break;
            ns++;
        }
        if (ns >= uint32_t(nsteerPath))
            return false;
        dtVcopy(steerPos, &steerPath[ns * VERTS]);
        steerPos[1] = startPos[1]; // keep Z value
        steerPosFlag = steerPathFlags[ns];
        steerPosRef = steerPathPolys[ns];
        return true;
    }

    dtStatus SmoothPath(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtQueryFilter const& filter,
        float const* startPos, float const* endPos, dtPolyRef const* polyPath, uint32_t polyPathSize,
        float* smoothPath, uint32_t* smoothPathSize, uint32_t maxSmoothPathSize)
    {
        *smoothPathSize = 0;
        uint32_t nsmoothPath = 0;

        dtPolyRef polys[PLAN_MAX_POLYS];
        memcpy(polys, polyPath, sizeof(dtPolyRef) * polyPathSize);
        uint32_t npolys = polyPathSize;

        float iterPos[VERTS], targetPos[VERTS];
        if (polyPathSize > 1)
        {
            if (dtStatusFailed(query->closestPointOnPolyBoundary(polys[0], startPos, iterPos)))
                return DT_FAILURE;
            if (dtStatusFailed(query->closestPointOnPolyBoundary(polys[npolys - 1], endPos, targetPos)))
                return DT_FAILURE;
        }
        else
        {
            dtVcopy(iterPos, startPos);
            dtVcopy(targetPos, endPos);
        }

        dtVcopy(&smoothPath[nsmoothPath * VERTS], iterPos);
        nsmoothPath++;

        while (npolys && nsmoothPath < maxSmoothPathSize)
        {
            float steerPos[VERTS];
            unsigned char steerPosFlag;
            dtPolyRef steerPosRef = 0;
            if (!SteerTarget(query, iterPos, targetPos, SMOOTH_SLOP, polys, npolys, steerPos, steerPosFlag, steerPosRef))
                break;

            bool endOfPath = (steerPosFlag & DT_STRAIGHTPATH_END) != 0;
            bool offMeshConnection = (steerPosFlag & DT_STRAIGHTPATH_OFFMESH_CONNECTION) != 0;

            float delta[VERTS];
            dtVsub(delta, steerPos, iterPos);
            float len = dtMathSqrtf(dtVdot(delta, delta));
            if ((endOfPath || offMeshConnection) && len < SMOOTH_STEP)
                len = 1.0f;
            else
                len = SMOOTH_STEP / len;

            float moveTgt[VERTS];
            dtVmad(moveTgt, iterPos, delta, len);

            float result[VERTS];
            static uint32_t const MAX_VISIT_POLY = 16;
            dtPolyRef visited[MAX_VISIT_POLY];
            int nvisited = 0;
            if (dtStatusFailed(query->moveAlongSurface(polys[0], iterPos, moveTgt, &filter, result, visited, &nvisited, int(MAX_VISIT_POLY))))
                return DT_FAILURE;
            npolys = FixupCorridor(polys, npolys, PLAN_MAX_POLYS, visited, uint32_t(nvisited));

            query->getPolyHeight(polys[0], result, &result[1]);
            result[1] += 0.5f;
            dtVcopy(iterPos, result);

            if (endOfPath && InRangeYZX(iterPos, steerPos, SMOOTH_SLOP, 1.0f))
            {
                dtVcopy(iterPos, targetPos);
                if (nsmoothPath < maxSmoothPathSize)
                {
                    dtVcopy(&smoothPath[nsmoothPath * VERTS], iterPos);
                    nsmoothPath++;
                }
                break;
            }
            else if (offMeshConnection && InRangeYZX(iterPos, steerPos, SMOOTH_SLOP, 1.0f))
            {
                dtPolyRef prevRef = 0;
                dtPolyRef polyRef = polys[0];
                uint32_t npos = 0;
                while (npos < npolys && polyRef != steerPosRef)
                {
                    prevRef = polyRef;
                    polyRef = polys[npos];
                    npos++;
                }
                for (uint32_t i = npos; i < npolys; ++i)
                    polys[i - npos] = polys[i];
                npolys -= npos;

                float connectionStartPos[VERTS], connectionEndPos[VERTS];
                if (dtStatusSucceed(navMesh->getOffMeshConnectionPolyEndPoints(prevRef, polyRef, connectionStartPos, connectionEndPos)))
                {
                    if (nsmoothPath < maxSmoothPathSize)
                    {
                        dtVcopy(&smoothPath[nsmoothPath * VERTS], connectionStartPos);
                        nsmoothPath++;
                    }
                    dtVcopy(iterPos, connectionEndPos);
                    if (dtStatusFailed(query->getPolyHeight(polys[0], iterPos, &iterPos[1])))
                        return DT_FAILURE;
                    iterPos[1] += 0.5f;
                }
            }

            if (nsmoothPath < maxSmoothPathSize)
            {
                dtVcopy(&smoothPath[nsmoothPath * VERTS], iterPos);
                nsmoothPath++;
            }
        }

        *smoothPathSize = nsmoothPath;
        return nsmoothPath < maxSmoothPathSize ? DT_SUCCESS : DT_FAILURE;
    }

    dtNavMeshQuery const* PlannerQuery(dtNavMesh const* navMesh)
    {
        // Per thread, so a map's update thread never shares a node pool with
        // another's; bound to the mesh it was last initialised on.
        struct Slot
        {
            dtNavMeshQuery* query = nullptr;
            dtNavMesh const* mesh = nullptr;
            ~Slot() { dtFreeNavMeshQuery(query); }
        };
        thread_local Slot slot;
        if (!navMesh)
            return nullptr;
        if (slot.query && slot.mesh == navMesh)
            return slot.query;
        if (!slot.query)
            slot.query = dtAllocNavMeshQuery();
        if (!slot.query || dtStatusFailed(slot.query->init(navMesh, PLAN_MAX_NODES)))
        {
            slot.mesh = nullptr;
            return nullptr;
        }
        slot.mesh = navMesh;
        return slot.query;
    }

    bool PlanCorridor(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtQueryFilter const& filter,
        dtPolyRef startRef, dtPolyRef endRef, float const* start, float const* end, uint32_t maxPoints,
        std::vector<float>& out, char const** why, int* polysOut)
    {
        dtPolyRef polys[PLAN_MAX_POLYS];
        int npolys = 0;
        dtStatus st = query->findPath(startRef, endRef, start, end, &filter, polys, &npolys, PLAN_MAX_POLYS);
        if (polysOut)
            *polysOut = npolys;
        if (dtStatusFailed(st) || npolys <= 0 || (st & DT_PARTIAL_RESULT) || polys[npolys - 1] != endRef)
        {
            *why = "no_route";
            return false;
        }
        std::vector<float> pts(size_t(maxPoints) * VERTS);
        uint32_t npts = 0;
        dtStatus sst = SmoothPath(navMesh, query, filter, start, end, polys, uint32_t(npolys), pts.data(), &npts, maxPoints);
        if (npts >= maxPoints)
        {
            *why = "too_long";
            return false;
        }
        if (dtStatusFailed(sst) || npts < 2)
        {
            *why = "no_route";
            return false;
        }
        pts.resize(size_t(npts) * VERTS);
        out = std::move(pts);
        return true;
    }

    bool OnIsland(dtNavMesh const* navMesh, dtQueryFilter const& filter, dtPolyRef startRef, dtPolyRef ref,
        std::vector<dtPolyRef>* island)
    {
        if (!ref || ref == startRef)
            return false;
        // Breadth-first over the polygons' links, through the polygons the
        // filter lets a path enter, as findPath would expand them.
        std::vector<dtPolyRef> open{ ref };
        std::unordered_set<dtPolyRef> seen{ ref };
        while (!open.empty())
        {
            dtPolyRef cur = open.back();
            open.pop_back();
            dtMeshTile const* tile = nullptr;
            dtPoly const* poly = nullptr;
            if (dtStatusFailed(navMesh->getTileAndPolyByRef(cur, &tile, &poly)))
                continue;
            for (unsigned int i = poly->firstLink; i != DT_NULL_LINK; i = tile->links[i].next)
            {
                dtPolyRef next = tile->links[i].ref;
                if (!next || seen.count(next))
                    continue;
                dtMeshTile const* nt = nullptr;
                dtPoly const* np = nullptr;
                if (dtStatusFailed(navMesh->getTileAndPolyByRef(next, &nt, &np)) || !filter.passFilter(next, nt, np))
                    continue;
                if (next == startRef)
                    return false;
                seen.insert(next);
                if (seen.size() >= ISLAND_MAX_POLYS)
                    return false;
                open.push_back(next);
            }
        }
        if (island)
            island->assign(seen.begin(), seen.end());
        return true;
    }

    bool NearestReachable(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtPolyRef startRef,
        float const* point, float const* extents, dtPolyRef* refOut, float* pointOut, uint32_t* islands)
    {
        ExcludePolysFilter const base;
        std::vector<dtPolyRef> barred;
        ExcludePolysFilter const filter(&barred);
        if (islands)
            *islands = 0;
        for (uint32_t round = 0; round <= NEAREST_MAX_ISLANDS; ++round)
        {
            dtPolyRef ref = 0;
            float closest[3] = { 0.0f, 0.0f, 0.0f };
            if (dtStatusFailed(query->findNearestPoly(point, extents, &filter, &ref, closest)) || ref == 0)
                return false;
            std::vector<dtPolyRef> island;
            if (!OnIsland(navMesh, base, startRef, ref, &island))
            {
                *refOut = ref;
                dtVcopy(pointOut, closest);
                return true;
            }
            if (islands)
                ++*islands;
            barred.insert(barred.end(), island.begin(), island.end());
        }
        return false;
    }
}
