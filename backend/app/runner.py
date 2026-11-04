"""
Run the built product locally, from inside Muse Team.

detect(root)  → the runnable services in the project (Next/Vite/Node, FastAPI/Flask/Django, docker compose)
start(...)    → installs what's missing, launches the dev server on a free port, streams logs, waits until it answers
stop(...)     → kills the whole process group

Nothing is deployed anywhere: the app runs on this machine, on 127.0.0.1, and the UI shows it in an iframe.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import socket
import time
from pathlib import Path
from typing import Awaitable, Callable

from .deploy import load_secrets, render_env
from .frameproxy import FrameProxy
from .local_engine import SKIP_DIRS

Log = Callable[[str], None | Awaitable[None]]

MAX_DEPTH = 3
READY_TIMEOUT = 150  # s: `next dev` first compile can be slow
INSTALL_TIMEOUT = 600
# on a server, the user's browser can't open 127.0.0.1: the app is shown through Muse Team itself at <RUN_BASE>/r/<token>/
# (set by main; None on a local installation, where the frame proxy on 127.0.0.1 is used)
RUN_BASE: str | None = None
ON_STATUS: Callable[["AppRun"], None] | None = None  # set by main: a run that fails goes to the builder, a fixed one comes back


# ------------------------------------------------------------------ detection

def _rel(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace("\\", "/")


def _skip(parts: tuple[str, ...]) -> bool:
    return any(x in SKIP_DIRS or x in ("node_modules", ".venv", "venv", "dist", "build", ".next", ".git") for x in parts)


def _pm(d: Path) -> str:
    if (d / "pnpm-lock.yaml").exists() and shutil.which("pnpm"):
        return "pnpm"
    if (d / "yarn.lock").exists() and shutil.which("yarn"):
        return "yarn"
    if (d / "bun.lockb").exists() and shutil.which("bun"):
        return "bun"
    return "npm"


def _py_app(d: Path) -> str | None:
    """`module:app` for uvicorn, found by grepping for FastAPI()/Flask() in the service folder."""
    for f in sorted(d.rglob("*.py")):
        if _skip(f.relative_to(d).parts) or f.stat().st_size > 200_000:
            continue
        try:
            txt = f.read_text(errors="replace")
        except Exception:
            continue
        m = re.search(r"^(\w+)\s*=\s*(?:FastAPI|Flask)\(", txt, re.M)
        if m:
            mod = ".".join(f.relative_to(d).with_suffix("").parts)
            return f"{mod}:{m.group(1)}"
    return None


def detect(root: Path) -> list[dict]:
    out: list[dict] = []
    if not root.exists():
        return out
    # --- node
    for pj in sorted(root.rglob("package.json")):
        rel = pj.relative_to(root)
        if _skip(rel.parts) or len(rel.parts) > MAX_DEPTH:
            continue
        try:
            d = json.loads(pj.read_text())
        except Exception:
            continue
        scripts = d.get("scripts") or {}
        script = next((s for s in ("dev", "start", "serve", "preview") if s in scripts), None)
        if not script:
            continue
        deps = {**(d.get("dependencies") or {}), **(d.get("devDependencies") or {})}
        if "expo" in deps:
            # a mobile app: Expo's dev server serves the web build (framed like any web app) and opens the simulators
            rel_dir = _rel(pj.parent, root) or "."
            pm = _pm(pj.parent)
            inst = f"{pm} install"
            label = d.get("name") or rel.parent or "app"
            dev = devices()
            out.append({"id": f"{rel_dir}#web", "dir": rel_dir, "label": f"{label} · Expo web", "kind": "expo", "web": True, "install": inst, "run": "npx expo start --web --port {port}", "needs_install": not (pj.parent / "node_modules").exists()})
            out.append({"id": f"{rel_dir}#ios", "dir": rel_dir, "label": f"{label} · simulador iOS", "kind": "expo", "web": True, "device": "ios", "available": dev["ios"]["ok"], "hint": dev["ios"]["hint"],
                        "install": inst, "run": "npx expo start --ios --port {port}", "needs_install": not (pj.parent / "node_modules").exists()})
            out.append({"id": f"{rel_dir}#android", "dir": rel_dir, "label": f"{label} · emulador Android", "kind": "expo", "web": True, "device": "android", "available": dev["android"]["ok"], "hint": dev["android"]["hint"],
                        "install": inst, "run": "npx expo start --android --port {port}", "needs_install": not (pj.parent / "node_modules").exists()})
            continue
        kind = "next" if "next" in deps else "vite" if "vite" in deps else "nuxt" if "nuxt" in deps else "node"
        web = kind != "node" or any(k in deps for k in ("react", "vue", "svelte", "express", "fastify", "koa", "hono"))
        pm = _pm(pj.parent)
        run = f"{pm} run {script}" if pm != "npm" or script not in ("start",) else "npm start"
        if kind == "next":
            run += f" -- -p {{port}}" if pm == "npm" else f" -p {{port}}"
        elif kind == "vite":
            run += f" -- --port {{port}} --strictPort --host 127.0.0.1" if pm == "npm" else f" --port {{port}} --strictPort --host 127.0.0.1"
        out.append({
            "id": _rel(pj.parent, root) or ".", "dir": _rel(pj.parent, root) or ".", "label": f"{d.get('name') or rel.parent or 'app'} · {kind}",
            "kind": kind, "web": web, "install": f"{pm} install", "run": run, "needs_install": not (pj.parent / "node_modules").exists(),
        })
    # --- python
    for marker in ("pyproject.toml", "requirements.txt", "manage.py"):
        for f in sorted(root.rglob(marker)):
            rel = f.relative_to(root)
            if _skip(rel.parts) or len(rel.parts) > MAX_DEPTH:
                continue
            d = f.parent
            if any(s["dir"] == (_rel(d, root) or ".") and s["kind"].startswith("py") for s in out):
                continue
            try:
                txt = (d / "pyproject.toml").read_text() if (d / "pyproject.toml").exists() else ""
                txt += (d / "requirements.txt").read_text() if (d / "requirements.txt").exists() else ""
            except Exception:
                txt = ""
            low = txt.lower()
            uv = (d / "pyproject.toml").exists() and shutil.which("uv")
            py = "uv run" if uv else ".venv/bin/python -m"
            install = "uv sync" if uv else "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
            if (d / "manage.py").exists():
                run = f"{py} python manage.py runserver 127.0.0.1:{{port}}" if uv else ".venv/bin/python manage.py runserver 127.0.0.1:{{port}}"
                kind, web = "py-django", True
            elif "fastapi" in low or "uvicorn" in low:
                app = _py_app(d) or "main:app"
                run = f"{py} uvicorn {app} --reload --port {{port}}" if uv else f".venv/bin/uvicorn {app} --reload --port {{port}}"
                kind, web = "py-fastapi", True
            elif "flask" in low:
                app = _py_app(d) or "app:app"
                run = f"FLASK_APP={app} {py} flask run --port {{port}}" if uv else f"FLASK_APP={app} .venv/bin/flask run --port {{port}}"
                kind, web = "py-flask", True
            else:
                continue
            out.append({"id": _rel(d, root) or ".", "dir": _rel(d, root) or ".", "label": f"{d.name or 'api'} · {kind[3:]}", "kind": kind, "web": web, "install": install, "run": run,
                        "needs_install": not ((d / ".venv").exists() or (uv and (d / ".venv").exists()))})
    # --- docker compose (only as an alternative; needs docker running)
    for name in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
        f = root / name
        if f.exists() and shutil.which("docker"):
            out.append({"id": "docker", "dir": ".", "label": "docker compose (todos los servicios)", "kind": "docker", "web": False, "install": "", "run": "docker compose up", "needs_install": False})
            break
    out.sort(key=lambda s: (not s["web"], s["kind"].startswith("py"), s["kind"] == "docker", s["id"]))  # UI first, then APIs, then docker
    return out


# ------------------------------------------------------------------ run

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


HOSTS = ("127.0.0.1", "::1")  # dev servers bind to one or the other (vite without --host listens on ::1 only)


async def _connect(port: int, timeout: float = 0.8):
    last: Exception | None = None
    for host in HOSTS:
        try:
            return await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        except Exception as e:  # noqa: BLE001
            last = e
    raise last or OSError("no host")


async def _host_of(port: int) -> str:
    """Which loopback address the server actually listens on (the proxy must target that one)."""
    for host in HOSTS:
        try:
            _, w = await asyncio.wait_for(asyncio.open_connection(host, port), 0.8)
            w.close()
            return host
        except Exception:  # noqa: BLE001
            continue
    return "127.0.0.1"


async def _port_open(port: int) -> bool:
    try:
        _, w = await _connect(port)
        w.close()
        return True
    except Exception:
        return False


async def _serves_html(port: int) -> bool | None:
    """GET / and tell whether the answer looks like a web page (None: no answer at all)."""
    try:
        r, w = await _connect(port)
        w.write(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        await w.drain()
        head = await asyncio.wait_for(r.read(4096), 2.0)
        w.close()
    except Exception:
        return None
    h = head.decode("utf-8", "replace").lower()
    return "text/html" in h or "<!doctype html" in h or "<html" in h


async def pick_web_port(candidates: list[int]) -> int | None:
    """Several servers may come up from one `dev` script (vite + an API worker, next + a mock server…): the one to
    frame is the one that serves a page. First HTML answer wins; else the first port that answers at all."""
    first_open = None
    for port in candidates:
        kind = await _serves_html(port)
        if kind:
            return port
        if kind is False and first_open is None:
            first_open = port
    return first_open


class AppRun:
    """One running dev server for a build."""

    def __init__(self, root: Path, service: dict, user_id: str, build_id: str, files: dict[str, str], emit: Callable[[str, dict], None]) -> None:
        self.root, self.service, self.emit = root, service, emit
        self.user_id, self.build_id, self.files = user_id, build_id, files
        self.port = free_port()
        self.url: str | None = None
        self.embed_url: str | None = None  # same app through the frame proxy (framing headers stripped)
        self.proxy: FrameProxy | None = None
        self.status = "idle"
        self.error: str | None = None
        self.logs: list[str] = []
        self.proc: asyncio.subprocess.Process | None = None
        self.task: asyncio.Task | None = None
        self.started = time.time()
        self.host = "127.0.0.1"
        self.token = secrets.token_urlsafe(16)  # the app's address through Muse Team (/r/<token>/)
        self.fix: dict | None = None  # Muse Team fixing it: {state: fixing|restarting|needs_approval|stuck|manual, since, what, fix, impact, id}
        self.quiet = False  # a check run by the build itself: its failures are the check's, not the self-healing's
        TOKENS[self.token] = self

    def state(self) -> dict:
        return {"status": self.status, "service": self.service["id"], "label": self.service["label"], "url": self.url, "embed_url": self.embed_url, "port": self.port, "error": self.error,
                "logs": self.logs[-200:], "started": self.started, "fix": self.fix}

    def _set(self, status: str, **extra) -> None:
        changed = status != self.status
        self.status = status
        for k, v in extra.items():
            setattr(self, k, v)
        if changed and ON_STATUS and not self.quiet:
            try:
                ON_STATUS(self)
            except Exception:  # pragma: no cover
                pass
        self.announce()

    def announce(self) -> None:
        self.emit("app.status", {"status": self.status, "service": self.service["id"], "label": self.service["label"], "url": self.url, "embed_url": self.embed_url, "port": self.port, "error": self.error,
                                 "fix": self.fix, "started": self.started})

    def _log(self, line: str) -> None:
        line = line[-400:]
        self.logs.append(line)
        self.logs = self.logs[-600:]
        self.emit("app.log", {"line": line})

    async def _stream(self, cmd: str, cwd: Path, env: dict, timeout: float) -> int:
        self.proc = await asyncio.create_subprocess_shell(cmd, cwd=str(cwd), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL, start_new_session=True, limit=8 * 1024 * 1024)
        assert self.proc.stdout

        async def pump():
            async for raw in self.proc.stdout:  # type: ignore[union-attr]
                self._log(raw.decode("utf-8", "replace").rstrip())

        try:
            await asyncio.wait_for(pump(), timeout=timeout)
        except asyncio.TimeoutError:
            self.kill()
            self._log("(timeout)")
            return 124
        return await self.proc.wait()

    def kill(self) -> None:
        p = self.proc
        if p and p.returncode is None:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    async def run(self) -> None:
        s = self.service
        cwd = self.root / s["dir"]
        env = {**os.environ, "PORT": str(self.port), "HOST": "127.0.0.1", "BROWSER": "none", "CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "PYTHONUNBUFFERED": "1"}
        # where the app keeps its data while it is tried without DATABASE_URL: inside the project, on Muse Team's volume, so a restart loses nothing
        data_dir = self.root / ".data"
        data_dir.mkdir(exist_ok=True)
        env.setdefault("TABLY_DATA_DIR", str(data_dir))
        if RUN_BASE or os.environ.get("TABLY_CLOUD_URL"):  # connected accounts (Google Calendar…) and AI-call reports, read/sent through Muse Team
            from .cloud import public_url
            from .observe import app_token

            env.setdefault("TABLY_URL", public_url())
            env.setdefault("TABLY_SITE", f"run-{self.build_id}")
            env.setdefault("TABLY_TOKEN", app_token(f"run-{self.build_id}"))
        for var, val in (("PGLITE_DIR", data_dir / "pglite"), ("PGLITE_DATA_DIR", data_dir / "pglite"), ("DATA_DIR", data_dir), ("SQLITE_PATH", data_dir / "app.db"), ("DB_PATH", data_dir / "app.db")):
            env.setdefault(var, str(val))  # the names apps use most for a local database folder or file
        # the saved service values → .env (never overwrite one the agent/user already wrote)
        values = load_secrets(self.user_id, self.build_id)
        for d in {self.root, cwd}:
            if values and not (d / ".env").exists():
                try:
                    (d / ".env").write_text(render_env(values, self.files))
                    self._log(f"· .env escrito en {d.relative_to(self.root) or '.'} con {len(values)} variables")
                except Exception:
                    pass
        try:
            if s["install"] and s.get("needs_install"):
                self._set("installing")
                self._log(f"$ {s['install']}")
                code = await self._stream(s["install"], cwd, env, INSTALL_TIMEOUT)
                if code != 0:
                    self._set("error", error=f"La instalación de dependencias falló (código {code}).")
                    return
            self._set("starting")
            cmd = s["run"].replace("{port}", str(self.port))
            self._log(f"$ {cmd}")
            server = asyncio.create_task(self._stream(cmd, cwd, env, 24 * 3600))
            t0 = time.time()
            while time.time() - t0 < READY_TIMEOUT:
                if server.done():
                    code = server.result()
                    if self._wrangler_corrupt_cleanup():
                        return
                    self._set("error", error=f"El servidor terminó antes de arrancar (código {code}). Revisá los logs." if code else "El servidor terminó sin levantar un puerto.")
                    return
                # servers that picked their own port say so in the logs; a dev script may start several (vite + an
                # API worker): frame the one that serves a page, not whichever URL was printed last
                seen: list[int] = [self.port]
                for line in self.logs[-60:]:
                    for m in re.finditer(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)", line):
                        pt = int(m.group(1))
                        if pt not in seen:
                            seen.append(pt)
                chosen = await pick_web_port(seen) if len(seen) > 1 else (self.port if await _port_open(self.port) else None)
                if chosen is not None and chosen != self.port:
                    self.port = chosen
                    self._log(f"· la app responde en el puerto {chosen}")
                if chosen is not None:
                    host = await _host_of(self.port)
                    self.host = host
                    self.url = f"http://localhost:{self.port}" if host != "127.0.0.1" else f"http://127.0.0.1:{self.port}"
                    if RUN_BASE:  # Muse Team on a server: the browser reaches the app through Muse Team's own address
                        self.url = self.embed_url = f"{RUN_BASE}/r/{self.token}/"
                        self._log(f"· la app se ve en {self.url}")
                        self._set("running")
                        code = await server
                        if self.status == "running":
                            self._set("stopped" if code in (0, -15, 143, None) else "error", error=None if code in (0, -15, 143, None) else f"El servidor se cerró (código {code}).")
                        return
                    try:  # the UI frames the proxy, not the app: production CSP/X-Frame-Options would blank the iframe
                        self.proxy = FrameProxy(self.port, free_port(), host)
                        await self.proxy.start()
                        self.embed_url = self.proxy.url
                        self._log(f"· vista embebida en {self.embed_url} (sin cabeceras anti-iframe)")
                    except Exception as e:  # pragma: no cover
                        self._log(f"· no pude levantar el proxy de vista embebida: {e}")
                        self.proxy, self.embed_url = None, None
                    self._set("running")
                    code = await server
                    if self.status == "running":
                        if code not in (0, -15, 143, None) and self._wrangler_corrupt_cleanup():
                            return
                        self._set("stopped" if code in (0, -15, 143, None) else "error", error=None if code in (0, -15, 143, None) else f"El servidor se cerró (código {code}).")
                    return
                await asyncio.sleep(1)
            self.kill()
            self._set("error", error=f"No respondió en el puerto {self.port} después de {READY_TIMEOUT}s.")
        except asyncio.CancelledError:
            self.kill()
            self._set("stopped")
            raise
        except Exception as e:  # pragma: no cover
            self.kill()
            self._set("error", error=str(e)[:300])

    def _wrangler_corrupt_cleanup(self) -> bool:
        """wrangler's local KV/DO cache (`.wrangler/state`, often shipped inside an uploaded zip) is a throwaway: when the
        worker dies with SQLITE_CORRUPT, every such folder under the project is removed and the run ends with a retry hint."""
        tail = "\n".join(self.logs[-120:])
        if "SQLITE_CORRUPT" not in tail:
            return False
        removed = []
        for d in self.root.rglob(".wrangler"):
            if "node_modules" in d.parts or not (d / "state").exists():
                continue
            shutil.rmtree(d / "state", ignore_errors=True)
            removed.append(_rel(d / "state", self.root))
        if not removed:
            return False
        self._log("· caché local de wrangler corrupto: se borró " + ", ".join(removed) + ". Volvé a correr la app.")
        self._set("error", error="El worker de Cloudflare se cayó por un caché local corrupto (.wrangler/state). Ya se limpió: tocá «Reintentar».")
        return True

    async def stop(self) -> None:
        if self.proxy:
            await self.proxy.stop()
            self.proxy = None
        self.kill()
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        p = self.proc
        if p and p.returncode is None:  # SIGTERM was polite; make sure the port is actually free
            try:
                await asyncio.wait_for(p.wait(), 5)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                except Exception:
                    pass
                await p.wait()
        if self.status not in ("error", "stopped"):
            self._set("stopped")


RUNS: dict[str, AppRun] = {}
TOKENS: dict[str, AppRun] = {}


async def stop_all() -> None:
    for r in list(RUNS.values()):
        await r.stop()


# ------------------------------------------------------------------ devices (iOS Simulator · Android emulator)

def _adb() -> str | None:
    for c in (shutil.which("adb"), os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"), os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb"), os.path.join(os.environ.get("ANDROID_SDK_ROOT", ""), "platform-tools", "adb")):
        if c and os.path.exists(c):
            return c
    return None


def _sh(cmd: list[str], timeout: float = 15) -> tuple[int, bytes]:
    import subprocess

    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return p.returncode, p.stdout
    except Exception:  # noqa: BLE001
        return 1, b""


def devices() -> dict:
    """What this machine can run: the iOS Simulator (macOS + Xcode with an iOS runtime) and the Android emulator (SDK + adb)."""
    ios = {"ok": False, "hint": None, "booted": None}
    if shutil.which("xcrun"):
        code, out = _sh(["xcrun", "simctl", "list", "devices", "available", "-j"], 20)
        try:
            devs = [d for v in json.loads(out or b"{}").get("devices", {}).values() for d in v if "iPhone" in d.get("name", "")]
        except Exception:  # noqa: BLE001
            devs = []
        if code != 0:
            ios["hint"] = "Xcode no está instalado o no está seleccionado (xcode-select)."
        elif not devs:
            ios["hint"] = "Xcode no tiene ningún simulador de iPhone: en Xcode → Settings → Components instalá un runtime de iOS."
        else:
            ios["ok"] = True
            ios["booted"] = next((d["name"] for d in devs if d.get("state") == "Booted"), None)
    else:
        ios["hint"] = "El simulador de iOS necesita una Mac con Xcode."
    android = {"ok": False, "hint": None, "booted": None}
    adb = _adb()
    if adb:
        code, out = _sh([adb, "devices"], 10)
        lines = [l for l in out.decode(errors="replace").splitlines()[1:] if l.strip() and "\tdevice" in l]
        android["ok"] = True
        android["booted"] = lines[0].split("\t")[0] if lines else None
        if not lines:
            android["hint"] = "No hay un emulador encendido: abrí uno desde Android Studio → Device Manager (Expo lo detecta solo)."
    else:
        android["hint"] = "Instalá Android Studio (SDK + adb) y creá un dispositivo virtual en Device Manager."
    return {"ios": ios, "android": android}


def screenshot(target: str) -> bytes | None:
    """PNG of the booted device's screen (what the panel shows, refreshed every second)."""
    if target == "ios":
        code, out = _sh(["xcrun", "simctl", "io", "booted", "screenshot", "--type=png", "-"], 10)
        return out if code == 0 and out[:4] == b"\x89PNG" else None
    adb = _adb()
    if not adb:
        return None
    code, out = _sh([adb, "exec-out", "screencap", "-p"], 10)
    return out if code == 0 and out[:4] == b"\x89PNG" else None


def tap(target: str, x: int, y: int) -> bool:
    """A tap at device pixels. Android via adb; the iOS Simulator has no public tap API (the user taps in the Simulator window)."""
    if target == "android" and (adb := _adb()):
        return _sh([adb, "shell", "input", "tap", str(int(x)), str(int(y))], 10)[0] == 0
    return False
