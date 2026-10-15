# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The library of 2D profiles: one JSON file per profile, no database (SPEC §7.1, §14)::

    profili/<uuid>.json   the Profile2D
    profili/<uuid>.png    thumbnail, drawn by the interface

Every profile is normalised (outer loops CCW, holes CW) and validated before it
is written: the library never holds an invalid profile. A file of a newer
schema is listed and shown, never overwritten (SPEC §14.2).
"""

from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import BaseModel

from .. import safety
from ..config import get_settings
from ..errors import AppError, NewerSchemaError
from ..geometry.profile import (
    SCHEMA_VERSION,
    EditorSource,
    Profile2D,
    ProfileDraft,
    ValidationReport,
    normalise,
    repair,
    validate,
)

__all__ = ["CheckResult", "ProfileEnvelope", "ProfileStore", "ProfileSummary", "check"]

_log = logging.getLogger(__name__)

MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ProfileSummary(BaseModel):
    """One row of the library list (the loops stay on disk)."""

    id: str
    name: str
    source_kind: Literal["section3d", "photo", "svg", "dxf", "editor"]
    #: For sections (also through later edits): the model they were cut from.
    model_id: str | None
    model_name: str | None
    created_at: datetime
    loops: int
    points: int
    #: Extent along x and y, metres.
    size: tuple[float, float]
    has_thumbnail: bool
    read_only: bool


class ProfileEnvelope(BaseModel):
    profile: Profile2D
    read_only: bool
    has_thumbnail: bool


class CheckResult(BaseModel):
    """A draft, normalised, its validation, and a repaired version if it is invalid."""

    draft: ProfileDraft
    report: ValidationReport
    repaired: ProfileDraft | None = None
    repaired_report: ValidationReport | None = None


def check(draft: ProfileDraft, min_area: float = 0.0) -> CheckResult:
    draft = normalise(draft)
    report = validate(draft)
    if report.valid:
        return CheckResult(draft=draft, report=report)
    fixed = normalise(repair(draft, min_area=min_area))
    return CheckResult(draft=draft, report=report, repaired=fixed, repaired_report=validate(fixed))


def _invalid(report: ValidationReport) -> AppError:
    codes = ", ".join(
        f"{i.code}" + (f" (anello {i.loop + 1})" if i.loop is not None else "")
        for i in report.issues
    )
    return AppError("Il profilo non è valido", codes, status=422)


class ProfileStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or get_settings().data_dir / "profili"
        self._lock = threading.Lock()

    def path(self, profile_id: str, suffix: str = ".json") -> Path:
        try:
            canonical = str(uuid.UUID(profile_id))
        except ValueError:
            raise FileNotFoundError("profilo inesistente") from None
        if canonical != profile_id:
            raise FileNotFoundError("profilo inesistente")
        return self.root / f"{profile_id}{suffix}"

    # --- reading ---------------------------------------------------------------

    def get(self, profile_id: str) -> ProfileEnvelope:
        path = self.path(profile_id)
        if not path.is_file():
            raise FileNotFoundError("profilo inesistente")
        profile = Profile2D.model_validate_json(path.read_bytes())
        return ProfileEnvelope(
            profile=profile,
            read_only=profile.schema_version > SCHEMA_VERSION,
            has_thumbnail=self.path(profile_id, ".png").is_file(),
        )

    def list(self) -> list[ProfileSummary]:
        if not self.root.is_dir():
            return []
        rows = []
        for path in self.root.glob("*.json"):
            try:
                rows.append(self._summary(self.get(path.stem)))
            except (ValueError, FileNotFoundError) as exc:
                _log.warning("profilo illeggibile in %s: %s", path, exc)
        return sorted(rows, key=lambda r: r.created_at, reverse=True)

    @staticmethod
    def _summary(envelope: ProfileEnvelope) -> ProfileSummary:
        p = envelope.profile
        allp = np.concatenate([np.asarray(loop.points) for loop in p.loops])
        w, h = allp.max(axis=0) - allp.min(axis=0)
        source = p.source
        origin = source.origin if isinstance(source, EditorSource) else source
        section = origin if origin is not None and origin.kind == "section3d" else None
        return ProfileSummary(
            id=p.id,
            name=p.name,
            source_kind=source.kind,
            model_id=section.model_id if section else None,
            model_name=section.model_name if section else None,
            created_at=p.created_at,
            loops=len(p.loops),
            points=int(len(allp)),
            size=(float(w), float(h)),
            has_thumbnail=envelope.has_thumbnail,
            read_only=envelope.read_only,
        )

    # --- writing ---------------------------------------------------------------

    def _write(self, profile: Profile2D) -> None:
        safety.make_dirs(self.root)
        payload = profile.model_dump(mode="json")
        safety.atomic_write_json(self.path(profile.id), payload)

    def create(self, draft: ProfileDraft) -> Profile2D:
        result = check(draft)
        if not result.report.valid:
            raise _invalid(result.report)
        profile = Profile2D(**result.draft.model_dump())
        with self._lock:
            self._write(profile)
        _log.info(
            "profilo creato: %s (%s, %s, %d anelli)",
            profile.name,
            profile.id,
            profile.source.kind,
            len(profile.loops),
        )
        return profile

    def update(self, profile_id: str, draft: ProfileDraft) -> Profile2D:
        """«Salva»: overwrite, keeping the id and the creation date."""
        result = check(draft)
        if not result.report.valid:
            raise _invalid(result.report)
        with self._lock:
            current = self.get(profile_id)
            if current.read_only:
                raise NewerSchemaError(f"profilo {profile_id}")
            profile = Profile2D(
                **result.draft.model_dump(),
                id=profile_id,
                created_at=current.profile.created_at,
            )
            self._write(profile)
            # The thumbnail shows the old shape: the interface draws a new one.
            safety.remove_file(self.path(profile_id, ".png"))
        _log.info("profilo sovrascritto: %s (%s)", profile.name, profile_id)
        return profile

    def delete(self, profile_id: str) -> int:
        with self._lock:
            self.get(profile_id)
            freed = 0
            for suffix in (".json", ".png"):
                path = self.path(profile_id, suffix)
                if path.is_file():
                    freed += path.stat().st_size
                    safety.remove_file(path)
        _log.info("profilo %s eliminato (%d byte)", profile_id, freed)
        return freed

    def set_thumbnail(self, profile_id: str, png: bytes) -> None:
        if not png.startswith(_PNG_SIGNATURE) or len(png) > MAX_THUMBNAIL_BYTES:
            raise AppError("La miniatura non è un PNG valido", f"{len(png)} byte")
        with self._lock:
            if self.get(profile_id).read_only:
                raise NewerSchemaError(f"profilo {profile_id}")
            safety.atomic_write_bytes(self.path(profile_id, ".png"), png)

    def thumbnail_path(self, profile_id: str) -> Path:
        path = self.path(profile_id, ".png")
        if not path.is_file():
            raise FileNotFoundError("miniatura assente")
        return path
