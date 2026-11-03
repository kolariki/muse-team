"""
"Pedir un developer": a Forward Deployed Engineer closes the last mile of a product built here — production deploy,
real integrations (payments, email, auth, an external data source), a human pre-launch review, extra hours.

Fixed-price packages with a closed scope. The request is created from the project's real state, so the engineer
receives a ticket with everything (brief summary, version and readiness, the council's open blockers, the services
still missing, stack, where the code is) instead of "hi, it doesn't work".
Payment links live in CHECKOUT_LINKS; FDE_CHECKOUT_URL_<PACKAGE_ID_UPPER> overrides one and FDE_BOOKING_URL (Cal.com)
adds scheduling. A request that can be paid online waits as "pending_payment" and the developer gets the ticket once the
payment is confirmed; one that cannot stays "new", the ticket goes out right away and you follow up by email. The client
always gets a copy, and the conversation runs through the support address (mailer.support_address).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid

from . import mailer
from .auth import _db
from .config import env

log = logging.getLogger("arena.fde")
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")

with _db() as _c:
    _c.executescript(
        """
        CREATE TABLE IF NOT EXISTS fde_requests (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, build_id TEXT NOT NULL,
            package TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
            ticket TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS fde_user ON fde_requests (user_id, created);
        """
    )
    _c.execute("CREATE TABLE IF NOT EXISTS fde_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, user_id TEXT NOT NULL, ts REAL NOT NULL, to_addr TEXT NOT NULL, text TEXT NOT NULL)")
    if "paid_at" not in {r[1] for r in _c.execute("PRAGMA table_info(fde_requests)")}:
        _c.execute("ALTER TABLE fde_requests ADD COLUMN paid_at REAL")

PACKAGES: list[dict] = [
    {
        "id": "launch", "name": "Puesta en producción", "price_usd": 199, "eta": "48 h hábiles", "badge": "más pedido",
        "tagline": "De «funciona en mi máquina» a una URL real, con todo configurado.",
        "includes": ["Dominio y HTTPS", "Deploy en Vercel / Railway (o tu nube)", "Variables y secretos por entorno", "Base de datos gestionada + migraciones", "CI con tests en cada push", "Monitoreo y alertas básicas", "Acta de entrega con accesos y cómo operar"],
        "excludes": ["Cambios de funcionalidad", "Integraciones nuevas (ver «Integración»)"],
        "needs": ["Invitación como colaborador a tu cuenta de Vercel/Railway y GitHub", "Dominio (si ya lo tenés)"],
        "name_en": "Production launch", "eta_en": "48 business hours", "badge_en": "most requested", "tagline_en": "From «works on my machine» to a real URL, with everything configured.", "includes_en": ["Domain and HTTPS", "Deploy on Vercel / Railway (or your cloud)", "Variables and secrets per environment", "Managed database + migrations", "CI with tests on every push", "Basic monitoring and alerts", "Handover report with access and how to operate it"], "excludes_en": ["Functionality changes", "New integrations (see «Integration»)"], "needs_en": ["Collaborator invite to your Vercel/Railway and GitHub accounts", "Domain (if you already have one)"],
    },
    {
        "id": "service_setup", "name": "Un experto configura el servicio", "price_usd": 49, "eta": "24 h hábiles", "badge": "nuevo",
        "tagline": "Mercado Pago, emails, login con Google… lo dejamos funcionando en tu app, con vos o por vos.",
        "includes": ["Precio por cada servicio conectado", "Te ayudamos a crear o configurar la cuenta del servicio", "Cargamos las claves en tu app (prueba y producción)", "Probamos que funcione de verdad (un pago, un email…)", "Te dejamos anotado cómo cambiarlo"],
        "excludes": ["Cambios en cómo funciona la app", "Los costos o comisiones del propio servicio"],
        "needs": ["Acceso a tu cuenta del servicio: nos invitás o lo hacemos juntos en una llamada"],
        "name_en": "An expert sets up the service", "eta_en": "24 business hours", "badge_en": "new", "tagline_en": "Mercado Pago, email, Google login… we leave it working in your app, with you or for you.", "includes_en": ["Price per connected service", "We help you create or configure the service account", "We load the keys into your app (test and production)", "We check it really works (a payment, an email…)", "A short note on how to change it"], "excludes_en": ["Changes to how the app works", "The service's own costs or fees"], "needs_en": ["Access to your service account: invite us or we do it together on a call"],
    },
    {
        "id": "integration", "name": "Integración de un servicio", "price_usd": 149, "eta": "24–48 h hábiles", "badge": None,
        "tagline": "Pagos, email, login social, una API externa real (datos, mapas, SMS…), analítica.",
        "includes": ["Cuenta y keys configuradas (modo test y producción)", "Código de integración revisado y probado", "Webhooks / reintentos / errores manejados", "Documentación corta de cómo cambiarlo"],
        "excludes": ["Más de un servicio por paquete", "Contratos o costos del proveedor"],
        "needs": ["Acceso al servicio (Stripe, Resend, Google Cloud…) por invitación"],
        "name_en": "One service integration", "eta_en": "24–48 business hours", "tagline_en": "Payments, email, social login, a real external API (data, maps, SMS…), analytics.", "includes_en": ["Account and keys configured (test and production mode)", "Integration code reviewed and tested", "Webhooks / retries / errors handled", "Short doc on how to change it"], "excludes_en": ["More than one service per package", "Provider contracts or costs"], "needs_en": ["Access to the service (Stripe, Resend, Google Cloud…) by invite"],
    },
    {
        "id": "review", "name": "Revisión humana pre-lanzamiento", "price_usd": 99, "eta": "24 h hábiles", "badge": None,
        "tagline": "Un ingeniero senior repasa lo que marcó el consejo: seguridad, costos, lo que se rompe primero.",
        "includes": ["Lectura del código y de los bloqueantes del consejo", "Llamada de 45 min", "Informe con prioridades y estimaciones", "Checklist de salida firmado"],
        "excludes": ["Implementar los cambios (se cotizan aparte o con «Horas»)"],
        "needs": ["Nada: trabaja sobre el proyecto tal como está en la plataforma"],
        "name_en": "Human pre-launch review", "eta_en": "24 business hours", "tagline_en": "A senior engineer goes over what the council flagged: security, costs, what breaks first.", "includes_en": ["Read-through of the code and the council blockers", "45-minute call", "Report with priorities and estimates", "Signed launch checklist"], "excludes_en": ["Implementing the changes (quoted separately or with «Hours»)"], "needs_en": ["Nothing: works on the project as it is on the platform"],
    },
    {
        "id": "hours", "name": "Horas de developer", "price_usd": 75, "eta": "a coordinar", "badge": "por hora",
        "tagline": "Para lo que no entra en un paquete: migraciones de datos, features puntuales, soporte de lanzamiento.",
        "includes": ["Mínimo 4 h", "Reporte por hora con lo hecho", "Trabajo sobre el repo del proyecto, versionado"],
        "excludes": [],
        "needs": ["Alcance acordado por escrito antes de empezar"],
        "name_en": "Developer hours", "eta_en": "to be arranged", "badge_en": "hourly", "tagline_en": "For what does not fit a package: data migrations, one-off features, launch support.", "includes_en": ["4 h minimum", "Hourly report of the work done", "Work on the project repo, versioned"], "needs_en": ["Scope agreed in writing before starting"],
    },
]

STATUSES = ["pending_payment", "new", "paid", "scheduled", "in_progress", "delivered", "closed", "cancelled"]


def package(pid: str) -> dict | None:
    return next((p for p in PACKAGES if p["id"] == pid), None)


# Stripe Payment Links, one per package, come from FDE_CHECKOUT_URL_<PACKAGE_ID_UPPER>.
CHECKOUT_LINKS: dict[str, str] = {}


def links(pid: str) -> dict:
    # a link is only offered once Stripe can tell us it was paid (its webhook): otherwise someone pays and nobody finds out
    link = (os.environ.get(f"FDE_CHECKOUT_URL_{pid.upper()}") or CHECKOUT_LINKS.get(pid)) if env("STRIPE_WEBHOOK_SECRET", "") else None
    return {"checkout_url": link, "booking_url": os.environ.get("FDE_BOOKING_URL") or None}


# ------------------------------------------------------------------ ticket

def _brief_summary(brief: str) -> str:
    m = re.search(r"^##\s*1\.[^\n]*\n(.*?)(?=^##\s*2\.|\Z)", brief or "", re.S | re.M)
    txt = (m.group(1) if m else (brief or "")).strip()
    return re.sub(r"\n{3,}", "\n\n", txt)[:1500]


def build_ticket(b, services: dict, stack: list[dict], pkg: dict, notes: str, contact: str, lang: str = "es") -> dict:
    """Everything the engineer needs, from the project's real state."""
    v = b.versions[-1] if b.versions else None
    blockers = []
    if v and v.get("council_session"):
        pending = [r for r in (v.get("resolved") or []) if r.get("status") != "done"]
        blockers += [{"severity": "bloqueante", "text": f"{r['text']} (pedido {r['id']}: {r['status']})", "role": ""} for r in pending]
    for rv in reversed(b.reviews[-1:]):
        for c in rv.get("changes") or []:
            if c.get("severity") == "bloqueante":
                blockers.append(c)
    missing = [x for x in (services.get("missing") or [])]
    groups = services.get("groups") or []
    return {
        "project": {"title": b.title, "session_id": b.req.session_id, "build_id": b.id, "files": len(b.files), "workdir": str(b.workdir) if b.workdir else None,
                    "version": v["tag"] if v else None, "commit": v.get("commit") if v else None, "readiness": v.get("readiness") if v else None, "status": b.status},
        "brief_summary": _brief_summary(b.brief),
        "stack": [{"id": s["id"], "label": s["label"], "run": s["run"]} for s in stack],
        "blockers": blockers[:20],
        "services": [{"service": g["service"], "purpose": g.get("purpose", ""), "vars": [x["var"] for x in g.get("vars", [])], "configured": all(x.get("configured") for x in g.get("vars", []))} for g in groups],
        "missing_vars": missing,
        "deploys": [{"target": d.get("target"), "ok": d.get("ok"), "url": d.get("url")} for d in (b.deploys or [])[-3:]],
        "app_run": {"status": b.app_run.status, "url": b.app_run.url} if getattr(b, "app_run", None) else None,
        "package": {"id": pkg["id"], "name": pkg["name"], "price_usd": pkg["price_usd"], "eta": pkg["eta"]},
        "notes": notes, "contact": contact, "lang": lang,
    }


def ticket_markdown(t: dict) -> str:
    p = t["project"]
    lines = [f"# Pedido FDE · {t['package']['name']} (USD {t['package']['price_usd']}, {t['package']['eta']})", "",
             f"**Proyecto:** {p['title']}  ", f"**Versión:** {p.get('version') or '—'} ({p.get('commit') or 'sin commit'}) · listo para prod: {str(p.get('readiness')) + '%' if p.get('readiness') is not None else 'sin revisar'}  ",
             f"**Archivos:** {p['files']} · estado: {p['status']}  ", f"**Código:** build `{p['build_id']}` de la sesión `{p['session_id']}`" + (f" · carpeta `{p['workdir']}`" if p.get("workdir") else ""), "",
             "## Lo que pide el cliente", t.get("notes") or "(sin detalle)", "", f"**Contacto:** {t.get('contact') or '—'}", "",
             "## Resumen del brief", t.get("brief_summary") or "—", ""]
    if t.get("stack"):
        lines += ["## Stack detectado"] + [f"- {s['label']} → `{s['run']}`" for s in t["stack"]] + [""]
    if t.get("blockers"):
        lines += ["## Bloqueantes abiertos (consejo de revisión)"] + [f"- [{c.get('severity', 'bloqueante')}] {c['text']}" + (f" · {c['role']}" if c.get("role") else "") for c in t["blockers"]] + [""]
    if t.get("services"):
        lines += ["## Servicios externos"] + [f"- {'✅' if s['configured'] else '⬜'} {s['service']}" + (f" — {s['purpose']}" if s.get("purpose") else "") + f" ({', '.join(s['vars'])})" for s in t["services"]] + [""]
    if t.get("missing_vars"):
        lines += [f"**Variables sin cargar:** {', '.join(t['missing_vars'])}", ""]
    if t.get("deploys"):
        lines += ["## Deploys previos"] + [f"- {d['target']}: {'ok' if d['ok'] else 'falló'}" + (f" → {d['url']}" if d.get("url") else "") for d in t["deploys"]] + [""]
    return "\n".join(lines)


# ------------------------------------------------------------------ storage

def _row(r) -> dict:
    d = dict(r)
    d["ticket"] = json.loads(d["ticket"])
    return d


def create_request(user_id: str, session_id: str, build_id: str, pkg: dict, ticket: dict, notes: str, contact: str, status: str = "new") -> dict:
    rid = "fde-" + uuid.uuid4().hex[:8]
    now = time.time()
    with _db() as c:
        c.execute("INSERT INTO fde_requests (id, user_id, session_id, build_id, package, status, notes, contact, ticket, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (rid, user_id, session_id, build_id, pkg["id"], status, notes[:4000], contact[:300], json.dumps(ticket, ensure_ascii=False), now, now))
    return get_request(user_id, rid)  # type: ignore[return-value]


def list_requests(user_id: str, session_id: str | None = None) -> list[dict]:
    with _db() as c:
        if session_id:
            rows = c.execute("SELECT * FROM fde_requests WHERE user_id=? AND session_id=? ORDER BY created DESC", (user_id, session_id))
        else:
            rows = c.execute("SELECT * FROM fde_requests WHERE user_id=? ORDER BY created DESC", (user_id,))
        return [_row(r) for r in rows]


def get_request(user_id: str, rid: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM fde_requests WHERE user_id=? AND id=?", (user_id, rid)).fetchone()
    return _row(r) if r else None


def usd_cents(session: dict) -> int:
    """What a Checkout Session charged in USD, 0 if it does not say. Payment Links offer the buyer's local currency: on
    current Stripe API versions the session stays in USD, on older ones the USD amount is under currency_conversion."""
    conversion = session.get("currency_conversion") or {}
    if str(conversion.get("source_currency") or "").lower() == "usd":
        return int(conversion.get("amount_total") or 0)
    return int(session.get("amount_total") or 0) if str(session.get("currency") or "").lower() == "usd" else 0


def _client_address(contact: str, account: str) -> str:
    """The email they left as contact, or their account's: the contact can be a WhatsApp number."""
    contact = (contact or "").strip()
    return contact if EMAIL.fullmatch(contact) else account


def reply_to_client(rid: str, text: str) -> dict | None:
    """The operator answers a request: the email goes out from support and stays on the request. None if nothing went out."""
    with _db() as c:
        row = c.execute("SELECT r.user_id, r.package, r.contact, u.email, u.name FROM fde_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?", (rid,)).fetchone()
    if not row or not row["email"]:
        return None
    to = _client_address(row["contact"], row["email"])
    pkg = package(row["package"]) or {}
    support = mailer.support_address()
    if not mailer.send(to, *mailer.fde_reply_email(rid, row["name"], pkg.get("name", row["package"]), text), from_addr=f"Muse Team <{support}>", reply_to=support):
        return None
    msg = {"ts": time.time(), "to_addr": to, "text": text}
    with _db() as c:
        c.execute("INSERT INTO fde_messages (request_id, user_id, ts, to_addr, text) VALUES (?,?,?,?,?)", (rid, row["user_id"], msg["ts"], to, text))
    return msg


def send_ticket_emails(r: dict, paid: bool) -> None:
    """The ticket by email to the developer and to the client. A mail problem never undoes a payment or a request."""
    try:
        with _db() as c:
            u = c.execute("SELECT email, name FROM users WHERE id=?", (r["user_id"],)).fetchone()
        t = r["ticket"]
        account = u["email"] if u else r["contact"]
        client = _client_address(r["contact"], account)
        pkg = package(r["package"]) or {}
        lang = t.get("lang", "es")
        package_client = (pkg.get("name_en") if lang == "en" else None) or t["package"]["name"]
        mailer.fde_requested(r["id"], account, client, u["name"] if u else "", t["package"]["name"], package_client, t["project"]["title"], ticket_markdown(t), paid, lang)
    except Exception as e:  # noqa: BLE001
        log.warning("could not send the ticket of %s: %s", r.get("id"), e)


def confirm_paid(rid: str) -> bool:
    """The request was really paid: it moves to 'paid' and the developer gets the ticket. Stripe's notice and the user's
    return can both arrive, only the first one counts. A request cancelled meanwhile counts too: the money came in."""
    with _db() as c:
        changed = c.execute("UPDATE fde_requests SET status='paid', paid_at=?, updated=? WHERE id=? AND status IN ('pending_payment','new','cancelled')", (time.time(), time.time(), rid)).rowcount
        row = c.execute("SELECT user_id FROM fde_requests WHERE id=?", (rid,)).fetchone()
    if not changed or not row:
        return False
    send_ticket_emails(get_request(row["user_id"], rid) or {}, paid=True)
    return True


def settle_link_payment(rid: str, amount_cents: int) -> bool:
    """A Stripe Payment Link came back paid with this request as its reference. The reference travels in a URL the
    user can edit, so the amount has to cover the package (taxes only add to it) before the request counts as paid."""
    with _db() as c:
        row = c.execute("SELECT package FROM fde_requests WHERE id=?", (rid,)).fetchone()
    if not row:
        return False
    pkg = package(row["package"]) or {}
    floor = float(pkg.get("price_usd", 0)) * (4 if row["package"] == "hours" else 1)
    if not floor or amount_cents < floor * 100:
        log.warning("payment link for %s came with %s cents, below the package price", rid, amount_cents)
        return False
    return confirm_paid(rid)


def operator_set_status(rid: str, status: str) -> None:
    """The operator moves a request along; marking it paid (arranged by email) records when, whatever comes after."""
    now = time.time()
    with _db() as c:
        c.execute("UPDATE fde_requests SET status=?, updated=?, paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at, ?) ELSE paid_at END WHERE id=?", (status, now, status, now, rid))


def request_amount(r: dict) -> float:
    """What a request is worth in USD: hourly ones by the hours written in their notes, 4 at least."""
    price = float((package(r["package"]) or {}).get("price_usd", 0))
    if r["package"] != "hours":
        return price
    m = re.search(r"Horas pedidas:\s*(\d+)", r.get("notes") or "")
    return price * max(4, int(m.group(1)) if m else 4)


def update_request(user_id: str, rid: str, status: str | None = None, notes: str | None = None) -> dict | None:
    with _db() as c:
        if status and status in STATUSES:
            c.execute("UPDATE fde_requests SET status=?, updated=? WHERE user_id=? AND id=?", (status, time.time(), user_id, rid))
        if notes is not None:
            c.execute("UPDATE fde_requests SET notes=?, updated=? WHERE user_id=? AND id=?", (notes[:4000], time.time(), user_id, rid))
    return get_request(user_id, rid)
