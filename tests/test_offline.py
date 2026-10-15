# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 4: no network, from the backend or from Chrome (SPEC §2.2).

The server runs in this process with every outgoing socket intercepted: a
connection or a name lookup that is not loopback is recorded and refused. A
session in the tunnel then runs in the system Chrome, with the program's
offline flags, behind a recording proxy on loopback; ``<-loopback>`` in the
bypass list sends the app's own traffic through the proxy too, so the proxy
sees everything Chrome asks for. The proxy forwards what is for the app and
records the rest: anything recorded fails the test -- with one declared
exception (decision of 2026-10-15): Chrome's updater "activity reporter" has
its URL compiled in and no switch to stop it; in the real window it fails on
DNS (``--host-resolver-rules``). The test accepts that host and nothing else.
"""

from __future__ import annotations

import http.client
import shutil
import socket
import socketserver
import subprocess
import threading
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from gdv.controls import AppControls
from gdv.server import STATIC_DIR, LocalServer

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
#: The one declared residual (see the docstring and gdv/window.py).
KNOWN_RESIDUAL = {"CONNECT update.googleapis.com:443"}


def is_loopback(address) -> bool:
    host = address[0] if isinstance(address, tuple) else address
    return isinstance(host, str) and (host in LOOPBACK or host.startswith("127."))


@pytest.fixture
def no_network(monkeypatch):
    """Record and refuse every connection or name lookup that is not loopback."""
    attempts: list[str] = []
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not is_loopback(address):
            attempts.append(f"connect {address}")
            raise OSError("rete vietata nei test")
        return real_connect(self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not is_loopback(address):
            attempts.append(f"connect_ex {address}")
            return 1
        return real_connect_ex(self, address)

    def getaddrinfo(host, *args, **kwargs):
        if host is not None and not is_loopback(host):
            attempts.append(f"getaddrinfo {host}")
            raise socket.gaierror("rete vietata nei test")
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    return attempts


class RecordingProxy(socketserver.ThreadingTCPServer):
    """A minimal HTTP proxy: forwards requests for the app, records everything else."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, app_port: int) -> None:
        self.app_port = app_port
        self.foreign: list[str] = []
        self.forwarded = 0
        super().__init__(("127.0.0.1", 0), ProxyHandler)


class ProxyHandler(socketserver.StreamRequestHandler):
    server: RecordingProxy

    def handle(self) -> None:
        while True:
            line = self.rfile.readline(65536).decode("latin-1").strip()
            if not line:
                return
            method, target, _version = line.split(" ", 2)
            headers: dict[str, str] = {}
            while True:
                h = self.rfile.readline(65536).decode("latin-1")
                if h in ("\r\n", "\n", ""):
                    break
                key, _, value = h.partition(":")
                headers[key.strip().lower()] = value.strip()
            body = self.rfile.read(int(headers.get("content-length", "0") or 0))
            if method == "CONNECT":
                self.server.foreign.append(f"CONNECT {target}")
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            parts = urlsplit(target)
            if parts.hostname not in LOOPBACK or parts.port != self.server.app_port:
                self.server.foreign.append(f"{method} {target}")
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            self.server.forwarded += 1
            path = parts.path + (f"?{parts.query}" if parts.query else "")
            conn = http.client.HTTPConnection("127.0.0.1", self.server.app_port, timeout=60)
            forward = {
                k: v for k, v in headers.items() if k not in ("proxy-connection", "connection")
            }
            conn.request(method, path or "/", body=body or None, headers=forward)
            response = conn.getresponse()
            data = response.read()
            conn.close()
            head = [f"HTTP/1.1 {response.status} {response.reason}"]
            for key, value in response.getheaders():
                if key.lower() not in ("transfer-encoding", "connection", "content-length"):
                    head.append(f"{key}: {value}")
            head += [f"Content-Length: {len(data)}", "Connection: keep-alive", "", ""]
            self.wfile.write("\r\n".join(head).encode("latin-1") + data)
            self.wfile.flush()


def missing() -> str | None:
    if not any(shutil.which(b) for b in ("google-chrome", "google-chrome-stable")):
        return "Google Chrome non trovato"
    if shutil.which("node") is None:
        return "Node non trovato"
    if not (FRONTEND / "node_modules" / "playwright-core").is_dir():
        return "playwright-core non installato (cd frontend && npm install)"
    if not (STATIC_DIR / "index.html").is_file():
        return "interfaccia non costruita (cd frontend && npm run build)"
    return None


@pytest.mark.browser
def test_4_no_network_from_backend_or_chrome(no_network, xdg_home):
    reason = missing()
    if reason:
        pytest.skip(reason)
    server = LocalServer(AppControls(), "127.0.0.1", 0)
    port = server.start()
    proxy = RecordingProxy(port)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    try:
        done = subprocess.run(
            [
                "node",
                "tests/e2e/offline.mjs",
                f"http://127.0.0.1:{port}/",
                str(proxy.server_address[1]),
            ],
            cwd=FRONTEND,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    finally:
        proxy.shutdown()
        proxy.server_close()
        server.stop()
    assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-4000:]
    assert proxy.forwarded > 10, "the app's traffic did not go through the proxy"
    unexpected = [r for r in proxy.foreign if r not in KNOWN_RESIDUAL]
    assert unexpected == [], "\n".join(unexpected)
    assert no_network == [], no_network


def test_4_the_test_browsers_get_the_window_flags():
    """The e2e harness launches Chrome with the window's own list (the argv of the
    window itself is checked in test_window.py)."""
    harness = (FRONTEND / "tests" / "e2e" / "harness.mjs").read_text(encoding="utf-8")
    assert "CHROME_OFFLINE_FLAGS" in harness and "...offlineFlags()" in harness
