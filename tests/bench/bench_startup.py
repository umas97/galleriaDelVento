# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""SPEC §17: start-up until the window is ready (≤ 3 s) and the backend's RAM at rest (≤ 200 MB).

The real program, in a throw-away home, opens its real window: the system
Chrome through a wrapper that only adds ``--remote-debugging-port``. A small
Node script connects over CDP and waits for the library screen to be drawn
(the header's «Esci» and the library's tabs); the time is from the launch of
the process. The first run creates the window's profile; the median is over
the runs after it. The backend's RSS is read from /proc 5 s after the window
is ready, with the library screen open: OpenCV and trimesh must not be loaded.

    uv run python tests/bench/bench_startup.py [--runs 5]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"

#: Waits until the library screen is drawn; prints the epoch milliseconds then.
READY_SCRIPT = r"""
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP(process.argv[1])
const deadline = Date.now() + 30000
for (;;) {
  const pages = browser.contexts().flatMap((c) => c.pages())
  const page = pages.find((p) => p.url().startsWith(process.argv[2]))
  if (page) {
    await page.getByRole('button', { name: 'Esci' }).waitFor({ timeout: 30000 })
    await page.getByText('Modelli 3D').first().waitFor({ timeout: 30000 })
    console.log(Date.now())
    break
  }
  if (Date.now() > deadline) throw new Error('no window')
  await new Promise((r) => setTimeout(r, 10))
}
await browser.close().catch(() => {})
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def rss_mb(pid: int) -> float:
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) / 1024
    return float("nan")


def backend_pid(launcher: subprocess.Popen) -> int:
    """The Python process of the program (``uv run`` may sit in between)."""
    children = Path(f"/proc/{launcher.pid}/task/{launcher.pid}/children")
    pid = launcher.pid
    for _ in range(3):
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if any(b"python" in part for part in cmd[:1]):
            return pid
        kids = children.read_text().split() if children.exists() else []
        if not kids:
            return pid
        pid = int(kids[0])
        children = Path(f"/proc/{pid}/task/{pid}/children")
    return pid


def one_run(home: Path, chrome: str, *, measure_ram: bool) -> tuple[float, float | None]:
    port = free_port()
    devtools = free_port()
    wrapper = home / "chrome-wrapper.sh"
    wrapper.write_text(f'#!/bin/sh\nexec "{chrome}" --remote-debugging-port={devtools} "$@"\n')
    wrapper.chmod(0o755)
    env = dict(os.environ, GDV_BROWSER=str(wrapper), GDV_PORT=str(port))
    # The runtime dir is the throw-away one (the single-instance lock lives there),
    # but the Wayland socket is in the real one: name it by its absolute path.
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    wayland = os.environ.get("WAYLAND_DISPLAY")
    if runtime and wayland and not wayland.startswith("/"):
        env["WAYLAND_DISPLAY"] = str(Path(runtime) / wayland)
    for var, sub in (
        ("XDG_DATA_HOME", "share"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_RUNTIME_DIR", "run"),
    ):
        (home / sub).mkdir(exist_ok=True)
        env[var] = str(home / sub)
    python = ROOT / ".venv" / "bin" / "galleriadelvento"
    start = time.time()
    proc = subprocess.Popen(  # noqa: S603
        [str(python)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    try:
        cdp = f"http://127.0.0.1:{devtools}"
        for _ in range(3000):
            try:
                urllib.request.urlopen(cdp + "/json/version", timeout=0.2).read()  # noqa: S310 - loopback
                break
            except OSError:
                time.sleep(0.005)
        done = subprocess.run(  # noqa: S603
            ["node", "--input-type=module", "-e", READY_SCRIPT, cdp, f"http://127.0.0.1:{port}/"],
            cwd=FRONTEND,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if done.returncode:
            raise RuntimeError(done.stderr[-2000:])
        ready = int(done.stdout.strip().splitlines()[-1]) / 1000
        ram = None
        if measure_ram:
            time.sleep(5)
            ram = rss_mb(backend_pid(proc))
        return ready - start, ram
    finally:
        try:
            req = urllib.request.Request(  # noqa: S310 - loopback
                f"http://127.0.0.1:{port}/api/app/quit",
                method="POST",
                headers={"Origin": f"http://127.0.0.1:{port}"},
            )
            urllib.request.urlopen(req, timeout=2).read()  # noqa: S310
        except OSError:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()
    chrome = shutil.which("google-chrome") or shutil.which("google-chrome-stable")
    if chrome is None:
        print("Google Chrome non trovato")
        return 2
    times: list[float] = []
    rams: list[float] = []
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        for run in range(args.runs + 1):
            elapsed, ram = one_run(home, chrome, measure_ram=run > 0)
            label = "primo avvio (profilo nuovo)" if run == 0 else f"avvio {run}"
            extra = f", RAM backend {ram:.0f} MB" if ram is not None else ""
            print(f"{label}: finestra pronta in {elapsed:.2f} s{extra}")
            if run > 0:
                times.append(elapsed)
                rams.append(ram or float("nan"))
    median = statistics.median(times)
    ram = statistics.median(rams)
    print(json.dumps({"startup_median_s": round(median, 2), "ram_median_mb": round(ram)}))
    print(f"mediana {median:.2f} s (target <= 3 s), RAM {ram:.0f} MB (target <= 200 MB)")
    return 0 if median <= 3 and ram <= 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
