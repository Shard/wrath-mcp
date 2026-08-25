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

    // One Achievement.dbc record (3.3.5a). Client-side knowledge: the client
    // names an earned achievement and its points from this table.
    struct AchievementRec
    {
        std::string name;           // enUS column
        uint32 points{0};
        uint32 categoryId{0};       // Achievement_Category.dbc id
    };

    // Per-session synthesized-movement state. Touched only on the
    // world thread (DoMoveTo/DoStop/DoFace and the Update tick), so unlocked.
    struct MoveState
    {
        bool active{false};
        bool stopping{false};       // MSG_MOVE_STOP sent, waiting for the server to confirm
        uint64_t moveId{0};
        std::vector<WbVec> points;  // resolved path, points[0] = start
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

        // Areatrigger edge detection (world thread only): the DBC volumes the
        // mover is currently inside, and the map they were tested on. A client
        // sends CMSG_AREATRIGGER once on crossing into a volume and never again
        // while it lingers (FOLLOW-UPS 56), so an id fires only when it is newly
        // inside; it is cleared when the mover leaves the volume, changes map,
        // or is teleported, so a re-entry fires again.
        std::vector<uint32> insideTriggers;
        uint32 insideTriggersMap{0xFFFFFFFF};

        // WB_RIDE_PROGRESS pacing while aboard a transport (world thread only).
        int64_t lastRideEmitMs{0};
        // TickTransports: last WB_TRANSPORT_PROGRESS batch for this session.
        int64_t lastTransportEmitMs{0};

        // Map transfer in flight: the destination map from SMSG_TRANSFER_PENDING,
        // cleared by SMSG_NEW_WORLD / SMSG_TRANSFER_ABORTED. Set on tap threads,
        // read by the mover on the world thread, hence atomic.
        std::atomic<uint32> pendingTransferMap{0};

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
        // as WB_AREA, sentinel until the first in-world tick so login emits one.
        // See TickAreas (FOLLOW-UPS 38 N2).
        uint32 lastZoneId{0xFFFFFFFF};
        uint32 lastAreaId{0xFFFFFFFF};

        // Client-side object cache mirror, fed by the update-object tap. Needed
        // because UPDATETYPE_VALUES blocks carry no object type (a real client
        // resolves them against its own cache). Also tracks which name/creature
        // queries this "client" has already issued. Tap threads -> mutex.
        std::mutex objMutex;
        std::unordered_map<uint64_t, uint8_t> knownObjects;      // guid -> TypeID
        std::unordered_set<uint32_t> queriedCreatures;           // creature entries
        std::unordered_set<uint64_t> queriedNames;               // player guids
        std::unordered_set<uint32_t> queriedItems;               // item entries
        std::unordered_set<uint32_t> queriedGameObjects;         // gameobject entries

        // loot_all: on the next SMSG_LOOT_RESPONSE the tap replays the client's
        // auto-loot sequence (AUTOSTORE per slot, LOOT_MONEY, LOOT_RELEASE).
        // Guarded by objMutex (set on world thread, consumed on tap threads).
        bool autoLootPending{false};

        std::ofstream audit;
        std::mutex auditMutex;
    };

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
        HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body, bool loopbackPeer) override;
        void OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn) override;
        void OnWsClose(std::string const& token, IWsConn* conn) override;

    private:
        Manager() = default;

        // World-thread task queue.
        void PushTask(std::function<void()> fn);

        // Request handlers. The HandleHttp* run on io threads and marshal onto the
        // world thread via PushTask; the Do* run on the world thread.
        HttpReply HttpCreateSession(std::string const& body);
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
        void DoMoveTo(std::string token, float x, float y, float z, std::string guid, std::shared_ptr<std::promise<HttpReply>> ack);
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
        };
        // One pass of the cause ladder at x,y,z; reqZ is the z the agent asked
        // for (meshZ is reported relative to it).
        PathResolve ResolvePathAt(Player* player, float x, float y, float z, float reqZ);
        // The z-ladder around it: ground height at x,y first for a unit
        // target, as a fallback after target_off_mesh otherwise.
        PathResolve ResolvePath(Player* player, float x, float y, float z, bool unitTarget,
            bool* usedGroundZ = nullptr, float* groundZOut = nullptr);

        // AreaTrigger.dbc as the client ships it (FOLLOW-UPS 38 N1): the
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

        // AreaTable.dbc as the client ships it (FOLLOW-UPS 38 N2): zone and
        // subzone names. The ids themselves come from Player::GetZoneAndAreaId,
        // which the server derives from the same terrain data a client reads
        // locally, so the pair is observation-equivalent (PROTOCOL.md, WB_AREA).
        bool LoadAreaTableDbc(std::string const& path);
        std::unordered_map<uint32, AreaTableRec> _areaTable;
        bool _areaTableLoaded{false};

        // Achievement.dbc as the client ships it (issue #8): name,
        // points and category for the ids SMSG_ACHIEVEMENT_EARNED and
        // SMSG_ALL_ACHIEVEMENT_DATA carry. Ids only when the file is absent.
        bool LoadAchievementDbc(std::string const& path);
        std::unordered_map<uint32, AchievementRec> _achievements;
        bool _achievementsLoaded{false};
        // One `{ achievementId, date, time, name?, points?, categoryId? }`
        // object; `date` is the wire's packed bitfield, `time` its reading.
        std::string AchievementJson(uint32 id, uint32 packedDate) const;
        // Per tick, every in-world session: emit WB_AREA on login and whenever
        // zone or area id changes (walking, teleport, transfer). World thread only.
        void TickAreas();
        // Append mapId/zoneId/zoneName/areaId/areaName for the player's current
        // position to a writer (WB_AREA and WB_SESSION_STATE share it).
        void AddAreaFields(Json::Writer& w, Player* player);

        // Mover (world thread only).
        void TickMovers(int64_t nowMs);
        void TickMover(BenchSession& s, int64_t nowMs);
        void TickRiders(int64_t nowMs);
        void TickTransports(int64_t nowMs);
        void FinishMove(BenchSession& s, char const* status);

        // Answer pending teleports the way a real client does (world thread
        // only): MSG_MOVE_TELEPORT_ACK / MSG_MOVE_WORLDPORT_ACK through the
        // stock handlers, so the destination is applied and movement resumes.
        void TickTeleportAcks(int64_t nowMs);

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
        // SMSG_LOGIN_VERIFY_WORLD carries.
        // World thread only (reads Player). Reused by the WS-reattach path and by
        // an idempotent same-token createSession so the caller re-syncs state.
        void EmitSessionState(std::shared_ptr<BenchSession> const& s);
        void Audit(BenchSession& s, char const* kind, std::string const& json);
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
        std::string _auditDir;

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
