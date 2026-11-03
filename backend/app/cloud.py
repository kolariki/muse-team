"""Muse Cloud: publish a built project with one click, provision its database/auth, and take it elsewhere later.

The experience is ours; the infrastructure is commodity, driven by API from the operator's accounts (see docs/tably-cloud.md):

  static apps   → `local` (always available: the backend serves the build under /apps/<slug>/) or `cloudflare` (Pages)
  server apps   → `railway` (one Railway project per app on the operator's workspace, with its own Postgres when the app
                  uses one) or `fly` (Fly Machines); a Dockerfile is generated when the project has none
  database      → Neon (one Postgres project per app)
  auth/storage  → Supabase (one project per app)

Everything provisioned is standard (static build, Dockerfile, Postgres, git), so "Migrar" is just pointing the same
pipeline at the user's own accounts (Vercel/Railway via deploy.py) plus a pg_dump command for the data.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from .auth import _db
from .config import DATA_DIR, env
from . import deploy as deploymod
from . import identity as identitymod
from . import observe as observemod
from . import incidents as incidentsmod
from . import leaks as leaksmod
from . import lessons as lessonsmod
from . import runner as runmod

log = logging.getLogger("arena.cloud")

APPS_ROOT = Path(env("ARENA_APPS_DIR", str(DATA_DIR.parent / "apps")))
APPS_ROOT.mkdir(parents=True, exist_ok=True)
Log = Callable[[str], Awaitable[None] | None]

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS cloud_apps (
            user_id TEXT NOT NULL, build_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
            kind TEXT NOT NULL, status TEXT NOT NULL, url TEXT, version INTEGER, error TEXT, log TEXT, db TEXT,
            created REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY (user_id, build_id))"""
    )


# ------------------------------------------------------------------------------------------------ operator status

def _railway_token(user_id: str | None = None) -> str:
    """The operator's workspace token (every app on Muse Team's account) or, without one, the Railway token the user connected
    in Settings → Deploy (their apps on their own Railway, billed to them)."""
    if env("TABLY_CLOUD_RAILWAY_TOKEN"):
        return env("TABLY_CLOUD_RAILWAY_TOKEN") or ""
    if not user_id:
        return ""
    from .keystore import get_key

    return get_key(user_id, "railway") or ""

def public_url() -> str:
    return (env("TABLY_CLOUD_URL") or "http://localhost:8000").rstrip("/")


def status(user_id: str | None = None) -> dict:
    """Which capabilities this installation has (operator env vars + CLIs; Railway also with the user's own token)."""
    cf = bool(env("CF_API_TOKEN") and env("CF_ACCOUNT_ID"))
    fly = bool(env("FLY_API_TOKEN")) and bool(shutil.which("flyctl") or shutil.which("fly"))
    rw = bool(_railway_token(user_id)) and bool(shutil.which("railway"))
    return {
        "static": "cloudflare" if cf else "local",
        "server": "railway" if rw else "fly" if fly else None,
        "database": "neon" if env("NEON_API_KEY") else None,
        "auth": "supabase" if env("SUPABASE_ACCESS_TOKEN") else None,
        "missing": {
            "cloudflare": None if cf else "CF_API_TOKEN y CF_ACCOUNT_ID en el .env del backend (token con permiso Pages: Edit)",
            "fly": None if fly else ("FLY_API_TOKEN en el .env del backend" if not env("FLY_API_TOKEN") else "flyctl no está instalado en el servidor"),
            "railway": None if rw else ("un token de Railway (conectalo en Configuración → Deploy)" if not _railway_token(user_id) else "la CLI de Railway no está instalada en el servidor"),
            "neon": None if env("NEON_API_KEY") else "NEON_API_KEY en el .env del backend",
            "supabase": None if env("SUPABASE_ACCESS_TOKEN") else "SUPABASE_ACCESS_TOKEN y SUPABASE_ORG_ID en el .env del backend",
        },
        "public_url": public_url(),
    }


# ------------------------------------------------------------------------------------------------ records

def _row_to_app(r) -> dict:
    d = dict(r)
    d["log"] = json.loads(d["log"] or "[]")
    d["db"] = json.loads(d["db"] or "{}")
    return d


def get_app(user_id: str, build_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM cloud_apps WHERE user_id = ? AND build_id = ?", (user_id, build_id)).fetchone()
    return _row_to_app(r) if r else None


def list_apps(user_id: str) -> list[dict]:
    with _db() as c:
        return [_row_to_app(r) for r in c.execute("SELECT * FROM cloud_apps WHERE user_id = ? ORDER BY updated DESC", (user_id,))]


def _save(app: dict) -> None:
    with _db() as c:
        c.execute(
            """INSERT INTO cloud_apps (user_id, build_id, slug, provider, kind, status, url, version, error, log, db, created, updated)
               VALUES (:user_id, :build_id, :slug, :provider, :kind, :status, :url, :version, :error, :log, :db, :created, :updated)
               ON CONFLICT(user_id, build_id) DO UPDATE SET slug=excluded.slug, provider=excluded.provider, kind=excluded.kind, status=excluded.status, url=excluded.url,
               version=excluded.version, error=excluded.error, log=excluded.log, db=excluded.db, updated=excluded.updated""",
            {**app, "log": json.dumps(app["log"][-300:]), "db": json.dumps(app.get("db") or {}), "updated": time.time()},
        )


def public(app: dict | None) -> dict | None:
    """Never ship secrets to the browser: the db block only says what exists."""
    if not app:
        return None
    db = app.get("db") or {}
    return {**app, "deploy_logs": (db.get("railway") or {}).get("logs"),
            "leaks": db.get("leaks"),
            "db": {k: {"provider": v.get("provider"), "ok": v.get("ok"), "vars": v.get("vars", []), "host": v.get("host"), "ts": v.get("ts")} for k, v in db.items() if k not in ("railway", "leaks")}}


def slug_for(user_id: str, build_id: str, title: str) -> str:
    base = re.sub(r"[^a-z0-9-]+", "-", (title or "app").lower()).strip("-")[:40] or "app"
    with _db() as c:
        taken = {r[0] for r in c.execute("SELECT slug FROM cloud_apps WHERE slug LIKE ?", (base + "%",))}
        own = c.execute("SELECT slug FROM cloud_apps WHERE user_id = ? AND build_id = ?", (user_id, build_id)).fetchone()
    if own:
        return own[0]
    if base not in taken:
        return base
    for _ in range(50):
        s = f"{base}-{secrets.token_hex(2)}"
        if s not in taken:
            return s
    return f"{base}-{secrets.token_hex(4)}"


# ------------------------------------------------------------------------------------------------ build detection

STATIC_DIRS = ("dist", "build", "out", ".output/public", "public")


def classify(root: Path) -> dict:
    """What the project is: a static site (vite/plain) to upload, or a server app to containerise."""
    services = [s for s in runmod.detect(root) if s["kind"] != "docker"]
    web = next((s for s in services if s["web"]), None)
    if not services:
        if (root / "index.html").exists():
            return {"kind": "static", "service": None, "dir": ".", "build": None, "out": "."}
        return {"kind": "unknown", "service": None, "dir": ".", "build": None, "out": None}
    svc = web or services[0]
    d = root / svc["dir"]
    pm = runmod._pm(d)
    if svc["kind"] in ("vite", "next", "nuxt", "node"):
        try:
            pj = json.loads((d / "package.json").read_text())
        except Exception:  # noqa: BLE001
            pj = {}
        scripts = pj.get("scripts") or {}
        has_build = "build" in scripts
        if svc["kind"] == "vite" or (svc["kind"] == "node" and has_build and not any(k in (pj.get("dependencies") or {}) for k in ("express", "fastify", "koa", "hono"))):
            return {"kind": "static", "service": svc, "dir": svc["dir"], "pm": pm, "build": f"{pm} run build" if has_build else None, "out": None}
        if svc["kind"] == "next":
            cfg = ""
            for name in ("next.config.js", "next.config.mjs", "next.config.ts"):
                if (d / name).exists():
                    cfg = (d / name).read_text(errors="replace")
            if "output" in cfg and "export" in cfg:
                return {"kind": "static", "service": svc, "dir": svc["dir"], "pm": pm, "build": f"{pm} run build", "out": "out"}
            return {"kind": "server", "service": svc, "dir": svc["dir"], "pm": pm, "build": f"{pm} run build" if has_build else None, "start": f"{pm} run start" if "start" in scripts else "node server.js", "runtime": "node"}
        return {"kind": "server", "service": svc, "dir": svc["dir"], "pm": pm, "build": f"{pm} run build" if has_build else None, "start": "npm start" if "start" in scripts else f"node {pj.get('main') or 'index.js'}", "runtime": "node"}
    if svc["kind"].startswith("py"):
        return {"kind": "server", "service": svc, "dir": svc["dir"], "build": None, "runtime": "python", "pykind": svc["kind"]}
    return {"kind": "unknown", "service": svc, "dir": svc["dir"], "build": None, "out": None}


def find_out_dir(d: Path, hint: str | None) -> Path | None:
    cands = [hint] if hint else []
    cands += list(STATIC_DIRS)
    for c in cands:
        p = d / c
        if p.is_dir() and (p / "index.html").exists():
            return p
    return d if (d / "index.html").exists() and not (d / "package.json").exists() else None


# ------------------------------------------------------------------------------------------------ publish

async def _call(logf: Log, line: str) -> None:
    r = logf(line)
    if asyncio.iscoroutine(r):
        await r


def _node_env(values: dict[str, str]) -> dict:
    return {**os.environ, **values, "CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "BROWSER": "none"}


async def _build_static(root: Path, cls: dict, slug: str, provider: str, values: dict[str, str], logf: Log) -> Path | None:
    d = root / cls["dir"]
    if cls.get("build"):
        pm = cls.get("pm", "npm")
        if not (d / "node_modules").exists():
            await _call(logf, f"$ {pm} install")
            code, _ = await deploymod._stream([*pm.split(), "install"], d, _node_env(values), logf, timeout=900)
            if code != 0:
                await _call(logf, f"✗ la instalación falló (código {code})")
                return None
        cmd = cls["build"].split()
        # under /apps/<slug>/ the assets are not at the domain root: vite takes --base, everything else must use relative URLs
        if provider == "local" and cls["service"] and cls["service"]["kind"] == "vite":
            cmd += (["--", f"--base=/apps/{slug}/"] if pm == "npm" else [f"--base=/apps/{slug}/"])
        await _call(logf, f"$ {' '.join(cmd)}")
        code, _ = await deploymod._stream(cmd, d, _node_env(values), logf, timeout=900)
        if code != 0:
            await _call(logf, f"✗ el build falló (código {code})")
            return None
    out = find_out_dir(d, cls.get("out"))
    if not out:
        await _call(logf, "✗ no encontré la carpeta del build (dist/, build/, out/) con un index.html")
    return out


async def _publish_local(out: Path, slug: str, logf: Log) -> dict:
    dest = APPS_ROOT / slug
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(out, dest, ignore=shutil.ignore_patterns("node_modules", ".git"))
    url = f"{public_url()}/apps/{slug}/"
    await _call(logf, f"✓ publicada en {url}")
    return {"ok": True, "url": url}


async def _publish_cloudflare(out: Path, slug: str, logf: Log) -> dict:
    token, account = env("CF_API_TOKEN"), env("CF_ACCOUNT_ID")
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=60) as cx:
        r = await cx.get(f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{slug}", headers=headers)
        if r.status_code == 404:
            await _call(logf, f"· creando el proyecto Pages «{slug}»")
            r = await cx.post(f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects", headers=headers, json={"name": slug, "production_branch": "main"})
            if r.status_code >= 300:
                return {"ok": False, "url": None, "error": f"Cloudflare no dejó crear el proyecto: {r.text[:200]}"}
    npx = shutil.which("npx")
    if not npx:
        return {"ok": False, "url": None, "error": "npx no está instalado en el servidor (hace falta para wrangler)"}
    cmd = [npx, "--yes", "wrangler@3", "pages", "deploy", str(out), "--project-name", slug, "--branch", "main", "--commit-dirty=true"]
    await _call(logf, "$ npx wrangler pages deploy …")
    code, text = await deploymod._stream(cmd, out, {**os.environ, "CLOUDFLARE_API_TOKEN": token, "CLOUDFLARE_ACCOUNT_ID": account, "CI": "1", "NO_COLOR": "1"}, logf, timeout=900)
    if code != 0:
        return {"ok": False, "url": None, "error": "wrangler falló: " + (text.strip().splitlines() or ["?"])[-1][:300]}
    dom = env("CF_PAGES_DOMAIN")
    url = f"https://{slug}.{dom}" if dom else f"https://{slug}.pages.dev"
    await _call(logf, f"✓ publicada en {url}")
    return {"ok": True, "url": url}


GENERATED = "# generated by Muse Team"
DOCKER_NODE = GENERATED + """ (deleting this line keeps your edits)
FROM node:{node}-alpine AS build
WORKDIR /app
COPY . .
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_OPTIONS=--max-old-space-size=3072
RUN ({install}) && ({build})
ENV NODE_ENV=production NODE_OPTIONS= PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD {start}
"""
DOCKER_PY = GENERATED + """ (deleting this line keeps your edits)
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir uv && (test -f pyproject.toml && uv pip install --system . || pip install --no-cache-dir -r requirements.txt)
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD {start}
"""


def _pkg_json(d: Path) -> dict:
    try:
        return json.loads((d / "package.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def _workspace(root: Path, d: Path) -> bool:
    """The service is part of a monorepo: its dependencies (workspace:*) live in sibling folders, so the image needs the whole repo."""
    pj = _pkg_json(root)
    return (root / "pnpm-workspace.yaml").exists() or bool(pj.get("workspaces")) or "workspace:" in json.dumps(_pkg_json(d))


def _node_pm(root: Path, d: Path) -> str:
    """The package manager the project uses, read from its files (not from what is installed on this server: the build runs in the image)."""
    for x in (d, root):
        pm = str(_pkg_json(x).get("packageManager") or "").split("@")[0]
        if pm in ("pnpm", "yarn", "bun", "npm"):
            return pm
    for x in (d, root):
        if (x / "pnpm-lock.yaml").exists() or (x / "pnpm-workspace.yaml").exists():
            return "pnpm"
        if (x / "yarn.lock").exists():
            return "yarn"
        if (x / "bun.lockb").exists() or (x / "bun.lock").exists():
            return "bun"
        if (x / "package-lock.json").exists():
            return "npm"
    # npm does not understand workspace:* at all; pnpm does
    return "pnpm" if "workspace:" in json.dumps(_pkg_json(d)) + json.dumps(_pkg_json(root)) else "npm"


def _dockerfile(cls: dict, d: Path, root: Path | None = None) -> str:
    """A Dockerfile for the detected service. With `root` (a monorepo) it is built from the repo root, entering the service folder."""
    if cls.get("runtime") == "python":
        app = runmod._py_app(d) or "main:app"
        start = {"py-django": 'sh -c "python manage.py migrate && gunicorn --bind 0.0.0.0:8080 $(python -c \\"import os;print(os.environ.get(\'DJANGO_WSGI\',\'config.wsgi\'))\\")"',
                 "py-flask": f'sh -c "gunicorn --bind 0.0.0.0:8080 {app}"'}.get(cls.get("pykind", ""), f'sh -c "uvicorn {app} --host 0.0.0.0 --port 8080"')
        return DOCKER_PY.format(start=start)
    pm = _node_pm(root or d, d)
    want = str((_pkg_json(d).get("engines") or {}).get("node") or (_pkg_json(root or d).get("engines") or {}).get("node") or "")
    majors = [int(x) for x in re.findall(r"\d+", want.split("||")[-1])[:1]]
    # «>=20» is a minimum (the current LTS satisfies it); «20.x», «^20», «~20» or «20» pin that major
    node = "22" if not majors or want.strip().startswith(">") and majors[0] <= 22 else str(min(max(majors[0] - want.strip().startswith("<"), 18), 24))
    has_pin = bool(_pkg_json(d).get("packageManager") or _pkg_json(root or d).get("packageManager"))
    setup = "corepack enable" if has_pin and pm in ("pnpm", "yarn") else {"pnpm": "npm i -g pnpm@9", "bun": "npm i -g bun"}.get(pm, "true")
    install = setup + " && (" + {"pnpm": "pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile", "yarn": "yarn install --frozen-lockfile || yarn install",
                                 "bun": "bun install"}.get(pm, "npm ci || npm install") + ")"
    run = lambda script: f"{pm} run {script}"  # noqa: E731
    build = run("build") if "build" in (_pkg_json(d).get("scripts") or {}) else "true"
    start = cls.get("start") or "npm start"
    if start.split()[0] in ("npm", "pnpm", "yarn", "bun") and start.split()[1:2] in (["start"], ["run"]):
        start = run(start.split()[-1])
    sub = cls.get("dir") or "."
    if root is not None and sub != ".":
        build = f"cd {sub} && {build}"
        return DOCKER_NODE.format(node=node, install=install, build=build, start=json.dumps(["sh", "-c", f"cd {sub} && {start}"]))
    return DOCKER_NODE.format(node=node, install=install, build=build, start=json.dumps(start.split()))


async def _place_dockerfile(root: Path, cls: dict, logf: Log) -> Path:
    """Where the image is built from, writing the Dockerfile there when the project has none of its own.
    The project's own Dockerfile at the root wins (it is how the team packaged the whole app); one we generated earlier is rewritten."""
    own = lambda p: p.exists() and not p.read_text(errors="replace").startswith(GENERATED)  # noqa: E731
    if own(root / "Dockerfile"):
        return root
    d = root / cls["dir"]
    mono = cls.get("dir", ".") != "." and _workspace(root, d)
    ctx = root if mono else d
    if not own(ctx / "Dockerfile"):
        (ctx / "Dockerfile").write_text(_dockerfile(cls, d, root if mono else None))
        await _call(logf, "· Dockerfile generado" + (" (monorepo: se construye desde la raíz)" if mono else " (el proyecto no tenía uno)"))
    if not (ctx / ".dockerignore").exists():
        (ctx / ".dockerignore").write_text("node_modules\n**/node_modules\n.git\n.venv\n.env\ndist-preview\ncoverage\n")
    return ctx


async def _publish_fly(root: Path, cls: dict, slug: str, values: dict[str, str], logf: Log) -> dict:
    fly = shutil.which("flyctl") or shutil.which("fly")
    if not fly:
        return {"ok": False, "url": None, "error": "flyctl no está instalado en el servidor"}
    d = await _place_dockerfile(root, cls, logf)
    fenv = {**os.environ, "FLY_API_TOKEN": env("FLY_API_TOKEN") or "", "NO_COLOR": "1", "CI": "1"}
    app_name = f"tably-{slug}"[:30].rstrip("-")
    org = env("FLY_ORG") or "personal"
    region = env("FLY_REGION") or "gru"
    if not (d / "fly.toml").exists():
        (d / "fly.toml").write_text(f'app = "{app_name}"\nprimary_region = "{region}"\n\n[build]\n\n[http_service]\n  internal_port = 8080\n  force_https = true\n  auto_stop_machines = "stop"\n  auto_start_machines = true\n  min_machines_running = 0\n\n[[vm]]\n  size = "shared-cpu-1x"\n  memory = "512mb"\n')
        await _call(logf, f"$ fly apps create {app_name}")
        code, text = await deploymod._stream([fly, "apps", "create", app_name, "--org", org], d, fenv, logf, timeout=120)
        if code != 0 and "already" not in text.lower():
            return {"ok": False, "url": None, "error": "fly apps create falló: " + (text.strip().splitlines() or ["?"])[-1][:300]}
    if values:
        await _call(logf, f"$ fly secrets set ({len(values)} variables)")
        code, text = await deploymod._stream([fly, "secrets", "set", "--app", app_name, "--stage", *[f"{k}={v}" for k, v in values.items()]], d, fenv, logf, timeout=120)
        if code != 0:
            await _call(logf, "⚠ no se pudieron cargar las variables: " + (text.strip().splitlines() or ["?"])[-1][:200])
    await _call(logf, "$ fly deploy --remote-only")
    code, text = await deploymod._stream([fly, "deploy", "--app", app_name, "--remote-only", "--ha=false", "--yes"], d, fenv, logf, timeout=1800)
    if code != 0:
        return {"ok": False, "url": None, "error": "fly deploy falló: " + (text.strip().splitlines() or ["?"])[-1][:300]}
    url = f"https://{app_name}.fly.dev"
    await _call(logf, f"✓ publicada en {url}")
    return {"ok": True, "url": url}


RAILWAY_SERVICE = "web"
RAILWAY_HOME = APPS_ROOT / ".railway-cli"  # the CLI's own config (which folder is linked to which project) lives apart


def _railway_env(user_id: str | None = None) -> dict:
    """A clean environment for the CLI. Muse Team itself runs on Railway, which injects RAILWAY_* variables about OUR project:
    none of them may reach the CLI, or it could deploy into Muse Team's own project. Only the operator's workspace token goes."""
    RAILWAY_HOME.mkdir(parents=True, exist_ok=True)
    base = {k: v for k, v in os.environ.items() if not k.startswith("RAILWAY_")}
    return {**base, "RAILWAY_API_TOKEN": _railway_token(user_id), "HOME": str(RAILWAY_HOME), "NO_COLOR": "1", "CI": "1"}


def _uses_postgres(d: Path) -> bool:
    for name in (".env.example", "package.json", "requirements.txt", "pyproject.toml", "prisma/schema.prisma", "drizzle.config.ts", "docker-compose.yml"):
        try:
            if re.search(r"postgres|DATABASE_URL|\bpg\b", (d / name).read_text(errors="replace"), re.I):
                return True
        except OSError:
            continue
    return False


_RW_HELP: dict[str, str] = {}


def _rw_has(rw: str, sub: str, flag: str) -> bool:
    """Whether this CLI version knows a flag (or, with sub == "", a command): the CLI changed between 4.x releases
    (`init --json`, `variable set`, `delete` are newer), and the server and a local install can be on different ones."""
    if sub not in _RW_HELP:
        code, text = deploymod._run_sync([rw, *([sub] if sub else []), "--help"], env=_railway_env(), timeout=20)
        _RW_HELP[sub] = text if code == 0 else ""
    return bool(re.search(rf"(^|\s){re.escape(flag)}\b", _RW_HELP[sub], re.M))


async def _wait_until_up(url: str, logf: Log, timeout: float = 900, failed: Callable[[], Awaitable[bool]] | None = None) -> bool | None:
    """The app answers on its URL (anything but Railway's own «not found / starting» responses). None: `failed` said the
    deployment broke (Railway knows it in seconds; no need to wait the whole timeout)."""
    start, last_note = time.time(), 0.0
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cx:
        while time.time() - start < timeout:
            if failed and await failed():
                return None
            try:
                r = await cx.get(url)
                fallback = r.headers.get("x-railway-fallback") or "application not found" in r.text[:2000].lower()
                if r.status_code < 400 and not fallback:  # the home page loads (a 404 there means the app is not what was meant)
                    return True
                if r.status_code < 500 and not fallback and time.time() - start > 300:
                    for probe in ("/api/health", "/health", "/healthz"):  # an API-only app: up if its health check answers
                        h = await cx.get(url.rstrip("/") + probe)
                        if h.status_code == 200:
                            await _call(logf, f"⚠ la app responde {r.status_code} en su URL principal pero {probe} está OK: revisá qué sirve en «/»")
                            return True
            except httpx.HTTPError:
                pass
            if time.time() - last_note > 60:
                last_note = time.time()
                await _call(logf, f"· esperando a que la app responda ({int(time.time() - start) // 60} min)…")
            await asyncio.sleep(10)
    return False


RAILWAY_GQL = "https://backboard.railway.com/graphql/v2"


async def _rw_gql(token: str, query: str, variables: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as cx:
        r = await cx.post(RAILWAY_GQL, headers={"Authorization": f"Bearer {token}"}, json={"query": query, "variables": variables})
    return (r.json().get("data") or {}) if r.status_code == 200 else {}


async def railway_deployment_status(token: str, deployment: str) -> str | None:
    """BUILDING, DEPLOYING, SUCCESS, FAILED, CRASHED… (None when Railway can't be asked)."""
    try:
        return ((await _rw_gql(token, "query($id:String!){deployment(id:$id){status}}", {"id": deployment})).get("deployment") or {}).get("status")
    except (httpx.HTTPError, ValueError):
        return None


async def railway_failure_logs(token: str, deployment: str) -> str:
    """The end of the build log and of the app's own log: what the builder needs to fix it."""
    out = []
    for field, n, title in (("buildLogs", 120, "BUILD"), ("deploymentLogs", 80, "APP")):
        try:
            rows = (await _rw_gql(token, f"query($id:String!,$l:Int){{{field}(deploymentId:$id,limit:$l){{message}}}}", {"id": deployment, "l": 400})).get(field) or []
        except (httpx.HTTPError, ValueError):
            rows = []
        msgs = [r.get("message", "") for r in rows if r.get("message")]
        if msgs:
            out.append(f"--- {title} (últimas líneas) ---\n" + "\n".join(m[:400] for m in msgs[-n:]))
    return "\n".join(out)[-14000:]


_INTERNAL_SECRET = deploymod.INTERNAL_SECRET


_URL_VAR = re.compile(r"^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_)?(APP|API|SITE|BASE|PUBLIC|WEB|FRONTEND|BACKEND|SERVER)(_BASE)?_URL$|^NEXTAUTH_URL$")


def url_values(env_examples: list[str], values: dict[str, str], url: str | None) -> dict[str, str]:
    """The app's own address (APP_URL, API_URL, NEXT_PUBLIC_SITE_URL…) once it has one: the published URL, keeping the path
    the example shows (http://localhost:8787/api → https://app…/api). Never replaces a value the user set."""
    if not url:
        return {}
    base = url.rstrip("/")
    out: dict[str, str] = {}
    for text in env_examples:
        for r in deploymod.parse_env_example(text):
            var = r["var"]
            if var in values or var in out or not _URL_VAR.search(var):
                continue
            path = re.sub(r"^[a-z]+://[^/]+", "", (r.get("example") or "").strip().strip("'\""), flags=re.I) if re.match(r"^[a-z]+://", (r.get("example") or "").strip().strip("'\""), re.I) else ""
            out[var] = base + (path.rstrip("/") if path not in ("", "/") else "")
    return out


def _internal_secrets(root: Path, values: dict[str, str]) -> dict[str, str]:
    """Variables of .env.example the app signs or checks with itself (JWT_SECRET, SESSION_SECRET, METRICS_TOKEN…) and that
    have no value yet: random values. Keys of outside services (STRIPE_SECRET_KEY, GITHUB_TOKEN…) are never invented."""
    out: dict[str, str] = {}
    for ex in [root / ".env.example", *root.glob("*/.env.example"), *root.glob("*/*/.env.example")][:12]:
        try:
            rows = deploymod.parse_env_example(ex.read_text(errors="replace"))
        except OSError:
            continue
        for r in rows:
            var = r["var"]
            if var in values or var in out or not _INTERNAL_SECRET.search(var):
                continue
            svc = deploymod.classify(var)
            if svc["service"] != "Secreto propio" and svc["url"]:  # a known outside service: its key comes from its dashboard
                continue
            if any(re.search(rx, var, re.I) for rx, service, _u, _p in deploymod.KNOWN if service not in ("Secreto propio",)):
                continue
            out[var] = secrets.token_urlsafe(48)
    return out


def _last_line(text: str) -> str:
    return (text.strip().splitlines() or ["?"])[-1][:300]


async def _publish_railway(root: Path, cls: dict, slug: str, values: dict[str, str], prev: dict, logf: Log, user_id: str | None = None) -> dict:
    """One Railway project per app on the operator's workspace: an empty «web» service with the code (Dockerfile), its own
    Postgres when the app uses one, the user's variables, and a public *.up.railway.app domain. Republishing reuses it."""
    rw = shutil.which("railway")
    if not rw:
        return {"ok": False, "url": None, "error": "La CLI de Railway no está instalada en el servidor"}
    d = await _place_dockerfile(root, cls, logf)
    renv = _railway_env(user_id)
    meta = dict((prev.get("db") or {}).get("railway") or {})
    # Railway: project names are 1-32 characters; a short hash of the full slug keeps two long, similar names apart
    name = f"tably-{slug[:20].rstrip('-')}-{hashlib.sha1(slug.encode()).hexdigest()[:5]}"
    linked = False
    if meta.get("project"):  # republish: link this folder to the project created the first time
        code, _ = await deploymod._stream([rw, "link", "--project", meta["project"], "--environment", "production", "--service", RAILWAY_SERVICE], d, renv, logf, timeout=120)
        linked = code == 0
    if not linked:
        ws = env("TABLY_CLOUD_RAILWAY_WORKSPACE")
        await _call(logf, f"$ railway init --name {name}")
        args = [rw, "init", "--name", name]
        if ws and _rw_has(rw, "init", "--workspace"):
            args += ["--workspace", ws]
        if _rw_has(rw, "init", "--json"):
            args += ["--json"]
        code, text = await deploymod._stream(args, d, renv, logf, timeout=120)
        if code != 0:
            if re.search(r"unauthori[sz]ed|not authori[sz]ed|railway login", text, re.I):
                return {"ok": False, "url": None, "error": "Railway rechazó el token: para crear proyectos hace falta un token de CUENTA. En railway.com/account/tokens creá uno con Workspace «No workspace» y reemplazalo en Configuración → Deploy (los tokens de workspace o de proyecto no alcanzan)."}
            return {"ok": False, "url": None, "error": "railway init falló: " + _last_line(text)}
        m = re.search(r'"(?:id|projectId)"\s*:\s*"([0-9a-f-]{20,})"', text) or re.search(r"railway\.com/project/([0-9a-f-]{36})", text)
        if not m:  # older CLIs print no JSON on init: the linked project's id comes from status
            _, st_text = await deploymod._stream([rw, "status", "--json"], d, renv, lambda _l: None, timeout=60)
            m = re.search(r'"id"\s*:\s*"([0-9a-f-]{20,})"', st_text)
        meta = {"project": m.group(1) if m else name, "db": False}
        code, text = await deploymod._stream([rw, "add", "--service", RAILWAY_SERVICE], d, renv, logf, timeout=120)
        if code != 0:
            return {"ok": False, "url": None, "error": "railway add (servicio) falló: " + _last_line(text), "railway": meta}
        await deploymod._stream([rw, "service", RAILWAY_SERVICE], d, renv, logf, timeout=60)
    if _uses_postgres(d) and not meta.get("db") and "DATABASE_URL" not in values:
        await _call(logf, "$ railway add --database postgres")
        code, text = await deploymod._stream([rw, "add", "--database", "postgres"], d, renv, logf, timeout=180)
        if code == 0:
            meta["db"] = True
        else:
            await _call(logf, "⚠ no se pudo crear la base de datos: " + _last_line(text))
    sets = {**values, "PORT": "8080"}
    if meta.get("db") and "DATABASE_URL" not in values:
        sets["DATABASE_URL"] = "${{Postgres.DATABASE_URL}}"  # Railway resolves the reference to the app's own database
    await _call(logf, f"$ railway variable set ({len(sets)} variables)")
    if _rw_has(rw, "", "variable"):  # newer CLI: `variable set`; older: `variables --set` (still accepted, deprecated)
        vargs = [rw, "variable", "set", "--service", RAILWAY_SERVICE, "--skip-deploys", *[f"{k}={v}" for k, v in sets.items()]]
    else:
        vargs = [rw, "variables", "--service", RAILWAY_SERVICE, *sum((["--set", f"{k}={v}"] for k, v in sets.items()), [])]
        if _rw_has(rw, "variables", "--skip-deploys"):
            vargs.append("--skip-deploys")
    code, text = await deploymod._stream(vargs, d, renv, logf, timeout=120)
    if code != 0:
        await _call(logf, "⚠ no se pudieron cargar las variables: " + _last_line(text))
    await _call(logf, "$ railway up --detach")
    code, text = await deploymod._stream([rw, "up", "--service", RAILWAY_SERVICE, "--detach"], d, renv, logf, timeout=900)
    logs = (re.search(r"https://railway\.com/project/\S+", text) or [None])[0]
    dep = re.search(r"[?&]id=([0-9a-f-]{36})", logs or "")
    meta["deployment"] = dep.group(1) if dep else None
    if code != 0:
        return {"ok": False, "url": None, "error": "railway up falló: " + _last_line(text), "railway": meta}
    url = meta.get("url")
    if not url:
        code, text = await deploymod._stream([rw, "domain", "--service", RAILWAY_SERVICE, "--port", "8080", "--json"], d, renv, logf, timeout=120)
        m = re.search(r"([a-z0-9.-]+\.up\.railway\.app)", text)
        url = f"https://{m.group(1)}" if m else None
        meta["url"] = url
    if not url:
        return {"ok": False, "url": None, "error": "La app quedó desplegada pero Railway no devolvió la URL pública", "railway": meta}
    # the build runs on Railway (minutes): the app is «deploying» and a watcher marks it live when its URL answers
    meta["logs"] = logs
    await _call(logf, f"· Railway está construyendo la imagen y arrancando la app en {url}: te avisamos cuando esté en línea")
    return {"ok": True, "deploying": True, "url": url, "railway": meta}



async def publish(user_id: str, build_id: str, title: str, root: Path, files: dict[str, str], version: int, logf: Log) -> dict:
    """Build + publish; returns the saved app record. Logs stream through `logf`."""
    st = status(user_id)
    slug = slug_for(user_id, build_id, title)
    prev = get_app(user_id, build_id) or {}
    app = {"user_id": user_id, "build_id": build_id, "slug": slug, "provider": "local", "kind": "unknown", "status": "building", "url": prev.get("url"),
           "version": version, "error": None, "log": [], "db": prev.get("db") or {}, "created": prev.get("created") or time.time(), "updated": time.time()}
    lines: list[str] = []

    async def log_(line: str) -> None:
        lines.append(line[-500:])
        app["log"] = lines
        _save(app)  # the panel polls the record while publishing (finished builds have no live socket)
        await _call(logf, line)

    _save(app)
    values = deploymod.load_secrets(user_id, build_id)
    gen = _internal_secrets(root, values)
    if gen:  # the app's own secrets (JWT, sessions…): generated once, saved with the build, the same on every republish
        deploymod.save_secrets(user_id, build_id, gen)
        values.update(gen)
        await log_(f"· generé {len(gen)} secreto(s) propio(s) de la app ({', '.join(gen)}); quedan guardados en «Servicios»")
    # what the app uses to report to Muse Team (AI calls, see observe.py): never written into the code, set on every publish
    values.update({"TABLY_URL": public_url(), "TABLY_SITE": slug, "TABLY_TOKEN": observemod.app_token(slug)})
    urls = url_values([p.read_text(errors="replace") for p in [root / ".env.example", *root.glob("*/.env.example")][:6] if p.exists()], values, prev.get("url"))
    if urls:  # the app's own address: Muse Team knows it, the user never has to look it up
        deploymod.save_secrets(user_id, build_id, urls)
        values.update(urls)
        await log_(f"· completé la dirección de la app ({', '.join(urls)}) con {prev.get('url')}")
    (root / ".env").write_text(deploymod.render_env(values, files)) if values and not (root / ".env").exists() else None
    # errors in the visitors' browsers come back to Muse Team, which hands them to the builder (see incidents.py)
    incidentsmod.inject_reporter(root, f"{public_url()}/api/app-errors/{slug}/reporter.js")
    icons = await identitymod.raster_icons(root)  # the PNG sizes phones and link previews ask for, from the app's icon.svg
    if icons:
        await log_(f"· generé los íconos de la app ({', '.join(p.rsplit('/', 1)[-1] for p in icons)}) a partir de su icon.svg")
    # nothing with a key written in its code goes out: the builder moves it to a variable and it is published again by itself
    keys = await leaksmod.scan(root, values)
    if keys:
        await log_(f"■ Frené la publicación: la app tiene {len(keys)} clave(s) escrita(s) en el código")
        for ln in leaksmod.report(keys).splitlines():
            await log_(ln)
        db = app.setdefault("db", {})
        # only what the panel shows: never the key itself
        db["leaks"] = {"ts": time.time(), "attempts": int((db.get("leaks") or {}).get("attempts") or 0),
                       "keys": [{k: x[k] for k in ("service", "url", "env", "files", "live", "own", "preview")} for x in keys]}
        app.update(status="error", error=f"La app tiene claves escritas en el código ({', '.join(sorted({k['service'] for k in keys}))}). Para que nadie las vea, hay que pasarlas a variables de entorno antes de publicar.", updated=time.time())
        _save(app)
        started = bool(ON_LEAKS and ON_LEAKS(user_id, build_id, keys, "\n".join(lines)))
        app["db"] = (get_app(user_id, build_id) or app).get("db") or app["db"]  # the attempts the hook counted
        if started:
            app.update(status="deploying", error=None)
            await log_("· el constructor las está pasando a variables de entorno; después se publica sola")
            _save(app)
        return app
    (prev.get("db") or {}).pop("leaks", None)
    app.get("db", {}).pop("leaks", None)
    cls = classify(root)
    app["kind"] = cls["kind"]
    try:
        if cls["kind"] == "static":
            app["provider"] = st["static"]
            await log_(f"▶ app estática · proveedor {app['provider']} · «{slug}»")
            out = await _build_static(root, cls, slug, app["provider"], values, log_)
            res = {"ok": False, "url": None, "error": "El build no produjo archivos publicables."} if not out else (await _publish_cloudflare(out, slug, log_) if app["provider"] == "cloudflare" else await _publish_local(out, slug, log_))
        elif cls["kind"] == "server":
            if not st["server"]:
                res = {"ok": False, "url": None, "error": "Esta app necesita un servidor y esta instalación no tiene hosting de servidores configurado (" + st["missing"]["railway"] + "). Mientras tanto podés correrla en «App real» o llevarla a Railway desde «Servicios»."}
            elif st["server"] == "railway":
                app["provider"] = "railway"
                await log_(f"▶ app con servidor ({cls.get('runtime')}) · Railway · «{slug}»")
                res = await _publish_railway(root, cls, slug, values, prev, log_, user_id)
                if res.get("railway"):
                    app["db"] = {**(app.get("db") or {}), "railway": res["railway"]}
            else:
                app["provider"] = "fly"
                await log_(f"▶ app con servidor ({cls.get('runtime')}) · Fly Machines · «{slug}»")
                res = await _publish_fly(root, cls, slug, values, log_)
        else:
            res = {"ok": False, "url": None, "error": "No reconozco qué publicar: no hay package.json con build, index.html ni app Python."}
    except Exception as e:  # noqa: BLE001
        log.exception("publish failed")
        res = {"ok": False, "url": None, "error": str(e)[:300]}
    app.update(status=("deploying" if res.get("deploying") else "live") if res.get("ok") else "error", url=res.get("url") or app.get("url"), error=res.get("error"), updated=time.time())
    _save(app)
    if app["status"] == "deploying":
        _watch(user_id, build_id)
    elif app["status"] == "live":
        incidentsmod.on_live(user_id, build_id)
        ON_LIVE and ON_LIVE(user_id, build_id)
    return app


_WATCHING: set[tuple[str, str]] = set()
# set by main: (user_id, build_id, keys, logs) -> whether the builder started moving the keys out of the code
ON_LEAKS: Callable[[str, str, list, str], bool] | None = None
# set by main: (user_id, build_id) -> the app went live (fill what only its URL could tell, e.g. APP_URL, and republish once)
ON_LIVE: Callable[[str, str], None] | None = None
# set by main: (user_id, build_id, reason, logs) -> whether a fix + republish was started (the app then stays «deploying»)
ON_DEPLOY_FAILED: Callable[[str, str, str, str], bool] | None = None


def _watch(user_id: str, build_id: str) -> None:
    """In the background: the deploying app goes live when its URL answers (or fails after 15 minutes, with the build logs)."""
    if (user_id, build_id) in _WATCHING:
        return
    _WATCHING.add((user_id, build_id))
    from .tasks import spawn

    async def run() -> None:
        try:
            app = get_app(user_id, build_id)
            if not app or app.get("status") != "deploying" or not app.get("url"):
                return
            lines = list(app.get("log") or [])

            async def note(line: str) -> None:
                lines.append(line)
                cur = get_app(user_id, build_id) or app
                cur["log"] = lines[-200:]
                _save(cur)

            rmeta = (app.get("db") or {}).get("railway") or {}
            m = re.search(r"[?&]id=([0-9a-f-]{36})", rmeta.get("logs") or "")
            token, dep = _railway_token(user_id), rmeta.get("deployment") or (m.group(1) if m else None)

            async def failed() -> bool:
                return bool(token and dep) and await railway_deployment_status(token, dep) in ("FAILED", "CRASHED")

            ok = await _wait_until_up(app["url"], note, failed=failed)
            cur = get_app(user_id, build_id) or app
            if cur.get("status") != "deploying":  # republished or taken down meanwhile
                return
            logs = ((cur.get("db") or {}).get("railway") or {}).get("logs")
            if ok:
                lines.append(f"✓ en línea en {cur['url']}")
                cur.update(status="live", error=None, log=lines[-200:], updated=time.time())
                cur.setdefault("db", {}).setdefault("railway", {})["fix_attempts"] = 0
                _save(cur)
                lessonsmod.resolve(user_id, build_id, True)
                incidentsmod.on_live(user_id, build_id)
                ON_LIVE and ON_LIVE(user_id, build_id)
                return
            detail = await railway_failure_logs(token, dep) if token and dep else ""
            reason = "el build o el arranque falló en Railway" if ok is None else "la app no respondió en su URL después de 15 minutos"
            # every failure is kept: the builder gets how the same one was fixed before, and new apps get the lesson up front
            fail = lessonsmod.record(user_id, build_id, "railway", reason, detail)
            past = lessonsmod.past_fixes(fail["signature"], user_id)
            if past:
                detail += "\n\nESTE ERROR YA PASÓ ANTES (" + lessonsmod.label(fail["signature"]) + "):\n" + past
            # the user never has to debug a deploy: the builder reads the logs, fixes the project and it is published again
            if ON_DEPLOY_FAILED and ON_DEPLOY_FAILED(user_id, build_id, reason, detail):
                lines.append("· ajustando la configuración del servidor y volviendo a desplegar…")
                cur.update(log=lines[-200:], updated=time.time())
                _save(cur)
                return
            lessonsmod.resolve(user_id, build_id, False)
            cur.update(status="error", log=lines[-200:], updated=time.time(),
                       error=f"No pudimos dejar la app en línea: {reason}. Mirá el build en Railway" + (f": {logs}" if logs else ".") + " Cuando lo corrijas, tocá «Publicar» de nuevo (reusa el mismo proyecto).")
            _save(cur)
        finally:
            _WATCHING.discard((user_id, build_id))

    spawn(run())


def resume_watchers() -> None:
    """After a restart: the apps that were still deploying get their watcher back."""
    with _db() as c:
        rows = c.execute("SELECT user_id, build_id FROM cloud_apps WHERE status = 'deploying'").fetchall()
    for r in rows:
        _watch(r["user_id"], r["build_id"])


async def unpublish(user_id: str, build_id: str, logf: Log | None = None) -> dict | None:
    app = get_app(user_id, build_id)
    if not app:
        return None
    lf = logf or (lambda s: None)
    try:
        if app["provider"] == "local":
            shutil.rmtree(APPS_ROOT / app["slug"], ignore_errors=True)
        elif app["provider"] == "cloudflare":
            async with httpx.AsyncClient(timeout=60) as cx:
                await cx.delete(f"https://api.cloudflare.com/client/v4/accounts/{env('CF_ACCOUNT_ID')}/pages/projects/{app['slug']}", headers={"Authorization": f"Bearer {env('CF_API_TOKEN')}"})
        elif app["provider"] == "railway":
            rw, project = shutil.which("railway"), ((app.get("db") or {}).get("railway") or {}).get("project")
            if rw and project and _rw_has(rw, "", "delete"):
                await deploymod._stream([rw, "delete", "--project", project, "--yes"], APPS_ROOT, _railway_env(user_id), lf, timeout=120)
            elif project:
                await _call(lf, f"⚠ esta versión de la CLI de Railway no borra proyectos: borralo a mano en Railway ({project})")
            (app.get("db") or {}).pop("railway", None)
        elif app["provider"] == "fly":
            fly = shutil.which("flyctl") or shutil.which("fly")
            if fly:
                await deploymod._stream([fly, "apps", "destroy", f"tably-{app['slug']}"[:30].rstrip("-"), "--yes"], APPS_ROOT, {**os.environ, "FLY_API_TOKEN": env("FLY_API_TOKEN") or ""}, lf, timeout=120)
    except Exception as e:  # noqa: BLE001
        log.warning("unpublish: %s", e)
    app.update(status="down", url=None, updated=time.time())
    _save(app)
    return app


def local_file(slug: str, path: str) -> Path | None:
    """File to serve for /apps/<slug>/<path>, with SPA fallback to index.html."""
    base = (APPS_ROOT / slug).resolve()
    if not base.is_dir() or not str(base).startswith(str(APPS_ROOT.resolve())):
        return None
    p = (base / (path or "index.html")).resolve()
    if not str(p).startswith(str(base)):
        return None
    if p.is_dir():
        p = p / "index.html"
    if p.is_file():
        return p
    return base / "index.html" if (base / "index.html").is_file() and "." not in Path(path).name else None


# ------------------------------------------------------------------------------------------------ database & auth

def _mask(url: str) -> str:
    return re.sub(r"://([^:]+):([^@]+)@", r"://\1:***@", url)


async def provision_neon(user_id: str, build_id: str, title: str, logf: Log) -> dict:
    key = env("NEON_API_KEY")
    if not key:
        return {"ok": False, "error": status()["missing"]["neon"]}
    name = f"tably-{slug_for(user_id, build_id, title)}"[:60]
    await _call(logf, f"· creando el proyecto Postgres «{name}» en Neon")
    async with httpx.AsyncClient(timeout=90) as cx:
        r = await cx.post("https://console.neon.tech/api/v2/projects", headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                          json={"project": {"name": name, "region_id": env("NEON_REGION") or "aws-us-east-1", "pg_version": 16}})
    if r.status_code >= 300:
        return {"ok": False, "error": f"Neon respondió {r.status_code}: {r.text[:200]}"}
    j = r.json()
    uri = next((c.get("connection_uri") for c in (j.get("connection_uris") or []) if c.get("connection_uri")), None)
    if not uri:
        return {"ok": False, "error": "Neon no devolvió la URL de conexión."}
    vals = {"DATABASE_URL": uri, "POSTGRES_URL": uri}
    deploymod.save_secrets(user_id, build_id, vals)
    host = re.sub(r"^.*@([^/]+)/.*$", r"\1", uri)
    rec = {"provider": "neon", "ok": True, "vars": sorted(vals), "host": host, "project_id": j.get("project", {}).get("id"), "ts": time.time()}
    _attach_db(user_id, build_id, "database", rec)
    await _call(logf, f"✓ Postgres listo en {host} · DATABASE_URL guardada en los secretos")
    return {"ok": True, **{k: rec[k] for k in ("provider", "host", "vars")}}


async def provision_supabase(user_id: str, build_id: str, title: str, logf: Log) -> dict:
    token, org = env("SUPABASE_ACCESS_TOKEN"), env("SUPABASE_ORG_ID")
    if not token or not org:
        return {"ok": False, "error": status()["missing"]["supabase"]}
    name = f"tably-{slug_for(user_id, build_id, title)}"[:60]
    pw = secrets.token_urlsafe(24)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    await _call(logf, f"· creando el proyecto Supabase «{name}»")
    async with httpx.AsyncClient(timeout=120) as cx:
        r = await cx.post("https://api.supabase.com/v1/projects", headers=headers, json={"name": name, "organization_id": org, "db_pass": pw, "region": env("SUPABASE_REGION") or "us-east-1", "plan": "free"})
        if r.status_code >= 300:
            return {"ok": False, "error": f"Supabase respondió {r.status_code}: {r.text[:200]}"}
        ref = r.json().get("id") or r.json().get("ref")
        for i in range(40):  # the project takes a minute or two to come up
            await asyncio.sleep(6)
            s = await cx.get(f"https://api.supabase.com/v1/projects/{ref}", headers=headers)
            stt = (s.json() or {}).get("status", "") if s.status_code < 300 else ""
            if i % 3 == 0:
                await _call(logf, f"· esperando a Supabase… ({stt or 'creando'})")
            if stt in ("ACTIVE_HEALTHY",):
                break
        k = await cx.get(f"https://api.supabase.com/v1/projects/{ref}/api-keys", headers=headers)
        keys = {x.get("name"): x.get("api_key") for x in (k.json() if k.status_code < 300 else [])}
    url = f"https://{ref}.supabase.co"
    vals = {"SUPABASE_URL": url, "SUPABASE_ANON_KEY": keys.get("anon", ""), "SUPABASE_SERVICE_ROLE_KEY": keys.get("service_role", ""),
            "VITE_SUPABASE_URL": url, "VITE_SUPABASE_ANON_KEY": keys.get("anon", ""), "NEXT_PUBLIC_SUPABASE_URL": url, "NEXT_PUBLIC_SUPABASE_ANON_KEY": keys.get("anon", ""),
            "DATABASE_URL": f"postgresql://postgres:{pw}@db.{ref}.supabase.co:5432/postgres"}
    deploymod.save_secrets(user_id, build_id, {k: v for k, v in vals.items() if v})
    rec = {"provider": "supabase", "ok": True, "vars": sorted(k for k, v in vals.items() if v), "host": f"{ref}.supabase.co", "ref": ref, "ts": time.time()}
    _attach_db(user_id, build_id, "auth", rec)
    await _call(logf, f"✓ Supabase listo ({ref}) · URL y keys guardadas en los secretos")
    return {"ok": True, **{k: rec[k] for k in ("provider", "host", "vars")}}


def _attach_db(user_id: str, build_id: str, slot: str, rec: dict) -> None:
    app = get_app(user_id, build_id) or {"user_id": user_id, "build_id": build_id, "slug": slug_for(user_id, build_id, build_id), "provider": "local", "kind": "unknown",
                                         "status": "down", "url": None, "version": None, "error": None, "log": [], "db": {}, "created": time.time(), "updated": time.time()}
    app["db"] = {**(app.get("db") or {}), slot: rec}
    _save(app)


def migration_kit(user_id: str, build_id: str) -> dict:
    """What the user needs to take the data elsewhere (connection host masked; the real URL stays in the secrets)."""
    values = deploymod.load_secrets(user_id, build_id)
    url = values.get("DATABASE_URL")
    return {
        "has_database": bool(url),
        "database_url_masked": _mask(url) if url else None,
        "pg_dump": f'pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f app.dump' if url else None,
        "pg_restore": 'pg_restore --no-owner --no-acl -d "$NEW_DATABASE_URL" app.dump' if url else None,
        "env_vars": sorted(values),
    }
