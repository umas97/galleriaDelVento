# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""SPEC §17: import of a 1 M-triangle STL, up to the view mesh, in at most 5 s.

Measures, through the real HTTP API of a server in a throw-away home: upload +
analysis + repair + library files (POST /api/models/import), then the download
of the mesh the 3D view loads (GET .../vista.bin). The frontend parse is a view
on the buffer and costs nothing measurable.

    uv run python tests/bench/bench_import.py [--triangles 1000000] [--runs 3]
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from synthetic import stl_binary, uv_sphere  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--triangles", type=int, default=1_000_000)
    parser.add_argument("--runs", type=int, default=3)
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
        # A UV sphere: rings * segments * 2 triangles.
        segments = int(np.sqrt(args.triangles))
        rings = args.triangles // (2 * segments) + 1
        vertices, faces = uv_sphere(1.0, rings, segments)
        times = []
        try:
            for run in range(args.runs):
                # A different scale each run: different bytes, no "already imported".
                data = stl_binary(vertices * (1000 + run), faces)
                start = time.perf_counter()
                status, body = api.import_model(data, f"sfera{run}.stl")
                assert status == 200, body
                imported = time.perf_counter()
                status, _, mesh = api.call("GET", f"/api/models/{body['model']['id']}/vista.bin")
                assert status == 200
                done = time.perf_counter()
                times.append(done - start)
                print(
                    f"run {run}: {len(faces):,} triangoli, {len(data) / 1e6:.0f} MB -- "
                    f"import {imported - start:.2f} s, vista {done - imported:.2f} s, "
                    f"totale {done - start:.2f} s"
                )
        finally:
            server.stop()
        print(f"mediana {statistics.median(times):.2f} s (target <= 5 s)")
        return 0 if statistics.median(times) <= 5 else 1


if __name__ == "__main__":
    raise SystemExit(main())
