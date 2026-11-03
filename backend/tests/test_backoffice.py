import json
import time

from fastapi.testclient import TestClient

from app import fde, main, mailer
from app.auth import current_user
from app.main import User

SECRET = b"never-show-this"


def _seed():
    with fde._db() as c:
        c.execute("INSERT OR REPLACE INTO users (id, email, name, pw_hash, salt, created, verified) VALUES ('bo_u','bo@example.test','Bo',?,?,?,1)", (SECRET, SECRET, time.time()))
        c.execute("INSERT OR REPLACE INTO user_providers (user_id, provider, enc_key, last4, updated) VALUES ('bo_u','openai',?,'9999',?)", (SECRET, time.time()))
        c.execute("INSERT OR REPLACE INTO user_connections (user_id, provider, account, enc_refresh, enc_access, created, updated) VALUES ('bo_u','google','bo@gmail.test',?,?,?,?)", (SECRET, SECRET, time.time(), time.time()))
        ticket = {"project": {"title": "Mi app", "session_id": "s", "build_id": "b", "files": 1, "status": "completed"}, "package": {"id": "hours", "name": "Horas", "price_usd": 75, "eta": ""}, "notes": "", "contact": "bo@example.test"}
        c.execute("INSERT OR REPLACE INTO fde_requests (id,user_id,session_id,build_id,package,status,notes,contact,ticket,created,updated) VALUES ('bo_r','bo_u','s','b','hours','new','Horas pedidas: 6','bo@example.test',?,?,?)", (json.dumps(ticket), time.time(), time.time()))


def _client(email, monkeypatch):
    monkeypatch.setenv("TABLY_ADMIN_EMAILS", "admin@example.test")
    main.app.dependency_overrides[current_user] = lambda: User(id="x", email=email, name="X")
    return TestClient(main.app)


def _done():
    main.app.dependency_overrides.pop(current_user, None)


def test_only_the_operator_gets_in(monkeypatch):
    c = _client("otro@example.test", monkeypatch)
    try:
        assert c.get("/api/admin/access").json() == {"admin": False}
        assert c.get("/api/admin/backoffice").status_code == 403
        assert c.patch("/api/admin/requests/bo_r", json={"status": "paid"}).status_code == 403
        assert c.get("/api/admin/requests/bo_r/ticket.md").status_code == 403
    finally:
        _done()


def test_snapshot_has_everything_and_no_secrets(monkeypatch):
    _seed()
    c = _client("admin@example.test", monkeypatch)
    try:
        r = c.get("/api/admin/backoffice")
    finally:
        _done()
    assert r.status_code == 200
    assert "never-show-this" not in r.text and "pw_hash" not in r.text and "enc_key" not in r.text and "9999" not in r.text
    d = r.json()
    me = next(u for u in d["users"] if u["id"] == "bo_u")
    assert me["connected"] == ["google", "openai"] and me["requests"] == 1
    req = next(x for x in d["requests"] if x["id"] == "bo_r")
    assert req["open"] and req["email"] == "bo@example.test" and req["amount_usd"] == 450 and req["project"] == "Mi app"
    assert {"Cuenta", "IA"} <= {a["kind"] for a in d["accounts"]}


def test_marking_paid_shows_in_payments_and_survives_later_steps(monkeypatch):
    _seed()
    c = _client("admin@example.test", monkeypatch)
    try:
        assert c.patch("/api/admin/requests/bo_r", json={"status": "inventado"}).status_code == 400
        assert c.patch("/api/admin/requests/bo_r", json={"status": "paid"}).status_code == 200
        assert c.patch("/api/admin/requests/bo_r", json={"status": "in_progress"}).status_code == 200
        d = c.get("/api/admin/backoffice").json()
        assert c.get("/api/admin/requests/bo_r/ticket.md").text.startswith("# Pedido FDE")
    finally:
        _done()
    assert next(x for x in d["requests"] if x["id"] == "bo_r")["status"] == "in_progress"
    assert next(p for p in d["payments"] if p["id"] == "bo_r")["amount_usd"] == 450


def test_email_log_keeps_verification_codes_out(monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("SMTP_HOST", raising=False)
    assert not mailer.send("a@example.test", "482913 es tu código de Tably Team", "cuerpo")
    last = mailer.mail_log(1)[0]
    assert last["to_addr"] == "a@example.test" and last["ok"] == 0
    assert "482913" not in last["subject"] and "código" in last["subject"]


def test_operator_replies_from_support_and_it_stays_on_the_ticket(monkeypatch):
    _seed()
    sent = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, text, html=None, **kw: sent.append((to, subject, text, html, kw)) or True)
    c = _client("admin@example.test", monkeypatch)
    try:
        assert c.post("/api/admin/requests/bo_r/reply", json={"text": "  "}).status_code == 400
        r = c.post("/api/admin/requests/bo_r/reply", json={"text": "Hola, ¿coordinamos? <b>"})
        d = c.get("/api/admin/backoffice").json()
    finally:
        _done()
    assert r.status_code == 200
    to, subject, text, html, kw = sent[0]
    assert to == "bo@example.test" and "bo_r" in subject and "Hola, ¿coordinamos?" in text and "&lt;b&gt;" in html
    assert kw == {"from_addr": "Tably Team <soporte@tablyteam.com>", "reply_to": "soporte@tablyteam.com"}
    assert next(x for x in d["requests"] if x["id"] == "bo_r")["messages"][-1]["text"] == "Hola, ¿coordinamos? <b>"


def test_failed_reply_is_reported_and_not_kept(monkeypatch):
    _seed()
    monkeypatch.setattr(mailer, "send", lambda *a, **k: False)
    c = _client("admin@example.test", monkeypatch)
    try:
        before = len(next(x for x in c.get("/api/admin/backoffice").json()["requests"] if x["id"] == "bo_r")["messages"])
        assert c.post("/api/admin/requests/bo_r/reply", json={"text": "hola"}).status_code == 502
        after = len(next(x for x in c.get("/api/admin/backoffice").json()["requests"] if x["id"] == "bo_r")["messages"])
    finally:
        _done()
    assert before == after


def test_only_the_operator_can_reply(monkeypatch):
    c = _client("otro@example.test", monkeypatch)
    try:
        assert c.post("/api/admin/requests/bo_r/reply", json={"text": "hola"}).status_code == 403
    finally:
        _done()


def test_meta_ads_is_coming_soon_except_for_admins_and_testers(monkeypatch):
    monkeypatch.setenv("META_ADS_OPEN", "false")
    monkeypatch.delenv("META_TESTER_EMAILS", raising=False)
    monkeypatch.setenv("TABLY_ADMIN_EMAILS", "admin@example.test")
    user = lambda email: User(id="x", email=email, name="X")
    assert not main._meta_open(user("cliente@example.test"))
    assert main._meta_open(user("admin@example.test"))
    monkeypatch.setenv("META_TESTER_EMAILS", "revisor@example.test, otro@example.test")
    assert main._meta_open(user("Revisor@example.test"))
    monkeypatch.setenv("META_ADS_OPEN", "true")
    assert main._meta_open(user("cliente@example.test"))
    monkeypatch.setenv("META_ADS_OPEN", "false")
    c = _client("cliente@example.test", monkeypatch)
    try:
        assert c.post("/api/meta-ads/start", json={}).status_code == 403
        assert c.get("/api/meta-ads/brain").json()["meta"]["open"] is False
    finally:
        _done()

