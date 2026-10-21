# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Studies, series, exports and comparison through the API (SPEC §11, §14).

Tests 27 (saved and read back; a newer file is never written), 29 (VTK read
back with an XML parser, CSV with the conditions on top), 30 (studies at a
different simulated Re are flagged), the study part of test 3 (a full cycle
on files in a read-only folder) and the unstable case of test 26 (no numbers,
no NaN in what is saved).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import stat
import struct
import xml.etree.ElementTree as ET

import numpy as np
import pytest

import studydata as sd
from apiclient import Api
from gdv.config import get_settings
from gdv.studies.store import StudyStore
from synthetic import naca4, stl_binary, subdivided_cube


@pytest.fixture
def api(live) -> Api:
    return Api(live.port)


def create(api: Api, **point_args) -> dict:
    body = sd.parts(study=sd.meta(), **sd.point(**point_args), miniatura=sd.png())
    status, study = api.json("POST", "/api/studies", body=body)
    assert status == 200, study
    return study


def series(api: Api, values, parameter="angle") -> dict:
    spec = {"parameter": parameter, "values": values, "state": "running"}
    status, study = api.json("POST", "/api/studies/series", json_body=sd.meta("Polare", spec))
    assert status == 200, study
    for v in values:
        body = sd.parts(**sd.point(angle=v if parameter == "angle" else 0.0, value=v))
        status, study = api.json("POST", f"/api/studies/{study['id']}/points", body=body)
        assert status == 200, study
    return study


# --- test 27 ------------------------------------------------------------------------------


def test_27_a_study_saved_and_read_back_is_identical(api):
    study = create(api)
    status, envelope = api.json("GET", f"/api/studies/{study['id']}")
    assert status == 200
    assert envelope["study"] == study
    assert not envelope["read_only"] and envelope["has_thumbnail"]
    # From the disk, with a fresh store: the same SimulationResult.
    again = StudyStore().study(study["id"])
    assert again.points[0].result.model_dump(mode="json") == study["points"][0]["result"]
    result = study["points"][0]["result"]
    assert result["status"] == "converged"
    assert result["coefficients"]["cd"]["mean"] == pytest.approx(0.05)
    # Real forces from the plan: F' = ½ ρ V² L C.
    assert result["forces_real"]["drag"] == pytest.approx(
        0.05 * result["plan"]["force_per_coefficient"]
    )
    assert {f["name"] for f in result["fields"]} == {"u", "v", "cp", "vorticity"}
    assert study["points"][0]["views"] == ["velocita", "cp"]


def test_27_a_newer_study_is_shown_and_never_written(api):
    study = create(api)
    path = get_settings().data_dir / "studi" / study["id"] / "studio.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["schema_version"] = 99
    path.write_text(json.dumps(raw))
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    status, envelope = api.json("GET", f"/api/studies/{study['id']}")
    assert status == 200 and envelope["read_only"]
    status, body = api.json("PATCH", f"/api/studies/{study['id']}", json_body={"name": "nuovo"})
    assert status == 409 and "più recente" in body["detail"]
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    _, rows = api.json("GET", "/api/studies")
    assert rows[0]["read_only"]
    # A newer file that does not even parse is still listed, and refused in full.
    raw["points"] = "formato futuro"
    path.write_text(json.dumps(raw))
    _, rows = api.json("GET", "/api/studies")
    assert rows[0]["read_only"] and rows[0]["name"] == study["name"]
    status, body = api.json("GET", f"/api/studies/{study['id']}")
    assert status == 409 and "più recente" in body["detail"]


def test_26_an_unstable_case_keeps_no_numbers_and_no_nan(api):
    study = create(api, status="unstable")
    result = study["points"][0]["result"]
    assert result["status"] == "unstable"
    assert result["coefficients"]["cd"] is None and result["forces_real"]["drag"] is None
    assert result["fields"] == []
    text = (get_settings().data_dir / "studi" / study["id"] / "studio.json").read_text(
        encoding="utf-8"
    )
    assert "NaN" not in text and "Infinity" not in text
    # NaN never gets in: a history with one is refused.
    body = sd.point()
    body["point"]["history"]["cd"][3] = math.nan
    status, _ = api.json("POST", "/api/studies", body=sd.parts(study=sd.meta(), **body))
    assert status in (400, 422)


def test_the_mean_fields_are_normalised_and_scaled(api):
    study = create(api)
    result = study["points"][0]["result"]
    plan = result["plan"]
    nx, ny = plan["nx"], plan["ny"]
    status, headers, data = api.call("GET", f"/api/studies/{study['id']}/points/0/fields.bin")
    assert status == 200
    (n,) = struct.unpack_from("<I", data)
    header = json.loads(data[4 : 4 + n])
    assert (header["nx"], header["ny"], header["names"]) == (nx, ny, ["u", "v", "cp", "vorticity"])
    arrays = np.frombuffer(data, "<f4", count=4 * nx * ny, offset=4 + n).reshape(4, ny, nx)
    solid = np.frombuffer(data, np.uint8, offset=4 + n + 16 * nx * ny).reshape(ny, nx)
    _, mask = sd.field_sums(nx, ny, plan["u_lat"])
    assert (solid == mask).all()
    i, j = nx - 10, 5
    x = (i + 0.5) / nx
    # u = V (1 + 0.1 x/W), real units; float16 storage: 3 significant digits.
    assert arrays[0, j, i] == pytest.approx(plan["speed"] * (1 + 0.1 * x), rel=2e-3)
    assert arrays[1, j, i] == pytest.approx(plan["speed"] * 0.05 * (j + 0.5) / ny, rel=2e-3)
    q = 0.5 * plan["u_lat"] ** 2
    assert arrays[2, j, i] == pytest.approx(0.003 * x / 3 / q, rel=2e-3)
    # ω = ∂v/∂x − ∂u/∂y = −∂u/∂y = 0 here (u depends on x only): v grows with y only.
    assert abs(arrays[3, j, i]) < 1e-3 * plan["speed"] / plan["reference_length"]
    assert (arrays[:, solid == 1] == 0).all()


def test_a_point_with_fields_of_another_grid_is_refused(api):
    body = sd.point()
    body["fields"] = body["fields"][:-1]
    status, answer = api.json("POST", "/api/studies", body=sd.parts(study=sd.meta(), **body))
    assert status == 400 and "griglia" in answer["detail"]


def test_a_series_grows_a_point_at_a_time(api):
    study = series(api, [-4.0, 0.0, 4.0])
    assert study["kind"] == "series" and len(study["points"]) == 3
    assert [p["value"] for p in study["points"]] == [-4.0, 0.0, 4.0]
    folder = get_settings().data_dir / "studi" / study["id"]
    assert (folder / "punti" / "002" / "campi.npz").is_file()
    _, rows = api.json("GET", "/api/studies")
    assert rows[0]["state"] == "running" and rows[0]["points"] == 3
    status, done = api.json(
        "POST", f"/api/studies/{study['id']}/finish", json_body={"state": "done"}
    )
    assert status == 200 and done["series"]["state"] == "done"
    status, _ = api.json(
        "POST", f"/api/studies/{study['id']}/points", body=sd.parts(**sd.point(value=8.0))
    )
    assert status == 409


def test_rename_notes_and_delete(api):
    study = create(api)
    status, changed = api.json(
        "PATCH", f"/api/studies/{study['id']}", json_body={"name": "Rinominato", "notes": "nota"}
    )
    assert status == 200 and (changed["name"], changed["notes"]) == ("Rinominato", "nota")
    status, freed = api.json("DELETE", f"/api/studies/{study['id']}")
    assert status == 200 and freed["freed_bytes"] > 1000
    assert api.json("GET", f"/api/studies/{study['id']}")[0] == 404


def test_json_export_and_import_give_the_same_results(api):
    study = series(api, [0.0, 2.0])
    status, headers, data = api.call("GET", f"/api/studies/{study['id']}/export.json")
    assert status == 200 and "attachment" in headers["content-disposition"]
    status, copy = api.json("POST", "/api/studies/import", body=data)
    assert status == 200, copy
    assert copy["id"] != study["id"] and copy["series"]["state"] == "stopped"
    for a, b in zip(study["points"], copy["points"], strict=True):
        assert a["result"]["coefficients"] == b["result"]["coefficients"]
        assert b["result"]["fields"] == [] and b["views"] == []
    h1 = api.json("GET", f"/api/studies/{study['id']}/points/1/history")[1]
    h2 = api.json("GET", f"/api/studies/{copy['id']}/points/1/history")[1]
    assert h1 == h2
    assert api.json("POST", "/api/studies/import", body=b'{"x": 1}')[0] == 400


# --- test 29 ------------------------------------------------------------------------------


def read_vtk(data: bytes) -> tuple[ET.Element, dict[str, np.ndarray]]:
    """A small VTK XML reader: the header parsed as XML, the appended arrays by offset."""
    start = data.index(b"<AppendedData")
    raw_at = data.index(b"_", start) + 1
    xml = data[:start] + b"</VTKFile>"
    root = ET.fromstring(xml)
    types = {"Float32": "<f4", "UInt8": "u1", "Int8": "i1", "Int64": "<i8"}
    arrays = {}
    for node in root.iter("DataArray"):
        at = raw_at + int(node.get("offset"))
        (size,) = struct.unpack_from("<Q", data, at)
        dtype = np.dtype(types[node.get("type")])
        flat = np.frombuffer(data, dtype, count=size // dtype.itemsize, offset=at + 8)
        components = int(node.get("NumberOfComponents", "1"))
        arrays[node.get("Name")] = flat.reshape(-1, components) if components > 1 else flat
    return root, arrays


def test_29_vti_and_vtp_read_back(api):
    study = create(api)
    result = study["points"][0]["result"]
    plan = result["plan"]
    nx, ny, dx = plan["nx"], plan["ny"], plan["dx"]
    status, headers, data = api.call("GET", f"/api/studies/{study['id']}/points/0/fields.vti")
    assert status == 200 and ".vti" in headers["content-disposition"]
    assert b"Re simulato" in data[:4000]
    root, arrays = read_vtk(data)
    image = root.find("ImageData")
    assert image.get("WholeExtent") == f"0 {nx - 1} 0 {ny - 1} 0 0"
    assert float(image.get("Spacing").split()[0]) == pytest.approx(dx)
    assert arrays["velocita_m_s"].shape == (nx * ny, 3)
    assert arrays["solido"].shape == (nx * ny,)
    i, j = nx - 10, 5
    x = (i + 0.5) / nx
    assert arrays["velocita_m_s"][j * nx + i, 0] == pytest.approx(
        plan["speed"] * (1 + 0.1 * x), rel=2e-3
    )
    assert arrays["pressione_Pa"][j * nx + i] == pytest.approx(
        arrays["Cp"][j * nx + i] * plan["dynamic_pressure"], rel=1e-5
    )
    _, mask = sd.field_sums(nx, ny, plan["u_lat"])
    assert (arrays["solido"].reshape(ny, nx) == mask).all()

    status, _, data = api.call("GET", f"/api/studies/{study['id']}/points/0/contour.vtp")
    assert status == 200
    root, arrays = read_vtk(data)
    piece = root.find("PolyData/Piece")
    assert piece.get("NumberOfPoints") == "6"
    order = np.argsort([0.5, 0.35, 0.25, 0.0, 0.75, 0.65])
    assert arrays["Cp"] == pytest.approx(np.array([1.0, -0.6, -0.3, 0.1, -0.2, -0.4])[order])
    assert arrays["Points"][0, 0] == pytest.approx(120.0 * dx)
    assert list(arrays["connectivity"]) == [0, 1, 2, 3, 4, 5, 0]


def csv_lines(api, path) -> list[str]:
    status, headers, data = api.call("GET", path)
    assert status == 200 and "attachment" in headers["content-disposition"]
    text = data.decode("utf-8")
    assert text.startswith("﻿")
    return text[1:].splitlines()


def test_29_csv_carries_the_conditions(api):
    study = create(api, angle=4.0)
    lines = csv_lines(api, f"/api/studies/{study['id']}/points/0/history.csv")
    comments = [line for line in lines if line.startswith("#")]
    text = "\n".join(comments)
    for needed in ("Re reale", "Re simulato", "Lunghezza di riferimento", "Griglia", "Stato"):
        assert needed in text
    assert "incidenza 4°" in text and "(N/m)" in text
    header = lines[len(comments)]
    assert header == "passo;tempo_s;Cd;Cl;Cm"
    first = lines[len(comments) + 1].split(";")
    assert first[0] == "8" and "," in first[2]
    dotted = csv_lines(api, f"/api/studies/{study['id']}/points/0/history.csv?separatore=,")
    row = dotted[len(comments) + 1].split(",")
    assert len(row) == 5 and "." in row[2]
    cp = csv_lines(api, f"/api/studies/{study['id']}/points/0/contour.csv")
    assert "x_c;s;superficie;Cp" in cp
    assert any(line.endswith(";ventre;-0,2") for line in cp)


def test_series_csv_has_a_row_per_point(api):
    study = series(api, [-2.0, 0.0, 2.0, 4.0])
    lines = csv_lines(api, f"/api/studies/{study['id']}/series.csv")
    body = [line for line in lines if not line.startswith("#")]
    assert body[0].startswith("incidenza_gradi;Re_reale;Re_simulato;stato;Cd;")
    assert len(body) == 5
    assert body[1].split(";")[0] == "-2"
    assert any("Serie di 4 punti" in line for line in lines)


# --- test 30 ------------------------------------------------------------------------------


def test_30_studies_at_another_simulated_reynolds_are_flagged(api):
    # A small, slow body: no partial similarity, the simulated Re follows the speed.
    small = sd.naca_draft(chord=0.01)
    a = create(api, speed=0.2, draft=small)
    b = create(api, speed=0.4, draft=small, cd=0.06)
    c = create(api, speed=0.2, draft=small, cd=0.055)
    status, cmp = api.json("POST", "/api/studies/compare", json_body={"ids": [a["id"], b["id"]]})
    assert status == 200
    assert not cmp["comparable"] and "non sono direttamente confrontabili" in cmp["warning"]
    assert cmp["rows"][1]["reasons"] == ["Re simulato diverso dal primo studio"]
    assert cmp["rows"][1]["diff"]["cd"] == pytest.approx(20.0)
    status, cmp = api.json("POST", "/api/studies/compare", json_body={"ids": [a["id"], c["id"]]})
    assert cmp["comparable"] and cmp["warning"] is None
    assert cmp["rows"][1]["diff"]["cd"] == pytest.approx(10.0)
    too_many = {"ids": [a["id"]] * 5}
    assert api.json("POST", "/api/studies/compare", json_body=too_many)[0] == 422


# --- test 3 (complete) ----------------------------------------------------------------------


def test_3_a_full_cycle_never_touches_the_users_files(api, tmp_path):
    """Import → repair → section → study → every export, on files in a read-only folder."""
    user_dir = tmp_path / "utente"
    user_dir.mkdir()
    model_file = user_dir / "scatola.stl"
    model_file.write_bytes(stl_binary(*subdivided_cube(12)))
    files = [model_file]
    for f in files:
        os.chmod(f, stat.S_IRUSR)
    os.chmod(user_dir, stat.S_IRUSR | stat.S_IXUSR)

    def fingerprint():
        return [(hashlib.sha256(f.read_bytes()).hexdigest(), f.stat().st_mtime_ns) for f in files]

    before = fingerprint()
    try:
        model = api.import_model(model_file.read_bytes(), model_file.name)[1]["model"]
        path = f"/api/models/{model['id']}"
        api.json("PATCH", path, json_body={"units": "m", "repairs": {"fill_holes": True}})
        source = {
            "kind": "section3d",
            "model_id": model["id"],
            "model_name": model["name"],
            "placement": model["placement"],
            "plane": "vertical",
            "depth_m": 0.5,
            "depth_fraction": 0.5,
            "roll_deg": 0.0,
            "tilt_deg": 0.0,
            "repaired": False,
        }
        section = sd.naca_draft("scatola — sezione verticale 50%", source=source)
        status, profile = api.json("POST", "/api/profiles", json_body=section)
        assert status == 200, profile
        body = sd.parts(
            study=sd.meta(profile_id=profile["id"], model_id=model["id"], model_name="scatola"),
            **sd.point(draft=section),
        )
        status, study = api.json("POST", "/api/studies", body=body)
        assert status == 200, study
        sid = study["id"]
        csv = api.call("GET", f"/api/studies/{sid}/points/0/history.csv")[2].decode("utf-8")
        assert "Sezione verticale del modello" in csv and "Sezione 2D" in csv
        for export in (
            "points/0/contour.csv",
            "points/0/fields.vti",
            "points/0/contour.vtp",
            "export.json",
        ):
            assert api.call("GET", f"/api/studies/{sid}/{export}")[0] == 200, export
        assert api.call("GET", f"/api/profiles/{profile['id']}/export.dxf")[0] == 200
        assert fingerprint() == before
        assert sorted(p.name for p in user_dir.iterdir()) == ["scatola.stl"]
    finally:
        os.chmod(user_dir, stat.S_IRWXU)
        for f in files:
            os.chmod(f, stat.S_IRUSR | stat.S_IWUSR)


def test_the_parts_container_is_checked(api):
    assert api.json("POST", "/api/studies", body=b"not a study")[0] == 400
    truncated = sd.parts(study=sd.meta())[:-5]
    assert api.json("POST", "/api/studies", body=truncated)[0] == 400
    assert naca4("0012", 10).shape[1] == 2
