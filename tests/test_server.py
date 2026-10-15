# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The local server: its base API, who may talk to it, and the interface it serves."""

from __future__ import annotations

import time

import pytest

from gdv.config import APP_ID


def test_health_names_the_application(live):
    status, body = live.json("GET", "/api/health")
    assert status == 200
    assert body["status"] == "ok"
    assert body["app"] == APP_ID


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "localhost:5173"])
def test_loopback_hosts_pass(live, host):
    status, _ = live.json("GET", "/api/health", host=host)
    assert status == 200


@pytest.mark.parametrize("host", ["evil.example", "192.168.1.10", "evil.example:80"])
def test_a_foreign_host_is_refused(live, host):
    """DNS rebinding: the page's name points at us, but the Host header gives it away."""
    status, body = live.json("GET", "/api/health", host=host)
    assert status == 400
    assert "host" in body["detail"]


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "file://"])
def test_a_foreign_page_cannot_quit_the_program(live, origin):
    status, _ = live.json("POST", "/api/app/quit", origin=origin)
    assert status == 403
    assert live.recorder.calls == []


def test_our_own_page_can_quit_and_the_answer_comes_first(live):
    status, body = live.json("POST", "/api/app/quit", origin=f"http://127.0.0.1:{live.port}")
    assert status == 202
    assert "chiusura" in body["detail"]
    for _ in range(50):
        if live.recorder.calls:
            break
        time.sleep(0.01)
    assert live.recorder.calls == ["quit"]


def test_window_info_says_whether_quit_is_possible(live):
    status, body = live.json("GET", "/api/window")
    assert status == 200
    assert body["mode"] == "app"
    assert body["can_quit"] is True


def test_a_second_launch_can_ask_for_the_window(live):
    status, body = live.json("POST", "/api/window/show")
    assert status == 200
    assert body == {"shown": True}
    assert live.recorder.calls == ["show"]


def test_the_interface_is_served_and_its_router_owns_the_urls(live):
    for path in ("/", "/qualsiasi/schermata"):
        status, headers, body = live.request("GET", path)
        assert status == 200
        assert b"<title>shell</title>" in body
        assert "no-cache" in headers["cache-control"]


def test_hashed_assets_are_cached_for_good(live):
    status, headers, _ = live.request("GET", "/assets/app-1234.js")
    assert status == 200
    assert "immutable" in headers["cache-control"]


def test_an_unknown_api_path_is_a_404_not_the_page(live):
    status, headers, body = live.request("GET", "/api/inesistente")
    assert status == 404
    assert headers["content-type"].startswith("application/json")
    assert b"<title>" not in body


def test_paths_cannot_escape_the_interface_folder(live):
    secret = live.static.parent / "segreto.txt"
    secret.write_text("non leggibile", encoding="utf-8")
    status, _, body = live.request("GET", "/../segreto.txt")
    assert b"non leggibile" not in body
    assert status in (200, 400, 404)


def test_the_window_path_leads_to_the_interface(live):
    """The window opens at /galleriadelvento for its dock identity, then lands on /."""
    status, headers, _ = live.request("GET", f"/{APP_ID}")
    assert status == 307
    assert headers["location"] == "/"


def test_with_a_session_token_the_api_needs_it(live_with_token):
    live = live_with_token
    assert live.json("GET", "/api/window")[0] == 403
    assert live.json("GET", "/api/window", token="sbagliato")[0] == 403
    assert live.json("GET", "/api/window", token="segreto")[0] == 200
    # The page itself and the health check do not: the page reads the token from
    # its own URL, and a second launch checks health without one.
    assert live.request("GET", "/")[0] == 200
    assert live.json("GET", "/api/health")[0] == 200
