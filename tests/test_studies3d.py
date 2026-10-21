# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Studies of the 3D tunnel through the API (SPEC §24.2 #7, Phase 7c).

A 3D result is saved and read back with its corrected coefficients, the
measured Cd and the forces in N; its mean field is normalised and exported as
a 3D ``.vti``; its history CSV has Cs and the blockage among the conditions;
it has no contour; JSON export and import keep it; 3D studies compare with
each other and never with a 2D one; a 2D study written before the 3D tunnel
(no ``dimension``) still reads.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

import studydata as sd
from apiclient import Api
from gdv.config import get_settings
from test_studies import create, read_vtk


@pytest.fixture
def api(live) -> Api:
    return Api(live.port)


def create3d(api: Api, **point_args) -> dict:
    body = sd.parts(study=sd.meta3d(), **sd.point3d(**point_args), miniatura=sd.png())
    status, study = api.json("POST", "/api/studies", body=body)
    assert status == 200, study
    return study


def test_a_3d_study_is_saved_with_its_numbers_and_files(api):
    study = create3d(api, cd=0.5)
    status, envelope = api.json("GET", f"/api/studies/{study['id']}")
    assert status == 200
    point = envelope["study"]["points"][0]
    result = point["result"]
    assert result["dimension"] == "3d"
    plan = result["plan"]
    c = result["coefficients"]
    # Corrected and measured Cd, the factor between them the plan's (SPEC §24.6).
    assert c["cd"]["mean"] == pytest.approx(c["cd_measured"]["mean"] * plan["blockage_correction"])
    # Forces in N from the corrected coefficients: ½ ρ V² A C.
    f = result["forces_real"]
    assert f["unit"] == "N"
    assert f["drag"] == pytest.approx(0.5 * plan["force_per_coefficient"])
    assert f["side"] == pytest.approx(-0.02 * plan["force_per_coefficient"])
    assert sorted(point["views"]) == ["piano", "superficie", "vista"]
    assert [r["name"] for r in result["fields"]] == ["u", "v", "w", "cp"]
    # The list says it is 3D.
    rows = api.json("GET", "/api/studies")[1]
    assert rows[0]["dimension"] == "3d" and rows[0]["cd"] == pytest.approx(0.5)

    # The mean field, normalised and stored (nz, ny, nx).
    folder = get_settings().data_dir / "studi" / study["id"]
    with np.load(folder / "campi.npz") as data:
        nx, ny, nz = plan["nx"], plan["ny"], plan["nz"]
        assert data["u"].shape == (nz, ny, nx) and data["u"].dtype == np.float16
        _, mask = sd.field_sums3d(nx, ny, nz, plan["u_lat"])
        assert (data["solid"] == mask).all()
        x = (nx - 10 + 0.5) / nx
        assert float(data["u"][3, 4, nx - 10]) == pytest.approx(1 + 0.1 * x, rel=2e-3)
        z = (nz - 3 + 0.5) / nz
        assert float(data["w"][nz - 3, 4, 5]) == pytest.approx(0.05 * z, rel=2e-3)
        assert float(data["u"][nz // 2, ny // 2, nx // 4 + 1]) == 0.0  # solid

    # The history has Cs; there is no contour.
    history = api.json("GET", f"/api/studies/{study['id']}/points/0/history")[1]
    assert set(history) == {"step", "cd", "cl", "cs"}
    assert api.call("GET", f"/api/studies/{study['id']}/points/0/contour")[0] == 404
    assert api.call("GET", f"/api/studies/{study['id']}/points/0/contour.csv")[0] == 404
    assert api.call("GET", f"/api/studies/{study['id']}/points/0/fields.bin")[0] == 400


def test_an_unstable_3d_case_keeps_no_numbers(api):
    study = create3d(api, status="unstable")
    result = study["points"][0]["result"]
    assert result["coefficients"]["cd"] is None and result["coefficients"]["cd_measured"] is None
    assert result["forces_real"]["drag"] is None
    assert result["fields"] == []


def test_the_3d_vti_reads_back(api):
    study = create3d(api)
    plan = study["points"][0]["result"]["plan"]
    nx, ny, nz, dx = plan["nx"], plan["ny"], plan["nz"], plan["dx"]
    status, headers, data = api.call("GET", f"/api/studies/{study['id']}/points/0/fields.vti")
    assert status == 200 and ".vti" in headers["content-disposition"]
    head = data[:4000].decode("utf-8", "replace")
    assert "galleria 3D" in head and "Bloccaggio" in head
    root, arrays = read_vtk(data)
    image = root.find("ImageData")
    assert image.get("WholeExtent") == f"0 {nx - 1} 0 {ny - 1} 0 {nz - 1}"
    assert float(image.get("Spacing").split()[2]) == pytest.approx(dx)
    n = nx * ny * nz
    assert arrays["velocita_m_s"].shape == (n, 3) and arrays["solido"].shape == (n,)
    i, j, k = nx - 10, 4, nz - 3
    at = i + nx * (j + ny * k)
    speed = plan["speed"]
    assert arrays["velocita_m_s"][at, 0] == pytest.approx(
        speed * (1 + 0.1 * (i + 0.5) / nx), rel=2e-3
    )
    assert arrays["velocita_m_s"][at, 2] == pytest.approx(speed * 0.05 * (k + 0.5) / nz, rel=2e-3)
    assert arrays["pressione_Pa"][at] == pytest.approx(
        arrays["Cp"][at] * plan["dynamic_pressure"], rel=1e-5
    )


def test_the_3d_history_csv_has_cs_and_the_blockage(api):
    study = create3d(api)
    status, _, data = api.call("GET", f"/api/studies/{study['id']}/points/0/history.csv")
    assert status == 200
    lines = data.decode("utf-8")[1:].splitlines()
    comments = [x for x in lines if x.startswith("#")]
    assert any("Bloccaggio d'area" in x for x in comments)
    assert any("imbardata" in x for x in comments)
    assert any("Forze sul corpo intero (N)" in x for x in comments)
    assert lines[len(comments)] == "passo;tempo_s;Cd;Cl;Cs"


def test_a_3d_study_goes_through_json(api):
    study = create3d(api)
    status, _, data = api.call("GET", f"/api/studies/{study['id']}/export.json")
    assert status == 200
    assert "contour" not in json.loads(data)["points"][0]
    status, copy = api.json("POST", "/api/studies/import", body=data)
    assert status == 200, copy
    a, b = study["points"][0]["result"], copy["points"][0]["result"]
    assert b["dimension"] == "3d" and a["coefficients"] == b["coefficients"]
    h1 = api.json("GET", f"/api/studies/{study['id']}/points/0/history")[1]
    h2 = api.json("GET", f"/api/studies/{copy['id']}/points/0/history")[1]
    assert h1 == h2


def test_3d_studies_compare_with_each_other_not_with_2d(api):
    a = create3d(api, speed=20.0, cd=0.5)
    b = create3d(api, speed=20.0, cd=0.55)
    flat = create(api)
    status, comparison = api.json(
        "POST", "/api/studies/compare", json_body={"ids": [a["id"], b["id"]]}
    )
    assert status == 200
    rows = comparison["rows"]
    assert [r["dimension"] for r in rows] == ["3d", "3d"]
    assert rows[1]["values"]["cs"] == pytest.approx(-0.02)
    assert rows[1]["diff"]["cd"] == pytest.approx(10.0)
    assert rows[1]["reference_area"] == pytest.approx(rows[0]["reference_area"])
    assert comparison["comparable"]
    mixed = api.json("POST", "/api/studies/compare", json_body={"ids": [a["id"], flat["id"]]})[1]
    assert not mixed["comparable"]
    assert any("2D e uno 3D" in r for r in mixed["rows"][1]["reasons"])


def test_the_3d_tunnel_makes_no_series(api):
    spec = {"parameter": "speed", "values": [10.0, 20.0], "state": "running"}
    status, study = api.json("POST", "/api/studies/series", json_body=sd.meta("Serie", spec))
    assert status == 200
    body = sd.parts(**sd.point3d())
    assert api.json("POST", f"/api/studies/{study['id']}/points", body=body)[0] == 400


def test_a_2d_study_written_before_the_3d_tunnel_still_reads(api):
    study = create(api)
    path = get_settings().data_dir / "studi" / study["id"] / "studio.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    for p in raw["points"]:
        del p["result"]["dimension"]
    path.write_text(json.dumps(raw), encoding="utf-8")
    status, envelope = api.json("GET", f"/api/studies/{study['id']}")
    assert status == 200 and envelope["study"]["points"][0]["result"]["dimension"] == "2d"
    rows = api.json("GET", "/api/studies")[1]
    assert rows[0]["dimension"] == "2d"
