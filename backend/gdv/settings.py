# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Persistent settings (SPEC §14.3): ``$XDG_CONFIG_HOME/galleriadelvento/config.json``.

Not to be confused with ``config.py``, which says where things live and how the
process was started (environment, never written). These are the user's
choices, written by the Settings screen one key at a time.

Reading never fails: a missing or unreadable file gives the defaults; an
unknown key is ignored; a value out of range goes back to its default with a
warning in the log. Writing validates the one key through ``_WRITABLE`` and
saves the whole file atomically (``.tmp`` + ``os.replace``, via ``safety``).
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import get_settings
from .errors import AppError
from .physics.fluids import FLUID_RANGES
from .safety import atomic_write_json, make_dirs

__all__ = ["DEFAULTS", "SettingsError", "load", "path", "update"]

_log = logging.getLogger(__name__)

DEFAULTS: dict[str, Any] = {
    "unita_velocita": "m/s",
    "fluido_predefinito": "aria",
    "temperatura_predefinita_c": 20,
    "risoluzione": "normale",
    "mappa_sequenziale": "viridis",
    "mappa_divergente": "coolwarm",
    "csv_separatore": ";",
    "passi_per_frame": "auto",
    "riferimento_in_profondita": "fissa",
}

_lock = threading.Lock()


class SettingsError(AppError):
    """A value the Settings screen should never send: said in Italian, 400."""


def _choice(*allowed: str) -> Callable[[Any, dict[str, Any]], Any]:
    def check(value: Any, _values: dict[str, Any]) -> Any:
        if value not in allowed:
            raise SettingsError(
                f"valore non ammesso: {value!r} (ammessi: {', '.join(allowed)})", str(value)
            )
        return value

    return check


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise SettingsError(f"serve un numero, non {value!r}", str(value))
    return float(value)


def _temperature(value: Any, values: dict[str, Any]) -> Any:
    number = _number(value)
    fluid = values.get("fluido_predefinito", DEFAULTS["fluido_predefinito"])
    lo, hi = FLUID_RANGES.get(fluid, FLUID_RANGES["aria"])
    if not lo <= number <= hi:
        raise SettingsError(
            f"per {fluid} la temperatura va da {lo:g} a {hi:g} °C".replace(".", ","), str(value)
        )
    return int(number) if number.is_integer() else number


def _steps(value: Any, _values: dict[str, Any]) -> Any:
    if value == "auto":
        return value
    number = _number(value)
    if not number.is_integer() or not 1 <= number <= 200:
        raise SettingsError("i passi per frame vanno da 1 a 200, oppure «auto»", str(value))
    return int(number)


#: One validator per key the API may write. A validator returns the value to
#: store or raises SettingsError; it sees the other values (the temperature
#: depends on the fluid).
_WRITABLE: dict[str, Callable[[Any, dict[str, Any]], Any]] = {
    "unita_velocita": _choice("m/s", "km/h"),
    "fluido_predefinito": _choice(*FLUID_RANGES),
    "temperatura_predefinita_c": _temperature,
    "risoluzione": _choice("bozza", "normale", "fine"),
    "mappa_sequenziale": _choice("viridis", "inferno", "cividis"),
    "mappa_divergente": _choice("coolwarm", "RdBu"),
    "csv_separatore": _choice(";", ","),
    "passi_per_frame": _steps,
    "riferimento_in_profondita": _choice("fissa", "sezione"),
}


def path() -> Path:
    return get_settings().config_dir / "config.json"


def _read_file() -> dict[str, Any]:
    file = path()
    if not file.is_file():
        return {}
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        _log.warning("impostazioni illeggibili in %s, uso i valori predefiniti: %s", file, exc)
        return {}
    if not isinstance(raw, dict):
        _log.warning("impostazioni non valide in %s, uso i valori predefiniti", file)
        return {}
    return raw


def _validated(raw: dict[str, Any]) -> dict[str, Any]:
    values = dict(DEFAULTS)
    # The fluid before the temperature: the temperature's range depends on it.
    for key in _WRITABLE:
        if key not in raw:
            continue
        try:
            values[key] = _WRITABLE[key](raw[key], values)
        except SettingsError as exc:
            _log.warning(
                "impostazione %s fuori campo (%r): torno al predefinito %r (%s)",
                key,
                raw[key],
                DEFAULTS[key],
                exc.message,
            )
            values[key] = DEFAULTS[key]
    for key in raw.keys() - _WRITABLE.keys():
        _log.info("impostazione sconosciuta ignorata: %s", key)
    return values


def load() -> dict[str, Any]:
    """Every setting, each one valid."""
    with _lock:
        return _validated(_read_file())


def update(key: str, value: Any) -> dict[str, Any]:
    """Validate and save one key; returns every setting as now saved."""
    if key not in _WRITABLE:
        raise SettingsError(f"impostazione sconosciuta: {key}", key, status=404)
    with _lock:
        values = _validated(_read_file())
        values[key] = _WRITABLE[key](value, values)
        if key == "fluido_predefinito":
            # A temperature valid for air may not be for water: bring it inside.
            lo, hi = FLUID_RANGES[values[key]]
            temp = float(values["temperatura_predefinita_c"])
            clamped = min(hi, max(lo, temp))
            if clamped != temp:
                whole = clamped.is_integer()
                values["temperatura_predefinita_c"] = int(clamped) if whole else clamped
        make_dirs(path().parent)
        atomic_write_json(path(), values)
    _log.info("impostazione %s = %r", key, values[key])
    return values
