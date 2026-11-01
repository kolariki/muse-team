"""The digital twin (HeyGen) and generated ads: the plan keeps stock shots over the voice, and HeyGen's answers are read right."""
import asyncio
import json

import httpx

from app import studio, twin
from app.auth import User


def test_plan_keeps_a_stock_shot_over_the_voice():
    proj = {"title": "X", "media": [{"id": "m1", "kind": "video", "duration": 20, "width": 1080, "height": 1920, "audio": True},
                                    {"id": "m2", "kind": "video", "duration": 8, "width": 1080, "height": 1920, "audio": False}]}
    plan = studio.clean_plan({"sequence": [{"type": "video", "media": "m1", "from": 0, "to": 3},
                                           {"type": "video", "media": "m1", "from": 3, "to": 6, "cover": "m2", "cover_from": 7.5},
                                           {"type": "video", "media": "m1", "from": 6, "to": 9, "cover": "m1"}]}, proj)
    seq = plan["sequence"]
    assert "cover" not in seq[0] and "cover" not in seq[2]  # a clip cannot cover itself
    assert seq[1]["cover"] == "m2" and seq[1]["cover_from"] == 5.0  # the shot is long enough for the span
    clips = studio.props(proj, plan, "vertical")["clips"]
    assert clips[1]["cover"] == {"src": "media:m2.mp4", "from": 5.0} and "cover" not in clips[0]


def _fake_heygen(monkeypatch, calls):
    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.path, req.headers.get("x-api-key")))
        p = req.url.path
        if p == "/v3/assets/direct-uploads":
            return httpx.Response(200, json={"data": {"asset_id": "as1", "upload_url": "https://upload.test/put", "upload_headers": {"x-up": "1"}}})
        if p == "/put":
            return httpx.Response(200)
        if p == "/v3/assets/as1/complete":
            return httpx.Response(200, json={"data": {"asset_id": "as1"}})
        if p == "/v3/avatars" and req.method == "POST":
            body = json.loads(req.content)
            assert body["type"] == "digital_twin" and body["file"] == {"type": "asset_id", "asset_id": "as1"}
            return httpx.Response(200, json={"data": {"avatar_item": {"id": "look1", "default_voice_id": "v1"}, "avatar_group": {"id": "g1"}}})
        if p == "/v3/avatars/g1/consent":
            return httpx.Response(200, json={"data": {"url": "https://heygen.test/consent", "consent_status": "pending"}})
        if p == "/v3/avatars/looks/look1":
            return httpx.Response(200, json={"data": {"id": "look1", "status": "completed"}})
        if p == "/v3/avatars/g1":
            return httpx.Response(200, json={"data": {"avatar_group": {"id": "g1", "consent_status": "accepted", "default_voice_id": "v1"}}})
        if p == "/v3/videos" and req.method == "POST":
            body = json.loads(req.content)
            assert body["avatar_id"] == "look1" and body["voice_id"] == "v1" and body["aspect_ratio"] == "9:16"
            return httpx.Response(200, json={"data": {"video_id": "vid1", "status": "pending"}})
        if p == "/v3/videos/vid1":
            return httpx.Response(200, json={"data": {"status": "completed", "video_url": "https://cdn.test/v.mp4"}})
        if p == "/v.mp4":
            return httpx.Response(200, content=b"MP4DATA")
        return httpx.Response(404, json={"error": {"message": f"no route {p}"}})

    real = httpx.AsyncClient
    monkeypatch.setattr(twin.httpx, "AsyncClient", lambda *a, **k: real(*a, **{**k, "transport": httpx.MockTransport(handler)}))


def test_twin_is_made_trained_and_renders(monkeypatch, tmp_path):
    calls: list = []
    _fake_heygen(monkeypatch, calls)
    uid = "twintest0001"
    user = User(id=uid, email="t@example.com", name="T")
    monkeypatch.setattr(twin.keystore, "get_key", lambda u, n: "hg-key" if n == "heygen" else None)
    monkeypatch.setattr(twin.media, "probe", lambda p: {"duration": 120.0, "width": 1920, "height": 1080, "audio": True})
    raw = tmp_path / "work" / "footage.mp4"
    raw.parent.mkdir()
    raw.write_bytes(b"x" * 1000)
    try:
        twin._set(uid, status="uploading", name="Yo")
        asyncio.run(twin._make(user, raw))
        t = twin.get(uid)
        assert t["status"] == "training" and t["look_id"] == "look1" and t["group_id"] == "g1" and t["voice_id"] == "v1"
        assert t["consent_url"] == "https://heygen.test/consent" and not raw.exists()  # the footage is only on HeyGen
        asyncio.run(twin.refresh(uid))
        assert twin.get(uid)["status"] == "ready"
        vid = asyncio.run(twin.render_talk(uid, "Hola, soy yo hablando de mi negocio.", "Prueba"))
        out = asyncio.run(twin.wait_talk(uid, vid, tmp_path / "t.mp4"))
        assert out.read_bytes() == b"MP4DATA"
        assert all(k == "hg-key" for m, path, k in calls if path.startswith("/v3"))
    finally:
        twin.forget(uid)


def test_heygen_errors_read_plainly():
    try:
        twin._check(httpx.Response(401, json={"error": {"message": "invalid key"}}))
    except twin.TwinError as e:
        assert "no aceptó la clave" in str(e)
    else:
        raise AssertionError("expected an error")
