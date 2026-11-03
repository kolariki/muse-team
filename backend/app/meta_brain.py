"""Meta Ads brain: Muse Team reads the connected ad account (Marketing API insights), the team's model works out what sells and
what does not, and turns every finished Ad Studio video into a ready ad (copy, audience, budget) to publish PAUSED.

What it reads, for the last 90 days (or the account's whole life when that is empty): every ad's spend, reach, clicks, CTR,
CPC, CPM, results and video retention, its copy and its call to action; and, for the account, results by age and gender,
by placement and by country. The analysis and the proposed ads are kept in <user>/meta_brain.json.
"""
from __future__ import annotations

import json
import re
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
AD_FIELDS = ("ad_id,ad_name,adset_id,campaign_id,campaign_name,adset_name,objective,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,"
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
        adsets, camps = [], []
        if rows:
            try:
                adsets = await _all(cx, f"{g}/{act}/adsets", {"fields": "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,targeting", "limit": 100, "access_token": token}, pages=2)
                camps = await _all(cx, f"{g}/{act}/campaigns", {"fields": "id,name,objective,effective_status,daily_budget,lifetime_budget", "limit": 100, "access_token": token}, pages=2)
            except metaads.MetaError as e:
                log.info("meta brain adsets/campaigns: %s", e)
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
        ads.append({"id": r.get("ad_id"), "adset_id": r.get("adset_id"), "campaign_id": r.get("campaign_id"), "ad": r.get("ad_name"), "campaign": r.get("campaign_name"), "adset": r.get("adset_name"), "objective": r.get("objective"),
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
    cur = info.get("currency") or "USD"
    money = lambda v: (_f(v) if cur.upper() in metaads.NO_CENTS else _f(v) / 100) if v else None  # noqa: E731  Meta keeps budgets in cents

    def aud(t: dict) -> dict:
        t = t or {}
        return {"age_min": t.get("age_min"), "age_max": t.get("age_max"), "genders": {1: "men", 2: "women"}.get((t.get("genders") or [0])[0], "all") if len(t.get("genders") or []) == 1 else "all",
                "countries": (t.get("geo_locations") or {}).get("countries"), "publisher_platforms": t.get("publisher_platforms") or "automáticas",
                "advantage_audience": (t.get("targeting_automation") or {}).get("advantage_audience")}

    used = {a["adset_id"] for a in ads} | {a["campaign_id"] for a in ads}
    sets = [{"id": x["id"], "name": x.get("name"), "campaign_id": x.get("campaign_id"), "status": x.get("effective_status"), "daily_budget": money(x.get("daily_budget")),
             "lifetime_budget": money(x.get("lifetime_budget")), **aud(x.get("targeting"))} for x in adsets if x["id"] in used or x.get("effective_status") == "ACTIVE"][:40]
    cps = [{"id": x["id"], "name": x.get("name"), "objective": x.get("objective"), "status": x.get("effective_status"), "daily_budget": money(x.get("daily_budget")),
            "lifetime_budget": money(x.get("lifetime_budget"))} for x in camps if x["id"] in used or x.get("effective_status") == "ACTIVE"][:30]
    return {"adsets": sets, "campaigns": cps, "account": {"id": act.removeprefix("act_"), "name": info.get("name"), "currency": info.get("currency") or "USD", "active": info.get("account_status") == 1},
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
3. A cada punto de «works» y «fix» agregale las acciones concretas que Muse Team puede hacer en la cuenta con un toque (si no hay ninguna,
   dejá actions vacío). Usá SOLO los id de anuncios (ads), conjuntos (adsets) y campañas (campaigns) que te paso. Tipos:
   - {{"type": "pause", "level": "ad|adset|campaign", "id": "", "name": "", "label": "Pausar …"}}  (frenarlo; se puede reactivar)
   - {{"type": "activate", "level": "ad|adset|campaign", "id": "", "name": "", "label": "Activar …"}}
   - {{"type": "delete", "level": "ad|adset|campaign", "id": "", "name": "", "label": "Eliminar …"}}  (solo si no sirve más; no se puede deshacer)
   - {{"type": "budget", "level": "adset|campaign", "id": "", "name": "", "daily_budget": 0, "label": "Subir/Bajar el presupuesto a …"}}  (en la
     moneda de la cuenta y en el nivel donde está el presupuesto: si la campaña tiene daily_budget, en la campaña; si no, en el conjunto)
   - {{"type": "targeting", "level": "adset", "id": "", "name": "", "age_min": 18, "age_max": 65, "genders": "all|women|men",
     "publisher_platforms": ["facebook","instagram"], "facebook_positions": ["feed","story","facebook_reels"], "instagram_positions": ["stream","story","reels"], "label": "…"}}
     (solo los campos que cambian; las ubicaciones solo si hay que sacar alguna)
   Un «label» corto con el verbo y el nombre, por ejemplo «Pausar Lote Maipú 1».
Cómo escribir (lo lee el dueño del negocio, no un técnico): en {lang}, claro y concreto. Nunca escribas los id numéricos ni los nombres
técnicos de la API (OUTCOME_SALES, link_click, platform_position…): nombrá cada anuncio o campaña por su nombre entre comillas y decí
«objetivo Ventas», «objetivo Clientes potenciales», «Reels de Instagram», etc. Montos redondeados, con separador de miles y la moneda
(«ARS 91.854»). Cada «title» de hasta 8 palabras; cada «detail» de 1 o 2 frases cortas con el dato clave y qué hacer. A cada punto ponele
un «impact»: la cifra que lo resume en menos de 28 caracteres («ARS 2.373 por lead», «ARS 99.847 sin leads», «CTR 9,3 %»).
Respondé SOLO JSON: {{"summary": "2-3 frases con lo más importante", "history": true, "works": [{{"title": "", "detail": "con el dato", "impact": "", "actions": []}}],
"fix": [{{"title": "", "detail": "con el dato y qué hacer", "impact": "", "actions": [{{"type": "pause", "level": "ad", "id": "", "name": "", "label": ""}}]}}], "audience": {{"countries": ["AR"], "age_min": 18, "age_max": 65, "genders": "all", "why": ""}},
"placements": "qué ubicaciones priorizar y por qué", "budget": {{"daily": 10, "why": ""}},
"ads": [{{"video": "id del video", "name": "", "angle": "", "headline": "", "primary_text": "", "description": "", "cta_type": "LEARN_MORE",
"countries": ["AR"], "age_min": 18, "age_max": 65, "genders": "all", "daily_budget": 10, "why": "por qué este anuncio así, según la cuenta"}}]}}"""


FB_POS = {"feed", "right_hand_column", "marketplace", "video_feeds", "story", "search", "instream_video", "facebook_reels", "facebook_reels_overlay", "profile_feed", "notification"}
IG_POS = {"stream", "story", "explore", "explore_home", "reels", "profile_feed", "ig_search", "profile_reels"}


def clean_actions(xs, data: dict) -> list[dict]:
    """The model's actions on ids that exist in the account, with only the fields each type takes."""
    ids = {"ad": {a["id"]: a.get("ad") for a in data.get("ads") or []}, "adset": {a["id"]: a.get("name") for a in data.get("adsets") or []},
           "campaign": {c["id"]: c.get("name") for c in data.get("campaigns") or []}}
    for a in data.get("ads") or []:  # an ad's set and campaign are known even when their listing was cut
        ids["adset"].setdefault(a.get("adset_id"), a.get("adset"))
        ids["campaign"].setdefault(a.get("campaign_id"), a.get("campaign"))
    out = []
    for x in (xs or [])[:5]:
        if not isinstance(x, dict) or x.get("type") not in ("pause", "activate", "delete", "budget", "targeting"):
            continue
        lvl = x.get("level") if x.get("level") in ids else None
        if x["type"] == "targeting":
            lvl = "adset"
        if x["type"] == "budget" and lvl == "ad":
            continue
        i = str(x.get("id") or "")
        if not lvl or i not in ids[lvl]:
            continue
        a = {"type": x["type"], "level": lvl, "id": i, "name": adsmod._cut(x.get("name") or ids[lvl][i], 80), "label": adsmod._cut(x.get("label"), 70)}
        if x["type"] == "budget":
            if _f(x.get("daily_budget")) <= 0:
                continue
            a["daily_budget"] = round(_f(x["daily_budget"]), 2)
        if x["type"] == "targeting":
            for k in ("age_min", "age_max"):
                if x.get(k) is not None:
                    try:
                        a[k] = max(13, min(65, int(x[k])))
                    except (TypeError, ValueError):
                        pass
            if x.get("genders") in ("all", "women", "men"):
                a["genders"] = x["genders"]
            pp = [p for p in x.get("publisher_platforms") or [] if p in ("facebook", "instagram", "audience_network", "messenger")]
            if pp:
                a["publisher_platforms"] = pp
                a["facebook_positions"] = [p for p in x.get("facebook_positions") or [] if p in FB_POS]
                a["instagram_positions"] = [p for p in x.get("instagram_positions") or [] if p in IG_POS]
            if len(a) <= 5:
                continue
        a["label"] = a["label"] or {"pause": "Pausar", "activate": "Activar", "delete": "Eliminar", "budget": "Cambiar presupuesto", "targeting": "Cambiar público"}[x["type"]] + f" {a['name']}"
        out.append(a)
    return out


API_WORDS = {"OUTCOME_SALES": "objetivo Ventas", "OUTCOME_LEADS": "objetivo Clientes potenciales", "OUTCOME_TRAFFIC": "objetivo Tráfico",
             "OUTCOME_ENGAGEMENT": "objetivo Interacción", "OUTCOME_AWARENESS": "objetivo Reconocimiento", "OUTCOME_APP_PROMOTION": "objetivo Promoción de app"}


def _names(data: dict) -> dict[str, str]:
    out = {str(a.get("id")): a.get("ad") for a in data.get("ads") or []}
    out.update({str(x.get("id")): x.get("name") for x in [*(data.get("adsets") or []), *(data.get("campaigns") or [])]})
    return out


def _plain(t, names: dict[str, str]) -> str:
    """No raw ids or API names in what the owner reads, even when the model slips them in."""
    t = re.sub(r"\b(?:[Aa]d|[Aa]nuncio|[Cc]ampa(?:ign|ña)|[Aa]d ?set|[Cc]onjunto)?\s*(\d{10,})\b", lambda m: f"«{names[m.group(1)]}»" if names.get(m.group(1)) else "", str(t or ""))
    for k, v in API_WORDS.items():
        t = t.replace(k, v)
    return re.sub(r"\s{2,}", " ", t).strip()


def _clean(raw: dict, vids: list[dict], currency: str, data: dict | None = None) -> dict:
    names = _names(data or {})
    plain = lambda t: _plain(t, names)  # noqa: E731

    def items(xs) -> list[dict]:
        return [{"title": adsmod._cut(plain(x.get("title")), 90), "detail": adsmod._cut(plain(x.get("detail")), 400), "impact": adsmod._cut(plain(x.get("impact")), 32),
                 "actions": clean_actions(x.get("actions"), data or {})}
                for x in (xs or []) if isinstance(x, dict) and x.get("title")][:6]

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
    return {"summary": adsmod._cut(plain(raw.get("summary")), 600), "history": bool(raw.get("history")), "works": items(raw.get("works")), "fix": items(raw.get("fix")),
            "audience": {"countries": base_c, "age_min": age(aud.get("age_min"), 13, 65, 18), "age_max": age(aud.get("age_max"), 13, 65, 65),
                         "genders": aud.get("genders") if aud.get("genders") in ("all", "women", "men") else "all", "why": adsmod._cut(aud.get("why"), 300)},
            "placements": adsmod._cut(plain(raw.get("placements")), 400), "budget": {"daily": round(daily, 2), "currency": currency, "why": adsmod._cut(bud.get("why"), 300)}, "ads": ads}


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
               f"{json.dumps({k: data.get(k) for k in ('totals', 'campaigns', 'adsets', 'ads', 'by_age_gender', 'by_placement', 'by_country')}, ensure_ascii=False)[:40000]}\n\n"
               f"VIDEOS PARA ARMAR LOS ANUNCIOS ({len(vids)}):\n{json.dumps([{k: v[k] for k in ('id', 'title', 'what', 'goal', 'link', 'angle', 'cta', 'on_screen', 'said', 'seconds')} for v in vids], ensure_ascii=False)[:12000] if vids else '(ninguno terminado todavía: dejá ads vacío)'}")
        raw, by = await studiomod.ask(user_id, system, msg, max_tokens=8000)
        res = _clean(raw, vids, cur, data)
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
    if an:  # analyses kept before the wording rules: same scrub on the way out
        names = _names(d.get("data") or {})
        an = {**an, "summary": _plain(an.get("summary"), names), "placements": _plain(an.get("placements"), names),
              **{k: [{**x, "title": _plain(x.get("title"), names), "detail": _plain(x.get("detail"), names)} for x in an.get(k) or []] for k in ("works", "fix")}}
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
        script = {"name": ad["name"], "angle": ad.get("angle") or "Muse Team", "headline": ad["headline"], "primary_text": ad["primary_text"],
                  "description": ad.get("description") or "", "cta_type": ad["cta_type"], "link": ad.get("link") or ""}
        opts = {"account_id": d.get("account_id"), "page_id": page_id, "currency": (d.get("data") or {}).get("account", {}).get("currency") or "USD",
                "daily_budget": ad["daily_budget"], "countries": ad["countries"], "age_min": ad["age_min"], "age_max": ad["age_max"], "genders": ad["genders"],
                "link": ad.get("link") or "", "days": edits.get("days")}
        res = await metaads.publish(user_id, {"script": script}, base, opts, step)
        save_ad({"status": "done", **res, "published": time.time()})
    except Exception as e:  # noqa: BLE001
        log.exception("meta brain publish %s", video)
        save_ad({"status": "error", "error": str(e)[:400]})


async def run_action(user_id: str, kind: str, idx: int, j: int, edits: dict) -> dict:
    """One of the analysis' actions on the ad account (pause, activate, delete, budget, audience or placements), done through the
    Marketing API. The result is kept on the action so the page shows it done."""
    d = load(user_id)
    try:
        a = {**((d.get("analysis") or {})[kind][idx]["actions"][j])}
    except (KeyError, IndexError, TypeError):
        raise metaads.MetaError("Esa acción ya no está: volvé a analizar la cuenta.")
    if a["type"] in ("pause", "activate", "delete") and edits.get("type") in ("pause", "activate", "delete"):  # the same ad, another way
        a["type"] = edits["type"]
    if a["type"] == "budget" and _f(edits.get("daily_budget")) > 0:
        a["daily_budget"] = round(_f(edits["daily_budget"]), 2)
    if a["type"] == "targeting":
        for k in ("age_min", "age_max"):
            if edits.get(k) is not None:
                a[k] = max(13, min(65, int(_f(edits[k]))))
        if edits.get("genders") in ("all", "women", "men"):
            a["genders"] = edits["genders"]
    token = metaads._token(user_id)
    g = metaads.graph()
    cur = ((d.get("data") or {}).get("account") or {}).get("currency") or "USD"
    async with httpx.AsyncClient(timeout=40) as cx:
        async def post(body: dict) -> dict:
            return metaads._check(await cx.post(f"{g}/{a['id']}", data={k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in body.items()} | {"access_token": token}))

        if a["type"] in ("pause", "activate", "delete"):
            await post({"status": {"pause": "PAUSED", "activate": "ACTIVE", "delete": "DELETED"}[a["type"]]})
            msg = {"pause": "Pausado", "activate": "Activado", "delete": "Eliminado"}[a["type"]]
        elif a["type"] == "budget":
            await post({"daily_budget": metaads.budget_units(a["daily_budget"], cur)})
            msg = f"Presupuesto diario: {a['daily_budget']:g} {cur}"
        else:
            t = metaads._check(await cx.get(f"{g}/{a['id']}", params={"fields": "targeting", "access_token": token})).get("targeting") or {}
            for k in ("age_min", "age_max"):
                if a.get(k) is not None:
                    t[k] = a[k]
            if a.get("genders"):
                if a["genders"] == "all":
                    t.pop("genders", None)
                else:
                    t["genders"] = [1 if a["genders"] == "men" else 2]
            if a.get("publisher_platforms"):
                t["publisher_platforms"] = a["publisher_platforms"]
                for k in ("facebook_positions", "instagram_positions"):
                    if a.get(k):
                        t[k] = a[k]
                    else:
                        t.pop(k, None)
                for k in ("audience_network_positions", "messenger_positions"):
                    if k.split("_")[0] not in "".join(a["publisher_platforms"]):
                        t.pop(k, None)
            # a top age, a single gender or chosen placements are hard limits: Advantage+ audience only takes them as suggestions
            if (t.get("age_max") and t["age_max"] < 65) or t.get("genders"):
                t["targeting_automation"] = {**(t.get("targeting_automation") or {}), "advantage_audience": 0}
            await post({"targeting": t})
            msg = "Público y ubicaciones actualizados"
    cur_d = load(user_id)
    cur_d["analysis"][kind][idx]["actions"][j] = {**a, "done": {"ok": True, "msg": msg, "ts": time.time()}}
    save(user_id, cur_d)
    return {"ok": True, "msg": msg}
