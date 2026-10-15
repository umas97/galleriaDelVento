# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""3D models: import, list, detail, update (units, orientation, repairs), binary mesh.

The upload is the raw request body (``application/octet-stream``) with the file
name in the query string: the backend receives *bytes*, never a path, so the
user's original is out of reach by construction (SPEC §2.1). The 500 MB limit is
enforced from ``Content-Length`` before reading, and again while streaming for a
body that does not declare its length (SPEC §13).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool

from ..errors import AppError
from ..geometry.mesh_import import MAX_UPLOAD_BYTES
from ..library.models import ImportResult, ModelRecord, ModelStore, ModelUpdate
from ..library.study_types import STUDY_TYPES, StudyTypePreset

__all__ = ["read_limited_body", "router"]

router = APIRouter(prefix="/api", tags=["models"])

_NO_STORE = {"Cache-Control": "no-cache, no-store, must-revalidate"}


def too_big(size: int) -> AppError:
    mb = MAX_UPLOAD_BYTES // (1024 * 1024)
    return AppError(
        f"Il file supera il limite di {mb} MB",
        f"{size} byte, limite {MAX_UPLOAD_BYTES}",
        status=413,
    )


async def read_limited_body(request: Request, limit: int = MAX_UPLOAD_BYTES) -> bytearray:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise too_big(int(declared))
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise too_big(len(body))
    if not body:
        raise AppError("Il file è vuoto", "corpo della richiesta vuoto")
    return body


def store_of(request: Request) -> ModelStore:
    return request.app.state.models


@router.get("/study-types")
def study_types() -> list[StudyTypePreset]:
    return list(STUDY_TYPES.values())


@router.get("/models")
def list_models(request: Request) -> list[ModelRecord]:
    return store_of(request).list()


@router.post("/models/import")
async def import_model(request: Request, nome: str = Query(default="modello.stl")) -> ImportResult:
    data = await read_limited_body(request)
    return await run_in_threadpool(store_of(request).import_bytes, data, nome)


@router.get("/models/{model_id}")
def get_model(request: Request, model_id: str) -> ModelRecord:
    store = store_of(request)
    record = store.get(model_id)
    store.ensure_view_job(record)
    return record


@router.patch("/models/{model_id}")
def update_model(request: Request, model_id: str, change: ModelUpdate) -> ModelRecord:
    return store_of(request).update(model_id, change)


@router.delete("/models/{model_id}")
def delete_model(request: Request, model_id: str) -> dict[str, Any]:
    return {"freed_bytes": store_of(request).delete(model_id)}


@router.get("/models/{model_id}/mesh.bin")
def mesh_bin(request: Request, model_id: str) -> Response:
    data = store_of(request).mesh_bytes(model_id)
    return Response(bytes(data), media_type="application/octet-stream", headers=_NO_STORE)


@router.get("/models/{model_id}/vista.bin")
def view_bin(request: Request, model_id: str) -> Response:
    """The decimated view mesh when ready, the full mesh until then."""
    data = store_of(request).mesh_bytes(model_id, view=True)
    return Response(bytes(data), media_type="application/octet-stream", headers=_NO_STORE)


@router.put("/models/{model_id}/thumbnail")
async def put_thumbnail(request: Request, model_id: str) -> ModelRecord:
    data = await read_limited_body(request, limit=8 * 1024 * 1024)
    return await run_in_threadpool(store_of(request).set_thumbnail, model_id, bytes(data))


@router.get("/models/{model_id}/thumbnail.png")
def get_thumbnail(request: Request, model_id: str) -> FileResponse:
    return FileResponse(store_of(request).thumbnail_path(model_id), headers=_NO_STORE)
