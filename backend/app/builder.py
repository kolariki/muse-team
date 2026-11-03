"""In-app builder: a model turns the build brief into a real project, file by file, stage by stage.

The builder talks a tiny tag protocol (provider-agnostic, streamed):
    <say>short Markdown: what I'm doing / decisions</say>
    <file path="relative/path.ext">full file contents</file>
    <stage n="1">what was delivered + how to verify</stage>
    <done>how to run the finished product</done>

Events (WebSocket /ws/builds/{id}):
    build.started {build}            turn.started {turn}            token {delta}
    file.written {path, size, lines} turn.completed {say, files, stage, done}
    preview.ready {path, html}       (self-contained prototype of the finished product)
    pass.completed {status}          one build pass ended (the pipeline may continue with a review)
    review.started {round, reviewers} review.token {round, agent_id, delta} review.result {round, agent_id, verdict, findings, requests}
    review.completed {round, approved, requests}   build.approved {round}

Pre-production review loop: the session's team (its roles) reviews the finished project in parallel; change
requests go back to the builder; the council reviews again, until everyone approves or max rounds.
    user.message {text}              build.completed {status, files}   error {error}

Files only exist on the server (no code is executed); the user downloads the project as a .zip.
State is persisted next to the arena session: <user>/<session>.build.<id>.json
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from . import observability as obs
from .tasks import spawn
from .auth import User, user_dir
from .pricing import cost_usd
from . import versions as vers
from .expertise import expertise_block, quality_bar
from . import skills as skillmod
from .design import BUILDER_DESIGN_RULE, ENGINE_DESIGN_PROMPT, MOCK_DESIGN, DESIGN_USER, design_context_for_builder, design_system_prompt, POLISH_PROMPT, frontend_design_guide
from .providers import PROVIDERS, CallResult, Cred, MockContext, stream
from .local_engine import ENGINES, is_engine, run_engine, snapshot_dir, sync_files, workdir, USER_ENV, user_claude_env
from .roles import role_of
from . import research as rsch
from . import uikit
from . import levels as levelsmod
from . import delivery

log = logging.getLogger("arena.builder")

MAX_TURNS = 30
MAX_FILE_BYTES = 400_000

BUILDER_SYSTEM = """Sos un ingeniero de software senior. Tu trabajo: CONSTRUIR el producto descripto en BRIEF.md (abajo), completo y
funcional, archivo por archivo, siguiendo su plan por etapas. Trabajás en turnos: en cada turno entregás una etapa (o parte).

PROTOCOLO DE SALIDA (obligatorio, sin texto fuera de las etiquetas):
<say>qué vas a hacer en este turno y las decisiones que tomás, en Markdown breve (3-8 líneas)</say>
<file path="ruta/relativa/al/archivo.ext">
contenido COMPLETO del archivo (nunca fragmentos, nunca "..." ni "resto igual")
</file>
(repetí <file> por cada archivo; podés reescribir un archivo existente entregándolo entero)
<stage n="N">qué quedó entregado en esta etapa y cómo verificarlo (comandos)</stage>   ← al cerrar una etapa
<done>cómo instalar, configurar (.env) y correr el producto terminado</done>            ← SOLO cuando TODO el brief está construido
<read path="ruta/relativa"/>  ← si necesitás ver el contenido actual de un archivo ya escrito antes de modificarlo: pedilo así (hasta 8 por turno) y lo recibís en el turno siguiente. Nunca pidas que una persona te pegue archivos.

ESTÁNDAR DE CALIDAD (el equipo que diseñó el producto lo va a revisar con esta vara; construí para aprobarla a la primera):
{quality_bar}

{design_rule}
REGLAS:
- Código real, completo, que compila y corre. Nada de pseudocódigo, TODOs vacíos ni placeholders.
- Primera etapa: estructura del proyecto, README.md (setup), .env.example con TODAS las variables del brief, dependencias y config base.
- Publicable con un clic (Muse Cloud): si es frontend, `npm run build` tiene que dejar un `dist/` (o `build/`/`out/`) estático que funcione servido desde cualquier ruta (assets relativos o `base` configurable por `--base`); si tiene servidor, tiene que arrancar con la variable `PORT` y escuchar en `0.0.0.0`, con un `Dockerfile` si no es Node o Python estándar. Postgres solo por `DATABASE_URL`; sin `DATABASE_URL` (al probarla en Muse Team) los datos se guardan en disco en la carpeta de `TABLY_DATA_DIR` (o `.data/`, ignorada en git y Docker): PGlite con dataDir o SQLite, nunca solo en memoria, y el seed de ejemplo solo si la base está vacía, así lo que se crea al probar no se pierde; auth y storage por Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
- Si la app llama a modelos de IA: cada llamada se reporta a Muse Team desde el servidor (un helper `reportAI` fire-and-forget: POST `${{TABLY_URL}}/api/llm/${{TABLY_SITE}}` con `Authorization: Bearer ${{TABLY_TOKEN}}` y {{provider, model, name, input_tokens, output_tokens, latency_ms, status, error}}); si TABLY_URL no existe no hace nada. Muse Team carga esas variables al publicar.
- Si la app usa datos de cuentas del usuario (su Google Calendar…), los lee de Muse Team desde el servidor: GET `${{TABLY_URL}}/api/connect/${{TABLY_SITE}}/google-calendar/events?from=<ISO>&to=<ISO>` con `Authorization: Bearer ${{TABLY_TOKEN}}` → {{connected, account, calendars, events:[{{id,calendar,title,start,end,all_day,location,description,link,meet,attendees}}]}}; nunca OAuth propio ni claves de Google; si connected es false, un estado claro «Conectá tu Google Calendar en Muse Team → Servicios».
- Identidad propia (apps web): un logo diseñado para esta app en SVG (`public/logo.svg`: símbolo + nombre, para el header) y su ícono (`public/icon.svg`: el símbolo solo, cuadrado, legible a 16 px) con los colores del diseño; el header usa el logo, nunca un ícono genérico de librería, y el HTML de entrada enlaza `<link rel="icon" href="/icon.svg" type="image/svg+xml">` y `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` (los PNG los genera Muse Team al publicar).
{delivery_rule}- Respetá el stack, el modelo de datos, los contratos y las pantallas del brief. Si algo falta, decidilo y anotalo en NOTES.md.
- Cada archivo se entrega una sola vez por turno. Un archivo por <file>. Rutas sin "./" inicial.
- MÁXIMO 4 archivos por turno (o menos si son largos): tu salida tiene un límite y un archivo cortado no sirve. Si una etapa
  necesita más archivos, repartila en varios turnos y cerrá la etapa en el último.
- Cuando el usuario te escriba, incorporá su pedido y seguí.
- Idioma de <say>/<stage>/<done>: {language}. Código y comentarios: como corresponda al proyecto.
- Cuando el producto esté completo según el brief, emití <done>. No alargues: calidad sobre cantidad."""

PREVIEW_PATH = "preview/index.html"
DESIGN_MOCKUP = "design/mockup.html"
PREVIEW_PROMPT = """El producto está construido. Ahora generá la VISTA PREVIEW: un único archivo `preview/index.html` AUTOCONTENIDO
(todo el CSS y JS inline; sin frameworks ni bundlers; sin peticiones a servidores; como máximo fuentes de Google Fonts por <link>)
que muestre el producto terminado tal como lo vería el usuario final: las pantallas principales navegables entre sí (JS vanilla),
con datos de ejemplo realistas, el mismo diseño, textos y flujos del brief y del código que escribiste. Debe verse pulido y
funcionar al abrirlo en un navegador sin instalar nada. Responsive. Si el producto no es una interfaz web, mostrá su resultado
de la forma más fiel posible (p. ej. una consola simulada o un documento). Entregalo con <say> breve y un único <file>."""

FILE_RE = re.compile(r'<file\s+path="([^"\n]+)"\s*>\n?(.*?)</file>', re.S)
SAY_RE = re.compile(r"<say>(.*?)</say>", re.S)
STAGE_RE = re.compile(r'<stage\s+n="?(\d+)"?\s*>(.*?)</stage>', re.S)
DONE_RE = re.compile(r"<done>(.*?)</done>", re.S)


CONTINUE = "__continue__"


class BuildRequest(BaseModel):
    session_id: str
    provider: str
    model: str
    target: str = "claude-code"
    review_rounds: int = 0  # >0: after the build, the team reviews and the loop runs up to N rounds
    council: bool = True  # review as a live arena debate (same UI as the design debate) instead of silent parallel reviews
    priorities: str = ""  # what the user wants the council to treat first (next round)
    design: bool = True  # Product Designer designs the UI (design/) before any code is written
    design_review: bool = True  # pause after the design so the user approves it (or asks for changes) before any code
    research: bool = False  # level 1: look at reference apps (user's list, or proposed from the brief) before designing
    references: list[str] = []  # reference apps / URLs the team studies first
    deep_analysis: bool = False  # level 2 (paid per use): REA reverse-engineering tools for the builder engine on those targets
    platform: str = "web"  # web | mobile | both (from the session config): decides the default stack and how the app runs
    references_auto: bool = False  # the references are the preset's (not the user's): used silently, never named in the chat
    language: str = "español rioplatense"  # the session language: <say>/<stage>/<done>, the design copy and the audit report come out in it


RESEARCH_PATH = "research/REFERENCES.md"
DEEP_ANALYSIS_LABEL = "Análisis profundo e ingeniería inversa (REA)"
REA_PROMPT = """

ANÁLISIS PROFUNDO (pago por uso, activado por el usuario): tenés disponibles las herramientas MCP de REA (Reverse Engineer Anything).
Usalas SOLO sobre los referentes listados en research/REFERENCES.md: analizá sus bundles de JavaScript, rutas, llamadas a API, estructura
de pantallas y flujos para ENTENDER cómo están construidos (arquitectura, estados, datos que manejan, patrones de UI). Documentá lo que
aprendiste en research/DEEP_ANALYSIS.md con evidencia. Está prohibido copiar código, assets, textos o marcas de terceros: se aprende el
mecanismo y se implementa una versión propia para nuestro producto."""


def design_platform_note(platform: str) -> str:
    if platform == "mobile":
        return ("\n\nPLATAFORMA MÓVIL: diseñá pantallas de teléfono (marco 390×844 con safe areas, barra de estado, tabs o stack nativos, gestos). "
                "El mockup muestra cada pantalla dentro de un marco de teléfono, con las convenciones de iOS y Android donde difieran (indicá ambas).")
    if platform == "both":
        return ("\n\nPLATAFORMA WEB + MÓVIL: diseñá cada pantalla clave en dos versiones, escritorio (1440) y teléfono (390×844 con safe areas y navegación nativa), "
                "con el mismo sistema visual. El mockup muestra ambas.")
    return ""


def platform_note(platform: str) -> str:
    """What «web», «mobile» or «both» means for the stack, the screens and what has to run at the end."""
    if platform == "mobile":
        return ("\n\nPLATAFORMA: APP MÓVIL (iOS y Android). Stack por defecto salvo que el brief fije otro: Expo (React Native) con TypeScript, expo-router, "
                "app.json con nombre/ícono/splash propios, `npx expo start` como script `dev` (tiene que correr en el simulador de iOS, en el emulador de Android y en Expo Go). "
                "Diseñá para pantalla de teléfono (390×844) con safe areas, navegación nativa (tabs/stack), gestos y estados de carga; nada de layouts de escritorio. "
                "Tests con jest-expo. Si hace falta backend, va aparte (FastAPI o Node, con Dockerfile) y la app lo consume por HTTP con la URL en variables EXPO_PUBLIC_*. "
                f"Igual creá `{PREVIEW_PATH}` como maqueta HTML de las pantallas en un marco de teléfono.")
    if platform == "both":
        return ("\n\nPLATAFORMA: WEB + MÓVIL (iOS y Android). Stack por defecto salvo que el brief fije otro: Expo (React Native) con TypeScript y expo-router, "
                "con soporte web de primera clase (react-native-web): un solo código, `npx expo start --web` para la web y `npx expo start` para los dispositivos. "
                "La web tiene que ser responsive y usable con mouse y teclado; el móvil con safe areas y navegación nativa. app.json con nombre/ícono/splash. "
                "Backend aparte si hace falta (FastAPI o Node, Dockerfile), consumido por HTTP con EXPO_PUBLIC_*. "
                f"`npx expo export --platform web` tiene que dejar un `dist/` estático publicable. Creá también `{PREVIEW_PATH}`.")
    return ""


CLONE_NOTE = (f"\n\nMODO CLON (ingeniería inversa activada por el usuario): el objetivo es que nuestro producto sea una RÉPLICA del referente principal, para usarla como base e iterar después. "
              "REGLA DE PRECEDENCIA: en todo lo visual y de comportamiento manda el referente, por encima de BRIEF.md, DESIGN.md y de cualquier sistema de diseño o guía propia; "
              "si el brief o el diseño fijan paleta, tipografía, grilla, radios o componentes distintos del referente, se ignoran y se usa lo del referente. "
              "Nada de «patrones a evitar» ni mejoras de criterio propio: lo que el referente hace, se replica. "
              f"En {RESEARCH_PATH} está el «Plano de clonación» y en research/shots/ las capturas reales (abrí las imágenes y compará lado a lado). Reproducí 1:1: la estructura de cada pantalla, "
              "el layout y las proporciones exactas, la paleta (mismos hex), la tipografía (la misma familia si es libre; si no, la equivalente más cercana), los componentes y sus estados, "
              "la navegación, los flujos, las interacciones, el motion y TODAS las funcionalidades visibles, con datos reales o de ejemplo coherentes. Usá las herramientas de REA sobre el referente "
              "para entender cómo está construido (rutas, estados, llamadas, estructura de pantallas) y replicar el comportamiento, no solo el aspecto. "
              "Lo ÚNICO que cambia: el nombre, el logo y los textos literales (reescribilos con el mismo sentido y largo). No copies imágenes, íconos de marca, assets ni código del sitio: todo se implementa propio. "
              "Criterio de terminado: abierto al lado del referente, se ve y se siente igual.")

PREVIEW_RULE = (f"\n\nREGLA DEL PROTOTIPO: `{PREVIEW_PATH}` es la vista previa que el usuario abre en Muse Team sin correr nada, dentro de un iframe aislado. "
                "Tiene que funcionar SOLO, sin backend ni servidor: datos de ejemplo dentro del propio prototipo, sin llamadas a la API real, sin login, "
                "sin depender de localStorage para arrancar. Nunca lo conviertas en cliente de la API de la app: la app real (apps/, src/…) es la que se conecta "
                "al backend; el prototipo la refleja con datos de ejemplo. Si cambian las pantallas, actualizalo con los mismos datos de ejemplo.")


FIDELITY_NOTE = (f"\n\nFIDELIDAD AL REFERENTE: en {RESEARCH_PATH} está el «Plano visual objetivo» y en research/shots/ las capturas reales (abrí las imágenes y miralas). "
                 "Reproducí la estructura visual lo más fielmente posible: distribución y proporciones de las regiones, componentes y su estilo, paleta (hex), tipografía equivalente, "
                 "espaciado, interacciones y comportamiento móvil. Con elementos propios: nunca assets, logos, marcas, textos ni código de terceros.")


# ------------------------------------------------------------------ self-contained HTML for the panes
_LINK_RX = re.compile(r"<link\b[^>]*>", re.I)
_SCRIPT_RX = re.compile(r"<script\b([^>]*)\bsrc=[\"']([^\"']+)[\"']([^>]*)>\s*</script>", re.I)
# a sandboxed srcdoc iframe (no same-origin) throws on localStorage: an in-memory stand-in keeps prototypes that use it alive
_STORAGE_SHIM = ("<script>(function(){try{window.localStorage.getItem('x')}catch(e){var m={};var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},"
                 "setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},"
                 "get length(){return Object.keys(m).length}};try{Object.defineProperty(window,'localStorage',{value:s});Object.defineProperty(window,'sessionStorage',{value:s})}catch(_){}}})()</script>")


def _local_ref(ref: str, base_dir: str, files: dict[str, str]) -> str | None:
    """Content of a project file an HTML page references by a relative path (None for URLs, data: and missing files)."""
    import posixpath

    ref = ref.strip()
    if not ref or re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", ref, re.I):
        return None
    ref = ref.split("#")[0].split("?")[0]
    path = ref.lstrip("/") if ref.startswith("/") else posixpath.normpath(posixpath.join(base_dir, ref))
    return files.get(path)


def html_refs(html: str, base_dir: str) -> set[str]:
    """Project paths a page pulls in (stylesheets and scripts), to know when a change to them should refresh the pane."""
    import posixpath

    out: set[str] = set()
    for tag in _LINK_RX.findall(html or ""):
        h = re.search(r"\bhref=[\"']([^\"']+)", tag, re.I)
        if h and "stylesheet" in tag.lower() and not re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", h.group(1), re.I):
            r = h.group(1).split("#")[0].split("?")[0]
            out.add(r.lstrip("/") if r.startswith("/") else posixpath.normpath(posixpath.join(base_dir, r)))
    for m in _SCRIPT_RX.finditer(html or ""):
        r = m.group(2)
        if not re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", r, re.I):
            r = r.split("#")[0].split("?")[0]
            out.add(r.lstrip("/") if r.startswith("/") else posixpath.normpath(posixpath.join(base_dir, r)))
    return out


def inline_html(html: str, path: str, files: dict[str, str]) -> str:
    """The pane shows the page as srcdoc, where relative links go nowhere: the project's own stylesheets and scripts are
    inlined (a deferred script moves to the end of <body>, where it would have run), plus the storage shim."""
    if not html:
        return html
    base_dir = path.rsplit("/", 1)[0] if "/" in path else ""
    tail: list[str] = []

    def link(m: re.Match) -> str:
        tag = m.group(0)
        if "stylesheet" not in tag.lower():
            return tag
        h = re.search(r"\bhref=[\"']([^\"']+)", tag, re.I)
        css = _local_ref(h.group(1), base_dir, files) if h else None
        return f"<style>\n{css}\n</style>" if css is not None else tag

    def script(m: re.Match) -> str:
        attrs = (m.group(1) + " " + m.group(3)).strip()
        js = _local_ref(m.group(2), base_dir, files)
        if js is None:
            return m.group(0)
        js = js.replace("</script", "<\\/script")
        module = re.search(r"type=[\"']?module", attrs, re.I)
        tag = f"<script{' type=\"module\"' if module else ''}>\n{js}\n</script>"
        if re.search(r"\b(defer|async)\b", attrs, re.I) and not module:
            tail.append(tag)
            return ""
        return tag

    out = _LINK_RX.sub(link, html)
    out = _SCRIPT_RX.sub(script, out)
    if tail:
        i = out.lower().rfind("</body>")
        out = (out[:i] + "\n".join(tail) + out[i:]) if i >= 0 else out + "\n".join(tail)
    i = out.lower().find("<head>")
    return (out[: i + 6] + _STORAGE_SHIM + out[i + 6:]) if i >= 0 else _STORAGE_SHIM + out


def summarize_usage(api: dict, api_by_model: dict, eng: dict | None, engine_tokens: int, cost: float, engine_cost: float, engine: str | None) -> dict:
    """Token totals (API calls + the CLI agent's measured usage per model) and, at list prices, what the agent's work is
    worth and what the prompt cache saved (cache-read tokens billed as plain input minus their cache-read price)."""
    from .pricing import usage_value

    u = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "unsplit": 0}
    for k in u:
        u[k] += int(api.get(k) or 0)
    engine_value = cache_saved = 0.0
    for model, mu in (eng or {}).items():
        for k in ("input", "output", "cache_read", "cache_write"):
            u[k] += mu[k]
        v = usage_value(model, mu)
        engine_value += v["value_usd"]
        cache_saved += v["cache_saved_usd"]
    for model, mu in (api_by_model or {}).items():
        cache_saved += usage_value(model, mu)["cache_saved_usd"]
    if not eng and engine_tokens:
        u["input"] += engine_tokens  # Codex / Muse only report a total
    return u | {"total": sum(u.values()), "engine": sum(sum(m.values()) for m in eng.values()) if eng else engine_tokens,
                "api": sum(int(api.get(k) or 0) for k in u), "measured": bool(eng) or engine != "claude-code",
                "engine_value_usd": round(engine_value if eng else engine_cost, 4), "cache_saved_usd": round(cache_saved, 4),
                "api_cost_usd": round(max(0.0, cost - engine_cost), 4), "models": sorted((eng or {}).keys())}


def saved_usage(d: dict) -> dict:
    """Build.usage() for a build saved on disk (the same sources: API counters + Claude Code's session logs)."""
    from .local_engine import claude_usage, is_engine

    api = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "unsplit": 0}
    if d.get("api_usage"):
        api.update(d["api_usage"])
    else:
        api["unsplit"] = int(d.get("tokens") or 0)
    wd, prov = d.get("workdir"), d.get("provider") or ""
    eng = claude_usage(Path(wd)) if prov == "claude-code" and wd and Path(wd).exists() else None
    cost = float(d.get("cost_usd") or 0)
    ec = d.get("engine_cost_usd")
    engine_cost = float(ec) if ec is not None else (cost if is_engine(prov) else 0.0)
    return summarize_usage(api, d.get("api_by_model") or {}, eng, int(d.get("engine_tokens") or 0), cost, engine_cost, prov if is_engine(prov) else None)

def research_context(md: str, clone: bool = False) -> str:
    if not md:
        return ""
    what = "plano de clonación del referente: en todo lo visual y de comportamiento manda este documento, por encima del brief" if clone else "benchmark de apps de referencia: emulá los patrones marcados, evitá los señalados"
    return f"\n\n===== {RESEARCH_PATH} ({what}) =====\n{md[:12000]}\n"


REVIEW_SYSTEM = """Sos {name}, {role_label} del equipo que diseñó este producto en TABLY TEAM. Personalidad: {persona}
Tu responsabilidad en el equipo: {mandate}.
{craft}

REVISIÓN PRE-PRODUCCIÓN (ronda {round}). El constructor entregó el proyecto. Si existe design/ (DESIGN.md, tokens.css, mockup.html), la interfaz
se juzga contra ESE diseño: toda desviación de tokens, layout, estados o copy es un hallazgo.{uikit_note} Revisalo DESDE TU ÁREA como lo haría un
profesional serio antes de aprobar una salida a producción: ¿cumple el brief? ¿está completo? ¿se rompe? ¿qué falta?
Leé el código real que te paso; no supongas. Sé exigente pero justo: aprobá si tu área está cubierta, pedí cambios si no.
{prior}
Respondé SOLO con:
<reflexion>cómo lo evaluaste en 1-2 frases</reflexion>
<verdict>approve | changes</verdict>
<findings>hallazgos de tu área en Markdown: lista con [bloqueante] o [mejora] al inicio de cada ítem; citá archivos y líneas</findings>
<requests>si verdict=changes: pedidos CONCRETOS y verificables para el constructor, numerados (qué archivo, qué cambiar, cómo se verifica). Si verdict=approve: dejalo vacío</requests>"""

AUDIT_SYSTEM = """Sos {name}, {role_label} de un equipo de auditoría técnica y de producto. Personalidad: {persona}
Tu responsabilidad: {mandate}.
{craft}

AUDITORÍA DE PROYECTO EXISTENTE. El usuario subió su proyecto para que el equipo lo evalúe con honestidad y lo ayude a mejorarlo.
Contexto del usuario: {context}
Revisá DESDE TU ÁREA leyendo el código real (no supongas): qué está bien hecho, qué está mal o falta, y qué mejoras concretas
proponés. Sé específico: archivos, líneas, ejemplos. Priorizá por impacto. No inventes problemas donde no los hay.
{prior}
Respondé SOLO con:
<reflexion>cómo lo evaluaste en 1-2 frases</reflexion>
<score>0-10 (estado actual de tu área)</score>
<strengths>qué está bien, en Markdown (lista corta, concreta)</strengths>
<findings>qué hay que mejorar: lista con [crítico], [importante] o [mejora] al inicio de cada ítem; citá archivos</findings>
<requests>propuestas de mejora CONCRETAS y accionables, numeradas (qué cambiar, dónde, por qué, impacto/esfuerzo estimado). Si no hay nada relevante, dejalo vacío</requests>"""

AUDIT_REPORT_SYSTEM = """Sos el presidente del comité de auditoría. Recibís las evaluaciones de cada rol sobre un proyecto existente y escribís el
INFORME DE AUDITORÍA final para el dueño del proyecto, en Markdown, en {language}. Claro, honesto, accionable; sin relleno.
Formato EXACTO:
# Informe de auditoría · <nombre del proyecto>
> <una línea: estado general y veredicto>

## 1. Resumen ejecutivo
(5-8 líneas; puntaje global 0-10 ponderando los puntajes de los roles)
## 2. Puntajes por área
(tabla: Área/Rol | Puntaje | Lo mejor | Lo más urgente)
## 3. Lo que está bien
## 4. Lo que hay que mejorar
(agrupado por severidad: críticos → importantes → mejoras; con archivo/ubicación)
## 5. Propuestas priorizadas
(tabla: # | Propuesta | Rol que la propone | Impacto | Esfuerzo | Prioridad)
## 6. Plan sugerido
(qué hacer primero, en orden, con criterio de terminado)
## 7. Riesgos si no se actúa"""

SCORE_RE = re.compile(r"<score>\s*(\d+(?:[.,]\d+)?)", re.S)
STRENGTHS_RE = re.compile(r"<strengths>(.*?)(?:</strengths>|$)", re.S)
VERDICT_RE = re.compile(r"<verdict>(.*?)</verdict>", re.S)
FINDINGS_RE = re.compile(r"<findings>(.*?)(?:</findings>|$)", re.S)
REQUESTS_RE = re.compile(r"<requests>(.*?)(?:</requests>|$)", re.S)
REFLEX_RE = re.compile(r"<reflexion>(.*?)</reflexion>", re.S)
MAX_REVIEW_ROUNDS = 6
REVIEW_CONTEXT_CHARS = 90_000


def _safe_path(path: str) -> str | None:
    p = path.strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    if not p or p.startswith("/") or ".." in p.split("/") or len(p) > 200:
        return None
    return p


class Build:
    def __init__(self, user: User, req: BuildRequest, cred: Cred, brief: str, title: str, team: list[dict] | None = None, creds: dict[str, Cred] | None = None, build_id: str | None = None):
        self.id = build_id or (time.strftime("%H%M%S-") + uuid.uuid4().hex[:6])  # rehydrate passes the saved id → same workdir, no stray folder
        self.user = user
        self.req = req
        self.cred = cred
        self.brief = brief
        self.title = title
        self.status = "running"
        self.files: dict[str, str] = {}
        self.stages: list[dict] = []
        self.events: list[dict] = []
        self.history: list[dict] = []  # compacted chat history sent to the model
        self.chat: list[dict] = []  # what the UI shows (persisted)
        self.inbox: asyncio.Queue[str] = asyncio.Queue()
        self.subscribers: set[asyncio.Queue] = set()
        self._stop = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.cost = 0.0
        self.tokens = 0
        self.turns = 0
        self.done_text = ""
        self.preview_html: str | None = None
        self.engine_cost = 0.0  # what the CLI agent itself reports (Claude Code: total_cost_usd, its API-equivalent price)
        self.engine_tokens = 0  # tokens the CLI agents report (Codex / Muse); Claude Code is read from its own logs
        self.api_usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "unsplit": 0}  # API calls (design, review, API builders)
        self.api_by_model: dict[str, dict] = {}  # the same, per model (to value the cache at each model's price)
        self.live: dict | None = None  # {turn, phase, raw} while a model turn is streaming
        self.team = [a for a in (team or []) if role_of(a.get("role"))]  # reviewers = session agents with a role
        self.creds_all = creds or {}
        self.review_plan: dict | None = {"max_rounds": min(MAX_REVIEW_ROUNDS, req.review_rounds)} if req.review_rounds > 0 else None
        self.reviews: list[dict] = []
        self.live_reviews: dict[str, list[str]] = {}
        self.last_truncated = False
        self.mode = "build"  # build | audit
        self.context = ""  # user's description for audits
        self.audit_report: str | None = None
        self.deploys: list[dict] = []
        self.engine = req.provider if is_engine(req.provider) else None
        self.workdir: Path | None = workdir(user.id, self.id) if self.engine else None
        self.engine_session: str | None = None  # Claude Code session id (resumable from the terminal too)
        self.app_run = None  # runner.AppRun while the built app is running locally
        self._design_ok = asyncio.Event()  # set by approve_design / redo_design while the pipeline waits in "design_review"
        self.design_feedback: str | None = None  # the user's change requests for the next design round
        self.design_rounds = 0
        self.council_sessions: list[str] = []  # arena sessions (mode "review") where the team debated this build
        self.design_html: str | None = None  # design/mockup.html, the hi-fi design the UI must match
        self.design_turns = 0  # turns spent in the design phase (build-stage numbering ignores them)
        self.research_md = ""  # research/REFERENCES.md: what the team learned from the reference apps
        self.research_refs: list[dict] = []  # [{url, name, ok, shots:[...]}]
        self.fees: list[dict] = []  # per-use charges that are not API tokens (deep analysis), [{label, usd}]
        self.council_priorities: str = req.priorities or ""  # consumed by the next council round
        self.build_seconds = 0.0  # wall-clock of every turn so far (turn.started → turn.completed)
        self._turn_t0: float | None = None
        self.versions: list[dict] = []  # one per build pass: v1 initial, v2 after council round 1, … (see versions.py)
        self._pending_requests: list[dict] = []  # change list the current pass is applying (→ next version's `requested`)
        self._pending_trigger = "initial"
        self._pending_from: str | None = None
        self.activity: list[dict] = []  # what the local agent is doing right now, in plain words (not raw tool calls)
        self.todos: list[dict] = []  # the agent's own plan (TodoWrite) → progress bar
        if self.workdir:
            existing = self.workdir / "BRIEF.md"
            if not existing.exists() or len(brief) > len(existing.read_text()):
                existing.write_text(brief)

    # ------------------------------------------------------------- pub/sub
    def emit(self, type_: str, **data) -> dict:
        # wall-clock per turn and for the whole build: the bar shows the turn, the header and the home cards the total
        if type_ == "turn.started":
            self._turn_t0 = time.time()
        elif type_ == "turn.completed":
            secs = round(time.time() - (self._turn_t0 or time.time()), 1)
            self._turn_t0 = None
            self.build_seconds = round(getattr(self, "build_seconds", 0.0) + secs, 1)
            data = {**data, "seconds": secs, "build_seconds": self.build_seconds}
            if self.chat and self.chat[-1].get("turn") == data.get("turn") and self.chat[-1].get("role") == "assistant":
                self.chat[-1]["seconds"] = secs
        ev = {"type": type_, "seq": len(self.events), "ts": time.time(), **data}
        if type_ not in ("token", "review.token"):
            self.events.append(ev)
        for q in list(self.subscribers):
            q.put_nowait(ev)
        return ev

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        q.put_nowait(self.snapshot_event())
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def snapshot(self) -> dict:
        return {
            "id": self.id, "session_id": self.req.session_id, "provider": self.req.provider, "model": self.req.model, "title": self.title,
            "status": self.status, "files": {p: {"size": len(c), "lines": c.count("\n") + 1} for p, c in self.files.items()},
            "stages": self.stages, "chat": self.chat, "cost_usd": round(self.cost, 5), "tokens": self.tokens, "usage": self.usage(), "engine_cost_usd": round(self.engine_cost, 5), "turns": self.turns, "done": self.done_text, "build_seconds": round(getattr(self, "build_seconds", 0.0)),
            "preview": self.preview_html is not None, "design": self.design_html is not None, "design_html": self.design_html,
            "live": {"turn": self.live["turn"], "phase": self.live["phase"], "raw": "".join(self.live["buf"])} if self.live else None,
            "engine": self.engine, "workdir": str(self.workdir) if self.workdir else None, "engine_session": self.engine_session,
            "activity": self.activity[-60:], "todos": self.todos,
            "app_run": self.app_run.state() if self.app_run else None,
            "design_review": self.status == "design_review", "design_rounds": self.design_rounds,
            "research": self.research_refs, "references": self.req.references, "deep_analysis": self.req.deep_analysis, "platform": self.req.platform, "language": self.req.language, "references_auto": self.req.references_auto, "fees": self.fees, "fees_usd": round(sum(float(f.get("usd") or 0) for f in self.fees), 2), "fees_due_usd": round(sum(float(f.get("usd") or 0) for f in self.fees if not f.get("paid")), 2),
            "council_sessions": self.council_sessions, "council": self.req.council,
            "versions": self.versions, "version": len(self.versions), "pending_council": self.pending_council(),
            "mode": self.mode, "audit_report": self.audit_report, "deploys": self.deploys,
            "team": [{k: a.get(k) for k in ("id", "name", "role", "provider", "model", "color", "skills")} | {"role_label": role_of(a.get("role"))["label"]} for a in self.team],
            "review_plan": self.review_plan, "reviews": self.reviews,
            "live_reviews": {k: "".join(v) for k, v in self.live_reviews.items()},
            "levels": self.levels_eval(),
        }

    # ------------------------------------------------------------- growth levels
    def cloud_app(self) -> dict | None:
        from . import cloud as cloudmod

        try:
            return cloudmod.get_app(self.user.id, self.id)
        except Exception:  # noqa: BLE001
            return None

    def levels_eval(self) -> dict:
        """The project's growth level (1 En línea → 4 Monetizado), the checks of the next level and the % towards it."""
        try:
            return levelsmod.evaluate(self, self.cloud_app())
        except Exception as e:  # noqa: BLE001
            log.warning("levels: %s", e)
            return {"level": 0, "max": levelsmod.MAX_LEVEL, "next": 1, "pct": 0, "pending": [], "levels": [], "market_ready": False, "visits": 0}

    def levels_block(self) -> str:
        """The ladder and the pending checks of the level being climbed, for the builder and the council prompts."""
        from . import cloud as cloudmod

        app_ = self.cloud_app()
        from . import lessons as lessonsmod

        return levelsmod.team_block(self.levels_eval(), (app_ or {}).get("slug"), cloudmod.public_url()) + lessonsmod.block()

    def snapshot_event(self) -> dict:
        return {"type": "build.snapshot", "seq": -1, "ts": time.time(), "build": self.snapshot()}

    def stop(self) -> None:
        self._design_ok.set()  # a build waiting for design approval stops too
        self._stop.set()
        self.inbox.put_nowait("")  # wake the loop if it is waiting

    def say(self, text: str) -> None:
        self.inbox.put_nowait(text)
        self.chat.append({"role": "user", "text": text, "ts": time.time()})
        self.emit("user.message", text=text)

    # ------------------------------------------------------------- loop
    def resume(self, text: str) -> None:
        """After completion/stop, a user message restarts the loop with that instruction."""
        if self.status == "running":
            return
        if text != CONTINUE:
            self._pending_requests, self._pending_trigger, self._pending_from = [{"severity": "mejora", "role": "usuario", "text": text[:300]}], "user", None
        self.status = "running"
        self._stop = asyncio.Event()
        self.task = spawn(self.pipeline(text))

    def start_audit(self) -> None:
        """Round 1 in audit mode (strengths / issues / proposals / score), then the chairman's report."""
        self.mode = "audit"
        self._stop = asyncio.Event()
        self.task = spawn(self.pipeline_audit())

    async def pipeline_audit(self) -> None:
        USER_ENV.set(user_claude_env(self.user.id))  # the engine runs as this user (their own subscription token on a server)
        try:
            rnd = await self.run_review(1, mode="audit")
            if rnd and not self._stop.is_set():
                await self._audit_report(rnd)
            self.status = "audited" if rnd else "error"
        except Exception as e:  # pragma: no cover
            log.exception("audit crashed")
            self.status = "error"
            self.emit("error", error=str(e)[:400])
        finally:
            self._save()
            await asyncio.to_thread(obs.flush)
            self.emit("build.completed", status=self.status, build=self.snapshot())
            for q in list(self.subscribers):
                q.put_nowait(None)

    def apply_improvements(self, requests: list[dict], max_rounds: int) -> None:
        """Audit → builder applies the selected proposals → council reviews (normal mode) until approved."""
        if self.status in ("running", "reviewing"):
            return
        self.review_plan = {"max_rounds": len(self.reviews) + min(MAX_REVIEW_ROUNDS, max(1, max_rounds))}
        self._pending_requests = [{"severity": "mejora", "role": r.get("role_label", ""), "text": r["text"]} for r in requests if r.get("text")]
        self._pending_trigger, self._pending_from = "audit", None
        text = "MEJORAS APROBADAS POR EL USUARIO tras la auditoría del equipo:\n" + "\n".join(f"- [{r.get('role_label', '')} · {r.get('name', '')}] {r['text']}" for r in requests if r.get("text"))
        shown = self.tx("Mejoras aprobadas tras la auditoría:", "Improvements approved after the audit:") + "\n" + "\n".join(f"- [{r.get('role_label', '')}] {r['text']}" for r in requests if r.get("text"))
        text += "\n\nAplicá TODAS con archivos completos (respetando el estilo y la estructura existentes), actualizá README/NOTES si corresponde y, al terminar, emití <done>."
        self.status = "running"
        self._stop = asyncio.Event()
        self.chat.append({"role": "user", "text": shown, "ts": time.time()})  # the chat shows the list; the instructions go to the builder only
        self.task = spawn(self.pipeline(text))

    async def _audit_report(self, rnd: dict) -> None:
        """Chairman synthesis of the audit round into a Markdown report."""
        from .providers import PROVIDERS as _P

        evals = "\n\n".join(
            f"### {r['name']} · {r['role_label']} (puntaje {r.get('score', '—')})\nFORTALEZAS:\n{r.get('strengths', '')}\nHALLAZGOS:\n{r['findings']}\nPROPUESTAS:\n{r['requests']}" for r in rnd["results"]
        )
        user = f"PROYECTO: {self.title}\nCONTEXTO DEL USUARIO: {self.context or '—'}\nARCHIVOS: {len(self.files)}\n\nEVALUACIONES DEL EQUIPO:\n{evals}"
        system = AUDIT_REPORT_SYSTEM.format(language=self.req.language)
        self.turns += 1
        self.emit("turn.started", turn=self.turns, phase="report")
        buf: list[str] = []
        self.live = {"turn": self.turns, "phase": "report", "buf": buf}
        try:
            if self.engine:
                res = await run_engine(self.engine, user + "\n\nEscribí el informe con el formato indicado.", self.workdir, system=system, read_only=True, max_turns=6, on_event=lambda *a, **k: None)
                text = res.get("text") or ""
                self.cost += float(res.get("cost") or 0)
                self.engine_cost += float(res.get("cost") or 0)
                self.engine_tokens += int(res.get("tokens") or 0)
            else:
                result = CallResult()
                mock = MockContext("Chair", [("x", "x")], self.title, script=_mock_audit_report(self.title, rnd))
                parts: list[str] = []
                async for kind, delta in stream(self.req.provider, self.req.model, system, user, temperature=0.3, max_tokens=6000, result=result, mock=mock, cred=self.cred):
                    if kind == "text":
                        parts.append(delta)
                        buf.append(delta)
                        self.emit("token", delta=delta, turn=self.turns)
                text = "".join(parts)
                self.cost += cost_usd(self.req.model, result.input_tokens, result.output_tokens)
                self.tokens += result.input_tokens + result.output_tokens
                self._add_api_usage(result)
        except Exception as e:
            text = f"# Informe de auditoría · {self.title}\n\n(No se pudo generar la síntesis: {str(e)[:200]}. Abajo están las evaluaciones por rol.)\n\n{evals}"
        self.live = None
        self.audit_report = text.strip()
        self.chat.append({"role": "report", "text": self.audit_report, "turn": self.turns, "ts": time.time()})
        self.emit("audit.report", markdown=self.audit_report, turn=self.turns)

    def start_review(self, max_rounds: int) -> None:
        """Kick off the pre-production review loop on a finished build."""
        if self.status in ("running", "reviewing"):
            return
        self.review_plan = {"max_rounds": min(MAX_REVIEW_ROUNDS, max(1, max_rounds))}
        self._stop = asyncio.Event()
        self.task = spawn(self.pipeline(None, review_first=True))

    async def pipeline(self, resume_with: str | None = None, review_first: bool = False) -> None:
        """build → (review → changes)* until the council approves, max rounds, stop or error. Closes the stream at the end."""
        USER_ENV.set(user_claude_env(self.user.id))  # the engine runs as this user (their own subscription token on a server)
        try:
            if not review_first:
                if resume_with is None and (self.req.research or self.req.references) and RESEARCH_PATH not in self.files and not self._stop.is_set():
                    await self.research_phase()
                if resume_with is None and self.req.design and DESIGN_MOCKUP not in self.files and not self._stop.is_set():
                    await self.design_phase()
                    await self._ensure_mockup()
                    # the user looks at the mockup before a line of code exists: approve, or ask for changes and redesign
                    while self.req.design_review and self.status != "error" and not self._stop.is_set() and self.design_rounds < 6:
                        self.status = "design_review"
                        self._design_ok.clear()
                        self.chat.append({"role": "system", "text": self.tx("El diseño está listo: revisalo en la pestaña Diseño. Aprobalo para construir, o pedí cambios.", "The design is ready: review it in the Design tab. Approve it to build, or ask for changes."), "ts": time.time()})
                        self.emit("design.review", html=self.files.get(DESIGN_MOCKUP, ""), round=self.design_rounds + 1)
                        self._save()
                        await self._design_ok.wait()
                        if self._stop.is_set():
                            break
                        if not self.design_feedback:
                            break
                        self.design_rounds += 1
                        fb, self.design_feedback = self.design_feedback, None
                        self.chat.append({"role": "user", "text": self.tx("Cambios al diseño: ", "Design changes: ") + fb, "ts": time.time()})
                        await self.design_phase(feedback=fb)
                        await self._ensure_mockup()
                if self.status != "error":
                    await self.run(resume_with)
                if resume_with in (None, CONTINUE):
                    await self._ensure_delivery()
                # a last pass that makes the UI match the design (typography, tokens, states, first impact): the difference
                # between "works" and "looks like a product"
                if resume_with is None and self.req.design and self.status == "completed" and self.files and not self._stop.is_set():
                    self.chat.append({"role": "system", "text": self.tx("Pulido visual: el constructor ajusta la UI al diseño antes de entregar.", "Visual polish: the builder matches the UI to the design before delivering."), "ts": time.time()})
                    await self.run(POLISH_PROMPT)
                await self._ensure_identity()
                if self.status == "completed" and self.files:
                    self.snapshot_version()
            plan = self.review_plan
            if plan and self.req.council and self.status == "completed" and not self._stop.is_set() and len(self.council_sessions) < plan["max_rounds"] and self.start_council():
                return  # the team debates in the arena; the user applies the council's change list from there
            # council mode never falls back to the silent parallel review: when no more council rounds are due, the build
            # simply ends and the user chooses (run the app, send to the council with priorities, ship)
            while plan and self.team and not self.req.council and self.status == "completed" and not self._stop.is_set():
                done_rounds = len(self.reviews)
                if done_rounds >= plan["max_rounds"]:
                    break
                rnd = await self.run_review(done_rounds + 1)
                if rnd is None:
                    break
                if rnd["approved"]:
                    self.status = "approved"
                    self.emit("build.approved", round=rnd["round"])
                    break
                if len(self.reviews) >= plan["max_rounds"]:
                    break
                reqs = "\n".join(f"- [{r['role_label']} · {r['name']}] {r['requests']}" for r in rnd["results"] if r["verdict"] == "changes")
                await self.run(f"REVISIÓN PRE-PRODUCCIÓN — ronda {rnd['round']}. El consejo del equipo pidió estos cambios:\n{reqs}\n\nAplicalos TODOS (archivos completos afectados), actualizá README/NOTES si corresponde y, cuando el proyecto vuelva a estar completo, emití <done>.")
            if self.status in ("completed", "approved") and not self._stop.is_set():
                self._auto_publish()  # already online + the approval holds → the new version goes out by itself
        except asyncio.CancelledError:
            self.status = "stopped"
        except Exception as e:  # pragma: no cover - a crash must leave the build resumable, never "running" forever
            log.exception("build pipeline crashed")
            self.status = "error"
            self.live = None
            self.emit("error", error=f"El constructor se interrumpió por un error interno: {str(e)[:300]}. Podés reanudarlo.", turn=self.turns)
        finally:
            self._save()
            await asyncio.to_thread(obs.flush)
            self.emit("build.completed", status=self.status, build=self.snapshot())
            for q in list(self.subscribers):
                q.put_nowait(None)

    async def run(self, resume_with: str | None = None) -> None:
        """One build pass (initial build, or applying requested changes). Does not close the stream."""
        self.status = "running"
        self.emit("build.started", build=self.snapshot())
        if self.engine:
            await self._run_engine(resume_with)
            return
        system = BUILDER_SYSTEM.format(delivery_rule=delivery.CONTRACT_RULE, language=self.req.language, quality_bar=quality_bar([a.get("role") for a in self.team] or None), design_rule=(BUILDER_DESIGN_RULE if self.design_html else "") + frontend_design_guide())
        kit = await self._seed_uikit() if resume_with is None else self._uikit_reminder()
        first = f"BRIEF.md:\n\n{self.brief}{research_context(self.research_md, bool(self.req.deep_analysis))}{design_context_for_builder(self.files)}{platform_note(self.req.platform)}{kit}{self.levels_block()}\n\n---\nEmpezá por la Etapa 1 del plan. Entregá los archivos completos."
        pending_user = resume_with or first
        if resume_with:
            self.preview_html = None  # changes invalidate the prototype; it is regenerated after the next <done>
            self.turns = max(self.turns, 0)
            files = "\n".join(f'<file path="{p}"/> ({c.count(chr(10)) + 1} líneas)' for p, c in self.files.items())
            if resume_with == CONTINUE:
                pending_user = (f"(Estado actual del proyecto: {len(self.files)} archivos ya escritos:\n{files}\nEtapas cerradas: {[s['n'] for s in self.stages] or 'ninguna'})\n\n"
                                "La construcción se interrumpió. RETOMÁ desde donde quedó: revisá qué falta del plan del brief (y qué archivos del árbol están incompletos), "
                                "entregá lo pendiente en turnos de máximo 3 archivos completos, cerrá las etapas restantes y emití <done> al terminar.")
            else:
                # the files the request names come with their current content, so the model edits instead of guessing
                named = self._files_named_in(resume_with)
                pending_user = f"(Estado actual del proyecto: {len(self.files)} archivos ya escritos:\n{files}){kit}\n\n{self._contents_block(named)}Pedido del usuario: {resume_with}\nAplicá los cambios entregando los archivos completos (los que modificás, enteros; los nuevos, enteros). Si necesitás ver otro archivo antes de tocarlo, pedilo con <read path=\"…\"/>."
        idle = 0
        try:
            with obs.session_trace(self.req.session_id, self.user.email, f"build · {self.title}"[:200], ["tablyteam", "build", self.req.provider], {"model": self.req.model}, {"session": self.req.session_id}):
                while self.turns < MAX_TURNS and not self._stop.is_set():
                    self.turns += 1
                    text = await self._turn(system, pending_user)
                    if text is None:
                        break
                    parsed = self._apply(text)
                    reads = [p for p in re.findall(r'<read path="([^"\n]+)"\s*/>', text)][:8]
                    idle = idle + 1 if not parsed["files"] and not parsed["stage"] and not parsed["done"] and not reads else 0
                    # compact: keep decisions + file list, drop file bodies from the context
                    compact = parsed["say"] + "\n" + "\n".join(f'<file path="{p}"/> (escrito, {self.files[p].count(chr(10)) + 1} líneas)' for p in parsed["files"])
                    if parsed["stage"]:
                        compact += f'\n<stage n="{parsed["stage"]["n"]}">{parsed["stage"]["text"]}</stage>'
                    self._push_history(pending_user if (self.turns > 1 or resume_with) else "(BRIEF.md + arranque)", compact)
                    self._save()
                    if self.last_truncated:
                        # the model hit the output limit: unfinished <file> blocks were dropped; make it redo them in smaller turns
                        open_file = re.findall(r'<file path="([^"\n]+)"\s*>(?![\s\S]*</file>)', text)
                        cut = open_file[-1] if open_file else None
                        self.chat.append({"role": "system", "text": self.tx(f"El turno se cortó por el límite de salida{f' en `{cut}`' if cut else ''}. Se le pide reanudar con menos archivos por turno.", f"The turn was cut off by the output limit{f' at `{cut}`' if cut else ''}. It is asked to resume with fewer files per turn."), "ts": time.time()})
                        self.emit("notice", text=f"Turno cortado por límite de salida{f' en {cut}' if cut else ''}; se reanuda con menos archivos por turno.")
                        pending_user = (f"Tu turno anterior se cortó por el límite de salida" + (f" mientras escribías `{cut}` (ese archivo NO quedó guardado)" if cut else "") +
                                        ". Seguí desde ahí: entregá como máximo 3 archivos por turno, completos, empezando por el que faltó.")
                        continue
                    if parsed["done"]:
                        self.status = "completed"
                        if self.preview_html is None and not self._stop.is_set():
                            await self._preview_turn(system)
                        break
                    # next instruction: the user's steering if any, otherwise continue
                    steer = await self._drain_inbox()
                    if self._stop.is_set():
                        break
                    if reads:
                        pending_user = (steer + "\n\n" if steer else "") + self._contents_block(reads) + "Seguí con los cambios: entregá los archivos completos."
                        continue
                    if idle >= 3:
                        # three turns without files, stage, done or a read: the model is stuck asking for something the pipeline cannot give
                        self.chat.append({"role": "system", "text": self.tx("El constructor se trabó: tres turnos seguidos sin entregar archivos. Se detiene para no gastar tokens. Podés pedirle lo mismo con más precisión, o pedirle que use <read path=\"…\"/> para leer lo que necesite.", "The builder got stuck: three turns in a row without delivering files. It stops so it does not burn tokens. Ask again more precisely, or ask it to use <read path=\"…\"/> to read what it needs."), "ts": time.time()})
                        self.emit("notice", text="Constructor detenido: tres turnos seguidos sin entregar archivos.")
                        self.status = "stopped"
                        break
                    pending_user = steer or "Continuá con la siguiente etapa del plan. Si el producto ya está completo según el brief y corre, emití <done>. Si te falta ver un archivo, pedilo con <read path=\"…\"/>."
        except Exception as e:  # pragma: no cover
            log.exception("build crashed")
            self.status = "error"
            self.emit("error", error=str(e)[:400])
        finally:
            if self.status == "running":
                self.status = "stopped" if self._stop.is_set() else "completed"
            self._save()
            self.emit("pass.completed", status=self.status, build=self.snapshot())

    def set_builder(self, provider: str, model: str | None) -> None:
        """Change who builds from now on (Claude Code / Codex on the subscription, or an API model). An API build that
        moves to a local engine gets its files written to a real folder first."""
        from .local_engine import workdir as mk_workdir

        if is_engine(provider):
            cred = Cred("local", None, model or "default", "local")
            model = model or "default"
        else:
            cred = self.creds_all.get(provider)
            if not cred or cred.source == "none":
                raise ValueError(f"Falta la API key de {provider}")
            model = model or cred.model or PROVIDERS[provider].default_model
        same = provider == self.req.provider and model == self.req.model
        self.req.provider, self.req.model, self.cred = provider, model, cred
        was_engine = self.engine
        self.engine = provider if is_engine(provider) else None
        if self.engine and not self.workdir:
            self.workdir = mk_workdir(self.user.id, self.id)
        if self.engine:
            for rel, content in self.files.items():  # the folder must hold the latest files (an API build kept them in memory only)
                dest = self.workdir / rel
                if not dest.exists() or dest.read_text(errors="replace") != content:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(content)
        if was_engine != self.engine:
            self.engine_session = None  # a different agent: no session to resume
        if not same:
            self.chat.append({"role": "system", "text": self.tx("Constructor cambiado a ", "Builder switched to ") + f"{provider} · {model}.", "ts": time.time()})
            self.emit("build.status", status=self.status, build=self.snapshot())
            self._save()

    def _files_named_in(self, text: str) -> list[str]:
        """Existing project files mentioned in a request (paths like src/x/y.ts or `y.ts` when unique), most relevant first."""
        found: list[str] = []
        for m in re.finditer(r"[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html|py|toml|ya?ml|sql|txt|env|sh)", text or ""):
            cand = m.group(0).lstrip("./")
            if cand in self.files and cand not in found:
                found.append(cand)
            elif "/" not in cand:
                hits = [p for p in self.files if p.endswith("/" + cand) or p == cand]
                if len(hits) == 1 and hits[0] not in found:
                    found.append(hits[0])
        return found[:12]

    def _contents_block(self, paths: list[str], budget: int = 90000) -> str:
        """The current content of those files, as context for a turn that must edit them (bounded)."""
        out, used = [], 0
        for p in paths:
            c = self.files.get(p)
            if c is None:
                out.append(f'<current path="{p}">(no existe)</current>')
                continue
            take = c[: max(0, budget - used)]
            used += len(take)
            out.append(f'<current path="{p}">\n{take}{"" if take == c else "\n… (recortado)"}\n</current>')
            if used >= budget:
                break
        return ("CONTENIDO ACTUAL DE LOS ARCHIVOS A MODIFICAR (entregalos enteros con los cambios):\n" + "\n".join(out) + "\n\n") if out else ""

    def _push_history(self, user: str, assistant: str) -> None:
        """Providers reject empty/whitespace-only messages: never let one into the context."""
        u = (user or "").strip() or "(continuar)"
        a = (assistant or "").strip() or "(turno sin salida)"
        self.history += [{"role": "user", "content": u[:8000]}, {"role": "assistant", "content": a[:6000]}]

    # ------------------------------------------------------------- local engines (Claude Code / Codex)
    async def _seed_uikit(self) -> str:
        """Web builds start from Muse Team's UI kit (shadcn/ui + Tailwind + the design tokens) copied into the tree before the first turn."""
        if not uikit.enabled(self.req.platform) or any(p.startswith(uikit.UI_DIR + "/") or p == uikit.GUIDE_PATH for p in self.files):
            return self._uikit_reminder()
        try:
            files, info = await asyncio.to_thread(uikit.scaffold, self.files.get("design/tokens.css", ""), None, title=self.title)
        except Exception as e:  # pragma: no cover - the kit is a boost, never a reason to fail a build
            log.warning("uikit scaffold failed: %s", e)
            return ""
        for rel, content in files.items():
            self._write(rel, content)
            if self.workdir:
                dest = self.workdir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(content)
        self.chat.append({"role": "system", "text": self.tx(f"Kit de UI sembrado: {len(info['components'])} componentes de shadcn/ui en {uikit.UI_DIR}/, Tailwind v4 y los tokens del diseño ({uikit.GUIDE_PATH}).", f"UI kit seeded: {len(info['components'])} shadcn/ui components in {uikit.UI_DIR}/, Tailwind v4 and the design tokens ({uikit.GUIDE_PATH})."), "ts": time.time()})
        self._save()
        return uikit.builder_block(info)

    def _uikit_reminder(self) -> str:
        if uikit.GUIDE_PATH not in self.files:
            return ""
        return (f"\n\nRecordá el kit de UI del proyecto ({uikit.GUIDE_PATH}): la interfaz se compone con los componentes de {uikit.UI_DIR}/ y las clases de tokens "
                "(bg-background, text-muted-foreground, bg-primary…); nada de controles caseros ni hex sueltos.")

    @property
    def en(self) -> bool:
        from .intake import lang_code

        return lang_code(self.req.language) == "en"

    def tx(self, es: str, en: str) -> str:
        """User-facing text in the session language (chat notes, headers)."""
        return en if self.en else es

    def _lang_note(self) -> str:
        return f"\n\nIDIOMA: tus mensajes, resúmenes, README/NOTES y todo el texto de la interfaz van en {self.req.language}."

    def _add_api_usage(self, result: Any, model: str | None = None) -> None:
        cr, cw = int(getattr(result, "cached_input_tokens", 0) or 0), int(getattr(result, "cache_write_tokens", 0) or 0)
        add = {"input": max(0, int(result.input_tokens or 0) - cr - cw), "output": int(result.output_tokens or 0), "cache_read": cr, "cache_write": cw}
        m = self.api_by_model.setdefault(model or self.req.model or "?", {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        for k, v in add.items():
            self.api_usage[k] += v
            m[k] += v

    def usage(self) -> dict:
        """Measured tokens and their list-price value for the whole build: API calls + the CLI agent (Claude Code from its logs)."""
        from .local_engine import claude_usage

        eng = claude_usage(self.workdir) if self.engine == "claude-code" and self.workdir else None
        return summarize_usage(self.api_usage, self.api_by_model, eng, self.engine_tokens, self.cost, self.engine_cost, self.engine)

    def _publish_pages(self, changed: list[str]) -> None:
        """Re-emit the prototype / mockup when they or a stylesheet or script they load changed, inlined for the pane."""
        for path, ev in ((PREVIEW_PATH, "preview.ready"), (DESIGN_MOCKUP, "design.ready")):
            raw = self.files.get(path)
            if not raw or not (path in changed or html_refs(raw, path.rsplit("/", 1)[0]) & set(changed)):
                continue
            doc = inline_html(raw, path, self.files)
            if path == PREVIEW_PATH:
                self.preview_html = doc
            else:
                self.design_html = doc
            self.emit(ev, path=path, html=doc)

    def _sync_from_disk(self) -> list[str]:
        assert self.workdir
        changed = sync_files(self.workdir, self.files)
        for rel in changed:
            c = self.files[rel]
            self.emit("file.written", path=rel, size=len(c), lines=c.count("\n") + 1, new=True, turn=self.turns)
        self._publish_pages(changed)
        return changed

    async def _run_engine(self, resume_with: str | None) -> None:
        """One pass with a local CLI agent working in self.workdir. Emits the same events as the API builder."""
        assert self.engine and self.workdir
        # the design phase writes design/ before any code: that does not make it a resume
        first = resume_with is None and not any(not p.startswith("design/") for p in self.files)
        if first:
            bar = quality_bar([a.get("role") for a in self.team] or None)
            prompt = (f"Leé BRIEF.md en este directorio: es la especificación completa del producto. CONSTRUÍ el producto entero, siguiendo su plan por etapas, "
                      f"con código real y completo (nada de placeholders), README.md con setup, .env.example con todas las variables, y tests donde el brief lo pida. "
                      f"Trabajá directamente sobre los archivos de este directorio. Si algo no está decidido, decidilo vos y anotalo en NOTES.md. "
                      f"Al terminar, creá también `{PREVIEW_PATH}`: un único archivo HTML autocontenido (CSS/JS inline, sin dependencias) con las pantallas "
                      f"principales navegables y datos de ejemplo, fiel al diseño del brief, para ver cómo queda el producto. "
                      f"Cuando termines, resumí en 5-10 líneas qué quedó construido, cómo correrlo y qué verificar.\n\n"
                      f"ESTÁNDAR DE CALIDAD (el equipo que diseñó el producto lo va a revisar con esta vara; construí para aprobarla a la primera):\n{bar}\n\n"
                      + delivery.CONTRACT_RULE
                      + (BUILDER_DESIGN_RULE if (self.workdir / "design" / "mockup.html").exists() else "")
                      + frontend_design_guide()
                      + platform_note(self.req.platform)
                      + await self._seed_uikit()
                      + (self._build_ref_prompt() if (self.workdir / RESEARCH_PATH).exists() else "")
                      + (REA_PROMPT if self.req.deep_analysis else "")
                      + self.levels_block() + PREVIEW_RULE + self._lang_note())
        elif resume_with == CONTINUE:
            prompt = ("La construcción se interrumpió. Revisá el estado actual de este directorio frente a BRIEF.md, completá lo que falte del plan "
                      f"(y los archivos incompletos), regenerá `{PREVIEW_PATH}` si cambió algo visible, y resumí qué hiciste y cómo correrlo." + PREVIEW_RULE + self._lang_note())
        else:
            prompt = (f"Pedido de cambios sobre el proyecto de este directorio (ver BRIEF.md):\n{resume_with}\n\nAplicá TODOS los cambios con archivos completos, "
                      f"actualizá README/NOTES si corresponde, regenerá `{PREVIEW_PATH}` para reflejarlos, y resumí qué cambió y cómo verificarlo."
                      + platform_note(self.req.platform)
                      + (self._build_ref_prompt() if (self.workdir / RESEARCH_PATH).exists() else "")
                      + (REA_PROMPT if self.req.deep_analysis else "") + PREVIEW_RULE + self._lang_note())
        self.turns += 1
        self.emit("turn.started", turn=self.turns, phase="build")
        buf: list[str] = []
        self.live = {"turn": self.turns, "phase": "build", "buf": buf}

        def push(delta: str) -> None:
            buf.append(delta)
            self.emit("token", delta=delta, turn=self.turns)

        push("<say>")
        tools: list[str] = []
        counts = {"write": 0, "edit": 0, "run": 0, "test": 0, "read": 0}
        think = {"buf": "", "sent": 0.0}
        self.activity = []

        async def on_event(kind: str, **d) -> None:
            if kind == "text":
                push(d["text"] + "\n\n")
            elif kind == "activity":
                tools.append(f"{d['label']} {d['path']}".strip())
                k = d.get("act", "run")
                counts[{"install": "run", "build": "run", "git": "run", "search": "read", "plan": "read", "think": "read"}.get(k, k)] = counts.get({"install": "run", "build": "run", "git": "run", "search": "read", "plan": "read", "think": "read"}.get(k, k), 0) + 1
                item = {"kind": k, "label": d["label"], "path": d.get("path", ""), "ts": time.time()}
                self.activity.append(item)
                self.activity = self.activity[-80:]
                self.emit("build.activity", turn=self.turns, **item)
            elif kind == "todos":
                self.todos = d["todos"]
                self.emit("build.todos", turn=self.turns, todos=self.todos)
            elif kind == "text_delta":
                push(d["text"])
            elif kind == "text_end":
                push("\n\n")
            elif kind in ("thinking", "reasoning"):
                # the model's reasoning, streamed: keeps the UI alive during long "silent" stretches
                think["buf"] = (think["buf"] + d["text"])[-700:]
                if not think["buf"].strip():
                    return
                if not self.activity or self.activity[-1]["kind"] != "think":
                    item = {"kind": "think", "label": "Pensando", "path": "", "ts": time.time()}
                    self.activity.append(item)
                    self.activity = self.activity[-80:]
                    self.emit("build.activity", turn=self.turns, **item)
                now = time.time()
                if now - think["sent"] > 0.35 or kind == "reasoning":
                    think["sent"] = now
                    self.emit("build.thinking", turn=self.turns, text=think["buf"])
            elif kind == "file_hint":
                self._sync_from_disk()
            if self._stop.is_set():
                raise asyncio.CancelledError

        try:
            with obs.observation(as_type="agent", name=f"engine · {self.engine}", input=prompt[:3000]) as span:
                res = await run_engine(self.engine, prompt, self.workdir, continue_=not first, resume_session=self.engine_session, model=self._engine_model(), mcp=self._engine_mcp(), on_event=on_event)
                if res.get("session_id"):
                    self.engine_session = res["session_id"]
                # the step cap of one headless run is not the end of the job: pick the same session up where it stopped
                for _ in range(3):
                    if res.get("subtype") != "error_max_turns" or self._stop.is_set():
                        break
                    self.cost += float(res.get("cost") or 0)
                    self.engine_cost += float(res.get("cost") or 0)
                    self.engine_tokens += int(res.get("tokens") or 0)
                    self._note(self.tx("El constructor llegó al límite de pasos del turno; sigue desde donde quedó.", "The builder hit the turn's step limit; it continues from where it left off."))
                    res = await run_engine(self.engine, "Seguí EXACTAMENTE desde donde quedaste con el pedido anterior: completá lo que falte, dejá todo compilando y con los tests en verde, y resumí qué cambió y cómo verificarlo.",
                                           self.workdir, continue_=True, resume_session=self.engine_session, model=self._engine_model(), mcp=self._engine_mcp(), on_event=on_event)
                    if res.get("session_id"):
                        self.engine_session = res["session_id"]
                obs.safe_update(span, output=res.get("text", "")[:8000], metadata={"turns": str(res.get("turns")), "cost": str(res.get("cost"))})
        except asyncio.CancelledError:
            res = {"text": "", "is_error": False, "error": None, "cost": 0.0}
        push("</say>")
        self.live = None
        changed = self._sync_from_disk()
        self.cost += float(res.get("cost") or 0)
        self.engine_cost += float(res.get("cost") or 0)
        self.engine_tokens += int(res.get("tokens") or 0)
        summary = (res.get("text") or "").strip()
        if res.get("is_error"):
            self.status = "error"
            self.emit("error", error=res.get("error") or "el agente local terminó con error", turn=self.turns)
        if not summary:
            summary = f"Trabajé en {len(changed)} archivo{'s' if len(changed) != 1 else ''} de este turno." if changed else "Terminé el turno sin cambios en archivos."
        entry = {"role": "assistant", "turn": self.turns, "say": summary, "files": changed, "stage": None,
                 "done": summary if not res.get("is_error") and self.files else None, "phase": "build", "tools": tools[-40:],
                 "activity": {"written": counts["write"], "edited": counts["edit"], "commands": counts["run"], "tests": counts["test"], "reads": counts["read"]}, "ts": time.time()}
        self.chat.append(entry)
        self.emit("turn.completed", **entry)
        self._push_history(prompt, summary)
        if not res.get("is_error") and self.files:
            self.status = "completed"
            if self.preview_html is None and not self._stop.is_set():
                self.turns += 1
                self.emit("turn.started", turn=self.turns, phase="preview")
                try:
                    r2 = await run_engine(self.engine, f"Falta `{PREVIEW_PATH}`: creá ese único archivo HTML autocontenido (CSS/JS inline, sin dependencias, navegable, datos de ejemplo) que muestre el producto terminado tal como lo vería el usuario.", self.workdir, continue_=True, resume_session=self.engine_session, on_event=lambda *a, **k: None)
                    self.cost += float(r2.get("cost") or 0)
                    self.engine_cost += float(r2.get("cost") or 0)
                    self.engine_tokens += int(r2.get("tokens") or 0)
                except Exception as e:
                    log.warning("preview pass failed: %s", e)
                ch2 = self._sync_from_disk()
                self.chat.append({"role": "assistant", "turn": self.turns, "say": self.tx("Vista previa generada.", "Preview generated.") if self.preview_html else self.tx("No se pudo generar la vista previa.", "The preview could not be generated."), "files": ch2, "stage": None, "done": None, "phase": "preview", "ts": time.time()})
                self.emit("turn.completed", **self.chat[-1])
        elif self.status == "running":
            self.status = "stopped" if self._stop.is_set() else "error"
        self._save()

    async def _engine_review_one(self, agent: dict, rnd: int, prior: str, mode: str = "review") -> dict:
        """A reviewer run as a read-only local agent over the project folder."""
        assert self.engine and self.workdir
        role = role_of(agent["role"])
        if mode == "audit":
            system = AUDIT_SYSTEM.format(name=agent["name"], role_label=role["label"], persona=agent.get("persona") or "profesional exigente", mandate=role["mandate"], context=self.context or "sin descripción", prior=prior, craft=expertise_block(agent["role"], mode="audit") + "\n" + skillmod.prompt_block(self.user.id, agent.get("skills")))
            prompt = f"Auditá el proyecto de este directorio (leé los archivos que necesites) como {role['label']}. Respondé SOLO con las etiquetas indicadas."
        else:
            system = REVIEW_SYSTEM.format(name=agent["name"], role_label=role["label"], persona=agent.get("persona") or "profesional exigente", mandate=role["mandate"], round=rnd, prior=prior, craft=expertise_block(agent["role"], mode="review") + "\n" + skillmod.prompt_block(self.user.id, agent.get("skills")), uikit_note=uikit.reviewer_note() if uikit.GUIDE_PATH in self.files else "")
            prompt = f"Revisá el proyecto de este directorio (leé BRIEF.md y los archivos que necesites) como {role['label']}. Respondé SOLO con las etiquetas indicadas."
        buf = self.live_reviews[agent["id"]]

        async def on_event(kind: str, **d) -> None:
            if kind == "text":
                buf.append(d["text"])
                self.emit("review.token", round=rnd, agent_id=agent["id"], delta=d["text"])

        try:
            res = await run_engine(self.engine, prompt, self.workdir, system=system, read_only=True, max_turns=25, on_event=on_event)
            text = res.get("text") or "".join(buf)
            if res.get("is_error"):
                text = f"<verdict>approve</verdict><findings>[mejora] No pude revisar: {res.get('error')}</findings><requests></requests>"
            self.cost += float(res.get("cost") or 0)
            self.engine_cost += float(res.get("cost") or 0)
            self.engine_tokens += int(res.get("tokens") or 0)
        except Exception as e:
            text = f"<verdict>approve</verdict><findings>[mejora] No pude revisar: {str(e)[:200]}</findings><requests></requests>"
        res_ = _parse_review(text, mode) | {"agent_id": agent["id"], "name": agent["name"], "role": agent["role"], "role_label": role["label"], "provider": self.engine, "model": ENGINES[self.engine]["label"]}
        self.emit("review.result", round=rnd, **res_)
        return res_




    # ------------------------------------------------------------- design phase (Product Designer, before any code)
    def _designer(self) -> tuple[str, str, Cred] | None:
        """The team's designer (or front/brand) with a usable API key; None → the builder's own model does it."""
        for role in ("product-designer", "frontend", "brand"):
            for a in self.team:
                if a.get("role") == role and self.creds_all.get(a.get("provider")) and self.creds_all[a["provider"]].source != "none" and not is_engine(a["provider"]):
                    return a["provider"], a["model"], self.creds_all[a["provider"]]
        return None

    def approve_design(self) -> None:
        self.design_feedback = None
        self._design_ok.set()

    def redo_design(self, feedback: str) -> None:
        self.design_feedback = feedback.strip()[:4000] or "Mejorá el diseño: más pulido, más claro, más profesional."
        self._design_ok.set()

    # ------------------------------------------------------------- reference research (level 1) + deep analysis fee (level 2)
    def _engine_model(self) -> str | None:
        """The model the local agent runs with: the user's choice, or the engine's strongest (Opus 5.5 for Claude Code)."""
        if self.req.model not in ("default", ""):
            return self.req.model
        return (ENGINES.get(self.req.provider) or {}).get("default_model")

    def _ref_note(self) -> str:
        """How close to the reference the work must be: a replica when the user turned on reverse engineering, close otherwise."""
        return CLONE_NOTE if self.req.deep_analysis else FIDELITY_NOTE

    def _design_ref_prompt(self) -> str:
        if self.req.deep_analysis:
            return (f"\n\nMODO CLON: ANTES de diseñar leé {RESEARCH_PATH} (plano de clonación) y abrí las capturas de research/shots/. DESIGN.md y tokens.css son la "
                    "TRANSCRIPCIÓN de ese plano: misma paleta (hex exactos), misma tipografía (o la libre equivalente), misma grilla, radios, sombras, componentes y estados que el referente. "
                    "No inventes un concepto propio, no cites otros referentes (ni Linear, ni Stripe, ni iOS) y no «mejores» nada: si el brief fija tokens distintos, manda el referente. "
                    "El mockup tiene que verse igual que la captura, con nuestro nombre, logo y textos." + self._ref_note())
        return f"\n\nANTES de diseñar leé {RESEARCH_PATH} (benchmark de apps de referencia): emulá los patrones marcados y evitá los señalados." + self._ref_note()

    def _build_ref_prompt(self) -> str:
        if self.req.deep_analysis:
            return (f"\n\nMODO CLON: leé {RESEARCH_PATH} (plano de clonación) y research/DEEP_ANALYSIS.md si existe, y abrí las capturas de research/shots/. "
                    "Construí la réplica pantalla por pantalla contra el plano y las capturas; la paleta, tipografía, grilla y componentes son las del referente aunque BRIEF.md o DESIGN.md digan otra cosa." + self._ref_note())
        return f"\n\nREFERENTES: leé {RESEARCH_PATH} (benchmark de apps de referencia que eligió el usuario) y llevá las pantallas y flujos al nivel de esos productos: emulá los patrones marcados, evitá los señalados." + self._ref_note()

    def _engine_mcp(self) -> dict | None:
        """Deep analysis (paid): the engine gets the REA MCP server for this run."""
        return rsch.rea_mcp_config() if self.req.deep_analysis else None

    def _vision_model(self) -> tuple[str, str, Cred] | None:
        """An API model that can look at screenshots: the team's designer, else the builder's own model, else any configured key."""
        who = self._designer()
        if who:
            return who
        if not is_engine(self.req.provider) and PROVIDERS.get(self.req.provider) and PROVIDERS[self.req.provider].kind != "mock":
            return self.req.provider, self.req.model, self.cred
        for pid in ("anthropic", "openai", "gemini", "xai", "openrouter"):
            c = self.creds_all.get(pid)
            if c and c.source != "none":
                return pid, c.model, c
        if PROVIDERS.get(self.req.provider) and PROVIDERS[self.req.provider].kind == "mock":
            return self.req.provider, self.req.model, self.cred
        return None

    async def _ask(self, system: str, user: str, provider: str, model: str, cred: Cred, images: list[bytes] | None = None, max_tokens: int = 4000, mock_text: str = "") -> str:
        """One non-streaming-to-UI call with token accounting (research notes are not shown token by token)."""
        result = CallResult()
        mock = MockContext("Researcher", [("x", "x")], self.title, script=mock_text or None)
        buf: list[str] = []
        async for kind, delta in stream(provider, model, system, user, temperature=0.3, max_tokens=max_tokens, result=result, mock=mock, cred=cred, images=images):
            if kind == "text":
                buf.append(delta)
            if self._stop.is_set():
                break
        self.cost += cost_usd(model, result.input_tokens, result.output_tokens, result.cached_input_tokens, result.cache_write_tokens)
        self.tokens += result.input_tokens + result.output_tokens
        self._add_api_usage(result, model)
        return "".join(buf)

    def _note(self, text: str) -> None:
        ts = time.time()
        self.chat.append({"role": "system", "text": text, "ts": ts})
        self.emit("notice", text=text, ts=ts)

    def _activity(self, kind: str, label: str, path: str = "") -> None:
        item = {"kind": kind, "label": label, "path": path, "ts": time.time()}
        self.activity = (self.activity + [item])[-80:]
        self.emit("build.activity", turn=self.turns, **item)

    async def research_phase(self, only: list[str] | None = None) -> None:
        """Level 1: visit the reference apps (headless Chrome), describe each one with a vision model, merge into research/REFERENCES.md."""
        if self.req.deep_analysis and rsch.DEEP_ANALYSIS_FEE_USD > 0 and not any(f.get("label") == DEEP_ANALYSIS_LABEL for f in self.fees):
            self.fees.append({"label": DEEP_ANALYSIS_LABEL, "usd": rsch.DEEP_ANALYSIS_FEE_USD, "ts": time.time()})
        self.status = "running"
        self.turns += 1
        self.design_turns += 1  # research turns do not count as build stages either
        self.emit("build.started", build=self.snapshot())
        self.emit("turn.started", turn=self.turns, phase="research")
        self.live = {"turn": self.turns, "phase": "research", "buf": []}
        who = self._vision_model()
        if not who:
            self._note(self.tx("Investigación de referentes omitida: hace falta una API key (Anthropic, OpenAI o Gemini) para mirar capturas.", "Reference research skipped: an API key (Anthropic, OpenAI or Gemini) is needed to look at screenshots."))
            self.live = None
            return
        provider, model, cred = who
        mock = PROVIDERS.get(provider) and PROVIDERS[provider].kind == "mock"
        refs: list[dict] = []
        for r in (only if only is not None else self.req.references)[:rsch.MAX_REFERENCES]:
            url = rsch.normalize_reference(r)
            refs.append({"name": r.strip()[:60], "url": url, "why": ""} if url else {"name": r.strip()[:60], "url": None, "why": ""})
        named_only = [r["name"] for r in refs if not r["url"]]
        user_gave = bool(refs)
        # what the user asked for is captured fresh every time (a previous capture may have been an error page); the
        # earlier entry for the same site is replaced so the notes do not duplicate
        refs = [r for r in refs if r["url"]]
        fresh = {r["url"].rstrip("/").lower() for r in refs}
        self.research_refs = [r for r in self.research_refs if (r.get("url") or "").rstrip("/").lower() not in fresh]
        shot_base = len(self.research_refs)
        if (not refs and not user_gave) or named_only:
            # the user's list is respected as is: the team only proposes references when nothing was given, and
            # otherwise just resolves the public URL of apps the user typed by name
            if named_only and refs:
                self._note(self.tx("Buscando la URL de: ", "Looking up the URL of: ") + ", ".join(named_only))
                self._activity("search", "Resolviendo referentes nombrados")
                ask = f"BRIEF:\n{self.brief[:6000]}\n\nEl usuario nombró estas apps (devolvé solo ellas, con su URL pública): {', '.join(named_only)}\nProponé exactamente {len(named_only)} referentes (JSON)."
                want = len(named_only)
            else:
                self._note(self.tx("El equipo propone apps de referencia para esta categoría…", "The team proposes reference apps for this category…") if not named_only else self.tx("El equipo busca las apps que nombraste y completa con referentes de la categoría…", "The team looks up the apps you named and adds references from the category…"))
                self._activity("search", "Buscando referentes")
                ask = f"BRIEF:\n{self.brief[:6000]}\n\n" + (f"El usuario nombró estas apps (buscá su URL pública e incluilas primero): {', '.join(named_only)}\n" if named_only else "") + f"Proponé {max(3, len(named_only))} referentes (JSON)."
                want = rsch.MAX_REFERENCES
            text = await self._ask(rsch.PROPOSE_SYSTEM, ask, provider, model, cred, max_tokens=1200, mock_text='[{"name":"Open-Meteo","url":"https://open-meteo.com","why":"API de clima abierta"},{"name":"Windy","url":"https://www.windy.com","why":"mapas"}]' if mock else "")
            seen = {r["url"] for r in refs}
            added = 0
            for pr in rsch.parse_proposals(text):
                if pr["url"] not in seen and len(refs) < rsch.MAX_REFERENCES and added < want:
                    refs.append(pr)
                    seen.add(pr["url"])
                    added += 1
        if not refs:
            self._note(self.tx("No se encontraron referentes para investigar; el diseño sigue solo con el brief.", "No references found to research; the design continues from the brief alone."))
            self.live = None
            return
        self._note(self.tx("Analizando modelos de referencia: el equipo saca capturas y anota qué emular y qué evitar.", "Analyzing reference models: the team takes screenshots and notes what to emulate and what to avoid.") if self.req.references_auto else
                   self.tx("Investigación de referentes: ", "Reference research: ") + ", ".join(r["name"] or r["url"] for r in refs) + self.tx(". El equipo entra a cada app, saca capturas y anota qué emular y qué evitar.", ". The team opens each app, takes screenshots and notes what to emulate and what to avoid."))
        notes: list[str] = []
        for i, ref in enumerate(refs, 1):
            if self._stop.is_set():
                break
            self._activity("search", f"Entrando a {ref['name'] or ref['url']}", ref["url"])
            cap = await rsch.capture_async(ref["url"])
            shots = rsch.save_shots(self.workdir, shot_base + i, cap)
            entry = {"name": ref["name"], "url": ref["url"], "why": ref.get("why", ""), "ok": cap.ok, "error": cap.error, "shots": shots, "title": cap.title}
            self.research_refs.append(entry)
            self.emit("research.reference", **entry)
            if not cap.ok:
                None if self.req.references_auto else self._note(self.tx(f"No se pudo abrir {ref['url']}: {cap.error}", f"Could not open {ref['url']}: {cap.error}"))
                continue
            self._activity("read", f"Analizando {ref['name'] or cap.title or ref['url']}", ref["url"])
            images = [im for im in (cap.desktop, cap.mobile) if im] if not mock else None
            analysis = await self._ask(rsch.analyze_system(bool(self.req.deep_analysis)), rsch.build_user_prompt_for_analysis(cap, self.brief), provider, model, cred, images=images, max_tokens=4500 if self.req.deep_analysis else 3000,
                                       mock_text=f"## 1. Qué es\n{cap.title or ref['url']} (simulado).\n## 2. Pantallas\nHome con buscador y pronóstico.\n## 3. Patrones\nCards, jerarquía clara.\n## 4. Decisiones\nSin cuentas.\n## 5. Emular / evitar\nEmular: buscador arriba. Evitar: densidad excesiva.")
            notes.append(f"## {ref['name'] or cap.title or ref['url']}\nURL: {ref['url']}\n\n{analysis.strip()}")
            None if self.req.references_auto else self._note(self.tx(f"{ref['name'] or cap.title or ref['url']}: notas tomadas ({len(analysis.split())} palabras).", f"{ref['name'] or cap.title or ref['url']}: notes taken ({len(analysis.split())} words)."))
        md = ""
        if notes and not self._stop.is_set():
            self._activity("plan", "Armando el brief de referentes", RESEARCH_PATH)
            synth = await self._ask(rsch.synth_system(bool(self.req.deep_analysis)), f"NUESTRO BRIEF:\n{self.brief[:8000]}\n\nREFERENTES (en orden de prioridad): {', '.join(r['name'] or r['url'] for r in refs)}\n\nNOTAS DE BENCHMARK:\n\n" + "\n\n---\n\n".join(notes), provider, model, cred, max_tokens=8000,
                                    mock_text="# Referentes\n| app | mejor | falta |\n|---|---|---|\n| Open-Meteo | API clara | UI |\n# Patrones a emular\n- Buscador arriba\n# Patrones a evitar\n- Densidad\n# Flujo recomendado\n1. Buscar ciudad 2. Ver pronóstico\n# Copy y tono\nDirecto.\n# Checklist\n1. Carga < 2 s")
            md = f"<!-- Benchmark generado por Muse Team el {rsch.stamp()}. Observación de productos públicos; nada copiado. -->\n\n{synth.strip()}\n\n---\n\n# Notas por referente\n\n" + "\n\n".join(notes) + "\n"
            self._write(RESEARCH_PATH, md)
            self.research_md = md
            if self.workdir:
                dest = self.workdir / RESEARCH_PATH
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(md)
            self._push_history("(investigación de referentes)", f"Benchmark de {len(notes)} apps de referencia en {RESEARCH_PATH}.")
        entry = {"role": "assistant", "turn": self.turns, "say": (f"Benchmark listo: {len(notes)} referentes en {RESEARCH_PATH}. El diseñador y el constructor lo usan como vara." if md else "La investigación no dejó notas utilizables."), "files": [RESEARCH_PATH] if md else [], "stage": None, "done": None, "phase": "research", "ts": time.time()}
        self.chat.append(entry)
        self.emit("turn.completed", **entry)
        self.emit("research.done", markdown=md, references=self.research_refs)
        self.live = None
        self._save()

    async def design_phase(self, feedback: str | None = None) -> None:
        """design/DESIGN.md + tokens.css + mockup.html, by a designer model (API) or by the local engine."""
        self._design_feedback_now = feedback
        self.status = "running"
        self.turns += 1
        self.design_turns += 1
        self.emit("build.started", build=self.snapshot())
        self.emit("turn.started", turn=self.turns, phase="design")
        self.chat.append({"role": "system", "text": self.tx("Fase de diseño: el Product Designer diseña la interfaz antes de escribir código.", "Design phase: the Product Designer designs the interface before any code is written."), "ts": time.time()})
        if self.engine and not self._designer():
            await self._engine_design()
            return
        who = self._designer()
        provider, model, cred = who if who else (self.req.provider, self.req.model, self.cred)
        if is_engine(provider):
            await self._engine_design()
            return
        designer = next((a for a in self.team if a.get("role") == "product-designer"), None)
        system = design_system_prompt(self.req.language, self.req.platform) + ("\n\n" + skillmod.prompt_block(self.user.id, designer.get("skills")) if designer and designer.get("skills") else "")
        user_msg = DESIGN_USER.format(brief=self.brief[:30000]) + design_platform_note(self.req.platform) + research_context(self.research_md, bool(self.req.deep_analysis)) + (self._ref_note() if self.research_md else "")
        if feedback:
            prev = self.files.get("design/DESIGN.md", "")[:12000]
            user_msg += f"\n\n---\nYA HAY UNA VERSIÓN DEL DISEÑO (abajo). El usuario la vio y pide ESTOS CAMBIOS, que son prioridad absoluta:\n{feedback}\n\nRediseñá entregando los tres archivos completos otra vez, aplicando los cambios y mejorando el resto.\n\nDISEÑO ANTERIOR (DESIGN.md):\n{prev}"
        text = await self._turn(system, user_msg, phase="design", provider=provider, model=model, cred=cred)
        if text is None:
            return
        parsed = self._apply(text, phase="design")
        if self.workdir:  # local agents build from disk: give them the design files too
            for rel in parsed.get("files", []):
                if rel.startswith("design/"):
                    dest = self.workdir / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(self.files[rel])
        self._push_history("(fase de diseño)", f"Diseño entregado en design/: {', '.join(parsed.get('files', []))}")
        self._save()

    async def _ensure_mockup(self, tries: int = 2) -> None:
        """The design review is about the mockup: if the designer's turn ran out before writing design/mockup.html (it is the
        longest of the three files), ask for that file alone, with DESIGN.md and tokens.css as the source."""
        for _ in range(tries):
            if DESIGN_MOCKUP in self.files or self._stop.is_set() or self.status == "error":
                return
            self.chat.append({"role": "system", "text": self.tx("Falta la maqueta (design/mockup.html): el diseñador la entrega ahora.", "The mockup (design/mockup.html) is missing: the designer delivers it now."), "ts": time.time()})
            ask = (f"Faltó {DESIGN_MOCKUP}. Entregá SOLO ese archivo, completo, con el protocolo <say>…</say><file path=\"{DESIGN_MOCKUP}\">…</file>: un único HTML autocontenido "
                   "(CSS inline en <style>, sin frameworks; Google Fonts por <link> si el diseño define una familia) que copia el :root de tokens.css y muestra las 3-5 pantallas clave "
                   "en alta fidelidad, navegables entre sí con JS mínimo, con datos reales del dominio, un estado vacío y uno de error, responsive. Sé eficiente con el largo: CSS compartido "
                   f"en clases, sin repetir estilos inline. Idioma del copy: {self.req.language}.\n\n"
                   f"===== design/DESIGN.md =====\n{self.files.get('design/DESIGN.md', '')[:14000]}\n\n===== design/tokens.css =====\n{self.files.get('design/tokens.css', '')[:6000]}")
            self.turns += 1
            self.design_turns += 1
            self.emit("turn.started", turn=self.turns, phase="design")
            if self.engine and not self._designer():
                assert self.workdir
                res = await run_engine(self.engine, ask.split("\n\n=====")[0] + " Escribilo directamente en el archivo; DESIGN.md y tokens.css ya están en design/.", self.workdir, resume_session=self.engine_session, model=self._engine_model())
                self.cost += float(res.get("cost") or 0)
                self.engine_cost += float(res.get("cost") or 0)
                self.engine_tokens += int(res.get("tokens") or 0)
                self._sync_from_disk()
            else:
                who = self._designer()
                provider, model, cred = who if who else (self.req.provider, self.req.model, self.cred)
                system = design_system_prompt(self.req.language, self.req.platform)
                text = await self._turn(system, ask, phase="design", provider=provider, model=model, cred=cred)
                if text is None:
                    return
                self._apply(text, phase="design")
                if self.workdir and DESIGN_MOCKUP in self.files:
                    dest = self.workdir / DESIGN_MOCKUP
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(self.files[DESIGN_MOCKUP])
            if DESIGN_MOCKUP in self.files:
                self.design_html = inline_html(self.files[DESIGN_MOCKUP], DESIGN_MOCKUP, self.files)
                self.emit("design.ready", path=DESIGN_MOCKUP, html=self.design_html)
            self._save()

    async def _engine_design(self) -> None:
        assert self.engine and self.workdir
        buf: list[str] = []
        self.live = {"turn": self.turns, "phase": "design", "buf": buf}
        self.activity = []

        async def on_event(kind: str, **d) -> None:
            if kind in ("text", "text_delta"):
                buf.append(d["text"] + ("\n\n" if kind == "text" else ""))
                self.emit("token", delta=d["text"], turn=self.turns)
            elif kind == "activity":
                item = {"kind": d.get("act", "run"), "label": d["label"], "path": d.get("path", ""), "ts": time.time()}
                self.activity = (self.activity + [item])[-80:]
                self.emit("build.activity", turn=self.turns, **item)
            elif kind == "file_hint":
                self._sync_from_disk()
            if self._stop.is_set():
                raise asyncio.CancelledError

        try:
            designer = next((a for a in self.team if a.get("role") == "product-designer"), None)
            fb = getattr(self, "_design_feedback_now", None)
            dprompt = ENGINE_DESIGN_PROMPT + uikit.designer_block(self.req.platform) + frontend_design_guide() + design_platform_note(self.req.platform) + (self._design_ref_prompt() if self.research_md else "") + (REA_PROMPT if self.req.deep_analysis else "") + (f"\n\nYA EXISTE design/ y el usuario lo revisó. Pide ESTOS CAMBIOS (prioridad absoluta): {fb}\nRediseñá los tres archivos aplicándolos y mejorando el resto." if fb else "") + ("\n\n" + skillmod.prompt_block(self.user.id, designer.get("skills")) if designer and designer.get("skills") else "")
            res = await run_engine(self.engine, dprompt, self.workdir, resume_session=self.engine_session, model=self._engine_model(), mcp=self._engine_mcp(), on_event=on_event)
            if res.get("session_id"):
                self.engine_session = res["session_id"]
        except asyncio.CancelledError:
            res = {"text": "", "is_error": False, "error": None, "cost": 0.0}
        self.live = None
        changed = self._sync_from_disk()
        self.cost += float(res.get("cost") or 0)
        self.engine_cost += float(res.get("cost") or 0)
        self.engine_tokens += int(res.get("tokens") or 0)
        say = (res.get("text") or "").strip() or f"Diseño entregado: {', '.join(changed) or 'sin archivos'}."
        entry = {"role": "assistant", "turn": self.turns, "say": say, "files": changed, "stage": None, "done": None, "phase": "design", "ts": time.time()}
        self.chat.append(entry)
        self.emit("turn.completed", **entry)
        self._save()

    # ------------------------------------------------------------- versions
    def snapshot_version(self) -> dict:
        """Freeze the current tree as the next version, with the diff vs the previous one and a git tag (best effort)."""
        n = len(self.versions) + 1
        prev = vers.load_version_files(self._path(), n - 1) if n > 1 else {}
        cur = dict(self.files)
        stats = vers.diff_stats(prev, cur)
        summary = next((c.get("say", "") for c in reversed(self.chat) if c.get("role") == "assistant" and c.get("say")), "")
        root = self.workdir if self.workdir else None
        if root is None:
            try:
                from .deploy import materialize

                root = materialize(self.user.id, self.id, self.files, None)
            except Exception:
                root = None
        commit = vers.git_commit(root, n, f"v{n}: {self._pending_trigger} · {len(self._pending_requests)} cambios pedidos") if root else None
        v = vers.version_record(n, self._pending_trigger, self._pending_requests, self._pending_from, stats, len(cur), summary, commit)
        self.versions.append(v)
        try:
            vers.save_version_files(self._path(), n, cur)
        except Exception as e:  # pragma: no cover
            log.warning("could not save version files: %s", e)
        self._pending_requests, self._pending_trigger, self._pending_from = [], "user", None
        self.emit("build.version", **v)
        self._save()
        return v

    def on_council_verdict(self, session_id: str, council: dict) -> None:
        """Called by the arena when the council finished reviewing: scores the version it looked at."""
        if not self.versions:
            return
        v = self.versions[-1]
        v["council_session"] = session_id
        v["verdict"] = {"approved": bool(council.get("approved")), "headline": council.get("headline", ""), "changes": len(council.get("changes") or [])}
        resolved = council.get("resolved") or []
        v["resolved"] = resolved
        v["readiness"] = vers.readiness(bool(council.get("approved")), resolved, len(v["requested"]), council.get("changes") or [])
        if council.get("approved"):
            self.status = "approved"
            self.emit("build.approved", round=len(self.council_sessions))
            self._auto_publish_after_save = True
        self.emit("build.readiness", n=v["n"], readiness=v["readiness"], approved=bool(council.get("approved")), resolved=resolved)
        self._save()
        try:  # a build resolving a Notion ticket: approval opens the PR and moves the ticket (see main.ticket_on_verdict)
            from .main import ticket_on_verdict

            ticket_on_verdict(self, session_id, bool(council.get("approved")), len(council.get("changes") or []))
        except Exception as e:  # noqa: BLE001
            log.warning("ticket hook failed: %s", e)
        if getattr(self, "_auto_publish_after_save", False):
            self._auto_publish_after_save = False
            self._auto_publish()

    async def _ensure_delivery(self) -> None:
        """The first delivery is everything the user asked for, end to end: when the builder says it is done, Muse Team checks the
        code against the brief and the delivery contract and sends it back to complete what is missing (at most twice)."""
        if getattr(self, "_error_fix", False) or getattr(self, "_deploy_fix", False):
            return
        result = None
        for attempt in range(3):
            if self.status != "completed" or not self.files or self._stop.is_set():
                return
            result = delivery.check(self.files, self.brief, self.title)
            if not result["gaps"] or attempt == 2:
                break
            missing = [c for c in result["checks"] if not c["ok"]]
            again = self.tx("Segunda pasada. ", "Second pass. ") if attempt else ""
            self._delivery_note(again + self.tx(f"Verificación de entrega: faltan {len(missing)} {'cosa' if len(missing) == 1 else 'cosas'} de lo que pediste. El constructor las completa antes de entregarte la app.",
                                        f"Delivery check: {len(missing)} {'thing is' if len(missing) == 1 else 'things are'} missing from what you asked for. The builder completes them before handing the app over."),
                                "working", result)
            await self.run(delivery.prompt(result))
        if result is None or not result["checks"]:
            return
        if result["gaps"]:
            self._delivery_note(self.tx("Verificación de entrega: después de dos pasadas de completado quedan puntos sin cubrir. Tocá «Completar lo que falta» para otra pasada.",
                                        "Delivery check: after two completion passes some points are still open. Tap «Complete what is missing» for another pass."), "attention", result)
        else:
            self._delivery_note(self.tx("Verificación de entrega: todo lo que pediste está construido de punta a punta.", "Delivery check: everything you asked for is built end to end."), "done", result)

    def _delivery_note(self, text: str, tone: str, result: dict) -> None:
        checks = [{"label": c["label"], "ok": c["ok"]} for c in result["checks"]]
        detail = " · ".join(result["gaps"])[:400]
        item = {"role": "system", "text": text, "ts": time.time(), "tone": tone, "checks": checks, **({"detail": detail} if detail else {})}
        self.chat.append(item)
        self.emit("notice", **{k: v for k, v in item.items() if k not in ("role", "ts")})
        self._save()

    async def _ensure_identity(self) -> None:
        """A web app ends with its own logo and tab icon: if they are missing, the builder designs them (once per run)."""
        from . import identity

        if self.status != "completed" or not self.files or self._stop.is_set() or getattr(self, "_identity_asked", False):
            return
        if getattr(self, "_error_fix", False) or getattr(self, "_deploy_fix", False):
            return  # a fix stays a fix: the identity comes with the next regular turn
        if not identity.gaps(self.files):
            return
        self._identity_asked = True
        self.chat.append({"role": "system", "text": self.tx("Identidad visual: el constructor diseña el logo y el ícono de la pestaña de la app.", "Visual identity: the builder designs the app's logo and tab icon."), "ts": time.time()})
        await self.run(identity.prompt(self.files, self.title))

    def _auto_publish(self) -> None:
        """An app already online is republished when new approved work lands (main.auto_publish decides; never blocks)."""
        try:
            from .main import auto_publish

            auto_publish(self)
        except Exception as e:  # noqa: BLE001
            log.warning("auto publish failed: %s", e)

    def pending_council(self) -> str | None:
        """Council session whose verdict is waiting for the user's decision (build with its changes or not)."""
        if self.status in ("running", "reviewing") or not self.versions:
            return None
        v = self.versions[-1]
        if v.get("council_session") and v.get("verdict") and not v["verdict"].get("approved"):
            return v["council_session"]
        return None

    def version_diff(self, n: int, path: str) -> str:
        cur = vers.load_version_files(self._path(), n) if n < len(self.versions) else dict(self.files)
        prev = vers.load_version_files(self._path(), n - 1) if n > 1 else {}
        return vers.unified_diff(prev, cur, path, f"v{n - 1}" if n > 1 else "∅", f"v{n}")

    def set_team_skills(self, agent_id: str, skill_ids: list[str]) -> bool:
        """Skills for a role of this build's team (used by the next council round / review / design)."""
        for a in self.team:
            if a.get("id") == agent_id:
                a["skills"] = list(dict.fromkeys(skill_ids))[:12]
                self.emit("build.team", team=self.snapshot()["team"])
                self._save()
                return True
        return False

    def set_team(self, agents: list[dict]) -> list[dict]:
        """Replace the council: add/remove roles, change company/model/name. Personas and skills of roles kept by id
        survive; the next council round, review or design phase uses the new team."""
        old = {a.get("id"): a for a in self.team}
        out: list[dict] = []
        for i, a in enumerate(agents[:8]):
            if not isinstance(a, dict) or not role_of(a.get("role")):
                continue
            aid = str(a.get("id") or f"rol-{i + 1}")
            prev = old.get(aid, {})
            out.append({
                **prev,
                "id": aid, "name": str(a.get("name") or prev.get("name") or role_of(a.get("role"))["label"])[:60], "role": a.get("role"),
                "provider": str(a.get("provider") or prev.get("provider") or self.req.provider), "model": str(a.get("model") or prev.get("model") or self.req.model),
                "color": a.get("color") or prev.get("color"), "skills": a.get("skills") if isinstance(a.get("skills"), list) else prev.get("skills"),
            })
        self.team = out
        self.emit("build.team", team=self.snapshot()["team"])
        self._save()
        return self.snapshot()["team"]

    # ------------------------------------------------------------- council review (live arena debate, mode "review")
    def council_agents(self) -> list[dict]:
        """Team roles that can speak via API (their own provider, or the builder's when the key is missing)."""
        out = []
        for a in self.team:
            prov = a.get("provider")
            if self.creds_all.get(prov) and self.creds_all[prov].source != "none":
                out.append(dict(a))
            elif not is_engine(self.req.provider) and self.creds_all.get(self.req.provider):
                out.append(dict(a) | {"provider": self.req.provider, "model": self.req.model})
        return out

    def add_references(self, references: list[str], deep_analysis: bool = False) -> list[str]:
        """Reference apps / URLs added later (council, verdict…): the new ones join the build and are returned."""
        have = {r.strip().lower() for r in self.req.references}
        new = [r.strip() for r in references if isinstance(r, str) and r.strip() and r.strip().lower() not in have]
        self.req.references = (self.req.references + new)[:12]
        if deep_analysis:
            self.req.deep_analysis = True
        return new

    async def research_then_council(self, priorities: str | None, new_refs: list[str], focus: str = "production") -> None:
        """New references before a council round: benchmark them (research/REFERENCES.md grows), then open the council."""
        before = self.status
        try:
            if new_refs:
                self.chat.append({"role": "system", "text": self.tx(f"Investigando {len(new_refs)} referente(s) antes del consejo: {', '.join(new_refs)[:300]}", f"Researching {len(new_refs)} reference(s) before the council: {', '.join(new_refs)[:300]}"), "ts": time.time()})
                await self.research_phase(only=new_refs)
        except Exception as e:  # noqa: BLE001
            self._note(self.tx("La investigación de referentes falló: ", "The reference research failed: ") + str(e)[:200])
        finally:
            self.status = before if before not in ("running", "reviewing") else "completed"
            self.live = None
            self.emit("build.status", status=self.status, build=self.snapshot())
            self._save()
        self.start_council(priorities=priorities, focus=focus)

    def start_council(self, priorities: str | None = None, focus: str = "production", audit: bool = False) -> str | None:
        """Launches the pre-production review as an arena session (same UI as the debate). Returns the session id."""
        if priorities is not None:
            self.council_priorities = priorities
        from .orchestrator import start_session
        from .schemas import SessionConfig

        agents = self.council_agents()
        if len(agents) < 2:
            return None
        rnd = len(self.council_sessions) + 1
        digest = f"BRIEF (resumen):\n{self.brief[:6000]}{research_context(self.research_md, bool(self.req.deep_analysis))}\n\n{self._project_digest()[:50000]}"
        prior = ""
        prior_requests = list(self.versions[-1]["requested"]) if self.versions else []
        if prior_requests:
            prior = "\n\nÍTEMS PEDIDOS EN LA RONDA ANTERIOR (verificá si el constructor los resolvió):\n" + "\n".join(f"- [{r['id']}] [{r.get('severity', 'mejora')}] {r['text'][:220]}" for r in prior_requests)
        prio = (self.council_priorities or "").strip()[:2000]
        self.council_priorities = ""
        design_focus = focus == "design"
        if design_focus:
            prior += ("\n\nENFOQUE DE ESTA RONDA: DISEÑO Y EXPERIENCIA. Solo se revisa cómo se ve y cómo se siente el producto: layout, jerarquía, componentes, paleta, tipografía, "
                      "espaciado, estados, interacciones, motion, responsive y pulido visual, comparado con el «Plano visual objetivo» de los referentes. "
                      "FUERA DE ALCANCE (no lo pidan ni lo mencionen): tests, CI, deploy, legales, términos de uso, rendimiento medido, seguridad, deuda técnica. "
                      "Diseño lidera; cada rol aporta desde lo suyo pero siempre sobre pantallas concretas. Pidan cambios región por región, con archivo y pantalla.")
        if self.req.references and self.research_md:
            prior += ("\n\nREFERENTES ELEGIDOS POR EL USUARIO: " + ", ".join(self.req.references[:8]) + f". Sus notas están en {RESEARCH_PATH} (arriba). "
                      "Cada rol compara el proyecto contra esos referentes desde su área (Diseño y Product: layout, jerarquía, interacciones, estados; Head of Eng y CTO: arquitectura y datos) "
                      "y pide como cambios CONCRETOS, con pantalla y archivo, lo que haya que emular para estar a ese nivel. No basta con decir que está bien: la vara son los referentes. "
                      "Diseño y Product: comparen cada pantalla nuestra con el «Plano visual objetivo» de REFERENCES.md y pidan, región por región, lo que falta para que quede igual de estructurada (layout, componentes, paleta, tipografía, interacciones).")
            if self.req.deep_analysis:
                prior += ("\n\nMODO CLON: el usuario quiere una RÉPLICA del referente principal (todo igual salvo nombre, logo y textos literales). Cada rol compara lado a lado contra las capturas de research/shots/ y "
                          "pide TODO lo que difiera: pantallas que faltan, funcionalidades visibles no implementadas, regiones con otra proporción, colores o tipografías distintas, interacciones ausentes. La vara es la igualdad.")
        if audit:
            prior += ("\n\nAUDITORÍA DE UN PROYECTO EXISTENTE: este proyecto lo subió el usuario, no lo construyó este equipo. No hay brief previo: el «brief» de arriba es solo el árbol "
                      "de archivos y la descripción del usuario. Cada rol revisa el estado real del código desde su área (producto, arquitectura, calidad, diseño, seguridad, datos) y pide "
                      "cambios CONCRETOS con archivo y pantalla, en orden de impacto: primero lo que bloquea una salida a producción, después mejoras. Al final el consejo entrega la lista "
                      "de cambios que el constructor va a aplicar sobre este mismo código.")
        if prio:
            prior += f"\n\nPRIORIDADES DEL USUARIO PARA ESTA RONDA (tratarlas primero):\n{prio}"
        lv = self.levels_eval()
        level_items = [{"id": f"N{i + 1}", "text": c["label"], "who": c["who"]} for i, c in enumerate(lv.get("pending") or [])]
        if not design_focus:
            prior += self.levels_block()
        ref_names = ", ".join(r.replace("https://", "").replace("http://", "").strip("/") for r in self.req.references[:3]) if self.req.references else ""
        refs_label = ref_names or self.tx("los referentes", "the references")
        cfg = SessionConfig(
            topic=(self.tx(f"Auditoría · ronda {rnd}: ¿qué hay que cambiar en {self.title} antes de salir a producción?", f"Audit · round {rnd}: what must change in {self.title} before going to production?") if audit
                   else self.tx(f"Revisión de diseño · ronda {rnd}: ¿las pantallas de {self.title} están al nivel de {refs_label}?", f"Design review · round {rnd}: are the screens of {self.title} on par with {refs_label}?") if design_focus
                   else self.tx(f"Revisión pre-producción · ronda {rnd}: ¿{self.title} está listo para salir?", f"Pre-production review · round {rnd}: is {self.title} ready to ship?")),
            title=(self.tx(f"Auditoría · {self.title} · ronda {rnd}", f"Audit · {self.title} · round {rnd}") if audit else self.tx(f"Consejo · {self.title} · ronda {rnd}", f"Council · {self.title} · round {rnd}")) + (self.tx(" · diseño", " · design") if design_focus else ""),
            language=self.req.language,
            mode="review", agents=[{k: v for k, v in a.items() if k in ("id", "role", "name", "provider", "model", "persona", "wanted_provider", "skills") and v is not None} for a in agents],
            max_turns=min(60, max(4, 2 * len(agents))), min_turns=min(len(agents), 4), final_vote=False, closing_round=True, pace_ms=500, max_tokens=1600,
            auto_skills=True,  # the council picks catalog skills the review needs (per role, on top of the user's)
            judge=agents[0]["id"], context=digest + prior, review_of={"build_id": self.id, "session_id": self.req.session_id, "title": self.title, "round": rnd, "version": len(self.versions), "prior_requests": prior_requests, "priorities": prio, "focus": focus, "level": {"current": lv.get("level", 0), "next": lv.get("next"), "label": lv.get("next_label"), "pct": lv.get("pct"), "items": level_items if not design_focus else []}},
        )
        s = start_session(cfg, self.user, self.creds_all)
        self.council_sessions.append(s.id)
        self.chat.append({"role": "system", "text": self.tx(f"El consejo revisa el proyecto en la arena (ronda {rnd}).", f"The council reviews the project in the arena (round {rnd})."), "ts": time.time()})
        self.emit("build.council", session_id=s.id, round=rnd)
        self._save()
        return s.id

    async def research_then_apply(self, changes: list[dict], session_id: str, refs: list[str]) -> None:
        """References added when accepting the council's list: benchmark them first, then apply the list with that bar."""
        USER_ENV.set(user_claude_env(self.user.id))  # the engine runs as this user (their own subscription token on a server)
        before = self.status
        try:
            self.chat.append({"role": "system", "text": self.tx(f"Investigando {len(refs)} referente(s) antes de aplicar los cambios: {', '.join(refs)[:300]}", f"Researching {len(refs)} reference(s) before applying the changes: {', '.join(refs)[:300]}"), "ts": time.time()})
            await self.research_phase(only=refs)
        except Exception as e:  # noqa: BLE001
            self._note(self.tx("La investigación de referentes falló: ", "The reference research failed: ") + str(e)[:200])
        finally:
            self.status = before if before not in ("running", "reviewing") else "completed"
            self.live = None
            self.emit("build.status", status=self.status, build=self.snapshot())
            self._save()
        self.apply_council(changes, session_id)

    def apply_council(self, changes: list[dict], session_id: str) -> None:
        """The user accepted the council's list: the builder applies it; a new council round follows if rounds remain."""
        if self.status in ("running", "reviewing"):
            return
        self.reviews.append({"round": len(self.council_sessions), "mode": "council", "session_id": session_id, "approved": False, "changes": changes, "results": [], "ts": time.time()})
        self._pending_requests, self._pending_trigger, self._pending_from = list(changes), "council", session_id
        text = "CAMBIOS PEDIDOS POR EL CONSEJO DE REVISIÓN (ronda {r}):\n".format(r=len(self.council_sessions)) + "\n".join(
            f"- [{c.get('severity', 'mejora')}]{(' [' + c['role'] + ']') if c.get('role') else ''} {c['text']}" for c in changes if c.get("text"))
        sev = {"bloqueante": ("bloqueante", "blocking"), "mejora": ("mejora", "improvement")}
        shown = self.tx(f"Cambios pedidos por el consejo (ronda {len(self.council_sessions)}):", f"Changes requested by the council (round {len(self.council_sessions)}):") + "\n" + "\n".join(
            f"- [{self.tx(*sev.get(c.get('severity', 'mejora'), (c.get('severity', ''),) * 2))}]{(' [' + c['role'] + ']') if c.get('role') else ''} {c['text']}" for c in changes if c.get("text"))
        text += "\n\nAplicá TODOS los cambios con archivos completos (respetando el estilo y la estructura existentes), primero los bloqueantes, actualizá README/NOTES si corresponde y, al terminar, emití <done>."
        text += self.levels_block()
        if self.req.references and self.research_md:
            who = "REFERENTES" if self.req.references_auto else "REFERENTES del usuario"
            text += f"\n\n{who}: {', '.join(self.req.references[:8])} (notas en {RESEARCH_PATH}). Los cambios de UI y flujo tienen que dejar el producto al nivel de esos referentes." + self._ref_note()
        text += PREVIEW_RULE
        self.status = "running"
        self._stop = asyncio.Event()
        self.chat.append({"role": "user", "text": shown, "ts": time.time()})  # the chat shows the list; the instructions go to the builder only
        self.task = spawn(self.pipeline(text))

    # ------------------------------------------------------------- pre-production review
    def _project_digest(self) -> str:
        """Tree + file contents for reviewers, within a char budget (key files first)."""
        prio = ["design/DESIGN.md", "design/tokens.css", "README.md", "NOTES.md", ".env.example", "package.json", "pyproject.toml", "requirements.txt"]
        # the seeded kit (shadcn components, Tailwind glue) is vendor code: listed in the tree, never dumped
        vendored = {p for p in self.files if p.startswith(uikit.UI_DIR + "/") or p in (uikit.UTILS_PATH, uikit.INDEX_CSS, "components.json")}
        keyed = sorted((p for p in self.files if p not in vendored), key=lambda p: (0 if p in prio else 1 if re.search(r"(schema|migration|prisma|\.sql$)", p) else 2 if p == PREVIEW_PATH else 1, p))
        tree = "\n".join(f"- {p} ({c.count(chr(10)) + 1} líneas)" + (" [kit de UI sembrado por Muse Team]" if p in vendored else "") for p, c in self.files.items())
        out = [f"ÁRBOL ({len(self.files)} archivos):\n{tree}\n"]
        used = len(out[0])
        for p in keyed:
            c = self.files[p]
            if p == PREVIEW_PATH:
                c = c[:3000] + ("\n…(recortado)" if len(c) > 3000 else "")
            chunk = f"\n===== {p} =====\n{c[:8000]}{'…(recortado)' if len(c) > 8000 else ''}\n"
            if used + len(chunk) > REVIEW_CONTEXT_CHARS:
                out.append(f"\n(… {len(keyed) - keyed.index(p)} archivos más no incluidos por tamaño)")
                break
            out.append(chunk)
            used += len(chunk)
        return "".join(out)

    async def run_review(self, rnd: int, mode: str = "review") -> dict | None:
        self.status = "reviewing"
        reviewers = [{k: a.get(k) for k in ("id", "name", "role", "provider", "model", "color")} | {"role_label": role_of(a["role"])["label"]} for a in self.team]
        self.emit("review.started", round=rnd, reviewers=reviewers, mode=mode)
        digest = self._project_digest()
        prior = ""
        if self.reviews:
            last = self.reviews[-1]
            prior = "En la ronda anterior pediste: " + " | ".join(r["requests"][:400] for r in last["results"] if r["verdict"] == "changes") + "\nVerificá si se resolvió."
        self.live_reviews = {a["id"]: [] for a in self.team}

        async def one(agent: dict) -> dict:
            role = role_of(agent["role"])
            if mode == "audit":
                system = AUDIT_SYSTEM.format(name=agent["name"], role_label=role["label"], persona=agent.get("persona") or "profesional exigente", mandate=role["mandate"], context=self.context or "sin descripción", prior=prior, craft=expertise_block(agent["role"], mode="audit") + "\n" + skillmod.prompt_block(self.user.id, agent.get("skills")))
                user = f"PROYECTO: {self.title}\n\n{digest}\n\nAuditá como {role['label']}."
            else:
                system = REVIEW_SYSTEM.format(name=agent["name"], role_label=role["label"], persona=agent.get("persona") or "profesional exigente", mandate=role["mandate"], round=rnd, prior=prior, craft=expertise_block(agent["role"], mode="review") + "\n" + skillmod.prompt_block(self.user.id, agent.get("skills")), uikit_note=uikit.reviewer_note() if uikit.GUIDE_PATH in self.files else "")
                user = f"BRIEF (resumen):\n{self.brief[:12000]}\n\nPROYECTO ENTREGADO:\n{digest}\n\nRevisá como {role['label']}."
            provider = agent["provider"] if self.creds_all.get(agent["provider"]) and self.creds_all[agent["provider"]].source != "none" else self.req.provider
            model = agent["model"] if provider == agent["provider"] else self.req.model
            cred = self.creds_all.get(provider) or self.cred
            result = CallResult()
            mock = MockContext(agent["name"], [("x", "x")], self.title, script=_mock_audit_script(agent) if mode == "audit" else _mock_review_script(agent, rnd))
            buf = self.live_reviews[agent["id"]]
            with obs.observation(as_type="agent", name=f"review-r{rnd} · {agent['name']}", input={"role": role["label"]}):
                with obs.observation(as_type="generation", name=f"llm · {model}", model=model) as gen:
                    try:
                        async for kind, delta in stream(provider, model, system, user, temperature=0.3, max_tokens=3000, result=result, mock=mock, cred=cred):
                            if kind != "text":
                                continue
                            buf.append(delta)
                            self.emit("review.token", round=rnd, agent_id=agent["id"], delta=delta)
                            if self._stop.is_set():
                                break
                    except Exception as e:
                        obs.safe_update(gen, level="ERROR", status_message=str(e)[:300])
                        text = f"<verdict>approve</verdict><findings>[mejora] No pude revisar: {str(e)[:200]}</findings><requests></requests>"
                    else:
                        text = "".join(buf)
                    cost = cost_usd(model, result.input_tokens, result.output_tokens)
                    self.cost += cost
                    self.tokens += result.input_tokens + result.output_tokens
                    self._add_api_usage(result, model)
                    obs.safe_update(gen, output=text[:8000], usage_details={"input": result.input_tokens, "output": result.output_tokens}, cost_details={"total": cost})
            res = _parse_review(text, mode) | {"agent_id": agent["id"], "name": agent["name"], "role": agent["role"], "role_label": role["label"], "provider": provider, "model": model}
            self.emit("review.result", round=rnd, **res)
            return res

        with obs.observation(as_type="chain", name=f"pre-prod review · round {rnd}"):
            if self.engine:
                results = []
                for a in self.team:  # one CLI session at a time: subscription rate limits
                    if self._stop.is_set():
                        break
                    results.append(await self._engine_review_one(a, rnd, prior, mode))
            else:
                results = await asyncio.gather(*(one(a) for a in self.team))
        self.live_reviews = {}
        if self._stop.is_set():
            self.status = "stopped"
            return None
        approved = all(r["verdict"] == "approve" for r in results) and mode != "audit"
        round_rec = {"round": rnd, "approved": approved, "results": results, "mode": mode, "ts": time.time()}
        self.reviews.append(round_rec)
        self.chat.append({"role": "review", "round": rnd, "approved": approved, "results": results, "mode": mode, "ts": time.time()})
        self.status = "approved" if approved else ("audited" if mode == "audit" else "completed")
        self.emit("review.completed", round=rnd, approved=approved, requests=[{"agent_id": r["agent_id"], "name": r["name"], "role_label": r["role_label"], "text": r["requests"]} for r in results if r["verdict"] == "changes"])
        self._save()
        return round_rec

    async def _preview_turn(self, system: str) -> None:
        """One extra pass: a self-contained HTML prototype of the finished product, shown in-app and shipped in the zip."""
        self.turns += 1
        self.emit("turn.started", turn=self.turns, phase="preview")
        text = await self._turn(system, PREVIEW_PROMPT, phase="preview")
        if text is None:
            return
        parsed = self._apply(text, phase="preview")
        self._push_history("(vista previa)", parsed["say"])
        self._save()

    async def _drain_inbox(self) -> str:
        msgs = []
        while not self.inbox.empty():
            m = self.inbox.get_nowait()
            if m:
                msgs.append(m)
        return "\n".join(msgs)

    async def _turn(self, system: str, user: str, phase: str = "build", provider: str | None = None, model: str | None = None, cred: Cred | None = None) -> str | None:
        if phase == "build":
            self.emit("turn.started", turn=self.turns)
        provider, model, cred = provider or self.req.provider, model or self.req.model, cred or self.cred
        result = CallResult()
        script = MOCK_DESIGN.replace("{title}", self.title) if phase == "design" else _mock_preview_script(self.title) if phase == "preview" else _mock_build_script(self.turns - self.design_turns, self.title, self.brief)
        mock = MockContext("Builder", [("x", "x")], self.title, script=script)
        buf: list[str] = []
        self.live = {"turn": self.turns, "phase": phase, "buf": buf}
        seen_files = 0
        with obs.observation(as_type="generation", name=f"build-turn-{self.turns:02d} · {model}", model=model, input=user[-3000:]) as gen:
            try:
                async for kind, delta in stream(
                    provider, model, system, user, temperature=0.2, max_tokens=16000, result=result, mock=mock, cred=cred, history=[] if phase == "design" else self.history,
                ):
                    if kind != "text":
                        continue
                    buf.append(delta)
                    self.emit("token", delta=delta, turn=self.turns)
                    # files close mid-stream → update the tree live
                    text = "".join(buf)
                    matches = list(FILE_RE.finditer(text))
                    while seen_files < len(matches):
                        m = matches[seen_files]
                        seen_files += 1
                        self._write(m.group(1), m.group(2))
                    if self._stop.is_set():
                        break
            except Exception as e:
                obs.safe_update(gen, level="ERROR", status_message=str(e)[:400])
                self.emit("error", error=str(e)[:400], turn=self.turns)
                self.status = "error"
                self.live = None
                return None
            text = "".join(buf)
            self.live = None
            self.last_truncated = result.truncated
            cost = cost_usd(model, result.input_tokens, result.output_tokens, result.cached_input_tokens, result.cache_write_tokens)
            self.cost += cost
            self.tokens += result.input_tokens + result.output_tokens
            self._add_api_usage(result, model)
            obs.safe_update(gen, output=text[:20000], usage_details={"input": result.input_tokens, "output": result.output_tokens}, cost_details={"total": cost})
        return text

    def _write(self, path: str, content: str) -> None:
        safe = _safe_path(path)
        if not safe:
            return
        content = content.rstrip("\n") + "\n"
        if len(content) > MAX_FILE_BYTES:
            content = content[:MAX_FILE_BYTES]
        is_new = safe not in self.files
        self.files[safe] = content
        self.emit("file.written", path=safe, size=len(content), lines=content.count("\n"), new=is_new, turn=self.turns)
        self._publish_pages([safe])  # any (re)write of the prototype, the mockup or a file they load publishes them

    def _apply(self, text: str, phase: str = "build") -> dict:
        files = []
        for m in FILE_RE.finditer(text):
            safe = _safe_path(m.group(1))
            if safe:
                if safe not in self.files:  # stream stopped before the regex saw it
                    self._write(safe, m.group(2))
                files.append(safe)
        say = "\n\n".join(s.strip() for s in SAY_RE.findall(text)) or re.sub(r"<file.*?</file>", "", text, flags=re.S).strip()[:1500]
        stage = None
        if sm := STAGE_RE.search(text):
            stage = {"n": int(sm.group(1)), "text": sm.group(2).strip(), "turn": self.turns, "files": files}
            self.stages.append(stage)
        done = None
        if dm := DONE_RE.search(text):
            done = dm.group(1).strip()
            self.done_text = done
        entry = {"role": "assistant", "turn": self.turns, "say": say, "files": files, "stage": stage, "done": done, "phase": phase, "ts": time.time()}
        self.chat.append(entry)
        self.emit("turn.completed", **entry)
        return entry

    # ------------------------------------------------------------- persistence
    def _path(self) -> Path:
        return user_dir(self.user.id) / f"{self.req.session_id}.build.{self.id}.json"

    def _save(self) -> None:
        try:
            self._path().write_text(json.dumps({**self.snapshot(), "context": self.context, "file_contents": self.files, "events": self.events, "history": self.history, "engine_tokens": self.engine_tokens, "api_usage": self.api_usage, "api_by_model": self.api_by_model}, ensure_ascii=False))
        except Exception as e:  # pragma: no cover
            log.warning("could not save build: %s", e)

    def zip_bytes(self) -> bytes:
        buf = io.BytesIO()
        root = re.sub(r"[^a-z0-9]+", "-", self.title.lower()).strip("-")[:40] or "proyecto"
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{root}/BRIEF.md", self.brief)
            for p, c in self.files.items():
                z.writestr(f"{root}/{p}", c)
        return buf.getvalue()


BUILDS: dict[str, Build] = {}


def rehydrate(user: User, session_id: str, build_id: str, cred: Cred, team: list[dict] | None = None, creds: dict[str, Cred] | None = None) -> Build | None:
    """Bring a saved (finished) build back into memory so it can be resumed after a server restart."""
    d = load_build(user, session_id, build_id)
    if not d:
        return None
    brief_path = user_dir(user.id) / f"{session_id}.brief.claude-code.md"
    briefs = sorted(user_dir(user.id).glob(f"{session_id}.brief.*.md"))
    brief = (brief_path if brief_path.exists() else briefs[0]).read_text() if (brief_path.exists() or briefs) else ""
    saved_team = [a for a in (d.get("team") or []) if isinstance(a, dict) and role_of(a.get("role"))]  # the council the user set on this build survives restarts
    b = Build(user, BuildRequest(session_id=session_id, provider=d["provider"], model=d["model"]), cred, brief, d["title"], saved_team or team, creds, build_id=d["id"])
    b.reviews = d.get("reviews", [])
    b.review_plan = d.get("review_plan")
    b.mode, b.context, b.audit_report = d.get("mode", "build"), d.get("context", ""), d.get("audit_report")
    b.deploys = d.get("deploys", [])
    b.status = d["status"] if d["status"] not in ("running", "reviewing", "design_review") else ("audited" if d.get("audit_report") else "stopped")
    b.files = dict(d.get("file_contents", {}))
    if b.engine and b.workdir and b.workdir.exists():
        b.files = snapshot_dir(b.workdir) or b.files  # the real tree on disk wins for local agents
    b.engine_session = d.get("engine_session")
    b.council_sessions = d.get("council_sessions", [])
    b.versions = d.get("versions", [])
    b.req.council = bool(d.get("council", True))
    b.req.references = [r for r in (d.get("references") or []) if isinstance(r, str)]
    b.req.deep_analysis = bool(d.get("deep_analysis", False))
    b.req.language = d.get("language") or b.req.language
    b.req.references_auto = bool(d.get("references_auto", False))
    b.stages = d.get("stages", [])
    b.chat = d.get("chat", [])
    b.events = d.get("events", [])
    b.cost, b.tokens, b.turns, b.done_text = d.get("cost_usd", 0.0), d.get("tokens", 0), d.get("turns", 0), d.get("done", "")
    b.engine_tokens = int(d.get("engine_tokens") or 0)
    # builds saved before the split: the engine's reported cost is the total minus nothing known (API calls were a few cents)
    b.engine_cost = float(d["engine_cost_usd"]) if d.get("engine_cost_usd") is not None else (b.cost if b.engine else 0.0)
    b.api_by_model = dict(d.get("api_by_model") or {})
    if d.get("api_usage"):
        b.api_usage = {**b.api_usage, **d["api_usage"]}
    else:  # builds saved before usage was split: their API tokens are known only as a total
        b.api_usage["unsplit"] = int(d.get("tokens") or 0)
    b.preview_html = inline_html(b.files.get(PREVIEW_PATH) or "", PREVIEW_PATH, b.files) or None
    b.design_html = inline_html(b.files.get(DESIGN_MOCKUP) or "", DESIGN_MOCKUP, b.files) or None
    b.design_turns = 1 if b.design_html else 0
    b.research_md = b.files.get(RESEARCH_PATH, "")
    b.research_refs = d.get("research", [])
    b.fees = d.get("fees", [])
    b.build_seconds = float(d.get("build_seconds") or 0)
    b.req.platform = d.get("platform") or getattr(b.req, "platform", "web")
    saved_hist = [m for m in d.get("history", []) if isinstance(m, dict) and (m.get("content") or "").strip()]
    # keep alternation user/assistant intact; otherwise fall back to a summary of the files written so far
    ok = len(saved_hist) % 2 == 0 and all(m["role"] == ("user" if i % 2 == 0 else "assistant") for i, m in enumerate(saved_hist))
    b.history = saved_hist[-24:] if ok and saved_hist else [{"role": "user", "content": "(construcción previa)"}, {"role": "assistant", "content": "\n".join(f'<file path="{p}"/> (escrito)' for p in b.files)[:6000]}]
    if len(b.history) % 2:
        b.history = b.history[1:]
    BUILDS[b.id] = b
    return b


def start_build(user: User, req: BuildRequest, cred: Cred, brief: str, title: str, team: list[dict] | None = None, creds: dict[str, Cred] | None = None) -> Build:
    b = Build(user, req, cred, brief, title, team, creds)
    BUILDS[b.id] = b
    b.task = spawn(b.pipeline())
    return b


def load_build(user: User, session_id: str, build_id: str) -> dict | None:
    path = user_dir(user.id) / f"{session_id}.build.{build_id}.json"
    if not path.exists() or path.resolve().parent != user_dir(user.id).resolve():
        return None
    return json.loads(path.read_text())


def _pending_from_saved(d: dict) -> str | None:
    v = (d.get("versions") or [{}])[-1]
    if d.get("status") in ("running", "reviewing") or not v.get("council_session") or not v.get("verdict") or v["verdict"].get("approved"):
        return None
    return v["council_session"]


def list_builds(user: User, session_id: str) -> list[dict]:
    out = []
    for p in sorted(user_dir(user.id).glob(f"{session_id}.build.*.json"), reverse=True):
        try:
            d = json.loads(p.read_text())
            out.append({k: d[k] for k in ("id", "provider", "model", "status", "turns", "cost_usd")} | {"fees_usd": d.get("fees_usd", 0), "build_seconds": d.get("build_seconds", 0), "level": (d.get("levels") or {}).get("level"), "level_pct": (d.get("levels") or {}).get("pct"), "level_next": (d.get("levels") or {}).get("next"), "files": len(d.get("files", {})), "engine_session": d.get("engine_session"), "workdir": d.get("workdir"), "stages": len(d.get("stages", [])), "version": len(d.get("versions", [])), "readiness": (d.get("versions") or [{}])[-1].get("readiness"), "pending_council": _pending_from_saved(d)})
        except Exception:
            continue
    return out


# --------------------------------------------------------------------------------------------- mock

def _mock_build_script(turn: int, title: str, brief: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:30] or "app"
    if turn == 1:
        return f"""<say>**Etapa 1 · base del proyecto.** Creo la estructura, el README con el setup, `.env.example` y la configuración inicial (modo simulado: proyecto de ejemplo).</say>
<file path="README.md">
# {title}

Proyecto generado por Muse Team (modo simulado).

## Setup
```bash
npm install
cp .env.example .env
npm run dev
```
</file>
<file path=".env.example">
# Variables requeridas por el brief
DATABASE_URL=postgres://user:pass@localhost:5432/{name}
NEXT_PUBLIC_APP_NAME={title}
</file>
<file path="package.json">
{{
  "name": "{name}",
  "private": true,
  "scripts": {{ "dev": "next dev", "build": "next build", "start": "next start", "test": "vitest" }},
  "dependencies": {{ "next": "15.0.0", "react": "19.0.0", "react-dom": "19.0.0" }},
  "devDependencies": {{ "typescript": "5.6.0", "vitest": "2.1.0" }}
}}
</file>
<stage n="1">Base lista: README, .env.example y package.json. Verificar con `npm install && npm run dev`.</stage>"""
    if turn == 2:
        return """<say>**Etapa 2 · modelo de datos y pantalla principal.** Agrego el esquema SQL del brief y la página inicial.</say>
<file path="db/schema.sql">
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);
create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount_cents bigint not null,
  occurred_on date not null,
  category text not null,
  created_at timestamptz not null default now()
);
create index on transactions (user_id, occurred_on);
</file>
<file path="app/page.tsx">
export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: 'system-ui' }}>
      <h1>Hola 👋</h1>
      <p>Proyecto generado en modo simulado. Con un modelo real, acá va la app completa del brief.</p>
    </main>
  )
}
</file>
<stage n="2">Esquema y pantalla inicial. Verificar: `psql -f db/schema.sql` y abrir http://localhost:3000.</stage>"""
    return """<say>**Cierre.** El ejemplo simulado está completo.</say>
<file path="NOTES.md">
# Notas
- Generado en modo simulado: sirve para probar el flujo de construcción sin gastar tokens.
- Con un modelo real (Claude, GPT, Gemini, Kimi…) el constructor implementa todas las etapas del brief.
</file>
<done>1) `npm install` 2) `cp .env.example .env` y completar 3) `npm run dev` → http://localhost:3000</done>"""


def _mock_preview_script(title: str) -> str:
    return f"""<say>**Vista previa.** Un prototipo navegable del producto terminado, en un solo archivo.</say>
<file path="preview/index.html">
<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · preview</title>
<style>
  body{{margin:0;font-family:system-ui,sans-serif;background:#f4f6f5;color:#1e2622}}
  header{{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#fff;border-bottom:1px solid #dce2de}}
  header b{{font-size:18px}} nav button{{border:1px solid #dce2de;background:#fff;border-radius:8px;padding:6px 10px;margin-left:6px;cursor:pointer}}
  nav button.on{{background:#2f6b5d;color:#fff;border-color:#2f6b5d}}
  main{{max-width:720px;margin:24px auto;padding:0 16px}} .card{{background:#fff;border:1px solid #dce2de;border-radius:14px;padding:16px;margin-bottom:12px}}
  .row{{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef1ef}} .row:last-child{{border:0}}
  .big{{font-size:34px;font-weight:700}} .muted{{color:#717c76;font-size:13px}} input,select{{padding:8px;border:1px solid #dce2de;border-radius:8px;margin:4px 0;width:100%}}
  .btn{{background:#2f6b5d;color:#fff;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;margin-top:8px}}
</style></head><body>
<header><b>{title}</b><nav><button class="on" onclick="go('home',this)">Inicio</button><button onclick="go('add',this)">Cargar</button><button onclick="go('report',this)">Reporte</button></nav></header>
<main>
  <section id="home" class="card"><div class="muted">Este mes</div><div class="big">$ 184.300</div><div class="muted">gastos hormiga: 18 % del total</div>
    <div class="row"><span>☕ Café</span><b>$ 2.400</b></div><div class="row"><span>🚌 Transporte</span><b>$ 1.200</b></div><div class="row"><span>🛒 Supermercado</span><b>$ 32.900</b></div></section>
  <section id="add" class="card" style="display:none"><label>Monto<input type="number" placeholder="0"></label><label>Categoría<select><option>Café</option><option>Transporte</option><option>Supermercado</option></select></label>
    <label><input type="checkbox" style="width:auto"> gasto hormiga</label><button class="btn" onclick="alert('Guardado (demo)')">Guardar</button></section>
  <section id="report" class="card" style="display:none"><div class="muted">Top categorías</div><div class="row"><span>Supermercado</span><b>48 %</b></div><div class="row"><span>Alquiler</span><b>31 %</b></div><div class="row"><span>Café</span><b>6 %</b></div></section>
</main>
<script>function go(id,btn){{for(const s of document.querySelectorAll('main section'))s.style.display=s.id===id?'':'none';for(const b of document.querySelectorAll('nav button'))b.classList.toggle('on',b===btn)}}</script>
</body></html>
</file>"""


def _mock_review_script(agent: dict, rnd: int) -> str:
    role = agent.get("role") or ""
    if rnd == 1 and role in ("qa", "security", "product-manager", "cto"):
        asks = {
            "qa": "1. Agregar `tests/transactions.test.ts` con casos de alta, edición y duplicado de recurrencia; verificar con `npm test` en verde.",
            "security": "1. En `db/schema.sql` habilitar RLS por `user_id` en `transactions`; verificar que un usuario no lea filas de otro.",
            "product-manager": "1. En `app/page.tsx` mostrar el porcentaje de gastos hormiga del mes (US-03); verificar que aparezca con datos de ejemplo.",
            "cto": "1. Agregar `.github/workflows/ci.yml` con lint + test en cada PR; verificar que el workflow exista y corra `npm test`.",
        }[role]
        return f"""<reflexion>Revisé el árbol y los archivos clave desde mi área; falta algo que considero bloqueante.</reflexion>
<verdict>changes</verdict>
<findings>- [bloqueante] Falta cobertura de mi área en la entrega actual (ver pedido).
- [mejora] El README podría incluir una sección de verificación.</findings>
<requests>{asks}</requests>"""
    return """<reflexion>Verifiqué los archivos de mi área y los pedidos anteriores quedaron resueltos.</reflexion>
<verdict>approve</verdict>
<findings>- [mejora] Nada bloqueante desde mi rol; documentación y estructura correctas.</findings>
<requests></requests>"""


def _parse_review(text: str, mode: str) -> dict:
    verdict = "changes" if VERDICT_RE.search(text) and "change" in VERDICT_RE.search(text).group(1).lower() else "approve"
    requests = REQUESTS_RE.search(text).group(1).strip() if REQUESTS_RE.search(text) else ""
    if mode == "audit":
        verdict = "changes" if requests.strip() else "approve"
    elif verdict == "changes" and not requests:
        verdict = "approve"
    score = None
    if m := SCORE_RE.search(text):
        try:
            score = max(0.0, min(10.0, float(m.group(1).replace(",", "."))))
        except ValueError:
            score = None
    return {
        "verdict": verdict, "requests": requests, "score": score,
        "reflexion": (REFLEX_RE.search(text).group(1).strip() if REFLEX_RE.search(text) else ""),
        "strengths": (STRENGTHS_RE.search(text).group(1).strip() if STRENGTHS_RE.search(text) else ""),
        "findings": (FINDINGS_RE.search(text).group(1).strip() if FINDINGS_RE.search(text) else text[:2000]),
    }


def _mock_audit_script(agent: dict) -> str:
    role = agent.get("role") or ""
    props = {
        "qa": "1. Agregar tests para la lógica central (`tests/`), correr en CI. Impacto alto, esfuerzo medio.",
        "security": "1. Mover secretos a variables de entorno y agregar `.env.example`. Impacto alto, esfuerzo bajo.",
        "cto": "1. Separar la lógica de negocio de la UI en módulos. Impacto medio, esfuerzo medio.",
        "product-manager": "1. Definir el flujo principal en el README con criterios de aceptación. Impacto medio, esfuerzo bajo.",
    }.get(role, "")
    return f"""<reflexion>Recorrí el árbol y los archivos principales desde mi área.</reflexion>
<score>{7 if props else 8}</score>
<strengths>- Estructura clara y README presente.
- Nombres consistentes.</strengths>
<findings>- [importante] Falta cobertura de mi área en algunos puntos (ver propuestas).
- [mejora] Documentar decisiones en NOTES.md.</findings>
<requests>{props}</requests>"""


def _mock_audit_report(title: str, rnd: dict) -> str:
    rows = "\n".join(f"| {r['role_label']} | {r.get('score', '—')} | {(r.get('strengths') or '-').splitlines()[0].lstrip('- ')} | {(r.get('findings') or '-').splitlines()[0].lstrip('- ')} |" for r in rnd["results"])
    props = "\n".join(f"| {i + 1} | {r['requests'].splitlines()[0][:80] if r['requests'] else '—'} | {r['role_label']} | alto | medio | P{i + 1} |" for i, r in enumerate(x for x in rnd["results"] if x["requests"]))
    return f"""# Informe de auditoría · {title}
> Proyecto sólido con mejoras claras por delante (informe simulado).

## 1. Resumen ejecutivo
El equipo evaluó el proyecto desde {len(rnd['results'])} áreas. Puntaje global: 7.5/10 (simulado).

## 2. Puntajes por área
| Área/Rol | Puntaje | Lo mejor | Lo más urgente |
|---|---|---|---|
{rows}

## 3. Lo que está bien
- Estructura clara y documentación básica.

## 4. Lo que hay que mejorar
- [importante] Cobertura de pruebas y manejo de secretos.

## 5. Propuestas priorizadas
| # | Propuesta | Rol | Impacto | Esfuerzo | Prioridad |
|---|---|---|---|---|---|
{props}

## 6. Plan sugerido
1. Secretos a `.env` · 2. Tests de la lógica central · 3. Separar módulos.

## 7. Riesgos si no se actúa
- Fugas de credenciales y regresiones sin detectar.
"""
