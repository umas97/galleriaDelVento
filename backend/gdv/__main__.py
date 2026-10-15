# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Command line entry point.

``galleriadelvento`` with no arguments starts the program *and its window*: it is what
the menu entry runs. The project's own commands, when it has some, become
subcommands here; the bare command must keep meaning "open the program".
"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .config import APP_ID, DEFAULT_PORT, DESCRIPTION, ENV_PREFIX


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=APP_ID, description=DESCRIPTION)
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--no-window",
        action="store_true",
        help="avvia solo il server, senza finestra (sviluppo, SSH, script)",
    )
    parser.add_argument(
        "--window",
        action="store_true",
        help="apri la finestra anche se non risulta un display",
    )
    parser.add_argument(
        "--port",
        type=int,
        help=f"porta locale (default {DEFAULT_PORT or 'scelta dal sistema'}, o {ENV_PREFIX}PORT)",
    )
    parser.add_argument(
        "--browser", help=f"browser Chromium da usare per la finestra (o {ENV_PREFIX}BROWSER)"
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help=f"livello del log su terminale (il file usa {ENV_PREFIX}LOG_LEVEL)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from .runtime import run

    return run(args)


if __name__ == "__main__":
    sys.exit(main())
