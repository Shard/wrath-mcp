/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

#include "WbManager.h"
#include "WbJson.h"
#include "WbNav.h"

#include "AccountMgr.h"
#include "AchievementMgr.h"
#include "ChatCommandHelpers.h"
#include "Config.h"
#include "CryptoHash.h"
#include "CryptoRandom.h"
#include "DatabaseEnv.h"
#include "DBCStores.h"
#include "GameTime.h"
#include "Item.h"
#include "ItemTemplate.h"
#include "Log.h"
#include "LootMgr.h"
#include "QuestDef.h"
#include "ReputationMgr.h"
#include "ObjectGuid.h"
#include "ObjectMgr.h"
#include "ObjectVisibilityContainer.h"
#include "Opcodes.h"
#include "Map.h"
#include "MapCollisionData.h"
#include "ModelIgnoreFlags.h"
#include "DetourCommon.h"
#include "PathGenerator.h"
#include "MovementTypedefs.h"
#include "MoveSpline.h"
#include "ObjectAccessor.h"
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
#include <cfloat>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <cmath>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <initializer_list>
#include <iterator>
#include <stdexcept>
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

    // The wire protocol this build speaks, served on /health beside the build
    // (PROTOCOL.md, "Versioning"). An SDK refuses a protocol it cannot drive.
    // Bumped only for a change an existing SDK would misread; an addition to
    // the protocol leaves it alone.
    static uint32_t const kProtocolVersion = 1;

    static void AddBuildIdentity(Json::Writer& w)
    {
        w.Add("build", WRATHBENCH_BUILD);
        w.Add("startedAtMs", kStartedAtMs);
        w.Add("uptimeMs", NowMs() - kStartedAtMs);
        w.Add("protocol", kProtocolVersion);
    }

    // Whether the world loaded whole, for /health (PROTOCOL.md, GET /health).
    // The core logs a query that lost its database connection and carries on:
    // a MySQL restart in the middle of SetInitialWorldSettings leaves a world
    // with no creatures and a server that otherwise looks fine. Taken once, on
    // the world thread, from Start(): OnStartup runs after the whole load and
    // before the first world tick, and the core never refills these stores, so
    // the snapshot is the truth for the life of the process. Written before
    // the HTTP threads exist and never again, so they read it without a lock.
    struct WorldCensus
    {
        uint64 creatureSpawns = 0;
        uint64 gameObjectSpawns = 0;
        uint64 creatureTemplates = 0;
        uint64 questTemplates = 0;
        int64 dbUptimeS = -1;      // the world database server's own Uptime; -1 unread
        int64 loadedAfterMs = 0;   // this process's age when the census ran
        bool dbRestarted = false;  // that server started after this process did
        bool loaded = false;
    };
    static WorldCensus sWorldCensus;
    static auto const kStartedSteady = std::chrono::steady_clock::now();

    static void TakeWorldCensus()
    {
        WorldCensus c;
        c.creatureSpawns = sObjectMgr->GetAllCreatureData().size();
        c.gameObjectSpawns = sObjectMgr->GetAllGOData().size();
        c.creatureTemplates = sObjectMgr->GetCreatureTemplates()->size();
        c.questTemplates = sObjectMgr->GetQuestTemplates().size();
        c.loadedAfterMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - kStartedSteady).count();
        // A database that is younger than this process restarted during the
        // load, and every query in flight then was lost whichever table it
        // read. Seconds resolution, so allow a few before calling it.
        if (QueryResult r = WorldDatabase.Query("SHOW GLOBAL STATUS LIKE 'Uptime'"))
        {
            std::string const v = r->Fetch()[1].Get<std::string>();
            char* end = nullptr;
            unsigned long long const s = std::strtoull(v.c_str(), &end, 10);
            if (end != v.c_str())
                c.dbUptimeS = static_cast<int64>(s);
        }
        c.dbRestarted = c.dbUptimeS >= 0 && (c.dbUptimeS + 5) * 1000 < c.loadedAfterMs;
        c.loaded = c.creatureSpawns > 0 && c.gameObjectSpawns > 0 && c.creatureTemplates > 0
            && c.questTemplates > 0 && !c.dbRestarted;
        sWorldCensus = c;

        if (c.dbUptimeS < 0)
            LOG_WARN("module", "wrathbench: could not read the world database's Uptime; the world load is judged on the store counts alone");
        if (c.dbRestarted)
            LOG_ERROR("module", "wrathbench: the world database has been up {}s and this process {}s: it restarted during the world load",
                c.dbUptimeS, c.loadedAfterMs / 1000);
        if (c.loaded)
            LOG_INFO("module", "wrathbench: world loaded: {} creature spawns, {} gameobject spawns, {} creature templates, {} quests",
                c.creatureSpawns, c.gameObjectSpawns, c.creatureTemplates, c.questTemplates);
        else
            LOG_ERROR("module", "wrathbench: the world did NOT load whole ({} creature spawns, {} gameobject spawns, {} creature templates, "
                "{} quests); /health answers 503 world_not_loaded until the worldserver restarts",
                c.creatureSpawns, c.gameObjectSpawns, c.creatureTemplates, c.questTemplates);
    }

    static void AddWorldLoad(Json::Writer& w)
    {
        Json::Writer c;
        c.Add("creatureSpawns", sWorldCensus.creatureSpawns);
        c.Add("gameObjectSpawns", sWorldCensus.gameObjectSpawns);
        c.Add("creatureTemplates", sWorldCensus.creatureTemplates);
        c.Add("questTemplates", sWorldCensus.questTemplates);
        if (sWorldCensus.dbUptimeS >= 0)
            c.Add("dbUptimeS", sWorldCensus.dbUptimeS);
        else
            c.Raw("dbUptimeS", "null");
        c.Add("loadedAfterMs", sWorldCensus.loadedAfterMs);
        c.Add("dbRestarted", sWorldCensus.dbRestarted);
        w.Raw("worldLoad", c.Str());
    }

    // The first `bytes` bytes of the token's SHA-256, as lowercase hex.
    static std::string TokenDigestHex(std::string const& token, size_t bytes)
    {
        auto const digest = Acore::Crypto::SHA256::GetDigestOf(
            reinterpret_cast<uint8 const*>(token.data()), token.size());
        static char const hex[] = "0123456789abcdef";
        std::string out;
        for (size_t i = 0; i < bytes && i < digest.size(); ++i)
        {
            out += hex[digest[i] >> 4];
            out += hex[digest[i] & 0x0F];
        }
        return out;
    }

    // The stem of a session's audit files: the first 16 hex characters of the
    // token's SHA-256 (PROTOCOL.md, "Audit log"). Its first 8 are TokenTag's,
    // so a worldserver log line's tag is a prefix of its session's file name.
    // Longer than the tag because a file name must stay unique across every
    // session the audit directory holds over its retention window: at 32 bits
    // two of ten thousand sessions share a tag about one time in a hundred,
    // and two sessions in one file would interleave silently. At 64 bits that
    // does not happen; and the hash of a 32-character random token, which is
    // what a session token is, names it without giving it away.
    static std::string TokenFingerprint(std::string const& token)
    {
        return TokenDigestHex(token, 8);
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
        _bindAddress = sConfigMgr->GetOption<std::string>("WrathBench.BindAddress", "127.0.0.1");
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
        std::string mapPath = sWorld->GetDataPath() + "dbc/Map.dbc";
        if (!LoadMapDbc(mapPath))
            LOG_ERROR("module", "wrathbench: Map.dbc not loaded from '{}'; WB_AREA will carry map ids without a name or instance type", mapPath);
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
        // Random item properties are named from the core's own stores of the
        // client's ItemRandomProperties / ItemRandomSuffix /
        // SpellItemEnchantment files (loaded with every other DBC); an empty
        // store serves ids without names, never an error.
        LOG_INFO("module", "wrathbench: item random properties named from {} ItemRandomProperties, {} ItemRandomSuffix and {} SpellItemEnchantment rows",
            sItemRandomPropertiesStore.GetNumRows(), sItemRandomSuffixStore.GetNumRows(), sSpellItemEnchantmentStore.GetNumRows());

        TakeWorldCensus();

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
        TickClientAnswers();
        TickMovers(nowMs);
        TickGrounded(nowMs);
        TickSplineDone();
        TickRiders(nowMs);
        TickTransports(nowMs);

        // Answer pending teleports; without this every teleport (repop's
        // graveyard port included) freezes movement forever.
        TickTeleportAcks(nowMs);
        TickCorpseQuery();
        TickAreas();
        TickPortals(nowMs);
        TickReplays(nowMs);

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
    std::string TokenTag(std::string const& token)
    {
        return std::string("tok:") + TokenDigestHex(token, 4);
    }

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
            std::optional<bool> forcedAllowGm;
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
                    // The GM opt-in likewise: the lease's, whatever the body
                    // says. Only the port secret's holder sets it, so the
                    // snippet a lease secret is handed to can never raise it.
                    forcedAllowGm = lease.allowGm;
                }
            }

            if (method == "POST" && target == "/session")
            {
                HttpReply reply = HttpCreateSession(body, forcedAccount, forcedAllowGm);
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

        // The GM opt-in the token's session-class creates inherit. Each
        // lease says it afresh, so re-leasing without it turns it off.
        bool const allowGm = req.GetBool("allowGm");

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
            l.allowGm = allowGm;
            character = l.character;
        }
        // A live session under the token takes the lease's opt-in now, not at
        // its next create: a re-lease without it must turn it off for the
        // session already in world, whose create may never come again (a GM
        // account's is refused before it could refresh anything). World
        // thread, where the flag is read.
        PushTask([this, token, allowGm]() {
            if (auto live = FindByToken(token))
                live->allowGm = allowGm;
        });
        LOG_INFO("module", "wrathbench: leased {} to account {}{}", TokenTag(token), account, allowGm ? " (GM opt-in)" : "");
        Json::Writer w;
        w.Add("ok", true).Add("token", token).Add("account", account).Add("secret", secret).Add("allowGm", allowGm);
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
        // A world that did not load whole (TakeWorldCensus) is not ready: 503
        // with the error envelope every refusal carries, and otherwise the
        // usual body. Every reader that keys on `ok` (the fleet gate, both
        // deploy windows, the smokes) waits on it unchanged, the build still
        // reads off it, and the worldserver's startup probe never passes.
        bool const loaded = sWorldCensus.loaded;
        int const status = loaded ? 200 : 503;
        auto head = [&](Json::Writer& w)
        {
            w.Add("ok", loaded);
            if (!loaded)
                w.Add("error", "world_not_loaded");
            w.Add("module", "mod-wrathbench");
            w.Add("worldStopped", World::IsStopped());
            w.Add("worldLoaded", loaded);
        };

        // Non-loopback callers (runner, snippet sandbox) get liveness only:
        // the global session count and the drop census describe module
        // internals and other runs' sessions, which the observation contract
        // never serves to a snippet. The counter fields stay present, zeroed,
        // so the SDK's health schema keeps parsing; the census is read
        // by operators via loopback curl inside the worldserver container.
        // The world-load counts are the same kind of internal: loopback only.
        if (!operatorView)
        {
            Json::Writer w;
            head(w);
            w.Add("sessions", 0);
            w.Add("droppedPackets", 0);
            w.Add("droppedPacketsLive", 0);
            AddBuildIdentity(w);
            return {status, w.Str()};
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
        head(w);
        w.Add("sessions", sessions);
        w.Add("droppedPackets", _totalDrops.load()); // lifetime
        w.Add("droppedPacketsLive", liveDrops);      // across current sessions
        w.Raw("droppedByOpcode", byOpcode.Str());    // lifetime, top 30 by count
        AddWorldLoad(w);
        AddBuildIdentity(w);
        return {status, w.Str()};
    }

    HttpReply Manager::HttpCreateSession(std::string const& body, std::string const& forcedAccount,
        std::optional<bool> forcedAllowGm)
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
        s->allowGm = forcedAllowGm.value_or(req.GetBool("allowGm"));
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
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
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

    // How a caller opts in to GM use, said by both refusals that need it.
    static char const* const kGmOptInHint =
        "the module serves player use only unless the session is created with allowGm "
        "(the MCP server's --allow-gm or WRATHBENCH_ALLOW_GM=1; the SDK's connect({ allowGm: true }); "
        "on a leased token, the lease's allowGm)";

    // Whether the stock chat handler would take this text as a command:
    // ChatHandler::ParseCommands's prefix test, exactly (AzerothCore 3cafaf4a,
    // src/server/game/Chat/Chat.cpp:250-271). A '.' or '!', then neither the
    // same character again nor the command delimiter. What follows is the
    // command lookup, which for an unknown command lets a player's line through
    // as chat; the module refuses at the prefix and runs no lookup.
    static bool ChatTextRunsCommand(std::string_view text)
    {
        if (text.empty())
            return false;
        if ((text[0] != '!') && (text[0] != '.'))
            return false;
        if (text.length() < 2)
            return false;
        if (text[1] == text[0])
            return false;
        if (text[1] == Acore::Impl::ChatCommands::COMMAND_DELIMITER)
            return false;
        return true;
    }

    // The addon channel's command form: AddonChannelCommandHandler::ParseCommands
    // (Chat.cpp:991-1030) runs a command for "AzerothCore\t", an 'h' or 'i', a
    // four-character counter and at least one character of command. Its 'p'
    // (ping) runs none. The text is a C string there, so "str[k] is not NUL"
    // for k up to 17 is a length of 18 or more.
    static bool AddonTextRunsCommand(std::string_view text)
    {
        if (text.size() < 18 || std::memcmp(text.data(), "AzerothCore\t", 12) != 0)
            return false;
        return text[12] == 'h' || text[12] == 'i';
    }

    // Whether WorldSession::HandleMessagechatOpcode would hand this
    // CMSG_MESSAGECHAT body to a command parser (ChatHandler.cpp:61-308 at the
    // pinned core, the parse calls at 302 and 307): read as the handler reads
    // it, with the same ByteBuffer calls, and through the same checks that
    // stand before its two parse calls. A body the handler cannot read throws
    // there as here, and runs nothing. The checks that depend on the
    // character or the server's config (language known, muted, addon channel
    // enabled) are not repeated: failing them stops the line before any
    // command, so refusing such a line anyway costs nothing.
    static bool ChatPacketRunsCommand(WorldPacket const& packet)
    {
        try
        {
            WorldPacket in(packet);
            in.rpos(0);
            uint32 type = 0, lang = 0;
            in >> type >> lang;
            if (type >= MAX_CHAT_MSG_TYPE)
                return false;
            std::string to, channel, msg;
            switch (type)
            {
                case CHAT_MSG_SAY:
                case CHAT_MSG_EMOTE:
                case CHAT_MSG_YELL:
                case CHAT_MSG_PARTY:
                case CHAT_MSG_PARTY_LEADER:
                case CHAT_MSG_GUILD:
                case CHAT_MSG_OFFICER:
                case CHAT_MSG_RAID:
                case CHAT_MSG_RAID_LEADER:
                case CHAT_MSG_RAID_WARNING:
                case CHAT_MSG_BATTLEGROUND:
                case CHAT_MSG_BATTLEGROUND_LEADER:
                    msg = in.ReadCString(lang != LANG_ADDON);
                    break;
                case CHAT_MSG_WHISPER:
                    in >> to;
                    msg = in.ReadCString(lang != LANG_ADDON);
                    break;
                case CHAT_MSG_CHANNEL:
                    in >> channel;
                    msg = in.ReadCString(lang != LANG_ADDON);
                    break;
                default:
                    // AFK and DND skip the parse (ignoreChecks); every other
                    // type reads no text, and empty text is never parsed.
                    return false;
            }
            if (msg.length() > 255 || (lang != LANG_ADDON && msg.find("|0") != std::string::npos))
                return false;
            if (msg.empty())
                return false;
            // The handler passes msg.c_str(): the text up to its first NUL.
            std::string_view const text(msg.c_str());
            if (lang == LANG_ADDON)
            {
                // LANG_ADDON is read only for these types; the rest are dropped.
                switch (type)
                {
                    case CHAT_MSG_PARTY:
                    case CHAT_MSG_RAID:
                    case CHAT_MSG_GUILD:
                    case CHAT_MSG_BATTLEGROUND:
                    case CHAT_MSG_WHISPER:
                        return AddonTextRunsCommand(text);
                    default:
                        return false;
                }
            }
            return ChatTextRunsCommand(text);
        }
        catch (ByteBufferException const&)
        {
            return false;
        }
    }

    // The refusal for chat that would run a command, without the opt-in.
    static std::string ChatCommandRefusal(std::string const& action)
    {
        return Json::Writer().Add("ok", false).Add("error", "chat_command").Add("action", action)
            .Add("hint", std::string("the server would run this text as a command (it starts with '.' or '!'); ")
                + kGmOptInHint)
            .Str();
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
        // the ammo slot: a hunter's arrows or bullets by item id (body u32
        // item id, 0 clears); CMSG_AUTOEQUIP_ITEM cannot equip ammo
        { "CMSG_SET_AMMO", CMSG_SET_AMMO },
        // spell/aura control
        { "CMSG_CANCEL_AURA", CMSG_CANCEL_AURA },
        // the client's Dismount (empty body; MiscHandler.cpp
        // HandleCancelMountAuraOpcode); the SDK's dismount sends it
        { "CMSG_CANCEL_MOUNT_AURA", CMSG_CANCEL_MOUNT_AURA },
        { "CMSG_CANCEL_AUTO_REPEAT_SPELL", CMSG_CANCEL_AUTO_REPEAT_SPELL },
        { "CMSG_CANCEL_CHANNELLING", CMSG_CANCEL_CHANNELLING },
        { "CMSG_SET_SHEATHED", CMSG_SET_SHEATHED },
        { "CMSG_STANDSTATECHANGE", CMSG_STANDSTATECHANGE },
        { "CMSG_RESURRECT_RESPONSE", CMSG_RESURRECT_RESPONSE },
        // the dead character's own resurrection (Soulstone, Reincarnation):
        // empty body; the handler casts PLAYER_SELF_RES_SPELL, served on self
        { "CMSG_SELF_RES", CMSG_SELF_RES },
        // dismiss the summoned companion (body u64 critter guid)
        { "CMSG_DISMISS_CRITTER", CMSG_DISMISS_CRITTER },
        // the right-click on a totem icon (body u8 slot, as SMSG_TOTEM_CREATED
        // names it: 0 fire, 1 earth, 2 water, 3 air)
        { "CMSG_TOTEM_DESTROYED", CMSG_TOTEM_DESTROYED },
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
        // the party frame's own refresh of one member (body u64 guid,
        // unpacked); answered with SMSG_PARTY_MEMBER_STATS_FULL, or with
        // the offline form for a guid not in the party
        { "CMSG_REQUEST_PARTY_MEMBER_STATS", CMSG_REQUEST_PARTY_MEMBER_STATS },
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
        // a quest's objective areas, as the world map and quest tracker ask
        // for them (body u32 count <= MAX_QUEST_LOG_SIZE, u32 questId x
        // count); answered with SMSG_QUEST_POI_QUERY_RESPONSE
        { "CMSG_QUEST_POI_QUERY", CMSG_QUEST_POI_QUERY },
        { "CMSG_PLAYED_TIME", CMSG_PLAYED_TIME },
        { "CMSG_QUERY_TIME", CMSG_QUERY_TIME },
        { "CMSG_SET_WATCHED_FACTION", CMSG_SET_WATCHED_FACTION },
        { "CMSG_SET_ACTION_BUTTON", CMSG_SET_ACTION_BUTTON },
        // a ghost asking where its corpse is (the module asks once per death
        // on the client's behalf; this lets a snippet re-ask)
        { "MSG_CORPSE_QUERY", MSG_CORPSE_QUERY },
        // vehicles: the click on a unit's spellclick (the vehicle cursor;
        // body u64 guid, SpellHandler.cpp HandleSpellClick casts the unit's
        // npc_spellclick_spells spell at the character), and the party's
        // "enter player vehicle" (u64 player guid, HandleEnterPlayerVehicle:
        // raid members within interaction range only). Leaving and changing
        // seat are actions: both carry the client's own MovementInfo.
        { "CMSG_SPELLCLICK", CMSG_SPELLCLICK },
        { "CMSG_PLAYER_VEHICLE_ENTER", CMSG_PLAYER_VEHICLE_ENTER },
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
        for (char const* key : { "guid", "targetGuid", "itemGuid", "itemTargetGuid" })
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
            // Optional: walk a route that steps off a ledge instead of
            // refusing it (PROTOCOL.md, `drop`). The fall then happens on the
            // server, as it would for a client that walked off the edge.
            bool force = req.GetBool("force");
            PushTask([this, token, x, y, z, guid, force, ack]() { DoMoveTo(token, x, y, z, guid, force, ack); });
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
                "quest_request_reward", "quest_choose_reward", "loot", "loot_all", "loot_release",
                "vendor_list", "buy_item", "sell_item", "repair_all",
                "trainer_list", "trainer_buy_spell",
                "spirit_healer_activate", "questgiver_status_query", nullptr };
            static char const* kNoParams[] = {
                "clear_target", "attack_stop", "loot_money", "repop", "reclaim_corpse",
                "questgiver_status_multiple_query", "vehicle_exit", nullptr };

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
                     || action == "learn_talent" || action == "learn_preview_talents" || action == "raw"
                     || action == "vehicle_change_seat";
            if (!known)
                return {400, Json::Writer().Add("ok", false).Add("error", "unsupported_action").Add("action", action).Str()};

            if (needsGuid && req.GetString("guid").empty())
                return MissingParam(action, "missing_guid", "guid");
            if (action == "gossip_select" && (!req.Has("menuId") || !req.Has("optionId")))
                return MissingParam(action, "missing_option", !req.Has("menuId") ? "menuId" : "optionId");
            if ((action == "quest_details" || action == "quest_accept" || action == "quest_complete"
                 || action == "quest_request_reward" || action == "quest_choose_reward"
                 || action == "quest_abandon" || action == "quest_query")
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
            // A ground target is a whole point: the module never makes up an axis.
            if ((action == "cast_spell" || action == "use_item")
                && (req.Has("destX") || req.Has("destY") || req.Has("destZ"))
                && !(req.Has("destX") && req.Has("destY") && req.Has("destZ")))
                return MissingParam(action, "missing_dest", !req.Has("destX") ? "destX" : (!req.Has("destY") ? "destY" : "destZ"));
            if (action == "learn_talent" && (!req.Has("talentId") || !req.Has("rank")))
                return MissingParam(action, "missing_talent", !req.Has("talentId") ? "talentId" : "rank");
            if (action == "learn_preview_talents" && !req.Has("talents"))
                return MissingParam(action, "missing_talents", "talents");
            if (action == "vehicle_change_seat" && !req.Has("seat"))
                return MissingParam(action, "missing_seat", "seat");
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
        s->allowGm = req.GetBool("allowGm");
        s->deleteMode = true;

        auto ack = std::make_shared<std::promise<HttpReply>>();
        s->ack = ack;
        auto fut = ack->get_future();
        PushTask([this, s, ack]() { DoCreateSession(s, ack); });

        if (fut.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
        {
            PushTask([this, token]() { TeardownByToken(token); });
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
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
        s->allowGm = req.GetBool("allowGm");
        s->listMode = true;

        auto ack = std::make_shared<std::promise<HttpReply>>();
        s->ack = ack;
        auto fut = ack->get_future();
        PushTask([this, s, ack]() { DoCreateSession(s, ack); });

        if (fut.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
        {
            PushTask([this, token]() { TeardownByToken(token); });
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
        }
        return fut.get();
    }

    // ---------------------------------------------------- world-thread work
    void Manager::DoCreateSession(std::shared_ptr<BenchSession> s, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto fail = [&](std::string const& err, int status = 400) {
            if (!s->ackFired.exchange(true))
                ack->set_value({status, Json::Writer().Add("ok", false).Add("error", err).Str()});
        };

        uint32 accountId = AccountMgr::GetId(s->account);
        if (!accountId)
            return fail("unknown_account");
        s->accountId = accountId;

        // Player accounts only, unless the caller opted in (PROTOCOL.md,
        // "POST /session", `allowGm`). A session runs at its account's security
        // level, and the stock chat handler runs a GM's dot commands, so a GM
        // account would give `say` the server's command set: actions no client
        // of a player could send. Decided first, before any teardown or
        // reclaim, so a refused create disturbs nothing. The highest level the
        // account holds on any realm decides, read from account_access
        // directly: AccountMgr::GetSecurity(id) takes whichever row comes first.
        if (!s->allowGm)
        {
            uint32 security = SEC_PLAYER;
            if (QueryResult access = LoginDatabase.Query("SELECT MAX(gmlevel) AS gmlevel FROM account_access WHERE id = {}", accountId))
                if (!access->Fetch()[0].IsNull())
                    security = access->Fetch()[0].Get<uint8>();
            if (security > SEC_PLAYER)
            {
                if (!s->ackFired.exchange(true))
                    ack->set_value({403, Json::Writer().Add("ok", false).Add("error", "gm_account")
                        .Add("hint", kGmOptInHint).Str()});
                return;
            }
        }

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
                    // The opt-in is this create's: a resumed caller that no
                    // longer asks for it turns it off (it passed the GM-account
                    // check above on its own terms). World thread, as its reads.
                    existing->allowGm = s->allowGm;
                    if (!s->ackFired.exchange(true))
                        ack->set_value({200, Json::Writer().Add("ok", true)
                            .Add("account", existing->account).Add("character", existing->charName)
                            .AddGuid("guid", existing->targetGuidRaw).Add("inWorld", true).Str()});
                    // No new module session is created, so the SDK's per-session
                    // event stream never restarts — without this the caller would
                    // get ok:inWorld beside an empty state cache (the trap in a new
                    // skin). Emit the reattach snapshot alone: a caller that needs
                    // the full replay asks for it on its subscribe (OnWsOpen), and
                    // a burst here would only crowd the event window. The SDK
                    // advances its event epoch before the POST, so this lands in
                    // the new epoch, not the discarded one.
                    EmitSessionState(existing, nullptr);
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
                            .Add("account", s->account).Add("bySession", TokenTag(s->token)).Str());
                        LOG_INFO("module", "wrathbench: reclaiming leaked account '{}' (session {}) for create {}",
                            s->account, TokenTag(t), TokenTag(s->token));
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

        // A player account, checked above: the session runs as one.
        std::string name = s->account;
        WorldSession* ws = new WorldSession(accountId, std::move(name), flags, s->socket,
            SEC_PLAYER, expansion, static_cast<time_t>(mutetime),
            static_cast<LocaleConstant>(locale), recruiter, false, false, totaltime);
        ws->ValidateAccountFlags();
        s->ws = ws;

        // Open the audit log: today's day file.
        {
            std::lock_guard<std::mutex> lock(s->auditMutex);
            OpenAudit(*s, NowMs() / 86400000);
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
        if (!s->allowGm && ChatPacketRunsCommand(*p))
        {
            delete p;
            return reply(403, ChatCommandRefusal("say"));
        }
        s->ws->QueuePacket(p);

        Audit(*s, "action", Json::Writer().Add("op", "say").Add("text", text).Str());
        reply(200, Json::Writer().Add("ok", true).Add("action", "say").Str());
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

    // The "client" clock: milliseconds since the session was created
    // (BenchSession::clientClockEpochMs), wrapping as a client's u32 clock
    // does. Not the server's getMSTime(): a client's clock is its own, and the
    // server's time sync (WorldSession::HandleTimeSyncResp, ComputeNewClockDelta)
    // measures the offset between the two and adds it to every movement
    // packet's time before relaying it (SynchronizeMovement). With the clocks
    // equal the offset measures ~0, which the core never adopts (it moves only
    // past 25ms) and treats as "no sync" (the fallback in SynchronizeMovement).
    static uint32 ClientMSTime(BenchSession const& s)
    {
        return getMSTime() - s.clientClockEpochMs;
    }

    // Synthesize one client movement packet (MovementInfo layout mirrors
    // WorldSession::ReadMovementInfo: flags u32, flags2 u16, time u32, xyzo,
    // [ONTRANSPORT: packGUID transport, local xyzo, u32 transport time, i8 seat,]
    // [SWIMMING: f32 pitch,] fallTime u32; no fall extras: the module never
    // sends a packet mid-fall). The time is the session's own "client"
    // clock (ClientMSTime), the one CMSG_TIME_SYNC_RESP reports, so the
    // server's time sync translates it to server time on every relay. When
    // the point is on a transport the packet says so the way a client's would:
    // the server then carries the character as a passenger.
    //
    // A swimming client sets MOVEMENTFLAG_SWIMMING on every movement packet
    // it sends, stops and facings included, and the flag makes the layout
    // carry the pitch. Every packet derives it from one place so none can
    // disagree: during a move the mover's own state (PlaceMover flips it and
    // sends the MSG_MOVE_START_SWIM / MSG_MOVE_STOP_SWIM), outside one the
    // server's record of the last flag the module sent (Player::IsInWater,
    // which ProcessMovementInfo keeps from the packets). Never on a
    // transport: a deck is not water.
    //
    // The movement-state flags the server has told this client it has (water
    // walking, feather fall, hover, can-fly: BenchSession::stateMoveFlags,
    // OnMoveFlagPacket) go on every packet too, as a client's do: the core
    // replaces its record of the unit's flags with each packet's
    // (HandleMoverRelocation) and relays them to observers, so a packet
    // without them would undo the change. One the server has since dropped
    // without a packet is stripped by the core on arrival (ReadMovementInfo
    // removes each without its aura), so it can never be claimed falsely.
    // Two deliberate gaps, until the walker can live the state: can-fly is
    // kept but never sent, acks included (the core's Player::CanFly reads the
    // flag from the packets, and with it set the pathfinder that plans
    // move_to on the character stops settling route points on the ground
    // and takes straight-line shortcuts off the mesh, PathGenerator and
    // UpdateAllowedPositionZ, while the walker only walks); and water walking
    // is dropped from a packet that swims (the walker swims a water-walking
    // body under the surface where a client runs on it, and no client sends
    // the two together).
    //
    // AppendMovementInfo is the MovementInfo alone, shared with the forced-root
    // acks (AnswerForceRoot), the speed-change acks (OnSpeedChangePacket) and
    // the movement-state acks (AnswerMoveFlag), whose bodies are packGUID, the
    // echoed counter, then this same MovementInfo: one writer, so an ack can
    // never disagree with the walk about the transport block, the swimming
    // flag, the state flags or the clock.
    //
    // Whether `unit` is the session's own character, as against a unit it
    // moves: by identity, never by type (a possessed player is another
    // player's character).
    static bool IsOwnCharacter(BenchSession& s, Unit* unit)
    {
        return s.ws && unit == static_cast<Unit*>(s.ws->GetPlayer());
    }

    static void AppendMovementInfo(WorldPacket& p, BenchSession& s, Unit* mover, uint32 moveFlags,
        float x, float y, float z, float o, Transport* transport)
    {
        // The character's told flags, or the controlled unit's (a vehicle, a
        // possessed unit: BenchSession::moverMoveFlags, its own flags at the
        // handover and the packets for its guid since). The can-fly gap is the
        // character's alone: a flying mover flies, and its packets say so
        // (FLYING | CAN_FLY, which ReadMovementInfo keeps once the mover has
        // its fly aura and strips until then).
        bool const own = IsOwnCharacter(s, mover);
        if (own)
            moveFlags |= s.stateMoveFlags.load() & ~uint32(MOVEMENTFLAG_CAN_FLY);
        else
            moveFlags |= s.moverMoveFlags.load();
        if (transport)
            moveFlags |= MOVEMENTFLAG_ONTRANSPORT;
        // The walk's swim and flight state only when the walk drives this unit
        // (an ack for the character while a vehicle is walked reads the
        // character's). FLYING is the walk's own, as a client's physics set it
        // on an airborne can-fly unit: no packet tells the client (the core
        // adds it to a possessed flyer in place, Unit::SetCharmedBy).
        bool const walkIsThis = s.move.active
            && (s.move.moverGuid ? mover->GetGUID().GetRawValue() == s.move.moverGuid : own);
        if (walkIsThis && s.move.flying)
            moveFlags |= MOVEMENTFLAG_FLYING;
        bool const flying = (moveFlags & MOVEMENTFLAG_FLYING) != 0;
        bool const swimming = !transport && !flying && (walkIsThis ? s.move.swimming : mover->IsInWater());
        if (swimming)
            moveFlags = (moveFlags | MOVEMENTFLAG_SWIMMING) & ~uint32(MOVEMENTFLAG_WATERWALKING);
        p << uint32(moveFlags);
        p << uint16(0);             // flags2
        p << uint32(ClientMSTime(s));
        p << float(x) << float(y) << float(z) << float(o);
        if (transport)
        {
            float lx = x, ly = y, lz = z, lo = o;
            transport->CalculatePassengerOffset(lx, ly, lz, &lo);
            p << transport->GetPackGUID();
            p << float(lx) << float(ly) << float(lz) << float(lo);
            p << uint32(transport->GetPathProgress());
            p << int8(-1);          // seat: none (not a vehicle)
        }
        if (swimming || flying)
            p << float(0.0f);       // pitch: level, swimming along the surface or flying straight
        p << uint32(0);             // fallTime
    }

    static void SendMovePacket(BenchSession& s, Unit* mover, uint16 opcode, uint32 moveFlags,
        float x, float y, float z, float o, Transport* transport = nullptr)
    {
        WorldPacket* p = new WorldPacket(opcode, 8 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4);
        *p << mover->GetPackGUID();
        AppendMovementInfo(*p, s, mover, moveFlags, x, y, z, o, transport);
        s.ws->QueuePacket(p);
        s.move.sentO = o;
    }

    // The unit this "client" moves, as the server has it (Player::m_mover):
    // the character, or the vehicle or possessed unit a control handover put
    // in its place (OnClientControlUpdate). Every movement packet carries its
    // guid or the server drops it (HandleMovementOpcodes), so the walk is the
    // mover's: its position, speed, map and water, its guid on the packets.
    // Null when the core holds a mover that is not in the character's map,
    // which no packet could drive.
    static Unit* ActiveMover(Player* player)
    {
        Unit* mover = static_cast<Unit*>(player->m_mover);
        if (!mover)
            return player;
        if (mover != player && (!mover->IsInWorld() || mover->GetMap() != player->GetMap()))
            return nullptr;
        return mover;
    }

    // Whether the walk in flight drives `unit` (MoveState::moverGuid: 0 is
    // the character), for the acks and packets that must restate the walk's
    // point only for the unit being walked.
    static bool WalkDrives(BenchSession const& s, Unit* unit, Player* player)
    {
        MoveState const& m = s.move;
        if (!m.active)
            return false;
        return m.moverGuid ? unit->GetGUID().GetRawValue() == m.moverGuid : unit == player;
    }

    // The rooted state this "client" holds for `mover`: the character's own
    // (BenchSession::rooted) or the controlled unit's (moverRooted).
    static bool RootedFor(BenchSession& s, Unit* mover, Player* player)
    {
        return mover == player ? s.rooted.load() : s.moverRooted.load();
    }

    // A stun, as against a root: UNIT_FLAG_STUNNED on the unit the client
    // moves, a bit of its own UNIT_FIELD_FLAGS, which the server sends this
    // client in the unit's values update (Unit::SetStunned sets it before it
    // roots, and clears it before it unroots). A stun roots the unit by the
    // same packets a root does (SetStunned -> SetRooted -> SendMoveRoot), so
    // the root packets alone cannot tell the two apart; a rooted client still
    // turns, a stunned one neither moves nor turns. The logout countdown sets
    // it too (HandleLogoutRequestOpcode), where a client sits and cannot turn
    // either.
    static bool StunnedFor(Unit* mover)
    {
        return mover->HasUnitFlag(UNIT_FLAG_STUNNED);
    }

    // The transport under a point of the walk, for the character alone: a
    // vehicle or a possessed unit is never walked onto a tram car or a boat.
    static Transport* TransportUnder(BenchSession& s, Unit* mover, float x, float y, float z)
    {
        return IsOwnCharacter(s, mover) ? FindTransportAt(mover->GetMap(), x, y, z) : nullptr;
    }

    // The MovementInfo of a unit as it stands, for the packets a client sends
    // about a unit it is not walking: the mover it hands back
    // (CMSG_MOVE_NOT_ACTIVE_MOVER), the vehicle it leaves or changes seat on
    // (CMSG_DISMISS_CONTROLLED_VEHICLE, CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE)
    // and its own body at the end of a boarding or exit spline
    // (CMSG_MOVE_SPLINE_DONE). The unit's own flags, less what a standing
    // body cannot carry (the moving and turning bits, FALLING, whose jump
    // block the layout would then want, the spline bits, and ROOT, which
    // ReadMovementInfo strips from every client packet), its position, its
    // transport block when it is aboard one (the seat included: that is how
    // a passenger's packets name the seat, Vehicle::AddPassenger), the pitch
    // the swim and fly flags put in the layout, and fallTime 0. The time is
    // the session's own clock, as on every packet of this client's
    // (AppendMovementInfo). Read on the world thread, or from the tap during
    // the core's map update, as AnswerForceRoot reads the character.
    static void AppendUnitMovementInfo(WorldPacket& p, BenchSession& s, Unit* unit)
    {
        uint32 const flags = unit->m_movementInfo.GetMovementFlags()
            & ~uint32(MOVEMENTFLAG_MASK_MOVING | MOVEMENTFLAG_MASK_TURNING | MOVEMENTFLAG_SPLINE_ENABLED | MOVEMENTFLAG_ROOT);
        p << uint32(flags);
        p << uint16(0);             // flags2
        p << uint32(ClientMSTime(s));
        p << float(unit->GetPositionX()) << float(unit->GetPositionY()) << float(unit->GetPositionZ()) << float(unit->GetOrientation());
        if (flags & MOVEMENTFLAG_ONTRANSPORT)
        {
            MovementInfo::TransportInfo const& t = unit->m_movementInfo.transport;
            p.appendPackGUID(t.guid.GetRawValue());
            p << float(t.pos.GetPositionX()) << float(t.pos.GetPositionY()) << float(t.pos.GetPositionZ()) << float(t.pos.GetOrientation());
            p << uint32(t.time);
            p << int8(t.seat);
        }
        if (flags & (MOVEMENTFLAG_SWIMMING | MOVEMENTFLAG_FLYING))
            p << float(unit->m_movementInfo.pitch);
        p << uint32(0);             // fallTime
    }

    // The MovementInfo of an ack for `unit`: the walk's or the server's pose
    // (AppendMovementInfo) — unless the unit sits on a vehicle seat, when it
    // is the seat's: the unit's own block with ONTRANSPORT, the vehicle's
    // guid, the seat offset and the seat (AppendUnitMovementInfo). The
    // handlers apply an ack's MovementInfo whole (HandleMoverRelocation), so
    // an ack during the boarding spline that omitted the seat would take the
    // passenger off it in the server's record.
    static void AppendAckMovementInfo(WorldPacket& p, BenchSession& s, Unit* unit, uint32 moveFlags,
        float x, float y, float z, float o, Transport* transport)
    {
        if (unit->GetVehicle())
            AppendUnitMovementInfo(p, s, unit);
        else
            AppendMovementInfo(p, s, unit, moveFlags, x, y, z, o, transport);
    }

    // Swimming, as the server judges it and a client does it. Every number
    // here is the pinned core's (docs in module/PROTOCOL.md "Swimming"):
    //  - a unit swims once the water over its feet is deeper than 75% of its
    //    collision height (Unit::ProcessTerrainStatusUpdate, "exact mirror of
    //    client logic"; Creature::UpdateMovementFlags uses the same fraction);
    //  - the breath timer runs only while the water over its feet is deeper
    //    than the whole collision height (LIQUID_MAP_UNDER_WATER,
    //    Map::GetLiquidData; Player::ProcessTerrainStatusUpdate).
    // So a swimmer at the surface is held at SWIM_DEPTH_FRACTION of its
    // height plus a margin under the surface: the server's strict ">" sees it
    // swimming, and it is far (a quarter of its height) from the depth that
    // starts the breath timer. GetCollisionHeight includes a mount, so a
    // mounted character wades deeper before it swims, as the core has it.
    static constexpr float SWIM_DEPTH_FRACTION = 0.75f;
    static constexpr float SWIM_DEPTH_MARGIN = 0.05f;
    // A walkable surface more than this above the water is a pier, a dock or
    // a bridge, not the water: nobody swims on planks. The mesh's own water
    // polygons lie on the surface within a voxel or two.
    static constexpr float SWIM_SURFACE_TOLERANCE = 1.0f;

    struct WaterPose
    {
        bool swimming{false};
        float z{0.0f};  // where the body is: the swim depth, the bed when wading, else the mesh's z
    };

    // Where a client's character is over (x, y) when the walkable surface the
    // route gives there is meshZ, from the server's own liquid status
    // (Map::GetLiquidData, the same query IsInWater/IsUnderWater make: ADT
    // and WMO liquid, any type) and the character's collision height now.
    // The route's z says nothing about depth: the navmesh over water is the
    // surface (the mmaps generator keeps a quad's liquid triangles and drops
    // the terrain under them, TerrainBuilder "pick higher one"), and the
    // core's NormalizePath (UpdateAllowedPositionZ) lowers points over deep
    // water to GetMinHeightInWater, ~0.59 of the height, which its own swim
    // test reads as not swimming, and leaves points over shallows on the
    // surface. So the depth is the liquid's own (Level minus the bed,
    // DepthLevel), never Level minus meshZ. Deeper than the threshold:
    // swimming, the body held under the surface as above (never below the
    // bed). Shallower: wading, the body on the bed, at run speed, as a client
    // walks through shallows. World thread.
    static WaterPose WaterPoseAt(Unit* mover, float x, float y, float meshZ)
    {
        WaterPose pose;
        pose.z = meshZ;
        Map* map = mover->GetMap();
        if (!map)
            return pose;
        float const height = mover->GetCollisionHeight();
        LiquidData const liquid = map->GetLiquidData(mover->GetPhaseMask(), x, y, meshZ, height, {});
        if (liquid.Status == LIQUID_MAP_NO_WATER || liquid.Level <= INVALID_HEIGHT || liquid.DepthLevel <= INVALID_HEIGHT
            || liquid.Level <= liquid.DepthLevel)
            return pose;
        if (meshZ > liquid.Level + SWIM_SURFACE_TOLERANCE)
            return pose;
        float const swimDepth = height * SWIM_DEPTH_FRACTION + SWIM_DEPTH_MARGIN;
        if (liquid.Level - liquid.DepthLevel > swimDepth)
        {
            pose.swimming = true;
            pose.z = std::max(liquid.DepthLevel, liquid.Level - swimDepth);
        }
        else if (liquid.DepthLevel < meshZ)
            pose.z = liquid.DepthLevel;
        return pose;
    }

    // How finely WalkEtaMs classifies a route: one WaterPoseAt per this many
    // yards of polyline (at least one per segment), at the middle of each
    // stretch. TickMover reclassifies every tick, so a stretch's pace can be
    // off by at most half a stretch either side of a shoreline.
    static constexpr float ETA_SAMPLE_YARDS = 5.0f;

    // How long a client's character takes over a downward ledge segment it
    // walks off (a forced `drop`, the mesh's or the edge past it): the fall's
    // own time, not a run down the cliff. The core's fall clock
    // (Movement::computeFallTime: gravity to terminal velocity, the time
    // MoveSpline gives a falling spline; the slow-fall terminal velocity under
    // a Feather Fall or Slow Fall aura, which the client's own buff frame
    // shows) over the segment's height, or the time the run takes over its
    // horizontal span when that is longer: a character keeps its forward
    // speed through a fall and covers ground no faster than that. A 143y fall
    // is about 4 s rather than the 20 s a run down its length took, during
    // which the server held the character at the lip.
    static bool IsDropSegment(WbVec const& a, WbVec const& b, float* dzOut);
    static uint64_t FallMs(Unit* mover, WbVec const& a, WbVec const& b)
    {
        float const fall = Movement::computeFallTime(a.z - b.z, mover->HasFeatherFallAura());
        float const run = mover->GetSpeed(MOVE_RUN);
        float const across = std::sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
        float const ride = run > 0.01f ? across / run : 0.0f;
        return uint64_t(std::llround(double(std::max(fall, ride)) * 1000.0));
    }

    struct WalkEta
    {
        uint64_t ms{0};      // 0 when no speed could be read
        float swimYards{0};  // the stretches classified as swimming
        uint32 samples{0};   // WaterPoseAt calls made
    };

    // How long TickMover will take to walk `points`, reported, not modelled:
    // each stretch at the speed the walker drives it at, GetSpeed(MOVE_SWIM)
    // where WaterPoseAt (at the polyline's own z, as PlaceMover passes it)
    // says the body swims and GetSpeed(MOVE_RUN) everywhere else, wading
    // included. The speeds are read once, now, so a mount, a ghost's speed or
    // a slow is in the estimate as it is in the walk's first step; a speed
    // that changes mid-walk is not. `dry` skips the water test for a route the
    // walker never swims (a transport leg: PlaceMover gives a deck no water).
    // Segment lengths are 3D, as `pathLength`. World thread.
    static WalkEta WalkEtaMs(Unit* mover, std::vector<WbVec> const& points, bool dry)
    {
        WalkEta eta;
        float const run = mover->GetSpeed(MOVE_RUN);
        float const swim = mover->GetSpeed(MOVE_SWIM);
        if (!(run > 0.01f) || !(swim > 0.01f))
            return eta;
        double seconds = 0.0;
        for (size_t i = 1; i < points.size(); ++i)
        {
            WbVec const& a = points[i - 1];
            WbVec const& b = points[i];
            float const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
            float const len = std::sqrt(sx * sx + sy * sy + sz * sz);
            if (len <= 0.0001f)
                continue;
            // A ledge in a dispatched route is a forced fall (an unforced one
            // is refused at planning): timed as TickMover times it.
            float dz = 0.0f;
            if (IsDropSegment(a, b, &dz) && dz < 0.0f)
            {
                seconds += double(FallMs(mover, a, b)) / 1000.0;
                continue;
            }
            if (dry)
            {
                seconds += len / run;
                continue;
            }
            uint32 const n = std::max<uint32>(1, uint32(std::ceil(len / ETA_SAMPLE_YARDS)));
            float const step = len / float(n);
            for (uint32 k = 0; k < n; ++k)
            {
                float const t = (float(k) + 0.5f) / float(n);
                bool const swimming = WaterPoseAt(mover, a.x + sx * t, a.y + sy * t, a.z + sz * t).swimming;
                ++eta.samples;
                seconds += step / (swimming ? swim : run);
                if (swimming)
                    eta.swimYards += step;
            }
        }
        eta.ms = uint64_t(std::llround(seconds * 1000.0));
        return eta;
    }

    // A flying mover's route: the straight line a client flies it along, from
    // where it is to the point asked for, at the z asked for. Nothing here
    // reads the mesh. The line is judged against the geometry a client has:
    // the map's line of sight over models and game objects
    // (Map::isInLineOfSight, as the core judges a spell's; it does not see
    // terrain), and the terrain's own height under each sample of the line
    // (Map::GetGridHeight, the ground at x,y whatever z is asked from — a
    // sample inside a hill is below it; GetHeight would search down from the
    // sample and find nothing), so a line into a hillside or through a wall is refused as
    // `path_incomplete` at the last clear sample — the agent flies higher or
    // around. The line's own length is the route (`pathLength`), its time the
    // mover's flight speed over it (FlightEtaMs). One LoS query per sample on
    // a refused line, one for the whole line otherwise.
    static constexpr float FLIGHT_SAMPLE_YARDS = 4.0f;

    struct FlightPlan
    {
        char const* status{nullptr};
        bool hasReached{false};
        WbVec reached{};
    };

    static FlightPlan PlanFlight(Unit* mover, float x, float y, float z, std::vector<WbVec>& points)
    {
        FlightPlan plan;
        Map* map = mover->GetMap();
        WbVec const from{mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ()};
        WbVec const to{x, y, z};
        points.clear();
        points.push_back(from);
        float const sx = to.x - from.x, sy = to.y - from.y, sz = to.z - from.z;
        float const len = std::sqrt(sx * sx + sy * sy + sz * sz);
        uint32 const n = std::max<uint32>(1, uint32(std::ceil(len / FLIGHT_SAMPLE_YARDS)));
        WbVec clear = from;
        for (uint32 k = 1; k <= n; ++k)
        {
            float const t = float(k) / float(n);
            WbVec const at{from.x + sx * t, from.y + sy * t, from.z + sz * t};
            float const terrain = map->GetGridHeight(at.x, at.y);
            bool const underGround = terrain > INVALID_HEIGHT && terrain > at.z + 0.5f;
            bool const seen = !underGround && map->isInLineOfSight(clear.x, clear.y, clear.z, at.x, at.y, at.z,
                mover->GetPhaseMask(), LINEOFSIGHT_ALL_CHECKS, VMAP::ModelIgnoreFlags::Nothing);
            if (!seen)
            {
                plan.status = "path_incomplete";
                plan.hasReached = true;
                plan.reached = clear;
                points.push_back(clear);
                return plan;
            }
            clear = at;
        }
        points.push_back(to);
        return plan;
    }

    // How long the mover flies `points` at its flight speed (the server's
    // MOVE_FLIGHT, every flight-speed aura in it), or its run speed when it
    // has none; 0 when neither can be read. Reported, as WalkEtaMs is.
    static WalkEta FlightEtaMs(Unit* mover, std::vector<WbVec> const& points)
    {
        WalkEta eta;
        float speed = mover->GetSpeed(MOVE_FLIGHT);
        if (!(speed > 0.01f))
            speed = mover->GetSpeed(MOVE_RUN);
        if (!(speed > 0.01f))
            return eta;
        double seconds = 0.0;
        for (size_t i = 1; i < points.size(); ++i)
        {
            WbVec const& a = points[i - 1];
            WbVec const& b = points[i];
            seconds += std::sqrt(std::pow(b.x - a.x, 2.0f) + std::pow(b.y - a.y, 2.0f) + std::pow(b.z - a.z, 2.0f)) / speed;
        }
        eta.ms = uint64_t(std::llround(seconds * 1000.0));
        return eta;
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

    // The closest point on the walkable mesh to (x, y, z) within `radius`
    // yards in 2D (and the core's own +-50y vertically), through the map's
    // Detour query with the filter PathGenerator gives a player
    // (NAV_GROUND | NAV_WATER | NAV_MAGMA). Detour considers at most 128
    // polygons in the box, so in a dense interior the point found is a
    // walkable one near the request rather than provably the nearest. False
    // when no polygon lies in the box. Detour's axis order is (y, z, x).
    static bool NearestMeshPoint(Unit* mover, float x, float y, float z, float radius, WbVec& out)
    {
        dtNavMeshQuery const* query = mover->GetMap()->GetMapCollisionData().GetMMapData().GetNavMeshQuery();
        if (!query)
            return false;
        dtQueryFilter filter;
        filter.setIncludeFlags(NAV_GROUND | NAV_WATER | NAV_MAGMA);
        filter.setExcludeFlags(0);
        float point[3] = { y, z, x };
        float extents[3] = { radius, 50.0f, radius };
        float closest[3] = { 0.0f, 0.0f, 0.0f };
        dtPolyRef ref = 0;
        if (dtStatusFailed(query->findNearestPoly(point, extents, &filter, &ref, closest)) || ref == 0)
            return false;
        out = { closest[2], closest[0], closest[1] };
        return true;
    }

    // The mesh's own height at (x, y): the polygon the core's path builder
    // picks for that point (the same two-stage poly search as
    // PathGenerator::GetPolyByLocation — a 3y x 5y box, then 3y x 50y; the
    // core keeps its end polygon private, so this re-asks the query the way
    // it did), then that polygon's detail height at (x, y) itself. False
    // when the point lies beside the polygon rather than over it: Detour's
    // nearest point is then on the boundary, up to 3y away, and its height
    // is not the ground at (x, y) — lifting to it would hang the character in
    // the air beside a cliff edge.
    static bool MeshHeightAt(Unit* mover, float x, float y, float z, float* out)
    {
        dtNavMeshQuery const* query = mover->GetMap()->GetMapCollisionData().GetMMapData().GetNavMeshQuery();
        if (!query)
            return false;
        dtQueryFilter filter;
        filter.setIncludeFlags(NAV_GROUND | NAV_WATER | NAV_MAGMA);
        filter.setExcludeFlags(0);
        float point[3] = { y, z, x };
        float closest[3] = { 0.0f, 0.0f, 0.0f };
        for (float vertical : { 5.0f, 50.0f })
        {
            float extents[3] = { 3.0f, vertical, 3.0f };
            dtPolyRef ref = 0;
            if (dtStatusFailed(query->findNearestPoly(point, extents, &filter, &ref, closest)) || ref == 0)
                continue;
            float h = 0.0f;
            if (dtStatusFailed(query->getPolyHeight(ref, point, &h)))
                return false;
            *out = h;
            return true;
        }
        return false;
    }

    // The core's NormalizePath settles every path point onto the ground by
    // asking Map::GetHeight from 2y above the point (Z_OFFSET_FIND_HEIGHT in
    // Object.cpp). The last point keeps the z the request asked for, so a
    // request more than 2y under the road looks down from inside the terrain:
    // the terrain is behind it, and the first floor beneath is whatever lies
    // buried there — nothing (the guessed z is kept, 4y deep) or a WMO roof
    // under the hill (Dun Algaz: a tunnel roof 45y down). A client's click
    // lands on the road either way. When the normalized endpoint sits more
    // than END_SINK_MAX below its own polygon's height, the polygon height is
    // the endpoint; the arrival then reports `meshZ` as any mesh-corrected
    // z does. 2y: the same band the core's own normalization tolerates.
    static constexpr float END_SINK_MAX = 2.0f;

    // The ground a character stepping off `edge` lands on at the foot's x,y:
    // the first surface Map::GetHeight finds looking down from just above
    // the edge's height (terrain, vmap and game-object floors, the geometry
    // a client has too). A foot more than FOOT_UNDER_SURFACE below it is
    // inside solid ground — a z the request guessed and the mesh never
    // resolved — and no client falls through terrain, so such a step is
    // refused forced or not. Searching from the edge rather than from the
    // foot is the point: the core's own look from 2y above the foot is what
    // finds nothing (or a buried floor) when the foot is already under the
    // surface. The look starts 1y over the edge: enough for the slope
    // between the edge and a foot a step away (the terrain at the foot sat
    // within 0.3y of the edge in every under-terrain landing of the run that
    // earned this), and not enough to take a floor over the edge's head — a
    // walkway's upper landing beside a 2.4y step down (Stormwind) — for the
    // ground, which a character at the edge is already under.
    // GetHeight sees solid geometry only, so a foot in water under a lip or
    // an overhang (the mesh's water point, Deadmines cove: a foot at -1.2
    // under a surface at 2.3) reads as buried although it is a fall into
    // water. A foot in or on water over its bed is therefore not buried:
    // the swim test's own query (GetLiquidData at the foot) with the swim
    // test's own reading — a valid Level over the bed, and the foot no more
    // than SWIM_SURFACE_TOLERANCE above it (the mesh's water polygons lie on
    // the surface within a voxel or two). Level is the test, not Status: the
    // vmap branch sets Status from the level alone, even for a z under the
    // WMO floor, and fills Level and DepthLevel only for a z at or above the
    // bed (the grid branch the same, within 0.2y), so a foot under a lake
    // bed is still refused.
    static constexpr float FOOT_UNDER_SURFACE = 1.0f;
    static constexpr float EDGE_LOOK_OFFSET = 1.0f;
    static bool FootUnderSurface(Unit* mover, WbVec const& edge, WbVec const& foot, float* surfaceZ)
    {
        Map* map = mover->GetMap();
        float top = edge.z + EDGE_LOOK_OFFSET;
        float search = std::max(DEFAULT_HEIGHT_SEARCH, top - foot.z + FOOT_UNDER_SURFACE);
        float s = map->GetHeight(mover->GetPhaseMask(), foot.x, foot.y, top, true, search);
        if (s <= INVALID_HEIGHT || foot.z >= s - FOOT_UNDER_SURFACE)
            return false;
        LiquidData const liquid = map->GetLiquidData(mover->GetPhaseMask(), foot.x, foot.y, foot.z,
            mover->GetCollisionHeight(), {});
        if (liquid.Status != LIQUID_MAP_NO_WATER && liquid.Level > INVALID_HEIGHT && liquid.DepthLevel > INVALID_HEIGHT
            && liquid.Level > liquid.DepthLevel && foot.z <= liquid.Level + SWIM_SURFACE_TOLERANCE)
            return false;
        *surfaceZ = s;
        return true;
    }

    // How far from its own position the mover looks for walkable mesh when
    // the character stands off it (a graveyard tile the mesh misses, a wedge
    // after a fall, the air over a platform). 10y: a few yards past the 7y
    // at which the core itself calls a start far from any polygon. One run
    // spent 51 hours as a ghost on such a tile, every move refused.
    static constexpr float START_SNAP_RADIUS = 10.0f;

    // How far around a `target_off_mesh` point the module looks for walkable
    // mesh to name in the result (operator decision, 2026-10-05: a bounded
    // nearest point to the agent's own requested point, in the failure only).
    // 20y: five times the mesh's own 4y tolerance — enough to name the road
    // shoulder beside a guessed point, and well inside what a client sees of
    // the ground around a click — while a sweep of such answers still only
    // ever describes the agent's own guesses, never the map.
    static constexpr float TARGET_NEAREST_RADIUS = 20.0f;

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

    // The character's own fall-height reduction (SPELL_AURA_SAFE_FALL, the
    // rogue's Safe Fall and the like), in yards, served on a `drop` so the
    // caller can estimate the fall the way Player::HandleFall will charge it.
    // An aura on self is what the client's own buff frame shows; the number
    // is the client's Spell.dbc reading of it. Omitted when zero.
    static void AddSafeFall(Json::Writer& w, Unit* mover)
    {
        int32 safeFall = mover->GetTotalAuraModifier(SPELL_AURA_SAFE_FALL);
        if (safeFall > 0)
            w.Add("safeFall", (uint32)safeFall);
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

    // ------------------------------------------------- the steep re-plan
    // Detour plans one corridor with the core's cost (dtQueryFilterExt: the
    // distance, weighted mildly by slope), and the smooth path along it can
    // cut a single 4y step of 51-58 degrees: steeper than the drop guard's
    // 1.2 (about 50 degrees), inside the 60 the mesh is built to walk. The
    // guard is the client-faithfulness line and stays as it is; when it
    // refuses the mesh's route, the module plans again with the polygons
    // under the refused segments barred, so the corridor goes around the band
    // when the mesh has a way, and the walk is that route — guarded the same
    // way — or the original `drop`. Pathing detail like the z-ladder and the
    // subdivision retry: the caller sees only the verdict.
    //
    // Up to REPLAN_STEEP_ROUNDS re-plans. The first bars the polygons under
    // every segment of the mesh's route the guard refuses (a 12y climb is
    // three 4y steps, and barring one only moves the refusal to the next);
    // each later one adds those of the previous re-plan's refused segments.
    // It stops at the first route the guard passes, at a round that bars
    // nothing new, or at a re-plan that finds no complete route.
    static constexpr uint32 REPLAN_STEEP_ROUNDS = 3;
    // The re-planned route's reach and corridor are the module planner's
    // (WbNav::PLAN_MAX_POINTS, PLAN_MAX_POLYS), so a re-plan never walks
    // farther than a move without one can.
    static_assert(WbNav::SMOOTH_STEP == SMOOTH_PATH_STEP_SIZE, "WbNav restates the core's smooth-path step");
    static_assert(WbNav::SMOOTH_SLOP == SMOOTH_PATH_SLOP, "WbNav restates the core's smooth-path slop");
    static_assert(WbNav::CORE_POINT_PATH == MAX_POINT_PATH_LENGTH, "WbNav restates the core's point-path cap");
    static_assert(WbNav::PLAYER_FLAGS == (NAV_GROUND | NAV_WATER | NAV_MAGMA), "WbNav restates a player's include flags");
    static_assert(WbNav::WATER_FLAG == NAV_WATER, "WbNav restates the water polygon flag");
    // The core's start/end "far from poly" distance (PathGenerator::BuildPolyPath).
    static constexpr float REPLAN_FAR_FROM_POLY = 7.0f;

    // The player's filter with barred polygons, and the polygon the core's
    // path builder picks for a point: WbNav.h.
    using WbNav::CorePolyAt;
    using WbNav::ExcludePolysFilter;

    // The polygons a route segment lies on: the one under its start, each one
    // a straight walk along the surface toward its end crosses (Detour's
    // raycast corridor), and the one under its end.
    static void SegmentPolys(dtNavMeshQuery const* query, dtQueryFilter const& filter, WbVec const& a, WbVec const& b,
        std::vector<dtPolyRef>& out)
    {
        auto add = [&](dtPolyRef ref) {
            if (ref != 0 && std::find(out.begin(), out.end(), ref) == out.end())
                out.push_back(ref);
        };
        float pa[3] = { a.y, a.z, a.x };
        float pb[3] = { b.y, b.z, b.x };
        dtPolyRef ra = CorePolyAt(query, filter, pa, nullptr);
        if (ra != 0)
        {
            add(ra);
            float t = 0.0f;
            float normal[3] = { 0.0f, 0.0f, 0.0f };
            dtPolyRef crossed[16];
            int n = 0;
            query->raycast(ra, pa, pb, &filter, &t, normal, crossed, &n, 16);
            for (int i = 0; i < n; ++i)
                add(crossed[i]);
        }
        add(CorePolyAt(query, filter, pb, nullptr));
    }

    // One re-plan from `start` to `end` (Detour order, the points the core
    // planned between) with `filter`'s polygons barred, as the core builds a
    // route: findPath over the corridor, the smooth path along it, every point
    // settled on the ground the way NormalizePath does
    // (WorldObject::UpdateAllowedPositionZ). False, with `why`, when the
    // corridor does not reach the end polygon or the route would not fit
    // REPLAN_MAX_POINTS; nothing is walked then.
    static bool PlanAround(Unit* mover, dtNavMesh const* navMesh, dtNavMeshQuery const* query, ExcludePolysFilter const& filter,
        dtPolyRef startRef, dtPolyRef endRef, float const* start, float const* end, std::vector<WbVec>& out, char const** why,
        int* polysOut = nullptr)
    {
        std::vector<float> pts;
        if (!WbNav::PlanCorridor(navMesh, query, filter, startRef, endRef, start, end, WbNav::PLAN_MAX_POINTS, pts, why, polysOut))
            return false;
        out.clear();
        for (size_t i = 0; i + 2 < pts.size(); i += 3)
        {
            WbVec v{ pts[i + 2], pts[i], pts[i + 1] };
            mover->UpdateAllowedPositionZ(v.x, v.y, v.z);
            out.push_back(v);
        }
        return true;
    }

    // The polygon a move from where the character stands paths from: the one
    // under it, else the start snap's (ResolvePathAt). Zero when neither is.
    static dtPolyRef MoverStartPoly(Unit* mover, dtNavMeshQuery const* query)
    {
        ExcludePolysFilter const base;
        float dist = 0.0f;
        float here[3] = { mover->GetPositionY(), mover->GetPositionZ(), mover->GetPositionX() };
        dtPolyRef ref = CorePolyAt(query, base, here, &dist);
        if (ref && dist <= REPLAN_FAR_FROM_POLY)
            return ref;
        WbVec near;
        if (!NearestMeshPoint(mover, here[2], here[0], here[1], START_SNAP_RADIUS, near))
            return 0;
        float snapped[3] = { near.y, near.z, near.x };
        return CorePolyAt(query, base, snapped, nullptr);
    }

    // The walkable mesh nearest (x, y, z) within `radius` that a move from
    // the character's position can reach (WbNav::NearestReachable): the
    // nearest polygon of a closed island the start is not on is no answer,
    // since no route gets there (by the Deadmines entrance the nearest
    // polygon to a guessed point was a 7-polygon island under the hill).
    static bool NearestReachablePoint(Unit* mover, float x, float y, float z, float radius, WbVec& out)
    {
        auto& mmap = mover->GetMap()->GetMapCollisionData().GetMMapData();
        dtNavMesh const* navMesh = mmap.GetNavMesh();
        dtNavMeshQuery const* query = mmap.GetNavMeshQuery();
        if (!navMesh || !query)
            return false;
        float point[3] = { y, z, x };
        float extents[3] = { radius, 50.0f, radius };
        float closest[3] = { 0.0f, 0.0f, 0.0f };
        dtPolyRef ref = 0;
        if (!WbNav::NearestReachable(navMesh, query, MoverStartPoly(mover, query), point, extents, &ref, closest))
            return false;
        out = { closest[2], closest[0], closest[1] };
        return true;
    }

    // The walkable levels of the mesh over or under (x, y) itself within the
    // core's own +-50y poly-search band (PathGenerator::GetPolyByLocation's
    // second box): every ground polygon the vertical line through (x, y)
    // crosses, at its detail height there, that a move from the character's
    // position can reach (an island under the hill is not a level, as in
    // NearestReachablePoint). Heights within MESH_LEVEL_MERGE of each other
    // are one floor — the drop guard's own bound for a step that is walked.
    // The core finds such a polygon but measures its distance to the request
    // in 3D and gives up on an end more than 7y from it (FARFROMPOLY_END), so
    // a request a floor's height under the road is target_off_mesh although
    // the road is directly over it, and Map::GetHeight only looks down from
    // the request, so the ground-z rung never finds a road above it. Returns
    // how many levels there are, with the level in `only` when there is one.
    static constexpr float MESH_COLUMN_HALF = 50.0f;
    static constexpr float MESH_LEVEL_MERGE = 2.0f;
    static size_t MeshLevelsAt(Unit* mover, float x, float y, float z, float* only)
    {
        auto& mmap = mover->GetMap()->GetMapCollisionData().GetMMapData();
        dtNavMesh const* navMesh = mmap.GetNavMesh();
        dtNavMeshQuery const* query = mmap.GetNavMeshQuery();
        if (!navMesh || !query)
            return 0;
        WbNav::ExcludePolysFilter const base;
        float center[3] = { y, z, x };
        float half[3] = { 0.05f, MESH_COLUMN_HALF, 0.05f };
        dtPolyRef polys[64];
        int n = 0;
        if (dtStatusFailed(query->queryPolygons(center, half, &base, polys, &n, 64)))
            return 0;
        dtPolyRef const startRef = MoverStartPoly(mover, query);
        std::vector<float> levels;
        for (int i = 0; i < n; ++i)
        {
            dtMeshTile const* tile = nullptr;
            dtPoly const* poly = nullptr;
            if (dtStatusFailed(navMesh->getTileAndPolyByRef(polys[i], &tile, &poly))
                || poly->getType() == DT_POLYTYPE_OFFMESH_CONNECTION)
                continue;
            float h = 0.0f;
            if (dtStatusFailed(query->getPolyHeight(polys[i], center, &h)) || std::fabs(h - z) > MESH_COLUMN_HALF)
                continue; // beside (x, y), not under it, or outside the band
            if (std::any_of(levels.begin(), levels.end(), [h](float l) { return std::fabs(l - h) <= MESH_LEVEL_MERGE; }))
                continue;
            if (WbNav::OnIsland(navMesh, base, startRef, polys[i], nullptr))
                continue;
            levels.push_back(h);
        }
        if (levels.size() == 1 && only)
            *only = levels.front();
        return levels.size();
    }

    // Two points the mesh's smooth path cannot join although one stands where
    // the other is: within the path's own slop of each other in 2D
    // (WbNav::SMOOTH_SLOP, the core's SMOOTH_PATH_SLOP — the steering skips
    // a corner that close), on one floor (MESH_LEVEL_MERGE), on the same
    // polygon or two linked neighbours — and when two, the core adds a second point
    // to a one-point smooth path only for a one-polygon corridor, so it
    // answers NOPATH and the planner no_route (WbNav::PlanCorridor). Only ever
    // asked after both have failed; a route that exists is always theirs.
    static bool WithinSlop(Unit* mover, WbVec const& a, float x, float y, float z)
    {
        float const dx = a.x - x, dy = a.y - y;
        if (dx * dx + dy * dy > WbNav::SMOOTH_SLOP * WbNav::SMOOTH_SLOP || std::fabs(a.z - z) > MESH_LEVEL_MERGE)
            return false;
        auto& mmap = mover->GetMap()->GetMapCollisionData().GetMMapData();
        dtNavMesh const* navMesh = mmap.GetNavMesh();
        dtNavMeshQuery const* query = mmap.GetNavMeshQuery();
        if (!navMesh || !query)
            return false;
        ExcludePolysFilter const base;
        float pa[3] = { a.y, a.z, a.x };
        float pb[3] = { y, z, x };
        dtPolyRef const ra = CorePolyAt(query, base, pa, nullptr);
        dtPolyRef const rb = CorePolyAt(query, base, pb, nullptr);
        if (!ra || !rb)
            return false;
        if (ra == rb)
            return true;
        // A direct neighbour, by the polygon's own links: exact, where an
        // island test only bounds a component's size (two stacked floors a
        // couple of yards apart are both large and joined by nothing).
        dtMeshTile const* tile = nullptr;
        dtPoly const* poly = nullptr;
        if (dtStatusFailed(navMesh->getTileAndPolyByRef(ra, &tile, &poly)))
            return false;
        for (unsigned int i = poly->firstLink; i != DT_NULL_LINK; i = tile->links[i].next)
            if (tile->links[i].ref == rb)
                return true;
        return false;
    }

    // How far from a request whose own polygon is on an island the walk may
    // end instead, at the reachable mesh nearest it: the core's own
    // far-from-polygon distance (PathGenerator::BuildPolyPath paths to an end
    // up to 7y from its polygon as if it were on it). The Deadmines entrance
    // trigger's centre is 4.4y from the tunnel's end, inside its 7y radius.
    static constexpr float END_REACHABLE_RADIUS = REPLAN_FAR_FROM_POLY;

    // The cause ladder behind a move_to (PROTOCOL.md, WB_MOVE_RESULT.status).
    // Returns status == nullptr with `points` filled on success. Order matters:
    // no_mesh must be tested before CalculatePath, because the core hides a
    // missing tile inside NORMAL|NOT_USING_PATH; the endpoint check is 2D so
    // that a stale z in the request is the mesh's problem (meshZ), not the
    // agent's.
    Manager::PathResolve Manager::ResolvePathAt(Unit* mover, float x, float y, float z, float reqZ, bool force)
    {
        PathResolve r;
        dtNavMesh const* navMesh = mover->GetMap()->GetMapCollisionData().GetMMapData().GetNavMesh();
        if (!HaveNavTile(navMesh, mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ())
            || !HaveNavTile(navMesh, x, y, z))
        {
            r.status = "no_mesh";
            return r;
        }

        // The start: the character's own position when the mesh covers it,
        // else the nearest mesh point within START_SNAP_RADIUS, with the true
        // position prepended to the route so the first leg is the straight
        // walk onto the mesh a client's character would make (a client is not
        // mesh-bound; only the pathfinder is). A path from the character to
        // itself is NORMAL exactly when the start is on the mesh; the core
        // does not otherwise say which end of a failed path was off it.
        float sx = mover->GetPositionX(), sy = mover->GetPositionY(), sz = mover->GetPositionZ();
        {
            PathGenerator probe(mover);
            probe.CalculatePath(sx, sy, sz, false);
            if (probe.GetPathType() & (PATHFIND_NOT_USING_PATH | PATHFIND_FARFROMPOLY_START))
            {
                WbVec near;
                if (!NearestMeshPoint(mover, sx, sy, sz, START_SNAP_RADIUS, near))
                {
                    r.status = "start_off_mesh";
                    return r;
                }
                r.hasSnap = true;
                r.snapX = near.x; r.snapY = near.y; r.snapZ = near.z;
                sx = near.x; sy = near.y; sz = near.z;
            }
        }

        // The end the start can reach. When the polygon the core would path
        // to is on a closed island of the mesh that does not hold the start
        // (a sliver under a WMO floor, a ledge no polygon links to), no
        // search reaches it however long it runs, and the core's partial
        // path ends wherever its heuristic last got: by the Deadmines
        // entrance, the hillside 22y over the tunnel the trigger sits in. The
        // walk ends at the reachable mesh nearest the request instead when
        // that lies within END_REACHABLE_RADIUS (WbNav::OnIsland,
        // NearestReachable). Past it the request stays as asked and ends
        // path_incomplete like any route the mesh does not have: an island is
        // walkable ground, only not from here.
        dtNavMeshQuery const* query = mover->GetMap()->GetMapCollisionData().GetMMapData().GetNavMeshQuery();
        ExcludePolysFilter const base;
        float startPt[3] = { sy, sz, sx };
        dtPolyRef startRef = query ? CorePolyAt(query, base, startPt, nullptr) : 0;
        if (query)
        {
            float endPt[3] = { y, z, x };
            dtPolyRef endRef = CorePolyAt(query, base, endPt, nullptr);
            // The start the end can reach. The polygon the core picks for the
            // start is the nearest in its box, and at a two-level spot that
            // can be a closed island under the level that links onward: by
            // the Deadmines pool past the first boss, a 6-polygon floor under
            // the water surface's polygons, from which every route ended at
            // the floor's edge (path_incomplete) while a step onto the
            // surface's footprint walked on. When the start's polygon is on
            // an island that does not hold the end, the route is planned from
            // the reachable water surface directly over the start
            // (WbNav::ReachableStartLevel) and still begins where the start
            // is (SettleRoute): the same column, so there is no leg to walk
            // onto it — a swim up, as a client's character in the pool does.
            // Without such a level the start stays as it is.
            {
                dtPolyRef levelRef = 0;
                float level[3] = { 0.0f, 0.0f, 0.0f };
                uint32_t islandPolys = 0;
                if (WbNav::ReachableStartLevel(navMesh, query, startRef, endRef, startPt, &levelRef, level, &islandPolys))
                {
                    r.hasStartLevel = true;
                    r.levelFromX = sx; r.levelFromY = sy; r.levelFromZ = sz;
                    r.levelZ = level[1];
                    r.levelIslandPolys = islandPolys;
                    sz = level[1];
                    startPt[1] = sz;
                    startRef = levelRef;
                }
            }
            std::vector<dtPolyRef> island;
            if (endRef && WbNav::OnIsland(navMesh, base, startRef, endRef, &island))
            {
                r.islandPolys = uint32(island.size());
                float extents[3] = { END_REACHABLE_RADIUS, END_REACHABLE_RADIUS, END_REACHABLE_RADIUS };
                float closest[3] = { 0.0f, 0.0f, 0.0f };
                dtPolyRef ref = 0;
                if (WbNav::NearestReachable(navMesh, query, startRef, endPt, extents, &ref, closest)
                    && dtVdist(closest, endPt) <= END_REACHABLE_RADIUS)
                {
                    r.hasEndReachable = true;
                    r.endFromX = x; r.endFromY = y; r.endFromZ = z;
                    x = closest[2]; y = closest[0]; z = closest[1];
                    r.endToX = x; r.endToY = y; r.endToZ = z;
                }
            }
        }

        PathGenerator gen(mover);
        bool built = gen.CalculatePath(sx, sy, sz, x, y, z, false);
        PathType type = gen.GetPathType();
        Movement::PointsArray const& pts = gen.GetPath();

        if (!built || (type & PATHFIND_NOT_USING_PATH))
        {
            // The start is on the mesh (or snapped onto it), so the poly
            // missing is under the target.
            r.status = "target_off_mesh";
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

        // The route the mesh has toward the request when it has none to it:
        // the core's partial path as far as it got, else the planned start
        // alone. A path_incomplete hands it to TryEdgeDrop. When that route
        // itself steps down a ledge on its way to its end, the edge past the
        // end is a second fall and is refused (`second_ledge`); the walk on is
        // then tried once more from the route's start, where the character
        // stands, toward the same request, under the same rules — one fall,
        // a descent. A ghost released onto a two-polygon terrace below the
        // Skettis ledge had every move refused so: its route ran down the
        // terrace's own 3.8y step, and off its edge from there.
        std::vector<WbVec> partial;
        auto incomplete = [&]() {
            r.status = "path_incomplete";
            // Already where the request is (WithinSlop: within the smooth
            // path's slop on a neighbouring polygon, which neither the core nor
            // the planner joins): the walk is the step to it, settled like any
            // route. Audited as move_end_slop.
            if (WithinSlop(mover, { sx, sy, sz }, x, y, z))
            {
                r.status = nullptr;
                r.hasReached = false;
                r.slopEnd = true;
                r.points = { { sx, sy, sz }, { x, y, sz } };
                SettleRoute(mover, r, z, reqZ, force);
                return r;
            }
            if (!partial.empty())
                TryEdgeDrop(mover, partial, x, y, z, reqZ, force, r);
            bool routeLedge = false; // the route itself steps down a ledge on its way to its end
            for (size_t i = 0; i + 1 < partial.size() && !routeLedge; ++i)
                routeLedge = IsDropSegment(partial[i], partial[i + 1], nullptr);
            if (r.status && std::strcmp(r.edgeDrop.reason, "second_ledge") == 0 && routeLedge)
            {
                PathResolve::EdgeDrop const first = r.edgeDrop;
                r.edgeDrop = PathResolve::EdgeDrop{};
                TryEdgeDrop(mover, std::vector<WbVec>{ partial.front() }, x, y, z, reqZ, force, r);
                if (!r.edgeDrop.tried)
                    r.edgeDrop = first; // the request is not below the start: the first answer stands
                else
                {
                    r.edgeDrop.fromStart = true;
                    r.edgeDrop.firstReason = first.reason;
                }
            }
            return r;
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
            //
            // Where the mesh got is the partial path's last point, except when
            // that point is the request itself: a corridor of the start
            // polygon alone ends there (FindSmoothPath's same-polygon case
            // steers to the request and appends it once it reaches the
            // polygon's edge), and so does a shortcut (BuildShortcut: SHORT,
            // NOPATH). That point is not on any route; a subdivision from it
            // is the request to itself, trivially complete, and the splice
            // walked the straight line between (71y from the Deadmines pool
            // toward a patrol, through a hollow 15y from any polygon, where
            // the character was then start_off_mesh). So the
            // request is left off, and the mesh got no farther than the point
            // before it.
            size_t got = pts.size();
            if (got >= 2)
            {
                float const dx = pts[got - 1].x - x, dy = pts[got - 1].y - y;
                if (dx * dx + dy * dy < 0.01f)
                    --got;
            }
            bool nonTrivial = got >= 2;
            if (nonTrivial)
            {
                G3D::Vector3 const& a = pts.front();
                G3D::Vector3 const& b = pts[got - 1];
                nonTrivial = (a - b).squaredLength() > 1.0f;
            }
            if (nonTrivial)
            {
                G3D::Vector3 const& mid = pts[got - 1];
                PathGenerator leg2(mover);
                bool built2 = leg2.CalculatePath(mid.x, mid.y, mid.z, x, y, z, false);
                if (built2 && IsCompletePath(leg2.GetPathType(), leg2.GetPath()) && endpointOk(leg2))
                {
                    for (size_t i = 0; i < got; ++i)
                        r.points.push_back({pts[i].x, pts[i].y, pts[i].z});
                    Movement::PointsArray const& pts2 = leg2.GetPath();
                    for (size_t i = 1; i < pts2.size(); ++i) // pts2[0] == mid
                        r.points.push_back({pts2[i].x, pts2[i].y, pts2[i].z});
                }
                else
                {
                    r.hasReached = true;
                    r.reachedX = mid.x; r.reachedY = mid.y; r.reachedZ = mid.z;
                    for (size_t i = 0; i < got; ++i)
                        partial.push_back({pts[i].x, pts[i].y, pts[i].z});
                }
            }
            else
            {
                r.hasReached = true;
                r.reachedX = mover->GetPositionX(); r.reachedY = mover->GetPositionY(); r.reachedZ = mover->GetPositionZ();
                partial.push_back({sx, sy, sz});
            }
            // Neither the core's path nor the subdivision reached the end:
            // the module's planner (WbNav::PlannerQuery) searches the whole
            // corridor the core's 74 polygons and 1024 nodes cannot hold — the
            // Deadmines mine is 177 polygons — exactly as the core would with
            // room to finish. Only what it cannot route is path_incomplete; an
            // end known to be on an island is not searched for at all.
            if (r.hasReached && r.islandPolys && !r.hasEndReachable)
                return incomplete();
            if (r.hasReached)
            {
                float endPt[3] = { y, z, x };
                dtPolyRef endRef = query ? CorePolyAt(query, base, endPt, nullptr) : 0;
                dtNavMeshQuery const* plan = WbNav::PlannerQuery(navMesh);
                char const* why = "";
                int polys = 0;
                std::vector<WbVec> planned;
                if (!plan || !startRef || !endRef
                    || !PlanAround(mover, navMesh, plan, base, startRef, endRef, startPt, endPt, planned, &why, &polys))
                    return incomplete();
                WbVec const& last = planned.back();
                float ex = last.x - x, ey = last.y - y;
                if (ex * ex + ey * ey > 16.0f) // endpointOk: within 4y of the end, 2D
                    return incomplete();
                r.hasReached = false;
                r.longPlan = true;
                r.longPolys = uint32(polys);
                r.points = std::move(planned);
            }
        }

        if (r.points.size() < 2)
        {
            r.status = "path_incomplete";
            return r;
        }
        std::vector<size_t> refusing;
        SettleRoute(mover, r, z, reqZ, force, &refusing);
        if (r.status && std::strcmp(r.status, "drop") == 0)
            ReplanSteep(mover, sx, sy, sz, x, y, z, reqZ, force, refusing, r);
        return r;
    }

    void Manager::SettleRoute(Unit* mover, PathResolve& r, float z, float reqZ, bool force, std::vector<size_t>* refusing)
    {
        // The endpoint: the core's normalization keeps a requested z that
        // sits under the terrain (see END_SINK_MAX). The polygon the path
        // ends on knows the ground; when the normalized point is under it by
        // more than the band, the polygon height is where the walk ends.
        {
            WbVec& end = r.points.back();
            float polyZ = 0.0f;
            if (MeshHeightAt(mover, end.x, end.y, z, &polyZ) && end.z < polyZ - END_SINK_MAX)
            {
                r.hasEndLift = true;
                r.endLiftFrom = end.z;
                end.z = polyZ;
            }
        }
        // A route planned from the water surface over the start
        // begins at the start itself, in the same column: the first segment
        // is the walk from where the start is to the route's next point, and
        // the guard below judges it like any other.
        if (r.hasStartLevel && !r.points.empty())
            r.points.front() = { r.levelFromX, r.levelFromY, r.levelFromZ };
        if (r.hasSnap)
            r.points.insert(r.points.begin(), { mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ() });
        // Per-segment drop guard over the whole polyline (the main path and,
        // when spliced, the leg2 continuation): the walk is not dispatched.
        // `points` is kept so the move_path audit shows the route that fell.
        // A forced request walks a downward step: the fall is the server's
        // to judge (TickMover sends the landing a client would). A step up is
        // refused whatever the request says — a client's character cannot
        // walk up a ledge the mesh calls a climb, and heartbeats that climb
        // it are the server-side shortcut the contract forbids. So is a step
        // whose foot lies under the ground (FootUnderSurface): no client
        // falls through terrain, and the foot is reported with the surface
        // it is under so the caller does not ask again with force. The
        // verdict is the first refused segment; with `refusing` the scan goes
        // on to list the rest for the steep re-plan.
        for (size_t i = 0; i + 1 < r.points.size(); ++i)
        {
            float dz = 0.0f;
            if (!IsDropSegment(r.points[i], r.points[i + 1], &dz))
                continue;
            float surfaceZ = 0.0f;
            bool buried = dz < 0.0f && FootUnderSurface(mover, r.points[i], r.points[i + 1], &surfaceZ);
            if (!force || dz > 0.0f || buried)
            {
                if (refusing)
                    refusing->push_back(i);
                if (r.status)
                    continue;
                r.status = "drop";
                r.hasReached = true;
                r.reachedX = r.points[i].x; r.reachedY = r.points[i].y; r.reachedZ = r.points[i].z;
                r.hasDrop = true;
                r.dropDz = dz;
                r.hasSurfaceZ = buried;
                r.surfaceZ = surfaceZ;
                if (!refusing)
                    return;
            }
        }
        if (r.status)
            return;
        float endZ = r.points.back().z;
        if (std::fabs(endZ - reqZ) > 1.0f)
        {
            r.hasMeshZ = true;
            r.meshZ = endZ;
        }
    }

    // The steep re-plan (see REPLAN_STEEP_ROUNDS). `r` holds the guard's
    // `drop` on the mesh's own route from (sx, sy, sz), the point the core
    // planned from (the snapped start when the character stood off the mesh);
    // `refusing` lists that route's refused segments. Each re-plan is a whole
    // route from the same start to the same end, settled by the same tail
    // (SettleRoute: endpoint lift, start-snap leg, guard), so a route the
    // guard passes is walked like any other and a route it refuses is never
    // walked. The start and end polygons are never barred: the first is
    // where the character stands, the second is where it asked to go.
    void Manager::ReplanSteep(Unit* mover, float sx, float sy, float sz, float x, float y, float z, float reqZ,
        bool force, std::vector<size_t> const& refusing, PathResolve& r)
    {
        PathResolve::Replan rp;
        rp.ran = true;
        rp.firstPoints = uint32(r.points.size());
        rp.edge = { r.reachedX, r.reachedY, r.reachedZ };
        rp.dz = r.dropDz;
        auto finish = [&](char const* outcome, char const* reason) {
            rp.outcome = outcome;
            rp.reason = reason;
            r.replan = rp;
        };

        auto& mmap = mover->GetMap()->GetMapCollisionData().GetMMapData();
        dtNavMesh const* navMesh = mmap.GetNavMesh();
        dtNavMeshQuery const* query = mmap.GetNavMeshQuery();
        if (!navMesh || !query)
            return finish("skipped", "no_mesh_query");
        // The re-plans search with the module planner's node pool: the same
        // routes as the core's query wherever that one does not run out.
        dtNavMeshQuery const* plan = WbNav::PlannerQuery(navMesh);
        if (!plan)
            plan = query;

        ExcludePolysFilter const base;
        float start[3] = { sy, sz, sx };
        float end[3] = { y, z, x };
        float distStart = 0.0f, distEnd = 0.0f;
        dtPolyRef startRef = CorePolyAt(query, base, start, &distStart);
        dtPolyRef endRef = CorePolyAt(query, base, end, &distEnd);
        if (!startRef || !endRef || distStart > REPLAN_FAR_FROM_POLY || distEnd > REPLAN_FAR_FROM_POLY)
            return finish("skipped", "far_from_poly");

        std::vector<dtPolyRef> excluded;
        ExcludePolysFilter const filter(&excluded);
        // The route whose refused segments feed the next round; the mesh's
        // own first. Its first segment is the walk onto the mesh when the
        // start was snapped, which is not a mesh segment to plan around.
        std::vector<WbVec> route = r.points;
        std::vector<size_t> segs = refusing;
        for (uint32 round = 1; round <= REPLAN_STEEP_ROUNDS; ++round)
        {
            size_t before = excluded.size();
            std::vector<dtPolyRef> under;
            for (size_t i : segs)
            {
                if (r.hasSnap && i == 0)
                    continue;
                SegmentPolys(query, base, route[i], route[i + 1], under);
            }
            for (dtPolyRef ref : under)
                if (ref != startRef && ref != endRef && std::find(excluded.begin(), excluded.end(), ref) == excluded.end())
                    excluded.push_back(ref);
            if (excluded.size() == before)
                return finish(round == 1 ? "skipped" : "failed", "nothing_to_exclude");

            rp.rounds = round;
            rp.excluded = uint32(excluded.size());
            PathResolve cand;
            cand.hasSnap = r.hasSnap;
            cand.snapX = r.snapX; cand.snapY = r.snapY; cand.snapZ = r.snapZ;
            cand.hasStartLevel = r.hasStartLevel;
            cand.levelFromX = r.levelFromX; cand.levelFromY = r.levelFromY; cand.levelFromZ = r.levelFromZ;
            cand.levelZ = r.levelZ;
            cand.levelIslandPolys = r.levelIslandPolys;
            char const* why = "";
            if (!PlanAround(mover, navMesh, plan, filter, startRef, endRef, start, end, cand.points, &why))
                return finish("failed", why);
            // The core's endpoint check (ResolvePathAt's endpointOk): the
            // route ends within 4y of the request in 2D.
            WbVec const& last = cand.points.back();
            float ex = last.x - x, ey = last.y - y;
            if (ex * ex + ey * ey > 16.0f)
                return finish("failed", "end_short");

            std::vector<size_t> again;
            SettleRoute(mover, cand, z, reqZ, force, &again);
            rp.points = uint32(cand.points.size());
            if (!cand.status)
            {
                rp.outcome = "ok";
                rp.reason = "";
                cand.replan = rp;
                r = std::move(cand);
                return;
            }
            route = std::move(cand.points);
            segs = std::move(again);
        }
        finish("failed", "drop");
    }

    // ------------------------------------------------- the edge drop
    // The mesh is built per connected surface, and a plateau whose sides are
    // too steep to walk is a component of its own: no mesh route from it
    // contains a ledge step, so the drop guard never sees one and every move
    // down is path_incomplete (a ghost released on the Skettis plateau, 143y
    // over its corpse, was refused every way down for two days). A client's
    // character walks off any edge. When the request lies below the end of
    // the mesh's route, the module walks on from that end toward the request
    // over the ground a client walks, to the edge where the ground falls
    // away, falls from there to the surface below, and routes on from the
    // landing to the request (operator decision, 2026-10-28). The fall is a
    // segment like a mesh ledge, settled by the same guard (SettleRoute) and
    // walked by the same packets (TickMover): `drop` unforced, walked forced.
    //
    // The ground is sampled every EDGE_SAMPLE_STEP yards: the step at which
    // the guard's two bounds meet (DROP_MIN_DZ over DROP_SLOPE, 1.67y), so a
    // pair of samples is a ledge exactly when the slope between them is
    // steeper than the guard's ramp, and no lip the guard would call one
    // passes between two samples.
    static constexpr float EDGE_SAMPLE_STEP = DROP_MIN_DZ / DROP_SLOPE;

    // The surface a character over (x, y) stands or lands on, looking down
    // from `top`: the first solid surface Map::GetHeight finds (terrain, vmap
    // and game-object floors, the geometry a client has), or the water over
    // it when there is any (the mesh's water polygons lie on the surface, as
    // FootUnderSurface reads the liquid). INVALID_HEIGHT when there is no
    // surface within `search`. `climb` when the terrain itself rises over
    // `top` there: GetHeight does not see terrain over the point it looks
    // from, and would answer with what lies under it.
    static float SurfaceUnder(Unit* mover, float x, float y, float top, float search, bool* climb)
    {
        Map* map = mover->GetMap();
        *climb = map->GetGridHeight(x, y) > top;
        if (*climb)
            return INVALID_HEIGHT;
        float const g = map->GetHeight(mover->GetPhaseMask(), x, y, top, true, search);
        if (g <= INVALID_HEIGHT)
            return INVALID_HEIGHT;
        LiquidData const liquid = map->GetLiquidData(mover->GetPhaseMask(), x, y, g, mover->GetCollisionHeight(), {});
        if (liquid.Status != LIQUID_MAP_NO_WATER && liquid.Level > INVALID_HEIGHT && liquid.DepthLevel > INVALID_HEIGHT
            && liquid.Level > g && liquid.Level <= top)
            return liquid.Level;
        return g;
    }

    void Manager::TryEdgeDrop(Unit* mover, std::vector<WbVec> const& partial, float x, float y, float z, float reqZ,
        bool force, PathResolve& r)
    {
        WbVec const from = partial.back();
        // Only a descent: a request at or above the route's end (within the
        // guard's own step) is not below any edge of it.
        if (!(z < from.z - DROP_MIN_DZ))
            return;
        PathResolve::EdgeDrop ed;
        ed.tried = true;
        ed.from = from;
        auto refuse = [&](char const* reason) {
            ed.reason = reason;
            r.edgeDrop = ed;
        };

        float const dx = x - from.x, dy = y - from.y;
        float const dist = std::sqrt(dx * dx + dy * dy);
        if (dist < 0.01f)
            return refuse("no_direction");
        float const ux = dx / dist, uy = dy / dist;
        Map* map = mover->GetMap();
        uint32 const phase = mover->GetPhaseMask();
        float const body = mover->GetCollisionHeight();
        // The body's line between two points: a wall, a model or a
        // game-object in the way (Map::isInLineOfSight; terrain is not in
        // it, and is the samples' own ground reads).
        auto clear = [&](WbVec const& a, float az, WbVec const& b, float bz) {
            return map->isInLineOfSight(a.x, a.y, az + body, b.x, b.y, bz + body, phase,
                LINEOFSIGHT_ALL_CHECKS, VMAP::ModelIgnoreFlags::Nothing);
        };
        // The look's own line: level at the height a sample's surface is read
        // from (`top`), from the last sample to this one. Map::GetHeight looks
        // down from `top` and sees nothing over it, and SurfaceUnder's grid
        // test covers only terrain rising over it; a model or game-object
        // surface that does (a ramp or an arched deck rising more than the
        // look between two samples) would let the look pass under it to the
        // floor below — a fall through a deck no client falls through. Any
        // such surface between the two samples crosses this line, which
        // Map::isInLineOfSight sees: refused as the climb it is. A surface
        // rising less than the look lies under the line and is the one read.
        auto lookClear = [&](WbVec const& a, WbVec const& b, float top) {
            return map->isInLineOfSight(a.x, a.y, top, b.x, b.y, top, phase,
                LINEOFSIGHT_ALL_CHECKS, VMAP::ModelIgnoreFlags::Nothing);
        };

        // The walk on: sample by sample from the route's end toward the
        // request, each sample's ground read from just over the last one
        // (FootUnderSurface's EDGE_LOOK_OFFSET), every pair a walkable slope
        // (IsDropSegment) with nothing in the body's way, until a pair falls
        // away: the first of it is the edge. A rise the look does not reach
        // is a climb and ends the attempt — a step up is never taken. The
        // walk on is bounded by START_SNAP_RADIUS, the straight leg the
        // module already walks onto the mesh from an off-mesh start, here in
        // the other direction: no sample, the one past the lip included, lies
        // farther than that from the route's end, nor past the request.
        float const reach = std::min(dist, START_SNAP_RADIUS);
        std::vector<WbVec> walk;
        WbVec prev = from;
        float travelled = 0.0f;
        WbVec foot;
        float footT = 0.0f;
        for (;;)
        {
            if (travelled >= reach)
                return refuse("no_edge");
            float const t = std::min(travelled + EDGE_SAMPLE_STEP, reach);
            WbVec next{ from.x + ux * t, from.y + uy * t, 0.0f };
            float const top = prev.z + EDGE_LOOK_OFFSET;
            if (!lookClear(prev, next, top))
                return refuse("climb");
            bool climb = false;
            // The look reaches the request's own height and the default
            // search past it, so a fall toward the request finds its floor.
            float const s = SurfaceUnder(mover, next.x, next.y, top, std::max(DEFAULT_HEIGHT_SEARCH, top - z + DEFAULT_HEIGHT_SEARCH), &climb);
            if (climb)
                return refuse("climb");
            if (s <= INVALID_HEIGHT)
                return refuse("no_surface");
            next.z = s;
            float dz = 0.0f;
            if (IsDropSegment(prev, next, &dz))
            {
                foot = next;
                footT = t;
                break;
            }
            if (!clear(prev, prev.z, next, next.z))
                return refuse("blocked");
            walk.push_back(next);
            prev = next;
            travelled = t;
        }
        WbVec const edge = prev;
        ed.walkYards = travelled;

        // The fall, as a client's body falls. It leaves the edge at the run
        // speed the walker drives it at (GetSpeed(MOVE_RUN): a ghost's
        // faster run included) and keeps that speed forward while it drops
        // by the core's own fall clock (Movement::computeFallElevation: the
        // curve MoveSpline gives a falling spline, Feather Fall's slower
        // terminal velocity included). Sample by sample along the line it
        // lands where that arc first meets the surface under it — so it
        // clears a shelf narrower than its flight, as a running client does,
        // and lands on one wider; the arc's own line, at the feet and at body
        // height, must be clear of models, and where it is not the body comes
        // down in the last column it crossed. On the ground it falls on only
        // down a pair steeper than the guard's ramp (a face no client stands
        // on, whatever the mesh says) and stops at the first pair that is not:
        // that is where it lands. The Skettis face, 109y over 30y, has a
        // patch 1.98y over one sample 6y down it, under the guard's 2y: a
        // body that stepped off would catch there, mid-face; the arc passes
        // over it and meets the face 23y out, which it slides down to its
        // foot. Still in the air at the request, the body comes down there:
        // a slower start (any forward speed up to the run is a client's) puts
        // the arc onto the surface at the request, if that arc clears the
        // ground before it. Bounded in practice by the fall itself: the arc
        // ends at its contact, the face at its first walkable pair, so flat
        // ground ends the run at the next sample; never past the request.
        float const run = mover->GetSpeed(MOVE_RUN);
        if (!(run > 0.01f))
            return refuse("no_speed");
        bool const slowFall = mover->HasFeatherFallAura();
        float const fallSearch = std::max(DEFAULT_HEIGHT_SEARCH, edge.z + EDGE_LOOK_OFFSET - z + DEFAULT_HEIGHT_SEARCH);
        auto bodyAt = [&](float t, float speed) { // the arc's height at `t` yards along the line
            return edge.z - Movement::computeFallElevation((t - travelled) / speed, slowFall);
        };
        struct Column { float t; WbVec ground; };
        std::vector<Column> air;  // the columns the arc crossed, with the ground under each
        WbVec landing = foot;
        float landT = footT;
        bool touched = false;
        {
            WbVec prevArc = edge;
            for (float t = footT; ; t = std::min(t + EDGE_SAMPLE_STEP, dist))
            {
                float const body = bodyAt(t, run);
                WbVec here{ from.x + ux * t, from.y + uy * t, body };
                // Something in the arc's way: the body comes down in the last
                // column it crossed (the edge's own, before the first).
                if (!map->isInLineOfSight(prevArc.x, prevArc.y, prevArc.z + EDGE_LOOK_OFFSET, here.x, here.y, here.z + EDGE_LOOK_OFFSET,
                        phase, LINEOFSIGHT_ALL_CHECKS, VMAP::ModelIgnoreFlags::Nothing)
                    || !clear(prevArc, prevArc.z, here, here.z))
                {
                    if (air.empty())
                        return refuse("blocked");
                    landing = air.back().ground;
                    landT = air.back().t;
                    touched = true;
                    break;
                }
                bool climb = false;
                float const s = SurfaceUnder(mover, here.x, here.y, body + EDGE_LOOK_OFFSET, fallSearch, &climb);
                if (s <= INVALID_HEIGHT && !climb)
                    return refuse("no_surface");
                if (climb || s >= body)
                {
                    // The arc meets the ground here (terrain over the look is
                    // ground it ran into on the way: the column before).
                    if (climb && air.empty())
                        return refuse("climb");
                    landing = climb ? air.back().ground : WbVec{ here.x, here.y, s };
                    landT = climb ? air.back().t : t;
                    touched = true;
                    break;
                }
                air.push_back({ t, { here.x, here.y, s } });
                prevArc = here;
                if (t >= dist)
                    break;
            }
        }
        if (!touched)
        {
            // In the air over the request: the slower start whose arc comes
            // down on the surface there, which must clear the ground before it
            // and, step by step, the same two lines the run's arc is held to.
            Column const& at = air.back();
            float const secs = Movement::computeFallTime(edge.z - at.ground.z, slowFall);
            float const speed = secs > 0.0f ? (at.t - travelled) / secs : run;
            WbVec prevArc = edge;
            for (Column const& c : air)
            {
                WbVec const here{ c.ground.x, c.ground.y, c.t < at.t ? bodyAt(c.t, speed) : at.ground.z };
                if (c.t < at.t && here.z < c.ground.z)
                    return refuse("air_to_request");
                if (!map->isInLineOfSight(prevArc.x, prevArc.y, prevArc.z + EDGE_LOOK_OFFSET, here.x, here.y, here.z + EDGE_LOOK_OFFSET,
                        phase, LINEOFSIGHT_ALL_CHECKS, VMAP::ModelIgnoreFlags::Nothing)
                    || !clear(prevArc, prevArc.z, here, here.z))
                    return refuse("air_to_request");
                prevArc = here;
            }
            landing = at.ground;
            landT = at.t;
        }
        else
        {
            // On the ground: down a face steeper than the ramp, no farther.
            for (float t = landT; t < dist; )
            {
                t = std::min(t + EDGE_SAMPLE_STEP, dist);
                WbVec next{ from.x + ux * t, from.y + uy * t, 0.0f };
                float const top = landing.z + EDGE_LOOK_OFFSET;
                if (!lookClear(landing, next, top))
                    break;
                bool climb = false;
                float const s = SurfaceUnder(mover, next.x, next.y, top, fallSearch, &climb);
                if (climb || s <= INVALID_HEIGHT)
                    break;
                next.z = s;
                float dz = 0.0f;
                if (!IsDropSegment(landing, next, &dz) || dz >= 0.0f || !clear(landing, landing.z, next, next.z))
                    break;
                landing = next;
            }
        }
        ed.hasEdge = true;
        ed.edge = edge;
        ed.landing = landing;
        // A short drop onto level ground comes down a few yards out at a run,
        // too far for the guard to call the edge-to-landing segment a ledge;
        // stepped off instead (the slowest start), the body lands at the
        // foot, which the walk on found a ledge below the edge.
        {
            float adz = 0.0f;
            if (!IsDropSegment(edge, landing, &adz) || adz >= 0.0f)
                landing = foot;
        }
        // The edge-to-landing segment is one the guard calls a ledge, so it
        // is walked as one: a heartbeat at the edge, the landing at the foot.
        float fallDz = 0.0f;
        if (!IsDropSegment(edge, landing, &fallDz) || fallDz >= 0.0f)
            return refuse("not_a_ledge");

        // The leg below, from the landing to the request: from the mesh under
        // the landing when the request can be reached from it, else from the
        // walkable mesh nearest the landing within START_SNAP_RADIUS that is
        // not on a closed island apart from the request's polygon
        // (WbNav::NearestReachable, as an island end is walked to its
        // reachable mesh), with the straight walk onto it clear at body
        // height. The foot of a cliff is where the mesh is broken up around
        // whatever stands there: at Skettis the nearest polygon to the
        // landing is a 2-polygon island 0.1y off, the main mesh 1.4y. A
        // landing on a cliff's face, whose nearest such mesh is the plateau,
        // is a climb the one-ledge rule below refuses. The core's path, else
        // the module's planner, as ResolvePathAt; it must end within 4y of
        // the request.
        auto& mmap = map->GetMapCollisionData().GetMMapData();
        dtNavMesh const* navMesh = mmap.GetNavMesh();
        dtNavMeshQuery const* query = mmap.GetNavMeshQuery();
        ExcludePolysFilter const base;
        float endPt[3] = { y, z, x };
        dtPolyRef const endRef = query ? CorePolyAt(query, base, endPt, nullptr) : 0;
        WbVec start = landing;
        std::vector<WbVec> snapWalk; // the ground between the landing and the mesh it walks onto
        {
            PathGenerator probe(mover);
            probe.CalculatePath(landing.x, landing.y, landing.z, landing.x, landing.y, landing.z, false);
            float landPt[3] = { landing.y, landing.z, landing.x };
            dtPolyRef const landRef = query ? CorePolyAt(query, base, landPt, nullptr) : 0;
            if ((probe.GetPathType() & (PATHFIND_NOT_USING_PATH | PATHFIND_FARFROMPOLY_START))
                || !landRef || (navMesh && WbNav::OnIsland(navMesh, base, endRef, landRef)))
            {
                float extents[3] = { START_SNAP_RADIUS, 50.0f, START_SNAP_RADIUS };
                float closest[3] = { 0.0f, 0.0f, 0.0f };
                dtPolyRef ref = 0;
                if (!navMesh || !query || !WbNav::NearestReachable(navMesh, query, endRef, landPt, extents, &ref, closest))
                    return refuse("landing_off_mesh");
                start = { closest[2], closest[0], closest[1] };
                ed.landingSnap = true;
                ed.snapTo = start;
                ed.snapYards = std::sqrt((start.x - landing.x) * (start.x - landing.x)
                    + (start.y - landing.y) * (start.y - landing.y) + (start.z - landing.z) * (start.z - landing.z));
                // The walk onto it is walked on the ground under the walk on's
                // own rule: each sample's surface read from 1y over the last,
                // nothing rising past that (terrain by its height, a model by
                // the look's line), no pair a ledge (that would be a second
                // fall), nothing at body height in the way. The search box
                // is the start snap's, 50y deep, so without this a snap to
                // mesh over a face or across a gap would be walked through
                // the air or the rock.
                float const sx = start.x - landing.x, sy = start.y - landing.y;
                float const len = std::sqrt(sx * sx + sy * sy);
                if (len < 0.01f && !clear(landing, landing.z, start, start.z))
                    return refuse("blocked"); // straight up or down onto it: the body's line alone
                WbVec p = landing;
                for (float t = 0.0f; t < len; )
                {
                    t = std::min(t + EDGE_SAMPLE_STEP, len);
                    WbVec n{ landing.x + sx * t / len, landing.y + sy * t / len, 0.0f };
                    float const top = p.z + EDGE_LOOK_OFFSET;
                    if (!lookClear(p, n, top))
                        return refuse("snap_climb");
                    bool climb = false;
                    float const s = SurfaceUnder(mover, n.x, n.y, top, DEFAULT_HEIGHT_SEARCH, &climb);
                    if (climb)
                        return refuse("snap_climb");
                    if (s <= INVALID_HEIGHT)
                        return refuse("no_surface");
                    n.z = s;
                    if (IsDropSegment(p, n, nullptr))
                        return refuse("snap_ledge");
                    if (!clear(p, p.z, n, n.z))
                        return refuse("blocked");
                    if (t < len)
                        snapWalk.push_back(n);
                    p = n;
                }
            }
        }
        auto nearEnd = [&](WbVec const& v) {
            float const ex = v.x - x, ey = v.y - y;
            return ex * ex + ey * ey <= 16.0f; // endpointOk: within 4y of the end, 2D
        };
        std::vector<WbVec> below;
        {
            PathGenerator gen(mover);
            if (gen.CalculatePath(start.x, start.y, start.z, x, y, z, false)
                && IsCompletePath(gen.GetPathType(), gen.GetPath()))
            {
                G3D::Vector3 const& end = gen.GetActualEndPosition();
                if (nearEnd({ end.x, end.y, end.z }))
                    for (auto const& v : gen.GetPath())
                        below.push_back({ v.x, v.y, v.z });
            }
        }
        if (below.empty())
        {
            dtNavMeshQuery const* plan = navMesh ? WbNav::PlannerQuery(navMesh) : nullptr;
            float startPt[3] = { start.y, start.z, start.x };
            dtPolyRef const startRef = query ? CorePolyAt(query, base, startPt, nullptr) : 0;
            char const* why = "";
            std::vector<WbVec> planned;
            if (plan && startRef && endRef
                && PlanAround(mover, navMesh, plan, base, startRef, endRef, startPt, endPt, planned, &why)
                && nearEnd(planned.back()))
                below = std::move(planned);
        }
        // Neither has a path, and the start is where the request is
        // (WithinSlop): the route ends there, with no leg below. At Skettis
        // the fall came down 0.8y straight under the request, on the polygon
        // beside its own, and was refused no_route_from_landing.
        if (below.empty() && WithinSlop(mover, start, x, y, z))
        {
            below.push_back(start);
            ed.endAtLanding = true;
        }
        if (below.empty())
            return refuse("no_route_from_landing");

        // The route: the mesh's as far as it got, the walk on, the fall, the
        // walk onto the mesh below when the landing is off it, and the leg
        // below. Settled like any route (SettleRoute: the start's own snap
        // leg, the endpoint lift, the guard), with the start's record carried
        // over as ReplanSteep carries it.
        PathResolve cand;
        cand.hasSnap = r.hasSnap;
        cand.snapX = r.snapX; cand.snapY = r.snapY; cand.snapZ = r.snapZ;
        cand.hasStartLevel = r.hasStartLevel;
        cand.levelFromX = r.levelFromX; cand.levelFromY = r.levelFromY; cand.levelFromZ = r.levelFromZ;
        cand.levelZ = r.levelZ;
        cand.levelIslandPolys = r.levelIslandPolys;
        cand.islandPolys = r.islandPolys;
        cand.hasEndReachable = r.hasEndReachable;
        cand.endFromX = r.endFromX; cand.endFromY = r.endFromY; cand.endFromZ = r.endFromZ;
        cand.endToX = r.endToX; cand.endToY = r.endToY; cand.endToZ = r.endToZ;
        cand.points = partial;
        cand.points.insert(cand.points.end(), walk.begin(), walk.end());
        cand.points.push_back(landing);
        cand.points.insert(cand.points.end(), snapWalk.begin(), snapWalk.end());
        if (ed.landingSnap)
            cand.points.push_back(below.front());
        cand.points.insert(cand.points.end(), below.begin() + 1, below.end());
        SettleRoute(mover, cand, z, reqZ, force);

        // One fall per move: the edge is the route's only ledge. A ledge of
        // the mesh's own before it, or one below, would be walked by the same
        // `force` the caller gives for this fall after judging a different
        // one (`drop` names the first), so such a route is not taken.
        size_t ledges = 0;
        for (size_t i = 0; i + 1 < cand.points.size(); ++i)
            if (IsDropSegment(cand.points[i], cand.points[i + 1], nullptr))
                ++ledges;
        if (ledges != 1)
            return refuse("second_ledge");

        ed.taken = true;
        cand.edgeDrop = ed;
        r = std::move(cand);
    }

    // The z-ladder in front of the cause ladder (part 3). A unit
    // target's z comes from the unit's own movement packets, and a patrolling or
    // sloped NPC's z can sit outside the core's default poly-search extents
    // while the ground under it is perfectly walkable ("Ironforge Mountaineer"
    // at (-5909, -68), nav-probe c3/c4: `target_off_mesh` for a point an NPC
    // stands on). The ground height at x,y is terrain and model geometry a
    // client has too (Map::GetHeight over maps/vmaps/GO models), so the module
    // resolves it before pathing: first for a unit target, as a fallback after
    // a `target_off_mesh` for any point. Map::GetHeight looks down from the
    // z it is given, so a request under the ground (a z read off a lower
    // level, often the character's own) gets no ground height; the mesh's
    // walkable level over x,y is tried after both when it is the only level
    // in the column (MeshLevelsAt) and the request rests on no ground of its
    // own, and a request whose column holds two or more levels is not guessed
    // between. A target the mesh rejects at every one of those heights is
    // still `target_off_mesh`; `meshZ` is always relative to the z the agent
    // asked for.
    Manager::PathResolve Manager::ResolvePath(Unit* mover, float x, float y, float z, bool unitTarget, bool* usedGroundZ, float* groundZOut, bool force, bool* usedMeshZ)
    {
        if (usedGroundZ) *usedGroundZ = false;
        if (usedMeshZ) *usedMeshZ = false;
        float groundZ = mover->GetMap()->GetHeight(mover->GetPhaseMask(), x, y, z, true);
        bool haveGround = groundZ > INVALID_HEIGHT && std::fabs(groundZ - z) > 0.5f;
        if (groundZOut) *groundZOut = haveGround ? groundZ : z;

        auto isTargetOffMesh = [](PathResolve const& r) { return r.status && std::strcmp(r.status, "target_off_mesh") == 0; };
        // A target the mesh rejected at every height it was tried: name the
        // walkable mesh nearest to it within TARGET_NEAREST_RADIUS, or that
        // there is none, on the result.
        auto withNearest = [&](PathResolve r) {
            if (isTargetOffMesh(r))
            {
                r.nearestSearched = true;
                WbVec near;
                if (NearestReachablePoint(mover, x, y, haveGround ? groundZ : z, TARGET_NEAREST_RADIUS, near))
                {
                    r.hasNearest = true;
                    r.nearestX = near.x; r.nearestY = near.y; r.nearestZ = near.z;
                }
            }
            return r;
        };

        // The last rung: the walkable level over x,y, when the mesh has
        // exactly one level in the column there (MeshLevelsAt), the request
        // is under it, and the request rests on no geometry of its own (no
        // ground height within MESH_LEVEL_MERGE of z, looking down from it).
        // That is a z buried in the terrain or in the air under a deck: a
        // stale or wrong one (the character's own, from a lower stretch of
        // road), and the level above is its one reading. A request resting on
        // ground the mesh does not walk asked for that ground, not for a
        // roof or a hilltop over it; a level below the request is not taken
        // either — the ground rung has judged that, and a tunnel under a
        // hill is not what a point on the hill asked for. Two or more levels
        // are two readings and the move stays refused.
        bool const restsOnGround = groundZ > INVALID_HEIGHT && std::fabs(z - groundZ) <= MESH_LEVEL_MERGE;
        auto meshLevel = [&](PathResolve r) {
            if (!isTargetOffMesh(r) || restsOnGround)
                return withNearest(r);
            float level = 0.0f;
            if (MeshLevelsAt(mover, x, y, z, &level) != 1 || level <= z + 0.5f
                || (haveGround && std::fabs(level - groundZ) <= 0.5f))
                return withNearest(r);
            PathResolve r3 = ResolvePathAt(mover, x, y, level, z, force);
            if (isTargetOffMesh(r3))
                return withNearest(r);
            if (usedMeshZ) *usedMeshZ = true;
            if (groundZOut) *groundZOut = level;
            return r3;
        };

        if (unitTarget && haveGround)
        {
            PathResolve r = ResolvePathAt(mover, x, y, groundZ, z, force);
            if (!isTargetOffMesh(r))
            {
                if (usedGroundZ) *usedGroundZ = true;
                return r;
            }
            return meshLevel(ResolvePathAt(mover, x, y, z, z, force));
        }
        PathResolve r = ResolvePathAt(mover, x, y, z, z, force);
        if (isTargetOffMesh(r) && haveGround)
        {
            PathResolve r2 = ResolvePathAt(mover, x, y, groundZ, z, force);
            if (!isTargetOffMesh(r2))
            {
                if (usedGroundZ) *usedGroundZ = true;
                return r2;
            }
        }
        return meshLevel(r);
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
        if (m.pathLength > 0.0f)
        {
            w.Add("pathLength", (double)m.pathLength);
            if (m.etaMs > 0)
                w.Add("etaMs", m.etaMs);
        }
        m.pathLength = 0.0f;
        m.etaMs = 0;
        // Server-confirmed position, when the session is still live: this is the
        // ground truth that the synthesized movement was actually applied. Of
        // the unit the walk drove (`mover` names it when it is not the
        // character; `flight` when the leg was flown).
        Player* player = (s.ws && sWorldSessionMgr->FindSession(s.accountId) == s.ws) ? s.ws->GetPlayer() : nullptr;
        Unit* unit = !player ? nullptr : (m.moverGuid ? ObjectAccessor::GetUnit(*player, ObjectGuid(m.moverGuid)) : static_cast<Unit*>(player));
        if (m.moverGuid)
            w.AddGuid("mover", m.moverGuid);
        if (m.flying)
            w.Add("flight", true);
        m.moverGuid = 0;
        m.flying = false;
        // `pos` always: a driven unit gone from the map by the verdict (a
        // possession recalled, a ride's end despawning the mount, the session
        // gone) leaves the walker's own last point, the client's last word on
        // where it was.
        if (unit)
        {
            w.Raw("pos", PosJson(unit->GetPositionX(), unit->GetPositionY(), unit->GetPositionZ(), unit->GetOrientation()));
            // Aboard a transport at the end of the move: the server is carrying
            // the character (it accepted ONTRANSPORT packets), so say which.
            if (Transport* t = unit->GetTransport())
                w.Raw("onTransport", Json::Writer().AddGuid("guid", (uint64_t)t->GetGUID().GetRawValue())
                    .Add("entry", t->GetEntry()).Str());
        }
        else
            w.Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO));
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
            if (m.hasSurfaceZ)
                w.Add("surfaceZ", (double)m.surfaceZ);
            if (player)
                AddSafeFall(w, player);
        }
        m.hasDrop = false;
        m.hasSurfaceZ = false;
        EmitEvent(s, "WB_MOVE_RESULT", 0xFF01, w.Str());
    }

    void Manager::DoMoveTo(std::string token, float x, float y, float z, std::string guid, bool force, std::shared_ptr<std::promise<HttpReply>> ack)
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
            if (force)
                a.Add("force", true);
            Audit(*s, "action", a.Str());
        }

        // The unit the client moves (ActiveMover): the character, or the
        // vehicle or possessed unit a control handover put in its place. The
        // walk is the mover's from here on: its guid on every packet, its
        // position, speed, map and water; a flying mover's leg is flown
        // (PlanFlight, below). A mover the core holds out of this map can be
        // driven by no packet: refused `controlling` before planning, acked
        // with moveId alone as `rooted` is, and a walk still running ends the
        // same way. A verdict for a walk of another unit names it (`mover`).
        Unit* mover = ActiveMover(player);
        if (!mover)
        {
            if (s->move.active)
                FinishMove(*s, "controlling");
            uint64_t const moveId = ++s->moveIdGen;
            s->move.moveId = moveId;
            ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "move_to").Add("moveId", moveId).Str()});
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", "controlling");
            if (Unit* held = static_cast<Unit*>(player->m_mover))
                w.AddGuid("mover", held->GetGUID().GetRawValue());
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
            return;
        }
        auto addMover = [&](Json::Writer& w) {
            if (mover != player)
                w.AddGuid("mover", mover->GetGUID().GetRawValue());
        };

        bool const stunned = StunnedFor(mover);
        if (stunned || RootedFor(*s, mover, player))
        {
            // A rooted client cannot move: nothing is sent, not even the stop a
            // redirect sends (the root ack was the stop). A walk the tick has
            // not ended yet ends `rooted` here, and the request is refused with
            // the same status after its ack, as a refusal at planning is. A
            // stun is the same refusal under its own name (StunnedFor), so a
            // caller can tell a stun from a root it can still turn in.
            char const* status = stunned ? "stunned" : "rooted";
            if (s->move.active)
                FinishMove(*s, status);
            uint64_t const moveId = ++s->moveIdGen;
            s->move.moveId = moveId;
            ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "move_to").Add("moveId", moveId).Str()});
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", status);
            addMover(w);
            w.Raw("pos", PosJson(mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation()));
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
            return;
        }

        if (s->move.active && !WalkDrives(*s, mover, player))
        {
            // The walk still running drove another unit (control changed hands
            // since; the tick has not seen it yet): the server drops that
            // unit's packets now, so nothing is sent and it ends `controlling`.
            FinishMove(*s, "controlling");
        }
        else if (s->move.active)
        {
            // A client whose run is redirected stops first: without this the
            // server's last movement word stays MOVEMENTFLAG_FORWARD when the
            // new request fails at planning, isMoving() stays true and every
            // later cast fails SPELL_FAILED_MOVING (~10 minutes of
            // Hearthstone casts in nav-probe c3).
            MoveState& old = s->move;
            SendMovePacket(*s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, old.curX, old.curY, old.curZ, old.curO,
                TransportUnder(*s, mover, old.curX, old.curY, old.curZ));
            FinishMove(*s, "superseded");
        }

        uint64_t moveId = ++s->moveIdGen;
        MoveState& m = s->move;
        m.moveId = moveId;

        // Ack means "queued"; the game-level outcome arrives as a WB_MOVE_RESULT
        // event, per the transport/game error split in PROTOCOL.md. Sent once
        // planning has answered, on each of the three ends below (too_far, a
        // refusal at planning, a dispatched walk), so a dispatched walk's ack
        // carries the route it walks: its length and the walker's time over it,
        // the same figures WB_MOVE_PROGRESS repeats. Planning is this call's own
        // synchronous work on the world thread, so the ack waits milliseconds.
        bool acked = false;
        auto sendAck = [&](bool dispatched) {
            if (acked)
                return;
            acked = true;
            Json::Writer w;
            w.Add("ok", true).Add("action", "move_to").Add("moveId", moveId);
            if (dispatched)
            {
                w.Add("pathLength", (double)m.pathLength);
                if (m.etaMs > 0)
                    w.Add("etaMs", m.etaMs);
            }
            ack->set_value({200, w.Str()});
        };

        auto failEvent = [&](char const* status) {
            sendAck(false);
            // Nothing moved; if the server still has the character flagged as
            // moving (a superseded run it has not yet seen stop), end it the
            // way a client's run ends. A no-op for a character already still.
            if (mover->isMoving())
                SendMovePacket(*s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                    mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation(),
                    mover->GetTransport());
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", status);
            addMover(w);
            w.Raw("pos", PosJson(mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation()));
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
        };

        if (mover->GetExactDist2d(x, y) > 250.0f)
            return failEvent("too_far");

        // A flying mover (the Eye of Acherus, a flying vehicle) is not walked
        // over the mesh: a client flies it in a straight line, and so does the
        // module (PlanFlight). Known the way a client knows it: from the
        // flight flags the unit's own create block carried at the handover and
        // the packets for its guid since (BenchSession::moverMoveFlags), never
        // from the creature's template.
        bool const flying = mover != player
            && (s->moverMoveFlags.load() & (MOVEMENTFLAG_CAN_FLY | MOVEMENTFLAG_DISABLE_GRAVITY)) != 0;

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
        bool transportLeg = false; // the straight leg onto or off a transport: WalkEtaMs runs it dry
        {
            Map* map = mover->GetMap();
            Transport* startT = mover->GetTransport();
            if (!startT)
                startT = FindTransportAt(map, mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ());
            Transport* targetT = FindTransportAt(map, x, y, z);
            if (flying)
            {
                FlightPlan const fp = PlanFlight(mover, x, y, z, r.points);
                r.status = fp.status;
                if (fp.hasReached)
                {
                    r.hasReached = true;
                    r.reachedX = fp.reached.x; r.reachedY = fp.reached.y; r.reachedZ = fp.reached.z;
                }
                Audit(*s, "action", Json::Writer().Add("op", "move_flight_leg").Add("moveId", moveId)
                    .Add("status", r.status ? r.status : "ok")
                    .Add("flightSpeed", (double)mover->GetSpeed(MOVE_FLIGHT)).Str());
            }
            else if (mover == player && (startT || targetT) && mover->GetExactDist2d(x, y) <= 30.0f)
            {
                transportLeg = true;
                bool leaving = startT != nullptr && !targetT;
                float endZ = z;
                // A leg that leaves the transport ends on ordinary ground, and
                // the ground is where a client's character ends up: its physics
                // drop it from the deck to the platform. Without this the leg
                // ended at whatever z was asked for — a request quoting the
                // car-deck height left the character standing in the air 10y
                // over the Deeprun platform, `arrived`, and off the mesh for
                // the next move. Ground height is terrain, vmap and model
                // geometry a client has too (as ResolvePath's z-ladder); it is
                // reported as `meshZ`, like a mesh-corrected arrival.
                if (leaving)
                {
                    float groundZ = map->GetHeight(mover->GetPhaseMask(), x, y, z, true);
                    if (groundZ > INVALID_HEIGHT && std::fabs(groundZ - z) > 1.0f)
                    {
                        endZ = groundZ;
                        r.hasMeshZ = true;
                        r.meshZ = groundZ;
                    }
                }
                r.points.push_back({mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ()});
                r.points.push_back({x, y, endZ});
                Json::Writer a;
                a.Add("op", "move_transport_leg").Add("moveId", moveId)
                    .Add("boarding", targetT != nullptr).Add("leaving", leaving);
                if (r.hasMeshZ)
                    a.Add("z", (double)z).Add("groundZ", (double)endZ);
                Audit(*s, "action", a.Str());
            }
            else
            {
                bool usedGroundZ = false, usedMeshZ = false; float groundZ = z;
                r = ResolvePath(mover, x, y, z, !guid.empty(), &usedGroundZ, &groundZ, force, &usedMeshZ);
                if (usedGroundZ)
                    Audit(*s, "action", Json::Writer().Add("op", "move_ground_z").Add("moveId", moveId)
                        .Add("unitTarget", !guid.empty()).Add("z", (double)z).Add("groundZ", (double)groundZ).Str());
                if (usedMeshZ)
                    Audit(*s, "action", Json::Writer().Add("op", "move_mesh_z").Add("moveId", moveId)
                        .Add("z", (double)z).Add("meshZ", (double)groundZ).Str());
                if (r.hasEndLift)
                    Audit(*s, "action", Json::Writer().Add("op", "move_end_z").Add("moveId", moveId)
                        .Add("normZ", (double)r.endLiftFrom).Add("meshZ", (double)r.points.back().z).Str());
                if (r.islandPolys)
                {
                    Json::Writer a;
                    a.Add("op", "move_end_reachable").Add("moveId", moveId).Add("islandPolys", r.islandPolys)
                        .Add("walked", r.hasEndReachable);
                    if (r.hasEndReachable)
                        a.Raw("from", Json::Writer().Add("x", (double)r.endFromX).Add("y", (double)r.endFromY).Add("z", (double)r.endFromZ).Str())
                            .Raw("to", Json::Writer().Add("x", (double)r.endToX).Add("y", (double)r.endToY).Add("z", (double)r.endToZ).Str());
                    Audit(*s, "action", a.Str());
                }
                if (r.slopEnd)
                    Audit(*s, "action", Json::Writer().Add("op", "move_end_slop").Add("moveId", moveId)
                        .Add("status", r.status ? r.status : "ok")
                        .Raw("to", Json::Writer().Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Str()).Str());
                if (r.longPlan)
                    Audit(*s, "action", Json::Writer().Add("op", "move_long_plan").Add("moveId", moveId)
                        .Add("polys", r.longPolys).Add("pointCount", (uint64_t)r.points.size()).Str());
                if (r.hasSnap)
                    Audit(*s, "action", Json::Writer().Add("op", "move_start_snap").Add("moveId", moveId)
                        .Raw("from", PosJson(mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation()))
                        .Raw("to", Json::Writer().Add("x", (double)r.snapX).Add("y", (double)r.snapY).Add("z", (double)r.snapZ).Str())
                        .Add("distance", (double)std::sqrt(std::pow(r.snapX - mover->GetPositionX(), 2.0f) + std::pow(r.snapY - mover->GetPositionY(), 2.0f) + std::pow(r.snapZ - mover->GetPositionZ(), 2.0f)))
                        .Str());
                if (r.hasStartLevel)
                    Audit(*s, "action", Json::Writer().Add("op", "move_start_level").Add("moveId", moveId)
                        .Raw("from", Json::Writer().Add("x", (double)r.levelFromX).Add("y", (double)r.levelFromY).Add("z", (double)r.levelFromZ).Str())
                        .Add("levelZ", (double)r.levelZ).Add("islandPolys", r.levelIslandPolys)
                        .Str());
                // The steep re-plan, whenever the guard refused the mesh's own
                // route: what it refused (edge, dz, pointCount), how many
                // re-plans ran and how many polygons the last one barred, and
                // whether the walk is now a re-planned route (outcome "ok",
                // whose polyline is the move_path below) or the refusal stands.
                if (r.replan.ran)
                {
                    Json::Writer a;
                    a.Add("op", "move_replan_steep").Add("moveId", moveId).Add("outcome", r.replan.outcome);
                    if (r.replan.reason[0] != '\0')
                        a.Add("reason", r.replan.reason);
                    a.Add("rounds", r.replan.rounds).Add("excluded", r.replan.excluded)
                        .Add("dz", (double)r.replan.dz)
                        .Raw("edge", Json::Writer().Add("x", (double)r.replan.edge.x).Add("y", (double)r.replan.edge.y)
                            .Add("z", (double)r.replan.edge.z).Str())
                        .Add("pointCount", r.replan.firstPoints)
                        .Add("replanPointCount", r.replan.points);
                    Audit(*s, "action", a.Str());
                }
                // The edge drop, whenever a path_incomplete's request lay
                // below the end of the mesh's route: whether the route is now
                // the walk on, the fall and the leg below (the move_path
                // below), and why not when it is not.
                if (r.edgeDrop.tried)
                {
                    PathResolve::EdgeDrop const& ed = r.edgeDrop;
                    auto vec = [](WbVec const& v) {
                        return Json::Writer().Add("x", (double)v.x).Add("y", (double)v.y).Add("z", (double)v.z).Str();
                    };
                    Json::Writer a;
                    a.Add("op", "move_edge_drop").Add("moveId", moveId).Add("taken", ed.taken);
                    if (ed.reason[0] != '\0')
                        a.Add("reason", ed.reason);
                    a.Raw("from", vec(ed.from));
                    if (ed.hasEdge)
                        a.Raw("edge", vec(ed.edge)).Raw("landing", vec(ed.landing))
                            .Add("walkYards", (double)ed.walkYards).Add("landingSnap", ed.landingSnap);
                    if (ed.landingSnap)
                        a.Raw("snapTo", vec(ed.snapTo)).Add("snapYards", (double)ed.snapYards);
                    if (ed.endAtLanding)
                        a.Add("endAtLanding", true);
                    if (ed.fromStart)
                        a.Add("fromStart", true).Add("firstReason", ed.firstReason);
                    Audit(*s, "action", a.Str());
                }
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
            if (mover->isMoving()) // see failEvent
                SendMovePacket(*s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                    mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation(),
                    mover->GetTransport());
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", r.status);
            addMover(w);
            if (flying)
                w.Add("flight", true);
            w.Raw("pos", PosJson(mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation()));
            if (r.hasReached)
                w.Raw("reachedPos", Json::Writer().Add("x", (double)r.reachedX).Add("y", (double)r.reachedY).Add("z", (double)r.reachedZ).Str());
            if (r.hasDrop)
            {
                w.Add("dz", (double)r.dropDz);
                w.Raw("target", Json::Writer().Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Str());
                if (r.hasSurfaceZ)
                    w.Add("surfaceZ", (double)r.surfaceZ);
                AddSafeFall(w, mover);
            }
            if (r.nearestSearched)
            {
                if (r.hasNearest)
                    w.Raw("nearest", Json::Writer().Add("x", (double)r.nearestX).Add("y", (double)r.nearestY).Add("z", (double)r.nearestZ).Str());
                else
                    w.Raw("nearest", "null");
            }
            sendAck(false);
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
            return;
        }
        std::vector<WbVec> const& pts = r.points;
        m.meshZ = r.meshZ;
        m.hasMeshZ = r.hasMeshZ;
        m.reqX = x; m.reqY = y; m.reqZ = z;
        m.hasDrop = false;
        m.hasSurfaceZ = false;
        m.force = force;
        m.inFall = false;
        m.fallStartMs = 0;
        m.fallMs = 0;

        int64_t now = NowMs();
        m.points.clear();
        m.points = pts;
        // The route's length as walked, so a caller can judge the walk by the
        // route rather than the straight line (a mine's tunnels are three
        // times it): on every progress event and on the verdict.
        m.pathLength = 0.0f;
        for (size_t i = 1; i < m.points.size(); ++i)
            m.pathLength += std::sqrt(std::pow(m.points[i].x - m.points[i - 1].x, 2.0f)
                + std::pow(m.points[i].y - m.points[i - 1].y, 2.0f) + std::pow(m.points[i].z - m.points[i - 1].z, 2.0f));
        // The same route in time, at the walker's own paces (WalkEtaMs), so a
        // caller judges a swim or a mounted walk by how long it takes rather
        // than by a run speed it assumes. Its cost is in the audit row: one
        // liquid query per ETA_SAMPLE_YARDS of route, on this thread.
        {
            auto const t0 = std::chrono::steady_clock::now();
            WalkEta const eta = flying ? FlightEtaMs(mover, m.points) : WalkEtaMs(mover, m.points, transportLeg);
            int64_t const costUs = std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - t0).count();
            m.etaMs = eta.ms;
            Audit(*s, "action", Json::Writer().Add("op", "move_eta").Add("moveId", moveId)
                .Add("etaMs", eta.ms).Add("pathLength", (double)m.pathLength)
                .Add("swimYards", (double)eta.swimYards).Add("samples", eta.samples).Add("costUs", costUs)
                .Add("runSpeed", (double)mover->GetSpeed(MOVE_RUN)).Add("swimSpeed", (double)mover->GetSpeed(MOVE_SWIM))
                .Str());
        }
        // Before the walker starts: nothing below can end the move first, but
        // FinishMove clears pathLength, so the ack reads it while it holds.
        sendAck(true);
        m.seg = 0;
        m.segDone = 0.0f;
        m.lastMs = now;
        m.lastPacketMs = now;
        m.lastProgressMs = now;
        m.curX = m.points[0].x; m.curY = m.points[0].y; m.curZ = m.points[0].z;
        m.destX = m.points.back().x; m.destY = m.points.back().y; m.destZ = m.points.back().z;
        m.curO = Position::NormalizeOrientation(std::atan2(m.points[1].y - m.points[0].y, m.points[1].x - m.points[0].x));
        m.stopping = false;
        m.moverGuid = mover == player ? 0 : mover->GetGUID().GetRawValue();
        m.flying = flying;
        m.active = true;
        // Where the body starts, from the server's record of the last swim
        // flag sent: a character idling in water starts swimming, and one the
        // world moved in or out of water since (a teleport, a knockback)
        // sends the transition first, as a client's physics would. A flight
        // has no water.
        m.swimming = !flying && mover->IsInWater();
        PlaceMover(*s, mover, m.curX, m.curY, m.curZ, MOVEMENTFLAG_NONE, now);

        SendMovePacket(*s, mover, MSG_MOVE_START_FORWARD, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO,
            TransportUnder(*s, mover, m.curX, m.curY, m.curZ));
        Json::Writer startW;
        startW.Add("op", "move_pkt").Add("opcode", "MSG_MOVE_START_FORWARD").Add("moveId", moveId);
        addMover(startW);
        if (flying)
            startW.Add("flight", true);
        Audit(*s, "action", startW.Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
    }

    void Manager::DoStop(std::string token, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        Audit(*s, "action", Json::Writer().Add("op", "stop").Str());

        // The unit the client moves (ActiveMover): the stop carries its
        // guid, as any movement packet must. A mover the core holds out of
        // this map takes no packet, so none is sent.
        Unit* mover = ActiveMover(player);
        if (!mover)
        {
            if (s->move.active)
                FinishMove(*s, "controlling");
            ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "stop").Str()});
            return;
        }

        if (s->move.active && !WalkDrives(*s, mover, player))
        {
            // The walk drove another unit and control has changed hands since
            // (the tick has not seen it yet): its packets are dropped now, so
            // nothing is sent and it ends `controlling`.
            FinishMove(*s, "controlling");
        }
        else if (s->move.active && (StunnedFor(mover) || RootedFor(*s, mover, player)))
        {
            // Rooted or stunned mid-walk and the tick has not ended it yet:
            // the root ack already stopped the character where the mover stood.
            FinishMove(*s, StunnedFor(mover) ? "stunned" : "rooted");
        }
        else if (s->move.active)
        {
            MoveState& m = s->move;
            // Stop where the "client" is (the interpolated position); the server
            // accepts it the same way it accepts any client stop mid-run.
            SendMovePacket(*s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO,
                TransportUnder(*s, mover, m.curX, m.curY, m.curZ));
            FinishMove(*s, "stopped");
        }
        else
        {
            SendMovePacket(*s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation(),
                mover->GetTransport());
        }
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "stop").Str()});
    }

    void Manager::DoFace(std::string token, bool hasO, float o, bool hasXY, float x, float y,
        std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        // A stunned client cannot turn (StunnedFor; a rooted one can):
        // refused, nothing sent. Before the walk's own refusal, since a stun
        // that has not yet ended a walk is the reason the caller needs.
        if (Unit* held = ActiveMover(player); held && StunnedFor(held))
            return ack->set_value({409, Json::Writer().Add("ok", false).Add("error", "stunned").Str()});
        // A walk is forward running, and a client running forward travels
        // where it faces: a facing sent mid-walk would either not match the
        // travel (no client sends that) or bend the walk off its planned path.
        // Refused, nothing sent (PROTOCOL.md "face").
        if (s->move.active)
            return ack->set_value({409, Json::Writer().Add("ok", false).Add("error", "moving").Str()});
        // The unit the client moves turns (ActiveMover): a vehicle's driving
        // seat turns the vehicle, a possession the possessed unit. A mover
        // the core holds out of this map takes no packet: refused, nothing
        // sent.
        Unit* mover = ActiveMover(player);
        if (!mover)
            return ack->set_value({409, Json::Writer().Add("ok", false).Add("error", "controlling").Str()});

        float target = hasO ? Position::NormalizeOrientation(o)
                            : (hasXY ? mover->GetAngle(x, y) : mover->GetOrientation());

        Audit(*s, "action", Json::Writer().Add("op", "face").Add("orientation", (double)target).Str());
        SendMovePacket(*s, mover, MSG_MOVE_SET_FACING, MOVEMENTFLAG_NONE,
            mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), target);
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "face")
            .Add("orientation", (double)target).Str()});
    }

    // Parse a guid request field (decimal string, see PROTOCOL.md u64 note).
    static uint64_t ParseGuid(Json::Value const& req, char const* key)
    {
        std::string v = req.GetString(key);
        if (v.empty())
            return 0;
        try { return std::stoull(v); } catch (...) { return 0; }
    }

    // What a cast aims at, as cast_spell and use_item take it (PROTOCOL.md):
    // a unit or object (targetGuid), an item the character holds
    // (itemTargetGuid) and a point on the ground (destX, destY, destZ).
    struct CastTargets
    {
        uint64_t unit{0};
        uint64_t item{0};
        bool hasDest{false};
        float x{0.0f}, y{0.0f}, z{0.0f};
    };

    // The targets off a request: the error code, or nullptr. An item guid of
    // 0, or a point off the float range, is refused rather than dropped,
    // which would send the cast with no item or no point. A guid that does
    // not parse, and a partial point, are refused on the io thread.
    static char const* ParseCastTargets(Json::Value const& req, CastTargets& t)
    {
        t.unit = ParseGuid(req, "targetGuid");
        if (req.Has("itemTargetGuid"))
        {
            t.item = ParseGuid(req, "itemTargetGuid");
            if (!t.item)
                return "invalid_item_target";
        }
        if (req.Has("destX"))
        {
            t.hasDest = true;
            t.x = (float)req.GetDouble("destX");
            t.y = (float)req.GetDouble("destY");
            t.z = (float)req.GetDouble("destZ");
            if (!std::isfinite(t.x) || !std::isfinite(t.y) || !std::isfinite(t.z))
                return "invalid_dest";
        }
        return nullptr;
    }

    // The SpellCastTargets block after a cast's header, in the order the core
    // reads it (Spell.cpp SpellCastTargets::Read): u32 mask; the packed object
    // guid under TARGET_FLAG_UNIT; the packed item guid under
    // TARGET_FLAG_ITEM; under TARGET_FLAG_DEST_LOCATION the packed transport
    // guid and x, y, z. The transport guid is always 0, so the point is a
    // world position: SpellCastTargets::Update relocates by a transport only
    // when one is named. With a unit alone, or nothing, this is the u32 2 +
    // packed guid, or the u32 0, both actions have always written.
    static void WriteCastTargets(WorldPacket& p, CastTargets const& t)
    {
        uint32 mask = TARGET_FLAG_NONE;
        if (t.unit)
            mask |= TARGET_FLAG_UNIT;
        if (t.item)
            mask |= TARGET_FLAG_ITEM;
        if (t.hasDest)
            mask |= TARGET_FLAG_DEST_LOCATION;
        p << uint32(mask);
        if (t.unit)
            p.appendPackGUID(t.unit);
        if (t.item)
            p.appendPackGUID(t.item);
        if (t.hasDest)
        {
            p.appendPackGUID(0);                             // transport guid: none
            p << float(t.x) << float(t.y) << float(t.z);
        }
    }

    static void AuditCastTargets(Json::Writer& w, CastTargets const& t)
    {
        if (t.item)
            w.AddGuid("itemTargetGuid", t.item);
        if (t.hasDest)
            w.Add("destX", (double)t.x).Add("destY", (double)t.y).Add("destZ", (double)t.z);
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
            CastTargets targets;
            if (char const* bad = ParseCastTargets(req, targets))
                return err(400, bad);
            // castCount is the client's own counter (BenchSession::castCount):
            // with 0 the core skips its in-progress check (Spell::prepare) and
            // a cast sent during another cancels it, where a client's is
            // refused SPELL_FAILED_SPELL_IN_PROGRESS.
            uint8 const castCount = s->NextCastCount();
            p = new WorldPacket(CMSG_CAST_SPELL, 1 + 4 + 1 + 4 + 9 + 9 + 1 + 12);
            *p << uint8(castCount) << uint32(spellId) << uint8(0);   // castCount, spellId, castFlags
            WriteCastTargets(*p, targets);                   // no target: mask 0, self/auto target
            auditW.Add("spellId", spellId).Add("castCount", (uint32)castCount);
            if (targets.unit)
                auditW.AddGuid("targetGuid", targets.unit);
            AuditCastTargets(auditW, targets);
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
            // A coded option (SMSG_GOSSIP_MESSAGE's boxCoded flag) has the
            // client's text box follow as a cstring; the core reads it only
            // when the menu item is coded (WorldSession::
            // HandleGossipSelectOptionOpcode, MiscHandler.cpp), so it is sent
            // only when given.
            if (req.Has("code"))
            {
                std::string code = req.GetString("code");
                *p << code;
                auditW.Add("code", code);
            }
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
        else if (action == "quest_request_reward")
        {
            // The client's "Continue" on a completable REQUEST_ITEMS window:
            // the handler completes the quest and answers OFFER_REWARD
            // (WorldSession::HandleQuestgiverRequestRewardOpcode).
            uint32 questId = static_cast<uint32>(req.GetInt("questId"));
            p = new WorldPacket(CMSG_QUESTGIVER_REQUEST_REWARD, 12);
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
            CastTargets targets;
            if (char const* bad = ParseCastTargets(req, targets))
                return err(400, bad);
            // The glyph slot a client's glyph frame sends with a glyph (the
            // u32 after the item guid; 0 for every other item). The server
            // drops anything past its six slots (MAX_GLYPH_SLOT_INDEX) as a
            // missing item, so that is refused here, before dispatch; the
            // slot's level lock and glyph type stay the server's to judge.
            int64_t glyphSlot = req.GetInt("glyphSlot", 0);
            if (glyphSlot < 0 || glyphSlot >= MAX_GLYPH_SLOT_INDEX)
                return err(400, "invalid_glyph_slot");
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
            bool opensForLoot = false;
            if (spellId)
            {
                // The same client cast counter as cast_spell's: the core hands
                // it to the item's spell (Player::CastItemUseSpell), whose
                // in-progress check skips a 0 the same way.
                p = new WorldPacket(CMSG_USE_ITEM, 1 + 1 + 1 + 4 + 8 + 4 + 1 + 4 + 9 + 9 + 1 + 12);
                *p << uint8(bag) << uint8(slot) << uint8(s->NextCastCount()) << uint32(spellId);
                *p << uint64(item->GetGUID().GetRawValue()) << uint32(glyphSlot) << uint8(0);
                // HandleUseItemOpcode reads the same SpellCastTargets block a
                // cast does, after the cast flags.
                WriteCastTargets(*p, targets);
            }
            else if ((startQuest || (proto && proto->HasFlag(ITEM_FLAG_HAS_LOOT))) && (targets.item || targets.hasDest))
            {
                // The quest offer and the loot window below take no target:
                // an item or a point would be dropped, not aimed.
                return err(400, "no_spell_to_target");
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
            else if (proto && proto->HasFlag(ITEM_FLAG_HAS_LOOT))
            {
                // A clam, a satchel, a lockbox: the template's
                // ITEM_FLAG_HAS_LOOT is what makes a client's right-click open
                // it for loot rather than use it. u8 bag, u8 slot, exactly what
                // SpellHandler.cpp HandleOpenItemOpcode reads; the window
                // arrives as SMSG_LOOT_RESPONSE under the item's guid, and a
                // refusal (locked, dead) as SMSG_INVENTORY_CHANGE_FAILURE.
                p = new WorldPacket(CMSG_OPEN_ITEM, 2);
                *p << uint8(bag) << uint8(slot);
                opensForLoot = true;
            }
            else
                return err(400, "item_not_usable");
            auditW.Add("bag", (uint32)bag).Add("slot", (uint32)slot).Add("spellId", spellId)
                .AddGuid("itemGuid", item->GetGUID().GetRawValue()).Add("startQuest", startQuest);
            if (opensForLoot)
                auditW.Add("open", true);
            if (spellId && glyphSlot)
                auditW.Add("glyphSlot", (uint32)glyphSlot);
            if (spellId)
                AuditCastTargets(auditW, targets);
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
        else if (action == "vehicle_exit")
        {
            // The client's Leave Vehicle. From the driving seat the client
            // moves the vehicle (Player::m_mover is it, OnClientControlUpdate)
            // and hands the vehicle's last MovementInfo back with
            // CMSG_DISMISS_CONTROLLED_VEHICLE (packGUID of the mover, a
            // MovementInfo; VehicleHandler.cpp HandleDismissControlledVehicle
            // applies it and exits); from any other seat it sends the bodiless
            // CMSG_REQUEST_VEHICLE_EXIT (HandleRequestVehicleExit, which exits
            // only from a seat whose flags allow it, and logs the rest
            // silently). The seat, the vehicle and whether the vehicle is the
            // mover are what a client knows of its own ride; not aboard, it
            // has no button to press, so nothing is sent.
            Unit* base = player->GetVehicleBase();
            if (!base)
                return err(409, "not_in_vehicle");
            if (static_cast<Unit*>(player->m_mover) == base)
            {
                p = new WorldPacket(CMSG_DISMISS_CONTROLLED_VEHICLE, 8 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4);
                *p << base->GetPackGUID();
                AppendUnitMovementInfo(*p, *s, base);
                auditW.Add("opcode", "CMSG_DISMISS_CONTROLLED_VEHICLE");
            }
            else
            {
                p = new WorldPacket(CMSG_REQUEST_VEHICLE_EXIT, 0);
                auditW.Add("opcode", "CMSG_REQUEST_VEHICLE_EXIT");
            }
            auditW.AddGuid("vehicleGuid", base->GetGUID().GetRawValue());
        }
        else if (action == "vehicle_change_seat")
        {
            // The vehicle frame's seat click. From the driving seat the client
            // sends CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE: packGUID of the
            // vehicle, its MovementInfo (the mover's last word, which the
            // handler keeps as the vehicle's), packGUID of the unit whose seat
            // is wanted (the vehicle itself; an accessory's seat would name the
            // accessory) and the i8 seat; from any other seat
            // CMSG_REQUEST_VEHICLE_SWITCH_SEAT, packGUID of the vehicle and
            // the i8 seat. Both reach HandleChangeSeatsOnControlledVehicle,
            // which refuses a seat whose flags forbid switching, and a seat
            // that is taken, silently.
            Unit* base = player->GetVehicleBase();
            if (!base)
                return err(409, "not_in_vehicle");
            int8 const seat = static_cast<int8>(req.GetInt("seat"));
            if (static_cast<Unit*>(player->m_mover) == base)
            {
                p = new WorldPacket(CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE, 8 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4 + 8 + 1);
                *p << base->GetPackGUID();
                AppendUnitMovementInfo(*p, *s, base);
                *p << base->GetPackGUID();
                *p << int8(seat);
                auditW.Add("opcode", "CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE");
            }
            else
            {
                p = new WorldPacket(CMSG_REQUEST_VEHICLE_SWITCH_SEAT, 8 + 1);
                *p << base->GetPackGUID();
                *p << int8(seat);
                auditW.Add("opcode", "CMSG_REQUEST_VEHICLE_SWITCH_SEAT");
            }
            auditW.AddGuid("vehicleGuid", base->GetGUID().GetRawValue()).Add("seat", (int32_t)seat);
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
            // Party, yell and whisper ride CMSG_MESSAGECHAT here, and the
            // stock handler runs commands from any of them: the same test as
            // `say`, on the bytes the handler will read.
            if (op == CMSG_MESSAGECHAT && !s->allowGm && ChatPacketRunsCommand(*p))
            {
                delete p;
                ack->set_value({403, ChatCommandRefusal(action)});
                return;
            }
            auditW.Add("opcode", opcode).Add("payload", payload);
        }
        else
            return err(400, "unsupported_action");

        s->ws->QueuePacket(p);
        Audit(*s, "action", auditW.Str());
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", action).Str()});
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

    // WDBC reader for Map.dbc (3.3.5a: 66 fields of 4 bytes, record size 264
    // — verified against the shipped file and the core's MapEntryfmt: id,
    // internal directory name, InstanceType, flags, pvp, name[16 locales +
    // flags] from field 5 with enUS first, ...). Only id, InstanceType and the
    // enUS name are kept. Same header as AreaTrigger.dbc above.
    bool Manager::LoadMapDbc(std::string const& path)
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
        if (!in || std::memcmp(magic, "WDBC", 4) != 0 || fieldCount != 66 || recordSize != 264)
        {
            LOG_ERROR("module", "wrathbench: '{}' is not a 3.3.5a Map.dbc (fields {}, record size {})", path, fieldCount, recordSize);
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
            uint32 id, instanceType, nameOff;
            std::memcpy(&id, rec, 4);
            std::memcpy(&instanceType, rec + 2 * 4, 4);
            std::memcpy(&nameOff, rec + 5 * 4, 4);
            MapRec r;
            r.instanceType = instanceType;
            if (nameOff < stringSize)
                r.name = std::string(strings.data() + nameOff, strnlen(strings.data() + nameOff, stringSize - nameOff));
            _maps[id] = std::move(r);
            ++loaded;
        }
        _mapsLoaded = loaded > 0;
        LOG_INFO("module", "wrathbench: loaded {} maps from '{}'", loaded, path);
        return _mapsLoaded;
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
    // ids). id, mapId, the position and the enUS name are kept: the client
    // draws each node on its flight map from the same row it names it from,
    // so SMSG_SHOWTAXINODES serves both. Same header as AreaTrigger.dbc above.
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
            float x, y, z;
            std::memcpy(&id, rec, 4);
            std::memcpy(&map, rec + 4, 4);
            std::memcpy(&x, rec + 2 * 4, 4);
            std::memcpy(&y, rec + 3 * 4, 4);
            std::memcpy(&z, rec + 4 * 4, 4);
            std::memcpy(&nameOff, rec + 5 * 4, 4);
            TaxiNodeRec r;
            r.mapId = map;
            r.x = x; r.y = y; r.z = z;
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
        // and class, the base the server reads off the same masks
        // (ReputationMgr::GetBaseReputation); `reputation` is what the pane
        // shows and what the Neutral/Friendly/... rank is read off.
        if (fe && player)
        {
            int32 base = player->GetReputationMgr().GetBaseReputation(fe);
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
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "talent_tree").Str()});
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
        uint32 const mapId = player->GetMapId();
        w.Add("mapId", mapId);
        // The client's Map.dbc row for the map it loaded: its name and
        // whether it is the open world or an instance. Both are left out for
        // a map the table has no row for — never a guessed 0, which would
        // read as the open world.
        auto map = _maps.find(mapId);
        if (map != _maps.end())
            w.Add("mapName", map->second.name).Add("instanceType", map->second.instanceType);
        w.Add("zoneId", zoneId).Add("zoneName", nameOf(zoneId))
         .Add("areaId", areaId).Add("areaName", nameOf(areaId));
    }

    // A client computes the zone/subzone it is in from its own map files and
    // names them from AreaTable.dbc, and redraws on every change whether it
    // walked, was teleported or transferred. The server keeps the same pair
    // on the Player from the same terrain data, so reading it is the same
    // observation. Edge-triggered per session on the map, the instance and
    // the pair, since a client redraws on a map load whatever the pair reads:
    // a portal can keep both ids (the Deadmines mine outside and map 36
    // inside are zone and area 1581 alike), and without the map in the test
    // the transfer announced nothing. The first in-world tick counts as a
    // change so login announces where the character is.
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
            uint32 const mapId = player->GetMapId();
            uint32 const instanceId = player->GetInstanceId();
            if (zoneId == s->lastZoneId && areaId == s->lastAreaId && mapId == s->lastMapId && instanceId == s->lastInstanceId)
                continue;
            s->lastZoneId = zoneId;
            s->lastAreaId = areaId;
            s->lastMapId = mapId;
            s->lastInstanceId = instanceId;
            Json::Writer w;
            AddAreaFields(w, player);
            EmitEvent(*s, "WB_AREA", 0xFF07, w.Str());
        }
    }

    // The map-transition portals a client sees around it: a dungeon entrance
    // or exit is scenery and an AreaTrigger.dbc volume, not an object, so no
    // create block ever names it, but a player sees the portal on screen and
    // the dungeon it opens into. Served as the volume's position from the
    // client's own AreaTrigger.dbc and the map it leads to — the target map
    // of the server's areatrigger_teleport row, named from Map.dbc — never
    // the arrival point. Only triggers that change the map, within the map's
    // visibility range in 2D (the range every object is sent at; the
    // transports' test, TickTransports). Tested at most once a second per
    // session, and WB_PORTALS is sent only when the set (or the map) changes:
    // the whole current set each time, empty when the last one left range.
    static constexpr int64_t PORTAL_CHECK_MS = 1000;
    void Manager::TickPortals(int64_t nowMs)
    {
        if (!_areaTriggersLoaded)
            return;
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->phase.load() == BenchSession::P_INWORLD)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            if (nowMs - s->lastPortalCheckMs < PORTAL_CHECK_MS)
                continue;
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            if (!player || !player->IsInWorld() || player->IsBeingTeleported())
                continue;
            s->lastPortalCheckMs = nowMs;
            uint32 const mapId = player->GetMapId();
            float const range = player->GetMap()->GetVisibilityRange();
            float const px = player->GetPositionX(), py = player->GetPositionY();
            std::vector<std::pair<AreaTriggerRec const*, uint32>> seen; // trigger, target map
            auto it = _areaTriggers.find(mapId);
            if (it != _areaTriggers.end())
                for (AreaTriggerRec const& t : it->second)
                {
                    float const dx = t.x - px, dy = t.y - py;
                    if (dx * dx + dy * dy > range * range)
                        continue;
                    AreaTriggerTeleport const* tele = sObjectMgr->GetAreaTriggerTeleport(t.id);
                    if (!tele || tele->target_mapId == mapId)
                        continue;
                    seen.emplace_back(&t, tele->target_mapId);
                }
            std::sort(seen.begin(), seen.end(), [](auto const& a, auto const& b) { return a.first->id < b.first->id; });
            std::string key = std::to_string(mapId) + ":";
            for (auto const& [t, to] : seen)
                key += std::to_string(t->id) + ",";
            if (key == s->portalsKey)
                continue;
            s->portalsKey = key;
            std::string list = "[";
            for (size_t i = 0; i < seen.size(); ++i)
            {
                AreaTriggerRec const& t = *seen[i].first;
                uint32 const to = seen[i].second;
                Json::Writer p;
                p.Add("triggerId", t.id).Add("x", (double)t.x).Add("y", (double)t.y).Add("z", (double)t.z).Add("toMap", to);
                auto map = _maps.find(to);
                if (map != _maps.end())
                    p.Add("toMapName", map->second.name).Add("toInstanceType", map->second.instanceType);
                if (i > 0)
                    list += ",";
                list += p.Str();
            }
            list += "]";
            Json::Writer w;
            w.Add("mapId", mapId).Raw("portals", list);
            EmitEvent(*s, "WB_PORTALS", 0xFF0A, w.Str());
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

    void Manager::CheckAreaTriggers(BenchSession& s, Player* player, Unit* mover, float x, float y, float z, int64_t nowMs)
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
            SendMovePacket(s, mover, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, x, y, z, m.curO,
                TransportUnder(s, mover, x, y, z));
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                .Add("moveId", m.moveId).Add("cause", "areatrigger").Raw("pos", PosJson(x, y, z, m.curO)).Str());
        }

        // Outside a move_to (a landing, a transport carrying the character, a
        // teleport's arrival) the tested position is the server's own, so no
        // heartbeat is owed and the move id is 0: no move crossed the volume.
        uint64_t const moveId = s.move.active ? s.move.moveId : 0;
        float const o = s.move.active ? s.move.curO : player->GetOrientation();
        for (uint32 id : entered)
        {
            WorldPacket* p = new WorldPacket(CMSG_AREATRIGGER, 4);
            *p << uint32(id);
            s.ws->QueuePacket(p);
            Audit(s, "action", Json::Writer().Add("op", "areatrigger").Add("triggerId", id).Add("moveId", moveId).Str());
            Json::Writer w;
            w.Add("triggerId", id).Add("moveId", moveId);
            w.Raw("pos", PosJson(x, y, z, o));
            EmitEvent(s, "WB_AREATRIGGER", 0xFF04, w.Str());
        }
    }

    // A taxi flight ends with the server's StopMoving at the last path point
    // (FlightPathMovementGenerator::DoFinalize), which is the flight altitude
    // over the node, a few yards up. A real client then has control back,
    // its physics drop the character to the ground and it sends
    // MSG_MOVE_FALL_LAND there; that packet is the server's next authoritative
    // position (the fall is measured from the SetFallInformation the finalize
    // left, so a node's few yards never hurt). The module does the same from
    // the same knowledge — the ground under x,y from the terrain and vmap a
    // client has — and reports the packet it sent as WB_SELF_MOVE, the way
    // WB_MOVE_PROGRESS reports the mover's. The drop is bounded: a surface more
    // than TAXI_LANDING_MAX_DROP below is not what a client would fall to from
    // a flight node, so the server's position stands and the audit says why.
    //
    // Then the areatrigger test a client runs on its own position every frame,
    // whatever moved it: the landing position first (the server ignores
    // CMSG_AREATRIGGER while in flight, HandleAreaTriggerOpcode, so a volume
    // entered on the way in is reported at the landing, against the set as it
    // stood at takeoff), and every idle tick after it — a transport carrying
    // the character, a teleport's arrival inside an inn. The mover does the
    // same test for a move_to in progress, against the same per-session set,
    // so nothing fires twice.
    static constexpr float TAXI_LANDING_MAX_DROP = 10.0f;
    void Manager::TickGrounded(int64_t nowMs)
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
            bool const flying = player->HasUnitFlag(UNIT_FLAG_TAXI_FLIGHT) || player->IsInFlight();
            bool const landed = s->wasTaxiFlight && !flying;
            s->wasTaxiFlight = flying;
            if (flying || s->move.active)
                continue;

            float x = player->GetPositionX(), y = player->GetPositionY(), z = player->GetPositionZ();
            float const o = player->GetOrientation();
            if (landed)
            {
                float const groundZ = player->GetMap()->GetHeight(player->GetPhaseMask(), x, y, z, true);
                bool const snapped = groundZ > INVALID_HEIGHT && groundZ < z - 0.1f && z - groundZ <= TAXI_LANDING_MAX_DROP;
                Json::Writer a;
                a.Add("op", "taxi_landing").Add("snapped", snapped).Add("splineZ", (double)z);
                if (groundZ > INVALID_HEIGHT) a.Add("groundZ", (double)groundZ);
                Audit(*s, "action", a.Str());
                if (snapped)
                {
                    float const fromZ = z;
                    z = groundZ;
                    SendMovePacket(*s, player, MSG_MOVE_FALL_LAND, MOVEMENTFLAG_NONE, x, y, z, o,
                        FindTransportAt(player->GetMap(), x, y, z));
                    Audit(*s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_FALL_LAND")
                        .Add("cause", "taxi_landing").Raw("pos", PosJson(x, y, z, o)).Str());
                    Json::Writer w;
                    w.Add("opcode", "MSG_MOVE_FALL_LAND").Add("cause", "taxi_landing").Add("fromZ", (double)fromZ);
                    w.Raw("pos", PosJson(x, y, z, o));
                    EmitEvent(*s, "WB_SELF_MOVE", 0xFF09, w.Str());
                }
            }
            CheckAreaTriggers(*s, player, player, x, y, z, nowMs);
        }
    }

    // The mover's body over a point of its route, and the swim transition a
    // client sends on its own when it gets there: MSG_MOVE_START_SWIM, the
    // flag set, on reaching water deeper than the swim threshold, and
    // MSG_MOVE_STOP_SWIM, the flag cleared, on reaching the shallows again.
    // The server does the rest from those packets, as for a client: its
    // Player::SetInWater (ProcessMovementInfo, on the flag changing) and its
    // terrain-status update remove the auras that end on entering or leaving
    // water — a mount whose spell says so included — and the pace changes
    // because TickMover reads GetSpeed(MOVE_SWIM) while swimming, which
    // carries no mounted-speed bonus (Unit::UpdateSpeed). Not on a transport
    // (no water on a deck), and nothing while a forced ledge is being fallen:
    // no packet goes out mid-fall, and the landing decides.
    void Manager::PlaceMover(BenchSession& s, Unit* mover, float x, float y, float meshZ, uint32 moveFlags, int64_t nowMs)
    {
        MoveState& m = s.move;
        m.curX = x; m.curY = y; m.curZ = meshZ;
        if (m.inFall || m.flying)
            return; // a flight has no water: the body is where the line puts it
        Transport* transport = TransportUnder(s, mover, x, y, meshZ);
        WaterPose const pose = transport ? WaterPose{false, meshZ} : WaterPoseAt(mover, x, y, meshZ);
        m.curZ = pose.z;
        if (pose.swimming == m.swimming)
            return;
        m.swimming = pose.swimming;
        char const* opcode = pose.swimming ? "MSG_MOVE_START_SWIM" : "MSG_MOVE_STOP_SWIM";
        SendMovePacket(s, mover, pose.swimming ? MSG_MOVE_START_SWIM : MSG_MOVE_STOP_SWIM, moveFlags,
            m.curX, m.curY, m.curZ, m.curO, transport);
        m.lastPacketMs = nowMs;
        Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", opcode)
            .Add("moveId", m.moveId).Add("cause", "water").Add("meshZ", (double)meshZ)
            .Add("collisionHeight", (double)mover->GetCollisionHeight())
            .Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
    }

    // A heading change the walker reports as a turn (TickMover): about 3
    // degrees, where an observer running on along the old heading for a
    // heartbeat's 500ms drifts under a fifth of a yard off the route at run
    // speed. Below it the next heartbeat carries the heading as before.
    static constexpr float TURN_REPORT_RADIANS = 0.05f;

    // The unsigned angle between two orientations, in [0, pi].
    static float AngleBetween(float a, float b)
    {
        float d = std::fabs(Position::NormalizeOrientation(a) - Position::NormalizeOrientation(b));
        return d > float(M_PI) ? 2.0f * float(M_PI) - d : d;
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
        // The unit the walk drives must still be the one the client moves
        // (ActiveMover): a handover mid-walk, either way, means the server
        // drops this walk's packets from here on.
        Unit* mover = ActiveMover(player);
        if (!mover || (m.moverGuid ? mover->GetGUID().GetRawValue() != m.moverGuid : mover != player))
        {
            FinishMove(s, "controlling");
            return;
        }

        if (m.stopping)
        {
            // MSG_MOVE_STOP is queued; arrival is confirmed when the server-side
            // position reaches the destination.
            if (mover->GetExactDist2d(m.destX, m.destY) < 2.5f)
                FinishMove(s, "arrived");
            else if (nowMs > m.stopDeadlineMs)
                FinishMove(s, "interrupted");
            return;
        }

        // Dying mid-run stops the move — but only while the body is still on
        // the ground. A released spirit (ghost flag) can and must move: the
        // corpse run is the normal 3.3.5a death recovery. Conflating the two
        // death states made every corpse run impossible.
        if (!mover->IsAlive() && !(mover == player && player->HasPlayerFlag(PLAYER_FLAGS_GHOST)))
        {
            SendMovePacket(s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation(),
                mover->GetTransport());
            FinishMove(s, "interrupted");
            return;
        }

        // Rooted or stunned (OnRootPacket, StunnedFor): a client that is told
        // so stops, and its root ack already carried the stop at the mover's
        // point, so the move ends here with no further packet: `stunned` when
        // the unit is stunned, `rooted` otherwise. After the death check:
        // dying roots too (Player::KillPlayer), and a death is `interrupted`.
        if (StunnedFor(mover) || RootedFor(s, mover, player))
        {
            FinishMove(s, StunnedFor(mover) ? "stunned" : "rooted");
            return;
        }

        int64_t dt = nowMs - m.lastMs;
        m.lastMs = nowMs;
        if (dt <= 0)
            return;

        // Advance along the polyline at the character's current speed: swim
        // speed while swimming (base 4.72y/s, swim-speed auras included, no
        // mount bonus), run speed otherwise (wading included), as a client.
        // A flying mover at its flight speed (the server's MOVE_FLIGHT, or
        // its run speed when it has none: FlightEtaMs reads the same).
        float pace = mover->GetSpeed(m.flying ? MOVE_FLIGHT : (m.swimming ? MOVE_SWIM : MOVE_RUN));
        if (m.flying && !(pace > 0.01f))
            pace = mover->GetSpeed(MOVE_RUN);
        float advance = pace * float(dt) / 1000.0f;
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
            // A forced move walks it instead, the way a client's character
            // walks off an edge: the last packet before the fall is a
            // heartbeat at the edge (the server records that z as the fall's
            // start, Player::UpdateFallInformationIfNeed), nothing is sent
            // during the fall, and the foot of the segment is reported with
            // MSG_MOVE_FALL_LAND, on which the server charges the fall
            // (Player::HandleFall) exactly as it would a client's. A climb is
            // refused forced or not: no client walks up a ledge. So is a
            // step whose foot lies under the ground (FootUnderSurface): no
            // client falls through terrain.
            if (!m.flying && m.segDone <= 0.0f)
            {
                float dz = 0.0f;
                if (IsDropSegment(a, b, &dz))
                {
                    float surfaceZ = 0.0f;
                    bool buried = dz < 0.0f && FootUnderSurface(mover, a, b, &surfaceZ);
                    if (!m.force || dz > 0.0f || buried)
                    {
                        PlaceMover(s, mover, a.x, a.y, a.z, MOVEMENTFLAG_FORWARD, nowMs);
                        SendMovePacket(s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO,
                            TransportUnder(s, mover, m.curX, m.curY, m.curZ));
                        Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_STOP")
                            .Add("moveId", m.moveId).Add("cause", "drop").Add("dz", (double)dz)
                            .Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
                        m.hasDrop = true;
                        m.dropDz = dz;
                        m.hasSurfaceZ = buried;
                        m.surfaceZ = surfaceZ;
                        FinishMove(s, "drop");
                        return;
                    }
                    if (dz < 0.0f && !m.inFall)
                    {
                        m.curO = Position::NormalizeOrientation(std::atan2(sy, sx));
                        PlaceMover(s, mover, a.x, a.y, a.z, MOVEMENTFLAG_FORWARD, nowMs);
                        SendMovePacket(s, mover, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO,
                            TransportUnder(s, mover, a.x, a.y, a.z));
                        m.lastPacketMs = nowMs;
                        Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                            .Add("moveId", m.moveId).Add("cause", "drop_forced").Add("dz", (double)dz)
                            .Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
                        m.inFall = true;
                        m.fallStartMs = nowMs;
                        m.fallMs = FallMs(mover, a, b);
                    }
                }
            }
            float remain = segLen - m.segDone;
            // A fall is timed by the fall (FallMs), not by the run: the body is
            // where the fall's clock puts it along the segment, and lands once
            // the clock runs out. Only the timing changes; the packets are the
            // edge heartbeat before and the landing after, as above.
            if (m.inFall)
            {
                int64_t const since = nowMs - m.fallStartMs;
                if (since < int64_t(m.fallMs))
                {
                    float const t = float(since) / float(m.fallMs);
                    m.segDone = segLen * t;
                    m.curX = a.x + sx * t;
                    m.curY = a.y + sy * t;
                    m.curZ = a.z + sz * t;
                    m.curO = Position::NormalizeOrientation(std::atan2(sy, sx));
                    advance = 0.0f;
                    break;
                }
                advance = remain; // the landing is this tick; the next segment starts on the next
            }
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
            if (m.inFall)
            {
                // The foot of the forced ledge: land there, as a client does.
                // A fall that ends in water deep enough to swim ends the way a
                // client's does, with MSG_MOVE_START_SWIM and no
                // MSG_MOVE_FALL_LAND: the server charges a fall only on the
                // landing (Player::HandleFall), and treats the swim start as
                // the end of the fall (ProcessMovementInfo).
                m.inFall = false;
                Transport* landT = TransportUnder(s, mover, b.x, b.y, b.z);
                WaterPose const pose = landT ? WaterPose{false, b.z} : WaterPoseAt(mover, b.x, b.y, b.z);
                m.curX = b.x; m.curY = b.y; m.curZ = pose.z;
                bool const intoWater = pose.swimming && !m.swimming;
                m.swimming = pose.swimming;
                char const* landOpcode = intoWater ? "MSG_MOVE_START_SWIM" : "MSG_MOVE_FALL_LAND";
                SendMovePacket(s, mover, intoWater ? MSG_MOVE_START_SWIM : MSG_MOVE_FALL_LAND, MOVEMENTFLAG_FORWARD,
                    m.curX, m.curY, m.curZ, m.curO, landT);
                m.lastPacketMs = nowMs;
                Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", landOpcode)
                    .Add("moveId", m.moveId).Add("cause", "drop_forced")
                    .Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
                // The server may have killed the character on landing; the
                // next heartbeat's drift check or the death handling ends the
                // move as `interrupted` in that case, as for any other death.
            }
        }

        if (m.seg + 1 >= m.points.size())
        {
            // Geometric end of path: send the stop at the exact destination
            // (the body's z there: under the surface when swimming) and wait
            // for the server to confirm.
            PlaceMover(s, mover, m.destX, m.destY, m.destZ, MOVEMENTFLAG_FORWARD, nowMs);
            SendMovePacket(s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO,
                TransportUnder(s, mover, m.destX, m.destY, m.destZ));
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_STOP")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
            m.stopping = true;
            m.stopDeadlineMs = nowMs + 3000;
            return;
        }

        // The body over the point just reached: under the surface or on the
        // bed in water, with the swim transition when it changes.
        PlaceMover(s, mover, m.curX, m.curY, m.curZ, MOVEMENTFLAG_FORWARD, nowMs);

        // Heartbeat cadence, as a real client: ~500ms. Before each heartbeat,
        // verify the server actually applied the previous packets; a large gap
        // means something (root, teleport, rejection) interrupted the move.
        // Held while a forced ledge is being fallen: the module's packets
        // carry fallTime 0, so a heartbeat mid-fall would move the server's
        // fall start down to the mid-air z (UpdateFallInformationIfNeed) and
        // the landing would be charged for less than the ledge. The same check
        // runs before a turn report (below), which restarts the interval: on a
        // bending route at a mount's speed turns can come faster than 500ms,
        // and the check must not wait on a heartbeat that never falls due.
        // The character's own walk keeps the 15y it always had. A flight, or
        // a walk of another unit, follows the pace: the server's position is
        // the last packet's, up to a heartbeat (500 ms) plus a map update
        // behind the walker, so a mover at several times run speed is
        // legitimately farther from its walker than a runner — 0.8 s of the
        // pace plus 10y, never under 15.
        float const driftTolerance = (m.flying || m.moverGuid) ? std::max(15.0f, pace * 0.8f + 10.0f) : 15.0f;
        auto drifted = [&]() -> bool
        {
            if (mover->GetExactDist2d(m.curX, m.curY) <= driftTolerance)
                return false;
            SendMovePacket(s, mover, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                mover->GetPositionX(), mover->GetPositionY(), mover->GetPositionZ(), mover->GetOrientation(),
                mover->GetTransport());
            FinishMove(s, "interrupted");
            return true;
        };
        if (nowMs - m.lastPacketMs >= 500 && !m.inFall)
        {
            if (drifted())
                return;
            SendMovePacket(s, mover, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO,
                TransportUnder(s, mover, m.curX, m.curY, m.curZ));
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
        }

        // A turn at a route point, reported when it happens, as a client
        // reports its own turn mid-run: MSG_MOVE_SET_FACING where the body is,
        // still running forward, with the new heading. Observers extrapolate
        // a run along the last heading they were sent, so without it they ran
        // on along the old leg until the next heartbeat (up to 500ms, with
        // route points a few yards apart) and then snapped back onto the
        // route. Once per change, against the heading last sent (sentO), so a
        // curve of small bends is reported once their sum is worth a packet;
        // the packet restarts the heartbeat interval, as any movement packet
        // does. Not mid-fall: nothing is sent between the edge and the landing.
        if (!m.inFall && AngleBetween(m.curO, m.sentO) > TURN_REPORT_RADIANS)
        {
            if (drifted())
                return;
            SendMovePacket(s, mover, MSG_MOVE_SET_FACING, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO,
                TransportUnder(s, mover, m.curX, m.curY, m.curZ));
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_SET_FACING")
                .Add("moveId", m.moveId).Add("cause", "turn")
                .Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
        }

        // Areatrigger volumes, as a client: the movement engine knows its own
        // position and the DBC, and fires CMSG_AREATRIGGER on entering one
        // without the player choosing to. After the heartbeat, so the server's
        // applied position is as close as possible to the one tested here.
        // Not mid-fall: the body is in the air on a line the fall's packets
        // never report, and the landing's column is tested on the next tick.
        // Only where the character itself travels: on its own feet, or on a
        // vehicle it sits in. A possessed unit flies off while the character
        // stands, and a client tests the character's own position.
        if (!m.inFall && !m.flying && (mover == player || player->GetVehicleBase() == mover))
            CheckAreaTriggers(s, player, mover, m.curX, m.curY, m.curZ, nowMs);
        if (!m.active)
            return; // (defensive: a synchronous finish is not expected here)

        // Progress events: the position the module's client-side movement engine
        // is at — knowledge a real client has locally. A walk of another
        // unit names it (`mover`): the position is that unit's.
        if (nowMs - m.lastProgressMs >= 1000)
        {
            m.lastProgressMs = nowMs;
            Json::Writer w;
            w.Add("moveId", m.moveId);
            if (m.moverGuid)
                w.AddGuid("mover", m.moverGuid);
            if (m.flying)
                w.Add("flight", true);
            w.Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO));
            w.Add("pathLength", (double)m.pathLength);
            if (m.etaMs > 0)
                w.Add("etaMs", m.etaMs);
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
    // each transport the session has been sent (knownObjects: the client's
    // own object cache) that is within the map's visibility range of the
    // character or that the character is aboard, plus `docked` — whether the
    // animation segment the clock is on has no displacement, i.e. the car
    // is dwelling at an end. Nothing here is beyond what the client computes
    // locally; it is the riding counterpart of WB_RIDE_PROGRESS for the car
    // rather than the passenger.
    //
    // The range is Map::GetVisibilityRange(), the distance at which the core
    // sends this client every other object (Visibility.Distance.*: 100y on
    // continents and 170y in instances by default). Transports are the
    // exception the core makes:
    // Map::SendInitTransports sends every one on the map at login, so on map
    // 0 a character in Westfall was told about every ship and zeppelin on the
    // continent, and reporting each one's clock every second was 56k of a
    // tank's 84k audit records and pushed its own move verdicts out of the
    // SDK's event ring in about 30s. A car the character could board or is
    // waiting for at a platform is within that range of it: the boarding
    // walk is a short straight line from the platform, and a tram car or a
    // ship comes into range while it is still pulling in, seconds before it
    // docks. When a reported car leaves the range the module sends one last
    // report with `inRange: false` and no `docked`, so the SDK's state does
    // not keep a car docked at a platform it has since left. World thread
    // only.
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
            float const range = map->GetVisibilityRange();
            Transport const* aboard = player->GetTransport();
            std::unordered_set<uint64_t> inRange;
            for (Transport* t : map->GetAllTransports())
            {
                if (!t || !t->IsInWorld())
                    continue;
                uint64_t const guid = (uint64_t)t->GetGUID().GetRawValue();
                {
                    std::lock_guard<std::mutex> lock(s->objMutex);
                    if (s->knownObjects.find(guid) == s->knownObjects.end())
                        continue; // never sent to this client: not observable
                }
                bool const near = t == aboard || player->GetExactDist2d(t) <= range;
                bool const wasNear = s->transportsInRange.count(guid) != 0;
                if (!near && !wasNear)
                    continue;
                Json::Writer w;
                w.AddGuid("guid", guid).Add("entry", t->GetEntry());
                w.Raw("pos", PosJson(t->GetPositionX(), t->GetPositionY(), t->GetPositionZ(), t->GetOrientation()));
                uint32 progress = t->GetPathProgress();
                w.Add("progressMs", progress);
                if (!near)
                {
                    // Left the range since the last batch: one last report,
                    // and no `docked`, which would go stale from here on.
                    w.Add("inRange", false);
                    EmitEvent(*s, "WB_TRANSPORT_PROGRESS", 0xFF06, w.Str());
                    continue;
                }
                inRange.insert(guid);
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
            // A map change leaves the old map's guids behind here unreported:
            // the core's SendRemoveTransports has already told the client
            // those cars are gone.
            s->transportsInRange = std::move(inRange);
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
                *p << uint32(ClientMSTime(*s));
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

    // Forced roots. Unit::SendMoveRoot roots a client-controlled unit by
    // packet alone: SMSG_FORCE_MOVE_ROOT / SMSG_FORCE_MOVE_UNROOT (packGUID,
    // u32 movement counter) to the controlling client, which stops, answers
    // CMSG_FORCE_MOVE_ROOT_ACK / CMSG_FORCE_MOVE_UNROOT_ACK and from then on
    // keeps itself still until the unroot; the server trusts it to. Stuns
    // arrive the same way (Unit::SetStunned -> SetRooted -> SendMoveRoot), and
    // so do death (Player::KillPlayer) and its end (BuildPlayerRepop,
    // ResurrectPlayer). A unit the client does not control (feared, confused)
    // is rooted server-side instead: MOVEMENTFLAG_ROOT set in place and
    // SMSG_SPLINE_MOVE_ROOT / UNROOT (packGUID alone) sent to the set, the
    // character's own client included. Only an unroot ack clears a
    // server-side ROOT once control is back (WorldSession::HandleMoveRootAck),
    // and while ROOT stands the core drops every movement packet
    // (VerifyMovementInfo), so a client that never answers is wedged for good:
    // the Deadmines fear-then-stun case.
    //
    // The ack is queued here, in the tap, the moment the server sends the
    // packet: in arrival order behind whatever the session already queued, and
    // before a far teleport later on can bump the map-change counter past it
    // (HandleMoveRootAck ignores a counter at or below
    // Player::GetMapChangeOrderCounter). Where the unroot and the far teleport
    // are one handler call (the repop's graveyard port to another map) no
    // client's ack can arrive in time; the ack is still sent, as a client
    // sends it.
    void Manager::OnRootPacket(BenchSession& s, WorldSession* ws, uint16_t opcode, WorldPacket const& packet)
    {
        Player* player = ws->GetPlayer();
        if (!player)
            return;
        uint64_t const self = player->GetGUID().GetRawValue();
        WorldPacket p(packet);
        try
        {
            if (opcode == SMSG_MULTIPLE_MOVES)
            {
                // Player::SendInitialPacketsAfterAddToMap (login, far port):
                // u32 size, then per sub-packet u8 length (opcode + body), u16
                // opcode, body. The root and the movement-state changes
                // (feather fall, water walk, hover) are answered in order, as
                // a client handles them; anything else is skipped.
                uint32 size = 0; p >> size;
                while (p.rpos() + 3 <= p.size())
                {
                    uint8 len = 0; uint16 sub = 0;
                    p >> len >> sub;
                    size_t const end = p.rpos() + (len >= 2 ? len - 2 : 0);
                    if (sub == SMSG_FORCE_MOVE_ROOT || sub == SMSG_FORCE_MOVE_UNROOT)
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        uint32 counter = 0; p >> counter;
                        if (guid == self)
                        {
                            s.rooted.store(sub == SMSG_FORCE_MOVE_ROOT);
                            AnswerForceRoot(s, ws, sub == SMSG_FORCE_MOVE_ROOT, guid, counter);
                        }
                    }
                    else if (sub == SMSG_MOVE_FEATHER_FALL || sub == SMSG_MOVE_WATER_WALK || sub == SMSG_MOVE_SET_HOVER)
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        uint32 counter = 0; p >> counter;
                        AnswerMoveFlag(s, ws, sub, guid, counter);
                    }
                    if (end > p.size())
                        break;
                    p.rpos(end);
                }
                return;
            }
            uint64 guid = 0; p.readPackGUID(guid);
            // The character's own, or the unit the client moves (a vehicle's
            // driving seat, a possession: OnClientControlUpdate), whose root
            // packets come to this client with that unit's guid once it is
            // the mover (Unit::SendMoveRoot, GetClientControlling); any other
            // unit's is not this client's state.
            bool const forMover = guid != self && guid == s.activeMover.load();
            if (guid != self && !forMover)
                return;
            bool const root = opcode == SMSG_FORCE_MOVE_ROOT || opcode == SMSG_SPLINE_MOVE_ROOT;
            (forMover ? s.moverRooted : s.rooted).store(root);
            if (opcode == SMSG_FORCE_MOVE_ROOT || opcode == SMSG_FORCE_MOVE_UNROOT)
            {
                uint32 counter = 0; p >> counter;
                AnswerForceRoot(s, ws, root, guid, counter);
            }
        }
        catch (std::exception const&)
        {
            // A short packet (ByteBufferException): nothing to answer.
        }
    }

    // The ack's body, as WorldSession::HandleMoveRootAck reads it: packGUID,
    // the echoed u32 counter, then a MovementInfo where the character is now,
    // with no moving flag (a rooted client has stopped) and MOVEMENTFLAG_ROOT
    // on the root ack only (ReadMovementInfo strips it on arrival anyway). The
    // server applies that MovementInfo (HandleMoverRelocation), so a root ack
    // during a walk is the walk's stop: it carries the mover's own point, where
    // this "client" stands, and the tick then ends the move `rooted` with no
    // further packet. Outside a walk it is the server's position. Reading the
    // mover here is safe: the tap runs during the core's session and map
    // updates, which the world script update (the mover's tick) never overlaps.
    void Manager::AnswerForceRoot(BenchSession& s, WorldSession* ws, bool root, uint64_t guid, uint32_t counter)
    {
        Player* player = ws->GetPlayer();
        if (!player)
            return;
        // The character, or the unit the client moves (OnRootPacket admits no
        // other): the ack carries that unit's guid and its point, as
        // HandleMoveRootAck wants the mover's.
        Unit* unit = guid == player->GetGUID().GetRawValue() ? static_cast<Unit*>(player) : ObjectAccessor::GetUnit(*player, ObjectGuid(guid));
        if (!unit)
            return;
        MoveState const& m = s.move;
        bool const walking = m.active && !m.inFall && WalkDrives(s, unit, player);
        float const x = walking ? m.curX : unit->GetPositionX();
        float const y = walking ? m.curY : unit->GetPositionY();
        float const z = walking ? m.curZ : unit->GetPositionZ();
        float const o = walking ? m.curO : unit->GetOrientation();
        Transport* transport = walking ? TransportUnder(s, unit, x, y, z) : unit->GetTransport();
        uint16 const opcode = root ? CMSG_FORCE_MOVE_ROOT_ACK : CMSG_FORCE_MOVE_UNROOT_ACK;
        WorldPacket* p = new WorldPacket(opcode, 8 + 4 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4);
        *p << unit->GetPackGUID();
        *p << uint32(counter);
        AppendAckMovementInfo(*p, s, unit, root ? MOVEMENTFLAG_ROOT : MOVEMENTFLAG_NONE, x, y, z, o, transport);
        ws->QueuePacket(p);
        Json::Writer a;
        a.Add("op", "root_ack")
            .Add("opcode", root ? "CMSG_FORCE_MOVE_ROOT_ACK" : "CMSG_FORCE_MOVE_UNROOT_ACK")
            .Add("counter", counter).Add("moveId", walking ? m.moveId : uint64_t(0));
        if (unit != player)
            a.AddGuid("mover", guid);
        Audit(s, "action", a.Raw("pos", PosJson(x, y, z, o)).Str());
    }

    // Forced speed changes. A unit its client controls changes speed by
    // packet (Unit::SetSpeed -> SendSpeedToController): SMSG_FORCE_*_SPEED_CHANGE
    // or SMSG_FORCE_*_RATE_CHANGE to the controlling client only, packGUID,
    // u32 movement counter, a u8 on the run-speed packet alone, then the new
    // speed. Nothing goes to observers until the client answers with the
    // matching CMSG_..._ACK: WorldSession::HandleForceSpeedChangeAck applies
    // the ack's MovementInfo and relays MSG_MOVE_SET_*_SPEED to the set, so a
    // client that never answers leaves every observer extrapolating its run at
    // the old speed while its heartbeats advance at the new one (a mount, a
    // dismount, a slow, a ghost's speed), and the core's count of unanswered
    // changes (Player::m_forced_speed_changes) only grows.
    //
    // Each change's ack; 0 for any other opcode.
    static uint16 SpeedChangeAckOpcode(uint16 opcode)
    {
        switch (opcode)
        {
            case SMSG_FORCE_WALK_SPEED_CHANGE:        return CMSG_FORCE_WALK_SPEED_CHANGE_ACK;
            case SMSG_FORCE_RUN_SPEED_CHANGE:         return CMSG_FORCE_RUN_SPEED_CHANGE_ACK;
            case SMSG_FORCE_RUN_BACK_SPEED_CHANGE:    return CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK;
            case SMSG_FORCE_SWIM_SPEED_CHANGE:        return CMSG_FORCE_SWIM_SPEED_CHANGE_ACK;
            case SMSG_FORCE_SWIM_BACK_SPEED_CHANGE:   return CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK;
            case SMSG_FORCE_TURN_RATE_CHANGE:         return CMSG_FORCE_TURN_RATE_CHANGE_ACK;
            case SMSG_FORCE_FLIGHT_SPEED_CHANGE:      return CMSG_FORCE_FLIGHT_SPEED_CHANGE_ACK;
            case SMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE: return CMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE_ACK;
            case SMSG_FORCE_PITCH_RATE_CHANGE:        return CMSG_FORCE_PITCH_RATE_CHANGE_ACK;
            default:                                  return 0;
        }
    }

    static char const* SpeedChangeAckName(uint16 ack)
    {
        switch (ack)
        {
            case CMSG_FORCE_WALK_SPEED_CHANGE_ACK:        return "CMSG_FORCE_WALK_SPEED_CHANGE_ACK";
            case CMSG_FORCE_RUN_SPEED_CHANGE_ACK:         return "CMSG_FORCE_RUN_SPEED_CHANGE_ACK";
            case CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK:    return "CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK";
            case CMSG_FORCE_SWIM_SPEED_CHANGE_ACK:        return "CMSG_FORCE_SWIM_SPEED_CHANGE_ACK";
            case CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK:   return "CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK";
            case CMSG_FORCE_TURN_RATE_CHANGE_ACK:         return "CMSG_FORCE_TURN_RATE_CHANGE_ACK";
            case CMSG_FORCE_FLIGHT_SPEED_CHANGE_ACK:      return "CMSG_FORCE_FLIGHT_SPEED_CHANGE_ACK";
            case CMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE_ACK: return "CMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE_ACK";
            case CMSG_FORCE_PITCH_RATE_CHANGE_ACK:        return "CMSG_FORCE_PITCH_RATE_CHANGE_ACK";
            default:                                      return "CMSG_FORCE_SPEED_CHANGE_ACK";
        }
    }

    // Where this "client" is and what it is doing at the moment it answers a
    // forced change, for the MovementInfo of the ack: the speed-change and
    // movement-state acks both carry one, and their handlers apply it
    // (ProcessMovementInfo) and relay it, so it must be the client's own
    // state. During a walk, the mover's point running forward, so the ack is
    // one more packet of the run (the core reads it as it reads a heartbeat);
    // stopping, the stop's point with no moving flag; rooted, the root ack's
    // point with MOVEMENTFLAG_ROOT (a rooted client is still). Mid-fall the
    // module sends nothing (a forced ledge's packets are the edge heartbeat
    // and the landing), so the ack restates the edge heartbeat, the server's
    // own position running forward: the server's fall start stays where the
    // edge put it (UpdateFallInformationIfNeed sees the same z) and the
    // landing is charged the whole ledge. Outside a walk, the server's
    // position, standing. One function, so the two kinds of ack cannot
    // disagree. Read from the tap like AnswerForceRoot, and safe for the same
    // reason.
    struct AckPose
    {
        float x, y, z, o;
        Transport* transport;
        uint32 flags;
        uint64_t moveId;  // the walk it was sent during, 0 outside one
    };

    // For `unit`: the character, or the unit the client moves. The walk's
    // point only when the walk drives this unit (WalkDrives); the rooted
    // state is this unit's (RootedFor).
    static AckPose ClientPoseForAck(BenchSession& s, Player* player, Unit* unit)
    {
        MoveState const& m = s.move;
        bool const rooted = RootedFor(s, unit, player);
        bool const drives = WalkDrives(s, unit, player);
        bool const atMover = drives && !m.inFall && unit->IsInWorld();
        bool const running = drives && !m.stopping && !rooted;
        AckPose a;
        a.x = atMover ? m.curX : unit->GetPositionX();
        a.y = atMover ? m.curY : unit->GetPositionY();
        a.z = atMover ? m.curZ : unit->GetPositionZ();
        a.o = atMover ? m.curO : unit->GetOrientation();
        a.transport = atMover ? TransportUnder(s, unit, a.x, a.y, a.z) : unit->GetTransport();
        a.flags = rooted ? MOVEMENTFLAG_ROOT : (running ? MOVEMENTFLAG_FORWARD : MOVEMENTFLAG_NONE);
        a.moveId = drives ? m.moveId : uint64_t(0);
        return a;
    }

    // Each change's movement type, as HandleForceSpeedChangeAck maps its ack.
    static UnitMoveType SpeedChangeMoveType(uint16 opcode)
    {
        switch (opcode)
        {
            case SMSG_FORCE_WALK_SPEED_CHANGE:        return MOVE_WALK;
            case SMSG_FORCE_RUN_SPEED_CHANGE:         return MOVE_RUN;
            case SMSG_FORCE_RUN_BACK_SPEED_CHANGE:    return MOVE_RUN_BACK;
            case SMSG_FORCE_SWIM_SPEED_CHANGE:        return MOVE_SWIM;
            case SMSG_FORCE_SWIM_BACK_SPEED_CHANGE:   return MOVE_SWIM_BACK;
            case SMSG_FORCE_TURN_RATE_CHANGE:         return MOVE_TURN_RATE;
            case SMSG_FORCE_FLIGHT_SPEED_CHANGE:      return MOVE_FLIGHT;
            case SMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE: return MOVE_FLIGHT_BACK;
            default:                                  return MOVE_PITCH_RATE;
        }
    }

    // The tap's half: read the change and queue its answer
    // (BenchSession::pendingAnswers) for the next world tick, which sends it
    // (SendSpeedChangeAck). Only the character's own guid is answered.
    void Manager::OnSpeedChangePacket(BenchSession& s, WorldSession* ws, uint16_t opcode, WorldPacket const& packet)
    {
        Player* player = ws->GetPlayer();
        if (!SpeedChangeAckOpcode(opcode) || !player)
            return;
        uint64 guid = 0;
        uint32 counter = 0;
        float speed = 0.0f;
        try
        {
            WorldPacket p(packet);
            p.readPackGUID(guid);
            p >> counter;
            if (opcode == SMSG_FORCE_RUN_SPEED_CHANGE)
                p.read_skip<uint8>();
            p >> speed;
        }
        catch (std::exception const&)
        {
            return; // a short packet (ByteBufferException): nothing to answer
        }
        if (guid != player->GetGUID().GetRawValue())
            return; // a vehicle or a charmed mover: never driven by the module
        std::lock_guard<std::mutex> lock(s.answerMutex);
        s.pendingAnswers.push_back({ opcode, counter, speed });
    }

    // The ack's body, as HandleForceSpeedChangeAck reads it: packGUID, the
    // echoed u32 counter, a MovementInfo (ClientPoseForAck), then the speed
    // the packet named, echoed as a client echoes it, never the module's own
    // reading. An ack whose counter is at or below the last far teleport's is
    // ignored as from the old map, as a client's is.
    //
    // The handler checks the speed only on the ack that brings the core's
    // count of unanswered changes of that type (Player::m_forced_speed_changes)
    // to zero, against the server's speed when it reads the ack: it corrects
    // a lower one and kicks the player ("Incorrect speed") for a higher one.
    // Not every speed change bumps that count: while the character is not
    // under its client's control (feared, confused, charmed, a disabled
    // mover) Unit::SetSpeed sends the creature opcode to the set instead and
    // the count stays where it was. So a change that lands between the
    // forced change and its ack's arrival can leave the last ack echoing a
    // speed the server no longer has, and the session is kicked for it. The
    // ack is therefore judged here, on the world tick, where the core reads
    // it at the start of the next map update: one that would be the last of
    // its type outstanding (counting those already sent this tick, which the
    // core has not read yet) and whose speed is no longer the server's is
    // withheld. The count then stays one high, which only means the core
    // skips the check on the next change's ack of that type: lenient, never
    // a kick. Everything else is sent as the client would.
    void Manager::SendSpeedChangeAck(BenchSession& s, WorldSession* ws, Player* player, uint16_t opcode, uint32_t counter,
        float speed, uint8_t alreadySent)
    {
        uint16 const ackOpcode = SpeedChangeAckOpcode(opcode);
        UnitMoveType const type = SpeedChangeMoveType(opcode);
        uint8 const outstanding = player->m_forced_speed_changes[type];
        bool const last = outstanding <= alreadySent + 1;
        float const serverSpeed = player->GetSpeed(type);
        AckPose const a = ClientPoseForAck(s, player, player);
        if (last && std::fabs(serverSpeed - speed) > 0.01f)
        {
            Audit(s, "action", Json::Writer().Add("op", "move_ack").Add("kind", "speed")
                .Add("opcode", SpeedChangeAckName(ackOpcode))
                .Add("counter", counter).Add("speed", (double)speed)
                .Add("withheld", true).Add("serverSpeed", (double)serverSpeed)
                .Add("moveId", a.moveId)
                .Raw("pos", PosJson(a.x, a.y, a.z, a.o)).Str());
            return;
        }
        WorldPacket* p = new WorldPacket(ackOpcode, 8 + 4 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4 + 4);
        *p << player->GetPackGUID();
        *p << uint32(counter);
        AppendAckMovementInfo(*p, s, player, a.flags, a.x, a.y, a.z, a.o, a.transport);
        *p << float(speed);
        ws->QueuePacket(p);
        Audit(s, "action", Json::Writer().Add("op", "move_ack").Add("kind", "speed")
            .Add("opcode", SpeedChangeAckName(ackOpcode))
            .Add("counter", counter).Add("speed", (double)speed)
            .Add("moveId", a.moveId)
            .Raw("pos", PosJson(a.x, a.y, a.z, a.o)).Str());
    }

    // The world tick's half of the deferred answers (BenchSession::
    // pendingAnswers), in the order the server asked. A time-sync response
    // carries the counter and the client clock (ClientMSTime) now, stamped
    // as received now: the request's send stamp (SendTimeSync, set after the
    // tap returned) always exists by this tick and precedes it, so the core's
    // round trip (HandleTimeSyncResp, a u32 difference) never wraps, which it
    // did when the answer was stamped inside the tap a millisecond boundary
    // before the send. Every live session is served, in a map or not: a far
    // teleport's requests (ResetTimeSync, SendTimeSync on arrival) and the
    // session's packet queue keep going while the character is between maps.
    void Manager::TickClientAnswers()
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load())
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            std::vector<BenchSession::PendingAnswer> answers;
            {
                std::lock_guard<std::mutex> lock(s->answerMutex);
                answers.swap(s->pendingAnswers);
            }
            if (answers.empty())
                continue;
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            uint8 sent[MAX_MOVE_TYPE] = {};
            for (auto const& a : answers)
            {
                if (a.opcode == SMSG_TIME_SYNC_REQ)
                {
                    WorldPacket tmp(CMSG_TIME_SYNC_RESP, 8);
                    tmp << a.counter << uint32(ClientMSTime(*s));
                    s->ws->QueuePacket(new WorldPacket(std::move(tmp), std::chrono::steady_clock::now()));
                    continue;
                }
                Player* player = s->ws->GetPlayer();
                if (!player)
                    continue;
                UnitMoveType const type = SpeedChangeMoveType(a.opcode);
                SendSpeedChangeAck(*s, s->ws, player, a.opcode, a.counter, a.speed, sent[type]);
                if (sent[type] < 255)
                    ++sent[type];
            }
        }
    }

    // Forced movement-state changes. A unit its client controls gains or
    // loses water walking, feather fall, hover or the ability to fly by packet
    // alone (Unit::SetWaterWalking, SetFeatherFall, SetHover, SetCanFly, from
    // the auras that grant them and from the ghost's repop and resurrection):
    // the set/unset packet below to the controlling client only, packGUID and
    // a u32 movement counter, and the core does not touch its own record of
    // the flag. The client sets or clears the flag, carries it on every
    // movement packet from then on, and answers with the ack:
    // WorldSession::HandleMoveFlagChangeOpcode, one handler for all four, which
    // reads packGUID, the counter, a MovementInfo and a u32 it never uses (1
    // set, 0 unset here), copies the MovementInfo's flags into the unit's
    // record (before its old-map counter check), applies the MovementInfo
    // (ProcessMovementInfo, fall start included), clears the pending flight
    // change on a can-fly ack whose counter matches, and relays MSG_MOVE_*
    // with the MovementInfo to the set. Unanswered, no observer ever learned a
    // ghost walks on water, and the next heartbeat (no flag) said otherwise.
    // Login and far teleports send the first three inside SMSG_MULTIPLE_MOVES
    // (OnRootPacket); a unit the client does not control (feared, confused)
    // gets the SMSG_SPLINE_MOVE_ twin of the first three instead, which sets
    // the flag server-side and wants no ack, but the client keeps it as its
    // own state all the same.
    struct MoveFlagChange
    {
        uint16 ack;         // the client's answer, 0 for a spline twin (none)
        uint32 flag;        // the MovementFlags bit it sets or clears
        bool apply;
        char const* kind;   // the audit's name for it
        char const* ackName;
    };

    static bool LookupMoveFlagChange(uint16 opcode, MoveFlagChange& c)
    {
        switch (opcode)
        {
            case SMSG_MOVE_WATER_WALK:
                c = { CMSG_MOVE_WATER_WALK_ACK, MOVEMENTFLAG_WATERWALKING, true, "water_walk", "CMSG_MOVE_WATER_WALK_ACK" };
                return true;
            case SMSG_MOVE_LAND_WALK:
                c = { CMSG_MOVE_WATER_WALK_ACK, MOVEMENTFLAG_WATERWALKING, false, "water_walk", "CMSG_MOVE_WATER_WALK_ACK" };
                return true;
            case SMSG_MOVE_FEATHER_FALL:
                c = { CMSG_MOVE_FEATHER_FALL_ACK, MOVEMENTFLAG_FALLING_SLOW, true, "feather_fall", "CMSG_MOVE_FEATHER_FALL_ACK" };
                return true;
            case SMSG_MOVE_NORMAL_FALL:
                c = { CMSG_MOVE_FEATHER_FALL_ACK, MOVEMENTFLAG_FALLING_SLOW, false, "feather_fall", "CMSG_MOVE_FEATHER_FALL_ACK" };
                return true;
            case SMSG_MOVE_SET_HOVER:
                c = { CMSG_MOVE_HOVER_ACK, MOVEMENTFLAG_HOVER, true, "hover", "CMSG_MOVE_HOVER_ACK" };
                return true;
            case SMSG_MOVE_UNSET_HOVER:
                c = { CMSG_MOVE_HOVER_ACK, MOVEMENTFLAG_HOVER, false, "hover", "CMSG_MOVE_HOVER_ACK" };
                return true;
            case SMSG_MOVE_SET_CAN_FLY:
                c = { CMSG_MOVE_SET_CAN_FLY_ACK, MOVEMENTFLAG_CAN_FLY, true, "can_fly", "CMSG_MOVE_SET_CAN_FLY_ACK" };
                return true;
            case SMSG_MOVE_UNSET_CAN_FLY:
                c = { CMSG_MOVE_SET_CAN_FLY_ACK, MOVEMENTFLAG_CAN_FLY, false, "can_fly", "CMSG_MOVE_SET_CAN_FLY_ACK" };
                return true;
            case SMSG_SPLINE_MOVE_WATER_WALK:
                c = { 0, MOVEMENTFLAG_WATERWALKING, true, "water_walk", nullptr };
                return true;
            case SMSG_SPLINE_MOVE_LAND_WALK:
                c = { 0, MOVEMENTFLAG_WATERWALKING, false, "water_walk", nullptr };
                return true;
            case SMSG_SPLINE_MOVE_FEATHER_FALL:
                c = { 0, MOVEMENTFLAG_FALLING_SLOW, true, "feather_fall", nullptr };
                return true;
            case SMSG_SPLINE_MOVE_NORMAL_FALL:
                c = { 0, MOVEMENTFLAG_FALLING_SLOW, false, "feather_fall", nullptr };
                return true;
            case SMSG_SPLINE_MOVE_SET_HOVER:
                c = { 0, MOVEMENTFLAG_HOVER, true, "hover", nullptr };
                return true;
            case SMSG_SPLINE_MOVE_UNSET_HOVER:
                c = { 0, MOVEMENTFLAG_HOVER, false, "hover", nullptr };
                return true;
            default:
                return false;
        }
    }

    void Manager::OnMoveFlagPacket(BenchSession& s, WorldSession* ws, uint16_t opcode, WorldPacket const& packet)
    {
        MoveFlagChange c;
        Player* player = ws->GetPlayer();
        if (!player || !LookupMoveFlagChange(opcode, c))
            return;
        uint64 guid = 0;
        uint32 counter = 0;
        try
        {
            WorldPacket p(packet);
            p.readPackGUID(guid);
            if (c.ack)
                p >> counter;
        }
        catch (std::exception const&)
        {
            return; // a short packet (ByteBufferException): nothing to answer
        }
        // The character's own, or the unit the client moves (its can-fly and
        // the rest come to this client with that unit's guid: Unit::SetCanFly
        // on a client-controlled unit); any other unit's spline change is not
        // this client's state.
        bool const forMover = guid != player->GetGUID().GetRawValue() && guid == s.activeMover.load();
        if (guid != player->GetGUID().GetRawValue() && !forMover)
            return;
        if (!c.ack)
        {
            // The spline twin: the server has set the flag itself; the client
            // only takes it as its own state.
            std::atomic<uint32_t>& flags = forMover ? s.moverMoveFlags : s.stateMoveFlags;
            if (c.apply)
                flags.fetch_or(c.flag);
            else
                flags.fetch_and(~c.flag);
            return;
        }
        AnswerMoveFlag(s, ws, opcode, guid, counter);
    }

    // The flag first, then the ack, so the ack (AppendMovementInfo) carries
    // the new state as a client's does, less AppendMovementInfo's two
    // deliberate gaps: a can-fly ack is still sent (it tells observers, and
    // clears the server's pending flight change) but says the character
    // cannot fly, and a water-walk ack sent mid-swim drops the flag. The ack's MovementInfo is
    // ClientPoseForAck's, as the speed acks'. Only for the unit the session
    // moves right now: HandleMoveFlagChangeOpcode writes the ack's flags onto
    // Player::m_mover without checking the guid, so an ack for the character
    // while it drives a vehicle or a possessed unit would set them on that
    // unit, and one for the unit after control returned would set them on the
    // character; the flag is kept either way, for the unit it was sent to
    // (stateMoveFlags, moverMoveFlags), and the ack follows when it is the mover.
    void Manager::AnswerMoveFlag(BenchSession& s, WorldSession* ws, uint16_t opcode, uint64_t guid, uint32_t counter)
    {
        MoveFlagChange c;
        Player* player = ws->GetPlayer();
        if (!player || !LookupMoveFlagChange(opcode, c) || !c.ack)
            return;
        bool const self = player->GetGUID().GetRawValue() == guid;
        if (!self && guid != s.activeMover.load())
            return;
        std::atomic<uint32_t>& flags = self ? s.stateMoveFlags : s.moverMoveFlags;
        if (c.apply)
            flags.fetch_or(c.flag);
        else
            flags.fetch_and(~c.flag);
        Unit* unit = self ? static_cast<Unit*>(player) : ObjectAccessor::GetUnit(*player, ObjectGuid(guid));
        if (!unit || static_cast<Unit*>(player->m_mover) != unit)
            return;

        AckPose const a = ClientPoseForAck(s, player, unit);
        WorldPacket* p = new WorldPacket(c.ack, 8 + 4 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4 + 4);
        *p << unit->GetPackGUID();
        *p << uint32(counter);
        AppendAckMovementInfo(*p, s, unit, a.flags, a.x, a.y, a.z, a.o, a.transport);
        *p << uint32(c.apply ? 1 : 0);  // read as a u32 and never used (HandleMoveFlagChangeOpcode)
        ws->QueuePacket(p);
        Json::Writer w;
        w.Add("op", "move_ack").Add("kind", c.kind)
            .Add("opcode", c.ackName)
            .Add("counter", counter).Add("apply", c.apply)
            .Add("moveId", a.moveId);
        if (!self)
            w.AddGuid("mover", guid);
        Audit(s, "action", w.Raw("pos", PosJson(a.x, a.y, a.z, a.o)).Str());
    }

    // Client control. Player::SetClientControl tells the client which unit
    // it moves and whether it may: SMSG_CLIENT_CONTROL_UPDATE, packGUID and
    // a u8 (1 move it, 0 not). A possession and a vehicle's driving seat
    // (Unit::SetCharmedBy, CHARM_TYPE_POSSESS / CHARM_TYPE_VEHICLE) send
    // (unit, 1) and SetMover(unit); the end of either (RemoveCharmedBy)
    // sends (unit, 0) then (character, 1) and SetMover(character); a fear
    // or confusion sends (character, 0) and (character, 1) with no mover
    // change. From the handover on every movement packet and ack must carry
    // the mover's guid (HandleMovementOpcodes, HandleMoveRootAck and
    // HandleMoveFlagChangeOpcode all read Player::m_mover), so the module
    // keeps it (BenchSession::activeMover) and sends what a stock client
    // sends on the handover, client behaviour and never an agent action:
    // CMSG_SET_ACTIVE_MOVER (u64 guid) for a unit it may now move, which
    // HandleSetActiveMoverOpcode only checks against m_mover, and
    // CMSG_MOVE_NOT_ACTIVE_MOVER (packGUID, MovementInfo) for the unit it
    // stops moving, whose MovementInfo HandleMoveNotActiveMover keeps only
    // while that unit is still the mover (by the time the queue is read the
    // core has run SetMover for the character; a real client's packet
    // crosses it the same way). The packet is served as an event too
    // (DecodeEvent), which is what the SDK shows as state.self.control.
    void Manager::OnClientControlUpdate(BenchSession& s, WorldSession* ws, WorldPacket const& packet)
    {
        Player* player = ws->GetPlayer();
        if (!player)
            return;
        uint64 guid = 0;
        uint8 allowMove = 0;
        try
        {
            WorldPacket p(packet);
            p.readPackGUID(guid);
            p >> allowMove;
        }
        catch (std::exception const&)
        {
            return; // a short packet (ByteBufferException): nothing to answer
        }
        uint64_t const self = player->GetGUID().GetRawValue();
        uint64_t const before = s.activeMover.load();
        if (allowMove)
        {
            s.activeMover.store(guid == self ? 0 : guid);
            // The unit's state as this client now holds it: rooted when its
            // create block carried ROOT (a spline root set before the
            // handover, when no client controlled it), and the
            // movement-state flags its create block and spline packets
            // carried (a flying creature's can-fly or no gravity, a hover,
            // its water walking, its feather fall: each set by a core
            // function that sends the set/unset to the set while no client
            // controls the unit). Not FLYING: the core adds it to a possessed
            // flyer in place (Unit::SetCharmedBy) and tells no client, so the
            // walk sets it on its own packets while it flies, as a client's
            // physics do (AppendMovementInfo). The packets for its guid keep
            // both from here (OnRootPacket, OnMoveFlagPacket).
            if (guid != self)
            {
                Unit* unit = ObjectAccessor::GetUnit(*player, ObjectGuid(guid));
                s.moverRooted.store(unit && unit->m_movementInfo.HasMovementFlag(MOVEMENTFLAG_ROOT));
                s.moverMoveFlags.store(!unit ? 0 : unit->m_movementInfo.GetMovementFlags()
                    & uint32(MOVEMENTFLAG_CAN_FLY | MOVEMENTFLAG_DISABLE_GRAVITY | MOVEMENTFLAG_HOVER
                        | MOVEMENTFLAG_WATERWALKING | MOVEMENTFLAG_FALLING_SLOW));
            }
            WorldPacket* p = new WorldPacket(CMSG_SET_ACTIVE_MOVER, 8);
            *p << uint64(guid);
            ws->QueuePacket(p);
            Audit(s, "action", Json::Writer().Add("op", "active_mover").Add("opcode", "CMSG_SET_ACTIVE_MOVER")
                .AddGuid("guid", (uint64_t)guid).Add("self", guid == self).Str());
            return;
        }
        if (guid == self || before != guid)
            return; // control of the character itself withheld (a fear), or a unit this client was not moving
        s.activeMover.store(0);
        s.moverRooted.store(false);
        s.moverMoveFlags.store(0);
        // The unit's own position and flags, as the server holds them: the
        // tap runs inside the map update, where reading it is safe (as
        // AnswerForceRoot reads the character).
        Unit* unit = ObjectAccessor::GetUnit(*player, ObjectGuid(guid));
        if (!unit)
            return;
        WorldPacket* p = new WorldPacket(CMSG_MOVE_NOT_ACTIVE_MOVER, 8 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4);
        *p << unit->GetPackGUID();
        AppendUnitMovementInfo(*p, s, unit);
        ws->QueuePacket(p);
        Audit(s, "action", Json::Writer().Add("op", "active_mover").Add("opcode", "CMSG_MOVE_NOT_ACTIVE_MOVER")
            .AddGuid("guid", (uint64_t)guid)
            .Raw("pos", PosJson(unit->GetPositionX(), unit->GetPositionY(), unit->GetPositionZ(), unit->GetOrientation())).Str());
    }

    // The packGUID at the head of a packet, read in place (no copy: every
    // SMSG_MONSTER_MOVE on the map passes OnSelfSpline, and only the
    // character's own is read further). False on a short packet.
    static bool PeekPackGUID(WorldPacket const& packet, uint64& guid)
    {
        if (packet.size() < 1)
            return false;
        uint8 const mask = packet[0];
        size_t pos = 1;
        guid = 0;
        for (uint8 i = 0; i < 8; ++i)
        {
            if (!(mask & (uint8(1) << i)))
                continue;
            if (pos >= packet.size())
                return false;
            guid |= uint64(packet[pos++]) << (i * 8);
        }
        return true;
    }

    // The splines a vehicle moves the character on: onto its seat
    // (Vehicle::AddPassenger, MoveSplineInit::SetTransportEnter) and off it
    // (Unit::_ExitVehicle, SetTransportExit), each sent to the character too
    // as SMSG_MONSTER_MOVE_TRANSPORT or SMSG_MONSTER_MOVE. A client reports
    // the end of each with CMSG_MOVE_SPLINE_DONE (packGUID, its MovementInfo,
    // u32 spline id; TaxiHandler.cpp HandleMoveSplineDoneOpcode). The core
    // takes the report only while the character is its own mover — a
    // passenger seat's boarding, and every exit (RemoveCharmedBy restores the
    // mover before the exit spline) — and then clears the "expecting a
    // transport change" it set when it launched the spline
    // (Player::SetExpectingChangeTransport) and relays the body's root state
    // to the set; from a driving seat the vehicle is the mover and the report
    // is dropped (mover->GetGUID() != guid), as a stock client's is. The tap
    // only notes the spline id (BenchSession::pendingSplineDone); the world
    // tick sends the report once the core has run the spline to its end
    // (TickSplineDone). Only the character's own guid, and only the two
    // boarding flags: a taxi's spline is the server's own flight, ended by
    // the core itself.
    void Manager::OnSelfSpline(BenchSession& s, WorldSession* ws, uint16_t opcode, WorldPacket const& packet)
    {
        Player* player = ws->GetPlayer();
        if (!player)
            return;
        uint64 head = 0;
        if (!PeekPackGUID(packet, head) || head != player->GetGUID().GetRawValue())
            return;
        try
        {
            WorldPacket p(packet);
            uint64 guid = 0; p.readPackGUID(guid);
            if (opcode == SMSG_MONSTER_MOVE_TRANSPORT)
            {
                uint64 transportGuid = 0; p.readPackGUID(transportGuid); // the vehicle: DecodeEvent serves it
                (void)transportGuid;
                p.read_skip<int8>();            // seat
            }
            p.read_skip<uint8>();               // toggle
            p.read_skip<float>(); p.read_skip<float>(); p.read_skip<float>();
            uint32 splineId = 0; p >> splineId;
            uint8 type = 0; p >> type;
            if (type == 1)                      // MonsterMoveStop: no flags follow
                return;
            switch (type)
            {
                case 2: p.read_skip<float>(); p.read_skip<float>(); p.read_skip<float>(); break; // facing spot
                case 3: p.read_skip<uint64>(); break;                                             // facing target
                case 4: p.read_skip<float>(); break;                                              // facing angle
                default: break;
            }
            uint32 splineFlags = 0; p >> splineFlags;
            if (splineFlags & (0x00800000 | 0x01000000)) // MoveSplineFlag::TransportEnter | TransportExit
                s.pendingSplineDone.store(splineId);
        }
        catch (std::exception const&)
        {
            // A short packet (ByteBufferException): nothing to report.
        }
    }

    // The world tick's half: once the core has finished the spline the tap
    // noted (Unit::UpdateSplineMovement marks it done), send the client's
    // report. The body is the character's own as it then stands
    // (AppendUnitMovementInfo: on its seat, the transport block names the
    // vehicle and the seat; off it, the exit point), and the spline id is
    // the one the packet carried. A later spline with another id makes the
    // report moot (the core checks the id), so it is dropped.
    void Manager::TickSplineDone()
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (!s->tearingDown.load() && s->pendingSplineDone.load() != 0)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
        {
            uint32_t const id = s->pendingSplineDone.load();
            if (!s->ws || sWorldSessionMgr->FindSession(s->accountId) != s->ws)
                continue;
            Player* player = s->ws->GetPlayer();
            if (!player || !player->IsInWorld() || !player->movespline)
                continue;
            if (player->movespline->GetId() != id)
            {
                s->pendingSplineDone.store(0);
                continue;
            }
            if (!player->movespline->Finalized())
                continue;
            s->pendingSplineDone.store(0);
            WorldPacket* p = new WorldPacket(CMSG_MOVE_SPLINE_DONE, 8 + 4 + 2 + 4 + 16 + 8 + 16 + 4 + 1 + 4 + 4 + 4);
            *p << player->GetPackGUID();
            AppendUnitMovementInfo(*p, *s, player);
            *p << uint32(id);
            s->ws->QueuePacket(p);
            Audit(*s, "action", Json::Writer().Add("op", "spline_done").Add("opcode", "CMSG_MOVE_SPLINE_DONE")
                .Add("splineId", id)
                .Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation())).Str());
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
        ack->set_value({200, Json::Writer().Add("ok", true).Str()});
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

        // Time sync, answered as a client answers it: after a round trip, on
        // the module's next world tick (TickClientAnswers), with the client's
        // own clock (ClientMSTime) then and stamped as received then. Not
        // here: the tap runs inside SendPacket, before SendTimeSync stamps the
        // request's send time, so an answer stamped here could precede it
        // across a millisecond boundary and the core's u32 round trip
        // (HandleTimeSyncResp) wrapped to ~2^32 ms, its clock offset to ~2^31
        // ms (relayed movement times ~24.8 days out). Not GameTime::Now(), the
        // socket's stamp for a real client's answer, for the same reason: the
        // start of the tick that sent the request precedes the send.
        if (opcode == SMSG_TIME_SYNC_REQ)
        {
            WorldPacket copy(packet);
            uint32 counter = 0;
            if (copy.size() >= 4) copy >> counter;
            std::lock_guard<std::mutex> lock(s->answerMutex);
            s->pendingAnswers.push_back({ SMSG_TIME_SYNC_REQ, counter, 0.0f });
        }

        // A new world, or the first: the client starts its movement state
        // afresh and the server restates what still holds (the auras' own
        // packets, SMSG_MULTIPLE_MOVES) once the character is added to the
        // map, after this packet. An unset the server suppressed while the
        // character was out of the world (Unit::SetWaterWalking and the rest
        // send nothing then) would otherwise leave a stale bit.
        if (opcode == SMSG_NEW_WORLD || opcode == SMSG_LOGIN_VERIFY_WORLD)
        {
            s->stateMoveFlags.store(0);
            // The character is its own mover again once it is in the map
            // (Player::SendInitialPacketsAfterAddToMap, SetMover(this)), and
            // no boarding spline survives a map change.
            s->activeMover.store(0);
            s->moverRooted.store(false);
            s->moverMoveFlags.store(0);
            s->pendingSplineDone.store(0);
        }

        // Forced and spline roots: the rooted state, and the client's ack.
        if (opcode == SMSG_FORCE_MOVE_ROOT || opcode == SMSG_FORCE_MOVE_UNROOT
            || opcode == SMSG_SPLINE_MOVE_ROOT || opcode == SMSG_SPLINE_MOVE_UNROOT
            || opcode == SMSG_MULTIPLE_MOVES)
            OnRootPacket(*s, ws, opcode, packet);

        // Forced speed changes: the client's ack, which is what tells observers.
        if (SpeedChangeAckOpcode(opcode))
            OnSpeedChangePacket(*s, ws, opcode, packet);

        // Forced movement-state changes (water walk, feather fall, hover,
        // can-fly) and their spline twins: the client's state, and its ack.
        if (MoveFlagChange c; LookupMoveFlagChange(opcode, c))
            OnMoveFlagPacket(*s, ws, opcode, packet);

        // Client control: a vehicle's driving seat or a possession hands the
        // client another unit to move and takes it back (OnClientControlUpdate).
        if (opcode == SMSG_CLIENT_CONTROL_UPDATE)
            OnClientControlUpdate(*s, ws, packet);

        // The boarding and exit splines a vehicle moves the character on,
        // whose end the client reports (OnSelfSpline, TickSplineDone).
        if (opcode == SMSG_MONSTER_MOVE || opcode == SMSG_MONSTER_MOVE_TRANSPORT)
            OnSelfSpline(*s, ws, opcode, packet);

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
                            s->ack->set_value({200, Json::Writer().Add("ok", true)
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
                            s->ack->set_value({200, Json::Writer().Add("ok", true)
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
    // No reply on the session surface names the caller's token (PROTOCOL.md,
    // "Authentication"): it is the caller's own opaque session id, so echoing
    // it told the caller nothing, and an action reply flows into snippet
    // results and from there into trajectories and the published feed. Only
    // the operator-only lease replies carry it, to pair a secret with its token.
    void Manager::SucceedAck(BenchSession& s)
    {
        if (s.ackFired.exchange(true) || !s.ack)
            return;
        Json::Writer w;
        w.Add("ok", true).Add("account", s.account)
         .Add("character", s.charName).AddGuid("guid", s.targetGuidRaw).Add("inWorld", true);
        s.ack->set_value({200, w.Str()});
    }

    void Manager::FailAck(BenchSession& s, std::string const& message, int status /*= 502*/)
    {
        if (!s.ackFired.exchange(true) && s.ack)
            s.ack->set_value({status, Json::Writer().Add("ok", false).Add("error", message).Str()});

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

        // A reattach replay goes to the connections that asked for it, not to
        // every subscriber of the token (EmitSessionState sets the targets for
        // the burst's duration, on the world thread with no map updating, so
        // every packet sent meanwhile is the replay's own).
        if (auto const* targets = s.replayTargets.load())
        {
            for (auto& c : *targets)
                c->Send(json);
            return;
        }
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

    void Manager::OpenAudit(BenchSession& s, int64_t day)
    {
        if (s.audit.is_open())
            s.audit.close();
        s.audit.clear();
        time_t const t = static_cast<time_t>(day) * 86400;
        struct tm tm;
        char date[16] = "";
        if (gmtime_r(&t, &tm))
            std::strftime(date, sizeof date, "%Y-%m-%d", &tm);
        // Named, and every record tagged, by the token's fingerprint, never the
        // token: the files are operational records an operator reads, copies
        // and prunes, and a token never leaves the session it names.
        if (s.auditStem.empty())
        {
            s.auditStem = TokenFingerprint(s.token);
            s.auditTag = TokenTag(s.token);
        }
        s.audit.open(_auditDir + "/" + s.auditStem + "." + date + ".jsonl", std::ios::out | std::ios::app);
        s.auditDay = day;
    }

    void Manager::Audit(BenchSession& s, char const* kind, std::string const& json)
    {
        std::lock_guard<std::mutex> lock(s.auditMutex);
        if (s.auditDay < 0)     // never opened: the session did not get as far as a WorldSession
            return;
        int64_t const ts = NowMs();
        // The first record after a UTC day boundary rolls to the day's file.
        // Only ever forward: a past date is never reopened, which is what lets
        // retention delete a past day's file whatever the server's start.
        if (int64_t const day = ts / 86400000; day > s.auditDay)
            OpenAudit(s, day);
        if (!s.audit.is_open())
            return;
        Json::Writer w;
        w.Add("ts", ts).Add("session", s.auditTag).Add("kind", kind);
        w.Raw("payload", json);
        s.audit << w.Str() << '\n';
        s.audit.flush();
    }

    // The least time between two reattach replays of one session: a request
    // inside it is deferred to the end of it and shares that burst with every
    // other request made meanwhile (TickReplays). Long enough that a consumer
    // flapping its subscribe costs the world thread one burst per interval
    // and short enough that a restarted sandbox child, whose connect() waits
    // a second for the state frame and five for the burst, is still served.
    static constexpr int64_t REPLAY_MIN_INTERVAL_MS = 3000;

    // ------------------------------------------------------- ws attach
    void Manager::OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn, bool replay)
    {
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            _wsByToken[token].push_back(conn);
        }

        // Reattach (io thread): a subscriber that connects after
        // SMSG_LOGIN_VERIFY_WORLD fired would otherwise never learn its own
        // position/map, so every such subscribe gets one synthetic
        // WB_SESSION_STATE (client-visible facts only: what LOGIN_VERIFY_WORLD
        // plus the session's own identity would carry). A subscribe that
        // asked for it (`replay=1`: a restarted sandbox child, a resumed run,
        // a consumer that holds nothing) gets the reattach replay instead —
        // the state frame marked `replay: true`, then what a connected client
        // holds (ReplayClientState) — on its own connection only, no sooner
        // than REPLAY_MIN_INTERVAL_MS after the session's last one, shared
        // with every other connection that asked in the meantime
        // (TickReplays). The replay is the heaviest thing a session's stream
        // can carry, so it is never sent unasked and never to a socket that
        // did not ask: a live SDK's automatic reconnect takes the plain frame,
        // and a consumer looping on subscribes gets one burst per interval.
        // Player state must be read on the world thread, so both paths are
        // asynchronous; each frame takes the next seq.
        auto s = FindByToken(token);
        if (!s || s->phase.load() != BenchSession::P_INWORLD || s->tearingDown.load())
            return;
        if (!replay)
        {
            PushTask([this, s]() { EmitSessionState(s, nullptr); });
            return;
        }
        std::lock_guard<std::mutex> lock(_sessMutex);
        s->replayWaiters.push_back(std::move(conn));
        if (s->replayDueMs == 0)
            s->replayDueMs = std::max(NowMs(), s->lastReplayMs + REPLAY_MIN_INTERVAL_MS);
    }

    void Manager::TickReplays(int64_t nowMs)
    {
        std::vector<std::pair<std::shared_ptr<BenchSession>, std::vector<std::shared_ptr<IWsConn>>>> due;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
            {
                if (s->replayDueMs == 0 || nowMs < s->replayDueMs)
                    continue;
                s->replayDueMs = 0;
                if (s->replayWaiters.empty())
                    continue;   // every asker hung up before its turn
                due.emplace_back(s, std::move(s->replayWaiters));
                s->replayWaiters.clear();
            }
        }
        for (auto& [s, conns] : due)
        {
            s->lastReplayMs = nowMs;
            EmitSessionState(s, &conns);
        }
    }

    // Emit one synthetic WB_SESSION_STATE carrying the session's own
    // client-visible state, and with `replayTo` the reattach replay after it,
    // to those connections alone. World thread only: reads the Player. The
    // guards mirror the reattach path — the session may tear down or lose the
    // core WorldSession between the caller's check and this run.
    void Manager::EmitSessionState(std::shared_ptr<BenchSession> const& s,
        std::vector<std::shared_ptr<IWsConn>> const* replayTo)
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
        // `replay: true` tells the consumer the login-shaped burst follows, so
        // it can drop what it held of the world before folding the burst.
        if (replayTo)
            w.Add("replay", true);
        // Route the state frame and everything the replay sends to the askers.
        s->replayTargets.store(replayTo);
        EmitEvent(*s, "WB_SESSION_STATE", 0xFF03, w.Str());
        if (replayTo)
            ReplayClientState(*s, player);
        s->replayTargets.store(nullptr);
        // A reattached client gets the portals in view again on the next
        // TickPortals, as it gets its position here.
        s->portalsKey.clear();
        s->lastPortalCheckMs = 0;
    }

    // The reattach replay. A real client keeps everything below for the life
    // of its connection, and a client that dials in again is handed all of it
    // by the login path; the bench client's connection is its WebSocket, so
    // a subscriber that asks on a character already in world is that client
    // dialling in again, and this is the same hand-over, built by the same
    // core functions the login uses and in the login's order
    // (WorldSession::HandlePlayerLoginFromDB): the senders of
    // Player::SendInitialPacketsBeforeAddToMap; then what Map::AddPlayerToMap
    // sends — Map::SendInitTransports, Map::SendInitSelf (with
    // Player::BuildCreateUpdateBlockForPlayer and GetAurasForTarget) and the
    // create builder plus Player::GetInitialVisiblePackets that
    // VisibleNotifier::SendToSelf runs for each object entering view; then
    // the pet bar, which the login sends once the pet is loaded.
    //
    // What is deliberately not re-run: the login path's side effects. No
    // LOGINEFFECT cast, no UpdateZone, no group update, no friend status, no
    // SetMover, no script hook, no time-sync reset — other players see
    // nothing, and the server's own state does not move. The visibility set
    // is read, never cleared and rebuilt: Player::UpdateVisibilityOf would
    // put every object through CanSeeOrDetect again and could destroy a pet
    // that failed it (BeforeVisibilityDestroy), so instead the create block
    // is built for each object the set already holds — which is exactly the
    // set a client has at this moment, and the server's later destroys and
    // creates apply to it unchanged. Packets whose opcode is not on the event
    // whitelist (the action bar, equipment sets, forced reactions, the social
    // list, world states, time speed) are not re-sent: the tap would drop
    // them, so they would only feed the drop census. This is the one place to
    // add them when one is whitelisted.
    //
    // Every packet goes through the session's own SendPacket and so through
    // the tap like any other: whitelisted ones become events, audited, routed
    // to the askers; nothing is written to the parked socket. The burst always
    // ends with WB_REPLAY_DONE, a builder's exception included — a consumer
    // waits on that frame, and the world thread must not carry the throw.
    void Manager::ReplayClientState(BenchSession& s, Player* player)
    {
        uint32 objects = 0;
        bool failed = false;
        try
        {
            Map* map = player->GetMap();
            if (!map)
                throw std::runtime_error("the player has no map");

            // The login packets that carry state no update field holds, in the
            // login's order (Player::SendInitialPacketsBeforeAddToMap): the bind
            // point, talents, the spellbook with its cooldowns, reputations,
            // achievements.
            {
                WorldPacket data(SMSG_BINDPOINTUPDATE, 5 * 4);
                data << player->m_homebindX << player->m_homebindY << player->m_homebindZ;
                data << (uint32)player->m_homebindMapId;
                data << (uint32)player->m_homebindAreaId;
                player->SendDirectMessage(&data);
            }
            player->SendTalentsInfoData(false);
            player->SendInitialSpells();
            player->GetReputationMgr().SendInitialReputations();
            player->GetAchievementMgr()->SendAllAchievementData();

            // What Map::AddPlayerToMap sends. The transports on the map: always
            // at a client, never in its visibility set
            // (ObjectVisibilityContainer::LinkWorldObjectVisibility skips them).
            // Then the character itself: its own transport, every item and bag
            // it carries, the self create block (UPDATEFLAG_SELF, every non-zero
            // update field: race, class, health, power, xp, money, the inventory
            // and bag slots, the quest log, skills, flags) and its own auras
            // (SMSG_AURA_UPDATE_ALL). A passenger of the character's own
            // transport is built here and again below, as at login.
            map->SendInitTransports(player);
            map->SendInitSelf(player);

            // Everything in view: one create block per object in the character's
            // visibility set, in one SMSG_UPDATE_OBJECT as a visibility pass
            // sends them, then each unit's auras and, if it is swinging at
            // something, its attack start — what VisibleNotifier::SendToSelf does
            // for the objects that just came into view, minus the pass itself.
            if (VisibleWorldObjectsMap const* visible = player->GetObjectVisibilityContainer().GetVisibleWorldObjectsMap())
            {
                UpdateData data;
                std::vector<Unit*> units;
                for (auto const& kv : *visible)
                {
                    WorldObject* obj = kv.second;
                    if (!obj || !obj->IsInWorld())
                        continue;
                    obj->BuildCreateUpdateBlockForPlayer(&data, player);
                    ++objects;
                    if (Unit* unit = obj->ToUnit())
                        units.push_back(unit);
                }
                if (data.HasData())
                {
                    WorldPacket packet;
                    data.BuildPacket(packet);
                    player->SendDirectMessage(&packet);
                }
                for (Unit* unit : units)
                    player->GetInitialVisiblePackets(unit);
            }

            // The pet bar, if a pet is out (a no-op otherwise).
            player->PetSpellInitialize();

            // Class resources no update field holds: the combo points and
            // their target (Unit::SendComboPoints, the core's own sender), and
            // a Death Knight's converted runes, which the login's aura
            // applications announced one SMSG_CONVERT_RUNE each
            // (Player::ConvertRune to the rune's current type changes
            // nothing and sends exactly that packet; the guard is
            // Player::InitRunes's own, the runes exist only then).
            player->SendComboPoints();
            if (player->IsClass(CLASS_DEATH_KNIGHT, CLASS_CONTEXT_ABILITY))
                for (uint8 i = 0; i < MAX_RUNES; ++i)
                    if (player->GetCurrentRune(i) != player->GetBaseRune(i))
                        player->ConvertRune(i, player->GetCurrentRune(i));

            // The proficiencies the login's passive spells announced, one
            // SMSG_SET_PROFICIENCY per item class with the whole mask, by
            // the core's own sender.
            player->SendProficiency(ITEM_CLASS_WEAPON, player->GetWeaponProficiency());
            player->SendProficiency(ITEM_CLASS_ARMOR, player->GetArmorProficiency());
        }
        catch (std::exception const& e)
        {
            failed = true;
            LOG_ERROR("module", "wrathbench: reattach replay for {} stopped after {} objects: {}", TokenTag(s.token), objects, e.what());
        }

        Json::Writer w;
        w.Add("objects", objects);
        if (failed)
            w.Add("incomplete", true);
        EmitEvent(s, "WB_REPLAY_DONE", 0xFF0B, w.Str());
        Audit(s, "action", Json::Writer().Add("op", "reattach_replay").Add("objects", objects).Add("incomplete", failed).Str());
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
        // A replay it asked for and hung up before is not owed.
        if (auto s = _byToken.find(token); s != _byToken.end())
        {
            auto& waiters = s->second->replayWaiters;
            waiters.erase(std::remove_if(waiters.begin(), waiters.end(),
                [conn](std::shared_ptr<IWsConn> const& c) { return c.get() == conn; }), waiters.end());
        }
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
        GuidHalves target, summonedBy, createdBy, charmedBy, corpseOwner, channelObject;
    };

    // An item's random property (ITEM_FIELD_RANDOM_PROPERTIES_ID, PUBLIC):
    // positive is an ItemRandomProperties.dbc row, negative the negated
    // ItemRandomSuffix.dbc row. The client reads the name suffix ("of the
    // Bear") off that row and, for a suffix, the per-slot allocation it
    // scales the stat amounts by (allocation x ITEM_FIELD_PROPERTY_SEED /
    // 10000 — the SDK's arithmetic, on fields the wire carried). Served
    // beside the id the way skill<n>Name rides beside a skill id; the
    // core's stores are the client's own files. A suffix always serves all
    // five allocations so a re-rolled id overwrites every earlier one.
    static void AppendRandomProperty(Json::Writer& f, int32 id)
    {
        f.Add("randomPropertyId", id);
        if (id > 0)
        {
            if (ItemRandomPropertiesEntry const* r = sItemRandomPropertiesStore.LookupEntry(uint32(id)))
                if (r->Name[0] && *r->Name[0])
                    f.Add("suffixName", r->Name[0]);
        }
        else if (id < 0)
        {
            if (ItemRandomSuffixEntry const* r = sItemRandomSuffixStore.LookupEntry(uint32(-id)))
            {
                if (r->Name[0] && *r->Name[0])
                    f.Add("suffixName", r->Name[0]);
                for (size_t k = 0; k < r->AllocationPct.size(); ++k)
                    f.Add("suffixAlloc" + std::to_string(k), r->AllocationPct[k]);
            }
        }
    }

    // One enchantment slot's SpellItemEnchantment.dbc row beside its id: the
    // three effects (type, amount, arg — a stat id for type 5, a spell id
    // for 1/3/7, a school for 4) and the enUS text the client draws the
    // green line from (`$i` in it is the amount). All three effects are
    // served, zeros included, so a changed id overwrites every earlier one.
    static void AppendEnchantment(Json::Writer& f, std::string const& key, uint32 id)
    {
        SpellItemEnchantmentEntry const* e = sSpellItemEnchantmentStore.LookupEntry(id);
        if (!e)
            return;
        for (uint32 i = 0; i < MAX_SPELL_ITEM_ENCHANTMENT_EFFECTS; ++i)
        {
            std::string ek = key + "Effect" + std::to_string(i);
            f.Add(ek + "Type", e->type[i]).Add(ek + "Amount", e->amount[i]).Add(ek + "Arg", e->spellid[i]);
        }
        if (e->description[0] && *e->description[0])
            f.Add(key + "Text", e->description[0]);
    }

    // A unit's faction template (UNIT_FIELD_FACTIONTEMPLATE, PUBLIC) is a
    // FactionTemplate.dbc row the client reads to colour the unit hostile,
    // neutral or friendly: its Faction.dbc faction, flags, the faction-group
    // masks (its own, those it befriends, those it fights), the explicit
    // enemy and friend factions, and whether that faction keeps a reputation
    // (Faction.dbc reputationListID, -1 when not) with, for one that does,
    // the faction's race/class base reputation table (the client's own
    // Faction.dbc base for a faction the reputation list does not carry).
    // Served beside the id the
    // way a skill's name rides beside its id; the SDK does the client's
    // arithmetic with the character's own reputation. `factionRow` names the
    // template the row describes, so a template with no row never leaves an
    // earlier template's row standing for it. Every field is served, zeros
    // included, so a changed template overwrites every earlier one.
    static void AppendFactionTemplate(Json::Writer& f, uint32 id)
    {
        FactionTemplateEntry const* t = sFactionTemplateStore.LookupEntry(id);
        if (!t)
            return;
        FactionEntry const* fe = sFactionStore.LookupEntry(t->faction);
        f.Add("factionRow", id).Add("factionRowFaction", t->faction).Add("factionRowFlags", t->factionFlags)
         .Add("factionRowGroup", t->ourMask).Add("factionRowFriendGroup", t->friendlyMask)
         .Add("factionRowEnemyGroup", t->hostileMask)
         .Add("factionRowRepIndex", fe ? fe->reputationListID : -1);
        for (uint32 i = 0; i < MAX_FACTION_RELATIONS; ++i)
            f.Add("factionRowEnemy" + std::to_string(i), t->enemyFaction[i])
             .Add("factionRowFriend" + std::to_string(i), t->friendFaction[i]);
        if (fe && fe->CanHaveReputation())
            for (uint32 i = 0; i < 4; ++i)
                f.Add("factionRowBaseRace" + std::to_string(i), fe->BaseRepRaceMask[i])
                 .Add("factionRowBaseClass" + std::to_string(i), fe->BaseRepClassMask[i])
                 .Add("factionRowBaseRep" + std::to_string(i), fe->BaseRepValue[i]);
    }

    // An update field the core keeps as a float, read from its u32 bits.
    static double FloatOf(uint32 v)
    {
        float fv; std::memcpy(&fv, &v, 4);
        return (double)fv;
    }

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
            // A channel in progress (PUBLIC, Spell::SendChannelStart sets
            // both and SendChannelUpdate(0) clears them): what the unit
            // channels at, and the spell; 0 when not channelling.
            if (index == UNIT_FIELD_CHANNEL_OBJECT)     { g.channelObject.lo = v; g.channelObject.hasLo = true; return true; }
            if (index == UNIT_FIELD_CHANNEL_OBJECT + 1) { g.channelObject.hi = v; g.channelObject.hasHi = true; return true; }
            if (index == UNIT_CHANNEL_SPELL)            { f.Add("channelSpell", v); return true; }
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
                case UNIT_FIELD_FACTIONTEMPLATE: f.Add("faction", v); AppendFactionTemplate(f, v); return true;
                case UNIT_FIELD_FLAGS:
                    // taxiFlight names UNIT_FLAG_TAXI_FLIGHT (0x00100000) off
                    // the same field: the client's own "on a flight path"
                    // reading, nothing the server adds (issue #8).
                    f.Add("unitFlags", v).Add("taxiFlight", (v & UNIT_FLAG_TAXI_FLIGHT) != 0); return true;
                case UNIT_FIELD_DISPLAYID:       f.Add("displayId", v); return true;
                // Stand state, byte 0 of UNIT_FIELD_BYTES_1 (PUBLIC;
                // UnitStandStateType: 0 stand, 1 sit, 3 sleep, 7 dead, 8
                // kneel, ...), and shapeshift form, byte 3 of
                // UNIT_FIELD_BYTES_2 (PUBLIC; ShapeshiftForm, 0 none): unpacked
                // like UNIT_FIELD_BYTES_0, the rest of both words dropped.
                case UNIT_FIELD_BYTES_1:         f.Add("standState", v & 0xFF); return true;
                case UNIT_FIELD_BYTES_2:         f.Add("shapeshiftForm", (v >> 24) & 0xFF); return true;
                // The character sheet's numbers, PRIVATE/OWNER (so a
                // character's own, and its pet's): attack power as the core
                // keeps it, base, signed mods and the float multiplier
                // (Unit::GetTotalAttackPowerValue: (base + mods) x (1 + mult)).
                case UNIT_FIELD_ATTACK_POWER:                   f.Add("attackPower", v); return true;
                case UNIT_FIELD_ATTACK_POWER_MODS:              f.Add("attackPowerMods", (int32)v); return true;
                case UNIT_FIELD_ATTACK_POWER_MULTIPLIER:        f.Add("attackPowerMultiplier", FloatOf(v)); return true;
                case UNIT_FIELD_RANGED_ATTACK_POWER:            f.Add("rangedAttackPower", v); return true;
                case UNIT_FIELD_RANGED_ATTACK_POWER_MODS:       f.Add("rangedAttackPowerMods", (int32)v); return true;
                case UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER: f.Add("rangedAttackPowerMultiplier", FloatOf(v)); return true;
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
            // Strength, agility, stamina, intellect, spirit (UNIT_FIELD_STAT0
            // + n, PRIVATE/OWNER; the totals with buffs, as the sheet shows
            // them), and armour then the six school resistances
            // (UNIT_FIELD_RESISTANCES + n, n 0 armour, 1 holy .. 6 arcane).
            if (index >= UNIT_FIELD_STAT0 && index < UNIT_FIELD_STAT0 + MAX_STATS)
            {
                f.Add("stat" + std::to_string(index - UNIT_FIELD_STAT0), (int32)v);
                return true;
            }
            if (index >= UNIT_FIELD_RESISTANCES && index < UNIT_FIELD_RESISTANCES + MAX_SPELL_SCHOOL)
            {
                f.Add("resistance" + std::to_string(index - UNIT_FIELD_RESISTANCES), (int32)v);
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
                // The ammo a ranged weapon fires (PLAYER_AMMO_ID, PRIVATE):
                // an item id, 0 when none is set; CMSG_SET_AMMO changes it.
                if (index == PLAYER_AMMO_ID) { f.Add("ammoId", v); return true; }
                // The spell a dead character may resurrect itself with
                // (PLAYER_SELF_RES_SPELL, PRIVATE: a Soulstone, Reincarnation),
                // what CMSG_SELF_RES casts; 0 when there is none.
                if (index == PLAYER_SELF_RES_SPELL) { f.Add("selfResSpell", v); return true; }
                // The character sheet's percentages (PRIVATE floats): block,
                // dodge, parry, melee and ranged crit, and spell crit per
                // school (PLAYER_SPELL_CRIT_PERCENTAGE1 + n, n 0 physical ..
                // 6 arcane).
                if (index == PLAYER_BLOCK_PERCENTAGE)       { f.Add("blockPct", FloatOf(v)); return true; }
                if (index == PLAYER_DODGE_PERCENTAGE)       { f.Add("dodgePct", FloatOf(v)); return true; }
                if (index == PLAYER_PARRY_PERCENTAGE)       { f.Add("parryPct", FloatOf(v)); return true; }
                if (index == PLAYER_CRIT_PERCENTAGE)        { f.Add("critPct", FloatOf(v)); return true; }
                if (index == PLAYER_RANGED_CRIT_PERCENTAGE) { f.Add("rangedCritPct", FloatOf(v)); return true; }
                if (index >= PLAYER_SPELL_CRIT_PERCENTAGE1 && index < PLAYER_SPELL_CRIT_PERCENTAGE1 + MAX_SPELL_SCHOOL)
                {
                    f.Add("spellCritPct" + std::to_string(index - PLAYER_SPELL_CRIT_PERCENTAGE1), FloatOf(v));
                    return true;
                }
                // Rested XP (PLAYER_REST_STATE_EXPERIENCE, PRIVATE): the
                // bonus pool the XP bar shades.
                if (index == PLAYER_REST_STATE_EXPERIENCE) { f.Add("restedXp", v); return true; }
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
                // Equipment/bag/backpack/bank/buyback/keyring/currency item
                // guids as lo/hi u32 halves keyed by inventory slot (0-22
                // equipment+bags, 23-38 backpack, 39-66 bank, 67-73 bank bags,
                // 74-85 vendor buyback, 86-117 keyring, 118-149 currency
                // tokens — the core's slot numbering, the fields are
                // contiguous). Halves stay u32 JSON numbers; the SDK joins
                // them into guids. The buyback slots are the vendor's buyback
                // tab, and the slot number is what CMSG_BUYBACK_ITEM names.
                if (index >= PLAYER_FIELD_INV_SLOT_HEAD && index < PLAYER_FIELD_CURRENCYTOKEN_SLOT_1 + 64)
                {
                    uint32 rel = index - PLAYER_FIELD_INV_SLOT_HEAD;
                    f.Add("invSlot" + std::to_string(rel / 2) + (rel % 2 ? "Hi" : "Lo"), v);
                    return true;
                }
                // What buying each buyback slot back costs, in copper
                // (PLAYER_FIELD_BUYBACK_PRICE_1, PRIVATE): the price the
                // buyback tab shows beside the item. n 0-11 is slot 74 + n.
                if (index >= PLAYER_FIELD_BUYBACK_PRICE_1 && index < PLAYER_FIELD_BUYBACK_PRICE_1 + 12)
                {
                    f.Add("buybackPrice" + std::to_string(index - PLAYER_FIELD_BUYBACK_PRICE_1), v);
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
            // The random property and its enchantments, PUBLIC fields every
            // client in range receives: the signed property id (with the
            // suffix name and allocations beside it), the suffix factor the
            // core keeps in PROPERTY_SEED, and the twelve enchantment slots
            // as id / duration / charges — a random property's enchants sit
            // in slots 7-11, a permanent enchant in 0, a temporary one in 1,
            // gems in 2-4. Raw per field, the quest-log idiom.
            if (index == ITEM_FIELD_RANDOM_PROPERTIES_ID) { AppendRandomProperty(f, (int32)v); return true; }
            if (index == ITEM_FIELD_PROPERTY_SEED)        { f.Add("propertySeed", v); return true; }
            if (index >= ITEM_FIELD_ENCHANTMENT_1_1 && index < ITEM_FIELD_ENCHANTMENT_1_1 + 3 * MAX_ENCHANTMENT_SLOT)
            {
                uint32 rel = index - ITEM_FIELD_ENCHANTMENT_1_1;
                std::string key = "enchant" + std::to_string(rel / 3);
                switch (rel % 3)
                {
                    case 0:
                        f.Add(key + "Id", v);
                        if (v)
                            AppendEnchantment(f, key, v);
                        return true;
                    case 1:  f.Add(key + "Duration", v); return true;
                    default: f.Add(key + "Charges", v); return true;
                }
            }
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
        else if (typeId == TYPEID_CORPSE)
        {
            // Whose corpse this is (CORPSE_FIELD_OWNER, PUBLIC; bones keep
            // it too, Map::ConvertCorpseToBones): the guid a client
            // name-queries to label "<name>'s corpse".
            if (index == CORPSE_FIELD_OWNER)     { g.corpseOwner.lo = v; g.corpseOwner.hasLo = true; return true; }
            if (index == CORPSE_FIELD_OWNER + 1) { g.corpseOwner.hi = v; g.corpseOwner.hasHi = true; return true; }
            // CORPSE_FIELD_FLAGS (PUBLIC), raw: CORPSE_FLAG_BONES is what a
            // client reads to draw bones rather than a body. Bones are a new
            // object under the corpse's guid, created after the corpse's
            // destroy with the flag set (Map::ConvertCorpseToBones).
            if (index == CORPSE_FIELD_FLAGS) { f.Add("corpseFlags", v); return true; }
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

    static std::string DecodeValuesBlock(WorldPacket& p, uint8 typeId, uint32* entryOut, uint32* petNumberOut = nullptr,
        uint64_t* corpseOwnerOut = nullptr)
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
        AddPendingGuid(f, "corpseOwnerGuid", g.corpseOwner);
        AddPendingGuid(f, "channelObjectGuid", g.channelObject);
        if (corpseOwnerOut && (g.corpseOwner.hasLo || g.corpseOwner.hasHi))
            *corpseOwnerOut = uint64_t(g.corpseOwner.lo) | (uint64_t(g.corpseOwner.hi) << 32);
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
                        uint64_t corpseOwner = 0;
                        std::string fields = DecodeValuesBlock(p, typeId, &entry, &petNumber, &corpseOwner);
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
                            // A corpse's owner may never have been in view
                            // (released and gone before we arrived): the
                            // client asks its name off the corpse, as here.
                            if (typeId == TYPEID_CORPSE && corpseOwner && s.queriedNames.insert(corpseOwner).second)
                                nameQueries.push_back(corpseOwner);
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
            // The name a client's buff frame shows for the id: client-cache
            // (Spell.dbc) knowledge, as on the spellbook rows (AddSpellFields).
            if (SpellInfo const* info = sSpellMgr->GetSpellInfo(spellId))
                if (info->SpellName[0])
                    a.Add("name", info->SpellName[0]);
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

    // The forms a Spell.dbc shapeshift mask names: bit n-1 is form n
    // (SpellInfo::CheckShapeshift reads it the same way).
    static std::string FormListJson(uint32 mask)
    {
        std::string out = "[";
        for (uint32 form = 1; form <= 32; ++form)
            if (mask & (1u << (form - 1)))
            {
                if (out.size() > 1) out += ',';
                out += std::to_string(form);
            }
        return out + "]";
    }

    // A spellbook row's stance facts, as the client's own Spell.dbc has them:
    // the forms the spell may be cast in (`stances`) and may not
    // (`stancesNot`), and the form a form-changing spell puts the caster in
    // (`form`, its SPELL_AURA_MOD_SHAPESHIFT misc value), so a refusal can
    // name the stance from the book. Read from the DBC store, not SpellInfo,
    // which the server corrects for itself (SpellInfoCorrections). Each is
    // omitted when the DBC says nothing. Spellbook rows only: AddSpellFields
    // rides on every aura and cast event, which have no use for it.
    static void AddSpellbookFields(Json::Writer& w, uint32 spellId)
    {
        AddSpellFields(w, spellId);
        SpellEntry const* e = sSpellStore.LookupEntry(spellId);
        if (!e)
            return;
        if (e->Stances)
            w.Raw("stances", FormListJson(e->Stances));
        if (e->StancesNot)
            w.Raw("stancesNot", FormListJson(e->StancesNot));
        for (uint8 i = 0; i < MAX_SPELL_EFFECTS; ++i)
            if (e->Effect[i] == SPELL_EFFECT_APPLY_AURA && e->EffectApplyAuraName[i] == SPELL_AURA_MOD_SHAPESHIFT
                && e->EffectMiscValue[i] > 0)
            {
                w.Add("form", (uint32)e->EffectMiscValue[i]);
                break;
            }
    }

    static std::string SpellJson(uint32 spellId)
    {
        Json::Writer w;
        w.Add("spellId", spellId);
        AddSpellbookFields(w, spellId);
        return w.Str();
    }

    // =================================================================
    // Whitelisted SMSG decoders. Field layouts mirror the server-side
    // builders in AzerothCore at the pinned commit; see module/PROTOCOL.md.
    // =================================================================
    // The body of SMSG_MONSTER_MOVE after the unit's packGUID (and, on
    // SMSG_MONSTER_MOVE_TRANSPORT, after the transport's packGUID and the
    // seat), as PacketBuilder::WriteCommonMonsterMovePart and WriteMonsterMove
    // lay it out: u8 toggle, the start point, u32 spline id, u8 type (1 is a
    // stop, nothing follows), the facing the type names, u32 spline flags,
    // the animation when flagged, u32 duration, the parabolic pair when
    // flagged, then the points. Destination and duration only: the path
    // points are consumed and dropped. `transportExit` names the flag the
    // exit spline carries (MoveSplineFlag::TransportExit, Unit::_ExitVehicle):
    // on the character's own guid, how a client learns it is off its seat.
    static void DecodeMonsterMoveBody(WorldPacket& p, Json::Writer& w)
    {
        uint8 toggle; p >> toggle;
        float sx, sy, sz; p >> sx >> sy >> sz;
        uint32 splineId; p >> splineId;
        uint8 type; p >> type;
        w.Raw("pos", Json::Writer().Add("x", (double)sx).Add("y", (double)sy).Add("z", (double)sz).Str());
        if (type == 1)                          // MonsterMoveStop
        {
            w.Add("stopped", true);
            return;
        }
        switch (type)
        {
            case 2: { float fx, fy, fz; p >> fx >> fy >> fz; break; } // facing spot
            case 3: { uint64 t; p >> t; break; }                     // facing target
            case 4: { float a; p >> a; break; }                      // facing angle
            default: break;
        }
        uint32 splineFlags; p >> splineFlags;
        if (splineFlags & 0x01000000)           // MoveSplineFlag::TransportExit
            w.Add("transportExit", true);
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
    }

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
                // A whisper (or other chat to a named player) found nobody by
                // that name online (WorldSession::SendPlayerNotFoundNotice):
                // the name as the sender wrote it, a cstring. The client shows
                // "No player named '<name>' is currently playing."
                case SMSG_CHAT_PLAYER_NOT_FOUND:
                {
                    name = "SMSG_CHAT_PLAYER_NOT_FOUND";
                    std::string who; p >> who;
                    w.Add("name", who);
                    break;
                }
                // A unit's one-shot emote, to everyone in range
                // (Unit::HandleEmoteCommand, Unit.cpp, and
                // WorldPackets::Chat::Emote::Write, ChatPackets.cpp): u32
                // emote id, the emoting unit's raw u64 guid. Creatures and
                // players alike.
                case SMSG_EMOTE:
                {
                    name = "SMSG_EMOTE";
                    uint32 emoteId; uint64 guid; p >> emoteId >> guid;
                    w.AddGuid("guid", (uint64_t)guid).Add("emoteId", emoteId);
                    break;
                }
                // A player's text emote ("/wave", "/bow") to every player in
                // listen range, the emoter included (Acore::EmoteChatBuilder,
                // ChatHandler.cpp): the emoter's raw u64 guid, u32 text emote
                // id (an EmotesText.dbc row), u32 emote number (as the client
                // sent it), u32 target-name length, then the target's name as
                // a cstring, or a single 0 byte when there is none (a
                // one-character name is also written as none).
                case SMSG_TEXT_EMOTE:
                {
                    name = "SMSG_TEXT_EMOTE";
                    uint64 guid; uint32 textEmote, emoteNum, nameLen;
                    p >> guid >> textEmote >> emoteNum >> nameLen;
                    std::string target; p >> target;
                    w.AddGuid("guid", (uint64_t)guid).Add("textEmote", textEmote)
                     .Add("emoteNum", emoteNum).Add("targetName", target);
                    break;
                }
                // A channel notice (Channel::MakeNotifyPacket and its Make*
                // callers, Channel.cpp; ChannelMgr::MakeNotOnPacket): u8
                // ChatNotify type, the channel's name as a cstring, then a
                // tail that depends on the type, served by its shape: `guid`
                // (joined, left, password or owner changed, announcements,
                // moderation, already a member, invite, voice), `guid` and
                // `byGuid` (kicked, banned, unbanned: the target, then who
                // did it), `playerName` (not found, owner, not banned,
                // invited, invite banned), a join's `flags` and `channelId`,
                // a leave's `channelId` and `constant`, and a mode change's
                // `guid`, `oldFlags` and `flags`.
                case SMSG_CHANNEL_NOTIFY:
                {
                    name = "SMSG_CHANNEL_NOTIFY";
                    uint8 type; std::string channel; p >> type >> channel;
                    w.Add("type", (uint32)type).Add("channel", channel);
                    auto guidAt = [&](char const* key) {
                        uint64 g; p >> g; w.AddGuid(key, (uint64_t)g);
                    };
                    switch (type)
                    {
                        case 0x02: // CHAT_YOU_JOINED_NOTICE: u8 flags, u32 channel id, u32 0
                        {
                            uint8 flags; uint32 channelId; p >> flags >> channelId;
                            w.Add("flags", (uint32)flags).Add("channelId", channelId);
                            break;
                        }
                        case 0x03: // CHAT_YOU_LEFT_NOTICE: u32 channel id, u8 constant
                        {
                            uint32 channelId; uint8 constant; p >> channelId >> constant;
                            w.Add("channelId", channelId).Add("constant", constant != 0);
                            break;
                        }
                        case 0x0C: // CHAT_MODE_CHANGE_NOTICE: guid, u8 old flags, u8 new flags
                        {
                            guidAt("guid");
                            uint8 oldFlags, flags; p >> oldFlags >> flags;
                            w.Add("oldFlags", (uint32)oldFlags).Add("flags", (uint32)flags);
                            break;
                        }
                        case 0x00: case 0x01: case 0x07: case 0x08: case 0x0D: case 0x0E:
                        case 0x0F: case 0x10: case 0x17: case 0x18: case 0x22: case 0x23:
                            guidAt("guid");
                            break;
                        case 0x12: case 0x14: case 0x15: // kicked, banned, unbanned
                            guidAt("guid");
                            guidAt("byGuid");
                            break;
                        case 0x09: case 0x0B: case 0x16: case 0x1D: case 0x1E:
                        {
                            std::string playerName; p >> playerName;
                            w.Add("playerName", playerName);
                            break;
                        }
                        default: break; // no tail
                    }
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
                    // Layout per chat type, exactly as ChatHandler::BuildChatPacket
                    // writes it (deps/azerothcore src/server/game/Chat/Chat.cpp
                    // 273-351): the header (type, language, sender, flags) is
                    // shared; what sits between it and the length-prefixed
                    // message depends on the type. Creature speech carries the
                    // speaker's name (a creature has no name-query path), a
                    // channel line its channel name, and the achievement
                    // broadcast trails an achievement id after the chat tag.
                    // Reading every type with the player layout put the parse
                    // inside the name bytes for creature types, so the message
                    // came out empty and the chat tag was a letter of the name.
                    uint8 type = 0; int32 lang = 0; uint64 sender = 0; uint32 flags = 0;
                    p >> type >> lang >> sender >> flags;
                    // A length-prefixed string: u32 (length including the NUL),
                    // then the C string. Empty when the packet is shorter.
                    auto readLenStr = [&](std::string& out) {
                        uint32 len = 0;
                        if (p.rpos() + 4 > p.size()) return;
                        p >> len;
                        if (len == 0 || p.rpos() + len > p.size()) return;
                        out.assign((char const*)p.contents() + p.rpos(), len);
                        if (!out.empty() && out.back() == '\0') out.pop_back();
                        p.rpos(p.rpos() + len);
                    };
                    bool hasSenderName = false, hasChannel = false;
                    std::string senderName, receiverName, channelName;
                    uint64 receiver = 0;
                    switch (type)
                    {
                        case CHAT_MSG_MONSTER_SAY: case CHAT_MSG_MONSTER_PARTY: case CHAT_MSG_MONSTER_YELL:
                        case CHAT_MSG_MONSTER_WHISPER: case CHAT_MSG_MONSTER_EMOTE:
                        case CHAT_MSG_RAID_BOSS_EMOTE: case CHAT_MSG_RAID_BOSS_WHISPER: case CHAT_MSG_BATTLENET:
                        {
                            hasSenderName = true;
                            readLenStr(senderName);
                            if (p.rpos() + 8 <= p.size()) p >> receiver;
                            ObjectGuid rg(receiver);
                            if (receiver && !rg.IsPlayer() && !rg.IsPet())
                                readLenStr(receiverName);
                            break;
                        }
                        case CHAT_MSG_WHISPER_FOREIGN:
                            hasSenderName = true;
                            readLenStr(senderName);
                            if (p.rpos() + 8 <= p.size()) p >> receiver;
                            break;
                        case CHAT_MSG_BG_SYSTEM_NEUTRAL: case CHAT_MSG_BG_SYSTEM_ALLIANCE: case CHAT_MSG_BG_SYSTEM_HORDE:
                        {
                            if (p.rpos() + 8 <= p.size()) p >> receiver;
                            if (receiver && !ObjectGuid(receiver).IsPlayer())
                                readLenStr(receiverName);
                            break;
                        }
                        case CHAT_MSG_ACHIEVEMENT: case CHAT_MSG_GUILD_ACHIEVEMENT:
                            if (p.rpos() + 8 <= p.size()) p >> receiver;
                            break;
                        default:
                            // (The GM-flagged sender-name prefix rides
                            // SMSG_GM_MESSAGECHAT, a different opcode, never this one.)
                            if (type == CHAT_MSG_CHANNEL)
                            {
                                hasChannel = true;
                                p >> channelName; // plain C string, no length prefix
                            }
                            if (p.rpos() + 8 <= p.size()) p >> receiver;
                            break;
                    }
                    std::string msg;
                    readLenStr(msg);
                    uint8 chatTag = 0; if (p.rpos() < p.size()) p >> chatTag;
                    uint32 achievementId = 0;
                    if ((type == CHAT_MSG_ACHIEVEMENT || type == CHAT_MSG_GUILD_ACHIEVEMENT) && p.rpos() + 4 <= p.size())
                        p >> achievementId;
                    w.Add("type", (uint32)type).Add("language", lang).AddGuid("senderGuid", (uint64_t)sender);
                    if (hasSenderName)
                        w.Add("senderName", senderName);
                    if (receiver)
                        w.AddGuid("receiverGuid", (uint64_t)receiver);
                    if (!receiverName.empty())
                        w.Add("receiverName", receiverName);
                    if (hasChannel)
                        w.Add("channelName", channelName);
                    w.Add("message", msg).Add("chatTag", (uint32)chatTag);
                    if (achievementId)
                        w.Add("achievementId", achievementId);
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
                // The two melee swing errors a client shows on screen. Both are
                // bodiless (Player::SendAttackSwingNotInRange /
                // SendAttackSwingBadFacingAttack), so the event is the fact and
                // nothing else: no victim, no distance. The core latches them
                // (Player::Update, m_swingErrorMsg): one packet per change of
                // error state and none when the state clears, so this tap is
                // exactly as sparse as the wire. SMSG_ATTACKSWING_DEADTARGET and
                // SMSG_ATTACKSWING_CANT_ATTACK have no caller at the pinned
                // commit and are left to the drop census until one does.
                case SMSG_ATTACKSWING_NOTINRANGE:
                    name = "SMSG_ATTACKSWING_NOTINRANGE";
                    break;
                case SMSG_ATTACKSWING_BADFACING:
                    name = "SMSG_ATTACKSWING_BADFACING";
                    break;
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
                    // A Death Knight's rune list (CAST_FLAG_RUNE_LIST 0x00200000,
                    // Spell::SendSpellGo), the only packet that tells a client
                    // which runes a cast spent: past the cast targets
                    // (SpellCastTargets::Write) and the power left
                    // (CAST_FLAG_POWER_LEFT_SELF 0x800), u8 ready-rune mask
                    // before the cast, u8 after, then for each rune spent (set
                    // before, clear after) u8 cooldown passed, 0-255 of its
                    // base. The core writes the list for a player caster only,
                    // so only a player's is read, and in a try of its own so a
                    // surprise here costs the runes and nothing else.
                    if ((castFlags & 0x00200000) && ObjectGuid(caster).IsPlayer())
                    {
                        try
                        {
                            uint32 tmask; p >> tmask;
                            uint64 skip = 0;
                            // unit | corpse_ally | gameobject | corpse_enemy | minipet
                            if (tmask & (0x0002 | 0x0200 | 0x0800 | 0x8000 | 0x00010000)) p.readPackGUID(skip);
                            if (tmask & (0x0010 | 0x1000)) p.readPackGUID(skip);   // item | trade item
                            if (tmask & 0x0020) { p.readPackGUID(skip); float a, b, c; p >> a >> b >> c; } // source
                            if (tmask & 0x0040) { p.readPackGUID(skip); float a, b, c; p >> a >> b >> c; } // dest
                            if (tmask & 0x2000) { std::string str; p >> str; }    // string
                            if (castFlags & 0x00000800) { uint32 powerLeft; p >> powerLeft; }
                            uint8 before, after; p >> before >> after;
                            std::string spent = "[";
                            bool firstRune = true;
                            for (uint8 i = 0; i < 6; ++i)
                            {
                                uint8 bit = uint8(1u << i);
                                if (!(before & bit) || (after & bit))
                                    continue;
                                uint8 passed; p >> passed;
                                if (!firstRune) spent += ',';
                                spent += Json::Writer().Add("index", (uint32)i).Add("passed", (uint32)passed).Str();
                                firstRune = false;
                            }
                            spent += "]";
                            w.Add("runesBefore", (uint32)before).Add("runesAfter", (uint32)after).Raw("runesSpent", spent);
                        }
                        catch (std::exception const&) { }
                    }
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
                // A cast pushed back by damage (Spell::Delayed, to every
                // client in range): caster packGUID, u32 ms added to the
                // cast. The client's cast bar moves back by it.
                case SMSG_SPELL_DELAYED:
                {
                    name = "SMSG_SPELL_DELAYED";
                    uint64 caster = 0; p.readPackGUID(caster);
                    uint32 delayMs; p >> delayMs;
                    w.AddGuid("casterGuid", (uint64_t)caster).Add("delayMs", delayMs);
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
                // The combat log's direct spell lines: what a client prints as
                // "X's Fireball hits you for 54 Fire damage". All three are
                // sent to every client in range (SendMessageToSet), the
                // reflect form of the damage log to the reflector alone.
                case SMSG_SPELLNONMELEEDAMAGELOG:
                {
                    // Unit::SendSpellNonMeleeDamageLog / SendSpellNonMeleeReflectLog:
                    // target packGUID, caster packGUID, u32 spell, u32 damage,
                    // u32 overkill, u8 school mask, u32 absorb, u32 resist,
                    // u8 physicalLog, u8 unused, u32 blocked, u32 hitInfo
                    // (SpellHitType), u8 debug flag. The debug rolls the flag
                    // would introduce are commented out in the builder at the
                    // pinned commit, so the flag is the last byte read.
                    name = "SMSG_SPELLNONMELEEDAMAGELOG";
                    uint64 target = 0, caster = 0;
                    p.readPackGUID(target);
                    p.readPackGUID(caster);
                    uint32 spellId, damage, overkill; p >> spellId >> damage >> overkill;
                    uint8 schoolMask; p >> schoolMask;
                    uint32 absorb, resist; p >> absorb >> resist;
                    uint8 physicalLog, unused; p >> physicalLog >> unused;
                    uint32 blocked, hitInfo; p >> blocked >> hitInfo;
                    uint8 debug; p >> debug;
                    w.AddGuid("targetGuid", (uint64_t)target).AddGuid("casterGuid", (uint64_t)caster)
                     .Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    w.Add("damage", damage).Add("overkill", overkill).Add("schoolMask", (uint32)schoolMask)
                     .Add("absorb", absorb).Add("resist", resist).Add("blocked", blocked)
                     .Add("hitInfo", hitInfo).Add("crit", (hitInfo & SPELL_HIT_TYPE_CRIT) != 0);
                    break;
                }
                case SMSG_SPELLHEALLOG:
                {
                    // Unit::SendHealSpellLog: target packGUID, healer packGUID,
                    // u32 spell, u32 heal, u32 overheal, u32 absorb, u8 crit,
                    // u8 unused.
                    name = "SMSG_SPELLHEALLOG";
                    uint64 target = 0, caster = 0;
                    p.readPackGUID(target);
                    p.readPackGUID(caster);
                    uint32 spellId, amount, overheal, absorb; p >> spellId >> amount >> overheal >> absorb;
                    uint8 crit, unused; p >> crit >> unused;
                    w.AddGuid("targetGuid", (uint64_t)target).AddGuid("casterGuid", (uint64_t)caster)
                     .Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    w.Add("amount", amount).Add("overheal", overheal).Add("absorb", absorb).Add("crit", crit != 0);
                    break;
                }
                case SMSG_SPELLENERGIZELOG:
                {
                    // Unit::SendEnergizeSpellLog: target packGUID, caster
                    // packGUID, u32 spell, u32 power type, u32 amount.
                    name = "SMSG_SPELLENERGIZELOG";
                    uint64 target = 0, caster = 0;
                    p.readPackGUID(target);
                    p.readPackGUID(caster);
                    uint32 spellId, powerType, amount; p >> spellId >> powerType >> amount;
                    w.AddGuid("targetGuid", (uint64_t)target).AddGuid("casterGuid", (uint64_t)caster)
                     .Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    w.Add("powerType", powerType).Add("amount", amount);
                    break;
                }
                // "Immune" in the combat log (Unit::SendSpellDamageImmune,
                // to every client in range): u64 caster, u64 target (both
                // unpacked), u32 spell, u8 debug-format flag.
                case SMSG_SPELLORDAMAGE_IMMUNE:
                {
                    name = "SMSG_SPELLORDAMAGE_IMMUNE";
                    uint64 caster, target; uint32 spellId; uint8 debug;
                    p >> caster >> target >> spellId >> debug;
                    w.AddGuid("casterGuid", (uint64_t)caster).AddGuid("targetGuid", (uint64_t)target)
                     .Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    break;
                }
                // Falling, drowning, fatigue, lava, slime and fire damage
                // (Player::EnvironmentalDamage, CombatLogPackets.cpp; to every
                // client in range): u64 victim, u8 EnviromentalDamage (0
                // exhausted, 1 drowning, 2 fall, 3 lava, 4 slime, 5 fire; a
                // fall into the void is sent as 2), u32 amount, u32 resisted,
                // u32 absorbed.
                case SMSG_ENVIRONMENTAL_DAMAGE_LOG:
                {
                    name = "SMSG_ENVIRONMENTAL_DAMAGE_LOG";
                    uint64 victim; uint8 type; uint32 amount, resisted, absorbed;
                    p >> victim >> type >> amount >> resisted >> absorbed;
                    w.AddGuid("victimGuid", (uint64_t)victim).Add("type", (uint32)type).Add("amount", amount)
                     .Add("resist", resisted).Add("absorb", absorbed);
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
                // ------------------------------------------- class resources
                // The combo points a rogue or a feral druid holds, and on
                // whom (Unit::SendComboPoints, to the player alone): target
                // packGUID (empty when there is none), u8 points. Sent on
                // every change, a spend and a target change included.
                case SMSG_UPDATE_COMBO_POINTS:
                {
                    name = "SMSG_UPDATE_COMBO_POINTS";
                    uint64 target = 0; p.readPackGUID(target);
                    uint8 points; p >> points;
                    w.AddGuid("targetGuid", (uint64_t)target).Add("points", (uint32)points);
                    break;
                }
                // A Death Knight rune changing type (Player::ConvertRune): u8
                // rune index 0-5, u8 RuneType (0 blood, 1 unholy, 2 frost, 3
                // death). Readiness rides SMSG_SPELL_GO's rune list (below);
                // SMSG_RESYNC_RUNES and SMSG_ADD_RUNE_POWER have no caller
                // at the pinned commit (the one ResyncRunes call in
                // SpellEffects.cpp is commented out), so they are left to
                // the drop census until one does.
                case SMSG_CONVERT_RUNE:
                {
                    name = "SMSG_CONVERT_RUNE";
                    uint8 index, runeType; p >> index >> runeType;
                    w.Add("index", (uint32)index).Add("runeType", (uint32)runeType);
                    break;
                }
                // A channel opening, and its pushback or end
                // (Spell::SendChannelStart / SendChannelUpdate, to every
                // client in range): caster packGUID, then u32 spell and u32
                // duration in ms for the start, u32 time left in ms for the
                // update, 0 being the end (interrupted or run out). The
                // channel follows the spell's own SMSG_SPELL_GO.
                case MSG_CHANNEL_START:
                {
                    name = "MSG_CHANNEL_START";
                    uint64 caster = 0; p.readPackGUID(caster);
                    uint32 spellId, durationMs; p >> spellId >> durationMs;
                    w.AddGuid("casterGuid", (uint64_t)caster).Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    w.Add("durationMs", durationMs);
                    break;
                }
                case MSG_CHANNEL_UPDATE:
                {
                    name = "MSG_CHANNEL_UPDATE";
                    uint64 caster = 0; p.readPackGUID(caster);
                    uint32 timeMs; p >> timeMs;
                    w.AddGuid("casterGuid", (uint64_t)caster).Add("timeMs", timeMs);
                    break;
                }
                // A totem in one of the four totem slots (Totem::InitStats,
                // to its owner alone): u8 slot (0 fire, 1 earth, 2 water,
                // 3 air: the number CMSG_TOTEM_DESTROYED takes), u64 totem
                // guid, u32 duration in ms, u32 spell that summoned it.
                case SMSG_TOTEM_CREATED:
                {
                    name = "SMSG_TOTEM_CREATED";
                    uint8 slot; uint64 totem; uint32 durationMs, spellId;
                    p >> slot >> totem >> durationMs >> spellId;
                    w.Add("slot", (uint32)slot).AddGuid("guid", (uint64_t)totem)
                     .Add("durationMs", durationMs).Add("spellId", spellId);
                    AddSpellFields(w, spellId);
                    break;
                }
                // The breath, fatigue and fire bars (Player::SendMirrorTimer,
                // StopMirrorTimer; MiscPackets.cpp), to the player alone and
                // only on a change: entering or leaving the water, death.
                // Start: u32 type (0 fatigue, 1 breath, 2 fire), u32 value
                // and u32 max in ms, i32 scale (ms gained per ms: -1
                // draining, 10 refilling), u8 paused, u32 spell. Stop: u32
                // type. SMSG_PAUSE_MIRROR_TIMER has no caller at the pinned
                // commit and is left to the drop census until one does.
                case SMSG_START_MIRROR_TIMER:
                {
                    name = "SMSG_START_MIRROR_TIMER";
                    uint32 type, value, maxValue; int32 scale; uint8 paused; uint32 spellId;
                    p >> type >> value >> maxValue >> scale >> paused >> spellId;
                    w.Add("type", type).Add("value", value).Add("max", maxValue).Add("scale", scale)
                     .Add("paused", paused != 0).Add("spellId", spellId);
                    break;
                }
                case SMSG_STOP_MIRROR_TIMER:
                {
                    name = "SMSG_STOP_MIRROR_TIMER";
                    uint32 type; p >> type;
                    w.Add("type", type);
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
                    AddSpellbookFields(w, spellId);
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
                    AddSpellbookFields(w, newId);
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
                        // The glyph slots, slot = index (MAX_GLYPH_SLOT_INDEX,
                        // 6): a GlyphProperties.dbc id, 0 for an empty slot,
                        // with the glyph's spell and its name from the
                        // client's own GlyphProperties.dbc and Spell.dbc.
                        uint8 glyphCount; p >> glyphCount;
                        std::string glyphs = "[";
                        for (uint8 gi = 0; gi < glyphCount; ++gi)
                        {
                            uint16 g; p >> g;
                            Json::Writer gw;
                            gw.Add("slot", (uint32)gi).Add("glyphId", (uint32)g);
                            if (g)
                                if (GlyphPropertiesEntry const* gp = sGlyphPropertiesStore.LookupEntry(g))
                                {
                                    gw.Add("spellId", gp->SpellId);
                                    if (SpellInfo const* info = sSpellMgr->GetSpellInfo(gp->SpellId))
                                        if (info->SpellName[0])
                                            gw.Add("name", info->SpellName[0]);
                                }
                            if (gi) glyphs += ',';
                            glyphs += gw.Str();
                        }
                        glyphs += "]";
                        if (si) specs += ',';
                        specs += Json::Writer().Raw("talents", talents).Raw("glyphs", glyphs).Str();
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
                    // the mask decoded, with the name and the map position a
                    // client reads from its own TaxiNodes.dbc (the flight map
                    // draws each known node at that point); nothing about
                    // routes or fares is here (the client learns those only
                    // by asking to fly). Only the mask's nodes are served: a
                    // client's flight map draws the nodes it has discovered,
                    // and the rest of the table is not what this packet shows.
                    name = "SMSG_SHOWTAXINODES";
                    uint32 show = 0; uint64 guid = 0; uint32 cur = 0;
                    p >> show >> guid >> cur;
                    auto addNodePos = [](Json::Writer& n, TaxiNodeRec const& r)
                    {
                        n.Add("map", r.mapId).Add("x", (double)r.x).Add("y", (double)r.y).Add("z", (double)r.z);
                    };
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
                            {
                                n.Add("name", it->second.name);
                                addNodePos(n, it->second);
                            }
                            known += n.Str();
                        }
                    }
                    mask += "]"; known += "]";
                    w.Add("showWindow", show == 1).AddGuid("guid", (uint64_t)guid).Add("currentNode", cur);
                    auto curIt = _taxiNodes.find(cur);
                    if (curIt != _taxiNodes.end())
                    {
                        w.Add("currentNodeName", curIt->second.name);
                        Json::Writer cp;
                        addNodePos(cp, curIt->second);
                        w.Raw("currentPos", cp.Str());
                    }
                    w.Raw("mask", mask).Raw("known", known);
                    break;
                }
                // Whether this character has discovered the flight master's
                // node (WorldSession::SendTaxiStatus, the answer to
                // CMSG_TAXINODE_STATUS_QUERY; Player::SendTaxiNodeStatusMultiple
                // once at login, after the add to map, for every flight
                // master then in view; and after a discovery):
                // u64 flight master guid, u8 1 known / 0 not. The flight
                // master's map icon.
                case SMSG_TAXINODE_STATUS:
                {
                    name = "SMSG_TAXINODE_STATUS";
                    uint64 guid; uint8 known; p >> guid >> known;
                    w.AddGuid("guid", (uint64_t)guid).Add("known", known != 0);
                    break;
                }
                // A flight path learned (WorldSession::SendLearnNewTaxiNode,
                // SendDiscoverNewTaxiNode): bodiless; the client's "New
                // flight path discovered".
                case SMSG_NEW_TAXI_PATH:
                    name = "SMSG_NEW_TAXI_PATH";
                    break;
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
                case SMSG_PARTY_MEMBER_STATS:
                case SMSG_PARTY_MEMBER_STATS_FULL:
                {
                    // The party frames of a member out of sight: the delta
                    // Group::UpdatePlayerOutOfRange sends (WorldSession::
                    // BuildPartyMemberStatsChangedPacket) only to members out
                    // of the sender's sight range or on another map, once per
                    // update with the fields that changed, and the _FULL
                    // reply to CMSG_REQUEST_PARTY_MEMBER_STATS
                    // (HandleRequestPartyMemberStatsOpcode). _FULL leads with
                    // a u8 0; then both are packed guid, u32 GROUP_UPDATE_FLAG
                    // mask, and one field per set bit in bit order: STATUS u16
                    // MEMBER_STATUS_*, CUR_HP u32, MAX_HP u32, POWER_TYPE u8,
                    // CUR_POWER u16, MAX_POWER u16, LEVEL u16, ZONE u16,
                    // POSITION u16 x, u16 y (the float position truncated
                    // into 16 bits, so read signed: most of the world is at
                    // negative coordinates), AURAS u64 slot mask then (u32
                    // spell, u8 flags) per set slot (spell 0 clears the slot
                    // in a delta). Pet and vehicle fields follow; they are
                    // left unread, and `mask` still says they were there. A
                    // member the server cannot find is answered with _FULL,
                    // mask STATUS and status 0 (offline). zoneName is the
                    // client's AreaTable.dbc name for the zone id, the text
                    // a party frame tooltip shows; an aura's name is its
                    // Spell.dbc name, as on SMSG_AURA_UPDATE.
                    bool const full = opcode == SMSG_PARTY_MEMBER_STATS_FULL;
                    name = full ? "SMSG_PARTY_MEMBER_STATS_FULL" : "SMSG_PARTY_MEMBER_STATS";
                    if (full)
                        { uint8 unk; p >> unk; }
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint32 mask; p >> mask;
                    w.AddGuid("guid", (uint64_t)guid).Add("full", full).Add("mask", mask);
                    if (mask & 0x00000001)
                        { uint16 v; p >> v; w.Add("status", (uint32)v); }
                    if (mask & 0x00000002)
                        { uint32 v; p >> v; w.Add("health", v); }
                    if (mask & 0x00000004)
                        { uint32 v; p >> v; w.Add("maxHealth", v); }
                    if (mask & 0x00000008)
                        { uint8 v; p >> v; w.Add("powerType", (uint32)v); }
                    if (mask & 0x00000010)
                        { uint16 v; p >> v; w.Add("power", (uint32)v); }
                    if (mask & 0x00000020)
                        { uint16 v; p >> v; w.Add("maxPower", (uint32)v); }
                    if (mask & 0x00000040)
                        { uint16 v; p >> v; w.Add("level", (uint32)v); }
                    if (mask & 0x00000080)
                    {
                        uint16 v; p >> v;
                        w.Add("zoneId", (uint32)v);
                        auto it = _areaTable.find(v);
                        if (it != _areaTable.end() && !it->second.name.empty())
                            w.Add("zoneName", it->second.name);
                    }
                    if (mask & 0x00000100)
                        { int16 x, y; p >> x >> y; w.Add("x", (int32)x).Add("y", (int32)y); }
                    if (mask & 0x00000200)
                    {
                        uint64 auraMask; p >> auraMask;
                        std::string auras = "[";
                        for (uint32 slot = 0; slot < 64; ++slot)
                        {
                            if (!(auraMask & (uint64(1) << slot)))
                                continue;
                            uint32 spellId; uint8 flags; p >> spellId >> flags;
                            Json::Writer a;
                            a.Add("slot", slot).Add("spellId", spellId).Add("flags", (uint32)flags);
                            if (spellId)
                                if (SpellInfo const* info = sSpellMgr->GetSpellInfo(spellId))
                                    if (info->SpellName[0])
                                        a.Add("name", info->SpellName[0]);
                            if (auras.size() > 1) auras += ',';
                            auras += a.Str();
                        }
                        auras += "]";
                        w.Raw("auras", auras);
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
                // "Discovered <area>" (Player::SendExplorationExperience,
                // from CheckAreaExploreAndOutdoor): u32 areaId, u32 XP
                // awarded (0 at the level cap or for an area worth none).
                // `areaName` is the client's AreaTable.dbc text, as on
                // SMSG_BINDPOINTUPDATE.
                case SMSG_EXPLORATION_EXPERIENCE:
                {
                    name = "SMSG_EXPLORATION_EXPERIENCE";
                    uint32 areaId, xp; p >> areaId >> xp;
                    auto it = _areaTable.find(areaId);
                    w.Add("areaId", areaId)
                     .Add("areaName", it == _areaTable.end() ? std::string() : it->second.name)
                     .Add("xp", xp);
                    break;
                }
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
                case SMSG_PARTYKILLLOG:
                {
                    // Unit::Kill: u64 the player with the killing blow, u64
                    // the victim. Broadcast to the killer's group (subgroup),
                    // or sent to the killer alone when it has none; only for
                    // a kill that rewards a player.
                    name = "SMSG_PARTYKILLLOG";
                    uint64 killer, victim; p >> killer >> victim;
                    w.AddGuid("killerGuid", (uint64_t)killer).AddGuid("victimGuid", (uint64_t)victim);
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
                    // log renders is named: title/objective text, level, the
                    // quest flags (raw, as the wire's `Flags & 0xFFFF`), and
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
                     .Add("type", type).Add("suggestedPlayers", suggested).Add("flags", flags)
                     .Add("title", title).Add("objectives", objectives).Add("details", details)
                     .Add("areaDescription", areaDescription).Add("completedText", completedText)
                     .Raw("requiredNpcOrGo", reqNpcOrGo).Raw("requiredItems", reqItems);
                    break;
                }
                // The objective areas a client draws on its world map and
                // quest tracker: the answer to CMSG_QUEST_POI_QUERY
                // (WorldSession::HandleQuestPOIQuery, QueryHandler.cpp:411).
                // u32 quest count, then per quest u32 questId, u32 POI count
                // and per POI u32 id, i32 objective index, u32 map, u32
                // WorldMapArea id, u32 floor, u32 priority, u32 flags (the
                // core's Unk3/Unk4, quest_poi's Priority/Flags), u32 point
                // count, (i32 x, i32 y) x points. Served whole: every field is
                // one the client receives. The handler dedupes the ids
                // through an unordered_set, so the order is not the ask's,
                // and a quest not in the log answers a count of 0 exactly as
                // a quest with no areas does.
                case SMSG_QUEST_POI_QUERY_RESPONSE:
                {
                    name = "SMSG_QUEST_POI_QUERY_RESPONSE";
                    uint32 questCount; p >> questCount;
                    std::string quests = "[";
                    for (uint32 i = 0; i < questCount; ++i)
                    {
                        uint32 questId, poiCount; p >> questId >> poiCount;
                        std::string pois = "[";
                        for (uint32 j = 0; j < poiCount; ++j)
                        {
                            uint32 poiId; int32 objectiveIndex;
                            uint32 mapId, worldMapAreaId, floorId, priority, flags, pointCount;
                            p >> poiId >> objectiveIndex >> mapId >> worldMapAreaId >> floorId >> priority >> flags >> pointCount;
                            std::string points = "[";
                            for (uint32 k = 0; k < pointCount; ++k)
                            {
                                int32 px, py; p >> px >> py;
                                if (k) points += ',';
                                points += Json::Writer().Add("x", px).Add("y", py).Str();
                            }
                            points += "]";
                            if (j) pois += ',';
                            pois += Json::Writer().Add("poiId", poiId).Add("objectiveIndex", objectiveIndex)
                                .Add("map", mapId).Add("worldMapAreaId", worldMapAreaId).Add("floor", floorId)
                                .Add("priority", priority).Add("flags", flags).Raw("points", points).Str();
                        }
                        pois += "]";
                        if (i) quests += ',';
                        quests += Json::Writer().Add("questId", questId).Raw("pois", pois).Str();
                    }
                    quests += "]";
                    w.Raw("quests", quests);
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
                // The quest log's 25 slots are taken (Player::SatisfyQuestLog):
                // an accept adds nothing and the client shows "Quest log is
                // full." Bodiless; the refused quest is not named.
                case SMSG_QUESTLOG_FULL:
                    name = "SMSG_QUESTLOG_FULL";
                    break;
                // Why a quest cannot be taken (Player::SendCanTakeQuestResponse,
                // from CanTakeQuest's checks on an accept or a query): u32
                // QuestFailedReason. The client shows it as an error line; the
                // quest is not named on the wire.
                case SMSG_QUESTGIVER_QUEST_INVALID:
                {
                    name = "SMSG_QUESTGIVER_QUEST_INVALID";
                    uint32 reason; p >> reason;
                    w.Add("reason", reason);
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
                        // `coded`: choosing it takes a typed code
                        // (gossip_select's `code`). `boxMoney` (copper) and
                        // `boxText` are the cost and the confirm text a client
                        // shows before the option is taken; left out when 0
                        // and empty.
                        Json::Writer opt;
                        opt.Add("optionId", index).Add("icon", (uint32)icon)
                            .Add("text", text).Add("coded", coded != 0);
                        if (boxMoney) opt.Add("boxMoney", boxMoney);
                        if (!boxText.empty()) opt.Add("boxText", boxText);
                        options += opt.Str();
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
                // The gossip window's body text, the answer to
                // CMSG_NPC_TEXT_QUERY on the textId SMSG_GOSSIP_MESSAGE names
                // (WorldSession::HandleNpcTextQueryOpcode): u32 textId, then
                // MAX_GOSSIP_TEXT_OPTIONS (8) x (float probability, string
                // male text, string female text, u32 language, 3 x (u32
                // emote delay, u32 emote)). An unknown id answers the core's
                // "Greetings $N" default. Options with no text are dropped;
                // the emotes are animation and are consumed.
                case SMSG_NPC_TEXT_UPDATE:
                {
                    name = "SMSG_NPC_TEXT_UPDATE";
                    uint32 textId; p >> textId;
                    std::string texts = "[";
                    bool firstText = true;
                    for (uint8 i = 0; i < MAX_GOSSIP_TEXT_OPTIONS; ++i)
                    {
                        float probability; std::string text0, text1; uint32 language;
                        p >> probability >> text0 >> text1 >> language;
                        for (uint8 j = 0; j < MAX_GOSSIP_TEXT_EMOTES; ++j)
                            { uint32 delay, emote; p >> delay >> emote; }
                        if (text0.empty() && text1.empty())
                            continue;
                        if (!firstText) texts += ',';
                        firstText = false;
                        texts += Json::Writer().Add("probability", (double)probability).Add("text", text0)
                            .Add("textFemale", text1).Add("language", language).Str();
                    }
                    texts += "]";
                    w.Add("textId", textId).Raw("texts", texts);
                    break;
                }
                // ----------------------------------------- client queries
                // /played (WorldSession::HandlePlayedTime): u32 total and
                // u32 this-level play time in seconds, u8 whether the client
                // asked to print it.
                case SMSG_PLAYED_TIME:
                {
                    name = "SMSG_PLAYED_TIME";
                    uint32 total, level; uint8 show; p >> total >> level >> show;
                    w.Add("totalSec", total).Add("levelSec", level).Add("show", show != 0);
                    break;
                }
                // The answer to CMSG_QUERY_TIME (WorldSession::
                // SendTimeQueryResponse): u32 server time (unix seconds),
                // u32 seconds until the daily quests reset.
                case SMSG_QUERY_TIME_RESPONSE:
                {
                    name = "SMSG_QUERY_TIME_RESPONSE";
                    uint32 serverTime, dailyResetIn; p >> serverTime >> dailyResetIn;
                    w.Add("serverTime", serverTime).Add("dailyResetInSec", dailyResetIn);
                    break;
                }
                // The item subclasses this character may use, per item class
                // (Player::SendProficiency, on learning a proficiency): u8
                // ItemClass (2 weapon, 4 armour), u32 subclass mask, the
                // whole mask each time.
                case SMSG_SET_PROFICIENCY:
                {
                    name = "SMSG_SET_PROFICIENCY";
                    uint8 itemClass; uint32 mask; p >> itemClass >> mask;
                    w.Add("itemClass", (uint32)itemClass).Add("subclassMask", mask);
                    break;
                }
                // ------------------------------------------------------ loot
                case SMSG_LOOT_RESPONSE:
                {
                    name = "SMSG_LOOT_RESPONSE";
                    uint64 guid; p >> guid;
                    uint8 lootType; p >> lootType;
                    // The refusal form (Player::SendLootError): guid, LOOT_NONE,
                    // one LootError byte — 10 bytes, no gold and no item list.
                    // The window form below is at least 14. Reading it as a
                    // window ran off the end and served {"decodeError":true},
                    // so the SDK waited for a window the server had refused.
                    if (lootType == LOOT_NONE && p.size() - p.rpos() == 1)
                    {
                        uint8 error; p >> error;
                        w.AddGuid("guid", (uint64_t)guid).Add("lootType", (uint32)lootType)
                         .Add("error", (uint32)error);
                        // A refused loot_all has nothing to replay; drop the
                        // pending flag so a later window is not auto-emptied.
                        std::lock_guard<std::mutex> lock(s.objMutex);
                        s.autoLootPending = false;
                        break;
                    }
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
                case SMSG_RESURRECT_REQUEST:
                {
                    // Spell::SendResurrectRequest: u64 caster, u32 name
                    // length, that many bytes of name (its NUL included;
                    // empty for a player caster, whom the client names by
                    // guid), a u8 0, u8 1 when accepting brings resurrection
                    // sickness (a creature caster), and a u32 0 only for a
                    // spell that skips the reclaim timer — consumed, not
                    // served. Answered with CMSG_RESURRECT_RESPONSE (raw).
                    name = "SMSG_RESURRECT_REQUEST";
                    uint64 caster; uint32 len; p >> caster >> len;
                    // A length past the packet's end is a decodeError, never
                    // an over-read (or an allocation of what it claims).
                    if (len > p.size() - p.rpos())
                        throw std::runtime_error("SMSG_RESURRECT_REQUEST name length past the packet end");
                    std::string casterName(len, '\0');
                    if (len)
                        p.read(reinterpret_cast<uint8*>(casterName.data()), len);
                    casterName.resize(strnlen(casterName.c_str(), casterName.size()));
                    uint8 pad, sickness; p >> pad >> sickness;
                    w.AddGuid("casterGuid", (uint64_t)caster);
                    if (!casterName.empty())
                        w.Add("casterName", casterName);
                    w.Add("sickness", sickness != 0);
                    break;
                }
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
                // A dungeon portal refused a ghost whose corpse is not inside
                // that dungeon (MapMgr::PlayerCannotEnter). Bodiless, and the
                // only word a client gets: no SMSG_TRANSFER_PENDING precedes
                // it, so nothing about the pending transfer changes.
                case SMSG_CORPSE_NOT_IN_INSTANCE:
                    name = "SMSG_CORPSE_NOT_IN_INSTANCE";
                    break;
                // A portal's refusal in words (WorldSession::SendAreaTriggerMessage):
                // a dungeon's level gate, a closed instance, a raid entered
                // without a raid group, a battleground portal of the other
                // faction. One packet per line of the text: u32 length (the
                // NUL included), then the line. The core writes the line from
                // a string_view, so the bytes run on past `length` into the
                // lines after it; exactly `length` bytes are read, and the
                // last of them is the NUL or, for every line but the last, the
                // newline that ended it, which is dropped. No transfer follows.
                case SMSG_AREA_TRIGGER_MESSAGE:
                {
                    name = "SMSG_AREA_TRIGGER_MESSAGE";
                    uint32 len; p >> len;
                    // A length past the packet's end is a decodeError, never
                    // an over-read (or an allocation of what it claims).
                    if (len > p.size() - p.rpos())
                        throw std::runtime_error("SMSG_AREA_TRIGGER_MESSAGE length past the packet end");
                    std::string text(len, '\0');
                    if (len)
                        p.read(reinterpret_cast<uint8*>(text.data()), len);
                    text.resize(strnlen(text.c_str(), text.size()));
                    if (!text.empty() && text.back() == '\n')
                        text.pop_back();
                    w.Add("text", text);
                    break;
                }
                // ------------------------------------------ client control
                case SMSG_CLIENT_CONTROL_UPDATE:
                {
                    // Player::SetClientControl: packGUID of the unit the client
                    // moves, u8 1 when it may move it, 0 when not (a fear on
                    // the character itself; a vehicle's driving seat or a
                    // possession ending). The module answers it as a client
                    // does (OnClientControlUpdate); served so the agent sees
                    // whose movement it owns.
                    name = "SMSG_CLIENT_CONTROL_UPDATE";
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint8 allow = 0; p >> allow;
                    w.AddGuid("guid", (uint64_t)guid).Add("allowMove", allow != 0);
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
                    w.AddGuid("guid", (uint64_t)guid);
                    DecodeMonsterMoveBody(p, w);
                    break;
                }
                case SMSG_MONSTER_MOVE_TRANSPORT:
                {
                    // MoveSplineInit::Launch for a unit aboard a transport or
                    // on a vehicle's seat: packGUID of the unit, packGUID of
                    // the transport, i8 seat (-1 on a transport's deck, the
                    // seat index on a vehicle), then the SMSG_MONSTER_MOVE
                    // body, in the transport's own frame. For the character's
                    // own guid it is the boarding spline Vehicle::AddPassenger
                    // launches onto the seat: how a client learns which
                    // vehicle, and which seat, it sits in.
                    name = "SMSG_MONSTER_MOVE_TRANSPORT";
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint64 transportGuid = 0; p.readPackGUID(transportGuid);
                    int8 seat = -1; p >> seat;
                    w.AddGuid("guid", (uint64_t)guid).AddGuid("transportGuid", (uint64_t)transportGuid).Add("seat", (int32_t)seat);
                    DecodeMonsterMoveBody(p, w);
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
