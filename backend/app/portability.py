"""Move a whole account between Muse Team installations (e.g. a local install → tablyteam.com), as one encrypted file.

Export: the user's session files (debates, briefs, builds, versions), the project folders (without node_modules and other
re-installable caches; with their git history), the user's git repos, and every database row of the user (team, memory,
knowledge, published apps, analytics of those apps, keys and build secrets — decrypted, since each installation encrypts
with its own key). The zip is encrypted with a random code shown once to the user (PBKDF2 → Fernet).

Import: into the account that is logged in. Folder paths inside the files are rewritten to this installation, keys and
secrets are encrypted again with its key, and nothing that already exists is overwritten (importing twice is harmless).
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import secrets
import time
import zipfile
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from . import analytics as _analytics  # noqa: F401  (creates analytics_people before an import)
from .auth import _db
from .config import DATA_DIR
from .gitserver import GIT_ROOT
from .keystore import _fernet
from .local_engine import BUILD_ROOT

FORMAT = 1
SKIP_TABLES = {"users", "tokens", "team_backfill", "trial_usage"}
SKIP_DIRS = {"node_modules", ".next", ".turbo", ".cache", "coverage", ".data", "test-results", "playwright-report", "__pycache__", ".venv"}
ENC_COLS = {"enc_key", "enc"}  # encrypted with the installation's key: travel decrypted inside the encrypted bundle
MAX_BUNDLE = 400 * 1024 * 1024


def _key(code: str, salt: bytes) -> Fernet:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=390_000)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(code.strip().upper().replace("-", "").encode())))


def new_code() -> str:
    raw = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(16))
    return "-".join(raw[i:i + 4] for i in range(0, 16, 4))


def _user_tables(c) -> list[tuple[str, list[str], bool]]:
    out = []
    for name, sql in c.execute("SELECT name, sql FROM sqlite_master WHERE type='table'").fetchall():
        if name in SKIP_TABLES or re.search(r"_(data|idx|content|docsize|config)$", name):
            continue
        cols = [r[1] for r in c.execute(f"PRAGMA table_info({name})")]
        if "user_id" in cols:
            out.append((name, cols, "VIRTUAL" in (sql or "").upper()))
    return out


def _encode(v):
    if isinstance(v, (bytes, memoryview)):
        return {"__b64__": base64.b64encode(bytes(v)).decode()}
    return v


def _decode(v):
    if isinstance(v, dict) and "__b64__" in v:
        return base64.b64decode(v["__b64__"])
    return v


def _add_tree(z: zipfile.ZipFile, src: Path, prefix: str) -> int:
    n = 0
    if not src.exists():
        return 0
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            p = Path(dirpath) / f
            if p.is_symlink() or not p.is_file():
                continue
            z.write(p, f"{prefix}/{p.relative_to(src).as_posix()}")
            n += 1
    return n


def export_bundle(user_id: str, code: str) -> tuple[bytes, dict]:
    buf = io.BytesIO()
    summary: dict = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        summary["session_files"] = _add_tree(z, DATA_DIR / user_id, "sessions")
        summary["project_files"] = _add_tree(z, BUILD_ROOT / user_id, "builds")
        summary["git_files"] = _add_tree(z, GIT_ROOT / user_id, "git")
        rows: dict[str, list[dict]] = {}
        with _db() as c:
            for name, cols, _virtual in _user_tables(c):
                out = []
                for r in c.execute(f"SELECT * FROM {name} WHERE user_id = ?", (user_id,)).fetchall():
                    d = dict(r)
                    for col in ENC_COLS & set(cols):
                        if d.get(col):
                            try:
                                d[col] = {"__plain__": _fernet.decrypt(bytes(d[col])).decode()}
                            except (InvalidToken, TypeError):
                                d[col] = None
                    out.append({k: _encode(v) for k, v in d.items()})
                if out:
                    rows[name] = out
            slugs = [a["slug"] for a in rows.get("cloud_apps", []) if a.get("slug")]
            hits = []
            for s in slugs:
                hits += [{k: _encode(v) for k, v in dict(r).items()} for r in c.execute("SELECT * FROM analytics_hits WHERE site = ?", (s,)).fetchall()]
            if hits:
                rows["analytics_hits"] = hits
            people = []
            for s_ in slugs:
                people += [{k: _encode(v) for k, v in dict(r).items()} for r in c.execute("SELECT * FROM analytics_people WHERE site = ?", (s_,)).fetchall()]
            if people:
                rows["analytics_people"] = people
        faces = DATA_DIR.parent / "faces"  # the faces generated for this user's employees
        for e in rows.get("employees", []):
            m = re.search(r"/api/faces/([a-f0-9]{24}\.webp)", json.dumps(e.get("avatar") or ""))
            if m and (faces / m.group(1)).exists():
                z.write(faces / m.group(1), f"faces/{m.group(1)}")
        summary["rows"] = {k: len(v) for k, v in rows.items()}
        manifest = {"format": FORMAT, "user_id": user_id, "exported": time.time(),
                    "roots": {"sessions": str(DATA_DIR / user_id), "builds": str(BUILD_ROOT / user_id), "git": str(GIT_ROOT / user_id)}}
        z.writestr("manifest.json", json.dumps(manifest))
        z.writestr("db.json", json.dumps(rows))
    salt = secrets.token_bytes(16)
    return b"TABLY1" + salt + _key(code, salt).encrypt(buf.getvalue()), summary


def _rewrite(text: str, roots: dict[str, str], new: dict[str, str]) -> str:
    for k in ("builds", "sessions", "git"):
        if roots.get(k):
            text = text.replace(roots[k], new[k])
    return text


def import_bundle(user_id: str, blob: bytes, code: str) -> dict:
    if len(blob) > MAX_BUNDLE or not blob.startswith(b"TABLY1"):
        raise ValueError("Ese archivo no es una exportación de Muse Team")
    salt, token = blob[6:22], blob[22:]
    try:
        raw = _key(code, salt).decrypt(token)
    except InvalidToken:
        raise ValueError("El código no corresponde a este archivo") from None
    new = {"sessions": str(DATA_DIR / user_id), "builds": str(BUILD_ROOT / user_id), "git": str(GIT_ROOT / user_id)}
    summary: dict = {"files": 0, "skipped_files": 0, "rows": {}}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        manifest = json.loads(z.read("manifest.json"))
        if manifest.get("format") != FORMAT:
            raise ValueError("La exportación es de una versión de Muse Team que esta instalación no entiende")
        roots = manifest["roots"]
        for info in z.infolist():
            name = info.filename
            top, _, rel = name.partition("/")
            if top == "faces" and re.fullmatch(r"[a-f0-9]{24}\.webp", rel):
                (DATA_DIR.parent / "faces").mkdir(parents=True, exist_ok=True)
                if not (DATA_DIR.parent / "faces" / rel).exists():
                    (DATA_DIR.parent / "faces" / rel).write_bytes(z.read(info))
                continue
            if top not in ("sessions", "builds", "git") or not rel or ".." in Path(rel).parts or info.is_dir():
                continue
            dest = Path(new[top]) / rel
            if dest.exists():
                summary["skipped_files"] += 1
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            data = z.read(info)
            if (top == "sessions" and name.endswith(".json")) or rel.endswith(".arena-files.json"):
                text = _rewrite(data.decode("utf-8", "replace"), roots, new)
                if top == "sessions" and ".build." in rel and not re.search(r"\.v\d+\.json$", rel):
                    try:  # the local agent's session (Claude Code / Codex on that machine) does not exist here
                        d = json.loads(text)
                        if isinstance(d, dict) and d.get("engine_session"):
                            d["engine_session"] = None
                        text = json.dumps(d)
                    except ValueError:
                        pass
                data = text.encode()
            dest.write_bytes(data)
            mode = (info.external_attr >> 16) & 0o777
            if mode:
                os.chmod(dest, mode)  # scripts keep their executable bit
            summary["files"] += 1
        rows = json.loads(z.read("db.json"))
    with _db() as c:
        tables = {name: (cols, virtual) for name, cols, virtual in _user_tables(c)}
        for name, items in rows.items():
            if name == "analytics_hits":
                cols = [r[1] for r in c.execute("PRAGMA table_info(analytics_hits)")]
                have = {(r[0], r[1], r[2]) for r in c.execute("SELECT site, ts, kind FROM analytics_hits WHERE site IN (%s)" % ",".join("?" * len({i['site'] for i in items})), list({i["site"] for i in items}))} if items else set()
                n = 0
                for it in items:
                    if (it["site"], it["ts"], it["kind"]) in have:
                        continue
                    keys = [k for k in it if k in cols]
                    c.execute(f"INSERT INTO analytics_hits ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", [_decode(it[k]) for k in keys])
                    n += 1
                summary["rows"][name] = n
                continue
            if name == "analytics_people":
                cols = [r[1] for r in c.execute("PRAGMA table_info(analytics_people)")]
                n = 0
                for it in items:
                    keys = [k for k in it if k in cols]
                    n += c.execute(f"INSERT OR IGNORE INTO analytics_people ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", [_decode(it[k]) for k in keys]).rowcount
                summary["rows"][name] = n
                continue
            if name not in tables:
                continue
            cols, virtual = tables[name]
            n = 0
            for it in items:
                d = {k: _decode(v) for k, v in it.items() if k in cols}
                d["user_id"] = user_id
                for col in ENC_COLS & set(d):
                    v = d.get(col)
                    d[col] = _fernet.encrypt(v["__plain__"].encode()) if isinstance(v, dict) and "__plain__" in v else None
                for k, v in d.items():
                    if isinstance(v, str) and roots:
                        d[k] = _rewrite(v, roots, new)
                keys = list(d)
                if virtual and "doc_id" in d and c.execute(f"SELECT 1 FROM {name} WHERE user_id = ? AND doc_id = ? AND seq = ?", (user_id, d["doc_id"], d.get("seq"))).fetchone():
                    continue  # full-text rows have no unique key: imported once only
                verb = "INSERT" if virtual else "INSERT OR IGNORE"
                cur = c.execute(f"{verb} INTO {name} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", [d[k] for k in keys])
                n += cur.rowcount if cur.rowcount > 0 else 0
            summary["rows"][name] = n
    return summary
