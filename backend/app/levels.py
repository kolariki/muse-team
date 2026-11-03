"""Growth levels: the strict ladder every project climbs, step by step, and what the team is held to.

Level 1 · En línea     — built from the brief, approved by the council and published on a public URL. From here it can be listed on the marketplace.
Level 2 · Medido       — Muse Team Analytics in the app and real visits coming in.
Level 3 · Visible      — SEO: titles, descriptions, social cards, robots/sitemap, icons.
Level 4 · Monetizado   — payments, pricing, legal pages.

Each level is a list of checks evaluated on the real project (files, council verdict, Muse Cloud record, analytics hits).
The % is how much of the *next* level is done. The council and the builder get the pending checks of the level the project is
climbing and must treat them as blocking: nothing else ships before them.

Also here: the analytics collector (the `/a.js` snippet + hits table) and the marketplace listings (with ownership transfer).
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from .auth import _db, user_dir
from .config import DATA_DIR, env

log = logging.getLogger("arena.levels")

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS analytics_hits (
            site TEXT NOT NULL, ts REAL NOT NULL, kind TEXT NOT NULL, path TEXT, ref TEXT, ua TEXT, name TEXT)"""
    )
    _c.execute("CREATE INDEX IF NOT EXISTS analytics_hits_site ON analytics_hits (site, ts)")
    if "sid" not in [r[1] for r in _c.execute("PRAGMA table_info(analytics_hits)")]:  # anonymous per-tab id: who is live right now
        _c.execute("ALTER TABLE analytics_hits ADD COLUMN sid TEXT")
    _c.execute(
        """CREATE TABLE IF NOT EXISTS market_listings (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, build_id TEXT NOT NULL, slug TEXT, title TEXT NOT NULL,
            pitch TEXT, price_usd REAL, level INTEGER NOT NULL, status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
            transferred_to TEXT)"""
    )

# ------------------------------------------------------------------------------------------------ the ladder

LEVELS: list[dict[str, Any]] = [
    {
        "n": 1, "id": "live", "label": "En línea", "label_en": "Live",
        "goal": "La app existe, el consejo la aprobó y cualquiera puede abrirla en una URL pública.",
        "goal_en": "The app exists, the council approved it and anyone can open it on a public URL.",
        "unlocks": "Se puede publicar en el marketplace.", "unlocks_en": "Can be listed on the marketplace.",
    },
    {
        "n": 2, "id": "measured", "label": "Medido", "label_en": "Measured",
        "goal": "Sabés cuánta gente entra, qué hace y qué falla: Muse Team Analytics en la app y visitas reales.",
        "goal_en": "You know how many people come in, what they do and what breaks: Muse Team Analytics in the app and real visits.",
        "unlocks": "El marketplace muestra tus visitas reales.", "unlocks_en": "The marketplace shows your real visits.",
    },
    {
        "n": 3, "id": "visible", "label": "Visible", "label_en": "Visible",
        "goal": "Buscadores y redes entienden la app: títulos, descripciones, tarjetas sociales, robots/sitemap e íconos.",
        "goal_en": "Search engines and social networks understand the app: titles, descriptions, social cards, robots/sitemap and icons.",
        "unlocks": "Lista para crecer sola.", "unlocks_en": "Ready to grow on its own.",
    },
    {
        "n": 4, "id": "monetized", "label": "Monetizado", "label_en": "Monetized",
        "goal": "La app cobra: pagos integrados, página de precios y páginas legales.",
        "goal_en": "The app charges: payments integrated, pricing page and legal pages.",
        "unlocks": "Negocio completo, listo para venderse al mejor precio.", "unlocks_en": "A full business, ready to sell at its best price.",
    },
]
MAX_LEVEL = len(LEVELS)

# the checks per level. `who`: team (the builder/council can do it in code) | user (an action in Muse Team) | world (comes from real usage)
CHECKS: dict[int, list[dict[str, str]]] = {
    1: [
        {"id": "built", "who": "team", "label": "Construida completa según el brief (todas las etapas, sin placeholders)", "label_en": "Built in full from the brief (every stage, no placeholders)"},
        {"id": "readme", "who": "team", "label": "README.md con cómo instalar, configurar y correr", "label_en": "README.md with how to install, configure and run"},
        {"id": "approved", "who": "team", "label": "Aprobada por el consejo (sin bloqueantes pendientes)", "label_en": "Approved by the council (no blocking items left)"},
        {"id": "published", "who": "user", "label": "Publicada en una URL pública (Muse Cloud)", "label_en": "Published on a public URL (Muse Cloud)"},
    ],
    2: [
        {"id": "analytics", "who": "team", "label": "Muse Team Analytics instalado: el snippet `/a.js` con `data-site` en cada página", "label_en": "Muse Team Analytics installed: the `/a.js` snippet with `data-site` on every page"},
        {"id": "events", "who": "team", "label": "Eventos de las acciones clave (`tably.track('nombre')` o `data-track`), al menos 3", "label_en": "Events on the key actions (`tably.track('name')` or `data-track`), at least 3"},
        {"id": "republished", "who": "user", "label": "Versión con analytics publicada", "label_en": "The version with analytics is published"},
        {"id": "visits", "who": "world", "label": "Visitas reales recibidas (al menos 10 páginas vistas)", "label_en": "Real visits received (at least 10 page views)"},
    ],
    3: [
        {"id": "meta", "who": "team", "label": "<title> y <meta name=\"description\"> en cada página", "label_en": "<title> and <meta name=\"description\"> on every page"},
        {"id": "social", "who": "team", "label": "Tarjetas sociales: og:title, og:description, og:image y twitter:card", "label_en": "Social cards: og:title, og:description, og:image and twitter:card"},
        {"id": "crawl", "who": "team", "label": "robots.txt y sitemap.xml en la raíz pública", "label_en": "robots.txt and sitemap.xml at the public root"},
        {"id": "icons", "who": "team", "label": "favicon y manifest.webmanifest", "label_en": "favicon and manifest.webmanifest"},
        {"id": "republished", "who": "user", "label": "Versión con SEO publicada", "label_en": "The version with SEO is published"},
    ],
    4: [
        {"id": "payments", "who": "team", "label": "Pagos integrados (Stripe, Mercado Pago, Lemon Squeezy o Paddle) con claves en .env.example", "label_en": "Payments integrated (Stripe, Mercado Pago, Lemon Squeezy or Paddle) with keys in .env.example"},
        {"id": "pricing", "who": "team", "label": "Página o sección de precios con planes y botón de pago", "label_en": "Pricing page or section with plans and a pay button"},
        {"id": "legal", "who": "team", "label": "Términos de uso y política de privacidad enlazadas desde la app", "label_en": "Terms of use and privacy policy linked from the app"},
        {"id": "republished", "who": "user", "label": "Versión monetizada publicada", "label_en": "The monetized version is published"},
    ],
}

_TEXT_EXT = (".html", ".htm", ".tsx", ".jsx", ".ts", ".js", ".mjs", ".vue", ".svelte", ".astro", ".md", ".json", ".xml", ".txt", ".webmanifest", ".py", ".css", ".example", ".env")
_SKIP = ("node_modules/", "dist/", "build/", ".git/", "preview/", "design/", "research/", ".next/", "out/")
_PAGE_RE = re.compile(r"\.(html?|tsx|jsx|vue|svelte|astro)$")


def _code(files: dict[str, str]) -> dict[str, str]:
    """The project's own source (not the prototype, the design kit, the research notes or build output)."""
    return {p: c for p, c in files.items() if p.lower().endswith(_TEXT_EXT) and not any(s in p for s in _SKIP) and not p.startswith("preview")}


def _pages(code: dict[str, str]) -> dict[str, str]:
    """Entry pages: index.html plus any html at the root / public / pages."""
    html = {p: c for p, c in code.items() if p.endswith((".html", ".htm"))}
    return html or {p: c for p, c in code.items() if _PAGE_RE.search(p) and ("app" in p.lower() or "layout" in p.lower() or "index" in p.lower() or "main" in p.lower())}


def _any(code: dict[str, str], pattern: str, flags: int = re.I) -> bool:
    rx = re.compile(pattern, flags)
    return any(rx.search(c) for c in code.values())


def _all_pages(pages: dict[str, str], pattern: str) -> bool:
    rx = re.compile(pattern, re.I | re.S)
    return bool(pages) and all(rx.search(c) for c in pages.values())


# ------------------------------------------------------------------------------------------------ evaluation

def _approved_then_improved(versions: list[dict]) -> tuple[bool, str | None]:
    """The council approved a version and what came after only applied the improvements that same approving council suggested
    (no blocking item, nothing else): the approval holds. Otherwise applying a suggestion would undo the approval."""
    last = next((i for i in range(len(versions) - 1, -1, -1) if (versions[i].get("verdict") or {}).get("approved")), None)
    if last is None:
        return False, None
    approving = {versions[last].get("council_session")}
    for v in versions[last + 1:]:
        if v.get("trigger") != "council" or v.get("from_council") not in approving:
            return False, None
        if any((r.get("severity") or "mejora") == "bloqueante" for r in v.get("requested") or []):
            return False, None
        if v.get("council_session"):  # a council looked at it again: its verdict decides (handled above when it approved)
            return False, None
    return True, f"v{versions[last]['n']} aprobada · después solo mejoras sugeridas"

def _check(level: int, cid: str, b, files: dict[str, str], app: dict | None, hits: int) -> tuple[bool, str | None]:
    """→ (ok, evidence)."""
    code = _code(files)
    pages = _pages(code)
    versions = getattr(b, "versions", []) or []
    status = getattr(b, "status", "")
    live = bool(app and app.get("status") == "live" and app.get("url"))
    published_version = (app or {}).get("version") or 0 if live else 0
    if level == 1:
        if cid == "built":
            ok = bool(files) and status not in ("running", "reviewing", "design_review") and bool(versions) and bool(getattr(b, "done_text", "") or len(versions) > 1 or status in ("approved", "completed", "audited"))
            return ok, f"{len(files)} archivos · v{len(versions)}" if ok else None
        if cid == "readme":
            rd = next((c for p, c in files.items() if p.lower() in ("readme.md", "readme")), "")
            ok = len(rd.strip()) > 200 and bool(re.search(r"(npm|pnpm|yarn|bun|pip|uv|docker|python|node)\b", rd, re.I))
            return ok, "README.md" if ok else None
        if cid == "approved":
            v = versions[-1] if versions else None
            if bool(v and v.get("verdict") and v["verdict"].get("approved")) or status == "approved":
                return True, (f"v{v['n']} aprobada" if v else None)
            return _approved_then_improved(versions)
        if cid == "published":
            return live, (app or {}).get("url") if live else None
    if level == 2:
        if cid == "analytics":
            # the snippet only counts when it reports to THIS installation (one built on another Muse Team, e.g. a local one
            # pointing at localhost, sends its visits somewhere this dashboard never sees)
            base = re.escape(collector_url())
            ok = _all_pages(pages, rf"<script[^>]+src=[\"']{base}/a\.js[\"'][^>]*data-site=|data-site=[\"'][^\"']+[\"'][^>]*src=[\"']{base}/a\.js") or _any(code, rf"{base}/a\.js[\"'][^>]*data-site=")
            if not ok and _any(code, r"/a\.js[\"'][^>]*data-site="):
                return False, "el snippet apunta a otro Muse Team: hay que actualizarlo"
            return ok, "snippet /a.js" if ok else None
        if cid == "events":
            n = sum(len(re.findall(r"tably\.track\(\s*[\"'][^\"']+[\"']|data-track=[\"'][^\"']+[\"']", c)) for c in code.values())
            return n >= 3, f"{n} eventos" if n >= 3 else (f"{n} de 3" if n else None)
        if cid == "republished":
            ok = _republished(versions, published_version)
            return ok, (f"v{published_version} publicada" if ok else f"publicada v{published_version}, la actual es v{len(versions)}" if published_version else None)
        if cid == "visits":
            return hits >= 10, f"{hits} páginas vistas" if hits else None
    if level == 3:
        if cid == "meta":
            ok = _all_pages(pages, r"<title>[^<]{3,}</title>") and _all_pages(pages, r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"'][^\"']{20,}")
            return ok, "title + description" if ok else None
        if cid == "social":
            ok = all(_any(code, p) for p in (r"og:title", r"og:description", r"og:image", r"twitter:card"))
            return ok, "og + twitter" if ok else None
        if cid == "crawl":
            ok = any(p.endswith("robots.txt") for p in files) and any(p.endswith("sitemap.xml") for p in files)
            return ok, "robots.txt + sitemap.xml" if ok else None
        if cid == "icons":
            ok = _any(code, r"rel=[\"'](icon|shortcut icon|apple-touch-icon)[\"']") and any(p.endswith((".webmanifest", "manifest.json")) for p in files)
            return ok, "favicon + manifest" if ok else None
        if cid == "republished":
            ok = _republished(versions, published_version)
            return ok, (f"v{published_version} publicada" if ok else f"publicada v{published_version}, la actual es v{len(versions)}" if published_version else None)
    if level == 4:
        if cid == "payments":
            prov = next((n for n, rx in (("Stripe", r"stripe"), ("Mercado Pago", r"mercadopago|mercado\s*pago"), ("Lemon Squeezy", r"lemonsqueezy|lemon\.?squeezy"), ("Paddle", r"paddle")) if _any(code, rx)), None)
            env_ex = next((c for p, c in files.items() if p.endswith(".env.example")), "")
            ok = bool(prov) and bool(re.search(r"(STRIPE|MP_|MERCADOPAGO|LEMON|PADDLE)[A-Z_]*(KEY|TOKEN|SECRET)", env_ex))
            return ok, prov if ok else None
        if cid == "pricing":
            ok = _any(code, r"pricing|precios|planes\b|plans\b") and _any(code, r"checkout|suscrib|subscribe|comprar|buy now|pagar|pay\b")
            return ok, "precios + pago" if ok else None
        if cid == "legal":
            ok = _any(code, r"t[ée]rminos|terms of (use|service)") and _any(code, r"privacidad|privacy")
            return ok, "términos + privacidad" if ok else None
        if cid == "republished":
            ok = _republished(versions, published_version)
            return ok, (f"v{published_version} publicada" if ok else f"publicada v{published_version}, la actual es v{len(versions)}" if published_version else None)
    return False, None


def collector_url() -> str:
    """Where this installation receives analytics (the same base Muse Cloud uses)."""
    return (env("TABLY_CLOUD_URL") or "http://localhost:8000").rstrip("/")


def _republished(versions: list[dict], published_version: int) -> bool:
    return bool(published_version) and published_version >= len(versions) > 0


def hits_for(site: str | None, since: float = 0.0) -> int:
    if not site:
        return 0
    with _db() as c:
        return c.execute("SELECT COUNT(*) FROM analytics_hits WHERE site = ? AND kind = 'pageview' AND ts >= ?", (site, since)).fetchone()[0]


_cache: dict[str, tuple[str, dict]] = {}


def evaluate(b, app: dict | None) -> dict:
    """The project's level, the next level's checks and the % towards it. Cached on the signals that can change it."""
    files = getattr(b, "files", {}) or {}
    hits = hits_for((app or {}).get("slug"))
    versions = getattr(b, "versions", []) or []
    key = json.dumps([len(files), sum(len(c) for c in files.values()), getattr(b, "status", ""), len(versions), (versions[-1].get("verdict") if versions else None),
                      (app or {}).get("status"), (app or {}).get("version"), (app or {}).get("updated"), hits, bool(getattr(b, "done_text", ""))], default=str)
    cached = _cache.get(b.id)
    if cached and cached[0] == key:
        return cached[1]
    levels = []
    current = 0
    for lv in LEVELS:
        checks = []
        for ch in CHECKS[lv["n"]]:
            ok, ev = _check(lv["n"], ch["id"], b, files, app, hits)
            checks.append({**ch, "ok": ok, "evidence": ev})
        done = sum(1 for c in checks if c["ok"])
        complete = done == len(checks)
        levels.append({**lv, "checks": checks, "done": done, "total": len(checks), "pct": int(round(100 * done / len(checks))), "complete": complete})
    for lv in levels:  # levels are strict: level N counts only when every level below is complete
        if lv["complete"] and current == lv["n"] - 1:
            current = lv["n"]
    nxt = next((lv for lv in levels if lv["n"] == current + 1), None)
    out = {
        "level": current, "max": MAX_LEVEL, "label": next((lv["label"] for lv in levels if lv["n"] == current), None), "label_en": next((lv["label_en"] for lv in levels if lv["n"] == current), None),
        "next": nxt["n"] if nxt else None, "next_label": nxt["label"] if nxt else None, "next_label_en": nxt["label_en"] if nxt else None,
        "pct": nxt["pct"] if nxt else 100, "pending": [c for c in (nxt["checks"] if nxt else []) if not c["ok"]],
        "levels": levels, "market_ready": current >= 1, "visits": hits,
    }
    _cache[b.id] = (key, out)
    return out


def team_block(ev: dict, slug: str | None, public_url: str) -> str:
    """What the council and the builder are held to: the ladder, the level being climbed and its pending checks (team ones first)."""
    nxt = ev.get("next")
    if not nxt:
        return "\n\nNIVELES: el proyecto ya está en el nivel 4 (Monetizado), el máximo. Sostené la calidad: nada de lo logrado puede romperse."
    lv = next(l for l in ev["levels"] if l["n"] == nxt)
    ladder = " → ".join(f"{l['n']} {l['label']}" for l in LEVELS)
    done = [c for c in lv["checks"] if c["ok"]]
    pend = [c for c in lv["checks"] if not c["ok"]]
    lines = [f"- [{'team' if c['who'] == 'team' else 'usuario' if c['who'] == 'user' else 'mundo'}] {c['label']}" for c in pend]
    site = slug or "<slug-de-la-app>"
    how = ""
    if nxt == 2:
        how = (f"\nCÓMO SE INSTALA TABLY ANALYTICS: en cada página HTML (o en el layout raíz) agregá exactamente "
               f"`<script defer src=\"{public_url}/a.js\" data-site=\"{site}\"></script>`. El script registra las páginas vistas y los errores solo. "
               f"Para las acciones clave llamá `window.tably.track('nombre_del_evento')` o poné `data-track=\"nombre\"` en el botón o link. Sin cookies, sin datos personales.")
    elif nxt == 3:
        how = ("\nCÓMO: <title> y <meta name=\"description\"> (20+ caracteres) en cada página; og:title, og:description, og:image (imagen 1200×630 en public/) y twitter:card; "
               "public/robots.txt (Allow: / y la línea Sitemap:) y public/sitemap.xml con las rutas; favicon (rel=\"icon\") y manifest.webmanifest con name, icons y theme_color.")
    elif nxt == 4:
        how = ("\nCÓMO: integrá el proveedor de pagos que mejor calce (Stripe por defecto: Checkout o Payment Links; Mercado Pago si el producto es de Latinoamérica), "
               "con TODAS sus claves en .env.example; una página /pricing (o sección) con planes y botón que lleve al checkout; páginas /terms y /privacy enlazadas desde el footer.")
    return (
        f"\n\nNIVELES DE CRECIMIENTO (el equipo los sigue A RAJATABLA, en orden; no se pasa de nivel sin cumplir TODO el anterior): {ladder}.\n"
        f"NIVEL ACTUAL DEL PROYECTO: {ev['level']} de {MAX_LEVEL}. ESTA RONDA TRABAJA PARA EL NIVEL {nxt} · {lv['label']} ({lv['goal']}) — {lv['pct']}% cumplido.\n"
        + (("YA CUMPLIDO: " + "; ".join(c["label"] for c in done) + ".\n") if done else "")
        + "PENDIENTE PARA SUBIR DE NIVEL (en este orden; lo marcado [team] lo resuelve el constructor y es BLOQUEANTE para el consejo; [usuario] lo hace el usuario en Muse Team con un clic; [mundo] llega con el uso real):\n"
        + "\n".join(lines)
        + how
        + "\nREGLA: nada que no sea de este nivel entra como bloqueante. Mejoras de otros niveles solo como [mejora], y nunca a costa de los pendientes de arriba."
    )


# ------------------------------------------------------------------------------------------------ analytics collector

LIVE_WINDOW = 120  # a visitor is «live» if their tab pinged within the last 2 minutes (the snippet pings every 30 s while visible)

SNIPPET_JS = r"""(function(){var s=document.currentScript;if(!s)return;var site=s.getAttribute('data-site');if(!site)return;
if(!/^https?:$/.test(location.protocol))return;
var base=s.src.replace(/\/a\.js(\?.*)?$/,'');var last='';
function rid(){return Math.random().toString(36).slice(2,12)}
var sid,vid;try{sid=sessionStorage.getItem('_tbly');if(!sid){sid=rid();sessionStorage.setItem('_tbly',sid)}}catch(e){sid=rid()}
try{vid=localStorage.getItem('_tblyv');if(!vid){vid=rid();localStorage.setItem('_tblyv',vid)}}catch(e){vid=sid}
var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}
function send(kind,name,props){try{var body=JSON.stringify({k:kind,n:name||null,p:location.pathname+location.search+(location.hash&&location.hash.length<60?location.hash:''),r:document.referrer||null,t:Date.now(),s:sid,v:vid,tz:tz,l:navigator.language||'',w:(screen&&screen.width?screen.width+'x'+screen.height:''),props:props||null});
if(navigator.sendBeacon){navigator.sendBeacon(base+'/api/a/'+site,new Blob([body],{type:'text/plain'}))}else{fetch(base+'/api/a/'+site,{method:'POST',headers:{'content-type':'text/plain'},body:body,keepalive:true}).catch(function(){})}}catch(e){}}
function page(){var k=location.pathname+location.search+location.hash;if(k===last)return;last=k;send('pageview')}
window.tably=window.tably||{};window.tably.track=function(name,props){send('event',String(name||'').slice(0,80),props)};
window.tably.identify=function(p){if(p&&typeof p==='object')send('identify',null,{email:p.email||'',name:p.name||'',id:p.id||''})};
function label(el){var t=el.getAttribute('aria-label')||el.getAttribute('title')||(el.innerText||el.value||'').replace(/\s+/g,' ').trim()||el.id||el.tagName.toLowerCase();return String(t).slice(0,60)}
document.addEventListener('click',function(e){var t=e.target;if(!t||!t.closest)return;var tr=t.closest('[data-track]');if(tr){send('event',tr.getAttribute('data-track'));return}
var el=t.closest('a,button,[role=button],[role=tab],[role=menuitem],summary,input[type=submit],input[type=button],label');if(el&&!(el.tagName==='INPUT'&&/password|text|email/.test(el.type)))send('click',label(el))},true);
window.addEventListener('error',function(e){send('error',String(e&&e.message||'error').slice(0,120))});
var ps=history.pushState;history.pushState=function(){ps.apply(this,arguments);setTimeout(page,0)};window.addEventListener('popstate',function(){setTimeout(page,0)});window.addEventListener('hashchange',function(){setTimeout(page,0)});
setInterval(function(){if(document.visibilityState==='visible')send('ping')},30000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')send('ping')});
page();})();"""


from .observe import VARIANT_JS  # noqa: E402  experiments live inside the same snippet (they use its visitor id and sender)

SNIPPET_JS = SNIPPET_JS.replace("page();})();", VARIANT_JS + "\npage();})();")


def record_hit(site: str, body: dict, ua: str | None) -> None:
    from . import analytics as an

    kind = str(body.get("k") or "pageview")[:16]
    if kind not in ("pageview", "event", "error", "ping", "click", "identify", "exp"):
        return
    sid = str(body.get("s") or "")[:16] or None
    x = an.enrich(body, ua)
    if x["device"] == "bot":
        return
    if kind == "identify":
        an.identify(site[:80], x["vid"] or sid, body.get("props") if isinstance(body.get("props"), dict) else None)
        return
    with _db() as c:
        if kind == "ping":  # presence only: one row per tab, refreshed (pings never count as visits)
            c.execute("DELETE FROM analytics_hits WHERE site = ? AND kind = 'ping' AND sid = ?", (site[:80], sid))
        c.execute("""INSERT INTO analytics_hits (site, ts, kind, path, ref, ua, name, sid, vid, country, device, os, browser, lang, tz, screen, props)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                  (site[:80], time.time(), kind, str(body.get("p") or "/")[:300], (str(body.get("r"))[:300] if body.get("r") else None), (ua or "")[:200],
                   (str(body.get("n"))[:80] if body.get("n") else None), sid, x["vid"], x["country"], x["device"], x["os"], x["browser"], x["lang"], x["tz"], x["screen"], x["props"]))


def stats(site: str | None) -> dict:
    """What the owner sees: totals, last 14 days, top pages, events, errors."""
    if not site:
        return {"site": None, "pageviews": 0, "events": 0, "errors": 0, "live": 0, "live_pages": [], "last_30m": 0, "days": [], "pages": [], "top_events": [], "last_errors": []}
    now = time.time()
    with _db() as c:
        tot = {k: n for k, n in c.execute("SELECT kind, COUNT(*) FROM analytics_hits WHERE site = ? GROUP BY kind", (site,))}
        days = [{"day": d, "n": n} for d, n in c.execute("SELECT date(ts, 'unixepoch') d, COUNT(*) FROM analytics_hits WHERE site = ? AND kind = 'pageview' AND ts >= ? GROUP BY d ORDER BY d", (site, now - 14 * 86400))]
        pages = [{"path": p, "n": n} for p, n in c.execute("SELECT path, COUNT(*) n FROM analytics_hits WHERE site = ? AND kind = 'pageview' GROUP BY path ORDER BY n DESC LIMIT 8", (site,))]
        evs = [{"name": p, "n": n} for p, n in c.execute("SELECT name, COUNT(*) n FROM analytics_hits WHERE site = ? AND kind = 'event' GROUP BY name ORDER BY n DESC LIMIT 8", (site,))]
        errs = [{"name": p, "ts": t} for p, t in c.execute("SELECT name, ts FROM analytics_hits WHERE site = ? AND kind = 'error' ORDER BY ts DESC LIMIT 5", (site,))]
        # live: distinct tabs with any signal in the window, and the page each one is on now
        live_rows = c.execute("SELECT sid, path, MAX(ts) FROM analytics_hits WHERE site = ? AND sid IS NOT NULL AND ts >= ? GROUP BY sid", (site, now - LIVE_WINDOW)).fetchall()
        last_30m = c.execute("SELECT COUNT(*) FROM analytics_hits WHERE site = ? AND kind = 'pageview' AND ts >= ?", (site, now - 1800)).fetchone()[0]
        c.execute("DELETE FROM analytics_hits WHERE kind = 'ping' AND ts < ?", (now - 86400,))  # presence rows are only useful for a while
    live_pages: dict[str, int] = {}
    for _sid, path, _ts in live_rows:
        live_pages[path or "/"] = live_pages.get(path or "/", 0) + 1
    return {"site": site, "pageviews": tot.get("pageview", 0), "events": tot.get("event", 0), "errors": tot.get("error", 0),
            "live": len(live_rows), "live_pages": [{"path": p, "n": n} for p, n in sorted(live_pages.items(), key=lambda x: -x[1])[:6]], "last_30m": last_30m,
            "days": days, "pages": pages, "top_events": evs, "last_errors": errs}


# ------------------------------------------------------------------------------------------------ marketplace

def _row(r) -> dict:
    return dict(r)


def listing_for(user_id: str, build_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM market_listings WHERE user_id = ? AND build_id = ? AND status != 'transferred' ORDER BY updated DESC", (user_id, build_id)).fetchone()
    return _row(r) if r else None


def list_market() -> list[dict]:
    with _db() as c:
        rows = [_row(r) for r in c.execute("SELECT * FROM market_listings WHERE status = 'active' ORDER BY level DESC, updated DESC")]
    for r in rows:
        r["visits"] = hits_for(r.get("slug"))
        r["visits_7d"] = hits_for(r.get("slug"), time.time() - 7 * 86400)
    return rows


def upsert_listing(user_id: str, session_id: str, build_id: str, slug: str | None, title: str, pitch: str, price_usd: float | None, level: int) -> dict:
    cur = listing_for(user_id, build_id)
    now = time.time()
    row = {"id": cur["id"] if cur else secrets.token_hex(6), "user_id": user_id, "session_id": session_id, "build_id": build_id, "slug": slug, "title": title[:120],
           "pitch": pitch[:1200], "price_usd": price_usd, "level": level, "status": "active", "created": cur["created"] if cur else now, "updated": now, "transferred_to": None}
    with _db() as c:
        c.execute(
            """INSERT INTO market_listings (id, user_id, session_id, build_id, slug, title, pitch, price_usd, level, status, created, updated, transferred_to)
               VALUES (:id, :user_id, :session_id, :build_id, :slug, :title, :pitch, :price_usd, :level, :status, :created, :updated, :transferred_to)
               ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, pitch=excluded.pitch, price_usd=excluded.price_usd, level=excluded.level, status=excluded.status, updated=excluded.updated""",
            row,
        )
    return row


def withdraw_listing(user_id: str, build_id: str) -> None:
    with _db() as c:
        c.execute("UPDATE market_listings SET status = 'withdrawn', updated = ? WHERE user_id = ? AND build_id = ? AND status = 'active'", (time.time(), user_id, build_id))


def refresh_level(user_id: str, build_id: str, level: int) -> None:
    with _db() as c:
        c.execute("UPDATE market_listings SET level = ?, updated = ? WHERE user_id = ? AND build_id = ? AND status = 'active'", (level, time.time(), user_id, build_id))


def transfer(listing: dict, new_user_id: str, workdir_root: Path) -> dict:
    """Ownership transfer: the saved session, brief, build, versions and git-less workdir move to the new owner; the Muse Cloud app
    and the listing follow. The public URL does not change."""
    old, sid, bid = listing["user_id"], listing["session_id"], listing["build_id"]
    src, dst = user_dir(old), user_dir(new_user_id)
    moved = []
    # the council rounds of this build are sessions of their own (named by their own id): they go with the project
    extra = []
    for p in src.glob("*.json"):
        if p.name.startswith(sid) or ".build." in p.name:
            continue
        try:
            head = p.read_text(errors="replace")
            if f'"build_id": "{bid}"' in head and '"review_of"' in head:
                extra.append(p)
        except OSError:
            continue
    for p in sorted(src.glob(f"{sid}.*")) + extra:
        target = dst / p.name
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.move(str(p), str(target))
        moved.append(p.name)
    wd_old, wd_new = workdir_root / old / bid, workdir_root / new_user_id / bid
    if wd_old.exists():
        wd_new.parent.mkdir(parents=True, exist_ok=True)
        if wd_new.exists():
            shutil.rmtree(wd_new)
        shutil.move(str(wd_old), str(wd_new))
    with _db() as c:
        c.execute("UPDATE cloud_apps SET user_id = ?, updated = ? WHERE user_id = ? AND build_id = ?", (new_user_id, time.time(), old, bid))
        c.execute("UPDATE market_listings SET status = 'transferred', transferred_to = ?, updated = ? WHERE id = ?", (new_user_id, time.time(), listing["id"]))
    log.info("transferred build %s/%s from %s to %s (%d files)", sid, bid, old, new_user_id, len(moved))
    return {"ok": True, "moved": moved, "session_id": sid, "build_id": bid}


def user_by_email(email: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT id, email, name FROM users WHERE lower(email) = lower(?)", (email.strip(),)).fetchone()
    return dict(r) if r else None


def public_listing(r: dict, owner_name: str | None = None) -> dict:
    return {k: r.get(k) for k in ("id", "slug", "title", "pitch", "price_usd", "level", "status", "created", "updated", "visits", "visits_7d")} | {"owner": owner_name, "url": None}
