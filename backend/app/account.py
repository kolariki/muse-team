"""Deleting an account: everything of the person goes. What stays are the bare accounting records of what was paid
(the order, and a paid developer request without its ticket, notes or contact)."""
from __future__ import annotations

import logging
import shutil

from . import adtier, mailer
from .auth import DATA_DIR, User, _db
from .gitserver import GIT_ROOT
from .local_engine import BUILD_ROOT, CLAUDE_HOMES

log = logging.getLogger("arena.account")
KEPT = {"orders", "fde_requests"}


def published_builds(user_id: str) -> list[str]:
    with _db() as c:
        return [r["build_id"] for r in c.execute("SELECT build_id FROM cloud_apps WHERE user_id = ?", (user_id,))]


def erase(user: User) -> None:
    with _db() as c:
        videos = [r[0] for r in c.execute("SELECT id FROM adtier_videos WHERE created_by = ?", (user.id,))]
    for video in videos:
        adtier.remove(video)
    with _db() as c:
        slugs = {r[0] for r in c.execute("SELECT slug FROM cloud_apps WHERE user_id = ?", (user.id,))} | {r[0] for r in c.execute("SELECT slug FROM analytics_sites WHERE user_id = ?", (user.id,))}
        for slug in slugs:  # what visitors did on this person's apps
            for table in ("analytics_hits", "analytics_people", "analytics_person_ai", "llm_calls"):
                c.execute(f"DELETE FROM {table} WHERE site = ?", (slug,))
        c.execute("DELETE FROM adtier_profile_videos WHERE profile_id IN (SELECT id FROM adtier_profiles WHERE user_id = ?)", (user.id,))
        c.execute("DELETE FROM fde_requests WHERE user_id = ? AND paid_at IS NULL", (user.id,))
        c.execute("UPDATE fde_requests SET notes = '', contact = '', ticket = '{}' WHERE user_id = ?", (user.id,))
        for table in [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]:
            if table not in KEPT and "user_id" in {r[1] for r in c.execute(f"PRAGMA table_info({table})")}:
                c.execute(f"DELETE FROM {table} WHERE user_id = ?", (user.id,))
        for table, column in (("email_codes", "email"), ("password_resets", "email"), ("mail_log", "to_addr")):
            if c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (table,)).fetchone():
                c.execute(f"DELETE FROM {table} WHERE {column} = ?", (user.email,))
        c.execute("DELETE FROM users WHERE id = ?", (user.id,))
    for root in (DATA_DIR, BUILD_ROOT, GIT_ROOT, CLAUDE_HOMES):
        shutil.rmtree(root / user.id, ignore_errors=True)
    if mailer.configured():
        mailer.send(user.email, "Eliminamos tu cuenta de Muse Team", f"Hola {user.name},\n\nTu cuenta y tus datos ya fueron eliminados. Si no fuiste vos, escribinos a {mailer.support_address()}.", reply_to=mailer.support_address())
