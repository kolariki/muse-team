"""
UI kit: where the team and the builder get their UI building blocks from.

Instead of each build inventing buttons, inputs and dialogs from scratch (and each model doing it differently), every
web project starts from the same, proven stack — the one the design community actually uses today (what catalogues
like Designeer list under "Resources"):

  - Tailwind CSS v4 for styling, with the project's design tokens (design/tokens.css) as the single source of color,
    type, spacing and radius.
  - shadcn/ui components (MIT): real source files copied INTO the project (src/components/ui/*.tsx), fetched from the
    official registry and cached on disk, so the user owns the code and the builder composes screens instead of
    re-implementing primitives. Radix UI underneath gives keyboard navigation, focus management and ARIA for free.
  - lucide-react icons (one library, one stroke), Google Fonts / Fontshare for typography, motion for purposeful
    animation.

Three consumers:
  team_block()      what the roles that decide the stack (CTO, frontend, designer…) are told in the design debate
  designer_block()  what the Product Designer must add to tokens.css so the components pick up the design
  scaffold()        the files Muse Team writes into the project before the builder's first turn, plus builder_block() with
                    the rules the builder gets (what exists, which deps to declare, how to import)

Everything degrades gracefully: without network and without cache the builder is told to add the components with the
shadcn CLI instead, and the rest (tokens, Tailwind, utils, rules) still ships.
"""
from __future__ import annotations

import json
import logging
import os
import re
import urllib.request
from pathlib import Path

log = logging.getLogger("arena.uikit")

STYLE = "new-york-v4"
REGISTRY = os.getenv("TABLY_SHADCN_REGISTRY", f"https://ui.shadcn.com/r/styles/{STYLE}").rstrip("/")
CACHE_DIR = Path(os.getenv("TABLY_UIKIT_CACHE", Path(__file__).resolve().parents[1] / "data" / "uikit" / STYLE))
OFFLINE = os.getenv("TABLY_UIKIT_OFFLINE", "") in ("1", "true", "yes")
ENABLED = os.getenv("TABLY_UIKIT", "1") not in ("0", "false", "no", "off")

UI_DIR = "src/components/ui"
TOKENS_PATH = "src/styles/tokens.css"
INDEX_CSS = "src/index.css"
UTILS_PATH = "src/lib/utils.ts"
GUIDE_PATH = "UIKIT.md"

# The primitives nearly every product screen is made of. Each is one file in the registry; registryDependencies are
# resolved on top (e.g. a component that reuses button).
DEFAULT_COMPONENTS = [
    "button", "card", "input", "label", "textarea", "select", "checkbox", "switch", "badge", "alert", "avatar",
    "dialog", "sheet", "dropdown-menu", "tabs", "table", "tooltip", "skeleton", "separator", "progress",
]

# npm packages the registry files import (the registry declares `cn` and `radix-ui`; `cn` is our own utils file).
BASE_DEPS = {
    "react": "^18.3.1", "react-dom": "^18.3.1", "radix-ui": "^1.4.3", "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1", "tailwind-merge": "^3.3.1", "lucide-react": "^1.0.0",
}
BASE_DEV_DEPS = {
    "vite": "^6.3.5", "@vitejs/plugin-react": "^4.5.2", "typescript": "~5.8.3", "@types/react": "^18.3.23",
    "@types/react-dom": "^18.3.7", "tailwindcss": "^4.1.11", "@tailwindcss/vite": "^4.1.11", "tw-animate-css": "^1.3.5",
}
# registry dependency name → npm package(s) (anything not listed maps to itself)
DEP_ALIAS = {"cn": None, "utils": None, "radix-ui": "radix-ui"}

# The semantic variables shadcn components read. The designer maps the product's palette onto them in tokens.css;
# anything missing gets a fallback derived from the designer's own role names (--color-bg, --color-accent…).
SHADCN_VARS = [
    ("--background", "var(--color-bg, #ffffff)"), ("--foreground", "var(--color-text, #111827)"),
    ("--card", "var(--color-surface, #ffffff)"), ("--card-foreground", "var(--color-text, #111827)"),
    ("--popover", "var(--color-surface-elevated, var(--color-surface, #ffffff))"), ("--popover-foreground", "var(--color-text, #111827)"),
    ("--primary", "var(--color-accent, #111827)"), ("--primary-foreground", "var(--color-on-accent, #ffffff)"),
    ("--secondary", "var(--color-accent-soft, #f3f4f6)"), ("--secondary-foreground", "var(--color-text, #111827)"),
    ("--muted", "var(--color-bg, #f3f4f6)"), ("--muted-foreground", "var(--color-text-2, #6b7280)"),
    ("--accent", "var(--color-accent-soft, #f3f4f6)"), ("--accent-foreground", "var(--color-text, #111827)"),
    ("--destructive", "var(--color-error, #b3382c)"), ("--border", "var(--color-border, #e5e7eb)"),
    ("--input", "var(--color-border, #e5e7eb)"), ("--ring", "var(--color-accent, #111827)"),
    ("--radius", "var(--radius-md, 8px)"),
]

# Curated sources (what designeer.xyz-style catalogues point to), with the license that decides how Muse Team may use them.
SOURCES = [
    {"name": "shadcn/ui", "url": "https://ui.shadcn.com", "license": "MIT", "use": "componentes accesibles (Radix + Tailwind) que se copian al proyecto; es la base de la UI de todo producto web de Muse Team"},
    {"name": "Radix UI", "url": "https://www.radix-ui.com/primitives", "license": "MIT", "use": "primitivas sin estilo (menús, diálogos, popovers, tabs) con teclado, foco y ARIA resueltos; debajo de shadcn"},
    {"name": "Base UI", "url": "https://base-ui.com", "license": "MIT", "use": "alternativa de primitivas (MUI/Radix/Floating UI) cuando hace falta algo que Radix no tiene"},
    {"name": "Tailwind CSS v4", "url": "https://tailwindcss.com", "license": "MIT", "use": "utilidades + tokens por @theme; cero CSS ad hoc"},
    {"name": "lucide", "url": "https://lucide.dev", "license": "ISC", "use": "iconos: una sola librería, un solo grosor (lucide-react)"},
    {"name": "Motion (Framer Motion)", "url": "https://motion.dev", "license": "MIT", "use": "animación con propósito (150-250 ms): transiciones de lista, modales, feedback"},
    {"name": "Motion Primitives", "url": "https://motion-primitives.com", "license": "MIT", "use": "componentes animados listos (texto, números, reveal) sobre motion"},
    {"name": "React Bits", "url": "https://reactbits.dev", "license": "MIT", "use": "componentes y fondos animados para el «primer impacto» de una landing, con moderación"},
    {"name": "Google Fonts", "url": "https://fonts.google.com", "license": "OFL", "use": "tipografía libre (Inter, Geist, Manrope, Fraunces, JetBrains Mono…)"},
    {"name": "Fontshare", "url": "https://www.fontshare.com", "license": "ITF Free Font License (uso comercial permitido)", "use": "tipografía con carácter (Satoshi, General Sans, Clash Display, Cabinet Grotesk)"},
    {"name": "Recharts", "url": "https://recharts.org", "license": "MIT", "use": "gráficos en dashboards (shadcn/charts los envuelve con los tokens)"},
    {"name": "21st.dev / shadcnblocks", "url": "https://21st.dev", "license": "varía por bloque — mirar la licencia antes de copiar", "use": "inspiración de bloques completos (hero, pricing, dashboard); se reimplementa con nuestros componentes, no se pega"},
]


def enabled(platform: str | None) -> bool:
    return ENABLED and (platform or "web") == "web"


def sources_block(limit: int | None = None) -> str:
    rows = SOURCES[:limit] if limit else SOURCES
    return "\n".join(f"- {s['name']} ({s['license']}) — {s['use']} · {s['url']}" for s in rows)


# ------------------------------------------------------------------ prompts
def team_block(role_id: str | None, platform: str | None) -> str:
    """What a role in the design debate is told about the UI stack. Only the roles that decide it get the long version."""
    if not enabled(platform):
        return ""
    deciders = {"cto", "tech-lead", "head-engineering", "frontend", "product-designer", "brand", "founder"}
    if role_id not in deciders:
        return ("STACK DE UI (ya decidido por Muse Team para la web): React + TypeScript con Vite, Tailwind v4, componentes shadcn/ui (Radix) copiados al proyecto, "
                "iconos lucide, tipografía de Google Fonts/Fontshare. No lo rediscutas; si tu área necesita algo de UI, pedilo en esos términos.\n")
    return (
        "STACK DE UI POR DEFECTO EN TABLY (web): React 18 + TypeScript con Vite, Tailwind CSS v4, componentes shadcn/ui (sobre Radix) copiados al proyecto "
        "(src/components/ui), iconos lucide-react, tipografía libre de Google Fonts o Fontshare, animación con motion. Muse Team siembra esos componentes y los "
        "tokens del diseño en el repo antes de que el constructor escriba la primera línea, así que el equipo DISEÑA Y DECIDE EN ESOS TÉRMINOS: "
        "qué componentes de la librería usa cada pantalla (Button, Card, Dialog, Sheet, Tabs, Table, Select, DropdownMenu, Tooltip, Skeleton, Badge…), "
        "qué variantes hacen falta, qué bloques se arman componiéndolos. Solo se cambia el stack si el brief lo exige (p. ej. Next.js por SEO, o un framework "
        "impuesto por el cliente), y en ese caso se dice explícitamente y se mantiene shadcn/Tailwind igual. Nada de librerías de UI con estilos propios "
        "(MUI, Ant, Bootstrap, Chakra) que peleen con los tokens.\n"
        "FUENTES DE REFERENCIA (lo que usa la comunidad de diseño hoy; licencias verificadas):\n" + sources_block() + "\n"
    )


def designer_block(platform: str | None) -> str:
    """Added to the Product Designer's prompt: the tokens have to drive the shadcn components."""
    if not enabled(platform):
        return ""
    names = ", ".join(v for v, _ in SHADCN_VARS)
    return (
        "\n\nCOMPONENTES: la interfaz se construye con shadcn/ui (Radix + Tailwind v4) y tus tokens. Al final de design/tokens.css agregá, dentro del mismo :root, "
        f"el MAPEO SEMÁNTICO que leen esos componentes, con tus HEX reales (sin alpha, sin var() anidados): {names}. "
        "--primary es tu acento, --primary-foreground el texto sobre el acento (AA), --muted el fondo suave, --muted-foreground el texto secundario, "
        "--destructive el error, --ring el color de foco, --radius el radio base. Si diseñás modo oscuro, repetí el mapeo dentro de `.dark { … }`. "
        "En DESIGN.md §3 nombrá los componentes de shadcn que usa cada patrón (Button variant=…, Card, Dialog, Sheet, Tabs, Table, Select, DropdownMenu, "
        "Tooltip, Badge, Skeleton…) y qué variantes nuevas hacen falta; la iconografía es lucide (un grosor). La tipografía, de Google Fonts o Fontshare "
        "(decí cuál y el <link> exacto)."
    )


def builder_block(info: dict) -> str:
    """The rules the builder gets once the kit is seeded in the project (API builder: first message; engine: prompt)."""
    comps = info.get("components") or []
    deps = ", ".join(f'"{k}": "{v}"' for k, v in sorted(info.get("deps", {}).items()))
    dev = ", ".join(f'"{k}": "{v}"' for k, v in sorted(info.get("dev_deps", {}).items()))
    seeded = ", ".join(info.get("files") or [])
    if comps:
        have = (f"Ya están copiados en {UI_DIR}/: {', '.join(comps)}. Importalos con `import {{ Button }} from \"@/components/ui/button\"` (ver {GUIDE_PATH} para los "
                f"exports de cada uno). NO reescribas esos archivos ni los reimplementes; si necesitás otro componente de shadcn, creá el archivo en {UI_DIR}/ con el "
                f"mismo estilo (o pedilo en NOTES.md).")
    else:
        have = (f"No se pudieron descargar los componentes (sin red): en el README indicá `npx shadcn@latest add {' '.join(DEFAULT_COMPONENTS)}` como paso de setup y "
                f"escribí la UI importando desde `@/components/ui/*` igual.")
    return (
        f"\n\nKIT DE UI SEMBRADO POR TABLY (archivos que ya existen en el proyecto: {seeded}). Stack: React 18 + TypeScript + Vite, Tailwind CSS v4 (plugin "
        f"@tailwindcss/vite, sin tailwind.config), shadcn/ui, lucide-react. {have}\n"
        f"- {INDEX_CSS} ya importa Tailwind, tw-animate-css y {TOKENS_PATH} (los tokens del diseño mapeados a las variables de shadcn vía @theme). Importalo UNA vez en "
        f"src/main.tsx. Todo color/espacio/radio sale de ahí: clases `bg-background text-foreground border-border bg-primary text-primary-foreground text-muted-foreground "
        f"rounded-md` y las utilidades de Tailwind; nada de CSS ad hoc ni de hex sueltos en los componentes.\n"
        f"- {UTILS_PATH} exporta `cn()`; vite.config.ts y tsconfig.json ya traen el alias `@` → src y el plugin de Tailwind: si los reescribís, conservá ambos.\n"
        f"- package.json (lo escribís vos) DEBE incluir estas dependencias exactas: {{ {deps} }} y devDependencies {{ {dev} }}, más lo que el producto necesite "
        f"(react-router-dom, @tanstack/react-query, zustand, motion, recharts…). Scripts: dev=vite, build=tsc -b && vite build, preview=vite preview.\n"
        f"- Las pantallas se COMPONEN con esos componentes (Card para agrupar, Dialog/Sheet para flujos secundarios, Table para listas densas, Tabs para secciones, "
        f"Skeleton para carga, Badge para estados, Tooltip para ayuda): un botón hecho con <div> estilizado o un modal casero donde existe el componente es un bug "
        f"que el equipo va a marcar. Iconos solo de lucide-react, tamaño `size-4`/`size-5`.\n"
        f"- La tipografía del diseño se carga con el <link> de Google Fonts/Fontshare en index.html y `--font-sans` en tokens.css; nada en la fuente del sistema."
    )


def reviewer_note() -> str:
    return (f" Si existe {GUIDE_PATH}, la UI tiene que estar compuesta con los componentes de {UI_DIR} (shadcn) y las clases de tokens (bg-background, text-muted-foreground…): "
            "un control casero donde había un componente, hex sueltos o CSS ad hoc son hallazgos.")


# ------------------------------------------------------------------ registry
def _fetch_url(url: str, timeout: float = 20) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": "tably-team/1.0 (+https://tablyteam-production.up.railway.app)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_component(name: str, fetcher=None) -> dict | None:
    """One registry item (cached on disk forever: a component's source only changes with a new style)."""
    if not re.fullmatch(r"[a-z0-9-]{1,40}", name):
        return None
    cached = CACHE_DIR / f"{name}.json"
    if cached.exists():
        try:
            return json.loads(cached.read_text())
        except Exception:
            pass
    if OFFLINE and fetcher is None:
        return None
    try:
        item = (fetcher or _fetch_url)(f"{REGISTRY}/{name}.json")
    except Exception as e:
        log.warning("shadcn registry: %s unavailable (%s)", name, e)
        return None
    if not isinstance(item, dict) or not item.get("files"):
        return None
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(item))
    except OSError:
        pass
    return item


def _normalize(src: str) -> str:
    # the current registry imports `cn` from a package of the same name; the project ships its own utils
    src = re.sub(r'from\s+"cn"', 'from "@/lib/utils"', src)
    src = re.sub(r'from\s+"@/registry/[^"]*/ui/([a-z0-9-]+)"', r'from "@/components/ui/\1"', src)
    src = re.sub(r'from\s+"@/registry/[^"]*/lib/utils"', 'from "@/lib/utils"', src)
    return src


_EXPORT_RX = re.compile(r"^export\s*\{([^}]+)\}", re.M)


def _exports(src: str) -> list[str]:
    names: list[str] = []
    for m in _EXPORT_RX.finditer(src):
        names += [n.strip().split(" as ")[-1].strip() for n in m.group(1).split(",") if n.strip()]
    names += re.findall(r"^export\s+(?:function|const)\s+([A-Z][A-Za-z0-9]*)", src, re.M)
    return [n for n in dict.fromkeys(names) if n and not n.startswith("type ")]


def _mapping_block(tokens_css: str) -> str:
    """shadcn variables missing from the designer's tokens, derived from the designer's role names with hex fallbacks."""
    missing = [(v, fb) for v, fb in SHADCN_VARS if not re.search(rf"{re.escape(v)}\s*:", tokens_css)]
    if not missing:
        return ""
    body = "\n".join(f"  {v}: {fb};" for v, fb in missing)
    return f"\n\n/* Mapeo a las variables semánticas de shadcn/ui (sembrado por Muse Team; faltaban en el diseño) */\n:root {{\n{body}\n}}\n"


def _index_css(tokens_rel: str) -> str:
    theme = "\n".join(f"  --color-{v[2:]}: var({v});" for v, _ in SHADCN_VARS if v != "--radius")
    return f'''@import "tailwindcss";
@import "tw-animate-css";
@import "./{tokens_rel}";

@custom-variant dark (&:is(.dark *));

/* Los tokens del diseño (tokens.css) alimentan a Tailwind y a los componentes de shadcn/ui. Nunca hex sueltos acá. */
@theme inline {{
{theme}
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --font-sans: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  --font-mono: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
}}

@layer base {{
  * {{
    @apply border-border outline-ring/50;
  }}
  html {{
    @apply antialiased;
  }}
  body {{
    @apply bg-background text-foreground font-sans;
  }}
}}
'''


UTILS_TS = '''import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
'''

VITE_CONFIG = '''import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// base configurable (`vite build --base=/ruta/`) para publicar desde cualquier ruta (Muse Cloud)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: { port: 5173, host: true },
})
'''

TSCONFIG = '''{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["vite/client", "node"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
'''

COMPONENTS_JSON = '''{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/index.css", "baseColor": "neutral", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" }
}
'''


def scaffold(tokens_css: str = "", components: list[str] | None = None, *, fetcher=None, title: str = "") -> tuple[dict[str, str], dict]:
    """Files to seed into a fresh web project + info for builder_block(). Pure except for registry fetches (cached)."""
    files: dict[str, str] = {}
    deps = dict(BASE_DEPS)
    dev_deps = dict(BASE_DEV_DEPS)
    wanted = list(dict.fromkeys(components or DEFAULT_COMPONENTS))
    done: dict[str, list[str]] = {}
    queue = list(wanted)
    while queue:
        name = queue.pop(0)
        if name in done or name in ("utils", "cn"):
            continue
        item = fetch_component(name, fetcher)
        if not item:
            continue
        exports: list[str] = []
        for f in item.get("files", []):
            if f.get("type") not in ("registry:ui", "registry:component") or not f.get("content"):
                continue
            base = Path(f.get("path", f"{name}.tsx")).name
            src = _normalize(f["content"]).rstrip("\n") + "\n"
            files[f"{UI_DIR}/{base}"] = src
            exports += _exports(src)
        for d in item.get("dependencies") or []:
            pkg = d.split("@")[0] if not d.startswith("@") else "@" + d[1:].split("@")[0]
            alias = DEP_ALIAS.get(pkg, pkg)
            if alias and alias not in deps:
                deps[alias] = "latest" if alias not in BASE_DEPS else BASE_DEPS[alias]
        for r in item.get("registryDependencies") or []:
            r = r.rsplit("/", 1)[-1]
            if r not in done and r not in queue:
                queue.append(r)
        done[name] = exports
    tokens = (tokens_css or "").rstrip("\n")
    if not tokens:
        tokens = ("/* Tokens del diseño (design/tokens.css). Sin fase de diseño: valores base sobrios; el constructor los ajusta al brief. */\n"
                  ":root {\n  --color-bg: #fafafa;\n  --color-surface: #ffffff;\n  --color-border: #e5e7eb;\n  --color-text: #111827;\n  --color-text-2: #6b7280;\n"
                  "  --color-accent: #1f3a5f;\n  --color-on-accent: #ffffff;\n  --color-accent-soft: #e8eef7;\n  --color-error: #b3382c;\n  --radius-md: 8px;\n"
                  "  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;\n}")
    files[TOKENS_PATH] = tokens + "\n" + _mapping_block(tokens)
    files[INDEX_CSS] = _index_css(TOKENS_PATH.split("/", 1)[1])
    files[UTILS_PATH] = UTILS_TS
    files["vite.config.ts"] = VITE_CONFIG
    files["tsconfig.json"] = TSCONFIG
    files["components.json"] = COMPONENTS_JSON
    info = {"components": sorted(done), "exports": done, "deps": deps, "dev_deps": dev_deps, "files": sorted(files) + [GUIDE_PATH]}
    files[GUIDE_PATH] = _guide(info, title)
    return files, info


def _guide(info: dict, title: str) -> str:
    comps = "\n".join(f"- `@/components/ui/{n}` → {', '.join(info['exports'].get(n) or ['(ver archivo)'])}" for n in info["components"]) or "- (sin red al sembrar: `npx shadcn@latest add " + " ".join(DEFAULT_COMPONENTS) + "`)"
    deps = "\n".join(f'    "{k}": "{v}",' for k, v in sorted(info["deps"].items()))
    dev = "\n".join(f'    "{k}": "{v}",' for k, v in sorted(info["dev_deps"].items()))
    return f"""# Kit de UI{(' · ' + title) if title else ''}

Sembrado por Muse Team antes de la construcción. La interfaz se compone con estos componentes y los tokens del diseño; no se reimplementan.

## Stack
React 18 + TypeScript (Vite) · Tailwind CSS v4 (`@tailwindcss/vite`, sin tailwind.config) · shadcn/ui (estilo new-york, Radix debajo) · lucide-react · tokens en `{TOKENS_PATH}`.

## Componentes disponibles
{comps}

Agregar otro: `npx shadcn@latest add <nombre>` (usa `components.json`), o copiar el archivo a `{UI_DIR}/` con el mismo estilo.

## Dependencias que package.json tiene que declarar
```json
  "dependencies": {{
{deps}
  }},
  "devDependencies": {{
{dev}
  }}
```

## Reglas
1. `{INDEX_CSS}` se importa una vez en `src/main.tsx`; trae Tailwind, tw-animate-css y los tokens mapeados a las variables de shadcn.
2. Color, espacio y radio salen de los tokens: `bg-background text-foreground bg-card border-border bg-primary text-primary-foreground bg-muted text-muted-foreground text-destructive rounded-md`. Nada de hex sueltos ni CSS ad hoc.
3. Un control hecho a mano donde existe el componente (botón con `<div>`, modal casero, select nativo sin estilo) es un bug.
4. Iconos: solo `lucide-react` (`size-4` / `size-5`). Tipografía: la del diseño, cargada por `<link>` en `index.html` y `--font-sans` en tokens.
5. Estados vacío / cargando (`Skeleton`) / error (`Alert` + acción) en todas las vistas.

## Fuentes (licencias verificadas)
{sources_block()}
"""
