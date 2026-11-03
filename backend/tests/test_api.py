import uuid
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
client.__enter__()  # runs the app lifespan (background job runner)


def _auth():
    email = f"t{uuid.uuid4().hex[:8]}@example.test"
    r = client.post("/api/auth/register", json={"accepted_terms": True, "email": email, "password": "password123"}).json()
    token = r.get("token") or client.post("/api/auth/verify", json={"email": email, "code": r["dev_code"]}).json()["token"]
    return {"authorization": f"Bearer {token}"}


def test_requires_auth():
    assert client.get("/api/sessions").status_code == 401


def test_health_and_security_headers():
    r = client.get("/api/health")
    assert r.status_code == 200 and r.headers["x-content-type-options"] == "nosniff"


def test_full_mock_flow_session_brief_build():
    h = _auth()
    cfg = {"topic": "app de prueba", "title": "Prueba", "max_turns": 2, "min_turns": 1, "pace_ms": 0, "final_vote": False, "closing_round": False,
           "agents": [{"id": "a", "name": "A", "role": "ceo", "provider": "mock", "model": "mock-1"}, {"id": "b", "name": "B", "role": "qa", "provider": "mock", "model": "mock-1"}]}
    assert client.post("/api/sessions/estimate", json=cfg, headers=h).status_code == 200
    sid = client.post("/api/sessions", json=cfg, headers=h).json()["id"]
    import time
    for _ in range(100):
        if not next(s for s in client.get("/api/sessions", headers=h).json() if s["id"] == sid)["live"]:
            break
        time.sleep(0.2)
    md = client.get(f"/api/sessions/{sid}/transcript.md", headers=h).text
    assert md.startswith("# Prueba")
    brief = client.post(f"/api/sessions/{sid}/brief", json={"provider": "mock", "model": "mock-1", "target": "claude-code", "include_transcript": False, "regenerate": False}, headers=h).text
    assert "Prompt para el agente constructor" in brief
    bid = client.post("/api/builds", json={"session_id": sid, "provider": "mock", "model": "mock-1", "target": "claude-code"}, headers=h).json()["id"]
    for _ in range(200):
        st = client.get(f"/api/sessions/{sid}/builds/{bid}", headers=h).json()["status"]
        if st in ("completed", "error", "stopped"):
            break
        if st == "design_review":  # the user approves the design before any code
            assert client.post(f"/api/builds/{bid}/design/approve", headers=h).status_code == 200
        time.sleep(0.2)
    assert st == "completed"
    svc = client.get(f"/api/sessions/{sid}/builds/{bid}/services", headers=h).json()
    assert "DATABASE_URL" in [i["var"] for i in svc["items"]]
    assert client.put(f"/api/sessions/{sid}/builds/{bid}/services", json={"values": {"DATABASE_URL": "postgres://x"}}, headers=h).json()["configured"] == ["DATABASE_URL"]
    assert client.get(f"/api/sessions/{sid}/builds/{bid}/zip", headers=h).headers["content-type"].startswith("application/zip")
    dash = client.get("/api/dashboard", headers=h).json()
    assert any(s["id"] == sid for s in dash["sessions"])
    assert client.patch(f"/api/sessions/{sid}", json={"title": "Renombrada"}, headers=h).status_code == 200
    assert client.delete(f"/api/sessions/{sid}", headers=h).status_code == 200
    assert client.get(f"/api/sessions/{sid}", headers=h).status_code == 404
