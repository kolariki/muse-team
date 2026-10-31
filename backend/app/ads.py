"""Video ads for the app the team built, ready for Meta Ads.

One click in the «Anuncios» pane:
1. capture: the product's real screens with headless Chrome — the published app when it is live, otherwise the approved
   design (design/mockup.html) or the prototype (preview/index.html);
2. script: a model (Meta Muse first) writes the ad from the brief and what is on those screens — the hook, three benefits,
   a caption per screen, the call to action, the palette and the Meta copy (primary text, headline, description, CTA);
   without a model key a plain script is made from the brief, so the pane always works;
3. render: the Remotion composition in backend/video turns the script into two MP4s, vertical 9:16 (Reels, Stories) and
   square 1:1 (feed), each with its cover JPG. One render at a time per server: it takes the whole CPU.

Everything lives in <user>/ads/<build_id>/: ads.json (the list) and one folder per ad (screens, videos, covers).
Publishing to Meta Ads is meta_ads.py.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import secrets
import shutil
import sys
import tempfile
import time
from pathlib import Path

from .auth import User, user_dir
from .config import env
from .providers import PROVIDERS, CallResult, Cred, stream
from . import cloud as cloudmod
from . import keystore
from . import research as rsch

log = logging.getLogger("arena.ads")

VIDEO_DIR = Path(__file__).resolve().parents[1] / "video"
FORMATS = ("vertical", "square")
CTA_TYPES = ("LEARN_MORE", "SIGN_UP", "SHOP_NOW", "BOOK_NOW", "GET_OFFER", "SUBSCRIBE", "DOWNLOAD", "CONTACT_US", "ORDER_NOW", "APPLY_NOW")
WRITERS = ("meta", "anthropic", "openai", "gemini", "xai", "openrouter", "deepseek", "mistral", "kimi", "groq", "baseten")
FONTS = ("grotesk", "serif", "rounded")
MAX_ADS = 12
DEFAULT_PALETTE = {"bg": "#10161F", "surface": "#1B2430", "ink": "#F1F4F8", "muted": "#A9B4C2", "accent": "#F5A524", "accentInk": "#10161F"}

_render_lock = asyncio.Lock()
_running: dict[str, asyncio.Task] = {}  # ad id → its job


# ------------------------------------------------------------------------------------------------------------ storage

def folder(user_id: str, build_id: str) -> Path:
    d = user_dir(user_id) / "ads" / re.sub(r"[^\w-]", "", build_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def load(user_id: str, build_id: str) -> list[dict]:
    p = folder(user_id, build_id) / "ads.json"
    try:
        return json.loads(p.read_text()) if p.exists() else []
    except (OSError, ValueError):
        return []


def _save(user_id: str, build_id: str, ads: list[dict]) -> None:
    p = folder(user_id, build_id) / "ads.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(ads, ensure_ascii=False, indent=1))
    tmp.replace(p)


def get(user_id: str, build_id: str, ad_id: str) -> dict | None:
    return next((a for a in load(user_id, build_id) if a["id"] == ad_id), None)


def _update(user_id: str, build_id: str, ad_id: str, **fields) -> dict | None:
    ads = load(user_id, build_id)
    for a in ads:
        if a["id"] == ad_id:
            a.update(fields)
            a["updated"] = time.time()
            _save(user_id, build_id, ads)
            return a
    return None


def file_for(user_id: str, build_id: str, ad_id: str, name: str) -> Path | None:
    """A video or cover of an ad (`vertical.mp4`, `square.jpg`…), only those names."""
    if not re.fullmatch(r"[a-f0-9]{12}", ad_id) or not re.fullmatch(r"(vertical|square)\.(mp4|jpg)|screen-\d\.jpg", name):
        return None
    p = folder(user_id, build_id) / ad_id / name
    return p if p.exists() else None


def remove(user_id: str, build_id: str, ad_id: str) -> None:
    t = _running.pop(ad_id, None)
    if t:
        t.cancel()
    _save(user_id, build_id, [a for a in load(user_id, build_id) if a["id"] != ad_id])
    shutil.rmtree(folder(user_id, build_id) / re.sub(r"[^a-f0-9]", "", ad_id), ignore_errors=True)


def public(ad: dict) -> dict:
    """What the pane gets: everything but the screens' local paths."""
    return {k: v for k, v in ad.items() if k not in ("screens",)} | {"screens": [{"kind": s["kind"], "caption": s.get("caption", "")} for s in ad.get("screens", [])]}


# ------------------------------------------------------------------------------------------------------------ capture

def _files(b) -> dict[str, str]:
    """The project's files, with the approved mockup even when it only lives on the build (design stage of an engine build)."""
    files = dict(b.files)
    if not files.get("design/mockup.html") and getattr(b, "design_html", None):
        files["design/mockup.html"] = b.design_html
    return files


def source_for(user: User, b) -> dict:
    """Where the screens come from: the live app, else the design mockup, else the prototype."""
    app_ = cloudmod.get_app(user.id, b.id) or {}
    if app_.get("status") == "live" and app_.get("url"):
        return {"kind": "live", "url": app_["url"], "label": app_["url"]}
    files = _files(b)
    for path, label in (("design/mockup.html", "design"), ("preview/index.html", "preview")):
        if isinstance(files.get(path), str) and files[path].strip():
            return {"kind": label, "path": path, "label": path}
    return {"kind": "none"}


def _shot(chrome: str, url: str, size: tuple[int, int], out: Path, tmp: str, mobile: bool) -> bytes | None:
    cmd = [chrome, "--headless=new", "--no-sandbox", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
           "--virtual-time-budget=12000", "--timeout=30000", f"--user-data-dir={tmp}/{out.stem}", f"--window-size={size[0]},{size[1]}",
           "--force-device-scale-factor=2", f"--screenshot={out}"]
    if mobile:
        cmd.append("--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    rsch._run_for_file(cmd + [url], out, rsch.SHOT_TIMEOUT)
    return out.read_bytes() if out.exists() and out.stat().st_size > 2000 else None


def _jpeg(png: bytes, width: int, max_ratio: float) -> tuple[bytes, float, str]:
    """Scaled to the width the video uses, cropped to a sane height, as JPEG; returns (bytes, height/width, page colour)."""
    from PIL import Image, ImageChops

    im = Image.open(io.BytesIO(png)).convert("RGB")
    # the empty page below the content (a short page in a tall window) would scroll the phone into a blank screen
    bg = im.getpixel((im.width - 1, im.height - 1))
    box = ImageChops.difference(im, Image.new("RGB", im.size, bg)).convert("L").point(lambda x: 255 if x > 14 else 0).getbbox()
    if box and box[3] < im.height - 80:
        im = im.crop((0, 0, im.width, min(im.height, box[3] + 80)))
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    if im.height / im.width > max_ratio:
        im = im.crop((0, 0, im.width, round(im.width * max_ratio)))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=86, optimize=True)
    return buf.getvalue(), im.height / im.width, "#%02X%02X%02X" % bg[:3]


def capture(src: dict, files: dict[str, str], out: Path) -> tuple[list[dict], str]:
    """The phone and the desktop screens as JPGs in `out`, and the page's text (for the script)."""
    chrome = rsch.chrome_path()
    if not chrome or src["kind"] == "none":
        return [], ""
    with tempfile.TemporaryDirectory(prefix="tably-ad-") as tmp:
        if src["kind"] == "live":
            url, tall = src["url"], 932
        else:  # the mockup or the prototype, written next to its tokens so relative links resolve
            for p in ("design/mockup.html", "design/tokens.css", "preview/index.html"):
                if isinstance(files.get(p), str):
                    (Path(tmp) / p).parent.mkdir(parents=True, exist_ok=True)
                    (Path(tmp) / p).write_text(files[p])
            url, tall = (Path(tmp) / src["path"]).as_uri(), 2200  # a mockup has no 100vh hero: the phone can scroll through it
        shots = []
        m = _shot(chrome, url, (430, tall), Path(tmp) / "m.png", tmp, True)
        if m:
            data, ratio, bg = _jpeg(m, 860, 4.4)
            (out / "screen-0.jpg").write_bytes(data)
            shots.append({"kind": "phone", "file": "screen-0.jpg", "ratio": ratio, "bg": bg})
        d = _shot(chrome, url, (1440, 900), Path(tmp) / "d.png", tmp, False)
        if d:
            data, ratio, bg = _jpeg(d, 1600, 0.9)
            (out / f"screen-{len(shots)}.jpg").write_bytes(data)
            shots.append({"kind": "desktop", "file": f"screen-{len(shots)}.jpg", "ratio": ratio, "bg": bg})
        text = ""
        code, dom = rsch._run([chrome, "--headless=new", "--no-sandbox", f"--user-data-dir={tmp}/dom", "--virtual-time-budget=8000", "--dump-dom", url], 40)
        if dom:
            cap = rsch.Capture(url=url)
            rsch._dom_summary(cap, dom)
            text = "\n".join(filter(None, [cap.title, " · ".join(cap.headings[:20]), " · ".join(cap.buttons[:20]), cap.text[:2500]]))
    return shots, text


# ------------------------------------------------------------------------------------------------------------ script

SCRIPT_SYSTEM = """Sos el/la creativo/a de performance de un equipo que lanza productos digitales. Escribís anuncios en video de 10-15 segundos
para Meta (Reels, Stories y feed de Instagram y Facebook) que la gente frena a mirar y que convierten: un gancho concreto en los
primeros 2 segundos, beneficios (no funciones), las pantallas reales del producto y un llamado a la acción claro.

Reglas:
- Hablale a la persona que tiene el problema, en su idioma y con sus palabras. Nada de clichés («revolucioná», «llevá al siguiente nivel»), nada de signos de exclamación en serie, nada de emojis.
- El gancho es una promesa o una tensión concreta del usuario, de máximo 8 palabras. `emphasis` son 1-2 palabras del gancho (copiadas tal cual) que se resaltan.
- `sub`: una línea (máx. 70 caracteres) que aterriza el gancho.
- `points`: exactamente 3 beneficios de máximo 5 palabras cada uno.
- `captions`: una frase corta (máx. 7 palabras) por cada pantalla que se muestra, en el orden dado, que diga qué logra el usuario ahí.
- `cta`: el botón (2-3 palabras). `cta_sub`: una línea que baja la fricción (precio, prueba, tiempo) SOLO si el brief lo respalda; si no, vacío.
- No inventes datos, precios, cifras ni testimonios que no estén en el brief o en las pantallas.
- `name`: el nombre corto del producto (el que aparece en las pantallas o el brief), máx. 22 caracteres.
- Paleta: tomala del diseño del producto si existe (tokens.css); si no, elegí una que encaje con el rubro. `bg` oscuro o claro, `ink` con contraste AA sobre `bg`, `accent` vivo y distinto del fondo, `accent_ink` legible sobre `accent`. Solo HEX #RRGGBB.
- `font`: grotesk (moderno, producto/tecnología), serif (editorial, premium, salud, belleza), rounded (amigable, familia, comida, niños).
- Copy de Meta: `primary_text` (máx. 125 caracteres, el texto arriba del video), `headline` (máx. 40), `description` (máx. 30), `cta_type` uno de: {ctas}.

Respondé SOLO un objeto JSON, sin texto alrededor:
{{"angle": "el ángulo creativo en 3-6 palabras", "name": "", "hook": "", "emphasis": "", "sub": "", "points": ["", "", ""], "captions": [], "cta": "", "cta_sub": "",
"font": "grotesk", "palette": {{"bg": "#", "surface": "#", "ink": "#", "muted": "#", "accent": "#", "accent_ink": "#"}},
"primary_text": "", "headline": "", "description": "", "cta_type": "LEARN_MORE"}}"""


def writer(user_id: str) -> tuple[str, str, Cred] | None:
    """The model that writes the ad: Meta Muse when there is a key, else the first configured one."""
    creds = keystore.creds(user_id)
    for pid in WRITERS:
        c = creds.get(pid)
        if c and c.source != "none" and PROVIDERS.get(pid):
            return pid, c.model or PROVIDERS[pid].default_model, c
    return None


def _hex(v, fallback: str) -> str:
    return v.upper() if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v.strip()) else fallback


def _lum(h: str) -> float:
    def ch(x: int) -> float:
        c = x / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def palette(raw) -> dict:
    """The script's palette, kept only where it reads well: text AA on the background, the button's text on the accent."""
    raw = raw if isinstance(raw, dict) else {}
    p = {"bg": _hex(raw.get("bg"), DEFAULT_PALETTE["bg"]), "surface": _hex(raw.get("surface"), ""), "ink": _hex(raw.get("ink"), ""),
         "muted": _hex(raw.get("muted"), ""), "accent": _hex(raw.get("accent"), DEFAULT_PALETTE["accent"]), "accentInk": _hex(raw.get("accent_ink") or raw.get("accentInk"), "")}
    dark = _lum(p["bg"]) < 0.2
    if not p["ink"] or contrast(p["ink"], p["bg"]) < 7:
        p["ink"] = "#F4F6F8" if dark else "#11161C"
    if not p["muted"] or contrast(p["muted"], p["bg"]) < 4.5:
        p["muted"] = "#B4BEC9" if dark else "#4A5562"
    if not p["surface"]:
        p["surface"] = "#1E2733" if dark else "#FFFFFF"
    if contrast(p["accent"], p["bg"]) < 2.2:  # an accent that disappears on the background
        p["accent"] = DEFAULT_PALETTE["accent"] if dark else "#2357E8"
    if not p["accentInk"] or contrast(p["accentInk"], p["accent"]) < 4.5:
        p["accentInk"] = max(("#0E1217", "#FFFFFF"), key=lambda k: contrast(k, p["accent"]))
    return p


def _cut(s, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


def clean(raw: dict, b, shots: list[dict], url: str) -> dict:
    """The script as the video and Meta need it, whatever the model returned."""
    name = _cut(raw.get("name") or b.title, 22)
    points = [_cut(p, 40) for p in (raw.get("points") or []) if str(p).strip()][:3]
    captions = [str(c) for c in (raw.get("captions") or [])]
    hook = _cut(raw.get("hook") or b.title, 70)
    emph = str(raw.get("emphasis") or "")
    return {
        "angle": _cut(raw.get("angle"), 60),
        "name": name,
        "hook": hook,
        "emphasis": emph if emph and emph.lower() in hook.lower() else "",
        "sub": _cut(raw.get("sub"), 90),
        "points": points or [b.tx("Listo para usar", "Ready to use")],
        "captions": [_cut(captions[i] if i < len(captions) else "", 50) or b.tx("Así se ve", "Here it is") for i in range(len(shots))],
        "cta": _cut(raw.get("cta") or b.tx("Probalo ahora", "Try it now"), 24),
        "cta_sub": _cut(raw.get("cta_sub"), 50),
        "font": raw.get("font") if raw.get("font") in FONTS else "grotesk",
        "palette": palette(raw.get("palette")),
        "primary_text": _cut(raw.get("primary_text") or hook, 300),
        "headline": _cut(raw.get("headline") or name, 40),
        "description": _cut(raw.get("description"), 30),
        "cta_type": raw.get("cta_type") if raw.get("cta_type") in CTA_TYPES else "LEARN_MORE",
        "link": url,
    }


def _plain(b, shots: list[dict]) -> dict:
    """Without a model: the brief's own sentences and bullet points (Markdown, tables and headings aside), so the pane still
    makes a decent ad."""
    sents, items = [], []
    for ln in (b.brief or "").splitlines():
        t = ln.strip()
        if not t or t.startswith(("#", "|", "```", ">", "<!--")) or re.match(r"^\d+[.)]\s", t):
            continue
        t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
        t = re.sub(r"\*{0,2}\((supuesto|assumption)\)\*{0,2}", "", t, flags=re.I)
        t = re.sub(r"\s+([:;,.])", r"\1", re.sub(r"\*\*|__|`", "", t)).strip()
        bullet = re.match(r"^[-*•]\s+(?:\[[ xX]\]\s*)?(.*)", t)
        if bullet:
            items.append(bullet.group(1).split(":")[-1].strip() if len(bullet.group(1)) > 40 else bullet.group(1).strip())
        else:
            sents += [x.strip() for x in re.split(r"(?<=[.!?])\s+", t)]
    sub = next((x for x in sents if 20 <= len(x) <= 90 and not x.endswith(":")), "")
    points = [x[0].upper() + x[1:].rstrip(".") for x in items if 4 <= len(x) <= 40 and not x.endswith(":")][:3]
    return {"angle": b.tx("Directo al grano", "Straight to the point"), "name": b.title, "hook": b.title, "sub": sub, "points": points, "captions": []}


def _json(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return {}
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


async def write_script(user: User, b, shots: list[dict], page_text: str, url: str, instructions: str, avoid: list[str]) -> tuple[dict, str | None]:
    """(script, «provider · model» or None when it was made without a model)."""
    who = writer(user.id)
    if not who:
        return clean(_plain(b, shots), b, shots, url), None
    pid, model, cred = who
    tokens = b.files.get("design/tokens.css") or ""
    screens = ", ".join(f"{i + 1}: {'celular' if s['kind'] == 'phone' else 'computadora'}" for i, s in enumerate(shots)) or "ninguna"
    user_msg = "\n\n".join(filter(None, [
        f"PRODUCTO: {b.title}",
        f"IDIOMA DEL ANUNCIO: {b.req.language}",
        f"BRIEF:\n{(b.brief or '')[:6000]}",
        f"TOKENS DEL DISEÑO (design/tokens.css):\n{tokens[:2500]}" if tokens else "",
        f"LO QUE SE VE EN EL PRODUCTO (texto de la página):\n{page_text[:3000]}" if page_text else "",
        f"PANTALLAS QUE MUESTRA EL VIDEO (una caption por cada una, en este orden): {screens}",
        f"DESTINO DEL ANUNCIO: {url}" if url else "",
        f"YA SE HICIERON ESTOS ÁNGULOS, PROBÁ OTRO DISTINTO: {'; '.join(avoid)}" if avoid else "",
        f"PEDIDO DEL USUARIO PARA ESTE ANUNCIO: {instructions}" if instructions else "",
    ]))
    result = CallResult()
    buf: list[str] = []
    async for kind, delta in stream(pid, model, SCRIPT_SYSTEM.format(ctas=", ".join(CTA_TYPES)), user_msg, temperature=0.8, max_tokens=1600, result=result, cred=cred):
        if kind == "text":
            buf.append(delta)
    raw = _json("".join(buf))
    if not raw.get("hook"):
        log.warning("ad script without a hook from %s/%s: %r", pid, model, "".join(buf)[:300])
        raw = _plain(b, shots)
    return clean(raw, b, shots, url), f"{PROVIDERS[pid].label} · {model}"


# ------------------------------------------------------------------------------------------------------------ render

def props(ad: dict, base: Path) -> dict:
    s = ad["script"]
    screens = []
    for sh in ad.get("screens", []):
        f = base / sh["file"]
        if f.exists():
            screens.append({"src": "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode(), "caption": sh.get("caption", ""), "kind": sh["kind"], "ratio": sh["ratio"], "bg": sh.get("bg") or "#FFFFFF"})
    url = re.sub(r"^https?://", "", s.get("link") or "").rstrip("/")
    return {"name": s["name"], "url": url, "palette": s["palette"], "font": s["font"], "hook": s["hook"], "emphasis": s["emphasis"], "sub": s["sub"],
            "points": s["points"], "screens": screens, "cta": s["cta"], "ctaSub": s["cta_sub"]}


def _browser() -> dict:
    """The Chrome Remotion renders with: ADS_CHROME when set; on macOS this machine's Chrome (the headless shell Remotion
    downloads there cannot load its ICU data); on Linux Remotion's own headless shell (installed in the Docker image)."""
    path = env("ADS_CHROME") or (rsch.chrome_path() if sys.platform == "darwin" else None)
    return {"browser": path, "chromeMode": "chrome-for-testing"} if path else {}


async def render(user_id: str, build_id: str, ad_id: str) -> None:
    base = folder(user_id, build_id) / ad_id
    ad = get(user_id, build_id, ad_id)
    if not ad:
        return
    if _render_lock.locked():
        _update(user_id, build_id, ad_id, status="queued", step="En cola: hay otro video renderizándose")
    async with _render_lock:
        _update(user_id, build_id, ad_id, status="rendering", step="Renderizando los videos", progress=0.0)
        job = base / "job.json"
        job.write_text(json.dumps({"props": props(ad, base), "out": str(base), "formats": list(FORMATS), **_browser()}))
        node = shutil.which("node")
        if not node or not (VIDEO_DIR / "node_modules").exists():
            raise RuntimeError("Falta el motor de video en el servidor (Node y backend/video con npm install).")
        proc = await asyncio.create_subprocess_exec(node, str(VIDEO_DIR / "render.mjs"), str(job), cwd=str(VIDEO_DIR),
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, limit=1 << 20)
        err, seconds, last = "", {}, 0.0
        try:
            assert proc.stdout
            async for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue  # Remotion's own logs (browser download, warnings)
                if "progress" in ev and ev["progress"] - last >= 0.02:
                    last = ev["progress"]
                    _update(user_id, build_id, ad_id, progress=round(last, 3))
                elif ev.get("done"):
                    seconds[ev["format"]] = round(ev.get("seconds") or 0, 1)
                elif ev.get("error"):
                    err = ev["error"]
            await proc.wait()
        except asyncio.CancelledError:
            proc.kill()
            raise
        finally:
            job.unlink(missing_ok=True)
        if proc.returncode != 0 or len(seconds) < len(FORMATS):
            raise RuntimeError(err or f"El render terminó con código {proc.returncode}")
        _update(user_id, build_id, ad_id, status="ready", step="", progress=1.0, formats=seconds, version=int(time.time()))


# ------------------------------------------------------------------------------------------------------------ jobs

async def _make(user: User, b, ad_id: str, instructions: str) -> None:
    uid, bid = user.id, b.id
    base = folder(uid, bid) / ad_id
    base.mkdir(parents=True, exist_ok=True)
    try:
        src = source_for(user, b)
        _update(uid, bid, ad_id, status="capturing", step="Sacando capturas de la app" if src["kind"] == "live" else "Sacando capturas del diseño", source=src.get("label"))
        shots, text = await asyncio.to_thread(capture, src, _files(b), base)
        _update(uid, bid, ad_id, status="writing", step="Escribiendo el guion del anuncio")
        avoid = [a["script"]["angle"] for a in load(uid, bid) if a.get("script") and a["id"] != ad_id][-5:]
        script, by = await write_script(user, b, shots, text, src.get("url") or "", instructions, avoid)
        for s, cap in zip(shots, script["captions"]):
            s["caption"] = cap
        _update(uid, bid, ad_id, script=script, screens=shots, writer=by)
        await render(uid, bid, ad_id)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("ad %s", ad_id)
        _update(uid, bid, ad_id, status="error", step="", error=str(e)[:600])
    finally:
        _running.pop(ad_id, None)


def start(user: User, b, instructions: str = "") -> dict:
    from .tasks import spawn

    ads = load(user.id, b.id)
    if len(ads) >= MAX_ADS:
        raise ValueError(f"Ya hay {MAX_ADS} anuncios en este proyecto: borrá alguno para hacer otro.")
    ad = {"id": secrets.token_hex(6), "created": time.time(), "updated": time.time(), "status": "capturing", "step": "Preparando", "progress": 0.0,
          "instructions": instructions[:600], "script": None, "screens": [], "formats": {}, "meta": None}
    _save(user.id, b.id, [ad] + ads)
    _running[ad["id"]] = spawn(_make(user, b, ad["id"], instructions[:600]))  # type: ignore[assignment]
    return ad


EDITABLE = ("name", "hook", "emphasis", "sub", "points", "captions", "cta", "cta_sub", "font", "palette", "primary_text", "headline", "description", "cta_type", "link")


def edit(user: User, b, ad_id: str, changes: dict) -> dict:
    """The user's own words on the script, then a new render with them."""
    from .tasks import spawn

    ad = get(user.id, b.id, ad_id)
    if not ad or not ad.get("script"):
        raise ValueError("Ese anuncio todavía no tiene guion")
    if ad_id in _running:
        raise ValueError("Ese anuncio se está haciendo: esperá a que termine")
    raw = {**ad["script"], **{k: v for k, v in changes.items() if k in EDITABLE}}
    script = clean(raw, b, ad["screens"], raw.get("link") or "")
    if "emphasis" in changes and not script["emphasis"] and str(changes["emphasis"]).strip():
        raise ValueError("Lo resaltado tiene que ser una parte del gancho")
    for s, cap in zip(ad["screens"], script["captions"]):
        s["caption"] = cap
    _update(user.id, b.id, ad_id, script=script, screens=ad["screens"], status="queued", step="Por renderizar", error=None, meta=None)

    async def job():
        try:
            await render(user.id, b.id, ad_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("ad render %s", ad_id)
            _update(user.id, b.id, ad_id, status="error", step="", error=str(e)[:600])
        finally:
            _running.pop(ad_id, None)

    _running[ad_id] = spawn(job())  # type: ignore[assignment]
    return get(user.id, b.id, ad_id) or {}


def recover(user_id: str, build_id: str) -> list[dict]:
    """The list, with the jobs a restart cut marked as failed (so they can be retried instead of spinning forever)."""
    ads = load(user_id, build_id)
    stale = [a for a in ads if a["status"] not in ("ready", "error") and a["id"] not in _running]
    for a in stale:
        a.update(status="error", step="", error="Se cortó porque el servidor se reinició: probá de nuevo.")
    if stale:
        _save(user_id, build_id, ads)
    return ads


def engine_ready() -> bool:
    return bool(shutil.which("node")) and (VIDEO_DIR / "node_modules").exists() and os.access(VIDEO_DIR / "render.mjs", os.R_OK)
