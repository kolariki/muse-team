import hashlib
import hmac
import json
import threading
import time

from app import fde, mailer


def _request(package="review", rid="fde_link_test"):
    with fde._db() as c:
        c.execute("DELETE FROM fde_requests WHERE id=?", (rid,))
        c.execute(
            "INSERT INTO fde_requests (id, user_id, session_id, build_id, package, status, ticket, created, updated) VALUES (?,?,?,?,?,?,?,?,?)",
            (rid, "u_link_test", "s", "b", package, "new", "{}", time.time(), time.time()),
        )
    return rid


def _status(rid):
    return fde.get_request("u_link_test", rid)["status"]


def test_full_price_marks_the_request_paid():
    rid = _request()
    assert fde.settle_link_payment(rid, 9900)
    assert _status(rid) == "paid"


def test_cheaper_link_with_this_reference_does_not_count():
    rid = _request()
    assert not fde.settle_link_payment(rid, 4900)
    assert _status(rid) == "new"


def test_hours_need_the_four_hour_minimum():
    rid = _request("hours")
    assert not fde.settle_link_payment(rid, 7500)
    assert fde.settle_link_payment(rid, 30000)


def test_unknown_reference_is_ignored():
    assert not fde.settle_link_payment("no_existe", 99900)


def test_paying_in_pesos_counts_the_usd_amount():
    current_api = {"currency": "usd", "amount_total": 9900, "presentment_details": {"presentment_amount": 191239, "presentment_currency": "mxn"}}
    older_api = {"currency": "mxn", "amount_total": 191239, "currency_conversion": {"source_currency": "usd", "amount_total": 9900}}
    assert fde.usd_cents(current_api) == 9900
    assert fde.usd_cents(older_api) == 9900


def test_a_cheaper_link_paid_in_pesos_does_not_count():
    rid = _request("launch")
    session = {"currency": "mxn", "amount_total": 94654, "currency_conversion": {"source_currency": "usd", "amount_total": 4900}}
    assert not fde.settle_link_payment(rid, fde.usd_cents(session))
    assert _status(rid) == "new"


def test_another_currency_without_the_usd_amount_does_not_count():
    assert fde.usd_cents({"currency": "mxn", "amount_total": 94654}) == 0


def test_packages_have_their_links_and_env_overrides(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    monkeypatch.delenv("FDE_CHECKOUT_URL_LAUNCH", raising=False)
    monkeypatch.delenv("FDE_CHECKOUT_URL_HOURS", raising=False)
    assert fde.links("hours")["checkout_url"] is None
    monkeypatch.setenv("FDE_CHECKOUT_URL_LAUNCH", "https://example.test/otro")
    assert fde.links("launch")["checkout_url"] == "https://example.test/otro"


def test_no_link_is_offered_until_stripe_can_confirm_the_payment(monkeypatch):
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    assert fde.links("launch")["checkout_url"] is None


def test_signed_webhook_settles_a_payment_link(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    rid = _request()
    body = json.dumps({"type": "checkout.session.completed", "data": {"object": {"id": "cs_1", "payment_link": "plink_1", "client_reference_id": rid, "payment_status": "paid", "currency": "usd", "amount_total": 9900}}}).encode()
    t = str(int(time.time()))
    sig = hmac.new(b"whsec_test", f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    r = TestClient(app).post("/api/billing/webhook", content=body, headers={"stripe-signature": f"t={t},v1={sig}"})
    assert r.status_code == 200
    assert _status(rid) == "paid"


def _sends(monkeypatch, accept=lambda kw: True):
    mails, done = [], threading.Event()

    def fake_send(to, subject, text, html=None, **kw):
        mails.append(dict(to=to, subject=subject, text=text, html=html, **kw))
        if len(mails) >= 2:
            done.set()
        return accept(kw)

    monkeypatch.setattr(mailer, "configured", lambda: True)
    monkeypatch.setattr(mailer, "send", fake_send)
    monkeypatch.setenv("FDE_NOTIFY_EMAIL", "equipo@example.test")
    monkeypatch.delenv("FDE_SUPPORT_EMAIL", raising=False)
    return mails, done


def test_ticket_goes_to_the_team_and_a_copy_to_the_client(monkeypatch):
    mails, done = _sends(monkeypatch)
    mailer.fde_requested("fde-1", "cuenta@example.test", "cliente@example.test", "Ana", "Puesta en producción", "Puesta en producción", "Mi app", "# Pedido\n- <bloqueante>", True)
    assert done.wait(3)
    team, client = mails
    assert team["to"] == "equipo@example.test" and team["reply_to"] == "cliente@example.test"
    assert team["from_addr"] == "Tably Team <soporte@tablyteam.com>"
    assert team["subject"].startswith("Pedido pagado fde-1") and "Puesta en producción" in team["subject"]
    assert "cuenta@example.test" in team["text"] and "Pago: confirmado" in team["text"] and "- <bloqueante>" in team["text"]
    assert "&lt;bloqueante&gt;" in team["html"]
    assert client["to"] == "cliente@example.test" and client["reply_to"] == "soporte@tablyteam.com"
    assert client["from_addr"] == "Tably Team <soporte@tablyteam.com>"
    assert "Hola Ana" in client["text"] and "soporte@tablyteam.com" in client["text"] and "- <bloqueante>" in client["text"]


def test_client_copy_speaks_english_when_the_request_was_made_in_english():
    subject, text, _ = mailer.fde_client_email("fde-1", "Ann", "Production launch", "My app", "ticket", False, "en")
    assert subject == "We received your request: Production launch"
    assert "Hi Ann" in text and "the scope, the payment and the start" in text


def test_ticket_still_goes_out_if_support_cannot_send(monkeypatch):
    mails, done = _sends(monkeypatch, accept=lambda kw: "from_addr" not in kw)
    mailer.fde_requested("fde-1", "c@example.test", "c@example.test", "Ana", "Paquete", "Paquete", "App", "ticket", False)
    assert done.wait(3)
    assert "from_addr" in mails[0] and "from_addr" not in mails[1] and mails[1]["reply_to"] == "c@example.test"


def test_resend_gets_the_sender_and_the_reply_address(monkeypatch):
    seen = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen.update(json)
        return type("R", (), {"status_code": 200, "text": ""})()

    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setattr(mailer.httpx, "post", fake_post)
    assert mailer.send("a@example.test", "s", "t", from_addr="Tably Team <soporte@tablyteam.com>", reply_to="b@example.test")
    assert seen["from"] == "Tably Team <soporte@tablyteam.com>" and seen["reply_to"] == "b@example.test"


def _create(monkeypatch, contact=""):
    """A request through the real endpoint, with the mail caught; returns the client's response and the mails sent."""
    monkeypatch.setenv("FDE_CHECKOUT_URL_REVIEW", "https://example.test/pagar")
    with fde._db() as c:
        c.execute("INSERT OR IGNORE INTO users (id, email, name, pw_hash, salt, created) VALUES (?,?,?,?,?,?)", ("u_link_test", "cliente@example.test", "Cliente", b"", b"", time.time()))
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from app import main
    from app.auth import current_user

    build = SimpleNamespace(
        id="b1", title="Mi app", brief="", files={}, workdir=None, status="completed", versions=[], reviews=[], deploys=[], app_run=None,
        chat=[], req=SimpleNamespace(session_id="s1"), _save=lambda: None,
    )
    sent = []
    monkeypatch.setattr(main, "_build_any", lambda *a: build)
    monkeypatch.setattr(main.deploymod, "services_for", lambda *a: {"missing": [], "groups": []})
    monkeypatch.setattr(main.deploymod, "load_secrets", lambda *a: {})
    monkeypatch.setattr(main.deploymod, "materialize", lambda *a: "/tmp")
    monkeypatch.setattr(main.runmod, "detect", lambda *a: [])
    monkeypatch.setattr(mailer, "fde_requested", lambda *a: sent.append(a))
    main.app.dependency_overrides[current_user] = lambda: SimpleNamespace(id="u_link_test", email="cliente@example.test", name="Cliente")
    try:
        r = TestClient(main.app).post("/api/fde/requests", json={"package": "review", "session_id": "s1", "build_id": "b1", "notes": "ayuda", "contact": contact})
    finally:
        main.app.dependency_overrides.pop(current_user, None)
    assert r.status_code == 200
    return r.json(), sent


def _signed_webhook(rid, secret="whsec_test", amount=9900):
    from fastapi.testclient import TestClient

    from app.main import app

    body = json.dumps({"type": "checkout.session.completed", "data": {"object": {"id": "cs_1", "payment_link": "plink_1", "client_reference_id": rid, "payment_status": "paid", "currency": "usd", "amount_total": amount}}}).encode()
    t = str(int(time.time()))
    sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return TestClient(app).post("/api/billing/webhook", content=body, headers={"stripe-signature": f"t={t},v1={sig}"})


def test_the_developer_hears_only_after_the_payment(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    req, sent = _create(monkeypatch)
    assert req["status"] == "pending_payment" and req["checkout_url"]
    assert sent == []

    assert _signed_webhook(req["id"]).status_code == 200
    assert _status(req["id"]) == "paid"
    rid, account, client, _name, package, _package_client, title, ticket, paid, _lang = sent[0]
    assert rid == req["id"] and account == client == "cliente@example.test" and package == "Revisión humana pre-lanzamiento" and title == "Mi app"
    assert "ayuda" in ticket and "Pedido FDE" in ticket and paid is True

    _signed_webhook(req["id"])  # Stripe can repeat its notice
    assert len(sent) == 1


def test_a_cheaper_payment_does_not_reach_the_developer(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    req, sent = _create(monkeypatch)
    _signed_webhook(req["id"], amount=4900)
    assert _status(req["id"]) == "pending_payment"
    assert sent == []


def test_checkout_payment_also_reaches_the_developer_once(monkeypatch):
    import asyncio

    from app import main

    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    req, sent = _create(monkeypatch)
    order = {"status": "paid", "kind": "fde", "user_id": "u_link_test", "ref": req["id"]}
    asyncio.run(main._settle(order))
    asyncio.run(main._settle(order))
    assert _status(req["id"]) == "paid"
    assert len(sent) == 1 and sent[0][8] is True


def test_without_online_payment_the_ticket_goes_out_right_away(monkeypatch):
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    req, sent = _create(monkeypatch)
    assert req["status"] == "new" and not req["checkout_url"]
    assert len(sent) == 1 and sent[0][8] is False


def test_paying_a_cancelled_request_still_counts(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    req, sent = _create(monkeypatch)
    fde.update_request("u_link_test", req["id"], status="cancelled")
    _signed_webhook(req["id"])
    assert _status(req["id"]) == "paid"
    assert len(sent) == 1


def test_client_copy_goes_to_the_contact_email_or_else_the_account(monkeypatch):
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    _, sent = _create(monkeypatch, contact="otra@example.test")
    assert sent[0][1] == "cliente@example.test" and sent[0][2] == "otra@example.test"
    _, sent = _create(monkeypatch, contact="+54 9 11 5555 5555")
    assert sent[0][2] == "cliente@example.test"
