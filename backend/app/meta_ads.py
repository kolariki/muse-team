"""Meta Ads: the user connects their ad account once in Tably and publishes the ads made in the «Anuncios» pane.

Publishing creates everything PAUSED — a traffic campaign, one ad set (budget, countries, age) and one ad per format
(vertical for Reels/Stories, square for feed) with the video, its cover and the copy — so no money is spent until the user
turns it on in Ads Manager (the result links straight there).

Setup (once per Tably install, by the admin): a Meta app (developers.facebook.com) with Facebook Login and the Marketing
API, the redirect URI <public URL>/api/meta-ads/callback, and META_ADS_APP_ID / META_ADS_APP_SECRET (or the same values in
Settings). Until Meta approves the app (App Review of ads_management + business verification) it only reaches the ad
accounts of the app's own admins, developers and testers. Without the keys the pane offers the downloads only.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx

from .auth import _db
from .config import env
from .keystore import _fernet

log = logging.getLogger("arena.meta_ads")

PROVIDER = "meta-ads"
SCOPES = ("ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement")
# AdTier reads the reels of the accounts a person gives as reference (Instagram Business Discovery): asked only from there, so an
# app without Instagram access still connects for ads
IG_SCOPES = SCOPES + ("instagram_basic",)
# currencies Meta counts without cents (budgets go in the currency's minimum unit)
NO_CENTS = {"CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"}
_STATES: dict[str, tuple[str, float, tuple[str, ...]]] = {}  # state → (user_id, expires, scopes)


class MetaError(Exception):
    pass


def version() -> str:
    return env("META_GRAPH_VERSION", "v24.0")


def graph() -> str:
    return f"https://graph.facebook.com/{version()}"


def app_creds() -> tuple[str | None, str | None]:
    from .tickets import _setting

    return (_setting("meta_ads_app_id") or env("META_ADS_APP_ID") or None, _setting("meta_ads_app_secret") or env("META_ADS_APP_SECRET") or None)


def ready() -> bool:
    a, s = app_creds()
    return bool(a and s)


def redirect_uri(public_url: str) -> str:
    return f"{public_url.rstrip('/')}/api/meta-ads/callback"


def connection(user_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT account, created, expires FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, PROVIDER)).fetchone()
    if not r:
        return None
    return {"account": r["account"], "since": r["created"], "expired": bool(r["expires"] and r["expires"] < time.time())}


def start(user_id: str, public_url: str, scopes: tuple[str, ...] = SCOPES) -> str:
    now = time.time()
    for k in [k for k, v in _STATES.items() if v[1] < now]:
        _STATES.pop(k, None)
    state = secrets.token_urlsafe(24)
    _STATES[state] = (user_id, now + 600, scopes)
    return f"https://www.facebook.com/{version()}/dialog/oauth?" + urlencode({
        "client_id": app_creds()[0], "redirect_uri": redirect_uri(public_url), "state": state, "response_type": "code", "scope": ",".join(scopes)})


def _check(r: httpx.Response) -> dict:
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code >= 400 or (isinstance(data, dict) and data.get("error")):
        e = (data or {}).get("error") or {}
        raise MetaError(e.get("error_user_msg") or e.get("message") or f"Meta respondió {r.status_code}")
    return data


async def finish(code: str, state: str, public_url: str) -> str:
    """Code → a long-lived token (about 60 days), kept encrypted. Returns the user id."""
    hit = _STATES.pop(state, None)
    if not hit or hit[1] < time.time():
        raise MetaError("El pedido de conexión venció: probá de nuevo desde Tably.")
    user_id = hit[0]
    app_id, secret = app_creds()
    async with httpx.AsyncClient(timeout=20) as cx:
        short = _check(await cx.get(f"{graph()}/oauth/access_token", params={"client_id": app_id, "client_secret": secret, "redirect_uri": redirect_uri(public_url), "code": code}))
        long = _check(await cx.get(f"{graph()}/oauth/access_token", params={"grant_type": "fb_exchange_token", "client_id": app_id, "client_secret": secret, "fb_exchange_token": short["access_token"]}))
        token = long.get("access_token") or short["access_token"]
        me = _check(await cx.get(f"{graph()}/me", params={"fields": "name", "access_token": token}))
    now = time.time()
    expires = now + int(long.get("expires_in") or 60 * 86400) - 3600
    with _db() as c:  # what was granted before stays granted (a reconnect for ads does not take Instagram away)
        old = c.execute("SELECT scopes FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, PROVIDER)).fetchone()
        scopes = list(dict.fromkeys([*hit[2], *((old["scopes"] or "").split(",") if old else [])]))
        c.execute("""INSERT INTO user_connections (user_id, provider, account, enc_refresh, enc_access, expires, scopes, created, updated)
                     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET account = excluded.account,
                     enc_access = excluded.enc_access, expires = excluded.expires, scopes = excluded.scopes, updated = excluded.updated""",
                  (user_id, PROVIDER, me.get("name"), _fernet.encrypt(token.encode()), expires, ",".join(x for x in scopes if x), now, now))
    return user_id


def _token(user_id: str) -> str:
    with _db() as c:
        r = c.execute("SELECT enc_access, expires FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, PROVIDER)).fetchone()
    if not r or not r["enc_access"]:
        raise MetaError("Conectá tu cuenta de Meta Ads primero.")
    if r["expires"] and r["expires"] < time.time():
        raise MetaError("La conexión con Meta venció (dura unos 60 días): volvé a conectar tu cuenta.")
    return _fernet.decrypt(r["enc_access"]).decode()


async def disconnect(user_id: str) -> None:
    try:
        token = _token(user_id)
        async with httpx.AsyncClient(timeout=10) as cx:  # revoke it at Meta too
            await cx.delete(f"{graph()}/me/permissions", params={"access_token": token})
    except Exception:  # noqa: BLE001
        pass
    with _db() as c:
        c.execute("DELETE FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, PROVIDER))


async def assets(user_id: str) -> dict:
    """The ad accounts and the Facebook Pages the user can publish with."""
    token = _token(user_id)
    async with httpx.AsyncClient(timeout=20) as cx:
        acc = _check(await cx.get(f"{graph()}/me/adaccounts", params={"fields": "name,account_id,currency,account_status", "limit": 50, "access_token": token}))
        pages = _check(await cx.get(f"{graph()}/me/accounts", params={"fields": "name,id", "limit": 50, "access_token": token}))
    return {
        # account_status 1 = active; the rest (disabled, unsettled, in review…) cannot run ads
        "accounts": [{"id": a["account_id"], "name": a.get("name") or a["account_id"], "currency": a.get("currency") or "USD", "active": a.get("account_status") == 1} for a in acc.get("data", [])],
        "pages": [{"id": p["id"], "name": p.get("name") or p["id"]} for p in pages.get("data", [])],
    }


def has_instagram(user_id: str) -> bool:
    with _db() as c:
        r = c.execute("SELECT scopes FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, PROVIDER)).fetchone()
    return bool(r) and "instagram_basic" in (r["scopes"] or "").split(",")


async def instagram_reels(user_id: str, username: str, n: int = 30) -> dict:
    """The latest videos of any public professional Instagram account (Business Discovery), read with the person's own connection:
    it needs an Instagram professional account linked to one of their Pages."""
    token = _token(user_id)
    async with httpx.AsyncClient(timeout=25) as cx:
        pages = _check(await cx.get(f"{graph()}/me/accounts", params={"fields": "instagram_business_account", "limit": 50, "access_token": token}))
        ig = next((p["instagram_business_account"]["id"] for p in pages.get("data", []) if p.get("instagram_business_account")), None)
        if not ig:
            raise MetaError("Para leer Instagram, Meta pide que tengas una cuenta de Instagram profesional vinculada a una de tus páginas de Facebook.")
        fields = (f"business_discovery.username({username}){{username,name,followers_count,media.limit({n})"
                  "{caption,media_type,media_product_type,permalink,thumbnail_url,like_count,comments_count,timestamp}}")
        data = _check(await cx.get(f"{graph()}/{ig}", params={"fields": fields, "access_token": token}))
    bd = data.get("business_discovery") or {}
    return {"name": bd.get("name") or username, "followers": bd.get("followers_count"),
            "media": [m for m in (bd.get("media") or {}).get("data", []) if m.get("media_type") == "VIDEO"]}


async def page_reels(user_id: str, ref: str, n: int = 25) -> dict | None:
    """The reels of a Facebook Page the person manages (Meta does not let anyone read the videos of other people's Pages)."""
    token = _token(user_id)
    async with httpx.AsyncClient(timeout=25) as cx:
        pages = _check(await cx.get(f"{graph()}/me/accounts", params={"fields": "name,id,username,link,access_token", "limit": 50, "access_token": token}))
        norm = lambda x: re.sub(r"[^a-z0-9]", "", (x or "").lower())  # noqa: E731
        page = next((p for p in pages.get("data", []) if norm(ref) in {norm(p.get("id")), norm(p.get("username")), norm(p.get("name"))}), None)
        if not page:
            return None
        data = _check(await cx.get(f"{graph()}/{page['id']}/video_reels", params={"fields": "description,permalink_url,length,picture,created_time", "limit": n,
                                                                                    "access_token": page.get("access_token") or token}))
    return {"name": page.get("name") or ref, "media": data.get("data", [])}


def budget_units(amount: float, currency: str) -> int:
    return int(round(amount)) if currency.upper() in NO_CENTS else int(round(amount * 100))


async def publish(user_id: str, ad: dict, base: Path, opts: dict, step) -> dict:
    """Videos and covers up, then campaign → ad set → creatives → ads, all PAUSED. `step(text)` reports progress."""
    token = _token(user_id)
    act = f"act_{str(opts['account_id']).removeprefix('act_')}"
    s = ad["script"]
    link = (opts.get("link") or s.get("link") or "").strip()
    if not link.startswith(("http://", "https://")):
        raise MetaError("El anuncio necesita el link de la app publicada.")
    name = f"{s['name']} · {s.get('angle') or 'Tably'}"[:120]
    async with httpx.AsyncClient(timeout=httpx.Timeout(60, read=300)) as cx:
        async def post(path: str, data: dict, files: dict | None = None) -> dict:
            body = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in data.items()} | {"access_token": token}
            return _check(await cx.post(f"{graph()}/{path}", data=body, files=files))

        uploads = {}
        for fmt in ("vertical", "square"):
            step(f"Subiendo el video {'vertical' if fmt == 'vertical' else 'cuadrado'} a Meta")
            v = await post(f"{act}/advideos", {"name": f"{name} · {fmt}"}, {"source": (f"{fmt}.mp4", (base / f"{fmt}.mp4").read_bytes(), "video/mp4")})
            img = await post(f"{act}/adimages", {}, {"filename": (f"{fmt}.jpg", (base / f"{fmt}.jpg").read_bytes(), "image/jpeg")})
            uploads[fmt] = (v["id"], next(iter((img.get("images") or {}).values()))["hash"])
        step("Meta está procesando los videos")
        for vid, _ in uploads.values():
            for _ in range(60):
                st = _check(await cx.get(f"{graph()}/{vid}", params={"fields": "status", "access_token": token})).get("status") or {}
                if st.get("video_status") == "ready":
                    break
                if st.get("video_status") == "error":
                    raise MetaError("Meta no pudo procesar el video.")
                await asyncio.sleep(5)
            else:
                raise MetaError("Meta tardó demasiado en procesar el video: probá de nuevo en unos minutos.")
        step("Creando la campaña (en pausa)")
        camp = await post(f"{act}/campaigns", {"name": name, "objective": "OUTCOME_TRAFFIC", "status": "PAUSED", "special_ad_categories": [],
                                               "is_adset_budget_sharing_enabled": "false"})
        targeting = {"geo_locations": {"countries": opts["countries"]}, "age_min": int(opts.get("age_min") or 18), "targeting_automation": {"advantage_audience": 1}}
        # a top age or a single gender are hard limits: Meta's Advantage+ audience only takes them at 65 / everyone, so it goes off
        if opts.get("age_max") and int(opts["age_max"]) < 65:
            targeting.update(age_max=int(opts["age_max"]), targeting_automation={"advantage_audience": 0})
        if opts.get("genders") in ("men", "women"):  # Meta: 1 men, 2 women
            targeting.update(genders=[1 if opts["genders"] == "men" else 2], targeting_automation={"advantage_audience": 0})
        adset_body = {"name": name, "campaign_id": camp["id"], "daily_budget": budget_units(float(opts["daily_budget"]), opts.get("currency") or "USD"),
                      "billing_event": "IMPRESSIONS", "optimization_goal": "LINK_CLICKS", "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                      "destination_type": "WEBSITE", "targeting": targeting, "status": "PAUSED"}
        if opts.get("days"):
            adset_body["end_time"] = int(time.time() + int(opts["days"]) * 86400)
        adset = await post(f"{act}/adsets", adset_body)
        step("Creando los anuncios (en pausa)")
        ad_ids = []
        for fmt, (vid, hash_) in uploads.items():
            cr = await post(f"{act}/adcreatives", {"name": f"{name} · {fmt}", "object_story_spec": {"page_id": opts["page_id"], "video_data": {
                "video_id": vid, "image_hash": hash_, "title": s["headline"], "message": s["primary_text"], "link_description": s.get("description") or "",
                "call_to_action": {"type": s["cta_type"], "value": {"link": link}}}}})
            a = await post(f"{act}/ads", {"name": f"{name} · {'Reels y Stories' if fmt == 'vertical' else 'Feed'}", "adset_id": adset["id"],
                                          "creative": {"creative_id": cr["id"]}, "status": "PAUSED"})
            ad_ids.append(a["id"])
    account = act.removeprefix("act_")
    return {"campaign_id": camp["id"], "adset_id": adset["id"], "ad_ids": ad_ids, "account_id": account,
            "manager_url": f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act={account}&selected_campaign_ids={camp['id']}"}
