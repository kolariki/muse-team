"""The Ad Studio: the user uploads their own videos and images, and a team of five agents turns them into a finished ad.

1. Listener: transcribes every video (Meta Muse Voice Transcribe) and writes down what is said, the tone and the best
   moments with their times.
2. Director: reads all that, looks at frames of every video and at the images, and writes the edit plan: which moments, in
   what order, where each image goes, the hook, the subtitles, the transitions, the colours and the call to action.
3. Editor: turns the plan into the edit (backend/video/src/Studio.tsx) and renders a first cut.
4. Finisher: watches the cut (frames of the render) and improves the plan: pacing, the hook, what to cut, titles, images.
5. Approver: watches the improved cut and approves it or sends it back to the finisher with what to fix, until it approves
   (at most MAX_ROUNDS rounds). Then the final ad is rendered in vertical 9:16 and square 1:1.

Everything lives in <user>/studio/<project>/: project.json, media/ (uploads and their normalised copies), work/ (audio,
frames) and renders/. The project's timeline is what the UI shows, agent by agent.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import shutil
import time
from pathlib import Path

from .auth import User, user_dir
from .providers import PROVIDERS, CallResult, stream
from . import ads as adsmod
from . import keystore
from . import media
from . import transcribe as stt

log = logging.getLogger("arena.studio")

MAX_FILES = 16
MAX_VIDEO_MB = 500
MAX_IMAGE_MB = 20
MAX_MINUTES = 8
MAX_ROUNDS = 3
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".heic")
AGENTS = [
    {"id": "listen", "es": "Escucha", "en": "Listener", "role_es": "transcribe y encuentra los mejores momentos", "role_en": "transcribes and finds the best moments"},
    {"id": "plan", "es": "Director", "en": "Director", "role_es": "mira todo y arma el plan de edición", "role_en": "watches everything and writes the edit plan"},
    {"id": "edit", "es": "Editor", "en": "Editor", "role_es": "arma el video", "role_en": "cuts the video"},
    {"id": "improve", "es": "Post-producción", "en": "Finisher", "role_es": "mira el corte y lo mejora", "role_en": "watches the cut and improves it"},
    {"id": "review", "es": "Aprobación", "en": "Approver", "role_es": "revisa todo y aprueba o lo devuelve", "role_en": "reviews it all and approves or sends it back"},
]
VISION = ("meta", "anthropic", "openai", "gemini", "xai", "openrouter")
_running: dict[str, asyncio.Task] = {}


# ------------------------------------------------------------------------------------------------------------ storage

def root(user_id: str) -> Path:
    d = user_dir(user_id) / "studio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def folder(user_id: str, pid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", pid):
        raise ValueError("Proyecto inválido")
    return root(user_id) / pid


def load(user_id: str, pid: str) -> dict | None:
    p = folder(user_id, pid) / "project.json"
    try:
        return json.loads(p.read_text()) if p.exists() else None
    except (OSError, ValueError):
        return None


def save(user_id: str, proj: dict) -> dict:
    proj["updated"] = time.time()
    p = folder(user_id, proj["id"]) / "project.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(proj, ensure_ascii=False, indent=1))
    tmp.replace(p)
    return proj


def update(user_id: str, pid: str, **fields) -> dict:
    proj = load(user_id, pid) or {}
    proj.update(fields)
    return save(user_id, proj)


def listing(user_id: str) -> list[dict]:
    out = []
    for d in root(user_id).iterdir():
        p = load(user_id, d.name) if re.fullmatch(r"[a-f0-9]{12}", d.name) else None
        if p:
            out.append(public(p, brief=True))
    return sorted(out, key=lambda x: -x["created"])


def public(p: dict, brief: bool = False) -> dict:
    keep = ("id", "title", "created", "updated", "status", "stage", "error", "round", "version", "final", "preview", "goal", "link", "instructions", "language")
    out = {k: p.get(k) for k in keep}
    out["media"] = [{k: m.get(k) for k in ("id", "name", "kind", "duration", "width", "height", "audio", "thumb")} for m in p.get("media", [])]
    if not brief:
        out["timeline"] = p.get("timeline", [])
        out["agents"] = p.get("agents", {})
        out["plan"] = p.get("plan")
        out["transcript"] = p.get("transcript")
    out["running"] = p["id"] in _running
    return out


def create(user: User, title: str, instructions: str, link: str, goal: str, language: str) -> dict:
    pid = secrets.token_hex(6)
    for sub in ("media", "work", "renders"):
        (folder(user.id, pid) / sub).mkdir(parents=True, exist_ok=True)
    return save(user.id, {"id": pid, "title": title[:80] or "Anuncio", "instructions": instructions[:2000], "link": link[:300], "goal": goal if goal in ("sell", "awareness", "signup") else "sell",
                          "language": language or "español rioplatense", "created": time.time(), "status": "draft", "stage": "", "media": [], "timeline": [], "agents": {}, "round": 0, "version": 0})


def remove(user_id: str, pid: str) -> None:
    t = _running.pop(pid, None)
    if t:
        t.cancel()
    shutil.rmtree(folder(user_id, pid), ignore_errors=True)


async def add_media(user: User, pid: str, name: str, chunks) -> dict:
    """Save an upload (video or image), probe it and make its thumbnail."""
    proj = load(user.id, pid)
    if not proj:
        raise ValueError("Proyecto no encontrado")
    if pid in _running:
        raise ValueError("El equipo está trabajando: esperá a que termine para sumar archivos")
    if len(proj["media"]) >= MAX_FILES:
        raise ValueError(f"Hasta {MAX_FILES} archivos por anuncio")
    ext = Path(name).suffix.lower()
    kind = "video" if ext in VIDEO_EXT else "image" if ext in IMAGE_EXT else None
    if not kind:
        raise ValueError("Formato no soportado: subí videos (mp4, mov, webm) o imágenes (jpg, png, webp)")
    mid = f"m{secrets.token_hex(3)}"
    d = folder(user.id, pid) / "media"
    raw = d / f"{mid}-raw{ext}"
    limit = (MAX_VIDEO_MB if kind == "video" else MAX_IMAGE_MB) * 1024 * 1024
    size = 0
    with raw.open("wb") as f:
        async for chunk in chunks:
            size += len(chunk)
            if size > limit:
                f.close()
                raw.unlink(missing_ok=True)
                raise ValueError(f"El archivo supera {limit // (1024 * 1024)} MB")
            f.write(chunk)
    item = {"id": mid, "name": Path(name).name[:120], "kind": kind, "raw": raw.name, "size": size}
    try:
        if kind == "video":
            info = await asyncio.to_thread(media.probe, raw)
            if info["duration"] <= 0:
                raise ValueError("No se pudo leer el video")
            total = sum(m.get("duration") or 0 for m in proj["media"] if m["kind"] == "video") + info["duration"]
            if total > MAX_MINUTES * 60:
                raise ValueError(f"Entre todos los videos, hasta {MAX_MINUTES} minutos")
            await asyncio.to_thread(media.thumb, raw, d / f"{mid}-thumb.jpg", min(1.0, info["duration"] / 2))
            item.update(duration=round(info["duration"], 2), width=info["width"], height=info["height"], audio=info["audio"], thumb=f"{mid}-thumb.jpg")
        else:
            from PIL import Image, ImageOps

            def norm() -> tuple[int, int]:
                im = ImageOps.exif_transpose(Image.open(raw)).convert("RGB")
                im.thumbnail((2160, 2160))
                im.save(d / f"{mid}.jpg", "JPEG", quality=90)
                t = im.copy()
                t.thumbnail((360, 360))
                t.save(d / f"{mid}-thumb.jpg", "JPEG", quality=80)
                return im.size
            w, h = await asyncio.to_thread(norm)
            item.update(file=f"{mid}.jpg", width=w, height=h, thumb=f"{mid}-thumb.jpg")
    except ValueError:
        raw.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001
        raw.unlink(missing_ok=True)
        raise ValueError(f"No se pudo leer el archivo: {e}") from e
    proj = load(user.id, pid) or proj
    proj["media"].append(item)
    save(user.id, proj)
    return item


def remove_media(user_id: str, pid: str, mid: str) -> dict:
    proj = load(user_id, pid)
    if not proj:
        raise ValueError("Proyecto no encontrado")
    if pid in _running:
        raise ValueError("El equipo está trabajando: esperá a que termine")
    for f in (folder(user_id, pid) / "media").glob(f"{re.sub(r'[^\w]', '', mid)}*"):
        f.unlink(missing_ok=True)
    proj["media"] = [m for m in proj["media"] if m["id"] != mid]
    return save(user_id, proj)


def file_for(user_id: str, pid: str, name: str) -> Path | None:
    """A thumbnail, an upload's normalised copy or a render, by its plain name."""
    if not re.fullmatch(r"([\w-]+/)?[\w-]+\.(jpg|mp4)", name):
        return None
    d = folder(user_id, pid)
    for sub in ("media", "renders"):
        p = (d / sub / name).resolve()
        if p.exists() and (d / sub).resolve() in p.parents:
            return p
    return None


# ------------------------------------------------------------------------------------------------------------ models

def _who(user_id: str, vision: bool) -> list[tuple[str, str, object]]:
    creds = keystore.creds(user_id)
    order = VISION if vision else adsmod.WRITERS
    return [(pid, creds[pid].model or PROVIDERS[pid].default_model, creds[pid]) for pid in order if creds.get(pid) and creds[pid].source != "none" and PROVIDERS.get(pid)]


REPAIR_SYSTEM = """Convertí la respuesta que te paso al objeto JSON que pide el formato. Respondé SOLO el JSON, completo y válido, sin texto
alrededor ni bloques de código. Si a la respuesta le falta algo que el formato pide, completalo con lo más razonable según la misma respuesta."""


async def _call(pid: str, model: str, cred, system: str, msg: str, images: list[bytes] | None, max_tokens: int) -> str:
    buf: list[str] = []
    async for kind, delta in stream(pid, model, system, msg, temperature=0.5, max_tokens=max_tokens, result=CallResult(), cred=cred, images=images or None):  # type: ignore[arg-type]
        if kind == "text":
            buf.append(delta)
    return "".join(buf)


async def ask(user_id: str, system: str, msg: str, images: list[bytes] | None = None, max_tokens: int = 8000) -> tuple[dict, str]:
    """A JSON answer from the team's model; with images, the first model that can look at them (Muse first). When the answer
    is not JSON (cut short, or prose), the same model turns it into the requested JSON before trying another model."""
    tried = []
    for pid, model, cred in _who(user_id, bool(images)):
        try:
            text = await _call(pid, model, cred, system, msg, images, max_tokens)
            data = adsmod._json(text)
            if not data:
                log.warning("studio model %s answered without JSON (%d chars): %r … %r", pid, len(text), text[:400], text[-200:])
                fmt = system[system.find("Respondé SOLO"):] if "Respondé SOLO" in system else "el JSON pedido"
                text = await _call(pid, model, cred, REPAIR_SYSTEM, f"FORMATO PEDIDO:\n{fmt}\n\nRESPUESTA A CONVERTIR:\n{text[-12000:] or '(vacía: armala de cero con el formato y este pedido)'}\n\nPEDIDO ORIGINAL:\n{msg[:6000]}", None, max_tokens)
                data = adsmod._json(text)
            if data:
                return data, f"{PROVIDERS[pid].label} · {model}"
            log.warning("studio model %s repair without JSON: %r", pid, text[:400])
            tried.append(f"{pid}: respuesta sin JSON")
        except Exception as e:  # noqa: BLE001
            log.warning("studio model %s failed: %s", pid, e)
            tried.append(f"{pid}: {str(e)[:120]}")
    raise RuntimeError("Ningún modelo pudo hacer este paso. " + ("Agregá una clave de Meta Muse (u otro modelo con visión) en Configuración." if not tried else "; ".join(tried)))


# ------------------------------------------------------------------------------------------------------------ timeline

def _say(user_id: str, pid: str, agent: str, text: str, kind: str = "note", data: dict | None = None, rnd: int | None = None) -> None:
    proj = load(user_id, pid) or {}
    proj.setdefault("timeline", []).append({"agent": agent, "text": text, "kind": kind, "data": data or {}, "round": rnd if rnd is not None else proj.get("round", 0), "ts": time.time()})
    save(user_id, proj)


def _agent(user_id: str, pid: str, agent: str, status: str, by: str | None = None) -> None:
    proj = load(user_id, pid) or {}
    a = proj.setdefault("agents", {}).setdefault(agent, {})
    a["status"] = status
    if by:
        a["by"] = by
    proj["stage"] = agent if status == "working" else proj.get("stage")
    save(user_id, proj)


# ------------------------------------------------------------------------------------------------------------ prompts

LISTEN_SYSTEM = """Sos el/la guionista del equipo de video. Escuchaste (transcripción con tiempos) los videos que subió el usuario para hacer un anuncio.
Escribí qué se dice, el tono, y elegí los MEJORES MOMENTOS para un anuncio de 15-35 segundos: frases que enganchan, muestran el
producto o el resultado, o generan confianza. Cada momento con su video, inicio y fin en segundos (que empiece y termine en frase
completa) y por qué sirve. Ordenalos del más fuerte al más débil. Escribí en {lang}.

Respondé SOLO JSON: {{"summary": "", "tone": "", "highlights": [{{"video": "m1", "start": 0.0, "end": 0.0, "quote": "", "why": "", "score": 1}}], "hooks": [""], "cta_idea": ""}}"""

PLAN_SYSTEM = """Sos el/la director/a creativo/a. Armás el plan de edición de un anuncio en video para Meta (Reels, Stories y feed) con el material
REAL que subió el usuario: sus videos (te paso cuadros de cada uno con su segundo, y la transcripción) y sus imágenes.

Reglas de un anuncio que rinde:
- Lo más fuerte en los primeros 2 segundos (el gancho): un momento potente del video o un título sobre la mejor imagen.
- 15 a 35 segundos en total. Cortá silencios y relleno: cada momento de video entre 2 y 8 segundos, empezando y terminando en frase completa.
- Usá los mejores momentos que encontró el/la guionista; intercalá las imágenes donde ilustran lo que se dice.
- Títulos cortos (máx. 7 palabras) sobre los planos clave; subtítulos de lo que se dice siempre visibles (la mayoría mira sin sonido).
- Cerrá con el llamado a la acción. No inventes datos, precios ni promesas que no estén en el material o el pedido.
- Para un video horizontal en formato vertical usá fit "contain" (va sobre una copia desenfocada); si ya es vertical, "cover".
- Escribí todo en {lang}.

Respondé SOLO JSON:
{{"angle": "el ángulo en 3-6 palabras", "name": "marca o producto (máx. 22)", "palette": {{"bg": "#RRGGBB", "accent": "#RRGGBB"}}, "font": "grotesk|serif|rounded",
"fx": "rise|pop|box", "transition": "cut|whip|zoom", "subtitles": {{"style": "karaoke|box|clean", "position": "bottom|center"}},
"sequence": [{{"type": "video", "media": "m1", "from": 0.0, "to": 0.0, "title": "", "emphasis": "", "zoom": "in|out|none", "fit": "cover|contain"}},
             {{"type": "image", "media": "m2", "d": 2.5, "title": "", "sub": "", "motion": "in|out|left|right"}},
             {{"type": "title", "d": 2.0, "text": "", "sub": "", "emphasis": ""}}],
"cta": {{"text": "botón de 2-3 palabras", "sub": "una línea o vacío"}}, "why": "por qué este corte, en 2 frases"}}"""

IMPROVE_SYSTEM = """Sos el/la editor/a de post-producción. Te paso cuadros del corte actual del anuncio (uno cada ~1,5 s, en orden), su plan de edición,
los mejores momentos del material y, si la hay, la devolución de quien aprueba. Mirá el video como lo vería alguien en Reels y mejoralo:
el gancho de los primeros 2 segundos, el ritmo (que nada sobre), que los títulos se lean y no tapen caras, que las imágenes sumen, que el
cierre invite a actuar. Si hay devolución, resolvé TODO lo que pide. Mantené las reglas: 15-35 s, nada inventado, todo en {lang}.

Respondé SOLO JSON: {{"notes": ["qué cambiaste y por qué, una frase por cambio"], "plan": <el plan completo revisado, con el mismo formato>}}"""

REVIEW_SYSTEM = """Sos quien aprueba los anuncios antes de publicarlos. Te paso cuadros del corte final (uno cada ~1,5 s, en orden), el plan y el pedido del usuario.
Evaluá con criterio de performance en Meta: ¿engancha en 2 s? ¿se entiende sin sonido? ¿los textos se leen y están dentro de la zona
segura? ¿el ritmo es bueno? ¿muestra lo que el usuario quiere anunciar? ¿el cierre es claro? ¿hay algo roto (cuadros negros, texto
cortado, imágenes deformadas)? Aprobá solo si está listo para publicar. Si no, decí exactamente qué arreglar. Escribí en {lang}.

Respondé SOLO JSON: {{"approved": true, "score": 8, "strengths": [""], "fix": ["qué arreglar, concreto"]}}"""


# ------------------------------------------------------------------------------------------------------------ plan → edit

def _num(v, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def clean_plan(raw: dict, proj: dict) -> dict:
    """The plan with valid media, times inside each video and a sane length."""
    by_id = {m["id"]: m for m in proj["media"]}
    seq, total = [], 0.0
    for it in raw.get("sequence") or []:
        if not isinstance(it, dict) or total >= 45:
            continue
        kind = it.get("type")
        m = by_id.get(str(it.get("media") or ""))
        if kind == "video" and m and m["kind"] == "video":
            dur = m.get("duration") or 0
            a = _num(it.get("from"), 0, max(0, dur - 0.5), 0)
            b = _num(it.get("to"), a + 0.8, dur, min(dur, a + 4))
            if b - a < 0.8:
                continue
            seq.append({"type": "video", "media": m["id"], "from": round(a, 2), "to": round(min(b, a + 12), 2), "title": adsmod._cut(it.get("title"), 60), "emphasis": adsmod._cut(it.get("emphasis"), 30),
                        "zoom": it.get("zoom") if it.get("zoom") in ("in", "out", "none") else "none", "fit": it.get("fit") if it.get("fit") in ("cover", "contain") else ("cover" if (m.get("height") or 0) >= (m.get("width") or 1) else "contain")})
            total += seq[-1]["to"] - seq[-1]["from"]
        elif kind == "image" and m and m["kind"] == "image":
            seq.append({"type": "image", "media": m["id"], "d": round(_num(it.get("d"), 1.2, 5, 2.5), 2), "title": adsmod._cut(it.get("title"), 60), "sub": adsmod._cut(it.get("sub"), 80),
                        "motion": it.get("motion") if it.get("motion") in ("in", "out", "left", "right") else "in"})
            total += seq[-1]["d"]
        elif kind == "title" and str(it.get("text") or "").strip():
            seq.append({"type": "title", "d": round(_num(it.get("d"), 1.2, 4, 2), 2), "text": adsmod._cut(it.get("text"), 70), "sub": adsmod._cut(it.get("sub"), 90), "emphasis": adsmod._cut(it.get("emphasis"), 30)})
            total += seq[-1]["d"]
    if not seq:  # nothing usable: every upload in order
        for m in proj["media"][:8]:
            seq.append({"type": "video", "media": m["id"], "from": 0, "to": round(min(6, m.get("duration") or 3), 2), "title": "", "emphasis": "", "zoom": "none", "fit": "contain"} if m["kind"] == "video"
                       else {"type": "image", "media": m["id"], "d": 2.5, "title": "", "sub": "", "motion": "in"})
    pal = raw.get("palette") if isinstance(raw.get("palette"), dict) else {}
    subs = raw.get("subtitles") if isinstance(raw.get("subtitles"), dict) else {}
    cta = raw.get("cta") if isinstance(raw.get("cta"), dict) else {}
    return {"angle": adsmod._cut(raw.get("angle"), 60), "name": adsmod._cut(raw.get("name") or proj["title"], 22),
            "palette": adsmod.palette({"bg": pal.get("bg"), "accent": pal.get("accent")}), "font": raw.get("font") if raw.get("font") in adsmod.FONTS else "grotesk",
            "fx": raw.get("fx") if raw.get("fx") in ("rise", "pop", "box") else "rise", "transition": raw.get("transition") if raw.get("transition") in ("cut", "whip", "zoom") else "whip",
            "subtitles": {"style": subs.get("style") if subs.get("style") in ("karaoke", "box", "clean") else "karaoke", "position": subs.get("position") if subs.get("position") in ("bottom", "center") else "bottom"},
            "sequence": seq, "cta": {"text": adsmod._cut(cta.get("text") or "Más info", 24), "sub": adsmod._cut(cta.get("sub"), 60)}, "why": adsmod._cut(raw.get("why"), 400)}


def _words(transcript: dict, mid: str, a: float, b: float) -> list[dict]:
    out = []
    for seg in transcript.get(mid) or []:
        for w in seg.get("words") or []:
            if a - 0.05 <= w["t"] < b:
                out.append({"w": w["w"], "t": round(w["t"] - a, 2), "d": w["d"]})
    return out


def props(proj: dict, plan: dict, fmt: str) -> dict:
    by_id = {m["id"]: m for m in proj["media"]}
    clips = []
    for it in plan["sequence"]:
        m = by_id.get(it.get("media", ""))
        if it["type"] == "video" and m:
            clips.append({"kind": "video", "src": f"media:{m['id']}.mp4", "from": it["from"], "to": it["to"], "words": _words(proj.get("transcript") or {}, m["id"], it["from"], it["to"]),
                          "title": it.get("title") or None, "emphasis": it.get("emphasis") or "", "zoom": it.get("zoom", "none"), "fit": "cover" if fmt == "square" and it.get("fit") == "cover" else it.get("fit", "contain")})
        elif it["type"] == "image" and m:
            clips.append({"kind": "image", "src": f"media:{m['file']}", "d": it["d"], "title": it.get("title") or None, "sub": it.get("sub") or None, "motion": it.get("motion", "in")})
        elif it["type"] == "title":
            clips.append({"kind": "title", "d": it["d"], "text": it["text"], "sub": it.get("sub") or None, "emphasis": it.get("emphasis") or ""})
    url = re.sub(r"^https?://", "", proj.get("link") or "").rstrip("/")
    return {"name": plan["name"], "url": url, "palette": plan["palette"], "font": plan["font"], "fx": plan["fx"], "transition": plan["transition"],
            "subtitles": plan["subtitles"], "clips": clips, "cta": plan["cta"]}


async def render(user: User, proj: dict, plan: dict, preview: bool, tag: str) -> dict:
    """A cut (vertical at half size) or the final ad (both formats). Returns {format: seconds}."""
    out = folder(user.id, proj["id"]) / "renders" / tag
    out.mkdir(parents=True, exist_ok=True)
    formats = ["vertical"] if preview else ["vertical", "square"]
    seconds = {}
    async with adsmod._render_lock:
        for fmt in formats:
            seconds.update(await adsmod.render_job({"composition": "Studio", "props": props(proj, plan, fmt), "out": str(out), "formats": [fmt],
                                                    "media": str(folder(user.id, proj["id"]) / "media"), "scale": 0.5 if preview else 1, "still": not preview}))
    return seconds


def _frames(user_id: str, pid: str, video: Path, tag: str) -> list[bytes]:
    dur = media.probe(video)["duration"]
    shots = media.frames(video, folder(user_id, pid) / "work" / f"look-{tag}", every=max(1.2, dur / 16), limit=16, width=360)
    return [p.read_bytes() for _, p in shots]


# ------------------------------------------------------------------------------------------------------------ pipeline

def run(user: User, pid: str) -> dict:
    from .tasks import spawn

    proj = load(user.id, pid)
    if not proj:
        raise ValueError("Proyecto no encontrado")
    if pid in _running:
        raise ValueError("El equipo ya está trabajando en este anuncio")
    if not proj["media"]:
        raise ValueError("Subí al menos un video o una imagen")
    if not adsmod.engine_ready() or not media.available():
        raise ValueError("Este servidor no tiene el motor de video instalado")
    if not _who(user.id, False):
        raise ValueError("Hace falta una clave de modelo (Meta Muse recomendado) en Configuración para que el equipo trabaje")
    proj.update(status="running", stage="listen", error=None, timeline=[], agents={a["id"]: {"status": "waiting"} for a in AGENTS}, round=0)
    save(user.id, proj)
    _running[pid] = spawn(_pipeline(user, pid))  # type: ignore[assignment]
    return proj


def stop(user_id: str, pid: str) -> None:
    t = _running.pop(pid, None)
    if t:
        t.cancel()
    update(user_id, pid, status="stopped", stage="")


async def _pipeline(user: User, pid: str) -> None:
    uid = user.id
    en = (load(uid, pid) or {}).get("language", "").lower().startswith(("english", "inglés"))
    tx = (lambda es, e: e) if en else (lambda es, e: es)  # noqa: E731
    try:
        proj = load(uid, pid) or {}
        lang = proj.get("language") or "español rioplatense"
        mdir = folder(uid, pid) / "media"
        work = folder(uid, pid) / "work"

        # 1 · listener ---------------------------------------------------------------------------------------------
        _agent(uid, pid, "listen", "working")
        videos = [m for m in proj["media"] if m["kind"] == "video"]
        transcript, heard_by = {}, None
        prior = proj.get("transcript") or {}
        if proj.get("listen") and all(m["id"] in prior for m in videos if m.get("audio")):  # a retry: the listener already did its part
            transcript, heard_by = prior, proj.get("heard_by")
            videos = [m for m in videos if not (mdir / f"{m['id']}.mp4").exists()]
        for m in videos:
            dst = mdir / f"{m['id']}.mp4"
            if not dst.exists():
                _say(uid, pid, "listen", tx(f"Preparando «{m['name']}»", f"Preparing «{m['name']}»"), "step")
                await asyncio.to_thread(media.normalise, mdir / m["raw"], dst)
            if m.get("audio"):
                _say(uid, pid, "listen", tx(f"Escuchando «{m['name']}» ({round(m['duration'])} s)", f"Listening to «{m['name']}» ({round(m['duration'])} s)"), "step")
                try:
                    segs, heard_by = await stt.transcribe(uid, dst, work, lang)
                except Exception as e:  # noqa: BLE001
                    log.warning("transcribe %s: %s", m["id"], e)
                    segs = []
                    _say(uid, pid, "listen", tx(f"No pude transcribir «{m['name']}»: {str(e)[:160]}", f"Could not transcribe «{m['name']}»: {str(e)[:160]}"), "warn")
                transcript[m["id"]] = segs
        update(uid, pid, transcript=transcript, heard_by=heard_by)
        videos = [m for m in proj["media"] if m["kind"] == "video"]
        lines = "\n".join(f"[{mid} {s['start']:.1f}-{s['end']:.1f}] {s['text']}" for mid, segs in transcript.items() for s in segs)
        material = "\n".join(f"- {m['id']}: {'video' if m['kind'] == 'video' else 'imagen'} «{m['name']}»" + (f", {m['duration']} s, {m['width']}x{m['height']}, {'con' if m.get('audio') else 'sin'} sonido" if m["kind"] == "video" else f", {m['width']}x{m['height']}") for m in proj["media"])
        ask_ctx = f"PEDIDO DEL USUARIO: {proj.get('instructions') or '(sin pedido)'}\nOBJETIVO: {proj['goal']}\nLINK: {proj.get('link') or '(sin link)'}\nTÍTULO: {proj['title']}\n\nMATERIAL:\n{material}"
        if proj.get("listen") and transcript == prior and prior:
            listen, by = proj["listen"], proj.get("listen_by")
        elif lines:
            listen, by = await ask(uid, LISTEN_SYSTEM.format(lang=lang), f"{ask_ctx}\n\nTRANSCRIPCIÓN:\n{lines}")
        else:
            listen, by = {"summary": tx("Los videos no tienen voz (o no hay transcriptor): el anuncio se arma con lo que se ve.", "The videos have no voice (or there is no transcriber): the ad is built from what is on screen."), "highlights": []}, None
        update(uid, pid, listen=listen, listen_by=by)
        _agent(uid, pid, "listen", "done", heard_by or by)
        _say(uid, pid, "listen", listen.get("summary") or "", "result", {"highlights": (listen.get("highlights") or [])[:8], "tone": listen.get("tone"), "heard_by": heard_by})

        # 2 · director ---------------------------------------------------------------------------------------------
        _agent(uid, pid, "plan", "working")
        imgs: list[bytes] = []
        legend = []
        for m in videos:
            per = max(1.5, (m["duration"] or 1) / 8)
            for t, p in await asyncio.to_thread(media.frames, mdir / f"{m['id']}.mp4", work / f"frames-{m['id']}", per, 8, 448, "f"):
                if len(imgs) < 24:
                    imgs.append(p.read_bytes())
                    legend.append(f"imagen {len(imgs)}: video {m['id']} en el segundo {t}")
        for m in [x for x in proj["media"] if x["kind"] == "image"][:8]:
            from PIL import Image
            import io as _io

            im = Image.open(mdir / m["file"])
            im.thumbnail((512, 512))
            b = _io.BytesIO()
            im.save(b, "JPEG", quality=80)
            imgs.append(b.getvalue())
            legend.append(f"imagen {len(imgs)}: la imagen {m['id']} «{m['name']}»")
        msg = f"{ask_ctx}\n\nLO QUE ENCONTRÓ EL/LA GUIONISTA:\n{json.dumps(listen, ensure_ascii=False)}\n\nTRANSCRIPCIÓN:\n{lines or '(sin voz)'}\n\nLAS IMÁGENES QUE TE PASO, EN ORDEN:\n" + "\n".join(legend)
        raw, by = await ask(uid, PLAN_SYSTEM.format(lang=lang), msg, imgs, 3500)
        plan = clean_plan(raw, proj)
        update(uid, pid, plan=plan)
        _agent(uid, pid, "plan", "done", by)
        _say(uid, pid, "plan", plan.get("why") or plan.get("angle") or "", "result", {"plan": plan})

        # 3 · editor -----------------------------------------------------------------------------------------------
        _agent(uid, pid, "edit", "working")
        _say(uid, pid, "edit", tx("Armando el primer corte", "Cutting the first version"), "step")
        await render(user, load(uid, pid) or proj, plan, True, "cut-0")
        update(uid, pid, preview={"file": "cut-0/vertical.mp4", "round": 0, "ts": time.time()}, version=1)
        _agent(uid, pid, "edit", "done", "Remotion")
        _say(uid, pid, "edit", tx(f"Primer corte listo: {len(plan['sequence'])} planos.", f"First cut ready: {len(plan['sequence'])} shots."), "result", {"video": "cut-0/vertical.mp4"})

        # 4 ⇄ 5 · finisher and approver, until it is approved -------------------------------------------------------
        feedback: list[str] = []
        approved = False
        cut = "cut-0"
        for rnd in range(1, MAX_ROUNDS + 1):
            update(uid, pid, round=rnd)
            _agent(uid, pid, "improve", "working")
            frames = await asyncio.to_thread(_frames, uid, pid, folder(uid, pid) / "renders" / cut / "vertical.mp4", cut)
            msg = f"{ask_ctx}\n\nPLAN ACTUAL:\n{json.dumps(plan, ensure_ascii=False)}\n\nMEJORES MOMENTOS:\n{json.dumps(listen.get('highlights') or [], ensure_ascii=False)}\n\nTRANSCRIPCIÓN:\n{lines or '(sin voz)'}" + (f"\n\nDEVOLUCIÓN DE QUIEN APRUEBA (resolvé todo):\n- " + "\n- ".join(feedback) if feedback else "")
            raw, by = await ask(uid, IMPROVE_SYSTEM.format(lang=lang), msg, frames, 3500)
            if isinstance(raw.get("plan"), dict) and raw["plan"].get("sequence"):
                plan = clean_plan(raw["plan"], load(uid, pid) or proj)
            notes = [adsmod._cut(n, 200) for n in raw.get("notes") or [] if str(n).strip()][:8]
            cut = f"cut-{rnd}"
            _say(uid, pid, "improve", tx("Mejoras: ", "Improvements: ") + ("; ".join(notes) if notes else tx("ajustes de ritmo y textos", "pacing and copy tweaks")), "result", {"notes": notes}, rnd)
            await render(user, load(uid, pid) or proj, plan, True, cut)
            update(uid, pid, plan=plan, preview={"file": f"{cut}/vertical.mp4", "round": rnd, "ts": time.time()}, version=rnd + 1)
            _agent(uid, pid, "improve", "done", by)

            _agent(uid, pid, "review", "working")
            frames = await asyncio.to_thread(_frames, uid, pid, folder(uid, pid) / "renders" / cut / "vertical.mp4", f"{cut}-r")
            rev, by = await ask(uid, REVIEW_SYSTEM.format(lang=lang), f"{ask_ctx}\n\nPLAN:\n{json.dumps(plan, ensure_ascii=False)}", frames, 1500)
            score = _num(rev.get("score"), 0, 10, 0)
            approved = bool(rev.get("approved")) and score >= 7
            feedback = [adsmod._cut(f, 220) for f in rev.get("fix") or [] if str(f).strip()][:8]
            _agent(uid, pid, "review", "done" if approved else "returned", by)
            _say(uid, pid, "review", (tx(f"Aprobado ({score:g}/10).", f"Approved ({score:g}/10).") if approved else tx(f"Lo devuelvo ({score:g}/10): ", f"Sent back ({score:g}/10): ") + "; ".join(feedback)),
                 "verdict", {"approved": approved, "score": score, "strengths": rev.get("strengths") or [], "fix": feedback}, rnd)
            if approved:
                break
        if not approved:
            _say(uid, pid, "review", tx(f"Después de {MAX_ROUNDS} vueltas sigo viendo cosas para mejorar: lo dejo listo con estas observaciones y podés pedir otra vuelta.",
                                        f"After {MAX_ROUNDS} rounds there is still room to improve: it is ready with these notes and you can ask for another round."), "warn")

        # final ------------------------------------------------------------------------------------------------------
        _say(uid, pid, "edit", tx("Exportando el anuncio en vertical (Reels, Stories) y cuadrado (feed)", "Exporting the ad vertical (Reels, Stories) and square (feed)"), "step")
        secs = await render(user, load(uid, pid) or proj, plan, False, "final")
        update(uid, pid, status="done", stage="", final={"vertical": "final/vertical.mp4", "square": "final/square.mp4", "seconds": secs, "approved": approved, "ts": time.time()})
        _say(uid, pid, "edit", tx("Anuncio listo.", "Ad ready."), "done")
    except asyncio.CancelledError:
        update(uid, pid, status="stopped", stage="")
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("studio %s", pid)
        proj = load(uid, pid) or {}
        for a in (proj.get("agents") or {}).values():
            if a.get("status") == "working":
                a["status"] = "error"
        proj.update(status="error", stage="", error=str(e)[:600])
        save(uid, proj)
    finally:
        _running.pop(pid, None)


def recover(user_id: str, pid: str) -> dict | None:
    p = load(user_id, pid)
    if p and p.get("status") == "running" and pid not in _running:
        p = update(user_id, pid, status="error", stage="", error="Se cortó porque el servidor se reinició: probá de nuevo.")
    return p
