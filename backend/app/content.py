"""Public content for search engines and answer engines: the blog, the FAQ and the machine-readable files around them.

Articles live in content/blog/*.md (front matter + Markdown), the FAQ in content/faq.md ("## question" + answer). The same
content feeds the JSON API (the landing reads it) and the server-rendered pages (/blog, /blog/<slug>, /faq), which carry
canonical URLs, Open Graph tags and JSON-LD (Article, FAQPage, BreadcrumbList, Organization) so crawlers and LLM crawlers
get real HTML, not an empty SPA shell. /sitemap.xml, /robots.txt, /llms.txt and /llms-full.txt are generated from the same files.
"""
from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import markdown

from .config import env
from .providers import PROVIDERS


def _brand(provider: str | None) -> tuple[str, str]:
    """(logo path, brand color) for the AI an article is about."""
    spec = PROVIDERS.get(provider or "")
    ext = "svg" if provider in ("github", "cloudflare") else "png"
    return (f"/logos/{provider}.{ext}", spec.color if spec else "#0064E0") if provider else ("", "#0064E0")

CONTENT_DIR = Path(env("ARENA_CONTENT_DIR", str(Path(__file__).resolve().parents[1] / "content")))
SITE_URL = (env("ARENA_PUBLIC_URL", "https://muse-team-production.up.railway.app") or "https://muse-team-production.up.railway.app").rstrip("/")
SITE_NAME = "Muse Team"
SITE_TAGLINE = "Tu equipo de IA que diseña y construye apps"
SITE_DESCRIPTION = ("Muse Team arma un equipo de inteligencias artificiales (CEO, CTO, ingeniería, producto, diseño y QA) que debate tu idea, "
                    "estudia apps de referencia, diseña las pantallas, escribe el código y lo revisa antes de entregarte una app lista para correr.")

_MD_EXT = ["extra", "toc", "sane_lists", "smarty"]
_WORDS_PER_MIN = 200


@dataclass
class Post:
    slug: str
    title: str
    description: str
    date: str  # ISO
    updated: str  # ISO
    tags: list[str]
    body_md: str
    body_html: str
    toc_html: str
    reading_min: int
    provider: str | None = None  # the AI the article is about (for the logo)
    category: str = "Guías"
    keywords: list[str] = field(default_factory=list)
    lang: str = "es"

    def path(self) -> str:
        return f"{_prefix(self.lang)}/blog/{self.slug}"

    def url(self) -> str:
        return f"{SITE_URL}{self.path()}"

    def meta(self) -> dict:
        return {"slug": self.slug, "title": self.title, "description": self.description, "date": self.date, "updated": self.updated, "tags": self.tags,
                "reading_min": self.reading_min, "provider": self.provider, "category": self.category, "lang": self.lang, "url": self.path()}


@dataclass
class Faq:
    question: str
    answer_md: str
    answer_html: str
    answer_text: str
    slug: str


_caches: dict[str, dict] = {"es": {"stamp": None, "posts": [], "faq": []}, "en": {"stamp": None, "posts": [], "faq": []}}
LANGS = ("es", "en")


def _dir(lang: str) -> Path:
    return CONTENT_DIR / "en" if lang == "en" else CONTENT_DIR


def _prefix(lang: str) -> str:
    return "/en" if lang == "en" else ""


def _front_matter(text: str) -> tuple[dict, str]:
    """A minimal YAML-ish front matter: `key: value` lines between --- fences; lists as [a, b] or comma-separated."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not m:
        return {}, text
    meta: dict = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip().strip('"').strip("'")
        if v.startswith("[") and v.endswith("]"):
            meta[k.strip()] = [x.strip().strip('"').strip("'") for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k.strip()] = v
    return meta, text[m.end():]


def _render(md_text: str) -> tuple[str, str]:
    md = markdown.Markdown(extensions=_MD_EXT, extension_configs={"toc": {"toc_depth": "2-3", "anchorlink": False}})
    body = md.convert(md_text)
    return body, getattr(md, "toc", "") or ""


def _strip_html(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def _stamp(lang: str) -> tuple:
    d = _dir(lang)
    files = sorted(d.glob("blog/*.md")) + [d / "faq.md"]
    return tuple((str(f), f.stat().st_mtime) for f in files if f.exists())


def _load(lang: str = "es") -> None:
    _cache = _caches[lang]
    st = _stamp(lang)
    if _cache["stamp"] == st:
        return
    posts: list[Post] = []
    for f in sorted(_dir(lang).glob("blog/*.md")):
        meta, body = _front_matter(f.read_text(encoding="utf-8"))
        if meta.get("draft") in ("true", "yes", "1"):
            continue
        body_html, toc = _render(body)
        words = len(re.findall(r"\w+", body))
        d = str(meta.get("date") or date.today().isoformat())
        tags = meta.get("tags") if isinstance(meta.get("tags"), list) else [t.strip() for t in str(meta.get("tags") or "").split(",") if t.strip()]
        kws = meta.get("keywords") if isinstance(meta.get("keywords"), list) else [t.strip() for t in str(meta.get("keywords") or "").split(",") if t.strip()]
        posts.append(Post(slug=meta.get("slug") or f.stem, title=str(meta.get("title") or f.stem), description=str(meta.get("description") or ""), date=d,
                          updated=str(meta.get("updated") or d), tags=tags, body_md=body, body_html=body_html, toc_html=toc, reading_min=max(1, round(words / _WORDS_PER_MIN)),
                          provider=meta.get("provider") or None, keywords=kws, category=str(meta.get("category") or ("Guides" if lang == "en" else "Guías")), lang=lang))
    posts.sort(key=lambda p: (p.date, p.slug), reverse=True)
    faq: list[Faq] = []
    fp = _dir(lang) / "faq.md"
    if fp.exists():
        _, text = _front_matter(fp.read_text(encoding="utf-8"))
        for block in re.split(r"^## +", text, flags=re.M)[1:]:
            q, _, a = block.partition("\n")
            q, a = q.strip(), a.strip()
            if not q or not a:
                continue
            a_html, _ = _render(a)
            faq.append(Faq(question=q, answer_md=a, answer_html=a_html, answer_text=_strip_html(a_html), slug=re.sub(r"[^a-z0-9]+", "-", q.lower()).strip("-")[:80]))
    _cache.update(stamp=st, posts=posts, faq=faq)


def posts(lang: str = "es") -> list[Post]:
    _load(lang)
    return list(_caches[lang]["posts"])


def post(slug: str, lang: str = "es") -> Post | None:
    _load(lang)
    return next((p for p in _caches[lang]["posts"] if p.slug == slug), None)


def faq(lang: str = "es") -> list[Faq]:
    _load(lang)
    return list(_caches[lang]["faq"])


# ------------------------------------------------------------------ server-rendered pages

_CSS = """
:root{--paper:#F6F6FA;--surface:#fff;--surface-2:#F4F3FA;--line:#E4E3EE;--ink:#17172A;--ink-2:#47475C;--ink-3:#73738A;--ink-4:#A6A6B8;--accent:#0064E0;--accent-soft:#EEEAFD;--gold:#9C7622}
html[data-theme=dark]{--paper:#182230;--surface:#1E2938;--surface-2:#22313F;--line:#434E5E;--ink:#E9EDF2;--ink-2:#C9D2DC;--ink-3:#A9B4C2;--ink-4:#7E8A99;--accent:#F5A524;--accent-soft:#3A3322;--gold:#F5C46B;--head-bg:rgba(24,34,48,.8);color-scheme:dark}
html[data-theme=dark] body{font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;background-image:none}
html[data-theme=dark] h1{font-weight:700;letter-spacing:-.01em}html[data-theme=dark] h2,html[data-theme=dark] h3{letter-spacing:-.005em}
html[data-theme=dark] .prose pre{background:#121A26}html[data-theme=dark] .card:hover{box-shadow:none}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Schibsted Grotesk",ui-sans-serif,system-ui,sans-serif;line-height:1.6;font-size:16px;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
.serif{font-family:"Schibsted Grotesk",ui-sans-serif,system-ui,sans-serif;font-weight:800;letter-spacing:-.02em}
header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:0 24px;height:56px;border-bottom:1px solid var(--line);background:var(--head-bg,rgba(246,246,250,.8));backdrop-filter:blur(10px)}
header.top img{width:28px;height:28px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
header.top .brand{font-weight:800;font-size:18px;color:var(--ink);text-decoration:none;letter-spacing:-.02em;white-space:nowrap}header.top .brand em{color:var(--accent)}
header.top nav{margin-left:auto;display:flex;gap:8px;align-items:center}
header.top nav>a{text-decoration:none;color:var(--ink-2);padding:6px 12px;border-radius:8px;font-size:14px;white-space:nowrap}header.top nav>a:hover{color:var(--ink)}
header.top nav>a.on{color:var(--accent);font-weight:600}
header.top nav>a.cta{background:var(--accent);color:#fff;padding:6px 14px;font-weight:500}header.top nav>a.cta:hover{filter:brightness(1.08)}
.sw{display:flex;align-items:center;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:2px;height:32px}
.sw button,.sw a{display:flex;align-items:center;justify-content:center;height:100%;min-width:26px;padding:0 9px;border:0;border-radius:999px;background:none;color:var(--ink-3);font-size:11px;font-weight:600;font-family:inherit;text-decoration:none;cursor:pointer}
.sw button{padding:0;width:26px}.sw button:hover,.sw a:hover{color:var(--ink)}
html:not([data-theme=dark]) .sw .t-light,html[data-theme=dark] .sw .t-dark,.sw .on{background:var(--accent);color:#fff}
.sw svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
@media(max-width:640px){header.top nav a.hide-sm{display:none}}
main{max-width:1120px;margin:0 auto;padding:48px 28px 72px;min-height:calc(100vh - 60px)}
.hero{max-width:820px;margin-bottom:28px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--accent);font-weight:600}
.eyebrow::before{content:"";width:18px;height:1px;background:var(--accent)}
h1{font-weight:800;font-size:clamp(36px,5vw,56px);line-height:1.04;margin:14px 0 16px;letter-spacing:-.03em}
.lede{font-size:19px;line-height:1.55;color:var(--ink-2);max-width:720px;margin:0}
.meta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px;color:var(--ink-3);margin:22px 0 0}
.meta .logo{width:22px;height:22px;border-radius:6px;vertical-align:middle;margin-right:4px}
.tag{display:inline-block;white-space:nowrap;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:3px 10px;font-size:11.5px;color:var(--ink-2);text-decoration:none;letter-spacing:.01em}
a.tag:hover{border-color:var(--accent);color:var(--accent)}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 28px}
.filters .tag.on{background:var(--accent);border-color:var(--accent);color:#fff}
.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(310px,1fr))}
.card{position:relative;display:flex;flex-direction:column;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:24px;text-decoration:none;color:inherit;transition:border-color .2s,transform .2s,box-shadow .2s;overflow:hidden}
.card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 14px 30px -18px rgba(30,38,34,.35)}
.card .top{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--ink-3)}
.card .top img{width:26px;height:26px;border-radius:7px}
.card .top .kind{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:600}
.card h2{font-weight:700;font-size:23px;line-height:1.18;margin:4px 0 0;letter-spacing:-.01em}
.card p{margin:0;color:var(--ink-2);font-size:14.5px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card .foot{margin-top:auto;padding-top:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink-3);border-top:1px solid var(--surface-2)}
.card .foot .read{color:var(--accent);font-weight:600;white-space:nowrap}
.card.feature{grid-column:1/-1;padding:32px;background:linear-gradient(135deg,var(--surface) 55%,var(--accent-soft))}
.card.feature h2{font-size:34px;max-width:720px}.card.feature p{-webkit-line-clamp:2;max-width:720px;font-size:16px}
.article{display:grid;grid-template-columns:minmax(0,1fr);gap:48px;margin-top:40px;padding-top:40px;border-top:1px solid var(--line)}
@media(min-width:980px){.article{grid-template-columns:minmax(0,1fr) 280px}}
.toc-box{position:sticky;top:84px;align-self:start;font-size:13.5px}
.toc-box .t{font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:var(--ink-3);margin-bottom:10px;font-weight:600}
.toc-box .toc{border-left:2px solid var(--line);padding-left:14px}
.toc-box ul{list-style:none;margin:0;padding:0}.toc-box li{margin:6px 0}.toc-box ul ul{padding-left:12px;font-size:12.5px}
.toc-box a{color:var(--ink-2);text-decoration:none;display:block;line-height:1.35}.toc-box a:hover{color:var(--accent)}
.toc-box .share{margin-top:22px;padding-top:16px;border-top:1px solid var(--line);color:var(--ink-3);font-size:12.5px}
.toc-box .share a{display:inline-block;margin:6px 10px 0 0;color:var(--accent)}
.prose{max-width:720px;font-size:17.5px;line-height:1.72}
.prose>p:first-child{font-size:19px;color:var(--ink-2)}
.prose h2{font-weight:700;font-size:31px;line-height:1.15;margin:52px 0 14px;letter-spacing:-.01em}
.prose h2+h3{margin-top:18px}
.prose h3{font-size:19px;font-weight:600;margin:34px 0 10px}
.prose p{margin:0 0 18px}.prose ul,.prose ol{padding-left:22px;margin:0 0 18px}.prose li{margin:6px 0}.prose li::marker{color:var(--accent)}
.prose strong{font-weight:600;color:var(--ink)}
.prose blockquote{margin:24px 0;padding:16px 22px;border-left:3px solid var(--accent);background:var(--surface);border-radius:0 14px 14px 0;color:var(--ink-2);font-size:17px}
.prose blockquote p{margin:0}
.prose code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.86em;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.prose pre{background:#1E2622;color:#EEF1EF;border-radius:14px;padding:18px 20px;overflow:auto;font-size:13.5px;line-height:1.6;margin:0 0 22px}.prose pre code{background:none;border:0;padding:0;color:inherit}
.prose table{border-collapse:separate;border-spacing:0;width:100%;margin:0 0 24px;font-size:14.5px;line-height:1.45;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.prose th,.prose td{padding:11px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}.prose th{background:var(--surface-2);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.prose tr:last-child td{border-bottom:0}
.prose img{max-width:100%;border-radius:14px}
.prose hr{border:0;border-top:1px solid var(--line);margin:40px 0}
.faq{max-width:none}
.faq details{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:6px 22px;margin:0 0 10px;transition:border-color .2s}
.faq details[open]{border-color:var(--accent)}
.faq summary{cursor:pointer;font-weight:600;font-size:16px;padding:14px 0;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:16px;line-height:1.35}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";flex:0 0 28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-weight:400;font-size:20px;line-height:1}
.faq details[open] summary::after{content:"–"}
.faq .a{padding:0 0 18px;color:var(--ink-2);line-height:1.65}.faq .a p{margin:0 0 10px}.faq .a p:last-child{margin:0}
.faq-head{display:grid;gap:24px;grid-template-columns:1fr;align-items:end;margin-bottom:28px}
@media(min-width:900px){.faq-head{grid-template-columns:1fr 320px}}
.search-row{display:flex;align-items:center;gap:16px;margin:0 0 20px}.search-row .count{font-size:13px;color:var(--ink-3);white-space:nowrap}
.search{flex:1;width:100%;height:50px;border:1px solid var(--line);border-radius:999px;background:var(--surface);padding:0 18px;font:inherit;font-size:15px;color:var(--ink);outline:none}
.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.cta-box{margin:64px 0 0;background:var(--ink);color:#fff;border-radius:24px;padding:36px 40px;display:flex;flex-wrap:wrap;gap:20px;align-items:center;justify-content:space-between;position:relative;overflow:clip}
.cta-box::after{content:"";position:absolute;right:-80px;top:-80px;width:280px;height:280px;border-radius:999px;background:radial-gradient(closest-side,rgba(47,107,93,.7),transparent)}
.cta-box h3{font-weight:700;font-size:30px;margin:0 0 6px;letter-spacing:-.01em}.cta-box p{margin:0;opacity:.8;max-width:520px}
.cta-box a{position:relative;background:#fff;color:var(--ink);text-decoration:none;font-weight:600;border-radius:999px;padding:13px 24px;white-space:nowrap}
.cta-box a:hover{background:var(--accent-soft)}
footer{border-top:1px solid var(--line);background:var(--surface)}
footer .in{max-width:1120px;margin:0 auto;padding:36px 28px;display:grid;gap:24px;grid-template-columns:1fr;font-size:13.5px;color:var(--ink-3)}
@media(min-width:760px){footer .in{grid-template-columns:1.4fr 1fr 1fr}}
footer .brand{font-weight:800;font-size:19px;letter-spacing:-.02em;color:var(--ink)}footer .brand em{color:var(--accent)}
footer p{margin:8px 0 0;max-width:380px;line-height:1.55}
footer h4{margin:0 0 10px;font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
footer a{display:block;color:var(--ink-2);text-decoration:none;margin:0 0 8px}footer a:hover{color:var(--accent)}
footer .legal{grid-column:1/-1;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px}
.more{margin-top:64px;padding-top:40px;border-top:1px solid var(--line)}.more h2{font-weight:700;font-size:30px;margin:0 0 18px;letter-spacing:-.01em}
.crumbs{font-size:12.5px;color:var(--ink-3);margin-bottom:8px}.crumbs a{color:var(--ink-3);text-decoration:none}.crumbs a:hover{color:var(--accent)}
.progress{position:fixed;left:0;top:0;height:3px;width:0;background:var(--accent);z-index:6;transition:width .1s linear}
.card.brand{--brand:#0064E0;background:linear-gradient(160deg,var(--surface) 45%,color-mix(in srgb,var(--brand) 14%,var(--surface)))}
.card.brand::before{content:"";position:absolute;right:-30px;top:-30px;width:180px;height:180px;border-radius:999px;background:radial-gradient(closest-side,color-mix(in srgb,var(--brand) 28%,transparent),transparent)}
.card.brand .wm{position:absolute;right:-18px;bottom:-22px;width:150px;height:150px;opacity:.14;filter:blur(1.5px) saturate(1.2);pointer-events:none;transform:rotate(-8deg)}
.card.brand:hover .wm{opacity:.22}
.card.brand>*:not(.wm){position:relative}
.hero.brand{--brand:#0064E0;position:relative;max-width:none;margin:-48px -28px 36px;padding:56px 28px 44px;overflow:hidden;background:linear-gradient(160deg,color-mix(in srgb,var(--brand) 10%,var(--paper)),var(--paper) 70%)}
.hero.brand::before{content:"";position:absolute;right:-120px;top:-160px;width:560px;height:560px;border-radius:999px;background:radial-gradient(closest-side,color-mix(in srgb,var(--brand) 30%,transparent),transparent)}
.hero.brand .wm{position:absolute;right:4%;top:50%;width:min(34vw,360px);height:min(34vw,360px);transform:translateY(-50%) rotate(-8deg);opacity:.16;filter:blur(2px) saturate(1.2);pointer-events:none}
.hero.brand>*:not(.wm){position:relative;max-width:760px}
.hero.brand .meta .logo{box-shadow:0 1px 3px rgba(0,0,0,.12)}
.cta-box{background:var(--accent)}
.cta-box::after{background:radial-gradient(closest-side,rgba(255,255,255,.22),transparent);pointer-events:none;z-index:0}
.cta-box a{z-index:1}
.cat{margin:0 0 56px;scroll-margin-top:84px}.cat-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 18px;margin:0 0 18px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.cat h2{font-weight:700;font-size:30px;margin:0;letter-spacing:-.01em}.cat-head p{margin:0;color:var(--ink-3);font-size:14.5px;max-width:640px}
.cta-box a{background:#fff;color:var(--accent)}.cta-box a:hover{background:var(--accent-soft)}
.cta-box p{opacity:.9}
"""

_THEME_JS = """<script>(function(){var d=document.documentElement,k='tably.theme',t='dark';try{t=localStorage.getItem(k)||'dark'}catch(e){}
function on(v){if(v==='light'||(v==='auto'&&!matchMedia('(prefers-color-scheme: dark)').matches))d.removeAttribute('data-theme');else d.setAttribute('data-theme','dark')}
on(t);window.tablyTheme=function(v){try{localStorage.setItem(k,v)}catch(e){}on(v)}})()</script>"""
_THEME_SWITCH = ('<div class="sw" role="group" aria-label="Theme">'
                 '<button type="button" class="t-light" aria-label="Light" onclick="tablyTheme(\'light\')"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>'
                 '<button type="button" class="t-dark" aria-label="Dark" onclick="tablyTheme(\'dark\')"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button></div>')

_FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
          '<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:ital,wght@0,400..900;1,400..900&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">')


CATEGORY_ORDER = ["Inteligencias artificiales", "Prompt engineering y referencias", "Cómo funciona Muse Team", "Publicar y móvil", "Costos y seguridad"]
CATEGORY_LEDE = {
    "Inteligencias artificiales": "Una guía por modelo: qué lo distingue, dónde no usarlo, qué rol darle y cuánto cuesta. Y la comparativa por rol.",
    "Prompt engineering y referencias": "Cómo escribir el pedido para que salga bien y cómo Muse Team estudia las apps que te gustan antes de construir.",
    "Cómo funciona Muse Team": "El equipo, las dos vías de construcción y quién escribe el código.",
    "Publicar y móvil": "Salir a internet con base de datos y usuarios, y construir para iOS y Android.",
    "Costos y seguridad": "Qué se paga, a quién, cómo bajarlo, y qué pasa con tus claves, tu código y tus datos.",
}
CATEGORY_ORDER_EN = ["AI models", "Prompt engineering and references", "How Muse Team works", "Publishing and mobile", "Costs and security"]
CATEGORY_LEDE_EN = {
    "AI models": "One guide per model: what sets it apart, where not to use it, which role to give it and what it costs. Plus the role-by-role comparison.",
    "Prompt engineering and references": "How to write the request so it comes out right, and how Muse Team studies the apps you like before building.",
    "How Muse Team works": "The team, the two ways to build and who writes the code.",
    "Publishing and mobile": "Going live with a database and users, and building for iOS and Android.",
    "Costs and security": "What you pay, to whom, how to lower it, and what happens to your keys, your code and your data.",
}
UI = {
    "es": {"blog": "Blog", "faq": "Preguntas frecuentes", "login": "Iniciar sesión", "signup": "Crear cuenta", "open": "Abrir la app", "home": "Inicio", "read": "Leer →",
           "min": "min de lectura", "by": "por el equipo de", "updated": "actualizado el", "all_sections": "← Todas las secciones", "topic": "Tema", "in_article": "En este artículo",
           "share": "Compartir", "more": "Seguir leyendo", "cta_title": "Probá Muse Team con tu idea", "cta_text": "Escribí lo que querés construir y mirá cómo el equipo lo debate, lo diseña y lo construye.",
           "cta_btn": "Crear cuenta gratis", "product": "Producto", "resources": "Recursos", "legal": "Las marcas de los proveedores de IA pertenecen a sus dueños.",
           "footer_text": "Un equipo de IA con roles que debate tu idea, la diseña, la construye y la revisa. Vos aprobás cada paso.", "tagline": SITE_TAGLINE,
           "blog_title": "Blog: guías sobre IA para construir apps", "blog_desc": "Guías detalladas sobre Muse y el equipo de IA: cómo elegirlas por rol y cómo Muse Team construye apps con ellas.",
           "blog_h1": "Guías para construir apps con un equipo de IA", "blog_lede": "Qué hace bien cada inteligencia artificial, cómo elegir una para cada rol, qué cuesta construir una app y cómo funciona Muse Team por dentro. Escrito por el equipo que lo construye.",
           "faq_title": "Preguntas frecuentes", "faq_desc": "Respuestas directas sobre Muse Team: qué es, cuánto cuesta, qué IA conviene para cada rol, cómo se publica la app, dónde queda tu código y cómo se cuidan tus API keys.",
           "faq_h1": "Lo que te preguntás antes de construir", "faq_lede": "Qué es, cuánto cuesta, qué IA usar, dónde queda tu código, cómo se publica la app y qué pasa con tus claves. Respuestas directas.",
           "search": "Buscar entre {n} preguntas…", "q1": "pregunta", "qn": "preguntas", "guide": "Guía", "locale": "es_AR", "lang": "es", "other": "EN", "other_lang": "en", "other_title": "English"},
    "en": {"blog": "Blog", "faq": "FAQ", "login": "Sign in", "signup": "Create account", "open": "Open the app", "home": "Home", "read": "Read →",
           "min": "min read", "by": "by the team at", "updated": "updated", "all_sections": "← All sections", "topic": "Topic", "in_article": "In this article",
           "share": "Share", "more": "Keep reading", "cta_title": "Try Muse Team with your idea", "cta_text": "Describe what you want to build and watch the team debate it, design it and build it.",
           "cta_btn": "Create a free account", "product": "Product", "resources": "Resources", "legal": "AI provider trademarks belong to their owners.",
           "footer_text": "An AI team with roles that debates your idea, designs it, builds it and reviews it. You approve every step.", "tagline": "Your AI team that designs and builds apps",
           "blog_title": "Blog: guides on AI for building apps", "blog_desc": "In-depth guides on Muse and the AI team: how to pick one per role and how Muse Team builds apps with them.",
           "blog_h1": "Guides to building apps with an AI team", "blog_lede": "What each AI does well, how to pick one for each role, what building an app costs and how Muse Team works inside. Written by the team that builds it.",
           "faq_title": "Frequently asked questions", "faq_desc": "Straight answers about Muse Team: what it is, what it costs, which AI fits each role, how the app gets published, where your code lives and how your API keys are protected.",
           "faq_h1": "What you ask before you build", "faq_lede": "What it is, what it costs, which AI to use, where your code lives, how the app gets published and what happens to your keys. Straight answers.",
           "search": "Search {n} questions…", "q1": "question", "qn": "questions", "guide": "Guide", "locale": "en_US", "lang": "en", "other": "ES", "other_lang": "es", "other_title": "Español"},
}
_MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
_MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def _fmt_date(iso: str, lang: str = "es") -> str:
    try:
        d = date.fromisoformat(iso)
        return f"{_MONTHS_EN[d.month - 1]} {d.day}, {d.year}" if lang == "en" else f"{d.day} de {_MONTHS[d.month - 1]} de {d.year}"
    except ValueError:
        return iso


def _org_ld() -> dict:
    return {"@type": "Organization", "@id": f"{SITE_URL}/#organization", "name": SITE_NAME, "url": SITE_URL, "logo": f"{SITE_URL}/icon-512.png",
            "description": SITE_DESCRIPTION, "sameAs": []}


def _alt_path(path: str, lang: str) -> str:
    """The same page in the other language: /blog/x ↔ /en/blog/x."""
    bare = path[3:] if path.startswith("/en") else path
    bare = bare or "/"
    return (f"/en{bare}" if lang == "es" else bare)


def _page(*, lang: str, title: str, description: str, path: str, body: str, ld: list[dict], og_type: str = "website", published: str | None = None, modified: str | None = None,
          keywords: list[str] | None = None, current: str = "", has_alt: bool = True) -> str:
    u = UI[lang]
    canonical = f"{SITE_URL}{path}"
    alt = _alt_path(path, lang)
    esc = html.escape
    meta_extra = ""
    if published:
        meta_extra += f'<meta property="article:published_time" content="{esc(published)}">'
    if modified:
        meta_extra += f'<meta property="article:modified_time" content="{esc(modified)}">'
    if keywords:
        meta_extra += f'<meta name="keywords" content="{esc(", ".join(keywords))}">'
    if has_alt:
        es_path, en_path = (path, alt) if lang == "es" else (alt, path)
        meta_extra += (f'<link rel="alternate" hreflang="es" href="{SITE_URL}{esc(es_path)}"><link rel="alternate" hreflang="en" href="{SITE_URL}{esc(en_path)}">'
                       f'<link rel="alternate" hreflang="x-default" href="{SITE_URL}{esc(es_path)}">')
    ld_json = json.dumps({"@context": "https://schema.org", "@graph": ld}, ensure_ascii=False)
    app_home = "/" if lang == "es" else "/?lang=en"
    progress = ('<div class="progress" id="progress"></div><script>addEventListener("scroll",()=>{const d=document.documentElement;const p=d.scrollTop/(d.scrollHeight-d.clientHeight||1);document.getElementById("progress").style.width=(p*100)+"%"},{passive:true})</script>'
                if og_type == "article" else "")
    _save = f"try{{localStorage.setItem('arena.lang','{u['other_lang']}')}}catch(e){{}}"
    _other = f'<a href="{esc(alt)}" hreflang="{u["other_lang"]}" title="{u["other_title"]}" onclick="{_save}">{u["other_lang"]}</a>' if has_alt else ""
    _mine = f'<a class="on" aria-current="true">{u["lang"]}</a>'
    switch = _THEME_SWITCH + (f'<div class="sw" role="group" aria-label="Language">{_mine + _other if u["lang"] == "es" else _other + _mine}</div>')
    return f"""<!doctype html>
<html lang="{u["lang"]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} · {SITE_NAME}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{esc(canonical)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta property="og:site_name" content="{SITE_NAME}">
<meta property="og:type" content="{og_type}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(canonical)}">
<meta property="og:image" content="{SITE_URL}/icon-512.png">
<meta property="og:locale" content="{u["locale"]}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(description)}">
{meta_extra}
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png?v=3">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=3">
<meta name="theme-color" content="#0064E0">
<link rel="alternate" type="application/rss+xml" title="{SITE_NAME} · Blog" href="{SITE_URL}{_prefix(lang)}/blog/feed.xml">
{_THEME_JS}
{_FONTS}
<style>{_CSS}</style>
<script type="application/ld+json">{ld_json}</script>
</head>
<body>
<header class="top">
  <img src="/icon.svg?v=3" alt="" aria-hidden="true">
  <a class="brand" href="{app_home}">Muse <em>Team</em></a>
  <nav aria-label="Main">
    {switch}
    <a href="{_prefix(lang)}/blog"{" class=on" if current == "blog" else ""}>{u["blog"]}</a>
    <a href="{_prefix(lang)}/faq"{" class=on" if current == "faq" else ""}>{u["faq"]}</a>
    <a class="hide-sm" id="nav-login" href="{app_home}#login">{u["login"]}</a>
    <a class="cta" id="nav-signup" href="{app_home}#signup">{u["signup"]}</a>
  </nav>
</header>
<script>try{{localStorage.setItem("arena.lang","{u["lang"]}");if(localStorage.getItem("arena.token")){{const l=document.getElementById("nav-login"),c=document.getElementById("nav-signup");l.remove();c.textContent="{u["open"]}";c.href="{app_home}";document.querySelectorAll(".cta-box a").forEach(a=>{{a.textContent="{u["open"]}";a.href="{app_home}"}})}}}}catch(e){{}}</script>
{progress}
<main>
{body}
<section class="cta-box">
  <div><h3>{u["cta_title"]}</h3><p>{u["cta_text"]}</p></div>
  <a href="{app_home}#signup">{u["cta_btn"]}</a>
</section>
</main>
<footer>
  <div class="in">
    <div><div class="brand">Muse <em>Team</em></div><p>{u["tagline"]}. {u["footer_text"]}</p></div>
    <div><h4>{u["product"]}</h4><a href="{app_home}">{u["home"]}</a><a href="{app_home}#signup">{u["signup"]}</a><a href="{app_home}#login">{u["login"]}</a></div>
    <div><h4>{u["resources"]}</h4><a href="{_prefix(lang)}/blog">{u["blog"]}</a><a href="{_prefix(lang)}/faq">{u["faq"]}</a></div>
    <div class="legal">© {date.today().year} {SITE_NAME}. {u["legal"]}</div>
  </div>
</footer>
</body>
</html>"""


def _card(p: Post, feature: bool = False) -> str:
    esc = html.escape
    u = UI[p.lang]
    logo_src, color = _brand(p.provider)
    logo = f'<img src="{esc(logo_src)}" alt="" aria-hidden="true">' if p.provider else f'<span class="kind">{esc(p.category)}</span>'
    wm = f'<img class="wm" src="{esc(logo_src)}" alt="" aria-hidden="true">' if p.provider else ""
    cls = "card" + (" feature" if feature else "") + (" brand" if p.provider else "")
    return (f'<a class="{cls}" style="--brand:{esc(color)}" href="{esc(p.path())}">{wm}<div class="top">{logo}<time datetime="{esc(p.date)}">{_fmt_date(p.date, p.lang)}</time></div>'
            f'<h2>{esc(p.title)}</h2><p>{esc(p.description)}</p>'
            f'<div class="foot"><span>{p.reading_min} {u["min"]}</span><span class="read">{u["read"]}</span></div></a>')


def cat_slug(c: str) -> str:
    import unicodedata
    base = unicodedata.normalize("NFKD", c).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")


def categories(lang: str = "es") -> list[tuple[str, list[Post]]]:
    ps = posts(lang)
    known = CATEGORY_ORDER_EN if lang == "en" else CATEGORY_ORDER
    order = known + sorted({p.category for p in ps} - set(known))
    return [(c, [p for p in ps if p.category == c]) for c in order if any(p.category == c for p in ps)]


def all_tags(lang: str = "es") -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for p in posts(lang):
        for t in p.tags:
            counts[t] = counts.get(t, 0) + 1
    return sorted(((t, n) for t, n in counts.items() if n >= 2), key=lambda kv: (-kv[1], kv[0]))[:12]


def _crumbs(lang: str, *items: tuple[str, str]) -> list[dict]:
    return [{"@type": "ListItem", "position": i + 1, "name": n, "item": u} for i, (n, u) in enumerate(items)]


def blog_index_html(tag: str | None = None, lang: str = "es") -> str:
    esc = html.escape
    u = UI[lang]
    pre = _prefix(lang)
    ledes = CATEGORY_LEDE_EN if lang == "en" else CATEGORY_LEDE
    if tag:
        ps = [p for p in posts(lang) if tag in p.tags]
        chips = f'<a class="tag" href="{pre}/blog">{u["all_sections"]}</a>' + "".join(f'<a class="tag{" on" if t == tag else ""}" href="{pre}/blog?tag={esc(t)}">{esc(t)} · {n}</a>' for t, n in all_tags(lang))
        sections = f'<section class="cat"><h2>{u["topic"]}: {esc(tag)}</h2><div class="grid">{"".join(_card(p) for p in ps)}</div></section>'
    else:
        cats = categories(lang)
        chips = "".join(f'<a class="tag" href="#{cat_slug(c)}">{esc(c)} · {len(ps)}</a>' for c, ps in cats)
        sections = "".join(f'<section class="cat" id="{cat_slug(c)}"><div class="cat-head"><h2>{esc(c)}</h2><p>{esc(ledes.get(c, ""))}</p></div><div class="grid">{"".join(_card(p) for p in ps)}</div></section>' for c, ps in cats)
    body = (f'<div class="hero"><div class="eyebrow">{u["blog"]}</div><h1>{u["blog_h1"]}</h1><p class="lede">{u["blog_lede"]}</p></div><div class="filters">{chips}</div>{sections}')
    ld = [_org_ld(), {"@type": "Blog", "@id": f"{SITE_URL}{pre}/blog#blog", "name": f"{SITE_NAME} · Blog", "url": f"{SITE_URL}{pre}/blog", "inLanguage": lang, "publisher": {"@id": f"{SITE_URL}/#organization"},
                      "blogPost": [{"@type": "BlogPosting", "headline": p.title, "url": p.url(), "datePublished": p.date, "dateModified": p.updated} for p in posts(lang)]},
          {"@type": "BreadcrumbList", "itemListElement": _crumbs(lang, (u["home"], SITE_URL), (u["blog"], f"{SITE_URL}{pre}/blog"))}]
    return _page(lang=lang, title=u["blog_title"], description=u["blog_desc"], path=f"{pre}/blog", body=body, ld=ld, current="blog")


def post_html(p: Post) -> str:
    esc = html.escape
    lang = p.lang
    u = UI[lang]
    pre = _prefix(lang)
    others = [o for o in posts(lang) if o.slug != p.slug]
    related = ([o for o in others if o.category == p.category] + [o for o in others if o.category != p.category and set(o.tags) & set(p.tags)])[:3] or others[:3]
    share = (f'<div class="share">{u["share"]}<br><a href="https://twitter.com/intent/tweet?url={esc(p.url())}&text={esc(p.title)}" rel="noopener" target="_blank">X</a>'
             f'<a href="https://www.linkedin.com/sharing/share-offsite/?url={esc(p.url())}" rel="noopener" target="_blank">LinkedIn</a>'
             f'<a href="https://wa.me/?text={esc(p.title)}%20{esc(p.url())}" rel="noopener" target="_blank">WhatsApp</a></div>')
    toc = f'<aside class="toc-box"><div class="t">{u["in_article"]}</div>{p.toc_html}{share}</aside>' if p.toc_html.strip() else f'<aside class="toc-box">{share}</aside>'
    logo_src, color = _brand(p.provider)
    logo = f'<img class="logo" src="{esc(logo_src)}" alt="">' if p.provider else ""
    wm = f'<img class="wm" src="{esc(logo_src)}" alt="" aria-hidden="true">' if p.provider else ""
    tags = "".join(f'<a class="tag" href="{pre}/blog?tag={esc(t)}">{esc(t)}</a>' for t in p.tags)
    body = (f'<div class="hero{" brand" if p.provider else ""}" style="--brand:{esc(color)}">{wm}<div class="crumbs"><a href="{"/" if lang == "es" else "/?lang=en"}">{u["home"]}</a> › <a href="{pre}/blog">{u["blog"]}</a> › <a href="{pre}/blog#{cat_slug(p.category)}">{esc(p.category)}</a></div>'
            f'<div class="eyebrow">{esc(p.category)}</div><h1>{esc(p.title)}</h1><p class="lede">{esc(p.description)}</p>'
            f'<div class="meta">{logo}<time datetime="{esc(p.date)}">{_fmt_date(p.date, lang)}</time>'
            + (f'<span>{u["updated"]} {_fmt_date(p.updated, lang)}</span>' if p.updated != p.date else "")
            + f'<span>{p.reading_min} {u["min"]}</span><span>{u["by"]} {SITE_NAME}</span><span class="tags">{tags}</span></div></div>'
            f'<div class="article"><article class="prose">{p.body_html}</article>{toc}</div>'
            f'<section class="more"><h2>{u["more"]}</h2><div class="grid">{"".join(_card(o) for o in related)}</div></section>')
    ld = [_org_ld(),
          {"@type": "Article", "@id": f"{p.url()}#article", "headline": p.title, "description": p.description, "url": p.url(), "mainEntityOfPage": p.url(), "inLanguage": lang,
           "datePublished": p.date, "dateModified": p.updated, "keywords": ", ".join(p.keywords or p.tags), "wordCount": len(re.findall(r"\w+", p.body_md)),
           "author": {"@type": "Organization", "name": SITE_NAME, "url": SITE_URL}, "publisher": {"@id": f"{SITE_URL}/#organization"}, "image": f"{SITE_URL}/icon-512.png"},
          {"@type": "BreadcrumbList", "itemListElement": _crumbs(lang, (u["home"], SITE_URL), (u["blog"], f"{SITE_URL}{pre}/blog"), (p.title, p.url()))}]
    has_alt = post(p.slug, "en" if lang == "es" else "es") is not None
    return _page(lang=lang, title=p.title, description=p.description, path=p.path(), body=body, ld=ld, og_type="article", published=p.date, modified=p.updated, keywords=p.keywords or p.tags, current="blog", has_alt=has_alt)


LEGAL = {"privacidad": "Política de privacidad", "terminos": "Términos y condiciones"}


def legal_body(doc: str) -> str | None:
    """The terms or the privacy policy: public pages for whoever needs the link, and what the signup shows in its dialog."""
    if doc not in LEGAL:
        return None
    return _render((CONTENT_DIR / "legal" / f"{doc}.md").read_text(encoding="utf-8"))[0]


def legal_html(doc: str) -> str:
    title = f"{LEGAL[doc]} · Muse Team"
    return _page(lang="es", title=title, description=f"{LEGAL[doc]} de Muse Team.", path=f"/{doc}", body=f'<article class="article">{legal_body(doc)}</article>', ld=[_org_ld()])


def faq_html(lang: str = "es") -> str:
    esc = html.escape
    u = UI[lang]
    pre = _prefix(lang)
    items = faq(lang)
    body = (f'<div class="hero"><div class="eyebrow">{u["faq"]}</div><h1>{u["faq_h1"]}</h1><p class="lede">{u["faq_lede"]}</p></div>'
            f'<div class="search-row"><input class="search" id="q" type="search" placeholder="{esc(u["search"].format(n=len(items)))}" autocomplete="off" aria-label="Search"><span class="count" id="count">{len(items)} {u["qn"]}</span></div><div class="faq" id="faq">'
            + "".join(f'<details id="{esc(i.slug)}"><summary>{esc(i.question)}</summary><div class="a">{i.answer_html}</div></details>' for i in items) + "</div>"
            f'<script>const q=document.getElementById("q"),all=[...document.querySelectorAll("#faq details")];q.addEventListener("input",()=>{{const v=q.value.trim().toLowerCase();let n=0;all.forEach(d=>{{const hit=!v||d.textContent.toLowerCase().includes(v);d.style.display=hit?"":"none";if(hit)n++;if(v&&hit)d.open=true}});document.getElementById("count").textContent=n+(n===1?" {u["q1"]}":" {u["qn"]}")}});'
            'if(location.hash){const d=document.getElementById(location.hash.slice(1));if(d){d.open=true;d.scrollIntoView()}}</script>')
    ld = [_org_ld(), {"@type": "FAQPage", "@id": f"{SITE_URL}{pre}/faq#faq", "url": f"{SITE_URL}{pre}/faq", "inLanguage": lang,
                      "mainEntity": [{"@type": "Question", "name": i.question, "acceptedAnswer": {"@type": "Answer", "text": i.answer_text}} for i in items]},
          {"@type": "BreadcrumbList", "itemListElement": _crumbs(lang, (u["home"], SITE_URL), (u["faq"], f"{SITE_URL}{pre}/faq"))}]
    return _page(lang=lang, title=u["faq_title"], description=u["faq_desc"], path=f"{pre}/faq", body=body, ld=ld, current="faq")


# ------------------------------------------------------------------ machine-readable files

def sitemap_xml() -> str:
    today = date.today().isoformat()
    rows: list[tuple[str, str, str, str]] = [(SITE_URL + "/", today, "weekly", "1.0")]
    for lang in LANGS:
        pre = _prefix(lang)
        ps = posts(lang)
        if not ps and lang != "es":
            continue
        rows += [(f"{SITE_URL}{pre}/blog", max([p.updated for p in ps] or [today]), "weekly", "0.8"), (f"{SITE_URL}{pre}/faq", today, "monthly", "0.8")]
        rows += [(p.url(), p.updated, "monthly", "0.7") for p in ps]
    body = "".join(f"<url><loc>{html.escape(u)}</loc><lastmod>{d}</lastmod><changefreq>{c}</changefreq><priority>{pr}</priority></url>" for u, d, c, pr in rows)
    return f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>'


def robots_txt() -> str:
    return "\n".join(["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /ws/", "Disallow: /git/", "Disallow: /apps/", "Disallow: /run/", "", f"Sitemap: {SITE_URL}/sitemap.xml", ""])


def rss_xml(lang: str = "es") -> str:
    esc = html.escape
    pre = _prefix(lang)
    items = "".join(f"<item><title>{esc(p.title)}</title><link>{esc(p.url())}</link><guid>{esc(p.url())}</guid><pubDate>{p.date}</pubDate><description>{esc(p.description)}</description></item>" for p in posts(lang))
    return (f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>{SITE_NAME} · Blog</title><link>{SITE_URL}{pre}/blog</link>'
            f'<description>{esc(SITE_DESCRIPTION)}</description><language>{lang}</language>{items}</channel></rss>')


def llms_txt() -> str:
    """llms.txt: a short, structured guide for LLM crawlers and answer engines (what the site is, where the canonical content lives), in both languages."""
    lines = [f"# {SITE_NAME}", "", f"> {SITE_DESCRIPTION}", "",
             "Muse Team es una plataforma donde un equipo de agentes de IA con roles (CEO, CTO, Head of Engineering, Product, Diseño y QA), cada uno con el modelo que elijas "
             "(Claude, GPT, Gemini, DeepSeek, Grok, Llama, Kimi, Mistral, OpenRouter u Ollama), debate una idea, la investiga contra apps de referencia, la diseña, la construye "
             "(con Muse Code) y la revisa. La app se puede correr, descargar o publicar en Muse Cloud.", "",
             "Muse Team is a platform where a team of AI agents with roles (CEO, CTO, Head of Engineering, Product, Design and QA), each on the model you choose, debates an idea, "
             "researches it against reference apps, designs it, builds it (with Muse Code) and reviews it. The app can be run, downloaded or published on Muse Cloud.", "",
             "## Páginas principales · Main pages", "", f"- [Inicio / Home]({SITE_URL}/)", f"- [Preguntas frecuentes]({SITE_URL}/faq) · [FAQ (English)]({SITE_URL}/en/faq)",
             f"- [Blog (español)]({SITE_URL}/blog) · [Blog (English)]({SITE_URL}/en/blog)", ""]
    for lang, title in (("es", "## Artículos (español)"), ("en", "## Articles (English)")):
        ps = posts(lang)
        if ps:
            lines += [title, ""] + [f"- [{p.title}]({p.url()}): {p.description}" for p in ps] + [""]
    lines += ["## Opcional · Optional", "", f"- [llms-full.txt]({SITE_URL}/llms-full.txt): todo el contenido en texto plano · all content as plain text", f"- [Sitemap]({SITE_URL}/sitemap.xml)", ""]
    return "\n".join(lines)


def llms_full_txt() -> str:
    parts = [llms_txt()]
    for lang, faq_title in (("es", "# Preguntas frecuentes"), ("en", "# Frequently asked questions")):
        items = faq(lang)
        if items:
            parts += ["", "---", "", faq_title, ""] + [f"## {i.question}\n\n{i.answer_md}\n" for i in items]
        for p in posts(lang):
            parts += ["", "---", "", f"# {p.title}", "", f"URL: {p.url()}", f"{'Published' if lang == 'en' else 'Publicado'}: {p.date} · {'Updated' if lang == 'en' else 'Actualizado'}: {p.updated}", "", p.description, "", p.body_md, ""]
    return "\n".join(parts)
