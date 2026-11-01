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
    assert fy._looks_like_ad({"duration": 30, "title": "Comercial Pizza Hut 2024"}) and not fy._looks_like_ad({"duration": 900, "title": "Comercial largo"})
