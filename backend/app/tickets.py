"""Tickets from Notion, resolved by the team.

The user connects Notion (integration token), picks the database with their tickets and links it to a Muse Team project.
«Resolver ticket» turns the ticket's page into a change request for the builder (its Markdown is the spec), the council
verifies the result against the ticket, and when it approves the branch is pushed to GitHub and a pull request is opened;
the ticket moves To do → In progress → Code review in Notion with a comment that links the PR. The merge is always human.

Notion API: https://developers.notion.com (version 2022-06-28). Only urllib, no SDK.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .auth import _db

log = logging.getLogger("arena.tickets")

NOTION = os.environ.get("TABLY_NOTION_API", "https://api.notion.com/v1")  # overridable for tests
NOTION_VERSION = "2022-06-28"

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS notion_links (
            user_id TEXT PRIMARY KEY, database_id TEXT, database_title TEXT, props TEXT, status_map TEXT, session_id TEXT, build_id TEXT,
            repo_url TEXT, assignee TEXT, updated REAL NOT NULL)"""
    )
    _c.execute(
        """CREATE TABLE IF NOT EXISTS ticket_runs (
            user_id TEXT NOT NULL, page_id TEXT NOT NULL, title TEXT, session_id TEXT, build_id TEXT, status TEXT NOT NULL, base_commit TEXT,
            branch TEXT, pr_url TEXT, council_session TEXT, error TEXT, started REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY (user_id, page_id))"""
    )
    if "projects" not in {r[1] for r in _c.execute("PRAGMA table_info(notion_links)")}:
        _c.execute("ALTER TABLE notion_links ADD COLUMN projects TEXT")
    _c.execute(
        """CREATE TABLE IF NOT EXISTS ticket_projects (
            user_id TEXT NOT NULL, page_id TEXT NOT NULL, session_id TEXT, build_id TEXT, method TEXT NOT NULL, confidence REAL,
            evidence TEXT, updated REAL NOT NULL, PRIMARY KEY (user_id, page_id))"""
    )


class NotionError(Exception):
    pass


# ------------------------------------------------------------------------------------------------ OAuth (public integration)
# Operator env: NOTION_CLIENT_ID + NOTION_CLIENT_SECRET (a public integration at notion.so/my-integrations) and the redirect URL
# registered there: <TABLY_CLOUD_URL>/api/notion/callback. Without them the screen falls back to pasting an internal token.

with _db() as _c:
    _c.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value BLOB, updated REAL NOT NULL)")


def _setting(key: str) -> str | None:
    from . import keystore

    with _db() as c:
        r = c.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    if not r or not r["value"]:
        return None
    try:
        return keystore._fernet.decrypt(r["value"]).decode()
    except Exception:  # noqa: BLE001
        return None


def set_setting(key: str, value: str | None) -> None:
    from . import keystore

    with _db() as c:
        if value:
            c.execute("INSERT OR REPLACE INTO app_settings (key, value, updated) VALUES (?, ?, ?)", (key, keystore._fernet.encrypt(value.encode()), time.time()))
        else:
            c.execute("DELETE FROM app_settings WHERE key = ?", (key,))


def oauth_creds() -> tuple[str | None, str | None]:
    """The app's Notion OAuth client: what the admin saved from the UI, else the env."""
    return (_setting("notion_client_id") or os.environ.get("NOTION_CLIENT_ID") or None, _setting("notion_client_secret") or os.environ.get("NOTION_CLIENT_SECRET") or None)


def oauth_configured() -> bool:
    cid, sec = oauth_creds()
    return bool(cid and sec)


def oauth_url(redirect_uri: str, state: str) -> str:
    from urllib.parse import urlencode

    return "https://api.notion.com/v1/oauth/authorize?" + urlencode({"client_id": oauth_creds()[0] or "", "response_type": "code", "owner": "user", "redirect_uri": redirect_uri, "state": state})


def oauth_exchange(code: str, redirect_uri: str) -> dict:
    """code → {access_token, workspace_name, ...}."""
    import base64

    cid, sec = oauth_creds()
    req = urllib.request.Request("https://api.notion.com/v1/oauth/token", method="POST", data=json.dumps({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri}).encode(),
                                 headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{sec}".encode()).decode(), "Content-Type": "application/json", "Notion-Version": NOTION_VERSION})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read() or b"{}")
        except Exception:  # noqa: BLE001
            d = {}
        raise NotionError(d.get("error_description") or d.get("error") or f"Notion respondió {e.code}")


# ------------------------------------------------------------------------------------------------ client

def _call(token: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(NOTION + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json", "User-Agent": "tablyteam"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read() or b"{}")
        except Exception:  # noqa: BLE001
            d = {}
        msg = d.get("message") or f"Notion respondió {e.code}"
        if e.code == 401:
            msg = "El token de Notion no es válido."
        if e.code == 404:
            msg = "Notion no encuentra eso: compartí la base con la integración (menú ··· → Conexiones → tu integración)."
        raise NotionError(msg[:300])
    except urllib.error.URLError as e:
        raise NotionError(f"No pude hablar con Notion: {e.reason}")


def me(token: str) -> dict:
    u = _call(token, "GET", "/users/me")
    return {"id": u.get("id"), "name": u.get("name") or (u.get("bot") or {}).get("workspace_name") or "Notion", "workspace": (u.get("bot") or {}).get("workspace_name")}


def _rich(rts: list[dict]) -> str:
    out = []
    for t in rts or []:
        s = t.get("plain_text", "")
        a = t.get("annotations") or {}
        if a.get("code"):
            s = f"`{s}`"
        if a.get("bold"):
            s = f"**{s}**"
        if a.get("italic"):
            s = f"*{s}*"
        if a.get("strikethrough"):
            s = f"~~{s}~~"
        if t.get("href"):
            s = f"[{s}]({t['href']})"
        out.append(s)
    return "".join(out)


def databases(token: str) -> list[dict]:
    """Every database shared with the integration."""
    out, cursor = [], None
    for _ in range(5):
        body: dict[str, Any] = {"filter": {"property": "object", "value": "database"}, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        r = _call(token, "POST", "/search", body)
        for d in r.get("results", []):
            out.append({"id": d["id"], "title": _rich(d.get("title") or []) or "(sin título)", "url": d.get("url")})
        if not r.get("has_more"):
            break
        cursor = r.get("next_cursor")
    return out


_STATUS_RX = {
    "todo": re.compile(r"to ?do|pendiente|backlog|por hacer|not started|sin empezar|open|abierto", re.I),
    "in_progress": re.compile(r"progress|en curso|doing|haciendo|working|desarrollo|en proceso", re.I),
    "review": re.compile(r"review|revisi|qa|testing|prueba", re.I),
    "done": re.compile(r"done|hecho|listo|complet|cerrado|closed|resuelto", re.I),
}


def schema(token: str, database_id: str) -> dict:
    """The properties that matter (title, status, priority, assignee, due, PR url) guessed from the database, plus the status options."""
    d = _call(token, "GET", f"/databases/{database_id}")
    props = d.get("properties") or {}
    found: dict[str, str | None] = {"title": None, "status": None, "priority": None, "assignee": None, "due": None, "pr": None, "project": None}
    status_options: list[str] = []
    status_type = None
    project_props: list[dict] = []  # select/multi_select properties that can tell which repo/app a ticket belongs to
    best_rank = 99
    for name, p in props.items():
        t = p.get("type")
        low = name.lower()
        if t in ("select", "multi_select"):
            project_props.append({"name": name, "options": [o["name"] for o in (p.get(t) or {}).get("options", [])]})
            rank = next((i for i, rx in enumerate(_PROJECT_RANK) if rx.search(low)), None)
            if rank is not None and rank < best_rank:
                found["project"], best_rank = name, rank
        if t == "title":
            found["title"] = name
        elif t == "status" and not found["status"]:
            found["status"], status_type = name, "status"
            status_options = [o["name"] for o in (p.get("status") or {}).get("options", [])]
        elif t == "select" and re.search(r"status|estado", low) and not found["status"]:
            found["status"], status_type = name, "select"
            status_options = [o["name"] for o in (p.get("select") or {}).get("options", [])]
        elif t == "select" and re.search(r"priorit|priorid|urgen|severity|severidad", low):
            found["priority"] = name
        elif t == "people" and not found["assignee"]:
            found["assignee"] = name
        elif t == "date" and re.search(r"due|vence|deadline|fecha|limit", low) and not found["due"]:
            found["due"] = name
        elif t == "url" and re.search(r"\bpr\b|pull|github|branch|rama", low):
            found["pr"] = name
    if not found["due"]:
        found["due"] = next((n for n, p in props.items() if p.get("type") == "date"), None)
    status_map = {k: next((o for o in status_options if rx.search(o)), None) for k, rx in _STATUS_RX.items()}
    return {"title": _rich(d.get("title") or []), "props": found, "status_type": status_type, "status_options": status_options, "status_map": status_map, "url": d.get("url"),
            "project_props": project_props}


# the property most likely to say which repo/app a ticket belongs to, best guess first ("Feature" beats "Área")
_PROJECT_RANK = [re.compile(x, re.I) for x in (r"feature", r"repo", r"proyect|project", r"producto|product", r"m[oó]dulo|module", r"component", r"servicio|service", r"\bapp\b", r"sistema|system", r"area|área")]


def project_values(fields: dict, prop: str | None) -> list[str]:
    """The ticket's project value(s): a multi_select comes back as "A, B"."""
    if not prop or not fields.get(prop):
        return []
    return [v.strip() for v in str(fields[prop]).split(",") if v.strip()]


def project_for_ticket(link: dict, fields: dict, assigned: dict | None = None) -> dict:
    """Which Muse Team project resolves this ticket, in this order: a choice made by hand for the ticket, the project mapped to the
    ticket's Feature value, the project Muse Team detected from the ticket text (files and repo it names), and, with no project
    property at all, the single default project. A ticket with none of those cannot be resolved (so a Codifier ticket never
    lands on the Preprocessor)."""
    pr = link.get("projects") or {}
    prop = pr.get("prop")
    if assigned and assigned.get("method") == "manual" and assigned.get("build_id"):
        return {"ok": True, "key": None, "method": "manual", "session_id": assigned["session_id"], "build_id": assigned["build_id"], "repo_url": (project_by_build(link, assigned["build_id"]) or {}).get("repo_url")}
    vals = project_values(fields, prop) if prop else []
    for v in vals:
        m = (pr.get("map") or {}).get(v)
        if m and m.get("build_id") and m.get("session_id"):
            return {"ok": True, "key": v, "method": "feature", "session_id": m["session_id"], "build_id": m["build_id"], "repo_url": m.get("repo_url")}
    if assigned and assigned.get("build_id"):
        return {"ok": True, "key": None, "method": assigned.get("method") or "auto", "confidence": assigned.get("confidence"), "evidence": assigned.get("evidence"),
                "session_id": assigned["session_id"], "build_id": assigned["build_id"], "repo_url": (project_by_build(link, assigned["build_id"]) or {}).get("repo_url")}
    if not prop:
        if link.get("build_id") and link.get("session_id"):
            return {"ok": True, "key": None, "method": "default", "session_id": link["session_id"], "build_id": link["build_id"], "repo_url": link.get("repo_url")}
        return {"ok": False, "key": None, "reason": "sin_proyecto"}
    if not vals:
        return {"ok": False, "key": None, "reason": "ticket_sin_valor", "prop": prop}
    return {"ok": False, "key": vals[0], "reason": "valor_sin_proyecto", "prop": prop}


# ------------------------------------------------------------------------------------------------ which project a ticket belongs to

_PATH_RX = re.compile(r"(?<![\w/])((?:[\w.-]+/)+[\w.-]+\.[a-z0-9]{1,5}|[\w-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|kt|rb|php|yaml|yml|toml|sql|md|cs|swift|dart))\b")
_DIR_RX = re.compile(r"(?<![\w/.])([a-z][\w-]{2,})/(?=[\w.-])")
_GENERIC_FILES = {"readme.md", "package.json", "pyproject.toml", "index.ts", "index.js", "main.py", "app.py", "setup.py", "dockerfile", "makefile", ".env", "config.py", "utils.py", "types.ts", "index.tsx", "app.tsx", "main.ts", "main.tsx", "requirements.txt", "changelog.md"}
_GENERIC_DIRS = {"src", "app", "lib", "tests", "test", "docs", "scripts", "api", "utils", "components", "pages", "public", "static", "config", "bin", "build", "dist", "data"}


def project_index(user_dir, builds: list[dict]) -> list[dict]:
    """What each uploaded project is made of: title, repo name, file paths, top-level folders (from the saved build or its workdir)."""
    import json as _json
    from pathlib import Path

    out = []
    for b in builds:
        path = Path(user_dir) / f"{b['session_id']}.build.{b['build_id']}.json"
        try:
            d = _json.loads(path.read_text())
        except Exception:
            continue
        paths: set[str] = set(d.get("files") or {})
        wd = d.get("workdir")
        if wd and Path(wd).is_dir():
            skip = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"}
            root = Path(wd)
            n = 0
            for p in root.rglob("*"):
                if n > 20000:
                    break
                if any(part in skip for part in p.relative_to(root).parts):
                    continue
                if p.is_file():
                    paths.add(str(p.relative_to(root)).replace("\\", "/"))
                    n += 1
        title = (d.get("title") or b.get("title") or "").strip()
        names = {_slug(title)}
        repo = (b.get("repo_url") or "").rstrip("/").split("/")[-1].lower() if b.get("repo_url") else None
        if repo:
            names.add(repo)
        names |= {x for x in re.split(r"[\s·:·-]+", title.lower()) if len(x) > 3 and x not in ("auditoría", "audit", "proyecto", "project", "core", "test")}
        dirs = {p.split("/")[0].lower() for p in paths if "/" in p}
        base = {p.rsplit("/", 1)[-1].lower() for p in paths}
        out.append({"session_id": b["session_id"], "build_id": b["build_id"], "title": title, "names": {n for n in names if n}, "paths": {p.lower() for p in paths}, "dirs": dirs, "base": base,
                    "tree": sorted(dirs)[:30], "sample": sorted(p for p in paths if p.count("/") <= 1)[:40]})
    return out


def classify_ticket(text: str, index: list[dict]) -> dict:
    """Score every project against the paths, folders and repo names the ticket mentions. Decided when one project clearly wins."""
    low = text.lower()
    mentioned_paths = {m.lower().strip("/") for m in _PATH_RX.findall(text)}
    mentioned_dirs = {m.lower() for m in _DIR_RX.findall(text)}
    scores = []
    for pj in index:
        pts, ev = 0.0, []
        for n in pj["names"]:
            if len(n) >= 4 and re.search(r"(?<![\w-])" + re.escape(n) + r"(?![\w-])", low):
                pts += 4
                ev.append(f"«{n}»")
        for mp in mentioned_paths:
            b = mp.rsplit("/", 1)[-1]
            if mp in pj["paths"] or any(p.endswith("/" + mp) for p in pj["paths"]):
                pts += 3
                ev.append(mp)
            elif b not in _GENERIC_FILES and b in pj["base"]:
                others = sum(1 for o in index if o is not pj and b in o["base"])
                if not others:
                    pts += 2
                    ev.append(b)
        for dname in mentioned_dirs:
            if dname in pj["dirs"] and dname not in _GENERIC_DIRS and sum(1 for o in index if o is not pj and dname in o["dirs"]) == 0:
                pts += 1
                ev.append(dname + "/")
        scores.append((pts, pj, ev))
    scores.sort(key=lambda x: -x[0])
    if not scores or scores[0][0] < 3:
        return {"ok": False, "scores": [(round(s), pj["title"]) for s, pj, _ in scores]}
    best, second = scores[0], (scores[1] if len(scores) > 1 else None)
    if second and second[0] > 0 and best[0] < 2 * second[0]:
        return {"ok": False, "scores": [(round(s), pj["title"]) for s, pj, _ in scores]}
    conf = min(0.99, 0.6 + best[0] / 20)
    return {"ok": True, "session_id": best[1]["session_id"], "build_id": best[1]["build_id"], "title": best[1]["title"], "confidence": round(conf, 2), "evidence": ", ".join(dict.fromkeys(best[2]))[:300]}


def assigned_projects(user_id: str) -> dict[str, dict]:
    with _db() as c:
        return {r["page_id"]: dict(r) for r in c.execute("SELECT * FROM ticket_projects WHERE user_id = ?", (user_id,))}


def save_assignment(user_id: str, page_id: str, session_id: str | None, build_id: str | None, method: str, confidence: float | None = None, evidence: str | None = None) -> None:
    with _db() as c:
        if not build_id:
            c.execute("DELETE FROM ticket_projects WHERE user_id = ? AND page_id = ?", (user_id, page_id))
        else:
            c.execute("INSERT OR REPLACE INTO ticket_projects (user_id, page_id, session_id, build_id, method, confidence, evidence, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                      (user_id, page_id, session_id, build_id, method, confidence, evidence, time.time()))


def project_by_build(link: dict, build_id: str) -> dict | None:
    """The mapping entry (default or per value) that points at this build: where its repo_url lives."""
    pr = link.get("projects") or {}
    for key, m in (pr.get("map") or {}).items():
        if m.get("build_id") == build_id:
            return {"key": key, **m}
    if link.get("build_id") == build_id:
        return {"key": None, "session_id": link.get("session_id"), "build_id": build_id, "repo_url": link.get("repo_url")}
    return None


def set_repo_url(user_id: str, build_id: str, repo_url: str | None) -> None:
    link = get_link(user_id) or {}
    pr = dict(link.get("projects") or {})
    mp = dict(pr.get("map") or {})
    hit = False
    for key, m in mp.items():
        if m.get("build_id") == build_id:
            mp[key] = {**m, "repo_url": repo_url}
            hit = True
    if hit:
        save_link(user_id, projects={**pr, "map": mp})
    if link.get("build_id") == build_id:
        save_link(user_id, repo_url=repo_url)


_PRIO = [
    ("urgent", re.compile(r"urgent|urgente|p0|crit|highest|bloque|blocker|🔥|⚠", re.I)),
    ("high", re.compile(r"high|alta|alto|p1|important", re.I)),
    ("medium", re.compile(r"medium|media|medio|normal|p2", re.I)),
    ("low", re.compile(r"low|baja|bajo|p3|minor|menor|someday", re.I)),
]


def bucket(priority: str | None, due: str | None) -> str:
    if due:
        try:
            if time.mktime(time.strptime(due[:10], "%Y-%m-%d")) < time.time() - 86400:
                return "urgent"  # overdue beats whatever the label says
        except ValueError:
            pass
    for b, rx in _PRIO:
        if priority and rx.search(priority):
            return b
    return "none"


def _prop_text(p: dict) -> str | None:
    t = p.get("type")
    if t == "title":
        return _rich(p.get("title") or [])
    if t == "rich_text":
        return _rich(p.get("rich_text") or [])
    if t == "select":
        return (p.get("select") or {}).get("name")
    if t == "status":
        return (p.get("status") or {}).get("name")
    if t == "multi_select":
        return ", ".join(o["name"] for o in p.get("multi_select") or [])
    if t == "people":
        return ", ".join(u.get("name") or "?" for u in p.get("people") or [])
    if t == "date":
        return (p.get("date") or {}).get("start")
    if t == "url":
        return p.get("url")
    if t == "number":
        return str(p.get("number")) if p.get("number") is not None else None
    if t == "checkbox":
        return "✓" if p.get("checkbox") else None
    if t == "unique_id":
        u = p.get("unique_id") or {}
        return f"{u.get('prefix') + '-' if u.get('prefix') else ''}{u.get('number')}" if u.get("number") is not None else None
    if t == "formula":
        f = p.get("formula") or {}
        v = f.get(f.get("type") or "")
        return (str(v) if not isinstance(v, dict) else v.get("start")) if v not in (None, "") else None
    if t == "created_time":
        return (p.get("created_time") or "")[:10] or None
    if t == "last_edited_time":
        return (p.get("last_edited_time") or "")[:10] or None
    return None


GROUPABLE = ("select", "status", "multi_select", "people", "date", "checkbox")


def groupable_props(token: str, database_id: str) -> list[dict]:
    """The properties the screen can group by: name, type and (for selects) the options in Notion's order with their colour."""
    d = _call(token, "GET", f"/databases/{database_id}")
    out = []
    for name, p in (d.get("properties") or {}).items():
        t = p.get("type")
        if t not in GROUPABLE:
            continue
        opts = []
        if t in ("select", "multi_select"):
            opts = [{"name": o["name"], "color": o.get("color")} for o in (p.get(t) or {}).get("options", [])]
        elif t == "status":
            groups = (p.get("status") or {}).get("groups", [])
            order = [oid for g in groups for oid in g.get("option_ids", [])]
            by_id = {o.get("id") or o["name"]: o for o in (p.get("status") or {}).get("options", [])}
            opts = [{"name": by_id[i]["name"], "color": by_id[i].get("color")} for i in order if i in by_id] or [{"name": o["name"], "color": o.get("color")} for o in by_id.values()]
        out.append({"name": name, "type": t, "options": opts})
    return out


def tickets(token: str, database_id: str, props: dict) -> list[dict]:
    """Every open ticket of the database (done ones are left out), newest edits first, with the fields the screen needs."""
    out, cursor = [], None
    for _ in range(5):
        body: dict[str, Any] = {"page_size": 100, "sorts": [{"timestamp": "last_edited_time", "direction": "descending"}]}
        if cursor:
            body["start_cursor"] = cursor
        r = _call(token, "POST", f"/databases/{database_id}/query", body)
        for pg in r.get("results", []):
            pp = pg.get("properties") or {}
            get = lambda key: _prop_text(pp.get(props.get(key) or "", {})) if props.get(key) else None  # noqa: E731
            title = get("title") or next((_prop_text(v) for v in pp.values() if v.get("type") == "title"), None) or "(sin título)"
            status, prio, due = get("status"), get("priority"), get("due")
            fields = {n: _prop_text(v) for n, v in pp.items() if v.get("type") != "title" and _prop_text(v)}
            extra = {n: v for n, v in fields.items() if n not in props.values() and pp[n].get("type") in ("select", "multi_select", "rich_text", "number", "checkbox", "unique_id", "formula")}
            out.append({"id": pg["id"], "title": title, "status": status, "priority": prio, "assignee": get("assignee"), "due": due, "pr": get("pr"), "url": pg.get("url"),
                        "bucket": bucket(prio, due), "created": pg.get("created_time"), "edited": pg.get("last_edited_time"), "extra": dict(list(extra.items())[:4]), "fields": fields,
                        "project_value": ", ".join(project_values(fields, props.get("project"))) or None})
        if not r.get("has_more"):
            break
        cursor = r.get("next_cursor")
    return out


def _blocks(token: str, block_id: str, depth: int = 0) -> str:
    """Children of a block → Markdown (recursive, three levels)."""
    md: list[str] = []
    cursor = None
    num = 0
    for _ in range(10):
        r = _call(token, "GET", f"/blocks/{block_id}/children?page_size=100" + (f"&start_cursor={cursor}" if cursor else ""))
        for b in r.get("results", []):
            t = b.get("type")
            d = b.get(t) or {}
            text = _rich(d.get("rich_text") or [])
            ind = "  " * depth
            if t == "paragraph":
                md.append(f"{ind}{text}" if text else "")
            elif t in ("heading_1", "heading_2", "heading_3"):
                md.append(f"{'#' * int(t[-1])} {text}")
            elif t == "bulleted_list_item":
                md.append(f"{ind}- {text}")
            elif t == "numbered_list_item":
                num += 1
                md.append(f"{ind}{num}. {text}")
            elif t == "to_do":
                md.append(f"{ind}- [{'x' if d.get('checked') else ' '}] {text}")
            elif t == "toggle":
                md.append(f"{ind}- {text}")
            elif t == "quote":
                md.append(f"> {text}")
            elif t == "callout":
                md.append(f"> {(d.get('icon') or {}).get('emoji', '')} {text}".strip())
            elif t == "code":
                md.append(f"```{d.get('language') or ''}\n{text}\n```")
            elif t == "divider":
                md.append("---")
            elif t == "image":
                src = (d.get("file") or d.get("external") or {}).get("url")
                md.append(f"![{_rich(d.get('caption') or []) or 'imagen'}]({src})" if src else "")
            elif t == "bookmark":
                md.append(f"<{d.get('url')}>")
            elif t == "table":
                md.append(_table(token, b["id"]))
                continue
            elif t == "child_page":
                md.append(f"📄 {d.get('title')}")
            elif text:
                md.append(f"{ind}{text}")
            if t != "numbered_list_item":
                num = 0
            if b.get("has_children") and depth < 3 and t not in ("table", "child_page", "child_database"):
                md.append(_blocks(token, b["id"], depth + 1))
        if not r.get("has_more"):
            break
        cursor = r.get("next_cursor")
    return "\n".join(x for x in md if x is not None)


def _table(token: str, table_id: str) -> str:
    r = _call(token, "GET", f"/blocks/{table_id}/children?page_size=100")
    rows = [[_rich(c) for c in (row.get("table_row") or {}).get("cells", [])] for row in r.get("results", []) if row.get("type") == "table_row"]
    if not rows:
        return ""
    head = "| " + " | ".join(rows[0]) + " |"
    sep = "| " + " | ".join("---" for _ in rows[0]) + " |"
    body = "\n".join("| " + " | ".join(c) + " |" for c in rows[1:])
    return "\n".join([head, sep, body])


def page_markdown(token: str, page_id: str) -> dict:
    pg = _call(token, "GET", f"/pages/{page_id}")
    pp = pg.get("properties") or {}
    title = next((_prop_text(v) for v in pp.values() if v.get("type") == "title"), None) or "(sin título)"
    fields = {n: _prop_text(v) for n, v in pp.items() if v.get("type") != "title" and _prop_text(v)}
    body = _blocks(token, page_id)
    return {"id": page_id, "title": title, "url": pg.get("url"), "fields": fields, "markdown": body}


def set_status(token: str, page_id: str, prop: str, status_type: str | None, value: str | None) -> None:
    if not prop or not value:
        return
    kind = status_type or "status"
    _call(token, "PATCH", f"/pages/{page_id}", {"properties": {prop: {kind: {"name": value}}}})


def set_url(token: str, page_id: str, prop: str | None, url: str) -> None:
    if prop:
        _call(token, "PATCH", f"/pages/{page_id}", {"properties": {prop: {"url": url}}})


def comment(token: str, page_id: str, text: str) -> None:
    _call(token, "POST", "/comments", {"parent": {"page_id": page_id}, "rich_text": [{"text": {"content": text[:1900]}}]})


# ------------------------------------------------------------------------------------------------ link + runs (sqlite)

def get_link(user_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM notion_links WHERE user_id = ?", (user_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["props"] = json.loads(d.get("props") or "{}")
    d["status_map"] = json.loads(d.get("status_map") or "{}")
    d["projects"] = json.loads(d.get("projects") or "{}")
    return d


def save_link(user_id: str, **fields) -> dict:
    cur = get_link(user_id) or {"user_id": user_id, "database_id": None, "database_title": None, "props": {}, "status_map": {}, "session_id": None, "build_id": None, "repo_url": None, "assignee": None, "projects": {}}
    cur.update({k: v for k, v in fields.items() if k in cur or k in ("status_type",)})
    with _db() as c:
        c.execute(
            """INSERT OR REPLACE INTO notion_links (user_id, database_id, database_title, props, status_map, session_id, build_id, repo_url, assignee, projects, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (user_id, cur.get("database_id"), cur.get("database_title"), json.dumps(cur.get("props") or {}), json.dumps(cur.get("status_map") or {}),
             cur.get("session_id"), cur.get("build_id"), cur.get("repo_url"), cur.get("assignee"), json.dumps(cur.get("projects") or {}), time.time()),
        )
    return get_link(user_id) or cur


def runs(user_id: str) -> dict[str, dict]:
    with _db() as c:
        return {r["page_id"]: dict(r) for r in c.execute("SELECT * FROM ticket_runs WHERE user_id = ?", (user_id,))}


def run_for_build(user_id: str, build_id: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM ticket_runs WHERE user_id = ? AND build_id = ? AND status IN ('building', 'reviewing', 'changes') ORDER BY updated DESC", (user_id, build_id)).fetchone()
    return dict(r) if r else None


def save_run(user_id: str, page_id: str, **fields) -> dict:
    cur = runs(user_id).get(page_id) or {"user_id": user_id, "page_id": page_id, "title": None, "session_id": None, "build_id": None, "status": "queued", "base_commit": None,
                                          "branch": None, "pr_url": None, "council_session": None, "error": None, "started": time.time()}
    cur.update(fields)
    cur["updated"] = time.time()
    with _db() as c:
        c.execute(
            """INSERT OR REPLACE INTO ticket_runs (user_id, page_id, title, session_id, build_id, status, base_commit, branch, pr_url, council_session, error, started, updated)
               VALUES (:user_id, :page_id, :title, :session_id, :build_id, :status, :base_commit, :branch, :pr_url, :council_session, :error, :started, :updated)""",
            cur,
        )
    return cur


# ------------------------------------------------------------------------------------------------ git: branch + pull request

def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:40] or "ticket"


def open_pull_request(root: Path, token: str, repo_url: str, branch: str, title: str, body: str) -> dict:
    """Commit the working folder, push it as `branch` to the GitHub repo and open a PR against main. Returns {ok, url, error}."""
    from . import gitserver as gs

    m = re.match(r"https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", repo_url or "")
    if not m:
        return {"ok": False, "url": None, "error": "El proyecto no tiene un repositorio de GitHub vinculado."}
    owner, name = m.group(1), m.group(2)
    if not (root / ".git").exists():
        gs._run(["init", "-q", "-b", "main"], cwd=root)
    gs._run(["add", "-A"], cwd=root)
    gs._run(["commit", "-q", "-m", title[:120], "--allow-empty"], cwd=root)
    head = gs._run(["rev-parse", "HEAD"], cwd=root).stdout.decode().strip()
    gs._run(["branch", "-f", branch, head], cwd=root)
    remote = f"https://x-access-token:{token}@github.com/{owner}/{name}.git"
    push = gs._run(["push", "--force", remote, f"{branch}:refs/heads/{branch}"], cwd=root, timeout=600)
    if push.returncode != 0:
        return {"ok": False, "url": None, "error": "El push de la rama falló: " + push.stderr.decode(errors="replace").replace(token, "***")[-300:]}
    code, repo = gs._gh("GET", f"https://api.github.com/repos/{owner}/{name}", token)
    base = (repo.get("default_branch") if code == 200 else None) or "main"
    code, prs = gs._gh("GET", f"https://api.github.com/repos/{owner}/{name}/pulls?head={owner}:{branch}&state=open", token)
    if code == 200 and isinstance(prs, list) and prs:
        return {"ok": True, "url": prs[0].get("html_url"), "error": None, "existing": True}
    code, pr = gs._gh("POST", f"https://api.github.com/repos/{owner}/{name}/pulls", token, {"title": title[:200], "head": branch, "base": base, "body": body[:60000]})
    if code not in (200, 201):
        return {"ok": False, "url": None, "error": f"GitHub no dejó abrir el PR: {pr.get('message') or code} " + "; ".join(e.get("message", "") for e in pr.get("errors", []) if isinstance(e, dict))}
    return {"ok": True, "url": pr.get("html_url"), "error": None}
