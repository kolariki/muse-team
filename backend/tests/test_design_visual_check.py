import asyncio
from types import SimpleNamespace

from app import builder as bmod
from app.builder import DESIGN_MOCKUP, Build, BuildRequest
from app.design import parse_design_critique
from tests.test_pipelines import MOCK, USER


def _build():
    b = Build(USER, BuildRequest(session_id="sv", provider="mock", model="mock-1"), MOCK, "# brief", "Demo", [])
    b.files[DESIGN_MOCKUP] = "<html><body>maqueta</body></html>"
    b.status = "running"
    return b


def _capture(monkeypatch, desktop=b"png"):
    async def fake(url):
        assert url.startswith("file://")
        return SimpleNamespace(desktop=desktop, mobile=b"png2")
    monkeypatch.setattr(bmod.rsch, "capture_async", fake)


def _see(monkeypatch, b, answer):
    monkeypatch.setitem(bmod.PROVIDERS, "seer", SimpleNamespace(kind="api"))
    monkeypatch.setattr(b, "_vision_model", lambda: ("seer", "m", b.cred))
    sent = {}
    async def ask(system, user, provider, model, cred, images=None, max_tokens=0, mock_text=""):
        sent["images"] = images
        return answer
    monkeypatch.setattr(b, "_ask", ask)
    calls = []
    async def design(feedback=None):
        calls.append(feedback)
    monkeypatch.setattr(b, "design_phase", design)
    return sent, calls


def test_parse_design_critique():
    assert parse_design_critique('{"aprobado": true, "problemas": []}') == []
    assert parse_design_critique('ok ```json\n{"aprobado": false, "problemas": ["Texto cortado"]}\n```') == ["Texto cortado"]
    assert parse_design_critique("no pude") is None
    assert parse_design_critique('{"aprobado": false, "problemas": []}') is None


def test_rejected_design_goes_back_once_with_the_problems(monkeypatch):
    b = _build()
    _capture(monkeypatch)
    sent, calls = _see(monkeypatch, b, '{"aprobado": false, "problemas": ["El título se corta en celular"]}')
    asyncio.run(b._visual_design_check())
    assert sent["images"] == [b"png", b"png2"]
    assert len(calls) == 1 and "El título se corta en celular" in calls[0]


def test_approved_or_unreadable_answer_keeps_the_design(monkeypatch):
    for answer in ('{"aprobado": true, "problemas": []}', "no pude"):
        b = _build()
        _capture(monkeypatch)
        _, calls = _see(monkeypatch, b, answer)
        asyncio.run(b._visual_design_check())
        assert calls == []


def test_failures_never_stop_the_build(monkeypatch):
    b = _build()
    async def boom(url):
        raise RuntimeError("sin Chrome")
    monkeypatch.setattr(bmod.rsch, "capture_async", boom)
    asyncio.run(b._visual_design_check())
    assert b.status == "running"

    b = _build()
    _capture(monkeypatch, desktop=None)  # Chrome could not open it
    _, calls = _see(monkeypatch, b, '{"aprobado": false, "problemas": ["x"]}')
    asyncio.run(b._visual_design_check())
    assert calls == []


def test_subscription_engine_looks_at_the_captures_and_cleans_up(monkeypatch, tmp_path):
    b = _build()
    b.engine, b.workdir, b.req.provider = "claude-code", tmp_path, "claude-code"
    _capture(monkeypatch)
    monkeypatch.setattr(b, "_vision_model", lambda: None)
    seen = {}
    async def run(engine, prompt, cwd, *, on_event, **kw):  # like run_claude_code: on_event is required
        await on_event("text", text="x")
        seen["shots"] = sorted(p.name for p in (cwd / "design" / "capturas").iterdir())
        (cwd / "design" / "mockup.html").write_text("<html>corregida</html>")
        return {"session_id": "s", "cost": 0.1, "tokens": 5}
    monkeypatch.setattr(bmod, "run_engine", run)
    asyncio.run(b._visual_design_check())
    assert seen["shots"] == ["celular.png", "escritorio.png"]
    assert not (tmp_path / "design" / "capturas").exists()
    assert b.files[DESIGN_MOCKUP] == "<html>corregida</html>" and b.engine_session == "s"


DIRECTION = '<!-- nombre: Noche clara | por qué: se lee bien de noche -->\n<html><body>x</body></html>'


def _engine_build(monkeypatch, tmp_path, picks):
    """A subscription build whose agent writes the three directions; `picks` is what the person does each round."""
    b = _build()
    b.files.pop(DESIGN_MOCKUP)
    b.engine, b.workdir, b.req.provider, b.req.design_review = "claude-code", tmp_path, "claude-code", True
    prompts = []
    async def run(engine, prompt, cwd, *, on_event, **kw):
        prompts.append(prompt)
        d = cwd / "design" / "direcciones"
        d.mkdir(parents=True, exist_ok=True)
        for i in (1, 2, 3):
            (d / f"{i}.html").write_text(DIRECTION)
        return {}
    monkeypatch.setattr(bmod, "run_engine", run)
    rounds = iter(picks)
    def emit(type_, **data):
        if type_ == "design.directions":
            assert len(data["directions"]) == 3 and data["directions"][0]["name"] == "Noche clara"
            next(rounds)(b)
    monkeypatch.setattr(b, "emit", emit)
    b.inspiration = []
    return b, prompts


def test_chosen_direction_reaches_the_designer_and_leaves_no_files(monkeypatch, tmp_path):
    b, _ = _engine_build(monkeypatch, tmp_path, [lambda x: x.choose_direction(1, "más sobria")])
    asyncio.run(b._choose_direction())
    assert b.direction_chosen["name"] == "Noche clara" and b._direction_wish == "más sobria" and b.directions == []
    assert not any(p.startswith("design/direcciones") for p in b.files) and not (tmp_path / "design" / "direcciones").exists()
    assert "más sobria" in bmod.direction_note(b.direction_chosen, b._direction_wish) and "Noche clara" in bmod.direction_note(b.direction_chosen)


def test_none_of_them_asks_for_three_more_with_what_the_person_said(monkeypatch, tmp_path):
    b, prompts = _engine_build(monkeypatch, tmp_path, [lambda x: x.redo_design("más foto"), lambda x: x.choose_direction(0)])
    asyncio.run(b._choose_direction())
    assert len(prompts) == 2 and "más foto" in prompts[1] and b.direction_chosen


def test_nobody_answers_a_build_without_approval_step_goes_on(monkeypatch, tmp_path):
    b, _ = _engine_build(monkeypatch, tmp_path, [lambda x: None])
    b.req.design_review = False
    monkeypatch.setattr(bmod, "DIRECTION_WAIT", 0.01)
    asyncio.run(b._choose_direction())
    assert b.direction_chosen and b.status == "running"


def test_simulated_and_clone_builds_skip_directions():
    assert not _build()._wants_directions()
    b = _build()
    b.req.provider, b.req.deep_analysis = "claude-code", True
    assert not b._wants_directions()


def test_final_check_engine_walks_the_app_only_on_web(monkeypatch):
    for platform, expected in (("web", 1), ("mobile", 0)):
        b = _build()
        b.engine, b.status, b.req.platform = "claude-code", "completed", platform
        calls = []
        async def run(prompt):
            calls.append(prompt)
        monkeypatch.setattr(b, "run", run)
        asyncio.run(b._final_app_check())
        assert len(calls) == expected and all("camino principal" in c for c in calls)


def test_final_check_sends_a_broken_app_back_and_never_reaches_the_self_healing(monkeypatch, tmp_path):
    from app import runner

    b = _build()
    b.status = "completed"
    monkeypatch.setitem(bmod.PROVIDERS, "seer", SimpleNamespace(kind="api"))
    b.req.provider = "seer"
    monkeypatch.setattr("app.deploy.materialize", lambda *a: tmp_path)
    monkeypatch.setattr(runner, "detect", lambda root: [{"id": "web", "label": "web", "dir": ".", "install": None, "run": "exit 3"}])
    healed = []
    monkeypatch.setattr(runner, "ON_STATUS", healed.append)
    sent = []
    async def run(prompt):
        sent.append(prompt)
    monkeypatch.setattr(b, "run", run)
    monkeypatch.setattr(b, "emit", lambda *a, **k: None)
    asyncio.run(b._final_app_check())
    assert len(sent) == 1 and "no arranca" in sent[0] and healed == []


def test_scope_question_only_when_it_is_well_formed():
    from app.exporter import parse_scope_question

    assert parse_scope_question('{"pregunta": null}') is None
    assert parse_scope_question("no sé") is None
    assert parse_scope_question('{"pregunta": "¿Qué preferís?", "opciones": ["Una"]}') is None
    assert parse_scope_question('```json\n{"pregunta": "¿Qué preferís?", "opciones": ["Una", "Otra"]}\n```') == {"question": "¿Qué preferís?", "options": ["Una", "Otra"]}


def _library(monkeypatch, tmp_path):
    from app import inspiration as insp

    monkeypatch.setattr(insp, "LIBRARY", tmp_path / "lib")
    monkeypatch.setattr(insp, "robots_allow", lambda url: True)
    return insp


def test_library_keeps_what_it_captures_and_doesnt_reopen_it_or_failures(monkeypatch, tmp_path):
    insp = _library(monkeypatch, tmp_path)
    opened = []
    def shoot(url):
        opened.append(url)
        return b"png" if "bien" in url else None
    monkeypatch.setattr(insp, "shoot", shoot)
    assert insp.add("tienda", "Bien", "https://bien.com")["file"] == "bien-com.png"
    assert insp.add("tienda", "Bien", "https://bien.com") and insp.add("tienda", "Mal", "https://mal.com") is None and insp.add("tienda", "Mal", "https://mal.com") is None
    assert opened == ["https://bien.com", "https://mal.com"]
    assert insp.add("software", "Bien", "https://bien.com")["rubro"] == "software" and len(opened) == 2  # same picture, another shelf
    assert insp.status()["total"] == 2 and insp.status()["failed"] == 1


def test_only_public_https_addresses_and_robots_are_respected(monkeypatch):
    from app import inspiration as insp

    for bad in ("http://a.com", "https://127.0.0.1", "https://10.0.0.1/x", "https://intranet", "https://a.internal", "file:///etc/passwd"):
        assert not insp.public_url(bad)
    assert insp.public_url("https://a.com/x")
    monkeypatch.setattr(insp, "robots_allow", lambda url: False)
    monkeypatch.setattr(insp.rsch, "chrome_path", lambda: "/bin/chrome")
    assert insp.shoot("https://a.com") is None


def test_missing_business_is_fetched_saved_listed_and_handpicked_goes_first(monkeypatch, tmp_path):
    insp = _library(monkeypatch, tmp_path)
    monkeypatch.setattr(insp, "shoot", lambda url: b"png")
    monkeypatch.setattr(insp.rsch, "chrome_path", lambda: "/bin/chrome")
    b = _build()
    answers = iter(['{"rubro": null, "nombre": "Fábrica de drones"}', '[{"name":"Skydio","url":"https://skydio.com","why":"x"},{"name":"Mala","url":"http://10.0.0.1","why":"x"}]'])
    async def ask_text(system, user, max_tokens=1200):
        return next(answers)
    monkeypatch.setattr(b, "_ask_text", ask_text)
    stages = []
    monkeypatch.setattr(b, "emit", lambda t, **d: stages.append(d["previews"]["stage"]) if t == "previews.progress" else None)
    picks = asyncio.run(b._gather_inspiration())
    assert [p["name"] for p in picks] == ["Skydio"] and "bajando" in stages
    pending = insp.to_curate()
    assert pending[0]["rubro"] == "fabrica-de-drones" and pending[0]["fetched"] == ["Skydio"]
    insp.add_by_hand("fabrica-de-drones", "ejemplo", b"png", done=True)
    assert insp.to_curate() == [] and insp.choose("fabrica-de-drones", 6)[0]["source"] == "hand"
    # next time the shelf isn't asked for again if it has enough
    for i in range(4):
        insp.add_by_hand("fabrica-de-drones", f"e{i}", b"png")
    b2 = _build()
    async def known(system, user, max_tokens=1200):
        return '{"rubro": "fabrica-de-drones", "nombre": null}'
    monkeypatch.setattr(b2, "_ask_text", known)
    monkeypatch.setattr(b2, "emit", lambda *a, **k: None)
    asyncio.run(b2._gather_inspiration())
    assert insp.to_curate() == []


def test_bundled_captures_reach_the_library_once_and_keep_what_was_there(monkeypatch, tmp_path):
    import json

    insp = _library(monkeypatch, tmp_path)
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "a.png").write_bytes(b"png")
    (seed / "index.json").write_text(json.dumps({"items": [{"name": "A", "url": "https://a.com", "rubro": "dark", "file": "a.png"}], "shelves": {"dark": "Dark"}}))
    insp.add_by_hand("dark", "mia", b"mine")
    assert insp.load_seed(seed) == 1 and insp.load_seed(seed) == 0
    assert insp.status()["shelves"]["dark"] == 2 and "dark" in insp.known_rubros() and insp.on_shelf("dark")


def test_skill_picks_only_count_what_the_model_chose_from_the_list():
    from app import skills_catalog as cat

    assert cat.parse_picks('```json\n{"a": ["x"]}\n```') == {"a": ["x"]}
    assert cat.parse_picks("no sé") is None
    assert cat._bundled(), "the catalog has to ship with the code: a server has no sources"


def test_design_roles_debate_with_references_and_nobody_else_gets_them(monkeypatch, tmp_path):
    from app import orchestrator as orch
    from app.schemas import AgentConfig, SessionConfig

    insp = _library(monkeypatch, tmp_path)
    insp.add_by_hand("dark", "uno", b"png")
    monkeypatch.setitem(orch.PROVIDERS, "seer", SimpleNamespace(kind="api", label="s", color="#000"))
    seen = []
    async def fake_stream(provider, model, system, user, **kw):
        seen.append(kw.get("images"))
        yield "text", ('{"rubro": "dark", "nombre": null}' if not kw.get("images") else "Mucho aire y letra grande")
    monkeypatch.setattr(orch, "stream", fake_stream)
    agent = lambda i, role: AgentConfig(id=i, name=i, provider="seer", model="m", role=role, persona="")
    s = orch.Session(SessionConfig(topic="una web oscura", agents=[agent("d", "product-designer"), agent("b", "backend")]), USER, {})
    asyncio.run(s._prepare_design_refs())
    assert seen[1] == [b"png"] and "Mucho aire" in s.design_refs
    assert "Mucho aire" in s._system(s.agents["d"]) and "Mucho aire" not in s._system(s.agents["b"])


def test_only_the_address_the_person_typed_is_shown_while_researching(monkeypatch):
    from app import research as rsch

    def run(references, auto):
        b = _build()
        b.req.references, b.req.references_auto = references, auto
        b.brief = "x"
        monkeypatch.setitem(bmod.PROVIDERS, "seer", SimpleNamespace(kind="api"))
        monkeypatch.setattr(b, "_vision_model", lambda: ("seer", "m", b.cred))
        async def ask(system, user, *a, **k):
            return '[{"name":"Propuesto","url":"https://propuesto.com","why":"x"}]' if system == rsch.PROPOSE_SYSTEM else "Ver https://propuesto.com y https://mia.com para ideas."
        monkeypatch.setattr(b, "_ask", ask)
        async def capture(url):
            return SimpleNamespace(ok=True, error=None, title="t", desktop=b"p", mobile=None, text="", url=url)
        monkeypatch.setattr(rsch, "capture_async", capture)
        monkeypatch.setattr(rsch, "save_shots", lambda *a: [])
        monkeypatch.setattr(rsch, "build_user_prompt_for_analysis", lambda cap, brief: "u")
        events = []
        monkeypatch.setattr(b, "emit", lambda t, **d: events.append((t, d)))
        asyncio.run(b.research_phase())
        return b, str(b.activity) + str(b.chat) + str([d for t, d in events if t in ("notice", "research.reference")]), b.files.get(bmod.RESEARCH_PATH, "")

    _, seen, md = run([], False)
    assert "propuesto.com" not in seen and "propuesto.com" not in md and "Investigando referentes" in seen
    _, seen, md = run(["https://mia.com"], False)
    assert "mia.com" in seen and "mia.com" in md
    _, seen, md = run(["https://mia.com"], True)  # the preset's, not the person's
    assert "mia.com" not in seen and "mia.com" not in md
