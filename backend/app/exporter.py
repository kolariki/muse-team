"""Session exports.

- transcript_markdown(): the debate as a readable Markdown file (no LLM).
- stream_brief(): an LLM turns the debate into a build brief + a ready-to-paste prompt for the agent
  that will build it (Claude Code, Cursor, a chat app…). Streamed, cached next to the session file.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import AsyncIterator, Literal

from pydantic import BaseModel

from . import observability as obs
from .auth import User, user_dir
from .pricing import cost_usd
from . import keystore
from .providers import PROVIDERS, CallResult, MockContext, stream
from .roles import role_of

Target = Literal["claude-code", "cursor", "chat", "generic"]

TARGETS: dict[str, dict[str, str]] = {
    "claude-code": {
        "label": "Claude Code",
        "howto": "El prompt final es para Claude Code (agente en terminal). Debe pedirle: guardar este documento como BRIEF.md en la raíz, "
        "crear un CLAUDE.md con convenciones y comandos del proyecto, armar el plan con su lista de tareas, implementar etapa por etapa "
        "verificando cada una (tests, correr la app), y frenar a preguntar sólo ante decisiones que el brief deja abiertas.",
    },
    "cursor": {
        "label": "Cursor",
        "howto": "El prompt final es para el agente de Cursor. Debe pedirle: guardar el documento como BRIEF.md, crear .cursor/rules/proyecto.mdc "
        "con las convenciones clave, y avanzar etapa por etapa con commits pequeños.",
    },
    "chat": {
        "label": "ChatGPT / Claude.ai",
        "howto": "El prompt final es para pegar en una app de chat (ChatGPT, Claude.ai, Gemini). Debe pedir que primero devuelva la estructura "
        "de carpetas y el plan, y luego el código archivo por archivo, empezando por la etapa 1.",
    },
    "generic": {
        "label": "Cualquier agente",
        "howto": "El prompt final debe ser agnóstico de herramienta: un agente de código cualquiera debe poder seguirlo.",
    },
}

BRIEF_SYSTEM = """Sos un arquitecto de software y product manager senior. Recibís la transcripción de un debate entre agentes de IA
con roles de equipo (TABLY TEAM) y tenés que convertirlo en una ESPECIFICACIÓN DE CONSTRUCCIÓN COMPLETA: el documento que otro
modelo de IA va a usar para construir el producto de punta a punta, sin volver a preguntar.

Reglas:
- Basate en lo que se debatió y, sobre todo, en la RONDA DE CIERRE (decisiones finales de cada rol). Citá quién decidió qué
  (nombre, rol, turno) y resolvé los desacuerdos con una recomendación concreta y su porqué.
- Lo que el equipo no cerró, decidilo vos con criterio y marcálo **(supuesto)**. Nunca dejes un hueco: el constructor no puede preguntar.
- Si el tema no es un producto de software, proponé el entregable construible más útil que materialice la conclusión y especificálo igual.
- Sé exhaustivo y específico: nombres exactos de paquetes y versiones, comandos reales, tablas con columnas y tipos, endpoints con
  request/response, pantallas con sus estados, variables de entorno con nombre exacto. Preferí tablas, listas y bloques de código.
- Idioma: {language}. Extensión esperada: larga (2.500-5.000 palabras). No resumas.
- {howto}

Formato EXACTO (Markdown, con estos encabezados):
# <Nombre del producto>
> <qué es, para quién y qué problema resuelve, en 2 líneas>

## 1. Resumen ejecutivo y métrica de éxito
## 2. Decisiones del equipo
(tabla: Decisión | Quién (rol) | Turno | Por qué · incluí las de la ronda de cierre)
## 3. Desacuerdos y resolución
## 4. Alcance de la primera entrega
(lista "Incluye": TODO lo que el usuario pidió, funcionando de punta a punta — frontend, backend, datos, cuentas, pagos, emails e integraciones que el producto necesite; lista "Después": solo lo que el usuario NO pidió; supuestos)
## 5. Usuarios e historias de usuario
(checklist "- [ ] US-NN · como … quiero … para …" con criterios de aceptación verificables)
## 6. Stack y servicios externos
(tabla: Componente | Tecnología/servicio | Versión | Por qué)
Si el debate no fijó un stack concreto, usá el stack por defecto de Muse Cloud, que se publica con un clic: frontend Vite + React + TypeScript (`npm run build` → `dist/` estático), backend solo si hace falta (FastAPI o Node con Dockerfile), Postgres por `DATABASE_URL`, auth y storage con Supabase, todo configurado por variables de entorno. Nunca dependas de un servidor para servir el frontend si la app puede ser estática.
### 6.1 Cuentas y API keys necesarias
(tabla: Servicio | Para qué | Dónde se obtiene (URL) | Variable de entorno | Plan/costo estimado · si no hace falta ninguna, decilo)
### 6.2 Variables de entorno
(bloque ```env``` con TODAS las variables, valores de ejemplo y comentario)
## 7. Arquitectura
(diagrama ```mermaid```, módulos y responsabilidades, flujo de datos principal)
## 8. Modelo de datos
(bloque ```sql``` con DDL completo: tablas, tipos, claves, índices, constraints; más reglas de negocio sobre los datos)
## 9. Contratos: API / acciones
(tabla o lista por endpoint/acción: método, ruta, auth, request, response, errores)
## 10. Pantallas y flujos de UI
(por pantalla: propósito, elementos, estados vacío/carga/error/éxito, navegación; accesibilidad)
## 11. Estructura del proyecto
(bloque con el árbol de carpetas y archivos principales)
## 12. Setup del entorno
(comandos exactos en bloques ```bash``` para crear el proyecto, instalar dependencias, configurar servicios y correrlo local)
## 13. Plan de construcción por etapas
(Etapa N — objetivo · tickets "T-NN: …" con criterio de terminado · entregable verificable al final de cada etapa)
## 14. Estrategia de pruebas y criterios de aceptación
(qué se testea en cada nivel, casos críticos, comandos para correrlos, gate de release)
## 15. Deploy y operación
(entornos, CI/CD, hosting, dominios, observabilidad, backups, costos mensuales estimados)
## 16. Riesgos, seguridad y preguntas abiertas
## 17. Prompt para el agente constructor
(un único bloque ```text``` autocontenido, listo para copiar y pegar: referencia este documento, indica por dónde empezar,
qué verificar al final de cada etapa, cuándo frenar a preguntar y qué NO hacer)"""


# English headings for the brief (same numbering, so parsers that key on "6.1" / "17." keep working)
BRIEF_HEADINGS_EN = [
    ("Formato EXACTO (Markdown, con estos encabezados):", "EXACT format (Markdown, with these headings, written in English):"),
    ("<Nombre del producto>", "<Product name>"),
    ("<qué es, para quién y qué problema resuelve, en 2 líneas>", "<what it is, who it is for and what problem it solves, in 2 lines>"),
    ("## 1. Resumen ejecutivo y métrica de éxito", "## 1. Executive summary and success metric"),
    ("## 2. Decisiones del equipo", "## 2. Team decisions"),
    ("(tabla: Decisión | Quién (rol) | Turno | Por qué · incluí las de la ronda de cierre)", "(table: Decision | Who (role) | Turn | Why · include the closing round ones)"),
    ("## 3. Desacuerdos y resolución", "## 3. Disagreements and resolution"),
    ("## 4. Alcance de la primera entrega", "## 4. First delivery scope"),
    ('(lista "Incluye" / lista "Fuera de alcance" / supuestos)', '("Included" list / "Out of scope" list / assumptions)'),
    ("## 5. Usuarios e historias de usuario", "## 5. Users and user stories"),
    ('(checklist "- [ ] US-NN · como … quiero … para …" con criterios de aceptación verificables)', '(checklist "- [ ] US-NN · as a … I want … so that …" with verifiable acceptance criteria)'),
    ("## 6. Stack y servicios externos", "## 6. Stack and external services"),
    ("(tabla: Componente | Tecnología/servicio | Versión | Por qué)", "(table: Component | Technology/service | Version | Why)"),
    ("### 6.1 Cuentas y API keys necesarias", "### 6.1 Accounts and API keys needed"),
    ("(tabla: Servicio | Para qué | Dónde se obtiene (URL) | Variable de entorno | Plan/costo estimado · si no hace falta ninguna, decilo)", "(table: Service | What for | Where to get it (URL) | Environment variable | Plan/estimated cost · if none is needed, say so)"),
    ("### 6.2 Variables de entorno", "### 6.2 Environment variables"),
    ("(bloque ```env``` con TODAS las variables, valores de ejemplo y comentario)", "(```env``` block with ALL variables, example values and a comment)"),
    ("## 7. Arquitectura", "## 7. Architecture"),
    ("(diagrama ```mermaid```, módulos y responsabilidades, flujo de datos principal)", "(```mermaid``` diagram, modules and responsibilities, main data flow)"),
    ("## 8. Modelo de datos", "## 8. Data model"),
    ("(bloque ```sql``` con DDL completo: tablas, tipos, claves, índices, constraints; más reglas de negocio sobre los datos)", "(```sql``` block with the full DDL: tables, types, keys, indexes, constraints; plus business rules on the data)"),
    ("## 9. Contratos: API / acciones", "## 9. Contracts: API / actions"),
    ("(tabla o lista por endpoint/acción: método, ruta, auth, request, response, errores)", "(table or list per endpoint/action: method, path, auth, request, response, errors)"),
    ("## 10. Pantallas y flujos de UI", "## 10. Screens and UI flows"),
    ("(por pantalla: propósito, elementos, estados vacío/carga/error/éxito, navegación; accesibilidad)", "(per screen: purpose, elements, empty/loading/error/success states, navigation; accessibility)"),
    ("## 11. Estructura del proyecto", "## 11. Project structure"),
    ("(bloque con el árbol de carpetas y archivos principales)", "(block with the folder tree and main files)"),
    ("## 12. Setup del entorno", "## 12. Environment setup"),
    ("(comandos exactos en bloques ```bash``` para crear el proyecto, instalar dependencias, configurar servicios y correrlo local)", "(exact commands in ```bash``` blocks to create the project, install dependencies, configure services and run it locally)"),
    ("## 13. Plan de construcción por etapas", "## 13. Staged build plan"),
    ('(Etapa N — objetivo · tickets "T-NN: …" con criterio de terminado · entregable verificable al final de cada etapa)', '(Stage N — goal · tickets "T-NN: …" with a definition of done · a verifiable deliverable at the end of each stage)'),
    ("## 14. Estrategia de pruebas y criterios de aceptación", "## 14. Testing strategy and acceptance criteria"),
    ("(qué se testea en cada nivel, casos críticos, comandos para correrlos, gate de release)", "(what is tested at each level, critical cases, commands to run them, release gate)"),
    ("## 15. Deploy y operación", "## 15. Deploy and operations"),
    ("(entornos, CI/CD, hosting, dominios, observabilidad, backups, costos mensuales estimados)", "(environments, CI/CD, hosting, domains, observability, backups, estimated monthly costs)"),
    ("## 16. Riesgos, seguridad y preguntas abiertas", "## 16. Risks, security and open questions"),
    ("## 17. Prompt para el agente constructor", "## 17. Prompt for the builder agent"),
    ("(un único bloque ```text``` autocontenido, listo para copiar y pegar: referencia este documento, indica por dónde empezar,\nqué verificar al final de cada etapa, cuándo frenar a preguntar y qué NO hacer)",
     "(a single self-contained ```text``` block, ready to copy and paste: it references this document, says where to start,\nwhat to verify at the end of each stage, when to stop and ask, and what NOT to do)"),
]


def brief_system(language: str, howto: str) -> str:
    """BRIEF_SYSTEM for the session language: in English the headings themselves are English too (every word of the brief follows the UI language)."""
    from .intake import lang_code

    s = BRIEF_SYSTEM.format(language=language, howto=howto)
    if lang_code(language) == "en":
        for es, en in BRIEF_HEADINGS_EN:
            s = s.replace(es, en)
        s += "\n\nLANGUAGE: the WHOLE document is in English — headings, tables (header rows and cells), lists, notes and the final prompt. Not a single Spanish word."
    return s


class BriefRequest(BaseModel):
    provider: str
    model: str
    target: Target = "claude-code"
    include_transcript: bool = True
    regenerate: bool = False
    user_notes: str = ""  # the decisions as the user edited them in the verdict: they override the debate


def session_path(user: User, session_id: str) -> Path:
    folder = user_dir(user.id)
    path = folder / f"{session_id}.json"
    if path.resolve().parent != folder.resolve():
        raise FileNotFoundError(session_id)
    return path


def _digest(data: dict) -> dict:
    """Rebuild turns / votes / verdict from the event log."""
    ev = data["events"]
    turns = [e for e in ev if e["type"] == "turn.completed"]
    votes = [e for e in ev if e["type"] == "vote"]
    verdict = next((e for e in reversed(ev) if e["type"] == "verdict"), None)
    expl = next((e for e in reversed(ev) if e["type"] == "verdict.explained"), None)
    done = next((e for e in reversed(ev) if e["type"] == "session.completed"), None)
    return {"turns": turns, "votes": votes, "verdict": verdict, "explanation": expl, "stats": (done or {}).get("stats")}


def transcript_markdown(data: dict) -> str:
    cfg = data["config"]
    agents = {a["id"]: a for a in cfg["agents"]}
    d = _digest(data)
    name = lambda i: agents.get(i or "", {}).get("name", i or "—")  # noqa: E731
    stance = {"agree": "🤝 de acuerdo", "disagree": "⚔️ en desacuerdo", "propose": "💡 propone", "neutral": "😐 neutral"}
    started = data["events"][0]["ts"] if data["events"] else time.time()
    out = [
        f"# {cfg.get('title') or cfg['topic']}",
        "",
        f"> Sesión `{data['id']}` · {time.strftime('%Y-%m-%d %H:%M', time.localtime(started))} · modo **{cfg['mode']}** · {len(d['turns'])} turnos",
        "",
        "## Tema",
        "",
        cfg["topic"],
        "",
        "## Participantes",
        "",
        "| Agente | Rol | Proveedor | Modelo | Personalidad |",
        "|---|---|---|---|---|",
        *[f"| {a['name']} | {(role_of(a.get('role')) or {}).get('label', '—')} | {a.get('wanted_provider') or a['provider']} | `{a['model']}` | {a.get('persona', '').replace('|', '/')} |" for a in cfg["agents"]],
        "",
        "## Debate",
        "",
    ]
    closing = [t for t in d["turns"] if t.get("phase") == "closing"]
    for t in d["turns"]:
        if t.get("phase") == "closing":
            continue
        resp = f" — responde a {name(t['responding_to'])}" if t.get("responding_to") else ""
        conf = f" · confianza {t['confidence']}%" if t.get("confidence") is not None else ""
        out += [f"### Turno {t['turn']} · {name(t['agent_id'])}{resp}", "", f"*{stance.get(t['stance'], t['stance'])}{conf}*", ""]
        if t.get("thinking"):
            out += [f"> 💭 {t['thinking']}", ""]
        out += [t["message"], ""]
        if t.get("next"):
            out += [f"→ le pasa la palabra a **{name(t['next']) if t['next'] != 'end' else 'FIN'}**: _{t.get('reason', '')}_", ""]
    if closing:
        out += ["## Ronda de cierre: decisiones finales por rol", ""]
        for t in closing:
            a = agents.get(t["agent_id"], {})
            r = role_of(a.get("role"))
            out += [f"### {a.get('name', t['agent_id'])}" + (f" · {r['label']}" if r and r["label"].lower() != a.get("name", "").lower() else ""), ""]
            if t.get("thinking"):
                out += [f"> {t['thinking']}", ""]
            out += [t["message"], ""]
    if d["verdict"]:
        v = d["verdict"]
        out += ["## Veredicto", "", f"**Ganador: {name(v['winner'])}**" + (" (desempate por confianza)" if v.get("tie") else ""), ""]
        out += ["| Agente | Votos |", "|---|---|", *[f"| {name(k)} | {n} |" for k, n in sorted(v["tally"].items(), key=lambda x: -x[1])], ""]
        for vo in d["votes"]:
            out.append(f"- {name(vo['voter'])} votó a **{name(vo.get('target'))}**: _{vo.get('reason', '')}_")
        out.append("")
        if e := d["explanation"]:
            out += [f"### Por qué ganó: {e.get('headline', '')}", "", e.get("why", ""), "", f"**Momento clave:** {e.get('key_moment', '')}", "", f"**Al resto le faltó:** {e.get('others', '')}", ""]
    if s := d["stats"]:
        out += ["## Métricas", "", "| Agente | Turnos | Tokens salida | Latencia prom. | Costo |", "|---|---|---|---|---|"]
        for k, a in s.get("agents", {}).items():
            out.append(f"| {name(k)} | {a['turns']} | {a['output_tokens']} | {round((a.get('avg_latency_ms') or 0) / 1000, 1)} s | ${a['cost_usd']} |")
        out += ["", f"Total: {s.get('total_tokens')} tokens · ${s.get('total_cost_usd')} · desacuerdo {round(100 * (s.get('disagreement_rate') or 0))}%", ""]
    return "\n".join(out)


def _mock_brief(data: dict, target: str) -> str:
    cfg = data["config"]
    agents = {a["id"]: a["name"] for a in cfg["agents"]}
    d = _digest(data)
    props = [t for t in d["turns"] if t["stance"] == "propose"] or d["turns"][:3]
    dis = [t for t in d["turns"] if t["stance"] == "disagree"]
    title = cfg.get("title") or cfg["topic"][:60]
    rows = "\n".join(f"| {t['message'][:90].replace('|', '/')}… | {agents.get(t['agent_id'])} | {t['turn']} | {t.get('reason', '')[:60]} |" for t in props[:5])
    disl = "\n".join(f"- **{agents.get(t['agent_id'])}** (turno {t['turn']}) objetó: {t['message'][:120]}… → **Recomendación (supuesto):** priorizar la opción más barata de validar." for t in dis[:3]) or "- No hubo desacuerdos fuertes."
    return f"""# {title}
> Brief generado en modo simulado (sin API) a partir del debate. Con un modelo real este documento es mucho más específico.

## 1. Objetivo y métrica de éxito
Materializar la conclusión del debate sobre: {cfg['topic']}
Métrica **(supuesto)**: un prototipo usable por 5 personas en 2 semanas.

## 2. Decisiones del debate
| Decisión | Propuesta por | Turno | Por qué |
|---|---|---|---|
{rows}

## 3. Desacuerdos y resolución recomendada
{disl}

## 4. Alcance de la primera entrega
**Incluye:** flujo principal, persistencia simple, una pantalla de resultados.
**Fuera de alcance:** pagos, multi-idioma, app móvil.

## 5. Requisitos funcionales
- [ ] Flujo principal de punta a punta
- [ ] Guardar y listar resultados
- [ ] Exportar resultados

## 6. Arquitectura y stack
```mermaid
flowchart LR
  UI[Frontend React] --> API[API FastAPI]
  API --> DB[(SQLite)]
```

## 7. Plan de implementación por etapas
**Etapa 1:** esqueleto del proyecto y modelo de datos → la app arranca y persiste.
**Etapa 2:** flujo principal → se puede completar de punta a punta.
**Etapa 3:** pulido, exportación y tests → criterios de aceptación en verde.

## 8. Criterios de aceptación
- El flujo principal funciona sin errores en un entorno limpio.
- Hay tests para la lógica central.

## 9. Riesgos y preguntas abiertas
- El debate no fijó presupuesto ni usuarios objetivo concretos.

## 6.1 Cuentas y API keys necesarias
| Servicio | Para qué | Dónde | Variable | Costo |
|---|---|---|---|---|
| (ninguno en modo simulado) | | | | |

## 17. Prompt para el agente constructor
```text
Leé BRIEF.md (este documento). Es la especificación de un proyecto surgido de un debate entre agentes de IA.
{TARGETS[target]['howto']}
Empezá por la Etapa 1 y mostrame el plan antes de escribir código.
```"""


SCOPE_SYSTEM = """Antes de construir, leés lo que pidió una persona sin formación técnica. Buscá UNA sola cosa: una contradicción real, o una decisión que cambie mucho cuánto hay que construir y que no se pueda decidir con criterio (por ejemplo: «sin servidor» junto con «que los datos se guarden para todos»).
Si se puede decidir con criterio, no preguntes: casi siempre se puede. Nunca preguntes colores, nombres ni gustos.
Respondé SOLO con JSON. Sin nada que aclarar: {{"pregunta": null}}. Si hay que aclarar: {{"pregunta": "una pregunta corta, en palabras simples", "opciones": ["2 o 3 respuestas cortas, que digan qué se va a construir"]}}. Idioma: {language}."""


def parse_scope_question(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        d = json.loads(m.group(0)) if m else None
    except ValueError:
        return None
    if not isinstance(d, dict) or not d.get("pregunta"):
        return None
    options = [str(o).strip()[:140] for o in (d.get("opciones") or []) if str(o).strip()][:3]
    return {"question": str(d["pregunta"]).strip()[:300], "options": options} if len(options) >= 2 else None


async def scope_question(user: User, topic: str, language: str, provider: str, model: str, engine: str | None = None) -> dict | None:
    """The one question worth asking before a long build; None (keep going) when there is none or nobody can read the request."""
    system = SCOPE_SYSTEM.format(language=language)
    if engine:
        from .local_engine import ask_engine

        return parse_scope_question((await ask_engine(user.id, engine, system, topic[:12000])).get("text") or "")
    cred = keystore.creds(user.id).get(provider)
    if provider not in PROVIDERS or PROVIDERS[provider].kind == "mock" or not cred or cred.source == "none":
        return None
    parts: list[str] = []
    async for kind, delta in stream(provider, model, system, topic[:12000], temperature=0, max_tokens=400, result=CallResult(), mock=MockContext("Arquitecto", [("x", "x")], topic[:60], script='{"pregunta": null}'), cred=cred):
        if kind == "text":
            parts.append(delta)
    return parse_scope_question("".join(parts))


async def stream_brief(user: User, session_id: str, req: BriefRequest, engine: str | None = None) -> AsyncIterator[str]:
    path = session_path(user, session_id)
    cache = path.with_suffix(f".brief.{req.target}.md")
    data = json.loads(path.read_text())
    transcript = transcript_markdown(data)
    appendix = f"\n\n---\n\n<details>\n<summary>Anexo: transcripción completa del debate</summary>\n\n{transcript}\n\n</details>\n" if req.include_transcript else ""

    notes = (req.user_notes or "").strip()[:12000]
    if notes:  # edited decisions change the brief: never serve the cached one, and regenerate from them
        req.regenerate = True
    if cache.exists() and not req.regenerate:
        body = cache.read_text()
        yield body + appendix
        return

    cred = keystore.creds(user.id).get(req.provider)
    if req.provider not in PROVIDERS or not cred or cred.source == "none":
        raise ValueError(f"Proveedor sin configurar: {req.provider}")
    cfg = data["config"]
    system = brief_system(cfg.get("language", "español"), TARGETS[req.target]["howto"])
    if cfg.get("mode") == "direct":
        # the fast lane: no debate, the (prompt-engineered) request is the whole input
        user_msg = ("PEDIDO DEL USUARIO (ya pasó por prompt engineering; no hubo debate de equipo). Convertilo en el brief completo: donde el pedido no decide algo, "
                    "decidilo vos con el criterio de un equipo senior y marcalo como «(supuesto)». Lo que el pedido decide o excluye manda, y el alcance es el mínimo que lo cumple: sin cuentas, servidor, panel ni integraciones que el pedido no necesite. El brief no se contradice: si en el Alcance no hay servidor, el stack y la arquitectura tampoco. Las secciones «Decisiones del debate» y «Desacuerdos» pasan a ser "
                    "«Decisiones tomadas» y «Alternativas descartadas», con el porqué.\n\n" + str(cfg.get("topic") or ""))
        if cfg.get("context") and "Referentes" not in str(cfg.get("context")):
            user_msg += f"\n\nCONTEXTO ADJUNTO POR EL USUARIO:\n{str(cfg['context'])[:20000]}"
    else:
        user_msg = f"DEBATE A CONVERTIR EN BRIEF:\n\n{transcript}"
    plat = cfg.get("platform") or "web"
    if plat == "mobile":
        user_msg += ("\n\nPLATAFORMA ELEGIDA POR EL USUARIO: APP MÓVIL (iOS y Android). El brief es para una app móvil: stack por defecto Expo (React Native) + TypeScript + expo-router, "
                     "pantallas de teléfono con navegación nativa, publicación en App Store y Google Play (EAS Build) como etapa final, backend aparte solo si hace falta. No propongas una web app.")
    elif plat == "both":
        user_msg += ("\n\nPLATAFORMA ELEGIDA POR EL USUARIO: WEB + MÓVIL (iOS y Android). El brief cubre las dos: stack por defecto Expo (React Native) + TypeScript + expo-router con react-native-web "
                     "(un solo código), web responsive publicable como estático y app móvil para las tiendas; backend aparte solo si hace falta. Marcá qué pantallas difieren entre web y móvil.")
    if cfg.get("context") and "Referentes" in str(cfg.get("context")):
        clone = bool(cfg.get("deep_analysis")) or "Plano de clonación" in str(cfg.get("context"))
        if clone:
            user_msg += ("\n\nMODO CLON (ingeniería inversa activada por el usuario): el producto es una RÉPLICA del referente principal, igual en todo salvo nombre, logo y textos. "
                         "El brief NO fija paleta, tipografía, grilla ni componentes propios: en diseño y comportamiento remite al plano de clonación de research/REFERENCES.md y dice "
                         "explícitamente que el referente manda sobre cualquier decisión visual del debate. El brief define nombre, logo, textos propios, stack y funcionalidades adicionales.")
        user_msg += f"\n\nBENCHMARK DE REFERENTES (investigado antes del debate; {'es el plano a replicar 1:1' if clone else 'el brief tiene que reflejar qué emular y qué evitar'}):\n{str(cfg['context'])[:20000]}"
    if notes:
        user_msg = f"DECISIONES FINALES EDITADAS POR EL USUARIO (tienen prioridad absoluta sobre lo dicho en el debate; si contradicen algo del debate, mandan estas):\n\n{notes}\n\n" + user_msg
    header = (
        f"<!-- Muse Team · brief de construcción · sesión {session_id} · escrito por {req.model} · "
        f"para {TARGETS[req.target]['label']} · {time.strftime('%Y-%m-%d %H:%M')} -->\n\n"
    )
    yield header
    if engine:  # no API key: the subscription writes it, instead of the simulated brief
        from .local_engine import ask_engine

        try:
            text = ((await ask_engine(user.id, engine, system, user_msg)).get("text") or "").strip()
        except ValueError:
            text = ""
        if text:
            yield text
            if len(re.findall(r"^## \d+\.", text, re.M)) >= 12:
                cache.write_text(header + text)
            yield appendix
            return
    parts: list[str] = []
    result = CallResult()
    mock = MockContext("Arquitecto", [("x", "x")], cfg["topic"], script=_mock_brief(data, req.target))
    with obs.session_trace(session_id, user.email, f"brief · {cfg.get('title') or cfg['topic']}"[:200], ["tablyteam", "brief", req.target], {"target": req.target}, {"session": session_id}):
        with obs.observation(as_type="generation", name=f"brief · {req.model}", model=req.model, input=[{"role": "system", "content": system}, {"role": "user", "content": user_msg}]) as gen:
            async for kind, delta in stream(req.provider, req.model, system, user_msg, temperature=0.4, max_tokens=16000, result=result, mock=mock, cred=cred):
                if kind == "text":
                    parts.append(delta)
                    yield delta
            obs.safe_update(gen, output="".join(parts), usage_details={"input": result.input_tokens, "output": result.output_tokens}, cost_details={"total": cost_usd(req.model, result.input_tokens, result.output_tokens)})
        # a brief has 17 numbered sections; if the model stopped early (max_tokens, hiccup), ask it to continue where it left off
        for _ in range(3):
            text_so_far = "".join(parts)
            sections = len(re.findall(r"^## \d+\.", text_so_far, re.M))
            if not (result.truncated or sections < 12) or mock.script:
                break
            tail = text_so_far[-1500:]
            cont = CallResult()
            more: list[str] = []
            with obs.observation(as_type="generation", name=f"brief · continuación · {req.model}", model=req.model, input=[{"role": "user", "content": "continuar"}]) as gen2:
                async for kind, delta in stream(req.provider, req.model, system,
                                                f"{user_msg}\n\n---\nYa escribiste este brief hasta acá (termina en):\n…{tail}\n\nCONTINUÁ EXACTAMENTE desde ese punto, sin repetir nada ni volver a empezar, hasta completar las 17 secciones.",
                                                temperature=0.4, max_tokens=16000, result=cont, mock=mock, cred=cred):
                    if kind == "text":
                        more.append(delta)
                        yield delta
                obs.safe_update(gen2, output="".join(more), usage_details={"input": cont.input_tokens, "output": cont.output_tokens})
            if not "".join(more).strip():
                break
            parts.append("\n" + "".join(more))
            result.truncated = cont.truncated
    await asyncio.to_thread(obs.flush)
    body = header + "".join(parts).strip()
    if len(re.findall(r"^## \d+\.", body, re.M)) >= 12 or mock.script:
        cache.write_text(body)  # incomplete briefs are shown but not cached: "regenerar" starts clean
    yield appendix
