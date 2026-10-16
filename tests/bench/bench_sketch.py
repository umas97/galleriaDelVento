# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""SPEC §17: the sketch pipeline answers every change in at most 400 ms.

A 4000 × 3000 phone photo (worked on at 2000 px, SPEC §8.1) of a hand-drawn
NACA 2412 is imported into a server in a throw-away home; then each kind of
change the wizard makes is timed through the real HTTP API, with a new value
every time so that no cache answers: a corner dragged (step 1, plus the
straightened sheet the panel shows), threshold and gap welding (step 2), gap
welding seen in step 3, smoothing (step 3), wind and scale (step 4).

    uv run python tests/bench/bench_sketch.py [--runs 15]
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from synthetic import naca4, on_sheet, sketch_photo  # noqa: E402

BUDGET_MS = 400


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=15)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as home:
        for var, sub in (
            ("XDG_DATA_HOME", "share"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_RUNTIME_DIR", "run"),
        ):
            Path(home, sub).mkdir()
            os.environ[var] = str(Path(home, sub))
        from apiclient import Api
        from gdv.controls import AppControls
        from gdv.server import LocalServer

        server = LocalServer(AppControls(), "127.0.0.1", 0, static_dir=Path(home) / "none")
        api = Api(server.start())
        try:
            data, _ = sketch_photo([(on_sheet(naca4("2412", 200)), True)], 7, photo=(4000, 3000))
            started = time.perf_counter()
            info = api.json("POST", "/api/sketches/import?nome=schizzo.jpg", body=data)[1]
            first = api.json(
                "POST",
                f"/api/sketches/{info['id']}/preview",
                json_body={"params": {}, "stage": "sheet"},
            )[1]
            print(f"import + decode + sheet found: {(time.perf_counter() - started) * 1000:.0f} ms")
            base = first["params"] | {"length_m": 1.0}
            corners = base["corners"]

            def preview(stage: str, **change) -> float:
                body = {"params": base | change, "stage": stage}
                t = time.perf_counter()
                status, _ = api.json("POST", f"/api/sketches/{info['id']}/preview", json_body=body)
                assert status == 200
                return (time.perf_counter() - t) * 1000

            def corner(k: int) -> float:
                moved = [list(c) for c in corners]
                moved[0][0] += 0.0005 * (k + 1)
                ms = preview("sheet", corners=moved)
                query = ",".join(str(v) for c in moved for v in c)
                t = time.perf_counter()
                api.call("GET", f"/api/sketches/{info['id']}/sheet.jpg?corners={query}")
                return ms + (time.perf_counter() - t) * 1000

            cases = {
                "1 corner dragged (+ sheet.jpg)": corner,
                "2 threshold": lambda k: preview("ink", threshold=0.08 + 0.004 * k),
                "2 gap welding": lambda k: preview("ink", closing=0.005 + 0.002 * k),
                "3 gap welding": lambda k: preview("outline", closing=0.006 + 0.002 * k),
                "3 smoothing": lambda k: preview("outline", smoothing=0.0002 + 0.0002 * k),
                "4 wind": lambda k: preview("profile", wind_deg=-10 + k),
                "4 scale": lambda k: preview("profile", length_m=0.5 + 0.1 * k),
            }
            worst = 0.0
            results = {}
            for label, run in cases.items():
                times = [run(k) for k in range(args.runs)]
                worst = max(worst, max(times))
                results[label] = times
                print(
                    f"{label:32s} median {statistics.median(times):6.0f} ms   "
                    f"max {max(times):6.0f} ms"
                )
            print(json.dumps({"worst_ms": round(worst), "budget_ms": BUDGET_MS}))
            return 0 if worst <= BUDGET_MS else 1
        finally:
            server.stop()


if __name__ == "__main__":
    sys.exit(main())
