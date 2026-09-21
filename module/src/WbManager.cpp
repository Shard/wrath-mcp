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

#include "WbManager.h"
#include "WbJson.h"

#include "AccountMgr.h"
#include "Config.h"
#include "CryptoRandom.h"
#include "DatabaseEnv.h"
#include "DBCStores.h"
#include "GameTime.h"
#include "Item.h"
#include "ItemTemplate.h"
#include "Log.h"
#include "LootMgr.h"
#include "QuestDef.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "Map.h"
#include "MapCollisionData.h"
#include "PathGenerator.h"
#include "Player.h"
#include "SharedDefines.h"
#include "SpellInfo.h"
#include "SpellMgr.h"
#include "Timer.h"
#include "Transport.h"
#include "GameObjectModel.h"
#include "UpdateData.h"
#include "UpdateFields.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include "WorldSocket.h"
#include "Util.h"

#include <boost/asio/ip/tcp.hpp>
#include <openssl/crypto.h>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <initializer_list>
#include <iterator>
#include <strings.h>

using boost::asio::ip::tcp;

namespace WrathBench
{
    static int64_t NowMs()
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    // Build identity served on /health to every caller. WRATHBENCH_BUILD is the
    // repo's `git describe --tags --always --dirty` at image build time (docker
    // build-arg -> cmake -> define, see module/mod-wrathbench.cmake); absent
    // when built outside that path. Process start is captured at static init.
#ifndef WRATHBENCH_BUILD
#define WRATHBENCH_BUILD "unknown"
#endif
    static int64_t const kStartedAtMs = NowMs();

    static void AddBuildIdentity(Json::Writer& w)
    {
        w.Add("build", WRATHBENCH_BUILD);
        w.Add("startedAtMs", kStartedAtMs);
        w.Add("uptimeMs", NowMs() - kStartedAtMs);
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
        std::string account = sConfigMgr->GetOption<std::string>("WrathBench.Account", "RUNNER");
        std::string secret = sConfigMgr->GetOption<std::string>("WrathBench.Secret", "");
        _auditDir = sConfigMgr->GetOption<std::string>("WrathBench.AuditDir", "/azerothcore/env/dist/logs/wrathbench");

        // Account allowlist: the accounts this module serves at all. Comma
        // separated; defaults to the single default account, so an unset
        // option behaves as before. Built into a local first: Configure()
        // re-runs on `.reload config` while HTTP threads read the list, so
        // the published fields are only ever touched under _accountMutex.
        std::vector<std::string> parsed;
        std::string accounts = sConfigMgr->GetOption<std::string>("WrathBench.Accounts", account);
        for (size_t start = 0; start <= accounts.size();)
        {
            size_t end = accounts.find(',', start);
            if (end == std::string::npos)
                end = accounts.size();
            std::string name = accounts.substr(start, end - start);
            // trim surrounding whitespace
            while (!name.empty() && std::isspace(static_cast<unsigned char>(name.front()))) name.erase(name.begin());
            while (!name.empty() && std::isspace(static_cast<unsigned char>(name.back()))) name.pop_back();
            if (!name.empty())
                parsed.push_back(name);
            start = end + 1;
        }
        if (parsed.empty())
            parsed.push_back(account);

        {
            std::lock_guard<std::mutex> lock(_accountMutex);
            _account = std::move(account);
            _accounts = std::move(parsed);
            _secret = std::move(secret);
        }
    }

    std::string Manager::PortSecret() const
    {
        std::lock_guard<std::mutex> lock(_accountMutex);
        return _secret;
    }

    bool Manager::AccountPermitted(std::string const& account) const
    {
        std::lock_guard<std::mutex> lock(_accountMutex);
        for (std::string const& allowed : _accounts)
            if (strcasecmp(account.c_str(), allowed.c_str()) == 0)
                return true;
        return false;
    }

    std::string Manager::DefaultAccount() const
    {
        std::lock_guard<std::mutex> lock(_accountMutex);
        return _account;
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

        // The client's own AreaTrigger.dbc, read from the data volume the
        // worldserver already mounts (DataDir). A missing file disables
        // automatic areatrigger dispatch and says so; it never stops the module.
        std::string dbcPath = sWorld->GetDataPath() + "dbc/AreaTrigger.dbc";
        if (!LoadAreaTriggerDbc(dbcPath))
            LOG_ERROR("module", "wrathbench: AreaTrigger.dbc not loaded from '{}'; portals and explore triggers will not fire for bench characters", dbcPath);
        std::string areaPath = sWorld->GetDataPath() + "dbc/AreaTable.dbc";
        if (!LoadAreaTableDbc(areaPath))
            LOG_ERROR("module", "wrathbench: AreaTable.dbc not loaded from '{}'; WB_AREA will carry ids without names", areaPath);
        std::string achPath = sWorld->GetDataPath() + "dbc/Achievement.dbc";
        if (!LoadAchievementDbc(achPath))
            LOG_ERROR("module", "wrathbench: Achievement.dbc not loaded from '{}'; achievement events will carry ids without names or points", achPath);
        std::string taxiPath = sWorld->GetDataPath() + "dbc/TaxiNodes.dbc";
        if (!LoadTaxiNodesDbc(taxiPath))
            LOG_ERROR("module", "wrathbench: TaxiNodes.dbc not loaded from '{}'; SMSG_SHOWTAXINODES will carry node ids without names", taxiPath);
        std::string tabPath = sWorld->GetDataPath() + "dbc/TalentTab.dbc";
        if (!LoadTalentTabDbc(tabPath))
            LOG_ERROR("module", "wrathbench: TalentTab.dbc not loaded from '{}'; talent_tree will carry tab ids without names", tabPath);
        // Reputation index -> faction id, the join a client makes from its own
        // Faction.dbc for every SMSG_INITIALIZE_FACTIONS position.
        for (uint32 i = 0; i < sFactionStore.GetNumRows(); ++i)
            if (FactionEntry const* f = sFactionStore.LookupEntry(i))
                if (f->reputationListID >= 0)
                    _repListToFaction[uint32(f->reputationListID)] = f->ID;
        LOG_INFO("module", "wrathbench: {} reputation factions indexed from Faction.dbc", _repListToFaction.size());

        // The port secret is the floor under every route (PROTOCOL.md,
        // "Authentication"): without one the control surface does not listen
        // at all. Fail closed and say exactly what is missing — the deploy
        // script reads the silence as "never became healthy" and rolls back.
        if (PortSecret().size() < 32)
        {
            LOG_ERROR("module", "wrathbench: WrathBench.Secret (AC_WRATH_BENCH_SECRET) is unset or shorter than 32 characters; "
                "the HTTP/WS control surface is NOT listening. Set WRATHBENCH_MODULE_SECRET in .env (docs/RUNBOOK.md, Secrets).");
            return;
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

        int64_t const nowMs = NowMs();

        // Drive synthesized movement. World thread: maps are not
        // mid-update here, so reading player state and QueuePacket are both safe.
        TickMovers(nowMs);
        TickRiders(nowMs);
        TickTransports(nowMs);

        // Answer pending teleports; without this every teleport (repop's
        // graveyard port included) freezes movement forever.
        TickTeleportAcks(nowMs);
        TickCorpseQuery();
        TickAreas();

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
    // Constant-time equality for secrets. Length is not secret (both sides
    // are module-issued or operator-configured), so a mismatch there returns
    // early; the bytes are compared with OpenSSL's CRYPTO_memcmp.
    static bool SecretEquals(std::string const& a, std::string const& b)
    {
        if (a.empty() || a.size() != b.size())
            return false;
        return CRYPTO_memcmp(a.data(), b.data(), a.size()) == 0;
    }

    // "Bearer <credential>" -> credential; anything else -> "".
    static std::string BearerOf(std::string const& authorization)
    {
        static char const kPrefix[] = "Bearer ";
        size_t const n = sizeof(kPrefix) - 1;
        if (authorization.size() <= n || strncasecmp(authorization.c_str(), kPrefix, n) != 0)
            return "";
        std::string cred = authorization.substr(n);
        while (!cred.empty() && std::isspace(static_cast<unsigned char>(cred.back()))) cred.pop_back();
        while (!cred.empty() && std::isspace(static_cast<unsigned char>(cred.front()))) cred.erase(cred.begin());
        return cred;
    }

    Cred Manager::Authenticate(std::string const& authorization, std::string* leaseToken, Lease* lease) const
    {
        std::string const cred = BearerOf(authorization);
        if (cred.empty())
            return Cred::None;
        if (SecretEquals(cred, PortSecret()))
            return Cred::Operator;
        // A lease secret. Scanned rather than indexed: the map holds one entry
        // per live run, and a scan keeps the check independent of whatever
        // token the body names (GET /health has none).
        std::lock_guard<std::mutex> lock(_leaseMutex);
        for (auto const& [token, l] : _leases)
        {
            if (SecretEquals(cred, l.secret))
            {
                if (leaseToken) *leaseToken = token;
                if (lease) *lease = l;
                return Cred::Session;
            }
        }
        return Cred::None;
    }

    bool Manager::AuthorizeWs(std::string const& token, std::string const& authorization)
    {
        std::string leaseToken;
        switch (Authenticate(authorization, &leaseToken, nullptr))
        {
            case Cred::Operator: return true;
            case Cred::Session:  return !token.empty() && token == leaseToken;
            default:             return false;
        }
    }

    static HttpReply ErrorReply(int status, char const* code)
    {
        return {status, Json::Writer().Add("ok", false).Add("error", code).Str()};
    }

    HttpReply Manager::HandleHttp(std::string const& method, std::string const& target, std::string const& body,
        std::string const& authorization, bool loopbackPeer)
    {
        try
        {
            // Every route authenticates first (PROTOCOL.md, "Authentication").
            // The port secret is the operator class and may do anything; a lease
            // secret is the session class and may only act as its own token.
            std::string leaseToken;
            Lease lease;
            Cred const cred = Authenticate(authorization, &leaseToken, &lease);
            if (cred == Cred::None)
                return ErrorReply(401, "unauthorized");

            if (method == "GET" && target == "/health")
                return HttpHealth(loopbackPeer);

            // Operator-only surfaces: leasing itself, and the character-select
            // utilities that act on an account rather than a session.
            bool const operatorOnly =
                target == "/lease" || target == "/character-delete" || target == "/characters";
            if (operatorOnly && cred != Cred::Operator)
                return ErrorReply(403, "operator_only");

            if (method == "POST" && target == "/lease")
                return HttpLease(body);
            if (method == "DELETE" && target == "/lease")
                return HttpReleaseLease(body);
            if (method == "POST" && target == "/character-delete")
                return HttpCharacterDelete(body);
            if (method == "POST" && target == "/characters")
                return HttpCharacterList(body);

            bool const tokenRoute =
                (method == "POST" && target == "/session") ||
                (method == "POST" && target == "/action") ||
                (method == "DELETE" && target == "/session");
            if (!tokenRoute)
                return ErrorReply(404, "not_found");

            std::string forcedAccount;
            if (cred == Cred::Session)
            {
                // The token in the body must be the lease's own: a lease
                // secret is a capability over exactly one token.
                Json::Value req = Json::Parse(body);
                if (req.GetString("token") != leaseToken)
                    return ErrorReply(403, "token_mismatch");
                if (method == "POST" && target == "/session")
                {
                    // Token-to-account and token-to-character binding. The
                    // account is the lease's, full stop; the character is bound
                    // by the first create that succeeds and fixed thereafter.
                    std::string const account = req.GetString("account");
                    if (!account.empty() && strcasecmp(account.c_str(), lease.account.c_str()) != 0)
                        return ErrorReply(403, "account_not_leased");
                    std::string const character = req.GetString("character");
                    if (!lease.character.empty() && strcasecmp(character.c_str(), lease.character.c_str()) != 0)
                        return {409, Json::Writer().Add("ok", false).Add("error", "character_bound")
                            .Add("bound", lease.character).Str()};
                    forcedAccount = lease.account;
                }
            }

            if (method == "POST" && target == "/session")
            {
                HttpReply reply = HttpCreateSession(body, forcedAccount);
                if (cred == Cred::Session && reply.status == 200 && lease.character.empty())
                {
                    // Bind on success only: a create the core refused (name
                    // taken, bad race/class) must not pin the token to a
                    // character that never existed.
                    std::string const character = Json::Parse(body).GetString("character");
                    std::lock_guard<std::mutex> lock(_leaseMutex);
                    auto it = _leases.find(leaseToken);
                    if (it != _leases.end() && it->second.character.empty())
                        it->second.character = character;
                }
                return reply;
            }
            if (method == "POST" && target == "/action")
                return HttpAction(body);
            return HttpDeleteSession(body);
        }
        catch (std::exception const& e)
        {
            return {500, Json::Writer().Add("ok", false).Add("error", "internal").Add("message", e.what()).Str()};
        }
    }

    // POST /lease: bind a token to an account and issue its secret. Operator
    // only. Re-leasing a token rotates its secret and keeps its character
    // binding (a resumed run re-leases the token it stored; the character it
    // played stays its own).
    HttpReply Manager::HttpLease(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return ErrorReply(400, "missing_token");
        if (token.size() < 32)
            return {400, Json::Writer().Add("ok", false).Add("error", "weak_token")
                .Add("received", (uint32_t)token.size()).Add("minimum", (uint32_t)32).Str()};
        std::string account = req.GetString("account", DefaultAccount());
        if (!AccountPermitted(account))
            return ErrorReply(403, "account_not_permitted");

        std::array<uint8, 32> const bytes = Acore::Crypto::GetRandomBytes<32>();
        std::string secret = ByteArrayToHexStr(bytes);
        std::string character;
        {
            std::lock_guard<std::mutex> lock(_leaseMutex);
            Lease& l = _leases[token];
            if (strcasecmp(l.account.c_str(), account.c_str()) != 0)
                l.character.clear(); // a token re-leased onto another account starts unbound
            l.account = account;
            l.secret = secret;
            character = l.character;
        }
        LOG_INFO("module", "wrathbench: leased token {} to account {}", token, account);
        Json::Writer w;
        w.Add("ok", true).Add("token", token).Add("account", account).Add("secret", secret);
        if (!character.empty())
            w.Add("character", character);
        return {200, w.Str()};
    }

    // DELETE /lease: forget a token's lease. Does not touch a live session
    // under it (DELETE /session does that); it only revokes the credential.
    HttpReply Manager::HttpReleaseLease(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return ErrorReply(400, "missing_token");
        bool released;
        {
            std::lock_guard<std::mutex> lock(_leaseMutex);
            released = _leases.erase(token) > 0;
        }
        return {200, Json::Writer().Add("ok", true).Add("token", token).Add("released", released).Str()};
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

    HttpReply Manager::HttpHealth(bool operatorView)
    {
        // Non-loopback callers (runner, snippet sandbox) get liveness only:
        // the global session count and the drop census describe module
        // internals and other runs' sessions, which the observation contract
        // never serves to a snippet. The counter fields stay present, zeroed,
        // so the SDK's health schema keeps parsing; the census is read
        // by operators via loopback curl inside the worldserver container.
        if (!operatorView)
        {
            Json::Writer w;
            w.Add("ok", true);
            w.Add("module", "mod-wrathbench");
            w.Add("worldStopped", World::IsStopped());
            w.Add("sessions", 0);
            w.Add("droppedPackets", 0);
            w.Add("droppedPacketsLive", 0);
            AddBuildIdentity(w);
            return {200, w.Str()};
        }

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
        AddBuildIdentity(w);
        return {200, w.Str()};
    }

    HttpReply Manager::HttpCreateSession(std::string const& body, std::string const& forcedAccount)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        // Minimum-length gate. The token is no longer the
        // credential — the lease secret is (PROTOCOL.md, "Authentication") —
        // but it is still the key every session, audit file and event stream
        // is addressed by, so a guessable one still lets an operator-class
        // caller collide with another run by accident. Checked before the
        // session is registered so a rejected token leaves nothing behind.
        static constexpr size_t kMinTokenChars = 32;
        if (token.size() < kMinTokenChars)
            return {400, Json::Writer().Add("ok", false).Add("error", "weak_token")
                .Add("received", (uint32_t)token.size())
                .Add("minimum", (uint32_t)kMinTokenChars)
                .Add("hint", "session tokens must be at least 32 characters; the runner generates one per "
                             "run — pass that token through instead of a hand-written or run-id-derived "
                             "string, or append random hex to it")
                .Str()};

        // Same-token handling (idempotent create / self-reclaim) is decided on
        // the world thread in DoCreateSession, where TeardownByToken is legal and
        // the create is serialized — not here on the io thread. _byToken[token]
        // is written only after those checks, so there is no clobber of an
        // existing record. (POST /characters and /character-delete keep their
        // io-thread token_in_use pre-filter below: they never reclaim.)

        auto s = std::make_shared<BenchSession>();
        s->token = token;
        // A session-class caller's account is its lease's, whatever the body
        // says (HandleHttp already refused a body naming another one).
        s->account = forcedAccount.empty() ? req.GetString("account", DefaultAccount()) : forcedAccount;
        // Same allowlist as /character-delete: the module serves only its
        // configured bench accounts, on every surface.
        if (!AccountPermitted(s->account))
            return {403, Json::Writer().Add("ok", false).Add("error", "account_not_permitted").Str()};
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

    // A guid request field must be a decimal u64 string (PROTOCOL.md). Empty
    // means "absent" (validated separately); anything else that does not parse
    // is a client bug — reported as 400 invalid_guid, never coerced to 0.
    static bool GuidFieldParses(std::string const& v)
    {
        if (v.empty())
            return true;
        if (v.find_first_not_of("0123456789") != std::string::npos)
            return false;
        try { (void)std::stoull(v); return true; } catch (...) { return false; }
    }

    // The raw-action allowlist (PROTOCOL.md "raw"). Every entry is a
    // client opcode a stock 3.3.5a client sends from ordinary play, whose
    // handler does nothing a non-GM client could not do, and which has NO
    // dedicated action yet — the hatch exists so a trajectory can show the
    // need for a surface before the module and SDK grow one.
    // Deliberately absent: movement (the module drives it; a stray packet
    // desyncs the mover), session lifecycle (login/logout/char create), every
    // opcode that already has an action (one audited path per opcode), and
    // anything GM-gated or teleport-shaped.
    struct RawOpcode { char const* name; uint16 op; };
    static RawOpcode const kRawAllowlist[] = {
        // talents (also first-class actions; listed so a caller can build the
        // preview packet by hand)
        { "CMSG_LEARN_TALENT", CMSG_LEARN_TALENT },
        { "CMSG_LEARN_PREVIEW_TALENTS", CMSG_LEARN_PREVIEW_TALENTS },
        // respec: the "yes" on the client's confirm dialog after the trainer's
        // unlearn gossip option answered with MSG_TALENT_WIPE_CONFIRM (the
        // opcode is bidirectional; body u64 trainer guid)
        { "MSG_TALENT_WIPE_CONFIRM", MSG_TALENT_WIPE_CONFIRM },
        // chat and emotes (whisper/party/yell ride CMSG_MESSAGECHAT)
        { "CMSG_MESSAGECHAT", CMSG_MESSAGECHAT },
        { "CMSG_EMOTE", CMSG_EMOTE },
        { "CMSG_TEXT_EMOTE", CMSG_TEXT_EMOTE },
        // inventory management (bags, splitting, swapping)
        { "CMSG_SPLIT_ITEM", CMSG_SPLIT_ITEM },
        { "CMSG_SWAP_ITEM", CMSG_SWAP_ITEM },
        { "CMSG_SWAP_INV_ITEM", CMSG_SWAP_INV_ITEM },
        { "CMSG_AUTOSTORE_BAG_ITEM", CMSG_AUTOSTORE_BAG_ITEM },
        { "CMSG_AUTOEQUIP_ITEM_SLOT", CMSG_AUTOEQUIP_ITEM_SLOT },
        { "CMSG_READ_ITEM", CMSG_READ_ITEM },
        { "CMSG_OPEN_ITEM", CMSG_OPEN_ITEM },
        { "CMSG_BUYBACK_ITEM", CMSG_BUYBACK_ITEM },
        // spell/aura control
        { "CMSG_CANCEL_AURA", CMSG_CANCEL_AURA },
        { "CMSG_CANCEL_AUTO_REPEAT_SPELL", CMSG_CANCEL_AUTO_REPEAT_SPELL },
        { "CMSG_CANCEL_CHANNELLING", CMSG_CANCEL_CHANNELLING },
        { "CMSG_SET_SHEATHED", CMSG_SET_SHEATHED },
        { "CMSG_STANDSTATECHANGE", CMSG_STANDSTATECHANGE },
        { "CMSG_RESURRECT_RESPONSE", CMSG_RESURRECT_RESPONSE },
        // flight paths
        { "CMSG_TAXINODE_STATUS_QUERY", CMSG_TAXINODE_STATUS_QUERY },
        { "CMSG_TAXIQUERYAVAILABLENODES", CMSG_TAXIQUERYAVAILABLENODES },
        { "CMSG_ACTIVATETAXI", CMSG_ACTIVATETAXI },
        { "CMSG_ACTIVATETAXIEXPRESS", CMSG_ACTIVATETAXIEXPRESS },
        // innkeeper bind: the "yes" on the client's confirm dialog after
        // SMSG_BINDER_CONFIRM (the gossip option itself is gossip_select)
        { "CMSG_BINDER_ACTIVATE", CMSG_BINDER_ACTIVATE },
        // bank
        { "CMSG_BANKER_ACTIVATE", CMSG_BANKER_ACTIVATE },
        { "CMSG_AUTOBANK_ITEM", CMSG_AUTOBANK_ITEM },
        { "CMSG_AUTOSTORE_BANK_ITEM", CMSG_AUTOSTORE_BANK_ITEM },
        { "CMSG_BUY_BANK_SLOT", CMSG_BUY_BANK_SLOT },
        // mail
        { "CMSG_SEND_MAIL", CMSG_SEND_MAIL },
        { "CMSG_GET_MAIL_LIST", CMSG_GET_MAIL_LIST },
        { "CMSG_MAIL_TAKE_ITEM", CMSG_MAIL_TAKE_ITEM },
        { "CMSG_MAIL_TAKE_MONEY", CMSG_MAIL_TAKE_MONEY },
        { "CMSG_MAIL_MARK_AS_READ", CMSG_MAIL_MARK_AS_READ },
        { "CMSG_MAIL_DELETE", CMSG_MAIL_DELETE },
        { "CMSG_MAIL_RETURN_TO_SENDER", CMSG_MAIL_RETURN_TO_SENDER },
        // party
        { "CMSG_GROUP_INVITE", CMSG_GROUP_INVITE },
        { "CMSG_GROUP_ACCEPT", CMSG_GROUP_ACCEPT },
        { "CMSG_GROUP_DECLINE", CMSG_GROUP_DECLINE },
        { "CMSG_GROUP_UNINVITE", CMSG_GROUP_UNINVITE },
        { "CMSG_GROUP_UNINVITE_GUID", CMSG_GROUP_UNINVITE_GUID },
        { "CMSG_GROUP_DISBAND", CMSG_GROUP_DISBAND },
        { "CMSG_GROUP_SET_LEADER", CMSG_GROUP_SET_LEADER },
        { "CMSG_LOOT_METHOD", CMSG_LOOT_METHOD },
        // group loot roll: the need/greed/pass/disenchant
        // button on the roll frame SMSG_LOOT_START_ROLL opened (body u64 roll
        // guid, u32 slot, u8 vote); the SDK's lootRoll builds it
        { "CMSG_LOOT_ROLL", CMSG_LOOT_ROLL },
        // trade
        { "CMSG_INITIATE_TRADE", CMSG_INITIATE_TRADE },
        { "CMSG_BEGIN_TRADE", CMSG_BEGIN_TRADE },
        { "CMSG_ACCEPT_TRADE", CMSG_ACCEPT_TRADE },
        { "CMSG_UNACCEPT_TRADE", CMSG_UNACCEPT_TRADE },
        { "CMSG_CANCEL_TRADE", CMSG_CANCEL_TRADE },
        { "CMSG_BUSY_TRADE", CMSG_BUSY_TRADE },
        { "CMSG_IGNORE_TRADE", CMSG_IGNORE_TRADE },
        { "CMSG_SET_TRADE_ITEM", CMSG_SET_TRADE_ITEM },
        { "CMSG_CLEAR_TRADE_ITEM", CMSG_CLEAR_TRADE_ITEM },
        { "CMSG_SET_TRADE_GOLD", CMSG_SET_TRADE_GOLD },
        // pet control: the pet action bar's buttons
        // (CMSG_PET_ACTION carries a command, a react state or a spell), a
        // direct pet cast, the bar edits, and the queries a client fires on
        // its own (name by pet number, the bar on demand)
        { "CMSG_PET_ACTION", CMSG_PET_ACTION },
        { "CMSG_PET_CAST_SPELL", CMSG_PET_CAST_SPELL },
        { "CMSG_PET_STOP_ATTACK", CMSG_PET_STOP_ATTACK },
        { "CMSG_PET_ABANDON", CMSG_PET_ABANDON },
        { "CMSG_PET_RENAME", CMSG_PET_RENAME },
        { "CMSG_PET_SET_ACTION", CMSG_PET_SET_ACTION },
        { "CMSG_PET_SPELL_AUTOCAST", CMSG_PET_SPELL_AUTOCAST },
        { "CMSG_PET_CANCEL_AURA", CMSG_PET_CANCEL_AURA },
        { "CMSG_PET_NAME_QUERY", CMSG_PET_NAME_QUERY },
        { "CMSG_REQUEST_PET_INFO", CMSG_REQUEST_PET_INFO },
        // client-cache queries a real client issues on its own
        { "CMSG_NAME_QUERY", CMSG_NAME_QUERY },
        { "CMSG_CREATURE_QUERY", CMSG_CREATURE_QUERY },
        { "CMSG_GAMEOBJECT_QUERY", CMSG_GAMEOBJECT_QUERY },
        { "CMSG_ITEM_QUERY_SINGLE", CMSG_ITEM_QUERY_SINGLE },
        { "CMSG_NPC_TEXT_QUERY", CMSG_NPC_TEXT_QUERY },
        { "CMSG_PAGE_TEXT_QUERY", CMSG_PAGE_TEXT_QUERY },
        // player-written item text — a mailed letter (body u64 item guid)
        { "CMSG_ITEM_TEXT_QUERY", CMSG_ITEM_TEXT_QUERY },
        { "CMSG_PLAYED_TIME", CMSG_PLAYED_TIME },
        { "CMSG_QUERY_TIME", CMSG_QUERY_TIME },
        { "CMSG_SET_WATCHED_FACTION", CMSG_SET_WATCHED_FACTION },
        { "CMSG_SET_ACTION_BUTTON", CMSG_SET_ACTION_BUTTON },
        // a ghost asking where its corpse is (the module asks once per death
        // on the client's behalf; this lets a snippet re-ask)
        { "MSG_CORPSE_QUERY", MSG_CORPSE_QUERY },
        { nullptr, 0 },
    };
    static constexpr size_t kRawPayloadMaxBytes = 512;

    static bool RawOpcodeAllowed(std::string const& name)
    {
        for (RawOpcode const* e = kRawAllowlist; e->name; ++e)
            if (name == e->name)
                return true;
        return false;
    }

    static uint16 RawOpcodeValue(std::string const& name)
    {
        for (RawOpcode const* e = kRawAllowlist; e->name; ++e)
            if (name == e->name)
                return e->op;
        return 0;
    }

    // Every missing/invalid-param reply names the action and the param it was
    // about: a bare "missing_guid" cost live-run turns to diagnose.
    static HttpReply MissingParam(std::string const& action, char const* code, char const* param)
    {
        return {400, Json::Writer().Add("ok", false).Add("error", code)
            .Add("action", action).Add("param", param).Str()};
    }

    HttpReply Manager::HttpAction(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        std::string action = req.GetString("action");
        if (token.empty())
            return MissingParam(action, "missing_token", "token");

        // Guid-shaped fields are validated wherever they appear, before any
        // per-action branching: a truncated or non-decimal guid must never
        // silently become guid 0 (which targets nothing).
        for (char const* key : { "guid", "targetGuid", "itemGuid" })
        {
            std::string v = req.GetString(key);
            if (!GuidFieldParses(v))
                return {400, Json::Writer().Add("ok", false).Add("error", "invalid_guid")
                    .Add("action", action).Add("param", key)
                    .Add("received", v.substr(0, 64)).Str()};
        }

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
                return MissingParam(action, "missing_position",
                    !req.Has("x") ? "x" : (!req.Has("y") ? "y" : "z"));
            float x = (float)req.GetDouble("x"), y = (float)req.GetDouble("y"), z = (float)req.GetDouble("z");
            // Optional: the guid of the unit the point was read from. Only a
            // planning hint (the z of a patrolling NPC is resolved to the
            // ground under it before pathing, see ResolvePath); never a
            // lookup, the request still walks to x,y.
            std::string guid = req.GetString("guid");
            PushTask([this, token, x, y, z, guid, ack]() { DoMoveTo(token, x, y, z, guid, ack); });
        }
        else if (action == "stop")
        {
            PushTask([this, token, ack]() { DoStop(token, ack); });
        }
        else if (action == "talent_tree")
        {
            // A client-local read (Talent.dbc / TalentTab.dbc for the
            // character's class), answered as a WB_TALENT_TREE event so the
            // observation is logged like every other one. No packet is sent.
            PushTask([this, token, ack]() { DoTalentTree(token, ack); });
        }
        else if (action == "face")
        {
            bool hasO = req.Has("orientation");
            bool hasXY = req.Has("x") && req.Has("y");
            if (!hasO && !hasXY)
                return MissingParam(action, "missing_face_target", "orientation or x,y");
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
                "vendor_list", "buy_item", "sell_item", "repair_all",
                "trainer_list", "trainer_buy_spell",
                "spirit_healer_activate", "questgiver_status_query", nullptr };
            static char const* kNoParams[] = {
                "clear_target", "attack_stop", "loot_money", "repop", "reclaim_corpse",
                "questgiver_status_multiple_query", nullptr };

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
                     || action == "destroy_item" || action == "quest_query"
                     || action == "learn_talent" || action == "learn_preview_talents" || action == "raw";
            if (!known)
                return {400, Json::Writer().Add("ok", false).Add("error", "unsupported_action").Add("action", action).Str()};

            if (needsGuid && req.GetString("guid").empty())
                return MissingParam(action, "missing_guid", "guid");
            if (action == "gossip_select" && (!req.Has("menuId") || !req.Has("optionId")))
                return MissingParam(action, "missing_option", !req.Has("menuId") ? "menuId" : "optionId");
            if ((action == "quest_details" || action == "quest_accept" || action == "quest_complete"
                 || action == "quest_choose_reward" || action == "quest_abandon" || action == "quest_query")
                && !req.Has("questId"))
                return MissingParam(action, "missing_quest_id", "questId");
            if (action == "quest_choose_reward" && !req.Has("rewardIndex"))
                return MissingParam(action, "missing_reward_index", "rewardIndex");
            if ((action == "cast_spell" || action == "cancel_cast" || action == "trainer_buy_spell")
                && !req.Has("spellId"))
                return MissingParam(action, "missing_spell_id", "spellId");
            if (action == "loot_item" && !req.Has("slot"))
                return MissingParam(action, "missing_slot", "slot");
            if (action == "buy_item" && (!req.Has("itemId") || !req.Has("slot")))
                return MissingParam(action, "missing_item", !req.Has("itemId") ? "itemId" : "slot");
            if (action == "sell_item" && req.GetString("itemGuid").empty())
                return MissingParam(action, "missing_item_guid", "itemGuid");
            if ((action == "equip_item" || action == "use_item" || action == "destroy_item")
                && (!req.Has("bag") || !req.Has("slot")))
                return MissingParam(action, "missing_bag_slot", !req.Has("bag") ? "bag" : "slot");
            if (action == "learn_talent" && (!req.Has("talentId") || !req.Has("rank")))
                return MissingParam(action, "missing_talent", !req.Has("talentId") ? "talentId" : "rank");
            if (action == "learn_preview_talents" && !req.Has("talents"))
                return MissingParam(action, "missing_talents", "talents");
            if (action == "raw")
            {
                // The escape hatch (PROTOCOL.md "raw"): an allowlisted client opcode by
                // name plus a caller-built hex payload. Everything about it is
                // checked here so a bad request never reaches the world thread.
                std::string opcode = req.GetString("opcode");
                if (opcode.empty())
                    return MissingParam(action, "missing_opcode", "opcode");
                if (!RawOpcodeAllowed(opcode))
                    return {400, Json::Writer().Add("ok", false).Add("error", "opcode_not_allowed")
                        .Add("action", action).Add("opcode", opcode)
                        .Add("hint", "only the CMSG_* names in PROTOCOL.md's raw allowlist can be sent; opcodes that already have an action must use that action").Str()};
                std::string payload = req.GetString("payload");
                if (payload.size() % 2 != 0 || payload.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
                    return {400, Json::Writer().Add("ok", false).Add("error", "invalid_payload")
                        .Add("action", action).Add("param", "payload")
                        .Add("hint", "payload is a hex string of the packet body bytes, little-endian per field, even length; empty for a bodiless opcode").Str()};
                if (payload.size() > kRawPayloadMaxBytes * 2)
                    return {400, Json::Writer().Add("ok", false).Add("error", "payload_too_large")
                        .Add("action", action).Add("received", (uint64_t)(payload.size() / 2))
                        .Add("maximum", (uint64_t)kRawPayloadMaxBytes).Str()};
            }

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
    // so it must not be in world). Needed because episode resets (a fresh
    // character per episode) accumulate characters against the realm's
    // per-account cap.
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

        std::string account = req.GetString("account", DefaultAccount());

        // Minimal ownership gate for the current per-run account scheme
        // (per-character credentials are the real Phase-1 fix,
        // . Deletes are only served for accounts on the
        // configured allowlist (WrathBench.Accounts), and never while another
        // token holds a live bench session on the account — an unauthenticated
        // caller must not be able to delete a character out from under a
        // running episode or on an arbitrary named account.
        if (!AccountPermitted(account))
            return {403, Json::Writer().Add("ok", false).Add("error", "account_not_permitted").Str()};
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [otherToken, other] : _byToken)
                if (!other->tearingDown.load() && otherToken != token
                    && strcasecmp(other->account.c_str(), account.c_str()) == 0)
                    return {409, Json::Writer().Add("ok", false).Add("error", "account_owned_by_other_token").Str()};
        }

        auto s = std::make_shared<BenchSession>();
        s->token = token;
        s->account = account;
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
        s->account = req.GetString("account", DefaultAccount());
        if (!AccountPermitted(s->account))
            return {403, Json::Writer().Add("ok", false).Add("error", "account_not_permitted").Str()};
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
        auto fail = [&](std::string const& err, int status = 400) {
            if (!s->ackFired.exchange(true))
                ack->set_value({status, Json::Writer().Add("ok", false).Add("error", err).Add("token", s->token).Str()});
        };

        uint32 accountId = AccountMgr::GetId(s->account);
        if (!accountId)
            return fail("unknown_account");
        s->accountId = accountId;

        // --- Same-token create (idempotent liftoff / self-reclaim) ---------
        // A repeated createSession under the same token must never dead-end. If
        // that token already owns a live in-world session for the SAME account
        // and character, return success idempotently — the caller re-syncs its
        // state from the event stream (the trap this whole change fixes was a
        // model boxed into calling createSession with no accepting answer). A
        // session still mid-login is genuinely in flight (token_in_use). Any
        // other same-token state — in world under a different character/account,
        // or already tearing down — means the old record is stale, so tear it
        // down and rebuild. Success is never returned for a character the caller
        // did not ask for (no silent wrong behavior). deleteMode and
        // listMode reject same-token upstream (HttpCharacterDelete/List) and
        // never reach here as duplicates.
        if (!s->deleteMode && !s->listMode)
        {
            std::shared_ptr<BenchSession> existing;
            {
                std::lock_guard<std::mutex> lock(_sessMutex);
                auto it = _byToken.find(s->token);
                if (it != _byToken.end() && it->second != s)
                    existing = it->second;
            }
            if (existing)
            {
                bool const sameChar = strcasecmp(existing->charName.c_str(), s->charName.c_str()) == 0;
                bool const sameAcct = existing->accountId == accountId;
                int const ph = existing->phase.load();
                if (!existing->tearingDown.load() && ph == BenchSession::P_INWORLD
                    && !existing->deleteMode && !existing->listMode && sameChar && sameAcct)
                {
                    // account/charName/targetGuidRaw are create-time-stable and
                    // published before P_INWORLD, so reading them here is safe.
                    if (!s->ackFired.exchange(true))
                        ack->set_value({200, Json::Writer().Add("ok", true).Add("token", existing->token)
                            .Add("account", existing->account).Add("character", existing->charName)
                            .AddGuid("guid", existing->targetGuidRaw).Add("inWorld", true).Str()});
                    // No new module session is created, so the SDK's per-session
                    // event stream never restarts — without this the caller would
                    // get ok:inWorld beside an empty state cache (the trap in a new
                    // skin). Emit the same reattach snapshot the WS-reattach path
                    // uses; the SDK advances its event epoch before the
                    // POST, so this lands in the new epoch, not the discarded one.
                    EmitSessionState(existing);
                    return;
                }
                if (!existing->tearingDown.load() && ph != BenchSession::P_INWORLD)
                    return fail("token_in_use", 409);   // genuinely mid-login; do not disrupt it
                // Stale or mismatched: reclaim our own token via the teardown
                // path. The account-reclaim wait below then covers the core
                // release before we rebuild.
                TeardownByToken(s->token);
            }
        }

        // --- Account ownership: reclaim (create) or refuse (delete/list) ---
        // One account = one lane = one live episode, enforced upstream (the
        // fleet's duplicate-account guard and the roster's account-busy guard),
        // so any OTHER session found holding this *permitted* account (the
        // allowlist was already checked in HttpCreateSession) at create time is a
        // stale/leaked session from a prior episode — not a legitimate concurrent
        // run, so reclaiming it is correct, not a race. A normal create therefore
        // takes ownership: tear the holder down via the existing teardown path
        // (never hand-rolled), then re-queue this create until the core has fully
        // released the account (FindSession null). Waiting for the release means
        // AddSession_ never has to kick a live session out from under a
        // WorldSession* we still hold — the dangling-pointer hazard the original
        // account_in_use guard existed to avoid, preserved here. deleteMode and
        // listMode keep the stricter refusal: character-delete must never evict a
        // running episode, and /characters is a read-only utility.
        {
            std::vector<std::string> holders;
            bool held = false;
            {
                std::lock_guard<std::mutex> lock(_sessMutex);
                for (auto& [otherToken, other] : _byToken)
                    if (!other->tearingDown.load() && otherToken != s->token && other->accountId == accountId)
                    {
                        held = true;
                        holders.push_back(otherToken);
                    }
            }
            if (held && (s->deleteMode || s->listMode))
                return s->deleteMode ? fail("account_owned_by_other_token", 409)
                                     : fail("account_in_use");

            // A core-side session on the account (a holder mid-teardown, or a
            // logged-out session still inside its post-logout grace window —
            // FindSession lingers up to ~a minute, the same window the runner's
            // deleteCharacter loop retries) also blocks a safe AddSession.
            bool const coreHeld = sWorldSessionMgr->FindSession(accountId) != nullptr;
            if (coreHeld && (s->deleteMode || s->listMode))
                return fail("account_in_use");

            if (held || coreHeld)   // create only past here
            {
                for (auto const& t : holders)
                {
                    // Audit the eviction on the leaked session's own log (its
                    // stream is still open until its shared_ptr drops) so the
                    // reclaim is visible from both sides of the handoff.
                    if (auto victim = TeardownByToken(t))   // idempotent: already-tearing-down holders are skipped
                    {
                        Audit(*victim, "action", Json::Writer().Add("op", "session_reclaimed")
                            .Add("account", s->account).Add("byToken", s->token).Str());
                        LOG_INFO("module", "wrathbench: reclaiming leaked account '{}' (session token '{}') for create token '{}'",
                            s->account, t, s->token);
                    }
                }

                int64_t const now = NowMs();
                if (s->createDeadlineMs == 0)
                    // Budget only part of HttpCreateSession's 20s wait for the
                    // release: the login flow that follows (auth -> char-enum ->
                    // PLAYER_LOGIN -> LOGIN_VERIFY_WORLD, several world ticks) must
                    // finish inside the same 20s, and overrunning it trips the 20s
                    // teardown path (which would now kill the session we just
                    // built). Leave ~9s of headroom for login.
                    s->createDeadlineMs = now + 11000;
                if (now < s->createDeadlineMs)
                {
                    // Retry on the next world tick: UpdateSessions (which drains
                    // before this task queue) needs ticks to run LogoutPlayer and
                    // drop the old WorldSession from the core session map.
                    PushTask([this, s, ack]() { DoCreateSession(s, ack); });
                    return;
                }
                // The core did not release the account within the wait. The
                // teardown is already in flight, so this is a transient the
                // caller should retry into — report it as `timeout` (the same
                // code, and actionable retry hint, the 20s HTTP wait uses),
                // never the old dead-end account_in_use.
                return fail("timeout", 504);
            }
        }

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

        // Build the parked loopback socket. Blocking connect then accept
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
    // move_to is resolved once against the server's mmaps (the single
    // sanctioned exception in docs/CONTRACTS.md), then driven as the client
    // movement packet sequence a real client would send: MSG_MOVE_START_FORWARD,
    // MSG_MOVE_HEARTBEAT at ~500ms, MSG_MOVE_STOP — all through QueuePacket into
    // the stock HandleMovementOpcodes. The agent sees progress/arrival/failure
    // events only, never the path.

    static std::string PosJson(float x, float y, float z, float o)
    {
        return Json::Writer().Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Add("o", (double)o).Str();
    }

    // Which transport (tram car, boat, zeppelin) is this point standing on, if
    // any? A client's physics puts it on the transport's model; the module uses
    // the same model's world-space bounds (GameObjectModel::GetBounds, kept
    // current by UpdateModelPosition as the transport moves). When the model is
    // not loaded for a transport, a coarse radius around the transport's
    // position stands in — a documented approximation. World thread only.
    static Transport* FindTransportAt(Map* map, float x, float y, float z)
    {
        if (!map)
            return nullptr;
        for (Transport* t : map->GetAllTransports())
        {
            if (!t || !t->IsInWorld())
                continue;
            if (t->m_model)
            {
                G3D::AABox const& b = t->m_model->GetBounds();
                if (x >= b.low().x - 0.5f && x <= b.high().x + 0.5f
                    && y >= b.low().y - 0.5f && y <= b.high().y + 0.5f
                    && z >= b.low().z - 2.0f && z <= b.high().z + 2.0f)
                    return t;
            }
            else if (t->GetExactDist2d(x, y) <= 12.0f && std::fabs(t->GetPositionZ() - z) <= 20.0f)
                return t;
        }
        return nullptr;
    }

    // Synthesize one client movement packet (MovementInfo layout mirrors
    // WorldSession::ReadMovementInfo: flags u32, flags2 u16, time u32, xyzo,
    // [ONTRANSPORT: packGUID transport, local xyzo, u32 transport time, i8 seat,]
    // fallTime u32; no swim/fall extras for ground movement). The module's
    // clock doubles as the "client" clock; CMSG_TIME_SYNC_RESP below keeps the
    // session's clock delta near zero so these timestamps are accepted. When
    // the point is on a transport the packet says so the way a client's would:
    // the server then carries the character as a passenger.
    static void SendMovePacket(BenchSession& s, Player* player, uint16 opcode, uint32 moveFlags,
        float x, float y, float z, float o, Transport* transport = nullptr)
    {
        if (transport)
            moveFlags |= MOVEMENTFLAG_ONTRANSPORT;
        WorldPacket* p = new WorldPacket(opcode, 8 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4);
        *p << player->GetPackGUID();
        *p << uint32(moveFlags);
        *p << uint16(0);            // flags2
        *p << uint32(getMSTime());
        *p << float(x) << float(y) << float(z) << float(o);
        if (transport)
        {
            float lx = x, ly = y, lz = z, lo = o;
            transport->CalculatePassengerOffset(lx, ly, lz, &lo);
            *p << transport->GetPackGUID();
            *p << float(lx) << float(ly) << float(lz) << float(lo);
            *p << uint32(transport->GetPathProgress());
            *p << int8(-1);         // seat: none (not a vehicle)
        }
        *p << uint32(0);            // fallTime
        s.ws->QueuePacket(p);
    }

    // Does the navmesh have a tile loaded under this point? Mirrors
    // PathGenerator::HaveTile, which is private; a missing tile is the case the
    // core folds into PATHFIND_NORMAL|PATHFIND_NOT_USING_PATH (a straight-line
    // "shortcut" the module must never walk).
    static bool HaveNavTile(dtNavMesh const* navMesh, float x, float y, float z)
    {
        if (!navMesh)
            return false;
        float point[3] = { y, z, x };
        int tx = -1, ty = -1;
        navMesh->calcTileLoc(point, &tx, &ty);
        if (tx < 0 || ty < 0)
            return false;
        return navMesh->getTileAt(tx, ty, 0) != nullptr;
    }

    static bool IsCompletePath(PathType type, Movement::PointsArray const& pts)
    {
        return (type & PATHFIND_NORMAL)
            && !(type & (PATHFIND_NOPATH | PATHFIND_INCOMPLETE | PATHFIND_SHORT | PATHFIND_FARFROMPOLY | PATHFIND_NOT_USING_PATH))
            && pts.size() >= 2;
    }

    // A mesh path that falls is a ledge, not a route (nav-probe c4 on map
    // 369: a polyline segment with dz -7.64 over 1.0y of
    // 2D travel was walked, `arrived` was reported from a 2D-only check, and
    // the next move from down there was `start_off_mesh`). A segment is a
    // drop when it is both tall (> 2.0y, so stairs and stale-z corrections
    // stay `meshZ`) and steeper than a ramp (|dz| > 1.2 x its 2D length).
    // Deliberately not the core's SetSlopeCheck: that is a pathing-time
    // preference, this is a verdict on the route the mesh already chose.
    static constexpr float DROP_MIN_DZ = 2.0f;
    static constexpr float DROP_SLOPE = 1.2f;
    static bool IsDropSegment(WbVec const& a, WbVec const& b, float* dzOut)
    {
        float dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        float d2 = std::sqrt(dx * dx + dy * dy);
        if (dzOut) *dzOut = dz;
        return std::fabs(dz) > DROP_MIN_DZ && std::fabs(dz) > DROP_SLOPE * d2;
    }

    // Audit shape of a resolved polyline (op: move_path), capped so a 200-point
    // sweep does not flood the log; `truncated` says when the cap bit.
    static std::string PathPointsJson(std::vector<WbVec> const& pts, size_t cap = 64)
    {
        std::ostringstream ss;
        ss << '[';
        size_t n = std::min(pts.size(), cap);
        for (size_t i = 0; i < n; ++i)
        {
            if (i) ss << ',';
            ss << Json::Writer().Add("x", (double)pts[i].x).Add("y", (double)pts[i].y).Add("z", (double)pts[i].z).Str();
        }
        ss << ']';
        return ss.str();
    }

    // The cause ladder behind a move_to (PROTOCOL.md, WB_MOVE_RESULT.status).
    // Returns status == nullptr with `points` filled on success. Order matters:
    // no_mesh must be tested before CalculatePath, because the core hides a
    // missing tile inside NORMAL|NOT_USING_PATH; the endpoint check is 2D so
    // that a stale z in the request is the mesh's problem (meshZ), not the
    // agent's.
    Manager::PathResolve Manager::ResolvePathAt(Player* player, float x, float y, float z, float reqZ)
    {
        PathResolve r;
        dtNavMesh const* navMesh = player->GetMap()->GetMapCollisionData().GetMMapData().GetNavMesh();
        if (!HaveNavTile(navMesh, player->GetPositionX(), player->GetPositionY(), player->GetPositionZ())
            || !HaveNavTile(navMesh, x, y, z))
        {
            r.status = "no_mesh";
            return r;
        }

        PathGenerator gen(player);
        bool built = gen.CalculatePath(x, y, z, false);
        PathType type = gen.GetPathType();
        Movement::PointsArray const& pts = gen.GetPath();

        if (!built || (type & PATHFIND_NOT_USING_PATH))
        {
            // No poly under one end. The core does not say which, so ask it
            // about the start alone: a path from the character to itself is
            // NORMAL when the start is on the mesh.
            PathGenerator probe(player);
            probe.CalculatePath(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), false);
            r.status = (probe.GetPathType() & PATHFIND_NOT_USING_PATH) ? "start_off_mesh" : "target_off_mesh";
            return r;
        }
        if (type & PATHFIND_FARFROMPOLY_START)
        {
            r.status = "start_off_mesh";
            return r;
        }
        if (type & PATHFIND_FARFROMPOLY_END)
        {
            r.status = "target_off_mesh";
            return r;
        }

        auto endpointOk = [&](PathGenerator const& g) {
            G3D::Vector3 const& end = g.GetActualEndPosition();
            float dx = end.x - x, dy = end.y - y;
            return dx * dx + dy * dy <= 16.0f; // navmesh end within 4y of the request, 2D
        };

        if (IsCompletePath(type, pts))
        {
            if (!endpointOk(gen))
            {
                r.status = "target_off_mesh";
                return r;
            }
            for (auto const& v : pts)
                r.points.push_back({v.x, v.y, v.z});
        }
        else
        {
            // Partial path (INCOMPLETE / SHORT / NOPATH). One module-side
            // subdivision retry: path from where the mesh got to, onward to the
            // target, and splice. The z-ladder and midpoint retries models used
            // to hand-roll (travel.ts) live here now — pathing detail, not a
            // decision the agent should have to make.
            bool nonTrivial = pts.size() >= 2;
            if (nonTrivial)
            {
                G3D::Vector3 const& a = pts.front();
                G3D::Vector3 const& b = pts.back();
                nonTrivial = (a - b).squaredLength() > 1.0f;
            }
            if (nonTrivial)
            {
                G3D::Vector3 const& mid = pts.back();
                PathGenerator leg2(player);
                bool built2 = leg2.CalculatePath(mid.x, mid.y, mid.z, x, y, z, false);
                if (built2 && IsCompletePath(leg2.GetPathType(), leg2.GetPath()) && endpointOk(leg2))
                {
                    for (auto const& v : pts)
                        r.points.push_back({v.x, v.y, v.z});
                    Movement::PointsArray const& pts2 = leg2.GetPath();
                    for (size_t i = 1; i < pts2.size(); ++i) // pts2[0] == mid
                        r.points.push_back({pts2[i].x, pts2[i].y, pts2[i].z});
                }
                else
                {
                    r.status = "path_incomplete";
                    r.hasReached = true;
                    r.reachedX = mid.x; r.reachedY = mid.y; r.reachedZ = mid.z;
                    return r;
                }
            }
            else
            {
                r.status = "path_incomplete";
                r.hasReached = true;
                r.reachedX = player->GetPositionX(); r.reachedY = player->GetPositionY(); r.reachedZ = player->GetPositionZ();
                return r;
            }
        }

        if (r.points.size() < 2)
        {
            r.status = "path_incomplete";
            return r;
        }
        // Per-segment drop guard over the whole polyline (the main path and,
        // when spliced, the leg2 continuation): the walk is not dispatched.
        // `points` is kept so the move_path audit shows the route that fell.
        for (size_t i = 0; i + 1 < r.points.size(); ++i)
        {
            float dz = 0.0f;
            if (IsDropSegment(r.points[i], r.points[i + 1], &dz))
            {
                r.status = "drop";
                r.hasReached = true;
                r.reachedX = r.points[i].x; r.reachedY = r.points[i].y; r.reachedZ = r.points[i].z;
                r.hasDrop = true;
                r.dropDz = dz;
                return r;
            }
        }
        float endZ = r.points.back().z;
        if (std::fabs(endZ - reqZ) > 1.0f)
        {
            r.hasMeshZ = true;
            r.meshZ = endZ;
        }
        return r;
    }

    // The z-ladder in front of the cause ladder (part 3). A unit
    // target's z comes from the unit's own movement packets, and a patrolling or
    // sloped NPC's z can sit outside the core's default poly-search extents
    // while the ground under it is perfectly walkable ("Ironforge Mountaineer"
    // at (-5909, -68), nav-probe c3/c4: `target_off_mesh` for a point an NPC
    // stands on). The ground height at x,y is terrain and model geometry a
    // client has too (Map::GetHeight over maps/vmaps/GO models), so the module
    // resolves it before pathing: first for a unit target, as a fallback after
    // a `target_off_mesh` for any point. A target the mesh rejects at both its
    // own z and the ground z is still `target_off_mesh`; `meshZ` is always
    // relative to the z the agent asked for.
    Manager::PathResolve Manager::ResolvePath(Player* player, float x, float y, float z, bool unitTarget, bool* usedGroundZ, float* groundZOut)
    {
        if (usedGroundZ) *usedGroundZ = false;
        float groundZ = player->GetMap()->GetHeight(player->GetPhaseMask(), x, y, z, true);
        bool haveGround = groundZ > INVALID_HEIGHT && std::fabs(groundZ - z) > 0.5f;
        if (groundZOut) *groundZOut = haveGround ? groundZ : z;

        auto isTargetOffMesh = [](PathResolve const& r) { return r.status && std::strcmp(r.status, "target_off_mesh") == 0; };

        if (unitTarget && haveGround)
        {
            PathResolve r = ResolvePathAt(player, x, y, groundZ, z);
            if (!isTargetOffMesh(r))
            {
                if (usedGroundZ) *usedGroundZ = true;
                return r;
            }
            return ResolvePathAt(player, x, y, z, z);
        }
        PathResolve r = ResolvePathAt(player, x, y, z, z);
        if (isTargetOffMesh(r) && haveGround)
        {
            PathResolve r2 = ResolvePathAt(player, x, y, groundZ, z);
            if (!isTargetOffMesh(r2))
            {
                if (usedGroundZ) *usedGroundZ = true;
                return r2;
            }
        }
        return r;
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
        {
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            // Aboard a transport at the end of the move: the server is carrying
            // the character (it accepted ONTRANSPORT packets), so say which.
            if (Transport* t = player->GetTransport())
                w.Raw("onTransport", Json::Writer().AddGuid("guid", (uint64_t)t->GetGUID().GetRawValue())
                    .Add("entry", t->GetEntry()).Str());
        }
        // The z the mesh resolved the request to, when it differed from the
        // request by more than 1y: the honest signal that the agent's z was off
        // and the module walked to the ground instead.
        if (m.hasMeshZ)
            w.Add("meshZ", (double)m.meshZ);
        m.hasMeshZ = false;
        // A ledge found while walking (TickMover's defensive check): the edge
        // is where the mover stopped, dz is the step it refused to take.
        if (m.hasDrop)
        {
            w.Raw("reachedPos", Json::Writer().Add("x", (double)m.curX).Add("y", (double)m.curY).Add("z", (double)m.curZ).Str());
            w.Add("dz", (double)m.dropDz);
            w.Raw("target", Json::Writer().Add("x", (double)m.reqX).Add("y", (double)m.reqY).Add("z", (double)m.reqZ).Str());
        }
        m.hasDrop = false;
        EmitEvent(s, "WB_MOVE_RESULT", 0xFF01, w.Str());
    }

    void Manager::DoMoveTo(std::string token, float x, float y, float z, std::string guid, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        {
            Json::Writer a;
            a.Add("op", "move_to").Add("x", (double)x).Add("y", (double)y).Add("z", (double)z);
            if (!guid.empty())
                a.Add("guid", guid);
            Audit(*s, "action", a.Str());
        }

        if (s->move.active)
        {
            // A client whose run is redirected stops first: without this the
            // server's last movement word stays MOVEMENTFLAG_FORWARD when the
            // new request fails at planning, isMoving() stays true and every
            // later cast fails SPELL_FAILED_MOVING (~10 minutes of
            // Hearthstone casts in nav-probe c3).
            MoveState& old = s->move;
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, old.curX, old.curY, old.curZ, old.curO,
                FindTransportAt(player->GetMap(), old.curX, old.curY, old.curZ));
            FinishMove(*s, "superseded");
        }

        uint64_t moveId = ++s->moveIdGen;
        MoveState& m = s->move;
        m.moveId = moveId;

        // Ack means "queued"; the game-level outcome arrives as a WB_MOVE_RESULT
        // event, per the transport/game error split in PROTOCOL.md.
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "move_to")
            .Add("token", token).Add("moveId", moveId).Str()});

        auto failEvent = [&](char const* status) {
            // Nothing moved; if the server still has the character flagged as
            // moving (a superseded run it has not yet seen stop), end it the
            // way a client's run ends. A no-op for a character already still.
            if (player->isMoving())
                SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                    player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation(),
                    player->GetTransport());
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", status);
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
        };

        if (player->GetExactDist2d(x, y) > 250.0f)
            return failEvent("too_far");

        // Resolve the request against the server's mmaps (the one sanctioned
        // navmesh use, docs/CONTRACTS.md "Pathing") into either a walkable
        // polyline or one typed cause: the old single
        // `no_path` hid four different failures, and one of them (a 3D endpoint
        // check against a request whose z was merely stale) was self-inflicted.
        // Transports have no navmesh: a client walks straight onto (or off) a
        // docked tram car or boat. When either end of a short move is on a
        // transport's model, the path is that straight line and the movement
        // packets carry the transport offset (SendMovePacket). Longer moves
        // go through the mesh and fail with the honest start_off_mesh /
        // target_off_mesh, whose hints say to board or disembark first.
        PathResolve r;
        {
            Map* map = player->GetMap();
            Transport* startT = player->GetTransport();
            if (!startT)
                startT = FindTransportAt(map, player->GetPositionX(), player->GetPositionY(), player->GetPositionZ());
            Transport* targetT = FindTransportAt(map, x, y, z);
            if ((startT || targetT) && player->GetExactDist2d(x, y) <= 30.0f)
            {
                r.points.push_back({player->GetPositionX(), player->GetPositionY(), player->GetPositionZ()});
                r.points.push_back({x, y, z});
                Audit(*s, "action", Json::Writer().Add("op", "move_transport_leg")
                    .Add("moveId", moveId)
                    .Add("boarding", targetT != nullptr).Add("leaving", startT != nullptr && !targetT).Str());
            }
            else
            {
                bool usedGroundZ = false; float groundZ = z;
                r = ResolvePath(player, x, y, z, !guid.empty(), &usedGroundZ, &groundZ);
                if (usedGroundZ)
                    Audit(*s, "action", Json::Writer().Add("op", "move_ground_z").Add("moveId", moveId)
                        .Add("unitTarget", !guid.empty()).Add("z", (double)z).Add("groundZ", (double)groundZ).Str());
            }
        }
        // The resolved polyline, at dispatch, so a diagnosis reads the route
        // the mesh chose instead of reconstructing it from heartbeats.
        Audit(*s, "action", Json::Writer().Add("op", "move_path").Add("moveId", moveId)
            .Add("status", r.status ? r.status : "ok")
            .Add("pointCount", (uint64_t)r.points.size()).Add("truncated", r.points.size() > 64)
            .Raw("points", PathPointsJson(r.points)).Str());
        if (r.status != nullptr)
        {
            if (player->isMoving()) // see failEvent
                SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                    player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation(),
                    player->GetTransport());
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", r.status);
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            if (r.hasReached)
                w.Raw("reachedPos", Json::Writer().Add("x", (double)r.reachedX).Add("y", (double)r.reachedY).Add("z", (double)r.reachedZ).Str());
            if (r.hasDrop)
            {
                w.Add("dz", (double)r.dropDz);
                w.Raw("target", Json::Writer().Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Str());
            }
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
            return;
        }
        std::vector<WbVec> const& pts = r.points;
        m.meshZ = r.meshZ;
        m.hasMeshZ = r.hasMeshZ;
        m.reqX = x; m.reqY = y; m.reqZ = z;
        m.hasDrop = false;

        int64_t now = NowMs();
        m.points.clear();
        m.points = pts;
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

        SendMovePacket(*s, player, MSG_MOVE_START_FORWARD, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO,
            FindTransportAt(player->GetMap(), m.curX, m.curY, m.curZ));
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
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO,
                FindTransportAt(player->GetMap(), m.curX, m.curY, m.curZ));
            FinishMove(*s, "stopped");
        }
        else
        {
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation(),
                player->GetTransport());
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
        else if (action == "quest_query")
        {
            // The client's template fetch for a quest in its log (title,
            // objective text, required entries/counts). Answered by
            // SMSG_QUEST_QUERY_RESPONSE; an unknown id is silently dropped by
            // the core, exactly as for a client.
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            p = new WorldPacket(CMSG_QUEST_QUERY, 4);
            *p << uint32(questId);
            auditW.Add("questId", questId);
        }
        else if (action == "questgiver_status_query")
        {
            // What a client sends for each questgiver-flagged unit/gameobject
            // that comes into view, to draw the !/? marker. Answered by
            // SMSG_QUESTGIVER_STATUS for that guid.
            p = new WorldPacket(CMSG_QUESTGIVER_STATUS_QUERY, 8);
            *p << uint64(guid);
        }
        else if (action == "questgiver_status_multiple_query")
        {
            // What a client sends after its quest log changes, to refresh every
            // marker in view. Answered by SMSG_QUESTGIVER_STATUS_MULTIPLE.
            p = new WorldPacket(CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY, 0);
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
        else if (action == "trainer_list")
        {
            // CMSG_TRAINER_LIST is the same Hello shape as gossip/vendor: one
            // guid. The server answers SMSG_TRAINER_LIST, or nothing at all if
            // the NPC is out of interaction range, is not a trainer, or trains
            // another class (NPCHandler::HandleTrainerListOpcode returns
            // silently on all three) — the ack means "opcode queued" only.
            p = new WorldPacket(CMSG_TRAINER_LIST, 8);
            *p << uint64(guid);
        }
        else if (action == "trainer_buy_spell")
        {
            // uint64 trainer guid + int32 spell id, exactly what
            // WorldPackets::NPC::TrainerBuySpell::Read consumes. The spell is
            // paid for out of the character's own money server-side; a failure
            // arrives as SMSG_TRAINER_BUY_FAILED with a reason.
            uint32 spellId = static_cast<uint32>(req.GetInt("spellId"));
            p = new WorldPacket(CMSG_TRAINER_BUY_SPELL, 8 + 4);
            *p << uint64(guid) << uint32(spellId);
            auditW.Add("spellId", spellId);
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
            uint32 startQuest = proto ? proto->StartQuest : 0;
            if (spellId)
            {
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
            }
            else if (startQuest)
            {
                // A quest-start item with no on-use spell (Tome of Divinity,
                // the starter-zone "found a letter" drops). A client never sends
                // CMSG_USE_ITEM for one: HandleUseItemOpcode drops spell id 0
                // as unknown before it looks at the item. Right-clicking it
                // sends CMSG_QUESTGIVER_QUERY_QUEST with the item's own guid as
                // the questgiver (the handler accepts TYPEMASK_ITEM), and the
                // server answers with SMSG_QUESTGIVER_QUEST_DETAILS; the accept
                // then names the item guid too. The quest id is the template's
                // (client-cache knowledge, same as the spell id above).
                p = new WorldPacket(CMSG_QUESTGIVER_QUERY_QUEST, 13);
                *p << uint64(item->GetGUID().GetRawValue()) << uint32(startQuest) << uint8(0);
            }
            else
                return err(400, "item_not_usable");
            auditW.Add("bag", (uint32)bag).Add("slot", (uint32)slot).Add("spellId", spellId)
                .AddGuid("itemGuid", item->GetGUID().GetRawValue()).Add("startQuest", startQuest);
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
        else if (action == "spirit_healer_activate")
        {
            // Graveyard fallback when the corpse is unreachable. No dedicated
            // response opcode: the client observes the resurrection through
            // already-served events (health/update fields, res-sickness aura,
            // and — if the corpse graveyard differs — a teleport, acked by
            // TickTeleportAcks).
            p = new WorldPacket(CMSG_SPIRIT_HEALER_ACTIVATE, 8);
            *p << uint64(guid);
        }
        else if (action == "reclaim_corpse")
        {
            // Handler resolves the player's own corpse; the guid payload is the
            // corpse guid a real client echoes (optional here).
            p = new WorldPacket(CMSG_RECLAIM_CORPSE, 8);
            *p << uint64(guid);
        }
        else if (action == "learn_talent")
        {
            // uint32 talent id (Talent.dbc) + uint32 requested rank (0-based),
            // exactly what HandleLearnTalentOpcode reads. The handler answers
            // with SMSG_TALENTS_INFO whether or not the talent was learned; the
            // spell it grants arrives as SMSG_LEARNED_SPELL.
            uint32 talentId = static_cast<uint32>(req.GetInt("talentId"));
            uint32 rank = static_cast<uint32>(req.GetInt("rank"));
            p = new WorldPacket(CMSG_LEARN_TALENT, 8);
            *p << uint32(talentId) << uint32(rank);
            auditW.Add("talentId", talentId).Add("rank", rank);
        }
        else if (action == "learn_preview_talents")
        {
            // uint32 count, then (uint32 talentId, uint32 rank) pairs — the
            // client's "learn" button in preview mode. `talents` is the raw
            // JSON array text [[id, rank], ...] (the flat parser keeps nested
            // values verbatim); the module only reads digit pairs out of it.
            std::string raw = req.GetString("talents");
            std::vector<std::pair<uint32, uint32>> pairs;
            std::vector<uint32> nums;
            size_t i = 0;
            while (i < raw.size())
            {
                if (std::isdigit(static_cast<unsigned char>(raw[i])))
                {
                    size_t j = i;
                    while (j < raw.size() && std::isdigit(static_cast<unsigned char>(raw[j]))) ++j;
                    try { nums.push_back(static_cast<uint32>(std::stoul(raw.substr(i, j - i)))); } catch (...) {}
                    i = j;
                }
                else
                    ++i;
            }
            if (nums.empty() || nums.size() % 2 != 0 || nums.size() / 2 > 150)
                return err(400, "invalid_talents");
            for (size_t k = 0; k < nums.size(); k += 2)
                pairs.emplace_back(nums[k], nums[k + 1]);
            p = new WorldPacket(CMSG_LEARN_PREVIEW_TALENTS, 4 + 8 * pairs.size());
            *p << uint32(pairs.size());
            for (auto const& [id, rank] : pairs)
                *p << uint32(id) << uint32(rank);
            auditW.Add("count", (uint64_t)pairs.size()).Raw("talents", raw.empty() ? "[]" : raw);
        }
        else if (action == "raw")
        {
            // The escape hatch: validated on the io thread (opcode
            // on the allowlist, payload well-formed hex, size-capped); here it
            // is only decoded and queued into the stock handler like any other
            // client packet. The audit record carries opcode and payload so
            // the exact bytes "the client" sent are reconstructable.
            std::string opcode = req.GetString("opcode");
            std::string payload = req.GetString("payload");
            uint16 op = RawOpcodeValue(opcode);
            if (!op)
                return err(400, "opcode_not_allowed");
            p = new WorldPacket(op, payload.size() / 2);
            for (size_t i = 0; i + 1 < payload.size(); i += 2)
                *p << uint8(std::stoul(payload.substr(i, 2), nullptr, 16));
            auditW.Add("opcode", opcode).Add("payload", payload);
        }
        else
            return err(400, "unsupported_action");

        s->ws->QueuePacket(p);
        Audit(*s, "action", auditW.Str());
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", action).Add("token", token).Str()});
    }

    // WDBC reader for AreaTrigger.dbc (3.3.5a: 10 fields of 4 bytes — id,
    // mapId, x, y, z, radius, boxLength, boxWidth, boxHeight, boxYaw). Header:
    // "WDBC", u32 recordCount, u32 fieldCount, u32 recordSize, u32 stringBlock.
    bool Manager::LoadAreaTriggerDbc(std::string const& path)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return false;
        char magic[4];
        uint32 recordCount = 0, fieldCount = 0, recordSize = 0, stringSize = 0;
        in.read(magic, 4);
        in.read(reinterpret_cast<char*>(&recordCount), 4);
        in.read(reinterpret_cast<char*>(&fieldCount), 4);
        in.read(reinterpret_cast<char*>(&recordSize), 4);
        in.read(reinterpret_cast<char*>(&stringSize), 4);
        if (!in || std::memcmp(magic, "WDBC", 4) != 0 || fieldCount < 10 || recordSize < 40)
        {
            LOG_ERROR("module", "wrathbench: '{}' is not a 3.3.5a AreaTrigger.dbc (fields {}, record size {})", path, fieldCount, recordSize);
            return false;
        }
        std::vector<char> rec(recordSize);
        size_t loaded = 0;
        for (uint32 i = 0; i < recordCount; ++i)
        {
            in.read(rec.data(), recordSize);
            if (!in)
                break;
            uint32 id, map;
            float f[8];
            std::memcpy(&id, rec.data(), 4);
            std::memcpy(&map, rec.data() + 4, 4);
            std::memcpy(f, rec.data() + 8, sizeof(f));
            AreaTriggerRec r;
            r.id = id;
            r.x = f[0]; r.y = f[1]; r.z = f[2];
            r.radius = f[3];
            r.boxLength = f[4]; r.boxWidth = f[5]; r.boxHeight = f[6]; r.boxYaw = f[7];
            _areaTriggers[map].push_back(r);
            ++loaded;
        }
        _areaTriggersLoaded = loaded > 0;
        LOG_INFO("module", "wrathbench: loaded {} areatriggers across {} maps from '{}'", loaded, _areaTriggers.size(), path);
        return _areaTriggersLoaded;
    }

    // WDBC reader for AreaTable.dbc (3.3.5a: 36 fields of 4 bytes, record
    // size 144 — verified against the shipped file: id, mapId, parentAreaId,
    // exploreFlag, flags, soundProviderPref, soundProviderPrefUnderwater,
    // ambienceId, zoneMusic, introSound, explorationLevel, name[16 locales +
    // flags] from field 11 with enUS first, ...). Only id, mapId, parentAreaId
    // and the enUS name are kept. Same header as AreaTrigger.dbc above.
    bool Manager::LoadAreaTableDbc(std::string const& path)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return false;
        char magic[4];
        uint32 recordCount = 0, fieldCount = 0, recordSize = 0, stringSize = 0;
        in.read(magic, 4);
        in.read(reinterpret_cast<char*>(&recordCount), 4);
        in.read(reinterpret_cast<char*>(&fieldCount), 4);
        in.read(reinterpret_cast<char*>(&recordSize), 4);
        in.read(reinterpret_cast<char*>(&stringSize), 4);
        if (!in || std::memcmp(magic, "WDBC", 4) != 0 || fieldCount != 36 || recordSize != 144)
        {
            LOG_ERROR("module", "wrathbench: '{}' is not a 3.3.5a AreaTable.dbc (fields {}, record size {})", path, fieldCount, recordSize);
            return false;
        }
        std::vector<char> recs(size_t(recordCount) * recordSize);
        in.read(recs.data(), recs.size());
        std::vector<char> strings(stringSize);
        in.read(strings.data(), stringSize);
        if (!in)
        {
            LOG_ERROR("module", "wrathbench: '{}' truncated ({} records, {} string bytes expected)", path, recordCount, stringSize);
            return false;
        }
        size_t loaded = 0;
        for (uint32 i = 0; i < recordCount; ++i)
        {
            char const* rec = recs.data() + size_t(i) * recordSize;
            uint32 id, map, parent, nameOff;
            std::memcpy(&id, rec, 4);
            std::memcpy(&map, rec + 4, 4);
            std::memcpy(&parent, rec + 8, 4);
            std::memcpy(&nameOff, rec + 11 * 4, 4);
            AreaTableRec r;
            r.mapId = map;
            r.parentAreaId = parent;
            if (nameOff < stringSize)
                r.name = std::string(strings.data() + nameOff, strnlen(strings.data() + nameOff, stringSize - nameOff));
            _areaTable[id] = std::move(r);
            ++loaded;
        }
        _areaTableLoaded = loaded > 0;
        LOG_INFO("module", "wrathbench: loaded {} areas from '{}'", loaded, path);
        return _areaTableLoaded;
    }

    // WDBC reader for Achievement.dbc (3.3.5a: 62 fields of 4 bytes, record
    // size 248 — verified against the shipped file: id, faction, map,
    // previous, name[16 locales + flags] from field 4 with enUS first,
    // description[17] from 21, category at 38, points at 39, uiOrder, flags,
    // icon, reward[17], minCriteria, sharesCriteria). Only id, enUS name,
    // points and category are kept. Same header as AreaTrigger.dbc above.
    bool Manager::LoadAchievementDbc(std::string const& path)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return false;
        char magic[4];
        uint32 recordCount = 0, fieldCount = 0, recordSize = 0, stringSize = 0;
        in.read(magic, 4);
        in.read(reinterpret_cast<char*>(&recordCount), 4);
        in.read(reinterpret_cast<char*>(&fieldCount), 4);
        in.read(reinterpret_cast<char*>(&recordSize), 4);
        in.read(reinterpret_cast<char*>(&stringSize), 4);
        if (!in || std::memcmp(magic, "WDBC", 4) != 0 || fieldCount != 62 || recordSize != 248)
        {
            LOG_ERROR("module", "wrathbench: '{}' is not a 3.3.5a Achievement.dbc (fields {}, record size {})", path, fieldCount, recordSize);
            return false;
        }
        std::vector<char> recs(size_t(recordCount) * recordSize);
        in.read(recs.data(), recs.size());
        std::vector<char> strings(stringSize);
        in.read(strings.data(), stringSize);
        if (!in)
        {
            LOG_ERROR("module", "wrathbench: '{}' truncated ({} records, {} string bytes expected)", path, recordCount, stringSize);
            return false;
        }
        size_t loaded = 0;
        for (uint32 i = 0; i < recordCount; ++i)
        {
            char const* rec = recs.data() + size_t(i) * recordSize;
            uint32 id, nameOff, category, points;
            std::memcpy(&id, rec, 4);
            std::memcpy(&nameOff, rec + 4 * 4, 4);
            std::memcpy(&category, rec + 38 * 4, 4);
            std::memcpy(&points, rec + 39 * 4, 4);
            AchievementRec r;
            r.points = points;
            r.categoryId = category;
            if (nameOff < stringSize)
                r.name = std::string(strings.data() + nameOff, strnlen(strings.data() + nameOff, stringSize - nameOff));
            _achievements[id] = std::move(r);
            ++loaded;
        }
        _achievementsLoaded = loaded > 0;
        LOG_INFO("module", "wrathbench: loaded {} achievements from '{}'", loaded, path);
        return _achievementsLoaded;
    }

    // WDBC reader for TaxiNodes.dbc (3.3.5a: 24 fields of 4 bytes, record
    // size 96 — verified against the shipped file: id, mapId, x, y, z,
    // name[16 locales + flags] from field 5 with enUS first, mount creature
    // ids). Only id, mapId and the enUS name are kept: the position is not
    // served (the client draws the node on its taxi map from it, but the
    // model-facing surface is names only until an operator decides
    // otherwise). Same header as AreaTrigger.dbc above.
    bool Manager::LoadTaxiNodesDbc(std::string const& path)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return false;
        char magic[4];
        uint32 recordCount = 0, fieldCount = 0, recordSize = 0, stringSize = 0;
        in.read(magic, 4);
        in.read(reinterpret_cast<char*>(&recordCount), 4);
        in.read(reinterpret_cast<char*>(&fieldCount), 4);
        in.read(reinterpret_cast<char*>(&recordSize), 4);
        in.read(reinterpret_cast<char*>(&stringSize), 4);
        if (!in || std::memcmp(magic, "WDBC", 4) != 0 || fieldCount != 24 || recordSize != 96)
        {
            LOG_ERROR("module", "wrathbench: '{}' is not a 3.3.5a TaxiNodes.dbc (fields {}, record size {})", path, fieldCount, recordSize);
            return false;
        }
        std::vector<char> recs(size_t(recordCount) * recordSize);
        in.read(recs.data(), recs.size());
        std::vector<char> strings(stringSize);
        in.read(strings.data(), stringSize);
        if (!in)
        {
            LOG_ERROR("module", "wrathbench: '{}' truncated ({} records, {} string bytes expected)", path, recordCount, stringSize);
            return false;
        }
        size_t loaded = 0;
        for (uint32 i = 0; i < recordCount; ++i)
        {
            char const* rec = recs.data() + size_t(i) * recordSize;
            uint32 id, map, nameOff;
            std::memcpy(&id, rec, 4);
            std::memcpy(&map, rec + 4, 4);
            std::memcpy(&nameOff, rec + 5 * 4, 4);
            TaxiNodeRec r;
            r.mapId = map;
            if (nameOff < stringSize)
                r.name = std::string(strings.data() + nameOff, strnlen(strings.data() + nameOff, stringSize - nameOff));
            _taxiNodes[id] = std::move(r);
            ++loaded;
        }
        _taxiNodesLoaded = loaded > 0;
        LOG_INFO("module", "wrathbench: loaded {} taxi nodes from '{}'", loaded, path);
        return _taxiNodesLoaded;
    }

    // WDBC reader for TalentTab.dbc (3.3.5a: 24 fields of 4 bytes, record
    // size 96 — verified against the shipped file: id, name[16 locales +
    // flags] from field 1 with enUS first, spell icon, race mask, class mask
    // (field 20), pet talent mask, tab page (field 22), internal name). Same
    // header as AreaTrigger.dbc above.
    bool Manager::LoadTalentTabDbc(std::string const& path)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return false;
        char magic[4];
        uint32 recordCount = 0, fieldCount = 0, recordSize = 0, stringSize = 0;
        in.read(magic, 4);
        in.read(reinterpret_cast<char*>(&recordCount), 4);
        in.read(reinterpret_cast<char*>(&fieldCount), 4);
        in.read(reinterpret_cast<char*>(&recordSize), 4);
        in.read(reinterpret_cast<char*>(&stringSize), 4);
        if (!in || std::memcmp(magic, "WDBC", 4) != 0 || fieldCount != 24 || recordSize != 96)
        {
            LOG_ERROR("module", "wrathbench: '{}' is not a 3.3.5a TalentTab.dbc (fields {}, record size {})", path, fieldCount, recordSize);
            return false;
        }
        std::vector<char> recs(size_t(recordCount) * recordSize);
        in.read(recs.data(), recs.size());
        std::vector<char> strings(stringSize);
        in.read(strings.data(), stringSize);
        if (!in)
        {
            LOG_ERROR("module", "wrathbench: '{}' truncated ({} records, {} string bytes expected)", path, recordCount, stringSize);
            return false;
        }
        size_t loaded = 0;
        for (uint32 i = 0; i < recordCount; ++i)
        {
            char const* rec = recs.data() + size_t(i) * recordSize;
            uint32 id, nameOff, classMask, page;
            std::memcpy(&id, rec, 4);
            std::memcpy(&nameOff, rec + 1 * 4, 4);
            std::memcpy(&classMask, rec + 20 * 4, 4);
            std::memcpy(&page, rec + 22 * 4, 4);
            TalentTabRec r;
            r.classMask = classMask;
            r.page = page;
            if (nameOff < stringSize)
                r.name = std::string(strings.data() + nameOff, strnlen(strings.data() + nameOff, stringSize - nameOff));
            _talentTabs[id] = std::move(r);
            ++loaded;
        }
        _talentTabsLoaded = loaded > 0;
        LOG_INFO("module", "wrathbench: loaded {} talent tabs from '{}'", loaded, path);
        return _talentTabsLoaded;
    }

    std::string Manager::FactionJson(uint32 repListId, int32 standing, Player* player) const
    {
        Json::Writer w;
        w.Add("repListId", repListId);
        auto it = _repListToFaction.find(repListId);
        FactionEntry const* fe = it == _repListToFaction.end() ? nullptr : sFactionStore.LookupEntry(it->second);
        if (fe)
        {
            w.Add("factionId", fe->ID);
            if (fe->name[0])
                w.Add("name", fe->name[0]);
        }
        w.Add("standing", standing);
        // The client adds its own Faction.dbc base for the character's race
        // and class (ReputationMgr::GetBaseReputation is the same arithmetic
        // over the same masks); `reputation` is what the pane shows and what
        // the Neutral/Friendly/... rank is read off.
        if (fe && player)
        {
            uint32 raceMask = player->getRaceMask();
            uint32 classMask = player->getClassMask();
            int32 base = 0;
            for (int i = 0; i < 4; ++i)
            {
                if ((fe->BaseRepRaceMask[i] & raceMask || (fe->BaseRepRaceMask[i] == 0 && fe->BaseRepClassMask[i] != 0))
                    && (fe->BaseRepClassMask[i] & classMask || fe->BaseRepClassMask[i] == 0))
                {
                    base = fe->BaseRepValue[i];
                    break;
                }
            }
            w.Add("base", base).Add("reputation", base + standing);
        }
        return w.Str();
    }

    // The talent frame's contents for the player's class: every tab whose
    // TalentTab.dbc class mask includes the class, each talent's grid
    // position, rank spells (named from Spell.dbc), and prerequisite — the
    // static picture a client draws from its own DBCs. Which ranks are
    // learned is SMSG_TALENTS_INFO's business; the SDK joins the two.
    std::string Manager::TalentTreeJson(Player* player) const
    {
        uint8 cls = player->getClass();
        uint32 clsMask = cls ? 1u << (cls - 1) : 0;
        struct Tab { uint32 id; uint32 page; };
        std::vector<Tab> tabs;
        for (uint32 i = 0; i < sTalentTabStore.GetNumRows(); ++i)
        {
            TalentTabEntry const* t = sTalentTabStore.LookupEntry(i);
            if (!t || !(t->ClassMask & clsMask))
                continue;
            tabs.push_back({ t->TalentTabID, t->tabpage });
        }
        std::sort(tabs.begin(), tabs.end(), [](Tab const& a, Tab const& b) { return a.page < b.page; });
        std::string tabsJson = "[";
        for (size_t ti = 0; ti < tabs.size(); ++ti)
        {
            std::vector<TalentEntry const*> talents;
            for (uint32 i = 0; i < sTalentStore.GetNumRows(); ++i)
            {
                TalentEntry const* t = sTalentStore.LookupEntry(i);
                if (t && t->TalentTab == tabs[ti].id)
                    talents.push_back(t);
            }
            std::sort(talents.begin(), talents.end(), [](TalentEntry const* a, TalentEntry const* b) {
                return a->Row != b->Row ? a->Row < b->Row : a->Col < b->Col;
            });
            std::string list = "[";
            for (size_t k = 0; k < talents.size(); ++k)
            {
                TalentEntry const* t = talents[k];
                Json::Writer tw;
                tw.Add("talentId", t->TalentID);
                uint32 maxRank = 0;
                std::string ranks = "[";
                for (uint32 r = 0; r < MAX_TALENT_RANK; ++r)
                {
                    if (!t->RankID[r]) break;
                    if (r) ranks += ',';
                    ranks += std::to_string(t->RankID[r]);
                    ++maxRank;
                }
                ranks += "]";
                if (SpellInfo const* info = sSpellMgr->GetSpellInfo(t->RankID[0]))
                    if (info->SpellName[0])
                        tw.Add("name", info->SpellName[0]);
                tw.Add("row", t->Row).Add("col", t->Col).Add("maxRank", maxRank).Raw("ranks", ranks);
                if (t->DependsOn)
                    tw.Add("dependsOn", t->DependsOn).Add("dependsOnRank", t->DependsOnRank);
                if (k) list += ',';
                list += tw.Str();
            }
            list += "]";
            Json::Writer tabW;
            tabW.Add("tabId", tabs[ti].id);
            auto nameIt = _talentTabs.find(tabs[ti].id);
            if (nameIt != _talentTabs.end() && !nameIt->second.name.empty())
                tabW.Add("name", nameIt->second.name);
            tabW.Add("page", tabs[ti].page).Raw("talents", list);
            if (ti) tabsJson += ',';
            tabsJson += tabW.Str();
        }
        tabsJson += "]";
        Json::Writer w;
        w.Add("class", (uint32)cls).Add("unspentPoints", player->GetFreeTalentPoints()).Raw("tabs", tabsJson);
        return w.Str();
    }

    void Manager::DoTalentTree(std::string token, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;
        std::string json = TalentTreeJson(player);
        Audit(*s, "action", Json::Writer().Add("op", "talent_tree").Str());
        EmitEvent(*s, "WB_TALENT_TREE", 0xFF08, json);
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "talent_tree").Add("token", token).Str()});
    }

    // The wire carries dates as the client's packed bitfield
    // (ByteBuffer::AppendPackedTime: (year-2000)<<24 | month<<20 | (day-1)<<14
    // | weekday<<11 | hour<<6 | minute). Both the raw field and a readable
    // "YYYY-MM-DD HH:MM" are served; the reading is a client-local decode.
    std::string Manager::AchievementJson(uint32 id, uint32 packedDate) const
    {
        char when[24];
        std::snprintf(when, sizeof(when), "%04u-%02u-%02u %02u:%02u",
            2000u + ((packedDate >> 24) & 0x1F), ((packedDate >> 20) & 0xF) + 1, ((packedDate >> 14) & 0x3F) + 1,
            (packedDate >> 6) & 0x1F, packedDate & 0x3F);
        Json::Writer w;
        w.Add("achievementId", id).Add("date", packedDate).Add("time", when);
        auto it = _achievements.find(id);
        if (it != _achievements.end())
            w.Add("name", it->second.name).Add("points", it->second.points).Add("categoryId", it->second.categoryId);
        return w.Str();
    }

    void Manager::AddAreaFields(Json::Writer& w, Player* player)
    {
        uint32 zoneId = 0, areaId = 0;
        player->GetZoneAndAreaId(zoneId, areaId);
        auto nameOf = [this](uint32 id) -> std::string {
            auto it = _areaTable.find(id);
            return it == _areaTable.end() ? std::string() : it->second.name;
        };
        w.Add("mapId", player->GetMapId())
         .Add("zoneId", zoneId).Add("zoneName", nameOf(zoneId))
         .Add("areaId", areaId).Add("areaName", nameOf(areaId));
    }

    // A client computes the zone/subzone it is in from its own map files and
    // names them from AreaTable.dbc, and redraws on every change whether it
    // walked, was teleported or transferred. The server keeps the same pair
    // on the Player from the same terrain data, so reading it is the same
    // observation. Edge-triggered per session; the first in-world tick counts
    // as a change so login announces where the character is.
    void Manager::TickAreas()
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->phase.load() == BenchSession::P_INWORLD)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            if (!player || !player->IsInWorld() || player->IsBeingTeleported())
                continue;
            uint32 zoneId = 0, areaId = 0;
            player->GetZoneAndAreaId(zoneId, areaId);
            if (zoneId == s->lastZoneId && areaId == s->lastAreaId)
                continue;
            s->lastZoneId = zoneId;
            s->lastAreaId = areaId;
            Json::Writer w;
            AddAreaFields(w, player);
            EmitEvent(*s, "WB_AREA", 0xFF07, w.Str());
        }
    }

    // Same geometry as Player::IsInAreaTriggerRadius with delta 0 (the 5y
    // tavern delta is server-side only): a sphere when radius > 0, otherwise
    // an oriented box with half-extents length/2, width/2, height/2 around
    // (x, y, z, yaw).
    static bool InsideAreaTrigger(AreaTriggerRec const& t, float x, float y, float z)
    {
        if (t.radius > 0.0f)
        {
            float dx = x - t.x, dy = y - t.y, dz = z - t.z;
            return dx * dx + dy * dy + dz * dz <= t.radius * t.radius;
        }
        Position center(t.x, t.y, t.z, t.boxYaw);
        Position p(x, y, z, 0.0f);
        return p.IsWithinBox(center, t.boxLength / 2.0f, t.boxWidth / 2.0f, t.boxHeight / 2.0f);
    }

    void Manager::CheckAreaTriggers(BenchSession& s, Player* player, float x, float y, float z, int64_t nowMs)
    {
        if (!_areaTriggersLoaded)
            return;
        uint32 const mapId = player->GetMapId();
        if (mapId != s.insideTriggersMap)
        {
            // A map change (transfer, far teleport) leaves every volume.
            s.insideTriggers.clear();
            s.insideTriggersMap = mapId;
        }
        auto it = _areaTriggers.find(mapId);
        if (it == _areaTriggers.end())
        {
            s.insideTriggers.clear();
            return;
        }
        std::vector<uint32> nowInside;
        for (AreaTriggerRec const& t : it->second)
            if (InsideAreaTrigger(t, x, y, z))
                nowInside.push_back(t.id);

        // Fire once per entry, as a client does: only ids that were not inside
        // on the previous check. Nothing is re-sent while the mover lingers —
        // exploration triggers the server does not act on (already credited)
        // therefore fire exactly once per entry.
        std::vector<uint32> entered;
        for (uint32 id : nowInside)
            if (std::find(s.insideTriggers.begin(), s.insideTriggers.end(), id) == s.insideTriggers.end())
                entered.push_back(id);
        s.insideTriggers = std::move(nowInside);
        if (entered.empty())
            return;

        // A client never reports a trigger from a position it has not sent:
        // CMSG_AREATRIGGER always follows a movement packet carrying the entry
        // position. Heartbeats go out every ~500ms while the position is
        // tested every tick, so an entry between heartbeats would otherwise
        // be judged by the server against a position up to ~3.5y behind
        // (run speed), fail IsInAreaTriggerRadius and, being fired once per
        // entry, never be retried (smoke-travel 9c44d77a: tram exit 2171 hit
        // at 9.98y from a r10 centre, no transfer). So send a heartbeat at the
        // entry position first; both go through the same ordered
        // WorldSession queue (QueuePacket), so the server applies the
        // position before it evaluates the trigger.
        if (s.move.active)
        {
            MoveState& m = s.move;
            SendMovePacket(s, player, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, x, y, z, m.curO,
                FindTransportAt(player->GetMap(), x, y, z));
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                .Add("moveId", m.moveId).Add("cause", "areatrigger").Raw("pos", PosJson(x, y, z, m.curO)).Str());
        }

        for (uint32 id : entered)
        {
            WorldPacket* p = new WorldPacket(CMSG_AREATRIGGER, 4);
            *p << uint32(id);
            s.ws->QueuePacket(p);
            Audit(s, "action", Json::Writer().Add("op", "areatrigger").Add("triggerId", id).Add("moveId", s.move.moveId).Str());
            Json::Writer w;
            w.Add("triggerId", id).Add("moveId", s.move.moveId);
            w.Raw("pos", PosJson(x, y, z, s.move.curO));
            EmitEvent(s, "WB_AREATRIGGER", 0xFF04, w.Str());
        }
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
        if (!player)
        {
            m.active = false;
            return;
        }

        // A map transfer or a teleport ends the move: the server discards
        // every movement opcode until the ack (TickTeleportAcks) and applies the
        // destination itself. `transferred` rather than `interrupted`, so the
        // agent knows a portal took it; the SDK then waits
        // for SMSG_NEW_WORLD and resolves on the new map. A same-map teleport
        // (Hearthstone, graveyard port) is `teleported`: no
        // map change is coming. The 15y desync guard
        // below must not run here: the far-teleport position jump would race it.
        if (s.pendingTransferMap.load() != 0 || player->IsBeingTeleportedFar())
        {
            FinishMove(s, "transferred");
            return;
        }
        if (player->IsBeingTeleportedNear())
        {
            // Same map: no SMSG_NEW_WORLD will follow. The arrival point is
            // what the server's MSG_MOVE_TELEPORT_ACK (tapped) carries.
            FinishMove(s, "teleported");
            return;
        }
        if (!player->IsInWorld())
        {
            // Removed from the map for a reason that is not a teleport (logout
            // in flight): the move has no server verdict left to wait for.
            FinishMove(s, "interrupted");
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

        // Dying mid-run stops the move — but only while the body is still on
        // the ground. A released spirit (ghost flag) can and must move: the
        // corpse run is the normal 3.3.5a death recovery. Conflating the two
        // death states made every corpse run impossible.
        if (!player->IsAlive() && !player->HasPlayerFlag(PLAYER_FLAGS_GHOST))
        {
            SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation(),
                player->GetTransport());
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
            // A zero-length segment is consumed, never "walked": a request for
            // the point the character already stands on resolves to the
            // two-point path [here, here] (same poly, straight line), and the
            // old `advance < remain || segLen <= 0.0001f` branch broke out of
            // this loop without ever advancing `seg` — so the geometric-end
            // check below never fired, no MSG_MOVE_STOP was sent, and the
            // move heartbeated in place forever with no WB_MOVE_RESULT
            // (module-navigation step 5 of the smoke shape: walk home,
            // off-mesh, too_far, then "walk home" again).
            if (segLen <= 0.0001f)
            {
                ++m.seg;
                m.segDone = 0.0f;
                continue;
            }
            // Defensive twin of ResolvePathAt's guard: a segment that would
            // step off a ledge is not walked. Stop at the segment's start (the
            // edge) and say `drop` rather than interpolate down the cliff.
            if (m.segDone <= 0.0f)
            {
                float dz = 0.0f;
                if (IsDropSegment(a, b, &dz))
                {
                    m.curX = a.x; m.curY = a.y; m.curZ = a.z;
                    SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO,
                        FindTransportAt(player->GetMap(), m.curX, m.curY, m.curZ));
                    Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_STOP")
                        .Add("moveId", m.moveId).Add("cause", "drop").Add("dz", (double)dz)
                        .Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
                    m.hasDrop = true;
                    m.dropDz = dz;
                    FinishMove(s, "drop");
                    return;
                }
            }
            float remain = segLen - m.segDone;
            if (advance < remain)
            {
                m.segDone += advance;
                float t = m.segDone / segLen;
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
            SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.destX, m.destY, m.destZ, m.curO,
                FindTransportAt(player->GetMap(), m.destX, m.destY, m.destZ));
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
                    player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation(),
                    player->GetTransport());
                FinishMove(s, "interrupted");
                return;
            }
            SendMovePacket(s, player, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO,
                FindTransportAt(player->GetMap(), m.curX, m.curY, m.curZ));
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
        }

        // Areatrigger volumes, as a client: the movement engine knows its own
        // position and the DBC, and fires CMSG_AREATRIGGER on entering one
        // without the player choosing to. After the heartbeat, so the server's
        // applied position is as close as possible to the one tested here.
        CheckAreaTriggers(s, player, m.curX, m.curY, m.curZ, nowMs);
        if (!m.active)
            return; // (defensive: a synchronous finish is not expected here)

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

    // While a character rides a transport and is not walking, the server moves
    // it (StaticTransport/MotionTransport::UpdatePassengerPositions) and tells
    // the client nothing — a client computes its own position from the
    // transport's animation. The module has the same knowledge server-side, so
    // it reports the character's own position once a second as WB_RIDE_PROGRESS,
    // the riding counterpart of WB_MOVE_PROGRESS. World thread only.
    void Manager::TickRiders(int64_t nowMs)
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->phase.load() == BenchSession::P_INWORLD && !s->move.active)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            Transport* t = (player && player->IsInWorld()) ? player->GetTransport() : nullptr;
            if (!t)
            {
                s->lastRideEmitMs = 0;
                continue;
            }
            if (s->lastRideEmitMs && nowMs - s->lastRideEmitMs < 1000)
                continue;
            s->lastRideEmitMs = nowMs;
            Json::Writer w;
            w.AddGuid("transportGuid", (uint64_t)t->GetGUID().GetRawValue()).Add("transportEntry", t->GetEntry());
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            EmitEvent(*s, "WB_RIDE_PROGRESS", 0xFF05, w.Str());
        }
    }

    // A client that has received a transport's create block animates the car
    // itself from TransportAnimation.dbc and the clock the block carried
    // (pathProgress): it always knows where the car is and whether it is
    // sitting at a platform. The server keeps the same animation
    // (StaticTransport::RelocateToProgress from the same DBC), so the module
    // reports, at most once a second per session, the current position of
    // every transport the session has been sent (knownObjects: the client's
    // own object cache) on the character's map, plus `docked` — whether the
    // animation segment the clock is on has no displacement, i.e. the car
    // is dwelling at an end. Nothing here is beyond what the client computes
    // locally; it is the riding counterpart of WB_RIDE_PROGRESS for the car
    // rather than the passenger. World thread only.
    void Manager::TickTransports(int64_t nowMs)
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->phase.load() == BenchSession::P_INWORLD)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            if (s->lastTransportEmitMs && nowMs - s->lastTransportEmitMs < 1000)
                continue;
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            Map* map = (player && player->IsInWorld()) ? player->GetMap() : nullptr;
            if (!map)
                continue;
            s->lastTransportEmitMs = nowMs;
            for (Transport* t : map->GetAllTransports())
            {
                if (!t || !t->IsInWorld())
                    continue;
                {
                    std::lock_guard<std::mutex> lock(s->objMutex);
                    if (s->knownObjects.find((uint64_t)t->GetGUID().GetRawValue()) == s->knownObjects.end())
                        continue; // never sent to this client: not observable
                }
                Json::Writer w;
                w.AddGuid("guid", (uint64_t)t->GetGUID().GetRawValue()).Add("entry", t->GetEntry());
                w.Raw("pos", PosJson(t->GetPositionX(), t->GetPositionY(), t->GetPositionZ(), t->GetOrientation()));
                uint32 progress = t->GetPathProgress();
                w.Add("progressMs", progress);
                if (TransportAnimation const* anim = t->GetGOValue()->Transport.AnimationInfo)
                {
                    w.Add("periodMs", anim->TotalTime);
                    // Same lookup as TransportAnimation::GetAnimNode (the
                    // keyframe at or before the clock and the one after it),
                    // written out so a clock past the last keyframe answers
                    // nothing instead of tripping that function's ASSERT.
                    if (anim->TotalTime && !anim->Path.empty())
                    {
                        uint32 time = progress % anim->TotalTime;
                        auto nextIt = anim->Path.upper_bound(time);
                        if (nextIt != anim->Path.begin() && nextIt != anim->Path.end())
                        {
                            TransportAnimationEntry const* next = nextIt->second;
                            TransportAnimationEntry const* curr = std::prev(nextIt)->second;
                            float dx = next->X - curr->X, dy = next->Y - curr->Y, dz = next->Z - curr->Z;
                            w.Add("docked", dx * dx + dy * dy + dz * dz < 0.01f);
                        }
                    }
                }
                else if (StaticTransport* st = dynamic_cast<StaticTransport*>(t))
                    w.Add("periodMs", st->GetPeriod());
                EmitEvent(*s, "WB_TRANSPORT_PROGRESS", 0xFF06, w.Str());
            }
        }
    }

    // A real client answers every teleport once its loading screen is done:
    // MSG_MOVE_TELEPORT_ACK for a same-map teleport, MSG_MOVE_WORLDPORT_ACK for
    // a map transfer. Until that ack arrives the core discards all movement
    // opcodes (HandleMovementOpcodes: IsBeingTeleported -> ignore) and the
    // destination is never applied, so a session that never acks is wedged at
    // its pre-teleport position forever — repop's graveyard teleport was the
    // observed case. The parked client has no
    // loading screen, so the module acks on the next world tick, through the
    // same handlers a real client's packets would hit. Like the
    // CMSG_TIME_SYNC_RESP answer in the tap, this is module-internal client
    // behaviour: the semaphore state is never served to the agent, and the
    // agent never needs to know teleports exist.
    void Manager::TickTeleportAcks(int64_t nowMs)
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->phase.load() == BenchSession::P_INWORLD)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            if (!player || !player->IsBeingTeleported())
            {
                s->teleportAckQueuedMs = 0;
                continue;
            }
            // Pace re-sends: the queued ack is consumed on the session's next
            // update, so retry only if the semaphore is still set well after.
            if (s->teleportAckQueuedMs && nowMs - s->teleportAckQueuedMs < 1000)
                continue;
            s->teleportAckQueuedMs = nowMs;
            // A teleport leaves every areatrigger volume: re-entry fires again.
            s->insideTriggers.clear();

            char const* opcodeName;
            if (player->IsBeingTeleportedNear())
            {
                // Mirror of the client's echo of Player::SendTeleportAckPacket.
                // HandleMoveTeleportAck reads counter and time but uses neither.
                WorldPacket* p = new WorldPacket(MSG_MOVE_TELEPORT_ACK, 8 + 4 + 4);
                *p << player->GetPackGUID();
                *p << uint32(0);            // movement order counter echo
                *p << uint32(getMSTime());
                s->ws->QueuePacket(p);
                opcodeName = "MSG_MOVE_TELEPORT_ACK";
            }
            else
            {
                s->ws->QueuePacket(new WorldPacket(MSG_MOVE_WORLDPORT_ACK, 0));
                opcodeName = "MSG_MOVE_WORLDPORT_ACK";
            }
            Audit(*s, "action", Json::Writer().Add("op", "teleport_ack").Add("opcode", opcodeName).Str());
        }
    }

    // A real client sends MSG_CORPSE_QUERY once it is a ghost (after the repop
    // teleport lands), and draws the answer as the corpse marker on its map.
    // The parked client has no map, so the module issues the same one-shot
    // query and the tapped MSG_CORPSE_QUERY reply is served as an event
    // (PROTOCOL.md "Death"). Client behaviour, not an agent
    // action: nothing here resurrects or moves anyone, and the handler answers
    // from the corpse the player already owns. Waiting for the teleport to be
    // acked matters: the handler compares the corpse map to the player's map,
    // and the graveyard port must have applied for that to be the right map.
    void Manager::TickCorpseQuery()
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->phase.load() == BenchSession::P_INWORLD)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            if (!player)
                continue;
            if (player->IsAlive() || !player->HasPlayerFlag(PLAYER_FLAGS_GHOST))
            {
                s->corpseQueried = false;
                continue;
            }
            if (s->corpseQueried || player->IsBeingTeleported())
                continue;
            s->corpseQueried = true;
            s->ws->QueuePacket(new WorldPacket(MSG_CORPSE_QUERY, 0));
            Audit(*s, "action", Json::Writer().Add("op", "corpse_query").Add("opcode", "MSG_CORPSE_QUERY").Str());
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
            // The hot path: decoded inline, one pass, per-session
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
                            FailAck(*s, "character_not_found", 400);
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
            // Relaxed atomic add: this is the hot path, fired for
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
        PushTask([this, s]() { EmitSessionState(s); });
    }

    // Emit one synthetic WB_SESSION_STATE carrying the session's own
    // client-visible state. World thread only: reads the Player. The
    // guards mirror the reattach path — the session may tear down or lose the
    // core WorldSession between the caller's check and this run.
    void Manager::EmitSessionState(std::shared_ptr<BenchSession> const& s)
    {
        if (!s || s->tearingDown.load() || s->phase.load() != BenchSession::P_INWORLD)
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
        AddAreaFields(w, player);
        EmitEvent(*s, "WB_SESSION_STATE", 0xFF03, w.Str());
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
    // SMSG_UPDATE_OBJECT decoding (the observation hot path).
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
        // A transport's create block carries its animation clock (ms into the
        // TransportAnimation.dbc period); the client animates the car from it.
        if (flags & UPDATEFLAG_TRANSPORT) { uint32 t; p >> t; o.Add("pathProgress", t); }
        if (flags & UPDATEFLAG_VEHICLE)   { uint32 vid; float vo; p >> vid >> vo; }
        if (flags & UPDATEFLAG_ROTATION)  { int64 rot; p >> rot; }
    }

    // One whitelisted update field -> named JSON key. Returns false if the index
    // is not served (caller has already consumed the value).
    // A u64 update field arrives as two u32 halves under consecutive
    // indices; the halves are collected here and joined into one guid
    // string after the block (targetGuid and, since, the
    // owner fields a client reads a pet's master off).
    struct GuidHalves
    {
        uint32 lo{0}, hi{0};
        bool hasLo{false}, hasHi{false};
    };
    struct PendingGuids
    {
        GuidHalves target, summonedBy, createdBy, charmedBy;
    };

    static bool AppendNamedField(Json::Writer& f, uint8 typeId, uint32 index, uint32 v,
        PendingGuids& g, uint32* entryOut, uint32* petNumberOut)
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
            if (index == UNIT_FIELD_TARGET)     { g.target.lo = v; g.target.hasLo = true; return true; }
            if (index == UNIT_FIELD_TARGET + 1) { g.target.hi = v; g.target.hasHi = true; return true; }
            // Who this unit belongs to (PUBLIC, every client in range gets
            // them): a pet's master is UNIT_FIELD_SUMMONEDBY / CREATEDBY, a
            // mind-controlled unit's is CHARMEDBY.
            if (index == UNIT_FIELD_SUMMONEDBY)     { g.summonedBy.lo = v; g.summonedBy.hasLo = true; return true; }
            if (index == UNIT_FIELD_SUMMONEDBY + 1) { g.summonedBy.hi = v; g.summonedBy.hasHi = true; return true; }
            if (index == UNIT_FIELD_CREATEDBY)      { g.createdBy.lo = v; g.createdBy.hasLo = true; return true; }
            if (index == UNIT_FIELD_CREATEDBY + 1)  { g.createdBy.hi = v; g.createdBy.hasHi = true; return true; }
            if (index == UNIT_FIELD_CHARMEDBY)      { g.charmedBy.lo = v; g.charmedBy.hasLo = true; return true; }
            if (index == UNIT_FIELD_CHARMEDBY + 1)  { g.charmedBy.hi = v; g.charmedBy.hasHi = true; return true; }
            // The pet number a client keys its CMSG_PET_NAME_QUERY on
            // (UNIT_FIELD_PETNUMBER, PUBLIC; 0 on anything that is not a pet).
            if (index == UNIT_FIELD_PETNUMBER)
            {
                f.Add("petNumber", v);
                if (petNumberOut) *petNumberOut = v;
                return true;
            }
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
                case UNIT_FIELD_FLAGS:
                    // taxiFlight names UNIT_FLAG_TAXI_FLIGHT (0x00100000) off
                    // the same field: the client's own "on a flight path"
                    // reading, nothing the server adds (issue #8).
                    f.Add("unitFlags", v).Add("taxiFlight", (v & UNIT_FLAG_TAXI_FLIGHT) != 0); return true;
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
                // Unspent talent points (PLAYER_CHARACTER_POINTS1, PRIVATE):
                // the number on the talent frame; SMSG_TALENTS_INFO carries the
                // same figure.
                if (index == PLAYER_CHARACTER_POINTS1) { f.Add("talentPoints", v); return true; }
                // Skills: 128 lines x 3 packed u32s, PRIVATE
                // to self. Served raw per field the way the quest log is, plus
                // the client's SkillLine.dbc name beside each id so the SDK
                // needs no table. The SDK's fold keeps only numbers in
                // `fields` and lifts the name strings into its skill rows.
                if (index >= PLAYER_SKILL_INFO_1_1 && index < PLAYER_SKILL_INFO_1_1 + 384)
                {
                    uint32 rel = index - PLAYER_SKILL_INFO_1_1;
                    std::string key = "skill" + std::to_string(rel / 3);
                    switch (rel % 3)
                    {
                        case 0:
                        {
                            uint32 id = v & 0xFFFF;
                            f.Add(key + "Id", id).Add(key + "Step", v >> 16);
                            if (id)
                                if (SkillLineEntry const* sl = sSkillLineStore.LookupEntry(id))
                                    if (sl->name[0])
                                        f.Add(key + "Name", sl->name[0]);
                            return true;
                        }
                        case 1:
                            f.Add(key + "Value", v & 0xFFFF).Add(key + "Max", v >> 16);
                            return true;
                        default:
                            f.Add(key + "TempBonus", (int32)int16(v & 0xFFFF)).Add(key + "PermBonus", (int32)int16(v >> 16));
                            return true;
                    }
                }
                // Quest log: 25 slots x 5 fields (id, state, counts lo/hi, time).
                // Served raw; the SDK reassembles its quest-log view from them.
                if (index >= PLAYER_QUEST_LOG_1_1 && index < PLAYER_QUEST_LOG_25_1 + 5)
                {
                    uint32 rel = index - PLAYER_QUEST_LOG_1_1;
                    static char const* offName[5] = { "Id", "State", "CountsLo", "CountsHi", "Time" };
                    f.Add("quest" + std::to_string(rel / 5) + offName[rel % 5], v);
                    return true;
                }
                // Equipment/bag/backpack/bank item guids as lo/hi u32 halves
                // keyed by inventory slot (0-22 equipment+bags, 23-38 backpack,
                // 39-66 bank, 67-73 bank bags — the core's slot numbering, the
                // fields are contiguous). Halves stay u32 JSON numbers; the
                // SDK joins them into guids. Bank slots since.
                if (index >= PLAYER_FIELD_INV_SLOT_HEAD && index < PLAYER_FIELD_BANKBAG_SLOT_1 + 14)
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
            // Worn-bag contents: a container's slot guids as
            // lo/hi u32 halves keyed by bag slot 0-35, plus its slot count.
            // PUBLIC fields every client in range receives; same idiom as
            // the player's invSlot<n>. The SDK joins halves into guids.
            if (typeId == TYPEID_CONTAINER)
            {
                if (index == CONTAINER_FIELD_NUM_SLOTS) { f.Add("numSlots", v); return true; }
                if (index >= CONTAINER_FIELD_SLOT_1 && index < CONTAINER_FIELD_SLOT_1 + 72)
                {
                    uint32 rel = index - CONTAINER_FIELD_SLOT_1;
                    f.Add("bagSlot" + std::to_string(rel / 2) + (rel % 2 ? "Hi" : "Lo"), v);
                    return true;
                }
            }
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
    static void AddPendingGuid(Json::Writer& f, char const* key, GuidHalves const& h)
    {
        if (h.hasLo || h.hasHi)
            f.AddGuid(key, uint64_t(h.lo) | (uint64_t(h.hi) << 32));
    }

    static std::string DecodeValuesBlock(WorldPacket& p, uint8 typeId, uint32* entryOut, uint32* petNumberOut = nullptr)
    {
        uint8 blockCount; p >> blockCount;
        uint32 mask[64]; // m_valuesCount caps far below 64*32 fields
        if (blockCount > 64)
            throw ByteBufferException();
        for (uint8 i = 0; i < blockCount; ++i)
            p >> mask[i];

        Json::Writer f;
        PendingGuids g;
        uint32 fieldCount = uint32(blockCount) * 32;
        for (uint32 i = 0; i < fieldCount; ++i)
        {
            if (!(mask[i >> 5] & (1u << (i & 31))))
                continue;
            uint32 v; p >> v;
            AppendNamedField(f, typeId, i, v, g, entryOut, petNumberOut);
        }
        if (g.target.hasLo)
            f.AddGuid("targetGuid", uint64_t(g.target.lo) | (uint64_t(g.target.hi) << 32));
        AddPendingGuid(f, "summonedByGuid", g.summonedBy);
        AddPendingGuid(f, "createdByGuid", g.createdBy);
        AddPendingGuid(f, "charmedByGuid", g.charmedBy);
        return f.Str();
    }

    std::string Manager::DecodeUpdateObject(BenchSession& s, WorldSession* ws, WorldPacket const& packet)
    {
        WorldPacket p(packet);
        // Creature/name queries a real client would fire on cache miss; issued
        // after the parse so a decode error doesn't send half-baked queries.
        std::vector<std::pair<uint32, uint64_t>> creatureQueries;
        std::vector<std::pair<uint32, uint64_t>> gameObjectQueries;
        std::vector<uint64_t> nameQueries;
        std::vector<uint32_t> itemQueries;
        // (petNumber, guid): a client asks a pet's given name once per pet
        // number it sees; the answer is SMSG_PET_NAME_QUERY_RESPONSE.
        std::vector<std::pair<uint32, uint64_t>> petNameQueries;

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
                        uint32 entry = 0, petNumber = 0;
                        std::string fields = DecodeValuesBlock(p, typeId, &entry, &petNumber);
                        o.Raw("fields", fields);
                        {
                            std::lock_guard<std::mutex> lock(s.objMutex);
                            s.knownObjects[guid] = typeId;
                            if (typeId == TYPEID_UNIT && petNumber && s.queriedPetNumbers.insert(petNumber).second)
                                petNameQueries.emplace_back(petNumber, guid);
                            if (typeId == TYPEID_UNIT && entry && s.queriedCreatures.insert(entry).second)
                                creatureQueries.emplace_back(entry, guid);
                            if (typeId == TYPEID_GAMEOBJECT && entry && s.queriedGameObjects.insert(entry).second)
                                gameObjectQueries.emplace_back(entry, guid);
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
        for (auto const& [entry, guid] : gameObjectQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_GAMEOBJECT_QUERY, 12);
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
        for (auto const& [petNumber, guid] : petNameQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_PET_NAME_QUERY, 12);
            *q << uint32(petNumber) << uint64(guid);
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
            case MSG_MOVE_TELEPORT_ACK:       return "MSG_MOVE_TELEPORT_ACK";
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

    // What a client reads from its own Spell.dbc for a spell id: the rank in
    // the chain (1 when unranked) and the display name. Client-cache knowledge,
    // exactly like the item-template fields on CMSG_ITEM_QUERY_SINGLE.
    static void AddSpellFields(Json::Writer& w, uint32 spellId)
    {
        SpellInfo const* info = sSpellMgr->GetSpellInfo(spellId);
        if (!info)
            return;
        w.Add("rank", (uint32)info->GetRank());
        if (info->SpellName[0])
            w.Add("name", info->SpellName[0]);
    }

    static std::string SpellJson(uint32 spellId)
    {
        Json::Writer w;
        w.Add("spellId", spellId);
        AddSpellFields(w, spellId);
        return w.Str();
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
                // The server's side of a same-map teleport (Player::
                // SendTeleportAckPacket): the bench character's own guid and
                // the arrival point, which the server relocated to before
                // building the MovementInfo. One u32 movement-order counter
                // sits between the packGUID and the MovementInfo; otherwise the
                // shape is the observed-movement one.
                case MSG_MOVE_TELEPORT_ACK:
                {
                    name = MoveOpcodeName(opcode);
                    uint64 guid = 0; p.readPackGUID(guid);
                    if (opcode == MSG_MOVE_TELEPORT_ACK) { uint32 counter = 0; p >> counter; }
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
                // ------------------------------------------- spellbook/talents
                case SMSG_INITIAL_SPELLS:
                {
                    // Player::SendInitialSpells: u8 0, u16 count, (u32 spellId,
                    // u16 0) x count, u16 cooldownCount, (u32 spellId, u16
                    // itemId, u16 category, u32 cooldownMs, u32
                    // categoryCooldownMs) x cooldownCount. Rank and name are
                    // what a client reads from its own Spell.dbc for each id.
                    name = "SMSG_INITIAL_SPELLS";
                    uint8 unk; p >> unk;
                    uint16 count; p >> count;
                    std::string spells = "[";
                    for (uint16 i = 0; i < count; ++i)
                    {
                        uint32 spellId; uint16 slot; p >> spellId >> slot;
                        if (i) spells += ',';
                        spells += SpellJson(spellId);
                    }
                    spells += "]";
                    // Upstream quirk (AzerothCore Player::_LoadSpells,
                    // Player.cpp:2852 at our pinned commit): the cooldown
                    // count is written as m_spellCooldowns.size() BEFORE the
                    // loop skips !needSendToClient rows, and unlike the spell
                    // count above it is never fixed up with a data.put. A
                    // character holding a category cooldown therefore gets a
                    // packet declaring more entries than it carries (observed
                    // live: Hearthstone -> declared 2, carried 1). The loop
                    // below is correct anyway because it trusts the buffer,
                    // not the declared count: the `p.rpos() + 16 <= p.size()`
                    // guard (16 = one full tuple) stops at the actual end of
                    // the packet, and cooldowns are its final field, so an
                    // over-declared count yields exactly the rows present —
                    // no overrun, no partial tuple, no decodeError. Keep that
                    // guard if this decode is ever tightened.
                    uint16 cdCount = 0;
                    if (p.rpos() + 2 <= p.size()) p >> cdCount;
                    std::string cds = "[";
                    bool firstCd = true;
                    for (uint16 i = 0; i < cdCount && p.rpos() + 16 <= p.size(); ++i)
                    {
                        uint32 spellId, cd, catCd; uint16 itemId, category;
                        p >> spellId >> itemId >> category >> cd >> catCd;
                        if (!firstCd) cds += ',';
                        firstCd = false;
                        cds += Json::Writer().Add("spellId", spellId).Add("itemId", (uint32)itemId)
                            .Add("category", (uint32)category).Add("cooldownMs", cd).Add("categoryCooldownMs", catCd).Str();
                    }
                    cds += "]";
                    w.Raw("spells", spells).Raw("cooldowns", cds);
                    break;
                }
                case SMSG_LEARNED_SPELL:
                {
                    name = "SMSG_LEARNED_SPELL";
                    uint32 spellId; p >> spellId;
                    w.Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    break;
                }
                case SMSG_REMOVED_SPELL:
                {
                    name = "SMSG_REMOVED_SPELL";
                    uint32 spellId; p >> spellId;
                    w.Add("spellId", spellId);
                    break;
                }
                case SMSG_SUPERCEDED_SPELL:
                {
                    // Player::addSpell: the old (lower-rank) id, then the new
                    // one that replaces it in the spellbook.
                    name = "SMSG_SUPERCEDED_SPELL";
                    uint32 oldId, newId; p >> oldId >> newId;
                    w.Add("supersededSpellId", oldId).Add("spellId", newId);
                    AddSpellFields(w, newId);
                    break;
                }
                case SMSG_SPELL_COOLDOWN:
                {
                    // Unit::BuildCooldownPacket: u64 guid, u8 flags (1 =
                    // include GCD), then (u32 spellId, u32 cooldownMs) pairs.
                    name = "SMSG_SPELL_COOLDOWN";
                    uint64 guid; uint8 flags; p >> guid >> flags;
                    std::string cds = "[";
                    bool first = true;
                    while (p.rpos() + 8 <= p.size())
                    {
                        uint32 spellId, cd; p >> spellId >> cd;
                        if (!first) cds += ',';
                        first = false;
                        cds += Json::Writer().Add("spellId", spellId).Add("cooldownMs", cd).Str();
                    }
                    cds += "]";
                    w.AddGuid("guid", (uint64_t)guid).Add("flags", (uint32)flags).Raw("cooldowns", cds);
                    break;
                }
                case SMSG_COOLDOWN_EVENT:
                {
                    // Player::SendCooldownEvent: the client starts the
                    // cooldown timer it already knows for this spell.
                    name = "SMSG_COOLDOWN_EVENT";
                    uint32 spellId; uint64 guid; p >> spellId >> guid;
                    w.Add("spellId", spellId).AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_CLEAR_COOLDOWN:
                {
                    name = "SMSG_CLEAR_COOLDOWN";
                    uint32 spellId; uint64 guid; p >> spellId >> guid;
                    w.Add("spellId", spellId).AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_TALENTS_INFO:
                {
                    // Player::BuildPlayerTalentsInfoData (pet variant is
                    // served as { pet: true } only; the pet bar itself is SMSG_PET_SPELLS):
                    // u32 unspent, u8 specCount, u8 activeSpec, per spec: u8
                    // talentCount, (u32 talentId, u8 rank) x count, u8
                    // glyphCount, u16 x glyphCount.
                    name = "SMSG_TALENTS_INFO";
                    uint8 pet; p >> pet;
                    if (pet)
                    {
                        w.Add("pet", true);
                        break;
                    }
                    uint32 unspent; uint8 specCount, activeSpec;
                    p >> unspent >> specCount >> activeSpec;
                    std::string specs = "[";
                    for (uint8 si = 0; si < specCount && si < 2; ++si)
                    {
                        uint8 talentCount; p >> talentCount;
                        std::string talents = "[";
                        for (uint8 ti = 0; ti < talentCount; ++ti)
                        {
                            uint32 talentId; uint8 rank; p >> talentId >> rank;
                            if (ti) talents += ',';
                            talents += Json::Writer().Add("talentId", talentId).Add("rank", (uint32)rank).Str();
                        }
                        talents += "]";
                        uint8 glyphCount; p >> glyphCount;
                        for (uint8 gi = 0; gi < glyphCount; ++gi) { uint16 g; p >> g; }
                        if (si) specs += ',';
                        specs += Json::Writer().Raw("talents", talents).Str();
                    }
                    specs += "]";
                    w.Add("pet", false).Add("unspentPoints", unspent).Add("specCount", (uint32)specCount)
                     .Add("activeSpec", (uint32)activeSpec).Raw("specs", specs);
                    break;
                }
                // ----------------------------------- achievements and taxi
                case SMSG_ACHIEVEMENT_EARNED:
                {
                    // AchievementMgr::SendAchievementEarned: packGUID earner,
                    // u32 id, u32 packed date, u32 0. Broadcast to everyone
                    // in say range, so `guid` may be another player; the
                    // client shows those as chat-frame lines too.
                    name = "SMSG_ACHIEVEMENT_EARNED";
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint32 id = 0, date = 0; p >> id >> date;
                    w.AddGuid("guid", (uint64_t)guid).Add("self", ws && ws->GetPlayer() && ws->GetPlayer()->GetGUID().GetRawValue() == guid)
                     .Raw("achievement", AchievementJson(id, date));
                    break;
                }
                case SMSG_ALL_ACHIEVEMENT_DATA:
                {
                    // AchievementMgr::BuildAllDataPacket, sent to self at
                    // login: (u32 id, u32 packed date)* then 0xFFFFFFFF, then
                    // the criteria-progress block to a second 0xFFFFFFFF.
                    // Only the completed block is served; criteria progress is
                    // not decoded.
                    name = "SMSG_ALL_ACHIEVEMENT_DATA";
                    std::string list = "[";
                    bool first = true;
                    uint32 count = 0;
                    while (p.rpos() + 4 <= p.size())
                    {
                        uint32 id; p >> id;
                        if (id == 0xFFFFFFFF) break;
                        uint32 date; p >> date;
                        if (!first) list += ',';
                        first = false;
                        list += AchievementJson(id, date);
                        ++count;
                    }
                    list += "]";
                    w.Add("count", count).Raw("achievements", list);
                    break;
                }
                case SMSG_ACTIVATETAXIREPLY:
                {
                    // WorldSession::SendActivateTaxiReply: u32 ActivateTaxiReply
                    // (0 ok; 1 server error, 2 no such path, 3 not enough
                    // money, 4 too far away, 5 no vendor nearby, 6 not
                    // visited, 7 busy, 8 mounted, 9 shapeshifted, 10 moving,
                    // 11 same node, 12 not standing). 0 means the flight is
                    // starting; the ride itself shows as `taxiFlight` on self.
                    name = "SMSG_ACTIVATETAXIREPLY";
                    uint32 reply = 0; p >> reply;
                    w.Add("reply", reply).Add("ok", reply == 0);
                    break;
                }
                case SMSG_SHOWTAXINODES:
                {
                    // WorldSession::SendTaxiMenu: u32 1 (show window), u64
                    // flight master guid, u32 current node, then the taximask
                    // (TaxiMaskSize = 14 u32; node n is bit (n-1)%32 of word
                    // (n-1)/32). Sent when the taxi gossip option is chosen —
                    // the client never asks for it any other way. `known` is
                    // the mask decoded, with the name a client reads from its
                    // own TaxiNodes.dbc; nothing about routes or fares is here
                    // (the client learns those only by asking to fly).
                    name = "SMSG_SHOWTAXINODES";
                    uint32 show = 0; uint64 guid = 0; uint32 cur = 0;
                    p >> show >> guid >> cur;
                    std::string mask = "[", known = "[";
                    bool firstKnown = true;
                    for (uint32 word = 0; word < 14 && p.rpos() + 4 <= p.size(); ++word)
                    {
                        uint32 bits; p >> bits;
                        if (word) mask += ',';
                        mask += std::to_string(bits);
                        for (uint32 bit = 0; bit < 32; ++bit)
                        {
                            if (!(bits & (1u << bit))) continue;
                            uint32 node = word * 32 + bit + 1;
                            if (!firstKnown) known += ',';
                            firstKnown = false;
                            Json::Writer n;
                            n.Add("nodeId", node);
                            auto it = _taxiNodes.find(node);
                            if (it != _taxiNodes.end())
                                n.Add("name", it->second.name);
                            known += n.Str();
                        }
                    }
                    mask += "]"; known += "]";
                    w.Add("showWindow", show == 1).AddGuid("guid", (uint64_t)guid).Add("currentNode", cur);
                    auto curIt = _taxiNodes.find(cur);
                    if (curIt != _taxiNodes.end())
                        w.Add("currentNodeName", curIt->second.name);
                    w.Raw("mask", mask).Raw("known", known);
                    break;
                }
                // -------------------------------------------- reputation
                case SMSG_INITIALIZE_FACTIONS:
                {
                    // ReputationMgr::SendInitialReputations: u32 count (128),
                    // then per reputation index: u8 flags, u32 standing. Sent
                    // once during login. Only indices the server has a row for
                    // (non-zero flags or standing) are served; the position is
                    // the client's key into its own Faction.dbc.
                    name = "SMSG_INITIALIZE_FACTIONS";
                    uint32 count; p >> count;
                    if (count > 256) throw ByteBufferException();
                    Player* pl = ws->GetPlayer();
                    std::string factions = "[";
                    bool first = true;
                    for (uint32 i = 0; i < count; ++i)
                    {
                        uint8 flags; int32 standing; p >> flags >> standing;
                        if (!flags && !standing) continue;
                        if (!first) factions += ',';
                        first = false;
                        Json::Writer fw;
                        fw.Add("flags", (uint32)flags).Add("visible", (flags & 0x01) != 0).Add("atWar", (flags & 0x02) != 0);
                        std::string body = FactionJson(i, standing, pl);
                        // merge: FactionJson's object minus its braces
                        std::string merged = fw.Str();
                        merged.pop_back();
                        merged += "," + body.substr(1);
                        factions += merged;
                    }
                    factions += "]";
                    w.Add("count", count).Raw("factions", factions);
                    break;
                }
                case SMSG_SET_FACTION_STANDING:
                {
                    // ReputationMgr::SendState: f32 (refer-a-friend bonus,
                    // unused), u8 showVisual (the "reputation increased"
                    // chat line), u32 count, then (u32 repListId, u32
                    // standing) x count — every faction whose standing
                    // changed since the last send.
                    name = "SMSG_SET_FACTION_STANDING";
                    float bonus; uint8 show; uint32 count;
                    p >> bonus >> show >> count;
                    if (count > 256) throw ByteBufferException();
                    Player* pl = ws->GetPlayer();
                    std::string factions = "[";
                    for (uint32 i = 0; i < count; ++i)
                    {
                        uint32 repListId; int32 standing; p >> repListId >> standing;
                        if (i) factions += ',';
                        factions += FactionJson(repListId, standing, pl);
                    }
                    factions += "]";
                    w.Add("showVisual", show != 0).Raw("factions", factions);
                    break;
                }
                case SMSG_SET_FACTION_VISIBLE:
                {
                    // ReputationMgr::SendVisible: u32 repListId — the faction
                    // appears in the client's reputation pane from now on.
                    name = "SMSG_SET_FACTION_VISIBLE";
                    uint32 repListId; p >> repListId;
                    w.Add("repListId", repListId);
                    auto it = _repListToFaction.find(repListId);
                    if (it != _repListToFaction.end())
                    {
                        w.Add("factionId", it->second);
                        if (FactionEntry const* fe = sFactionStore.LookupEntry(it->second))
                            if (fe->name[0])
                                w.Add("name", fe->name[0]);
                    }
                    break;
                }
                // ------------------------------------------------ respec
                case MSG_TALENT_WIPE_CONFIRM:
                {
                    // Player::SendTalentWipeConfirm (u64 trainer guid, u32
                    // cost in copper) after the trainer's unlearn gossip
                    // option: the client shows "unlearn all talents for X?"
                    // and answers yes by echoing the opcode with the guid
                    // (raw). HandleTalentWipeConfirmOpcode answers a refusal
                    // (no talents to reset) with guid 0 and cost 0; success
                    // has no packet of its own — SMSG_TALENTS_INFO follows
                    // with every rank at 0 and the points back.
                    name = "MSG_TALENT_WIPE_CONFIRM";
                    uint64 guid = 0; uint32 cost = 0;
                    p >> guid >> cost;
                    w.AddGuid("guid", (uint64_t)guid).Add("cost", cost).Add("nothingToReset", guid == 0);
                    break;
                }
                // ------------------------------------------------- pets
                //. Everything below is what the client's pet
                // frame is drawn from; spell ids carry their Spell.dbc name
                // the way the spellbook rows do.
                case SMSG_PET_SPELLS:
                {
                    // Player::PetSpellInitialize (and the possess/charm/vehicle
                    // variants, same layout): u64 pet guid — 0 alone means
                    // "remove the control bar" (Player::SendRemoveControlBar)
                    // — then u16 creature family, u32 duration ms (0 =
                    // permanent), u8 react state, u8 command state, u16 flags,
                    // 10 x u32 action bar buttons (action | type << 24), u8
                    // spell count + u32 per spell (spellId | active << 24), u8
                    // cooldown count + (u32 spellId, u16 category, u32
                    // cooldownMs, u32 categoryCooldownMs) per cooldown.
                    name = "SMSG_PET_SPELLS";
                    uint64 guid; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    if (!guid)
                    {
                        w.Add("removed", true);
                        break;
                    }
                    uint16 family; uint32 duration; uint8 react, command; uint16 flags;
                    p >> family >> duration >> react >> command >> flags;
                    w.Add("removed", false).Add("family", (uint32)family).Add("durationMs", duration)
                     .Add("reactState", (uint32)react).Add("commandState", (uint32)command).Add("flags", (uint32)flags);
                    std::string bar = "[";
                    for (uint32 i = 0; i < 10; ++i)
                    {
                        uint32 packed; p >> packed;
                        uint32 action = packed & 0x00FFFFFF;
                        uint32 type = packed >> 24;
                        if (i) bar += ',';
                        Json::Writer b;
                        b.Add("slot", i).Add("type", type);
                        if (type == 0x07)                       // ACT_COMMAND: stay/follow/attack/abandon
                            b.Add("command", action);
                        else if (type == 0x06)                  // ACT_REACTION: passive/defensive/aggressive
                            b.Add("reaction", action);
                        else if (action)                        // a spell button (0x01 passive, 0x81 castable, 0xC1 autocast)
                        {
                            b.Add("spellId", action).Add("autocast", type == 0xC1);
                            AddSpellFields(b, action);
                        }
                        bar += b.Str();
                    }
                    bar += "]";
                    uint8 spellCount; p >> spellCount;
                    std::string spells = "[";
                    for (uint8 i = 0; i < spellCount; ++i)
                    {
                        uint32 packed; p >> packed;
                        uint32 spellId = packed & 0x00FFFFFF;
                        uint32 active = packed >> 24;
                        if (i) spells += ',';
                        Json::Writer sp;
                        sp.Add("spellId", spellId).Add("active", active).Add("autocast", active == 0xC1);
                        AddSpellFields(sp, spellId);
                        spells += sp.Str();
                    }
                    spells += "]";
                    uint8 cdCount; p >> cdCount;
                    std::string cds = "[";
                    for (uint8 i = 0; i < cdCount; ++i)
                    {
                        uint32 spellId, cd, catCd; uint16 category;
                        p >> spellId >> category >> cd >> catCd;
                        if (i) cds += ',';
                        cds += Json::Writer().Add("spellId", spellId).Add("category", (uint32)category)
                            .Add("cooldownMs", cd).Add("categoryCooldownMs", catCd).Str();
                    }
                    cds += "]";
                    w.Raw("actionBar", bar).Raw("spells", spells).Raw("cooldowns", cds);
                    break;
                }
                case SMSG_PET_ACTION_FEEDBACK:
                {
                    // Unit::SendPetActionFeedback: u8 (ActionFeedback: 1 pet
                    // dead, 2 nothing to attack, 3 can't attack target).
                    name = "SMSG_PET_ACTION_FEEDBACK";
                    uint8 msg; p >> msg;
                    w.Add("feedback", (uint32)msg);
                    break;
                }
                case SMSG_PET_TAME_FAILURE:
                {
                    // Unit::SendTameFailure: u8 PetTameFailure.
                    name = "SMSG_PET_TAME_FAILURE";
                    uint8 result; p >> result;
                    w.Add("result", (uint32)result);
                    break;
                }
                case SMSG_PET_CAST_FAILED:
                {
                    // Spell::SendPetCastResult: the SMSG_CAST_FAILED layout
                    // (u8 cast count, u32 spell, u8 SpellCastResult) for a
                    // spell the pet was told to cast.
                    name = "SMSG_PET_CAST_FAILED";
                    uint8 castCount; uint32 spellId; uint8 result;
                    p >> castCount >> spellId >> result;
                    w.Add("spellId", spellId).Add("result", (uint32)result);
                    AddSpellFields(w, spellId);
                    break;
                }
                case SMSG_PET_NAME_QUERY_RESPONSE:
                {
                    // WorldSession::SendPetNameQuery: u32 pet number, cstring
                    // name, u32 name timestamp, u8 declined (+5 cstrings). The
                    // not-found form is the same bytes with an empty name and
                    // zeros. The module asked on the client's behalf when a
                    // unit with a pet number came into view; the SDK joins the
                    // number back to that unit.
                    name = "SMSG_PET_NAME_QUERY_RESPONSE";
                    uint32 petNumber; std::string petName; uint32 stamp;
                    p >> petNumber >> petName >> stamp;
                    w.Add("petNumber", petNumber).Add("found", !petName.empty());
                    if (!petName.empty())
                        w.Add("name", petName);
                    break;
                }
                case SMSG_PET_NAME_INVALID:
                {
                    // WorldSession::SendPetNameInvalid: u32 PetNameInvalidReason,
                    // cstring the name that was refused.
                    name = "SMSG_PET_NAME_INVALID";
                    uint32 error; std::string petName;
                    p >> error >> petName;
                    w.Add("reason", error).Add("name", petName);
                    break;
                }
                // ------------------------------------------------ group
                //. Group::SendUpdateToPlayer and the
                // GroupHandler replies; codes are the core's PartyResult /
                // PartyOperation, named by the SDK.
                case SMSG_GROUP_INVITE:
                {
                    // u8 canAccept (1 = an invitation; 0 = "you were invited
                    // but are already grouped" notice), cstring inviter, u32,
                    // u8 count, u32.
                    name = "SMSG_GROUP_INVITE";
                    uint8 canAccept; std::string inviter;
                    p >> canAccept >> inviter;
                    w.Add("canAccept", canAccept != 0).Add("inviterName", inviter);
                    break;
                }
                case SMSG_GROUP_DECLINE:
                {
                    name = "SMSG_GROUP_DECLINE";
                    std::string who; p >> who;
                    w.Add("name", who);
                    break;
                }
                case SMSG_GROUP_SET_LEADER:
                {
                    name = "SMSG_GROUP_SET_LEADER";
                    std::string who; p >> who;
                    w.Add("name", who);
                    break;
                }
                case SMSG_GROUP_UNINVITE:
                    // Bodiless: this character was removed from the group.
                    name = "SMSG_GROUP_UNINVITE";
                    break;
                case SMSG_GROUP_DESTROYED:
                    name = "SMSG_GROUP_DESTROYED";
                    break;
                case SMSG_PARTY_COMMAND_RESULT:
                {
                    // WorldSession::SendPartyResult: u32 operation (0 invite,
                    // 1 uninvite, 2 leave, 4 swap), cstring member name, u32
                    // PartyResult (0 ok), u32 lfg value.
                    name = "SMSG_PARTY_COMMAND_RESULT";
                    uint32 op; std::string member; uint32 result, val;
                    p >> op >> member >> result >> val;
                    w.Add("operation", op).Add("name", member).Add("result", result).Add("value", val);
                    break;
                }
                case SMSG_GROUP_LIST:
                {
                    // Group::SendUpdateToPlayer: u8 group type flags, u8 own
                    // subgroup, u8 own member flags, u8 own lfg roles, [lfg
                    // groups: u8 state, u32 dungeon], u64 group guid, u32
                    // counter, u32 other-member count, per member: cstring
                    // name, u64 guid, u8 online flags, u8 subgroup, u8 flags,
                    // u8 roles; u64 leader guid; when there are other
                    // members: u8 loot method, u64 looter guid, u8 loot
                    // threshold, u8 dungeon difficulty, u8 raid difficulty,
                    // u8 dynamic difficulty. The "you left" form is group
                    // type 0x10 with no members and a zero leader.
                    name = "SMSG_GROUP_LIST";
                    uint8 groupType, subGroup, memberFlags, roles;
                    p >> groupType >> subGroup >> memberFlags >> roles;
                    if (groupType & 0x08)
                        { uint8 st; uint32 dungeon; p >> st >> dungeon; }
                    uint64 groupGuid; uint32 counter, count;
                    p >> groupGuid >> counter >> count;
                    if (count > 40) throw ByteBufferException();
                    std::string members = "[";
                    for (uint32 i = 0; i < count; ++i)
                    {
                        std::string mname; uint64 mguid; uint8 online, mgroup, mflags, mroles;
                        p >> mname >> mguid >> online >> mgroup >> mflags >> mroles;
                        if (i) members += ',';
                        members += Json::Writer().Add("name", mname).AddGuid("guid", (uint64_t)mguid)
                            .Add("online", (online & 0x01) != 0).Add("subGroup", (uint32)mgroup)
                            .Add("flags", (uint32)mflags).Add("roles", (uint32)mroles).Str();
                    }
                    members += "]";
                    uint64 leader; p >> leader;
                    w.Add("groupType", (uint32)groupType).Add("left", (groupType & 0x10) != 0)
                     .Add("raid", (groupType & 0x02) != 0).Add("subGroup", (uint32)subGroup)
                     .Add("memberFlags", (uint32)memberFlags).Add("roles", (uint32)roles)
                     .AddGuid("groupGuid", (uint64_t)groupGuid).Add("counter", counter)
                     .Raw("members", members).AddGuid("leaderGuid", (uint64_t)leader);
                    if (count)
                    {
                        uint8 lootMethod; uint64 looter; uint8 threshold, dungeonDiff, raidDiff, dynDiff;
                        p >> lootMethod >> looter >> threshold >> dungeonDiff >> raidDiff >> dynDiff;
                        w.Add("lootMethod", (uint32)lootMethod).AddGuid("looterGuid", (uint64_t)looter)
                         .Add("lootThreshold", (uint32)threshold).Add("dungeonDifficulty", (uint32)dungeonDiff)
                         .Add("raidDifficulty", (uint32)raidDiff);
                    }
                    break;
                }
                // ------------------------------------------------- mail
                //. MailHandler / Player::SendMailResult.
                case SMSG_SHOW_MAILBOX:
                {
                    // WorldSession::SendShowMailBox: u64 mailbox guid — the
                    // mailbox frame opens (after CMSG_GAMEOBJ_USE on one).
                    name = "SMSG_SHOW_MAILBOX";
                    uint64 guid; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_RECEIVED_MAIL:
                    // Player::SendNewMail: u32 0 — "you have new mail".
                    name = "SMSG_RECEIVED_MAIL";
                    break;
                case SMSG_SEND_MAIL_RESULT:
                {
                    // Player::SendMailResult: u32 mail id, u32 action
                    // (MailResponseType: 0 send, 1 money taken, 2 item taken,
                    // 3 returned, 4 deleted, 5 made permanent), u32 result
                    // (MailResponseResult: 0 ok), then u32 InventoryResult
                    // when result is 1 (equip error), or (u32 item guid low,
                    // u32 count) when an item was taken.
                    name = "SMSG_SEND_MAIL_RESULT";
                    uint32 mailId, action, result;
                    p >> mailId >> action >> result;
                    w.Add("mailId", mailId).Add("action", action).Add("result", result);
                    if (result == 1)
                        { uint32 eq; p >> eq; w.Add("inventoryResult", eq); }
                    else if (action == 2)
                    {
                        uint32 itemLow, count; p >> itemLow >> count;
                        w.Add("itemGuidLow", itemLow).Add("count", count);
                    }
                    break;
                }
                case SMSG_MAIL_LIST_RESULT:
                {
                    // WorldSession::HandleGetMailList: u32 total mails, u8
                    // listed mails; per mail: u16 size, u32 id, u8 type (0
                    // player: u64 sender guid; else u32 sender entry / id),
                    // u32 COD, u32, u32 stationery, u32 money, u32 flags
                    // (1 read, 4 returned, 8 COD payment), f32 days left,
                    // u32 template, cstring subject, cstring body, u8 item
                    // count; per item: u8 index, u32 item guid low, u32 entry,
                    // 7 x (u32 enchant id, u32 duration, u32 charges), i32
                    // random property, u32 suffix factor, u32 count, u32
                    // charges, u32 max durability, u32 durability, u8.
                    name = "SMSG_MAIL_LIST_RESULT";
                    uint32 total; uint8 count;
                    p >> total >> count;
                    std::string mails = "[";
                    for (uint8 i = 0; i < count; ++i)
                    {
                        uint16 size; uint32 mailId; uint8 type;
                        p >> size >> mailId >> type;
                        Json::Writer m;
                        m.Add("mailId", mailId).Add("type", (uint32)type);
                        if (type == 0)
                            { uint64 sender; p >> sender; m.AddGuid("senderGuid", (uint64_t)sender); }
                        else
                            { uint32 sender; p >> sender; m.Add("senderId", sender); }
                        uint32 cod, unk, stationery, money, flags, templ; float days;
                        p >> cod >> unk >> stationery >> money >> flags >> days >> templ;
                        std::string subject, body; uint8 itemCount;
                        p >> subject >> body >> itemCount;
                        if (itemCount > 16) throw ByteBufferException();
                        std::string items = "[";
                        for (uint8 k = 0; k < itemCount; ++k)
                        {
                            uint8 idx; uint32 itemLow, entry;
                            p >> idx >> itemLow >> entry;
                            for (int e = 0; e < 7; ++e) { uint32 a, b, c; p >> a >> b >> c; }
                            int32 randProp; uint32 suffix, cnt, charges, maxDur, dur; uint8 tail;
                            p >> randProp >> suffix >> cnt >> charges >> maxDur >> dur >> tail;
                            if (k) items += ',';
                            items += Json::Writer().Add("index", (uint32)idx).Add("itemGuidLow", itemLow)
                                .Add("itemId", entry).Add("count", cnt).Str();
                            if (entry) itemEntries.push_back(entry);
                        }
                        items += "]";
                        m.Add("cod", cod).Add("stationery", stationery).Add("money", money).Add("flags", flags)
                         .Add("read", (flags & 0x01) != 0).Add("daysLeft", (double)days).Add("templateId", templ)
                         .Add("subject", subject).Add("body", body).Raw("items", items);
                        if (i) mails += ',';
                        mails += m.Str();
                    }
                    mails += "]";
                    w.Add("total", total).Add("count", (uint32)count).Raw("mails", mails);
                    break;
                }
                // ------------------------------------------------- bank
                //. The slots themselves are the PLAYER_FIELD_
                // BANK_SLOT_1 / BANKBAG_SLOT_1 update fields (invSlot39-73).
                case SMSG_SHOW_BANK:
                {
                    // WorldSession::SendShowBank: u64 banker guid — the bank
                    // frame opens (after CMSG_BANKER_ACTIVATE or a banker's
                    // gossip option).
                    name = "SMSG_SHOW_BANK";
                    uint64 guid; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_BUY_BANK_SLOT_RESULT:
                {
                    // u32 BuyBankSlotResult (0 failed too many, 1 insufficient
                    // funds, 2 not a banker, 3 ok).
                    name = "SMSG_BUY_BANK_SLOT_RESULT";
                    uint32 result; p >> result;
                    w.Add("result", result);
                    break;
                }
                // ------------------------------------------------ trade
                //. TradeHandler.
                case SMSG_TRADE_STATUS:
                {
                    // WorldSession::SendTradeStatus: u32 TradeStatus, then per
                    // status: 1 begin -> u64 trader guid; 2 open window ->
                    // u32 trade id; 12 close window -> u32 InventoryResult,
                    // u8 is target's error, u32 limiting item; 22/23 -> u8 slot.
                    name = "SMSG_TRADE_STATUS";
                    uint32 status; p >> status;
                    w.Add("status", status);
                    switch (status)
                    {
                        case 1: { uint64 g; p >> g; w.AddGuid("traderGuid", (uint64_t)g); break; }
                        case 2: { uint32 id; p >> id; break; }
                        case 12:
                        {
                            uint32 res; uint8 target; uint32 item;
                            p >> res >> target >> item;
                            w.Add("inventoryResult", res).Add("targetError", target != 0);
                            if (item) w.Add("limitedItemId", item);
                            break;
                        }
                        case 22: case 23: { uint8 slot; p >> slot; w.Add("slot", (uint32)slot); break; }
                        default: break;
                    }
                    break;
                }
                case SMSG_TRADE_STATUS_EXTENDED:
                {
                    // WorldSession::SendUpdateTrade: u8 whose (1 = the other
                    // trader's side, 0 = own), u32 trade id, u32 slot count,
                    // u32 slot count, u32 money, u32 spell cast on the
                    // enchant slot; 7 x (u8 slot, then either an item — u32
                    // entry, u32 display, u32 count, u32 wrapped, u64 gift
                    // creator, u32 enchant, 3 x u32 gems, u64 creator, u32
                    // charges, u32 suffix, i32 random property, u32 lock, u32
                    // max durability, u32 durability — or 18 zero u32s).
                    // Slot 6 is the "will not be traded" enchant slot.
                    name = "SMSG_TRADE_STATUS_EXTENDED";
                    uint8 whose; uint32 tradeId, slots, slots2, money, spell;
                    p >> whose >> tradeId >> slots >> slots2 >> money >> spell;
                    if (slots > 7) throw ByteBufferException();
                    std::string items = "[";
                    bool firstItem = true;
                    for (uint32 i = 0; i < slots; ++i)
                    {
                        uint8 slot; uint32 entry, display, count, wrapped; uint64 gift;
                        p >> slot >> entry >> display >> count >> wrapped >> gift;
                        uint32 ench, g1, g2, g3; uint64 creator; uint32 charges, suffix; int32 randProp; uint32 lock, maxDur, dur;
                        p >> ench >> g1 >> g2 >> g3 >> creator >> charges >> suffix >> randProp >> lock >> maxDur >> dur;
                        if (!entry) continue;
                        if (!firstItem) items += ',';
                        firstItem = false;
                        items += Json::Writer().Add("slot", (uint32)slot).Add("itemId", entry).Add("count", count)
                            .Add("wrapped", wrapped != 0).Str();
                        itemEntries.push_back(entry);
                    }
                    items += "]";
                    w.Add("theirs", whose != 0).Add("money", money).Add("spellId", spell).Raw("items", items);
                    break;
                }
                // ----------------------------------------- innkeeper bind
                case SMSG_BINDER_CONFIRM:
                {
                    // Player::SetBindPoint: u64 innkeeper guid. The answer to
                    // the "Make this inn your home" gossip option; a client
                    // shows a yes/no dialog and sends CMSG_BINDER_ACTIVATE
                    // (raw) on yes.
                    name = "SMSG_BINDER_CONFIRM";
                    uint64 guid = 0; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_BINDPOINTUPDATE:
                {
                    // Spell::EffectBind / Player login: f32 x, y, z, u32 map,
                    // u32 areaId — the hearthstone's destination. Once during
                    // login and again after every bind. `areaName` is the
                    // client's AreaTable.dbc text for the id ("" when unknown).
                    name = "SMSG_BINDPOINTUPDATE";
                    float x, y, z; uint32 map, areaId;
                    p >> x >> y >> z >> map >> areaId;
                    auto it = _areaTable.find(areaId);
                    w.Add("x", (double)x).Add("y", (double)y).Add("z", (double)z)
                     .Add("map", map).Add("areaId", areaId)
                     .Add("areaName", it == _areaTable.end() ? std::string() : it->second.name);
                    break;
                }
                case SMSG_PLAYERBOUND:
                {
                    // Spell::EffectBind: u64 binder guid, u32 areaId — the
                    // "Your home is now X" line a client prints after a bind.
                    name = "SMSG_PLAYERBOUND";
                    uint64 guid = 0; uint32 areaId = 0;
                    p >> guid >> areaId;
                    auto it = _areaTable.find(areaId);
                    w.AddGuid("guid", (uint64_t)guid).Add("areaId", areaId)
                     .Add("areaName", it == _areaTable.end() ? std::string() : it->second.name);
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
                case SMSG_QUESTGIVER_STATUS_MULTIPLE:
                {
                    // Player::SendQuestGiverStatusMultiple: u32 count, then
                    // (u64 guid, u8 status) per questgiver in view. Sent by the
                    // core on login, level-up and quest reward, and in answer
                    // to CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY.
                    name = "SMSG_QUESTGIVER_STATUS_MULTIPLE";
                    uint32 count; p >> count;
                    std::string statuses = "[";
                    for (uint32 i = 0; i < count; ++i)
                    {
                        uint64 guid; uint8 status;
                        p >> guid >> status;
                        if (i) statuses += ',';
                        statuses += Json::Writer().AddGuid("guid", (uint64_t)guid).Add("status", (uint32)status).Str();
                    }
                    statuses += "]";
                    w.Raw("statuses", statuses);
                    break;
                }
                case SMSG_QUEST_QUERY_RESPONSE:
                {
                    // PlayerMenu::SendQuestQueryResponse (3.3.5a layout; field
                    // order cited in PROTOCOL.md). Only what the client's quest
                    // log renders is named: title/objective text, level, and
                    // the per-objective required entries and counts. Rewards
                    // are skipped over (they arrive on QUEST_DETAILS /
                    // OFFER_REWARD when the client asks for them).
                    name = "SMSG_QUEST_QUERY_RESPONSE";
                    uint32 questId, method; int32 level; uint32 minLevel, zoneOrSort, type, suggested;
                    p >> questId >> method >> level >> minLevel >> zoneOrSort >> type >> suggested;
                    uint32 repFaction, repValue, repFaction2, repValue2, nextQuest, xpId;
                    p >> repFaction >> repValue >> repFaction2 >> repValue2 >> nextQuest >> xpId;
                    uint32 rewMoney, rewMoneyMaxLevel, rewSpell; int32 rewSpellCast;
                    p >> rewMoney >> rewMoneyMaxLevel >> rewSpell >> rewSpellCast;
                    uint32 honorAdd; float honorMult; uint32 srcItem, flags, titleId, playersSlain, bonusTalents, arenaPoints, repMask;
                    p >> honorAdd >> honorMult >> srcItem >> flags >> titleId >> playersSlain >> bonusTalents >> arenaPoints >> repMask;
                    // QUEST_REWARDS_COUNT (4) + QUEST_REWARD_CHOICES_COUNT (6) item/count pairs
                    for (int i = 0; i < 4 + 6; ++i) { uint32 a, b; p >> a >> b; }
                    // QUEST_REPUTATIONS_COUNT (5) x3 (faction id, value id, override)
                    for (int i = 0; i < 5 * 3; ++i) { uint32 a; p >> a; }
                    uint32 poiContinent; float poiX, poiY; uint32 pointOpt;
                    p >> poiContinent >> poiX >> poiY >> pointOpt;
                    std::string title, objectives, details, areaDescription, completedText;
                    p >> title >> objectives >> details >> areaDescription >> completedText;
                    // QUEST_OBJECTIVES_COUNT (4): required npc-or-go (go as id|0x80000000), count, item drop, 0
                    uint32 reqEntry[4], reqCount[4];
                    for (int i = 0; i < 4; ++i)
                    {
                        uint32 itemDrop, unk;
                        p >> reqEntry[i] >> reqCount[i] >> itemDrop >> unk;
                    }
                    // QUEST_ITEM_OBJECTIVES_COUNT (6): required item id, count
                    std::string reqItems = "[";
                    for (int i = 0; i < 6; ++i)
                    {
                        uint32 itemId, cnt; p >> itemId >> cnt;
                        if (i) reqItems += ',';
                        reqItems += Json::Writer().Add("itemId", itemId).Add("count", cnt).Str();
                        if (itemId)
                            itemEntries.push_back(itemId);
                    }
                    reqItems += "]";
                    std::string reqNpcOrGo = "[";
                    for (int i = 0; i < 4; ++i)
                    {
                        std::string text; p >> text;
                        if (i) reqNpcOrGo += ',';
                        reqNpcOrGo += Json::Writer().Add("entry", reqEntry[i]).Add("count", reqCount[i])
                            .Add("text", text).Str();
                    }
                    reqNpcOrGo += "]";
                    w.Add("questId", questId).Add("method", method).Add("level", level).Add("minLevel", minLevel)
                     .Add("type", type).Add("suggestedPlayers", suggested)
                     .Add("title", title).Add("objectives", objectives).Add("details", details)
                     .Add("areaDescription", areaDescription).Add("completedText", completedText)
                     .Raw("requiredNpcOrGo", reqNpcOrGo).Raw("requiredItems", reqItems);
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
                        // A solo looter's slots arrive as LOOT_SLOT_TYPE_OWNER,
                        // not ALLOW_LOOT: the core marks every slot OWNER when
                        // the looter owns the corpse outright (LootMgr.cpp,
                        // PERMISSION_OWNER). Gating on ALLOW_LOOT alone meant
                        // solo auto-loot released the window without storing a
                        // single item (morning-opus-1). MASTER, ROLL_ONGOING
                        // and LOCKED stay excluded deliberately: they are
                        // group-distribution states a client cannot auto-store
                        // from, and this benchmark is solo.
                        if (slotType == LOOT_SLOT_TYPE_ALLOW_LOOT || slotType == LOOT_SLOT_TYPE_OWNER)
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
                // ------------------------------------------- group loot rolls
                //. Group::SendLootStartRoll and friends: a
                // roll is keyed by a fresh item guid the core mints for it
                // (`rollGuid`), not by the loot slot alone.
                case SMSG_LOOT_START_ROLL:
                {
                    // u64 roll guid, u32 map, u32 loot slot, u32 item entry,
                    // u32 random suffix, u32 random property, u32 count, u32
                    // countdown ms, u8 vote mask (1 need, 2 greed, 4
                    // disenchant; pass is always allowed). The per-player form
                    // (SendLootStartRollToPlayer) drops the need bit when this
                    // character cannot need.
                    name = "SMSG_LOOT_START_ROLL";
                    uint64 rollGuid; uint32 mapId, slot, itemId, suffix, prop, count, countdown; uint8 mask;
                    p >> rollGuid >> mapId >> slot >> itemId >> suffix >> prop >> count >> countdown >> mask;
                    w.AddGuid("rollGuid", (uint64_t)rollGuid).Add("slot", slot).Add("itemId", itemId)
                     .Add("count", count).Add("countdownMs", countdown).Add("voteMask", (uint32)mask)
                     .Add("canNeed", (mask & 0x01) != 0).Add("canGreed", (mask & 0x02) != 0)
                     .Add("canDisenchant", (mask & 0x04) != 0);
                    itemEntries.push_back(itemId);
                    break;
                }
                case SMSG_LOOT_ROLL:
                {
                    // u64 roll guid, u32 slot, u64 player, u32 item entry, u32
                    // suffix, u32 property, u8 roll (1-100; 128 = passed), u8
                    // vote (0 pass, 1 need, 2 greed, 3 disenchant), u8 auto
                    // pass. One per counted vote, to every voter.
                    name = "SMSG_LOOT_ROLL";
                    uint64 rollGuid; uint32 slot; uint64 player; uint32 itemId, suffix, prop; uint8 roll, vote, autoPass;
                    p >> rollGuid >> slot >> player >> itemId >> suffix >> prop >> roll >> vote >> autoPass;
                    w.AddGuid("rollGuid", (uint64_t)rollGuid).Add("slot", slot).AddGuid("playerGuid", (uint64_t)player)
                     .Add("itemId", itemId).Add("roll", (uint32)roll).Add("rollType", (uint32)vote).Add("autoPass", autoPass != 0);
                    itemEntries.push_back(itemId);
                    break;
                }
                case SMSG_LOOT_ROLL_WON:
                {
                    // u64 roll guid, u32 slot, u32 item entry, u32 suffix, u32
                    // property, u64 winner, u8 winning roll, u8 vote.
                    name = "SMSG_LOOT_ROLL_WON";
                    uint64 rollGuid; uint32 slot, itemId, suffix, prop; uint64 winner; uint8 roll, vote;
                    p >> rollGuid >> slot >> itemId >> suffix >> prop >> winner >> roll >> vote;
                    w.AddGuid("rollGuid", (uint64_t)rollGuid).Add("slot", slot).Add("itemId", itemId)
                     .AddGuid("winnerGuid", (uint64_t)winner).Add("roll", (uint32)roll).Add("rollType", (uint32)vote);
                    itemEntries.push_back(itemId);
                    break;
                }
                case SMSG_LOOT_ALL_PASSED:
                {
                    // u64 roll guid, u32 slot, u32 item entry, u32 property, u32 suffix.
                    name = "SMSG_LOOT_ALL_PASSED";
                    uint64 rollGuid; uint32 slot, itemId, prop, suffix;
                    p >> rollGuid >> slot >> itemId >> prop >> suffix;
                    w.AddGuid("rollGuid", (uint64_t)rollGuid).Add("slot", slot).Add("itemId", itemId);
                    itemEntries.push_back(itemId);
                    break;
                }
                case SMSG_LOOT_MASTER_LIST:
                {
                    // Group::MasterLoot: u8 count, count x u64 — who the master
                    // looter may hand an over-threshold item to.
                    name = "SMSG_LOOT_MASTER_LIST";
                    uint8 count; p >> count;
                    if (count > 40) throw ByteBufferException();
                    std::string looters = "[";
                    for (uint8 i = 0; i < count; ++i)
                    {
                        uint64 g; p >> g;
                        if (i) looters += ',';
                        looters += Json::Writer().AddGuid("guid", (uint64_t)g).Str();
                    }
                    looters += "]";
                    w.Raw("looters", looters);
                    break;
                }
                // ------------------------------------------------ item text
                //. Two reading paths a client has: a book or
                // letter with a PageText id (CMSG_READ_ITEM -> SMSG_READ_ITEM_OK
                // -> the client's CMSG_PAGE_TEXT_QUERY on the template's page
                // id -> one SMSG_PAGE_TEXT_QUERY_RESPONSE per page, the core
                // walks the NextPage chain itself), and player-written text on
                // a mailed letter (CMSG_ITEM_TEXT_QUERY). The SDK sends the
                // page query the client would, keyed by the pageText it was
                // served on the item query.
                case SMSG_READ_ITEM_OK:
                {
                    name = "SMSG_READ_ITEM_OK";
                    uint64 guid; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_READ_ITEM_FAILED:
                {
                    // Same body; the equip error (SMSG_INVENTORY_CHANGE_FAILURE) precedes it.
                    name = "SMSG_READ_ITEM_FAILED";
                    uint64 guid; p >> guid;
                    w.AddGuid("guid", (uint64_t)guid);
                    break;
                }
                case SMSG_PAGE_TEXT_QUERY_RESPONSE:
                {
                    // WorldSession::HandlePageTextQueryOpcode: u32 page id,
                    // cstring text, u32 next page (0 = last). A missing page
                    // is served as the core's own "Item page missing." text.
                    name = "SMSG_PAGE_TEXT_QUERY_RESPONSE";
                    uint32 pageId; std::string text; uint32 next;
                    p >> pageId >> text >> next;
                    w.Add("pageId", pageId).Add("text", text).Add("nextPageId", next);
                    break;
                }
                case SMSG_ITEM_TEXT_QUERY_RESPONSE:
                {
                    // WorldSession::HandleItemTextQuery: u8 1 = no such item;
                    // else u8 0, u64 item guid, cstring text.
                    name = "SMSG_ITEM_TEXT_QUERY_RESPONSE";
                    uint8 noText; p >> noText;
                    w.Add("found", noText == 0);
                    if (noText == 0)
                    {
                        uint64 guid; std::string text;
                        p >> guid >> text;
                        w.AddGuid("guid", (uint64_t)guid).Add("text", text);
                    }
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
                // --------------------------------------------------- trainer
                // Field order follows WorldPackets::NPC::TrainerList::Write on
                // the pinned core (src/server/game/Server/Packets/NPCPackets.cpp).
                case SMSG_TRAINER_LIST:
                {
                    name = "SMSG_TRAINER_LIST";
                    uint64 guid; p >> guid;
                    int32 trainerType; p >> trainerType;  // Trainer::Type: 0 class, 1 mount, 2 tradeskill, 3 pet
                    int32 count; p >> count;
                    std::string spells = "[";
                    bool firstSpell = true;
                    for (int32 i = 0; i < count && p.rpos() < p.size(); ++i)
                    {
                        int32 spellId; p >> spellId;
                        // Trainer::SpellState, what the client colours the row
                        // with: 0 available (green, trainable now), 1
                        // unavailable (red — level, skill, prerequisite spell or
                        // class/race), 2 known (gray, already learned). Money is
                        // NOT part of this state: a green spell still fails to
                        // buy with reason 1 if the character cannot afford it.
                        uint8 state; p >> state;
                        int32 cost; p >> cost;              // copper, reputation discount already applied
                        p.rpos(p.rpos() + 8);               // PointCost[2]: talent points (always 0) + profession-slot flag
                        uint8 reqLevel; p >> reqLevel;
                        int32 reqSkill; p >> reqSkill;      // skill line id, 0 = none
                        int32 reqSkillValue; p >> reqSkillValue;
                        p.rpos(p.rpos() + 12);              // ReqAbility[3]: prerequisite spell ids, summarised by state
                        if (!firstSpell) spells += ',';
                        spells += Json::Writer().Add("spellId", spellId).Add("state", (uint32)state)
                            .Add("cost", cost).Add("reqLevel", (uint32)reqLevel)
                            .Add("reqSkill", reqSkill).Add("reqSkillValue", reqSkillValue).Str();
                        firstSpell = false;
                    }
                    spells += "]";
                    std::string greeting;
                    if (p.rpos() < p.size()) p >> greeting; // trainer window text
                    w.AddGuid("guid", (uint64_t)guid).Add("trainerType", trainerType)
                     .Raw("spells", spells).Add("greeting", greeting);
                    break;
                }
                case SMSG_TRAINER_BUY_SUCCEEDED:
                {
                    name = "SMSG_TRAINER_BUY_SUCCEEDED";
                    uint64 guid; p >> guid;
                    int32 spellId; p >> spellId;
                    w.AddGuid("guid", (uint64_t)guid).Add("spellId", spellId);
                    break;
                }
                case SMSG_TRAINER_BUY_FAILED:
                {
                    name = "SMSG_TRAINER_BUY_FAILED";
                    uint64 guid; p >> guid;
                    int32 spellId; p >> spellId;
                    // Trainer::FailReason: 0 unavailable (not on this trainer's
                    // list / not trainable), 1 not enough money, 2 not enough
                    // skill (also the catch-all for level and prerequisites).
                    int32 reason; p >> reason;
                    w.AddGuid("guid", (uint64_t)guid).Add("spellId", spellId).Add("reason", reason);
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
                case SMSG_GAMEOBJECT_QUERY_RESPONSE:
                {
                    // HandleGameObjectQueryOpcode: entry, type, displayId, name,
                    // 3 empty names, iconName, castBarCaption, unk1, then the
                    // 24 raw data u32s, size and quest items (template
                    // internals a client gets but the agent has no use for).
                    name = "SMSG_GAMEOBJECT_QUERY_RESPONSE";
                    uint32 entry = 0; p >> entry;
                    if (entry & 0x80000000)
                    {
                        w.Add("entry", entry & 0x7FFFFFFF).Add("found", false);
                        break;
                    }
                    uint32 gtype, display; p >> gtype >> display;
                    std::string gname; p >> gname;
                    std::string n2, n3, n4; p >> n2 >> n3 >> n4; // always empty
                    std::string iconName, castBarCaption; p >> iconName >> castBarCaption;
                    w.Add("entry", entry).Add("found", true).Add("name", gname)
                     .Add("type", gtype).Add("displayId", display).Add("castBarCaption", castBarCaption);
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
                    // The rest of the tooltip, in the order
                    // WorldSession::HandleItemQuerySingleOpcode writes it:
                    // requirements, stack/bag sizes, the stat list, two damage
                    // ranges, armor and six resistances, speed, five spell
                    // slots, bonding, description, then the page/quest/lock/
                    // material block up to maxDurability. Everything after
                    // (sockets, gems, duration, holiday) is left unread.
                    uint32 reqSkill, reqSkillRank, reqSpell, reqHonor, reqCity, reqRepFaction, reqRepRank;
                    p >> reqSkill >> reqSkillRank >> reqSpell >> reqHonor >> reqCity >> reqRepFaction >> reqRepRank;
                    int32 maxCount, stackable; uint32 containerSlots, statsCount;
                    p >> maxCount >> stackable >> containerSlots >> statsCount;
                    if (statsCount > 10) throw ByteBufferException();
                    std::string stats = "[";
                    for (uint32 i = 0; i < statsCount; ++i)
                    {
                        uint32 type; int32 value; p >> type >> value;
                        if (i) stats += ',';
                        stats += Json::Writer().Add("type", type).Add("value", value).Str();
                    }
                    stats += "]";
                    uint32 ssd, ssv; p >> ssd >> ssv;
                    std::string damage = "[";
                    bool firstDmg = true;
                    for (int i = 0; i < 2; ++i)
                    {
                        float dmin, dmax; uint32 dtype; p >> dmin >> dmax >> dtype;
                        if (dmin == 0 && dmax == 0) continue;
                        if (!firstDmg) damage += ',';
                        firstDmg = false;
                        damage += Json::Writer().Add("min", (double)dmin).Add("max", (double)dmax).Add("type", dtype).Str();
                    }
                    damage += "]";
                    uint32 armor; p >> armor;
                    static char const* resName[6] = { "holy", "fire", "nature", "frost", "shadow", "arcane" };
                    Json::Writer res; bool anyRes = false;
                    for (int i = 0; i < 6; ++i)
                    {
                        uint32 r; p >> r;
                        if (r) { res.Add(resName[i], r); anyRes = true; }
                    }
                    uint32 delay, ammoType; float rangedMod;
                    p >> delay >> ammoType >> rangedMod;
                    std::string spells = "[";
                    bool firstSpell = true;
                    for (int i = 0; i < 5; ++i)
                    {
                        uint32 spellId, trigger; int32 charges; uint32 cd, cat, catCd;
                        p >> spellId >> trigger >> charges >> cd >> cat >> catCd;
                        if (!spellId) continue;
                        if (!firstSpell) spells += ',';
                        firstSpell = false;
                        Json::Writer sp;
                        sp.Add("spellId", spellId).Add("trigger", trigger).Add("charges", charges);
                        if (SpellInfo const* info = sSpellMgr->GetSpellInfo(spellId))
                            if (info->SpellName[0])
                                sp.Add("name", info->SpellName[0]);
                        spells += sp.Str();
                    }
                    spells += "]";
                    uint32 bonding; std::string description;
                    p >> bonding >> description;
                    uint32 pageText, languageId, pageMaterial, startQuest, lockId; int32 material;
                    uint32 sheath, randomProperty, randomSuffix, block, itemSet, maxDurability;
                    p >> pageText >> languageId >> pageMaterial >> startQuest >> lockId >> material
                      >> sheath >> randomProperty >> randomSuffix >> block >> itemSet >> maxDurability;
                    w.Add("requiredSkill", reqSkill).Add("requiredSkillRank", reqSkillRank);
                    if (reqSkill)
                        if (SkillLineEntry const* sl = sSkillLineStore.LookupEntry(reqSkill))
                            if (sl->name[0])
                                w.Add("requiredSkillName", sl->name[0]);
                    if (reqSpell) w.Add("requiredSpell", reqSpell);
                    if (reqRepFaction)
                    {
                        w.Add("requiredReputationFaction", reqRepFaction).Add("requiredReputationRank", reqRepRank);
                        if (FactionEntry const* fe = sFactionStore.LookupEntry(reqRepFaction))
                            if (fe->name[0])
                                w.Add("requiredReputationFactionName", fe->name[0]);
                    }
                    w.Add("maxCount", maxCount).Add("stackable", stackable).Add("containerSlots", containerSlots)
                     .Raw("stats", stats).Raw("damage", damage).Add("armor", armor);
                    if (anyRes) w.Raw("resistances", res.Str());
                    w.Add("speedMs", delay).Raw("spells", spells).Add("bonding", bonding);
                    if (!description.empty()) w.Add("description", description);
                    if (startQuest) w.Add("startQuest", startQuest);
                    // PageText.dbc-shaped id of the item's first page: a book
                    // or letter the client can read. 0 is
                    // "nothing to read" and is not served.
                    if (pageText) w.Add("pageText", pageText);
                    if (block) w.Add("block", block);
                    w.Add("maxDurability", maxDurability);
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
                case MSG_CORPSE_QUERY:
                {
                    // The server's answer to the ghost's corpse query
                    // (HandleCorpseQueryOpcode): found flag, then the point the
                    // client draws the corpse marker at and the corpse's own
                    // map. For a corpse in a dungeon the point is the entrance
                    // on the outer map, which is why the two map ids differ.
                    // The trailing u32 is unused by the client and dropped.
                    name = "MSG_CORPSE_QUERY";
                    uint8 found = 0; p >> found;
                    w.Add("found", found != 0);
                    if (found)
                    {
                        int32 map, corpseMap; float x, y, z;
                        p >> map >> x >> y >> z >> corpseMap;
                        w.Add("map", map).Add("x", (double)x).Add("y", (double)y).Add("z", (double)z)
                         .Add("corpseMap", corpseMap);
                    }
                    break;
                }
                // --------------------------------------------------- session
                case SMSG_CHAR_DELETE:
                {
                    name = "SMSG_CHAR_DELETE";
                    uint8 result = 0; if (p.size() >= 1) p >> result;
                    w.Add("result", (uint32)result);
                    break;
                }
                // ------------------------------------------- map transfers
                case SMSG_TRANSFER_PENDING:
                {
                    // Player::TeleportTo (far): u32 mapId, then (u32
                    // transportEntry, u32 oldMapId) only when the character is
                    // being carried across by a transport.
                    name = "SMSG_TRANSFER_PENDING";
                    uint32 mapId; p >> mapId;
                    w.Add("map", mapId);
                    if (p.rpos() + 8 <= p.size())
                    {
                        uint32 transportEntry, oldMap; p >> transportEntry >> oldMap;
                        w.Add("transportEntry", transportEntry).Add("oldMap", oldMap);
                    }
                    s.pendingTransferMap.store(mapId);
                    break;
                }
                case SMSG_NEW_WORLD:
                {
                    // Player::TeleportTo (far): u32 mapId, xyzo of the arrival
                    // point (transport-local when aboard one). This is the
                    // client's only map id after login (SMSG_LOGIN_VERIFY_WORLD
                    // is never re-sent), so the SDK keys self.position.map on it.
                    name = "SMSG_NEW_WORLD";
                    uint32 mapId; float x, y, z, o; p >> mapId >> x >> y >> z >> o;
                    w.Add("map", mapId).Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Add("o", (double)o);
                    s.pendingTransferMap.store(0);
                    break;
                }
                case SMSG_TRANSFER_ABORTED:
                {
                    // Player::SendTransferAborted: u32 mapId, u8 reason, u8 arg
                    // only for INSUF_EXPAN_LVL / DIFFICULTY / UNIQUE_MESSAGE.
                    name = "SMSG_TRANSFER_ABORTED";
                    uint32 mapId; uint8 reason; p >> mapId >> reason;
                    w.Add("map", mapId).Add("reason", (uint32)reason);
                    if (p.rpos() + 1 <= p.size())
                    {
                        uint8 arg; p >> arg;
                        w.Add("arg", (uint32)arg);
                    }
                    s.pendingTransferMap.store(0);
                    break;
                }
                // ---------------------------------------- creature movement
                case SMSG_MONSTER_MOVE:
                {
                    // Destination and duration ONLY. The spline path points are
                    // consumed and dropped: serving them would leak the server's
                    // route.
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
