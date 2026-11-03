"""The arena: runs the conversation between agents and emits a stream of events.

Event types (all JSON, all carry `type`, `seq`, `ts`):
    session.started   {session_id, config, providers, langfuse_url}
    turn.started      {turn, agent_id, caller_id, reason}
    token             {turn, agent_id, kind: text|reasoning, delta}
    turn.completed    {turn, agent_id, responding_to, thinking, message, stance, confidence, next, reason, metrics}
    handoff           {turn, from, to, reason, requested, forced_reason}
    agent.error       {turn, agent_id, error}
    vote.started      {}
    vote              {voter, target, reason, metrics}
    verdict           {winner, tally, tie, tiebreak}
    judge.started     {judge_id, model}
    token             (judge=true) streamed explanation
    verdict.explained {headline, why, key_moment, others, judge_id, model}
    session.completed {stats, status}

Each turn the agent answers using a tiny tag protocol, which keeps the stream human-readable
while letting the UI parse thinking / message / decision live, provider-agnostic.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections import Counter, defaultdict
from typing import Any

from . import observability as obs
from . import uikit
from .tasks import spawn
from .auth import User, user_dir
from .pricing import cost_usd
from .providers import CACHE_SEP, PROVIDERS, CallResult, Cred, MockContext, stream
from .roles import role_of
from .expertise import expertise_block
from . import skills as skillmod
from .schemas import AgentConfig, SessionConfig

log = logging.getLogger("arena")

PROTOCOL = """Respondé SIEMPRE con este formato exacto de etiquetas, sin nada fuera de ellas:
<reflexion>tu lectura de la situación en 1-2 frases, máximo 40 palabras (se mostrará como "pensamiento")</reflexion>
<message>tu intervención pública, 2-5 frases (hasta ~150 palabras; en la ronda de cierre podés extenderte), con personalidad. Dirigite a los demás por su nombre. Abrí SIEMPRE con <message> antes que nada largo: si te quedás sin espacio, que lo que falte sea lo de menos.</message>
<stance>agree | disagree | propose | neutral  (tu postura respecto de la intervención anterior)</stance>
<confidence>0-100 (qué tan seguro estás de tu postura)</confidence>
<next>{ids}  (id del agente al que le pasás la palabra{end})</next>
<reason>por qué elegís a ese agente, en una frase</reason>"""

JUDGE_SYSTEM = """Sos el JUEZ neutral de TABLY TEAM, un experimento donde modelos de IA de distintas empresas debatieron en vivo.
No participaste del debate (aunque corras sobre {model}): sé imparcial, incluso si el ganador es de tu misma empresa.
Los agentes ya votaron. Tu trabajo: explicarle al público, de forma clara y con gancho para redes, POR QUÉ ganó {winner}.
Basate en evidencia concreta de la transcripción (citá ideas o frases cortas, mencioná turnos) y en los votos.
Si hubo empate, explicá que se desempató por confianza promedio y si eso fue justo.
Idioma: {language}. Respondé SOLO con:
<headline>titular de 6-12 palabras</headline>
<why>2-4 frases: qué hizo {winner} mejor que el resto, con ejemplos concretos</why>
<key_moment>el momento decisivo: "Turno N — ..." en una frase</key_moment>
<others>1-2 frases: qué le faltó a cada uno de los demás</others>"""

VOTE_PROTOCOL = """La discusión terminó. Votá al agente (que no seas vos) con el mejor aporte.
Respondé SOLO con:
<reflexion>tu evaluación en 1-2 frases</reflexion>
<vote>id del agente: {ids}</vote>
<reason>por qué, en una frase con gancho</reason>"""

CLOSING_PROTOCOL = """RONDA DE CIERRE. El debate terminó; ya no se discute. Entregá tus DECISIONES FINALES sobre tu responsabilidad
({mandate}) incorporando lo que se acordó. Sé exhaustivo y concreto: nombres exactos, números, comandos, tablas, endpoints,
pantallas, tickets. Si algo de tu área no se debatió, decidilo vos y marcá "(decisión propia)". Lo que escribas acá va directo
al documento con el que se va a construir el producto.
Respondé SOLO con:
<reflexion>qué quedó decidido y qué tuviste que definir vos, en 1-2 frases</reflexion>
<message>tus decisiones finales, en Markdown (listas, tablas o bloques de código), 150-400 palabras</message>
<stance>propose</stance>
<confidence>0-100</confidence>"""

CLOSING_REVIEW_PROTOCOL = """RONDA DE CIERRE DE LA REVISIÓN. La discusión terminó. Entregá tu VEREDICTO FINAL como {role_label} sobre el proyecto entregado
({mandate}), incorporando lo que se discutió con el resto del consejo.
Respondé SOLO con:
<reflexion>qué pesó más en tu decisión, en 1-2 frases</reflexion>
<message>Primera línea: `APRUEBO` o `CAMBIOS`. Después, la lista de cambios que pedís de tu área, uno por línea, con este formato exacto:
- [bloqueante] qué cambiar y dónde (archivo, pantalla o endpoint concreto) — solo lo que se arregla en el código; publicar, desplegar o cargar secretos lo hace el usuario desde Muse Team y nunca es bloqueante
- [mejora] qué cambiar y dónde
Si aprobás sin cambios, dejá la lista vacía. Máximo 8 ítems, concretos y accionables para el constructor.</message>
<stance>propose</stance>
<confidence>0-100</confidence>"""

COUNCIL_SYSTEM = """Sos el PRESIDENTE del consejo de revisión pre-producción de TABLY TEAM (corrés sobre {model}; sé imparcial).
Los roles del equipo revisaron el proyecto construido y debatieron en vivo; cada uno dio su veredicto final.
Tu trabajo: consolidar UNA lista de cambios para el constructor (el agente que escribe el código), sin repetir ítems, y decir si el producto
está listo para producción o no. Mantené la atribución del rol que lo pidió. Idioma: {language}. Respondé SOLO con:
<verdict>approve | changes</verdict>
<headline>titular de 6-12 palabras sobre el estado del producto</headline>
<why>2-4 frases: qué está bien y qué lo frena, con ejemplos concretos del debate</why>
<changes>un ítem por línea, formato exacto `- [bloqueante|mejora] [ROL] qué cambiar y dónde`; primero los bloqueantes. Vacío si approve.</changes>
<resolved>SOLO si hubo ítems pedidos en la ronda anterior: uno por línea, formato exacto `- [ID] done|partial|pending — evidencia en una frase`</resolved>
<priorities>SOLO si el usuario dio prioridades: una línea por prioridad, formato exacto `- [P1] cumplida|parcial|pendiente — qué se hizo o qué falta`</priorities>
<level>SOLO si hay REQUISITOS DEL NIVEL: una línea por requisito, formato exacto `- [N1] cumplido|parcial|pendiente — evidencia concreta (archivo, pantalla)`</level>
IMPORTANTE: las prioridades del usuario que no estén cumplidas DEBEN aparecer también en <changes> como [bloqueante] [Usuario]. Los requisitos del nivel marcados [team] que no estén
cumplidos DEBEN aparecer en <changes> como [bloqueante] [Nivel N]: el equipo sigue los niveles a rajatabla y no se aprueba un producto que no cumple el nivel que está escalando.
Nunca devuelvas <changes> vacío si algún rol pidió cambios.
QUÉ PUEDE SER [bloqueante]: solo lo que el constructor puede resolver escribiendo código en el repo (un bug, un flujo roto, un hueco de
seguridad, datos que se pierden, una prioridad del usuario o un requisito [team] del nivel sin cumplir). Publicar en una URL, desplegar,
cargar secretos o variables de un host, crear cuentas, correr CI en un servidor real o conseguir dominios lo hace el USUARIO desde Muse Team
(Publicar): eso nunca es bloqueante; como mucho, una [mejora] que diga que queda listo para publicar.
CONVERGENCIA: desde la ronda 2, no abras alcance nuevo. Un bloqueante nuevo solo si es un defecto real que rompe el producto; lo demás es
[mejora]. Si los bloqueantes de la ronda anterior quedaron resueltos y no hay defectos reales, aprobá."""

TAGS = ("thinking", "reflexion", "message", "stance", "confidence", "next", "reason", "vote", "headline", "why", "key_moment", "others", "verdict", "changes", "resolved", "priorities", "level")


def parse_tags(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for tag in TAGS:
        m = re.search(rf"<{tag}>(.*?)(?:</{tag}>|(?=<(?:{'|'.join(TAGS)})>)|\Z)", text, re.S | re.I)
        if m:
            out[tag] = m.group(1).strip()
    if "reflexion" in out and not out.get("thinking"):
        out["thinking"] = out.pop("reflexion")
    if "message" not in out:
        out["message"] = re.sub(r"<[^>]+>", "", text).strip()
    return out


SELF_APPROVAL = re.compile(r"aprobad[ao] por el consejo|approved by the council", re.I)


def drop_self_approval(items: list[dict]) -> list[dict]:
    """«Approved by the council» is the council's own verdict, never a change to build or to carry to the next round: asked as
    a change it can never be resolved, so the council could never approve (the loop users saw at round 8 and 11)."""
    return [c for c in items if not SELF_APPROVAL.search(c.get("text") or "")]


def parse_changes(text: str) -> list[dict]:
    """`- [bloqueante] [CTO] texto` lines → [{severity, role, text}] (role optional, severity defaults to mejora)."""
    out = []
    for line in (text or "").splitlines():
        # the tags come in the debate language: [bloqueante|mejora] in Spanish, [blocking|improvement] in English; several roles fit one tag
        m = re.match(r"^\s*[-*•]\s*(?:\[(bloqueante|mejora|blocking|blocker|improvement|nice[- ]to[- ]have|cr[ií]tico|critical)\]\s*)?(?:\[([^\]]{1,160})\]\s*)?(.+)$", line.strip(), re.I)
        if not m or len(m.group(3).strip()) < 6:
            continue
        sev = (m.group(1) or "mejora").lower()
        sev = "bloqueante" if sev in ("bloqueante", "blocking", "blocker", "crítico", "critico", "critical") else "mejora"
        out.append({"severity": sev, "role": (m.group(2) or "").strip(), "text": m.group(3).strip()})
    return out


def parse_resolved(text: str, prior: list[dict]) -> list[dict]:
    """`- [R1.2] done — nota` lines → [{id, status, note}], one per prior item (missing → pending)."""
    found: dict[str, dict] = {}
    for line in (text or "").splitlines():
        m = re.match(r"^\s*[-*•]\s*\[?([A-Za-z]*\d+(?:\.\d+)?)\]?\s*[:\-–—]?\s*(done|partial|pending|hecho|parcial|pendiente)\b\s*[—\-–:]?\s*(.*)$", line.strip(), re.I)
        if not m:
            continue
        st = m.group(2).lower()
        st = "done" if st in ("done", "hecho") else "partial" if st in ("partial", "parcial") else "pending"
        found[m.group(1).upper()] = {"status": st, "note": m.group(3).strip()[:200]}
    return [{"id": r["id"], "text": r.get("text", ""), **found.get(r["id"].upper(), {"status": "pending", "note": ""})} for r in prior]


def split_priorities(text: str | None) -> list[str]:
    """User priorities → short items (one per line / sentence), max 6."""
    out = []
    for part in re.split(r"[\n;]+|(?<=[.!?])\s+", text or ""):
        part = part.strip(" -•*\t")
        if len(part) >= 8:
            out.append(part[:240])
    return out[:6]


_STANCE_WORDS = (
    ("disagree", ("disagree", "desacuerdo", "discrep", "rechaz", "objet", "no coincido", "en contra", "oppos", "refut")),
    ("propose", ("propose", "propon", "propuesta", "sugier", "suggest", "plante")),
    ("agree", ("agree", "acuerdo", "coincid", "apoy", "concuerd", "de acuerdo", "comparto", "support")),
    ("neutral", ("neutral", "neutro")),
)


def _norm_stance(s: str | None) -> str:
    """Models often answer the stance in the debate language ("de acuerdo", "propongo…") or with a phrase: map it."""
    s = (s or "").lower()
    for k, words in _STANCE_WORDS:
        if any(w in s for w in words):
            return k
    return "neutral"


def _norm_conf(s: str | None) -> int | None:
    m = re.search(r"\d+", s or "")
    return max(0, min(100, int(m.group()))) if m else None



def lang_rule(language: str | None) -> str:
    """The instructions are written in Spanish; in an English session that alone drags the answers into Spanish."""
    from .intake import lang_code

    if lang_code(language) != "en":
        return ""
    return ("\n\nLANGUAGE: English. Write EVERY word in English (messages, stances, reasons, change lists, verdicts, headlines), "
            "even though these instructions, the brief or earlier messages are in Spanish. Keep file paths and code as they are.")

class Session:
    def __init__(self, config: SessionConfig, owner: User, creds: dict[str, Cred]):
        self.owner = owner
        self.creds = creds  # never persisted
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.config = config
        self.events: list[dict[str, Any]] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.status = "pending"
        self.task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.agents = {a.id: a for a in config.agents}
        self.transcript: list[dict[str, Any]] = []
        self.trace_id: str | None = None
        self.votes: list[dict[str, Any]] = []
        self.verdict: dict[str, Any] = {}
        self._resume = asyncio.Event()
        self.pause: dict[str, Any] | None = None  # {agent_id, provider, model, error, attempts} while waiting for the user

    # ------------------------------------------------------------------ pub/sub
    def emit(self, type_: str, **data) -> dict:
        ev = {"type": type_, "seq": len(self.events), "ts": time.time(), **data}
        self.events.append(ev)
        for q in list(self.subscribers):
            q.put_nowait(ev)
        return ev

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for ev in self.events:
            q.put_nowait(ev)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def stop(self) -> None:
        self._stop.set()
        self._resume.set()

    def resume(self, action: str = "retry") -> None:
        """User decision after a provider outage: retry with the (possibly updated) model."""
        if self.pause:
            self.pause = None
            self.emit("session.resumed", action=action)
            self._resume.set()

    def update_agent_skills(self, agent_id: str, skill_ids: list[str]) -> None:
        """Attach/detach skills to a role mid-session; the prompt is rebuilt on its next call."""
        a = self.agents[agent_id]
        a.skills = list(dict.fromkeys(skill_ids))[:12]
        self.emit("agent.updated", agent_id=agent_id, provider=a.provider, model=a.model, color=PROVIDERS[a.provider].color, skills=a.skills)
        self._save()

    def update_agent(self, agent_id: str, provider: str, model: str, cred) -> None:
        """Promote/demote a role to another model; applies from its next call. Works mid-run and while paused."""
        a = self.agents[agent_id]
        a.provider, a.model = provider, model
        a.color = a.color or None
        if cred is not None:
            self.creds[provider] = cred
        self.emit("agent.updated", agent_id=agent_id, provider=provider, model=model, color=PROVIDERS[provider].color)
        self._save()

    async def _finish_if_cut(self, agent: AgentConfig, system: str, user: str, text: str, result: CallResult, *, turn: int | None) -> tuple[str, CallResult]:
        """A turn that hit max_tokens is continued once (same prompt, its partial answer as the assistant's turn) and
        stitched, so long Markdown decisions do not end mid-sentence. Returns the full text and the last call's result."""
        if not getattr(result, "truncated", False) or not text.strip() or PROVIDERS[agent.provider].kind == "mock":
            return text, result
        log.info("turn of %s was cut at %s tokens, continuing", agent.id, result.output_tokens)
        more, _nr, res2 = await self._call(
            agent, system, "Tu respuesta se cortó por el límite de largo. Continuá EXACTAMENTE desde donde quedó, sin repetir nada y cerrando las etiquetas que falten.",
            turn=turn, vote=False, max_tokens=max(self.config.max_tokens, 1500), history=[{"role": "user", "content": user}, {"role": "assistant", "content": text}],
        )
        res2.input_tokens += result.input_tokens
        res2.output_tokens += result.output_tokens
        return text + more, res2

    # ------------------------------------------------------------------ prompts
    def _system(self, agent: AgentConfig, vote: bool = False) -> str:
        others = [a for a in self.config.agents if a.id != agent.id]
        roster = "\n".join(
            f"- id `{a.id}`: {a.name}" + (f" · {role_of(a.role)['label']}" if role_of(a.role) and role_of(a.role)["label"].lower() != a.name.lower() else "") + f" ({PROVIDERS[a.provider].label}, {a.model}) — {a.persona[:140]}"
            for a in others
        )
        role = role_of(agent.role)
        review = self.config.mode == "review"
        if role and review:
            role_txt = (
                f"Tu rol en el equipo: {role['label']} (tu área: {role['mandate']}). Esto es una REVISIÓN PRE-PRODUCCIÓN del producto que el equipo "
                f"diseñó y un constructor ya escribió: no se debate el diseño, se revisa lo entregado. Buscá problemas CONCRETOS de tu área "
                f"(archivo, pantalla, endpoint, dato), decí si son bloqueantes o mejoras, y discutí con los demás qué merece frenar la salida. "
                f"Si el proyecto trae design/ (DESIGN.md, tokens.css, mockup.html), la interfaz se juzga contra ese diseño: desviaciones de tokens, "
                f"layout, estados o copy son hallazgos. Citá el proyecto, no inventes archivos.\n"
            )
        else:
            role_txt = (
                f"Tu rol en el equipo: {role['label']}. Tu responsabilidad es que al final del debate quede resuelto: {role['mandate']}. "
                f"Hablá desde ese rol, sé concreto (nombres, números, pasos) y no te metas en lo que es de otro rol salvo para pedírselo.\n"
                if role
                else ""
            )
        # the project under review is the same for every role and turn → its own block, first, so providers cache it
        if review and self.config.context:
            context = f"PROYECTO ENTREGADO (lo que se revisa):\n{self.config.context[:60000]}\n{CACHE_SEP}"
        elif self.config.context:
            # material the user attached at intake (documents, a project…): same for every role → cached block, first
            context = f"MATERIAL ADJUNTO POR EL USUARIO (contexto real del proyecto; citalo cuando decidas):\n{self.config.context[:60000]}\n{CACHE_SEP}"
        else:
            context = ""
        craft = expertise_block(agent.role, mode="review" if review else "debate")
        if craft:
            role_txt += craft + "\n"
        if not review:
            role_txt += uikit.team_block(agent.role, getattr(self.config, "platform", "web"))
        from . import memory as memorymod

        from . import team as teammod

        role_txt += memorymod.prompt_block(self.owner.id, agent.role, agent.name)
        role_txt += teammod.knowledge_block(self.owner.id, agent.role, agent.name, f"{self.config.title or ''} {self.config.topic}")
        sk = skillmod.prompt_block(self.owner.id, agent.skills)
        if sk:
            role_txt += sk
        prio = (self.config.review_of or {}).get("priorities") if review else None
        if review and (self.config.review_of or {}).get("focus") == "design":
            role_txt += ("ESTA RONDA ES SOLO DE DISEÑO Y EXPERIENCIA: hablás de pantallas, layout, componentes, paleta, tipografía, estados, interacciones y pulido, comparando con el plano visual de los referentes. "
                         "No pidas ni menciones tests, CI, deploy, legales, rendimiento ni deuda técnica: están fuera de alcance en esta ronda.\n")
        if prio:
            role_txt += (f"PRIORIDADES DEL USUARIO PARA ESTA RONDA (tratalas PRIMERO, con detalle; recién después lo que vos consideres):\n{prio[:2000]}\n")
        lvl = (self.config.review_of or {}).get("level") if review else None
        if lvl and lvl.get("items"):
            role_txt += (f"NIVELES DE CRECIMIENTO: el proyecto está en el nivel {lvl.get('current', 0)} y esta ronda trabaja para el nivel {lvl.get('next')} · {lvl.get('label')} ({lvl.get('pct', 0)}% cumplido). "
                         "Los requisitos pendientes del nivel están en el contexto (PENDIENTE PARA SUBIR DE NIVEL): verificá cada uno de tu área en el proyecto entregado y, si no está cumplido, "
                         "pedilo como [bloqueante] con archivo y pantalla. No se aprueba el producto sin cumplir el nivel; nada de otros niveles entra como bloqueante.\n")
        ids = ", ".join(a.id for a in others)
        protocol = (
            VOTE_PROTOCOL.format(ids=ids)
            if vote
            else PROTOCOL.format(ids=ids, end=", o END si creés que el debate ya está resuelto" if self.config.mode in ("handoff", "review") else "")
        )
        return (
            context
            + f"Sos {agent.name}, un agente de IA que corre sobre {agent.model} ({PROVIDERS[agent.provider].label}).\n"
            f"Personalidad: {agent.persona or 'libre'}\n{role_txt}\n"
            f"Estás en TABLY TEAM, un experimento en vivo donde modelos de distintas empresas conversan entre sí "
            f"y todo se transmite en pantalla. Idioma: {self.config.language}. Sé conciso, concreto y con carácter; "
            f"podés discrepar con fuerza. No repitas lo que ya se dijo.\n\n"
            f"Los otros participantes:\n{roster}\n\n{protocol}"
            + lang_rule(self.config.language)
        )

    def _user(self, agent: AgentConfig, caller: str | None, reason: str | None, vote: bool = False) -> str:
        lines = []
        for t in self.transcript[-14:]:
            a = self.agents[t["agent_id"]]
            tag = " · CIERRE" if t.get("phase") == "closing" else ""
            lines.append(f"[Turno {t['turn']}{tag}] {a.name} ({a.id}) [{t['stance']}, confianza {t['confidence']}]: {t['message']}")
        history = "\n".join(lines) or "(todavía nadie habló — abrís vos)"
        call = ""
        if caller and not vote:
            call = f"\n\n{self.agents[caller].name} te pasó la palabra porque: {reason}"
        elif not vote and not caller:
            prio = (self.config.review_of or {}).get("priorities") if self.config.mode == "review" else None
            call = ("\n\nAbrís la revisión: empezá por las PRIORIDADES DEL USUARIO (qué encontraste sobre cada una, con archivos/pantallas concretos) y pasale la palabra a quien corresponda."
                    if prio else "\n\nAbrís la sesión: planteá tu postura inicial con fuerza.")
        return f"TEMA: {self.config.topic}\n\nTRANSCRIPCIÓN:\n{history}{call}\n\nTu turno, {agent.name}."

    # ------------------------------------------------------------------ calls
    async def _call(self, agent: AgentConfig, system: str, user: str, *, turn: int | None, vote: bool, judge: bool = False, mock_script: str | None = None, max_tokens: int | None = None, history: list[dict] | None = None) -> tuple[str, str, CallResult]:
        """Provider call. Transient errors (503/529/rate limit) get one quick retry, then the team pauses for the user;
        account errors (no credits, bad key, model gone) pause immediately: the user can top up and retry, or switch the role's model."""
        attempts = 0
        while True:
            try:
                return await self._call_once(agent, system, user, turn=turn, vote=vote, judge=judge, mock_script=mock_script, max_tokens=max_tokens, history=history)
            except Exception as e:
                kind = _classify_error(e)
                if kind is None or self._stop.is_set():
                    raise
                attempts += 1
                if kind == "transient" and attempts == 1:  # one quick automatic retry first
                    self.emit("notice", text=f"{agent.name} ({agent.model}): proveedor saturado. Reintentando en 5 s…")
                    await asyncio.sleep(5)
                    continue
                # stop the team and let the user decide (wait & retry, or switch this role's model)
                self.pause = {"agent_id": agent.id, "provider": agent.provider, "model": agent.model, "error": _clean_error(str(e)), "attempts": attempts, "kind": kind, "phase": "judge" if judge else "vote" if vote else "turn"}
                self.status = "paused"
                self._resume.clear()
                self.emit("session.paused", **self.pause)
                self._save()
                await self._resume.wait()
                if self._stop.is_set():
                    raise
                self.status = "running"
                # the user may have switched the model (or topped up): refresh from config and try again, a few spaced retries
                for wait in (0, 10, 20):
                    if wait:
                        self.emit("notice", text=f"{agent.name} ({agent.model}): reintento en {wait} s…")
                        await asyncio.sleep(wait)
                    try:
                        return await self._call_once(agent, system, user, turn=turn, vote=vote, judge=judge, mock_script=mock_script, max_tokens=max_tokens, history=history)
                    except Exception as e2:
                        k2 = _classify_error(e2)
                        if k2 is None or self._stop.is_set():
                            raise
                        e = e2
                        if k2 != "transient":
                            break  # an account error won't fix itself in 10 s: ask the user again right away
                attempts += 1  # loops back to a new pause with the latest error

    async def _call_once(self, agent: AgentConfig, system: str, user: str, *, turn: int | None, vote: bool, judge: bool = False, mock_script: str | None = None, max_tokens: int | None = None, history: list[dict] | None = None) -> tuple[str, str, CallResult]:
        mt = max_tokens or self.config.max_tokens
        result = CallResult()
        mock = MockContext(agent.name, [(a.id, a.name) for a in self.config.agents if a.id != agent.id], self.config.topic, vote, mock_script)
        text, reasoning = [], []
        name = f"judge · {agent.model}" if judge else f"vote · {agent.name}" if vote else f"turn-{turn:02d} · {agent.name}"
        with obs.observation(as_type="agent", name=name, input={"caller_prompt": user[-2000:]}, metadata={"agent_id": agent.id, "provider": agent.provider}) as span:
            with obs.observation(
                as_type="generation",
                name=f"llm · {agent.model}",
                model=agent.model,
                input=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                model_parameters={"temperature": agent.temperature, "max_tokens": mt},
                metadata={"provider": agent.provider},
            ) as gen:
                try:
                    async for kind, delta in stream(
                        agent.provider, agent.model, system, user,
                        temperature=agent.temperature, max_tokens=mt, result=result, mock=mock, cred=self.creds.get(agent.provider), history=history,
                    ):
                        (reasoning if kind == "reasoning" else text).append(delta)
                        self.emit("token", turn=turn, agent_id=agent.id, kind=kind, delta=delta, vote=vote, judge=judge)
                        if self._stop.is_set():
                            break
                except Exception as e:
                    obs.safe_update(gen, level="ERROR", status_message=str(e)[:500])
                    raise
                full = "".join(text)
                cost = cost_usd(agent.model, result.input_tokens, result.output_tokens, result.cached_input_tokens, result.cache_write_tokens)
                obs.safe_update(
                    gen,
                    output=full,
                    usage_details={"input": result.input_tokens, "output": result.output_tokens},
                    cost_details={"total": cost},
                    metadata={"ttft_ms": round(result.ttft_ms or 0), "native_reasoning": "".join(reasoning)[:2000]},
                )
            obs.safe_update(span, output=parse_tags(full))
        return full, "".join(reasoning), result

    def _metrics(self, agent: AgentConfig, r: CallResult) -> dict:
        return {
            "latency_ms": round(r.latency_ms),
            "ttft_ms": round(r.ttft_ms) if r.ttft_ms else None,
            "input_tokens": r.input_tokens,
            "output_tokens": r.output_tokens,
            "reasoning_tokens": r.reasoning_tokens,
            "cost_usd": cost_usd(agent.model, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.cache_write_tokens),
            "cached_tokens": r.cached_input_tokens,
            "estimated": r.estimated_usage,
            "tokens_per_s": round(r.output_tokens / max(0.001, (r.latency_ms - (r.ttft_ms or 0)) / 1000), 1),
        }

    # ------------------------------------------------------------------ main loop
    async def run(self) -> None:
        cfg = self.config
        self.status = "running"
        ids = [a.id for a in cfg.agents]
        tags = ["tablyteam", cfg.mode] + sorted({a.provider for a in cfg.agents})
        title = cfg.title or cfg.topic
        try:
            with obs.session_trace(self.id, self.owner.email, f"arena · {title}", tags, {"mode": cfg.mode, "agents": ",".join(f"{a.name}:{a.model}" for a in cfg.agents)}, cfg.model_dump()) as root:
                self.trace_id = obs.current_trace_id()
                url = await asyncio.to_thread(obs.trace_url, self.trace_id)
                self.emit(
                    "session.started",
                    session_id=self.id,
                    config=cfg.model_dump(),
                    providers={a.provider: {"label": PROVIDERS[a.provider].label, "color": PROVIDERS[a.provider].color} for a in cfg.agents},
                    langfuse_url=url,
                )
                await asyncio.sleep(0.8)
                await self._conversation(ids)
                if cfg.closing_round and not self._stop.is_set() and any(role_of(a.role) for a in cfg.agents):
                    await self._closing()
                if cfg.mode == "review" and not self._stop.is_set():
                    await self._council()
                elif cfg.final_vote and not self._stop.is_set():
                    await self._vote()
                stats = self._stats()
                obs.safe_update(root, output={"stats": stats, "transcript": self.transcript})
                self._score(stats)
                self.status = "stopped" if self._stop.is_set() else "completed"
                self.emit("session.completed", status=self.status, stats=stats)
        except Exception as e:  # pragma: no cover
            log.exception("session crashed")
            self.status = "error"
            self.emit("session.completed", status="error", error=str(e), stats=self._stats())
        finally:
            self._charge_trial()
            await asyncio.to_thread(obs.flush)  # flush is blocking; keep the event loop free
            self._save()
            for q in list(self.subscribers):
                q.put_nowait(None)

    async def _conversation(self, ids: list[str]) -> None:
        cfg = self.config
        current = cfg.starter if cfg.starter in self.agents else ids[0]
        caller, reason = None, None
        rr_index = ids.index(current)
        for turn in range(1, cfg.max_turns + 1):
            if self._stop.is_set():
                return
            agent = self.agents[current]
            self.emit("turn.started", turn=turn, agent_id=agent.id, caller_id=caller, reason=reason)
            try:
                text, native_reasoning, result = await self._call(agent, self._system(agent), self._user(agent, caller, reason), turn=turn, vote=False)
                text, result = await self._finish_if_cut(agent, self._system(agent), self._user(agent, caller, reason), text, result, turn=turn)
                p = parse_tags(text)
                if not p.get("message", "").strip():  # empty/refused/cut answer: one retry with a nudge and triple the budget
                    log.info("empty turn from %s (truncated=%s), retrying with more room", agent.id, result.truncated)
                    nudge = "\n\n(Tu respuesta anterior llegó vacía o cortada. Respondé ahora, directo, con el formato de etiquetas: primero <message>.)"
                    text, native_reasoning, result = await self._call(agent, self._system(agent), self._user(agent, caller, reason) + nudge, turn=turn, vote=False, max_tokens=max(self.config.max_tokens * 3, 2000))
                    p = parse_tags(text)
            except Exception as e:
                log.warning("agent %s failed: %s", agent.id, e)
                self.emit("agent.error", turn=turn, agent_id=agent.id, error=str(e)[:400])
                p, native_reasoning, result = {"message": f"⚠️ error: {str(e)[:160]}", "stance": "neutral"}, "", CallResult()

            entry = {
                "turn": turn,
                "agent_id": agent.id,
                "responding_to": self.transcript[-1]["agent_id"] if self.transcript else None,
                "thinking": p.get("thinking", ""),
                "native_reasoning": native_reasoning[-4000:],
                "message": p.get("message", "") + (" […]" if getattr(result, "truncated", False) and p.get("message", "").strip() else ""),
                "stance": _norm_stance(p.get("stance")),
                "confidence": _norm_conf(p.get("confidence")),
                "next": (p.get("next") or "").strip().strip("`").lower(),
                "reason": p.get("reason", ""),
                "metrics": self._metrics(agent, result),
            }
            self.transcript.append(entry)
            self.emit("turn.completed", **entry)
            self._save()  # persist after every turn: a crash never loses the run

            # --- who speaks next?
            requested = entry["next"]
            rr_index = (ids.index(current) + 1) % len(ids)
            round_robin = ids[rr_index]
            forced_reason = None
            if cfg.mode in ("handoff", "review"):
                if requested == "end" and turn >= cfg.min_turns:
                    obs.event("conversation-ended-by-agent", metadata={"agent": agent.id, "turn": turn})
                    self.emit("handoff", turn=turn, **{"from": agent.id}, to="END", reason=entry["reason"], requested="END", forced_reason=None)
                    return
                if requested in self.agents and requested != agent.id:
                    nxt = requested
                else:
                    nxt = round_robin
                    forced_reason = "fin prematuro rechazado" if requested == "end" else "id inválido → round-robin"
            else:
                nxt = round_robin
                if requested and requested != round_robin:
                    forced_reason = f"modo {cfg.mode}: turno fijo"

            if turn < cfg.max_turns:
                obs.event(f"handoff {agent.name} → {self.agents[nxt].name}", input={"reason": entry["reason"]}, metadata={"requested": requested, "forced": forced_reason or ""})
                self.emit("handoff", turn=turn, **{"from": agent.id}, to=nxt, reason=entry["reason"], requested=requested, forced_reason=forced_reason)
                caller, reason, current = agent.id, entry["reason"], nxt
                await asyncio.sleep(cfg.pace_ms / 1000)

    async def _closing(self) -> None:
        """Each agent with a role delivers its final decisions for the build document (no debate)."""
        self.emit("closing.started")
        base_turn = len(self.transcript)
        n = 0
        for agent in self.config.agents:
            role = role_of(agent.role)
            if not role or self._stop.is_set():
                continue
            n += 1
            turn = base_turn + n
            self.emit("turn.started", turn=turn, agent_id=agent.id, caller_id=None, reason="ronda de cierre", phase="closing")
            if self.config.mode == "review":
                system = self._system(agent).split("Respondé SIEMPRE con este formato")[0] + CLOSING_REVIEW_PROTOCOL.format(role_label=role["label"], mandate=role["mandate"])
                user = self._user(agent, None, None, vote=True) + f"\n\nRONDA DE CIERRE — tu veredicto final como {role['label']}: APRUEBO o CAMBIOS + lista."
            else:
                system = self._system(agent).split("Respondé SIEMPRE con este formato")[0] + CLOSING_PROTOCOL.format(mandate=role["mandate"])
                user = self._user(agent, None, None, vote=True) + f"\n\nRONDA DE CIERRE — entregá tus decisiones finales como {role['label']}."
            script = None
            if self.config.mode == "review":  # mock/demo agents: a plausible verdict so the council has something to consolidate; from round 2 on they approve (the demo can climb the levels)
                if int((self.config.review_of or {}).get("round") or 1) >= 2:
                    script = f"<reflexion>Los cambios de la ronda anterior están aplicados.</reflexion><message>APRUEBO\n</message><stance>agree</stance><confidence>86</confidence>"
                else:
                    script = (f"<reflexion>Revisé mi área.</reflexion><message>CAMBIOS\n- [bloqueante] Falta validación de entrada en el endpoint principal (revisar {role['label']}).\n"
                              f"- [mejora] Documentar en README cómo correr los tests.</message><stance>propose</stance><confidence>78</confidence>")
            try:
                text, native_reasoning, result = await self._call(agent, system, user, turn=turn, vote=False, mock_script=script, max_tokens=max(self.config.max_tokens * 3, 2500))  # closing decisions are long and structured: never cut them at the debate's per-turn budget
                text, result = await self._finish_if_cut(agent, system, user, text, result, turn=turn)
                p = parse_tags(text)
                if not p.get("message", "").strip():
                    text, native_reasoning, result = await self._call(agent, system, user + "\n\n(Tu respuesta anterior llegó vacía. Respondé ahora.)", turn=turn, vote=False)
                    p = parse_tags(text)
            except Exception as e:
                self.emit("agent.error", turn=turn, agent_id=agent.id, error=f"cierre: {str(e)[:300]}")
                continue
            entry = {
                "turn": turn, "phase": "closing", "agent_id": agent.id, "responding_to": None,
                "thinking": p.get("thinking", ""), "native_reasoning": native_reasoning[-4000:], "message": p.get("message", ""),
                "stance": "propose", "confidence": _norm_conf(p.get("confidence")), "next": "", "reason": "", "metrics": self._metrics(agent, result),
            }
            self.transcript.append(entry)
            self.emit("turn.completed", **entry)
            await asyncio.sleep(self.config.pace_ms / 1000)

    async def _vote(self) -> None:
        self.emit("vote.started")
        tally: Counter = Counter()

        async def one(agent: AgentConfig):
            try:
                text, _, r = await self._call(agent, self._system(agent, vote=True), self._user(agent, None, None, vote=True), turn=None, vote=True)
                p = parse_tags(text)
                target = (p.get("vote") or "").strip().strip("`").lower()
                if target not in self.agents or target == agent.id:
                    target = next((i for i in self.agents if i in target and i != agent.id), None)
                if target:
                    tally[target] += 1
                vote = {"voter": agent.id, "target": target, "reason": p.get("reason", ""), "thinking": p.get("thinking", "")}
                self.votes.append(vote)
                self.emit("vote", **vote, metrics=self._metrics(agent, r))
            except Exception as e:
                self.emit("agent.error", turn=None, agent_id=agent.id, error=f"vote: {str(e)[:300]}")

        with obs.observation(as_type="chain", name="final-vote"):
            await asyncio.gather(*(one(a) for a in self.config.agents))
        top = tally.most_common()
        winner = top[0][0] if top else None
        tie = len(top) > 1 and top[0][1] == top[1][1]
        tiebreak = None
        if tie:  # tie-break: highest average confidence among the tied agents
            tied = [k for k, v in top if v == top[0][1]]
            conf = {k: self._avg_conf(k) for k in tied}
            winner = max(tied, key=lambda k: conf[k] or 0)
            tiebreak = {"rule": "avg_confidence", "tied": tied, "confidence": conf}
        self.verdict = {"winner": winner, "tally": dict(tally), "tie": tie, "tiebreak": tiebreak}
        self.emit("verdict", **self.verdict)
        if winner and self.config.judge != "none" and not self._stop.is_set():
            await self._explain()

    def _avg_conf(self, agent_id: str) -> float | None:
        xs = [t["confidence"] for t in self.transcript if t["agent_id"] == agent_id and t["confidence"] is not None]
        return round(sum(xs) / len(xs), 1) if xs else None

    def _facts(self) -> dict[str, dict]:
        """Hard numbers per agent, shared by the judge prompt and the mock judge."""
        out = {}
        for a in self.config.agents:
            mine = [t for t in self.transcript if t["agent_id"] == a.id]
            out[a.id] = {
                "name": a.name,
                "votes": self.verdict["tally"].get(a.id, 0),
                "voted_by": [self.agents[v["voter"]].name for v in self.votes if v.get("target") == a.id],
                "turns": len(mine),
                "avg_confidence": self._avg_conf(a.id),
                "called_by": sum(1 for e in self.events if e["type"] == "handoff" and e["to"] == a.id),
                "disagreements": sum(1 for t in mine if t["stance"] == "disagree"),
                "proposals": sum(1 for t in mine if t["stance"] == "propose"),
            }
        return out

    async def _explain(self) -> None:
        cfg = self.config
        judge = self.agents.get(cfg.judge or "") or cfg.agents[0]
        winner = self.agents[self.verdict["winner"]]
        facts = self._facts()
        transcript = "\n".join(
            f"[Turno {t['turn']}] {self.agents[t['agent_id']].name} [{t['stance']}, conf {t['confidence']}]: {t['message'][:600]}" for t in self.transcript
        )
        votes = "\n".join(f"- {self.agents[v['voter']].name} votó a {self.agents[v['target']].name if v.get('target') else '—'}: {v.get('reason', '')}" for v in self.votes)
        numbers = "\n".join(
            f"- {f['name']}: {f['votes']} votos, {f['turns']} turnos, confianza prom. {f['avg_confidence']}, lo llamaron {f['called_by']} veces, "
            f"{f['disagreements']} desacuerdos, {f['proposals']} propuestas" for f in facts.values()
        )
        tb = self.verdict.get("tiebreak")
        tie_txt = f"\nHUBO EMPATE entre {', '.join(self.agents[k].name for k in tb['tied'])}; se desempató por confianza promedio {tb['confidence']}." if tb else ""
        user = f"TEMA: {cfg.topic}\n\nTRANSCRIPCIÓN:\n{transcript}\n\nVOTOS:\n{votes}\n\nDATOS:\n{numbers}{tie_txt}\n\nGANADOR: {winner.name} ({winner.model})."
        system = JUDGE_SYSTEM.format(model=judge.model, winner=winner.name, language=cfg.language) + lang_rule(cfg.language)
        self.emit("judge.started", judge_id=judge.id, model=judge.model, provider=judge.provider)
        try:
            text, _, _ = await self._call(judge, system, user, turn=None, vote=False, judge=True, mock_script=self._mock_judge(winner.id, facts))
            p = parse_tags(text)
            if "headline" not in p and "why" not in p:  # model ignored the format: show the raw text as the explanation
                p = {"why": p.get("message", text)}
        except Exception as e:
            log.warning("judge failed: %s", e)
            self.emit("agent.error", turn=None, agent_id=judge.id, error=f"juez: {str(e)[:300]}")
            return
        self.verdict["explanation"] = {k: p.get(k, "") for k in ("headline", "why", "key_moment", "others")}
        self.emit("verdict.explained", **self.verdict["explanation"], judge_id=judge.id, model=judge.model)


    # ------------------------------------------------------------------ review council (mode "review")
    async def _council(self) -> None:
        """Chairman consolidates the closing-round verdicts into one change list for the builder."""
        cfg = self.config
        judge = self.agents.get(cfg.judge or "") or cfg.agents[0]
        closing = [t for t in self.transcript if t.get("phase") == "closing"]
        debate = [t for t in self.transcript if t.get("phase") != "closing"]
        def who(t: dict) -> str:
            a = self.agents[t["agent_id"]]
            return f"{a.name} · {(role_of(a.role) or {}).get('label', '')}"

        transcript = "\n".join(f"[Turno {t['turn']}] {who(t)}: {t['message'][:700]}" for t in debate)
        verdicts = "\n\n".join(f"### {who(t)}\n{t['message'][:1500]}" for t in closing)
        prior = drop_self_approval((cfg.review_of or {}).get("prior_requests") or [])
        prior_txt = ("\n\nÍTEMS PEDIDOS EN LA RONDA ANTERIOR (decidí para cada uno done/partial/pending según el debate y los veredictos):\n"
                     + "\n".join(f"- [{r['id']}] [{r.get('severity', 'mejora')}] {r.get('text', '')[:220]}" for r in prior)) if prior else ""
        prios = split_priorities((cfg.review_of or {}).get("priorities"))
        prio_txt = ("\n\nPRIORIDADES DEL USUARIO (decidí para cada una cumplida/parcial/pendiente; las no cumplidas van a <changes> como [bloqueante] [Usuario]):\n"
                    + "\n".join(f"- [P{i + 1}] {t}" for i, t in enumerate(prios))) if prios else ""
        lvl = (cfg.review_of or {}).get("level") or {}
        # "approved" is this very verdict: asking the council about it would block the approval on itself
        lv_items = [i for i in (lvl.get("items") or []) if isinstance(i, dict) and i.get("text") and i.get("id") != "approved"]
        level_txt = (f"\n\nREQUISITOS DEL NIVEL {lvl.get('next')} · {lvl.get('label')} (decidí para cada uno cumplido/parcial/pendiente según el proyecto y los veredictos; los [team] no cumplidos van a <changes> como [bloqueante] [Nivel {lvl.get('next')}]):\n"
                     + "\n".join(f"- [{i['id']}] [{i.get('who', 'team')}] {i['text']}" for i in lv_items)) if lv_items else ""
        focus_txt = ("\n\nENFOQUE DE LA RONDA: DISEÑO. Los <changes> son únicamente de UI/UX (layout, componentes, paleta, tipografía, estados, interacciones, responsive, pulido) con pantalla y archivo. "
                     "Descartá cualquier pedido de tests, CI, deploy, legales, rendimiento o deuda técnica aunque algún rol lo haya mencionado.") if (cfg.review_of or {}).get("focus") == "design" else ""
        user = f"PROYECTO: {(cfg.review_of or {}).get('title') or cfg.topic} · RONDA {(cfg.review_of or {}).get('round') or 1}\n\nDEBATE DEL CONSEJO:\n{transcript}\n\nVEREDICTOS FINALES POR ROL:\n{verdicts}{prior_txt}{prio_txt}{level_txt}{focus_txt}"
        system = COUNCIL_SYSTEM.format(model=judge.model, language=cfg.language) + lang_rule(cfg.language)
        self.emit("judge.started", judge_id=judge.id, model=judge.model, provider=judge.provider)
        try:
            text, _, jres = await self._call(judge, system, user, turn=None, vote=False, judge=True, mock_script=self._mock_council(closing), max_tokens=4000)
            p = parse_tags(text)
            if jres.truncated:
                log.warning("council output truncated")
        except Exception as e:
            log.warning("council failed: %s", e)
            self.emit("agent.error", turn=None, agent_id=judge.id, error=f"consejo: {str(e)[:300]}")
            p = {}
        changes = parse_changes(p.get("changes", ""))
        roles_asked = []  # what each role asked in its own closing verdict
        for t in closing:
            label = (role_of(self.agents[t["agent_id"]].role) or {}).get("label", "")
            if re.match(r"\s*cambios", t["message"], re.I) or parse_changes(t["message"]):
                for c in parse_changes(t["message"]):
                    roles_asked.append(c | {"role": c["role"] or label})
        if not changes and roles_asked:  # chairman cut short / ignored the format: the roles' own lists are the verdict
            seen = set()
            for c in roles_asked:
                key = re.sub(r"\W+", " ", c["text"].lower())[:80]
                if key not in seen:
                    seen.add(key)
                    changes.append(c)
            changes = changes[:12]
        # the user's priorities: status per item, and anything not fulfilled becomes a blocking change for the builder
        prio_status = parse_resolved(p.get("priorities", "").replace("cumplida", "done").replace("parcial", "partial").replace("pendiente", "pending"),
                                     [{"id": f"P{i + 1}", "text": t} for i, t in enumerate(prios)]) if prios else []
        for ps in prio_status:
            if ps["status"] != "done" and not any("(prioridad del usuario)" in c["text"] and ps["text"][:40].lower() in c["text"].lower() for c in changes):
                changes.append({"severity": "bloqueante", "role": "Usuario", "text": f"(prioridad del usuario) {ps['text']}" + (f" — {ps['note']}" if ps.get("note") else "")})
        # the growth level: every pending team requirement the council did not see fulfilled is a blocking change (the ladder is strict)
        level_status = parse_resolved(p.get("level", "").replace("cumplido", "done").replace("cumplida", "done").replace("parcial", "partial").replace("pendiente", "pending"), lv_items) if lv_items else []
        who = {i["id"]: i.get("who", "team") for i in lv_items}
        for ls in level_status:
            if ls["status"] != "done" and who.get(ls["id"]) == "team" and not any(f"(nivel {lvl.get('next')})" in c["text"].lower() and ls["text"][:40].lower() in c["text"].lower() for c in changes):
                changes.append({"severity": "bloqueante", "role": f"Nivel {lvl.get('next')}", "text": f"(nivel {lvl.get('next')}) {ls['text']}" + (f" — {ls['note']}" if ls.get("note") else "")})
        changes = drop_self_approval(changes)
        # approved = no blocking item left (that is the level's own definition); improvements stay as suggestions to apply or not
        approved = not any(c["severity"] == "bloqueante" for c in changes)
        resolved = parse_resolved(p.get("resolved", ""), prior) if prior else []
        self.verdict = {"winner": None, "tally": {}, "council": {"approved": approved, "headline": p.get("headline", ""), "why": p.get("why", ""), "changes": changes, "resolved": resolved, "priorities": prio_status, "level": {**lvl, "status": level_status} if lv_items else None, "judge_id": judge.id, "model": judge.model}}
        self.emit("council.verdict", **self.verdict["council"], review_of=cfg.review_of)
        # score the version the council just looked at (readiness %, resolved items) on the build itself
        try:
            from .builder import BUILDS

            b = BUILDS.get((cfg.review_of or {}).get("build_id", ""))
            if b and b.user.id == self.owner.id:
                b.on_council_verdict(self.id, self.verdict["council"])
        except Exception as e:  # pragma: no cover
            log.warning("could not score build version: %s", e)

    def _mock_council(self, closing: list[dict]) -> str:
        items = [c for t in closing for c in parse_changes(t["message"])]
        prior = (self.config.review_of or {}).get("prior_requests") or []
        res = "\n".join(f"- [{r['id']}] {'done' if i % 3 != 2 else 'partial'} — se ve en el árbol" for i, r in enumerate(prior))
        res_tag = f"\n<resolved>\n{res}\n</resolved>" if prior else ""
        pr = split_priorities((self.config.review_of or {}).get("priorities"))
        if pr:
            rnd = int((self.config.review_of or {}).get("round") or 1)
            res_tag += "\n<priorities>\n" + "\n".join(f"- [P{i + 1}] {'cumplida' if (i % 2 or rnd >= 2) else 'pendiente'} — simulado" for i in range(len(pr))) + "\n</priorities>"
        lv_items = ((self.config.review_of or {}).get("level") or {}).get("items") or []
        if lv_items:
            res_tag += "\n<level>\n" + "\n".join(f"- [{i['id']}] cumplido — simulado" for i in lv_items) + "\n</level>"
        if not items:
            return "<verdict>approve</verdict><headline>Listo para producción</headline><why>Nadie pidió cambios.</why><changes></changes>" + res_tag
        lines = "\n".join(f"- [{c['severity']}] [{c['role'] or 'Equipo'}] {c['text']}" for c in items[:8])
        return f"<verdict>changes</verdict><headline>Faltan ajustes antes de salir</headline><why>El consejo encontró {len(items)} puntos; los bloqueantes frenan la salida.</why><changes>\n{lines}\n</changes>" + res_tag

    def _mock_judge(self, winner_id: str, facts: dict[str, dict]) -> str:
        w = facts[winner_id]
        best = max(self.transcript, key=lambda t: (t["agent_id"] == winner_id, t["confidence"] or 0), default=None)
        others = [f for k, f in facts.items() if k != winner_id]
        tb = self.verdict.get("tiebreak")
        why = (
            f"{w['name']} ganó con {w['votes']} {'voto' if w['votes'] == 1 else 'votos'}" + (f" de {', '.join(w['voted_by'])}" if w["voted_by"] else "")
            + f": sostuvo su postura con una confianza promedio de {w['avg_confidence']}% y el resto lo convocó {w['called_by']} {'vez' if w['called_by'] == 1 else 'veces'}, señal de que su planteo era el eje de la discusión."
        )
        if tb:
            why += f" Hubo empate en votos y lo definió la confianza: {', '.join(facts[k]['name'] + f' {v}%' for k, v in tb['confidence'].items())}."
        km = f"Turno {best['turn']} — {best['message'][:140]}" if best else ""
        oth = " ".join(f"{o['name']}: {o['disagreements']} desacuerdos y {o['votes']} {'voto' if o['votes'] == 1 else 'votos'}." for o in others)
        return f"<headline>{w['name']} se lleva la arena con el argumento más sólido</headline>\n<why>{why}</why>\n<key_moment>{km}</key_moment>\n<others>{oth}</others>"

    # ------------------------------------------------------------------ stats
    def _stats(self) -> dict:
        per: dict[str, dict] = defaultdict(lambda: {"turns": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "latency": [], "ttft": [], "confidence": [], "stances": Counter(), "called_by": 0})
        for t in self.transcript:
            s = per[t["agent_id"]]
            m = t["metrics"]
            s["turns"] += 1
            s["input_tokens"] += m["input_tokens"]
            s["output_tokens"] += m["output_tokens"]
            s["cost_usd"] += m["cost_usd"]
            s["latency"].append(m["latency_ms"])
            if m["ttft_ms"]:
                s["ttft"].append(m["ttft_ms"])
            if t["confidence"] is not None:
                s["confidence"].append(t["confidence"])
            s["stances"][t["stance"]] += 1
        for ev in self.events:
            if ev["type"] == "handoff" and ev["to"] in per:
                per[ev["to"]]["called_by"] += 1
        avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None  # noqa: E731
        agents = {
            k: {**{x: v[x] for x in ("turns", "input_tokens", "output_tokens", "called_by")}, "cost_usd": round(v["cost_usd"], 5),
                "avg_latency_ms": avg(v["latency"]), "avg_ttft_ms": avg(v["ttft"]), "avg_confidence": avg(v["confidence"]), "stances": dict(v["stances"])}
            for k, v in per.items()
        }
        n = len(self.transcript) or 1
        disagreements = sum(1 for t in self.transcript if t["stance"] == "disagree")
        return {
            "agents": agents,
            "turns": len(self.transcript),
            "total_cost_usd": round(sum(a["cost_usd"] for a in agents.values()), 5),
            "total_tokens": sum(a["input_tokens"] + a["output_tokens"] for a in agents.values()),
            "disagreement_rate": round(disagreements / n, 3),
            "verdict": self.verdict or None,
        }

    def _charge_trial(self) -> None:
        """What the seats on the free Baseten trial spent goes against the trial budget."""
        trial_ids = {a.id for a in self.config.agents if (c := self.creds.get(a.provider)) and c.source == "trial"}
        if trial_ids:
            from . import trial

            cost = sum(v["cost_usd"] for k, v in self._stats()["agents"].items() if k in trial_ids)
            trial.spend(self.owner.id, cost_usd=cost)

    def _score(self, stats: dict) -> None:
        obs.score(self.trace_id, "disagreement_rate", stats["disagreement_rate"], comment="share of turns with stance=disagree")
        obs.score(self.trace_id, "total_cost_usd", stats["total_cost_usd"])
        confs = [a["avg_confidence"] for a in stats["agents"].values() if a["avg_confidence"] is not None]
        if confs:
            obs.score(self.trace_id, "avg_confidence", round(sum(confs) / len(confs), 1))
        v = stats.get("verdict") or {}
        if v.get("winner"):
            w = self.agents[v["winner"]]
            obs.score(self.trace_id, "winner", f"{w.name} ({w.model})", data_type="CATEGORICAL", comment=(v.get("explanation") or {}).get("why"))

    def _save(self) -> None:
        try:
            path = user_dir(self.owner.id) / f"{self.id}.json"
            path.write_text(json.dumps({"id": self.id, "owner": self.owner.id, "status": self.status, "config": self.config.model_dump(), "events": self.events}, ensure_ascii=False))
        except Exception as e:  # pragma: no cover
            log.warning("could not save session: %s", e)

    def summary(self) -> dict:
        return {"id": self.id, "status": self.status, "paused": bool(self.pause), "topic": self.config.topic, "title": self.config.title, "mode": self.config.mode, "review_of": self.config.review_of,
                "cost_usd": round(sum(t["metrics"]["cost_usd"] for t in self.transcript), 5), "turns": len(self.transcript),
                "agents": [{"name": a.name, "provider": a.provider, "model": a.model} for a in self.config.agents],
                "created": self.events[0]["ts"] if self.events else time.time(), "live": self.status in ("pending", "running", "paused")}


SESSIONS: dict[str, Session] = {}


def auto_pick_skills(config: SessionConfig) -> dict[str, list[str]]:
    """The council chooses catalog skills for each role from the task (lexical match + role category). Adds, never removes."""
    from . import skills_catalog
    from .roles import ROLES

    groups = {"Dirección": "ceo", "Producto": "product", "Ingeniería": "backend", "Diseño": "design", "Datos e IA": "data", "Negocio": "growth", "Calidad y seguridad": "qa"}
    picked: dict[str, list[str]] = {}
    for a in config.agents:
        role = next((r for r in ROLES if r["id"] == a.role), None)
        grp = groups.get(role["group"]) if role else None
        text = f"{config.topic}\n{role['mandate'] if role else a.persona}"
        sug = [x["id"] for x in skills_catalog.suggest(text, k=2, role_group=grp) if x.get("score", 0) >= 15]
        new = [x for x in sug if x not in (a.skills or [])]
        if new:
            a.skills = list(a.skills or []) + new
            picked[a.id] = new
    return picked


def start_session(config: SessionConfig, owner: User, creds: dict[str, Cred], auto_pick: bool = True) -> Session:
    if config.auto_skills and auto_pick:
        auto_pick_skills(config)
    s = Session(config, owner, creds)
    SESSIONS[s.id] = s
    s.task = spawn(s.run())
    return s


def estimate_cost(config: SessionConfig) -> dict:
    """Rough USD estimate before launching: per-turn prompt grows with the transcript; closing + vote add calls."""
    from .pricing import price_for

    turns = config.max_turns
    n = len(config.agents)
    per_agent = {}
    total = 0.0
    for i, a in enumerate(config.agents):
        pin, pout = price_for(a.model)
        my_turns = max(1, round(turns / n)) + (1 if config.closing_round else 0) + (1 if config.final_vote else 0)
        avg_in = 1800 + 0.5 * turns * 250  # system + roster + growing transcript
        cost = my_turns * (avg_in * pin + 350 * pout) / 1e6
        per_agent[a.id] = round(cost, 4)
        total += cost
    judge = (6000 * 3 + 400 * 15) / 1e6 if config.final_vote else 0  # ~ a mid-size model
    return {"total_usd": round(total + judge, 3), "per_agent": per_agent, "note": "estimación aproximada; depende del largo real de las respuestas"}


TRANSIENT_HINTS = ("503", "529", "overloaded", "high demand", "rate limit", "rate_limit", "429", "unavailable", "timeout", "temporarily", "capacity", "502", "504")
ACCOUNT_HINTS = ("credit balance", "billing", "insufficient_quota", "quota", "402", "payment", "purchase credits", "api key", "api_key", "authentication", "401", "403", "permission", "unauthorized", "invalid x-api-key", "not_found_error", "model not found", "does not exist", "404")


def _classify_error(e: Exception) -> str | None:
    """'transient' (provider saturated), 'account' (credits/key/model: only the user can fix it), or None (a real bug: propagate)."""
    msg = str(e).lower()
    if any(k in msg for k in ACCOUNT_HINTS):
        return "account"
    if any(k in msg for k in TRANSIENT_HINTS):
        return "transient"
    return None


def _clean_error(msg: str) -> str:
    """Human-readable provider error: keep the vendor's message, drop the JSON noise."""
    m = re.search(r"'message':\s*'([^']+)'", msg) or re.search(r'"message":\s*"([^"]+)"', msg)
    text = m.group(1) if m else msg
    code = re.search(r"\b(503|529|429|500|502|504)\b", msg)
    return (f"HTTP {code.group(1)} · " if code else "") + text[:300]
