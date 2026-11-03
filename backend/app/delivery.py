"""The first delivery has to be complete: everything the user asked for, working end to end.

Two pieces:
- the delivery contract: the builder writes `.tably/entrega.md` before coding — every screen, endpoint, the data, the
  accounts, payments, emails and integrations the product needs — as a `- [ ]` checklist, and ticks each item only when
  it works end to end;
- the delivery check, when the builder says it is done: Muse Team reads the code against the brief (a product with users
  needs a backend, a database and real accounts; payments and emails when it charges or notifies; no TODOs or filler;
  the contract fully ticked; README, .env.example and tests) and, if something is missing, sends the builder back to
  complete it before the user gets the delivery.
"""
from __future__ import annotations

import re

CONTRACT = ".tably/entrega.md"
SKIP = re.compile(r"(^|/)(node_modules|dist|build|\.next|out|coverage|\.tably|preview|design|research|\.git)/")
CODE = re.compile(r"\.(ts|tsx|js|jsx|mjs|cjs|py|vue|svelte|astro|prisma|sql|go|rb|php)$")
TESTS = re.compile(r"(^|/)(tests?|__tests__|e2e|spec)/|\.(test|spec)\.(ts|tsx|js|jsx|mjs|py)$|(^|/)test_[\w-]+\.py$")

# what the product needs, read from the brief
NEEDS: list[tuple[str, str, str]] = [
    ("accounts", r"\b(login|log in|sign ?up|sign ?in|registr|iniciar sesi|inicio de sesi|cuenta de usuario|crear (una |su )?cuenta|contraseñ|password|usuarios? (registrad|logue)|autenticaci|authentication)", "cuentas de usuario (registro, login, sesión)"),
    ("data", r"\b(guarda|almacen|base de datos|database|historial|reservas?\b|turnos?\b|pedidos?\b|inventario|crud|perfil|factura|suscriptor|tareas?\b|bookings?|orders?\b)", "datos guardados en una base de datos"),
    ("payments", r"\b(pagos?\b|pagar|cobr[aoe]|seña\b|suscripci[oó]n paga|checkout|mercado ?pago|stripe|paypal|payments?\b)", "cobros o pagos"),
    ("email", r"(envi\w* (un |el |los |una )?(e-?mails?|correos?|mails?)\b|\b(e-?mails?|correos?|mails?) (de|con) |recordatori|notificaci[oó]n|newsletter|recuperar (la )?contraseña|send (an )?emails?|email notifications?|reminders?)", "envío de emails"),
]
SERVER = re.compile(r'"(express|fastify|hono|koa|@nestjs/core|next|nuxt|@remix-run/node|@sveltejs/kit|@trpc/server|elysia|@hapi/hapi)"\s*:|\b(fastapi|flask|django|starlette|litestar)\b', re.I)
DB = re.compile(r"prisma|drizzle|typeorm|sequelize|mongoose|knex|kysely|sqlalchemy|sqlmodel|django\.db|better-sqlite3|\bpg\b|postgres|@supabase/supabase-js|pglite|sqlite3|mysql2|CREATE TABLE", re.I)
SIGNUP = re.compile(r"sign[-_ ]?up|register|registr(o|arse|ate)|crear[-_ ]?cuenta|createUser|create_user", re.I)
LOGIN = re.compile(r"log[-_ ]?in|sign[-_ ]?in|iniciar[-_ ]?sesi|authenticate|session", re.I)
SECURE_PW = re.compile(r"bcrypt|argon2|scrypt|pbkdf2|passlib|hashPassword|hash_password|supabase\.auth|@clerk|lucia|next-auth|@auth/|better-auth|passport|firebase/auth|werkzeug\.security", re.I)
PAYMENTS = re.compile(r"stripe|mercadopago|mercado-pago|paypal|lemonsqueezy|paddle", re.I)
EMAIL = re.compile(r"resend|nodemailer|sendgrid|postmark|mailgun|smtp|ses\b|sendEmail|send_email", re.I)
FILLER = re.compile(r"\b(TODO|FIXME|XXX)\b|(?i:lorem ipsum|not implemented|no implementado|coming soon|próximamente)")  # TODO in capitals: «todo» is Spanish
# the parts of the brief that are NOT in this delivery (out of scope, later, assumptions) don't count as needs
LATER = re.compile(r"fuera de alcance|out of scope|no incluye|not included|despu[eé]s|later|futur|pr[oó]ximas? (versi|etapa)|next version|supuestos|assumptions|riesgos|risks", re.I)


def _in_scope(brief: str) -> str:
    out, skip, level = [], False, 0
    for ln in (brief or "").splitlines():
        h = re.match(r"^(#{1,6})\s+(.*)", ln)
        if h:
            if skip and len(h.group(1)) > level:
                continue
            skip, level = bool(LATER.search(h.group(2))), len(h.group(1))
            if skip:
                continue
        elif skip or re.match(r"^\s*([-*]\s*)?\**(" + LATER.pattern + r")", ln, re.I):
            continue
        out.append(re.split(r"(?i)\b(?:despu[eé]s|later|fuera de alcance|out of scope|no incluye)\s*:", ln)[0])
    return "\n".join(out)


def needs(brief: str, title: str = "") -> list[str]:
    text = f"{title}\n{_in_scope(brief)}"
    return [k for k, rx, _ in NEEDS if re.search(rx, text, re.I)]


def _web(files: dict[str, str]) -> bool:
    return any(p.endswith(("package.json", "pyproject.toml", "requirements.txt", "index.html")) for p in files)


def check(files: dict[str, str], brief: str, title: str = "") -> dict:
    """What the delivery has and what it lacks. {needs, checks: [{label, ok, detail}], gaps: [str]} — gaps are written for the builder."""
    src = {p: t for p, t in files.items() if isinstance(t, str) and not SKIP.search(p)}
    code = {p: t for p, t in src.items() if CODE.search(p) or p.endswith(("package.json", "pyproject.toml", "requirements.txt"))}
    blob = "\n".join(code.values())
    need = needs(brief, title)
    checks: list[dict] = []
    gaps: list[str] = []

    def add(label: str, ok: bool, gap: str, detail: str = "") -> None:
        checks.append({"label": label, "ok": ok, "detail": detail})
        if not ok:
            gaps.append(gap)

    server = bool(SERVER.search(blob)) or any(re.search(r"(^|/)(api|server|backend)/", p) and CODE.search(p) for p in code)
    if "accounts" in need or "data" in need or "payments" in need:
        add("Backend (servidor y API)", server, "Falta el backend: el producto guarda datos o tiene usuarios, así que necesita un servidor con su API (no solo pantallas con datos de ejemplo).")
    if "data" in need or "accounts" in need:
        add("Base de datos con su esquema", bool(DB.search(blob)), "Falta la base de datos: definí el esquema (tablas/modelos) y las migraciones que corren solas al arrancar, y que la API lea y guarde ahí (Postgres por DATABASE_URL; sin DATABASE_URL, en disco en TABLY_DATA_DIR).")
    if "accounts" in need:
        signup, login, secure = bool(SIGNUP.search(blob)), bool(LOGIN.search(blob)), bool(SECURE_PW.search(blob))
        add("Cuentas: registro, login y sesión", signup and login, "Faltan las cuentas de usuario completas: registro, inicio de sesión, cierre de sesión y sesión persistente, con las pantallas y los endpoints.")
        add("Contraseñas guardadas de forma segura", secure, "Las contraseñas no se guardan de forma segura: usá hash (bcrypt/argon2) o un proveedor de auth; nunca texto plano.")
    if "payments" in need:
        add("Cobros integrados", bool(PAYMENTS.search(blob)), "Falta integrar el cobro que pide el brief (Mercado Pago o Stripe) con su webhook de confirmación y las claves en .env.example.")
    if "email" in need:
        add("Envío de emails", bool(EMAIL.search(blob)), "Falta el envío de emails que pide el brief (Resend u otro proveedor), con las claves en .env.example.")

    filler = []
    for p, t in code.items():
        if TESTS.search(p) or re.search(r"(^|/)(seed|fixtures?|mocks?)\b", p, re.I):
            continue
        for i, line in enumerate(t.splitlines(), 1):
            if FILLER.search(line):
                filler.append(f"{p}:{i}")
    add("Sin TODOs ni texto de relleno", not filler, "Quedan partes sin terminar (TODO, «próximamente», relleno): " + ", ".join(filler[:10]) + ("…" if len(filler) > 10 else ""), ", ".join(filler[:5]))

    contract = files.get(CONTRACT) or ""
    open_items = [re.sub(r"^\s*[-*]\s*\[ \]\s*", "", ln).strip() for ln in contract.splitlines() if re.match(r"^\s*[-*]\s*\[ \]", ln)]
    done_items = [ln for ln in contract.splitlines() if re.match(r"^\s*[-*]\s*\[[xX]\]", ln)]
    if contract:
        add(f"Contrato de entrega ({len(done_items)}/{len(done_items) + len(open_items)} cumplido)", not open_items,
            "Hay ítems del contrato de entrega (.tably/entrega.md) sin cumplir: " + "; ".join(open_items[:12]) + ("…" if len(open_items) > 12 else ""))
    elif _web(files):
        add("Contrato de entrega", False, f"Falta el contrato de entrega: escribí {CONTRACT} con TODO lo que el producto tiene que hacer según el brief (cada pantalla, endpoint, datos, cuentas, pagos, emails, integraciones) como checklist, verificá cada punto y tildalo.")

    add("README con cómo correrlo", any(p.lower().endswith("readme.md") for p in src), "Falta el README.md con cómo instalar, configurar y correr el producto.")
    if server:
        add(".env.example con las variables", any(p.endswith(".env.example") for p in src), "Falta el .env.example con todas las variables que usa el producto.")
        add("Tests de los flujos principales", any(TESTS.search(p) for p in src), "Faltan los tests de los flujos principales (al menos el camino feliz y los errores de lo que guarda datos, cobra o autentica).")
    return {"needs": need, "checks": checks, "gaps": gaps}


def prompt(result: dict) -> str:
    gaps = "\n".join(f"- {g}" for g in result["gaps"])
    return ("VERIFICACIÓN DE ENTREGA: Muse Team revisó el proyecto contra el brief y la primera entrega todavía NO está completa. "
            "La primera entrega tiene que tener TODO lo que el usuario pidió funcionando de punta a punta. Completá esto (código real, nada de placeholders):\n"
            f"{gaps}\n\nDespués corré el build y los tests y arreglá lo que falle, actualizá {CONTRACT} tildando solo lo que funciona de verdad, "
            "y emití <done> con qué quedó y cómo verificarlo.")


CONTRACT_RULE = (f"- Contrato de entrega: en la primera etapa, antes de programar, escribí `{CONTRACT}` con TODO lo que el producto tiene que hacer según el brief "
                 "(cada pantalla, cada endpoint, los datos, las cuentas, los pagos, los emails y las integraciones) como checklist `- [ ] …`. Tildá cada ítem "
                 "(`- [x]`) recién cuando funciona de punta a punta. No emitas <done> con ítems sin tildar: Muse Team lo verifica y te devuelve lo que falte.\n"
                 "- Primera entrega completa: es TODO lo que el usuario pidió, funcionando. Si el producto guarda datos o tiene usuarios es full-stack: frontend + "
                 "backend con su API + base de datos con migraciones + cuentas reales (registro, login, logout, sesión, recuperar contraseña, contraseñas con hash) y "
                 "permisos; si cobra, el cobro con su webhook; si avisa, los emails. Nada de «en una próxima versión» ni pantallas con datos de ejemplo en lugar de la API.\n")


def card(result: dict) -> str:
    """The checks, one per line, for the chat card."""
    return "\n".join(("✓ " if c["ok"] else "✗ ") + c["label"] for c in result["checks"])
