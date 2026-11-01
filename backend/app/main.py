"""HTTP + WebSocket API.

REST
    POST /api/auth/register|login|logout, GET /api/auth/me   (Bearer token)
    GET  /api/health
    GET  /api/providers                 which vendors have keys, default model, brand color
    GET  /api/providers/{id}/models     live model list from the vendor
    GET  /api/presets?fallback=true     experiments; unconfigured providers swapped for "mock"
    POST /api/sessions                  start a run → {id}
    POST /api/sessions/{id}/stop
    GET  /api/sessions                  live + saved runs
    GET  /api/sessions/{id}             full event log (for replay)
    GET  /api/sessions/{id}/transcript.md   debate as Markdown
    POST /api/sessions/{id}/brief       streamed build brief + prompt for the builder agent
WS
    /ws/sessions/{id}?token=...         backlog + live events, closes when the run ends
All session endpoints are scoped to the signed-in user.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import copy
import html
import json
import time
import hashlib
import logging
import re
import secrets
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import auth, keystore, trial
from . import memory as memorymod
from . import scores as scoresmod
from . import team as teammod
from . import portability
from . import analytics as analyticsmod
from . import observability as obs
from .tasks import spawn
from . import research
from . import scene_gen
from .auth import CurrentUser, Credentials, User
from . import builder as buildermod
from .builder import BUILDS, Build, BuildRequest, list_builds, load_build, rehydrate, start_build
from .local_engine import ENGINES, engine_status, is_engine, snapshot_dir
from . import deploy as deploymod
from . import service_guide
from . import service_tutorials
from . import billing
from . import research_jobs
from . import providers as provmod
from . import runner as runmod
from . import skills as skillmod
from . import cloud as cloudmod
from . import incidents as incidentsmod
from . import observe as observemod
from . import connections as connectionsmod
from . import leaks as leaksmod
from . import lessons as lessonsmod
from . import levels as levelsmod
from . import ads as adsmod
from . import meta_ads as metaads
from . import studio as studiomod
from . import adtier as adtiermod
from . import tickets as ticketsmod
from . import gitserver
from . import agent_sessions
from . import skills_catalog as catalog
from .i18n_data import GROUPS_EN, preset_en, role_en, template_en
from . import fde as fdemod
from . import scenes as scenemod
from . import intake as intakemod
from .user_presets import create_preset, delete_preset, list_presets, scene_path
from .exporter import TARGETS, BriefRequest, session_path, stream_brief, transcript_markdown
from .config import CORS_ORIGINS, DATA_DIR, env
from .orchestrator import SESSIONS, drop_self_approval, start_session
from .presets import PRESETS
from .roles import ROLE_GROUPS, ROLES
from .providers import PROVIDERS, CallResult, Cred, available_models, list_models, stream
from .schemas import SessionConfig

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("arena.api")

app = FastAPI(title="Tably Team", version="1.0.0", docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])

MAX_CONCURRENT_JOBS = int(env("ARENA_MAX_JOBS_PER_USER", "3"))
_auth_hits: dict[str, list[float]] = {}


class SecurityHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if not path.startswith("/r/"):  # an absolute path asked by an app running at /r/<token>/ (/assets/x.js, /api/…): into it
            ref = re.search(r"^https?://([^/]+)/r/([\w-]{16,})/", request.headers.get("referer") or "")
            q = f"?{request.url.query}" if request.url.query else ""
            if ref and ref.group(2) in runmod.TOKENS:  # the run's token is the check (proxies in front may rewrite Host)
                return Response(status_code=307, headers={"Location": f"/r/{ref.group(2)}{path}{q}"})
            run_tok = request.cookies.get("tably_run")
            if run_tok in runmod.TOKENS and request.headers.get("sec-fetch-dest") == "iframe":  # Tably frames nothing but running apps
                return Response(status_code=307, headers={"Location": f"/r/{run_tok}{path}{q}"})
        resp = await call_next(request)
        dest, run_tok = request.headers.get("sec-fetch-dest"), request.cookies.get("tably_run")
        if resp.status_code in (404, 405) and run_tok and not path.startswith(("/r/", "/api/", "/ws")):
            q = f"?{request.url.query}" if request.url.query else ""
            if run_tok in runmod.TOKENS and (
                    (request.headers.get("sec-fetch-site") == "same-origin" and dest not in (None, "empty", "document"))  # an image, font or script of the app
                    or (dest == "document" and request.method == "GET")):  # a link of the app opened in a tab, pasted, or the way back from a payment
                return Response(status_code=307, headers={"Location": f"/r/{run_tok}{path}{q}"})
            if dest == "document" and request.method == "GET":  # a link of an app that is no longer running
                return Response(_RUN_GONE, status_code=404, media_type="text/html")
        if path.startswith("/r/"):  # the running app is shown inside Tably's panel
            if "x-frame-options" in resp.headers:
                del resp.headers["x-frame-options"]
            return resp
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("Cache-Control", "no-store")
        return resp


app.add_middleware(SecurityHeaders)


def _rate_limit(request: Request, bucket: str, limit: int = 10, window: float = 60) -> None:
    """Simple per-IP limiter for auth endpoints (brute-force protection)."""
    import time as _t

    key = f"{bucket}:{request.client.host if request.client else 'x'}"
    now = _t.time()
    hits = [t for t in _auth_hits.get(key, []) if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(429, "Demasiados intentos; esperá un minuto")
    hits.append(now)
    _auth_hits[key] = hits


def _active_jobs(user_id: str) -> int:
    running = sum(1 for s in SESSIONS.values() if s.owner.id == user_id and s.status in ("running", "paused"))
    running += sum(1 for b in BUILDS.values() if b.user.id == user_id and b.status in ("running", "reviewing"))
    return running


def _check_capacity(user_id: str) -> None:
    if _active_jobs(user_id) >= MAX_CONCURRENT_JOBS:
        raise HTTPException(429, f"Ya tenés {MAX_CONCURRENT_JOBS} trabajos en curso; esperá a que terminen")


@app.get("/api/health")
def health():
    return {"ok": True, "langfuse": obs.ENABLED, "langfuse_host": (env("LANGFUSE_BASE_URL") or env("LANGFUSE_HOST")) if obs.ENABLED else None, "stripe": billing.status()}


@app.post("/api/auth/register")
def register(cred: Credentials, request: Request):
    _rate_limit(request, "register", limit=5)
    token, user, dev_code = auth.register(cred)
    if token:
        return {"token": token, "user": user}
    return {"pending": True, "email": user.email, "user": user, **({"dev_code": dev_code} if dev_code else {})}


class VerifyBody(BaseModel):
    email: str
    code: str = ""


@app.post("/api/auth/verify")
def verify_email(body: VerifyBody, request: Request):
    _rate_limit(request, "verify", limit=20)
    token, user = auth.verify(body.email, body.code)
    return {"token": token, "user": user}


@app.post("/api/auth/resend")
def resend_code(body: VerifyBody, request: Request):
    """A new code for an unverified account (after login said email_unverified, or the first one never arrived)."""
    _rate_limit(request, "resend", limit=6)
    dev_code = auth.send_code(body.email.strip().lower())
    return {"ok": True, **({"dev_code": dev_code} if dev_code else {})}


@app.post("/api/auth/login")
def login(cred: Credentials, request: Request):
    _rate_limit(request, "login", limit=10)
    token, user = auth.login(cred)
    return {"token": token, "user": user}


@app.post("/api/auth/logout")
def logout(request: Request):
    if token := auth.bearer(request):
        auth.logout(token)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: User = CurrentUser):
    return {"user": user}


def _my_photo(user: User):
    return next((p for p in auth.user_dir(user.id).glob("me-photo.*") if p.suffix in (".jpg", ".png", ".webp")), None)


@app.get("/api/me/photo")
def my_photo(user: User = CurrentUser):
    """The user's own photo (their seat «Vos» at the team table, their chip): a data URL, or null."""
    import base64

    p = _my_photo(user)
    if not p:
        return {"image": None}
    kind = {".jpg": "jpeg", ".png": "png", ".webp": "webp"}[p.suffix]
    return {"image": f"data:image/{kind};base64," + base64.b64encode(p.read_bytes()).decode()}


@app.put("/api/me/photo")
def my_photo_set(body: dict, user: User = CurrentUser):
    """Body {image: data URL}: the browser already cropped it square and made it small."""
    import base64

    m = re.match(r"^data:image/(jpeg|png|webp);base64,(.+)$", str(body.get("image") or ""), re.S)
    if not m:
        raise HTTPException(400, "Mandá una imagen JPG, PNG o WebP")
    try:
        data = base64.b64decode(m.group(2), validate=True)
    except ValueError:
        raise HTTPException(400, "La imagen llegó dañada")
    if len(data) > 600_000:
        raise HTTPException(400, "La imagen es muy grande (máximo 600 KB)")
    old = _my_photo(user)
    if old:
        old.unlink(missing_ok=True)
    ext = {"jpeg": "jpg", "png": "png", "webp": "webp"}[m.group(1)]
    (auth.user_dir(user.id) / f"me-photo.{ext}").write_bytes(data)
    return my_photo(user)


@app.delete("/api/me/photo")
def my_photo_delete(user: User = CurrentUser):
    p = _my_photo(user)
    if p:
        p.unlink(missing_ok=True)
    return {"image": None}


@app.get("/api/auth/config")
def auth_config():
    return {"allow_signup": auth.ALLOW_SIGNUP}


async def _trial_model(cred: Cred) -> str:
    return trial.pick_model(await available_models(trial.PROVIDER, cred)) or cred.model or PROVIDERS[trial.PROVIDER].default_model


@app.get("/api/providers")
async def providers(user: User = CurrentUser):
    eff = keystore.creds(user.id)
    out = [
        {"id": p.id, "label": p.label, "color": p.color, "configured": eff[p.id].source != "none", "default_model": eff[p.id].model, "source": eff[p.id].source}
        for p in PROVIDERS.values()
    ]
    for p in out:
        if p["id"] == trial.PROVIDER and p["source"] == "trial":
            p["default_model"] = await _trial_model(eff[trial.PROVIDER])
            p["trial_left"] = trial.left(user.id)
    return out


@app.get("/api/providers/{provider_id}/models")
async def provider_models(provider_id: str, user: User = CurrentUser):
    if provider_id not in PROVIDERS:
        raise HTTPException(404, "unknown provider")
    try:
        return {"models": await list_models(provider_id, keystore.creds(user.id)[provider_id])}
    except Exception as e:
        return {"models": [], "error": str(e)[:300]}


# ---------------------------------------------------------------------------- settings (per user)
class ProviderSettings(BaseModel):
    api_key: str | None = None
    clear_key: bool = False
    default_model: str | None = None
    base_url: str | None = None


class KeyTest(BaseModel):
    api_key: str | None = None
    base_url: str | None = None


@app.get("/api/settings/providers")
def settings_providers(user: User = CurrentUser):
    return {"providers": keystore.public_settings(user.id), "share_server_keys": keystore.SHARE_SERVER_KEYS}


@app.put("/api/settings/providers/{provider_id}")
def settings_save(provider_id: str, body: ProviderSettings, user: User = CurrentUser):
    if provider_id not in PROVIDERS or PROVIDERS[provider_id].kind == "mock":
        raise HTTPException(404, "unknown provider")
    keystore.save(user.id, provider_id, api_key=body.api_key, clear_key=body.clear_key, default_model=body.default_model, base_url=body.base_url)
    return next(p for p in keystore.public_settings(user.id) if p["id"] == provider_id)


@app.post("/api/settings/providers/{provider_id}/test")
async def settings_test(provider_id: str, body: KeyTest, user: User = CurrentUser):
    """Checks a key (the typed one, or the saved/effective one) by listing the provider's models."""
    if provider_id not in PROVIDERS:
        raise HTTPException(404, "unknown provider")
    eff = keystore.creds(user.id)[provider_id]
    cred = Cred(body.api_key.strip(), body.base_url or eff.base_url, eff.model, "test") if body.api_key else Cred(eff.api_key, body.base_url or eff.base_url, eff.model, eff.source)
    if not cred.api_key and provider_id != "ollama":
        return {"ok": False, "error": "No hay key para probar"}
    try:
        models = await asyncio.wait_for(list_models(provider_id, cred), timeout=20)
        return {"ok": True, "models": models}
    except Exception as e:
        msg = str(e)
        if "401" in msg or "invalid" in msg.lower() or "auth" in msg.lower():
            msg = "La key fue rechazada por el proveedor (401). Revisá que esté completa y activa."
        return {"ok": False, "error": msg[:300]}


@app.get("/api/roles")
def roles():
    return {"groups": ROLE_GROUPS, "groups_en": [GROUPS_EN.get(g, g) for g in ROLE_GROUPS], "roles": [role_en(r) for r in ROLES]}


@app.get("/api/presets")
async def presets(fallback: bool = True, user: User = CurrentUser):
    """Built-in experiments + the user's saved ones (each with its animated scene)."""
    eff = keystore.creds(user.id)
    # seats without a key run on the Baseten trial when there is one, else on the simulator
    stand_in = trial.PROVIDER if eff[trial.PROVIDER].source == "trial" else "mock"
    stand_in_model = await _trial_model(eff[stand_in]) if stand_in == trial.PROVIDER else eff["mock"].model
    out = []
    for preset in copy.deepcopy(PRESETS) + list_presets(user.id):
        for a in preset["agents"]:
            pid = a["provider"]
            if pid not in PROVIDERS:
                pid = a["provider"] = "mock"
            if fallback and eff[pid].source == "none":
                a["wanted_provider"] = pid
                pid = a["provider"] = stand_in
                a["model"] = stand_in_model
            a.setdefault("model", eff[pid].model)
        preset.setdefault("scene_url", f"/scenes/{preset['id']}.svg")
        if preset.get("custom"):
            # the saved experiment wears the same model-drawn scene as its project (drawn once if there is none yet)
            sp = scene_path(preset["id"])
            scene_gen.ensure_preset(user, preset["id"], preset.get("title") or "", preset, sp)
            preset["scene_url"] = f"/api/scenes/{preset['id']}.svg?v={int(sp.stat().st_mtime) if sp.exists() else 0}"
        out.append(preset_en(preset))
    return out


@app.post("/api/presets")
def preset_save(body: dict, user: User = CurrentUser):
    """Save the current setup as an experiment card; its looping scene is generated from the title/topic right away."""
    try:
        cfg = SessionConfig(**{k: v for k, v in body.items() if k in SessionConfig.model_fields})
    except Exception as e:
        raise HTTPException(400, f"configuración inválida: {str(e)[:200]}")
    title = (body.get("title") or cfg.title or cfg.topic or "").strip()[:80]
    if not title:
        raise HTTPException(400, "el experimento necesita un título")
    return create_preset(user.id, title, cfg.model_dump(), str(body.get("emoji") or "✨"), body.get("motif"))


@app.delete("/api/presets/{preset_id}")
def preset_delete(preset_id: str, user: User = CurrentUser):
    if not delete_preset(user.id, preset_id):
        raise HTTPException(404)
    return {"ok": True}


# ------------------------------------------------------------------ intake: idea + attachments → prompt-engineered brief

class IntakeRun(BaseModel):
    text: str
    provider: str = "mock"
    model: str = "mock-1"
    extra: str = ""  # "add this too" after a prompt was generated
    language: str = ""  # "es" | "en" (the UI language): the analysis, the questions and the prompt come out in it


class IntakeAnswers(BaseModel):
    answers: dict[str, str]


class IntakePath(BaseModel):
    path: str


def _intake(user: User, intake_id: str) -> intakemod.Intake:
    it = intakemod.get(user, intake_id)
    if not it:
        raise HTTPException(404, "intake not found")
    return it


@app.post("/api/intake")
async def intake_create(user: User = CurrentUser):
    return intakemod.create(user).snapshot()


@app.get("/api/intake/{intake_id}")
async def intake_get(intake_id: str, user: User = CurrentUser):
    return _intake(user, intake_id).snapshot()


@app.post("/api/intake/{intake_id}/files")
async def intake_files(intake_id: str, files: list[UploadFile] = File(...), paths: str = Form("[]"), user: User = CurrentUser):
    """Attach documents / a folder (the browser sends each file with its relative path in `paths`) / a .zip."""
    it = _intake(user, intake_id)
    rels = json.loads(paths or "[]")
    added = []
    for i, f in enumerate(files):
        data = await f.read()
        if len(data) > 60_000_000:
            raise HTTPException(413, f"{f.filename}: supera 60 MB")
        name = rels[i] if i < len(rels) and rels[i] else (f.filename or f"archivo-{i}")
        try:
            added += it.add_upload(name, data)
        except (ValueError, zipfile.BadZipFile) as e:
            raise HTTPException(400, str(e))
    return {"added": len(added), **it.snapshot()}


@app.post("/api/intake/{intake_id}/path")
async def intake_path(intake_id: str, body: IntakePath, user: User = CurrentUser):
    """Attach a folder or file that lives on this machine (the backend runs locally)."""
    it = _intake(user, intake_id)
    try:
        added = it.add_path(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"added": len(added), **it.snapshot()}


class IntakePick(BaseModel):
    kind: str = "folder"  # folder | files


@app.post("/api/intake/{intake_id}/pick")
async def intake_pick(intake_id: str, body: IntakePick, user: User = CurrentUser):
    """Open the native Finder chooser on this Mac (the backend runs locally) and attach what the user picks."""
    import platform
    import subprocess

    it = _intake(user, intake_id)
    if platform.system() != "Darwin":
        raise HTTPException(400, "El selector nativo solo está disponible en macOS; usá «carpeta» o «documentos»")
    script = ('set xs to choose file with prompt "Elegí documentos para el proyecto" with multiple selections allowed\n'
              'set out to ""\nrepeat with x in xs\nset out to out & POSIX path of x & linefeed\nend repeat\nreturn out'
              if body.kind == "files" else
              'set xs to choose folder with prompt "Elegí una carpeta o proyecto" with multiple selections allowed\n'
              'set out to ""\nrepeat with x in xs\nset out to out & POSIX path of x & linefeed\nend repeat\nreturn out')
    try:
        loop = asyncio.get_running_loop()
        r = await loop.run_in_executor(None, lambda: subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600))
    except subprocess.TimeoutExpired:
        raise HTTPException(408, "Se cerró el selector por tiempo")
    if r.returncode != 0:
        if "-128" in r.stderr:  # user cancelled
            return {"added": 0, "cancelled": True, **it.snapshot()}
        raise HTTPException(500, f"No se pudo abrir el Finder: {r.stderr.strip()[:200]}")
    added = 0
    errors = []
    for path in [p for p in r.stdout.splitlines() if p.strip()]:
        try:
            added += len(it.add_path(path.strip()))
        except ValueError as e:
            errors.append(f"{path}: {e}")
    if not added and errors:
        raise HTTPException(400, "; ".join(errors)[:300])
    return {"added": added, "cancelled": False, "errors": errors, **it.snapshot()}


@app.delete("/api/intake/{intake_id}/files/{att_id}")
async def intake_remove(intake_id: str, att_id: str, user: User = CurrentUser):
    it = _intake(user, intake_id)
    it.remove(att_id)
    return it.snapshot()


class RolePromptsBody(BaseModel):
    agents: list[dict]  # [{id, name, role, label, mandate, persona}]
    provider: str = "mock"
    model: str = "mock-1"
    language: str = ""  # "es" | "en"


@app.post("/api/intake/{intake_id}/role-prompts")
async def intake_role_prompts(intake_id: str, body: RolePromptsBody, user: User = CurrentUser):
    """Tailored personality prompt per role, from the generated brief. The user applies them (they replace the current ones)."""
    it = _intake(user, intake_id)
    if body.provider not in PROVIDERS:
        raise HTTPException(400, "Proveedor desconocido")
    eff = keystore.creds(user.id)
    if PROVIDERS[body.provider].kind != "mock" and body.provider not in eff:
        raise HTTPException(400, f"{PROVIDERS[body.provider].label}: sin API key")
    try:
        prompts = await it.role_prompts(body.agents[:8], body.provider, body.model, eff.get(body.provider), language=body.language or None)
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(400, str(e))
    return {"prompts": prompts, "cost_usd": round(it.cost_usd, 4)}


@app.post("/api/intake/{intake_id}/run")
async def intake_run(intake_id: str, body: IntakeRun, user: User = CurrentUser):
    it = _intake(user, intake_id)
    if not body.text.strip():
        raise HTTPException(400, "Escribí qué querés construir")
    if body.provider not in PROVIDERS:
        raise HTTPException(400, "Proveedor desconocido")
    eff = keystore.creds(user.id)
    if PROVIDERS[body.provider].kind != "mock" and body.provider not in eff:
        raise HTTPException(400, f"{PROVIDERS[body.provider].label}: sin API key")
    try:
        it.start(body.text, body.provider, body.model, eff.get(body.provider), extra=body.extra, language=body.language or None)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return it.snapshot()


@app.post("/api/intake/{intake_id}/answer")
async def intake_answer(intake_id: str, body: IntakeAnswers, user: User = CurrentUser):
    it = _intake(user, intake_id)
    try:
        it.answer(body.answers)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return it.snapshot()


@app.post("/api/intake/{intake_id}/cancel")
async def intake_cancel(intake_id: str, user: User = CurrentUser):
    it = _intake(user, intake_id)
    it.cancel()
    return it.snapshot()


@app.websocket("/ws/intake/{intake_id}")
async def ws_intake(ws: WebSocket, intake_id: str):
    await ws.accept()
    user = auth.user_from_token(ws.query_params.get("token"))
    it = intakemod.get(user, intake_id) if user else None
    if not it:
        await ws.send_json({"type": "error", "error": "intake not found"})
        await ws.close()
        return
    q = it.subscribe()
    try:
        await ws.send_json({"type": "snapshot", **it.snapshot()})
        while True:
            ev = await q.get()
            await ws.send_json(ev)
    except WebSocketDisconnect:
        pass
    finally:
        it.unsubscribe(q)


def _session_config(user: User, session_id: str) -> dict:
    live = SESSIONS.get(session_id)
    if live and live.owner.id == user.id:
        return live.config.model_dump()
    return _saved(user, session_id).get("config") or {}


@app.get("/api/sessions/{session_id}/scene.svg")
def session_scene(session_id: str, token: str = ""):
    """The project's own animated scene (drawn by a model from its brief) or, until it exists, the procedural one.
    <img> tags cannot send headers, so the token travels as a query param (same as the WebSockets)."""
    user = auth.user_from_token(token)
    if not user:
        raise HTTPException(401)
    try:
        p = scene_gen.scene_path(user, session_id)
    except FileNotFoundError:
        raise HTTPException(404)
    if p.exists():
        return FileResponse(p, media_type="image/svg+xml", headers={"Cache-Control": "private, max-age=86400"})
    cfg = _session_config(user, session_id)
    svg = scenemod.generate(cfg.get("title") or (cfg.get("topic") or "")[:80], (cfg.get("topic") or "")[:400])
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.get("/api/sessions/{session_id}/scene/status")
async def session_scene_status(session_id: str, user: User = CurrentUser):
    """Is the project's own scene ready? If not (and there is an API key), drawing starts in the background."""
    cfg = _session_config(user, session_id)
    return scene_gen.ensure(user, session_id, cfg)


@app.post("/api/sessions/{session_id}/scene/regenerate")
async def session_scene_regenerate(session_id: str, user: User = CurrentUser):
    cfg = _session_config(user, session_id)
    await scene_gen.regenerate(user, session_id, cfg)
    return scene_gen.status(user, session_id)


@app.get("/api/scenes/topic.svg")
def topic_scene(t: str = ""):
    """Animated mini scene for any title/topic (project rows): generated from the query text only, no stored data."""
    svg = scenemod.generate(t[:200])
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/scenes/{preset_id}.svg")
def preset_scene(preset_id: str):
    """Animated background of a saved experiment (ids are unguessable; the scene holds no personal data)."""
    p = scene_path(preset_id)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/sessions")
async def create_session(config: SessionConfig, user: User = CurrentUser):
    ids = [a.id for a in config.agents]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "agent ids must be unique")
    eff = keystore.creds(user.id)
    if config.auto_skills:
        from .orchestrator import auto_pick_skills
        await asyncio.to_thread(auto_pick_skills, config)
    for a in config.agents:
        spec = PROVIDERS.get(a.provider)
        if not spec:
            raise HTTPException(400, f"unknown provider {a.provider}")
        if eff[a.provider].source == "none":
            if a.provider == trial.PROVIDER and trial.enabled():
                raise HTTPException(400, "Se terminaron tus rondas de prueba gratis. Cargá tu API key en Configuración para seguir.")
            raise HTTPException(400, f"{spec.label}: falta la API key. Cargala en Configuración.")
    # preflight: every model must exist for this account, otherwise the agent would fail on every turn
    problems = []
    for a in config.agents:
        if PROVIDERS[a.provider].kind == "mock":
            continue
        models = await available_models(a.provider, eff[a.provider])
        if models and a.model not in models:
            problems.append(f"{a.name}: el modelo «{a.model}» no está disponible en tu cuenta de {PROVIDERS[a.provider].label}. Elegí otro del desplegable.")
    if problems:
        raise HTTPException(400, " · ".join(problems))
    _check_capacity(user.id)
    if any(eff[a.provider].source == "trial" for a in config.agents):
        trial.spend(user.id, rounds=1)  # creds() already refused the trial when no round is left
    s = start_session(config, user, eff, auto_pick=False)
    try:  # the roles of this project join (or stay in) the user's team, in the database
        teammod.save_from_agents(user.id, config.agents)
    except Exception as e:  # noqa: BLE001
        log.warning("team: could not save the roles: %s", e)
    return {"id": s.id}


@app.post("/api/sessions/{session_id}/council/redo")
async def council_redo(session_id: str, user: User = CurrentUser):
    """Re-runs only the chairman over a finished council (cheap): rebuilds the change list from the saved debate + role verdicts."""
    from .orchestrator import Session

    data = _saved(user, session_id)
    cfg = SessionConfig(**data["config"])
    if cfg.mode != "review":  # the project's session (the arena moved to it after applying a list): its latest council round
        latest = None
        for p in sorted(auth.user_dir(user.id).glob(f"{session_id}.build.*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                latest = (json.loads(p.read_text()).get("council_sessions") or [None])[-1]
            except Exception:
                latest = None
            if latest:
                break
        if not latest:
            raise HTTPException(400, "Esta sesión no es un consejo de revisión")
        session_id = latest
        data = _saved(user, session_id)
        cfg = SessionConfig(**data["config"])
    s = SESSIONS.get(session_id)
    if s and s.status == "running":
        raise HTTPException(409, "El consejo todavía está debatiendo")
    if not s:
        s = Session(cfg, user, keystore.creds(user.id))
        s.id, s.events, s.status = session_id, data["events"], data["status"]
        s.transcript = [{k: e.get(k) for k in ("turn", "phase", "agent_id", "message", "stance", "confidence", "thinking", "next", "reason", "metrics", "responding_to")} for e in data["events"] if e["type"] == "turn.completed"]
        SESSIONS[session_id] = s
    ro = cfg.review_of or {}
    if ro.get("build_id"):
        try:
            _build(user, ro["build_id"], ro.get("session_id"))  # so the version gets re-scored
        except HTTPException:
            pass
    await s._council()
    s._save()
    return (s.verdict.get("council") or {}) | {"session_id": session_id}


@app.post("/api/sessions/{session_id}/resume")
def session_resume(session_id: str, body: dict, user: User = CurrentUser):
    """After a provider outage pause: retry (optionally after switching the role's model)."""
    s = SESSIONS.get(session_id)
    if not s or s.owner.id != user.id:
        raise HTTPException(404)
    s.resume(body.get("action") or "retry")
    return {"ok": True}


@app.patch("/api/sessions/{session_id}/agents/{agent_id}")
async def session_update_agent(session_id: str, agent_id: str, body: dict, user: User = CurrentUser):
    """Switch a role to another provider/model during the run (promote or demote). Applies from its next call."""
    s = SESSIONS.get(session_id)
    if not s or s.owner.id != user.id:
        raise HTTPException(404)
    if agent_id not in s.agents:
        raise HTTPException(404, "agente no encontrado")
    provider, model = body.get("provider") or "", (body.get("model") or "").strip()
    if provider not in PROVIDERS or not model:
        raise HTTPException(400, "proveedor o modelo inválido")
    eff = keystore.creds(user.id)
    if eff[provider].source == "none":
        raise HTTPException(400, f"{PROVIDERS[provider].label}: falta la API key. Cargala en Configuración.")
    if PROVIDERS[provider].kind != "mock":
        models = await available_models(provider, eff[provider])
        if models and model not in models:
            raise HTTPException(400, f"El modelo «{model}» no está disponible en tu cuenta de {PROVIDERS[provider].label}.")
    s.update_agent(agent_id, provider, model, eff[provider])
    if s.pause and s.pause["agent_id"] == agent_id:
        s.resume("switched")
    return {"ok": True, "agent": {"id": agent_id, "provider": provider, "model": model}}


@app.post("/api/sessions/estimate")
def estimate(config: SessionConfig, _: User = CurrentUser):
    from .orchestrator import estimate_cost

    return estimate_cost(config)


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str, user: User = CurrentUser):
    """Deletes a session with its exports, builds and secrets. Running jobs are stopped first."""
    import shutil

    s = SESSIONS.get(session_id)
    if s and s.owner.id == user.id:
        s.stop()
        SESSIONS.pop(session_id, None)
    for b in [b for b in BUILDS.values() if b.user.id == user.id and b.req.session_id == session_id]:
        b.stop()
        BUILDS.pop(b.id, None)
        if b.workdir and b.workdir.exists():
            shutil.rmtree(b.workdir, ignore_errors=True)
    folder = auth.user_dir(user.id)
    removed = 0
    for p in folder.glob(f"{session_id}*"):
        if p.resolve().parent == folder.resolve():
            p.unlink()
            removed += 1
    if not removed:
        raise HTTPException(404)
    return {"ok": True, "removed": removed}


@app.patch("/api/sessions/{session_id}")
def rename_session(session_id: str, body: dict, user: User = CurrentUser):
    title = (body.get("title") or "").strip()[:120]
    if not title:
        raise HTTPException(400, "título vacío")
    s = SESSIONS.get(session_id)
    if s and s.owner.id == user.id:
        s.config.title = title
    path = session_path(user, session_id)
    if not path.exists():
        raise HTTPException(404)
    data = json.loads(path.read_text())
    data["config"]["title"] = title
    path.write_text(json.dumps(data, ensure_ascii=False))
    return {"ok": True}


def _api_build_cost(builds: list[dict]) -> float:
    """Spend that actually hits an API key: builds run by a local engine (Claude Code / Codex by subscription) are not
    billed per token, so their list-price equivalent is shown on the build but never added to the spend."""
    return sum((float(b.get("cost_usd") or 0) if not is_engine(b.get("provider") or "") else 0.0) + float(b.get("fees_usd") or 0) for b in builds)


@app.get("/api/dashboard")
def dashboard(user: User = CurrentUser):
    """Everything the user owns, with status and spend, for the home dashboard."""
    all_sessions = list_sessions(user)
    # council rounds live inside their project row, not as projects of their own
    councils: dict[str, list[dict]] = {}
    sessions = []
    for s in all_sessions:
        ro = s.get("review_of") if s.get("mode") == "review" else None
        if ro and ro.get("session_id"):
            councils.setdefault(ro["session_id"], []).append({"id": s["id"], "round": ro.get("round"), "version": ro.get("version"), "build_id": ro.get("build_id"), "status": s["status"], "cost_usd": s.get("cost_usd", 0), "created": s["created"], "live": s.get("live", False)})
        else:
            sessions.append(s)
    builds_by_session: dict[str, list[dict]] = {}
    total_cost = 0.0
    for s in sessions:
        bl = session_builds(s["id"], user)
        builds_by_session[s["id"]] = bl
        s["councils"] = sorted(councils.get(s["id"], []), key=lambda c: c["created"])
        s["council_cost_usd"] = round(sum(float(c.get("cost_usd") or 0) for c in s["councils"]), 4)
        total_cost += float(s.get("cost_usd") or 0) + s["council_cost_usd"] + _api_build_cost(bl)
    import time as _t

    month = _t.strftime("%Y-%m")
    month_cost = sum(
        float(s.get("cost_usd") or 0) + float(s.get("council_cost_usd") or 0) + _api_build_cost(builds_by_session[s["id"]])
        for s in sessions if _t.strftime("%Y-%m", _t.localtime(s["created"])) == month
    )
    eff = keystore.creds(user.id)
    return {
        "sessions": [s | {"builds": builds_by_session[s["id"]]} for s in sessions],
        "spend": {"total_usd": round(total_cost, 3), "month_usd": round(month_cost, 3), "month": month},
        "active_jobs": _active_jobs(user.id), "max_jobs": MAX_CONCURRENT_JOBS,
        "setup": {
            "api_keys": sum(1 for c in eff.values() if c.source == "user"),
            "engines": [e for e in engine_status(user.id) if e["ok"]],
            "langfuse": obs.ENABLED, "sessions": len(all_sessions),
        },
    }


@app.post("/api/sessions/{session_id}/stop")
def stop_session(session_id: str, user: User = CurrentUser):
    s = SESSIONS.get(session_id)
    if not s or s.owner.id != user.id:
        raise HTTPException(404)
    s.stop()
    return {"ok": True}


@app.get("/api/sessions")
def list_sessions(user: User = CurrentUser):
    items = {sid: s.summary() for sid, s in SESSIONS.items() if s.owner.id == user.id}
    for path in sorted(auth.user_dir(user.id).glob("*.json"), reverse=True)[:200]:
        if path.stem in items:
            continue
        try:
            data = json.loads(path.read_text())
            cfg = data["config"]
            done = next((e for e in reversed(data["events"]) if e["type"] == "session.completed"), {})
            items[path.stem] = {
                "id": data["id"], "status": data["status"], "topic": cfg["topic"], "title": cfg.get("title"), "mode": cfg["mode"], "review_of": cfg.get("review_of"),
                "agents": [{"name": a["name"], "provider": a["provider"], "model": a["model"]} for a in cfg["agents"]],
                "created": data["events"][0]["ts"] if data["events"] else path.stat().st_mtime, "live": False,
                "cost_usd": (done.get("stats") or {}).get("total_cost_usd", 0), "turns": (done.get("stats") or {}).get("turns", 0),
                "has_brief": any(path.parent.glob(f"{path.stem}.brief.*.md")),
            }
        except Exception:
            continue
    return sorted(items.values(), key=lambda x: x["created"], reverse=True)


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, user: User = CurrentUser):
    s = SESSIONS.get(session_id)
    if s and s.owner.id == user.id:
        return {"id": s.id, "status": s.status, "config": s.config.model_dump(), "events": s.events}
    folder = auth.user_dir(user.id)
    path = folder / f"{session_id}.json"
    if not path.exists() or path.resolve().parent != folder.resolve():
        raise HTTPException(404)
    return json.loads(path.read_text())


class TeamBody(BaseModel):
    agents: list[dict]


@app.put("/api/sessions/{session_id}/team")
def update_team(session_id: str, body: TeamBody, user: User = CurrentUser):
    """Edit a saved project's team (roles, models, personas, skills). Applies to the saved config and to the project's
    builds, so the next council round / build / review uses it. Not allowed while the debate itself is running."""
    from .roles import ROLES as _ROLES
    from .schemas import AgentConfig

    live = SESSIONS.get(session_id)
    if live and live.owner.id == user.id and live.status in ("running", "paused"):
        raise HTTPException(409, "El debate está corriendo: cambiá modelos desde el panel Equipo o esperá a que termine.")
    try:
        agents = [AgentConfig(**{k: v for k, v in a.items() if k in AgentConfig.model_fields}) for a in body.agents]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Equipo inválido: {e}")
    if not 2 <= len(agents) <= 8:
        raise HTTPException(400, "El equipo tiene que tener entre 2 y 8 roles")
    ids = [a.id for a in agents]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Los ids de agentes deben ser únicos")
    valid_roles = {r["id"] for r in _ROLES}
    for a in agents:
        if a.provider not in PROVIDERS:
            raise HTTPException(400, f"Proveedor desconocido: {a.provider}")
        if a.role and a.role not in valid_roles:
            a.role = None
    dumped = [a.model_dump() for a in agents]
    path = session_path(user, session_id)
    if not path.exists():
        raise HTTPException(404)
    d = json.loads(path.read_text())
    d.setdefault("config", {})["agents"] = dumped
    path.write_text(json.dumps(d, ensure_ascii=False))
    if live and live.owner.id == user.id:
        live.config.agents = agents
    for b in BUILDS.values():
        if b.user.id == user.id and b.req.session_id == session_id:
            b.team = [dict(a) for a in dumped if a.get("role")]
            b.emit("build.team", team=b.snapshot()["team"])
            b._save()
    return {"agents": dumped}


def _saved(user: User, session_id: str) -> dict:
    try:
        path = session_path(user, session_id)
    except FileNotFoundError:
        raise HTTPException(404)
    if not path.exists():
        raise HTTPException(409 if session_id in SESSIONS else 404, "La sesión todavía no terminó")
    return json.loads(path.read_text())


@app.get("/api/export/targets")
def export_targets():
    return [{"id": k, "label": v["label"]} for k, v in TARGETS.items()]


@app.get("/api/sessions/{session_id}/transcript.md")
def session_transcript(session_id: str, user: User = CurrentUser):
    return PlainTextResponse(transcript_markdown(_saved(user, session_id)), media_type="text/markdown; charset=utf-8")


@app.post("/api/sessions/{session_id}/brief")
async def session_brief(session_id: str, req: BriefRequest, user: User = CurrentUser):
    """Streams a build brief (Markdown) written by the chosen model; cached per target."""
    _saved(user, session_id)
    cred = keystore.creds(user.id).get(req.provider)
    if req.provider not in PROVIDERS or not cred or cred.source == "none":
        raise HTTPException(400, f"Proveedor sin configurar: {req.provider}")
    return StreamingResponse(stream_brief(user, session_id, req), media_type="text/markdown; charset=utf-8")


@app.post("/api/direct-builds")
async def create_direct_build(body: dict, user: User = CurrentUser):
    """The fast lane: one (prompt-engineered) request → brief written by a model → builder, no council. Returns the session
    and the build; the build runs in the background like any other."""
    import time as _t

    from .auth import user_dir
    from .exporter import BriefRequest, stream_brief

    topic = (body.get("topic") or "").strip()
    if not topic:
        raise HTTPException(400, "Contá qué querés construir")
    title = (body.get("title") or "").strip() or topic[:60]
    provider, model, target = body.get("provider") or "mock", body.get("model") or "", body.get("target") or "claude-code"
    if target not in TARGETS:
        target = "claude-code"
    refs = [r.strip() for r in body.get("references", []) if isinstance(r, str) and r.strip()] if isinstance(body.get("references"), list) else []
    # who writes the brief: the builder's own API model, else the first configured API provider, else mock
    eff = keystore.creds(user.id)
    bp, bm = (provider, model) if (not is_engine(provider) and eff.get(provider) and eff[provider].source != "none") else (None, None)
    if not bp:
        for pid in ("meta", "anthropic", "openai", "gemini", "deepseek", "xai", "groq", "mistral", "openrouter", "kimi", "ollama", "baseten"):
            c = eff.get(pid)
            if c and c.source != "none":
                bp, bm = pid, c.model or PROVIDERS[pid].default_model
                break
    if not bp:
        bp, bm = "mock", "mock-1"
    sid = _t.strftime("%Y%m%d-%H%M%S-") + __import__("uuid").uuid4().hex[:6]
    agents = [a for a in (body.get("agents") or []) if isinstance(a, dict) and a.get("role")]
    config = {"topic": topic, "title": title, "mode": "direct", "agents": agents, "max_turns": 0, "min_turns": 0, "language": body.get("language") or "español rioplatense",
              "final_vote": False, "closing_round": False, "max_tokens": 0, "pace_ms": 0, "platform": body.get("platform") or "web", "references": refs,
              "deep_analysis": bool(body.get("deep_analysis")), "context": body.get("context") or None}
    (user_dir(user.id) / f"{sid}.json").write_text(json.dumps({"id": sid, "owner": user.id, "status": "direct", "config": config, "events": [
        {"type": "session.started", "seq": 0, "ts": _t.time(), "session_id": sid, "config": config, "providers": {}, "langfuse_url": None},
        {"type": "session.completed", "seq": 1, "ts": _t.time(), "status": "direct", "stats": {"agents": {}, "turns": 0, "total_cost_usd": 0, "total_tokens": 0, "disagreement_rate": 0, "verdict": None}},
    ]}, ensure_ascii=False))
    # the brief, written now (it is what the builder follows); cached next to the session like any brief
    parts: list[str] = []
    try:
        async for chunk in stream_brief(user, sid, BriefRequest(provider=bp, model=bm, target=target, include_transcript=False, regenerate=True)):
            parts.append(chunk)
    except ValueError as e:
        raise HTTPException(400, str(e))
    brief = "".join(parts)
    if is_engine(provider):
        st = next(e for e in engine_status(user.id) if e["id"] == provider)
        if not st["ok"]:
            raise HTTPException(400, f"{st['label']}: {st['hint'] or 'no disponible'}")
        cred = Cred("local", None, model or "default", "local")
    else:
        cred = eff.get(provider)
        if not cred or cred.source == "none":
            raise HTTPException(400, f"Falta la API key de {provider}")
    req = BuildRequest(session_id=sid, provider=provider, model=model or (cred.model or ""), target=target, review_rounds=0, council=True, design=bool(body.get("design", True)),
                       design_review=False, research=bool(refs), references=refs, deep_analysis=bool(body.get("deep_analysis")), platform=config["platform"], references_auto=bool(config.get("references_auto")), language=config.get("language") or "español rioplatense")
    b = start_build(user, req, cred, brief, title, agents, eff)
    b.chat.insert(0, {"role": "system", "text": "Vía rápida: brief escrito desde tu pedido (sin consejo) y construcción directa.", "ts": _t.time()})
    return {"session_id": sid, "id": b.id, "brief_by": f"{bp} · {bm}"}


# ---------------------------------------------------------------------------- in-app builder
def _brief_for(user: User, session_id: str, target: str) -> str:
    path = session_path(user, session_id).with_suffix(f".brief.{target}.md")
    if not path.exists():
        raise HTTPException(409, "Primero generá el brief de construcción para esta sesión.")
    return path.read_text()


@app.post("/api/research/jobs")
async def research_job_start(body: dict, user: User = CurrentUser):
    """Benchmark the reference apps before a debate; poll the job for the reverse-engineering screen."""
    refs = [r.strip() for r in body.get("references", []) if isinstance(r, str) and r.strip()] if isinstance(body.get("references"), list) else []
    if not refs:
        raise HTTPException(400, "Sin referencias")
    return research_jobs.start(user, refs, str(body.get("brief") or ""), bool(body.get("deep_analysis")))


@app.get("/api/research/jobs/{jid}")
def research_job_get(jid: str, user: User = CurrentUser):
    j = research_jobs.get(user, jid)
    if not j:
        raise HTTPException(404)
    return j


@app.get("/api/research/status")
def research_status(_: User = CurrentUser):
    """Reference research (level 1: headless Chrome + vision model) and deep analysis (level 2: REA, paid per use) availability."""
    return research.status()


@app.get("/api/engines")
def engines(user: User = CurrentUser):
    """Local CLI agents (Claude Code / Codex) usable as builder + review council without API billing."""
    return engine_status(user.id)


@app.put("/api/settings/claude-token")
def settings_claude_token(body: dict, user: User = CurrentUser):
    """The user's own Claude Code subscription token (`claude setup-token` on their computer): with it, builds and the
    sessions chat run on this server as them, PC off or not."""
    tok = (body.get("token") or "").strip()
    if body.get("clear"):
        keystore.save(user.id, "claude-code", clear_key=True)
    elif tok:
        if not tok.startswith("sk-ant-oat"):
            raise HTTPException(400, "Ese no parece un token de `claude setup-token` (empieza con sk-ant-oat…).")
        keystore.save(user.id, "claude-code", api_key=tok)
    return {"status": keystore.key_status(user.id, "claude-code"), "engines": engine_status(user.id)}


@app.post("/api/builds")
async def create_build(req: BuildRequest, user: User = CurrentUser):
    data = _saved(user, req.session_id)
    if is_engine(req.provider):
        st = next(e for e in engine_status(user.id) if e["id"] == req.provider)
        if not st["ok"]:
            raise HTTPException(400, f"{st['label']}: {st['hint'] or 'no disponible'}")
        cred = Cred("local", None, req.model, "local")
    else:
        cred = keystore.creds(user.id).get(req.provider)
        if req.provider not in PROVIDERS or not cred or cred.source == "none":
            raise HTTPException(400, f"Proveedor sin configurar: {req.provider}")
    if not is_engine(req.provider) and PROVIDERS[req.provider].kind != "mock":
        models = await available_models(req.provider, cred)
        if models and req.model not in models:
            raise HTTPException(400, f"El modelo «{req.model}» no está disponible en tu cuenta de {PROVIDERS[req.provider].label}.")
    _check_capacity(user.id)
    if req.deep_analysis:
        if not is_engine(req.provider):
            raise HTTPException(400, "El análisis profundo (REA) corre con un motor local (Claude Code / Codex) como constructor.")
        if not research.rea_available()["ok"]:
            raise HTTPException(400, "REA no está instalado en esta máquina: corré `npx rea-agents setup` y reiniciá el motor.")
    if not req.references:
        req.references = [r for r in (data["config"].get("references") or []) if isinstance(r, str) and r.strip()]
    brief = _brief_for(user, req.session_id, req.target)
    title = data["config"].get("title") or data["config"]["topic"][:60]
    if req.platform == "web":  # the request rarely says it: the session config decides (web / mobile / both)
        req.platform = data["config"].get("platform") or "web"
    req.language = data["config"].get("language") or req.language
    req.references_auto = bool(data["config"].get("references_auto"))
    b = start_build(user, req, cred, brief, title, data["config"].get("agents", []), keystore.creds(user.id))
    return {"id": b.id}


# ---------------------------------------------------------------------------- project audit (upload → team review → report → improvements)
AUDIT_SKIP = {"node_modules", ".git", ".next", "dist", "dist-lhci", "dist-preview", "build", "out", ".venv", "venv", "__pycache__", ".pytest_cache", ".turbo", ".cache", ".wrangler", "coverage", "test-results", "playwright-report", ".lighthouseci", ".perf", "tmp", ".idea", ".vscode", "target", ".expo", "vendor"}
AUDIT_MAX_FILES, AUDIT_MAX_TOTAL, AUDIT_MAX_FILE = 2500, 25_000_000, 400_000


AUDIT_MAX_ZIP = int(os.environ.get("TABLY_AUDIT_MAX_ZIP_MB", "1024")) * 1_000_000


def _extract_zip(src) -> dict[str, str]:
    """`src` is a path or a file object: the zip is read from disk, never fully loaded in memory (node_modules/.git inflate zips to hundreds of MB)."""
    import re as _re
    import zipfile

    out: dict[str, str] = {}
    total = 0
    with zipfile.ZipFile(src) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        # strip a single common top-level folder (what `zip -r folder` produces)
        roots = {n.split("/")[0] for n in names}
        strip = (next(iter(roots)) + "/") if len(roots) == 1 and all("/" in n for n in names) else ""
        for n in names:
            rel = n[len(strip):] if n.startswith(strip) else n
            parts = rel.split("/")
            if not rel or rel.startswith("__MACOSX") or any(p in AUDIT_SKIP or p.startswith(".DS_Store") for p in parts) or ".." in parts:
                continue
            info = z.getinfo(n)
            if info.file_size > AUDIT_MAX_FILE or _re.search(r"\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|mov|bin|lock|map)$", rel, _re.I):
                continue
            try:
                txt = z.read(n).decode("utf-8")
            except UnicodeDecodeError:
                continue
            total += len(txt)
            if total > AUDIT_MAX_TOTAL or len(out) >= AUDIT_MAX_FILES:
                break
            out[rel] = txt
    return out


@app.post("/api/audits")
async def create_audit(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
    team: str = Form("[]"),
    provider: str = Form("mock"),
    model: str = Form("mock-1"),
    auto_skills: str = Form("false"),
    language: str = Form("español"),
    user: User = CurrentUser,
):
    """Upload a project (.zip) and have the team audit it. Creates a lightweight session + an audit build."""
    import time as _t

    from .auth import user_dir

    import tempfile

    # streamed to a temp file in chunks: a 1 GB zip must not sit in memory (the text/code files are picked out afterwards)
    size = 0
    with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
        while chunk := await file.read(4 * 1024 * 1024):
            size += len(chunk)
            if size > AUDIT_MAX_ZIP:
                raise HTTPException(413, f"El zip supera {AUDIT_MAX_ZIP // 1_000_000} MB: sacá node_modules, .git, builds y binarios y volvé a comprimir")
            tmp.write(chunk)
        tmp.flush()
        try:
            files = _extract_zip(tmp.name)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(400, "No pude leer el .zip")
    if not files:
        raise HTTPException(400, "El zip no contiene archivos de texto/código legibles")
    try:
        agents = json.loads(team)
    except json.JSONDecodeError:
        raise HTTPException(400, "team inválido")
    agents = [a for a in agents if a.get("role")]
    if len(agents) < 1:
        raise HTTPException(400, "Elegí al menos un rol auditor")
    if is_engine(provider):
        st = next(e for e in engine_status(user.id) if e["id"] == provider)
        if not st["ok"]:
            raise HTTPException(400, f"{st['label']}: {st['hint'] or 'no disponible'}")
        cred = Cred("local", None, model, "local")
    else:
        cred = keystore.creds(user.id).get(provider)
        if provider not in PROVIDERS or not cred or cred.source == "none":
            raise HTTPException(400, f"Proveedor sin configurar: {provider}")
    for a in agents:  # reviewers by API need a configured provider; otherwise they fall back to the audit model
        if not is_engine(provider) and keystore.creds(user.id).get(a.get("provider", ""), Cred(None)).source == "none":
            a["provider"], a["model"] = provider, model
    title = name.strip()[:80] or "Proyecto"
    if auto_skills.lower() in ("1", "true", "yes"):
        # the team picks catalog skills for each auditor from the project description and its role (added, never replaced)
        from .roles import ROLES as _ROLES
        groups = {"Dirección": "ceo", "Producto": "product", "Ingeniería": "backend", "Diseño": "design", "Datos e IA": "data", "Negocio": "growth", "Calidad y seguridad": "qa"}
        for a in agents:
            role = next((r for r in _ROLES if r["id"] == a.get("role")), None)
            text = f"{title}\n{description}\n{role['mandate'] if role else ''}"
            sug = [x["id"] for x in catalog.suggest(text, k=2, role_group=groups.get(role["group"]) if role else None) if x.get("score", 0) >= 15]
            a["skills"] = list(dict.fromkeys([*(a.get("skills") or []), *sug]))[:12]
    # a session record so the audit lives next to normal sessions (history, builds folder, exports)
    sid = _t.strftime("%Y%m%d-%H%M%S-") + __import__("uuid").uuid4().hex[:6]
    config = {"topic": f"Auditoría de «{title}»: {description.strip()[:500]}", "title": f"Auditoría · {title}", "mode": "audit", "agents": agents,
              "max_turns": 0, "min_turns": 0, "language": language or "español", "final_vote": False, "closing_round": False, "max_tokens": 0, "pace_ms": 0}
    (user_dir(user.id) / f"{sid}.json").write_text(json.dumps({"id": sid, "owner": user.id, "status": "audit", "config": config, "events": [
        {"type": "session.started", "seq": 0, "ts": _t.time(), "session_id": sid, "config": config, "providers": {}, "langfuse_url": None},
        {"type": "session.completed", "seq": 1, "ts": _t.time(), "status": "audit", "stats": {"agents": {}, "turns": 0, "total_cost_usd": 0, "total_tokens": 0, "disagreement_rate": 0, "verdict": None}},
    ]}, ensure_ascii=False))
    tree = "\n".join(f"- {p} ({c.count(chr(10)) + 1} líneas)" for p, c in sorted(files.items()))
    brief = f"# Auditoría de {title}\n\n{description.strip() or '(sin descripción)'}\n\n## Árbol del proyecto ({len(files)} archivos)\n{tree}\n"
    b = Build(user, BuildRequest(session_id=sid, provider=provider, model=model, language=language or "español"), cred, brief, title, agents, keystore.creds(user.id))
    b.context = description.strip()
    b.files = files
    if b.workdir:  # local engine: materialise the project on disk so the CLI can read it
        for rel, content in files.items():
            dest = b.workdir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content)
    b.status = "completed"
    b.chat.append({"role": "system", "text": f"Proyecto «{title}» cargado: {len(files)} archivos. El equipo empieza la auditoría.", "ts": _t.time()})
    BUILDS[b.id] = b
    # the audit is a council round in the arena (live debate → verdict → change list → «construir con estos cambios»);
    # the silent parallel review stays as fallback when no role can speak via API
    b.review_plan = {"max_rounds": 6}
    council = b.start_council(priorities=description.strip()[:2000], focus="production", audit=True)
    if not council:
        b.start_audit()
    else:
        b._save()
    return {"id": b.id, "session_id": sid, "files": len(files), "council": council}


@app.post("/api/builds/{build_id}/apply")
async def build_apply(build_id: str, body: dict, user: User = CurrentUser):
    """After an audit: apply the selected proposals with the builder, then the council reviews until approved."""
    b = _build(user, build_id, body.get("session_id"))
    reqs = [r for r in (body.get("requests") or []) if isinstance(r, dict) and (r.get("text") or "").strip()]
    if not reqs:
        raise HTTPException(400, "No hay propuestas seleccionadas")
    b.apply_improvements(reqs, int(body.get("max_rounds") or 2))
    return {"ok": True}


@app.get("/api/sessions/{session_id}/builds/{build_id}/report.md")
def build_report(session_id: str, build_id: str, user: User = CurrentUser):
    b = BUILDS.get(build_id)
    report = b.audit_report if (b and b.user.id == user.id) else (load_build(user, session_id, build_id) or {}).get("audit_report")
    if not report:
        raise HTTPException(404, "Esta construcción no tiene informe de auditoría")
    return PlainTextResponse(report, media_type="text/markdown; charset=utf-8")


# ---------------------------------------------------------------------------- external services + deploy
def _build_any(user: User, session_id: str, build_id: str):
    """Live build or rehydrated saved one (needed for deploy/services on finished builds)."""
    return _build(user, build_id, session_id)


@app.get("/api/sessions/{session_id}/builds/{build_id}/services")
def build_services(session_id: str, build_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    values = deploymod.load_secrets(user.id, build_id)
    data = deploymod.services_for(b.files, b.brief, set(values))
    # keys of outside services that an older Tably filled with a random value (it took them for the app's own secrets): out
    invented = [i["var"] for i in data["items"] if i["tier"] != "auto" and re.fullmatch(r"[A-Za-z0-9_-]{64}", values.get(i["var"]) or "")
                and re.search(r"TURNSTILE|TRIGGER|RECAPTCHA|HCAPTCHA|SLACK|DISCORD|POSTMARK|MAILGUN", i["var"])]
    if invented:
        deploymod.save_secrets(user.id, build_id, {v: "" for v in invented})
        data = deploymod.services_for(b.files, b.brief, set(values) - set(invented))
    app_ = cloudmod.get_app(user.id, build_id) or {}
    data["app"] = {"status": app_.get("status"), "url": app_.get("url"), "updated": app_.get("updated")} if app_ else None
    # values saved after the last publish only reach the published app when it is published again
    with auth._db() as c:
        last = c.execute("SELECT MAX(updated) FROM build_secrets WHERE user_id = ? AND build_id = ?", (user.id, build_id)).fetchone()[0]
    data["pending_publish"] = bool(app_ and app_.get("status") in ("live", "error") and last and last > (app_.get("updated") or 0) + 2)
    data["deploy_targets"] = deploymod.deploy_status(user.id)
    data["deploys"] = b.deploys
    return data


@app.get("/api/sessions/{session_id}/builds/{build_id}/services/guide")
async def build_service_guide(session_id: str, build_id: str, service: str, lang: str = "es", refresh: bool = False, user: User = CurrentUser):
    """How to obtain what one service needs: a model-written walkthrough (cached), or a generic one without keys."""
    b = _build_any(user, session_id, build_id)
    data = deploymod.services_for(b.files, b.brief, set(deploymod.load_secrets(user.id, build_id)))
    group = next((g for g in data["groups"] if g["service"] == service), None)
    if not group:
        raise HTTPException(404, "service not found")
    tut = service_tutorials.find(group)
    if tut and lang == "en" and service_guide._pick_model(user, {"agents": []}):
        tut = None  # the tutorials are in Spanish: in English a model writes it (without a key, the Spanish one beats the generic)
    if tut:  # hand-written and checked, with the app's real addresses
        app_ = cloudmod.get_app(user.id, build_id) or {}
        url = (app_.get("url") or "").rstrip("/") or None
        path = service_tutorials.webhook_path(b.files, group)
        return {**service_tutorials.render(tut, group, url, (url + path) if url and path else None), "lang": lang}
    return await service_guide.guide(user, build_id, group, b.title, data.get("stack") or [], "en" if lang == "en" else "es", refresh=refresh)


@app.put("/api/sessions/{session_id}/builds/{build_id}/services")
def build_services_save(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    _build_any(user, session_id, build_id)
    values = {k: v for k, v in (body.get("values") or {}).items() if isinstance(k, str)}
    deploymod.save_secrets(user.id, build_id, {k: (str(v) if v is not None else "") for k, v in values.items()})
    return {"ok": True, "configured": sorted(deploymod.load_secrets(user.id, build_id))}


@app.get("/api/sessions/{session_id}/builds/{build_id}/env")
def build_env(session_id: str, build_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    return PlainTextResponse(deploymod.render_env(deploymod.load_secrets(user.id, build_id), b.files), media_type="text/plain; charset=utf-8", headers={"Content-Disposition": 'attachment; filename=".env"'})


@app.post("/api/sessions/{session_id}/builds/{build_id}/deploy")
async def build_deploy(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    target = body.get("target") or "vercel"
    if target not in deploymod.TARGETS:
        raise HTTPException(400, "destino inválido")
    st = next(t for t in deploymod.deploy_status(user.id) if t["id"] == target)
    if not st["ok"]:
        raise HTTPException(400, f"{st['label']}: {st['hint']}")
    if getattr(b, "deploying", False):
        raise HTTPException(409, "Ya hay un deploy en curso")
    values = deploymod.load_secrets(user.id, build_id)
    cwd = deploymod.materialize(user.id, build_id, b.files, b.workdir)
    rec = {"target": target, "ts": __import__("time").time(), "ok": None, "url": None, "error": None, "log": []}
    b.deploys.append(rec)
    b.deploying = True
    b.emit("deploy.started", target=target)

    async def run():
        def log(line: str):
            rec["log"].append(line[-500:])
            b.emit("deploy.log", target=target, line=line[-500:])

        try:
            res = await deploymod.deploy(target, user.id, build_id, b.title, cwd, values, log)
        except Exception as e:
            res = {"ok": False, "url": None, "error": str(e)[:300]}
        rec.update(ok=res["ok"], url=res["url"], error=res["error"])
        rec["log"] = rec["log"][-200:]
        b.deploying = False
        b._save()
        b.emit("deploy.completed", target=target, ok=res["ok"], url=res["url"], error=res["error"])

    spawn(run())
    return {"ok": True}


@app.get("/api/settings/deploy")
def settings_deploy(user: User = CurrentUser):
    return {t: keystore.key_status(user.id, t) for t in deploymod.TARGETS} | {"status": deploymod.deploy_status(user.id)}


@app.put("/api/settings/deploy/{target}")
def settings_deploy_save(target: str, body: dict, user: User = CurrentUser):
    if target not in deploymod.TARGETS:
        raise HTTPException(404)
    keystore.save(user.id, target, api_key=body.get("token"), clear_key=bool(body.get("clear")))
    return keystore.key_status(user.id, target)


@app.get("/api/sessions/{session_id}/builds")
def session_builds(session_id: str, user: User = CurrentUser):
    live = [b.snapshot() | {"files": len(b.files), "stages": len(b.stages), "version": len(b.versions), "readiness": (b.versions[-1]["readiness"] if b.versions else None)} for b in BUILDS.values() if b.user.id == user.id and b.req.session_id == session_id]
    saved = [x for x in list_builds(user, session_id) if x["id"] not in {b["id"] for b in live}]
    return [{k: b.get(k) for k in ("id", "provider", "model", "status", "turns", "cost_usd", "files", "stages", "engine_session", "workdir", "version", "readiness", "pending_council", "build_seconds")} for b in live] + saved


def _build(user: User, build_id: str, session_id: str | None = None):
    b = BUILDS.get(build_id)
    if b and b.user.id == user.id:
        return b
    if session_id:  # finished build saved on disk: bring it back so it can be resumed
        d = load_build(user, session_id, build_id)
        if d:
            cred = Cred("local", None, d["model"], "local") if is_engine(d["provider"]) else keystore.creds(user.id).get(d["provider"])
            if not cred or cred.source == "none":
                raise HTTPException(400, f"Falta la API key de {d['provider']} para reanudar esta construcción.")
            sess = _saved(user, session_id)
            b = rehydrate(user, session_id, build_id, cred, sess["config"].get("agents", []), keystore.creds(user.id))
            if b:
                return b
    raise HTTPException(404)


@app.get("/api/sessions/{session_id}/builds/{build_id}")
def get_build(session_id: str, build_id: str, user: User = CurrentUser):
    b = BUILDS.get(build_id)
    if b and b.user.id == user.id:
        return b.snapshot() | {"file_contents": b.files, "preview_html": b.preview_html, "design_html": b.design_html}
    d = load_build(user, session_id, build_id)
    if not d:
        raise HTTPException(404)
    from .builder import DESIGN_MOCKUP, PREVIEW_PATH, inline_html

    fc = d.get("file_contents") or {}
    from .builder import saved_usage

    d["usage"] = saved_usage(d)
    d["preview_html"] = inline_html(fc.get(PREVIEW_PATH) or "", PREVIEW_PATH, fc) or None
    d["design_html"] = inline_html(fc.get(DESIGN_MOCKUP) or "", DESIGN_MOCKUP, fc) or d.get("design_html")
    return d


@app.put("/api/sessions/{session_id}/builds/{build_id}/language")
def build_language(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    """The language the team speaks on this project (builder messages, council rounds, reports). Takes effect from the next
    turn or council round; what was already written stays as it is."""
    from .intake import lang_code

    code = "en" if lang_code(str(body.get("language") or "")) == "en" else "es"
    b = _build(user, build_id, session_id)
    b.req.language = "English" if code == "en" else "español rioplatense"
    b._save()
    b.emit("build.language", language=b.req.language)
    return {"language": b.req.language, "code": code}


@app.put("/api/sessions/{session_id}/builds/{build_id}/files")
def build_file_save(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    """The user edited a file in the editor: it replaces the build's copy (and the working folder on disk, when the
    build has one), so the next turn, the zip, the preview and the deploy all see the edit."""
    b = _build(user, build_id, session_id)
    path, content = str(body.get("path") or ""), body.get("content")
    if not isinstance(content, str) or not buildermod._safe_path(path):
        raise HTTPException(400, "path o contenido inválidos")
    if len(content) > buildermod.MAX_FILE_BYTES:
        raise HTTPException(413, "archivo demasiado grande")
    b._write(path, content)
    if b.workdir:
        dest = Path(b.workdir) / path
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(b.files[path])
        except OSError as e:
            raise HTTPException(500, f"no pude escribir en disco: {e}")
    b._save()
    return {"ok": True, "path": path, "lines": b.files[path].count("\n"), "size": len(b.files[path])}


@app.post("/api/builds/{build_id}/message")
async def build_message(build_id: str, body: dict, user: User = CurrentUser):
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "mensaje vacío")
    b = _build(user, build_id, body.get("session_id"))
    # "pulido visual" / "polish" in the chat → the full visual-polish checklist (the builder does not know the phrase)
    if re.match(r"^\s*(aplic[aá]\s+el\s+)?(pulido\s+visual|visual\s+polish|polish)\b", text, re.I):
        from .design import POLISH_PROMPT
        extra = re.sub(r"^\s*(aplic[aá]\s+el\s+)?(pulido\s+visual|visual\s+polish|polish)\b[:.,\s-]*", "", text, flags=re.I).strip()
        text = POLISH_PROMPT + (f"\n\nADEMÁS, pedido del usuario: {extra}" if extra else "")
    shown = text
    # «Completá lo que falta de la entrega» (the delivery-check card's button) → what the check finds missing right now
    if re.match(r"^\s*(complet[aá] lo que falta de la entrega|complete what the delivery is missing)", text, re.I):
        from . import delivery
        found = delivery.check(b.files, b.brief, b.title)
        text = delivery.prompt(found) if found["gaps"] else text + ". Revisá .tably/entrega.md y el brief, completá lo que falte de punta a punta y emití <done>."
    if b.status == "running":
        b.say(text[:6000])
        return {"ok": True, "resumed": False}
    b.chat.append({"role": "user", "text": shown[:6000], "ts": __import__("time").time()})
    b.resume(text[:6000])
    return {"ok": True, "resumed": True}


@app.post("/api/builds/{build_id}/review")
async def build_review(build_id: str, body: dict, user: User = CurrentUser):
    """Sends the finished project to the session's team for a pre-production review loop."""
    b = _build(user, build_id, body.get("session_id"))
    if b.status in ("running", "reviewing"):
        raise HTTPException(409, "La construcción todavía está en curso")
    if not b.team:
        raise HTTPException(400, "La sesión no tiene agentes con rol: no hay equipo que pueda revisar")
    b.start_review(int(body.get("max_rounds") or 3))
    return {"ok": True}


@app.get("/api/sessions/{session_id}/builds/{build_id}/versions")
def build_versions(session_id: str, build_id: str, user: User = CurrentUser):
    """v1, v2, …: what was requested, what changed, the council's verdict and the readiness % of each."""
    b = _build_any(user, session_id, build_id)
    return {"versions": b.versions, "current": len(b.versions), "status": b.status}


@app.get("/api/sessions/{session_id}/builds/{build_id}/versions/{n}/diff")
def build_version_diff(session_id: str, build_id: str, n: int, path: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    if n < 1 or n > max(1, len(b.versions)):
        raise HTTPException(404, "versión inexistente")
    return PlainTextResponse(b.version_diff(n, path), media_type="text/plain; charset=utf-8")


@app.post("/api/builds/{build_id}/council")
async def build_council(build_id: str, body: dict, user: User = CurrentUser):
    """Pre-production review as a live arena debate of the team (mode "review"). Returns the arena session to watch."""
    b = _build(user, build_id, body.get("session_id"))
    if b.status in ("running", "reviewing"):
        raise HTTPException(409, "La construcción todavía está en curso")
    if len(b.council_agents()) < 2:
        raise HTTPException(400, "Hacen falta al menos 2 roles con API key para que el consejo debata")
    _check_capacity(user.id)
    b.review_plan = b.review_plan or {"max_rounds": min(3, max(1, int(body.get("max_rounds") or 1)))}
    refs = [r.strip() for r in body.get("references", []) if isinstance(r, str) and r.strip()] if isinstance(body.get("references"), list) else []
    b.add_references(refs, bool(body.get("deep_analysis")))
    focus = "design" if body.get("focus") == "design" else "production"
    if refs:  # whatever the user listed this time is benchmarked first (fresh), then the council opens by itself
        b._save()
        spawn(b.research_then_council(str(body.get("priorities") or ""), refs, focus))
        return {"ok": True, "session_id": None, "researching": len(refs)}
    sid = b.start_council(priorities=str(body.get("priorities") or ""), focus=focus)
    return {"ok": True, "session_id": sid}


def _learn_from_council(user: User, council_session: str, chosen: list[dict]) -> None:
    """What the user kept and dropped from the council's list → insights for each role (in the background, never blocks the build)."""
    if not council_session:
        return
    try:
        data = _saved(user, council_session)
    except HTTPException:
        return
    agents = (data.get("config") or {}).get("agents") or []
    judge = next((a for a in agents if a.get("id") == (data.get("config") or {}).get("judge")), agents[0] if agents else None)
    if not judge:
        return
    provider = judge.get("provider") or "mock"
    cred = keystore.creds(user.id).get(provider)
    spawn(memorymod.learn_from_council(user.id, data, chosen, provider, judge.get("model") or "", cred))


# ---------------------------------------------------------------------------- team memory (each role learns)
@app.get("/api/team/memory")
def team_memory(user: User = CurrentUser):
    return memorymod.listing(user.id)


# ---------------------------------------------------------------------------------------------- move an account between installs
@app.post("/api/account/export")
def account_export(user: User = CurrentUser):
    """Everything of this account as one encrypted file; the code to open it goes in a header and is never stored."""
    code = portability.new_code()
    blob, summary = portability.export_bundle(user.id, code)
    name = f"tably-{time.strftime('%Y%m%d-%H%M')}.tably"
    return Response(blob, media_type="application/octet-stream", headers={
        "Content-Disposition": f'attachment; filename="{name}"', "X-Tably-Code": code, "X-Tably-Summary": json.dumps(summary),
        "Access-Control-Expose-Headers": "X-Tably-Code, X-Tably-Summary, Content-Disposition"})


@app.post("/api/account/import")
async def account_import(file: UploadFile = File(...), code: str = Form(...), user: User = CurrentUser):
    """Bring an export from another installation into this account (nothing that exists here is overwritten)."""
    data = await file.read()
    try:
        summary = portability.import_bundle(user.id, data, code)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **summary}


@app.get("/api/team/employees")
def team_employees(user: User = CurrentUser):
    """The user's saved roles (employees), with how much they know and how many lessons they carry."""
    return {"employees": teammod.listing(user.id)}


@app.post("/api/team/employees")
def team_employee_create(body: dict, user: User = CurrentUser):
    try:
        teammod.create(user.id, body)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"employees": teammod.listing(user.id)}


@app.patch("/api/team/employees/{eid}")
def team_employee_update(eid: str, body: dict, user: User = CurrentUser):
    try:
        if not teammod.update(user.id, eid, body):
            raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"employees": teammod.listing(user.id)}


@app.delete("/api/team/employees/{eid}")
def team_employee_delete(eid: str, user: User = CurrentUser):
    if not teammod.delete(user.id, eid):
        raise HTTPException(404)
    return {"employees": teammod.listing(user.id)}


ROLE_PROMPT_SYSTEM = """Sos un experto en diseñar equipos de IA. Escribí el PROMPT de un rol de un equipo que debate, diseña, construye y revisa apps.
El prompt se suma al mandato base del rol del catálogo: no lo repitas, agregá carácter y criterio propio.
Estructura (texto corrido o viñetas cortas, 120 a 220 palabras, en {language}, en segunda persona dirigida al rol):
- Quién es y desde qué experiencia mira los problemas.
- Qué prioriza y qué cosas defiende siempre.
- Qué pide como bloqueante (solo lo que rompe el producto o el negocio) y qué deja como mejora.
- Cómo habla en el debate (tono, nivel de detalle, cómo discrepa).
- Si hay CONOCIMIENTO DE LA EMPRESA, usalo: industria, clientes, stack, tono, restricciones reales.
No inventes datos de la empresa que no estén en el contexto. Devolvé SOLO el prompt, sin título ni comillas."""


@app.post("/api/team/employees/{eid}/suggest-prompt")
async def team_employee_suggest_prompt(eid: str, body: dict | None = None, user: User = CurrentUser):
    """AI help for a role's prompt: from its catalog mandate, what it knows about the company and an optional idea of the user."""
    e = teammod.get(user.id, eid)
    if not e:
        raise HTTPException(404)
    pick = _classify_model(user)
    if not pick:
        eff = keystore.creds(user.id)
        c = eff.get("baseten")
        if c and c.source != "none":
            pick = ("baseten", c.model or PROVIDERS["baseten"].default_model, c)
    if not pick:
        raise HTTPException(400, "Conectá un modelo (por ejemplo Muse) en Modelos y API keys para que la IA te sugiera prompts")
    provider, model, cred = pick
    from .roles import role_of

    r = role_of(e.get("role"))
    hint = str((body or {}).get("hint") or "").strip()[:800]
    know = teammod.knowledge_block(user.id, e.get("role"), e.get("name"), f"{e.get('name')} {hint} empresa producto clientes")
    en = str((body or {}).get("lang") or "") == "en"
    prompt_user = (f"ROL: {e.get('name')}" + (f" — {r['label']}. Mandato base: {r.get('mandate', '')}" if r else " (rol propio, sin mandato del catálogo)")
                   + (f"\n\nPROMPT ACTUAL (mejoralo, no lo descartes sin motivo):\n{e.get('persona')[:3000]}" if e.get("persona") else "")
                   + (f"\n\nLO QUE PIDE EL USUARIO:\n{hint}" if hint else "")
                   + (f"\n\n{know[:6000]}" if know else "\n\n(Sin conocimiento de la empresa cargado todavía.)"))
    result, out = CallResult(), []
    try:
        async for kind, delta in stream(provider, model, ROLE_PROMPT_SYSTEM.format(language="English" if en else "español rioplatense"), prompt_user,
                                        temperature=0.6, max_tokens=4000, result=result, cred=cred):
            if kind == "text":
                out.append(delta)
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(502, f"El modelo no respondió: {str(ex)[:200]}")
    text = re.sub(r"^\s*[\"“]|[\"”]\s*$", "", "".join(out).strip())
    if not text:
        raise HTTPException(502, "El modelo no devolvió un prompt; probá de nuevo")
    return {"prompt": text[:6000], "model": model}


FACES_DIR = DATA_DIR.parent / "faces"
FACE_STYLE = ("Editorial corporate portrait photograph, head and shoulders framed from mid-chest up with some space above the head, centered, facing the camera, soft diffused window light, realistic skin texture, "
              "shallow depth of field, painterly textured studio backdrop with a soft gradient from warm cream on the left to muted sage teal on the right, "
              "subtle film grain, refined muted color grade, square composition, no text, no logos. Person: ")


def _image_provider(user_id: str, op: str) -> tuple[str, str, str]:
    """(url, key, model) for an image call: Muse (muse-image-1.0 on the Meta key) first, OpenAI (gpt-image-2) when there is no Meta key."""
    eff = keystore.creds(user_id)
    meta, openai = eff.get("meta"), eff.get("openai")
    if meta and meta.source != "none" and meta.api_key:
        return (meta.base_url or PROVIDERS["meta"].base_url).rstrip("/") + f"/images/{op}", meta.api_key, "muse-image-1.0"
    if openai and openai.source != "none" and openai.api_key:
        return f"https://api.openai.com/v1/images/{op}", openai.api_key, "gpt-image-2"
    raise HTTPException(400, "Para crear caras con IA conectá Muse (o OpenAI) en Modelos y API keys; mientras tanto elegí una de las prediseñadas")


async def _save_face(r: httpx.Response, model: str) -> dict:
    """Store the model's image as a 384px webp under an unguessable name."""
    if r.status_code != 200:
        msg = (r.json().get("error") or {}).get("message", r.text[:200]) if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
        raise HTTPException(400 if r.status_code < 500 else 502, f"{'Muse' if model.startswith('muse') else 'OpenAI'} no generó la cara: {msg}")
    import base64
    import io

    from PIL import Image

    FACES_DIR.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(12)
    d0 = (r.json().get("data") or [{}])[0]
    raw = base64.b64decode(d0["b64_json"]) if d0.get("b64_json") else b""
    if not raw and d0.get("url"):
        async with httpx.AsyncClient(timeout=60) as cx:
            raw = (await cx.get(d0["url"])).content
    if not raw:
        raise HTTPException(502, "El modelo no devolvió la imagen; probá de nuevo")
    img = Image.open(io.BytesIO(raw)).convert("RGB").resize((384, 384), Image.LANCZOS)
    img.save(FACES_DIR / f"{name}.webp", "WEBP", quality=82, method=6)
    return {"src": f"/api/faces/{name}.webp"}


@app.post("/api/team/employees/{eid}/generate-face")
async def team_employee_generate_face(eid: str, body: dict, user: User = CurrentUser):
    """A realistic portrait for an employee, in the same editorial style as the role portraits, from the traits the user picked; billed per image."""
    if not teammod.get(user.id, eid):
        raise HTTPException(404)
    url, key, model = _image_provider(user.id, "generations")
    pick = lambda k, n=60: re.sub(r"[^\w\s,.'/-]", "", str(body.get(k) or ""))[:n].strip()  # noqa: E731
    parts = [f"a {pick('gender') or 'person'} in their {pick('age') or '30s'}", f"{pick('skin') or 'medium'} skin"]
    hair = pick("hair")
    parts.append("completely bald head" if hair in ("bald", "pelado") else f"{pick('hair_color')} {hair} hair".strip())
    if pick("beard") and pick("beard") != "none":
        parts.append(pick("beard"))
    if pick("glasses") and pick("glasses") != "none":
        parts.append(f"wearing {pick('glasses')} glasses")
    parts.append(f"wearing {pick('clothes') or 'a smart casual blazer'}")
    parts.append(f"{pick('expression') or 'calm confident expression with a slight natural smile'}")
    if pick("extra", 160):
        parts.append(pick("extra", 160))
    try:
        async with httpx.AsyncClient(timeout=240) as cx:
            req = {"model": model, "prompt": FACE_STYLE + ", ".join(parts), "size": "1024x1024", "n": 1} | ({"quality": "medium"} if model.startswith("gpt-image") else {})
            r = await cx.post(url, headers={"Authorization": f"Bearer {key}"}, json=req)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"No se pudo generar la cara: {e}")
    return await _save_face(r, model)


FACE_FROM_PHOTO = ("Turn the person in this photo into an " + FACE_STYLE.split(". Person: ")[0][0].lower() + FACE_STYLE.split(". Person: ")[0][1:] + ". "
                   "Keep their real likeness: same face shape, features, skin tone, hair, beard and glasses as in the photo, so they are clearly recognizable. "
                   "Replace the original background, lighting and framing with the style described.")


@app.post("/api/team/employees/{eid}/face-from-photo")
async def team_employee_face_from_photo(eid: str, file: UploadFile = File(...), extra: str = Form(""), user: User = CurrentUser):
    """The user's own photo turned into the role portrait style (image edit on Muse, or OpenAI). The uploaded photo is never stored."""
    if not teammod.get(user.id, eid):
        raise HTTPException(404)
    data = await file.read()
    if len(data) > 15_000_000:
        raise HTTPException(413, "La foto supera 15 MB")
    import io

    from PIL import Image, ImageOps

    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "No pude leer la imagen; subí una foto JPG, PNG o WEBP")
    img.thumbnail((1024, 1024))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    url, key, model = _image_provider(user.id, "edits")
    prompt = FACE_FROM_PHOTO + (" " + re.sub(r"[^\w\s,.'/-]", "", extra)[:200].strip() if extra.strip() else "")
    form = {"model": model, "prompt": prompt, "size": "1024x1024", "n": "1"} | ({"quality": "medium", "input_fidelity": "high"} if model.startswith("gpt-image") else {})
    try:
        async with httpx.AsyncClient(timeout=240) as cx:
            r = await cx.post(url, headers={"Authorization": f"Bearer {key}"}, data=form, files={"image": ("photo.png", buf.getvalue(), "image/png")})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"No se pudo generar la cara: {e}")
    return await _save_face(r, model)


@app.get("/api/faces/{name}")
def face_file(name: str):
    """Generated faces: random, unguessable names (they are shown in <img>, so no auth header)."""
    if not re.fullmatch(r"[a-f0-9]{24}\.webp", name) or not (FACES_DIR / name).exists():
        raise HTTPException(404)
    return FileResponse(FACES_DIR / name, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/team/employees/{eid}/docs")
def team_employee_docs(eid: str, user: User = CurrentUser):
    d = teammod.docs(user.id, eid)
    if d is None:
        raise HTTPException(404)
    return {"docs": d}


@app.post("/api/team/employees/{eid}/docs")
async def team_employee_add_doc(eid: str, body: dict, user: User = CurrentUser):
    """Feed a role: a note ({title, text}) or a public web page ({url})."""
    try:
        if body.get("url"):
            url = str(body["url"]).strip()
            title, text = await teammod.page_text(url)
            doc = teammod.add_doc(user.id, eid, str(body.get("title") or "") or title, text, "url", url)
        else:
            doc = teammod.add_doc(user.id, eid, str(body.get("title") or ""), str(body.get("text") or ""), "note")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001  (network errors reading the page)
        raise HTTPException(400, f"No pude leer la página: {e}")
    if doc is None:
        raise HTTPException(404)
    return {"docs": teammod.docs(user.id, eid)}


@app.post("/api/team/employees/{eid}/docs/file")
async def team_employee_add_file(eid: str, file: UploadFile = File(...), user: User = CurrentUser):
    """Feed a role with a document (md, txt, pdf, docx, csv, code…)."""
    data = await file.read()
    if len(data) > 25_000_000:
        raise HTTPException(413, "El documento supera 25 MB")
    try:
        text = skillmod.extract_text(file.filename or "documento", data).strip()
        doc = teammod.add_doc(user.id, eid, re.sub(r"\.[A-Za-z0-9]+$", "", file.filename or "Documento"), text, "file", file.filename or "")
    except ValueError as e:
        raise HTTPException(400, str(e) if str(e) != "No hay texto para guardar" else "El documento no tiene texto legible (¿es un PDF escaneado?)")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"No pude leer el documento: {e}")
    if doc is None:
        raise HTTPException(404)
    return {"docs": teammod.docs(user.id, eid)}


@app.delete("/api/team/employees/{eid}/docs/{did}")
def team_employee_delete_doc(eid: str, did: str, user: User = CurrentUser):
    if not teammod.delete_doc(user.id, eid, did):
        raise HTTPException(404)
    return {"docs": teammod.docs(user.id, eid)}


@app.get("/api/team/scores")
def team_scores(user: User = CurrentUser):
    """Each role's score from what actually happened: changes the user kept, blockers that held, rounds to approval."""
    return {"roles": scoresmod.compute(user.id)}


@app.post("/api/team/memory/{iid}")
def team_memory_decide(iid: str, body: dict, user: User = CurrentUser):
    """accept | dismiss a pending insight (optionally with edited text), edit or forget an accepted lesson."""
    try:
        row = memorymod.decide(user.id, iid, str(body.get("action") or ""), body.get("text"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not row:
        raise HTTPException(404)
    return memorymod.listing(user.id)


@app.post("/api/builds/{build_id}/council/apply")
async def build_council_apply(build_id: str, body: dict, user: User = CurrentUser):
    """The user accepted (a subset of) the council's change list → the builder applies it."""
    b = _build(user, build_id, body.get("session_id"))
    changes = drop_self_approval([c for c in (body.get("changes") or []) if isinstance(c, dict) and (c.get("text") or "").strip()])
    if not changes:
        raise HTTPException(400, "No hay cambios para construir: lo que falta es que el consejo lo apruebe (enviá a revisión)")
    if b.status in ("running", "reviewing"):
        raise HTTPException(409, "La construcción ya está en curso")
    if body.get("provider"):  # the user picked who builds this list (Claude Code / Codex / an API model)
        try:
            b.set_builder(str(body["provider"]), str(body.get("model") or "") or None)
        except ValueError as e:
            raise HTTPException(400, str(e))
    _learn_from_council(user, body.get("council_session") or "", changes)
    rounds = int(body.get("max_rounds") or 0)
    b.review_plan = {"max_rounds": len(b.council_sessions) + rounds} if rounds > 0 else None
    b.council_priorities = str(body.get("priorities") or "")
    refs = [r.strip() for r in body.get("references", []) if isinstance(r, str) and r.strip()] if isinstance(body.get("references"), list) else []
    b.add_references(refs, bool(body.get("deep_analysis")))
    if refs:  # benchmark first (the research screen shows it), then the builder applies the list against that bar
        b._save()
        spawn(b.research_then_apply(changes, body.get("council_session") or "", refs))
        return {"ok": True, "researching": len(refs)}
    b.apply_council(changes, body.get("council_session") or "")
    return {"ok": True}


@app.post("/api/builds/{build_id}/resume")
async def build_resume(build_id: str, body: dict, user: User = CurrentUser):
    """Continues an interrupted (error/stopped) build from where it left off, same chat, same context."""
    from .builder import CONTINUE

    b = _build(user, build_id, body.get("session_id"))
    if b.status in ("running", "reviewing"):
        raise HTTPException(409, "La construcción ya está en curso")
    if b.workdir:  # the brief may have been regenerated/completed since: give the agent the latest one
        from .exporter import session_path

        briefs = sorted(session_path(user, b.req.session_id).parent.glob(f"{b.req.session_id}.brief.*.md"), key=lambda p: p.stat().st_mtime)
        if briefs:
            latest = briefs[-1].read_text()
            if latest and latest != b.brief:
                b.brief = latest
                (b.workdir / "BRIEF.md").write_text(latest)
                b.chat.append({"role": "system", "text": "BRIEF.md actualizado con la última versión del brief.", "ts": __import__("time").time()})
    b.chat.append({"role": "system", "text": "Construcción reanudada desde donde quedó.", "ts": __import__("time").time()})
    b.resume(CONTINUE)
    return {"ok": True}


@app.post("/api/builds/{build_id}/design/approve")
async def build_design_approve(build_id: str, body: dict | None = None, user: User = CurrentUser):
    """The user approved the mockup: the build goes on to write code."""
    b = _build(user, build_id, (body or {}).get("session_id"))
    if b.status != "design_review":
        raise HTTPException(409, "Esta construcción no está esperando aprobación del diseño")
    b.approve_design()
    return {"ok": True}


@app.post("/api/builds/{build_id}/design/redo")
async def build_design_redo(build_id: str, body: dict, user: User = CurrentUser):
    """The user asked for changes: the designer does another round with that feedback, then waits again."""
    b = _build(user, build_id, body.get("session_id"))
    if b.status != "design_review":
        raise HTTPException(409, "Esta construcción no está esperando aprobación del diseño")
    fb = (body.get("feedback") or "").strip()
    if not fb:
        raise HTTPException(400, "Contá qué cambiar del diseño")
    b.redo_design(fb)
    return {"ok": True}


DESIGN_SUMMARY_SYSTEM = {
    "es": "Sos un/a Product Designer que le explica el diseño de una app a alguien sin formación técnica. Escribí en español rioplatense, claro y concreto, en Markdown corto: un párrafo de 2-3 líneas con la idea general (estilo, sensación, a qué se parece), y después secciones breves con viñetas: **Colores** (cuáles y para qué), **Tipografía**, **Pantallas** (qué hay en cada una y qué puede hacer la persona), **Componentes** (botones, tarjetas, listas… cómo se ven), **Detalles** (animaciones, estados vacíos, errores, modo oscuro, accesibilidad). Sin jerga: nada de tokens, px, hex, nombres de clases ni archivos. Máximo 300 palabras.",
    "en": "You are a Product Designer explaining an app's design to someone non-technical. Write clear, concrete, short Markdown: a 2-3 line paragraph with the overall idea (style, feel, what it resembles), then brief bulleted sections: **Colors** (which and what for), **Typography**, **Screens** (what is on each and what the person can do), **Components** (buttons, cards, lists… how they look), **Details** (animations, empty states, errors, dark mode, accessibility). No jargon: no tokens, px, hex, class or file names. 300 words max.",
}


@app.get("/api/sessions/{session_id}/builds/{build_id}/design/summary")
async def build_design_summary(session_id: str, build_id: str, lang: str = "es", refresh: bool = False, user: User = CurrentUser):
    """What the current design is, in plain language, written by a model from design/DESIGN.md + the mockup.
    Cached next to the build and keyed by the design's content, so it is rewritten only when the design changes."""
    b = _build_any(user, session_id, build_id)
    md = b.files.get("design/DESIGN.md") or ""
    html = b.files.get(buildermod.DESIGN_MOCKUP) or b.design_html or ""
    if not md and not html:
        return {"text": None, "reason": "no_design"}
    key = hashlib.sha1((md + html[:20000] + lang).encode()).hexdigest()[:16]
    cache = auth.user_dir(user.id) / f"{session_id}.build.{build_id}.design-summary.json"
    try:
        d = json.loads(cache.read_text())
        if not refresh and d.get("key") == key:
            return d
    except Exception:  # noqa: BLE001
        pass
    who = scene_gen._pick_model(user, {"agents": []})
    if not who:
        return {"text": None, "reason": "no_key"}
    provider, model, cred = who
    text_html = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I)
    text_html = re.sub(r"<[^>]+>", " ", text_html)
    text_html = " ".join(text_html.split())[:3000]
    prompt = f"PROYECTO: {b.title}\n\nDESIGN.md (lo que escribió el diseñador):\n{md[:9000]}\n\nTEXTO VISIBLE DE LA MAQUETA:\n{text_html}"
    result = provmod.CallResult()
    buf: list[str] = []
    async for kind, delta in provmod.stream(provider, model, DESIGN_SUMMARY_SYSTEM["en" if lang == "en" else "es"], prompt, temperature=0.3, max_tokens=1200, result=result, cred=cred):
        if kind == "text":
            buf.append(delta)
    out = {"key": key, "text": "".join(buf).strip(), "model": f"{provmod.PROVIDERS[provider].label} · {model}", "lang": lang, "ts": time.time()}
    try:
        cache.write_text(json.dumps(out, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        pass
    return out


@app.post("/api/builds/{build_id}/design/request")
async def build_design_request(build_id: str, body: dict, user: User = CurrentUser):
    """A specific design change, in the user's words, at any moment: during the design gate it is another designer
    round; while building it goes to the builder's inbox; on a finished build it resumes the build with the change."""
    b = _build(user, build_id, body.get("session_id"))
    text = (body.get("text") or "").strip()[:4000]
    if not text:
        raise HTTPException(400, "Contá qué cambiar del diseño")
    if b.status == "design_review":
        b.redo_design(text)
        return {"ok": True, "mode": "redo"}
    ask = (
        "CAMBIO DE DISEÑO pedido por el usuario (prioridad): " + text
        + "\n\nActuá como Product Designer + frontend: actualizá design/mockup.html y design/DESIGN.md para reflejar el cambio y aplicalo en la UI real, "
        "archivo por archivo, sin romper funcionalidad ni tests. Mantené coherencia con el resto del sistema visual. Al terminar, en <say>, resumí en lenguaje simple qué cambió visualmente."
    )
    if b.status == "running":
        b.say(ask)
        return {"ok": True, "mode": "queued"}
    b.chat.append({"role": "user", "text": f"🎨 {text}", "ts": time.time()})
    b.resume(ask)
    return {"ok": True, "mode": "resumed"}


@app.post("/api/builds/{build_id}/stop")
async def build_stop(build_id: str, user: User = CurrentUser):
    _build(user, build_id).stop()
    return {"ok": True}


@app.get("/api/sessions/{session_id}/builds/{build_id}/zip")
def build_zip(session_id: str, build_id: str, user: User = CurrentUser):
    import io
    import re as _re
    import zipfile

    b = BUILDS.get(build_id)
    if b and b.user.id == user.id:
        data, title = b.zip_bytes(), b.title
    else:
        d = load_build(user, session_id, build_id)
        if not d:
            raise HTTPException(404)
        title = d["title"]
        root = _re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "proyecto"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for p, c in d.get("file_contents", {}).items():
                z.writestr(f"{root}/{p}", c)
        data = buf.getvalue()
    name = _re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "proyecto"
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}.zip"'})


@app.websocket("/ws/builds/{build_id}")
async def ws_build(ws: WebSocket, build_id: str):
    await ws.accept()
    user = auth.user_from_token(ws.query_params.get("token"))
    b = BUILDS.get(build_id)
    if (not b or b.user.id != user.id) and user and ws.query_params.get("session"):
        # the server restarted while the page was open: bring the saved build back so the UI shows its real state
        try:
            b = _build(user, build_id, ws.query_params.get("session"))
        except HTTPException:
            b = None
    if not b or not user or b.user.id != user.id:
        await ws.send_json({"type": "error", "error": "build not found"})
        await ws.close()
        return
    q = b.subscribe()
    try:
        app_live = b.app_run is not None and b.app_run.status in ("installing", "starting", "running")
        if b.status not in ("running", "reviewing", "design_review") and not app_live:
            q.put_nowait(None)
        while True:
            ev = await q.get()
            if ev is None:
                break
            await ws.send_json(ev)
        await ws.close()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        b.unsubscribe(q)


@app.websocket("/ws/sessions/{session_id}")
async def ws_session(ws: WebSocket, session_id: str):
    await ws.accept()
    user = auth.user_from_token(ws.query_params.get("token"))
    s = SESSIONS.get(session_id)
    if not s or not user or s.owner.id != user.id:
        await ws.send_json({"type": "error", "error": "session not found"})
        await ws.close()
        return
    q = s.subscribe()
    try:
        if s.status in ("completed", "stopped", "error"):
            q.put_nowait(None)
        while True:
            ev = await q.get()
            if ev is None:
                break
            await ws.send_json(ev)
        await ws.close()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        s.unsubscribe(q)


# --------------------------------------------------------------------------- run the built app locally

def _run_root(b) -> "Path":
    return deploymod.materialize(b.user.id, b.id, b.files, b.workdir)


@app.get("/api/sessions/{session_id}/builds/{build_id}/run")
def app_run_state(session_id: str, build_id: str, user: User = CurrentUser):
    """Runnable services detected in the project + the current run (if any)."""
    b = _build_any(user, session_id, build_id)
    r = runmod.RUNS.get(build_id)
    return {"services": runmod.detect(_run_root(b)), "run": r.state() if r else None}


@app.post("/api/sessions/{session_id}/builds/{build_id}/run")
async def app_run_start(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    _check_capacity(user.id)
    root = _run_root(b)
    services = runmod.detect(root)
    svc = next((s for s in services if s["id"] == body.get("service")), services[0] if services else None)
    if not svc:
        raise HTTPException(400, "No hay nada que se pueda correr en este proyecto")
    old = runmod.RUNS.get(build_id)
    if old and old.status in ("installing", "starting", "running"):
        raise HTTPException(409, "La app ya está corriendo")
    r = runmod.AppRun(root, svc, user.id, build_id, b.files, lambda t, d: b.emit(t, **d))
    runmod.RUNS[build_id] = r
    b.app_run = r
    from .tasks import spawn

    r.task = spawn(r.run())
    return {"ok": True, "port": r.port}


@app.delete("/api/sessions/{session_id}/builds/{build_id}/run")
async def app_run_stop(session_id: str, build_id: str, user: User = CurrentUser):
    _build_any(user, session_id, build_id)
    r = runmod.RUNS.get(build_id)
    if r:
        await r.stop()
    return {"ok": True}


# «Correr la app» on a server: the user's browser can't open the server's 127.0.0.1, so the app is reached through Tably at
# <run base>/r/<token>/ — preferably another host than Tably's own (TABLY_RUN_URL, or Railway's service domain), so the
# app's code never shares an origin with Tably's session. Absolute paths the app asks for (/assets/x.js, /api/…) come back
# here with a Referer under /r/<token>/ and are sent into it (see SecurityHeaders).
def _run_base() -> str | None:
    if env("TABLY_RUN_URL"):
        return env("TABLY_RUN_URL").rstrip("/")
    pub = cloudmod.public_url()
    if re.search(r"//(localhost|127\.0\.0\.1)", pub):
        return None
    dom = env("RAILWAY_PUBLIC_DOMAIN")
    return f"https://{dom}" if dom and dom not in pub else pub


runmod.RUN_BASE = _run_base()
_RUN_HTTP = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5), follow_redirects=False)
_RUN_DROP = {"content-security-policy", "content-security-policy-report-only", "x-frame-options", "referrer-policy", "content-length", "transfer-encoding", "content-encoding", "connection", "keep-alive"}
_RUN_HOP = {"host", "connection", "keep-alive", "accept-encoding", "content-length", "x-tably-sw"}
_RUN_GONE = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>La app no está corriendo</title>"
             "<body style='margin:0;display:grid;place-items:center;min-height:100vh;font:15px system-ui;color:#1E2622;background:#F7F5F0'>"
             "<div style='max-width:420px;padding:24px;text-align:center'><h1 style='font-size:20px'>Este link es de una app que estabas probando en Tably</h1>"
             "<p style='color:#55625C'>Solo funciona mientras la app está corriendo. Abrila en Tably y tocá «Correr la app»; para compartirlo con otras personas, publicala.</p>"
             "<a href='/' style='display:inline-block;margin-top:8px;padding:10px 18px;border-radius:999px;background:#2F6B5D;color:#fff;text-decoration:none;font-weight:600'>Ir a Tably</a></div></body>")
_RUN_WAIT = ("<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=4><title>Cargando…</title>"
             "<body style='margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;color:#55625C;background:#F7F5F0'>Cargando…</body>")


def _run_shim(prefix: str) -> str:
    """First script of the app's page when it runs at /r/<token>/: the app sees itself at «/» (its router finds its pages) and
    every absolute path it asks for (/api/…, /img/…) goes to the app, not to Tably. Navigations that still leave
    (location.href = "/x", a plain link) come back through the tably_run cookie (see SecurityHeaders)."""
    return ("(function(){if(window.__tablyRun)return;var P=" + json.dumps(prefix) + ",O=location.origin;window.__tablyRun=P;"
            "function fix(u){try{var s=u instanceof URL?u.href:u;if(typeof s!=='string')return u;"
            "if(s.indexOf(O+'/')===0)s=s.slice(O.length);else if(/^[a-z][a-z0-9+.-]*:|^\\/\\//i.test(s))return u;"
            "if(s.charAt(0)==='/'&&s!==P&&s.indexOf(P+'/')!==0)return P+s;return u}catch(e){return u}}"
            "if(location.pathname.indexOf(P)===0)history.replaceState(history.state,'',(location.pathname.slice(P.length)||'/')+location.search+location.hash);"
            "var F=window.fetch;if(F)window.fetch=function(i,o){try{if(i instanceof Request){var n=fix(i.url);if(n!==i.url)i=new Request(n,i)}else i=fix(i)}catch(e){}return F.call(this,i,o)};"
            "var X=window.XMLHttpRequest;if(X){var op=X.prototype.open;X.prototype.open=function(m,u){arguments[1]=fix(u);return op.apply(this,arguments)}}"
            "if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,c){return new E(fix(u),c)};window.EventSource.prototype=E.prototype}"
            "if(navigator.sendBeacon){var B=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return B(fix(u),d)}}"
            "var A={IMG:'src',SCRIPT:'src',IFRAME:'src',VIDEO:'src',AUDIO:'src',SOURCE:'src',LINK:'href',FORM:'action'};"
            "function el(n){var a=n&&A[n.tagName];if(!a)return;var v=n.getAttribute(a);if(v){var w=fix(v);if(w!==v)n.setAttribute(a,w)}}"
            "function all(r){if(!r||!r.querySelectorAll)return;el(r);r.querySelectorAll('img,script,iframe,video,audio,source,link,form').forEach(el)}"
            "new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==='attributes')el(m.target);else m.addedNodes.forEach(all)})})"
            ".observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','action']});"
            "})();")


@app.api_route("/r/{token}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
async def run_proxy(token: str, path: str, request: Request):
    r = runmod.TOKENS.get(token)
    if not r:
        return Response(_RUN_WAIT, status_code=404, media_type="text/html")
    if path == "__tably/errors" and request.method == "POST":  # the reporter in the app's page: browser errors
        try:
            body = json.loads((await request.body())[:8000] or b"{}")
        except ValueError:
            body = {}
        msg = str((body or {}).get("message") or "")[:500]
        if msg and body.get("kind") != "http" and not incidentsmod.BROWSER_NOISE.search(msg + str(body.get("stack") or "")) and r.status == "running" and not r.fix:
            incidentsmod.record(r.user_id, r.build_id, "run", msg, f"{msg}\n(página: {str(body.get('page') or '')[:200]})\n{str(body.get('stack') or '')[:2000]}")
            spawn(_kick_async(r.user_id, r.build_id))
        return Response(status_code=204)
    if r.status != "running":
        return Response(_RUN_WAIT, status_code=503, media_type="text/html")
    host = f"[{r.host}]" if ":" in r.host else r.host
    url = f"http://{host}:{r.port}/{path}" + (f"?{request.url.query}" if request.url.query else "")
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in _RUN_HOP]
    headers.append(("host", f"127.0.0.1:{r.port}"))
    body = await request.body()
    try:
        resp = await _RUN_HTTP.send(_RUN_HTTP.build_request(request.method, url, headers=headers, content=body or None), stream=True)
    except httpx.HTTPError:
        return Response(_RUN_WAIT, status_code=503, media_type="text/html")
    prefix = f"/r/{token}"
    out = []
    for k, v in resp.headers.multi_items():
        if k.lower() in _RUN_DROP:
            continue
        if k.lower() == "location" and v.startswith("/") and not v.startswith(prefix):
            v = prefix + v
        out.append((k, v))
    ctype = resp.headers.get("content-type", "")
    if resp.status_code >= 500 and r.status == "running" and not r.fix:  # the app's server failed a request: its log says why
        await asyncio.sleep(0.4)  # let the log pump catch up with what the server printed before answering
        tail = [ln for ln in r.logs[-60:] if ln.strip()]
        head = incidentsmod.log_headline(tail)
        incidentsmod.record(r.user_id, r.build_id, "run", head or f"{request.method} /{path} → {resp.status_code}", f"{request.method} /{path} → {resp.status_code}\n--- log ---\n" + "\n".join(tail))
        spawn(_kick_async(r.user_id, r.build_id))
    if "text/html" in ctype:  # the page reports its own errors back (uncaught exceptions, rejected promises)
        html = (await resp.aread()).decode(resp.encoding or "utf-8", "replace")
        await resp.aclose()
        tag = f"<script>{_run_shim(prefix)}</script><script>{incidentsmod.reporter_js(prefix + '/__tably/errors')}</script>"
        m = re.search(r"<head[^>]*>", html, re.I)  # first thing in the page, so it sees the app's own errors
        html = html[:m.end()] + tag + html[m.end():] if m else tag + html
        out.append(("set-cookie", f"tably_run={token}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly" + ("; Secure" if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https" else "")))
        return _run_response(html.encode(), resp.status_code, out)

    async def stream():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()

    sr = StreamingResponse(stream(), status_code=resp.status_code)
    for k, v in out:
        sr.headers.append(k, v)
    return sr


def _run_response(body: bytes, status: int, headers: list[tuple[str, str]]) -> Response:
    resp = Response(body, status_code=status)
    for k, v in headers:
        resp.headers.append(k, v)
    return resp


@app.api_route("/r/{token}", methods=["GET", "HEAD"], include_in_schema=False)
async def run_proxy_root(token: str):
    return Response(status_code=307, headers={"Location": f"/r/{token}/"})


# --------------------------------------------------------------------------- skills (knowledge attached to roles)

@app.get("/api/skills")
def skills_list(user: User = CurrentUser):
    return {"skills": skillmod.list_skills(user.id), "templates": [template_en({k: t[k] for k in ("id", "name", "description", "tags")} | {"chars": len(t["body"])}) for t in skillmod.TEMPLATES]}


class SuggestBody(BaseModel):
    text: str
    roles: list[dict] = []  # [{id, label, group}]
    k: int = 4


ROLE_GROUP_TO_CATALOG = {"Dirección": "ceo", "Producto": "product", "Ingeniería": "backend", "Diseño": "design", "Datos e IA": "data", "Negocio": "growth", "Calidad y seguridad": "qa", "Otros": None}


@app.get("/api/skills/catalog")
def skills_catalog_search(q: str = "", category: str = "", limit: int = 80, user: User = CurrentUser):
    """Public skills catalog (downloaded repos), searchable and grouped by category."""
    return {"skills": catalog.search(q, category, limit), "categories": catalog.categories(), "total": len(catalog.index()), "sync": catalog.SYNC}


@app.get("/api/skills/catalog/sync")
def skills_catalog_sync_status(user: User = CurrentUser):
    return catalog.SYNC | {"total_skills": len(catalog.index())}


@app.post("/api/skills/catalog/sync")
def skills_catalog_sync(user: User = CurrentUser):
    """Download/update every source and rebuild the index (background)."""
    started = catalog.sync_in_background()
    return {"started": started, **catalog.SYNC}


class TranslateBody(BaseModel):
    provider: str
    model: str


@app.post("/api/skills/catalog/translate")
async def skills_catalog_translate(body: TranslateBody, user: User = CurrentUser):
    """Translate the catalog's names/descriptions to Spanish with one of the user's models (background, cached)."""
    eff = keystore.creds(user.id)
    if body.provider not in PROVIDERS or (PROVIDERS[body.provider].kind != "mock" and body.provider not in eff):
        raise HTTPException(400, "Proveedor sin API key")
    if not catalog.TRANSLATE["running"]:
        spawn(catalog.translate_missing(body.provider, body.model, eff.get(body.provider)))
    return catalog.TRANSLATE | {"translated": len(catalog.translations()), "total_skills": len(catalog.index())}


@app.get("/api/skills/catalog/translate")
def skills_catalog_translate_status(user: User = CurrentUser):
    return catalog.TRANSLATE | {"translated": len(catalog.translations()), "total_skills": len(catalog.index())}


@app.post("/api/skills/suggest")
def skills_suggest(body: SuggestBody, user: User = CurrentUser):
    """Catalog skills a task needs, per role: {role_id: [skill…]} plus a general list."""
    per_role = {}
    for r in body.roles:
        grp = ROLE_GROUP_TO_CATALOG.get(r.get("group") or "", None)
        per_role[r.get("id")] = catalog.suggest(f"{body.text}\n{r.get('mandate', '')}", k=body.k, role_group=grp)  # the mandate says what the role needs; its title only adds noise
    return {"general": catalog.suggest(body.text, k=body.k * 2), "per_role": per_role}


@app.get("/api/skills/{skill_id}")
def skills_get(skill_id: str, user: User = CurrentUser):
    if skill_id.startswith("cat-"):
        c = catalog.get(skill_id)
        if not c:
            raise HTTPException(404)
        return catalog.localized(c) | {"body": catalog.body(skill_id) or ""}
    sk = next((t for t in skillmod.TEMPLATES if t["id"] == skill_id), None) if skill_id.startswith("tpl-") else skillmod.get_skill(user.id, skill_id)
    if not sk:
        raise HTTPException(404)
    return sk


@app.post("/api/skills")
def skills_create(body: dict, user: User = CurrentUser):
    try:
        return skillmod.save_skill(user.id, str(body.get("name") or ""), str(body.get("body") or ""), str(body.get("description") or ""), str(body.get("tags") or ""), body.get("id") or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/documents/text")
async def document_text(file: UploadFile = File(...), user: User = CurrentUser):
    """Plain text of a document (md, txt, pdf, docx, code…) — used to replace a role's prompt with a full brief."""
    data = await file.read()
    if len(data) > 25_000_000:
        raise HTTPException(413, "El documento supera 25 MB")
    try:
        text = skillmod.extract_text(file.filename or "documento", data).strip()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"No pude leer el documento: {e}")
    if not text:
        raise HTTPException(400, "El documento no tiene texto legible (¿es un PDF escaneado?)")
    cap = 60_000
    return {"text": text[:cap], "chars": len(text), "truncated": len(text) > cap, "filename": file.filename}


@app.post("/api/skills/upload")
async def skills_upload(file: UploadFile = File(...), name: str = Form(""), user: User = CurrentUser):
    """A document (md, txt, pdf, docx, code…) becomes a skill in the user's library: the role's memory / full brief."""
    data = await file.read()
    if len(data) > 25_000_000:
        raise HTTPException(413, "El documento supera 25 MB")
    try:
        text = skillmod.extract_text(file.filename or "documento", data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"No pude leer el documento: {e}")
    text = text.strip()
    if not text:
        raise HTTPException(400, "El documento no tiene texto legible (¿es un PDF escaneado?)")
    cut = len(text) > skillmod.MAX_BODY
    title = (name.strip() or re.sub(r"\.[A-Za-z0-9]+$", "", file.filename or "Documento")).strip()[:120]
    try:
        sk = skillmod.save_skill(user.id, title, text, description=f"Documento adjunto: {file.filename} ({len(text):,} caracteres{' · recortado' if cut else ''})", tags="documento")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return sk | {"truncated": cut, "chars_total": len(text)}


@app.delete("/api/skills/{skill_id}")
def skills_delete(skill_id: str, user: User = CurrentUser):
    if not skillmod.delete_skill(user.id, skill_id):
        raise HTTPException(404)
    return {"ok": True}


@app.patch("/api/sessions/{session_id}/agents/{agent_id}/skills")
def session_agent_skills(session_id: str, agent_id: str, body: dict, user: User = CurrentUser):
    """Attach skills to a role mid-session (debate or council); applies from its next turn."""
    s = SESSIONS.get(session_id)
    if not s or s.owner.id != user.id:
        raise HTTPException(404)
    if agent_id not in s.agents:
        raise HTTPException(404, "agente no encontrado")
    ids = [str(x) for x in (body.get("skills") or []) if isinstance(x, str)]
    s.update_agent_skills(agent_id, ids)
    return {"ok": True, "skills": s.agents[agent_id].skills}


@app.patch("/api/builds/{build_id}/team/{agent_id}/skills")
def build_team_skills(build_id: str, agent_id: str, body: dict, user: User = CurrentUser):
    """Skills for a role of the build's team: the next council round, review or design phase uses them."""
    b = _build(user, build_id, body.get("session_id"))
    ids = [str(x) for x in (body.get("skills") or []) if isinstance(x, str)]
    if not b.set_team_skills(agent_id, ids):
        raise HTTPException(404, "rol no encontrado en el equipo")
    return {"ok": True}


@app.put("/api/builds/{build_id}/team")
def build_team_set(build_id: str, body: dict, user: User = CurrentUser):
    """The council itself: which roles sit at the table and with which company/model. Used before sending to review."""
    b = _build(user, build_id, body.get("session_id"))
    team = body.get("team")
    if not isinstance(team, list) or len([a for a in team if isinstance(a, dict)]) < 2:
        raise HTTPException(400, "El consejo necesita al menos 2 roles")
    return {"ok": True, "team": b.set_team(team)}


# --------------------------------------------------------------------------- FDE: "pedir un developer" (fixed-price packages)

@app.get("/api/fde/packages")
def fde_packages(_: User = CurrentUser):
    return {"packages": [p | fdemod.links(p["id"]) for p in fdemod.PACKAGES], "booking_url": fdemod.links("x")["booking_url"], "stripe": billing.status()}


@app.post("/api/fde/requests")
def fde_create(body: dict, user: User = CurrentUser):
    """Creates the request with a ticket built from the project's real state (version, blockers, missing services, stack)."""
    pkg = fdemod.package(str(body.get("package") or ""))
    if not pkg:
        raise HTTPException(400, "paquete inválido")
    session_id, build_id = str(body.get("session_id") or ""), str(body.get("build_id") or "")
    b = _build_any(user, session_id, build_id)
    services = deploymod.services_for(b.files, b.brief, set(deploymod.load_secrets(user.id, build_id)))
    try:
        stack = runmod.detect(deploymod.materialize(user.id, build_id, b.files, b.workdir))
    except Exception:
        stack = []
    ticket = fdemod.build_ticket(b, services, stack, pkg, str(body.get("notes") or ""), str(body.get("contact") or user.email))
    req = fdemod.create_request(user.id, session_id, build_id, pkg, ticket, str(body.get("notes") or ""), str(body.get("contact") or user.email))
    b.chat.append({"role": "system", "text": f"Pedido de developer creado: {pkg['name']} ({req['id']}).", "ts": __import__("time").time()})
    b._save()
    return req | fdemod.links(pkg["id"])


# --------------------------------------------------------------------------- billing (Stripe Checkout)

def _fees_due(b) -> list[dict]:
    return [f for f in b.fees if not f.get("paid")]


@app.post("/api/billing/checkout")
async def billing_checkout(body: dict, user: User = CurrentUser):
    """Starts a Stripe Checkout for a developer request (kind=fde, ref=request id) or for a build's unpaid per-use
    fees (kind=fees, build_id + session_id). Returns the hosted page URL."""
    if not billing.enabled():
        raise HTTPException(503, "Pagos no configurados: falta STRIPE_SECRET_KEY en el .env del backend")
    kind = str(body.get("kind") or "")
    session_id, build_id = str(body.get("session_id") or ""), str(body.get("build_id") or "")
    back = f"#live={session_id}" if session_id else ""
    if kind == "fde":
        r = fdemod.get_request(user.id, str(body.get("ref") or ""))
        if not r:
            raise HTTPException(404, "pedido no encontrado")
        pkg = fdemod.package(r["package"]) or {}
        hours = max(4, int(body.get("hours") or 4)) if r["package"] == "hours" else 1
        amount = float(pkg.get("price_usd", 0)) * hours
        name = f"Tably Team · {pkg.get('name', r['package'])}" + (f" × {hours} h" if hours > 1 else "")
        try:
            o = await billing.create_checkout(user.id, user.email, "fde", r["id"], name, f"Pedido {r['id']} · {r['ticket'].get('project', {}).get('title', '')}", amount, back, r["build_id"], r["session_id"])
        except RuntimeError as e:
            raise HTTPException(502, str(e))
        return o
    if kind == "fees":
        b = _build_any(user, session_id, build_id)
        due = _fees_due(b)
        total = round(sum(float(f.get("usd") or 0) for f in due), 2)
        if total <= 0:
            raise HTTPException(400, "no hay cargos pendientes")
        try:
            o = await billing.create_checkout(user.id, user.email, "fees", build_id, "Tably Team · cargos por uso", " · ".join(f.get("label", "") for f in due)[:300], total, back, build_id, session_id)
        except RuntimeError as e:
            raise HTTPException(502, str(e))
        return o
    raise HTTPException(400, "kind inválido")


async def _settle(o: dict) -> None:
    """A paid order takes effect: the request moves to 'paid'; the build's fees are marked paid."""
    if o.get("status") != "paid":
        return
    if o["kind"] == "fde":
        fdemod.update_request(o["user_id"], o["ref"], status="paid")
    elif o["kind"] == "fees":
        b = BUILDS.get(o["build_id"])
        if b is not None:
            for f in b.fees:
                f["paid"] = True
            b._save()
        else:  # finished build only on disk: flip the flags in its saved file
            p = auth.user_dir(o["user_id"]) / f"{o['session_id']}.build.{o['build_id']}.json"
            try:
                d = json.loads(p.read_text())
                for f in d.get("fees", []):
                    f["paid"] = True
                p.write_text(json.dumps(d, ensure_ascii=False))
            except Exception as e:  # noqa: BLE001
                log.warning("could not settle fees on %s: %s", p, e)


@app.post("/api/billing/confirm")
async def billing_confirm(body: dict, user: User = CurrentUser):
    """Back from Stripe: read the session and settle. Safe to call many times."""
    o = await billing.confirm(str(body.get("checkout") or ""))
    if not o or o["user_id"] != user.id:
        raise HTTPException(404, "orden no encontrada")
    await _settle(o)
    return o


@app.get("/api/billing/orders")
def billing_orders(build_id: str | None = None, user: User = CurrentUser):
    return billing.list_orders(user.id, build_id)


@app.post("/api/billing/webhook")
async def billing_webhook(request: Request):
    payload = await request.body()
    ev = billing.verify_webhook(payload, request.headers.get("stripe-signature", ""))
    if ev is None:
        raise HTTPException(400, "firma inválida o webhook no configurado")
    if ev.get("type") in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        o = await billing.confirm(ev["data"]["object"]["id"])
        if o:
            await _settle(o)
    return {"ok": True}


@app.get("/api/fde/requests")
def fde_list(session_id: str | None = None, user: User = CurrentUser):
    return [r | fdemod.links(r["package"]) for r in fdemod.list_requests(user.id, session_id)]


@app.get("/api/fde/requests/{rid}/ticket.md")
def fde_ticket(rid: str, user: User = CurrentUser):
    r = fdemod.get_request(user.id, rid)
    if not r:
        raise HTTPException(404)
    return PlainTextResponse(fdemod.ticket_markdown(r["ticket"]), media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="pedido-{rid}.md"'})


@app.patch("/api/fde/requests/{rid}")
def fde_update(rid: str, body: dict, user: User = CurrentUser):
    status = body.get("status")
    if status and status not in ("cancelled",):  # the user can only cancel; the rest is the engineer's side
        raise HTTPException(400, "estado inválido")
    r = fdemod.update_request(user.id, rid, status=status, notes=body.get("notes"))
    if not r:
        raise HTTPException(404)
    return r


@app.on_event("startup")
async def _startup():
    from .tasks import start_runner

    start_runner()
    cloudmod.resume_watchers()  # Tably Cloud apps still deploying on Railway get their «is it up yet?» watcher back
    spawn(incidentsmod.monitor())  # published apps: their errors go to the builder, fixed and published again
    spawn(adtiermod.daily_loop())  # AdTier: videos whose embed stopped working are unpublished


# ================================================================================================ Tably Cloud · git propio, publicar, base de datos, migrar


# ------------------------------------------------------------------------------------------------ tickets (Notion → team → builder → PR)

def _notion_token(user: User) -> str:
    tok = keystore.get_key(user.id, "notion")
    if not tok:
        raise HTTPException(400, "Conectá Notion primero (token de integración).")
    return tok


_NOTION_STATES: dict[str, tuple[str, float]] = {}  # oauth state → (user id, expiry)


def _notion_redirect() -> str:
    return (env("NOTION_REDIRECT_URI") or f"{cloudmod.public_url()}/api/notion/callback")


def _is_admin(user: User) -> bool:
    """Who may set installation-wide settings: the emails in TABLY_ADMIN_EMAILS, else the first account created."""
    admins = [e.strip().lower() for e in (env("TABLY_ADMIN_EMAILS") or "").split(",") if e.strip()]
    if admins:
        return user.email.lower() in admins
    with auth._db() as c:
        first = c.execute("SELECT id FROM users ORDER BY created ASC LIMIT 1").fetchone()
    return bool(first and first["id"] == user.id)


@app.get("/api/settings/notion-app")
def notion_app_get(user: User = CurrentUser):
    """The app's Notion OAuth client (one per installation): set from the UI by the admin, never sent to other browsers."""
    cid, sec = ticketsmod.oauth_creds()
    return {"admin": _is_admin(user), "client_id": cid if _is_admin(user) else None, "has_secret": bool(sec), "configured": bool(cid and sec), "redirect_uri": _notion_redirect(),
            "from_env": bool(env("NOTION_CLIENT_ID")) and not ticketsmod._setting("notion_client_id")}


@app.put("/api/settings/notion-app")
def notion_app_set(body: dict, user: User = CurrentUser):
    if not _is_admin(user):
        raise HTTPException(403, "Solo quien administra esta instalación puede cargar la conexión de Notion.")
    if body.get("clear"):
        ticketsmod.set_setting("notion_client_id", None)
        ticketsmod.set_setting("notion_client_secret", None)
        return notion_app_get(user)
    cid = str(body.get("client_id") or "").strip()
    sec = str(body.get("client_secret") or "").strip()
    if cid:
        ticketsmod.set_setting("notion_client_id", cid)
    if sec:
        ticketsmod.set_setting("notion_client_secret", sec)
    return notion_app_get(user)


@app.get("/api/notion/oauth/url")
def notion_oauth_url(user: User = CurrentUser):
    """«Conectar con Notion» with one click (needs the operator's public integration); null when not configured."""
    if not ticketsmod.oauth_configured():
        return {"url": None}
    now = time.time()
    for k, (_, exp) in list(_NOTION_STATES.items()):
        if exp < now:
            _NOTION_STATES.pop(k, None)
    state = secrets.token_urlsafe(24)
    _NOTION_STATES[state] = (user.id, now + 600)
    return {"url": ticketsmod.oauth_url(_notion_redirect(), state)}


@app.get("/api/notion/callback")
def notion_callback(code: str = "", state: str = "", error: str = ""):
    """Notion sends the user back here; the token is saved for the account that started the flow and the app reopens on Tickets."""
    from fastapi.responses import RedirectResponse

    front = (env("TABLY_APP_URL") or env("TABLY_CLOUD_URL") or "http://localhost:5173").rstrip("/")
    uid_exp = _NOTION_STATES.pop(state, None)
    if error or not code or not uid_exp or uid_exp[1] < time.time():
        return RedirectResponse(f"{front}/#tickets=error", status_code=302)
    try:
        tok = ticketsmod.oauth_exchange(code, _notion_redirect())
    except ticketsmod.NotionError as e:
        log.warning("notion oauth: %s", e)
        return RedirectResponse(f"{front}/#tickets=error", status_code=302)
    if tok.get("access_token"):
        keystore.save(uid_exp[0], "notion", api_key=tok["access_token"])
    return RedirectResponse(f"{front}/#tickets", status_code=302)


@app.get("/api/notion/status")
def notion_status(user: User = CurrentUser):
    st = keystore.key_status(user.id, "notion")
    out: dict = {**st, "me": None, "error": None, "oauth": ticketsmod.oauth_configured()}
    if st["set"]:
        try:
            out["me"] = ticketsmod.me(keystore.get_key(user.id, "notion") or "")
        except ticketsmod.NotionError as e:
            out["error"] = str(e)
    return out


@app.put("/api/settings/notion")
def settings_notion(body: dict, user: User = CurrentUser):
    tok = (body.get("token") or "").strip()
    if tok:
        try:
            ticketsmod.me(tok)
        except ticketsmod.NotionError as e:
            raise HTTPException(400, str(e))
    keystore.save(user.id, "notion", api_key=tok or None, clear_key=bool(body.get("clear")))
    return notion_status(user)


@app.get("/api/notion/databases")
def notion_databases(user: User = CurrentUser):
    try:
        return {"databases": ticketsmod.databases(_notion_token(user))}
    except ticketsmod.NotionError as e:
        raise HTTPException(400, str(e))


@app.get("/api/tickets/config")
def tickets_config(user: User = CurrentUser):
    link = ticketsmod.get_link(user.id)
    schema = None
    if link and link.get("database_id") and keystore.key_status(user.id, "notion")["set"]:
        try:
            schema = ticketsmod.schema(keystore.get_key(user.id, "notion") or "", link["database_id"])
        except ticketsmod.NotionError as e:
            schema = {"error": str(e)}
    return {"link": link, "schema": schema, "github": keystore.key_status(user.id, "github")}


@app.put("/api/tickets/config")
def tickets_config_save(body: dict, user: User = CurrentUser):
    """Which Notion database holds the tickets, which Tably project resolves them, and how the statuses map."""
    fields: dict = {}
    if "database_id" in body:
        db_id = str(body.get("database_id") or "")
        if db_id:
            try:
                sc = ticketsmod.schema(_notion_token(user), db_id)
            except ticketsmod.NotionError as e:
                raise HTTPException(400, str(e))
            fields.update(database_id=db_id, database_title=sc["title"], props={**sc["props"], "status_type": sc["status_type"]},
                          status_map=body.get("status_map") if isinstance(body.get("status_map"), dict) and body.get("status_map") else sc["status_map"])
        else:
            fields.update(database_id=None, database_title=None, props={}, status_map={})
    if isinstance(body.get("status_map"), dict) and "database_id" not in body:
        fields["status_map"] = body["status_map"]
    if "session_id" in body or "build_id" in body:
        sid, bid = body.get("session_id") or None, body.get("build_id") or None
        if sid and bid:
            _build_any(user, sid, bid)  # must be the user's
        fields.update(session_id=sid, build_id=bid, repo_url=None if (ticketsmod.get_link(user.id) or {}).get("build_id") != bid else (ticketsmod.get_link(user.id) or {}).get("repo_url"))
    if "assignee" in body:
        fields["assignee"] = body.get("assignee") or None
    if "repo_url" in body:
        fields["repo_url"] = (body.get("repo_url") or "").strip() or None
    if "projects" in body:
        # {"prop": "Feature", "map": {"Codifier": {"session_id", "build_id", "repo_url"}, ...}}: one Tably project per value of that property
        pr = body.get("projects") if isinstance(body.get("projects"), dict) else {}
        prop = (pr.get("prop") or "").strip() or None
        mp: dict = {}
        for key, m in (pr.get("map") or {}).items() if isinstance(pr.get("map"), dict) else []:
            if not isinstance(m, dict):
                continue
            sid, bid = m.get("session_id") or None, m.get("build_id") or None
            if sid and bid:
                _build_any(user, sid, bid)  # must be the user's
            entry = {"session_id": sid if bid else None, "build_id": bid if sid else None, "repo_url": (m.get("repo_url") or "").strip() or None}
            if entry["build_id"] or entry["repo_url"]:
                mp[str(key)] = entry
        fields["projects"] = {"prop": prop, "map": mp}
    link = ticketsmod.save_link(user.id, **fields)
    return tickets_config(user)


def _ticket_status(run: dict | None, b=None) -> dict | None:
    """What the screen shows for a ticket the team took: building / reviewing / changes / pr / error."""
    if not run:
        return None
    st = run["status"]
    if b is not None and st in ("building", "reviewing"):
        st = "building" if b.status in ("running", "design_review") else "reviewing" if b.status == "reviewing" or (b.council_sessions and b.status == "running") else st
        if b.status in ("completed", "approved", "stopped", "error") and run["status"] == "building" and not b.pending_council() and not b.council_sessions:
            st = "built"
    return {**run, "status": st}


_CLOSED_RX = re.compile(r"cancel|archiv|\bold\b|descart|won'?t|duplic", re.I)


@app.get("/api/tickets")
def tickets_list(all: bool = False, user: User = CurrentUser):
    """Open tickets (done, cancelled and archived ones are left out unless `all`), with the properties the screen can group by."""
    link = ticketsmod.get_link(user.id)
    if not link or not link.get("database_id"):
        return {"link": link, "tickets": [], "runs": {}, "groupable": []}
    try:
        token = _notion_token(user)
        items = ticketsmod.tickets(token, link["database_id"], link.get("props") or {})
        groupable = ticketsmod.groupable_props(token, link["database_id"])
    except ticketsmod.NotionError as e:
        raise HTTPException(400, str(e))
    done = (link.get("status_map") or {}).get("done")
    if not all:
        items = [t for t in items if not ((done and t.get("status") == done) or (t.get("status") and _CLOSED_RX.search(t["status"])))]
    runs = ticketsmod.runs(user.id)
    out_runs = {}
    for pid, r in runs.items():
        b = BUILDS.get(r.get("build_id") or "")
        out_runs[pid] = _ticket_status(r, b if b and b.user.id == user.id else None)
    pprop = (link.get("projects") or {}).get("prop")
    assigned = ticketsmod.assigned_projects(user.id)
    for t in items:  # which Tably project takes each ticket (by hand, by Feature, detected from its text, or the default one)
        t["project"] = ticketsmod.project_for_ticket(link, t.get("fields") or {}, assigned.get(t["id"]))
        t["project_value"] = ", ".join(ticketsmod.project_values(t.get("fields") or {}, pprop)) or None
    return {"link": link, "tickets": items, "runs": out_runs, "groupable": groupable, "classify": _CLASSIFY_JOBS.get(user.id)}


_CLASSIFY_JOBS: dict[str, dict] = {}


def _user_builds(user: User) -> list[dict]:
    """Every saved build of the user (session + build ids, title, repo url) for the project index."""
    from .auth import user_dir
    link = ticketsmod.get_link(user.id) or {}
    out = []
    for p in sorted(user_dir(user.id).glob("*.build.*.json"), reverse=True):
        sid, _, bid = p.stem.partition(".build.")
        if not sid or not bid:
            continue
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        pj = ticketsmod.project_by_build(link, bid) or {}
        out.append({"session_id": sid, "build_id": bid, "title": d.get("title") or bid, "repo_url": pj.get("repo_url")})
    return out


def _classify_model(user: User):
    """Muse first, then any other configured API provider; none → only the deterministic match is used."""
    eff = keystore.creds(user.id)
    for pid in ("meta", "anthropic", "openai", "gemini", "deepseek", "xai", "groq", "kimi", "mistral", "openrouter"):
        c = eff.get(pid)
        if c and c.source != "none":
            return pid, c.model or PROVIDERS[pid].default_model, c
    return None


async def _classify_llm(who, index: list[dict], title: str, text: str) -> dict | None:
    """Ask the model which project the ticket belongs to, given each project's name and top-level layout."""
    from .providers import CallResult, stream
    projects = "\n".join(f"- id={pj['build_id']} · {pj['title']} · carpetas: {', '.join(pj['tree'][:20]) or '-'} · archivos: {', '.join(pj['sample'][:25]) or '-'}" for pj in index)
    system = ("Sos el tech lead. Decidís a qué repositorio pertenece un ticket. Respondé SOLO un JSON: "
              '{"build_id": "<id o null>", "confidence": 0..1, "why": "<una frase>"}. Si no hay evidencia suficiente, build_id null.')
    user_msg = f"PROYECTOS:\n{projects}\n\nTICKET «{title}»:\n{text[:3500]}"
    result = CallResult()
    buf: list[str] = []
    try:
        async for kind, delta in stream(who[0], who[1], system, user_msg, temperature=0.1, max_tokens=300, result=result, cred=who[2]):
            if kind == "text":
                buf.append(delta)
        mobj = re.search(r"\{.*\}", "".join(buf), re.S)
        d = json.loads(mobj.group(0)) if mobj else {}
    except Exception as e:
        log.warning("classify llm failed: %s", e)
        return None
    bid = d.get("build_id")
    pj = next((x for x in index if x["build_id"] == bid), None)
    if not pj or float(d.get("confidence") or 0) < 0.7:
        return None
    return {"ok": True, "session_id": pj["session_id"], "build_id": pj["build_id"], "title": pj["title"], "confidence": round(float(d["confidence"]), 2), "evidence": f"modelo: {str(d.get('why') or '')[:200]}"}


async def _classify_run(user: User, page_ids: list[str] | None) -> None:
    """Background: read each open ticket and decide its project from the files/repo it names, then the model. Hand-made choices are kept."""
    from .auth import user_dir
    job = _CLASSIFY_JOBS[user.id]
    try:
        link = ticketsmod.get_link(user.id) or {}
        token = keystore.get_key(user.id, "notion") or ""
        index = ticketsmod.project_index(user_dir(user.id), _user_builds(user))
        if not index:
            job.update(status="error", error="No hay proyectos subidos: auditá o construí uno primero.")
            return
        items = ticketsmod.tickets(token, link["database_id"], link.get("props") or {})
        done_st = (link.get("status_map") or {}).get("done")
        items = [t for t in items if not ((done_st and t.get("status") == done_st) or (t.get("status") and _CLOSED_RX.search(t["status"])))]
        if page_ids:
            items = [t for t in items if t["id"] in page_ids]
        assigned = ticketsmod.assigned_projects(user.id)
        who = _classify_model(user)
        if who and PROVIDERS[who[0]].kind == "mock":
            who = None
        job.update(total=len(items), done=0, detected=0, undecided=0)
        for t in items:
            if job.get("cancel"):
                break
            cur = assigned.get(t["id"])
            if cur and cur.get("method") == "manual":
                job["done"] += 1
                continue
            try:
                page = await asyncio.to_thread(ticketsmod.page_markdown, token, t["id"])
                text = f"{t['title']}\n" + "\n".join(f"{k}: {v}" for k, v in (page.get("fields") or {}).items()) + "\n" + page["markdown"]
            except ticketsmod.NotionError as e:
                log.warning("classify: %s", e)
                job["done"] += 1
                continue
            r = ticketsmod.classify_ticket(text, index)
            if not r["ok"] and who and len(index) > 1:
                r = await _classify_llm(who, index, t["title"], text) or r
            if r.get("ok"):
                ticketsmod.save_assignment(user.id, t["id"], r["session_id"], r["build_id"], "llm" if str(r.get("evidence", "")).startswith("modelo:") else "auto", r.get("confidence"), r.get("evidence"))
                job["detected"] += 1
            else:
                ticketsmod.save_assignment(user.id, t["id"], None, None, "auto")  # clears an older automatic guess
                job["undecided"] += 1
            job["done"] += 1
            await asyncio.sleep(0.35)  # Notion allows ~3 requests/s
        job.update(status="done", finished=time.time())
    except Exception as e:
        log.exception("classify failed")
        job.update(status="error", error=str(e)[:300])


@app.post("/api/tickets/classify")
async def tickets_classify(body: dict | None = None, user: User = CurrentUser):
    """Detect, for every open ticket, which uploaded project it belongs to (files, folders and repo names it mentions; the model as a fallback)."""
    link = ticketsmod.get_link(user.id)
    if not link or not link.get("database_id"):
        raise HTTPException(400, "Vinculá la base de Notion primero.")
    _notion_token(user)
    cur = _CLASSIFY_JOBS.get(user.id)
    if cur and cur.get("status") == "running":
        return cur
    _CLASSIFY_JOBS[user.id] = {"status": "running", "total": 0, "done": 0, "detected": 0, "undecided": 0, "started": time.time(), "error": None}
    spawn(_classify_run(user, (body or {}).get("page_ids")))
    return _CLASSIFY_JOBS[user.id]


@app.get("/api/tickets/classify")
def tickets_classify_status(user: User = CurrentUser):
    return _CLASSIFY_JOBS.get(user.id) or {"status": "idle"}


@app.put("/api/tickets/{page_id}/project")
async def ticket_set_project(page_id: str, body: dict, user: User = CurrentUser):
    """Choose the project of one ticket by hand (null clears it: the Feature mapping applies again and the ticket is re-detected)."""
    sid, bid = body.get("session_id") or None, body.get("build_id") or None
    if sid and bid:
        _build_any(user, sid, bid)
        ticketsmod.save_assignment(user.id, page_id, sid, bid, "manual", 1.0, "elegido a mano")
    else:
        ticketsmod.save_assignment(user.id, page_id, None, None, "manual")
        cur = _CLASSIFY_JOBS.get(user.id)
        if not (cur and cur.get("status") == "running"):
            _CLASSIFY_JOBS[user.id] = {"status": "running", "total": 0, "done": 0, "detected": 0, "undecided": 0, "started": time.time(), "error": None, "quiet": True}
            spawn(_classify_run(user, [page_id]))
    return {"ok": True}


@app.get("/api/tickets/{page_id}")
def ticket_detail(page_id: str, user: User = CurrentUser):
    try:
        return ticketsmod.page_markdown(_notion_token(user), page_id)
    except ticketsmod.NotionError as e:
        raise HTTPException(400, str(e))


@app.post("/api/tickets/{page_id}/resolve")
async def ticket_resolve(page_id: str, user: User = CurrentUser):
    """The team takes the ticket: its page becomes the change request for the builder; the council verifies against it;
    on approval the branch is pushed and the PR opened (see ticket_on_verdict)."""
    link = ticketsmod.get_link(user.id)
    if not link or not link.get("database_id"):
        raise HTTPException(400, "Vinculá la base de Notion primero.")
    token = _notion_token(user)
    try:
        page = ticketsmod.page_markdown(token, page_id)
    except ticketsmod.NotionError as e:
        raise HTTPException(400, str(e))
    proj = ticketsmod.project_for_ticket(link, page.get("fields") or {}, ticketsmod.assigned_projects(user.id).get(page_id))
    if not proj["ok"]:
        if proj["reason"] == "sin_proyecto":
            raise HTTPException(400, "Vinculá un proyecto de Tably a los tickets primero.")
        if proj["reason"] == "ticket_sin_valor":
            raise HTTPException(400, f"El ticket no tiene «{proj['prop']}»: completalo en Notion para saber a qué proyecto va.")
        raise HTTPException(400, f"«{proj['prop']}: {proj['key']}» no tiene un proyecto de Tably asignado: asignalo en la configuración de Tickets.")
    b = _build(user, proj["build_id"], proj["session_id"])
    if b.status in ("running", "reviewing", "design_review"):
        raise HTTPException(409, "El equipo ya está trabajando en este proyecto; esperá a que termine.")
    busy = ticketsmod.run_for_build(user.id, b.id)
    if busy and busy["page_id"] != page_id and busy["status"] in ("building", "reviewing"):
        raise HTTPException(409, f"El equipo ya está con el ticket «{busy.get('title')}».")
    _check_capacity(user.id)
    root = _cloud_root(user, b)
    gh = keystore.get_key(user.id, "github")
    repo_url = proj.get("repo_url")
    if gh and not repo_url:
        res = gitserver.push_github(user.id, b.id, gh, b.title or b.id, private=True, root=root)
        if res.get("ok"):
            repo_url = res["url"]
            ticketsmod.set_repo_url(user.id, b.id, repo_url)
            b.emit("cloud.github", url=repo_url)
        else:
            log.warning("ticket: could not create the GitHub repo: %s", res.get("error"))
    base = gitserver._run(["rev-parse", "HEAD"], cwd=root).stdout.decode().strip() if (root / ".git").exists() else None
    fields = "\n".join(f"- {k}: {v}" for k, v in (page.get("fields") or {}).items())
    spec = f"TICKET DE NOTION «{page['title']}» ({page.get('url')})\n{fields}\n\n{page['markdown']}".strip()
    changes = [{"severity": "bloqueante", "role": "Ticket", "text": spec[:8000]}]
    b.council_priorities = f"Ticket «{page['title']}»: todo lo que pide el ticket tiene que estar resuelto y verificable (pantallas, endpoints, datos, casos borde). Ticket:\n{page['markdown'][:1800]}"
    b.review_plan = {"max_rounds": len(b.council_sessions) + 1}
    branch = f"tably/{ticketsmod._slug(page['title'])}-{page_id.replace('-', '')[:6]}"
    ticketsmod.save_run(user.id, page_id, title=page["title"], session_id=proj["session_id"], build_id=b.id, status="building", base_commit=base, branch=branch, pr_url=None, council_session=None, error=None, started=time.time())
    props, smap = link.get("props") or {}, link.get("status_map") or {}
    try:
        ticketsmod.set_status(token, page_id, props.get("status") or "", props.get("status_type"), smap.get("in_progress"))
        ticketsmod.comment(token, page_id, f"Tably Team tomó este ticket: el equipo lo está construyendo en «{b.title}» (rama {branch}). Cuando el consejo lo apruebe, abre el pull request y lo pasa a revisión.")
    except ticketsmod.NotionError as e:
        log.warning("notion status update failed: %s", e)
    b.apply_council(changes, "")
    return {"ok": True, "build_id": b.id, "session_id": proj["session_id"], "branch": branch, "repo_url": repo_url}


def ticket_on_verdict(b, session_id: str, approved: bool, changes: int) -> None:
    """Called by the builder when the council finished a round on a build that is resolving a ticket."""
    run = ticketsmod.run_for_build(b.user.id, b.id)
    if not run:
        return
    link = ticketsmod.get_link(b.user.id) or {}
    token = keystore.get_key(b.user.id, "notion")
    props, smap = link.get("props") or {}, link.get("status_map") or {}
    if not approved:
        ticketsmod.save_run(b.user.id, run["page_id"], status="changes", council_session=session_id)
        if token:
            try:
                ticketsmod.comment(token, run["page_id"], f"El consejo revisó el ticket y pidió {changes} cambio(s) antes de abrir el PR. El constructor los aplica en Tably.")
            except ticketsmod.NotionError:
                pass
        return
    gh = keystore.get_key(b.user.id, "github")
    pr_url, err = None, None
    proj = ticketsmod.project_by_build(link, b.id) or {}
    repo_url = proj.get("repo_url") or link.get("repo_url")
    if gh and repo_url:
        root = _cloud_root(b.user, b)
        body = (f"Resuelve el ticket de Notion **{run.get('title')}**" + (f" ({run.get('page_url')})" if run.get("page_url") else "") + "\n\n"
                f"Construido y revisado por el equipo de Tably Team (consejo: {len(b.council_sessions)} ronda(s), versión v{len(b.versions)}).\n\n"
                + "\n".join(f"- {s.get('text', '')[:200]}" for s in (b.stages or [])[-6:]))
        res = ticketsmod.open_pull_request(root, gh, repo_url, run["branch"] or "tably/ticket", f"{run.get('title')}", body)
        pr_url, err = res.get("url"), res.get("error")
    else:
        err = "Sin token de GitHub o repositorio vinculado: no se abrió el PR."
    ticketsmod.save_run(b.user.id, run["page_id"], status="pr" if pr_url else "approved", pr_url=pr_url, error=err, council_session=session_id)
    if token:
        try:
            ticketsmod.set_status(token, run["page_id"], props.get("status") or "", props.get("status_type"), smap.get("review"))
            if pr_url:
                ticketsmod.set_url(token, run["page_id"], props.get("pr"), pr_url)
            ticketsmod.comment(token, run["page_id"], (f"Aprobado por el consejo de Tably Team. Pull request listo para code review: {pr_url}" if pr_url else f"Aprobado por el consejo de Tably Team. {err}"))
        except ticketsmod.NotionError as e:
            log.warning("notion update failed: %s", e)
    b.emit("ticket.done", page_id=run["page_id"], pr_url=pr_url, error=err)


# ------------------------------------------------------------------------------------------------ growth levels · analytics · marketplace

@app.get("/a.js")
def analytics_snippet():
    """Tably Analytics: the script a built app loads (`<script defer src=".../a.js" data-site="<slug>">`). No cookies, no personal data."""
    return Response(levelsmod.SNIPPET_JS, media_type="application/javascript", headers={"Cache-Control": "public, max-age=300"})


_ONLINE_SNIPPET: dict[str, tuple[float, bool | None]] = {}


async def _online_has_snippet(url: str | None, published_at: float = 0) -> bool | None:
    """Whether the page live on the app's URL loads Tably Analytics (None when it could not be read). Cached a minute,
    and read again as soon as the app is republished."""
    if not url:
        return None
    hit = _ONLINE_SNIPPET.get(f"{url}@{published_at}")
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=True) as cx:
            r = await cx.get(url)
        base = re.escape(cloudmod.public_url())  # it has to report here, not to another Tably (e.g. a local one)
        val: bool | None = bool(re.search(rf"{base}/a\.js[^>]*data-site|data-site[^>]*{base}/a\.js", r.text[:400_000])) if r.status_code < 400 else None
    except Exception:  # noqa: BLE001
        val = None
    _ONLINE_SNIPPET[f"{url}@{published_at}"] = (time.time(), val)
    return val


@app.get("/api/analytics")
async def analytics_overview(user: User = CurrentUser):
    """Tably Analytics for every app the user published: visits, events and errors of each, whether the project has the
    snippet and whether the version online already carries it (if not, the page offers to publish again)."""
    folder = auth.user_dir(user.id)
    out = []
    for app_ in cloudmod.list_apps(user.id):
        title, session_id, installed, versions = app_["slug"], None, False, 0
        for p in folder.glob(f"*.build.{app_['build_id']}.json"):
            session_id = p.name.split(".build.")[0]
            try:  # the live level checks of the project (the saved snapshot can be old)
                b = _build_any(user, session_id, app_["build_id"])
                title, versions = b.title or title, len(b.versions)
                checks = {c["id"]: c["ok"] for lv in b.levels_eval().get("levels") or [] for c in lv["checks"]}
                installed = bool(checks.get("analytics"))
            except Exception:  # noqa: BLE001
                pass
            break
        st = levelsmod.stats(app_["slug"])
        online = await _online_has_snippet(app_.get("url"), app_.get("updated") or 0) if app_.get("status") == "live" else None
        installed = installed or st["pageviews"] > 0 or st["live"] > 0 or online is True
        out.append({"slug": app_["slug"], "title": title, "url": app_.get("url"), "status": app_.get("status"), "provider": app_.get("provider"),
                    "build_id": app_["build_id"], "session_id": session_id, "installed": installed,
                    # the project has the snippet but the page online does not load it (read from the live URL): publish again
                    "needs_republish": installed and online is False,
                    "stats": st, "visits_7d": levelsmod.hits_for(app_["slug"], time.time() - 7 * 86400)})
    return {"apps": out, "collector": cloudmod.public_url(), "collector_public": not re.match(r"https?://(localhost|127\.0\.0\.1)", cloudmod.public_url())}


@app.get("/api/analytics/{slug}")
def analytics_detail(slug: str, days: int = 30, user: User = CurrentUser):
    """One app's detailed analytics: visitors, sessions, countries, devices, sources, pages, what people tap, who they are."""
    app_ = next((a for a in cloudmod.list_apps(user.id) if a["slug"] == slug), None)
    if not app_:
        raise HTTPException(404)
    own = urlparse(app_.get("url") or "").hostname
    return analyticsmod.detail(slug, max(1, min(int(days), 365)), own)


def _my_app(user: User, slug: str) -> dict:
    app_ = next((a for a in cloudmod.list_apps(user.id) if a["slug"] == slug), None)
    if not app_:
        raise HTTPException(404)
    return app_


@app.get("/api/analytics/{slug}/errors")
def analytics_errors(slug: str, days: int = 30, user: User = CurrentUser):
    """The app's errors grouped by cause (like Sentry), each with its timeline, status and what Tably did about it."""
    app_ = _my_app(user, slug)
    rows = incidentsmod.list_for(user.id, app_["build_id"])
    return {"issues": observemod.issues(rows, max(1, min(int(days), 90))), "build_id": app_["build_id"]}


@app.get("/api/analytics/{slug}/ai")
def analytics_ai(slug: str, days: int = 30, user: User = CurrentUser):
    """The app's AI calls (like Langfuse): cost, tokens, latency and errors per day, model and feature."""
    _my_app(user, slug)
    return observemod.llm_summary(slug, max(1, min(int(days), 365)))


@app.get("/api/analytics/{slug}/experiments")
def analytics_experiments(slug: str, days: int = 30, goals: str = "", user: User = CurrentUser):
    """A/B experiments: each variant's visitors and conversions to the chosen goal event. `goals`: JSON {experiment: event}."""
    _my_app(user, slug)
    try:
        g = json.loads(goals) if goals else {}
    except ValueError:
        g = {}
    return observemod.experiments(slug, max(1, min(int(days), 365)), g if isinstance(g, dict) else {})


@app.post("/api/analytics/{slug}/ask")
def analytics_ask(slug: str, body: dict, user: User = CurrentUser):
    """One click from Analytics: the builder sets up an A/B test or the AI-call reporting in the app."""
    app_ = _my_app(user, slug)
    found = next(iter(auth.user_dir(user.id).glob(f"*.build.{app_['build_id']}.json")), None)
    if not found:
        raise HTTPException(404, "No encontré el proyecto de esta app")
    b = _build(user, app_["build_id"], found.name.split(".build.")[0])
    kind, what = str(body.get("kind") or ""), str(body.get("text") or "").strip()[:800]
    if kind == "ab":
        if not what:
            raise HTTPException(400, "Contá qué querés probar")
        text = (f"EXPERIMENTO A/B pedido por el usuario: {what}\n"
                "Armalo con Tably Analytics (el snippet /a.js ya está en la app): const v = window.tably && window.tably.variant ? window.tably.variant('nombre-corto-del-experimento', ['a', 'b']) : 'a'; "
                "mostrá la versión A (la actual) o la B según v, y marcá el objetivo con tably.track('nombre-del-objetivo') (o data-track) en la acción que mide si funcionó (registrarse, reservar, pagar…). "
                "La variante es estable por visitante. No cambies nada más. Al terminar emití <done> y decí el nombre del experimento y del objetivo.")
    elif kind == "ai":
        text = AI_REPORT_RULE + "\nAplicalo ahora a TODAS las llamadas a modelos de IA de la app. No cambies nada más. Al terminar emití <done>."
    else:
        raise HTTPException(400, "pedido inválido")
    if b.status in ("running", "reviewing", "design_review"):
        b.say(text)
    else:
        b.chat.append({"role": "user", "text": text, "ts": time.time()})
        b.resume(text)
    return {"ok": True, "build_id": b.id, "session_id": b.req.session_id}


@app.get("/api/settings/google-app")
def google_app_get(user: User = CurrentUser):
    """The install's Google OAuth client (for «Conectar Google Calendar»): set once by the admin, never sent to other browsers."""
    from .tickets import _setting

    cid, sec = connectionsmod.google_creds()
    return {"admin": _is_admin(user), "client_id": cid if _is_admin(user) else None, "has_secret": bool(sec), "configured": bool(cid and sec),
            "redirect_uri": connectionsmod.redirect_uri(cloudmod.public_url()), "origin": cloudmod.public_url().rstrip("/"),
            "from_env": bool(env("GOOGLE_OAUTH_CLIENT_ID")) and not _setting("google_client_id")}


@app.put("/api/settings/google-app")
def google_app_set(body: dict, user: User = CurrentUser):
    if not _is_admin(user):
        raise HTTPException(403, "Solo quien administra esta instalación puede cargar la conexión de Google.")
    if body.get("clear"):
        ticketsmod.set_setting("google_client_id", None)
        ticketsmod.set_setting("google_client_secret", None)
        return google_app_get(user)
    cid, sec = str(body.get("client_id") or "").strip(), str(body.get("client_secret") or "").strip()
    if cid:
        ticketsmod.set_setting("google_client_id", cid)
    if sec:
        ticketsmod.set_setting("google_client_secret", sec)
    return google_app_get(user)


@app.get("/api/connections")
def connections_list(user: User = CurrentUser):
    """The user's accounts connected to Tably (their apps read them through Tably) and whether this install can connect them."""
    return {"connections": connectionsmod.listing(user.id), "google_ready": connectionsmod.google_ready(),
            "redirect_uri": connectionsmod.redirect_uri(cloudmod.public_url())}


@app.post("/api/connections/{provider}/start")
def connections_start(provider: str, user: User = CurrentUser):
    if provider not in connectionsmod.PROVIDERS:
        raise HTTPException(404)
    if not connectionsmod.google_ready():
        raise HTTPException(400, "Falta configurar la conexión con Google en esta instalación de Tably (Configuración → Conexión de Google).")
    return {"url": connectionsmod.start(user.id, provider, cloudmod.public_url())}


@app.get("/api/connections/google/callback", include_in_schema=False)
async def connections_google_callback(code: str = "", state: str = "", error: str = ""):
    """Google sends the user back here after the consent screen; Tably keeps the tokens and returns to the app."""
    from urllib.parse import quote

    from fastapi.responses import RedirectResponse

    front = (env("TABLY_APP_URL") or env("TABLY_CLOUD_URL") or "http://localhost:5173").rstrip("/")
    if error or not code:
        return RedirectResponse(f"{front}/#connect_error={quote(error or 'cancelado')}", status_code=302)
    try:
        _uid, provider = await connectionsmod.finish(code, state, cloudmod.public_url())
    except ValueError as e:
        return RedirectResponse(f"{front}/#connect_error={quote(str(e)[:200])}", status_code=302)
    return RedirectResponse(f"{front}/#connected={provider}", status_code=302)


@app.delete("/api/connections/{provider}")
async def connections_delete(provider: str, user: User = CurrentUser):
    await connectionsmod.disconnect(user.id, provider)
    return {"ok": True, "connections": connectionsmod.listing(user.id)}


def _site_owner(site: str) -> str | None:
    """Whose data an app may read: the user who owns the published app (or the run being tried in Tably)."""
    if site.startswith("run-"):
        r = runmod.RUNS.get(site[4:])
        return r.user_id if r else None
    with auth._db() as c:
        row = c.execute("SELECT user_id FROM cloud_apps WHERE slug = ?", (site,)).fetchone()
    return row["user_id"] if row else None


@app.get("/api/connect/{site}/google-calendar/events")
async def connect_calendar_events(site: str, request: Request, start: str = Query("", alias="from"), end: str = Query("", alias="to"), limit: int = 250):
    """An app reads its owner's Google Calendar through Tably (Authorization: Bearer TABLY_TOKEN). Default: today and the next 7 days."""
    import datetime as _dt

    if not re.fullmatch(r"[a-z0-9-]{1,90}", site) or not observemod.check_token(site, request.headers.get("authorization")):
        raise HTTPException(401, "token inválido")
    owner = _site_owner(site)
    if not owner:
        raise HTTPException(404, "app desconocida")
    today = _dt.datetime.now(_dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    def iso(v: str, dflt: _dt.datetime) -> str:
        try:
            d = _dt.datetime.fromisoformat(v.replace("Z", "+00:00")) if v else dflt
        except ValueError:
            d = dflt
        return (d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)).isoformat()

    try:
        return await connectionsmod.calendar_events(owner, iso(start, today), iso(end, today + _dt.timedelta(days=7)), max(1, min(int(limit), 500)))
    except httpx.HTTPError:
        raise HTTPException(502, "Google Calendar no respondió; probá de nuevo en un rato")


@app.post("/api/llm/{site}")
async def llm_ingest(site: str, request: Request):
    """A published app reports one AI call (Authorization: Bearer TABLY_TOKEN)."""
    if not observemod.SLUG.fullmatch(site) or not observemod.check_token(site, request.headers.get("authorization")):
        raise HTTPException(401, "token inválido")
    try:
        body = json.loads((await request.body())[:20000] or b"{}")
    except ValueError:
        raise HTTPException(400, "JSON inválido")
    items = body if isinstance(body, list) else [body]
    kept = sum(1 for x in items[:50] if isinstance(x, dict) and observemod.record_llm(site, x))
    return {"ok": True, "kept": kept}


AI_REPORT_RULE = ("REPORTE DE LLAMADAS A IA A TABLY: después de cada llamada a un modelo (OpenAI, Anthropic, Gemini…), en el servidor y sin esperar la respuesta "
                  "(fire-and-forget, sin romper nada si falla), mandá un POST a `${process.env.TABLY_URL}/api/llm/${process.env.TABLY_SITE}` con el header "
                  "`Authorization: Bearer ${process.env.TABLY_TOKEN}` y el JSON {provider, model, name (la función de la app: «resumen», «chat», «clasificar»…), "
                  "input_tokens, output_tokens, latency_ms, status ('ok' | 'error'), error (si falló)}; los tokens salen del campo usage de la respuesta. "
                  "Hacelo en un helper único (por ejemplo `reportAI`) que se llama desde todas las llamadas. Si TABLY_URL no está definida, no hagas nada. "
                  "Nunca mandes claves; el texto del prompt y la respuesta solo recortados a 500 caracteres en input/output y nunca con datos personales.")


@app.post("/api/a/{site}")
async def analytics_hit(site: str, request: Request):
    """Beacon from a published app (text/plain so there is no preflight). Unauthenticated by design; one row per hit."""
    if not re.fullmatch(r"[a-z0-9-]{1,80}", site):
        return Response(status_code=204)
    try:
        body = json.loads((await request.body()).decode("utf-8", "replace") or "{}")
    except Exception:  # noqa: BLE001
        return Response(status_code=204)
    if isinstance(body, dict):
        levelsmod.record_hit(site, body, request.headers.get("user-agent"))
    return Response(status_code=204)


def _levels_payload(user: User, b) -> dict:
    app_ = cloudmod.get_app(user.id, b.id)
    ev = b.levels_eval()
    listing = levelsmod.listing_for(user.id, b.id)
    if listing and listing.get("level") != ev.get("level"):
        levelsmod.refresh_level(user.id, b.id, ev.get("level", 0))
        listing["level"] = ev.get("level", 0)
    return {"levels": ev, "analytics": levelsmod.stats((app_ or {}).get("slug")), "app": cloudmod.public(app_), "listing": listing, "snippet": f'<script defer src="{cloudmod.public_url()}/a.js" data-site="{(app_ or {}).get("slug") or "<slug>"}"></script>'}


@app.get("/api/sessions/{session_id}/builds/{build_id}/levels")
def build_levels(session_id: str, build_id: str, user: User = CurrentUser):
    """The project's growth level, the next level's checks with evidence, its analytics and its marketplace listing."""
    return _levels_payload(user, _build_any(user, session_id, build_id))


def _level_change(b, check: dict, level: int, site: str) -> dict:
    """A pending level check as a request for the builder; the analytics ones carry the exact snippet (any level)."""
    if check["id"] == "analytics":
        text = b.tx(f"Instalá Tably Analytics: en cada página HTML (o en el layout raíz que las envuelve) agregá exactamente <script defer src=\"{cloudmod.public_url()}/a.js\" data-site=\"{site}\"></script>. Si ya hay un snippet de /a.js apuntando a otra dirección (por ejemplo localhost), reemplazalo por este en TODOS los archivos, incluidos los scripts que generan páginas. Registra visitas, clics, gente en vivo y errores solo; no uses cookies ni otro analytics. Si la app tiene usuarios, donde ya sabe quién es (registro, inicio de sesión, sesión abierta) llamá window.tably && window.tably.identify({{ email, name, id }}).",
                    f"Install Tably Analytics: on every HTML page (or the root layout that wraps them) add exactly <script defer src=\"{cloudmod.public_url()}/a.js\" data-site=\"{site}\"></script>. If there is already an /a.js snippet pointing elsewhere (e.g. localhost), replace it with this one in EVERY file, including scripts that generate pages. It records visits, clicks, live visitors and errors by itself; use no cookies or other analytics. If the app has users, wherever it already knows who they are (sign up, log in, open session) call window.tably && window.tably.identify({{ email, name, id }}).")
    elif check["id"] == "events":
        text = b.tx("Marcá al menos 3 acciones clave del producto (registro, crear, pagar, etc.) con data-track=\"nombre\" en el botón o tably.track('nombre') en el código.",
                    "Mark at least 3 key product actions (sign up, create, pay, etc.) with data-track=\"name\" on the button or tably.track('name') in code.")
    else:
        text = b.tx(check.get("label") or "", check.get("label_en") or check.get("label") or "")
    word = b.tx("nivel", "level")
    return {"severity": "bloqueante", "role": f"{word.title()} {level}", "text": f"({word} {level}) {text}"}


@app.post("/api/sessions/{session_id}/builds/{build_id}/levels/build-pending")
async def build_levels_pending(session_id: str, build_id: str, body: dict | None = None, user: User = CurrentUser):
    """One click from anywhere (Levels, Analytics): the builder resolves pending level items. Body: {"ids": [...]} for specific
    checks (any level), {"focus": "analytics"} for the snippet + key events, nothing for everything the team owes the next level."""
    b = _build(user, build_id, session_id)
    if b.status in ("running", "reviewing", "design_review"):
        raise HTTPException(409, "El constructor ya está trabajando en este proyecto: cuando termine, probá de nuevo")
    ev = b.levels_eval()
    site = (cloudmod.get_app(user.id, b.id) or {}).get("slug") or "<slug-de-la-app>"
    body = body or {}
    ids = set(body.get("ids") or []) | ({"analytics", "events"} if body.get("focus") == "analytics" else set())
    if body.get("focus") == "identify":  # not a level check: who the signed-in users are, for the analytics «people» list
        b.apply_council([{"severity": "mejora", "role": "Tably Analytics", "text": b.tx(
            "Identificá a los usuarios en Tably Analytics: donde la app ya sabe quién es el usuario (al registrarse, al iniciar sesión y al cargar la app con la sesión abierta) llamá window.tably && window.tably.identify({ email, name, id }) con los datos que la app ya tiene; nunca contraseñas ni datos sensibles. Si la app no tiene usuarios, no hagas nada. Agregá a la política de privacidad (si existe) que se miden visitas y, para usuarios registrados, su email y nombre.",
            "Identify users in Tably Analytics: wherever the app already knows who the user is (sign up, log in and app load with an open session) call window.tably && window.tably.identify({ email, name, id }) with the data the app already has; never passwords or sensitive data. If the app has no users, do nothing. Add to the privacy policy (if there is one) that visits are measured and, for registered users, their email and name.")}], "")
        return {"ok": True, "items": 1}
    changes = []
    for lv in ev.get("levels") or []:
        for c in lv["checks"]:
            if c["ok"] or c.get("who") != "team" or c["id"] == "approved":
                continue
            if (ids and c["id"] in ids) or (not ids and lv["n"] == ev.get("next")):
                changes.append(_level_change(b, c, lv["n"], site))
    if not changes:
        if body.get("focus") == "analytics":
            raise HTTPException(400, "Las analíticas ya están instaladas en el proyecto: falta publicar de nuevo para que queden en línea")
        raise HTTPException(400, "Eso ya está resuelto en el proyecto" if ids else "No hay nada pendiente que construir para el próximo nivel")
    b.apply_council(changes, "")
    return {"ok": True, "items": len(changes)}


@app.put("/api/sessions/{session_id}/builds/{build_id}/market")
def market_list(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    """List the project on the marketplace (level 1 or more). Pitch and price are the owner's words."""
    b = _build_any(user, session_id, build_id)
    ev = b.levels_eval()
    if ev.get("level", 0) < 1:
        raise HTTPException(400, "Para publicar en el marketplace el proyecto tiene que estar en el nivel 1 (construido, aprobado y en línea).")
    app_ = cloudmod.get_app(user.id, b.id)
    price = body.get("price_usd")
    try:
        price = float(price) if price not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(400, "Precio inválido")
    row = levelsmod.upsert_listing(user.id, session_id, b.id, (app_ or {}).get("slug"), str(body.get("title") or b.title), str(body.get("pitch") or ""), price, ev["level"])
    return {"ok": True, "listing": row}


@app.delete("/api/sessions/{session_id}/builds/{build_id}/market")
def market_withdraw(session_id: str, build_id: str, user: User = CurrentUser):
    _build_any(user, session_id, build_id)
    levelsmod.withdraw_listing(user.id, build_id)
    return {"ok": True}


# ------------------------------------------------------------------------------------------------ ads (Remotion) and Meta Ads

def _ads_payload(user: User, b) -> dict:
    conn = metaads.connection(user.id)
    w = adsmod.writer(user.id)
    st = adsmod.recover_app(user.id, b)
    return {"ads": [adsmod.public(a) for a in adsmod.recover(user.id, b.id)], "source": adsmod.source_for(user, b), "engine": adsmod.engine_ready(),
            "writer": f"{provmod.PROVIDERS[w[0]].label} · {w[1]}" if w else None, "app": {**adsmod.public_app(st), "stale": bool(st.get("stale"))},
            "meta": {"ready": metaads.ready(), "connected": bool(conn), **(conn or {})}}


@app.get("/api/ads/templates")
def ads_templates(user: User = CurrentUser):
    """The ad templates (structures and styles) with their sample content, for the gallery's live previews."""
    return adsmod.catalog()


@app.post("/api/sessions/{session_id}/builds/{build_id}/ads/analyze")
async def build_ads_analyze(session_id: str, build_id: str, user: User = CurrentUser):
    """Understand the app again: capture its screens, summarise what it does, recommend the 5 templates that fit it."""
    b = _build_any(user, session_id, build_id)
    if not b.files:
        raise HTTPException(400, "Todavía no hay una app para analizar.")
    adsmod.prepare(user, b)
    return _ads_payload(user, b)


@app.put("/api/sessions/{session_id}/builds/{build_id}/ads/summary")
async def build_ads_summary(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    """The user's corrections to the summary of the app (the ads are written from it); the recommendations follow."""
    b = _build_any(user, session_id, build_id)
    await adsmod.edit_summary(user, b, body or {})
    return _ads_payload(user, b)


@app.get("/api/sessions/{session_id}/builds/{build_id}/ads")
def build_ads(session_id: str, build_id: str, user: User = CurrentUser):
    """The project's video ads (made, being made or failed), where their screens come from and the Meta Ads connection."""
    return _ads_payload(user, _build_any(user, session_id, build_id))


@app.post("/api/sessions/{session_id}/builds/{build_id}/ads")
async def build_ads_new(session_id: str, build_id: str, body: dict | None = None, user: User = CurrentUser):
    """A new ad: capture the screens, write the script, render vertical and square. Body: {"instructions": "..."} (optional)."""
    b = _build_any(user, session_id, build_id)
    if not adsmod.engine_ready():
        raise HTTPException(503, "Este servidor no tiene el motor de video instalado (backend/video).")
    if not b.files:
        raise HTTPException(400, "Todavía no hay una app para mostrar: el anuncio se hace cuando el equipo la construyó.")
    try:
        adsmod.start(user, b, str((body or {}).get("instructions") or "").strip(), (body or {}).get("template"), (body or {}).get("look"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _ads_payload(user, b)


@app.put("/api/sessions/{session_id}/builds/{build_id}/ads/{ad_id}")
async def build_ads_edit(session_id: str, build_id: str, ad_id: str, body: dict, user: User = CurrentUser):
    """The user's changes to the texts, colours or font: the ad is rendered again with them."""
    b = _build_any(user, session_id, build_id)
    try:
        adsmod.edit(user, b, ad_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _ads_payload(user, b)


@app.post("/api/sessions/{session_id}/builds/{build_id}/ads/{ad_id}/retry")
async def build_ads_retry(session_id: str, build_id: str, ad_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    ad = adsmod.get(user.id, b.id, ad_id)
    if not ad:
        raise HTTPException(404)
    try:
        if ad.get("script") and ad.get("screens") is not None:
            adsmod.edit(user, b, ad_id, {})
        else:
            adsmod.remove(user.id, b.id, ad_id)
            adsmod.start(user, b, ad.get("instructions") or "", ad.get("template"), ad.get("look"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _ads_payload(user, b)


@app.delete("/api/sessions/{session_id}/builds/{build_id}/ads/{ad_id}")
async def build_ads_delete(session_id: str, build_id: str, ad_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    adsmod.remove(user.id, b.id, ad_id)
    return _ads_payload(user, b)


@app.get("/api/sessions/{session_id}/builds/{build_id}/ads/{ad_id}/{name}")
def build_ads_file(session_id: str, build_id: str, ad_id: str, name: str, request: Request, token: str = "", download: int = 0):
    """A video or its cover. Auth by bearer or by `token` query, because the pane plays it in a <video>."""
    bearer = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    user = auth.user_from_token(token or bearer or None)
    if not user:
        raise HTTPException(401)
    b = _build_any(user, session_id, build_id)
    p = adsmod.file_for(user.id, b.id, ad_id, name)
    if not p:
        raise HTTPException(404)
    ad = adsmod.get(user.id, b.id, ad_id) or {}
    slug = re.sub(r"[^a-z0-9]+", "-", ((ad.get("script") or {}).get("name") or "anuncio").lower()).strip("-") or "anuncio"
    return FileResponse(p, media_type="video/mp4" if name.endswith(".mp4") else "image/jpeg", headers={"cache-control": "private, max-age=3600"},
                        filename=f"{slug}-{name}" if download else None, content_disposition_type="attachment" if download else "inline")


@app.post("/api/meta-ads/start")
def meta_ads_start(user: User = CurrentUser):
    if not metaads.ready():
        raise HTTPException(400, "La conexión con Meta Ads todavía no está habilitada en Tably.")
    return {"url": metaads.start(user.id, cloudmod.public_url())}


@app.get("/api/meta-ads/callback", include_in_schema=False)
async def meta_ads_callback(code: str = "", state: str = "", error: str = "", error_description: str = ""):
    """Meta sends the user back here (in the window Tably opened); the window tells Tably how it went and closes itself."""
    from fastapi.responses import HTMLResponse

    ok, msg = False, error_description or error or "Se canceló la conexión."
    if code:
        try:
            await metaads.finish(code, state, cloudmod.public_url())
            ok, msg = True, "Listo: tu cuenta de Meta Ads quedó conectada a Tably."
        except Exception as e:  # noqa: BLE001
            msg = str(e)[:300]
    payload = json.dumps({"tablyMetaAds": "ok" if ok else "error", "message": msg})
    page = (f"<!doctype html><meta charset=utf-8><title>Tably · Meta Ads</title><body style=\"font:16px system-ui;padding:40px;background:#10161F;color:#F1F4F8\">"
            f"<p>{html.escape(msg)}</p><p>Ya podés cerrar esta ventana.</p><script>try{{window.opener&&window.opener.postMessage({payload},'*')}}catch(e){{}}setTimeout(function(){{window.close()}},1200)</script>")
    return HTMLResponse(page)


@app.delete("/api/meta-ads")
async def meta_ads_disconnect(user: User = CurrentUser):
    await metaads.disconnect(user.id)
    return {"ok": True}


@app.get("/api/meta-ads/assets")
async def meta_ads_assets(user: User = CurrentUser):
    """The ad accounts and Facebook Pages of the connected account, to pick where the ad goes."""
    try:
        return await metaads.assets(user.id)
    except metaads.MetaError as e:
        raise HTTPException(400, str(e))


@app.post("/api/sessions/{session_id}/builds/{build_id}/ads/{ad_id}/meta")
async def build_ads_to_meta(session_id: str, build_id: str, ad_id: str, body: dict, user: User = CurrentUser):
    """Publish a ready ad to Meta Ads, PAUSED: body {account_id, page_id, currency, daily_budget, countries: [..], age_min, days, link}."""
    b = _build_any(user, session_id, build_id)
    ad = adsmod.get(user.id, b.id, ad_id)
    if not ad or ad.get("status") != "ready":
        raise HTTPException(400, "El anuncio todavía no está listo")
    if (ad.get("meta") or {}).get("status") == "publishing":
        raise HTTPException(409, "Ya se está publicando")
    try:
        budget = float(body.get("daily_budget") or 0)
    except (TypeError, ValueError):
        budget = 0
    countries = [str(c).upper() for c in (body.get("countries") or []) if re.fullmatch(r"[A-Za-z]{2}", str(c))]
    if budget <= 0 or not countries or not body.get("account_id") or not body.get("page_id"):
        raise HTTPException(400, "Elegí la cuenta publicitaria, la página, el presupuesto diario y al menos un país")
    opts = {**body, "daily_budget": budget, "countries": countries[:25]}
    base = adsmod.folder(user.id, b.id) / ad_id

    def step(text: str) -> None:
        adsmod._update(user.id, b.id, ad_id, meta={"status": "publishing", "step": text})

    async def job():
        try:
            step("Conectando con Meta")
            res = await metaads.publish(user.id, ad, base, opts, step)
            adsmod._update(user.id, b.id, ad_id, meta={"status": "done", **res, "published": time.time(), "daily_budget": budget, "currency": body.get("currency"), "countries": countries})
        except Exception as e:  # noqa: BLE001
            log.exception("meta ads publish %s", ad_id)
            adsmod._update(user.id, b.id, ad_id, meta={"status": "error", "error": str(e)[:500]})

    step("Conectando con Meta")
    spawn(job())
    return _ads_payload(user, b)


# ------------------------------------------------------------------------------------------------ Ad Studio (own videos and images)

def _studio(user: User, pid: str) -> dict:
    try:
        p = studiomod.recover(user.id, pid)
    except ValueError:
        p = None
    if not p:
        raise HTTPException(404, "Anuncio no encontrado")
    return p


@app.get("/api/studio")
def studio_list(user: User = CurrentUser):
    """The user's studio ads, newest first, and whether this server can make them."""
    return {"projects": studiomod.listing(user.id), "ready": adsmod.engine_ready() and studiomod.media.available(), "agents": studiomod.AGENTS,
            "transcriber": studiomod.stt.who(user.id), "model": bool(studiomod._who(user.id, False)), "limits": {"files": studiomod.MAX_FILES, "video_mb": studiomod.MAX_VIDEO_MB, "image_mb": studiomod.MAX_IMAGE_MB, "minutes": studiomod.MAX_MINUTES}}


@app.post("/api/studio")
def studio_create(body: dict, user: User = CurrentUser):
    lang = "English" if str(body.get("lang") or "") == "en" else "español rioplatense"
    p = studiomod.create(user, str(body.get("title") or ""), str(body.get("instructions") or ""), str(body.get("link") or ""), str(body.get("goal") or "sell"), lang)
    return studiomod.public(p)


@app.get("/api/studio/{pid}")
def studio_get(pid: str, user: User = CurrentUser):
    return studiomod.public(_studio(user, pid))


@app.patch("/api/studio/{pid}")
def studio_patch(pid: str, body: dict, user: User = CurrentUser):
    _studio(user, pid)
    fields = {k: str(body[k])[:n] for k, n in (("title", 80), ("instructions", 2000), ("link", 300)) if k in body}
    if body.get("goal") in ("sell", "awareness", "signup"):
        fields["goal"] = body["goal"]
    return studiomod.public(studiomod.update(user.id, pid, **fields))


@app.delete("/api/studio/{pid}")
def studio_delete(pid: str, user: User = CurrentUser):
    _studio(user, pid)
    studiomod.remove(user.id, pid)
    return {"ok": True}


@app.post("/api/studio/{pid}/media")
async def studio_upload(pid: str, file: UploadFile, user: User = CurrentUser):
    """A video or an image for the ad, streamed to disk."""
    _studio(user, pid)

    async def chunks():
        while data := await file.read(1 << 20):
            yield data

    try:
        await studiomod.add_media(user, pid, file.filename or "archivo", chunks())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return studiomod.public(_studio(user, pid))


@app.delete("/api/studio/{pid}/media/{mid}")
def studio_media_delete(pid: str, mid: str, user: User = CurrentUser):
    _studio(user, pid)
    try:
        return studiomod.public(studiomod.remove_media(user.id, pid, mid))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/studio/{pid}/run")
async def studio_run(pid: str, user: User = CurrentUser):
    """The five agents get to work: listen, plan, cut, improve and approve (until it is approved), then the final export."""
    _studio(user, pid)
    try:
        studiomod.run(user, pid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return studiomod.public(_studio(user, pid))


@app.post("/api/studio/{pid}/stop")
async def studio_stop(pid: str, user: User = CurrentUser):
    _studio(user, pid)
    studiomod.stop(user.id, pid)
    return studiomod.public(_studio(user, pid))


@app.get("/api/studio/{pid}/file/{name:path}")
def studio_file(pid: str, name: str, request: Request, token: str = "", download: int = 0):
    """A thumbnail, a cut or the final ad. Auth by bearer or by `token` query (it plays in a <video>)."""
    bearer = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    user = auth.user_from_token(token or bearer or None)
    if not user:
        raise HTTPException(401)
    p = _studio(user, pid)
    f = studiomod.file_for(user.id, pid, name)
    if not f:
        raise HTTPException(404)
    slug = re.sub(r"[^a-z0-9]+", "-", (p.get("title") or "anuncio").lower()).strip("-") or "anuncio"
    return FileResponse(f, media_type="video/mp4" if f.suffix == ".mp4" else "image/jpeg", headers={"cache-control": "private, max-age=600"},
                        filename=f"{slug}-{f.name}" if download else None, content_disposition_type="attachment" if download else "inline")


# ------------------------------------------------------------------------------------------------ AdTier (ads ranked S/A/B/C with templates)

def _adtier_admin(user: User) -> None:
    if not _is_admin(user):
        raise HTTPException(403, "Solo quien administra Tably carga y revisa el catálogo de AdTier")


def _adtier_filters(request: Request) -> dict:
    q = request.query_params
    return {k: q.get(k) for k in ("tier", "format", "industry", "language", "country", "platform_origin", "brand", "region", "min_s", "max_s", "embed_provider") if q.get(k)}


@app.get("/api/adtier")
def adtier_home(request: Request, user: User = CurrentUser):
    """The tier list (S, A, B, C rows) with the filters, the facets to filter by and, for the admin, the review numbers."""
    admin = _is_admin(user)
    out = {"tiers": adtiermod.tier_list(_adtier_filters(request)), "facets": adtiermod.facets(), "admin": admin, "formats": adtiermod.FORMATS,
           "takedown_email": env("ADTIER_TAKEDOWN_EMAIL") or None, "public_url": cloudmod.public_url()}
    if admin:
        out["agreement"] = adtiermod.agreement()
    return out


@app.get("/api/adtier/videos")
def adtier_videos(request: Request, q: str = "", page: int = 1, status: str = "published", user: User = CurrentUser):
    if status != "published":
        _adtier_admin(user)
    return adtiermod.search(_adtier_filters(request), q, status, max(1, page))


@app.get("/api/adtier/videos/{vid}")
def adtier_video(vid: str, user: User = CurrentUser):
    v = adtiermod.get(vid)
    admin = _is_admin(user)
    if not v or (v["status"] != "published" and not admin):
        raise HTTPException(404, "Video no encontrado")
    return adtiermod.detail(v, admin)


@app.get("/api/adtier/videos/{vid}/template.{ext}")
def adtier_template_export(vid: str, ext: str, token: str = ""):
    """The template as Markdown or JSON (download). Published videos only."""
    v = adtiermod.get(vid)
    tpl = adtiermod.template_of(v["id"], True) if v and v["status"] == "published" else None
    if not tpl or ext not in ("md", "json"):
        raise HTTPException(404)
    name = f"{v['slug']}-plantilla.{ext}"
    if ext == "md":
        return Response(adtiermod.template_markdown(v, tpl["body"]), media_type="text/markdown; charset=utf-8", headers={"content-disposition": f'attachment; filename="{name}"'})
    return Response(json.dumps(tpl["body"], ensure_ascii=False, indent=2), media_type="application/json", headers={"content-disposition": f'attachment; filename="{name}"'})


@app.get("/api/adtier/brands")
def adtier_brands(user: User = CurrentUser):
    return {"brands": adtiermod.brands()}


@app.get("/api/adtier/masters")
def adtier_masters(user: User = CurrentUser):
    return {"masters": adtiermod.masters_list(), "status": adtiermod.master_status(), "min": adtiermod.MASTER_MIN}


# public read API and MCP (published videos only; no transcript)
@app.get("/api/public/adtier/videos")
def adtier_public_videos(request: Request, q: str = "", page: int = 1):
    return adtiermod.search(_adtier_filters(request), q, "published", max(1, page))


@app.get("/api/public/adtier/videos/{vid}")
def adtier_public_video(vid: str):
    v = adtiermod.get(vid)
    if not v or v["status"] != "published":
        raise HTTPException(404)
    d = adtiermod.detail(v)
    d.pop("similar", None)
    return d


@app.get("/api/public/adtier/templates/{vid}")
def adtier_public_template(vid: str):
    v = adtiermod.get(vid)
    tpl = adtiermod.template_of(v["id"], True) if v and v["status"] == "published" else None
    if not tpl:
        raise HTTPException(404)
    return {"video": {k: v.get(k) for k in ("slug", "title", "brand", "year", "source_url")}, "tier": (adtiermod.tier_of(v["id"]) or {}).get("tier"), "template": tpl["body"]}


@app.post("/mcp/adtier")
async def adtier_mcp(request: Request):
    """AdTier as an MCP server (JSON-RPC over HTTP): search_videos, get_template, list_tiers."""
    body = await request.json()
    if isinstance(body, list):
        out = [r for r in (adtiermod.mcp(x) for x in body) if r]
        return out if out else Response(status_code=202)
    res = adtiermod.mcp(body)
    return res if res else Response(status_code=202)


# admin: load, ingest, review
@app.post("/api/adtier/admin/videos")
def adtier_add(body: dict, user: User = CurrentUser):
    """One video by URL with its evidence; the ingest starts right away."""
    _adtier_admin(user)
    try:
        v = adtiermod.add(user, str(body.get("url") or ""), body.get("evidence") or [], body.get("meta") or {})
    except ValueError as e:
        raise HTTPException(400, str(e))
    adtiermod.start_ingest(user, [v["id"]])
    return adtiermod.detail(adtiermod.get(v["id"]) or v, True)


@app.post("/api/adtier/admin/batch")
def adtier_batch(body: dict, user: User = CurrentUser):
    """A CSV lot: url, brand, agency, year, country, language, industry, format, evidence_type, evidence_detail, evidence_url, days_active, variations_count."""
    _adtier_admin(user)
    res = adtiermod.batch(user, str(body.get("csv") or ""))
    adtiermod.start_ingest(user, res["added"])
    return res


@app.get("/api/adtier/admin/queue")
def adtier_queue(user: User = CurrentUser):
    _adtier_admin(user)
    return {"drafts": adtiermod.search({}, "", "draft", 1, 200)["videos"], "review": adtiermod.search({}, "", "review", 1, 200)["videos"],
            "running": list(adtiermod._jobs), "agreement": adtiermod.agreement(), "columns": adtiermod.CSV_COLUMNS}


@app.patch("/api/adtier/admin/videos/{vid}")
def adtier_edit(vid: str, body: dict, user: User = CurrentUser):
    _adtier_admin(user)
    if not adtiermod.get(vid):
        raise HTTPException(404)
    adtiermod.update_meta(vid, body)
    if isinstance(body.get("evidence"), list):
        adtiermod.set_evidence(vid, body["evidence"])
    return adtiermod.detail(adtiermod.get(vid) or {}, True)


@app.post("/api/adtier/admin/videos/{vid}/ingest")
def adtier_reingest(vid: str, user: User = CurrentUser):
    """Run the analysis again (after new evidence, a corrected format or a failure)."""
    _adtier_admin(user)
    if not adtiermod.get(vid):
        raise HTTPException(404)
    adtiermod.start_ingest(user, [vid])
    return adtiermod.detail(adtiermod.get(vid) or {}, True)


@app.post("/api/adtier/admin/videos/{vid}/review")
def adtier_review(vid: str, body: dict, user: User = CurrentUser):
    """The person's decision on the tier and the template; publishing happens only here."""
    _adtier_admin(user)
    try:
        v = adtiermod.review(user, vid, str(body.get("tier") or ""), body.get("template") if isinstance(body.get("template"), dict) else None, bool(body.get("publish")), str(body.get("note") or "")[:400])
    except ValueError as e:
        raise HTTPException(400, str(e))
    return adtiermod.detail(v, True)


@app.delete("/api/adtier/admin/videos/{vid}")
def adtier_delete(vid: str, user: User = CurrentUser):
    _adtier_admin(user)
    adtiermod.remove(vid)
    return {"ok": True}


@app.post("/api/adtier/admin/masters")
async def adtier_make_master(body: dict, user: User = CurrentUser):
    _adtier_admin(user)
    try:
        await adtiermod.make_master(user, str(body.get("format") or ""), str(body.get("tier") or ""))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    return {"masters": adtiermod.masters_list(), "status": adtiermod.master_status(), "min": adtiermod.MASTER_MIN}


@app.post("/api/adtier/admin/check-embeds")
async def adtier_check(user: User = CurrentUser):
    _adtier_admin(user)
    return await adtiermod.validate_embeds()


@app.get("/api/market")
def market(user: User = CurrentUser):
    """Every project for sale: level, public URL, real visits, pitch and price. Buyers contact the owner; the owner transfers."""
    out = []
    for r in levelsmod.list_market():
        app_ = cloudmod.get_app(r["user_id"], r["build_id"])
        with auth._db() as c:
            o = c.execute("SELECT name, email FROM users WHERE id = ?", (r["user_id"],)).fetchone()
        item = levelsmod.public_listing(r, (o["name"] if o else None))
        item["url"] = (app_ or {}).get("url") if (app_ or {}).get("status") == "live" else None
        item["mine"] = r["user_id"] == user.id
        item["owner_email"] = o["email"] if o and r["user_id"] != user.id else None
        item["session_id"] = r["session_id"] if r["user_id"] == user.id else None
        item["build_id"] = r["build_id"] if r["user_id"] == user.id else None
        out.append(item)
    return {"listings": out, "levels": levelsmod.LEVELS}


@app.post("/api/market/{listing_id}/transfer")
def market_transfer(listing_id: str, body: dict, user: User = CurrentUser):
    """Ownership transfer to another Tably account (by email): the project, its versions, its workdir and its public app move; the URL stays."""
    with auth._db() as c:
        r = c.execute("SELECT * FROM market_listings WHERE id = ?", (listing_id,)).fetchone()
    if not r or r["user_id"] != user.id:
        raise HTTPException(404, "Publicación no encontrada")
    if r["status"] != "active":
        raise HTTPException(409, "Esta publicación ya no está activa")
    target = levelsmod.user_by_email(str(body.get("email") or ""))
    if not target:
        raise HTTPException(404, "No hay una cuenta de Tably con ese email: la otra persona tiene que crearla primero.")
    if target["id"] == user.id:
        raise HTTPException(400, "Ya es tuyo")
    listing = dict(r)
    b = BUILDS.get(listing["build_id"])
    if b and b.user.id == user.id and b.status in ("running", "reviewing"):
        raise HTTPException(409, "Esperá a que el constructor termine antes de transferir")
    BUILDS.pop(listing["build_id"], None)
    from .orchestrator import SESSIONS

    for sid in list(SESSIONS):
        if sid == listing["session_id"] or (getattr(SESSIONS[sid], "config", None) and (SESSIONS[sid].config.review_of or {}).get("build_id") == listing["build_id"]):
            SESSIONS.pop(sid, None)
    from .local_engine import BUILD_ROOT

    res = levelsmod.transfer(listing, target["id"], BUILD_ROOT)
    return {**res, "to": {"name": target["name"], "email": target["email"]}}


@app.get("/api/cloud/status")
def cloud_status(user: User = CurrentUser):
    return {**cloudmod.status(user.id), "github": keystore.key_status(user.id, "github"), "apps": [cloudmod.public(a) for a in cloudmod.list_apps(user.id)]}


@app.put("/api/settings/github")
def settings_github(body: dict, user: User = CurrentUser):
    keystore.save(user.id, "github", api_key=body.get("token"), clear_key=bool(body.get("clear")))
    return keystore.key_status(user.id, "github")


def _cloud_root(user: User, b) -> Path:
    """The project folder to build/publish/commit: the engine's workdir when it really holds the project; otherwise
    (API builds, or a workdir that is empty because the build was restored elsewhere) a folder written from the saved files."""
    def has_project(d: Path) -> bool:
        for p in d.iterdir():
            if p.name in (".git", ".gitignore"):
                continue
            if p.is_dir() or p.stat().st_size > 0:
                return True
        return False

    wd = b.workdir if b.workdir and b.workdir.exists() and has_project(b.workdir) else None
    return deploymod.materialize(user.id, b.id, b.files, wd)


@app.get("/api/sessions/{session_id}/builds/{build_id}/cloud")
def build_cloud(session_id: str, build_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    return {
        "app": cloudmod.public(cloudmod.get_app(user.id, build_id)),
        "git": gitserver.info(user.id, build_id, cloudmod.public_url()),
        "migration": cloudmod.migration_kit(user.id, build_id),
        "status": cloudmod.status(user.id),
        "github": keystore.key_status(user.id, "github"),
        "publishing": bool(getattr(b, "publishing", False)),
        "version": len(b.versions),
    }


@app.post("/api/sessions/{session_id}/builds/{build_id}/cloud/publish")
async def build_cloud_publish(session_id: str, build_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    if getattr(b, "publishing", False):
        raise HTTPException(409, "Ya hay una publicación en curso")
    if b.status in ("running", "reviewing"):
        raise HTTPException(409, "Esperá a que el constructor termine")
    _check_capacity(user.id)
    _start_publish(user, b)
    return {"ok": True}


def _start_publish(user: User, b) -> None:
    """Publish the build's current files on Tably Cloud in the background (the panel follows the cloud.* events)."""
    build_id = b.id
    root = _cloud_root(user, b)
    b.publishing = True
    b.emit("cloud.started", build=build_id)

    async def run():
        def logf(line: str):
            b.emit("cloud.log", line=line[-500:])

        try:
            app_ = await cloudmod.publish(user.id, build_id, b.title, root, b.files, len(b.versions), logf)
            gitserver.sync(user.id, build_id, root, f"publicación v{len(b.versions)}")
        except Exception as e:  # noqa: BLE001
            log.exception("cloud publish")
            app_ = {"status": "error", "error": str(e)[:300], "url": None, "slug": None, "provider": None}
        b.publishing = False
        b.emit("cloud.status", app=cloudmod.public(app_) if app_.get("slug") else app_)

    spawn(run())


def auto_publish(b) -> bool:
    """An app that is already online gets the new work by itself: when the builder finishes or the council approves and the
    approval holds (see levels «approved»), the current version is published again on the same app. Returns whether it started."""
    app_ = cloudmod.get_app(b.user.id, b.id)
    if not app_ or not (app_.get("status") in ("live", "deploying") or (app_.get("status") == "error" and app_.get("url"))):
        return False  # never published (the first publish is the user's decision)
    if _busy(b):
        return False  # a deploy or error fix publishes by itself when the builder is done (see on_deploy_failed, on_app_errors)
    checks = {c["id"]: c["ok"] for lv in b.levels_eval().get("levels") or [] for c in lv["checks"]}
    if not checks.get("approved"):
        return False  # new work the council has not approved stays unpublished until it is
    b.chat.append({"role": "system", "text": b.tx(f"Publicando automáticamente la versión aprobada en {app_.get('url')}…", f"Publishing the approved version automatically at {app_.get('url')}…"), "ts": time.time()})
    _start_publish(b.user, b)
    return True


DEPLOY_FIX_ATTEMPTS = 3


def _owner_build(user_id: str, build_id: str):
    """(user, build) for work that starts without a request (watchers, monitors); (None, None) when it no longer exists."""
    with auth._db() as c:
        row = c.execute("SELECT id, email, name FROM users WHERE id = ?", (user_id,)).fetchone()
    found = next(iter(auth.user_dir(user_id).glob(f"*.build.{build_id}.json")), None)
    if not row or not found:
        return None, None
    user = User(**dict(row))
    try:
        return user, _build(user, build_id, found.name.split(".build.")[0])
    except HTTPException:
        return None, None


def _busy(b) -> bool:
    return b.status in ("running", "reviewing", "design_review") or getattr(b, "publishing", False) or getattr(b, "_deploy_fix", False) or getattr(b, "_error_fix", False)


def on_deploy_failed(user_id: str, build_id: str, reason: str, logs: str) -> bool:
    """Railway could not build or start the app: the builder gets the logs, fixes the project and it is published again,
    without the user having to step in (up to DEPLOY_FIX_ATTEMPTS times). Returns whether the fix started."""
    app_ = cloudmod.get_app(user_id, build_id) or {}
    rmeta = (app_.get("db") or {}).get("railway") or {}
    attempt = int(rmeta.get("fix_attempts") or 0) + 1
    if attempt > DEPLOY_FIX_ATTEMPTS:
        return False
    user, b = _owner_build(user_id, build_id)
    if not b or _busy(b):
        return False
    app_.setdefault("db", {}).setdefault("railway", {})["fix_attempts"] = attempt
    cloudmod._save(app_)
    b._deploy_fix = True
    b.resume(
        f"EL DESPLIEGUE EN RAILWAY FALLÓ ({reason}; intento {attempt} de {DEPLOY_FIX_ATTEMPTS}). Corregí el proyecto para que la imagen Docker se construya y la app arranque en Railway, "
        "sin cambiar lo que hace la app. Railway construye con el Dockerfile de la RAÍZ del repo; si no hay uno propio usa el que genera Tably (empieza con «# generated by Tably»): "
        "si el problema está en cómo se instala o se construye (gestor de paquetes, workspaces, versión de Node, carpeta del servicio), escribí un Dockerfile propio en la raíz que funcione, sin esa primera línea. "
        "La app tiene que escuchar en 0.0.0.0 y en el puerto de la variable PORT (8080), servir la web en «/» y leer sus secretos de variables de entorno. "
        "Si hace falta una variable nueva, agregala a .env.example. Al terminar emití <done>.\n\n" + (logs or "(Railway no devolvió logs)"))
    b._pending_requests, b._pending_trigger = [{"severity": "bloqueante", "role": "Tably Cloud", "text": f"El despliegue falló: {reason}"}], "deploy"

    async def republish() -> None:
        try:
            while b.status in ("running", "reviewing", "design_review"):
                await asyncio.sleep(10)
        finally:
            b._deploy_fix = False
        v = b.versions[-1] if b.versions else {}
        if v.get("trigger") == "deploy":  # what the builder changed: confirmed as the fix when the app goes live
            st = v.get("stats") or {}
            lessonsmod.note_fix(user_id, build_id, v.get("summary") or "", [*st.get("added", []), *st.get("modified", [])])
        if b.status != "error" and not getattr(b, "publishing", False):
            _start_publish(user, b)
            return
        cur = cloudmod.get_app(user_id, build_id) or {}
        if cur.get("status") == "deploying":
            cur.update(status="error", error="No pudimos dejar la app en línea: el constructor no terminó la corrección del despliegue. Tocá «Publicar» de nuevo.")
            cloudmod._save(cur)
            b.emit("cloud.status", app=cloudmod.public(cur))

    spawn(republish())
    return True


cloudmod.ON_DEPLOY_FAILED = on_deploy_failed


LEAK_FIX_ATTEMPTS = 2


def on_leaks(user_id: str, build_id: str, keys: list[dict], logs: str) -> bool:
    """Keys written in the app's code (found before publishing): each value is saved as one of the app's secrets, the builder
    reads them from environment variables instead, and the app is published again by itself. A key that still works also
    gets a card to change it (it was in the code). Returns whether the fix started."""
    user, b = _owner_build(user_id, build_id)
    if not b:
        return False
    app_ = cloudmod.get_app(user_id, build_id) or {}
    meta = (app_.get("db") or {}).get("leaks") or {}
    services = ", ".join(sorted({k["service"] for k in keys}))
    lessonsmod.record(user_id, build_id, app_.get("provider") or "", f"{leaksmod.MARK}: {services}", logs)
    for k in keys if not meta.get("attempts") else []:  # once per round of fixes, not on every retry
        if k["live"]:
            _note(b, b.tx(f"Tu clave de {k['service']} estaba escrita en el código de la app y todavía funciona. La sacamos del código, pero conviene cambiarla por una nueva: alguien pudo haberla visto.",
                          f"Your {k['service']} key was written in the app's code and still works. We took it out of the code, but it is safer to replace it with a new one: someone may have seen it."),
                  tone="attention", link={"label": b.tx(f"Cambiar la clave de {k['service']}", f"Change the {k['service']} key"), "url": k["url"]} if k["url"] else None)
    attempt = int(meta.get("attempts") or 0) + 1
    busy = b.status in ("running", "reviewing", "design_review") or getattr(b, "_deploy_fix", False) or getattr(b, "_error_fix", False)  # called from inside the publish itself
    if attempt > LEAK_FIX_ATTEMPTS or busy:
        _note(b, b.tx(f"No publicamos la app porque tiene claves escritas en el código ({services}) y no pudimos sacarlas solos. Pedile al constructor que las pase a variables de entorno, o tocá «Publicar» para intentarlo de nuevo.",
                      f"We didn't publish the app because it has keys written in its code ({services}) and we couldn't remove them on our own. Ask the builder to move them to environment variables, or press «Publish» to try again."),
              tone="attention", go="cloud")
        if attempt > LEAK_FIX_ATTEMPTS:
            meta["attempts"] = 0  # a «Publicar» by hand starts over
            app_.setdefault("db", {})["leaks"] = meta
            cloudmod._save(app_)
        return False
    meta["attempts"] = attempt
    app_.setdefault("db", {})["leaks"] = meta
    cloudmod._save(app_)
    deploymod.save_secrets(user_id, build_id, {k["env"]: k["secret"] for k in keys if not k["own"]})  # the app keeps working with the same value
    _note(b, b.tx(f"Antes de publicar encontramos claves escritas en el código de la app ({services}). Las estamos pasando a un lugar seguro para que nadie pueda verlas; después se publica sola.",
                  f"Before publishing we found keys written in the app's code ({services}). We are moving them somewhere safe so nobody can see them; then it publishes by itself."),
          tone="working", detail=", ".join(f"{k['env']} ← {k['files'][0]}" for k in keys))
    b._deploy_fix = True
    b.resume(
        "HAY CLAVES ESCRITAS EN EL CÓDIGO y no se puede publicar así (cualquiera que vea el código o el navegador las ve). Sacalas del código y leelas de variables "
        "de entorno, sin cambiar lo que hace la app. Tably ya guardó cada valor como secreto de la app con el nombre indicado, así que en producción la variable existe:\n"
        + leaksmod.report(keys) + "\n\nPara cada una: reemplazá el valor por la lectura de la variable (process.env.X / os.environ[\"X\"]; en el frontend, solo si es "
        "una clave pública, con el prefijo que use el bundler, p. ej. VITE_X, y si es secreta movela al servidor), agregala a .env.example con un valor de ejemplo, "
        "y si estaba en un archivo de configuración o de datos de ejemplo, dejá un placeholder. No escribas los valores en ningún otro archivo. Al terminar emití <done>.")
    b._pending_requests, b._pending_trigger = [{"severity": "bloqueante", "role": "Tably Cloud", "text": f"Claves en el código: {services}"}], "deploy"

    async def republish() -> None:
        try:
            while b.status in ("running", "reviewing", "design_review"):
                await asyncio.sleep(10)
        finally:
            b._deploy_fix = False
        if b.status != "error" and not getattr(b, "publishing", False):
            _start_publish(user, b)
            return
        cur = cloudmod.get_app(user_id, build_id) or {}
        if cur.get("status") == "deploying":
            cur.update(status="error", error="No publicamos la app: tiene claves escritas en el código y el constructor no terminó de sacarlas. Tocá «Publicar» de nuevo.")
            cloudmod._save(cur)
            b.emit("cloud.status", app=cloudmod.public(cur))

    spawn(republish())
    return True


cloudmod.ON_LEAKS = on_leaks


def on_app_live(user_id: str, build_id: str) -> None:
    """The app is online: what only its address could tell (APP_URL, API_URL…) is filled and it is published once more to use it."""
    user, b = _owner_build(user_id, build_id)
    app_ = cloudmod.get_app(user_id, build_id) or {}
    if not b or not app_.get("url"):
        return
    examples = [t for rel, t in b.files.items() if rel.rsplit("/", 1)[-1] == ".env.example" and rel.count("/") <= 2]
    urls = cloudmod.url_values(examples, deploymod.load_secrets(user_id, build_id), app_["url"])
    if not urls:
        return
    deploymod.save_secrets(user_id, build_id, urls)
    if not _busy(b):
        _note(b, b.tx(f"Completé la dirección de tu app ({', '.join(urls)}) y la vuelvo a publicar para que la use.",
                      f"I filled in your app's address ({', '.join(urls)}) and I'm publishing it again so it uses it."), tone="working")
        _start_publish(user, b)


cloudmod.ON_LIVE = on_app_live


# ------------------------------------------------------------------------------------------------ errors of the published app

ERROR_FIX_PER_DAY = 4  # automatic fix passes per app per day (each one is a builder run)
ERROR_FIX_ATTEMPTS = 2  # the same error fixed this many times and still happening → the user decides
BIG_FIX_FILES, BIG_FIX_LINES = 10, 500  # a «small» fix that changes more than this waits for the user anyway


def _project_write(b, rel: str, text: str | None) -> None:
    """A file of the project, on disk (engine builds) and in the build's files (what versions and publishing use)."""
    if text is None:
        b.files.pop(rel, None)
    else:
        b.files[rel] = text
    if b.workdir:
        p = b.workdir / rel
        if text is None:
            p.unlink(missing_ok=True)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)


def _project_read(b, rel: str) -> str | None:
    if b.workdir and (b.workdir / rel).exists():
        return (b.workdir / rel).read_text(errors="replace")
    return b.files.get(rel)


def _fix_plan(b) -> dict:
    """The builder's verdict in .tably/arreglo.json: size, whether it applied the fix, and the plain-words explanation."""
    raw = _project_read(b, incidentsmod.FIX_FILE) or ""
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        d = json.loads(m.group(0)) if m else {}
    except ValueError:
        d = {}
    size = str(d.get("tamano") or d.get("tamaño") or d.get("size") or "").lower()
    return {"size": "big" if size.startswith(("gran", "big", "large")) else "small" if size else "", "applied": bool(d.get("aplicado", d.get("applied"))),
            "what": str(d.get("que_paso") or d.get("what") or "")[:600], "fix": str(d.get("como_se_arregla") or d.get("fix") or "")[:800],
            "impact": str(d.get("que_cambia") or d.get("impact") or "")[:500]}


def on_app_errors(user_id: str, build_id: str) -> None:
    """The published app has open errors (incidents.tick): the builder fixes them and the fix is published again, unless it
    is big (then it waits for the user's approval). Errors fixed twice that keep happening also wait for the user."""
    rows = incidentsmod.with_status(user_id, build_id, "open")
    stuck = [r["id"] for r in rows if r["attempts"] >= ERROR_FIX_ATTEMPTS]
    incidentsmod.update(stuck, status="stuck")
    rows = [r for r in rows if r["id"] not in stuck]
    if not rows or incidentsmod.fixes_today(user_id, build_id) >= ERROR_FIX_PER_DAY:
        return  # stays open: the panel offers «Arreglar ahora»
    user, b = _owner_build(user_id, build_id)
    if b and not _busy(b):
        _start_error_fix(user, b, rows)


def _note(b, text: str, tone: str = "", detail: str = "", run: bool = False, link: dict | None = None, go: str = "") -> None:
    """A line from Tably in the build's chat (live too). With a tone (working/done/attention) it is a card, not a faint line:
    the user has to see what is happening with their app; `detail` is the technical error, `run` adds «Ver la app»."""
    ts = time.time()
    item = {"role": "system", "text": text, "ts": ts, **({"tone": tone} if tone else {}), **({"detail": detail[:400]} if detail else {}), **({"run": True} if run else {}), **({"link": link} if link else {}), **({"go": go} if go else {})}
    b.chat.append(item)
    b.emit("notice", **{k: v for k, v in item.items() if k not in ("role", "ts")})
    b._save()


def _run_fix(b, state: str | None, **fields) -> None:
    """What the «App real» pane shows while Tably fixes the run: a loader (fixing/restarting) or a card (needs_approval/stuck/manual)."""
    r = runmod.RUNS.get(b.id)
    if not r:
        return
    r.fix = None if state is None else {**(r.fix or {}), "state": state, "since": (r.fix or {}).get("since") or time.time(), **fields}  # one clock for the whole fix
    r.announce()


def _published(user_id: str, build_id: str) -> bool:
    a = cloudmod.get_app(user_id, build_id) or {}
    return a.get("status") in ("live", "deploying") or (a.get("status") == "error" and bool(a.get("url")))


def _start_error_fix(user: User, b, rows: list[dict], approved: dict | None = None, extra: str = "") -> None:
    """One builder pass over these errors. `approved`: a big fix the user said yes to (it is applied and published).
    Errors of «Correr la app» (source run) end with the app running again; the published app gets the fix too."""
    ids = [r["id"] for r in rows]
    app_ = cloudmod.get_app(user.id, b.id) or {}
    on_run = any(r["source"] == "run" for r in rows)
    _project_write(b, incidentsmod.ERRORS_FILE, incidentsmod.render_md(incidentsmod.list_for(user.id, b.id)))
    _project_write(b, incidentsmod.FIX_FILE, None)
    before = len(b.versions)
    plain = ("En .tably/arreglo.json escribí un JSON: {\"tamano\": \"chico\"|\"grande\", \"aplicado\": true|false, \"que_paso\": \"…\", \"como_se_arregla\": \"…\", \"que_cambia\": \"…\"}. "
             f"Las tres explicaciones en {b.req.language or 'español'} simple, para alguien que no sabe programar: una o dos frases cada una, sin jerga técnica "
             "(nada de «migración», «endpoint», «stack», «500»; por ejemplo: «la base de datos no tenía armadas las tablas donde se guardan los turnos, así que la agenda no podía cargar»). "
             "«que_cambia» dice qué va a notar la persona que usa la app. Al terminar emití <done>.")
    where = {"server": "servidor publicado", "browser": "navegador", "run": "al correr la app en Tably"}
    errors = "\n\n".join(f"- {r['title']} ({r['count']} vez/veces, {where.get(r['source'], r['source'])})\n{(r['sample'] or r['detail'] or '')[-2500:]}" for r in rows)
    scene = ("AL CORRER LA APP DENTRO DE TABLY («Correr la app»: instala dependencias y levanta el servidor de desarrollo) FALLÓ O TUVO ERRORES"
             if on_run else f"LA APP PUBLICADA ({app_.get('url')}) ESTÁ TENIENDO ERRORES MIENTRAS LA USAN")
    if approved:
        text = (f"EL USUARIO APROBÓ ESTE ARREGLO ({scene.lower()}).\nProblema: {approved.get('what')}\nArreglo aprobado: {approved.get('fix')}\n"
                "Aplicalo completo, verificá que compila (build/typecheck) y que los tests pasan. Los errores están en .tably/errores.md.\n" + plain.replace("\"tamano\": \"chico\"|\"grande\"", "\"tamano\": \"grande\"") + "\n\nERRORES:\n" + errors)
    else:
        text = (f"{scene}. Tably los detectó (log del servidor, navegador o el arranque); están abajo y en .tably/errores.md. Encontrá la causa raíz de cada uno.\n"
                "Primero decidí el tamaño del arreglo:\n"
                "- CHICO: corregir un bug acotado, una dependencia o un script que falta, que las tablas/migraciones se creen solas al arrancar, una variable de entorno con valor por defecto, el puerto, una validación, el manejo de un error. "
                "No borra ni transforma datos existentes y no cambia lo que la app hace ni cómo se ve.\n"
                f"- GRANDE: rehacer partes de la app, cambiar el modelo de datos transformando o borrando datos existentes, cambiar lo que la app hace o cómo se ve, sumar un servicio externo o un cobro, o tocar más de {BIG_FIX_FILES - 2} archivos.\n"
                "Si es CHICO: aplicalo y verificá que compila (build/typecheck) y que los tests pasan. Si es GRANDE: NO cambies código, solo explicá la propuesta.\n"
                + plain + "\n\nERRORES:\n" + errors + (f"\n\nLO QUE MANDÓ EL USUARIO DESDE LA APP:\n{extra}" if extra else ""))
    incidentsmod.bump_attempts(ids)
    lessonsmod.record(user.id, b.id, "runtime", "error en producción", "\n".join(r["detail"] or "" for r in rows))
    b._error_fix = True
    b.resume(text)
    b._pending_requests = [{"severity": "bloqueante", "role": "Tably Cloud", "text": f"Error: {r['title']}"[:300]} for r in rows]
    b._pending_trigger = "runtime"
    if on_run:
        _run_fix(b, "fixing", id=rows[0]["id"])
    _note(b, b.tx(f"La app tuvo un error {'al correrla' if on_run else 'en producción'} y ya lo estamos arreglando." + (" Cuando termine, se vuelve a abrir sola." if on_run else " Cuando termine, se publica sola."),
                  f"The app hit an error {'while running' if on_run else 'in production'} and we are already fixing it." + (" When it's done it opens again by itself." if on_run else " When it's done it publishes by itself.")),
          tone="working", detail=rows[0]["title"], run=on_run)

    async def finish() -> None:
        try:
            while b.status in ("running", "reviewing", "design_review"):
                await asyncio.sleep(5)
        finally:
            b._error_fix = False
        plan = _fix_plan(b)
        v = b.versions[-1] if len(b.versions) > before else None
        st = (v or {}).get("stats") or {}
        changed = [*st.get("added", []), *st.get("modified", []), *st.get("deleted", [])]
        changed = [p for p in changed if not p.startswith(".tably/")]
        fields = {k: plan[k] for k in ("what", "fix", "impact") if plan[k]}
        big = len(changed) > BIG_FIX_FILES or int(st.get("insertions") or 0) + int(st.get("deletions") or 0) > BIG_FIX_LINES
        if b.status != "error" and not approved and (plan["size"] == "big" or big):
            # nothing goes out without the user's yes; what was already changed stays unpublished until then
            incidentsmod.update(ids, status="needs_approval", size="big", applied=int(bool(changed)), **fields)
            if on_run:
                _run_fix(b, "needs_approval", id=ids[0], what=plan["what"] or rows[0]["title"], fix=plan["fix"], impact=plan["impact"], applied=bool(changed))
            _note(b, b.tx(f"Para arreglar este error hace falta un cambio grande y necesita tu OK: {plan['what'] or rows[0]['title']}" + ("" if on_run else ". Revisalo en «Publicar»."),
                          f"Fixing this error needs a big change and your OK: {plan['what'] or rows[0]['title']}" + ("" if on_run else ". Review it in «Publish».")),
                  tone="attention", run=on_run)
            return
        if b.status == "error" or not changed:
            incidentsmod.update(ids, status="open", **fields)  # next round, or «stuck» after the attempts
            if on_run:
                _kick_run_errors(user.id, b.id)
            return
        if v:
            lessonsmod.note_fix(user.id, b.id, v.get("summary") or plan["fix"], changed)
        incidentsmod.update(ids, status="deploying", size=plan["size"] or "small", applied=1, **fields)
        _note(b, b.tx(f"Arreglado: {plan['what'] or rows[0]['title']}" + (f" {plan['fix']}" if plan["fix"] else "") + (" Volviendo a correr la app…" if on_run else "") + (" Publicando la corrección…" if _published(user.id, b.id) else ""),
                      f"Fixed: {plan['what'] or rows[0]['title']}" + (f" {plan['fix']}" if plan["fix"] else "") + (" Running the app again…" if on_run else "") + (" Publishing the fix…" if _published(user.id, b.id) else "")),
              tone="done", run=on_run)
        if on_run:
            await _restart_run(user, b)
        if _published(user.id, b.id):
            _start_publish(user, b)

    spawn(finish())


def _kick_run_errors(user_id: str, build_id: str) -> None:
    """Open errors of «Correr la app»: fix them now (they can't wait for the monitor: the user is looking at the app).
    Fixed twice and still failing, the daily limit, or the builder busy with something else: the pane shows a card instead."""
    rows = [r for r in incidentsmod.with_status(user_id, build_id, "open") if r["source"] == "run"]
    user, b = _owner_build(user_id, build_id)
    if not b:
        return
    if not rows:  # this error already waits for the user (approval, stuck, dismissed) or is being fixed: say so, never a dead pane
        last = next((r for r in incidentsmod.list_for(user_id, build_id) if r["source"] == "run"), None)
        if last and last["status"] != "fixing":
            st = {"needs_approval": "needs_approval", "stuck": "stuck"}.get(last["status"], "manual")
            _run_fix(b, st, id=last["id"], what=last["what"] or last["title"], fix=last["fix"], impact=last["impact"], applied=bool(last["applied"]))
        return
    stuck = [r for r in rows if r["attempts"] >= ERROR_FIX_ATTEMPTS]
    if stuck:
        incidentsmod.update([r["id"] for r in stuck], status="stuck")
        _run_fix(b, "stuck", id=stuck[0]["id"], what=stuck[0]["what"] or stuck[0]["title"], fix=stuck[0]["fix"], impact=stuck[0]["impact"])
        _note(b, b.tx(f"Lo intentamos arreglar dos veces y la app sigue fallando ({stuck[0]['title'].lower()}). Hace falta que lo mires: tenés el detalle en «App real».",
                      f"We tried to fix it twice and the app keeps failing ({stuck[0]['title'].lower()}). It needs your look: details in «Real app»."),
              tone="attention", run=True)
        return
    if _busy(b):
        _run_fix(b, "manual", id=rows[0]["id"], what=rows[0]["title"], reason="busy")
        return
    if incidentsmod.fixes_today(user_id, build_id) >= ERROR_FIX_PER_DAY:
        _run_fix(b, "manual", id=rows[0]["id"], what=rows[0]["title"], reason="limit")
        return
    _start_error_fix(user, b, rows)


async def _restart_run(user: User, b) -> None:
    """Run the app again after a fix, same service; the pane keeps the loader until it answers."""
    old = runmod.RUNS.get(b.id)
    svc_id = old.service["id"] if old else None
    fix = dict(old.fix or {}) if old else {}
    if old:
        await old.stop()
    root = _run_root(b)
    services = runmod.detect(root)
    svc = next((s for s in services if s["id"] == svc_id), services[0] if services else None)
    if not svc:
        return
    r = runmod.AppRun(root, svc, user.id, b.id, b.files, lambda t, d: b.emit(t, **d))
    r.fix = {**fix, "state": "restarting"}
    runmod.RUNS[b.id] = r
    b.app_run = r
    r.task = spawn(r.run())


def on_run_status(run) -> None:
    """«Correr la app» changed state. A failure goes to the builder (the pane shows a loader, never a dead app); a run that
    comes back after a fix closes it."""
    if run.status == "running" and run.fix and run.fix.get("state") in ("restarting", "fixing"):
        with auth._db() as c:
            c.execute("UPDATE app_errors SET status = 'fixed', fixed_ts = ? WHERE user_id = ? AND build_id = ? AND source = 'run' AND status = 'deploying'", (time.time(), run.user_id, run.build_id))
        run.fix = None
    elif run.status == "error":
        _run_failed(run, run.error or "La app no arrancó")
    if run.status == "running" and not run.fix:
        _check_memory_db(run)


# the app keeps its data only in memory when it runs without DATABASE_URL: what the user creates while trying it is lost on every restart
_MEMORY_DB = re.compile(r'\b(in-memory|in memory|pg-mem|en memoria|:memory:)\b|"?(engine|db|database|store|storage)"?\s*[:=]\s*"?(memory|mem|in-?memory|pg-?mem)\b', re.I)


def _check_memory_db(run) -> None:
    hit = next((ln for ln in run.logs[-200:] if _MEMORY_DB.search(ln) and not re.search(r"out of memory|heap|MemoryError", ln, re.I)), None)
    if not hit:
        return
    title = "Lo que se crea al probar la app se borra cuando se reinicia (guarda los datos solo en memoria)"
    row = incidentsmod.record(run.user_id, run.build_id, "run", title,
                              f"{title}\nLínea del log: {hit.strip()[:300]}\n"
                              "Sin DATABASE_URL la app tiene que guardar en disco, en la carpeta de la variable TABLY_DATA_DIR (o .data/ si no existe): "
                              "PGlite con dataDir, o SQLite en un archivo, con las mismas migraciones que en Postgres, y el seed de ejemplo solo si la base está vacía. "
                              "Agregá .data/ a .gitignore y .dockerignore. Con DATABASE_URL (publicada) sigue usando Postgres como ahora.")
    if row.get("status") == "open" and (row.get("attempts") or 0) < ERROR_FIX_ATTEMPTS:
        spawn(_kick_async(run.user_id, run.build_id))


def _run_failed(run, what: str) -> None:
    with auth._db() as c:  # failed again after a fix: that fix did not hold
        c.execute("UPDATE app_errors SET status = 'open' WHERE user_id = ? AND build_id = ? AND source = 'run' AND status = 'deploying'", (run.user_id, run.build_id))
    tail = [ln for ln in run.logs[-80:] if ln.strip()]
    head = incidentsmod.log_headline(tail)
    row = incidentsmod.record(run.user_id, run.build_id, "run", head or what, f"{what}\n--- log ---\n" + "\n".join(tail[-60:]))
    if row.get("status") == "fixed":  # it broke again right after the fix
        incidentsmod.update([row["id"]], status="open")
    run.fix = {**(run.fix or {}), "state": "fixing", "since": (run.fix or {}).get("since") or time.time()}  # the loader shows right away; _kick_run_errors decides what happens
    spawn(_kick_async(run.user_id, run.build_id))


async def _kick_async(user_id: str, build_id: str) -> None:
    await asyncio.sleep(0.5)  # out of the run's own status change
    try:
        _kick_run_errors(user_id, build_id)
    except Exception:  # noqa: BLE001
        log.exception("run error fix")


runmod.ON_STATUS = on_run_status


incidentsmod.ON_ERRORS = on_app_errors


def _errors_payload(user: User, build_id: str) -> dict:
    rows = incidentsmod.list_for(user.id, build_id)
    keep = ("id", "source", "title", "detail", "count", "first_ts", "last_ts", "status", "attempts", "size", "applied", "what", "fix", "impact", "fixed_ts")
    return {"errors": [{k: r[k] for k in keep} for r in rows], "summary": incidentsmod.summary(rows), "limit_reached": incidentsmod.fixes_today(user.id, build_id) >= ERROR_FIX_PER_DAY}


@app.get("/api/sessions/{session_id}/builds/{build_id}/app-errors")
def build_app_errors(session_id: str, build_id: str, user: User = CurrentUser):
    _build_any(user, session_id, build_id)
    return _errors_payload(user, build_id)


@app.post("/api/sessions/{session_id}/builds/{build_id}/app-errors/{eid}/{action}")
async def build_app_error_action(session_id: str, build_id: str, eid: str, action: str, user: User = CurrentUser):
    """approve: apply/publish the big fix the builder proposed · fix: fix it now (also after «stuck» or the daily limit) · dismiss: leave it."""
    b = _build_any(user, session_id, build_id)
    r = incidentsmod.get(user.id, eid)
    if not r or r["build_id"] != build_id:
        raise HTTPException(404)
    if action == "dismiss":
        incidentsmod.update([eid], status="ignored")
        if r["source"] == "run":
            _run_fix(b, "manual", id=eid, what=r["what"] or r["title"], fix=r["fix"], impact=r["impact"])
        return _errors_payload(user, build_id)
    if action not in ("approve", "fix"):
        raise HTTPException(400)
    if _busy(b):
        raise HTTPException(409, "El constructor está trabajando: probá en un rato")
    if action == "approve" and r["status"] == "needs_approval" and r["applied"]:
        incidentsmod.update([eid], status="deploying")  # the fix is already in the code: it only needed the yes to go out
        if r["source"] == "run":
            _run_fix(b, "restarting")
            spawn(_restart_run(user, b))
        if _published(user.id, build_id):
            _start_publish(user, b)
    elif action == "approve" and r["status"] == "needs_approval":
        _start_error_fix(user, b, [r], approved=r)
    else:
        incidentsmod.update([eid], status="open", attempts=0)
        _start_error_fix(user, b, [incidentsmod.get(user.id, eid)])
    return _errors_payload(user, build_id)


@app.post("/api/sessions/{session_id}/builds/{build_id}/app-run/report")
async def build_run_report(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    """«Enviar al constructor» from «App real»: what the user sees (screenshot, text on screen), the page's failed requests and
    errors, and the server log go to the builder, which finds exactly where it breaks, fixes it and the app runs again."""
    import base64

    b = _build_any(user, session_id, build_id)
    run = runmod.RUNS.get(b.id)
    shot = ""
    m = re.match(r"^data:image/(jpeg|png);base64,(.+)$", str(body.get("screenshot") or ""), re.S)
    if m and b.workdir:
        try:
            data = base64.b64decode(m.group(2))[:6_000_000]
            rel = f".tably/capturas/{time.strftime('%Y%m%d-%H%M%S')}.{'jpg' if m.group(1) == 'jpeg' else 'png'}"
            (b.workdir / rel).parent.mkdir(parents=True, exist_ok=True)
            (b.workdir / rel).write_bytes(data)
            shot = rel
        except Exception:  # noqa: BLE001
            log.exception("run report screenshot")
    entries = [e for e in (body.get("log") or []) if isinstance(e, dict)][-25:]
    http = [e for e in entries if e.get("kind") == "http"]
    fails = "\n".join(f"- {e.get('method') or 'GET'} {str(e.get('url'))[:200]} → {e.get('status')}\n  respuesta: {str(e.get('body') or '')[:600]}" for e in http) or "(ningún pedido falló en esta página)"
    errs = "\n".join(f"- [{e.get('kind')}] {str(e.get('message'))[:600]}" + (f"\n  {str(e.get('stack'))[:800]}" if e.get("stack") else "") for e in entries if e.get("kind") != "http") or "(ninguno)"
    screen = str(body.get("text") or "").strip()[:2500]
    alerts = [str(a).strip()[:300] for a in (body.get("alerts") or []) if str(a).strip()][:6]
    note = str(body.get("note") or "").strip()[:1000]
    tail = "\n".join([ln for ln in (run.logs if run else []) if ln.strip()][-60:]) or "(sin log)"
    head = (f"{http[-1].get('method') or 'GET'} {str(http[-1].get('url')).split('?')[0]} → {http[-1].get('status')}" if http
            else alerts[0] if alerts else "Error que el usuario vio al usar la app")
    sample = (
        "EL USUARIO ESTABA USANDO LA APP («Correr la app») Y SE ENCONTRÓ CON ESTE ERROR. Mandó lo que estaba viendo.\n"
        + (f"Lo que dice el usuario: {note}\n" if note else "")
        + f"Página: {str(body.get('page') or '')[:300]}\n"
        + (f"Captura de pantalla: {shot} (abrila y miralo antes de tocar nada)\n" if shot else "")
        + ("Mensajes de error en pantalla:\n" + "\n".join(f"- {a}" for a in alerts) + "\n" if alerts else "")
        + f"\nPedidos a la API que fallaron (del navegador):\n{fails}\n\nErrores del navegador:\n{errs}\n"
        + f"\nTexto visible en la pantalla:\n{screen}\n\nÚltimas líneas del log del servidor:\n{tail}\n\n"
        "Seguí el flujo que estaba haciendo el usuario desde la pantalla hasta la API y la base de datos, y encontrá EXACTAMENTE dónde está el error "
        "(archivo y línea, y por qué falla). Arreglá la causa (no escondas el mensaje), probalo reproduciendo el mismo pedido (un test o un curl contra la API) "
        "y, si el mensaje de error de la pantalla no explica nada, hacelo claro para quien usa la app.")
    row = incidentsmod.record(user.id, b.id, "run", head, head + ("\n" + "\n".join(alerts) if alerts else ""))
    if row.get("status") != "open":
        incidentsmod.update([row["id"]], status="open")
        row = incidentsmod.get(user.id, row["id"]) or row
    if b.status in ("running", "reviewing", "design_review") or _busy(b):  # the builder is on something else: it reads it next
        if b.status == "running":
            b.say(sample[:6000])
        _note(b, b.tx("Le mandamos al constructor lo que viste en la app (con la captura). Lo toma apenas termine lo que está haciendo.",
                      "We sent the builder what you saw in the app (with the screenshot). It picks it up as soon as it finishes what it is doing."), tone="working", detail=head)
        return {"ok": True, "queued": True}
    _start_error_fix(user, b, [row], extra=sample)
    return {"ok": True, "queued": False}


@app.get("/api/app-errors/{slug}/reporter.js")
def app_errors_reporter(slug: str):
    js = incidentsmod.reporter_js(f"{cloudmod.public_url()}/api/app-errors/{slug}")
    return Response(js, media_type="application/javascript", headers={"Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*"})


@app.post("/api/app-errors/{slug}")
async def app_errors_report(slug: str, request: Request):
    """Public: a visitor's browser reports an error of a published app (sendBeacon, text/plain JSON). Rate-limited per app."""
    try:
        body = json.loads((await request.body())[:8000] or b"{}")
    except ValueError:
        body = {}
    kept = incidentsmod.report_browser(slug, body if isinstance(body, dict) else {})
    return Response(status_code=204 if kept else 202, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/api/admin/deploy-failures")
def admin_deploy_failures(days: int = 90, user: User = CurrentUser):
    """What Tably Cloud learned from failed deploys: which errors repeat, which the automatic fix solved (admin only)."""
    if not _is_admin(user):
        raise HTTPException(403)
    return lessonsmod.report(max(1, min(days, 365)))


@app.delete("/api/sessions/{session_id}/builds/{build_id}/cloud/publish")
async def build_cloud_unpublish(session_id: str, build_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    app_ = await cloudmod.unpublish(user.id, build_id)
    b.emit("cloud.status", app=cloudmod.public(app_))
    return {"ok": True, "app": cloudmod.public(app_)}


@app.post("/api/sessions/{session_id}/builds/{build_id}/cloud/db")
async def build_cloud_db(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    provider = body.get("provider")

    def logf(line: str):
        b.emit("cloud.log", line=line[-500:])

    if provider == "neon":
        res = await cloudmod.provision_neon(user.id, build_id, b.title, logf)
    elif provider == "supabase":
        res = await cloudmod.provision_supabase(user.id, build_id, b.title, logf)
    else:
        raise HTTPException(400, "proveedor inválido")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "no se pudo provisionar")
    b.emit("cloud.status", app=cloudmod.public(cloudmod.get_app(user.id, build_id)))
    return res


@app.post("/api/sessions/{session_id}/builds/{build_id}/cloud/git/sync")
def build_git_sync(session_id: str, build_id: str, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    res = gitserver.sync(user.id, build_id, _cloud_root(user, b), f"sync manual · v{len(b.versions)}")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "no se pudo sincronizar")
    return {**res, "git": gitserver.info(user.id, build_id, cloudmod.public_url())}


@app.post("/api/sessions/{session_id}/builds/{build_id}/cloud/git/github")
def build_git_github(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    b = _build_any(user, session_id, build_id)
    token = keystore.get_key(user.id, "github")
    if not token:
        raise HTTPException(400, "Cargá un token de GitHub (permiso «repo») en Configuración → Tably Cloud.")
    res = gitserver.push_github(user.id, build_id, token, body.get("name") or b.title or build_id, private=body.get("private", True), root=_cloud_root(user, b))
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "no se pudo mover a GitHub")
    b.emit("cloud.github", url=res["url"])
    return res


@app.api_route("/git/{user_id}/{repo}/{path:path}", methods=["GET", "POST"])
async def git_http(user_id: str, repo: str, path: str, request: Request):
    """Smart HTTP for `git clone/fetch/push`: the account token goes as the Basic password (any username)."""
    tok = gitserver.parse_basic_auth(request.headers.get("authorization"))
    u = auth.user_from_token(tok) if tok else None
    if not u or u.id != user_id:
        return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Tably Git"'}, content="token requerido")
    body = await request.body()
    status, headers, payload = gitserver.http_backend(user_id, repo, path, request.method, request.url.query, request.headers.get("content-type"), body)
    return Response(status_code=status, headers={k: v for k, v in headers}, content=payload)


@app.get("/api/agents/sessions")
def agent_sessions_list(engine: str = "claude", user: User = CurrentUser):
    """Your Claude Code / Codex conversations on this machine, grouped by project (read-only)."""
    if engine not in ("claude", "codex", "muse"):
        raise HTTPException(400, "engine: claude | codex | muse")
    return agent_sessions.list_sessions(engine, user.id)


@app.get("/api/agents/sessions/{engine}/{session_id}")
def agent_session_get(engine: str, session_id: str, user: User = CurrentUser):
    if engine not in ("claude", "codex", "muse"):
        raise HTTPException(400, "engine: claude | codex | muse")
    d = agent_sessions.get_session(engine, session_id, user.id)
    if not d:
        raise HTTPException(404, "Sesión no encontrada")
    return d


@app.post("/api/agents/sessions/{engine}/{session_id}/message")
async def agent_session_message(engine: str, session_id: str, body: dict, user: User = CurrentUser):
    """Chat from the sessions screen: resumes the real CLI session and streams its events as JSON lines."""
    if engine not in ("claude", "codex", "muse"):
        raise HTTPException(400, "engine: claude | codex | muse")
    text = (body.get("text") or "").strip()[:20000]
    if not text:
        raise HTTPException(400, "Escribí un mensaje")
    _check_capacity(user.id)
    return StreamingResponse(agent_sessions.chat(engine, session_id, text, user.id), media_type="application/x-ndjson", headers={"cache-control": "no-store", "x-accel-buffering": "no"})


@app.get("/api/devices")
def devices_status(user: User = CurrentUser):
    """What this machine can run for mobile apps (iOS Simulator, Android emulator)."""
    return runmod.devices()


@app.get("/api/sessions/{session_id}/builds/{build_id}/run/screen")
def app_run_screen(session_id: str, build_id: str, request: Request, target: str = "ios", token: str | None = None):
    """The device screen as PNG. Auth by bearer or by `token` query, because the panel loads it in an <img>."""
    bearer = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    user = auth.user_from_token(token or bearer or None)
    if not user:
        raise HTTPException(401)
    _build_any(user, session_id, build_id)
    png = runmod.screenshot(target if target in ("ios", "android") else "ios")
    if not png:
        raise HTTPException(404, "No hay un dispositivo encendido para capturar")
    return Response(content=png, media_type="image/png", headers={"cache-control": "no-store"})


@app.post("/api/sessions/{session_id}/builds/{build_id}/run/tap")
def app_run_tap(session_id: str, build_id: str, body: dict, user: User = CurrentUser):
    _build_any(user, session_id, build_id)
    ok = runmod.tap(str(body.get("target") or "android"), int(body.get("x") or 0), int(body.get("y") or 0))
    return {"ok": ok}


@app.get("/apps/{slug}/{path:path}")
def cloud_app_file(slug: str, path: str = ""):
    p = cloudmod.local_file(slug, path)
    if not p:
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/apps/{slug}")
def cloud_app_root(slug: str):
    p = cloudmod.local_file(slug, "")
    if not p:
        raise HTTPException(404)
    return FileResponse(p)


# ------------------------------------------------------------------ public content: blog, FAQ and the machine-readable files (SEO / answer engines)
from . import content as contentmod
from fastapi.responses import HTMLResponse


@app.get("/api/content/blog")
def content_blog_list(lang: str = "es"):
    return [p.meta() for p in contentmod.posts("en" if lang == "en" else "es")]


@app.get("/api/content/blog/{slug}")
def content_blog_post(slug: str, lang: str = "es"):
    p = contentmod.post(slug, "en" if lang == "en" else "es")
    if not p:
        raise HTTPException(404, "No existe ese artículo")
    return {**p.meta(), "html": p.body_html, "toc": p.toc_html, "keywords": p.keywords}


@app.get("/api/content/faq")
def content_faq(lang: str = "es"):
    return [{"question": i.question, "html": i.answer_html, "text": i.answer_text, "slug": i.slug} for i in contentmod.faq("en" if lang == "en" else "es")]


def _lang_of(prefix: str) -> str:
    return "en" if prefix == "en" else "es"


@app.get("/blog", response_class=HTMLResponse, include_in_schema=False)
@app.get("/{prefix}/blog", response_class=HTMLResponse, include_in_schema=False)
def page_blog(tag: str | None = None, prefix: str = ""):
    if prefix not in ("", "en"):
        raise HTTPException(404)
    return HTMLResponse(contentmod.blog_index_html(tag, _lang_of(prefix)))


@app.get("/blog/feed.xml", include_in_schema=False)
@app.get("/{prefix}/blog/feed.xml", include_in_schema=False)
def page_blog_feed(prefix: str = ""):
    if prefix not in ("", "en"):
        raise HTTPException(404)
    return Response(contentmod.rss_xml(_lang_of(prefix)), media_type="application/rss+xml")


@app.get("/blog/{slug}", response_class=HTMLResponse, include_in_schema=False)
@app.get("/{prefix}/blog/{slug}", response_class=HTMLResponse, include_in_schema=False)
def page_blog_post(slug: str, prefix: str = ""):
    if prefix not in ("", "en"):
        raise HTTPException(404)
    p = contentmod.post(slug, _lang_of(prefix))
    if not p:
        raise HTTPException(404, "No existe ese artículo")
    return HTMLResponse(contentmod.post_html(p))


@app.get("/faq", response_class=HTMLResponse, include_in_schema=False)
@app.get("/{prefix}/faq", response_class=HTMLResponse, include_in_schema=False)
def page_faq(prefix: str = ""):
    if prefix not in ("", "en"):
        raise HTTPException(404)
    return HTMLResponse(contentmod.faq_html(_lang_of(prefix)))


@app.get("/sitemap.xml", include_in_schema=False)
def page_sitemap():
    return Response(contentmod.sitemap_xml(), media_type="application/xml")


@app.get("/robots.txt", include_in_schema=False)
def page_robots():
    return PlainTextResponse(contentmod.robots_txt())


@app.get("/llms.txt", include_in_schema=False)
def page_llms():
    return PlainTextResponse(contentmod.llms_txt(), media_type="text/plain; charset=utf-8")


@app.get("/llms-full.txt", include_in_schema=False)
def page_llms_full():
    return PlainTextResponse(contentmod.llms_full_txt(), media_type="text/plain; charset=utf-8")


# ------------------------------------------------------------------ single-service deploy: the built frontend is served by the API
_STATIC = Path(env("ARENA_STATIC_DIR", str(Path(__file__).resolve().parents[2] / "frontend" / "dist")))
if _STATIC.is_dir() and (_STATIC / "index.html").exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="frontend")


@app.on_event("shutdown")
async def _shutdown():
    from .tasks import stop_runner

    for s in SESSIONS.values():
        s.stop()
    for b in BUILDS.values():
        b.stop()
    await runmod.stop_all()
    await asyncio.sleep(0.1)
    await stop_runner()
    obs.flush()
