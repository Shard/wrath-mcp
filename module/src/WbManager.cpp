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

#include "WbManager.h"
#include "WbJson.h"

#include "AccountMgr.h"
#include "Config.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Item.h"
#include "ItemTemplate.h"
#include "Log.h"
#include "QuestDef.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "PathGenerator.h"
#include "Player.h"
#include "SharedDefines.h"
#include "Timer.h"
#include "UpdateData.h"
#include "UpdateFields.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include "WorldSocket.h"

#include <boost/asio/ip/tcp.hpp>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <strings.h>

using boost::asio::ip::tcp;

namespace WrathBench
{
    static int64_t NowMs()
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    static std::string Sanitize(std::string const& token)
    {
        std::string out;
        for (char c : token)
            out += (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_') ? c : '_';
        if (out.empty()) out = "session";
        return out;
    }

    Manager& Manager::Instance()
    {
        static Manager instance;
        return instance;
    }

    // -------------------------------------------------------------- config
    void Manager::Configure()
    {
        _enabled = sConfigMgr->GetOption<bool>("WrathBench.Enable", false);
        _bindAddress = sConfigMgr->GetOption<std::string>("WrathBench.BindAddress", "0.0.0.0");
        _port = static_cast<uint16_t>(sConfigMgr->GetOption<uint32>("WrathBench.Port", 8086));
        _threads = std::max<unsigned>(1, sConfigMgr->GetOption<uint32>("WrathBench.Threads", 2));
        _account = sConfigMgr->GetOption<std::string>("WrathBench.Account", "RUNNER");
        _auditDir = sConfigMgr->GetOption<std::string>("WrathBench.AuditDir", "/azerothcore/env/dist/logs/wrathbench");
    }

    void Manager::Start()
    {
        if (!_enabled)
            return;

        try
        {
            std::filesystem::create_directories(_auditDir);
        }
        catch (std::exception const& e)
        {
            LOG_WARN("module", "wrathbench: could not create audit dir '{}': {}", _auditDir, e.what());
        }

        _http = std::make_unique<HttpServer>(_bindAddress, _port, this, _threads);
        try
        {
            _http->Start();
        }
        catch (std::exception const& e)
        {
            LOG_ERROR("module", "wrathbench: HTTP server failed to start: {}", e.what());
            _http.reset();
        }
    }

    void Manager::Stop()
    {
        if (_http)
        {
            _http->Stop();
            _http.reset();
        }
        // Best-effort teardown of any live parked sockets.
        std::lock_guard<std::mutex> lock(_sessMutex);
        for (auto& [token, s] : _byToken)
            if (s->socket)
                s->socket->CloseSocket();
        _byToken.clear();
        _byWs.clear();
        _wsByToken.clear();
    }

    // --------------------------------------------------------- task queue
    void Manager::PushTask(std::function<void()> fn)
    {
        std::lock_guard<std::mutex> lock(_taskMutex);
        _tasks.push_back(std::move(fn));
    }

    void Manager::Update(uint32 /*diff*/)
    {
        std::vector<std::function<void()>> tasks;
        {
            std::lock_guard<std::mutex> lock(_taskMutex);
            tasks.swap(_tasks);
        }
        for (auto& t : tasks)
            t();

        // Drive synthesized movement (ADR-0010). World thread: maps are not
        // mid-update here, so reading player state and QueuePacket are both safe.
        TickMovers(NowMs());

        // Keep parked sockets from being reaped by the idle-connection check in
        // WorldSession::Update (it calls CloseSocket once m_timeOutTime hits 0).
        // Only deref ws when the core's own session map still points at it: the
        // core may delete a session out from under us (AddSession_ kicks a prior
        // session on the same account). A null/mismatched result is normal in the
        // tick between our AddSession and the core's AddSession_, so we skip the
        // reset but never erase the entry.
        std::lock_guard<std::mutex> lock(_sessMutex);
        for (auto& [ws, s] : _byWs)
            if (!s->tearingDown.load() && sWorldSessionMgr->FindSession(s->accountId) == ws)
                ws->ResetTimeOutTime(false);
    }

    // ----------------------------------------------------------- lookups
    std::shared_ptr<BenchSession> Manager::FindByToken(std::string const& token)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        auto it = _byToken.find(token);
        return it == _byToken.end() ? nullptr : it->second;
    }

    std::shared_ptr<BenchSession> Manager::FindByWs(WorldSession* ws)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        auto it = _byWs.find(ws);
        return it == _byWs.end() ? nullptr : it->second;
    }

    // ------------------------------------------------------------- HTTP
    HttpReply Manager::HandleHttp(std::string const& method, std::string const& target, std::string const& body)
    {
        try
        {
            if (method == "GET" && target == "/health")
                return HttpHealth();
            if (method == "POST" && target == "/session")
                return HttpCreateSession(body);
            if (method == "POST" && target == "/action")
                return HttpAction(body);
            if (method == "DELETE" && target == "/session")
                return HttpDeleteSession(body);
            if (method == "POST" && target == "/character-delete")
                return HttpCharacterDelete(body);
            if (method == "POST" && target == "/characters")
                return HttpCharacterList(body);

            return {404, Json::Writer().Add("ok", false).Add("error", "not_found").Str()};
        }
        catch (std::exception const& e)
        {
            return {500, Json::Writer().Add("ok", false).Add("error", "internal").Add("message", e.what()).Str()};
        }
    }

    // Name an opcode id for the /health drop histogram: the core's opcode
    // table name where it has one, "0xNNN" hex otherwise.
    static std::string DropOpcodeName(uint16 opc)
    {
        if (opc < NUM_OPCODE_HANDLERS)
            if (OpcodeHandler const* h = opcodeTable[static_cast<Opcodes>(opc)])
                return h->Name;
        char buf[8];
        std::snprintf(buf, sizeof(buf), "0x%03X", opc);
        return buf;
    }

    HttpReply Manager::HttpHealth()
    {
        uint64_t sessions;
        uint64_t liveDrops = 0;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            sessions = _byToken.size();
            for (auto& [token, s] : _byToken)
                liveDrops += s->dropCount.load();
        }

        // Top 30 dropped opcodes by count (whitelist-expansion census signal).
        std::vector<std::pair<uint16, uint64_t>> drops;
        for (size_t i = 0; i < kOpcodeSpace; ++i)
            if (uint64_t c = _dropsByOpcode[i].load(std::memory_order_relaxed))
                drops.emplace_back(static_cast<uint16>(i), c);
        size_t const top = std::min<size_t>(drops.size(), 30);
        std::partial_sort(drops.begin(), drops.begin() + top, drops.end(),
            [](auto const& a, auto const& b) { return a.second > b.second; });
        drops.resize(top);
        Json::Writer byOpcode;
        for (auto const& [opc, count] : drops)
            byOpcode.Add(DropOpcodeName(opc), count);

        Json::Writer w;
        w.Add("ok", true);
        w.Add("module", "mod-wrathbench");
        w.Add("worldStopped", World::IsStopped());
        w.Add("sessions", sessions);
        w.Add("droppedPackets", _totalDrops.load()); // lifetime
        w.Add("droppedPacketsLive", liveDrops);      // across current sessions
        w.Raw("droppedByOpcode", byOpcode.Str());    // lifetime, top 30 by count
        return {200, w.Str()};
    }

    HttpReply Manager::HttpCreateSession(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        if (FindByToken(token))
            return {409, Json::Writer().Add("ok", false).Add("error", "token_in_use").Str()};

        auto s = std::make_shared<BenchSession>();
        s->token = token;
        s->account = req.GetString("account", _account);
        s->charName = req.GetString("character", "");
        // Absent or garbage race/class deliberately parse to 0, which is outside
        // the valid [1,11] range. Whether that matters is only decided at
        // char-enum time: an existing character ignores these entirely, but a
        // character CREATE with an out-of-range race/class fails the request
        // with 400 invalid_race_class instead of silently making a default
        // Human Warrior (the incident this guards against).
        s->charRace = static_cast<uint8>(req.GetInt("race", 0));
        s->charClass = static_cast<uint8>(req.GetInt("class", 0));
        s->charGender = static_cast<uint8>(req.GetInt("gender", 0));
        if (s->charName.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_character").Str()};

        auto ack = std::make_shared<std::promise<HttpReply>>();
        s->ack = ack;
        auto fut = ack->get_future();

        PushTask([this, s, ack]() { DoCreateSession(s, ack); });

        if (fut.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
        {
            // Don't leave a half-built session registered with an unset promise:
            // that orphan is exactly what feeds a dangling-pointer crash on the
            // next create for this account. Tear it down on the world thread.
            PushTask([this, token]() { TeardownByToken(token); });
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Add("token", token).Str()};
        }
        return fut.get();
    }

    HttpReply Manager::HttpAction(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        std::string action = req.GetString("action");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        auto ack = std::make_shared<std::promise<HttpReply>>();
        auto fut = ack->get_future();

        if (action == "say")
        {
            std::string text = req.GetString("text");
            PushTask([this, token, text, ack]() { DoSay(token, text, ack); });
        }
        else if (action == "move_to")
        {
            if (!req.Has("x") || !req.Has("y") || !req.Has("z"))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_position").Str()};
            float x = (float)req.GetDouble("x"), y = (float)req.GetDouble("y"), z = (float)req.GetDouble("z");
            PushTask([this, token, x, y, z, ack]() { DoMoveTo(token, x, y, z, ack); });
        }
        else if (action == "stop")
        {
            PushTask([this, token, ack]() { DoStop(token, ack); });
        }
        else if (action == "face")
        {
            bool hasO = req.Has("orientation");
            bool hasXY = req.Has("x") && req.Has("y");
            if (!hasO && !hasXY)
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_face_target").Str()};
            float o = (float)req.GetDouble("orientation");
            float x = (float)req.GetDouble("x"), y = (float)req.GetDouble("y");
            PushTask([this, token, hasO, o, hasXY, x, y, ack]() { DoFace(token, hasO, o, hasXY, x, y, ack); });
        }
        else
        {
            // Single-opcode actions (2026-08 quest/combat extension). Validate
            // required params here on the io thread; synthesis happens on the
            // world thread in DoGameAction.
            static char const* kNeedsGuid[] = {
                "set_target", "attack_start", "interact", "gossip_hello", "gossip_select",
                "quest_list", "quest_details", "quest_accept", "quest_complete",
                "quest_choose_reward", "loot", "loot_all", "loot_release",
                "vendor_list", "buy_item", "sell_item", "repair_all", nullptr };
            static char const* kNoParams[] = {
                "clear_target", "attack_stop", "loot_money", "repop", "reclaim_corpse", nullptr };

            bool known = false;
            bool needsGuid = false;
            for (char const** a = kNeedsGuid; *a; ++a)
                if (action == *a) { known = true; needsGuid = true; break; }
            if (!known)
                for (char const** a = kNoParams; *a; ++a)
                    if (action == *a) { known = true; break; }
            if (!known)
                known = action == "cast_spell" || action == "cancel_cast" || action == "quest_abandon"
                     || action == "loot_item" || action == "equip_item" || action == "use_item"
                     || action == "destroy_item";
            if (!known)
                return {400, Json::Writer().Add("ok", false).Add("error", "unsupported_action").Add("action", action).Str()};

            if (needsGuid && req.GetString("guid").empty())
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_guid").Str()};
            if (action == "gossip_select" && (!req.Has("menuId") || !req.Has("optionId")))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_option").Str()};
            if ((action == "quest_details" || action == "quest_accept" || action == "quest_complete"
                 || action == "quest_choose_reward" || action == "quest_abandon") && !req.Has("questId"))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_quest_id").Str()};
            if (action == "quest_choose_reward" && !req.Has("rewardIndex"))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_reward_index").Str()};
            if ((action == "cast_spell" || action == "cancel_cast") && !req.Has("spellId"))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_spell_id").Str()};
            if (action == "loot_item" && !req.Has("slot"))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_slot").Str()};
            if (action == "buy_item" && (!req.Has("itemId") || !req.Has("slot")))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_item").Str()};
            if (action == "sell_item" && req.GetString("itemGuid").empty())
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_item_guid").Str()};
            if ((action == "equip_item" || action == "use_item" || action == "destroy_item")
                && (!req.Has("bag") || !req.Has("slot")))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_bag_slot").Str()};

            PushTask([this, token, action, body, ack]() { DoGameAction(token, action, body, ack); });
        }

        if (fut.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
        return fut.get();
    }

    HttpReply Manager::HttpDeleteSession(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        auto ack = std::make_shared<std::promise<HttpReply>>();
        auto fut = ack->get_future();
        PushTask([this, token, ack]() { DoDeleteSession(token, ack); });

        if (fut.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
        return fut.get();
    }

    // POST /character-delete: a short-lived utility session that parks at the
    // character-select stage and sends the real CMSG_CHAR_DELETE (STATUS_AUTHED,
    // so it must not be in world). Needed because episode resets (ADR-0006)
    // accumulate characters against the realm's per-account cap.
    HttpReply Manager::HttpCharacterDelete(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};
        if (req.GetString("character").empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_character").Str()};
        if (FindByToken(token))
            return {409, Json::Writer().Add("ok", false).Add("error", "token_in_use").Str()};

        auto s = std::make_shared<BenchSession>();
        s->token = token;
        s->account = req.GetString("account", _account);
        s->charName = req.GetString("character");
        s->deleteMode = true;

        auto ack = std::make_shared<std::promise<HttpReply>>();
        s->ack = ack;
        auto fut = ack->get_future();
        PushTask([this, s, ack]() { DoCreateSession(s, ack); });

        if (fut.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
        {
            PushTask([this, token]() { TeardownByToken(token); });
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Add("token", token).Str()};
        }
        return fut.get();
    }

    HttpReply Manager::HttpCharacterList(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};
        if (FindByToken(token))
            return {409, Json::Writer().Add("ok", false).Add("error", "token_in_use").Str()};

        auto s = std::make_shared<BenchSession>();
        s->token = token;
        s->account = req.GetString("account", _account);
        s->listMode = true;

        auto ack = std::make_shared<std::promise<HttpReply>>();
        s->ack = ack;
        auto fut = ack->get_future();
        PushTask([this, s, ack]() { DoCreateSession(s, ack); });

        if (fut.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
        {
            PushTask([this, token]() { TeardownByToken(token); });
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Add("token", token).Str()};
        }
        return fut.get();
    }

    // ---------------------------------------------------- world-thread work
    void Manager::DoCreateSession(std::shared_ptr<BenchSession> s, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto fail = [&](std::string const& err) {
            if (!s->ackFired.exchange(true))
                ack->set_value({400, Json::Writer().Add("ok", false).Add("error", err).Add("token", s->token).Str()});
        };

        uint32 accountId = AccountMgr::GetId(s->account);
        if (!accountId)
            return fail("unknown_account");
        s->accountId = accountId;

        // One session per account. The core's AddSession_ would otherwise kick and
        // delete the existing session, leaving us with a dangling WorldSession*.
        if (sWorldSessionMgr->FindSession(accountId))
            return fail("account_in_use");

        QueryResult info = LoginDatabase.Query(
            "SELECT expansion, flags, mutetime, locale, recruiter, totaltime FROM account WHERE id = {}", accountId);
        uint8 expansion = 2;
        uint32 flags = 0, recruiter = 0, totaltime = 0;
        uint8 locale = 0;
        int64 mutetime = 0;
        if (info)
        {
            Field* f = info->Fetch();
            expansion = f[0].Get<uint8>();
            flags = f[1].Get<uint32>();
            mutetime = f[2].Get<int64>();
            locale = f[3].Get<uint8>();
            recruiter = f[4].Get<uint32>();
            totaltime = f[5].Get<uint32>();
        }

        // Build the parked loopback socket (ADR-0009). Blocking connect then accept
        // on localhost: connect completes into the listen backlog without accept
        // running concurrently, so a single thread is fine.
        try
        {
            tcp::acceptor acc(_socketIoc, tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), 0));
            auto client = std::make_unique<IoContextTcpSocket>(_socketIoc);
            client->connect(acc.local_endpoint());
            IoContextTcpSocket server(_socketIoc);
            acc.accept(server);
            s->clientEnd = std::move(client);
            s->socket = std::make_shared<WorldSocket>(std::move(server));
        }
        catch (std::exception const& e)
        {
            return fail(std::string("socket_setup_failed"));
        }

        uint32 security = AccountMgr::GetSecurity(accountId);
        std::string name = s->account;
        WorldSession* ws = new WorldSession(accountId, std::move(name), flags, s->socket,
            static_cast<AccountTypes>(security), expansion, static_cast<time_t>(mutetime),
            static_cast<LocaleConstant>(locale), recruiter, false, security != 0, totaltime);
        ws->ValidateAccountFlags();
        s->ws = ws;

        // Open the audit log.
        {
            std::string path = _auditDir + "/" + Sanitize(s->token) + ".jsonl";
            s->audit.open(path, std::ios::out | std::ios::app);
        }

        // Register before AddSession so the tap sees the very first outbound packet.
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            _byToken[s->token] = s;
            _byWs[ws] = s;
        }

        Audit(*s, "action", Json::Writer().Add("op", s->deleteMode ? "character_delete" : "session_create")
            .Add("account", s->account).Add("character", s->charName)
            .Add("race", (uint32)s->charRace).Add("class", (uint32)s->charClass).Str());

        s->phase.store(BenchSession::P_AUTH);
        sWorldSessionMgr->AddSession(ws);
        // Success/failure is delivered later by the tap once the login flow reaches
        // SMSG_LOGIN_VERIFY_WORLD (or an error packet). Do not set the ack here.
    }

    // Shared guard for the Do* action handlers (world thread). Validates the
    // session is in world and still owned by the core, and resolves the player.
    // On failure the error reply is set and nullptr returned.
    Player* Manager::CheckActionSession(std::shared_ptr<BenchSession> const& s,
        std::shared_ptr<std::promise<HttpReply>>& ack)
    {
        auto reply = [&](int status, char const* err) {
            ack->set_value({status, Json::Writer().Add("ok", false).Add("error", err).Str()});
            return nullptr;
        };
        if (!s || !s->ws)
            return reply(404, "no_session");
        if (s->phase.load() != BenchSession::P_INWORLD)
            return reply(409, "not_in_world");
        // Confirm the core still owns this exact WorldSession before dereferencing it.
        if (sWorldSessionMgr->FindSession(s->accountId) != s->ws)
            return reply(410, "session_gone");
        Player* player = s->ws->GetPlayer();
        if (!player)
            return reply(409, "no_player");
        return player;
    }

    void Manager::DoSay(std::string token, std::string text, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto reply = [&](int status, std::string const& json) { ack->set_value({status, json}); };

        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        // Language derived from the player's team, as a real client does. Sending
        // LANG_UNIVERSAL would be flagged as a hack by HandleMessagechatOpcode.
        uint32 lang = (player->GetTeamId() == TEAM_ALLIANCE) ? LANG_COMMON : LANG_ORCISH;

        WorldPacket* p = new WorldPacket(CMSG_MESSAGECHAT, 4 + 4 + text.size() + 1);
        *p << uint32(CHAT_MSG_SAY);
        *p << uint32(lang);
        *p << text;
        s->ws->QueuePacket(p);

        Audit(*s, "action", Json::Writer().Add("op", "say").Add("text", text).Str());
        reply(200, Json::Writer().Add("ok", true).Add("action", "say").Add("token", token).Str());
    }

    // ------------------------------------------------------------- movement
    // ADR-0010: move_to is resolved once against the server's mmaps (the single
    // sanctioned exception in docs/CONTRACTS.md), then driven as the client
    // movement packet sequence a real client would send: MSG_MOVE_START_FORWARD,
    // MSG_MOVE_HEARTBEAT at ~500ms, MSG_MOVE_STOP — all through QueuePacket into
    // the stock HandleMovementOpcodes. The agent sees progress/arrival/failure
    // events only, never the path.

    static std::string PosJson(float x, float y, float z, float o)
    {
        return Json::Writer().Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Add("o", (double)o).Str();
    }

    // Synthesize one client movement packet (MovementInfo layout mirrors
    // WorldSession::ReadMovementInfo: flags u32, flags2 u16, time u32, xyzo,
    // fallTime u32; no transport/swim/fall extras for ground movement). The
    // module's clock doubles as the "client" clock; CMSG_TIME_SYNC_RESP below
    // keeps the session's clock delta near zero so these timestamps are accepted.
    static void SendMovePacket(BenchSession& s, Player* player, uint16 opcode, uint32 moveFlags,
        float x, float y, float z, float o)
    {
        WorldPacket* p = new WorldPacket(opcode, 8 + 4 + 2 + 4 + 16 + 4);
        *p << player->GetPackGUID();
        *p << uint32(moveFlags);
        *p << uint16(0);            // flags2
        *p << uint32(getMSTime());
        *p << float(x) << float(y) << float(z) << float(o);
        *p << uint32(0);            // fallTime
        s.ws->QueuePacket(p);
    }

    void Manager::FinishMove(BenchSession& s, char const* status)
    {
        MoveState& m = s.move;
        if (!m.active)
            return;
        m.active = false;
        m.stopping = false;
        m.points.clear();

        Json::Writer w;
        w.Add("moveId", m.moveId).Add("status", status);
        // Server-confirmed position, when the session is still live: this is the
        // ground truth that the synthesized movement was actually applied.
        Player* player = (s.ws && sWorldSessionMgr->FindSession(s.accountId) == s.ws) ? s.ws->GetPlayer() : nullptr;
        if (player)
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
        EmitEvent(s, "WB_MOVE_RESULT", 0xFF01, w.Str());
    }

    void Manager::DoMoveTo(std::string token, float x, float y, float z, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        Audit(*s, "action", Json::Writer().Add("op", "move_to")
            .Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Str());

        if (s->move.active)
            FinishMove(*s, "superseded");

        uint64_t moveId = ++s->moveIdGen;
        MoveState& m = s->move;
        m.moveId = moveId;

        // Ack means "queued"; the game-level outcome arrives as a WB_MOVE_RESULT
        // event, per the transport/game error split in PROTOCOL.md.
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "move_to")
            .Add("token", token).Add("moveId", moveId).Str()});

        auto failEvent = [&](char const* status) {
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", status);
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
        };

        if (player->GetExactDist2d(x, y) > 250.0f)
            return failEvent("too_far");

        // The one sanctioned mmaps use (docs/CONTRACTS.md "Pathing"). PathGenerator
        // runs against the player's map; world thread, maps are not mid-update here.
        PathGenerator gen(player);
        bool built = gen.CalculatePath(x, y, z, false);
        PathType type = gen.GetPathType();
        Movement::PointsArray const& pts = gen.GetPath();
        bool good = built && (type & PATHFIND_NORMAL)
            && !(type & (PATHFIND_NOPATH | PATHFIND_INCOMPLETE | PATHFIND_SHORT | PATHFIND_FARFROMPOLY))
            && pts.size() >= 2;
        if (good)
        {
            G3D::Vector3 const& end = gen.GetActualEndPosition();
            float dx = end.x - x, dy = end.y - y, dz = end.z - z;
            if (dx * dx + dy * dy + dz * dz > 16.0f) // navmesh end > 4y from request
                good = false;
        }
        if (!good)
            return failEvent("no_path");

        int64_t now = NowMs();
        m.points.clear();
        m.points.reserve(pts.size());
        for (auto const& v : pts)
            m.points.push_back({v.x, v.y, v.z});
        m.seg = 0;
        m.segDone = 0.0f;
        m.lastMs = now;
        m.lastPacketMs = now;
        m.lastProgressMs = now;
        m.curX = m.points[0].x; m.curY = m.points[0].y; m.curZ = m.points[0].z;
        m.destX = m.points.back().x; m.destY = m.points.back().y; m.destZ = m.points.back().z;
        m.curO = Position::NormalizeOrientation(std::atan2(m.points[1].y - m.points[0].y, m.points[1].x - m.points[0].x));
        m.stopping = false;
        m.active = true;

        SendMovePacket(*s, player, MSG_MOVE_START_FORWARD, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO);
        Audit(*s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_START_FORWARD")
            .Add("moveId", moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
    }

    void Manager::DoStop(std::string token, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        Audit(*s, "action", Json::Writer().Add("op", "stop").Str());

        if (s->move.active)
        {
            MoveState& m = s->move;
            // Stop where the "client" is (the interpolated position); the server
            // accepts it the same way it accepts any client stop mid-run.
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO);
            FinishMove(*s, "stopped");
        }
        else
        {
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation());
        }
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "stop").Add("token", token).Str()});
    }

    void Manager::DoFace(std::string token, bool hasO, float o, bool hasXY, float x, float y,
        std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        if (s->move.active)
            return ack->set_value({409, Json::Writer().Add("ok", false).Add("error", "moving").Str()});

        float target = hasO ? Position::NormalizeOrientation(o)
                            : (hasXY ? player->GetAngle(x, y) : player->GetOrientation());

        Audit(*s, "action", Json::Writer().Add("op", "face").Add("orientation", (double)target).Str());
        SendMovePacket(*s, player, MSG_MOVE_SET_FACING, MOVEMENTFLAG_NONE,
            player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), target);
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "face")
            .Add("token", token).Add("orientation", (double)target).Str()});
    }

    // Parse a guid request field (decimal string, see PROTOCOL.md u64 note).
    static uint64_t ParseGuid(Json::Value const& req, char const* key)
    {
        std::string v = req.GetString(key);
        if (v.empty())
            return 0;
        try { return std::stoull(v); } catch (...) { return 0; }
    }

    // Every action that is one synthesized client opcode through the stock
    // handlers (docs/CONTRACTS.md action contract). The ack means "opcode
    // queued"; the game outcome arrives as whitelisted events.
    void Manager::DoGameAction(std::string token, std::string action, std::string body,
        std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        Json::Value req = Json::Parse(body);
        uint64_t guid = ParseGuid(req, "guid");

        auto err = [&](int status, char const* code) {
            ack->set_value({status, Json::Writer().Add("ok", false).Add("error", code).Str()});
        };

        Json::Writer auditW;
        auditW.Add("op", action);
        if (!req.GetString("guid").empty())
            auditW.AddGuid("guid", guid);

        WorldPacket* p = nullptr;

        if (action == "set_target" || action == "clear_target")
        {
            p = new WorldPacket(CMSG_SET_SELECTION, 8);
            *p << uint64(action == "set_target" ? guid : 0);
        }
        else if (action == "attack_start")
        {
            p = new WorldPacket(CMSG_ATTACKSWING, 8);
            *p << uint64(guid);
        }
        else if (action == "attack_stop")
            p = new WorldPacket(CMSG_ATTACKSTOP, 0);
        else if (action == "cast_spell")
        {
            uint32 spellId = static_cast<uint32>(req.GetInt("spellId"));
            uint64_t target = ParseGuid(req, "targetGuid");
            p = new WorldPacket(CMSG_CAST_SPELL, 1 + 4 + 1 + 4 + 9);
            *p << uint8(0) << uint32(spellId) << uint8(0);   // castCount, spellId, castFlags
            if (target)
            {
                *p << uint32(0x0002);                        // TARGET_FLAG_UNIT
                p->appendPackGUID(target);
            }
            else
                *p << uint32(0);                             // TARGET_FLAG_NONE (self/auto target)
            auditW.Add("spellId", spellId);
            if (target)
                auditW.AddGuid("targetGuid", target);
        }
        else if (action == "cancel_cast")
        {
            uint32 spellId = static_cast<uint32>(req.GetInt("spellId"));
            p = new WorldPacket(CMSG_CANCEL_CAST, 5);
            *p << uint8(0) << uint32(spellId);
            auditW.Add("spellId", spellId);
        }
        else if (action == "interact")
        {
            p = new WorldPacket(CMSG_GAMEOBJ_USE, 8);
            *p << uint64(guid);
        }
        else if (action == "gossip_hello")
        {
            p = new WorldPacket(CMSG_GOSSIP_HELLO, 8);
            *p << uint64(guid);
        }
        else if (action == "gossip_select")
        {
            uint32 menuId = static_cast<uint32>(req.GetInt("menuId"));
            uint32 optionId = static_cast<uint32>(req.GetInt("optionId"));
            p = new WorldPacket(CMSG_GOSSIP_SELECT_OPTION, 16);
            *p << uint64(guid) << uint32(menuId) << uint32(optionId);
            auditW.Add("menuId", menuId).Add("optionId", optionId);
        }
        else if (action == "quest_list")
        {
            p = new WorldPacket(CMSG_QUESTGIVER_HELLO, 8);
            *p << uint64(guid);
        }
        else if (action == "quest_details")
        {
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            p = new WorldPacket(CMSG_QUESTGIVER_QUERY_QUEST, 13);
            *p << uint64(guid) << uint32(questId) << uint8(0);
            auditW.Add("questId", questId);
        }
        else if (action == "quest_accept")
        {
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            p = new WorldPacket(CMSG_QUESTGIVER_ACCEPT_QUEST, 16);
            *p << uint64(guid) << uint32(questId) << uint32(0);
            auditW.Add("questId", questId);
        }
        else if (action == "quest_complete")
        {
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            p = new WorldPacket(CMSG_QUESTGIVER_COMPLETE_QUEST, 12);
            *p << uint64(guid) << uint32(questId);
            auditW.Add("questId", questId);
        }
        else if (action == "quest_choose_reward")
        {
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            uint32 rewardIndex = static_cast<uint32>(req.GetInt("rewardIndex"));
            p = new WorldPacket(CMSG_QUESTGIVER_CHOOSE_REWARD, 16);
            *p << uint64(guid) << uint32(questId) << uint32(rewardIndex);
            auditW.Add("questId", questId).Add("rewardIndex", rewardIndex);
        }
        else if (action == "quest_abandon")
        {
            // The client sends the quest-log slot; the module resolves it from
            // the quest id the same way a client resolves it from its own
            // (served) PLAYER_QUEST_LOG update fields.
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            uint16 slot = player->FindQuestSlot(questId);
            if (slot >= MAX_QUEST_LOG_SIZE)
                return err(400, "quest_not_in_log");
            p = new WorldPacket(CMSG_QUESTLOG_REMOVE_QUEST, 1);
            *p << uint8(slot);
            auditW.Add("questId", questId).Add("slot", (uint32)slot);
        }
        else if (action == "loot" || action == "loot_all")
        {
            if (action == "loot_all")
            {
                std::lock_guard<std::mutex> lock(s->objMutex);
                s->autoLootPending = true;
            }
            p = new WorldPacket(CMSG_LOOT, 8);
            *p << uint64(guid);
        }
        else if (action == "loot_item")
        {
            uint8 slot = static_cast<uint8>(req.GetInt("slot"));
            p = new WorldPacket(CMSG_AUTOSTORE_LOOT_ITEM, 1);
            *p << uint8(slot);
            auditW.Add("slot", (uint32)slot);
        }
        else if (action == "loot_money")
            p = new WorldPacket(CMSG_LOOT_MONEY, 0);
        else if (action == "loot_release")
        {
            {
                std::lock_guard<std::mutex> lock(s->objMutex);
                s->autoLootPending = false;
            }
            p = new WorldPacket(CMSG_LOOT_RELEASE, 8);
            *p << uint64(guid);
        }
        else if (action == "vendor_list")
        {
            p = new WorldPacket(CMSG_LIST_INVENTORY, 8);
            *p << uint64(guid);
        }
        else if (action == "buy_item")
        {
            uint32 itemId = static_cast<uint32>(req.GetInt("itemId"));
            uint32 slot = static_cast<uint32>(req.GetInt("slot"));       // 1-based, from SMSG_LIST_INVENTORY
            uint32 count = static_cast<uint32>(req.GetInt("count", 1));
            p = new WorldPacket(CMSG_BUY_ITEM, 8 + 4 + 4 + 4 + 1);
            *p << uint64(guid) << uint32(itemId) << uint32(slot) << uint32(count) << uint8(0);
            auditW.Add("itemId", itemId).Add("slot", slot).Add("count", count);
        }
        else if (action == "sell_item")
        {
            uint64_t itemGuid = ParseGuid(req, "itemGuid");
            uint32 count = static_cast<uint32>(req.GetInt("count", 0)); // 0 = whole stack
            p = new WorldPacket(CMSG_SELL_ITEM, 8 + 8 + 4);
            *p << uint64(guid) << uint64(itemGuid) << uint32(count);
            auditW.AddGuid("itemGuid", itemGuid).Add("count", count);
        }
        else if (action == "repair_all")
        {
            p = new WorldPacket(CMSG_REPAIR_ITEM, 8 + 8 + 1);
            *p << uint64(guid) << uint64(0) << uint8(0);     // item guid 0 = repair all
        }
        else if (action == "equip_item")
        {
            uint8 bag = static_cast<uint8>(req.GetInt("bag"));
            uint8 slot = static_cast<uint8>(req.GetInt("slot"));
            p = new WorldPacket(CMSG_AUTOEQUIP_ITEM, 2);
            *p << uint8(bag) << uint8(slot);
            auditW.Add("bag", (uint32)bag).Add("slot", (uint32)slot);
        }
        else if (action == "use_item")
        {
            uint8 bag = static_cast<uint8>(req.GetInt("bag"));
            uint8 slot = static_cast<uint8>(req.GetInt("slot"));
            uint64_t target = ParseGuid(req, "targetGuid");
            // The client fills the item guid and on-use spell id from its own
            // inventory + item cache; the module reads the same client-visible
            // state from the live item.
            Item* item = player->GetItemByPos(bag, slot);
            if (!item)
                return err(400, "no_item_at_slot");
            ItemTemplate const* proto = item->GetTemplate();
            uint32 spellId = 0;
            if (proto)
                for (auto const& spell : proto->Spells)
                    if (spell.SpellId > 0 && spell.SpellTrigger == ITEM_SPELLTRIGGER_ON_USE)
                    {
                        spellId = spell.SpellId;
                        break;
                    }
            if (!spellId)
                return err(400, "item_not_usable");
            p = new WorldPacket(CMSG_USE_ITEM, 1 + 1 + 1 + 4 + 8 + 4 + 1 + 4 + 9);
            *p << uint8(bag) << uint8(slot) << uint8(0) << uint32(spellId);
            *p << uint64(item->GetGUID().GetRawValue()) << uint32(0) << uint8(0);
            if (target)
            {
                *p << uint32(0x0002);                        // TARGET_FLAG_UNIT
                p->appendPackGUID(target);
            }
            else
                *p << uint32(0);
            auditW.Add("bag", (uint32)bag).Add("slot", (uint32)slot).Add("spellId", spellId);
        }
        else if (action == "destroy_item")
        {
            uint8 bag = static_cast<uint8>(req.GetInt("bag"));
            uint8 slot = static_cast<uint8>(req.GetInt("slot"));
            uint8 count = static_cast<uint8>(req.GetInt("count", 0));   // 0 = whole stack
            p = new WorldPacket(CMSG_DESTROYITEM, 6);
            *p << uint8(bag) << uint8(slot) << uint8(count) << uint8(0) << uint8(0) << uint8(0);
            auditW.Add("bag", (uint32)bag).Add("slot", (uint32)slot).Add("count", (uint32)count);
        }
        else if (action == "repop")
        {
            p = new WorldPacket(CMSG_REPOP_REQUEST, 1);
            *p << uint8(0);
        }
        else if (action == "reclaim_corpse")
        {
            // Handler resolves the player's own corpse; the guid payload is the
            // corpse guid a real client echoes (optional here).
            p = new WorldPacket(CMSG_RECLAIM_CORPSE, 8);
            *p << uint64(guid);
        }
        else
            return err(400, "unsupported_action");

        s->ws->QueuePacket(p);
        Audit(*s, "action", auditW.Str());
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", action).Add("token", token).Str()});
    }

    void Manager::TickMovers(int64_t nowMs)
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (s->move.active)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
            TickMover(*s, nowMs);
    }

    void Manager::TickMover(BenchSession& s, int64_t nowMs)
    {
        MoveState& m = s.move;
        if (!m.active || s.tearingDown.load())
        {
            m.active = false;
            return;
        }
        if (!s.ws || sWorldSessionMgr->FindSession(s.accountId) != s.ws)
        {
            m.active = false; // session died under us; nothing to report to
            return;
        }
        Player* player = s.ws->GetPlayer();
        if (!player || !player->IsInWorld())
        {
            m.active = false;
            return;
        }

        if (m.stopping)
        {
            // MSG_MOVE_STOP is queued; arrival is confirmed when the server-side
            // position reaches the destination.
            if (player->GetExactDist2d(m.destX, m.destY) < 2.5f)
                FinishMove(s, "arrived");
            else if (nowMs > m.stopDeadlineMs)
                FinishMove(s, "interrupted");
            return;
        }

        if (!player->IsAlive())
        {
            SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation());
            FinishMove(s, "interrupted");
            return;
        }

        int64_t dt = nowMs - m.lastMs;
        m.lastMs = nowMs;
        if (dt <= 0)
            return;

        // Advance along the polyline at the character's current run speed.
        float advance = player->GetSpeed(MOVE_RUN) * float(dt) / 1000.0f;
        while (m.seg + 1 < m.points.size())
        {
            WbVec const& a = m.points[m.seg];
            WbVec const& b = m.points[m.seg + 1];
            float sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
            float segLen = std::sqrt(sx * sx + sy * sy + sz * sz);
            float remain = segLen - m.segDone;
            if (advance < remain || segLen <= 0.0001f)
            {
                m.segDone += advance;
                float t = segLen > 0.0001f ? m.segDone / segLen : 1.0f;
                m.curX = a.x + sx * t;
                m.curY = a.y + sy * t;
                m.curZ = a.z + sz * t;
                m.curO = Position::NormalizeOrientation(std::atan2(sy, sx));
                advance = 0.0f;
                break;
            }
            advance -= remain;
            ++m.seg;
            m.segDone = 0.0f;
        }

        if (m.seg + 1 >= m.points.size())
        {
            // Geometric end of path: send the stop at the exact destination and
            // wait for the server to confirm.
            m.curX = m.destX; m.curY = m.destY; m.curZ = m.destZ;
            SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.destX, m.destY, m.destZ, m.curO);
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_STOP")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.destX, m.destY, m.destZ, m.curO)).Str());
            m.stopping = true;
            m.stopDeadlineMs = nowMs + 3000;
            return;
        }

        // Heartbeat cadence, as a real client: ~500ms. Before each heartbeat,
        // verify the server actually applied the previous packets; a large gap
        // means something (root, teleport, rejection) interrupted the move.
        if (nowMs - m.lastPacketMs >= 500)
        {
            if (player->GetExactDist2d(m.curX, m.curY) > 15.0f)
            {
                SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                    player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation());
                FinishMove(s, "interrupted");
                return;
            }
            SendMovePacket(s, player, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO);
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
        }

        // Progress events: the position the module's client-side movement engine
        // is at — knowledge a real client has locally.
        if (nowMs - m.lastProgressMs >= 1000)
        {
            m.lastProgressMs = nowMs;
            Json::Writer w;
            w.Add("moveId", m.moveId);
            w.Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO));
            EmitEvent(s, "WB_MOVE_PROGRESS", 0xFF02, w.Str());
        }
    }

    std::shared_ptr<BenchSession> Manager::TeardownByToken(std::string const& token)
    {
        std::shared_ptr<BenchSession> s;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            auto it = _byToken.find(token);
            if (it != _byToken.end())
            {
                s = it->second;
                _byToken.erase(it);
                if (s->ws)
                    _byWs.erase(s->ws);
            }
        }
        if (!s || s->tearingDown.exchange(true))
            return s;

        // Closing the parked socket is exactly a client disconnect at the WorldSession
        // level: core runs LogoutPlayer(save) on its next update and saves the char.
        if (s->socket)
            s->socket->CloseSocket();
        return s;
    }

    void Manager::DoDeleteSession(std::string token, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = TeardownByToken(token);
        if (!s)
            return ack->set_value({404, Json::Writer().Add("ok", false).Add("error", "no_session").Str()});
        Audit(*s, "action", Json::Writer().Add("op", "session_delete").Str());
        ack->set_value({200, Json::Writer().Add("ok", true).Add("token", token).Str()});
    }

    // --------------------------------------------------------------- tap
    // Walk an SMSG_CHAR_ENUM and return the GUID of the character whose name
    // matches (case-insensitive), or 0. Selecting by name, not list position, is
    // required: the account accumulates characters across episodes, so the one we
    // just created is not necessarily first. Reading the name from the enum packet
    // (not sCharacterCache) keeps us within the observation contract.
    static uint64_t FindCharInEnum(WorldPacket const& packet, std::string const& wantName);

    bool Manager::OnPacketSend(WorldSession* ws, WorldPacket const& packet)
    {
        auto s = FindByWs(ws);
        if (!s)
            return true; // not a bench session: let the core handle it normally

        uint16 opcode = packet.GetOpcode();
        std::string name, dataJson;
        bool whitelisted;
        if (opcode == SMSG_UPDATE_OBJECT)
        {
            // The hot path (ADR-0005): decoded inline, one pass, per-session
            // object-type cache for VALUES blocks. Compression is not a concern
            // here: EncryptableAndCompressiblePacket::CompressIfNeeded runs at
            // socket-write time, below this tap, so SMSG_COMPRESSED_UPDATE_OBJECT
            // never reaches us.
            name = "SMSG_UPDATE_OBJECT";
            dataJson = DecodeUpdateObject(*s, ws, packet);
            whitelisted = true;
        }
        else
            whitelisted = DecodeEvent(*s, ws, opcode, packet, name, dataJson);

        // Answer time sync like a client whose clock is the server clock, so the
        // session's clock delta stays ~0 and synthesized movement timestamps are
        // accepted without the fallback-log spam in SynchronizeMovement.
        if (opcode == SMSG_TIME_SYNC_REQ)
        {
            WorldPacket copy(packet);
            uint32 counter = 0;
            if (copy.size() >= 4) copy >> counter;
            WorldPacket tmp(CMSG_TIME_SYNC_RESP, 8);
            tmp << counter << uint32(getMSTime());
            ws->QueuePacket(new WorldPacket(std::move(tmp), GameTime::Now()));
        }

        // Keep the client-side object cache in sync with destroys.
        if (opcode == SMSG_DESTROY_OBJECT && packet.size() >= 8)
        {
            WorldPacket copy(packet);
            uint64 guid = 0; copy >> guid;
            std::lock_guard<std::mutex> lock(s->objMutex);
            s->knownObjects.erase(guid);
        }

        // Drive the login state machine off the packets we observe.
        int phase = s->phase.load();
        switch (opcode)
        {
            case SMSG_AUTH_RESPONSE:
            {
                WorldPacket copy(packet);
                uint8 code = 0;
                if (copy.size() >= 1) copy >> code;
                if (phase == BenchSession::P_AUTH && code == AUTH_OK)
                {
                    WorldPacket* p = new WorldPacket(CMSG_CHAR_ENUM, 0);
                    ws->QueuePacket(p);
                    s->phase.store(BenchSession::P_ENUM);
                }
                break;
            }
            case SMSG_CHAR_ENUM:
            {
                if (s->listMode)
                {
                    if (phase == BenchSession::P_ENUM)
                    {
                        // dataJson is the whitelisted decode of this very packet:
                        // {"count":N,"characters":[{guid,name,race,class,gender,level},...]}
                        if (!s->ackFired.exchange(true) && s->ack)
                            s->ack->set_value({200, Json::Writer().Add("ok", true).Add("token", s->token)
                                .Raw("enum", dataJson).Str()});
                        if (!s->tearingDown.exchange(true))
                        {
                            {
                                std::lock_guard<std::mutex> lock(_sessMutex);
                                _byToken.erase(s->token);
                                if (s->ws)
                                    _byWs.erase(s->ws);
                            }
                            if (s->socket)
                                s->socket->CloseSocket();
                        }
                    }
                    break;
                }
                if (s->deleteMode)
                {
                    if (phase == BenchSession::P_ENUM)
                    {
                        uint64_t matchGuid = FindCharInEnum(packet, s->charName);
                        if (matchGuid == 0)
                            FailAck(*s, "character_not_found");
                        else
                        {
                            s->targetGuidRaw = matchGuid;
                            WorldPacket* p = new WorldPacket(CMSG_CHAR_DELETE, 8);
                            *p << uint64(matchGuid);
                            ws->QueuePacket(p);
                            s->phase.store(BenchSession::P_DELETE);
                        }
                    }
                    break;
                }
                if (phase == BenchSession::P_ENUM || phase == BenchSession::P_ENUM2)
                {
                    uint64_t matchGuid = FindCharInEnum(packet, s->charName);
                    if (matchGuid != 0)
                    {
                        s->targetGuidRaw = matchGuid;
                        WorldPacket* p = new WorldPacket(CMSG_PLAYER_LOGIN, 8);
                        *p << uint64(matchGuid);
                        ws->QueuePacket(p);
                        s->phase.store(BenchSession::P_LOGIN);
                    }
                    else if (phase == BenchSession::P_ENUM)
                    {
                        // The character does not exist, so this session must
                        // CREATE one — the point where race/class stop being
                        // ignorable. Reject out-of-range values before any
                        // char-create packet is synthesized (400, not the
                        // usual 502: this is a caller error, not a game one).
                        if (s->charRace < 1 || s->charRace > 11 || s->charClass < 1 || s->charClass > 11)
                        {
                            FailAck(*s, "invalid_race_class", 400);
                            break;
                        }
                        WorldPacket* p = new WorldPacket(CMSG_CHAR_CREATE, 32);
                        *p << s->charName;
                        *p << uint8(s->charRace) << uint8(s->charClass) << uint8(s->charGender);
                        *p << uint8(0) << uint8(0) << uint8(0) << uint8(0) << uint8(0) << uint8(0); // appearance + outfit
                        ws->QueuePacket(p);
                        s->phase.store(BenchSession::P_CREATE);
                    }
                    else
                    {
                        FailAck(*s, "character_missing_after_create");
                    }
                }
                break;
            }
            case SMSG_CHAR_CREATE:
            {
                WorldPacket copy(packet);
                uint8 result = 0;
                if (copy.size() >= 1) copy >> result;
                if (phase == BenchSession::P_CREATE)
                {
                    if (result == CHAR_CREATE_SUCCESS)
                    {
                        WorldPacket* p = new WorldPacket(CMSG_CHAR_ENUM, 0);
                        ws->QueuePacket(p);
                        s->phase.store(BenchSession::P_ENUM2);
                    }
                    else
                    {
                        FailAck(*s, "char_create_failed_code_" + std::to_string(result));
                    }
                }
                break;
            }
            case SMSG_CHAR_DELETE:
            {
                WorldPacket copy(packet);
                uint8 result = 0;
                if (copy.size() >= 1) copy >> result;
                if (phase == BenchSession::P_DELETE)
                {
                    if (result == CHAR_DELETE_SUCCESS)
                    {
                        if (!s->ackFired.exchange(true) && s->ack)
                            s->ack->set_value({200, Json::Writer().Add("ok", true).Add("token", s->token)
                                .Add("character", s->charName).Add("deleted", true).Str()});
                        // The utility session's job is done: discard it the same
                        // way a failed login discards its session.
                        if (!s->tearingDown.exchange(true))
                        {
                            {
                                std::lock_guard<std::mutex> lock(_sessMutex);
                                _byToken.erase(s->token);
                                if (s->ws)
                                    _byWs.erase(s->ws);
                            }
                            if (s->socket)
                                s->socket->CloseSocket();
                        }
                    }
                    else
                        FailAck(*s, "char_delete_failed_code_" + std::to_string(result));
                }
                break;
            }
            case SMSG_LOGIN_VERIFY_WORLD:
                if (phase == BenchSession::P_LOGIN)
                {
                    s->phase.store(BenchSession::P_INWORLD);
                    SucceedAck(*s);
                }
                break;
            case SMSG_CHARACTER_LOGIN_FAILED:
                if (phase == BenchSession::P_LOGIN || phase == BenchSession::P_ENUM || phase == BenchSession::P_ENUM2)
                    FailAck(*s, "login_failed");
                break;
            default:
                break;
        }

        if (whitelisted)
            EmitEvent(*s, name, opcode, dataJson);
        else
        {
            s->dropCount.fetch_add(1);
            _totalDrops.fetch_add(1);
            // Per-opcode histogram for the whitelist-expansion census
            // (PHASE-0). Relaxed atomic add: this is the hot path, fired for
            // every non-whitelisted packet on world and map threads.
            if (opcode < kOpcodeSpace)
                _dropsByOpcode[opcode].fetch_add(1, std::memory_order_relaxed);
        }

        return false; // never write bench packets to the parked socket
    }

    // ------------------------------------------------------- ack helpers
    void Manager::SucceedAck(BenchSession& s)
    {
        if (s.ackFired.exchange(true) || !s.ack)
            return;
        Json::Writer w;
        w.Add("ok", true).Add("token", s.token).Add("account", s.account)
         .Add("character", s.charName).AddGuid("guid", s.targetGuidRaw).Add("inWorld", true);
        s.ack->set_value({200, w.Str()});
    }

    void Manager::FailAck(BenchSession& s, std::string const& message, int status /*= 502*/)
    {
        if (!s.ackFired.exchange(true) && s.ack)
            s.ack->set_value({status, Json::Writer().Add("ok", false).Add("error", message).Add("token", s.token).Str()});

        // A failure here means the session never reached the world; discard it so it
        // does not linger in the session maps. Called from the tap on the world
        // thread, so touching the socket is safe.
        if (s.tearingDown.exchange(true))
            return;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            _byToken.erase(s.token);
            if (s.ws)
                _byWs.erase(s.ws);
        }
        if (s.socket)
            s.socket->CloseSocket();
    }

    // --------------------------------------------------------- events/audit
    void Manager::EmitEvent(BenchSession& s, std::string const& opcodeName, uint16_t opcodeId, std::string const& dataJson)
    {
        uint64_t seq = s.eventSeq.fetch_add(1);
        Json::Writer w;
        w.Add("seq", seq).Add("opcode", opcodeName).Add("opcodeId", (uint32)opcodeId).Add("ts", (int64_t)NowMs());
        w.Raw("data", dataJson.empty() ? "{}" : dataJson);
        std::string json = w.Str();

        Audit(s, "event", json);

        std::vector<std::shared_ptr<IWsConn>> conns;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            auto it = _wsByToken.find(s.token);
            if (it != _wsByToken.end())
                conns = it->second;
        }
        for (auto& c : conns)
            c->Send(json);
    }

    void Manager::Audit(BenchSession& s, char const* kind, std::string const& json)
    {
        std::lock_guard<std::mutex> lock(s.auditMutex);
        if (!s.audit.is_open())
            return;
        Json::Writer w;
        w.Add("ts", (int64_t)NowMs()).Add("session", s.token).Add("kind", kind);
        w.Raw("payload", json);
        s.audit << w.Str() << '\n';
        s.audit.flush();
    }

    // ------------------------------------------------------- ws attach
    void Manager::OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn)
    {
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            _wsByToken[token].push_back(std::move(conn));
        }

        // Reattach state (io thread): a subscriber that connects after
        // SMSG_LOGIN_VERIFY_WORLD fired would otherwise never learn its own
        // position/map. Emit one synthetic WB_SESSION_STATE event carrying only
        // client-visible facts (what LOGIN_VERIFY_WORLD plus the session's own
        // identity would carry). Player state must be read on the world thread,
        // so the event is delivered asynchronously via the task queue; it takes
        // the next seq and fans out to every subscriber like any event, keeping
        // seq gapless for subscribers that stayed connected.
        auto s = FindByToken(token);
        if (!s || s->phase.load() != BenchSession::P_INWORLD || s->tearingDown.load())
            return;
        PushTask([this, s]() {
            if (s->tearingDown.load() || s->phase.load() != BenchSession::P_INWORLD)
                return;
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                return;
            Player* player = s->ws->GetPlayer();
            if (!player || !player->IsInWorld())
                return;
            Json::Writer w;
            w.Add("character", s->charName)
             .AddGuid("guid", (uint64_t)player->GetGUID().GetRawValue())
             .Add("inWorld", true)
             .Add("map", player->GetMapId())
             .Add("x", (double)player->GetPositionX())
             .Add("y", (double)player->GetPositionY())
             .Add("z", (double)player->GetPositionZ())
             .Add("o", (double)player->GetOrientation())
             .Add("level", (uint32)player->GetLevel());
            EmitEvent(*s, "WB_SESSION_STATE", 0xFF03, w.Str());
        });
    }

    void Manager::OnWsClose(std::string const& token, IWsConn* conn)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        auto it = _wsByToken.find(token);
        if (it == _wsByToken.end())
            return;
        auto& vec = it->second;
        vec.erase(std::remove_if(vec.begin(), vec.end(),
            [conn](std::shared_ptr<IWsConn> const& c) { return c.get() == conn; }), vec.end());
        if (vec.empty())
            _wsByToken.erase(it);
    }

    // =================================================================
    // SMSG_UPDATE_OBJECT decoding (the observation hot path, ADR-0005/0010).
    // Layouts mirror Object::BuildCreateUpdateBlockForPlayer /
    // BuildMovementUpdate / BuildValuesUpdate and UpdateData::BuildPacket at
    // the pinned commit. Only whitelisted fields are named; everything else in
    // the mask is consumed and dropped (docs/CONTRACTS.md).
    // =================================================================

    static char const* TypeIdName(uint8 typeId)
    {
        switch (typeId)
        {
            case TYPEID_OBJECT:        return "object";
            case TYPEID_ITEM:          return "item";
            case TYPEID_CONTAINER:     return "container";
            case TYPEID_UNIT:          return "unit";
            case TYPEID_PLAYER:        return "player";
            case TYPEID_GAMEOBJECT:    return "gameObject";
            case TYPEID_DYNAMICOBJECT: return "dynamicObject";
            case TYPEID_CORPSE:        return "corpse";
            default:                   return "unknown";
        }
    }

    // Skip a Movement::PacketBuilder::WriteCreate spline blob (never served: the
    // client gets it, but serving creature spline paths would leak route data the
    // player only sees as animation; position comes from the movement block).
    static void SkipSplineCreate(WorldPacket& p)
    {
        uint32 sflags; p >> sflags;
        if (sflags & 0x00020000)      { float a; p >> a; }                    // Final_Angle
        else if (sflags & 0x00010000) { uint64 t; p >> t; }                   // Final_Target
        else if (sflags & 0x00008000) { float fx, fy, fz; p >> fx >> fy >> fz; } // Final_Point
        uint32 timePassed, duration, id; p >> timePassed >> duration >> id;
        float durMod, durModNext, vertAccel; p >> durMod >> durModNext >> vertAccel;
        uint32 effectStart; p >> effectStart;
        uint32 nodes; p >> nodes;
        p.rpos(p.rpos() + size_t(nodes) * 12);
        uint8 mode; p >> mode;
        float ex, ey, ez; p >> ex >> ey >> ez;
    }

    // Parse the movement part of a CREATE/MOVEMENT block (Object::BuildMovementUpdate)
    // and add pos / moveFlags / runSpeed / self / targetGuid to the object JSON.
    static void DecodeMovementBlockUpd(WorldPacket& p, Json::Writer& o)
    {
        uint16 flags; p >> flags;
        if (flags & UPDATEFLAG_SELF)
            o.Add("self", true);

        if (flags & UPDATEFLAG_LIVING)
        {
            uint32 mflags; uint16 mflags2; uint32 mtime;
            p >> mflags >> mflags2 >> mtime;
            float x, y, z, ori;
            p >> x >> y >> z >> ori;
            if (mflags & MOVEMENTFLAG_ONTRANSPORT)
            {
                uint64 tg; p.readPackGUID(tg);
                float tx, ty, tz, to; uint32 tt; uint8 seat;
                p >> tx >> ty >> tz >> to >> tt >> seat;
                if (mflags2 & MOVEMENTFLAG2_INTERPOLATED_MOVEMENT)
                    { uint32 t2; p >> t2; }
            }
            if ((mflags & (MOVEMENTFLAG_SWIMMING | MOVEMENTFLAG_FLYING)) || (mflags2 & MOVEMENTFLAG2_ALWAYS_ALLOW_PITCHING))
                { float pitch; p >> pitch; }
            uint32 fallTime; p >> fallTime;
            if (mflags & MOVEMENTFLAG_FALLING)
                { float a, b, c, d; p >> a >> b >> c >> d; }
            if (mflags & MOVEMENTFLAG_SPLINE_ELEVATION)
                { float se; p >> se; }
            float speeds[9];
            for (float& sp : speeds) p >> sp;
            if (mflags & MOVEMENTFLAG_SPLINE_ENABLED)
                SkipSplineCreate(p);
            o.Add("moveFlags", mflags);
            o.Raw("pos", PosJson(x, y, z, ori));
            o.Add("runSpeed", (double)speeds[1]);
        }
        else if (flags & UPDATEFLAG_POSITION)
        {
            uint64 tg; p.readPackGUID(tg);
            float x, y, z, cx, cy, cz, ori, cOri;
            p >> x >> y >> z >> cx >> cy >> cz >> ori >> cOri;
            o.Raw("pos", PosJson(x, y, z, ori));
        }
        else if (flags & UPDATEFLAG_STATIONARY_POSITION)
        {
            float x, y, z, ori;
            p >> x >> y >> z >> ori;
            o.Raw("pos", PosJson(x, y, z, ori));
        }

        if (flags & UPDATEFLAG_UNKNOWN)   { uint32 u; p >> u; }
        if (flags & UPDATEFLAG_LOWGUID)   { uint32 u; p >> u; }
        if (flags & UPDATEFLAG_HAS_TARGET)
        {
            uint64 tg = 0; p.readPackGUID(tg);
            o.AddGuid("targetGuid", (uint64_t)tg);
        }
        if (flags & UPDATEFLAG_TRANSPORT) { uint32 t; p >> t; }
        if (flags & UPDATEFLAG_VEHICLE)   { uint32 vid; float vo; p >> vid >> vo; }
        if (flags & UPDATEFLAG_ROTATION)  { int64 rot; p >> rot; }
    }

    // One whitelisted update field -> named JSON key. Returns false if the index
    // is not served (caller has already consumed the value).
    static bool AppendNamedField(Json::Writer& f, uint8 typeId, uint32 index, uint32 v,
        uint32& tLo, uint32& tHi, bool& hasLo, bool& hasHi, uint32* entryOut)
    {
        if (index == OBJECT_FIELD_ENTRY)
        {
            f.Add("entry", v);
            if (entryOut) *entryOut = v;
            return true;
        }
        if (index == OBJECT_FIELD_SCALE_X)
        {
            float fv; std::memcpy(&fv, &v, 4);
            f.Add("scale", (double)fv);
            return true;
        }

        if (typeId == TYPEID_UNIT || typeId == TYPEID_PLAYER)
        {
            if (index == UNIT_FIELD_TARGET)     { tLo = v; hasLo = true; return true; }
            if (index == UNIT_FIELD_TARGET + 1) { tHi = v; hasHi = true; return true; }
            switch (index)
            {
                case UNIT_FIELD_BYTES_0:
                    f.Add("race", v & 0xFF).Add("class", (v >> 8) & 0xFF)
                     .Add("gender", (v >> 16) & 0xFF).Add("powerType", (v >> 24) & 0xFF);
                    return true;
                case UNIT_FIELD_HEALTH:          f.Add("health", v); return true;
                case UNIT_FIELD_MAXHEALTH:       f.Add("maxHealth", v); return true;
                case UNIT_FIELD_LEVEL:           f.Add("level", v); return true;
                case UNIT_FIELD_FACTIONTEMPLATE: f.Add("faction", v); return true;
                case UNIT_FIELD_FLAGS:           f.Add("unitFlags", v); return true;
                case UNIT_FIELD_DISPLAYID:       f.Add("displayId", v); return true;
                case UNIT_DYNAMIC_FLAGS:         f.Add("dynamicFlags", v); return true;
                case UNIT_NPC_FLAGS:             f.Add("npcFlags", v); return true;
                default: break;
            }
            if (index >= UNIT_FIELD_POWER1 && index < UNIT_FIELD_POWER1 + 7)
            {
                f.Add("power" + std::to_string(index - UNIT_FIELD_POWER1 + 1), v);
                return true;
            }
            if (index >= UNIT_FIELD_MAXPOWER1 && index < UNIT_FIELD_MAXPOWER1 + 7)
            {
                f.Add("maxPower" + std::to_string(index - UNIT_FIELD_MAXPOWER1 + 1), v);
                return true;
            }
            if (typeId == TYPEID_PLAYER)
            {
                if (index == PLAYER_FLAGS)          { f.Add("playerFlags", v); return true; }
                if (index == PLAYER_FIELD_COINAGE)  { f.Add("money", v); return true; }
                if (index == PLAYER_XP)             { f.Add("xp", v); return true; }
                if (index == PLAYER_NEXT_LEVEL_XP)  { f.Add("nextLevelXp", v); return true; }
                // Quest log: 25 slots x 5 fields (id, state, counts lo/hi, time).
                // Served raw; the SDK reassembles its quest-log view from them.
                if (index >= PLAYER_QUEST_LOG_1_1 && index < PLAYER_QUEST_LOG_25_1 + 5)
                {
                    uint32 rel = index - PLAYER_QUEST_LOG_1_1;
                    static char const* offName[5] = { "Id", "State", "CountsLo", "CountsHi", "Time" };
                    f.Add("quest" + std::to_string(rel / 5) + offName[rel % 5], v);
                    return true;
                }
                // Equipment/bag/backpack item guids as lo/hi u32 halves keyed by
                // inventory slot (0-22 equipment+bags, 23-38 backpack). Halves
                // stay u32 JSON numbers; the SDK joins them into guids.
                if (index >= PLAYER_FIELD_INV_SLOT_HEAD && index < PLAYER_FIELD_PACK_SLOT_1 + 32)
                {
                    uint32 rel = index - PLAYER_FIELD_INV_SLOT_HEAD;
                    f.Add("invSlot" + std::to_string(rel / 2) + (rel % 2 ? "Hi" : "Lo"), v);
                    return true;
                }
            }
        }
        else if (typeId == TYPEID_ITEM || typeId == TYPEID_CONTAINER)
        {
            switch (index)
            {
                case ITEM_FIELD_STACK_COUNT:   f.Add("stackCount", v); return true;
                case ITEM_FIELD_DURABILITY:    f.Add("durability", v); return true;
                case ITEM_FIELD_MAXDURABILITY: f.Add("maxDurability", v); return true;
                case ITEM_FIELD_FLAGS:         f.Add("itemFlags", v); return true;
                default: break;
            }
            if (index == ITEM_FIELD_OWNER)         { f.Add("ownerLo", v); return true; }
            if (index == ITEM_FIELD_OWNER + 1)     { f.Add("ownerHi", v); return true; }
            if (index == ITEM_FIELD_CONTAINED)     { f.Add("containedLo", v); return true; }
            if (index == ITEM_FIELD_CONTAINED + 1) { f.Add("containedHi", v); return true; }
        }
        else if (typeId == TYPEID_GAMEOBJECT)
        {
            switch (index)
            {
                case GAMEOBJECT_DISPLAYID: f.Add("goDisplayId", v); return true;
                case GAMEOBJECT_FLAGS:     f.Add("goFlags", v); return true;
                case GAMEOBJECT_FACTION:   f.Add("goFaction", v); return true;
                case GAMEOBJECT_LEVEL:     f.Add("goLevel", v); return true;
                case GAMEOBJECT_BYTES_1:
                    f.Add("goState", v & 0xFF).Add("goType", (v >> 8) & 0xFF);
                    return true;
                default: break;
            }
        }
        return false;
    }

    // Parse a BuildValuesUpdate mask+values run into the whitelisted named
    // fields. All values are consumed regardless of whitelist membership.
    static std::string DecodeValuesBlock(WorldPacket& p, uint8 typeId, uint32* entryOut)
    {
        uint8 blockCount; p >> blockCount;
        uint32 mask[64]; // m_valuesCount caps far below 64*32 fields
        if (blockCount > 64)
            throw ByteBufferException();
        for (uint8 i = 0; i < blockCount; ++i)
            p >> mask[i];

        Json::Writer f;
        uint32 tLo = 0, tHi = 0;
        bool hasLo = false, hasHi = false;
        uint32 fieldCount = uint32(blockCount) * 32;
        for (uint32 i = 0; i < fieldCount; ++i)
        {
            if (!(mask[i >> 5] & (1u << (i & 31))))
                continue;
            uint32 v; p >> v;
            AppendNamedField(f, typeId, i, v, tLo, tHi, hasLo, hasHi, entryOut);
        }
        if (hasLo)
            f.AddGuid("targetGuid", uint64_t(tLo) | (uint64_t(tHi) << 32));
        return f.Str();
    }

    std::string Manager::DecodeUpdateObject(BenchSession& s, WorldSession* ws, WorldPacket const& packet)
    {
        WorldPacket p(packet);
        // Creature/name queries a real client would fire on cache miss; issued
        // after the parse so a decode error doesn't send half-baked queries.
        std::vector<std::pair<uint32, uint64_t>> creatureQueries;
        std::vector<uint64_t> nameQueries;
        std::vector<uint32_t> itemQueries;

        Json::Writer top;
        std::string objects = "[";
        bool first = true;
        try
        {
            uint32 blockCount; p >> blockCount;
            top.Add("blocks", blockCount);
            for (uint32 b = 0; b < blockCount; ++b)
            {
                uint8 updateType; p >> updateType;
                Json::Writer o;
                switch (updateType)
                {
                    case UPDATETYPE_VALUES:
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        uint8 typeId = 0xFF;
                        {
                            std::lock_guard<std::mutex> lock(s.objMutex);
                            auto it = s.knownObjects.find(guid);
                            if (it != s.knownObjects.end())
                                typeId = it->second;
                        }
                        o.Add("update", "values").AddGuid("guid", (uint64_t)guid);
                        std::string fields = DecodeValuesBlock(p, typeId, nullptr);
                        o.Raw("fields", fields);
                        break;
                    }
                    case UPDATETYPE_MOVEMENT:
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        o.Add("update", "movement").AddGuid("guid", (uint64_t)guid);
                        DecodeMovementBlockUpd(p, o);
                        break;
                    }
                    case UPDATETYPE_CREATE_OBJECT:
                    case UPDATETYPE_CREATE_OBJECT2:
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        uint8 typeId; p >> typeId;
                        o.Add("update", "create").AddGuid("guid", (uint64_t)guid)
                         .Add("objectType", TypeIdName(typeId));
                        DecodeMovementBlockUpd(p, o);
                        uint32 entry = 0;
                        std::string fields = DecodeValuesBlock(p, typeId, &entry);
                        o.Raw("fields", fields);
                        {
                            std::lock_guard<std::mutex> lock(s.objMutex);
                            s.knownObjects[guid] = typeId;
                            if (typeId == TYPEID_UNIT && entry && s.queriedCreatures.insert(entry).second)
                                creatureQueries.emplace_back(entry, guid);
                            if (typeId == TYPEID_PLAYER && s.queriedNames.insert(guid).second)
                                nameQueries.push_back(guid);
                            if ((typeId == TYPEID_ITEM || typeId == TYPEID_CONTAINER)
                                && entry && s.queriedItems.insert(entry).second)
                                itemQueries.push_back(entry);
                        }
                        break;
                    }
                    case UPDATETYPE_OUT_OF_RANGE_OBJECTS:
                    case UPDATETYPE_NEAR_OBJECTS:
                    {
                        uint32 n; p >> n;
                        std::string guids = "[";
                        for (uint32 i = 0; i < n; ++i)
                        {
                            uint64 guid = 0; p.readPackGUID(guid);
                            if (i) guids += ',';
                            guids += '"' + std::to_string(guid) + '"';
                            if (updateType == UPDATETYPE_OUT_OF_RANGE_OBJECTS)
                            {
                                std::lock_guard<std::mutex> lock(s.objMutex);
                                s.knownObjects.erase(guid);
                            }
                        }
                        guids += "]";
                        o.Add("update", updateType == UPDATETYPE_OUT_OF_RANGE_OBJECTS ? "outOfRange" : "near");
                        o.Raw("guids", guids);
                        break;
                    }
                    default:
                        // Unknown block type: cannot resync the stream, bail out.
                        throw ByteBufferException();
                }
                if (!first) objects += ',';
                objects += o.Str();
                first = false;
            }
        }
        catch (std::exception const&)
        {
            return Json::Writer().Add("decodeError", true).Str();
        }
        objects += "]";
        top.Raw("objects", objects);

        for (auto const& [entry, guid] : creatureQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_CREATURE_QUERY, 12);
            *q << uint32(entry) << uint64(guid);
            ws->QueuePacket(q);
        }
        for (uint64_t guid : nameQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_NAME_QUERY, 8);
            *q << uint64(guid);
            ws->QueuePacket(q);
        }
        for (uint32_t entry : itemQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_ITEM_QUERY_SINGLE, 4);
            *q << uint32(entry);
            ws->QueuePacket(q);
        }
        return top.Str();
    }

    // Opcode-name helper for the observed MSG_MOVE_* whitelist.
    static char const* MoveOpcodeName(uint16 opcode)
    {
        switch (opcode)
        {
            case MSG_MOVE_START_FORWARD:      return "MSG_MOVE_START_FORWARD";
            case MSG_MOVE_START_BACKWARD:     return "MSG_MOVE_START_BACKWARD";
            case MSG_MOVE_STOP:               return "MSG_MOVE_STOP";
            case MSG_MOVE_START_STRAFE_LEFT:  return "MSG_MOVE_START_STRAFE_LEFT";
            case MSG_MOVE_START_STRAFE_RIGHT: return "MSG_MOVE_START_STRAFE_RIGHT";
            case MSG_MOVE_STOP_STRAFE:        return "MSG_MOVE_STOP_STRAFE";
            case MSG_MOVE_JUMP:               return "MSG_MOVE_JUMP";
            case MSG_MOVE_START_TURN_LEFT:    return "MSG_MOVE_START_TURN_LEFT";
            case MSG_MOVE_START_TURN_RIGHT:   return "MSG_MOVE_START_TURN_RIGHT";
            case MSG_MOVE_STOP_TURN:          return "MSG_MOVE_STOP_TURN";
            case MSG_MOVE_SET_FACING:         return "MSG_MOVE_SET_FACING";
            case MSG_MOVE_HEARTBEAT:          return "MSG_MOVE_HEARTBEAT";
            case MSG_MOVE_FALL_LAND:          return "MSG_MOVE_FALL_LAND";
            case MSG_MOVE_START_SWIM:         return "MSG_MOVE_START_SWIM";
            case MSG_MOVE_STOP_SWIM:          return "MSG_MOVE_STOP_SWIM";
            case MSG_MOVE_SET_RUN_MODE:       return "MSG_MOVE_SET_RUN_MODE";
            case MSG_MOVE_SET_WALK_MODE:      return "MSG_MOVE_SET_WALK_MODE";
            default:                          return "MSG_MOVE";
        }
    }

    // One AuraApplication::BuildUpdatePacket block (SMSG_AURA_UPDATE[_ALL]).
    static std::string ReadAuraBlock(WorldPacket& p)
    {
        uint8 slot; p >> slot;
        uint32 spellId; p >> spellId;
        Json::Writer a;
        a.Add("slot", (uint32)slot).Add("spellId", spellId);
        if (spellId)
        {
            uint8 flags, level, stacks;
            p >> flags >> level >> stacks;
            a.Add("flags", (uint32)flags).Add("level", (uint32)level).Add("stacks", (uint32)stacks);
            if (!(flags & 0x08))                            // !AFLAG_CASTER: caster guid follows
            {
                uint64 caster = 0; p.readPackGUID(caster);
                a.AddGuid("casterGuid", (uint64_t)caster);
            }
            if (flags & 0x20)                               // AFLAG_DURATION
            {
                uint32 maxDur, dur; p >> maxDur >> dur;
                a.Add("maxDuration", maxDur).Add("duration", dur);
            }
        }
        else
            a.Add("removed", true);
        return a.Str();
    }

    // Read a SpellCastTargets::Write block far enough to name the object
    // target; everything else is consumed by position in the packet copy only.
    static void ReadSpellTargets(WorldPacket& p, Json::Writer& w)
    {
        uint32 mask; p >> mask;
        // unit | minipet | gameobject | corpse_enemy | corpse_ally
        if (mask & (0x0002 | 0x00010000 | 0x0800 | 0x0200 | 0x8000))
        {
            uint64 tg = 0; p.readPackGUID(tg);
            w.AddGuid("targetGuid", (uint64_t)tg);
        }
    }

    void Manager::QueryItems(BenchSession& s, WorldSession* ws, std::vector<uint32_t> const& entries)
    {
        std::vector<uint32_t> toQuery;
        {
            std::lock_guard<std::mutex> lock(s.objMutex);
            for (uint32_t e : entries)
                if (e && s.queriedItems.insert(e).second)
                    toQuery.push_back(e);
        }
        for (uint32_t e : toQuery)
        {
            WorldPacket* q = new WorldPacket(CMSG_ITEM_QUERY_SINGLE, 4);
            *q << uint32(e);
            ws->QueuePacket(q);
        }
    }

    // =================================================================
    // Whitelisted SMSG decoders. Field layouts mirror the server-side
    // builders in AzerothCore at the pinned commit; see module/PROTOCOL.md.
    // =================================================================
    bool Manager::DecodeEvent(BenchSession& s, WorldSession* ws, uint16_t opcode,
        WorldPacket const& packet, std::string& name, std::string& dataJson)
    {
        WorldPacket p(packet); // copy so reads don't disturb the live packet
        Json::Writer w;
        // Item entries seen in this packet; queried like a client cache miss
        // after a clean parse.
        std::vector<uint32_t> itemEntries;
        try
        {
            switch (opcode)
            {
                case SMSG_AUTH_RESPONSE:
                {
                    name = "SMSG_AUTH_RESPONSE";
                    uint8 code = 0; if (p.size() >= 1) p >> code;
                    w.Add("code", (uint32)code);
                    break;
                }
                case SMSG_CHAR_CREATE:
                {
                    name = "SMSG_CHAR_CREATE";
                    uint8 code = 0; if (p.size() >= 1) p >> code;
                    w.Add("result", (uint32)code);
                    break;
                }
                case SMSG_CHARACTER_LOGIN_FAILED:
                {
                    name = "SMSG_CHARACTER_LOGIN_FAILED";
                    uint8 code = 0; if (p.size() >= 1) p >> code;
                    w.Add("reason", (uint32)code);
                    break;
                }
                case SMSG_LOGIN_VERIFY_WORLD:
                {
                    name = "SMSG_LOGIN_VERIFY_WORLD";
                    uint32 map = 0; float x = 0, y = 0, z = 0, o = 0;
                    p >> map >> x >> y >> z >> o;
                    w.Add("map", map).Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Add("o", (double)o);
                    break;
                }
                case SMSG_MOTD:
                {
                    name = "SMSG_MOTD";
                    uint32 lineCount = 0; p >> lineCount;
                    std::string lines = "[";
                    for (uint32 i = 0; i < lineCount && p.rpos() < p.size(); ++i)
                    {
                        std::string line; p >> line;
                        if (i) lines += ',';
                        lines += Json::Str(line);
                    }
                    lines += "]";
                    w.Add("lineCount", lineCount).Raw("lines", lines);
                    break;
                }
                case SMSG_NOTIFICATION:
                {
                    name = "SMSG_NOTIFICATION";
                    std::string text; p >> text;
                    w.Add("text", text);
                    break;
                }
                case SMSG_NAME_QUERY_RESPONSE:
                {
                    name = "SMSG_NAME_QUERY_RESPONSE";
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint8 unknown = 1; if (p.rpos() < p.size()) p >> unknown; // NameUnknown
                    w.AddGuid("guid", (uint64_t)guid).Add("found", unknown == 0);
                    if (unknown == 0 && p.rpos() < p.size())
                    {
                        std::string pname; p >> pname;
                        w.Add("name", pname);
                    }
                    break;
                }
                case SMSG_MESSAGECHAT:
                {
                    name = "SMSG_MESSAGECHAT";
                    uint8 type = 0; int32 lang = 0; uint64 sender = 0; uint32 flags = 0;
                    p >> type >> lang >> sender >> flags;
                    // For CHAT_MSG_SAY the next field is the (unused) receiver GUID.
                    uint64 receiver = 0;
                    if (p.rpos() + 8 <= p.size()) p >> receiver;
                    uint32 msgLen = 0; if (p.rpos() + 4 <= p.size()) p >> msgLen;
                    std::string msg;
                    if (msgLen > 0 && p.rpos() + msgLen <= p.size())
                    {
                        msg.assign((char const*)p.contents() + p.rpos(), msgLen);
                        if (!msg.empty() && msg.back() == '\0') msg.pop_back();
                        p.rpos(p.rpos() + msgLen);
                    }
                    uint8 chatTag = 0; if (p.rpos() < p.size()) p >> chatTag;
                    w.Add("type", (uint32)type).Add("language", lang).AddGuid("senderGuid", (uint64_t)sender)
                     .Add("message", msg).Add("chatTag", (uint32)chatTag);
                    break;
                }
                case SMSG_CHAR_ENUM:
                {
                    name = "SMSG_CHAR_ENUM";
                    uint8 count = 0; p >> count;
                    std::string chars = "[";
                    for (uint8 i = 0; i < count && p.rpos() < p.size(); ++i)
                    {
                        uint64 guid = 0; p >> guid;
                        std::string cname; p >> cname;
                        uint8 race = 0, cls = 0, gender = 0; p >> race >> cls >> gender;
                        uint8 skin, face, hair, hairColor, facial;
                        p >> skin >> face >> hair >> hairColor >> facial;
                        uint8 level = 0; p >> level;
                        uint32 zone = 0, map = 0; p >> zone >> map;
                        float x, y, z; p >> x >> y >> z;
                        uint32 guildId = 0, charFlags = 0, customize = 0; p >> guildId >> charFlags >> customize;
                        uint8 firstLogin = 0; p >> firstLogin;
                        uint32 petDisplay = 0, petLevel = 0, petFamily = 0; p >> petDisplay >> petLevel >> petFamily;
                        for (uint8 slot = 0; slot < 23; ++slot) // INVENTORY_SLOT_BAG_END
                        {
                            uint32 displayInfo = 0; uint8 invType = 0; uint32 enchant = 0;
                            p >> displayInfo >> invType >> enchant;
                        }
                        if (i) chars += ',';
                        chars += Json::Writer().AddGuid("guid", (uint64_t)guid).Add("name", cname)
                            .Add("race", (uint32)race).Add("class", (uint32)cls).Add("gender", (uint32)gender)
                            .Add("level", (uint32)level).Str();
                    }
                    chars += "]";
                    w.Add("count", (uint32)count).Raw("characters", chars);
                    break;
                }
                case SMSG_DESTROY_OBJECT:
                {
                    name = "SMSG_DESTROY_OBJECT";
                    uint64 guid = 0; p >> guid;
                    uint8 onDeath = 0; if (p.rpos() < p.size()) p >> onDeath;
                    w.AddGuid("guid", (uint64_t)guid).Add("onDeath", onDeath != 0);
                    break;
                }
                case SMSG_CREATURE_QUERY_RESPONSE:
                {
                    name = "SMSG_CREATURE_QUERY_RESPONSE";
                    uint32 entry = 0; p >> entry;
                    if (entry & 0x80000000)
                    {
                        w.Add("entry", entry & 0x7FFFFFFF).Add("found", false);
                        break;
                    }
                    std::string cname; p >> cname;
                    std::string n2, n3, n4; p >> n2 >> n3 >> n4; // always empty
                    std::string subname; p >> subname;
                    std::string iconName; p >> iconName;
                    uint32 typeFlags, ctype, family, rank;
                    p >> typeFlags >> ctype >> family >> rank;
                    w.Add("entry", entry).Add("found", true).Add("name", cname)
                     .Add("subname", subname).Add("type", ctype).Add("rank", rank);
                    break;
                }
                // Observed movement of nearby units/players, relayed by the server
                // with the same opcode the mover's client sent. Position only; the
                // extras (transport, fall, pitch) are skipped, not served.
                case MSG_MOVE_START_FORWARD: case MSG_MOVE_START_BACKWARD: case MSG_MOVE_STOP:
                case MSG_MOVE_START_STRAFE_LEFT: case MSG_MOVE_START_STRAFE_RIGHT: case MSG_MOVE_STOP_STRAFE:
                case MSG_MOVE_JUMP: case MSG_MOVE_START_TURN_LEFT: case MSG_MOVE_START_TURN_RIGHT:
                case MSG_MOVE_STOP_TURN: case MSG_MOVE_SET_FACING: case MSG_MOVE_HEARTBEAT:
                case MSG_MOVE_FALL_LAND: case MSG_MOVE_START_SWIM: case MSG_MOVE_STOP_SWIM:
                case MSG_MOVE_SET_RUN_MODE: case MSG_MOVE_SET_WALK_MODE:
                {
                    name = MoveOpcodeName(opcode);
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint32 mflags = 0; uint16 mflags2 = 0; uint32 mtime = 0;
                    p >> mflags >> mflags2 >> mtime;
                    float x, y, z, o;
                    p >> x >> y >> z >> o;
                    w.AddGuid("guid", (uint64_t)guid).Add("flags", mflags).Raw("pos", PosJson(x, y, z, o));
                    break;
                }
                // ---------------------------------------------------- combat
                case SMSG_ATTACKSTART:
                {
                    name = "SMSG_ATTACKSTART";
                    uint64 attacker, victim; p >> attacker >> victim;
                    w.AddGuid("attackerGuid", (uint64_t)attacker).AddGuid("victimGuid", (uint64_t)victim);
                    break;
                }
                case SMSG_ATTACKSTOP:
                {
                    name = "SMSG_ATTACKSTOP";
                    uint64 attacker = 0, victim = 0;
                    p.readPackGUID(attacker);
                    p.readPackGUID(victim);
                    uint32 nowDead = 0; p >> nowDead;
                    w.AddGuid("attackerGuid", (uint64_t)attacker).AddGuid("victimGuid", (uint64_t)victim)
                     .Add("attackerDead", nowDead != 0);
                    break;
                }
                case SMSG_ATTACKERSTATEUPDATE:
                {
                    // Compact summary of Unit::SendAttackStateUpdate: totals only,
                    // not every sub-damage field.
                    name = "SMSG_ATTACKERSTATEUPDATE";
                    uint32 hitInfo; p >> hitInfo;
                    uint64 attacker = 0, victim = 0;
                    p.readPackGUID(attacker);
                    p.readPackGUID(victim);
                    uint32 damage, overkill; p >> damage >> overkill;
                    uint8 subCount; p >> subCount;
                    for (uint8 i = 0; i < subCount; ++i)
                        { uint32 school; float fdmg; uint32 idmg; p >> school >> fdmg >> idmg; }
                    uint32 absorb = 0, resist = 0;
                    if (hitInfo & (HITINFO_FULL_ABSORB | HITINFO_PARTIAL_ABSORB))
                        for (uint8 i = 0; i < subCount; ++i) { uint32 a; p >> a; absorb += a; }
                    if (hitInfo & (HITINFO_FULL_RESIST | HITINFO_PARTIAL_RESIST))
                        for (uint8 i = 0; i < subCount; ++i) { uint32 r; p >> r; resist += r; }
                    uint8 victimState; p >> victimState;
                    uint32 unkState, meleeSpellId; p >> unkState >> meleeSpellId;
                    uint32 blocked = 0;
                    if (hitInfo & HITINFO_BLOCK)
                        p >> blocked;
                    w.AddGuid("attackerGuid", (uint64_t)attacker).AddGuid("victimGuid", (uint64_t)victim)
                     .Add("hitInfo", hitInfo).Add("damage", damage).Add("overkill", overkill)
                     .Add("absorb", absorb).Add("resist", resist).Add("blocked", blocked)
                     .Add("victimState", (uint32)victimState)
                     .Add("miss", (hitInfo & HITINFO_MISS) != 0)
                     .Add("crit", (hitInfo & HITINFO_CRITICALHIT) != 0);
                    break;
                }
                case SMSG_SPELL_START:
                {
                    name = "SMSG_SPELL_START";
                    uint64 castSource = 0, caster = 0;
                    p.readPackGUID(castSource); // cast item or caster
                    p.readPackGUID(caster);
                    uint8 castCount; uint32 spellId, castFlags; int32 timer;
                    p >> castCount >> spellId >> castFlags >> timer;
                    w.AddGuid("casterGuid", (uint64_t)caster).Add("spellId", spellId)
                     .Add("castTimeMs", timer);
                    ReadSpellTargets(p, w);
                    break;
                }
                case SMSG_SPELL_GO:
                {
                    name = "SMSG_SPELL_GO";
                    uint64 castSource = 0, caster = 0;
                    p.readPackGUID(castSource);
                    p.readPackGUID(caster);
                    uint8 castCount; uint32 spellId, castFlags, timestamp;
                    p >> castCount >> spellId >> castFlags >> timestamp;
                    uint8 hitCount; p >> hitCount;
                    std::string hits = "[";
                    for (uint8 i = 0; i < hitCount; ++i)
                    {
                        uint64 hg; p >> hg;
                        if (i) hits += ',';
                        hits += '"' + std::to_string(hg) + '"';
                    }
                    hits += "]";
                    uint8 missCount; p >> missCount;
                    std::string misses = "[";
                    for (uint8 i = 0; i < missCount; ++i)
                    {
                        uint64 mg; uint8 cond;
                        p >> mg >> cond;
                        if (cond == SPELL_MISS_REFLECT) { uint8 r; p >> r; }
                        if (i) misses += ',';
                        misses += Json::Writer().AddGuid("guid", (uint64_t)mg).Add("reason", (uint32)cond).Str();
                    }
                    misses += "]";
                    w.AddGuid("casterGuid", (uint64_t)caster).Add("spellId", spellId);
                    w.Raw("hitGuids", hits).Raw("misses", misses);
                    break;
                }
                case SMSG_CAST_FAILED:
                {
                    name = "SMSG_CAST_FAILED";
                    uint8 castCount; uint32 spellId; uint8 result;
                    p >> castCount >> spellId >> result;
                    w.Add("spellId", spellId).Add("result", (uint32)result);
                    break;
                }
                case SMSG_SPELL_FAILURE:
                {
                    name = "SMSG_SPELL_FAILURE";
                    uint64 caster = 0; p.readPackGUID(caster);
                    uint8 castCount; uint32 spellId; uint8 result;
                    p >> castCount >> spellId >> result;
                    w.AddGuid("casterGuid", (uint64_t)caster).Add("spellId", spellId).Add("result", (uint32)result);
                    break;
                }
                case SMSG_PERIODICAURALOG:
                {
                    name = "SMSG_PERIODICAURALOG";
                    uint64 target = 0, caster = 0;
                    p.readPackGUID(target);
                    p.readPackGUID(caster);
                    uint32 spellId, count, auraType;
                    p >> spellId >> count >> auraType;
                    uint32 amount = 0;
                    switch (auraType)
                    {
                        case 3: case 89:            // periodic damage (percent)
                        {
                            uint32 over, school, absorb, resist; uint8 crit;
                            p >> amount >> over >> school >> absorb >> resist >> crit;
                            break;
                        }
                        case 8: case 20:            // periodic heal / obs mod health
                        {
                            uint32 over, absorb; uint8 crit;
                            p >> amount >> over >> absorb >> crit;
                            break;
                        }
                        case 21: case 24:           // obs mod power / energize
                        {
                            uint32 ptype; p >> ptype >> amount;
                            break;
                        }
                        case 64:                    // mana leech
                        {
                            uint32 ptype; float mult; p >> ptype >> amount >> mult;
                            break;
                        }
                        default: break;
                    }
                    w.AddGuid("targetGuid", (uint64_t)target).AddGuid("casterGuid", (uint64_t)caster)
                     .Add("spellId", spellId).Add("auraType", auraType).Add("amount", amount);
                    break;
                }
                case SMSG_AURA_UPDATE:
                case SMSG_AURA_UPDATE_ALL:
                {
                    name = opcode == SMSG_AURA_UPDATE ? "SMSG_AURA_UPDATE" : "SMSG_AURA_UPDATE_ALL";
                    uint64 target = 0; p.readPackGUID(target);
                    std::string auras = "[";
                    bool firstAura = true;
                    while (p.rpos() < p.size())
                    {
                        if (!firstAura) auras += ',';
                        auras += ReadAuraBlock(p);
                        firstAura = false;
                    }
                    auras += "]";
                    w.AddGuid("targetGuid", (uint64_t)target).Raw("auras", auras);
                    break;
                }
                // -------------------------------------------------- progress
                case SMSG_LOG_XPGAIN:
                {
                    name = "SMSG_LOG_XPGAIN";
                    uint64 victim; p >> victim;
                    uint32 amount; uint8 type;
                    p >> amount >> type;
                    w.AddGuid("victimGuid", (uint64_t)victim).Add("amount", amount)
                     .Add("fromKill", type == 0);
                    break;
                }
                case SMSG_LEVELUP_INFO:
                {
                    name = "SMSG_LEVELUP_INFO";
                    uint32 level, healthGained;
                    p >> level >> healthGained;
                    w.Add("level", level).Add("healthGained", healthGained);
                    break;
                }
                case SMSG_ITEM_PUSH_RESULT:
                {
                    name = "SMSG_ITEM_PUSH_RESULT";
                    uint64 player; p >> player;
                    uint32 received, created, chat; uint8 bagSlot; uint32 itemSlot, itemId, suffix; int32 randProp;
                    uint32 count, totalCount;
                    p >> received >> created >> chat >> bagSlot >> itemSlot >> itemId >> suffix >> randProp
                      >> count >> totalCount;
                    w.AddGuid("playerGuid", (uint64_t)player).Add("itemId", itemId).Add("count", count)
                     .Add("totalCount", totalCount).Add("bagSlot", (uint32)bagSlot).Add("itemSlot", itemSlot)
                     .Add("looted", received == 0).Add("created", created != 0);
                    itemEntries.push_back(itemId);
                    break;
                }
                // ---------------------------------------------------- quests
                case SMSG_QUESTGIVER_STATUS:
                {
                    name = "SMSG_QUESTGIVER_STATUS";
                    uint64 guid; p >> guid;
                    uint8 status; p >> status;
                    w.AddGuid("guid", (uint64_t)guid).Add("status", (uint32)status);
                    break;
                }
                case SMSG_QUESTGIVER_QUEST_LIST:
                {
                    name = "SMSG_QUESTGIVER_QUEST_LIST";
                    uint64 guid; p >> guid;
                    std::string greeting; p >> greeting;
                    uint32 emoteDelay, emote; p >> emoteDelay >> emote;
                    uint8 count; p >> count;
                    std::string quests = "[";
                    for (uint8 i = 0; i < count; ++i)
                    {
                        uint32 questId, icon; int32 level; uint32 flags; uint8 repeatable;
                        p >> questId >> icon >> level >> flags >> repeatable;
                        std::string title; p >> title;
                        if (i) quests += ',';
                        quests += Json::Writer().Add("questId", questId).Add("icon", icon)
                            .Add("level", level).Add("repeatable", repeatable != 0).Add("title", title).Str();
                    }
                    quests += "]";
                    w.AddGuid("guid", (uint64_t)guid).Add("greeting", greeting).Raw("quests", quests);
                    break;
                }
                case SMSG_QUESTGIVER_QUEST_DETAILS:
                {
                    name = "SMSG_QUESTGIVER_QUEST_DETAILS";
                    uint64 guid, divider; p >> guid >> divider;
                    uint32 questId; p >> questId;
                    std::string title, details, objectives;
                    p >> title >> details >> objectives;
                    uint8 autoFinish; uint32 flags, suggested; uint8 unk;
                    p >> autoFinish >> flags >> suggested >> unk;
                    uint32 choiceCount; p >> choiceCount;
                    std::string choices = "[";
                    for (uint32 i = 0; i < choiceCount && i < 6; ++i)
                    {
                        uint32 id, cnt, disp; p >> id >> cnt >> disp;
                        if (i) choices += ',';
                        choices += Json::Writer().Add("itemId", id).Add("count", cnt).Str();
                        itemEntries.push_back(id);
                    }
                    choices += "]";
                    uint32 itemCount; p >> itemCount;
                    std::string rewards = "[";
                    for (uint32 i = 0; i < itemCount && i < 4; ++i)
                    {
                        uint32 id, cnt, disp; p >> id >> cnt >> disp;
                        if (i) rewards += ',';
                        rewards += Json::Writer().Add("itemId", id).Add("count", cnt).Str();
                        itemEntries.push_back(id);
                    }
                    rewards += "]";
                    uint32 money, xp; p >> money >> xp;
                    w.AddGuid("guid", (uint64_t)guid).Add("questId", questId).Add("title", title)
                     .Add("details", details).Add("objectives", objectives)
                     .Raw("choiceRewards", choices).Raw("rewards", rewards)
                     .Add("money", money).Add("xp", xp);
                    break;
                }
                case SMSG_QUESTGIVER_REQUEST_ITEMS:
                {
                    name = "SMSG_QUESTGIVER_REQUEST_ITEMS";
                    uint64 guid; p >> guid;
                    uint32 questId; p >> questId;
                    std::string title, text; p >> title >> text;
                    uint32 unk, emote, closeOnCancel, flags, suggested, reqMoney;
                    p >> unk >> emote >> closeOnCancel >> flags >> suggested >> reqMoney;
                    uint32 itemCount; p >> itemCount;
                    std::string items = "[";
                    for (uint32 i = 0; i < itemCount && i < 6; ++i)
                    {
                        uint32 id, cnt, disp; p >> id >> cnt >> disp;
                        if (i) items += ',';
                        items += Json::Writer().Add("itemId", id).Add("count", cnt).Str();
                        itemEntries.push_back(id);
                    }
                    items += "]";
                    uint32 canComplete; p >> canComplete;
                    w.AddGuid("guid", (uint64_t)guid).Add("questId", questId).Add("title", title)
                     .Add("text", text).Add("requiredMoney", reqMoney).Raw("requiredItems", items)
                     .Add("completable", canComplete != 0);
                    break;
                }
                case SMSG_QUESTGIVER_OFFER_REWARD:
                {
                    name = "SMSG_QUESTGIVER_OFFER_REWARD";
                    uint64 guid; p >> guid;
                    uint32 questId; p >> questId;
                    std::string title, text; p >> title >> text;
                    uint8 autoFinish; uint32 flags, suggested;
                    p >> autoFinish >> flags >> suggested;
                    uint32 emoteCount; p >> emoteCount;
                    for (uint32 i = 0; i < emoteCount && i < 4; ++i)
                        { uint32 d, e; p >> d >> e; }
                    uint32 choiceCount; p >> choiceCount;
                    std::string choices = "[";
                    for (uint32 i = 0; i < choiceCount && i < 6; ++i)
                    {
                        uint32 id, cnt, disp; p >> id >> cnt >> disp;
                        if (i) choices += ',';
                        choices += Json::Writer().Add("itemId", id).Add("count", cnt).Str();
                        itemEntries.push_back(id);
                    }
                    choices += "]";
                    uint32 itemCount; p >> itemCount;
                    std::string rewards = "[";
                    for (uint32 i = 0; i < itemCount && i < 4; ++i)
                    {
                        uint32 id, cnt, disp; p >> id >> cnt >> disp;
                        if (i) rewards += ',';
                        rewards += Json::Writer().Add("itemId", id).Add("count", cnt).Str();
                        itemEntries.push_back(id);
                    }
                    rewards += "]";
                    uint32 money, xp; p >> money >> xp;
                    w.AddGuid("guid", (uint64_t)guid).Add("questId", questId).Add("title", title)
                     .Add("text", text).Raw("choiceRewards", choices).Raw("rewards", rewards)
                     .Add("money", money).Add("xp", xp);
                    break;
                }
                case SMSG_QUESTGIVER_QUEST_COMPLETE:
                {
                    name = "SMSG_QUESTGIVER_QUEST_COMPLETE";
                    uint32 questId, xp, money, honor, talents, arena;
                    p >> questId >> xp >> money >> honor >> talents >> arena;
                    w.Add("questId", questId).Add("xp", xp).Add("money", money);
                    break;
                }
                case SMSG_QUESTGIVER_QUEST_FAILED:
                {
                    name = "SMSG_QUESTGIVER_QUEST_FAILED";
                    uint32 questId, reason; p >> questId >> reason;
                    w.Add("questId", questId).Add("reason", reason);
                    break;
                }
                case SMSG_QUESTUPDATE_ADD_KILL:
                {
                    name = "SMSG_QUESTUPDATE_ADD_KILL";
                    uint32 questId, entry, current, required; uint64 guid;
                    p >> questId >> entry >> current >> required >> guid;
                    w.Add("questId", questId).Add("entry", entry).Add("current", current)
                     .Add("required", required).AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_QUESTUPDATE_ADD_ITEM:
                {
                    // Sent intentionally empty by the core; the client updates its
                    // quest log from the PLAYER_QUEST_LOG fields instead.
                    name = "SMSG_QUESTUPDATE_ADD_ITEM";
                    break;
                }
                case SMSG_QUESTUPDATE_COMPLETE:
                {
                    name = "SMSG_QUESTUPDATE_COMPLETE";
                    uint32 questId; p >> questId;
                    w.Add("questId", questId);
                    break;
                }
                case SMSG_QUESTUPDATE_FAILED:
                {
                    name = "SMSG_QUESTUPDATE_FAILED";
                    uint32 questId; p >> questId;
                    w.Add("questId", questId);
                    break;
                }
                // ---------------------------------------------------- gossip
                case SMSG_GOSSIP_MESSAGE:
                {
                    name = "SMSG_GOSSIP_MESSAGE";
                    uint64 guid; p >> guid;
                    uint32 menuId, textId, optionCount;
                    p >> menuId >> textId >> optionCount;
                    std::string options = "[";
                    for (uint32 i = 0; i < optionCount && i < 32; ++i)
                    {
                        uint32 index; uint8 icon, coded; uint32 boxMoney;
                        p >> index >> icon >> coded >> boxMoney;
                        std::string text, boxText; p >> text >> boxText;
                        if (i) options += ',';
                        options += Json::Writer().Add("optionId", index).Add("icon", (uint32)icon)
                            .Add("text", text).Str();
                    }
                    options += "]";
                    uint32 questCount; p >> questCount;
                    std::string quests = "[";
                    for (uint32 i = 0; i < questCount && i < 32; ++i)
                    {
                        uint32 questId, icon; int32 level; uint32 flags; uint8 repeatable;
                        p >> questId >> icon >> level >> flags >> repeatable;
                        std::string title; p >> title;
                        if (i) quests += ',';
                        quests += Json::Writer().Add("questId", questId).Add("icon", icon)
                            .Add("level", level).Add("title", title).Str();
                    }
                    quests += "]";
                    w.AddGuid("guid", (uint64_t)guid).Add("menuId", menuId).Add("textId", textId);
                    w.Raw("options", options).Raw("quests", quests);
                    break;
                }
                case SMSG_GOSSIP_COMPLETE:
                    name = "SMSG_GOSSIP_COMPLETE";
                    break;
                // ------------------------------------------------------ loot
                case SMSG_LOOT_RESPONSE:
                {
                    name = "SMSG_LOOT_RESPONSE";
                    uint64 guid; p >> guid;
                    uint8 lootType; p >> lootType;
                    uint32 gold; p >> gold;
                    uint8 count; p >> count;
                    std::vector<uint8_t> slots;
                    std::string items = "[";
                    for (uint8 i = 0; i < count; ++i)
                    {
                        uint8 slot; uint32 itemId, cnt, disp, suffix; int32 randProp; uint8 slotType;
                        p >> slot >> itemId >> cnt >> disp >> suffix >> randProp >> slotType;
                        if (i) items += ',';
                        items += Json::Writer().Add("slot", (uint32)slot).Add("itemId", itemId)
                            .Add("count", cnt).Add("slotType", (uint32)slotType).Str();
                        itemEntries.push_back(itemId);
                        if (slotType == 0)              // LOOT_SLOT_TYPE_ALLOW_LOOT
                            slots.push_back(slot);
                    }
                    items += "]";
                    w.AddGuid("guid", (uint64_t)guid).Add("lootType", (uint32)lootType)
                     .Add("gold", gold).Raw("items", items);

                    // loot_all: replay the auto-loot client sequence now that the
                    // window contents are known.
                    bool doAuto = false;
                    {
                        std::lock_guard<std::mutex> lock(s.objMutex);
                        if (s.autoLootPending)
                        {
                            s.autoLootPending = false;
                            doAuto = true;
                        }
                    }
                    if (doAuto)
                    {
                        for (uint8_t slot : slots)
                        {
                            WorldPacket* q = new WorldPacket(CMSG_AUTOSTORE_LOOT_ITEM, 1);
                            *q << uint8(slot);
                            ws->QueuePacket(q);
                        }
                        if (gold)
                            ws->QueuePacket(new WorldPacket(CMSG_LOOT_MONEY, 0));
                        WorldPacket* rel = new WorldPacket(CMSG_LOOT_RELEASE, 8);
                        *rel << uint64(guid);
                        ws->QueuePacket(rel);
                    }
                    break;
                }
                case SMSG_LOOT_REMOVED:
                {
                    name = "SMSG_LOOT_REMOVED";
                    uint8 slot; p >> slot;
                    w.Add("slot", (uint32)slot);
                    break;
                }
                case SMSG_LOOT_MONEY_NOTIFY:
                {
                    name = "SMSG_LOOT_MONEY_NOTIFY";
                    uint32 money; p >> money;
                    w.Add("money", money);
                    break;
                }
                case SMSG_LOOT_CLEAR_MONEY:
                    name = "SMSG_LOOT_CLEAR_MONEY";
                    break;
                case SMSG_LOOT_RELEASE_RESPONSE:
                {
                    name = "SMSG_LOOT_RELEASE_RESPONSE";
                    uint64 guid; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    break;
                }
                // ---------------------------------------------------- vendor
                case SMSG_LIST_INVENTORY:
                {
                    name = "SMSG_LIST_INVENTORY";
                    uint64 guid; p >> guid;
                    uint8 count; p >> count;
                    std::string items = "[";
                    for (uint8 i = 0; i < count; ++i)
                    {
                        uint32 slot, itemId, disp; int32 leftInStock; uint32 price, maxDur, buyCount, extCost;
                        p >> slot >> itemId >> disp >> leftInStock >> price >> maxDur >> buyCount >> extCost;
                        if (i) items += ',';
                        items += Json::Writer().Add("slot", slot).Add("itemId", itemId)
                            .Add("price", price).Add("buyCount", buyCount)
                            .Add("leftInStock", leftInStock).Add("extendedCost", extCost).Str();
                        itemEntries.push_back(itemId);
                    }
                    items += "]";
                    w.AddGuid("vendorGuid", (uint64_t)guid).Raw("items", items);
                    if (count == 0 && p.rpos() < p.size())
                    {
                        uint8 errCode; p >> errCode;
                        w.Add("emptyReason", (uint32)errCode);
                    }
                    break;
                }
                case SMSG_BUY_ITEM:
                {
                    name = "SMSG_BUY_ITEM";
                    uint64 guid; p >> guid;
                    uint32 slot; int32 newCount; uint32 count;
                    p >> slot >> newCount >> count;
                    w.AddGuid("vendorGuid", (uint64_t)guid).Add("slot", slot).Add("count", count);
                    break;
                }
                case SMSG_BUY_FAILED:
                {
                    name = "SMSG_BUY_FAILED";
                    uint64 guid; p >> guid;
                    uint32 itemId; p >> itemId;
                    if (p.size() - p.rpos() > 1)            // optional u32 param before the code
                        { uint32 param; p >> param; }
                    uint8 result; p >> result;
                    w.AddGuid("vendorGuid", (uint64_t)guid).Add("itemId", itemId).Add("result", (uint32)result);
                    break;
                }
                case SMSG_SELL_ITEM:
                {
                    name = "SMSG_SELL_ITEM";
                    uint64 vendor, item; p >> vendor >> item;
                    if (p.size() - p.rpos() > 1)            // optional u32 param before the code
                        { uint32 param; p >> param; }
                    uint8 result; p >> result;
                    w.AddGuid("vendorGuid", (uint64_t)vendor).AddGuid("itemGuid", (uint64_t)item)
                     .Add("result", (uint32)result);
                    break;
                }
                case SMSG_INVENTORY_CHANGE_FAILURE:
                {
                    name = "SMSG_INVENTORY_CHANGE_FAILURE";
                    uint8 result; p >> result;
                    w.Add("result", (uint32)result);
                    if (result != 0 && p.rpos() + 17 <= p.size())
                    {
                        uint64 item1, item2; uint8 bagResult;
                        p >> item1 >> item2 >> bagResult;
                        w.AddGuid("itemGuid", (uint64_t)item1).AddGuid("itemGuid2", (uint64_t)item2);
                        if (p.rpos() + 4 <= p.size())       // EQUIP_ERR_CANT_EQUIP_LEVEL_I etc.
                        {
                            uint32 level; p >> level;
                            w.Add("requiredLevel", level);
                        }
                    }
                    break;
                }
                case SMSG_ITEM_QUERY_SINGLE_RESPONSE:
                {
                    name = "SMSG_ITEM_QUERY_SINGLE_RESPONSE";
                    uint32 itemId; p >> itemId;
                    if (itemId & 0x80000000)
                    {
                        w.Add("itemId", itemId & 0x7FFFFFFF).Add("found", false);
                        break;
                    }
                    uint32 itemClass, subClass; int32 soundOverride;
                    p >> itemClass >> subClass >> soundOverride;
                    std::string iname; p >> iname;
                    std::string n2, n3, n4; p >> n2 >> n3 >> n4;   // empty
                    uint32 display, quality, flags, flags2, buyPrice, sellPrice, invType;
                    p >> display >> quality >> flags >> flags2 >> buyPrice >> sellPrice >> invType;
                    uint32 allowClass, allowRace, itemLevel, reqLevel;
                    p >> allowClass >> allowRace >> itemLevel >> reqLevel;
                    w.Add("itemId", itemId).Add("found", true).Add("name", iname)
                     .Add("quality", quality).Add("inventoryType", invType)
                     .Add("buyPrice", buyPrice).Add("sellPrice", sellPrice)
                     .Add("itemLevel", itemLevel).Add("requiredLevel", reqLevel)
                     .Add("class", itemClass).Add("subClass", subClass);
                    break;
                }
                // ----------------------------------------------------- death
                case SMSG_DEATH_RELEASE_LOC:
                {
                    name = "SMSG_DEATH_RELEASE_LOC";
                    int32 map; float x, y, z;
                    p >> map >> x >> y >> z;
                    w.Add("map", map).Add("x", (double)x).Add("y", (double)y).Add("z", (double)z);
                    break;
                }
                case SMSG_CORPSE_RECLAIM_DELAY:
                {
                    name = "SMSG_CORPSE_RECLAIM_DELAY";
                    uint32 delayMs; p >> delayMs;
                    w.Add("delayMs", delayMs);
                    break;
                }
                case SMSG_DURABILITY_DAMAGE_DEATH:
                    name = "SMSG_DURABILITY_DAMAGE_DEATH";
                    break;
                // --------------------------------------------------- session
                case SMSG_CHAR_DELETE:
                {
                    name = "SMSG_CHAR_DELETE";
                    uint8 result = 0; if (p.size() >= 1) p >> result;
                    w.Add("result", (uint32)result);
                    break;
                }
                // ---------------------------------------- creature movement
                case SMSG_MONSTER_MOVE:
                {
                    // Destination and duration ONLY. The spline path points are
                    // consumed and dropped: serving them would leak the server's
                    // route (ADR-0010 watch-out).
                    name = "SMSG_MONSTER_MOVE";
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint8 toggle; p >> toggle;
                    float sx, sy, sz; p >> sx >> sy >> sz;
                    uint32 splineId; p >> splineId;
                    uint8 type; p >> type;
                    w.AddGuid("guid", (uint64_t)guid);
                    w.Raw("pos", Json::Writer().Add("x", (double)sx).Add("y", (double)sy).Add("z", (double)sz).Str());
                    if (type == 1)                          // MonsterMoveStop
                    {
                        w.Add("stopped", true);
                        break;
                    }
                    switch (type)
                    {
                        case 2: { float fx, fy, fz; p >> fx >> fy >> fz; break; } // facing spot
                        case 3: { uint64 t; p >> t; break; }                     // facing target
                        case 4: { float a; p >> a; break; }                      // facing angle
                        default: break;
                    }
                    uint32 splineFlags; p >> splineFlags;
                    if (splineFlags & 0x00200000)           // animation
                        { uint8 animId; uint32 startTime; p >> animId >> startTime; }
                    uint32 duration; p >> duration;
                    if (splineFlags & 0x00000800)           // parabolic
                        { float accel; uint32 startTime; p >> accel >> startTime; }
                    uint32 pointCount; p >> pointCount;
                    float dx = sx, dy = sy, dz = sz;
                    if (splineFlags & (0x00002000 | 0x00040000)) // catmullrom/flying: full points
                    {
                        for (uint32 i = 0; i < pointCount; ++i)
                        {
                            float px, py, pz; p >> px >> py >> pz;
                            dx = px; dy = py; dz = pz;      // keep only the last (the destination)
                        }
                    }
                    else                                    // linear: destination + packed offsets
                    {
                        p >> dx >> dy >> dz;
                        if (pointCount > 1)
                            p.rpos(p.rpos() + size_t(pointCount - 1) * 4);
                    }
                    w.Raw("destination", Json::Writer().Add("x", (double)dx).Add("y", (double)dy).Add("z", (double)dz).Str());
                    w.Add("durationMs", duration);
                    break;
                }
                default:
                    return false; // not whitelisted
            }
        }
        catch (std::exception const&)
        {
            // Truncated/unexpected packet: still emit the opcode so the drop is visible.
            dataJson = Json::Writer().Add("decodeError", true).Str();
            return true;
        }
        QueryItems(s, ws, itemEntries);
        dataJson = w.Str();
        return true;
    }

    static uint64_t FindCharInEnum(WorldPacket const& packet, std::string const& wantName)
    {
        WorldPacket p(packet);
        try
        {
            uint8 count = 0; p >> count;
            for (uint8 i = 0; i < count && p.rpos() < p.size(); ++i)
            {
                uint64 guid = 0; p >> guid;
                std::string cname; p >> cname;
                uint8 race, cls, gender; p >> race >> cls >> gender;
                uint8 skin, face, hair, hairColor, facial; p >> skin >> face >> hair >> hairColor >> facial;
                uint8 level = 0; p >> level;
                uint32 zone = 0, map = 0; p >> zone >> map;
                float x, y, z; p >> x >> y >> z;
                uint32 guildId = 0, charFlags = 0, customize = 0; p >> guildId >> charFlags >> customize;
                uint8 firstLogin = 0; p >> firstLogin;
                uint32 petDisplay = 0, petLevel = 0, petFamily = 0; p >> petDisplay >> petLevel >> petFamily;
                for (uint8 slot = 0; slot < 23; ++slot) // INVENTORY_SLOT_BAG_END
                {
                    uint32 displayInfo = 0; uint8 invType = 0; uint32 enchant = 0;
                    p >> displayInfo >> invType >> enchant;
                }
                if (strcasecmp(cname.c_str(), wantName.c_str()) == 0)
                    return guid;
            }
        }
        catch (std::exception const&)
        {
        }
        return 0;
    }
}
