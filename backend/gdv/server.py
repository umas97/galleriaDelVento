# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The local server: FastAPI, run by uvicorn in a background thread.

The server is not a service. It is the back half of a desktop program that
speaks HTTP to its own window, and everything here follows from that: it binds
``127.0.0.1`` with no option not to, it has no authentication because there is
no one else on the socket (``security.py`` turns away the other pages of the
user's browser), and it lives and dies with the program.

Errors become JSON with a ``detail`` in Italian. The interface shows that
sentence as it is: only the server knows *which* file was wrong.

The project's routes go in :func:`create_app`, before the interface is mounted:
the interface is a catch-all and would shadow anything registered after it.
"""

from __future__ import annotations

import logging
import mimetypes
import threading
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field, ValidationError
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__
from .api import routes_cases, routes_models, routes_profiles, routes_sketch
from .config import APP_ID, APP_NAME, WINDOW_PATH
from .controls import AppControls
from .errors import AppError
from .library.drawings import DrawingStore
from .library.models import ModelStore
from .library.photos import PhotoStore
from .library.profiles import ProfileStore
from .safety import UnsafeWriteError
from .security import BAD_TOKEN, TOKEN_HEADER, needs_token, refusal, token_matches

__all__ = ["STATIC_DIR", "LocalServer", "create_app"]

_log = logging.getLogger(__name__)

#: The interface. React builds into it; a vanilla interface lives in it.
STATIC_DIR = Path(__file__).resolve().parent / "static"

#: Never cached by the browser: a new build must be seen the moment it exists.
_NO_STORE = {"Cache-Control": "no-cache, no-store, must-revalidate"}
#: Vite puts a content hash in every name under assets/: those never change.
_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


class LocalOnlyMiddleware:
    """Refuse HTTP and WebSocket requests that do not come from our own page."""

    def __init__(self, app: ASGIApp, token: str | None = None) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        reason = refusal(headers.get("host"), headers.get("origin"))
        given = headers.get(TOKEN_HEADER)
        if reason is None and needs_token(scope["path"]) and not token_matches(self.token, given):
            reason = (403, BAD_TOKEN)
        if reason is None:
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            # Closing before accepting refuses the handshake.
            await send({"type": "websocket.close", "code": 1008, "reason": reason[1]})
            return
        response = JSONResponse({"detail": reason[1]}, status_code=reason[0])
        await response(scope, receive, send)


#: No outgoing network from the page, ever (SPEC §2.2). Inline styles are allowed
#: because libraries set them; scripts only from our own origin.
CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "connect-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "worker-src 'self' blob:",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    )
)


class SecurityHeadersMiddleware:
    """Add the Content-Security-Policy to every HTTP response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
                headers["X-Content-Type-Options"] = "nosniff"
                headers["Referrer-Policy"] = "no-referrer"
            await send(message)

        await self.app(scope, receive, send_with_headers)


class ClientLog(BaseModel):
    """An error the interface reports (JS exception, lost WebGL context; SPEC §15)."""

    level: str = Field(default="error", pattern="^(error|warning|info)$")
    message: str = Field(max_length=4000)
    details: str = Field(default="", max_length=20000)


def _error_body(message: str, technical: str = "") -> dict[str, str]:
    return {"detail": message, "technical": technical}


def create_app(controls: AppControls | None = None, static_dir: Path | None = None) -> FastAPI:
    controls = controls or AppControls()
    app = FastAPI(title=APP_NAME, version=__version__)
    app.add_middleware(LocalOnlyMiddleware, token=controls.token)
    app.add_middleware(SecurityHeadersMiddleware)
    app.state.models = ModelStore()
    app.state.profiles = ProfileStore()
    app.state.drawings = DrawingStore()
    app.state.photos = PhotoStore()

    @app.get("/api/health", tags=["app"])
    def health() -> dict[str, Any]:
        """Liveness, and the name a second launch checks before trusting a port."""
        return {"status": "ok", "app": APP_ID, "version": __version__}

    @app.get("/api/window", tags=["app"])
    def window() -> dict[str, Any]:
        """What the interface is shown in, and whether "Esci" can stop the program."""
        return controls.window_info() | {"can_quit": controls.quit is not None}

    @app.post("/api/window/show", tags=["app"])
    def show_window() -> dict[str, Any]:
        if controls.show_window is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "questo server non gestisce finestre")
        return controls.show_window()

    @app.post("/api/app/quit", status_code=status.HTTP_202_ACCEPTED, tags=["app"])
    def quit_app(background: BackgroundTasks) -> dict[str, str]:
        """ "Esci": the answer leaves first, then the program stops."""
        if controls.quit is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "questo server non è stato avviato dal programma e non può spegnersi da solo",
            )
        background.add_task(controls.quit)
        return {"detail": "chiusura in corso"}

    @app.get(WINDOW_PATH, include_in_schema=False)
    def window_entry() -> RedirectResponse:
        """Where the window opens: on to the interface (see ``config.WINDOW_PATH``)."""
        return RedirectResponse("/", status_code=status.HTTP_307_TEMPORARY_REDIRECT)

    # --- the project's routes go here, before the interface -------------------

    @app.post("/api/log", status_code=status.HTTP_204_NO_CONTENT, tags=["app"])
    def client_log(entry: ClientLog) -> None:
        level = {"error": logging.ERROR, "warning": logging.WARNING}.get(entry.level, logging.INFO)
        logging.getLogger("gdv.frontend").log(level, "%s %s", entry.message, entry.details)

    app.include_router(routes_models.router)
    app.include_router(routes_profiles.router)
    app.include_router(routes_cases.router)
    app.include_router(routes_sketch.router)

    @app.exception_handler(AppError)
    async def _app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=_error_body(exc.message, exc.technical))

    @app.exception_handler(UnsafeWriteError)
    async def _unsafe(_request: Request, exc: UnsafeWriteError) -> JSONResponse:
        # Already logged at ERROR by the guard: a defect, never the user's fault.
        return JSONResponse(
            status_code=409,
            content=_error_body("Operazione bloccata per proteggere i tuoi file", str(exc)),
        )

    @app.exception_handler(RequestValidationError)
    async def _bad_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422, content=_error_body("Richiesta non valida", str(exc.errors()))
        )

    @app.exception_handler(ValidationError)
    async def _invalid(_request: Request, exc: ValidationError) -> JSONResponse:
        first = exc.errors()[0]["msg"] if exc.errors() else str(exc)
        return JSONResponse(status_code=400, content=_error_body(first, str(exc)))

    @app.exception_handler(ValueError)
    async def _bad_value(_request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(FileNotFoundError)
    async def _not_found(_request: Request, exc: FileNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    mount_interface(app, static_dir or STATIC_DIR)
    return app


def mount_interface(app: FastAPI, root: Path) -> bool:
    """Serve the interface, if there is one. Registered last: it is a catch-all.

    The router inside the page owns the URLs: a reload on ``/qualcosa`` must give
    the same document as ``/``, because the window has no address bar to fix it
    with. Anything that is not a file and not the API falls back to index.html.
    ``/api`` never does: an API 404 must stay a 404, not become a page.
    """
    index = root / "index.html"
    if not index.is_file():
        _log.warning("interfaccia assente in %s: servo solo l'API", root)
        return False
    # Not in every distribution's map; a manifest served as text/plain is ignored.
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    resolved_root = root.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def interface(path: str) -> Response:
        if path.startswith(("api/", "ws", "docs", "redoc", "openapi.json")) or path == "api":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "risorsa inesistente")
        candidate = (root / path).resolve() if path else index
        if path and resolved_root in candidate.parents and candidate.is_file():
            headers = _IMMUTABLE if path.startswith("assets/") else _NO_STORE
            return FileResponse(candidate, headers=headers)
        return FileResponse(index, headers=_NO_STORE)

    _ = interface
    return True


class LocalServer:
    """Uvicorn in a background thread; the main thread belongs to the window."""

    def __init__(
        self,
        controls: AppControls,
        host: str = "127.0.0.1",
        port: int = 0,
        static_dir: Path | None = None,
    ) -> None:
        self.app = create_app(controls, static_dir)
        config = uvicorn.Config(
            self.app,
            host=host,
            port=port,
            log_level="warning",
            # Access logs of a window talking to its own server are noise.
            access_log=False,
        )
        self._server = uvicorn.Server(config)
        self._thread: threading.Thread | None = None
        self.port = port

    def start(self, timeout: float = 15.0) -> int:
        """Start serving and return the bound port. Raises OSError if it cannot."""
        self._thread = threading.Thread(target=self._server.run, name="server", daemon=True)
        self._thread.start()
        deadline = time.monotonic() + timeout
        while not self._server.started:
            if not self._thread.is_alive():
                raise OSError(f"porta {self.port} non disponibile")
            if time.monotonic() > deadline:
                raise OSError("il server non è partito in tempo")
            time.sleep(0.02)
        self.port = self._server.servers[0].sockets[0].getsockname()[1]
        return self.port

    def stop(self, timeout: float = 5.0) -> None:
        self._server.should_exit = True
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout)
