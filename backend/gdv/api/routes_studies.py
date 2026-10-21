# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Studies over HTTP: save, series, list, read, compare, export, report (SPEC §11).

A finished case arrives as the raw body in a small container of named parts
(like the models' uploads, nothing is spooled to a temporary file outside the
program's folders)::

    b"GDV1" · ( u32 name length · name (UTF-8) · u64 data length · data )*

with the parts ``study`` (StudyMeta, JSON; creating a single study only),
``point`` (PointUpload, JSON), ``fields`` (the GPU's sums, see
``studies/fields.py``), one PNG per view (``velocita``, ``cp``, ...) and
``miniatura``. Everything little-endian.

Exports are downloads (``Content-Disposition: attachment``), never files
written outside the program (SPEC §2.1).
"""

from __future__ import annotations

import json
import struct
from typing import Any, Literal

import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, TypeAdapter
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..errors import AppError
from ..studies import export_csv, export_vtk
from ..studies.compare import MAX_COMPARED, Comparison, compare
from ..studies.report import ReportTokens, render_pdf
from ..studies.result import (
    VIEW_NAMES,
    AnyPointUpload,
    SimulationResult3D,
    Study,
    StudyMeta,
    StudySummary,
)
from ..studies.store import PointParts, StudyEnvelope, StudyStore
from ..window import find_browser
from .routes_models import read_limited_body
from .routes_profiles import attachment

__all__ = ["MAX_STUDY_UPLOAD", "parse_parts", "router"]

router = APIRouter(prefix="/api", tags=["studies"])

#: A Fine case: 27 MB of field sums and a few large PNGs.
MAX_STUDY_UPLOAD = 128 * 1024 * 1024
MAGIC = b"GDV1"
_NO_STORE = {"Cache-Control": "no-cache, no-store, must-revalidate"}


def studies(request: Request) -> StudyStore:
    return request.app.state.studies


def tokens(request: Request) -> ReportTokens:
    return request.app.state.report_tokens


def parse_parts(body: bytes) -> dict[str, bytes]:
    if not body.startswith(MAGIC):
        raise AppError("Dati dello studio non riconosciuti", "intestazione assente")
    parts: dict[str, bytes] = {}
    at = len(MAGIC)
    try:
        while at < len(body):
            (n,) = struct.unpack_from("<I", body, at)
            at += 4
            name = body[at : at + n].decode("utf-8")
            at += n
            (size,) = struct.unpack_from("<Q", body, at)
            at += 8
            if at + size > len(body):
                raise ValueError("parte troncata")
            parts[name] = body[at : at + size]
            at += size
    except (struct.error, UnicodeDecodeError, ValueError) as exc:
        raise AppError("Dati dello studio danneggiati", str(exc)) from exc
    return parts


def _json_part(parts: dict[str, bytes], name: str) -> Any:
    if name not in parts:
        raise AppError("Dati dello studio incompleti", f"manca la parte {name}")
    try:
        return json.loads(parts[name])
    except ValueError as exc:
        raise AppError("Dati dello studio danneggiati", f"{name}: {exc}") from exc


_UPLOAD: TypeAdapter[Any] = TypeAdapter(AnyPointUpload)


def _point(parts: dict[str, bytes]) -> PointParts:
    """A 2D or a 3D point (``dimension``; none means 2D)."""
    upload = _UPLOAD.validate_python(_json_part(parts, "point"))
    return PointParts(
        upload=upload,
        fields=parts.get("fields"),
        views={k: v for k, v in parts.items() if k in VIEW_NAMES},
    )


def _download(data: bytes, name: str, fmt: str, media: str) -> Response:
    return Response(data, media_type=media, headers=attachment(name, fmt))


# --- the list and the studies ------------------------------------------------------------


@router.get("/studies")
def list_studies(request: Request) -> list[StudySummary]:
    return studies(request).list()


@router.post("/studies")
async def create_study(request: Request) -> Study:
    """A single study: meta, its one result, the pictures and the thumbnail."""
    parts = parse_parts(bytes(await read_limited_body(request, limit=MAX_STUDY_UPLOAD)))
    meta = StudyMeta.model_validate(_json_part(parts, "study"))
    if meta.series is not None:
        raise AppError("Una serie si crea vuota", "usare /api/studies/series")
    point = _point(parts)
    return await run_in_threadpool(studies(request).create, meta, point, parts.get("miniatura"))


@router.post("/studies/series")
def create_series(request: Request, meta: StudyMeta) -> Study:
    if meta.series is None:
        raise AppError("Manca la descrizione della serie")
    return studies(request).create(meta)


@router.post("/studies/{study_id}/points")
async def add_point(request: Request, study_id: str) -> Study:
    parts = parse_parts(bytes(await read_limited_body(request, limit=MAX_STUDY_UPLOAD)))
    point = _point(parts)
    return await run_in_threadpool(
        studies(request).add_point, study_id, point, parts.get("miniatura")
    )


class FinishRequest(BaseModel):
    state: Literal["done", "stopped"]


@router.post("/studies/{study_id}/finish")
def finish_series(request: Request, study_id: str, body: FinishRequest) -> Study:
    return studies(request).finish(study_id, body.state)


@router.post("/studies/import")
async def import_study(request: Request) -> Study:
    data = bytes(await read_limited_body(request, limit=MAX_STUDY_UPLOAD))
    return await run_in_threadpool(studies(request).import_json, data)


class CompareRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=MAX_COMPARED)


@router.post("/studies/compare")
def compare_studies(request: Request, body: CompareRequest) -> Comparison:
    store = studies(request)
    return compare([store.study(i) for i in body.ids])


@router.get("/studies/{study_id}")
def get_study(request: Request, study_id: str) -> StudyEnvelope:
    return studies(request).get(study_id)


class StudyUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=20_000)


@router.patch("/studies/{study_id}")
def update_study(request: Request, study_id: str, change: StudyUpdate) -> Study:
    return studies(request).update(study_id, change.name, change.notes)


@router.delete("/studies/{study_id}")
def delete_study(request: Request, study_id: str) -> dict[str, Any]:
    return {"freed_bytes": studies(request).delete(study_id)}


@router.get("/studies/{study_id}/thumbnail.png")
def study_thumbnail(request: Request, study_id: str) -> FileResponse:
    return FileResponse(studies(request).thumbnail_path(study_id), headers=_NO_STORE)


# --- a point's data ------------------------------------------------------------------------


@router.get("/studies/{study_id}/points/{k}/views/{name}.png")
def study_view(request: Request, study_id: str, k: int, name: str) -> FileResponse:
    return FileResponse(studies(request).view_path(study_id, k, name), headers=_NO_STORE)


@router.get("/studies/{study_id}/points/{k}/history")
def point_history(request: Request, study_id: str, k: int) -> dict[str, list[float]]:
    return {key: value.tolist() for key, value in studies(request).history(study_id, k).items()}


@router.get("/studies/{study_id}/points/{k}/contour")
def point_contour(request: Request, study_id: str, k: int) -> dict[str, list[Any]]:
    return {key: value.tolist() for key, value in studies(request).contour(study_id, k).items()}


@router.get("/studies/{study_id}/points/{k}/fields.bin")
def point_fields(request: Request, study_id: str, k: int) -> Response:
    """The mean fields in real units, for drawing: a JSON header, float32 arrays, the mask.

    ``u32 header length · header (JSON, padded to 4 bytes) · u, v, cp, vorticity
    (float32, ny × nx, row 0 at the bottom) · solid (uint8)``.
    """
    refs, arrays = studies(request).fields(study_id, k)
    ref = refs[0]
    if isinstance(studies(request).point(study_id, k).result, SimulationResult3D):
        raise AppError("I campi 3D si esportano in VTK", "fields.bin è solo per il 2D")
    header = json.dumps(
        {
            "nx": ref.nx,
            "ny": ref.ny,
            "dx": ref.dx,
            "names": [r.name for r in refs],
            "units": {r.name: r.unit for r in refs},
            "samples": ref.samples,
        }
    ).encode()
    header += b" " * (-len(header) % 4)
    blocks = [struct.pack("<I", len(header)), header]
    for r in refs:
        real = arrays[r.name].astype(np.float32) * np.float32(r.scale)
        blocks.append(real.astype("<f4").tobytes())
    blocks.append(arrays["solid"].astype(np.uint8).tobytes())
    return Response(b"".join(blocks), media_type="application/octet-stream", headers=_NO_STORE)


# --- exports (SPEC §11.5) ----------------------------------------------------------------------

Sep = Literal[";", ","]


def _stem(study: Study, k: int, what: str) -> str:
    return f"{study.name} — {what}" + (f" — punto {k + 1}" if study.kind == "series" else "")


@router.get("/studies/{study_id}/points/{k}/history.csv")
def history_csv(request: Request, study_id: str, k: int, separatore: Sep = ";") -> Response:
    store = studies(request)
    study = store.study(study_id)
    data = export_csv.history_csv(study, k, store.history(study_id, k), separatore)
    return _download(data, _stem(study, k, "storia"), "csv", "text/csv; charset=utf-8")


@router.get("/studies/{study_id}/points/{k}/contour.csv")
def contour_csv(request: Request, study_id: str, k: int, separatore: Sep = ";") -> Response:
    store = studies(request)
    study = store.study(study_id)
    data = export_csv.contour_csv(study, k, store.contour(study_id, k), separatore)
    return _download(data, _stem(study, k, "Cp"), "csv", "text/csv; charset=utf-8")


@router.get("/studies/{study_id}/series.csv")
def series_csv(request: Request, study_id: str, separatore: Sep = ";") -> Response:
    study = studies(request).study(study_id)
    if study.kind != "series" or not study.points:
        raise AppError("Lo studio non è una serie con punti")
    data = export_csv.series_csv(study, separatore)
    return _download(data, f"{study.name} — punti", "csv", "text/csv; charset=utf-8")


@router.get("/studies/{study_id}/points/{k}/fields.vti")
def fields_vti(request: Request, study_id: str, k: int) -> Response:
    store = studies(request)
    study = store.study(study_id)
    refs, arrays = store.fields(study_id, k)
    if isinstance(study.points[k].result, SimulationResult3D):
        data = export_vtk.fields_vti3d(study, k, refs, arrays)  # type: ignore[arg-type]
    else:
        data = export_vtk.fields_vti(study, k, refs, arrays)  # type: ignore[arg-type]
    return _download(data, _stem(study, k, "campi"), "vti", "application/xml")


@router.get("/studies/{study_id}/points/{k}/contour.vtp")
def contour_vtp(request: Request, study_id: str, k: int) -> Response:
    store = studies(request)
    study = store.study(study_id)
    data = export_vtk.contour_vtp(study, k, store.contour(study_id, k))
    return _download(data, _stem(study, k, "contorno"), "vtp", "application/xml")


@router.get("/studies/{study_id}/export.json")
def export_json(request: Request, study_id: str) -> Response:
    store = studies(request)
    payload = store.export_json(study_id)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return _download(data, store.study(study_id).name, "json", "application/json")


# --- the report (SPEC §11.6) ---------------------------------------------------------------------


@router.get("/studies/{study_id}/report.pdf")
async def report_pdf(request: Request, study_id: str) -> Response:
    study = studies(request).study(study_id)
    data = await run_in_threadpool(render_pdf, str(request.base_url), study_id, tokens(request))
    return _download(data, f"{study.name} — report", "pdf", "application/pdf")


class ClaimRequest(BaseModel):
    token: str = Field(max_length=200)


@router.post("/reports/claim")
def claim_report(request: Request, body: ClaimRequest) -> dict[str, str]:
    study_id = tokens(request).claim(body.token)
    if study_id is None:
        raise AppError(
            "Il collegamento di stampa è scaduto", "token sconosciuto o già usato", status=410
        )
    return {"study_id": study_id}


@router.get("/reports/chrome")
def report_chrome() -> dict[str, bool]:
    """Whether a PDF can be made here (else the interface offers «Stampa»)."""
    return {"available": find_browser(get_settings().browser) is not None}
