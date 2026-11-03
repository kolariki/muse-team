"""External services checklist + one-click deploy (Vercel / Railway) for a built project.

Services: derived deterministically from the project's `.env.example` (+ the brief's "6.1" table when present)
and a catalogue of well-known variables, so the user sees every key/service the app needs, where to get it,
and can fill the values (stored encrypted per build; never returned to the browser).

Deploy: runs the official CLIs in the project folder with the user's token (or the CLI's own login), passing
the saved values as environment variables. Logs stream to the builder UI.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Awaitable, Callable

from .auth import _db
from .keystore import _fernet, get_key
from .local_engine import BUILD_ROOT, SKIP_DIRS

with _db() as _c:
    _c.execute("CREATE TABLE IF NOT EXISTS build_secrets (user_id TEXT NOT NULL, build_id TEXT NOT NULL, var TEXT NOT NULL, enc BLOB NOT NULL, updated REAL NOT NULL, PRIMARY KEY (user_id, build_id, var))")

# ------------------------------------------------------------------ catalogue of well-known variables
KNOWN: list[tuple[str, str, str, str]] = [  # (regex on var name, service, where to get it, purpose)
    (r"^(NEXT_PUBLIC_)?SUPABASE_", "Supabase", "https://supabase.com/dashboard/project/_/settings/api", "Base de datos Postgres, auth y storage"),
    (r"^DATABASE_URL$|^POSTGRES", "Postgres", "https://neon.tech (gratis) · https://railway.com · Supabase", "Conexión a la base de datos"),
    (r"^STRIPE_", "Stripe", "https://dashboard.stripe.com/apikeys", "Pagos"),
    (r"^MERCADOPAGO|^MP_", "Mercado Pago", "https://www.mercadopago.com.ar/developers/panel/app", "Pagos (LatAm)"),
    (r"^PAYPAL_", "PayPal", "https://developer.paypal.com/dashboard/applications", "Pagos"),
    (r"^OPENAI_", "OpenAI", "https://platform.openai.com/api-keys", "Modelos de IA"),
    (r"^ANTHROPIC_", "Anthropic", "https://console.anthropic.com/settings/keys", "Modelos de IA (Claude)"),
    (r"^GEMINI_|^GOOGLE_(GENERATIVE|AI)", "Google AI Studio", "https://aistudio.google.com/apikey", "Modelos de IA (Gemini)"),
    (r"^GOOGLE_(CLIENT|OAUTH)", "Google Cloud (OAuth)", "https://console.cloud.google.com/apis/credentials", "Login con Google"),
    (r"^GOOGLE_MAPS|^MAPS_API", "Google Maps", "https://console.cloud.google.com/google/maps-apis/credentials", "Mapas"),
    (r"^MAPBOX_", "Mapbox", "https://account.mapbox.com/access-tokens/", "Mapas"),
    (r"^GITHUB_(CLIENT|TOKEN|APP)", "GitHub", "https://github.com/settings/developers", "Login / API de GitHub"),
    (r"^NEXTAUTH_SECRET$|^AUTH_SECRET$|^JWT_SECRET$|^SESSION_SECRET$|^SECRET_KEY$|^ENCRYPTION_KEY$", "Secreto propio", "generalo: `openssl rand -hex 32`", "Firma de sesiones/tokens (no es un servicio)"),
    (r"^NEXTAUTH_URL$|^APP_URL$|^NEXT_PUBLIC_(APP|SITE|BASE)_URL$|^PUBLIC_URL$", "URL de la app", "la URL que te da el deploy (Vercel/Railway)", "URL pública de la aplicación"),
    (r"^CLERK_|^NEXT_PUBLIC_CLERK", "Clerk", "https://dashboard.clerk.com", "Autenticación de usuarios"),
    (r"^AUTH0_", "Auth0", "https://manage.auth0.com", "Autenticación"),
    (r"^FIREBASE_|^NEXT_PUBLIC_FIREBASE", "Firebase", "https://console.firebase.google.com", "Backend/auth/notificaciones"),
    (r"^RESEND_", "Resend", "https://resend.com/api-keys", "Envío de emails"),
    (r"^SENDGRID_", "SendGrid", "https://app.sendgrid.com/settings/api_keys", "Envío de emails"),
    (r"^SMTP_|^MAIL_", "SMTP", "tu proveedor de correo (Gmail, Resend, Mailgun…)", "Envío de emails"),
    (r"^TWILIO_", "Twilio", "https://console.twilio.com", "SMS / WhatsApp"),
    (r"^AWS_|^S3_", "AWS / S3", "https://console.aws.amazon.com/iam", "Storage / servicios AWS"),
    (r"^CLOUDINARY_", "Cloudinary", "https://console.cloudinary.com/settings/api-keys", "Imágenes"),
    (r"^UPLOADTHING_", "UploadThing", "https://uploadthing.com/dashboard", "Subida de archivos"),
    (r"^REDIS_|^UPSTASH_|^KV_", "Redis (Upstash)", "https://console.upstash.com", "Cache / colas"),
    (r"^SENTRY_", "Sentry", "https://sentry.io/settings/", "Monitoreo de errores"),
    (r"^POSTHOG_|^NEXT_PUBLIC_POSTHOG", "PostHog", "https://app.posthog.com/project/settings", "Analítica de producto"),
    (r"^LANGFUSE_", "Langfuse", "https://cloud.langfuse.com", "Observabilidad de LLM"),
    (r"^VERCEL_", "Vercel", "https://vercel.com/account/tokens", "Hosting"),
    (r"^RAILWAY_", "Railway", "https://railway.com/account/tokens", "Hosting"),
    (r"^(CF_|CLOUDFLARE_)?TURNSTILE_", "Cloudflare Turnstile", "https://dash.cloudflare.com/?to=/:account/turnstile", "Captcha invisible contra bots"),
    (r"^RECAPTCHA_|^HCAPTCHA_", "Captcha", None, "Captcha contra bots"),
    (r"^TRIGGER_", "Trigger.dev", "https://cloud.trigger.dev", "Tareas programadas"),
    (r"^SLACK_", "Slack", "https://api.slack.com/apps", "Alertas por Slack"),
    (r"^DISCORD_", "Discord", "https://discord.com/developers/applications", "Alertas por Discord"),
    (r"^POSTMARK_", "Postmark", "https://account.postmarkapp.com/servers", "Envío de emails"),
    (r"^MAILGUN_", "Mailgun", "https://app.mailgun.com/settings/api_security", "Envío de emails"),
    (r"^(EMAIL|MAIL)_FROM$|^FROM_EMAIL$|^EMAIL_SENDER$", "Remitente de emails", None, "Desde qué dirección salen los emails"),
    (r"^CLOUDFLARE_|^CF_", "Cloudflare", "https://dash.cloudflare.com/profile/api-tokens", "Hosting / Workers / DNS"),
    (r"^NOMINATIM|^OPENCAGE|^GEOCOD", "Geocoding", None, "Direcciones ↔ coordenadas"),
    (r"^OPENWEATHER|^WEATHER", "OpenWeather", "https://home.openweathermap.org/api_keys", "Datos de clima"),
    (r"^(PORT|NODE_ENV|HOST|LOG_LEVEL|TZ|VITE_PORT)$", "Configuración local", "no requiere cuenta", "Parámetros de ejecución"),
]

_GENERIC = {"API", "APP", "BASE", "PUBLIC", "SERVER", "SERVICE", "CLIENT", "WEB", "NEXT", "VITE", "EXPO", "REACT"}


def _service_name(var: str) -> str:
    """CLOUDFLARE_API_TOKEN → Cloudflare; VITE_API_BASE_URL → API base; PARAGUAS_TERMS_CONFIRMED → Paraguas."""
    raw = [p for p in re.sub(r"^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_)", "", var).split("_") if p]
    parts = [p for p in raw if p not in ("KEY", "SECRET", "TOKEN", "URL", "ID", "DSN", "CONFIRMED", "ENABLED")] or raw
    # two words read as a name ("API base", "Allowed origins", "Contact email"); one would be a bare adjective
    words = parts[:2] if len(parts) > 1 else raw[:2]
    return " ".join(w.upper() if w == "API" else (w.title() if i == 0 else w.lower()) for i, w in enumerate(words))


def _clean_note(note: str) -> str:
    """Comment banners (----- Deploy -----) become plain text; runs of dashes/equals disappear."""
    note = re.sub(r"[-=_#]{3,}", " ", note)
    return " ".join(note.split()).strip(" ·:-")


def classify(var: str) -> dict:
    for rx, service, url, purpose in KNOWN:
        if re.search(rx, var, re.I):
            return {"service": service, "url": url, "purpose": purpose}
    return {"service": _service_name(var) or "Servicio", "url": None, "purpose": None}


def parse_env_example(text: str) -> list[dict]:
    out, comment = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            comment = []
            continue
        if line.startswith("#"):
            comment.append(line.lstrip("# ").strip())
            continue
        m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m:
            continue
        var, val = m.group(1), m.group(2)
        inline = ""
        if "#" in val and not val.startswith(("'", '"')):
            val, inline = val.split("#", 1)
            val, inline = val.strip(), inline.strip()
        val = val.strip().strip("'\"")
        out.append({"var": var, "example": val, "note": _clean_note(" ".join(comment + ([inline] if inline else [])))})
        comment = []
    return out


def parse_brief_services(brief: str) -> dict[str, dict]:
    """Rows of the brief's '6.1 Cuentas y API keys' table: Servicio | Para qué | Dónde | Variable | Costo."""
    out: dict[str, dict] = {}
    sec = re.split(r"(?:^|\n)###?\s*6\.1[^\n]*", brief)
    if len(sec) < 2:
        return out
    body = re.split(r"\n###?\s", sec[1])[0]
    for line in body.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or set(cells[0]) <= {"-", ":", " "} or cells[0].lower().startswith(("servicio", "service")):
            continue
        for var in re.findall(r"[A-Z][A-Z0-9_]{2,}", cells[3]):
            out[var] = {"service": cells[0], "purpose": cells[1], "url": re.sub(r"[<>]", "", cells[2]), "cost": cells[4] if len(cells) > 4 else None}
    return out


# ------------------------------------------------------------------ what the app really needs (and what Muse Team solves by itself)
# Muse Team provides these itself: the database when publishing, the app's own URL, the hosting, the data folder, its own secrets
AUTO_VAR = re.compile(r"^(DATABASE_URL|POSTGRES\w*|PG(HOST|PORT|USER|PASSWORD|DATABASE)|PGLITE_\w+|DATA_DIR|SQLITE_\w+|DB_PATH|DATABASE_PATH|"
                      r"PORT|HOST|NODE_ENV|TZ|LOG_LEVEL|VITE_PORT|(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_)?(APP|API|SITE|BASE|PUBLIC|WEB|FRONTEND|BACKEND|SERVER)(_BASE)?_URL|"
                      r"NEXTAUTH_URL|VERCEL_\w+|RAILWAY_\w+|NETLIFY_\w+|FLY_\w+|CLOUDFLARE_(API_TOKEN|ACCOUNT_ID))$")
INTERNAL_SECRET = re.compile(r"(^|_)(SECRET|SECRET_KEY|TOKEN|SALT|PEPPER|SIGNING_KEY|ENCRYPTION_KEY|COOKIE_KEY)$")
_AUTO_SERVICES = {"Postgres", "Secreto propio", "URL de la app", "Configuración local", "Vercel", "Railway"}
# the app works without these (it simulates or skips them): improvements, not requirements
OPTIONAL_HINT = re.compile(r"sentry|posthog|langfuse|slack|discord|datadog|logtail|better ?stack|anal[ií]tic|analytics|monitor|alerta|alert|redis|upstash|\bkv\b|"
                           r"rate.?limit|turnstile|captcha|trigger\.dev|\bcron\b|opcional|optional|errores$|error tracking", re.I)
IMPACT: list[tuple[str, str, str]] = [  # (pattern over the service, its purpose and its variables, kind, what does not work while it is missing)
    (r"MP_|MERCADO|STRIPE|PAYPAL|LEMON|PADDLE|pago|cobro|payment|checkout|seña", "payments", "Los cobros son de prueba: nadie puede pagar de verdad."),
    (r"RESEND|SENDGRID|POSTMARK|MAILGUN|SMTP|MAIL_|EMAIL", "email", "La app no manda emails: ni confirmaciones, ni recordatorios, ni recuperar la contraseña."),
    (r"TWILIO|WHATSAPP|SMS", "sms", "No se mandan SMS ni WhatsApp."),
    (r"OPENAI|ANTHROPIC|GEMINI|GOOGLE_(GENERATIVE|AI)|MISTRAL|GROQ|\bIA\b|\bAI\b", "ai", "Las funciones con inteligencia artificial no responden."),
    (r"GOOGLE_(CLIENT|OAUTH)|GITHUB_CLIENT|OAUTH|CLERK|AUTH0|FIREBASE|login", "auth", "No funciona entrar con Google u otras cuentas."),
    (r"MAPS|MAPBOX|GEOCOD", "maps", "Los mapas y las direcciones no cargan."),
    (r"CLOUDINARY|UPLOADTHING|S3_|AWS_|STORAGE|BUCKET", "storage", "No se pueden subir archivos ni imágenes."),
]


def _tier(item: dict) -> tuple[str, str]:
    """needed (the app does not work fully without it) · auto (Muse Team provides it) · optional (an improvement). With the reason."""
    var, svc = item["var"], item["service"]
    text = f"{svc} {item.get('purpose') or ''} {item.get('note') or ''}"
    if svc in _AUTO_SERVICES or AUTO_VAR.search(var):
        why = ("La base de datos la crea Muse Team al publicar." if re.search(r"DATABASE|POSTGRES|^PG", var) else
               "La guarda Muse Team en su disco." if re.search(r"DIR$|PATH$|SQLITE|PGLITE", var) else
               "La completa Muse Team con la dirección de tu app al publicarla." if re.search(r"URL$", var) else
               "La hospeda Muse Team: no hace falta." if re.search(r"^(VERCEL|RAILWAY|NETLIFY|FLY|CLOUDFLARE)_", var) else "No requiere nada.")
        return "auto", why
    if INTERNAL_SECRET.search(var) and classify(var)["service"] in ("Secreto propio",) or (INTERNAL_SECRET.search(var) and not classify(var)["url"] and not any(re.search(rx, var, re.I) for rx, *_ in KNOWN)):
        return "auto", "Un secreto propio de la app: Muse Team lo genera solo."
    if OPTIONAL_HINT.search(text) or OPTIONAL_HINT.search(var):
        return "optional", ""
    return "needed", ""


def _impact(group: dict) -> tuple[str, str]:
    text = " ".join([group["service"], group.get("purpose") or "", *[v["var"] for v in group["vars"]]])
    for rx, kind, msg in IMPACT:
        if re.search(rx, text, re.I):
            return kind, msg
    return "other", (f"Sin esto no funciona: {group['purpose'].lower()}." if group.get("purpose") else "Una parte de la app no va a funcionar completa.")


def _group(service: str, vs: list[dict]) -> dict:
    g = {"service": service, "url": next((v["url"] for v in vs if v["url"]), None), "purpose": next((v["purpose"] for v in vs if v["purpose"]), None), "vars": vs}
    tiers = {v["tier"] for v in vs}
    g["tier"] = "needed" if "needed" in tiers else "optional" if "optional" in tiers else "auto"
    g["kind"], g["impact"] = _impact(g)
    return g


def services_for(files: dict[str, str], brief: str, saved: set[str]) -> dict:
    env = parse_env_example(files.get(".env.example") or files.get(".env.sample") or files.get("env.example") or "")
    from_brief = parse_brief_services(brief or "")
    seen = {e["var"] for e in env}
    for var, meta in from_brief.items():  # variables the brief lists but .env.example forgot
        if var not in seen:
            env.append({"var": var, "example": "", "note": meta.get("purpose") or ""})
    items = []
    for e in env:
        k = classify(e["var"])
        b = from_brief.get(e["var"], {})
        public = e["var"].startswith(("NEXT_PUBLIC_", "VITE_", "PUBLIC_", "EXPO_PUBLIC_"))
        local = k["service"] == "Configuración local"
        items.append({
            "var": e["var"], "service": b.get("service") or k["service"], "purpose": b.get("purpose") or k["purpose"] or e["note"] or None,
            "url": b.get("url") or k["url"], "cost": b.get("cost"), "example": e["example"], "note": e["note"] or None,
            "public": public, "required": not local, "secret": not public and not local, "configured": e["var"] in saved,
        })
    for it in items:
        it["tier"], it["auto_reason"] = _tier(it)
        if it["tier"] != "needed":
            it["required"] = False
    # the sender address goes with the email service it belongs to
    mailer = next((it["service"] for it in items if re.search(r"RESEND|SENDGRID|POSTMARK|MAILGUN|SMTP", it["var"])), None)
    for it in items:
        if mailer and it["service"] == "Remitente de emails":
            it["service"] = mailer
    # group by service for the UI
    groups: dict[str, list[dict]] = {}
    for it in items:
        groups.setdefault(it["service"], []).append(it)
    stack = []
    if "package.json" in files:
        try:
            deps = {**json.loads(files["package.json"]).get("dependencies", {}), **json.loads(files["package.json"]).get("devDependencies", {})}
            stack = [d for d in ("next", "react", "vite", "express", "fastify", "hono", "nuxt", "svelte", "@supabase/supabase-js", "prisma", "drizzle-orm") if d in deps]
        except Exception:
            pass
    elif "pyproject.toml" in files or "requirements.txt" in files:
        stack = ["python"]
    return {
        "items": items, "groups": [_group(s, v) for s, v in groups.items()],
        "missing": [i["var"] for i in items if i["required"] and not i["configured"]], "stack": stack,
        "recommended_target": "vercel" if any(s in stack for s in ("next", "vite", "react", "nuxt", "svelte")) and not any(s in stack for s in ("express", "fastify", "hono", "python")) else "railway",
    }


# ------------------------------------------------------------------ per-build secrets (encrypted)

def save_secrets(user_id: str, build_id: str, values: dict[str, str]) -> None:
    with _db() as c:
        for var, val in values.items():
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", var):
                continue
            if val is None or val == "":
                c.execute("DELETE FROM build_secrets WHERE user_id=? AND build_id=? AND var=?", (user_id, build_id, var))
            else:
                c.execute("INSERT OR REPLACE INTO build_secrets VALUES (?, ?, ?, ?, ?)", (user_id, build_id, var, _fernet.encrypt(val.encode()), time.time()))


def load_secrets(user_id: str, build_id: str) -> dict[str, str]:
    with _db() as c:
        rows = c.execute("SELECT var, enc FROM build_secrets WHERE user_id=? AND build_id=?", (user_id, build_id)).fetchall()
    out = {}
    for r in rows:
        try:
            out[r["var"]] = _fernet.decrypt(r["enc"]).decode()
        except Exception:
            continue
    return out


def render_env(values: dict[str, str], files: dict[str, str]) -> str:
    """A .env with the saved values, keeping the order/comments of .env.example."""
    lines = []
    example = files.get(".env.example") or ""
    done = set()
    for raw in example.splitlines():
        m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", raw.strip())
        if m and m.group(1) in values:
            lines.append(f"{m.group(1)}={values[m.group(1)]}")
            done.add(m.group(1))
        else:
            lines.append(raw)
    for k, v in values.items():
        if k not in done:
            lines.append(f"{k}={v}")
    return "\n".join(lines).rstrip() + "\n"


# ------------------------------------------------------------------ deploy

TARGETS = {
    "vercel": {"label": "Vercel", "bin": "vercel", "token_help": "https://vercel.com/account/tokens", "good_for": "frontends y apps Next.js/Vite (sin servidor propio)", "good_for_en": "frontends and Next.js/Vite apps (no server of their own)"},
    "railway": {"label": "Railway", "bin": "railway", "token_help": "https://railway.com/account/tokens", "good_for": "backends, APIs y apps con base de datos", "good_for_en": "backends, APIs and apps with a database"},
}

Log = Callable[[str], Awaitable[None] | None]


def _run_sync(cmd: list[str], env: dict | None = None, timeout: float = 20) -> tuple[int, str]:
    import subprocess

    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:
        return 1, str(e)


def deploy_status(user_id: str) -> list[dict]:
    out = []
    for tid, t in TARGETS.items():
        path = shutil.which(t["bin"])
        token = get_key(user_id, tid)
        st = {"id": tid, "label": t["label"], "installed": bool(path), "token": bool(token), "logged_in": False, "good_for": t["good_for"], "good_for_en": t.get("good_for_en"), "token_help": t["token_help"], "hint": None, "hint_en": None}
        if not path:
            st["hint"] = f"Instalá el CLI: npm i -g {'vercel' if tid == 'vercel' else '@railway/cli'}"
            st["hint_en"] = f"Install the CLI: npm i -g {'vercel' if tid == 'vercel' else '@railway/cli'}"
        elif token:
            st["logged_in"] = True
        else:
            env = dict(os.environ)
            code, txt = _run_sync([path, "whoami"], env=env)
            st["logged_in"] = code == 0 and "login" not in txt.lower() and "unauthorized" not in txt.lower()
            if not st["logged_in"]:
                st["hint"] = f"Cargá un token en Configuración → Deploy, o iniciá sesión en tu terminal: `{t['bin']} login`"
                st["hint_en"] = f"Add a token in Settings → Deploy, or sign in from your terminal: `{t['bin']} login`"
        st["ok"] = st["installed"] and st["logged_in"]
        out.append(st)
    return out


def materialize(user_id: str, build_id: str, files: dict[str, str], existing: Path | None) -> Path:
    """Project folder for the CLIs: the engine's workdir, or a fresh copy of the API build's files."""
    if existing and existing.exists():
        return existing
    root = BUILD_ROOT / user_id / f"{build_id}-deploy"
    # sync instead of wipe: node_modules/.venv (and a dev server running from here) survive; only project files change
    manifest = root / ".arena-files.json"
    tracked = set(json.loads(manifest.read_text())) if manifest.exists() else set()
    wanted = {rel: c for rel, c in files.items() if not any(p in SKIP_DIRS for p in rel.split("/"))}
    for rel in tracked - set(wanted):
        try:
            (root / rel).unlink()
        except FileNotFoundError:
            pass
    for rel, content in wanted.items():
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.read_text(errors="replace") != content:
            dest.write_text(content)
    root.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(sorted(wanted)))
    return root


async def _stream(cmd: list[str], cwd: Path, env: dict, log: Log, timeout: float = 900) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(cwd), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL, limit=8 * 1024 * 1024)
    out: list[str] = []
    assert proc.stdout

    async def pump():
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            out.append(line)
            r = log(line)
            if asyncio.iscoroutine(r):
                await r

    try:
        await asyncio.wait_for(pump(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "\n".join(out) + "\n(timeout)"
    code = await proc.wait()
    return code, "\n".join(out)


async def deploy(target: str, user_id: str, build_id: str, name: str, cwd: Path, values: dict[str, str], log: Log) -> dict:
    """Returns {ok, url, error}. Env values are passed to the platform; nothing is committed to git."""
    t = TARGETS[target]
    binp = shutil.which(t["bin"])
    if not binp:
        return {"ok": False, "url": None, "error": f"{t['label']} CLI no está instalado"}
    token = get_key(user_id, target)
    env = {**os.environ, "CI": "1", "NO_COLOR": "1"}
    slug = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")[:48] or "tablyteam-app"
    (cwd / ".env").write_text(render_env(values, {}))  # local file for the build step; platforms get vars explicitly below
    await _call(log, f"▶ deploy a {t['label']} · proyecto «{slug}» · {len(values)} variables")
    if target == "vercel":
        cmd = [binp, "deploy", "--prod", "--yes", "--cwd", str(cwd), "--name", slug]
        if token:
            cmd += ["--token", token]
        for k, v in values.items():
            cmd += ["-e", f"{k}={v}", "--build-env", f"{k}={v}"]
        code, out = await _stream(cmd, cwd, env, log)
        urls = re.findall(r"https://[a-z0-9.-]+\.vercel\.app", out)
        url = urls[-1] if urls else None
        return {"ok": code == 0 and bool(url), "url": url, "error": None if code == 0 else (out.strip().splitlines() or ["falló"])[-1][:300]}
    # railway: project + service bound to this folder, variables, upload, public domain
    if token:
        env["RAILWAY_TOKEN"] = token
    linked = (cwd / ".railway").exists() or (cwd / "railway.json").exists()
    if not linked:
        code, out = await _stream([binp, "init", "-n", slug], cwd, env, log, timeout=120)
        if code != 0:
            return {"ok": False, "url": None, "error": "railway init falló: " + (out.strip().splitlines() or ["?"])[-1][:300]}
    if values:
        code, out = await _stream([binp, "variables", *sum((["--set", f"{k}={v}"] for k, v in values.items()), [])], cwd, env, log, timeout=120)
        if code != 0:
            await _call(log, "⚠ no se pudieron cargar las variables: " + (out.strip().splitlines() or ["?"])[-1][:200])
    code, out = await _stream([binp, "up", "--detach"], cwd, env, log)
    if code != 0:
        return {"ok": False, "url": None, "error": "railway up falló: " + (out.strip().splitlines() or ["?"])[-1][:300]}
    code, dom = await _stream([binp, "domain", "--json"], cwd, env, log, timeout=120)
    url = None
    try:
        j = json.loads(dom[dom.index("{"):])
        url = "https://" + (j.get("domain") or j.get("serviceDomains", [{}])[0].get("domain"))
    except Exception:
        m = re.search(r"https?://[a-z0-9.-]+\.up\.railway\.app", dom)
        url = m.group(0) if m else None
    return {"ok": True, "url": url, "error": None}


async def _call(log: Log, line: str) -> None:
    r = log(line)
    if asyncio.iscoroutine(r):
        await r
