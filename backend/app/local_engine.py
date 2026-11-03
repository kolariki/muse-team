"""Local agent engines: build (and review) with the official CLIs instead of the API.

    claude-code  →  `claude -p … --output-format stream-json`   (Claude Pro/Max subscription login)
    codex        →  `codex exec --json …`                        (ChatGPT login, or API key)

The CLI works in a real folder on this machine (data/builds/<user>/<build>/): it writes files, can run
commands, and keeps its own conversation (`--continue`) so change requests and resumes keep context.
Tably Team watches the folder and streams the agent's messages/tools into the builder UI.

Nothing here talks to claude.ai or chatgpt.com directly: only the vendors' CLIs, with their own login.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable

from .config import DATA_DIR, env

log = logging.getLogger("arena.engine")

ENGINES: dict[str, dict] = {
    # "default" from the UI resolves to the engine's strongest model, not to whatever the CLI happens to have configured
    "claude-code": {"label": "Claude Code · tu suscripción", "logo": "anthropic", "bin": env("ARENA_CLAUDE_BIN", "claude"), "color": "#C0603F", "default_model": env("ARENA_CLAUDE_MODEL", "claude-opus-5-5")},
    "codex": {"label": "Codex CLI · ChatGPT", "logo": "openai", "bin": env("ARENA_CODEX_BIN", "codex"), "color": "#17896A"},
    # Meta's coding agent (`muse exec --json`): runs with the user's META_API_KEY from Tably, or with `muse login` on this machine
    "muse-code": {"label": "Muse Code · Meta", "logo": "meta", "bin": env("ARENA_MUSE_BIN", "muse"), "color": "#0082FB", "default_model": env("ARENA_MUSE_MODEL", "muse-wonder-1.0")},
}
MUSE_HOME = Path(env("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "muse"


def _which(spec: dict) -> str | None:
    """The engine binary on PATH, or in the places the official installers use (~/.local/bin for Muse Code)."""
    found = shutil.which(spec["bin"])
    if found:
        return found
    for cand in (Path.home() / ".local" / "bin" / spec["bin"], Path("/usr/local/bin") / spec["bin"], Path("/opt/homebrew/bin") / spec["bin"]):
        if cand.exists():
            return str(cand)
    return None
BUILD_ROOT = Path(env("ARENA_BUILD_DIR", str(DATA_DIR.parent / "builds")))
CLAUDE_HOMES = Path(env("ARENA_CLAUDE_HOME_DIR", str(DATA_DIR.parent / "claude-home")))  # one Claude Code home per user (sessions, settings)

# The engine environment of the user whose job is running (set by the build pipeline / the sessions chat): on a server
# every user brings their own Claude Code subscription via `claude setup-token`, and gets their own config dir.
import contextvars

USER_ENV: contextvars.ContextVar[dict] = contextvars.ContextVar("engine_user_env", default={})


def claude_home(user_id: str) -> Path:
    d = CLAUDE_HOMES / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def user_claude_env(user_id: str) -> dict:
    """Env that makes `claude` run as this user: their long-lived OAuth token (from `claude setup-token` on their own
    computer) and a private config dir. Without a token, the machine's own login is used (local setups)."""
    from . import keystore

    out: dict = {}
    token = keystore.get_key(user_id, "claude-code")
    if token:
        out.update({"CLAUDE_CODE_OAUTH_TOKEN": token, "CLAUDE_CONFIG_DIR": str(claude_home(user_id))})
    # Muse Code takes the Meta Model API key from the environment: the key the user loaded in «Modelos y API keys»
    meta = keystore.get_key(user_id, "meta")
    if meta:
        out["META_API_KEY"] = meta
    return out

SKIP_DIRS = {"node_modules", ".git", ".next", "dist", "build", ".venv", "__pycache__", ".turbo", ".cache", "coverage", ".claude"}
MAX_FILE = 400_000
TEXT_EXT_HINT = re.compile(r"\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|mov|bin|lock)$", re.I)

Emit = Callable[..., Awaitable[None] | None]


def is_engine(provider: str) -> bool:
    return provider in ENGINES


def workdir(user_id: str, build_id: str) -> Path:
    d = BUILD_ROOT / user_id / build_id
    d.mkdir(parents=True, exist_ok=True)
    return d


# ------------------------------------------------------------------ status

def _run(cmd: list[str], timeout: float = 15) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:
        return 1, str(e)


def _simulate_logged_out() -> bool:
    """Dev switch: `touch backend/data/.engines-offline` (or ARENA_ENGINES_OFFLINE=1) makes every CLI look logged out,
    so the connection flow can be tried without really signing out of Claude Code / Codex."""
    return bool(os.environ.get("ARENA_ENGINES_OFFLINE")) or (DATA_DIR.parent / ".engines-offline").exists()


_HINT_EN = [
    ("No está instalado en esta máquina.", "Not installed on this machine."),
    ("Instalá Claude Code:", "Install Claude Code:"), ("Instalá Muse Code:", "Install Muse Code:"), ("Instalá Codex CLI:", "Install Codex CLI:"),
    ("Cargá tu META_API_KEY en Modelos y API keys, o iniciá sesión en tu terminal:", "Add your META_API_KEY in Models and API keys, or sign in from your terminal:"),
    ("Iniciá sesión en tu terminal:", "Sign in from your terminal:"),
    ("No pude leer el estado de login", "Could not read the login status"),
    ("Logueado con API key (factura por uso). Para usar tu plan de ChatGPT:", "Signed in with an API key (billed per use). To use your ChatGPT plan:"),
]


def _en(st: dict) -> dict:
    """English copies of the user-facing strings (the UI picks them by its language)."""
    h = st.get("hint")
    if h:
        for es, en in _HINT_EN:
            h = h.replace(es, en)
    st["hint_en"] = h
    st["label_en"] = (st.get("label") or "").replace("tu suscripción", "your subscription")
    return st


def engine_models(engine: str) -> list[str]:
    """What can be chosen in a picker; any other id can be typed. Codex lists none: it uses what the user's plan has."""
    return {"claude-code": ["default", "opus", "sonnet", "haiku"], "muse-code": ["default", "muse-wonder-1.0", "muse-spark-1.3"]}.get(engine, ["default"])


def engine_status(user_id: str | None = None) -> list[dict]:
    out = []
    offline = _simulate_logged_out()
    from . import keystore

    token_set = bool(user_id and keystore.get_key(user_id, "claude-code"))
    meta_key = bool(user_id and keystore.get_key(user_id, "meta"))
    for eid, spec in ENGINES.items():
        path = _which(spec)
        st = {"id": eid, "label": spec["label"], "logo": spec["logo"], "color": spec["color"], "installed": bool(path), "version": None, "auth": None, "ok": False, "hint": None, "token_set": token_set if eid == "claude-code" else False}
        if not path:
            st["hint"] = "No está instalado en esta máquina." + (" Instalá Claude Code: https://claude.com/claude-code" if eid == "claude-code" else " Instalá Muse Code: curl -fsSL https://dev.meta.ai/install.sh | sh" if eid == "muse-code" else " Instalá Codex CLI: npm i -g @openai/codex")
            out.append(_en(st))
            continue
        if eid == "muse-code":
            _, v = _run([path, "--version"])
            st["version"] = v.splitlines()[0][:40] if v else None
            if meta_key:
                st["auth"] = "API key de Meta (tu cuenta de Tably)"
                st["ok"] = True
            elif (MUSE_HOME / "auth.json").exists() or os.environ.get("META_API_KEY"):
                st["auth"] = "sesión de Muse (muse login)"
                st["ok"] = True
            else:
                st["hint"] = "Cargá tu META_API_KEY en Modelos y API keys, o iniciá sesión en tu terminal: `muse login`"
            out.append(_en(st))
            continue
        _, v = _run([path, "--version"])
        st["version"] = v.splitlines()[0][:40] if v else None
        if offline:
            st["auth"] = "sin sesión (simulado)"
            st["hint"] = "Iniciá sesión en tu terminal: `claude auth login`" if eid == "claude-code" else "Iniciá sesión en tu terminal: `codex login`"
        elif eid == "claude-code" and token_set:
            # the user's own subscription token (works on any machine, the PC can be off)
            st["auth"] = "suscripción (token de tu cuenta)"
            st["ok"] = True
        elif eid == "claude-code":
            code, txt = _run([path, "auth", "status"])
            try:
                j = json.loads(txt[txt.index("{"):])
                st["auth"] = "suscripción (claude.ai)" if j.get("authMethod") == "claude.ai" else j.get("authMethod")
                st["ok"] = bool(j.get("loggedIn"))
                if not st["ok"]:
                    st["hint"] = "Iniciá sesión en tu terminal: `claude auth login`"
            except Exception:
                st["hint"] = "No pude leer el estado de login (`claude auth status`)."
        else:
            code, txt = _run([path, "login", "status"])
            st["auth"] = txt.splitlines()[0][:80] if txt else None
            st["ok"] = code == 0 and "not logged" not in txt.lower()
            if st["ok"] and "api key" in txt.lower():
                st["hint"] = "Logueado con API key (factura por uso). Para usar tu plan de ChatGPT: `codex logout && codex login`."
            elif not st["ok"]:
                st["hint"] = "Iniciá sesión en tu terminal: `codex login`"
        out.append(_en(st))
    return out


# ------------------------------------------------------------------ file sync

def _text(p: Path) -> str | None:
    if TEXT_EXT_HINT.search(p.name) or p.stat().st_size > MAX_FILE:
        return None
    try:
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def snapshot_dir(root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        rel = p.relative_to(root).as_posix()
        if rel == "BRIEF.md":
            continue
        t = _text(p)
        if t is not None:
            files[rel] = t
    return files


def sync_files(root: Path, known: dict[str, str]) -> list[str]:
    """Pull changed/new files from disk into `known`; returns the paths that changed."""
    changed = []
    cur = snapshot_dir(root)
    for rel, content in cur.items():
        if known.get(rel) != content:
            known[rel] = content
            changed.append(rel)
    for rel in list(known):
        if rel not in cur and rel != "preview/index.html":
            known.pop(rel, None)
    return changed



STREAM_LIMIT = 64 * 1024 * 1024  # one stream-json line can carry a whole file; asyncio's default 64 KiB line limit killed builds


# ------------------------------------------------------------------ friendly activity (what the user sees instead of raw tool calls)

def _rel(path: str, cwd: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(cwd.resolve()))
    except Exception:
        return Path(path).name or path


def describe_tool(name: str, inp: dict, cwd: Path) -> dict:
    """Maps a raw tool call to a short human label: {kind, label, path}. Kinds: read|write|edit|search|run|test|install|build|git|plan|think."""
    fp = inp.get("file_path") or inp.get("path") or ""
    if name == "Read":
        return {"kind": "read", "label": "Leyendo", "path": _rel(fp, cwd)}
    if name == "Write":
        return {"kind": "write", "label": "Escribiendo", "path": _rel(fp, cwd)}
    if name in ("Edit", "MultiEdit"):
        return {"kind": "edit", "label": "Editando", "path": _rel(fp, cwd)}
    if name in ("Glob", "Grep", "LS"):
        return {"kind": "search", "label": "Explorando el proyecto", "path": str(inp.get("pattern") or "")[:40]}
    if name == "TodoWrite":
        return {"kind": "plan", "label": "Actualizando el plan", "path": ""}
    if name == "Bash":
        cmd = str(inp.get("command") or "").strip()
        first = re.sub(r'^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*', "", cmd)  # drop `cd <dir> &&` prefixes
        low = first.lower()
        if re.search(r"\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip\s+install|\buv\s+(sync|add|pip)|\bpoetry\s+(install|add)", low):
            return {"kind": "install", "label": "Instalando dependencias", "path": ""}
        if re.search(r"\b(pytest|vitest|jest|mocha)\b|\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bgo\s+test\b|\bcargo\s+test\b", low):
            return {"kind": "test", "label": "Corriendo los tests", "path": ""}
        if re.search(r"\btsc\b|\b(npm|pnpm|yarn)\s+run\s+(build|lint|typecheck)\b|\bcargo\s+build\b|\bgo\s+build\b|\bruff\b|\beslint\b", low):
            return {"kind": "build", "label": "Compilando y verificando", "path": ""}
        if low.startswith("git "):
            return {"kind": "git", "label": "Guardando en git", "path": ""}
        if re.match(r"^(mkdir|touch|cp|mv)\b", low):
            return {"kind": "write", "label": "Creando la estructura de carpetas", "path": ""}
        if re.match(r"^(ls|cat|head|tail|wc|pwd|which|find|tree|echo|env|python3? --version|node --version|uv --version)\b", low) or " --version" in low:
            return {"kind": "read", "label": "Revisando el entorno", "path": ""}
        if re.search(r"\b(npx|npm|pnpm|yarn)\s+(create|init)\b|create-(vite|next|react)-app|\bdjango-admin\b|\bvite\b", low):
            return {"kind": "build", "label": "Inicializando el proyecto", "path": ""}
        short = re.sub(r"\s+", " ", first.split("\n")[0])[:48]
        return {"kind": "run", "label": "Ejecutando", "path": short}
    return {"kind": "run", "label": name, "path": ""}


# ------------------------------------------------------------------ measured usage
_USAGE_CACHE: dict[str, tuple[tuple, dict]] = {}


def claude_usage(cwd: Path) -> dict[str, dict] | None:
    """Real token usage per model of every Claude Code run in this folder, read from Claude Code's own session logs
    (~/.claude/projects/<folder>/*.jsonl; each assistant message once, by id). None when there are no logs."""
    slug = re.sub(r"[^A-Za-z0-9-]", "-", str(cwd.resolve()))
    d = Path(os.path.expanduser("~/.claude/projects")) / slug
    logs = sorted(d.glob("*.jsonl")) if d.is_dir() else []
    if not logs:
        return None
    key = tuple((str(f), f.stat().st_mtime_ns, f.stat().st_size) for f in logs)
    hit = _USAGE_CACHE.get(str(d))
    if hit and hit[0] == key:
        return hit[1]
    seen: dict[str, dict] = {}
    for f in logs:
        with f.open(encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                m = e.get("message")
                if e.get("type") == "assistant" and isinstance(m, dict) and isinstance(m.get("usage"), dict):
                    seen[m.get("id") or e.get("uuid") or str(len(seen))] = {**m["usage"], "_model": m.get("model") or "claude"}
    by_model: dict[str, dict] = {}
    for x in seen.values():
        u = by_model.setdefault(x["_model"], {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        u["input"] += int(x.get("input_tokens") or 0)
        u["output"] += int(x.get("output_tokens") or 0)
        u["cache_read"] += int(x.get("cache_read_input_tokens") or 0)
        u["cache_write"] += int(x.get("cache_creation_input_tokens") or 0)
    _USAGE_CACHE[str(d)] = (key, by_model)
    return by_model


# ------------------------------------------------------------------ claude code

CLAUDE_ALLOWED_TOOLS = [
    "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite",
    "Bash(ls*)", "Bash(cat *)", "Bash(mkdir *)", "Bash(touch *)", "Bash(cp *)", "Bash(mv *)",
    "Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)", "Bash(yarn *)", "Bash(node *)",
    "Bash(python *)", "Bash(python3 *)", "Bash(pip *)", "Bash(uv *)", "Bash(pytest*)",
    "Bash(git init*)", "Bash(git add*)", "Bash(git status*)", "Bash(git commit*)",
]



async def _claude_loop(proc, result: dict, cwd: Path, on_event: Emit) -> None:
    streamed_text = 0  # chars already delivered as text deltas (so the final block isn't repeated)
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        if ev.get("session_id"):
            result["session_id"] = ev["session_id"]  # the user can open it with `claude --resume <id>` in the workdir
        if t == "stream_event":
            e = ev.get("event") or {}
            d = e.get("delta") or {}
            if e.get("type") == "content_block_delta":
                if d.get("type") == "thinking_delta" and d.get("thinking"):
                    await _call(on_event, "thinking", text=d["thinking"])
                elif d.get("type") == "text_delta" and d.get("text"):
                    streamed_text += len(d["text"])
                    await _call(on_event, "text_delta", text=d["text"])
            elif e.get("type") == "content_block_start" and (e.get("content_block") or {}).get("type") == "thinking":
                await _call(on_event, "thinking", text="")
        elif t == "assistant":
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "text" and block.get("text"):
                    if streamed_text:
                        streamed_text = 0
                        await _call(on_event, "text_end")
                    else:
                        await _call(on_event, "text", text=block["text"])
                elif block.get("type") == "tool_use":
                    name = block.get("name", "")
                    inp = block.get("input") or {}
                    a = describe_tool(name, inp, cwd)
                    await _call(on_event, "activity", act=a["kind"], label=a["label"], path=a["path"])
                    if name == "TodoWrite" and isinstance(inp.get("todos"), list):
                        await _call(on_event, "todos", todos=[{"text": str(x.get("content", ""))[:160], "status": str(x.get("status", "pending"))} for x in inp["todos"] if isinstance(x, dict)])
                    if name in ("Write", "Edit", "MultiEdit") and inp.get("file_path"):
                        await _call(on_event, "file_hint", path=str(inp["file_path"]))
        elif t == "result":
            result.update(text=ev.get("result") or "", cost=float(ev.get("total_cost_usd") or 0), turns=int(ev.get("num_turns") or 0), is_error=bool(ev.get("is_error")), subtype=ev.get("subtype"))
            if ev.get("is_error"):
                # the step cap is not a failure of the work: the caller continues the same session
                result["error"] = "límite de pasos del turno alcanzado" if ev.get("subtype") == "error_max_turns" else (ev.get("result") or "error")[:400]


# steps (tool calls) a single headless turn may take before Claude Code stops; a big design pass needs hundreds
MAX_TURNS = int(os.environ.get("ARENA_ENGINE_MAX_TURNS", "400"))


async def run_claude_code(prompt: str, cwd: Path, *, system: str | None = None, continue_: bool = False, resume_session: str | None = None, read_only: bool = False, max_turns: int = MAX_TURNS, model: str | None = None, mcp: dict | None = None, on_event: Emit) -> dict:
    """Streams a headless Claude Code run. on_event(kind, **data): text | tool | file_hint | result | error.
    `mcp`: {"mcpServers": {...}, "path_dir": ...} → the run gets those MCP servers (e.g. REA for deep analysis) and their tools allowed."""
    spec = ENGINES["claude-code"]
    cmd = [spec["bin"], "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", str(max_turns)]
    mcp_tools = [f"mcp__{name}" for name in (mcp or {}).get("mcpServers", {})]
    if read_only:
        cmd += ["--allowedTools", "Read", "Glob", "Grep", "LS", *mcp_tools, "--disallowedTools", "Write", "Edit", "MultiEdit", "Bash"]
    else:
        cmd += ["--permission-mode", "acceptEdits", "--allowedTools", *CLAUDE_ALLOWED_TOOLS, *mcp_tools]
    if mcp:
        mcp_file = cwd / ".arena-mcp.json"
        mcp_file.write_text(json.dumps({"mcpServers": mcp["mcpServers"]}))
        cmd += ["--mcp-config", str(mcp_file)]
    if system:
        cmd += ["--append-system-prompt", system]
    if resume_session:
        cmd += ["--resume", resume_session]  # same Claude Code session: full memory of what it already built
    elif continue_:
        cmd += ["--continue"]
    if model:
        cmd += ["--model", model]
    env_ = {**os.environ, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", **USER_ENV.get()}
    if mcp and mcp.get("path_dir"):
        env_["PATH"] = f"{mcp['path_dir']}:{env_.get('PATH', '')}"  # the MCP server's own Node first
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(cwd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=STREAM_LIMIT, env=env_)
    result: dict = {"text": "", "cost": 0.0, "turns": 0, "is_error": False, "error": None, "session_id": resume_session}
    assert proc.stdout
    try:
        await _claude_loop(proc, result, cwd, on_event)
    finally:
        if proc.returncode is None:
            proc.kill()  # stop/cancel must not leave a headless agent writing in the workdir
            await proc.wait()
    stderr = (await proc.stderr.read()).decode("utf-8", "replace") if proc.stderr else ""
    code = await proc.wait()
    if code != 0 and not result["error"]:
        result["is_error"] = True
        result["error"] = (stderr.strip().splitlines() or [f"claude exited {code}"])[-1][:400]
    return result


# ------------------------------------------------------------------ codex


async def _codex_loop(proc, texts: list, result: dict, cwd: Path, on_event: Emit) -> None:
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = ev.get("item") or {}
        it = item.get("type")
        if ev.get("type") == "item.completed":
            if it == "agent_message" and item.get("text"):
                texts.append(item["text"])
                await _call(on_event, "text", text=item["text"])
            elif it == "command_execution":
                a = describe_tool("Bash", {"command": str(item.get("command", ""))}, cwd)
                await _call(on_event, "activity", act=a["kind"], label=a["label"], path=a["path"])
            elif it == "file_change":
                for ch in item.get("changes") or []:
                    a = describe_tool("Write" if str(ch.get("kind", "")).lower() in ("add", "create", "") else "Edit", {"file_path": str(ch.get("path", ""))}, cwd)
                    await _call(on_event, "activity", act=a["kind"], label=a["label"], path=a["path"])
                    await _call(on_event, "file_hint", path=str(ch.get("path", "")))
            elif it == "reasoning" and item.get("text"):
                await _call(on_event, "reasoning", text=item["text"][:500])
        elif ev.get("type") == "turn.completed":
            usage = ev.get("usage") or {}
            result["turns"] += 1
            result["tokens"] = int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
        elif ev.get("type") == "error":
            result["is_error"] = True
            result["error"] = str(ev.get("message", "error"))[:400]


async def run_codex(prompt: str, cwd: Path, *, system: str | None = None, continue_: bool = False, resume_session: str | None = None, read_only: bool = False, model: str | None = None, mcp: dict | None = None, on_event: Emit) -> dict:
    """Codex takes its MCP servers from ~/.codex/config.toml (REA registers itself there); `mcp` only puts its Node first on PATH."""
    spec = ENGINES["codex"]
    full = (system + "\n\n" if system else "") + prompt
    cmd = [spec["bin"], "exec", "--json", "--skip-git-repo-check", "-C", str(cwd)]
    cmd += ["--sandbox", "read-only"] if read_only else ["--full-auto"]
    if model:
        cmd += ["-m", model]
    if resume_session:
        cmd += ["resume", resume_session]  # same Codex thread: full memory of the conversation
    elif continue_:
        cmd += ["resume", "--last"]
    cmd += [full]
    env_ = {**os.environ, **({"PATH": f"{mcp['path_dir']}:{os.environ.get('PATH', '')}"} if mcp and mcp.get("path_dir") else {})}
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(cwd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=STREAM_LIMIT, env=env_)
    result: dict = {"text": "", "cost": 0.0, "turns": 0, "is_error": False, "error": None}
    texts = []
    assert proc.stdout
    try:
      await _codex_loop(proc, texts, result, cwd, on_event)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    stderr = (await proc.stderr.read()).decode("utf-8", "replace") if proc.stderr else ""
    code = await proc.wait()
    result["text"] = "\n\n".join(texts)
    if code != 0 and not result["error"]:
        result["is_error"] = True
        result["error"] = (stderr.strip().splitlines() or [f"codex exited {code}"])[-1][:400]
    return result


# ------------------------------------------------------------------ muse code (Meta)


def _muse_tool_activity(payload: dict, cwd: Path) -> tuple[dict | None, str | None]:
    """Best-effort mapping of a Muse Code tool event to our activity vocabulary. Returns (activity, file_path)."""
    name = str(payload.get("tool") or payload.get("tool_name") or payload.get("name") or (payload.get("call") or {}).get("name") or "").lower()
    args = payload.get("arguments") or payload.get("args") or payload.get("input") or (payload.get("call") or {}).get("arguments") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:  # noqa: BLE001
            args = {"command": args}
    if not isinstance(args, dict):
        args = {}
    path = str(args.get("path") or args.get("file_path") or args.get("file") or "")
    if any(k in name for k in ("shell", "bash", "exec", "command", "run")):
        return describe_tool("Bash", {"command": str(args.get("command") or args.get("cmd") or "")}, cwd), None
    if any(k in name for k in ("write", "create", "apply_patch", "patch")):
        return describe_tool("Write", {"file_path": path}, cwd), (path or None)
    if "edit" in name or "replace" in name:
        return describe_tool("Edit", {"file_path": path}, cwd), (path or None)
    if any(k in name for k in ("read", "cat", "view", "open")):
        return describe_tool("Read", {"file_path": path}, cwd), None
    if any(k in name for k in ("search", "grep", "glob", "find", "ls", "list")):
        return describe_tool("Grep", {"pattern": str(args.get("pattern") or args.get("query") or "")}, cwd), None
    return None, None


async def _muse_loop(proc, texts: list, result: dict, cwd: Path, on_event: Emit) -> None:
    """`muse exec --json` prints MSP records: run.output.delta (text as it streams), run.terminal.* (how the turn ended),
    run.usage (tokens), task.lifecycle.failed (a sub-task that failed) and tool records (names vary by build)."""
    buf: list[str] = []
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        pt = str(ev.get("payload_type") or "")
        pl = ev.get("payload") or {}
        if pt == "run.output.delta":
            t = str(pl.get("text") or "")
            if t:
                buf.append(t)
                await _call(on_event, "text_delta", text=t)
        elif pt.startswith("run.terminal"):
            term = str(pl.get("terminal") or pt.rsplit(".", 1)[-1])
            final = str(pl.get("text") or "")
            text = final or "".join(buf)
            if text:
                texts.append(text)
                await _call(on_event, "text", text=text)
            buf.clear()
            result["turns"] += 1
            if term != "completed":
                result["is_error"] = True
                result["error"] = str(pl.get("reason") or f"muse: {term}")[:400]
        elif pt == "run.usage":
            tot = 0
            for m in pl.get("models") or []:
                tot += int(m.get("input_tokens") or 0) + int(m.get("output_tokens") or 0) + int(m.get("reasoning_tokens") or 0)
            result["tokens"] = tot
        elif pt.startswith("run.reasoning") or pt.startswith("model.reasoning"):
            t = str(pl.get("text") or "")
            if t:
                await _call(on_event, "reasoning", text=t[:500])
        elif "tool" in pt or str(pl.get("kind") or "").startswith("tool"):
            if any(k in pt for k in ("result", "completed", "output")):
                continue  # one activity per call, on the request record
            act, fp = _muse_tool_activity(pl, cwd)
            if act:
                await _call(on_event, "activity", act=act["kind"], label=act["label"], path=act["path"])
            if fp:
                await _call(on_event, "file_hint", path=fp)
        elif pt == "task.lifecycle.failed":
            reason = str(((pl.get("event") or {}).get("reason")) or "")
            if reason and "base instructions" not in reason:
                log.info("muse task failed: %s", reason)


async def run_muse_code(prompt: str, cwd: Path, *, system: str | None = None, continue_: bool = False, resume_session: str | None = None, read_only: bool = False, model: str | None = None, mcp: dict | None = None, on_event: Emit = None, max_turns: int = MAX_TURNS) -> dict:
    """Streams a headless Muse Code run (`muse exec --json`). Auth: META_API_KEY from the user's Tably key (USER_ENV), else the
    machine's `muse login`. Approvals are off (there is nobody to answer them) and the sandbox too, like our other engines."""
    spec = ENGINES["muse-code"]
    binary = _which(spec) or spec["bin"]
    full = (system + "\n\n" if system else "") + prompt
    if read_only:
        full = "Modo solo lectura: no modifiques ningún archivo ni corras comandos que escriban; solo leé y respondé.\n\n" + full
    cmd = [binary, "exec", "--json", "--disable-approval", "--disable-sandbox", "--trust-workspace", "--max-model-steps", str(max_turns)]
    cmd += ["--model", model or spec.get("default_model") or "muse-wonder-1.0"]
    if resume_session:
        cmd += ["--session-id", resume_session, "--allow-workspace-switch"]
    cmd += [full]
    env_ = {**os.environ, **USER_ENV.get()}
    if mcp and mcp.get("path_dir"):
        env_["PATH"] = f"{mcp['path_dir']}:{env_.get('PATH', '')}"
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(cwd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=STREAM_LIMIT, env=env_)
    result: dict = {"text": "", "cost": 0.0, "turns": 0, "tokens": 0, "is_error": False, "error": None}
    texts: list[str] = []
    assert proc.stdout
    try:
        await _muse_loop(proc, texts, result, cwd, on_event)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    stderr = (await proc.stderr.read()).decode("utf-8", "replace") if proc.stderr else ""
    code = await proc.wait()
    result["text"] = "\n\n".join(texts)
    if code != 0 and not result["error"]:
        result["is_error"] = True
        result["error"] = ([l for l in stderr.strip().splitlines() if not l.startswith("muse: ")] or [f"muse exited {code}"])[-1][:400]
    return result


async def run_engine(engine: str, prompt: str, cwd: Path, **kw) -> dict:
    fn = run_claude_code if engine == "claude-code" else run_muse_code if engine == "muse-code" else run_codex
    return await fn(prompt, cwd, **kw)


async def ask_engine(user_id: str, engine: str, system: str, prompt: str, model: str | None = None, on_text=None) -> dict:
    """One text answer from a local CLI agent, in an empty folder and without write tools: the subscription used as a plain model."""
    if not next((e["ok"] for e in engine_status(user_id) if e["id"] == engine), False):
        raise ValueError(f"{ENGINES[engine]['label']}: no está disponible en esta máquina")
    USER_ENV.set(user_claude_env(user_id))

    async def on_event(kind: str, **data) -> None:
        if kind in ("text_delta", "text") and on_text and data.get("text"):
            on_text(data["text"])

    pick = model if model and model != "default" else ENGINES[engine].get("default_model")
    with tempfile.TemporaryDirectory(prefix="tably-ask-") as tmp:
        res = await run_engine(engine, prompt, Path(tmp), system=system, read_only=True, max_turns=3, model=pick, on_event=on_event)
    if res.get("is_error") and not (res.get("text") or "").strip():
        raise ValueError(res.get("error") or f"{ENGINES[engine]['label']} no respondió")
    return res


async def _call(fn: Emit, kind: str, **data) -> None:
    r = fn(kind, **data)
    if asyncio.iscoroutine(r):
        await r


def digest_hash(files: dict[str, str]) -> str:
    h = hashlib.sha1()
    for k in sorted(files):
        h.update(k.encode())
        h.update(files[k].encode("utf-8", "replace"))
    return h.hexdigest()[:10]
