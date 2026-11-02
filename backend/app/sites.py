"""Tably Analytics for apps that live outside Tably (their own GitHub + Railway/Vercel/…): the site is registered here,
and the `/a.js` snippet gets into the app in one of three ways:

  · a pull request Tably opens on the app's GitHub repo (with the token from Settings), so the host deploys it on merge
  · `npx -y <collector>/pkg/tably-analytics-<slug>.tgz` run in the project folder: it adds the snippet to the pages itself
  · the `tably-analytics` package (`npm i <same url>` + `import 'tably-analytics'`) or the plain script tag

The package is built on the fly with the site and the collector already inside, so there is nothing to configure.
"""
from __future__ import annotations

import base64
import io
import json
import re
import secrets
import tarfile
import time

import httpx

from .auth import _db

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS analytics_sites (
            slug TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, repo TEXT,
            pr_url TEXT, pr_error TEXT, created REAL NOT NULL, updated REAL NOT NULL)"""
    )

REPO_RX = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?(?:[#?].*)?$", re.I)
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", "vendor", "coverage", "storybook-static",
             "__tests__", "test", "tests", "fixtures", "e2e", "cypress", ".venv", "venv", "__pycache__", "target", ".angular"}
PAGE_EXT = (".html", ".htm", ".ejs", ".hbs", ".handlebars", ".njk", ".jinja", ".jinja2", ".j2", ".erb", ".php", ".liquid", ".cshtml")
LAYOUT_RX = re.compile(r"^(?:src/)?app/layout\.(?:tsx|jsx|ts|js)$")
DOCUMENT_RX = re.compile(r"^(?:src/)?pages/_document\.(?:tsx|jsx|ts|js)$")
MAX_FILES = 60


def tag(collector: str, slug: str) -> str:
    return f'<script defer src="{collector}/a.js" data-site="{slug}"></script>'


def _row(r) -> dict:
    return dict(r) if r else {}


def list_sites(user_id: str) -> list[dict]:
    with _db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM analytics_sites WHERE user_id = ? ORDER BY created DESC", (user_id,))]


def get(user_id: str, slug: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM analytics_sites WHERE user_id = ? AND slug = ?", (user_id, slug)).fetchone()
    return dict(r) if r else None


def exists(slug: str) -> bool:
    with _db() as c:
        return bool(c.execute("SELECT 1 FROM analytics_sites WHERE slug = ?", (slug,)).fetchone())


def normal_url(url: str) -> str | None:
    url = (url or "").strip()
    if not url:
        return None
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    if not re.match(r"^https?://[\w.-]+\.[a-z]{2,}(?::\d+)?(?:/\S*)?$", url, re.I):
        raise ValueError("El link del sitio no parece una dirección web (ej.: https://elevum.com)")
    return url.rstrip("/")


def normal_repo(repo: str) -> str | None:
    repo = (repo or "").strip()
    if not repo:
        return None
    m = REPO_RX.match(repo)
    if not m:
        raise ValueError("El repositorio tiene que ser un link de GitHub (ej.: https://github.com/tu-usuario/elevum)")
    return f"https://github.com/{m.group(1)}/{m.group(2)}"


def _free_slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9-]+", "-", (title or "sitio").lower()).strip("-")[:40] or "sitio"
    with _db() as c:
        taken = {r[0] for r in c.execute("SELECT slug FROM analytics_sites WHERE slug LIKE ?", (base + "%",))}
        taken |= {r[0] for r in c.execute("SELECT slug FROM cloud_apps WHERE slug LIKE ?", (base + "%",))}
    if base not in taken:
        return base
    while True:
        s = f"{base}-{secrets.token_hex(2)}"
        if s not in taken:
            return s


def create(user_id: str, title: str, url: str = "", repo: str = "") -> dict:
    title = (title or "").strip()[:80]
    if not title:
        raise ValueError("Poné el nombre del sitio")
    u, r = normal_url(url), normal_repo(repo)
    if not u and not r:
        raise ValueError("Pegá el link del sitio o el de su repositorio de GitHub")
    slug, now = _free_slug(title), time.time()
    with _db() as c:
        c.execute("INSERT INTO analytics_sites (slug, user_id, title, url, repo, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)", (slug, user_id, title, u, r, now, now))
    return get(user_id, slug) or {}


def update(user_id: str, slug: str, **fields) -> dict:
    cur = get(user_id, slug)
    if not cur:
        raise KeyError(slug)
    if "url" in fields:
        fields["url"] = normal_url(fields["url"] or "")
    if "repo" in fields:
        fields["repo"] = normal_repo(fields["repo"] or "")
    cur.update({k: v for k, v in fields.items() if k in ("title", "url", "repo", "pr_url", "pr_error")})
    with _db() as c:
        c.execute("UPDATE analytics_sites SET title = ?, url = ?, repo = ?, pr_url = ?, pr_error = ?, updated = ? WHERE slug = ? AND user_id = ?",
                  (cur["title"], cur["url"], cur["repo"], cur["pr_url"], cur["pr_error"], time.time(), slug, user_id))
    return cur


def remove(user_id: str, slug: str) -> None:
    with _db() as c:
        c.execute("DELETE FROM analytics_sites WHERE user_id = ? AND slug = ?", (user_id, slug))
        c.execute("DELETE FROM analytics_hits WHERE site = ?", (slug,))
        c.execute("DELETE FROM analytics_people WHERE site = ?", (slug,))


def as_app(site: dict) -> dict:
    """The shape the Analytics endpoints use for a published app (there is no build: errors, A/B and AI calls still come from the snippet)."""
    return {"slug": site["slug"], "build_id": f"site:{site['slug']}", "url": site.get("url"), "status": "live", "provider": "external", "title": site["title"]}


# ------------------------------------------------------------------------------------------------ putting the snippet in the code

GENERATED_DIRS = {"reports", "reportes", "informes", "report", "reporte", "cartas_ofertas", "cartas", "outputs", "output", "exports", "uploads", "storage", "logs", "tmp", "temp"}
SHELL_RX = re.compile(r"^_?(index|base|layout|_layout|app|main|default|master|document)\.", re.I)


SIDE_DIRS = re.compile(r"^(docs?|examples?|demos?|samples?|playground|[\w.-]+-examples?)$", re.I)
NOT_PAGE = re.compile(r"e-?mail|newsletter|correo|pdf|report|invoice|factura|carta", re.I)


def _generated(p: str) -> bool:
    """Files a program wrote or that are not the site (reports, e-mails, PDFs, exports…): a date or a long number in the name,
    a name like that, or a reports/exports folder."""
    name = p.rsplit("/", 1)[-1]
    return (bool(re.search(r"\d{4}-\d{2}-\d{2}|\d{8,}", name)) or bool(NOT_PAGE.search(name))
            or any(x.lower() in GENERATED_DIRS for x in p.split("/")[:-1]))


def _side(p: str) -> bool:
    """Docs, examples and demos next to the app: only used when the repo has nothing else."""
    return any(SIDE_DIRS.match(x) for x in p.split("/")[:-1])


def candidates(paths: list[str]) -> list[str]:
    """The files that can carry the snippet: pages and templates with a <head>, and Next.js's root layout / _document.
    When the app has a shell (index.html, a base template, the Next.js layout) only the shells get it: every screen loads them."""
    out = []
    for p in paths:
        parts = p.split("/")
        if any(x in SKIP_DIRS for x in parts[:-1]) or re.search(r"(^|/)(e-?mails?|mail)(/|$)", p, re.I) or _generated(p):
            continue
        if LAYOUT_RX.match(p) or DOCUMENT_RX.match(p) or p.lower().endswith(PAGE_EXT):
            out.append(p)

    def shell(p: str) -> bool:
        return bool(LAYOUT_RX.match(p) or DOCUMENT_RX.match(p) or SHELL_RX.match(p.rsplit("/", 1)[-1]))

    out = [p for p in out if not _side(p)] or out
    shells = [p for p in out if shell(p)]
    return sorted(shells or out, key=lambda p: (p.count("/"), p))


CODE_EXT = (".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".php", ".java", ".cs", ".vue", ".svelte")
CODE_HINT = re.compile(r"seo|page|template|view|render|layout|html|landing|home|header|head|ssr|site|web|server|app|index|main", re.I)


def code_candidates(paths: list[str]) -> list[str]:
    """Backends that write their pages from code (an HTML string with </head> in a .js/.py…): the files most likely to hold it."""
    out = [p for p in paths if p.lower().endswith(CODE_EXT) and not _generated(p)
           and not any(x in SKIP_DIRS or x.lower() in ("scripts", "migrations", "seeders", "seeds") for x in p.split("/")[:-1])
           and not _side(p) and not re.search(r"(\.test|\.spec|\.d)\.", p) and not re.search(r"(^|/)(e-?mails?|mail)", p, re.I)]
    return sorted(out, key=lambda p: (0 if CODE_HINT.search(p.rsplit("/", 1)[-1]) else 1, p.count("/"), p))


def patch_code(text: str, snippet: str) -> str | None:
    """Put the tag before each literal </head> in source code, with the quotes that do not break the string around it."""
    if snippet in text or snippet.replace('"', "'") in text:
        return None
    out, last, n = [], 0, 0
    for m in re.finditer(r"</head\s*>", text, re.I):
        # only a </head> that closes a real <head> in the same HTML; never a bare '</head>' used as a search string
        if m.start() and text[m.start() - 1] in "'\"`" or "<head" not in text[max(0, m.start() - 4000): m.start()].lower():
            continue
        line = text[text.rfind("\n", 0, m.start()) + 1: m.start()]
        tag_ = snippet.replace('"', "'") if line.count('"') % 2 == 1 else snippet
        out += [text[last:m.start()], tag_]
        last, n = m.start(), n + 1
    return "".join(out) + text[last:] if n else None


_OLD_TAG = re.compile(r"""<script[^>]*src=["'][^"']*/a\.js["'][^>]*data-site=["'][^"']*["'][^>]*>\s*</script>|<script[^>]*data-site=["'][^"']*["'][^>]*src=["'][^"']*/a\.js["'][^>]*>\s*</script>""", re.I)


def patch(path: str, text: str, snippet: str) -> str | None:
    """The file with the snippet in it, or None if it does not apply (or it is already there)."""
    if _OLD_TAG.search(text):  # an older snippet (another address or site): swap it
        new = _OLD_TAG.sub(snippet, text, count=1)
        return new if new != text else None
    if DOCUMENT_RX.match(path):
        if re.search(r"<Head\s*/>", text):
            return re.sub(r"<Head\s*/>", f"<Head>{snippet}</Head>", text, count=1)
        if "</Head>" in text:
            return text.replace("</Head>", f"  {snippet}\n        </Head>", 1)
        return None
    if LAYOUT_RX.match(path):
        if "</head>" in text:
            return text.replace("</head>", f"  {snippet}\n      </head>", 1)
        m = re.search(r"<html\b[^>]*>", text)
        return text[: m.end()] + f"\n      <head>{snippet}</head>" + text[m.end():] if m else None
    m = re.search(r"[ \t]*</head\s*>", text, re.I)
    if not m:
        return None
    pad = re.match(r"[ \t]*", m.group(0)).group(0)
    return text[: m.start()] + f"{pad}  {snippet}\n" + text[m.start():]


# ------------------------------------------------------------------------------------------------ GitHub pull request

def _gh(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict | list]:
    try:
        r = httpx.request(method, f"https://api.github.com{path}", json=body, timeout=40,
                          headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "tablyteam"})
        return r.status_code, (r.json() if r.content else {})
    except (httpx.HTTPError, ValueError) as e:
        return 0, {"message": str(e)[:200]}


def _paths(own: str, name: str, sha: str, token: str) -> list[str] | None:
    """Every file of the repo (under 400 KB). GitHub cuts the recursive list of big repos (node_modules or .yarn committed):
    then it walks the folders one by one, skipping those."""
    code, tree = _gh("GET", f"/repos/{own}/{name}/git/trees/{sha}?recursive=1", token)
    if code != 200 or not isinstance(tree, dict):
        return None
    files = lambda t, pre="": [pre + x["path"] for x in t.get("tree", []) if x.get("type") == "blob" and x.get("size", 0) < 400_000]
    if not tree.get("truncated"):
        return files(tree)
    out, todo, calls = [], [("", sha)], 0
    while todo and calls < 200:
        pre, s = todo.pop(0)
        code, t = _gh("GET", f"/repos/{own}/{name}/git/trees/{s}", token)
        calls += 1
        if code != 200 or not isinstance(t, dict):
            continue
        out += files(t, pre)
        todo += [(pre + x["path"] + "/", x["sha"]) for x in t.get("tree", []) if x.get("type") == "tree"
                 and x["path"] not in SKIP_DIRS and not x["path"].startswith(".") and pre.count("/") < 6]
    return out


BRANCH = "tably-analytics"
BAD_TOKEN = "GitHub no acepta tu token: venció, lo borraste o lo que se guardó no es un token. Cargá uno nuevo con permiso «repo»."


def clear_token_errors(user_id: str) -> None:
    """A new token was saved: the «token rejected» notices of the user's sites no longer apply."""
    with _db() as c:
        c.execute("UPDATE analytics_sites SET pr_error = NULL WHERE user_id = ? AND pr_error = ?", (user_id, BAD_TOKEN))


def check_token(token: str) -> str | None:
    """None when GitHub accepts the token; otherwise what to tell the user."""
    token = (token or "").strip()
    if not token:
        return "Pegá el token de GitHub"
    if re.search(r"\s|github\.com|/", token):
        return "Eso no es un token: pegaste un link o un nombre. El token empieza con ghp_ o github_pat_ y se crea en GitHub → Settings → Developer settings → Tokens."
    code, me = _gh("GET", "/user", token)
    if code == 401:
        return "GitHub no acepta ese token (puede estar vencido o mal copiado). Creá uno nuevo con permiso «repo»."
    if code != 200:
        return None  # GitHub unreachable: keep it, the next call says what happened
    return None


def _push(own: str, name: str, base: str, head_sha: str, changes: dict[str, str], token: str, branch: str, message: str, title: str, body: str) -> dict:
    """One commit with every file (blobs → tree → commit → branch) and the PR for it (the open one when there is one)."""
    items = []
    for p, text in changes.items():
        code, blob = _gh("POST", f"/repos/{own}/{name}/git/blobs", token, {"content": text, "encoding": "utf-8"})
        if code != 201:
            return {"ok": False, "error": f"GitHub no aceptó el cambio en {p}"}
        items.append({"path": p, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    code, head = _gh("GET", f"/repos/{own}/{name}/git/commits/{head_sha}", token)
    if code != 200 or not isinstance(head, dict):
        return {"ok": False, "error": "No pude leer el último commit del repo"}
    code, new_tree = _gh("POST", f"/repos/{own}/{name}/git/trees", token, {"base_tree": head["tree"]["sha"], "tree": items})
    if code != 201:
        return {"ok": False, "error": "GitHub no aceptó los cambios"}
    code, commit = _gh("POST", f"/repos/{own}/{name}/git/commits", token, {"message": message, "tree": new_tree["sha"], "parents": [head_sha]})
    if code != 201:
        return {"ok": False, "error": "GitHub no aceptó el commit"}
    code, _ = _gh("POST", f"/repos/{own}/{name}/git/refs", token, {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
    if code == 422:  # the branch is there from a previous try: move it
        code, _ = _gh("PATCH", f"/repos/{own}/{name}/git/refs/heads/{branch}", token, {"sha": commit["sha"], "force": True})
    if code not in (200, 201):
        return {"ok": False, "error": "No pude crear la rama en GitHub"}
    code, prs = _gh("GET", f"/repos/{own}/{name}/pulls?head={own}:{branch}&state=open", token)
    if code == 200 and isinstance(prs, list) and prs:
        return {"ok": True, "url": prs[0].get("html_url"), "files": list(changes)}
    code, pr = _gh("POST", f"/repos/{own}/{name}/pulls", token, {"title": title, "head": branch, "base": base, "body": body})
    if code not in (200, 201) or not isinstance(pr, dict):
        return {"ok": False, "error": f"GitHub no dejó abrir el PR: {pr.get('message') if isinstance(pr, dict) else code}"}
    return {"ok": True, "url": pr.get("html_url"), "files": list(changes)}


def open_pr(site: dict, token: str, collector: str) -> dict:
    """Read the repo through the API (no clone), add the snippet where it goes, push it as a branch and open a PR."""
    m = REPO_RX.match(site.get("repo") or "")
    if not m:
        return {"ok": False, "error": "Falta el link del repositorio de GitHub"}
    own, name = m.group(1), m.group(2)
    code, repo = _gh("GET", f"/repos/{own}/{name}", token)
    if code == 401:
        return {"ok": False, "error": BAD_TOKEN}
    if code == 404:
        return {"ok": False, "error": f"GitHub no encuentra {own}/{name} con tu token. Si el repo es privado, el token necesita el permiso «repo» y acceso a esa cuenta u organización."}
    if code != 200 or not isinstance(repo, dict):
        return {"ok": False, "error": f"GitHub respondió {code}: {(repo or {}).get('message', '') if isinstance(repo, dict) else ''}"}
    if not (repo.get("permissions") or {}).get("push"):
        return {"ok": False, "error": f"Tu token puede leer {own}/{name} pero no escribir: necesita el permiso «repo» (o «Contents» y «Pull requests» de escritura)."}
    base = repo.get("default_branch") or "main"
    code, ref = _gh("GET", f"/repos/{own}/{name}/git/ref/heads/{base}", token)
    if code != 200:
        return {"ok": False, "error": f"No pude leer la rama {base} del repo"}
    head_sha = ref["object"]["sha"]
    paths = _paths(own, name, head_sha, token)
    if paths is None:
        return {"ok": False, "error": "No pude leer los archivos del repo"}
    snippet, changes, already = tag(collector, site["slug"]), {}, []
    for p in candidates(paths)[:120]:
        code, f = _gh("GET", f"/repos/{own}/{name}/contents/{p}?ref={base}", token)
        if code != 200 or not isinstance(f, dict) or f.get("encoding") != "base64":
            continue
        try:
            text = base64.b64decode(f["content"]).decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            continue
        if snippet in text:
            already.append(p)
            continue
        new = patch(p, text, snippet)
        if new and new != text:
            changes[p] = new
        if len(changes) >= MAX_FILES:
            break
    # backends that write their pages from code (an HTML string with </head>, e.g. server-rendered SEO pages): those too
    if len(changes) < MAX_FILES:
        for p in code_candidates(paths)[:120]:
            code, f = _gh("GET", f"/repos/{own}/{name}/contents/{p}?ref={base}", token)
            if code != 200 or not isinstance(f, dict) or f.get("encoding") != "base64":
                continue
            try:
                text = base64.b64decode(f["content"]).decode("utf-8")
            except (UnicodeDecodeError, ValueError):
                continue
            if snippet in text or snippet.replace('"', "'") in text:
                already.append(p)
                continue
            new = patch_code(text, snippet) if re.search(r"<html|<!doctype", text, re.I) else None
            if new:
                changes[p] = new
            if len(changes) >= MAX_FILES:
                break
    # an earlier PR may have put it in e-mails, PDFs' HTML, docs or demos: take it out of those
    if changes or already:
        stray = [p for p in paths if p.lower().endswith(PAGE_EXT) and (_generated(p) or _side(p)) and p not in changes]
        for p in stray[:40]:
            code, f = _gh("GET", f"/repos/{own}/{name}/contents/{p}?ref={base}", token)
            if code != 200 or not isinstance(f, dict) or f.get("encoding") != "base64":
                continue
            text = base64.b64decode(f["content"]).decode("utf-8", "ignore")
            if snippet in text:
                changes[p] = re.sub(r"[ \t]*" + re.escape(snippet) + r"[ \t]*\r?\n?", "", text)
    if not changes and already:
        return {"ok": True, "url": site.get("pr_url"), "files": [], "already": already}
    if not changes:
        return {"ok": False, "code": "no_pages", "error": f"En {own}/{name} no hay ninguna página donde poner el script (ni un index.html ni un layout de Next.js)."}
    files = "\n".join(f"- `{p}`" for p in changes)
    body = (f"Agrega **Tably Analytics** a {site['title']}: visitas, de dónde llegan, qué tocan, gente en vivo y errores. Sin cookies ni datos personales.\n\n"
            f"Es una sola línea en cada página:\n\n```html\n{snippet}\n```\n\nArchivos:\n{files}\n\n"
            "Cuando se mergee y se despliegue, las visitas aparecen en Tably → Analíticas.\n\n"
            "Si la app tiene usuarios, donde ya sabe quién inició sesión se puede agregar `window.tably && window.tably.identify({ email, name, id })` para ver quién es cada visitante.")
    return _push(own, name, base, head_sha, changes, token, BRANCH, "Tably Analytics: visitas, clics y errores (sin cookies)", "Tably Analytics", body)


# ------------------------------------------------------------------------------------------------ who signed in

ID_BRANCH = "tably-identify"
AUTH_PATH = re.compile(r"auth|login|log-in|signin|sign-in|session|account|user|profile|guard|interceptor|store|context|provider|app\.(component|tsx|jsx|vue)", re.I)
AUTH_CODE = re.compile(r"\b(login|logIn|signIn|signin|signInWith\w*|setUser|currentUser|onAuthStateChanged|getSession|getUser|useSession|useUser|"
                       r"me\(\)|/auth/|/login|/me\b|localStorage\.setItem\(\s*['\"](?:token|user|auth|access_token|jwt))", re.I)
ID_SYSTEM = """Sos un ingeniero que agrega la identificación de usuarios de Tably Analytics a una app, tocando lo mínimo.
Te paso los archivos de la app donde se maneja el inicio de sesión. Buscá los lugares donde la app YA SABE quién es el usuario:
justo después de un login o registro exitoso, y cuando la app carga con la sesión ya abierta (al leer el usuario guardado o al pedir /me).
Ahí agregá una sola llamada con los datos que la app ya tiene a mano en ese punto:
- JavaScript: window.tably && window.tably.identify({ email: <email>, name: <nombre o "">, id: <id o ""> })
- TypeScript: (window as any).tably?.identify?.({ email: <email>, name: <nombre o "">, id: <id o ""> })
Reglas: nunca contraseñas, tokens ni otros datos; no cambies nada más; no inventes variables (usá las que existen en ese punto); si un
dato no está, pasá "". Si la app no tiene usuarios o no encontrás dónde, devolvé edits vacío y explicalo en summary.
Cada edit reemplaza un fragmento EXACTO del archivo (copiado tal cual, con su indentación, que aparezca una sola vez) por el mismo fragmento con la llamada agregada.
Respondé SOLO JSON: {"summary": "qué hiciste, en una o dos frases", "edits": [{"path": "", "find": "fragmento exacto", "replace": "fragmento con la llamada", "why": ""}]}"""


def _auth_files(own: str, name: str, base: str, head_sha: str, token: str) -> list[tuple[str, str]]:
    """The few files where the app handles signing in, best first."""
    paths = _paths(own, name, head_sha, token) or []
    code = [p for p in paths if p.lower().endswith(CODE_EXT) and not _side(p) and not _generated(p) and not any(x in SKIP_DIRS for x in p.split("/")[:-1])
            and not re.search(r"(\.test|\.spec|\.d|\.min)\.", p)]
    named = sorted([p for p in code if AUTH_PATH.search(p)], key=lambda p: (0 if re.search(r"auth|login|signin|sign-in|session", p, re.I) else 1, p.count("/")))[:40]
    scored = []
    for p in named:
        c, f = _gh("GET", f"/repos/{own}/{name}/contents/{p}?ref={base}", token)
        if c != 200 or not isinstance(f, dict) or f.get("encoding") != "base64":
            continue
        text = base64.b64decode(f["content"]).decode("utf-8", "ignore")
        n = len(AUTH_CODE.findall(text))
        if n and "tably" not in text.lower():
            scored.append((n + (3 if re.search(r"auth|login", p, re.I) else 0), p, text))
    scored.sort(key=lambda x: -x[0])
    return [(p, t) for _, p, t in scored[:6]]


def apply_edits(files: dict[str, str], edits: list) -> dict[str, str]:
    """The model's edits that are safe to apply: an exact fragment found once, a replacement that keeps it and only adds the call."""
    out: dict[str, str] = {}
    for e in (edits or [])[:6]:
        if not isinstance(e, dict):
            continue
        p, find, rep = e.get("path"), e.get("find") or "", e.get("replace") or ""
        text = out.get(p, files.get(p))
        if text is None or not find or text.count(find) != 1 or "identify" not in rep or "tably" not in rep:
            continue
        added = rep.replace(find, "") if find in rep else rep
        if re.search(r"password|passwd|contrase|token|secret", added, re.I):
            continue
        out[p] = text.replace(find, rep, 1)
    return out


def _excerpt(text: str, limit: int = 14000) -> str:
    """A big file as the pieces around its sign-in code (the model copies its edits from these, so they stay exact)."""
    if len(text) <= limit:
        return text
    spans: list[list[int]] = []
    for m in AUTH_CODE.finditer(text):
        a, b = max(0, m.start() - 1200), min(len(text), m.end() + 1200)
        if spans and a <= spans[-1][1]:
            spans[-1][1] = b
        else:
            spans.append([a, b])
    out, n = [], 0
    for a, b in spans:
        if n + (b - a) > limit:
            break
        out.append(text[a:b])
        n += b - a
    return "\n/* … */\n".join(out) or text[:limit]


async def identify_pr(site: dict, token: str, user_id: str) -> dict:
    """A PR that tells Tably Analytics who signed in: the model finds the app's login and adds tably.identify({ email, name, id })."""
    import asyncio

    from . import studio as studiomod

    m = REPO_RX.match(site.get("repo") or "")
    if not m:
        return {"ok": False, "error": "Falta el link del repositorio de GitHub"}
    own, name = m.group(1), m.group(2)
    code, repo = await asyncio.to_thread(_gh, "GET", f"/repos/{own}/{name}", token)
    if code == 401:
        return {"ok": False, "error": BAD_TOKEN}
    if code != 200 or not isinstance(repo, dict):
        return {"ok": False, "error": f"No pude leer {own}/{name} en GitHub"}
    base = repo.get("default_branch") or "main"
    code, ref = await asyncio.to_thread(_gh, "GET", f"/repos/{own}/{name}/git/ref/heads/{base}", token)
    if code != 200:
        return {"ok": False, "error": f"No pude leer la rama {base} del repo"}
    head_sha = ref["object"]["sha"]
    found = await asyncio.to_thread(_auth_files, own, name, base, head_sha, token)
    if not found:
        return {"ok": False, "error": f"No encontré un inicio de sesión en {own}/{name}. Si tu app tiene usuarios en otro repo, conectá ese repo al sitio."}
    msg = "\n\n".join(f"=== {p} ===\n{_excerpt(t)}" for p, t in found)
    raw, by = await studiomod.ask(user_id, ID_SYSTEM, f"App: {site['title']} ({own}/{name})\n\n{msg}", max_tokens=6000)
    changes = apply_edits(dict(found), raw.get("edits"))
    if not changes:
        return {"ok": False, "error": "No pude agregarlo solo: " + (str(raw.get("summary") or "no encontré dónde la app sabe quién inició sesión."))[:300]}
    files = "\n".join(f"- `{p}`" for p in changes)
    body = (f"Para que **Tably Analytics** muestre el email y el nombre de quienes inician sesión en {site['title']}.\n\n"
            f"{raw.get('summary') or ''}\n\nAgrega `tably.identify({{ email, name, id }})` donde la app ya sabe quién es el usuario. No manda contraseñas ni tokens.\n\n"
            f"Archivos:\n{files}\n\nRecordá mencionar en tu política de privacidad que, para usuarios registrados, se registran su email y nombre junto a sus visitas.\n\n_Escrito por {by}._")
    return await asyncio.to_thread(_push, own, name, base, head_sha, changes, token, ID_BRANCH, "Tably Analytics: identificar a quien inicia sesión", "Tably Analytics: quién inició sesión", body)


# ------------------------------------------------------------------------------------------------ is it connected?

def hits(slug: str) -> int:
    with _db() as c:
        return c.execute("SELECT COUNT(*) FROM analytics_hits WHERE site = ? AND kind != 'ping'", (slug,)).fetchone()[0]


async def check(site: dict, collector: str) -> dict:
    """Visits that arrived, and whether the page online loads the snippet (an app that adds it from JS only shows up with visits)."""
    n, online = hits(site["slug"]), None
    if site.get("url"):
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 TablyCheck"}) as cx:
                r = await cx.get(site["url"])
            online = bool(re.search(rf'data-site=["\']{re.escape(site["slug"])}["\']', r.text[:600_000])) if r.status_code < 400 else None
        except httpx.HTTPError:
            online = None
    return {"hits": n, "online": online, "connected": n > 0}


# ------------------------------------------------------------------------------------------------ the npm package

def package(slug: str, collector: str) -> bytes:
    """`tably-analytics` with this site and collector inside: import it once and the app reports to Tably; or run it with
    npx in the project folder and it writes the script tag into the pages."""
    cfg = json.dumps({"site": slug, "base": collector})
    core = f"""var CFG = {cfg};
var queue = [];
function ready() {{ return typeof window !== 'undefined' && window.tably && typeof window.tably.track === 'function'; }}
function flush() {{ while (queue.length && ready()) {{ var c = queue.shift(); window.tably[c[0]].apply(null, c[1]); }} }}
function load() {{
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.querySelector('script[data-site][src$="/a.js"]')) {{ flush(); return; }}
  var s = document.createElement('script');
  s.defer = true; s.src = CFG.base + '/a.js'; s.setAttribute('data-site', CFG.site);
  s.onload = flush;
  (document.head || document.documentElement).appendChild(s);
}}
function call(name, args) {{ if (ready()) window.tably[name].apply(null, args); else queue.push([name, args]); }}
function track(name, props) {{ call('track', [name, props]); }}
function identify(user) {{ call('identify', [user]); }}
function variant(name, options) {{ return ready() && window.tably.variant ? window.tably.variant(name, options) : (options && options[0]); }}
function init() {{ load(); }}
load();
"""
    mjs = core + "export { init, track, identify, variant };\nexport default { init, track, identify, variant };\n"
    cjs = core + "module.exports = { init: init, track: track, identify: identify, variant: variant };\nmodule.exports.default = module.exports;\n"
    dts = """export declare function init(): void;
/** An action that matters (sign up, buy, book…). It shows up in Tably → Analytics → Events. */
export declare function track(name: string, props?: Record<string, unknown>): void;
/** Who the signed-in visitor is, so Analytics shows people by name. */
export declare function identify(user: { email?: string; name?: string; id?: string }): void;
/** A/B test: a stable variant per visitor. */
export declare function variant<T extends string>(name: string, options: T[]): T;
declare const _default: { init: typeof init; track: typeof track; identify: typeof identify; variant: typeof variant };
export default _default;
"""
    bin_js = r"""#!/usr/bin/env node
// Writes the Tably Analytics script tag into this project's pages (index.html, templates, Next.js layout/_document).
var fs = require('fs'), path = require('path');
var CFG = __CFG__;
var TAG = '<script defer src="' + CFG.base + '/a.js" data-site="' + CFG.site + '"></script>';
var SKIP = __SKIP__;
var EXT = __EXT__;
var LAYOUT = /^(?:src\/)?app\/layout\.(?:tsx|jsx|ts|js)$/, DOC = /^(?:src\/)?pages\/_document\.(?:tsx|jsx|ts|js)$/;
var OLD = /<script[^>]*src=["'][^"']*\/a\.js["'][^>]*data-site=["'][^"']*["'][^>]*>\s*<\/script>/i;
var GENDIRS = __GENDIRS__, SHELL = /^_?(index|base|layout|_layout|app|main|default|master|document)\./i;
var SIDE = /^(docs?|examples?|demos?|samples?|playground|[\w.-]+-examples?)$/i;
function side(r) { return r.split('/').slice(0, -1).some(function (x) { return SIDE.test(x); }); }
function GEN(r) { var parts = r.split('/'), name = parts.pop(); return /\d{4}-\d{2}-\d{2}|\d{8,}|e-?mail|newsletter|correo|pdf|report|invoice|factura|carta/i.test(name) || parts.some(function (x) { return GENDIRS.indexOf(x.toLowerCase()) >= 0; }); }
var root = process.cwd(), files = [], code = [], CODE = /\.(m?js|cjs|ts|jsx|tsx|py|rb|go|php|java|cs|vue|svelte)$/i;
(function walk(dir, rel) {
  var list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  list.forEach(function (d) {
    var r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) { if (SKIP.indexOf(d.name) < 0 && !/^e-?mails?$|^mail$/i.test(d.name)) walk(path.join(dir, d.name), r); }
    else if (!GEN(r) && (LAYOUT.test(r) || DOC.test(r) || EXT.some(function (e) { return d.name.toLowerCase().endsWith(e); }))) files.push(r);
    else if (!GEN(r) && CODE.test(d.name) && !/(\.test|\.spec|\.d)\./.test(d.name) && !/(^|\/)(scripts|migrations|seeders|seeds)\//.test(r)) code.push(r);
  });
})(root, '');
// every screen loads the shell (index.html, a base template, the Next.js layout): when there is one, only the shells get the tag
var main = files.filter(function (r) { return !side(r); }); if (main.length) files = main;
code = code.filter(function (r) { return !side(r); });
var shells = files.filter(function (r) { return LAYOUT.test(r) || DOC.test(r) || SHELL.test(r.split('/').pop()); });
if (shells.length) files = shells;
var changed = [], already = [];
files.forEach(function (r) {
  var f = path.join(root, r), t = fs.readFileSync(f, 'utf8'), n = null;
  if (t.indexOf(TAG) >= 0) { already.push(r); return; }
  if (OLD.test(t)) n = t.replace(OLD, TAG);
  else if (DOC.test(r)) n = /<Head\s*\/>/.test(t) ? t.replace(/<Head\s*\/>/, '<Head>' + TAG + '</Head>') : (t.indexOf('</Head>') >= 0 ? t.replace('</Head>', '  ' + TAG + '\n        </Head>') : null);
  else if (LAYOUT.test(r)) n = t.indexOf('</head>') >= 0 ? t.replace('</head>', '  ' + TAG + '\n      </head>') : t.replace(/<html\b[^>]*>/, function (m) { return m + '\n      <head>' + TAG + '</head>'; });
  else if (/<\/head\s*>/i.test(t)) n = t.replace(/[ \t]*<\/head\s*>/i, function (m) { var pad = m.match(/^[ \t]*/)[0]; return pad + '  ' + TAG + '\n' + m; });
  if (n && n !== t) { fs.writeFileSync(f, n); changed.push(r); }
});
// backends that write their pages from code: a </head> that closes a real <head> inside an HTML string
code.forEach(function (r) {
  var f = path.join(root, r), t;
  try { t = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
  if (!/<html|<!doctype/i.test(t) || !/<\/head\s*>/i.test(t)) return;
  if (t.indexOf(TAG) >= 0 || t.indexOf(TAG.replace(/"/g, "'")) >= 0) { already.push(r); return; }
  var out = '', last = 0, n = 0, re = /<\/head\s*>/gi, m;
  while ((m = re.exec(t))) {
    if ("'\"`".indexOf(t[m.index - 1]) >= 0 || t.slice(Math.max(0, m.index - 4000), m.index).toLowerCase().indexOf('<head') < 0) continue;
    var line = t.slice(t.lastIndexOf('\n', m.index) + 1, m.index);
    out += t.slice(last, m.index) + ((line.split('"').length - 1) % 2 ? TAG.replace(/"/g, "'") : TAG); last = m.index; n++;
  }
  if (n) { fs.writeFileSync(f, out + t.slice(last)); changed.push(r); }
});
if (!changed.length && already.length) {
  console.log('\nTably Analytics ya estaba en:\n' + already.map(function (c) { return '  - ' + c; }).join('\n') + '\n');
  process.exit(0);
}
if (!changed.length) {
  console.log('\nNo encontré dónde poner Tably Analytics (ni un index.html ni un layout de Next.js).');
  console.log('Pegá esta línea dentro del <head> de tu página:\n\n  ' + TAG + '\n');
  process.exit(1);
}
console.log('\nTably Analytics quedó en:\n' + changed.map(function (c) { return '  - ' + c; }).join('\n'));
console.log('\nHacé commit y push; cuando se despliegue, las visitas aparecen en Tably → Analíticas.\n');
"""
    bin_js = bin_js.replace("__CFG__", cfg).replace("__SKIP__", json.dumps(sorted(SKIP_DIRS))).replace("__EXT__", json.dumps(list(PAGE_EXT))).replace("__GENDIRS__", json.dumps(sorted(GENERATED_DIRS)))
    readme = f"""# tably-analytics

Tably Analytics for **{slug}**: visits, where they come from, what people tap, who is live and errors. No cookies.

```js
import 'tably-analytics'            // once, in your entry file (main.ts / main.tsx / app root)
import {{ track, identify }} from 'tably-analytics'
identify({{ email, name, id }})       // where you know who signed in
track('signup')                     // the actions that matter
```

Or, without the dependency: `npx -y {collector}/pkg/tably-analytics-{slug}.tgz` in the project folder writes
`{tag(collector, slug)}` into your pages.
"""
    pkg = {"name": "tably-analytics", "version": "1.0.0", "description": f"Tably Analytics for {slug}", "license": "MIT",
           "main": "index.cjs", "module": "index.mjs", "types": "index.d.ts", "sideEffects": True,
           "exports": {".": {"types": "./index.d.ts", "import": "./index.mjs", "require": "./index.cjs"}},
           "bin": {"tably-analytics": "bin/connect.cjs"}}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text, mode in (("package.json", json.dumps(pkg, indent=2), 0o644), ("index.mjs", mjs, 0o644), ("index.cjs", cjs, 0o644),
                                 ("index.d.ts", dts, 0o644), ("bin/connect.cjs", bin_js, 0o755), ("README.md", readme, 0o644)):
            data = text.encode()
            info = tarfile.TarInfo(f"package/{name}")
            info.size, info.mode, info.mtime = len(data), mode, 1_700_000_000
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ------------------------------------------------------------------------------------------------ picking the repo from GitHub

def repos(token: str) -> dict:
    """The user's repos they can push to, most recently pushed first: picking one fills the connect form."""
    code, me = _gh("GET", "/user", token)
    if code != 200:
        return {"ok": False, "error": "GitHub no aceptó el token: creá uno nuevo con permiso «repo»" if code in (401, 403) else "No pude hablar con GitHub"}
    out: list[dict] = []
    for page in (1, 2, 3):
        code, rs = _gh("GET", f"/user/repos?per_page=100&sort=pushed&page={page}&affiliation=owner,collaborator,organization_member", token)
        if code != 200 or not isinstance(rs, list):
            break
        out += [{"full_name": r["full_name"], "name": r["name"], "url": r["html_url"], "homepage": (r.get("homepage") or "").strip() or None,
                 "private": bool(r.get("private")), "pushed_at": r.get("pushed_at")}
                for r in rs if (r.get("permissions") or {}).get("push") and not r.get("archived")]
        if len(rs) < 100:
            break
    return {"ok": True, "login": me.get("login"), "repos": out}


def live_url(token: str, repo: str) -> str | None:
    """Where the repo is online: its «website» on GitHub, or the address its host (Railway, Vercel, Netlify…) reports on deploys."""
    m = REPO_RX.match(repo or "")
    if not m:
        return None
    own, name = m.group(1), m.group(2)
    code, r = _gh("GET", f"/repos/{own}/{name}", token)
    if code == 200 and (r.get("homepage") or "").strip():
        return r["homepage"].strip()
    for path in ("CNAME", "public/CNAME", "package.json"):  # GitHub Pages / a «homepage» in package.json
        code, f = _gh("GET", f"/repos/{own}/{name}/contents/{path}", token)
        if code != 200 or not isinstance(f, dict) or not f.get("content"):
            continue
        txt = base64.b64decode(f["content"]).decode("utf-8", "ignore")
        if path == "package.json":
            try:
                txt = str(json.loads(txt).get("homepage") or "")
            except ValueError:
                continue
        u = txt.strip().splitlines()[0].strip() if txt.strip() else ""
        if re.match(r"^(https?://)?[\w.-]+\.[a-z]{2,}(/\S*)?$", u, re.I) and "github.com" not in u:
            return (u if u.startswith("http") else "https://" + u).rstrip("/")
    code, deps = _gh("GET", f"/repos/{own}/{name}/deployments?per_page=15", token)
    if code != 200 or not isinstance(deps, list):
        return None
    # production first, then whatever deployed most recently
    deps.sort(key=lambda d: 0 if re.search(r"prod", d.get("environment") or "", re.I) else 1)
    for d in deps:
        code, sts = _gh("GET", f"/repos/{own}/{name}/deployments/{d['id']}/statuses?per_page=5", token)
        for s in sts if code == 200 and isinstance(sts, list) else []:
            u = (s.get("environment_url") or s.get("target_url") or "").strip()
            if u.startswith("http") and not re.search(r"railway\.(app|com)/project|vercel\.com/|app\.netlify\.com|github\.com", u):
                return u.rstrip("/")
    return None



# ------------------------------------------------------------------------------------------------ finding the repo that serves the site

def _title(html: str) -> str:
    m = re.search(r"<title[^>]*>([^<]{3,})</title", html or "", re.I)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def repo_for_url(token: str, url: str, skip: str = "") -> str | None:
    """Which of the user's repos serves `url`: the one whose page (index.html, a base template…) has the same <title> as the live site."""
    try:
        live = httpx.get(url, timeout=20, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 tablyteam"}).text
    except httpx.HTTPError:
        return None
    want = _title(live)
    if not want:
        return None
    for r in (repos(token).get("repos") or [])[:60]:
        if r["url"].lower() == (skip or "").lower():
            continue
        own, name = r["full_name"].split("/", 1)
        code, info = _gh("GET", f"/repos/{own}/{name}", token)
        base = info.get("default_branch") if code == 200 and isinstance(info, dict) else None
        if not base:
            continue
        for p in candidates(_paths(own, name, base, token) or [])[:4]:
            code, f = _gh("GET", f"/repos/{own}/{name}/contents/{p}?ref={base}", token)
            if code == 200 and isinstance(f, dict) and f.get("content"):
                if _title(base64.b64decode(f["content"]).decode("utf-8", "ignore")) == want:
                    return r["url"]
    return None


def connect_pr(site: dict, token: str, collector: str) -> dict:
    """The PR on the site's repo; when that repo has no page (a backend, say), Tably finds the repo that serves the site and uses it."""
    res = open_pr(site, token, collector)
    if res.get("code") != "no_pages" or not site.get("url"):
        return res
    other = repo_for_url(token, site["url"], skip=site.get("repo") or "")
    if not other:
        return {**res, "error": res["error"] + " Tampoco encontré entre tus repos el que sirve " + site["url"] + ": usá el comando o el paquete de abajo."}
    res = open_pr({**site, "repo": other}, token, collector)
    if res.get("ok"):
        res["repo"] = other
    return res
