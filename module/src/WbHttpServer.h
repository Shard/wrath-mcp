/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

#ifndef MOD_WRATHBENCH_WBHTTPSERVER_H
#define MOD_WRATHBENCH_WBHTTPSERVER_H

#include <cstdint>
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
    };

    // A session token as the worldserver log and the audit records name it:
    // "tok:" and the first 8 lowercase hex characters of its SHA-256. Enough
    // to tie one session's lines together, not to recover the token; an
    // operator holding a token finds its lines with
    // `printf %s "$TOKEN" | sha256sum | cut -c1-8`. No token value is ever
    // logged (PROTOCOL.md, "Authentication").
    std::string TokenTag(std::string const& token);

    // The game-facing surface the HTTP/WS server calls into. Implemented by the
    // Manager. All callbacks run on io_context threads, never the world thread;
    // the Manager is responsible for marshalling anything that touches game
    // state onto the world thread (see WbManager).
    class IHttpSink
    {
    public:
        virtual ~IHttpSink() = default;
        // loopbackPeer: the TCP peer is 127.0.0.1/::1 — an operator inside the
        // worldserver container, as opposed to a caller on the compose network
        // (runner, snippet sandbox). Lets diagnostics endpoints serve their
        // verbose view to operators only.
        // authorization: the request's Authorization header verbatim ("" when
        // absent). Every route authenticates on it (PROTOCOL.md,
        // "Authentication"); the server never interprets it itself.
        virtual HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body,
            std::string const& authorization, bool loopbackPeer) = 0;
        // Decide an /events upgrade before the handshake: false refuses the
        // socket with 401 so an unauthenticated subscriber never registers.
        virtual bool AuthorizeWs(std::string const& token, std::string const& authorization) = 0;
        // replay: the subscribe carried `replay=1`, asking for the reattach
        // replay on this connection (PROTOCOL.md, "/events").
        virtual void OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn, bool replay) = 0;
        virtual void OnWsClose(std::string const& token, IWsConn* conn) = 0;
    };

    // Boost.Beast HTTP/1.1 + WebSocket server on a small dedicated thread pool.
    // No published host port; the compose network is private (see compose.yml).
    class HttpServer
    {
    public:
        HttpServer(std::string bindAddress, uint16_t port, IHttpSink* sink, unsigned threads = 2);
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
