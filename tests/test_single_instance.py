# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""One running program at a time, and a lockfile that never strands the user."""

from __future__ import annotations

import json
import socket

import pytest

from gdv import single_instance as si
from gdv.config import get_settings


def test_the_lock_is_taken_and_released(tmp_path):
    path = tmp_path / "app.lock"
    lock = si.acquire(0, path=path)
    assert si.read_lock(path).pid == lock.info.pid
    lock.update(port=4321)
    assert si.read_lock(path).port == 4321
    lock.release()
    assert not path.exists()


def test_a_stale_lockfile_is_removed_and_the_launch_continues(tmp_path):
    path = tmp_path / "app.lock"
    path.write_text(json.dumps({"pid": 999_999_999, "port": 1}), encoding="utf-8")
    lock = si.acquire(0, path=path)
    assert lock.info.pid != 999_999_999
    lock.release()


def test_a_corrupt_lockfile_does_not_block_the_program(tmp_path):
    path = tmp_path / "app.lock"
    path.write_text('{"pid": 12', encoding="utf-8")
    assert si.read_lock(path) is None
    si.acquire(0, path=path).release()


def test_a_live_pid_that_is_not_us_does_not_block_either(tmp_path):
    """PIDs are recycled: a live process that does not answer as us is not us."""
    import os

    path = tmp_path / "app.lock"
    path.write_text(json.dumps({"pid": os.getppid(), "port": 9}), encoding="utf-8")
    si.acquire(0, path=path).release()


def test_a_running_instance_is_found(tmp_path, live):
    import os

    path = tmp_path / "app.lock"
    path.write_text(json.dumps({"pid": os.getpid(), "port": live.port}), encoding="utf-8")
    with pytest.raises(si.AlreadyRunning) as caught:
        si.acquire(0, path=path)
    assert caught.value.info.port == live.port


def test_a_port_held_by_a_stranger_is_an_error_not_another_port(tmp_path):
    with socket.socket() as stranger:
        stranger.bind(("127.0.0.1", 0))
        stranger.listen()
        port = stranger.getsockname()[1]
        with pytest.raises(si.PortBusy) as caught:
            si.acquire(port, path=tmp_path / "app.lock")
    assert "--port" in str(caught.value)


def test_a_lock_is_not_released_by_a_process_that_does_not_own_it(tmp_path):
    path = tmp_path / "app.lock"
    lock = si.acquire(0, path=path)
    path.write_text(json.dumps({"pid": lock.info.pid + 1, "port": 1}), encoding="utf-8")
    lock.release()
    assert path.exists()


def test_the_default_lock_lives_in_the_runtime_directory(xdg_home):
    assert get_settings().lock_path.parent == xdg_home / "run"


def test_asking_an_instance_to_show_itself(live):
    assert si.ask_to_show(live.port) == {"shown": True}
    assert si.ask_to_show(1, timeout=0.5) is None
