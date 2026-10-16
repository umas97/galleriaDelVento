# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Photos of hand sketches, kept as they arrived (SPEC §2.1, §8.1, §14.1)::

    foto/<sha256[:16]>.jpg|png|webp   the uploaded bytes, untouched
    foto/<sha256[:16]>.json           original name, format and SHA-256

The wizard works on a reduced copy made in memory (``geometry/sketch``); the
copy on disk is never modified. A profile made from a photo records its
SHA-256 and every setting of the four steps, so the wizard can be reopened
on it. Re-importing the same bytes reuses the copy.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel

from .. import safety
from ..config import get_settings
from ..errors import AppError
from ..geometry.profile import ProfileDraft
from ..geometry.sketch.params import SketchParams
from ..geometry.sketch.preview import SketchPreview, Stage

if TYPE_CHECKING:  # OpenCV is loaded only when a photo is first processed
    from ..geometry.sketch.pipeline import SketchPipeline

__all__ = ["MAX_PHOTO_BYTES", "PhotoStore", "SketchInfo", "sniff_photo"]

_log = logging.getLogger(__name__)

#: A phone photo is a few MB; 40 MB leaves room for a large PNG (SPEC §8.1).
MAX_PHOTO_BYTES = 40 * 1024 * 1024

PhotoFormat = Literal["jpg", "png", "webp"]
#: ISO-BMFF brands of HEIC/HEIF photos (iPhone): not supported (SPEC §22).
_HEIF_BRANDS = (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"hevc")


class SketchInfo(BaseModel):
    id: str
    file_name: str
    format: PhotoFormat
    sha256: str


def sniff_photo(data: bytes) -> PhotoFormat:
    """The photo's format from its first bytes; a dedicated message for HEIC."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS:
        raise AppError(
            "Le foto HEIC non sono supportate: salvala o esportala in JPEG dal telefono",
            f"marca {data[8:12].decode('latin-1')}",
            status=415,
        )
    raise AppError(
        "Il file non è una foto JPEG, PNG o WebP", "contenuto non riconosciuto", status=415
    )


class PhotoStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or get_settings().data_dir / "foto"
        self._lock = threading.Lock()
        self._pipeline: SketchPipeline | None = None

    @property
    def pipeline(self) -> SketchPipeline:
        if self._pipeline is None:
            from ..geometry.sketch.pipeline import SketchPipeline

            self._pipeline = SketchPipeline(self._bytes)
        return self._pipeline

    def _meta_path(self, photo_id: str) -> Path:
        if len(photo_id) != 16 or any(c not in "0123456789abcdef" for c in photo_id):
            raise FileNotFoundError("foto inesistente")
        return self.root / f"{photo_id}.json"

    def info(self, photo_id: str) -> SketchInfo:
        meta = self._meta_path(photo_id)
        if not meta.is_file():
            raise FileNotFoundError("foto inesistente")
        return SketchInfo.model_validate_json(meta.read_text(encoding="utf-8"))

    def _bytes(self, photo_id: str) -> bytes:
        info = self.info(photo_id)
        return (self.root / f"{photo_id}.{info.format}").read_bytes()

    def import_bytes(self, data: bytes, file_name: str) -> SketchInfo:
        kind = sniff_photo(data)
        from ..geometry.sketch.paper import decode

        decode(data)  # refuses a damaged file before anything is written
        sha = hashlib.sha256(data).hexdigest()
        info = SketchInfo(id=sha[:16], file_name=Path(file_name).name, format=kind, sha256=sha)
        meta = self._meta_path(info.id)
        with self._lock:
            if not meta.is_file():
                safety.make_dirs(self.root)
                safety.atomic_write_bytes(self.root / f"{info.id}.{kind}", data)
                safety.atomic_write_json(meta, json.loads(info.model_dump_json()))
            else:
                info = self.info(info.id)
        _log.info("foto importata: %s (%s, %d byte)", file_name, kind, len(data))
        return info

    # --- the wizard --------------------------------------------------------------------

    def preview(
        self, photo_id: str, params: SketchParams, stage: Stage, name: str = "schizzo"
    ) -> SketchPreview:
        info = self.info(photo_id)
        return self.pipeline.process(
            photo_id, params, stage, name=name, sha256=info.sha256, file_name=info.file_name
        )

    def draft(self, photo_id: str, params: SketchParams, name: str) -> ProfileDraft:
        info = self.info(photo_id)
        return self.pipeline.draft(
            photo_id, params, name=name, sha256=info.sha256, file_name=info.file_name
        )

    def photo_jpeg(self, photo_id: str) -> bytes:
        self.info(photo_id)
        return self.pipeline.photo_jpeg(photo_id)

    def sheet_jpeg(self, photo_id: str, params: SketchParams) -> bytes:
        self.info(photo_id)
        return self.pipeline.sheet_jpeg(photo_id, params)
