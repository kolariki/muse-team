"""Everything about a published app without leaving Muse Team, next to its analytics:

- Errors (like Sentry): the incidents Muse Team already groups by cause (server log, visitors' browsers, «Correr la app»), with
  every occurrence kept so each issue has its timeline.
- AI calls (like Langfuse): the app reports each model call (model, tokens, latency, cost, which feature, ok/error) to
  POST /api/llm/<site> with its own token; Muse Team prices it when the app does not and shows cost per day, model and feature.
- A/B experiments: `tably.variant('exp', ['a', 'b'])` in the analytics snippet assigns each visitor a stable variant and
  records the exposure; any tracked event is a goal, and Muse Team compares the conversion of each variant with the first one.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import re
import time

from .auth import _db

with _db() as _c:
    _c.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_error_events (error_id TEXT NOT NULL, ts REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS app_error_events_id ON app_error_events (error_id, ts);
        CREATE TABLE IF NOT EXISTS llm_calls (
            site TEXT NOT NULL, ts REAL NOT NULL, provider TEXT, model TEXT, name TEXT, input_tokens INTEGER, output_tokens INTEGER,
            cost_usd REAL, latency_ms INTEGER, status TEXT, error TEXT, user TEXT, input TEXT, output TEXT);
        CREATE INDEX IF NOT EXISTS llm_calls_site ON llm_calls (site, ts);
        """
    )


# ------------------------------------------------------------------------------------------------ the app's own token

def app_token(site: str) -> str:
    """What the published app sends to Muse Team's ingest endpoints (TABLY_TOKEN): derived from the server secret, never stored."""
    from .keystore import _secret

    return "tbly_" + hmac.new(_secret(), f"ingest:{site}".encode(), hashlib.sha256).hexdigest()[:40]


def check_token(site: str, header: str | None) -> bool:
    got = (header or "").removeprefix("Bearer ").strip()
    return bool(got) and hmac.compare_digest(got, app_token(site))


# ------------------------------------------------------------------------------------------------ errors

def note_occurrence(error_id: str, ts: float | None = None) -> None:
    with _db() as c:
        c.execute("INSERT INTO app_error_events (error_id, ts) VALUES (?, ?)", (error_id, ts or time.time()))


def issues(rows: list[dict], days: int) -> list[dict]:
    """The app's error issues with a per-day timeline of their occurrences (the last `days` days)."""
    now = time.time()
    since = now - days * 86400
    ids = [r["id"] for r in rows]
    per: dict[str, dict[str, int]] = {}
    if ids:
        with _db() as c:
            q = f"SELECT error_id, date(ts, 'unixepoch') d, COUNT(*) FROM app_error_events WHERE ts >= ? AND error_id IN ({','.join('?' * len(ids))}) GROUP BY error_id, d"
            for eid, d, n in c.execute(q, (since, *ids)):
                per.setdefault(eid, {})[d] = n
    span = [time.strftime("%Y-%m-%d", time.gmtime(now - i * 86400)) for i in range(min(days, 30) - 1, -1, -1)]
    keep = ("id", "source", "title", "detail", "sample", "count", "first_ts", "last_ts", "status", "attempts", "size", "what", "fix", "impact", "fixed_ts")
    out = []
    for r in rows:
        if (r.get("last_ts") or 0) < since:
            continue
        out.append({**{k: r.get(k) for k in keep}, "series": [per.get(r["id"], {}).get(d, 0) for d in span],
                    "in_period": sum(per.get(r["id"], {}).values())})
    out.sort(key=lambda x: (x["status"] in ("fixed", "ignored"), -(x["last_ts"] or 0)))
    return out


# ------------------------------------------------------------------------------------------------ AI calls

def record_llm(site: str, body: dict) -> bool:
    from .pricing import cost_usd

    def num(k: str) -> int:
        try:
            return max(0, int(float(body.get(k) or 0)))
        except (TypeError, ValueError):
            return 0

    model = str(body.get("model") or "")[:80]
    tin, tout = num("input_tokens") or num("prompt_tokens"), num("output_tokens") or num("completion_tokens")
    try:
        cost = float(body["cost_usd"]) if body.get("cost_usd") not in (None, "") else (cost_usd(model, tin, tout) if model else 0.0)
    except (TypeError, ValueError, KeyError):
        cost = 0.0
    status = "error" if body.get("error") or str(body.get("status") or "").lower() in ("error", "failed") else "ok"
    with _db() as c:
        recent = c.execute("SELECT COUNT(*) FROM llm_calls WHERE site = ? AND ts >= ?", (site, time.time() - 60)).fetchone()[0]
        if recent >= 600:  # a runaway loop in the app: keep the data useful, not unlimited
            return False
        c.execute("""INSERT INTO llm_calls (site, ts, provider, model, name, input_tokens, output_tokens, cost_usd, latency_ms, status, error, user, input, output)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                  (site, time.time(), str(body.get("provider") or "")[:40] or None, model or None, str(body.get("name") or body.get("feature") or "")[:80] or None,
                   tin, tout, round(max(cost, 0.0), 6), num("latency_ms") or None, status, (str(body.get("error"))[:500] if body.get("error") else None),
                   (str(body.get("user"))[:120] if body.get("user") else None), (str(body.get("input"))[:2000] if body.get("input") else None),
                   (str(body.get("output"))[:2000] if body.get("output") else None)))
    return True


def llm_summary(site: str, days: int) -> dict:
    now = time.time()
    since = now - days * 86400
    with _db() as c:
        k = c.execute("""SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_usd), 0),
                         AVG(latency_ms), SUM(status = 'error') FROM llm_calls WHERE site = ? AND ts >= ?""", (site, since)).fetchone()
        by_day = {d: (n, cst) for d, n, cst in c.execute("SELECT date(ts, 'unixepoch') d, COUNT(*), SUM(cost_usd) FROM llm_calls WHERE site = ? AND ts >= ? GROUP BY d", (site, since))}

        def group(col: str) -> list[dict]:
            return [{"key": key or "—", "calls": n, "cost": round(cst or 0, 4), "tokens": int(t or 0), "latency": int(lat or 0), "errors": int(er or 0)}
                    for key, n, cst, t, lat, er in c.execute(f"""SELECT {col}, COUNT(*), SUM(cost_usd), SUM(input_tokens + output_tokens), AVG(latency_ms), SUM(status = 'error')
                                                                  FROM llm_calls WHERE site = ? AND ts >= ? GROUP BY {col} ORDER BY SUM(cost_usd) DESC, COUNT(*) DESC LIMIT 12""", (site, since))]
        models, features = group("model"), group("name")
        recent = [dict(r) for r in c.execute("""SELECT ts, provider, model, name, input_tokens, output_tokens, cost_usd, latency_ms, status, error, user, input, output
                                                FROM llm_calls WHERE site = ? ORDER BY ts DESC LIMIT 40""", (site,))]
    calls, tin, tout, cost, lat, errs = k
    series = []
    for i in range(days - 1, -1, -1):
        d = time.strftime("%Y-%m-%d", time.gmtime(now - i * 86400))
        n, cst = by_day.get(d, (0, 0))
        series.append({"day": d, "calls": n, "cost": round(cst or 0, 4)})
    return {"kpis": {"calls": calls or 0, "input_tokens": int(tin), "output_tokens": int(tout), "cost": round(cost or 0, 4),
                     "latency": int(lat or 0), "errors": int(errs or 0), "cost_per_call": round((cost or 0) / calls, 5) if calls else 0},
            "series": series, "models": models, "features": features, "recent": recent}


# ------------------------------------------------------------------------------------------------ A/B experiments

def _p_value(c1: int, n1: int, c2: int, n2: int) -> float | None:
    """Two-sided p-value of a two-proportion z-test (None when there is too little data to say anything)."""
    if min(n1, n2) < 1 or c1 + c2 == 0:
        return None
    p = (c1 + c2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return None
    z = abs(c1 / n1 - c2 / n2) / se
    return round(math.erfc(z / math.sqrt(2)), 4)


def experiments(site: str, days: int, goals: dict[str, str] | None = None) -> dict:
    """Each experiment: its variants with the visitors exposed and how many reached the goal (an event) after seeing it."""
    since = time.time() - days * 86400
    goals = goals or {}
    with _db() as c:
        exps = [r[0] for r in c.execute("SELECT DISTINCT name FROM analytics_hits WHERE site = ? AND kind = 'exp' AND ts >= ? AND name IS NOT NULL ORDER BY name", (site, since))]
        events = [r[0] for r in c.execute("SELECT name FROM analytics_hits WHERE site = ? AND kind = 'event' AND ts >= ? AND name IS NOT NULL GROUP BY name ORDER BY COUNT(*) DESC LIMIT 30", (site, since))]
        out = []
        for exp in exps:
            goal = goals.get(exp) or (events[0] if events else None)
            rows = c.execute("""SELECT json_extract(props, '$.v') v, COUNT(DISTINCT vid) n, MIN(ts) FROM analytics_hits
                                WHERE site = ? AND kind = 'exp' AND name = ? AND ts >= ? GROUP BY v ORDER BY MIN(ts)""", (site, exp, since)).fetchall()
            variants = []
            for v, n, _ in rows:
                conv = 0
                if goal:
                    conv = c.execute("""SELECT COUNT(DISTINCT e.vid) FROM analytics_hits e JOIN
                                        (SELECT vid, MIN(ts) t FROM analytics_hits WHERE site = ? AND kind = 'exp' AND name = ? AND json_extract(props, '$.v') = ? AND ts >= ? GROUP BY vid) x
                                        ON e.vid = x.vid AND e.ts >= x.t WHERE e.site = ? AND e.kind = 'event' AND e.name = ?""",
                                     (site, exp, v, since, site, goal)).fetchone()[0]
                variants.append({"variant": v or "—", "visitors": n, "conversions": conv, "rate": round(conv / n, 4) if n else 0})
            base = variants[0] if variants else None
            for x in variants[1:]:
                x["lift"] = round((x["rate"] - base["rate"]) / base["rate"], 4) if base and base["rate"] else None
                x["p"] = _p_value(base["conversions"], base["visitors"], x["conversions"], x["visitors"]) if base else None
            best = max(variants, key=lambda x: x["rate"]) if variants else None
            sure = bool(best and best is not base and best.get("p") is not None and best["p"] < 0.05 and best["visitors"] >= 30)
            out.append({"name": exp, "goal": goal, "variants": variants, "winner": best["variant"] if sure else None,
                        "visitors": sum(x["visitors"] for x in variants)})
    return {"experiments": out, "goals": events}


# the analytics snippet's piece for experiments (appended to levels.SNIPPET_JS)
VARIANT_JS = r"""window.tably.variant=function(exp,vs,ws){exp=String(exp||'').slice(0,60);if(!exp||!vs||!vs.length)return vs&&vs[0];
var key='_tblyx_'+exp,v=null;try{v=localStorage.getItem(key)}catch(e){}
if(v===null||vs.indexOf(v)<0){var h=0,s=vid+':'+exp;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))>>>0}
var tot=0,i2;ws=ws&&ws.length===vs.length?ws:vs.map(function(){return 1});for(i2=0;i2<ws.length;i2++)tot+=ws[i2];var r=(h%10000)/10000*tot;v=vs[vs.length-1];
for(i2=0;i2<vs.length;i2++){if(r<ws[i2]){v=vs[i2];break}r-=ws[i2]}try{localStorage.setItem(key,v)}catch(e){}}
var sk='_tblyxs_'+exp;try{if(!sessionStorage.getItem(sk)){sessionStorage.setItem(sk,'1');send('exp',exp,{v:String(v)})}}catch(e){send('exp',exp,{v:String(v)})}
return v};"""

SLUG = re.compile(r"[a-z0-9-]{1,80}")
