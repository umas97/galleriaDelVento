# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The library of 3D models: files on disk, no database (SPEC §6, §14).

One folder per model, named after the first 16 hex digits of the SHA-256 of the
uploaded bytes::

    modelli/<sha256[:16]>/
        originale.stl|obj   the uploaded bytes, untouched (SHA-256 in modello.json)
        modello.json        name, units, scale, base orientation, study type,
                            chosen repairs, reports
        riparata.npz        derived: the repaired mesh in file units
        mesh.bin            derived: repaired + placed, the format of mesh_binary.py
        vista.npz           derived: decimated copy of riparata (only above 500k triangles)
        vista.bin           derived: vista.npz placed
        miniatura.png       captured by the interface

Derived files are regenerated whenever they are missing or of another version
(SPEC §14.2), so deleting them is always safe. Every write goes through
``safety`` (SPEC §2.1).
"""

from __future__ import annotations

import hashlib
import io
import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

from .. import safety
from ..config import get_settings
from ..errors import AppError, NewerSchemaError
from ..geometry import mesh_binary, placement
from ..geometry.mesh_import import (
    UNIT_SCALE,
    MeshReport,
    analyse_with_table,
    load_mesh,
    merge_vertices,
    propose_units,
)
from ..geometry.mesh_repair import RepairOptions, RepairSummary, repair
from .study_types import StudyTypeId

__all__ = ["ModelRecord", "ModelStore", "ModelUpdate", "RealLength", "VIEW_THRESHOLD"]

_log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
#: Above this many triangles the 3D view uses a decimated copy (SPEC §6.6).
VIEW_THRESHOLD = 500_000
#: Triangles of the decimated view mesh.
VIEW_TARGET = 400_000
MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ModelRecord(BaseModel):
    """``modello.json``."""

    schema_version: int = SCHEMA_VERSION
    id: str
    name: str
    original_name: str
    format: Literal["stl", "obj"]
    sha256: str
    size_bytes: int
    imported_at: datetime
    units: Literal["mm", "cm", "m", "in", "custom"]
    units_confirmed: bool = False
    units_proposed: Literal["mm", "cm", "m"]
    placement: placement.Placement
    study_type: StudyTypeId = "generico"
    repairs: RepairOptions = RepairOptions()
    report: MeshReport
    repair_summary: RepairSummary
    repaired_report: MeshReport
    #: Extents along the tunnel axes x, y, z, metres.
    dimensions_m: tuple[float, float, float]
    view: Literal["full", "pending", "ready"] = "full"
    has_thumbnail: bool = False
    #: Set when read from a newer schema: shown, never written.
    read_only: bool = False


class RealLength(BaseModel):
    """«Lunghezza reale»: the true length of one tunnel axis gives the scale."""

    axis: Literal["x", "y", "z"]
    metres: float = Field(gt=0.0, le=1e4)


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    units: Literal["mm", "cm", "m", "in"] | None = None
    real_length: RealLength | None = None
    rotation: list[list[int]] | None = None
    floor: placement.Floor | None = None
    study_type: StudyTypeId | None = None
    repairs: RepairOptions | None = None


class ImportResult(BaseModel):
    status: Literal["created", "exists"]
    model: ModelRecord


def _dimensions(report: MeshReport, place: placement.Placement) -> tuple[float, float, float]:
    ext = placement.rotated_extents(report.extents, place.rotation) * place.scale
    return float(ext[0]), float(ext[1]), float(ext[2])


class ModelStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or get_settings().data_dir / "modelli"
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        #: Bumped whenever the repaired mesh changes, so a stale decimation is dropped.
        self._generation: dict[str, int] = {}
        self._view_jobs: set[str] = set()
        #: Hook for the tests: run background work inline.
        self.run_background: Callable[[Callable[[], None]], None] = self._thread

    # --- plumbing --------------------------------------------------------------

    @staticmethod
    def _thread(work: Callable[[], None]) -> None:
        threading.Thread(target=work, name="model-view", daemon=True).start()

    def _lock(self, model_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(model_id, threading.Lock())

    def folder(self, model_id: str) -> Path:
        if len(model_id) != 16 or any(c not in "0123456789abcdef" for c in model_id):
            raise FileNotFoundError("modello inesistente")
        return self.root / model_id

    def _record_path(self, model_id: str) -> Path:
        return self.folder(model_id) / "modello.json"

    def original_path(self, record: ModelRecord) -> Path:
        return self.folder(record.id) / f"originale.{record.format}"

    # --- reading ---------------------------------------------------------------

    def get(self, model_id: str) -> ModelRecord:
        path = self._record_path(model_id)
        if not path.is_file():
            raise FileNotFoundError("modello inesistente")
        record = ModelRecord.model_validate_json(path.read_bytes())
        if record.schema_version > SCHEMA_VERSION:
            record.read_only = True
        return record

    def list(self) -> list[ModelRecord]:
        if not self.root.is_dir():
            return []
        records = []
        for folder in self.root.iterdir():
            if (folder / "modello.json").is_file():
                try:
                    records.append(self.get(folder.name))
                except (ValueError, FileNotFoundError) as exc:
                    _log.warning("modello illeggibile in %s: %s", folder, exc)
        return sorted(records, key=lambda r: r.imported_at, reverse=True)

    def size_on_disk(self, model_id: str) -> int:
        folder = self.folder(model_id)
        return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())

    # --- writing ---------------------------------------------------------------

    def _save(self, record: ModelRecord) -> None:
        if record.read_only or record.schema_version > SCHEMA_VERSION:
            raise NewerSchemaError(f"modello {record.id}, schema {record.schema_version}")
        payload = record.model_dump(mode="json", exclude={"read_only"})
        safety.atomic_write_json(self._record_path(record.id), payload)

    def import_bytes(self, data: bytes, original_name: str) -> ImportResult:
        """Copy the upload into the library, analyse and repair it (SPEC §6.1-6.3)."""
        sha = hashlib.sha256(data).hexdigest()
        model_id = sha[:16]
        with self._lock(model_id):
            if self._record_path(model_id).is_file():
                return ImportResult(status="exists", model=self.get(model_id))
            raw = load_mesh(data)
            merged = merge_vertices(raw.vertices, raw.faces)
            report, table = analyse_with_table(raw.vertices, raw.faces, merged)
            options = RepairOptions()
            repaired = repair(raw.vertices, raw.faces, options, merged=merged, table=table)
            repaired_report = analyse_with_table(repaired.vertices, repaired.faces)[0]
            proposed = propose_units(max(report.extents))
            place = placement.Placement(scale=UNIT_SCALE[proposed])
            stem = Path(original_name).stem or "modello"
            record = ModelRecord(
                id=model_id,
                name=stem,
                original_name=Path(original_name).name or f"modello.{raw.fmt}",
                format=raw.fmt,
                sha256=sha,
                size_bytes=len(data),
                imported_at=datetime.now(UTC),
                units=proposed,
                units_proposed=proposed,
                placement=place,
                repairs=options,
                report=report,
                repair_summary=repaired.summary,
                repaired_report=repaired_report,
                dimensions_m=_dimensions(report, place),
                view="pending" if len(repaired.faces) > VIEW_THRESHOLD else "full",
            )
            # Build the folder under a temporary name: a crash never leaves half a model.
            folder = self.folder(model_id)
            staging = folder.with_name(f".{model_id}.import")
            safety.remove_tree(staging)
            safety.make_dirs(staging)
            safety.atomic_write_bytes(staging / f"originale.{raw.fmt}", data)
            self._write_repaired(staging, repaired.vertices, repaired.faces)
            self._write_placed(staging, record, repaired.vertices, repaired.faces)
            payload = record.model_dump(mode="json", exclude={"read_only"})
            safety.atomic_write_json(staging / "modello.json", payload)
            safety.assert_writable(folder)
            staging.rename(folder)
            self._generation[model_id] = 0
        _log.info(
            "importato %s (%s, %d triangoli, unità proposte %s)",
            record.name,
            model_id,
            report.triangles,
            proposed,
        )
        if record.view == "pending":
            self._schedule_view(model_id)
        return ImportResult(status="created", model=record)

    def _write_repaired(self, folder: Path, vertices: np.ndarray, faces: np.ndarray) -> None:
        buffer = io.BytesIO()
        np.savez(buffer, vertices=vertices, faces=faces.astype(np.uint32))
        safety.atomic_write_bytes(folder / "riparata.npz", buffer.getvalue())

    def _write_placed(
        self,
        folder: Path,
        record: ModelRecord,
        vertices: np.ndarray,
        faces: np.ndarray,
        name: str = "mesh.bin",
    ) -> None:
        placed = placement.apply(vertices, record.placement)
        safety.atomic_write_bytes(
            folder / name, mesh_binary.encode(placed, faces, {"model_id": record.id})
        )

    def _load_npz(self, path: Path) -> tuple[np.ndarray, np.ndarray] | None:
        try:
            with np.load(path) as data:
                return np.asarray(data["vertices"]), np.asarray(data["faces"], dtype=np.int64)
        except (OSError, KeyError, ValueError):
            return None

    def repaired_mesh(self, record: ModelRecord) -> tuple[np.ndarray, np.ndarray]:
        """The repaired mesh in file units, rebuilt from the original if needed."""
        folder = self.folder(record.id)
        cached = self._load_npz(folder / "riparata.npz")
        if cached is not None:
            return cached
        _log.info("riparata.npz assente o illeggibile per %s: la rigenero", record.id)
        raw = load_mesh(self.original_path(record).read_bytes())
        repaired = repair(raw.vertices, raw.faces, record.repairs)
        if not record.read_only:
            self._write_repaired(folder, repaired.vertices, repaired.faces)
        return repaired.vertices, repaired.faces

    def mesh_bytes(self, model_id: str, view: bool = False) -> bytes:
        """``mesh.bin`` (or ``vista.bin`` when ``view`` and ready), regenerated if stale."""
        with self._lock(model_id):
            record = self.get(model_id)
            folder = self.folder(model_id)
            if view and record.view == "ready":
                data = self._read_if_current(folder / "vista.bin")
                if data is not None:
                    return data
                decimated = self._load_npz(folder / "vista.npz")
                if decimated is not None:
                    placed = placement.apply(decimated[0], record.placement)
                    data = mesh_binary.encode(placed, decimated[1], {"model_id": record.id})
                    if not record.read_only:
                        safety.atomic_write_bytes(folder / "vista.bin", data)
                    return data
            data = self._read_if_current(folder / "mesh.bin")
            if data is not None:
                return data
            vertices, faces = self.repaired_mesh(record)
            placed = placement.apply(vertices, record.placement)
            data = mesh_binary.encode(placed, faces, {"model_id": record.id})
            if not record.read_only:
                safety.atomic_write_bytes(folder / "mesh.bin", data)
            return data

    @staticmethod
    def _read_if_current(path: Path) -> bytes | None:
        if not path.is_file():
            return None
        data = path.read_bytes()
        return data if mesh_binary.read_header(data) is not None else None

    def update(self, model_id: str, change: ModelUpdate) -> ModelRecord:
        with self._lock(model_id):
            record = self.get(model_id)
            if record.read_only:
                raise NewerSchemaError(f"modello {model_id}")
            folder = self.folder(model_id)
            place = record.placement.model_copy(deep=True)
            if change.name is not None:
                record.name = change.name.strip() or record.name
            if change.units is not None:
                record.units = change.units
                place.scale = UNIT_SCALE[change.units]
                record.units_confirmed = True
            if change.rotation is not None:
                place = placement.Placement(
                    scale=place.scale, rotation=change.rotation, floor=place.floor
                )
            if change.real_length is not None:
                axis = "xyz".index(change.real_length.axis)
                extent = placement.rotated_extents(record.report.extents, place.rotation)[axis]
                if extent <= 0:
                    raise AppError(
                        "Il modello non ha estensione lungo quell'asse: scegline un altro",
                        f"axis={change.real_length.axis} extent={extent}",
                    )
                record.units = "custom"
                place.scale = change.real_length.metres / float(extent)
                record.units_confirmed = True
            if change.floor is not None:
                place.floor = change.floor
            if change.study_type is not None:
                record.study_type = change.study_type
            placement_changed = place != record.placement
            record.placement = place
            record.dimensions_m = _dimensions(record.report, place)
            repairs_changed = change.repairs is not None and change.repairs != record.repairs
            if repairs_changed:
                assert change.repairs is not None
                raw = load_mesh(self.original_path(record).read_bytes())
                repaired = repair(raw.vertices, raw.faces, change.repairs)
                record.repairs = change.repairs
                record.repair_summary = repaired.summary
                record.repaired_report = analyse_with_table(repaired.vertices, repaired.faces)[0]
                self._write_repaired(folder, repaired.vertices, repaired.faces)
                self._generation[model_id] = self._generation.get(model_id, 0) + 1
                for name in ("vista.npz", "vista.bin"):
                    safety.remove_file(folder / name)
                record.view = "pending" if len(repaired.faces) > VIEW_THRESHOLD else "full"
                self._write_placed(folder, record, repaired.vertices, repaired.faces)
            elif placement_changed:
                vertices, faces = self.repaired_mesh(record)
                self._write_placed(folder, record, vertices, faces)
                decimated = self._load_npz(folder / "vista.npz")
                if decimated is not None:
                    self._write_placed(folder, record, *decimated, name="vista.bin")
            if placement_changed or repairs_changed:
                # The thumbnail shows the old pose: the interface captures a new one.
                record.has_thumbnail = False
                safety.remove_file(folder / "miniatura.png")
            self._save(record)
        if repairs_changed and record.view == "pending":
            self._schedule_view(model_id)
        _log.info("modello %s aggiornato: %s", model_id, change.model_dump(exclude_none=True))
        return record

    def set_thumbnail(self, model_id: str, png: bytes) -> ModelRecord:
        if not png.startswith(_PNG_SIGNATURE) or len(png) > MAX_THUMBNAIL_BYTES:
            raise AppError("La miniatura non è un PNG valido", f"{len(png)} byte")
        with self._lock(model_id):
            record = self.get(model_id)
            if record.read_only:
                raise NewerSchemaError(f"modello {model_id}")
            safety.atomic_write_bytes(self.folder(model_id) / "miniatura.png", png)
            record.has_thumbnail = True
            self._save(record)
        return record

    def thumbnail_path(self, model_id: str) -> Path:
        path = self.folder(model_id) / "miniatura.png"
        if not path.is_file():
            raise FileNotFoundError("miniatura assente")
        return path

    def delete(self, model_id: str) -> int:
        """Remove the library copy (never the user's file). Returns the bytes freed."""
        with self._lock(model_id):
            self.get(model_id)
            freed = self.size_on_disk(model_id)
            safety.remove_tree(self.folder(model_id))
            self._generation.pop(model_id, None)
        _log.info("modello %s eliminato dalla libreria (%d byte)", model_id, freed)
        return freed

    # --- view mesh ---------------------------------------------------------------

    def ensure_view_job(self, record: ModelRecord) -> None:
        """A view left "pending" by a previous run (closed mid-job) is resumed."""
        if record.view == "pending" and not record.read_only and record.id not in self._view_jobs:
            self._schedule_view(record.id)

    def _schedule_view(self, model_id: str) -> None:
        generation = self._generation.get(model_id, 0)
        self._view_jobs.add(model_id)
        self.run_background(lambda: self._build_view(model_id, generation))

    def _build_view(self, model_id: str, generation: int) -> None:
        try:
            self._build_view_now(model_id, generation)
        finally:
            self._view_jobs.discard(model_id)

    def _build_view_now(self, model_id: str, generation: int) -> None:
        try:
            record = self.get(model_id)
            vertices, faces = self.repaired_mesh(record)
            import fast_simplification  # heavy: only when a big model arrives

            reduction = 1.0 - VIEW_TARGET / max(len(faces), 1)
            points, triangles = fast_simplification.simplify(
                vertices.astype(np.float32), faces.astype(np.int32), target_reduction=reduction
            )
            with self._lock(model_id):
                if self._generation.get(model_id, 0) != generation:
                    return  # the repaired mesh changed meanwhile: a newer job follows
                record = self.get(model_id)
                folder = self.folder(model_id)
                buffer = io.BytesIO()
                np.savez(
                    buffer, vertices=points.astype(np.float64), faces=triangles.astype(np.uint32)
                )
                safety.atomic_write_bytes(folder / "vista.npz", buffer.getvalue())
                self._write_placed(
                    folder,
                    record,
                    points.astype(np.float64),
                    triangles.astype(np.int64),
                    name="vista.bin",
                )
                record.view = "ready"
                self._save(record)
            _log.info("mesh di vista pronta per %s: %d triangoli", model_id, len(triangles))
        except FileNotFoundError:
            return  # deleted meanwhile
        except Exception:  # noqa: BLE001 - the full mesh still works: log and carry on
            _log.exception("mesh di vista non generata per %s", model_id)
