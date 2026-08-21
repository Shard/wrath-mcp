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

    // The game-facing surface the HTTP/WS server calls into. Implemented by the
    // Manager. All callbacks run on io_context threads, never the world thread;
    // the Manager is responsible for marshalling anything that touches game
    // state onto the world thread (see WbManager).
    class IHttpSink
    {
    public:
        virtual ~IHttpSink() = default;
        virtual HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body) = 0;
        virtual void OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn) = 0;
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
