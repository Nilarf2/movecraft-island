"""Standalone HTTP server: python3 -m server.serve (settings from environment variables).

Also exports respond(app, handler) so another BaseHTTPRequestHandler (the Windows
launcher) can hand /api/v1/ requests to the same App in one line.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
import os
import signal
import sys
import threading

from .app import MAX_BODY, create_app

log = logging.getLogger("movecraft")
DRAIN_LIMIT = 2 * 1024 * 1024


def respond(app, handler):
    """Read the request from a BaseHTTPRequestHandler, run app.handle, write the response."""
    headers = handler.headers
    if "chunked" in (headers.get("Transfer-Encoding") or "").lower():
        return _send(handler, *app.reply_error(411, "invalid", "请求需要 Content-Length"), close=True)
    raw = (headers.get("Content-Length") or "0").strip()
    if not raw.isascii() or not raw.isdigit():
        return _send(handler, *app.reply_error(400, "invalid", "Content-Length 不对"), close=True)
    length = int(raw)
    if length > MAX_BODY:
        if length <= DRAIN_LIMIT:  # read it so the client sees the 413 instead of a reset
            _read(handler, length)
        return _send(handler, *app.reply_error(413, "too_large", "请求内容太大"), close=True)
    body = _read(handler, length) if length else b""
    if body is None or len(body) != length:
        return _send(handler, *app.reply_error(400, "invalid", "请求内容不完整"), close=True)
    status, out_headers, out_body = app.handle(handler.command, handler.path, headers.items(),
                                               body, handler.client_address[0])
    return _send(handler, status, out_headers, out_body)


def _read(handler, length):
    try:
        return handler.rfile.read(length)
    except OSError:
        return None


def _send(handler, status, headers, body, close=False):
    handler.send_response(status)
    for name, value in headers:
        handler.send_header(name, value)
    if close:
        handler.send_header("Connection", "close")
        handler.close_connection = True
    handler.end_headers()
    if body and handler.command != "HEAD":
        handler.wfile.write(body)


class ApiHandler(BaseHTTPRequestHandler):
    app = None
    timeout = 15  # slow or stalled clients cannot hold a thread forever
    server_version = "movecraft"
    sys_version = ""

    def _any(self):
        respond(self.app, self)

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_HEAD = do_PATCH = _any

    def version_string(self):
        return self.server_version

    def log_message(self, fmt, *args):
        pass  # App.handle writes its own access log without paths' query strings


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, handler, max_threads=32):
        self.slots = threading.BoundedSemaphore(max_threads)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)  # overloaded: drop rather than queue unbounded threads
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def make_server(app, host="127.0.0.1", port=8787):
    handler = type("BoundApiHandler", (ApiHandler,), {"app": app})
    return Server((host, port), handler)


def _stop(*_):
    raise KeyboardInterrupt


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    os.umask(0o077)  # the database and backups are readable by this user only
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8787"))
    app = create_app()
    server = make_server(app, host, port)
    signal.signal(signal.SIGTERM, _stop)  # docker stop: close the database cleanly
    print(f"MoveCraft API listening on http://{host}:{server.server_port}/api/v1/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()


if __name__ == "__main__":
    main()
