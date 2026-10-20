# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 32: persistent settings (SPEC §14.3), in the module and through the API."""

from __future__ import annotations

import json
import logging

import pytest

from apiclient import Api
from gdv import settings


@pytest.fixture
def api(live) -> Api:
    return Api(live.port)


def write_raw(payload) -> None:
    file = settings.path()
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(payload) if not isinstance(payload, str) else payload, "utf-8")


def test_32_defaults_without_a_file():
    assert settings.load() == settings.DEFAULTS
    assert settings.DEFAULTS["unita_velocita"] == "m/s"
    assert settings.DEFAULTS["csv_separatore"] == ";"


def test_32_out_of_range_values_go_back_to_default_with_a_warning(caplog):
    write_raw(
        {
            "risoluzione": "altissima",
            "passi_per_frame": 500,
            "temperatura_predefinita_c": 90,
            "mappa_sequenziale": "jet",
            "unita_velocita": "km/h",
        }
    )
    with caplog.at_level(logging.WARNING, logger="gdv.settings"):
        values = settings.load()
    assert values["risoluzione"] == "normale"
    assert values["passi_per_frame"] == "auto"
    assert values["temperatura_predefinita_c"] == 20
    assert values["mappa_sequenziale"] == "viridis"
    assert values["unita_velocita"] == "km/h"  # the valid one survives
    warned = " ".join(r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)
    for key in ("risoluzione", "passi_per_frame", "temperatura_predefinita_c", "mappa_sequenziale"):
        assert key in warned


def test_32_unknown_keys_are_ignored():
    write_raw({"tema": "rosa", "csv_separatore": ","})
    values = settings.load()
    assert "tema" not in values
    assert values["csv_separatore"] == ","


def test_32_unreadable_file_gives_the_defaults():
    write_raw("{non è json")
    assert settings.load() == settings.DEFAULTS
    write_raw([1, 2, 3])
    assert settings.load() == settings.DEFAULTS


def test_32_the_temperature_follows_the_fluid():
    settings.update("temperatura_predefinita_c", 45)
    values = settings.update("fluido_predefinito", "acqua")
    assert values["temperatura_predefinita_c"] == 40  # water stops at 40 °C
    with pytest.raises(settings.SettingsError):
        settings.update("temperatura_predefinita_c", 2)
    # The same rule on reading: 2 °C water is out of range.
    write_raw({"fluido_predefinito": "acqua", "temperatura_predefinita_c": 2})
    assert settings.load()["temperatura_predefinita_c"] == 20


def test_32_steps_per_frame():
    assert settings.update("passi_per_frame", 40)["passi_per_frame"] == 40
    assert settings.update("passi_per_frame", "auto")["passi_per_frame"] == "auto"
    for bad in (0, 201, 2.5, "molti", True):
        with pytest.raises(settings.SettingsError):
            settings.update("passi_per_frame", bad)


def test_32_writes_are_atomic_and_complete():
    settings.update("csv_separatore", ",")
    on_disk = json.loads(settings.path().read_text("utf-8"))
    assert on_disk == settings.DEFAULTS | {"csv_separatore": ","}
    assert not settings.path().with_name("config.json.tmp").exists()


def test_32_api_reads_and_writes(api):
    status, body = api.json("GET", "/api/settings")
    assert status == 200
    assert body["values"] == settings.DEFAULTS and body["defaults"] == settings.DEFAULTS
    status, body = api.json("PUT", "/api/settings/mappa_divergente", json_body={"value": "RdBu"})
    assert status == 200 and body["values"]["mappa_divergente"] == "RdBu"
    assert settings.load()["mappa_divergente"] == "RdBu"


def test_32_api_refuses_bad_values_and_unknown_keys(api):
    status, body = api.json("PUT", "/api/settings/risoluzione", json_body={"value": "enorme"})
    assert status == 400 and "non ammesso" in body["detail"]
    status, body = api.json("PUT", "/api/settings/tema", json_body={"value": "scuro"})
    assert status == 404 and "sconosciuta" in body["detail"]
    assert not settings.path().exists()


def test_library_storage(api):
    from gdv.config import get_settings

    studies = get_settings().data_dir / "studi" / "x"
    studies.mkdir(parents=True)
    (studies / "studio.json").write_bytes(b"0" * 1000)
    status, body = api.json("GET", "/api/settings/storage")
    assert status == 200
    parts = {p["folder"]: p for p in body["parts"]}
    assert list(parts) == ["modelli", "profili", "foto", "disegni", "studi"]
    assert parts["studi"]["bytes"] == 1000 and parts["studi"]["files"] == 1
    assert body["total_bytes"] == 1000
