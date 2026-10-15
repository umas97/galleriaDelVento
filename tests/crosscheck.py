# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Run the TypeScript side of a cross-language test (``frontend/tests/crosscheck.test.ts``).

Some algorithms exist twice, once per language, and must agree (SPEC §18: tests
9 and 10). The Python test writes the cases, this helper runs vitest on them
and returns what the TypeScript code computed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


def run_ts(task: str, payload: Any, tmp_path: Path) -> Any:
    if shutil.which("npx") is None:
        pytest.skip("Node non trovato: il confronto con TypeScript non si può fare")
    if not (FRONTEND / "node_modules" / "vitest").is_dir():
        pytest.skip("dipendenze del frontend non installate (cd frontend && npm install)")
    source, result = tmp_path / "cross-in.json", tmp_path / "cross-out.json"
    source.write_text(json.dumps({"task": task, "payload": payload}), encoding="utf-8")
    env = {**os.environ, "GDV_CROSS_IN": str(source), "GDV_CROSS_OUT": str(result)}
    done = subprocess.run(
        ["npx", "vitest", "run", "tests/crosscheck.test.ts"],
        cwd=FRONTEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-4000:]
    return json.loads(result.read_text(encoding="utf-8"))
