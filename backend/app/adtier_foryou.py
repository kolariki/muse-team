"""AdTier «Para vos»: the ads a person needs, not the whole catalogue.

A profile says who the ads are for: what the business does, the sector, B2B or B2C, the country, the audience and the goal.
- From a project built in Tably it is written by itself (Meta Muse reads the brief, the README and the app summary of «Anuncios»).
- Otherwise the person answers a few questions (and can add the website or a document); Muse turns that into the profile.

With the profile:
- the catalogue is ranked for it (sector, country/region, language, format, keywords, tier), each match with its reasons;
- a search finds real ads of that sector and country on YouTube (yt-dlp search, never downloading the video) and they go through
  the same ingest as the catalogue (frames, transcript, Muse analysis, template). They are drafts without external evidence: the
  person sees them in their section, and they reach the public catalogue only if the admin reviews and publishes them.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import secrets
import time

import httpx

from . import adtier as at
from . import ads as adsmod
from .auth import User, _db, user_dir

log = logging.getLogger("arena.adtier.foryou")

SECTORS: list[tuple[str, str, str]] = [  # id, es, en
    ("food", "Gastronomía y restaurantes", "Food and restaurants"), ("retail", "Comercio y retail", "Retail"),
    ("ecommerce", "Tienda online / e-commerce", "Online store / e-commerce"), ("fashion", "Moda y belleza", "Fashion and beauty"),
    ("health", "Salud y bienestar", "Health and wellness"), ("fitness", "Deporte y fitness", "Sports and fitness"),
    ("education", "Educación y cursos", "Education and courses"), ("software", "Software / SaaS", "Software / SaaS"),
    ("apps", "Apps móviles", "Mobile apps"), ("finance", "Finanzas, bancos y seguros", "Finance, banking and insurance"),
    ("real_estate", "Inmobiliaria y construcción", "Real estate and construction"), ("automotive", "Automotor", "Automotive"),
    ("travel", "Turismo y viajes", "Travel and tourism"), ("services", "Servicios profesionales", "Professional services"),
    ("industry", "Industria y manufactura", "Industry and manufacturing"), ("agro", "Agro", "Agriculture"),
    ("logistics", "Logística y transporte", "Logistics and transport"), ("media", "Entretenimiento y medios", "Entertainment and media"),
    ("home", "Hogar y decoración", "Home and decor"), ("pets", "Mascotas", "Pets"), ("drinks", "Bebidas", "Drinks"),
    ("consumer", "Alimentos y consumo masivo", "Food and consumer goods"), ("telecom", "Telecomunicaciones", "Telecom"),
    ("nonprofit", "ONG y causas", "Non-profits and causes"), ("public", "Gobierno y sector público", "Government and public sector"),
    ("other", "Otro", "Other"),
]
KINDS = ("b2b", "b2c", "both", "startup", "freelance", "nonprofit", "app")
GOALS = ("awareness", "leads", "sales", "downloads", "signups")
LATAM = {"AR", "BR", "CL", "CO", "MX", "PE", "UY", "PY", "BO", "EC", "VE", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "CU", "PR"}
AD_WORDS = re.compile(r"\b(anuncio|comercial|publicidad|publicitario|spot|campaña|campanha|propaganda|commercial|advert|ad|ads|tvc|promo|promocional|reel)\b", re.I)
COUNTRY_NAMES = {"AR": "Argentina", "MX": "México", "CO": "Colombia", "CL": "Chile", "PE": "Perú", "UY": "Uruguay", "PY": "Paraguay", "BO": "Bolivia",
                 "EC": "Ecuador", "VE": "Venezuela", "CR": "Costa Rica", "PA": "Panamá", "GT": "Guatemala", "DO": "República Dominicana", "PR": "Puerto Rico",
                 "BR": "Brasil", "ES": "España", "US": "USA", "GB": "UK", "CA": "Canada", "FR": "France", "IT": "Italia", "DE": "Deutschland", "PT": "Portugal"}
STOP = {"para", "como", "pero", "todo", "todos", "toda", "todas", "país", "familiar", "vende", "vendemos", "hace", "hacemos", "sobre", "desde", "también",
        "nuestro", "nuestra", "nuestros", "empresa", "somos", "tiene", "tenemos", "están", "esta", "este", "with", "that", "from", "online", "abierta"}
PLACEMENTS = {"reels": (6, 60), "stories": (5, 20), "long": (6, 180)}  # where the ads will run → the length of the references (s)
MAX_FOUND = 12  # new videos per search: each one is two analysis calls on the person's own key

with _db() as _c:
    _c.executescript("""
    CREATE TABLE IF NOT EXISTS adtier_profiles (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT, build_id TEXT,
        answers TEXT, data TEXT NOT NULL, searched REAL, created REAL NOT NULL, updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS adtier_profile_videos (
        profile_id TEXT NOT NULL, video_id TEXT NOT NULL, query TEXT, created REAL NOT NULL, PRIMARY KEY (profile_id, video_id));
    CREATE INDEX IF NOT EXISTS adtier_profiles_user ON adtier_profiles (user_id);
    """)
_search_jobs: dict[str, asyncio.Task] = {}


# ------------------------------------------------------------------------------------------------------------ storage

def _profile(r) -> dict:
    d = dict(r)
    d["data"] = json.loads(d["data"] or "{}")
    d["answers"] = json.loads(d["answers"] or "{}")
    return d


def profiles(user_id: str) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM adtier_profiles WHERE user_id = ? ORDER BY updated DESC", (user_id,)).fetchall()
    return [_profile(r) | {"searching": r["id"] in _search_jobs, "found": len(found_ids(r["id"]))} for r in rows]


def get(user_id: str, pid: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM adtier_profiles WHERE id = ? AND user_id = ?", (pid, user_id)).fetchone()
    return _profile(r) | {"searching": pid in _search_jobs} if r else None


def remove(user_id: str, pid: str) -> None:
    with _db() as c:
        c.execute("DELETE FROM adtier_profile_videos WHERE profile_id IN (SELECT id FROM adtier_profiles WHERE id = ? AND user_id = ?)", (pid, user_id))
        c.execute("DELETE FROM adtier_profiles WHERE id = ? AND user_id = ?", (pid, user_id))


def found_ids(pid: str) -> list[str]:
    with _db() as c:
        return [r[0] for r in c.execute("SELECT video_id FROM adtier_profile_videos WHERE profile_id = ? ORDER BY created DESC", (pid,))]


def owns_video(user_id: str, video_id: str) -> bool:
    """A video found for one of the person's profiles: they can open it before the admin publishes it."""
    with _db() as c:
        return bool(c.execute("""SELECT 1 FROM adtier_profile_videos pv JOIN adtier_profiles p ON p.id = pv.profile_id
                                 WHERE pv.video_id = ? AND p.user_id = ?""", (video_id, user_id)).fetchone())


# ------------------------------------------------------------------------------------------------------------ the person's Tably projects

def projects(user: User) -> list[dict]:
    """Every session with a saved build: the title and the newest build, to build the profile from."""
    d = user_dir(user.id)
    out: dict[str, dict] = {}
    for p in sorted(d.glob("*.build.*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        sid, _, bid = p.name.removesuffix(".json").partition(".build.")
        if sid in out:
            continue
        try:
            cfg = json.loads((d / f"{sid}.json").read_text())["config"]
        except Exception:  # noqa: BLE001
            continue
        out[sid] = {"session_id": sid, "build_id": bid, "title": cfg.get("title") or cfg.get("topic", "")[:80], "updated": p.stat().st_mtime}
    return list(out.values())[:40]


def _project_text(user: User, sid: str, bid: str) -> tuple[str, str]:
    """(title, what the project is) from the session, the newest brief, the README and the app summary of «Anuncios»."""
    d = user_dir(user.id)
    try:
        cfg = json.loads((d / f"{sid}.json").read_text())["config"]
    except Exception:  # noqa: BLE001
        raise ValueError("No encontré ese proyecto")
    title = cfg.get("title") or cfg.get("topic", "")[:80]
    parts = [f"PROYECTO: {title}", f"IDEA: {cfg.get('topic', '')[:2000]}"]
    briefs = sorted(d.glob(f"{sid}.brief.*.md"), key=lambda x: x.stat().st_mtime)
    if briefs:
        parts.append("BRIEF:\n" + briefs[-1].read_text()[:6000])
    try:
        files = (json.loads((d / f"{sid}.build.{bid}.json").read_text()).get("files") or {})
        readme = next((v for k, v in files.items() if k.lower().endswith("readme.md") and isinstance(v, str)), "")
        if readme:
            parts.append("README:\n" + readme[:3000])
    except Exception:  # noqa: BLE001
        pass
    summary = (adsmod.app_state(user.id, bid) or {}).get("summary")
    if summary:
        parts.append("RESUMEN DE LA APP (de sus pantallas):\n" + json.dumps(summary, ensure_ascii=False)[:3000])
    return title, "\n\n".join(parts)


# ------------------------------------------------------------------------------------------------------------ the profile

PROFILE_SYSTEM = """Sos estratega de publicidad. Con lo que te paso de un negocio o proyecto escribí su perfil para buscar anuncios en video
que le sirvan de referencia (de su sector, su país o región y su tipo de cliente). Respondé SOLO un objeto JSON:
{"name": "nombre corto del negocio", "summary": "qué hace, en una oración", "sector": "<uno de los ids de SECTORES>",
 "kind": "b2b|b2c|both|startup|freelance|nonprofit|app", "country": "código ISO de 2 letras o vacío", "language": "es|en|pt|...",
 "audience": "a quién le vende, concreto", "goal": "awareness|leads|sales|downloads|signups",
 "industries": ["3 a 6 industrias en inglés, en minúscula, como las del catálogo (ej. food delivery, software, telecom, retail)"],
 "keywords": ["6 a 12 palabras clave del rubro, en el idioma del país"],
 "formats": ["2 o 3 de: brand_spot, ugc, demo, testimonial, explainer"],
 "queries": ["4 búsquedas de YouTube para encontrar ANUNCIOS reales de ese rubro y país, en el idioma del país, con la palabra
             'comercial', 'publicidad' o 'anuncio' (o 'commercial'/'ad' en inglés); una puede ser de una marca líder del rubro.
             Si DÓNDE SE PUBLICAN es reels o stories, buscá piezas cortas y verticales: sumá 'reel', 'shorts' o 'tiktok' a dos de ellas"],
 "why": "una oración: qué tipo de anuncios le conviene ver y por qué"}
Si el país no aparece, dejalo vacío. Nada de texto fuera del JSON."""


def _clean(raw: dict, answers: dict) -> dict:
    sector_ids = [s[0] for s in SECTORS]
    lst = lambda v, n: [str(x).strip()[:60] for x in (v if isinstance(v, list) else []) if str(x).strip()][:n]  # noqa: E731
    out = {
        "name": str(raw.get("name") or answers.get("name") or "Mi negocio")[:80],
        "summary": str(raw.get("summary") or answers.get("description") or "")[:400],
        "sector": raw.get("sector") if raw.get("sector") in sector_ids else (answers.get("sector") if answers.get("sector") in sector_ids else "other"),
        "kind": raw.get("kind") if raw.get("kind") in KINDS else (answers.get("kind") if answers.get("kind") in KINDS else "b2c"),
        "country": str(answers.get("country") or raw.get("country") or "").upper()[:2],
        "language": str(raw.get("language") or "es")[:5],
        "audience": str(raw.get("audience") or answers.get("audience") or "")[:200],
        "goal": answers.get("goal") if answers.get("goal") in GOALS else (raw.get("goal") if raw.get("goal") in GOALS else "sales"),
        "industries": [x.lower() for x in lst(raw.get("industries"), 6)],
        "keywords": lst(raw.get("keywords"), 12),
        "formats": [x for x in lst(raw.get("formats"), 3) if x in at.FORMATS],
        "queries": lst(raw.get("queries"), 4),
        "why": str(raw.get("why") or "")[:300],
        "placement": answers.get("placement") if answers.get("placement") in PLACEMENTS else "reels",
    }
    if not out["keywords"]:  # no model: the content words of the description
        words = re.findall(r"[a-záéíóúñü]{4,}", (answers.get("description") or "").lower())
        out["keywords"] = list(dict.fromkeys(w for w in words if w not in STOP))[:10]
    if not out["queries"]:  # no model: searches from what it does, the sector and the country
        place = COUNTRY_NAMES.get(out["country"], "")
        label = next((s[1] for s in SECTORS if s[0] == out["sector"]), "").lower()
        top = " ".join(out["keywords"][:2])
        out["queries"] = [q.strip() for q in (f"publicidad {top} {place}", f"comercial {out['keywords'][0] if out['keywords'] else label} {place}", f"anuncio {label} {place}")]
    return out


async def _write(user: User, text: str, answers: dict) -> tuple[dict, str | None]:
    msg = f"SECTORES (ids): {', '.join(s[0] for s in SECTORS)}\nINDUSTRIAS DEL CATÁLOGO: {', '.join(at.facets().get('industry', [])[:40])}\n\n{text}"
    try:
        raw, by = await at._ask(user.id, PROFILE_SYSTEM, msg, None, 0.2)
        return _clean(raw, answers), by
    except Exception as e:  # noqa: BLE001 — no model key: the answers alone
        log.info("adtier profile without a model: %s", e)
        return _clean({}, answers), None


def _site_text(url: str) -> str:
    try:
        r = httpx.get(url if url.startswith("http") else f"https://{url}", timeout=12, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 TablyAdTier"})
        html = r.text[:400_000]
    except Exception:  # noqa: BLE001
        return ""
    html = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    desc = re.search(r'(?is)<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', html)
    body = re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", " ", html)).strip()
    return " · ".join(x for x in [title.group(1).strip() if title else "", desc.group(1) if desc else "", body[:4000]] if x)


def doc_text(name: str, data: bytes) -> str:
    """The text of a document the person attaches (PDF, Markdown, text)."""
    if name.lower().endswith(".pdf"):
        from pypdf import PdfReader

        try:
            return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages[:30])[:12000]
        except Exception:  # noqa: BLE001
            raise ValueError("No pude leer ese PDF")
    try:
        return data.decode("utf-8", "ignore")[:12000]
    except Exception:  # noqa: BLE001
        raise ValueError("Solo PDF, Markdown o texto")


async def create(user: User, body: dict) -> dict:
    """A profile from a Tably project (session_id + build_id) or from the answers (name, description, sector, kind, country, …)."""
    now = time.time()
    sid, bid = str(body.get("session_id") or ""), str(body.get("build_id") or "")
    answers = {k: str(body.get(k) or "")[:3000] for k in ("name", "description", "sector", "kind", "country", "audience", "goal", "website", "docs", "placement")}
    if sid and bid:
        title, text = _project_text(user, sid, bid)
        answers["name"] = answers["name"] or title
        source = "tably"
    else:
        if len(answers["description"].strip()) < 15 and not answers["docs"] and not answers["website"]:
            raise ValueError("Contanos en una o dos oraciones a qué se dedica tu empresa o proyecto")
        site = await asyncio.to_thread(_site_text, answers["website"]) if answers["website"] else ""
        text = "\n".join(f"{k.upper()}: {v}" for k, v in answers.items() if v and k not in ("docs", "website"))
        text += (f"\n\nSITIO WEB ({answers['website']}):\n{site}" if site else "") + (f"\n\nDOCUMENTOS:\n{answers['docs'][:6000]}" if answers["docs"] else "")
        source = "form"
    answers["placement"] = answers["placement"] if answers["placement"] in PLACEMENTS else "reels"
    text += f"\n\nDÓNDE SE PUBLICAN: {answers['placement']} (reels = Instagram/Facebook Reels, TikTok y Shorts, hasta 60 s; stories = hasta 15 s; long = YouTube/TV)"
    data, by = await _write(user, text, answers)
    data["by"] = by
    pid = secrets.token_hex(6)
    answers.pop("docs", None)
    with _db() as c:
        c.execute("INSERT INTO adtier_profiles VALUES (?,?,?,?,?,?,?,?,NULL,?,?)",
                  (pid, user.id, data["name"], source, sid or None, bid or None, json.dumps(answers, ensure_ascii=False), json.dumps(data, ensure_ascii=False), now, now))
    return get(user.id, pid) or {}


def update(user_id: str, pid: str, fields: dict) -> dict:
    p = get(user_id, pid)
    if not p:
        raise ValueError("Perfil no encontrado")
    data = p["data"]
    for k in ("name", "summary", "audience", "why"):
        if k in fields:
            data[k] = str(fields[k] or "")[:400]
    if fields.get("sector") in [s[0] for s in SECTORS]:
        data["sector"] = fields["sector"]
    if fields.get("kind") in KINDS:
        data["kind"] = fields["kind"]
    if fields.get("placement") in PLACEMENTS:
        data["placement"] = fields["placement"]
    if fields.get("goal") in GOALS:
        data["goal"] = fields["goal"]
    if "country" in fields:
        data["country"] = str(fields["country"] or "").upper()[:2]
    for k, n in (("keywords", 12), ("queries", 4), ("industries", 6)):
        if isinstance(fields.get(k), list):
            data[k] = [str(x).strip()[:60] for x in fields[k] if str(x).strip()][:n]
    with _db() as c:
        c.execute("UPDATE adtier_profiles SET name = ?, data = ?, updated = ? WHERE id = ?", (data["name"], json.dumps(data, ensure_ascii=False), time.time(), pid))
    return get(user_id, pid) or {}


# ------------------------------------------------------------------------------------------------------------ matches

def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9áéíóúñü]{3,}", (text or "").lower())}


def score(profile: dict, v: dict) -> tuple[float, list[str]]:
    """How well a catalogue video fits the profile, with the reasons a person reads."""
    p = profile
    pts, why = 0.0, []
    ind = (v.get("industry") or "").lower()
    if ind and any(i == ind or i in ind or ind in i for i in p.get("industries") or []):
        pts += 40
        why.append(f"mismo rubro ({v.get('industry')})")
    elif ind and _words(ind) & _words(" ".join(p.get("industries") or []) + " " + " ".join(p.get("keywords") or [])):
        pts += 22
        why.append(f"rubro cercano ({v.get('industry')})")
    c = (v.get("country") or "").upper()
    if p.get("country") and c == p["country"]:
        pts += 18
        why.append("de tu país")
    elif p.get("country") in LATAM and c in LATAM:
        pts += 10
        why.append("de Latinoamérica")
    lang = (v.get("language") or "")[:2].lower()
    if lang and lang == (p.get("language") or "")[:2]:
        pts += 8
        why.append("en tu idioma")
    if v.get("format") and v["format"] in (p.get("formats") or []):
        pts += 10
        why.append("formato que te conviene")
    tags = v.get("tags") or {}
    hay = _words(" ".join([v.get("title") or "", v.get("brand") or "", json.dumps(tags, ensure_ascii=False)]))
    hits = [k for k in p.get("keywords") or [] if _words(k) & hay]
    if hits:
        pts += min(20, 6 * len(hits))
        why.append("habla de " + ", ".join(hits[:3]))
    pts += {"S": 10, "A": 7, "B": 4, "C": 1}.get(v.get("tier") or "", 0)
    return pts, why


def matches(user_id: str, pid: str, n: int = 24) -> dict:
    p = get(user_id, pid)
    if not p:
        raise ValueError("Perfil no encontrado")
    with _db() as c:
        rows = c.execute("SELECT v.* FROM adtier_videos v WHERE v.status = 'published'").fetchall()
    close, rest = [], []  # same or near sector / talks about the business first; then only same country or region
    top = PLACEMENTS.get(p["data"].get("placement") or "reels", PLACEMENTS["reels"])[1]
    for r in rows:
        card = at.card(at._row(r))
        if (card.get("duration_s") or 0) > top * 1.5:  # a 2-minute case film is no reference for a reel
            continue
        pts, why = score(p["data"], card)
        item = (pts, card | {"match": round(min(100, pts)), "why": why})
        if any(w.startswith(("mismo rubro", "rubro cercano", "habla de")) for w in why):
            close.append(item)
        elif pts >= 25:
            rest.append(item)
    close.sort(key=lambda x: -x[0])
    rest.sort(key=lambda x: -x[0])
    ranked = close + rest
    found = []
    for vid in found_ids(pid):
        v = at.get(vid)
        if v:
            found.append(at.card(v) | {"stage": v.get("stage"), "error": v.get("error"), "reviewed": v.get("status") == "published"})
    return {"profile": p, "catalog": [x for _, x in ranked[:n]], "found": found, "searching": pid in _search_jobs}


# ------------------------------------------------------------------------------------------------------------ search: real ads of that sector and country

def _yt_search(query: str, n: int = 10) -> list[dict]:
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True}) as y:
            res = y.extract_info(f"ytsearch{n}:{query}", download=False) or {}
        return [e for e in res.get("entries") or [] if e]
    except Exception as e:  # noqa: BLE001
        log.warning("adtier search %r: %s", query, e)
        return []


def _looks_like_ad(e: dict, placement: str = "reels") -> bool:
    lo, hi = PLACEMENTS.get(placement, PLACEMENTS["reels"])
    d = e.get("duration") or 0
    return lo <= d <= hi and bool(AD_WORDS.search(e.get("title") or ""))


def search(user: User, pid: str) -> int:
    """Start the search (in the background): new ads for the profile, analysed like the catalogue. Returns 1 if it started."""
    p = get(user.id, pid)
    if not p:
        raise ValueError("Perfil no encontrado")
    if pid in _search_jobs:
        return 0
    from .tasks import spawn

    async def run():
        try:
            data, added = p["data"], []
            seen = set(found_ids(pid))
            for q in data.get("queries") or []:
                for e in await asyncio.to_thread(_yt_search, q):
                    if len(added) >= MAX_FOUND:
                        break
                    if not _looks_like_ad(e, data.get("placement") or "reels") or not e.get("id"):
                        continue
                    url = f"https://www.youtube.com/watch?v={e['id']}"
                    with _db() as c:
                        dup = c.execute("SELECT id FROM adtier_videos WHERE embed_provider = 'youtube' AND embed_id = ?", (e["id"],)).fetchone()
                    if dup:
                        vid = dup[0]
                    else:
                        meta = {"title": e.get("title"), "brand": e.get("channel") or e.get("uploader"), "country": data.get("country"),
                                "language": data.get("language"), "industry": (data.get("industries") or [""])[0]}
                        vid = at.add(user, url, [], meta)["id"]
                        added.append(vid)
                    if vid not in seen:
                        seen.add(vid)
                        with _db() as c:
                            c.execute("INSERT OR IGNORE INTO adtier_profile_videos VALUES (?,?,?,?)", (pid, vid, q, time.time()))
            with _db() as c:
                c.execute("UPDATE adtier_profiles SET searched = ? WHERE id = ?", (time.time(), pid))
            if added:
                at.start_ingest(user, added)
        except Exception:  # noqa: BLE001
            log.exception("adtier profile search %s", pid)
        finally:
            _search_jobs.pop(pid, None)

    _search_jobs[pid] = spawn(run())  # type: ignore[assignment]
    return 1
