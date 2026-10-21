# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Studies on disk, one folder each, no database (SPEC §4 decision 6, §11.2, §14.1)::

    studi/<uuid>/studio.json          the Study (its SimulationResults inside)
    studi/<uuid>/storia.npz           a single study's files ...
    studi/<uuid>/campi.npz
    studi/<uuid>/contorno.npz
    studi/<uuid>/viste/<nome>.png     the instantaneous pictures of §11.2
    studi/<uuid>/punti/<k>/...        ... or, for a series, each point's
    studi/<uuid>/miniatura.png

A 3D result (SPEC §24.2 #7) has the same files but the contour; its history
holds Cs instead of Cm and its fields are 3D (``result.py``).

Everything is written atomically through the write guard. A series is created
empty and grows a point at a time, as the GPU finishes them (SPEC §11.3, §13):
``studio.json`` is rewritten after the point's files are in place, so a crash
leaves at worst files no result points at. A file of a newer schema is listed
and shown, never written (SPEC §14.2).
"""

from __future__ import annotations

import io
import json
import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ValidationError

from .. import safety
from ..config import get_settings
from ..errors import AppError, NewerSchemaError
from ..physics.coefficients import Coefficients, Coefficients3D, real_forces, real_forces3d
from . import fields as field_files
from .result import (
    SCHEMA_VERSION,
    VIEW_NAMES,
    ContourCpRef,
    FieldRef,
    FieldRef3D,
    PointUpload,
    PointUpload3D,
    SimulationResult,
    SimulationResult3D,
    Study,
    StudyMeta,
    StudyPoint,
    StudySummary,
    TimeSeriesRef,
)

__all__ = ["PointParts", "StudyEnvelope", "StudyStore"]

_log = logging.getLogger(__name__)

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_VIEW_BYTES = 16 * 1024 * 1024
FIELD_NAMES = ("u", "v", "cp", "vorticity")
FIELD_NAMES_3D = ("u", "v", "w", "cp")
CONTOUR_FLOATS = ("xc", "s", "cp", "x", "y")


@dataclass
class PointParts:
    """A finished case as the interface sends it: the JSON, the field sums, the pictures."""

    upload: PointUpload | PointUpload3D
    fields: bytes | None = None
    views: dict[str, bytes] = field(default_factory=dict)


class StudyEnvelope(BaseModel):
    study: Study
    read_only: bool
    size_bytes: int
    has_thumbnail: bool


def _npz(**arrays: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **arrays)
    return buffer.getvalue()


def _raw_dimension(raw: dict[str, Any]) -> Literal["2d", "3d"]:
    """A study we cannot read in full is 3D if its first result says so."""
    points = raw.get("points") or [{}]
    first = points[0] if isinstance(points[0], dict) else {}
    result = first.get("result") if isinstance(first.get("result"), dict) else {}
    return "3d" if result.get("dimension") == "3d" else "2d"


def _png(data: bytes, what: str) -> bytes:
    if not data.startswith(_PNG_SIGNATURE) or len(data) > MAX_VIEW_BYTES:
        raise AppError("Un’immagine dello studio non è un PNG valido", f"{what}: {len(data)} byte")
    return data


class StudyStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or get_settings().data_dir / "studi"
        self._lock = threading.Lock()

    # --- paths --------------------------------------------------------------------

    def folder(self, study_id: str) -> Path:
        try:
            canonical = str(uuid.UUID(study_id))
        except ValueError:
            raise FileNotFoundError("studio inesistente") from None
        if canonical != study_id:
            raise FileNotFoundError("studio inesistente")
        return self.root / study_id

    @staticmethod
    def point_dir(study: Study, k: int) -> str:
        """Where point ``k``'s files live, relative to the study's folder ('' or 'punti/003/')."""
        return "" if study.kind == "single" else f"punti/{k:03d}/"

    def _file(self, study_id: str, relative: str) -> Path:
        base = self.folder(study_id)
        path = (base / relative).resolve()
        if base.resolve() not in path.parents:
            raise FileNotFoundError("file dello studio inesistente")
        return path

    # --- reading --------------------------------------------------------------------

    def _raw(self, study_id: str) -> dict[str, Any]:
        path = self.folder(study_id) / "studio.json"
        if not path.is_file():
            raise FileNotFoundError("studio inesistente")
        return json.loads(path.read_bytes())

    def get(self, study_id: str) -> StudyEnvelope:
        raw = self._raw(study_id)
        newer = int(raw.get("schema_version", 1)) > SCHEMA_VERSION
        try:
            study = Study.model_validate(raw)
        except ValidationError as exc:
            if newer:
                raise NewerSchemaError(f"studio {study_id}") from exc
            raise
        return StudyEnvelope(
            study=study,
            read_only=newer,
            size_bytes=self.size_on_disk(study_id),
            has_thumbnail=(self.folder(study_id) / "miniatura.png").is_file(),
        )

    def study(self, study_id: str) -> Study:
        return self.get(study_id).study

    def size_on_disk(self, study_id: str) -> int:
        folder = self.folder(study_id)
        return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())

    def list(self) -> list[StudySummary]:
        if not self.root.is_dir():
            return []
        rows = []
        for folder in self.root.iterdir():
            if not (folder / "studio.json").is_file():
                continue
            try:
                rows.append(self._summary(folder.name))
            except (ValueError, FileNotFoundError, AppError) as exc:
                _log.warning("studio illeggibile in %s: %s", folder, exc)
        return sorted(rows, key=lambda r: r.created_at, reverse=True)

    def _summary(self, study_id: str) -> StudySummary:
        try:
            envelope = self.get(study_id)
        except NewerSchemaError:
            # A newer study we cannot read in full: listed by what any version keeps.
            raw = self._raw(study_id)
            return StudySummary(
                id=study_id,
                name=str(raw.get("name", study_id)),
                kind="series" if raw.get("kind") == "series" else "single",
                parameter=None,
                state=None,
                points=len(raw.get("points", [])),
                planned=len(raw.get("points", [])),
                status=None,
                profile_id=None,
                profile_name=str(raw.get("profile_name", "")),
                model_id=None,
                model_name=None,
                dimension=_raw_dimension(raw),
                cd=None,
                cl=None,
                reynolds="",
                created_at=raw.get("created_at", datetime.now(UTC)),
                size_bytes=self.size_on_disk(study_id),
                has_thumbnail=(self.folder(study_id) / "miniatura.png").is_file(),
                read_only=True,
            )
        s = envelope.study
        statuses = [p.result.status for p in s.points]
        if s.kind == "single":
            status = statuses[0] if statuses else None
        elif not statuses:
            status = None
        elif all(x == "converged" for x in statuses):
            status = "converged"
        else:
            status = "provisional"
        first = s.points[0].result if s.points else None
        single = first if s.kind == "single" else None
        return StudySummary(
            dimension=first.dimension if first else "2d",
            id=s.id,
            name=s.name,
            kind=s.kind,
            parameter=s.series.parameter if s.series else None,
            state=s.series.state if s.series else None,
            points=len(s.points),
            planned=len(s.series.values) if s.series else 1,
            status=status,
            profile_id=s.profile_id,
            profile_name=s.profile_name,
            model_id=s.model_id,
            model_name=s.model_name,
            cd=single.coefficients.cd.mean if single and single.coefficients.cd else None,
            cl=single.coefficients.cl.mean if single and single.coefficients.cl else None,
            reynolds=first.plan.texts.reynolds if first else "",
            created_at=s.created_at,
            size_bytes=envelope.size_bytes,
            has_thumbnail=envelope.has_thumbnail,
            read_only=envelope.read_only,
        )

    def point(self, study_id: str, k: int) -> StudyPoint:
        points = self.study(study_id).points
        if not 0 <= k < len(points):
            raise FileNotFoundError("punto dello studio inesistente")
        return points[k]

    def history(self, study_id: str, k: int) -> dict[str, np.ndarray]:
        """``step``, ``cd``, ``cl`` and ``cm`` (2D) or ``cs`` (3D)."""
        result = self.point(study_id, k).result
        names = ("step", "cd", "cl", "cs" if result.dimension == "3d" else "cm")
        with np.load(self._file(study_id, result.history.file)) as data:
            return {name: data[name] for name in names}

    def contour(self, study_id: str, k: int) -> dict[str, np.ndarray]:
        result = self.point(study_id, k).result
        if isinstance(result, SimulationResult3D):
            raise FileNotFoundError("un risultato 3D non ha contorno")
        ref = result.contour_cp
        with np.load(self._file(study_id, ref.file)) as data:
            return {name: data[name] for name in ("xc", "s", "upper", "cp", "x", "y")}

    def fields(
        self, study_id: str, k: int
    ) -> tuple[list[FieldRef] | list[FieldRef3D], dict[str, np.ndarray]]:
        """The field references of point ``k`` and the stored arrays (with ``solid``)."""
        refs = self.point(study_id, k).result.fields
        if not refs:
            raise FileNotFoundError("questo risultato non ha campi medi")
        names = FIELD_NAMES_3D if isinstance(refs[0], FieldRef3D) else FIELD_NAMES
        with np.load(self._file(study_id, refs[0].file)) as data:
            arrays = {name: data[name] for name in (*names, "solid")}
        return refs, arrays

    def view_path(self, study_id: str, k: int, name: str) -> Path:
        study = self.study(study_id)
        point = self.point(study_id, k)
        if name not in point.views:
            raise FileNotFoundError("immagine dello studio inesistente")
        return self._file(study_id, f"{self.point_dir(study, k)}viste/{name}.png")

    def thumbnail_path(self, study_id: str) -> Path:
        path = self.folder(study_id) / "miniatura.png"
        if not path.is_file():
            raise FileNotFoundError("miniatura assente")
        return path

    # --- writing ---------------------------------------------------------------------

    def _save(self, study: Study) -> None:
        folder = safety.make_dirs(self.folder(study.id))
        safety.atomic_write_json(folder / "studio.json", study.model_dump(mode="json"))

    def _writable(self, study_id: str) -> Study:
        envelope = self.get(study_id)
        if envelope.read_only:
            raise NewerSchemaError(f"studio {study_id}")
        return envelope.study

    def _views(self, base: Path, rel: str, parts: PointParts) -> list[str]:
        views: list[str] = []
        for name, data in parts.views.items():
            if name not in VIEW_NAMES:
                raise AppError("Immagine dello studio sconosciuta", name)
            safety.make_dirs(base / f"{rel}viste")
            safety.atomic_write_bytes(base / f"{rel}viste/{name}.png", _png(data, name))
            views.append(name)
        return sorted(views, key=VIEW_NAMES.index)

    def _write_point3d(self, study: Study, k: int, parts: PointParts) -> StudyPoint:
        """Point ``k`` of a 3D result (SPEC §24.2 #7): history, mean field, pictures."""
        up = parts.upload
        assert isinstance(up, PointUpload3D)
        base = self.folder(study.id)
        rel = self.point_dir(study, k)
        safety.make_dirs(base / rel if rel else base)
        unstable = up.status == "unstable"
        c = up.coefficients
        coefficients = (
            Coefficients3D(
                cd=None,
                cl=None,
                cs=None,
                cd_measured=None,
                blockage_correction=c.blockage_correction,
                regime=None,
                change=None,
                averaged_steps=c.averaged_steps,
                rho_inf=c.rho_inf,
            )
            if unstable
            else c
        )
        h = up.history
        safety.atomic_write_bytes(
            base / f"{rel}storia.npz",
            _npz(
                step=np.asarray(h.step, dtype=np.int64),
                cd=np.asarray(h.cd, dtype=np.float32),
                cl=np.asarray(h.cl, dtype=np.float32),
                cs=np.asarray(h.cs, dtype=np.float32),
            ),
        )
        refs: list[FieldRef3D] = []
        if parts.fields is not None and up.mean is not None and not unstable:
            plan = up.plan
            sums, mask = field_files.decode3d(parts.fields, plan.nx, plan.ny, plan.nz)
            arrays = field_files.normalise3d(sums, mask, up.mean.samples, up.mean.rho_inf, plan)
            safety.atomic_write_bytes(base / f"{rel}campi.npz", _npz(**arrays))
            for name, (unit, scale) in field_files.scales3d(plan).items():
                refs.append(
                    FieldRef3D(
                        file=f"{rel}campi.npz",
                        key=name,
                        name=name,  # type: ignore[arg-type]
                        unit=unit,
                        scale=scale,
                        nx=plan.nx,
                        ny=plan.ny,
                        nz=plan.nz,
                        dx=plan.dx,
                        samples=up.mean.samples,
                    )
                )
        result = SimulationResult3D(
            case=up.case,
            plan=up.plan,
            status=up.status,
            coefficients=coefficients,
            forces_real=real_forces3d(coefficients, up.plan),
            history=TimeSeriesRef(file=f"{rel}storia.npz", samples=len(h.step), every=h.every),
            fields=refs,
        )
        return StudyPoint(
            value=None,
            result=result,
            steps=up.steps,
            elapsed_s=up.elapsed_s,
            views=self._views(base, rel, parts),  # type: ignore[arg-type]
        )

    def _write_point(self, study: Study, k: int, parts: PointParts) -> StudyPoint:
        """Write point ``k``'s files and return its StudyPoint (not yet in the study)."""
        if isinstance(parts.upload, PointUpload3D):
            return self._write_point3d(study, k, parts)
        up = parts.upload
        base = self.folder(study.id)
        rel = self.point_dir(study, k)
        safety.make_dirs(base / rel if rel else base)
        unstable = up.status == "unstable"
        c = up.coefficients
        # An unstable case keeps no numbers (SPEC §2.3, §9.5).
        coefficients = (
            Coefficients(
                cd=None,
                cl=None,
                cm=None,
                clcd=None,
                strouhal=None,
                regime=None,
                change=None,
                averaged_steps=c.averaged_steps,
                rho_inf=c.rho_inf,
            )
            if unstable
            else c
        )
        h = up.history
        safety.atomic_write_bytes(
            base / f"{rel}storia.npz",
            _npz(
                step=np.asarray(h.step, dtype=np.int64),
                cd=np.asarray(h.cd, dtype=np.float32),
                cl=np.asarray(h.cl, dtype=np.float32),
                cm=np.asarray(h.cm, dtype=np.float32),
            ),
        )
        ct = up.contour
        safety.atomic_write_bytes(
            base / f"{rel}contorno.npz",
            _npz(
                xc=np.asarray(ct.xc, dtype=np.float32),
                s=np.asarray(ct.s, dtype=np.float32),
                upper=np.asarray(ct.upper, dtype=bool),
                cp=np.asarray(ct.cp, dtype=np.float32),
                x=np.asarray(ct.x, dtype=np.float32),
                y=np.asarray(ct.y, dtype=np.float32),
            ),
        )
        refs: list[FieldRef] = []
        if parts.fields is not None and up.mean is not None and not unstable:
            plan = up.plan
            sums, mask = field_files.decode(parts.fields, plan.nx, plan.ny)
            arrays = field_files.normalise(sums, mask, up.mean.rho_inf, plan)
            safety.atomic_write_bytes(base / f"{rel}campi.npz", _npz(**arrays))
            for name, (unit, scale) in field_files.scales(plan).items():
                refs.append(
                    FieldRef(
                        file=f"{rel}campi.npz",
                        key=name,
                        name=name,  # type: ignore[arg-type]
                        unit=unit,
                        scale=scale,
                        nx=plan.nx,
                        ny=plan.ny,
                        dx=plan.dx,
                        samples=up.mean.samples,
                    )
                )
        result = SimulationResult(
            case=up.case,
            plan=up.plan,
            status=up.status,
            coefficients=coefficients,
            forces_real=real_forces(coefficients, up.plan),
            history=TimeSeriesRef(file=f"{rel}storia.npz", samples=len(h.step), every=h.every),
            fields=refs,
            contour_cp=ContourCpRef(file=f"{rel}contorno.npz", points=len(ct.xc), chord=ct.chord),
        )
        return StudyPoint(
            value=up.value,
            result=result,
            steps=up.steps,
            elapsed_s=up.elapsed_s,
            views=self._views(base, rel, parts),  # type: ignore[arg-type]
        )

    def create(
        self, meta: StudyMeta, point: PointParts | None = None, thumbnail: bytes | None = None
    ) -> Study:
        """A single study (with its one point) or an empty series."""
        if meta.series is None and point is None:
            raise AppError("Uno studio singolo richiede un risultato", "nessun punto")
        if meta.series is not None and point is not None and point.upload.dimension == "3d":
            raise AppError("La galleria 3D non fa serie", "studio 3D con serie")
        now = datetime.now(UTC)
        series = meta.series.model_copy(update={"state": "running"}) if meta.series else None
        study = Study(
            id=str(uuid.uuid4()),
            name=meta.name.strip(),
            notes=meta.notes,
            kind="series" if series else "single",
            series=series,
            profile_id=meta.profile_id,
            profile_name=meta.profile_name,
            model_id=meta.model_id,
            model_name=meta.model_name,
            points=[],
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            safety.make_dirs(self.folder(study.id))
            if point is not None:
                study.points.append(self._write_point(study, 0, point))
            if thumbnail:
                safety.atomic_write_bytes(
                    self.folder(study.id) / "miniatura.png", _png(thumbnail, "miniatura")
                )
            self._save(study)
        _log.info(
            "studio creato: «%s» (%s, %s, %d punti)",
            study.name,
            study.id,
            study.kind,
            len(study.points),
        )
        return study

    def add_point(self, study_id: str, point: PointParts, thumbnail: bytes | None = None) -> Study:
        with self._lock:
            study = self._writable(study_id)
            if study.kind != "series" or study.series is None:
                raise AppError("Solo una serie riceve nuovi punti", f"studio {study.kind}")
            if point.upload.dimension == "3d":
                raise AppError("La galleria 3D non fa serie", "punto 3D in una serie")
            if study.series.state != "running":
                raise AppError("La serie è già conclusa", study.series.state, status=409)
            k = len(study.points)
            study.points.append(self._write_point(study, k, point))
            study.updated_at = datetime.now(UTC)
            if thumbnail and not (self.folder(study_id) / "miniatura.png").is_file():
                safety.atomic_write_bytes(
                    self.folder(study_id) / "miniatura.png", _png(thumbnail, "miniatura")
                )
            self._save(study)
        status = point.upload.status
        _log.info(
            "serie %s: punto %d (%s = %s) %s",
            study_id,
            k + 1,
            study.series.parameter,
            point.upload.value,
            status,
        )
        return study

    def finish(self, study_id: str, state: Literal["done", "stopped"]) -> Study:
        with self._lock:
            study = self._writable(study_id)
            if study.series is None:
                raise AppError("Solo una serie si conclude", study.kind)
            study.series.state = state
            study.updated_at = datetime.now(UTC)
            self._save(study)
        statuses = [p.result.status for p in study.points]
        _log.info(
            "serie %s %s: %d punti su %d in %.0f s (%d convergenti, %d provvisori, %d instabili)",
            study_id,
            "conclusa" if state == "done" else "fermata",
            len(study.points),
            len(study.series.values),
            sum(p.elapsed_s for p in study.points),
            statuses.count("converged"),
            statuses.count("provisional"),
            statuses.count("unstable"),
        )
        return study

    def update(self, study_id: str, name: str | None, notes: str | None) -> Study:
        with self._lock:
            study = self._writable(study_id)
            if name is not None:
                if not name.strip():
                    raise AppError("Il nome non può essere vuoto")
                study.name = name.strip()
            if notes is not None:
                study.notes = notes
            study.updated_at = datetime.now(UTC)
            self._save(study)
        return study

    def set_thumbnail(self, study_id: str, png: bytes) -> None:
        with self._lock:
            self._writable(study_id)
            target = self.folder(study_id) / "miniatura.png"
            safety.atomic_write_bytes(target, _png(png, "miniatura"))

    def delete(self, study_id: str) -> int:
        with self._lock:
            folder = self.folder(study_id)
            if not (folder / "studio.json").is_file():
                raise FileNotFoundError("studio inesistente")
            freed = self.size_on_disk(study_id)
            safety.remove_tree(folder)
        _log.info("studio %s eliminato (%d byte)", study_id, freed)
        return freed

    # --- JSON, to reopen or compare elsewhere (SPEC §11.5) -------------------------------

    EXPORT_FORMAT = "galleriadelvento-studio"

    def export_json(self, study_id: str) -> dict[str, Any]:
        """The whole study without the fields: results, histories, Cp along the contour."""
        study = self.study(study_id)
        points = []
        for k, point in enumerate(study.points):
            h = self.history(study_id, k)
            data: dict[str, Any] = {"history": {key: value.tolist() for key, value in h.items()}}
            if point.result.dimension == "2d":
                c = self.contour(study_id, k)
                data["contour"] = {key: value.tolist() for key, value in c.items()}
            points.append(data)
        return {
            "formato": self.EXPORT_FORMAT,
            "versione": SCHEMA_VERSION,
            "study": study.model_dump(mode="json"),
            "points": points,
        }

    def import_json(self, data: bytes) -> Study:
        try:
            payload = json.loads(data)
        except (ValueError, UnicodeDecodeError) as exc:
            raise AppError("Il file non è uno studio di galleriaDelVento", str(exc)) from exc
        if not isinstance(payload, dict) or payload.get("formato") != self.EXPORT_FORMAT:
            raise AppError("Il file non è uno studio di galleriaDelVento", "formato assente")
        if int(payload.get("versione", 0)) > SCHEMA_VERSION:
            raise NewerSchemaError("studio importato")
        source = Study.model_validate(payload["study"])
        extra = payload.get("points", [])
        if len(extra) != len(source.points):
            raise AppError("Lo studio è incompleto", "punti e dati non corrispondono")
        study = source.model_copy(
            update={"id": str(uuid.uuid4()), "points": [], "updated_at": datetime.now(UTC)}
        )
        if study.series is not None and study.series.state == "running":
            study.series.state = "stopped"
        with self._lock:
            base = safety.make_dirs(self.folder(study.id))
            for k, (point, data_k) in enumerate(zip(source.points, extra, strict=True)):
                rel = self.point_dir(study, k)
                safety.make_dirs(base / rel if rel else base)
                h = data_k["history"]
                three = isinstance(point.result, SimulationResult3D)
                names = ("cd", "cl", "cs") if three else ("cd", "cl", "cm")
                safety.atomic_write_bytes(
                    base / f"{rel}storia.npz",
                    _npz(
                        step=np.asarray(h["step"], dtype=np.int64),
                        **{n: np.asarray(h[n], dtype=np.float32) for n in names},
                    ),
                )
                if three:
                    result3d = point.result.model_copy(
                        update={
                            "fields": [],
                            "history": point.result.history.model_copy(
                                update={"file": f"{rel}storia.npz"}
                            ),
                        }
                    )
                    study.points.append(point.model_copy(update={"result": result3d, "views": []}))
                    continue
                c = data_k["contour"]
                safety.atomic_write_bytes(
                    base / f"{rel}contorno.npz",
                    _npz(
                        upper=np.asarray(c["upper"], dtype=bool),
                        **{n: np.asarray(c[n], dtype=np.float32) for n in CONTOUR_FLOATS},
                    ),
                )
                result = point.result.model_copy(
                    update={
                        "fields": [],
                        "history": point.result.history.model_copy(
                            update={"file": f"{rel}storia.npz"}
                        ),
                        "contour_cp": point.result.contour_cp.model_copy(
                            update={"file": f"{rel}contorno.npz"}
                        ),
                    }
                )
                study.points.append(point.model_copy(update={"result": result, "views": []}))
            self._save(study)
        _log.info("studio importato: «%s» (%s)", study.name, study.id)
        return study
