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

#ifndef MOD_WRATHBENCH_WBMANAGER_H
#define MOD_WRATHBENCH_WBMANAGER_H

#include "WbHttpServer.h"
#include "WbJson.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <fstream>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

class WorldSession;
class WorldSocket;
class WorldPacket;
class Player;

// The parked-socket client end is an Asio tcp socket; forward-declare the type
// so the header stays free of Asio. Defined in AzerothCore's Socket.h.
#include "Socket.h" // for IoContextTcpSocket
#include <boost/asio/io_context.hpp>

namespace WrathBench
{
    // A waypoint of a resolved navmesh path. Internal to the mover; never leaves
    // the module (docs/CONTRACTS.md: the agent gets progress/arrival/failure
    // events, not the path).
    struct WbVec
    {
        float x{0}, y{0}, z{0};
    };

    // One AreaTrigger.dbc record (3.3.5a). Client-side knowledge: the volumes
    // a client tests its own position against to send CMSG_AREATRIGGER.
    struct AreaTriggerRec
    {
        uint32 id{0};
        float x{0}, y{0}, z{0};
        float radius{0};            // > 0: sphere; else oriented box below
        float boxLength{0}, boxWidth{0}, boxHeight{0}, boxYaw{0};
    };

    // One AreaTable.dbc record (3.3.5a). Client-side knowledge: the client
    // names the zone and subzone it draws on screen from this table.
    struct AreaTableRec
    {
        uint32 mapId{0};
        uint32 parentAreaId{0};     // 0 for a zone; the zone id for a subzone
        std::string name;           // enUS column
    };

    // One Map.dbc record (3.3.5a). Client-side knowledge: the client names
    // the map it loads from this table and reads from the same row whether it
    // is the open world or an instance (the loading screen, the instance UI).
    struct MapRec
    {
        uint32 instanceType{0};     // InstanceType: 0 none, 1 party, 2 raid, 3 pvp, 4 arena
        std::string name;           // enUS column
    };

    // One Achievement.dbc record (3.3.5a). Client-side knowledge: the client
    // names an earned achievement and its points from this table.
    struct AchievementRec
    {
        std::string name;           // enUS column
        uint32 points{0};
        uint32 categoryId{0};       // Achievement_Category.dbc id
    };

    // One TaxiNodes.dbc record (3.3.5a). Client-side knowledge: the client
    // names the flight-master window's nodes from this table and draws each
    // one on its flight map at the position the row carries.
    struct TaxiNodeRec
    {
        uint32 mapId{0};
        float x{0.0f}, y{0.0f}, z{0.0f};
        std::string name;           // enUS column
    };

    // One TalentTab.dbc record (3.3.5a). Client-side knowledge: the tab
    // names ("Arms", "Fury", ...) the talent frame draws; the core's own
    // store drops the name column, so the module reads the file itself.
    struct TalentTabRec
    {
        std::string name;           // enUS column
        uint32 classMask{0};
        uint32 page{0};
    };

    // Per-session synthesized-movement state. Touched only on the
    // world thread (DoMoveTo/DoStop/DoFace and the Update tick), so unlocked.
    struct MoveState
    {
        bool active{false};
        bool stopping{false};       // MSG_MOVE_STOP sent, waiting for the server to confirm
        uint64_t moveId{0};
        std::vector<WbVec> points;  // resolved path, points[0] = start
        float pathLength{0};        // yards along `points`, set at dispatch (WB_MOVE_PROGRESS, WB_MOVE_RESULT)
        uint64_t etaMs{0};          // the walker's own time over `points` at dispatch-time speeds (WB_MOVE_PROGRESS, WB_MOVE_RESULT)
        size_t seg{0};              // moving from points[seg] to points[seg+1]
        float segDone{0};           // distance covered on the current segment
        int64_t lastMs{0};          // last tick timestamp
        int64_t lastPacketMs{0};    // last heartbeat dispatch
        int64_t lastProgressMs{0};  // last WB_MOVE_PROGRESS event
        int64_t stopDeadlineMs{0};  // arrival-confirm timeout once stopping
        float curX{0}, curY{0}, curZ{0}, curO{0}; // interpolated client-side position
        float destX{0}, destY{0}, destZ{0};
        bool hasMeshZ{false};       // the mesh resolved the request to a different z
        float meshZ{0};
        float reqX{0}, reqY{0}, reqZ{0}; // the point the agent asked for (echoed on `drop`)
        bool hasDrop{false};        // TickMover found a ledge in the polyline: FinishMove says `drop`
        float dropDz{0};
        bool hasSurfaceZ{false};    // ... and the ledge's foot lies under the ground there (refused forced or not)
        float surfaceZ{0};
        bool force{false};          // request said force: ledges are walked (and fallen off), not refused
        bool inFall{false};         // walking a forced downward ledge: MSG_MOVE_FALL_LAND is owed at its foot
        int64_t fallStartMs{0};     // ... since when (the edge heartbeat), and
        uint64_t fallMs{0};         // ... how long the fall takes (FallMs): the segment is timed by it, not by the run
        bool swimming{false};       // the "client" is swimming: packets carry MOVEMENTFLAG_SWIMMING, pace is swim speed
    };

    // Per-token headless session. See docs/METHODOLOGY.md ("Client fidelity")
    // for the parked-socket design.
    struct BenchSession
    {
        std::string token;
        std::string account;
        uint32 accountId{0};

        // The parked WorldSocket handed to the WorldSession, plus the loopback
        // client end kept open so the connection stays established.
        std::shared_ptr<WorldSocket> socket;
        std::unique_ptr<IoContextTcpSocket> clientEnd;
        WorldSession* ws{nullptr};

        // Desired character (from the /session request).
        std::string charName;
        uint8 charRace{0};
        uint8 charClass{0};
        uint8 charGender{0};

        // Character-delete utility session (POST /character-delete): parks at
        // the character-select stage, sends CMSG_CHAR_DELETE, never logs in.
        bool deleteMode{false};
        // Character-list utility session (POST /characters): parks at the
        // character-select stage, answers with the decoded CMSG_CHAR_ENUM
        // response, never logs in. Episode hygiene for the runner.
        bool listMode{false};

        // Login state machine, driven by the outbound packet tap.
        enum Phase { P_AUTH, P_ENUM, P_CREATE, P_ENUM2, P_LOGIN, P_INWORLD, P_DONE, P_DELETE };
        std::atomic<int> phase{P_AUTH};
        uint64_t targetGuidRaw{0};

        // Account-reclaim wait (create only, world thread only). When a create
        // has to evict a stale/leaked session holding the account, DoCreateSession
        // tears it down and re-queues itself until the core releases the account;
        // this is the wall-clock deadline for that wait, set on the first entry.
        int64_t createDeadlineMs{0};

        // Ack for the in-flight /session request. Set exactly once, by whichever
        // of the kickoff task (sync failure) or the tap (async completion) reaches
        // the terminal state first.
        std::shared_ptr<std::promise<HttpReply>> ack;
        std::atomic<bool> ackFired{false};

        std::atomic<uint64_t> dropCount{0};
        std::atomic<uint64_t> eventSeq{0};
        std::atomic<bool> tearingDown{false};

        // Movement synthesis (world thread only).
        MoveState move;
        uint64_t moveIdGen{0};

        // The client's cast counter (world thread only): the u8 a client
        // stamps on every CMSG_CAST_SPELL and CMSG_USE_ITEM it sends, one
        // more each time. The core keys its "another cast is in progress"
        // refusal on it being nonzero (Spell::prepare), so it runs 1..255 and
        // never 0, which the core reserves for casts no client asked for.
        uint8 castCount{0};
        uint8 NextCastCount() { castCount = castCount == 255 ? 1 : castCount + 1; return castCount; }

        // Areatrigger edge detection (world thread only): the DBC volumes the
        // mover is currently inside, and the map they were tested on. A client
        // sends CMSG_AREATRIGGER once on crossing into a volume and never again
        // while it lingers, so an id fires only when it is newly
        // inside; it is cleared when the mover leaves the volume, changes map,
        // or is teleported, so a re-entry fires again.
        std::vector<uint32> insideTriggers;
        uint32 insideTriggersMap{0xFFFFFFFF};
        // UNIT_FLAG_TAXI_FLIGHT as the last world tick read it (world thread
        // only): the flag turning off is the landing, where the module does
        // the client's own drop to the ground (TickGrounded).
        bool wasTaxiFlight{false};

        // WB_RIDE_PROGRESS pacing while aboard a transport (world thread only).
        int64_t lastRideEmitMs{0};
        // TickTransports: last WB_TRANSPORT_PROGRESS batch for this session,
        // and the transports that batch reported as within range (a car
        // leaving the range gets one last report saying so). World thread only.
        int64_t lastTransportEmitMs{0};
        std::unordered_set<uint64_t> transportsInRange;
        // TickPortals: when the in-range portal set was last tested, and the
        // set (map and trigger ids) the last WB_PORTALS reported. World thread only.
        int64_t lastPortalCheckMs{0};
        std::string portalsKey;

        // The reattach replay (PROTOCOL.md, "/events"). Connections that
        // subscribed with replay=1 and are owed a replay, and when it is
        // due: both under _sessMutex (io threads add, the world thread's
        // TickReplays drains). lastReplayMs is world thread only; the
        // minimum interval between two replays of one session is measured
        // from it. replayTargets is non-null only while the world thread is
        // sending a replay, and points EmitEvent at the connections that
        // asked instead of every subscriber of the token.
        std::vector<std::shared_ptr<IWsConn>> replayWaiters;
        int64_t replayDueMs{0};
        int64_t lastReplayMs{0};
        std::atomic<std::vector<std::shared_ptr<IWsConn>> const*> replayTargets{nullptr};

        // Map transfer in flight: the destination map from SMSG_TRANSFER_PENDING,
        // cleared by SMSG_NEW_WORLD / SMSG_TRANSFER_ABORTED. Set on tap threads,
        // read by the mover on the world thread, hence atomic.
        std::atomic<uint32> pendingTransferMap{0};

        // Rooted, as this "client" has been told: set by SMSG_FORCE_MOVE_ROOT
        // and SMSG_SPLINE_MOVE_ROOT for the character's own guid, cleared by
        // their UNROOT twins (OnRootPacket). A rooted client cannot move, so
        // while it is set the mover stops and move_to is refused `rooted`.
        // Written on tap threads, read on the world thread, hence atomic.
        std::atomic<bool> rooted{false};

        // Teleport-ack pacing (world thread only): when the last ack for a
        // still-pending teleport was queued, 0 when none is pending. See
        // TickTeleportAcks.
        int64_t teleportAckQueuedMs{0};

        // Corpse query (world thread only): a client asks MSG_CORPSE_QUERY once
        // when it becomes a ghost; this latches that ask per death so it is not
        // re-sent every tick. Reset when the player is alive again. See
        // TickCorpseQuery.
        bool corpseQueried{false};

        // Zone/area edge detection (world thread only): the ids last announced
        // as WB_AREA, and the map and instance they were on, sentinel until the
        // first in-world tick so login emits one. See TickAreas.
        uint32 lastZoneId{0xFFFFFFFF};
        uint32 lastAreaId{0xFFFFFFFF};
        uint32 lastMapId{0xFFFFFFFF};
        uint32 lastInstanceId{0xFFFFFFFF};

        // Client-side object cache mirror, fed by the update-object tap. Needed
        // because UPDATETYPE_VALUES blocks carry no object type (a real client
        // resolves them against its own cache). Also tracks which name/creature
        // queries this "client" has already issued. Tap threads -> mutex.
        std::mutex objMutex;
        std::unordered_map<uint64_t, uint8_t> knownObjects;      // guid -> TypeID
        std::unordered_set<uint32_t> queriedCreatures;           // creature entries
        std::unordered_set<uint64_t> queriedNames;               // player guids
        std::unordered_set<uint32_t> queriedItems;               // item entries
        std::unordered_set<uint32_t> queriedPetNumbers;          // pet numbers whose name was asked
        std::unordered_set<uint32_t> queriedGameObjects;         // gameobject entries

        // loot_all: on the next SMSG_LOOT_RESPONSE the tap replays the client's
        // auto-loot sequence (AUTOSTORE per slot, LOOT_MONEY, LOOT_RELEASE).
        // Guarded by objMutex (set on world thread, consumed on tap threads).
        bool autoLootPending{false};

        // The audit log (PROTOCOL.md "Audit log"): one file per UTC day,
        // `<token>.<YYYY-MM-DD>.jsonl`, rolled by the writer at the first
        // record after a day boundary. auditDay is the day the open file is
        // for (days since the epoch), -1 until session create opens the first.
        // Both guarded by auditMutex.
        std::ofstream audit;
        std::mutex auditMutex;
        int64_t auditDay{-1};
    };

    // A lease binds a session token to one account and — once the first
    // POST /session under it succeeds — one character, and carries the random
    // secret the module issued for it. Issued to the operator
    // (port-secret) caller, handed by the runner to the snippet child, and the
    // only credential the child ever holds: it authenticates /session, /action,
    // DELETE /session and /events for exactly this token, and nothing else.
    struct Lease
    {
        std::string account;
        std::string character;      // empty until the first successful create
        std::string secret;         // 64 hex chars
    };

    // Which credential a request presented (PROTOCOL.md, "Authentication").
    enum class Cred { None, Operator, Session };

    class Manager : public IHttpSink
    {
    public:
        static Manager& Instance();

        // Lifecycle, all on the world thread.
        void Configure();
        void Start();
        void Stop();
        bool Enabled() const { return _enabled; }

        // Called from WorldScript::OnUpdate (world thread): drains queued work and
        // keeps parked sockets from being reaped as idle.
        void Update(uint32 diff);

        // Called from ServerScript::CanPacketSend. Returns true to let the packet
        // flow to the (parked) socket, false to suppress it. Bench-session packets
        // are always suppressed; whitelisted ones become JSON events first.
        bool OnPacketSend(WorldSession* ws, WorldPacket const& packet);

        // IHttpSink (io_context threads).
        HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body,
            std::string const& authorization, bool loopbackPeer) override;
        bool AuthorizeWs(std::string const& token, std::string const& authorization) override;
        void OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn, bool replay) override;
        void OnWsClose(std::string const& token, IWsConn* conn) override;

    private:
        Manager() = default;

        // World-thread task queue.
        void PushTask(std::function<void()> fn);

        // Request handlers. The HandleHttp* run on io threads and marshal onto the
        // world thread via PushTask; the Do* run on the world thread.
        // Resolve the Authorization header to a credential class. Operator:
        // the bearer is the port secret (WrathBench.Secret). Session: it is a
        // lease's secret, and *leaseToken/*lease name that lease. None
        // otherwise. Constant-time compares; io threads.
        Cred Authenticate(std::string const& authorization, std::string* leaseToken, Lease* lease) const;
        // POST /lease and DELETE /lease (operator only).
        HttpReply HttpLease(std::string const& body);
        HttpReply HttpReleaseLease(std::string const& body);
        std::string PortSecret() const;

        // forcedAccount: non-empty for a session-class create — the lease's
        // account, which overrides whatever the body says.
        HttpReply HttpCreateSession(std::string const& body, std::string const& forcedAccount = "");
        HttpReply HttpAction(std::string const& body);
        HttpReply HttpDeleteSession(std::string const& body);
        HttpReply HttpCharacterDelete(std::string const& body);
        HttpReply HttpCharacterList(std::string const& body);
        // operatorView (loopback caller): include the session count and the
        // packet-drop census. Network callers (runner, snippet sandbox) get a
        // liveness-only view — the census is module-internal state no client
        // could observe (docs/CONTRACTS.md).
        HttpReply HttpHealth(bool operatorView);

        void DoCreateSession(std::shared_ptr<BenchSession> s, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoSay(std::string token, std::string text, std::shared_ptr<std::promise<HttpReply>> ack);
        // One handler for every action that is a single synthesized client
        // opcode (targeting, combat, interaction, quests, loot, vendor,
        // inventory, death). body is the raw request JSON, reparsed on the
        // world thread.
        void DoGameAction(std::string token, std::string action, std::string body,
            std::shared_ptr<std::promise<HttpReply>> ack);
        void DoDeleteSession(std::string token, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoMoveTo(std::string token, float x, float y, float z, std::string guid, bool force, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoStop(std::string token, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoFace(std::string token, bool hasO, float o, bool hasXY, float x, float y, std::shared_ptr<std::promise<HttpReply>> ack);

        // Outcome of resolving a move_to against the navmesh (world thread).
        // status is nullptr on success, else one of the typed causes in
        // PROTOCOL.md (WB_MOVE_RESULT.status).
        struct PathResolve
        {
            char const* status{nullptr};
            std::vector<WbVec> points;
            bool hasMeshZ{false};
            float meshZ{0};
            bool hasReached{false};     // path_incomplete / drop: how far the mesh got / the ledge edge
            float reachedX{0}, reachedY{0}, reachedZ{0};
            bool hasDrop{false};        // drop: the vertical step the polyline takes past reachedPos
            float dropDz{0};
            bool hasSurfaceZ{false};    // drop: the step's foot lies under the ground surface at its x,y (surfaceZ)
            float surfaceZ{0};
            bool hasEndLift{false};     // the endpoint's normalized z sat under its mesh polygon and was lifted to it
            float endLiftFrom{0};       // ... from this z (audit only)
            bool hasSnap{false};        // the start was off the mesh and was snapped to the nearest point
            float snapX{0}, snapY{0}, snapZ{0};
            // The start's own polygon is on a closed island that does not hold
            // the end, and the route is planned from the reachable water
            // surface over the start instead (WbNav::ReachableStartLevel), audit
            // only (op: move_start_level): the start itself, the level's z,
            // and the island's size. The route still begins at levelFrom.
            bool hasStartLevel{false};
            float levelFromX{0}, levelFromY{0}, levelFromZ{0}, levelZ{0};
            uint32 levelIslandPolys{0};
            // The request's own polygon is on a closed island the start cannot
            // reach (WbNav::OnIsland), audit only (op: move_end_reachable):
            // its size, and whether the walk goes to the reachable mesh
            // nearest the request instead (endFrom -> endTo).
            uint32 islandPolys{0};
            bool hasEndReachable{false};
            float endFromX{0}, endFromY{0}, endFromZ{0};
            float endToX{0}, endToY{0}, endToZ{0};
            // The core's path and the subdivision both fell short and the
            // module's planner built the route (op: move_long_plan).
            bool longPlan{false};
            uint32 longPolys{0};
            bool nearestSearched{false}; // target_off_mesh: the bounded search for mesh near the target ran
            bool hasNearest{false};      // ... and found a point (nearestX/Y/Z)
            float nearestX{0}, nearestY{0}, nearestZ{0};
            // The steep re-plan (ReplanSteep), audit only (op: move_replan_steep):
            // `ran` whenever the mesh's own route tripped the drop guard.
            struct Replan
            {
                bool ran{false};
                char const* outcome{""};  // "ok" (the re-planned route is the walk), "failed", "skipped"
                char const* reason{""};   // why it failed or was skipped
                uint32 rounds{0};         // re-plans run (at most REPLAN_STEEP_ROUNDS)
                uint32 excluded{0};       // polygons excluded by the last one
                uint32 firstPoints{0};    // the mesh's own route: point count, refused edge, step
                WbVec edge;
                float dz{0};
                uint32 points{0};         // the last re-planned route's point count (0 when none was built)
            } replan;
            // The edge drop past the end of the mesh (TryEdgeDrop), audit only
            // (op: move_edge_drop): `tried` whenever a path_incomplete's
            // request lay below the route's end; `taken` when the route is now
            // the walk on, the fall and the leg below, else `reason`.
            struct EdgeDrop
            {
                bool tried{false};
                bool taken{false};
                char const* reason{""};
                WbVec from;               // the end of the mesh's route
                bool hasEdge{false};      // ... and once found: the lip and where the fall lands
                WbVec edge;
                WbVec landing;
                float walkYards{0};       // from `from` to the edge, off the mesh
                bool landingSnap{false};  // the leg below starts from the mesh nearest the landing
                bool fromStart{false};    // tried again from the route's start after the route's own ledge (`firstReason`)
                char const* firstReason{""};
            } edgeDrop;
        };
        // One pass of the cause ladder at x,y,z; reqZ is the z the agent asked
        // for (meshZ is reported relative to it).
        PathResolve ResolvePathAt(Player* player, float x, float y, float z, float reqZ, bool force = false);
        // The tail of the cause ladder over a resolved polyline, the mesh's own
        // route and a steep re-plan alike: the endpoint lift, the start-snap leg,
        // the drop guard and meshZ. `refusing`, when given, collects every
        // segment the guard refuses (the verdict is the first).
        void SettleRoute(Player* player, PathResolve& r, float z, float reqZ, bool force,
            std::vector<size_t>* refusing = nullptr);
        // After the guard refused the mesh's route from (sx, sy, sz): plan again
        // with the polygons under the refused segments excluded and take the
        // first route the guard passes. `r` is replaced only then; otherwise
        // only its `replan` record changes.
        void ReplanSteep(Player* player, float sx, float sy, float sz, float x, float y, float z, float reqZ,
            bool force, std::vector<size_t> const& refusing, PathResolve& r);
        // A path_incomplete whose request lies below the end of the mesh's
        // route (`partial`, from the planned start): walk on from that end
        // toward the request to an edge, fall to the surface below, and route
        // on from the landing. `r` becomes that route, settled like any other
        // (a `drop` unforced, walked forced), only when the fall is its one
        // ledge and the leg below reaches the request; otherwise only its
        // `edgeDrop` record changes.
        void TryEdgeDrop(Player* player, std::vector<WbVec> const& partial, float x, float y, float z, float reqZ,
            bool force, PathResolve& r);
        // The z-ladder around it: ground height at x,y first for a unit
        // target, as a fallback after target_off_mesh otherwise; then the
        // mesh's walkable level over x,y when it is the column's only one
        // (`usedMeshZ`, with the level in `groundZOut`).
        PathResolve ResolvePath(Player* player, float x, float y, float z, bool unitTarget,
            bool* usedGroundZ = nullptr, float* groundZOut = nullptr, bool force = false, bool* usedMeshZ = nullptr);

        // AreaTrigger.dbc as the client ships it: the
        // module reads the DBC from the server data volume so the mover can
        // send CMSG_AREATRIGGER on entering a volume, exactly as a client does
        // without the player choosing to. The server still applies its own
        // IsInAreaTriggerRadius check, so a wrong client-side hit is harmless.
        bool LoadAreaTriggerDbc(std::string const& path);
        // Edge-triggered: queues CMSG_AREATRIGGER (and emits WB_AREATRIGGER)
        // when the interpolated position enters a volume the session was not
        // already inside. World thread only.
        void CheckAreaTriggers(BenchSession& s, Player* player, float x, float y, float z, int64_t nowMs);
        std::unordered_map<uint32, std::vector<AreaTriggerRec>> _areaTriggers; // by map
        bool _areaTriggersLoaded{false};

        // AreaTable.dbc as the client ships it: zone and
        // subzone names. The ids themselves come from Player::GetZoneAndAreaId,
        // which the server derives from the same terrain data a client reads
        // locally, so the pair is observation-equivalent (PROTOCOL.md, WB_AREA).
        bool LoadAreaTableDbc(std::string const& path);
        std::unordered_map<uint32, AreaTableRec> _areaTable;
        bool _areaTableLoaded{false};

        // Map.dbc as the client ships it: the map's name and
        // InstanceType for the map id SMSG_NEW_WORLD / SMSG_LOGIN_VERIFY_WORLD
        // already carry, served beside it on WB_AREA and WB_SESSION_STATE.
        // Ids only when the file is absent.
        bool LoadMapDbc(std::string const& path);
        std::unordered_map<uint32, MapRec> _maps;
        bool _mapsLoaded{false};

        // Achievement.dbc as the client ships it (issue #8): name,
        // points and category for the ids SMSG_ACHIEVEMENT_EARNED and
        // SMSG_ALL_ACHIEVEMENT_DATA carry. Ids only when the file is absent.
        bool LoadAchievementDbc(std::string const& path);
        std::unordered_map<uint32, AchievementRec> _achievements;
        bool _achievementsLoaded{false};
        // TaxiNodes.dbc as the client ships it: the name
        // the client draws for each node id in SMSG_SHOWTAXINODES. Ids only
        // when the file is absent. Never TaxiPath: routes stay the server's.
        bool LoadTaxiNodesDbc(std::string const& path);
        std::unordered_map<uint32, TaxiNodeRec> _taxiNodes;
        bool _taxiNodesLoaded{false};
        // TalentTab.dbc as the client ships it: tab names for
        // the talent tree the `talent_tree` action serves. Ids only when the
        // file is absent; the tree itself comes from the core's Talent.dbc
        // and TalentTab.dbc stores (the same files a client reads).
        bool LoadTalentTabDbc(std::string const& path);
        std::unordered_map<uint32, TalentTabRec> _talentTabs;
        bool _talentTabsLoaded{false};
        // Faction.dbc reputation index -> faction id, built once at startup
        // from the core's store. The wire carries the index
        // (SMSG_INITIALIZE_FACTIONS position, SMSG_SET_FACTION_STANDING
        // entries); a client names it through this table.
        std::unordered_map<uint32, uint32> _repListToFaction;
        // One `{ repListId, factionId, name, standing, base, reputation }`
        // object: `standing` is the wire value, `base` the client's
        // Faction.dbc base for this race/class, `reputation` their sum (what
        // the reputation pane shows). Tap threads; `player` may be null.
        std::string FactionJson(uint32 repListId, int32 standing, Player* player) const;
        // The class talent tree as the client's talent frame renders it
        // (`talent_tree` action, WB_TALENT_TREE). World thread only.
        std::string TalentTreeJson(Player* player) const;
        void DoTalentTree(std::string token, std::shared_ptr<std::promise<HttpReply>> ack);
        // One `{ achievementId, date, time, name?, points?, categoryId? }`
        // object; `date` is the wire's packed bitfield, `time` its reading.
        std::string AchievementJson(uint32 id, uint32 packedDate) const;
        // Per tick, every in-world session: emit WB_AREA on login and whenever
        // zone or area id changes (walking, teleport, transfer). World thread only.
        void TickAreas();
        void TickPortals(int64_t nowMs);
        // Append mapId/mapName/instanceType/zoneId/zoneName/areaId/areaName for
        // the player's current position to a writer (WB_AREA and
        // WB_SESSION_STATE share it). mapName and instanceType only when
        // Map.dbc has a row for the map.
        void AddAreaFields(Json::Writer& w, Player* player);

        // Mover (world thread only).
        void TickMovers(int64_t nowMs);
        void TickMover(BenchSession& s, int64_t nowMs);
        // Put the mover's body where a client's physics would over (x, y)
        // whose walkable surface is meshZ (m.curX/Y/Z), entering or leaving
        // the water with MSG_MOVE_START_SWIM / MSG_MOVE_STOP_SWIM. World thread.
        void PlaceMover(BenchSession& s, Player* player, float x, float y, float meshZ, uint32 moveFlags, int64_t nowMs);
        // The character when no move_to is driving it (world thread only): a
        // taxi landing is dropped to the ground the way a client's physics
        // drops it, and the live position is tested against the areatrigger
        // volumes every tick, as a client tests its own position every frame.
        void TickGrounded(int64_t nowMs);
        void TickRiders(int64_t nowMs);
        void TickTransports(int64_t nowMs);
        void FinishMove(BenchSession& s, char const* status);

        // Answer pending teleports the way a real client does (world thread
        // only): MSG_MOVE_TELEPORT_ACK / MSG_MOVE_WORLDPORT_ACK through the
        // stock handlers, so the destination is applied and movement resumes.
        void TickTeleportAcks(int64_t nowMs);

        // Forced roots, answered the way a client answers them (tap threads):
        // CMSG_FORCE_MOVE_ROOT_ACK / CMSG_FORCE_MOVE_UNROOT_ACK queued the
        // moment the server's packet is sent, and the rooted state above kept
        // from the root packets, SMSG_MULTIPLE_MOVES' sub-packets included.
        void OnRootPacket(BenchSession& s, WorldSession* ws, uint16_t opcode, WorldPacket const& packet);
        void AnswerForceRoot(BenchSession& s, WorldSession* ws, bool root, uint64_t guid, uint32_t counter);

        // Ask MSG_CORPSE_QUERY once per death, after the ghost's graveyard
        // teleport has been acked, the way a client does on becoming a ghost
        // (world thread only). The answer is tapped as an event.
        void TickCorpseQuery();

        // In-world session guard for action handlers. Returns the player, or
        // nullptr after setting the error reply. World thread only.
        Player* CheckActionSession(std::shared_ptr<BenchSession> const& s,
            std::shared_ptr<std::promise<HttpReply>>& ack);

        // Update-object decoding (tap threads). Returns the event data JSON and
        // issues the creature/name queries a client cache miss would.
        std::string DecodeUpdateObject(BenchSession& s, WorldSession* ws, WorldPacket const& packet);

        // Whitelisted SMSG decoding (tap threads). Needs the session for
        // client-style item-query cache misses and the loot_all auto sequence.
        bool DecodeEvent(BenchSession& s, WorldSession* ws, uint16_t opcode,
            WorldPacket const& packet, std::string& name, std::string& dataJson);

        // Issue CMSG_ITEM_QUERY_SINGLE for entries this "client" has not cached
        // yet (mirrors the creature/name query behaviour). Tap threads.
        void QueryItems(BenchSession& s, WorldSession* ws, std::vector<uint32_t> const& entries);

        // Remove a session from the maps and close its parked socket (a client
        // disconnect at the WorldSession level). World thread only. Returns the
        // session that was removed, or nullptr if the token was unknown.
        std::shared_ptr<BenchSession> TeardownByToken(std::string const& token);

        // Tap helpers (world/map thread).
        void EmitEvent(BenchSession& s, std::string const& opcodeName, uint16_t opcodeId, std::string const& dataJson);
        // Emit one synthetic WB_SESSION_STATE for an in-world session (see
        // module/PROTOCOL.md): the client-visible self state a fresh
        // SMSG_LOGIN_VERIFY_WORLD carries. With `replayTo`, the frame says
        // `replay: true`, the reattach replay follows it (ReplayClientState)
        // and all of it goes to those connections alone. World thread only
        // (reads Player). TickReplays passes the connections that asked; an
        // idempotent same-token createSession and a plain subscribe pass
        // nullptr and get the state frame alone, fanned out as any event.
        void EmitSessionState(std::shared_ptr<BenchSession> const& s,
            std::vector<std::shared_ptr<IWsConn>> const* replayTo);
        // Run the replays that are due: one burst per session, shared by
        // every connection that asked since the last one, no sooner than
        // REPLAY_MIN_INTERVAL_MS after it. World thread, from Update.
        void TickReplays(int64_t nowMs);
        // Re-send what a connected client holds for this character: the login
        // packets that carry state outside update fields, the transports, its
        // own create block with every item and bag, its auras, a create block
        // for everything in its visibility set, and the pet bar, closed by
        // WB_REPLAY_DONE — always, an exception included. Every packet is one
        // the core's own login path sends, built by the core's own builders;
        // nothing is broadcast and no server state moves (PROTOCOL.md,
        // "/events"). World thread only.
        void ReplayClientState(BenchSession& s, Player* player);
        void Audit(BenchSession& s, char const* kind, std::string const& json);
        // Open (or roll to) the session's audit file for a UTC day. auditMutex held.
        void OpenAudit(BenchSession& s, int64_t day);
        void SucceedAck(BenchSession& s);
        void FailAck(BenchSession& s, std::string const& message, int status = 502);

        std::shared_ptr<BenchSession> FindByToken(std::string const& token);
        std::shared_ptr<BenchSession> FindByWs(WorldSession* ws);

        // Is this account on the WrathBench.Accounts allowlist
        // (case-insensitive)? io/world threads. Guarded by _accountMutex:
        // Configure() rewrites the list on every config load, and the
        // worldserver `.reload config` command re-fires that while HTTP
        // worker threads are serving requests.
        bool AccountPermitted(std::string const& account) const;

        // The configured default account (WrathBench.Account), for requests
        // that omit "account". io threads; guarded by _accountMutex (same
        // reload race as the allowlist).
        std::string DefaultAccount() const;

        // config
        bool _enabled{false};
        std::string _bindAddress{"0.0.0.0"};
        uint16_t _port{8086};
        unsigned _threads{2};
        // _account/_accounts are written by Configure() (world thread, re-run
        // on `.reload config`) and read from HTTP worker threads — always
        // through _accountMutex. The other config fields are only consumed at
        // Start() and are not re-applied on reload.
        mutable std::mutex _accountMutex;
        std::string _account{"RUNNER"};
        std::vector<std::string> _accounts; // allowlist; defaults to {_account}
        // The port secret (WrathBench.Secret / AC_WRATH_BENCH_SECRET). Read on
        // io threads under _accountMutex like the allowlist. Start() refuses to
        // listen when it is shorter than 32 characters.
        std::string _secret;
        std::string _auditDir;

        // Leases by token (PROTOCOL.md, "Authentication"). Their own mutex:
        // touched on io threads per request and never on the world thread.
        mutable std::mutex _leaseMutex;
        std::unordered_map<std::string, Lease> _leases;

        std::unique_ptr<HttpServer> _http;

        // Owns the parked sockets' executor. Never run(): the sockets do no async
        // I/O (we never Start() them), so the context exists only to host them.
        boost::asio::io_context _socketIoc;

        std::mutex _taskMutex;
        std::vector<std::function<void()>> _tasks;

        // Lifetime count of dropped (non-whitelisted) outbound packets, surviving
        // session teardown so /health reflects it after a session ends.
        std::atomic<uint64_t> _totalDrops{0};

        // Per-opcode counts of dropped packets, process lifetime. Indexed by
        // opcode id; 0x600 covers the whole 3.3.5 opcode space (max 0x51F).
        // Lock-free: the drop path fires for every non-whitelisted packet on
        // world and map threads. The Manager is a function-local static, so the
        // array starts zeroed by static storage before first use.
        static constexpr size_t kOpcodeSpace = 0x600;
        std::array<std::atomic<uint64_t>, kOpcodeSpace> _dropsByOpcode{};

        std::mutex _sessMutex;
        std::unordered_map<std::string, std::shared_ptr<BenchSession>> _byToken;
        std::unordered_map<WorldSession*, std::shared_ptr<BenchSession>> _byWs;
        std::unordered_map<std::string, std::vector<std::shared_ptr<IWsConn>>> _wsByToken;
    };
}

#endif // MOD_WRATHBENCH_WBMANAGER_H
