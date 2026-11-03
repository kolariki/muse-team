"""The operator's backoffice: every account, developer request, email, payment and published app in one read.
Only named columns are selected, so password hashes, API keys and OAuth tokens cannot reach the screen."""
from __future__ import annotations

import json

from . import billing, fde, mailer  # noqa: F401  (billing and the rest create the tables read here)
from . import cloud, connections, keystore, incidents  # noqa: F401
from .auth import _db, user_dir

LIMIT = 1000
OPEN = ("pending_payment", "new", "paid", "scheduled", "in_progress")


def _requests(emails: dict[str, str], names: dict[str, str]) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT id, user_id, session_id, build_id, package, status, notes, contact, ticket, created, updated, paid_at FROM fde_requests ORDER BY created DESC LIMIT ?", (LIMIT,)).fetchall()
    with _db() as c:
        messages: dict[str, list[dict]] = {}
        for m in c.execute("SELECT request_id, ts, to_addr, text FROM fde_messages ORDER BY id"):
            messages.setdefault(m["request_id"], []).append({"ts": m["ts"], "to_addr": m["to_addr"], "text": m["text"]})
    out = []
    for r in rows:
        d = dict(r)
        ticket = json.loads(d.pop("ticket") or "{}")
        pkg = fde.package(d["package"]) or {}
        out.append(d | {"email": emails.get(d["user_id"], ""), "name": names.get(d["user_id"], ""), "package_name": pkg.get("name", d["package"]), "amount_usd": fde.request_amount(d),
                        "project": (ticket.get("project") or {}).get("title", ""), "open": d["status"] in OPEN, "messages": messages.get(d["id"], [])})
    return out


def _payments(requests: list[dict], emails: dict[str, str]) -> list[dict]:
    with _db() as c:
        orders = [dict(r) for r in c.execute("SELECT id, user_id, kind, ref, name, amount_usd, status, created, paid_at FROM orders ORDER BY created DESC LIMIT ?", (LIMIT,))]
    through_order = {o["ref"] for o in orders if o["kind"] == "fde" and o["status"] == "paid"}
    rows = [{"id": o["id"], "email": emails.get(o["user_id"], ""), "concept": o["name"], "amount_usd": o["amount_usd"], "status": o["status"], "ts": o["paid_at"] or o["created"], "via": "Stripe Checkout"} for o in orders]
    # paid on a Payment Link or arranged by email: there is no order behind them
    rows += [{"id": r["id"], "email": r["email"], "concept": r["package_name"], "amount_usd": r["amount_usd"], "status": "paid", "ts": r["paid_at"], "via": "Link o email"} for r in requests if r["paid_at"] and r["id"] not in through_order]
    return sorted(rows, key=lambda x: x["ts"] or 0, reverse=True)


def snapshot() -> dict:
    with _db() as c:
        users = [dict(r) for r in c.execute("SELECT id, email, name, phone, created, verified FROM users ORDER BY created DESC LIMIT ?", (LIMIT,))]
        conns = [dict(r) for r in c.execute("SELECT user_id, provider, account, expires, updated FROM user_connections ORDER BY updated DESC LIMIT ?", (LIMIT,))]
        ais = [dict(r) for r in c.execute("SELECT user_id, provider, updated FROM user_providers WHERE enc_key IS NOT NULL ORDER BY updated DESC LIMIT ?", (LIMIT,))]
        apps = [dict(r) for r in c.execute("SELECT user_id, build_id, slug, provider, status, url, error, created, updated FROM cloud_apps ORDER BY updated DESC LIMIT ?", (LIMIT,))]
        errors = {(r["user_id"], r["build_id"]): r["n"] for r in c.execute("SELECT user_id, build_id, COUNT(*) AS n FROM app_errors WHERE status = 'open' GROUP BY user_id, build_id")}
    emails, names = {u["id"]: u["email"] for u in users}, {u["id"]: u["name"] for u in users}
    requests = _requests(emails, names)
    payments = _payments(requests, emails)
    mails = mailer.mail_log()
    for u in users:
        uid = u["id"]
        mine = [r for r in requests if r["user_id"] == uid]
        u |= {"requests": len(mine), "paid_usd": sum(p["amount_usd"] for p in payments if p["email"] == u["email"] and p["status"] == "paid"), "apps": sum(a["user_id"] == uid for a in apps),
              "projects": sum(1 for _ in user_dir(uid).glob("*.build.*.json")), "connected": sorted({x["provider"] for x in conns if x["user_id"] == uid} | {x["provider"] for x in ais if x["user_id"] == uid})}
    accounts = [x | {"email": emails.get(x["user_id"], ""), "kind": "Cuenta"} for x in conns] + [x | {"email": emails.get(x["user_id"], ""), "kind": "IA", "account": None, "expires": None} for x in ais]
    return {
        "overview": {
            "users": len(users), "verified": sum(1 for u in users if u["verified"]), "open_requests": sum(r["open"] for r in requests), "new_requests": sum(r["status"] in ("new", "pending_payment") for r in requests),
            "paid_usd": sum(p["amount_usd"] for p in payments if p["status"] == "paid"), "apps": len(apps), "open_errors": sum(errors.values()), "emails": len(mails), "emails_failed": sum(not m["ok"] for m in mails),
        },
        "users": users, "accounts": sorted(accounts, key=lambda x: x["updated"] or 0, reverse=True), "requests": requests, "emails": mails, "payments": payments,
        "apps": [a | {"email": emails.get(a["user_id"], ""), "open_errors": errors.get((a["user_id"], a["build_id"]), 0)} for a in apps],
        "statuses": fde.STATUSES,
    }


def ticket(rid: str) -> str | None:
    with _db() as c:
        r = c.execute("SELECT ticket FROM fde_requests WHERE id=?", (rid,)).fetchone()
    return fde.ticket_markdown(json.loads(r["ticket"])) if r else None
