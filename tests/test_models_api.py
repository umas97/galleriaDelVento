# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The model library through the API: import, units, orientation, repairs (SPEC §6, §14).

Includes test 7 (repair keeps the original byte for byte, mesh.bin matches the
repaired mesh) and the import part of test 3 (the user's file is never touched).
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import time

import numpy as np
import pytest

from apiclient import Api
from gdv.config import get_settings
from gdv.geometry import mesh_binary, placement
from gdv.geometry.mesh_import import analyse, load_mesh
from gdv.geometry.mesh_repair import RepairOptions, repair
from gdv.library import models as models_module
from synthetic import CUBE_FACES, CUBE_VERTICES, cube_with_hole, stl_binary, subdivided_cube

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)


@pytest.fixture
def api(live) -> Api:
    return Api(live.port)


def model_dir(model_id: str):
    return get_settings().data_dir / "modelli" / model_id


def test_import_creates_the_library_copy(api):
    data = stl_binary(CUBE_VERTICES * 400, CUBE_FACES)
    status, body = api.import_model(data, "cubo grande.stl")
    assert status == 200, body
    assert body["status"] == "created"
    model = body["model"]
    assert model["id"] == hashlib.sha256(data).hexdigest()[:16]
    assert model["name"] == "cubo grande"
    assert model["units_proposed"] == "mm" and not model["units_confirmed"]
    assert model["dimensions_m"] == pytest.approx([0.4, 0.4, 0.4])
    folder = model_dir(model["id"])
    assert (folder / "originale.stl").read_bytes() == data
    assert {p.name for p in folder.iterdir()} >= {"originale.stl", "modello.json", "mesh.bin"}
    status, listed = api.json("GET", "/api/models")
    assert [m["id"] for m in listed] == [model["id"]]


def test_reimporting_the_same_file_proposes_the_existing_one(api):
    data = stl_binary(CUBE_VERTICES, CUBE_FACES)
    first = api.import_model(data, "a.stl")[1]
    status, second = api.import_model(data, "b.stl")
    assert status == 200
    assert second["status"] == "exists"
    assert second["model"]["id"] == first["model"]["id"]
    assert second["model"]["name"] == "a"


def test_an_invalid_file_gets_a_message_and_details(api):
    status, body = api.import_model(b"this is not a mesh at all", "x.stl")
    assert status == 422
    assert body["detail"] == "Il file non sembra un STL/OBJ valido"
    assert body["technical"]
    assert not (get_settings().data_dir / "modelli").exists() or not any(
        (get_settings().data_dir / "modelli").iterdir()
    )


def test_the_upload_limit_is_checked_before_reading(api, monkeypatch):
    status, _, raw = api.call(
        "POST",
        "/api/models/import?nome=x.stl",
        body=b"x" * 10,
        headers={"Content-Length": str(600 * 1024 * 1024)},
    )
    # The server answers without waiting for 600 MB that never come.
    assert status == 413
    assert "500 MB" in json.loads(raw)["detail"]


def test_units_and_real_length(api):
    model = api.import_model(stl_binary(CUBE_VERTICES * [4, 2, 1], CUBE_FACES))[1]["model"]
    assert model["units_proposed"] == "m"
    path = f"/api/models/{model['id']}"
    status, updated = api.json("PATCH", path, json_body={"units": "cm"})
    assert status == 200
    assert updated["units_confirmed"] and updated["units"] == "cm"
    assert updated["dimensions_m"] == pytest.approx([0.04, 0.02, 0.01])
    status, updated = api.json(
        "PATCH", path, json_body={"real_length": {"axis": "x", "metres": 4.35}}
    )
    assert updated["units"] == "custom"
    assert updated["placement"]["scale"] == pytest.approx(4.35 / 4)
    assert updated["dimensions_m"] == pytest.approx([4.35, 2.175, 1.0875])


def test_rotation_floor_and_mesh_bin(api):
    model = api.import_model(stl_binary(CUBE_VERTICES * [4, 2, 1], CUBE_FACES))[1]["model"]
    path = f"/api/models/{model['id']}"
    y_up = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]  # "L'asse alto del file è Y"
    status, updated = api.json(
        "PATCH", path, json_body={"rotation": y_up, "floor": {"enabled": True, "clearance_m": 0.1}}
    )
    assert status == 200, updated
    assert updated["dimensions_m"] == pytest.approx([4, 1, 2])
    status, _, data = api.call("GET", path + "/mesh.bin")
    mesh = mesh_binary.decode(data)
    assert mesh.header["bbox_min"] == pytest.approx([-2, -0.5, 0.1])
    assert mesh.header["bbox_max"] == pytest.approx([2, 0.5, 2.1])


@pytest.mark.parametrize(
    "rotation", [[[1, 0, 0], [0, 1, 0], [0, 0, -1]], [[2, 0, 0], [0, 1, 0], [0, 0, 1]], [[1, 0]]]
)
def test_mirrors_and_garbage_rotations_are_refused(api, rotation):
    model = api.import_model(stl_binary(CUBE_VERTICES, CUBE_FACES))[1]["model"]
    status, body = api.json("PATCH", f"/api/models/{model['id']}", json_body={"rotation": rotation})
    assert status in (400, 422)
    assert body["detail"]


def test_7_repair_closes_the_hole_and_keeps_the_original(api):
    vertices, faces = cube_with_hole(60)
    data = stl_binary(vertices, faces)
    model = api.import_model(data, "bucato.stl")[1]["model"]
    assert model["report"]["holes"] == 1 and not model["report"]["watertight"]
    assert model["repaired_report"]["watertight"]
    assert model["repair_summary"]["holes_filled"] == 1
    folder = model_dir(model["id"])
    assert (folder / "originale.stl").read_bytes() == data
    # mesh.bin read back is the repaired mesh, placed.
    _, _, raw = api.call("GET", f"/api/models/{model['id']}/mesh.bin")
    mesh = mesh_binary.decode(raw)
    loaded = load_mesh(data)
    expected = repair(loaded.vertices, loaded.faces, RepairOptions())
    place = placement.Placement.model_validate(model["placement"])
    np.testing.assert_allclose(
        mesh.vertices, placement.apply(expected.vertices, place).astype(np.float32), atol=1e-7
    )
    np.testing.assert_array_equal(mesh.faces, expected.faces)
    assert analyse(mesh.vertices.astype(np.float64), mesh.faces.astype(np.int64)).watertight


def test_turning_repairs_off_and_on(api):
    model = api.import_model(stl_binary(*cube_with_hole(60)))[1]["model"]
    path = f"/api/models/{model['id']}"
    off = {
        "fill_holes": False,
        "merge_vertices": True,
        "remove_degenerate": True,
        "fix_normals": True,
        "remove_small_components": False,
    }
    status, updated = api.json("PATCH", path, json_body={"repairs": off})
    assert status == 200
    assert not updated["repaired_report"]["watertight"]
    _, _, raw = api.call("GET", path + "/mesh.bin")
    assert len(mesh_binary.decode(raw).faces) == model["report"]["triangles"]


def test_derived_files_are_regenerated(api):
    model = api.import_model(stl_binary(*subdivided_cube(3)))[1]["model"]
    folder = model_dir(model["id"])
    _, _, before = api.call("GET", f"/api/models/{model['id']}/mesh.bin")
    (folder / "mesh.bin").unlink()
    (folder / "riparata.npz").unlink()
    _, _, after = api.call("GET", f"/api/models/{model['id']}/mesh.bin")
    assert after == before
    (folder / "mesh.bin").write_bytes(b'{"format":"gdv-mesh","version":0}'.ljust(2048))
    _, _, again = api.call("GET", f"/api/models/{model['id']}/mesh.bin")
    assert again == before


def test_a_model_from_a_newer_version_is_read_but_never_written(api):
    model = api.import_model(stl_binary(CUBE_VERTICES, CUBE_FACES))[1]["model"]
    record = model_dir(model["id"]) / "modello.json"
    payload = json.loads(record.read_text())
    payload["schema_version"] = 99
    record.write_text(json.dumps(payload))
    before = record.read_bytes()
    status, body = api.json("GET", f"/api/models/{model['id']}")
    assert status == 200 and body["read_only"]
    status, body = api.json("PATCH", f"/api/models/{model['id']}", json_body={"units": "mm"})
    assert status == 409
    assert body["detail"] == "Creato da una versione più recente di galleriaDelVento"
    assert record.read_bytes() == before


def test_thumbnail_and_delete(api):
    model = api.import_model(stl_binary(CUBE_VERTICES, CUBE_FACES))[1]["model"]
    path = f"/api/models/{model['id']}"
    status, body = api.json("PUT", path + "/thumbnail", body=PNG_1PX)
    assert status == 200 and body["has_thumbnail"]
    status, headers, data = api.call("GET", path + "/thumbnail.png")
    assert status == 200 and data == PNG_1PX
    status, body = api.json("PUT", path + "/thumbnail", body=b"GIF89a....")
    assert status == 400
    status, body = api.json("DELETE", path)
    assert status == 200 and body["freed_bytes"] > 0
    assert not model_dir(model["id"]).exists()
    assert api.json("GET", path)[0] == 404


def test_bad_ids_are_not_paths(api):
    for bad in ("..%2F..%2Fetc", "ABCDEF0123456789", "123"):
        assert api.json("GET", f"/api/models/{bad}")[0] == 404


def test_study_types_are_listed(api):
    status, body = api.json("GET", "/api/study-types")
    assert status == 200
    by_id = {t["id"]: t for t in body}
    assert by_id["ala"]["depth_fraction"] == 0.4 and by_id["ala"]["max_blockage"] == 0.05
    assert by_id["edificio_pianta"]["plane"] == "horizontal"
    assert len(by_id) == 6


def test_every_response_carries_the_content_security_policy(api):
    _, headers, _ = api.call("GET", "/api/health")
    csp = headers["content-security-policy"]
    for directive in (
        "default-src 'self'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
    ):
        assert directive in csp


def test_big_models_get_a_decimated_view(api, monkeypatch, live):
    monkeypatch.setattr(models_module, "VIEW_THRESHOLD", 1000)
    monkeypatch.setattr(models_module, "VIEW_TARGET", 500)
    model = api.import_model(stl_binary(*subdivided_cube(20)))[1]["model"]  # 4800 triangles
    assert model["view"] == "pending"
    for _ in range(200):
        status, body = api.json("GET", f"/api/models/{model['id']}")
        if body["view"] == "ready":
            break
        time.sleep(0.02)
    assert body["view"] == "ready"
    _, _, view = api.call("GET", f"/api/models/{model['id']}/vista.bin")
    _, _, full = api.call("GET", f"/api/models/{model['id']}/mesh.bin")
    assert len(mesh_binary.decode(view).faces) < 1000 < len(mesh_binary.decode(full).faces)


def test_3_import_never_touches_the_users_file(api, xdg_home, tmp_path):
    """Test 3 (import part): a read-only folder, a full cycle, same hash and mtime."""
    user_dir = tmp_path / "utente"
    user_dir.mkdir()
    user_file = user_dir / "ala.stl"
    user_file.write_bytes(stl_binary(*cube_with_hole(60)))
    os.chmod(user_file, stat.S_IRUSR)
    os.chmod(user_dir, stat.S_IRUSR | stat.S_IXUSR)
    before = (hashlib.sha256(user_file.read_bytes()).hexdigest(), user_file.stat().st_mtime_ns)
    try:
        model = api.import_model(user_file.read_bytes(), user_file.name)[1]["model"]
        path = f"/api/models/{model['id']}"
        api.json(
            "PATCH", path, json_body={"units": "mm", "rotation": [[0, -1, 0], [1, 0, 0], [0, 0, 1]]}
        )
        api.json("PATCH", path, json_body={"repairs": {"remove_small_components": True}})
        api.call("GET", path + "/mesh.bin")
        api.json("PUT", path + "/thumbnail", body=PNG_1PX)
        after = (hashlib.sha256(user_file.read_bytes()).hexdigest(), user_file.stat().st_mtime_ns)
        assert after == before
        assert sorted(p.name for p in user_dir.iterdir()) == ["ala.stl"]
    finally:
        os.chmod(user_dir, stat.S_IRWXU)
        os.chmod(user_file, stat.S_IRUSR | stat.S_IWUSR)


def test_3_the_guard_refuses_a_path_outside(tmp_path):
    from gdv import safety

    with pytest.raises(safety.UnsafeWriteError):
        safety.atomic_write_bytes(tmp_path / "fuori.bin", b"x")
    assert not (tmp_path / "fuori.bin").exists()


def test_client_errors_reach_the_log(api):
    status, _ = api.json("POST", "/api/log", json_body={"message": "boom", "details": "stack"})
    assert status == 204
