import asyncio

import pytest

from app.auth import User
from app.builder import Build, BuildRequest
from app.orchestrator import Session, estimate_cost
from app.providers import Cred
from app.schemas import SessionConfig

MOCK = Cred("mock", "", "mock-1", "server")
USER = User(id="t-user", email="t@test.local", name="t")


def _team():
    return [dict(id="ceo", role="ceo", name="CEO", provider="mock", model="mock-1"), dict(id="qa", role="qa", name="QA", provider="mock", model="mock-1")]


def test_arena_session_runs_closing_round_vote_and_judge():
    cfg = SessionConfig(topic="app de prueba", max_turns=3, min_turns=1, pace_ms=0, agents=_team())
    s = Session(cfg, USER, {"mock": MOCK})
    asyncio.run(s.run())
    types = [e["type"] for e in s.events]
    assert s.status == "completed"
    assert "closing.started" in types and "verdict" in types and "verdict.explained" in types
    assert any(t.get("phase") == "closing" for t in s.transcript)


def test_estimate_cost_is_positive_and_per_agent():
    cfg = SessionConfig(topic="x", max_turns=6, agents=_team())
    est = estimate_cost(cfg)
    assert est["total_usd"] >= 0 and set(est["per_agent"]) == {"ceo", "qa"}


@pytest.mark.parametrize("rounds", [0, 2])
def test_build_pipeline_with_optional_review(rounds):
    b = Build(USER, BuildRequest(session_id="s", provider="mock", model="mock-1", review_rounds=rounds, council=False, design_review=False), MOCK, "# brief", "Demo", _team(), {"mock": MOCK})
    asyncio.run(b.pipeline())
    assert b.preview_html is not None and "README.md" in b.files
    assert b.status == ("approved" if rounds else "completed")


def test_audit_then_apply_improvements():
    async def main():
        b = Build(USER, BuildRequest(session_id="s", provider="mock", model="mock-1", council=False, design_review=False), MOCK, "# audit", "MiApp", _team(), {"mock": MOCK})
        b.files = {"README.md": "# x\n"}
        b.status = "completed"
        await b.pipeline_audit()
        assert b.status == "audited" and b.audit_report and b.reviews[0]["mode"] == "audit"
        reqs = [{"role_label": r["role_label"], "name": r["name"], "text": r["requests"]} for r in b.reviews[0]["results"] if r["requests"]]
        b.apply_improvements(reqs, 2)
        await b.task
        assert b.status == "approved"

    asyncio.run(main())


def test_empty_history_messages_are_never_sent():
    b = Build(USER, BuildRequest(session_id="s", provider="mock", model="mock-1"), MOCK, "# brief", "Demo")
    b._push_history("", "   ")
    assert all(m["content"].strip() for m in b.history)


def test_rehydrate_keeps_the_same_workdir(tmp_path, monkeypatch):
    """A saved local-agent build must come back in ITS folder (not a fresh one with only BRIEF.md)."""
    from app import builder as bmod
    from app import local_engine

    monkeypatch.setattr(local_engine, "BUILD_ROOT", tmp_path / "builds")
    monkeypatch.setattr(bmod, "is_engine", lambda p: p == "claude-code")
    monkeypatch.setattr(local_engine, "is_engine", lambda p: p == "claude-code")
    sess_dir = bmod.user_dir(USER.id)
    sess_dir.mkdir(parents=True, exist_ok=True)
    (sess_dir / "s2.brief.claude-code.md").write_text("# brief\n" + "\n".join(f"## {i}. x" for i in range(1, 18)))
    b = Build(USER, BuildRequest(session_id="s2", provider="claude-code", model="default"), Cred("local", None, "default", "local"), "# brief", "Demo")
    assert b.workdir and b.workdir.name == b.id and (b.workdir / "BRIEF.md").exists()
    (b.workdir / "src").mkdir()
    (b.workdir / "src" / "app.py").write_text("print('hi')\n")
    b.files = {"src/app.py": "print('hi')\n"}
    b.engine_session = "sess-xyz"
    b.status = "stopped"
    b._save()
    before = sorted(p.name for p in (tmp_path / "builds" / USER.id).iterdir())
    r = bmod.rehydrate(USER, "s2", b.id, Cred("local", None, "default", "local"))
    assert r is not None and r.id == b.id and r.workdir == b.workdir
    assert r.engine_session == "sess-xyz" and "src/app.py" in r.files
    assert sorted(p.name for p in (tmp_path / "builds" / USER.id).iterdir()) == before  # no stray sibling folder
    bmod.BUILDS.pop(b.id, None)


def test_council_review_runs_in_the_arena_and_feeds_the_builder():
    """build → council session (mode review, same arena) → council.verdict with changes → apply → builder runs again."""
    from app import orchestrator as orch

    b = Build(USER, BuildRequest(session_id="s3", provider="mock", model="mock-1", review_rounds=1, council=True, design_review=False), MOCK, "# brief", "Demo", _team(), {"mock": MOCK})

    async def go():
        await b.pipeline()
        assert b.status == "completed" and len(b.council_sessions) == 1
        sid = b.council_sessions[0]
        s = orch.SESSIONS[sid]
        assert s.config.mode == "review" and s.config.review_of["build_id"] == b.id and s.config.context
        await s.task
        assert s.status == "completed"
        ev = next(e for e in s.events if e["type"] == "council.verdict")
        assert ev["changes"] and ev["approved"] is False and ev["review_of"]["build_id"] == b.id
        assert not any(e["type"] == "vote" for e in s.events)  # no popularity vote in a review
        # the user accepts the list → builder applies it (no further council: rounds exhausted)
        b.apply_council(ev["changes"], sid)
        await b.task
        assert b.status == "completed" and b.reviews[-1]["mode"] == "council" and len(b.council_sessions) == 1
        assert any(c["role"] == "user" and "CONSEJO" in c["text"] for c in b.chat)
        orch.SESSIONS.pop(sid, None)

    asyncio.run(go())


def test_versions_diffs_and_readiness():
    """v1 after the first build; the council scores it; applying its list yields v2 with a diff and a readiness %."""
    from app import orchestrator as orch

    from app.builder import BUILDS

    b = Build(USER, BuildRequest(session_id="s4", provider="mock", model="mock-1", review_rounds=2, council=True), MOCK, "# brief", "Demo", _team(), {"mock": MOCK})
    BUILDS[b.id] = b  # the council scores the build through the live index, like in the app

    async def go():
        await b.pipeline()
        assert [v["n"] for v in b.versions] == [1] and b.versions[0]["trigger"] == "initial" and b.versions[0]["stats"]["added"]
        s1 = orch.SESSIONS[b.council_sessions[0]]
        await s1.task
        v1 = b.versions[0]
        assert v1["council_session"] == s1.id and v1["verdict"]["approved"] is False
        assert v1["readiness"] is not None and 0 <= v1["readiness"] < 100  # open findings, nothing requested before
        ev = next(e for e in s1.events if e["type"] == "council.verdict")
        b.apply_council(ev["changes"], s1.id)
        await b.task
        assert len(b.versions) == 2 and b.versions[1]["trigger"] == "council" and len(b.versions[1]["requested"]) == len(ev["changes"])
        assert b.versions[1]["requested"][0]["id"] == "R1.1"
        assert "README.md" in b.version_diff(1, "README.md") and isinstance(b.version_diff(2, "README.md"), str)
        # second council round verifies the requested items → resolved list + readiness based on them
        s2 = orch.SESSIONS[b.council_sessions[1]]
        assert s2.config.review_of["prior_requests"][0]["id"] == "R1.1"
        await s2.task
        v2 = b.versions[1]
        assert v2["resolved"] and {r["status"] for r in v2["resolved"]} <= {"done", "partial", "pending"}
        assert v2["readiness"] is not None
        for sid in b.council_sessions:
            orch.SESSIONS.pop(sid, None)
        BUILDS.pop(b.id, None)

    asyncio.run(go())


def test_uikit_scaffold_offline_and_with_fake_registry():
    from app import uikit

    files, info = uikit.scaffold(":root { --color-bg: #fff; --primary: #123456; }", ["button"], fetcher=lambda url: None)
    assert info["components"] == [] and uikit.GUIDE_PATH in files and "npx shadcn@latest add" in files[uikit.GUIDE_PATH]
    assert "--background: var(--color-bg" in files[uikit.TOKENS_PATH] and "--primary:" not in files[uikit.TOKENS_PATH].split("sembrado por Muse Team")[1]

    def fake(url):
        name = url.rsplit("/", 1)[1][:-5]
        if name == "card":
            return {"name": "card", "dependencies": ["cn"], "registryDependencies": ["button"], "files": [{"path": f"registry/x/ui/card.tsx", "type": "registry:ui", "content": 'import { cn } from "cn"\nfunction Card() {}\nexport { Card }\n'}]}
        if name == "button":
            return {"name": "button", "dependencies": ["cn", "radix-ui"], "files": [{"path": "registry/x/ui/button.tsx", "type": "registry:ui", "content": 'import { Slot } from "radix-ui"\nimport { cn } from "@/registry/x/lib/utils"\nexport { Button, buttonVariants }\n'}]}
        return None

    files, info = uikit.scaffold("", ["card"], fetcher=fake)
    assert info["components"] == ["button", "card"] and info["exports"]["button"] == ["Button", "buttonVariants"]
    assert 'from "@/lib/utils"' in files[f"{uikit.UI_DIR}/card.tsx"] and 'from "@/lib/utils"' in files[f"{uikit.UI_DIR}/button.tsx"]
    assert "radix-ui" in info["deps"] and "cn" not in info["deps"]
    block = uikit.builder_block(info)
    assert "button, card" in block and '"radix-ui"' in block
    assert uikit.team_block("cto", "web") and not uikit.team_block("cto", "mobile") and "shadcn" in uikit.designer_block("web")


def test_build_seeds_uikit_only_for_web(tmp_path, monkeypatch):
    from app import uikit

    monkeypatch.setattr(uikit, "CACHE_DIR", tmp_path / "cache")
    b = Build(USER, BuildRequest(session_id="s-kit", provider="mock", model="mock-1", design=False, platform="web"), MOCK, "# brief", "Demo")
    asyncio.run(b.pipeline())
    assert uikit.GUIDE_PATH in b.files and uikit.INDEX_CSS in b.files and "vite.config.ts" in b.files
    assert any(c.get("role") == "system" and "Kit de UI" in c.get("text", "") for c in b.chat)
    m = Build(USER, BuildRequest(session_id="s-mob", provider="mock", model="mock-1", design=False, platform="mobile"), MOCK, "# brief", "Demo")
    asyncio.run(m.pipeline())
    assert uikit.GUIDE_PATH not in m.files
