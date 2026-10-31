import asyncio
import json
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx

from app import ads, meta_ads


def _build(brief: str = "", title: str = "Turnera Luna"):
    return SimpleNamespace(title=title, brief=brief, files={}, tx=lambda es, en: es)


def test_palette_keeps_only_readable_colours():
    p = ads.palette({"bg": "#101010", "ink": "#202020", "accent": "#111111", "accent_ink": "#121212"})
    assert ads.contrast(p["ink"], p["bg"]) >= 7
    assert ads.contrast(p["accentInk"], p["accent"]) >= 4.5
    assert ads.contrast(p["accent"], p["bg"]) >= 2.2
    assert ads.palette("nonsense")["bg"] == ads.DEFAULT_PALETTE["bg"]


def test_clean_bounds_the_script_and_the_meta_copy():
    shots = [{"kind": "phone"}, {"kind": "desktop"}]
    s = ads.clean({"hook": "Reservá sin llamar", "emphasis": "no está en el gancho", "points": ["a", "b", "c", "d"], "captions": ["uno"],
                   "cta_type": "BUY_A_HOUSE", "font": "comic", "headline": "x" * 80}, _build(), shots, "https://x.tably.app")
    assert s["emphasis"] == ""  # only words that are in the hook get highlighted
    assert len(s["points"]) == 3 and len(s["captions"]) == 2 and s["captions"][1]
    assert s["cta_type"] == "LEARN_MORE" and s["font"] == "grotesk" and len(s["headline"]) <= 40
    assert s["link"] == "https://x.tably.app"


def test_plain_script_skips_markdown_noise():
    brief = "<!-- x -->\n# Turnera\n## 1. Objetivo\nUn turnero online para estudios de uñas.\nMétrica **(supuesto)**: 5 usuarias.\n| a | b |\n|---|---|\n- [ ] Reservas online\n- Seña con Mercado Pago\n"
    p = ads._plain(_build(brief), [])
    assert p["hook"] == "Turnera Luna"
    assert p["sub"] == "Un turnero online para estudios de uñas."
    assert p["points"] == ["Reservas online", "Seña con Mercado Pago"]


def test_file_names_are_whitelisted():
    assert ads.file_for("u", "b", "../../etc", "vertical.mp4") is None
    assert ads.file_for("u", "b", "abcdefabcdef", "../ads.json") is None


def test_publish_creates_everything_paused(tmp_path, monkeypatch):
    for f in ("vertical", "square"):
        (tmp_path / f"{f}.mp4").write_bytes(b"mp4")
        (tmp_path / f"{f}.jpg").write_bytes(b"jpg")
    calls: list[tuple[str, dict]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path.split("/", 2)[-1]
        if req.method == "GET":
            return httpx.Response(200, json={"status": {"video_status": "ready"}})
        body = req.content.decode("latin-1")
        form = {k: v[0] for k, v in parse_qs(body).items()} if req.headers.get("content-type", "").startswith("application/x-www-form-urlencoded") else {}
        calls.append((path, form))
        if path.endswith("/advideos"):
            return httpx.Response(200, json={"id": f"vid{len(calls)}"})
        if path.endswith("/adimages"):
            return httpx.Response(200, json={"images": {"x.jpg": {"hash": f"h{len(calls)}"}}})
        return httpx.Response(200, json={"id": f"{path.rsplit('/', 1)[-1]}{len(calls)}"})

    real = httpx.AsyncClient
    monkeypatch.setattr(meta_ads.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(meta_ads, "_token", lambda uid: "tok")
    monkeypatch.setattr(meta_ads.asyncio, "sleep", lambda s: asyncio.sleep(0))
    ad = {"script": {"name": "Turnera", "angle": "Sin llamadas", "headline": "Reservá online", "primary_text": "Tus clientas reservan solas",
                     "description": "", "cta_type": "BOOK_NOW", "link": "https://turnera.tably.app"}}
    steps: list[str] = []
    res = asyncio.run(meta_ads.publish("u", ad, tmp_path, {"account_id": "act_123", "page_id": "p1", "daily_budget": 12.5, "currency": "ARS",
                                                          "countries": ["AR"], "age_min": 21, "days": 7}, steps.append))
    paths = [p for p, _ in calls]
    assert paths.count("act_123/advideos") == 2 and paths.count("act_123/adcreatives") == 2 and paths.count("act_123/ads") == 2
    camp = dict(calls)["act_123/campaigns"]
    adset = dict(calls)["act_123/adsets"]
    assert camp["status"] == "PAUSED" and camp["objective"] == "OUTCOME_TRAFFIC" and camp["special_ad_categories"] == "[]"
    assert adset["status"] == "PAUSED" and adset["daily_budget"] == "1250" and json.loads(adset["targeting"])["geo_locations"]["countries"] == ["AR"]
    creative = json.loads([f for p, f in calls if p == "act_123/adcreatives"][0]["object_story_spec"])
    assert creative["page_id"] == "p1" and creative["video_data"]["call_to_action"] == {"type": "BOOK_NOW", "value": {"link": "https://turnera.tably.app"}}
    assert all(f["status"] == "PAUSED" for p, f in calls if p == "act_123/ads")
    assert res["account_id"] == "123" and "act=123" in res["manager_url"] and len(res["ad_ids"]) == 2
    assert steps and meta_ads.budget_units(5000, "CLP") == 5000
