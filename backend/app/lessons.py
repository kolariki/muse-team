"""What Muse Cloud learns from failed deploys.

Every failure on Railway is saved with a signature (a known kind of error, or a fingerprint of its last error line) and,
when the automatic fix worked, what the builder changed. Two uses:
- the builder gets the lessons up front (`block`), so new apps are born deploy-ready instead of failing the same way;
- the admin sees which failures repeat (`report`), to harden the generated Dockerfile / checks in code.
Across users only the catalog's generic rules travel; a project's own fix summaries are shown only to its owner and the admin.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid

from .auth import _db

with _db() as _c:
    _c.execute(
        """CREATE TABLE IF NOT EXISTS deploy_failures (
            id TEXT PRIMARY KEY, ts REAL NOT NULL, user_id TEXT NOT NULL, build_id TEXT NOT NULL, provider TEXT NOT NULL,
            signature TEXT NOT NULL, reason TEXT, excerpt TEXT, status TEXT NOT NULL DEFAULT 'open',
            fix_summary TEXT, fix_files TEXT, fixed_ts REAL)"""
    )
    _c.execute("CREATE INDEX IF NOT EXISTS deploy_failures_build ON deploy_failures (user_id, build_id, status)")

# (signature, pattern in the logs, what it is, how to avoid it from the start, whether Muse Team's generated Dockerfile already prevents it)
CATALOG: list[tuple[str, str, str, str, bool]] = [
    ("workspace-protocol", r'Unsupported URL Type "workspace:"|EUNSUPPORTEDPROTOCOL',
     "Monorepo con dependencias workspace:* instalado con npm",
     "En un monorepo usá pnpm: `pnpm-workspace.yaml` en la raíz, `\"packageManager\": \"pnpm@9\"` en el package.json raíz y `pnpm-lock.yaml` commiteado.", True),
    ("missing-tables", r'relation "?[\w.]+"? does not exist|no such table|ER_NO_SUCH_TABLE',
     "La base de datos no tiene las tablas (las migraciones no corrieron)",
     "Las migraciones (o el CREATE TABLE inicial) corren solas al arrancar el servidor, antes de escuchar el puerto, y se pueden correr muchas veces sin romper nada; nunca dependas de correrlas a mano.", False),
    ("lockfile-out-of-sync", r"ERR_PNPM_OUTDATED_LOCKFILE|`npm ci` can only install|package-lock\.json.*(not in sync|out of sync)|lockfile needs to be updated",
     "El lockfile no coincide con package.json",
     "Cada vez que cambies dependencias en package.json actualizá también el lockfile (pnpm-lock.yaml / package-lock.json) en el mismo cambio.", True),
    ("missing-script", r'Missing script: "?(start|build)',
     "Falta el script start o build",
     "El package.json del servicio tiene que tener `build` (si compila) y `start` (que arranca el servidor de producción, no el de desarrollo).", False),
    ("module-not-found", r"Cannot find module|ERR_MODULE_NOT_FOUND|Module not found|Cannot find package",
     "Un módulo no se encuentra en producción",
     "Todo lo que se importa en runtime va en `dependencies` (no en devDependencies), con imports que respeten mayúsculas/minúsculas y extensiones (.js en ESM).", False),
    ("typescript-build", r"error TS\d{3,5}",
     "El build falla por errores de TypeScript",
     "Antes de terminar corré el typecheck/build de producción (`tsc --noEmit` / `npm run build`) y dejalo sin errores.", False),
    ("node-version", r'engine "node" is incompatible|Unsupported engine|requires (a )?Node(\.js)? (version )?[>=v]*\d|The engine "node"',
     "La versión de Node no es la que pide el proyecto",
     "Declará la versión de Node en `engines.node` del package.json (por ejemplo \">=20\") y usá APIs disponibles en esa versión.", True),
    ("out-of-memory", r"JavaScript heap out of memory|exit code: 137|Killed\s*$",
     "El build se quedó sin memoria",
     "Evitá builds gigantes: nada de importar librerías enteras si alcanza con una parte, y sin source maps de producción enormes.", True),
    ("prisma", r"prisma generate|PrismaClientInitializationError|@prisma/client did not initialize",
     "Prisma no está generado o no conecta",
     "Con Prisma: `prisma generate` en el build (o postinstall) y migraciones con `prisma migrate deploy` al arrancar, usando DATABASE_URL.", False),
    ("missing-env", r"(Missing|required) (required )?(env|environment variable)|is not set|must be (set|defined)|JWT_SECRET|DATABASE_URL.*(undefined|not)",
     "Falta una variable de entorno al arrancar",
     "Toda variable que la app necesita va en `.env.example` (con comentario); las propias (JWT_SECRET…) Muse Team las genera, las externas las carga el usuario.", False),
    ("port-binding", r"EADDRINUSE|listening on (http://)?(localhost|127\.0\.0\.1)",
     "El servidor no escucha donde Railway lo busca",
     "El servidor escucha en `0.0.0.0` y en `process.env.PORT` (8080 en Muse Cloud), nunca en un puerto fijo ni en localhost.", False),
    ("python-deps", r"No matching distribution found|ModuleNotFoundError: No module named|ResolutionImpossible",
     "Faltan dependencias de Python",
     "Todas las dependencias de Python van en requirements.txt o pyproject.toml, con versiones que existan.", False),
    ("secret-in-code", r"CLAVE EN EL CÓDIGO",
     "Claves escritas en el código (Muse Team frena la publicación)",
     "Nunca escribas claves, tokens ni contraseñas en el código, en la configuración ni en datos de ejemplo: leelas siempre de variables de entorno y documentalas en `.env.example`; en el frontend solo claves públicas, las secretas viven en el servidor.", False),
    ("data-in-memory", r"guarda los datos solo en memoria",
     "Los datos de la app de prueba vivían solo en memoria",
     "Sin DATABASE_URL los datos se guardan en disco (TABLY_DATA_DIR o .data/, con PGlite o SQLite), nunca solo en memoria; el seed de ejemplo solo si la base está vacía.", False),
    ("no-response", r"^$",
     "La app arrancó pero no respondió en su URL",
     "La web tiene que responder en «/» (sin login obligatorio en la home) y el servidor tiene que arrancar en menos de un minuto.", False),
]
_BY_SIG = {c[0]: c for c in CATALOG}


def signature(logs: str, timed_out: bool = False) -> str:
    for sig, rx, *_ in CATALOG:
        if sig != "no-response" and re.search(rx, logs or "", re.I | re.M):
            return sig
    if timed_out and not re.search(r"\berror\b", logs or "", re.I):
        return "no-response"
    # unknown: a fingerprint of the last error-looking line without numbers, paths or hashes, so repeats group together
    lines = [ln for ln in (logs or "").splitlines() if re.search(r"error|failed|exception|fatal", ln, re.I)]
    last = re.sub(r"(/[\w.@-]+)+|\b[0-9a-f]{7,}\b|\d+", "#", (lines or ["?"])[-1].lower()).strip()[:160]
    return "other-" + hashlib.sha1(last.encode()).hexdigest()[:8]


def label(sig: str) -> str:
    return _BY_SIG[sig][2] if sig in _BY_SIG else "Error nuevo (todavía sin regla)"


def record(user_id: str, build_id: str, provider: str, reason: str, logs: str) -> dict:
    sig = signature(logs, timed_out="no respondió" in reason)
    row = {"id": uuid.uuid4().hex[:12], "ts": time.time(), "user_id": user_id, "build_id": build_id, "provider": provider,
           "signature": sig, "reason": reason, "excerpt": _excerpt(logs)}
    with _db() as c:
        c.execute("INSERT INTO deploy_failures (id, ts, user_id, build_id, provider, signature, reason, excerpt) VALUES (:id, :ts, :user_id, :build_id, :provider, :signature, :reason, :excerpt)", row)
    return row


def _excerpt(logs: str) -> str:
    lines = [ln for ln in (logs or "").splitlines() if ln.strip()]
    hits = [i for i, ln in enumerate(lines) if re.search(r"error|failed|exception|fatal|cannot|missing", ln, re.I)]
    keep = lines[max(0, hits[0] - 3): hits[-1] + 3] if hits else lines[-15:]
    return "\n".join(keep)[-3000:]


def note_fix(user_id: str, build_id: str, summary: str, files: list[str]) -> None:
    """What the builder changed to fix the open failures of this app (confirmed when the app goes live)."""
    with _db() as c:
        c.execute("UPDATE deploy_failures SET fix_summary = ?, fix_files = ? WHERE user_id = ? AND build_id = ? AND status = 'open'",
                  (summary[:1500], json.dumps(files[:40]), user_id, build_id))


def resolve(user_id: str, build_id: str, ok: bool) -> None:
    """The app went live (the open failures were fixed) or the automatic fixes ran out (they stay as lessons to learn by hand)."""
    with _db() as c:
        c.execute("UPDATE deploy_failures SET status = ?, fixed_ts = ? WHERE user_id = ? AND build_id = ? AND status = 'open'",
                  ("fixed" if ok else "unfixed", time.time(), user_id, build_id))


def past_fixes(sig: str, user_id: str, limit: int = 3) -> str:
    """How the same failure was fixed before: the catalog rule for everyone, the fix summaries of this user's own apps."""
    out = []
    if sig in _BY_SIG:
        out.append(f"Regla conocida: {_BY_SIG[sig][3]}")
    with _db() as c:
        rows = c.execute("SELECT fix_summary FROM deploy_failures WHERE signature = ? AND user_id = ? AND status = 'fixed' AND fix_summary IS NOT NULL ORDER BY fixed_ts DESC LIMIT ?",
                         (sig, user_id, limit)).fetchall()
    out += [f"Así se resolvió antes en otra app tuya: {r['fix_summary'][:600]}" for r in rows]
    return "\n".join(out)


def block(user_id: str | None = None, limit: int = 8) -> str:
    """For the builder's prompts: the deploy failures that already happened on Muse Cloud (most frequent first) and how to avoid them."""
    with _db() as c:
        rows = c.execute("SELECT signature, COUNT(*) n FROM deploy_failures GROUP BY signature ORDER BY n DESC").fetchall()
    rules = [f"- {_BY_SIG[r['signature']][2]} ({r['n']} vez/veces): {_BY_SIG[r['signature']][3]}" for r in rows if r["signature"] in _BY_SIG][:limit]
    if not rules:
        return ""
    return ("\n\nLECCIONES DE PRODUCCIÓN (fallas que ya pasaron publicando o usando apps en Muse Cloud; dejá el proyecto listo para que no le pasen a este):\n"
            + "\n".join(rules))


def report(days: int = 90) -> dict:
    """For the admin: which failures repeat, how many the automatic fix solved, and an example of each (to harden the config in code)."""
    since = time.time() - days * 86400
    with _db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM deploy_failures WHERE ts >= ? ORDER BY ts DESC", (since,))]
    groups: dict[str, dict] = {}
    for r in rows:
        g = groups.setdefault(r["signature"], {"signature": r["signature"], "label": label(r["signature"]), "rule": (_BY_SIG.get(r["signature"]) or (None,) * 4)[3],
                                               "prevented": bool((_BY_SIG.get(r["signature"]) or (None,) * 5)[4]), "count": 0, "fixed": 0, "unfixed": 0, "open": 0, "apps": set(),
                                               "last_ts": r["ts"], "excerpt": r["excerpt"], "fix_summary": None})
        g["count"] += 1
        g[r["status"]] = g.get(r["status"], 0) + 1
        g["apps"].add(r["build_id"])
        if r["status"] == "fixed" and r["fix_summary"] and not g["fix_summary"]:
            g["fix_summary"] = r["fix_summary"]
    out = sorted(groups.values(), key=lambda g: (-g["count"], -g["last_ts"]))
    for g in out:
        g["apps"] = len(g["apps"])
    return {"groups": out, "total": len(rows), "fixed": sum(1 for r in rows if r["status"] == "fixed"), "days": days}
