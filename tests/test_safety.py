# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 2: the write guard refuses every path outside the program's folders (SPEC §2.1)."""

from __future__ import annotations

import logging
import os

import pytest

from gdv import safety
from gdv.config import get_settings


def test_paths_inside_the_app_folders_are_allowed():
    settings = get_settings()
    for root in settings.writable_roots:
        assert safety.assert_writable(root / "sub" / "file.json")


@pytest.mark.parametrize("relative", ["outside.txt", "Documenti/model.stl", "../escape"])
def test_paths_outside_are_refused_and_logged(xdg_home, relative, caplog):
    target = xdg_home.parent / relative
    with (
        caplog.at_level(logging.ERROR, logger="gdv.safety"),
        pytest.raises(safety.UnsafeWriteError),
    ):
        safety.assert_writable(target)
    assert any("bloccata" in r.message for r in caplog.records)


def test_dot_dot_cannot_climb_out():
    data = get_settings().data_dir
    with pytest.raises(safety.UnsafeWriteError):
        safety.assert_writable(data / ".." / ".." / "fuori.txt")


def test_a_symlink_inside_the_library_pointing_outside_is_refused(xdg_home):
    outside = xdg_home.parent / "user_files"
    outside.mkdir()
    data = get_settings().data_dir
    data.mkdir(parents=True, exist_ok=True)
    link = data / "trappola"
    os.symlink(outside, link)
    with pytest.raises(safety.UnsafeWriteError):
        safety.assert_writable(link / "model.stl")
    file_link = data / "file-trappola.stl"
    os.symlink(outside / "model.stl", file_link)
    with pytest.raises(safety.UnsafeWriteError):
        safety.atomic_write_bytes(file_link, b"x")
    assert not (outside / "model.stl").exists()


def test_helpers_write_atomically_inside(xdg_home):
    target = get_settings().data_dir / "a" / "b.json"
    safety.make_dirs(target.parent)
    safety.atomic_write_json(target, {"x": 1})
    assert target.read_text(encoding="utf-8").strip() == '{\n  "x": 1\n}'
    assert not target.with_name("b.json.tmp").exists()


def test_a_root_folder_cannot_be_deleted():
    with pytest.raises(safety.UnsafeWriteError):
        safety.remove_tree(get_settings().data_dir)


def test_empty_dir_removes_links_without_following_them(xdg_home):
    outside = xdg_home.parent / "keep"
    outside.mkdir()
    (outside / "precious.txt").write_text("x")
    tmp = get_settings().tmp_dir
    safety.make_dirs(tmp / "nested")
    (tmp / "nested" / "f").write_text("x")
    os.symlink(outside, tmp / "link")
    safety.empty_dir(tmp)
    assert list(tmp.iterdir()) == []
    assert (outside / "precious.txt").exists()
