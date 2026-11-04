"""
The inspiration library: captures of well-designed public sites, by line of business, that the designer looks at before
proposing directions. It lives on the server's disk, never in the repo or in the projects: only the addresses are in the code.

Filled in the background from inspiration_sites.SITES, and on demand: a business it doesn't know gets its own shelf, with sites a
model proposes. A site that says no (robots.txt, a bot wall, a page that doesn't paint) is left out, and nothing tries to get past it.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import random
import re
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

from . import research as rsch
from .config import DATA_DIR
from .inspiration_sites import SITES

log = logging.getLogger("arena.inspiration")

ENABLED = os.getenv("TABLY_INSPIRATION", "1") not in ("0", "false", "no", "off")
LIBRARY = Path(os.getenv("TABLY_INSPIRATION_LIBRARY", DATA_DIR.parent / "inspiration"))
SEED = Path(__file__).resolve().parents[1] / "inspiration_seed"
MIN_FOR_A_BUSINESS = 4  # fewer than this and the shelf is completed with a search
RETRY_AFTER = 30 * 86400
SHOT_LIMIT = 35
MIN_PNG_BYTES = 12_000  # a page that didn't paint is a nearly empty image
WALL_RE = re.compile(r"captcha|access denied|just a moment|verify you are (a )?human|checking your browser|attention required|are you a robot|enable javascript", re.I)
_lock = threading.Lock()

RUBRO_SYSTEM = """Te paso un pedido para construir una app o sitio. Decí a qué rubro pertenece.
Rubros conocidos:
{rubros}
Respondé SOLO con JSON: {{"rubro": "el id del rubro", "nombre": null}}. Si ninguno le queda bien: {{"rubro": null, "nombre": "el rubro en dos o tres palabras"}}."""

PROPOSE_SYSTEM = """Sos un Director de Arte. Dado un rubro, nombrá sitios públicos reales con muy buen diseño visual: líderes del rubro y marcas con una estética memorable, de estilos variados.
Solo sitios que existen, con la URL de su home, que se abran sin cuenta. Respondé SOLO con JSON: una lista de objetos {"name", "url", "why"}."""


def _index_path() -> Path:
    return LIBRARY / "index.json"


def load_index() -> dict:
    try:
        return json.loads(_index_path().read_text())
    except (OSError, ValueError):
        return {"items": [], "failed": {}, "shelves": {}}


def _update(fn) -> None:
    with _lock:
        d = load_index()
        fn(d)
        LIBRARY.mkdir(parents=True, exist_ok=True)
        tmp = _index_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False))
        tmp.replace(_index_path())


def slug(text: str) -> str:
    plain = text.lower().translate(str.maketrans("áéíóúüñ", "aeiouun"))
    return re.sub(r"[^a-z0-9]+", "-", plain).strip("-")[:50] or "otro"


def public_url(url: str) -> bool:
    """Only an https address of a public site: these come from a list or a model, and the server is the one who opens them."""
    u = urlparse(url or "")
    host = (u.hostname or "").lower()
    if u.scheme != "https" or "." not in host or host.endswith((".local", ".internal", ".localhost")):
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        return True


def robots_allow(url: str) -> bool:
    u = urlparse(url)
    try:
        with urlopen(Request(f"{u.scheme}://{u.netloc}/robots.txt", headers={"User-Agent": "MuseTeamInspiration"}), timeout=8) as r:
            rules = RobotFileParser()
            rules.parse(r.read(200_000).decode("utf-8", "replace").splitlines())
        return rules.can_fetch("MuseTeamInspiration", url)
    except Exception:  # no robots.txt, or unreadable: nothing says no
        return True


def shoot(url: str) -> bytes | None:
    """The first screen of a page, as an ordinary headless Chrome. None when it can't be seen or the site says no."""
    # --timeout paints whatever arrived by then: with --virtual-time-budget, heavy pages hung until the kill
    chrome = rsch.chrome_path()
    if not chrome or not public_url(url) or not robots_allow(url):
        return None
    with tempfile.TemporaryDirectory(prefix="tably-insp-") as tmp:
        out = Path(tmp) / "shot.png"
        base = [chrome, "--headless=new", "--no-sandbox", "--hide-scrollbars", "--no-first-run", "--disable-extensions", "--timeout=15000", "--lang=es", "--window-size=1440,900"]
        rsch._run_for_file(base + [f"--user-data-dir={tmp}/a", f"--screenshot={out}", url], out, SHOT_LIMIT)
        if not out.exists() or out.stat().st_size < MIN_PNG_BYTES:
            log.info("inspiration: nothing painted at %s", url)
            return None
        _, html = rsch._run(base + [f"--user-data-dir={tmp}/b", "--dump-dom", url], SHOT_LIMIT)  # only to tell a wall from a page
        visible = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", html or "", flags=re.S | re.I)
        if len(visible) < 20000 and WALL_RE.search(visible):
            log.info("inspiration: %s answered with a wall", url)
            return None
        return out.read_bytes()


def add(rubro: str, name: str, url: str, look: str = "") -> dict | None:
    """Capture one site into a shelf; what's already there (or failed recently) isn't opened again."""
    d = load_index()
    known = next((i for i in d["items"] if i["url"] == url and i["rubro"] == rubro), None)
    if known or time.time() - d["failed"].get(url, 0) < RETRY_AFTER:
        return known
    same = next((i for i in d["items"] if i["url"] == url), None)  # the same site on another shelf: same picture
    if same:
        item = {**same, "rubro": rubro}
        _update(lambda x: x["items"].append(item))
        return item
    png = shoot(url)
    if not png:
        _update(lambda x: x["failed"].__setitem__(url, time.time()))
        return None
    file = f"{slug(urlparse(url).netloc.removeprefix('www.'))}.png"
    LIBRARY.mkdir(parents=True, exist_ok=True)
    (LIBRARY / file).write_bytes(png)
    item = {"name": name[:60], "url": url, "rubro": rubro, "look": look, "file": file, "ts": time.time()}
    _update(lambda x: (x["failed"].pop(url, None), x["items"].append(item)))
    return item


def fill(workers: int = 1, pause: float = 2.0) -> dict:
    """Capture what's missing from the list, a site at a time on a server."""
    jobs = [(rubro, n, u, look) for rubro, shelf in SITES.items() for n, u, look in shelf["sites"]]
    random.Random(7).shuffle(jobs)

    def one(job: tuple) -> None:
        try:
            add(*job)
        except Exception:
            log.exception("inspiration capture %s", job[2])
        time.sleep(pause)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, jobs))
    return status()


def load_seed(seed: Path = SEED) -> int:
    """The example captures that ship with the code: copied to the server's disk once, without touching what's already there."""
    try:
        bundled = json.loads((seed / "index.json").read_text())
    except (OSError, ValueError):
        return 0
    LIBRARY.mkdir(parents=True, exist_ok=True)
    for name in {i["file"] for i in bundled["items"]}:
        if not (LIBRARY / name).exists():
            shutil.copy(seed / name, LIBRARY / name)
    added = 0

    def merge(d: dict) -> None:
        nonlocal added
        have = {(i["url"], i["rubro"]) for i in d["items"]}
        fresh = [i for i in bundled["items"] if (i["url"], i["rubro"]) not in have]
        d["items"] += fresh
        d.setdefault("shelves", {}).update({k: v for k, v in bundled.get("shelves", {}).items() if k not in d["shelves"]})
        added = len(fresh)

    _update(merge)
    return added


async def fill_in_background() -> None:
    if ENABLED:
        await asyncio.to_thread(load_seed)
    if ENABLED and rsch.chrome_path():
        await asyncio.sleep(120)  # after the server is settled in
        await asyncio.to_thread(fill)


def mark_for_curation(rubro: str, label: str, sites: list[str]) -> None:
    """We had to go looking for this business: it stays on the list until someone adds the best examples by hand."""
    _update(lambda d: d.setdefault("to_curate", {}).setdefault(rubro, {"label": label, "ts": time.time(), "fetched": []})["fetched"].extend(s for s in sites if s not in d["to_curate"][rubro]["fetched"]))


def to_curate() -> list[dict]:
    return [{"rubro": k, **v} for k, v in sorted(load_index().get("to_curate", {}).items(), key=lambda kv: -kv[1]["ts"])]


def add_by_hand(rubro: str, name: str, png: bytes, source: str = "hand", done: bool = False) -> dict:
    """A capture a person picked. It doesn't go through robots or walls because no server visited anything."""
    file = f"{source}-{slug(name)}.png"
    LIBRARY.mkdir(parents=True, exist_ok=True)
    (LIBRARY / file).write_bytes(png)
    item = {"name": name[:60], "url": f"{source}:{slug(name)}", "rubro": rubro, "look": "", "file": file, "source": source, "ts": time.time()}

    def save(d: dict) -> None:
        d["items"] = [i for i in d["items"] if not (i["file"] == file and i["rubro"] == rubro)] + [item]
        if done:
            d.get("to_curate", {}).pop(rubro, None)

    _update(save)
    return item


def status() -> dict:
    d = load_index()
    shelves: dict[str, int] = {}
    for i in d["items"]:
        shelves[i["rubro"]] = shelves.get(i["rubro"], 0) + 1
    return {"total": len(d["items"]), "shelves": shelves, "failed": len(d["failed"]), "known_sites": sum(len(s["sites"]) for s in SITES.values()), "to_curate": to_curate(), "rubros": known_rubros()}


def known_rubros() -> dict[str, str]:
    return {**{k: v for k, v in load_index().get("shelves", {}).items()}, **{k: s["label"] for k, s in SITES.items()}}


def rubro_prompt() -> str:
    return RUBRO_SYSTEM.format(rubros="\n".join(f"- {k}: {v}" for k, v in known_rubros().items()))


def rubro_by_words(text: str) -> str | None:
    low = f" {text.lower()} "
    best, score = None, 0
    for rubro, shelf in SITES.items():
        hits = sum(1 for w in shelf["keywords"] if w in low)
        if hits > score:
            best, score = rubro, hits
    return best


def read_rubro(answer: str, text: str) -> tuple[str | None, str | None]:
    """(known shelf, or None) and the name for a new one."""
    m = re.search(r"\{.*\}", answer or "", re.S)
    try:
        d = json.loads(m.group(0)) if m else {}
    except ValueError:
        d = {}
    rubro = d.get("rubro") if isinstance(d, dict) else None
    if rubro in known_rubros():
        return rubro, None
    name = d.get("nombre") if isinstance(d, dict) else None
    if name and isinstance(name, str):
        return None, name.strip()[:60]
    return rubro_by_words(text), None


def new_shelf(name: str) -> str:
    rubro = slug(name)
    if rubro not in known_rubros():
        _update(lambda x: x.setdefault("shelves", {}).__setitem__(rubro, name))
    return rubro


def on_shelf(rubro: str) -> list[dict]:
    return [i for i in load_index()["items"] if i["rubro"] == rubro and (LIBRARY / i["file"]).exists()]


def choose(rubro: str | None, n: int = 6, seed: str = "") -> list[dict]:
    """Up to n pictures: mostly from the business, in as many looks as there are, plus one or two from elsewhere so it doesn't all look alike."""
    rng = random.Random(seed)
    own = on_shelf(rubro) if rubro else []
    rng.shuffle(own)
    picked: list[dict] = []
    own.sort(key=lambda i: i.get("source") != "hand")  # what a person picked goes first
    looks: set[str] = set()
    for i in own:  # then one of each look
        if i.get("source") == "hand" or i.get("look") not in looks:
            looks.add(i.get("look"))
            picked.append(i)
    picked += [i for i in own if i not in picked]
    picked = picked[:max(n - 2, 1)] if own else []
    others = [i for i in load_index()["items"] if i["rubro"] != rubro and i["file"] not in {p["file"] for p in picked} and (LIBRARY / i["file"]).exists()]
    rng.shuffle(others)
    seen = {p["file"] for p in picked}
    for i in others:
        if len(picked) >= n:
            break
        if i["file"] not in seen:
            seen.add(i["file"])
            picked.append(i)
    return picked
