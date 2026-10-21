# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The sketch wizard through the API (SPEC §8, §14.1).

Includes the photo part of test 3: a photo in a read-only folder goes through
import, the four steps, profile and export, and comes out with the same hash
and mtime.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat

import cv2
import numpy as np
import pytest

from apiclient import Api
from gdv.config import get_settings
from synthetic import naca4, on_sheet, sketch_photo


@pytest.fixture
def api(live) -> Api:
    return Api(live.port)


@pytest.fixture(scope="module")
def photo() -> bytes:
    return sketch_photo([(on_sheet(naca4("0012", 200)), True)], 2)[0]


def preview(api: Api, photo_id: str, stage: str, **params):
    body = {"params": params, "stage": stage, "name": "ala"}
    return api.json("POST", f"/api/sketches/{photo_id}/preview", json_body=body)


def test_import_keeps_the_photo_as_it_arrived(api, photo):
    status, info = api.json("POST", "/api/sketches/import?nome=ala.jpg", body=photo)
    assert status == 200
    assert info["id"] == hashlib.sha256(photo).hexdigest()[:16]
    assert info["format"] == "jpg" and info["file_name"] == "ala.jpg"
    folder = get_settings().data_dir / "foto"
    assert (folder / f"{info['id']}.jpg").read_bytes() == photo
    assert (
        json.loads((folder / f"{info['id']}.json").read_text(encoding="utf-8"))["sha256"]
        == info["sha256"]
    )
    # The same bytes again: the same copy, under its first name.
    again = api.json("POST", "/api/sketches/import?nome=altro.jpg", body=photo)[1]
    assert again == info
    assert len(list(folder.iterdir())) == 2


@pytest.mark.parametrize("fmt", [".png", ".webp"])
def test_png_and_webp(api, fmt):
    image = np.full((300, 400, 3), 230, np.uint8)
    cv2.rectangle(image, (100, 100), (300, 200), (20, 20, 20), 4)
    ok, data = cv2.imencode(fmt, image)
    status, info = api.json("POST", f"/api/sketches/import?nome=x{fmt}", body=data.tobytes())
    assert status == 200 and info["format"] == fmt[1:]


def test_heic_and_other_files_get_their_own_message(api):
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 64
    status, body = api.json("POST", "/api/sketches/import?nome=x.heic", body=heic)
    assert status == 415 and "HEIC" in body["detail"]
    status, body = api.json("POST", "/api/sketches/import?nome=x.txt", body=b"hello")
    assert status == 415 and "JPEG, PNG o WebP" in body["detail"]
    damaged = b"\xff\xd8\xff" + b"0" * 99
    status, body = api.json("POST", "/api/sketches/import?nome=x.jpg", body=damaged)
    assert status == 422 and "non si riesce a leggere" in body["detail"]
    assert not (get_settings().data_dir / "foto").exists()


def test_the_limit_is_40_mb_and_says_so(api):
    status, _, raw = api.call(
        "POST",
        "/api/sketches/import?nome=x.jpg",
        body=b"x" * 10,
        headers={"Content-Length": str(41 * 1024 * 1024)},
    )
    assert status == 413
    assert "40 MB" in json.loads(raw)["detail"]


def test_the_four_steps(api, photo):
    photo_id = api.json("POST", "/api/sketches/import?nome=ala.jpg", body=photo)[1]["id"]

    status, sheet = preview(api, photo_id, "sheet")
    assert status == 200
    assert sheet["sheet_found"] and sheet["standard_sheet"]
    assert len(sheet["params"]["corners"]) == 4
    assert sheet["ink"] is None and sheet["regions"] is None

    status, headers, jpeg = api.call("GET", f"/api/sketches/{photo_id}/photo.jpg")
    assert status == 200 and headers["content-type"] == "image/jpeg"
    image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert image.shape[1] == sheet["photo_size"][0]
    corners = ",".join(str(v) for c in sheet["params"]["corners"] for v in c)
    status, _, jpeg = api.call("GET", f"/api/sketches/{photo_id}/sheet.jpg?corners={corners}")
    straight = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert list(straight.shape[1::-1]) == sheet["sheet_size"]
    assert api.call("GET", f"/api/sketches/{photo_id}/sheet.jpg?corners=1,2,3")[0] == 400

    ink = preview(api, photo_id, "ink")[1]
    assert ink["ink"].startswith("data:image/png;base64,")

    outline = preview(api, photo_id, "outline")[1]
    assert len(outline["regions"]) == 1 and outline["regions"][0]["selected"]
    assert outline["draft"] is None and outline["gap"] is None

    no_scale = preview(api, photo_id, "profile")[1]
    assert no_scale["draft"] is None
    status, body = api.json(
        "POST", f"/api/sketches/{photo_id}/draft", json_body={"params": {}, "name": "ala"}
    )
    assert status == 422 and "scala" in body["detail"]

    scaled = preview(api, photo_id, "profile", length_m=0.5)[1]
    assert scaled["size_m"][0] == pytest.approx(0.5)
    assert scaled["draft"]["source"]["kind"] == "photo"


def test_a_profile_from_a_photo_reopens_with_its_settings(api, photo):
    photo_id = api.json("POST", "/api/sketches/import?nome=ala.jpg", body=photo)[1]["id"]
    params = {"length_m": 1.2, "wind_deg": 3.0, "smoothing": 0.001, "threshold": 0.1}
    status, checked = api.json(
        "POST", f"/api/sketches/{photo_id}/draft", json_body={"params": params, "name": "ala"}
    )
    assert status == 200 and checked["report"]["valid"]
    status, profile = api.json("POST", "/api/profiles", json_body=checked["draft"])
    assert status == 200
    source = api.json("GET", f"/api/profiles/{profile['id']}")[1]["profile"]["source"]
    assert source["kind"] == "photo"
    assert source["sha256"] == hashlib.sha256(photo).hexdigest()
    assert source["file_name"] == "ala.jpg"
    assert len(source["params"]["corners"]) == 4  # filled in: the exact sheet
    assert source["params"]["wind_deg"] == 3.0
    # The wizard reopened on these settings gives the same profile.
    again = api.json(
        "POST",
        f"/api/sketches/{source['sha256'][:16]}/draft",
        json_body={"params": source["params"], "name": "ala"},
    )[1]
    assert again["draft"]["loops"] == checked["draft"]["loops"]


def test_bad_ids_are_not_paths(api):
    for bad in ("..%2F..%2Fx", "0123456789ABCDEF", "abc"):
        assert api.json("GET", f"/api/sketches/{bad}")[0] == 404
        assert api.call("GET", f"/api/sketches/{bad}/photo.jpg")[0] == 404


def test_3_photos_never_touch_the_users_files(api, photo, tmp_path):
    """Test 3 (photo part): import, the four steps, profile and export, read-only folder."""
    user_dir = tmp_path / "utente"
    user_dir.mkdir()
    original = user_dir / "schizzo.jpg"
    original.write_bytes(photo)
    os.chmod(original, stat.S_IRUSR)
    os.chmod(user_dir, stat.S_IRUSR | stat.S_IXUSR)
    before = (hashlib.sha256(original.read_bytes()).hexdigest(), original.stat().st_mtime_ns)
    try:
        data = original.read_bytes()
        photo_id = api.json("POST", "/api/sketches/import?nome=schizzo.jpg", body=data)[1]["id"]
        for stage in ("sheet", "ink", "outline", "profile"):
            assert preview(api, photo_id, stage, length_m=1.0)[0] == 200
        api.call("GET", f"/api/sketches/{photo_id}/photo.jpg")
        api.call("GET", f"/api/sketches/{photo_id}/sheet.jpg")
        body = {"params": {"length_m": 1.0}, "name": "schizzo"}
        checked = api.json("POST", f"/api/sketches/{photo_id}/draft", json_body=body)[1]
        pid = api.json("POST", "/api/profiles", json_body=checked["draft"])[1]["id"]
        for fmt in ("svg", "dxf"):
            assert api.call("GET", f"/api/profiles/{pid}/export.{fmt}")[0] == 200
        after = (hashlib.sha256(original.read_bytes()).hexdigest(), original.stat().st_mtime_ns)
        assert after == before
    finally:
        os.chmod(user_dir, stat.S_IRWXU)


def test_opencv_is_not_loaded_at_start_up():
    """SPEC §17: the backend at rest stays light; OpenCV comes with the first photo."""
    import subprocess
    import sys

    code = "import sys; from gdv.server import create_app as c; c(); print('cv2' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
