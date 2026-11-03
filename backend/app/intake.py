"""
Intake: from "what I want to build" + whatever the user attaches (documents, folders, a whole project) to a
prompt-engineered Markdown brief the council debates.

Flow (one Intake per setup screen):
  1. attachments: uploaded files/folders (multipart, relative paths kept), a .zip, or a local folder path (the backend
     runs on the user's machine). Text-like files are extracted and budgeted; binaries are listed by name only.
  2. run(text, provider, model): an "analyst" model reads the material + the user's text, says what it understood,
     and either asks up to 5 clarifying questions (the UI shows them, the user answers, up to 3 rounds) or writes the
     final prompt: a Markdown brief with goal, scope, users, requirements, constraints, acceptance criteria.
  Everything is streamed as events (reading files, thinking deltas, questions, final text) over /ws/intake/{id}.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import re
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .auth import User, user_dir
from .pricing import cost_usd
from .local_engine import ask_engine, is_engine
from .providers import PROVIDERS, CallResult, Cred, MockContext, stream

TEXT_EXT = {".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss",
            ".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".cs", ".php",
            ".sql", ".sh", ".env.example", ".ini", ".cfg", ".conf", ".graphql", ".proto", ".vue", ".svelte", ".prisma", ".tex"}
SKIP_DIRS = {"node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".turbo", ".cache", "coverage",
             "vendor", ".idea", ".vscode", "DerivedData", "Pods", ".gradle", "target"}
BINARY_RE = re.compile(r"\.(png|jpe?g|gif|webp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|gz|tar|woff2?|ttf|otf|mp[34]|mov|wav|bin|lock|map|dylib|so|exe|dmg)$", re.I)
MAX_FILE = 200_000  # chars kept per file
MAX_TOTAL = 160_000  # chars of extracted text per intake
MAX_FILES = 400
DIGEST_BUDGET = 70_000  # chars of material sent to the analyst (big files are trimmed, not dropped)
MAX_ROUNDS = 3

INTAKES: dict[str, "Intake"] = {}


@dataclass
class Attachment:
    id: str
    name: str  # relative path as attached (folder/file.ext)
    size: int
    kind: str  # text | binary | skipped
    chars: int = 0
    origin: str = "upload"  # upload | zip | path
    text: str = ""  # extracted (text kind only)


@dataclass
class Question:
    id: str
    question: str
    why: str = ""
    options: list[str] = field(default_factory=list)
    answer: str | None = None


ANALYST_SYSTEM = """Sos un product analyst y prompt engineer senior. Tu trabajo: a partir de lo que un usuario escribió y del material que adjuntó, entender QUÉ necesita construir y con qué ALCANCE, y dejar un brief impecable para que un equipo de roles (CEO, CTO, diseño, ingeniería, QA…) lo debata y lo construya.

Trabajás en dos pasos. En el Paso A respondés con un único JSON (sin texto fuera del JSON, sin ```); en el Paso B respondés con el Markdown directamente (sin JSON, sin ```):

Paso A — si todavía hay dudas que cambiarían el alcance o el resultado:
{"status":"questions","understanding":"<2-4 frases: qué entendiste que quiere y para quién>","scope":"<1-3 frases: alcance que infieren el texto y el material>","questions":[{"id":"q1","question":"<pregunta concreta>","why":"<por qué importa, 1 frase>","options":["<opción>","<opción>"]}]}
- Máximo 5 preguntas, solo las que de verdad cambian el producto (plataforma, usuarios, datos reales vs demo, integraciones, monetización, límites). Nada obvio ni que ya esté respondido en el texto o el material. Options es opcional (2-4 opciones cortas) y el usuario puede escribir libre.

Paso B — cuando ya está claro (o el usuario respondió lo necesario, o dijo que decidas vos): escribí el prompt final como Markdown puro, empezando directamente con el título "# ". Nada antes ni después del Markdown.
El Markdown del prompt tiene estas secciones, en este orden, concretas y sin relleno:
# <nombre del producto>
## Objetivo
## Para quién
## Contexto y material adjunto  (qué hay en lo adjunto y cómo usarlo; citá archivos por nombre)
## Alcance de la primera entrega  (lista numerada: todo lo pedido, de punta a punta)
## Fuera de alcance  (solo lo que el usuario no pidió)
## Requisitos funcionales  (lista numerada, verificables)
## Datos e integraciones  (fuentes reales, APIs, qué es demo)
## Restricciones técnicas y de producto
## Criterios de aceptación  (lista numerada)
## Decisiones ya tomadas por el usuario  (respuestas a las preguntas)
## Instrucción para el equipo  (qué tiene que quedar resuelto al final del debate)
{language_rule} No inventes datos del negocio: si falta, decilo como supuesto explícito."""

LANGUAGE_RULES = {
    "es": "Idioma: español rioplatense (títulos de sección como están arriba), aunque el usuario escriba en otro idioma.",
    "en": "LANGUAGE: ENGLISH. Everything you write — the questions, understanding, scope and the whole Markdown prompt — must be in English, even if the user wrote in Spanish. Use these exact English section titles instead of the Spanish ones above: # <product name>, ## Goal, ## Who it is for, ## Context and attached material, ## First delivery scope, ## Out of scope, ## Functional requirements, ## Data and integrations, ## Technical and product constraints, ## Acceptance criteria, ## Decisions already made by the user, ## Instructions for the team.",
}


def lang_code(language: str | None) -> str:
    """'English' / 'en' / 'inglés' → en; anything else → es."""
    l = (language or "").strip().lower()
    return "en" if l.startswith(("en", "ingl")) else "es"


STEPS = {
    "reading": ("Leyendo el material adjunto", "Reading the attached material"),
    "studying": ("Estudiando lo que necesitás y el alcance", "Studying what you need and the scope"),
    "integrating": ("Integrando tus respuestas", "Working your answers in"),
    "questions": ("Tengo algunas preguntas antes de escribir el prompt", "I have a few questions before writing the prompt"),
    "done": ("Prompt listo", "Prompt ready"),
    "failed": ("Falló el análisis", "The analysis failed"),
}


ROLE_PROMPTS_SYSTEM = """Sos un prompt engineer senior. Te dan el brief de un producto y el equipo de roles que lo va a debatir y construir.
Para CADA rol escribí su prompt de personalidad A MEDIDA DE ESTE PROYECTO: 3 a 6 frases en segunda persona ("Sos…"), concretas, que digan
qué tiene que priorizar en este producto, qué riesgos vigilar, qué decisiones le tocan y en qué debe ser exigente con los demás. Nada genérico:
citá partes del brief (datos, integraciones, usuarios, restricciones). Respetá el rol (el CTO no decide copy, el diseñador no decide stack).
Respondé SOLO un JSON: {"<agent_id>": "<prompt>", …} con todos los ids que te pasaron. {language_rule}"""

ROLE_LANGUAGE_RULES = {"es": "Idioma de los prompts: español rioplatense.", "en": "LANGUAGE: ENGLISH. Write every prompt in English (start with \"You are…\"), even if the brief or the current prompts are in Spanish."}


def _mock_role_prompts(agents: list[dict], brief: str, lang: str = "es") -> dict:
    head = brief.strip().splitlines()[0].lstrip("# ").strip()[:60] if brief.strip() else "el producto"
    if lang == "en":
        return {a["id"]: f"You are the {a.get('label') or a.get('name')} of «{head}». Prioritise {a.get('mandate') or 'what is yours'} and hold the rest of the team to it." for a in agents}
    return {a["id"]: f"Sos {a.get('label') or a.get('name')} de «{head}». Priorizá {a.get('mandate') or 'lo que te toca'} y sé exigente con el resto del equipo en eso." for a in agents}


def _mock_round(text: str, round_no: int, answers: dict[str, str], att: list[Attachment]) -> dict:
    """Deterministic analyst for the mock provider (tests, no keys)."""
    if round_no == 0:
        return {"status": "questions", "understanding": f"Querés construir: {text[:160]}", "scope": f"Material adjunto: {len(att)} archivo(s).",
                "questions": [{"id": "q1", "question": "¿Para qué plataforma arranca el MVP?", "why": "Cambia stack y diseño.", "options": ["Web", "iOS + Android", "Las dos"]},
                              {"id": "q2", "question": "¿Datos reales desde el día uno o una demo con datos de ejemplo?", "why": "Define integraciones.", "options": ["Reales", "Demo"]}]}
    names = ", ".join(a.name for a in att[:5]) or "sin adjuntos"
    decided = "\n".join(f"- {k}: {v}" for k, v in answers.items()) or "- (sin preguntas)"
    return {"status": "ready", "markdown": f"# Producto\n\n## Objetivo\n{text.strip()[:400]}\n\n## Para quién\nUsuarios iniciales del producto.\n\n## Contexto y material adjunto\n{names}\n\n## Alcance de la primera entrega\n1. Flujo principal end-to-end.\n2. Pantallas clave.\n\n## Fuera de alcance\n- Todo lo que no esté arriba.\n\n## Requisitos funcionales\n1. El usuario completa el flujo principal.\n\n## Datos e integraciones\n- Según decisiones.\n\n## Restricciones técnicas y de producto\n- Simples y operables.\n\n## Criterios de aceptación\n1. Flujo principal probado.\n\n## Decisiones ya tomadas por el usuario\n{decided}\n\n## Instrucción para el equipo\nDejar un plan por etapas y criterios de aceptación."}


class Intake:
    def __init__(self, user: User):
        self.id = "in-" + uuid.uuid4().hex[:10]
        self.user = user
        self.created = time.time()
        self.attachments: list[Attachment] = []
        self.text = ""
        self.provider = "mock"
        self.model = "mock-1"
        self.status = "idle"  # idle | running | waiting | done | error
        self.step = ""  # what the system is doing right now, in plain words
        self.events: list[dict] = []
        self.questions: list[Question] = []
        self.history: list[dict] = []  # analyst conversation (user/assistant)
        self.understanding = ""
        self.prompt_md = ""
        self.error: str | None = None
        self.cost_usd = 0.0
        self.rounds = 0
        self.previous_md = ""  # prompt being revised (when the user asks to add something)
        self.extra = ""
        self.language = "es"  # es | en: the UI language when the analysis started; everything generated follows it
        self._subs: set[asyncio.Queue] = set()
        self._answered = asyncio.Event()
        self._task: asyncio.Task | None = None
        self.dir = user_dir(user.id) / "intake" / self.id
        self.dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ events
    def emit(self, type_: str, **data) -> None:
        ev = {"type": type_, "ts": time.time(), **data}
        if type_ != "delta":
            self.events.append(ev)
            self.events = self.events[-400:]
        for q in list(self._subs):
            q.put_nowait(ev)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def snapshot(self) -> dict:
        return {
            "id": self.id, "status": self.status, "step": self.step, "text": self.text, "provider": self.provider, "model": self.model,
            "attachments": [{"id": a.id, "name": a.name, "size": a.size, "kind": a.kind, "chars": a.chars, "origin": a.origin} for a in self.attachments],
            "questions": [q.__dict__ for q in self.questions], "understanding": self.understanding, "prompt": self.prompt_md,
            "error": self.error, "cost_usd": round(self.cost_usd, 4), "rounds": self.rounds, "events": self.events[-60:],
            "context_chars": sum(a.chars for a in self.attachments),
            "context": self.digest() if (self.attachments and self.status == "done") else None,
        }

    # ------------------------------------------------------------------ attachments
    def _add(self, name: str, data: bytes, origin: str) -> Attachment:
        name = name.replace("\\", "/").lstrip("/")
        aid = uuid.uuid4().hex[:8]
        kind, text = "binary", ""
        low = name.lower()
        if not BINARY_RE.search(low) and (any(low.endswith(e) for e in TEXT_EXT) or "." not in low.rsplit("/", 1)[-1] or len(data) < 400_000):
            try:
                text = data.decode("utf-8")
                kind = "text"
            except UnicodeDecodeError:
                kind = "binary"
        if kind == "text":
            total = sum(a.chars for a in self.attachments)
            if total >= MAX_TOTAL:
                kind, text = "skipped", ""
            else:
                text = text[: min(MAX_FILE, MAX_TOTAL - total)]
        att = Attachment(id=aid, name=name, size=len(data), kind=kind, chars=len(text), origin=origin, text=text)
        self.attachments.append(att)
        return att

    def add_upload(self, name: str, data: bytes) -> list[Attachment]:
        if len(self.attachments) >= MAX_FILES:
            raise ValueError(f"Máximo {MAX_FILES} archivos")
        if name.lower().endswith(".zip"):
            return self.add_zip(data, name)
        return [self._add(name, data, "upload")]

    def add_zip(self, data: bytes, zname: str) -> list[Attachment]:
        out = []
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if not n.endswith("/")]
            roots = {n.split("/")[0] for n in names}
            strip = (next(iter(roots)) + "/") if len(roots) == 1 and all("/" in n for n in names) else ""
            for n in names:
                rel = n[len(strip):] if n.startswith(strip) else n
                parts = rel.split("/")
                if not rel or rel.startswith("__MACOSX") or ".." in parts or any(p in SKIP_DIRS or p == ".DS_Store" for p in parts):
                    continue
                if len(self.attachments) >= MAX_FILES:
                    break
                info = z.getinfo(n)
                if info.file_size > 2_000_000:
                    continue
                out.append(self._add(f"{Path(zname).stem}/{rel}", z.read(n), "zip"))
        return out

    def add_path(self, path: str) -> list[Attachment]:
        """A folder (or file) on this machine. Only inside the user's home, never system dirs."""
        p = Path(os.path.expanduser(path)).resolve()
        home = Path.home().resolve()
        if home not in p.parents and p != home:
            raise ValueError("Solo se pueden adjuntar carpetas dentro de tu carpeta de usuario")
        if not p.exists():
            raise ValueError("Esa ruta no existe")
        files = [p] if p.is_file() else sorted(x for x in p.rglob("*") if x.is_file())
        out = []
        for f in files:
            rel = f.relative_to(p.parent)
            if any(part in SKIP_DIRS or part.startswith(".DS_Store") for part in rel.parts):
                continue
            if len(self.attachments) >= MAX_FILES:
                break
            try:
                if f.stat().st_size > 2_000_000:
                    continue
                out.append(self._add(str(rel), f.read_bytes(), "path"))
            except OSError:
                continue
        if not out:
            raise ValueError("No encontré archivos legibles en esa ruta")
        return out

    def remove(self, att_id: str) -> bool:
        before = len(self.attachments)
        self.attachments = [a for a in self.attachments if a.id != att_id]
        return len(self.attachments) < before

    def digest(self) -> str:
        """The attached material as the analyst sees it (budgeted, big files trimmed)."""
        texts = [a for a in self.attachments if a.kind == "text"]
        others = [a for a in self.attachments if a.kind != "text"]
        if not self.attachments:
            return "(sin material adjunto)"
        per = max(1500, DIGEST_BUDGET // max(1, len(texts)))
        parts = [f"ARCHIVOS ADJUNTOS: {len(self.attachments)} ({len(texts)} de texto, {len(others)} binarios/omitidos)", ""]
        parts += ["Lista: " + ", ".join(a.name for a in self.attachments[:120]) + (" …" if len(self.attachments) > 120 else ""), ""]
        for a in texts:
            body = a.text if len(a.text) <= per else a.text[:per] + f"\n…(recortado, {len(a.text)} caracteres en total)"
            parts.append(f"--- {a.name} ({a.chars} caracteres) ---\n{body}\n")
        return "\n".join(parts)[: DIGEST_BUDGET + 8000]

    # ------------------------------------------------------------------ run
    def start(self, text: str, provider: str, model: str, cred: Cred | None, extra: str = "", language: str | None = None) -> None:
        """`extra`: something the user wants added/changed after a prompt was generated → the analyst rewrites it."""
        if self.status in ("running", "waiting"):
            raise ValueError("Ya está analizando")
        if provider not in PROVIDERS and not is_engine(provider):
            raise ValueError("Proveedor desconocido")
        self.text, self.provider, self.model = text.strip(), provider, model
        self.language = lang_code(language) if language else self.language
        self.previous_md = self.prompt_md if extra.strip() else ""
        self.extra = extra.strip()
        self.status, self.error, self.prompt_md = "running", None, ""
        self.questions, self.history, self.rounds = [], [], 0
        self._task = asyncio.get_running_loop().create_task(self._run(cred))

    def answer(self, answers: dict[str, str]) -> None:
        if self.status == "running" and self._answered.is_set():
            return  # already answered (double click): nothing to do
        if self.status != "waiting":
            raise ValueError("No hay preguntas pendientes")
        for q in self.questions:
            if q.id in answers:
                q.answer = answers[q.id].strip()
        self._answered.set()

    def cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self.status = "idle"
        self.step = ""
        self.emit("status", status="idle", step="")

    def _set(self, status: str | None = None, step: str | None = None) -> None:
        if status:
            self.status = status
        if step is not None:
            self.step = step
        self.emit("status", status=self.status, step=self.step)

    async def _ask_model(self, user_msg: str, cred: Cred | None) -> str:
        result = CallResult()
        chunks: list[str] = []
        mock = None
        if is_engine(self.provider):  # the subscription of a local CLI agent: no conversation API, so the rounds go inside the prompt
            past = "\n\n".join(f"[{'USUARIO' if m['role'] == 'user' else 'VOS'}]\n{m['content']}" for m in self.history)
            def on_text(delta: str) -> None:
                chunks.append(delta)
                self.emit("delta", kind="text", delta=delta)
            res = await ask_engine(self.user.id, self.provider, ANALYST_SYSTEM.replace("{language_rule}", LANGUAGE_RULES[self.language]), f"{past}\n\n[USUARIO]\n{user_msg}" if past else user_msg, self.model, on_text)
            text = "".join(chunks) or res.get("text") or ""
            self.history += [{"role": "user", "content": user_msg}, {"role": "assistant", "content": text}]
            return text
        if PROVIDERS[self.provider].kind == "mock":
            answers = {q.question: q.answer or "" for q in self.questions}
            data = _mock_round(self.text, 99 if self.extra else self.rounds, answers, self.attachments)
            if data.get("status") == "ready":
                script = data["markdown"] + (f"\n\n## Agregado por el usuario\n{self.extra}" if self.extra else "")
            else:
                script = json.dumps(data, ensure_ascii=False)
            mock = MockContext("Analista", [("user", "Usuario")], self.text, script=script)
        async for kind, delta in stream(self.provider, self.model, ANALYST_SYSTEM.replace("{language_rule}", LANGUAGE_RULES[self.language]), user_msg, temperature=0.2, max_tokens=8000, result=result, mock=mock, cred=cred, history=self.history):
            chunks.append(delta)
            self.emit("delta", kind=kind, delta=delta)
        self.cost_usd += cost_usd(self.model, result.input_tokens, result.output_tokens, result.cached_input_tokens, result.cache_write_tokens)
        self.history += [{"role": "user", "content": user_msg}, {"role": "assistant", "content": "".join(chunks)}]
        return "".join(chunks)

    async def role_prompts(self, agents: list[dict], provider: str, model: str, cred: Cred | None, language: str | None = None) -> dict[str, str]:
        """One call: the brief (or the user's text) + the team → a tailored personality prompt per agent id."""
        brief = self.prompt_md or self.text
        if not brief.strip():
            raise ValueError("Primero escribí o generá el prompt del proyecto")
        lang = lang_code(language) if language else self.language
        if not is_engine(provider) and PROVIDERS[provider].kind == "mock":
            return _mock_role_prompts(agents, brief, lang)
        team = "\n".join(f"- id: {a['id']} · {a.get('label') or a.get('name')} ({a.get('name')}) · debe resolver: {a.get('mandate') or '—'} · prompt actual: {str(a.get('persona') or '')[:300]}" for a in agents)
        user = f"BRIEF DEL PRODUCTO:\n{brief[:20000]}\n\nEQUIPO:\n{team}\n\nRespondé solo el JSON."
        result = CallResult()
        chunks: list[str] = []
        if is_engine(provider):
            chunks.append((await ask_engine(self.user.id, provider, ROLE_PROMPTS_SYSTEM.replace("{language_rule}", ROLE_LANGUAGE_RULES[lang]), user, model)).get("text") or "")
        else:
            async for _kind, delta in stream(provider, model, ROLE_PROMPTS_SYSTEM.replace("{language_rule}", ROLE_LANGUAGE_RULES[lang]), user, temperature=0.3, max_tokens=4000, result=result, cred=cred):
                chunks.append(delta)
        self.cost_usd += cost_usd(model, result.input_tokens, result.output_tokens, result.cached_input_tokens, result.cache_write_tokens)
        raw = "".join(chunks)
        m = re.search(r"\{.*\}", re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip()), re.S)
        if not m:
            raise ValueError("El modelo no devolvió los prompts en el formato esperado")
        data = json.loads(m.group(0))
        return {a["id"]: str(data[a["id"]]).strip() for a in agents if isinstance(data.get(a["id"]), str) and data[a["id"]].strip()}

    def _step(self, key: str) -> str:
        return STEPS[key][1 if self.language == "en" else 0]

    @staticmethod
    def _parse(raw: str) -> dict:
        """Paso A → {"status":"questions",...}; Paso B → {"status":"ready","prompt": markdown}. Tolerant to fences and chatter."""
        txt = re.sub(r"^```(?:json|markdown|md)?\s*|\s*```$", "", raw.strip())
        if txt.startswith("{") or re.search(r'"status"\s*:\s*"questions"', txt):
            m = re.search(r"\{.*\}", txt, re.S)
            if m:
                try:
                    return json.loads(m.group(0))  # questions (or the old {"status":"ready","prompt":…} shape)
                except json.JSONDecodeError:
                    pass
            pm = re.search(r'"prompt"\s*:\s*"(.*)', txt, re.S)  # truncated / unterminated JSON with the prompt inside
            if pm:
                try:
                    return {"status": "ready", "prompt": json.loads('"' + pm.group(1).rstrip().rstrip("}").rstrip().rstrip('"') + '"')}
                except json.JSONDecodeError:
                    pass
            raise ValueError("El modelo no devolvió JSON válido")
        h = txt.find("# ")
        if h >= 0 and h < 400:
            return {"status": "ready", "prompt": txt[h:].strip()}
        raise ValueError("El modelo no respondió en el formato esperado")

    async def _run(self, cred: Cred | None) -> None:
        try:
            self._set("running", self._step("reading"))
            for a in self.attachments:
                self.emit("reading", name=a.name, kind=a.kind, chars=a.chars, size=a.size)
                await asyncio.sleep(0.03)
            self.emit("read_done", files=len(self.attachments), chars=sum(a.chars for a in self.attachments))
            if self.previous_md and self.extra:
                first = (f"TEXTO ORIGINAL DEL USUARIO:\n{self.text}\n\nMATERIAL ADJUNTO:\n{self.digest()}\n\n"
                         f"PROMPT YA GENERADO (versión anterior):\n{self.previous_md}\n\n"
                         f"EL USUARIO QUIERE AGREGAR O CAMBIAR ESTO:\n{self.extra}\n\n"
                         "Reescribí el prompt COMPLETO integrando el agregado en las secciones que correspondan (Paso B). "
                         "Solo Paso A si el agregado abre una duda que cambia el producto. Respondé solo el JSON.")
            else:
                first = (f"TEXTO DEL USUARIO (lo que quiere construir):\n{self.text}\n\nMATERIAL ADJUNTO:\n{self.digest()}\n\n"
                         "Paso A o Paso B según corresponda. Respondé solo el JSON.")
            msg = first
            bad = 0  # format retries (separate from question rounds)
            while True:
                self._set("running", self._step("studying") if self.rounds == 0 else self._step("integrating"))
                raw = await self._ask_model(msg, cred)
                try:
                    data = self._parse(raw)
                except (ValueError, json.JSONDecodeError) as e:
                    bad += 1
                    if bad > 2:
                        raise ValueError(f"{e}. Probá de nuevo o con otro modelo.")
                    self.emit("retry", reason=str(e))
                    msg = ("Tu respuesta no tuvo el formato pedido. Si faltan preguntas, respondé SOLO el JSON del Paso A. "
                           "Si ya está claro, respondé SOLO el Markdown del Paso B empezando con '# '.")
                    continue
                self.understanding = str(data.get("understanding") or self.understanding)
                if data.get("status") == "questions" and data.get("questions") and self.rounds < MAX_ROUNDS:
                    self.questions = [Question(id=str(q.get("id") or f"q{i + 1}"), question=str(q.get("question", "")).strip(), why=str(q.get("why", "")).strip(),
                                               options=[str(o) for o in (q.get("options") or [])][:4]) for i, q in enumerate(data["questions"][:5]) if q.get("question")]
                    self.rounds += 1
                    self._answered.clear()
                    self._set("waiting", self._step("questions"))
                    self.emit("questions", understanding=self.understanding, scope=str(data.get("scope", "")), questions=[q.__dict__ for q in self.questions], round=self.rounds)
                    await self._answered.wait()
                    answered = "\n".join(f"- {q.question}\n  Respuesta: {q.answer or '(decidilo vos con el criterio más razonable)'}" for q in self.questions)
                    self.emit("answers", answers={q.id: q.answer for q in self.questions})
                    msg = f"RESPUESTAS DEL USUARIO:\n{answered}\n\nSi ya está claro, Paso B (JSON con status ready y el prompt Markdown completo). Si queda una duda que cambia el producto, Paso A con menos preguntas."
                    continue
                prompt = str(data.get("prompt") or "").strip()
                if not prompt:
                    raise ValueError("El modelo no escribió el prompt")
                self.prompt_md = prompt
                self._set("done", self._step("done"))
                # the material goes with the prompt: the council sees it as shared context
                self.emit("done", prompt=prompt, understanding=self.understanding, cost_usd=round(self.cost_usd, 4), context=self.digest() if self.attachments else None)
                return
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self.error = str(e)[:600]
            self.status = "error"
            self.step = self._step("failed")
            self.emit("error", error=self.error)
            self.emit("status", status="error", step=self.step)


def create(user: User) -> Intake:
    it = Intake(user)
    INTAKES[it.id] = it
    # keep memory bounded: drop the user's oldest idle intakes
    mine = sorted((x for x in INTAKES.values() if x.user.id == user.id), key=lambda x: x.created)
    for old in mine[:-6]:
        if old.status not in ("running", "waiting"):
            INTAKES.pop(old.id, None)
    return it


def get(user: User, intake_id: str) -> Intake | None:
    it = INTAKES.get(intake_id)
    return it if it and it.user.id == user.id else None
