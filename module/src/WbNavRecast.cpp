/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: Zlib
 *
 * Copyright (c) 2009-2010 Mikko Mononen memon@inside.org
 *
 * This software is provided 'as-is', without any express or implied
 * warranty.  In no event will the authors be held liable for any damages
 * arising from the use of this software.
 * Permission is granted to anyone to use this software for any purpose,
 * including commercial applications, and to alter it and redistribute it
 * freely, subject to the following restrictions:
 * 1. The origin of this software must not be misrepresented; you must not
 *    claim that you wrote the original software. If you use this software
 *    in a product, an acknowledgment in the product documentation would be
 *    appreciated but is not required.
 * 2. Altered source versions must be plainly marked as such, and must not be
 *    misrepresented as being the original software.
 * 3. This notice may not be removed or altered from any source distribution.
 *
 * ALTERED SOURCE. This is not the original Recast Navigation software. It is
 * derived from Recast Navigation (https://github.com/recastnavigation/recastnavigation)
 * at commit c40188c796f089f89a42e0b939d934178dbcfc5c, the version AzerothCore
 * vendors: inRange, fixupCorridor and getSteerTarget from
 * RecastDemo/Source/NavMeshTesterTool.cpp, and the path-follow loop of
 * NavMeshTesterTool::recalc (TOOLMODE_PATHFIND_FOLLOW) as SmoothPath;
 * fixupCorridor is the same merge as DetourCrowd's dtMergeCorridorStartMoved
 * (DetourCrowd/Source/DetourPathCorridor.cpp). Altered by the mod-wrathbench
 * authors:
 *  - the caller's query, filter, corridor (at most PLAN_MAX_POLYS polygons)
 *    and point cap; DT_FAILURE when the walk fills the cap or a query fails;
 *  - a SMOOTH_STEP (4y) step and a SMOOTH_SLOP (0.3y) slop for 0.5 and 0.01;
 *  - on a corridor of more than one polygon, the walk starts and aims at the
 *    nearest points on its first and last polygons' boundaries; on one
 *    polygon, at the given points themselves;
 *  - every point stands 0.5y over its polygon's height, and keeps the height
 *    it has where the polygon gives none;
 *  - getSteerTarget fails on a failed straight-path query;
 *  - no U-turn shortcut (fixupShortcuts), no repeated point at an off-mesh
 *    link (the demo's dotted-line drawing), no debug output points.
 */

#include "WbNav.h"

#include "DetourCommon.h"

#include <cmath>
#include <cstring>

namespace WbNav
{
    namespace
    {
        inline bool inRange(const float* v1, const float* v2, const float r, const float h)
        {
            const float dx = v2[0] - v1[0];
            const float dy = v2[1] - v1[1];
            const float dz = v2[2] - v1[2];
            return (dx*dx + dz*dz) < r*r && fabsf(dy) < h;
        }

        int fixupCorridor(dtPolyRef* path, const int npath, const int maxPath,
                          const dtPolyRef* visited, const int nvisited)
        {
            int furthestPath = -1;
            int furthestVisited = -1;

            // Find furthest common polygon.
            for (int i = npath-1; i >= 0; --i)
            {
                bool found = false;
                for (int j = nvisited-1; j >= 0; --j)
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

            // If no intersection found just return current path.
            if (furthestPath == -1 || furthestVisited == -1)
                return npath;

            // Concatenate paths.

            // Adjust beginning of the buffer to include the visited.
            const int req = nvisited - furthestVisited;
            const int orig = dtMin(furthestPath+1, npath);
            int size = dtMax(0, npath-orig);
            if (req+size > maxPath)
                size = maxPath-req;
            if (size)
                memmove(path+req, path+orig, size*sizeof(dtPolyRef));

            // Store visited
            for (int i = 0; i < req; ++i)
                path[i] = visited[(nvisited-1)-i];

            return req+size;
        }

        bool getSteerTarget(const dtNavMeshQuery* navQuery, const float* startPos, const float* endPos,
                            const float minTargetDist,
                            const dtPolyRef* path, const int pathSize,
                            float* steerPos, unsigned char& steerPosFlag, dtPolyRef& steerPosRef)
        {
            // Find steer target.
            static const int MAX_STEER_POINTS = 3;
            float steerPath[MAX_STEER_POINTS*3];
            unsigned char steerPathFlags[MAX_STEER_POINTS];
            dtPolyRef steerPathPolys[MAX_STEER_POINTS];
            int nsteerPath = 0;
            dtStatus status = navQuery->findStraightPath(startPos, endPos, path, pathSize,
                                                         steerPath, steerPathFlags, steerPathPolys, &nsteerPath, MAX_STEER_POINTS);
            if (!nsteerPath || dtStatusFailed(status))
                return false;

            // Find vertex far enough to steer to.
            int ns = 0;
            while (ns < nsteerPath)
            {
                // Stop at Off-Mesh link or when point is further than slop away.
                if ((steerPathFlags[ns] & DT_STRAIGHTPATH_OFFMESH_CONNECTION) ||
                    !inRange(&steerPath[ns*3], startPos, minTargetDist, 1000.0f))
                    break;
                ns++;
            }
            // Failed to find good point to steer to.
            if (ns >= nsteerPath)
                return false;

            dtVcopy(steerPos, &steerPath[ns*3]);
            steerPos[1] = startPos[1];
            steerPosFlag = steerPathFlags[ns];
            steerPosRef = steerPathPolys[ns];

            return true;
        }
    }

    dtStatus SmoothPath(const dtNavMesh* navMesh, const dtNavMeshQuery* navQuery, const dtQueryFilter& filter,
        const float* startPos, const float* endPos, const dtPolyRef* path, uint32_t pathSize,
        float* smoothPath, uint32_t* smoothPathSize, uint32_t maxSmoothPathSize)
    {
        const int maxSmooth = int(maxSmoothPathSize);
        int nsmoothPath = 0;
        *smoothPathSize = 0;

        // Iterate over the path to find smooth path on the detail mesh surface.
        dtPolyRef polys[PLAN_MAX_POLYS];
        memcpy(polys, path, sizeof(dtPolyRef)*pathSize);
        int npolys = int(pathSize);

        float iterPos[3], targetPos[3];
        if (npolys > 1)
        {
            if (dtStatusFailed(navQuery->closestPointOnPolyBoundary(polys[0], startPos, iterPos)) ||
                dtStatusFailed(navQuery->closestPointOnPolyBoundary(polys[npolys-1], endPos, targetPos)))
                return DT_FAILURE;
        }
        else
        {
            dtVcopy(iterPos, startPos);
            dtVcopy(targetPos, endPos);
        }

        dtVcopy(&smoothPath[nsmoothPath*3], iterPos);
        nsmoothPath++;

        // Move towards target a small advancement at a time until target reached or
        // when ran out of memory to store the path.
        while (npolys && nsmoothPath < maxSmooth)
        {
            // Find location to steer towards.
            float steerPos[3];
            unsigned char steerPosFlag;
            dtPolyRef steerPosRef = 0;

            if (!getSteerTarget(navQuery, iterPos, targetPos, SMOOTH_SLOP,
                                polys, npolys, steerPos, steerPosFlag, steerPosRef))
                break;

            bool endOfPath = (steerPosFlag & DT_STRAIGHTPATH_END) ? true : false;
            bool offMeshConnection = (steerPosFlag & DT_STRAIGHTPATH_OFFMESH_CONNECTION) ? true : false;

            // Find movement delta.
            float delta[3], len;
            dtVsub(delta, steerPos, iterPos);
            len = dtMathSqrtf(dtVdot(delta, delta));
            // If the steer target is end of path or off-mesh link, do not move past the location.
            if ((endOfPath || offMeshConnection) && len < SMOOTH_STEP)
                len = 1;
            else
                len = SMOOTH_STEP / len;
            float moveTgt[3];
            dtVmad(moveTgt, iterPos, delta, len);

            // Move
            float result[3];
            dtPolyRef visited[16];
            int nvisited = 0;
            if (dtStatusFailed(navQuery->moveAlongSurface(polys[0], iterPos, moveTgt, &filter,
                                                          result, visited, &nvisited, 16)))
                return DT_FAILURE;

            npolys = fixupCorridor(polys, npolys, PLAN_MAX_POLYS, visited, nvisited);

            float h = result[1];
            navQuery->getPolyHeight(polys[0], result, &h);
            result[1] = h + 0.5f;
            dtVcopy(iterPos, result);

            // Handle end of path and off-mesh links when close enough.
            if (endOfPath && inRange(iterPos, steerPos, SMOOTH_SLOP, 1.0f))
            {
                // Reached end of path.
                dtVcopy(iterPos, targetPos);
                if (nsmoothPath < maxSmooth)
                {
                    dtVcopy(&smoothPath[nsmoothPath*3], iterPos);
                    nsmoothPath++;
                }
                break;
            }
            else if (offMeshConnection && inRange(iterPos, steerPos, SMOOTH_SLOP, 1.0f))
            {
                // Reached off-mesh connection.
                float linkStart[3], linkEnd[3];

                // Advance the path up to and over the off-mesh connection.
                dtPolyRef prevRef = 0, polyRef = polys[0];
                int npos = 0;
                while (npos < npolys && polyRef != steerPosRef)
                {
                    prevRef = polyRef;
                    polyRef = polys[npos];
                    npos++;
                }
                for (int i = npos; i < npolys; ++i)
                    polys[i-npos] = polys[i];
                npolys -= npos;

                // Handle the connection.
                dtStatus status = navMesh->getOffMeshConnectionPolyEndPoints(prevRef, polyRef, linkStart, linkEnd);
                if (dtStatusSucceed(status))
                {
                    if (nsmoothPath < maxSmooth)
                    {
                        dtVcopy(&smoothPath[nsmoothPath*3], linkStart);
                        nsmoothPath++;
                    }
                    // Move position at the other side of the off-mesh link.
                    dtVcopy(iterPos, linkEnd);
                    float eh = iterPos[1];
                    if (dtStatusFailed(navQuery->getPolyHeight(polys[0], iterPos, &eh)))
                        return DT_FAILURE;
                    iterPos[1] = eh + 0.5f;
                }
            }

            // Store results.
            if (nsmoothPath < maxSmooth)
            {
                dtVcopy(&smoothPath[nsmoothPath*3], iterPos);
                nsmoothPath++;
            }
        }

        *smoothPathSize = uint32_t(nsmoothPath);
        return nsmoothPath < maxSmooth ? DT_SUCCESS : DT_FAILURE;
    }
}
