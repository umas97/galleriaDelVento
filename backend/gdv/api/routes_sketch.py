# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The photographed sketch (SPEC §8): upload, the four steps' previews, the profile.

The photo is uploaded as the raw body, like models and drawings. Each change
in the wizard asks ``/preview`` for the step being shown; the result carries
the parameters actually used (the sheet's corners once found). ``/draft``
returns the profile checked, ready for ``POST /api/profiles``: the profile is
saved through the same door as every other one.

The photo and the straightened sheet are served as JPEG for the wizard to
draw on; both are made in memory from the untouched copy.
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..errors import AppError
from ..geometry.sketch.params import SketchParams
from ..geometry.sketch.preview import SketchPreview, Stage
from ..library.photos import MAX_PHOTO_BYTES, PhotoStore, SketchInfo
from ..library.profiles import CheckResult, check
from .routes_models import read_limited_body

__all__ = ["router"]

router = APIRouter(prefix="/api/sketches", tags=["sketches"])

_NO_STORE = {"Cache-Control": "no-cache, no-store, must-revalidate"}


def photos(request: Request) -> PhotoStore:
    return request.app.state.photos


class PreviewRequest(BaseModel):
    params: SketchParams
    stage: Stage
    name: str = Field(default="schizzo", min_length=1, max_length=200)


class DraftRequest(BaseModel):
    params: SketchParams
    name: str = Field(min_length=1, max_length=200)


@router.post("/import")
async def import_photo(request: Request, nome: str = Query(default="schizzo.jpg")) -> SketchInfo:
    data = await read_limited_body(request, limit=MAX_PHOTO_BYTES)
    return await run_in_threadpool(photos(request).import_bytes, bytes(data), nome)


@router.get("/{photo_id}")
def get_photo(request: Request, photo_id: str) -> SketchInfo:
    return photos(request).info(photo_id)


@router.get("/{photo_id}/photo.jpg")
def photo_jpeg(request: Request, photo_id: str) -> Response:
    data = photos(request).photo_jpeg(photo_id)
    return Response(data, media_type="image/jpeg", headers=_NO_STORE)


@router.get("/{photo_id}/sheet.jpg")
def sheet_jpeg(request: Request, photo_id: str, corners: str = Query(default="")) -> Response:
    """The straightened sheet; ``corners`` = 8 fractions x,y,... (empty: as found)."""
    params = SketchParams()
    if corners:
        try:
            values = [float(v) for v in corners.split(",")]
        except ValueError as exc:
            raise AppError("Angoli del foglio non validi", corners) from exc
        if len(values) != 8:
            raise AppError("Angoli del foglio non validi", corners)
        params = SketchParams(corners=list(zip(values[::2], values[1::2], strict=True)))
    data = photos(request).sheet_jpeg(photo_id, params)
    return Response(data, media_type="image/jpeg", headers=_NO_STORE)


@router.post("/{photo_id}/preview")
def preview(request: Request, photo_id: str, body: PreviewRequest) -> SketchPreview:
    return photos(request).preview(photo_id, body.params, body.stage, body.name)


@router.post("/{photo_id}/draft")
def draft(request: Request, photo_id: str, body: DraftRequest) -> CheckResult:
    return check(photos(request).draft(photo_id, body.params, body.name))
