"""The app's own visual identity: a custom logo for the header and an icon for the browser tab, designed by the builder as
SVG (crisp at any size, editable like the rest of the code, free). Muse Team checks they exist when a build ends (and asks the
builder once if not), and at publish time renders the PNG sizes phones and link previews still ask for from that SVG.
"""
from __future__ import annotations

import asyncio
import html
import logging
import re
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

SKIP = re.compile(r"(^|/)(node_modules|dist|build|\.next|out|preview|design|research|\.tably|coverage)/")
ICON_SVG = re.compile(r"(^|/)(public|static|assets|src/assets|app|web/public|apps/web/public)/?([\w-]*/)?(icon|favicon|logo-mark|mark|app-icon)[\w-]*\.svg$|(^|/)app/icon\.svg$", re.I)
LOGO_SVG = re.compile(r"(logo|brand|wordmark)[\w-]*\.svg$", re.I)
ICON_LINK = re.compile(r"<link[^>]+rel=[\"'](shortcut )?icon[\"']", re.I)
WEB_DEPS = re.compile(r'"(react|react-dom|vue|svelte|@sveltejs/kit|next|nuxt|astro|solid-js|preact|vite)"\s*:')

PROMPT = """IDENTIDAD VISUAL DE LA APP: {gaps}. Diseñala ahora (y no cambies nada más):
- `{pub}/icon.svg`: el símbolo de «{title}», propio y reconocible, pensado para esta app y su rubro (nada de un ícono genérico de una librería tal cual, ni marcas de terceros). Cuadrado (viewBox="0 0 64 64"), fondo de color con esquinas redondeadas y el símbolo en contraste, formas simples y gruesas que se lean a 16 px, sin texto (como mucho una inicial).
- `{pub}/logo.svg`: el mismo símbolo + el nombre de la app al lado, horizontal, para el header.
- Colores y tipografía del diseño de la app (sus tokens / DESIGN.md), no colores al azar.
- Usá el logo en el header (y en login/registro/onboarding si existen) en lugar del ícono genérico que haya.
- En el HTML de entrada (o el layout raíz): <link rel="icon" href="/icon.svg" type="image/svg+xml"> y <link rel="apple-touch-icon" href="/apple-touch-icon.png"> (el PNG lo genera Muse Team al publicar a partir de icon.svg). En Next.js alcanza con `app/icon.svg`.
Al terminar emití <done>."""


def _web_files(files: dict[str, str]) -> dict[str, str]:
    return {p: t for p, t in files.items() if isinstance(t, str) and not SKIP.search(p)}


def is_web(files: dict[str, str]) -> bool:
    fs = _web_files(files)
    if any(p.endswith("app.json") and '"expo"' in t for p, t in fs.items()):
        return False  # mobile: app.json carries its own icon/splash
    return any(p.endswith(".html") for p in fs) or any(p.endswith("package.json") and WEB_DEPS.search(t) for p, t in fs.items())


def public_dir(files: dict[str, str]) -> str:
    """Where static files are served from: the web app's public/ (in a monorepo, the web package's)."""
    pubs = sorted({p.split("public/")[0] + "public" for p in files if "/public/" in f"/{p}" and not SKIP.search(p)}, key=len)
    web = [p for p in pubs if re.search(r"(^|/)(web|frontend|client|app)s?/", p + "/")]
    if web or pubs:
        return (web or pubs)[0]
    html_entry = next((p for p in files if p.endswith("index.html") and not SKIP.search(p)), "")
    return (html_entry.rsplit("/", 1)[0] + "/public").lstrip("/") if "/" in html_entry else "public"


def gaps(files: dict[str, str]) -> list[str]:
    """What is missing of the app's identity (empty when it has a logo and a tab icon, or it is not a web app)."""
    if not is_web(files):
        return []
    fs = _web_files(files)
    out = []
    has_icon = any(ICON_SVG.search(p) for p in fs) or any(re.search(r"(^|/)(public/favicon\.(ico|png|svg)|app/(icon|favicon)\.(svg|png|ico))$", p) for p in fs)
    linked = any(p.endswith(".html") and ICON_LINK.search(t) for p, t in fs.items()) or any(re.search(r"(^|/)app/(icon|favicon)\.", p) for p in fs)
    if not has_icon or not linked:
        out.append("falta el ícono de la pestaña (favicon) propio de la app")
    if not any(LOGO_SVG.search(p) for p in fs):
        out.append("el header no tiene un logo propio")
    return out


def prompt(files: dict[str, str], title: str) -> str:
    return PROMPT.format(gaps="; ".join(gaps(files)) or "revisá el logo y el favicon", pub=public_dir(files), title=title or "la app")


# ------------------------------------------------------------------------------------------------ PNG sizes at publish

SIZES = (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512))


def _icon_source(root: Path) -> Path | None:
    cands = [p for p in root.rglob("*.svg") if not SKIP.search(p.relative_to(root).as_posix()) and ICON_SVG.search(p.relative_to(root).as_posix())]
    cands.sort(key=lambda p: (0 if p.stem in ("icon", "favicon") else 1, len(p.as_posix())))
    return cands[0] if cands else None


async def _render(chrome: str, svg: Path, size: int, out: Path) -> bool:
    from .research import _run_for_file

    with tempfile.TemporaryDirectory(prefix="tably-icon-") as tmp:
        page = Path(tmp) / "icon.html"
        # the SVG as an <img> fills the square exactly; transparent around it (an icon with a rounded background keeps its corners)
        page.write_text(f"<!doctype html><html><body style='margin:0;background:transparent'><img src='{html.escape(svg.as_uri())}' style='display:block;width:{size}px;height:{size}px'></body></html>")
        cmd = [chrome, "--headless=new", "--no-sandbox", "--hide-scrollbars", "--disable-gpu", "--no-first-run", "--allow-file-access-from-files",
               "--default-background-color=00000000", f"--user-data-dir={tmp}/p", f"--window-size={size},{size}", f"--screenshot={out}", page.as_uri()]
        code = await asyncio.to_thread(_run_for_file, cmd, out, 30)
        return code == 0 and out.exists() and out.stat().st_size > 0


async def raster_icons(root: Path) -> list[str]:
    """apple-touch-icon.png (180), icon-192.png and icon-512.png next to the app's icon.svg when they are missing, and the
    apple-touch-icon link in the HTML entry points. Returns what was written. Never fails a publish."""
    from .research import chrome_path

    svg = _icon_source(root)
    chrome = chrome_path()
    if not svg or not chrome:
        return []
    done = []
    if svg.parent.name == "app" and svg.parent.parent.name != "public":  # Next.js app router: app/icon.svg + app/apple-icon.png are picked up by Next itself
        out = svg.parent / "apple-icon.png"
        if not out.exists() and await _render(chrome, svg, 180, out):
            done.append(out.relative_to(root).as_posix())
        return done
    try:
        for name, size in SIZES:
            out = svg.parent / name
            if not out.exists() and await _render(chrome, svg, size, out):
                done.append(out.relative_to(root).as_posix())
        href = "/" + "apple-touch-icon.png"
        if (svg.parent / "apple-touch-icon.png").exists():
            for page in [p for p in root.rglob("index.html") if not SKIP.search(p.relative_to(root).as_posix())][:6]:
                text = page.read_text(errors="replace")
                if "apple-touch-icon" in text or "<head" not in text.lower():
                    continue
                m = re.search(r"<head[^>]*>", text, re.I)
                page.write_text(text[:m.end()] + f'\n    <link rel="apple-touch-icon" href="{href}">' + text[m.end():])
                done.append(page.relative_to(root).as_posix())
    except Exception as e:  # noqa: BLE001
        log.warning("icon rendering failed: %s", e)
    return done
