"""AdTier: a catalogue of video ads ranked S/A/B/C, each one broken down into a reusable template (hook, beats, CTA).

What makes it different from an awards archive or an ads library is the three things together: curation (only what the admin
loads, with its evidence), a ranking with criteria, and the template. Inside Tably the approved S and A templates also feed the
ad scripts the team writes («Anuncios» and the Ad Studio).

The tier comes from two independent signals and the higher one wins:
- external evidence (an award or proven performance), proposed by the model from the evidence the admin loads;
- an internal score 0–100 (hook 25 · structure 25 · copy 20 · visual 15 · platform fit 15).
A video cannot be S without external evidence (the score alone takes it up to A), and nothing is published before a person reviews it.

Ingest (per video, resumable): metadata (oEmbed + yt-dlp, never downloading the video) → 6 frames from the provider's own
storyboards (≤ 320 px) → transcript (the provider's captions, else Meta Muse Voice Transcribe on audio that is deleted at once) →
analysis with Meta Muse (two runs at temperature 0; more than 10 points apart = needs review) → review → published.

Legal rules (from the brief): playback only through official embeds; videos whose embed stops working are unpublished; the
public page shows the hook and the CTA, never the whole transcript; attribution always visible.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import httpx

from .auth import User, _db
from .config import DATA_DIR
from .providers import PROVIDERS, CallResult, stream
from . import ads as adsmod
from . import keystore
from . import media
from . import transcribe as stt

log = logging.getLogger("arena.adtier")

PROMPT_PATH = Path(__file__).parent / "prompts" / "adtier_analyze.md"
PROMPT_VERSION = "v1"
TIERS = "SABC"
WEIGHTS = {"hook": 25, "structure": 25, "copy": 20, "visual": 15, "platform_fit": 15}
FORMATS = ("brand_spot", "ugc", "demo", "testimonial", "explainer", "other")
PLATFORMS = ("tv", "youtube", "tiktok", "meta")
EVIDENCE = ("award", "performance", "editorial")
HOOKS = ("question", "result_first", "pattern_interrupt", "testimonial", "demo", "humor")
MASTER_MIN = 20  # videos of the same format and tier before a master template is made
FILES = DATA_DIR / "adtier"
_jobs: dict[str, asyncio.Task] = {}

with _db() as _c:
    _c.executescript("""
    CREATE TABLE IF NOT EXISTS adtier_videos (
        id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT, brand TEXT, agency TEXT, year INTEGER, country TEXT, language TEXT,
        platform_origin TEXT, format TEXT, duration_s REAL, industry TEXT, embed_provider TEXT, embed_id TEXT, source_url TEXT NOT NULL,
        thumbnail_url TEXT, transcript TEXT, tags TEXT, status TEXT NOT NULL, stage TEXT, error TEXT, embed_ok INTEGER, checked REAL,
        created_by TEXT, created REAL NOT NULL, updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS adtier_evidence (
        id TEXT PRIMARY KEY, video_id TEXT NOT NULL, type TEXT NOT NULL, detail TEXT, url TEXT, awarded_at TEXT, days_active INTEGER, variations_count INTEGER);
    CREATE TABLE IF NOT EXISTS adtier_scores (
        id TEXT PRIMARY KEY, video_id TEXT NOT NULL, hook REAL, structure REAL, copy REAL, visual REAL, platform_fit REAL, total REAL, model TEXT,
        rationale TEXT, needs_review INTEGER, confidence REAL, prompt_version TEXT, reviewed_by TEXT, reviewed_at REAL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS adtier_tiers (
        video_id TEXT PRIMARY KEY, tier TEXT, basis TEXT, justification TEXT, proposed TEXT, evidence_tier TEXT, score_tier TEXT,
        assigned_at REAL, assigned_by TEXT);
    CREATE TABLE IF NOT EXISTS adtier_templates (
        id TEXT PRIMARY KEY, video_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, approved INTEGER NOT NULL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS adtier_masters (
        format TEXT NOT NULL, tier TEXT NOT NULL, body TEXT NOT NULL, videos TEXT NOT NULL, model TEXT, created REAL NOT NULL, PRIMARY KEY (format, tier));
    CREATE INDEX IF NOT EXISTS adtier_evidence_video ON adtier_evidence (video_id);
    CREATE INDEX IF NOT EXISTS adtier_scores_video ON adtier_scores (video_id);
    CREATE INDEX IF NOT EXISTS adtier_templates_video ON adtier_templates (video_id);
    """)


# ------------------------------------------------------------------------------------------------------------ helpers

def _now() -> float:
    return time.time()


def _slug(text: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (text or "anuncio").lower().encode("ascii", "ignore").decode()).strip("-")[:60] or "anuncio"
    with _db() as c:
        slug, n = base, 2
        while c.execute("SELECT 1 FROM adtier_videos WHERE slug = ?", (slug,)).fetchone():
            slug, n = f"{base}-{n}", n + 1
    return slug


def tier_from_score(total: float) -> str:
    return "S" if total >= 85 else "A" if total >= 70 else "B" if total >= 55 else "C"


def best(*tiers: str | None) -> str:
    ok = [t for t in tiers if isinstance(t, str) and t and t in TIERS]
    return min(ok, key=TIERS.index) if ok else "C"


def final_tier(evidence_tier: str | None, total: float) -> tuple[str, str]:
    """(tier, basis): the higher of the two signals; the score alone never reaches S."""
    score = tier_from_score(total)
    if score == "S" and evidence_tier != "S":
        score = "A"
    t = best(evidence_tier, score)
    return t, ("evidence" if evidence_tier and t == evidence_tier else "score")


def total_of(scores: dict) -> float:
    return round(sum(float(scores.get(k) or 0) * w for k, w in WEIGHTS.items()) / 100, 1)


def studio_who(user_id: str) -> list:
    """The models that can write for this person (Meta Muse first)."""
    from . import studio

    return studio._who(user_id, False)


def provider(url: str) -> tuple[str, str] | None:
    """(embed provider, embed id) of a YouTube, Vimeo or TikTok link."""
    u = urlparse(url.strip())
    host = (u.hostname or "").removeprefix("www.").removeprefix("m.")
    if host in ("youtube.com", "music.youtube.com"):
        if u.path.startswith(("/shorts/", "/embed/", "/live/")):
            return "youtube", u.path.split("/")[2]
        v = parse_qs(u.query).get("v")
        return ("youtube", v[0]) if v else None
    if host == "youtu.be":
        return "youtube", u.path.strip("/").split("/")[0]
    if host in ("vimeo.com", "player.vimeo.com"):
        m = re.search(r"/(\d{5,})", u.path)
        return ("vimeo", m.group(1)) if m else None
    if host.endswith("tiktok.com"):
        m = re.search(r"/video/(\d+)", u.path)
        return ("tiktok", m.group(1)) if m else None
    return None


async def oembed(prov: str, url: str) -> dict | None:
    """The provider's own oEmbed: proof that the video can be embedded, plus title, author and thumbnail."""
    endpoint = {"youtube": "https://www.youtube.com/oembed?format=json&url=", "vimeo": "https://vimeo.com/api/oembed.json?url=",
                "tiktok": "https://www.tiktok.com/oembed?url="}[prov]
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cx:
            r = await cx.get(endpoint + quote(url, safe=""))
        return r.json() if r.status_code == 200 else None
    except Exception:  # noqa: BLE001
        return None


def embed_url(prov: str, eid: str) -> str:
    return {"youtube": f"https://www.youtube-nocookie.com/embed/{eid}", "vimeo": f"https://player.vimeo.com/video/{eid}",
            "tiktok": f"https://www.tiktok.com/embed/v2/{eid}"}.get(prov, "")


# ------------------------------------------------------------------------------------------------------------ catalogue

def _row(r) -> dict:
    d = dict(r)
    for k in ("transcript", "tags"):
        try:
            d[k] = json.loads(d[k]) if d.get(k) else ([] if k == "transcript" else {})
        except ValueError:
            d[k] = [] if k == "transcript" else {}
    return d


def get(video_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM adtier_videos WHERE id = ? OR slug = ?", (video_id, video_id)).fetchone()
    return _row(r) if r else None


def evidence_of(video_id: str) -> list[dict]:
    with _db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM adtier_evidence WHERE video_id = ?", (video_id,))]


def score_of(video_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM adtier_scores WHERE video_id = ? ORDER BY created DESC LIMIT 1", (video_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["rationale"] = json.loads(d["rationale"] or "{}")
    return d


def tier_of(video_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM adtier_tiers WHERE video_id = ?", (video_id,)).fetchone()
    return dict(r) if r else None


def template_of(video_id: str, approved_only: bool = False) -> dict | None:
    with _db() as c:
        r = c.execute(f"SELECT * FROM adtier_templates WHERE video_id = ? {'AND approved = 1' if approved_only else ''} ORDER BY version DESC LIMIT 1", (video_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["body"] = json.loads(d["body"])
    return d


def card(v: dict) -> dict:
    """What a list shows: no transcript."""
    t = tier_of(v["id"]) or {}
    keep = ("id", "slug", "title", "brand", "agency", "year", "country", "language", "platform_origin", "format", "duration_s", "industry",
            "embed_provider", "embed_id", "thumbnail_url", "status")
    return {**{k: v.get(k) for k in keep}, "tier": t.get("tier"), "proposed": t.get("proposed"), "tags": v.get("tags") or {}}


def detail(v: dict, admin: bool = False, own: bool = False) -> dict:
    """The full card of a video. The public sees the hook and the CTA lines, never the whole transcript. A video found for the
    person's own profile shows its template before review (marked as not reviewed)."""
    tpl = template_of(v["id"], approved_only=not (admin or own))
    out = {**card(v), "source_url": v["source_url"], "embed_url": embed_url(v["embed_provider"], v["embed_id"]), "tier_info": tier_of(v["id"]),
           "evidence": evidence_of(v["id"]), "score": score_of(v["id"]), "template": tpl["body"] if tpl else None,
           "template_version": tpl["version"] if tpl else None, "similar": [card(x) for x in similar(v)],
           "unreviewed": v.get("status") != "published", "stage": v.get("stage") if own else None}
    if admin:
        out.update(transcript=v.get("transcript") or [], stage=v.get("stage"), error=v.get("error"), embed_ok=v.get("embed_ok"))
    return out


def similar(v: dict, n: int = 4) -> list[dict]:
    with _db() as c:
        rows = c.execute("""SELECT v.* FROM adtier_videos v LEFT JOIN adtier_tiers t ON t.video_id = v.id WHERE v.status = 'published' AND v.id != ?
                            AND (v.format = ? OR v.industry = ?) ORDER BY (v.format = ?) DESC, instr('SABC', COALESCE(t.tier, 'C')) LIMIT ?""",
                         (v["id"], v.get("format"), v.get("industry"), v.get("format"), n)).fetchall()
    return [_row(r) for r in rows]


def search(filters: dict, q: str = "", status: str = "published", page: int = 1, per: int = 24) -> dict:
    where, args = ["v.status = ?"] if status != "all" else ["1=1"], [status] if status != "all" else []
    for k in ("format", "industry", "language", "country", "platform_origin", "brand", "embed_provider"):
        if filters.get(k):
            where.append(f"v.{k} = ?")
            args.append(filters[k])
    if filters.get("tier"):
        where.append("t.tier = ?")
        args.append(filters["tier"])
    if filters.get("region") == "latam":
        where.append("v.country IN ('AR','BR','CL','CO','MX','PE','UY','PY','BO','EC','VE','CR','PA','GT','HN','SV','NI','DO','CU','PR')")
    if filters.get("max_s"):
        where.append("v.duration_s <= ?")
        args.append(float(filters["max_s"]))
    if filters.get("min_s"):
        where.append("v.duration_s >= ?")
        args.append(float(filters["min_s"]))
    if q.strip():
        where.append("(v.title LIKE ? OR v.brand LIKE ? OR v.transcript LIKE ? OR v.industry LIKE ?)")
        args += [f"%{q.strip()}%"] * 4
    sql = f"FROM adtier_videos v LEFT JOIN adtier_tiers t ON t.video_id = v.id WHERE {' AND '.join(where)}"
    with _db() as c:
        total = c.execute(f"SELECT COUNT(*) {sql}", args).fetchone()[0]
        rows = c.execute(f"SELECT v.* {sql} ORDER BY instr('SABC', COALESCE(t.tier, 'C')), v.year DESC, v.created DESC LIMIT ? OFFSET ?", args + [per, (page - 1) * per]).fetchall()
    return {"total": total, "page": page, "per": per, "videos": [card(_row(r)) for r in rows]}


def tier_list(filters: dict, per_tier: int = 12) -> dict:
    return {t: search({**filters, "tier": t}, per=per_tier)["videos"] for t in TIERS}


def facets() -> dict:
    with _db() as c:
        out = {}
        for k in ("format", "industry", "language", "country", "platform_origin", "brand"):
            out[k] = [r[0] for r in c.execute(f"SELECT {k} FROM adtier_videos WHERE status = 'published' AND {k} IS NOT NULL AND {k} != '' GROUP BY {k} ORDER BY COUNT(*) DESC LIMIT 60")]
        out["counts"] = {r[0] or "?": r[1] for r in c.execute("SELECT t.tier, COUNT(*) FROM adtier_videos v LEFT JOIN adtier_tiers t ON t.video_id = v.id WHERE v.status = 'published' GROUP BY t.tier")}
    return out


def brands() -> list[dict]:
    with _db() as c:
        return [{"brand": r[0], "videos": r[1]} for r in c.execute("SELECT brand, COUNT(*) FROM adtier_videos WHERE status = 'published' AND brand IS NOT NULL AND brand != '' GROUP BY brand ORDER BY COUNT(*) DESC")]


# ------------------------------------------------------------------------------------------------------------ admin: load

def add(user: User, url: str, evidence: list[dict] | None = None, meta: dict | None = None) -> dict:
    """A video into the catalogue as a draft (then the ingest job fills it)."""
    p = provider(url)
    if not p:
        raise ValueError("Solo videos de YouTube, Vimeo o TikTok (se reproducen por su embed oficial, nunca se descargan)")
    with _db() as c:
        dup = c.execute("SELECT slug FROM adtier_videos WHERE embed_provider = ? AND embed_id = ?", p).fetchone()
    if dup:
        raise ValueError(f"Ese video ya está en el catálogo ({dup[0]})")
    meta = meta or {}
    vid = secrets.token_hex(6)
    title = str(meta.get("title") or "")[:200]
    now = _now()
    fmt = meta.get("format") if meta.get("format") in FORMATS else None
    plat = meta.get("platform_origin") if meta.get("platform_origin") in PLATFORMS else ("tiktok" if p[0] == "tiktok" else "youtube" if p[0] == "youtube" else None)
    year = int(meta["year"]) if str(meta.get("year") or "").isdigit() else None
    with _db() as c:
        c.execute("""INSERT INTO adtier_videos (id, slug, title, brand, agency, year, country, language, platform_origin, format, industry, embed_provider, embed_id,
                     source_url, status, stage, created_by, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft','queued',?,?,?)""",
                  (vid, _slug(title or f"{meta.get('brand') or ''} {p[1]}"), title, str(meta.get("brand") or "")[:120], str(meta.get("agency") or "")[:120], year,
                   str(meta.get("country") or "").upper()[:2], str(meta.get("language") or "")[:20], plat, fmt, str(meta.get("industry") or "")[:60], p[0], p[1],
                   url.strip(), user.id, now, now))
        for e in evidence or []:
            if e.get("type") in EVIDENCE and (e.get("detail") or e.get("url")):
                c.execute("INSERT INTO adtier_evidence VALUES (?,?,?,?,?,?,?,?)", (secrets.token_hex(6), vid, e["type"], str(e.get("detail") or "")[:300], str(e.get("url") or "")[:500],
                                                                                   str(e.get("awarded_at") or "")[:20] or None, _int(e.get("days_active")), _int(e.get("variations_count"))))
    return get(vid) or {}


def _int(v) -> int | None:
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


CSV_COLUMNS = ("url", "brand", "agency", "year", "country", "language", "industry", "format", "evidence_type", "evidence_detail", "evidence_url", "days_active", "variations_count")


def batch(user: User, text: str) -> dict:
    """A CSV lot (url, brand, year, country, evidence_type, evidence_detail, evidence_url, …): one draft per row."""
    added, errors = [], []
    for i, row in enumerate(csv.DictReader(io.StringIO(text.strip())), start=2):
        row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        try:
            ev = [{"type": row.get("evidence_type") or "editorial", "detail": row.get("evidence_detail"), "url": row.get("evidence_url"),
                   "days_active": row.get("days_active"), "variations_count": row.get("variations_count")}] if (row.get("evidence_detail") or row.get("evidence_url")) else []
            added.append(add(user, row.get("url") or "", ev, row)["id"])
        except ValueError as e:
            errors.append(f"fila {i}: {e}")
    return {"added": added, "errors": errors}


def update_meta(video_id: str, fields: dict) -> dict:
    allowed = {"title": 200, "brand": 120, "agency": 120, "country": 2, "language": 20, "industry": 60}
    sets, args = [], []
    for k, n in allowed.items():
        if k in fields:
            sets.append(f"{k} = ?")
            args.append(str(fields[k] or "")[:n] if k != "country" else str(fields[k] or "").upper()[:2])
    if "year" in fields:
        sets.append("year = ?")
        args.append(_int(fields["year"]))
    if fields.get("format") in FORMATS:
        sets.append("format = ?")
        args.append(fields["format"])
    if fields.get("platform_origin") in PLATFORMS:
        sets.append("platform_origin = ?")
        args.append(fields["platform_origin"])
    if sets:
        with _db() as c:
            c.execute(f"UPDATE adtier_videos SET {', '.join(sets)}, updated = ? WHERE id = ?", args + [_now(), video_id])
    return get(video_id) or {}


def set_evidence(video_id: str, items: list[dict]) -> None:
    with _db() as c:
        c.execute("DELETE FROM adtier_evidence WHERE video_id = ?", (video_id,))
        for e in items:
            if e.get("type") in EVIDENCE and (e.get("detail") or e.get("url")):
                c.execute("INSERT INTO adtier_evidence VALUES (?,?,?,?,?,?,?,?)", (secrets.token_hex(6), video_id, e["type"], str(e.get("detail") or "")[:300], str(e.get("url") or "")[:500],
                                                                                   str(e.get("awarded_at") or "")[:20] or None, _int(e.get("days_active")), _int(e.get("variations_count"))))


def remove(video_id: str) -> None:
    with _db() as c:
        for t in ("adtier_evidence", "adtier_scores", "adtier_templates"):
            c.execute(f"DELETE FROM {t} WHERE video_id = ?", (video_id,))
        c.execute("DELETE FROM adtier_tiers WHERE video_id = ?", (video_id,))
        c.execute("DELETE FROM adtier_videos WHERE id = ?", (video_id,))
    shutil.rmtree(FILES / video_id, ignore_errors=True)


def _set(video_id: str, **fields) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _db() as c:
        c.execute(f"UPDATE adtier_videos SET {sets}, updated = ? WHERE id = ?", [*fields.values(), _now(), video_id])


# ------------------------------------------------------------------------------------------------------------ ingest

def _ytinfo(url: str) -> dict | None:
    """Metadata, captions and storyboards from yt-dlp, without downloading the video."""
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}) as y:
            return y.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        log.warning("yt-dlp %s: %s", url, e)
        return None


def _captions(info: dict, lang_hint: str = "") -> list[dict]:
    """The provider's captions (manual first, then automatic, in the video's language) as timed segments."""
    langs = [lang_hint, info.get("language") or "", "es", "es-419", "en", "pt", "pt-BR"]
    for pool in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        key = next((l for l in langs if l and l in pool), None) or next((k for k in pool if "-orig" in k), None)
        if not key:
            continue
        track = next((t for t in pool[key] if t.get("ext") == "json3"), None)
        if not track:
            continue
        try:
            data = httpx.get(track["url"], timeout=20).json()
        except Exception:  # noqa: BLE001
            continue
        segs = []
        for ev in data.get("events") or []:
            text = "".join(s.get("utf8", "") for s in ev.get("segs") or []).replace("\n", " ").strip()
            if text:
                start = (ev.get("tStartMs") or 0) / 1000
                segs.append({"start": round(start, 2), "end": round(start + (ev.get("dDurationMs") or 0) / 1000, 2), "text": text})
        if segs:
            return segs
    return []


def _frames(info: dict, out: Path) -> list[tuple[float, Path]]:
    """6 frames (0 s, 3 s, 25 %, 50 %, 75 %, last) cut from the provider's own storyboard sheets (≤ 320 px, no video download)."""
    from PIL import Image

    dur = float(info.get("duration") or 0)
    sb = sorted([f for f in info.get("formats") or [] if str(f.get("format_id", "")).startswith("sb") and f.get("fragments")], key=lambda f: -(f.get("width") or 0))
    if not sb or dur <= 0:
        return []
    f = sb[0]
    rows, cols, w, h = f.get("rows") or 1, f.get("columns") or 1, f.get("width") or 160, f.get("height") or 90
    per_sheet = rows * cols
    frags = f["fragments"]
    tile_s = (frags[0].get("duration") or dur / len(frags)) / per_sheet  # the first sheet is always full
    total_tiles = max(1, int(dur / tile_s) + 1)
    out.mkdir(parents=True, exist_ok=True)
    sheets: dict[int, Image.Image] = {}
    shots = []
    for t in [0.5, min(3, dur), dur * 0.25, dur * 0.5, dur * 0.75, dur * 0.93]:
        idx = min(int(t / tile_s), total_tiles - 1)
        sheet, tile = divmod(idx, per_sheet)
        if sheet >= len(frags):
            continue
        if sheet not in sheets:
            try:
                r = httpx.get(frags[sheet]["url"], timeout=20)
                sheets[sheet] = Image.open(io.BytesIO(r.content)).convert("RGB")
            except Exception:  # noqa: BLE001
                continue
        im = sheets[sheet]
        x, y = (tile % cols) * w, (tile // cols) * h
        p = out / f"f{int(t * 10):05d}.jpg"
        im.crop((x, y, x + w, y + h)).save(p, "JPEG", quality=85)
        shots.append((round(t, 1), p))
    return shots


async def _audio_transcript(user_id: str, url: str, work: Path) -> list[dict]:
    """No captions: the audio only, to a temporary file, transcribed by Meta Muse Voice Transcribe and deleted right away."""
    import yt_dlp

    work.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="adtier-", dir=work))
    try:
        def fetch() -> Path | None:
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "format": "bestaudio/best", "outtmpl": str(tmp / "a.%(ext)s"), "noplaylist": True}) as y:
                y.download([url])
            return next(iter(tmp.glob("a.*")), None)
        audio = await asyncio.to_thread(fetch)
        if not audio:
            return []
        segs, _ = await stt.transcribe(user_id, audio, tmp)
        return [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in segs]
    except Exception as e:  # noqa: BLE001
        log.warning("adtier audio %s: %s", url, e)
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _ask(user_id: str, system: str, msg: str, images: list[bytes] | None, temperature: float) -> tuple[dict, str]:
    """JSON from Meta Muse first (it reads images), then any other configured model."""
    from . import studio

    tried = []
    for pid, model, cred in studio._who(user_id, bool(images)):
        try:
            buf: list[str] = []
            async for kind, delta in stream(pid, model, system, msg, temperature=temperature, max_tokens=8000, result=CallResult(), cred=cred, images=images or None):  # type: ignore[arg-type]
                if kind == "text":
                    buf.append(delta)
            data = adsmod._json("".join(buf))
            if data:
                return data, f"{PROVIDERS[pid].label} · {model}"
            tried.append(f"{pid}: sin JSON")
        except Exception as e:  # noqa: BLE001
            tried.append(f"{pid}: {str(e)[:100]}")
    raise RuntimeError("Ningún modelo pudo analizar el video. " + ("; ".join(tried) if tried else "Agregá tu clave de Meta Muse en Configuración."))


def _clamp(v) -> float:
    try:
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


async def analyze(user_id: str, v: dict, frames: list[tuple[float, Path]], transcript: list[dict]) -> dict:
    """Scores, format, hook type, template and proposed tier, from two runs at temperature 0."""
    ev = evidence_of(v["id"])
    lines = "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in transcript) or "(sin transcripción)"
    meta = {k: v.get(k) for k in ("title", "brand", "agency", "year", "country", "language", "platform_origin", "format", "duration_s", "industry", "source_url")}
    msg = (f"METADATA:\n{json.dumps(meta, ensure_ascii=False)}\n\nEVIDENCIA EXTERNA:\n{json.dumps(ev, ensure_ascii=False) if ev else '(ninguna)'}\n\n"
           f"TRANSCRIPCIÓN:\n{lines[:12000]}\n\nCUADROS (en orden): " + ", ".join(f"segundo {t}" for t, _ in frames))
    images = [p.read_bytes() for _, p in frames]
    system = PROMPT_PATH.read_text()
    runs = []
    for _ in range(2):
        data, by = await _ask(user_id, system, msg, images, 0)
        runs.append((data, by))
    a, by = runs[0]
    totals = [total_of({k: _clamp((r.get("scores") or {}).get(k)) for k in WEIGHTS}) for r, _ in runs]
    scores = {k: round(sum(_clamp((r.get("scores") or {}).get(k)) for r, _ in runs) / len(runs), 1) for k in WEIGHTS}
    raw_tier = a.get("evidence_tier")
    ev_tier = raw_tier if isinstance(raw_tier, str) and len(raw_tier) == 1 and raw_tier in TIERS and ev else None
    return {"scores": scores, "total": total_of(scores), "rationale": a.get("rationale") or {}, "format": a.get("format") if a.get("format") in FORMATS else None,
            "hook_type": a.get("hook_type") if a.get("hook_type") in HOOKS else None, "evidence_tier": ev_tier, "evidence_reason": str(a.get("evidence_reason") or "")[:400],
            "template": a.get("template") if isinstance(a.get("template"), dict) else {}, "tags": a.get("tags") if isinstance(a.get("tags"), dict) else {},
            "confidence": max(0.0, min(1.0, float(a.get("confidence") or 0))), "needs_review": abs(totals[0] - totals[-1]) > 10, "model": by, "runs": totals}


async def ingest(user: User, video_id: str) -> None:
    """Every step of one video, resuming from what is already there; ends in «review»."""
    v = get(video_id)
    if not v:
        return
    work = FILES / video_id
    try:
        _set(video_id, stage="meta", error=None)
        o = await oembed(v["embed_provider"], v["source_url"])
        if not o:
            raise RuntimeError("El proveedor no permite embeber este video (oEmbed): no puede entrar al catálogo")
        info = await asyncio.to_thread(_ytinfo, v["source_url"]) or {}
        year = v.get("year") or (int(str(info.get("upload_date"))[:4]) if str(info.get("upload_date") or "")[:4].isdigit() else None)
        _set(video_id, title=v.get("title") or o.get("title") or info.get("title") or "", brand=v.get("brand") or o.get("author_name") or info.get("uploader") or "",
             thumbnail_url=o.get("thumbnail_url") or info.get("thumbnail"), duration_s=float(info.get("duration") or 0) or v.get("duration_s"), year=year,
             language=v.get("language") or info.get("language") or "", embed_ok=1, checked=_now())
        v = get(video_id) or v

        _set(video_id, stage="frames")
        frames = await asyncio.to_thread(_frames, info, work / "frames") if info else []
        if not frames and v.get("thumbnail_url"):  # no storyboard (Vimeo, TikTok): the provider's thumbnail as the only frame
            try:
                async with httpx.AsyncClient(timeout=15) as cx:
                    r = await cx.get(v["thumbnail_url"])
                from PIL import Image

                (work / "frames").mkdir(parents=True, exist_ok=True)
                im = Image.open(io.BytesIO(r.content)).convert("RGB")
                im.thumbnail((640, 640))
                im.save(work / "frames" / "thumb.jpg", "JPEG", quality=85)
                frames = [(0.0, work / "frames" / "thumb.jpg")]
            except Exception:  # noqa: BLE001
                frames = []

        _set(video_id, stage="transcribe")
        transcript = v.get("transcript") or (await asyncio.to_thread(_captions, info, v.get("language") or "") if info else [])
        if not transcript:
            transcript = await _audio_transcript(user.id, v["source_url"], work)
        _set(video_id, transcript=json.dumps(transcript, ensure_ascii=False))

        _set(video_id, stage="analyze")
        a = await analyze(user.id, get(video_id) or v, frames, transcript)
        now = _now()
        tier, basis = final_tier(a["evidence_tier"], a["total"])
        with _db() as c:
            c.execute("INSERT INTO adtier_scores VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (secrets.token_hex(6), video_id, *[a["scores"][k] for k in WEIGHTS], a["total"], a["model"], json.dumps(a["rationale"], ensure_ascii=False),
                       int(a["needs_review"]), a["confidence"], PROMPT_VERSION, None, None, now))
            version = (c.execute("SELECT MAX(version) FROM adtier_templates WHERE video_id = ?", (video_id,)).fetchone()[0] or 0) + 1
            c.execute("INSERT INTO adtier_templates VALUES (?,?,?,?,0,?)", (secrets.token_hex(6), video_id, version, json.dumps(a["template"], ensure_ascii=False), now))
            just = (f"Evidencia: {a['evidence_reason']}. " if a["evidence_tier"] else "") + f"Score {a['total']:g}/100 → {tier_from_score(a['total'])}" + (" (sin evidencia externa no puede ser S)" if a["total"] >= 85 and a["evidence_tier"] != "S" else "")
            c.execute("""INSERT INTO adtier_tiers (video_id, tier, basis, justification, proposed, evidence_tier, score_tier, assigned_at, assigned_by) VALUES (?,?,?,?,?,?,?,?, 'ai')
                         ON CONFLICT(video_id) DO UPDATE SET tier = excluded.tier, basis = excluded.basis, justification = excluded.justification, proposed = excluded.proposed,
                         evidence_tier = excluded.evidence_tier, score_tier = excluded.score_tier, assigned_at = excluded.assigned_at, assigned_by = 'ai'""",
                      (video_id, tier, basis, just, tier, a["evidence_tier"], tier_from_score(a["total"]), now))
        tags = {**(a["tags"] or {}), "hook_type": a["hook_type"]}
        auto = autopublish() and bool(evidence_of(video_id)) and bool(a["template"])
        if auto:  # published as analysed (tier from the evidence first), marked as not reviewed by a person yet
            with _db() as c:
                c.execute("UPDATE adtier_templates SET approved = 1 WHERE video_id = ? AND version = ?", (video_id, version))
        _set(video_id, stage="published" if auto else "review", status="published" if auto else "review", format=v.get("format") or a["format"], tags=json.dumps(tags, ensure_ascii=False))
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("adtier ingest %s", video_id)
        _set(video_id, error=str(e)[:500], stage="error")
    finally:
        _jobs.pop(video_id, None)


def autopublish() -> bool:
    """Videos with external evidence go live as soon as they are analysed (the admin can switch it off and review first)."""
    from .tickets import _setting

    return (_setting("adtier_autopublish") or "1") != "0"


def set_autopublish(on: bool) -> None:
    from .tickets import set_setting

    set_setting("adtier_autopublish", "1" if on else "0")


SEED = Path(__file__).parent / "data" / "adtier_seed.csv"


def seed(user: User) -> dict:
    """The researched winners (Cannes, D&AD, One Show, YouTube Ads Leaderboard, El Ojo, Effie…) that are not in the catalogue
    yet, loaded and analysed. Every row has its official video and a verifiable link to its evidence."""
    if not SEED.exists():
        return {"added": [], "errors": ["No hay semilla"]}
    res = batch(user, SEED.read_text())
    res["errors"] = [e for e in res["errors"] if "ya está en el catálogo" not in e]
    start_ingest(user, res["added"])
    from .tickets import set_setting

    set_setting("adtier_seeded", str(int(_now())))
    return res


def seeded() -> bool:
    from .tickets import _setting

    return bool(_setting("adtier_seeded"))


def seed_size() -> int:
    return max(0, len(SEED.read_text().strip().splitlines()) - 1) if SEED.exists() else 0


def start_ingest(user: User, video_ids: list[str]) -> int:
    """One job per video, one after the other (they share the model and the network)."""
    from .tasks import spawn

    ids = [i for i in video_ids if i not in _jobs and get(i)]
    if not ids:
        return 0

    async def run():
        for i in ids:
            await ingest(user, i)

    t = spawn(run())
    for i in ids:
        _jobs[i] = t  # type: ignore[assignment]
        _set(i, stage="queued", error=None)
    return len(ids)


# ------------------------------------------------------------------------------------------------------------ review

def review(user: User, video_id: str, tier: str, template: dict | None, publish: bool, note: str = "") -> dict:
    """The person's decision: the tier (the evidence rule still holds) and the template; published only from here."""
    v = get(video_id)
    if not v:
        raise ValueError("Video no encontrado")
    t = tier_of(video_id) or {}
    if len(tier) != 1 or tier not in TIERS:
        raise ValueError("Tier inválido")
    if tier == "S" and not evidence_of(video_id):
        raise ValueError("Un video sin evidencia externa no puede ser S")
    now = _now()
    with _db() as c:
        c.execute("""INSERT INTO adtier_tiers (video_id, tier, basis, justification, proposed, assigned_at, assigned_by) VALUES (?,?,?,?,?,?,?)
                     ON CONFLICT(video_id) DO UPDATE SET tier = excluded.tier, basis = CASE WHEN excluded.tier = adtier_tiers.proposed THEN adtier_tiers.basis ELSE 'human' END,
                     justification = CASE WHEN ? != '' THEN ? ELSE adtier_tiers.justification END, assigned_at = excluded.assigned_at, assigned_by = excluded.assigned_by""",
                  (video_id, tier, "human", note, t.get("proposed"), now, user.email, note, note))
        c.execute("UPDATE adtier_scores SET reviewed_by = ?, reviewed_at = ? WHERE video_id = ?", (user.email, now, video_id))
        if template is not None:
            version = (c.execute("SELECT MAX(version) FROM adtier_templates WHERE video_id = ?", (video_id,)).fetchone()[0] or 0) + 1
            c.execute("INSERT INTO adtier_templates VALUES (?,?,?,?,1,?)", (secrets.token_hex(6), video_id, version, json.dumps(template, ensure_ascii=False), now))
        else:
            c.execute("UPDATE adtier_templates SET approved = 1 WHERE video_id = ? AND version = (SELECT MAX(version) FROM adtier_templates WHERE video_id = ?)", (video_id, video_id))
    _set(video_id, status="published" if publish else "review", stage="published" if publish else "review")
    return get(video_id) or {}


def unreviewed() -> list[dict]:
    """Published automatically and not looked at by a person yet."""
    with _db() as c:
        rows = c.execute("""SELECT v.* FROM adtier_videos v JOIN adtier_tiers t ON t.video_id = v.id WHERE v.status = 'published' AND t.assigned_by = 'ai'
                            ORDER BY instr('SABC', t.tier), v.created DESC""").fetchall()
    return [card(_row(r)) for r in rows]


def agreement() -> dict:
    """How often the person kept the tier the model proposed (the brief's bar: more than 70 %)."""
    with _db() as c:
        rows = c.execute("SELECT t.tier, t.proposed FROM adtier_tiers t JOIN adtier_videos v ON v.id = t.video_id WHERE v.status = 'published' AND t.assigned_by != 'ai'").fetchall()
    n = len(rows)
    same = sum(1 for r in rows if r[0] == r[1])
    return {"reviewed": n, "agree": same, "pct": round(100 * same / n) if n else None}


# ------------------------------------------------------------------------------------------------------------ masters

MASTER_SYSTEM = """Sos director/a creativo/a. Te paso las plantillas aprobadas de {n} anuncios del mismo formato ({fmt}) y tier ({tier}).
Escribí la PLANTILLA MAESTRA del formato: la estructura promedio por segundos, los 5 hooks más frecuentes (con un ejemplo de cada uno
tomado de las plantillas), los CTA típicos, las decisiones de producción comunes y qué separa a los mejores. Español neutro.

Respondé SOLO JSON: {{"skeleton": "", "beats": [{{"from": 0, "to": 3, "purpose": "", "what": ""}}], "top_hooks": [{{"type": "", "share": 0.0, "example": ""}}],
"ctas": [""], "production": "", "what_wins": [""], "duration_avg_s": 0}}"""


async def make_master(user: User, fmt: str, tier: str) -> dict:
    with _db() as c:
        rows = c.execute("""SELECT v.id, v.title, v.brand, v.duration_s FROM adtier_videos v JOIN adtier_tiers t ON t.video_id = v.id
                            WHERE v.status = 'published' AND v.format = ? AND t.tier = ?""", (fmt, tier)).fetchall()
    if len(rows) < MASTER_MIN:
        raise ValueError(f"Hacen falta {MASTER_MIN} videos publicados de ese formato y tier (hay {len(rows)})")
    bodies = [{"video": r["title"], "brand": r["brand"], "duration_s": r["duration_s"], "template": (template_of(r["id"], True) or {}).get("body")} for r in rows]
    data, by = await _ask(user.id, MASTER_SYSTEM.format(n=len(rows), fmt=fmt, tier=tier), json.dumps(bodies, ensure_ascii=False)[:60000], None, 0.2)
    with _db() as c:
        c.execute("INSERT OR REPLACE INTO adtier_masters VALUES (?,?,?,?,?,?)", (fmt, tier, json.dumps(data, ensure_ascii=False), json.dumps([r["id"] for r in rows]), by, _now()))
    return masters_list()[0] if masters_list() else {}


def masters_list() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM adtier_masters ORDER BY created DESC").fetchall()
    return [{"format": r["format"], "tier": r["tier"], "body": json.loads(r["body"]), "videos": json.loads(r["videos"]), "model": r["model"], "created": r["created"]} for r in rows]


def master_status() -> list[dict]:
    """Every format × tier with how many published videos it has and whether its master template exists."""
    with _db() as c:
        counts = {(r[0], r[1]): r[2] for r in c.execute("""SELECT v.format, t.tier, COUNT(*) FROM adtier_videos v JOIN adtier_tiers t ON t.video_id = v.id
                                                           WHERE v.status = 'published' AND v.format IS NOT NULL GROUP BY v.format, t.tier""")}
    have = {(m["format"], m["tier"]) for m in masters_list()}
    return [{"format": f, "tier": t, "videos": n, "ready": n >= MASTER_MIN, "made": (f, t) in have} for (f, t), n in sorted(counts.items())]


# ------------------------------------------------------------------------------------------------------------ embeds

async def validate_embeds() -> dict:
    """The daily check: a published video whose provider no longer allows the embed is unpublished."""
    with _db() as c:
        rows = c.execute("SELECT id, embed_provider, source_url FROM adtier_videos WHERE status = 'published'").fetchall()
    off = []
    for r in rows:
        ok = bool(await oembed(r["embed_provider"], r["source_url"]))
        _set(r["id"], embed_ok=int(ok), checked=_now(), **({"status": "review", "error": "El proveedor deshabilitó el embed: se despublicó"} if not ok else {}))
        if not ok:
            off.append(r["id"])
    return {"checked": len(rows), "unpublished": off}


def resume() -> int:
    """After a restart: the videos whose analysis was cut keep going, with the account that loaded them."""
    with _db() as c:
        rows = c.execute("""SELECT v.id, v.created_by, u.email, u.name FROM adtier_videos v JOIN users u ON u.id = v.created_by
                            WHERE v.status = 'draft' AND COALESCE(v.stage, 'queued') NOT IN ('error')""").fetchall()
    by: dict[str, list[str]] = {}
    who: dict[str, User] = {}
    for r in rows:
        by.setdefault(r["created_by"], []).append(r["id"])
        who[r["created_by"]] = User(id=r["created_by"], email=r["email"], name=r["name"] or "")
    return sum(start_ingest(who[k], ids) for k, ids in by.items())


async def daily_loop() -> None:
    try:
        n = resume()
        if n:
            log.info("adtier: resuming %d analyses", n)
    except Exception:  # noqa: BLE001
        log.exception("adtier resume")
    while True:
        await asyncio.sleep(24 * 3600)
        try:
            await validate_embeds()
        except Exception:  # noqa: BLE001
            log.exception("adtier embed check")


# ------------------------------------------------------------------------------------------------------------ export, Tably and MCP

def template_markdown(v: dict, tpl: dict) -> str:
    b = tpl or {}
    hook, cta = b.get("hook") or {}, b.get("cta") or {}
    lines = [f"# {v.get('title')} — plantilla", "", f"{v.get('brand') or ''} · {v.get('agency') or ''} · {v.get('year') or ''} · {v.get('source_url')}", "",
             f"**Esqueleto:** {b.get('reusable_skeleton', '')}", "", f"## Hook ({hook.get('seconds', '0-3')} s) · {hook.get('type', '')}", hook.get("description", ""), f"> {hook.get('line', '')}", "", "## Beats"]
    lines += [f"- {x.get('from')}–{x.get('to')} s · **{x.get('purpose', '')}** — {x.get('visual', '')} / {x.get('audio', '')}" for x in b.get("beats") or []]
    lines += ["", f"## CTA ({cta.get('seconds', '')} s) · {cta.get('type', '')}", f"> {cta.get('line', '')}", "", f"**Tono:** {', '.join(b.get('tone') or [])}",
              f"**Producción:** {json.dumps(b.get('production') or {}, ensure_ascii=False)}", "", f"**Notas de adaptación:** {b.get('adapt_notes', '')}"]
    return "\n".join(lines)


def references(fmt_hint: str | None = None, n: int = 3) -> list[dict]:
    """Approved S/A templates for Tably's own ad scripts: their skeleton, hook and CTA."""
    with _db() as c:
        rows = c.execute("""SELECT v.id, v.title, v.brand, v.format, t.tier FROM adtier_videos v JOIN adtier_tiers t ON t.video_id = v.id
                            WHERE v.status = 'published' AND t.tier IN ('S','A') ORDER BY (v.format = ?) DESC, instr('SABC', t.tier), RANDOM() LIMIT ?""", (fmt_hint or "", n)).fetchall()
    out = []
    for r in rows:
        b = (template_of(r["id"], True) or {}).get("body") or {}
        if b.get("reusable_skeleton"):
            out.append({"tier": r["tier"], "format": r["format"], "skeleton": b.get("reusable_skeleton"), "hook": (b.get("hook") or {}).get("description"), "cta": (b.get("cta") or {}).get("type")})
    return out


MCP_TOOLS = [
    {"name": "search_videos", "description": "Busca anuncios en video del catálogo AdTier por tier (S/A/B/C), formato, industria, idioma, región o texto. Devuelve título, marca, año, tier y link.",
     "inputSchema": {"type": "object", "properties": {"tier": {"type": "string", "enum": list(TIERS)}, "format": {"type": "string", "enum": list(FORMATS)}, "industry": {"type": "string"},
                                                     "language": {"type": "string"}, "region": {"type": "string", "enum": ["latam"]}, "q": {"type": "string"}, "limit": {"type": "integer", "maximum": 20}}}},
    {"name": "get_template", "description": "La plantilla de un anuncio (hook, beats por segundo, CTA, producción, esqueleto reutilizable) por su id o slug.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "list_tiers", "description": "Cómo se asignan los tiers S/A/B/C y cuántos videos hay en cada uno.", "inputSchema": {"type": "object", "properties": {}}},
]


def mcp(req: dict) -> dict | None:
    """A minimal MCP server (JSON-RPC over HTTP) on the published catalogue."""
    rid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
    if rid is None:
        return None  # a notification
    def ok(result):
        return {"jsonrpc": "2.0", "id": rid, "result": result}
    if method == "initialize":
        return ok({"protocolVersion": params.get("protocolVersion") or "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "adtier", "version": "1.0"}})
    if method == "tools/list":
        return ok({"tools": MCP_TOOLS})
    if method == "ping":
        return ok({})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name == "search_videos":
            res = search({k: args.get(k) for k in ("tier", "format", "industry", "language", "region")}, str(args.get("q") or ""), per=min(int(args.get("limit") or 5), 20))
            data = [{k: x[k] for k in ("slug", "title", "brand", "year", "tier", "format", "industry", "duration_s")} | {"url": (get(x["id"]) or {}).get("source_url")} for x in res["videos"]]
        elif name == "get_template":
            v = get(str(args.get("id") or ""))
            tpl = template_of(v["id"], True) if v and v["status"] == "published" else None
            data = {"video": {k: v.get(k) for k in ("title", "brand", "year", "source_url")}, "tier": (tier_of(v["id"]) or {}).get("tier"), "template": tpl["body"]} if tpl else {"error": "No encontrado"}
        elif name == "list_tiers":
            data = {"rules": {"S": "Grand Prix/Oro Cannes Film, Black/Yellow Pencil D&AD, top 10 YouTube Ads Leaderboard, Gran Ojo; score ≥ 85 con evidencia",
                              "A": "Plata/Bronce Cannes, Oro One Show/El Ojo/Wave, performance 180+ días y 5+ variaciones; score 70–84",
                              "B": "Shortlist, 30–180 días activo, 3+ listas editoriales; score 55–69", "C": "Sin evidencia; score < 55"},
                    "counts": facets()["counts"]}
        else:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Herramienta desconocida: {name}"}}
        return ok({"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]})
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Método desconocido: {method}"}}
