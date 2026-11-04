"""Reference research as a standalone job, before a debate starts.

The home page lets the user name reference apps (and turn on reverse engineering) before launching the team. Until now
those only reached the build; the debate itself started blind. A job here benchmarks the references first (same
capture → vision → synthesis flow as the build's research phase), reports progress for the reverse-engineering screen,
and hands back research/REFERENCES.md, which the session then carries as `context` so every role debates with it.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path

from . import keystore
from . import research as rsch
from .auth import User
from .config import DATA_DIR
from .providers import PROVIDERS, CallResult, Cred, MockContext, stream
from .tasks import spawn

log = logging.getLogger("arena.research_jobs")

JOBS: dict[str, dict] = {}
TTL = 2 * 3600


def _vision_model(user: User) -> tuple[str, str, Cred] | None:
    eff = keystore.creds(user.id)
    for pid in ("anthropic", "openai", "gemini", "xai", "openrouter"):
        c = eff.get(pid)
        if c and c.source != "none":
            return pid, c.model or PROVIDERS[pid].default_model, c
    c = eff.get("mock")
    return ("mock", c.model if c else "mock-1", c) if c else None


async def _ask(system: str, user_msg: str, who: tuple[str, str, Cred], job: dict, images: list[bytes] | None = None, max_tokens: int = 4000, mock_text: str = "") -> str:
    provider, model, cred = who
    result = CallResult()
    mock = MockContext("Researcher", [("x", "x")], job["brief"][:80], script=mock_text or None)
    buf: list[str] = []
    async for kind, delta in stream(provider, model, system, user_msg, temperature=0.3, max_tokens=max_tokens, result=result, mock=mock, cred=cred, images=images):
        if kind == "text":
            buf.append(delta)
    job["tokens"] += result.input_tokens + result.output_tokens
    return "".join(buf)


def _act(job: dict, kind: str, label: str, path: str = "") -> None:
    job["activity"] = (job["activity"] + [{"kind": kind, "label": label, "path": path, "ts": time.time()}])[-60:]


async def _run(job: dict, user: User) -> None:
    try:
        who = _vision_model(user)
        if not who:
            job.update(status="error", error="Hace falta una API key (Anthropic, OpenAI o Gemini) para mirar las capturas.")
            return
        mock = PROVIDERS[who[0]].kind == "mock"
        deep = job["deep"]
        refs: list[dict] = []
        for r in job["refs"][: rsch.MAX_REFERENCES]:
            url = rsch.normalize_reference(r)
            refs.append({"name": r.strip()[:60], "url": url, "why": ""})
        named_only = [r["name"] for r in refs if not r["url"]]
        refs = [r for r in refs if r["url"]]
        if named_only:  # apps typed by name: resolve their public URL, nothing else is added
            _act(job, "search", "Buscando la URL de " + ", ".join(named_only))
            ask = f"BRIEF:\n{job['brief'][:6000]}\n\nEl usuario nombró estas apps (devolvé solo ellas, con su URL pública): {', '.join(named_only)}\nProponé exactamente {len(named_only)} referentes (JSON)."
            text = await _ask(rsch.PROPOSE_SYSTEM, ask, who, job, max_tokens=1200, mock_text='[{"name":"Windy","url":"https://www.windy.com","why":"mapas"}]' if mock else "")
            seen = {r["url"] for r in refs}
            for pr in rsch.parse_proposals(text)[: len(named_only)]:
                if pr["url"] not in seen:
                    refs.append(pr)
                    seen.add(pr["url"])
        notes: list[str] = []
        workdir = job["dir"]
        if job.get("hidden"):  # the team's own references (no address the person typed): nothing is named or linked
            _act(job, "search", "Investigando referentes")
        for i, ref in enumerate(refs):
            if not job.get("hidden"):
                _act(job, "search", f"Entrando a {ref['name'] or ref['url']}", ref["url"])
            cap = await rsch.capture_async(ref["url"])
            shots = rsch.save_shots(workdir, i, cap)
            job["visited"].append({"name": "", "url": None, "ok": cap.ok} if job.get("hidden") else {"name": ref["name"], "url": ref["url"], "ok": cap.ok, "error": cap.error, "shots": shots, "title": cap.title})
            if not cap.ok:
                if not job.get("hidden"):
                    _act(job, "search", f"No se pudo abrir {ref['url']}: {cap.error}")
                continue
            if not job.get("hidden"):
                _act(job, "read", f"Analizando {ref['name'] or cap.title or ref['url']}", ref["url"])
            images = [im for im in (cap.desktop, cap.mobile) if im] if not mock else None
            analysis = await _ask(rsch.analyze_system(deep), rsch.build_user_prompt_for_analysis(cap, job["brief"]), who, job, images=images, max_tokens=4500 if deep else 3000,
                                  mock_text=f"## 1. Qué es\n{cap.title or ref['url']} (simulado).\n## 2. Pantallas\nHome con buscador.\n## 3. Patrones\nCards.\n## 4. Decisiones\nSin cuentas.\n## 5. Emular / evitar\nEmular: buscador arriba.")
            notes.append(f"## {ref['name'] or cap.title or ref['url']}\n" + ("" if job.get("hidden") else f"URL: {ref['url']}\n") + f"\n{analysis.strip()}")
        md = ""
        if notes:
            _act(job, "plan", "Investigando referentes" if job.get("hidden") else "Armando el brief de referentes", "" if job.get("hidden") else "research/REFERENCES.md")
            synth = await _ask(rsch.synth_system(deep), f"NUESTRO BRIEF:\n{job['brief'][:8000]}\n\nREFERENTES (en orden de prioridad): {', '.join(r['name'] or r['url'] for r in refs)}\n\nNOTAS DE BENCHMARK:\n\n" + "\n\n---\n\n".join(notes), who, job, max_tokens=8000,
                              mock_text="# Referentes\n| app | mejor | falta |\n|---|---|---|\n| Windy | mapa | texto |\n# Patrones a emular\n- Mapa protagonista\n# Patrones a evitar\n- Densidad\n# Flujo recomendado\n1. Buscar ciudad\n# Copy y tono\nDirecto.\n# Checklist\n1. Carga < 2 s")
            md = f"<!-- Benchmark generado por Muse Team el {rsch.stamp()}. Observación de productos públicos; nada copiado. -->\n\n{synth.strip()}\n\n---\n\n# Notas por referente\n\n" + "\n\n".join(notes) + "\n"
            if job.get("hidden"):
                md = rsch.without_addresses(md, refs)
            (workdir / "REFERENCES.md").write_text(md)
        job.update(status="done", md=md, model=f"{PROVIDERS[who[0]].label} · {who[1]}")
    except Exception as e:  # noqa: BLE001
        log.warning("research job %s failed: %s", job["id"], e)
        job.update(status="error", error=str(e)[:300])
    finally:
        job["finished_at"] = time.time()


def start(user: User, references: list[str], brief: str, deep: bool, hidden: bool = False) -> dict:
    jid = "rj-" + uuid.uuid4().hex[:10]
    d = DATA_DIR.parent / "research" / user.id / jid
    d.mkdir(parents=True, exist_ok=True)
    job = {"id": jid, "user_id": user.id, "refs": [r for r in references if r.strip()], "brief": brief[:12000], "deep": bool(deep), "hidden": hidden, "dir": d,
           "status": "running", "visited": [], "activity": [], "md": "", "error": None, "tokens": 0, "started": time.time(), "finished_at": None}
    JOBS[jid] = job
    for k, j in list(JOBS.items()):  # forget old ones
        if j.get("finished_at") and time.time() - j["finished_at"] > TTL:
            JOBS.pop(k, None)
    spawn(_run(job, user))
    return public(job)


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in ("dir", "brief", "user_id")} | {"dir": str(job["dir"])}


def get(user: User, jid: str) -> dict | None:
    j = JOBS.get(jid)
    return public(j) if j and j["user_id"] == user.id else None
