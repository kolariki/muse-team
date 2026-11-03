"""
Build versions: one snapshot per build pass (v1 = first build, v2 = after the council's first change list, …).

Each version keeps: what was requested (and by whom), what actually changed vs the previous version (files + line deltas),
the council's verdict on it, which requested items were resolved, and a production-readiness score (0–100).
File contents of every version are stored next to the build (`<session>.build.<id>.v<n>.json`) so any two versions can be
diffed later; when `git` is available the project folder also gets a commit + tag `v<n>` per version.
"""
from __future__ import annotations

import difflib
import json
import logging
import shutil
import subprocess
import time
from pathlib import Path

log = logging.getLogger("arena.versions")

GITIGNORE = "node_modules/\n.venv/\nvenv/\n.next/\ndist/\nbuild/\n.env\n.arena-files.json\n__pycache__/\n.pytest_cache/\n"


# ------------------------------------------------------------------ storage

def version_path(base: Path, n: int) -> Path:
    return base.with_name(base.name.replace(".json", f".v{n}.json"))


def save_version_files(base: Path, n: int, files: dict[str, str]) -> None:
    version_path(base, n).write_text(json.dumps(files, ensure_ascii=False))


def load_version_files(base: Path, n: int) -> dict[str, str]:
    p = version_path(base, n)
    return json.loads(p.read_text()) if p.exists() else {}


# ------------------------------------------------------------------ diff

def diff_stats(prev: dict[str, str], cur: dict[str, str]) -> dict:
    added = sorted(p for p in cur if p not in prev)
    deleted = sorted(p for p in prev if p not in cur)
    modified = sorted(p for p in cur if p in prev and prev[p] != cur[p])
    ins = sum(cur[p].count("\n") + 1 for p in added)
    dele = sum(prev[p].count("\n") + 1 for p in deleted)
    for p in modified:
        for line in difflib.unified_diff(prev[p].splitlines(), cur[p].splitlines(), lineterm="", n=0):
            if line.startswith("+") and not line.startswith("+++"):
                ins += 1
            elif line.startswith("-") and not line.startswith("---"):
                dele += 1
    return {"added": added, "modified": modified, "deleted": deleted, "insertions": ins, "deletions": dele}


def unified_diff(prev: dict[str, str], cur: dict[str, str], path: str, a: str, b: str) -> str:
    return "\n".join(difflib.unified_diff((prev.get(path) or "").splitlines(), (cur.get(path) or "").splitlines(), fromfile=f"{a}/{path}", tofile=f"{b}/{path}", lineterm="", n=3))


# ------------------------------------------------------------------ readiness

def readiness(approved: bool, resolved: list[dict], requested: int, changes: list[dict]) -> int:
    """0–100: share of the previously requested items the builder resolved, minus what the council still finds open.
    approved → 100. partial counts half. New blocking findings weigh 15 each, improvements 4 each."""
    if approved:
        return 100
    if requested > 0:
        done = sum(1.0 if r.get("status") == "done" else 0.5 if r.get("status") == "partial" else 0.0 for r in resolved)
        base = 100.0 * min(done, requested) / requested
    else:
        base = 100.0
    penalty = sum(15 if c.get("severity") == "bloqueante" else 4 for c in changes)
    return int(max(0, min(100, round(base - penalty))))


# ------------------------------------------------------------------ git (best effort, never blocks the build)

def git_commit(root: Path, n: int, message: str) -> str | None:
    """Commit the current tree as tag v<n>; returns the short commit id (or None if git is unavailable/fails)."""
    git = shutil.which("git")
    if not git or not root.exists():
        return None
    env = {"GIT_AUTHOR_NAME": "Muse Team", "GIT_AUTHOR_EMAIL": "team@tablyteam.com", "GIT_COMMITTER_NAME": "Muse Team", "GIT_COMMITTER_EMAIL": "team@tablyteam.com", "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}

    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run([git, *args], cwd=str(root), capture_output=True, text=True, timeout=60, env=env)

    try:
        if not (root / ".git").exists():
            run("init", "-q")
        gi = root / ".gitignore"
        if not gi.exists():
            gi.write_text(GITIGNORE)
        run("add", "-A")
        run("commit", "-q", "-m", message, "--allow-empty")
        run("tag", "-f", f"v{n}")
        out = run("rev-parse", "--short", "HEAD")
        return out.stdout.strip() or None
    except Exception as e:  # pragma: no cover
        log.warning("git snapshot failed: %s", e)
        return None


def version_record(n: int, trigger: str, requested: list[dict], council_session: str | None, stats: dict, files: int, summary: str, commit: str | None) -> dict:
    return {
        "n": n, "tag": f"v{n}", "commit": commit, "ts": time.time(), "trigger": trigger,
        "requested": [{"id": f"R{n - 1}.{i + 1}", **{k: r.get(k, "") for k in ("severity", "role", "text")}} for i, r in enumerate(requested)],
        "from_council": council_session, "stats": stats, "files": files, "summary": summary[:600],
        "council_session": None, "verdict": None, "resolved": [], "readiness": None,
    }
