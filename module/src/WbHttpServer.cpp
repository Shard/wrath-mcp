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

#include "WbHttpServer.h"
#include "Log.h"

#include <boost/asio/dispatch.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/strand.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <boost/beast/websocket.hpp>

#include <deque>
#include <thread>
#include <vector>

namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
namespace asio = boost::asio;
using tcp = asio::ip::tcp;

namespace WrathBench
{
    // Split "/events?token=abc&x=1" into path and a token= value.
    static void SplitTarget(std::string const& target, std::string& path, std::string& token)
    {
        auto q = target.find('?');
        path = q == std::string::npos ? target : target.substr(0, q);
        token.clear();
        if (q == std::string::npos)
            return;
        std::string query = target.substr(q + 1);
        size_t i = 0;
        while (i < query.size())
        {
            auto amp = query.find('&', i);
            std::string pair = query.substr(i, amp == std::string::npos ? std::string::npos : amp - i);
            auto eq = pair.find('=');
            if (eq != std::string::npos && pair.substr(0, eq) == "token")
            {
                token = pair.substr(eq + 1);
                return;
            }
            if (amp == std::string::npos) break;
            i = amp + 1;
        }
    }

    // ----------------------------------------------------------- WebSocket
    class WsSession : public IWsConn, public std::enable_shared_from_this<WsSession>
    {
    public:
        WsSession(tcp::socket&& socket, IHttpSink* sink, std::string token)
            : _ws(std::move(socket)), _sink(sink), _token(std::move(token)) { }

        void Run(http::request<http::string_body> req)
        {
            _ws.set_option(websocket::stream_base::timeout::suggested(beast::role_type::server));
            _ws.async_accept(req, beast::bind_front_handler(&WsSession::OnAccept, shared_from_this()));
        }

        // IWsConn: callable from any thread.
        void Send(std::string const& json) override
        {
            auto self = shared_from_this();
            asio::post(_ws.get_executor(), [self, json]()
            {
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
        void OnAccept(beast::error_code ec)
        {
            if (ec)
            {
                LOG_DEBUG("module", "wrathbench: ws accept failed for token '{}': {}", _token, ec.message());
                return;
            }
            _opened = true;
            _sink->OnWsOpen(_token, shared_from_this());
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
            _outbox.pop_front();
            if (!_outbox.empty())
                DoWrite();
        }

        websocket::stream<tcp::socket> _ws;
        IHttpSink* _sink;
        std::string _token;
        beast::flat_buffer _buffer;
        std::deque<std::string> _outbox;
        bool _opened{false};
    };

    // ----------------------------------------------------------- HTTP conn
    class HttpConnection : public std::enable_shared_from_this<HttpConnection>
    {
    public:
        HttpConnection(tcp::socket&& socket, IHttpSink* sink)
            : _stream(std::move(socket)), _sink(sink)
        {
            // Captured once at accept time; remote_endpoint can fail on an
            // already-dead socket, which just means "not an operator".
            beast::error_code ec;
            auto ep = _stream.socket().remote_endpoint(ec);
            _loopbackPeer = !ec && ep.address().is_loopback();
        }

        void Run()
        {
            asio::dispatch(_stream.get_executor(),
                beast::bind_front_handler(&HttpConnection::DoRead, shared_from_this()));
        }

    private:
        void DoRead()
        {
            _req = {};
            _stream.expires_after(std::chrono::seconds(60));
            http::async_read(_stream, _buffer, _req,
                beast::bind_front_handler(&HttpConnection::OnRead, shared_from_this()));
        }

        void OnRead(beast::error_code ec, std::size_t)
        {
            if (ec == http::error::end_of_stream)
                return Shutdown();
            if (ec)
                return;

            std::string path, token;
            SplitTarget(std::string(_req.target()), path, token);

            // WebSocket upgrade on /events becomes a WsSession that outlives us.
            if (websocket::is_upgrade(_req) && path == "/events")
            {
                std::make_shared<WsSession>(_stream.release_socket(), _sink, token)->Run(_req);
                return; // socket ownership handed off
            }

            std::string method(_req.method_string());
            HttpReply reply = _sink->HandleHttp(method, path, _req.body(), _loopbackPeer);
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
        bool _loopbackPeer{false};
        beast::flat_buffer _buffer;
        http::request<http::string_body> _req;
    };

    // ----------------------------------------------------------- acceptor
    struct HttpServer::Impl
    {
        Impl(std::string addr, uint16_t port, IHttpSink* sink, unsigned threads)
            : bindAddress(std::move(addr)), bindPort(port), sink(sink), numThreads(threads),
              ioc(static_cast<int>(threads)), acceptor(ioc) { }

        void Accept()
        {
            acceptor.async_accept(asio::make_strand(ioc),
                [this](beast::error_code ec, tcp::socket socket)
                {
                    if (!ec)
                        std::make_shared<HttpConnection>(std::move(socket), sink)->Run();
                    if (running)
                        Accept();
                });
        }

        std::string bindAddress;
        uint16_t bindPort;
        IHttpSink* sink;
        unsigned numThreads;
        asio::io_context ioc;
        tcp::acceptor acceptor;
        std::vector<std::thread> workers;
        bool running{false};
    };

    HttpServer::HttpServer(std::string bindAddress, uint16_t port, IHttpSink* sink, unsigned threads)
        : _impl(std::make_unique<Impl>(std::move(bindAddress), port, sink, threads)) { }

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
            impl.workers.emplace_back([&impl]() { impl.ioc.run(); });

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
