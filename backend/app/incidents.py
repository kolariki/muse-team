"""Errors of published apps, caught while people use them, and fixed by the builder by itself.

Two sources:
- the server's own log on Railway, read every few minutes: unhandled errors, failed jobs, crashes, missing tables…
- the browser: a small script Muse Team adds to the app's index.html reports uncaught errors and API calls answered with 5xx.
Errors are grouped by fingerprint (same cause = one incident), kept in `app_errors`, written to `.tably/errores.md` in the
project and handed to the builder (main.on_app_errors) to fix and publish again. A fix that is big (the builder says so, or
the diff is) waits for the user's approval, explained in plain words.

Incident status: open → fixing → deploying → fixed; needs_approval (big fix, waits for the user); stuck (fixed twice and it
keeps happening); ignored (the user said no).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Callable

import httpx

from .auth import _db
from . import observe as _observe  # noqa: F401  (creates app_error_events, each occurrence's row)

log = logging.getLogger("arena.incidents")

INTERVAL = 150  # seconds between reads of the live apps' logs
FIRST_WINDOW = 30 * 60  # the first read of a deployment looks this far back
ERRORS_FILE = ".tably/errores.md"
FIX_FILE = ".tably/arreglo.json"
MARK = "tably-errors"

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS app_errors (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, build_id TEXT NOT NULL, fingerprint TEXT NOT NULL, source TEXT NOT NULL,
            title TEXT NOT NULL, detail TEXT, sample TEXT, count INTEGER NOT NULL DEFAULT 1, first_ts REAL NOT NULL, last_ts REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'open', attempts INTEGER NOT NULL DEFAULT 0, size TEXT, applied INTEGER NOT NULL DEFAULT 0,
            what TEXT, fix TEXT, impact TEXT, fix_ts REAL, fixed_ts REAL, UNIQUE (user_id, build_id, fingerprint))"""
    )
    _c.execute("CREATE TABLE IF NOT EXISTS app_error_cursors (user_id TEXT NOT NULL, build_id TEXT NOT NULL, deployment TEXT, cursor TEXT, PRIMARY KEY (user_id, build_id))")

# what an error means, for someone who doesn't program (the builder's own explanation replaces it once it looked)
FRIENDLY: list[tuple[str, str]] = [
    (r'relation "?[\w.]+"? does not exist|no such table|ER_NO_SUCH_TABLE|Table \'[\w.]+\' doesn\'t exist',
     "La base de datos no tiene armadas las tablas donde la app guarda sus datos"),
    (r'column "?[\w.]+"? (of relation "?[\w.]+"? )?does not exist|no such column|Unknown column', "La base de datos está desactualizada: le falta un campo que la app usa"),
    (r"password authentication failed|DATABASE_URL|database .* does not exist", "La app no puede entrar a su base de datos"),
    (r"ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection refused|getaddrinfo", "La app no logra conectarse a otro servicio que necesita"),
    (r"heap out of memory|MemoryError|OOMKilled", "La app se queda sin memoria"),
    (r"Minified React error|Invalid hook call|Rendered (more|fewer) hooks", "Una pantalla de la app se rompe por cómo está armada por dentro (React)"),
    (r"Cannot read propert|undefined is not|is not a function|of undefined|of null|TypeError|AttributeError|KeyError",
     "Una parte de la app se rompe porque un dato no llega como esperaba"),
    (r"→ 5\d\d$", "Un pedido de la app a su servidor falla"),
]

ERROR_LINE = re.compile(r"\b(error|exception|traceback|unhandled|uncaught|fatal|panic|crash(ed)?|failed)\b|ECONN\w+|does not exist|cannot find|→ 5\d\d", re.I)
NOT_ERROR = re.compile(r"\b0 errors?\b|no errors|error[_ ]?(rate|count|handler registered)|errors?: ?0\b|npm (warn|notice)|deprecat", re.I)
LOG_NOISE = re.compile(r"complete log of this run|_logs/.*debug.*\.log|^\s*npm (error|ERR!)\s*$|^\s*npm (error|ERR!) (code|errno|syscall)\b|^\s*at |^\s*$", re.I)
STACK_LINE = re.compile(r"^\s+at |^\s+File \"|^Traceback|^\s{2,}\S|^\w*(Error|Exception):")
BROWSER_NOISE = re.compile(r"^Script error\.?$|ResizeObserver loop|chrome-extension://|moz-extension://|safari-extension://|Non-Error promise rejection|Load failed|Failed to fetch|NetworkError", re.I)

ON_ERRORS: Callable[[str, str], None] | None = None  # set by main: hand the app's open errors to the builder


def _norm(text: str) -> str:
    t = text.lower()
    t = re.sub(r"https?://\S+", "<url>", t)
    t = re.sub(r"\"[^\"]*\"|'[^']*'|`[^`]*`", "<v>", t)
    t = re.sub(r"(/[\w.@-]+)+", "<path>", t)
    t = re.sub(r"\b[0-9a-f]{8,}\b|\b[0-9a-f-]{36}\b|\d+", "#", t)
    return re.sub(r"\s+", " ", t).strip()[:220]


GROUPED = 5  # the first FRIENDLY kinds are one cause however many places show it (missing tables, no database, …): one incident


def fingerprint(text: str) -> str:
    kind = next((i for i, (rx, _) in enumerate(FRIENDLY[:GROUPED]) if re.search(rx, text, re.I)), None)
    return hashlib.sha1((f"kind:{kind}" if kind is not None else _norm(text)).encode()).hexdigest()[:12]


def friendly(text: str) -> str:
    for rx, label in FRIENDLY:
        if re.search(rx, text, re.I):
            return label
    first = re.sub(r"\s+", " ", text).strip()
    return first[:140] + ("…" if len(first) > 140 else "")


# ------------------------------------------------------------------------------------------------ records

def _row(r) -> dict:
    return dict(r) if r else {}


def record(user_id: str, build_id: str, source: str, text: str, sample: str, ts: float | None = None) -> dict:
    """One more occurrence. A fixed error that shows up again after the fix went live is open again."""
    ts = ts or time.time()
    fp = fingerprint(text)
    with _db() as c:
        cur = c.execute("SELECT * FROM app_errors WHERE user_id = ? AND build_id = ? AND fingerprint = ?", (user_id, build_id, fp)).fetchone()
        if not cur:
            row = {"id": uuid.uuid4().hex[:12], "user_id": user_id, "build_id": build_id, "fingerprint": fp, "source": source, "title": friendly(text),
                   "detail": text[:600], "sample": sample[-4000:], "first_ts": ts, "last_ts": ts}
            c.execute("INSERT INTO app_errors (id, user_id, build_id, fingerprint, source, title, detail, sample, first_ts, last_ts) "
                      "VALUES (:id, :user_id, :build_id, :fingerprint, :source, :title, :detail, :sample, :first_ts, :last_ts)", row)
            c.execute("INSERT INTO app_error_events (error_id, ts) VALUES (?, ?)", (row["id"], ts))  # its timeline (see observe.issues)
            return {**row, "status": "open", "count": 1, "attempts": 0}
        status = cur["status"]
        if status == "fixed" and ts > (cur["fixed_ts"] or 0) + 30:
            status = "open"  # the fix did not hold
        keep = cur["sample"] or ""
        if status == "open" and _norm(text) not in {_norm(ln) for ln in keep.splitlines()}:  # another face of the same cause: the builder sees them all
            keep = (keep + "\n---\n" + sample)[-4000:]
        c.execute("UPDATE app_errors SET count = count + 1, last_ts = MAX(last_ts, ?), sample = ?, status = ? WHERE id = ?", (ts, keep, status, cur["id"]))
        c.execute("INSERT INTO app_error_events (error_id, ts) VALUES (?, ?)", (cur["id"], ts))
        return {**dict(cur), "status": status}


def list_for(user_id: str, build_id: str) -> list[dict]:
    with _db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM app_errors WHERE user_id = ? AND build_id = ? ORDER BY last_ts DESC LIMIT 60", (user_id, build_id))]


def get(user_id: str, eid: str) -> dict:
    with _db() as c:
        return _row(c.execute("SELECT * FROM app_errors WHERE user_id = ? AND id = ?", (user_id, eid)).fetchone())


def with_status(user_id: str, build_id: str, *statuses: str) -> list[dict]:
    with _db() as c:
        q = f"SELECT * FROM app_errors WHERE user_id = ? AND build_id = ? AND status IN ({','.join('?' * len(statuses))}) ORDER BY count DESC"
        return [dict(r) for r in c.execute(q, (user_id, build_id, *statuses))]


def update(ids: list[str], **fields) -> None:
    if not ids or not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _db() as c:
        c.executemany(f"UPDATE app_errors SET {sets} WHERE id = ?", [(*fields.values(), i) for i in ids])


def bump_attempts(ids: list[str]) -> None:
    now = time.time()  # one pass = one fix_ts (fixes_today counts passes)
    with _db() as c:
        c.executemany("UPDATE app_errors SET attempts = attempts + 1, status = 'fixing', fix_ts = ? WHERE id = ?", [(now, i) for i in ids])


def fixes_today(user_id: str, build_id: str) -> int:
    with _db() as c:
        r = c.execute("SELECT COUNT(DISTINCT fix_ts) n FROM app_errors WHERE user_id = ? AND build_id = ? AND fix_ts > ?", (user_id, build_id, time.time() - 86400)).fetchone()
    return int(r["n"] or 0)


def on_live(user_id: str, build_id: str) -> None:
    """The app went live again: the fixes that were being published are fixed (they reopen if they show up again)."""
    with _db() as c:
        c.execute("UPDATE app_errors SET status = 'fixed', fixed_ts = ? WHERE user_id = ? AND build_id = ? AND status = 'deploying'", (time.time(), user_id, build_id))


def summary(rows: list[dict]) -> dict:
    return {"fixed": sum(1 for r in rows if r["status"] == "fixed"), "open": sum(1 for r in rows if r["status"] in ("open", "fixing", "deploying")),
            "needs_approval": sum(1 for r in rows if r["status"] == "needs_approval"), "stuck": sum(1 for r in rows if r["status"] == "stuck")}


def render_md(rows: list[dict]) -> str:
    """`.tably/errores.md`: the errors the published app is having, for the builder (and anyone reading the repo)."""
    out = ["# Errores de la app publicada", "",
           "Muse Team los detecta mientras la app está en línea (log del servidor y navegador de los usuarios) y los manda al constructor para arreglarlos.", ""]
    for r in rows:
        when = datetime.fromtimestamp(r["last_ts"]).strftime("%Y-%m-%d %H:%M")
        out += [f"## {r['title']}", "", f"- Origen: {'servidor' if r['source'] == 'server' else 'navegador'} · {r['count']} vez/veces · última: {when} · estado: {r['status']}",
                f"- Error: `{(r['detail'] or '')[:400]}`", "", "```", (r["sample"] or "")[-2500:], "```", ""]
    return "\n".join(out)


# ------------------------------------------------------------------------------------------------ server logs (Railway)

def _attrs(row: dict) -> dict:
    out = {}
    for a in row.get("attributes") or []:
        v = a.get("value")
        try:
            v = json.loads(v) if isinstance(v, str) else v
        except ValueError:
            pass
        out[a.get("key")] = v
    return out


def _line(row: dict) -> str:
    a = _attrs(row)
    extra = " ".join(f"{k}={v}" for k, v in a.items() if k not in ("level", "t", "time", "ts", "timestamp", "msg", "message") and v not in (None, ""))
    msg = (row.get("message") or a.get("msg") or a.get("message") or "").strip()
    return (msg + (" " if msg and extra else "") + extra).strip()


def _is_error(row: dict) -> bool:
    a = _attrs(row)
    text = _line(row)
    if not text or NOT_ERROR.search(text):
        return False
    if (row.get("severity") or "").lower() == "error" or str(a.get("level", "")).lower() in ("error", "fatal", "critical", "50", "60"):
        return True
    if any(k in a for k in ("error", "err", "stack", "exception")):
        return True
    return bool(ERROR_LINE.search(text)) and not STACK_LINE.match(row.get("message") or "")


def _epoch(iso: str) -> float:
    try:
        return datetime.fromisoformat(re.sub(r"(\.\d{6})\d*", r"\1", iso.replace("Z", "+00:00"))).timestamp()
    except ValueError:
        return time.time()


def errors_in(rows: list[dict]) -> list[tuple[str, str, float]]:
    """(error line, the line plus its stack/context, time) for each error row of a log page."""
    out, i = [], 0
    while i < len(rows):
        r = rows[i]
        i += 1
        if not _is_error(r):
            continue
        ctx = [_line(r)]
        while i < len(rows) and len(ctx) < 16 and STACK_LINE.match(rows[i].get("message") or ""):  # its stack trace
            ctx.append((rows[i].get("message") or "").rstrip())
            i += 1
        head = ctx[-1] if ctx[0].startswith("Traceback") and len(ctx) > 1 else ctx[0]  # Python: the error is the last line
        out.append((head, "\n".join(ctx), _epoch(r.get("timestamp") or "")))
    return out


def _cursor(user_id: str, build_id: str) -> tuple[str | None, str | None]:
    with _db() as c:
        r = c.execute("SELECT deployment, cursor FROM app_error_cursors WHERE user_id = ? AND build_id = ?", (user_id, build_id)).fetchone()
    return (r["deployment"], r["cursor"]) if r else (None, None)


def _set_cursor(user_id: str, build_id: str, dep: str, cur: str) -> None:
    with _db() as c:
        c.execute("INSERT INTO app_error_cursors (user_id, build_id, deployment, cursor) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, build_id) DO UPDATE SET deployment = excluded.deployment, cursor = excluded.cursor",
                  (user_id, build_id, dep, cur))


async def scan_railway(app: dict) -> int:
    """New error lines in the live deployment's log since the last read → incidents. Returns how many were recorded."""
    from . import cloud as cloudmod

    user_id, build_id = app["user_id"], app["build_id"]
    dep = ((app.get("db") or {}).get("railway") or {}).get("deployment")
    token = cloudmod._railway_token(user_id)
    if not dep or not token:
        return 0
    try:
        rows = (await cloudmod._rw_gql(token, "query($id:String!,$l:Int){deploymentLogs(deploymentId:$id,limit:$l){message severity timestamp attributes{key value}}}",
                                       {"id": dep, "l": 1000})).get("deploymentLogs") or []
    except (httpx.HTTPError, ValueError) as e:
        log.info("logs of %s: %s", build_id, e)
        return 0
    if not rows:
        return 0
    seen_dep, cursor = _cursor(user_id, build_id)
    if seen_dep != dep or not cursor:
        since = time.time() - FIRST_WINDOW
        rows = [r for r in rows if _epoch(r.get("timestamp") or "") >= since]
    else:
        rows = [r for r in rows if (r.get("timestamp") or "") > cursor]
    n = 0
    for text, sample, ts in errors_in(rows):
        record(user_id, build_id, "server", text, sample, ts)
        n += 1
    if rows:
        _set_cursor(user_id, build_id, dep, max(r.get("timestamp") or "" for r in rows))
    return n


async def tick() -> None:
    from . import cloud as cloudmod

    with _db() as c:  # a fix cut short (restart, crash) is not «fixing» forever
        c.execute("UPDATE app_errors SET status = 'open' WHERE status = 'fixing' AND fix_ts < ?", (time.time() - 7200,))
    with _db() as c:
        apps = [cloudmod._row_to_app(r) for r in c.execute("SELECT * FROM cloud_apps WHERE status IN ('live', 'error')")]
    for app in apps:
        if app["status"] == "error":  # a fix whose publish failed is not «being published» anymore: back to open
            with _db() as c:
                c.execute("UPDATE app_errors SET status = 'open' WHERE user_id = ? AND build_id = ? AND status = 'deploying'", (app["user_id"], app["build_id"]))
            continue
        if app["provider"] == "railway":
            await scan_railway(app)
        if ON_ERRORS and with_status(app["user_id"], app["build_id"], "open"):
            try:
                ON_ERRORS(app["user_id"], app["build_id"])
            except Exception:  # noqa: BLE001
                log.exception("fixing the errors of %s", app["build_id"])


def enabled() -> bool:
    """On by default on a public installation; off on a local one (its apps' fixes would run on the developer's machine).
    TABLY_APP_MONITOR=1/0 forces it."""
    from .cloud import public_url
    from .config import env

    flag = (env("TABLY_APP_MONITOR") or "").strip()
    return flag == "1" if flag else not re.search(r"//(localhost|127\.0\.0\.1)", public_url())


async def monitor() -> None:
    """Forever, in the background: read the live apps' logs and hand new errors to the builder."""
    if not enabled():
        log.info("app error monitor off (local installation; TABLY_APP_MONITOR=1 turns it on)")
        return
    await asyncio.sleep(20)
    while True:
        try:
            await tick()
        except Exception:  # noqa: BLE001
            log.exception("incidents tick")
        await asyncio.sleep(INTERVAL)


# ------------------------------------------------------------------------------------------------ browser reporter

_RATE: dict[str, deque] = {}


def reporter_js(endpoint: str) -> str:
    """Reports uncaught errors, rejected promises and API calls answered with 5xx (at most 20 per page view, no repeats).
    It also keeps the page's last failures in window.__tably.log (requests answered 4xx/5xx with their body, console.error),
    which «Enviar al constructor» reads from the «App real» pane."""
    return ("(function(){var U=" + json.dumps(endpoint) + ",n=0,seen={};"
            "var L=window.__tably=window.__tably||{log:[]};function keep(e){try{e.t=Date.now();L.log.push(e);if(L.log.length>40)L.log.shift()}catch(x){}}"
            "function path(u){return String(u||'').replace(location.origin,'')}"
            "function send(k,m,s){m=String(m||'');keep({kind:k,message:m.slice(0,500),stack:String(s||'').slice(0,1500)});if(!m||n>=20||seen[k+m])return;seen[k+m]=1;n++;"
            "try{var b=JSON.stringify({kind:k,message:m.slice(0,500),stack:String(s||'').slice(0,2000),page:location.pathname});"
            "if(navigator.sendBeacon)navigator.sendBeacon(U,new Blob([b],{type:'text/plain'}));else fetch(U,{method:'POST',body:b,keepalive:true,mode:'no-cors'})}catch(e){}}"
            "window.addEventListener('error',function(e){if(e.message)send('error',e.message,e.error&&e.error.stack)});"
            "window.addEventListener('unhandledrejection',function(e){var r=e.reason;send('promise',r&&r.message||r,r&&r.stack)});"
            "var ce=console.error;console.error=function(){try{keep({kind:'console',message:[].map.call(arguments,function(a){try{return a&&a.stack||(typeof a==='object'?JSON.stringify(a):String(a))}catch(x){return String(a)}}).join(' ').slice(0,800)})}catch(x){}return ce.apply(this,arguments)};"
            "var f=window.fetch;if(f)window.fetch=function(i,o){var m=(o&&o.method)||(i&&i.method)||'GET',u=typeof i==='string'?i:(i&&i.url)||String(i);"
            "return f.apply(this,arguments).then(function(r){try{if(r.status>=400){r.clone().text().then(function(t){keep({kind:'http',method:m,url:path(u),status:r.status,body:String(t).slice(0,800)})},function(){});"
            "if(r.status>=500)send('http',m+' '+path(u).split('?')[0]+' \\u2192 '+r.status)}}catch(e){}return r},function(e){keep({kind:'http',method:m,url:path(u),status:0,body:String(e&&e.message||e)});throw e})};"
            "var X=window.XMLHttpRequest;if(X){var op=X.prototype.open,sd=X.prototype.send;X.prototype.open=function(m,u){this.__t=[m,u];return op.apply(this,arguments)};"
            "X.prototype.send=function(){var x=this;x.addEventListener('loadend',function(){try{if(x.status>=400||x.status===0){var t='';try{t=x.responseType===''||x.responseType==='text'?x.responseText:''}catch(e){}"
            "keep({kind:'http',method:(x.__t||[])[0],url:path((x.__t||[])[1]),status:x.status,body:String(t).slice(0,800)})}}catch(e){}});return sd.apply(this,arguments)}}"
            "})();")


def report_browser(slug: str, body: dict) -> bool:
    """An error a visitor's browser reported. Returns whether it was kept."""
    from . import cloud as cloudmod

    q = _RATE.setdefault(slug, deque())
    now = time.time()
    while q and q[0] < now - 600:
        q.popleft()
    if len(q) >= 60:
        return False
    msg = str(body.get("message") or "")[:500].strip()
    stack = str(body.get("stack") or "")[:2000]
    if not msg or BROWSER_NOISE.search(msg) or BROWSER_NOISE.search(stack):
        return False
    with _db() as c:
        r = c.execute("SELECT * FROM cloud_apps WHERE slug = ? AND status = 'live'", (slug,)).fetchone()
    if not r:
        return False
    q.append(now)
    app = cloudmod._row_to_app(r)
    page = str(body.get("page") or "")[:200]
    record(app["user_id"], app["build_id"], "browser", msg, f"{msg}\n(página: {page})\n{stack}".strip())
    return True


def inject_reporter(root: Path, script_url: str) -> list[str]:
    """Add (or refresh) the reporter <script> in the app's HTML entry points. Returns the files touched."""
    tag = f'<script src="{script_url}" defer data-{MARK}></script>'
    touched = []
    skip = ("node_modules", "dist", "build", ".next", "out", "design", "research", ".tably", "coverage")
    for p in [root / "index.html", *root.glob("*/index.html"), *root.glob("*/*/index.html")][:8]:
        if any(part in skip for part in p.relative_to(root).parts[:-1]):
            continue
        try:
            html = p.read_text()
        except OSError:
            continue
        if "</head>" not in html or tag in html:
            continue
        new = re.sub(rf'[ \t]*<script[^>]*data-{MARK}[^>]*></script>\n?', "", html)  # an older one (another URL)
        new = new.replace("</head>", f"{tag}\n</head>", 1)
        if new != html:
            p.write_text(new)
            touched.append(str(p.relative_to(root)))
    return touched


def log_headline(lines: list[str]) -> str | None:
    """The line of a run's log that best says what went wrong (not npm's «see the debug log» footer)."""
    hits = [ln.strip() for ln in lines if ERROR_LINE.search(ln) and not NOT_ERROR.search(ln) and not LOG_NOISE.search(ln)]
    return hits[-1][:400] if hits else None
