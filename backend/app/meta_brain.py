"""Meta Ads brain: Tably reads the connected ad account (Marketing API insights), the team's model works out what sells and
what does not, and turns every finished Ad Studio video into a ready ad (copy, audience, budget) to publish PAUSED.

What it reads, for the last 90 days (or the account's whole life when that is empty): every ad's spend, reach, clicks, CTR,
CPC, CPM, results and video retention, its copy and its call to action; and, for the account, results by age and gender,
by placement and by country. The analysis and the proposed ads are kept in <user>/meta_brain.json.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import httpx

from . import ads as adsmod
from . import meta_ads as metaads
from . import studio as studiomod
from .auth import user_dir

log = logging.getLogger("arena.meta_brain")

# the action that counts as «the result», best first (the first one the account has is the one it is judged by)
RESULTS = [
    ("offsite_conversion.fb_pixel_purchase", "compras"), ("purchase", "compras"), ("omni_purchase", "compras"),
    ("offsite_conversion.fb_pixel_lead", "leads"), ("lead", "leads"), ("onsite_conversion.lead_grouped", "leads"),
    ("offsite_conversion.fb_pixel_complete_registration", "registros"), ("complete_registration", "registros"),
    ("onsite_conversion.messaging_conversation_started_7d", "conversaciones"),
    ("landing_page_view", "visitas a la página"), ("link_click", "clics en el link"),
]
AD_FIELDS = ("ad_id,ad_name,campaign_name,adset_name,objective,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,"
             "actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p100_watched_actions")


def _file(user_id: str) -> Path:
    return user_dir(user_id) / "meta_brain.json"


def load(user_id: str) -> dict:
    try:
        return json.loads(_file(user_id).read_text())
    except (OSError, ValueError):
        return {}


def save(user_id: str, data: dict) -> dict:
    p = _file(user_id)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(p)
    return data


def update(user_id: str, **fields) -> dict:
    return save(user_id, {**load(user_id), **fields})


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _act(row: dict, kind: str, field: str = "actions") -> float:
    return sum(_f(a.get("value")) for a in row.get(field) or [] if a.get("action_type") == kind)


def _video(row: dict, field: str) -> float:
    return sum(_f(a.get("value")) for a in row.get(field) or [])


def _text(cr: dict) -> tuple[str, str]:
    """A creative's headline and main text, wherever Meta keeps them (plain, in the post spec or in a dynamic asset feed)."""
    spec = cr.get("object_story_spec") or {}
    data = spec.get("video_data") or spec.get("link_data") or {}
    feed = cr.get("asset_feed_spec") or {}
    title = cr.get("title") or data.get("title") or data.get("name") or ((feed.get("titles") or [{}])[0].get("text")) or ""
    body = cr.get("body") or data.get("message") or ((feed.get("bodies") or [{}])[0].get("text")) or ""
    return title, body


async def _all(cx: httpx.AsyncClient, url: str, params: dict, pages: int = 4) -> list[dict]:
    out: list[dict] = []
    data = metaads._check(await cx.get(url, params=params))
    for _ in range(pages):
        out += data.get("data") or []
        nxt = (data.get("paging") or {}).get("next")
        if not nxt:
            break
        data = metaads._check(await cx.get(nxt))
    return out


async def read_account(user_id: str, account_id: str) -> dict:
    """The account's numbers, compact enough for a model to read: one row per ad plus breakdowns."""
    token = metaads._token(user_id)
    act = f"act_{str(account_id).removeprefix('act_')}"
    g = metaads.graph()
    async with httpx.AsyncClient(timeout=httpx.Timeout(40, read=90)) as cx:
        info = metaads._check(await cx.get(f"{g}/{act}", params={"fields": "name,currency,account_status", "access_token": token}))
        period = "last_90d"
        rows = await _all(cx, f"{g}/{act}/insights", {"level": "ad", "date_preset": period, "fields": AD_FIELDS, "limit": 200, "access_token": token})
        if not rows:
            period = "maximum"
            rows = await _all(cx, f"{g}/{act}/insights", {"level": "ad", "date_preset": period, "fields": AD_FIELDS, "limit": 200, "access_token": token})
        creatives = {}
        if rows:
            for a in await _all(cx, f"{g}/{act}/ads", {"fields": "id,effective_status,creative{title,body,call_to_action_type,object_type,thumbnail_url,video_id,object_story_spec,asset_feed_spec}",
                                                       "limit": 100, "access_token": token}, pages=3):
                creatives[a["id"]] = {**(a.get("creative") or {}), "status": a.get("effective_status")}
        splits = {}
        for name, bd in (("edad_y_genero", "age,gender"), ("ubicacion", "publisher_platform,platform_position"), ("pais", "country")):
            if not rows:
                break
            try:
                splits[name] = await _all(cx, f"{g}/{act}/insights", {"level": "account", "date_preset": period, "breakdowns": bd,
                                                                      "fields": "spend,impressions,clicks,inline_link_clicks,ctr,cpc,actions", "limit": 200, "access_token": token}, pages=2)
            except metaads.MetaError as e:  # a breakdown Meta refuses for this account should not cost the whole reading
                log.info("meta brain breakdown %s: %s", bd, e)
    present = {a.get("action_type") for r in rows for a in r.get("actions") or [] if _f(a.get("value")) > 0}
    result, result_name = next(((k, n) for k, n in RESULTS if k in present), ("link_click", "clics en el link"))

    ads = []
    for r in rows:
        cr = creatives.get(r.get("ad_id")) or {}
        title, body = _text(cr)
        spend, res, imp = _f(r.get("spend")), _act(r, result), _f(r.get("impressions"))
        p25, p100 = _video(r, "video_p25_watched_actions"), _video(r, "video_p100_watched_actions")
        ads.append({"id": r.get("ad_id"), "ad": r.get("ad_name"), "campaign": r.get("campaign_name"), "adset": r.get("adset_name"), "objective": r.get("objective"),
                    "status": cr.get("status"), "kind": "video" if cr.get("video_id") or cr.get("object_type") == "VIDEO" else (cr.get("object_type") or "").lower() or None,
                    "spend": round(spend, 2), "impressions": int(imp), "reach": int(_f(r.get("reach"))), "frequency": round(_f(r.get("frequency")), 2),
                    "link_clicks": int(_f(r.get("inline_link_clicks"))), "ctr": round(_f(r.get("ctr")), 2), "cpc": round(_f(r.get("cpc")), 2), "cpm": round(_f(r.get("cpm")), 2),
                    "results": int(res), "cost_per_result": round(spend / res, 2) if res else None,
                    "video_25_to_100": round(p100 / p25 * 100) if p25 else None, "thruplays": int(_video(r, "video_thruplay_watched_actions")) or None,
                    "headline": title[:120], "text": body[:400], "cta": cr.get("call_to_action_type"), "thumb": cr.get("thumbnail_url")})
    ads.sort(key=lambda a: -a["spend"])

    def split(name: str, keys: tuple[str, ...]) -> list[dict]:
        out = []
        for r in splits.get(name) or []:
            spend, res = _f(r.get("spend")), _act(r, result)
            out.append({**{k: r.get(k) for k in keys}, "spend": round(spend, 2), "ctr": round(_f(r.get("ctr")), 2), "results": int(res),
                        "cost_per_result": round(spend / res, 2) if res else None})
        return sorted(out, key=lambda x: -x["spend"])[:20]

    spend = sum(a["spend"] for a in ads)
    results = sum(a["results"] for a in ads)
    return {"account": {"id": act.removeprefix("act_"), "name": info.get("name"), "currency": info.get("currency") or "USD", "active": info.get("account_status") == 1},
            "period": "últimos 90 días" if period == "last_90d" else "toda la historia de la cuenta",
            "result": result_name, "totals": {"spend": round(spend, 2), "results": results, "cost_per_result": round(spend / results, 2) if results else None,
                                               "impressions": sum(a["impressions"] for a in ads), "link_clicks": sum(a["link_clicks"] for a in ads), "ads": len(ads)},
            "ads": ads[:60], "by_age_gender": split("edad_y_genero", ("age", "gender")), "by_placement": split("ubicacion", ("publisher_platform", "platform_position")),
            "by_country": split("pais", ("country",))}


def videos(user_id: str) -> list[dict]:
    """The Ad Studio videos that are finished, with what they say: what the model writes the ads from."""
    out = []
    for p in studiomod.listing(user_id):
        if p.get("status") != "done" or not p.get("final"):
            continue
        full = studiomod.load(user_id, p["id"]) or {}
        plan = full.get("plan") or {}
        said = " ".join(seg.get("text") or "" for segs in (full.get("transcript") or {}).values() for seg in segs or [])[:700]
        out.append({"id": p["id"], "title": p["title"], "what": (p.get("instructions") or "")[:500], "goal": p.get("goal"), "link": p.get("link") or "",
                    "angle": plan.get("angle") or "", "cta": (plan.get("cta") or {}).get("text") or "", "on_screen": [s.get("title") or s.get("text") for s in plan.get("sequence") or [] if s.get("title") or s.get("text")][:8],
                    "said": said, "seconds": (p.get("final") or {}).get("seconds"), "thumb": "final/vertical.jpg", "ts": (p.get("final") or {}).get("ts")})
    return out


SYSTEM = """Sos el estratega de Meta Ads del equipo. Te paso los números reales de la cuenta publicitaria de la persona (Meta Marketing
API) y los videos que el equipo ya le hizo. Tu trabajo:
1. Leer la cuenta como un media buyer con experiencia: qué anuncios, mensajes, formatos, públicos (edad, género, país) y ubicaciones
   traen resultados al menor costo, y cuáles gastan sin traer nada. Basate en los números: citá el dato que lo prueba (gasto, CTR,
   costo por resultado, retención del video). Si la cuenta tiene poco o nada de historial, decilo y recomendá desde las buenas prácticas
   de Meta (Advantage+ audience, vertical para Reels, gancho en los primeros 3 segundos, etc.).
2. Para CADA video que te paso, armar el anuncio listo para publicar: nombre, ángulo, título (máx. 40 caracteres), texto principal
   (máx. 300, que abra con el gancho que mejor le funcionó a la cuenta o con el más fuerte del video), descripción corta, el botón
   (uno de: {ctas}), países, edades y presupuesto diario en la moneda de la cuenta. Usá lo que aprendiste de la cuenta: el público y
   las ubicaciones que mejor rinden, el tipo de mensaje que funcionó. El link es el del video (no inventes links).
Escribí en {lang}, claro y concreto, sin jerga innecesaria.
Respondé SOLO JSON: {{"summary": "2-3 frases con lo más importante", "history": true, "works": [{{"title": "", "detail": "con el dato"}}],
"fix": [{{"title": "", "detail": "con el dato y qué hacer"}}], "audience": {{"countries": ["AR"], "age_min": 18, "age_max": 65, "genders": "all", "why": ""}},
"placements": "qué ubicaciones priorizar y por qué", "budget": {{"daily": 10, "why": ""}},
"ads": [{{"video": "id del video", "name": "", "angle": "", "headline": "", "primary_text": "", "description": "", "cta_type": "LEARN_MORE",
"countries": ["AR"], "age_min": 18, "age_max": 65, "genders": "all", "daily_budget": 10, "why": "por qué este anuncio así, según la cuenta"}}]}}"""


def _clean(raw: dict, vids: list[dict], currency: str) -> dict:
    def items(xs) -> list[dict]:
        return [{"title": adsmod._cut(x.get("title"), 90), "detail": adsmod._cut(x.get("detail"), 400)} for x in (xs or []) if isinstance(x, dict) and x.get("title")][:6]

    def countries(xs, fallback: list[str]) -> list[str]:
        out = [str(c).upper() for c in (xs or []) if isinstance(c, str) and len(c) == 2 and c.isalpha()]
        return out[:25] or fallback

    def age(v, lo: int, hi: int, d: int) -> int:
        try:
            return max(lo, min(hi, int(v)))
        except (TypeError, ValueError):
            return d

    aud = raw.get("audience") if isinstance(raw.get("audience"), dict) else {}
    base_c = countries(aud.get("countries"), ["US"])
    bud = raw.get("budget") if isinstance(raw.get("budget"), dict) else {}
    daily = max(1.0, _f(bud.get("daily")) or 5.0)
    by_id = {v["id"]: v for v in vids}
    ads, seen = [], set()
    for a in raw.get("ads") or []:
        v = by_id.get(str((a or {}).get("video") or "")) if isinstance(a, dict) else None
        if not v or v["id"] in seen:
            continue
        seen.add(v["id"])
        g = a.get("genders") if a.get("genders") in ("all", "women", "men") else "all"
        lo = age(a.get("age_min"), 13, 65, 18)
        ads.append({"video": v["id"], "name": adsmod._cut(a.get("name") or v["title"], 60), "angle": adsmod._cut(a.get("angle"), 60),
                    "headline": adsmod._cut(a.get("headline"), 40), "primary_text": adsmod._cut(a.get("primary_text"), 300), "description": adsmod._cut(a.get("description"), 60),
                    "cta_type": a.get("cta_type") if a.get("cta_type") in adsmod.CTA_TYPES else "LEARN_MORE", "countries": countries(a.get("countries"), base_c),
                    "age_min": lo, "age_max": max(lo, age(a.get("age_max"), 13, 65, 65)), "genders": g, "daily_budget": round(max(1.0, _f(a.get("daily_budget")) or daily), 2),
                    "link": v["link"], "why": adsmod._cut(a.get("why"), 400)})
    return {"summary": adsmod._cut(raw.get("summary"), 600), "history": bool(raw.get("history")), "works": items(raw.get("works")), "fix": items(raw.get("fix")),
            "audience": {"countries": base_c, "age_min": age(aud.get("age_min"), 13, 65, 18), "age_max": age(aud.get("age_max"), 13, 65, 65),
                         "genders": aud.get("genders") if aud.get("genders") in ("all", "women", "men") else "all", "why": adsmod._cut(aud.get("why"), 300)},
            "placements": adsmod._cut(raw.get("placements"), 400), "budget": {"daily": round(daily, 2), "currency": currency, "why": adsmod._cut(bud.get("why"), 300)}, "ads": ads}


async def analyze(user_id: str, account_id: str, english: bool = False) -> None:
    """Read the account, ask the model, keep the result. Progress and errors go to the stored state the page polls."""
    try:
        update(user_id, status="working", step="Leyendo tu cuenta de Meta Ads", error=None, account_id=str(account_id))
        data = await read_account(user_id, account_id)
        vids = videos(user_id)
        update(user_id, step="La IA está analizando tus anuncios" + (" y armando los nuevos" if vids else ""), data=data)
        cur = data["account"]["currency"]
        system = SYSTEM.format(ctas=", ".join(adsmod.CTA_TYPES), lang="English" if english else "español rioplatense")
        msg = (f"CUENTA ({data['account']['name']}, moneda {cur}, {data['period']}, el resultado que se mide: {data['result']}):\n"
               f"{json.dumps({k: data[k] for k in ('totals', 'ads', 'by_age_gender', 'by_placement', 'by_country')}, ensure_ascii=False)[:30000]}\n\n"
               f"VIDEOS PARA ARMAR LOS ANUNCIOS ({len(vids)}):\n{json.dumps([{k: v[k] for k in ('id', 'title', 'what', 'goal', 'link', 'angle', 'cta', 'on_screen', 'said', 'seconds')} for v in vids], ensure_ascii=False)[:12000] if vids else '(ninguno terminado todavía: dejá ads vacío)'}")
        raw, by = await studiomod.ask(user_id, system, msg, max_tokens=8000)
        res = _clean(raw, vids, cur)
        old = {a["video"]: a for a in (load(user_id).get("analysis") or {}).get("ads") or [] if a.get("meta")}
        for a in res["ads"]:  # an ad already published keeps its campaign link
            if a["video"] in old:
                a["meta"] = old[a["video"]]["meta"]
        update(user_id, status="done", step="", analysis=res, by=by, ts=time.time())
    except Exception as e:  # noqa: BLE001
        log.exception("meta brain %s", user_id)
        update(user_id, status="error", step="", error=str(e)[:400])


def public(user_id: str) -> dict:
    d = load(user_id)
    vids = {v["id"]: v for v in videos(user_id)}
    an = d.get("analysis")
    if an:
        an = {**an, "ads": [{**a, "title": vids[a["video"]]["title"], "ts": vids[a["video"]]["ts"]} for a in an.get("ads") or [] if a["video"] in vids]}
        an["missing"] = [{"id": v["id"], "title": v["title"]} for v in vids.values() if v["id"] not in {a["video"] for a in an["ads"]}]
    data = d.get("data") or {}
    return {"status": d.get("status") or "idle", "step": d.get("step") or "", "error": d.get("error"), "account_id": d.get("account_id"), "by": d.get("by"), "ts": d.get("ts"),
            "account": data.get("account"), "period": data.get("period"), "result": data.get("result"), "totals": data.get("totals"),
            "top": [{k: a.get(k) for k in ("ad", "spend", "results", "cost_per_result", "ctr", "thumb", "status")} for a in sorted(data.get("ads") or [], key=lambda a: -a["spend"])[:6]],
            "analysis": an, "videos": len(vids)}


def mark(user_id: str, video: str, meta: dict) -> None:
    cur = load(user_id)
    for a in (cur.get("analysis") or {}).get("ads") or []:
        if a["video"] == video:
            a["meta"] = meta
    save(user_id, cur)


async def publish(user_id: str, video: str, page_id: str, edits: dict) -> None:
    """One proposed ad to Meta, PAUSED, with the studio video (vertical for Reels/Stories, square for feed)."""
    d = load(user_id)
    an = d.get("analysis") or {}
    ad = next((a for a in an.get("ads") or [] if a["video"] == video), None)
    if not ad:
        raise metaads.MetaError("Ese anuncio ya no está en la propuesta: volvé a analizar la cuenta.")
    for k in ("headline", "primary_text", "description", "link"):
        if isinstance(edits.get(k), str) and edits[k].strip():
            ad[k] = edits[k].strip()[:300]
    if edits.get("cta_type") in adsmod.CTA_TYPES:
        ad["cta_type"] = edits["cta_type"]
    if _f(edits.get("daily_budget")) > 0:
        ad["daily_budget"] = round(_f(edits["daily_budget"]), 2)
    if isinstance(edits.get("countries"), list):
        ad["countries"] = [str(c).upper() for c in edits["countries"] if isinstance(c, str) and len(c) == 2 and c.isalpha()][:25] or ad["countries"]
    base = studiomod.folder(user_id, video) / "renders" / "final"
    for fmt in ("vertical", "square"):
        if not (base / f"{fmt}.mp4").exists():
            raise metaads.MetaError("No encuentro el video terminado: volvé a armarlo en «Crear anuncio».")
        if not (base / f"{fmt}.jpg").exists():
            studiomod.media.thumb(base / f"{fmt}.mp4", base / f"{fmt}.jpg", 1.0)

    def save_ad(meta: dict) -> None:
        cur = load(user_id)
        for a in (cur.get("analysis") or {}).get("ads") or []:
            if a["video"] == video:
                a.update({k: ad[k] for k in ("headline", "primary_text", "description", "link", "cta_type", "daily_budget", "countries")}, meta=meta)
        save(user_id, cur)

    def step(text: str) -> None:
        save_ad({"status": "publishing", "step": text})

    try:
        step("Conectando con Meta")
        script = {"name": ad["name"], "angle": ad.get("angle") or "Tably", "headline": ad["headline"], "primary_text": ad["primary_text"],
                  "description": ad.get("description") or "", "cta_type": ad["cta_type"], "link": ad.get("link") or ""}
        opts = {"account_id": d.get("account_id"), "page_id": page_id, "currency": (d.get("data") or {}).get("account", {}).get("currency") or "USD",
                "daily_budget": ad["daily_budget"], "countries": ad["countries"], "age_min": ad["age_min"], "age_max": ad["age_max"], "genders": ad["genders"],
                "link": ad.get("link") or "", "days": edits.get("days")}
        res = await metaads.publish(user_id, {"script": script}, base, opts, step)
        save_ad({"status": "done", **res, "published": time.time()})
    except Exception as e:  # noqa: BLE001
        log.exception("meta brain publish %s", video)
        save_ad({"status": "error", "error": str(e)[:400]})
