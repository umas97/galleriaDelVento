# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""A tiny HTTP client for the live test server (no extra dependency)."""

from __future__ import annotations

import http.client
import json
from typing import Any
from urllib.parse import quote


class Api:
    def __init__(self, port: int) -> None:
        self.port = port

    def call(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        *,
        json_body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        all_headers = {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}"}
        if json_body is not None:
            body = json.dumps(json_body).encode()
            all_headers["Content-Type"] = "application/json"
        elif body is not None:
            all_headers["Content-Type"] = "application/octet-stream"
        all_headers.update(headers or {})
        connection.request(method, path, body=body, headers=all_headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, data

    def json(self, method: str, path: str, **kwargs: Any) -> tuple[int, Any]:
        status, _, data = self.call(method, path, **kwargs)
        return status, json.loads(data) if data else None

    def import_model(self, data: bytes, name: str = "modello.stl") -> tuple[int, Any]:
        return self.json("POST", f"/api/models/import?nome={quote(name)}", body=data)
