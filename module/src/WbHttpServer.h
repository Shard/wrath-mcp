/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

#ifndef MOD_WRATHBENCH_WBHTTPSERVER_H
#define MOD_WRATHBENCH_WBHTTPSERVER_H

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace WrathBench
{
    // One outbound WebSocket connection. The game side (Manager) holds this and
    // calls Send() from the world/map thread; the implementation marshals the
    // write onto its own io_context strand, so the caller never touches Asio.
    class IWsConn
    {
    public:
        virtual ~IWsConn() = default;
        virtual void Send(std::string const& json) = 0;
        virtual void Close() = 0;
    };

    struct HttpReply
    {
        int status{200};
        std::string body; // JSON
        // Close the connection once the reply is written, whatever the
        // request said about keeping it: set on a refusal that leaves the
        // connection with no caller behind it (a credential that did not
        // authenticate, a lease at its connection limit).
        bool close{false};
    };

    // The reply to one request, for a sink that cannot make it before
    // HandleHttp returns: the game answers on the world thread, and an io
    // thread that waited for it there would be a thread no other connection
    // could use meanwhile. HandleHttp instead returns Defer()'s value, the io
    // thread goes back to its other connections, and the reply is written
    // when Answer() is called or the wait runs out, whichever is first.
    class IHttpAck
    {
    public:
        virtual ~IHttpAck() = default;
        // The reply. Callable from any thread, any number of times: the
        // first call answers the request and every later one is dropped, as
        // is one that comes after the wait ran out or after the connection
        // went away. Never blocks; the write happens on an io thread.
        virtual void Answer(HttpReply reply) = 0;

        // The rest is the sink's to call from inside HandleHttp only.

        // Leave the reply to Answer(), for at most `wait`: after that the
        // request is answered `expired`, and `onExpired` runs first (on an
        // io thread) when given. Returns what HandleHttp must then return.
        virtual HttpReply Defer(std::chrono::seconds wait, HttpReply expired, std::function<void()> onExpired = {}) = 0;
        // A step the reply passes through on an io thread just before it is
        // written, whichever of the three made it: HandleHttp's own return,
        // Answer(), or the wait running out.
        virtual void Then(std::function<void(HttpReply const&)> step) = 0;
    };

    // The answer to an /events upgrade (IHttpSink::AuthorizeWs).
    struct WsAdmit
    {
        int status{0};              // 0 admits; otherwise the HTTP status of the refusal
        char const* error{""};      // the refusal's error code
        bool counted{false};        // holds a subscriber slot of its token
    };

    // The server's own limits (WbManager reads them from the conf). Each is
    // the module protecting the worldserver it runs in, never a rule about
    // the game; 0 turns one off.
    struct HttpLimits
    {
        // Open connections, HTTP and WebSocket together; one past it is
        // closed at accept.
        uint32_t maxConnections{4096};
        // The same, from one peer address.
        uint32_t maxConnectionsPerPeer{0};
        // The same, authenticated by one lease's secret (IHttpPeer::Admit).
        uint32_t maxConnectionsPerLease{0};
        // Bytes one /events subscriber may have queued and unsent before it
        // is dropped as a reader that has stopped reading.
        uint64_t eventsBacklogBytes{16u * 1024 * 1024};
    };

    // A session token as the worldserver log and the audit records name it:
    // "tok:" and the first 8 lowercase hex characters of its SHA-256. Enough
    // to tie one session's lines together, not to recover the token; an
    // operator holding a token finds its lines with
    // `printf %s "$TOKEN" | sha256sum | cut -c1-8`. No token value is ever
    // logged (PROTOCOL.md, "Authentication").
    std::string TokenTag(std::string const& token);

    // The connection a request arrived on, as the sink sees it. The server
    // reads no credential itself, so the sink tells it whose connection this
    // has turned out to be; until it does, the connection is one of the
    // unauthenticated, which are held to a share of the connection table and
    // to a short deadline for their first request (WbHttpServer.cpp).
    class IHttpPeer
    {
    public:
        virtual ~IHttpPeer() = default;
        // The TCP peer is 127.0.0.1/::1.
        virtual bool Loopback() const = 0;
        // The request on this connection authenticated: as the lease named
        // (a session token), or as the operator for "". False when that
        // lease already holds HttpLimits::maxConnectionsPerLease other
        // connections; the connection then stays unauthenticated, and the
        // sink refuses the request. The operator is never refused.
        virtual bool Admit(std::string const& lease) = 0;
    };

    // The game-facing surface the HTTP/WS server calls into. Implemented by the
    // Manager. All callbacks run on io_context threads, never the world thread;
    // the Manager is responsible for marshalling anything that touches game
    // state onto the world thread (see WbManager), and none of them may wait
    // for it there: the threads are few and every connection shares them.
    class IHttpSink
    {
    public:
        virtual ~IHttpSink() = default;
        // peer: the connection. A loopback peer is an operator inside the
        // worldserver container, as opposed to a caller on the compose network
        // (runner, snippet sandbox), which lets diagnostics endpoints serve
        // their verbose view to operators only; and the sink says who
        // authenticated on it (IHttpPeer::Admit).
        // authorization: the request's Authorization header verbatim ("" when
        // absent). Every route authenticates on it (PROTOCOL.md,
        // "Authentication"); the server never interprets it itself.
        // ack: how a reply the world thread makes is given (IHttpAck). The
        // return value is the reply, written at once, unless it is
        // ack->Defer()'s.
        virtual HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body,
            std::string const& authorization, IHttpPeer& peer, std::shared_ptr<IHttpAck> const& ack) = 0;
        // Decide an /events upgrade before the handshake. A refusal (status
        // other than 0) is answered as a plain HTTP reply with that status
        // and error code, so a refused subscriber never registers: 401 for a
        // bad credential, 429 for a cap (PROTOCOL.md, "/events"). An
        // admitted upgrade with `counted` set holds one of its token's
        // subscriber slots, which the server gives back through
        // ReleaseWsSlot exactly once, when the connection object dies,
        // whether or not its handshake ever completed.
        virtual WsAdmit AuthorizeWs(std::string const& token, std::string const& authorization, IHttpPeer& peer) = 0;
        virtual void ReleaseWsSlot(std::string const& token) = 0;
        // replay: the subscribe carried `replay=1`, asking for the reattach
        // replay on this connection (PROTOCOL.md, "/events").
        virtual void OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn, bool replay) = 0;
        virtual void OnWsClose(std::string const& token, IWsConn* conn) = 0;
    };

    // Boost.Beast HTTP/1.1 + WebSocket server on a small dedicated thread pool.
    // No published host port; the compose network is private (see compose.yml).
    // Every peer that can reach the port reaches this parser before any
    // credential is read, so its bounds are fixed here and not negotiable by a
    // caller: request head and body sizes, a deadline on every read and write,
    // the connection count, the size of a frame a subscriber may send and the
    // backlog a subscriber may leave unread (WbHttpServer.cpp).
    class HttpServer
    {
    public:
        HttpServer(std::string bindAddress, uint16_t port, IHttpSink* sink, unsigned threads = 2,
            HttpLimits limits = {});
        ~HttpServer();

        // Binds and starts the accept loop + worker threads. Throws on bind failure.
        void Start();
        // Stops the io_context and joins the workers.
        void Stop();

    private:
        struct Impl;
        std::unique_ptr<Impl> _impl;
    };
}

#endif // MOD_WRATHBENCH_WBHTTPSERVER_H
