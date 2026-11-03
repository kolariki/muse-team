"""Run-the-app: service detection and a real local dev server start/stop (plain node http server, no installs)."""
import asyncio
import json
import shutil
import urllib.request

import pytest

from app import runner

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")


def _node_project(root):
    (root / "web").mkdir(parents=True)
    (root / "web" / "node_modules").mkdir()  # pretend deps are installed
    (root / "web" / "package.json").write_text(json.dumps({"name": "demo-web", "scripts": {"dev": "node server.js"}, "dependencies": {"express": "^4"}}))
    (root / "web" / "server.js").write_text(
        "const http=require('http');const p=process.env.PORT||3000;"
        "http.createServer((q,r)=>{r.end('<h1>hola</h1>')}).listen(p,'127.0.0.1',()=>console.log('listening on http://127.0.0.1:'+p));"
    )
    (root / "api").mkdir()
    (root / "api" / "requirements.txt").write_text("fastapi\nuvicorn\n")
    (root / "api" / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n")


def test_detect_finds_web_and_api(tmp_path):
    _node_project(tmp_path)
    svcs = runner.detect(tmp_path)
    ids = [s["id"] for s in svcs]
    assert ids[0] == "web"  # web UI first
    web = svcs[0]
    assert web["kind"] == "node" and web["web"] and web["needs_install"] is False and web["run"] == "npm run dev"
    api = next(s for s in svcs if s["id"] == "api")
    assert api["kind"] == "py-fastapi" and "uvicorn main:app" in api["run"] and "{port}" in api["run"]


def test_start_and_stop_real_server(tmp_path):
    _node_project(tmp_path)
    events = []
    svc = runner.detect(tmp_path)[0]

    async def go():
        r = runner.AppRun(tmp_path, svc, "u", "b", {}, lambda t, d: events.append((t, d)))
        r.task = asyncio.create_task(r.run())
        for _ in range(100):
            if r.status in ("running", "error"):
                break
            await asyncio.sleep(0.1)
        assert r.status == "running", r.logs
        body = await asyncio.to_thread(lambda: urllib.request.urlopen(r.url, timeout=5).read().decode())
        assert "hola" in body
        await r.stop()
        assert r.status == "stopped"
        assert r.proc.returncode is not None

    asyncio.run(go())
    kinds = [t for t, _ in events]
    assert "app.status" in kinds and "app.log" in kinds
    assert any(d.get("status") == "running" and d.get("url") for t, d in events if t == "app.status")


def test_embed_proxy_strips_frame_blocking_headers(tmp_path):
    """A product that ships `frame-ancestors 'none'` is still visible inside Muse Team, through the embed proxy."""
    (tmp_path / "web").mkdir(parents=True)
    (tmp_path / "web" / "node_modules").mkdir()
    (tmp_path / "web" / "package.json").write_text(json.dumps({"name": "csp-web", "scripts": {"dev": "node server.js"}, "dependencies": {"express": "^4"}}))
    (tmp_path / "web" / "server.js").write_text(
        "const http=require('http');const p=process.env.PORT||3000;"
        "http.createServer((q,r)=>{r.setHeader('Content-Security-Policy',\"default-src 'self'; frame-ancestors 'none'\");r.setHeader('X-Frame-Options','DENY');"
        "r.setHeader('content-type','text/html');r.end('<h1>embebida</h1>')}).listen(p,'127.0.0.1',()=>console.log('listening on http://127.0.0.1:'+p));"
    )
    svc = runner.detect(tmp_path)[0]

    async def go():
        r = runner.AppRun(tmp_path, svc, "u", "b", {}, lambda t, d: None)
        r.task = asyncio.create_task(r.run())
        for _ in range(100):
            if r.status in ("running", "error"):
                break
            await asyncio.sleep(0.1)
        assert r.status == "running" and r.embed_url and r.embed_url != r.url, r.logs

        def fetch(url):
            resp = urllib.request.urlopen(url, timeout=5)
            return resp.headers, resp.read().decode()

        direct_h, _ = await asyncio.to_thread(fetch, r.url)
        assert "frame-ancestors" in (direct_h.get("Content-Security-Policy") or "")
        proxied_h, body = await asyncio.to_thread(fetch, r.embed_url)
        assert "embebida" in body
        assert proxied_h.get("Content-Security-Policy") is None and proxied_h.get("X-Frame-Options") is None
        await r.stop()
        assert r.status == "stopped" and r.proxy is None

    asyncio.run(go())
