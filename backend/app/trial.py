"""Free trial on Baseten: users without their own key debate on open models paid by Muse Team, within two caps.

Each user gets ARENA_TRIAL_ROUNDS rounds (default 5), and all trial spend together stops at ARENA_TRIAL_BUDGET_USD
(default 90, a margin under the $100 credit). The server key (BASETEN_API_KEY) never leaves the server; ARENA_TRIAL=off
turns the trial off without removing the key.
"""
from __future__ import annotations

import time

from .auth import _db
from .config import env

PROVIDER = "baseten"
# Muse Spark Open keeps the trial on brand with the Meta edition; GLM-5.3 is the documented fallback
PREFERRED_MODELS = ("meta-models/muse-spark-open", "zai-org/GLM-5.3")

with _db() as _c:
    _c.execute("CREATE TABLE IF NOT EXISTS trial_usage (user_id TEXT PRIMARY KEY, rounds INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, updated REAL NOT NULL)")


def _int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)) or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(env(name, str(default)) or default)
    except ValueError:
        return default


def enabled() -> bool:
    return bool(env("BASETEN_API_KEY")) and (env("ARENA_TRIAL", "on") or "on").lower() != "off"


def rounds_limit() -> int:
    return _int("ARENA_TRIAL_ROUNDS", 5)


def budget_usd() -> float:
    return _float("ARENA_TRIAL_BUDGET_USD", 90.0)


def _usage(user_id: str) -> tuple[int, float]:
    with _db() as c:
        r = c.execute("SELECT rounds, cost_usd FROM trial_usage WHERE user_id = ?", (user_id,)).fetchone()
    return (r["rounds"], r["cost_usd"]) if r else (0, 0.0)


def spent_usd() -> float:
    with _db() as c:
        return float(c.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM trial_usage").fetchone()[0])


def left(user_id: str) -> int:
    """Trial rounds this user can still start (0 when the trial is off or the global budget ran out)."""
    if not enabled() or spent_usd() >= budget_usd():
        return 0
    return max(0, rounds_limit() - _usage(user_id)[0])


def spend(user_id: str, rounds: int = 0, cost_usd: float = 0.0) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO trial_usage (user_id, rounds, cost_usd, updated) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET rounds = rounds + excluded.rounds, cost_usd = cost_usd + excluded.cost_usd, updated = excluded.updated",
            (user_id, rounds, cost_usd, time.time()),
        )


def pick_model(models: list[str] | None) -> str | None:
    """The trial model: an env override, else the first preferred model the account lists."""
    if m := env("DEFAULT_MODEL_BASETEN"):
        return m
    if not models:  # the catalog could not be listed: the slug Baseten documents
        return PREFERRED_MODELS[-1]
    return next((m for m in PREFERRED_MODELS if m in models), None)
