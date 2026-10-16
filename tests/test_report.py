# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 31: the PDF report, printed by headless Chrome from the program's own page.

The server runs with the built interface (the report is a page of it); a
study is saved through the API and its PDF asked for. Without Chrome the
answer is the dedicated message (Chrome simulated absent). The print URL's
token works once, for 60 s.
"""

from __future__ import annotations

import re
import shutil
import time

import pytest

import studydata as sd
from apiclient import Api
from gdv.controls import AppControls
from gdv.server import STATIC_DIR, LocalServer
from gdv.studies import report

pytestmark = pytest.mark.browser


@pytest.fixture
def app_api():
    server = LocalServer(AppControls(), "127.0.0.1", 0, static_dir=STATIC_DIR)
    port = server.start()
    yield Api(port)
    server.stop()


def make_study(api: Api, **extra) -> dict:
    body = sd.parts(study=sd.meta(**extra), **sd.point(), miniatura=sd.png())
    status, study = api.json("POST", "/api/studies", body=body)
    assert status == 200, study
    return study


def pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page[^s]", pdf))


def test_31_the_report_is_a_pdf_of_the_expected_pages(app_api):
    if not (STATIC_DIR / "index.html").is_file():
        pytest.skip("interfaccia non costruita (cd frontend && npm run build)")
    if report.find_browser(None) is None:
        pytest.skip("Chrome o Chromium non trovato")
    study = make_study(app_api)
    started = time.monotonic()
    status, headers, data = app_api.call("GET", f"/api/studies/{study['id']}/report.pdf")
    assert status == 200, data[:500]
    assert headers["content-type"] == "application/pdf"
    assert "attachment" in headers["content-disposition"]
    assert data.startswith(b"%PDF") and len(data) > 10_000
    # Conditions and coefficients; the pictures (two here); the charts.
    assert pages(data) == 4
    assert time.monotonic() - started < 60
    # Nothing left behind in the program's temporary folder.
    from gdv.config import get_settings

    assert not list(get_settings().tmp_dir.glob("report-*"))


def test_31_without_chrome_the_message_says_so(app_api, monkeypatch):
    monkeypatch.setattr(report, "find_browser", lambda *_: None)
    import gdv.api.routes_studies as routes

    monkeypatch.setattr(routes, "find_browser", lambda *_: None)
    study = make_study(app_api)
    status, body = app_api.json("GET", f"/api/studies/{study['id']}/report.pdf")
    assert status == 409 and body["detail"] == "Serve Chrome o Chromium per il PDF"
    assert app_api.json("GET", "/api/reports/chrome")[1] == {"available": False}


def test_the_print_token_works_once_and_expires():
    tokens = report.ReportTokens(lifetime=0.2)
    token = tokens.issue("abc")
    assert tokens.claim(token) == "abc"
    assert tokens.claim(token) is None
    late = tokens.issue("abc")
    time.sleep(0.3)
    assert tokens.claim(late) is None


def test_the_headless_chrome_gets_the_offline_flags():
    from gdv.window import CHROME_OFFLINE_FLAGS

    argv = report.chrome_argv(["chrome"], "/p", "/o.pdf", "http://127.0.0.1:1/report/x")
    assert all(flag in argv for flag in CHROME_OFFLINE_FLAGS)
    assert "--headless=new" in argv and argv[-1].startswith("http://127.0.0.1")
    assert shutil.which("true")  # the test environment has a shell
