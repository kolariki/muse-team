"""Video ads for the app the team built, ready for Meta Ads.

The «Anuncios» pane works in three steps:
1. understand the app: headless Chrome captures its real screens (the published app and the routes found in its code; the
   approved design or the prototype when it is not published yet) and a model (Meta Muse first) reads the code, the README,
   the brief and the text on those screens, and writes a summary: what it does, for whom, the problem, the features, the
   real figures. The user sees it and can correct it;
2. pick a template: 20 ad structures (backend/video/src/templates.json, renewed monthly from what is performing on Meta
   and TikTok) and the 5 that fit this app best, recommended by the model with a reason;
3. make the ad: the model writes the script for that template's scenes from the summary, and the Remotion composition in
   backend/video renders it as two MP4s (vertical 9:16 and square 1:1) with their covers. One render at a time per server.

Without a model key the summary and the script come from the brief, so the pane always works. Everything lives in
<user>/ads/<build_id>/: app.json (screens + summary), ads.json (the list) and one folder per ad. Publishing is meta_ads.py.
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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .auth import User, user_dir
from .config import env
from .providers import PROVIDERS, CallResult, Cred, stream
from . import cloud as cloudmod
from . import keystore
from . import research as rsch

log = logging.getLogger("arena.ads")

VIDEO_DIR = Path(__file__).resolve().parents[1] / "video"
CATALOG = VIDEO_DIR / "src" / "templates.json"
FORMATS = ("vertical", "square")
CTA_TYPES = ("LEARN_MORE", "SIGN_UP", "SHOP_NOW", "BOOK_NOW", "GET_OFFER", "SUBSCRIBE", "DOWNLOAD", "CONTACT_US", "ORDER_NOW", "APPLY_NOW")
WRITERS = ("meta", "anthropic", "openai", "gemini", "xai", "openrouter", "deepseek", "mistral", "kimi", "groq", "baseten")
FONTS = ("grotesk", "serif", "rounded")
CATEGORIES = ("saas", "b2b", "consumo", "servicios", "local", "ecommerce")
MAX_ADS = 12
MAX_ROUTES = 3
DEFAULT_PALETTE = {"bg": "#10161F", "surface": "#1B2430", "ink": "#F1F4F8", "muted": "#A9B4C2", "accent": "#F5A524", "accentInk": "#10161F"}

_render_lock = asyncio.Lock()
_running: dict[str, asyncio.Task] = {}  # ad id (or "app:<build>") → its job


def catalog() -> dict:
    return json.loads(CATALOG.read_text())


def templates() -> list[dict]:
    return catalog()["templates"]


def template(tid: str | None) -> dict:
    ts = templates()
    return next((t for t in ts if t["id"] == tid), ts[0])


# ------------------------------------------------------------------------------------------------------------ storage

def folder(user_id: str, build_id: str) -> Path:
    d = user_dir(user_id) / "ads" / re.sub(r"[^\w-]", "", build_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(p: Path, default):
    try:
        return json.loads(p.read_text()) if p.exists() else default
    except (OSError, ValueError):
        return default


def _write(p: Path, data) -> None:
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(p)


def load(user_id: str, build_id: str) -> list[dict]:
    return _read(folder(user_id, build_id) / "ads.json", [])


def _save(user_id: str, build_id: str, ads: list[dict]) -> None:
    _write(folder(user_id, build_id) / "ads.json", ads)


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


def app_state(user_id: str, build_id: str) -> dict:
    return _read(folder(user_id, build_id) / "app.json", {})


def _app_update(user_id: str, build_id: str, **fields) -> dict:
    st = app_state(user_id, build_id) | fields | {"updated": time.time()}
    _write(folder(user_id, build_id) / "app.json", st)
    return st


def file_for(user_id: str, build_id: str, ad_id: str, name: str) -> Path | None:
    """A video, cover or screen of an ad (`vertical.mp4`, `square.jpg`, `screen-0.jpg`), or a captured screen of the app
    (ad id `app`), only those names."""
    if ad_id == "app":
        if not re.fullmatch(r"screen-\d\.jpg", name):
            return None
        p = folder(user_id, build_id) / "screens" / name
        return p if p.exists() else None
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


def public_app(st: dict) -> dict:
    return {"status": st.get("status") or "none", "step": st.get("step") or "", "error": st.get("error"), "summary": st.get("summary"),
            "summary_by": st.get("summary_by"), "source": st.get("source"), "updated": st.get("updated"), "edited": bool(st.get("edited")),
            "screens": [{"kind": s["kind"], "route": s.get("route", "/"), "file": s["file"], "ratio": s.get("ratio", 2), "bg": s.get("bg") or "#FFFFFF"} for s in st.get("screens", [])],
            "recommended": st.get("recommended") or [], "palette": st.get("palette")}


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


SKIP_ROUTE = re.compile(r"login|signin|sign-in|signup|sign-up|register|registro|auth|logout|reset|forgot|recuperar|admin|api|callback|404|terms|terminos|privacy|privacidad|legal", re.I)


def routes(files: dict[str, str]) -> list[str]:
    """The app's own pages, read from its code (React Router, Next.js app/ and pages/, plain HTML), the ones worth showing."""
    found: list[str] = []
    for p, t in files.items():
        if not isinstance(t, str) or re.search(r"(^|/)(node_modules|dist|build|\.next|design|preview|research|tests?)/", p):
            continue
        if re.search(r"\.(tsx|jsx|ts|js|vue|svelte)$", p):
            found += re.findall(r"""\bpath\s*[:=]\s*["'](/[\w\-/]*)["']""", t)
        m = re.match(r"(?:src/)?app/(.*?)/?page\.(tsx|jsx|ts|js)$", p)
        if m:
            found.append("/" + "/".join(s for s in m.group(1).split("/") if s and not s.startswith("(")))
        m = re.match(r"(?:src/)?pages/(.+)\.(tsx|jsx)$", p)
        if m and not m.group(1).startswith(("_", "api/")):
            found.append("/" + re.sub(r"(^|/)index$", "", m.group(1)))
        m = re.match(r"(?:public/)?([\w-]+)\.html$", p)
        if m and m.group(1) != "index":
            found.append(f"/{m.group(1)}.html")
    out: list[str] = []
    for r in found:
        r = r.rstrip("/") or "/"
        if r != "/" and r not in out and not re.search(r"[:\[*]", r) and not SKIP_ROUTE.search(r):
            out.append(r)
    return out[:MAX_ROUTES]


def _shot(chrome: str, url: str, size: tuple[int, int], out: Path, tmp: str, mobile: bool) -> bytes | None:
    cmd = [chrome, "--headless=new", "--no-sandbox", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
           "--virtual-time-budget=12000", "--timeout=30000", f"--user-data-dir={tmp}/{out.stem}", f"--window-size={size[0]},{size[1]}",
           "--force-device-scale-factor=2", f"--screenshot={out}"]
    if mobile:
        cmd.append("--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    rsch._run_for_file(cmd + [url], out, rsch.SHOT_TIMEOUT)
    return out.read_bytes() if out.exists() and out.stat().st_size > 2000 else None


def _dom(chrome: str, url: str, tmp: str, tag: str) -> str:
    _, dom = rsch._run([chrome, "--headless=new", "--no-sandbox", f"--user-data-dir={tmp}/dom-{tag}", "--virtual-time-budget=8000", "--dump-dom", url], 40)
    if not dom:
        return ""
    cap = rsch.Capture(url=url)
    rsch._dom_summary(cap, dom)
    login = bool(re.search(r"type=[\"']password", dom))
    return ("[pantalla de acceso] " if login else "") + "\n".join(filter(None, [cap.title, " · ".join(cap.headings[:20]), " · ".join(cap.buttons[:20]), cap.text[:1800]]))


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


def _same(a: bytes, b: bytes) -> bool:
    """Two captures of the same page (a route that redirected home)."""
    from PIL import Image, ImageChops, ImageStat

    x, y = (Image.open(io.BytesIO(v)).convert("L").resize((64, 128)) for v in (a, b))
    return ImageStat.Stat(ImageChops.difference(x, y)).mean[0] < 4


def capture(src: dict, files: dict[str, str], out: Path) -> list[dict]:
    """The app's screens as JPGs in `out`: the home and up to 3 more routes on the phone, the home on a desktop. Each one with
    the text on it (what the summary and the captions are written from)."""
    chrome = rsch.chrome_path()
    if not chrome or src["kind"] == "none":
        return []
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("screen-*.jpg"):
        old.unlink()
    with tempfile.TemporaryDirectory(prefix="tably-ad-") as tmp:
        if src["kind"] == "live":
            base, tall = src["url"].rstrip("/"), 932
            pages = [("/", base)] + [(r, base + r) for r in routes(files)]
        else:  # the mockup or the prototype, written next to its tokens so relative links resolve
            for p in ("design/mockup.html", "design/tokens.css", "preview/index.html"):
                if isinstance(files.get(p), str):
                    (Path(tmp) / p).parent.mkdir(parents=True, exist_ok=True)
                    (Path(tmp) / p).write_text(files[p])
            tall = 2200  # a mockup has no 100vh hero: the phone can scroll through it
            pages = [("/", (Path(tmp) / src["path"]).as_uri())]
        with ThreadPoolExecutor(max_workers=4) as pool:
            phone = {r: pool.submit(_shot, chrome, u, (430, tall), Path(tmp) / f"m{i}.png", tmp, True) for i, (r, u) in enumerate(pages)}
            text = {r: pool.submit(_dom, chrome, u, tmp, str(i)) for i, (r, u) in enumerate(pages)}
            desk = pool.submit(_shot, chrome, pages[0][1], (1440, 900), Path(tmp) / "d.png", tmp, False)
            shots: list[dict] = []
            kept: list[bytes] = []
            for r, _ in pages:
                png, words = phone[r].result(), text[r].result()
                if not png or words.startswith("[pantalla de acceso]") and r != "/" or any(_same(png, k) for k in kept):
                    continue
                kept.append(png)
                data, ratio, bg = _jpeg(png, 860, 4.4)
                name = f"screen-{len(shots)}.jpg"
                (out / name).write_bytes(data)
                shots.append({"kind": "phone", "file": name, "ratio": ratio, "bg": bg, "route": r, "text": words[:2000]})
            d = desk.result()
            if d:
                data, ratio, bg = _jpeg(d, 1600, 0.9)
                name = f"screen-{len(shots)}.jpg"
                (out / name).write_bytes(data)
                shots.append({"kind": "desktop", "file": name, "ratio": ratio, "bg": bg, "route": "/", "text": ""})
    return shots


# ------------------------------------------------------------------------------------------------------------ colours

HEX = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")
ROLE = {
    "bg": re.compile(r"^(color-)?(bg|background|paper|canvas|base)(-default|-primary)?$", re.I),
    "surface": re.compile(r"^(color-)?(surface|card|panel|elevated)(-default|-1)?$", re.I),
    "ink": re.compile(r"^(color-)?(ink|text|fg|foreground|on-bg)(-primary|-default)?$", re.I),
    "accent": re.compile(r"^(color-)?(accent|primary|brand|cta)(-default|-500|-600)?$", re.I),
}
DECL = re.compile(r"--([\w-]+)\s*:\s*([^;{}]+)")


def _full(h: str) -> str:
    h = h.lstrip("#")
    return "#" + ("".join(c * 2 for c in h) if len(h) == 3 else h).upper()


def palette_from_code(files: dict[str, str]) -> dict | None:
    """The app's own colours, read from its design tokens or its CSS variables (design/tokens.css first)."""
    srcs = [files.get("design/tokens.css") or ""] + [t for p, t in files.items() if isinstance(t, str) and re.search(r"\.(css|scss)$", p) and not re.search(r"node_modules|dist/", p)][:12]
    found: dict[str, str] = {}
    for css in srcs:
        for name, value in DECL.findall(css):
            m = HEX.search(value)
            for role, rx in ROLE.items():
                if m and role not in found and rx.match(name):
                    found[role] = _full(m.group(0))
    if "accent" not in found or "bg" not in found:
        return None
    return palette({"bg": found["bg"], "surface": found.get("surface"), "ink": found.get("ink"), "accent": found["accent"]})


def palette_from_shots(folder_: Path, shots: list[dict]) -> dict | None:
    """Without tokens: the page colour of the first screen and its most frequent vivid colour as the accent."""
    from PIL import Image
    import colorsys

    phone = next((s for s in shots if s["kind"] == "phone"), None)
    if not phone or not (folder_ / phone["file"]).exists():
        return None
    im = Image.open(folder_ / phone["file"]).convert("RGB").resize((120, 240))
    counts = im.getcolors(120 * 240) or []
    vivid = []
    for n, (r, g, b) in counts:
        h, l, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if sat > 0.45 and 0.25 < l < 0.75:
            vivid.append((n, (r, g, b)))
    if not vivid:
        return None
    acc = max(vivid)[1]
    return palette({"bg": phone.get("bg") or "#FFFFFF", "accent": "#%02X%02X%02X" % acc})


# ------------------------------------------------------------------------------------------------------------ models

def writer(user_id: str) -> tuple[str, str, Cred] | None:
    """The model that understands the app and writes the ad: Meta Muse when there is a key, else the first configured one."""
    creds = keystore.creds(user_id)
    for pid in WRITERS:
        c = creds.get(pid)
        if c and c.source != "none" and PROVIDERS.get(pid):
            return pid, c.model or PROVIDERS[pid].default_model, c
    return None


async def _ask(user_id: str, system: str, user_msg: str, max_tokens: int = 1800, temperature: float = 0.7) -> tuple[dict, str | None]:
    """One JSON answer from the writer model: (data, «provider · model») — ({}, None) without a model."""
    who = writer(user_id)
    if not who:
        return {}, None
    pid, model, cred = who
    buf: list[str] = []
    async for kind, delta in stream(pid, model, system, user_msg, temperature=temperature, max_tokens=max_tokens, result=CallResult(), cred=cred):
        if kind == "text":
            buf.append(delta)
    return _json("".join(buf)), f"{PROVIDERS[pid].label} · {model}"


def _close(s: str) -> str | None:
    """A JSON object that was cut short (the model ran out of tokens), closed after its last complete element."""
    stack: list[str] = []
    in_str = esc = False
    last: tuple[int, list[str]] | None = None
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
            if not stack:
                return s[: i + 1]
        elif ch == "," and stack:
            last = (i, list(stack))
    return s[: last[0]] + "".join(reversed(last[1])) if last else None


def _json(text: str) -> dict:
    """The JSON object in a model's answer, even inside a code block or cut short at the end."""
    start = (text or "").find("{")
    if start < 0:
        return {}
    m = re.search(r"\{.*\}", text, re.S)
    for cand in filter(None, [m.group(0) if m else None, _close(text[start:])]):
        try:
            v = json.loads(cand)
            if isinstance(v, dict):
                return v
        except ValueError:
            continue
    return {}


def _cut(s, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


# ------------------------------------------------------------------------------------------------------------ summary

KEY_FILES = re.compile(r"(^|/)(README\.md|BRIEF\.md|package\.json|design/DESIGN\.md|\.tably/entrega\.md)$|(^|/)(app|pages|routes|screens|views)/.*\.(tsx|jsx|vue|svelte)$|(^|/)(App|main|index|router|routes)\.(tsx|jsx)$|(^|/)(models?|schema)\.(py|ts)$|schema\.prisma$", re.I)

SUMMARY_SYSTEM = """Sos un analista de producto. Te paso todo lo que hay de una app: el brief, el código (rutas, pantallas, modelos de datos), el README
y el texto que se ve en sus pantallas. Entendé qué hace DE VERDAD (lo que está construido, no lo que se promete) y resumilo para el
equipo creativo que va a hacer sus anuncios.

Reglas: solo lo que está en el material; nada inventado. `proof` son cifras o datos concretos y verificables que aparecen en el material
(precios, tiempos, cantidades); si no hay, lista vacía. `features` son las funciones que existen, en palabras de usuario (no técnicas).
`category` es una de: {cats}. Escribí en {lang}.

Respondé SOLO un objeto JSON:
{{"name": "nombre corto del producto", "one_liner": "qué es en una frase (máx. 14 palabras)", "what": "qué hace, 2-3 frases",
"for_whom": "para quién es", "problem": "el problema que resuelve, en palabras de esa persona", "features": ["", ""], "proof": [],
"tone": "tono de marca en 3 palabras", "category": "saas", "offer": "precio, prueba gratis u oferta si aparece; si no, vacío"}}"""


def _material(b, shots: list[dict]) -> str:
    files = {p: t for p, t in b.files.items() if isinstance(t, str) and KEY_FILES.search(p) and not re.search(r"node_modules|dist/|build/", p)}
    tree = "\n".join(sorted(p for p in b.files if not re.search(r"node_modules|dist/|\.git/", p))[:150])
    parts, budget = [], 14000
    for p in sorted(files, key=lambda x: (not x.endswith((".md", ".prisma")), len(files[x]))):
        chunk = f"--- {p}\n{files[p][:3000]}"
        if budget - len(chunk) < 0:
            break
        budget -= len(chunk)
        parts.append(chunk)
    screens = "\n".join(f"PANTALLA {s['route']} ({'celular' if s['kind'] == 'phone' else 'computadora'}):\n{s.get('text') or '(sin texto)'}" for s in shots if s.get("text"))
    return "\n\n".join(filter(None, [f"PRODUCTO: {b.title}", f"BRIEF:\n{(b.brief or '')[:6000]}", f"ARCHIVOS:\n{tree}", "\n\n".join(parts), screens]))


def _plain_summary(b) -> dict:
    p = _plain(b)
    return {"name": b.title[:22], "one_liner": p.get("sub") or b.title, "what": p.get("sub") or "", "for_whom": "", "problem": "",
            "features": p.get("points") or [], "proof": [], "tone": "", "category": "consumo", "offer": ""}


def clean_summary(raw: dict, b) -> dict:
    lst = lambda v, n, k: [_cut(x, k) for x in (v or []) if str(x).strip()][:n] if isinstance(v, list) else []  # noqa: E731
    return {"name": _cut(raw.get("name") or b.title, 22), "one_liner": _cut(raw.get("one_liner"), 140), "what": _cut(raw.get("what"), 500),
            "for_whom": _cut(raw.get("for_whom"), 200), "problem": _cut(raw.get("problem"), 240), "features": lst(raw.get("features"), 8, 90),
            "proof": lst(raw.get("proof"), 5, 120), "tone": _cut(raw.get("tone"), 60),
            "category": raw.get("category") if raw.get("category") in CATEGORIES else "consumo", "offer": _cut(raw.get("offer"), 120)}


# ------------------------------------------------------------------------------------------------------------ recommend

RECOMMEND_SYSTEM = """Sos el/la director/a creativo/a. Te paso el resumen de una app y un catálogo de plantillas de anuncios en video.
Elegí las 5 que mejor van a funcionar para ESTA app en Meta (Reels, Stories y feed), variadas entre sí (no 5 iguales), y en orden.
Tené en cuenta qué material hay: si no hay cifras reales no elijas «dato-primero»; si no hay pantallas, evitá las que dependen de ellas.
Para cada una, una razón de máximo 18 palabras en {lang}, concreta para esta app.

Respondé SOLO JSON: {{"picks": [{{"id": "", "why": ""}}]}}"""


def _fits(t: dict, summary: dict, shots: list[dict]) -> bool:
    need_screens = any(s in ("split", "zoom") for s in t["scenes"]) or t["scenes"].count("screens")
    if "stat" in t["scenes"] and not summary.get("proof"):
        return False
    if need_screens and not shots:
        return False
    if t["id"] == "demo-web" and not any(s["kind"] == "desktop" for s in shots):
        return False
    return True


def _heuristic(summary: dict, shots: list[dict], en: bool) -> list[dict]:
    cat = summary.get("category") or "consumo"
    ranked = sorted([t for t in templates() if _fits(t, summary, shots)], key=lambda t: (cat not in t["tags"], t["goal"] != "conversion"))
    return [{"id": t["id"], "why": t["why"]["en" if en else "es"]} for t in ranked[:5]]


async def recommend(user: User, b, summary: dict, shots: list[dict]) -> tuple[list[dict], str | None]:
    lang = b.req.language
    cat = "\n".join(f"- {t['id']}: {t['name']['es']}. {t['desc']['es']} (sirve para: {', '.join(t['tags'])}; objetivo: {t['goal']})" for t in templates())
    msg = f"RESUMEN DE LA APP:\n{json.dumps(summary, ensure_ascii=False)}\n\nPANTALLAS CAPTURADAS: {len(shots)}\n\nCATÁLOGO:\n{cat}"
    raw, by = await _ask(user.id, RECOMMEND_SYSTEM.format(lang=lang), msg, max_tokens=900, temperature=0.4)
    ids = {t["id"]: t for t in templates()}
    picks, seen = [], set()
    for p in raw.get("picks") or []:
        tid = str((p or {}).get("id") or "")
        if tid in ids and tid not in seen and _fits(ids[tid], summary, shots):
            seen.add(tid)
            picks.append({"id": tid, "why": _cut(p.get("why"), 160) or ids[tid]["why"]["es"]})
    for h in _heuristic(summary, shots, b.en):  # always five
        if len(picks) >= 5:
            break
        if h["id"] not in seen:
            seen.add(h["id"])
            picks.append(h)
    return picks[:5], by


# ------------------------------------------------------------------------------------------------------------ analysis job

def prepare(user: User, b) -> dict:
    """Understand the app again (screens, summary, recommendations), in the background."""
    from .tasks import spawn

    key = f"app:{b.id}"
    if key in _running:
        return app_state(user.id, b.id)
    st = _app_update(user.id, b.id, status="capturing", step="Sacando capturas de tus pantallas", error=None)

    async def job():
        try:
            src = source_for(user, b)
            _app_update(user.id, b.id, source=src.get("label"), step="Sacando capturas de tus pantallas" if src["kind"] == "live" else "Sacando capturas del diseño")
            shots = await asyncio.to_thread(capture, src, _files(b), folder(user.id, b.id) / "screens")
            pal = palette_from_code(_files(b)) or palette_from_shots(folder(user.id, b.id) / "screens", shots)
            _app_update(user.id, b.id, status="summarizing", step="Leyendo la app para entender qué hace", screens=shots, palette=pal)
            raw, by = await _ask(user.id, SUMMARY_SYSTEM.format(cats=", ".join(CATEGORIES), lang=b.req.language), _material(b, shots), temperature=0.3)
            summary = clean_summary(raw, b) if raw.get("what") or raw.get("one_liner") else _plain_summary(b)
            _app_update(user.id, b.id, status="recommending", step="Eligiendo las plantillas que mejor le van", summary=summary, summary_by=by, edited=False)
            picks, _ = await recommend(user, b, summary, shots)
            _app_update(user.id, b.id, status="ready", step="", recommended=picks, key=_app_key(b))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("ads analysis %s", b.id)
            _app_update(user.id, b.id, status="error", step="", error=str(e)[:400])
        finally:
            _running.pop(key, None)

    _running[key] = spawn(job())  # type: ignore[assignment]
    return st


def _app_key(b) -> str:
    """Changes when the app changes (a new version), so the summary is redone then."""
    return f"v{len(b.versions)}"


async def edit_summary(user: User, b, changes: dict) -> dict:
    """The user's own corrections to the summary; the recommendations are redone from it."""
    st = app_state(user.id, b.id)
    raw = {**(st.get("summary") or _plain_summary(b)), **{k: v for k, v in changes.items() if k in ("name", "one_liner", "what", "for_whom", "problem", "features", "proof", "tone", "category", "offer")}}
    summary = clean_summary(raw, b)
    picks, _ = await recommend(user, b, summary, st.get("screens") or [])
    return _app_update(user.id, b.id, summary=summary, edited=True, recommended=picks)


def recover_app(user_id: str, b) -> dict:
    st = app_state(user_id, b.id)
    if st.get("status") in ("capturing", "summarizing", "recommending") and f"app:{b.id}" not in _running:
        st = _app_update(user_id, b.id, status="error", step="", error="Se cortó porque el servidor se reinició: probá de nuevo.")
    if st.get("status") == "ready" and st.get("key") and st["key"] != _app_key(b):
        st = {**st, "stale": True}
    return st


# ------------------------------------------------------------------------------------------------------------ script

FIELDS = {
    "hook": "gancho: una promesa o tensión concreta del usuario, máx. 8 palabras",
    "emphasis": "1-2 palabras del gancho, copiadas tal cual, que se resaltan",
    "sub": "una línea que aterriza el gancho, máx. 70 caracteres",
    "points": "exactamente 3 beneficios de máx. 5 palabras",
    "captions": "una frase (máx. 7 palabras) por cada pantalla listada, en ese orden, que diga qué logra el usuario ahí",
    "lines": "4 o 5 líneas cortas (máx. 7 palabras) que se leen sin sonido y cuentan problema → solución",
    "chat": "4 mensajes [{\"me\": false|true, \"text\": \"\"}] de una conversación natural entre dos personas: una cuenta el problema, la otra le recomienda el producto por su nombre; máx. 12 palabras c/u, un emoji como mucho",
    "notes_title": "título de una nota personal del celular, máx. 4 palabras",
    "notes": "4 ítems de esa nota: lo que la persona quiere lograr y el producto resuelve, máx. 7 palabras",
    "before": "3 frases cortas de cómo es la vida SIN el producto",
    "after": "3 frases cortas de cómo es CON el producto (paralelas a las de before)",
    "stat": "{\"value\": \"\", \"label\": \"\"} SOLO con una cifra que esté en `proof` del resumen; si no hay, null",
    "query": "lo que esa persona escribiría en un buscador, en minúsculas, máx. 6 palabras",
    "notifs": "3 notificaciones que la app manda de verdad [{\"title\": \"\", \"body\": \"\"}] con datos de ejemplo realistas",
    "pov": "lo que sigue a «POV:», en primera persona del usuario feliz, máx. 12 palabras",
    "problem": "la práctica vieja que se tacha (sigue a «Basta de»), máx. 6 palabras",
    "steps": "3 pasos para empezar a usarla, máx. 5 palabras c/u",
    "question": "la pregunta u objeción que frena a la gente, máx. 8 palabras",
    "answer": "la respuesta, máx. 7 palabras",
    "marquee": "4 palabras sueltas que resumen el producto",
}
SCENE_FIELDS = {
    "hook": ["hook", "emphasis", "sub"], "points": ["points"], "reasons": ["points"], "screens": ["captions"], "lines": ["lines"], "chat": ["chat"],
    "notes": ["notes_title", "notes"], "beforeAfter": ["before", "after"], "stat": ["stat"], "search": ["query", "sub"], "notifs": ["notifs"],
    "pov": ["pov"], "problem": ["problem", "sub"], "steps": ["steps"], "question": ["question", "answer"], "marquee": ["marquee"],
    "split": ["lines"], "zoom": ["captions"],
}


def fields_for(t: dict) -> list[str]:
    out = ["hook", "emphasis", "sub", "points", "captions"]
    for s in t["scenes"]:
        for f in SCENE_FIELDS.get("screens" if s.startswith("screen") else s, []):
            if f not in out:
                out.append(f)
    return out


SCRIPT_SYSTEM = """Sos el/la creativo/a de performance de un equipo que lanza productos digitales. Escribís anuncios en video de 10-20 segundos
para Meta (Reels, Stories y feed de Instagram y Facebook) que la gente frena a mirar y que convierten.

Hoy el anuncio usa la plantilla «{tname}»: {tdesc} Sus escenas, en orden: {scenes}.

Reglas:
- Todo sale del RESUMEN DE LA APP: lo que hace de verdad, para quién y el problema. Hablale a esa persona con sus palabras, en {lang}.
- Nada de clichés («revolucioná», «llevá al siguiente nivel»), nada de signos de exclamación en serie.
- No inventes datos, precios, cifras ni testimonios que no estén en el resumen.
- `name`: el nombre corto del producto, máx. 22 caracteres. `cta`: el botón (2-3 palabras). `cta_sub`: una línea que baja la fricción SOLO si el resumen la respalda (oferta, prueba); si no, vacío.
- Paleta: tomala del diseño del producto si existe (tokens.css); si no, una que encaje con el rubro. `ink` con contraste AA sobre `bg`, `accent` vivo, `accent_ink` legible sobre `accent`. Solo HEX #RRGGBB.
- `font`: grotesk (moderno, producto/tecnología), serif (editorial, premium, salud, belleza), rounded (amigable, familia, comida, niños).
- Copy de Meta: `primary_text` (máx. 125 caracteres), `headline` (máx. 40), `description` (máx. 30), `cta_type` uno de: {ctas}.

Los campos de esta plantilla:
{fields}

Respondé SOLO un objeto JSON con: angle (el ángulo creativo en 3-6 palabras), name, {keys}, cta, cta_sub, font, palette {{bg, surface, ink, muted, accent, accent_ink}}, primary_text, headline, description, cta_type."""


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


def _strs(v, n: int, k: int) -> list[str]:
    return [_cut(x, k) for x in v if isinstance(x, (str, int, float)) and str(x).strip()][:n] if isinstance(v, list) else []


def clean(raw: dict, b, shots: list[dict], url: str) -> dict:
    """The script as the video and Meta need it, whatever the model returned."""
    name = _cut(raw.get("name") or b.title, 22)
    hook = _cut(raw.get("hook") or b.title, 70)
    emph = str(raw.get("emphasis") or "")
    captions = [str(c) for c in (raw.get("captions") or [])]
    stat = raw.get("stat") if isinstance(raw.get("stat"), dict) and str(raw["stat"].get("value") or "").strip() else None
    chat = [{"me": bool(m.get("me")), "text": _cut(m.get("text"), 90)} for m in (raw.get("chat") or []) if isinstance(m, dict) and str(m.get("text") or "").strip()][:5]
    notifs = [{"title": _cut(m.get("title"), 40), "body": _cut(m.get("body"), 70)} for m in (raw.get("notifs") or []) if isinstance(m, dict) and m.get("title")][:3]
    return {
        "angle": _cut(raw.get("angle"), 60),
        "name": name,
        "hook": hook,
        "emphasis": emph if emph and emph.lower() in hook.lower() else "",
        "sub": _cut(raw.get("sub"), 90),
        "points": _strs(raw.get("points"), 3, 40) or [b.tx("Listo para usar", "Ready to use")],
        "captions": [_cut(captions[i] if i < len(captions) else "", 50) or b.tx("Así se ve", "Here it is") for i in range(len(shots))],
        "lines": _strs(raw.get("lines"), 5, 60),
        "chat": chat,
        "notes_title": _cut(raw.get("notes_title"), 32),
        "notes": _strs(raw.get("notes"), 5, 50),
        "before": _strs(raw.get("before"), 3, 44),
        "after": _strs(raw.get("after"), 3, 44),
        "stat": {"value": _cut(stat.get("value"), 10), "label": _cut(stat.get("label"), 60)} if stat else None,
        "query": _cut(raw.get("query"), 48).lower(),
        "notifs": notifs,
        "pov": _cut(raw.get("pov"), 90),
        "problem": _cut(raw.get("problem"), 50),
        "steps": _strs(raw.get("steps"), 4, 40),
        "question": _cut(raw.get("question"), 70),
        "answer": _cut(raw.get("answer"), 60),
        "marquee": _strs(raw.get("marquee"), 6, 18),
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


def _plain(b, shots: list[dict] | None = None) -> dict:
    """Without a model: the brief's own sentences and bullet points (Markdown, tables and headings aside), so the pane still
    makes a decent ad."""
    sents, items, code = [], [], False
    for ln in (b.brief or "").splitlines():
        t = ln.strip()
        if t.startswith("```"):
            code = not code
            continue
        if code or not t or t.startswith(("#", "|", ">", "<!--")) or re.match(r"^\d+[.)]\s", t):
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
    return {"angle": b.tx("Directo al grano", "Straight to the point"), "name": b.title, "hook": b.title, "sub": sub, "points": points, "captions": [],
            "lines": [x for x in sents if 12 <= len(x) <= 60][:4], "steps": points, "before": [], "after": points, "marquee": [w for w in re.findall(r"\w{4,}", b.title)][:4]}


async def write_script(user: User, b, t: dict, summary: dict, shots: list[dict], url: str, instructions: str, avoid: list[str]) -> tuple[dict, str | None]:
    """(script, «provider · model» or None when it was made without a model)."""
    keys = fields_for(t)
    screens = ", ".join(f"{i + 1}: {'celular' if s['kind'] == 'phone' else 'computadora'} en {s.get('route', '/')}" for i, s in enumerate(shots)) or "ninguna"
    system = SCRIPT_SYSTEM.format(tname=t["name"]["es"], tdesc=t["desc"]["es"], scenes=" → ".join(t["scenes"]), lang=b.req.language,
                                  ctas=", ".join(CTA_TYPES), fields="\n".join(f"- `{k}`: {FIELDS[k]}" for k in keys), keys=", ".join(keys))
    tokens = b.files.get("design/tokens.css") or ""
    msg = "\n\n".join(filter(None, [
        f"RESUMEN DE LA APP:\n{json.dumps(summary, ensure_ascii=False, indent=1)}",
        f"TOKENS DEL DISEÑO (design/tokens.css):\n{tokens[:2500]}" if tokens else "",
        f"PANTALLAS QUE MUESTRA EL VIDEO (una caption por cada una, en este orden): {screens}",
        "\n".join(f"Texto de la pantalla {i + 1}: {s.get('text', '')[:600]}" for i, s in enumerate(shots) if s.get("text")),
        f"DESTINO DEL ANUNCIO: {url}" if url else "",
        _references(),
        f"YA SE HICIERON ESTOS ÁNGULOS, PROBÁ OTRO DISTINTO: {'; '.join(avoid)}" if avoid else "",
        f"PEDIDO DEL USUARIO PARA ESTE ANUNCIO: {instructions}" if instructions else "",
    ]))
    raw, by = await _ask(user.id, system, msg, max_tokens=2200, temperature=0.8)
    if not raw.get("hook"):
        raw = {**_plain(b, shots), "name": summary.get("name") or b.title, "sub": summary.get("one_liner") or "", "points": (summary.get("features") or [])[:3] or _plain(b).get("points")}
        by = None
    return clean(raw, b, shots, url), by


# ------------------------------------------------------------------------------------------------------------ render

def _references() -> str:
    """Skeletons of real S/A ads from the AdTier catalogue: how the best ones are built (to learn from, never to copy)."""
    try:
        from . import adtier

        refs = adtier.references(n=3)
    except Exception:  # noqa: BLE001
        refs = []
    if not refs:
        return ""
    return "REFERENCIAS DEL CATÁLOGO ADTIER (anuncios reales de tier S/A: aprendé de su estructura, no copies su contenido):\n" + "\n".join(
        f"- tier {r['tier']} · {r['format'] or ''}: {r['skeleton']} · hook: {r['hook'] or ''} · CTA: {r['cta'] or ''}" for r in refs)


def labels(b) -> dict:
    return {"before": b.tx("Antes", "Before"), "after": b.tx("Ahora", "Now"), "pov": "POV:", "stop": b.tx("Basta de", "Stop"),
            "notes": b.tx("Notas", "Notes"), "now": b.tx("ahora", "now"), "chat": b.tx("Caro", "Sam")}


def props(ad: dict, base: Path, b) -> dict:
    s = ad["script"]
    t = template(ad.get("template"))
    look = ad.get("look") or {}
    style = {**t["style"], **{k: look[k] for k in ("bg", "fx", "theme") if k in look}}
    if "palette" in look:
        style["theme"] = look.get("theme", "auto")  # colours the user picked are shown as they are
    if "font" in look:
        style["font"] = look["font"]
    screens = []
    for sh in ad.get("screens", []):
        f = base / sh["file"]
        if f.exists():
            screens.append({"src": "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode(), "caption": sh.get("caption", ""), "kind": sh["kind"], "ratio": sh["ratio"], "bg": sh.get("bg") or "#FFFFFF"})
    url = re.sub(r"^https?://", "", s.get("link") or "").rstrip("/")
    return {"name": s["name"], "url": url, "palette": look.get("palette") or s["palette"], "font": look.get("font") or s["font"], "template": {"id": t["id"], "scenes": t["scenes"], "style": style},
            "labels": labels(b), "hook": s["hook"], "emphasis": s["emphasis"], "sub": s["sub"], "points": s["points"], "screens": screens, "cta": s["cta"], "ctaSub": s["cta_sub"],
            "lines": s.get("lines") or None, "chat": s.get("chat") or None, "notesTitle": s.get("notes_title") or "", "notes": s.get("notes") or None,
            "before": s.get("before") or None, "after": s.get("after") or None, "stat": s.get("stat"), "query": s.get("query") or "", "notifs": s.get("notifs") or None,
            "pov": s.get("pov") or "", "problem": s.get("problem") or "", "steps": s.get("steps") or None, "question": s.get("question") or "", "answer": s.get("answer") or "",
            "marquee": s.get("marquee") or None}


def _browser() -> dict:
    """The Chrome Remotion renders with: ADS_CHROME when set; on macOS this machine's Chrome (the headless shell Remotion
    downloads there cannot load its ICU data); on Linux Remotion's own headless shell (installed in the Docker image)."""
    path = env("ADS_CHROME") or (rsch.chrome_path() if sys.platform == "darwin" else None)
    return {"browser": path, "chromeMode": "chrome-for-testing"} if path else {}


async def render_job(job: dict, on_progress=None) -> dict:
    """Runs backend/video/render.mjs on a job ({props, out, formats, composition?}); returns {format: seconds}."""
    node = shutil.which("node")
    if not node or not (VIDEO_DIR / "node_modules").exists():
        raise RuntimeError("Falta el motor de video en el servidor (Node y backend/video con npm install).")
    out = Path(job["out"])
    path = out / f"job-{secrets.token_hex(4)}.json"
    path.write_text(json.dumps({**job, **_browser()}))
    proc = await asyncio.create_subprocess_exec(node, str(VIDEO_DIR / "render.mjs"), str(path), cwd=str(VIDEO_DIR),
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
                if on_progress:
                    on_progress(round(last, 3))
            elif ev.get("done"):
                seconds[ev["format"]] = round(ev.get("seconds") or 0, 1)
            elif ev.get("error"):
                err = ev["error"]
        await proc.wait()
    except asyncio.CancelledError:
        proc.kill()
        raise
    finally:
        path.unlink(missing_ok=True)
    if proc.returncode != 0 or len(seconds) < len(job.get("formats") or FORMATS):
        raise RuntimeError(err or f"El render terminó con código {proc.returncode}")
    return seconds


async def render(user_id: str, build_id: str, ad_id: str, b) -> None:
    base = folder(user_id, build_id) / ad_id
    ad = get(user_id, build_id, ad_id)
    if not ad:
        return
    if _render_lock.locked():
        _update(user_id, build_id, ad_id, status="queued", step="En cola: hay otro video renderizándose")
    async with _render_lock:
        _update(user_id, build_id, ad_id, status="rendering", step="Renderizando los videos", progress=0.0)
        seconds = await render_job({"props": props(ad, base, b), "out": str(base), "formats": list(FORMATS)},
                                   lambda p: _update(user_id, build_id, ad_id, progress=p))
        _update(user_id, build_id, ad_id, status="ready", step="", progress=1.0, formats=seconds, version=int(time.time()))


# ------------------------------------------------------------------------------------------------------------ jobs

async def _wait_app(user: User, b) -> dict:
    """The app's screens and summary, made now if they are not there (or the app changed since)."""
    st = recover_app(user.id, b)
    if st.get("status") != "ready" or st.get("stale"):
        prepare(user, b)
    for _ in range(600):
        t = _running.get(f"app:{b.id}")
        if not t:
            break
        await asyncio.sleep(1)
    st = app_state(user.id, b.id)
    if st.get("status") != "ready":
        raise RuntimeError(st.get("error") or "No se pudo entender la app")
    return st


async def _make(user: User, b, ad_id: str, instructions: str) -> None:
    uid, bid = user.id, b.id
    base = folder(uid, bid) / ad_id
    base.mkdir(parents=True, exist_ok=True)
    try:
        _update(uid, bid, ad_id, status="capturing", step="Entendiendo tu app")
        st = await _wait_app(user, b)
        shots = []
        for s in st.get("screens") or []:
            src = folder(uid, bid) / "screens" / s["file"]
            if src.exists():
                shutil.copy(src, base / s["file"])
                shots.append(dict(s))
        t = template(get(uid, bid, ad_id).get("template"))
        _update(uid, bid, ad_id, status="writing", step="Escribiendo el guion")
        avoid = [a["script"]["angle"] for a in load(uid, bid) if a.get("script") and a["id"] != ad_id][-5:]
        src = source_for(user, b)
        script, by = await write_script(user, b, t, st.get("summary") or {}, shots, src.get("url") or "", instructions, avoid)
        if st.get("palette"):  # the app's own colours (tokens, CSS or its screens) over the model's guess
            script["palette"] = st["palette"]
        for s, cap in zip(shots, script["captions"]):
            s["caption"] = cap
        _update(uid, bid, ad_id, script=script, screens=[{k: v for k, v in s.items() if k != "text"} for s in shots], writer=by)
        await render(uid, bid, ad_id, b)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("ad %s", ad_id)
        _update(uid, bid, ad_id, status="error", step="", error=str(e)[:600])
    finally:
        _running.pop(ad_id, None)


LOOK_KEYS = {"bg": ("blobs", "grid", "solid", "gradient"), "fx": ("rise", "pop", "box", "type"), "font": FONTS, "theme": ("auto", "dark", "light", "accent", "paper")}


def clean_look(raw) -> dict:
    """The user's style choices for an ad: colours, font, background and text animation (only valid values)."""
    raw = raw if isinstance(raw, dict) else {}
    look = {k: raw[k] for k, ok in LOOK_KEYS.items() if raw.get(k) in ok}
    if isinstance(raw.get("palette"), dict):
        look["palette"] = palette(raw["palette"])
    return look


def start(user: User, b, instructions: str = "", template_id: str | None = None, look: dict | None = None) -> dict:
    from .tasks import spawn

    ads = load(user.id, b.id)
    if len(ads) >= MAX_ADS:
        raise ValueError(f"Ya hay {MAX_ADS} anuncios en este proyecto: borrá alguno para hacer otro.")
    t = template(template_id or ((app_state(user.id, b.id).get("recommended") or [{}])[0].get("id")))
    ad = {"id": secrets.token_hex(6), "created": time.time(), "updated": time.time(), "status": "capturing", "step": "Preparando", "progress": 0.0,
          "template": t["id"], "look": clean_look(look), "instructions": instructions[:600], "script": None, "screens": [], "formats": {}, "meta": None}
    _save(user.id, b.id, [ad] + ads)
    _running[ad["id"]] = spawn(_make(user, b, ad["id"], instructions[:600]))  # type: ignore[assignment]
    return ad


EDITABLE = ("name", "hook", "emphasis", "sub", "points", "captions", "cta", "cta_sub", "font", "palette", "primary_text", "headline", "description", "cta_type", "link",
            "lines", "chat", "notes_title", "notes", "before", "after", "stat", "query", "notifs", "pov", "problem", "steps", "question", "answer", "marquee")


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
            await render(user.id, b.id, ad_id, b)
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
