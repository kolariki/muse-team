"""
Design phase: before any code is written, the team's Product Designer produces a real, professional UI design
the builder is then obliged to implement — not a paragraph of intentions.

Deliverables (all under design/ in the project):
  design/DESIGN.md     the design system + every key screen specified (layout, hierarchy, components, states, copy)
  design/tokens.css    the tokens as CSS variables (color roles, type scale, spacing, radii, shadows, motion)
  design/mockup.html   a single self-contained hi-fi mockup of the key screens, built with those tokens — what the
                       product must look like, pixel by pixel; it doubles as the first "how it's shaping up" thumbnail
"""
from __future__ import annotations

import json
import re

from .expertise import EXPERTISE

DESIGN_SYSTEM = """Sos un/a Product Designer senior (UX/UI) de nivel Linear / Stripe / Vercel / Apple. Te pasan el BRIEF de un producto
y tu trabajo es DISEÑARLO de verdad, como lo harías en Figma, antes de que el equipo escriba código. El resultado tiene que ser
preciso y hermoso: jerarquía clara, espacio generoso, tipografía cuidada, color con roles, cero decoración gratuita, cero
"plantilla genérica". Nada de lorem ipsum: copy real del dominio del producto.

CÓMO TRABAJÁS: {craft}
TU ESTÁNDAR: {standards}

ENTREGÁS EXACTAMENTE TRES ARCHIVOS, con este protocolo (sin texto fuera de las etiquetas):
<say>en 4-8 líneas: la dirección visual elegida (y por qué encaja con el producto y su usuario), referencias, y qué pantallas diseñaste</say>
<file path="design/DESIGN.md">
# Diseño de <producto>
## 1. Dirección visual — de qué rubro y para quién es, concepto en 2-3 frases, referentes, tono, plataforma(s) y breakpoints; el plan (paleta con nombres, tipografías y rol, layout en una frase + esquema ASCII, 2-3 principios propios) y «Qué cambié para que no sea genérico».
## 2. Sistema
- Paleta con ROLES y HEX exactos: fondo, superficie, superficie elevada, borde, texto primario/secundario/terciario, acento, acento suave, éxito, aviso, error; contraste AA verificado (indicá ratios).
- Tipografía: familias (máx. 2, con fallback del sistema), escala modular con tamaños/pesos/interlineado por nivel (display, h1, h2, h3, body, small, mono).
- Espaciado en escala 4/8/12/16/24/32/48/64, radios, sombras (máx. 3 niveles), grilla y anchos de contenido, iconografía (una librería, un grosor).
- Movimiento: duraciones (150–250 ms) y easings; qué se anima y qué no.
## 3. Componentes — botón (primario/secundario/ghost/destructivo, tamaños, estados hover/focus/disabled/loading), inputs y formularios (labels, ayuda, error en línea), tarjetas, tablas/listas, navegación, badges/estados, toasts, modales, empty states. Para cada uno: medidas, tokens usados, estados.
## 4. Pantallas — para CADA pantalla clave del brief: objetivo, layout (zonas y proporciones), jerarquía (qué se ve primero), componentes, contenido real de ejemplo, estados (vacío / cargando con skeleton / error con acción / éxito), responsive (qué cambia en 360px), accesibilidad (foco, labels, orden), microinteracciones.
## 5. Flujo principal — paso a paso con las pantallas, y los momentos de feedback.
## 6. Checklist de calidad para el constructor — 10-15 ítems verificables (tokens, espaciado, contraste, estados, responsive, foco, copy).
</file>
<file path="design/tokens.css">
:root {{ --color-bg: #…; --color-surface: #…; … --font-sans: …; --text-xs: …; --space-1: 4px; … --radius-md: …; --shadow-sm: …; --ease: …; --dur-fast: 150ms; }}
(todas las variables del sistema, con los mismos nombres que usa DESIGN.md; incluí un bloque @media (prefers-color-scheme: dark) solo si el brief lo pide)
</file>
<file path="design/mockup.html">
UN solo HTML autocontenido (CSS inline en <style>, SIN dependencias externas salvo Google Fonts si definiste una familia; nada de frameworks)
que importa literalmente las variables de tokens.css (copiá el :root dentro del <style>) y muestra las 3-5 pantallas clave del producto
en alta fidelidad, navegables entre sí con JS mínimo (tabs/links), con datos de ejemplo reales del dominio, y al menos un estado vacío y uno de error.
Responsive de verdad (probá mentalmente 360px y 1440px). Tiene que verse como un producto terminado y pulido, no como un wireframe.
</file>

REGLAS: HEX reales, medidas reales, nombres reales. Contraste AA en texto. Un solo acento. Un CTA primario por pantalla. Espaciado en escala.
Si el brief ya fija nombre, tono o paleta, respetalo. Idioma del copy: {language}."""

DESIGN_USER = """BRIEF DEL PRODUCTO:

{brief}

---
Diseñá este producto. Primero decidí la dirección visual (adecuada a su usuario y contexto), después el sistema, después cada pantalla.
Recordá: tres archivos completos, el mockup tiene que ser hermoso y fiel al sistema."""

BUILDER_DESIGN_RULE = """
DISEÑO APROBADO: existe un diseño profesional en design/DESIGN.md (sistema + pantallas), design/tokens.css (variables) y design/mockup.html
(maqueta hi-fi). La interfaz DEBE implementarlo fielmente: usá tokens.css tal cual (copiala al proyecto e importala; nunca valores sueltos),
reproducí la estructura, jerarquía, espaciado, estados y copy de cada pantalla del mockup, y pasá la checklist del final de DESIGN.md.
Si algo del diseño es inviable, acercate lo más posible y anotá la desviación en NOTES.md. Una UI que no coincide con el mockup es un bug."""

ENGINE_DESIGN_PROMPT = """Actuá como Product Designer senior (UX/UI) de nivel Linear / Stripe / Vercel / Apple. Leé BRIEF.md y, ANTES de que se escriba
código, diseñá el producto de verdad: creá design/DESIGN.md (dirección visual, sistema con paleta en HEX y contraste AA, tipografía con escala,
espaciado 4/8, radios, sombras, movimiento; componentes con estados; CADA pantalla clave con layout, jerarquía, contenido real, estados
vacío/cargando/error, responsive 360px, accesibilidad; flujo principal; checklist de calidad), design/tokens.css (todas las variables CSS) y
design/mockup.html (UN HTML autocontenido con las 3-5 pantallas clave en alta fidelidad, usando esos tokens, con datos reales del dominio,
navegable, responsive; tiene que verse como un producto terminado y pulido). Nada de lorem ipsum ni plantillas genéricas. No escribas nada
fuera de design/ en este paso. Al terminar, resumí en 5 líneas la dirección visual elegida y qué pantallas diseñaste."""


# How to design so it does not look generated: adapted (in our words, in Spanish) from Anthropic's «frontend-design» skill,
# Apache License 2.0 (https://github.com/anthropics/skills/tree/main/skills/frontend-design). It lives here, in the code,
# so it reaches every designer and builder run (the skills catalog folder is not shipped to the server).
DESIGN_CRAFT = """
CÓMO DISEÑAR SIN QUE PAREZCA HECHO POR IA (adaptado de la guía «frontend-design» de Anthropic):
1. Partí del rubro. Antes de elegir nada, nombrá el tema, quién lo usa y su tarea principal. Colores, tipografía, imágenes y lo primero
   que se ve salen del mundo de ESE negocio (sus materiales, objetos, vocabulario), no de una plantilla de SaaS: una agenda de peluquería
   no se ve como un panel financiero.
2. Lo primero que se ve es lo más característico del rubro, en la forma que mejor le sienta: un titular, una foto, una demo real, el dato
   que importa. El combo «número grande + etiqueta chica + degradé» solo si de verdad es lo mejor.
3. Tipografía con personalidad: 1 o 2 familias elegidas para ESTE producto (no las que usarías en cualquiera), escala clara, pesos con
   intención, líneas de menos de 80 caracteres. El titular es parte del diseño, no un simple contenedor de texto.
4. Evitá los rasgos que delatan una página generada (salvo que el brief los pida): fondo crema con títulos con serifa y acento terracota;
   fondo casi negro con un único acento ácido; todo cortado en tarjetas iguales con el mismo radio y la misma sombra gris; degradés de
   relleno; etiquetas en MAYÚSCULAS espaciadas arriba de cada título; datos unidos con «·»; monoespaciada para datos chicos; «→» al final
   de botones y links; una sola palabra del titular en otro color o en itálica; marcadores 01/02/03 cuando el contenido no es una secuencia.
5. La estructura informa: bordes, numeración, separadores y etiquetas solo cuando dicen algo del contenido, nunca de adorno.
6. Movimiento con intención: como mucho un momento orquestado al cargar. Nada de aparecer deslizando en cada sección ni hover animado en
   cada tarjeta. Sí animá lo que responde a una acción de la persona (abrir, confirmar, expandir) para mostrar qué cambió.
7. Proceso: primero un plan corto (4-6 colores con nombre y HEX, tipografías y su rol, el layout en una frase y un esquema ASCII, 2-3
   principios propios del producto). Revisalo contra el brief: todo lo que sería igual para cualquier producto parecido, cambialo, y anotá
   qué cambiaste y por qué. Recién ahí diseñás.
8. Audacia en un solo lugar: un elemento memorable y todo lo demás sobrio y disciplinado. Antes de entregar, sacá un adorno.
9. Piso de calidad sin anunciarlo: responsive hasta 360px, foco de teclado visible, respeta «reducir movimiento», contraste AA, paleta armónica.
10. Textos: desde la persona que usa la app y en palabras simples («Avisos», no «webhooks»). Voz activa. El botón dice qué pasa
   («Guardar cambios», no «Enviar») y la acción se llama igual en todo el flujo (botón «Publicar» → aviso «Publicado»). Los errores dicen
   qué pasó y cómo seguir, sin pedir perdón ni ser vagos; un estado vacío invita a hacer algo. Mayúscula solo al inicio de la oración, sin relleno.
"""


def frontend_design_guide(limit: int = 0) -> str:
    """The design craft notes for the designer and the builder (always the same, shipped with the code)."""
    return DESIGN_CRAFT


POLISH_PROMPT = """PULIDO VISUAL OBLIGATORIO (última pasada antes de entregar). La app funciona; ahora tiene que VERSE profesional. Abrí la UI que
construiste al lado de design/mockup.html y design/DESIGN.md y corregí, archivo por archivo, hasta que coincidan:
1. Tipografía: la familia elegida en DESIGN.md cargada de verdad (Google Fonts o self-hosted), escala y pesos aplicados; nada en la fuente
   por defecto del navegador. Títulos con jerarquía clara, cuerpo legible (16px+, interlineado 1.5), líneas < 80 caracteres.
2. Tokens: TODO color, espacio, radio y sombra sale de tokens.css. Si encontrás valores sueltos o colores de sistema (azul link, gris
   #ccc, botones default), reemplazalos.
3. Layout: márgenes y espaciado en la escala 4/8; contenedor con ancho máximo centrado; alineación consistente; en móvil (360px) nada
   desborda ni se encima; la navegación y el CTA principal se ven sin scroll.
4. Componentes: botones con estados hover/focus/disabled, inputs con label y foco visible, tarjetas con jerarquía (no todo con el mismo
   borde y la misma sombra), listas y tablas con ritmo vertical; iconos de UNA librería y un solo grosor. Si el proyecto trae UIKIT.md,
   todo control es el componente de src/components/ui (shadcn) correspondiente: reemplazá los caseros.
5. Estados: vacío con explicación y acción, cargando con skeleton, error con reintento, todos diseñados (no texto suelto en rojo).
6. Primer impacto: la primera pantalla tiene un elemento memorable (dato protagonista, hero, visual del dominio) y el resto queda sobrio.
   Nada de decoración gratuita, gradientes de relleno ni plantilla genérica.
   Sacá los rasgos de página generada de la guía de diseño (etiquetas en mayúsculas espaciadas, «·» entre datos, «→» en botones, tarjetas
   todas iguales, animaciones de entrada en cada sección, una palabra del titular resaltada) salvo que DESIGN.md los pida.
7. Accesibilidad: contraste AA, foco visible, textos alternativos, tamaños de toque ≥ 44px.
8. Textos: botones que dicen qué pasa, la misma palabra para la misma acción en todo el flujo, errores que dicen cómo seguir y estados
   vacíos que invitan a actuar; palabras de la persona usuaria, nunca nombres técnicos.
Hacé los cambios ahora mismo en el código (no me describas lo que harías). Al final listá en 5-10 líneas qué cambiaste y qué quedó
pendiente, y dejá la checklist de DESIGN.md marcada en NOTES.md."""


DESIGN_CRITIC = """Sos un/a Design Director exigente. Mirás capturas REALES de una maqueta ya renderizada (escritorio y celular), como la vería
la persona que encargó el producto. Juzgá solo lo que se ve, nunca lo que el diseño dice que hace. Falla si pasa algo de esto:
1. Se nota sin terminar: fuente por defecto del navegador, texto o elementos encimados o cortados, zonas vacías sin motivo, imágenes rotas.
2. Jerarquía: en tres segundos no se entiende qué es ni qué hacer, compiten varios protagonistas o no se ve la acción principal.
3. Legibilidad: texto chico o con poco contraste, líneas demasiado largas o apretadas.
4. Ritmo: márgenes y separaciones desparejos, cosas que deberían alinearse y no se alinean.
5. Celular: desborda, queda chico para tocar, o es la versión de escritorio achicada.
6. Parece plantilla: podría ser de cualquier otro producto, o trae los rasgos típicos de página generada (tarjetas todas iguales, degradado de relleno, adornos sin función).
La captura de celular está en un marco de 390 px: la franja blanca a su derecha y el corte al final no son parte de la maqueta.
No opines de gustos ni pidas cambios menores: si se ve como un producto profesional, aprobalo.
Respondé SOLO con JSON: {"aprobado": true|false, "problemas": ["qué se ve mal, dónde y cómo corregirlo"]}, máximo 6 problemas, los más graves primero."""


APP_CHECK_PROMPT = """REVISIÓN FINAL DE LA APP TERMINADA. La maqueta ya se revisó; ahora se prueba lo que va a recibir la persona, en un navegador de verdad:
1. Levantá la app como la correría ella y abrila con un navegador sin ventana (Playwright si el proyecto lo trae; si no, `npx playwright`).
2. Recorré el camino principal de BRIEF.md de punta a punta, haciendo clic y cargando datos reales, como alguien que la ve por primera vez.
3. Sacá capturas de cada paso a 1440 px y a 390 px de ancho, abrilas y miralas. Si no podés ver imágenes, medí: nada desborda, nada se encima, sin errores en la consola.
4. Comparalas con design/mockup.html y corregí lo que se ve mal o no funciona: pasos rotos, errores en la consola, pantallas distintas a la maqueta, textos encimados o cortados, estados vacíos sin terminar.
Solo corregí: no agregues funciones ni cambies la dirección visual. Borrá las capturas al terminar y dejá las pruebas en verde.
Terminá en 3-6 líneas, en palabras simples: qué probaste, qué corregiste y qué sigue sin funcionar, si algo no quedó."""

APP_CRITIC_NOTE = "Estas capturas son de la app ya construida y funcionando, no de una maqueta. La de celular es la pantalla de inicio en un marco de 390 px."

DIRECTION_RE = re.compile(r"<!--\s*nombre:\s*(.+?)\s*\|\s*por qu[eé]:\s*(.+?)\s*-->", re.S | re.I)
DIRECTIONS_DIR = "design/direcciones"

DIRECTIONS_PROMPT = """Antes del diseño completo, la persona va a elegir entre TRES direcciones visuales. Leé el brief y escribí tres archivos: design/direcciones/1.html, 2.html y 3.html.
Cada uno es la pantalla más importante del producto, terminada: un HTML autocontenido (CSS en <style>; Google Fonts por <link> si hace falta; sin frameworks), responsive, con textos reales del rubro. Nada de lorem ipsum ni de una galería de opciones: una sola pantalla, como quedaría de verdad. Si el brief no trae precios, teléfonos u otros datos del negocio, no los inventes: dejá el lugar con un texto que se note de ejemplo.
Tienen que ser realmente distintas: otra paleta, otra tipografía, otra distribución y otro tono. Si dos se pueden confundir de lejos, cambiá una. Las tres cumplen el brief y se ven profesionales: no hagas una mala para que gane otra.
La primera línea de cada archivo es exactamente: <!-- nombre: dos o tres palabras | por qué: una frase simple sobre para quién o por qué funciona -->
Sé breve: cada archivo, como máximo 150 líneas. Idioma de los textos: {language}."""

INSPIRATION_NOTE = """
INSPIRACIÓN: en design/inspiracion/ hay capturas de sitios con muy buen diseño. Abrilas antes de diseñar y subí la vara: que tus direcciones se animen como esas. Tomá ideas (composición, jerarquía, ritmo, audacia) y combiná las de varias: ninguna dirección puede ser la versión de un solo sitio con otros colores. Colores, tipografías, textos e imágenes son propios; nunca uses sus logos, fotos ni marcas."""

INSPIRATION_READ = """Sos Director de Arte. Mirás capturas de sitios con muy buen diseño y le pasás a tu diseñador, en menos de 300 palabras, las ideas que puede combinar para un producto nuevo: composición, jerarquía, ritmo, tipografía, uso del color, qué se anima a hacer cada una. Describí ideas, no marcas, y no le pidas copiar ninguna."""

INSPIRATION_TEXT_NOTE = """
INSPIRACIÓN: tu Director de Arte miró sitios con muy buen diseño y anotó ideas. Subí la vara con ellas y combiná varias; colores, tipografías, textos e imágenes son propios.
{notes}"""

DIRECTIONS_API_FORMAT = """
Entregá solo esto, sin texto afuera: <say>una línea</say><file path="design/direcciones/1.html">…</file><file path="design/direcciones/2.html">…</file><file path="design/direcciones/3.html">…</file>"""

DIRECTIONS_ENGINE_FORMAT = "\nEscribí los tres archivos directamente. No escribas nada más, ni fuera de design/direcciones/."


def read_directions(files: dict[str, str]) -> list[dict]:
    """The directions the designer wrote, in order: {name, why, html}."""
    out = []
    for i in (1, 2, 3):
        html = files.get(f"{DIRECTIONS_DIR}/{i}.html")
        if html and "<" in html:
            m = DIRECTION_RE.search(html[:600])
            out.append({"name": m.group(1).strip()[:60] if m else f"Dirección {i}", "why": m.group(2).strip()[:220] if m else "", "html": html})
    return out


def direction_note(direction: dict | None, wish: str = "") -> str:
    if not direction:
        return ""
    return (f"\n\nDIRECCIÓN ELEGIDA POR LA PERSONA (manda: desarrollala en todas las pantallas, no la reemplaces): {direction['name']}. {direction['why']}"
            f"{' Pidió además: ' + wish if wish else ''}\n\nPantalla de muestra de esa dirección:\n{direction['html'][:24000]}")


def parse_design_critique(text: str) -> list[str] | None:
    """The problems the critic found: [] when approved, None when the answer can't be read (the design then goes on unchanged)."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(d, dict) or not isinstance(d.get("aprobado"), bool):
        return None
    if d["aprobado"]:
        return []
    return [str(x) for x in (d.get("problemas") or []) if str(x).strip()][:6] or None


def design_system_prompt(language: str = "español", platform: str = "web") -> str:
    from . import uikit

    e = EXPERTISE["product-designer"]
    return DESIGN_SYSTEM.format(craft=e["craft"], standards=e["standards"], language=language) + uikit.designer_block(platform) + frontend_design_guide()


def design_context_for_builder(files: dict[str, str]) -> str:
    """What the API builder gets in its first message so it can follow the design without re-reading the tree."""
    md = files.get("design/DESIGN.md", "")
    css = files.get("design/tokens.css", "")
    mock = files.get("design/mockup.html", "")
    if not (md or css):
        return ""
    return (f"\n\n===== design/DESIGN.md =====\n{md[:14000]}\n\n===== design/tokens.css =====\n{css[:6000]}\n\n"
            f"===== design/mockup.html (extracto: estructura y estilos a replicar) =====\n{mock[:12000]}\n")


MOCK_DESIGN = """<say>**Dirección visual: sobria y precisa**, tipo herramienta profesional (referencias: Linear, Stripe). Paleta neutra con un acento verde; tipografía Inter; mucho aire. Diseñé 3 pantallas: inicio, detalle y ajustes.</say>
<file path="design/DESIGN.md">
# Diseño de {title}
## 1. Dirección visual
Sobria, precisa, confiable. Referencias: Linear, Stripe. Web responsive, breakpoints 360/768/1024/1440.
## 2. Sistema
- Paleta: bg #F7F8F7, surface #FFFFFF, border #E3E7E4, text #1B2320 (AA 14.9:1), text-2 #566059, accent #2F6B5D, ok #2E7D5B, warn #B8860B, error #B3382C.
- Tipografía: Inter; display 32/40 600, h1 24/32 600, h2 18/26 600, body 14/22 400, small 12/18 400.
- Espaciado 4/8/12/16/24/32/48; radio 8/12; sombra sm/md.
## 3. Componentes
Botón primario (accent, 36px, radio 8), secundario (borde), inputs 36px con label arriba y error en línea, tarjetas radio 12, tabla con zebra sutil.
## 4. Pantallas
### Inicio — lista de ítems con buscador y CTA "Nuevo"; vacío: ilustración + CTA; cargando: skeleton; error: mensaje + reintentar.
### Detalle — cabecera con título y estado, dos columnas (datos / actividad).
### Ajustes — formulario en una columna de 560px.
## 5. Flujo principal
Inicio → Nuevo → Detalle → guardado con toast.
## 6. Checklist
- tokens.css importado · espaciado en escala · contraste AA · estados vacío/cargando/error · foco visible · responsive 360px
</file>
<file path="design/tokens.css">
:root {{ --color-bg: #F7F8F7; --color-surface: #FFFFFF; --color-border: #E3E7E4; --color-text: #1B2320; --color-text-2: #566059; --color-accent: #2F6B5D; --color-ok: #2E7D5B; --color-warn: #B8860B; --color-error: #B3382C; --font-sans: Inter, system-ui, sans-serif; --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px; --radius-md: 8px; --radius-lg: 12px; --shadow-sm: 0 1px 2px rgba(0,0,0,.06); --dur-fast: 150ms; --ease: cubic-bezier(.2,.8,.2,1); }}
</file>
<file path="design/mockup.html">
<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · mockup</title>
<style>:root {{ --color-bg: #F7F8F7; --color-surface: #FFFFFF; --color-border: #E3E7E4; --color-text: #1B2320; --color-text-2: #566059; --color-accent: #2F6B5D; --space-4: 16px; --space-6: 24px; --radius-lg: 12px; --font-sans: Inter, system-ui, sans-serif; }}
body {{ margin:0; font-family: var(--font-sans); background: var(--color-bg); color: var(--color-text); }} header {{ display:flex; align-items:center; gap:16px; padding: 12px 24px; background: var(--color-surface); border-bottom:1px solid var(--color-border); }}
main {{ padding: 24px; max-width: 1100px; margin: 0 auto; }} .card {{ background: var(--color-surface); border:1px solid var(--color-border); border-radius: var(--radius-lg); padding: 16px; }} .btn {{ background: var(--color-accent); color:#fff; border:0; border-radius:8px; padding: 8px 14px; font-weight:600; }}
.grid {{ display:grid; grid-template-columns: repeat(auto-fill, minmax(260px,1fr)); gap:16px; }} .muted {{ color: var(--color-text-2); font-size:13px; }}</style></head>
<body><header><strong>{title}</strong><span class="muted">Inicio · Detalle · Ajustes</span><button class="btn" style="margin-left:auto">Nuevo</button></header>
<main><h1 style="font-size:24px;margin:0 0 16px">Inicio</h1><div class="grid"><div class="card"><strong>Ítem de ejemplo</strong><p class="muted">Estado: activo · actualizado hoy</p></div><div class="card"><strong>Otro ítem</strong><p class="muted">Estado: pendiente</p></div></div>
<div class="card" style="margin-top:24px;text-align:center"><p class="muted">Todavía no hay nada acá. Creá el primero.</p><button class="btn">Nuevo</button></div></main></body></html>
</file>"""
