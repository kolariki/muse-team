"""Accounts: email + password (scrypt), opaque bearer tokens, SQLite. No external deps.

Every arena session belongs to the user who started it; files live in DATA_DIR/<user_id>/.
Sessions recorded before accounts existed (files directly in DATA_DIR) are handed to the first
account that signs up.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .config import DATA_DIR, env

DB_PATH = Path(env("ARENA_DB", str(DATA_DIR.parent / "arena.db")))
TOKEN_TTL = int(env("ARENA_TOKEN_TTL_DAYS", "30")) * 86400
ALLOW_SIGNUP = (env("ARENA_ALLOW_SIGNUP", "true") or "true").lower() != "false"


def _db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


with _db() as _c:
    _c.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
            pw_hash BLOB NOT NULL, salt BLOB NOT NULL, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS tokens (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS email_codes (
            email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent REAL NOT NULL);
        """
    )
    # accounts created before email verification existed count as verified
    if "verified" not in {r[1] for r in _c.execute("PRAGMA table_info(users)")}:
        _c.execute("ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1")

    if "phone" not in {r[1] for r in _c.execute("PRAGMA table_info(users)")}:
        _c.execute("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''")
    for _col, _type in (("terms_accepted_at", "REAL"), ("terms_version", "TEXT")):
        if _col not in {r[1] for r in _c.execute("PRAGMA table_info(users)")}:
            _c.execute(f"ALTER TABLE users ADD COLUMN {_col} {_type}")
    _c.execute("CREATE TABLE IF NOT EXISTS email_changes (user_id TEXT PRIMARY KEY, new_email TEXT NOT NULL, code_hash TEXT NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent REAL NOT NULL)")

    _c.execute("CREATE TABLE IF NOT EXISTS password_resets (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent REAL NOT NULL)")

VERIFY_EMAIL = (env("ARENA_VERIFY_EMAIL", "true") or "true").lower() != "false"
CODE_TTL = 15 * 60
TERMS_VERSION = "2026-11-03.3"  # of frontend/src/legal; each account records which one it accepted


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=80)
    accepted_terms: bool = False


class User(BaseModel):
    id: str
    email: str
    name: str


def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _issue(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with _db() as c:
        c.execute("DELETE FROM tokens WHERE expires < ?", (time.time(),))
        c.execute("INSERT INTO tokens VALUES (?, ?, ?)", (_token_hash(token), user_id, time.time() + TOKEN_TTL))
    return token


def user_dir(user_id: str) -> Path:
    d = DATA_DIR / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def register(cred: Credentials) -> tuple[str | None, User, str | None]:
    """Creates the account. With email verification on, no token is issued yet: a 6-digit code goes to the email
    (or comes back as `dev_code` when no mail transport is configured, so local setups still work)."""
    if not ALLOW_SIGNUP:
        raise HTTPException(403, "El registro está deshabilitado")
    if not cred.accepted_terms:
        raise HTTPException(400, "Para crear la cuenta tenés que aceptar los términos y la política de privacidad")
    email = cred.email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(400, "Email inválido")
    salt = secrets.token_bytes(16)
    user = User(id=uuid.uuid4().hex[:12], email=email, name=(cred.name or email.split("@")[0]).strip())
    try:
        with _db() as c:
            first = c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
            c.execute("INSERT INTO users (id, email, name, pw_hash, salt, created, verified, terms_accepted_at, terms_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (user.id, user.email, user.name, _hash(cred.password, salt), salt, time.time(), 0 if VERIFY_EMAIL else 1, time.time(), TERMS_VERSION))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Ya existe una cuenta con ese email")
    if first:  # adopt sessions recorded before accounts existed
        for f in DATA_DIR.glob("*.json"):
            f.rename(user_dir(user.id) / f.name)
    if not VERIFY_EMAIL:
        from . import mailer

        mailer.account_created(user.name, user.email)
        return _issue(user.id), user, None
    return None, user, send_code(email)


def _count_wrong_code(table: str, key: str, value: str) -> None:
    """On its own connection: the check that called this is about to raise, which rolls back whatever it wrote on its own."""
    with _db() as c:
        c.execute(f"UPDATE {table} SET attempts = attempts + 1 WHERE {key} = ?", (value,))


def send_code(email: str) -> str | None:
    """Issues a fresh code for the email and sends it; returns the code itself only when no transport is configured."""
    from . import mailer

    with _db() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row:
            raise HTTPException(404, "No hay una cuenta con ese email")
        if row["verified"]:
            raise HTTPException(409, "Ese email ya está verificado")
        prev = c.execute("SELECT sent FROM email_codes WHERE email = ?", (email,)).fetchone()
        if prev and time.time() - prev["sent"] < 30:
            raise HTTPException(429, "Esperá medio minuto antes de pedir otro código")
        code = f"{secrets.randbelow(1_000_000):06d}"
        c.execute("INSERT OR REPLACE INTO email_codes VALUES (?, ?, ?, 0, ?)", (email, _token_hash(code), time.time() + CODE_TTL, time.time()))
        name = row["name"]
    if mailer.configured():
        subject, text, html = mailer.verification_email(name, code)
        if not mailer.send(email, subject, text, html):
            raise HTTPException(502, "No se pudo enviar el email de verificación; probá de nuevo en un momento")
        return None
    return code  # dev mode: no mail transport → the client shows it


def verify(email: str, code: str, lang: str = "es") -> tuple[str, User]:
    from . import mailer

    email = email.strip().lower()
    code = re.sub(r"\D", "", code or "")
    with _db() as c:
        row = c.execute("SELECT * FROM email_codes WHERE email = ?", (email,)).fetchone()
        if not row or row["expires"] < time.time():
            raise HTTPException(400, "El código venció: pedí uno nuevo")
        if row["attempts"] >= 6:
            raise HTTPException(429, "Demasiados intentos: pedí un código nuevo")
        if not hmac.compare_digest(_token_hash(code), row["code_hash"]):
            _count_wrong_code("email_codes", "email", email)
            raise HTTPException(400, "Código incorrecto")
        c.execute("UPDATE users SET verified = 1 WHERE email = ?", (email,))
        c.execute("DELETE FROM email_codes WHERE email = ?", (email,))
        u = c.execute("SELECT id, email, name FROM users WHERE email = ?", (email,)).fetchone()
    mailer.account_created(u["name"], u["email"], lang)  # the account exists from here on: the code was right, and it can only be used once
    return _issue(u["id"]), User(**dict(u))


def login(cred: Credentials) -> tuple[str, User]:
    with _db() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (cred.email.strip().lower(),)).fetchone()
    if not row or not hmac.compare_digest(_hash(cred.password, row["salt"]), row["pw_hash"]):
        raise HTTPException(401, "Email o contraseña incorrectos")
    if not row["verified"]:
        raise HTTPException(403, "email_unverified")
    return _issue(row["id"]), User(id=row["id"], email=row["email"], name=row["name"])


def profile(user_id: str) -> dict:
    with _db() as c:
        row = c.execute("SELECT id, email, name, phone FROM users WHERE id = ?", (user_id,)).fetchone()
        pending = c.execute("SELECT new_email FROM email_changes WHERE user_id = ? AND expires > ?", (user_id, time.time())).fetchone()
    if not row:
        raise HTTPException(404)
    return dict(row) | {"pending_email": pending["new_email"] if pending else None}


def update_profile(user_id: str, name: str, phone: str) -> dict:
    name, phone = name.strip(), phone.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Escribí tu nombre (hasta 80 letras)")
    if phone and not (re.fullmatch(r"\+?[\d\s().-]{6,30}", phone) and sum(ch.isdigit() for ch in phone) >= 6):
        raise HTTPException(400, "Ese teléfono no parece válido")
    with _db() as c:
        c.execute("UPDATE users SET name = ?, phone = ? WHERE id = ?", (name, phone, user_id))
    return profile(user_id)


def check_password(user_id: str, password: str) -> None:
    with _db() as c:
        row = c.execute("SELECT pw_hash, salt FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row or not hmac.compare_digest(_hash(password, row["salt"]), row["pw_hash"]):
        raise HTTPException(400, "La contraseña no es correcta")  # not 401: the site reads that as an expired session and signs out


def _other_sessions_out(user_id: str, keep_token: str | None) -> None:
    with _db() as c:
        c.execute("DELETE FROM tokens WHERE user_id = ? AND token_hash != ?", (user_id, _token_hash(keep_token or "")))


def start_email_change(user: User, new_email: str, password: str) -> str | None:
    """Asks for the password and proves the new address with a code; the account keeps its email until then.
    Returns the code only when no mail transport is configured, like the signup."""
    from . import mailer

    check_password(user.id, password)
    email = new_email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 200:
        raise HTTPException(400, "Email inválido")
    if email == user.email:
        raise HTTPException(400, "Ese ya es tu email")
    with _db() as c:
        if c.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "Ya existe una cuenta con ese email")
        prev = c.execute("SELECT sent FROM email_changes WHERE user_id = ?", (user.id,)).fetchone()
        if prev and time.time() - prev["sent"] < 30:
            raise HTTPException(429, "Esperá medio minuto antes de pedir otro código")
        code = f"{secrets.randbelow(1_000_000):06d}"
        c.execute("INSERT OR REPLACE INTO email_changes VALUES (?, ?, ?, ?, 0, ?)", (user.id, email, _token_hash(code), time.time() + CODE_TTL, time.time()))
    if mailer.configured():
        subject, text, html = mailer.verification_email(user.name, code)
        if not mailer.send(email, subject, text, html):
            raise HTTPException(502, "No se pudo enviar el código; probá de nuevo en un momento")
        return None
    return code


def confirm_email_change(user: User, code: str, keep_token: str | None) -> dict:
    """The new address proved itself: the account moves there, the old address hears about it and other sessions end."""
    from . import mailer

    code = re.sub(r"\D", "", code or "")
    with _db() as c:
        row = c.execute("SELECT * FROM email_changes WHERE user_id = ?", (user.id,)).fetchone()
        if not row or row["expires"] < time.time():
            raise HTTPException(400, "El código venció: pedí uno nuevo")
        if row["attempts"] >= 6:
            raise HTTPException(429, "Demasiados intentos: pedí un código nuevo")
        if not hmac.compare_digest(_token_hash(code), row["code_hash"]):
            _count_wrong_code("email_changes", "user_id", user.id)
            raise HTTPException(400, "Código incorrecto")
        try:
            c.execute("UPDATE users SET email = ? WHERE id = ?", (row["new_email"], user.id))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Ya existe una cuenta con ese email")
        c.execute("DELETE FROM email_changes WHERE user_id = ?", (user.id,))
    _other_sessions_out(user.id, keep_token)
    if mailer.configured():
        mailer.send(user.email, "Cambiaste el email de tu cuenta de Muse Team", f"Hola {user.name},\n\nEl email de tu cuenta ahora es {row['new_email']}. Si no fuiste vos, respondé a soporte@tablyteam.com.", reply_to="soporte@tablyteam.com")
    return profile(user.id)


def cancel_email_change(user_id: str) -> None:
    with _db() as c:
        c.execute("DELETE FROM email_changes WHERE user_id = ?", (user_id,))


def change_password(user: User, current: str, new: str, keep_token: str | None) -> None:
    check_password(user.id, current)
    if not 8 <= len(new) <= 200:
        raise HTTPException(400, "La contraseña nueva necesita al menos 8 caracteres")
    salt = secrets.token_bytes(16)
    with _db() as c:
        c.execute("UPDATE users SET pw_hash = ?, salt = ? WHERE id = ?", (_hash(new, salt), salt, user.id))
    _other_sessions_out(user.id, keep_token)


def start_password_reset(email: str) -> str | None:
    """A code to the registered email. It answers the same whether the account exists or not, so nobody can probe who has
    one; the code only comes back when no mail transport is configured, like the signup."""
    from . import mailer

    email = email.strip().lower()
    with _db() as c:
        row = c.execute("SELECT name FROM users WHERE email = ?", (email,)).fetchone()
        prev = c.execute("SELECT sent FROM password_resets WHERE email = ?", (email,)).fetchone()
        if not row or (prev and time.time() - prev["sent"] < 30):
            return None
        code = f"{secrets.randbelow(1_000_000):06d}"
        c.execute("INSERT OR REPLACE INTO password_resets VALUES (?, ?, ?, 0, ?)", (email, _token_hash(code), time.time() + CODE_TTL, time.time()))
        name = row["name"]
    if not mailer.configured():
        return code
    mailer.send(email, *mailer.password_reset_email(name, code))
    return None


def check_password_reset(email: str, code: str) -> None:
    """Raises unless the code is the right one; a wrong try counts, and six of them end it."""
    email, code = email.strip().lower(), re.sub(r"\D", "", code or "")
    with _db() as c:
        row = c.execute("SELECT * FROM password_resets WHERE email = ?", (email,)).fetchone()
        if not row or row["expires"] < time.time():
            raise HTTPException(400, "El código venció: pedí uno nuevo")
        if row["attempts"] >= 6:
            raise HTTPException(429, "Demasiados intentos: pedí un código nuevo")
        if not hmac.compare_digest(_token_hash(code), row["code_hash"]):
            _count_wrong_code("password_resets", "email", email)
            raise HTTPException(400, "Código incorrecto")


def finish_password_reset(email: str, code: str, password: str) -> tuple[str, User]:
    """The new password replaces the old one and every open session ends. The code came to that inbox, so the email counts as verified."""
    check_password_reset(email, code)
    if not 8 <= len(password) <= 200:
        raise HTTPException(400, "La contraseña nueva necesita al menos 8 caracteres")
    email = email.strip().lower()
    salt = secrets.token_bytes(16)
    with _db() as c:
        c.execute("UPDATE users SET pw_hash = ?, salt = ?, verified = 1 WHERE email = ?", (_hash(password, salt), salt, email))
        c.execute("DELETE FROM password_resets WHERE email = ?", (email,))
        row = c.execute("SELECT id, email, name FROM users WHERE email = ?", (email,)).fetchone()
        c.execute("DELETE FROM tokens WHERE user_id = ?", (row["id"],))
    return _issue(row["id"]), User(**dict(row))


def logout(token: str) -> None:
    with _db() as c:
        c.execute("DELETE FROM tokens WHERE token_hash = ?", (_token_hash(token),))


def user_from_token(token: str | None) -> User | None:
    if not token:
        return None
    with _db() as c:
        row = c.execute(
            "SELECT u.id, u.email, u.name FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.expires > ?",
            (_token_hash(token), time.time()),
        ).fetchone()
    return User(**dict(row)) if row else None


def bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    return h[7:] if h.lower().startswith("bearer ") else None


def current_user(request: Request) -> User:
    user = user_from_token(bearer(request))
    if not user:
        raise HTTPException(401, "Iniciá sesión")
    return user


CurrentUser = Depends(current_user)
