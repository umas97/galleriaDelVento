# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
#
# PyInstaller recipe of the Windows executable (SPEC §25.3). A folder, not a
# single file: a single file unpacks 300-400 MB at every launch and antivirus
# programs flag it more often. No console: ``launcher.py`` shows errors.
#
#   uv run --group windows-build pyinstaller --noconfirm packaging/windows/galleriadelvento.spec
#
# The interface must be built first (cd frontend && npm run build). Output:
# dist/galleriaDelVento/galleriaDelVento.exe, with everything else in _internal.

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parents[1]  # noqa: F821 - defined by PyInstaller
STATIC = ROOT / "backend" / "gdv" / "static"
if not (STATIC / "index.html").is_file():
    raise SystemExit("interfaccia non costruita: cd frontend && npm run build")

analysis = Analysis(  # noqa: F821
    [str(ROOT / "packaging" / "windows" / "launcher.py")],
    pathex=[str(ROOT / "backend")],
    datas=[
        # Where server.py looks for it: next to the package.
        (str(STATIC), "gdv/static"),
        # Resource files the libraries open at run time.
        *collect_data_files("trimesh"),
        *collect_data_files("ezdxf"),
    ],
    hiddenimports=[
        # Uvicorn picks its loop, protocols and lifespan by name.
        *collect_submodules("uvicorn"),
        # Modules imported inside functions (the window, the report), which
        # the analysis may not follow.
        *collect_submodules("gdv"),
    ],
    # Development tools that a dependency may import optionally.
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "numba", "PIL.ImageTk"],
)
pyz = PYZ(analysis.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="galleriaDelVento",
    console=False,
    icon=str(ROOT / "packaging" / "icons" / "galleriadelvento.ico"),
    # UPX packing is a frequent cause of false antivirus alarms.
    upx=False,
)
COLLECT(  # noqa: F821
    exe,
    analysis.binaries,
    analysis.datas,
    name="galleriaDelVento",
    upx=False,
)
