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
    return _profile(r) | {"searching": pid in _search_jobs, "ideating": pid in _idea_jobs} if r else None


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
    found, other = [], 0  # only the ones of the length the person picked; the rest are counted
    placement = p["data"].get("placement") or "reels"
    for vid in found_ids(pid):
        v = at.get(vid)
        if not v:
            continue
        if v.get("duration_s") and not fits(v["duration_s"], placement):
            other += 1
            continue
        found.append(at.card(v) | {"stage": v.get("stage"), "error": v.get("error"), "reviewed": v.get("status") == "published"})
    return {"profile": p, "catalog": [x for _, x in ranked[:n]], "found": found, "other_length": other, "searching": pid in _search_jobs,
            "ideating": pid in _idea_jobs}


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


DUR_MARK = re.compile(r"(\b\d{1,2}\s?(s|seg|segundos|sec|seconds)\b|:\d{2}\b|\b\d{1,2}\")", re.I)


def fits(duration: float | None, placement: str) -> bool:
    lo, hi = PLACEMENTS.get(placement, PLACEMENTS["reels"])
    return lo <= (duration or 0) <= hi


def _looks_like_ad(e: dict, placement: str = "reels", keywords: list[str] | None = None) -> bool:
    """The right length and an ad by its title: it says so («comercial», «spot», «15s») or, coming from an ad search, it is about the
    business (short pieces often carry only the product in the title)."""
    if not fits(e.get("duration"), placement):
        return False
    title = e.get("title") or ""
    if AD_WORDS.search(title) or DUR_MARK.search(title):
        return True
    return bool(keywords) and bool(_words(title) & _words(" ".join(keywords)))


def _plan(data: dict) -> list[str]:
    """The searches for this profile and this length: the profile's own, then variants that YouTube answers with short pieces."""
    base = [q for q in data.get("queries") or [] if q]
    kw = [k for k in data.get("keywords") or [] if k][:3] or [(data.get("industries") or ["publicidad"])[0]]
    place = COUNTRY_NAMES.get(data.get("country") or "", "")
    placement = data.get("placement") or "reels"
    extra: list[str] = []
    if placement == "stories":
        extra = [f"comercial {k} 15 segundos" for k in kw] + [f"{q} 15s" for q in base[:2]] + [f"{q} shorts" for q in base[:2]]
    elif placement == "reels":
        extra = [f"{q} shorts" for q in base[:3]] + [f"comercial {k} 30 segundos" for k in kw[:2]] + [f"reel publicidad {kw[0]} {place}".strip()]
    return list(dict.fromkeys(extra + base if placement == "stories" else base + extra))


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
            data, added, linked = p["data"], [], 0
            placement = data.get("placement") or "reels"
            seen = set(found_ids(pid))
            for q in _plan(data):
                if linked >= MAX_FOUND:
                    break
                for e in await asyncio.to_thread(_yt_search, q, 30):
                    if linked >= MAX_FOUND:
                        break
                    if not e.get("id") or not _looks_like_ad(e, placement, data.get("keywords")):
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
                        linked += 1
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


# ------------------------------------------------------------------------------------------------------------ ideas: reels to make, from reference accounts

MAX_ACCOUNTS = 5
RESERVED = {"p", "reel", "reels", "tv", "stories", "explore", "watch", "share", "video", "videos", "profile.php", "groups", "shorts", "channel", "c", "user"}
_idea_jobs: dict[str, asyncio.Task] = {}


def parse_account(raw: str) -> dict | None:
    """An Instagram, Facebook, TikTok or YouTube link (or a bare @handle, taken as Instagram) → {platform, handle, url}."""
    s = (raw or "").strip().rstrip("/")
    if not s:
        return None
    if re.fullmatch(r"@?[A-Za-z0-9._]{2,40}", s):
        h = s.lstrip("@")
        return {"platform": "instagram", "handle": h, "url": f"https://www.instagram.com/{h}/"}
    m = re.match(r"(?:https?://)?(?:[a-z]+\.)?(instagram\.com|facebook\.com|fb\.com|tiktok\.com|youtube\.com)/(.+)", s, re.I)
    if not m:
        return None
    host, parts = m.group(1).lower(), [x for x in re.split(r"[/?#]", m.group(2)) if x]
    if not parts:
        return None
    if host == "tiktok.com" and parts[0].startswith("@"):
        return {"platform": "tiktok", "handle": parts[0][1:], "url": f"https://www.tiktok.com/{parts[0]}"}
    if host == "youtube.com" and parts[0].startswith("@"):
        return {"platform": "youtube", "handle": parts[0][1:], "url": f"https://www.youtube.com/{parts[0]}"}
    if parts[0].lower() in RESERVED or parts[0].startswith("@"):
        return None
    if host == "instagram.com":
        return {"platform": "instagram", "handle": parts[0], "url": f"https://www.instagram.com/{parts[0]}/"}
    if host in ("facebook.com", "fb.com"):
        return {"platform": "facebook", "handle": parts[0], "url": f"https://www.facebook.com/{parts[0]}"}
    return None


def _flat(url: str, n: int) -> dict:
    import yt_dlp

    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True, "playlistend": n}) as y:
        return y.extract_info(url, download=False) or {}


def _thumb(e: dict) -> str | None:
    th = [t for t in e.get("thumbnails") or [] if t.get("url")]
    return e.get("thumbnail") or (th[-1]["url"] if th else None)


def _yt_shorts(handle: str, n: int = 15) -> list[dict]:
    try:
        res = _flat(f"https://www.youtube.com/@{handle}/shorts", n)
    except Exception as e:  # noqa: BLE001
        log.info("adtier shorts @%s: %s", handle, e)
        return []
    return [{"caption": e.get("title") or "", "url": e.get("url") or f"https://www.youtube.com/shorts/{e['id']}", "thumb": _thumb(e),
             "views": e.get("view_count"), "duration": e.get("duration")} for e in res.get("entries") or [] if e and e.get("id")]


def _tiktok(handle: str, n: int = 15) -> list[dict]:
    try:
        res = _flat(f"https://www.tiktok.com/@{handle}", n)
    except Exception as e:  # noqa: BLE001
        log.info("adtier tiktok @%s: %s", handle, e)
        return []
    return [{"caption": e.get("title") or e.get("description") or "", "url": e.get("url") or e.get("webpage_url") or "", "thumb": _thumb(e),
             "views": e.get("view_count"), "likes": e.get("like_count"), "comments": e.get("comment_count"), "duration": e.get("duration")}
            for e in res.get("entries") or [] if e]


async def read_account(user: User, acc: dict) -> tuple[list[dict], dict]:
    """The latest reels of one account and how they were read: Meta's own API for Instagram and Pages first, the public listings
    for TikTok and YouTube, and the brand's YouTube Shorts (same handle) when the first way is closed."""
    from . import meta_ads as meta

    plat, h = acc["platform"], acc["handle"]
    note = {"account": acc["url"], "platform": plat, "handle": h, "via": None, "count": 0, "problem": None, "action": None}
    items: list[dict] = []
    if plat == "instagram":
        if meta.connection(user.id) and meta.has_instagram(user.id):
            try:
                got = await meta.instagram_reels(user.id, h)
                items = [{"caption": m.get("caption") or "", "url": m.get("permalink") or "", "thumb": m.get("thumbnail_url"), "likes": m.get("like_count"),
                          "comments": m.get("comments_count"), "date": (m.get("timestamp") or "")[:10]} for m in got["media"]]
                note["via"], note["name"], note["followers"] = "instagram", got["name"], got.get("followers")
            except Exception as e:  # noqa: BLE001
                note["problem"] = str(e)[:240]
        else:
            if meta.ready():
                note["problem"] = "Instagram muestra los reels solo a cuentas conectadas: conectá tu cuenta de Meta y los leemos con su API oficial."
                note["action"] = "connect_meta"
            else:
                note["problem"] = "Instagram no deja leer reels sin la conexión con Meta, que todavía no está habilitada en Tably."
    elif plat == "facebook":
        try:
            got = await meta.page_reels(user.id, h) if meta.connection(user.id) else None
        except Exception as e:  # noqa: BLE001
            got, note["problem"] = None, str(e)[:240]
        if got:
            items = [{"caption": m.get("description") or "", "url": f"https://www.facebook.com{m['permalink_url']}" if str(m.get("permalink_url", "")).startswith("/") else m.get("permalink_url") or "",
                      "thumb": m.get("picture"), "duration": m.get("length"), "date": (m.get("created_time") or "")[:10]} for m in got["media"]]
            note["via"], note["name"] = "facebook", got["name"]
        elif not note["problem"]:
            note["problem"] = ("Meta deja leer los videos solo de las páginas que administrás." if meta.connection(user.id)
                               else "Para leer los reels de una página de Facebook, conectá tu cuenta de Meta (solo de páginas que administrás)." if meta.ready()
                               else "Facebook no deja leer los videos de una página sin la conexión con Meta, que todavía no está habilitada en Tably.")
            note["action"] = None if meta.connection(user.id) or not meta.ready() else "connect_meta"
    elif plat == "tiktok":
        items = await asyncio.to_thread(_tiktok, h)
        note["via"] = "tiktok" if items else None
    elif plat == "youtube":
        items = await asyncio.to_thread(_yt_shorts, h)
        note["via"] = "youtube" if items else None
    if not items and plat != "youtube":  # the same brand usually posts the same reels as YouTube Shorts
        items = await asyncio.to_thread(_yt_shorts, h)
        if items:
            note["via"] = "youtube"
    if not items:
        note["problem"] = (note["problem"] or "No encontré reels públicos de esa cuenta.") + (" Si la marca tiene TikTok o canal de YouTube, pegá ese link." if plat in ("instagram", "facebook") else "")
    for it in items:
        it.update(platform=note["via"], account=h)
    note["count"] = len(items)
    return items, note


IDEAS_SYSTEM = """Sos director creativo de contenido para redes. Te paso el perfil de un negocio y los últimos reels de las cuentas que
la persona eligió como referencia (con sus números cuando los hay). Primero mirá qué funciona en esas cuentas (ganchos, formatos,
temas, duración, los que más vistas o me gusta tienen) y después escribí EXACTAMENTE 5 reels para que este negocio los grabe, adaptados a
su rubro, su país y su objetivo. Que se puedan grabar con un celular. No copies: tomá el patrón. Respondé SOLO un objeto JSON:
{"patterns": "2 o 3 oraciones: qué funciona en esas cuentas y por qué",
 "ideas": [{"title": "nombre corto del reel", "duration_s": 15,
            "based_on": [números de los reels de referencia que inspiran esta idea],
            "why": "una oración: por qué le va a funcionar",
            "hook": "los primeros 2 segundos: qué se ve y qué se dice o se lee",
            "beats": [{"t": "0-2 s", "shot": "qué se filma", "text": "texto en pantalla", "voice": "lo que se dice (o vacío)"}],
            "cta": "el cierre y qué tiene que hacer quien lo ve",
            "caption": "el texto de la publicación con 3 a 5 hashtags",
            "audio": "qué música o sonido usar"}]}
Escribí en el idioma del negocio."""


def _number(n) -> str:
    return "" if n in (None, "") else f"{int(n):,}".replace(",", ".")


async def _ideas_from(user: User, data: dict, refs: list[dict]) -> tuple[dict, str]:
    lo, hi = PLACEMENTS.get(data.get("placement") or "reels", PLACEMENTS["reels"])
    prof = {k: data.get(k) for k in ("name", "summary", "sector", "kind", "country", "language", "audience", "goal", "keywords")}
    lines = []
    for i, r in enumerate(refs, 1):
        nums = " · ".join(x for x in [f"{_number(r.get('views'))} vistas" if r.get("views") else "", f"{_number(r.get('likes'))} me gusta" if r.get("likes") else "",
                                       f"{_number(r.get('comments'))} comentarios" if r.get("comments") else "", f"{round(r['duration'])} s" if r.get("duration") else ""] if x)
        lines.append(f"{i}. @{r.get('account')} ({r.get('platform')}){' · ' + nums if nums else ''}: {(r.get('caption') or '(sin texto)')[:300]}")
    if not lines:  # nothing could be read: the best ads found for the profile are the reference
        for i, v in enumerate([at.get(x) for x in found_ids(data.get("_pid") or "")][:10], 1):
            if v:
                lines.append(f"{i}. {v.get('brand') or ''} (anuncio de YouTube · {round(v.get('duration_s') or 0)} s): {v.get('title') or ''}")
    msg = (f"PERFIL DEL NEGOCIO:\n{json.dumps(prof, ensure_ascii=False)}\n\nLARGO: entre {lo} y {hi} segundos (dónde se publican: {data.get('placement') or 'reels'})\n\n"
           f"REELS DE REFERENCIA:\n" + ("\n".join(lines) or "(no se pudieron leer: basate en el perfil)") + "\n\nLas imágenes son las portadas de los primeros reels, en orden.")
    images: list[bytes] = []
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as cx:
        for r in refs[:6]:
            if not r.get("thumb"):
                continue
            try:
                res = await cx.get(r["thumb"])
                if res.status_code == 200 and res.headers.get("content-type", "").startswith("image/") and len(res.content) < 2_000_000:
                    images.append(res.content)
            except Exception:  # noqa: BLE001
                pass
    try:
        return await at._ask(user.id, IDEAS_SYSTEM, msg, images or None, 0.6)
    except RuntimeError:
        if not images:
            raise
        return await at._ask(user.id, IDEAS_SYSTEM, msg, None, 0.6)


def _clean_ideas(raw: dict, n_refs: int) -> list[dict]:
    out = []
    for it in (raw.get("ideas") if isinstance(raw.get("ideas"), list) else [])[:5]:
        if not isinstance(it, dict) or not it.get("title"):
            continue
        beats = [{k: str(b.get(k) or "")[:240] for k in ("t", "shot", "text", "voice")} for b in (it.get("beats") or []) if isinstance(b, dict)][:8]
        based = [int(x) for x in (it.get("based_on") or []) if str(x).isdigit() and 1 <= int(x) <= n_refs][:3]
        try:
            dur = max(3, min(180, int(float(it.get("duration_s") or 15))))
        except (TypeError, ValueError):
            dur = 15
        out.append({"title": str(it["title"])[:90], "duration_s": dur, "based_on": based, "why": str(it.get("why") or "")[:300],
                    "hook": str(it.get("hook") or "")[:300], "beats": beats, "cta": str(it.get("cta") or "")[:240],
                    "caption": str(it.get("caption") or "")[:600], "audio": str(it.get("audio") or "")[:160]})
    return out


def _save_data(pid: str, data: dict) -> None:
    with _db() as c:
        c.execute("UPDATE adtier_profiles SET data = ?, updated = ? WHERE id = ?", (json.dumps(data, ensure_ascii=False), time.time(), pid))


def ideas(user: User, pid: str, accounts: list[str] | None = None) -> int:
    """Read the reference accounts and write 5 reels to make (in the background). Returns 1 if it started."""
    p = get(user.id, pid)
    if not p:
        raise ValueError("Perfil no encontrado")
    data = p["data"]
    if accounts is not None:
        parsed = [a for a in (parse_account(x) for x in accounts) if a]
        bad = [x for x in accounts if x.strip() and not parse_account(x)]
        if bad:
            raise ValueError(f"No reconozco «{bad[0][:80]}»: pegá el link del perfil de Instagram, Facebook, TikTok o YouTube (no de un posteo)")
        data["accounts"] = [a["url"] for a in {a["url"]: a for a in parsed}.values()][:MAX_ACCOUNTS]
        _save_data(pid, data)
    if not data.get("accounts"):
        raise ValueError("Pegá al menos una cuenta de Instagram, Facebook, TikTok o YouTube")
    if pid in _idea_jobs:
        return 0
    from .tasks import spawn

    async def run():
        d = data
        try:
            refs, notes = [], []
            for url in d["accounts"]:
                items, note = await read_account(user, parse_account(url) or {})
                notes.append(note)
                items.sort(key=lambda x: -((x.get("views") or 0) + 20 * (x.get("likes") or 0)))  # the ones that worked best first
                refs.extend(items[:8])
            d = (get(user.id, pid) or {}).get("data") or d
            d.update(refs=refs[:24], notes=notes, ideas_error=None)
            try:
                raw, by = await _ideas_from(user, d | {"_pid": pid}, refs[:24])
                d.update(ideas=_clean_ideas(raw, len(refs[:24])), patterns=str(raw.get("patterns") or "")[:600], ideas_by=by, ideas_at=time.time())
                if not d["ideas"]:
                    d["ideas_error"] = "El modelo no devolvió ideas: probá de nuevo."
            except Exception as e:  # noqa: BLE001
                d["ideas_error"] = ("Para escribir las ideas hace falta la clave de Meta Muse (o de otro modelo) en Configuración."
                                    if "Agregá tu clave" in str(e) else f"No pude escribir las ideas: {str(e)[:240]}")
            _save_data(pid, d)
        except Exception:  # noqa: BLE001
            log.exception("adtier ideas %s", pid)
        finally:
            _idea_jobs.pop(pid, None)

    _idea_jobs[pid] = spawn(run())  # type: ignore[assignment]
    return 1
