# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The write guard: the user's files are never touched (SPEC §2.1).

Imports arrive as uploaded *bytes*, so the backend never even learns where the
user's originals live. This module is the second fence: every function in the
program that opens a file for writing, creates a directory or deletes something
goes through :func:`assert_writable`, which lets through only paths inside the
program's own XDG folders (``config.Settings.writable_roots``).

Paths are compared after ``Path.resolve()``, so a symlink planted inside the
library that points outside it does not get through; the parent is checked too,
so a file cannot be created through a directory symlink either.

A refused write is a *bug*, not a user error: it is logged at ERROR level and
the API answers 409.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from .config import get_settings

__all__ = [
    "UnsafeWriteError",
    "assert_writable",
    "atomic_write_bytes",
    "atomic_write_json",
    "make_dirs",
    "remove_file",
    "remove_tree",
]

_log = logging.getLogger(__name__)


class UnsafeWriteError(PermissionError):
    """A write outside the program's folders was attempted. Always a defect."""


def _inside(path: Path, roots: tuple[Path, ...]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def assert_writable(path: str | os.PathLike[str]) -> Path:
    """Return ``path`` resolved, or raise if writing there is not allowed."""
    roots = tuple(root.resolve() for root in get_settings().writable_roots)
    candidate = Path(path)
    resolved = candidate.resolve()
    parent = candidate.parent.resolve()
    # The root folders themselves may be created, never written over as files.
    if not _inside(resolved, roots) or not (_inside(parent, roots) or resolved in roots):
        _log.error("scrittura bloccata fuori dalle cartelle del programma: %s", candidate)
        raise UnsafeWriteError(
            f"scrittura non consentita fuori dalle cartelle del programma: {path}"
        )
    return resolved


def make_dirs(path: str | os.PathLike[str]) -> Path:
    resolved = assert_writable(path)
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def atomic_write_bytes(path: str | os.PathLike[str], data: bytes) -> Path:
    """Write ``data`` to ``path`` through a ``.tmp`` sibling and ``os.replace``."""
    target = assert_writable(path)
    tmp = assert_writable(target.with_name(target.name + ".tmp"))
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)
    return target


def atomic_write_json(path: str | os.PathLike[str], payload: Any) -> Path:
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)
    return atomic_write_bytes(path, (text + "\n").encode("utf-8"))


def remove_file(path: str | os.PathLike[str]) -> None:
    target = assert_writable(path)
    target.unlink(missing_ok=True)


def remove_tree(path: str | os.PathLike[str]) -> None:
    target = assert_writable(path)
    if target in tuple(root.resolve() for root in get_settings().writable_roots):
        raise UnsafeWriteError(f"rifiuto di cancellare una cartella radice: {path}")
    if target.exists():
        shutil.rmtree(target)


def empty_dir(path: str | os.PathLike[str]) -> None:
    """Delete everything inside ``path`` (the temporary folder at start-up)."""
    target = make_dirs(path)
    for child in target.iterdir():
        if child.is_dir() and not child.is_symlink():
            remove_tree(child)
        else:
            # A symlink is removed as a link: its target is never followed.
            assert_writable(child.parent)
            child.unlink(missing_ok=True)
