# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Browser end-to-end tests (playwright-core + the system Chrome, SPEC §18).

They drive the built interface against the real program. Skipped -- saying why --
when Chrome, Node, the frontend's node_modules or the build are missing.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

pytestmark = pytest.mark.browser


def _missing() -> str | None:
    if not any(shutil.which(b) for b in ("google-chrome", "google-chrome-stable")):
        return "Google Chrome non trovato"
    if shutil.which("node") is None:
        return "Node non trovato"
    if not (FRONTEND / "node_modules" / "playwright-core").is_dir():
        return "playwright-core non installato (cd frontend && npm install)"
    if not (ROOT / "backend" / "gdv" / "static" / "index.html").is_file():
        return "interfaccia non costruita (cd frontend && npm run build)"
    return None


@pytest.mark.parametrize(
    "script",
    [
        "phase1.e2e.mjs",
        "phase2.e2e.mjs",
        "phase3.e2e.mjs",
        "phase4.e2e.mjs",
        "phase5.e2e.mjs",
        "phase6.e2e.mjs",
        "phase7.e2e.mjs",
    ],
)
def test_e2e(script, tmp_path):
    reason = _missing()
    if reason:
        pytest.skip(reason)
    result = subprocess.run(
        ["node", f"tests/e2e/{script}", str(tmp_path)],
        cwd=FRONTEND,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-4000:]
    assert "OK" in result.stdout
