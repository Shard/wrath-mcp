/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef MOD_WRATHBENCH_WBMANAGER_H
#define MOD_WRATHBENCH_WBMANAGER_H

#include "WbHttpServer.h"

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

    // Per-session synthesized-movement state (ADR-0010). Touched only on the
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
    };

    // Per-token headless session. See ADR-0009 for the parked-socket design.
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

        // Client-side object cache mirror, fed by the update-object tap. Needed
        // because UPDATETYPE_VALUES blocks carry no object type (a real client
        // resolves them against its own cache). Also tracks which name/creature
        // queries this "client" has already issued. Tap threads -> mutex.
        std::mutex objMutex;
        std::unordered_map<uint64_t, uint8_t> knownObjects;      // guid -> TypeID
        std::unordered_set<uint32_t> queriedCreatures;           // creature entries
        std::unordered_set<uint64_t> queriedNames;               // player guids
        std::unordered_set<uint32_t> queriedItems;               // item entries

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
        HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body) override;
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
        HttpReply HttpHealth();

        void DoCreateSession(std::shared_ptr<BenchSession> s, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoSay(std::string token, std::string text, std::shared_ptr<std::promise<HttpReply>> ack);
        // One handler for every action that is a single synthesized client
        // opcode (targeting, combat, interaction, quests, loot, vendor,
        // inventory, death). body is the raw request JSON, reparsed on the
        // world thread.
        void DoGameAction(std::string token, std::string action, std::string body,
            std::shared_ptr<std::promise<HttpReply>> ack);
        void DoDeleteSession(std::string token, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoMoveTo(std::string token, float x, float y, float z, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoStop(std::string token, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoFace(std::string token, bool hasO, float o, bool hasXY, float x, float y, std::shared_ptr<std::promise<HttpReply>> ack);

        // Mover (world thread only; see ADR-0010).
        void TickMovers(int64_t nowMs);
        void TickMover(BenchSession& s, int64_t nowMs);
        void FinishMove(BenchSession& s, char const* status);

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
        void Audit(BenchSession& s, char const* kind, std::string const& json);
        void SucceedAck(BenchSession& s);
        void FailAck(BenchSession& s, std::string const& message, int status = 502);

        std::shared_ptr<BenchSession> FindByToken(std::string const& token);
        std::shared_ptr<BenchSession> FindByWs(WorldSession* ws);

        // config
        bool _enabled{false};
        std::string _bindAddress{"0.0.0.0"};
        uint16_t _port{8086};
        unsigned _threads{2};
        std::string _account{"RUNNER"};
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
