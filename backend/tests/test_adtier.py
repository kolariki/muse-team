from app import adtier


def test_score_alone_never_reaches_s():
    assert adtier.final_tier(None, 92) == ("A", "score")
    assert adtier.final_tier("S", 60) == ("S", "evidence")
    assert adtier.final_tier("B", 75) == ("A", "score")
    assert adtier.final_tier(None, 40) == ("C", "score")


def test_weighted_total_and_bands():
    assert adtier.total_of({"hook": 100, "structure": 100, "copy": 100, "visual": 100, "platform_fit": 100}) == 100
    assert adtier.total_of({"hook": 80, "structure": 60, "copy": 70, "visual": 90, "platform_fit": 50}) == 70.0
    assert [adtier.tier_from_score(x) for x in (85, 70, 55, 54)] == ["S", "A", "B", "C"]


def test_providers():
    assert adtier.provider("https://youtu.be/abc123") == ("youtube", "abc123")
    assert adtier.provider("https://www.youtube.com/shorts/xyz") == ("youtube", "xyz")
    assert adtier.provider("https://vimeo.com/123456789") == ("vimeo", "123456789")
    assert adtier.provider("https://www.tiktok.com/@marca/video/7300000000000000000") == ("tiktok", "7300000000000000000")
    assert adtier.provider("https://example.com/video.mp4") is None


def test_mcp_lists_tools():
    res = adtier.mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert {t["name"] for t in res["result"]["tools"]} == {"search_videos", "get_template", "list_tiers"}
    assert adtier.mcp({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_foryou_profile_and_score():
    from app import adtier_foryou as fy

    p = fy._clean({"sector": "food", "industries": ["Food Delivery"], "keywords": ["delivery", "pizza"], "formats": ["ugc", "nope"]}, {"country": "ar", "description": "pizzería"})
    assert p["country"] == "AR" and p["industries"] == ["food delivery"] and p["formats"] == ["ugc"] and p["queries"]
    near, why = fy.score(p, {"industry": "food delivery", "country": "AR", "language": "es", "format": "ugc", "title": "Pizza a domicilio", "tier": "A", "tags": {}})
    far, _ = fy.score(p, {"industry": "automotive", "country": "US", "language": "en", "format": "brand_spot", "title": "New truck", "tier": "S", "tags": {}})
    assert near > far and "de tu país" in why
    assert fy._looks_like_ad({"duration": 30, "title": "Comercial Pizza Hut 2024"}) and not fy._looks_like_ad({"duration": 90, "title": "Comercial largo"}) and fy._looks_like_ad({"duration": 90, "title": "Comercial largo"}, "long")


def test_foryou_short_pieces():
    from app import adtier_foryou as fy

    data = {"queries": ["comercial pizzería Argentina"], "keywords": ["pizza"], "country": "AR", "placement": "stories"}
    plan = fy._plan(data)
    assert plan[0] == "comercial pizza 15 segundos" and "comercial pizzería Argentina" in plan
    assert fy._looks_like_ad({"duration": 16, "title": "Pizza Hut Maestro Pizzero"}, "stories", ["pizza"])  # only the product in the title
    assert fy._looks_like_ad({"duration": 15, "title": "Specialty Pizzas - Hold Up :15"}, "stories")
    assert not fy._looks_like_ad({"duration": 45, "title": "Comercial pizza"}, "stories") and fy.fits(45, "reels")


def test_foryou_reference_accounts_and_ideas():
    from app import adtier_foryou as f

    assert f.parse_account("instagram.com/nike/reels/")["handle"] == "nike"
    assert f.parse_account("@pizzeria.don")["platform"] == "instagram"
    assert f.parse_account("https://www.tiktok.com/@natgeo")["platform"] == "tiktok"
    assert f.parse_account("https://www.facebook.com/cocacola")["platform"] == "facebook"
    assert f.parse_account("youtube.com/@mercadolibre")["platform"] == "youtube"
    assert f.parse_account("https://www.instagram.com/reel/abc/") is None  # a post, not an account
    raw = {"ideas": [{"title": "Uno", "duration_s": "999", "based_on": [1, 7, "x"], "beats": [{"t": "0-2 s", "shot": "plano"}], "hook": "h"}, {"no": "title"}]}
    out = f._clean_ideas(raw, 3)
    assert len(out) == 1 and out[0]["duration_s"] == 180 and out[0]["based_on"] == [1] and out[0]["beats"][0]["voice"] == ""


def test_foryou_upload_file_names_are_safe():
    from app import adtier_foryou as f

    assert f.upload_file("u", "p", "../../x", "thumb.jpg") is None
    assert f.upload_file("u", "p", "abcd1234", "../secret.jpg") is None
    assert f.upload_file("u", "p", "abcd1234", "thumb.jpg") is None  # does not exist


def test_foryou_find_reel_in_a_screen_recording(tmp_path):
    """A moving reel in the middle of a still page, paused 3 s before and 4 s after: the crop and the cut find it."""
    from app import adtier_foryou as f
    from app import media

    if not media.available():
        return
    v = tmp_path / "rec.mp4"
    media.run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0xF2F2F2:s=640x360:d=13", "-f", "lavfi", "-i", "testsrc2=s=150x266:d=6",
                         "-filter_complex", "[1:v]tpad=start_mode=clone:start_duration=3:stop_mode=clone:stop_duration=4[r];[0:v][r]overlay=245:45:shortest=1",
                         "-t", "13", "-pix_fmt", "yuv420p", str(v)])
    spot = f.find_reel(v)
    assert 2 <= spot["start"] <= 3.5 and 8.5 <= spot["end"] <= 10.5
    x, y, w, h = spot["crop"]
    assert abs(x - 245) <= 12 and abs(y - 45) <= 12 and abs(w - 150) <= 24 and abs(h - 266) <= 24
