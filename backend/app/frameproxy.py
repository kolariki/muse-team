"""
Embed proxy for "App real": the built product often ships strict security headers (CSP `frame-ancestors 'none'`,
`X-Frame-Options`), which is correct for production but makes the browser refuse to show it inside Muse Team.

So the UI never frames the app directly: it frames a tiny local reverse proxy on another free port that forwards every
request to the app and drops only the framing headers. The real URL is still shown for "open in a new tab".
Websockets (e.g. Next dev HMR) are not proxied: the page renders fine, hot reload just stays silent inside the frame.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

import httpx
import uvicorn

log = logging.getLogger("arena.frameproxy")

DROP = {b"content-security-policy", b"content-security-policy-report-only", b"x-frame-options", b"content-length", b"transfer-encoding", b"content-encoding", b"connection", b"keep-alive"}
HOP = {b"host", b"connection", b"keep-alive", b"accept-encoding", b"content-length"}


def make_app(target_port: int, target_host: str = "127.0.0.1") -> Callable[..., Awaitable[None]]:
    host = f"[{target_host}]" if ":" in target_host else target_host  # IPv6 loopback needs brackets in a URL
    client = httpx.AsyncClient(base_url=f"http://{host}:{target_port}", timeout=httpx.Timeout(60, connect=5), follow_redirects=False)

    async def app(scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            while True:
                msg = await receive()
                if msg["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif msg["type"] == "lifespan.shutdown":
                    await client.aclose()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        path = scope["raw_path"].decode("latin-1") + (("?" + scope["query_string"].decode("latin-1")) if scope.get("query_string") else "")
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope["headers"] if k.lower() not in HOP]
        headers.append(("host", f"127.0.0.1:{target_port}"))
        try:
            req = client.build_request(scope["method"], path, headers=headers, content=body or None)
            resp = await client.send(req, stream=True)
        except Exception as e:
            await send({"type": "http.response.start", "status": 502, "headers": [(b"content-type", b"text/plain; charset=utf-8")]})
            await send({"type": "http.response.body", "body": f"La app no respondió: {e}".encode()})
            return
        try:
            out = [(k, v) for k, v in resp.headers.raw if k.lower() not in DROP]
            await send({"type": "http.response.start", "status": resp.status_code, "headers": out})
            async for chunk in resp.aiter_bytes():  # decoded (gzip/br) → we dropped content-encoding/length above
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        finally:
            await resp.aclose()

    return app


class FrameProxy:
    def __init__(self, target_port: int, port: int, target_host: str = "127.0.0.1") -> None:
        self.target_port, self.port, self.target_host = target_port, port, target_host
        self.server: uvicorn.Server | None = None
        self.task: asyncio.Task | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> None:
        cfg = uvicorn.Config(make_app(self.target_port, self.target_host), host="127.0.0.1", port=self.port, log_level="warning", lifespan="on", access_log=False)
        self.server = uvicorn.Server(cfg)
        self.server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
        self.task = asyncio.create_task(self.server.serve())
        for _ in range(50):
            if self.server.started:
                return
            await asyncio.sleep(0.1)

    async def stop(self) -> None:
        if self.server:
            self.server.should_exit = True
        if self.task:
            try:
                await asyncio.wait_for(self.task, 5)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                self.task.cancel()
