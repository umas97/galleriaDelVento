# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The Windows branches (SPEC §25.3).

Each module that differs on Windows asks ``winsupport.WINDOWS``; here it is set
by hand, so the branches run on Linux too. What needs the real system -- a PID
seen through ``OpenProcess``, the exclusive port probe -- runs only on Windows,
in the GitHub action.
"""

from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from gdv import runtime, single_instance, window, winsupport
from gdv.config import APP_ID, get_settings

on_windows = pytest.mark.skipif(sys.platform != "win32", reason="serve Windows")


@pytest.fixture
def windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(winsupport, "WINDOWS", True)
    get_settings.cache_clear()


def test_folders_go_under_local_app_data(windows, tmp_path, monkeypatch):
    for variable in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    settings = get_settings()
    root = tmp_path / "Local" / APP_ID
    assert settings.data_dir == root / "dati"
    assert settings.log_dir == root / "stato" / "logs"
    assert settings.config_dir == root / "config"
    assert settings.tmp_dir == root / "cache" / "tmp"
    assert settings.lock_path == root / "stato" / f"{APP_ID}.lock"


def test_an_xdg_variable_still_wins_on_windows(windows, xdg_home, monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    assert get_settings().data_dir == xdg_home / "share" / APP_ID


def test_chrome_comes_before_edge_and_each_path_once():
    environ = {
        "PROGRAMFILES": r"C:\Program Files",
        "PROGRAMFILES(X86)": r"C:\Program Files (x86)",
        "LOCALAPPDATA": r"C:\Users\s\AppData\Local",
    }
    names = [path.name for path in winsupport.browser_paths(environ)]
    assert names[:3] == ["chrome.exe"] * 3
    assert names[3:] == ["msedge.exe"] * 3
    assert len(set(winsupport.browser_paths(environ))) == 6


def test_the_first_installed_browser_is_found(tmp_path):
    edge = tmp_path / "x86" / "Microsoft" / "Edge" / "Application" / "msedge.exe"
    edge.parent.mkdir(parents=True)
    edge.write_bytes(b"")
    environ = {"PROGRAMFILES": str(tmp_path / "pf"), "PROGRAMFILES(X86)": str(tmp_path / "x86")}
    assert winsupport.find_browser(environ) == [str(edge)]
    chrome = tmp_path / "pf" / "Google" / "Chrome" / "Application" / "chrome.exe"
    chrome.parent.mkdir(parents=True)
    chrome.write_bytes(b"")
    assert winsupport.find_browser(environ) == [str(chrome)]
    assert winsupport.find_browser({}) is None


def test_the_window_asks_winsupport_for_the_browser(windows, monkeypatch):
    monkeypatch.setattr(winsupport, "find_browser", lambda: [r"C:\Edge\msedge.exe"])
    assert window.find_browser() == [r"C:\Edge\msedge.exe"]
    # The tests' own candidate lists still bypass it.
    assert window.find_browser(candidates=(), flatpaks=()) is None


def test_a_window_that_cannot_be_raised_says_where_it_is(windows, monkeypatch):
    monkeypatch.setattr(winsupport, "raise_window", lambda pid: False)
    host = window.WindowHost(None, candidates=(), flatpaks=())

    class Running:
        pid = 4242

        def poll(self) -> None:
            return None

    host.process = Running()  # type: ignore[assignment]
    assert host.show() == {"shown": False, "reason": winsupport.WINDOW_HIDDEN}


def test_a_window_opens_without_a_display_variable(windows, monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    assert runtime.want_window(argparse.Namespace(no_window=False, window=False))
    assert not runtime.want_window(argparse.Namespace(no_window=True, window=False))


def test_no_sighup_on_windows(windows, monkeypatch):
    # Ctrl+Break exists only on Windows; elsewhere any number stands in for it.
    monkeypatch.setattr(signal, "SIGBREAK", getattr(signal, "SIGBREAK", 21), raising=False)
    installed: list[int] = []
    monkeypatch.setattr(signal, "signal", lambda signum, _handler: installed.append(signum))
    runtime._install_signal_handlers(threading.Event())
    assert installed == [signal.SIGTERM, signal.SIGINT, signal.SIGBREAK]


def test_the_lock_asks_winsupport_whether_a_pid_lives(windows, monkeypatch):
    asked: list[int] = []
    monkeypatch.setattr(winsupport, "pid_alive", lambda pid: asked.append(pid) or False)
    assert not single_instance._pid_alive(1234)
    assert asked == [1234]


def test_the_interface_keeps_its_media_types_over_the_registry(monkeypatch):
    import mimetypes

    monkeypatch.setattr(mimetypes, "_db", mimetypes.MimeTypes())
    mimetypes.add_type("text/plain", ".js")  # what a Windows registry may say
    winsupport.fix_media_types()
    assert mimetypes.guess_type("assets/app-1234.js")[0] == "text/javascript"
    assert mimetypes.guess_type("assets/app.css")[0] == "text/css"


class Reserved(OSError):
    winerror = 10013  # what Windows says of a port it reserves


def test_a_port_windows_reserves_is_told_apart(windows, tmp_path, monkeypatch):
    assert winsupport.is_reserved(Reserved())
    assert not winsupport.is_reserved(OSError(98, "in uso"))
    monkeypatch.setattr(single_instance, "_bind_error", lambda port, host="": Reserved())
    with pytest.raises(single_instance.PortReserved) as caught:
        single_instance.acquire(8853, path=tmp_path / "app.lock")
    assert "riservata da Windows" in str(caught.value)
    # On Linux the same error is the plain "taken" one.
    monkeypatch.setattr(winsupport, "WINDOWS", False)
    with pytest.raises(single_instance.PortBusy) as caught:
        single_instance.acquire(8853, path=tmp_path / "app.lock")
    assert not isinstance(caught.value, single_instance.PortReserved)


def test_the_ports_to_try_start_from_the_remembered_one(xdg_home):
    state = get_settings().state_dir
    state.mkdir(parents=True, exist_ok=True)
    assert winsupport.port_candidates(state, 8853) == [8853, 0]
    winsupport.remember_port(state, 51234)
    assert winsupport.port_candidates(state, 8853) == [51234, 8853, 0]
    winsupport.remember_port(state, 8853)
    assert winsupport.port_candidates(state, 8853) == [8853, 0]
    (state / winsupport.PORT_FILE).write_text("niente", encoding="utf-8")
    assert winsupport.port_candidates(state, 8853) == [8853, 0]


def fake_acquire(monkeypatch, refuse):
    """``acquire`` that refuses some ports, and remembers what it was asked."""
    asked: list[int] = []

    def acquire(port):
        asked.append(port)
        if port in refuse:
            raise refuse[port](port)
        return f"lock:{port}"

    monkeypatch.setattr(single_instance, "acquire", acquire)
    return asked


def test_a_reserved_port_moves_to_one_windows_hands_out(windows, xdg_home, monkeypatch):
    asked = fake_acquire(monkeypatch, {8853: single_instance.PortReserved})
    assert runtime.take_lock(get_settings(), 8853, chosen=False) == "lock:0"
    assert asked == [8853, 0]


def test_a_remembered_port_now_taken_moves_on_too(windows, xdg_home, monkeypatch):
    state = get_settings().state_dir
    state.mkdir(parents=True, exist_ok=True)
    winsupport.remember_port(state, 51234)
    asked = fake_acquire(monkeypatch, {51234: single_instance.PortBusy})
    assert runtime.take_lock(get_settings(), 8853, chosen=False) == "lock:8853"
    assert asked == [51234, 8853]


def test_the_fixed_port_taken_by_another_program_stays_an_error(windows, xdg_home, monkeypatch):
    fake_acquire(monkeypatch, {8853: single_instance.PortBusy})
    with pytest.raises(single_instance.PortBusy):
        runtime.take_lock(get_settings(), 8853, chosen=False)


def test_a_port_the_user_chose_never_moves(windows, xdg_home, monkeypatch):
    asked = fake_acquire(monkeypatch, {8854: single_instance.PortReserved})
    with pytest.raises(single_instance.PortReserved):
        runtime.take_lock(get_settings(), 8854, chosen=True)
    assert asked == [8854]


def test_on_linux_the_port_never_moves(xdg_home, monkeypatch):
    asked = fake_acquire(monkeypatch, {8853: single_instance.PortBusy})
    with pytest.raises(single_instance.PortBusy):
        runtime.take_lock(get_settings(), 8853, chosen=False)
    assert asked == [8853]


EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


@pytest.fixture
def registry(monkeypatch, xdg_home):
    """A fake UserGpuPreferences key; the state folder exists."""
    values: dict[str, str] = {}
    monkeypatch.setattr(winsupport, "_read_gpu_preference", values.get)

    def write(executable, value):
        if value is None:
            values.pop(executable, None)
        else:
            values[executable] = value

    monkeypatch.setattr(winsupport, "_write_gpu_preference", write)
    get_settings().state_dir.mkdir(parents=True, exist_ok=True)
    return values


def test_the_browser_gets_the_dedicated_gpu_while_the_program_runs(registry):
    state = get_settings().state_dir
    winsupport.prefer_dedicated_gpu(EDGE, state)
    assert registry == {EDGE: "GpuPreference=2;"}
    winsupport.restore_gpu_preference(state)
    assert registry == {}
    assert not (state / winsupport.GPU_MARKER).exists()


def test_a_choice_the_user_made_is_left_alone(registry):
    state = get_settings().state_dir
    registry[EDGE] = "GpuPreference=1;"
    winsupport.prefer_dedicated_gpu(EDGE, state)
    winsupport.restore_gpu_preference(state)
    assert registry == {EDGE: "GpuPreference=1;"}


def test_other_settings_of_the_browser_come_back_as_they_were(registry):
    state = get_settings().state_dir
    registry[EDGE] = "SwapEffectUpgradeEnable=1;"
    winsupport.prefer_dedicated_gpu(EDGE, state)
    assert registry[EDGE] == "SwapEffectUpgradeEnable=1;GpuPreference=2;"
    winsupport.restore_gpu_preference(state)
    assert registry[EDGE] == "SwapEffectUpgradeEnable=1;"


def test_a_change_the_user_makes_meanwhile_is_kept(registry):
    state = get_settings().state_dir
    winsupport.prefer_dedicated_gpu(EDGE, state)
    registry[EDGE] = "GpuPreference=1;"  # Settings, while the program runs
    winsupport.restore_gpu_preference(state)
    assert registry == {EDGE: "GpuPreference=1;"}
    assert not (state / winsupport.GPU_MARKER).exists()


def test_a_crash_is_undone_at_the_next_launch(registry):
    state = get_settings().state_dir
    winsupport.prefer_dedicated_gpu(EDGE, state)  # ...and the program is killed
    assert (state / winsupport.GPU_MARKER).exists()
    winsupport.prefer_dedicated_gpu(EDGE, state)  # the next launch
    assert registry == {EDGE: "GpuPreference=2;"}
    winsupport.restore_gpu_preference(state)
    assert registry == {}


def test_the_window_asks_for_the_dedicated_gpu_only_on_windows(monkeypatch, xdg_home):
    host = window.WindowHost(sys.executable)
    monkeypatch.setattr(winsupport, "WINDOWS", False)
    assert not set(winsupport.GPU_FLAGS) & set(host.argv("http://127.0.0.1:8853/"))
    monkeypatch.setattr(winsupport, "WINDOWS", True)
    assert set(winsupport.GPU_FLAGS) <= set(host.argv("http://127.0.0.1:8853/"))


@on_windows
def test_the_gpu_preference_goes_through_the_real_registry(xdg_home):
    state = get_settings().state_dir
    state.mkdir(parents=True, exist_ok=True)
    fake = r"C:\gdv-test\non-esiste.exe"
    try:
        winsupport.prefer_dedicated_gpu(fake, state)
        assert winsupport._read_gpu_preference(fake) == "GpuPreference=2;"
        winsupport.restore_gpu_preference(state)
        assert winsupport._read_gpu_preference(fake) is None
    finally:
        winsupport._write_gpu_preference(fake, None)


def test_no_pid_no_window_to_raise():
    assert winsupport.raise_window(None) is False


@on_windows
def test_pid_alive_sees_this_process_and_not_a_finished_one():
    assert winsupport.pid_alive(os.getpid())
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert not winsupport.pid_alive(child.pid)


@on_windows
def test_a_port_in_use_is_not_free_on_windows():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        assert not single_instance.port_is_free(port)
    assert single_instance.port_is_free(port)


@on_windows
def test_the_installed_browser_is_found_on_this_machine():
    # The GitHub runner has both; a school PC has Edge at least.
    command = winsupport.find_browser()
    assert command is not None and Path(command[0]).name in ("chrome.exe", "msedge.exe")
