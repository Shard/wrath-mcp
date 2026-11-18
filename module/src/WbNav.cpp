/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

#include "WbNav.h"

#include "DetourCommon.h"
#include "WbRoute.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
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

    float SteepShare(dtMeshTile const* tile, dtPoly const* poly)
    {
        if (!tile || !poly || poly->getType() != DT_POLYTYPE_GROUND || !tile->detailMeshes)
            return 0.0f;
        unsigned int const ip = (unsigned int)(poly - tile->polys);
        dtPolyDetail const& pd = tile->detailMeshes[ip];
        float steep = 0.0f, total = 0.0f;
        for (int j = 0; j < pd.triCount; ++j)
        {
            unsigned char const* t = &tile->detailTris[(pd.triBase + j) * 4];
            float const* v[3];
            for (int k = 0; k < 3; ++k)
                v[k] = t[k] < poly->vertCount
                    ? &tile->verts[poly->verts[t[k]] * 3]
                    : &tile->detailVerts[(pd.vertBase + (t[k] - poly->vertCount)) * 3];
            float e0[3], e1[3], n[3];
            dtVsub(e0, v[1], v[0]);
            dtVsub(e1, v[2], v[0]);
            dtVcross(n, e0, e1);
            float const len = dtVlen(n); // twice the triangle's area
            total += len;
            if (WrathBench::Route::SteepSurface(n[1], len)) // Detour's y is up
                steep += len;
        }
        return total > 0.0f ? steep / total : 0.0f;
    }

    SteepCostFilter::SteepCostFilter(std::vector<dtPolyRef> const* excluded, float weight)
        : ExcludePolysFilter(excluded), _weight(weight < 0.0f ? WrathBench::Route::STEEP_COST : weight)
    {
    }

    float SteepCostFilter::getCost(float const* pa, float const* pb,
        dtPolyRef const prevRef, dtMeshTile const* prevTile, dtPoly const* prevPoly,
        dtPolyRef const curRef, dtMeshTile const* curTile, dtPoly const* curPoly,
        dtPolyRef const nextRef, dtMeshTile const* nextTile, dtPoly const* nextPoly) const
    {
        float const cost = dtQueryFilterExt::getCost(pa, pb, prevRef, prevTile, prevPoly, curRef, curTile, curPoly,
            nextRef, nextTile, nextPoly);
        auto it = _share.find(curRef);
        if (it == _share.end())
            it = _share.emplace(curRef, SteepShare(curTile, curPoly)).first;
        return cost * WrathBench::Route::SteepCost(it->second, _weight);
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

    void SurfaceHeights(dtNavMeshQuery const* query, dtQueryFilter const& filter, dtPolyRef startRef, float const* start,
        std::vector<float> const& points, std::vector<float>& heights, std::vector<uint8_t>& known)
    {
        size_t const n = points.size() / VERTS;
        heights.assign(n, 0.0f);
        known.assign(n, 0);
        if (!query || !startRef)
            return;
        float cur[3] = { 0.0f, 0.0f, 0.0f };
        if (dtStatusFailed(query->closestPointOnPolyBoundary(startRef, start, cur)))
            return;
        dtPolyRef curRef = startRef;
        for (size_t i = 0; i < n; ++i)
        {
            float const* target = &points[i * VERTS];
            float result[3] = { 0.0f, 0.0f, 0.0f };
            dtPolyRef visited[SURFACE_MAX_VISITED];
            int nvisited = 0;
            if (dtStatusFailed(query->moveAlongSurface(curRef, cur, target, &filter, result, visited, &nvisited, SURFACE_MAX_VISITED))
                || nvisited <= 0 || dtVdist2DSqr(result, target) > SURFACE_REACH * SURFACE_REACH)
                return;
            dtPolyRef const ref = visited[nvisited - 1];
            float h = 0.0f;
            if (dtStatusFailed(query->getPolyHeight(ref, result, &h)))
            {
                // On the polygon's edge, where the inside test can miss by a hair.
                float closest[3] = { 0.0f, 0.0f, 0.0f };
                if (dtStatusFailed(query->closestPointOnPoly(ref, result, closest, nullptr)))
                    return;
                h = closest[1];
            }
            heights[i] = h;
            known[i] = 1;
            cur[0] = result[0];
            cur[1] = h;
            cur[2] = result[2];
            curRef = ref;
        }
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

    bool ReachableStartLevel(dtNavMesh const* navMesh, dtNavMeshQuery const* query, dtPolyRef startRef, dtPolyRef endRef,
        float const* start, dtPolyRef* refOut, float* pointOut, uint32_t* islandPolys)
    {
        ExcludePolysFilter const base;
        std::vector<dtPolyRef> island;
        if (!startRef || !endRef || !OnIsland(navMesh, base, endRef, startRef, &island))
            return false;
        // The core's first start box (CorePolyAt); a level over the start
        // point is what Detour's nearest-polygon search prefers in it.
        float const extents[3] = { 3.0f, 5.0f, 3.0f };
        dtPolyRef ref = 0;
        float level[3] = { 0.0f, 0.0f, 0.0f };
        if (!NearestReachable(navMesh, query, endRef, start, extents, &ref, level))
            return false;
        float over[3] = { 0.0f, 0.0f, 0.0f };
        bool posOverPoly = false;
        if (dtStatusFailed(query->closestPointOnPoly(ref, start, over, &posOverPoly)) || !posOverPoly)
            return false; // beside the start, not over or under it
        if (over[1] <= start[1])
            return false; // a level under the start: a floor no client falls through
        dtPolyRef const core = CorePolyAt(query, base, over, nullptr);
        if (!core || std::find(island.begin(), island.end(), core) != island.end())
            return false;
        dtMeshTile const* tile = nullptr;
        dtPoly const* poly = nullptr;
        if (dtStatusFailed(navMesh->getTileAndPolyByRef(core, &tile, &poly)) || !(poly->flags & WATER_FLAG))
            return false; // a dry level over the start: a ledge no client climbs
        *refOut = core;
        dtVcopy(pointOut, over);
        if (islandPolys)
            *islandPolys = uint32_t(island.size());
        return true;
    }
}
