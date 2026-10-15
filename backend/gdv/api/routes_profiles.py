# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""2D profiles: list, create, check, overwrite, delete, export; SVG/DXF drawings.

Every way into the library ends at ``POST /api/profiles`` (or ``PUT`` for
«Salva»), which normalises and validates: an invalid profile gets a 422 and is
not written. ``/check`` returns the same verdict without saving, with a
repaired proposal when invalid, so the interface can show the before and after
and let the user confirm (SPEC §7.1).

Drawings are uploaded as the raw body, like models; the scale is chosen in a
second step (``/draft``), because most SVGs do not say what size they are.

Exports are downloads (``Content-Disposition: attachment``): nothing is written
outside the program's folders (SPEC §2.1).
"""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..geometry.profile import Profile2D, ProfileDraft, normalise
from ..geometry.profile_export import to_dxf, to_svg
from ..library.drawings import MAX_DRAWING_BYTES, DrawingInfo, DrawingStore
from ..library.profiles import CheckResult, ProfileEnvelope, ProfileStore, ProfileSummary, check
from .routes_models import read_limited_body

__all__ = ["router"]

router = APIRouter(prefix="/api", tags=["profiles"])

_NO_STORE = {"Cache-Control": "no-cache, no-store, must-revalidate"}
_MEDIA = {"svg": "image/svg+xml", "dxf": "application/dxf"}


def profiles(request: Request) -> ProfileStore:
    return request.app.state.profiles


def drawings(request: Request) -> DrawingStore:
    return request.app.state.drawings


def attachment(name: str, fmt: str) -> dict[str, str]:
    """A download header that survives accents and odd characters in the name."""
    stem = "".join(c if c.isalnum() or c in " -_." else "_" for c in name).strip() or "profilo"
    ascii_stem = stem.encode("ascii", "replace").decode().replace("?", "_")
    return {
        "Content-Disposition": f'attachment; filename="{ascii_stem}.{fmt}"; '
        f"filename*=UTF-8''{quote(stem)}.{fmt}",
        **_NO_STORE,
    }


def _export(draft: ProfileDraft, fmt: Literal["svg", "dxf"]) -> Response:
    data = to_svg(draft) if fmt == "svg" else to_dxf(draft)
    return Response(data, media_type=_MEDIA[fmt], headers=attachment(draft.name, fmt))


# --- profiles --------------------------------------------------------------------


@router.get("/profiles")
def list_profiles(request: Request) -> list[ProfileSummary]:
    return profiles(request).list()


@router.post("/profiles")
def create_profile(request: Request, draft: ProfileDraft) -> Profile2D:
    return profiles(request).create(draft)


@router.post("/profiles/check")
def check_profile(draft: ProfileDraft, min_area: float = Query(default=0.0, ge=0.0)) -> CheckResult:
    return check(draft, min_area=min_area)


@router.post("/profiles/export.{fmt}")
def export_draft(draft: ProfileDraft, fmt: Literal["svg", "dxf"]) -> Response:
    """Export a profile that is not in the library (a live section)."""
    return _export(normalise(draft), fmt)


@router.get("/profiles/{profile_id}")
def get_profile(request: Request, profile_id: str) -> ProfileEnvelope:
    return profiles(request).get(profile_id)


@router.put("/profiles/{profile_id}")
def update_profile(request: Request, profile_id: str, draft: ProfileDraft) -> Profile2D:
    return profiles(request).update(profile_id, draft)


@router.delete("/profiles/{profile_id}")
def delete_profile(request: Request, profile_id: str) -> dict[str, Any]:
    return {"freed_bytes": profiles(request).delete(profile_id)}


@router.get("/profiles/{profile_id}/export.{fmt}")
def export_profile(request: Request, profile_id: str, fmt: Literal["svg", "dxf"]) -> Response:
    return _export(profiles(request).get(profile_id).profile, fmt)


@router.put("/profiles/{profile_id}/thumbnail", status_code=204)
async def put_profile_thumbnail(request: Request, profile_id: str) -> None:
    data = await read_limited_body(request, limit=4 * 1024 * 1024)
    await run_in_threadpool(profiles(request).set_thumbnail, profile_id, bytes(data))


@router.get("/profiles/{profile_id}/thumbnail.png")
def get_profile_thumbnail(request: Request, profile_id: str) -> FileResponse:
    return FileResponse(profiles(request).thumbnail_path(profile_id), headers=_NO_STORE)


# --- drawings --------------------------------------------------------------------


class DraftRequest(BaseModel):
    scale: float = Field(gt=0.0, le=1e3)
    name: str = Field(min_length=1, max_length=200)


@router.post("/drawings/import")
async def import_drawing(request: Request, nome: str = Query(default="disegno.svg")) -> DrawingInfo:
    data = await read_limited_body(request, limit=MAX_DRAWING_BYTES)
    return await run_in_threadpool(drawings(request).import_bytes, bytes(data), nome)


@router.get("/drawings/{drawing_id}")
def get_drawing(request: Request, drawing_id: str) -> DrawingInfo:
    return drawings(request).info(drawing_id)


@router.post("/drawings/{drawing_id}/draft")
def drawing_draft(request: Request, drawing_id: str, body: DraftRequest) -> CheckResult:
    return drawings(request).draft(drawing_id, body.scale, body.name)
