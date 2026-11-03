"""The user's own accounts connected to Muse Team (Google Calendar first), for the apps they build for themselves.

Apps never handle the provider's OAuth: the user connects the account once in Muse Team, and their published app reads through
Muse Team with its own token (GET /api/connect/<site>/google-calendar/events, Authorization: Bearer TABLY_TOKEN). The owner of
the app is the owner of the data: an app only ever sees the connections of the user who built it.

Setup (once per Muse Team install): a Google Cloud OAuth client of type «Web application» with the redirect URI
<public URL>/api/connections/google/callback, loaded by the admin in Settings (or GOOGLE_OAUTH_CLIENT_ID / _SECRET).
"""
from __future__ import annotations

import json
import secrets
import time
from urllib.parse import quote, urlencode

import httpx

from .auth import _db
from .config import env
from .keystore import _fernet

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS user_connections (
            user_id TEXT NOT NULL, provider TEXT NOT NULL, account TEXT, enc_refresh BLOB, enc_access BLOB, expires REAL,
            scopes TEXT, created REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY (user_id, provider))"""
    )

GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke"
CAL_API = "https://www.googleapis.com/calendar/v3"

PROVIDERS: dict[str, dict] = {
    "google-calendar": {
        "label": "Google Calendar", "kind": "google",
        "scopes": ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
        "what": "Lee tus calendarios y eventos (solo lectura). Tus apps los ven a través de Muse Team, nunca con tu contraseña.",
        "what_en": "Reads your calendars and events (read-only). Your apps see them through Muse Team, never with your password.",
    },
}

_STATES: dict[str, tuple[str, str, float]] = {}  # state → (user_id, provider, expires)


def google_creds() -> tuple[str | None, str | None]:
    """The install's Google OAuth client: set by the admin in Settings, or GOOGLE_OAUTH_CLIENT_ID / _SECRET in the environment."""
    from .tickets import _setting

    return (_setting("google_client_id") or env("GOOGLE_OAUTH_CLIENT_ID") or None, _setting("google_client_secret") or env("GOOGLE_OAUTH_CLIENT_SECRET") or None)


def google_ready() -> bool:
    cid, sec = google_creds()
    return bool(cid and sec)


def redirect_uri(public_url: str) -> str:
    return f"{public_url.rstrip('/')}/api/connections/google/callback"


def listing(user_id: str) -> list[dict]:
    with _db() as c:
        rows = {r["provider"]: dict(r) for r in c.execute("SELECT provider, account, created, updated, scopes FROM user_connections WHERE user_id = ?", (user_id,))}
    out = []
    for pid, p in PROVIDERS.items():
        r = rows.get(pid)
        out.append({"id": pid, "label": p["label"], "what": p["what"], "what_en": p["what_en"], "connected": bool(r), "account": (r or {}).get("account"),
                    "since": (r or {}).get("created"), "ready": google_ready() if p["kind"] == "google" else True})
    return out


def start(user_id: str, provider: str, public_url: str) -> str:
    """The provider's consent page for this user (the state ties the answer back to them for 10 minutes)."""
    p = PROVIDERS[provider]
    now = time.time()
    for k in [k for k, v in _STATES.items() if v[2] < now]:
        _STATES.pop(k, None)
    state = secrets.token_urlsafe(24)
    _STATES[state] = (user_id, provider, now + 600)
    return GOOGLE_AUTH + "?" + urlencode({
        "client_id": google_creds()[0], "redirect_uri": redirect_uri(public_url), "response_type": "code",
        "scope": " ".join(p["scopes"]), "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true", "state": state,
    })


async def finish(code: str, state: str, public_url: str) -> tuple[str, str]:
    """Code → tokens, kept encrypted. Returns (user_id, provider)."""
    hit = _STATES.pop(state, None)
    if not hit or hit[2] < time.time():
        raise ValueError("El pedido de conexión venció: probá de nuevo desde Muse Team.")
    user_id, provider, _ = hit
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.post(GOOGLE_TOKEN, data={"code": code, "client_id": google_creds()[0], "client_secret": google_creds()[1],
                                              "redirect_uri": redirect_uri(public_url), "grant_type": "authorization_code"})
    tok = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or not tok.get("access_token"):
        raise ValueError(f"Google no aceptó la conexión: {tok.get('error_description') or tok.get('error') or r.status_code}")
    account = None
    try:  # the id_token's payload says which Google account it is (no signature check needed: it came straight from Google over TLS)
        import base64

        part = (tok.get("id_token") or "").split(".")[1]
        account = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("email")
    except Exception:  # noqa: BLE001
        pass
    now = time.time()
    with _db() as c:
        old = c.execute("SELECT enc_refresh FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, provider)).fetchone()
        refresh = _fernet.encrypt(tok["refresh_token"].encode()) if tok.get("refresh_token") else (old["enc_refresh"] if old else None)
        c.execute("""INSERT INTO user_connections (user_id, provider, account, enc_refresh, enc_access, expires, scopes, created, updated)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET account = excluded.account,
                     enc_refresh = excluded.enc_refresh, enc_access = excluded.enc_access, expires = excluded.expires, scopes = excluded.scopes, updated = excluded.updated""",
                  (user_id, provider, account, refresh, _fernet.encrypt(tok["access_token"].encode()), now + int(tok.get("expires_in") or 3600) - 60,
                   tok.get("scope") or "", now, now))
    return user_id, provider


async def disconnect(user_id: str, provider: str) -> None:
    with _db() as c:
        r = c.execute("SELECT enc_refresh FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, provider)).fetchone()
        c.execute("DELETE FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, provider))
    if r and r["enc_refresh"]:
        try:  # also revoke it at Google, so nothing keeps working with it
            async with httpx.AsyncClient(timeout=10) as cx:
                await cx.post(GOOGLE_REVOKE, data={"token": _fernet.decrypt(r["enc_refresh"]).decode()})
        except Exception:  # noqa: BLE001
            pass


async def _access(user_id: str, provider: str) -> str | None:
    """A valid access token (refreshed when it expired), or None when the account is not connected or was revoked."""
    with _db() as c:
        r = c.execute("SELECT * FROM user_connections WHERE user_id = ? AND provider = ?", (user_id, provider)).fetchone()
    if not r:
        return None
    if r["enc_access"] and (r["expires"] or 0) > time.time():
        return _fernet.decrypt(r["enc_access"]).decode()
    if not r["enc_refresh"]:
        return None
    async with httpx.AsyncClient(timeout=20) as cx:
        res = await cx.post(GOOGLE_TOKEN, data={"client_id": google_creds()[0], "client_secret": google_creds()[1],
                                                "refresh_token": _fernet.decrypt(r["enc_refresh"]).decode(), "grant_type": "refresh_token"})
    tok = res.json() if res.status_code == 200 else {}
    if not tok.get("access_token"):
        return None
    with _db() as c:
        c.execute("UPDATE user_connections SET enc_access = ?, expires = ?, updated = ? WHERE user_id = ? AND provider = ?",
                  (_fernet.encrypt(tok["access_token"].encode()), time.time() + int(tok.get("expires_in") or 3600) - 60, time.time(), user_id, provider))
    return tok["access_token"]


def _event(e: dict, cal: str) -> dict:
    s, en = e.get("start") or {}, e.get("end") or {}
    return {"id": e.get("id"), "calendar": cal, "title": e.get("summary") or "(sin título)", "start": s.get("dateTime") or s.get("date"),
            "end": en.get("dateTime") or en.get("date"), "all_day": "date" in s and "dateTime" not in s, "location": e.get("location"),
            "description": (e.get("description") or "")[:1000] or None, "link": e.get("htmlLink"), "meet": e.get("hangoutLink"),
            "status": e.get("status"), "attendees": [a.get("email") for a in (e.get("attendees") or [])[:30] if a.get("email")],
            "organizer": (e.get("organizer") or {}).get("email")}


async def calendar_events(user_id: str, time_min: str, time_max: str, limit: int = 250) -> dict:
    """Events of every calendar the user has selected in Google Calendar, between two ISO dates, in order."""
    token = await _access(user_id, "google-calendar")
    if not token:
        return {"connected": False, "account": None, "calendars": [], "events": []}
    with _db() as c:
        account = (c.execute("SELECT account FROM user_connections WHERE user_id = ? AND provider = 'google-calendar'", (user_id,)).fetchone() or {"account": None})["account"]
    h = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=20, headers=h) as cx:
        cl = await cx.get(f"{CAL_API}/users/me/calendarList", params={"minAccessRole": "reader", "maxResults": 50})
        cals = [x for x in (cl.json().get("items") or []) if x.get("selected", True)] if cl.status_code == 200 else [{"id": "primary", "summary": account or "primary"}]
        events: list[dict] = []
        for cal in cals[:12]:
            r = await cx.get(f"{CAL_API}/calendars/{quote(cal['id'], safe='')}/events",
                             params={"timeMin": time_min, "timeMax": time_max, "singleEvents": "true", "orderBy": "startTime", "maxResults": min(limit, 250)})
            if r.status_code == 200:
                events += [_event(e, cal.get("summary") or cal["id"]) for e in r.json().get("items") or [] if e.get("status") != "cancelled"]
    events.sort(key=lambda e: e["start"] or "")
    return {"connected": True, "account": account, "calendars": [{"id": x["id"], "name": x.get("summary"), "color": x.get("backgroundColor")} for x in cals[:12]],
            "events": events[:limit]}


CONNECT_RULE = ("DATOS DE LAS CUENTAS DEL USUARIO (Google Calendar…): nunca implementes OAuth ni pidas claves de Google. La app los lee de Muse Team desde el servidor: "
                "GET `${process.env.TABLY_URL}/api/connect/${process.env.TABLY_SITE}/google-calendar/events?from=<ISO>&to=<ISO>` con el header "
                "`Authorization: Bearer ${process.env.TABLY_TOKEN}`. Responde {connected, account, calendars:[{id,name,color}], events:[{id, calendar, title, start, end, "
                "all_day, location, description, link, meet, attendees, organizer}]} (start/end en ISO). Si connected es false, mostrá un estado claro: "
                "«Conectá tu Google Calendar en Muse Team → Servicios» (no es un error). Cacheá la respuesta unos minutos y nunca expongas TABLY_TOKEN al navegador.")
