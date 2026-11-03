import uuid

from fastapi.testclient import TestClient

from app import mailer, main
from app.main import app

client = TestClient(app)


def _account(monkeypatch):
    monkeypatch.setattr(mailer, "configured", lambda: False)
    monkeypatch.setattr(main, "_rate_limit", lambda *a, **k: None)
    email = f"p{uuid.uuid4().hex[:8]}@example.test"
    r = client.post("/api/auth/register", json={"accepted_terms": True, "email": email, "password": "clave-vieja-1", "name": "Ana"}).json()
    token = client.post("/api/auth/verify", json={"email": email, "code": r["dev_code"]}).json()["token"]
    return email, {"authorization": f"Bearer {token}"}


def test_name_and_phone(monkeypatch):
    email, h = _account(monkeypatch)
    r = client.patch("/api/auth/profile", headers=h, json={"name": " Ana María ", "phone": "+54 9 11 5555-5555"})
    assert r.status_code == 200 and r.json()["name"] == "Ana María" and r.json()["phone"] == "+54 9 11 5555-5555"
    assert client.get("/api/auth/me", headers=h).json()["user"]["name"] == "Ana María"
    assert client.patch("/api/auth/profile", headers=h, json={"name": "", "phone": ""}).status_code == 400
    assert client.patch("/api/auth/profile", headers=h, json={"name": "Ana", "phone": "llamame"}).status_code == 400
    assert client.patch("/api/auth/profile", headers=h, json={"name": "Ana", "phone": ""}).json()["phone"] == ""


def test_email_changes_only_with_password_and_code(monkeypatch):
    email, h = _account(monkeypatch)
    new = f"n{uuid.uuid4().hex[:8]}@example.test"
    assert client.post("/api/auth/email", headers=h, json={"email": new, "password": "mal"}).status_code == 400
    r = client.post("/api/auth/email", headers=h, json={"email": new, "password": "clave-vieja-1"}).json()
    assert client.get("/api/auth/profile", headers=h).json() | {"email": email, "pending_email": new} == client.get("/api/auth/profile", headers=h).json()
    bad = "000000" if r["dev_code"] != "000000" else "111111"
    assert client.post("/api/auth/email/confirm", headers=h, json={"code": bad}).status_code == 400
    p = client.post("/api/auth/email/confirm", headers=h, json={"code": r["dev_code"]}).json()
    assert p["email"] == new and p["pending_email"] is None
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-vieja-1"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": new, "password": "clave-vieja-1"}).status_code == 200


def test_email_of_another_account_is_refused(monkeypatch):
    other, _ = _account(monkeypatch)
    _, h = _account(monkeypatch)
    assert client.post("/api/auth/email", headers=h, json={"email": other, "password": "clave-vieja-1"}).status_code == 409


def test_email_change_can_be_cancelled(monkeypatch):
    email, h = _account(monkeypatch)
    r = client.post("/api/auth/email", headers=h, json={"email": f"c{uuid.uuid4().hex[:8]}@example.test", "password": "clave-vieja-1"}).json()
    assert client.delete("/api/auth/email", headers=h).status_code == 200
    assert client.post("/api/auth/email/confirm", headers=h, json={"code": r["dev_code"]}).status_code == 400
    assert client.get("/api/auth/profile", headers=h).json()["email"] == email


def test_password_change_closes_other_sessions(monkeypatch):
    email, h = _account(monkeypatch)
    other = {"authorization": f"Bearer {client.post('/api/auth/login', json={'email': email, 'password': 'clave-vieja-1'}).json()['token']}"}
    assert client.post("/api/auth/password", headers=h, json={"current": "mal", "new": "clave-nueva-1"}).status_code == 400
    assert client.post("/api/auth/password", headers=h, json={"current": "clave-vieja-1", "new": "corta"}).status_code == 400
    assert client.post("/api/auth/password", headers=h, json={"current": "clave-vieja-1", "new": "clave-nueva-1"}).status_code == 200
    assert client.get("/api/auth/me", headers=h).status_code == 200
    assert client.get("/api/auth/me", headers=other).status_code == 401
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-nueva-1"}).status_code == 200
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-vieja-1"}).status_code == 401


def test_forgotten_password_needs_the_code_from_the_email(monkeypatch):
    email, h = _account(monkeypatch)
    code = client.post("/api/auth/forgot", json={"email": email.upper()}).json()["dev_code"]
    bad = "000000" if code != "000000" else "111111"
    assert client.post("/api/auth/forgot/check", json={"email": email, "code": bad}).status_code == 400
    assert client.post("/api/auth/forgot/reset", json={"email": email, "code": bad, "password": "clave-nueva-1"}).status_code == 400
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-vieja-1"}).status_code == 200
    assert client.post("/api/auth/forgot/check", json={"email": email, "code": code}).status_code == 200
    assert client.post("/api/auth/forgot/reset", json={"email": email, "code": code, "password": "corta"}).status_code == 400
    r = client.post("/api/auth/forgot/reset", json={"email": email, "code": code, "password": "clave-nueva-1"})
    assert r.status_code == 200 and r.json()["user"]["email"] == email
    assert client.get("/api/auth/me", headers={"authorization": f"Bearer {r.json()['token']}"}).status_code == 200
    assert client.get("/api/auth/me", headers=h).status_code == 401  # old sessions end
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-vieja-1"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-nueva-1"}).status_code == 200
    assert client.post("/api/auth/forgot/reset", json={"email": email, "code": code, "password": "otra-clave-22"}).status_code == 400  # one use


def test_forgot_answers_the_same_for_an_unknown_email(monkeypatch):
    _account(monkeypatch)
    r = client.post("/api/auth/forgot", json={"email": "nadie@example.test"})
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_too_many_wrong_codes_end_the_reset(monkeypatch):
    email, _ = _account(monkeypatch)
    code = client.post("/api/auth/forgot", json={"email": email}).json()["dev_code"]
    bad = "000000" if code != "000000" else "111111"
    for _i in range(6):
        client.post("/api/auth/forgot/check", json={"email": email, "code": bad})
    assert client.post("/api/auth/forgot/check", json={"email": email, "code": code}).status_code == 429


def test_too_many_wrong_codes_end_the_signup_and_the_email_change(monkeypatch):
    monkeypatch.setattr(mailer, "configured", lambda: False)
    monkeypatch.setattr(main, "_rate_limit", lambda *a, **k: None)
    email = f"s{uuid.uuid4().hex[:8]}@example.test"
    code = client.post("/api/auth/register", json={"accepted_terms": True, "email": email, "password": "clave-vieja-1"}).json()["dev_code"]
    bad = "000000" if code != "000000" else "111111"
    for _i in range(6):
        client.post("/api/auth/verify", json={"email": email, "code": bad})
    assert client.post("/api/auth/verify", json={"email": email, "code": code}).status_code == 429

    _, h = _account(monkeypatch)
    code = client.post("/api/auth/email", headers=h, json={"email": f"m{uuid.uuid4().hex[:8]}@example.test", "password": "clave-vieja-1"}).json()["dev_code"]
    bad = "000000" if code != "000000" else "111111"
    for _i in range(6):
        client.post("/api/auth/email/confirm", headers=h, json={"code": bad})
    assert client.post("/api/auth/email/confirm", headers=h, json={"code": code}).status_code == 429


def _delete_setup(monkeypatch):
    import json
    import time

    from app import fde
    from app.auth import DATA_DIR, user_dir

    email, h = _account(monkeypatch)
    monkeypatch.setenv("TABLY_ADMIN_EMAILS", "otro-admin@example.test")
    uid = client.get("/api/auth/me", headers=h).json()["user"]["id"]
    (user_dir(uid) / "proyecto.json").write_text("{}")
    from app.account import BUILD_ROOT, CLAUDE_HOMES, GIT_ROOT

    for root in (BUILD_ROOT, GIT_ROOT, CLAUDE_HOMES):
        (root / uid).mkdir(parents=True, exist_ok=True)
        (root / uid / "archivo").write_text("x")
    now = time.time()
    with fde._db() as c:
        c.execute("INSERT OR REPLACE INTO user_providers (user_id, provider, enc_key, updated) VALUES (?, 'openai', ?, ?)", (uid, b"x", now))
        c.execute("INSERT OR REPLACE INTO analytics_sites (slug, user_id, title, created, updated) VALUES (?, ?, 'App', ?, ?)", (f"s{uid}", uid, now, now))
        c.execute("INSERT INTO analytics_hits (site, ts, kind) VALUES (?, ?, 'view')", (f"s{uid}", now))
        ticket = json.dumps({"contact": email})
        for rid, paid in (("impago", None), ("pagado", now)):
            c.execute("INSERT OR REPLACE INTO fde_requests (id,user_id,session_id,build_id,package,status,notes,contact,ticket,created,updated,paid_at) VALUES (?,?,'s','b','review','new','nota',?,?,?,?,?)", (rid + uid, uid, email, ticket, now, now, paid))
    return email, h, uid, DATA_DIR, fde


def test_deleting_the_account_leaves_nothing_but_the_paid_record(monkeypatch):
    email, h, uid, data_dir, fde = _delete_setup(monkeypatch)
    assert client.post("/api/account/check-password", headers=h, json={"password": "mal"}).json() == {"ok": False}
    assert client.post("/api/account/check-password", headers=h, json={"password": "clave-vieja-1"}).json() == {"ok": True}
    assert client.post("/api/account/delete", headers=h, json={"password": "mal"}).status_code == 400
    assert client.get("/api/auth/me", headers=h).status_code == 200
    assert client.post("/api/account/delete", headers=h, json={"password": "clave-vieja-1"}).status_code == 200
    assert client.get("/api/auth/me", headers=h).status_code == 401
    assert client.post("/api/auth/login", json={"email": email, "password": "clave-vieja-1"}).status_code == 401
    from app.account import BUILD_ROOT, CLAUDE_HOMES, GIT_ROOT

    for root in (data_dir, BUILD_ROOT, GIT_ROOT, CLAUDE_HOMES):
        assert not (root / uid).exists()
    with fde._db() as c:
        assert not c.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone()
        assert not c.execute("SELECT 1 FROM user_providers WHERE user_id = ?", (uid,)).fetchone()
        assert not c.execute("SELECT 1 FROM tokens WHERE user_id = ?", (uid,)).fetchone()
        assert not c.execute("SELECT 1 FROM analytics_hits WHERE site = ?", (f"s{uid}",)).fetchone()
        rows = [dict(r) for r in c.execute("SELECT id, notes, contact, ticket FROM fde_requests WHERE user_id = ?", (uid,))]
    assert rows == [{"id": "pagado" + uid, "notes": "", "contact": "", "ticket": "{}"}]
    assert client.post("/api/auth/register", json={"accepted_terms": True, "email": email, "password": "clave-nueva-11"}).status_code == 200  # the email is free again


def test_an_administrator_cannot_delete_their_account_by_accident(monkeypatch):
    email, h, *_ = _delete_setup(monkeypatch)
    monkeypatch.setenv("TABLY_ADMIN_EMAILS", email)
    assert client.post("/api/account/delete", headers=h, json={"password": "clave-vieja-1"}).status_code == 400
    assert client.get("/api/auth/me", headers=h).status_code == 200


def test_the_visitor_address_is_read_from_the_proxy_only_on_railway(monkeypatch):
    from types import SimpleNamespace

    request = SimpleNamespace(headers={"x-real-ip": "203.0.113.9"}, client=SimpleNamespace(host="10.0.0.1"))
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.delenv("RAILWAY_PROJECT_ID", raising=False)
    assert main._client_ip(request) == "10.0.0.1"
    monkeypatch.setenv("RAILWAY_PROJECT_ID", "p")
    assert main._client_ip(request) == "203.0.113.9"


def test_signup_needs_the_terms_accepted_and_records_them(monkeypatch):
    from app import auth

    monkeypatch.setattr(mailer, "configured", lambda: False)
    monkeypatch.setattr(main, "_rate_limit", lambda *a, **k: None)
    email = f"t{uuid.uuid4().hex[:8]}@example.test"
    assert client.post("/api/auth/register", json={"email": email, "password": "clave-vieja-1"}).status_code == 400
    assert client.post("/api/auth/register", json={"email": email, "password": "clave-vieja-1", "accepted_terms": False}).status_code == 400
    assert client.post("/api/auth/register", json={"email": email, "password": "clave-vieja-1", "accepted_terms": True}).status_code == 200
    with auth._db() as c:
        row = c.execute("SELECT terms_accepted_at, terms_version FROM users WHERE email = ?", (email,)).fetchone()
    assert row["terms_accepted_at"] and row["terms_version"] == auth.TERMS_VERSION


def test_legal_pages_are_public_and_complete():
    for path, title in (("/privacidad", "Política de privacidad de Muse Team"), ("/terminos", "Términos y condiciones de Muse Team")):
        r = client.get(path)
        assert r.status_code == 200 and title in r.text and "THE ELEVUM GROUP" in r.text and "COMPLETAR" not in r.text
    assert "Política de privacidad" in client.get("/api/content/legal/privacidad").json()["html"]
    assert client.get("/api/content/legal/otra").status_code == 404

