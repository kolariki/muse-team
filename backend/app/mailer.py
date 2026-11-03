"""Outgoing email for account verification: Resend (RESEND_API_KEY) or SMTP (SMTP_HOST/PORT/USER/PASS); MAIL_FROM for both.
Without any transport configured, nothing is sent and the caller falls back to showing the code locally (dev mode)."""
from __future__ import annotations

import logging
import re
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage
from html import escape

import httpx

from .config import env

log = logging.getLogger("arena.mail")


def configured() -> bool:
    return bool(env("RESEND_API_KEY", "") or env("SMTP_HOST", ""))


def sender() -> str:
    return env("MAIL_FROM", "") or env("SMTP_FROM", "") or "Tably Team <hola@tablyteam.com>"


def send(to: str, subject: str, text: str, html: str | None = None, from_addr: str | None = None, reply_to: str | None = None) -> bool:
    """True when a transport accepted the message; False (never raises) otherwise. Every attempt goes to the log the backoffice shows."""
    ok = _deliver(to, subject, text, html, from_addr, reply_to)
    _log_attempt(to, subject, from_addr or sender(), ok)
    return ok


def _log_attempt(to: str, subject: str, from_addr: str, ok: bool) -> None:
    from .auth import _db

    try:
        with _db() as c:
            c.execute("CREATE TABLE IF NOT EXISTS mail_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, to_addr TEXT NOT NULL, from_addr TEXT NOT NULL, subject TEXT NOT NULL, ok INTEGER NOT NULL)")
            # a verification mail carries its code in the subject: the log keeps it out
            c.execute("INSERT INTO mail_log (ts, to_addr, from_addr, subject, ok) VALUES (?,?,?,?,?)", (time.time(), to, from_addr, re.sub(r"^\d{4,8}\b", "••••", subject), int(ok)))
    except Exception as e:  # noqa: BLE001
        log.warning("could not log an email: %s", str(e)[:200])


def mail_log(limit: int = 300) -> list[dict]:
    from .auth import _db

    with _db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS mail_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, to_addr TEXT NOT NULL, from_addr TEXT NOT NULL, subject TEXT NOT NULL, ok INTEGER NOT NULL)")
        return [dict(r) for r in c.execute("SELECT ts, to_addr, from_addr, subject, ok FROM mail_log ORDER BY id DESC LIMIT ?", (limit,))]


def _deliver(to: str, subject: str, text: str, html: str | None, from_addr: str | None, reply_to: str | None) -> bool:
    try:
        if key := env("RESEND_API_KEY", ""):
            r = httpx.post("https://api.resend.com/emails", headers={"Authorization": f"Bearer {key}"},
                           json={"from": from_addr or sender(), "to": [to], "subject": subject, "text": text, **({"html": html} if html else {}), **({"reply_to": reply_to} if reply_to else {})}, timeout=15)
            if r.status_code >= 300:
                log.warning("resend rejected the email: %s %s", r.status_code, r.text[:200])
                return False
            return True
        if host := env("SMTP_HOST", ""):
            msg = EmailMessage()
            msg["From"], msg["To"], msg["Subject"] = from_addr or sender(), to, subject
            if reply_to:
                msg["Reply-To"] = reply_to
            msg.set_content(text)
            if html:
                msg.add_alternative(html, subtype="html")
            port = int(env("SMTP_PORT", "587") or "587")
            user, pw = env("SMTP_USER", ""), env("SMTP_PASS", "")
            if port == 465:
                with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as s:
                    if user:
                        s.login(user, pw or "")
                    s.send_message(msg)
            else:
                with smtplib.SMTP(host, port, timeout=20) as s:
                    s.starttls(context=ssl.create_default_context())
                    if user:
                        s.login(user, pw or "")
                    s.send_message(msg)
            return True
    except Exception as e:  # noqa: BLE001
        log.warning("email to %s failed: %s", to, str(e)[:200])
    return False


def verification_email(name: str, code: str) -> tuple[str, str, str]:
    subject = f"{code} es tu código de Tably Team"
    text = f"Hola {name},\n\nTu código para verificar el email es: {code}\n\nVence en 15 minutos. Si no creaste una cuenta en Tably Team, ignorá este mensaje."
    who = escape(name)
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Tably <em style="color:#6A4BE8">Team</em></div>
  <h1 style="font-weight:800;font-size:26px;letter-spacing:-.02em;margin:20px 0 4px">Verificá tu email</h1>
  <p style="color:#47475C;font-size:15px;margin:0">Hola {who}, este es tu código. Vence en 15 minutos.</p>
  <div style="font-family:Menlo,Consolas,monospace;font-size:36px;letter-spacing:.35em;font-weight:700;background:#EEEAFD;color:#4A2FC4;border-radius:14px;padding:18px 0;text-align:center;margin:20px 0">{code}</div>
  <p style="color:#73738A;font-size:12.5px;margin:0">Si no creaste una cuenta en Tably Team, ignorá este mensaje.</p>
</div>"""
    return subject, text, html


def password_reset_email(name: str, code: str) -> tuple[str, str, str]:
    subject = f"{code} es tu código para cambiar la contraseña de Tably Team"
    text = f"Hola {name},\n\nTu código para cambiar la contraseña es: {code}\n\nVence en 15 minutos. Si no lo pediste, ignorá este mensaje: tu contraseña sigue igual."
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Tably <em style="color:#6A4BE8">Team</em></div>
  <h1 style="font-weight:800;font-size:26px;letter-spacing:-.02em;margin:20px 0 4px">Cambiá tu contraseña</h1>
  <p style="color:#47475C;font-size:15px;margin:0">Hola {escape(name)}, este es tu código. Vence en 15 minutos.</p>
  <div style="font-family:Menlo,Consolas,monospace;font-size:36px;letter-spacing:.35em;font-weight:700;background:#EEEAFD;color:#4A2FC4;border-radius:14px;padding:18px 0;text-align:center;margin:20px 0">{code}</div>
  <p style="color:#73738A;font-size:12.5px;margin:0">Si no lo pediste, ignorá este mensaje: tu contraseña sigue igual.</p>
</div>"""
    return subject, text, html


def welcome_email(name: str, lang: str = "es") -> tuple[str, str, str]:
    en = lang == "en"
    subject = "Welcome to Tably Team" if en else "Te damos la bienvenida a Tably Team"
    hello = f"Hi {name}," if en else f"Hola {name},"
    intro = "Your account is ready. This is how you go from idea to a live app:" if en else "Tu cuenta ya está lista. Así pasás de la idea a una app online:"
    steps = (["Write your idea: your AI team debates it, designs it and builds it.", "Publish it online with one click.", "Connect Meta Ads: the AI reads your account, tells you what to change and builds your ads."] if en
             else ["Escribí tu idea: tu equipo de IA la debate, la diseña y la construye.", "Publicala online con un clic.", "Conectá Meta Ads: la IA lee tu cuenta, te dice qué cambiar y arma tus anuncios."])
    cta = "Start building" if en else "Empezar a construir"
    text = f"{hello}\n\n{intro}\n\n" + "\n".join(f"{i + 1}. {x}" for i, x in enumerate(steps)) + f"\n\n{cta}: https://tablyteam.com"
    rows = "".join(f'<p style="color:#47475C;font-size:15px;margin:0 0 10px"><b style="color:#6A4BE8">{i + 1}.</b> {x}</p>' for i, x in enumerate(steps))
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Tably <em style="color:#6A4BE8">Team</em></div>
  <h1 style="font-weight:800;font-size:26px;letter-spacing:-.02em;margin:20px 0 8px">{escape(hello)}</h1>
  <p style="color:#47475C;font-size:15px;margin:0 0 16px">{intro}</p>
  {rows}
  <a href="https://tablyteam.com" style="display:inline-block;margin-top:12px;background:#6A4BE8;color:#fff;text-decoration:none;font-weight:600;font-size:15px;border-radius:10px;padding:12px 22px">{cta}</a>
</div>"""
    return subject, text, html


def notify_address() -> str | None:
    """Who hears about new accounts: SIGNUP_NOTIFY_EMAIL, else the first admin, else the first account created."""
    if to := env("SIGNUP_NOTIFY_EMAIL", ""):
        return to.strip()
    if admins := [e.strip() for e in (env("TABLY_ADMIN_EMAILS", "") or "").split(",") if e.strip()]:
        return admins[0]
    from .auth import _db

    with _db() as c:
        r = c.execute("SELECT email FROM users ORDER BY created LIMIT 1").fetchone()
    return r["email"] if r else None


def new_account_email(name: str, email: str, total: int) -> tuple[str, str, str]:
    subject = f"Cuenta nueva en Tably Team: {email}"
    when = time.strftime("%d/%m/%Y %H:%M UTC", time.gmtime())
    text = f"Se creó una cuenta nueva.\n\nNombre: {name}\nEmail: {email}\nFecha: {when}\nCuentas en total: {total}"
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Tably <em style="color:#6A4BE8">Team</em></div>
  <h1 style="font-weight:800;font-size:22px;letter-spacing:-.02em;margin:20px 0 12px">Cuenta nueva</h1>
  <p style="font-size:15px;margin:0 0 6px"><b>Nombre:</b> {escape(name)}</p>
  <p style="font-size:15px;margin:0 0 6px"><b>Email:</b> {escape(email)}</p>
  <p style="font-size:15px;margin:0 0 6px"><b>Fecha:</b> {when}</p>
  <p style="font-size:15px;margin:0"><b>Cuentas en total:</b> {total}</p>
</div>"""
    return subject, text, html


def account_created(name: str, email: str, lang: str = "es") -> None:
    """The welcome to the new user and the notice to the owner, in the background: a mail problem never gets in the way of signing up."""
    if not configured():
        return

    def job() -> None:
        from .auth import _db

        send(email, *welcome_email(name, lang))
        to = notify_address()
        if to and to.lower() != email.lower():
            with _db() as c:
                total = c.execute("SELECT COUNT(*) FROM users WHERE verified = 1").fetchone()[0]
            send(to, *new_account_email(name, email, total))

    threading.Thread(target=job, daemon=True).start()


def fde_request_email(rid: str, account: str, package: str, title: str, ticket: str, paid: bool) -> tuple[str, str, str]:
    subject = f"{'Pedido pagado' if paid else 'Pedido de developer'} {rid}: {package} · {title}"
    payment = "confirmado" if paid else "a coordinar"
    text = f"Pedido: {rid}\nCuenta: {account}\nPago: {payment}\n\n{ticket}"
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Tably <em style="color:#6A4BE8">Team</em></div>
  <h1 style="font-weight:800;font-size:22px;letter-spacing:-.02em;margin:20px 0 12px">{'Pedido pagado' if paid else 'Pedido de developer'}</h1>
  <p style="font-size:15px;margin:0 0 6px"><b>Pedido:</b> {escape(rid)}</p>
  <p style="font-size:15px;margin:0 0 6px"><b>Cuenta:</b> {escape(account)}</p>
  <p style="font-size:15px;margin:0 0 16px"><b>Pago:</b> {payment}</p>
  <pre style="white-space:pre-wrap;word-break:break-word;font-family:Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;background:#F5F4FA;border-radius:12px;padding:16px;margin:0">{escape(ticket)}</pre>
</div>"""
    return subject, text, html


def support_address() -> str:
    return env("FDE_SUPPORT_EMAIL", "") or "soporte@tablyteam.com"


def fde_client_email(rid: str, name: str, package: str, title: str, ticket: str, paid: bool, lang: str = "es") -> tuple[str, str, str]:
    """The client's copy: what we received and what happens next, with the same ticket the developer gets."""
    support = support_address()
    if lang == "en":
        subject = f"We received your request: {package}"
        hello, got = f"Hi {name},", f"We received your {'payment and your ' if paid else ''}request «{package}» for {title} (request {rid})."
        nxt = f"We will write to you from {support} to arrange {'the start' if paid else 'the scope, the payment and the start'}. If you want to add anything first, just reply to this email."
        below = "This is the ticket with the state of your project:"
    else:
        subject = f"Recibimos tu pedido: {package}"
        hello, got = f"Hola {name},", f"Recibimos {'tu pago y ' if paid else ''}tu pedido «{package}» para {title} (pedido {rid})."
        nxt = f"Te vamos a escribir desde {support} para acordar {'el inicio' if paid else 'el alcance, el pago y el inicio'}. Si querés sumar algo antes, respondé este email."
        below = "Este es el ticket con el estado de tu proyecto:"
    text = f"{hello}\n\n{got}\n\n{nxt}\n\n{below}\n\n{ticket}"
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Tably <em style="color:#6A4BE8">Team</em></div>
  <h1 style="font-weight:800;font-size:22px;letter-spacing:-.02em;margin:20px 0 12px">{escape(hello)}</h1>
  <p style="color:#47475C;font-size:15px;margin:0 0 10px">{escape(got)}</p>
  <p style="color:#47475C;font-size:15px;margin:0 0 20px">{escape(nxt)}</p>
  <p style="color:#73738A;font-size:12.5px;margin:0 0 8px">{escape(below)}</p>
  <pre style="white-space:pre-wrap;word-break:break-word;font-family:Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;background:#F5F4FA;border-radius:12px;padding:16px;margin:0">{escape(ticket)}</pre>
</div>"""
    return subject, text, html


def fde_reply_email(rid: str, name: str, package: str, body: str) -> tuple[str, str, str]:
    subject = f"Tu pedido {rid}: {package}"
    text = f"{body}\n\nEquipo de Tably Team"
    paragraphs = "".join(f'<p style="font-size:15px;line-height:1.5;margin:0 0 12px;white-space:pre-wrap">{escape(p)}</p>' for p in body.split("\n\n"))
    html = f"""<div style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#17172A">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em;margin-bottom:20px">Tably <em style="color:#6A4BE8">Team</em></div>
  {paragraphs}
  <p style="color:#47475C;font-size:15px;margin:16px 0 0">Equipo de Tably Team</p>
</div>"""
    return subject, text, html


def fde_requested(rid: str, account: str, client: str, name: str, package: str, package_client: str, title: str, ticket: str, paid: bool, lang: str = "es") -> None:
    """The whole ticket to whoever handles developer requests (FDE_NOTIFY_EMAIL), whose «Reply» goes to the client, and the
    client's copy, whose «Reply» goes to support. Both from support, in the background: a mail problem never gets in the way of the request."""
    if not configured():
        log.warning("no email transport: the ticket of %s was not sent", rid)
        return
    team = env("FDE_NOTIFY_EMAIL", "") or notify_address() or support_address()
    support = support_address()
    from_addr = f"Tably Team <{support}>"

    def job() -> None:
        ticket_mail = fde_request_email(rid, account, package, title, ticket, paid)
        # the ticket is the one mail that cannot get lost: if support cannot send, it goes out from the usual address
        send(team, *ticket_mail, from_addr=from_addr, reply_to=client) or send(team, *ticket_mail, reply_to=client)
        send(client, *fde_client_email(rid, name, package_client, title, ticket, paid, lang), from_addr=from_addr, reply_to=support)

    threading.Thread(target=job, daemon=True).start()
