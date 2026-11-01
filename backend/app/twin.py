"""Your digital twin (HeyGen) and stock shots (Pexels): an ad made without uploading any footage.

Meta's Model API only returns text, so here Meta Muse writes what the person says and which shots go with it, and two other
services make the footage (the meta-first rule: Meta as far as it goes, then the tool that does it):
- HeyGen makes the person's digital twin from one video of them talking (15 s to 10 min, about 2 minutes is best) and, with it,
  renders them saying any script, with their own cloned voice. The person records a consent statement on HeyGen's page (HeyGen
  asks for it on every twin) and only their own face can be used. API key per user, billed to their HeyGen API balance.
- Pexels gives free vertical stock video for the shots in between (with credit to the author).
Then the Ad Studio's team edits it like any upload: listens, plans (the voice keeps running over the stock shots), cuts, improves
and approves.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from pathlib import Path

import httpx

from . import keystore
from . import media
from .auth import User, _db, user_dir

log = logging.getLogger("arena.twin")

API = "https://api.heygen.com"
PEXELS = "https://api.pexels.com"
MIN_S, MAX_S, MAX_UPLOAD_MB = 15, 600, 200
_jobs: dict[str, asyncio.Task] = {}

with _db() as _c:
    _c.executescript("""
    CREATE TABLE IF NOT EXISTS twins (
        user_id TEXT PRIMARY KEY, name TEXT, group_id TEXT, look_id TEXT, voice_id TEXT, status TEXT NOT NULL, step TEXT,
        consent_url TEXT, consent_status TEXT, error TEXT, created REAL NOT NULL, updated REAL NOT NULL);
    """)


class TwinError(Exception):
    pass


# ------------------------------------------------------------------------------------------------------------ keys

def keys(user_id: str) -> dict:
    return {"heygen": keystore.key_status(user_id, "heygen"), "pexels": keystore.key_status(user_id, "pexels")}


def _heygen_key(user_id: str) -> str:
    k = keystore.get_key(user_id, "heygen")
    if not k:
        raise TwinError("Falta tu clave de API de HeyGen")
    return k


def _check(r: httpx.Response) -> dict:
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code >= 400 or (isinstance(data, dict) and data.get("error") and not data.get("data")):
        e = data.get("error") if isinstance(data, dict) else None
        msg = (e.get("message") if isinstance(e, dict) else e) or (data.get("message") if isinstance(data, dict) else None) or f"HeyGen respondió {r.status_code}"
        if r.status_code in (401, 403):
            msg = f"HeyGen no aceptó la clave ({msg})"
        if r.status_code == 402:
            msg = f"Tu cuenta de API de HeyGen no tiene saldo ({msg})"
        raise TwinError(str(msg)[:300])
    return data if isinstance(data, dict) else {}


async def save_keys(user_id: str, heygen: str | None, pexels: str | None) -> dict:
    """Checks each key against its service before keeping it (encrypted)."""
    async with httpx.AsyncClient(timeout=20) as cx:
        if heygen:
            _check(await cx.get(f"{API}/v3/users/me", headers={"x-api-key": heygen}))
            keystore.save(user_id, "heygen", api_key=heygen)
        if pexels:
            r = await cx.get(f"{PEXELS}/videos/search", params={"query": "coffee", "per_page": 1}, headers={"Authorization": pexels})
            if r.status_code != 200:
                raise TwinError("Pexels no aceptó la clave")
            keystore.save(user_id, "pexels", api_key=pexels)
    return keys(user_id)


# ------------------------------------------------------------------------------------------------------------ the twin

def get(user_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM twins WHERE user_id = ?", (user_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["working"] = user_id in _jobs
    return d


def _set(user_id: str, **fields) -> None:
    now = time.time()
    with _db() as c:
        if not c.execute("SELECT 1 FROM twins WHERE user_id = ?", (user_id,)).fetchone():
            c.execute("INSERT INTO twins (user_id, status, created, updated) VALUES (?, 'new', ?, ?)", (user_id, now, now))
        sets = ", ".join(f"{k} = ?" for k in fields)
        c.execute(f"UPDATE twins SET {sets}, updated = ? WHERE user_id = ?", [*fields.values(), now, user_id])


def forget(user_id: str) -> None:
    """Tably stops using it (the twin stays in the person's HeyGen account, where they can delete it)."""
    with _db() as c:
        c.execute("DELETE FROM twins WHERE user_id = ?", (user_id,))


async def _upload(cx: httpx.AsyncClient, key: str, path: Path) -> str:
    """The footage to HeyGen as an asset (direct upload: up to 200 MB)."""
    size = path.stat().st_size
    ctype = "video/webm" if path.suffix == ".webm" else "video/mp4"
    up = _check(await cx.post(f"{API}/v3/assets/direct-uploads", headers={"x-api-key": key}, json={"filename": path.name, "content_type": ctype, "size_bytes": size}))
    d = up.get("data") or up
    aid, url, hdrs = d.get("asset_id"), d.get("upload_url"), d.get("upload_headers") or {}
    if not aid or not url:
        raise TwinError("HeyGen no devolvió dónde subir el video")

    async def body():
        with path.open("rb") as f:
            while chunk := f.read(1 << 20):
                yield chunk
    r = await cx.put(url, content=body(), headers={**hdrs, "content-length": str(size)}, timeout=900)
    if r.status_code >= 300:
        raise TwinError(f"No se pudo subir el video a HeyGen ({r.status_code})")
    _check(await cx.post(f"{API}/v3/assets/{aid}/complete", headers={"x-api-key": key}, json={}))
    return aid


def start(user: User, raw: Path, name: str) -> None:
    """Make (or add a look to) the person's twin from one video of them talking, in the background."""
    from .tasks import spawn

    if user.id in _jobs:
        raise TwinError("Ya estamos armando tu gemelo: esperá a que termine")
    _set(user.id, status="uploading", step="Revisando el video", error=None, name=(name or "Mi gemelo")[:60])
    _jobs[user.id] = spawn(_make(user, raw))  # type: ignore[assignment]


async def _make(user: User, raw: Path) -> None:
    work = raw.parent
    try:
        key = _heygen_key(user.id)
        info = await asyncio.to_thread(media.probe, raw)
        if not info["duration"]:
            raise TwinError("No pude leer ese video")
        if info["duration"] < MIN_S:
            raise TwinError(f"Dura {round(info['duration'])} s: HeyGen pide al menos {MIN_S} s de vos hablando (lo ideal son 2 minutos)")
        if info["duration"] > MAX_S:
            raise TwinError(f"Dura {round(info['duration'] / 60)} min: HeyGen acepta hasta {MAX_S // 60} minutos")
        if not info["audio"]:
            raise TwinError("El video no tiene sonido: tu gemelo aprende tu voz de lo que decís")
        src = raw
        long_edge = max(info["width"], info["height"])
        if raw.suffix.lower() not in (".mp4", ".webm") or raw.stat().st_size > MAX_UPLOAD_MB * 1024 * 1024 or long_edge > 4096:
            _set(user.id, step="Preparando el video")
            src = work / "twin.mp4"
            await asyncio.to_thread(media.normalise, raw, src, 1920)
            if src.stat().st_size > MAX_UPLOAD_MB * 1024 * 1024:
                raise TwinError("El video pesa más de 200 MB aun comprimido: subí uno más corto (con 2 minutos alcanza)")
        _set(user.id, step="Subiendo el video a HeyGen")
        cur = get(user.id) or {}
        async with httpx.AsyncClient(timeout=60) as cx:
            aid = await _upload(cx, key, src)
            _set(user.id, step="Creando tu gemelo en HeyGen")
            body = {"type": "digital_twin", "name": cur.get("name") or "Mi gemelo", "file": {"type": "asset_id", "asset_id": aid}}
            if cur.get("group_id"):
                body["avatar_group_id"] = cur["group_id"]  # another look of the same person
            made = _check(await cx.post(f"{API}/v3/avatars", headers={"x-api-key": key}, json=body))
            d = made.get("data") or made
            item, group = d.get("avatar_item") or {}, d.get("avatar_group") or {}
            look, gid = item.get("id"), group.get("id") or cur.get("group_id")
            voice = group.get("default_voice_id") or item.get("default_voice_id") or cur.get("voice_id")
            if not look or not gid:
                raise TwinError("HeyGen no devolvió el gemelo creado")
            _set(user.id, look_id=look, group_id=gid, voice_id=voice, status="training", step="HeyGen está entrenando tu gemelo (unos minutos)")
            if (cur.get("consent_status") or "") != "accepted":
                c = _check(await cx.post(f"{API}/v3/avatars/{gid}/consent", headers={"x-api-key": key}, json={}))
                url = (c.get("data") or c).get("url")
                _set(user.id, consent_url=url, consent_status="pending")
    except Exception as e:  # noqa: BLE001
        log.warning("twin %s: %s", user.id, e)
        _set(user.id, status="failed", step=None, error=str(e)[:300] if isinstance(e, (TwinError, ValueError)) else f"No se pudo crear el gemelo: {str(e)[:200]}")
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the footage is only on HeyGen
        _jobs.pop(user.id, None)


async def new_consent(user_id: str) -> dict:
    t = get(user_id)
    if not t or not t.get("group_id"):
        raise TwinError("Primero creá tu gemelo")
    async with httpx.AsyncClient(timeout=30) as cx:
        c = _check(await cx.post(f"{API}/v3/avatars/{t['group_id']}/consent", headers={"x-api-key": _heygen_key(user_id)}, json={}))
    _set(user_id, consent_url=(c.get("data") or c).get("url"), consent_status="pending")
    return get(user_id) or {}


async def refresh(user_id: str) -> dict | None:
    """Training and consent, as HeyGen sees them now. Ready = the look is trained and the consent was accepted."""
    t = get(user_id)
    if not t or t["status"] not in ("training", "consent") or t["working"]:
        return t
    try:
        key = _heygen_key(user_id)
        async with httpx.AsyncClient(timeout=20) as cx:
            look = (_check(await cx.get(f"{API}/v3/avatars/looks/{t['look_id']}", headers={"x-api-key": key})).get("data") or {})
            look = look.get("avatar_look") or look.get("look") or look
            grp = (_check(await cx.get(f"{API}/v3/avatars/{t['group_id']}", headers={"x-api-key": key})).get("data") or {})
            grp = grp.get("avatar_group") or grp
        ls, cs = str(look.get("status") or ""), grp.get("consent_status")
        err = look.get("error") if isinstance(look.get("error"), dict) else (grp.get("error") if isinstance(grp.get("error"), dict) else None)
        if ls == "failed" or cs == "rejected" or grp.get("status") == "failed":
            _set(user_id, status="failed", step=None, consent_status=cs, error=(err or {}).get("message") or ("HeyGen rechazó el consentimiento: grabalo de nuevo" if cs == "rejected" else "HeyGen no pudo entrenar el gemelo"))
        elif ls == "completed" and cs == "accepted":
            _set(user_id, status="ready", step=None, consent_status=cs, error=None, voice_id=grp.get("default_voice_id") or t.get("voice_id"))
        else:
            _set(user_id, status="consent" if ls == "completed" else "training", consent_status=cs,
                 step="Falta que grabes tu consentimiento en HeyGen" if cs != "accepted" else "HeyGen está entrenando tu gemelo (unos minutos)")
    except TwinError as e:
        log.info("twin refresh %s: %s", user_id, e)
    except Exception as e:  # noqa: BLE001
        log.warning("twin refresh %s: %s", user_id, e)
    return get(user_id)


# ------------------------------------------------------------------------------------------------------------ footage for an ad

async def render_talk(user_id: str, script: str, title: str) -> str:
    """The twin saying the script, vertical 9:16 at 1080p, with their cloned voice. Returns HeyGen's video id."""
    t = get(user_id)
    if not t or t["status"] != "ready":
        raise TwinError("Tu gemelo todavía no está listo")
    body = {"type": "avatar", "avatar_id": t["look_id"], "script": script, "title": title[:80], "resolution": "1080p", "aspect_ratio": "9:16", "output_format": "mp4"}
    if t.get("voice_id"):
        body["voice_id"] = t["voice_id"]
    async with httpx.AsyncClient(timeout=60) as cx:
        r = _check(await cx.post(f"{API}/v3/videos", headers={"x-api-key": _heygen_key(user_id)}, json=body))
    vid = (r.get("data") or r).get("video_id")
    if not vid:
        raise TwinError("HeyGen no devolvió el video")
    return vid


async def wait_talk(user_id: str, vid: str, out: Path, on_wait=None, limit_s: int = 2400) -> Path:
    """Waits for HeyGen's render and downloads it (the links expire)."""
    key = _heygen_key(user_id)
    t0 = time.time()
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as cx:
        while True:
            d = _check(await cx.get(f"{API}/v3/videos/{vid}", headers={"x-api-key": key})).get("data") or {}
            st = d.get("status")
            if st == "completed" and d.get("video_url"):
                async with cx.stream("GET", d["video_url"], timeout=600) as r:
                    r.raise_for_status()
                    with out.open("wb") as f:
                        async for chunk in r.aiter_bytes(1 << 20):
                            f.write(chunk)
                return out
            if st == "failed":
                raise TwinError("HeyGen no pudo hacer el video: " + str(d.get("failure_message") or d.get("failure_code") or "sin detalle")[:200])
            if time.time() - t0 > limit_s:
                raise TwinError("HeyGen tardó demasiado en hacer el video")
            if on_wait:
                on_wait(int(time.time() - t0))
            await asyncio.sleep(10)


async def stock(user_id: str, query: str, used: set[int]) -> dict | None:
    """One vertical Pexels clip for the query (HD, not huge, 4 s or more), not one already used in this ad."""
    key = keystore.get_key(user_id, "pexels")
    if not key:
        raise TwinError("Falta tu clave de Pexels")
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.get(f"{PEXELS}/videos/search", params={"query": query, "orientation": "portrait", "per_page": 10, "size": "medium"}, headers={"Authorization": key})
    if r.status_code != 200:
        raise TwinError(f"Pexels respondió {r.status_code}")
    for v in r.json().get("videos") or []:
        if v.get("id") in used or (v.get("duration") or 0) < 4:
            continue
        files = sorted([f for f in v.get("video_files") or [] if f.get("file_type") == "video/mp4" and (f.get("height") or 0) >= 1000 and (f.get("height") or 0) <= 2000],
                       key=lambda f: f.get("height") or 0)
        if files:
            used.add(v["id"])
            return {"id": v["id"], "url": files[0]["link"], "duration": v.get("duration"), "author": (v.get("user") or {}).get("name") or "Pexels", "page": v.get("url")}
    return None


async def download(url: str, out: Path) -> Path:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as cx, cx.stream("GET", url, timeout=600) as r:
        r.raise_for_status()
        with out.open("wb") as f:
            async for chunk in r.aiter_bytes(1 << 20):
                f.write(chunk)
    return out


def footage_dir(user_id: str) -> Path:
    d = user_dir(user_id) / "twin-upload"
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)
    return d


def words(text: str) -> int:
    return len(re.findall(r"\w+", text or ""))


def public(user_id: str) -> dict:
    t = get(user_id)
    return {"twin": {k: t.get(k) for k in ("name", "status", "step", "consent_url", "consent_status", "error", "working", "updated")} if t else None,
            "keys": keys(user_id), "engine": media.available()}

