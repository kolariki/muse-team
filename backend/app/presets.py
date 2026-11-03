"""Ready-made experiments: apps that can be built AND monetised, each with the reference apps the team benchmarks first
(research with a real browser, and reverse engineering with REA when the user turns it on), so the result lands at the level of the best in its category.
`provider` is a preference: the API swaps unconfigured providers for "mock" when `fallback=true`."""

_TEAM_WEB = [
    {"id": "ceo", "role": "ceo", "name": "CEO", "provider": "anthropic", "persona": "Visionario pero concreto. Decide alcance y prioridades, delega y corta lo que no suma al lanzamiento."},
    {"id": "pm", "role": "product-manager", "name": "Product", "provider": "deepseek", "persona": "Historias de usuario con criterios de aceptación verificables; prioriza por impacto/esfuerzo y define qué es 'terminado'."},
    {"id": "design", "role": "product-designer", "name": "Diseño", "provider": "anthropic", "persona": "Compara cada pantalla con los referentes: layout, jerarquía, estados, onboarding sin fricción."},
    {"id": "head-eng", "role": "head-engineering", "name": "Head of Eng", "provider": "openai", "persona": "Plan por etapas, módulos y contratos claros; código que se publica con un clic."},
    {"id": "growth", "role": "growth", "name": "Growth", "provider": "gemini", "persona": "Monetización desde el día uno: pricing, conversión a pago, SEO y primer cliente."},
    {"id": "qa", "role": "qa", "name": "QA", "provider": "openai", "persona": "Pagos, permisos y datos: busca cómo se rompe todo; criterios de aceptación verificables."},
]

_TEAM_MOBILE = [
    {"id": "ceo", "role": "ceo", "name": "CEO", "provider": "anthropic", "persona": "Visionario pero concreto. Decide alcance y prioridades, delega y corta lo que no suma al lanzamiento."},
    {"id": "pm", "role": "product-manager", "name": "Product", "provider": "deepseek", "persona": "Historias de usuario con criterios de aceptación verificables; onboarding y retención."},
    {"id": "design", "role": "product-designer", "name": "Diseño", "provider": "anthropic", "persona": "Pantallas móviles al nivel de los referentes: gestos, estados vacíos, dark mode."},
    {"id": "mobile", "role": "mobile", "name": "Mobile", "provider": "gemini", "persona": "Expo/React Native, offline, push, compras in-app y las stores."},
    {"id": "growth", "role": "growth", "name": "Growth", "provider": "gemini", "persona": "Freemium que convierte: paywall, trial, precios por país y reseñas."},
    {"id": "qa", "role": "qa", "name": "QA", "provider": "openai", "persona": "Suscripciones, sincronización y notificaciones: cómo se rompe todo."},
]


def _p(id_: str, title: str, topic: str, refs: list[str], *, platform: str = "web", team: list[dict] | None = None, max_turns: int = 14, emoji: str = "🚀") -> dict:
    return {"id": id_, "title": title, "emoji": emoji, "topic": topic, "mode": "handoff", "max_turns": max_turns, "platform": platform,
            "references": refs, "agents": [dict(a) for a in (team or (_TEAM_MOBILE if platform == "mobile" else _TEAM_WEB))]}


_TEAM_PERSONAL = [
    {"id": "pm", "role": "product-manager", "name": "Product", "provider": "deepseek", "persona": "Piensa en el día a día de UNA persona: qué necesita ver a primera hora, qué la distrae, qué automatizar. Alcance chico y útil desde el primer día."},
    {"id": "design", "role": "product-designer", "name": "Diseño", "provider": "anthropic", "persona": "Un panel que se lee en 5 segundos: jerarquía clara, lo urgente arriba, estados vacíos amables, móvil primero."},
    {"id": "head-eng", "role": "head-engineering", "name": "Head of Eng", "provider": "openai", "persona": "Datos de las cuentas del usuario siempre a través de Muse Team (nunca OAuth propio), caché, tareas programadas y cero claves en el navegador."},
    {"id": "qa", "role": "qa", "name": "QA", "provider": "openai", "persona": "Privacidad y fallas: cuenta sin conectar, token vencido, días sin eventos, zonas horarias; nada se rompe ni expone datos."},
]

PRESETS = [
    _p("personal-panel", "Mi panel personal: agenda, prioridades y automatizaciones",
       "Construyamos MI panel personal: una app privada para mí que junta lo de mi día a día. Primera versión: mi agenda de Google Calendar (hoy y los próximos 7 días, "
       "con los huecos libres y lo que se superpone), un resumen de «qué tengo hoy» arriba de todo, tareas/pendientes propios y un resumen diario a la mañana. "
       "Los datos de mis cuentas los lee de Muse Team (Google Calendar ya conectado en Muse Team), sin OAuth propio. Solo yo entro (login con mi email). "
       "Después vamos sumando conexiones (email, etc.) y automatizaciones que yo pida. "
       "Decidan alcance de la primera entrega (todo lo pedido, de punta a punta), pantallas, stack, arquitectura y plan por etapas; que se lea en 5 segundos y funcione perfecto en el celular.",
       ["https://www.sunsama.com", "https://www.usemotion.com", "https://akiflow.com"], team=_TEAM_PERSONAL, emoji="🗂️"),
    _p("link-in-bio", "Link in bio: página de creador con plan Pro",
       "Construyamos una página «link in bio» para creadores: perfil con foto, bio y lista de links/botones ordenables, temas de color, analytics de clics y una URL pública propia (tably.app/@usuario). "
       "Monetización: plan gratis con marca de agua y plan Pro (USD 5/mes, Stripe) con dominio propio, temas premium y analytics completos. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación. La vara son los referentes: la página pública tiene que verse igual de pulida.",
       ["https://linktr.ee", "https://bento.me", "https://beacons.ai"], emoji="🔗"),
    _p("bookings", "Turnos y reservas: agenda online con cobro de seña",
       "Construyamos una app de turnos para profesionales y locales (peluquerías, consultorios, clases): calendario con disponibilidad, página pública de reserva, recordatorios por email/WhatsApp, cobro de seña y panel del negocio. "
       "Monetización: suscripción por negocio (USD 12/mes) + comisión opcional sobre la seña (Stripe/Mercado Pago). "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación, comparando el flujo de reserva con los referentes.",
       ["https://cal.com", "https://calendly.com", "https://booksy.com"], emoji="📅"),
    _p("invoicing", "Facturas y cobros para freelancers",
       "Construyamos una app para freelancers y pymes: clientes, presupuestos que se convierten en facturas, envío por email con link de pago, recordatorios automáticos de vencimiento y un panel de cobrado/pendiente. "
       "Monetización: gratis hasta 3 facturas por mes; plan Pro (USD 9/mes) ilimitado con marca propia y reportes; comisión sobre pagos con link. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación. La vara: la simplicidad de los referentes.",
       ["https://www.waveapps.com", "https://www.hellobonsai.com", "https://www.invoicesimple.com"], emoji="🧾"),
    _p("courses", "Cursos online: academia con venta de cursos",
       "Construyamos una plataforma para vender cursos: página de venta por curso, checkout, lecciones en video con progreso, certificados y panel del creador con ingresos. "
       "Monetización: comisión del 8% por venta (Stripe Connect) o plan Pro (USD 29/mes) sin comisión; cursos de pago único y membresías. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación, con la página de venta al nivel de los referentes.",
       ["https://teachable.com", "https://gumroad.com", "https://www.podia.com"], emoji="🎓"),
    _p("services-marketplace", "Marketplace de servicios locales con comisión",
       "Construyamos un marketplace de servicios a domicilio (limpieza, plomería, clases particulares): búsqueda por zona y categoría, perfiles con reseñas, pedido de presupuesto, chat, pago en la plataforma y liberación al terminar. "
       "Monetización: comisión del 15% por trabajo (Stripe Connect) + perfiles destacados pagos. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación; la confianza (reseñas, verificación, pago protegido) es el centro.",
       ["https://www.thumbtack.com", "https://www.taskrabbit.com", "https://www.fiverr.com"], emoji="🧰"),
    _p("restaurant-orders", "Menú digital y pedidos para restaurantes",
       "Construyamos un menú digital con QR y pedidos online para restaurantes y cafés: carta con fotos y variantes, pedido desde la mesa o para retirar, pago, pantalla de cocina y panel con ventas. "
       "Monetización: suscripción por local (USD 25/mes) + comisión del 3% en pedidos online; plan Enterprise para cadenas. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación. La carta tiene que verse tan apetitosa como la de los referentes.",
       ["https://pos.toasttab.com", "https://www.olo.com", "https://fu.do"], emoji="🍽️"),
    _p("habits", "Hábitos y rachas: app móvil freemium",
       "Construyamos una app móvil (iOS + Android) de hábitos: crear hábitos con frecuencia, check diario con racha, recordatorios, estadísticas semanales y widgets. "
       "Monetización: freemium con hasta 3 hábitos; Premium (USD 3.99/mes o USD 24.99/año, compras in-app) con hábitos ilimitados, temas, estadísticas avanzadas y sincronización. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack (Expo), backend, paywall, stores y plan por etapas, con el onboarding al nivel de los referentes.",
       ["https://www.habitify.me", "https://streaksapp.com", "https://todoist.com"], platform="mobile", emoji="✅"),
    _p("rentals", "Alquileres temporarios: gestión multi-plataforma",
       "Construyamos una herramienta para anfitriones de alquiler temporario: calendario unificado (Airbnb/Booking por iCal), mensajes automáticos a huéspedes, limpieza y tareas, precios dinámicos y reporte de ingresos. "
       "Monetización: suscripción por propiedad (USD 15/mes por propiedad, con descuento por volumen). "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación, con el calendario y el panel al nivel de los referentes.",
       ["https://www.hospitable.com", "https://www.guesty.com", "https://www.airbnb.com"], emoji="🏠"),
    _p("newsletter", "Newsletter paga y membresías",
       "Construyamos una plataforma de newsletters con suscripciones de pago: editor de posts, lista de suscriptores, envío por email, posts solo para miembros, página pública y panel con ingresos. "
       "Monetización: comisión del 10% sobre suscripciones pagas (Stripe) o plan Pro (USD 19/mes) sin comisión. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación; el editor y la lectura tienen que estar al nivel de los referentes.",
       ["https://substack.com", "https://www.beehiiv.com", "https://www.patreon.com"], emoji="📰"),
    _p("crm", "CRM simple para pymes y equipos de venta",
       "Construyamos un CRM liviano: contactos y empresas, pipeline kanban de oportunidades, notas y tareas, integración de email, recordatorios y reportes de cierre. "
       "Monetización: gratis hasta 2 usuarios; plan Team (USD 10/usuario/mes) con pipelines ilimitados, automatizaciones y reportes. "
       "Decidan producto, alcance de la primera entrega (todo lo pedido, de punta a punta), stack, arquitectura, plan por etapas y criterios de aceptación; el pipeline tiene que ser tan fluido como el de los referentes.",
       ["https://www.pipedrive.com", "https://www.folk.app", "https://www.hubspot.com"], emoji="📈"),
]
