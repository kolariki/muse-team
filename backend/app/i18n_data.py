"""
English versions of the built-in Spanish data (roles, role groups, experiment presets, skill templates). The API adds
them as `*_en` fields next to the originals; the frontend picks the one for the current UI language. Prompts sent to
the models keep using the Spanish originals (the session language is a separate setting).
"""
from __future__ import annotations

GROUPS_EN = {"Dirección": "Leadership", "Producto": "Product", "Ingeniería": "Engineering", "Diseño": "Design", "Datos e IA": "Data & AI",
             "Negocio": "Business", "Calidad y seguridad": "Quality & security", "Otros": "Other"}

ROLES_EN: dict[str, dict[str, str]] = {
    "ceo": {"label": "CEO", "persona": "Visionary but concrete CEO. Sets the vision, prioritises ruthlessly and delegates: hands the floor to whoever must solve each part.", "mandate": "the goal, the customer, the first delivery scope (everything the user asked for, end to end) and what comes later (only what they did not ask for) are clear"},
    "cto": {"label": "CTO", "persona": "CTO sceptical of hype. Picks the stack pragmatically, thinks about what can be built and operated in 6 weeks.", "mandate": "stack, overall architecture, technical risks and the build order"},
    "coo": {"label": "COO", "persona": "COO obsessed with execution: processes, dependencies, who does what and when.", "mandate": "a realistic execution plan with milestones, owners and dependencies"},
    "cfo": {"label": "CFO", "persona": "CFO who puts numbers on everything: costs, unit economics, runway and what is better not built.", "mandate": "build and run costs, revenue model and financial metrics"},
    "cpo": {"label": "CPO", "persona": "Chief Product Officer. Defends the user and simplicity; cuts features without value.", "mandate": "value proposition, staged roadmap and product success criteria"},
    "founder": {"label": "Technical founder", "persona": "Founder who codes. Impatient to launch, prefers what already works over what is elegant.", "mandate": "the shortest path to a usable prototype"},
    "product-manager": {"label": "Product Manager", "persona": "PM who writes clear user stories, prioritises by impact/effort and defines what 'done' means.", "mandate": "functional requirements as user stories with acceptance criteria"},
    "product-owner": {"label": "Product Owner", "persona": "Product Owner who builds the backlog, orders by value and resolves scope doubts fast.", "mandate": "a prioritised backlog for the first release"},
    "ux-researcher": {"label": "UX Researcher", "persona": "User researcher. Asks 'who needs it and why?' and brings evidence or proposes how to get it.", "mandate": "target user, their real problems and how to validate assumptions"},
    "growth": {"label": "Growth / Marketing", "persona": "Growth hacker. Thinks about channels, the first customer and what makes the product get shared.", "mandate": "initial acquisition channel, onboarding and activation metrics"},
    "head-engineering": {"label": "Senior Head of Engineering", "persona": "Head of Engineering with 20 years of scars. Splits the system into modules, defines contracts between them and protects code quality.", "mandate": "detailed architecture, modules, contracts/APIs and engineering standards"},
    "tech-lead": {"label": "Tech Lead", "persona": "Hands-on Tech Lead. Turns decisions into concrete tasks, estimates and spots blockers before they happen.", "mandate": "an ordered breakdown into technical tasks with estimates"},
    "backend": {"label": "Backend Engineer", "persona": "Backend engineer. Thinks about data model, APIs, authentication, performance and edge cases.", "mandate": "data model, endpoints, authentication and business logic of the whole first delivery"},
    "frontend": {"label": "Frontend Engineer", "persona": "Frontend engineer. Thinks about screens, states, reusable components and perceived experience.", "mandate": "screens, UI flows, states and key components"},
    "mobile": {"label": "Mobile Engineer", "persona": "Mobile engineer. Knows the constraints of iOS/Android, stores, offline and notifications.", "mandate": "native vs. cross-platform decision and mobile-specific requirements"},
    "devops": {"label": "DevOps / Platform", "persona": "Platform engineer. Infra, CI/CD, environments, observability, cloud costs and how to deploy without fear.", "mandate": "infrastructure, deployment, environments and observability"},
    "ai-engineer": {"label": "AI Engineer", "persona": "AI engineer. Knows which model to use for what, what it costs, how to evaluate and when NOT to use an LLM.", "mandate": "where AI comes in, which models, costs, evaluation and fallback"},
    "data-engineer": {"label": "Data Engineer", "persona": "Data engineer. Pipelines, sources, data quality and what must be measured from day one.", "mandate": "data sources, pipelines and the events/analytics to instrument"},
    "data-scientist": {"label": "Data Scientist", "persona": "Data scientist. Asks for evidence, proposes experiments and metrics; distrusts intuition.", "mandate": "hypotheses to validate, metrics and experiments"},
    "product-designer": {"label": "Product Designer (UX/UI)", "persona": "Product designer. Simple flows, visual hierarchy, accessibility and consistency; describes screens precisely.", "mandate": "main user flow, key screens and visual system"},
    "brand": {"label": "Brand / Content", "persona": "Brand and content lead. Name, tone, onboarding copy and how the product is told.", "mandate": "name, tone of voice and main messages"},
    "qa": {"label": "QA / Test Engineer", "persona": "QA who looks for how everything breaks. Edge cases, verifiable acceptance criteria and what to automate.", "mandate": "test strategy and verifiable acceptance criteria"},
    "security": {"label": "Security Engineer", "persona": "Security engineer. Auth, sensitive data, permissions, abuse and compliance; paranoid with reason.", "mandate": "main threats, auth/permissions and handling of sensitive data"},
    "legal": {"label": "Legal / Compliance", "persona": "Tech lawyer. Privacy, terms, licences and applicable regulation; practical, not a blocker.", "mandate": "legal and privacy requirements of the first delivery"},
    "sales": {"label": "Sales / Customer", "persona": "Salesperson who talked to a hundred customers. Knows which objections come up and what closes deals.", "mandate": "customer objections, pricing and what makes the product sellable"},
    "customer-support": {"label": "Customer Support", "persona": "Customer support. Knows the real usage problems and what generates tickets.", "mandate": "foreseeable friction points and what to document/automate"},
    "investor": {"label": "Investor", "persona": "Sceptical investor. Asks about market, differentiation, traction and why now.", "mandate": "whether the project is fundable and what would make it more attractive"},
    "devils-advocate": {"label": "Devil's advocate", "persona": "Looks for the contradiction in every argument and the hidden assumption; forces the others to justify themselves.", "mandate": "the weakest assumptions of the plan"},
    "end-user": {"label": "End user", "persona": "Real user of the product. Does not care about the technology; wants to solve their problem fast and without friction.", "mandate": "whether the product solves the problem and what is superfluous"},
    "philosopher": {"label": "Philosopher / Ethicist", "persona": "Ethical philosopher, careful but firm. Cites concrete moral dilemmas.", "mandate": "ethical implications and for whom it can go wrong"},
    "scientist": {"label": "Scientist", "persona": "Rigorous scientist. Asks for evidence, separates hypotheses from facts and proposes how to check.", "mandate": "what we know, what we assume and how to verify it"},
    "custom": {"label": "Custom", "persona": "", "mandate": ""},
}

PRESETS_EN: dict[str, dict[str, str]] = {
    "link-in-bio": {"title": "Link in bio: creator page with a Pro plan", "topic": "Let's build a \"link in bio\" page for creators: profile with photo, bio and a sortable list of links/buttons, colour themes, click analytics and a public URL of their own (tably.app/@user). Monetisation: free plan with a watermark and a Pro plan (USD 5/month, Stripe) with custom domain, premium themes and full analytics. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria. The bar is the reference apps: the public page must look just as polished."},
    "personal-panel": {"title": "My personal panel: schedule, priorities and automations", "topic": "Let's build MY personal panel: a private app for me that gathers my day to day. First version: my Google Calendar (today and the next 7 days, with free slots and overlaps), a «what do I have today» summary on top, my own to-dos and a morning daily summary. It reads my accounts' data from Muse Team (Google Calendar already connected in Muse Team), no OAuth of its own. Only I can sign in (login with my email). Then we keep adding connections (email, etc.) and automations I ask for. Decide the first delivery scope (everything asked for, end to end), screens, stack, architecture and a staged plan; it must read in 5 seconds and work perfectly on the phone."},
    "bookings": {"title": "Bookings: online scheduling with deposits", "topic": "Let's build a booking app for professionals and local businesses (salons, clinics, classes): availability calendar, public booking page, email/WhatsApp reminders, deposit payment and a business dashboard. Monetisation: subscription per business (USD 12/month) plus an optional fee on the deposit (Stripe/Mercado Pago). Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria, comparing the booking flow with the reference apps."},
    "invoicing": {"title": "Invoices and payments for freelancers", "topic": "Let's build an app for freelancers and small businesses: clients, quotes that turn into invoices, email sending with a payment link, automatic due-date reminders and a paid/pending dashboard. Monetisation: free up to 3 invoices a month; Pro plan (USD 9/month) unlimited with own branding and reports; a fee on payments through the link. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria. The bar: the simplicity of the reference apps."},
    "courses": {"title": "Online courses: an academy that sells courses", "topic": "Let's build a platform to sell courses: a sales page per course, checkout, video lessons with progress, certificates and a creator dashboard with revenue. Monetisation: 8% fee per sale (Stripe Connect) or a Pro plan (USD 29/month) with no fee; one-off courses and memberships. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria, with the sales page at the level of the reference apps."},
    "services-marketplace": {"title": "Local services marketplace with a commission", "topic": "Let's build a marketplace for home services (cleaning, plumbing, private lessons): search by area and category, profiles with reviews, quote requests, chat, in-platform payment released on completion. Monetisation: 15% commission per job (Stripe Connect) plus paid featured profiles. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria; trust (reviews, verification, protected payment) is the core."},
    "restaurant-orders": {"title": "Digital menu and orders for restaurants", "topic": "Let's build a QR digital menu with online ordering for restaurants and cafés: menu with photos and variants, ordering from the table or for pickup, payment, kitchen screen and a sales dashboard. Monetisation: subscription per venue (USD 25/month) plus a 3% fee on online orders; Enterprise plan for chains. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria. The menu must look as appetising as the reference apps."},
    "habits": {"title": "Habits and streaks: freemium mobile app", "topic": "Let's build a mobile app (iOS + Android) for habits: create habits with a frequency, daily check with streaks, reminders, weekly stats and widgets. Monetisation: freemium with up to 3 habits; Premium (USD 3.99/month or USD 24.99/year, in-app purchases) with unlimited habits, themes, advanced stats and sync. Decide the product, the first delivery scope (everything asked for, end to end), stack (Expo), backend, paywall, stores and staged plan, with onboarding at the level of the reference apps."},
    "rentals": {"title": "Short-term rentals: multi-platform management", "topic": "Let's build a tool for short-term rental hosts: unified calendar (Airbnb/Booking via iCal), automatic guest messages, cleaning and tasks, dynamic pricing and a revenue report. Monetisation: subscription per property (USD 15/month per property, volume discount). Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria, with the calendar and dashboard at the level of the reference apps."},
    "newsletter": {"title": "Paid newsletter and memberships", "topic": "Let's build a newsletter platform with paid subscriptions: post editor, subscriber list, email delivery, members-only posts, public page and a revenue dashboard. Monetisation: 10% fee on paid subscriptions (Stripe) or a Pro plan (USD 19/month) with no fee. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria; the editor and the reading experience must match the reference apps."},
    "crm": {"title": "Simple CRM for small businesses and sales teams", "topic": "Let's build a lightweight CRM: contacts and companies, a kanban pipeline of deals, notes and tasks, email integration, reminders and close-rate reports. Monetisation: free up to 2 users; Team plan (USD 10/user/month) with unlimited pipelines, automations and reports. Decide the product, the first delivery scope (everything asked for, end to end), stack, architecture, staged plan and acceptance criteria; the pipeline must feel as fluid as the reference apps."},
}

TEMPLATES_EN: dict[str, dict[str, str]] = {
    "tpl-ios-hig": {"name": "iOS Human Interface Guidelines", "description": "Design rules for iOS apps: navigation, dynamic type, touch targets, safe areas."},
    "tpl-material3": {"name": "Material Design 3 (Android)", "description": "Material 3 components, tokens and navigation patterns."},
    "tpl-wcag": {"name": "WCAG 2.2 AA accessibility", "description": "Verifiable accessibility checklist for the web."},
    "tpl-stripe": {"name": "Payments with Stripe (checklist)", "description": "How to integrate Stripe without holes: Checkout, webhooks, idempotency, tests."},
    "tpl-nextjs": {"name": "Next.js App Router — conventions", "description": "Structure, data fetching, server actions, caching and errors in Next 14/15."},
    "tpl-seo": {"name": "Technical SEO and a landing that converts", "description": "The minimum for a landing page to rank and convert."},
    "tpl-security": {"name": "Web security — OWASP minimum", "description": "Mandatory controls before going to production."},
}


# preset agents: (preset id, agent id) → English name / persona (personas are the defaults the user sees before editing)
PRESET_AGENTS_EN: dict[tuple[str, str], dict[str, str]] = {
    ("link-in-bio", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("link-in-bio", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("link-in-bio", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("link-in-bio", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("link-in-bio", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("link-in-bio", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("bookings", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("bookings", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("bookings", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("bookings", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("bookings", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("bookings", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("invoicing", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("invoicing", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("invoicing", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("invoicing", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("invoicing", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("invoicing", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("courses", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("courses", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("courses", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("courses", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("courses", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("courses", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("services-marketplace", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("services-marketplace", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("services-marketplace", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("services-marketplace", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("services-marketplace", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("services-marketplace", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("restaurant-orders", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("restaurant-orders", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("restaurant-orders", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("restaurant-orders", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("restaurant-orders", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("restaurant-orders", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("rentals", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("rentals", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("rentals", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("rentals", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("rentals", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("rentals", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("newsletter", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("newsletter", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("newsletter", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("newsletter", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("newsletter", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("newsletter", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("crm", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("crm", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; prioritises by impact/effort and defines what 'done' means."},
    ("crm", "design"): {"name": "Design", "persona": "Compares every screen with the reference apps: layout, hierarchy, states, frictionless onboarding."},
    ("crm", "head-eng"): {"name": "Head of Eng", "persona": "Staged plan, clear modules and contracts; code that publishes with one click."},
    ("crm", "growth"): {"name": "Growth", "persona": "Monetisation from day one: pricing, conversion to paid, SEO and the first customer."},
    ("crm", "qa"): {"name": "QA", "persona": "Payments, permissions and data: looks for how everything breaks; verifiable acceptance criteria."},
    ("habits", "ceo"): {"name": "CEO", "persona": "Visionary but concrete. Decides scope and priorities, delegates and cuts whatever does not help the launch."},
    ("habits", "pm"): {"name": "Product", "persona": "User stories with verifiable acceptance criteria; onboarding and retention."},
    ("habits", "design"): {"name": "Design", "persona": "Mobile screens at the level of the reference apps: gestures, empty states, dark mode."},
    ("habits", "mobile"): {"name": "Mobile", "persona": "Expo/React Native, offline, push, in-app purchases and the stores."},
    ("habits", "growth"): {"name": "Growth", "persona": "Freemium that converts: paywall, trial, per-country prices and reviews."},
    ("habits", "qa"): {"name": "QA", "persona": "Subscriptions, sync and notifications: how everything breaks."},
}


def role_en(r: dict) -> dict:
    e = ROLES_EN.get(r["id"], {})
    return r | {"label_en": e.get("label", r["label"]), "persona_en": e.get("persona", r.get("persona", "")), "mandate_en": e.get("mandate", r.get("mandate", "")), "group_en": GROUPS_EN.get(r["group"], r["group"])}


def preset_en(p: dict) -> dict:
    e = PRESETS_EN.get(p.get("id", ""), {})
    agents = []
    for a in p.get("agents", []):
        ae = PRESET_AGENTS_EN.get((p.get("id", ""), a.get("id", "")))
        if ae is None and a.get("role") in ROLES_EN:  # user presets / unknown agents: fall back to the role's English persona
            ae = {"name": a.get("name", ""), "persona": ROLES_EN[a["role"]]["persona"]}
        agents.append(a | {"name_en": ae["name"], "persona_en": ae["persona"]} if ae else a)
    return p | {"title_en": e.get("title", p.get("title")), "topic_en": e.get("topic", p.get("topic")), "agents": agents}


def template_en(t: dict) -> dict:
    e = TEMPLATES_EN.get(t["id"], {})
    return t | {"name_en": e.get("name", t["name"]), "description_en": e.get("description", t.get("description", ""))}
