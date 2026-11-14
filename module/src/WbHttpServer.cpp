/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

#include "WbHttpServer.h"
#include "Log.h"

#include <boost/asio/dispatch.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/asio/strand.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <boost/beast/websocket.hpp>

#include <atomic>
#include <chrono>
#include <deque>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <vector>

#if defined(__linux__)
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#endif

namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
namespace asio = boost::asio;
using tcp = asio::ip::tcp;

namespace WrathBench
{
    // Split "/events?token=abc&replay=1" into path, the token= value and
    // whether replay=1 was asked for (the reattach replay, PROTOCOL.md).
    static void SplitTarget(std::string const& target, std::string& path, std::string& token, bool& replay)
    {
        auto q = target.find('?');
        path = q == std::string::npos ? target : target.substr(0, q);
        token.clear();
        replay = false;
        if (q == std::string::npos)
            return;
        std::string query = target.substr(q + 1);
        size_t i = 0;
        while (i < query.size())
        {
            auto amp = query.find('&', i);
            std::string pair = query.substr(i, amp == std::string::npos ? std::string::npos : amp - i);
            auto eq = pair.find('=');
            if (eq != std::string::npos)
            {
                std::string const key = pair.substr(0, eq);
                if (key == "token")
                    token = pair.substr(eq + 1);
                else if (key == "replay")
                    replay = pair.substr(eq + 1) == "1";
            }
            if (amp == std::string::npos) break;
            i = amp + 1;
        }
    }

    // The bounds on what a peer may make this server hold, fixed rather than
    // configured: none is a number a deployment tunes, and each is far above
    // anything the protocol sends. A request head is a short target and a
    // handful of headers; the largest body is a `raw` action's 1024 hex
    // characters or a line of chat; a subscriber sends nothing at all
    // (PROTOCOL.md, "/events"). Beast's own defaults would allow a megabyte
    // of body per connection and a 16 MiB frame per subscriber, buffered
    // before any credential is looked at.
    static constexpr std::uint32_t kHeaderLimit = 8 * 1024;
    static constexpr std::uint64_t kBodyLimit = 64 * 1024;
    static constexpr std::size_t kWsReadMax = 4 * 1024;
    // One request, from its first byte (or from the moment a kept-alive
    // connection went idle) to its last, and one reply. Absolute deadlines:
    // a peer that trickles bytes does not extend them.
    static constexpr std::chrono::seconds kReadTimeout{60};
    static constexpr std::chrono::seconds kWriteTimeout{30};

    // The connection count, total and per peer address. A connection holds a
    // ConnSlot from accept until its object dies, the WebSocket it may have
    // become included.
    struct ConnTable
    {
        std::mutex mutex;
        std::uint32_t total{0};
        std::map<asio::ip::address, std::uint32_t> byPeer;
    };

    class ConnSlot
    {
    public:
        ConnSlot(std::shared_ptr<ConnTable> table, asio::ip::address peer)
            : _table(std::move(table)), _peer(std::move(peer)) { }
        ConnSlot(ConnSlot const&) = delete;
        ConnSlot& operator=(ConnSlot const&) = delete;
        ~ConnSlot()
        {
            std::lock_guard<std::mutex> lock(_table->mutex);
            --_table->total;
            auto it = _table->byPeer.find(_peer);
            if (it != _table->byPeer.end() && --it->second == 0)
                _table->byPeer.erase(it);
        }

        // A slot for one more connection from this peer, or nullptr when a
        // limit is reached.
        static std::shared_ptr<ConnSlot> Take(std::shared_ptr<ConnTable> const& table, HttpLimits const& limits,
            asio::ip::address const& peer)
        {
            {
                std::lock_guard<std::mutex> lock(table->mutex);
                if (limits.maxConnections && table->total >= limits.maxConnections)
                    return nullptr;
                std::uint32_t& mine = table->byPeer[peer];
                if (limits.maxConnectionsPerPeer && mine >= limits.maxConnectionsPerPeer)
                {
                    if (mine == 0)
                        table->byPeer.erase(peer);
                    return nullptr;
                }
                ++mine;
                ++table->total;
            }
            return std::make_shared<ConnSlot>(table, peer);
        }

    private:
        std::shared_ptr<ConnTable> _table;
        asio::ip::address _peer;
    };

    // A subscriber's socket lives for hours and the server only ever writes
    // to it, so a peer that vanished without a FIN (a killed pod, a dropped
    // route) would otherwise hold its connection, and its token's subscriber
    // slot, until a write happened to fail many minutes later. Keepalive
    // probes find an idle dead peer and the user timeout one that has stopped
    // acknowledging what was sent; both are the kernel's, so a client whose
    // own event loop is busy is not mistaken for a dead one. Linux only, as
    // the options are; elsewhere the system's keepalive defaults apply.
    static void TuneSubscriberSocket(tcp::socket& socket)
    {
        beast::error_code ec;
        socket.set_option(asio::socket_base::keep_alive(true), ec);
#if defined(__linux__)
        int const fd = socket.native_handle();
        int const idleS = 30, intervalS = 10, probes = 9;
        unsigned int const userTimeoutMs = 120 * 1000;
        (void)::setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idleS, sizeof(idleS));
        (void)::setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intervalS, sizeof(intervalS));
        (void)::setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &probes, sizeof(probes));
        (void)::setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &userTimeoutMs, sizeof(userTimeoutMs));
#endif
    }

    // ----------------------------------------------------------- WebSocket
    class WsSession : public IWsConn, public std::enable_shared_from_this<WsSession>
    {
    public:
        WsSession(tcp::socket&& socket, IHttpSink* sink, std::string token, bool replay, bool counted,
            std::shared_ptr<ConnSlot> slot, std::uint64_t backlogLimit)
            : _ws(std::move(socket)), _sink(sink), _token(std::move(token)), _replay(replay), _counted(counted),
              _slot(std::move(slot)), _backlogLimit(backlogLimit), _buffer(kWsReadMax + 1024) { }

        // The subscriber slot goes back when the object dies, not at close:
        // that covers a handshake that never completed as well, and it is the
        // one point every path reaches exactly once.
        ~WsSession() override
        {
            if (_counted)
                _sink->ReleaseWsSlot(_token);
        }

        void Run(http::request<http::string_body> req)
        {
            TuneSubscriberSocket(_ws.next_layer());
            _ws.set_option(websocket::stream_base::timeout::suggested(beast::role_type::server));
            // The client sends nothing the server reads; a frame larger than
            // this fails the read and closes the socket instead of being
            // buffered to be thrown away.
            _ws.read_message_max(kWsReadMax);
            _ws.async_accept(req, beast::bind_front_handler(&WsSession::OnAccept, shared_from_this()));
        }

        // IWsConn: callable from any thread.
        void Send(std::string const& json) override
        {
            auto self = shared_from_this();
            asio::post(_ws.get_executor(), [self, json]()
            {
                if (self->_dropped)
                    return;
                // A reader that has stopped reading (or reads slower than its
                // session produces) would otherwise grow this queue for as
                // long as the session lives, in the worldserver's memory. Past
                // the limit the subscriber is dropped, which it sees as any
                // socket loss: the SDK reconnects and reports the gap.
                if (self->_backlogLimit && self->_outboxBytes + json.size() > self->_backlogLimit)
                    return self->Drop();
                self->_outboxBytes += json.size();
                self->_outbox.push_back(json);
                if (self->_outbox.size() == 1)
                    self->DoWrite();
            });
        }

        void Close() override
        {
            auto self = shared_from_this();
            asio::post(_ws.get_executor(), [self]()
            {
                beast::error_code ec;
                self->_ws.next_layer().close(ec);
            });
        }

    private:
        // On the strand. The front of the queue stays: a write in flight
        // still points at it, and fails on the closed socket.
        void Drop()
        {
            _dropped = true;
            LOG_WARN("module", "wrathbench: dropping an /events subscriber of {}: {} bytes queued and unread (WrathBench.EventsBacklogBytes)",
                TokenTag(_token), _outboxBytes);
            while (_outbox.size() > 1)
                _outbox.pop_back();
            beast::error_code ec;
            _ws.next_layer().close(ec);
            if (_opened)
            {
                _sink->OnWsClose(_token, this);
                _opened = false;
            }
        }

        void OnAccept(beast::error_code ec)
        {
            if (ec)
            {
                LOG_DEBUG("module", "wrathbench: ws accept failed for {}: {}", TokenTag(_token), ec.message());
                return;
            }
            _opened = true;
            _sink->OnWsOpen(_token, shared_from_this(), _replay);
            DoRead();
        }

        void DoRead()
        {
            _ws.async_read(_buffer, beast::bind_front_handler(&WsSession::OnRead, shared_from_this()));
        }

        void OnRead(beast::error_code ec, std::size_t)
        {
            if (ec)
            {
                if (_opened)
                {
                    _sink->OnWsClose(_token, this);
                    _opened = false;
                }
                return;
            }
            // Events flow server->client only; discard anything the client sends.
            _buffer.consume(_buffer.size());
            DoRead();
        }

        void DoWrite()
        {
            _ws.text(true);
            _ws.async_write(asio::buffer(_outbox.front()),
                beast::bind_front_handler(&WsSession::OnWrite, shared_from_this()));
        }

        void OnWrite(beast::error_code ec, std::size_t)
        {
            if (ec)
            {
                if (_opened) { _sink->OnWsClose(_token, this); _opened = false; }
                return;
            }
            _outboxBytes -= _outbox.front().size();
            _outbox.pop_front();
            if (!_outbox.empty())
                DoWrite();
        }

        websocket::stream<tcp::socket> _ws;
        IHttpSink* _sink;
        std::string _token;
        bool _replay{false};
        bool _counted{false};
        std::shared_ptr<ConnSlot> _slot;
        std::uint64_t _backlogLimit{0};
        beast::flat_buffer _buffer;
        std::deque<std::string> _outbox;
        std::uint64_t _outboxBytes{0};
        bool _opened{false};
        bool _dropped{false};
    };

    // ----------------------------------------------------------- HTTP conn
    class HttpConnection : public std::enable_shared_from_this<HttpConnection>
    {
    public:
        HttpConnection(tcp::socket&& socket, IHttpSink* sink, std::shared_ptr<ConnSlot> slot, bool loopbackPeer,
            std::uint64_t backlogLimit)
            : _stream(std::move(socket)), _sink(sink), _slot(std::move(slot)), _loopbackPeer(loopbackPeer),
              _backlogLimit(backlogLimit), _buffer(kHeaderLimit + kBodyLimit) { }

        void Run()
        {
            asio::dispatch(_stream.get_executor(),
                beast::bind_front_handler(&HttpConnection::DoRead, shared_from_this()));
        }

    private:
        void DoRead()
        {
            // A parser of our own rather than the one async_read makes for a
            // bare message, so the limits are stated here and not inherited.
            _parser.emplace();
            _parser->header_limit(kHeaderLimit);
            _parser->body_limit(kBodyLimit);
            _stream.expires_after(kReadTimeout);
            http::async_read(_stream, _buffer, *_parser,
                beast::bind_front_handler(&HttpConnection::OnRead, shared_from_this()));
        }

        void OnRead(beast::error_code ec, std::size_t)
        {
            if (ec == http::error::end_of_stream)
                return Shutdown();
            // Too large is answered, once, and the connection closed: the
            // rest of the request is never read.
            if (ec == http::error::body_limit || ec == http::error::buffer_overflow)
                return SendReply({413, R"({"ok":false,"error":"body_too_large"})"}, false);
            if (ec == http::error::header_limit)
                return SendReply({431, R"({"ok":false,"error":"header_too_large"})"}, false);
            if (ec)
                return;
            _req = _parser->release();

            std::string path, token;
            bool replay = false;
            SplitTarget(std::string(_req.target()), path, token, replay);

            std::string authorization(_req[http::field::authorization]);

            // WebSocket upgrade on /events becomes a WsSession that outlives us
            // — once the credential and the token's subscriber cap have been
            // checked. A refused upgrade is a plain response on the
            // not-yet-upgraded stream.
            if (websocket::is_upgrade(_req) && path == "/events")
            {
                WsAdmit const admit = _sink->AuthorizeWs(token, authorization);
                if (admit.status != 0)
                {
                    SendReply({admit.status, std::string(R"({"ok":false,"error":")") + admit.error + "\"}"}, false);
                    return;
                }
                std::make_shared<WsSession>(_stream.release_socket(), _sink, token, replay, admit.counted,
                    std::move(_slot), _backlogLimit)->Run(_req);
                return; // socket ownership handed off
            }

            std::string method(_req.method_string());
            HttpReply reply = _sink->HandleHttp(method, path, _req.body(), authorization, _loopbackPeer);
            SendReply(reply, _req.keep_alive());
        }

        void SendReply(HttpReply const& reply, bool keepAlive)
        {
            auto res = std::make_shared<http::response<http::string_body>>(
                static_cast<http::status>(reply.status), _req.version());
            res->set(http::field::server, "mod-wrathbench");
            res->set(http::field::content_type, "application/json");
            res->keep_alive(keepAlive);
            res->body() = reply.body;
            res->prepare_payload();

            // The read's deadline is spent by now (the handler may have
            // waited on the world thread); the write gets its own, so a peer
            // that never reads its reply does not hold the connection.
            _stream.expires_after(kWriteTimeout);
            http::async_write(_stream, *res,
                [self = shared_from_this(), res, keepAlive](beast::error_code ec, std::size_t)
                {
                    if (ec) return;
                    if (keepAlive) self->DoRead();
                    else self->Shutdown();
                });
        }

        void Shutdown()
        {
            beast::error_code ec;
            _stream.socket().shutdown(tcp::socket::shutdown_send, ec);
        }

        beast::tcp_stream _stream;
        IHttpSink* _sink;
        std::shared_ptr<ConnSlot> _slot;
        bool _loopbackPeer{false};
        std::uint64_t _backlogLimit{0};
        beast::flat_buffer _buffer;
        std::optional<http::request_parser<http::string_body>> _parser;
        http::request<http::string_body> _req;
    };

    // ----------------------------------------------------------- acceptor
    struct HttpServer::Impl
    {
        Impl(std::string addr, uint16_t port, IHttpSink* sink, unsigned threads, HttpLimits limits)
            : bindAddress(std::move(addr)), bindPort(port), sink(sink), numThreads(threads), limits(limits),
              ioc(static_cast<int>(threads)), acceptor(ioc), retry(ioc) { }

        void Accept()
        {
            acceptor.async_accept(asio::make_strand(ioc),
                [this](beast::error_code ec, tcp::socket socket)
                {
                    if (!running.load())
                        return;
                    if (ec)
                    {
                        // Out of descriptors, most likely. Accepting again at
                        // once would fail the same way and spin a worker; a
                        // short pause lets connections close.
                        retry.expires_after(std::chrono::milliseconds(100));
                        retry.async_wait([this](beast::error_code) { if (running.load()) Accept(); });
                        return;
                    }
                    // The peer is read once, here; a socket already dead by
                    // now has none and is dropped.
                    beast::error_code pec;
                    auto const peer = socket.remote_endpoint(pec);
                    if (!pec)
                    {
                        if (auto slot = ConnSlot::Take(table, limits, peer.address()))
                            std::make_shared<HttpConnection>(std::move(socket), sink, std::move(slot),
                                peer.address().is_loopback(), limits.eventsBacklogBytes)->Run();
                        else
                            NoteRefused(peer.address());
                    }
                    Accept();
                });
        }

        // A connection past a limit is closed unanswered (the socket dies
        // with the handler's scope). Said in the log at most once in ten
        // seconds, with the count since: a flood must not become a log flood.
        // Only the accept handler calls this, one at a time.
        void NoteRefused(asio::ip::address const& peer)
        {
            ++refusedSinceLog;
            auto const now = std::chrono::steady_clock::now();
            if (now - lastRefusedLog < std::chrono::seconds(10))
                return;
            LOG_WARN("module", "wrathbench: refused {} connection(s) at a connection limit, the last from {} "
                "(WrathBench.MaxConnections, WrathBench.MaxConnectionsPerPeer)", refusedSinceLog, peer.to_string());
            lastRefusedLog = now;
            refusedSinceLog = 0;
        }

        std::string bindAddress;
        uint16_t bindPort;
        IHttpSink* sink;
        unsigned numThreads;
        HttpLimits limits;
        asio::io_context ioc;
        tcp::acceptor acceptor;
        asio::steady_timer retry;
        std::shared_ptr<ConnTable> table{std::make_shared<ConnTable>()};
        std::vector<std::thread> workers;
        // Written by Start/Stop on the world thread, read by the accept
        // handler on a worker.
        std::atomic<bool> running{false};
        std::uint64_t refusedSinceLog{0};
        std::chrono::steady_clock::time_point lastRefusedLog{};
    };

    HttpServer::HttpServer(std::string bindAddress, uint16_t port, IHttpSink* sink, unsigned threads, HttpLimits limits)
        : _impl(std::make_unique<Impl>(std::move(bindAddress), port, sink, threads, limits)) { }

    HttpServer::~HttpServer() { Stop(); }

    void HttpServer::Start()
    {
        auto& impl = *_impl;
        beast::error_code ec;
        tcp::endpoint endpoint(asio::ip::make_address(impl.bindAddress, ec), impl.bindPort);
        if (ec)
            throw std::runtime_error("wrathbench: bad bind address '" + impl.bindAddress + "': " + ec.message());

        impl.acceptor.open(endpoint.protocol(), ec);
        if (ec) throw std::runtime_error("wrathbench: acceptor open failed: " + ec.message());
        impl.acceptor.set_option(asio::socket_base::reuse_address(true), ec);
        impl.acceptor.bind(endpoint, ec);
        if (ec) throw std::runtime_error("wrathbench: bind failed: " + ec.message());
        impl.acceptor.listen(asio::socket_base::max_listen_connections, ec);
        if (ec) throw std::runtime_error("wrathbench: listen failed: " + ec.message());

        impl.running = true;
        impl.Accept();

        impl.workers.reserve(impl.numThreads);
        for (unsigned i = 0; i < impl.numThreads; ++i)
            impl.workers.emplace_back([&impl]()
            {
                // An exception out of a handler would otherwise end the
                // thread, and with it the worldserver (std::terminate). The
                // connection whose handler threw is gone; the rest carry on.
                for (;;)
                {
                    try
                    {
                        impl.ioc.run();
                        return;
                    }
                    catch (std::exception const& e)
                    {
                        LOG_ERROR("module", "wrathbench: HTTP/WS handler threw: {}", e.what());
                    }
                }
            });

        LOG_INFO("module", "wrathbench: HTTP/WS listening on {}:{} ({} threads)",
            impl.bindAddress, impl.bindPort, impl.numThreads);
    }

    void HttpServer::Stop()
    {
        auto& impl = *_impl;
        if (!impl.running)
            return;
        impl.running = false;
        beast::error_code ec;
        impl.acceptor.close(ec);
        impl.ioc.stop();
        for (auto& t : impl.workers)
            if (t.joinable())
                t.join();
        impl.workers.clear();
    }
}
