# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Who may talk to the server.

Binding ``127.0.0.1`` keeps the network out, but not the other pages open in the
user's browser: they can reach a loopback port too. Two ways in are left, and
each header closes one:

* **DNS rebinding.** A page on ``evil.example`` has its name re-resolved to
  ``127.0.0.1`` and then reads our answers as same-origin. The browser still
  sends ``Host: evil.example``, so a request whose Host is not a loopback name
  is refused.
* **Cross-site requests.** A page can POST to us without reading the answer
  (enough for "quit"), and can open a WebSocket and read it, since WebSockets
  have no same-origin rule. The Host is right there; the Origin is not, and
  browsers send it on every such request, so a foreign Origin is refused too.

A request without Origin passes: a navigation, a same-origin GET, or a program
that is not a browser (a second launch asking for the window, ``curl``) -- none
of which a web page can forge. The port is never compared: the attacks name
another host, and in development the page may come from a dev server on another port.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlsplit

LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost"})
TOKEN_HEADER = "X-App-Token"

BAD_HOST = "richiesta rifiutata: host non locale"
BAD_ORIGIN = "richiesta rifiutata: proviene da una pagina che non è galleriaDelVento"
BAD_TOKEN = "richiesta rifiutata: manca il token di sessione di questa finestra"


def _hostname(netloc: str) -> str | None:
    try:
        return urlsplit(f"//{netloc}").hostname
    except ValueError:
        return None


def refusal(host: str | None, origin: str | None) -> tuple[int, str] | None:
    """Why a request is refused, as ``(status, message)``; ``None`` if it may pass."""
    if _hostname(host or "") not in LOOPBACK_NAMES:
        return 400, BAD_HOST
    if origin is None:
        return None
    # ``null`` is a sandboxed frame or a file:// page: not our window.
    parts = urlsplit(origin) if origin != "null" else None
    if parts is None or parts.scheme not in ("http", "https"):
        return 403, BAD_ORIGIN
    if _hostname(parts.netloc) not in LOOPBACK_NAMES:
        return 403, BAD_ORIGIN
    return None


def needs_token(path: str) -> bool:
    """The API needs the token; the page, its files and the health check do not.

    The page must load before it can know the token (it reads it from its own
    URL), and a second launch checks health without one.
    """
    return path.startswith("/api/") and path != "/api/health"


def token_matches(expected: str | None, given: str | None) -> bool:
    if expected is None:
        return True
    return given is not None and secrets.compare_digest(expected, given)
