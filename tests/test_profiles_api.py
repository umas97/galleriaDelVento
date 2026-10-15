# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Profiles and drawings through the API (SPEC §7, §11.5, §14).

Includes the drawing part of test 3: an SVG and a DXF in a read-only folder go
through import, profile, export, and come out with the same hash and mtime.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
from urllib.parse import quote

import numpy as np
import pytest

from apiclient import Api
from gdv.config import get_settings
from synthetic import naca4

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)

SQUARE_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">'
    b'<rect x="10" y="10" width="40" height="20"/></svg>'
)


@pytest.fixture
def api(live) -> Api:
    return Api(live.port)


def draft(points, name="prova", **extra):
    return {
        "name": name,
        "loops": [{"points": [list(map(float, p)) for p in points]}],
        "source": {"kind": "editor"},
        **extra,
    }


def dxf_square() -> bytes:
    import ezdxf

    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    doc.modelspace().add_lwpolyline([(0, 0), (30, 0), (30, 10), (0, 10)], close=True)
    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue().encode()


def test_create_list_get_update_delete(api):
    cw = naca4("0012", 60, 0.5)[::-1]  # clockwise on purpose: the server normalises
    status, created = api.json("POST", "/api/profiles", json_body=draft(cw, "NACA"))
    assert status == 200, created
    pid = created["id"]
    assert created["schema_version"] == 1
    first = np.asarray(created["loops"][0]["points"])
    assert np.allclose(first, cw[::-1])  # reversed to counter-clockwise
    assert (get_settings().data_dir / "profili" / f"{pid}.json").is_file()

    status, rows = api.json("GET", "/api/profiles")
    assert [r["id"] for r in rows] == [pid]
    assert rows[0]["source_kind"] == "editor" and rows[0]["loops"] == 1
    assert rows[0]["size"] == pytest.approx([0.5, 0.06], rel=0.01)

    status, envelope = api.json("GET", f"/api/profiles/{pid}")
    assert envelope["profile"]["name"] == "NACA" and not envelope["read_only"]

    status, updated = api.json(
        "PUT", f"/api/profiles/{pid}", json_body=draft(naca4("0012", 60, 1.0), "NACA lunga")
    )
    assert status == 200
    assert updated["id"] == pid and updated["created_at"] == created["created_at"]
    assert api.json("GET", f"/api/profiles/{pid}")[1]["profile"]["name"] == "NACA lunga"

    status, freed = api.json("DELETE", f"/api/profiles/{pid}")
    assert status == 200 and freed["freed_bytes"] > 0
    assert api.json("GET", "/api/profiles")[1] == []
    assert api.json("GET", f"/api/profiles/{pid}")[0] == 404


def test_an_invalid_profile_is_refused_and_not_written(api):
    bow = [[0, 0], [1, 1], [1, 0], [0, 1]]
    status, body = api.json("POST", "/api/profiles", json_body=draft(bow))
    assert status == 422
    assert body["detail"] == "Il profilo non è valido"
    assert "self_intersection" in body["technical"]
    folder = get_settings().data_dir / "profili"
    assert not folder.exists() or not any(folder.iterdir())


def test_check_proposes_a_repair_without_saving(api):
    bow = [[0, 0], [1, 1], [1, 0], [0, 1]]
    status, result = api.json("POST", "/api/profiles/check", json_body=draft(bow))
    assert status == 200
    assert not result["report"]["valid"]
    assert result["report"]["issues"][0]["code"] == "self_intersection"
    assert result["repaired_report"]["valid"]
    assert len(result["repaired"]["loops"]) == 2
    # The repaired version is what «Salva» then sends.
    status, _ = api.json("POST", "/api/profiles", json_body=result["repaired"])
    assert status == 200
    status, ok = api.json("POST", "/api/profiles/check", json_body=draft(naca4()))
    assert ok["report"]["valid"] and ok["repaired"] is None


def test_thumbnail(api):
    pid = api.json("POST", "/api/profiles", json_body=draft(naca4()))[1]["id"]
    assert api.json("GET", "/api/profiles")[1][0]["has_thumbnail"] is False
    status, _, _ = api.call("PUT", f"/api/profiles/{pid}/thumbnail", body=PNG_1PX)
    assert status == 204
    status, _, data = api.call("GET", f"/api/profiles/{pid}/thumbnail.png")
    assert status == 200 and data == PNG_1PX
    assert api.json("GET", "/api/profiles")[1][0]["has_thumbnail"] is True
    status, _, _ = api.call("PUT", f"/api/profiles/{pid}/thumbnail", body=b"not a png")
    assert status == 400
    # Overwriting the shape drops the old picture.
    api.json("PUT", f"/api/profiles/{pid}", json_body=draft(naca4("2412")))
    assert api.json("GET", "/api/profiles")[1][0]["has_thumbnail"] is False


def test_exports_are_downloads(api):
    pid = api.json("POST", "/api/profiles", json_body=draft(naca4(), "Àla 1/2"))[1]["id"]
    for fmt, magic in (("svg", b"<?xml"), ("dxf", b"  0\nSECTION")):
        status, headers, data = api.call("GET", f"/api/profiles/{pid}/export.{fmt}")
        assert status == 200
        assert headers["content-disposition"].startswith("attachment;")
        assert f"filename*=UTF-8''{quote('Àla 1_2')}.{fmt}" in headers["content-disposition"]
        assert data.startswith(magic)
    # A profile that is not in the library (a live section) exports too.
    status, headers, data = api.call(
        "POST", "/api/profiles/export.dxf", json_body=draft(naca4(), "sezione")
    )
    assert status == 200 and b"LWPOLYLINE" in data


def test_drawing_import_then_draft_then_profile(api):
    status, info = api.json("POST", "/api/drawings/import?nome=quadro.svg", body=SQUARE_SVG)
    assert status == 200, info
    assert info["format"] == "svg" and info["units"] == "mm" and info["loops"] == 1
    assert info["extent"][0] * info["metres_per_unit"] == pytest.approx(0.04)
    sha = hashlib.sha256(SQUARE_SVG).hexdigest()
    assert info["id"] == sha[:16]
    folder = get_settings().data_dir / "disegni"
    assert (folder / f"{info['id']}.svg").read_bytes() == SQUARE_SVG

    body = {"scale": info["metres_per_unit"], "name": "quadro"}
    status, result = api.json("POST", f"/api/drawings/{info['id']}/draft", json_body=body)
    assert status == 200 and result["report"]["valid"]
    source = result["draft"]["source"]
    assert source == {
        "kind": "svg",
        "sha256": sha,
        "file_name": "quadro.svg",
        "scale": info["metres_per_unit"],
        "units": "mm",
    }
    status, profile = api.json("POST", "/api/profiles", json_body=result["draft"])
    assert status == 200
    pts = np.asarray(profile["loops"][0]["points"])
    assert np.ptp(pts, axis=0) == pytest.approx([0.04, 0.02])

    # The same bytes again reuse the copy; a scale of choice works without units.
    status, again = api.json("POST", "/api/drawings/import?nome=altro.svg", body=SQUARE_SVG)
    assert again["id"] == info["id"]
    assert len(list(folder.glob("*.svg"))) == 1


def test_drawing_errors(api):
    status, body = api.json("POST", "/api/drawings/import", body=b"neither svg nor dxf")
    assert status == 422 and body["detail"] == "Il file non è un SVG né un DXF"
    open_only = b'<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0 10,0 10,10"/></svg>'
    status, body = api.json("POST", "/api/drawings/import", body=open_only)
    assert status == 422 and body["detail"] == "Il disegno non contiene contorni chiusi"
    assert api.json("GET", "/api/drawings/../../etc")[0] == 404
    assert api.json("GET", "/api/drawings/0123456789abcdef")[0] == 404


def test_a_profile_from_a_newer_version_is_shown_but_not_overwritten(api):
    pid = api.json("POST", "/api/profiles", json_body=draft(naca4()))[1]["id"]
    path = get_settings().data_dir / "profili" / f"{pid}.json"
    data = json.loads(path.read_text())
    data["schema_version"] = 99
    path.write_text(json.dumps(data))
    before = path.read_bytes()
    assert api.json("GET", "/api/profiles")[1][0]["read_only"] is True
    status, body = api.json("PUT", f"/api/profiles/{pid}", json_body=draft(naca4("2412")))
    assert status == 409 and "più recente" in body["detail"]
    assert path.read_bytes() == before


def test_bad_profile_ids_are_not_paths(api):
    for bad in ("..%2F..%2Fx", "not-a-uuid", "0123456789ABCDEF0123456789ABCDEF"):
        assert api.json("GET", f"/api/profiles/{bad}")[0] == 404


def test_3_drawings_never_touch_the_users_files(api, tmp_path):
    """Test 3 (drawing part): import, profile, export from a read-only folder."""
    user_dir = tmp_path / "utente"
    user_dir.mkdir()
    files = {"quadro.svg": SQUARE_SVG, "pezzo.dxf": dxf_square()}
    for name, data in files.items():
        (user_dir / name).write_bytes(data)
        os.chmod(user_dir / name, stat.S_IRUSR)
    os.chmod(user_dir, stat.S_IRUSR | stat.S_IXUSR)

    def fingerprint():
        return {
            p.name: (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns)
            for p in user_dir.iterdir()
        }

    before = fingerprint()
    try:
        for name in files:
            data = (user_dir / name).read_bytes()
            info = api.json("POST", f"/api/drawings/import?nome={name}", body=data)[1]
            body = {"scale": info["metres_per_unit"], "name": name}
            result = api.json("POST", f"/api/drawings/{info['id']}/draft", json_body=body)[1]
            pid = api.json("POST", "/api/profiles", json_body=result["draft"])[1]["id"]
            api.call("PUT", f"/api/profiles/{pid}/thumbnail", body=PNG_1PX)
            for fmt in ("svg", "dxf"):
                assert api.call("GET", f"/api/profiles/{pid}/export.{fmt}")[0] == 200
        assert fingerprint() == before
    finally:
        os.chmod(user_dir, stat.S_IRWXU)
