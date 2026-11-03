"""Muse Team Git: one bare repository per build, served over HTTP with the account token, movable to GitHub.

The build's working folder already gets a commit + tag per version (versions.git_commit). This module keeps a bare
mirror of it under data/git/<user>/<build>.git so the user can clone it from any machine:

    git clone http://<token>@<host>/git/<user>/<build>.git

and, when they want to leave, pushes the whole history to a GitHub repository created with their own token.
Serving uses `git http-backend` (the stock smart-HTTP CGI) so clone/fetch/push behave exactly like any git host.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import DATA_DIR, env
from .local_engine import workdir as build_workdir
from . import versions as vers

log = logging.getLogger("arena.git")

GIT_ROOT = Path(env("ARENA_GIT_DIR", str(DATA_DIR.parent / "git")))
GIT_ROOT.mkdir(parents=True, exist_ok=True)
GIT = shutil.which("git")
ENV = {"GIT_AUTHOR_NAME": "Muse Team", "GIT_AUTHOR_EMAIL": "team@tablyteam.com", "GIT_COMMITTER_NAME": "Muse Team", "GIT_COMMITTER_EMAIL": "team@tablyteam.com",
       "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "HOME": os.environ.get("HOME", "/tmp")}


def _run(args: list[str], cwd: Path | None = None, timeout: int = 120, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([GIT, *args], cwd=str(cwd) if cwd else None, capture_output=True, timeout=timeout, env=ENV, input=stdin)


def repo_path(user_id: str, build_id: str) -> Path:
    return GIT_ROOT / user_id / f"{build_id}.git"


def ensure_repo(user_id: str, build_id: str) -> Path:
    p = repo_path(user_id, build_id)
    if not (p / "HEAD").exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        _run(["init", "-q", "--bare", "-b", "main", str(p)])
        _run(["config", "http.receivepack", "true"], cwd=p)  # pushes over HTTP are allowed (the token is the auth)
        _run(["config", "http.uploadpack", "true"], cwd=p)
    return p


def sync(user_id: str, build_id: str, root: Path | None, message: str = "sync") -> dict:
    """Commit whatever changed in the working folder (if anything) and mirror branches + tags into the bare repo."""
    if not GIT:
        return {"ok": False, "error": "git no está instalado en el servidor"}
    root = root or build_workdir(user_id, build_id)
    if not root or not root.exists():
        return {"ok": False, "error": "La construcción no tiene carpeta de trabajo"}
    bare = ensure_repo(user_id, build_id)
    try:
        if not (root / ".git").exists():
            _run(["init", "-q", "-b", "main"], cwd=root)
            gi = root / ".gitignore"
            if not gi.exists():
                gi.write_text(vers.GITIGNORE)
        _run(["add", "-A"], cwd=root)
        st = _run(["status", "--porcelain"], cwd=root).stdout.decode()
        committed = False
        if st.strip() or not _run(["rev-parse", "HEAD"], cwd=root).returncode == 0:
            _run(["commit", "-q", "-m", message, "--allow-empty"], cwd=root)
            committed = True
        # the working folder may be on master (older builds): mirror whatever HEAD is as main
        push = _run(["push", "-q", "--force", str(bare), "HEAD:refs/heads/main"], cwd=root)
        if push.returncode != 0:
            return {"ok": False, "error": push.stderr.decode()[-300:]}
        _run(["push", "-q", "--force", "--tags", str(bare)], cwd=root)
        _run(["symbolic-ref", "HEAD", "refs/heads/main"], cwd=bare)
        head = _run(["rev-parse", "--short", "HEAD"], cwd=root).stdout.decode().strip()
        return {"ok": True, "committed": committed, "head": head}
    except Exception as e:  # noqa: BLE001
        log.warning("git sync failed: %s", e)
        return {"ok": False, "error": str(e)[:300]}


def info(user_id: str, build_id: str, base_url: str, limit: int = 30) -> dict:
    """What the panel shows: clone URL, commits, tags, size."""
    bare = repo_path(user_id, build_id)
    out = {"exists": (bare / "HEAD").exists(), "clone_url": f"{base_url.rstrip('/')}/git/{user_id}/{build_id}.git", "commits": [], "tags": [], "head": None}
    if not out["exists"] or not GIT:
        return out
    lg = _run(["log", f"--max-count={limit}", "--format=%h%x1f%at%x1f%s%x1f%D", "main"], cwd=bare)
    for line in lg.stdout.decode(errors="replace").splitlines():
        parts = line.split("\x1f")
        if len(parts) >= 3:
            out["commits"].append({"hash": parts[0], "ts": int(parts[1] or 0), "message": parts[2][:200], "refs": [r.strip() for r in (parts[3] if len(parts) > 3 else "").split(",") if r.strip()]})
    out["tags"] = _run(["tag", "--sort=-v:refname"], cwd=bare).stdout.decode().split()
    out["head"] = out["commits"][0]["hash"] if out["commits"] else None
    return out


# ------------------------------------------------------------------------------------------------ smart HTTP (CGI)

def http_backend(user_id: str, repo: str, path: str, method: str, query: str, content_type: str | None, body: bytes) -> tuple[int, list[tuple[str, str]], bytes]:
    """Run `git http-backend` for one request; returns (status, headers, body)."""
    if not GIT:
        return 503, [("content-type", "text/plain")], b"git not installed"
    root = GIT_ROOT / user_id
    if not re.fullmatch(r"[\w.-]+\.git", repo) or not (root / repo / "HEAD").exists():
        return 404, [("content-type", "text/plain")], b"repository not found"
    cgi_env = {
        **ENV,
        "GIT_PROJECT_ROOT": str(root),
        "GIT_HTTP_EXPORT_ALL": "1",
        "PATH_INFO": f"/{repo}/{path}",
        "REQUEST_METHOD": method,
        "QUERY_STRING": query or "",
        "CONTENT_TYPE": content_type or "",
        "CONTENT_LENGTH": str(len(body)),
        "REMOTE_USER": user_id,
        "REMOTE_ADDR": "127.0.0.1",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "GATEWAY_INTERFACE": "CGI/1.1",
    }
    try:
        r = subprocess.run([GIT, "http-backend"], input=body, capture_output=True, env=cgi_env, timeout=600)
    except subprocess.TimeoutExpired:
        return 504, [("content-type", "text/plain")], b"git timeout"
    raw = r.stdout
    sep = raw.find(b"\r\n\r\n")
    nl = 4
    if sep < 0:
        sep = raw.find(b"\n\n")
        nl = 2
    if sep < 0:
        return 500, [("content-type", "text/plain")], r.stderr[-500:] or b"git http-backend failed"
    head, payload = raw[:sep].decode(errors="replace"), raw[sep + nl:]
    status = 200
    headers: list[tuple[str, str]] = []
    for line in head.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        if k.strip().lower() == "status":
            try:
                status = int(v.strip().split()[0])
            except ValueError:
                pass
        else:
            headers.append((k.strip().lower(), v.strip()))
    return status, headers, payload


def parse_basic_auth(header: str | None) -> str | None:
    """The token travels as the Basic password (any username) or as the username alone."""
    if not header or not header.lower().startswith("basic "):
        return None
    try:
        user, _, pw = base64.b64decode(header[6:]).decode().partition(":")
    except Exception:  # noqa: BLE001
        return None
    return pw or user or None


# ------------------------------------------------------------------------------------------------ GitHub

def _gh(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "tablyteam", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:  # noqa: BLE001
            return e.code, {}


def push_github(user_id: str, build_id: str, token: str, name: str, private: bool = True, root: Path | None = None) -> dict:
    """Create <login>/<name> (if it does not exist) and push the whole history there. Returns {ok, url, error}."""
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")[:100] or f"tablyteam-{build_id}"
    code, me = _gh("GET", "https://api.github.com/user", token)
    if code != 200 or not me.get("login"):
        return {"ok": False, "url": None, "error": "El token de GitHub no es válido (necesita el permiso «repo»)."}
    login = me["login"]
    code, repo = _gh("GET", f"https://api.github.com/repos/{login}/{name}", token)
    if code == 404:
        code, repo = _gh("POST", "https://api.github.com/user/repos", token, {"name": name, "private": private, "description": "Construido con Muse Team", "auto_init": False})
        if code not in (200, 201):
            return {"ok": False, "url": None, "error": f"GitHub no dejó crear el repo: {repo.get('message') or code}"}
    elif code != 200:
        return {"ok": False, "url": None, "error": f"GitHub respondió {code}: {repo.get('message') or ''}"}
    s = sync(user_id, build_id, root, "sync antes de mover a GitHub")
    if not s.get("ok"):
        return {"ok": False, "url": None, "error": s.get("error")}
    bare = repo_path(user_id, build_id)
    remote = f"https://x-access-token:{token}@github.com/{login}/{name}.git"
    push = _run(["push", "--force", "--all", remote], cwd=bare, timeout=600)
    if push.returncode != 0:
        err = push.stderr.decode(errors="replace").replace(token, "***")[-400:]
        return {"ok": False, "url": None, "error": f"El push falló: {err}"}
    _run(["push", "--force", "--tags", remote], cwd=bare, timeout=300)
    return {"ok": True, "url": repo.get("html_url") or f"https://github.com/{login}/{name}", "error": None, "ts": time.time()}
