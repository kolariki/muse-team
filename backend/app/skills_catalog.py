"""
Skills catalog: every public Agent Skill we could find (Anthropic's official repo, the VoltAgent "awesome agent
skills" list with its ~1500 linked skills, and a few well-known collections), downloaded into
data/skills-catalog/sources/ and indexed so the user can search them and attach them to a role, and so the council
can pick the ones a task needs.

  sync()    clones/updates the sources (git, depth 1) and rebuilds the index — background job, progress in SYNC
  index()   list of {id, name, description, category, source, url, path, chars}
  body(id)  the SKILL.md text (+ a listing of bundled files) for the prompt
  search(q, category, limit)
  suggest(text, k)  catalog skills relevant to a task (lexical score over name/description/tags)
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

from .config import DATA_DIR

ROOT = DATA_DIR.parent / "skills-catalog"
SOURCES_DIR = ROOT / "sources"
INDEX_PATH = ROOT / "index.json"
BUNDLED_INDEX = Path(__file__).resolve().parents[1] / "skills_catalog_index.json"  # ships with the code: the sources are 3 GB and a server has none
CACHED_BODIES = ROOT / "cached"
TRANSLATIONS_PATH = ROOT / "translations.json"  # {skill_id: {"name_es", "description_es"}}
TRANSLATE: dict = {"running": False, "done": 0, "total": 0, "error": None, "finished": None}
ROOT.mkdir(parents=True, exist_ok=True)
SOURCES_DIR.mkdir(parents=True, exist_ok=True)

# collections cloned whole
COLLECTIONS = [
    ("anthropics/skills", "Anthropic (oficial)"),
    ("obra/superpowers", "Superpowers (obra)"),
    ("VoltAgent/awesome-agent-skills", "Awesome Agent Skills (índice)"),
]
MAX_BODY = 60_000
SKIP = {"node_modules", ".git", "__pycache__", "dist", "build", ".venv"}

SYNC: dict = {"running": False, "step": "", "done": 0, "total": 0, "repos": 0, "skills": 0, "errors": [], "finished": None}

# category by keywords over name + description + path (first match wins, ordered from specific to generic)
CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("qa", "QA y testing", ("test", "tests", "testing", "qa", "playwright", "cypress", "selenium", "appium", "jest", "pytest", "bdd", "gherkin", "e2e", "coverage", "mocks", "debugging", "debug", "tdd", "verification")),
    ("design", "Diseño y UX", ("design", "designer", "ui", "ux", "figma", "tailwind", "css", "theme", "themes", "brand", "canvas", "art", "accessibility", "wcag", "typography", "animation", "animations", "layout", "visual", "icons", "color", "colors")),
    ("security", "Seguridad", ("security", "secure", "owasp", "auth", "authentication", "vulnerability", "vulnerabilities", "pentest", "secrets", "jwt", "oauth", "compliance", "privacy", "gdpr", "threat")),
    ("devops", "DevOps e infraestructura", ("devops", "docker", "kubernetes", "k8s", "terraform", "cicd", "ci", "cd", "pipeline", "pipelines", "deploy", "deployment", "aws", "gcp", "azure", "cloud", "infra", "infrastructure", "monitoring", "observability", "sre", "helm", "nginx", "linux", "shell", "bash")),
    ("data", "Datos e IA", ("data", "sql", "database", "databases", "postgres", "postgresql", "mysql", "mongodb", "redis", "etl", "analytics", "pandas", "ml", "llm", "llms", "rag", "embeddings", "prompt", "prompts", "agent", "agents", "mcp", "claude", "openai", "model", "models", "vector", "notebook", "ai")),
    ("mobile", "Mobile", ("ios", "android", "swift", "swiftui", "kotlin", "flutter", "expo", "mobile", "xcode", "iphone")),
    ("frontend", "Frontend", ("react", "nextjs", "next.js", "vue", "svelte", "angular", "typescript", "javascript", "html", "web", "frontend", "components", "component", "browser", "artifacts", "vite", "tsx", "webapp")),
    ("backend", "Backend", ("backend", "api", "apis", "rest", "graphql", "grpc", "server", "node", "nodejs", "express", "fastapi", "django", "flask", "spring", "java", "rust", "golang", "dotnet", "c#", "python", "ruby", "rails", "php", "laravel", "microservices", "queue", "webhooks", "webhook")),
    ("product", "Producto", ("product", "pm", "roadmap", "requirements", "spec", "specs", "prd", "backlog", "prioritization", "discovery", "interviews", "research", "stories")),
    ("ceo", "Negocio y estrategia (CEO)", ("business", "strategy", "pricing", "monetization", "pitch", "investors", "market", "sales", "revenue", "startup", "okr", "okrs", "finance", "financial", "legal", "contracts", "hiring", "comms", "communication", "leadership", "executive")),
    ("growth", "Marketing y growth", ("marketing", "seo", "growth", "landing", "copywriting", "copy", "content", "social", "campaigns", "campaign", "newsletter", "email", "ads")),
    ("docs", "Documentos y oficina", ("docx", "pdf", "pptx", "xlsx", "excel", "word", "powerpoint", "slides", "document", "documents", "report", "reports", "spreadsheet", "presentation", "presentations", "writing", "markdown", "docs", "documentation")),
    ("cto", "Arquitectura y liderazgo técnico (CTO)", ("architecture", "architect", "scalability", "engineering", "review", "reviews", "refactoring", "refactor", "practices", "patterns", "performance", "migration", "monorepo", "workflow", "workflows", "git", "planning", "plans", "brainstorming", "superpowers", "codebase", "code")),
]
CATEGORY_LABELS = {k: v for k, v, _ in CATEGORIES} | {"other": "Otras"}
CATEGORY_LABELS_EN = {"qa": "QA & testing", "design": "Design & UX", "security": "Security", "devops": "DevOps & infrastructure", "data": "Data & AI", "mobile": "Mobile",
                      "frontend": "Frontend", "backend": "Backend", "product": "Product", "ceo": "Business & strategy (CEO)", "growth": "Marketing & growth",
                      "docs": "Documents & office", "cto": "Architecture & tech leadership (CTO)", "other": "Other"}
ROLE_CATEGORIES = {  # which catalog categories fit which role groups (for suggestions)
    "ceo": ["ceo", "product", "growth"], "cto": ["cto", "backend", "devops", "security", "data"], "product": ["product", "ceo", "growth", "design"],
    "design": ["design", "frontend", "mobile"], "frontend": ["frontend", "design", "qa"], "backend": ["backend", "data", "security", "devops"],
    "mobile": ["mobile", "design", "qa"], "qa": ["qa", "security", "devops"], "devops": ["devops", "security", "backend"], "security": ["security", "devops", "backend"],
    "data": ["data", "backend"], "growth": ["growth", "ceo", "product"], "docs": ["docs"],
}


def _slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")[:60]


def _frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.S)
    if not m:
        return {}, text
    meta: dict = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        if _ and k.strip() and not k.startswith(" "):
            meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta, text[m.end():]


_CAT_RE = [(key, re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(w.strip()) for w in words) + r")(?![a-z0-9])")) for key, _label, words in CATEGORIES]


def categorize(name: str, description: str, path: str) -> str:
    """Best category by weighted keyword hits (name and path count triple), whole-word matches only."""
    name_l, desc_l, path_l = name.lower(), description.lower(), path.lower().replace("/", " ").replace("-", " ")
    best, best_score = "other", 0
    for key, rx in _CAT_RE:
        score = 3 * len(rx.findall(name_l.replace("-", " "))) + 3 * len(rx.findall(path_l)) + len(rx.findall(desc_l))
        if score > best_score:
            best, best_score = key, score
    return best


# ------------------------------------------------------------------ sources

def _run(cmd: list[str], cwd: Path | None = None, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def _clone(repo: str, paths: list[str] | None = None) -> Path | None:
    """owner/name → sources/owner--name. Depth 1; when only some folders hold skills (`paths`), a sparse checkout of
    just those folders, so a repo that also ships videos or a whole product does not fill the disk."""
    dest = SOURCES_DIR / repo.replace("/", "--")
    sparse = [p for p in (paths or []) if p]
    try:
        if dest.exists():
            _run(["git", "pull", "-q", "--ff-only"], cwd=dest, timeout=300)
            if sparse:
                _run(["git", "sparse-checkout", "add", *sparse], cwd=dest, timeout=120)
            return dest
        if paths is None:
            r = _run(["git", "clone", "-q", "--depth", "1", f"https://github.com/{repo}", str(dest)], timeout=300)  # whole collections
        else:
            # blobless + sparse: only the skill folders, or (repo linked at its root) only Markdown + scripts folders
            r = _run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", f"https://github.com/{repo}", str(dest)], timeout=180)
            if r.returncode == 0:
                pats = ([*sparse, *[p + "/**" for p in sparse]] if "" not in paths else ["/*.md", "**/SKILL.md", "**/scripts/**", "**/references/**"])
                _run(["git", "sparse-checkout", "set", "--no-cone", *pats], cwd=dest, timeout=180)
        if r.returncode != 0:
            SYNC["errors"].append(f"{repo}: {r.stderr.strip()[:160]}")
            return None
        return dest
    except Exception as e:  # noqa: BLE001
        SYNC["errors"].append(f"{repo}: {e}")
        return None


LINK_RE = re.compile(r"\[([^\]]+)\]\((https://github\.com/([\w.-]+/[\w.-]+)(?:/(?:tree|blob)/[^/)]+/([^)\s]+))?)\)\**\s*-\s*([^\n]+)")


def awesome_entries() -> list[dict]:
    """Skills linked from VoltAgent/awesome-agent-skills README: {name, repo, path, url, description, section}."""
    readme = SOURCES_DIR / "VoltAgent--awesome-agent-skills" / "README.md"
    if not readme.exists():
        return []
    out, section = [], ""
    for line in readme.read_text(errors="ignore").splitlines():
        if line.startswith("#"):
            section = line.strip("# ").strip()
            continue
        m = LINK_RE.search(line)
        if m:
            name, url, repo, path, desc = m.groups()
            out.append({"name": name.strip(), "repo": repo, "path": (path or "").strip("/"), "url": url, "description": desc.strip().rstrip("."), "section": section})
    return out


def sync() -> None:
    """Clone/update everything and rebuild the index. Blocking; call from a thread."""
    if SYNC["running"]:
        return
    SYNC.update(running=True, step="Clonando colecciones", done=0, errors=[], finished=None, repos=0, skills=0)
    try:
        for repo, _label in COLLECTIONS:
            _clone(repo)
            SYNC["repos"] += 1
        entries = awesome_entries()
        by_repo: dict[str, list[str]] = {}
        for e in entries:
            by_repo.setdefault(e["repo"], []).append(e["path"])
        SYNC.update(step=f"Descargando {len(by_repo)} repositorios del índice", total=len(by_repo), done=0)
        for repo, paths in sorted(by_repo.items()):
            if repo in {r for r, _ in COLLECTIONS}:
                SYNC["done"] += 1
                continue
            _clone(repo, paths)
            SYNC["repos"] += 1
            SYNC["done"] += 1
        SYNC["step"] = "Indexando"
        idx = build_index()
        SYNC["skills"] = len(idx)
        SYNC["step"] = f"Listo: {len(idx)} skills"
    finally:
        SYNC["running"] = False
        SYNC["finished"] = time.time()


def sync_in_background() -> bool:
    if SYNC["running"]:
        return False
    threading.Thread(target=sync, name="skills-catalog-sync", daemon=True).start()
    return True


# ------------------------------------------------------------------ index

_cache: list[dict] | None = None


def build_index() -> list[dict]:
    """Every SKILL.md under sources/, enriched with the awesome-list description/section when linked there."""
    global _cache
    linked = {}
    for e in awesome_entries():
        linked[(e["repo"].replace("/", "--"), e["path"])] = e
    out: list[dict] = []
    seen: set[str] = set()
    for src in sorted(SOURCES_DIR.iterdir()):
        if not src.is_dir():
            continue
        for f in sorted(src.rglob("SKILL.md")):
            rel = f.relative_to(src)
            if any(p in SKIP for p in rel.parts):
                continue
            try:
                text = f.read_text(errors="ignore")
            except OSError:
                continue
            meta, body = _frontmatter(text)
            name = meta.get("name") or rel.parent.name or src.name
            desc = meta.get("description", "")
            skill_dir = str(rel.parent).replace("\\", "/")
            link = linked.get((src.name, skill_dir)) or next((v for (r, p), v in linked.items() if r == src.name and skill_dir.endswith(p) and p), None)
            if link:
                desc = desc or link["description"]
            sid = "cat-" + _slug(f"{src.name}-{skill_dir}")
            if sid in seen:
                continue
            seen.add(sid)
            source_label = next((lbl for repo, lbl in COLLECTIONS if repo.replace("/", "--") == src.name), src.name.replace("--", "/"))
            out.append({
                "id": sid, "name": name.replace("-", " ").strip()[:80], "slug": name, "description": desc[:400], "category": categorize(name, desc, skill_dir),
                "source": source_label, "repo": src.name.replace("--", "/"), "path": skill_dir if skill_dir != "." else "",
                "url": link["url"] if link else f"https://github.com/{src.name.replace('--', '/')}/tree/HEAD/{skill_dir if skill_dir != '.' else ''}",
                "section": link["section"] if link else "", "chars": len(body), "file": str(f.relative_to(SOURCES_DIR)),
            })
    INDEX_PATH.write_text(json.dumps(out, ensure_ascii=False))
    _cache = out
    return out


_translations: dict | None = None


def translations() -> dict:
    global _translations
    if _translations is None:
        try:
            _translations = json.loads(TRANSLATIONS_PATH.read_text()) if TRANSLATIONS_PATH.exists() else {}
        except json.JSONDecodeError:
            _translations = {}
    return _translations


def localized(s: dict) -> dict:
    """The index entry plus its Spanish name/description when translated (the originals are English)."""
    t = translations().get(s["id"])
    return s | {"name_es": t["name_es"], "description_es": t["description_es"]} if t else s


async def translate_missing(provider: str, model: str, cred) -> None:
    """Translate name + description of every untranslated catalog skill to rioplatense Spanish, 40 per call, cached."""
    from .providers import CallResult, stream
    if TRANSLATE["running"]:
        return
    todo = [s for s in index() if s["id"] not in translations()]
    TRANSLATE.update(running=True, done=0, total=len(todo), error=None, finished=None)
    try:
        for i in range(0, len(todo), 40):
            batch = todo[i:i + 40]
            payload = {s["id"]: {"name": s["name"], "description": s["description"][:300]} for s in batch}
            system = ("Traducí al español rioplatense (neutro, claro, sin anglicismos innecesarios; los nombres propios de productos y "
                      "tecnologías quedan igual). Respondé SOLO un JSON con la misma forma: {id: {\"name_es\": …, \"description_es\": …}}.")
            result = CallResult()
            chunks = []
            async for _kind, delta in stream(provider, model, system, json.dumps(payload, ensure_ascii=False), temperature=0.1, max_tokens=6000, result=result, cred=cred):
                chunks.append(delta)
            raw = "".join(chunks).strip()
            m = re.search(r"\{.*\}", raw, re.S)
            data = json.loads(m.group(0)) if m else {}
            for sid, v in data.items():
                if isinstance(v, dict) and v.get("name_es"):
                    translations()[sid] = {"name_es": str(v["name_es"])[:80], "description_es": str(v.get("description_es", ""))[:400]}
            TRANSLATIONS_PATH.write_text(json.dumps(translations(), ensure_ascii=False))
            TRANSLATE["done"] = min(len(todo), i + 40)
    except Exception as e:  # noqa: BLE001
        TRANSLATE["error"] = str(e)[:300]
    finally:
        TRANSLATE["running"] = False
        TRANSLATE["finished"] = time.time()


def _bundled() -> list[dict]:
    try:
        return json.loads(BUNDLED_INDEX.read_text())
    except (OSError, ValueError):
        return []


def index() -> list[dict]:
    global _cache
    if _cache is None:
        if INDEX_PATH.exists():
            try:
                _cache = json.loads(INDEX_PATH.read_text())
            except json.JSONDecodeError:
                _cache = build_index()
        else:
            _cache = build_index() if SOURCES_DIR.is_dir() and any(SOURCES_DIR.iterdir()) else _bundled()
    return _cache


def get(skill_id: str) -> dict | None:
    return next((s for s in index() if s["id"] == skill_id), None)


def _remote_body(s: dict) -> str | None:
    cached = CACHED_BODIES / f"{_slug(s['id'])}.md"
    try:
        return cached.read_text()[:MAX_BODY]
    except OSError:
        pass
    in_repo = s["file"].split("/", 1)[1] if "/" in s["file"] else "SKILL.md"
    try:
        with urlopen(f"https://raw.githubusercontent.com/{s['repo']}/HEAD/{quote(in_repo)}", timeout=10) as r:
            _meta, text = _frontmatter(r.read(400_000).decode("utf-8", "replace"))
    except OSError:
        return None
    CACHED_BODIES.mkdir(parents=True, exist_ok=True)
    cached.write_text(text.strip())
    return text.strip()[:MAX_BODY]


def body(skill_id: str) -> str | None:
    """SKILL.md text plus the names of the files that ship with it (scripts, references) so the role knows they exist."""
    s = get(skill_id)
    if not s:
        return None
    f = SOURCES_DIR / s["file"]
    try:
        _meta, text = _frontmatter(f.read_text(errors="ignore"))
    except OSError:  # a server without the sources reads that one skill from its repo, once
        return _remote_body(s)
    extras = [str(p.relative_to(f.parent)) for p in f.parent.rglob("*") if p.is_file() and p.name != "SKILL.md" and not any(x in p.parts for x in SKIP)][:40]
    tail = ("\n\n(Archivos que acompañan a esta skill en su repositorio: " + ", ".join(extras) + ")") if extras else ""
    return (text.strip()[:MAX_BODY] + tail)


_hay_cache: tuple[int, list[tuple[str, str]]] | None = None  # (id(index), [(name+slug, full haystack)])


def _haystacks() -> list[tuple[str, str]]:
    """Lower-cased search text per index entry, built once per index (and per translations change)."""
    global _hay_cache
    idx = index()
    key = id(idx) + len(translations())
    if _hay_cache is None or _hay_cache[0] != key:
        tr_ = translations()
        rows = []
        for s in idx:
            t = tr_.get(s["id"], {})
            rows.append((f"{s['name']} {s['slug']}".lower(), f"{s['name']} {s['slug']} {s['description']} {s['repo']} {s['section']} {t.get('name_es', '')} {t.get('description_es', '')}".lower()))
        _hay_cache = (key, rows)
    return _hay_cache[1]


def search(q: str = "", category: str = "", limit: int = 60) -> list[dict]:
    terms = [t for t in re.split(r"\s+", q.lower().strip()) if t]
    out = []
    for s, (names, hay) in zip(index(), _haystacks()):
        if category and s["category"] != category:
            continue
        if terms:
            score = sum(3 if t in names else 1 for t in terms if t in hay)
            if score < len(terms):
                continue
            out.append((score, s))
        else:
            out.append((0, s))
    out.sort(key=lambda x: (-x[0], x[1]["source"] != "Anthropic (oficial)", x[1]["name"]))
    return [localized(s) for _, s in out[:limit]]


_cat_cache: tuple[int, list[dict]] | None = None


def categories() -> list[dict]:
    global _cat_cache
    idx = index()
    if _cat_cache and _cat_cache[0] == id(idx):
        return _cat_cache[1]
    counts: dict[str, int] = {}
    for s in idx:
        counts[s["category"]] = counts.get(s["category"], 0) + 1
    order = [k for k, _, _ in CATEGORIES] + ["other"]
    _cat_cache = (id(idx), [{"id": k, "label": CATEGORY_LABELS[k], "label_en": CATEGORY_LABELS_EN.get(k, CATEGORY_LABELS[k]), "count": counts.get(k, 0)} for k in order if counts.get(k)])
    return _cat_cache[1]


STOP = set(("the a an and or of to for in on with de la el los las un una y o para por con del al es que se su sus como más mas sin sobre entre "
            "app apps use using que queremos quiero necesito construir build equipo team plan etapas pasos lista final debe quede concretos mvp "
            "producto product decidan alcance criterios aceptación empezar mañana idea acá describí tu una this that you your "
            "senior junior engineer engineers engineering manager head lead officer chief ingeniero ingeniería responsable rol role").split())
# Spanish task words → the English words skills are described with (skills are almost all in English)
ES_EN = {
    "pagos": "payments stripe billing", "pago": "payments", "cobrar": "payments", "suscripción": "subscription", "suscripciones": "subscriptions",
    "pruebas": "testing tests", "prueba": "testing", "testeo": "testing", "testear": "testing", "calidad": "quality qa",
    "diseño": "design ui ux", "diseñar": "design", "pantallas": "screens ui", "interfaz": "ui interface", "accesibilidad": "accessibility",
    "usuarios": "users", "usuario": "user", "login": "auth login", "registro": "signup auth", "autenticación": "auth authentication",
    "datos": "data", "base": "database", "basededatos": "database", "mapa": "map maps geolocation", "mapas": "maps", "ubicación": "location geolocation",
    "notificaciones": "notifications push", "notificación": "notification", "correo": "email", "mail": "email", "mensajes": "messaging chat",
    "seguridad": "security", "tienda": "store ecommerce shop", "ecommerce": "ecommerce", "carrito": "cart checkout", "catálogo": "catalog",
    "móvil": "mobile", "movil": "mobile", "celular": "mobile", "ios": "ios swift", "android": "android kotlin", "web": "web frontend",
    "backend": "backend api", "api": "api", "apis": "api", "integración": "integration", "integrar": "integration", "despliegue": "deploy deployment",
    "producción": "production deploy", "servidor": "server", "nube": "cloud", "docker": "docker", "rendimiento": "performance",
    "sismo": "earthquake alerts realtime", "sismos": "earthquake alerts realtime", "alertas": "alerts notifications", "clima": "weather", "pronóstico": "forecast weather",
    "marketing": "marketing seo", "seo": "seo", "landing": "landing page", "ventas": "sales", "precio": "pricing", "precios": "pricing", "monetizar": "monetization pricing",
    "documento": "document docx", "documentos": "documents", "pdf": "pdf", "excel": "xlsx excel spreadsheet", "planilla": "spreadsheet xlsx", "presentación": "pptx presentation",
    "video": "video", "imagen": "image", "imágenes": "images", "chat": "chat", "bot": "bot chatbot", "ia": "ai llm", "inteligencia": "ai", "agente": "agent", "agentes": "agents",
    "automatizar": "automation", "automatización": "automation", "analítica": "analytics", "métricas": "metrics analytics", "reportes": "reports", "dashboard": "dashboard",
    "arquitectura": "architecture", "escalar": "scalability", "migrar": "migration", "pipeline": "pipeline ci", "pruebas e2e": "e2e", "react": "react", "next": "nextjs", "python": "python",
}


def _terms(text: str) -> dict[str, int]:
    freq: dict[str, int] = {}
    for w in re.findall(r"[a-záéíóúñ0-9.+#-]{3,}", text.lower()):
        if w in STOP:
            continue
        for t in (ES_EN.get(w, w)).split():
            if t not in STOP:
                freq[t] = freq.get(t, 0) + 1
    return freq


_df_cache: tuple[int, dict[str, int]] = (0, {})


def _df(stem: str) -> int:
    """Number of catalog entries whose search text contains the stem (cached per index version)."""
    global _df_cache
    hays = _haystacks()
    if _df_cache[0] != id(hays):
        _df_cache = (id(hays), {})
    cache = _df_cache[1]
    if stem not in cache:
        cache[stem] = sum(1 for _names, hay in hays if stem in hay)
    return cache[stem]


def suggest(text: str, k: int = 5, role_group: str | None = None) -> list[dict]:
    """Catalog skills relevant to a task (and, optionally, a role group): lexical overlap on English-normalised terms,
    a hit in the skill's name required, with a category boost for the role."""
    freq = _terms(text)
    if not freq:
        return []
    wanted = set(ROLE_CATEGORIES.get(role_group or "", []))
    hays = _haystacks()
    n_docs = max(1, len(hays))
    # rarity: a term that appears in half the catalog ("api", "test") says little; one in a handful says a lot.
    # df is cached per stem (a whole generated brief has hundreds of terms; this must stay well under a second)
    stems = {w: (w[:4] if len(w) >= 4 else w) for w in freq}
    df = {w: _df(stems[w]) for w in freq}
    weight = {w: max(0.0, math.log(n_docs / (1 + df[w]))) for w in freq}
    # keep the terms that carry signal: the rarest ones, by frequency in the text (a long brief would otherwise match everything)
    keep = sorted(freq, key=lambda w: (-weight[w] * freq[w], w))[:40]
    freq = {w: freq[w] for w in keep if weight[w] > 0.5 or n_docs < 100}
    if not freq:
        return []
    scored = []
    for s, (names, hay) in zip(index(), hays):
        name_words = set(re.findall(r"[a-z0-9.+#]+", names.replace("-", " ")))
        # a term hits the name when a name word starts with its stem (test → testing, payment → payments)
        name_hits = [w for w in freq if any(n.startswith(stems[w]) and (len(w) >= 4 or n == w) for n in name_words)]
        if not name_hits:
            continue
        desc_hits = [w for w in freq if w not in name_hits and stems[w] in hay]
        if len(name_hits) + len(desc_hits) < 2 and df[name_hits[0]] > 40:
            continue  # one common word in the name is a coincidence, not a match
        score = sum(weight[w] * 3 for w in name_hits) + sum(weight[w] for w in desc_hits)
        if wanted and s["category"] in wanted:
            score *= 1.6
        if s["source"] == "Anthropic (oficial)":
            score *= 1.2
        scored.append((score, s))
    scored.sort(key=lambda x: (-x[0], x[1]["name"]))
    return [dict(localized(s), score=round(sc, 1)) for sc, s in scored[:k]]


PICK_SYSTEM = """Armás un equipo de IA para una tarea. A cada rol le pasás, de una lista de candidatas, solo las skills que de verdad le sirven para ESA tarea.
La lista sale de una búsqueda por palabras y trae coincidencias falsas: «hackernews» para un hackathon o «barbados vat» para una barbería no sirven. Si ninguna sirve para un rol, dejalo vacío. Mejor pocas y buenas.
Respondé SOLO con JSON: {{"id del rol": ["id de skill", ...]}}, como máximo {k} por rol."""


def parse_picks(text: str) -> dict[str, list[str]] | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        d = json.loads(m.group(0)) if m else None
    except ValueError:
        return None
    return {str(k): [str(x) for x in v] for k, v in d.items() if isinstance(v, list)} if isinstance(d, dict) else None


async def pick_for_roles(task: str, roles: list[dict], shortlist: dict[str, list[dict]], k: int, provider: str, model: str, cred) -> dict[str, list[dict]] | None:
    """A model chooses among what the word search found, because the word search alone is not trustworthy. None if it can't answer."""
    from .providers import CallResult, MockContext, stream

    rows = []
    for r in roles:
        cands = "\n".join(f"- {c['id']}: {c['name']}. {str(c.get('description') or '')[:140]}" for c in shortlist.get(r.get("id"), []))
        rows.append(f"ROL {r.get('id')} ({r.get('label') or ''}): {r.get('mandate') or ''}\nCandidatas:\n{cands or '(ninguna)'}")
    user = f"TAREA:\n{task[:6000]}\n\n" + "\n\n".join(rows)
    parts: list[str] = []
    async for kind, delta in stream(provider, model, PICK_SYSTEM.format(k=k), user, temperature=0, max_tokens=1500, result=CallResult(), mock=MockContext("Skills", [("x", "x")], "skills", script="{}"), cred=cred):
        if kind == "text":
            parts.append(delta)
    picks = parse_picks("".join(parts))
    if picks is None:
        return None
    out = {}
    for r in roles:
        known = {c["id"]: c for c in shortlist.get(r.get("id"), [])}
        out[r.get("id")] = [{**known[i], "score": 100} for i in picks.get(str(r.get("id")), []) if i in known][:k]
    return out
