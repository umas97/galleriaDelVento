# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Try the built executable as a student would start it (SPEC §25.5).

The GitHub action runs it on the folder PyInstaller made, before zipping it:
what the frozen program misses -- a module, a data file of a library, a media
type -- only shows up when the frozen program runs. With no window, it checks
that the server answers, serves the interface, refuses a foreign page, imports
a model (trimesh, scipy), a drawing (svgelements), a photo (OpenCV), exports a
DXF (ezdxf), that a second launch hands over and that "Esci" ends it all with
the lock removed.

The home is temporary: on Windows ``%LOCALAPPDATA%`` points into it, so the
Windows folders are what is exercised; elsewhere the XDG variables do.

    python packaging/windows/smoke.py dist/galleriaDelVento/galleriaDelVento.exe

Only the standard library: it runs before anything is installed around it.
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

APP_ID = "galleriadelvento"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Client:
    def __init__(self, port: int) -> None:
        self.port = port
        self.origin = f"http://127.0.0.1:{port}"

    def call(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        *,
        content_type: str = "application/octet-stream",
        host: str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        headers = {"Host": host or f"127.0.0.1:{self.port}", "Origin": self.origin}
        if body is not None:
            headers["Content-Type"] = content_type
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, data

    def json(self, method: str, path: str, payload: object = None, **kwargs) -> object:
        body = json.dumps(payload).encode() if payload is not None else kwargs.pop("body", None)
        if payload is not None:
            kwargs["content_type"] = "application/json"
        status, _headers, data = self.call(method, path, body, **kwargs)
        check(status < 300, f"{method} {path}: {status} {data[:500]!r}")
        return json.loads(data)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FALLITO: {message}")
    print(f"ok  {message}")


def cube_stl() -> bytes:
    """A 10 cm cube, ASCII STL."""
    v = [(x, y, z) for x in (0, 0.1) for y in (0, 0.1) for z in (0, 0.1)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    lines = ["solid cube"]
    for a, b, c, d in quads:
        for tri in ((a, b, c), (a, c, d)):
            lines.append("facet normal 0 0 0\nouter loop")
            lines += [f"vertex {v[i][0]} {v[i][1]} {v[i][2]}" for i in tri]
            lines.append("endloop\nendfacet")
    lines.append("endsolid cube")
    return "\n".join(lines).encode()


def sketch_png(width: int = 320, height: int = 240) -> bytes:
    """A white sheet with a dark ellipse: grayscale PNG, written by hand."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # no filter
        for x in range(width):
            inside = ((x - width / 2) / 90) ** 2 + ((y - height / 2) / 40) ** 2 <= 1
            rows.append(20 if inside else 245)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows)))
        + chunk(b"IEND", b"")
    )


SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="20mm" viewBox="0 0 100 20">'
    b'<path d="M0 10 C 20 0, 60 0, 100 10 C 60 20, 20 20, 0 10 Z"/></svg>'
)


def wait_for_health(client: Client, process: subprocess.Popen, timeout: float = 120.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"FALLITO: il programma è uscito subito con {process.returncode}")
        try:
            status, _h, data = client.call("GET", "/api/health")
            if status == 200 and json.loads(data).get("app") == APP_ID:
                return
        except OSError:
            pass
        time.sleep(0.5)
    raise SystemExit("FALLITO: il server non ha risposto in tempo")


def main(executable: str) -> None:
    home = Path(tempfile.mkdtemp(prefix="gdv-smoke-"))
    env = dict(os.environ)
    if sys.platform == "win32":
        env["LOCALAPPDATA"] = str(home / "Local")
        for name in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
            env.pop(name, None)
        lock = home / "Local" / APP_ID / "stato" / f"{APP_ID}.lock"
        log_dir = home / "Local" / APP_ID / "stato" / "logs"
    else:
        for name, sub in (
            ("XDG_DATA_HOME", "share"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_RUNTIME_DIR", "run"),
        ):
            (home / sub).mkdir(parents=True)
            env[name] = str(home / sub)
        lock = home / "run" / f"{APP_ID}.lock"
        log_dir = home / "state" / APP_ID / "logs"
    port = free_port()
    argv = [executable, "--no-window", "--port", str(port)]
    started = time.monotonic()
    process = subprocess.Popen(argv, env=env)
    client = Client(port)
    try:
        wait_for_health(client, process)
        check(True, f"avvio: risponde in {time.monotonic() - started:.1f} s")
        check(lock.is_file(), f"lock: in {lock}")

        status, headers, page = client.call("GET", "/")
        check(status == 200 and b"<script" in page, f"interfaccia: {status}")
        script = page.split(b'src="', 1)[1].split(b'"', 1)[0].decode()
        status, headers, _ = client.call("GET", script)
        kind = headers.get("content-type", "")
        check(status == 200 and "javascript" in kind, f"script come JavaScript: {script} {kind}")
        status, _h, _ = client.call("GET", "/api/health", host="evil.example:80")
        check(status == 400, f"pagina estranea rifiutata: {status}")

        model = client.json("POST", "/api/models/import?nome=cubo.stl", body=cube_stl())
        check("model" in model, "modello 3D: importato")
        drawing = client.json("POST", "/api/drawings/import?nome=profilo.svg", body=SVG)
        check("id" in drawing, "disegno SVG: importato")
        photo = client.json("POST", "/api/sketches/import?nome=schizzo.png", body=sketch_png())
        check("id" in photo, "foto dello schizzo: letta con OpenCV")
        loop = [[0.0, 0.0], [1.0, 0.0], [1.0, 0.2], [0.0, 0.2]]
        profile = client.json(
            "POST",
            "/api/profiles",
            {"name": "prova", "loops": [{"points": loop}], "source": {"kind": "editor"}},
        )
        status, _h, dxf = client.call("GET", f"/api/profiles/{profile['id']}/export.dxf")
        check(status == 200 and b"SECTION" in dxf, f"export DXF: {status}")

        second = subprocess.run(argv, env=env, timeout=120, check=False)
        check(second.returncode == 0, f"secondo avvio: esce con {second.returncode}")
        check(process.poll() is None, "secondo avvio: il primo resta acceso")

        status, _h, _ = client.call("POST", "/api/app/quit", b"")
        check(status == 202, f"Esci: {status}")
        code = process.wait(60)
        check(code == 0, f"chiusura: codice {code}")
        check(not lock.exists(), "lock: rimosso")
    except BaseException:
        for log in sorted(log_dir.glob("*.log")):
            print(f"--- {log}\n{log.read_text(encoding='utf-8', errors='replace')[-6000:]}")
        raise
    finally:
        if process.poll() is None:
            process.kill()
    print("tutto a posto")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("uso: smoke.py <eseguibile>")
    main(sys.argv[1])
